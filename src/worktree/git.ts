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
): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync(GIT_BIN, [...args], {
      cwd,
      maxBuffer: MAX_BUFFER_BYTES,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
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
