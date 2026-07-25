/**
 * F10 — the node_modules-excluding staging helpers (`git.ts`), against REAL git.
 *
 * These are the ONLY two paths by which harness-authored content becomes a
 * commit (`implementor.ts`'s post-turn commit and `validate.ts`'s §16.3 WIP
 * reconciliation), and they had no real-git coverage — which is exactly why the
 * git 2.55 regression below reached production.
 *
 * THE BUG (git 2.55.0, deterministic): `git add -A -- . ':(exclude)node_modules'`
 * exits 1 with "The following paths are ignored by one of your .gitignore files:
 * node_modules" whenever an ignored `node_modules` exists ON DISK — git treats the
 * exclude pathspec item as an explicit mention of an ignored path. F7 provisions a
 * git-ignored `node_modules` into every worktree, so from git 2.55 onward BOTH
 * callers fail on every provisioned round (`run_756ce21b` died exactly there).
 *
 * The replacement stages with a plain `git add -A -- .` (gitignore alone already
 * keeps an ignored tree out) and then PROVES the index is free of `node_modules`
 * at ANY depth, failing closed if it cannot make it so.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { addAllExceptNodeModules, runGit, unstageNodeModules } from './git.js';
import { isWorktreeError, type WorktreeError } from './errors.js';
import { makeTempGitRepo, type TempGitRepo } from './test-support.js';

let repo: TempGitRepo | undefined;

afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

/** A repo whose `.gitignore` is exactly `rules` (empty string = no rules at all). */
async function repoWithIgnore(rules: string): Promise<TempGitRepo> {
  repo = await makeTempGitRepo('harness-git-staging-');
  await repo.writeFile('.gitignore', rules);
  await repo.writeFile('src/app.ts', 'export const app = 1;\n');
  await repo.commitAll('base');
  return repo;
}

/** Materializes a node_modules tree at `relDir` with one file and a `.bin` entry. */
function plantNodeModules(root: string, relDir: string): void {
  mkdirSync(path.join(root, relDir, 'left-pad'), { recursive: true });
  writeFileSync(path.join(root, relDir, 'left-pad', 'index.js'), 'module.exports = () => {};\n', 'utf8');
  mkdirSync(path.join(root, relDir, '.bin'), { recursive: true });
  writeFileSync(path.join(root, relDir, '.bin', 'tsc'), '#!/bin/sh\n', 'utf8');
}

async function stagedPaths(worktreePath: string): Promise<string[]> {
  const { stdout } = await runGit(['diff', '--cached', '--name-only'], worktreePath);
  return stdout.split('\n').filter((line) => line.length > 0);
}

describe('addAllExceptNodeModules — F10 (git 2.55 ignored-pathspec regression)', () => {
  it('stages the work when a git-IGNORED node_modules is present on disk (the exact production failure)', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'node_modules'); // what F7 provisioning leaves behind
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');
    await r.writeFile('src/app.ts', 'export const app = 2;\n');

    await addAllExceptNodeModules(r.dir);

    expect(await stagedPaths(r.dir)).toEqual(['src/app.ts', 'src/feature.ts']);
  });

  it('preserves full -A semantics: adds, modifications AND deletions', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'node_modules');
    await r.writeFile('src/added.ts', 'export const added = 1;\n');
    await r.writeFile('src/app.ts', 'export const app = 3;\n');
    await r.run(['rm', '--quiet', 'README.md']);

    await addAllExceptNodeModules(r.dir);

    const staged = await stagedPaths(r.dir);
    expect(staged).toContain('src/added.ts');
    expect(staged).toContain('src/app.ts');
    expect(staged).toContain('README.md'); // the deletion is staged too
  });

  it('never stages an UNIGNORED node_modules (the belt that survives a deleted ignore rule)', async () => {
    const r = await repoWithIgnore(''); // no ignore rule at all
    plantNodeModules(r.dir, 'node_modules');
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');

    await addAllExceptNodeModules(r.dir);

    const staged = await stagedPaths(r.dir);
    expect(staged).toContain('src/feature.ts');
    expect(staged.some((p) => p.includes('node_modules'))).toBe(false);
    // ...and the tree itself is untouched on disk (never deleted, only unstaged).
    expect(await stagedPaths(r.dir)).not.toContain('node_modules/left-pad/index.js');
  });

  it('never stages a NESTED node_modules — at any depth, ignored or not', async () => {
    const r = await repoWithIgnore(''); // the old root-only pathspec staged this
    plantNodeModules(r.dir, 'web/node_modules');
    plantNodeModules(r.dir, 'packages/api/node_modules');
    await r.writeFile('web/app.ts', 'export const web = 1;\n');

    await addAllExceptNodeModules(r.dir);

    const staged = await stagedPaths(r.dir);
    expect(staged).toContain('web/app.ts');
    expect(staged.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('a nested node_modules covered by a bare `node_modules/` rule is likewise never staged', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'web/node_modules');
    await r.writeFile('web/app.ts', 'export const web = 1;\n');

    await addAllExceptNodeModules(r.dir);

    expect(await stagedPaths(r.dir)).toEqual(['web/app.ts']);
  });

  it('removes an ALREADY-STAGED node_modules the agent added itself (round-4 #3), at any depth', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'node_modules');
    plantNodeModules(r.dir, 'web/node_modules');
    // The agent force-staged the ignored tree during its turn.
    await r.run(['add', '-f', '--', 'node_modules', 'web/node_modules']);
    expect((await stagedPaths(r.dir)).some((p) => p.includes('node_modules'))).toBe(true);
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');

    await addAllExceptNodeModules(r.dir);

    const staged = await stagedPaths(r.dir);
    expect(staged).toContain('src/feature.ts');
    expect(staged.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('a TRACKED node_modules modification is never staged, and the working tree keeps the new bytes', async () => {
    const r = await repoWithIgnore('');
    plantNodeModules(r.dir, 'node_modules');
    await r.commitAll('a repo that (wrongly) tracks node_modules');
    writeFileSync(path.join(r.dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 2;\n', 'utf8');
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');

    await addAllExceptNodeModules(r.dir);

    expect(await stagedPaths(r.dir)).toEqual(['src/feature.ts']);
    // The provisioned bytes stay on disk — the helper unstages, never deletes.
    expect((await r.run(['show', ':node_modules/left-pad/index.js'])).trim()).toBe('module.exports = () => {};');
  });

  it('FAILS CLOSED when a node_modules path cannot be removed from the index', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'node_modules');
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');
    // A stubborn index the reset cannot clear: simulated by making `git reset`
    // itself impossible — a stale index.lock blocks every index write.
    const gitDir = (await runGit(['rev-parse', '--absolute-git-dir'], r.dir)).stdout.trim();
    await r.run(['add', '-f', '--', 'node_modules']);
    writeFileSync(path.join(gitDir, 'index.lock'), '', 'utf8');

    const thrown: unknown = await addAllExceptNodeModules(r.dir).catch((e: unknown) => e);

    expect(isWorktreeError(thrown)).toBe(true);
    // Whatever git refused (add or reset), the helper never returns "staged OK".
    expect((thrown as WorktreeError).kind).toBe('git_command_failed');
  });
});

describe('unstageNodeModules — F10 depth-aware unstage', () => {
  it('unstages node_modules at every depth and leaves everything else staged', async () => {
    const r = await repoWithIgnore('');
    plantNodeModules(r.dir, 'node_modules');
    plantNodeModules(r.dir, 'web/node_modules');
    await r.writeFile('web/app.ts', 'export const web = 1;\n');
    await r.run(['add', '-A']);
    expect((await stagedPaths(r.dir)).some((p) => p.includes('node_modules'))).toBe(true);

    await unstageNodeModules(r.dir);

    const staged = await stagedPaths(r.dir);
    expect(staged).toContain('web/app.ts');
    expect(staged.some((p) => p.includes('node_modules'))).toBe(false);
  });

  it('is a no-op when nothing node_modules-shaped is staged', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');
    await r.run(['add', '-A']);

    await unstageNodeModules(r.dir);

    expect(await stagedPaths(r.dir)).toEqual(['src/feature.ts']);
  });

  it('does NOT unstage a path that merely CONTAINS the substring node_modules', async () => {
    const r = await repoWithIgnore('');
    await r.writeFile('src/node_modules_helper.ts', 'export const helper = 1;\n');
    await r.writeFile('src/my_node_modules/keep.ts', 'export const keep = 1;\n');
    await r.run(['add', '-A']);

    await unstageNodeModules(r.dir);

    expect(await stagedPaths(r.dir)).toEqual(['src/my_node_modules/keep.ts', 'src/node_modules_helper.ts']);
  });
});
