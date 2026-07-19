/**
 * W4-2 STAGE 1 / review-6 F2 — DurableRunOwnershipStore.acquire is an EXCLUSIVE
 * compare-and-swap (attack-e), not last-writer-wins.
 *
 * The CAS runs inside ONE `BEGIN IMMEDIATE` transaction (the same shape as the
 * W3-5a count-and-reserve), so two concurrent reclaimers of the SAME crashed run
 * serialize on the write lock: the first commits its claim, the second observes
 * it and LOSES (gets `false`). Parameterized over every available SQLite driver
 * — the exclusivity must hold on BOTH, exactly like the count-and-reserve.
 *
 * FAILS without the fix: the old `acquire` was last-writer-wins returning `void`
 * — every caller "won", so the "exactly one winner" assertion could never hold
 * (two reclaimers both silently overwrote → a double-drive).
 */
import { describe, expect, it, afterEach } from 'vitest';
import { runId as makeRunId } from '../domain/ids.js';
import { openTestDatabase, availableDriverKinds, type TestDatabaseHandle } from '../persistence/test-support.js';
import { DurableRunOwnershipStore, type RunOwnershipRecord } from './run-ownership-store.js';

const DRIVER_KINDS = await availableDriverKinds();

const RUN = makeRunId('run_cas_target');

function record(ownerPid: number, extra?: Partial<RunOwnershipRecord>): RunOwnershipRecord {
  return {
    runId: String(RUN),
    ownerPid,
    ownerStartedAt: `lstart-${ownerPid}`,
    acquiredAt: '2026-07-19T00:00:00.000Z',
    ...extra,
  };
}

describe.each(DRIVER_KINDS)('DurableRunOwnershipStore CAS acquire (%s)', (kind) => {
  let handle: TestDatabaseHandle | undefined;
  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  async function openStore(): Promise<DurableRunOwnershipStore> {
    handle = await openTestDatabase({ kind, file: true });
    return new DurableRunOwnershipStore(handle.db);
  }

  it('two reclaimers of one CRASHED run → EXACTLY ONE wins; the loser gets false and the winner keeps the lease', async () => {
    const store = await openStore();
    const CRASHED = 40_000; // the since-dead owner whose stale lease is on disk
    const A = 41_000;
    const B = 42_000;
    // Both reclaimers are alive; the crashed owner is NOT.
    const alive = new Set([A, B]);
    const isOwnerLive = (existing: RunOwnershipRecord): boolean => alive.has(existing.ownerPid);

    // Seed the crashed owner's stale lease.
    expect(store.acquire(record(CRASHED), () => false)).toBe(true);

    // Two reclaimers race. In single-threaded JS the `transactionImmediate`s run
    // back-to-back, which is exactly the serialized order the write lock imposes
    // across processes: the FIRST reclaims the dead lease, the SECOND then sees a
    // LIVE owner (the first) and is refused.
    const wonA = store.acquire(record(A), isOwnerLive);
    const wonB = store.acquire(record(B), isOwnerLive);

    expect([wonA, wonB].filter(Boolean)).toHaveLength(1); // exactly one winner
    expect(wonA).toBe(true);
    expect(wonB).toBe(false); // loser withholds — no double-drive
    // The winner's lease is what persisted (the loser never overwrote it).
    expect(store.list()).toEqual([record(A)]);
  });

  it('accepts when the run is UNCLAIMED', async () => {
    const store = await openStore();
    expect(store.acquire(record(1234), () => true)).toBe(true);
    expect(store.list()).toEqual([record(1234)]);
  });

  it('REJECTS a claim while a LIVE peer owns the run (lease untouched)', async () => {
    const store = await openStore();
    expect(store.acquire(record(50_000), () => false)).toBe(true); // peer seeds
    // A different process tries to claim while the peer is provably alive.
    expect(store.acquire(record(51_000), () => true)).toBe(false);
    expect(store.list()).toEqual([record(50_000)]); // peer's lease intact
  });

  it('idempotent SELF re-acquire always ACCEPTS (checked before liveness)', async () => {
    const store = await openStore();
    const SELF = 60_000;
    expect(store.acquire(record(SELF), () => true)).toBe(true);
    // Re-acquiring our OWN lease succeeds even though `isOwnerLive` would report
    // the existing (self) owner live — self is matched by pid BEFORE liveness.
    const refreshed = record(SELF, { acquiredAt: '2026-07-19T01:00:00.000Z' });
    expect(store.acquire(refreshed, () => true)).toBe(true);
    expect(store.list()).toEqual([refreshed]);
  });

  it('reclaims a DEAD/recycled owner (liveness false) and overwrites the stale lease', async () => {
    const store = await openStore();
    expect(store.acquire(record(70_000), () => true)).toBe(true); // stale lease on disk
    // The new owner's CAS: the stored owner is provably dead → reclaim.
    const reclaimer = record(71_000);
    expect(store.acquire(reclaimer, () => false)).toBe(true);
    expect(store.list()).toEqual([reclaimer]);
  });
});
