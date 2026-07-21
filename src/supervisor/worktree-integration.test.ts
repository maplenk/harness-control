/**
 * Supervisor ↔ worktree integration seam (PLAN §14/§16.2/§16.3).
 *
 * `watchdog.ts` consumes the git-op lease + taint surface through minimal
 * STRUCTURAL interfaces (`GitOpLeaseObserver`/`WorktreeTaintSink`) that were
 * built concurrently with `../worktree/manager.ts`'s `GitWorktreeManager`.
 * This suite is the cross-package proof the two really meet:
 *
 *  1. COMPILE-TIME: a real `GitWorktreeManager` instance satisfies both
 *     structural interfaces with zero adapter code (the assignments below
 *     fail `npm run typecheck` if either side drifts).
 *  2. RUNTIME: a watchdog emergency kill wired to a REAL manager (real temp
 *     git repo, real worktree) taints the assignment's worktree, which then
 *     refuses lease reacquisition until `validate()` — the §16.3 gate.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { assignmentId, gitSha, processGenerationId, runId } from '../domain/ids.js';
import type { DomainEvent } from '../domain/events.js';
import { GitWorktreeManager, WorktreeError } from '../worktree/index.js';
import { makeTempGitRepo, type TempGitRepo } from '../worktree/test-support.js';
import type { ProcessTreeSample, PsClient } from './ps.js';
import type { VerifiedSignaler } from './registry.js';
import { Watchdog, type GitOpLeaseObserver, type WorktreeTaintSink } from './watchdog.js';

const GENEROUS_MS = 30_000;
const clock = new ManualClock('2026-07-18T10:00:00.000Z');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Deterministic ps stub: a live one-process tree at a scripted RSS. */
function stubPs(rssBytes: number): PsClient {
  const sample = (pgid: number): ProcessTreeSample => ({
    pgid,
    rssBytes,
    processCount: 1,
    pids: [pgid],
    sampledAt: clock.nowIso(),
  });
  return {
    sampleProcessTree: (pgid) => sample(pgid),
    sampleIdentity: () => undefined,
    isAlive: () => true,
  };
}

/** VerifiedSignaler stub that always identity-matches (records the calls). */
function stubSignaler(): { signaler: VerifiedSignaler; readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    signaler: {
      signalVerified: (generationId, signal, options) => {
        calls.push(`${String(generationId)}:${signal}`);
        options?.beforeSignal?.();
        return {
          verdict: 'match',
          observed: { pid: 12345, ppid: 1, pgid: 12345, startedAt: 'x', executablePath: 'node' },
        };
      },
    },
  };
}

describe('GitWorktreeManager satisfies the watchdog structural interfaces (§14/§16.2)', () => {
  it(
    'compile-time + runtime: awaitGitOpIdle answers idle when no git op holds the lease',
    async () => {
      const repo: TempGitRepo = await makeTempGitRepo('harness-sup-wt-');
      cleanups.push(() => repo.cleanup());
      const manager = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock });

      // COMPILE-TIME seam proof: structural satisfaction with zero adapters.
      const leaseObserver: GitOpLeaseObserver = manager;
      const taintSink: WorktreeTaintSink = manager;

      expect(manager.currentGitOpLease()).toBeUndefined();
      await expect(leaseObserver.awaitGitOpIdle(50)).resolves.toBe('idle');
      // And the sink really is the manager's own taint bookkeeping:
      const asg = assignmentId('asg_seam_check');
      taintSink.markTainted(asg, 'emergency_kill');
      expect(manager.isTainted(asg)).toBe(true);
    },
    GENEROUS_MS,
  );

  it(
    'a watchdog emergency kill taints the REAL worktree, which then refuses its lease until validate()',
    async () => {
      const repo = await makeTempGitRepo('harness-sup-wt-kill-');
      cleanups.push(() => repo.cleanup());
      const manager = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock });
      const asg = assignmentId('asg_watchdog_kill');
      const handle = await manager.createWorktree({ assignmentId: asg, baseCommit: gitSha(await repo.headSha()) });
      cleanups.push(async () => {
        await manager.removeWorktree(asg).catch(() => undefined);
      });
      expect(handle.leased).toBe(true);

      const events: DomainEvent[] = [];
      const { signaler, calls } = stubSignaler();
      // RSS scripted ABOVE the default hard ceiling (1024MB budget × 150%).
      const watchdog = new Watchdog({
        clock,
        ids: new DeterministicIdFactory(),
        registry: signaler,
        ps: stubPs(4 * 1024 * 1024 * 1024),
        gitOpLease: manager, // the real §16.2 lease surface
        worktreeTaint: manager, // the real §16.3 taint sink
        onEvent: (event) => events.push(event),
      });
      cleanups.push(async () => watchdog.stopAll());

      const generation = processGenerationId('pgen_watchdog_kill');
      watchdog.watch({
        runId: runId('run_watchdog_kill'),
        generationId: generation,
        pgid: 12345,
        assignmentId: asg,
      });
      await watchdog.sampleOnce(generation);

      // Emergency path ran: identity-verified SIGKILL + rss.hard_limit event.
      expect(calls).toEqual([`${String(generation)}:SIGKILL`]);
      expect(
        events.some(
          (event) =>
            event.type === 'rss.hard_limit' &&
            (event.payload as { escalation?: string }).escalation === 'emergency_kill',
        ),
      ).toBe(true);

      // §16.3 gate, on the REAL manager: tainted → reacquire refused.
      expect(manager.isTainted(asg)).toBe(true);
      expect(manager.taintsFor(asg)).toEqual(['emergency_kill']);
      manager.releaseLease(asg);
      expect(() => manager.reacquireLease(asg)).toThrowError(WorktreeError);
      try {
        manager.reacquireLease(asg);
      } catch (error) {
        expect((error as WorktreeError).kind).toBe('requires_validation');
      }

      // validate() reconciles (fresh worktree, clean tree → 'clean'),
      // clearing the taint; the lease can then be reacquired.
      const validation = await manager.validate(asg);
      expect(validation.outcome).toBe('clean');
      expect(manager.isTainted(asg)).toBe(false);
      const reacquired = manager.reacquireLease(asg);
      expect(reacquired.leased).toBe(true);
    },
    GENEROUS_MS,
  );
});
