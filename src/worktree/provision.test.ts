/**
 * F7 — worktree dependency provisioning (engine-fix-worktree-deps-spec v3).
 *
 * Manager-level tests over REAL temp git repos (mirroring `manager.test.ts`
 * style): they exercise the REAL clone (`cp -c -R` via the default runtime, and a
 * symlink-preserving copy via the fake), the REAL out-of-worktree rename swap, the
 * REAL git ignore/HEAD plumbing, and the REAL fail-closed gate — faking only the
 * two genuinely heavy/host-specific host ops (a full `npm ci`, and APFS support
 * toggling) through the injected `ProvisionRuntime`. Covers the §6 test matrix:
 * git-invisibility, primary safety, manifest binding + clone-vs-install selection,
 * fail-closed, isolation + idempotency, transactional rollback + crash recovery,
 * and locking coverage.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { assignmentId, gitSha, type AssignmentId } from '../domain/ids.js';
import { GitWorktreeManager } from './manager.js';
import { WorktreeError, isWorktreeError, type WorktreeErrorKind } from './errors.js';
import { isPathIgnored, isPathTracked, runGit } from './git.js';
import {
  defaultProvisionRuntime,
  lstatSafe,
  provisionWorktreeDeps,
  PROVISION_MARKER_FILE,
  PROVISION_STAGE_SUBDIR,
  QUARANTINE_MARKER_FILE,
  QUARANTINE_TTL_MS,
  gcProvisionStages,
  scanSymlinkContainment,
  stageHoldsBackup,
  swapIntoPlace,
  type ProvisionGit,
  type ProvisionRuntime,
  type ProvisionStrategy,
  type ProvisionWarnEvent,
} from './provision.js';
import { readFileAtHead as realReadFileAtHead } from './git.js';

/** Every `old-*` backup dir currently under an assignment's stage namespace. */
function findBackups(assignmentStageRoot: string): string[] {
  const found: string[] = [];
  let stages: string[];
  try {
    stages = fs.readdirSync(assignmentStageRoot);
  } catch {
    return found;
  }
  for (const stage of stages) {
    const stageDir = path.join(assignmentStageRoot, stage);
    let inner: string[];
    try {
      inner = fs.readdirSync(stageDir);
    } catch {
      continue;
    }
    for (const child of inner) if (child.startsWith('old-')) found.push(path.join(stageDir, child));
  }
  return found;
}
import { makeTempGitRepo, type TempGitRepo } from './test-support.js';

const AUTHOR_ENV = {
  GIT_AUTHOR_NAME: 'f7-tests',
  GIT_AUTHOR_EMAIL: 'f7@harness.invalid',
  GIT_COMMITTER_NAME: 'f7-tests',
  GIT_COMMITTER_EMAIL: 'f7@harness.invalid',
} as const;

const DEFAULT_LOCK = JSON.stringify(
  { name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {} },
  null,
  2,
);

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
/** A temp git repo that declares dependencies, with a lockfile and (by default) a
 * `node_modules/` ignore rule — the shape provisioning acts on. */
async function makeDepsRepo(opts: {
  readonly deps?: Record<string, string>;
  /** F9: declared devDependencies — proven by the primary-tree check like `deps`. */
  readonly devDeps?: Record<string, string>;
  readonly lock?: string;
  readonly npmrc?: string;
  readonly ignore?: boolean;
  readonly prefix?: string;
} = {}): Promise<TempGitRepo> {
  const repo = await makeTempGitRepo(opts.prefix ?? 'harness-f7-');
  if (opts.ignore !== false) await repo.writeFile('.gitignore', 'node_modules/\n');
  await repo.writeFile(
    'package.json',
    `${JSON.stringify(
      {
        name: 'x',
        version: '1.0.0',
        dependencies: opts.deps ?? { 'left-pad': '1.0.0' },
        ...(opts.devDeps !== undefined ? { devDependencies: opts.devDeps } : {}),
      },
      null,
      2,
    )}\n`,
  );
  // ROUND 8: the fixture lockfile RESOLVES every declared package, as a real npm
  // lockfile does. `writeInstalledPackage` installs 1.0.0, so these agree; a test
  // that wants a version MISMATCH builds its own repo.
  const resolved: Record<string, { version: string }> = {};
  for (const name of Object.keys({ ...(opts.deps ?? { 'left-pad': '1.0.0' }), ...(opts.devDeps ?? {}) })) {
    resolved[`node_modules/${name}`] = { version: '1.0.0' };
  }
  await repo.writeFile(
    'package-lock.json',
    opts.lock ??
      `${JSON.stringify(
        { name: 'x', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'x' }, ...resolved } },
        null,
        2,
      )}\n`,
  );
  if (opts.npmrc !== undefined) await repo.writeFile('.npmrc', opts.npmrc);
  await repo.commitAll('deps');
  return repo;
}

/**
 * F9: writes an INSTALLED package dir under `nm`. `native:true` gives it a
 * `binding.gyp` + an install script (the better-sqlite3 shape the runtime smoke
 * targets); `built:false` leaves its entry point loading a `.node` that was never
 * compiled — the exact P1 breakage a script-less install produces.
 */
function writeInstalledPackage(
  nm: string,
  name: string,
  opts: { readonly native?: boolean; readonly built?: boolean } = {},
): void {
  const dir = path.join(nm, name);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = { name, version: '1.0.0', main: 'index.js' };
  if (opts.native === true) {
    manifest['scripts'] = { install: 'prebuild-install || node-gyp rebuild' };
    fs.writeFileSync(path.join(dir, 'binding.gyp'), '{ "targets": [] }\n');
    fs.writeFileSync(
      path.join(dir, 'index.js'),
      opts.built === false
        ? "module.exports = require('./build/Release/bind.node');\n" // never built -> load fails
        : 'module.exports = { native: true };\n',
    );
  } else {
    fs.writeFileSync(path.join(dir, 'index.js'), 'CLONE_SOURCE\n');
  }
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** A REAL on-disk primary `node_modules` (the clone source), with a safe relative
 * `.bin` link — exactly the shape a dev's installed tree has. Git-ignored, so it
 * sits on disk untracked, never committed. */
async function writePrimaryNodeModules(
  root: string,
  opts: {
    readonly withVite?: boolean;
    readonly badLink?: 'absolute' | 'escaping';
    /** F9: which declared packages actually exist in the tree (default `left-pad`). */
    readonly packages?: readonly string[];
    /** F9: a script-bearing native package, optionally left unbuilt. */
    readonly native?: { readonly name: string; readonly built: boolean };
  } = {},
): Promise<string> {
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
  for (const name of opts.packages ?? ['left-pad']) writeInstalledPackage(nm, name);
  if (opts.native !== undefined) {
    writeInstalledPackage(nm, opts.native.name, { native: true, built: opts.native.built });
  }
  // Safe relative link — present whenever `left-pad` is (the default tree shape).
  if (fs.existsSync(path.join(nm, 'left-pad'))) {
    await symlink('../left-pad/index.js', path.join(nm, '.bin', 'left-pad'));
  } else {
    fs.writeFileSync(path.join(nm, '.bin', 'placeholder'), '#!/bin/sh\n');
  }
  if (opts.withVite === true) {
    fs.mkdirSync(path.join(nm, '.vite'), { recursive: true });
    fs.writeFileSync(path.join(nm, '.vite', 'deps.json'), 'stale-cache\n');
  }
  if (opts.badLink === 'absolute') await symlink('/etc/passwd', path.join(nm, 'abs-link'));
  if (opts.badLink === 'escaping') await symlink('../../../../outside-target', path.join(nm, 'escape-link'));
  return nm;
}

interface FakeRuntime {
  readonly runtime: ProvisionRuntime;
  readonly calls: { clone: number; install: number };
}

/** A runtime that clones via a symlink-preserving copy and "installs" by writing a
 * distinctive fake tree — so a test can assert WHICH lane ran without a real
 * `npm ci`. `installImpl` can override the install to inject a failure. */
function fakeRuntime(opts: {
  readonly cloneSupported?: boolean;
  readonly platformKey?: string;
  readonly installImpl?: (cwd: string) => Promise<void>;
  /** F9: override the clone to inject a build failure (the install lane is gone,
   * so the clone is now the only build a rollback test can fault). */
  readonly cloneImpl?: (src: string, dst: string) => Promise<void>;
} = {}): FakeRuntime {
  const calls = { clone: 0, install: 0 };
  const runtime: ProvisionRuntime = {
    cloneSupported: opts.cloneSupported ?? true,
    platformKey: opts.platformKey ?? 'test-platform',
    async cloneDir(src, dst) {
      calls.clone += 1;
      if (opts.cloneImpl !== undefined) {
        await opts.cloneImpl(src, dst);
        return;
      }
      await cp(src, dst, { recursive: true, verbatimSymlinks: true });
    },
    async install(cwd) {
      calls.install += 1;
      if (opts.installImpl !== undefined) {
        await opts.installImpl(cwd);
        return;
      }
      const nm = path.join(cwd, 'node_modules');
      fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
      fs.mkdirSync(path.join(nm, 'installed-pkg'), { recursive: true });
      fs.writeFileSync(path.join(nm, 'installed-pkg', 'index.js'), 'FAKE_INSTALL\n');
      await symlink('../installed-pkg/index.js', path.join(nm, '.bin', 'installed'));
    },
  };
  return { runtime, calls };
}

let managers: GitWorktreeManager[] = [];
let repos: TempGitRepo[] = [];

async function openManager(
  repo: TempGitRepo,
  opts: {
    readonly runtime?: ProvisionRuntime;
    readonly provision?: ProvisionStrategy;
    readonly warn?: (event: ProvisionWarnEvent) => void;
    readonly provisionGit?: ProvisionGit;
    /** F9: the bounded-command deadline, shrunk so a hung fake seam is testable. */
    readonly timeoutMs?: number;
  } = {},
): Promise<GitWorktreeManager> {
  const manager = await GitWorktreeManager.open({
    primaryRepoRoot: repo.dir,
    clock: new ManualClock('2026-07-22T00:00:00.000Z'),
    provisionRuntime: opts.runtime ?? fakeRuntime().runtime,
    ...(opts.provision !== undefined ? { provision: opts.provision } : {}),
    ...(opts.warn !== undefined ? { provisionWarn: opts.warn } : {}),
    ...(opts.provisionGit !== undefined ? { provisionGit: opts.provisionGit } : {}),
    ...(opts.timeoutMs !== undefined ? { provisionTimeoutMs: opts.timeoutMs } : {}),
  });
  managers.push(manager);
  return manager;
}

async function createAtHead(repo: TempGitRepo, manager: GitWorktreeManager, id: AssignmentId) {
  return manager.createWorktree({ assignmentId: id, baseCommit: gitSha(await repo.headSha()) });
}

/** Commit whatever is currently in the worktree (simulating the implementor
 * editing manifests then committing), returning the new HEAD. */
async function commitInWorktree(worktreePath: string, message: string): Promise<void> {
  await runGit(['add', '-A'], worktreePath);
  await runGit(['commit', '--no-verify', '-m', message], worktreePath, AUTHOR_ENV);
}

afterEach(async () => {
  for (const manager of managers) {
    try {
      await rm(manager.baseDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  managers = [];
  for (const repo of repos) await repo.cleanup().catch(() => undefined);
  repos = [];
});

function track<T extends TempGitRepo>(repo: T): T {
  repos.push(repo);
  return repo;
}

// ===========================================================================
// AC-1 — git-invisibility (node_modules absent from status/diff/commit, survives
// `git clean -fd`, check-ignore asserted)
// ===========================================================================
describe('F7 AC-1 — git-invisibility of the provisioned node_modules', () => {
  it('provisions a REAL node_modules that git ignores, never commits, and survives `git clean -fd`', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const manager = await openManager(repo);
    const asg = assignmentId('asg_invisible');
    const handle = await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);
    expect(outcome.provisioned).toBe(true);
    expect(outcome.strategy).toBe('clone');

    const nm = path.join(handle.worktreePath, 'node_modules');
    // REAL directory (not a symlink), populated, with the fingerprint marker.
    expect(fs.lstatSync(nm).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(nm).isDirectory()).toBe(true);
    expect(readFileSync(path.join(nm, 'left-pad', 'index.js'), 'utf8')).toBe('CLONE_SOURCE\n');
    // HIGH-3: the marker is the v2 PROOF format — fingerprint + smoke attestation.
    expect(readFileSync(path.join(nm, PROVISION_MARKER_FILE), 'utf8')).toBe(`v2:${outcome.fingerprint}`);

    // Invisible to git: plain status/diff clean; --ignored shows it; check-ignore
    // asserts the rule matches; clean -fd (no -x) does NOT remove it.
    expect((await runGit(['status', '--porcelain'], handle.worktreePath)).stdout.trim()).toBe('');
    expect((await runGit(['diff', '--name-only', String(handle.baseSha)], handle.worktreePath)).stdout.trim()).toBe('');
    expect((await runGit(['status', '--porcelain', '--ignored'], handle.worktreePath)).stdout).toContain('node_modules/');
    expect((await runGit(['check-ignore', 'node_modules'], handle.worktreePath)).stdout.trim()).toBe('node_modules');
    await runGit(['clean', '-fd'], handle.worktreePath);
    expect(existsSync(nm)).toBe(true);
    expect(existsSync(path.join(nm, 'left-pad', 'index.js'))).toBe(true);
  });

  it('uses the REAL default runtime (`cp -c -R` APFS clone) end to end', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    // The real runtime: real APFS clone; install would be real `npm ci` but the
    // fingerprint matches the primary here, so ONLY the clone path runs.
    const manager = await openManager(repo, { runtime: defaultProvisionRuntime() });
    const asg = assignmentId('asg_real_clone');
    const handle = await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);
    expect(outcome.strategy).toBe('clone');
    const nm = path.join(handle.worktreePath, 'node_modules');
    expect(readFileSync(path.join(nm, 'left-pad', 'index.js'), 'utf8')).toBe('CLONE_SOURCE\n');
    expect((await runGit(['status', '--porcelain'], handle.worktreePath)).stdout.trim()).toBe('');
  });

  it('a repo whose committed manifests declare NO dependencies is provisioned-trivially-true (no node_modules created)', async () => {
    // makeTempGitRepo has only README — no package.json → no deps.
    const repo = track(await makeTempGitRepo('harness-f7-nodeps-'));
    const manager = await openManager(repo);
    const asg = assignmentId('asg_nodeps');
    const handle = await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);
    expect(outcome.provisioned).toBe(true);
    expect(outcome.strategy).toBe('none');
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(false);
  });
});

// ===========================================================================
// AC-2 — primary safety (primary node_modules survives every deletion path)
// ===========================================================================
describe('F7 AC-2 — the primary checkout node_modules is never touched', () => {
  it('survives removeWorktree, discardToCommit (`git clean -fd`), and rm(baseDir)', async () => {
    const repo = track(await makeDepsRepo());
    const primaryNm = await writePrimaryNodeModules(repo.dir);
    const primaryFile = path.join(primaryNm, 'left-pad', 'index.js');
    const manager = await openManager(repo);
    const asg = assignmentId('asg_primary_safe');
    const handle = await createAtHead(repo, manager, asg);
    await manager.provisionForVerification(asg);

    // discardToCommit runs `git clean -fd` (no -x) in the worktree — the worktree's
    // own node_modules (ignored) survives, and the primary is untouched.
    await manager.discardToCommit(asg, handle.baseSha);
    expect(existsSync(primaryFile)).toBe(true);
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', 'left-pad', 'index.js'))).toBe(true);

    await manager.removeWorktree(asg);
    expect(existsSync(primaryFile)).toBe(true);
    expect(existsSync(handle.worktreePath)).toBe(false);

    await rm(manager.baseDir, { recursive: true, force: true });
    expect(existsSync(primaryFile)).toBe(true);
  });
});

// ===========================================================================
// AC-3 — boundary + manifest binding (reprovision on lock/pkg/workspace/.npmrc
// change; clone-vs-install selection by fingerprint; never clone an unproven source)
// ===========================================================================
describe('F7 AC-3 — clone-vs-install selection by dependency fingerprint', () => {
  it('CLONE when the committed fingerprint matches the primary + APFS is available', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_clone');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    expect(fake.calls).toEqual({ clone: 1, install: 0 });
  });

  // F9: the four rows below all USED to select the install lane. The invariant
  // they encode ("never clone an unproven source") is unchanged and still proven;
  // what changed is the ALTERNATIVE — there is no install lane to fall to, because
  // a `--ignore-scripts` install cannot produce a provable tree. Each is now a
  // cause-coded refusal.
  it('the primary node_modules being ABSENT is a refusal, not an install (never clone a missing source)', async () => {
    const repo = track(await makeDepsRepo());
    // No writePrimaryNodeModules → primary absent.
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_install_absent');
    const handle = await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
    expect(error.provisioningCause).toBe('primary_tree_stale');
    expect(fake.calls).toEqual({ clone: 0, install: 0 });
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(false);
  });

  it('a HOLLOW primary node_modules is a refusal, not an install (never clone nothing)', async () => {
    const repo = track(await makeDepsRepo());
    fs.mkdirSync(path.join(repo.dir, 'node_modules'), { recursive: true }); // empty/hollow
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_install_hollow');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
    expect(error.provisioningCause).toBe('primary_tree_stale');
    expect(fake.calls).toEqual({ clone: 0, install: 0 });
  });

  it('a primary that DRIFTED from the committed manifests is a refusal, not an install', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_install_drift');
    await createAtHead(repo, manager, asg);
    // Drift the PRIMARY working-tree manifest AFTER worktree creation — its
    // node_modules no longer corresponds to the committed fingerprint.
    await writeFile(
      path.join(repo.dir, 'package.json'),
      `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'right-pad': '9.9.9' } }, null, 2)}\n`,
    );

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
    expect(error.provisioningCause).toBe('primary_manifests_diverged');
    expect(fake.calls).toEqual({ clone: 0, install: 0 });
  });

  it('a non-APFS host is a refusal, not an install (with a clone_unsupported warning)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime({ cloneSupported: false });
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_non_apfs');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
    expect(error.provisioningCause).toBe('clone_unsupported');
    expect(fake.calls).toEqual({ clone: 0, install: 0 });
    expect(warnings.some((w) => w.kind === 'clone_unsupported')).toBe(true);
  });

  it.each([
    // ROUND 8: a VALID lockfile whose bytes differ — the fingerprint must change,
    // but the lock must still resolve the declared package (an unparseable one is
    // now a refusal in its own right, which is a different test).
    [
      'package-lock.json only',
      async (root: string) =>
        writeFile(
          path.join(root, 'package-lock.json'),
          `${JSON.stringify(
            {
              name: 'x',
              version: '1.0.0',
              lockfileVersion: 3,
              requires: true,
              bumped: true,
              packages: { '': { name: 'x' }, 'node_modules/left-pad': { version: '1.0.0' } },
            },
            null,
            2,
          )}\n`,
        ),
    ],
    ['package.json only', async (root: string) => writeFile(path.join(root, 'package.json'), `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '2.0.0' } }, null, 2)}\n`)],
    ['.npmrc', async (root: string) => writeFile(path.join(root, '.npmrc'), 'registry=https://example.test/\n')],
  ])(
    'a committed %s change REPROVISIONS (fingerprint marker mismatch), and an unchanged re-run is a no-op',
    async (_label, mutate) => {
      const repo = track(await makeDepsRepo());
      await writePrimaryNodeModules(repo.dir);
      const fake = fakeRuntime();
      const manager = await openManager(repo, { runtime: fake.runtime });
      const asg = assignmentId('asg_rebind');
      const handle = await createAtHead(repo, manager, asg);

      expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
      expect(fake.calls.clone).toBe(1);

      // Idempotent: unchanged manifests short-circuit on the marker.
      expect((await manager.provisionForVerification(asg)).strategy).toBe('short_circuit');
      expect(fake.calls.clone).toBe(1);

      // F9: a manifest change reprovisions ONLY when the primary moved WITH it —
      // the fingerprint binds the worktree's committed manifests to the primary's
      // installed ones, and a worktree-only change is now the `deps_changed_in_worktree`
      // refusal (proven in the F9 AC-1 block). Move BOTH, as the engine track does.
      await mutate(handle.worktreePath);
      await commitInWorktree(handle.worktreePath, 'edit manifest');
      await mutate(repo.dir);
      expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
      expect(fake.calls.clone).toBe(2);
    },
  );

  // Round-2 #5: npm workspaces are UNSUPPORTED — ANY `workspaces` declaration on the
  // committed root package.json FAILS CLOSED (never a clone / install / trivial
  // success), so a workspace repo can never false-green by fingerprinting only the
  // root and silently missing workspace-local dependencies. Normalize-or-reject ALL
  // syntax: literal / `*` / `**` / `./packages/*` / partial-segment globs, the
  // `{ packages: [] }` object form, an empty array, and non-array/malformed values.
  describe('any `workspaces` declaration on the root package.json FAILS CLOSED (workspaces unsupported)', () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ['./packages/* (npm strips the leading ./)', ['./packages/*']],
      ['packages/* (single-segment glob)', ['packages/*']],
      ['packages/** (globstar)', ['packages/**']],
      ['pkg-* (partial-segment glob)', ['pkg-*']],
      ['{ packages: [...] } object form', { packages: ['packages/*'] }],
      ['a non-array string (malformed)', 'packages/*'],
      ['an empty array (declares workspaces, no members)', []],
    ];
    for (const [label, workspaces] of cases) {
      it(`workspaces = ${label} → provisioning_failed`, async () => {
        const repo = track(await makeTempGitRepo('harness-f7-ws-'));
        await repo.writeFile('.gitignore', 'node_modules/\n');
        await repo.writeFile(
          'package.json',
          `${JSON.stringify({ name: 'root', version: '1.0.0', private: true, workspaces }, null, 2)}\n`,
        );
        await repo.writeFile('package-lock.json', DEFAULT_LOCK);
        // A workspace member that DECLARES deps — the exact false-green risk if the
        // root-only fingerprint reached trivial success while missing this tree.
        await repo.writeFile(
          'packages/a/package.json',
          `${JSON.stringify({ name: 'a', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }, null, 2)}\n`,
        );
        await repo.commitAll('workspace repo');
        await writePrimaryNodeModules(repo.dir); // a cloneable primary must NOT rescue it
        const manager = await openManager(repo);
        const asg = assignmentId('asg_ws_failclosed');
        await createAtHead(repo, manager, asg);
        await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
      });
    }
  });
});

// ===========================================================================
// AC-4 — fail-closed (no accidental false pass)
// ===========================================================================
describe('F7 AC-4 — fail closed (a global tsc/vitest on PATH can never green it)', () => {
  it('a repo where node_modules is NOT git-ignored → provisioning_failed (never provisions)', async () => {
    const repo = track(await makeDepsRepo({ ignore: false }));
    await writePrimaryNodeModules(repo.dir);
    const manager = await openManager(repo);
    const asg = assignmentId('asg_no_ignore');
    const handle = await createAtHead(repo, manager, asg);

    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
    // Nothing was placed in the worktree, and nothing enters a commit.
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(false);
    expect((await runGit(['status', '--porcelain'], handle.worktreePath)).stdout.trim()).toBe('');
  });

  it('a repo where a node_modules path is TRACKED → provisioning_failed even with an ignore rule', async () => {
    const repo = track(await makeDepsRepo());
    // Force-commit a node_modules file despite the ignore rule (tracked wins).
    await repo.writeFile('node_modules/committed.js', 'tracked\n');
    await runGit(['add', '-f', 'node_modules/committed.js'], repo.dir);
    await runGit(['commit', '--no-verify', '-m', 'track node_modules'], repo.dir, AUTHOR_ENV);
    const manager = await openManager(repo);
    const asg = assignmentId('asg_tracked');
    await createAtHead(repo, manager, asg);

    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
  });

  it('when npm ci fails and no clone is possible → provisioning_failed (no fake-green tree)', async () => {
    const repo = track(await makeDepsRepo()); // primary absent → install lane
    const fake = fakeRuntime({
      installImpl: async () => {
        throw new Error('npm ci exploded');
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_install_fail');
    const handle = await createAtHead(repo, manager, asg);

    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(false);
  });
});

// ===========================================================================
// AC-5 — isolation + idempotency (.vite purged, double-provision no-op, symlink scan)
// ===========================================================================
describe('F7 AC-5 — isolation, cache purge, idempotency, and the symlink scan', () => {
  it('purges a cloned node_modules/.vite so stale cache state is never inherited', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir, { withVite: true });
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_vite');
    const handle = await createAtHead(repo, manager, asg);

    await manager.provisionForVerification(asg);
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', '.vite'))).toBe(false);
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', 'left-pad'))).toBe(true);
    expect(warnings.some((w) => w.kind === 'cache_purged')).toBe(true);
  });

  it('double provisioning is a no-op (fingerprint marker short-circuit)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_idem');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    expect((await manager.provisionForVerification(asg)).strategy).toBe('short_circuit');
    expect((await manager.provisionForVerification(asg)).strategy).toBe('short_circuit');
    expect(fake.calls).toEqual({ clone: 1, install: 0 });
  });

  it('scanSymlinkContainment (H7): worktree-relative + workspace links pass, absolute/escaping fail, traversal error is fatal', async () => {
    // Model a staged node_modules whose EVENTUAL home is <worktree>/node_modules.
    const worktree = await mkdtemp(path.join(tmpdir(), 'harness-f7-scan-'));
    const stage = path.join(worktree, '.provision', 'stage', 'node_modules');
    const scanFor = () => ({
      stageTreeRoot: stage,
      eventualTreeRoot: path.join(worktree, 'node_modules'),
      containmentRoot: worktree,
    });
    try {
      fs.mkdirSync(path.join(stage, '.bin'), { recursive: true });
      fs.mkdirSync(path.join(stage, 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(worktree, 'packages', 'w'), { recursive: true });
      fs.writeFileSync(path.join(stage, 'pkg', 'index.js'), 'x\n');
      await symlink('../pkg/index.js', path.join(stage, '.bin', 'ok')); // in-node_modules
      // H7: a standard npm-workspace link node_modules/w -> ../packages/w resolves,
      // from the EVENTUAL <worktree>/node_modules, into the worktree → SAFE.
      await symlink('../packages/w', path.join(stage, 'w'));
      expect(await scanSymlinkContainment(scanFor())).toEqual([]);

      await symlink('/etc/passwd', path.join(stage, 'abs'));
      await symlink('../../../../escape', path.join(stage, 'esc')); // out of the worktree
      const bad = await scanSymlinkContainment(scanFor());
      expect(bad.some((p) => p.endsWith('/abs'))).toBe(true);
      expect(bad.some((p) => p.endsWith('/esc'))).toBe(true);
      expect(bad.some((p) => p.endsWith('/ok'))).toBe(false);
      expect(bad.some((p) => p.endsWith('/w'))).toBe(false);

      // B6: a scan that cannot read the tree at all is FATAL (fail closed).
      await expectRejectsWithKind(
        scanSymlinkContainment({ ...scanFor(), stageTreeRoot: path.join(worktree, 'does-not-exist') }),
        'provisioning_failed',
      );
    } finally {
      await rm(worktree, { recursive: true, force: true });
    }
  });

  // F9 (§4): this row used to prove the `auto` retry-as-install. That retry is gone
  // with the install lane, so `auto` now behaves exactly like `clone` here — which
  // is the point: the config no longer promises a lane it does not have.
  it('a CLONE containing an escaping link FAILS CLOSED under auto too (no lane switch)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir, { badLink: 'escaping' });
    const fake = fakeRuntime();
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_badlink_fallback');
    const handle = await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
    expect(error.provisioningCause).toBe('unsafe_clone_symlinks');
    expect(fake.calls).toEqual({ clone: 1, install: 0 });
    expect(warnings.some((w) => w.kind === 'clone_symlinks_unsafe')).toBe(true);
    // Nothing landed in the worktree — the unsafe tree never got near it.
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(false);
  });

  it('a forced-clone strategy with an unsafe link FAILS CLOSED (no install fallback)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir, { badLink: 'absolute' });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime, provision: 'clone' });
    const asg = assignmentId('asg_badlink_closed');
    const handle = await createAtHead(repo, manager, asg);

    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
    expect(fake.calls).toEqual({ clone: 1, install: 0 });
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(false);
  });

  it('FAILS CLOSED on a symlinked node_modules WITHOUT mutating it (B1/B8: never unlink before the checks)', async () => {
    const repo = track(await makeDepsRepo());
    const primaryNm = await writePrimaryNodeModules(repo.dir);
    const manager = await openManager(repo);
    const asg = assignmentId('asg_symlink_nm');
    const handle = await createAtHead(repo, manager, asg);
    const nm = path.join(handle.worktreePath, 'node_modules');
    // Plant a symlinked node_modules → primary (the codex-v1 primitive we reject).
    await symlink(primaryNm, nm);
    expect(fs.lstatSync(nm).isSymbolicLink()).toBe(true);

    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
    // The link is UNCHANGED (not unlinked), the primary target is intact, and the
    // worktree is not mutated into a dirty deletion.
    expect(fs.lstatSync(nm).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(primaryNm, 'left-pad', 'index.js'))).toBe(true);
  });
});

// ===========================================================================
// AC-6 — transactional degrade + crash recovery (nothing staged inside the worktree)
// ===========================================================================
describe('F7 AC-6 — transactional rollback and crash recovery', () => {
  // F9: the build being faulted here is the CLONE, not the (now removed) install
  // lane. The invariant is untouched: a failed BUILD never disturbs the tree
  // already in the worktree, never leaves anything staged inside it, and a later
  // successful call recovers.
  it('a build failure leaves a pre-existing tree intact, nothing staged inside the worktree, and recovers next call', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    let failClone = false;
    const fake = fakeRuntime({
      cloneImpl: async (src, dst) => {
        if (failClone) throw new Error('clone boom');
        await cp(src, dst, { recursive: true, verbatimSymlinks: true });
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_rollback');
    const handle = await createAtHead(repo, manager, asg);

    // First provision succeeds — a real tree lands.
    await manager.provisionForVerification(asg);
    expect(readFileSync(path.join(handle.worktreePath, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('CLONE_SOURCE\n');

    // A manifest change on BOTH sides forces a rebuild; make THAT clone fail.
    const bumped = `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '3.0.0' } }, null, 2)}\n`;
    await writeFile(path.join(handle.worktreePath, 'package.json'), bumped);
    await commitInWorktree(handle.worktreePath, 'bump');
    await writeFile(path.join(repo.dir, 'package.json'), bumped);
    failClone = true;
    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');

    // The PRE-EXISTING tree is intact (rollback: the prior tree was never removed —
    // the swap is only reached after a successful build), and NOTHING is staged
    // inside the worktree (no node_modules.tmp-*; git status still clean).
    expect(readFileSync(path.join(handle.worktreePath, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('CLONE_SOURCE\n');
    expect((await runGit(['status', '--porcelain'], handle.worktreePath)).stdout.trim()).toBe('');
    const insideWorktree = fs.readdirSync(handle.worktreePath).filter((n) => n.startsWith('node_modules.tmp'));
    expect(insideWorktree).toEqual([]);

    // Recovery: a later successful call reprovisions.
    failClone = false;
    await manager.provisionForVerification(asg);
    expect(readFileSync(path.join(handle.worktreePath, 'node_modules', 'left-pad', 'index.js'), 'utf8')).toBe('CLONE_SOURCE\n');
  });

  it('a stage GC preflight adopts/removes an abandoned stage dir from a prior crash', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const manager = await openManager(repo);
    const asg = assignmentId('asg_stage_gc');
    await createAtHead(repo, manager, asg);
    // Simulate a crashed provisioning: an abandoned stage dir inside this
    // assignment's per-assignment namespace dir (#5: `<.provision>/<slug>/<stage>`).
    const stageRoot = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR);
    const abandoned = path.join(stageRoot, String(asg), 'crashed');
    fs.mkdirSync(path.join(abandoned, 'old-deadbeef'), { recursive: true });
    fs.writeFileSync(path.join(abandoned, 'old-deadbeef', 'junk'), 'x\n');

    const outcome = await manager.provisionForVerification(asg);
    expect(existsSync(abandoned)).toBe(false); // GC'd by the crash-recovery preflight
    expect(outcome.provisioned).toBe(true); // and provisioning still succeeded cleanly
  });

  it('removeWorktree GCs the assignment stage dirs', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const manager = await openManager(repo);
    const asg = assignmentId('asg_remove_gc');
    await createAtHead(repo, manager, asg);
    const stageRoot = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR);
    const leftover = path.join(stageRoot, String(asg), 'leftover');
    fs.mkdirSync(leftover, { recursive: true });

    await manager.removeWorktree(asg);
    expect(existsSync(leftover)).toBe(false);
  });
});

// ===========================================================================
// AC-7 — locking coverage (one mutex+lease-held op; reprovision after discardToCommit)
// ===========================================================================
describe('F7 AC-7 — locking + boundary coverage', () => {
  it('holds the git-op mutex for the whole provisioning (a concurrent worktree op serializes behind it)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // F9: the clone is the only build lane now, so it is what holds the lock.
    const fake = fakeRuntime({
      cloneImpl: async (src, dst) => {
        await gate; // hold the lock until the test releases it
        await cp(src, dst, { recursive: true, verbatimSymlinks: true });
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_lock');
    await createAtHead(repo, manager, asg);

    const provisioning = manager.provisionForVerification(asg);
    // While provisioning holds the lock, the observable git-op lease is this
    // assignment's op (proof it runs under the mutex, like createWorktree).
    let observed: string | undefined;
    for (let i = 0; i < 50 && observed === undefined; i += 1) {
      observed = manager.currentGitOpLease()?.assignmentId !== undefined ? String(manager.currentGitOpLease()?.assignmentId) : undefined;
      if (observed === undefined) await sleep(2);
    }
    expect(observed).toBe(String(asg));

    // A concurrent createWorktree for a DIFFERENT assignment queues behind it.
    const other = assignmentId('asg_lock_other');
    const concurrent = manager.createWorktree({ assignmentId: other, baseCommit: gitSha(await repo.headSha()) });
    await sleep(10);
    expect(manager.handleFor(other)).toBeUndefined(); // still queued behind provisioning

    release();
    await provisioning;
    await concurrent;
    expect(manager.handleFor(other)).toBeDefined();
  });

  it('reprovisions against the forced HEAD after discardToCommit (resume-after-discard boundary)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_discard_reprovision');
    const handle = await createAtHead(repo, manager, asg);

    // Provision at base, then move BOTH manifests (F9: a worktree-only manifest
    // change is now the `deps_changed_in_worktree` refusal) and provision again.
    await manager.provisionForVerification(asg);
    expect(fake.calls.clone).toBe(1);
    const changed = `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '5.0.0' } }, null, 2)}\n`;
    await writeFile(path.join(handle.worktreePath, 'package.json'), changed);
    await commitInWorktree(handle.worktreePath, 'changed');
    await writeFile(path.join(repo.dir, 'package.json'), changed);
    const changedHead = gitSha((await runGit(['rev-parse', 'HEAD'], handle.worktreePath)).stdout.trim());
    await manager.provisionForVerification(asg);
    expect(fake.calls.clone).toBe(2); // reprovisioned for the new fingerprint

    // Discard back to the changed commit: the ignored node_modules survives with
    // the matching marker, so the next provision short-circuits (fingerprint held).
    await manager.discardToCommit(asg, changedHead);
    expect((await manager.provisionForVerification(asg)).strategy).toBe('short_circuit');
    expect(fake.calls.clone).toBe(2);
  });
});

// ===========================================================================
// Codex diff-review fixes (B1–B5, B8): definitive checks before any trivial
// success, `.bin` proof, git/parse errors fail closed, crash-recovery restore,
// unresolvable workspace fail-closed.
// ===========================================================================
function hasBin(nodeModules: string): boolean {
  return existsSync(path.join(nodeModules, '.bin'));
}

describe('F7 B1/B8 — definitive node_modules checks run BEFORE the no-dependency shortcut', () => {
  it('a no-dep repo with an ignored node_modules SYMLINK → fail closed, link + primary UNCHANGED (never unlink)', async () => {
    const repo = track(await makeTempGitRepo('harness-f7-nodep-symlink-'));
    await repo.writeFile('.gitignore', 'node_modules/\n');
    await repo.writeFile('README.md', '# no deps\n'); // no package.json → dep-free
    await repo.commitAll('no-deps + ignore rule');
    const primaryNm = await writePrimaryNodeModules(repo.dir);
    const manager = await openManager(repo);
    const asg = assignmentId('asg_nodep_symlink');
    const handle = await createAtHead(repo, manager, asg);
    const nm = path.join(handle.worktreePath, 'node_modules');
    await symlink(primaryNm, nm); // ignored symlink → primary (write-through risk)

    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
    // B8: not unlinked (checked before any mutation); B1: the no-deps shortcut did
    // NOT let the symlink survive; primary untouched.
    expect(fs.lstatSync(nm).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(primaryNm, 'left-pad', 'index.js'))).toBe(true);
  });

  it('a TRACKED node_modules fails closed EVEN with no declared dependencies (B1)', async () => {
    const repo = track(await makeTempGitRepo('harness-f7-tracked-nodep-'));
    await repo.writeFile('.gitignore', 'node_modules/\n');
    await repo.writeFile('README.md', '# no deps\n'); // no package.json
    await repo.writeFile('node_modules/committed.js', 'tracked\n');
    await runGit(['add', '-f', 'node_modules/committed.js'], repo.dir);
    await runGit(['add', 'README.md', '.gitignore'], repo.dir);
    await runGit(['commit', '--no-verify', '-m', 'tracked node_modules, no deps'], repo.dir, AUTHOR_ENV);
    const manager = await openManager(repo);
    const asg = assignmentId('asg_tracked_nodep');
    await createAtHead(repo, manager, asg);

    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
  });
});

describe('F7 B2 — never accept/short-circuit a tree without a real node_modules/.bin', () => {
  it('never short-circuits when .bin is missing even if the marker matches — rebuilds', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_bin_gone');
    const handle = await createAtHead(repo, manager, asg);
    await manager.provisionForVerification(asg); // clone #1 → tree with .bin + marker
    expect(fake.calls.clone).toBe(1);
    const nm = path.join(handle.worktreePath, 'node_modules');
    // Corrupt the tree: remove .bin but KEEP the (still-matching) marker.
    fs.rmSync(path.join(nm, '.bin'), { recursive: true, force: true });
    expect(hasBin(nm)).toBe(false);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone'); // NOT short_circuit
    expect(fake.calls.clone).toBe(2);
    expect(hasBin(nm)).toBe(true); // rebuilt with a real .bin
  });

  it('a primary node_modules populated but with NO .bin is refused (broken clone source, no install to fall to)', async () => {
    const repo = track(await makeDepsRepo());
    // A primary node_modules with a package but NO `.bin` — a broken clone source.
    fs.mkdirSync(path.join(repo.dir, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, 'node_modules', 'left-pad', 'index.js'), 'x\n');
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_primary_no_bin');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
    expect(error.provisioningCause).toBe('primary_tree_stale');
    expect(fake.calls).toEqual({ clone: 0, install: 0 });
  });
});

describe('F7 B3 — git/manifest ERRORS fail closed (never classified as safe absence)', () => {
  it('a git error reading the committed HEAD manifests → provisioning_failed (not no-deps)', async () => {
    const repo = track(await makeDepsRepo());
    const manager = await openManager(repo, {
      // Inject a git seam whose HEAD read fails (simulating `git show` exit 128).
      provisionGit: {
        isPathIgnored: async () => true,
        isPathTracked: async () => false,
        readFileAtHead: async () => {
          throw new WorktreeError('git_command_failed', 'simulated git show exit 128');
        },
      },
    });
    const asg = assignmentId('asg_git_show_err');
    await createAtHead(repo, manager, asg);

    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
  });

  it('a git error resolving tracked/ignored status → provisioning_failed', async () => {
    const repo = track(await makeDepsRepo());
    const manager = await openManager(repo, {
      provisionGit: {
        isPathIgnored: async () => {
          throw new WorktreeError('git_command_failed', 'simulated ls-files exit 128');
        },
        isPathTracked: async () => false,
        readFileAtHead: realReadFileAtHead,
      },
    });
    const asg = assignmentId('asg_ignore_err');
    await createAtHead(repo, manager, asg);

    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
  });

  it('a malformed committed package.json → provisioning_failed (never treated as no-deps)', async () => {
    const repo = track(await makeTempGitRepo('harness-f7-malformed-'));
    await repo.writeFile('.gitignore', 'node_modules/\n');
    await repo.writeFile('package.json', '{ this is : not valid json ');
    await repo.commitAll('malformed manifest');
    const manager = await openManager(repo);
    const asg = assignmentId('asg_malformed');
    await createAtHead(repo, manager, asg);

    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
  });
});

describe('F7 B4 — crash-recovery restores the only rollback copy', () => {
  it('crash after move-aside + a FAILING rebuild → the prior valid tree is RESTORED', async () => {
    // F9: the build being faulted is the CLONE (the install lane is gone); the
    // crash-recovery invariant under test is unchanged.
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    fs.writeFileSync(path.join(repo.dir, 'node_modules', 'gen.txt'), 'ORIGINAL\n');
    let failClone = false;
    const fake = fakeRuntime({
      cloneImpl: async (src, dst) => {
        if (failClone) throw new Error('rebuild boom');
        await cp(src, dst, { recursive: true, verbatimSymlinks: true });
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_b4_restore');
    const handle = await createAtHead(repo, manager, asg);
    await manager.provisionForVerification(asg); // GEN tree lands (marker = fp1)
    const nm = path.join(handle.worktreePath, 'node_modules');
    expect(readFileSync(path.join(nm, 'gen.txt'), 'utf8')).toBe('ORIGINAL\n');

    // A manifest change on BOTH sides makes the fingerprint fp2 (so the restored
    // tree's fp1 marker will NOT short-circuit — a rebuild is genuinely attempted).
    const bumped = `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '9.9.9' } }, null, 2)}\n`;
    await writeFile(path.join(handle.worktreePath, 'package.json'), bumped);
    await commitInWorktree(handle.worktreePath, 'bump deps');
    await writeFile(path.join(repo.dir, 'package.json'), bumped);

    // Simulate a crash AFTER move-aside, BEFORE move-in: the old (fp1) tree sits in a
    // stage as `old-*` (inside this assignment's namespace dir, #5), and the worktree
    // has NO node_modules.
    const crashStage = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg), 'crash');
    fs.mkdirSync(crashStage, { recursive: true });
    fs.renameSync(nm, path.join(crashStage, 'old-deadbeef'));
    expect(existsSync(nm)).toBe(false);

    // Force the rebuild to FAIL. The GC preflight RESTORES the old tree first, so the
    // previously-valid tree survives even though the (fp2) rebuild throws.
    failClone = true;
    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
    expect(existsSync(nm)).toBe(true);
    expect(readFileSync(path.join(nm, 'gen.txt'), 'utf8')).toBe('ORIGINAL\n'); // restored, not lost
  });
});

// ===========================================================================
// Round-2 #4 — a FAILED restore must PRESERVE the sole backup and fail closed
// ===========================================================================
describe('F7 round-2 #4 — a failed crash-recovery restore preserves the only backup', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(isRoot)(
    'when restoring the sole `old-*` backup FAILS, the backup is preserved and provisioning fails closed',
    async () => {
      const repo = track(await makeDepsRepo()); // deps declared → provisioning is attempted
      const manager = await openManager(repo, { runtime: fakeRuntime().runtime });
      const asg = assignmentId('asg_restore_fail');
      const handle = await createAtHead(repo, manager, asg);
      const nm = path.join(handle.worktreePath, 'node_modules');

      // Simulate a crash AFTER move-aside, BEFORE move-in: the ONLY surviving copy of
      // the prior valid tree sits in a stage as `old-*` (inside this assignment's
      // namespace dir, #5), and the worktree has none.
      const crashStage = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg), 'crash');
      const backup = path.join(crashStage, 'old-deadbeef');
      fs.mkdirSync(backup, { recursive: true });
      fs.writeFileSync(path.join(backup, 'gen.txt'), 'ONLY_COPY\n');
      expect(existsSync(nm)).toBe(false);

      // Make the restore rename FAIL deterministically: a read-only stage dir cannot
      // have its `old-*` child renamed out (EACCES on the parent). The crash-recovery
      // preflight must NOT swallow that and delete the stage — it must preserve the
      // backup and fail closed so it stays recoverable on a later call.
      fs.chmodSync(crashStage, 0o555);
      try {
        await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
        expect(existsSync(backup)).toBe(true); // PRESERVED — never deleted by a GC sweep
        expect(readFileSync(path.join(backup, 'gen.txt'), 'utf8')).toBe('ONLY_COPY\n');
      } finally {
        fs.chmodSync(crashStage, 0o755); // let afterEach clean up
      }
    },
  );
});

// ===========================================================================
// Round-2 #1 — a no-dependency repo carries NO stale provisioned node_modules
// ===========================================================================
describe('F7 round-2 #1 — the no-dependency success path does not carry a stale toolchain', () => {
  it('removes a pre-existing (ignored, real) node_modules so nothing stale reaches verification', async () => {
    const repo = track(await makeTempGitRepo('harness-f7-nodeps-stale-'));
    await repo.writeFile('.gitignore', 'node_modules/\n');
    await repo.writeFile('README.md', '# no deps\n'); // no package.json → dependency-free
    await repo.commitAll('no-deps + ignore rule');
    const manager = await openManager(repo);
    const asg = assignmentId('asg_nodeps_stale');
    const handle = await createAtHead(repo, manager, asg);

    // Plant a stale provisioned toolchain (a prior round's node_modules with a `.bin`
    // that could resolve tsc/vitest) — git-ignored, real, untracked: exactly the tree
    // fix #1 must clear before a dependency-free round is greened.
    const nm = path.join(handle.worktreePath, 'node_modules');
    fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
    fs.writeFileSync(path.join(nm, '.bin', 'tsc'), '#!/bin/sh\nexit 0\n');
    fs.writeFileSync(path.join(nm, 'stale.txt'), 'STALE\n');

    const outcome = await manager.provisionForVerification(asg);
    expect(outcome.strategy).toBe('none'); // dependency-free → trivially-true skip
    expect(outcome.detail).toMatch(/removed a stale/i);
    expect(existsSync(nm)).toBe(false); // …and the stale tree is GONE
  });

  it('is a clean no-op (still no node_modules) when there is nothing stale to remove', async () => {
    const repo = track(await makeTempGitRepo('harness-f7-nodeps-clean-'));
    await repo.writeFile('README.md', '# no deps\n');
    await repo.commitAll('no-deps');
    const manager = await openManager(repo);
    const asg = assignmentId('asg_nodeps_clean');
    const handle = await createAtHead(repo, manager, asg);
    expect((await manager.provisionForVerification(asg)).strategy).toBe('none');
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(false);
  });
});

// ===========================================================================
// Round-2 #8 — readFileAtHead absence detection is structural + locale-independent
// ===========================================================================
describe('F7 round-2 #8 — readFileAtHead: genuine absence vs a real git failure', () => {
  it('a genuinely-absent path at HEAD → undefined (no English-stderr dependency)', async () => {
    const repo = track(await makeTempGitRepo('harness-f7-abs-'));
    await repo.writeFile('package.json', '{"name":"x"}\n');
    await repo.commitAll('add package.json');
    // Present → content; absent (e.g. a missing .npmrc, or a nested path) → undefined:
    // both decided on ls-tree's exit code + emptiness, never a translated git fatal.
    expect(await realReadFileAtHead(repo.dir, 'package.json')).toContain('"name"');
    expect(await realReadFileAtHead(repo.dir, '.npmrc')).toBeUndefined();
    expect(await realReadFileAtHead(repo.dir, 'packages/deep/nope.json')).toBeUndefined();
    // Locale independence is inherent (no message parsing): a non-English LC_ALL
    // cannot flip a genuine absence into a spurious git failure.
    const prev = process.env.LC_ALL;
    process.env.LC_ALL = 'fr_FR.UTF-8';
    try {
      expect(await realReadFileAtHead(repo.dir, '.npmrc')).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = prev;
    }
  });

  it('a real git failure (unresolvable HEAD) FAILS CLOSED (throws), never classified as absence', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-f7-nohead-'));
    try {
      await runGit(['init'], dir); // a repo with NO commits → HEAD is unresolvable
      await expectRejectsWithKind(realReadFileAtHead(dir, 'package.json'), 'git_command_failed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// Codex diff-review ROUND 3 fixes: #2 swap double-fault, #3 lstat fail-closed,
// #5 stage-GC namespace + read-failure preserve.
// ===========================================================================

describe('F7 round-3 #2 — a swap whose move-in AND rollback BOTH fail preserves the only backup', () => {
  it('swapIntoPlace leaves the sole `old-*` backup in the stage on a double fault (never destroys it)', () => {
    const root = fs.mkdtempSync(path.join(tmpdir(), 'harness-f7-swap-'));
    try {
      const target = path.join(root, 'node_modules'); // the prior valid tree in place
      const newTree = path.join(root, 'newtree');
      const stageDir = path.join(root, 'stage');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'gen.txt'), 'PRIOR\n');
      fs.mkdirSync(newTree, { recursive: true });
      fs.writeFileSync(path.join(newTree, 'x.js'), 'new\n');
      fs.mkdirSync(stageDir, { recursive: true });

      // The move-aside (rename #1) succeeds — a backup IS created; move-in (#2) AND the
      // rollback (#3) BOTH fault. The prior tree then survives ONLY as the `old-*`
      // backup, which the fix must NOT destroy.
      let call = 0;
      const rename = (from: string, to: string): void => {
        call += 1;
        if (call === 1) {
          fs.renameSync(from, to); // move-aside → real
          return;
        }
        throw new Error('injected rename fault'); // move-in AND rollback both fault
      };
      expect(() => swapIntoPlace(target, newTree, stageDir, rename)).toThrow(/injected rename fault/);

      // The worktree has no node_modules and the sole PRIOR tree is preserved as `old-*`.
      expect(fs.existsSync(target)).toBe(false);
      const backups = fs.readdirSync(stageDir).filter((n) => n.startsWith('old-'));
      expect(backups).toHaveLength(1);
      expect(fs.readFileSync(path.join(stageDir, backups[0]!, 'gen.txt'), 'utf8')).toBe('PRIOR\n');
      // …and the `finally`-GC guard PRESERVES a stage that still holds an `old-*`.
      expect(stageHoldsBackup(stageDir)).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('stageHoldsBackup: `old-*` present → true; empty → false; unreadable → true (fail safe)', () => {
    const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
    const root = fs.mkdtempSync(path.join(tmpdir(), 'harness-f7-holds-'));
    try {
      const withBackup = path.join(root, 'with');
      fs.mkdirSync(path.join(withBackup, 'old-deadbeef'), { recursive: true });
      expect(stageHoldsBackup(withBackup)).toBe(true);

      const empty = path.join(root, 'empty');
      fs.mkdirSync(empty, { recursive: true });
      expect(stageHoldsBackup(empty)).toBe(false);

      expect(stageHoldsBackup(path.join(root, 'absent'))).toBe(false); // ENOENT → nothing to preserve

      if (!isRoot) {
        const unreadable = path.join(root, 'blocked');
        fs.mkdirSync(unreadable, { recursive: true });
        fs.chmodSync(unreadable, 0o000);
        try {
          expect(stageHoldsBackup(unreadable)).toBe(true); // fail safe: preserve on a read error
        } finally {
          fs.chmodSync(unreadable, 0o755);
        }
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('F7 round-3 #3 — a non-ENOENT lstat error fails closed (never misclassified as absence)', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it('lstatSafe: ENOENT/ENOTDIR → undefined (absent); any other error (EACCES) → provisioning_failed', () => {
    // The OLD `lstatSafe` swallowed EVERY error → the safety preflight / no-deps
    // removal treated a real FS failure as "absent" → success, leaving a stale
    // toolchain to green a round. Now only ENOENT/ENOTDIR is absence; the rest throws.
    expect(lstatSafe(path.join(tmpdir(), 'harness-f7-definitely-absent-xyz'))).toBeUndefined(); // ENOENT
    const file = path.join(fs.mkdtempSync(path.join(tmpdir(), 'harness-f7-notdir-')), 'f');
    fs.writeFileSync(file, 'x');
    expect(lstatSafe(path.join(file, 'child'))).toBeUndefined(); // ENOTDIR (parent is a file)

    if (!isRoot) {
      // EACCES: a path under a 0o000 dir cannot be lstat'd (parent not traversable) —
      // a real FS error that must FAIL CLOSED, never be classified as absence.
      const blocked = fs.mkdtempSync(path.join(tmpdir(), 'harness-f7-eacces-'));
      fs.chmodSync(blocked, 0o000);
      let thrown: unknown;
      try {
        lstatSafe(path.join(blocked, 'child'));
      } catch (error) {
        thrown = error;
      } finally {
        fs.chmodSync(blocked, 0o755);
        fs.rmSync(blocked, { recursive: true, force: true });
      }
      expect(isWorktreeError(thrown)).toBe(true);
      expect((thrown as WorktreeError).kind).toBe('provisioning_failed');
    }
  });
});

describe('F7 round-3 #5 — stage GC preserves backups on a read failure + is exact per-assignment', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)(
    'an UNREADABLE stage during crash-recovery is PRESERVED and fails closed (never swept away)',
    async () => {
      const repo = track(await makeDepsRepo()); // deps → provisioning attempted
      const manager = await openManager(repo, { runtime: fakeRuntime().runtime });
      const asg = assignmentId('asg_gc_unreadable');
      const handle = await createAtHead(repo, manager, asg);
      const nm = path.join(handle.worktreePath, 'node_modules');
      expect(existsSync(nm)).toBe(false); // fresh worktree → the crash-recovery restore scan runs

      // A crashed stage holding the only `old-*` backup, made UNREADABLE (its inner
      // readdir will EACCES). The crash-recovery preflight must PRESERVE it — a transient
      // read error must never let the later sweep destroy the sole surviving copy.
      const stage = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg), 'crash');
      const backup = path.join(stage, 'old-deadbeef');
      fs.mkdirSync(backup, { recursive: true });
      fs.writeFileSync(path.join(backup, 'gen.txt'), 'ONLY_COPY\n');
      fs.chmodSync(stage, 0o000); // inner readdir(stage) → EACCES
      try {
        await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
      } finally {
        fs.chmodSync(stage, 0o755); // restore access before asserting + for cleanup
      }
      expect(existsSync(backup)).toBe(true); // PRESERVED — never swept on a transient read error
      expect(readFileSync(path.join(backup, 'gen.txt'), 'utf8')).toBe('ONLY_COPY\n');
    },
  );

  it('GC for one assignment never touches a prefix-related assignment (asg-x vs asg-x-y)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const manager = await openManager(repo);
    const shortAsg = assignmentId('asg-x');
    const longAsg = assignmentId('asg-x-y'); // its slug starts with the short slug + '-'
    await createAtHead(repo, manager, shortAsg);
    await createAtHead(repo, manager, longAsg);

    // Plant a leftover stage in EACH assignment's OWN namespace dir.
    const stageRoot = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR);
    const shortLeftover = path.join(stageRoot, String(shortAsg), 'leftover');
    const longLeftover = path.join(stageRoot, String(longAsg), 'leftover');
    fs.mkdirSync(shortLeftover, { recursive: true });
    fs.mkdirSync(longLeftover, { recursive: true });
    fs.writeFileSync(path.join(longLeftover, 'keep.txt'), 'DO_NOT_DELETE\n');

    // GC `asg-x` (via removeWorktree): with the OLD bare-prefix filter, `asg-x` also
    // matched `asg-x-y-*`; the per-assignment namespace makes GC an EXACT match, so
    // `asg-x-y`'s stages are untouched.
    await manager.removeWorktree(shortAsg);
    expect(existsSync(path.join(stageRoot, String(shortAsg)))).toBe(false); // asg-x namespace swept
    expect(existsSync(path.join(longLeftover, 'keep.txt'))).toBe(true); // asg-x-y untouched
  });
});

describe('F7 round-3 #1 (fix a) — a §16.3 WIP reconciliation commit EXCLUDES node_modules while provisioning is active', () => {
  it('validate() WIP-commits real dirt but never the provisioned (un-ignored) node_modules', async () => {
    // Deps repo with NO ignore rule → a plain `git add -A` WOULD stage node_modules;
    // manager.validate()'s WIP path must exclude it (the SAME exclusion the implementor
    // commit uses) while managed provisioning is ACTIVE (default 'auto').
    const repo = track(await makeDepsRepo({ ignore: false }));
    const manager = await openManager(repo);
    const asg = assignmentId('asg_validate_exclude');
    const handle = await createAtHead(repo, manager, asg);

    // Dirty the worktree: a real untracked change to PRESERVE + a provisioned
    // (un-ignored) node_modules that must NEVER enter the reconciliation commit.
    fs.writeFileSync(path.join(handle.worktreePath, 'feature.txt'), 'real work\n');
    fs.mkdirSync(path.join(handle.worktreePath, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(handle.worktreePath, 'node_modules', 'junk.js'), 'toolchain\n');

    // No checkpoint → dirty → wip_committed.
    const result = await manager.validate(asg);
    expect(result.outcome).toBe('wip_committed');
    expect(result.wipCommitSha).toBeDefined();

    const tracked = (
      await runGit(['ls-tree', '-r', '--name-only', String(result.wipCommitSha)], handle.worktreePath)
    ).stdout;
    expect(tracked).toContain('feature.txt'); // real work preserved
    expect(tracked.split('\n').some((p) => p.startsWith('node_modules'))).toBe(false); // never committed
    // …and node_modules is still on disk (EXCLUDED from the commit, not deleted).
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', 'junk.js'))).toBe(true);
  });
});

// ===========================================================================
// Codex diff-review ROUND 4 refinements: #2 primary-manifest ENOENT-only,
// #3 unstage already-staged node_modules, #4 namespace-root enum fail-closed,
// #2 production-path swap double-fault.
// ===========================================================================

describe('F7 round-4 #3 — an ALREADY-STAGED node_modules is unstaged before the WIP commit (not just prevented from adding)', () => {
  it('manager.validate() WIP commit UNSTAGES a pre-staged node_modules', async () => {
    const repo = track(await makeDepsRepo({ ignore: false })); // no ignore rule → add -A would stage it
    const manager = await openManager(repo); // provisioning ACTIVE (auto)
    const asg = assignmentId('asg_prestaged_wip');
    const handle = await createAtHead(repo, manager, asg);

    fs.writeFileSync(path.join(handle.worktreePath, 'feature.txt'), 'real work\n');
    fs.mkdirSync(path.join(handle.worktreePath, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(handle.worktreePath, 'node_modules', 'junk.js'), 'toolchain\n');
    // PRE-STAGE both into the index (simulating an interrupted implementor / a
    // verification command that ran `git add`). The exclusion pathspec ALONE would
    // leave the already-staged node_modules in the commit.
    await runGit(['add', 'feature.txt', 'node_modules'], handle.worktreePath);
    expect((await runGit(['diff', '--cached', '--name-only'], handle.worktreePath)).stdout).toContain('node_modules');

    const result = await manager.validate(asg);
    expect(result.outcome).toBe('wip_committed');
    const tracked = (
      await runGit(['ls-tree', '-r', '--name-only', String(result.wipCommitSha)], handle.worktreePath)
    ).stdout;
    expect(tracked).toContain('feature.txt'); // real work preserved
    expect(tracked.split('\n').some((p) => p.startsWith('node_modules'))).toBe(false); // UNSTAGED, never committed
  });
});

describe('F7 round-4 #2 — a non-ENOENT primary-manifest read error is never a false clone', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(isRoot)('an UNREADABLE (present) primary .npmrc → clone NOT attempted; F9 refuses instead of installing', async () => {
    // The worktree HEAD manifests match the primary's package.json/lock. The OLD
    // diskSource swallowed the EACCES on a PRESENT-but-unreadable primary .npmrc →
    // treated it as absent → false-matched the worktree's (genuinely absent) .npmrc →
    // cloned an UNPROVEN tree. makeDepsRepo commits NO .npmrc.
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir); // a cloneable primary
    const primaryNpmrc = path.join(repo.dir, '.npmrc'); // present on disk, NOT committed
    fs.writeFileSync(primaryNpmrc, 'registry=https://example.test/\n');
    fs.chmodSync(primaryNpmrc, 0o000);
    const fake = fakeRuntime({ cloneSupported: true });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_primary_npmrc_eacces');
    await createAtHead(repo, manager, asg);
    try {
      // F9: the unreadable primary manifest still never becomes a clone — but with
      // no install lane left, "cannot establish the source's dependency set" is a
      // refusal rather than a silent switch to an unprovable build.
      const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
      expect(error.provisioningCause).toBe('manifest_divergence_unclassified');
      expect(fake.calls).toEqual({ clone: 0, install: 0 });
    } finally {
      fs.chmodSync(primaryNpmrc, 0o644);
    }
  });
});

describe('F7 round-4 #4 — an unreadable stage NAMESPACE root fails closed on the provisioning preflight', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(isRoot)('a non-ENOENT enumeration error on the assignment namespace dir → provisioning_failed (preserved)', async () => {
    const repo = track(await makeDepsRepo());
    const manager = await openManager(repo, { runtime: fakeRuntime().runtime });
    const asg = assignmentId('asg_ns_unreadable');
    const handle = await createAtHead(repo, manager, asg);
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(false); // fresh → restore-critical

    // The assignment namespace dir holds the sole backup but is itself UNREADABLE (its
    // readdir EACCES). The preflight must fail closed, not treat it as "no namespace".
    const namespace = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg));
    const backup = path.join(namespace, 'stage', 'old-deadbeef');
    fs.mkdirSync(backup, { recursive: true });
    fs.writeFileSync(path.join(backup, 'gen.txt'), 'ONLY_COPY\n');
    fs.chmodSync(namespace, 0o000); // readdir(namespace) → EACCES
    try {
      await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');
    } finally {
      fs.chmodSync(namespace, 0o755); // restore before asserting + for cleanup
    }
    expect(existsSync(backup)).toBe(true); // PRESERVED — never continued-as-empty then swept
    expect(readFileSync(path.join(backup, 'gen.txt'), 'utf8')).toBe('ONLY_COPY\n');
  });
});

describe('F7 round-4 #2 (production path) — provisionWorktreeDeps preserves the backup on a swap double fault', () => {
  it('the production catch/finally keeps the sole `old-*` backup when move-in AND rollback both fault', async () => {
    // F9: builds come from the clone lane now; the generation marker lives in the
    // PRIMARY tree and is bumped between provisions.
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const primaryGen = path.join(repo.dir, 'node_modules', 'gen.txt');
    fs.writeFileSync(primaryGen, 'GEN1\n');
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_prod_swap');
    const handle = await createAtHead(repo, manager, asg);
    const nm = path.join(handle.worktreePath, 'node_modules');
    const realGit: ProvisionGit = { isPathIgnored, isPathTracked, readFileAtHead: realReadFileAtHead };

    // A first provision lands GEN1 (the prior valid tree that must survive).
    await manager.provisionForVerification(asg);
    expect(readFileSync(path.join(nm, 'gen.txt'), 'utf8')).toBe('GEN1\n');
    // Bump the manifest on BOTH sides so the next provision rebuilds (a swap that
    // move-asides GEN1), and mark the primary tree GEN2 so a landed rebuild is visible.
    const bumped = `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '2.0.0' } }, null, 2)}\n`;
    await writeFile(path.join(handle.worktreePath, 'package.json'), bumped);
    await commitInWorktree(handle.worktreePath, 'bump');
    await writeFile(path.join(repo.dir, 'package.json'), bumped);
    fs.writeFileSync(primaryGen, 'GEN2\n');

    // Drive the PRODUCTION path (provisionWorktreeDeps, via its `rename` seam) with a
    // rename that faults BOTH move-in and rollback (dest === worktree node_modules);
    // move-aside (dest = stage backup) still succeeds, so a backup IS created.
    const realRename = fs.renameSync.bind(fs);
    const rename = (from: string, to: string): void => {
      if (path.resolve(to) === path.resolve(nm)) throw new Error('injected rename fault');
      realRename(from, to);
    };
    await expectRejectsWithKind(
      provisionWorktreeDeps({
        assignmentId: String(asg),
        worktreePath: handle.worktreePath,
        primaryRepoRoot: repo.dir,
        baseDir: manager.baseDir,
        strategy: 'auto',
        runtime: fake.runtime,
        git: realGit,
        rename,
      }),
      'provisioning_failed',
    );

    // The production catch surfaced provisioning_failed; the finally PRESERVED the
    // stage because it still holds the sole GEN1 `old-*` backup.
    expect(existsSync(nm)).toBe(false);
    const backups = findBackups(path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg)));
    expect(backups).toHaveLength(1);
    expect(readFileSync(path.join(backups[0]!, 'gen.txt'), 'utf8')).toBe('GEN1\n'); // the prior tree, intact
  });
});

// ===========================================================================
// F9 — provisioning must PROVE the tree it provides, or fail closed.
//
// F7 shipped three lanes that could hand verification an UNPROVEN tree:
//  P1 the INSTALL lane ran `npm ci --ignore-scripts`, which cannot build a
//     script-installed native dep (better-sqlite3 lands with no `.node`), while
//     `hasBinDir` stamped the result "proven" — `.bin/` is populated at UNPACK
//     time from `bin` fields, entirely independent of lifecycle scripts, so it
//     can never be a toolchain proof;
//  P2 that broken tree became STICKY (its marker matched, so every later round
//     short-circuited onto it and the run burned to terminal);
//  P3 the FALSE CLONE — eligibility compared manifest FINGERPRINTS but never
//     validated the primary tree's CONTENTS, so a primary that had not been
//     `npm install`ed since a dep-adding merge was cloned wholesale;
//  P4 the config lied: `'clone'` silently fell through to install;
//  P5 `npm ci` / git ran unbounded while holding the mutex + advisory lease.
//
// Every lane that cannot be proven now refuses with a CAUSE CODE the CLI turns
// into a specific remedy.
// ===========================================================================

/** Awaits a rejection and returns the WorktreeError for cause/message assertions. */
async function expectProvisioningFailure(promise: Promise<unknown>): Promise<WorktreeError> {
  let thrown: unknown;
  try {
    await promise;
  } catch (error) {
    thrown = error;
  }
  expect(isWorktreeError(thrown)).toBe(true);
  const error = thrown as WorktreeError;
  expect(error.kind).toBe('provisioning_failed');
  return error;
}

describe('F9 AC-1 — a manifest mismatch fails closed (the install fallback is gone)', () => {
  it('the implementor changed manifests → deps_changed_in_worktree, npm is never invoked', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_f9_deps_changed');
    const handle = await createAtHead(repo, manager, asg);
    // The implementor committed a dependency change inside the worktree.
    fs.writeFileSync(
      path.join(handle.worktreePath, 'package.json'),
      `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0', chalk: '5.0.0' } }, null, 2)}\n`,
    );
    await commitInWorktree(handle.worktreePath, 'add a dependency');

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('deps_changed_in_worktree');
    expect(error.message).toContain('package.json'); // names the diverged manifest
    expect(error.message).toMatch(/engine track/i); // states the remedy
    // The whole point: no npm, no clone — nothing was built from an unproven input.
    expect(fake.calls.install).toBe(0);
    expect(fake.calls.clone).toBe(0);
    // ...and NO marker was written, so a later round cannot short-circuit onto it.
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(false);
  });

  it('the PRIMARY has uncommitted manifest edits → primary_manifests_diverged', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_f9_primary_diverged');
    await createAtHead(repo, manager, asg);
    // The worktree is untouched; the PRIMARY's on-disk manifest drifted from HEAD.
    await repo.writeFile(
      'package.json',
      `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '2.0.0' } }, null, 2)}\n`,
    );

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('primary_manifests_diverged');
    expect(error.message).toContain('package.json');
    expect(error.message).toMatch(/npm install/i); // the operator's remedy
    expect(fake.calls.install).toBe(0);
  });

  it('names the LOCKFILE (only) when that is what diverged', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const manager = await openManager(repo);
    const asg = assignmentId('asg_f9_lock_diverged');
    await createAtHead(repo, manager, asg);
    await repo.writeFile('package-lock.json', `${DEFAULT_LOCK}\n`); // byte-different

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.message).toContain('package-lock.json');
    expect(error.provisioningCause).toBe('primary_manifests_diverged');
  });
});

describe('F9 AC-2 — a stale primary tree is never cloned (primary_tree_stale)', () => {
  it('fingerprints match but a declared package is MISSING from the primary tree → refuse, no clone', async () => {
    // The exact P3 shape: a dep-adding commit was merged into the primary, but
    // `npm install` was never run there before the next run started.
    const repo = track(await makeDepsRepo({ deps: { 'left-pad': '1.0.0', chalk: '5.0.0' } }));
    await writePrimaryNodeModules(repo.dir, { packages: ['left-pad'] }); // chalk missing
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_f9_stale_primary');
    const handle = await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('primary_tree_stale');
    expect(error.message).toContain('chalk'); // names the missing package
    expect(error.message).toMatch(/npm install/i);
    expect(fake.calls.clone).toBe(0); // never cloned an unproven source
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(false);
  });

  // ROUND 7 (Finding 2) — the same false-clone defect one level down. Checking
  // only that each declared NAME has a directory let a dependency bumped without
  // reinstalling pass on its OLD directory: the wrong tree is cloned, stamped v2,
  // and every later round short-circuits onto it — verifying against dependency
  // versions that differ from the lockfile. A non-native package evades the
  // runtime smoke entirely, so nothing downstream catches it either.
  it('a package installed at the WRONG VERSION is refused (presence is not proof)', async () => {
    const repo = track(await makeTempGitRepo('harness-f9-ver-'));
    await repo.writeFile('.gitignore', 'node_modules/\n');
    await repo.writeFile(
      'package.json',
      `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '2.0.0' } }, null, 2)}\n`,
    );
    await repo.writeFile(
      'package-lock.json',
      `${JSON.stringify(
        {
          name: 'x',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'x' }, 'node_modules/left-pad': { version: '2.0.0' } },
        },
        null,
        2,
      )}\n`,
    );
    await repo.commitAll('deps at 2.0.0');
    // The primary still holds the OLD 1.0.0 directory — present, so the pre-round-7
    // name check passed it.
    const nm = await writePrimaryNodeModules(repo.dir, { packages: [] });
    writeInstalledPackage(nm, 'left-pad');
    fs.writeFileSync(
      path.join(nm, 'left-pad', 'package.json'),
      `${JSON.stringify({ name: 'left-pad', version: '1.0.0', main: 'index.js' }, null, 2)}\n`,
    );
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_f9_version_drift');
    const handle = await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('primary_tree_stale');
    expect(error.message).toContain('left-pad');
    expect(error.message).toContain('1.0.0'); // installed
    expect(error.message).toContain('2.0.0'); // lockfile
    expect(fake.calls.clone).toBe(0); // never cloned the wrong tree
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(false);
  });

  it('a package whose installed manifest is unreadable is refused (not assumed to match)', async () => {
    const repo = track(await makeTempGitRepo('harness-f9-unread-'));
    await repo.writeFile('.gitignore', 'node_modules/\n');
    await repo.writeFile(
      'package.json',
      `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }, null, 2)}\n`,
    );
    await repo.writeFile(
      'package-lock.json',
      `${JSON.stringify(
        {
          name: 'x',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'x' }, 'node_modules/left-pad': { version: '1.0.0' } },
        },
        null,
        2,
      )}\n`,
    );
    await repo.commitAll('deps with a pinned lockfile');
    const nm = await writePrimaryNodeModules(repo.dir);
    // The lockfile pins a version, so the installed manifest MUST be readable to
    // prove it — an unreadable one is not evidence of a match.
    fs.writeFileSync(path.join(nm, 'left-pad', 'package.json'), '{ not json');
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_f9_version_unreadable');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
    expect(error.provisioningCause).toBe('primary_tree_stale');
    expect(error.message).toContain('left-pad');
    expect(fake.calls.clone).toBe(0); // refused BEFORE cloning
  });

  // ROUND 8 (Blocker 2) — the version proof was CONDITIONAL: an absent lock entry
  // skipped the comparison, and an unreadable/unsupported lockfile produced an
  // empty map, so Yarn, pnpm, no lockfile, a malformed package-lock.json, or an
  // unrecognised entry all degraded silently to presence-only — cloning a stale
  // tree and stamping it v2. That is the F9 defect reintroduced through F9's own
  // precondition. Absence of proof is not proof.
  describe('unusable lock data is a REFUSAL, never a downgrade to presence-only', () => {
    /** A repo declaring `left-pad` whose lockfile is exactly `lock` (absent when undefined). */
    async function repoWithLock(lock: string | undefined): Promise<TempGitRepo> {
      const repo = track(await makeTempGitRepo('harness-f9-lock-'));
      await repo.writeFile('.gitignore', 'node_modules/\n');
      await repo.writeFile(
        'package.json',
        `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }, null, 2)}\n`,
      );
      if (lock !== undefined) await repo.writeFile('package-lock.json', lock);
      await repo.commitAll('deps');
      return repo;
    }

    it.each([
      ['NO lockfile at all (Yarn/pnpm repos land here)', undefined, /no package-lock\.json/i],
      ['a MALFORMED lockfile', '{ not json at all', /could not be parsed/i],
      ['a lockfile that is not an object', '"a string"', /not a JSON object/i],
      [
        'a lockfile with no entry for a DECLARED package',
        `${JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' } } }, null, 2)}\n`,
        /resolves no version for it/i,
      ],
    ])('refuses on %s', async (_label, lock, expected) => {
      const repo = await repoWithLock(lock);
      await writePrimaryNodeModules(repo.dir); // a PRESENT, healthy-looking tree
      const fake = fakeRuntime();
      const manager = await openManager(repo, { runtime: fake.runtime });
      const asg = assignmentId(`asg_f9_lock_${String(_label).replace(/[^a-z]/gi, '').slice(0, 12)}`);
      const handle = await createAtHead(repo, manager, asg);

      const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

      expect(error.provisioningCause).toBe('primary_tree_stale');
      expect(error.message).toMatch(expected);
      expect(fake.calls.clone).toBe(0); // the stale tree is never cloned...
      expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(false); // ...nor marked
    });

    it('a v1 lockfile (top-level `dependencies`) IS recognised and proven', async () => {
      const repo = await repoWithLock(
        `${JSON.stringify(
          { name: 'x', version: '1.0.0', lockfileVersion: 1, dependencies: { 'left-pad': { version: '1.0.0' } } },
          null,
          2,
        )}\n`,
      );
      await writePrimaryNodeModules(repo.dir);
      const fake = fakeRuntime();
      const manager = await openManager(repo, { runtime: fake.runtime });
      const asg = assignmentId('asg_f9_lock_v1');
      await createAtHead(repo, manager, asg);

      expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
      expect(fake.calls.clone).toBe(1);
    });
  });

  it('matching versions still clone (the happy path is unchanged)', async () => {
    const repo = track(await makeDepsRepo());
    const nm = await writePrimaryNodeModules(repo.dir);
    // makeDepsRepo's lockfile pins no versions, so presence remains sufficient
    // there; pin one explicitly and match it to prove the comparison passes.
    fs.writeFileSync(
      path.join(nm, 'left-pad', 'package.json'),
      `${JSON.stringify({ name: 'left-pad', version: '1.0.0', main: 'index.js' }, null, 2)}\n`,
    );
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_f9_version_ok');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    expect(fake.calls.clone).toBe(1);
  });

  it('devDependencies are proven too (a missing devDep is just as fatal)', async () => {
    const repo = track(await makeDepsRepo({ devDeps: { vite: '5.0.0' } }));
    await writePrimaryNodeModules(repo.dir, { packages: ['left-pad'] }); // vite missing
    const manager = await openManager(repo);
    const asg = assignmentId('asg_f9_stale_devdep');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('primary_tree_stale');
    expect(error.message).toContain('vite');
  });

  it('a SCOPED declared package resolves under its scope directory', async () => {
    const repo = track(await makeDepsRepo({ deps: { '@scope/pkg': '1.0.0' } }));
    await writePrimaryNodeModules(repo.dir, { packages: ['@scope/pkg'] });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_f9_scoped');
    await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);

    expect(outcome.strategy).toBe('clone');
    expect(fake.calls.clone).toBe(1);
  });

  it('AC-3: a healthy primary + matching fingerprints still clones, and the marker still short-circuits', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_f9_happy');
    const handle = await createAtHead(repo, manager, asg);

    const first = await manager.provisionForVerification(asg);
    expect(first.strategy).toBe('clone');
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(true);

    const second = await manager.provisionForVerification(asg);
    expect(second.strategy).toBe('short_circuit');
    expect(fake.calls.clone).toBe(1); // the second call built nothing
  });
});

describe('F9 AC-5 — an unbuilt native dependency is caught BEFORE the tree is marked', () => {
  it('a script-bearing package that cannot be loaded → native_toolchain_unproven, no marker (never sticky)', async () => {
    const repo = track(
      await makeDepsRepo({ deps: { 'left-pad': '1.0.0' }, devDeps: { 'fake-native': '1.0.0' } }),
    );
    // The primary's tree has the package dir AND a populated `.bin` — exactly what
    // `hasBinDir` accepted as "proven" — but the binding was never built.
    await writePrimaryNodeModules(repo.dir, {
      packages: ['left-pad'],
      native: { name: 'fake-native', built: false },
    });
    const manager = await openManager(repo);
    const asg = assignmentId('asg_f9_unbuilt_native');
    const handle = await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    expect(error.message).toContain('fake-native'); // names the package
    // P2: nothing was marked, so the next round cannot short-circuit onto it.
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(false);
  });

  it('a BUILT native dependency passes the smoke and the tree is provisioned + marked', async () => {
    const repo = track(
      await makeDepsRepo({ deps: { 'left-pad': '1.0.0' }, devDeps: { 'fake-native': '1.0.0' } }),
    );
    await writePrimaryNodeModules(repo.dir, {
      packages: ['left-pad'],
      native: { name: 'fake-native', built: true },
    });
    const manager = await openManager(repo);
    const asg = assignmentId('asg_f9_built_native');
    const handle = await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);

    expect(outcome.strategy).toBe('clone');
    expect(readFileSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE), 'utf8')).toBe(
      `v2:${outcome.fingerprint}`,
    );
  });

  it('the smoke runs on the CLONE lane too — a primary broken by a past script-less install never propagates', async () => {
    // The clone lane is CHEAP, not SAFE: its correctness is inherited from the
    // last real `npm install` in the primary, so it gets the same proof.
    const repo = track(await makeDepsRepo({ devDeps: { 'fake-native': '1.0.0' } }));
    await writePrimaryNodeModules(repo.dir, {
      packages: ['left-pad'],
      native: { name: 'fake-native', built: false },
    });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime, provision: 'clone' });
    const asg = assignmentId('asg_f9_clone_lane_smoke');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(fake.calls.clone).toBe(1); // the clone happened...
    expect(error.provisioningCause).toBe('native_toolchain_unproven'); // ...and was then refused
  });
});

describe('F9 HIGH-3 — a pre-F9 (v1) marker never short-circuits past the smoke', () => {
  it('a v1 marker on a HEALTHY legacy tree is re-proven in place and UPGRADED to v2 (no rebuild)', async () => {
    const repo = track(await makeDepsRepo({ devDeps: { 'fake-native': '1.0.0' } }));
    await writePrimaryNodeModules(repo.dir, { native: { name: 'fake-native', built: true } });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_legacy_marker_ok');
    const handle = await createAtHead(repo, manager, asg);

    // Build once so the tree + fingerprint are real, then DOWNGRADE the marker to
    // the pre-F9 v1 format (a bare fingerprint).
    const first = await manager.provisionForVerification(asg);
    expect(fake.calls.clone).toBe(1);
    const markerPath = path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE);
    fs.writeFileSync(markerPath, first.fingerprint, 'utf8');

    const second = await manager.provisionForVerification(asg);

    expect(second.strategy).toBe('short_circuit');
    expect(fake.calls.clone).toBe(1); // re-proven IN PLACE, never rebuilt
    expect(second.detail).toMatch(/re-proven/i);
    expect(readFileSync(markerPath, 'utf8')).toBe(`v2:${first.fingerprint}`); // upgraded
  });

  it('a v1 marker whose tree cannot be loaded refuses instead of short-circuiting', async () => {
    const repo = track(await makeDepsRepo({ devDeps: { 'fake-native': '1.0.0' } }));
    await writePrimaryNodeModules(repo.dir, { native: { name: 'fake-native', built: true } });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_legacy_marker_unbuilt');
    const handle = await createAtHead(repo, manager, asg);

    const first = await manager.provisionForVerification(asg);
    const nm = path.join(handle.worktreePath, 'node_modules');
    // BREAK the in-place tree the way a script-less install would have left it,
    // and stamp the pre-F9 marker that used to make it sticky.
    writeInstalledPackage(nm, 'fake-native', { native: true, built: false });
    fs.writeFileSync(path.join(nm, PROVISION_MARKER_FILE), first.fingerprint, 'utf8');

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    expect(error.message).toContain('fake-native');
  });
});

describe('F9 HIGH-4 — the native filter is independent of the scripts object', () => {
  it('a package with binding.gyp and NO scripts is still proven (npm supplies the implicit node-gyp rebuild)', async () => {
    const repo = track(await makeDepsRepo({ devDeps: { 'implicit-gyp': '1.0.0' } }));
    const nm = await writePrimaryNodeModules(repo.dir);
    // binding.gyp present, `scripts` absent entirely — npm runs `node-gyp
    // rebuild` for this package, and the pre-fix filter skipped it because it
    // required a scripts object first.
    const dir = path.join(nm, 'implicit-gyp');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'binding.gyp'), '{ "targets": [] }\n');
    fs.writeFileSync(path.join(dir, 'index.js'), "module.exports = require('./build/Release/bind.node');\n");
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify({ name: 'implicit-gyp', version: '1.0.0', main: 'index.js' }, null, 2)}\n`,
    );
    const manager = await openManager(repo);
    const asg = assignmentId('asg_implicit_gyp');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    expect(error.message).toContain('implicit-gyp');
  });

  it('nesting DEEPER than the scan limit FAILS CLOSED (never a silent truncation)', async () => {
    // Round-3 returned silently past the depth cap, so a native package below it
    // was never smoked — yet the tree still got a v2 (smoke-attested) marker. An
    // unexamined tree cannot be attested, so exceeding the cap must refuse.
    const repo = track(await makeDepsRepo());
    const nm = await writePrimaryNodeModules(repo.dir);
    let deep = path.join(nm, 'left-pad');
    for (let level = 0; level <= 17; level += 1) {
      deep = path.join(deep, 'node_modules', `lvl${level}`);
    }
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'package.json'), '{"name":"deep","version":"1.0.0"}\n');
    const manager = await openManager(repo);
    const asg = assignmentId('asg_scan_depth');
    const handle = await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    expect(error.message).toMatch(/nests deeper than \d+ levels/i);
    expect(error.message).toContain('node_modules');
    // ...and nothing was marked, so the unexamined tree cannot become sticky.
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(false);
  });

  it('an UNREADABLE package manifest fails the scan closed (never silently omitted)', async () => {
    // Round 4 swallowed read/enumeration failures during the native scan, so a
    // package it could not examine was simply omitted while the tree STILL got a
    // v2 (smoke-attested) marker — the same silent-truncation shape the depth cap
    // now refuses. A manifest is the reachable case: the symlink containment scan
    // (which runs first) reads DIRECTORIES, so an unreadable directory refuses
    // there, but it never opens a package.json.
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    let staged: string | undefined;
    const fake = fakeRuntime({
      cloneImpl: async (src, dst) => {
        await cp(src, dst, { recursive: true, verbatimSymlinks: true });
        staged = path.join(dst, 'left-pad', 'package.json');
        fs.chmodSync(staged, 0o000);
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_manifest_unreadable');
    const handle = await createAtHead(repo, manager, asg);

    try {
      const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
      expect(error.provisioningCause).toBe('native_toolchain_unproven');
      expect(error.message).toContain('left-pad');
      expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(false);
    } finally {
      if (staged !== undefined && existsSync(staged)) fs.chmodSync(staged, 0o644);
    }
  });

  it('a MALFORMED package manifest fails the scan closed', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime({
      cloneImpl: async (src, dst) => {
        await cp(src, dst, { recursive: true, verbatimSymlinks: true });
        fs.writeFileSync(path.join(dst, 'left-pad', 'package.json'), '{ not json');
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_manifest_malformed');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    expect(error.message).toContain('left-pad');
  });

  it('an unreadable scope DIRECTORY is refused before the tree can be marked', async () => {
    // Round 4 swallowed a scope-enumeration error with `continue`, so native
    // packages hidden under it were omitted and the tree STILL got a v2 marker —
    // the same silent-truncation shape the depth cap now refuses. Enumeration and
    // depth must have the same posture.
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    // The scope dir becomes unreadable in the STAGED tree (the clone), which is
    // where the scan runs — the primary stays healthy so its own tree proof and
    // the clone itself both succeed, isolating the scan as the thing under test.
    let stagedScope: string | undefined;
    const fake = fakeRuntime({
      cloneImpl: async (src, dst) => {
        await cp(src, dst, { recursive: true, verbatimSymlinks: true });
        stagedScope = path.join(dst, '@scope');
        fs.mkdirSync(path.join(stagedScope, 'pkg'), { recursive: true });
        fs.chmodSync(stagedScope, 0o000);
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_scope_unreadable');
    const handle = await createAtHead(repo, manager, asg);

    try {
      // The symlink containment scan (B6) reaches this first and refuses; the
      // native scan's own enumeration guard is defence-in-depth for the race
      // where a directory becomes unreadable BETWEEN the two walks. Either way
      // the tree is never marked.
      const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
      expect(error.kind).toBe('provisioning_failed');
      expect(error.message).toContain('@scope');
      expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(false);
    } finally {
      if (stagedScope !== undefined && existsSync(stagedScope)) fs.chmodSync(stagedScope, 0o755);
    }
  });

  it('a NESTED (non-hoisted) native package is proven too, by its nested specifier', async () => {
    const repo = track(await makeDepsRepo());
    const nm = await writePrimaryNodeModules(repo.dir);
    // `left-pad/node_modules/nested-native` — the shape a version conflict leaves.
    const nested = path.join(nm, 'left-pad', 'node_modules');
    fs.mkdirSync(nested, { recursive: true });
    writeInstalledPackage(nested, 'nested-native', { native: true, built: false });
    const manager = await openManager(repo);
    const asg = assignmentId('asg_nested_native');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    // Named by the NESTED specifier — requiring bare `nested-native` would have
    // resolved the hoisted copy and proven the wrong artifact.
    expect(error.message).toContain('left-pad/node_modules/nested-native');
  });
});

describe('F9 AC-4 — the config vocabulary means what it says', () => {
  it("'clone' with an unsafe-symlink clone result FAILS CLOSED (no silent lane switch)", async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir, { badLink: 'absolute' });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime, provision: 'clone' });
    const asg = assignmentId('asg_f9_clone_unsafe');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('unsafe_clone_symlinks');
    expect(fake.calls.install).toBe(0);
  });

  it("'auto' with an unsafe-symlink clone result ALSO fails closed (auto = clone-or-fail)", async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir, { badLink: 'escaping' });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime, provision: 'auto' });
    const asg = assignmentId('asg_f9_auto_unsafe');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('unsafe_clone_symlinks');
    expect(fake.calls.install).toBe(0); // the OLD auto path retried as install here
  });

  it("'install' is refused outright with a migration message", async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime, provision: 'install' });
    const asg = assignmentId('asg_f9_install_refused');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('install_provisioning_removed');
    expect(error.message).toMatch(/cannot prove native toolchains/i);
    expect(fake.calls.install).toBe(0);
  });

  it('a non-APFS host fails closed instead of installing (auto = clone-or-fail)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime({ cloneSupported: false });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_f9_no_apfs');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('clone_unsupported');
    expect(fake.calls.install).toBe(0);
  });

  it("'none' is unchanged — a proven skip that never reads a manifest", async () => {
    const repo = track(await makeDepsRepo());
    const manager = await openManager(repo, { provision: 'none' });
    const asg = assignmentId('asg_f9_none');
    await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);

    expect(outcome.provisioned).toBe(true);
    expect(outcome.strategy).toBe('none');
  });
});

describe('F9 AC-6 — a stalled provisioning command fails closed with the locks released', () => {
  it('a hung clone times out, refuses, and the mutex + advisory lease are immediately reacquirable', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const hung: ProvisionRuntime = {
      cloneSupported: true,
      platformKey: 'test-platform',
      cloneDir: () => new Promise<void>(() => undefined), // never settles
      install: async () => undefined,
    };
    const manager = await openManager(repo, { runtime: hung, timeoutMs: 60 });
    const asg = assignmentId('asg_f9_hung_clone');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('provisioning_timeout');
    expect(error.message).toMatch(/timed out/i);
    // The critical section really was left: a fresh operation acquires at once.
    const validated = await manager.validate(asg);
    expect(validated.outcome).toBe('clean');
  });

  it('HIGH-6 #4: a stage whose quarantine MARKER cannot be written is NOT reported quarantined', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const hung: ProvisionRuntime = {
      cloneSupported: true,
      platformKey: 'test-platform',
      // Make the stage un-markable: replace it with a FILE, so both mkdir and the
      // marker write fail. (A real cause would be a full disk or a permission
      // change under the stage root.)
      cloneDir: (_src, dst) =>
        new Promise<void>(() => {
          fs.rmSync(path.dirname(dst), { recursive: true, force: true });
          fs.writeFileSync(path.dirname(dst), 'not a directory\n');
        }),
      install: async () => undefined,
    };
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: hung, timeoutMs: 60, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_f9_mark_fail');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
    expect(error.provisioningCause).toBe('provisioning_timeout');
    // It must NOT claim a quarantine it did not achieve.
    expect(warnings.some((w) => w.kind === 'stage_quarantined')).toBe(false);
    expect(warnings.some((w) => w.kind === 'stage_quarantine_failed')).toBe(true);
  });

  it('HIGH-6 #5: a marker that cannot be READ means LIVE, never "ordinary" (GC must not delete it)', async () => {
    const repo = track(await makeDepsRepo());
    const manager = await openManager(repo);
    const asg = assignmentId('asg_f9_marker_unreadable');
    await createAtHead(repo, manager, asg);
    const stageRoot = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg));
    const stage = path.join(stageRoot, 'stage-unreadable');
    fs.mkdirSync(stage, { recursive: true });
    const marker = path.join(stage, QUARANTINE_MARKER_FILE);
    fs.writeFileSync(marker, '{}');
    fs.chmodSync(marker, 0o000);

    try {
      // A GC sweep must leave it alone: the marker EXISTS but cannot be read, so
      // its liveness is unknown — which is the definition of "do not touch".
      gcProvisionStages(manager.baseDir, String(asg));
      expect(existsSync(stage)).toBe(true);
    } finally {
      fs.chmodSync(marker, 0o644);
    }
  });

  it('HIGH-6 #6: a post-TTL stage is deleted only once its OWNER is proven gone', async () => {
    const repo = track(await makeDepsRepo());
    const manager = await openManager(repo);
    const asg = assignmentId('asg_f9_ttl_owner');
    await createAtHead(repo, manager, asg);
    const stageRoot = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg));
    const ancient = Date.now() - QUARANTINE_TTL_MS - 60_000;

    const liveStage = path.join(stageRoot, 'stage-live-owner');
    fs.mkdirSync(liveStage, { recursive: true });
    fs.writeFileSync(
      path.join(liveStage, QUARANTINE_MARKER_FILE),
      JSON.stringify({ quarantinedAtMs: ancient, ownerPid: 4242, ownerStartedAt: 'START-A' }),
    );
    const deadStage = path.join(stageRoot, 'stage-dead-owner');
    fs.mkdirSync(deadStage, { recursive: true });
    fs.writeFileSync(
      path.join(deadStage, QUARANTINE_MARKER_FILE),
      JSON.stringify({ quarantinedAtMs: ancient, ownerPid: 4343, ownerStartedAt: 'START-B' }),
    );

    // Owner 4242 is still the SAME live process; 4343 is gone.
    const ownerProbe = {
      self: () => ({ pid: process.pid, startedAt: 'SELF' }),
      isOwnerAlive: (owner: { readonly pid: number; readonly startedAt?: string }): boolean =>
        owner.pid === 4242 && owner.startedAt === 'START-A',
    };

    gcProvisionStages(manager.baseDir, String(asg), undefined, undefined, ownerProbe);

    // A live owner EXTENDS rather than expires — deleting it would recreate the
    // original race, just a day later.
    expect(existsSync(liveStage)).toBe(true);
    // A proven-gone owner releases the stage, so retention stays bounded.
    expect(existsSync(deadStage)).toBe(false);
  });

  it('HIGH-6 / MED-6: a MALFORMED marker is bounded, not protected forever', async () => {
    const repo = track(await makeDepsRepo());
    const manager = await openManager(repo);
    const asg = assignmentId('asg_f9_malformed_marker');
    await createAtHead(repo, manager, asg);
    const stageRoot = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg));
    const stage = path.join(stageRoot, 'stage-malformed');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, QUARANTINE_MARKER_FILE), 'not json at all');
    // Age the directory past the TTL — the fallback clock when the marker carries
    // no usable timestamp.
    const ancient = new Date(Date.now() - QUARANTINE_TTL_MS - 60_000);
    fs.utimesSync(stage, ancient, ancient);

    const neverAlive = {
      self: () => ({ pid: process.pid }),
      isOwnerAlive: (): boolean => false,
    };
    gcProvisionStages(manager.baseDir, String(asg), undefined, undefined, neverAlive);

    expect(existsSync(stage)).toBe(false);
  });

  it('a hung provisioning GIT probe times out the same way', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const hangingGit: ProvisionGit = {
      isPathIgnored: () => new Promise<boolean>(() => undefined), // never settles
      isPathTracked,
      readFileAtHead: realReadFileAtHead,
    };
    const manager = await openManager(repo, { provisionGit: hangingGit, timeoutMs: 60 });
    const asg = assignmentId('asg_f9_hung_git');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('provisioning_timeout');
  });

  it('HIGH-6: a timed-out stage is marked IN PLACE, survives GC, and the late producer write lands in it', async () => {
    // Round 3 renamed the stage aside. That does not work: the producer writes by
    // the ORIGINAL pathname, so renaming the parent just lets it recreate
    // `stage-*` while the renamed copy gets swept by an indiscriminate GC — the
    // tree ends up split and half-deleted under a live writer. Nothing is moved
    // or deleted now; the stage is MARKED and GC skips it.
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    let releaseProducer: (() => void) | undefined;
    let producerDst: string | undefined;
    const hung: ProvisionRuntime = {
      cloneSupported: true,
      platformKey: 'test-platform',
      // Still writing into the stage long after the deadline fires.
      cloneDir: (_src, dst) =>
        new Promise<void>((resolve) => {
          producerDst = dst;
          releaseProducer = (): void => {
            fs.mkdirSync(dst, { recursive: true });
            fs.writeFileSync(path.join(dst, 'late-write.txt'), 'written after the deadline\n');
            resolve();
          };
        }),
      install: async () => undefined,
    };
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: hung, timeoutMs: 60, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_f9_quarantine');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));
    expect(error.provisioningCause).toBe('provisioning_timeout');
    expect(warnings.some((w) => w.kind === 'stage_quarantined')).toBe(true);

    // The stage is still at its ORIGINAL path — not renamed, not deleted — and
    // carries the quarantine marker.
    const stageRoot = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg));
    const quarantinedStage = fs.readdirSync(stageRoot).find((name) => name.startsWith('stage-'));
    expect(quarantinedStage).toBeDefined();
    expect(existsSync(path.join(stageRoot, quarantinedStage!, QUARANTINE_MARKER_FILE))).toBe(true);
    expect(fs.readdirSync(stageRoot).some((name) => name.startsWith('quarantine-'))).toBe(false);

    // The producer finishes AFTER the refusal. Its write lands in the SAME
    // directory the deadline abandoned — the one we marked — not in a resurrected
    // copy beside it.
    releaseProducer?.();
    expect(producerDst).toBeDefined();
    expect(path.dirname(producerDst!)).toBe(path.join(stageRoot, quarantinedStage!));
    expect(readFileSync(path.join(producerDst!, 'late-write.txt'), 'utf8')).toBe('written after the deadline\n');

    // A SUBSEQUENT provisioning attempt is unaffected: it gets its own unique
    // stage, succeeds, and its GC pass leaves the quarantined stage alone.
    const healthy = fakeRuntime();
    const manager2 = await openManager(repo, { runtime: healthy.runtime });
    const asg2 = assignmentId('asg_f9_quarantine'); // SAME assignment → same namespace
    await manager2.reattach({
      assignmentId: asg2,
      worktreePath: path.join(manager.baseDir, `assignment-${String(asg)}`),
      branch: `harness/${String(asg)}`,
      baseSha: gitSha(await repo.headSha()),
    });
    const outcome = await manager2.provisionForVerification(asg2);
    expect(outcome.strategy).toBe('clone');
    // The quarantined stage and the producer's bytes are STILL there.
    expect(existsSync(path.join(stageRoot, quarantinedStage!, QUARANTINE_MARKER_FILE))).toBe(true);
    expect(existsSync(path.join(producerDst!, 'late-write.txt'))).toBe(true);
  });
});

