import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { SEQUENCE_UNASSIGNED, artifactHash, idempotencyKey, runId } from '../domain/ids.js';
import type { DomainEvent } from '../domain/events.js';
import { collectReferencedArtifactHashes } from './gc.js';
import { sha256Hex } from './hash.js';
import { ArtifactStore } from './store.js';

const RUN = runId('run_000001');

describe('sha256Hex', () => {
  it('matches the known digest of an empty string', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('is deterministic for identical content', () => {
    expect(sha256Hex('hello world')).toBe(sha256Hex('hello world'));
    expect(sha256Hex(Buffer.from('hello world'))).toBe(sha256Hex('hello world'));
  });

  it('differs for different content', () => {
    expect(sha256Hex('a')).not.toBe(sha256Hex('b'));
  });
});

describe('ArtifactStore', () => {
  let dir: string;
  let store: ArtifactStore;
  let ids: DeterministicIdFactory;
  let clock: ManualClock;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harness-artifacts-'));
    ids = new DeterministicIdFactory();
    clock = new ManualClock('2026-07-18T00:00:00.000Z');
    store = new ArtifactStore({ rootDir: dir, clock, ids });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes content addressed by its sha256 hash and reads it back', async () => {
    const artifact = await store.put({ content: 'hello world', kind: 'other' });
    expect(artifact.hash).toBe(sha256Hex('hello world'));
    expect(artifact.sizeBytes).toBe(Buffer.byteLength('hello world'));
    expect(artifact.redacted).toBe(true);
    expect(artifact.createdAt).toBe('2026-07-18T00:00:00.000Z');
    expect(await store.has(artifact.hash)).toBe(true);
    expect(await store.getText(artifact.hash)).toBe('hello world');
  });

  it('shards the content-addressed path as objects/<h[0:2]>/<h[2:4]>/<hash>', async () => {
    const artifact = await store.put({ content: 'sharding test', kind: 'other' });
    const hash = String(artifact.hash);
    const expected = path.join(dir, 'objects', hash.slice(0, 2), hash.slice(2, 4), hash);
    expect(store.pathForHash(hash)).toBe(expected);
    expect(await store.has(artifact.hash)).toBe(true);
  });

  it('carries runId and a bounded preview when supplied', async () => {
    const artifact = await store.put({
      content: 'a'.repeat(1000),
      kind: 'checkpoint',
      runId: RUN,
      previewChars: 10,
    });
    expect(artifact.runId).toBe(RUN);
    expect(artifact.preview).toBe('a'.repeat(10));
  });

  it('omits the preview when previewChars is 0', async () => {
    const artifact = await store.put({ content: 'some content', kind: 'other', previewChars: 0 });
    expect(artifact.preview).toBeUndefined();
  });

  it('dedupes identical content: a second put() does not rewrite and yields the same hash', async () => {
    const first = await store.put({ content: 'dedup me', kind: 'other' });
    const before = [...(await readdir(path.join(dir, 'objects', String(first.hash).slice(0, 2), String(first.hash).slice(2, 4))))];
    const second = await store.put({ content: 'dedup me', kind: 'other' });
    const after = [...(await readdir(path.join(dir, 'objects', String(first.hash).slice(0, 2), String(first.hash).slice(2, 4))))];
    expect(second.hash).toBe(first.hash);
    expect(after).toEqual(before);
  });

  it('leaves no temp files behind after a successful put (fsync-then-rename completed)', async () => {
    await store.put({ content: 'no leftovers', kind: 'other' });
    const tmpEntries = await readdir(path.join(dir, 'tmp')).catch(() => []);
    expect(tmpEntries).toEqual([]);
  });

  it('auto-redacts string content by default (artifact-file sink, §17.1)', async () => {
    const artifact = await store.put({
      content: 'Authorization: Bearer sk-ant-api03-AAAAAAAAAAAAAAAAAAAA',
      kind: 'transcript',
    });
    const stored = await store.getText(artifact.hash);
    expect(stored).not.toContain('sk-ant-api03-AAAAAAAAAAAAAAAAAAAA');
    expect(stored).toContain('[REDACTED:');
  });

  it('does not double-redact when the caller attests preRedacted:true', async () => {
    // A literal '[REDACTED:...]' token would not be produced from raw text
    // containing this exact literal unless redaction were skipped, since the
    // rule set does not match its own output shape; preRedacted:true stores
    // the string byte-for-byte instead of re-running the rules.
    const literal = 'already scrubbed: [REDACTED:manual]';
    const artifact = await store.put({ content: literal, kind: 'other', preRedacted: true });
    expect(await store.getText(artifact.hash)).toBe(literal);
  });

  it('rejects binary content without an explicit preRedacted:true attestation', async () => {
    await expect(store.put({ content: Buffer.from([1, 2, 3]), kind: 'other' })).rejects.toThrow(/preRedacted/);
  });

  it('accepts binary content when preRedacted:true is asserted', async () => {
    const bytes = Buffer.from([1, 2, 3, 4]);
    const artifact = await store.put({ content: bytes, kind: 'other', preRedacted: true });
    expect(artifact.preview).toBeUndefined();
    expect(await store.get(artifact.hash)).toEqual(bytes);
  });

  it('has() is false and get() throws for a hash never written', async () => {
    const missing = artifactHash(sha256Hex('never written'));
    expect(await store.has(missing)).toBe(false);
    await expect(store.get(missing)).rejects.toThrow(/no object for hash/);
  });

  it('is deterministic under injected clock/ids: identical content + fresh store yields identical metadata modulo path', async () => {
    const otherDir = await mkdtemp(path.join(tmpdir(), 'harness-artifacts-'));
    try {
      const otherStore = new ArtifactStore({
        rootDir: otherDir,
        clock: new ManualClock('2026-07-18T00:00:00.000Z'),
        ids: new DeterministicIdFactory(),
      });
      const a = await store.put({ content: 'same everywhere', kind: 'other' });
      const b = await otherStore.put({ content: 'same everywhere', kind: 'other' });
      expect(a.hash).toBe(b.hash);
      expect(a.createdAt).toBe(b.createdAt);
    } finally {
      await rm(otherDir, { recursive: true, force: true });
    }
  });

  describe('gcSweep (reference-aware)', () => {
    it('removes objects absent from the live set and keeps objects present in it', async () => {
      const kept = await store.put({ content: 'kept forever', kind: 'checkpoint' });
      const orphan = await store.put({ content: 'nobody references me', kind: 'checkpoint' });

      const result = await store.gcSweep(new Set([kept.hash]));

      expect(result.scanned).toBe(2);
      expect(result.removed).toEqual([orphan.hash]);
      expect(result.removedBytes).toBe(Buffer.byteLength('nobody references me'));
      expect(await store.has(kept.hash)).toBe(true);
      expect(await store.has(orphan.hash)).toBe(false);
    });

    it('is a no-op over an empty store', async () => {
      const result = await store.gcSweep(new Set());
      expect(result).toEqual({ scanned: 0, removed: [], removedBytes: 0 });
    });

    it('removes everything when the live set is empty', async () => {
      const a = await store.put({ content: 'alpha', kind: 'other' });
      const b = await store.put({ content: 'beta', kind: 'other' });
      const result = await store.gcSweep(new Set());
      expect(new Set(result.removed)).toEqual(new Set([a.hash, b.hash]));
    });
  });
});

describe('collectReferencedArtifactHashes', () => {
  // Structural-scan test: the scanner is deliberately shape-agnostic (see
  // gc.ts doc comment), so this builds envelope-shaped objects with
  // arbitrary payloads rather than constraining to today's real event
  // payload shapes. The single cast at the end is the only type-defeat.
  function fakeEvent(payload: Record<string, unknown>): DomainEvent {
    return {
      type: 'checkpoint.recorded',
      runId: RUN,
      sequence: SEQUENCE_UNASSIGNED,
      idempotencyKey: idempotencyKey('k1'),
      occurredAt: isoTimestamp('2026-07-18T00:00:00.000Z'),
      payload,
    } as unknown as DomainEvent;
  }

  it('collects a top-level artifactHash field', () => {
    const live = collectReferencedArtifactHashes([fakeEvent({ checkpointId: 'ckpt_1', artifactHash: 'hash-a', reason: 'cadence' })]);
    expect(live.has(artifactHash('hash-a'))).toBe(true);
    expect(live.size).toBe(1);
  });

  it('collects hashes nested inside an artifactRefs array', () => {
    const live = collectReferencedArtifactHashes([fakeEvent({ artifactRefs: ['hash-a', 'hash-b'] })]);
    expect(live.has(artifactHash('hash-a'))).toBe(true);
    expect(live.has(artifactHash('hash-b'))).toBe(true);
  });

  it('ignores string values under non-matching keys', () => {
    const live = collectReferencedArtifactHashes([fakeEvent({ reason: 'cadence', segmentId: 'seg_1' })]);
    expect(live.size).toBe(0);
  });

  it('only reflects events actually present in the input (crash-before-commit is simply absent)', () => {
    const committed = [fakeEvent({ artifactHash: 'hash-committed' })];
    const live = collectReferencedArtifactHashes(committed);
    expect(live.has(artifactHash('hash-committed'))).toBe(true);
    expect(live.has(artifactHash('hash-never-committed'))).toBe(false);
  });
});
