/**
 * Max-live-children concurrency guard (PLAN.md §14 "Concurrency": "simple
 * max-live-children guard (default 3) — the MVP is serial-per-run; RAM-tier
 * scheduling + LRU eviction deferred to the parallel-waves phase").
 *
 * Deliberately the simplest possible primitive: a bounded set of live
 * generation keys. No RAM-awareness, no eviction policy — those are
 * explicitly out of MVP scope (§4.2).
 */
export const DEFAULT_MAX_LIVE_CHILDREN = 3;

export class MaxLiveChildrenExceededError extends Error {
  readonly max: number;
  readonly current: number;

  constructor(max: number, current: number) {
    super(`max-live-children guard: at capacity (${current}/${max}); cannot spawn another child`);
    this.name = 'MaxLiveChildrenExceededError';
    this.max = max;
    this.current = current;
  }
}

export interface MaxLiveChildrenGuardOptions {
  readonly maxLiveChildren?: number;
}

export class MaxLiveChildrenGuard {
  readonly #max: number;
  readonly #live = new Set<string>();

  constructor(options: MaxLiveChildrenGuardOptions = {}) {
    const max = options.maxLiveChildren ?? DEFAULT_MAX_LIVE_CHILDREN;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new Error(`MaxLiveChildrenGuard: maxLiveChildren must be a positive safe integer, got ${String(max)}`);
    }
    this.#max = max;
  }

  get max(): number {
    return this.#max;
  }

  get liveCount(): number {
    return this.#live.size;
  }

  get liveKeys(): readonly string[] {
    return [...this.#live];
  }

  isLive(key: string): boolean {
    return this.#live.has(key);
  }

  canSpawn(): boolean {
    return this.#live.size < this.#max;
  }

  /** Idempotent: re-acquiring an already-live key always succeeds and never double-counts. Returns false (never throws) when at capacity. */
  acquire(key: string): boolean {
    if (this.#live.has(key)) return true;
    if (!this.canSpawn()) return false;
    this.#live.add(key);
    return true;
  }

  /** Same as `acquire`, but throws `MaxLiveChildrenExceededError` instead of returning false — for callers that want fail-loud semantics. */
  requireCapacity(key: string): void {
    if (!this.acquire(key)) {
      throw new MaxLiveChildrenExceededError(this.#max, this.#live.size);
    }
  }

  release(key: string): void {
    this.#live.delete(key);
  }
}
