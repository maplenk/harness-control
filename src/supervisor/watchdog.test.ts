/**
 * PLAN.md §19 test 27: "watchdog: soft warn -> graceful -> emergency taint,
 * kill during git-op lease waits or taints."
 *
 * Real spawned Node child processes throughout, RSS controlled via
 * `Buffer.alloc` (per the task framing) — no fakes stand in for the OS.
 * `budgetMb` (300) and the target allocations below are computed from a
 * MEASURED baseline RSS (a bare `node -e` process's own footprint, ~35-40MB
 * on this env) rather than a guessed constant, so the scenarios land in
 * their intended threshold zone regardless of the exact Node/OS baseline.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { assignmentId, processGenerationId, runId, segmentId, type AssignmentId } from '../domain/ids.js';
import type { DomainEvent } from '../domain/events.js';
import type { WorktreeTaint } from '../domain/state.js';
import { parseEngineConfig } from '../config/loader.js';
import type { MemoryConfig } from '../config/schema.js';
import { createPsClient } from './ps.js';
import { ProcessRegistry } from './registry.js';
import { Watchdog, type GitOpLeaseObserver, type WatchdogTarget, type WorktreeTaintSink } from './watchdog.js';

const clock = new ManualClock('2026-07-18T09:00:00.000Z');
const ps = createPsClient(clock);
const BUDGET_MB = 300;

let spawned: ChildProcess[] = [];
let watchdogsToStop: Watchdog[] = [];

function spawnWithExtraMb(extraMb: number): ChildProcess {
  const mb = Math.max(0, Math.round(extraMb));
  const script = `const b = Buffer.alloc(${mb} * 1024 * 1024, 1); global.__keep = b; setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
  spawned.push(child);
  return child;
}

function isAliveReal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function settle(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil: condition not satisfied within ${timeoutMs}ms`);
    }
    await settle(intervalMs);
  }
}

let baselineMb = 40;

beforeAll(async () => {
  const probe = spawnWithExtraMb(0);
  await settle(400);
  const sample = ps.sampleProcessTree(probe.pid!);
  if (sample) baselineMb = sample.rssBytes / (1024 * 1024);
  try {
    process.kill(-probe.pid!, 'SIGKILL');
  } catch {
    // already gone
  }
  await settle(50);
}, 15_000);

afterEach(async () => {
  for (const watchdog of watchdogsToStop) watchdog.stopAll();
  watchdogsToStop = [];
  for (const child of spawned) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  spawned = [];
  await settle(50);
});

function buildMemoryConfig(overrides: Partial<{ budgetMb: number; gracefulStopDeadlineMs: number }> = {}): MemoryConfig {
  const parsed = parseEngineConfig({
    memory: { budgetMb: BUDGET_MB, gracefulStopDeadlineMs: 200, ...overrides },
  });
  if (!parsed.ok) throw new Error(`invalid test memory config: ${JSON.stringify(parsed.error)}`);
  return parsed.value.memory;
}

interface Harness {
  readonly watchdog: Watchdog;
  readonly events: DomainEvent[];
  readonly taints: Array<{ assignmentId: AssignmentId; taint: WorktreeTaint }>;
  readonly gracefulStopCalls: WatchdogTarget[];
  readonly registry: ProcessRegistry;
}

function buildHarness(opts: {
  readonly memory?: MemoryConfig;
  readonly requestGracefulStop?: (target: WatchdogTarget) => void | Promise<void>;
  readonly gitOpLease?: GitOpLeaseObserver;
  readonly leaseWaitPollMs?: number;
}): Harness {
  const events: DomainEvent[] = [];
  const taints: Array<{ assignmentId: AssignmentId; taint: WorktreeTaint }> = [];
  const gracefulStopCalls: WatchdogTarget[] = [];
  const registry = new ProcessRegistry({ clock, ps });
  const worktreeTaint: WorktreeTaintSink = {
    markTainted: (asg, taint) => taints.push({ assignmentId: asg, taint }),
  };

  const watchdog = new Watchdog({
    clock,
    ids: new DeterministicIdFactory(),
    registry,
    ps,
    memory: opts.memory ?? buildMemoryConfig(),
    sampleIntervalMs: 40,
    elevatedSampleIntervalMs: 20,
    ...(opts.gitOpLease ? { gitOpLease: opts.gitOpLease } : {}),
    ...(opts.leaseWaitPollMs !== undefined ? { leaseWaitPollMs: opts.leaseWaitPollMs } : {}),
    worktreeTaint,
    requestGracefulStop: (target) => {
      gracefulStopCalls.push(target);
      return opts.requestGracefulStop?.(target);
    },
    onEvent: (event) => events.push(event),
  });
  watchdogsToStop.push(watchdog);
  return { watchdog, events, taints, gracefulStopCalls, registry };
}

function watchTarget(harness: Harness, child: ChildProcess, extra: Partial<WatchdogTarget> = {}): WatchdogTarget {
  const generationId = extra.generationId ?? processGenerationId(`gen_${child.pid}`);
  harness.registry.register({
    generationId,
    pid: child.pid!,
    pgid: child.pid!,
    spawnNonce: `nonce-${child.pid}`,
  });
  const target: WatchdogTarget = {
    runId: runId(`run_${child.pid}`),
    generationId,
    pgid: child.pid!,
    segmentId: segmentId(`seg_${child.pid}`),
    assignmentId: assignmentId(`asg_${child.pid}`),
    ...extra,
  };
  harness.watchdog.watch(target);
  return target;
}

function eventTypes(events: DomainEvent[]): string[] {
  return events.map((e) => e.type);
}

function hardLimitEvents(events: DomainEvent[]): Array<{ escalation: string }> {
  return events
    .filter((e) => e.type === 'rss.hard_limit')
    .map((e) => ({ escalation: (e.payload as { escalation: string }).escalation }));
}

describe('Watchdog: soft warn (§14 75% threshold)', () => {
  it('emits exactly one rss.soft_threshold event once, never escalates, and never touches the process', async () => {
    // ~0.77x budget: comfortably between 75% and 100%, robust to baseline variance.
    const child = spawnWithExtraMb(230 - baselineMb);
    await settle(300);
    const harness = buildHarness({});
    const target = watchTarget(harness, child);

    await waitUntil(() => eventTypes(harness.events).includes('rss.soft_threshold'), 3_000);
    await settle(250); // give it several more sample ticks to (not) do anything further

    expect(eventTypes(harness.events).filter((t) => t === 'rss.soft_threshold')).toHaveLength(1);
    expect(eventTypes(harness.events)).not.toContain('rss.hard_limit');
    expect(harness.taints).toEqual([]);
    expect(harness.gracefulStopCalls).toEqual([]);
    expect(isAliveReal(child.pid!)).toBe(true);
    expect(harness.watchdog.phaseOf(target.generationId)).toBe('soft_warned');
  }, 10_000);
});

describe('Watchdog: graceful path at 100% (§14)', () => {
  it('requests a graceful stop; when it succeeds within the deadline, cleans up with NO taint and NO emergency event', async () => {
    // ~1.13x budget: over 100%, comfortably under the 150% ceiling.
    const child = spawnWithExtraMb(340 - baselineMb);
    await settle(300);
    const harness = buildHarness({
      memory: buildMemoryConfig({ gracefulStopDeadlineMs: 2_000 }), // generous — success should land well before this
      requestGracefulStop: (target) => {
        // Simulate the engine's real checkpoint+clean-stop succeeding.
        try {
          process.kill(-target.pgid, 'SIGKILL');
        } catch {
          // already gone
        }
      },
    });
    const target = watchTarget(harness, child);

    await waitUntil(() => eventTypes(harness.events).includes('rss.hard_limit'), 3_000);
    expect(harness.gracefulStopCalls).toHaveLength(1);
    expect(hardLimitEvents(harness.events)).toEqual([{ escalation: 'graceful' }]);

    await waitUntil(() => !harness.watchdog.isWatching(target.generationId), 3_000);
    expect(isAliveReal(child.pid!)).toBe(false);
    expect(harness.taints).toEqual([]); // clean stop: never tainted
    expect(hardLimitEvents(harness.events)).toEqual([{ escalation: 'graceful' }]); // still exactly one — no emergency escalation
  }, 10_000);

  it('escalates to an emergency kill + deadline_termination taint once the graceful deadline elapses without the process stopping', async () => {
    const child = spawnWithExtraMb(340 - baselineMb);
    await settle(300);
    const harness = buildHarness({
      memory: buildMemoryConfig({ gracefulStopDeadlineMs: 200 }),
      requestGracefulStop: () => undefined, // the "engine" never actually stops it
    });
    const target = watchTarget(harness, child);

    await waitUntil(() => eventTypes(harness.events).includes('rss.hard_limit'), 3_000);
    expect(hardLimitEvents(harness.events)).toEqual([{ escalation: 'graceful' }]);

    // Deadline (200ms) must elapse before escalation — not touched immediately.
    await settle(80);
    expect(isAliveReal(child.pid!)).toBe(true);

    await waitUntil(() => hardLimitEvents(harness.events).length === 2, 3_000);
    expect(hardLimitEvents(harness.events)).toEqual([{ escalation: 'graceful' }, { escalation: 'emergency_kill' }]);
    expect(harness.taints).toEqual([{ assignmentId: target.assignmentId, taint: 'deadline_termination' }]);

    await waitUntil(() => isAliveReal(child.pid!) === false, 2_000);
    expect(harness.watchdog.isWatching(target.generationId)).toBe(false);
  }, 10_000);
});

describe('Watchdog: immediate hard emergency ceiling (§14 150%)', () => {
  it('kills immediately with NO graceful phase at all, tainted emergency_kill', async () => {
    // ~1.73x budget: past the 150% ceiling from the very first sample.
    const child = spawnWithExtraMb(520 - baselineMb);
    await settle(300);
    const harness = buildHarness({});
    const target = watchTarget(harness, child);

    await waitUntil(() => eventTypes(harness.events).includes('rss.hard_limit'), 3_000);

    expect(hardLimitEvents(harness.events)).toEqual([{ escalation: 'emergency_kill' }]);
    expect(harness.gracefulStopCalls).toEqual([]); // graceful phase never entered
    expect(harness.taints).toEqual([{ assignmentId: target.assignmentId, taint: 'emergency_kill' }]);

    await waitUntil(() => isAliveReal(child.pid!) === false, 2_000);
    expect(harness.watchdog.isWatching(target.generationId)).toBe(false);
  }, 10_000);
});

describe('Watchdog: kill respects an active git-op lease (§14/§16.2) — waits or taints', () => {
  function fakeLease(heldRef: { held: boolean }): GitOpLeaseObserver {
    return {
      awaitGitOpIdle: async (deadlineMs) => {
        if (!heldRef.held) return 'idle';
        await settle(deadlineMs);
        return heldRef.held ? 'timed_out' : 'idle';
      },
    };
  }

  it('WAITS for the lease to release before killing on a deadline-triggered escalation, then kills + taints deadline_termination', async () => {
    const child = spawnWithExtraMb(340 - baselineMb); // graceful zone
    await settle(300);
    const heldRef = { held: true };
    const harness = buildHarness({
      memory: buildMemoryConfig({ gracefulStopDeadlineMs: 150 }),
      requestGracefulStop: () => undefined,
      gitOpLease: fakeLease(heldRef),
      leaseWaitPollMs: 60,
    });
    const target = watchTarget(harness, child);

    // Let the graceful deadline elapse, then a bit more: the process must
    // still be ALIVE and UNTAINTED because the lease is (still) held.
    await settle(150 + 250);
    expect(isAliveReal(child.pid!)).toBe(true);
    expect(harness.taints).toEqual([]);
    expect(hardLimitEvents(harness.events)).toEqual([{ escalation: 'graceful' }]); // no emergency event yet

    // Release the lease: the kill must now proceed.
    heldRef.held = false;
    await waitUntil(() => isAliveReal(child.pid!) === false, 3_000);
    expect(harness.taints).toEqual([{ assignmentId: target.assignmentId, taint: 'deadline_termination' }]);
    expect(hardLimitEvents(harness.events)).toEqual([{ escalation: 'graceful' }, { escalation: 'emergency_kill' }]);
  }, 10_000);

  it('the emergency ceiling ALWAYS wins over an indefinitely-held lease — kills immediately, tainted emergency_kill', async () => {
    const child = spawnWithExtraMb(520 - baselineMb); // ceiling zone from the first sample
    await settle(300);
    const heldRef = { held: true }; // never released for the duration of this test
    const harness = buildHarness({
      gitOpLease: fakeLease(heldRef),
      leaseWaitPollMs: 60,
    });
    const target = watchTarget(harness, child);

    // The ceiling path never even consults the lease, so this must resolve fast.
    await waitUntil(() => isAliveReal(child.pid!) === false, 2_000);
    expect(harness.taints).toEqual([{ assignmentId: target.assignmentId, taint: 'emergency_kill' }]);
    expect(hardLimitEvents(harness.events)).toEqual([{ escalation: 'emergency_kill' }]);
  }, 10_000);
});

describe('Watchdog: identity-gated kill (§14 bullet 1) — even the emergency path never bypasses it', () => {
  it('an emergency-kill target whose registry record has gone stale is left alive and unwatched-but-unkilled, with no taint', async () => {
    const child = spawnWithExtraMb(520 - baselineMb); // ceiling zone
    await settle(300);
    const harness = buildHarness({});
    const generationId = processGenerationId(`gen_stale_${child.pid}`);
    // Register a MISMATCHING identity on purpose (simulating "the registry's
    // record for this generation id is stale") rather than the real one.
    harness.registry.store.put({
      generationId,
      pid: child.pid!,
      pgid: child.pid!,
      startedAt: 'Mon Jan  1 00:00:00 2020',
      executablePath: '/definitely/not/it',
      spawnNonce: 'stale',
      recordedAt: clock.nowIso(),
    });
    const target: WatchdogTarget = {
      runId: runId(`run_${child.pid}`),
      generationId,
      pgid: child.pid!,
      assignmentId: assignmentId(`asg_${child.pid}`),
    };
    harness.watchdog.watch(target);

    await waitUntil(() => eventTypes(harness.events).includes('rss.hard_limit'), 3_000);
    await settle(200);

    // The registry withheld the signal (identity mismatch) — the process
    // must still be alive, and no taint was ever recorded for it.
    expect(isAliveReal(child.pid!)).toBe(true);
    expect(harness.taints).toEqual([]);
  }, 10_000);
});
