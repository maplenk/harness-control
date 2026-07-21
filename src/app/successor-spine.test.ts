/**
 * P4b-2 self-drive SUCCESSOR spine (§5cc/§5dd) — the shared, crash-safe
 * successor mechanism: seed a NEW generation from a §12.2 checkpoint, re-assert
 * a target pin, and resume, driven IN-PROCESS by the lease-holding owner. The
 * durable INTENT marker (a `resumeReentryPending` sibling on `EngineState`)
 * rides ONE `#atomicEngineWrite` fused with the T9/T12 suspension-clear, is
 * committed BEFORE any OS spawn, and is ACKED/cleared by the SAME
 * `child.spawned → resume_reentry.completed` path.
 *
 * Adversarial crash-window proof (real-path injection through the shipped
 * `recordSuccessorIntent` / `runRole`, a fresh service over the same store
 * playing the restarted process — the `pause-crash-injection.test.ts` idiom):
 *   A = crash BEFORE the marker commits → no marker, run at its prior durable
 *       state (`paused_limit`), the decision re-runs on restart, NO orphan;
 *   B = crash AFTER the marker but DURING the OS spawn, BEFORE `child.spawned`
 *       → the un-acked marker + a stopped/reaped orphan re-drive EXACTLY ONE
 *       surviving successor (no duplicate spawn, no leaked orphan);
 *   C = successor crashes AFTER `child.spawned` → the ordinary T13 path.
 * Plus: `child.spawned` acks the marker; the marker + fold ride one txn; and
 * the T5 `segment.successor.required` gap now has the spine as its consumer.
 *
 * Runs on BOTH sqlite drivers (crash-safety is driver-sensitive).
 */
import { CLEAN_PINNED_WORKSPACE_GIT, createRunFixture } from './test-support.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { runId as toRunId, type RunId } from '../domain/ids.js';
import type { DomainEvent } from '../domain/events.js';
import {
  InProcessFakeAdapter,
  limitOnTurnN,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
} from '../adapters/index.js';
import { DeterministicIdFactory, RandomIdFactory } from '../lib/id-factory.js';
import {
  openTestDatabase,
  availableDriverKinds,
  type TestDatabaseHandle,
} from '../persistence/test-support.js';
import { OrchestrationService, type RoleAdapterFactory } from './service.js';
import type { RoleRunner } from './role-runner.js';
import type { Harness, RoleModelSpec } from './model-resolution.js';

const DRIVER_KINDS = await availableDriverKinds();

const T0 = '2026-07-20T00:00:00.000Z';
const CLAUDE_LOW: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const RUN1 = toRunId('run_000001');

// ---------------------------------------------------------------------------
// Harness (pause-crash-injection conventions)
// ---------------------------------------------------------------------------
function fakeConfigOptions(harness: Harness): ConfigOptionDescriptor[] {
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

/** Factory whose Nth created adapter takes the Nth turn script (last reused). */
function makeQueueFactory(scripts: readonly (readonly InProcessTurnScript[])[]): {
  factory: RoleAdapterFactory;
  createdCount: () => number;
} {
  let created = 0;
  const factory: RoleAdapterFactory = {
    create(options) {
      const turns = scripts[Math.min(created, scripts.length - 1)] ?? [];
      created += 1;
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        clock: options.clock,
        capabilities: { configOptions: fakeConfigOptions(options.resolved.harness) },
        turns,
      });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory, createdCount: () => created };
}

const handles: TestDatabaseHandle[] = [];
afterEach(() => {
  for (const h of handles) {
    h.close();
    h.cleanup();
  }
  handles.length = 0;
});

async function setup(
  kind: (typeof DRIVER_KINDS)[number],
  scripts: readonly (readonly InProcessTurnScript[])[],
): Promise<{
  service: OrchestrationService;
  db: TestDatabaseHandle['db'];
  clock: ManualClock;
  createdCount: () => number;
}> {
  const clock = new ManualClock(T0);
  const handle = await openTestDatabase({ kind, file: false, clock });
  handles.push(handle);
  const { factory, createdCount } = makeQueueFactory(scripts);
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
  });
  return { service, db: handle.db, clock, createdCount };
}

/** A restarted-process stand-in over the SAME store (fresh service, fresh ids). */
function successorService(
  db: TestDatabaseHandle['db'],
  scripts?: readonly (readonly InProcessTurnScript[])[],
): OrchestrationService {
  const factory: RoleAdapterFactory =
    scripts !== undefined
      ? makeQueueFactory(scripts).factory
      : {
          create: () => {
            throw new Error('this recovery path must not spawn adapters');
          },
        };
  return new OrchestrationService({
    db,
    ids: new RandomIdFactory(),
    adapterFactory: factory,
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
  });
}

function promptOnceRunner(): RoleRunner {
  return {
    role: 'coordinator',
    run: async (session) => {
      await session.prompt({ prompt: 'go' });
      return {};
    },
  };
}

function eventTypes(db: TestDatabaseHandle['db'], id: RunId): string[] {
  return db.events.listByRun(id).map((e) => e.type);
}

function countType(db: TestDatabaseHandle['db'], id: RunId, type: string): number {
  return eventTypes(db, id).filter((t) => t === type).length;
}

/** Inject a "process death" into the durable write path: the append carrying
 * `type` throws. Returns a restore function. */
function crashOnAppendOf(db: TestDatabaseHandle['db'], type: string): { restore: () => void } {
  const events = db.events as { appendBatch: typeof db.events.appendBatch };
  const original = db.events.appendBatch.bind(db.events);
  events.appendBatch = (drafts: readonly DomainEvent[]) => {
    if (drafts.some((d) => d.type === type)) {
      throw new Error(`injected crash: process died appending ${type}`);
    }
    return original(drafts);
  };
  return {
    restore: () => {
      events.appendBatch = original;
    },
  };
}

/** Drive a fresh coordinator round to a `paused_limit` state with a §12.2
 * pre-pause checkpoint recorded — the spine's seed. */
async function pauseOnLimit(service: OrchestrationService): Promise<RunId> {
  const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
  await service.runCoordination(runId, promptOnceRunner()).catch(() => undefined);
  expect(service.status(runId).suspension).toBe('paused_limit');
  return runId;
}

/** The last `child.spawned` event's model pin (§11.2 re-assertion evidence). */
function lastSpawnedModelPin(db: TestDatabaseHandle['db'], id: RunId): string | undefined {
  const spawns = db.events.listByRun(id).filter((e) => e.type === 'child.spawned');
  const last = spawns[spawns.length - 1];
  const pins = (last?.payload as { pins?: readonly { purpose: string; value: string }[] }).pins ?? [];
  return pins.find((p) => p.purpose === 'model')?.value;
}

describe.each(DRIVER_KINDS)('P4b-2 successor spine (%s)', (kind) => {
  // -------------------------------------------------------------------------
  // Happy path — EXACTLY ONE successor from a checkpoint; pin re-asserted; run
  // continues; child.spawned acks the marker.
  // -------------------------------------------------------------------------
  it('records the INTENT marker from a checkpoint (target + seed), spawns EXACTLY ONE successor that re-asserts the pin, and the child.spawned ack clears the marker', async () => {
    const { service, db } = await setup(kind, [limitOnTurnN(1), [{}]]);
    const runId = await pauseOnLimit(service);
    expect(RUN1).toEqual(runId); // deterministic id sanity

    // STEP 1 — the durable INTENT marker, BEFORE any spawn.
    const marked = service.recordSuccessorIntent(runId);
    expect(marked.status).toBe('applied');
    const afterMark = service.status(runId);
    expect(afterMark.suspension).toBe('none'); // suspension-clear rode the SAME write
    expect(afterMark.resumeReentryPending).toBeDefined();
    // The marker carries the target (wave 1: the crashed round's OWN spec) and
    // the derived §12.2 seed checkpoint hash.
    expect(afterMark.successorIntent).toMatchObject({
      target: { harness: 'claude', model: 'opus', effort: 'low' },
      reason: 'recovery',
      reassertModel: true,
    });
    expect(afterMark.successorIntent?.seedCheckpointHash).toBeDefined();
    // The seed IS the derived resume checkpoint (F3 derive-from-log).
    expect(String(afterMark.successorIntent?.seedCheckpointHash)).toBe(
      String(service.resolveResumeCheckpointHash(runId)),
    );
    const spawnsBefore = countType(db, runId, 'child.spawned');

    // STEP 2 — the POST-COMMIT spawn (the existing re-entry machinery: the
    // coordinator round re-drives via runRole). child.spawned ACKS the marker.
    await service.runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
      round: 1,
      completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
    });
    service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');

    const done = service.status(runId);
    expect(done.phase).toBe('awaiting_approval'); // run continues
    expect(done.suspension).toBe('none');
    expect(done.successorIntent).toBeUndefined(); // acked/cleared by child.spawned
    expect(done.resumeReentryPending).toBeUndefined();
    // EXACTLY ONE successor generation spawned; its pin re-asserts the target.
    expect(countType(db, runId, 'child.spawned')).toBe(spawnsBefore + 1);
    expect(countType(db, runId, 'resume_reentry.completed')).toBe(1);
    expect(lastSpawnedModelPin(db, runId)).toBe('opus');
    // A limit pause + its successor never count as restarts (§13).
    expect(done.counters.restartsInWindow).toBe(0);
    expect(done.counters.lifetimeRestarts).toBe(0);
    // `via: 'successor'` distinguishes the spine's resume from a plain one.
    const resumeInit = db.events.listByRun(runId).find((e) => e.type === 'segment.resume.initiated');
    expect((resumeInit?.payload as { via?: string }).via).toBe('successor');
  });

  // -------------------------------------------------------------------------
  // ONE transaction — the marker + suspension-clear + fold are atomic.
  // -------------------------------------------------------------------------
  it('the marker + the T9 suspension-clear ride ONE transaction — an injected crash on the trigger append leaves NEITHER (regression: a torn marker)', async () => {
    const { service, db } = await setup(kind, [limitOnTurnN(1), [{}]]);
    const runId = await pauseOnLimit(service);

    const crash = crashOnAppendOf(db, 'resume.limit.requested');
    const error: unknown = (() => {
      try {
        service.recordSuccessorIntent(runId);
        return undefined;
      } catch (e: unknown) {
        return e;
      }
    })();
    crash.restore();
    expect(String(error)).toContain('injected crash');

    // Nothing partially committed: still paused, no marker, no re-entry pending,
    // no resume-initiated effect. If the marker did NOT ride the suspension-clear
    // write, one of these would have leaked.
    const st = service.status(runId);
    expect(st.suspension).toBe('paused_limit');
    expect(st.successorIntent).toBeUndefined();
    expect(st.resumeReentryPending).toBeUndefined();
    expect(eventTypes(db, runId)).not.toContain('resume.limit.requested');
    expect(eventTypes(db, runId)).not.toContain('segment.resume.initiated');
  });

  // -------------------------------------------------------------------------
  // Window A — crash BEFORE the marker commits → re-decide, NO orphan.
  // -------------------------------------------------------------------------
  it('window A: crash BEFORE the marker commits → the run is still paused, the decision re-runs on restart, and EXACTLY ONE successor spawns (no orphan)', async () => {
    const { service, db } = await setup(kind, [limitOnTurnN(1), [{}]]);
    const runId = await pauseOnLimit(service);
    const spawnsAtPause = countType(db, runId, 'child.spawned');

    // The owner dies as it records the marker (the trigger append throws).
    const crash = crashOnAppendOf(db, 'resume.limit.requested');
    try {
      service.recordSuccessorIntent(runId);
    } catch {
      /* injected crash */
    }
    crash.restore();
    // No spawn was ever attempted (the marker commits BEFORE the spawn), so no
    // orphan can exist.
    expect(countType(db, runId, 'child.spawn.initiated')).toBe(spawnsAtPause);

    // Restart: recovery rebuilds the paused state; the decision re-runs.
    const restarted = successorService(db, [[{}]]);
    expect(restarted.recover(runId).suspension.kind).toBe('paused_limit');
    expect(restarted.reapOrphanProcesses().entries.length).toBe(0); // nothing to reap

    expect(restarted.recordSuccessorIntent(runId).status).toBe('applied');
    await restarted.runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
      round: 1,
      completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
    });
    restarted.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');

    const st = restarted.status(runId);
    expect(st.phase).toBe('awaiting_approval');
    expect(st.successorIntent).toBeUndefined();
    // EXACTLY ONE successor: no duplicate, no leaked orphan.
    expect(countType(db, runId, 'child.spawned')).toBe(spawnsAtPause + 1);
    expect(countType(db, runId, 'resume.limit.requested')).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Window B — crash AFTER the marker, DURING the spawn, BEFORE child.spawned.
  // -------------------------------------------------------------------------
  it('window B: crash AFTER the marker but BEFORE child.spawned → the un-acked marker + reap re-drive EXACTLY ONE surviving successor (no duplicate spawn, no leaked orphan)', async () => {
    const { service, db } = await setup(kind, [limitOnTurnN(1), [{}]]);
    const runId = await pauseOnLimit(service);

    // STEP 1 commits the marker.
    expect(service.recordSuccessorIntent(runId).status).toBe('applied');
    const spawnsAfterMarker = countType(db, runId, 'child.spawned'); // just gen 1

    // STEP 2: the successor spawn dies appending `child.spawned` — the OS
    // process existed (child.spawn.initiated committed) but never went active.
    const crash = crashOnAppendOf(db, 'child.spawned');
    const spawnError: unknown = await service
      .runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
        round: 1,
        completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
      })
      .then(() => undefined)
      .catch((e: unknown) => e);
    crash.restore();
    expect(String(spawnError)).toContain('injected crash');

    // Durable state: the marker is STILL un-acked; the successor's child.spawned
    // never committed.
    expect(countType(db, runId, 'child.spawned')).toBe(spawnsAfterMarker);
    expect(countType(db, runId, 'resume_reentry.completed')).toBe(0);
    const restarted = successorService(db, [[{}]]);
    const recovered = restarted.recover(runId);
    expect(recovered.successorIntent).toBeDefined();
    expect(recovered.resumeReentryPending).toBeDefined();

    // Restart: reap any orphan (the mid-spawn generation), then the un-acked
    // marker re-drives a fresh successor — EXACTLY ONE survives.
    restarted.reapOrphanProcesses();
    await restarted.runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
      round: 1,
      completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
    });
    restarted.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');

    const st = restarted.status(runId);
    expect(st.phase).toBe('awaiting_approval');
    expect(st.successorIntent).toBeUndefined(); // acked exactly once
    expect(st.resumeReentryPending).toBeUndefined();
    // EXACTLY ONE surviving successor beyond gen 1 (the crashed attempt left no
    // committed child.spawned): total = gen 1 + the survivor.
    expect(countType(db, runId, 'child.spawned')).toBe(spawnsAfterMarker + 1);
    expect(countType(db, runId, 'resume_reentry.completed')).toBe(1);
    // NO duplicate marker consumed, NO fresh incident, NO restart counted.
    expect(countType(db, runId, 'resume.limit.requested')).toBe(1);
    expect(st.counters.lifetimeRestarts).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Window C — the successor itself crashes AFTER child.spawned → ordinary T13.
  // -------------------------------------------------------------------------
  it('window C: the successor crashes AFTER child.spawned → the ordinary T13 interrupt path (marker already acked, generation-matched)', async () => {
    // gen 1 pauses; the successor (gen 2) dies mid-turn (unexpected_eof → T13).
    const { service, db } = await setup(kind, [limitOnTurnN(1), [{ dieMidTurn: true }]]);
    const runId = await pauseOnLimit(service);
    expect(service.recordSuccessorIntent(runId).status).toBe('applied');

    const crashed: unknown = await service
      .runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
        round: 1,
        completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
      })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(crashed).toBeDefined();

    const st = service.status(runId);
    // The successor DID go active (child.spawned committed) → the marker is
    // acked; a later crash is the ordinary generation-matched T13 interrupt.
    expect(st.successorIntent).toBeUndefined();
    expect(countType(db, runId, 'resume_reentry.completed')).toBe(1);
    expect(countType(db, runId, 'child.spawned')).toBe(2);
    expect(st.suspension).toBe('interrupted');
    expect(st.counters.lifetimeRestarts).toBe(1); // T13 folded one restart
  });

  // -------------------------------------------------------------------------
  // T5 gap-close — segment.successor.required now HAS a consumer (the spine).
  // -------------------------------------------------------------------------
  it('the T5 segment.successor.required event drives the spine: the marker inherits its reason + reassertModel, and the requirement is consumed', async () => {
    const { service, db } = await setup(kind, [limitOnTurnN(1), [{}]]);
    const runId = await pauseOnLimit(service);
    expect(service.hasPendingSuccessorRequirement(runId)).toBe(false);

    // Simulate the T5 emission (`limit.classified.model_switch` →
    // `require_successor` → this event; §6.3 T5 emits it with reassertModel).
    service.ingest({
      type: 'segment.successor.required',
      runId,
      sequence: 0 as never,
      idempotencyKey: 'succ-req-test' as never,
      occurredAt: T0,
      payload: { reason: 'model_switch_indeterminate', reassertModel: true },
    } as unknown as DomainEvent);
    expect(service.hasPendingSuccessorRequirement(runId)).toBe(true);

    // The spine is the consumer: the marker inherits the T5 reason/flag.
    expect(service.recordSuccessorIntent(runId).status).toBe('applied');
    expect(service.status(runId).successorIntent).toMatchObject({
      reason: 'model_switch_indeterminate',
      reassertModel: true,
    });
    // Consumed: a later resume trigger is beyond the requirement's sequence.
    expect(service.hasPendingSuccessorRequirement(runId)).toBe(false);

    // And the successor still spawns exactly once through the SAME machinery.
    await service.runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
      round: 1,
      completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
    });
    expect(service.status(runId).successorIntent).toBeUndefined();
    expect(countType(db, runId, 'child.spawned')).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Refusals — a target-less / ineligible seed is honest, never silent.
  // -------------------------------------------------------------------------
  it('refuses to seed a successor from a non-suspended run (never fabricates a marker)', async () => {
    const { service } = await setup(kind, [[{}]]);
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    expect(() => service.recordSuccessorIntent(runId)).toThrow(/paused_limit or interrupted/);
    expect(service.status(runId).successorIntent).toBeUndefined();
  });
});
