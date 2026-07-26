/**
 * Migration runner + schema (PLAN.md §12.1: "migration table").
 *
 * `MIGRATIONS` is a plain, append-only, numbered list — never edit a
 * migration once it has shipped; add a new one. `runMigrations` creates
 * `schema_migrations` if missing, then applies every migration whose id
 * isn't already recorded there, each inside its own transaction (schema
 * change + the ledger row commit together, so a crash mid-migration never
 * leaves a migration half-applied-but-unrecorded or recorded-but-not-run).
 */
import type { Clock, IsoTimestamp } from '../lib/clock.js';
import type { SqlDriver } from './driver.js';

export interface Migration {
  readonly id: number;
  readonly name: string;
  readonly up: (driver: SqlDriver) => void;
}

export interface AppliedMigration {
  readonly id: number;
  readonly name: string;
  readonly appliedAt: IsoTimestamp;
}

/**
 * Schema notes:
 *  - `runs` is the FK parent every `run_id` column references (see
 *    ./runs.ts); `ON DELETE CASCADE` makes a future "purge run data" GC
 *    pass a single `DELETE FROM runs WHERE run_id = ?`.
 *  - `events`: append-only log. `UNIQUE(run_id, sequence)` is the monotonic
 *    per-run ordering; `UNIQUE(run_id, idempotency_key)` is what makes a
 *    duplicate append a no-op (§19 test 9) instead of a second row.
 *  - `run_sequence_counters`: O(1) "next sequence for this run" instead of
 *    `MAX(sequence)` per append.
 *  - `run_projections`: generic named-projection store, keyed by
 *    (run_id, projection_name), holding an opaque JSON state blob plus the
 *    event sequence it was last folded through (`event_cursor`) — the
 *    watermark `recover()` (./projection-repository.ts) uses to replay only
 *    what it's missing (§19 test 10, §12.3).
 *  - `artifacts`: content-addressed metadata only; bytes live in the CAS
 *    directory (§12.1: "SQLite keeps metadata + bounded previews"). Primary
 *    key is the hash ALONE (not per-run) — identical bytes are one row
 *    regardless of how many runs reference them, so a dedup hit never
 *    double-charges any quota (§19 test 31).
 *  - `artifact_admission_rejections`: audit trail for quota rejections.
 *    `events.ts` (owned by the domain layer) has no artifact-quota event
 *    type yet, so this ships as its own append-only table carrying the same
 *    fields a `artifact.admission.rejected` event would — see
 *    ./artifact-repository.ts for the full rationale.
 *  - `raw_process_samples` / `process_sample_aggregates`: the §14 watchdog
 *    writes raw RSS ticks; `aggregateWindow` (./telemetry-repository.ts)
 *    folds a window into one `process_sample_aggregates` row (the
 *    `ProcessSample` projection from `../domain/entities.ts`) and PRUNES the
 *    raw rows it just folded, bounding raw storage (§12.1, §19 test 31).
 *  - `operations`: durable command operation records (§3A.2). Lifecycle
 *    accepted → claimed → running → terminal, with UNIQUE(actor,
 *    idempotency_key) so a retried command is idempotent rather than
 *    duplicated. `run_id` is nullable until a `start` binds a run. Owner /
 *    lease / heartbeat columns support reclaim of claimed|running rows
 *    whose lease lapsed. The versioned command payload (`command_version` +
 *    `command_json` + `command_hash`) is the re-drive input for a start that
 *    never bound a run.
 */
const MIGRATION_1_INIT = `
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (run_id, sequence),
  UNIQUE (run_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_events_run_sequence ON events (run_id, sequence);

CREATE TABLE IF NOT EXISTS run_sequence_counters (
  run_id TEXT PRIMARY KEY REFERENCES runs(run_id) ON DELETE CASCADE,
  next_sequence INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS run_projections (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  projection_name TEXT NOT NULL,
  state_json TEXT NOT NULL,
  event_cursor INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, projection_name)
);

CREATE TABLE IF NOT EXISTS artifacts (
  hash TEXT PRIMARY KEY,
  run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  redacted INTEGER NOT NULL,
  preview TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts (run_id);

CREATE TABLE IF NOT EXISTS artifact_admission_rejections (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
  attempted_hash TEXT NOT NULL,
  attempted_size_bytes INTEGER NOT NULL,
  scope TEXT NOT NULL,
  limit_bytes INTEGER NOT NULL,
  current_usage_bytes INTEGER NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admission_rejections_run ON artifact_admission_rejections (run_id);

CREATE TABLE IF NOT EXISTS raw_process_samples (
  row_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  segment_id TEXT,
  process_generation_id TEXT,
  sampled_at TEXT NOT NULL,
  rss_bytes INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_raw_samples_run_time ON raw_process_samples (run_id, sampled_at);

CREATE TABLE IF NOT EXISTS process_sample_aggregates (
  run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  segment_key TEXT NOT NULL,
  segment_id TEXT,
  process_generation_id TEXT,
  window_start TEXT NOT NULL,
  window_seconds INTEGER NOT NULL,
  rss_max_bytes INTEGER NOT NULL,
  rss_mean_bytes REAL NOT NULL,
  sample_count INTEGER NOT NULL,
  PRIMARY KEY (run_id, segment_key, window_start)
);
`;

const MIGRATION_2_OPERATIONS = `
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  origin TEXT NOT NULL,
  kind TEXT NOT NULL,
  command_version INTEGER NOT NULL,
  command_json TEXT NOT NULL,
  command_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  run_id TEXT REFERENCES runs(run_id) ON DELETE CASCADE,
  owner_pid INTEGER,
  owner_started_at TEXT,
  lease_expires_at TEXT,
  heartbeat_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  result_json TEXT,
  error_json TEXT,
  accepted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_at TEXT,
  UNIQUE (actor, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_operations_state ON operations (state);
CREATE INDEX IF NOT EXISTS idx_operations_run ON operations (run_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: 'init',
    up: (driver) => driver.exec(MIGRATION_1_INIT),
  },
  {
    id: 2,
    name: 'operations',
    up: (driver) => driver.exec(MIGRATION_2_OPERATIONS),
  },
];

export function runMigrations(driver: SqlDriver, clock: Clock): readonly AppliedMigration[] {
  driver.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const already = new Set(
    driver.prepare('SELECT id FROM schema_migrations').all<{ id: number }>().map((row) => row.id),
  );
  const applied: AppliedMigration[] = [];
  for (const migration of MIGRATIONS) {
    if (already.has(migration.id)) continue;
    const appliedAt = clock.nowIso();
    driver.transaction(() => {
      migration.up(driver);
      driver
        .prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run([migration.id, migration.name, appliedAt]);
    });
    applied.push({ id: migration.id, name: migration.name, appliedAt });
  }
  return applied;
}

export function listAppliedMigrations(driver: SqlDriver): readonly AppliedMigration[] {
  return driver
    .prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id ASC')
    .all<{ id: number; name: string; applied_at: string }>()
    .map((row) => ({ id: row.id, name: row.name, appliedAt: row.applied_at as IsoTimestamp }));
}
