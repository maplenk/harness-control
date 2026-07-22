/**
 * F7 — Worktree dependency provisioning (engine-fix-worktree-deps-spec v3).
 *
 * `git worktree add` gives a child worktree source but no `node_modules`, so the
 * host self-check runner and the independent verifier get `tsc`/`vitest` → exit
 * 127 and the run false-negatives ("verification can't run"). This module
 * provisions a REAL, git-ignored `node_modules` DIRECTORY into a child worktree
 * at the post-commit / pre-verification boundary, keyed to the COMMITTED HEAD's
 * dependency manifests:
 *
 *  - **clone** (`cp -c -R`, APFS copy-on-write, instant) when the worktree's
 *    committed dependency fingerprint matches the primary checkout's installed
 *    tree — the common dogfood case (the implementor did not touch manifests);
 *  - **install** (`npm ci --prefer-offline --no-audit --fund=false
 *    --ignore-scripts`) into an out-of-worktree stage otherwise;
 *  - **trivially-true** when the committed manifests declare NO dependencies —
 *    the only legitimate skip;
 *  - **fail-closed** (`WorktreeError{kind:'provisioning_failed'}`) when a repo
 *    where `node_modules` is not git-ignored / is tracked would risk staging deps
 *    into a commit, when neither clone nor install can produce a proven tree, or
 *    when a provisioned tree contains an unsafe (absolute / worktree-escaping)
 *    symlink. The caller HALTS the round before any host command runs — a run can
 *    never be greened by an inherited global `tsc`/`vitest` when local
 *    provisioning did not happen.
 *
 * The whole operation runs inside the caller's mutex + advisory-lease critical
 * section (`GitWorktreeManager.provisionForVerification`, the same wrappers as
 * `createWorktree`/`removeWorktree`). Everything transactional happens OUT OF the
 * git worktree — a `<baseDir>/.provision/<slug>/<stage>-<rand>/` stage (a
 * per-assignment namespace dir, #5) on the SAME filesystem — then a two-step
 * move-aside / move-in swap places the finished tree
 * (POSIX `rename` cannot overwrite a non-empty dir). A `node_modules.tmp-*` never
 * exists inside the worktree, so a crash can never leave an un-ignored artifact
 * for the implementor's `git add -A` to stage; abandoned stages are GC'd on the
 * next call and on `removeWorktree`.
 *
 * DEFERRED (spec §5, NOT built here): runtime toolchain-provenance attestation
 * woven into merge-readiness, a full npm-lifecycle sandbox beyond
 * `--ignore-scripts`, a writable-tree integrity re-check, and a journaled
 * crash-recovery state machine. The fail-closed gate already closes the ACCIDENTAL
 * false-green, which is the MVP threat (cooperative, FS-sandboxed implementor).
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import type { Dirent } from 'node:fs';
import { readdir, readFile, readlink } from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { sha256Hex } from '../artifacts/hash.js';
import { WorktreeError } from './errors.js';

const execFileAsync = promisify(execFile);

/** Marker file written INSIDE a provisioned `node_modules` (after the tree is
 * built, so `npm ci` cannot wipe it) carrying the dependency fingerprint. It is
 * git-ignored along with the rest of `node_modules`. */
export const PROVISION_MARKER_FILE = '.harness-provisioned';
/** Sibling-of-worktrees dir under the manager base dir that holds every
 * out-of-worktree provisioning stage. Never inside a git worktree. */
export const PROVISION_STAGE_SUBDIR = '.provision';
/** Transient build caches purged from a cloned/installed tree so stale cache
 * state is never inherited (a fresh per-worktree cache is created on first use). */
export const TRANSIENT_CACHE_DIRS: readonly string[] = ['.vite', '.cache'];
/** A manifest absent at HEAD/disk is recorded as `null` in the manifest set (vs a
 * present file's string content) -- so "the lockfile was deleted" fingerprints
 * differently from "unchanged", collision-free (JSON `null` is never any string,
 * incl. `"null"`/`""`) and without embedding non-text sentinels in the source. */
type ManifestValue = string | null;

// ---------------------------------------------------------------------------
// Config strategy + result + injection seams
// ---------------------------------------------------------------------------
/** `worktree.provision` config vocabulary (schema.ts). `auto` = clone when the
 * fingerprint matches the primary and APFS is available, else install. */
export type ProvisionStrategy = 'auto' | 'clone' | 'install' | 'none';

/** How a `provisionForVerification` call actually satisfied the worktree. */
export type ProvisionStrategyTaken = 'clone' | 'install' | 'short_circuit' | 'none';

export interface ProvisionOutcome {
  /** Always `true` on a resolved call — a proven real tree, or a trivially-true
   * no-dependency / opt-out skip. A failure THROWS `provisioning_failed`. */
  readonly provisioned: boolean;
  readonly strategy: ProvisionStrategyTaken;
  /** The committed dependency fingerprint the tree is bound to (empty for the
   * `none` opt-out, which reads no manifests). */
  readonly fingerprint: string;
  readonly repoRoot: string;
  readonly worktreePath: string;
  /** Operator-facing one-line explanation of the outcome. */
  readonly detail: string;
}

/** Structured provisioning warnings (non-fatal path notes) for the manager's
 * `provisionWarn` sink. */
export type ProvisionWarnEvent =
  | { readonly kind: 'clone_source_fingerprint_mismatch'; readonly worktreePath: string }
  | { readonly kind: 'clone_unsupported'; readonly reason: string }
  | { readonly kind: 'clone_failed'; readonly detail: string }
  | {
      readonly kind: 'clone_symlinks_unsafe';
      readonly count: number;
      readonly sample: readonly string[];
      readonly fallback: 'install';
    }
  | { readonly kind: 'cache_purged'; readonly cache: string }
  | { readonly kind: 'stage_gc_removed'; readonly stage: string }
  | { readonly kind: 'stage_backup_restored'; readonly stage: string };

export type ProvisionWarnSink = (event: ProvisionWarnEvent) => void;

/**
 * The heavy, host-touching primitives, injected so tests can drive the REAL
 * clone/rename/fail-closed/git logic against temp repos while faking the two
 * genuinely expensive/host-specific operations (an APFS clone, a full `npm ci`).
 */
export interface ProvisionRuntime {
  /** Whether an APFS copy-on-write clone (`cp -c`) is available on this host. A
   * runtime `cloneDir` failure (e.g. a cross-volume base dir) still falls back to
   * install regardless of this flag. */
  readonly cloneSupported: boolean;
  /** Folded into the fingerprint so a tree provisioned under one Node/OS/arch is
   * never short-circuited (or cloned) under an incompatible one. */
  readonly platformKey: string;
  /** COW-clone `srcDir` → `dstDir` (which must NOT already exist). Throws on
   * failure. Default: `cp -c -R`. */
  cloneDir(srcDir: string, dstDir: string): Promise<void>;
  /** Offline install in `cwd` (seeded with the committed manifests), producing
   * `cwd/node_modules`. Throws on failure. Default:
   * `npm ci --prefer-offline --no-audit --fund=false --ignore-scripts`. */
  install(cwd: string): Promise<void>;
}

/** The read-only git plumbing `provisionWorktreeDeps` needs (all committed-HEAD
 * / ignore queries). Defaults to the real `git.ts` functions; injectable. */
export interface ProvisionGit {
  isPathIgnored(worktreePath: string, pathspec: string): Promise<boolean>;
  isPathTracked(worktreePath: string, pathspec: string): Promise<boolean>;
  readFileAtHead(worktreePath: string, relpath: string): Promise<string | undefined>;
}

export interface ProvisionParams {
  /** Used only to name (and GC) this assignment's stage dirs. */
  readonly assignmentId: string;
  readonly worktreePath: string;
  readonly primaryRepoRoot: string;
  /** The manager base dir (`<repo>.worktrees`); the stage lives under it, on the
   * SAME filesystem as the worktree, so the final swap is a rename. */
  readonly baseDir: string;
  readonly strategy: ProvisionStrategy;
  readonly runtime: ProvisionRuntime;
  readonly git: ProvisionGit;
  readonly warn?: ProvisionWarnSink;
  /** Test-only seam for the final move-aside/move-in swap rename (ESM forbids spying
   * `fs.renameSync`); production leaves it undefined so `swapIntoPlace` uses the real
   * rename. Lets a test drive the #2 double-fault through the PRODUCTION catch/finally. */
  readonly rename?: (from: string, to: string) => void;
}

// ---------------------------------------------------------------------------
// Default host runtime
// ---------------------------------------------------------------------------
/** Real host runtime: APFS `cp -c -R` clone + offline `npm ci` install. */
export function defaultProvisionRuntime(): ProvisionRuntime {
  return {
    cloneSupported: process.platform === 'darwin',
    platformKey: `${process.version}|${process.platform}|${process.arch}`,
    async cloneDir(srcDir, dstDir) {
      // `-c` = clonefile(2) (APFS copy-on-write, instant, zero extra space until
      // divergence); `-R` recursive, preserving symlinks. `dstDir` must not exist
      // (cp then creates it as a clone of srcDir).
      await execFileAsync('cp', ['-c', '-R', srcDir, dstDir]);
    },
    async install(cwd) {
      // `--ignore-scripts` is the MVP install-script mitigation (spec §2.2/§5): a
      // manifest the implementor edited cannot run arbitrary lifecycle scripts on
      // the host during provisioning.
      await execFileAsync(
        'npm',
        ['ci', '--prefer-offline', '--no-audit', '--fund=false', '--ignore-scripts'],
        { cwd, env: { ...process.env, npm_config_ignore_scripts: 'true' }, maxBuffer: 64 * 1024 * 1024 },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Manifest reading + dependency fingerprint
// ---------------------------------------------------------------------------
interface ManifestSet {
  /** relpath (posix) → the file's content, or `null` when absent at HEAD/disk. */
  readonly entries: ReadonlyMap<string, ManifestValue>;
  /** The root `package.json` declares at least one dependency (workspace repos
   * fail closed before this is computed — `assertNoWorkspaces`). */
  readonly declaresDeps: boolean;
}

interface ManifestSource {
  read(relpath: string): Promise<string | undefined>;
}

function headSource(git: ProvisionGit, worktreePath: string): ManifestSource {
  return { read: (rel) => git.readFileAtHead(worktreePath, rel) };
}

function diskSource(root: string): ManifestSource {
  return {
    async read(rel) {
      try {
        return await readFile(path.join(root, rel), 'utf8');
      } catch (error) {
        // round-4 #2: return `undefined` ONLY for a GENUINE absence (ENOENT). Any
        // other FS error must NOT be silently classified as absence — a PRESENT but
        // transiently-unreadable primary `.npmrc`/lockfile that looked "absent" could
        // make the primary fingerprint FALSELY match the worktree's (also-absent)
        // entry → cloning an UNPROVEN tree and marking it valid. Throw so
        // `buildStagedTree`'s catch falls back to install (never a false clone).
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
  };
}

/**
 * MVP scope (round-2 #5): npm workspaces are NOT supported — any root
 * `package.json` that declares a `workspaces` KEY (in ANY form: an array of
 * literal / `*` / `**` / `./packages/*` globs, the `{ packages: [...] }` object
 * form, an empty array, OR a non-array / malformed value) FAILS CLOSED. Real
 * workspace provisioning (installing the workspace-local `packages/<pkg>/node_modules`
 * trees an unhoisted / version-conflicting dependency needs) is a deferred
 * follow-up (spec §5). Refusing here is the fail-closed invariant: a workspace
 * repo can never false-green by fingerprinting only the root manifest and
 * silently skipping workspace-local dependencies, and never reaches a clone /
 * install / trivial-success path. Presence of the key alone is decisive — the
 * value is never trusted or normalized. `worktree.provision='none'` opts a repo
 * whose workspaces the operator provisions themselves out of the managed path.
 */
function assertNoWorkspaces(parsedRoot: Record<string, unknown>): void {
  if (!('workspaces' in parsedRoot)) return;
  throw failClosed(
    'npm workspaces are not supported by F7 dependency provisioning (root package.json declares `workspaces`). ' +
      'Refusing rather than provisioning only the root tree and silently missing workspace-local dependencies ' +
      "(real workspace support is a deferred follow-up — see spec §5). Set worktree.provision='none' to opt this repo out.",
    'root package.json declares workspaces (unsupported; fail closed)',
  );
}

/** Parse a package.json manifest, FAILING CLOSED on malformed JSON (B3) — a
 * corrupt manifest must never be silently treated as declaring no dependencies. */
function parsePackageJson(content: string, relpath: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw failClosed(`malformed ${relpath} at HEAD (cannot parse JSON): ${messageOf(error)}`, `malformed ${relpath}`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw failClosed(`malformed ${relpath} at HEAD (not a JSON object)`, `malformed ${relpath}`);
  }
  return parsed as Record<string, unknown>;
}

function packageDeclaresDeps(parsed: Record<string, unknown>): boolean {
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const) {
    const value = parsed[field];
    if (value !== null && typeof value === 'object' && Object.keys(value as object).length > 0) return true;
  }
  return false;
}

/**
 * Collect the dependency manifests (root `package.json`, `package-lock.json`,
 * `.npmrc`) into the fingerprint input map. FAILS CLOSED on: a git/read failure
 * surfaced by `source.read` (headSource throws on a git error, B3), malformed
 * manifest JSON (B3), or ANY `workspaces` declaration (round-2 #5 — npm workspaces
 * are unsupported, `assertNoWorkspaces`) — never mis-classifies any of them as
 * dependency-free.
 */
async function collectManifests(source: ManifestSource, _platformKey: string): Promise<ManifestSet> {
  const entries = new Map<string, ManifestValue>();
  const rootRaw = await source.read('package.json');
  entries.set('package.json', rootRaw ?? null);
  for (const file of ['package-lock.json', '.npmrc']) {
    entries.set(file, (await source.read(file)) ?? null);
  }
  const rootParsed = rootRaw !== undefined ? parsePackageJson(rootRaw, 'package.json') : undefined;
  if (rootParsed !== undefined) assertNoWorkspaces(rootParsed);
  const declaresDeps = rootParsed !== undefined && packageDeclaresDeps(rootParsed);
  return { entries, declaresDeps };
}

/**
 * Deterministic hash over the committed dependency inputs (root `package.json`,
 * `package-lock.json`, effective `.npmrc`) plus the platform key.
 * This is the provenance key: it decides clone-vs-install, the idempotent
 * short-circuit, and the `.harness-provisioned` marker — so a `package.json`-only
 * edit (not just the lockfile) reprovisions, and a tree is never reused across an
 * incompatible platform.
 */
export function computeDependencyFingerprint(manifests: ManifestSet, platformKey: string): string {
  const sorted = [...manifests.entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return sha256Hex(JSON.stringify({ v: 1, platformKey, entries: sorted }));
}

// ---------------------------------------------------------------------------
// Symlink containment scan
// ---------------------------------------------------------------------------
export interface SymlinkContainmentScan {
  /** The staged tree currently on disk that is being scanned. */
  readonly stageTreeRoot: string;
  /** Where the tree WILL live after the move-in swap (`<worktree>/node_modules`) —
   * links are resolved as if already there (H7). */
  readonly eventualTreeRoot: string;
  /** The boundary a link's resolved target must stay within (`<worktree>`). */
  readonly containmentRoot: string;
  readonly max?: number;
}

/**
 * Walk a staged tree and return every symlink whose target is ABSOLUTE or escapes
 * the WORKTREE once the tree is moved into place (H7). Each link is resolved from
 * its EVENTUAL in-worktree location, so a normal npm-workspace link
 * (`node_modules/pkg → ../packages/pkg`, i.e. into the worktree) is SAFE while an
 * absolute or worktree-escaping link is flagged. A `.bin` link
 * (`../typescript/bin/tsc`) stays inside `node_modules` and is likewise safe.
 *
 * B6: a scan that cannot fully complete is FATAL — any readdir/lstat/readlink
 * error THROWS `provisioning_failed`, so a tree with an unreadable subtree (which
 * could hide an escaping link) is never marked/accepted. Bounded by `max`.
 */
export async function scanSymlinkContainment(scan: SymlinkContainmentScan): Promise<string[]> {
  const stageRootAbs = path.resolve(scan.stageTreeRoot);
  const eventualRootAbs = path.resolve(scan.eventualTreeRoot);
  const containmentAbs = path.resolve(scan.containmentRoot);
  const max = scan.max ?? 50;
  const bad: string[] = [];
  const stack: string[] = [stageRootAbs];
  while (stack.length > 0 && bad.length < max) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      throw failClosed(`symlink containment scan could not read ${dir}: ${messageOf(error)}`, messageOf(error));
    }
    for (const entry of entries) {
      if (bad.length >= max) break;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        let target: string;
        try {
          target = await readlink(full);
        } catch (error) {
          throw failClosed(`symlink containment scan could not read link ${full}: ${messageOf(error)}`, messageOf(error));
        }
        if (path.isAbsolute(target)) {
          bad.push(full);
          continue;
        }
        // Resolve from the link's EVENTUAL worktree location, then require the
        // target to stay within the worktree (containmentRoot).
        const eventualLink = path.resolve(eventualRootAbs, path.relative(stageRootAbs, full));
        const resolved = path.resolve(path.dirname(eventualLink), target);
        const relToContainment = path.relative(containmentAbs, resolved);
        if (relToContainment === '..' || relToContainment.startsWith(`..${path.sep}`) || path.isAbsolute(relToContainment)) {
          bad.push(full);
        }
      } else if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
  return bad;
}

/**
 * B1/B8 preflight — fail closed if the worktree's node_modules is tracked,
 * unignored (when present, or when we are about to provision), or a SYMLINK, so a
 * prior round's tree can never enter the implementor's `git add -A` commit and a
 * write-through symlink can never survive the no-dependency shortcut. Runs BEFORE
 * any success return OR mutation; NEVER unlinks (a symlink fails closed without
 * touching disk). B3: a git error THROWS (fail closed), never "not tracked".
 */
async function assertNodeModulesSafe(a: {
  readonly git: ProvisionGit;
  readonly worktreePath: string;
  readonly nodeModules: string;
  readonly repoRoot: string;
  readonly fingerprint: string;
  readonly declaresDeps: boolean;
}): Promise<void> {
  const nmStat = lstatSafe(a.nodeModules);
  if (nmStat?.isSymbolicLink() === true) {
    throw failClosed(
      `worktree dependency provisioning refused for ${a.worktreePath} (repo ${a.repoRoot}): node_modules is a SYMLINK ` +
        '(write-through risk to the primary checkout or outside the worktree); a real, git-ignored node_modules directory is required.',
      `fingerprint=${a.fingerprint}; node_modules is a symlink`,
    );
  }
  const [ignored, tracked] = await Promise.all([
    a.git.isPathIgnored(a.worktreePath, 'node_modules/'),
    a.git.isPathTracked(a.worktreePath, 'node_modules'),
  ]);
  const reasons: string[] = [];
  if (tracked) reasons.push('a node_modules path is TRACKED');
  // An EXISTING tree, or one we are about to create (deps declared), must be
  // ignored — otherwise `git add -A` would stage it into the commit.
  if (!ignored && (nmStat !== undefined || a.declaresDeps)) reasons.push('node_modules is NOT git-ignored');
  if (reasons.length > 0) {
    throw failClosed(
      `worktree dependency provisioning refused for ${a.worktreePath} (repo ${a.repoRoot}): ${reasons.join('; ')}. ` +
        "Add a 'node_modules/' rule to .gitignore and untrack any committed node_modules so provisioned deps can never enter a commit.",
      `fingerprint=${a.fingerprint}; ${reasons.join('; ')}`,
    );
  }
}

// ---------------------------------------------------------------------------
// The provisioning orchestration (runs UNDER the manager's mutex + lease)
// ---------------------------------------------------------------------------
/**
 * Provision `<worktree>/node_modules` for the committed HEAD. MUST be called by
 * `GitWorktreeManager.provisionForVerification` inside the mutex + advisory-lease
 * critical section. Returns a proven outcome or THROWS
 * `WorktreeError{kind:'provisioning_failed'}` (the caller fails closed).
 */
export async function provisionWorktreeDeps(params: ProvisionParams): Promise<ProvisionOutcome> {
  const { worktreePath, primaryRepoRoot: repoRoot, baseDir, strategy, runtime, git } = params;
  const warn: ProvisionWarnSink = params.warn ?? (() => undefined);
  const nodeModules = path.join(worktreePath, 'node_modules');
  // #5: every assignment gets its OWN stage NAMESPACE dir `<.provision>/<slug>/`, so
  // GC is an EXACT per-assignment match (enumerate exactly that dir) — never a bare
  // prefix match where GC for `asg-x` also swept `asg-x-y`'s stages. Distinct slugs
  // are distinct directory names, so there is no prefix aliasing.
  const assignmentStageRoot = path.join(baseDir, PROVISION_STAGE_SUBDIR, sanitizeSlug(params.assignmentId));

  // Crash-recovery preflight (§2.3, B4): adopt-or-remove any abandoned stage/backup
  // dirs a previous crashed provisioning for THIS assignment left behind. If the
  // worktree's node_modules is MISSING but a stage holds an `old-*` backup (a crash
  // after move-aside, before move-in), the backup is RESTORED before deletion — it
  // is the only surviving copy of the prior valid tree.
  gcAbandonedStages(assignmentStageRoot, worktreePath, warn);

  // Explicit opt-out: `none` disables managed provisioning (the operator owns
  // node_modules). Proven-skip so the fail-closed gate never halts a deliberately
  // unmanaged run.
  if (strategy === 'none') {
    return proven('none', '', repoRoot, worktreePath, "provisioning disabled (worktree.provision='none')");
  }

  // Dependency fingerprint from the COMMITTED HEAD manifests (bound to what the
  // implementor just committed — not the base, not the working tree). B3/#5:
  // collectManifests fails closed on a git/read error, malformed manifest JSON, or
  // ANY workspaces declaration (unsupported) — never mis-classifies any as no-deps.
  let wtManifests: ManifestSet;
  try {
    wtManifests = await collectManifests(headSource(git, worktreePath), runtime.platformKey);
  } catch (error) {
    if (error instanceof WorktreeError && error.kind === 'provisioning_failed') throw error;
    throw failClosed(
      `could not read committed dependency manifests for ${worktreePath} (repo ${repoRoot}): ${messageOf(error)}`,
      messageOf(error),
    );
  }
  const fingerprint = computeDependencyFingerprint(wtManifests, runtime.platformKey);

  // B1/B8: run the DEFINITIVE tracked / ignored / symlink checks BEFORE any success
  // return OR mutation — a node_modules that is tracked, unignored, or a symlink
  // fails closed REGARDLESS of whether THIS round declares deps (else a prior
  // round's tree could enter the implementor's `git add -A` commit, or a
  // write-through symlink could survive the no-deps shortcut). Never unlinks. B3: a
  // git error here fails closed (provisioning_failed), never "safe".
  try {
    await assertNodeModulesSafe({ git, worktreePath, nodeModules, repoRoot, fingerprint, declaresDeps: wtManifests.declaresDeps });
  } catch (error) {
    if (error instanceof WorktreeError && error.kind === 'provisioning_failed') throw error;
    throw failClosed(
      `node_modules safety preflight failed for ${worktreePath} (repo ${repoRoot}): ${messageOf(error)}`,
      messageOf(error),
    );
  }

  // No declared dependencies → provisioned-trivially-true (the ONLY legitimate
  // skip), now proven safe by the preflight above. But a dependency-free repo must
  // NOT carry a stale provisioned toolchain into verification (round-2 #1): a prior
  // round's node_modules whose `.bin` could resolve tsc/vitest and green a run that
  // should have none. Remove any existing tree TRANSACTIONALLY — rename it OUT of
  // the worktree into a same-filesystem stage (atomic: the worktree has no
  // node_modules the instant the rename returns, so a crash mid-delete can never
  // leave a partial tree the verifier could still use), then free the moved-aside
  // copy best-effort. If the atomic move cannot be done, FAIL CLOSED. The tree is
  // already proven safe (real, git-ignored, untracked, non-symlink) above.
  if (!wtManifests.declaresDeps) {
    let removedStale = false;
    if (lstatSafe(nodeModules) !== undefined) {
      let doomed: string;
      try {
        fs.mkdirSync(assignmentStageRoot, { recursive: true });
        doomed = fs.mkdtempSync(path.join(assignmentStageRoot, 'nodeps-'));
        fs.renameSync(nodeModules, path.join(doomed, 'removed'));
      } catch (error) {
        throw failClosed(
          `no-dependency repo ${worktreePath} (repo ${repoRoot}) carries a pre-existing node_modules that could not ` +
            `be removed: ${messageOf(error)}. Refusing to verify a dependency-free repo with a stale provisioned toolchain.`,
          `fingerprint=${fingerprint}; stale node_modules removal failed`,
        );
      }
      try {
        fs.rmSync(doomed, { recursive: true, force: true });
      } catch {
        /* best effort — a leftover stage is GC'd on a later provisioning call */
      }
      removedStale = true;
    }
    return proven(
      'none',
      fingerprint,
      repoRoot,
      worktreePath,
      removedStale
        ? 'committed manifests declare no dependencies; removed a stale provisioned node_modules'
        : 'committed manifests declare no dependencies',
    );
  }

  // Idempotent short-circuit: a REAL node_modules directory with a populated
  // `.bin/` (B2 — never accept a broken tree) whose marker matches the fingerprint.
  const existing = lstatSafe(nodeModules);
  if (existing?.isDirectory() === true && hasBinDir(nodeModules) && readMarker(nodeModules) === fingerprint) {
    return proven('short_circuit', fingerprint, repoRoot, worktreePath, 'existing node_modules matches the committed dependency fingerprint');
  }

  // Build a staged tree OUT OF the worktree, scan it, purge caches, mark it, then
  // swap it into place. The stage is under `<baseDir>/.provision`, on the same
  // filesystem as the worktree, so the swap is a rename.
  fs.mkdirSync(assignmentStageRoot, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(assignmentStageRoot, 'stage-'));
  try {
    const built = await buildStagedTree({
      stageDir,
      strategy,
      runtime,
      primaryRepoRoot: repoRoot,
      worktreeFingerprint: fingerprint,
      wtManifests,
      warn,
    });

    // Symlink containment scan against the EVENTUAL worktree boundary (H7). An
    // unsafe link from a CLONE → discard and install fresh (unless clone was
    // forced); an unsafe link that survives install → fail closed. A scan that
    // cannot fully complete THROWS (B6) → fail closed.
    const scanFor = (treeRoot: string): SymlinkContainmentScan => ({
      stageTreeRoot: treeRoot,
      eventualTreeRoot: nodeModules,
      containmentRoot: worktreePath,
    });
    let bad = await scanSymlinkContainment(scanFor(built.treePath));
    if (bad.length > 0 && built.strategyTaken === 'clone' && strategy !== 'clone') {
      warn({ kind: 'clone_symlinks_unsafe', count: bad.length, sample: bad.slice(0, 5), fallback: 'install' });
      fs.rmSync(built.treePath, { recursive: true, force: true });
      built.treePath = await buildViaInstall({ stageDir, runtime, wtManifests });
      built.strategyTaken = 'install';
      bad = await scanSymlinkContainment(scanFor(built.treePath));
    }
    if (bad.length > 0) {
      throw failClosed(
        `provisioned node_modules for ${worktreePath} contains ${bad.length} unsafe symlink(s) ` +
          `(absolute or worktree-escaping): ${bad.slice(0, 5).join(', ')}`,
        `fingerprint=${fingerprint}; strategy=${built.strategyTaken}`,
      );
    }

    purgeTransientCaches(built.treePath, warn);
    // B2: never accept/mark a tree without a real `.bin/` — a populated-but-broken
    // tree (only `.package-lock.json`, or `.bin` vanished) would let the verifier
    // resolve a GLOBAL tsc/vitest and falsely green the run.
    if (!hasBinDir(built.treePath)) {
      throw failClosed(
        `provisioned node_modules for ${worktreePath} has no node_modules/.bin directory (strategy=${built.strategyTaken}) — ` +
          'refusing a tree whose local toolchain is missing (verification would resolve a global binary).',
        `fingerprint=${fingerprint}; strategy=${built.strategyTaken}; missing .bin`,
      );
    }
    // Marker LAST (after the tree is fully built): npm ci wipes node_modules before
    // installing, so a marker written earlier would be lost.
    fs.writeFileSync(path.join(built.treePath, PROVISION_MARKER_FILE), fingerprint, 'utf8');

    try {
      swapIntoPlace(nodeModules, built.treePath, stageDir, params.rename);
    } catch (error) {
      // #2: surface a swap failure as provisioning_failed (fail closed). Whether the
      // stage survives is decided by `stageHoldsBackup` in `finally` — a double fault
      // that left the sole `old-*` backup behind is PRESERVED for crash recovery.
      throw failClosed(
        `could not swap the provisioned node_modules into place for ${worktreePath} (repo ${repoRoot}): ${messageOf(error)}`,
        `fingerprint=${fingerprint}; strategy=${built.strategyTaken}; swap failed`,
      );
    }
    return proven(built.strategyTaken, fingerprint, repoRoot, worktreePath, `provisioned via ${built.strategyTaken}`);
  } finally {
    // Best-effort GC of the stage — but PRESERVE it whenever it still holds an `old-*`
    // backup (#2: a swap whose move-in AND rollback both failed left the sole surviving
    // copy of the prior valid tree there). Deleting it would destroy that only backup;
    // leave it for the next call's crash-recovery preflight to RESTORE. On the success
    // path (and the confirmed-rollback path) no `old-*` remains, so the stage is GC'd.
    if (!stageHoldsBackup(stageDir)) {
      fs.rmSync(stageDir, { recursive: true, force: true });
    }
  }
}

interface BuildArgs {
  readonly stageDir: string;
  readonly strategy: ProvisionStrategy;
  readonly runtime: ProvisionRuntime;
  readonly primaryRepoRoot: string;
  readonly worktreeFingerprint: string;
  readonly wtManifests: ManifestSet;
  readonly warn: ProvisionWarnSink;
}

/** Produce a staged `node_modules` via clone (fingerprint-matched primary, APFS)
 * or install (everything else). Never clones an unproven source. */
async function buildStagedTree(args: BuildArgs): Promise<{ treePath: string; strategyTaken: 'clone' | 'install' }> {
  const { strategy, runtime, primaryRepoRoot, worktreeFingerprint, warn } = args;
  const primaryNodeModules = path.join(primaryRepoRoot, 'node_modules');
  // A real directory (never a symlinked root) with a real `.bin/` — B2: a
  // hollow/empty or toolchain-less primary node_modules is never cloned (it would
  // clone a broken tree and reintroduce the exit-127 false-negative); install. #3:
  // a real FS error reading the non-authoritative clone source is "not cloneable →
  // install", never a fail-closed halt (isolated in `isPrimaryCloneable`).
  const primaryIsCloneable = isPrimaryCloneable(primaryNodeModules);
  const wantsClone = strategy === 'auto' || strategy === 'clone';

  let cloneEligible = false;
  if (wantsClone && runtime.cloneSupported && primaryIsCloneable) {
    // Clone ONLY when the primary's INSTALLED (working-tree) manifests fingerprint
    // matches the worktree's committed one — otherwise the primary tree is the
    // wrong dependency set (an unproven source, never cloned). A failure reading
    // the primary's own manifests is NOT fatal (the primary is only the clone
    // SOURCE, not the authority) — fall back to install.
    try {
      const primaryManifests = await collectManifests(diskSource(primaryRepoRoot), runtime.platformKey);
      cloneEligible = computeDependencyFingerprint(primaryManifests, runtime.platformKey) === worktreeFingerprint;
    } catch (error) {
      warn({ kind: 'clone_failed', detail: `primary manifest read failed: ${messageOf(error)}` });
      cloneEligible = false;
    }
    if (!cloneEligible) warn({ kind: 'clone_source_fingerprint_mismatch', worktreePath: primaryRepoRoot });
  } else if (wantsClone && !runtime.cloneSupported) {
    warn({ kind: 'clone_unsupported', reason: 'APFS copy-on-write (cp -c) is not available on this platform' });
  }

  if (cloneEligible) {
    const dst = path.join(args.stageDir, 'node_modules');
    try {
      await runtime.cloneDir(primaryNodeModules, dst);
      return { treePath: dst, strategyTaken: 'clone' };
    } catch (error) {
      // A runtime clone failure (e.g. a cross-volume base dir, non-APFS at runtime)
      // falls back to install — never fails the run on the clone optimization.
      warn({ kind: 'clone_failed', detail: messageOf(error) });
      fs.rmSync(dst, { recursive: true, force: true });
    }
  }
  return { treePath: await buildViaInstall(args), strategyTaken: 'install' };
}

/** Seed a checkout-free stage with the committed manifests and run `npm ci`
 * there, producing `<stage>/install/node_modules`. Throws `provisioning_failed`
 * on install failure. */
async function buildViaInstall(args: { stageDir: string; runtime: ProvisionRuntime; wtManifests: ManifestSet }): Promise<string> {
  const cwd = path.join(args.stageDir, 'install');
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.mkdirSync(cwd, { recursive: true });
  for (const [rel, content] of args.wtManifests.entries) {
    if (content === null) continue;
    const dst = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, content, 'utf8');
  }
  try {
    await args.runtime.install(cwd);
  } catch (error) {
    throw failClosed(`dependency install (npm ci) failed in ${cwd}: ${messageOf(error)}`, messageOf(error));
  }
  const treePath = path.join(cwd, 'node_modules');
  if (lstatSafe(treePath)?.isDirectory() !== true) {
    throw failClosed(`dependency install produced no node_modules directory in ${cwd}`, 'npm ci left no node_modules');
  }
  return treePath;
}

/**
 * Two-step move-aside / move-in swap (§2.3), all under the caller's lock. POSIX
 * `rename` cannot overwrite a non-empty dir, so a prior tree is renamed aside to
 * the stage FIRST, the new tree renamed in, then the old one deleted. A move-in
 * failure rolls the prior tree back. Everything is on the base-dir filesystem, so
 * every rename is atomic; the backup lives OUTSIDE the worktree.
 */
export function swapIntoPlace(
  target: string,
  newTree: string,
  stageDir: string,
  // Injectable ONLY so a test can drive the #2 double-fault deterministically (ESM
  // forbids spying `fs.renameSync`); production always uses the real rename.
  rename: (from: string, to: string) => void = fs.renameSync,
): void {
  const backup = path.join(stageDir, `old-${randomBytes(6).toString('hex')}`);
  const hadPrior = fs.existsSync(target);
  if (hadPrior) rename(target, backup);
  try {
    rename(newTree, target);
  } catch (moveInError) {
    // #2: move-in failed. Try to roll the prior tree back. If rollback CANNOT be
    // confirmed — the target is not provably restored, e.g. the rollback rename ALSO
    // fails — LEAVE the `old-*` backup in `stageDir`: it is now the ONLY surviving
    // copy of the prior valid tree. The caller's `finally` PRESERVES a stage that
    // still holds an `old-*` (`stageHoldsBackup`), so a later call's crash-recovery
    // preflight can RESTORE it. Never delete an unconfirmed-only backup on a double
    // fault; surface the original move-in failure.
    if (hadPrior && !fs.existsSync(target)) {
      try {
        rename(backup, target);
      } catch {
        /* rollback unconfirmed — the backup stays in stageDir for crash recovery */
      }
    }
    throw moveInError;
  }
  if (hadPrior) fs.rmSync(backup, { recursive: true, force: true });
}

/**
 * True iff `stageDir` still contains an `old-*` backup — the sole surviving copy of a
 * prior valid tree when a swap's move-in AND rollback both failed (#2). Also true
 * (fail SAFE) when the stage cannot be enumerated: never delete a stage on a transient
 * read error when it MIGHT hold the only backup. A genuinely-absent stage (`ENOENT`)
 * holds nothing to preserve.
 */
export function stageHoldsBackup(stageDir: string): boolean {
  let entries: string[];
  try {
    entries = fs.readdirSync(stageDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return true; // unreadable — fail safe: preserve rather than risk deleting the only backup
  }
  return entries.some((name) => name.startsWith('old-'));
}

/**
 * Remove any provisioning stage/backup dirs for `assignmentId` under
 * `<baseDir>/.provision`. Called both as the crash-recovery preflight of
 * `provisionWorktreeDeps` (with `worktreePath`, so a crash-orphaned `old-*` backup
 * can be RESTORED) and on `removeWorktree` (final cleanup, `worktreePath` omitted).
 * The primary checkout's `node_modules` is never touched — only this manager's own
 * stages.
 */
export function gcProvisionStages(
  baseDir: string,
  assignmentId: string,
  worktreePath?: string,
  warn?: ProvisionWarnSink,
): void {
  gcAbandonedStages(
    // #5: the per-assignment namespace dir — an EXACT match, never a prefix scan.
    path.join(baseDir, PROVISION_STAGE_SUBDIR, sanitizeSlug(assignmentId)),
    worktreePath,
    warn ?? (() => undefined),
  );
}

function gcAbandonedStages(
  assignmentStageRoot: string,
  worktreePath: string | undefined,
  warn: ProvisionWarnSink,
): void {
  // #5: `assignmentStageRoot` is THIS assignment's own namespace dir — every child is
  // one of its stage dirs, so no slug prefix filter is needed (which is what caused
  // `asg-x` to also match `asg-x-y-*`). A distinct assignment has a distinct dir.
  let entries: string[];
  try {
    entries = fs.readdirSync(assignmentStageRoot);
  } catch (error) {
    // round-4 #4: ONLY a genuine ENOENT means "no stage namespace yet". Any OTHER
    // read error on the namespace ROOT is ambiguous — it may hide the sole `old-*`
    // backup we could not enumerate. On the provisioning preflight (`worktreePath`
    // defined) FAIL CLOSED (preserve + throw) rather than continue as if empty. On the
    // removeWorktree cleanup path (`worktreePath` undefined) the assignment is being
    // torn down — there is no future provision to protect — so best-effort return.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (worktreePath === undefined) return;
    throw failClosed(
      `crash-recovery could not enumerate the provisioning stage namespace ${assignmentStageRoot}: ` +
        `${messageOf(error)}. It may hold the only node_modules backup; preserving it and failing closed.`,
      'unreadable stage namespace',
    );
  }

  // B4 crash recovery: if the worktree's node_modules is MISSING and a stage holds
  // an `old-*` backup (a crash AFTER move-aside, BEFORE move-in left the old tree
  // there as the only surviving copy), RESTORE it into the worktree before deleting
  // anything. Never blindly deletes the only rollback copy.
  if (worktreePath !== undefined) {
    const nm = path.join(worktreePath, 'node_modules');
    if (lstatSafe(nm) === undefined) {
      for (const name of entries) {
        const stageDir = path.join(assignmentStageRoot, name);
        let inner: string[];
        try {
          inner = fs.readdirSync(stageDir);
        } catch (error) {
          // #5: the worktree tree is MISSING, so this stage's `old-*` could be the
          // ONLY surviving copy. An UNREADABLE stage must NOT be skipped-then-swept
          // (a transient read error would become permanent loss). PRESERVE it and
          // FAIL CLOSED so it stays recoverable on a later call.
          throw failClosed(
            `crash-recovery could not read provisioning stage ${stageDir} while the worktree ` +
              `node_modules is missing: ${messageOf(error)}. Preserving it (it may hold the only backup) ` +
              'and failing closed.',
            `unreadable stage ${name}`,
          );
        }
        const backup = inner.find((child) => child.startsWith('old-'));
        if (backup !== undefined) {
          try {
            fs.renameSync(path.join(stageDir, backup), nm);
            warn({ kind: 'stage_backup_restored', stage: name });
            break; // restored into the worktree; the deletion sweep below is now safe
          } catch (error) {
            // round-2 #4: the restore FAILED. Do NOT fall through to the deletion
            // sweep — that would delete this stage and destroy the ONLY surviving
            // copy of the prior valid tree (a transient rename failure would become
            // permanent data loss). PRESERVE the stage (leave `old-*` intact) and
            // FAIL CLOSED so the backup stays recoverable on a later call.
            throw failClosed(
              `crash-recovery could not restore the only node_modules backup for ${worktreePath} from ` +
                `stage ${name}: ${messageOf(error)}. Preserving the backup and failing closed so it stays recoverable.`,
              `restore failed from stage ${name}`,
            );
          }
        }
      }
    }
  }

  for (const name of entries) {
    try {
      fs.rmSync(path.join(assignmentStageRoot, name), { recursive: true, force: true });
      warn({ kind: 'stage_gc_removed', stage: name });
    } catch {
      /* best effort */
    }
  }
  // Best-effort: drop the now-empty per-assignment namespace dir. `rmdirSync` removes
  // it ONLY when empty, so a preserved `old-*` backup (fail-closed above threw before
  // here) or a stage the sweep could not remove keeps it — never a recursive force.
  try {
    fs.rmdirSync(assignmentStageRoot);
  } catch {
    /* non-empty or already gone — leave it */
  }
}

function purgeTransientCaches(treePath: string, warn: ProvisionWarnSink): void {
  for (const cache of TRANSIENT_CACHE_DIRS) {
    const full = path.join(treePath, cache);
    if (fs.existsSync(full)) {
      fs.rmSync(full, { recursive: true, force: true });
      warn({ kind: 'cache_purged', cache });
    }
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function proven(
  strategy: ProvisionStrategyTaken,
  fingerprint: string,
  repoRoot: string,
  worktreePath: string,
  detail: string,
): ProvisionOutcome {
  return { provisioned: true, strategy, fingerprint, repoRoot, worktreePath, detail };
}

function failClosed(message: string, detail: string): WorktreeError {
  return new WorktreeError('provisioning_failed', message, { detail });
}

/**
 * lstat that returns `undefined` ONLY for a GENUINE absence, and FAILS CLOSED on any
 * real filesystem error (#3). `ENOENT` (no such entry) and `ENOTDIR` (a parent path
 * component is not a directory, so the target cannot exist) are definitive
 * non-existence → `undefined`. ANY other error (EIO, EACCES, ELOOP, …) is a real FS
 * failure that MUST throw `provisioning_failed` — never be silently misclassified as
 * absence, which would let a stale toolchain green a no-dependency round or skip the
 * tracked/ignored/symlink safety preflight. The PRIMARY clone-source call is wrapped
 * (`isPrimaryCloneable`) so this strictness applies to the WORKTREE tree without
 * turning a non-authoritative clone-source hiccup into a hard run failure.
 */
export function lstatSafe(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw failClosed(`could not lstat ${target}: ${messageOf(error)}`, `lstat ${target} failed (${code ?? 'unknown'})`);
  }
}

/** True iff `<nmPath>/.bin` exists as a real directory — the local-toolchain proof
 * (B2): a tree without it would let verification resolve a GLOBAL binary and green
 * a run whose local provisioning is broken. Required in clone-eligibility, the
 * short-circuit, and before writing the marker. */
function hasBinDir(nmPath: string): boolean {
  return lstatSafe(path.join(nmPath, '.bin'))?.isDirectory() === true;
}

/**
 * True iff the primary's `node_modules` is a real (non-symlink) directory with a
 * populated `.bin/` — a cloneable source. NEVER throws: the primary is only the
 * clone SOURCE (not authoritative), so a genuine absence OR a real FS error (#3's
 * strict `lstatSafe`/`hasBinDir`) both mean "not cloneable → install", not a
 * fail-closed run halt. Isolates #3's strictness to the worktree tree.
 */
function isPrimaryCloneable(primaryNodeModules: string): boolean {
  try {
    const stat = lstatSafe(primaryNodeModules);
    return stat?.isDirectory() === true && stat.isSymbolicLink() === false && hasBinDir(primaryNodeModules);
  } catch {
    return false;
  }
}

function readMarker(nodeModulesDir: string): string | undefined {
  try {
    return fs.readFileSync(path.join(nodeModulesDir, PROVISION_MARKER_FILE), 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Filesystem+git-ref-safe slug (mirrors paths.ts) for naming stage dirs. */
function sanitizeSlug(raw: string): string {
  const slug = raw.replace(/[^a-zA-Z0-9._-]/g, '-');
  return slug.length > 0 ? slug : 'assignment';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
