/**
 * Default driver (PLAN.md §3, §21 D6): `better-sqlite3` behind `SqlDriver`.
 */
import BetterSqlite3, { type Database as NativeDb, type Statement as NativeStmt } from 'better-sqlite3';
import type { PreparedStatement, RunResult, SqlDriver, SqlParam } from '../driver.js';

export interface BetterSqlite3DriverOptions {
  readonly filename: string;
  readonly readonly?: boolean;
}

export class BetterSqlite3Driver implements SqlDriver {
  readonly kind = 'better-sqlite3' as const;
  readonly #db: NativeDb;
  readonly #statementCache = new Map<string, NativeStmt>();
  #closed = false;

  constructor(options: BetterSqlite3DriverOptions) {
    this.#db = new BetterSqlite3(options.filename, { readonly: options.readonly ?? false });
  }

  exec(sql: string): void {
    this.#db.exec(sql);
  }

  #native(sql: string): NativeStmt {
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
      run: (params: readonly SqlParam[] = []): RunResult => stmt.run(...params) as RunResult,
      get: <T,>(params: readonly SqlParam[] = []): T | undefined => stmt.get(...params) as T | undefined,
      all: <T,>(params: readonly SqlParam[] = []): T[] => stmt.all(...params) as T[],
    };
  }

  setPragma(name: string, value: string | number): void {
    this.#db.pragma(`${name} = ${value}`);
  }

  getPragma<T>(name: string): T | undefined {
    return this.#db.pragma(name, { simple: true }) as T | undefined;
  }

  transaction<T>(fn: () => T): T {
    return this.#db.transaction(fn)();
  }

  transactionImmediate<T>(fn: () => T): T {
    // better-sqlite3 exposes BEGIN-mode variants on the wrapped function;
    // `.immediate()` takes the write lock at BEGIN. When called while already
    // inside a transaction better-sqlite3 uses a SAVEPOINT (mode ignored),
    // which is the correct "share the enclosing transaction" behavior.
    return this.#db.transaction(fn).immediate();
  }

  close(): void {
    // Idempotent by construction (see NodeSqliteDriver.close for why this
    // matters even though better-sqlite3 itself tolerates a repeat call).
    if (this.#closed) return;
    this.#closed = true;
    this.#statementCache.clear();
    this.#db.close();
  }
}
