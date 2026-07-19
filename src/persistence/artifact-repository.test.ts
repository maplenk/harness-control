/**
 * §19 test 31 (part A): "quotas: artifact admission rejection."
 * §12.1: "per-run artifact quota 2GB, global 20GB (admission rejection +
 * event when exceeded)."
 */
import { readdir } from 'node:fs/promises';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isErr, isOk, unwrap } from '../lib/result.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { runId } from '../domain/ids.js';
import { ArtifactStore } from '../artifacts/store.js';
import { DEFAULT_QUOTAS } from './artifact-repository.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';

const DRIVER_KINDS = await availableDriverKinds();
const RUN_A = runId('run_artifact_a');
const RUN_B = runId('run_artifact_b');

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('DEFAULT_QUOTAS', () => {
  it('matches PLAN §12.1 normative defaults: per-run 2GB, global 20GB', () => {
    expect(DEFAULT_QUOTAS.perRunBytes).toBe(2 * 1024 ** 3);
    expect(DEFAULT_QUOTAS.globalBytes).toBe(20 * 1024 ** 3);
  });
});

describe.each(DRIVER_KINDS)('ArtifactRepository (%s) — §19 test 31 quota admission', (kind) => {
  let handle: TestDatabaseHandle | undefined;
  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('admits artifacts within budget, accumulates per-run + global usage, and preserves every field through the write/read round-trip', async () => {
    handle = await openTestDatabase({ kind, file: true, quotas: { perRunBytes: 1000, globalBytes: 1000 } });
    const content = bytesOf('alpha-content');
    const a = handle.db.artifacts.write({ runId: RUN_A, kind: 'diff', bytes: content, redacted: true });
    expect(isOk(a)).toBe(true);
    const written = unwrap(a);
    expect(written).toMatchObject({
      runId: RUN_A,
      kind: 'diff',
      sizeBytes: content.length,
      redacted: true,
      preview: 'alpha-content',
    });
    // Fields are not just correct on the write() return value — a fresh
    // read from storage (separate INSERT-column vs. SELECT-column code
    // paths) must agree exactly, guarding against any column/placeholder
    // misalignment between the two.
    expect(handle.db.artifacts.get(written.hash)).toEqual(written);
    expect(handle.db.artifacts.usedBytesForRun(RUN_A)).toBe(content.length);
    expect(handle.db.artifacts.usedBytesGlobal()).toBe(content.length);
  });

  it('rejects a write that would exceed the PER-RUN quota, writes nothing, and records the rejection', async () => {
    handle = await openTestDatabase({
      kind,
      file: true,
      quotas: { perRunBytes: 300, globalBytes: 1_000_000 },
    });
    const first = handle.db.artifacts.write({ runId: RUN_A, kind: 'evidence', bytes: new Uint8Array(250), redacted: true });
    expect(isOk(first)).toBe(true);

    const second = handle.db.artifacts.write({
      runId: RUN_A,
      kind: 'evidence',
      bytes: new Uint8Array(100).fill(7), // distinct content from `first`
      redacted: true,
    });
    expect(isErr(second)).toBe(true);
    if (isOk(second)) throw new Error('expected rejection');
    expect(second.error).toMatchObject({
      runId: RUN_A,
      scope: 'per_run',
      limitBytes: 300,
      currentUsageBytes: 250,
      attemptedSizeBytes: 100,
    });

    // Usage is unchanged by the rejected attempt.
    expect(handle.db.artifacts.usedBytesForRun(RUN_A)).toBe(250);
    // The rejection is durably recorded.
    const rejections = handle.db.artifacts.listAdmissionRejections(RUN_A);
    expect(rejections).toHaveLength(1);
    expect(rejections[0]).toMatchObject({ scope: 'per_run', attemptedSizeBytes: 100 });

    // Never written to the CAS.
    expect(handle.db.artifacts.get(second.error.attemptedHash)).toBeUndefined();
  });

  it('rejects a write that individually fits the per-run quota but would exceed the GLOBAL quota', async () => {
    handle = await openTestDatabase({
      kind,
      file: true,
      quotas: { perRunBytes: 1_000_000, globalBytes: 900 },
    });
    expect(isOk(handle.db.artifacts.write({ runId: RUN_A, kind: 'diff', bytes: new Uint8Array(500).fill(1), redacted: true }))).toBe(true);
    expect(isOk(handle.db.artifacts.write({ runId: RUN_B, kind: 'diff', bytes: new Uint8Array(350).fill(2), redacted: true }))).toBe(true);
    expect(handle.db.artifacts.usedBytesGlobal()).toBe(850);

    // Fits RUN_B's own (huge) per-run quota easily, but pushes global 850 -> 950 > 900.
    const rejected = handle.db.artifacts.write({
      runId: RUN_B,
      kind: 'diff',
      bytes: new Uint8Array(100).fill(3),
      redacted: true,
    });
    expect(isErr(rejected)).toBe(true);
    if (isOk(rejected)) throw new Error('expected rejection');
    expect(rejected.error).toMatchObject({ scope: 'global', limitBytes: 900, currentUsageBytes: 850 });
    expect(handle.db.artifacts.usedBytesGlobal()).toBe(850); // unchanged
    expect(handle.db.artifacts.listAdmissionRejections(RUN_B)).toHaveLength(1);
    expect(handle.db.artifacts.listAdmissionRejections()).toHaveLength(1); // global listing too
  });

  it('content-addressed dedup: rewriting identical bytes never double-charges any quota, even across runs', async () => {
    handle = await openTestDatabase({ kind, file: true, quotas: { perRunBytes: 1000, globalBytes: 1000 } });
    const bytes = bytesOf('shared exploration artifact contents');

    const first = unwrap(handle.db.artifacts.write({ runId: RUN_A, kind: 'exploration', bytes, redacted: true }));
    expect(handle.db.artifacts.usedBytesForRun(RUN_A)).toBe(bytes.length);
    expect(handle.db.artifacts.usedBytesGlobal()).toBe(bytes.length);

    // Same run, same bytes again: no-op, same hash, usage unchanged.
    const again = unwrap(handle.db.artifacts.write({ runId: RUN_A, kind: 'exploration', bytes, redacted: true }));
    expect(again.hash).toBe(first.hash);
    expect(handle.db.artifacts.usedBytesForRun(RUN_A)).toBe(bytes.length);
    expect(handle.db.artifacts.usedBytesGlobal()).toBe(bytes.length);

    // A DIFFERENT run "writing" the same bytes gets the original record back
    // and is NOT charged — the physical content already exists.
    const fromOtherRun = unwrap(handle.db.artifacts.write({ runId: RUN_B, kind: 'exploration', bytes, redacted: true }));
    expect(fromOtherRun.hash).toBe(first.hash);
    expect(fromOtherRun.runId).toBe(RUN_A); // original owner, unchanged
    expect(handle.db.artifacts.usedBytesForRun(RUN_B)).toBe(0);
    expect(handle.db.artifacts.usedBytesGlobal()).toBe(bytes.length); // still just once
  });

  it('round-trips bytes through the content-addressed store', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const bytes = bytesOf('round trip me');
    const written = unwrap(handle.db.artifacts.write({ runId: RUN_A, kind: 'transcript', bytes, redacted: true }));
    expect(handle.db.artifacts.readBytes(written.hash)).toEqual(bytes);
  });

  it('refuses to persist an artifact explicitly marked NOT redacted (§17.1)', async () => {
    handle = await openTestDatabase({ kind, file: true });
    expect(() =>
      handle!.db.artifacts.write({ runId: RUN_A, kind: 'stderr', bytes: bytesOf('unredacted secret'), redacted: false }),
    ).toThrow(/redact/i);
  });
});

// ---------------------------------------------------------------------------
// P1 verifier punch-list item 1: "UNIFY the two CAS implementations ...
// ONE write path with fsync-before-rename AND quota admission AND redaction
// enforcement." These tests prove the unification directly: bytes written
// through the quota-aware repository are physically readable through the
// plain, quota-agnostic `ArtifactStore` when both point at the same root,
// because both delegate to the identical primitive (../artifacts/cas-fs.ts).
// ---------------------------------------------------------------------------
describe.each(DRIVER_KINDS)('ArtifactRepository (%s) — unified with ArtifactStore', (kind) => {
  let handle: TestDatabaseHandle | undefined;
  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('a hash written through the repository is readable through a plain ArtifactStore at the same casRoot', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const written = unwrap(
      handle.db.artifacts.write({ runId: RUN_A, kind: 'diff', bytes: bytesOf('shared physical CAS layout'), redacted: true }),
    );

    const store = new ArtifactStore({ rootDir: handle.casRoot, clock: handle.db.clock, ids: new DeterministicIdFactory() });
    expect(await store.has(written.hash)).toBe(true);
    expect(await store.getText(written.hash)).toBe('shared physical CAS layout');
  });

  it('leaves no leftover temp files after a successful write (fsync-then-rename completed)', async () => {
    handle = await openTestDatabase({ kind, file: true });
    unwrap(handle.db.artifacts.write({ runId: RUN_A, kind: 'diff', bytes: bytesOf('no leftovers'), redacted: true }));
    const tmpEntries = await readdir(path.join(handle.casRoot, 'tmp')).catch(() => []);
    expect(tmpEntries).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P1 verifier punch-list item 2: promote artifact_admission_rejections into
// a real DomainEventType, emitted through the event log, while keeping the
// audit table exactly as documented.
// ---------------------------------------------------------------------------
describe.each(DRIVER_KINDS)('ArtifactRepository (%s) — admission rejection emits a domain event', (kind) => {
  let handle: TestDatabaseHandle | undefined;
  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('appends an artifact.admission.rejected event to the run log alongside the (unchanged) audit row', async () => {
    handle = await openTestDatabase({ kind, file: true, quotas: { perRunBytes: 100, globalBytes: 1_000_000 } });
    unwrap(handle.db.artifacts.write({ runId: RUN_A, kind: 'evidence', bytes: new Uint8Array(80), redacted: true }));

    const rejected = handle.db.artifacts.write({
      runId: RUN_A,
      kind: 'evidence',
      bytes: new Uint8Array(50).fill(9),
      redacted: true,
    });
    expect(isErr(rejected)).toBe(true);
    if (isOk(rejected)) throw new Error('expected rejection');

    const rejectionEvents = handle.db.events.listByRun(RUN_A).filter((e) => e.type === 'artifact.admission.rejected');
    expect(rejectionEvents).toHaveLength(1);
    expect(rejectionEvents[0]?.payload).toMatchObject({
      attemptedHash: rejected.error.attemptedHash,
      attemptedSizeBytes: 50,
      scope: 'per_run',
      limitBytes: 100,
      currentUsageBytes: 80,
    });
    expect(rejectionEvents[0]?.runId).toBe(RUN_A);

    // Additive, not a replacement — "keep the migration as documented".
    expect(handle.db.artifacts.listAdmissionRejections(RUN_A)).toHaveLength(1);
  });

  it('a duplicate rejection of the exact same attempt dedupes to one logical event (idempotency)', async () => {
    handle = await openTestDatabase({ kind, file: true, quotas: { perRunBytes: 10, globalBytes: 1_000_000 } });
    const db = handle.db;
    const attemptBytes = new Uint8Array(50);
    expect(isErr(db.artifacts.write({ runId: RUN_A, kind: 'evidence', bytes: attemptBytes, redacted: true }))).toBe(true);
    expect(isErr(db.artifacts.write({ runId: RUN_A, kind: 'evidence', bytes: attemptBytes, redacted: true }))).toBe(true);

    const rejectionEvents = db.events.listByRun(RUN_A).filter((e) => e.type === 'artifact.admission.rejected');
    expect(rejectionEvents).toHaveLength(1);
    // Both attempts ARE still independently audited, even though they
    // collapsed to one logical event.
    expect(db.artifacts.listAdmissionRejections(RUN_A)).toHaveLength(2);
  });

  it('does NOT emit a domain event for a purely global, run-less rejection (no RunId to attach it to)', async () => {
    handle = await openTestDatabase({ kind, file: true, quotas: { perRunBytes: 1_000_000, globalBytes: 10 } });
    const rejected = handle.db.artifacts.write({ kind: 'evidence', bytes: new Uint8Array(50), redacted: true });
    expect(isErr(rejected)).toBe(true);
    // Recorded in the audit table (run_id NULL) but no run to attach an event to.
    expect(handle.db.artifacts.listAdmissionRejections()).toHaveLength(1);
  });
});
