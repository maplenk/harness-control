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
  readonly lock?: string;
  readonly npmrc?: string;
  readonly ignore?: boolean;
  readonly prefix?: string;
} = {}): Promise<TempGitRepo> {
  const repo = await makeTempGitRepo(opts.prefix ?? 'harness-f7-');
  if (opts.ignore !== false) await repo.writeFile('.gitignore', 'node_modules/\n');
  await repo.writeFile(
    'package.json',
    `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: opts.deps ?? { 'left-pad': '1.0.0' } }, null, 2)}\n`,
  );
  await repo.writeFile('package-lock.json', opts.lock ?? DEFAULT_LOCK);
  if (opts.npmrc !== undefined) await repo.writeFile('.npmrc', opts.npmrc);
  await repo.commitAll('deps');
  return repo;
}

/** A REAL on-disk primary `node_modules` (the clone source), with a safe relative
 * `.bin` link — exactly the shape a dev's installed tree has. Git-ignored, so it
 * sits on disk untracked, never committed. */
async function writePrimaryNodeModules(
  root: string,
  opts: { readonly withVite?: boolean; readonly badLink?: 'absolute' | 'escaping' } = {},
): Promise<string> {
  const nm = path.join(root, 'node_modules');
  fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
  fs.mkdirSync(path.join(nm, 'left-pad'), { recursive: true });
  fs.writeFileSync(path.join(nm, 'left-pad', 'index.js'), 'CLONE_SOURCE\n');
  await symlink('../left-pad/index.js', path.join(nm, '.bin', 'left-pad')); // safe relative link
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
} = {}): FakeRuntime {
  const calls = { clone: 0, install: 0 };
  const runtime: ProvisionRuntime = {
    cloneSupported: opts.cloneSupported ?? true,
    platformKey: opts.platformKey ?? 'test-platform',
    async cloneDir(src, dst) {
      calls.clone += 1;
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
  } = {},
): Promise<GitWorktreeManager> {
  const manager = await GitWorktreeManager.open({
    primaryRepoRoot: repo.dir,
    clock: new ManualClock('2026-07-22T00:00:00.000Z'),
    provisionRuntime: opts.runtime ?? fakeRuntime().runtime,
    ...(opts.provision !== undefined ? { provision: opts.provision } : {}),
    ...(opts.warn !== undefined ? { provisionWarn: opts.warn } : {}),
    ...(opts.provisionGit !== undefined ? { provisionGit: opts.provisionGit } : {}),
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
    expect(readFileSync(path.join(nm, PROVISION_MARKER_FILE), 'utf8')).toBe(outcome.fingerprint);

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

  it('INSTALL when the primary node_modules is ABSENT (never clone a missing source)', async () => {
    const repo = track(await makeDepsRepo());
    // No writePrimaryNodeModules → primary absent.
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_install_absent');
    const handle = await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);
    expect(outcome.strategy).toBe('install');
    expect(fake.calls).toEqual({ clone: 0, install: 1 });
    expect(readFileSync(path.join(handle.worktreePath, 'node_modules', 'installed-pkg', 'index.js'), 'utf8')).toBe(
      'FAKE_INSTALL\n',
    );
  });

  it('INSTALL when the primary node_modules is HOLLOW (empty dir — never clone nothing)', async () => {
    const repo = track(await makeDepsRepo());
    fs.mkdirSync(path.join(repo.dir, 'node_modules'), { recursive: true }); // empty/hollow
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_install_hollow');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
    expect(fake.calls).toEqual({ clone: 0, install: 1 });
  });

  it('INSTALL (never clone an unproven source) when the primary drifted from the committed manifests', async () => {
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

    expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
    expect(fake.calls).toEqual({ clone: 0, install: 1 });
  });

  it('non-APFS host → clone falls back to install (with a clone_unsupported warning)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir);
    const fake = fakeRuntime({ cloneSupported: false });
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_non_apfs');
    await createAtHead(repo, manager, asg);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
    expect(fake.calls).toEqual({ clone: 0, install: 1 });
    expect(warnings.some((w) => w.kind === 'clone_unsupported')).toBe(true);
  });

  it.each([
    ['package-lock.json only', async (wt: string) => writeFile(path.join(wt, 'package-lock.json'), `${DEFAULT_LOCK}\n// bumped`)],
    ['package.json only', async (wt: string) => writeFile(path.join(wt, 'package.json'), `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '2.0.0' } }, null, 2)}\n`)],
    ['.npmrc', async (wt: string) => writeFile(path.join(wt, '.npmrc'), 'registry=https://example.test/\n')],
  ])(
    'a committed %s change REPROVISIONS (fingerprint marker mismatch), and an unchanged re-run is a no-op',
    async (_label, mutate) => {
      const repo = track(await makeDepsRepo());
      // Primary absent → every reprovision goes install (deterministic counting).
      const fake = fakeRuntime();
      const manager = await openManager(repo, { runtime: fake.runtime });
      const asg = assignmentId('asg_rebind');
      const handle = await createAtHead(repo, manager, asg);

      expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
      expect(fake.calls.install).toBe(1);

      // Idempotent: unchanged manifests short-circuit on the marker.
      expect((await manager.provisionForVerification(asg)).strategy).toBe('short_circuit');
      expect(fake.calls.install).toBe(1);

      // A committed manifest change reprovisions.
      await mutate(handle.worktreePath);
      await commitInWorktree(handle.worktreePath, 'edit manifest');
      expect((await manager.provisionForVerification(asg)).strategy).toBe('install');
      expect(fake.calls.install).toBe(2);
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

  it('a CLONE that contains an escaping link falls back to install (auto strategy)', async () => {
    const repo = track(await makeDepsRepo());
    await writePrimaryNodeModules(repo.dir, { badLink: 'escaping' });
    const fake = fakeRuntime();
    const warnings: ProvisionWarnEvent[] = [];
    const manager = await openManager(repo, { runtime: fake.runtime, warn: (e) => warnings.push(e) });
    const asg = assignmentId('asg_badlink_fallback');
    const handle = await createAtHead(repo, manager, asg);

    const outcome = await manager.provisionForVerification(asg);
    expect(outcome.strategy).toBe('install');
    expect(fake.calls).toEqual({ clone: 1, install: 1 });
    expect(warnings.some((w) => w.kind === 'clone_symlinks_unsafe')).toBe(true);
    // The unsafe clone was discarded; the safe install tree is what landed.
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', 'installed-pkg'))).toBe(true);
    expect(existsSync(path.join(handle.worktreePath, 'node_modules', 'escape-link'))).toBe(false);
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
  it('an install failure leaves a pre-existing tree intact, nothing staged inside the worktree, and recovers next call', async () => {
    const repo = track(await makeDepsRepo()); // primary absent → install lane
    let failInstall = false;
    const fake = fakeRuntime({
      installImpl: async (cwd) => {
        if (failInstall) throw new Error('install boom');
        const nm = path.join(cwd, 'node_modules');
        fs.mkdirSync(path.join(nm, '.bin'), { recursive: true }); // B2: real toolchain dir
        fs.mkdirSync(path.join(nm, 'installed-pkg'), { recursive: true });
        fs.writeFileSync(path.join(nm, 'installed-pkg', 'index.js'), 'GEN1\n');
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_rollback');
    const handle = await createAtHead(repo, manager, asg);

    // First provision succeeds — a real tree lands.
    await manager.provisionForVerification(asg);
    expect(readFileSync(path.join(handle.worktreePath, 'node_modules', 'installed-pkg', 'index.js'), 'utf8')).toBe('GEN1\n');

    // A change forces a rebuild; make THAT install fail.
    await writeFile(path.join(handle.worktreePath, 'package.json'), `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '3.0.0' } }, null, 2)}\n`);
    await commitInWorktree(handle.worktreePath, 'bump');
    failInstall = true;
    await expectRejectsWithKind(manager.provisionForVerification(asg), 'provisioning_failed');

    // The PRE-EXISTING tree is intact (rollback: the prior tree was never removed —
    // the swap is only reached after a successful build), and NOTHING is staged
    // inside the worktree (no node_modules.tmp-*; git status still clean).
    expect(readFileSync(path.join(handle.worktreePath, 'node_modules', 'installed-pkg', 'index.js'), 'utf8')).toBe('GEN1\n');
    expect((await runGit(['status', '--porcelain'], handle.worktreePath)).stdout.trim()).toBe('');
    const insideWorktree = fs.readdirSync(handle.worktreePath).filter((n) => n.startsWith('node_modules.tmp'));
    expect(insideWorktree).toEqual([]);

    // Recovery: a later successful call reprovisions.
    failInstall = false;
    await manager.provisionForVerification(asg);
    expect(readFileSync(path.join(handle.worktreePath, 'node_modules', 'installed-pkg', 'index.js'), 'utf8')).toBe('GEN1\n');
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
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeRuntime({
      installImpl: async (cwd) => {
        await gate; // hold the lock until the test releases it
        fs.mkdirSync(path.join(cwd, 'node_modules', '.bin'), { recursive: true }); // B2
        fs.writeFileSync(path.join(cwd, 'node_modules', 'x.js'), 'x\n');
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
    const fake = fakeRuntime(); // primary absent → install lane
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_discard_reprovision');
    const handle = await createAtHead(repo, manager, asg);

    // Provision at base, then commit a manifest change and provision again.
    await manager.provisionForVerification(asg);
    expect(fake.calls.install).toBe(1);
    await writeFile(path.join(handle.worktreePath, 'package.json'), `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '5.0.0' } }, null, 2)}\n`);
    await commitInWorktree(handle.worktreePath, 'changed');
    const changedHead = gitSha((await runGit(['rev-parse', 'HEAD'], handle.worktreePath)).stdout.trim());
    await manager.provisionForVerification(asg);
    expect(fake.calls.install).toBe(2); // reprovisioned for the new fingerprint

    // Discard back to the changed commit: the ignored node_modules survives with
    // the matching marker, so the next provision short-circuits (fingerprint held).
    await manager.discardToCommit(asg, changedHead);
    expect((await manager.provisionForVerification(asg)).strategy).toBe('short_circuit');
    expect(fake.calls.install).toBe(2);
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
    const repo = track(await makeDepsRepo()); // primary absent → install lane
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_bin_gone');
    const handle = await createAtHead(repo, manager, asg);
    await manager.provisionForVerification(asg); // install #1 → tree with .bin + marker
    expect(fake.calls.install).toBe(1);
    const nm = path.join(handle.worktreePath, 'node_modules');
    // Corrupt the tree: remove .bin but KEEP the (still-matching) marker.
    fs.rmSync(path.join(nm, '.bin'), { recursive: true, force: true });
    expect(hasBin(nm)).toBe(false);

    expect((await manager.provisionForVerification(asg)).strategy).toBe('install'); // NOT short_circuit
    expect(fake.calls.install).toBe(2);
    expect(hasBin(nm)).toBe(true); // rebuilt with a real .bin
  });

  it('INSTALL when the primary node_modules is populated but has NO .bin (broken clone source)', async () => {
    const repo = track(await makeDepsRepo());
    // A primary node_modules with a package but NO `.bin` — a broken clone source.
    fs.mkdirSync(path.join(repo.dir, 'node_modules', 'left-pad'), { recursive: true });
    fs.writeFileSync(path.join(repo.dir, 'node_modules', 'left-pad', 'index.js'), 'x\n');
    const fake = fakeRuntime();
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_primary_no_bin');
    await createAtHead(repo, manager, asg);

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
    const repo = track(await makeDepsRepo()); // primary absent → install lane
    let failInstall = false;
    const fake = fakeRuntime({
      installImpl: async (cwd) => {
        if (failInstall) throw new Error('rebuild boom');
        const nm = path.join(cwd, 'node_modules');
        fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
        fs.writeFileSync(path.join(nm, 'gen.txt'), 'ORIGINAL\n');
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_b4_restore');
    const handle = await createAtHead(repo, manager, asg);
    await manager.provisionForVerification(asg); // GEN tree lands (marker = fp1)
    const nm = path.join(handle.worktreePath, 'node_modules');
    expect(readFileSync(path.join(nm, 'gen.txt'), 'utf8')).toBe('ORIGINAL\n');

    // A committed manifest change makes the fingerprint fp2 (so the restored tree's
    // fp1 marker will NOT short-circuit — a rebuild is genuinely attempted).
    await writeFile(
      path.join(handle.worktreePath, 'package.json'),
      `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '9.9.9' } }, null, 2)}\n`,
    );
    await commitInWorktree(handle.worktreePath, 'bump deps');

    // Simulate a crash AFTER move-aside, BEFORE move-in: the old (fp1) tree sits in a
    // stage as `old-*` (inside this assignment's namespace dir, #5), and the worktree
    // has NO node_modules.
    const crashStage = path.join(manager.baseDir, PROVISION_STAGE_SUBDIR, String(asg), 'crash');
    fs.mkdirSync(crashStage, { recursive: true });
    fs.renameSync(nm, path.join(crashStage, 'old-deadbeef'));
    expect(existsSync(nm)).toBe(false);

    // Force the rebuild to FAIL. The GC preflight RESTORES the old tree first, so the
    // previously-valid tree survives even though the (fp2) rebuild throws.
    failInstall = true;
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

describe('F7 round-4 #2 — a non-ENOENT primary-manifest read error selects install (never a false clone)', () => {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it.skipIf(isRoot)('an UNREADABLE (present) primary .npmrc → clone NOT attempted, install selected', async () => {
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
      const outcome = await manager.provisionForVerification(asg);
      expect(outcome.strategy).toBe('install'); // the unreadable primary manifest → NOT a clone
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
    const repo = track(await makeDepsRepo()); // primary absent → install lane
    let gen = 0;
    const fake = fakeRuntime({
      installImpl: async (cwd) => {
        gen += 1;
        const nm = path.join(cwd, 'node_modules');
        fs.mkdirSync(path.join(nm, '.bin'), { recursive: true });
        fs.writeFileSync(path.join(nm, 'gen.txt'), `GEN${gen}\n`);
      },
    });
    const manager = await openManager(repo, { runtime: fake.runtime });
    const asg = assignmentId('asg_prod_swap');
    const handle = await createAtHead(repo, manager, asg);
    const nm = path.join(handle.worktreePath, 'node_modules');
    const realGit: ProvisionGit = { isPathIgnored, isPathTracked, readFileAtHead: realReadFileAtHead };

    // A first provision lands GEN1 (the prior valid tree that must survive).
    await manager.provisionForVerification(asg);
    expect(readFileSync(path.join(nm, 'gen.txt'), 'utf8')).toBe('GEN1\n');
    // Bump the committed manifest so the next provision rebuilds (a swap that move-asides GEN1).
    await writeFile(
      path.join(handle.worktreePath, 'package.json'),
      `${JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '2.0.0' } }, null, 2)}\n`,
    );
    await commitInWorktree(handle.worktreePath, 'bump');

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

