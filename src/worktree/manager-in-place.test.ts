/**
 * B3/B4 at the MANAGER — the substrate that makes R1 structural.
 *
 * A spec-approval check is a check on a document; these are checks on the live
 * set of workspaces the manager has actually handed out. That distinction is the
 * whole point: a run that reaches here by any route — a hand-built input, a
 * resumed record, a flow nobody has written yet — still cannot obtain two
 * overlapping write boundaries at the same time.
 *
 * Kept in its own file so `manager.test.ts` stays byte-for-byte the worktree-mode
 * contract it has always asserted.
 */
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { assignmentId, gitSha, type AssignmentId } from '../domain/ids.js';
import { WorktreeError } from './errors.js';
import * as git from './git.js';
import { GitWorktreeManager } from './manager.js';
import type { InPlaceCheckpoint } from './in-place.js';
import { makeTempGitRepo, type TempGitRepo } from './test-support.js';

const repos: TempGitRepo[] = [];
afterEach(async () => {
  while (repos.length > 0) await repos.pop()?.cleanup();
});

async function rig(): Promise<{
  readonly repo: TempGitRepo;
  readonly manager: GitWorktreeManager;
  readonly base: string;
  readonly checkpoints: InPlaceCheckpoint[];
}> {
  const repo = await makeTempGitRepo('harness-manager-in-place-');
  repos.push(repo);
  await repo.writeFile('src/keep.ts', 'export const a = 1;\n');
  await repo.writeFile('web/keep.ts', 'export const b = 2;\n');
  await repo.commitAll('seed');
  const manager = await GitWorktreeManager.open({
    primaryRepoRoot: repo.dir,
    clock: new ManualClock('2026-07-26T00:00:00.000Z'),
  });
  return { repo, manager, base: await repo.headSha(), checkpoints: [] };
}

function openInPlace(
  manager: GitWorktreeManager,
  id: AssignmentId,
  base: string,
  writeScope: readonly string[] | undefined,
  sink: InPlaceCheckpoint[],
): Promise<import('./manager.js').WorktreeHandle> {
  return manager.createInPlaceWorkspace({
    assignmentId: id,
    baseCommit: gitSha(base),
    ...(writeScope !== undefined ? { writeScope } : {}),
    persistCheckpoint: (checkpoint) => sink.push(checkpoint),
  });
}

describe('createInPlaceWorkspace', () => {
  it('works IN the checkout: worktreePath === repoRoot, mode recorded on the handle', async () => {
    const { repo, manager, base, checkpoints } = await rig();
    const handle = await openInPlace(manager, assignmentId('asg_a'), base, undefined, checkpoints);

    expect(handle.executionMode).toBe('in_place');
    expect(handle.worktreePath).toBe(handle.repoRoot);
    // `repo.dir` is the mkdtemp path; the manager canonicalizes through
    // `git rev-parse --show-toplevel`, which resolves the macOS `/var -> /private/var`
    // symlink. Compare realpaths, not the strings the fixture happened to hand out.
    expect(realpathSync(handle.worktreePath)).toBe(realpathSync(repo.dir));
    expect(handle.leased).toBe(true);
    expect(await git.currentBranch(repo.dir)).toBe(handle.branch);
    expect(checkpoints).toHaveLength(1);
    expect(manager.inPlaceCheckpointFor(assignmentId('asg_a'))?.headRef).toBe('main');
    // No sibling worktree directory was created — that is the mode's whole point.
    expect(existsSync(manager.baseDir)).toBe(false);
  });

  it('REFUSES two whole-root in-place assignments (one checkout, one owner)', async () => {
    const { manager, base, checkpoints } = await rig();
    await openInPlace(manager, assignmentId('asg_a'), base, undefined, checkpoints);
    const error: unknown = await openInPlace(
      manager,
      assignmentId('asg_b'),
      base,
      undefined,
      checkpoints,
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorktreeError);
  });
});

describe('R1 at the substrate — overlapping scopes are refused', () => {
  it('REFUSES a second assignment whose scope NESTS inside a live one', async () => {
    const { manager, base, checkpoints } = await rig();
    await openInPlace(manager, assignmentId('asg_a'), base, ['src'], checkpoints);

    const error: unknown = await openInPlace(
      manager,
      assignmentId('asg_b'),
      base,
      ['src/app'],
      checkpoints,
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as WorktreeError).kind).toBe('already_leased');
    expect((error as Error).message).toContain('write scopes overlap');
    // The refusal happened BEFORE anything was recorded or switched.
    expect(checkpoints).toHaveLength(1);
    expect(manager.handleFor(assignmentId('asg_b'))).toBeUndefined();
  });

  it('REFUSES the exact same scope twice', async () => {
    const { manager, base, checkpoints } = await rig();
    await openInPlace(manager, assignmentId('asg_a'), base, ['src'], checkpoints);
    await expect(
      openInPlace(manager, assignmentId('asg_b'), base, ['src'], checkpoints),
    ).rejects.toBeInstanceOf(WorktreeError);
  });

  it('ADMITS two DISJOINT scopes in one checkout — the shared-tree shape', async () => {
    const { repo, manager, base, checkpoints } = await rig();
    const first = await openInPlace(manager, assignmentId('asg_a'), base, ['src'], checkpoints);
    const second = await openInPlace(manager, assignmentId('asg_b'), base, ['web'], checkpoints);

    expect(first.writeBoundary.roots).toEqual([path.join(realpathSync(repo.dir), 'src')]);
    expect(second.writeBoundary.roots).toEqual([path.join(realpathSync(repo.dir), 'web')]);
    expect(manager.handleFor(assignmentId('asg_b'))?.executionMode).toBe('in_place');
  });

  it('does NOT refuse `src/app` beside `src/application`', async () => {
    const { manager, base, checkpoints } = await rig();
    await openInPlace(manager, assignmentId('asg_a'), base, ['src/app'], checkpoints);
    await expect(
      openInPlace(manager, assignmentId('asg_b'), base, ['src/application'], checkpoints),
    ).resolves.toBeDefined();
  });
});

describe('destructive operations are gated on the HANDLE, not on a path comparison', () => {
  it('removeWorktree REFUSES an in-place assignment (it is the user`s checkout)', async () => {
    const { repo, manager, base, checkpoints } = await rig();
    await openInPlace(manager, assignmentId('asg_a'), base, undefined, checkpoints);
    const error: unknown = await manager.removeWorktree(assignmentId('asg_a')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as WorktreeError).kind).toBe('unsafe_path');
    expect(existsSync(path.join(repo.dir, 'src/keep.ts'))).toBe(true);
  });

  it('discardToCommit REFUSES out-of-scope dirt, and still discards in-scope dirt', async () => {
    const { repo, manager, base, checkpoints } = await rig();
    await openInPlace(manager, assignmentId('asg_a'), base, ['src'], checkpoints);

    await repo.writeFile('web/human.ts', 'export const h = 1;\n'); // a human's edit
    const error: unknown = await manager
      .discardToCommit(assignmentId('asg_a'), gitSha(base))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorktreeError);
    expect((error as WorktreeError).kind).toBe('requires_validation');
    expect(existsSync(path.join(repo.dir, 'web/human.ts'))).toBe(true);

    // Remove the unattributable path and the same call succeeds: the guard is
    // about attribution, not about refusing to work.
    await repo.run(['clean', '-fd', 'web']);
    await repo.writeFile('src/evidence.log', 'noise\n');
    await expect(manager.discardToCommit(assignmentId('asg_a'), gitSha(base))).resolves.toBeDefined();
    expect(existsSync(path.join(repo.dir, 'src/evidence.log'))).toBe(false);
  });

  it('releaseInPlaceWorkspace restores the pre-run HEAD and stops tracking', async () => {
    const { repo, manager, base, checkpoints } = await rig();
    await openInPlace(manager, assignmentId('asg_a'), base, undefined, checkpoints);
    const outcome = await manager.releaseInPlaceWorkspace(assignmentId('asg_a'));
    expect(outcome).toEqual({ restored: true, headRef: 'main' });
    expect(await git.currentBranch(repo.dir)).toBe('main');
    expect(manager.handleFor(assignmentId('asg_a'))).toBeUndefined();
  });
});

describe('provisioning', () => {
  it('is a trivially-true SKIP in-place — the whole F7/F9 lane does not apply', async () => {
    const { manager, base, checkpoints } = await rig();
    await openInPlace(manager, assignmentId('asg_a'), base, undefined, checkpoints);
    const outcome = await manager.provisionForVerification(assignmentId('asg_a'));
    expect(outcome.provisioned).toBe(true);
    expect(outcome.strategy).toBe('in_place');
    expect(outcome.fingerprint).toBe('');
  });
});

describe('reattach — the persisted mode is UNTRUSTED JSON', () => {
  it('a record with NO mode resolves to worktree (every pre-B3 record)', async () => {
    const { repo, manager, base, checkpoints } = await rig();
    // Create a real worktree so the path is registered, then drop the handle by
    // opening a SECOND manager (a fresh process's in-memory state).
    const handle = await manager.createWorktree({
      assignmentId: assignmentId('asg_a'),
      baseCommit: gitSha(base),
    });
    const successor = await GitWorktreeManager.open({
      primaryRepoRoot: repo.dir,
      clock: new ManualClock('2026-07-26T00:00:00.000Z'),
    });
    const reattached = await successor.reattach({
      assignmentId: assignmentId('asg_a'),
      worktreePath: handle.worktreePath,
      branch: handle.branch,
      baseSha: handle.baseSha,
      // `executionMode` deliberately absent — the pre-B3 record shape.
    });
    expect(reattached.executionMode).toBe('worktree');
    expect(reattached.writeBoundary.roots).toEqual([handle.worktreePath]);
    void checkpoints;
  });

  it('a GARBAGE mode resolves to worktree rather than crashing the resume', async () => {
    const { repo, manager, base } = await rig();
    const handle = await manager.createWorktree({
      assignmentId: assignmentId('asg_a'),
      baseCommit: gitSha(base),
    });
    const successor = await GitWorktreeManager.open({
      primaryRepoRoot: repo.dir,
      clock: new ManualClock('2026-07-26T00:00:00.000Z'),
    });
    const reattached = await successor.reattach({
      assignmentId: assignmentId('asg_a'),
      worktreePath: handle.worktreePath,
      branch: handle.branch,
      baseSha: handle.baseSha,
      executionMode: { from: 'the future' },
    });
    expect(reattached.executionMode).toBe('worktree');
  });
});
