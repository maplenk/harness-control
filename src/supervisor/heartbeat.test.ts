/**
 * PLAN.md §14 "Self-supervision": heartbeat event every 60s (injected clock).
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { runId } from '../domain/ids.js';
import type { DomainEvent } from '../domain/events.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS, HeartbeatEmitter, startHeartbeat } from './heartbeat.js';

const RUN = runId('run_heartbeat_1');

describe('HeartbeatEmitter.tick', () => {
  it('emits a ready orchestrator.heartbeat event stamped from the injected clock', () => {
    const clock = new ManualClock('2026-07-18T09:00:00.000Z');
    const ids = new DeterministicIdFactory();
    const events: DomainEvent[] = [];
    const emitter = new HeartbeatEmitter({ clock, ids, onEvent: (e) => events.push(e) });

    const event = emitter.tick(RUN);
    expect(event.type).toBe('orchestrator.heartbeat');
    expect(event.runId).toBe(RUN);
    expect(event.occurredAt).toBe(clock.nowIso());
    expect(event.payload).toEqual({});
    expect(events).toEqual([event]);
  });

  it('omits rssBytes entirely when no sampler is provided (never fabricated)', () => {
    const clock = new ManualClock('2026-07-18T09:00:00.000Z');
    const ids = new DeterministicIdFactory();
    const emitter = new HeartbeatEmitter({ clock, ids, onEvent: () => undefined });
    const event = emitter.tick(RUN);
    expect('rssBytes' in event.payload).toBe(false);
  });

  it('includes rssBytes when a sampler is provided', () => {
    const clock = new ManualClock('2026-07-18T09:00:00.000Z');
    const ids = new DeterministicIdFactory();
    const emitter = new HeartbeatEmitter({
      clock,
      ids,
      onEvent: () => undefined,
      sampleOwnRssBytes: () => 12_345,
    });
    const event = emitter.tick(RUN);
    expect(event.payload).toEqual({ rssBytes: 12_345 });
  });

  it('each tick carries a distinct idempotency key (genuinely new occurrences, not replays)', () => {
    const clock = new ManualClock('2026-07-18T09:00:00.000Z');
    const ids = new DeterministicIdFactory();
    const emitter = new HeartbeatEmitter({ clock, ids, onEvent: () => undefined });
    const first = emitter.tick(RUN);
    clock.advanceMs(60_000);
    const second = emitter.tick(RUN);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
    expect(second.occurredAt).not.toBe(first.occurredAt);
  });
});

describe('startHeartbeat (real-timer wrapper)', () => {
  it('ticks every currently-active run on each interval and can be stopped (real timers, small interval, generous assertion bound)', async () => {
    const clock = new ManualClock('2026-07-18T09:00:00.000Z');
    const ids = new DeterministicIdFactory();
    const events: DomainEvent[] = [];
    const emitter = new HeartbeatEmitter({ clock, ids, onEvent: (e) => events.push(e) });

    const activeRuns = new Set<typeof RUN>([RUN]);
    const handle = startHeartbeat(emitter, () => activeRuns, 20);

    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    handle.stop();
    const countAtStop = events.length;
    expect(countAtStop).toBeGreaterThanOrEqual(3); // 500ms / 20ms interval, generously bounded

    // Confirms `stop()` actually stops the timer: no further ticks land.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(events.length).toBe(countAtStop);
  }, 10_000);

  it('default interval constant matches the PLAN §14 normative 60s', () => {
    expect(DEFAULT_HEARTBEAT_INTERVAL_MS).toBe(60_000);
  });
});
