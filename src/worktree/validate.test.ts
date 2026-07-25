/**
 * §16.3 validation (`validate.ts`) — the FULL reconciliation outcome matrix at
 * the module level, against REAL temp git repos (`manager.test.ts` covers the
 * same routine through the manager's mutex/taint bookkeeping; this file pins the
 * decision tree itself).
 *
 * F8 (A) adds the forward-containment row: an interrupted IMPLEMENTOR round
 * whose HEAD moved FORWARD from the checkpoint (the implementor's own commit,
 * taken after the last cadence checkpoint) is implementor-authored motion, not
 * tamper — accepted when the caller opts in. Everything that is NOT a strict
 * forward descent (diverge, reset/amend, an ancestry probe that ERRORS) stays
 * `refuse_resume`, fail-closed.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { artifactHash, gitSha } from '../domain/ids.js';
import type { WorktreeState } from '../domain/entities.js';
import { sha256Hex } from '../artifacts/hash.js';
import { runGit } from './git.js';
import { validateWorktree } from './validate.js';
import {
  assertPrimaryCheckoutUntouched,
  makeTempGitRepo,
  snapshotPrimaryCheckout,
  type TempGitRepo,
} from './test-support.js';

const WIP_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'f8-tests',
  GIT_AUTHOR_EMAIL: 'f8@harness.invalid',
  GIT_COMMITTER_NAME: 'f8-tests',
  GIT_COMMITTER_EMAIL: 'f8@harness.invalid',
};

let repo: TempGitRepo | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

/** Mirrors validate.ts's own plumbing exactly, so a fixture checkpoint either matches reality or diverges from it deliberately. */
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

async function makeRepo(): Promise<TempGitRepo> {
  repo = await makeTempGitRepo('harness-validate-test-');
  return repo;
}

// ---------------------------------------------------------------------------
// The pre-F8 decision tree (rows 1-3 of validate.ts's doc comment)
// ---------------------------------------------------------------------------
describe('validateWorktree — §16.3 reconciliation outcome matrix', () => {
  it('no checkpoint reference + clean worktree -> clean', async () => {
    const r = await makeRepo();
    const result = await validateWorktree({ worktreePath: r.dir });
    expect(result.outcome).toBe('clean');
    expect(result.mismatchDetected).toBe(false);
    expect(result.wipCommitSha).toBeUndefined();
    expect(String(result.worktreeState.headSha)).toBe(await r.headSha());
    expect(result.worktreeState.taintFlags).toEqual([]);
  });

  it('no checkpoint reference + dirty worktree -> wip_committed (unrecorded work is PRESERVED, never discarded)', async () => {
    const r = await makeRepo();
    const before = await r.headSha();
    await r.writeFile('scratch.txt', 'unrecorded work\n');

    const result = await validateWorktree({ worktreePath: r.dir, wipCommitEnv: WIP_ENV });

    expect(result.outcome).toBe('wip_committed');
    expect(result.mismatchDetected).toBe(false);
    expect(result.wipCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await r.headSha()).not.toBe(before);
    expect(await r.statusPorcelain()).toBe('');
    // The preserved content really is in the WIP commit.
    expect((await r.run(['show', '--name-only', '--format=', 'HEAD'])).trim()).toBe('scratch.txt');
  });

  it('checkpoint matches reality EXACTLY -> clean, no mismatch', async () => {
    const r = await makeRepo();
    const checkpoint = await captureWorktreeState(r.dir);
    const result = await validateWorktree({ worktreePath: r.dir, checkpointWorktreeState: checkpoint });
    expect(result.outcome).toBe('clean');
    expect(result.mismatchDetected).toBe(false);
    expect(result.worktreeState.taintFlags).toEqual([]);
  });

  it('checkpoint recorded dirt that is no longer there -> reset_and_recorded (mismatch flagged, nothing to preserve)', async () => {
    const r = await makeRepo();
    // A checkpoint that CLAIMS uncommitted dirt the tree does not have.
    const head = await r.headSha();
    const fabricatedDirty: WorktreeState = {
      headSha: gitSha(head),
      statusPorcelain: ' M README.md\n',
      diffHash: artifactHash(sha256Hex('a diff that is not there')),
      lockfileCleanupPerformed: false,
      taintFlags: [],
    };

    const result = await validateWorktree({ worktreePath: r.dir, checkpointWorktreeState: fabricatedDirty });

    expect(result.outcome).toBe('reset_and_recorded');
    expect(result.mismatchDetected).toBe(true);
    expect(result.wipCommitSha).toBeUndefined();
    expect(await r.headSha()).toBe(head); // reset --hard HEAD is a no-op on an already-clean tree
  });

  it('same HEAD, dirt BEYOND what the checkpoint recorded -> wip_committed', async () => {
    const r = await makeRepo();
    const checkpoint = await captureWorktreeState(r.dir); // clean
    await r.writeFile('surprise.txt', 'appeared after the checkpoint\n');

    const result = await validateWorktree({
      worktreePath: r.dir,
      checkpointWorktreeState: checkpoint,
      wipCommitEnv: WIP_ENV,
    });

    expect(result.outcome).toBe('wip_committed');
    expect(result.mismatchDetected).toBe(true);
    expect(result.wipCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(await r.statusPorcelain()).toBe('');
  });

  it('HEAD drifted and forward containment is NOT requested -> refuse_resume + reconcile_mismatch taint', async () => {
    const r = await makeRepo();
    const checkpoint = await captureWorktreeState(r.dir);
    await r.writeFile('later.txt', 'committed after the checkpoint\n');
    const moved = await r.commitAll('a commit the checkpoint never saw');

    const result = await validateWorktree({ worktreePath: r.dir, checkpointWorktreeState: checkpoint });

    expect(result.outcome).toBe('refuse_resume');
    expect(result.mismatchDetected).toBe(true);
    expect(result.worktreeState.taintFlags).toEqual(['reconcile_mismatch']);
    expect(result.detail).toContain(String(checkpoint.headSha));
    expect(result.detail).toContain(moved);
  });

  it('HEAD not readable -> refuse_resume with the unreadable-head sentinel', async () => {
    const r = await makeRepo();
    // An empty repo with no commits at all: `git rev-parse HEAD` fails.
    const empty = path.join(r.dir, 'empty-repo');
    mkdirSync(empty, { recursive: true });
    await runGit(['init', '--initial-branch=main'], empty);

    const result = await validateWorktree({ worktreePath: empty });

    expect(result.outcome).toBe('refuse_resume');
    expect(result.mismatchDetected).toBe(true);
    expect(String(result.worktreeState.headSha)).toBe('HEAD_UNREADABLE');
    expect(result.detail).toMatch(/HEAD is not readable/i);
  });

  it('removes a stale index.lock (provably stale inside the caller mutex) and reports it', async () => {
    const r = await makeRepo();
    const gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], r.dir)).stdout.trim();
    const lock = path.join(gitDir, 'index.lock');
    writeFileSync(lock, '', 'utf8');

    const result = await validateWorktree({ worktreePath: r.dir });

    expect(result.lockfileCleanupPerformed).toBe(true);
    expect(existsSync(lock)).toBe(false);
    expect(result.outcome).toBe('clean');
  });

  it('F10: the WIP commit succeeds with a PROVISIONED (git-ignored) node_modules on disk', async () => {
    // The §16.3 reconciliation path with a real F7-provisioned tree present had
    // ZERO coverage — which is how the git 2.55 exclude-pathspec regression
    // ("The following paths are ignored by one of your .gitignore files")
    // reached production and killed run_756ce21b's resume.
    const r = await makeRepo();
    await r.writeFile('.gitignore', 'node_modules/\n');
    await r.writeFile('src/app.ts', 'export const x = 1;\n');
    await r.commitAll('source with an ignore rule');
    await r.writeFile('node_modules/left-pad/index.js', 'module.exports = () => {};\n');
    await r.writeFile('node_modules/.bin/tsc', '#!/bin/sh\n');
    await r.writeFile('src/crash-dirt.ts', 'export const y = 2;\n');

    const result = await validateWorktree({
      worktreePath: r.dir,
      wipCommitEnv: WIP_ENV,
      excludeNodeModulesFromWip: true,
    });

    expect(result.outcome).toBe('wip_committed');
    expect(result.wipCommitSha).toMatch(/^[0-9a-f]{40}$/);
    const committed = (await r.run(['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n');
    expect(committed).toEqual(['src/crash-dirt.ts']); // the dirt preserved, the toolchain excluded
  });

  it('F7 (#1): the WIP commit EXCLUDES node_modules when managed provisioning is active', async () => {
    const r = await makeRepo();
    await r.writeFile('src/app.ts', 'export const x = 1;\n');
    await r.commitAll('source');
    await r.writeFile('node_modules/left-pad/index.js', 'module.exports = () => {};\n');
    await r.writeFile('src/added.ts', 'export const y = 2;\n');

    const result = await validateWorktree({
      worktreePath: r.dir,
      wipCommitEnv: WIP_ENV,
      excludeNodeModulesFromWip: true,
    });

    expect(result.outcome).toBe('wip_committed');
    const committed = (await r.run(['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n');
    expect(committed).toContain('src/added.ts');
    expect(committed.some((f) => f.startsWith('node_modules/'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F8 (A) — forward containment
// ---------------------------------------------------------------------------
describe('validateWorktree — F8 (A) forward-containment acceptance', () => {
  it('ACCEPTS a checkpoint sha that is a strict ancestor of HEAD (the implementor committed after the last checkpoint)', async () => {
    const r = await makeRepo();
    // The cadence checkpoint fires MID-round: HEAD is the base, the work is
    // uncommitted dirt. This is the shape production always produces.
    await r.writeFile('feature.ts', 'work in progress\n');
    const checkpoint = await captureWorktreeState(r.dir);
    expect(checkpoint.statusPorcelain).not.toBe('');
    // ...then the implementor commits and the process dies before any later checkpoint.
    const implementationCommit = await r.commitAll('implementor round 1');

    const result = await validateWorktree({
      worktreePath: r.dir,
      checkpointWorktreeState: checkpoint,
      wipCommitEnv: WIP_ENV,
      acceptForwardContainment: true,
    });

    expect(result.outcome).not.toBe('refuse_resume');
    expect(result.worktreeState.taintFlags).toEqual([]);
    // The committed HEAD survives untouched — the round's deliverable is intact.
    expect(String(result.worktreeState.headSha)).toBe(implementationCommit);
    expect(await r.headSha()).toBe(implementationCommit);
    // The drift is still REPORTED honestly (the recorded state is not what is on disk).
    expect(result.mismatchDetected).toBe(true);
    expect(result.detail).toMatch(/forward/i);
  });

  it('accepted forward drift with post-commit dirt still preserves the dirt as a WIP commit', async () => {
    const r = await makeRepo();
    await r.writeFile('feature.ts', 'work in progress\n');
    const checkpoint = await captureWorktreeState(r.dir);
    const implementationCommit = await r.commitAll('implementor round 1');
    await r.writeFile('post-commit.txt', 'written after the commit\n');

    const result = await validateWorktree({
      worktreePath: r.dir,
      checkpointWorktreeState: checkpoint,
      wipCommitEnv: WIP_ENV,
      acceptForwardContainment: true,
    });

    expect(result.outcome).toBe('wip_committed');
    expect(result.wipCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.worktreeState.taintFlags).toEqual([]);
    // The implementation commit is the WIP commit's PARENT — nothing was lost.
    expect((await r.run(['rev-parse', 'HEAD~1'])).trim()).toBe(implementationCommit);
  });

  it('accepts forward drift across MORE than one commit (several rounds of motion)', async () => {
    const r = await makeRepo();
    const checkpoint = await captureWorktreeState(r.dir);
    await r.writeFile('a.txt', 'a\n');
    await r.commitAll('one');
    await r.writeFile('b.txt', 'b\n');
    const second = await r.commitAll('two');

    const result = await validateWorktree({
      worktreePath: r.dir,
      checkpointWorktreeState: checkpoint,
      acceptForwardContainment: true,
    });

    expect(result.outcome).not.toBe('refuse_resume');
    expect(String(result.worktreeState.headSha)).toBe(second);
  });

  it('REFUSES a DIVERGED HEAD (a rewritten history is not a descendant) even with forward containment on', async () => {
    const r = await makeRepo();
    const base = await r.headSha();
    await r.writeFile('feature.ts', 'work\n');
    const round1 = await r.commitAll('implementor round 1');
    // Tamper: abandon `round1` and build a DIFFERENT commit on the same base.
    // The checkpoint's sha is now on an unreachable branch — neither an ancestor
    // nor a descendant of HEAD.
    await r.run(['reset', '--hard', base]);
    await r.writeFile('other.ts', 'a different history\n');
    const rewritten = await r.commitAll('a rewritten round');
    expect(rewritten).not.toBe(round1);
    const abandoned: WorktreeState = {
      headSha: gitSha(round1),
      statusPorcelain: '',
      diffHash: artifactHash(sha256Hex('')),
      lockfileCleanupPerformed: false,
      taintFlags: [],
    };

    const result = await validateWorktree({
      worktreePath: r.dir,
      checkpointWorktreeState: abandoned,
      acceptForwardContainment: true,
    });

    expect(result.outcome).toBe('refuse_resume');
    expect(result.worktreeState.taintFlags).toEqual(['reconcile_mismatch']);
  });

  it('REFUSES a BACKWARD reset (HEAD is an ancestor of the checkpoint, not a descendant)', async () => {
    const r = await makeRepo();
    const base = await r.headSha();
    await r.writeFile('feature.ts', 'work\n');
    const ahead = await r.commitAll('implementor round 1');
    const checkpoint: WorktreeState = {
      headSha: gitSha(ahead),
      statusPorcelain: '',
      diffHash: artifactHash(sha256Hex('')),
      lockfileCleanupPerformed: false,
      taintFlags: [],
    };
    // Tamper: throw the round's commit away.
    await r.run(['reset', '--hard', base]);

    const result = await validateWorktree({
      worktreePath: r.dir,
      checkpointWorktreeState: checkpoint,
      acceptForwardContainment: true,
    });

    expect(result.outcome).toBe('refuse_resume');
    expect(result.worktreeState.taintFlags).toEqual(['reconcile_mismatch']);
  });

  it('REFUSES when the ancestry probe ERRORS (unknown checkpoint object) — a probe failure is never an acceptance', async () => {
    const r = await makeRepo();
    await r.writeFile('feature.ts', 'work\n');
    await r.commitAll('implementor round 1');
    const unknownObject: WorktreeState = {
      headSha: gitSha('0000000000000000000000000000000000000001'),
      statusPorcelain: '',
      diffHash: artifactHash(sha256Hex('')),
      lockfileCleanupPerformed: false,
      taintFlags: [],
    };

    const result = await validateWorktree({
      worktreePath: r.dir,
      checkpointWorktreeState: unknownObject,
      acceptForwardContainment: true,
    });

    expect(result.outcome).toBe('refuse_resume');
    expect(result.worktreeState.taintFlags).toEqual(['reconcile_mismatch']);
    expect(result.detail).toMatch(/ancestry/i);
  });

  it('REFUSES the empty-sentinel checkpoint sha a non-probed pause records (fail closed, never accepted)', async () => {
    const r = await makeRepo();
    await r.writeFile('feature.ts', 'work\n');
    await r.commitAll('implementor round 1');
    const unprobed: WorktreeState = {
      headSha: gitSha(''),
      statusPorcelain: '',
      diffHash: artifactHash(sha256Hex('')),
      lockfileCleanupPerformed: false,
      taintFlags: [],
    };

    const result = await validateWorktree({
      worktreePath: r.dir,
      checkpointWorktreeState: unprobed,
      acceptForwardContainment: true,
    });

    expect(result.outcome).toBe('refuse_resume');
  });

  it('leaves the PRIMARY checkout byte-for-byte untouched while validating a linked worktree', async () => {
    const r = await makeRepo();
    const before = await snapshotPrimaryCheckout(r.dir);
    const wtPath = path.join(r.dir, '..', `${path.basename(r.dir)}-linked`);
    await r.run(['worktree', 'add', '-b', 'linked-branch', wtPath, 'HEAD']);
    try {
      const checkpoint = await captureWorktreeState(wtPath);
      writeFileSync(path.join(wtPath, 'work.txt'), 'implementor work\n', 'utf8');
      await runGit(['add', '-A'], wtPath);
      await runGit(['commit', '-m', 'round 1'], wtPath, WIP_ENV);

      const result = await validateWorktree({
        worktreePath: wtPath,
        checkpointWorktreeState: checkpoint,
        acceptForwardContainment: true,
      });

      expect(result.outcome).not.toBe('refuse_resume');
      await assertPrimaryCheckoutUntouched(r.dir, before);
    } finally {
      await r.run(['worktree', 'remove', '--force', wtPath]).catch(() => '');
    }
  });
});
