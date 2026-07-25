/**
 * B2 — auto-approval (docs/AUTONOMOUS-BASE-PLAN.md §1), asserted through the
 * SHIPPED CLI surface (`executeCommand`) with in-process fake adapters and a
 * REAL temp git repo, exactly as `commands.wiring.test.ts` drives the P3 slice.
 *
 * What these tests pin down, in the order the contract states it:
 *
 *  1. BOTH config values genuinely ACT (W4-1). `approval: 'human'` (the
 *     DEFAULT) holds the run at `awaiting_approval` with no `spec.approved`
 *     event; `approval: 'auto'` reaches `approved` inside `start`.
 *  2. Auto-approval binds the REAL drafted hash (W1-F3) and is EVENTED as
 *     `spec.approved {approvedBy:'auto'}`, so the audit trail shows that no
 *     human signed it. `--test-approve`'s fabricated hash stays unreachable.
 *  3. The §7 TESTABILITY GATE still runs: an untestable criterion never
 *     completes a drafting round, so autonomy never gets a spec to approve.
 *  4. Auto-approval runs the SAME W3-4 validation as a human approval — a
 *     MISSING/STALE draft refuses with the identical code and exit.
 *  5. The mode is PINNED per run (W1-F5): a later process under the opposite
 *     ambient config can neither grant nor revoke autonomy.
 *  6. The §16 merge-readiness report SAYS the spec was auto-approved, on both
 *     the JSON and the human surface — a merge reviewer must not have to dig
 *     for the fact that nobody reviewed the intent.
 *
 * Both SQLite drivers are exercised: the approval mode lives in the run's
 * persisted config projection and the signature lives in the event log.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import {
  artifactHash,
  specHash as toSpecHash,
  specVersionId as toSpecVersionId,
  type RunId,
} from '../domain/ids.js';
import {
  availableDriverKinds,
  openTestDatabase,
  type TestDatabaseHandle,
} from '../persistence/test-support.js';
import type { DriverKind } from '../persistence/index.js';
import { ArtifactStore } from '../artifacts/store.js';
import { loadProfileFile, type Profile } from '../config/profile.js';
import { parseEngineConfig } from '../config/loader.js';
import type { EngineConfig } from '../config/schema.js';
import { unwrap } from '../lib/result.js';
import {
  InProcessFakeAdapter,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
} from '../adapters/index.js';
import { GitWorktreeManager } from '../worktree/index.js';
import { makeTempGitRepo, type TempGitRepo } from '../worktree/test-support.js';
import {
  OrchestrationService,
  type Harness,
  type RoleAdapterFactory,
  type RoleModelSpec,
} from '../app/index.js';
import { CoordinatorRunner } from '../app/flows/coordinator.js';
import type { EvidenceRecorder } from '../app/flows/verifier.js';
import type { VerificationRunner } from '../app/flows/implementor.js';
import { executeCommand, type CliFlowDeps } from './commands.js';

const GOAL = 'Add a --verbose flag to the CLI so debug lines print to stderr.';
const COORDINATOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const IMPLEMENTOR: RoleModelSpec = { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const PROFILE_PATH = fileURLToPath(new URL('../../profiles/coordinator.md', import.meta.url));

const HUMAN_CONFIG = (): EngineConfig => unwrap(parseEngineConfig({}));
const AUTO_CONFIG = (): EngineConfig => unwrap(parseEngineConfig({ approval: 'auto' }));

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

/** A §7-valid spec: every criterion's expected evidence names a concrete observable. */
function validSpec(): Record<string, unknown> {
  return {
    goal: GOAL,
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
    ],
    rollback: 'Revert the single commit on the worktree branch.',
    proposedImplementorProfile: 'implementor',
    proposedVerifierProfile: 'verifier',
  };
}

/**
 * The SAME spec with its evidence stripped of every concrete observable —
 * `assessSpecSemantics`'s testability gate must reject it. This is the ONLY
 * automated filter left between a coordinator's plan and real work once the
 * human input gate is gone, so it is asserted under `approval: 'auto'`.
 */
function untestableSpec(): Record<string, unknown> {
  return {
    ...validSpec(),
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'The verbose behaviour is good',
        // Schema-VALID (a command is declared) so the refusal below can only
        // come from `assessSpecSemantics` — the §7 testability gate itself,
        // not the shape check that runs before it.
        verificationCommands: ['echo check-ac1'],
        expectedEvidence: 'the feature works properly and looks right',
      },
    ],
  };
}

const fence = (o: unknown): string => '```json\n' + JSON.stringify(o, null, 2) + '\n```';

const coordinatorTurn = (spec: unknown): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text: `Here is the specification.\n\n${fence(spec)}` }],
  result: { stopReason: 'end_turn' },
});

const implementorTurn = (text: string): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text }],
  result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 40, source: 'adapter' } },
});

const verifierTurn = (
  rows: ReadonlyArray<{ id: string; verdict: string; evidence?: string }>,
): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text: JSON.stringify({ criteria: rows }) }],
  result: { stopReason: 'end_turn' },
});

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

interface Scripts {
  readonly coordinator?: readonly AdapterScript[];
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}

function makeFactory(scripts: Scripts): RoleAdapterFactory {
  const cursors: Record<string, number> = {};
  return {
    create(options) {
      const role = options.role;
      const idx = cursors[role] ?? 0;
      cursors[role] = idx + 1;
      const queue = scripts[role as keyof Scripts] ?? [];
      const script: AdapterScript = queue[idx] ?? { turns: [] };
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: configOptionsFor(options.resolved.harness) },
        turns: script.turns,
      });
      const orig = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (input) => {
        for (const write of script.writes ?? []) {
          const target = path.join(options.cwd, write.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, write.content, 'utf8');
        }
        return orig(input);
      };
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
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

interface Wired {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly deps: { readonly ids: DeterministicIdFactory; readonly flows: CliFlowDeps };
  /** Build ANOTHER service over the SAME store, under a different ambient config. */
  readonly reopen: (config: EngineConfig) => OrchestrationService;
}

async function setup(kind: DriverKind, config: EngineConfig, scripts: Scripts): Promise<Wired> {
  repo = await makeTempGitRepo('harness-cli-autoapprove-');
  dbHandle = await openTestDatabase({ kind, file: true });
  worktrees = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: dbHandle.db.clock });
  const ids = new DeterministicIdFactory();
  const flowIds = new DeterministicIdFactory();
  const adapterFactory = makeFactory(scripts);
  const db = dbHandle.db;
  const service = new OrchestrationService({ db, ids, adapterFactory, config });
  const store = new ArtifactStore({ rootDir: dbHandle.casRoot, clock: db.clock, ids: flowIds });
  const profileResult = loadProfileFile(PROFILE_PATH);
  if (!profileResult.ok) throw new Error(`coordinator profile failed to load: ${JSON.stringify(profileResult.error)}`);
  const profile: Profile = profileResult.value;
  const mgr = worktrees;
  const flows: CliFlowDeps = {
    ids,
    clock: db.clock,
    buildCoordinatorRunner: ({ goal, revise, baseCommit }) =>
      new CoordinatorRunner({
        goal,
        profile,
        artifactStore: store,
        ids: flowIds,
        clock: db.clock,
        baseCommit,
        // One round only: the retry loop would otherwise re-prompt a fake with
        // an exhausted script and mask WHICH emission the gate rejected.
        maxRounds: 1,
        ...(revise !== undefined ? { revise } : {}),
      }),
    openWorktrees: async () => mgr,
    evidence: fakeEvidence(),
    runVerification: PASS_VERIFY,
  };
  return {
    service,
    db,
    deps: { ids, flows },
    reopen: (other) => new OrchestrationService({ db, ids, adapterFactory, config: other }),
  };
}

/**
 * A service view whose W3-4 draft read-model is DAMAGED. `start` drafts and
 * auto-approves back to back inside ONE process, so this is the only way to
 * put the auto path in front of the projection loss the approve path exists to
 * refuse. Every other method is the REAL service (bound to the real receiver,
 * so its private state still works).
 */
function withDamagedDraft(
  service: OrchestrationService,
  opts: { readonly keepCompletionRef: boolean },
): OrchestrationService {
  return new Proxy(service, {
    get(target, prop): unknown {
      if (prop === 'getSpecDraft') return () => undefined;
      if (prop === 'getCoordinatorCompletion' && !opts.keepCompletionRef) return () => undefined;
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

const DRIVER_KINDS = await availableDriverKinds();

describe.each(DRIVER_KINDS)('B2 auto-approval [%s]', (kind) => {
  // -------------------------------------------------------------------------
  // 1 + 2 — both values ACT; `auto` binds the REAL hash and is evented
  // -------------------------------------------------------------------------
  it("DEFAULT approval:'human' — start WAITS at awaiting_approval and emits no spec.approved", async () => {
    const { service, db, deps } = await setup(kind, HUMAN_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(start.exitCode).toBe(0);
    const runId = start.json['runId'] as RunId;
    expect(start.json['phase']).toBe('awaiting_approval');
    expect(start.json['approval']).toBeUndefined();
    expect(start.text).toContain(`next: approve ${runId}`);
    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(service.status(runId).approvedSpecHash).toBeUndefined();
    expect(service.status(runId).specApprovedBy).toBeUndefined();
    expect(db.events.listByRun(runId).map((e) => e.type)).not.toContain('spec.approved');
  });

  it("approval:'auto' — start reaches approved, binding the REAL drafted hash, evented approvedBy:'auto'", async () => {
    const { service, db, deps } = await setup(kind, AUTO_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(start.exitCode).toBe(0);
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };

    // The run advanced WITHOUT a human: phase `approved`, no wait state.
    expect(start.json['phase']).toBe('approved');
    expect(service.status(runId).phase).toBe('approved');

    // W1-F3: the bound hash is the DRAFTED one, byte for byte.
    expect(String(service.status(runId).approvedSpecHash)).toBe(spec.specHash);
    expect(start.json['approval']).toEqual({
      mode: 'auto',
      specVersionId: spec.specVersionId,
      specHash: spec.specHash,
      transitionId: 'T1',
    });

    // EVENTED: the audit trail says the engine signed it, and the payload
    // carries the same real hash (never `--test-approve`'s synthetic one).
    const approvedEvents = db.events.listByRun(runId).filter((e) => e.type === 'spec.approved');
    expect(approvedEvents).toHaveLength(1);
    expect(approvedEvents[0]!.payload).toEqual({
      specVersionId: spec.specVersionId,
      specHash: spec.specHash,
      approvedBy: 'auto',
    });
    expect(spec.specHash).not.toContain('test-approve');
    expect(service.status(runId).specApprovedBy).toBe('auto');

    // The operator is TOLD, on the human surface, that nobody reviewed it.
    expect(start.text).toContain('AUTO-APPROVED');
    expect(start.text).toContain('no human reviewed this spec');
    expect(start.text).toContain(`next: run ${runId}`);
    expect(start.text).not.toContain(`next: approve ${runId}`);
  });

  // -------------------------------------------------------------------------
  // 3 — the §7 testability gate is the last automated filter; it still runs
  // -------------------------------------------------------------------------
  it("approval:'auto' — an UNTESTABLE spec is refused; no run is ever approved", async () => {
    const { service, db, deps } = await setup(kind, AUTO_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(untestableSpec())] }],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(start.exitCode).not.toBe(0);
    // The refusal names the testability gate, verbatim from assessSpecSemantics.
    expect(JSON.stringify(start.json)).toContain('not objectively testable');

    // Nothing was approved — under autonomy this gate is what stops the work.
    const runId = start.json['runId'] as RunId | undefined;
    const approvals = db.events
      .listByRun(runId ?? ('run_none' as RunId))
      .filter((e) => e.type === 'spec.approved');
    expect(approvals).toHaveLength(0);
    if (runId !== undefined) expect(service.status(runId).phase).not.toBe('approved');
  });

  // -------------------------------------------------------------------------
  // 4 — the SAME W3-4 validation a human approval runs
  // -------------------------------------------------------------------------
  it("approval:'auto' — a MISSING draft refuses with the SAME code/exit as an explicit approve", async () => {
    const { service, db, deps } = await setup(kind, AUTO_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
    });
    const damaged = withDamagedDraft(service, { keepCompletionRef: true });
    const start = await executeCommand(
      damaged,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(start.exitCode).toBe(1);
    expect(start.json['refused']).toBe('spec_draft_missing');
    expect(start.json['detail']).toContain('W3-4');
    const runId = start.json['runId'] as RunId;
    expect(service.status(runId).phase).toBe('awaiting_approval'); // NOT approved
    expect(db.events.listByRun(runId).map((e) => e.type)).not.toContain('spec.approved');

    // A HUMAN approve on the same damaged run refuses identically — auto is
    // not a softer gate, it is the same gate with a different signer.
    const human = await executeCommand(
      damaged,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId('spec_1'),
        specHash: toSpecHash('whatever'),
        testApprove: false,
      },
      {},
      deps,
    );
    expect(human.exitCode).toBe(start.exitCode);
    expect(human.json['refused']).toBe(start.json['refused']);
  });

  it("approval:'auto' — with NO draft and NO completion ref the engine refuses rather than fabricating a hash", async () => {
    const { service, db, deps } = await setup(kind, AUTO_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
    });
    const start = await executeCommand(
      withDamagedDraft(service, { keepCompletionRef: false }),
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(start.exitCode).toBe(1);
    expect(start.json['refused']).toBe('auto_approve_no_draft');
    const runId = start.json['runId'] as RunId;
    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(db.events.listByRun(runId).map((e) => e.type)).not.toContain('spec.approved');
  });

  it("--test-approve keeps its HARNESS_TEST_MODE guard under approval:'auto'", async () => {
    const { service, db, deps } = await setup(kind, AUTO_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };
    const refused = await executeCommand(
      service,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId(spec.specVersionId),
        specHash: toSpecHash(spec.specHash),
        testApprove: true,
      },
      {}, // no HARNESS_TEST_MODE
      deps,
    );
    expect(refused.exitCode).toBe(2);
    expect(refused.json['refused']).toBe('test_approve_guard');
  });

  // -------------------------------------------------------------------------
  // 5 — the mode is PINNED per run and immutable once started (W1-F5)
  // -------------------------------------------------------------------------
  it("the run's PINNED approval mode wins over a later process's ambient config, in both directions", async () => {
    // (a) created under `auto`; a later HUMAN-configured process still auto-approves.
    const auto = await setup(kind, AUTO_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }, { turns: [coordinatorTurn(validSpec())] }],
    });
    const started = await executeCommand(
      auto.service,
      auto.db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      auto.deps,
    );
    const autoRunId = started.json['runId'] as RunId;
    expect(auto.service.getRunConfig(autoRunId)?.approval).toBe('auto');
    expect(started.json['phase']).toBe('approved');

    // (b) created under the DEFAULT human gate; a later AUTO-configured
    // process must NOT approve it — autonomy cannot be granted after the fact.
    const humanWired = await setup(kind, HUMAN_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }, { turns: [coordinatorTurn(validSpec())] }],
    });
    const humanStart = await executeCommand(
      humanWired.service,
      humanWired.db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      humanWired.deps,
    );
    const humanRunId = humanStart.json['runId'] as RunId;
    expect(humanStart.json['phase']).toBe('awaiting_approval');

    const laterAutoService = humanWired.reopen(AUTO_CONFIG());
    const revised = await executeCommand(
      laterAutoService,
      humanWired.db,
      { kind: 'spec_revise', json: true, runId: humanRunId, feedback: 'tighten AC-1' },
      {},
      humanWired.deps,
    );
    expect(revised.exitCode).toBe(0);
    expect(revised.json['phase']).toBe('awaiting_approval');
    expect(revised.json['approval']).toBeUndefined();
    expect(laterAutoService.status(humanRunId).phase).toBe('awaiting_approval');
    expect(humanWired.db.events.listByRun(humanRunId).map((e) => e.type)).not.toContain('spec.approved');
  });

  it("after a SUCCESSFUL auto-approval, `spec revise` is correctly illegal (the run is past awaiting_approval)", async () => {
    const { service, db, deps } = await setup(kind, AUTO_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    // Auto-approval already took the run to `approved`, so T2's
    // `awaiting_approval` precondition fails. The revise hatch therefore only
    // ever serves a run the engine REFUSED to sign — the next test.
    const revise = await executeCommand(
      service,
      db,
      { kind: 'spec_revise', json: true, runId, feedback: 'tighten AC-1' },
      {},
      deps,
    );
    expect(revise.json['outcome']).toBe('rejected');
    expect(service.status(runId).phase).toBe('approved');
  });

  it("a REFUSED auto-approval is repaired by `spec revise`, which auto-approves the SUPERSEDING draft", async () => {
    // The W3-4 recovery path must not strand an autonomous run at the very
    // gate it is pinned not to have: the completed revise round lands at
    // awaiting_approval exactly as `start` does, so the same pinned mode signs
    // the NEW draft — and W1-F3 binds the NEW hash, never the superseded one.
    const revisedSpec = {
      ...validSpec(),
      rollback: 'Revert the single commit on the worktree branch; then re-run the suite.',
    };
    const { service, db, deps } = await setup(kind, AUTO_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }, { turns: [coordinatorTurn(revisedSpec)] }],
    });
    // `start` through the damaged view: the draft IS persisted, the auto path
    // just cannot see it → refusal, run parked at awaiting_approval.
    const refused = await executeCommand(
      withDamagedDraft(service, { keepCompletionRef: true }),
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(refused.json['refused']).toBe('spec_draft_missing');
    const runId = refused.json['runId'] as RunId;
    const supersededHash = refused.json['completionSpecHash'] as string;
    expect(service.status(runId).phase).toBe('awaiting_approval');

    // The operator's documented recovery, now on the UNDAMAGED service.
    const revise = await executeCommand(
      service,
      db,
      { kind: 'spec_revise', json: true, runId, feedback: 'spell out the rollback steps' },
      {},
      deps,
    );
    expect(revise.exitCode).toBe(0);
    expect(revise.json['phase']).toBe('approved');
    const newSpec = revise.json['spec'] as { specVersionId: string; specHash: string; revision: number };
    expect(newSpec.revision).toBe(2);
    expect(newSpec.specHash).not.toBe(supersededHash); // a genuinely superseding draft
    expect(revise.json['approval']).toEqual({
      mode: 'auto',
      specVersionId: newSpec.specVersionId,
      specHash: newSpec.specHash,
      transitionId: 'T1',
    });
    expect(revise.text).toContain('AUTO-APPROVED');

    // The engine bound the NEW hash, and the log names the engine as signer.
    expect(String(service.status(runId).approvedSpecHash)).toBe(newSpec.specHash);
    expect(service.status(runId).specApprovedBy).toBe('auto');
    const approvals = db.events.listByRun(runId).filter((e) => e.type === 'spec.approved');
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.payload).toMatchObject({ specHash: newSpec.specHash, approvedBy: 'auto' });
  });

  // -------------------------------------------------------------------------
  // 6 — the merge-readiness report SAYS the spec was auto-approved
  // -------------------------------------------------------------------------
  it("the §16 merge-readiness report reports specApprovedBy:'auto' on both surfaces", async () => {
    const { service, db, deps } = await setup(kind, AUTO_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        {
          writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const verbose = true;\n' }],
          turns: [implementorTurn('Implemented --verbose.')],
        },
      ],
      verifier: [
        { turns: [verifierTurn([{ id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' }])] },
      ],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    expect(start.json['phase']).toBe('approved'); // no `approve` command was ever issued

    const run = await executeCommand(
      service,
      db,
      { kind: 'run', json: true, runId, implementor: IMPLEMENTOR, verifier: VERIFIER },
      {},
      deps,
    );
    expect(run.exitCode).toBe(0);
    expect(run.json['outcome']).toBe('merge_ready');
    const mr = run.json['mergeReadiness'] as { ready: boolean; specApprovedBy: string };
    expect(mr.ready).toBe(true);
    expect(mr.specApprovedBy).toBe('auto');
    expect(run.text).toContain('spec approval: AUTO');
    expect(run.text).toContain('NO human reviewed the intent');
  });

  it("a human-approved run's merge-readiness report says specApprovedBy:'human' and carries no auto notice", async () => {
    const { service, db, deps } = await setup(kind, HUMAN_CONFIG(), {
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        {
          writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const verbose = true;\n' }],
          turns: [implementorTurn('Implemented --verbose.')],
        },
      ],
      verifier: [
        { turns: [verifierTurn([{ id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' }])] },
      ],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };
    const approved = await executeCommand(
      service,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId(spec.specVersionId),
        specHash: toSpecHash(spec.specHash),
        testApprove: false, // a REAL explicit human approval, not the test seam
      },
      {},
      deps,
    );
    expect(approved.exitCode).toBe(0);
    expect(service.status(runId).specApprovedBy).toBe('human');

    const run = await executeCommand(
      service,
      db,
      { kind: 'run', json: true, runId, implementor: IMPLEMENTOR, verifier: VERIFIER },
      {},
      deps,
    );
    expect(run.json['outcome']).toBe('merge_ready');
    const mr = run.json['mergeReadiness'] as { specApprovedBy: string };
    expect(mr.specApprovedBy).toBe('human');
    expect(run.text).not.toContain('spec approval: AUTO');
  });
});
