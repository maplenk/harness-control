import { afterEach, describe, expect, it } from 'vitest';
import { runId } from '../domain/ids.js';
import { openTestDatabase, type TestDatabaseHandle } from './test-support.js';
import { listRuns, registerRun, RESERVED_RUN_SCOPES } from './runs.js';

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

describe('listRuns', () => {
  it('returns only registry rows with real run metadata', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const { db } = handle;
    const real = runId('run_real');
    const orphan = runId('run_orphan');
    const reserved = runId(RESERVED_RUN_SCOPES[0]);

    registerRun(db.driver, db.clock, real);
    registerRun(db.driver, db.clock, orphan);
    registerRun(db.driver, db.clock, reserved);
    db.projections.save(real, 'run_meta', { goal: 'real' });
    // Defense in depth: even a reserved scope carrying forged metadata is not a
    // user run.
    db.projections.save(reserved, 'run_meta', { goal: 'not a run' });

    expect(listRuns(db.driver).map((entry) => String(entry.runId))).toEqual(['run_real']);
  });
});
