/**
 * T22 replay compatibility.
 *
 * `rss.hard_limit` predates the durable RSS stop-intent.  Events without a
 * semantics version must therefore continue to rebuild the historical
 * projection, while version 2 events record a generation-bound
 * `resource_exhaustion` intent.  Legacy orphan recovery moves forward by
 * appending `resource.exhausted`; it never changes how the old T22 itself is
 * interpreted during replay.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { draftEvent, type DomainEvent, type DomainEventType, type EventPayloads } from '../domain/events.js';
import {
  idempotencyKey,
  processGenerationId,
  runId,
  segmentId,
} from '../domain/ids.js';
import { applyTransition, initialEngineState, type EngineState } from '../domain/transitions.js';
import { isoTimestamp } from '../lib/clock.js';
import { ENGINE_STATE_PROJECTION, makeEngineReducer } from '../app/projections.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';

const DRIVER_KINDS = await availableDriverKinds();
const RUN = runId('run_t22_replay_compat');
const SEGMENT = segmentId('seg_t22_replay_compat');
const GENERATION = processGenerationId('pgen_t22_replay_compat');
const AT = isoTimestamp('2026-07-21T09:00:00.000Z');

const SEED = initialEngineState({ phase: 'implementing' });
const REDUCE = makeEngineReducer(SEED.bounds);

function event<T extends DomainEventType>(
  type: T,
  payload: EventPayloads[T],
  key: string,
): DomainEvent {
  return draftEvent({
    type,
    runId: RUN,
    payload,
    idempotencyKey: idempotencyKey(key),
    occurredAt: AT,
  }) as DomainEvent;
}

function spawnEvents(): readonly DomainEvent[] {
  return [
    event(
      'child.spawn.initiated',
      { generationId: GENERATION, segmentId: SEGMENT, role: 'implementor' },
      't22-spawn-initiated',
    ),
    event(
      'child.spawned',
      { generationId: GENERATION, segmentId: SEGMENT, role: 'implementor', pins: [] },
      't22-spawned',
    ),
  ];
}

function activeState(): EngineState {
  return spawnEvents().reduce(REDUCE, SEED);
}

function legacyT22(key = 't22-legacy'): DomainEvent {
  return event(
    'rss.hard_limit',
    {
      segmentId: SEGMENT,
      generationId: GENERATION,
      role: 'implementor',
      rssBytes: 1_600_000_000,
      budgetBytes: 1_024_000_000,
      escalation: 'graceful',
      // Deliberately no semanticsVersion: persisted v1 history.
    },
    key,
  );
}

function v2T22(): DomainEvent {
  return event(
    'rss.hard_limit',
    {
      semanticsVersion: 2,
      segmentId: SEGMENT,
      generationId: GENERATION,
      role: 'implementor',
      rssBytes: 1_600_000_000,
      budgetBytes: 1_024_000_000,
      escalation: 'graceful',
    },
    't22-v2',
  );
}

function confirmation(key = 't22-confirmed'): DomainEvent {
  return event(
    'resource.exhausted',
    {
      segmentId: SEGMENT,
      generationId: GENERATION,
      role: 'implementor',
      rssBytes: 1_600_000_000,
      budgetBytes: 1_024_000_000,
    },
    key,
  );
}

function appendT22Batch(handle: TestDatabaseHandle, trigger: DomainEvent): void {
  const outcome = applyTransition(activeState(), trigger);
  if (outcome.status !== 'applied') throw new Error(`setup: ${trigger.type} unexpectedly rejected`);
  handle.db.events.appendBatch([...spawnEvents(), trigger, ...outcome.emitted]);
}

function recover(handle: TestDatabaseHandle): EngineState {
  return handle.db.projections.recover(
    RUN,
    ENGINE_STATE_PROJECTION,
    REDUCE,
    SEED,
  ).state;
}

describe.each(DRIVER_KINDS)('T22 semantics-version replay compatibility (%s)', (kind) => {
  let handle: TestDatabaseHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('full replay keeps an unversioned legacy T22 on its historical reducer branch', async () => {
    handle = await openTestDatabase({ kind, file: false });
    appendT22Batch(handle, legacyT22());

    const recovered = recover(handle);

    expect(recovered).toMatchObject({
      phase: 'implementing',
      suspension: { kind: 'none' },
      operation: { kind: 'idle' },
      activeChild: {
        generationId: GENERATION,
        segmentId: SEGMENT,
        status: 'active',
      },
    });
    expect(recovered.activeChild).not.toHaveProperty('stopCause');
    expect(handle.db.events.listByRun(RUN).map((entry) => entry.type)).not.toContain('child.stop.intent');

    // Full recovery is idempotent and does not silently reinterpret old T22.
    expect(recover(handle)).toEqual(recovered);
  });

  it('forward-reconciles a legacy-only history by appending confirmation facts', async () => {
    handle = await openTestDatabase({ kind, file: false });
    appendT22Batch(handle, legacyT22());
    const historical = recover(handle);
    expect(historical.activeChild?.status).toBe('active');

    // This is the startup recovery contract: append a new fact; never mutate
    // or reinterpret the already-persisted legacy trigger.
    handle.db.events.append(confirmation());
    const reconciled = recover(handle);

    expect(reconciled.suspension.kind).toBe('resource_exhausted');
    expect(reconciled.activeChild).toMatchObject({
      generationId: GENERATION,
      status: 'stopped',
    });
    expect(handle.db.events.listByRun(RUN).filter((entry) => entry.type === 'rss.hard_limit'))
      .toHaveLength(1);

    // Repeated startup recovery / projection recovery is a no-op once the
    // confirmation already exists.
    expect(recover(handle)).toEqual(reconciled);
  });

  it('replays a mixed legacy T22 plus an existing confirmation idempotently', async () => {
    handle = await openTestDatabase({ kind, file: false });
    appendT22Batch(handle, legacyT22());
    handle.db.events.append(confirmation());

    const first = recover(handle);
    const second = recover(handle);

    expect(first).toEqual(second);
    expect(first.suspension.kind).toBe('resource_exhausted');
    expect(first.activeChild?.status).toBe('stopped');
    expect(handle.db.events.listByRun(RUN).filter((entry) => entry.type === 'resource.exhausted'))
      .toHaveLength(1);
  });

  it('replays T22 v2 as a durable stop intent and folds confirmation without T13', async () => {
    handle = await openTestDatabase({ kind, file: false });
    appendT22Batch(handle, v2T22());

    const intended = recover(handle);
    expect(intended.activeChild).toMatchObject({
      generationId: GENERATION,
      status: 'stopping',
      stopCause: 'resource_exhaustion',
    });
    expect(handle.db.events.listByRun(RUN)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'child.stop.intent',
          payload: expect.objectContaining({
            generationId: GENERATION,
            cause: 'resource_exhaustion',
          }),
        }),
      ]),
    );

    handle.db.events.append(confirmation('t22-v2-confirmed'));
    const confirmed = recover(handle);
    expect(confirmed.suspension.kind).toBe('resource_exhausted');
    expect(confirmed.activeChild?.status).toBe('stopped');
    expect(confirmed.counters.restartsInWindow).toBe(0);
    expect(confirmed.counters.lifetimeRestarts).toBe(0);
    expect(handle.db.events.listByRun(RUN).map((entry) => entry.type)).not.toContain(
      'child.exited.unexpectedly',
    );
  });
});
