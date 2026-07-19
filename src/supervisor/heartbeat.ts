/**
 * Self-supervision heartbeat (PLAN.md §14 "Self-supervision": "the
 * orchestrator bounds its own memory ... and emits a heartbeat event (60s)
 * so a stall is observable.").
 *
 * `tick()` is the deterministic, directly-testable primitive: it builds and
 * hands a ready `orchestrator.heartbeat` event to the caller's sink using
 * the INJECTED `Clock` for its timestamp — no test needs to wait through a
 * real 60s interval to exercise it. `startHeartbeat` is a thin real-timer
 * convenience wrapper for production wiring (its own default interval is
 * the PLAN-normative 60_000ms; tests that want to observe the interval
 * itself firing pass a small override with a generous assertion timeout).
 */
import type { Clock } from '../lib/clock.js';
import type { IdFactory } from '../lib/id-factory.js';
import { newIdempotencyKey, type RunId } from '../domain/ids.js';
import { draftEvent, type DomainEvent, type EventOfType } from '../domain/events.js';

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;

export interface HeartbeatDeps {
  readonly clock: Clock;
  readonly ids: IdFactory;
  readonly onEvent: (event: DomainEvent) => void;
  /** Optional live self-RSS reading (§14 self-supervision); omitted entirely from the payload when not provided — never fabricated. */
  readonly sampleOwnRssBytes?: () => number | undefined;
}

export class HeartbeatEmitter {
  readonly #deps: HeartbeatDeps;

  constructor(deps: HeartbeatDeps) {
    this.#deps = deps;
  }

  /** Emits one `orchestrator.heartbeat` ready event for `runId` right now. */
  tick(runId: RunId): EventOfType<'orchestrator.heartbeat'> {
    const rssBytes = this.#deps.sampleOwnRssBytes?.();
    const event = draftEvent({
      type: 'orchestrator.heartbeat',
      runId,
      payload: rssBytes !== undefined ? { rssBytes } : {},
      idempotencyKey: newIdempotencyKey(this.#deps.ids),
      occurredAt: this.#deps.clock.nowIso(),
    });
    this.#deps.onEvent(event);
    return event;
  }
}

export interface HeartbeatScheduleHandle {
  stop(): void;
}

/**
 * Real-timer wrapper: ticks every currently-active run (as reported by
 * `getActiveRunIds`, re-read on each interval so runs that start/finish
 * between ticks are picked up/dropped automatically) every `intervalMs`
 * (default 60s, §14). `.unref()`s the timer so a lone heartbeat interval
 * never keeps the Node process alive on its own.
 */
export function startHeartbeat(
  emitter: HeartbeatEmitter,
  getActiveRunIds: () => Iterable<RunId>,
  intervalMs: number = DEFAULT_HEARTBEAT_INTERVAL_MS,
): HeartbeatScheduleHandle {
  const timer = setInterval(() => {
    for (const runId of getActiveRunIds()) emitter.tick(runId);
  }, intervalMs);
  timer.unref?.();
  return { stop: (): void => clearInterval(timer) };
}
