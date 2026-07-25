/**
 * B3 — the `in_place` execution mode: a git START CHECKPOINT instead of a
 * filesystem boundary (execution-modes spec §2.2).
 *
 * The user's framing: *"we need optional worktrees. the solution could be
 * simply git. have a start checkpoint and we could revert to it if needed."*
 *
 * ## What replaces the worktree, exactly
 *
 * In `worktree` mode the implementor writes in a directory the user's checkout
 * does not contain, so ANY change in the primary checkout is contamination and
 * rollback is `rm -rf`. In-place mode gives that up deliberately, so the safety
 * has to come from somewhere else:
 *
 *  1. **Entry is fail-closed.** The §16.1 gate (canonical root, resolved base
 *     commit, EMPTY porcelain status) is not relaxed — it is DEPENDED ON. A
 *     dirty checkout refuses, which is what guarantees no human work is inside
 *     the revert blast radius when the run starts.
 *  2. **The checkpoint is recorded BEFORE anything is mutated.** Not before the
 *     agent spawns — before the BRANCH SWITCH. A crash between "switched" and
 *     "recorded" would leave a tree the engine moved and cannot prove a revert
 *     target for; recording first makes that window empty.
 *  3. **The work is always on an assignment branch.** The user's branch is never
 *     committed to, and their original HEAD is recorded so exit can restore it.
 *  4. **The revert is GUARDED by the write scope.** Before `reset --hard` +
 *     `clean -fd`, every dirty path must be attributable to this assignment.
 *     One path outside its scope and the revert is REFUSED with the tree left
 *     exactly as it is. `git clean` never gets `-x`: ignored files (`node_modules`
 *     — the whole reason this mode is cheap) survive.
 *
 * ## The honest cost, restated where the code is
 *
 * Drift detection degrades from "any change in the primary checkout is drift" to
 * "any change OUTSIDE the assignment's scope is drift". A human editing an
 * in-scope file while the run is live is indistinguishable from the agent. That
 * is a real reduction in safety against `worktree` mode, it is why `worktree`
 * remains the default, and it is why the revert refuses rather than guesses.
 */
import { createHash } from 'node:crypto';
import type { Clock, IsoTimestamp } from '../lib/clock.js';
import { gitSha, type AssignmentId, type GitSha } from '../domain/ids.js';
import * as git from './git.js';
import { WorktreeError } from './errors.js';
import { pathsOutsideBoundary, type WriteBoundary } from './write-scope.js';
import * as path from 'node:path';

/**
 * The revert target and the F8-style receipt for an in-place assignment.
 *
 * Every field is load-bearing:
 *  - `baseSha` — what `reset --hard` targets.
 *  - `headRef` / `headRefKind` — what the user was on, so exit puts them back.
 *    A DETACHED head records the sha, because restoring a branch name that was
 *    never checked out would be a fabrication.
 *  - `entryPorcelainDigest` — proof of what the tree looked like at entry.
 *    Recorded even though entry requires it to be EMPTY: a digest of "" is a
 *    statement that the check ran, which a missing field is not.
 */
export interface InPlaceCheckpoint {
  readonly rootPath: string;
  readonly baseSha: GitSha;
  readonly headRef: string;
  readonly headRefKind: 'branch' | 'detached';
  readonly entryPorcelainDigest: string;
  /** The assignment branch created at `baseSha` and checked out. */
  readonly branch: string;
  readonly createdAt: IsoTimestamp;
}

/** Digest of a porcelain snapshot — sha256 over the exact bytes git printed. */
export function porcelainDigest(statusPorcelain: string): string {
  return createHash('sha256').update(statusPorcelain, 'utf8').digest('hex');
}

export interface OpenInPlaceInput {
  readonly assignmentId: AssignmentId;
  /** The canonical primary checkout root (`git rev-parse --show-toplevel`). */
  readonly rootPath: string;
  /** The run's PINNED immutable base commit (§16 item 1). */
  readonly baseSha: GitSha;
  readonly branch: string;
  readonly clock: Clock;
  /**
   * The durable write of the start checkpoint. Called BEFORE the tree is
   * touched; a throw here ABORTS entry with the checkout untouched. Required —
   * not optional — because an in-place run with no recorded revert target is
   * precisely the state this mode exists to prevent, and an optional persist is
   * an optional guarantee.
   */
  readonly persist: (checkpoint: InPlaceCheckpoint) => void;
}

/**
 * Enter in-place mode: verify the checkout is clean, record the start
 * checkpoint, then create and check out the assignment branch at `baseSha`.
 *
 * Ordering is the guarantee. Every step that can refuse runs BEFORE the first
 * step that mutates, and the durable write is the last thing before the mutation
 * — so the only crash window left is "checkpoint recorded, branch not created",
 * which is recoverable (the recorded `headRef` is still where the user is).
 */
export async function openInPlaceCheckpoint(input: OpenInPlaceInput): Promise<InPlaceCheckpoint> {
  const { rootPath } = input;

  // (1) §16.1, not relaxed. A dirty tree refuses BEFORE anything is recorded.
  const status = await git.statusPorcelain(rootPath);
  if (status.trim().length !== 0) {
    throw new WorktreeError(
      'requires_validation',
      `in-place execution requires a clean checkout at ${rootPath}: 'git status --porcelain' is not empty. ` +
        'The start checkpoint is a revert target, and reverting a tree that already held uncommitted work ' +
        'would destroy work this engine did not create. Commit or stash first.',
      { detail: status },
    );
  }

  // (2) The base must really be this commit — the same byte-for-byte identity
  // check `createWorktree` applies, for the same reason: a branded GitSha is a
  // compile-time claim, and `HEAD`/a short id would silently become the base.
  const resolvedBase = await git.resolveSha(rootPath, String(input.baseSha));
  if (resolvedBase !== String(input.baseSha)) {
    throw new WorktreeError(
      'invalid_base_commit',
      `in-place baseCommit resolved to a different commit: supplied=${String(input.baseSha)} resolved=${resolvedBase}`,
    );
  }

  // (3) The restore point. `undefined` means we could read NEITHER a branch nor
  // a sha — "I could not determine where you were" is never "you were nowhere".
  const restore = await git.headRestorePoint(rootPath);
  if (restore === undefined) {
    throw new WorktreeError(
      'requires_validation',
      `could not read the current HEAD of ${rootPath}, so the in-place exit could not restore it. ` +
        'Refusing to enter a mode whose exit path is already unprovable.',
    );
  }

  // (4) The assignment branch must not already exist: an existing branch is
  // either another assignment's live work or a stale one, and adopting it would
  // make THIS run's commits descend from something it never adjudicated.
  if (await git.branchExists(rootPath, input.branch)) {
    throw new WorktreeError(
      'already_leased',
      `assignment branch ${input.branch} already exists in ${rootPath}. In-place execution creates its own ` +
        'branch at the pinned base; adopting an existing one would build on work this run never adjudicated.',
    );
  }

  const checkpoint: InPlaceCheckpoint = {
    rootPath,
    baseSha: gitSha(resolvedBase),
    headRef: restore.ref,
    headRefKind: restore.kind,
    entryPorcelainDigest: porcelainDigest(status),
    branch: input.branch,
    createdAt: input.clock.nowIso(),
  };

  // (5) DURABLE FIRST, mutate second.
  input.persist(checkpoint);
  await git.createAndCheckoutBranch(rootPath, input.branch, String(checkpoint.baseSha));
  return checkpoint;
}

export type InPlaceRevertOutcome =
  | { readonly kind: 'reverted'; readonly restoredTo: string }
  | {
      readonly kind: 'refused';
      /** Dirty paths this assignment's scope cannot account for. */
      readonly unattributable: readonly string[];
    };

export interface RevertInPlaceInput {
  readonly checkpoint: InPlaceCheckpoint;
  /** The assignment's write scope — the ONLY thing the revert may destroy. */
  readonly boundary: WriteBoundary;
  /** Restore the pre-run HEAD after reverting (default true). */
  readonly restoreHead?: boolean;
}

/**
 * The revert: `reset --hard <baseSha>` + `clean -fd`, then restore the user's
 * HEAD — but ONLY when every dirty path is inside the assignment's write scope.
 *
 * The guard is the whole point. A revert is the one operation in this engine
 * that destroys bytes, and the engine may only destroy what it can PROVE it
 * created. An unattributable path is not a reason to be careful; it is a reason
 * to stop, leave the tree exactly as it is, and hand the operator a list.
 *
 * Note what "attributable" rests on: the paths come from
 * `statusPorcelainPathsExact` (`-z`, unquoted) and are judged by
 * `resolvesInsideRoot` via the boundary. A path we cannot resolve is judged
 * OUTSIDE, so the failure direction is refusal — never a wider deletion.
 */
export async function revertToCheckpoint(input: RevertInPlaceInput): Promise<InPlaceRevertOutcome> {
  const { checkpoint, boundary } = input;
  const root = checkpoint.rootPath;

  const dirty = await git.statusPorcelainPathsExact(root);
  const absolute = dirty.map((relative) => path.resolve(root, relative));
  const unattributable = pathsOutsideBoundary(boundary, absolute);
  if (unattributable.length > 0) {
    return { kind: 'refused', unattributable };
  }

  await git.hardReset(root, String(checkpoint.baseSha));
  // NEVER `-x`: ignored files (`node_modules`) are exactly what makes in-place
  // mode cheap, and they were never this assignment's work to delete.
  await git.cleanUntracked(root);
  if (input.restoreHead !== false) {
    await git.checkoutRef(root, checkpoint.headRef);
  }
  return { kind: 'reverted', restoredTo: checkpoint.headRef };
}

/**
 * Exit on SUCCESS: leave the assignment branch and its commits alone, put the
 * user back on the branch they were on. Never destructive — if the tree is dirty
 * git itself refuses the checkout, which is the correct answer (the dirt is
 * either the verifier's evidence or a human's edit, and neither is ours to drop).
 */
export async function restoreCheckpointHead(checkpoint: InPlaceCheckpoint): Promise<void> {
  await git.checkoutRef(checkpoint.rootPath, checkpoint.headRef);
}
