/**
 * Scope-visibility rule shared by the store (./store.ts) and the selector
 * (./selector.ts) — PLAN.md §15: `MemoryEntry.scope` is `run | role |
 * project`; `global` is explicitly deferred post-MVP and has no
 * representation here (the exhaustive switch below throws on anything else,
 * which is the only way a `global`-like value could ever reach this code).
 */
import type { MemoryEntry } from '../domain/entities.js';
import type { RunId } from '../domain/ids.js';
import type { RoleName } from '../domain/state.js';

export interface ScopeQuery {
  readonly runId?: RunId;
  readonly role?: RoleName;
}

/**
 * True when `entry` is visible to a requester identified by `query`:
 *  - `project`: always visible — project scope has no run/role boundary.
 *  - `run`: visible only when `query.runId` matches the entry's run.
 *  - `role`: visible only within the same run AND the same role (role-scoped
 *    memory is still run-bound in the MVP — there is no cross-run role
 *    memory; that would be the deferred `global`/bi-temporal design).
 */
export function isVisibleTo(entry: MemoryEntry, query: ScopeQuery): boolean {
  switch (entry.scope) {
    case 'project':
      return true;
    case 'run':
      return query.runId !== undefined && entry.runId === query.runId;
    case 'role':
      return (
        query.runId !== undefined &&
        entry.runId === query.runId &&
        query.role !== undefined &&
        entry.role === query.role
      );
    default: {
      const exhaustive: never = entry.scope;
      throw new Error(`Unknown memory scope: ${String(exhaustive)}`);
    }
  }
}

/**
 * Structural guard for constructing/inserting entries: `run` and `role`
 * scope require the identifiers `isVisibleTo` matches on to actually be
 * present, so a malformed entry fails loudly at insertion rather than
 * silently matching nothing (or everything) later.
 */
export function assertScopeShape(entry: MemoryEntry): void {
  if (entry.scope === 'run' && entry.runId === undefined) {
    throw new Error(`MemoryEntry ${String(entry.id)}: scope 'run' requires runId`);
  }
  if (entry.scope === 'role' && (entry.runId === undefined || entry.role === undefined)) {
    throw new Error(`MemoryEntry ${String(entry.id)}: scope 'role' requires runId and role`);
  }
}
