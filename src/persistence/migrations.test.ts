/**
 * §12.1: "migration table." Parameterized over every available driver.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { MIGRATIONS, listAppliedMigrations, runMigrations } from './migrations.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';

const DRIVER_KINDS = await availableDriverKinds();

describe.each(DRIVER_KINDS)('migrations (%s)', (kind) => {
  let handle: TestDatabaseHandle | undefined;
  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('applies every migration on first open and records each in schema_migrations', async () => {
    handle = await openTestDatabase({ kind, file: true });
    expect(handle.db.appliedMigrations.map((m) => m.id)).toEqual(MIGRATIONS.map((m) => m.id));
    expect(listAppliedMigrations(handle.db.driver).map((m) => m.id)).toEqual(MIGRATIONS.map((m) => m.id));
  });

  it('is idempotent: re-running against an up-to-date schema applies nothing new', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const before = listAppliedMigrations(handle.db.driver);
    const second = runMigrations(handle.db.driver, new ManualClock('2026-07-19T00:00:00.000Z'));
    expect(second).toEqual([]);
    expect(listAppliedMigrations(handle.db.driver)).toEqual(before);
  });

  it('creates every table the repositories depend on', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const rows = handle.db.driver
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = rows.map((r) => r.name);
    for (const table of [
      'runs',
      'events',
      'run_sequence_counters',
      'run_projections',
      'artifacts',
      'artifact_admission_rejections',
      'raw_process_samples',
      'process_sample_aggregates',
      'schema_migrations',
    ]) {
      expect(names).toContain(table);
    }
  });
});
