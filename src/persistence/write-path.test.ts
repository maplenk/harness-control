/**
 * §6.3: "Every transition is one idempotent event append + projection
 * update in one transaction." · §12.1: "transactions wrap event append +
 * projection update." This is the dedicated test for that composed
 * guarantee (event-repository.test.ts and projection-repository.test.ts
 * exercise the two repositories individually; this file exercises them
 * TOGETHER through `appendTriggerWithEffects`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { isoTimestamp } from '../lib/clock.js';
import { idempotencyKey, runId } from '../domain/ids.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import { appendTriggerWithEffects } from './write-path.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';
import { appendableEvent } from '../domain/events.js';

const DRIVER_KINDS = await availableDriverKinds();
const RUN = runId('run_writepath_1');
const AT = isoTimestamp('2026-07-18T10:00:00.000Z');
const PROJECTION_NAME = 'demo_counter';

interface CounterState {
  readonly count: number;
}

function trigger(key: string): DomainEvent {
  return draftEvent({
    type: 'pause.user.requested',
    runId: RUN,
    payload: {},
    idempotencyKey: idempotencyKey(key),
    occurredAt: AT,
  }) as DomainEvent;
}

function effect(key: string): DomainEvent {
  return draftEvent({
    type: 'checkpoint.requested',
    runId: RUN,
    payload: { reason: 'pre_pause' },
    idempotencyKey: idempotencyKey(key),
    occurredAt: AT,
  }) as DomainEvent;
}

describe.each(DRIVER_KINDS)('appendTriggerWithEffects (%s) — one-transaction event+projection write', (kind) => {
  let handle: TestDatabaseHandle | undefined;
  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('appends the trigger + its emitted effects and updates the projection in one call', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;

    const result = appendTriggerWithEffects(db, appendableEvent(trigger('t1')), [appendableEvent(effect('e1'))], {
      name: PROJECTION_NAME,
      currentState: { count: 0 } as CounterState,
      reduceEvent: (state: CounterState) => ({ count: state.count + 1 }),
    });

    expect(result.appended.map((o) => o.deduped)).toEqual([false, false]);
    expect(result.projection.state).toEqual({ count: 1 });
    expect(db.events.countByRun(RUN)).toBe(2);
    expect(db.projections.get(RUN, PROJECTION_NAME)).toEqual(result.projection);
  });

  it('is idempotent end-to-end: replaying the identical trigger+emitted batch leaves events and projection exactly where they were', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;
    const projectionUpdate = {
      name: PROJECTION_NAME,
      currentState: { count: 0 } as CounterState,
      reduceEvent: (state: CounterState) => ({ count: state.count + 1 }),
    };

    const first = appendTriggerWithEffects(db, appendableEvent(trigger('t2')), [appendableEvent(effect('e2'))], projectionUpdate);
    // Caller retries from the same pre-transaction snapshot (unknown outcome after a crash).
    const second = appendTriggerWithEffects(db, appendableEvent(trigger('t2')), [appendableEvent(effect('e2'))], projectionUpdate);

    expect(second.appended.every((o) => o.deduped)).toBe(true);
    expect(second.projection).toEqual(first.projection);
    expect(second.projection.state).toEqual({ count: 1 }); // NOT double-incremented to 2
    expect(db.events.countByRun(RUN)).toBe(2);
  });

  it('rolls back BOTH the event append and the projection update together when the projection step throws', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;

    expect(() =>
      appendTriggerWithEffects(db, appendableEvent(trigger('t3')), [appendableEvent(effect('e3'))], {
        name: PROJECTION_NAME,
        currentState: { count: 0 } as CounterState,
        reduceEvent: (): CounterState => {
          throw new Error('reducer bug');
        },
      }),
    ).toThrow('reducer bug');

    // Neither the trigger nor its emitted effect was persisted: they sink together.
    expect(db.events.countByRun(RUN)).toBe(0);
    expect(db.projections.get(RUN, PROJECTION_NAME)).toBeUndefined();
  });

  it('a DEDUPED trigger skips the re-fold: replaying from the CURRENT (already-folded) state never double-counts, and the key/type conflict stays loud', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;
    const reduceEvent = (state: CounterState): CounterState => ({ count: state.count + 1 });

    const first = appendTriggerWithEffects(db, appendableEvent(trigger('t5')), [appendableEvent(effect('e5'))], {
      name: PROJECTION_NAME,
      currentState: { count: 0 } as CounterState,
      reduceEvent,
    });
    expect(first.projection.state).toEqual({ count: 1 });

    // The realistic duplicate (the P4a R-B defect): the caller reloads the
    // CURRENT projection — already folded to 1 — and re-appends under the
    // same idempotency key. The write path must recognize the deduped
    // trigger and skip the fold + save, NOT count to 2.
    const replay = appendTriggerWithEffects(db, appendableEvent(trigger('t5')), [appendableEvent(effect('e5'))], {
      name: PROJECTION_NAME,
      currentState: first.projection.state,
      reduceEvent,
    });
    expect(replay.appended[0]?.deduped).toBe(true);
    expect(replay.projection.state).toEqual({ count: 1 }); // NOT double-incremented
    expect(db.projections.get<CounterState>(RUN, PROJECTION_NAME)?.state).toEqual({ count: 1 });
    expect(db.events.countByRun(RUN)).toBe(2); // one logical trigger + one effect

    // The LOUD path is intact: the same key under a DIFFERENT event type is
    // a hard conflict (§6.1), never a silent dedupe — and it changes nothing.
    expect(() =>
      appendTriggerWithEffects(db, appendableEvent(effect('t5')), [], {
        name: PROJECTION_NAME,
        currentState: first.projection.state,
        reduceEvent,
      }),
    ).toThrow(/cannot reuse it for/);
    expect(db.projections.get<CounterState>(RUN, PROJECTION_NAME)?.state).toEqual({ count: 1 });
    expect(db.events.countByRun(RUN)).toBe(2);
  });

  it('W2-3: extraEvents commit in the SAME transaction (the pauseForLimit composite append), cursor covering them, folded only once', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;
    const projectionUpdate = {
      name: PROJECTION_NAME,
      currentState: { count: 0 } as CounterState,
      reduceEvent: (state: CounterState) => ({ count: state.count + 1 }),
    };

    const result = appendTriggerWithEffects(
      db,
      appendableEvent(trigger('t4')),
      [appendableEvent(effect('e4'))],
      projectionUpdate,
      [appendableEvent(effect('x4'))], // e.g. checkpoint.recorded riding the pause append
    );

    expect(result.appended.map((o) => o.deduped)).toEqual([false, false, false]);
    // The extra event is durable, the projection folded ONLY the trigger,
    // and the cursor advanced past the whole batch (extras included).
    expect(result.projection.state).toEqual({ count: 1 });
    expect(db.events.countByRun(RUN)).toBe(3);
    const last = result.appended[result.appended.length - 1]!;
    expect(result.projection.eventCursor).toBe(last.event.sequence);

    // Replaying the identical composite batch dedupes every member.
    const replay = appendTriggerWithEffects(db, appendableEvent(trigger('t4')), [appendableEvent(effect('e4'))], projectionUpdate, [
      appendableEvent(effect('x4')),
    ]);
    expect(replay.appended.every((o) => o.deduped)).toBe(true);
    expect(db.events.countByRun(RUN)).toBe(3);
  });

  it('F1: `alreadyInTransaction` JOINS the caller-owned BEGIN IMMEDIATE (no nested BEGIN) and commits/rolls back with it', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const db = handle.db;
    const projectionUpdate = {
      name: PROJECTION_NAME,
      currentState: { count: 0 } as CounterState,
      reduceEvent: (state: CounterState) => ({ count: state.count + 1 }),
    };

    // Inside an outer transactionImmediate (the F1 primitive's shape), calling
    // with `alreadyInTransaction` must NOT open a second BEGIN — it joins the
    // caller's txn — and the whole unit commits atomically.
    const result = db.transactionImmediate(() =>
      appendTriggerWithEffects(db, appendableEvent(trigger('t6')), [appendableEvent(effect('e6'))], projectionUpdate, [], {
        alreadyInTransaction: true,
      }),
    );
    expect(result.projection.state).toEqual({ count: 1 });
    expect(db.events.countByRun(RUN)).toBe(2);
    expect(db.projections.get(RUN, PROJECTION_NAME)?.state).toEqual({ count: 1 });

    // And it rolls back WITH the caller's txn: an error thrown after the join
    // aborts the append+fold too (nothing new committed).
    expect(() =>
      db.transactionImmediate(() => {
        appendTriggerWithEffects(db, appendableEvent(trigger('t7')), [appendableEvent(effect('e7'))], projectionUpdate, [], {
          alreadyInTransaction: true,
        });
        throw new Error('abort the enclosing transaction');
      }),
    ).toThrow('abort the enclosing transaction');
    expect(db.events.countByRun(RUN)).toBe(2); // t7/e7 rolled back with the outer txn
    expect(db.projections.get(RUN, PROJECTION_NAME)?.state).toEqual({ count: 1 });
  });
});
