/**
 * Per-repo git-operation mutex + observable "lease" (PLAN.md §16.2, §14).
 *
 * §16.2: "all `git worktree add/remove` serialized per repo (concurrent ops
 * corrupt `.git/worktrees`)." The orchestrator is a single in-process Node
 * event loop (§5: "internal event bus... in-process; no network server");
 * concurrency here means overlapping ASYNC calls within that one process
 * (e.g. two assignments' pause/resume paths racing each other), not
 * multiple OS processes — so an in-process promise-chain mutex, keyed by
 * the resolved primary repo root, is the correct and sufficient primitive.
 * `manager.ts` also routes `validate()`'s git plumbing (§16.3) through the
 * SAME mutex, since its `index.lock` cleanup step is only safe to perform
 * "within the mutex" (see `validate.ts`'s doc comment for why).
 *
 * §14: "the supervisor's kill path respects git-op leases... while a
 * segment holds a git-op lease, kill waits for op completion or the
 * emergency ceiling (which taints)." `currentLease` + `awaitIdle` are that
 * consumption surface: the supervisor never acquires this mutex itself (it
 * has no git op of its own to run) — it only OBSERVES whether one is in
 * flight for the repo it is about to act on, and races the observed op's
 * completion against its own emergency deadline (§14's default 30s
 * graceful-stop deadline, or the RSS hard-limit path's kill decision).
 */
import type { AssignmentId } from '../domain/ids.js';
import type { GitOpKind } from '../domain/state.js';
import type { Clock, IsoTimestamp } from '../lib/clock.js';

export interface GitOpLeaseSnapshot {
  readonly repoRoot: string;
  readonly op: GitOpKind;
  readonly worktreePath?: string;
  readonly assignmentId?: AssignmentId;
  readonly startedAt: IsoTimestamp;
}

export type AwaitIdleOutcome = 'idle' | 'timed_out';

export interface GitOpMeta {
  readonly assignmentId?: AssignmentId;
  readonly worktreePath?: string;
}

interface Waiter {
  readonly resolve: (outcome: AwaitIdleOutcome) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

/** Never rejects — used to chain the per-repo tail without ever poisoning the queue for later callers (see `runExclusive`). */
function settleQuietly(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

export class GitOpMutex {
  readonly #clock: Clock;
  readonly #tailByRepo = new Map<string, Promise<void>>();
  readonly #current = new Map<string, GitOpLeaseSnapshot>();
  readonly #idleWaiters = new Map<string, Set<Waiter>>();

  constructor(clock: Clock) {
    this.#clock = clock;
  }

  /**
   * Runs `fn` with exclusive access for `repoRoot`: queued behind any
   * currently-running or already-queued op for the SAME repo root, but
   * fully concurrent with ops on a DIFFERENT repo root. Ops for one repo
   * are served strictly FIFO in the order `runExclusive` was CALLED (a
   * consequence of there being no `await` before this method registers
   * itself in the queue — two calls made back-to-back, e.g. from
   * `Array.prototype.map`, enqueue in that exact order with no possible
   * interleaving, since JS is single-threaded and neither call yields to
   * the event loop before it has already taken its place in line).
   *
   * A failing `fn` (rejects) still releases the lease for the NEXT queued
   * op — one op's failure never wedges the queue — while the ORIGINAL
   * caller of the failing op still observes the real rejection.
   */
  runExclusive<T>(repoRoot: string, op: GitOpKind, meta: GitOpMeta, fn: () => Promise<T>): Promise<T> {
    const priorTail = this.#tailByRepo.get(repoRoot) ?? Promise.resolve();

    const ourTurn: Promise<T> = settleQuietly(priorTail).then(async () => {
      this.#current.set(repoRoot, {
        repoRoot,
        op,
        startedAt: this.#clock.nowIso(),
        ...(meta.assignmentId !== undefined ? { assignmentId: meta.assignmentId } : {}),
        ...(meta.worktreePath !== undefined ? { worktreePath: meta.worktreePath } : {}),
      });
      try {
        return await fn();
      } finally {
        this.#current.delete(repoRoot);
        this.#notifyIdle(repoRoot);
      }
    });

    // What the NEXT caller queues behind: settles once WE settle, but never
    // itself rejects, so our failure can't cascade into the next op never
    // getting its turn.
    this.#tailByRepo.set(repoRoot, settleQuietly(ourTurn));

    return ourTurn;
  }

  /** The op currently holding the lease for `repoRoot`, if any (§14 kill-path observability). */
  currentLease(repoRoot: string): GitOpLeaseSnapshot | undefined {
    return this.#current.get(repoRoot);
  }

  /**
   * Resolves `'idle'` immediately if no op is in flight for `repoRoot`;
   * otherwise resolves `'idle'` the moment the current op finishes, or
   * `'timed_out'` after `deadlineMs`, whichever comes first (§14: "kill
   * waits for op completion or the emergency ceiling"). Uses a REAL timer
   * deliberately: the deadline races an actual git subprocess, which runs
   * on wall-clock time regardless of any injected fake clock.
   */
  awaitIdle(repoRoot: string, deadlineMs: number): Promise<AwaitIdleOutcome> {
    if (!this.#current.has(repoRoot)) return Promise.resolve('idle');
    return new Promise<AwaitIdleOutcome>((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          this.#removeWaiter(repoRoot, waiter);
          resolve('timed_out');
        }, deadlineMs),
      };
      const set = this.#idleWaiters.get(repoRoot) ?? new Set<Waiter>();
      set.add(waiter);
      this.#idleWaiters.set(repoRoot, set);
    });
  }

  #removeWaiter(repoRoot: string, waiter: Waiter): void {
    const set = this.#idleWaiters.get(repoRoot);
    if (!set) return;
    set.delete(waiter);
    if (set.size === 0) this.#idleWaiters.delete(repoRoot);
  }

  #notifyIdle(repoRoot: string): void {
    const set = this.#idleWaiters.get(repoRoot);
    if (!set) return;
    this.#idleWaiters.delete(repoRoot);
    for (const waiter of set) {
      clearTimeout(waiter.timer);
      waiter.resolve('idle');
    }
  }
}
