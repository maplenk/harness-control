/**
 * §12.1 normative driver properties: "WAL; foreign keys; busy timeout."
 * Parameterized over every available `SqlDriver` implementation (§3, §21
 * D6: "the same contract tests run against `node:sqlite` to keep the swap
 * live").
 */
import { afterEach, describe, expect, it } from 'vitest';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';

const DRIVER_KINDS = await availableDriverKinds();

describe.each(DRIVER_KINDS)('SqlDriver contract (%s)', (kind) => {
  let handle: TestDatabaseHandle | undefined;
  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('reports its own kind', async () => {
    handle = await openTestDatabase({ kind, file: false });
    expect(handle.db.driver.kind).toBe(kind);
  });

  it('opens a file-based database in WAL mode', async () => {
    handle = await openTestDatabase({ kind, file: true });
    expect(handle.db.driver.getPragma<string>('journal_mode')).toBe('wal');
  });

  it('turns foreign_keys ON and actually ENFORCES it (not just a flipped pragma)', async () => {
    handle = await openTestDatabase({ kind, file: true });
    expect(Number(handle.db.driver.getPragma<number>('foreign_keys'))).toBe(1);

    // Bypass the repository's auto `registerRun` to insert an event whose
    // run_id was never registered in `runs` — must be rejected by the FK.
    expect(() =>
      handle!.db.driver
        .prepare(
          'INSERT INTO events (run_id, sequence, type, idempotency_key, occurred_at, recorded_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(['never-registered-run', 1, 'x.y', 'k', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '{}']),
    ).toThrow(/foreign key/i);
  });

  it('applies the configured busy_timeout', async () => {
    handle = await openTestDatabase({ kind, file: true, busyTimeoutMs: 1234 });
    expect(Number(handle.db.driver.getPragma<number>('busy_timeout'))).toBe(1234);
  });

  it('defaults busy_timeout to 5000ms when unspecified', async () => {
    handle = await openTestDatabase({ kind, file: true });
    expect(Number(handle.db.driver.getPragma<number>('busy_timeout'))).toBe(5000);
  });

  it('commits a successful transaction', async () => {
    handle = await openTestDatabase({ kind, file: false });
    handle.db.driver.exec('CREATE TABLE t_commit (id INTEGER PRIMARY KEY)');
    handle.db.driver.transaction(() => {
      handle!.db.driver.prepare('INSERT INTO t_commit (id) VALUES (?)').run([1]);
      handle!.db.driver.prepare('INSERT INTO t_commit (id) VALUES (?)').run([2]);
    });
    expect(handle.db.driver.prepare('SELECT * FROM t_commit').all()).toHaveLength(2);
  });

  it('transactionImmediate commits and rolls back on throw (W3-5a atomic count-and-reserve)', async () => {
    handle = await openTestDatabase({ kind, file: false });
    handle.db.driver.exec('CREATE TABLE t_imm (id INTEGER PRIMARY KEY)');
    // Commit path.
    handle.db.driver.transactionImmediate(() => {
      handle!.db.driver.prepare('INSERT INTO t_imm (id) VALUES (?)').run([1]);
    });
    expect(handle.db.driver.prepare('SELECT * FROM t_imm').all()).toEqual([{ id: 1 }]);
    // Rollback path: a throw (the admission refusal) unwinds the reservation.
    expect(() =>
      handle!.db.driver.transactionImmediate(() => {
        handle!.db.driver.prepare('INSERT INTO t_imm (id) VALUES (?)').run([2]);
        throw new Error('refused');
      }),
    ).toThrow('refused');
    expect(handle.db.driver.prepare('SELECT * FROM t_imm').all()).toEqual([{ id: 1 }]);
  });

  it('rolls back the ENTIRE transaction when the callback throws', async () => {
    handle = await openTestDatabase({ kind, file: false });
    handle.db.driver.exec('CREATE TABLE t_rollback (id INTEGER PRIMARY KEY)');
    handle.db.driver.prepare('INSERT INTO t_rollback (id) VALUES (?)').run([1]);

    expect(() =>
      handle!.db.driver.transaction(() => {
        handle!.db.driver.prepare('INSERT INTO t_rollback (id) VALUES (?)').run([2]);
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // Only the pre-transaction row survives; the id=2 insert was rolled back.
    expect(handle.db.driver.prepare('SELECT * FROM t_rollback').all()).toEqual([{ id: 1 }]);
  });

  it('round-trips bound parameters through prepare/run/get/all', async () => {
    handle = await openTestDatabase({ kind, file: false });
    handle.db.driver.exec('CREATE TABLE t_rw (id INTEGER PRIMARY KEY, name TEXT, n INTEGER)');
    handle.db.driver.prepare('INSERT INTO t_rw (id, name, n) VALUES (?, ?, ?)').run([1, 'alpha', 7]);
    expect(handle.db.driver.prepare('SELECT * FROM t_rw WHERE id = ?').get([1])).toEqual({
      id: 1,
      name: 'alpha',
      n: 7,
    });
    expect(handle.db.driver.prepare('SELECT * FROM t_rw').all()).toEqual([{ id: 1, name: 'alpha', n: 7 }]);
  });
});
