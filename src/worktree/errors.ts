/**
 * Typed error taxonomy for the git worktree manager (PLAN.md §16).
 * Mirrors `src/adapters/spi.ts`'s `AdapterError` shape: a closed `kind`
 * enum, never a bare `Error`/string throw, so callers can branch on
 * `.kind` instead of parsing messages.
 */

export const WORKTREE_ERROR_KINDS = [
  /** `primaryRepoRoot` is not inside a git working tree (§16 item 1). */
  'not_a_git_repo',
  /** A `git` subprocess exited non-zero; `.detail` carries stdout+stderr. */
  'git_command_failed',
  /** A fresh worktree was not bound to an exact, full, resolvable commit SHA. */
  'invalid_base_commit',
  /** `createWorktree`/`reacquireLease`/`reattach` for an assignment that already holds an active lease. */
  'already_leased',
  /** The target worktree path is already leased by a DIFFERENT assignment. */
  'path_already_leased',
  /** No tracked handle/lease exists for the given assignment in this manager instance. */
  'not_found',
  /**
   * `reacquireLease`/`reattach` refused: the worktree is tainted and has
   * not been cleared by a `validate()` pass since (§16.3: "before any
   * restart or verification").
   */
  'requires_validation',
  /** A resolved path landed outside the manager's configured base dir / inside the primary checkout (safety guard). */
  'unsafe_path',
] as const;

export type WorktreeErrorKind = (typeof WORKTREE_ERROR_KINDS)[number];

export interface WorktreeErrorOptions {
  readonly cause?: unknown;
  /** Extra machine-oriented detail (e.g. raw git stdout+stderr). */
  readonly detail?: string;
}

export class WorktreeError extends Error {
  override readonly name: string = 'WorktreeError';
  readonly kind: WorktreeErrorKind;
  readonly detail?: string;

  constructor(kind: WorktreeErrorKind, message: string, options: WorktreeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.kind = kind;
    if (options.detail !== undefined) this.detail = options.detail;
  }
}

export function isWorktreeError(value: unknown): value is WorktreeError {
  return value instanceof WorktreeError;
}
