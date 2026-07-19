/**
 * W2-7 — the FULL §19 test-24 MATRIX through the shipped CLI (spec
 * docs/specs/hardening-p4a.md §W2-7; PLAN §13, §18, §19 test 24): the
 * pause→resume e2e for an IMPLEMENTOR round, a COORDINATOR round (during
 * `start`), and a REVISION-COORDINATOR round (during `spec revise`) — every
 * flavor on the injectable fake clock, through the ONE shared
 * LimitPausedError policy handler, asserting the same fact set:
 *
 *  - the §12.2 checkpoint recorded (`pre_pause`), a CLEAN generation-matched
 *    stop, ZERO respawns (no `segment.restart.initiated`, restart counters
 *    untouched);
 *  - an honestly-UNKNOWN ETA (no structured reset → etaSource `unknown`,
 *    never an invented countdown — snapshotted mid-wait);
 *  - the scheduled probe ladder: fenced claim → T10 (still limited) + the
 *    explicit next `limit.probe.scheduled` rung → fenced claim → T9 (mode
 *    `scheduled_probe`) at the event-anchored deadlines (sleeps are exactly
 *    rung + deterministic jitter);
 *  - the re-entry completes and the run reaches `merge_ready` end to end.
 *
 * Sibling coverage this file deliberately does NOT duplicate:
 * cli/commands.limit.test.ts owns `--no-wait` exit-3 surfaces, the elapsed
 * structured retry_after path, `resume --wait`, eligibility refusals, the
 * `status --json` limit block, and startup reclaim; the per-boundary crash
 * matrix lives in app/pause-crash-injection.test.ts.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import {
  artifactHash,
  runId as toRunId,
  specHash as toSpecHash,
  specVersionId as toSpecVersionId,
  type RunId,
} from '../domain/ids.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { ArtifactStore } from '../artifacts/store.js';
import { loadProfileFile, type Profile } from '../config/profile.js';
import {
  InProcessFakeAdapter,
  rateLimitErrorEnvelope,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
} from '../adapters/index.js';
import { deterministicJitterMs, type ResumePlan } from '../scheduler/limit-schedule.js';
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
import { executeCommand, type CliFlowDeps, type CommandDeps, type WaitScheduler } from './commands.js';

const GOAL = 'Add a --verbose flag to the CLI so debug lines print to stderr.';
const COORDINATOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const IMPLEMENTOR: RoleModelSpec = { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const PROFILE_PATH = fileURLToPath(new URL('../../profiles/coordinator.md', import.meta.url));
const T0 = '2026-07-18T00:00:00.000Z';
/** DeterministicIdFactory mints run_000001 for the first run of every test. */
const RUN1 = toRunId('run_000001');
const RUNG1_MS = 30 * 60_000;
const RUNG2_MS = 60 * 60_000;

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

function validSpec(): Record<string, unknown> {
  return {
    goal: GOAL,
    assumptions: [],
    openQuestions: [],
    constraints: ['Touch only files under src/cli'],
    permissions: ['read and write within the assigned worktree'],
    nonGoals: [],
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

const fence = (o: unknown): string => '```json\n' + JSON.stringify(o, null, 2) + '\n```';

const coordinatorTurn = (spec: unknown): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text: `Here is the specification.\n\n${fence(spec)}` }],
  result: { stopReason: 'end_turn' },
});

const implementorTurn = (): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text: 'implemented' }],
  result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 40, source: 'adapter' } },
});

const verifierPassTurn = (): InProcessTurnScript => ({
  updates: [
    {
      kind: 'agent_message_chunk',
      text: JSON.stringify({
        criteria: [{ id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' }],
      }),
    },
  ],
  result: { stopReason: 'end_turn' },
});

const PASS_VERIFY: VerificationRunner = async (command) => ({
  exitCode: 0,
  stdout: `ran ${command}`,
  stderr: '',
  launchFailed: false,
});

const LIMIT_TURN: InProcessTurnScript = { errorEnvelope: rateLimitErrorEnvelope() };

interface AdapterScript {
  readonly writes?: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly turns: readonly InProcessTurnScript[];
}

function makeFactory(scripts: {
  readonly coordinator?: readonly AdapterScript[];
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}): RoleAdapterFactory {
  const cursors: Record<string, number> = {};
  return {
    create(options) {
      const role = options.role;
      const idx = cursors[role] ?? 0;
      cursors[role] = idx + 1;
      const queue = scripts[role as keyof typeof scripts] ?? [];
      const script: AdapterScript = queue[idx] ?? { turns: [] };
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        clock: options.clock,
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

/** Mid-wait honest-ETA posture, captured on every schedule-loop sleep. */
interface PausedSnapshot {
  readonly suspension: string;
  readonly plan: ResumePlan | undefined;
}

interface Wired {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly clock: ManualClock;
  readonly deps: CommandDeps;
  readonly sleeps: number[];
  readonly snapshots: PausedSnapshot[];
  /** Set by the test once the runId exists; the waiter snapshots it. */
  readonly snapshotTarget: { runId?: RunId };
}

async function setup(scripts: {
  readonly coordinator?: readonly AdapterScript[];
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}): Promise<Wired> {
  repo = await makeTempGitRepo('harness-cli-matrix-');
  const clock = new ManualClock(T0);
  dbHandle = await openTestDatabase({ kind: 'better-sqlite3', file: true, clock });
  worktrees = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock });
  const ids = new DeterministicIdFactory();
  const flowIds = new DeterministicIdFactory();
  const service = new OrchestrationService({ db: dbHandle.db, ids, adapterFactory: makeFactory(scripts) });
  const store = new ArtifactStore({ rootDir: dbHandle.casRoot, clock, ids: flowIds });
  const profileResult = loadProfileFile(PROFILE_PATH);
  if (!profileResult.ok) throw new Error('coordinator profile failed to load');
  const profile: Profile = profileResult.value;
  const mgr = worktrees;
  const flows: CliFlowDeps = {
    ids,
    clock,
    buildCoordinatorRunner: ({ goal, revise }) =>
      new CoordinatorRunner({
        goal,
        profile,
        artifactStore: store,
        ids: flowIds,
        clock,
        ...(revise !== undefined ? { revise } : {}),
      }),
    openWorktrees: async () => mgr,
    evidence: fakeEvidence(),
    runVerification: PASS_VERIFY,
  };
  const sleeps: number[] = [];
  const snapshots: PausedSnapshot[] = [];
  const snapshotTarget: { runId?: RunId } = {};
  // A waiter that ADVANCES the manual clock instead of sleeping (W2-5 seam),
  // snapshotting the paused posture BEFORE each advance — the mid-wait view.
  const waiter: WaitScheduler = {
    sleep: async (ms) => {
      if (snapshotTarget.runId !== undefined) {
        snapshots.push({
          suspension: service.status(snapshotTarget.runId).suspension,
          plan: service.getResumePlan(snapshotTarget.runId),
        });
      }
      sleeps.push(ms);
      clock.advanceMs(ms);
    },
  };
  const deps: CommandDeps = { ids, flows, waiter };
  return { service, db: dbHandle.db, clock, deps, sleeps, snapshots, snapshotTarget };
}

/** Approve the drafted spec (test mode binds the REAL draft hash, W1-F3). */
async function approveDraft(
  w: Wired,
  runId: RunId,
  spec: { specVersionId: string; specHash: string },
): Promise<void> {
  const approve = await executeCommand(
    w.service,
    w.db,
    {
      kind: 'approve',
      json: true,
      runId,
      specVersionId: toSpecVersionId(spec.specVersionId),
      specHash: toSpecHash(spec.specHash),
      testApprove: true,
    },
    { HARNESS_TEST_MODE: '1' },
  );
  expect(approve.exitCode).toBe(0);
}

const RUN_CMD = (runId: RunId) => ({
  kind: 'run' as const,
  json: true,
  runId,
  implementor: IMPLEMENTOR,
  verifier: VERIFIER,
});

/** The shared test-24 fact set every matrix flavor must satisfy. */
function assertMatrixFacts(w: Wired, runId: RunId): void {
  const log = w.db.events.listByRun(runId);
  const types = log.map((e) => e.type);

  // Exactly one incident, honestly unknown — never an invented countdown.
  const incidents = log.filter((e) => e.type === 'limit.incident.recorded');
  expect(incidents).toHaveLength(1);
  expect(incidents[0]!.payload).toMatchObject({ incidentKind: 'usage_limit', etaSource: 'unknown' });
  expect((incidents[0]!.payload as { resumesAt?: string }).resumesAt).toBeUndefined();

  // The §12.2 pause checkpoint was recorded.
  const checkpoints = log.filter((e) => e.type === 'checkpoint.recorded');
  expect(checkpoints.some((e) => (e.payload as { reason: string }).reason === 'pre_pause')).toBe(true);

  // Clean stop: durable stop-intent, then the generation-MATCHED graceful
  // confirmation.
  const intent = log.find((e) => e.type === 'child.stop.intent');
  expect(intent).toBeDefined();
  const pausedGeneration = (intent!.payload as { generationId: string }).generationId;
  const stop = log.find(
    (e) =>
      e.type === 'child.stopped' &&
      (e.payload as { generationId: string }).generationId === pausedGeneration,
  );
  expect(stop?.payload).toMatchObject({ reason: 'graceful' });
  expect(log.indexOf(intent!)).toBeLessThan(log.indexOf(stop!));

  // ZERO respawns — a limit pause never restarts anything (§13).
  expect(types).not.toContain('segment.restart.initiated');
  const st = w.service.status(runId);
  expect(st.counters.restartsInWindow).toBe(0);
  expect(st.counters.lifetimeRestarts).toBe(0);

  // The probe ladder: fenced claim → T10 → the explicit next rung → fenced
  // claim → T9 (mode scheduled_probe), in order.
  const claims = log.filter((e) => e.type === 'limit.probe.claimed');
  expect(claims.map((e) => (e.payload as { probeIndex: number }).probeIndex)).toEqual([1, 2]);
  expect(types.filter((t) => t === 'limit.probe.still_limited')).toHaveLength(1);
  const scheduled = log.find((e) => e.type === 'limit.probe.scheduled');
  expect(scheduled?.payload).toMatchObject({ rung: 60, probeIndex: 2 });
  const t9s = log.filter((e) => e.type === 'resume.limit.requested');
  expect(t9s).toHaveLength(1);
  expect(t9s[0]!.payload).toEqual({ mode: 'scheduled_probe' });
  expect(types.indexOf('limit.probe.still_limited')).toBeLessThan(
    types.indexOf('resume.limit.requested'),
  );

  // The re-entry was acked when the resumed round went active.
  expect(types).toContain('resume_reentry.completed');
  expect(st.resumeReentryPending).toBeUndefined();

  // The schedule slept exactly to the event-anchored deadlines: rung 30 then
  // rung 60, each plus the deterministic (runId, probeIndex) jitter.
  expect(w.sleeps).toEqual([
    RUNG1_MS + deterministicJitterMs(RUN1, 1, RUNG1_MS),
    RUNG2_MS + deterministicJitterMs(RUN1, 2, RUNG2_MS),
  ]);

  // The mid-wait posture was honest at every sleep: durably paused, the plan
  // a LADDER deadline (never an invented provider ETA).
  expect(w.snapshots.length).toBeGreaterThan(0);
  for (const snapshot of w.snapshots) {
    expect(snapshot.suspension).toBe('paused_limit');
    expect(snapshot.plan?.kind).toBe('probe_at');
    if (snapshot.plan?.kind === 'probe_at') expect(snapshot.plan.rung).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// Flavor 1 — IMPLEMENTOR round pause under `run` (default wait policy)
// ---------------------------------------------------------------------------
describe('test-24 matrix — implementor round', () => {
  it('run waits: unknown-ETA pause → T10 → T9 → re-entry → merge_ready with the full fact set', async () => {
    const w = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        { turns: [LIMIT_TURN] }, // round 1: limit mid-turn, no ETA
        { turns: [LIMIT_TURN] }, // probe 1: still limited (T10)
        { turns: [{}] }, // probe 2: healthy (T9)
        { writes: [{ relPath: 'src/f.ts', content: 'export const f = 1;\n' }], turns: [implementorTurn()] },
      ],
      verifier: [{ turns: [verifierPassTurn()] }],
    });
    const start = await executeCommand(
      w.service,
      w.db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      w.deps,
    );
    expect(start.exitCode).toBe(0);
    const runId = start.json['runId'] as RunId;
    await approveDraft(w, runId, start.json['spec'] as { specVersionId: string; specHash: string });
    w.snapshotTarget.runId = runId;

    const run = await executeCommand(w.service, w.db, RUN_CMD(runId), {}, w.deps);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ command: 'run', ok: true, outcome: 'merge_ready' });
    expect(w.service.status(runId).phase).toBe('merge_ready');
    assertMatrixFacts(w, runId);
    // The paused round was the implementor's and its re-entry completed it.
    expect(w.service.getRoleRound(runId)).toMatchObject({ role: 'verifier', stage: 'completed' });
  });
});

// ---------------------------------------------------------------------------
// Flavor 2 — COORDINATOR round pause during `start`
// ---------------------------------------------------------------------------
describe('test-24 matrix — coordinator round (during start)', () => {
  it('start waits: unknown-ETA pause → T10 → T9 → re-entry drafts the spec; approve + run completes to merge_ready', async () => {
    const w = await setup({
      coordinator: [
        { turns: [LIMIT_TURN] }, // start round 1: limit mid-turn, no ETA
        { turns: [LIMIT_TURN] }, // probe 1: still limited (T10)
        { turns: [{}] }, // probe 2: healthy (T9)
        { turns: [coordinatorTurn(validSpec())] }, // re-entry: the draft
      ],
      implementor: [
        { writes: [{ relPath: 'src/f.ts', content: 'export const f = 1;\n' }], turns: [implementorTurn()] },
      ],
      verifier: [{ turns: [verifierPassTurn()] }],
    });
    // The runId is deterministic (run_000001): snapshot from the first sleep.
    w.snapshotTarget.runId = RUN1;

    const start = await executeCommand(
      w.service,
      w.db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      w.deps,
    );
    expect(start.exitCode).toBe(0);
    expect(start.json).toMatchObject({ command: 'start', ok: true, outcome: 'resumed', reentry: 'coordinator' });
    const runId = start.json['runId'] as RunId;
    expect(runId).toBe(RUN1);
    expect(w.service.status(runId).phase).toBe('awaiting_approval');
    assertMatrixFacts(w, runId);

    // The e2e completes to merge_ready under the re-entered round's draft.
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };
    expect(w.service.getSpecDraft(runId)?.specHash).toBe(spec.specHash);
    await approveDraft(w, runId, spec);
    const run = await executeCommand(w.service, w.db, RUN_CMD(runId), {}, w.deps);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ command: 'run', ok: true, outcome: 'merge_ready' });
    expect(w.service.status(runId).phase).toBe('merge_ready');
  });
});

// ---------------------------------------------------------------------------
// Flavor 3 — REVISION-COORDINATOR round pause during `spec revise`
// ---------------------------------------------------------------------------
describe('test-24 matrix — revision-coordinator round (during spec revise)', () => {
  it('revise waits: unknown-ETA pause → T10 → T9 → re-entry lands the superseding draft; approve v2 + run completes to merge_ready', async () => {
    const revisedSpec = {
      ...validSpec(),
      constraints: ['Touch only files under src/cli', 'No new dependencies'],
    };
    const w = await setup({
      coordinator: [
        { turns: [coordinatorTurn(validSpec())] }, // start: draft v1 (no pause)
        { turns: [LIMIT_TURN] }, // revise re-run: limit mid-turn, no ETA
        { turns: [LIMIT_TURN] }, // probe 1: still limited (T10)
        { turns: [{}] }, // probe 2: healthy (T9)
        { turns: [coordinatorTurn(revisedSpec)] }, // re-entry: revision 2
      ],
      implementor: [
        { writes: [{ relPath: 'src/f.ts', content: 'export const f = 1;\n' }], turns: [implementorTurn()] },
      ],
      verifier: [{ turns: [verifierPassTurn()] }],
    });
    const start = await executeCommand(
      w.service,
      w.db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      w.deps,
    );
    expect(start.exitCode).toBe(0);
    const runId = start.json['runId'] as RunId;
    const spec1 = start.json['spec'] as { specVersionId: string; specHash: string };
    w.snapshotTarget.runId = runId;

    const revise = await executeCommand(
      w.service,
      w.db,
      { kind: 'spec_revise', json: true, runId, feedback: 'Add a no-new-dependencies constraint.' },
      {},
      w.deps,
    );
    expect(revise.exitCode).toBe(0);
    expect(revise.json).toMatchObject({ command: 'spec_revise', ok: true, outcome: 'resumed', reentry: 'coordinator' });
    expect(w.service.status(runId).phase).toBe('awaiting_approval');
    assertMatrixFacts(w, runId);

    // The re-entered round produced the SUPERSEDING revision (W1-F7 lineage).
    const spec2 = revise.json['spec'] as {
      specVersionId: string;
      specHash: string;
      revision: number;
      supersedes?: string;
    };
    expect(spec2.revision).toBe(2);
    expect(spec2.specHash).not.toBe(spec1.specHash);
    expect(spec2.supersedes).toBe(spec1.specVersionId);
    expect(w.service.getSpecDraft(runId)?.specHash).toBe(spec2.specHash);

    // The e2e completes to merge_ready under the REVISED, re-approved spec.
    await approveDraft(w, runId, spec2);
    const run = await executeCommand(w.service, w.db, RUN_CMD(runId), {}, w.deps);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ command: 'run', ok: true, outcome: 'merge_ready' });
    expect(w.service.status(runId).phase).toBe('merge_ready');
  });
});
