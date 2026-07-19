/**
 * Durable desired-model store (W4-2 switch-model, §5t) — set/get/list/clear and
 * last-write-wins per (runId, role), over a real temp SQLite projection layer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runId as toRunId } from '../domain/ids.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { DurableDesiredModelStore, type DesiredModelRecord } from './desired-model-store.js';

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

async function store(): Promise<{ store: DurableDesiredModelStore; db: TestDatabaseHandle['db'] }> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  return { store: new DurableDesiredModelStore(handle.db), db: handle.db };
}

const RUN_A = toRunId('run_a');
const RUN_B = toRunId('run_b');

function record(runId: string, role: DesiredModelRecord['role'], model: string): DesiredModelRecord {
  return { runId, role, harness: 'codex', model, requestedAt: '2026-07-20T00:00:00.000Z' };
}

describe('DurableDesiredModelStore', () => {
  it('set → get round-trips per (runId, role)', async () => {
    const { store: s } = await store();
    s.set(record('run_a', 'implementor', 'gpt-5.6-terra'));
    expect(s.get(RUN_A, 'implementor')).toMatchObject({ role: 'implementor', model: 'gpt-5.6-terra' });
    expect(s.get(RUN_A, 'verifier')).toBeUndefined();
  });

  it('overwrites last-write-wins for the same (runId, role)', async () => {
    const { store: s } = await store();
    s.set(record('run_a', 'implementor', 'gpt-5.6-terra'));
    s.set(record('run_a', 'implementor', 'gpt-5.6-sol'));
    expect(s.get(RUN_A, 'implementor')?.model).toBe('gpt-5.6-sol');
    expect(s.listForRun(RUN_A)).toHaveLength(1);
  });

  it('keeps distinct rows per role and per run', async () => {
    const { store: s } = await store();
    s.set(record('run_a', 'implementor', 'm1'));
    s.set(record('run_a', 'verifier', 'm2'));
    s.set(record('run_b', 'implementor', 'm3'));
    expect(s.listForRun(RUN_A).map((r) => r.model).sort()).toEqual(['m1', 'm2']);
    expect(s.listForRun(RUN_B).map((r) => r.model)).toEqual(['m3']);
    expect(s.list()).toHaveLength(3);
  });

  it('clear removes only the targeted (runId, role)', async () => {
    const { store: s } = await store();
    s.set(record('run_a', 'implementor', 'm1'));
    s.set(record('run_a', 'verifier', 'm2'));
    s.clear(RUN_A, 'implementor');
    expect(s.get(RUN_A, 'implementor')).toBeUndefined();
    expect(s.get(RUN_A, 'verifier')?.model).toBe('m2');
  });

  it('survives being re-opened over the same persisted projection (durable)', async () => {
    const { store: s, db } = await store();
    s.set(record('run_a', 'coordinator', 'opus'));
    // A fresh store instance over the SAME db reads the persisted record.
    expect(new DurableDesiredModelStore(db).get(RUN_A, 'coordinator')?.model).toBe('opus');
  });
});
