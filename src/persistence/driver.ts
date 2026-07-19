/**
 * Driver-agnostic SQL access (PLAN.md §12.1, §3).
 *
 * §3: "SQLite: `node:sqlite` on Node 22.14.0 emits `ExperimentalWarning`
 * (verified locally). Default driver = `better-sqlite3` behind the
 * repository interface; the same contract tests run against `node:sqlite`
 * to keep the swap live." This module is that interface: every repository
 * in this package is written against `SqlDriver`, never against a concrete
 * client library, so the driver can be swapped (see ./drivers/*).
 *
 * Both concrete drivers are SYNCHRONOUS and represent exactly ONE physical
 * connection (no pooling). §12.1's "one logical writer" requirement is
 * satisfied by construction: a `Database` (./database.ts) wraps exactly one
 * driver instance and all repositories share it, so every write from a
 * process is serialized through one connection. Because both drivers are
 * synchronous, `transaction()` is a plain (non-async) function call, and
 * repository methods invoked from inside it automatically share that one
 * transaction — no explicit "tx handle" threading is needed.
 */

export type SqlParam = string | number | bigint | null | Uint8Array;

export interface RunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  run(params?: readonly SqlParam[]): RunResult;
  get<T = Record<string, unknown>>(params?: readonly SqlParam[]): T | undefined;
  all<T = Record<string, unknown>>(params?: readonly SqlParam[]): T[];
}

export type DriverKind = 'better-sqlite3' | 'node:sqlite';

/**
 * Minimal synchronous SQL driver surface each concrete engine adapts to.
 * Deliberately small: raw multi-statement `exec` (DDL/migrations), single-
 * statement `prepare` (DML with bound parameters), pragma get/set, and a
 * synchronous `transaction`. Repository code is written entirely against
 * this interface so it never imports `better-sqlite3` or `node:sqlite`
 * directly (§3, §12.1: "driver behind an interface").
 */
export interface SqlDriver {
  readonly kind: DriverKind;
  /** Raw multi-statement execution (DDL, migrations). No bound parameters. */
  exec(sql: string): void;
  /** Prepares (and caches) a single SQL statement for repeated bound execution. */
  prepare(sql: string): PreparedStatement;
  /** `PRAGMA <name> = <value>` (no readback; some pragmas return an empty result set). */
  setPragma(name: string, value: string | number): void;
  /** `PRAGMA <name>` readback — value of the first column of the first row. */
  getPragma<T = unknown>(name: string): T | undefined;
  /**
   * Runs `fn` inside BEGIN/COMMIT, with ROLLBACK on throw (the thrown error
   * propagates after rollback). Both drivers are synchronous, so nested
   * repository calls made from inside `fn` transparently share this exact
   * transaction — this is how §6.3's "one idempotent event append +
   * projection update in one transaction" rule is implemented.
   */
  transaction<T>(fn: () => T): T;
  /**
   * Like `transaction`, but opens with `BEGIN IMMEDIATE` so the write lock is
   * taken AT THE START rather than lazily on the first write (a default
   * deferred `BEGIN` only upgrades to a write lock when it first writes,
   * which lets two connections both read-then-race the upgrade). Immediate
   * mode makes a count-then-reserve critical section serialize across
   * PROCESSES: a second connection's `BEGIN IMMEDIATE` blocks (up to
   * `busy_timeout`) until the first commits, so it observes the first's
   * write — the atom the W3-5 concurrency admission relies on (§14). Nested
   * calls (already inside a transaction) share the enclosing one, exactly
   * like `transaction`.
   */
  transactionImmediate<T>(fn: () => T): T;
  close(): void;
}
