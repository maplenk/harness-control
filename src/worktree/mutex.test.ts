import { describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { assignmentId } from '../domain/ids.js';
import { GitOpMutex } from './mutex.js';

/**
 * Deterministic (no real timers) proof of `GitOpMutex`'s core FIFO
 * serialization algorithm. `runExclusive` never `await`s before enqueueing
 * itself (see its doc comment), so flushing a generous number of
 * microtask ticks is enough to let an op REACH its critical section if the
 * mutex would ever allow it to — a controlled "gate" promise then proves
 * the SECOND op genuinely cannot proceed until the first is released,
 * with zero dependence on wall-clock timing.
 */
function flushMicrotasks(times = 30): Promise<void> {
  return Array.from({ length: times }).reduce<Promise<void>>(
    (p) => p.then(() => undefined),
    Promise.resolve(),
  );
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('GitOpMutex (PLAN §16.2)', () => {
  it('serializes two ops on the same repo: op2 never starts until op1 fully resolves', async () => {
    const mutex = new GitOpMutex(new ManualClock());
    const order: string[] = [];
    const gate = deferred();

    const p1 = mutex.runExclusive('/repo', 'worktree_add', {}, async () => {
      order.push('op1-start');
      await gate.promise;
      order.push('op1-end');
      return 'r1';
    });
    const p2 = mutex.runExclusive('/repo', 'worktree_remove', {}, async () => {
      order.push('op2-start');
      return 'r2';
    });

    // Give op2 every opportunity to (incorrectly) start if the mutex were
    // broken — this can NEVER let op2 proceed for real, since op2's own
    // queued continuation is chained behind op1's ENTIRE promise, which is
    // held open by `gate` until we explicitly resolve it below.
    await flushMicrotasks();
    expect(order).toEqual(['op1-start']);

    gate.resolve();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(order).toEqual(['op1-start', 'op1-end', 'op2-start']);
    expect(r1).toBe('r1');
    expect(r2).toBe('r2');
  });

  it('three queued ops on the same repo run in strict call order', async () => {
    const mutex = new GitOpMutex(new ManualClock());
    const order: string[] = [];
    const gates = [deferred(), deferred(), deferred()];

    const runners = [0, 1, 2].map((i) =>
      mutex.runExclusive('/repo', 'other', {}, async () => {
        order.push(`start-${i}`);
        await gates[i]?.promise;
        order.push(`end-${i}`);
      }),
    );

    await flushMicrotasks();
    expect(order).toEqual(['start-0']);
    gates[0]?.resolve();
    await flushMicrotasks();
    expect(order).toEqual(['start-0', 'end-0', 'start-1']);
    gates[1]?.resolve();
    await flushMicrotasks();
    expect(order).toEqual(['start-0', 'end-0', 'start-1', 'end-1', 'start-2']);
    gates[2]?.resolve();
    await Promise.all(runners);
    expect(order).toEqual(['start-0', 'end-0', 'start-1', 'end-1', 'start-2', 'end-2']);
  });

  it('a rejecting op still releases the lease for the next queued op (one failure never wedges the queue)', async () => {
    const mutex = new GitOpMutex(new ManualClock());
    const p1 = mutex.runExclusive('/repo', 'other', {}, async () => {
      throw new Error('boom');
    });
    const p2 = mutex.runExclusive('/repo', 'other', {}, async () => 'ok');

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });

  it('ops on different repos run fully concurrently (never queue behind each other)', async () => {
    const mutex = new GitOpMutex(new ManualClock());
    const order: string[] = [];
    const gateA = deferred();

    const pA = mutex.runExclusive('/repoA', 'other', {}, async () => {
      order.push('A-start');
      await gateA.promise;
      order.push('A-end');
    });
    const pB = mutex.runExclusive('/repoB', 'other', {}, async () => {
      order.push('B-start');
      order.push('B-end');
    });

    // repoB has nothing to queue behind — it must complete without ever
    // waiting on repoA's still-open gate.
    await pB;
    expect(order).toEqual(['A-start', 'B-start', 'B-end']);

    gateA.resolve();
    await pA;
    expect(order).toEqual(['A-start', 'B-start', 'B-end', 'A-end']);
  });

  it('currentLease reflects the in-flight op with its metadata, and clears the instant it completes', async () => {
    const mutex = new GitOpMutex(new ManualClock('2026-07-18T00:00:00.000Z'));
    const gate = deferred();
    const asg = assignmentId('asg_1');

    expect(mutex.currentLease('/repo')).toBeUndefined();

    const p = mutex.runExclusive(
      '/repo',
      'worktree_add',
      { assignmentId: asg, worktreePath: '/repo.worktrees/a' },
      async () => {
        await gate.promise;
      },
    );

    await flushMicrotasks();
    const lease = mutex.currentLease('/repo');
    expect(lease?.op).toBe('worktree_add');
    expect(lease?.assignmentId).toBe(asg);
    expect(lease?.worktreePath).toBe('/repo.worktrees/a');
    expect(lease?.startedAt).toBe('2026-07-18T00:00:00.000Z');
    expect(lease?.repoRoot).toBe('/repo');

    gate.resolve();
    await p;
    expect(mutex.currentLease('/repo')).toBeUndefined();
  });

  it('awaitIdle resolves "idle" immediately when nothing is in flight for that repo', async () => {
    const mutex = new GitOpMutex(new ManualClock());
    await expect(mutex.awaitIdle('/repo', 1000)).resolves.toBe('idle');
    // A different repo being busy must not affect this one.
    const gate = deferred();
    void mutex.runExclusive('/other-repo', 'other', {}, () => gate.promise);
    await flushMicrotasks();
    await expect(mutex.awaitIdle('/repo', 1000)).resolves.toBe('idle');
    gate.resolve();
  });

  it('awaitIdle resolves "idle" the moment the in-flight op completes, well before a generous deadline', async () => {
    const mutex = new GitOpMutex(new ManualClock());
    const gate = deferred();
    const p = mutex.runExclusive('/repo', 'other', {}, async () => {
      await gate.promise;
    });
    await flushMicrotasks();

    const idlePromise = mutex.awaitIdle('/repo', 500);
    gate.resolve();
    await expect(idlePromise).resolves.toBe('idle');
    await p;
  });

  it('awaitIdle resolves "timed_out" when the in-flight op outlives the deadline (§14 kill-path)', async () => {
    const mutex = new GitOpMutex(new ManualClock());
    const gate = deferred();
    const p = mutex.runExclusive('/repo', 'other', {}, async () => {
      await gate.promise;
    });
    await flushMicrotasks();

    await expect(mutex.awaitIdle('/repo', 40)).resolves.toBe('timed_out');
    gate.resolve();
    await p;
  });
});
