/**
 * W4-4 consumer resume-routing gate + W4-1 breaker wiring (PLAN §5o Stage 2).
 *
 * Offline unit tests against the in-process fake adapter (no real spawns):
 *
 *  - CONSUMER GATE (commands.ts handleResume): an UNSUSPENDED implementor/
 *    verifier run stranded at a role-completion boundary (the orchestrator
 *    crashed after `child.stopped` folded but before the next dispatch/verdict
 *    landed) is re-driven by `harness resume` — variant 2 (implementor done,
 *    phase `implementing`) and the symmetric verifier gap (verifier round done,
 *    phase `verifying`). WITHOUT the gate `resume` errored "not paused". The
 *    branch is §14 owner-liveness-gated: a still-alive peer's run is NOT
 *    double-driven. Variant 1 (reap produces `interrupted` WITHIN the same
 *    resume call) falls through to the existing T12 re-entry.
 *  - BREAKER WIRING (service.ts #interruptOnChildDeath): a child crash-loop
 *    trips `breaker_open` (T14) through the runtime path instead of looping on
 *    plain interrupts (T13); `breaker reset` (T15) clears the in-memory window
 *    so the next crash interrupts again rather than re-opening immediately.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  assignmentId,
  gitSha,
  idempotencyKey,
  processGenerationId,
  segmentId,
  specHash,
  specVersionId,
  type RunId,
} from '../domain/ids.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import type { EngineState } from '../domain/transitions.js';
import {
  AdapterError,
  InProcessFakeAdapter,
  rateLimitErrorEnvelope,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../adapters/index.js';
import type { ProcessIdentitySample, PsClient } from '../supervisor/index.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { parseEngineConfig } from '../config/loader.js';
import { LimitPausedError, OrchestrationService, type RoleAdapterFactory } from './service.js';
import type { RoleRunner } from './role-runner.js';
import type { Harness, RoleModelSpec } from './model-resolution.js';
import { ENGINE_STATE_PROJECTION } from './projections.js';
import { DurableRunOwnershipStore } from './run-ownership-store.js';
import { executeCommand } from '../cli/commands.js';
import type { RoleName } from '../domain/state.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const CLAUDE_LOW: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const SPEC = specHash('spec_stage2');

function configOptions(harness: Harness): ConfigOptionDescriptor[] {
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

interface FactoryOpts {
  /** Per-role scripted turns; each role's queue is consumed across dispatches. */
  readonly turnsByRole?: Partial<Record<string, readonly InProcessTurnScript[]>>;
  /** Throw from the pin window (setConfigOption) — a spawn-window CRASH that
   * keeps the phase at its pre-dispatch value so the round can be re-dispatched. */
  readonly onSetConfigOption?: (input: SetConfigOptionInput) => SetConfigOptionResult;
}

function makeFactory(opts: FactoryOpts = {}): RoleAdapterFactory {
  const cursors: Record<string, number> = {};
  return {
    create(options) {
      const role = options.role;
      const idx = cursors[role] ?? 0;
      cursors[role] = idx + 1;
      const turns = opts.turnsByRole?.[role] ?? [{}];
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: configOptions(options.resolved.harness) },
        turns,
        ...(opts.onSetConfigOption !== undefined ? { onSetConfigOption: opts.onSetConfigOption } : {}),
      });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
}

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

async function setup(opts?: {
  readonly factory?: FactoryOpts;
  readonly config?: Record<string, unknown>;
  readonly supervision?: { readonly ps: PsClient; readonly selfPid: number };
}): Promise<{ service: OrchestrationService; db: TestDatabaseHandle['db'] }> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const db = handle.db;
  const parsed = opts?.config !== undefined ? parseEngineConfig(opts.config) : undefined;
  if (parsed !== undefined && !parsed.ok) throw new Error(`bad test config: ${JSON.stringify(parsed.error)}`);
  const service = new OrchestrationService({
    db,
    ids: new DeterministicIdFactory(),
    adapterFactory: makeFactory(opts?.factory ?? {}),
    ...(parsed?.ok === true ? { config: parsed.value } : {}),
    ...(opts?.supervision !== undefined
      ? {
          supervision: {
            ps: opts.supervision.ps,
            selfPid: opts.supervision.selfPid,
            envNonce: { verifyNonce: () => 'match' },
            sendSignal: () => undefined, // synthetic pids: never touch a real process
          },
        }
      : {}),
  });
  return { service, db };
}

function engineState(db: TestDatabaseHandle['db'], runId: RunId): EngineState {
  const record = db.projections.get<EngineState>(runId, ENGINE_STATE_PROJECTION);
  if (record === undefined) throw new Error('engine projection missing');
  return record.state;
}

function eventTypes(db: TestDatabaseHandle['db'], runId: RunId): string[] {
  return db.events.listByRun(runId).map((e) => e.type);
}

/** A role runner that drives exactly one prompt turn and completes cleanly. */
function roleRunnerOnce(role: RoleName): RoleRunner {
  return {
    role,
    run: async (session) => {
      await session.prompt({ prompt: 'go' });
      return {};
    },
  };
}

/** Drive a run to `approved` (T1) with `SPEC` bound. */
function approvedRun(service: OrchestrationService): RunId {
  const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  expect(service.approve(runId, { specVersionId: specVersionId('sv_stage2'), specHash: SPEC }).status).toBe('applied');
  return runId;
}

// ---------------------------------------------------------------------------
// A minimal fake `ps` — used ONLY by the variant-1 reap composition test.
// ---------------------------------------------------------------------------
interface FakePs {
  readonly client: PsClient;
  readonly identities: Map<number, ProcessIdentitySample>;
}
function makeFakePs(): FakePs {
  const identities = new Map<number, ProcessIdentitySample>();
  return {
    identities,
    client: {
      sampleProcessTree: () => undefined,
      sampleIdentity: (pid: number) => identities.get(pid),
      isAlive: (pid: number) => identities.has(pid),
    },
  };
}
function sampleFor(pid: number): ProcessIdentitySample {
  return { pid, ppid: 1, pgid: pid, startedAt: `lstart-${pid}`, executablePath: '/fake/agent' };
}

// ===========================================================================
// W4-4 — consumer resume-routing gate (handleResume)
// ===========================================================================
describe('W4-4 consumer resume-routing gate', () => {
  it('variant 2: implementor completed, phase `implementing`, suspension none → resume RE-DRIVES (fails without the gate: resume errored "not paused")', async () => {
    const { service, db } = await setup({ factory: { turnsByRole: { implementor: [{}] } } });
    const runId = approvedRun(service);

    // Drive the implementor round to completion but STOP before dispatching the
    // verifier (the natural variant-2 boundary: the implement→verify loop
    // advances `implementing → verifying` only at the verifier's dispatch).
    await service.runRole(runId, roleRunnerOnce('implementor'), CLAUDE_LOW, '/ws', {
      round: 1,
      advance: { from: 'approved', to: 'implementing' },
      completionAdvance: { from: 'implementing', to: 'verifying' },
      specHash: SPEC,
      assignmentId: assignmentId('asg_stage2'),
    });

    const st = service.status(runId);
    expect(st.suspension).toBe('none');
    expect(st.phase).toBe('implementing');
    expect(service.getRoleRound(runId)).toMatchObject({ role: 'implementor', stage: 'completed' });
    expect(st.activeChild?.status).toBe('stopped');

    // No flow runtime injected → driveReentry short-circuits to `unavailable`,
    // which is proof the gate ROUTED to re-entry (exit 0) rather than the
    // pre-gate "not paused" error (exit 1).
    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {}, {});
    expect(out.exitCode).toBe(0);
    expect(out.json.outcome).toBe('resumed');
    expect(out.json.reentry).toBe('unavailable');
  });

  it('symmetric gap: verifier round completed, phase `verifying`, suspension none → resume RE-DRIVES', async () => {
    const { service, db } = await setup({ factory: { turnsByRole: { verifier: [{}] } } });
    const runId = approvedRun(service);
    service.advanceWorkflowPhase(runId, 'approved', 'implementing');

    await service.runRole(runId, roleRunnerOnce('verifier'), CLAUDE_LOW, '/ws', {
      round: 1,
      advance: { from: 'implementing', to: 'verifying' },
      specHash: SPEC,
      implementationCommit: gitSha('impl_commit_stage2'),
      assignmentId: assignmentId('asg_stage2'),
    });

    const st = service.status(runId);
    expect(st.suspension).toBe('none');
    expect(st.phase).toBe('verifying');
    expect(service.getRoleRound(runId)).toMatchObject({ role: 'verifier', stage: 'completed' });

    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {}, {});
    expect(out.exitCode).toBe(0);
    expect(out.json.outcome).toBe('resumed');
    expect(out.json.reentry).toBe('unavailable');
  });

  it('owner-liveness: a run claimed by a still-alive process is NOT re-driven — the gate WITHHOLDS (falls through to the "not paused" error)', async () => {
    const { service, db } = await setup({ factory: { turnsByRole: { implementor: [{}] } } });
    const runId = approvedRun(service);
    await service.runRole(runId, roleRunnerOnce('implementor'), CLAUDE_LOW, '/ws', {
      round: 1,
      advance: { from: 'approved', to: 'implementing' },
      completionAdvance: { from: 'implementing', to: 'verifying' },
      specHash: SPEC,
      assignmentId: assignmentId('asg_stage2'),
    });

    // A durable RUN-ownership lease attributing this run to a LIVE owner (self —
    // `ownerPid === #selfPid`, which defaults to this process). This is the
    // between-rounds owner/control channel: even after the child record has been
    // disposed, the lease is held for the whole time the owner drives the run, so
    // the gate consults `isRunClaimedByLiveProcess` and the boundary branch must
    // WITHHOLD.
    service.acquireRunOwnership(runId);
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(true);

    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {}, {});
    expect(out.exitCode).toBe(1);
    expect(out.json.reentry).toBeUndefined(); // NOT routed to re-entry
  });

  // ADVERSARIAL REGRESSION (verifier-added): window 1 — an ACTIVE IMPLEMENTOR
  // generation whose owning orchestrator crashed must be marked interrupted by
  // T17 `recovery.running_segment_found`, NOT T13 `child.exited.unexpectedly`.
  // The load-bearing assertion is that the restart counters stay at ZERO: T13
  // folds `restartsInWindow +1`/`lifetimeRestarts +1` (polluting the child-crash
  // breaker + P4b respawn budget with an orchestrator restart), while T17 folds
  // no counters. If the reap producer is reverted to emit T13, the counters go
  // to 1 and `child.exited.unexpectedly` appears → these assertions FAIL.
  it('window 1 (active implementor gen, dead owner): reap uses T17 NOT T13 — interrupted, restart counters UNTOUCHED, then resume re-drives', async () => {
    const ps = makeFakePs();
    const DEAD_OWNER = 58_100; // absent from the fake ps table → provably dead
    const SELF = 58_200;
    ps.identities.set(SELF, sampleFor(SELF));
    const { service, db } = await setup({ supervision: { ps: ps.client, selfPid: SELF } });
    const runId = approvedRun(service);
    service.advanceWorkflowPhase(runId, 'approved', 'implementing'); // non-terminal home

    // Seed an ACTIVE implementor generation whose owner (DEAD_OWNER) crashed
    // mid-round — the child process is still alive, so the reap must reconcile
    // it. No RoleRoundProjection is persisted (round !== 'completed'), so the
    // stage-aware reap routes to T17, not the completed-stage confirm-stop.
    const generation = processGenerationId('pgen_w1_impl');
    const segment = segmentId('seg_w1_impl');
    const now = db.clock.nowIso();
    service.ingest(
      draftEvent({
        type: 'child.spawn.initiated',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'implementor' },
        idempotencyKey: idempotencyKey('w1-init'),
        occurredAt: now,
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'implementor', pins: [] },
        idempotencyKey: idempotencyKey('w1-spawned'),
        occurredAt: now,
      }) as DomainEvent,
    );
    const childPid = 58_300;
    ps.identities.set(childPid, sampleFor(childPid)); // live child → reap kills it
    service.supervision.registry.store.put({
      generationId: generation,
      pid: childPid,
      pgid: childPid,
      startedAt: `lstart-${childPid}`,
      executablePath: '/fake/agent',
      spawnNonce: `nonce-${childPid}`,
      recordedAt: now,
      runId,
      segmentId: segment,
      ownerPid: DEAD_OWNER,
    });
    expect(engineState(db, runId).counters.lifetimeRestarts).toBe(0);

    service.reapOrphanProcesses();

    // T17 producer fired (interrupted), NOT the child-crash T13 path.
    const types = eventTypes(db, runId);
    expect(types).toContain('recovery.running_segment_found'); // T17 trigger
    expect(types).not.toContain('child.exited.unexpectedly'); // NOT T13
    const afterReap = engineState(db, runId);
    expect(afterReap.suspension.kind).toBe('interrupted');
    // Load-bearing: an orchestrator restart must not pollute the child-crash
    // restart counters (T13 would have bumped BOTH to 1).
    expect(afterReap.counters.lifetimeRestarts).toBe(0);
    expect(afterReap.counters.restartsInWindow).toBe(0);
    expect(afterReap.phase).toBe('implementing'); // phase_unchanged (T17 invariant)

    // Manual resume re-drives via T12 (interrupted → re-entry).
    service.resume(runId);
    expect(eventTypes(db, runId)).toContain('resume.user.requested');
    expect(engineState(db, runId).suspension.kind).toBe('none');
  });

  it('variant 1: reap PRODUCES `interrupted` (T17) within the same resume call, then T12 drives re-entry', async () => {
    const ps = makeFakePs();
    const DEAD_OWNER = 59_999; // absent from the fake ps table → provably dead
    const SELF = 60_000;
    ps.identities.set(SELF, sampleFor(SELF));
    const { service, db } = await setup({ supervision: { ps: ps.client, selfPid: SELF } });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // Seed an ACTIVE generation whose owning orchestrator (DEAD_OWNER) crashed.
    const generation = processGenerationId('pgen_variant1');
    const segment = segmentId('seg_variant1');
    const now = db.clock.nowIso();
    service.ingest(
      draftEvent({
        type: 'child.spawn.initiated',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'coordinator' },
        idempotencyKey: idempotencyKey('v1-init'),
        occurredAt: now,
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'coordinator', pins: [] },
        idempotencyKey: idempotencyKey('v1-spawned'),
        occurredAt: now,
      }) as DomainEvent,
    );
    const childPid = 62_500;
    ps.identities.set(childPid, sampleFor(childPid)); // child still alive → reap kills it
    service.supervision.registry.store.put({
      generationId: generation,
      pid: childPid,
      pgid: childPid,
      startedAt: `lstart-${childPid}`,
      executablePath: '/fake/agent',
      spawnNonce: `nonce-${childPid}`,
      recordedAt: now,
      runId,
      segmentId: segment,
      ownerPid: DEAD_OWNER,
    });
    expect(engineState(db, runId).suspension.kind).toBe('none');

    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {}, {});

    // The reap (first thing handleResume does) produced T17 `interrupted`, then
    // the same call's `service.resume()` lifted it via T12 and drove re-entry.
    expect(eventTypes(db, runId)).toContain('recovery.initiated'); // T17 (reap)
    expect(eventTypes(db, runId)).toContain('resume.user.requested'); // T12
    expect(engineState(db, runId).suspension.kind).toBe('none');
    expect(out.exitCode).toBe(0);
    expect(out.json.outcome).toBe('resumed');
  });
});

// ===========================================================================
// W4-4 — durable RUN-ownership lease (the between-rounds owner/control channel)
//
// The residual the lease closes: `isRunClaimedByLiveProcess` used to read the
// per-CHILD registry, but a clean child dispose REMOVES the child record. So in
// the gap between an implementor's clean stop and the verifier's dispatch — a
// stretch of real worktree/git I/O — a LIVE owner holds NO child record, and a
// concurrent `resume` could not tell "owner crashed" from "owner alive between
// rounds" → it double-drove the worktree. The RUN-level lease is held ACROSS
// rounds, so it survives that gap.
//
// Every test here drives a REAL implementor round to the completion boundary
// (phase `implementing`, round implementor/completed, child stopped) and then
// disposes leaves NO child record for the run — so the gate can rely ONLY on
// the run-ownership lease. Synthetic pids + no-op sendSignal throughout.
// ===========================================================================
describe('W4-4 run-ownership lease closes the between-rounds double-drive gap', () => {
  /** Drive a fresh implementor round to the clean completion boundary. */
  async function driveToImplementorBoundary(
    service: OrchestrationService,
  ): Promise<RunId> {
    const runId = approvedRun(service);
    await service.runRole(runId, roleRunnerOnce('implementor'), CLAUDE_LOW, '/ws', {
      round: 1,
      advance: { from: 'approved', to: 'implementing' },
      completionAdvance: { from: 'implementing', to: 'verifying' },
      specHash: SPEC,
      assignmentId: assignmentId('asg_stage2'),
    });
    const st = service.status(runId);
    expect(st.phase).toBe('implementing');
    expect(service.getRoleRound(runId)).toMatchObject({ role: 'implementor', stage: 'completed' });
    // The in-process fake adapter registers no §14 identity, and a clean dispose
    // removes any child record — so there is NO per-child record for this run.
    expect(service.supervision.registry.store.list().filter((r) => r.runId === runId)).toHaveLength(0);
    return runId;
  }

  it('between-rounds race: a LIVE PEER holds the run lease with NO child record → the impl/verifier gate WITHHOLDS (fails without the lease: the registry-only check returned false → double-drive)', async () => {
    const ps = makeFakePs();
    const SELF = 71_000;
    const PEER = 71_500;
    ps.identities.set(SELF, sampleFor(SELF));
    ps.identities.set(PEER, sampleFor(PEER)); // a genuinely-alive peer orchestrator
    const { service, db } = await setup({
      factory: { turnsByRole: { implementor: [{}] } },
      supervision: { ps: ps.client, selfPid: SELF },
    });
    const runId = await driveToImplementorBoundary(service);

    // A LIVE PEER (not self) holds the run-ownership lease for the whole time it
    // drives the run — the between-rounds owner/control channel.
    new DurableRunOwnershipStore(db).acquire(
      {
        runId,
        ownerPid: PEER,
        ownerStartedAt: `lstart-${PEER}`,
        acquiredAt: db.clock.nowIso(),
      },
      () => false, // seed into an empty store — land the lease unconditionally
    );
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(true);

    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {}, {});
    expect(out.exitCode).toBe(1); // WITHHELD → falls through to the "not paused" error
    expect(out.json.reentry).toBeUndefined(); // NOT routed to re-entry
  });

  it('crash-recovery: the run lease exists but its owner pid is DEAD → resume PROCEEDS (re-drives) — the intended reclaim', async () => {
    const ps = makeFakePs();
    const SELF = 72_000;
    const DEAD_OWNER = 72_500; // absent from the fake ps table → provably dead
    ps.identities.set(SELF, sampleFor(SELF));
    const { service, db } = await setup({
      factory: { turnsByRole: { implementor: [{}] } },
      supervision: { ps: ps.client, selfPid: SELF },
    });
    const runId = await driveToImplementorBoundary(service);

    new DurableRunOwnershipStore(db).acquire(
      {
        runId,
        ownerPid: DEAD_OWNER,
        ownerStartedAt: `lstart-${DEAD_OWNER}`,
        acquiredAt: db.clock.nowIso(),
      },
      () => false, // seed into an empty store — land the lease unconditionally
    );
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(false); // dead owner → reclaimable

    // No flow runtime injected → driveReentry short-circuits to `unavailable`,
    // proving the gate ROUTED to re-entry (exit 0) rather than withholding.
    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {}, {});
    expect(out.exitCode).toBe(0);
    expect(out.json.outcome).toBe('resumed');
    expect(out.json.reentry).toBe('unavailable');
  });

  it('stale/recycled owner pid: an alive pid whose START-TIME mismatches (recycled) is treated as a dead owner → resume PROCEEDS and the lease is reclaimable', async () => {
    const ps = makeFakePs();
    const SELF = 73_000;
    const RECYCLED = 73_500;
    ps.identities.set(SELF, sampleFor(SELF));
    ps.identities.set(RECYCLED, sampleFor(RECYCLED)); // pid alive NOW as an UNRELATED process
    const { service, db } = await setup({
      factory: { turnsByRole: { implementor: [{}] } },
      supervision: { ps: ps.client, selfPid: SELF },
    });
    const runId = await driveToImplementorBoundary(service);

    // The lease was written by a since-crashed owner; the pid was recycled by an
    // unrelated process (start-time differs), so it is NOT the original owner.
    new DurableRunOwnershipStore(db).acquire(
      {
        runId,
        ownerPid: RECYCLED,
        ownerStartedAt: 'lstart-ORIGINAL-crashed-owner', // ≠ current sampleFor(RECYCLED).startedAt
        acquiredAt: db.clock.nowIso(),
      },
      () => false, // seed into an empty store — land the lease unconditionally
    );
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(false); // recycled ≠ alive owner

    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {}, {});
    expect(out.exitCode).toBe(0);
    expect(out.json.reentry).toBe('unavailable'); // proceeded

    // Reclaimable: this process can now take the lease over the stale record.
    service.acquireRunOwnership(runId);
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(true); // now owned by self (live)
  });

  it('release: after the driver releases the lease, a legitimate SEQUENTIAL resume is not blocked', async () => {
    const { service, db } = await setup({ factory: { turnsByRole: { implementor: [{}] } } });
    const runId = await driveToImplementorBoundary(service);

    // Simulate the driver acquiring then releasing in its outer `finally`.
    service.acquireRunOwnership(runId);
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(true);
    service.releaseRunOwnership(runId);
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(false);

    // A later, sequential resume (no live owner now) proceeds.
    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {}, {});
    expect(out.exitCode).toBe(0);
    expect(out.json.reentry).toBe('unavailable');
  });
});

// ===========================================================================
// W4-2 STAGE 1 / review-6 F2 — run ownership is EXCLUSIVE on the OTHER two
// carve-outs the earlier stage never covered:
//   (S4) a LIVE coordinator round now HOLDS the lease → `isRunClaimedByLiveProcess`
//        is TRUE during it (was a production NO-OP), so a concurrent resume
//        WITHHOLDS instead of double-driving the coordinator round;
//   (F2) the unacknowledged pending-re-entry carve-out (commands.ts) is now
//        owner-liveness gated like every other resume path.
// ===========================================================================
interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('W4-2 S4 — a live coordinator round holds the exclusive run-ownership lease', () => {
  it('mid-coordinator-round the lease is HELD (isRunClaimedByLiveProcess TRUE) → a concurrent resume WITHHOLDS; released after (fails without the fix: runCoordination acquired NOTHING → the gate was a no-op → the resume double-drove the round)', async () => {
    const { service, db } = await setup({ factory: { turnsByRole: { coordinator: [{}] } } });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // Before the coordinator round runs, nobody owns the run.
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(false);

    const reached = deferred<void>();
    const release = deferred<void>();
    let claimedMidRound: boolean | undefined;
    let concurrentReentry: unknown;
    const gatedCoordinator: RoleRunner = {
      role: 'coordinator',
      run: async (session) => {
        await session.prompt({ prompt: 'draft the spec' });
        // Mid-round: the run is being actively driven. The lease MUST be held.
        claimedMidRound = service.isRunClaimedByLiveProcess(runId);
        reached.resolve();
        await release.promise;
        return {};
      },
    };

    const driving = service.runCoordination(runId, gatedCoordinator);
    await reached.promise;

    // (1) The lease is held for the WHOLE live coordinator round.
    expect(claimedMidRound).toBe(true);
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(true);
    expect(service.status(runId).phase).toBe('specifying'); // dispatched, mid-round

    // (2) A concurrent `harness resume` in this window hits the W3-4 coordinator
    // carve-out — now GATED on the lease, so it WITHHOLDS (no flow re-drive).
    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {}, {});
    concurrentReentry = out.json.reentry;
    expect(concurrentReentry).toBeUndefined(); // NOT re-driven (withheld)

    // Let the round finish; the lease is released in runCoordination's `finally`.
    release.resolve();
    await driving;
    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(false); // released
  });
});

describe('W4-2 F2 — the pending-re-entry carve-out is owner-liveness gated', () => {
  it('a LIVE owner holds the run lease → the unacknowledged pending re-entry WITHHOLDS (fails without the gate: the ungated carve-out re-drove the round)', async () => {
    const { service, db } = await setup({
      factory: { turnsByRole: { implementor: [{ errorEnvelope: rateLimitErrorEnvelope() }] } },
    });
    const runId = approvedRun(service);

    // Drive an implementor round that pauses on a provider limit (T4), then take
    // the T9 resume so an UNACKNOWLEDGED pending re-entry is recorded
    // (suspension none, resumeReentryPending set) — the crash-window the
    // pending-re-entry carve-out exists to reclaim.
    const paused: unknown = await service
      .runRole(runId, roleRunnerOnce('implementor'), CLAUDE_LOW, '/ws', {
        round: 1,
        advance: { from: 'approved', to: 'implementing' },
        completionAdvance: { from: 'implementing', to: 'verifying' },
        specHash: SPEC,
        assignmentId: assignmentId('asg_stage2'),
      })
      .catch((e: unknown) => e);
    expect(paused).toBeInstanceOf(LimitPausedError);
    expect(service.resume(runId).status).toBe('applied');
    const st = service.status(runId);
    expect(st.suspension).toBe('none');
    expect(st.resumeReentryPending).toBeDefined();

    // A LIVE owner (self) holds the run lease — a concurrent resume in another
    // process must NOT double-drive the pending re-entry.
    service.acquireRunOwnership(runId);
    expect(service.isRunClaimedByLiveProcess(runId)).toBe(true);

    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {}, {});
    expect(out.json.reentry).toBeUndefined(); // WITHHELD — the carve-out did not fire
    // The pending re-entry is still UNACKED (never driven), left for the owner.
    expect(service.status(runId).resumeReentryPending).toBeDefined();
  });
});

// ===========================================================================
// W4-1 — breaker wired into the child-crash site (#interruptOnChildDeath)
// ===========================================================================
describe('W4-1 breaker wiring at the child-crash site', () => {
  /** A pin-window crash: setConfigOption throws a `crash`-classified error
   * (`unexpected_eof`) BEFORE the phase advance, so the coordinator round can be
   * re-dispatched from `created` after each resume (a genuine crash loop). */
  const crashOnPin: FactoryOpts['onSetConfigOption'] = () => {
    throw new AdapterError('unexpected_eof', 'injected: child died during pin');
  };

  /** One crash → interrupt (or breaker_open), then lift the interrupt so the
   * next dispatch can spawn again. Returns the suspension AFTER the crash. */
  async function crashOnce(service: OrchestrationService, runId: RunId): Promise<string> {
    await service.runCoordination(runId, roleRunnerOnce('coordinator')).catch(() => undefined);
    const suspension = service.status(runId).suspension;
    if (suspension === 'interrupted') service.resume(runId);
    return suspension;
  }

  it('a child crash-LOOP trips `breaker_open` through the runtime path (fails without the wiring: it would interrupt forever)', async () => {
    // windowMax 3 → the 4th crash inside the window opens the breaker (T14).
    const { service, db } = await setup({
      factory: { onSetConfigOption: crashOnPin },
      config: { restarts: { windowMax: 3 } },
    });
    const runId = approvedRun(service);
    service.advanceWorkflowPhase(runId, 'approved', 'implementing'); // stable non-terminal home

    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) outcomes.push(await crashOnce(service, runId));

    // First three crashes each interrupt (T13); the fourth opens the breaker.
    expect(outcomes.slice(0, 3)).toEqual(['interrupted', 'interrupted', 'interrupted']);
    expect(service.status(runId).suspension).toBe('breaker_open');
    // The exhaustion was driven by T14 (`restart.exhausted`), not another T13.
    expect(eventTypes(db, runId)).toContain('restart.exhausted');
  });

  it('`breaker reset` (T15) clears the in-memory window so the next crash interrupts again (fails without breakerReset wiring: it would re-open immediately)', async () => {
    const { service } = await setup({
      factory: { onSetConfigOption: crashOnPin },
      config: { restarts: { windowMax: 3 } },
    });
    const runId = approvedRun(service);
    service.advanceWorkflowPhase(runId, 'approved', 'implementing');

    for (let i = 0; i < 4; i += 1) await crashOnce(service, runId);
    expect(service.status(runId).suspension).toBe('breaker_open');

    expect(service.breakerReset(runId).status).toBe('applied');
    expect(service.status(runId).suspension).toBe('none');

    // The NEXT crash must INTERRUPT (T13), not immediately re-open: proof the
    // in-memory restart window was cleared by the reset (the durable
    // window-counter reset alone would not clear the breaker's own deque).
    const after = await crashOnce(service, runId);
    expect(after).toBe('interrupted');
  });
});
