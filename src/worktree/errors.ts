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
  /**
   * F7 (`./provision.ts`): `provisionForVerification` could not PROVE a real,
   * git-ignored `node_modules` for the committed manifests — `node_modules` is
   * not ignored / is tracked (would risk staging deps into a commit), neither
   * clone nor `npm ci` produced a tree, or a provisioned tree held an unsafe
   * (absolute / worktree-escaping) symlink. The caller FAILS CLOSED: no host
   * self-check, no verifier dispatch, no `merge_ready`.
   */
  'provisioning_failed',
  /**
   * MED-8 (`./git.ts`): after staging, `node_modules` paths REMAINED in the index
   * and could not be unstaged, so a harness commit would have carried a
   * provisioned dependency tree. Distinct from `git_command_failed` because no
   * git command failed — the index simply refused to reach a safe state, which is
   * an invariant violation the caller must not retry blindly.
   */
  'node_modules_still_staged',
] as const;

export type WorktreeErrorKind = (typeof WORKTREE_ERROR_KINDS)[number];

/**
 * F9 — WHY provisioning refused, as a machine code rather than prose. Every one
 * of these has a DIFFERENT operator remedy, and the old single generic CLI hint
 * ("ensure node_modules is installed and git-ignored") sent the two most common
 * cases in circles. The CLI maps each to its own `next:` line; `undefined`
 * (the pre-F9 refusals that keep their prose) falls back to the generic hint.
 */
export const PROVISIONING_CAUSES = [
  /** The worktree's COMMITTED manifests differ from the primary's — the
   * implementor's commit changed dependencies. Deps land via the engine track. */
  'deps_changed_in_worktree',
  /** The PRIMARY's on-disk manifests differ from its own HEAD — uncommitted or
   * unsynced edits there. Commit/sync + `npm install`, then re-run. */
  'primary_manifests_diverged',
  /** Manifests diverged but the classifying probe (the primary's HEAD manifests)
   * could not be read, so neither remedy can be asserted. Fail closed naming both. */
  'manifest_divergence_unclassified',
  /** Fingerprints match, but a manifest-declared package has no directory in the
   * primary's `node_modules` — the primary was never `npm install`ed since the
   * manifests changed. Cloning it would propagate a stale tree (the false clone). */
  'primary_tree_stale',
  /** A staged package that declares a native build step could not be `require`d —
   * the tree is present but UNBUILT. Raised BEFORE the marker write, so an
   * unproven tree can never become sticky. */
  'native_toolchain_unproven',
  /** A cloned tree held an absolute / worktree-escaping symlink. Refused outright:
   * `auto` and `clone` are both clone-or-fail; there is no install lane to fall to. */
  'unsafe_clone_symlinks',
  /** `provision:'install'` was requested. The lane is gone — script-less installs
   * cannot prove native toolchains. */
  'install_provisioning_removed',
  /** Clone is the only lane and this host cannot copy-on-write clone. */
  'clone_unsupported',
  /** The clone itself failed (cross-volume stage, FS error). */
  'clone_failed',
  /** A provisioning command/probe exceeded its deadline; refused with the mutex
   * and advisory lease released. */
  'provisioning_timeout',
] as const;

export type ProvisioningCause = (typeof PROVISIONING_CAUSES)[number];

export interface WorktreeErrorOptions {
  readonly cause?: unknown;
  /** Extra machine-oriented detail (e.g. raw git stdout+stderr). */
  readonly detail?: string;
  /** F9: the machine-readable provisioning cause (`provisioning_failed` only). */
  readonly provisioningCause?: ProvisioningCause;
}

export class WorktreeError extends Error {
  override readonly name: string = 'WorktreeError';
  readonly kind: WorktreeErrorKind;
  readonly detail?: string;
  /**
   * F9: the machine-readable refusal cause for `provisioning_failed`. Named
   * `provisioningCause` on the OPTIONS bag and exposed here as `cause` would
   * collide with `Error.cause`, so it keeps the explicit name at both ends.
   */
  readonly provisioningCause?: ProvisioningCause;

  constructor(kind: WorktreeErrorKind, message: string, options: WorktreeErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.kind = kind;
    if (options.detail !== undefined) this.detail = options.detail;
    if (options.provisioningCause !== undefined) this.provisioningCause = options.provisioningCause;
  }
}

export function isWorktreeError(value: unknown): value is WorktreeError {
  return value instanceof WorktreeError;
}
