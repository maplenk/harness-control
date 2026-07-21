/** Startup RSS reconciliation for both persisted T22 semantics. */
import { createRunFixture } from './test-support.js';
import { afterEach, describe, expect, it } from 'vitest';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import {
  idempotencyKey,
  processGenerationId,
  segmentId,
  type ProcessGenerationId,
  type RunId,
  type SegmentId,
} from '../domain/ids.js';
import type { EngineState } from '../domain/transitions.js';
import { isoTimestamp } from '../lib/clock.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import type { ProcessIdentitySample, PsClient } from '../supervisor/index.js';
import { ENGINE_STATE_PROJECTION } from './projections.js';
import { OrchestrationService } from './service.js';

const DRIVER_KINDS = await availableDriverKinds();
const COORDINATOR = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const DEAD_OWNER = 89_999;

interface FakePs {
  readonly client: PsClient;
  readonly identities: Map<number, ProcessIdentitySample>;
  readonly trees: Map<number, readonly number[]>;
  readonly signals: Array<{ pgid: number; signal: NodeJS.Signals }>;
}

function fakePs(): FakePs {
  const identities = new Map<number, ProcessIdentitySample>();
  const trees = new Map<number, readonly number[]>();
  const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  return {
    identities,
    trees,
    signals,
    client: {
      sampleProcessTree(pgid) {
        const pids = trees.get(pgid);
        return pids !== undefined
          ? {
              pgid,
              rssBytes: 1_600_000_000,
              processCount: pids.length,
              pids,
              sampledAt: isoTimestamp('2026-07-21T10:00:00.000Z'),
            }
          : undefined;
      },
      sampleIdentity(pid) {
        return identities.get(pid);
      },
      isAlive(pid) {
        return identities.has(pid);
      },
    },
  };
}

function sample(pid: number): ProcessIdentitySample {
  return {
    pid,
    ppid: 1,
    pgid: pid,
    startedAt: `started-${pid}`,
    executablePath: '/fake/agent',
  };
}

function seedActiveChild(
  service: OrchestrationService,
  runId: RunId,
  generationId: ProcessGenerationId,
  segment: SegmentId,
): void {
  service.ingest(
    draftEvent({
      type: 'child.spawn.initiated',
      runId,
      payload: { generationId, segmentId: segment, role: 'implementor' },
      idempotencyKey: idempotencyKey(`${generationId}:initiated`),
      occurredAt: isoTimestamp('2026-07-21T10:00:00.000Z'),
    }) as DomainEvent,
  );
  service.ingest(
    draftEvent({
      type: 'child.spawned',
      runId,
      payload: { generationId, segmentId: segment, role: 'implementor', pins: [] },
      idempotencyKey: idempotencyKey(`${generationId}:spawned`),
      occurredAt: isoTimestamp('2026-07-21T10:00:00.000Z'),
    }) as DomainEvent,
  );
}

function ingestT22(
  service: OrchestrationService,
  runId: RunId,
  generationId: ProcessGenerationId,
  segment: SegmentId,
  semanticsVersion?: 2,
): void {
  service.ingest(
    draftEvent({
      type: 'rss.hard_limit',
      runId,
      payload: {
        ...(semanticsVersion === 2 ? { semanticsVersion } : {}),
        generationId,
        segmentId: segment,
        role: 'implementor',
        rssBytes: 1_600_000_000,
        budgetBytes: 1_024_000_000,
        escalation: 'graceful',
      },
      idempotencyKey: idempotencyKey(`${generationId}:t22:${semanticsVersion ?? 'legacy'}`),
      occurredAt: isoTimestamp('2026-07-21T10:01:00.000Z'),
    }) as DomainEvent,
  );
}

function state(handle: TestDatabaseHandle, runId: RunId): EngineState {
  const projection = handle.db.projections.get<EngineState>(runId, ENGINE_STATE_PROJECTION);
  if (projection === undefined) throw new Error('missing engine projection');
  return projection.state;
}

describe.each(DRIVER_KINDS)('T22 startup orphan reconciliation (%s)', (kind) => {
  let handle: TestDatabaseHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  function setup(generationName: string): {
    service: OrchestrationService;
    runId: RunId;
    generationId: ProcessGenerationId;
    segment: SegmentId;
    ps: FakePs;
    pid: number;
  } {
    if (handle === undefined) throw new Error('database not open');
    const ps = fakePs();
    const service = new OrchestrationService({
      db: handle.db,
      supervision: {
        ps: ps.client,
        selfPid: 88_001,
        envNonce: { verifyNonce: () => 'match' },
        sendSignal: (pgid, signal) => ps.signals.push({ pgid, signal }),
      },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: COORDINATOR });
    const generationId = processGenerationId(generationName);
    const segment = segmentId(`seg_${generationName}`);
    seedActiveChild(service, runId, generationId, segment);
    const pid = generationName.endsWith('v2') ? 88_102 : 88_101;
    ps.identities.set(pid, sample(pid));
    ps.trees.set(pid, [pid]);
    service.supervision.registry.store.put({
      generationId,
      pid,
      pgid: pid,
      startedAt: `started-${pid}`,
      executablePath: '/fake/agent',
      spawnNonce: `nonce-${pid}`,
      runId,
      segmentId: segment,
      recordedAt: handle.db.clock.nowIso(),
      ownerPid: DEAD_OWNER,
    });
    return { service, runId, generationId, segment, ps, pid };
  }

  it('forward-reconciles a generation-bound legacy T22 without reinterpreting it', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const { service, runId, generationId, segment, ps, pid } = setup('pgen_recover_legacy');
    ingestT22(service, runId, generationId, segment);
    expect(state(handle, runId).activeChild?.status).toBe('active');

    const signaled = service.reapOrphanProcesses();

    expect(signaled.signalSentCount).toBe(1);
    expect(signaled.confirmedGoneCount).toBe(0);
    expect(state(handle, runId).suspension.kind).toBe('none');
    expect(state(handle, runId).activeChild?.status).toBe('active');
    expect(handle.db.events.listByRun(runId).map((entry) => entry.type)).not.toContain('resource.exhausted');
    expect(service.supervision.registry.store.get(generationId)).toBeDefined();

    ps.identities.delete(pid);
    ps.trees.delete(pid);
    expect(service.reapOrphanProcesses().confirmedGoneCount).toBe(1);
    expect(state(handle, runId).suspension.kind).toBe('resource_exhausted');
    expect(state(handle, runId).activeChild?.status).toBe('stopped');
    const types = handle.db.events.listByRun(runId).map((entry) => entry.type);
    expect(types).toContain('resource.exhausted');
    expect(types).not.toContain('recovery.running_segment_found');
    expect(types).not.toContain('child.exited.unexpectedly');

    service.reapOrphanProcesses();
    expect(handle.db.events.listByRun(runId).filter((entry) => entry.type === 'resource.exhausted'))
      .toHaveLength(1);
  });

  it('confirms a T22 v2 stop intent through resource.exhausted, never child crash', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const { service, runId, generationId, segment, ps, pid } = setup('pgen_recover_v2');
    ingestT22(service, runId, generationId, segment, 2);
    expect(state(handle, runId).activeChild).toMatchObject({
      status: 'stopping',
      stopCause: 'resource_exhaustion',
    });

    const signaled = service.reapOrphanProcesses();

    expect(signaled.signalSentCount).toBe(1);
    expect(signaled.confirmedGoneCount).toBe(0);
    expect(state(handle, runId).suspension.kind).toBe('none');
    expect(state(handle, runId).activeChild).toMatchObject({
      status: 'stopping',
      stopCause: 'resource_exhaustion',
    });
    expect(handle.db.events.listByRun(runId).map((entry) => entry.type)).not.toContain('resource.exhausted');
    expect(service.supervision.registry.store.get(generationId)).toBeDefined();

    ps.identities.delete(pid);
    ps.trees.delete(pid);
    expect(service.reapOrphanProcesses().confirmedGoneCount).toBe(1);
    expect(state(handle, runId).suspension.kind).toBe('resource_exhausted');
    expect(state(handle, runId).activeChild?.status).toBe('stopped');
    const types = handle.db.events.listByRun(runId).map((entry) => entry.type);
    expect(types).toContain('resource.exhausted');
    expect(types).not.toContain('child.exited.unexpectedly');
  });

  it('does not duplicate an existing legacy confirmation during startup reap', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const { service, runId, generationId, segment, ps, pid } = setup('pgen_recover_mixed');
    ingestT22(service, runId, generationId, segment);
    service.ingest(
      draftEvent({
        type: 'resource.exhausted',
        runId,
        payload: {
          generationId,
          segmentId: segment,
          role: 'implementor',
          rssBytes: 1_600_000_000,
          budgetBytes: 1_024_000_000,
        },
        idempotencyKey: idempotencyKey(`${generationId}:already-confirmed`),
        occurredAt: isoTimestamp('2026-07-21T10:02:00.000Z'),
      }) as DomainEvent,
    );
    expect(state(handle, runId).suspension.kind).toBe('resource_exhausted');

    expect(service.reapOrphanProcesses().signalSentCount).toBe(1);
    expect(service.supervision.registry.store.get(generationId)).toBeDefined();
    ps.identities.delete(pid);
    ps.trees.delete(pid);
    expect(service.reapOrphanProcesses().confirmedGoneCount).toBe(1);

    expect(handle.db.events.listByRun(runId).filter((entry) => entry.type === 'resource.exhausted'))
      .toHaveLength(1);
    expect(state(handle, runId).activeChild?.status).toBe('stopped');
  });

  it('retains a T22 v2 stop intent while the leader is gone but its process-group descendants remain alive', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const { service, runId, generationId, segment, ps, pid } = setup('pgen_tree_v2');
    ingestT22(service, runId, generationId, segment, 2);

    // The process-group leader exited, but a descendant still occupies the
    // same pgid. Leader absence alone must not finalize resource exhaustion.
    ps.identities.delete(pid);
    ps.trees.set(pid, [pid + 1]);
    const descendantsAlive = service.reapOrphanProcesses();

    expect(descendantsAlive.signalSentCount).toBe(0);
    expect(descendantsAlive.exitPendingCount).toBe(1);
    expect(descendantsAlive.confirmedGoneCount).toBe(0);
    expect(descendantsAlive.entries[0]).toMatchObject({
      generationId,
      action: 'exit_pending',
      verification: { verdict: 'gone' },
    });
    expect(ps.signals).toEqual([]);
    expect(state(handle, runId).suspension.kind).toBe('none');
    expect(state(handle, runId).activeChild).toMatchObject({
      status: 'stopping',
      stopCause: 'resource_exhaustion',
    });
    expect(handle.db.events.listByRun(runId).map((entry) => entry.type)).not.toContain('resource.exhausted');
    expect(service.supervision.registry.store.get(generationId)).toBeDefined();

    ps.trees.delete(pid);
    expect(service.reapOrphanProcesses().confirmedGoneCount).toBe(1);
    expect(state(handle, runId).suspension.kind).toBe('resource_exhausted');
    expect(state(handle, runId).activeChild?.status).toBe('stopped');
  });

  it('retains confirmed-gone registry ownership when durable RSS finalization fails, then retries', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const { service, runId, generationId, segment, ps, pid } = setup('pgen_finalize_retry_v2');
    ingestT22(service, runId, generationId, segment, 2);
    ps.identities.delete(pid);
    ps.trees.delete(pid);

    const mutableDb = handle.db as unknown as {
      transactionImmediate: typeof handle.db.transactionImmediate;
    };
    const transactionImmediate = mutableDb.transactionImmediate;
    mutableDb.transactionImmediate = () => {
      throw new Error('injected durable finalization failure');
    };
    try {
      expect(() => service.reapOrphanProcesses()).toThrow('injected durable finalization failure');
    } finally {
      mutableDb.transactionImmediate = transactionImmediate;
    }

    expect(service.supervision.registry.store.get(generationId)).toBeDefined();
    expect(state(handle, runId).suspension.kind).toBe('none');
    expect(state(handle, runId).activeChild).toMatchObject({
      status: 'stopping',
      stopCause: 'resource_exhaustion',
    });
    expect(handle.db.events.listByRun(runId).map((entry) => entry.type)).not.toContain('resource.exhausted');

    const retry = service.reapOrphanProcesses();
    expect(retry.confirmedGoneCount).toBe(1);
    expect(state(handle, runId).suspension.kind).toBe('resource_exhausted');
    expect(state(handle, runId).activeChild?.status).toBe('stopped');
    expect(service.supervision.registry.store.get(generationId)).toBeUndefined();
    expect(handle.db.events.listByRun(runId).filter((entry) => entry.type === 'resource.exhausted'))
      .toHaveLength(1);
  });
});
