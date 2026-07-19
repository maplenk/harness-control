/**
 * Bounded FIFO queue (PLAN.md §12.1 quotas, §19 test 31): "job/subscriber/
 * wait queues bounded with drop-oldest+replay or dead-letter".
 *
 * This is the shared primitive the event-bus/application layer (§5, built in
 * P2+) composes for its subscriber/job/wait queues; persistence deliberately
 * does not own queueing (see src/persistence — its report records that
 * boundary), so the primitive lives in `lib` beside the other injected
 * infrastructure (clock, ids, result).
 *
 * Overflow policies:
 * - `drop_oldest`: the OLDEST queued item is evicted to admit the newest,
 *   and the queue raises `needsReplay`. The §5/§12.1 recovery contract is
 *   that a consumer which lost items catches up by replaying from the
 *   durable event log by `(run_id, sequence)` — so the queue's job is to
 *   record honestly THAT loss happened (and how much), never to hide it.
 *   Call `acknowledgeReplay()` once the consumer has re-synced.
 * - `dead_letter`: admitted items are never lost; the REJECTED incoming item
 *   is handed to the `onDeadLetter` sink for out-of-band handling.
 *
 * Deterministic by construction: no clock, no randomness, no I/O — outcomes
 * are a pure function of the operation sequence.
 */

export type OverflowPolicy = 'drop_oldest' | 'dead_letter';

export interface BoundedQueueOptions<T> {
  /** Maximum queued items; positive safe integer. */
  readonly capacity: number;
  readonly policy: OverflowPolicy;
  /** `drop_oldest` only: receives each evicted (oldest) item. */
  readonly onDropOldest?: (item: T) => void;
  /** `dead_letter` only: receives each rejected (newest) item. */
  readonly onDeadLetter?: (item: T) => void;
}

export interface EnqueueResult<T> {
  /** false only under `dead_letter` overflow (the incoming item was rejected). */
  readonly accepted: boolean;
  /** Set only under `drop_oldest` overflow: the oldest item that was evicted. */
  readonly evicted: T | undefined;
}

export interface BoundedQueueStats {
  /** Items admitted into the queue (excludes dead-lettered rejections). */
  readonly enqueuedTotal: number;
  readonly dequeuedTotal: number;
  readonly droppedOldestTotal: number;
  readonly deadLetteredTotal: number;
}

export class BoundedQueue<T> {
  readonly #capacity: number;
  readonly #policy: OverflowPolicy;
  readonly #onDropOldest: ((item: T) => void) | undefined;
  readonly #onDeadLetter: ((item: T) => void) | undefined;

  /** Backing array with a head cursor (O(1) amortized dequeue, no shift()). */
  #items: T[] = [];
  #head = 0;

  #enqueuedTotal = 0;
  #dequeuedTotal = 0;
  #droppedOldestTotal = 0;
  #deadLetteredTotal = 0;
  #needsReplay = false;

  constructor(options: BoundedQueueOptions<T>) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 1) {
      throw new Error(`BoundedQueue capacity must be a positive safe integer, got ${String(options.capacity)}`);
    }
    this.#capacity = options.capacity;
    this.#policy = options.policy;
    this.#onDropOldest = options.onDropOldest;
    this.#onDeadLetter = options.onDeadLetter;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get policy(): OverflowPolicy {
    return this.#policy;
  }

  get size(): number {
    return this.#items.length - this.#head;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  get isFull(): boolean {
    return this.size >= this.#capacity;
  }

  /**
   * True after any `drop_oldest` eviction: the consumer's view is no longer
   * complete and it must replay from the durable log (§12.1) before trusting
   * this queue as its only feed. Cleared via `acknowledgeReplay()`.
   */
  get needsReplay(): boolean {
    return this.#needsReplay;
  }

  acknowledgeReplay(): void {
    this.#needsReplay = false;
  }

  get stats(): BoundedQueueStats {
    return {
      enqueuedTotal: this.#enqueuedTotal,
      dequeuedTotal: this.#dequeuedTotal,
      droppedOldestTotal: this.#droppedOldestTotal,
      deadLetteredTotal: this.#deadLetteredTotal,
    };
  }

  enqueue(item: T): EnqueueResult<T> {
    if (!this.isFull) {
      this.#items.push(item);
      this.#enqueuedTotal += 1;
      return { accepted: true, evicted: undefined };
    }

    if (this.#policy === 'dead_letter') {
      this.#deadLetteredTotal += 1;
      this.#onDeadLetter?.(item);
      return { accepted: false, evicted: undefined };
    }

    // drop_oldest: evict the head to admit the newest; record the loss.
    const evicted = this.#takeHead();
    this.#droppedOldestTotal += 1;
    this.#needsReplay = true;
    this.#items.push(item);
    this.#enqueuedTotal += 1;
    this.#onDropOldest?.(evicted);
    return { accepted: true, evicted };
  }

  peek(): T | undefined {
    return this.isEmpty ? undefined : this.#items[this.#head];
  }

  dequeue(): T | undefined {
    if (this.isEmpty) return undefined;
    const item = this.#takeHead();
    this.#dequeuedTotal += 1;
    return item;
  }

  /** Dequeues everything, in FIFO order. */
  drain(): T[] {
    const out: T[] = [];
    for (let next = this.dequeue(); next !== undefined; next = this.dequeue()) {
      out.push(next);
    }
    return out;
  }

  #takeHead(): T {
    const item = this.#items[this.#head];
    if (item === undefined && this.#head >= this.#items.length) {
      throw new Error('BoundedQueue internal error: takeHead on empty queue');
    }
    this.#head += 1;
    // Periodically compact so the backing array cannot grow unbounded — this
    // primitive exists to enforce §12.1 memory bounds, so it must not leak.
    if (this.#head >= this.#capacity || this.#head >= 1024) {
      this.#items = this.#items.slice(this.#head);
      this.#head = 0;
    }
    return item as T;
  }
}
