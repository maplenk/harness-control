import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { isErr, unwrap } from '../lib/result.js';
import {
  SEQUENCE_UNASSIGNED,
  artifactHash,
  criterionId,
  eventSequence,
  gitSha,
  runId,
  segmentId,
  specHash,
} from '../domain/ids.js';
import type { CheckpointContent, PermissionPolicy, SegmentLineage, WorktreeState } from '../domain/entities.js';
import type { DomainEvent } from '../domain/events.js';
import { ArtifactStore } from '../artifacts/store.js';
import { collectReferencedArtifactHashes } from '../artifacts/gc.js';
import { openDatabase, type Database } from '../persistence/database.js';
import { CadenceTracker, DEFAULT_CADENCE_POLICY, decideCheckpoint } from './cadence.js';
import { buildCheckpointContent, deriveIncompleteOperation } from './content.js';
import { canonicalStringify } from './serialize.js';
import { writeCheckpoint } from './writer.js';

const RUN = runId('run_000001');
const SEG = segmentId('seg_000001');
const AT = isoTimestamp('2026-07-18T10:00:00.000Z');

const LINEAGE: SegmentLineage = { harnessId: 'claude-code', model: 'claude-opus-4' };
const PERMISSION_POLICY: PermissionPolicy = { mode: 'headless', allowlist: ['git status'] };
const WORKTREE: WorktreeState = {
  headSha: gitSha('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'),
  statusPorcelain: '',
  diffHash: artifactHash('diffhash0000'),
  lockfileCleanupPerformed: false,
  taintFlags: [],
};

interface ContentOverrides {
  readonly constraints?: readonly string[];
  readonly unresolvedRisks?: readonly string[];
  readonly failingTests?: readonly string[];
  readonly incompleteOperation?: CheckpointContent['incompleteOperation'];
}

function baseContent(overrides: ContentOverrides = {}): CheckpointContent {
  return buildCheckpointContent({
    lineage: LINEAGE,
    eventCursor: eventSequence(1),
    specHash: specHash('spec-hash-abc'),
    criterionStates: [{ criterionId: criterionId('crit_1'), state: 'pending' }],
    permissionPolicy: PERMISSION_POLICY,
    worktree: WORKTREE,
    ...(overrides.constraints !== undefined ? { constraints: overrides.constraints } : {}),
    ...(overrides.unresolvedRisks !== undefined ? { unresolvedRisks: overrides.unresolvedRisks } : {}),
    ...(overrides.failingTests !== undefined ? { failingTests: overrides.failingTests } : {}),
    ...(overrides.incompleteOperation !== undefined ? { incompleteOperation: overrides.incompleteOperation } : {}),
  });
}

// ---------------------------------------------------------------------------
// Cadence policy
// ---------------------------------------------------------------------------
describe('decideCheckpoint (cadence policy)', () => {
  it('defaults to every 3rd completed turn', () => {
    expect(DEFAULT_CADENCE_POLICY.everyNTurns).toBe(3);
    expect(decideCheckpoint({ kind: 'turn_completed', completedSinceLastCheckpoint: 1 })).toEqual({
      shouldCheckpoint: false,
    });
    expect(decideCheckpoint({ kind: 'turn_completed', completedSinceLastCheckpoint: 2 })).toEqual({
      shouldCheckpoint: false,
    });
    expect(decideCheckpoint({ kind: 'turn_completed', completedSinceLastCheckpoint: 3 })).toEqual({
      shouldCheckpoint: true,
      reason: 'cadence',
    });
  });

  it('honors a configured N', () => {
    const policy = { everyNTurns: 5 };
    expect(decideCheckpoint({ kind: 'turn_completed', completedSinceLastCheckpoint: 4 }, policy).shouldCheckpoint).toBe(
      false,
    );
    expect(decideCheckpoint({ kind: 'turn_completed', completedSinceLastCheckpoint: 5 }, policy).shouldCheckpoint).toBe(
      true,
    );
  });

  it('disables turn-based cadence when N <= 0, without affecting boundary triggers', () => {
    const policy = { everyNTurns: 0 };
    expect(
      decideCheckpoint({ kind: 'turn_completed', completedSinceLastCheckpoint: 1000 }, policy).shouldCheckpoint,
    ).toBe(false);
    expect(decideCheckpoint({ kind: 'pre_pause' }, policy)).toEqual({ shouldCheckpoint: true, reason: 'pre_pause' });
  });

  it('always checkpoints before switch, pause, verify handoff, and graceful stop', () => {
    expect(decideCheckpoint({ kind: 'pre_model_switch' })).toEqual({ shouldCheckpoint: true, reason: 'pre_model_switch' });
    expect(decideCheckpoint({ kind: 'pre_pause' })).toEqual({ shouldCheckpoint: true, reason: 'pre_pause' });
    expect(decideCheckpoint({ kind: 'pre_verify_handoff' })).toEqual({
      shouldCheckpoint: true,
      reason: 'pre_verify_handoff',
    });
    expect(decideCheckpoint({ kind: 'pre_graceful_stop' })).toEqual({
      shouldCheckpoint: true,
      reason: 'pre_graceful_stop',
    });
  });
});

describe('CadenceTracker', () => {
  it('fires every 3rd completed turn and resets afterward', () => {
    const tracker = new CadenceTracker();
    expect(tracker.recordCompletedTurn().shouldCheckpoint).toBe(false);
    expect(tracker.recordCompletedTurn().shouldCheckpoint).toBe(false);
    const third = tracker.recordCompletedTurn();
    expect(third).toEqual({ shouldCheckpoint: true, reason: 'cadence' });
    expect(tracker.completedSinceLastCheckpoint).toBe(0);
    expect(tracker.recordCompletedTurn().shouldCheckpoint).toBe(false);
  });

  it('recordCheckpointWritten resets the window early (boundary checkpoint absorbs the cadence)', () => {
    const tracker = new CadenceTracker();
    tracker.recordCompletedTurn();
    tracker.recordCompletedTurn();
    tracker.recordCheckpointWritten(); // e.g. a pre_pause checkpoint just happened
    expect(tracker.completedSinceLastCheckpoint).toBe(0);
    expect(tracker.recordCompletedTurn().shouldCheckpoint).toBe(false);
    expect(tracker.recordCompletedTurn().shouldCheckpoint).toBe(false);
    expect(tracker.recordCompletedTurn().shouldCheckpoint).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Canonical serialization
// ---------------------------------------------------------------------------
describe('canonicalStringify', () => {
  it('is independent of source object key order', () => {
    const a = { b: 1, a: 2, c: { z: 1, y: 2 } };
    const b = { a: 2, c: { y: 2, z: 1 }, b: 1 };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });

  it('still distinguishes genuinely different content', () => {
    expect(canonicalStringify({ a: 1 })).not.toBe(canonicalStringify({ a: 2 }));
  });

  it('sorts keys inside array elements too', () => {
    const a = { list: [{ b: 1, a: 2 }] };
    const b = { list: [{ a: 2, b: 1 }] };
    expect(canonicalStringify(a)).toBe(canonicalStringify(b));
  });
});

// ---------------------------------------------------------------------------
// incomplete_operation honesty
// ---------------------------------------------------------------------------
describe('deriveIncompleteOperation', () => {
  it('is undefined for idle — never fabricates an incomplete operation', () => {
    expect(deriveIncompleteOperation({ kind: 'idle' }, AT)).toBeUndefined();
  });

  it('reports prompt_turn honestly, falling back to the trigger timestamp when no better one is known', () => {
    const result = deriveIncompleteOperation({ kind: 'prompt_turn' }, AT);
    expect(result).toEqual({ operation: 'prompt_turn', startedAt: AT });
  });

  it("uses the operation's own timestamp for model_switch when no explicit startedAt is given", () => {
    const requestedAt = isoTimestamp('2026-07-18T09:00:00.000Z');
    const result = deriveIncompleteOperation(
      { kind: 'model_switch', fromModel: 'a', toModel: 'b', requestedAt },
      AT,
    );
    expect(result).toEqual({ operation: 'model_switch', startedAt: requestedAt });
  });

  it('prefers an explicit startedAt override and passes through detail', () => {
    const explicit = isoTimestamp('2026-07-18T08:30:00.000Z');
    const result = deriveIncompleteOperation(
      { kind: 'git_op', op: 'commit' },
      AT,
      { startedAt: explicit, detail: 'git commit in flight' },
    );
    expect(result).toEqual({ operation: 'git_op', startedAt: explicit, detail: 'git commit in flight' });
  });
});

describe('buildCheckpointContent', () => {
  it('defaults list fields to empty arrays and omits incompleteOperation when absent', () => {
    const content = baseContent();
    expect(content.constraints).toEqual([]);
    expect(content.confirmedDecisions).toEqual([]);
    expect(content.unresolvedRisks).toEqual([]);
    expect(content.failingTests).toEqual([]);
    expect(content.artifactRefs).toEqual([]);
    expect('incompleteOperation' in content).toBe(false);
  });

  it('passes through an honestly-derived incompleteOperation', () => {
    const incomplete = deriveIncompleteOperation({ kind: 'prompt_turn' }, AT);
    const content = baseContent({ incompleteOperation: incomplete });
    expect(content.incompleteOperation).toEqual({ operation: 'prompt_turn', startedAt: AT });
  });
});

// ---------------------------------------------------------------------------
// writeCheckpoint: mechanical write + atomicity contract
//
// Deps now go through the UNIFIED artifact write path (P1 verifier
// punch-list item 1): `db.artifacts` is the quota-admitting, fsync-durable
// `ArtifactRepository` (../persistence/artifact-repository.ts), not a bare
// `ArtifactStore`. A SECOND, independent `ArtifactStore` handle is opened
// onto the SAME `casRoot` purely for read-side/GC assertions below — since
// both surfaces delegate to the identical fsync-before-rename primitive
// (../artifacts/cas-fs.ts), bytes written through one are readable through
// the other, which these tests exercise directly as proof of unification.
// ---------------------------------------------------------------------------
describe('writeCheckpoint', () => {
  let dir: string;
  let db: Database;
  let store: ArtifactStore;
  let deps: { artifacts: Database['artifacts']; clock: ManualClock; ids: DeterministicIdFactory };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harness-checkpoint-'));
    const ids = new DeterministicIdFactory();
    const clock = new ManualClock('2026-07-18T10:00:00.000Z');
    const casRoot = path.join(dir, 'cas');
    db = await openDatabase({ filename: path.join(dir, 'test.db'), casRoot, clock });
    store = new ArtifactStore({ rootDir: casRoot, clock, ids });
    deps = { artifacts: db.artifacts, clock, ids };
  });

  afterEach(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes the artifact durably, and the event carries its hash', async () => {
    const content = baseContent();
    const { checkpoint, event } = unwrap(
      await writeCheckpoint(deps, { runId: RUN, segmentId: SEG, reason: 'cadence', content }),
    );

    expect(await store.has(checkpoint.artifactHash)).toBe(true);
    expect(event.type).toBe('checkpoint.recorded');
    expect(event.payload.artifactHash).toBe(checkpoint.artifactHash);
    expect(event.payload.checkpointId).toBe(checkpoint.id);
    expect(event.payload.reason).toBe('cadence');
    expect(event.sequence).toBe(SEQUENCE_UNASSIGNED); // not yet appended (caller's job)
    expect(event.runId).toBe(RUN);
    expect(checkpoint.content).toEqual(content);
  });

  it('content-addresses the artifact to the canonical serialization of the content', async () => {
    const content = baseContent();
    const { checkpoint } = unwrap(
      await writeCheckpoint(deps, { runId: RUN, segmentId: SEG, reason: 'cadence', content }),
    );
    const stored = await store.getText(checkpoint.artifactHash);
    expect(stored).toBe(canonicalStringify(content));
  });

  it('redacts secrets embedded in checkpoint content before they reach the artifact sink', async () => {
    const content = baseContent({
      unresolvedRisks: ['a stray Authorization: Bearer sk-ant-api03-LEAKEDLEAKEDLEAKEDLE header was logged'],
      failingTests: ['AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY leaked in stderr'],
    });
    const { checkpoint } = unwrap(
      await writeCheckpoint(deps, { runId: RUN, segmentId: SEG, reason: 'pre_pause', content }),
    );
    const stored = await store.getText(checkpoint.artifactHash);
    expect(stored).not.toContain('sk-ant-api03-LEAKEDLEAKEDLEAKEDLE');
    expect(stored).not.toContain('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
  });

  it('honestly carries an incomplete_operation for a mid-turn pause checkpoint', async () => {
    const incomplete = deriveIncompleteOperation({ kind: 'prompt_turn' }, AT);
    const content = baseContent({ incompleteOperation: incomplete });
    const { checkpoint } = unwrap(
      await writeCheckpoint(deps, { runId: RUN, segmentId: SEG, reason: 'pre_pause', content }),
    );
    expect(checkpoint.content.incompleteOperation).toEqual({ operation: 'prompt_turn', startedAt: AT });
    const stored = JSON.parse(await store.getText(checkpoint.artifactHash)) as CheckpointContent;
    expect(stored.incompleteOperation).toEqual({ operation: 'prompt_turn', startedAt: AT });
  });

  it('never claims an incomplete_operation for a clean cadence checkpoint (operation was idle)', async () => {
    const incomplete = deriveIncompleteOperation({ kind: 'idle' }, AT);
    const content = baseContent({ incompleteOperation: incomplete });
    const { checkpoint } = unwrap(
      await writeCheckpoint(deps, { runId: RUN, segmentId: SEG, reason: 'cadence', content }),
    );
    expect('incompleteOperation' in checkpoint.content).toBe(false);
  });

  // -------------------------------------------------------------------------
  // P1 verifier punch-list item 1: checkpoint artifacts now respect quotas.
  // -------------------------------------------------------------------------
  it('respects the artifact quota: a checkpoint write can be honestly rejected, never a fabricated success', async () => {
    const tightDir = await mkdtemp(path.join(tmpdir(), 'harness-checkpoint-tight-'));
    const tightClock = new ManualClock('2026-07-18T10:00:00.000Z');
    const tightDb = await openDatabase({
      filename: path.join(tightDir, 'test.db'),
      casRoot: path.join(tightDir, 'cas'),
      clock: tightClock,
      quotas: { perRunBytes: 10, globalBytes: 10 },
    });
    try {
      const tightDeps = { artifacts: tightDb.artifacts, clock: tightClock, ids: new DeterministicIdFactory() };
      const result = await writeCheckpoint(tightDeps, {
        runId: RUN,
        segmentId: SEG,
        reason: 'cadence',
        content: baseContent(),
      });
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error('expected rejection');
      expect(result.error).toMatchObject({ runId: RUN, scope: 'per_run', limitBytes: 10 });

      // The rejection is ALSO promoted onto the run's event log (P1
      // verifier punch-list item 2), not just an audit-table-only fact.
      const events = tightDb.events.listByRun(RUN);
      expect(events.some((e) => e.type === 'artifact.admission.rejected')).toBe(true);
    } finally {
      tightDb.close();
      await rm(tightDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // §19 test 23 — crash between artifact and event: artifact invisible + GC'd
  // -------------------------------------------------------------------------
  describe('atomicity under a crash between artifact write and event commit (§19 test 23)', () => {
    it('leaves the artifact durable-but-orphaned when the event never commits, and GC reclaims it', async () => {
      // A checkpoint that DID make it all the way through: its event will be
      // "committed" (added to the log) below, so it must survive GC.
      const survivorContent = baseContent({ constraints: ['survivor'] });
      const survivor = unwrap(
        await writeCheckpoint(deps, { runId: RUN, segmentId: SEG, reason: 'cadence', content: survivorContent }),
      );

      // The checkpoint whose event never lands — simulates a crash in the
      // application layer's transaction AFTER the artifact fsync completed
      // (writeCheckpoint already returned) but BEFORE the caller appended
      // `event` to the log. writeCheckpoint's own job — fsyncing the
      // artifact before the event could even be constructed — already
      // happened; nothing further ties them together until this append.
      const orphanContent = baseContent({ constraints: ['orphan — its event will never be committed'] });
      const orphan = unwrap(
        await writeCheckpoint(deps, { runId: RUN, segmentId: SEG, reason: 'pre_pause', content: orphanContent }),
      );

      // Both artifacts are durably on disk right now — the artifact write
      // does not know or care whether its event will ever commit.
      expect(await store.has(survivor.checkpoint.artifactHash)).toBe(true);
      expect(await store.has(orphan.checkpoint.artifactHash)).toBe(true);

      // "Commit" only the survivor's event (the orphan's event is simply
      // never appended — that IS the crash).
      const committedEvents: DomainEvent[] = [survivor.event];

      const liveHashes = collectReferencedArtifactHashes(committedEvents);
      expect(liveHashes.has(survivor.checkpoint.artifactHash)).toBe(true);
      expect(liveHashes.has(orphan.checkpoint.artifactHash)).toBe(false);

      const gcResult = await store.gcSweep(liveHashes);

      expect(gcResult.removed).toContain(orphan.checkpoint.artifactHash);
      expect(gcResult.removed).not.toContain(survivor.checkpoint.artifactHash);

      // Invisible: gone from the store, exactly as if it never existed.
      expect(await store.has(orphan.checkpoint.artifactHash)).toBe(false);
      await expect(store.get(orphan.checkpoint.artifactHash)).rejects.toThrow(/no object for hash/);

      // The properly-committed checkpoint is untouched.
      expect(await store.has(survivor.checkpoint.artifactHash)).toBe(true);
      expect(await store.getText(survivor.checkpoint.artifactHash)).toBe(canonicalStringify(survivorContent));
    });

    it('is genuinely reference-aware, not a blanket sweep: the same content survives a sweep once its event is committed', async () => {
      const content = baseContent({ constraints: ['eventually committed'] });
      const first = unwrap(await writeCheckpoint(deps, { runId: RUN, segmentId: SEG, reason: 'cadence', content }));

      // First sweep BEFORE any event commits: reclaimed (proves GC isn't a no-op).
      const beforeCommit = await store.gcSweep(collectReferencedArtifactHashes([]));
      expect(beforeCommit.removed).toContain(first.checkpoint.artifactHash);
      expect(await store.has(first.checkpoint.artifactHash)).toBe(false);

      // Re-write the same logical checkpoint (as a real recovery path would
      // after detecting the missing event) and THIS time commit its event
      // before sweeping again.
      const rewritten = unwrap(
        await writeCheckpoint(deps, { runId: RUN, segmentId: SEG, reason: 'cadence', content }),
      );
      expect(rewritten.checkpoint.artifactHash).toBe(first.checkpoint.artifactHash); // same content, same hash

      const afterCommit = await store.gcSweep(collectReferencedArtifactHashes([rewritten.event]));
      expect(afterCommit.removed).not.toContain(rewritten.checkpoint.artifactHash);
      expect(await store.has(rewritten.checkpoint.artifactHash)).toBe(true);
    });
  });
});
