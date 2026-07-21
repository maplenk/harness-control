/**
 * W3-4 — coordinator completion atomicity (spec docs/specs/hardening-p4a.md
 * §W3-4; external review F5). The old defect: `start` advanced
 * `specifying → awaiting_approval`, RETURNED, and only then saved the spec
 * draft — a crash in that window left an approval-ready run with no draft,
 * and (the draft being projection-only) replay could not rebuild it.
 *
 * Proven here, through the SHIPPED `executeCommand` surface over real
 * `CoordinatorRunner` + CAS artifacts (in-process fake adapters, no spawns):
 *
 *  1. the completion is ONE transaction, draft persisted BEFORE the final
 *     advance, and the advance event carries the draft's artifact hash +
 *     version (`SpecDraftRef`) — durable-detectable;
 *  2. crash-injection EXACTLY in the old window (the completion append, and
 *     the draft-projection write) → the run is either still `specifying`
 *     (resumable — CLI `resume` re-drives the round to completion) or
 *     `awaiting_approval` WITH the draft. Never stranded, never
 *     approval-ready-and-draftless;
 *  3. a draft lost AFTER the completion committed (projection deleted /
 *     corrupted) is DETECTED against the durable completion ref:
 *     `approve` (human and --test-approve alike) and `run` refuse with the
 *     recovery hint, and `spec revise` RE-DRAFTS — rebuilding the revision
 *     context from the completion ref + CAS artifact.
 */
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DeterministicIdFactory, RandomIdFactory } from '../lib/id-factory.js';
import {
  criterionId,
  gitSha,
  runId as toRunId,
  specHash as toSpecHash,
  specVersionId as toSpecVersionId,
  type RunId,
} from '../domain/ids.js';
import type { DomainEvent } from '../domain/events.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { ArtifactStore } from '../artifacts/store.js';
import { loadProfileFile, type Profile } from '../config/profile.js';
import { InProcessFakeAdapter, type ConfigOptionDescriptor, type InProcessTurnScript } from '../adapters/index.js';
import {
  OrchestrationService,
  ROLE_ROUND_PROJECTION,
  SPEC_DRAFT_PROJECTION,
  WorkflowAdvanceError,
  type RoleAdapterFactory,
  type RoleModelSpec,
  type RoleRoundProjection,
  type SpecDraftState,
} from '../app/index.js';
import { CoordinatorRunner, type CoordinatorReviseContext } from '../app/flows/coordinator.js';
import { DurableRunOwnershipStore } from '../app/run-ownership-store.js';
import type { EvidenceRecorder } from '../app/flows/verifier.js';
import { createLegacyRunFixture, createRunFixture } from '../app/test-support.js';
import { artifactHash } from '../domain/ids.js';
import { executeCommand, type CliFlowDeps } from './commands.js';
import { makeTempGitRepo, type TempGitRepo } from '../worktree/test-support.js';

const GOAL = 'Add a --verbose flag to the CLI so debug lines print to stderr.';
const COORDINATOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const IMPLEMENTOR: RoleModelSpec = { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const PROFILE_PATH = fileURLToPath(new URL('../../profiles/coordinator.md', import.meta.url));
/** DeterministicIdFactory mints run_000001 for the first run of every test. */
const RUN1 = toRunId('run_000001');

function configOptions(): ConfigOptionDescriptor[] {
  return [
    { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
    { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

function validSpec(goalSuffix = ''): Record<string, unknown> {
  return {
    goal: `${GOAL}${goalSuffix}`,
    assumptions: ['The CLI entrypoint is src/cli/index.ts.'],
    openQuestions: [],
    constraints: ['Touch only files under src/cli'],
    permissions: ['read and write within the assigned worktree'],
    nonGoals: ['No change to the existing log format'],
    tasks: [{ id: 'T1', description: 'Recognize --verbose in the arg parser', dependsOn: [] }],
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'The --verbose flag enables debug output',
        verificationCommands: ['echo check-ac1'],
        expectedEvidence: 'exits with code 0 and stderr contains the debug prefix',
      },
      {
        id: 'AC-2',
        description: 'Without the flag no debug output is printed',
        verificationCommands: ['echo check-ac2'],
        expectedEvidence: 'exit code is 0 and stdout has no line matching the debug prefix',
      },
    ],
    rollback: 'Revert the single commit on the worktree branch.',
    proposedImplementorProfile: 'implementor',
    proposedVerifierProfile: 'verifier',
  };
}

const fence = (o: unknown): string => '```json\n' + JSON.stringify(o, null, 2) + '\n```';

const coordinatorTurn = (spec: unknown): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text: `Here is the specification.\n\n${fence(spec)}` }],
  result: { stopReason: 'end_turn' },
});

/** Coordinator-only fake factory: the Nth created adapter takes the Nth script. */
function makeCoordinatorFactory(scripts: readonly (readonly InProcessTurnScript[])[]): RoleAdapterFactory {
  let created = 0;
  return {
    create(options) {
      const turns = scripts[Math.min(created, scripts.length - 1)] ?? [];
      created += 1;
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: configOptions() },
        turns,
      });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
}

const NO_EVIDENCE: EvidenceRecorder = {
  async record(input) {
    return artifactHash(`ev_${String(input.criterionId)}`);
  },
};

let handle: TestDatabaseHandle | undefined;
let repo: TempGitRepo | undefined;

afterEach(async () => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
  await repo?.cleanup();
  repo = undefined;
});

interface Wired {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly deps: { readonly ids: DeterministicIdFactory; readonly flows: CliFlowDeps };
  /** Every revision context the flow factory was handed (W3-4 rebuild proof). */
  readonly reviseCalls: (CoordinatorReviseContext | undefined)[];
  /** Every immutable source base passed into a coordinator construction. */
  readonly coordinatorBaseCommits: (string | undefined)[];
  /** A restarted-process stand-in over the SAME store with its own adapters. */
  successor(scripts: readonly (readonly InProcessTurnScript[])[]): OrchestrationService;
}

async function setup(scripts: readonly (readonly InProcessTurnScript[])[]): Promise<Wired> {
  repo = await makeTempGitRepo('harness-draft-atomicity-');
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const db = handle.db;
  const ids = new DeterministicIdFactory();
  const flowIds = new DeterministicIdFactory();
  const service = new OrchestrationService({
    db,
    ids,
    adapterFactory: makeCoordinatorFactory(scripts),
  });
  // The CAS the CoordinatorRunner writes is the SAME tree `db.artifacts`
  // reads (shared cas-fs layout), so the W3-4 rebuild-from-artifact path is
  // exercised against real stored bytes.
  const store = new ArtifactStore({ rootDir: handle.casRoot, clock: db.clock, ids: flowIds });
  const profileResult = loadProfileFile(PROFILE_PATH);
  if (!profileResult.ok) throw new Error('coordinator profile failed to load');
  const profile: Profile = profileResult.value;
  const reviseCalls: (CoordinatorReviseContext | undefined)[] = [];
  const coordinatorBaseCommits: (string | undefined)[] = [];
  const flows: CliFlowDeps = {
    ids,
    clock: db.clock,
    buildCoordinatorRunner: ({ goal, revise, baseCommit }) => {
      reviseCalls.push(revise);
      coordinatorBaseCommits.push(baseCommit !== undefined ? String(baseCommit) : undefined);
      return new CoordinatorRunner({
        goal,
        profile,
        artifactStore: store,
        ids: flowIds,
        clock: db.clock,
        baseCommit,
        ...(revise !== undefined ? { revise } : {}),
      });
    },
    openWorktrees: async () => {
      throw new Error('coordinator-only tests must never open worktrees');
    },
    evidence: NO_EVIDENCE,
  };
  return {
    service,
    db,
    deps: { ids, flows },
    reviseCalls,
    coordinatorBaseCommits,
    successor: (successorScripts) =>
      new OrchestrationService({
        db,
        ids: new RandomIdFactory(), // a restarted process never re-mints ids
        adapterFactory: makeCoordinatorFactory(successorScripts),
      }),
  };
}

function startCommand() {
  if (repo === undefined) throw new Error('test repository is not initialized');
  return { kind: 'start' as const, json: true, workspace: repo.dir, goal: GOAL, coordinator: COORDINATOR };
}

/** Inject a process death into the durable write path: the append carrying
 * the coordinator COMPLETION advance (to === 'awaiting_approval') throws.
 * The earlier created→specifying advance passes through untouched. */
function crashOnCompletionAdvance(db: TestDatabaseHandle['db']): { restore: () => void; crashes: () => number } {
  const events = db.events as { appendBatch: typeof db.events.appendBatch };
  const original = db.events.appendBatch.bind(db.events);
  let crashes = 0;
  events.appendBatch = (drafts: readonly DomainEvent[]) => {
    const hit = drafts.some(
      (d) => d.type === 'workflow.dispatch.advanced' && (d.payload as { to?: string }).to === 'awaiting_approval',
    );
    if (hit) {
      crashes += 1;
      throw new Error('injected crash: process died appending the completion advance');
    }
    return original(drafts);
  };
  return {
    restore: () => {
      events.appendBatch = original;
    },
    crashes: () => crashes,
  };
}

/** Inject a process death into the OTHER half of the transaction: the
 * spec-draft projection write throws (every other projection passes). */
function crashOnDraftSave(db: TestDatabaseHandle['db']): { restore: () => void } {
  const projections = db.projections as { save: typeof db.projections.save };
  const original = db.projections.save.bind(db.projections);
  projections.save = (runId, name, state, cursor) => {
    if (name === SPEC_DRAFT_PROJECTION) {
      throw new Error('injected crash: process died writing the draft projection');
    }
    original(runId, name, state, cursor);
  };
  return {
    restore: () => {
      projections.save = original;
    },
  };
}

function deleteDraftProjection(db: TestDatabaseHandle['db'], runId: RunId): void {
  db.driver
    .prepare('DELETE FROM run_projections WHERE run_id = ? AND projection_name = ?')
    .run([runId, SPEC_DRAFT_PROJECTION]);
}

function completionAdvances(db: TestDatabaseHandle['db'], runId: RunId): DomainEvent[] {
  return db.events
    .listByRun(runId)
    .filter(
      (e) => e.type === 'workflow.dispatch.advanced' && (e.payload as { to?: string }).to === 'awaiting_approval',
    );
}

// ---------------------------------------------------------------------------
// 1 — the completion is durable-detectable
// ---------------------------------------------------------------------------
describe('W3-4: the coordinator completion advance carries the draft ref', () => {
  it('start commits draft + advance together; the advance event carries artifact hash + version and getCoordinatorCompletion reads it back', async () => {
    const w = await setup([[coordinatorTurn(validSpec())]]);
    const start = await executeCommand(w.service, w.db, startCommand(), {}, w.deps);
    expect(start.exitCode).toBe(0);
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };

    const draft = w.service.getSpecDraft(runId);
    expect(draft).toBeDefined();
    expect(String(draft!.specHash)).toBe(spec.specHash);

    // The COMPLETION advance (and only it) carries the SpecDraftRef; §7 makes
    // the artifact ref the spec content hash, so the CAS bytes are locatable
    // from the event alone.
    const advances = w.db.events.listByRun(runId).filter((e) => e.type === 'workflow.dispatch.advanced');
    expect(advances).toHaveLength(2); // created→specifying, specifying→awaiting_approval
    expect((advances[0]!.payload as { draft?: unknown }).draft).toBeUndefined();
    expect(advances[1]!.payload).toMatchObject({
      from: 'specifying',
      to: 'awaiting_approval',
      draft: {
        artifactHash: spec.specHash,
        specVersionId: spec.specVersionId,
        specHash: spec.specHash,
        revision: 1,
      },
    });
    expect(w.service.getCoordinatorCompletion(runId)).toMatchObject({ specHash: spec.specHash, revision: 1 });
    // The ref points at REAL stored bytes (artifact-backed draft).
    expect(w.db.artifacts.readBytes(artifactHash(spec.specHash))).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2 — crash-injection exactly in the old window
// ---------------------------------------------------------------------------
describe('W3-4: crash exactly in the old draft-save window', () => {
  it('C2/C4: legacy coordinator re-entry pins once and constructs the runner with that base', async () => {
    const w = await setup([[coordinatorTurn(validSpec())]]);
    const { runId } = createLegacyRunFixture(w.service, w.db, {
      goal: GOAL,
      workspacePath: repo!.dir,
      coordinator: COORDINATOR,
    });
    w.service.advanceWorkflowPhase(runId, 'created', 'specifying');
    w.db.projections.save<RoleRoundProjection>(runId, ROLE_ROUND_PROJECTION, {
      round: 1,
      role: 'coordinator',
      stage: 'completed',
      modelSpec: COORDINATOR,
      inputs: JSON.stringify({ goal: GOAL }),
      intendedCompletionAdvance: { from: 'specifying', to: 'awaiting_approval' },
    });

    const resume = await executeCommand(
      w.service,
      w.db,
      { kind: 'resume', json: true, runId },
      {},
      w.deps,
    );
    expect(resume.exitCode).toBe(0);
    expect(resume.json).toMatchObject({ reentry: 'coordinator', phase: 'awaiting_approval' });
    const pinned = w.service.getRunBaseCommit(runId);
    expect(pinned).toBeTruthy();
    expect(w.coordinatorBaseCommits).toEqual([String(pinned)]);
    expect(w.db.events.listByRun(runId).filter((event) => event.type === 'run.base_commit.pinned')).toHaveLength(1);
  });

  it('completion-append death: the draft ROLLS BACK with the advance (still specifying, no draft), and `resume` re-drives the round to awaiting_approval WITH the draft', async () => {
    const w = await setup([
      [coordinatorTurn(validSpec())], // the crashed round
      [coordinatorTurn(validSpec())], // the re-driven round after "restart"
    ]);
    const crash = crashOnCompletionAdvance(w.db);
    const start = await executeCommand(w.service, w.db, startCommand(), {}, w.deps);
    crash.restore();
    expect(start.exitCode).toBe(1);
    expect(JSON.stringify(start.json)).toContain('injected crash');
    expect(crash.crashes()).toBe(1);

    // The dichotomy's FIRST arm: still `specifying`, with NO draft, NO
    // completion event, and the completed round re-drivable — the draft
    // projection written inside the transaction was rolled back with the
    // failed advance (draft-BEFORE-advance, one transaction).
    expect(w.service.status(RUN1).phase).toBe('specifying');
    expect(w.service.status(RUN1).suspension).toBe('none');
    expect(w.service.getSpecDraft(RUN1)).toBeUndefined();
    expect(w.service.getCoordinatorCompletion(RUN1)).toBeUndefined();
    expect(completionAdvances(w.db, RUN1)).toHaveLength(0);
    expect(w.service.getRoleRound(RUN1)).toMatchObject({ role: 'coordinator', round: 1 });

    // NEVER STRANDED: a restarted process (fresh service over the same
    // store) drives `resume`, which re-enters the coordinator round and
    // completes it atomically.
    const successor = w.successor([[coordinatorTurn(validSpec())]]);
    const resume = await executeCommand(successor, w.db, { kind: 'resume', json: true, runId: RUN1 }, {}, w.deps);
    expect(resume.exitCode).toBe(0);
    expect(resume.json).toMatchObject({ outcome: 'resumed', reentry: 'coordinator', phase: 'awaiting_approval' });
    expect(w.coordinatorBaseCommits).toHaveLength(2);
    expect(w.coordinatorBaseCommits[0]).toBeTruthy();
    expect(w.coordinatorBaseCommits[1]).toBe(w.coordinatorBaseCommits[0]);

    // The dichotomy's SECOND arm: awaiting_approval WITH the draft, and the
    // durable completion ref matches it.
    expect(w.service.status(RUN1).phase).toBe('awaiting_approval');
    const draft = w.service.getSpecDraft(RUN1);
    const completion = w.service.getCoordinatorCompletion(RUN1);
    expect(draft).toBeDefined();
    expect(completion).toBeDefined();
    expect(String(draft!.specHash)).toBe(String(completion!.specHash));
  });

  it('draft-projection-write death: nothing advances (still specifying, no half-committed completion), and `resume` completes the round', async () => {
    const w = await setup([[coordinatorTurn(validSpec())], [coordinatorTurn(validSpec())]]);
    const crash = crashOnDraftSave(w.db);
    const start = await executeCommand(w.service, w.db, startCommand(), {}, w.deps);
    crash.restore();
    expect(start.exitCode).toBe(1);
    expect(JSON.stringify(start.json)).toContain('injected crash');

    expect(w.service.status(RUN1).phase).toBe('specifying');
    expect(w.service.getSpecDraft(RUN1)).toBeUndefined();
    expect(completionAdvances(w.db, RUN1)).toHaveLength(0);

    const resume = await executeCommand(w.service, w.db, { kind: 'resume', json: true, runId: RUN1 }, {}, w.deps);
    expect(resume.exitCode).toBe(0);
    expect(w.service.status(RUN1).phase).toBe('awaiting_approval');
    expect(w.service.getSpecDraft(RUN1)).toBeDefined();
    expect(w.service.getCoordinatorCompletion(RUN1)).toBeDefined();
  });

  it('completeCoordinationRound is all-or-nothing: an illegal phase throws and persists NEITHER the draft NOR an advance', async () => {
    const w = await setup([[]]);
    const { runId } = createRunFixture(w.service, {
      goal: 'g',
      workspacePath: repo!.dir,
      coordinator: COORDINATOR,
      baseCommit: gitSha(await repo!.headSha()),
    });
    const draft: SpecDraftState = {
      specVersionId: toSpecVersionId('spec_x'),
      specHash: toSpecHash('hash_x'),
      canonicalSpec: '{"goal":"g"}',
      goal: 'g',
      criteria: [
        { id: criterionId('AC-1'), description: 'd', verificationCommands: ['echo ok'], expectedEvidence: 'exit code 0' },
      ],
      proposedImplementorProfile: 'implementor',
      proposedVerifierProfile: 'verifier',
      revision: 1,
    };
    // The run is at `created`, not `specifying` — the advance validation
    // aborts the WHOLE transaction, so the draft written first rolls back.
    await expect(w.service.completeCoordinationRound(runId, draft)).rejects.toThrow(WorkflowAdvanceError);
    expect(w.service.getSpecDraft(runId)).toBeUndefined();
    expect(completionAdvances(w.db, runId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3 — draft loss AFTER the completion committed: detect + refuse + recover
// ---------------------------------------------------------------------------
describe('W3-4: a draftless awaiting_approval run is detected and refused', () => {
  async function startedRun(w: Wired): Promise<{ runId: RunId; specVersionId: string; specHash: string }> {
    const start = await executeCommand(w.service, w.db, startCommand(), {}, w.deps);
    expect(start.exitCode).toBe(0);
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };
    return { runId: start.json['runId'] as RunId, specVersionId: spec.specVersionId, specHash: spec.specHash };
  }

  it('human approve with the CORRECT hash refuses (spec_draft_missing) with the spec-revise recovery hint', async () => {
    const w = await setup([[coordinatorTurn(validSpec())]]);
    const { runId, specVersionId, specHash } = await startedRun(w);
    deleteDraftProjection(w.db, runId);

    const out = await executeCommand(
      w.service,
      w.db,
      { kind: 'approve', json: true, runId, specVersionId: toSpecVersionId(specVersionId), specHash: toSpecHash(specHash), testApprove: false },
      {},
    );
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ refused: 'spec_draft_missing', completionSpecHash: specHash });
    expect(out.text).toContain('spec revise');
    expect(w.service.status(runId).phase).toBe('awaiting_approval'); // nothing bound
    expect(w.db.events.listByRun(runId).map((e) => e.type)).not.toContain('spec.approved');
  });

  it('--test-approve also refuses — a lost draft never falls back to the synthetic hash', async () => {
    const w = await setup([[coordinatorTurn(validSpec())]]);
    const { runId, specVersionId } = await startedRun(w);
    deleteDraftProjection(w.db, runId);

    const out = await executeCommand(
      w.service,
      w.db,
      { kind: 'approve', json: true, runId, specVersionId: toSpecVersionId(specVersionId), testApprove: true },
      { HARNESS_TEST_MODE: '1' },
    );
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ refused: 'spec_draft_missing' });
    expect(w.db.events.listByRun(runId).map((e) => e.type)).not.toContain('spec.approved');
  });

  it('a STALE draft (hash diverged from the durable completion) refuses approve with both hashes', async () => {
    const w = await setup([[coordinatorTurn(validSpec())]]);
    const { runId, specVersionId, specHash } = await startedRun(w);
    const draft = w.service.getSpecDraft(runId)!;
    w.service.saveSpecDraft(runId, { ...draft, specHash: toSpecHash('divergent_hash') });

    const out = await executeCommand(
      w.service,
      w.db,
      { kind: 'approve', json: true, runId, specVersionId: toSpecVersionId(specVersionId), testApprove: false },
      {},
    );
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({
      refused: 'spec_draft_stale',
      completionSpecHash: specHash,
      draftSpecHash: 'divergent_hash',
    });
  });

  it('run on a draftless APPROVED run refuses with the completion facts + recovery hint', async () => {
    const w = await setup([[coordinatorTurn(validSpec())]]);
    const { runId, specVersionId, specHash } = await startedRun(w);
    const approve = await executeCommand(
      w.service,
      w.db,
      { kind: 'approve', json: true, runId, specVersionId: toSpecVersionId(specVersionId), specHash: toSpecHash(specHash), testApprove: false },
      {},
    );
    expect(approve.exitCode).toBe(0);
    deleteDraftProjection(w.db, runId);

    const out = await executeCommand(
      w.service,
      w.db,
      { kind: 'run', json: true, runId, implementor: IMPLEMENTOR, verifier: VERIFIER },
      {},
      w.deps,
    );
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ error: 'spec_draft_missing', completionSpecHash: specHash });
    expect(out.text).toContain('cancelled and re-started');
    expect(w.service.status(runId).phase).toBe('approved'); // nothing ran
  });

  it('spec revise RE-DRAFTS a draftless run: revision context rebuilt from the completion ref + CAS artifact, superseding draft lands, approve binds the NEW hash', async () => {
    const w = await setup([
      [coordinatorTurn(validSpec())], // revision 1 (start)
      [coordinatorTurn(validSpec(' Keep flag output on stderr only.'))], // revision 2 (recovery re-draft)
    ]);
    const { runId, specVersionId: v1Id, specHash: v1Hash } = await startedRun(w);
    deleteDraftProjection(w.db, runId);

    const revise = await executeCommand(
      w.service,
      w.db,
      { kind: 'spec_revise', json: true, runId, feedback: 'tighten the criteria' },
      {},
      w.deps,
    );
    expect(revise.exitCode).toBe(0);
    expect(revise.json).toMatchObject({ outcome: 'applied', transitionId: 'T2', phase: 'awaiting_approval', draftRecovered: true });
    const spec2 = revise.json['spec'] as { specVersionId: string; specHash: string; revision: number; supersedes?: string };
    expect(spec2.revision).toBe(2);
    expect(spec2.supersedes).toBe(v1Id); // lineage rebuilt from the completion ref
    expect(revise.text).toContain('rebuilt');

    // The rebuild handed the coordinator the FULL revision context: the prior
    // version identity from the event, criteria + text re-parsed from the CAS.
    const recoveredCtx = w.reviseCalls.at(-1);
    expect(recoveredCtx).toBeDefined();
    expect(String(recoveredCtx!.priorVersion.id)).toBe(v1Id);
    expect(String(recoveredCtx!.priorVersion.contentHash)).toBe(v1Hash);
    expect(recoveredCtx!.priorVersion.criteria).toHaveLength(2);
    expect(recoveredCtx!.priorSpecText).toContain('"acceptanceCriteria"');

    // The superseding draft is durably persisted + completion-stamped; the
    // old hash is dead and approval binds the NEW one (W1-F3 unchanged).
    const draft = w.service.getSpecDraft(runId);
    expect(draft).toMatchObject({ revision: 2, specHash: spec2.specHash });
    expect(w.service.getCoordinatorCompletion(runId)).toMatchObject({ specHash: spec2.specHash, revision: 2 });
    const approve = await executeCommand(
      w.service,
      w.db,
      { kind: 'approve', json: true, runId, specVersionId: toSpecVersionId(spec2.specVersionId), testApprove: false },
      {},
    );
    expect(approve.exitCode).toBe(0);
    expect(w.service.status(runId).approvedSpecHash).toBe(spec2.specHash);
  });
});

// ---------------------------------------------------------------------------
// 4 — W4-4: the coordinator re-drive carve-out is §14 owner-liveness gated
//
// The W3-4 carve-out re-drives an UNSUSPENDED coordinator round stranded at
// `specifying` (crash before the completion advance committed). Before W4-4 it
// had NO owner-liveness check, so a concurrent `resume` in another process
// could double-drive the same coordinator round. It is now gated on the durable
// RUN-ownership lease (`isRunClaimedByLiveProcess`), exactly like the
// implementor/verifier boundary gate.
// ---------------------------------------------------------------------------
describe('W4-4: the coordinator re-drive carve-out is owner-liveness gated', () => {
  it('a LIVE owner holds the run lease → the carve-out WITHHOLDS (stays specifying, no draft) — fails without the gate: the ungated carve-out re-drove to awaiting_approval', async () => {
    const w = await setup([[coordinatorTurn(validSpec())]]);
    const crash = crashOnCompletionAdvance(w.db);
    const start = await executeCommand(w.service, w.db, startCommand(), {}, w.deps);
    crash.restore();
    expect(start.exitCode).toBe(1);
    // Stranded at the coordinator round, still specifying (the W3-4 dichotomy).
    expect(w.service.status(RUN1).phase).toBe('specifying');
    expect(w.service.getRoleRound(RUN1)).toMatchObject({ role: 'coordinator', round: 1 });

    // A still-alive owner holds the RUN-ownership lease (self stands in for a
    // live peer: `ownerPid === selfPid` is always live). The successor's
    // carve-out must WITHHOLD.
    new DurableRunOwnershipStore(w.db).acquire(
      {
        runId: RUN1,
        ownerPid: process.pid,
        acquiredAt: w.db.clock.nowIso(),
      },
      () => false, // seed into an empty store — land the lease unconditionally
    );

    const successor = w.successor([[coordinatorTurn(validSpec())]]);
    expect(successor.isRunClaimedByLiveProcess(RUN1)).toBe(true);
    const resume = await executeCommand(successor, w.db, { kind: 'resume', json: true, runId: RUN1 }, {}, w.deps);
    // WITHHELD: NOT re-driven — falls through to the "not paused" error, the run
    // stays specifying with no draft (the ungated carve-out would have reached
    // awaiting_approval WITH a draft).
    expect(resume.exitCode).toBe(1);
    expect(resume.json.reentry).not.toBe('coordinator');
    expect(w.service.status(RUN1).phase).toBe('specifying');
    expect(w.service.getSpecDraft(RUN1)).toBeUndefined();
  });

  it('a DEAD owner lease → the carve-out PROCEEDS (re-drives to awaiting_approval) — the intended crash reclaim', async () => {
    const w = await setup([[coordinatorTurn(validSpec())]]);
    const crash = crashOnCompletionAdvance(w.db);
    const start = await executeCommand(w.service, w.db, startCommand(), {}, w.deps);
    crash.restore();
    expect(start.exitCode).toBe(1);
    expect(w.service.status(RUN1).phase).toBe('specifying');

    // A stale lease from a since-crashed owner: a high pid the OS is not running
    // (real `ps.isAlive` → false, same convention as ps.test.ts), so the owner
    // is provably dead and the lease is reclaimable — the carve-out proceeds.
    new DurableRunOwnershipStore(w.db).acquire(
      {
        runId: RUN1,
        ownerPid: 999_999,
        ownerStartedAt: 'lstart-crashed-owner',
        acquiredAt: w.db.clock.nowIso(),
      },
      () => false, // seed into an empty store — land the lease unconditionally
    );

    const successor = w.successor([[coordinatorTurn(validSpec())]]);
    expect(successor.isRunClaimedByLiveProcess(RUN1)).toBe(false);
    const resume = await executeCommand(successor, w.db, { kind: 'resume', json: true, runId: RUN1 }, {}, w.deps);
    expect(resume.exitCode).toBe(0);
    expect(resume.json).toMatchObject({ outcome: 'resumed', reentry: 'coordinator', phase: 'awaiting_approval' });
    expect(w.service.getSpecDraft(RUN1)).toBeDefined();
  });
});
