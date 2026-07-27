/**
 * Minimal run registry backing the `foreign_keys` pragma (PLAN.md §12.1:
 * "WAL; foreign keys; busy timeout..."). Every table that carries a
 * `run_id` column declares `REFERENCES runs(run_id)`, and `foreign_keys` is
 * turned ON (see ./database.ts), so the constraint is actually ENFORCED,
 * not just a pragma flipped with nothing behind it. Repositories call
 * `registerRun` before their first write for a given run id so normal
 * usage never trips the constraint.
 */
import type { Clock } from '../lib/clock.js';
import { runId, type RunId } from '../domain/ids.js';
import type { IsoTimestamp } from '../lib/clock.js';
import type { SqlDriver } from './driver.js';

/**
 * Reserved RunId-shaped scopes used by cross-run durable stores. They share
 * the `runs` FK registry, but they are infrastructure records rather than
 * operator-created runs and must never appear in Fleet.
 */
export const RESERVED_RUN_SCOPES = [
  'run__process_registry',
  'run__desired_model',
  'run__run_ownership',
  'run__spawn_reservations',
  'run__failover_incident',
] as const;

export interface RegisteredRun {
  readonly runId: RunId;
  readonly firstSeenAt: IsoTimestamp;
}

export function registerRun(driver: SqlDriver, clock: Clock, runId: RunId): void {
  driver
    .prepare('INSERT OR IGNORE INTO runs (run_id, first_seen_at) VALUES (?, ?)')
    .run([runId, clock.nowIso()]);
}

/**
 * Enumerate real user runs, newest first.
 *
 * `runs` is an FK registry, not by itself a user-run table. Requiring the
 * immutable `run_meta` projection excludes every infrastructure scope and any
 * partially-created registry row. The explicit reserved-scope filter is kept
 * as defense in depth: a corrupt or hand-written projection cannot promote an
 * infrastructure scope into Fleet.
 */
export function listRuns(driver: SqlDriver): readonly RegisteredRun[] {
  const reservedPlaceholders = RESERVED_RUN_SCOPES.map(() => '?').join(', ');
  const rows = driver
    .prepare(
      `
        SELECT r.run_id, r.first_seen_at
        FROM runs AS r
        INNER JOIN run_projections AS p
          ON p.run_id = r.run_id AND p.projection_name = 'run_meta'
        WHERE r.run_id NOT IN (${reservedPlaceholders})
        ORDER BY r.first_seen_at DESC, r.run_id ASC
      `,
    )
    .all<{ run_id: string; first_seen_at: string }>([...RESERVED_RUN_SCOPES]);
  return rows.map((row) => ({
    runId: runId(row.run_id),
    firstSeenAt: row.first_seen_at as IsoTimestamp,
  }));
}
