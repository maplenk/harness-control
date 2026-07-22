/**
 * §16.3 taint + validation routine.
 *
 * Callers (see `manager.ts`'s `validate()`) MUST run this entirely INSIDE
 * the repo's `GitOpMutex` (§16.2). Two reasons:
 *  (a) it must never race a concurrent `git worktree add/remove` for the
 *      same repo, and
 *  (b) any `index.lock` found here is provably STALE: this manager is the
 *      sole writer of these worktrees within the orchestrator process
 *      (§5's single in-process orchestrator), and the mutex guarantees no
 *      OTHER git-op initiated by this manager is concurrently running at
 *      the moment validation runs — so a lock file can only be a leftover
 *      from a process that was killed mid-git-write (§14 emergency kill /
 *      §6.3 T6 deadline termination), never a real in-progress writer.
 *      Removing it unconditionally (no age/PID heuristics) is therefore
 *      safe BECAUSE of the mutex, not despite it — PLAN's own phrasing
 *      ("remove stale index.lock (only within mutex)") is exactly this.
 *
 * Reconciliation policy against a checkpoint's recorded `WorktreeState`
 * (§12.2's `WorktreeState`: `headSha` + `statusPorcelain` + `diffHash`) —
 * deterministic decision tree, evaluated in this order:
 *   1. HEAD not readable (`git rev-parse HEAD` fails)        -> refuse_resume
 *   2. No checkpoint reference to reconcile against:
 *        - current status clean                              -> clean
 *        - current status dirty                               -> wip_committed
 *          (nothing to compare against; the conservative default
 *          PRESERVES unrecorded work rather than risking discarding it)
 *   3. Checkpoint reference present:
 *        - current HEAD != checkpoint.headSha                 -> refuse_resume
 *          (a base-commit drift is too ambiguous to auto-reconcile;
 *          PLAN §16.3: "refusal to resume-in-place on mismatch")
 *        - current HEAD == checkpoint.headSha AND
 *          (statusPorcelain, diffHash) match EXACTLY            -> clean
 *          (worktree is precisely what was honestly checkpointed)
 *        - current HEAD == checkpoint.headSha, MISMATCHED, and
 *          current status is now CLEAN (checkpoint recalled it dirty) -> reset_and_recorded
 *          (actively `git reset --hard HEAD` as a safety no-op on tracked
 *          files, then re-read; nothing to preserve since it is already
 *          clean, but the discrepancy from what was recorded is real and
 *          gets flagged via `mismatchDetected`)
 *        - current HEAD == checkpoint.headSha, MISMATCHED, and
 *          current status is DIRTY                              -> wip_committed
 *          (new, unaccounted-for divergence beyond what the checkpoint
 *          honestly recorded — e.g. a partial write mid-emergency-kill;
 *          preserved via a WIP commit rather than silently discarded)
 *
 * `refuse_resume` is the ONLY outcome that leaves the worktree still
 * "tainted" from the caller's point of view (`manager.ts` re-taints with
 * `reconcile_mismatch` on that outcome and clears any prior taint on every
 * other outcome — validation's whole point is to resolve staleness).
 */
import { existsSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import { artifactHash, gitSha, type ArtifactHash, type GitSha } from '../domain/ids.js';
import type { WorktreeState } from '../domain/entities.js';
import type { WorktreeTaint } from '../domain/state.js';
import { sha256Hex } from '../artifacts/hash.js';
import * as git from './git.js';

export type ValidationOutcome = 'clean' | 'wip_committed' | 'reset_and_recorded' | 'refuse_resume';

export interface ValidateWorktreeInput {
  readonly worktreePath: string;
  /** The last checkpoint's recorded worktree state to reconcile against (§12.2 `WorktreeState`). Absent = nothing to compare (fresh worktree, never yet checkpointed). */
  readonly checkpointWorktreeState?: WorktreeState;
  /** Commit message used for the `wip_committed` path. */
  readonly wipCommitMessage?: string;
  /** Author/committer env for the WIP commit — never relies on ambient git config (see `git.commitAll`). */
  readonly wipCommitEnv?: Readonly<Record<string, string>>;
  /**
   * F7 (#1): when true, the WIP/dirty-recovery commit EXCLUDES `node_modules`
   * (`addAllExceptNodeModules`) — the SAME exclusion the implementor commit uses, so
   * a provisioned, git-ignored toolchain can never enter a §16.3 reconciliation
   * commit even if the target repo's ignore rule was removed. The manager sets this
   * to `provisionStrategy !== 'none'`; under `'none'` (the operator owns
   * node_modules) it stays false so legitimately-tracked node_modules changes are
   * preserved. Default false — non-F7 callers keep plain `git add -A`.
   */
  readonly excludeNodeModulesFromWip?: boolean;
}

export interface ValidateWorktreeResult {
  readonly outcome: ValidationOutcome;
  readonly worktreePath: string;
  /** Freshly captured worktree state — becomes the new baseline for the NEXT checkpoint/validation. */
  readonly worktreeState: WorktreeState;
  readonly lockfileCleanupPerformed: boolean;
  /** True iff a checkpoint reference was supplied AND its recorded state did not match reality (regardless of whether reconciliation then succeeded or refused). */
  readonly mismatchDetected: boolean;
  readonly wipCommitSha?: GitSha;
  readonly detail: string;
}

const DEFAULT_WIP_MESSAGE = 'harness-orchestration: WIP reconciliation (§16.3 validation)';
const DEFAULT_WIP_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'harness-orchestration',
  GIT_AUTHOR_EMAIL: 'harness-orchestration@localhost',
  GIT_COMMITTER_NAME: 'harness-orchestration',
  GIT_COMMITTER_EMAIL: 'harness-orchestration@localhost',
};
/** Sentinel for `worktreeState.headSha` when HEAD could not be read at all — never collides with a real 40-hex sha. */
const UNREADABLE_HEAD_SENTINEL = 'HEAD_UNREADABLE';
const EMPTY_DIFF_HASH: ArtifactHash = artifactHash(sha256Hex(''));

interface CurrentRead {
  readonly headSha: string;
  readonly statusPorcelain: string;
  readonly isDirty: boolean;
  readonly diffHash: ArtifactHash;
}

async function readCurrentState(worktreePath: string): Promise<CurrentRead | undefined> {
  let headSha: string;
  try {
    headSha = await git.resolveSha(worktreePath, 'HEAD');
  } catch {
    return undefined;
  }
  const statusPorcelain = await git.statusPorcelain(worktreePath);
  const diffRaw = await git.diffText(worktreePath, 'HEAD');
  return {
    headSha,
    statusPorcelain,
    isDirty: statusPorcelain.trim().length > 0,
    diffHash: diffRaw.length === 0 ? EMPTY_DIFF_HASH : artifactHash(sha256Hex(diffRaw)),
  };
}

/**
 * Removes a stale `index.lock` if present. Resolves the worktree's ACTUAL
 * git-dir first (transparently following the linked-worktree `.git` FILE
 * indirection) rather than assuming a layout, so this is correct whether
 * `worktreePath` is a linked worktree (the common case — its index lives
 * under the primary repo's `.git/worktrees/<name>/`) or, in tests, a
 * plain repo root.
 *
 * Exported for `manager.ts`'s W2-5 verifier-resume `discardToCommit` path,
 * which shares this routine's mutex-safety argument (this module's doc
 * comment, point (b)): callers MUST hold the repo's `GitOpMutex`.
 */
export async function removeStaleIndexLock(worktreePath: string): Promise<boolean> {
  let gitDir: string;
  try {
    gitDir = await git.absoluteGitDir(worktreePath);
  } catch {
    // Can't even resolve the git-dir (e.g. a broken `.git` pointer) —
    // nothing to clean up here; readCurrentState() below will separately
    // surface this as HEAD-unreadable -> refuse_resume.
    return false;
  }
  const lockPath = path.join(gitDir, 'index.lock');
  if (!existsSync(lockPath)) return false;
  rmSync(lockPath, { force: true });
  return true;
}

async function commitWip(
  worktreePath: string,
  message: string | undefined,
  extraEnv: Readonly<Record<string, string>> | undefined,
  excludeNodeModules: boolean,
): Promise<string | undefined> {
  // F7 (#1): while managed provisioning is ACTIVE, a reconciliation WIP commit must
  // EXCLUDE node_modules (a provisioned, git-ignored toolchain must never enter a
  // commit even if the target repo's ignore rule was removed) — the SAME exclusion
  // the implementor commit uses. Under provision='none' (the operator owns
  // node_modules) keep full `git add -A` so legitimately-tracked node_modules
  // changes are preserved (round-2 #3). For a repo with no node_modules the two are
  // identical. round-4 #3: unstage any ALREADY-STAGED node_modules FIRST — the
  // exclusion pathspec only prevents ADDING it, not removing an index entry an
  // interrupted implementor / a verification command already staged.
  if (excludeNodeModules) {
    await git.unstageNodeModules(worktreePath);
    await git.addAllExceptNodeModules(worktreePath);
  } else {
    await git.addAll(worktreePath);
  }
  const result = await git.commitAll(worktreePath, message ?? DEFAULT_WIP_MESSAGE, extraEnv ?? DEFAULT_WIP_ENV);
  return result.sha;
}

function buildResult(
  outcome: ValidationOutcome,
  worktreePath: string,
  read: CurrentRead | undefined,
  lockfileCleanupPerformed: boolean,
  mismatchDetected: boolean,
  detail: string,
  wipCommitSha?: string,
): ValidateWorktreeResult {
  const taintFlags: readonly WorktreeTaint[] = outcome === 'refuse_resume' ? ['reconcile_mismatch'] : [];
  const worktreeState: WorktreeState = {
    headSha: gitSha(read?.headSha ?? UNREADABLE_HEAD_SENTINEL),
    statusPorcelain: read?.statusPorcelain ?? '',
    diffHash: read?.diffHash ?? EMPTY_DIFF_HASH,
    lockfileCleanupPerformed,
    taintFlags,
  };
  return {
    outcome,
    worktreePath,
    worktreeState,
    lockfileCleanupPerformed,
    mismatchDetected,
    detail,
    ...(wipCommitSha !== undefined ? { wipCommitSha: gitSha(wipCommitSha) } : {}),
  };
}

export async function validateWorktree(input: ValidateWorktreeInput): Promise<ValidateWorktreeResult> {
  const { worktreePath, checkpointWorktreeState: checkpoint } = input;

  const lockfileCleanupPerformed = await removeStaleIndexLock(worktreePath);

  const initialRead = await readCurrentState(worktreePath);
  if (initialRead === undefined) {
    return buildResult('refuse_resume', worktreePath, undefined, lockfileCleanupPerformed, true, 'HEAD is not readable.');
  }

  if (checkpoint === undefined) {
    if (!initialRead.isDirty) {
      return buildResult(
        'clean',
        worktreePath,
        initialRead,
        lockfileCleanupPerformed,
        false,
        'No prior checkpoint to reconcile against; worktree is clean.',
      );
    }
    const wipSha = await commitWip(worktreePath, input.wipCommitMessage, input.wipCommitEnv, input.excludeNodeModulesFromWip ?? false);
    const after = await readCurrentState(worktreePath);
    return buildResult(
      'wip_committed',
      worktreePath,
      after ?? initialRead,
      lockfileCleanupPerformed,
      false,
      'No prior checkpoint to reconcile against; dirty worktree preserved as a WIP commit.',
      wipSha,
    );
  }

  if (initialRead.headSha !== String(checkpoint.headSha)) {
    return buildResult(
      'refuse_resume',
      worktreePath,
      initialRead,
      lockfileCleanupPerformed,
      true,
      `HEAD drifted since the last checkpoint (checkpoint=${String(checkpoint.headSha)}, current=${initialRead.headSha}); refusing to resume in place.`,
    );
  }

  const exactMatch =
    initialRead.statusPorcelain === checkpoint.statusPorcelain &&
    String(initialRead.diffHash) === String(checkpoint.diffHash);
  if (exactMatch) {
    return buildResult('clean', worktreePath, initialRead, lockfileCleanupPerformed, false, 'Worktree matches the last checkpoint exactly.');
  }

  if (!initialRead.isDirty) {
    // Checkpoint recorded dirty content that is no longer there: reset to
    // HEAD as a safety no-op on tracked files (nothing to preserve — it is
    // already clean), then re-read and record the discrepancy honestly.
    await git.hardReset(worktreePath, initialRead.headSha);
    const after = await readCurrentState(worktreePath);
    return buildResult(
      'reset_and_recorded',
      worktreePath,
      after ?? initialRead,
      lockfileCleanupPerformed,
      true,
      'Checkpoint recorded a dirty worktree that is already clean now; reset to HEAD and recorded.',
    );
  }

  const wipSha = await commitWip(worktreePath, input.wipCommitMessage, input.wipCommitEnv, input.excludeNodeModulesFromWip ?? false);
  const after = await readCurrentState(worktreePath);
  return buildResult(
    'wip_committed',
    worktreePath,
    after ?? initialRead,
    lockfileCleanupPerformed,
    true,
    'Worktree diverged from the last checkpoint beyond what was recorded; preserved as a WIP commit.',
    wipSha,
  );
}
