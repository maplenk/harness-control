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
import { createPsClient } from '../supervisor/ps.js';
import { SystemClock } from '../lib/clock.js';
import { sha256Hex } from '../artifacts/hash.js';
import { WorktreeError, type ProvisioningCause } from './errors.js';

const execFileAsync = promisify(execFile);

/**
 * F9 (P5) — the deadline every provisioning-path external command and injected
 * seam call runs under (10 min, matching the verification runner's per-command
 * cap). An unbounded `npm ci`/`cp`/git probe holds the repo git mutex AND the
 * cross-process advisory lease forever, wedging the whole run and every peer
 * process. On expiry provisioning fails closed with `provisioning_timeout` and
 * the throw unwinds the manager's critical section, releasing both.
 */
export const PROVISION_COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * F9 — per-package cap for the runtime native smoke. Much tighter than the
 * command deadline: a `node -e "require(pkg)"` that has not returned in a minute
 * is not "slow", it is hung.
 */
export const NATIVE_SMOKE_TIMEOUT_MS = 60 * 1000;

/**
 * F9 — the minimal environment the native smoke's `node` runs under. Mirrors the
 * verification runner's W3-1 posture (§17.1): the orchestrator's environment,
 * including every provider credential, is NEVER inherited wholesale by a
 * provisioning-time subprocess. Kept as a local list rather than importing the
 * transport's `CHILD_ENV_ALLOWLIST` because `src/worktree` must not depend on
 * `src/adapters`; the two are deliberately identical in spirit.
 */
const SMOKE_ENV_ALLOWLIST: readonly string[] = ['PATH', 'HOME', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'LC_ALL'];

/**
 * HIGH-4 — how many `node_modules` levels the native-build scan will descend.
 * npm hoists, so real trees are 1-2 levels deep and conflicts add a few more; 16
 * is far beyond anything an install produces. Exceeding it is FATAL, never a
 * silent truncation: a tree the scan did not finish examining cannot be attested.
 */
const MAX_NATIVE_SCAN_DEPTH = 16;

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
  /** F9 (iv): the field carries the PRIMARY checkout root (the clone SOURCE),
   * which the pre-F9 name `worktreePath` misdescribed. Now emitted only as a
   * note alongside the fail-closed refusal, never as a fall-through to install. */
  | { readonly kind: 'clone_source_fingerprint_mismatch'; readonly primaryRepoRoot: string }
  | { readonly kind: 'clone_unsupported'; readonly reason: string }
  | { readonly kind: 'clone_failed'; readonly detail: string }
  /** F9: no `fallback` field — an unsafe clone is now a refusal, not a lane switch. */
  | {
      readonly kind: 'clone_symlinks_unsafe';
      readonly count: number;
      readonly sample: readonly string[];
    }
  | { readonly kind: 'cache_purged'; readonly cache: string }
  | { readonly kind: 'stage_gc_removed'; readonly stage: string }
  | { readonly kind: 'stage_backup_restored'; readonly stage: string }
  /** HIGH-6: a stage abandoned on a DEADLINE was renamed aside rather than
   * deleted, because the producer may still be writing into it. */
  | { readonly kind: 'stage_quarantined'; readonly stage: string }
  /** ROUND 5 (#4): the stage could NOT be marked, so it is not protected — said
   * plainly rather than reported as a quarantine that did not happen. */
  | { readonly kind: 'stage_quarantine_failed'; readonly stage: string; readonly detail: string }
  /** F9: the runtime native smoke loaded these packages from the staged tree. */
  | { readonly kind: 'native_smoke_passed'; readonly packages: readonly string[] };

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
  /**
   * Offline install in `cwd` (seeded with the committed manifests), producing
   * `cwd/node_modules`.
   *
   * F9: THIS SEAM HAS NO PRODUCTION CALLER. The install lane is gone — `npm ci
   * --ignore-scripts` cannot build a script-installed native dependency, so a
   * tree it produces can never be PROVEN (P1), and stamping it "proven" made the
   * breakage sticky (P2). `provision:'install'` is refused at config parse and at
   * this module's entry; `'auto'`/`'clone'` are clone-or-fail-closed. The member
   * is retained for the transition (the manager's runtime option, the F7 test
   * fakes) and still bounded by the provisioning deadline wherever it is called.
   */
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
  /** F9 (P5): deadline for every external command / injected seam call on the
   * provisioning path. Defaults to `PROVISION_COMMAND_TIMEOUT_MS`; shrunk in tests. */
  readonly commandTimeoutMs?: number;
  /** ROUND 5 (#6): §14 owner-liveness probe for quarantine GC; injectable in tests. */
  readonly ownerProbe?: QuarantineOwnerProbe;
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
      // (cp then creates it as a clone of srcDir). F9 (P5): `timeout` makes
      // execFile KILL a wedged `cp` rather than merely stop waiting on it.
      await execFileAsync('cp', ['-c', '-R', srcDir, dstDir], { timeout: PROVISION_COMMAND_TIMEOUT_MS });
    },
    async install(cwd) {
      // `--ignore-scripts` is the MVP install-script mitigation (spec §2.2/§5): a
      // manifest the implementor edited cannot run arbitrary lifecycle scripts on
      // the host during provisioning. F9: this lane has no production caller (see
      // `ProvisionRuntime.install`); the env is pinned to the smoke allowlist
      // anyway (codex focus (ii)) so it can never leak orchestrator credentials to
      // an npm lifecycle if it is ever called again, and it is bounded like `cp`.
      const env: Record<string, string> = { npm_config_ignore_scripts: 'true' };
      for (const key of SMOKE_ENV_ALLOWLIST) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      await execFileAsync(
        'npm',
        ['ci', '--prefer-offline', '--no-audit', '--fund=false', '--ignore-scripts'],
        { cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: PROVISION_COMMAND_TIMEOUT_MS },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// F9 (P5) — bounded seam calls
// ---------------------------------------------------------------------------
/**
 * Race an injected seam call (a runtime op, a git probe) against a deadline and
 * FAIL CLOSED on expiry. The default runtime's own `execFile` calls carry a
 * `timeout` too — that KILLS the child; this bounds the PROMISE, so a hung
 * injected seam (or one whose kill did not take) can never hold the caller's
 * mutex + advisory lease open indefinitely. Both are needed: neither subsumes
 * the other.
 */
async function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              failClosed(
                `provisioning step '${label}' timed out after ${timeoutMs}ms; refusing (the git mutex and advisory lease are released).`,
                `timeout: ${label} (${timeoutMs}ms)`,
                'provisioning_timeout',
              ),
            ),
          timeoutMs,
        );
        // Never keep the process alive for a deadline that no longer matters.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** The `ProvisionGit` seam with every call bounded (F9 P5). */
function boundedGit(git: ProvisionGit, timeoutMs: number): ProvisionGit {
  return {
    isPathIgnored: (worktreePath, pathspec) =>
      withDeadline(() => git.isPathIgnored(worktreePath, pathspec), timeoutMs, `git check-ignore ${pathspec}`),
    isPathTracked: (worktreePath, pathspec) =>
      withDeadline(() => git.isPathTracked(worktreePath, pathspec), timeoutMs, `git ls-files ${pathspec}`),
    readFileAtHead: (worktreePath, relpath) =>
      withDeadline(() => git.readFileAtHead(worktreePath, relpath), timeoutMs, `git show HEAD:${relpath}`),
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
  const { worktreePath, primaryRepoRoot: repoRoot, baseDir, strategy, runtime } = params;
  const warn: ProvisionWarnSink = params.warn ?? (() => undefined);
  const timeoutMs = params.commandTimeoutMs ?? PROVISION_COMMAND_TIMEOUT_MS;
  // ROUND 5 (#6): the §14 owner-liveness probe quarantine GC consults.
  const ownerProbe = params.ownerProbe ?? defaultOwnerProbe();
  // F9 (P5): every git probe below runs under the deadline.
  const git = boundedGit(params.git, timeoutMs);
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
  gcAbandonedStages(assignmentStageRoot, worktreePath, warn, ownerProbe);

  // Explicit opt-out: `none` disables managed provisioning (the operator owns
  // node_modules). Proven-skip so the fail-closed gate never halts a deliberately
  // unmanaged run.
  if (strategy === 'none') {
    return proven('none', '', repoRoot, worktreePath, "provisioning disabled (worktree.provision='none')");
  }

  // F9 (P4/§4): the install lane is GONE. `npm ci --ignore-scripts` cannot build a
  // script-installed native dependency, so a tree it produces can never be proven
  // — and stamping it proven made the breakage STICKY for the rest of the run. The
  // config schema refuses `'install'` at parse; this is the programmatic belt for
  // a manager constructed directly. Accepted config must ACT or be REFUSED.
  if (strategy === 'install') {
    throw failClosed(
      `worktree.provision='install' is no longer supported (repo ${repoRoot}): script-less installs cannot prove ` +
        'native toolchains (a `--ignore-scripts` install leaves better-sqlite3 with no compiled binding while still ' +
        "populating node_modules/.bin). Land dependency changes in the primary checkout, run `npm install` there, and use " +
        "worktree.provision='clone' (or 'auto').",
      'install provisioning removed',
      'install_provisioning_removed',
    );
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
  //
  // HIGH-3: the marker must also ATTEST the runtime smoke (v2). A pre-F9 (v1)
  // marker proves only that the manifests match — a tree the old install lane
  // built carries one and would otherwise short-circuit straight past the smoke,
  // carrying the P2 stickiness across the upgrade. So a v1 marker re-proves the
  // tree IN PLACE (no rebuild) and is upgraded to v2 on success.
  const existing = lstatSafe(nodeModules);
  const marker = existing?.isDirectory() === true && hasBinDir(nodeModules) ? readMarker(nodeModules) : undefined;
  if (marker !== undefined && marker.fingerprint === fingerprint) {
    if (marker.smokeAttested && marker.versionsAttested) {
      return proven('short_circuit', fingerprint, repoRoot, worktreePath, 'existing node_modules matches the committed dependency fingerprint');
    }
    // ROUND 9 (Blocker 2): a v1/v2 marker is NOT a proof under the current rules,
    // so run the FULL proof against the tree in place (no rebuild) before reusing
    // it. Both halves throw rather than degrade: version defects refuse
    // `primary_tree_stale`, an unloadable toolchain refuses
    // `native_toolchain_unproven`.
    assertRootVersionsProven(nodeModules, wtManifests, worktreePath, 'the worktree');
    await runNativeSmoke(nodeModules, warn, timeoutMs);
    fs.writeFileSync(path.join(nodeModules, PROVISION_MARKER_FILE), markerV3(fingerprint), 'utf8');
    return proven(
      'short_circuit',
      fingerprint,
      repoRoot,
      worktreePath,
      `existing node_modules matches the committed dependency fingerprint; its ${marker.smokeAttested ? 'pre-version-proof (v2)' : 'pre-F9 (v1)'} marker was re-proven in place and upgraded`,
    );
  }

  // Build a staged tree OUT OF the worktree, scan it, purge caches, mark it, then
  // swap it into place. The stage is under `<baseDir>/.provision`, on the same
  // filesystem as the worktree, so the swap is a rename.
  fs.mkdirSync(assignmentStageRoot, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(assignmentStageRoot, 'stage-'));
  // HIGH-6: set when a deadline fired, so the `finally` QUARANTINES the stage
  // instead of deleting it out from under a producer that may still be writing.
  let timedOut = false;
  try {
    const built = await buildStagedTree({
      stageDir,
      strategy,
      runtime,
      primaryRepoRoot: repoRoot,
      worktreeFingerprint: fingerprint,
      wtManifests,
      warn,
      git,
      timeoutMs,
    });

    // Symlink containment scan against the EVENTUAL worktree boundary (H7). A scan
    // that cannot fully complete THROWS (B6) → fail closed. F9 (§4): an unsafe link
    // is now a REFUSAL under EVERY strategy — the retry-as-install that `auto` used
    // to perform is gone with the install lane, so `auto` and `clone` behave
    // identically here (clone-or-fail-closed) and the config no longer lies about it.
    const scan: SymlinkContainmentScan = {
      stageTreeRoot: built.treePath,
      eventualTreeRoot: nodeModules,
      containmentRoot: worktreePath,
    };
    const bad = await scanSymlinkContainment(scan);
    if (bad.length > 0) {
      warn({ kind: 'clone_symlinks_unsafe', count: bad.length, sample: bad.slice(0, 5) });
      throw failClosed(
        `provisioned node_modules for ${worktreePath} (repo ${repoRoot}) contains ${bad.length} unsafe symlink(s) ` +
          `(absolute or worktree-escaping): ${bad.slice(0, 5).join(', ')}. Refusing — a write through such a link ` +
          'escapes the worktree. Repair the primary checkout\'s node_modules (reinstall it) and re-run.',
        `fingerprint=${fingerprint}; strategy=${built.strategyTaken}`,
        'unsafe_clone_symlinks',
      );
    }

    purgeTransientCaches(built.treePath, warn);
    // B2: never accept/mark a tree without a real `.bin/`. NOTE (F9 P1): this is a
    // NECESSARY condition, never a sufficient one — `.bin` is populated at unpack
    // time from `bin` fields and says nothing about lifecycle scripts having run.
    // The real toolchain proof is the runtime smoke below.
    if (!hasBinDir(built.treePath)) {
      throw failClosed(
        `provisioned node_modules for ${worktreePath} has no node_modules/.bin directory (strategy=${built.strategyTaken}) — ` +
          'refusing a tree whose local toolchain is missing (verification would resolve a global binary).',
        `fingerprint=${fingerprint}; strategy=${built.strategyTaken}; missing .bin`,
      );
    }
    // F9 (P1/P2): PROVE the toolchain by LOADING it, BEFORE the marker exists — so
    // a tree that cannot be proven can never become the sticky short-circuit for
    // every later round of the run.
    await runNativeSmoke(built.treePath, warn, timeoutMs);
    // Marker LAST (after the tree is fully built AND proven), in the v2 format
    // that attests the smoke as well as the fingerprint (HIGH-3).
    fs.writeFileSync(path.join(built.treePath, PROVISION_MARKER_FILE), markerV3(fingerprint), 'utf8');

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
  } catch (error) {
    // HIGH-6: remember that this failure was a DEADLINE, so the `finally` below
    // quarantines rather than deletes (the producer may still be writing here).
    if (error instanceof WorktreeError && error.provisioningCause === 'provisioning_timeout') timedOut = true;
    throw error;
  } finally {
    // Best-effort GC of the stage — but PRESERVE it whenever it still holds an `old-*`
    // backup (#2: a swap whose move-in AND rollback both failed left the sole surviving
    // copy of the prior valid tree there). Deleting it would destroy that only backup;
    // leave it for the next call's crash-recovery preflight to RESTORE. On the success
    // path (and the confirmed-rollback path) no `old-*` remains, so the stage is GC'd.
    //
    // HIGH-6: a stage abandoned because a command TIMED OUT is never deleted.
    // `withDeadline` stops WAITING; it cannot stop the producer, so a wedged
    // `cp`/`npm`/git may still be writing into this directory. Deleting it under
    // a live writer races that writer (and could resurrect a half-tree after the
    // locks release). Rename it aside to `quarantine-*` instead — an atomic,
    // same-filesystem move that takes the path out of the assignment's active
    // namespace — and leave it for a later GC sweep once the writer is gone.
    if (timedOut) {
      quarantineStage(stageDir, warn, ownerProbe);
    } else if (!stageHoldsBackup(stageDir)) {
      try {
        fs.rmSync(stageDir, { recursive: true, force: true });
      } catch {
        // ROUND 5: a CLEANUP failure must never MASK the outcome. `rmSync` on a
        // tree containing an unreadable directory throws, and thrown from this
        // `finally` it REPLACED the real fail-closed refusal with a bare EACCES —
        // turning a precise, cause-coded refusal into an untyped error. A stage
        // we could not delete is a leftover temp directory, which the next call's
        // GC preflight sweeps; the refusal is what the caller must see.
      }
    }
  }
}

/**
 * HIGH-6 (round 4) — MARK an abandoned stage in place; move and delete NOTHING.
 *
 * The round-3 shape renamed the stage aside, which does not work: a producer
 * that timed out is still writing to the ORIGINAL absolute pathname, so renaming
 * the parent simply lets it recreate `stage-*` underneath — and the tree it is
 * filling ends up split across two directories, with the renamed copy then swept
 * by an indiscriminate GC. Since the writer cannot be redirected, the only sound
 * move is to leave the tree exactly where the writer expects it and record that
 * this stage is off-limits.
 *
 * The marker carries the writing process's pid and the time, so GC can
 * distinguish "a producer may still own this" from "old enough that nothing
 * can" (`QUARANTINE_TTL_MS`). Stage directory names are unique per attempt
 * (`mkdtemp`), so a recreated `stage-*` is always THIS attempt's own directory
 * and can never collide with a future provisioning run's.
 */
export const QUARANTINE_MARKER_FILE = '.harness-quarantined';
/** How long a quarantined stage is presumed to have a live writer, when the
 * owner's liveness cannot be positively disproven. */
export const QUARANTINE_TTL_MS = 24 * 60 * 60 * 1000;

/** The recorded §14 identity of the process that abandoned a stage. */
export interface QuarantineOwner {
  readonly pid: number;
  /** Opaque `ps lstart` token — compared for exact equality only. */
  readonly startedAt?: string;
}

/**
 * ROUND 5 (#6) — the §14 liveness/identity probe quarantine GC consults. A
 * post-TTL delete must PROVE the owner is gone, because a producer with no
 * bound (a hung `npm`, an NFS stall) can outlive any timeout: deleting its
 * stage on a timestamp alone recreates the original race a day later.
 * Injectable so tests can script a live/dead owner without racing real pids.
 */
export interface QuarantineOwnerProbe {
  /** This process's own identity, to stamp into a marker it writes. */
  self(): QuarantineOwner;
  /** Is `owner` still the EXACT live process it claims to be? `false` for a gone
   * pid OR a recycled one (start-time mismatch) — either way the stage is free. */
  isOwnerAlive(owner: QuarantineOwner): boolean;
}

let cachedOwnerProbe: QuarantineOwnerProbe | undefined;
function defaultOwnerProbe(): QuarantineOwnerProbe {
  if (cachedOwnerProbe !== undefined) return cachedOwnerProbe;
  // Only sampleIdentity/isAlive are used here; the clock stamps tree samples we
  // never take.
  const ps = createPsClient(new SystemClock());
  cachedOwnerProbe = {
    self() {
      const startedAt = ps.sampleIdentity(process.pid)?.startedAt;
      return { pid: process.pid, ...(startedAt !== undefined ? { startedAt } : {}) };
    },
    isOwnerAlive(owner) {
      if (!ps.isAlive(owner.pid)) return false;
      if (owner.startedAt === undefined) return true; // bare liveness, best effort
      return ps.sampleIdentity(owner.pid)?.startedAt === owner.startedAt;
    },
  };
  return cachedOwnerProbe;
}

/**
 * ROUND 5 (#4) — mark a stage quarantined, and report HONESTLY whether it
 * worked. The round-4 shape wrote the marker best-effort yet emitted
 * `stage_quarantined` unconditionally, so a failed write left an UNMARKED live
 * stage that GC would then treat as ordinary and delete — the exact race
 * quarantining exists to prevent, now invisible because we had claimed success.
 */
function quarantineStage(stageDir: string, warn: ProvisionWarnSink, probe: QuarantineOwnerProbe): void {
  // ROUND 6 (Finding 3): this runs from the timeout `finally`, so ANYTHING it
  // throws would REPLACE the in-flight cause-coded refusal with an unrelated
  // error. `probe.self()` shells out to `ps` and can fail. A missing owner
  // identity only weakens the marker (GC falls back to the TTL clock); losing
  // the refusal would be far worse.
  let owner: QuarantineOwner;
  try {
    owner = probe.self();
  } catch {
    owner = { pid: process.pid };
  }
  try {
    fs.mkdirSync(stageDir, { recursive: true }); // the producer may have removed it
    fs.writeFileSync(
      path.join(stageDir, QUARANTINE_MARKER_FILE),
      JSON.stringify({
        quarantinedAtMs: Date.now(),
        ownerPid: owner.pid,
        ...(owner.startedAt !== undefined ? { ownerStartedAt: owner.startedAt } : {}),
      }),
      'utf8',
    );
  } catch (error) {
    warn({ kind: 'stage_quarantine_failed', stage: path.basename(stageDir), detail: messageOf(error) });
    return;
  }
  warn({ kind: 'stage_quarantined', stage: path.basename(stageDir) });
}

/**
 * True when a stage must be left alone by GC.
 *
 * ROUND 5 (#5/#6) — two corrections. A marker that EXISTS but cannot be READ is
 * LIVE, not "ordinary": round 4 classified every read failure as no-marker, so
 * the very next sweep deleted it — the exact opposite of the documented rule.
 * Only a genuine absence (ENOENT/ENOTDIR) means "an ordinary stage".
 *
 * And a post-TTL stage is released only once its OWNER is proven gone. The TTL
 * alone is not a liveness proof: an unbounded producer still holds the path a
 * day later. A live owner EXTENDS the quarantine rather than expiring it.
 * MED-6: retention stays BOUNDED because the moment the owner dies (or its pid
 * is recycled) the next sweep collects the stage, and a marker with no usable
 * timestamp falls back to the directory's own mtime rather than being protected
 * forever.
 */
function isQuarantineProtected(stageDir: string, nowMs: number, probe: QuarantineOwnerProbe): boolean {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(stageDir, QUARANTINE_MARKER_FILE), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false; // no marker — ordinary stage
    return true; // present but unreadable — liveness unknown, so do not touch
  }

  let owner: QuarantineOwner | undefined;
  let quarantinedAtMs: number | undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as { quarantinedAtMs?: unknown; ownerPid?: unknown; ownerStartedAt?: unknown };
      if (typeof record.quarantinedAtMs === 'number' && Number.isFinite(record.quarantinedAtMs)) {
        quarantinedAtMs = record.quarantinedAtMs;
      }
      if (typeof record.ownerPid === 'number' && Number.isInteger(record.ownerPid)) {
        owner = {
          pid: record.ownerPid,
          ...(typeof record.ownerStartedAt === 'string' ? { startedAt: record.ownerStartedAt } : {}),
        };
      }
    }
  } catch {
    /* malformed — fall through to the mtime clock below (bounded, not forever) */
  }

  // A still-live owner extends the quarantine for as long as it lives.
  if (owner !== undefined) {
    try {
      if (probe.isOwnerAlive(owner)) return true;
    } catch {
      return true; // a probe we cannot run is not a proof of death
    }
  }

  // Owner gone (or never recorded): hold only until the TTL elapses. A marker
  // with no usable timestamp uses the stage's own mtime, so a malformed marker
  // is bounded rather than protected forever (MED-6).
  const since = quarantinedAtMs ?? mtimeMsOf(stageDir) ?? nowMs;
  return nowMs - since < QUARANTINE_TTL_MS;
}

function mtimeMsOf(target: string): number | undefined {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return undefined;
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
  /** Already deadline-bounded (`boundedGit`). Used to classify a manifest divergence. */
  readonly git: ProvisionGit;
  readonly timeoutMs: number;
}

/**
 * Produce a staged `node_modules` by CLONING a primary tree that has been proven
 * to match the committed manifests — or FAIL CLOSED.
 *
 * F9: there is no second lane. Everything that used to "fall back to install"
 * (fingerprint mismatch, an unreadable primary manifest, a non-APFS host, a
 * hollow primary tree, a runtime clone failure) is now a cause-coded refusal,
 * because the install lane could not produce a PROVABLE tree and silently
 * stamping its output "proven" is how a broken toolchain became sticky for a
 * whole run. `auto` and `clone` are both clone-or-fail-closed; they differ only
 * in that neither retries anything any more.
 */
async function buildStagedTree(args: BuildArgs): Promise<{ treePath: string; strategyTaken: 'clone' }> {
  const { runtime, primaryRepoRoot, worktreeFingerprint, warn } = args;
  const primaryNodeModules = path.join(primaryRepoRoot, 'node_modules');

  if (!runtime.cloneSupported) {
    warn({ kind: 'clone_unsupported', reason: 'APFS copy-on-write (cp -c) is not available on this platform' });
    throw failClosed(
      `worktree dependency provisioning requires a copy-on-write clone of ${primaryNodeModules}, which this host ` +
        'does not support (no APFS `cp -c`). The install lane was removed because a script-less install cannot ' +
        "prove native toolchains; set worktree.provision='none' and provision node_modules yourself on this host.",
      'clone unsupported on this platform',
      'clone_unsupported',
    );
  }
  // A real directory (never a symlinked root) with a real `.bin/`. B2: a hollow or
  // toolchain-less primary is never cloned — that is how the exit-127 false
  // negative got in. There is nothing to fall back to now, so it refuses.
  if (!isPrimaryCloneable(primaryNodeModules)) {
    throw failClosed(
      `the primary checkout's node_modules at ${primaryNodeModules} is missing, hollow, a symlink, or has no .bin/ — ` +
        'there is no proven tree to clone. Run `npm install` in the primary checkout and re-run.',
      'primary node_modules is not a cloneable tree',
      'primary_tree_stale',
    );
  }

  // Clone ONLY when the primary's INSTALLED (working-tree) manifests fingerprint
  // matches the worktree's COMMITTED one. A failure reading the primary's own
  // manifests used to be non-fatal ("the primary is only the SOURCE") and fell
  // through to install; with no install lane, an unreadable clone source is a
  // refusal — never a guess.
  let primaryManifests: ManifestSet;
  try {
    primaryManifests = await collectManifests(diskSource(primaryRepoRoot), runtime.platformKey);
  } catch (error) {
    warn({ kind: 'clone_failed', detail: `primary manifest read failed: ${messageOf(error)}` });
    throw failClosed(
      `could not read the primary checkout's dependency manifests at ${primaryRepoRoot}: ${messageOf(error)}. ` +
        'Refusing to clone a source whose dependency set cannot be established.',
      messageOf(error),
      'manifest_divergence_unclassified',
    );
  }
  if (computeDependencyFingerprint(primaryManifests, runtime.platformKey) !== worktreeFingerprint) {
    warn({ kind: 'clone_source_fingerprint_mismatch', primaryRepoRoot });
    throw await manifestDivergenceFailure(args, primaryManifests);
  }

  // F9 (P3) — fingerprints agreeing proves only that the two MANIFESTS match. Prove
  // the primary TREE actually contains what they declare before cloning it.
  const declared = declaredRootPackages(args.wtManifests);
  // ROUND 7 (Finding 2): at VERSION granularity — a name check alone let a
  // dependency bumped without reinstalling pass on its OLD directory.
  assertRootVersionsProven(primaryNodeModules, args.wtManifests, primaryRepoRoot, 'the primary checkout');

  const dst = path.join(args.stageDir, 'node_modules');
  try {
    await withDeadline(() => runtime.cloneDir(primaryNodeModules, dst), args.timeoutMs, 'clone node_modules');
  } catch (error) {
    // HIGH-6 (round 4): on a DEADLINE, delete NOTHING. `withDeadline` stops
    // waiting; it does not stop the producer, which is still writing to this
    // exact pathname — removing the tree here just lets it recreate the
    // directory behind us, and no later rename can redirect a writer that holds
    // the original path. The stage is quarantined IN PLACE by the caller
    // instead. A non-deadline clone failure is a settled producer, so cleaning
    // up its partial output is safe.
    if (error instanceof WorktreeError && error.provisioningCause === 'provisioning_timeout') throw error;
    // ROUND 6 (Finding 3): guarded for the same reason as the stage `finally` —
    // `rmSync` over a partial tree containing an unreadable entry throws, and
    // thrown from this catch it would REPLACE the clone's own cause-coded
    // refusal with a bare FS error. A stage we could not clean is a leftover
    // temp directory the next GC preflight sweeps; the refusal is what matters.
    try {
      fs.rmSync(dst, { recursive: true, force: true });
    } catch {
      /* cleanup must never mask the primary failure */
    }
    if (error instanceof WorktreeError && error.kind === 'provisioning_failed') throw error;
    warn({ kind: 'clone_failed', detail: messageOf(error) });
    throw failClosed(
      `copy-on-write clone of ${primaryNodeModules} into the provisioning stage failed: ${messageOf(error)}. ` +
        'Refusing — there is no install fallback (a script-less install cannot prove native toolchains).',
      messageOf(error),
      'clone_failed',
    );
  }
  return { treePath: dst, strategyTaken: 'clone' };
}

/**
 * F9 (§1) — turn a fingerprint mismatch into a message that names WHICH manifest
 * diverged and WHOSE fault it is, because the two cases have opposite remedies
 * and the old generic hint ("ensure the primary's node_modules is installed")
 * sent the commonest one (a dep-adding implementor commit) in circles.
 *
 * Classification needs a third reference, since the two sets in hand — the
 * worktree at HEAD and the primary ON DISK — cannot by themselves say which side
 * moved. The primary's own HEAD is that reference:
 *   - worktree-HEAD manifests differ from primary-HEAD manifests
 *       → the implementor's COMMIT changed dependencies (`deps_changed_in_worktree`);
 *   - they agree, so the divergence is primary on-disk vs primary HEAD
 *       → uncommitted/unsynced edits in the primary (`primary_manifests_diverged`).
 * If the primary's HEAD cannot be read, neither remedy can be asserted, so the
 * refusal says so and names both (`manifest_divergence_unclassified`) rather than
 * guessing — fail closed, honestly.
 */
async function manifestDivergenceFailure(
  args: BuildArgs,
  primaryManifests: ManifestSet,
): Promise<WorktreeError> {
  const { wtManifests, primaryRepoRoot, runtime } = args;
  const diverged = divergedManifestNames(wtManifests, primaryManifests);
  const named =
    diverged.length > 0
      ? `diverged manifests: ${diverged.join(', ')}`
      : `the manifests are byte-identical, so the platform key differs (${runtime.platformKey}) — the primary's tree was installed under a different Node/OS/arch`;

  let primaryHead: ManifestSet | undefined;
  try {
    primaryHead = await collectManifests(headSource(args.git, primaryRepoRoot), runtime.platformKey);
  } catch {
    primaryHead = undefined;
  }
  if (primaryHead === undefined) {
    return failClosed(
      `worktree dependency provisioning refused (repo ${primaryRepoRoot}): the committed manifests do not match the ` +
        `primary checkout's installed ones — ${named}. The primary's own HEAD could not be read, so the cause cannot ` +
        'be attributed: either the implementor committed a dependency change (land dependency changes via the engine ' +
        'track, not inside runs) or the primary has uncommitted manifest edits (commit/sync and run `npm install`).',
      named,
      'manifest_divergence_unclassified',
    );
  }
  const worktreeMoved = divergedManifestNames(wtManifests, primaryHead).length > 0;
  return worktreeMoved
    ? failClosed(
        `worktree dependency provisioning refused (repo ${primaryRepoRoot}): the implementor's commit CHANGED the ` +
          `dependency manifests — ${named}. Dependency changes are landed via the engine track, not inside runs: ` +
          'no provable tree exists for the new manifests (a script-less install cannot build native dependencies). ' +
          'Revert the manifest change in the round, or land it in the primary checkout, `npm install` there, and re-run.',
        named,
        'deps_changed_in_worktree',
      )
    : failClosed(
        `worktree dependency provisioning refused (repo ${primaryRepoRoot}): the PRIMARY checkout has uncommitted or ` +
          `unsynced dependency manifest edits — ${named}. Its committed manifests match the worktree's, so the drift ` +
          'is on disk in the primary. Commit/sync the manifests, run `npm install` in the primary checkout, and re-run.',
        named,
        'primary_manifests_diverged',
      );
}

/** Which fingerprinted manifest files differ between two sets (present-vs-absent
 * counts as a difference — `null` is the absent sentinel). */
function divergedManifestNames(a: ManifestSet, b: ManifestSet): string[] {
  const names = new Set<string>([...a.entries.keys(), ...b.entries.keys()]);
  const diverged: string[] = [];
  for (const name of [...names].sort()) {
    if (a.entries.get(name) !== b.entries.get(name)) diverged.push(name);
  }
  return diverged;
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
  // ROUND 6 (Finding 3, same family): the swap has SUCCEEDED — the new tree is in
  // place. Freeing the moved-aside copy is pure cleanup, so letting it throw
  // would turn a completed provisioning into a spurious "could not swap into
  // place" failure. A surviving backup is harmless: the caller's `finally`
  // preserves the stage and a later GC sweep collects it.
  if (hadPrior) {
    try {
      fs.rmSync(backup, { recursive: true, force: true });
    } catch {
      /* the swap already succeeded; cleanup never fails it */
    }
  }
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
  ownerProbe?: QuarantineOwnerProbe,
): void {
  gcAbandonedStages(
    // #5: the per-assignment namespace dir — an EXACT match, never a prefix scan.
    path.join(baseDir, PROVISION_STAGE_SUBDIR, sanitizeSlug(assignmentId)),
    worktreePath,
    warn ?? (() => undefined),
    ownerProbe ?? defaultOwnerProbe(),
  );
}

function gcAbandonedStages(
  assignmentStageRoot: string,
  worktreePath: string | undefined,
  warn: ProvisionWarnSink,
  ownerProbe: QuarantineOwnerProbe,
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

  const nowMs = Date.now();
  for (const name of entries) {
    const stageDir = path.join(assignmentStageRoot, name);
    // HIGH-6: never sweep a QUARANTINED stage while a producer abandoned on a
    // deadline may still be writing into it. Deleting it would race that writer
    // — the very hazard quarantining exists to avoid — and the round-3 shape
    // made it worse by GC'ing the renamed copy indiscriminately. Past the TTL
    // no writer can plausibly remain, so it collects like anything else.
    if (isQuarantineProtected(stageDir, nowMs, ownerProbe)) continue;
    try {
      fs.rmSync(stageDir, { recursive: true, force: true });
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

/** F9: every refusal may carry a machine-readable `cause` the CLI turns into a
 * SPECIFIC remedy. Pre-F9 refusals pass none and keep the generic hint. */
function failClosed(message: string, detail: string, cause?: ProvisioningCause): WorktreeError {
  return new WorktreeError('provisioning_failed', message, {
    detail,
    ...(cause !== undefined ? { provisioningCause: cause } : {}),
  });
}

// ---------------------------------------------------------------------------
// F9 — proving the tree
// ---------------------------------------------------------------------------
/** The root-level `dependencies` + `devDependencies` NAMES a manifest declares. */
function declaredRootPackages(manifests: ManifestSet): string[] {
  const raw = manifests.entries.get('package.json');
  if (typeof raw !== 'string') return [];
  const parsed = parsePackageJson(raw, 'package.json');
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const value = parsed[field];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      for (const name of Object.keys(value as object)) names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * F9 (P3) — PROVE the primary tree before cloning it. Fingerprints only prove
 * that the primary's MANIFESTS say what the worktree's committed manifests say;
 * they say nothing about whether anyone ever ran `npm install` against them. The
 * false clone is exactly that gap: merge a dep-adding commit, start a run before
 * installing in the primary, and a stale tree missing the new dependency is
 * cloned and stamped proven — `vite: not found`, exit 127, the very failure class
 * F7 exists to kill, arriving through the clone lane instead.
 *
 * ROUND 7 (Finding 2) — the proof is at VERSION granularity, not presence.
 * Checking only that each declared NAME has a directory left the same defect one
 * level down: bump a dependency's version without reinstalling and the OLD
 * directory still satisfies a name check, so the wrong tree is cloned, stamped
 * v2, and every later round short-circuits onto it — verifying against dependency
 * versions that differ from the lockfile. Non-native packages evade the runtime
 * smoke entirely, so nothing downstream would have caught it either.
 *
 * Each root-declared dependency + devDependency must therefore have an INSTALLED
 * `node_modules/<name>/package.json` whose `version` EXACTLY equals the version
 * the lockfile resolved for it. Exact equality against the lock's own entry is
 * the simplest sound rule — the lock is what the install was supposed to
 * reproduce, so any difference means it did not.
 *
 * Transitive dependencies are still not enumerated: the root set is what the
 * fingerprint is computed over and what verification commands reach for.
 */
interface PrimaryTreeDefect {
  readonly name: string;
  readonly detail: string;
}

/**
 * ROUND 9 (Blocker 2) — the ROOT VERSION proof, applied to whichever tree is
 * about to be trusted. Extracted so the CLONE lane (proving the primary before
 * copying it) and the SHORT-CIRCUIT lane (proving a worktree tree whose marker
 * predates this proof) run the identical check rather than one of them silently
 * skipping it.
 *
 * `label`/`root` only shape the operator message; the rule is the same either
 * way. Throws `provisioning_failed` / `primary_tree_stale`; returns on success.
 */
function assertRootVersionsProven(
  treeNodeModules: string,
  manifests: ManifestSet,
  root: string,
  label: string,
): void {
  const locked = lockedRootVersions(manifests);
  if (!locked.ok) {
    throw failClosed(
      `${label}'s node_modules at ${treeNodeModules} cannot be proven against the committed dependency ` +
        `manifests (repo ${root}): ${locked.reason}. Refusing rather than trusting a tree whose dependency ` +
        'VERSIONS nothing can confirm — presence alone is not proof (a package bumped without reinstalling keeps ' +
        'its old directory). Commit an npm package-lock.json alongside package.json and run `npm install`.',
      `unusable lock data: ${locked.reason}`,
      'primary_tree_stale',
    );
  }
  const defects = proveePrimaryTree(treeNodeModules, declaredRootPackages(manifests), locked.versions);
  if (defects.length === 0) return;
  const named = defects
    .slice(0, 8)
    .map((d) => `${d.name} (${d.detail})`)
    .join('; ');
  throw failClosed(
    `${label}'s node_modules at ${treeNodeModules} is STALE: ${defects.length} manifest-declared package(s) do ` +
      `not match the lockfile — ${named}${defects.length > 8 ? '; …' : ''}. Its manifests match the committed ` +
      'ones, but it was not installed against them — trusting it would hand verification a tree whose ' +
      'dependencies differ from the lockfile (a missing package exits 127; a stale VERSION verifies the wrong ' +
      'code silently). Run `npm install` and re-run.',
    `${label} tree has ${defects.length} package(s) diverging from the lockfile`,
    'primary_tree_stale',
  );
}

function proveePrimaryTree(
  primaryNodeModules: string,
  declared: readonly string[],
  lockedVersions: ReadonlyMap<string, string>,
): PrimaryTreeDefect[] {
  const defects: PrimaryTreeDefect[] = [];
  for (const name of declared) {
    // A package name is a posix path fragment ('@scope/pkg'); join it as such.
    const dir = path.join(primaryNodeModules, ...name.split('/'));
    if (lstatSafe(dir)?.isDirectory() !== true) {
      defects.push({ name, detail: 'no directory in the primary node_modules' });
      continue;
    }
    const expected = lockedVersions.get(name);
    if (expected === undefined) {
      // ROUND 8 (Blocker 2): no resolved version for a DECLARED package means the
      // lockfile cannot prove this package at all. Skipping the comparison is the
      // same silent downgrade the empty-map fallback was.
      defects.push({ name, detail: 'the lockfile resolves no version for it (unrecognised or absent entry)' });
      continue;
    }
    let installed: string | undefined;
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
        const version = (raw as { version?: unknown }).version;
        if (typeof version === 'string') installed = version;
      }
    } catch {
      // An unreadable/malformed installed manifest is not evidence of a match.
      defects.push({ name, detail: `installed package.json is unreadable or malformed (lockfile wants ${expected})` });
      continue;
    }
    if (installed === undefined) {
      defects.push({ name, detail: `installed package.json declares no version (lockfile wants ${expected})` });
    } else if (installed !== expected) {
      defects.push({ name, detail: `installed ${installed}, lockfile resolved ${expected}` });
    }
  }
  return defects;
}

/**
 * The version the LOCKFILE resolved for each root-declared package, read from
 * the fingerprinted `package-lock.json`.
 *
 * ROUND 8 (Blocker 2) — returns a REASON instead of an empty map when the data
 * is unusable. Degrading to presence-only was the F9 defect reintroduced through
 * its own precondition: a missing, malformed, or non-npm lockfile (Yarn, pnpm)
 * silently skipped every version comparison, cloned a stale tree, stamped it v2,
 * and short-circuited onto it for the rest of the run. Absence of proof is not
 * proof; the caller REFUSES.
 *
 * Recognised: npm lockfileVersion 2/3 `packages` entries keyed
 * `node_modules/<name>` (top-level only — a nested `a/node_modules/b` is not the
 * root copy), and the v1 `dependencies` map.
 */
/** npm lockfile format versions whose ROOT entries this engine can read. */
const SUPPORTED_LOCKFILE_VERSIONS: ReadonlySet<number> = new Set([1, 2, 3]);

type LockVersions =
  | { readonly ok: true; readonly versions: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly reason: string };

function lockedRootVersions(manifests: ManifestSet): LockVersions {
  const raw = manifests.entries.get('package-lock.json');
  if (raw === null || raw === undefined) {
    return {
      ok: false,
      reason:
        'the committed manifests contain no package-lock.json, so no resolved dependency versions exist to prove ' +
        'the primary tree against (a Yarn/pnpm lockfile is not read by this engine)',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { ok: false, reason: `package-lock.json could not be parsed: ${messageOf(error)}` };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'package-lock.json is not a JSON object' };
  }
  const record = parsed as { packages?: unknown; dependencies?: unknown; lockfileVersion?: unknown };
  // ROUND 9 (Blocker 3): validate the FORMAT VERSION explicitly. Accepting a
  // lockfile because its `packages`/`dependencies` merely RESEMBLE a recognised
  // structure is inference from shape — the same error the F11 classifier made
  // about operation kind. A future format may key or nest root entries
  // differently while still looking familiar, so resemblance is not support.
  const lockfileVersion = record.lockfileVersion;
  if (typeof lockfileVersion !== 'number' || !SUPPORTED_LOCKFILE_VERSIONS.has(lockfileVersion)) {
    return {
      ok: false,
      reason:
        `package-lock.json declares lockfileVersion ${JSON.stringify(lockfileVersion)}, which this engine does ` +
        `not support (recognised: ${[...SUPPORTED_LOCKFILE_VERSIONS].join(', ')}). Its resolved dependency ` +
        'versions cannot be read, so the tree cannot be proven',
    };
  }
  const versions = new Map<string, string>();
  const packages = record.packages;
  if (packages !== null && typeof packages === 'object' && !Array.isArray(packages)) {
    for (const [key, value] of Object.entries(packages as Record<string, unknown>)) {
      if (!key.startsWith('node_modules/')) continue;
      const name = key.slice('node_modules/'.length);
      if (name.includes('node_modules/')) continue;
      if (value !== null && typeof value === 'object') {
        const version = (value as { version?: unknown }).version;
        if (typeof version === 'string') versions.set(name, version);
      }
    }
  }
  const deps = record.dependencies;
  if (versions.size === 0 && deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
    for (const [name, value] of Object.entries(deps as Record<string, unknown>)) {
      if (value !== null && typeof value === 'object') {
        const version = (value as { version?: unknown }).version;
        if (typeof version === 'string') versions.set(name, version);
      }
    }
  }
  return { ok: true, versions };
}

/**
 * F9 (P1) — the packages in an INSTALLED tree whose correctness depends on a
 * lifecycle BUILD step: they declare an install/preinstall/postinstall script AND
 * look like a native addon (a `binding.gyp`, or a script invoking node-gyp /
 * prebuild / node-pre-gyp / cmake-js). `better-sqlite3` is the canonical member.
 *
 * Deliberately narrower than "every script-bearing package": plenty of packages
 * run a postinstall that has nothing to do with loadability (`esbuild` fetches a
 * platform binary, CLI packages run setup scripts, some are not `require`-able at
 * all), and `require`ing those would fail the smoke for reasons that are not
 * breakage. The native-addon set is exactly the set whose `require()` genuinely
 * dlopens a built artifact — a real proof, with no false positives.
 *
 * Enumerates the tree's TOP LEVEL (npm hoists, so that is the installed set),
 * including one level under `@scope/`. Unreadable/malformed package manifests are
 * skipped, not fatal: they are not evidence of a missing BUILD.
 */
function nativeBuildPackages(treePath: string): string[] {
  const found: string[] = [];

  /** `dir` holds a package; `specifier` is how `require()` names it. */
  const consider = (dir: string, specifier: string): void => {
    // HIGH-4: `binding.gyp` is decisive ON ITS OWN, checked BEFORE any script
    // lookup. npm runs an IMPLICIT `node-gyp rebuild` for a package that has a
    // binding.gyp and declares no `install`/`preinstall` script — so requiring a
    // `scripts` object first (and returning early without one) skipped exactly
    // the packages whose build npm supplies for them.
    if (fs.existsSync(path.join(dir, 'binding.gyp'))) {
      found.push(specifier);
      return;
    }
    let manifestRaw: string;
    try {
      manifestRaw = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
    } catch (error) {
      // ROUND 5 (#3 audit): only a GENUINE absence is a skip — a cache dir, a
      // stray file, `.bin`. Any OTHER read error (EACCES, EIO) is a package we
      // could not examine, and an unexamined package cannot be attested.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return;
      throw failClosed(
        `the native-build scan could not read ${path.join(dir, 'package.json')}: ${messageOf(error)}. ` +
          'A package we could not examine cannot be attested; refusing rather than marking the tree proven.',
        `unreadable manifest for ${specifier}`,
        'native_toolchain_unproven',
      );
    }
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(manifestRaw);
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('not a JSON object');
      }
      parsed = value as Record<string, unknown>;
    } catch (error) {
      // A malformed manifest inside a tree we are attesting is a corrupt tree —
      // the same fail-closed posture `parsePackageJson` (B3) already takes.
      throw failClosed(
        `the native-build scan could not parse ${path.join(dir, 'package.json')}: ${messageOf(error)}. ` +
          'A package whose manifest is corrupt cannot be attested.',
        `malformed manifest for ${specifier}`,
        'native_toolchain_unproven',
      );
    }
    const scripts = parsed['scripts'];
    if (scripts === null || typeof scripts !== 'object') return;
    const hooks = ['install', 'preinstall', 'postinstall']
      .map((hook) => (scripts as Record<string, unknown>)[hook])
      .filter((value): value is string => typeof value === 'string');
    if (hooks.some((script) => /node-gyp|node-pre-gyp|prebuild|cmake-js/i.test(script))) {
      found.push(specifier);
    }
  };

  /**
   * HIGH-4: walk NESTED `node_modules` too. npm hoists most packages to the top
   * level, but a version conflict leaves a transitive dependency installed at
   * `a/node_modules/b` — and a native one there is just as unbuilt-able. The
   * specifier stays the nested PATH (`a/node_modules/b`), which is what the
   * smoke must require: bare `b` would resolve to the hoisted copy, proving the
   * wrong artifact.
   */
  const walk = (root: string, specifierPrefix: string, depth: number): void => {
    // HIGH-4 (round 4): the depth guard FAILS CLOSED. Returning silently meant a
    // native package nested deeper than the limit was never smoked, yet the tree
    // still received a v2 (smoke-attested) marker — an UNPROVEN tree stamped
    // proven, and sticky from then on. Refusing is the only honest option: a tree
    // we did not finish examining is a tree we cannot attest.
    if (depth > MAX_NATIVE_SCAN_DEPTH) {
      throw failClosed(
        `the staged node_modules nests deeper than ${MAX_NATIVE_SCAN_DEPTH} levels at ${root} — the native-build ` +
          'scan could not examine the whole tree, so no toolchain attestation can be made for it. Refusing rather ' +
          'than marking an unexamined tree proven. Flatten/reinstall the primary tree, or raise the scan depth.',
        `native scan depth limit ${MAX_NATIVE_SCAN_DEPTH} exceeded at ${root}`,
        'native_toolchain_unproven',
      );
    }
    let entries: Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch (error) {
      throw failClosed(
        `could not enumerate the staged node_modules at ${root} to derive its native-build packages: ${messageOf(error)}`,
        'staged tree unreadable',
        'native_toolchain_unproven',
      );
    }
    const visit = (dir: string, specifier: string): void => {
      consider(dir, specifier);
      const nested = path.join(dir, 'node_modules');
      if (lstatSafe(nested)?.isDirectory() === true) walk(nested, `${specifier}/node_modules/`, depth + 1);
    };
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.bin') continue;
      if (entry.name.startsWith('@')) {
        let scoped: Dirent[];
        try {
          scoped = fs.readdirSync(path.join(root, entry.name), { withFileTypes: true });
        } catch (error) {
          // ROUND 5 (#3): FAIL CLOSED, exactly as the depth cap does. Swallowing
          // this with `continue` omitted every native package under the scope
          // while the tree still received a v2 (smoke-attested) marker — an
          // unexamined subtree stamped proven. Enumeration and depth must have
          // the same posture: a scan that could not complete attests nothing.
          throw failClosed(
            `the native-build scan could not enumerate ${path.join(root, entry.name)}: ${messageOf(error)}. ` +
              'A subtree we could not examine cannot be attested; refusing rather than marking the tree proven.',
            `unreadable scope directory ${entry.name}`,
            'native_toolchain_unproven',
          );
        }
        for (const child of scoped) {
          if (child.isDirectory()) {
            visit(path.join(root, entry.name, child.name), `${specifierPrefix}${entry.name}/${child.name}`);
          }
        }
      } else {
        visit(path.join(root, entry.name), `${specifierPrefix}${entry.name}`);
      }
    }
  };

  walk(treePath, '', 0);
  return [...new Set(found)].sort();
}

/**
 * F9 (P1/P2) — the RUNTIME toolchain proof, run on the STAGED tree BEFORE the
 * marker is written, on BOTH lanes.
 *
 * `hasBinDir` never could have worked: `node_modules/.bin/` is populated from
 * package `bin` fields at UNPACK time, wholly independent of lifecycle scripts,
 * so a `--ignore-scripts` install yields a fully-populated `.bin` and zero built
 * `.node` artifacts — which is precisely how a better-sqlite3 with no binding was
 * stamped "proven" and then, because the marker matched, reused by every
 * subsequent round until the run burned to terminal.
 *
 * The replacement actually loads each native-build package with
 * `node -e "require('<pkg>')"` from the staged tree's parent (so bare-specifier
 * resolution walks into the staged `node_modules`), under a minimal env and a
 * per-package deadline. A load failure is `native_toolchain_unproven` naming the
 * package. The CLONE lane runs it too: the clone is CHEAP, not SAFE — its
 * correctness is inherited from whenever the primary was last really installed.
 */
async function runNativeSmoke(
  treePath: string,
  warn: ProvisionWarnSink,
  timeoutMs: number,
): Promise<void> {
  const packages = nativeBuildPackages(treePath);
  if (packages.length === 0) return;
  // Bare specifiers resolve from `<cwd>/node_modules`, and the staged tree IS
  // `<parent>/node_modules` on both lanes (clone: `<stage>/node_modules`;
  // install: `<stage>/install/node_modules`).
  const cwd = path.dirname(treePath);
  const env: Record<string, string> = {};
  for (const key of SMOKE_ENV_ALLOWLIST) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  for (const name of packages) {
    try {
      await execFileAsync(process.execPath, ['-e', `require(${JSON.stringify(name)})`], {
        cwd,
        env,
        timeout: Math.min(timeoutMs, NATIVE_SMOKE_TIMEOUT_MS),
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const stderr = typeof (error as { stderr?: unknown }).stderr === 'string'
        ? ((error as { stderr: string }).stderr).trim().split('\n').slice(0, 6).join(' | ')
        : messageOf(error);
      throw failClosed(
        `provisioned node_modules for ${treePath} could not LOAD '${name}', which declares a native build step — ` +
          'the package is present but was never built (a script-less install cannot build it). Refusing to verify ' +
          `against an unproven toolchain: ${stderr}`,
        `native smoke failed for ${name}`,
        'native_toolchain_unproven',
      );
    }
  }
  warn({ kind: 'native_smoke_passed', packages });
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

/**
 * HIGH-3 — the marker's PROOF FORMAT, versioned.
 *
 * v1 (pre-F9) recorded only the dependency fingerprint, so it attests
 * "these manifests" and NOTHING about the toolchain having been proven to load.
 * A tree built by the old install lane carries a v1 marker that still matches its
 * fingerprint, so it would short-circuit straight past the new runtime smoke —
 * the exact stickiness (P2) F9 exists to kill, surviving the upgrade.
 *
 * v2 = fingerprint + a native-smoke attestation. Only v2 short-circuits. A v1 (or
 * unrecognized) marker is treated as UNPROVEN: the smoke runs against the tree in
 * place, and on success the marker is rewritten as v2 (cheap — no rebuild), on
 * failure provisioning refuses `native_toolchain_unproven`.
 */
const MARKER_V2_PREFIX = 'v2:';
/**
 * ROUND 9 (Blocker 2) — v3 = fingerprint + native-smoke attestation + ROOT
 * VERSION proof.
 *
 * v2 attests only that the toolchain LOADS; it says nothing about the installed
 * dependency VERSIONS matching the lockfile. So a v2 marker written before the
 * version proof existed short-circuited straight past it — and those are exactly
 * the trees most likely to already exist, which made "no tree is stamped proven
 * without the version proof" false where it mattered most.
 *
 * Same shape as the v1 -> v2 upgrade: only v3 may short-circuit; a v1/v2 marker
 * triggers the FULL proof in place (no rebuild) and is rewritten as v3 on
 * success, refused on failure.
 */
const MARKER_V3_PREFIX = 'v3:';

function markerV3(fingerprint: string): string {
  return `${MARKER_V3_PREFIX}${fingerprint}`;
}

interface MarkerProof {
  readonly fingerprint: string;
  /** v2+: the runtime native smoke passed for this tree. */
  readonly smokeAttested: boolean;
  /** v3 only: root dependency VERSIONS were proven against the lockfile. */
  readonly versionsAttested: boolean;
}

function readMarker(nodeModulesDir: string): MarkerProof | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(nodeModulesDir, PROVISION_MARKER_FILE), 'utf8').trim();
  } catch {
    return undefined;
  }
  if (raw.startsWith(MARKER_V3_PREFIX)) {
    return { fingerprint: raw.slice(MARKER_V3_PREFIX.length), smokeAttested: true, versionsAttested: true };
  }
  if (raw.startsWith(MARKER_V2_PREFIX)) {
    return { fingerprint: raw.slice(MARKER_V2_PREFIX.length), smokeAttested: true, versionsAttested: false };
  }
  // A bare fingerprint is the v1 format. Anything else unrecognized is treated
  // the same way — as an unattested claim, never as a proof.
  return { fingerprint: raw, smokeAttested: false, versionsAttested: false };
}

/** Filesystem+git-ref-safe slug (mirrors paths.ts) for naming stage dirs. */
function sanitizeSlug(raw: string): string {
  const slug = raw.replace(/[^a-zA-Z0-9._-]/g, '-');
  return slug.length > 0 ? slug : 'assignment';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
