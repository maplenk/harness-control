/**
 * Cross-process advisory git-op lease (PLAN.md §16.2 + §14 identity) — W3-5.
 *
 * `mutex.ts`'s `GitOpMutex` serializes `git worktree add/remove` WITHIN one
 * orchestrator process; it cannot see a SECOND OS process (a concurrent
 * `harness` CLI invocation) driving the SAME repo. Two such processes running
 * `git worktree add/remove` on one repo concurrently corrupt
 * `.git/worktrees` — exactly the hazard §16.2 names. This is the cross-process
 * complement: a file-based advisory lease whose atomic gate is an
 * `mkdir(lockDir)` (POSIX-atomic — succeeds for exactly one racer, `EEXIST`
 * for the rest) placed UNDER the primary repo's `.git`, so it is repo-scoped,
 * git-ignored, and never touches the working tree.
 *
 * Stale-lease reclamation is §14 identity, applied to the ORCHESTRATOR
 * process that holds the lease (not a spawned child): the holder stamps its
 * own {pid, start-time} into the lock. A would-be acquirer that finds the lock
 * held re-verifies that identity — a pid that is GONE, or a pid that resolves
 * to a DIFFERENT start-time (an unrelated process that recycled the pid), is a
 * dead holder whose lease is reclaimed (the whole point of §14: a stale pid
 * NEVER blocks a live one, and is NEVER mistaken for its recycler). A holder
 * that is genuinely still alive is waited on (poll) up to `acquireTimeoutMs`.
 * A HOLDERLESS orphan (the lock dir exists but its identity file is
 * missing/unreadable/malformed — a process that crashed in the tiny
 * mkdir→stamp window, or left a corrupt file) is likewise reclaimed rather
 * than deadlocked (W3-5(d)): after a bounded grace that a live mid-stamp
 * acquirer beats, but a crash orphan never satisfies.
 *
 * This is deliberately ADVISORY (cooperative): only participants that go
 * through this lease honor it. The harness owns every worktree op, so that is
 * sufficient — and it composes with, never replaces, the in-process mutex
 * (`manager.ts` holds both: mutex first, then this).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPsClient, type PsClient } from '../supervisor/ps.js';
import type { Clock } from '../lib/clock.js';

/** §14 identity of the process holding the lease — compared for exact equality. */
export interface LockIdentity {
  readonly pid: number;
  /** Opaque `ps lstart` token (§14 start-time); absent only when unreadable at stamp time. */
  readonly startedAt?: string;
  /** When the lock was acquired (diagnostics only — never part of the identity compare). */
  readonly acquiredAt?: string;
}

/**
 * The §14 liveness/identity probe the lease consults: who am I, and is a
 * recorded holder still the SAME live process? Injectable so tests can script
 * a dead/recycled holder deterministically without racing real pids.
 */
export interface LeaseIdentityProbe {
  /** This process's own current §14 identity, to stamp into a lock we take. */
  self(): LockIdentity;
  /**
   * Is `holder` still the exact live process it claims to be? `false` for a
   * gone pid OR a pid whose start-time no longer matches (recycled) — either
   * way the lease is reclaimable. A missing `startedAt` on the holder degrades
   * to a bare liveness probe (best-effort; still never kills, only reclaims).
   */
  isHolderLive(holder: LockIdentity): boolean;
}

/** Default probe backed by the real `ps` identity surface (§14). */
export function createPsLeaseProbe(ps: PsClient, pid: number = process.pid): LeaseIdentityProbe {
  return {
    self(): LockIdentity {
      const sample = ps.sampleIdentity(pid);
      return sample !== undefined ? { pid, startedAt: sample.startedAt } : { pid };
    },
    isHolderLive(holder: LockIdentity): boolean {
      if (!ps.isAlive(holder.pid)) return false;
      // §14: a live pid with a DIFFERENT start-time is a recycled identifier —
      // an unrelated process, not our holder — so the lease is stale.
      if (holder.startedAt === undefined) return true;
      const sample = ps.sampleIdentity(holder.pid);
      if (sample === undefined) return false;
      return sample.startedAt === holder.startedAt;
    },
  };
}

export class AdvisoryGitLeaseTimeoutError extends Error {
  readonly lockDir: string;
  constructor(lockDir: string, timeoutMs: number) {
    super(`advisory git-op lease: timed out after ${timeoutMs}ms waiting for ${lockDir}`);
    this.name = 'AdvisoryGitLeaseTimeoutError';
    this.lockDir = lockDir;
  }
}

export interface AdvisoryGitLeaseOptions {
  /** The directory whose atomic creation IS the lock (placed under `.git`). */
  readonly lockDir: string;
  readonly probe: LeaseIdentityProbe;
  /** How long to wait for a live holder before giving up (default 30s). */
  readonly acquireTimeoutMs?: number;
  /** Poll cadence while waiting on a live holder (default 25ms). */
  readonly pollIntervalMs?: number;
  /**
   * W3-5(d): grace before a HOLDERLESS lock (dir present, identity file
   * missing/unreadable/malformed) is reclaimed. It absorbs the tiny window
   * where a live acquirer has `mkdir`'d the lock but not yet written its
   * identity; a lock that stays holderless past the grace is a crash orphan
   * and is reclaimed rather than deadlocking. Default 1s.
   */
  readonly holderlessGraceMs?: number;
  /** Injectable sleep + wall-clock for deterministic tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

const DEFAULT_ACQUIRE_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 25;
const DEFAULT_HOLDERLESS_GRACE_MS = 1_000;
const HOLDER_FILE = 'holder.json';

/**
 * A repo-scoped advisory lease around a single git-op critical section. One
 * lease instance serializes its own `withLease` calls trivially (the in-process
 * mutex already does that); its REAL job is serializing against a DIFFERENT OS
 * process that opened its own lease on the same `lockDir`.
 */
export class AdvisoryGitLease {
  readonly #lockDir: string;
  readonly #holderPath: string;
  readonly #probe: LeaseIdentityProbe;
  readonly #acquireTimeoutMs: number;
  readonly #pollIntervalMs: number;
  readonly #holderlessGraceMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  #held = false;

  constructor(options: AdvisoryGitLeaseOptions) {
    this.#lockDir = options.lockDir;
    this.#holderPath = path.join(options.lockDir, HOLDER_FILE);
    this.#probe = options.probe;
    this.#acquireTimeoutMs = options.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#holderlessGraceMs = options.holderlessGraceMs ?? DEFAULT_HOLDERLESS_GRACE_MS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))));
    this.#now = options.now ?? (() => Date.now());
  }

  get lockDir(): string {
    return this.#lockDir;
  }

  /** Run `fn` while holding the cross-process lease; always released after. */
  async withLease<T>(fn: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await fn();
    } finally {
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    const deadline = this.#now() + this.#acquireTimeoutMs;
    // W3-5(d): when we first observed the lock HOLDERLESS (dir present, no
    // readable identity). Reset whenever a real identity appears or we take
    // the lock — the grace is measured from OUR first holderless sighting.
    let holderlessSince: number | undefined;
    for (;;) {
      if (this.#tryTake()) return;
      const holder = this.#readHolder();
      if (holder !== undefined) {
        // A real identity is present: the §14 stale-lease path. Reclaim iff
        // the recorded holder is dead/recycled; otherwise wait and re-poll.
        holderlessSince = undefined;
        if (!this.#probe.isHolderLive(holder)) {
          this.#reclaim();
          if (this.#tryTake()) return;
        }
      } else {
        // W3-5(d): HOLDERLESS orphan — the lock dir exists but carries no
        // valid holder identity (missing / unreadable / malformed). This is
        // EITHER a live acquirer in the tiny mkdir→write window (the grace
        // lets it finish) OR a process that crashed there / left a corrupt
        // file (a permanent deadlock unless we reclaim it). Reclaim once the
        // lock has stayed holderless past the bounded grace — never before,
        // so a healthy holder mid-stamp is never falsely reclaimed.
        if (holderlessSince === undefined) holderlessSince = this.#now();
        if (this.#now() - holderlessSince >= this.#holderlessGraceMs) {
          this.#reclaim();
          holderlessSince = undefined;
          if (this.#tryTake()) return;
        }
      }
      if (this.#now() >= deadline) {
        throw new AdvisoryGitLeaseTimeoutError(this.#lockDir, this.#acquireTimeoutMs);
      }
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  /** Atomically claim the lock via `mkdir` (fails `EEXIST` if already held). */
  #tryTake(): boolean {
    fs.mkdirSync(path.dirname(this.#lockDir), { recursive: true });
    try {
      fs.mkdirSync(this.#lockDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
    const self = this.#probe.self();
    const identity: LockIdentity = { ...self, acquiredAt: new Date(this.#now()).toISOString() };
    fs.writeFileSync(this.#holderPath, JSON.stringify(identity), 'utf8');
    this.#held = true;
    return true;
  }

  /**
   * The recorded holder identity, or `undefined` when the lock exists but its
   * holder file is missing/unreadable/corrupt. `undefined` means HOLDERLESS:
   * the caller (`#acquire`) reclaims it only after the bounded holderless
   * grace (W3-5(d)) — long enough that a live acquirer that took the dir but
   * has not yet stamped its identity finishes first, short enough that a crash
   * orphan (the file never appears, or is permanently corrupt) can never
   * deadlock the lock.
   */
  #readHolder(): LockIdentity | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.#holderPath, 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as LockIdentity;
      if (typeof parsed?.pid !== 'number') return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  #reclaim(): void {
    fs.rmSync(this.#lockDir, { recursive: true, force: true });
  }

  #release(): void {
    if (!this.#held) return;
    this.#held = false;
    fs.rmSync(this.#lockDir, { recursive: true, force: true });
  }
}

/**
 * Convenience constructor for the production path: a lease under `gitDir`
 * backed by the real `ps` §14 identity probe. `gitDir` is the primary repo's
 * absolute `.git` directory (`git rev-parse --absolute-git-dir`).
 */
export function openAdvisoryGitLease(
  gitDir: string,
  clock: Clock,
  overrides: Partial<Omit<AdvisoryGitLeaseOptions, 'lockDir' | 'probe'>> = {},
): AdvisoryGitLease {
  return new AdvisoryGitLease({
    lockDir: path.join(gitDir, ADVISORY_LOCK_DIRNAME),
    probe: createPsLeaseProbe(createPsClient(clock)),
    ...overrides,
  });
}

/** Lock dir name placed directly under `.git` (git ignores everything there). */
export const ADVISORY_LOCK_DIRNAME = 'harness-orchestration-worktree-op.lock';
