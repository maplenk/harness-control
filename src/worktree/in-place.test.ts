/**
 * B3 in-place execution — the start checkpoint and the GUARDED revert, against
 * real git repositories.
 *
 * The revert is the only operation in this engine that destroys bytes, so the
 * tests that matter most here are the ones asserting it REFUSES: an unproven
 * path is not a reason to be careful, it is a reason to stop.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { assignmentId, gitSha } from '../domain/ids.js';
import { WorktreeError } from './errors.js';
import * as git from './git.js';
import {
  openInPlaceCheckpoint,
  porcelainDigest,
  restoreCheckpointHead,
  revertToCheckpoint,
  type InPlaceCheckpoint,
} from './in-place.js';
import { makeTempGitRepo, type TempGitRepo } from './test-support.js';
import { writeBoundary } from './write-scope.js';

const repos: TempGitRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

async function repoWithSrcAndWeb(): Promise<TempGitRepo> {
  const repo = await makeTempGitRepo('harness-in-place-test-');
  repos.push(repo);
  await repo.writeFile('src/keep.ts', 'export const a = 1;\n');
  await repo.writeFile('web/keep.ts', 'export const b = 2;\n');
  await repo.writeFile('.gitignore', 'node_modules\n');
  await repo.writeFile('node_modules/dep/index.js', 'module.exports = 1;\n');
  await repo.commitAll('seed');
  return repo;
}

async function open(repo: TempGitRepo, branch = 'harness/assignment/asg_a'): Promise<InPlaceCheckpoint> {
  return openInPlaceCheckpoint({
    assignmentId: assignmentId('asg_a'),
    rootPath: repo.dir,
    baseSha: gitSha(await repo.headSha()),
    branch,
    clock: new ManualClock('2026-07-26T00:00:00.000Z'),
    persist: () => undefined,
  });
}

describe('openInPlaceCheckpoint — entry is fail-closed', () => {
  it('REFUSES a dirty checkout, before recording or mutating anything', async () => {
    const repo = await repoWithSrcAndWeb();
    await repo.writeFile('src/dirty.ts', 'export const c = 3;\n');
    const persisted: InPlaceCheckpoint[] = [];

    const error: unknown = await openInPlaceCheckpoint({
      assignmentId: assignmentId('asg_a'),
      rootPath: repo.dir,
      baseSha: gitSha(await repo.headSha()),
      branch: 'harness/assignment/asg_a',
      clock: new ManualClock('2026-07-26T00:00:00.000Z'),
      persist: (c) => persisted.push(c),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as WorktreeError).kind).toBe('requires_validation');
    // Nothing recorded, nothing switched: the refusal is complete.
    expect(persisted).toHaveLength(0);
    expect(await git.currentBranch(repo.dir)).toBe('main');
    expect(await git.branchExists(repo.dir, 'harness/assignment/asg_a')).toBe(false);
  });

  it('records the checkpoint BEFORE the branch switch, then switches', async () => {
    const repo = await repoWithSrcAndWeb();
    const base = await repo.headSha();
    // Observed AT the persist call: the tree must still be where the user left it.
    let branchAtPersist: string | undefined;
    const checkpoint = await openInPlaceCheckpoint({
      assignmentId: assignmentId('asg_a'),
      rootPath: repo.dir,
      baseSha: gitSha(base),
      branch: 'harness/assignment/asg_a',
      clock: new ManualClock('2026-07-26T00:00:00.000Z'),
      persist: () => {
        branchAtPersist = 'observed';
      },
    });

    expect(branchAtPersist).toBe('observed');
    expect(checkpoint.headRef).toBe('main');
    expect(checkpoint.headRefKind).toBe('branch');
    expect(String(checkpoint.baseSha)).toBe(base);
    expect(checkpoint.entryPorcelainDigest).toBe(porcelainDigest(''));
    // …and only afterwards is the work branch checked out at the pinned base.
    expect(await git.currentBranch(repo.dir)).toBe('harness/assignment/asg_a');
    expect(await git.resolveSha(repo.dir, 'HEAD')).toBe(base);
  });

  it('records a DETACHED head as a sha, never as a branch name it never had', async () => {
    const repo = await repoWithSrcAndWeb();
    const base = await repo.headSha();
    await repo.run(['checkout', '--detach', base]);
    const checkpoint = await open(repo);
    expect(checkpoint.headRefKind).toBe('detached');
    expect(checkpoint.headRef).toBe(base);
  });

  it('REFUSES when the assignment branch already exists', async () => {
    const repo = await repoWithSrcAndWeb();
    await repo.run(['branch', 'harness/assignment/asg_a']);
    const error: unknown = await open(repo).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as WorktreeError).kind).toBe('already_leased');
  });

  it('REFUSES a base that is not the exact resolved commit', async () => {
    const repo = await repoWithSrcAndWeb();
    const error: unknown = await openInPlaceCheckpoint({
      assignmentId: assignmentId('asg_a'),
      rootPath: repo.dir,
      baseSha: gitSha('0'.repeat(40)),
      branch: 'harness/assignment/asg_a',
      clock: new ManualClock('2026-07-26T00:00:00.000Z'),
      persist: () => undefined,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorktreeError);
  });
});

describe('revertToCheckpoint — the guard is the point', () => {
  it('reverts in-scope work and restores the pre-run HEAD', async () => {
    const repo = await repoWithSrcAndWeb();
    const checkpoint = await open(repo);
    const boundary = writeBoundary({ mode: 'in_place', executionRoot: repo.dir, declaredScope: ['src'] });

    await repo.writeFile('src/keep.ts', 'export const a = 999;\n'); // modified, in scope
    await repo.writeFile('src/new.ts', 'export const n = 1;\n'); // untracked, in scope

    const outcome = await revertToCheckpoint({ checkpoint, boundary });
    expect(outcome.kind).toBe('reverted');
    expect(readFileSync(path.join(repo.dir, 'src/keep.ts'), 'utf8')).toBe('export const a = 1;\n');
    expect(existsSync(path.join(repo.dir, 'src/new.ts'))).toBe(false);
    expect(await git.currentBranch(repo.dir)).toBe('main');
  });

  it('REFUSES when a dirty path is OUTSIDE the scope, and leaves the tree untouched', async () => {
    const repo = await repoWithSrcAndWeb();
    const checkpoint = await open(repo);
    const boundary = writeBoundary({ mode: 'in_place', executionRoot: repo.dir, declaredScope: ['src'] });

    await repo.writeFile('src/new.ts', 'export const n = 1;\n'); // ours
    await repo.writeFile('web/human.ts', 'export const h = 1;\n'); // NOT ours

    const outcome = await revertToCheckpoint({ checkpoint, boundary });
    expect(outcome.kind).toBe('refused');
    expect(outcome.kind === 'refused' ? outcome.unattributable : []).toEqual([
      path.join(repo.dir, 'web/human.ts'),
    ]);
    // NOTHING was destroyed — including our own in-scope file, because a partial
    // revert of a tree we cannot fully account for is still a revert we cannot
    // account for.
    expect(existsSync(path.join(repo.dir, 'src/new.ts'))).toBe(true);
    expect(existsSync(path.join(repo.dir, 'web/human.ts'))).toBe(true);
    expect(await git.currentBranch(repo.dir)).toBe('harness/assignment/asg_a');
  });

  it('never passes `-x`: an IGNORED node_modules survives the revert', async () => {
    // The whole practical win of in-place mode is that dependencies are already
    // there. A `git clean -fdx` would delete them and turn every in-place revert
    // into a reinstall.
    const repo = await repoWithSrcAndWeb();
    const checkpoint = await open(repo);
    const boundary = writeBoundary({ mode: 'in_place', executionRoot: repo.dir });
    await repo.writeFile('src/new.ts', 'export const n = 1;\n');

    const outcome = await revertToCheckpoint({ checkpoint, boundary });
    expect(outcome.kind).toBe('reverted');
    expect(existsSync(path.join(repo.dir, 'node_modules/dep/index.js'))).toBe(true);
  });

  it('a WHOLE-ROOT boundary attributes everything — the lone-implementor shape', async () => {
    const repo = await repoWithSrcAndWeb();
    const checkpoint = await open(repo);
    const boundary = writeBoundary({ mode: 'in_place', executionRoot: repo.dir });
    await repo.writeFile('web/anything.ts', 'export const x = 1;\n');
    expect((await revertToCheckpoint({ checkpoint, boundary })).kind).toBe('reverted');
  });

  it('reverts a COMMIT on the assignment branch back to the base', async () => {
    const repo = await repoWithSrcAndWeb();
    const base = await repo.headSha();
    const checkpoint = await open(repo);
    await repo.writeFile('src/new.ts', 'export const n = 1;\n');
    await repo.commitAll('agent work');
    expect(await repo.headSha()).not.toBe(base);

    const outcome = await revertToCheckpoint({
      checkpoint,
      boundary: writeBoundary({ mode: 'in_place', executionRoot: repo.dir, declaredScope: ['src'] }),
    });
    expect(outcome.kind).toBe('reverted');
    expect(await git.resolveSha(repo.dir, 'refs/heads/harness/assignment/asg_a')).toBe(base);
    expect(await git.currentBranch(repo.dir)).toBe('main');
  });
});

describe('restoreCheckpointHead — the success exit', () => {
  it('puts the operator back on their branch and LEAVES the assignment branch', async () => {
    const repo = await repoWithSrcAndWeb();
    const checkpoint = await open(repo);
    await repo.writeFile('src/new.ts', 'export const n = 1;\n');
    const workCommit = await repo.commitAll('agent work');

    await restoreCheckpointHead(checkpoint);

    expect(await git.currentBranch(repo.dir)).toBe('main');
    // The work survives for a human to merge — the engine never merges (§16).
    expect(await git.resolveSha(repo.dir, 'refs/heads/harness/assignment/asg_a')).toBe(workCommit);
    expect(existsSync(path.join(repo.dir, 'src/new.ts'))).toBe(false); // not on main
  });
});
