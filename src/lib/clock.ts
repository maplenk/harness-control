import type { Brand } from './brand.js';

/** ISO-8601 UTC timestamp string, e.g. `2026-07-18T00:00:00.000Z`. */
export type IsoTimestamp = Brand<string, 'IsoTimestamp'>;

/** Constructor for IsoTimestamp; validates parseability. */
export function isoTimestamp(value: string): IsoTimestamp {
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Not a parseable ISO-8601 timestamp: ${JSON.stringify(value)}`);
  }
  return value as IsoTimestamp;
}

/**
 * Injectable time source (PLAN.md §19: fake clocks; determinism rule: no
 * direct Date.now() in domain logic — always take a Clock).
 */
export interface Clock {
  nowMs(): number;
  nowIso(): IsoTimestamp;
}

/**
 * Production clock. This class is the ONLY sanctioned direct use of
 * `Date.now()` for time-of-day in the codebase; everything else receives a
 * `Clock`.
 */
export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
  nowIso(): IsoTimestamp {
    return new Date(this.nowMs()).toISOString() as IsoTimestamp;
  }
}

/** Deterministic clock for tests: starts fixed, advances only explicitly. */
export class ManualClock implements Clock {
  #currentMs: number;

  constructor(start: number | string | Date = '2026-01-01T00:00:00.000Z') {
    this.#currentMs = typeof start === 'number' ? start : new Date(start).getTime();
    if (Number.isNaN(this.#currentMs)) {
      throw new Error(`Invalid ManualClock start: ${String(start)}`);
    }
  }

  nowMs(): number {
    return this.#currentMs;
  }

  nowIso(): IsoTimestamp {
    return new Date(this.#currentMs).toISOString() as IsoTimestamp;
  }

  advanceMs(deltaMs: number): this {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new Error(`ManualClock.advanceMs requires a non-negative finite delta, got ${deltaMs}`);
    }
    this.#currentMs += deltaMs;
    return this;
  }

  set(to: number | string | Date): this {
    const ms = typeof to === 'number' ? to : new Date(to).getTime();
    if (Number.isNaN(ms)) throw new Error(`Invalid ManualClock.set value: ${String(to)}`);
    this.#currentMs = ms;
    return this;
  }
}
