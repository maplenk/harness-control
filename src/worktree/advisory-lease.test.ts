/**
 * W3-5 cross-process advisory git-op lease (PLAN §16.2 + §14 identity).
 *
 * Two OS processes driving `git worktree add/remove` on ONE repo corrupt
 * `.git/worktrees`; the in-process `GitOpMutex` cannot see a second process.
 * This suite proves the file-based advisory lease closes that gap:
 *  1. two leases on the SAME lock dir serialize (never overlap);
 *  2. a lease held by a DEAD/recycled pid (§14) is reclaimed, not waited on;
 *  3. two real `GitWorktreeManager`s on one repo serialize their worktree ops.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { assignmentId, gitSha } from '../domain/ids.js';
import {
  AdvisoryGitLease,
  AdvisoryGitLeaseTimeoutError,
  type LeaseIdentityProbe,
  type LockIdentity,
} from './advisory-lease.js';
import { GitWorktreeManager } from './manager.js';
import { makeTempGitRepo, snapshotPrimaryCheckout, assertPrimaryCheckoutUntouched } from './test-support.js';

const clock = new ManualClock('2026-07-19T10:00:00.000Z');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** A probe whose holder is always alive (never reclaimable). */
function liveProbe(pid = 4242): LeaseIdentityProbe {
  return {
    self: (): LockIdentity => ({ pid, startedAt: `lstart-${pid}` }),
    isHolderLive: () => true,
  };
}

async function tempLockRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'w3-5-lease-'));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

describe('AdvisoryGitLease — cross-process serialization (§16.2)', () => {
  it('two leases on the same lock dir never hold the critical section at the same time', async () => {
    const root = await tempLockRoot();
    const lockDir = path.join(root, 'op.lock');
    const opts = { lockDir, probe: liveProbe(), acquireTimeoutMs: 5_000, pollIntervalMs: 2, sleep };
    const a = new AdvisoryGitLease(opts);
    const b = new AdvisoryGitLease(opts);

    let inside = 0;
    let maxInside = 0;
    const order: string[] = [];
    async function critical(tag: string): Promise<void> {
      inside += 1;
      maxInside = Math.max(maxInside, inside);
      order.push(`enter-${tag}`);
      await sleep(30);
      order.push(`exit-${tag}`);
      inside -= 1;
    }

    await Promise.all([a.withLease(() => critical('a')), b.withLease(() => critical('b'))]);

    expect(maxInside).toBe(1); // never overlapped
    // Whichever won, the loser's enter comes strictly AFTER the winner's exit.
    expect(order).toHaveLength(4);
    expect(order[1]).toMatch(/^exit-/);
    expect(order[2]).toMatch(/^enter-/);
  });

  it('releases the lock dir after the critical section so a later acquire succeeds immediately', async () => {
    const root = await tempLockRoot();
    const lockDir = path.join(root, 'op.lock');
    const lease = new AdvisoryGitLease({ lockDir, probe: liveProbe(), sleep });
    await lease.withLease(async () => {
      expect(existsSync(lockDir)).toBe(true);
    });
    expect(existsSync(lockDir)).toBe(false);
    // Re-acquire with no waiting.
    await lease.withLease(async () => undefined);
    expect(existsSync(lockDir)).toBe(false);
  });
});

describe('AdvisoryGitLease — §14 stale-lease reclamation', () => {
  it('reclaims a lock held by a DEAD pid rather than blocking on it', async () => {
    const root = await tempLockRoot();
    const lockDir = path.join(root, 'op.lock');
    // Pre-plant a held lock owned by a dead process (as if a crashed peer).
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, 'holder.json'),
      JSON.stringify({ pid: 999_999, startedAt: 'lstart-dead' } satisfies LockIdentity),
      'utf8',
    );

    const deadPidProbe: LeaseIdentityProbe = {
      self: () => ({ pid: 1234, startedAt: 'lstart-1234' }),
      isHolderLive: (holder) => holder.pid !== 999_999, // 999_999 is dead
    };
    const lease = new AdvisoryGitLease({
      lockDir,
      probe: deadPidProbe,
      acquireTimeoutMs: 1_000,
      pollIntervalMs: 2,
      sleep,
    });

    // Must acquire by RECLAIMING the stale lock (not time out waiting on it).
    let acquired = false;
    await lease.withLease(async () => {
      acquired = true;
    });
    expect(acquired).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('reclaims a lock whose pid was RECYCLED (alive but different start-time — §14)', async () => {
    const root = await tempLockRoot();
    const lockDir = path.join(root, 'op.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, 'holder.json'),
      JSON.stringify({ pid: 777, startedAt: 'ORIGINAL-start' } satisfies LockIdentity),
      'utf8',
    );
    // pid 777 is alive now but reports a DIFFERENT start-time → recycled → stale.
    const recycledProbe: LeaseIdentityProbe = {
      self: () => ({ pid: 777, startedAt: 'NEW-start' }),
      isHolderLive: (holder) => holder.startedAt === 'NEW-start',
    };
    const lease = new AdvisoryGitLease({ lockDir, probe: recycledProbe, acquireTimeoutMs: 1_000, pollIntervalMs: 2, sleep });
    let acquired = false;
    await lease.withLease(async () => {
      acquired = true;
    });
    expect(acquired).toBe(true);
  });

  it('W3-5(d): reclaims a HOLDERLESS orphan (lock dir exists, identity file MISSING) rather than deadlocking', async () => {
    const root = await tempLockRoot();
    const lockDir = path.join(root, 'op.lock');
    // A crash in the mkdir→stamp window: the lock dir exists but no holder.json.
    mkdirSync(lockDir, { recursive: true });
    const lease = new AdvisoryGitLease({
      lockDir,
      probe: liveProbe(),
      acquireTimeoutMs: 2_000,
      pollIntervalMs: 2,
      holderlessGraceMs: 10,
      sleep,
    });
    // Must acquire by reclaiming the holderless orphan, not time out on it.
    let acquired = false;
    await lease.withLease(async () => {
      acquired = true;
    });
    expect(acquired).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('W3-5(d): reclaims a lock whose identity file is MALFORMED (unparseable / no pid) after the grace', async () => {
    const root = await tempLockRoot();
    const lockDir = path.join(root, 'op.lock');
    mkdirSync(lockDir, { recursive: true });
    // Corrupt identity file: not valid JSON at all → no valid holder.
    writeFileSync(path.join(lockDir, 'holder.json'), '{ this is not: json', 'utf8');
    const lease = new AdvisoryGitLease({
      lockDir,
      probe: liveProbe(),
      acquireTimeoutMs: 2_000,
      pollIntervalMs: 2,
      holderlessGraceMs: 10,
      sleep,
    });
    let acquired = false;
    await lease.withLease(async () => {
      acquired = true;
    });
    expect(acquired).toBe(true);
    expect(existsSync(lockDir)).toBe(false);
  });

  it('W3-5(d): does NOT reclaim a holderless orphan BEFORE the grace elapses (no false-positive on a mid-stamp acquirer)', async () => {
    const root = await tempLockRoot();
    const lockDir = path.join(root, 'op.lock');
    mkdirSync(lockDir, { recursive: true });
    // Grace far exceeds the acquire timeout → the orphan is still within its
    // grace when we give up, so it is left untouched (proving reclamation is
    // gated on the grace, not immediate — a live mid-stamp holder is safe).
    const lease = new AdvisoryGitLease({
      lockDir,
      probe: liveProbe(),
      acquireTimeoutMs: 40,
      pollIntervalMs: 5,
      holderlessGraceMs: 10_000,
      sleep,
    });
    await expect(lease.withLease(async () => undefined)).rejects.toBeInstanceOf(AdvisoryGitLeaseTimeoutError);
    expect(existsSync(lockDir)).toBe(true); // not reclaimed within the grace
  });

  it('does NOT reclaim a lock held by a genuinely-live holder — it waits, then times out', async () => {
    const root = await tempLockRoot();
    const lockDir = path.join(root, 'op.lock');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      path.join(lockDir, 'holder.json'),
      JSON.stringify({ pid: 555, startedAt: 'live' } satisfies LockIdentity),
      'utf8',
    );
    const lease = new AdvisoryGitLease({ lockDir, probe: liveProbe(555), acquireTimeoutMs: 60, pollIntervalMs: 5, sleep });
    await expect(lease.withLease(async () => undefined)).rejects.toBeInstanceOf(AdvisoryGitLeaseTimeoutError);
    // The live holder's lock is untouched.
    expect(existsSync(lockDir)).toBe(true);
  });
});

describe('W3-5 — two GitWorktreeManagers on one repo serialize worktree ops', () => {
  it(
    'concurrent createWorktree from two managers (separate in-process mutexes, shared .git lock) never overlap and both succeed',
    async () => {
      const repo = await makeTempGitRepo('w3-5-two-managers-');
      cleanups.push(() => repo.cleanup());
      const before = await snapshotPrimaryCheckout(repo.dir);

      // Two SEPARATE advisory leases over the SAME lock dir = two "processes".
      const lockDir = path.join(repo.dir, '.git', 'harness-orchestration-worktree-op.lock');
      let inside = 0;
      let maxInside = 0;
      const wrap = (lease: AdvisoryGitLease): AdvisoryGitLease =>
        new Proxy(lease, {
          get(target, prop, receiver) {
            if (prop === 'withLease') {
              return async <T>(fn: () => Promise<T>): Promise<T> =>
                target.withLease(async () => {
                  inside += 1;
                  maxInside = Math.max(maxInside, inside);
                  try {
                    return await fn();
                  } finally {
                    inside -= 1;
                  }
                });
            }
            return Reflect.get(target, prop, receiver);
          },
        });
      const leaseOpts = { lockDir, probe: liveProbe(), acquireTimeoutMs: 10_000, pollIntervalMs: 2, sleep };
      const leaseA = wrap(new AdvisoryGitLease(leaseOpts));
      const leaseB = wrap(new AdvisoryGitLease(leaseOpts));

      const managerA = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock, advisoryLease: leaseA });
      const managerB = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock, advisoryLease: leaseB });
      const asgA = assignmentId('asg_two_mgr_a');
      const asgB = assignmentId('asg_two_mgr_b');
      const baseCommit = gitSha(await repo.headSha());
      cleanups.push(async () => {
        await managerA.removeWorktree(asgA).catch(() => undefined);
        await managerB.removeWorktree(asgB).catch(() => undefined);
      });

      const [handleA, handleB] = await Promise.all([
        managerA.createWorktree({ assignmentId: asgA, baseCommit }),
        managerB.createWorktree({ assignmentId: asgB, baseCommit }),
      ]);

      expect(handleA.leased).toBe(true);
      expect(handleB.leased).toBe(true);
      expect(handleA.worktreePath).not.toBe(handleB.worktreePath);
      expect(maxInside).toBe(1); // the two managers never ran their git op concurrently
      expect(existsSync(handleA.worktreePath)).toBe(true);
      expect(existsSync(handleB.worktreePath)).toBe(true);
      // §16 item 2 / §19 test 17: primary checkout untouched by either op.
      await assertPrimaryCheckoutUntouched(repo.dir, before);
    },
    30_000,
  );
});
