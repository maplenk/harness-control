/**
 * Shared test scaffolding for the persistence contract tests. NOT a test
 * file itself (no top-level `describe`/`it`) — vitest's default include
 * pattern only picks up `*.test.ts`, so this module is safe to import from
 * every `*.test.ts` file in this package without being run as its own
 * (empty) suite.
 *
 * §3 / §21 D6: "the same contract tests run against `node:sqlite` to keep
 * the swap live." `availableDriverKinds()` is how every test file in this
 * package decides which drivers to parameterize over — `better-sqlite3`
 * always, `node:sqlite` only when the runtime actually has it (soft skip,
 * never a hard failure, per PLAN §3's note that it's experimental).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ManualClock, type Clock } from '../lib/clock.js';
import { openDatabase, type Database, type DriverKind, type OpenDatabaseOptions } from './database.js';
import { isNodeSqliteAvailable } from './drivers/index.js';

let cachedNodeSqlite: boolean | undefined;

export async function availableDriverKinds(): Promise<readonly DriverKind[]> {
  if (cachedNodeSqlite === undefined) {
    cachedNodeSqlite = await isNodeSqliteAvailable();
  }
  return cachedNodeSqlite ? (['better-sqlite3', 'node:sqlite'] as const) : (['better-sqlite3'] as const);
}

export function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'harness-persistence-'));
}

export interface OpenTestDatabaseOptions {
  readonly kind: DriverKind;
  /** File-based (default) is needed for WAL/restart tests; `false` uses `:memory:` for fast isolated unit tests. */
  readonly file?: boolean;
  readonly clock?: Clock;
  readonly quotas?: OpenDatabaseOptions['quotas'];
  readonly busyTimeoutMs?: number;
}

export interface TestDatabaseHandle {
  readonly db: Database;
  readonly dir: string;
  readonly filename: string;
  readonly casRoot: string;
  close(): void;
  cleanup(): void;
}

export async function openTestDatabase(options: OpenTestDatabaseOptions): Promise<TestDatabaseHandle> {
  const dir = makeTempDir();
  const filename = options.file === false ? ':memory:' : path.join(dir, 'test.db');
  const casRoot = path.join(dir, 'artifacts');
  const clock = options.clock ?? new ManualClock('2026-07-18T00:00:00.000Z');
  const db = await openDatabase({
    filename,
    driver: options.kind,
    clock,
    casRoot,
    ...(options.quotas !== undefined ? { quotas: options.quotas } : {}),
    ...(options.busyTimeoutMs !== undefined ? { busyTimeoutMs: options.busyTimeoutMs } : {}),
  });
  return {
    db,
    dir,
    filename,
    casRoot,
    close: (): void => db.close(),
    cleanup: (): void => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
    },
  };
}
