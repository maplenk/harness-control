/**
 * PLAN §19 test 31 (third clause) / §12.1 quotas: "job/subscriber/wait
 * queues bounded with drop-oldest+replay or dead-letter". The first two
 * clauses of test 31 (artifact admission rejection, telemetry aggregation)
 * live in src/persistence/artifact-repository.test.ts and
 * src/persistence/telemetry-repository.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { BoundedQueue } from './bounded-queue.js';

describe('BoundedQueue — construction', () => {
  it('rejects a non-positive or non-integer capacity', () => {
    for (const capacity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new BoundedQueue<number>({ capacity, policy: 'drop_oldest' })).toThrow(
        /positive safe integer/,
      );
    }
  });

  it('preserves FIFO order while under capacity', () => {
    const q = new BoundedQueue<number>({ capacity: 3, policy: 'drop_oldest' });
    for (const n of [1, 2, 3]) expect(q.enqueue(n)).toEqual({ accepted: true, evicted: undefined });
    expect(q.size).toBe(3);
    expect(q.isFull).toBe(true);
    expect(q.peek()).toBe(1);
    expect(q.drain()).toEqual([1, 2, 3]);
    expect(q.isEmpty).toBe(true);
  });

  it('dequeue/peek on an empty queue return undefined, never throw', () => {
    const q = new BoundedQueue<string>({ capacity: 1, policy: 'dead_letter' });
    expect(q.dequeue()).toBeUndefined();
    expect(q.peek()).toBeUndefined();
  });
});

describe('BoundedQueue — drop_oldest + replay (§12.1)', () => {
  it('at capacity, evicts exactly the OLDEST item, admits the newest, and stays bounded', () => {
    const dropped: number[] = [];
    const q = new BoundedQueue<number>({
      capacity: 3,
      policy: 'drop_oldest',
      onDropOldest: (n) => dropped.push(n),
    });
    [1, 2, 3].forEach((n) => q.enqueue(n));

    const overflow = q.enqueue(4);
    expect(overflow).toEqual({ accepted: true, evicted: 1 });
    expect(q.size).toBe(3);
    expect(dropped).toEqual([1]);
    expect(q.drain()).toEqual([2, 3, 4]);
  });

  it('signals needsReplay after loss — the consumer must catch up from the durable log by sequence', () => {
    const q = new BoundedQueue<number>({ capacity: 2, policy: 'drop_oldest' });
    q.enqueue(1);
    q.enqueue(2);
    expect(q.needsReplay).toBe(false);

    q.enqueue(3);
    expect(q.needsReplay).toBe(true);

    // Acknowledging replay clears the flag; a NEW overflow re-arms it.
    q.acknowledgeReplay();
    expect(q.needsReplay).toBe(false);
    q.enqueue(4);
    expect(q.needsReplay).toBe(true);
  });

  it('a long overflow burst never grows the queue beyond capacity and counts every loss', () => {
    const q = new BoundedQueue<number>({ capacity: 5, policy: 'drop_oldest' });
    for (let n = 0; n < 5_000; n += 1) q.enqueue(n);
    expect(q.size).toBe(5);
    expect(q.stats.droppedOldestTotal).toBe(4_995);
    expect(q.stats.enqueuedTotal).toBe(5_000);
    expect(q.drain()).toEqual([4995, 4996, 4997, 4998, 4999]);
  });
});

describe('BoundedQueue — dead_letter (§12.1)', () => {
  it('at capacity, rejects the INCOMING item into the dead-letter sink; admitted items are never lost', () => {
    const deadLettered: string[] = [];
    const q = new BoundedQueue<string>({
      capacity: 2,
      policy: 'dead_letter',
      onDeadLetter: (s) => deadLettered.push(s),
    });
    q.enqueue('a');
    q.enqueue('b');

    const overflow = q.enqueue('c');
    expect(overflow).toEqual({ accepted: false, evicted: undefined });
    expect(deadLettered).toEqual(['c']);
    // dead_letter loses nothing that was admitted, so no replay is needed.
    expect(q.needsReplay).toBe(false);
    expect(q.drain()).toEqual(['a', 'b']);
  });

  it('accepts normally again once dequeues make room', () => {
    const q = new BoundedQueue<string>({ capacity: 1, policy: 'dead_letter' });
    q.enqueue('a');
    expect(q.enqueue('b').accepted).toBe(false);
    expect(q.dequeue()).toBe('a');
    expect(q.enqueue('c').accepted).toBe(true);
    expect(q.dequeue()).toBe('c');
  });
});

describe('BoundedQueue — accounting and determinism', () => {
  it('keeps exact cumulative stats across mixed operations', () => {
    const q = new BoundedQueue<number>({ capacity: 2, policy: 'drop_oldest' });
    q.enqueue(1);
    q.enqueue(2);
    q.enqueue(3); // drops 1
    q.dequeue(); // -> 2
    q.enqueue(4);
    q.enqueue(5); // drops 3
    expect(q.stats).toEqual({
      enqueuedTotal: 5,
      dequeuedTotal: 1,
      droppedOldestTotal: 2,
      deadLetteredTotal: 0,
    });
    expect(q.drain()).toEqual([4, 5]);
    expect(q.stats.dequeuedTotal).toBe(3);
  });

  it('is deterministic: two instances fed the identical operation sequence agree on every outcome', () => {
    const run = (): { results: Array<{ accepted: boolean; evicted: number | undefined }>; drained: number[] } => {
      const q = new BoundedQueue<number>({ capacity: 3, policy: 'drop_oldest' });
      const results = [];
      for (let n = 0; n < 10; n += 1) {
        results.push(q.enqueue(n));
        if (n % 4 === 3) q.dequeue();
      }
      return { results, drained: q.drain() };
    };
    expect(run()).toEqual(run());
  });
});
