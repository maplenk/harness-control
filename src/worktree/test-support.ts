/**
 * Real temp git repo scaffolding for src/worktree tests. NOT a test file
 * itself (no top-level `describe`/`it`) — vitest's default include pattern
 * only picks up `*.test.ts`, so this module is safe to import from every
 * `*.test.ts` file in this package without being run as its own (empty)
 * suite (mirrors `src/persistence/test-support.ts` / `src/memory/
 * test-support.ts`'s convention).
 *
 * Every repo here is created under `os.tmpdir()` via `mkdtemp` with a
 * unique prefix — this package's own `.git` (the harness-orchestration
 * repo you are reading this from) is NEVER touched by anything in this
 * module or its callers.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TEST_AUTHOR_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'harness-orchestration-tests',
  GIT_AUTHOR_EMAIL: 'tests@harness-orchestration.invalid',
  GIT_COMMITTER_NAME: 'harness-orchestration-tests',
  GIT_COMMITTER_EMAIL: 'tests@harness-orchestration.invalid',
};

async function git(cwd: string, args: readonly string[], extraEnv: Readonly<Record<string, string>> = {}): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
  });
  return stdout.toString();
}

async function writeRepoFile(fullPath: string, content: string): Promise<void> {
  await mkdir(path.dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf8');
}

export interface TempGitRepo {
  readonly dir: string;
  /** Escape hatch for arbitrary porcelain-plumbing calls the fixture doesn't wrap directly. */
  run(args: readonly string[]): Promise<string>;
  writeFile(relPath: string, content: string): Promise<void>;
  /** Stages everything and commits; returns the new commit's full sha. */
  commitAll(message: string): Promise<string>;
  headSha(): Promise<string>;
  statusPorcelain(): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * Creates a fresh git repo under a unique `mkdtemp` directory, with one
 * initial commit (`README.md`) on `main` so `HEAD` is always readable from
 * the start. Repo-local `user.name`/`user.email` are set (belt) AND every
 * commit call also passes `TEST_AUTHOR_ENV` (suspenders) — commits work
 * reliably regardless of the host's ambient/global git config.
 */
export async function makeTempGitRepo(prefix = 'harness-worktree-test-'): Promise<TempGitRepo> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  await git(dir, ['init', '--initial-branch=main']);
  await git(dir, ['config', 'user.name', TEST_AUTHOR_ENV.GIT_AUTHOR_NAME as string]);
  await git(dir, ['config', 'user.email', TEST_AUTHOR_ENV.GIT_AUTHOR_EMAIL as string]);

  const repo: TempGitRepo = {
    dir,
    run: (args) => git(dir, args),
    writeFile: (relPath, content) => writeRepoFile(path.join(dir, relPath), content),
    commitAll: async (message) => {
      await git(dir, ['add', '-A']);
      await git(dir, ['commit', '-m', message], TEST_AUTHOR_ENV);
      return (await git(dir, ['rev-parse', 'HEAD'])).trim();
    },
    headSha: async () => (await git(dir, ['rev-parse', 'HEAD'])).trim(),
    statusPorcelain: () => git(dir, ['status', '--porcelain']),
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };

  await repo.writeFile('README.md', '# test repo\n');
  await repo.commitAll('initial commit');
  return repo;
}

/**
 * PLAN §19 test 17 helper ("worktree isolation leaves primary checkout
 * untouched") — EXPORTED for the P3 agent that writes test 17 proper (this
 * package's own tests also use it as an inline invariant check on every
 * worktree-mutating operation). Snapshots the primary checkout's current
 * HEAD sha and `git status --porcelain` output.
 */
export interface PrimaryCheckoutSnapshot {
  readonly headSha: string;
  readonly statusPorcelain: string;
}

export async function snapshotPrimaryCheckout(repoRoot: string): Promise<PrimaryCheckoutSnapshot> {
  const [headSha, statusPorcelain] = await Promise.all([
    git(repoRoot, ['rev-parse', 'HEAD']).then((s) => s.trim()),
    git(repoRoot, ['status', '--porcelain']),
  ]);
  return { headSha, statusPorcelain };
}

/**
 * Asserts the primary checkout is byte-for-byte unchanged relative to
 * `before` (PLAN §16 item 2 / §19 test 17: worktree operations must never
 * touch the primary checkout). Throws with a descriptive message on
 * mismatch — call from inside a vitest `it()` so the throw surfaces as a
 * normal assertion failure.
 */
export async function assertPrimaryCheckoutUntouched(repoRoot: string, before: PrimaryCheckoutSnapshot): Promise<void> {
  const after = await snapshotPrimaryCheckout(repoRoot);
  if (after.headSha !== before.headSha) {
    throw new Error(`Primary checkout HEAD changed: before=${before.headSha} after=${after.headSha} (repoRoot=${repoRoot})`);
  }
  if (after.statusPorcelain !== before.statusPorcelain) {
    throw new Error(
      `Primary checkout working tree changed:\n--- before ---\n${before.statusPorcelain}\n--- after ---\n${after.statusPorcelain}\n(repoRoot=${repoRoot})`,
    );
  }
}
