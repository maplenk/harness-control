/**
 * Barrel integration smoke (src/index.ts): proves the whole P1 public
 * surface is importable from ONE entry point with no ambiguous re-exports,
 * and that the modules actually interoperate THROUGH that surface — every
 * import below comes from './index.js', never from a module path. Deep
 * behavior is owned by each module's own colocated suite; this file only
 * guards the integration seams.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  // lib
  BoundedQueue,
  DeterministicIdFactory,
  ManualClock,
  isOk,
  isoTimestamp,
  unwrap,
  // domain
  TRANSITION_TABLE,
  applyTransition,
  artifactHash,
  draftEvent,
  eventSequence,
  gitSha,
  idempotencyKey,
  initialEngineState,
  memoryEntryId,
  runId,
  segmentId,
  specHash,
  specVersionId,
  // redaction
  redactText,
  // artifacts + checkpoint
  ArtifactStore,
  buildCheckpointContent,
  canonicalStringify,
  collectReferencedArtifactHashes,
  sha256Hex,
  writeCheckpoint,
  // memory
  MemoryStore,
  selectMemory,
  // persistence
  MIGRATIONS,
  appendTriggerWithEffects,
  openDatabase,
  registerRun,
  // config + profiles
  CONFIG_DEFAULT,
  DEFAULT_ENGINE_CONFIG,
  loadProfileFile,
  parseEngineConfig,
  toEngineBounds,
  type DomainEvent,
  type MemoryEntry,
} from './index.js';

const AT = isoTimestamp('2026-07-18T12:00:00.000Z');
const RUN = runId('run_barrel_smoke');

const tempDirs: string[] = [];
async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-barrel-smoke-'));
  tempDirs.push(dir);
  return dir;
}
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('barrel surface', () => {
  it('exposes the normative §6.3 table (25 rows), migrations, and the profile sentinel', () => {
    expect(TRANSITION_TABLE).toHaveLength(25);
    expect(MIGRATIONS.length).toBeGreaterThan(0);
    expect(CONFIG_DEFAULT).toBe('config-default');
    expect(typeof loadProfileFile).toBe('function');
  });

  it('config: parseEngineConfig({}) yields the frozen defaults and bridges into domain EngineBounds', () => {
    const parsed = parseEngineConfig({});
    expect(isOk(parsed)).toBe(true);
    const config = unwrap(parsed);
    expect(config).toEqual(DEFAULT_ENGINE_CONFIG);
    const bounds = toEngineBounds(config);
    expect(typeof bounds.restartWindowMax).toBe('number');
    expect(Number.isFinite(bounds.lifetimeRestartMax)).toBe(true);
  });

  it('redaction: the barrel redactText removes secrets', () => {
    const out = redactText('api key sk-abcdefghijklmnopqrstuvwx should vanish');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });

  it('bounded queue: §12.1 drop-oldest overflow is honest about loss', () => {
    const q = new BoundedQueue<number>({ capacity: 1, policy: 'drop_oldest' });
    q.enqueue(1);
    expect(q.enqueue(2)).toEqual({ accepted: true, evicted: 1 });
    expect(q.needsReplay).toBe(true);
  });
});

describe('cross-module flows through the barrel only', () => {
  it('domain: T1 spec.approved applies from awaiting_approval and binds the spec hash', () => {
    const state = initialEngineState({ phase: 'awaiting_approval' });
    const event = draftEvent({
      type: 'spec.approved',
      runId: RUN,
      payload: {
        specVersionId: specVersionId('spec_smoke_1'),
        specHash: specHash('spec-hash-smoke'),
        approvedBy: 'human',
      },
      idempotencyKey: idempotencyKey('barrel-approve-1'),
      occurredAt: AT,
    });
    const outcome = applyTransition(state, event);
    expect(outcome.status).toBe('applied');
    if (outcome.status === 'applied') {
      expect(outcome.next.phase).toBe('approved');
      expect(outcome.next.approvedSpecHash).toBe(specHash('spec-hash-smoke'));
    }
  });

  it('lib+redaction+artifacts+checkpoint+persistence: writeCheckpoint round-trips via the unified quota-aware CAS write path and is GC-referenced', async () => {
    const clock = new ManualClock(String(AT));
    const ids = new DeterministicIdFactory();
    const dir = await makeTempDir();
    const casRoot = path.join(dir, 'cas');
    const db = await openDatabase({ filename: path.join(dir, 'smoke.db'), casRoot, clock });
    try {
      // Independent read handle onto the SAME physical CAS the quota-aware
      // repository writes through below — both delegate to the identical
      // fsync-before-rename primitive, proving the two surfaces are unified
      // (P1 verifier punch-list item 1), not two independent CAS layouts.
      const store = new ArtifactStore({ rootDir: casRoot, clock, ids });

      const content = buildCheckpointContent({
        lineage: { harnessId: 'claude-code', model: 'model-under-test' },
        eventCursor: eventSequence(7),
        specHash: specHash('spec-hash-smoke'),
        criterionStates: [],
        permissionPolicy: { mode: 'headless', allowlist: [] },
        worktree: {
          headSha: gitSha('a'.repeat(40)),
          statusPorcelain: '',
          diffHash: artifactHash(sha256Hex('')),
          lockfileCleanupPerformed: false,
          taintFlags: [],
        },
      });

      const { checkpoint, event } = unwrap(
        await writeCheckpoint(
          { artifacts: db.artifacts, clock, ids },
          { runId: RUN, segmentId: segmentId('seg_smoke_1'), reason: 'pre_pause', content },
        ),
      );

      expect(event.payload.artifactHash).toBe(checkpoint.artifactHash);
      await expect(store.getText(checkpoint.artifactHash)).resolves.toBe(canonicalStringify(content));
      const referenced = collectReferencedArtifactHashes([event as DomainEvent]);
      expect(referenced.has(checkpoint.artifactHash)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('persistence: one-transaction append+projection write with idempotent redelivery (§6.3)', async () => {
    const dir = await makeTempDir();
    const db = await openDatabase({
      filename: path.join(dir, 'smoke.db'),
      casRoot: path.join(dir, 'cas'),
      clock: new ManualClock(String(AT)),
    });
    try {
      registerRun(db.driver, db.clock, RUN);
      const trigger = draftEvent({
        type: 'pause.user.requested',
        runId: RUN,
        payload: {},
        idempotencyKey: idempotencyKey('barrel-pause-1'),
        occurredAt: AT,
      }) as DomainEvent;

      const first = appendTriggerWithEffects(db, trigger, [], {
        name: 'barrel_smoke',
        currentState: { count: 0 },
        reduceEvent: (s: { count: number }) => ({ count: s.count + 1 }),
      });
      expect(first.projection.state.count).toBe(1);
      expect(db.events.countByRun(RUN)).toBe(1);

      // Redelivered notification (same idempotency key) = one logical event.
      const redelivered = db.events.append(trigger);
      expect(redelivered.deduped).toBe(true);
      expect(db.events.countByRun(RUN)).toBe(1);
    } finally {
      db.close();
    }
  });

  it('memory: store visibility + §15 selector agree through the barrel', () => {
    const constraint: MemoryEntry = {
      id: memoryEntryId('mem_smoke_1'),
      type: 'constraint',
      scope: 'run',
      runId: RUN,
      trust: 'trusted',
      contentHash: artifactHash(sha256Hex('never touch prod')),
      content: 'never touch prod',
      createdAt: AT,
    };
    const otherRun: MemoryEntry = {
      ...constraint,
      id: memoryEntryId('mem_smoke_2'),
      runId: runId('run_other'),
      contentHash: artifactHash(sha256Hex('other-run entry')),
      content: 'other-run entry',
    };
    const store = new MemoryStore();
    store.addMany([constraint, otherRun]);
    expect(store.visibleTo({ runId: RUN, role: 'implementor' })).toEqual([constraint]);

    const selection = selectMemory(store.all(), {
      runId: RUN,
      role: 'implementor',
      now: AT,
      budgetChars: 10_000,
    });
    expect(selection.selected).toEqual([constraint]);
    expect(selection.rejected.map((r) => r.reason)).toEqual(['out_of_scope']);
  });
});
