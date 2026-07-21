/**
 * W2-5 `runImplementVerifyLoop` RESUME MODE (spec docs/specs/hardening-p4a.md
 * §W2-5; PLAN §11.1, §13, §16.3) — in-process fake adapters + a REAL temp git
 * repo, no real spawns:
 *
 *  - re-entry is driven ENTIRELY by the persisted `RoleRoundProjection` +
 *    §12.2 checkpoint + loop binding: the loop enters at implementing/
 *    verifying/needs_remediation and ADOPTS the worktree through the manager
 *    (reattach in a fresh process; mutex + §16.3 validation) — it never
 *    creates one on resume;
 *  - interrupted IMPLEMENTOR → WIP-commit-or-reset reconciliation, recorded
 *    durably; the WIP content is preserved work and part of the verified HEAD;
 *  - interrupted VERIFIER → forced back to the persisted
 *    `implementationCommit`, verifier dirt DISCARDED, clean asserted, and the
 *    round restarts on the SAME immutable binding; checkpointed passed
 *    criteria carry ONLY with same-spec/commit-bound evidence; worktreeClean
 *    is RE-PROBED after adoption, never carried;
 *  - a `needs_remediation` re-entry drives the NEXT implementor round with
 *    the remediation payload rebuilt from the durable T23 record.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactHash,
  assignmentId,
  criterionId,
  eventSequence,
  gitSha,
  specHash,
  specVersionId,
  type RunId,
} from '../../domain/ids.js';
import type { AcceptanceCriterion, CheckpointContent } from '../../domain/entities.js';
import { buildCheckpointContent } from '../../checkpoint/content.js';
import { DeterministicIdFactory, RandomIdFactory } from '../../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../../persistence/test-support.js';
import {
  InProcessFakeAdapter,
  rateLimitErrorEnvelope,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
} from '../../adapters/index.js';
import { GitWorktreeManager } from '../../worktree/index.js';
import * as git from '../../worktree/git.js';
import { makeTempGitRepo, type TempGitRepo } from '../../worktree/test-support.js';
import {
  LimitPausedError,
  OrchestrationService,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from '../service.js';
import type { Harness, RoleModelSpec } from '../model-resolution.js';
import { LoopCompositionError, runImplementVerifyLoop } from './orchestrate.js';
import { RunOwnershipConflictError } from '../run-ownership-store.js';
import { rebuildFixRequestsFromT23, type EvidenceRecorder } from './verifier.js';
import type { VerificationRunner } from './implementor.js';

const IMPLEMENTOR: RoleModelSpec = { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const COORDINATOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const SPEC_HASH = specHash('spec_hash_1');
const AC1 = criterionId('AC-1');
const AC2 = criterionId('AC-2');

const CRITERIA: readonly AcceptanceCriterion[] = [
  { id: AC1, description: 'flag exists', verificationCommands: ['echo check-ac1'], expectedEvidence: 'exit code 0' },
  { id: AC2, description: 'flag gates output', verificationCommands: ['echo check-ac2'], expectedEvidence: 'exit code 0' },
];

function configOptionsFor(harness: Harness): ConfigOptionDescriptor[] {
  if (harness === 'claude') {
    return [
      { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
      { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
    ];
  }
  return [
    { id: 'model', kind: 'model', values: ['gpt-5.6-terra', 'gpt-5.6-sol'], current: 'gpt-5.6-sol' },
    { id: 'model_reasoning_effort', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

const implementorTurn = (text: string): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text }],
  result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 40, source: 'adapter' } },
});

function verifierTurn(
  rows: ReadonlyArray<{ id: string; verdict: string; evidence?: string; fix?: string }>,
): InProcessTurnScript {
  return {
    updates: [{ kind: 'agent_message_chunk', text: JSON.stringify({ criteria: rows }) }],
    result: { stopReason: 'end_turn' },
  };
}

const PASS_BOTH = verifierTurn([
  { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' },
  { id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0' },
]);

const PASS_VERIFY: VerificationRunner = async (command) => ({
  exitCode: 0,
  stdout: `ran ${command}`,
  stderr: '',
  launchFailed: false,
});

interface AdapterScript {
  readonly writes?: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly turns: readonly InProcessTurnScript[];
}

interface CreatedAdapter {
  readonly role: string;
  readonly options: RoleAdapterOptions;
  readonly adapter: InProcessFakeAdapter;
  readonly prompts: string[];
}

function makeFactory(scripts: {
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}): { factory: RoleAdapterFactory; created: CreatedAdapter[] } {
  const created: CreatedAdapter[] = [];
  const cursors: Record<string, number> = {};
  const factory: RoleAdapterFactory = {
    create(options) {
      const role = options.role;
      const idx = cursors[role] ?? 0;
      cursors[role] = idx + 1;
      const queue = scripts[role as keyof typeof scripts] ?? [];
      const script: AdapterScript = queue[idx] ?? { turns: [] };
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: configOptionsFor(options.resolved.harness) },
        turns: script.turns,
      });
      const prompts: string[] = [];
      const orig = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (
        input,
      ) => {
        prompts.push(input.prompt);
        for (const write of script.writes ?? []) {
          const target = path.join(options.cwd, write.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, write.content, 'utf8');
        }
        return orig(input);
      };
      created.push({ role, options, adapter, prompts });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory, created };
}

function fakeEvidence(): EvidenceRecorder {
  let n = 0;
  return {
    async record(input) {
      n += 1;
      return artifactHash(`ev_${String(input.criterionId)}_${n}`);
    },
  };
}

let dbHandle: TestDatabaseHandle | undefined;
let repo: TempGitRepo | undefined;
let worktrees: GitWorktreeManager | undefined;

afterEach(async () => {
  if (worktrees !== undefined) {
    try {
      fs.rmSync(worktrees.baseDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  worktrees = undefined;
  dbHandle?.close();
  dbHandle?.cleanup();
  dbHandle = undefined;
  await repo?.cleanup();
  repo = undefined;
});

interface Rig {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly worktrees: GitWorktreeManager;
  readonly created: CreatedAdapter[];
  readonly ids: DeterministicIdFactory;
  readonly runId: RunId;
}

/** Open the rig at phase `approved` with the loop's spec hash bound (T1). */
async function openRig(scripts: {
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}): Promise<Rig> {
  repo = await makeTempGitRepo('harness-resume-');
  dbHandle = await openTestDatabase({ kind: 'better-sqlite3', file: true });
  worktrees = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: dbHandle.db.clock });
  const ids = new DeterministicIdFactory();
  const { factory, created } = makeFactory(scripts);
  const service = new OrchestrationService({ db: dbHandle.db, ids, adapterFactory: factory });
  const { runId } = service.createRun({ goal: 'g', workspacePath: repo.dir, coordinator: COORDINATOR });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  expect(
    service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: SPEC_HASH }).status,
  ).toBe('applied');
  return { service, db: dbHandle.db, worktrees, created, ids, runId };
}

function loopInput(rig: Rig) {
  return {
    runId: rig.runId,
    assignmentId: assignmentId(`asg_${rig.runId}`),
    implementor: IMPLEMENTOR,
    verifier: VERIFIER,
    specHash: SPEC_HASH,
    specDocument: '{"goal":"g"}',
    goal: 'g',
    taskScope: 'Implement the approved specification end to end.',
    criteria: CRITERIA,
    evidence: fakeEvidence(),
    runVerificationCommands: PASS_VERIFY,
    // F5: the fresh test repo's HEAD IS the intended base — pin it explicitly
    // (the loop refuses to silently default to live HEAD).
    baseRef: 'HEAD',
  };
}

function loopDeps(rig: Rig, manager?: GitWorktreeManager) {
  return {
    service: rig.service,
    worktrees: manager ?? rig.worktrees,
    ids: new RandomIdFactory(),
    clock: rig.db.clock,
  };
}

// ---------------------------------------------------------------------------
// Interrupted IMPLEMENTOR round — adopt + WIP reconciliation + re-drive
// ---------------------------------------------------------------------------
describe('resume mode — interrupted implementor round', () => {
  it('adopts the worktree (never creates), records the reconciliation, re-drives the round, completes to merge_ready', async () => {
    const rig = await openRig({
      implementor: [
        // Round-1 first attempt: writes a partial file, then the provider
        // limit lands mid-turn → durable pause (T4).
        { writes: [{ relPath: 'src/partial.ts', content: 'export const partial = 1;\n' }], turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] },
        // The re-entered round completes the work.
        { writes: [{ relPath: 'src/feature.ts', content: 'export const feature = true;\n' }], turns: [implementorTurn('done')] },
      ],
      verifier: [{ turns: [PASS_BOTH] }],
    });

    const paused: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch(
      (e: unknown) => e,
    );
    expect(paused).toBeInstanceOf(LimitPausedError);
    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('paused_limit');
    expect(st.phase).toBe('implementing');

    // W2-5: the loop persisted its binding + worktree facts AT CREATION.
    const loopState = rig.service.getImplementVerifyLoopState(rig.runId);
    expect(loopState).toMatchObject({ implementor: IMPLEMENTOR, verifier: VERIFIER, specHash: 'spec_hash_1' });
    expect(loopState?.worktree?.worktreePath).toBeDefined();
    const originalWorktreePath = loopState!.worktree!.worktreePath;
    const round = rig.service.getRoleRound(rig.runId);
    expect(round).toMatchObject({ role: 'implementor', round: 1, stage: 'active' });

    // Sprinkle EXTRA crash dirt beyond what the pause checkpoint recorded →
    // the §16.3 reconciliation must WIP-commit (preserve), never discard.
    fs.writeFileSync(path.join(originalWorktreePath, 'crash-dirt.txt'), 'unsaved work\n', 'utf8');

    // Eligibility-checked resume (T9) then re-entry driven by the projection.
    expect(rig.service.resume(rig.runId).status).toBe('applied');
    const checkpoint =
      round?.checkpointRef !== undefined ? rig.service.getCheckpointContent(round.checkpointRef) : undefined;
    expect(checkpoint).toBeDefined();
    const result = await runImplementVerifyLoop(loopDeps(rig), {
      ...loopInput(rig),
      resume: { round: round!, checkpoint: checkpoint! },
    });

    expect(result.outcome).toBe('merge_ready');
    expect(result.finalPhase).toBe('merge_ready');
    // ADOPTED, never created: same worktree path, round numbering resumed at 1.
    expect(result.worktree.worktreePath).toBe(originalWorktreePath);
    expect(result.rounds.map((r) => r.round)).toEqual([1]);
    expect(result.rounds[0]!.implementation).toBeDefined();

    // The WIP reconciliation was RECORDED durably and its commit preserved
    // the crash dirt (part of the verified HEAD's history, never discarded).
    const after = rig.service.getImplementVerifyLoopState(rig.runId);
    expect(after?.worktree?.lastValidation?.outcome).toBe('wip_committed');
    expect(after?.worktree?.lastValidation?.wipCommitSha).toBeDefined();
    const show = await git.runGit(
      ['log', '--name-only', '--format=%s'],
      originalWorktreePath,
    );
    expect(show.stdout).toContain('crash-dirt.txt');

    // The re-entered round acked the pending re-entry when it went active.
    const types = rig.db.events.listByRun(rig.runId).map((e) => e.type);
    expect(types).toContain('resume_reentry.completed');
    expect(rig.service.status(rig.runId).resumeReentryPending).toBeUndefined();
  });

  it('refuses resume mode without persisted worktree facts (never creates a worktree on resume)', async () => {
    const rig = await openRig({});
    const fakeRound = {
      round: 1,
      role: 'implementor' as const,
      stage: 'active' as const,
      specHash: SPEC_HASH,
    };
    await expect(
      runImplementVerifyLoop(loopDeps(rig), { ...loopInput(rig), resume: { round: fakeRound } }),
    ).rejects.toThrow(LoopCompositionError);
    // Nothing was created on the resume path.
    expect(rig.worktrees.handleFor(assignmentId(`asg_${rig.runId}`))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Interrupted VERIFIER round — forced binding, dirt DISCARDED, same binding
// ---------------------------------------------------------------------------
describe('resume mode — interrupted verifier round', () => {
  async function pauseVerifierRound(rig: Rig): Promise<{
    round: NonNullable<ReturnType<OrchestrationService['getRoleRound']>>;
    worktreePath: string;
    implementationCommit: string;
  }> {
    const paused: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch(
      (e: unknown) => e,
    );
    expect(paused).toBeInstanceOf(LimitPausedError);
    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('paused_limit');
    expect(st.phase).toBe('verifying'); // the verifier round had gone active
    const round = rig.service.getRoleRound(rig.runId)!;
    expect(round).toMatchObject({ role: 'verifier', round: 1, stage: 'active' });
    expect(round.implementationCommit).toBeDefined();
    const worktreePath = rig.service.getImplementVerifyLoopState(rig.runId)!.worktree!.worktreePath;
    return { round, worktreePath, implementationCommit: String(round.implementationCommit) };
  }

  it('fresh process: reattaches, forces HEAD to the persisted implementationCommit, DISCARDS verifier dirt, restarts on the SAME binding', async () => {
    const rig = await openRig({
      implementor: [
        {
          writes: [{ relPath: 'src/feature.ts', content: 'export const feature = true;\n' }],
          turns: [implementorTurn('done')],
        },
      ],
      verifier: [
        // Verifier attempt #1: leaves evidence dirt in the worktree, then the
        // limit lands mid-turn.
        { writes: [{ relPath: 'verifier-scratch.log', content: 'probe output\n' }], turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] },
        // Attempt #2 (the re-entry) passes everything.
        { turns: [PASS_BOTH] },
      ],
    });
    const { round, worktreePath, implementationCommit } = await pauseVerifierRound(rig);
    expect(fs.existsSync(path.join(worktreePath, 'verifier-scratch.log'))).toBe(true);

    expect(rig.service.resume(rig.runId).status).toBe('applied');

    // FRESH-PROCESS simulation: a brand-new manager over the same repo — the
    // loop must reattach from the persisted worktree facts (mutex + §16.3).
    const freshManager = await GitWorktreeManager.open({
      primaryRepoRoot: repo!.dir,
      clock: rig.db.clock,
    });
    const result = await runImplementVerifyLoop(loopDeps(rig, freshManager), {
      ...loopInput(rig),
      resume: { round },
    });

    expect(result.outcome).toBe('merge_ready');
    // Verifier dirt DISCARDED; HEAD forced to the persisted binding; clean.
    expect(fs.existsSync(path.join(worktreePath, 'verifier-scratch.log'))).toBe(false);
    expect(await git.resolveSha(worktreePath, 'HEAD')).toBe(implementationCommit);
    expect((await git.statusPorcelain(worktreePath)).trim()).toBe('');
    // The SAME immutable binding: spec/base/implementation commit unchanged.
    const verification = result.rounds[0]!.verification.verification;
    expect(String(verification.specHash)).toBe('spec_hash_1');
    expect(String(verification.implementationCommit)).toBe(implementationCommit);
    expect(String(verification.baseCommit)).toBe(String(result.worktree.baseSha));
    // A verify-only re-entry round: no in-process implementor result.
    expect(result.rounds[0]!.implementation).toBeUndefined();
    // worktreeClean was RE-PROBED after adoption (fresh §16 facts → ready).
    expect(result.mergeReadiness?.worktreeClean).toBe(true);
    expect(result.mergeReadiness?.ready).toBe(true);
    // The durable record says exactly what the adoption did.
    expect(rig.service.getImplementVerifyLoopState(rig.runId)?.worktree?.lastValidation?.detail).toContain(
      'verifier dirt discarded',
    );
  });

  it('checkpointed passed criteria carry ONLY with same-spec/commit-bound evidence (and never otherwise)', async () => {
    const rig = await openRig({
      implementor: [
        {
          writes: [{ relPath: 'src/feature.ts', content: 'export const feature = true;\n' }],
          turns: [implementorTurn('done')],
        },
      ],
      verifier: [
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] },
        // Re-entry with a MATCHING checkpoint: only AC-2 is re-verified.
        { turns: [verifierTurn([{ id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0' }])] },
      ],
    });
    const { round, implementationCommit } = await pauseVerifierRound(rig);
    expect(rig.service.resume(rig.runId).status).toBe('applied');

    // A checkpoint whose evidence is bound to the SAME spec + implementation
    // commit — AC-1 passed with the predecessor's own evidence bundle.
    const boundCheckpoint: CheckpointContent = buildCheckpointContent({
      lineage: { harnessId: 'claude', model: 'sonnet' },
      eventCursor: eventSequence(1),
      specHash: SPEC_HASH,
      criterionStates: [
        { criterionId: AC1, state: 'passed' },
        { criterionId: AC2, state: 'pending' },
      ],
      permissionPolicy: { mode: 'headless', allowlist: [] },
      worktree: {
        headSha: gitSha(implementationCommit),
        statusPorcelain: '',
        diffHash: artifactHash('d'),
        lockfileCleanupPerformed: false,
        taintFlags: [],
      },
      artifactRefs: [artifactHash('prior_ev_ac1')],
    });
    const result = await runImplementVerifyLoop(loopDeps(rig), {
      ...loopInput(rig),
      resume: { round, checkpoint: boundCheckpoint },
    });
    expect(result.outcome).toBe('merge_ready');
    const gathering = result.rounds[0]!.verification.gathering;
    expect(gathering.carriedCriterionIds.map(String)).toEqual(['AC-1']);
    expect(gathering.verifiedCriterionIds.map(String)).toEqual(['AC-2']);
    const carried = gathering.criteria.find((c) => String(c.criterionId) === 'AC-1');
    expect(carried?.evidenceRefs.map(String)).toEqual(['prior_ev_ac1']);
    // The re-entered verifier was prompted ONLY for AC-2.
    const verifierAdapters = rig.created.filter((c) => c.role === 'verifier');
    const reentryPrompt = verifierAdapters[1]!.prompts[0]!;
    expect(reentryPrompt).toContain('[AC-2]');
    expect(reentryPrompt).not.toContain('[AC-1]');
  });

  it('a checkpoint bound to a DIFFERENT implementation commit carries NOTHING — everything is re-verified', async () => {
    const rig = await openRig({
      implementor: [
        {
          writes: [{ relPath: 'src/feature.ts', content: 'export const feature = true;\n' }],
          turns: [implementorTurn('done')],
        },
      ],
      verifier: [{ turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }, { turns: [PASS_BOTH] }],
    });
    const { round } = await pauseVerifierRound(rig);
    expect(rig.service.resume(rig.runId).status).toBe('applied');

    const unboundCheckpoint: CheckpointContent = buildCheckpointContent({
      lineage: { harnessId: 'claude', model: 'sonnet' },
      eventCursor: eventSequence(1),
      specHash: SPEC_HASH,
      criterionStates: [
        { criterionId: AC1, state: 'passed' },
        { criterionId: AC2, state: 'pending' },
      ],
      permissionPolicy: { mode: 'headless', allowlist: [] },
      worktree: {
        headSha: gitSha('f'.repeat(40)), // NOT the round's implementation commit
        statusPorcelain: '',
        diffHash: artifactHash('d'),
        lockfileCleanupPerformed: false,
        taintFlags: [],
      },
      artifactRefs: [artifactHash('prior_ev_ac1')],
    });
    const result = await runImplementVerifyLoop(loopDeps(rig), {
      ...loopInput(rig),
      resume: { round, checkpoint: unboundCheckpoint },
    });
    expect(result.outcome).toBe('merge_ready');
    const gathering = result.rounds[0]!.verification.gathering;
    expect(gathering.carriedCriterionIds).toHaveLength(0);
    expect(gathering.verifiedCriterionIds.map(String)).toEqual(['AC-1', 'AC-2']);
  });
});

// ---------------------------------------------------------------------------
// needs_remediation re-entry — the NEXT implementor round from durable T23
// ---------------------------------------------------------------------------
describe('resume mode — needs_remediation re-entry', () => {
  it('drives implementor round N+1 with the remediation payload rebuilt from the durable T23 record', async () => {
    const rig = await openRig({
      implementor: [
        {
          writes: [{ relPath: 'src/feature.ts', content: 'export const feature = true;\n' }],
          turns: [implementorTurn('round 1')],
        },
        {
          writes: [{ relPath: 'src/fix.ts', content: 'export const fixed = true;\n' }],
          turns: [implementorTurn('round 2')],
        },
      ],
      verifier: [
        {
          turns: [
            verifierTurn([
              { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' },
              { id: 'AC-2', verdict: 'failed', evidence: 'ran check-ac2: exit 1', fix: 'gate the output' },
            ]),
          ],
        },
        { turns: [PASS_BOTH] },
      ],
    });

    // Round 1 ends in T23; the caller cap stops the loop there ("crash" point).
    const first = await runImplementVerifyLoop(loopDeps(rig), { ...loopInput(rig), maxRounds: 1 });
    expect(first.outcome).toBe('needs_remediation');
    expect(rig.service.status(rig.runId).phase).toBe('needs_remediation');
    const round = rig.service.getRoleRound(rig.runId)!;
    expect(round).toMatchObject({ role: 'verifier', round: 1, stage: 'completed' });

    // Rebuild the remediation payload from the DURABLE T23 record (what the
    // CLI re-entry driver does) and re-enter.
    const t23 = rig.db.events
      .listByRun(rig.runId)
      .find((e) => e.type === 'verification.completed.failed');
    expect(t23).toBeDefined();
    const fixRequests = rebuildFixRequestsFromT23(
      t23!.payload as Parameters<typeof rebuildFixRequestsFromT23>[0],
    );
    expect(fixRequests.some((f) => f.kind === 'criterion' && String(f.criterionId) === 'AC-2')).toBe(true);

    const result = await runImplementVerifyLoop(loopDeps(rig), {
      ...loopInput(rig),
      resume: { round, fixRequests },
    });
    expect(result.outcome).toBe('merge_ready');
    expect(result.rounds.map((r) => r.round)).toEqual([2]);
    // The round-2 implementor prompt carried the rebuilt remediation payload.
    const implementorAdapters = rig.created.filter((c) => c.role === 'implementor');
    const round2Prompt = implementorAdapters[1]!.prompts[0]!;
    expect(round2Prompt).toContain('Remediation round');
    expect(round2Prompt).toContain('AC-2');
  });
});

// ===========================================================================
// W4-4 — the DRIVER's run-ownership lease LIFECYCLE (acquire on entry, release
// in the outer `finally`).
//
// The store/CLI-gate tests (restart-safety-stage2, commands.draft-atomicity)
// prove the resume GATE consults the lease. This proves the OTHER half the
// between-rounds residual depends on: that `runImplementVerifyLoop` itself
// actually HOLDS the lease for the whole drive (so a concurrent resume in the
// dispose gap sees a live owner and withholds) and RELEASES it on exit (so a
// legitimate SEQUENTIAL resume is never permanently blocked — attack (c),
// including the self-deadlock where our OWN pid is always live). Observed from
// INSIDE the drive via the evidence recorder (called during the verifier round,
// after acquire and before the outer finally).
//
// Fails without the fix:
//  - remove the `acquireRunOwnership` at loop entry → the mid-drive observation
//    reads `false` → the `claimedMidDrive` assertion fails;
//  - remove the `releaseRunOwnership` from the outer `finally` → our own lease
//    (owner pid === self, always live) outlives the drive → the post-loop
//    `isRunClaimedByLiveProcess` assertion fails (the sequential-resume deadlock
//    the release exists to prevent).
// ===========================================================================
describe('W4-4 run-ownership lease — driver acquire/release lifecycle', () => {
  it('holds the lease across the whole drive and releases it in the outer finally', async () => {
    const rig = await openRig({
      implementor: [
        {
          writes: [{ relPath: 'src/feature.ts', content: 'export const feature = true;\n' }],
          turns: [implementorTurn('round 1')],
        },
      ],
      verifier: [{ turns: [PASS_BOTH] }],
    });

    // Before the driver runs, nobody owns the run.
    expect(rig.service.isRunClaimedByLiveProcess(rig.runId)).toBe(false);

    // Observe the lease from INSIDE the drive — the evidence recorder runs
    // during the verifier round, strictly between acquire (loop entry) and the
    // outer `finally`. Without the acquire this reads `false`.
    let claimedMidDrive: boolean | undefined;
    const observingEvidence: EvidenceRecorder = {
      async record(input) {
        claimedMidDrive ??= rig.service.isRunClaimedByLiveProcess(rig.runId);
        return artifactHash(`ev_${String(input.criterionId)}`);
      },
    };

    const result = await runImplementVerifyLoop(loopDeps(rig), {
      ...loopInput(rig),
      evidence: observingEvidence,
      maxRounds: 1,
    });
    expect(result.outcome).toBe('merge_ready');

    // Held DURING the drive (self is the live owner) ...
    expect(claimedMidDrive).toBe(true);
    // ... and RELEASED after the outer `finally` — a later sequential resume is
    // never blocked by our own stale lease.
    expect(rig.service.isRunClaimedByLiveProcess(rig.runId)).toBe(false);
  });
});

// ===========================================================================
// W4-2 STAGE 1 / review-6 F2 — the driver acquires the EXCLUSIVE lease BEFORE
// any worktree work AND checks the compare-and-swap result:
//   - ORDERING: acquire strictly precedes worktree create (was AFTER it);
//   - REFUSAL: a lost CAS (a still-live peer owns the run) makes the driver
//     WITHHOLD with an honest error and create NO worktree — a fire-and-forget
//     acquire could not close this concurrent-same-run double-drive.
// ===========================================================================
describe('W4-2 F2 — acquire-before-worktree ordering + refuse-on-lost-CAS', () => {
  it('acquires the run-ownership lease BEFORE creating the worktree (fails without the fix: acquire ran AFTER worktree create/adopt)', async () => {
    const rig = await openRig({
      implementor: [
        {
          writes: [{ relPath: 'src/feature.ts', content: 'export const feature = true;\n' }],
          turns: [implementorTurn('round 1')],
        },
      ],
      verifier: [{ turns: [PASS_BOTH] }],
    });

    // Record the interleaving of acquire vs. worktree creation.
    const order: string[] = [];
    const realAcquire = rig.service.acquireRunOwnership.bind(rig.service);
    rig.service.acquireRunOwnership = (id): boolean => {
      order.push('acquire');
      return realAcquire(id);
    };
    const realCreate = rig.worktrees.createWorktree.bind(rig.worktrees);
    rig.worktrees.createWorktree = async (opts) => {
      // At worktree-create time the lease must ALREADY be held (acquire first).
      order.push('worktree');
      expect(rig.service.isRunClaimedByLiveProcess(rig.runId)).toBe(true);
      return realCreate(opts);
    };

    const result = await runImplementVerifyLoop(loopDeps(rig), { ...loopInput(rig), maxRounds: 1 });
    expect(result.outcome).toBe('merge_ready');
    expect(order[0]).toBe('acquire'); // acquire STRICTLY before worktree create
    expect(order).toEqual(['acquire', 'worktree']);
  });

  it('refuses to drive (RunOwnershipConflictError) and creates NO worktree when the CAS is LOST', async () => {
    const rig = await openRig({
      implementor: [{ writes: [], turns: [implementorTurn('unused')] }],
      verifier: [{ turns: [PASS_BOTH] }],
    });

    // Simulate losing the compare-and-swap to a still-live peer owner.
    let createCalled = false;
    rig.service.acquireRunOwnership = (): boolean => false;
    const realCreate = rig.worktrees.createWorktree.bind(rig.worktrees);
    rig.worktrees.createWorktree = async (opts) => {
      createCalled = true;
      return realCreate(opts);
    };

    const thrown: unknown = await runImplementVerifyLoop(loopDeps(rig), {
      ...loopInput(rig),
      maxRounds: 1,
    }).catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(RunOwnershipConflictError);
    // WITHHELD before any worktree I/O — no worktree was created/adopted.
    expect(createCalled).toBe(false);
    expect(rig.worktrees.handleFor(assignmentId(`asg_${rig.runId}`))).toBeUndefined();
  });
});
