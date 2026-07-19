/**
 * Alternate driver (PLAN.md §3, §21 D6): `node:sqlite` behind the SAME
 * `SqlDriver` interface as the default `better-sqlite3` driver, "to keep
 * the swap live." Node 22.14 reports this module `ExperimentalWarning` —
 * expected and harmless; callers that want to avoid a hard crash on Node
 * builds without `node:sqlite` should feature-detect via a dynamic
 * `import('node:sqlite')` before constructing this driver (see
 * `../test-support.ts` for the pattern the contract tests use).
 *
 * `node:sqlite`'s `DatabaseSync`/`StatementSync` have no `.pragma()` sugar
 * and no built-in `.transaction()` helper (unlike better-sqlite3), so both
 * are implemented here directly on top of `exec`/`prepare`.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import type { PreparedStatement, RunResult, SqlDriver, SqlParam } from '../driver.js';

export interface NodeSqliteDriverOptions {
  readonly filename: string;
  readonly readonly?: boolean;
}

export class NodeSqliteDriver implements SqlDriver {
  readonly kind = 'node:sqlite' as const;
  readonly #db: DatabaseSync;
  readonly #statementCache = new Map<string, StatementSync>();
  #inTransaction = false;
  #closed = false;

  constructor(options: NodeSqliteDriverOptions) {
    this.#db = new DatabaseSync(options.filename, { readOnly: options.readonly ?? false });
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  #native(sql: string): StatementSync {
    let stmt = this.#statementCache.get(sql);
    if (!stmt) {
      stmt = this.#db.prepare(sql);
      this.#statementCache.set(sql, stmt);
    }
    return stmt;
  }

  prepare(sql: string): PreparedStatement {
    const stmt = this.#native(sql);
    return {
      run: (params: readonly SqlParam[] = []): RunResult => {
        const result = stmt.run(...(params as (string | number | bigint | null | Uint8Array)[]));
        return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
      },
      get: <T,>(params: readonly SqlParam[] = []): T | undefined =>
        stmt.get(...(params as (string | number | bigint | null | Uint8Array)[])) as T | undefined,
      all: <T,>(params: readonly SqlParam[] = []): T[] =>
        stmt.all(...(params as (string | number | bigint | null | Uint8Array)[])) as T[],
    };
  }

  setPragma(name: string, value: string | number): void {
    this.#db.exec(`PRAGMA ${name} = ${value}`);
  }

  getPragma<T>(name: string): T | undefined {
    const row = this.#db.prepare(`PRAGMA ${name}`).get();
    if (row === undefined) return undefined;
    // Pragma result column names don't always match the pragma name (e.g.
    // `busy_timeout` reads back as column `timeout`) — take the first value
    // positionally, mirroring better-sqlite3's `{ simple: true }` mode.
    const values = Object.values(row as Record<string, unknown>);
    return values[0] as T | undefined;
  }

  transaction<T>(fn: () => T): T {
    return this.#runTransaction('BEGIN', fn);
  }

  transactionImmediate<T>(fn: () => T): T {
    // `BEGIN IMMEDIATE` takes the write lock up front so a second connection's
    // immediate begin blocks (up to busy_timeout) until this one commits —
    // the cross-process serialization W3-5 admission needs.
    return this.#runTransaction('BEGIN IMMEDIATE', fn);
  }

  #runTransaction<T>(begin: 'BEGIN' | 'BEGIN IMMEDIATE', fn: () => T): T {
    if (this.#inTransaction) {
      // Both drivers are single-connection/synchronous; nested calls share
      // the outer transaction rather than nesting BEGIN statements.
      return fn();
    }
    this.#db.exec(begin);
    this.#inTransaction = true;
    try {
      const result = fn();
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.#db.exec('ROLLBACK');
      } catch {
        // Best-effort: if rollback itself fails the connection is already
        // broken: surface the ORIGINAL error, not the rollback failure.
      }
      throw error;
    } finally {
      this.#inTransaction = false;
    }
  }

  close(): void {
    // Idempotent by construction (unlike `DatabaseSync.close()`, which
    // throws "database is not open" on a repeat call) — a caller closing
    // twice (e.g. an explicit mid-flow close followed by cleanup-on-exit)
    // should never crash the process.
    if (this.#closed) return;
    this.#closed = true;
    this.#statementCache.clear();
    this.#db.close();
  }
}
