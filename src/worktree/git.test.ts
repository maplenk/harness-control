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
import { addAllExceptNodeModules, assertIndexFreeOfNodeModules, runGit, unstageNodeModules } from './git.js';
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
  // THE regression test. It is the FOUR-WAY combination that no pre-existing test
  // had, which is exactly why the bug shipped into production:
  //   (1) REAL git — not a fake seam;
  //   (2) a COMMITTED `node_modules/` ignore rule;
  //   (3) a node_modules tree PRESENT on disk;
  //   (4) a call to the actual staging helper.
  // The suite was fixture-shape-blind, not fake-git-blind: `implementor.test.ts`
  // drives this helper against real git, but its only ignore rule was `*.log`, so
  // its node_modules fixtures were UNIGNORED and the old pathspec exited 0 there;
  // `provision.test.ts` writes the real `node_modules/` rule but never calls the
  // staging helper. Neither file ever held all four at once.
  it('stages the work when a git-IGNORED node_modules is present on disk (the exact production failure)', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'node_modules'); // what F7 provisioning leaves behind
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');
    await r.writeFile('src/app.ts', 'export const app = 2;\n');

    // Must not throw. Pre-fix this rejected with the git 2.55 ignored-path advice
    // AFTER git had already staged the non-excluded paths — see the CONTROL test
    // below — so the round's work sat in the index with the commit never reached.
    await addAllExceptNodeModules(r.dir);

    // No half-state: the index is EXACTLY the work, and the commit really lands.
    expect(await stagedPaths(r.dir)).toEqual(['src/app.ts', 'src/feature.ts']);
    const sha = await r.commitAll('the round commits cleanly');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const committed = (await r.run(['show', '--name-only', '--format=', 'HEAD'])).trim().split('\n');
    expect(committed).toEqual(['src/app.ts', 'src/feature.ts']);
    expect((await r.statusPorcelain()).trim()).toBe(''); // nothing left staged or dirty
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

  // REGRESSION 4 (round 10): an UNIGNORED node_modules is intentional USER
  // content — a vendored tree main commits without complaint. The guard exists to
  // stop the engine's PROVISIONED tree entering a commit, and a provisioned tree
  // is by definition git-ignored (provisioning fails closed otherwise).
  it('KEEPS an unignored (vendored) node_modules staged — it is user content, not ours', async () => {
    const r = await repoWithIgnore(''); // no ignore rule at all
    plantNodeModules(r.dir, 'node_modules');
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');

    await addAllExceptNodeModules(r.dir);

    const staged = await stagedPaths(r.dir);
    expect(staged).toContain('src/feature.ts');
    expect(staged).toContain('node_modules/left-pad/index.js'); // committable, as on main
  });

  it('KEEPS a nested vendored node_modules staged when it is not ignored', async () => {
    const r = await repoWithIgnore('');
    plantNodeModules(r.dir, 'web/node_modules');
    plantNodeModules(r.dir, 'packages/api/node_modules');
    await r.writeFile('web/app.ts', 'export const web = 1;\n');

    await addAllExceptNodeModules(r.dir);

    const staged = await stagedPaths(r.dir);
    expect(staged).toContain('web/app.ts');
    expect(staged.some((p) => p.includes('node_modules'))).toBe(true);
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

  // REGRESSION 4: a TRACKED node_modules is the clearest case of user content —
  // main commits its changes, and so must this.
  it('a TRACKED node_modules modification IS staged and commits (main does; so do we)', async () => {
    const r = await repoWithIgnore('');
    plantNodeModules(r.dir, 'node_modules');
    await r.commitAll('a repo that (wrongly) tracks node_modules');
    writeFileSync(path.join(r.dir, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 2;\n', 'utf8');
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');

    await addAllExceptNodeModules(r.dir);

    const staged = await stagedPaths(r.dir);
    expect(staged).toContain('src/feature.ts');
    expect(staged).toContain('node_modules/left-pad/index.js');
    const sha = await r.commitAll('vendored dependency update');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('CONTROL: the pathspec form this replaced is still fatal on this git, with the same tree', async () => {
    // Pins WHY the helper changed, and fails loudly if anyone reinstates the
    // exclude pathspec: on git >= 2.55 the `:(exclude)node_modules` ITEM counts
    // as explicitly naming an ignored path, so the command dies before staging
    // anything. If a future git stops doing this, this test goes red and the
    // decision can be revisited on evidence rather than memory.
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'node_modules');
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');

    const thrown: unknown = await runGit(['add', '-A', '--', '.', ':(exclude)node_modules'], r.dir).catch(
      (e: unknown) => e,
    );

    expect(isWorktreeError(thrown)).toBe(true);
    expect(String(thrown)).toMatch(/ignored by one of your \.gitignore files/i);
    // Note the failure mode is not even clean: git stages what it can and THEN
    // reports the ignored path with exit 1, so the old helper threw over a
    // half-staged index and the commit never ran — the round's work sat staged
    // and uncommitted.
    expect(await stagedPaths(r.dir)).toEqual(['src/feature.ts']);

    // The replacement handles the identical tree and commits cleanly.
    await addAllExceptNodeModules(r.dir);
    expect(await stagedPaths(r.dir)).toEqual(['src/feature.ts']);
  });

  // MED-8: a repo path may legitimately begin with a colon. Git would parse the
  // leading `:(...)` of an unprefixed pathspec as PATHSPEC MAGIC rather than as
  // part of the path, so the reset matched nothing, exited 0, and left the
  // node_modules entries STAGED — the invariant silently broken by a "successful"
  // command. Verified against real git before the fix.
  it('unstages a node_modules under a path that LOOKS like pathspec magic', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, ':(top)foo/node_modules');
    await r.writeFile(':(top)foo/app.ts', 'export const app = 1;\n');

    await addAllExceptNodeModules(r.dir);

    const staged = await stagedPaths(r.dir);
    expect(staged).toContain(':(top)foo/app.ts'); // the real work is staged...
    expect(staged.some((p) => p.includes('node_modules'))).toBe(false); // ...the tree is not
  });

  it('FAILS CLOSED with its own error kind when the index cannot be made safe', async () => {
    // Drives the INVARIANT GUARD directly, so the refusal branch is genuinely
    // reached rather than short-circuited by an earlier git failure (the previous
    // shape used a stale index.lock, which made `git add` throw first and never
    // exercised this at all).
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'node_modules');
    await r.run(['add', '-f', '--', 'node_modules']);
    expect((await stagedPaths(r.dir)).some((p) => p.includes('node_modules'))).toBe(true);

    const thrown: unknown = await assertIndexFreeOfNodeModules(r.dir).catch((e: unknown) => e);

    expect(isWorktreeError(thrown)).toBe(true);
    expect((thrown as WorktreeError).kind).toBe('node_modules_still_staged');
    expect(String(thrown)).toMatch(/remain STAGED/i);
  });

  it('the invariant guard PASSES (and the second index read is load-bearing) when nothing is staged', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'node_modules');
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');
    await addAllExceptNodeModules(r.dir);

    // No node_modules entry ever entered the index, so `unstageNodeModules` ran
    // no reset at all — and the guard still has to confirm it independently.
    expect(await unstageNodeModules(r.dir)).toEqual([]);
    await expect(assertIndexFreeOfNodeModules(r.dir)).resolves.toBeUndefined();
  });
});

// REGRESSION 4 (round 10) — the two cases side by side, both shapes MAIN handles.
describe('F10 exclusion is scoped to the ENGINE tree, not to every node_modules', () => {
  it('a tracked vendored NESTED node_modules stays staged and COMMITS (as on main)', async () => {
    const r = await repoWithIgnore(''); // no ignore rule: this tree is user content
    plantNodeModules(r.dir, 'vendor/web/node_modules');
    await r.writeFile('vendor/web/app.ts', 'export const web = 1;\n');

    await addAllExceptNodeModules(r.dir);
    const sha = await r.commitAll('vendored dependencies');

    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    const tree = (await r.run(['ls-tree', '-r', '--name-only', 'HEAD'])).trim().split('\n');
    expect(tree).toContain('vendor/web/node_modules/left-pad/index.js');
    expect(tree).toContain('vendor/web/app.ts');
    expect((await r.statusPorcelain()).trim()).toBe(''); // no post-verification dirt
  });

  it('a PROVISIONED (ignored) node_modules is still refused from the commit', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'node_modules');
    await r.writeFile('src/feature.ts', 'export const feature = true;\n');
    // Even force-added by an agent, the engine's tree never enters the commit.
    await r.run(['add', '-f', '--', 'node_modules']);

    await addAllExceptNodeModules(r.dir);
    await r.commitAll('the round');

    const tree = (await r.run(['ls-tree', '-r', '--name-only', 'HEAD'])).trim().split('\n');
    expect(tree).toContain('src/feature.ts');
    expect(tree.some((f) => f.includes('node_modules'))).toBe(false);
  });
});

describe('unstageNodeModules — F10 depth-aware unstage', () => {
  it('unstages IGNORED node_modules at every depth and leaves everything else staged', async () => {
    const r = await repoWithIgnore('node_modules/\n');
    plantNodeModules(r.dir, 'node_modules');
    plantNodeModules(r.dir, 'web/node_modules');
    await r.writeFile('web/app.ts', 'export const web = 1;\n');
    await r.run(['add', '-A']);
    // The ignore rule keeps them out of `add -A`, so FORCE them in — the round-4 #3
    // shape (an agent running `git add -f`). Force-adding must not launder the
    // engine's own tree past the guard.
    await r.run(['add', '-f', '--', 'node_modules', 'web/node_modules']);
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
    const r = await repoWithIgnore('node_modules/\n');
    await r.writeFile('src/node_modules_helper.ts', 'export const helper = 1;\n');
    await r.writeFile('src/my_node_modules/keep.ts', 'export const keep = 1;\n');
    await r.run(['add', '-A']);

    await unstageNodeModules(r.dir);

    expect(await stagedPaths(r.dir)).toEqual(['src/my_node_modules/keep.ts', 'src/node_modules_helper.ts']);
  });
});
