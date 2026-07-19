/**
 * §19 test 9: "duplicate notification = one logical event."
 *
 * Provider notifications (and the application service's own retries of a
 * transition whose outcome is unknown after a crash) can arrive more than
 * once carrying the SAME idempotency key. `EventRepository` must treat a
 * repeat append under an already-seen `(run_id, idempotency_key)` as the
 * identical logical event: no second row, no sequence burned, no gap.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isoTimestamp } from '../lib/clock.js';
import { idempotencyKey, runId, segmentId } from '../domain/ids.js';
import { draftEvent, type DomainEvent, type DomainEventType, type EventPayloads } from '../domain/events.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';

const DRIVER_KINDS = await availableDriverKinds();
const RUN = runId('run_evt_1');
const SEG = segmentId('seg_evt_1');
const AT = isoTimestamp('2026-07-18T10:00:00.000Z');

function ev<T extends DomainEventType>(type: T, payload: EventPayloads[T], key: string, runIdOverride = RUN): DomainEvent {
  return draftEvent({
    type,
    runId: runIdOverride,
    payload,
    idempotencyKey: idempotencyKey(key),
    occurredAt: AT,
  }) as DomainEvent;
}

describe.each(DRIVER_KINDS)('EventRepository (%s) — §19 test 9', (kind) => {
  let handle: TestDatabaseHandle;

  beforeEach(async () => {
    handle = await openTestDatabase({ kind, file: false });
  });
  afterEach(() => {
    handle.close();
    handle.cleanup();
  });

  it('a redelivered provider notification (same idempotency key) does not create a second row or burn a new sequence', () => {
    const notification = ev(
      'limit.classified.prompt_turn',
      {
        segmentId: SEG,
        classification: {
          kind: 'usage_limit',
          provider: 'claude',
          source: 'structured',
          confidence: 'high',
          detectionTier: 'structured',
        },
      },
      'provider-notification-abc',
    );

    const first = handle.db.events.append(notification);
    expect(first.deduped).toBe(false);
    expect(first.event.sequence).toBe(1);

    // The SAME provider notification is redelivered (at-least-once delivery).
    const second = handle.db.events.append(notification);
    expect(second.deduped).toBe(true);
    expect(second.event.sequence).toBe(1); // no new sequence burned
    expect(second.event).toEqual(first.event);

    expect(handle.db.events.countByRun(RUN)).toBe(1);
    expect(handle.db.events.listByRun(RUN)).toHaveLength(1);

    // A genuinely different event still advances the counter by exactly one.
    const other = handle.db.events.append(ev('pause.user.requested', {}, 'distinct-key'));
    expect(other.event.sequence).toBe(2);
    expect(handle.db.events.countByRun(RUN)).toBe(2);
  });

  it('dedupes an entire re-appended trigger+emitted batch (e.g. retried after an unknown-outcome crash)', () => {
    const trigger = ev('pause.user.requested', {}, 'trigger-1');
    const effectA = ev('checkpoint.requested', { reason: 'pre_pause' }, 'effect-a');
    const effectB = ev('segment.stop.requested', { mode: 'graceful' }, 'effect-b');

    const firstBatch = handle.db.events.appendBatch([trigger, effectA, effectB]);
    expect(firstBatch.map((o) => o.deduped)).toEqual([false, false, false]);
    expect(firstBatch.map((o) => o.event.sequence)).toEqual([1, 2, 3]);

    // Caller doesn't know whether the batch landed before a crash — retries the identical batch.
    const secondBatch = handle.db.events.appendBatch([trigger, effectA, effectB]);
    expect(secondBatch.map((o) => o.deduped)).toEqual([true, true, true]);
    expect(secondBatch.map((o) => o.event.sequence)).toEqual([1, 2, 3]);
    // The events themselves (ignoring the `deduped` flag, which correctly
    // differs between the first and second call) are byte-for-byte the same.
    expect(secondBatch.map((o) => o.event)).toEqual(firstBatch.map((o) => o.event));

    expect(handle.db.events.countByRun(RUN)).toBe(3);
  });

  it('dedupes a PARTIALLY-seen batch: some events already durable, some new', () => {
    const trigger = ev('pause.user.requested', {}, 'trigger-2');
    handle.db.events.append(trigger); // only the trigger landed before "the crash"

    const effectA = ev('checkpoint.requested', { reason: 'pre_pause' }, 'effect-a2');
    const effectB = ev('segment.stop.requested', { mode: 'graceful' }, 'effect-b2');
    const retried = handle.db.events.appendBatch([trigger, effectA, effectB]);

    expect(retried.map((o) => o.deduped)).toEqual([true, false, false]);
    expect(retried.map((o) => o.event.sequence)).toEqual([1, 2, 3]);
    expect(handle.db.events.countByRun(RUN)).toBe(3);
  });

  it('rejects reusing an idempotency key for a different event type (key collision is a caller bug)', () => {
    handle.db.events.append(ev('pause.user.requested', {}, 'shared-key'));
    expect(() => handle.db.events.append(ev('resume.user.requested', {}, 'shared-key'))).toThrow(
      /idempotency key/i,
    );
    // The failed attempt must not have consumed a sequence number or left a partial row.
    expect(handle.db.events.countByRun(RUN)).toBe(1);
  });

  it('assigns a strictly monotonic, gapless per-run sequence across many appends', () => {
    for (let i = 0; i < 5; i += 1) {
      handle.db.events.append(ev('pause.user.requested', {}, `key-${i}`));
    }
    const events = handle.db.events.listByRun(RUN);
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
  });

  it('keeps independent sequence counters per run', () => {
    const otherRun = runId('run_evt_2');
    handle.db.events.append(ev('pause.user.requested', {}, 'a', RUN));
    handle.db.events.append(ev('pause.user.requested', {}, 'b', otherRun));
    handle.db.events.append(ev('resume.user.requested', {}, 'c', RUN));

    expect(handle.db.events.listByRun(RUN).map((e) => e.sequence)).toEqual([1, 2]);
    expect(handle.db.events.listByRun(otherRun).map((e) => e.sequence)).toEqual([1]);
  });

  it('listByRun supports replay-by-sequence from a given cursor (fromSequence)', () => {
    for (let i = 0; i < 4; i += 1) {
      handle.db.events.append(ev('pause.user.requested', {}, `seq-${i}`));
    }
    const fromThree = handle.db.events.listByRun(RUN, { fromSequence: handle.db.events.listByRun(RUN)[2]!.sequence });
    expect(fromThree.map((e) => e.sequence)).toEqual([3, 4]);
  });

  it('getByIdempotencyKey finds the persisted event and round-trips its payload', () => {
    const trigger = ev(
      'model.switch.requested',
      { segmentId: SEG, fromModel: 'sonnet', toModel: 'opus', mechanism: 'session/set_config_option' },
      'switch-1',
    );
    handle.db.events.append(trigger);
    const found = handle.db.events.getByIdempotencyKey(RUN, idempotencyKey('switch-1'));
    expect(found).toBeDefined();
    expect(found?.payload).toEqual(trigger.payload);
    expect(handle.db.events.getByIdempotencyKey(RUN, idempotencyKey('nope'))).toBeUndefined();
  });
});
