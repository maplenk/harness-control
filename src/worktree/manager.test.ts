import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { assignmentId, artifactHash, gitSha, type AssignmentId } from '../domain/ids.js';
import type { WorktreeState } from '../domain/entities.js';
import { sha256Hex } from '../artifacts/hash.js';
import { GitWorktreeManager } from './manager.js';
import { WorktreeError, isWorktreeError, type WorktreeErrorKind } from './errors.js';
import { runGit } from './git.js';
import {
  DEFAULT_BASE_DIR_STRATEGY,
  branchNameFor,
  isPathInside,
  resolveBaseDir,
  worktreePathFor,
} from './paths.js';
import {
  assertPrimaryCheckoutUntouched,
  makeTempGitRepo,
  snapshotPrimaryCheckout,
  type TempGitRepo,
} from './test-support.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function expectRejectsWithKind(promise: Promise<unknown>, kind: WorktreeErrorKind): Promise<void> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(isWorktreeError(thrown)).toBe(true);
  expect((thrown as WorktreeError).kind).toBe(kind);
}

function expectThrowsWithKind(fn: () => unknown, kind: WorktreeErrorKind): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(isWorktreeError(thrown)).toBe(true);
  expect((thrown as WorktreeError).kind).toBe(kind);
}

/** Mirrors validate.ts's own plumbing exactly, so tests can build exact-matching or deliberately-mismatched checkpoint fixtures. */
async function captureWorktreeState(worktreePath: string): Promise<WorktreeState> {
  const head = (await runGit(['rev-parse', 'HEAD'], worktreePath)).stdout.trim();
  const status = (await runGit(['status', '--porcelain'], worktreePath)).stdout;
  const diff = (await runGit(['diff', 'HEAD'], worktreePath)).stdout;
  return {
    headSha: gitSha(head),
    statusPorcelain: status,
    diffHash: artifactHash(sha256Hex(diff)),
    lockfileCleanupPerformed: false,
    taintFlags: [],
  };
}

// ---------------------------------------------------------------------------
// paths.ts (pure — no I/O)
// ---------------------------------------------------------------------------
describe('paths (pure)', () => {
  it('resolveBaseDir: sibling strategy is a SIBLING of the repo root, never nested inside it', () => {
    const base = resolveBaseDir('/a/b/repo', { kind: 'sibling' });
    expect(base).toBe('/a/b/repo.worktrees');
    expect(isPathInside('/a/b/repo', base)).toBe(false);
  });

  it('resolveBaseDir: os_tmp strategy lands under the OS temp dir, outside the repo', () => {
    const base = resolveBaseDir('/a/b/repo', { kind: 'os_tmp' });
    expect(isPathInside('/a/b/repo', base)).toBe(false);
    expect(path.isAbsolute(base)).toBe(true);
  });

  it('resolveBaseDir: explicit strategy resolves the given dir as-is', () => {
    expect(resolveBaseDir('/a/b/repo', { kind: 'explicit', dir: '/custom/dir' })).toBe('/custom/dir');
  });

  it('DEFAULT_BASE_DIR_STRATEGY is sibling (PLAN §16 item 2 default)', () => {
    expect(DEFAULT_BASE_DIR_STRATEGY).toEqual({ kind: 'sibling' });
  });

  it('worktreePathFor / branchNameFor are deterministic and namespaced by assignment id', () => {
    const id = assignmentId('asg_007');
    expect(worktreePathFor('/base', id)).toBe(path.join('/base', 'assignment-asg_007'));
    expect(branchNameFor(id)).toBe('harness/assignment/asg_007');
  });

  it('isPathInside: true for self and descendants, false for siblings/ancestors', () => {
    expect(isPathInside('/a/b', '/a/b')).toBe(true);
    expect(isPathInside('/a/b', '/a/b/c')).toBe(true);
    expect(isPathInside('/a/b', '/a/bc')).toBe(false);
    expect(isPathInside('/a/b', '/a')).toBe(false);
    expect(isPathInside('/a/b', '/a/c')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared fixture: a real temp git repo + manager, torn down (repo AND the
// manager's sibling worktrees dir — the default strategy deliberately
// creates that OUTSIDE repo.dir, so `repo.cleanup()` alone would leak it)
// after every test.
// ---------------------------------------------------------------------------
async function withRepoAndManager(
  run: (repo: TempGitRepo, manager: GitWorktreeManager) => Promise<void>,
): Promise<void> {
  const repo = await makeTempGitRepo();
  const manager = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: new ManualClock('2026-07-18T00:00:00.000Z') });
  try {
    await run(repo, manager);
  } finally {
    await rm(manager.baseDir, { recursive: true, force: true });
    await repo.cleanup();
  }
}

async function createAtHead(
  repo: TempGitRepo,
  manager: GitWorktreeManager,
  assignmentIdValue: AssignmentId,
) {
  return manager.createWorktree({
    assignmentId: assignmentIdValue,
    baseCommit: gitSha(await repo.headSha()),
  });
}

describe('GitWorktreeManager.open (PLAN §16 item 1)', () => {
  it('rejects a directory that is not a git repository', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-not-a-repo-'));
    try {
      await expectRejectsWithKind(GitWorktreeManager.open({ primaryRepoRoot: dir, clock: new ManualClock() }), 'not_a_git_repo');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('canonicalizes the repo root via git rev-parse --show-toplevel', async () => {
    await withRepoAndManager(async (repo, manager) => {
      expect(manager.primaryRepoRoot).toBe((await runGit(['rev-parse', '--show-toplevel'], repo.dir)).stdout.trim());
    });
  });
});

describe('GitWorktreeManager.createWorktree (PLAN §16 items 1-3)', () => {
  it('resolves an immutable base SHA and creates a dedicated branch + worktree outside the primary checkout', async () => {
    await withRepoAndManager(async (repo, manager) => {
      const asg = assignmentId('asg_create');
      const before = await snapshotPrimaryCheckout(repo.dir);

      const handle = await createAtHead(repo, manager, asg);

      expect(handle.baseSha).toBe(await repo.headSha());
      expect(handle.branch).toBe('harness/assignment/asg_create');
      // NOTE: compared against manager.primaryRepoRoot (canonicalized via
      // `git rev-parse --show-toplevel`), not the raw `repo.dir` from
      // `mkdtemp` — on macOS `os.tmpdir()` resolves under `/var/folders/...`,
      // itself a symlink to `/private/var/folders/...`, and git reports the
      // REAL path.
      expect(handle.worktreePath).toBe(path.join(`${manager.primaryRepoRoot}.worktrees`, 'assignment-asg_create'));
      expect(handle.leased).toBe(true);
      expect(handle.createdAt).toBe('2026-07-18T00:00:00.000Z');
      expect(isPathInside(manager.primaryRepoRoot, handle.worktreePath)).toBe(false);
      expect(existsSync(handle.worktreePath)).toBe(true);
      expect(existsSync(path.join(handle.worktreePath, 'README.md'))).toBe(true);

      const checkedOutBranch = (await runGit(['rev-parse', '--abbrev-ref', 'HEAD'], handle.worktreePath)).stdout.trim();
      expect(checkedOutBranch).toBe('harness/assignment/asg_create');

      await assertPrimaryCheckoutUntouched(repo.dir, before);
    });
  });

  it('throws already_leased when creating twice for the same assignment', async () => {
    await withRepoAndManager(async (repo, manager) => {
      const asg = assignmentId('asg_dup');
      const baseCommit = gitSha(await repo.headSha());
      await manager.createWorktree({ assignmentId: asg, baseCommit });
      await expectRejectsWithKind(manager.createWorktree({ assignmentId: asg, baseCommit }), 'already_leased');
    });
  });

  it('branches from the exact pinned baseCommit, not live HEAD', async () => {
    await withRepoAndManager(async (repo, manager) => {
      const firstSha = await repo.headSha();
      await repo.writeFile('second.txt', 'more content\n');
      await repo.commitAll('second commit');

      const asg = assignmentId('asg_baseref');
      const handle = await manager.createWorktree({ assignmentId: asg, baseCommit: gitSha(firstSha) });
      expect(handle.baseSha).toBe(firstSha);
      expect(existsSync(path.join(handle.worktreePath, 'second.txt'))).toBe(false);
    });
  });

  it.each([
    ['missing', undefined],
    ['symbolic', 'HEAD'],
    ['short', 'deadbeef'],
    ['case-mismatched', 'A'.repeat(40)],
  ])('rejects a %s base even when the caller bypasses TypeScript', async (_label, supplied) => {
    await withRepoAndManager(async (_repo, manager) => {
      await expectRejectsWithKind(
        manager.createWorktree({
          assignmentId: assignmentId(`asg_invalid_${_label}`),
          baseCommit: supplied,
        } as never),
        'invalid_base_commit',
      );
    });
  });

  it('rejects a full SHA that does not resolve to a commit', async () => {
    await withRepoAndManager(async (_repo, manager) => {
      await expectRejectsWithKind(
        manager.createWorktree({
          assignmentId: assignmentId('asg_unresolvable_base'),
          baseCommit: gitSha('f'.repeat(40)),
        }),
        'git_command_failed',
      );
    });
  });
});

describe('GitWorktreeManager lease lifecycle', () => {
  it('releaseLease releases without deleting the worktree; reacquireLease grants it back', async () => {
    await withRepoAndManager(async (repo, manager) => {
      const asg = assignmentId('asg_lease');
      const created = await createAtHead(repo, manager, asg);
      expect(created.leased).toBe(true);

      manager.releaseLease(asg);
      expect(manager.handleFor(asg)?.leased).toBe(false);
      expect(existsSync(created.worktreePath)).toBe(true);

      manager.releaseLease(asg); // idempotent
      expect(manager.handleFor(asg)?.leased).toBe(false);

      const reacquired = manager.reacquireLease(asg);
      expect(reacquired.leased).toBe(true);
      expect(reacquired.worktreePath).toBe(created.worktreePath);

      expectThrowsWithKind(() => manager.reacquireLease(asg), 'already_leased');
    });
  });

  it('releaseLease / reacquireLease throw not_found for an untracked assignment', async () => {
    await withRepoAndManager(async (_repo, manager) => {
      const unknown = assignmentId('asg_ghost');
      expectThrowsWithKind(() => manager.releaseLease(unknown), 'not_found');
      expectThrowsWithKind(() => manager.reacquireLease(unknown), 'not_found');
    });
  });

  it('removeWorktree deletes the worktree, clears bookkeeping, and never touches the primary checkout', async () => {
    await withRepoAndManager(async (repo, manager) => {
      const asg = assignmentId('asg_remove');
      const handle = await createAtHead(repo, manager, asg);
      const before = await snapshotPrimaryCheckout(repo.dir);

      await manager.removeWorktree(asg);

      expect(existsSync(handle.worktreePath)).toBe(false);
      expect(manager.handleFor(asg)).toBeUndefined();
      await expectRejectsWithKind(manager.removeWorktree(asg), 'not_found');
      await assertPrimaryCheckoutUntouched(repo.dir, before);
    });
  });

  it('reattach re-registers a worktree from persisted data after a simulated process restart', async () => {
    await withRepoAndManager(async (repo, manager) => {
      const asg = assignmentId('asg_reattach');
      const created = await createAtHead(repo, manager, asg);

      // Simulate a fresh orchestrator process: a brand new manager instance
      // with empty in-memory bookkeeping, pointed at the SAME repo.
      const restarted = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: new ManualClock() });
      expect(restarted.handleFor(asg)).toBeUndefined();

      const reattached = await restarted.reattach({
        assignmentId: asg,
        worktreePath: created.worktreePath,
        branch: created.branch,
        baseSha: created.baseSha,
      });
      expect(reattached.worktreePath).toBe(created.worktreePath);
      expect(reattached.leased).toBe(true);

      await expectRejectsWithKind(
        restarted.reattach({
          assignmentId: asg,
          worktreePath: created.worktreePath,
          branch: created.branch,
          baseSha: created.baseSha,
        }),
        'already_leased',
      );
    });
  });

  it('reattach refuses a path that is not a registered worktree of this repo', async () => {
    await withRepoAndManager(async (repo, manager) => {
      await expectRejectsWithKind(
        manager.reattach({
          assignmentId: assignmentId('asg_bogus'),
          worktreePath: path.join(repo.dir, 'not-a-real-worktree'),
          branch: 'harness/assignment/asg_bogus',
          baseSha: gitSha(await repo.headSha()),
        }),
        'not_found',
      );
    });
  });

  it('reattach carrying prior taint flags refuses reuse until validated (§16.3)', async () => {
    await withRepoAndManager(async (repo, manager) => {
      const asg = assignmentId('asg_reattach_tainted');
      const created = await createAtHead(repo, manager, asg);
      manager.releaseLease(asg);

      const restarted = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: new ManualClock() });
      await expectRejectsWithKind(
        restarted.reattach({
          assignmentId: asg,
          worktreePath: created.worktreePath,
          branch: created.branch,
          baseSha: created.baseSha,
          taintFlags: ['emergency_kill'],
        }),
        'requires_validation',
      );
      expect(restarted.isTainted(asg)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// PLAN §16.2 / §19: "a mutex race test (parallel add/remove attempts
// serialize — use real temp git repos)".
// ---------------------------------------------------------------------------
describe('mutex race: parallel add/remove attempts serialize (real temp git repos)', () => {
  it('N concurrent createWorktree calls against the same repo all succeed and never overlap', async () => {
    await withRepoAndManager(async (repo, manager) => {
      const ids = Array.from({ length: 5 }, (_, i) => assignmentId(`asg_race_${i}`));

      let settled = false;
      const observed: string[] = []; // consecutive-deduped "currently active" assignment ids
      const poll = (async () => {
        while (!settled) {
          const lease = manager.currentGitOpLease();
          const idStr = lease?.assignmentId !== undefined ? String(lease.assignmentId) : undefined;
          if (idStr !== undefined && observed[observed.length - 1] !== idStr) observed.push(idStr);
          await sleep(1);
        }
      })();

      const before = await snapshotPrimaryCheckout(repo.dir);
      const baseCommit = gitSha(await repo.headSha());
      const handles = await Promise.all(ids.map((id) => manager.createWorktree({ assignmentId: id, baseCommit })));
      settled = true;
      await poll;

      // Outcome correctness (real git, no corruption): all 5 succeeded with
      // the right branch, and `git worktree list` agrees.
      expect(handles).toHaveLength(5);
      for (const [i, handle] of handles.entries()) {
        expect(handle.branch).toBe(`harness/assignment/asg_race_${i}`);
        expect(handle.baseSha).toBe(await repo.headSha());
      }
      const list = await repo.run(['worktree', 'list', '--porcelain']);
      for (const id of ids) {
        expect(list).toContain(`branch refs/heads/${branchNameFor(id)}`);
      }

      // Serialization evidence: the observed "currently active" sequence
      // must be a strictly order-preserving, non-repeating subsequence of
      // call order. Sampling gaps are fine (an op can finish between two
      // 1ms polls); an id appearing OUT of order, or reappearing after a
      // later one was already observed, would mean two ops' critical
      // sections overlapped — which the mutex must never allow.
      const callOrderIndex = new Map(ids.map((id, i) => [String(id), i]));
      let lastIndex = -1;
      for (const seen of observed) {
        const idx = callOrderIndex.get(seen);
        expect(idx).toBeDefined();
        expect(idx as number).toBeGreaterThan(lastIndex);
        lastIndex = idx as number;
      }
      expect(observed.length).toBeGreaterThan(0); // sanity: polling actually caught something

      await assertPrimaryCheckoutUntouched(repo.dir, before);
    });
  });

  it('mixed concurrent create + remove attempts against the same repo serialize and leave consistent state', async () => {
    await withRepoAndManager(async (repo, manager) => {
      const survivor0 = assignmentId('asg_survivor_0');
      const survivor1 = assignmentId('asg_survivor_1');
      const toRemove = assignmentId('asg_to_remove');
      for (const id of [survivor0, survivor1, toRemove]) {
        await createAtHead(repo, manager, id);
      }

      const before = await snapshotPrimaryCheckout(repo.dir);
      const fresh0 = assignmentId('asg_fresh_0');
      const fresh1 = assignmentId('asg_fresh_1');

      const results = await Promise.allSettled([
        manager.removeWorktree(toRemove),
        createAtHead(repo, manager, fresh0),
        createAtHead(repo, manager, fresh1),
      ]);
      for (const result of results) expect(result.status).toBe('fulfilled');

      const list = await repo.run(['worktree', 'list', '--porcelain']);
      expect(list).not.toContain(`branch refs/heads/${branchNameFor(toRemove)}`);
      for (const id of [survivor0, survivor1, fresh0, fresh1]) {
        expect(list).toContain(`branch refs/heads/${branchNameFor(id)}`);
      }
      expect(manager.handleFor(toRemove)).toBeUndefined();

      await assertPrimaryCheckoutUntouched(repo.dir, before);
    });
  });
});

// ---------------------------------------------------------------------------
// PLAN §19 test 30: "worktree taint validation: index.lock cleanup,
// reconcile-or-refuse on checkpoint mismatch."
// ---------------------------------------------------------------------------
describe('GitWorktreeManager.validate — §16.3 taint + validation (PLAN §19 test 30)', () => {
  async function withValidatedWorktree(
    run: (repo: TempGitRepo, manager: GitWorktreeManager, asg: AssignmentId) => Promise<void>,
  ): Promise<void> {
    await withRepoAndManager(async (repo, manager) => {
      const asg = assignmentId('asg_validate');
      await createAtHead(repo, manager, asg);
      await run(repo, manager, asg);
    });
  }

  it('removes a stale index.lock, and does so within the SAME mutex that serializes worktree add/remove', async () => {
    await withValidatedWorktree(async (repo, manager, asg) => {
      const handle = manager.handleFor(asg);
      if (!handle) throw new Error('expected a handle');
      const gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], handle.worktreePath)).stdout.trim();
      const lockPath = path.join(gitDir, 'index.lock');
      await writeFile(lockPath, ''); // simulate a leftover lock from a process killed mid-git-write
      expect(existsSync(lockPath)).toBe(true);

      // "within the mutex": a concurrent createWorktree for a DIFFERENT
      // assignment on the same repo must queue behind validate() — proven
      // the same way as the mutex race tests above (real timing, real git).
      const other = assignmentId('asg_other');
      let settled = false;
      const observed: string[] = [];
      const poll = (async () => {
        while (!settled) {
          const lease = manager.currentGitOpLease();
          const id = lease?.assignmentId !== undefined ? String(lease.assignmentId) : undefined;
          if (id !== undefined && observed[observed.length - 1] !== id) observed.push(id);
          await sleep(1);
        }
      })();

      const [result] = await Promise.all([manager.validate(asg), createAtHead(repo, manager, other)]);
      settled = true;
      await poll;

      expect(result.lockfileCleanupPerformed).toBe(true);
      expect(result.worktreeState.lockfileCleanupPerformed).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
      expect(result.outcome).toBe('clean');

      expect(observed.length).toBeGreaterThan(0);
      expect(observed[0]).toBe(String(asg)); // validate() was called first -> must be observed first (FIFO)
    });
  });

  it('reconciles as clean, with no taint, when the worktree matches the checkpoint exactly', async () => {
    await withValidatedWorktree(async (_repo, manager, asg) => {
      const handle = manager.handleFor(asg);
      if (!handle) throw new Error('expected a handle');
      const checkpoint = await captureWorktreeState(handle.worktreePath);

      const result = await manager.validate(asg, checkpoint);

      expect(result.outcome).toBe('clean');
      expect(result.mismatchDetected).toBe(false);
      expect(result.worktreeState.taintFlags).toEqual([]);
      expect(manager.isTainted(asg)).toBe(false);
    });
  });

  it('preserves unrecorded divergence as a WIP commit when the worktree is dirtier than the checkpoint recorded', async () => {
    await withValidatedWorktree(async (_repo, manager, asg) => {
      const handle = manager.handleFor(asg);
      if (!handle) throw new Error('expected a handle');
      const cleanCheckpoint = await captureWorktreeState(handle.worktreePath);
      await writeFile(path.join(handle.worktreePath, 'unrecorded.txt'), 'partial work never checkpointed\n');

      const result = await manager.validate(asg, cleanCheckpoint);

      expect(result.outcome).toBe('wip_committed');
      expect(result.mismatchDetected).toBe(true);
      expect(result.wipCommitSha).toBeDefined();
      expect(result.worktreeState.statusPorcelain).toBe('');
      expect(manager.isTainted(asg)).toBe(false); // resolved, not left tainted

      const log = (await runGit(['log', '--oneline', '-1'], handle.worktreePath)).stdout;
      expect(log).toContain('WIP reconciliation');
    });
  });

  it('resets to HEAD and records the discrepancy when the checkpoint recalled a dirty tree that is already clean', async () => {
    await withValidatedWorktree(async (_repo, manager, asg) => {
      const handle = manager.handleFor(asg);
      if (!handle) throw new Error('expected a handle');
      const realHead = await runGit(['rev-parse', 'HEAD'], handle.worktreePath).then((r) => r.stdout.trim());
      const fabricatedDirtyCheckpoint: WorktreeState = {
        headSha: gitSha(realHead),
        statusPorcelain: ' M pretend-file.txt\n',
        diffHash: artifactHash(sha256Hex('pretend diff content')),
        lockfileCleanupPerformed: false,
        taintFlags: [],
      };

      const result = await manager.validate(asg, fabricatedDirtyCheckpoint);

      expect(result.outcome).toBe('reset_and_recorded');
      expect(result.mismatchDetected).toBe(true);
      expect(result.worktreeState.statusPorcelain).toBe('');
      expect(result.worktreeState.headSha).toBe(realHead);
      expect(manager.isTainted(asg)).toBe(false);
    });
  });

  it('refuses to resume when HEAD drifted from the checkpoint, and taints the assignment until re-validated', async () => {
    await withValidatedWorktree(async (_repo, manager, asg) => {
      const handle = manager.handleFor(asg);
      if (!handle) throw new Error('expected a handle');
      const staleCheckpoint: WorktreeState = {
        headSha: gitSha('0'.repeat(40)), // definitely not the real HEAD
        statusPorcelain: '',
        diffHash: artifactHash(sha256Hex('')),
        lockfileCleanupPerformed: false,
        taintFlags: [],
      };

      const result = await manager.validate(asg, staleCheckpoint);

      expect(result.outcome).toBe('refuse_resume');
      expect(result.worktreeState.taintFlags).toEqual(['reconcile_mismatch']);
      expect(manager.isTainted(asg)).toBe(true);
      expect(manager.taintsFor(asg)).toEqual(['reconcile_mismatch']);

      manager.releaseLease(asg);
      expectThrowsWithKind(() => manager.reacquireLease(asg), 'requires_validation');

      // Re-validating with the CORRECT checkpoint clears the taint and
      // unblocks reuse — the whole point of the routine (§16.3: "before
      // any restart or verification").
      const correctCheckpoint = await captureWorktreeState(handle.worktreePath);
      const second = await manager.validate(asg, correctCheckpoint);
      expect(second.outcome).toBe('clean');
      expect(manager.isTainted(asg)).toBe(false);
      expect(() => manager.reacquireLease(asg)).not.toThrow();
    });
  });

  it('refuses to resume when HEAD is not readable at all (no checkpoint needed to detect this)', async () => {
    await withValidatedWorktree(async (_repo, manager, asg) => {
      const handle = manager.handleFor(asg);
      if (!handle) throw new Error('expected a handle');
      const gitFilePath = path.join(handle.worktreePath, '.git');
      const original = await readFile(gitFilePath, 'utf8');
      await writeFile(gitFilePath, 'gitdir: /nonexistent/broken/gitdir\n');

      try {
        const result = await manager.validate(asg);
        expect(result.outcome).toBe('refuse_resume');
        expect(manager.isTainted(asg)).toBe(true);
      } finally {
        await writeFile(gitFilePath, original); // restore so removeWorktree()/cleanup can still operate on it
      }
    });
  });

  it('with no checkpoint reference: a clean worktree validates as clean', async () => {
    await withValidatedWorktree(async (_repo, manager, asg) => {
      const result = await manager.validate(asg);
      expect(result.outcome).toBe('clean');
      expect(result.mismatchDetected).toBe(false);
      expect(manager.isTainted(asg)).toBe(false);
    });
  });

  it('with no checkpoint reference: a dirty worktree is preserved as a WIP commit', async () => {
    await withValidatedWorktree(async (_repo, manager, asg) => {
      const handle = manager.handleFor(asg);
      if (!handle) throw new Error('expected a handle');
      await writeFile(path.join(handle.worktreePath, 'untracked.txt'), 'content\n');

      const result = await manager.validate(asg);

      expect(result.outcome).toBe('wip_committed');
      expect(result.wipCommitSha).toBeDefined();
      const statusAfter = (await runGit(['status', '--porcelain'], handle.worktreePath)).stdout;
      expect(statusAfter.trim()).toBe('');
    });
  });

  it('validate throws not_found for an assignment with no tracked worktree', async () => {
    await withRepoAndManager(async (_repo, manager) => {
      await expectRejectsWithKind(manager.validate(assignmentId('asg_never_created')), 'not_found');
    });
  });
});
