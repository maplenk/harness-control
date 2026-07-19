/**
 * `Database` facade (PLAN.md §12.1): wires ONE driver connection ("one
 * logical writer") through migrations and all repositories. This is the
 * package's main entry point — application code should call `openDatabase`
 * rather than constructing drivers/repositories individually.
 */
import { SystemClock, type Clock } from '../lib/clock.js';
import type { DriverKind, SqlDriver } from './driver.js';
import { openDriver } from './drivers/index.js';
import { runMigrations, listAppliedMigrations, type AppliedMigration } from './migrations.js';
import { SqliteEventRepository, type EventRepository } from './event-repository.js';
import { SqliteProjectionRepository, type ProjectionRepository } from './projection-repository.js';
import {
  DEFAULT_QUOTAS,
  SqliteArtifactRepository,
  type ArtifactRepository,
  type QuotaConfig,
} from './artifact-repository.js';
import { SqliteProcessSampleRepository, type ProcessSampleRepository } from './telemetry-repository.js';

export interface Database {
  readonly driver: SqlDriver;
  readonly clock: Clock;
  readonly events: EventRepository;
  readonly projections: ProjectionRepository;
  readonly artifacts: ArtifactRepository;
  readonly telemetry: ProcessSampleRepository;
  readonly appliedMigrations: readonly AppliedMigration[];
  /** Delegates to the underlying driver — see `SqlDriver.transaction`. */
  transaction<T>(fn: () => T): T;
  /** Delegates to the underlying driver — see `SqlDriver.transactionImmediate`. */
  transactionImmediate<T>(fn: () => T): T;
  close(): void;
}

export interface OpenDatabaseOptions {
  /** `:memory:` or a filesystem path. WAL requires a real file (§3, §12.1). */
  readonly filename: string;
  /** Defaults to `'better-sqlite3'` (§21 D6). */
  readonly driver?: DriverKind;
  readonly readonly?: boolean;
  readonly busyTimeoutMs?: number;
  readonly clock?: Clock;
  readonly quotas?: QuotaConfig;
  /**
   * Root directory for content-addressed artifact bytes. Required, not
   * defaulted: this package never invents filesystem paths on the
   * caller's behalf (mirrors the "inject clock/id providers" determinism
   * rule — no implicit environment-derived state).
   */
  readonly casRoot: string;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export async function openDatabase(options: OpenDatabaseOptions): Promise<Database> {
  const clock = options.clock ?? new SystemClock();
  const driver = await openDriver({
    filename: options.filename,
    ...(options.driver !== undefined ? { kind: options.driver } : {}),
    ...(options.readonly !== undefined ? { readonly: options.readonly } : {}),
  });

  // §12.1 normative: WAL; foreign keys; busy timeout.
  driver.setPragma('journal_mode', 'WAL');
  driver.setPragma('foreign_keys', 'ON');
  driver.setPragma('busy_timeout', options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS);

  const appliedMigrations = options.readonly
    ? listAppliedMigrations(driver)
    : runMigrations(driver, clock);

  const events = new SqliteEventRepository(driver, clock);
  const projections = new SqliteProjectionRepository(driver, clock, events);
  const artifacts = new SqliteArtifactRepository(
    driver,
    clock,
    options.casRoot,
    events,
    options.quotas ?? DEFAULT_QUOTAS,
  );
  const telemetry = new SqliteProcessSampleRepository(driver, clock);

  return {
    driver,
    clock,
    events,
    projections,
    artifacts,
    telemetry,
    appliedMigrations,
    transaction: <T>(fn: () => T): T => driver.transaction(fn),
    transactionImmediate: <T>(fn: () => T): T => driver.transactionImmediate(fn),
    close: (): void => driver.close(),
  };
}

export { isNodeSqliteAvailable } from './drivers/index.js';
export type { DriverKind } from './driver.js';
