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
import type { RunId } from '../domain/ids.js';
import type { SqlDriver } from './driver.js';

export function registerRun(driver: SqlDriver, clock: Clock, runId: RunId): void {
  driver
    .prepare('INSERT OR IGNORE INTO runs (run_id, first_seen_at) VALUES (?, ?)')
    .run([runId, clock.nowIso()]);
}
