/**
 * `openDatabase` facade tests (PLAN.md §12.1). Every OTHER test file in this
 * package exercises `openDatabase` only indirectly through
 * `./test-support.ts`'s `openTestDatabase` helper, which always opens
 * read-write — the `readonly: true` option (used by e.g. a future read-only
 * status/inspection surface, §18 `--json` commands that must never mutate
 * state) had no dedicated coverage (P1 verifier punch-list item 3).
 *
 * Verifies: reopening an already-migrated database read-only (a) does NOT
 * re-run migrations (`listAppliedMigrations` only, per ./database.ts's
 * `options.readonly ? listAppliedMigrations(driver) : runMigrations(...)`
 * branch), (b) still permits reads, (c) has writes rejected by SQLite
 * itself — never silently accepted — and (d) fails fast on a database file
 * that doesn't exist yet, rather than silently creating one (SQLite cannot
 * create a new file in read-only mode).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { runId } from '../domain/ids.js';
import { openDatabase, type Database } from './database.js';
import { listAppliedMigrations } from './migrations.js';
import { registerRun } from './runs.js';
import { availableDriverKinds, makeTempDir } from './test-support.js';

const DRIVER_KINDS = await availableDriverKinds();

describe.each(DRIVER_KINDS)('openDatabase({ readonly: true }) (%s)', (kind) => {
  let dir: string | undefined;
  let opened: Database[] = [];

  afterEach(() => {
    for (const db of opened) db.close();
    opened = [];
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('reopens an already-migrated database read-only: migrations are listed (not re-run), reads succeed, writes are rejected', async () => {
    dir = makeTempDir();
    const filename = path.join(dir, 'test.db');
    const casRoot = path.join(dir, 'artifacts');
    const clock = new ManualClock('2026-07-18T00:00:00.000Z');
    const probeRun = runId('run_ro_probe');

    const rw = await openDatabase({ filename, driver: kind, clock, casRoot });
    opened.push(rw);
    const originallyApplied = rw.appliedMigrations;
    expect(originallyApplied.length).toBeGreaterThan(0);
    registerRun(rw.driver, rw.clock, probeRun);

    const ro = await openDatabase({ filename, driver: kind, clock, casRoot, readonly: true });
    opened.push(ro);

    // Migrations were LISTED, not re-applied: identical ids/names/timestamps
    // to what the read-write open already recorded.
    expect(ro.appliedMigrations).toEqual(originallyApplied);
    expect(listAppliedMigrations(ro.driver)).toEqual(originallyApplied);

    // Reads work fine on the read-only connection.
    expect(ro.events.listByRun(probeRun)).toEqual([]);

    // Writes are rejected by SQLite itself — never silently accepted.
    expect(() => registerRun(ro.driver, ro.clock, runId('run_should_fail'))).toThrow(/readonly|read-only/i);
  });

  it('fails fast opening a NONEXISTENT file read-only, rather than silently creating one', async () => {
    dir = makeTempDir();
    const filename = path.join(dir, 'does-not-exist.db');
    await expect(
      openDatabase({ filename, driver: kind, casRoot: path.join(dir, 'artifacts'), readonly: true }),
    ).rejects.toThrow();
  });
});
