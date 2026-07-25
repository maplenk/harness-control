/**
 * Low-level real `git` subprocess plumbing (PLAN.md §16). Every function
 * here shells out to the actual `git` binary via `execFile` (argv array,
 * never a shell string — no injection surface from branch names or paths)
 * and normalizes failures into a typed `WorktreeError{kind:'git_command_failed'}`
 * carrying the raw stdout+stderr in `.detail`.
 *
 * Deliberately ASYNC (child-process I/O), unlike `src/artifacts/cas-fs.ts`'s
 * synchronous byte-write primitive: git operations (spawn, clone-like
 * `worktree add` copies, status/diff over a real tree) can take a
 * non-trivial amount of wall-clock time, and this manager runs inside the
 * same process as the orchestrator's own self-supervision heartbeat (§14) —
 * blocking the event loop here would stall that heartbeat.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { WorktreeError, isWorktreeError } from './errors.js';

const execFileAsync = promisify(execFile);

const GIT_BIN = 'git';
/** Generous: real `git status`/`diff` output on a large dirty tree can be sizeable. */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
}

interface ExecFileErrorShape {
  readonly stdout?: string | Buffer;
  readonly stderr?: string | Buffer;
  readonly message?: string;
}

function toText(value: string | Buffer | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : value.toString('utf8');
}

/**
 * Runs `git <args>` with cwd `cwd`. Never hangs on an interactive
 * credential/terminal prompt (`GIT_TERMINAL_PROMPT=0`); `extraEnv` overrides
 * on top of that for call-specific needs (e.g. WIP-commit author identity).
 */
export async function runGit(
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<Record<string, string>> = {},
  /** F9 (P5): wall-clock cap; on expiry execFile KILLS the child and this
   * rejects `git_command_failed`. Omitted = unbounded (the historical default —
   * every caller that holds the git mutex should pass one). */
  timeoutMs?: number,
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync(GIT_BIN, [...args], {
      cwd,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
    return { stdout: toText(stdout), stderr: toText(stderr) };
  } catch (error) {
    const shaped = error as ExecFileErrorShape;
    const stdout = toText(shaped.stdout);
    const stderr = toText(shaped.stderr);
    const summary = stderr.trim() || stdout.trim() || shaped.message || String(error);
    throw new WorktreeError('git_command_failed', `git ${args.join(' ')} (cwd=${cwd}) failed: ${summary}`, {
      cause: error,
      detail: [stdout, stderr].filter((s) => s.length > 0).join('\n'),
    });
  }
}

export async function isInsideWorkTree(dir: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(['rev-parse', '--is-inside-work-tree'], dir);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

export async function resolveTopLevel(dir: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', '--show-toplevel'], dir);
  return stdout.trim();
}

const SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * Resolves `ref` to a full 40-hex commit sha, failing loudly (never a
 * partial/short sha, never a symbolic name) — this is what makes the
 * result usable as PLAN §16 item 1's "immutable base SHA" and as §16.3's
 * "verify HEAD readable" check (callers pass `ref: 'HEAD'`).
 */
export async function resolveSha(dir: string, ref: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', '--verify', `${ref}^{commit}`], dir);
  const sha = stdout.trim();
  if (!SHA_RE.test(sha)) {
    throw new WorktreeError('git_command_failed', `git rev-parse did not return a 40-char sha for '${ref}': ${JSON.stringify(sha)}`);
  }
  return sha;
}

export async function statusPorcelain(worktreePath: string): Promise<string> {
  const { stdout } = await runGit(['status', '--porcelain'], worktreePath);
  return stdout;
}

/**
 * Read HEAD and porcelain status without accepting a cached-HEAD race. Git
 * does not expose a transaction spanning rev-parse and status, so bracket the
 * status read with two HEAD resolutions; callers must refuse `stable:false`.
 */
export interface StableHeadReadDeps {
  readonly resolveSha?: (dir: string, ref: string) => Promise<string>;
  readonly statusPorcelain?: (dir: string) => Promise<string>;
}

export async function readStableHeadAndStatus(
  worktreePath: string,
  deps: StableHeadReadDeps = {},
): Promise<{
  readonly headBefore: string;
  readonly headAfter: string;
  readonly statusPorcelain: string;
  readonly stable: boolean;
}> {
  const resolve = deps.resolveSha ?? resolveSha;
  const readStatus = deps.statusPorcelain ?? statusPorcelain;
  const headBefore = await resolve(worktreePath, 'HEAD');
  const status = await readStatus(worktreePath);
  const headAfter = await resolve(worktreePath, 'HEAD');
  return {
    headBefore,
    headAfter,
    statusPorcelain: status,
    stable: headBefore === headAfter,
  };
}

/**
 * Parse `git status --porcelain` output into the touched paths. Rename/copy
 * lines (`XY orig -> dest`) report the DESTINATION path; git's quoting of
 * unusual paths is left verbatim (the list feeds human-facing blocker text,
 * never further git commands). Used by the W1-F4 post-verification dirt
 * snapshot and the §16 worktree-cleanliness probe.
 */
export function porcelainPaths(status: string): string[] {
  const paths: string[] = [];
  for (const line of status.split('\n')) {
    if (line.trim().length === 0) continue;
    const entry = line.slice(3);
    const arrow = entry.lastIndexOf(' -> ');
    paths.push(arrow >= 0 ? entry.slice(arrow + 4) : entry);
  }
  return paths;
}

/**
 * The checked-out branch name of `dir` (§16 integration hint). Returns
 * `undefined` on a detached HEAD or when `dir` is not a resolvable repo:
 * `symbolic-ref --quiet` exits non-zero (no branch) rather than printing an
 * error, which `runGit` surfaces as a throw the caller treats as "no branch".
 * Used to target the manual `git switch <dest>` hint at the repo's REAL default
 * branch (e.g. `master`) instead of a hardcoded `main`.
 */
export async function currentBranch(dir: string): Promise<string | undefined> {
  try {
    const { stdout } = await runGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], dir);
    const name = stdout.trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

export async function diffText(worktreePath: string, against: string): Promise<string> {
  const { stdout } = await runGit(['diff', against], worktreePath);
  return stdout;
}

/** Resolves the ACTUAL git-dir for `worktreePath`, transparently following the linked-worktree `.git` FILE indirection. */
export async function absoluteGitDir(worktreePath: string): Promise<string> {
  const { stdout } = await runGit(['rev-parse', '--absolute-git-dir'], worktreePath);
  return stdout.trim();
}

export async function worktreeListPorcelain(repoRoot: string): Promise<string> {
  const { stdout } = await runGit(['worktree', 'list', '--porcelain'], repoRoot);
  return stdout;
}

export async function worktreeAdd(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  baseSha: string,
): Promise<void> {
  await runGit(['worktree', 'add', '-b', branch, worktreePath, baseSha], repoRoot);
}

export async function worktreeRemove(repoRoot: string, worktreePath: string, force: boolean): Promise<void> {
  await runGit(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath], repoRoot);
}

export async function worktreePrune(repoRoot: string): Promise<void> {
  await runGit(['worktree', 'prune', '-v'], repoRoot);
}

export async function addAll(worktreePath: string): Promise<void> {
  await runGit(['add', '-A'], worktreePath);
}

/** A repo-root-relative path that lies IN (or IS) a `node_modules` directory, at
 * ANY depth: `node_modules/x`, `web/node_modules/x`, `node_modules`. Deliberately
 * segment-anchored so `src/node_modules_helper.ts` / `src/my_node_modules/` — real
 * source files that merely contain the substring — are never touched. */
const NODE_MODULES_PATH_RE = /(^|\/)node_modules(\/|$)/;

/** The staged paths (index vs HEAD) that live under a `node_modules`, at any depth.
 * `-z` is NUL-TERMINATED and disables git's path quoting, so paths with spaces,
 * newlines or non-ASCII bytes come through verbatim (the trailing empty field the
 * final NUL produces is dropped). */
async function stagedNodeModulesPaths(worktreePath: string): Promise<string[]> {
  const { stdout } = await runGit(['diff', '--cached', '--name-only', '-z'], worktreePath);
  const candidates = stdout.split('\0').filter((p) => p.length > 0 && NODE_MODULES_PATH_RE.test(p));
  if (candidates.length === 0) return [];
  // REGRESSION 4 (round 10): only the ENGINE's node_modules is excluded.
  //
  // The guard exists to stop the PROVISIONED tree entering a commit. Excluding
  // every node_modules-shaped path at any depth swept up TRACKED, vendored trees
  // too — intentional user content that main commits without complaint —
  // silently unstaging them and then refusing the round for post-verification
  // dirt. A vendored node_modules stays committable.
  //
  // ROUND 13 (ITEM 3): ownership is a property of the ROOT, decided ONCE. The
  // unstage necessarily acts on the outer root (one pathspec per file would blow
  // ARG_MAX on a 100k-entry tree), so classifying per FILE let a single ignored,
  // not-yet-committed file inside a vendored tree condemn the whole root — its
  // tracked siblings' staged modifications went with it. Grouping first also ends
  // the per-file subprocess storm: at most two probes per ROOT, whatever the tree's
  // size.
  const byRoot = new Map<string, string[]>();
  for (const candidate of candidates) {
    const root = outerNodeModulesRoot(candidate);
    if (root === undefined) continue; // unreachable for NODE_MODULES_PATH_RE matches; defensive
    const grouped = byRoot.get(root);
    if (grouped === undefined) byRoot.set(root, [candidate]);
    else grouped.push(candidate);
  }
  const engineOwned: string[] = [];
  for (const [root, staged] of byRoot) {
    if (await isEngineOwnedNodeModulesRoot(worktreePath, root, staged)) engineOwned.push(...staged);
  }
  return engineOwned;
}

/** The OUTERMOST `node_modules` directory a repo-relative path sits under
 * (`node_modules`, `web/node_modules`), or `undefined` if it is not under one. */
function outerNodeModulesRoot(relpath: string): string | undefined {
  const segments = relpath.split('/');
  const index = segments.indexOf('node_modules');
  if (index < 0) return undefined;
  return segments.slice(0, index + 1).join('/');
}

/** The marker the provisioner writes INSIDE a tree it built (see `provision.ts`). */
const PROVISION_MARKER_BASENAME = '.harness-provisioned';

/**
 * REGRESSION 4 (round 10) — is this staged node_modules ROOT the ENGINE's tree
 * rather than the user's? Asked ONCE per root (ITEM 3), never per file.
 *
 * ROUND 13 (ITEM 1) — the ROOT tree is exempt from the question entirely.
 *
 * Both callers of this module COMMIT BEFORE provisioning runs (`implementor.ts`'s
 * post-turn commit, `validate.ts`'s §16.3 WIP reconciliation), so at staging time
 * an agent-created `node_modules` is necessarily UNIGNORED and UNMARKED —
 * provisioning is what refuses a missing ignore rule and what writes the marker,
 * and it has not run yet. Asking for a positive signal therefore COMMITTED it:
 * a large generated tree, native binaries, or generated secrets added permanently
 * to the branch and the git object database. A previously provisioned tree whose
 * marker an `npm ci` removed along with its ignore rule lands in the same place.
 * Main excluded a ROOT `node_modules` UNCONDITIONALLY, and that is restored here:
 * while managed provisioning is ACTIVE (the only state in which these helpers are
 * reached — `provision='none'` uses plain `addAll`) the root tree never enters a
 * harness commit, whatever its ignore/marker/tracked status.
 *
 * NESTED roots keep the round-10 policy, because nested staging is what F10
 * actually got wrong (main's root-only pathspec never touched them):
 *  - a git IGNORE RULE covers it (rules only, via `--no-index`, so force-adding
 *    cannot launder it), which is what a provisioned tree always has; or
 *  - the tree carries the provisioner's own MARKER file, which proves engine
 *    ownership even in a repo with no ignore rule at all.
 *
 * And one veto that outranks both: ANY content of the root already IN HEAD makes
 * the WHOLE root committed user content — a vendored dependency tree main commits
 * without complaint — which must stay committable. ITEM 3: the veto is evaluated
 * over the root, not over the individual file, because the unstage acts on the
 * root; deciding per file let one ignored newcomer unstage its tracked siblings.
 * Excluding every node_modules-shaped path at any depth was the original
 * regression: it silently unstaged those and then failed the round on the
 * resulting "post-verification dirt".
 */
async function isEngineOwnedNodeModulesRoot(
  worktreePath: string,
  root: string,
  staged: readonly string[],
): Promise<boolean> {
  // ITEM 1: the ROOT tree — main's unconditional exclusion, asked no questions.
  if (!root.includes('/')) return true;
  if (await rootHasHeadContent(worktreePath, root)) return false; // committed user content
  // The ignore probe runs on a staged FILE under the root, not on the root path
  // itself: `git check-ignore --no-index` answers "not ignored" for a DIRECTORY
  // that is absent from disk (a trailing-slash rule needs to know it IS one),
  // while a file path under it answers correctly whether or not it exists.
  // Verified against git 2.55. One probe either way.
  const probe = staged[0];
  if (probe !== undefined && (await isPathIgnoredByRule(worktreePath, probe))) return true;
  return existsSync(path.join(worktreePath, root, PROVISION_MARKER_BASENAME));
}

/**
 * True iff the committed HEAD tree holds ANY content under `root`.
 *
 * `:(literal)` (MED-8's reason, and supported by `ls-tree` unlike `check-ignore`):
 * a repo path may legitimately begin with a colon, and git would otherwise parse a
 * leading `:(...)` as PATHSPEC MAGIC — the probe would then match nothing and
 * report a tracked tree as untracked. An unreadable HEAD (unborn branch) exits
 * non-zero, which is correctly "nothing is tracked yet".
 */
async function rootHasHeadContent(worktreePath: string, root: string): Promise<boolean> {
  const { exitCode, stdout } = await runGitStatus(
    ['ls-tree', '-r', '--name-only', 'HEAD', '--', `:(literal)${root}`],
    worktreePath,
  );
  return exitCode === 0 && stdout.trim().length > 0;
}

/**
 * The OUTERMOST `node_modules` directory each staged path sits under — a tiny,
 * bounded pathspec set (`node_modules`, `web/node_modules`, …) rather than one
 * argument per file, so a 100k-entry tree cannot blow past ARG_MAX.
 *
 * MED-8: every entry is prefixed `:(literal)`. A repo path can legitimately
 * begin with a colon (`:(top)foo/node_modules`), and git would then parse the
 * leading `:(...)` as PATHSPEC MAGIC rather than as part of the path — the reset
 * silently matches nothing, exits 0, and the node_modules entries stay STAGED.
 * Verified against real git: without the prefix that exact directory name leaves
 * `:(top)foo/node_modules/pkg/i.js` in the index after a "successful" reset.
 */
function nodeModulesPathspecs(paths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const p of paths) {
    // The SAME root derivation the ownership classification groups by, so what is
    // reset is exactly what was classified.
    const root = outerNodeModulesRoot(p);
    if (root === undefined) continue; // unreachable for NODE_MODULES_PATH_RE matches; defensive
    roots.add(`:(literal)${root}`);
  }
  return [...roots].sort();
}

/**
 * Stage every change EXCEPT anything under a `node_modules` (at any depth),
 * preserving full `-A` semantics (adds, modifications, AND deletions) for
 * everything else.
 *
 * F7 (B1): the harness provisions a git-ignored `node_modules` into agent
 * worktrees; if a target repo lacks a `node_modules/` ignore rule (or an agent
 * removed it), a plain `git add -A` would stage the provisioned toolchain INTO the
 * commit. Guaranteeing it never enters a harness commit is the invariant — held
 * here independently of, and complementary to, provisioning's own fail-closed
 * refusal of an unignored/tracked `node_modules`.
 *
 * F10 — HOW that invariant is held changed, because the old mechanism stopped
 * working. `git add -A -- . ':(exclude)node_modules'` exits 1 under git 2.55 with
 * "The following paths are ignored by one of your .gitignore files: node_modules"
 * whenever an ignored `node_modules` exists on disk: the exclude pathspec ITEM is
 * treated as an explicit mention of an ignored path. Since F7 provisions exactly
 * such a tree into every worktree, that made BOTH callers (the implementor's
 * post-turn commit and the §16.3 WIP reconciliation) fail on every provisioned
 * round. So: stage with a plain `git add -A -- .` — .gitignore alone already keeps
 * an ignored tree out — and then PROVE the index is clean of `node_modules`,
 * unstaging what is there and FAILING CLOSED if anything survives. The proof is
 * strictly stronger than the old pathspec, which only ever covered a ROOT
 * `node_modules` and silently staged a nested `web/node_modules`.
 *
 * Never deletes: unstaging leaves the provisioned tree on disk for the verifier.
 */
export async function addAllExceptNodeModules(worktreePath: string): Promise<void> {
  await runGit(['add', '-A', '--', '.'], worktreePath);
  // Covers BOTH what `add -A` just staged and anything a prior `git add` had
  // already placed in the index (F7 round-4 #3 — e.g. a verification command or an
  // interrupted implementor that ran `git add -f node_modules`).
  await unstageNodeModules(worktreePath);
  await assertIndexFreeOfNodeModules(worktreePath);
}

/**
 * MED-8 — the INVARIANT, asserted independently of how the index got here: no
 * `node_modules` path (at any depth) is staged. Exported so the guarantee can be
 * checked — and tested — on its own, rather than only as a tail of
 * `addAllExceptNodeModules`.
 *
 * Throws the dedicated `node_modules_still_staged` kind, NOT
 * `git_command_failed`: no git command failed here. The index simply refused to
 * reach a safe state, which is an invariant violation a caller must not retry
 * blindly.
 */
export async function assertIndexFreeOfNodeModules(worktreePath: string): Promise<void> {
  const remaining = await stagedNodeModulesPaths(worktreePath);
  if (remaining.length === 0) return;
  throw new WorktreeError(
    'node_modules_still_staged',
    `refusing to commit: ${remaining.length} node_modules path(s) remain STAGED after unstaging them ` +
      `(cwd=${worktreePath}): ${remaining.slice(0, 5).join(', ')}. A provisioned dependency tree must never ` +
      'enter a harness commit.',
    { detail: remaining.slice(0, 20).join('\n') },
  );
}

/**
 * Unstage every ALREADY-STAGED `node_modules` path from the index, at ANY depth,
 * WITHOUT touching the working tree. F7 (round-4 #3): staging must not merely
 * avoid ADDING `node_modules` — it must also remove entries a prior `git add`
 * already placed in the index. F10: the old form (`git reset -- node_modules`) was
 * root-only, so a nested `web/node_modules` slipped through; the index is now
 * enumerated and every `node_modules` root found is reset.
 *
 * A tracked-in-HEAD `node_modules` is reset back to its HEAD content, so it is no
 * longer a staged CHANGE (exactly what the old exclusion achieved); an untracked
 * one leaves the index entirely. Either way the bytes stay on disk. Resetting a
 * pathspec that matches nothing is a no-op (exit 0), and no reset runs at all when
 * nothing is staged. Returns the paths it unstaged.
 */
export async function unstageNodeModules(worktreePath: string): Promise<string[]> {
  const staged = await stagedNodeModulesPaths(worktreePath);
  if (staged.length === 0) return [];
  await runGit(['reset', '--quiet', '--', ...nodeModulesPathspecs(staged)], worktreePath);
  return staged;
}

const NOTHING_TO_COMMIT_RE = /nothing to commit/i;

/**
 * Commits whatever is currently staged. Author/committer identity is
 * supplied via `extraEnv` (never relies on ambient/global git config —
 * the target repo may have none configured, e.g. a fresh CI checkout).
 * "Nothing to commit" (everything already matched HEAD after `addAll`) is
 * NOT an error here — it's reported as `committed:false` so callers can
 * treat it as a no-op rather than a failure.
 */
export async function commitAll(
  worktreePath: string,
  message: string,
  extraEnv: Readonly<Record<string, string>>,
): Promise<{ readonly committed: boolean; readonly sha?: string }> {
  try {
    // §17.1-adjacent safety note: `--no-verify` is deliberate here — this is
    // an INTERNAL reconciliation commit inside an AGENT-owned worktree
    // (never the harness-orchestration repo itself, and never a commit a
    // human asked for), created purely to avoid silently losing partial
    // work at a taint-recovery boundary. An unrelated pre-commit hook
    // (lint/format) in the TARGET repo must never be allowed to block that
    // safety net.
    await runGit(['commit', '--no-verify', '-m', message], worktreePath, extraEnv);
  } catch (error) {
    if (isWorktreeError(error) && NOTHING_TO_COMMIT_RE.test(error.detail ?? error.message)) {
      return { committed: false };
    }
    throw error;
  }
  const sha = await resolveSha(worktreePath, 'HEAD');
  return { committed: true, sha };
}

export async function hardReset(worktreePath: string, sha: string): Promise<void> {
  await runGit(['reset', '--hard', sha], worktreePath);
}

/**
 * W2-5 verifier-resume reconciliation: remove UNTRACKED files/directories
 * (`git clean -fd`). Deliberately without `-x`: ignored files (caches, build
 * output the repo chose to ignore) are not "verifier dirt" and discarding
 * them would punish unrelated tooling. Pair with `hardReset` to force a
 * worktree back to an exact commit and DISCARD everything a read-only
 * verifier's evidence commands left behind.
 */
export async function cleanUntracked(worktreePath: string): Promise<void> {
  await runGit(['clean', '-fd'], worktreePath);
}

// ---------------------------------------------------------------------------
// F7 worktree dependency provisioning: exit-code-aware plumbing + committed-HEAD
// / ignore queries (see `./provision.ts`).
// ---------------------------------------------------------------------------
export interface GitCommandStatus {
  readonly stdout: string;
  readonly stderr: string;
  /** Process exit code; `-1` when the process could not be spawned at all. */
  readonly exitCode: number;
}

/**
 * Runs `git <args>` and returns its exit code WITHOUT throwing on a non-zero
 * exit — for callers that must branch on a SPECIFIC code (`check-ignore` exits 1
 * for "not ignored" but 128 for a real error; `ls-files --error-unmatch` exits 1
 * for "not tracked"). A spawn failure (git not found) yields `exitCode: -1`.
 */
export async function runGitStatus(
  args: readonly string[],
  cwd: string,
  extraEnv: Readonly<Record<string, string>> = {},
  /** F9 (P5): wall-clock cap; a killed child surfaces as a non-zero exit code. */
  timeoutMs?: number,
): Promise<GitCommandStatus> {
  try {
    const { stdout, stderr } = await execFileAsync(GIT_BIN, [...args], {
      cwd,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
      ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
    });
    return { stdout: toText(stdout), stderr: toText(stderr), exitCode: 0 };
  } catch (error) {
    const shaped = error as ExecFileErrorShape & { code?: unknown };
    const exitCode = typeof shaped.code === 'number' ? shaped.code : -1;
    return { stdout: toText(shaped.stdout), stderr: toText(shaped.stderr), exitCode };
  }
}

/**
 * True iff `pathspec` is git-ignored in the worktree (`git check-ignore -q`).
 * Distinguishes "not ignored" (exit 1 → `false`) from a genuine git error
 * (exit 128 / spawn failure → throw), so the F7 preflight never mistakes a
 * broken repo for "safe to provision".
 */
/**
 * REGRESSION 4 (round 10) — is `pathspec` covered by an IGNORE RULE, regardless of
 * whether it currently sits in the index?
 *
 * Plain `check-ignore` skips TRACKED paths, so a provisioned tree that an agent
 * force-added (`git add -f`) would report as "not ignored" and escape the guard —
 * force-adding must not launder the engine's own tree. `--no-index` consults the
 * rules alone, which is the question actually being asked.
 */
export async function isPathIgnoredByRule(worktreePath: string, pathspec: string, timeoutMs?: number): Promise<boolean> {
  const { exitCode, stderr } = await runGitStatus(
    ['check-ignore', '-q', '--no-index', '--', pathspec],
    worktreePath,
    {},
    timeoutMs,
  );
  if (exitCode === 0) return true;
  if (exitCode === 1) return false;
  throw new WorktreeError(
    'git_command_failed',
    `git check-ignore --no-index ${pathspec} (cwd=${worktreePath}) failed (exit ${exitCode}): ${stderr.trim()}`,
  );
}

export async function isPathIgnored(worktreePath: string, pathspec: string, timeoutMs?: number): Promise<boolean> {
  const { exitCode, stderr } = await runGitStatus(['check-ignore', '-q', '--', pathspec], worktreePath, {}, timeoutMs);
  if (exitCode === 0) return true;
  if (exitCode === 1) return false;
  throw new WorktreeError(
    'git_command_failed',
    `git check-ignore ${pathspec} (cwd=${worktreePath}) failed (exit ${exitCode}): ${stderr.trim()}`,
  );
}

/**
 * True iff at least one TRACKED file matches `pathspec` (`git ls-files
 * --error-unmatch`). Exit 0 → tracked; exit 1 → the documented "did not match a
 * known file" (not tracked); ANY OTHER exit (128 real error / -1 spawn failure) →
 * throw — F7 must never mistake an operational git failure for "not tracked".
 */
export async function isPathTracked(worktreePath: string, pathspec: string, timeoutMs?: number): Promise<boolean> {
  const { exitCode, stderr } = await runGitStatus(
    ['ls-files', '--error-unmatch', '--', pathspec],
    worktreePath,
    {},
    timeoutMs,
  );
  if (exitCode === 0) return true;
  if (exitCode === 1) return false;
  throw new WorktreeError(
    'git_command_failed',
    `git ls-files --error-unmatch ${pathspec} (cwd=${worktreePath}) failed (exit ${exitCode}): ${stderr.trim()}`,
  );
}

/**
 * F8 (A) — true iff `ancestor` is reachable from `descendant`
 * (`git merge-base --is-ancestor`). Exit 0 → ancestor; exit 1 → the documented
 * "not an ancestor"; ANY OTHER exit (128 for an unknown/non-commit object name, a
 * broken object store, -1 for a spawn failure) → THROW.
 *
 * The exit-1/exit-128 split is the whole point: §16.3's forward-containment
 * acceptance may only trust a POSITIVE answer, and must treat an ancestry probe
 * it could not complete as a REFUSAL, never as "not an ancestor is fine" and
 * never as an acceptance. Both revs are peeled with `^{commit}` so a tag/tree/
 * blob name fails loudly here rather than silently answering about the wrong
 * object. Note git's own semantics make a commit an ancestor of ITSELF; callers
 * that need STRICT ancestry (this one does) compare the shas first.
 */
export async function isAncestor(worktreePath: string, ancestor: string, descendant: string): Promise<boolean> {
  const { exitCode, stderr } = await runGitStatus(
    ['merge-base', '--is-ancestor', `${ancestor}^{commit}`, `${descendant}^{commit}`],
    worktreePath,
  );
  if (exitCode === 0) return true;
  if (exitCode === 1) return false;
  throw new WorktreeError(
    'git_command_failed',
    `git merge-base --is-ancestor ${ancestor} ${descendant} (cwd=${worktreePath}) failed (exit ${exitCode}): ${stderr.trim()}`,
  );
}

/**
 * Contents of `relpath` at the worktree's committed HEAD, or `undefined` when the
 * path is GENUINELY absent from HEAD.
 *
 * B3 (round-2 #8): existence is determined STRUCTURALLY and LOCALE-INDEPENDENTLY.
 * `git ls-tree HEAD -- <relpath>` exits 0 for any readable HEAD and prints a line
 * IFF the path is a tracked entry, so an EMPTY stdout is genuine absence — decided
 * on the exit code + emptiness, never by regex-matching an English `git show`
 * fatal ("does not exist in …") a non-English git locale would translate and
 * break. ANY nonzero `ls-tree` exit (a broken object store, an unreadable/absent
 * HEAD, a spawn failure) is a real error → THROW (fail closed), never classified
 * as "no such manifest" (which would wrongly reach the no-dependency success path).
 * The follow-up `git show` reads the proven-present blob's bytes. `relpath` is
 * repo-root-relative, posix-separated.
 */
export async function readFileAtHead(
  worktreePath: string,
  relpath: string,
  timeoutMs?: number,
): Promise<string | undefined> {
  const probe = await runGitStatus(['ls-tree', '--name-only', 'HEAD', '--', relpath], worktreePath, {}, timeoutMs);
  if (probe.exitCode !== 0) {
    throw new WorktreeError(
      'git_command_failed',
      `git ls-tree HEAD -- ${relpath} (cwd=${worktreePath}) failed (exit ${probe.exitCode}): ${probe.stderr.trim()}`,
    );
  }
  if (probe.stdout.trim().length === 0) return undefined; // genuinely absent at HEAD (locale-independent)
  const { exitCode, stdout, stderr } = await runGitStatus(['show', `HEAD:${relpath}`], worktreePath, {}, timeoutMs);
  if (exitCode === 0) return stdout;
  throw new WorktreeError(
    'git_command_failed',
    `git show HEAD:${relpath} (cwd=${worktreePath}) failed (exit ${exitCode}): ${stderr.trim()}`,
  );
}
