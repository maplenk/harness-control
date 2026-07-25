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
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import * as fs from 'node:fs';
import { cp, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { assignmentId, gitSha, type AssignmentId } from '../domain/ids.js';
import { GitWorktreeManager } from './manager.js';
import { WorktreeError, isWorktreeError, type WorktreeErrorKind } from './errors.js';
import { isPathIgnored, isPathTracked, runGit } from './git.js';
import {
  defaultProvisionRuntime,
  lstatSafe,
  MAX_QUARANTINED_STAGES,
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

const execFileAsync = promisify(execFile);

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
 * ROUND 15 — a REAL compiled addon from this repo's own tree, to plant in a
 * fixture that is supposed to be BUILT. Nothing synthetic can stand in: the proof
 * `dlopen`s the artifact, so it must be a genuine loadable one. `better-sqlite3`
 * is a production dependency here, so the second candidate always exists.
 */
function realNativeAddon(): string {
  const candidates = ['fsevents/fsevents.node', 'better-sqlite3/build/Release/better_sqlite3.node'];
  for (const candidate of candidates) {
    const full = path.resolve(process.cwd(), 'node_modules', candidate);
    if (existsSync(full)) return full;
  }
  throw new Error('no compiled .node addon found under node_modules to use as a test fixture');
}

/**
 * F9: writes an INSTALLED package dir under `nm`. `native:true` gives it a
 * `binding.gyp` + an install script (the better-sqlite3 shape the runtime smoke
 * targets); `built:false` leaves it with NO compiled artifact — the exact P1
 * breakage a script-less install produces.
 *
 * ROUND 15 — the entry point now models the REAL dependency: better-sqlite3 loads
 * its addon LAZILY, inside the Database constructor (`lib/database.js:48`), so
 * `require('better-sqlite3')` succeeds whether or not the binding was ever built.
 * The old fixture required the missing `.node` at module scope, which no real
 * native package does — and that is precisely why a smoke built on `require()`
 * looked like it worked for fourteen rounds.
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
      "'use strict';\nlet addon;\n" +
        'class Thing {\n' +
        "  constructor() { addon = addon || require('./build/Release/bind.node'); }\n" +
        '}\n' +
        'module.exports = Thing;\n',
    );
    if (opts.built === false) {
      // "Unbuilt" must mean it: strip any artifact a previous write left behind,
      // so a test that BREAKS a healthy tree in place really breaks it.
      fs.rmSync(path.join(dir, 'build'), { recursive: true, force: true });
    } else {
      fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true });
      fs.copyFileSync(realNativeAddon(), path.join(dir, 'build', 'Release', 'bind.node'));
    }
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
    expect(readFileSync(path.join(nm, PROVISION_MARKER_FILE), 'utf8')).toBe(`v3:${outcome.fingerprint}`);

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
  it('the primary node_modules being ABSENT falls through to the install lane (never clones a missing source)', async () => {
    const repo = track(await makeDepsRepo());
    // No writePrimaryNodeModules → primary absent.
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_install_absent');
    const handle = await createAtHead(repo, manager, asg);

    // ROUND 15: nothing to clone is a reason to INSTALL, never to refuse — main
    // provisions here. The missing source is still never cloned.
    expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
    expect(fake.calls).toEqual({ clone: 0, install: 1 });
    expect(existsSync(path.join(handle.worktreePath, 'node_modules'))).toBe(true);
  });

  it('a HOLLOW primary node_modules falls through to the install lane (never clones nothing)', async () => {
    const repo = track(await makeDepsRepo());
    fs.mkdirSync(path.join(repo.dir, 'node_modules'), { recursive: true }); // empty/hollow
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_install_hollow');
    await createAtHead(repo, manager, asg);

    // ROUND 15: a hollow source is still never CLONED (B2's real invariant); it
    // falls through to the install lane instead of refusing.
    expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
    expect(fake.calls).toEqual({ clone: 0, install: 1 });
  });

  it('a primary that DRIFTED from the committed manifests installs from the round\u2019s own manifests', async () => {
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

    // ROUND 15: a primary whose manifests are not this round's is not a usable
    // clone SOURCE — so build from the round's own manifests. Still never cloned.
    expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
    expect(fake.calls).toEqual({ clone: 0, install: 1 });
  });

  it('a non-APFS host installs (with a clone_unsupported warning explaining why)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime({ cloneSupported: false });
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_non_apfs');
    await createAtHead(repo, manager, asg);

    // ROUND 15: a host without copy-on-write installs, exactly as main does. The
    // warning still says why the optimisation was skipped.
    expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
    expect(fake.calls).toEqual({ clone: 0, install: 1 });
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
    // ROUND 15: a clone failure now falls back to the INSTALL lane, so a test about
    // what a failed BUILD leaves behind has to fault both lanes — otherwise it is
    // testing the fallback, not the rollback.
    const fake = fakeRuntime({
      cloneImpl: async (src, dst) => {
        if (failClone) throw new Error('clone boom');
        await cp(src, dst, { recursive: true, verbatimSymlinks: true });
      },
      installImpl: async () => {
        if (failClone) throw new Error('install boom');
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

  it('a primary node_modules populated but with NO .bin is never cloned (it installs instead)', async () => {
    const repo = track(await makeDepsRepo());
    // A primary node_modules with a package but NO `.bin` — a broken clone source.
    fs.mkdirSync(path.join(repo.dir, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, 'node_modules', 'left-pad', 'index.js'), 'x\n');
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_primary_no_bin');
    await createAtHead(repo, manager, asg);

    // ROUND 15: B2's invariant is that a toolchain-less tree is never CLONED (it
    // would reintroduce the exit-127 false negative). It is a reason to install.
    expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
    expect(fake.calls).toEqual({ clone: 0, install: 1 });
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
    // ROUND 15: both lanes are faulted, because a failed clone now falls back to
    // the install — the crash-recovery invariant under test is unchanged.
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    fs.writeFileSync(path.join(repo.dir, 'node_modules', 'gen.txt'), 'ORIGINAL\n');
    let failClone = false;
    const fake = fakeRuntime({
      cloneImpl: async (src, dst) => {
        if (failClone) throw new Error('rebuild boom');
        await cp(src, dst, { recursive: true, verbatimSymlinks: true });
      },
      installImpl: async () => {
        if (failClone) throw new Error('rebuild boom (install)');
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
    const repo = track(await makeDepsRepo());
    const manager = await openManager(repo);
    const asg = assignmentId('asg_validate_exclude');
    const handle = await createAtHead(repo, manager, asg);

    // Dirty the worktree: a real untracked change to PRESERVE + a provisioned
    // (git-IGNORED) node_modules that must NEVER enter the reconciliation commit.
    // ROUND 10 (Regression 4): the exclusion is scoped to the ENGINE's tree, and a
    // provisioned tree is by definition ignored — an unignored one is user content.
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
    const repo = track(await makeDepsRepo()); // ignored: the engine tree shape
    const manager = await openManager(repo); // provisioning ACTIVE (auto)
    const asg = assignmentId('asg_prestaged_wip');
    const handle = await createAtHead(repo, manager, asg);

    fs.writeFileSync(path.join(handle.worktreePath, 'feature.txt'), 'real work\n');
    fs.mkdirSync(path.join(handle.worktreePath, 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(handle.worktreePath, 'node_modules', 'junk.js'), 'toolchain\n');
    // PRE-STAGE both into the index (simulating an interrupted implementor / a
    // verification command that ran `git add`). The exclusion pathspec ALONE would
    // leave the already-staged node_modules in the commit.
    // FORCE it in: the ignore rule keeps `add` out, and force-adding is exactly
    // the round-4 #3 shape (an agent running `git add -f`) that must not launder
    // the engine's tree past the guard.
    await runGit(['add', '-f', 'feature.txt', 'node_modules'], handle.worktreePath);
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
  it.skipIf(isRoot)('an UNREADABLE (present) primary .npmrc → clone NOT attempted; the round installs instead', async () => {
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
      // ROUND 15: the unreadable primary manifest still never becomes a CLONE —
      // that is the invariant this test exists for. A source whose dependency set
      // cannot be established is not a source, so the round builds its own tree.
      expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
      expect(fake.calls).toEqual({ clone: 0, install: 1 });
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

// ROUND 15: the F9 AC-1 block is GONE with the machinery it tested. A manifest
// mismatch no longer refuses — it selects the install lane, which is what main
// did and what `ROUND 15 REGRESSION 3` now asserts. The three divergence causes
// (`deps_changed_in_worktree`, `primary_manifests_diverged`,
// `manifest_divergence_unclassified`) and `manifestDivergenceFailure` were deleted
// rather than left unreachable.

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

  // ROUND 8 (Blocker 2) made unusable lock data a REFUSAL, because it had been a
  // SILENT downgrade to presence-only. ROUND 15 REVERSES the refusal and keeps the
  // loudness: the defect round 8 fixed was the SILENCE, and refusing was a
  // heavier remedy than the disease. A repo using Yarn or pnpm, or a future npm
  // lockfile format, is a tree MAIN clones and verifies; the governing principle
  // says such a shape is INDETERMINATE — warn loudly, name what could not be read,
  // and proceed. Presence is still proven, so a genuinely missing package still
  // refuses (asserted below).
  describe('unusable lock data is INDETERMINATE — loud, never silent, and never a refusal', () => {
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
      // ROUND 9 (Blocker 3): the FORMAT VERSION is checked, never inferred from a
      // familiar-looking shape — a future format may key root entries differently
      // while still resembling one we know.
      [
        'a FUTURE lockfileVersion whose shape resembles a known one',
        `${JSON.stringify(
          { name: 'x', lockfileVersion: 99, packages: { '': { name: 'x' }, 'node_modules/left-pad': { version: '1.0.0' } } },
          null,
          2,
        )}\n`,
        /lockfileVersion 99, which this engine does not support/i,
      ],
      [
        'a lockfile with NO lockfileVersion at all',
        `${JSON.stringify(
          { name: 'x', packages: { '': { name: 'x' }, 'node_modules/left-pad': { version: '1.0.0' } } },
          null,
          2,
        )}\n`,
        /does not support/i,
      ],
      [
        'a lockfile with no entry for a DECLARED package',
        `${JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' } } }, null, 2)}\n`,
        /no version/i,
      ],
      [
        'a lockfile whose entry is null',
        `${JSON.stringify(
          { name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/left-pad': null } },
          null,
          2,
        )}\n`,
        /no version|not an object/i,
      ],
      [
        'a lockfile whose entry is a primitive',
        `${JSON.stringify(
          { name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/left-pad': '1.0.0' } },
          null,
          2,
        )}\n`,
        /no version|not an object/i,
      ],
    ])('warns and PROCEEDS on %s', async (_label, lock, expected) => {
      const repo = await repoWithLock(lock);
      await writePrimaryNodeModules(repo.dir); // a PRESENT, healthy-looking tree
      const fake = fakeRuntime();
      const warnings: ProvisionWarnEvent[] = [];
      const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
      const asg = assignmentId(`asg_f9_lock_${String(_label).replace(/[^a-z]/gi, '').slice(0, 12)}`);
      const handle = await createAtHead(repo, manager, asg);

      // Main clones and verifies this tree, so we must too.
      expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
      expect(fake.calls.clone).toBe(1);
      expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(true);
      // …but never silently: the operator is told exactly what could not be read.
      const indeterminate = warnings.filter((w) => w.kind === 'proof_indeterminate');
      expect(indeterminate.length).toBeGreaterThan(0);
      expect(indeterminate.map((w) => (w as { reason: string }).reason).join(' ')).toMatch(expected);
    });

    it('a genuinely MISSING package still refuses, even with an unreadable lockfile', async () => {
      // The pair: dropping the version proof must not drop the presence proof.
      // This is what separates "we cannot check the version" from "the tree is
      // demonstrably not installed against these manifests".
      const repo = track(await makeTempGitRepo('harness-f9-lock-missing-'));
      await repo.writeFile('.gitignore', 'node_modules/\n');
      await repo.writeFile(
        'package.json',
        `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0', chalk: '5.0.0' } }, null, 2)}\n`,
      );
      await repo.writeFile('package-lock.json', '{ not json at all');
      await repo.commitAll('deps with an unreadable lockfile');
      await writePrimaryNodeModules(repo.dir, { packages: ['left-pad'] }); // chalk absent
      const fake = fakeRuntime();
      const manager = await openManager(repo, { runtime: fake.runtime });
      const asg = assignmentId('asg_f9_lock_missing_pkg');
      await createAtHead(repo, manager, asg);

      const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

      expect(error.provisioningCause).toBe('primary_tree_stale');
      expect(error.message).toContain('chalk');
      expect(fake.calls.clone).toBe(0);
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

// ---------------------------------------------------------------------------
// ROUND 14 REGRESSION 2 — a `file:` dependency is a normal npm shape.
//
// npm installs one as a SYMLINK to its target directory and records it in the
// lockfile as a LINK descriptor: `{"resolved": "<target path>", "link": true}`
// with no version, the version living on a separate entry keyed by that path
// (docs.npmjs.com/cli/v11/configuring-npm/package-lock-json). Both halves of the
// proof rejected it — the installed entry is not a directory by `lstat`, and the
// descriptor resolves no version — so a tree MAIN clones and uses was refused.
//
// THE GOVERNING PRINCIPLE these tests exist to pin: the proof may never refuse
// what main accepts. It interprets what it can, refuses what it can positively
// show to be stale, and WARNS-AND-PROCEEDS on a shape it does not understand.
// ---------------------------------------------------------------------------
describe('ROUND 14 REGRESSION 2 — linked (`file:`) dependencies are proven, or unprovable, but never refused', () => {
  /**
   * A repo declaring `left-pad` plus a `file:` dependency on an in-repo package,
   * installed the way npm installs one: a relative symlink in node_modules.
   * `linkEntry` is the lockfile's `node_modules/local-pkg` descriptor and
   * `targetEntry` the separate entry it points at (omitted = uninterpretable).
   */
  async function repoWithFileDep(opts: {
    readonly linkEntry: Record<string, unknown>;
    readonly targetEntry?: Record<string, unknown>;
    readonly installedVersion?: string;
    readonly dangling?: boolean;
  }): Promise<TempGitRepo> {
    const repo = track(await makeTempGitRepo('harness-f9-filedep-'));
    await repo.writeFile('.gitignore', 'node_modules/\n');
    await repo.writeFile(
      'package.json',
      `${JSON.stringify(
        {
          name: 'x',
          version: '1.0.0',
          dependencies: { 'left-pad': '1.0.0', 'local-pkg': 'file:packages/local-pkg' },
        },
        null,
        2,
      )}\n`,
    );
    await repo.writeFile(
      'package-lock.json',
      `${JSON.stringify(
        {
          name: 'x',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: {
            '': { name: 'x' },
            'node_modules/left-pad': { version: '1.0.0' },
            'node_modules/local-pkg': opts.linkEntry,
            ...(opts.targetEntry !== undefined ? { 'packages/local-pkg': opts.targetEntry } : {}),
          },
        },
        null,
        2,
      )}\n`,
    );
    // The link TARGET is committed source, so it exists in the worktree too.
    if (opts.dangling !== true) {
      await repo.writeFile(
        'packages/local-pkg/package.json',
        `${JSON.stringify({ name: 'local-pkg', version: opts.installedVersion ?? '2.3.4', main: 'index.js' }, null, 2)}\n`,
      );
      await repo.writeFile('packages/local-pkg/index.js', 'module.exports = { local: true };\n');
    }
    await repo.commitAll('a file: dependency');
    const nm = await writePrimaryNodeModules(repo.dir);
    // Exactly what `npm install` leaves behind for `file:packages/local-pkg`.
    await symlink('../packages/local-pkg', path.join(nm, 'local-pkg'));
    return repo;
  }

  it('a symlinked `file:` dep whose LINK descriptor resolves is PROVEN and provisions (main clones it fine)', async () => {
    const repo = await repoWithFileDep({
      linkEntry: { resolved: 'packages/local-pkg', link: true },
      targetEntry: { name: 'local-pkg', version: '2.3.4' },
    });
    const fake = fakeRuntime();
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_r14_filedep_ok');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    // INTERPRETED, not skipped: nothing was declared unprovable.
    expect(warnings.filter((w) => w.kind === 'proof_indeterminate')).toEqual([]);
  });

  it('…and the SAME shape at the wrong version is still REFUSED (interpretation is real, not a skip)', async () => {
    const repo = await repoWithFileDep({
      linkEntry: { resolved: 'packages/local-pkg', link: true },
      targetEntry: { name: 'local-pkg', version: '2.3.4' }, // lockfile says 2.3.4…
      installedVersion: '1.0.0', // …the linked target is 1.0.0
    });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_r14_filedep_stale');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('primary_tree_stale');
    expect(error.message).toContain('local-pkg');
    expect(error.message).toContain('2.3.4');
    expect(fake.calls.clone).toBe(0);
  });

  it('an UNINTERPRETABLE link descriptor warns and proceeds — it never refuses', async () => {
    const repo = await repoWithFileDep({
      // A link whose target entry is not in the lockfile at all: a descriptor we
      // cannot interpret, which is not evidence that anything is wrong.
      linkEntry: { resolved: 'packages/local-pkg', link: true },
    });
    const fake = fakeRuntime();
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_r14_filedep_opaque');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    const indeterminate = warnings.filter((w) => w.kind === 'proof_indeterminate');
    expect(indeterminate).toHaveLength(1);
    // Loud and specific: WHAT could not be interpreted, and about which package.
    expect(indeterminate[0]).toMatchObject({ subject: 'local-pkg' });
    expect((indeterminate[0] as { reason: string }).reason).toMatch(/link/i);
  });

  it('a link descriptor with no `resolved` at all is likewise unprovable, not a defect', async () => {
    const repo = await repoWithFileDep({ linkEntry: { link: true } });
    const fake = fakeRuntime();
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_r14_filedep_noresolved');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    expect(warnings.filter((w) => w.kind === 'proof_indeterminate')).toHaveLength(1);
  });

  it('a package DECLARED but wholly ABSENT from the tree is still a REFUSAL (no entry is not a descriptor)', async () => {
    // The distinction the principle turns on: an entry we cannot INTERPRET is a
    // shape we do not understand, but a declared package with no directory at all
    // is a positively identified stale tree — F9's whole reason to exist.
    const repo = track(await makeDepsRepo({ deps: { 'left-pad': '1.0.0', chalk: '5.0.0' } }));
    await writePrimaryNodeModules(repo.dir, { packages: ['left-pad'] });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_r14_absent_still_refuses');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('primary_tree_stale');
    expect(error.message).toContain('chalk');
    expect(fake.calls.clone).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ROUND 15 — F9 DID NOT DETECT THE FAILURE IT WAS BUILT FOR.
//
// The smoke `require`d the package and called that a proof. better-sqlite3 loads
// its binding only when the exported constructor is INVOKED (`lib/database.js:48`,
// inside `new Database(...)`) — verified at runtime here by hooking
// `process.dlopen`: requiring the real package triggers NO dlopen; the constructor
// does. So the proof passed on precisely the tree it exists to reject — the
// script-less install that left better-sqlite3 with no binding and turned 58 of
// 122 persistence tests red while typecheck stayed green.
//
// The fix does not try to guess a package's API (invoking arbitrary constructors
// is arbitrary code execution, the same objection as executing a `bin`). It proves
// the ARTIFACT: a package that declares a native build must HAVE a compiled
// `.node`, and that artifact must `dlopen`. That is API-independent, and it is the
// thing a script-less install actually fails to produce.
// ---------------------------------------------------------------------------
describe('ROUND 15 — the native proof is the compiled ARTIFACT, not a successful require()', () => {
  /**
   * The REAL better-sqlite3: its own manifest, its own `lib/` (which loads the
   * addon lazily), its own binding.gyp — and NO `build/`, exactly as a
   * `npm ci --ignore-scripts` leaves it. Copied from this repo's tree rather than
   * hand-written, so the fixture cannot drift from the dependency it models.
   */
  async function repoWithUnbuiltBetterSqlite3(): Promise<{ repo: TempGitRepo; nm: string; version: string }> {
    const source = path.resolve(process.cwd(), 'node_modules', 'better-sqlite3');
    expect(existsSync(source)).toBe(true); // a production dependency of this repo
    const version = (JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')) as { version: string })
      .version;
    const repo = track(await makeTempGitRepo('harness-r15-bs3-'));
    await repo.writeFile('.gitignore', 'node_modules/\n');
    await repo.writeFile(
      'package.json',
      `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'better-sqlite3': version } }, null, 2)}\n`,
    );
    await repo.writeFile(
      'package-lock.json',
      `${JSON.stringify(
        {
          name: 'x',
          version: '1.0.0',
          lockfileVersion: 3,
          requires: true,
          packages: { '': { name: 'x' }, 'node_modules/better-sqlite3': { version } },
        },
        null,
        2,
      )}\n`,
    );
    await repo.commitAll('depends on better-sqlite3');
    const nm = path.join(repo.dir, 'node_modules');
    const dst = path.join(nm, 'better-sqlite3');
    fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
    fs.writeFileSync(path.join(nm, '.bin', 'placeholder'), '#!/bin/sh\n');
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(path.join(source, 'lib'), path.join(dst, 'lib'), { recursive: true });
    fs.copyFileSync(path.join(source, 'package.json'), path.join(dst, 'package.json'));
    fs.copyFileSync(path.join(source, 'binding.gyp'), path.join(dst, 'binding.gyp'));
    // Its own runtime dependency, so `require()` reaches the binding lookup rather
    // than dying earlier for an unrelated reason.
    for (const dep of ['bindings', 'file-uri-to-path']) {
      const depSource = path.resolve(process.cwd(), 'node_modules', dep);
      if (existsSync(depSource)) fs.cpSync(depSource, path.join(nm, dep), { recursive: true });
    }
    return { repo, nm, version };
  }

  it('DECISIVE (a): the real better-sqlite3 shape with NO binding is REFUSED — though require() succeeds', async () => {
    const { repo, nm } = await repoWithUnbuiltBetterSqlite3();

    // The old proof's exact mechanism, run against this very tree: it PASSES.
    // This is what fourteen rounds of hardening were resting on.
    const requireProbe = await execFileAsync(
      process.execPath,
      ['-e', "require('better-sqlite3'); console.log('LOADED');"],
      { cwd: repo.dir },
    );
    expect(String(requireProbe.stdout).trim()).toBe('LOADED');
    // …while the thing that actually uses it does not.
    const ctorProbe = await execFileAsync(
      process.execPath,
      ['-e', "try { new (require('better-sqlite3'))(':memory:'); console.log('CTOR-OK'); } catch (e) { console.log('CTOR-FAILS'); }"],
      { cwd: repo.dir },
    );
    expect(String(ctorProbe.stdout).trim()).toBe('CTOR-FAILS');
    expect(fs.readdirSync(path.join(nm, 'better-sqlite3'))).not.toContain('build'); // no artifact at all

    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_r15_bs3_unbuilt');
    const handle = await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    expect(error.message).toContain('better-sqlite3');
    expect(error.message).toMatch(/no compiled/i);
    // P2: nothing marked, so no later round can short-circuit onto the broken tree.
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(false);
  });

  it('an artifact that EXISTS and dlopens proves the package (a real compiled addon)', async () => {
    const repo = track(await makeDepsRepo({ deps: { 'left-pad': '1.0.0' }, devDeps: { 'fake-native': '1.0.0' } }));
    await writePrimaryNodeModules(repo.dir, {
      packages: ['left-pad'],
      native: { name: 'fake-native', built: true }, // plants a REAL .node
    });
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_r15_artifact_ok');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    const smoked = warnings.find((w) => w.kind === 'native_smoke_passed');
    expect((smoked as { packages: readonly string[] }).packages.some((p) => p.endsWith('fake-native'))).toBe(true);
  });

  it('an artifact that exists but CANNOT be dlopened is refused (a corrupt or wrong-arch build)', async () => {
    const repo = track(await makeDepsRepo({ deps: { 'left-pad': '1.0.0' }, devDeps: { 'fake-native': '1.0.0' } }));
    const nm = await writePrimaryNodeModules(repo.dir, {
      packages: ['left-pad'],
      native: { name: 'fake-native', built: true },
    });
    // Same path, same name, not a Mach-O/ELF object — what a truncated download or
    // a build for the wrong architecture leaves behind.
    fs.writeFileSync(path.join(nm, 'fake-native', 'build', 'Release', 'bind.node'), 'not an object file\n');
    const manager = await openManager(repo);
    const asg = assignmentId('asg_r15_artifact_corrupt');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    expect(error.message).toMatch(/dlopen|could not LOAD/i);
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
      `v3:${outcome.fingerprint}`,
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
  it('a v1 marker on a HEALTHY legacy tree is re-proven in place and UPGRADED to v3 (no rebuild)', async () => {
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
    expect(readFileSync(markerPath, 'utf8')).toBe(`v3:${first.fingerprint}`); // upgraded
  });

  // ROUND 9 (Blocker 2) — a v2 marker attests only that the toolchain LOADS. It
  // says nothing about installed VERSIONS matching the lockfile, so a v2 marker
  // written before the version proof existed short-circuited straight past it —
  // and those are exactly the trees most likely to already exist on disk.
  it('a pre-existing v2 marker does NOT short-circuit past the version proof', async () => {
    const repo = track(await makeTempGitRepo('harness-f9-v2marker-'));
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
    await repo.commitAll('deps');
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_f9_v2_marker');
    const handle = await createAtHead(repo, manager, asg);

    // A healthy provision first: the tree lands and is stamped v3.
    const first = await manager.provisionForVerification(asg);
    expect(fake.calls.clone).toBe(1);
    const nm = path.join(handle.worktreePath, 'node_modules');

    // Now recreate exactly what a PRE-version-proof build left behind: the same
    // fingerprint and a smoke-clean tree, stamped v2 — but with left-pad at a
    // version the lockfile does not resolve. Under v2 semantics this
    // short-circuited and the stale versions were never noticed.
    fs.writeFileSync(
      path.join(nm, 'left-pad', 'package.json'),
      `${JSON.stringify({ name: 'left-pad', version: '9.9.9', main: 'index.js' }, null, 2)}\n`,
    );
    fs.writeFileSync(path.join(nm, PROVISION_MARKER_FILE), `v2:${first.fingerprint}`, 'utf8');

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('primary_tree_stale');
    expect(error.message).toContain('left-pad');
    expect(error.message).toContain('9.9.9');
    expect(fake.calls.clone).toBe(1); // never rebuilt — refused in place
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

  // ROUND 15 REGRESSION 4 — REVERSED. Round 4 made the depth cap fail closed
  // because a silent truncation still produced a smoke-attested marker; that was
  // right when the proof was the only guard. It is wrong under the governing
  // principle: a tree nested past our limit is a tree MAIN clones and verifies,
  // and refusing it means the SCAN's limit, not the tree, decides the run. Depth
  // exhaustion is now indeterminate — warn loudly, name the path, proceed.
  it('nesting DEEPER than the scan limit warns and PROCEEDS (never a silent truncation either)', async () => {
    const repo = track(await makeDepsRepo());
    const nm = await writePrimaryNodeModules(repo.dir);
    let deep = path.join(nm, 'left-pad');
    for (let level = 0; level <= 17; level += 1) {
      deep = path.join(deep, 'node_modules', `lvl${level}`);
    }
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'package.json'), '{"name":"deep","version":"1.0.0"}\n');
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_scan_depth');
    const handle = await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(true);
    const depthWarn = warnings
      .filter((w) => w.kind === 'proof_indeterminate')
      .find((w) => /deeper than \d+ levels/i.test((w as { reason: string }).reason));
    expect(depthWarn).toBeDefined();
    expect((depthWarn as { subject: string }).subject).toContain('node_modules');
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
    // Named by its DIRECTORY, which is the nested copy — not the hoisted one.
    expect(error.message).toContain(path.join('left-pad', 'node_modules', 'nested-native'));
  });

  // REGRESSION 1 (round 10) — the nested smoke used to request
  // `parent/node_modules/child`, which Node resolves as a SUBPATH of the parent.
  // A parent declaring `exports` therefore threw ERR_PACKAGE_PATH_NOT_EXPORTED and
  // a VALID tree — one main clones and uses without complaint — was falsely
  // refused. The smoke must prove the addon LOADS, not that one spelling resolves.
  it('a nested native under a parent declaring `exports` is NOT falsely refused', async () => {
    const repo = track(await makeDepsRepo());
    const nm = await writePrimaryNodeModules(repo.dir);
    // The parent restricts its own surface with `exports` — legal and common.
    fs.writeFileSync(
      path.join(nm, 'left-pad', 'package.json'),
      `${JSON.stringify(
        { name: 'left-pad', version: '1.0.0', main: 'index.js', exports: { '.': './index.js' } },
        null,
        2,
      )}\n`,
    );
    // ...and holds a nested native package that is BUILT and loads fine.
    const nested = path.join(nm, 'left-pad', 'node_modules');
    fs.mkdirSync(nested, { recursive: true });
    writeInstalledPackage(nested, 'nested-native', { native: true, built: true });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_nested_exports');
    await createAtHead(repo, manager, asg);

    // Main clones this tree happily; so must we.
    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    expect(fake.calls.clone).toBe(1);
  });

  // ROUND 13 ITEM 4 — the same error, one layer over: the smoke proved loading by
  // CommonJS `require` EXCLUSIVELY, so an ESM-only package was refused for the
  // mechanism it declares rather than for being broken. Main clones and uses such a
  // tree without complaint. The principle is REGRESSION 1's: prove the addon LOADS,
  // by whichever mechanism the package declares — not that one specifier form works.
  it('an ESM-ONLY native package that loads via import() is NOT falsely refused', async () => {
    const repo = track(await makeDepsRepo({ deps: { 'left-pad': '1.0.0', 'esm-native': '1.0.0' } }));
    const nm = await writePrimaryNodeModules(repo.dir, { packages: ['left-pad', 'esm-native'] });
    const dir = path.join(nm, 'esm-native');
    // A native build (binding.gyp + a node-gyp install hook) whose ONLY export
    // condition is `import`. `require('esm-native')` throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED — "No \"exports\" main defined" — because the
    // `require` condition matches nothing; `import('esm-native')` loads it. (A
    // `"type":"module"` entry point reaches the same place via ERR_REQUIRE_ESM, or
    // ERR_REQUIRE_ASYNC_MODULE with a top-level await.)
    fs.writeFileSync(path.join(dir, 'binding.gyp'), '{ "targets": [] }\n');
    fs.writeFileSync(path.join(dir, 'index.mjs'), 'export const native = true;\n');
    // ROUND 15: these fixtures are about WHICH SPECIFIER resolves, not about the
    // build, so they ship a real compiled artifact for the artifact proof.
    fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true });
    fs.copyFileSync(realNativeAddon(), path.join(dir, 'build', 'Release', 'bind.node'));
    fs.rmSync(path.join(dir, 'index.js'), { force: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'esm-native',
          version: '1.0.0',
          type: 'module',
          exports: { '.': { import: './index.mjs' } },
          scripts: { install: 'node-gyp rebuild' },
        },
        null,
        2,
      )}\n`,
    );
    const fake = fakeRuntime();
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_esm_native');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    // And it was genuinely SMOKED, not skipped: the package is in the attestation.
    const smoked = warnings.find((w) => w.kind === 'native_smoke_passed');
    expect(smoked).toBeDefined();
    expect((smoked as { packages: readonly string[] }).packages.some((p) => p.endsWith('esm-native'))).toBe(true);
  });

  // ROUND 14 REGRESSION 3 — Node lets a package define exported SUBPATHS with no
  // root entry at all (nodejs.org/api/packages.html#subpath-exports), and lets a
  // package ship only a CLI. The smoke asked for the bare name and nothing else,
  // so neither `require(name)` nor `import(name)` could ever resolve and a tree
  // MAIN clones and uses was refused. Under the governing principle: prove it by
  // any mechanism the package DECLARES; if it declares none we can load, warn and
  // proceed — never refuse.
  it('a native package exporting only a SUBPATH is proven through that subpath', async () => {
    const repo = track(await makeDepsRepo({ deps: { 'left-pad': '1.0.0', 'subpath-native': '1.0.0' } }));
    const nm = await writePrimaryNodeModules(repo.dir, { packages: ['left-pad', 'subpath-native'] });
    const dir = path.join(nm, 'subpath-native');
    fs.writeFileSync(path.join(dir, 'binding.gyp'), '{ "targets": [] }\n');
    fs.writeFileSync(path.join(dir, 'addon.js'), 'module.exports = { native: true };\n');
    // ROUND 15: these fixtures are about WHICH SPECIFIER resolves, not about the
    // build, so they ship a real compiled artifact for the artifact proof.
    fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true });
    fs.copyFileSync(realNativeAddon(), path.join(dir, 'build', 'Release', 'bind.node'));
    fs.rmSync(path.join(dir, 'index.js'), { force: true });
    // No `main`, and `exports` declares no '.' — `require('subpath-native')` can
    // only ever throw ERR_PACKAGE_PATH_NOT_EXPORTED.
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'subpath-native',
          version: '1.0.0',
          exports: { './addon': './addon.js' },
          scripts: { install: 'node-gyp rebuild' },
        },
        null,
        2,
      )}\n`,
    );
    const fake = fakeRuntime();
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_r14_subpath');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    // PROVEN, not merely tolerated: it is in the smoke attestation and nothing was
    // declared unprovable.
    const smoked = warnings.find((w) => w.kind === 'native_smoke_passed');
    expect((smoked as { packages: readonly string[] }).packages.some((p) => p.endsWith('subpath-native'))).toBe(true);
    expect(warnings.filter((w) => w.kind === 'proof_indeterminate')).toEqual([]);
  });

  it('a native package with NO loadable entry (a CLI only) warns and proceeds — it never refuses', async () => {
    const repo = track(await makeDepsRepo({ deps: { 'left-pad': '1.0.0', 'cli-native': '1.0.0' } }));
    const nm = await writePrimaryNodeModules(repo.dir, { packages: ['left-pad', 'cli-native'] });
    const dir = path.join(nm, 'cli-native');
    fs.writeFileSync(path.join(dir, 'binding.gyp'), '{ "targets": [] }\n');
    fs.writeFileSync(path.join(dir, 'cli.js'), '#!/usr/bin/env node\nconsole.log("hi");\n');
    // ROUND 15: these fixtures are about WHICH SPECIFIER resolves, not about the
    // build, so they ship a real compiled artifact for the artifact proof.
    fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true });
    fs.copyFileSync(realNativeAddon(), path.join(dir, 'build', 'Release', 'bind.node'));
    fs.rmSync(path.join(dir, 'index.js'), { force: true });
    // Ships a CLI and nothing importable: no `main`, no `exports`, no index.js.
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'cli-native',
          version: '1.0.0',
          bin: { 'cli-native': './cli.js' },
          scripts: { install: 'node-gyp rebuild' },
        },
        null,
        2,
      )}\n`,
    );
    const fake = fakeRuntime();
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_r14_cli_only');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('clone');
    const indeterminate = warnings.filter((w) => w.kind === 'proof_indeterminate');
    expect(indeterminate).toHaveLength(1);
    expect((indeterminate[0] as { subject: string }).subject).toContain('cli-native');
    expect((indeterminate[0] as { reason: string }).reason).toMatch(/no .*entry|bin/i);
  });

  it('a package that DECLARES a root entry which fails to load is still REFUSED (better-sqlite3 keeps working)', async () => {
    // The pair to the two above: the fallback must not become a way to pass
    // without loading anything. This is our real dependency's shape — a `main`
    // that dlopens a binding that was never built.
    const repo = track(await makeDepsRepo({ deps: { 'left-pad': '1.0.0' }, devDeps: { 'real-native': '1.0.0' } }));
    await writePrimaryNodeModules(repo.dir, {
      packages: ['left-pad', 'real-native'],
      native: { name: 'real-native', built: false },
    });
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_r14_declared_root_broken');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    expect(error.message).toContain('real-native');
  });

  it('an ESM-only native package whose entry point is BROKEN is still refused', async () => {
    // The fallback proves loading; it must not become a way to pass without one.
    const repo = track(await makeDepsRepo({ deps: { 'left-pad': '1.0.0', 'esm-native': '1.0.0' } }));
    const nm = await writePrimaryNodeModules(repo.dir, { packages: ['left-pad', 'esm-native'] });
    const dir = path.join(nm, 'esm-native');
    fs.writeFileSync(path.join(dir, 'binding.gyp'), '{ "targets": [] }\n');
    // Declares the ESM entry point but never built the addon it imports.
    fs.writeFileSync(path.join(dir, 'index.mjs'), "import './build/Release/bind.node';\nexport const native = true;\n");
    // ROUND 15: these fixtures are about WHICH SPECIFIER resolves, not about the
    // build, so they ship a real compiled artifact for the artifact proof.
    fs.mkdirSync(path.join(dir, 'build', 'Release'), { recursive: true });
    fs.copyFileSync(realNativeAddon(), path.join(dir, 'build', 'Release', 'bind.node'));
    fs.rmSync(path.join(dir, 'index.js'), { force: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify(
        {
          name: 'esm-native',
          version: '1.0.0',
          type: 'module',
          exports: { '.': { import: './index.mjs' } },
          scripts: { install: 'node-gyp rebuild' },
        },
        null,
        2,
      )}\n`,
    );
    const manager = await openManager(repo);
    const asg = assignmentId('asg_esm_native_broken');
    await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    // BOTH attempts are reported, so the operator is not told a half-truth about
    // which mechanism failed. ROUND 14: each attempt now names the TARGET it
    // tried, since a package can declare several.
    expect(error.message).toMatch(/require esm-native:/);
    expect(error.message).toMatch(/import esm-native:/);
  });
});

// ---------------------------------------------------------------------------
// ROUND 15 REGRESSION 3 — the install lane is BACK, gated on the native proof.
//
// F9 removed it because `npm ci --ignore-scripts` cannot build a native
// dependency. True — and too broad: a script-less install is perfectly fine for a
// project with no native dependencies at all, which is most of them. The removal
// unconditionally refused three things MAIN does successfully: `provision:
// 'install'`, a round whose implementor changed the manifests, and any host
// without APFS copy-on-write.
//
// The hazard was never the lane, it was stamping its output PROVEN. So the lane
// returns and the (now genuinely working) artifact proof decides: a tree with a
// native package the install could not build is refused exactly as before, and a
// pure-JS tree provisions. This DELETES the removal machinery rather than adding
// more shape handling.
// ---------------------------------------------------------------------------
describe('ROUND 15 REGRESSION 3 — the install lane, gated on the native proof', () => {
  it("DECISIVE (b): a pure-JS project on provision:'install' SUCCEEDS", async () => {
    const repo = track(await makeDepsRepo());
    // No primary node_modules at all — the install lane does not need one.
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime, provision: 'install' });
    const asg = assignmentId('asg_r15_install_purejs');
    const handle = await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);

    expect(outcome.provisioned).toBe(true);
    expect(outcome.strategy).toBe('install');
    expect(fake.calls.install).toBe(1);
    expect(fake.calls.clone).toBe(0);
    // A real, marked tree the verifier can use.
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', '.bin'))).toBe(true);
    expect(readFileSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE), 'utf8')).toBe(
      `v3:${outcome.fingerprint}`,
    );
  });

  it('the install lane is GATED: an unbuilt native dependency it produced is still REFUSED', async () => {
    // The pair to the above, and the reason removal was the wrong remedy: the
    // hazard is an unprovable TREE, and that is caught where it always should have
    // been — at the proof, not by deleting the lane.
    const repo = track(await makeDepsRepo({ deps: { 'left-pad': '1.0.0' } }));
    const fake = fakeRuntime({
      installImpl: async (cwd) => {
        const nm = path.join(cwd, 'node_modules');
        fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
        fs.writeFileSync(path.join(nm, '.bin', 'placeholder'), '#!/bin/sh\n');
        writeInstalledPackage(nm, 'left-pad');
        // Exactly what `--ignore-scripts` leaves: present, declared native, unbuilt.
        writeInstalledPackage(nm, 'needs-build', { native: true, built: false });
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime, provision: 'install' });
    const asg = assignmentId('asg_r15_install_gated');
    const handle = await createAtHead(repo, manager, asg);

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('native_toolchain_unproven');
    expect(error.message).toContain('needs-build');
    expect(fake.calls.install).toBe(1); // the lane RAN; the proof rejected its output
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', PROVISION_MARKER_FILE))).toBe(false);
  });

  it('a non-COW host installs instead of refusing (main provisions here)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime({ cloneSupported: false });
    const manager = await openManager(repo, { runtime: fake.runtime }); // 'auto'
    const asg = assignmentId('asg_r15_no_cow');
    await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);

    expect(outcome.strategy).toBe('install');
    expect(fake.calls.install).toBe(1);
  });

  it('a round whose implementor CHANGED the manifests installs from the new ones', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_r15_deps_changed');
    const handle = await createAtHead(repo, manager, asg);
    // The implementor adds a dependency and commits — the primary's tree is now the
    // WRONG dependency set, which is precisely what the install lane is for.
    await writeFile(
      path.join(handle.worktreePath, 'package.json'),
      `${JSON.stringify(
        { name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0', chalk: '5.0.0' } },
        null,
        2,
      )}\n`,
    );
    await commitInWorktree(handle.worktreePath, 'add a dependency');

    const outcome = await manager.provisionForVerification(asg);

    expect(outcome.strategy).toBe('install');
    expect(fake.calls.clone).toBe(0); // never clones a source that does not match
    expect(fake.calls.install).toBe(1);
  });

  it('a primary with no cloneable tree installs rather than refusing', async () => {
    const repo = track(await makeDepsRepo());
    // No primary node_modules: nothing to clone, everything to install.
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime, provision: 'clone' });
    const asg = assignmentId('asg_r15_no_source');
    await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);

    expect(outcome.strategy).toBe('install');
    expect(fake.calls.install).toBe(1);
  });
});

describe('F9 AC-4 — the config vocabulary means what it says', () => {
  // ROUND 15: the two rows that asserted `'install'` was refused, and that a
  // non-APFS host failed closed, are gone with the removal itself — both cases are
  // asserted as INSTALLS in the `ROUND 15 REGRESSION 3` block above.
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

  it('HIGH-6 #6 / ROUND 10: a post-TTL stage collects on the TIMESTAMP, not on owner liveness', async () => {
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

    // ROUND 10 (Regression 2): owner liveness NO LONGER extends retention. The
    // recorded pid is the ORCHESTRATOR's, not the producer's, so "owner alive"
    // held for the entire life of a long-running orchestrator and every timed-out
    // stage was retained indefinitely — an unbounded cost main does not have. The
    // TTL now runs from the quarantine timestamp alone.
    const ownerProbe = {
      self: () => ({ pid: process.pid, startedAt: 'SELF' }),
      isOwnerAlive: (): boolean => true, // even a "live" owner does not hold a stage open
    };

    gcProvisionStages(manager.baseDir, String(asg), undefined, undefined, ownerProbe);

    // BOTH are past the TTL, so both collect regardless of any liveness claim.
    expect(existsSync(liveStage)).toBe(false);
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

  // ROUND 13 ITEM 2 — the cap was enforced by DELETING protected stages, which is
  // the exact race quarantine exists to prevent: those stages are protected
  // precisely because a producer that outlived its deadline may still be writing
  // into them, and `withDeadline` stops waiting without stopping the writer. A cap
  // is a reason to stop STARTING producers, not a licence to delete their trees.
  it('ROUND 13 ITEM 2: at the cap, provisioning refuses to start another producer and deletes nothing', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_cap_backpressure');
    await createAtHead(repo, manager, asg);
    const stageRoot = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg));
    fs.mkdirSync(stageRoot, { recursive: true });

    // One MORE than the cap, all freshly quarantined (inside the TTL) — the state
    // the old code resolved by evicting the oldest.
    const planted: string[] = [];
    for (let i = 0; i <= MAX_QUARANTINED_STAGES; i += 1) {
      const stage = path.join(stageRoot, `stage-protected-${String(i)}`);
      fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(
        path.join(stage, QUARANTINE_MARKER_FILE),
        JSON.stringify({ quarantinedAtMs: Date.now(), ownerPid: process.pid }),
      );
      fs.writeFileSync(path.join(stage, 'producer-output.txt'), `stage ${String(i)}\n`);
      planted.push(stage);
    }

    const error = await expectProvisioningFailure(manager.provisionForVerification(asg));

    expect(error.provisioningCause).toBe('quarantine_cap_reached');
    expect(fake.calls.clone).toBe(0); // no producer was started — that IS the fix
    // Back-pressure, not eviction: every protected stage, and every byte a live
    // producer may still be writing into it, is untouched.
    for (const stage of planted) {
      expect(existsSync(path.join(stage, QUARANTINE_MARKER_FILE))).toBe(true);
      expect(existsSync(path.join(stage, 'producer-output.txt'))).toBe(true);
    }
  });

  it('ROUND 13 ITEM 2: a GC sweep never deletes a PROTECTED stage, cap or no cap', async () => {
    // The same rule stated where the deletion used to happen. GC collects ordinary
    // stages and leaves protected ones for the TTL; the cap is enforced by refusing
    // new producers (above), never by sweeping a stage a writer may still hold.
    const repo = track(await makeDepsRepo());
    const manager = await openManager(repo);
    const asg = assignmentId('asg_cap_gc');
    await createAtHead(repo, manager, asg);
    const stageRoot = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg));
    fs.mkdirSync(stageRoot, { recursive: true });
    for (let i = 0; i <= MAX_QUARANTINED_STAGES; i += 1) {
      const stage = path.join(stageRoot, `stage-protected-${String(i)}`);
      fs.mkdirSync(stage, { recursive: true });
      fs.writeFileSync(
        path.join(stage, QUARANTINE_MARKER_FILE),
        JSON.stringify({ quarantinedAtMs: Date.now(), ownerPid: process.pid }),
      );
    }
    // …plus one ORDINARY stage, which must still be collected.
    fs.mkdirSync(path.join(stageRoot, 'stage-ordinary'), { recursive: true });

    gcProvisionStages(manager.baseDir, String(asg));

    for (let i = 0; i <= MAX_QUARANTINED_STAGES; i += 1) {
      expect(existsSync(path.join(stageRoot, `stage-protected-${String(i)}`))).toBe(true);
    }
    expect(existsSync(path.join(stageRoot, 'stage-ordinary'))).toBe(false);
  });

  it('a stage that cannot be REMOVED is never reported as removed', async () => {
    // The other half of ITEM 2: report only what actually happened. (The eviction
    // block counted every stage it TRIED to delete; the ordinary sweep already
    // warned only after a successful `rmSync`, and this pins that it stays so.)
    const repo = track(await makeDepsRepo());
    const manager = await openManager(repo);
    const asg = assignmentId('asg_gc_unremovable');
    await createAtHead(repo, manager, asg);
    const stageRoot = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg));
    const stage = path.join(stageRoot, 'stage-undeletable');
    fs.mkdirSync(stage, { recursive: true });
    fs.writeFileSync(path.join(stage, 'child.txt'), 'x\n');
    fs.chmodSync(stage, 0o500); // r-x: its children cannot be unlinked

    const warnings: ProvisionWarnEvent[] = [];
    try {
      gcProvisionStages(manager.baseDir, String(asg), undefined, (e) => warnings.push(e));
      expect(existsSync(stage)).toBe(true); // it really did survive
      expect(warnings.some((w) => w.kind === 'stage_gc_removed')).toBe(false);
    } finally {
      fs.chmodSync(stage, 0o700);
    }
  });
});

