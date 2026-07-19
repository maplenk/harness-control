/**
 * Driver factory (PLAN.md §3, §21 D6). `openDriver` is the ONE place that
 * knows how to construct either concrete engine; everything above it in
 * this package (repositories, migrations, `Database`) depends only on
 * `SqlDriver` (../driver.js).
 */
import type { DriverKind, SqlDriver } from '../driver.js';
import { BetterSqlite3Driver } from './better-sqlite3-driver.js';

export interface OpenDriverOptions {
  readonly kind?: DriverKind;
  readonly filename: string;
  readonly readonly?: boolean;
}

/**
 * Feature-detects `node:sqlite` without throwing (§3: experimental on Node
 * 22.14 — present but warns; some builds/older Node patch versions may lack
 * it entirely). Safe to call repeatedly; the dynamic import is cached by
 * the module loader after the first call.
 */
export async function isNodeSqliteAvailable(): Promise<boolean> {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/**
 * Constructs the requested driver. `kind` defaults to `'better-sqlite3'`
 * (§21 D6 default). Requesting `'node:sqlite'` on a runtime without it
 * throws — callers that want a soft skip (contract tests) should check
 * `isNodeSqliteAvailable()` first.
 */
export async function openDriver(options: OpenDriverOptions): Promise<SqlDriver> {
  const kind = options.kind ?? 'better-sqlite3';
  const driverOptions = {
    filename: options.filename,
    ...(options.readonly !== undefined ? { readonly: options.readonly } : {}),
  };
  if (kind === 'better-sqlite3') {
    return new BetterSqlite3Driver(driverOptions);
  }
  const { NodeSqliteDriver } = await import('./node-sqlite-driver.js');
  return new NodeSqliteDriver(driverOptions);
}

export { BetterSqlite3Driver } from './better-sqlite3-driver.js';
export type { BetterSqlite3DriverOptions } from './better-sqlite3-driver.js';
