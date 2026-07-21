/**
 * W2-7 CRASH-INJECTION at the spec-listed pause/probe/re-entry boundaries
 * (spec docs/specs/hardening-p4a.md §W2-7, pushback items 4 + 9; PLAN §12.2,
 * §13) — REAL-path injections through the shipped `pauseForLimit` /
 * `runScheduledProbe` / `runRole` code, a fresh service over the same store
 * playing the restarted process. Restart must recover idempotently at EVERY
 * boundary.
 *
 * The full boundary matrix and where each leg is proven:
 *  1. after checkpoint-write (before the atomic append) —
 *     app/pause-spine.test.ts "append-failure after the checkpoint fsync"
 *     (artifact unreferenced → GC-invisible; nothing paused);
 *  2. after the atomic append / 3. before `child.stopped` — THIS FILE
 *     (real-path injection; both crashes leave the identical durable state:
 *     committed stop-intent, no confirmation — the difference is only
 *     whether the OS process is still alive, which §14 startup reaping owns:
 *     app/supervision.test.ts proves a provably-GONE generation completes
 *     the stop-intent, and pause-spine proves the synthetic reclaim);
 *  4. after the probe claim (before the outcome) — THIS FILE (real-path:
 *     the claimant dies after `limit.probe.claimed` commits; the rung is
 *     adopted after the grace under the SAME idempotency fence;
 *     app/limit-probe.test.ts proves the synthetic-claim variant);
 *  5. after T9 before the re-entry spawn — app/resume-reentry.test.ts
 *     ("crash before re-entry") + cli/commands.limit.test.ts (startup
 *     reclaim drives the unacknowledged pending re-entry);
 *  6. after the re-entry spawn, before the `resume_reentry.completed` ack —
 *     THIS FILE (real-path: `child.spawned` committed, the ack append dies;
 *     the next re-entry drive acks exactly once, no fresh T9 consumed).
 */
import { CLEAN_PINNED_WORKSPACE_GIT, createRunFixture } from './test-support.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { runId as toRunId, type RunId } from '../domain/ids.js';
import type { DomainEvent } from '../domain/events.js';
import {
  InProcessFakeAdapter,
  limitOnTurnN,
  rateLimitErrorEnvelope,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
} from '../adapters/index.js';
import { DeterministicIdFactory, RandomIdFactory } from '../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import {
  DEFAULT_PROBE_ADOPT_AFTER_MS,
  deterministicJitterMs,
  incidentIdOf,
  latestIncidentEvent,
  probeClaimKey,
  probeOutcomeKey,
} from '../scheduler/limit-schedule.js';
import { LimitPausedError, OrchestrationService, type RoleAdapterFactory } from './service.js';
import type { RoleRunner } from './role-runner.js';
import type { Harness, RoleModelSpec } from './model-resolution.js';

// ---------------------------------------------------------------------------
// Harness (pause-matrix conventions)
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

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

const T0 = '2026-07-18T00:00:00.000Z';
const CLAUDE_LOW: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
/** DeterministicIdFactory mints run_000001 for the first run of every test. */
const RUN1 = toRunId('run_000001');
const RUNG1_MS = 30 * 60_000;
const DEADLINE1_OFFSET_MS = RUNG1_MS + deterministicJitterMs(RUN1, 1, RUNG1_MS);

async function setup(scripts: readonly (readonly InProcessTurnScript[])[]): Promise<{
  service: OrchestrationService;
  db: TestDatabaseHandle['db'];
  clock: ManualClock;
  createdCount: () => number;
}> {
  const clock = new ManualClock(T0);
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false, clock });
  const { factory, createdCount } = makeQueueFactory(scripts);
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
  });
  return { service, db: handle.db, clock, createdCount };
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

/** Inject a "process death" into the durable write path: the append that
 * carries `type` throws. Returns a restore function. */
function crashOnAppendOf(
  db: TestDatabaseHandle['db'],
  type: string,
): { restore: () => void; crashes: () => number } {
  const events = db.events as { appendBatch: typeof db.events.appendBatch };
  const original = db.events.appendBatch.bind(db.events);
  let crashes = 0;
  events.appendBatch = (drafts: readonly DomainEvent[]) => {
    if (drafts.some((d) => d.type === type)) {
      crashes += 1;
      throw new Error(`injected crash: process died appending ${type}`);
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

/** A restarted-process stand-in that must never need to spawn an adapter. */
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
  // RandomIdFactory: a restarted process never re-mints the dead one's ids.
  return new OrchestrationService({
    db,
    ids: new RandomIdFactory(),
    adapterFactory: factory,
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
  });
}

// ---------------------------------------------------------------------------
// Boundary 2/3 — after the atomic append, before `child.stopped`
// ---------------------------------------------------------------------------
describe('crash after the atomic pause append, before the stop confirmation (real path)', () => {
  it('restart finds the committed stop-intent, reclaims it idempotently, and the round re-enters to completion', async () => {
    const { service, db } = await setup([limitOnTurnN(1)]);
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const crash = crashOnAppendOf(db, 'child.stopped');
    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);
    crash.restore();
    expect(String(error)).toContain('injected crash');
    expect(crash.crashes()).toBeGreaterThanOrEqual(1); // step 4 + the finally's confirm

    // The durable state the crash left: the ONE atomic append committed —
    // paused with incident + checkpoint + stop-intent — but no confirmation.
    const types = eventTypes(db, runId);
    expect(types).toContain('limit.classified.prompt_turn');
    expect(types).toContain('checkpoint.recorded');
    expect(types).toContain('limit.incident.recorded');
    expect(types).toContain('child.stop.intent');
    expect(types).not.toContain('child.stopped');

    // "Restart": recovery rebuilds the paused state from the log alone.
    const restarted = successorService(db);
    const recovered = restarted.recover(runId);
    expect(recovered.suspension.kind).toBe('paused_limit');
    expect(recovered.activeChild).toMatchObject({ status: 'stopping', stopCause: 'limit_pause' });

    // The §14-identity-verified cleanup completes the intent (the process is
    // provably gone here — the fake spawns nothing); idempotent on repeat.
    const confirmed = restarted.confirmStopIntentAfterCleanup(runId);
    expect(confirmed?.status).toBe('recorded');
    expect(restarted.status(runId).suspension).toBe('paused_limit'); // the pause survives
    expect(restarted.status(runId).activeChild).toMatchObject({ status: 'stopped' });
    const stopped = db.events.listByRun(runId).find((e) => e.type === 'child.stopped');
    expect(stopped?.payload).toMatchObject({ reason: 'startup_cleanup' });
    expect(restarted.confirmStopIntentAfterCleanup(runId)).toBeUndefined(); // no-op

    // Full re-entry: T9, re-drive the round, complete — zero respawns ever.
    const reentrant = successorService(db, [[{}]]);
    expect(reentrant.resume(runId).status).toBe('applied');
    await reentrant.runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
      round: 1,
      completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
    });
    reentrant.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
    const st = reentrant.status(runId);
    expect(st.phase).toBe('awaiting_approval');
    expect(st.suspension).toBe('none');
    expect(st.resumeReentryPending).toBeUndefined();
    expect(st.counters.restartsInWindow).toBe(0);
    expect(st.counters.lifetimeRestarts).toBe(0);
    expect(eventTypes(db, runId)).not.toContain('segment.restart.initiated');
  });
});

// ---------------------------------------------------------------------------
// Boundary 4 — after the probe claim, before the outcome
// ---------------------------------------------------------------------------
describe('crash after the probe claim committed, before the outcome (real path)', () => {
  it('the rung stays fenced: presumed live within the grace, then ADOPTED — one claim, one outcome under the same key', async () => {
    const { service, db, clock, createdCount } = await setup([
      limitOnTurnN(1), // the paused round
      [{}], // every probe attempt is healthy
    ]);
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(runId, promptOnceRunner()).catch(() => undefined);
    expect(service.status(runId).suspension).toBe('paused_limit');
    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);

    // The claimant dies AFTER `limit.probe.claimed` commits: the probe ran,
    // but its outcome append (T9 here) never lands.
    const crash = crashOnAppendOf(db, 'resume.limit.requested');
    const error: unknown = await service.runScheduledProbe(runId).catch((e: unknown) => e);
    crash.restore();
    expect(String(error)).toContain('injected crash');
    expect(countType(db, runId, 'limit.probe.claimed')).toBe(1);
    expect(countType(db, runId, 'resume.limit.requested')).toBe(0);
    expect(service.status(runId).suspension).toBe('paused_limit');
    const probeSpawns = createdCount();

    // A restarted waiter within the adoption grace presumes the claimant
    // live — no double-probe.
    const young = await service.runScheduledProbe(runId);
    expect(young).toEqual({ outcome: 'claim_in_flight', probeIndex: 1 });
    expect(createdCount()).toBe(probeSpawns);

    // Past the grace the outcome-less claim is ADOPTED: the SAME fence keys
    // the one logical outcome, and the run resumes.
    clock.advanceMs(DEFAULT_PROBE_ADOPT_AFTER_MS + 1000);
    const adopted = await service.runScheduledProbe(runId);
    expect(adopted).toEqual({ outcome: 'resumed', probeIndex: 1 });
    expect(countType(db, runId, 'limit.probe.claimed')).toBe(1); // still one logical claim
    const t9s = db.events.listByRun(runId).filter((e) => e.type === 'resume.limit.requested');
    expect(t9s).toHaveLength(1);
    const incident = latestIncidentEvent(db.events.listByRun(runId))!;
    expect(t9s[0]?.idempotencyKey).toBe(probeOutcomeKey(probeClaimKey(incidentIdOf(incident), 1)));
    const st = service.status(runId);
    expect(st.suspension).toBe('none');
    expect(st.resumeReentryPending).toMatchObject({ mode: 'scheduled_probe' });
  });
});

// ---------------------------------------------------------------------------
// Boundary 6 — after the re-entry spawn, before the ack
// ---------------------------------------------------------------------------
describe('crash after the re-entry spawn committed, before resume_reentry.completed (real path)', () => {
  it('the pending re-entry survives; the next drive re-enters and acks EXACTLY once — no fresh T9, no respawn counting', async () => {
    const { service, db } = await setup([
      limitOnTurnN(1), // generation 1: pauses
      [{}], // generation 2: the crashed re-entry attempt
      [{}], // generation 3: the successful re-drive
    ]);
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(runId, promptOnceRunner()).catch(() => undefined);
    expect(service.resume(runId).status).toBe('applied'); // T9, pending recorded

    // The re-entry spawn commits `child.spawned` (round active), then the
    // process dies appending the ack.
    const crash = crashOnAppendOf(db, 'resume_reentry.completed');
    const reentry: unknown = await service
      .runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
        round: 1,
        completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
      })
      .then(() => undefined)
      .catch((e: unknown) => e);
    crash.restore();
    expect(String(reentry)).toContain('injected crash');

    // Durable state: the spawn committed and its stop was confirmed by the
    // unwind, but the pending re-entry is STILL unacknowledged.
    expect(countType(db, runId, 'child.spawned')).toBe(2); // gen 1 + the crashed re-entry
    expect(countType(db, runId, 'resume_reentry.completed')).toBe(0);
    const restarted = successorService(db, [[{}]]);
    expect(restarted.recover(runId).resumeReentryPending).toBeDefined();
    expect(restarted.getRoleRound(runId)).toMatchObject({ round: 1, stage: 'active' });

    // The next drive (what `resume`'s startup reclaim does) re-enters the
    // SAME round idempotently: the ack lands exactly once, no new T9.
    await restarted.runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
      round: 1,
      completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
    });
    restarted.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
    const st = restarted.status(runId);
    expect(st.phase).toBe('awaiting_approval');
    expect(st.resumeReentryPending).toBeUndefined();
    expect(countType(db, runId, 'resume_reentry.completed')).toBe(1);
    expect(countType(db, runId, 'resume.limit.requested')).toBe(1); // the one T9
    expect(restarted.getRoleRound(runId)).toMatchObject({ round: 1, stage: 'completed' });
    // A limit pause and its crash-recovery never count as restarts (§13).
    expect(st.counters.restartsInWindow).toBe(0);
    expect(st.counters.lifetimeRestarts).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-check: the injected-crash error text names the write, never a pause
// ---------------------------------------------------------------------------
describe('crash-injection hygiene', () => {
  it('an injected append failure is a raw error, never converted into a LimitPausedError', async () => {
    const { service, db } = await setup([[{ errorEnvelope: rateLimitErrorEnvelope() }]]);
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const crash = crashOnAppendOf(db, 'child.stopped');
    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);
    crash.restore();
    expect(error).not.toBeInstanceOf(LimitPausedError);
    expect(String(error)).toContain('injected crash');
  });
});
