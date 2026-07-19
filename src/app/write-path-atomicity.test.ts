/**
 * F1 (§5w/§5x, Approach A) — the write path is ATOMIC: `ingest` runs
 * `loadEngineRecord` + `applyTransition` (validate) + `appendTriggerWithEffects`
 * INSIDE one `transactionImmediate` (BEGIN IMMEDIATE). Because the read lives
 * inside the write-locked transaction, a trigger is ALWAYS validated against
 * FRESH state.
 *
 * THE BUG this locks in (verified in §5w): two logically-concurrent CLIs both
 * observe the same pre-crash state; CLI-B commits a T18 `cancel` (phase =
 * cancelled) FIRST; CLI-A then commits a T13 `child.exited.unexpectedly`
 * validated against its STALE pre-cancel snapshot — the crash lands as an
 * "applied" transition AFTER the cancel (an ILLEGAL post-terminal append) and
 * its projection fold silently OVERWRITES the cancel with `suspension =
 * interrupted`, cursor past both events, so `recover()` can never self-heal.
 *
 * The concurrency is modelled the way the rest of this suite models it
 * (run-ownership-store.test.ts): a `transactionImmediate`-serialised order is
 * exactly back-to-back single-threaded calls. The "A read the state before B
 * committed" window is injected with a Database wrapper that serves the STALE
 * pre-cancel snapshot for engine-state reads that happen OUTSIDE a transaction,
 * and the true committed state for reads INSIDE the transaction — which is
 * precisely what the fix changes (the old read was outside the txn, the new one
 * is inside it). With the fix, A's read is inside the write lock → it sees the
 * cancel and REJECTS the crash. Without it, A folds the stale snapshot → the
 * cancel is lost and an illegal T13 sits in the log.
 *
 * FAILS without the fix on BOTH drivers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  idempotencyKey,
  processGenerationId,
  segmentId,
  type RunId,
} from '../domain/ids.js';
import type { EventSequence } from '../domain/ids.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import {
  openTestDatabase,
  availableDriverKinds,
  type TestDatabaseHandle,
} from '../persistence/test-support.js';
import type {
  Database,
  ProjectionRecord,
  ProjectionRepository,
} from '../persistence/index.js';
import { OrchestrationService, type RoleAdapterFactory } from './service.js';
import { ENGINE_STATE_PROJECTION } from './projections.js';

const DRIVER_KINDS = await availableDriverKinds();

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const GEN = processGenerationId('pgen_f1_race');
const SEG = segmentId('seg_f1_race');

/** Minimal adapter factory — this test never spawns; it drives `ingest` directly. */
function noopFactory(): RoleAdapterFactory {
  return {
    create() {
      throw new Error('write-path-atomicity: no spawn expected in this test');
    },
  };
}

/**
 * A Database wrapper that injects the F1 stale-read window. When ARMED it
 * serves `stale` for engine-state `projections.get` calls made OUTSIDE any
 * transaction (the old, buggy pre-txn read) and the real committed record for
 * reads made INSIDE a transaction (the fixed in-txn read). Everything else is
 * delegated verbatim to the real database.
 */
function makeStaleWindowDb(real: Database): {
  readonly db: Database;
  arm(stale: ProjectionRecord<unknown>): void;
  disarm(): void;
} {
  let depth = 0;
  let stale: ProjectionRecord<unknown> | undefined;
  const realProjections = real.projections;
  const projections: ProjectionRepository = {
    get<S>(runId: RunId, name: string): ProjectionRecord<S> | undefined {
      if (stale !== undefined && name === ENGINE_STATE_PROJECTION && depth === 0) {
        return stale as ProjectionRecord<S>;
      }
      return realProjections.get<S>(runId, name);
    },
    save<S>(runId: RunId, name: string, state: S, eventCursor?: EventSequence): void {
      realProjections.save<S>(runId, name, state, eventCursor);
    },
    recover<S>(
      runId: RunId,
      name: string,
      reduceEvent: (state: S, event: DomainEvent) => S,
      initialState: S,
    ): ProjectionRecord<S> {
      return realProjections.recover<S>(runId, name, reduceEvent, initialState);
    },
  };
  const track = <T>(run: (fn: () => T) => T, fn: () => T): T => {
    depth += 1;
    try {
      return run(fn);
    } finally {
      depth -= 1;
    }
  };
  const db: Database = {
    ...real,
    projections,
    transaction: <T>(fn: () => T): T => track(real.transaction.bind(real), fn),
    transactionImmediate: <T>(fn: () => T): T => track(real.transactionImmediate.bind(real), fn),
  };
  return {
    db,
    arm: (r): void => {
      stale = r;
    },
    disarm: (): void => {
      stale = undefined;
    },
  };
}

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

describe.each(DRIVER_KINDS)('F1 write-path atomicity (%s)', (kind) => {
  it('a T13 crash validated against a STALE pre-cancel snapshot does NOT lose the cancel or append an illegal post-cancel transition', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const real = handle.db;
    const window = makeStaleWindowDb(real);
    const service = new OrchestrationService({
      db: window.db,
      ids: new DeterministicIdFactory(),
      adapterFactory: noopFactory(),
    });

    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // Seed an ACTIVE child so BOTH a T18 cancel (phase non-terminal) and a T13
    // crash (suspension none + child active + generation matches) are legal
    // from the same starting state.
    const spawned = service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: {
          generationId: GEN,
          segmentId: SEG,
          role: 'implementor',
          pins: [{ purpose: 'model', optionId: 'model', value: 'opus', effectiveValue: 'opus', echoed: true }],
        },
        idempotencyKey: idempotencyKey('f1_spawn'),
        occurredAt: real.clock.nowIso(),
      }) as DomainEvent,
    );
    expect(spawned.status).toBe('recorded');
    expect(service.status(runId).childActive).toBe(true);

    // The stale pre-cancel snapshot BOTH CLIs observed (captured off the real
    // db, so it never mutates when the row does).
    const staleRecord = real.projections.get<unknown>(runId, ENGINE_STATE_PROJECTION);
    expect(staleRecord).toBeDefined();

    // CLI-B commits the cancel FIRST → phase = cancelled, child stopped.
    const cancelled = service.ingest(
      draftEvent({
        type: 'cancel.requested',
        runId,
        payload: {},
        idempotencyKey: idempotencyKey('f1_cancel'),
        occurredAt: real.clock.nowIso(),
      }) as DomainEvent,
    );
    expect(cancelled.status).toBe('applied');
    expect(service.status(runId).phase).toBe('cancelled');

    // CLI-A now commits its T13 crash. It DECIDED to ingest while the run was
    // still pre-cancel (the armed stale window models that), but the write
    // itself happens after B's cancel is durable.
    window.arm(staleRecord!);
    const crash = service.ingest(
      draftEvent({
        type: 'child.exited.unexpectedly',
        runId,
        payload: { generationId: GEN, segmentId: SEG, exitCode: 1, classifiedAs: 'crash' },
        idempotencyKey: idempotencyKey('f1_crash'),
        occurredAt: real.clock.nowIso(),
      }) as DomainEvent,
    );
    window.disarm();

    // With the fix, the crash is validated against the FRESH (cancelled) state
    // and REJECTED — never applied against the stale snapshot.
    expect(crash.status).toBe('rejected');

    // 1) The cancel is NOT lost — the run is still terminally cancelled.
    const after = service.status(runId);
    expect(after.phase).toBe('cancelled');
    expect(after.suspension).toBe('none');

    // 2) No ILLEGAL post-cancel transition in the log: no applied
    //    `child.exited.unexpectedly` sits after the cancel.
    const types = real.events.listByRun(runId).map((e) => e.type);
    const cancelIdx = types.indexOf('cancel.requested');
    expect(cancelIdx).toBeGreaterThanOrEqual(0);
    expect(types.slice(cancelIdx + 1)).not.toContain('child.exited.unexpectedly');

    // 3) The durable projection matches a from-zero replay of the log.
    const durable = real.projections.get<{ phase: string; suspension: { kind: string } }>(
      runId,
      ENGINE_STATE_PROJECTION,
    );
    const replayed = service.recover(runId);
    expect(durable?.state.phase).toBe(replayed.phase);
    expect(durable?.state.suspension.kind).toBe(replayed.suspension.kind);
    expect(replayed.phase).toBe('cancelled');
  });
});
