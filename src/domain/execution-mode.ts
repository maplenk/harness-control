/**
 * B3 — WHERE an assignment's implementor works (execution modes spec §2).
 *
 * Two shapes, one vocabulary:
 *  - `worktree` — today's behaviour, unchanged: `git worktree add` at the pinned
 *    base, single-writer lease, F7/F9 provisioning at the verify boundary. The
 *    worktree directory IS the containment root; the primary checkout is never
 *    written.
 *  - `in_place` — the implementor works in the ACTUAL checkout, on an assignment
 *    branch, with a durable START CHECKPOINT as the revert target instead of
 *    filesystem isolation. Provisioning is structurally moot (the checkout
 *    already has `node_modules`), which is the mode's main practical win.
 *
 * WHY THIS LIVES IN `domain/`: the mode is persisted (it is part of a run's
 * durable worktree facts) and it is read by the app layer, the worktree layer
 * and the config layer. One vocabulary, one migration function, no parallel
 * copies of the string literals.
 *
 * ## The read boundary is the migration boundary
 *
 * This is an EVENT-SOURCED store. Every record written before execution modes
 * existed has no mode field at all, and `undefined` there does not mean "no
 * mode" — it means "written when there was only one". `resolveExecutionMode`
 * gives absence its only honest meaning (`worktree`, the status quo) and is the
 * ONLY way any reader is allowed to turn persisted JSON into an `ExecutionMode`.
 * It never throws: a record from the future, or a corrupted one, must not crash
 * a resume — it degrades to the mode that cannot destroy anything (`worktree`
 * writes nothing in the user's checkout), which is also the mode every such
 * record was actually written under.
 */

/** The closed vocabulary. Order is the config-facing order (default first). */
export const EXECUTION_MODES = ['worktree', 'in_place'] as const;

export type ExecutionMode = (typeof EXECUTION_MODES)[number];

/** Today's behaviour, and the value every pre-B3 record resolves to. */
export const DEFAULT_EXECUTION_MODE: ExecutionMode = 'worktree';

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && (EXECUTION_MODES as readonly string[]).includes(value);
}

/**
 * The READ boundary for a persisted execution mode.
 *
 * `undefined` (a record predating B3) and any unrecognised value both resolve to
 * `worktree`. Deliberately total — a reader that throws on an old record turns a
 * resumable run into a stranded one, and this codebase has already paid for that
 * once (`migrateMergeReadinessBlockedState`, F13).
 */
export function resolveExecutionMode(persisted: unknown): ExecutionMode {
  return isExecutionMode(persisted) ? persisted : DEFAULT_EXECUTION_MODE;
}
