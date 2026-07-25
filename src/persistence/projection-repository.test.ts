/**
 * §19 test 10: "restart between event append and projection recovers via
 * replay."
 *
 * Scenario: the event log and the `run_projections` table are NOT always
 * in lockstep from a recovering process's point of view — a batch of
 * events can be durably appended (e.g. by whatever committed the
 * transaction) while the projection that folds them was never updated
 * (crashed before that step, or this is the very first projector run).
 * `ProjectionRepository.recover` (§12.3: "replay idempotent events to
 * rebuild projections") must reconstruct the CORRECT projection purely
 * from what's in the event log, whether that means an incremental catch-up
 * from a stale-but-present projection or a full replay from nothing.
 *
 * The reducer used here is the REAL workflow engine
 * (`../domain/transitions.js`'s `applyTransition`), folded only over
 * TRIGGER events (its own contract) — this is deliberately the realistic
 * shape of what the application layer would pass in, not a toy reducer, so
 * the test exercises genuine event storage/ordering/retrieval fidelity
 * rather than a strawman.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../lib/clock.js';
import { idempotencyKey, processGenerationId, runId, segmentId } from '../domain/ids.js';
import { draftEvent, type DomainEvent, type DomainEventType, type EventPayloads } from '../domain/events.js';
import {
  TRIGGER_EVENT_TYPES,
  applyTransition,
  initialEngineState,
  type EngineState,
} from '../domain/transitions.js';
import { openDatabase } from './database.js';
import { appendTriggerWithEffects } from './write-path.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';
import { appendableEvent, appendableEvents } from '../domain/events.js';

const DRIVER_KINDS = await availableDriverKinds();
const PROJECTION_NAME = 'engine_state';
const RUN = runId('run_recovery_1');
const SEG = segmentId('seg_recovery_1');
const GEN = processGenerationId('pgen_recovery_1');
const AT = isoTimestamp('2026-07-18T10:00:00.000Z');

function ev<T extends DomainEventType>(type: T, payload: EventPayloads[T], key: string): DomainEvent {
  return draftEvent({ type, runId: RUN, payload, idempotencyKey: idempotencyKey(key), occurredAt: AT }) as DomainEvent;
}

/** The reducer an application service would pass to `recover()`: only trigger events move `EngineState`. */
function reduceEngineState(state: EngineState, event: DomainEvent): EngineState {
  if (!(TRIGGER_EVENT_TYPES as readonly string[]).includes(event.type)) return state;
  const outcome = applyTransition(state, event);
  return outcome.status === 'applied' ? outcome.next : state;
}

// W2-1 trigger sequence: T11 pause (stop-intent; suspension defers to the
// stop confirmation) → T13 crash of the stopping child (→ interrupted) →
// T12 manual resume from interrupted. All three legal in order.
const TRIGGER_1 = ev('pause.user.requested', {}, 'k1-pause');
const TRIGGER_2 = ev(
  'child.exited.unexpectedly',
  { segmentId: SEG, generationId: GEN, exitCode: 1, classifiedAs: 'crash' },
  'k2-crash',
);
const TRIGGER_3 = ev('resume.user.requested', {}, 'k3-resume');

const SEED_STATE = (): EngineState =>
  initialEngineState({
    phase: 'implementing',
    operation: { kind: 'idle' },
    activeChild: { generationId: GEN, segmentId: SEG, status: 'active' },
  });

describe.each(DRIVER_KINDS)('ProjectionRepository.recover (%s) — §19 test 10', (kind) => {
  let handle: TestDatabaseHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('reconstructs the correct projection when events were durably appended but the projection update never ran, across a real close+reopen', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const db1 = handle.db;

    // ---- steps 1-2: NORMAL path — event append + projection update atomic ----
    let state = SEED_STATE();
    const outcome1 = applyTransition(state, TRIGGER_1);
    if (outcome1.status !== 'applied') throw new Error('setup: TRIGGER_1 unexpectedly rejected');
    const step1 = appendTriggerWithEffects(db1, appendableEvent(TRIGGER_1), appendableEvents(outcome1.emitted), {
      name: PROJECTION_NAME,
      currentState: state,
      reduceEvent: reduceEngineState,
    });
    state = outcome1.next;
    expect(step1.projection.state).toEqual(state);

    const outcome2 = applyTransition(state, TRIGGER_2);
    if (outcome2.status !== 'applied') throw new Error('setup: TRIGGER_2 unexpectedly rejected');
    const step2 = appendTriggerWithEffects(db1, appendableEvent(TRIGGER_2), appendableEvents(outcome2.emitted), {
      name: PROJECTION_NAME,
      currentState: state,
      reduceEvent: reduceEngineState,
    });
    state = outcome2.next;
    expect(step2.projection.state).toEqual(state);
    const cursorBeforeCrash = step2.projection.eventCursor;

    // ---- step 3: simulate "the process crashed after committing the event
    // append but before the projection update ran" — append the trigger's
    // full effect batch through the RAW event repository only. ----
    const outcome3 = applyTransition(state, TRIGGER_3);
    if (outcome3.status !== 'applied') throw new Error('setup: TRIGGER_3 unexpectedly rejected');
    db1.events.appendBatch(appendableEvents([TRIGGER_3, ...outcome3.emitted]));
    // Deliberately NOT calling db1.projections.save here.
    const expected = outcome3.next; // ground truth: what full processing WOULD have produced

    expect(db1.events.countByRun(RUN)).toBe(10); // (1 trigger + 4 emitted) + (1 + 2) + (1 + 1)
    expect(db1.projections.get(RUN, PROJECTION_NAME)?.eventCursor).toBe(cursorBeforeCrash); // still stale

    handle.close(); // simulate the orchestrator process exiting

    // ---- "restart": fresh Database instance over the SAME file ----
    const db2 = await openDatabase({
      filename: handle.filename,
      driver: kind,
      casRoot: handle.casRoot,
      clock: new ManualClock('2026-07-18T11:00:00.000Z'),
    });
    try {
      const staleOnRestart = db2.projections.get<EngineState>(RUN, PROJECTION_NAME);
      expect(staleOnRestart?.eventCursor).toBe(cursorBeforeCrash);
      expect(staleOnRestart?.state).not.toEqual(expected); // proves recovery below did real work

      const recovered = db2.projections.recover<EngineState>(
        RUN,
        PROJECTION_NAME,
        reduceEngineState,
        SEED_STATE(),
      );

      expect(recovered.state).toEqual(expected);
      expect(recovered.eventCursor).toBe(10); // last event of the whole run, not just the last trigger

      // Recovery PERSISTS: a fresh read (no recover() call) now returns the caught-up state.
      const persisted = db2.projections.get<EngineState>(RUN, PROJECTION_NAME);
      expect(persisted?.state).toEqual(expected);
      expect(persisted?.eventCursor).toBe(10);

      // Idempotent: nothing new to fold, second call is a no-op that returns the same record.
      const again = db2.projections.recover<EngineState>(RUN, PROJECTION_NAME, reduceEngineState, SEED_STATE());
      expect(again).toEqual(recovered);
    } finally {
      db2.close();
    }
  });

  it('replays a run whose projection was NEVER written (fresh recovery from nothing)', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;

    const s0 = SEED_STATE();
    const o1 = applyTransition(s0, TRIGGER_1);
    if (o1.status !== 'applied') throw new Error('setup: TRIGGER_1 unexpectedly rejected');
    const o2 = applyTransition(o1.next, TRIGGER_2);
    if (o2.status !== 'applied') throw new Error('setup: TRIGGER_2 unexpectedly rejected');
    const expected = o2.next;

    // Raw append only — no projection ever saved for this run.
    db.events.appendBatch(appendableEvents([TRIGGER_1, ...o1.emitted]));
    db.events.appendBatch(appendableEvents([TRIGGER_2, ...o2.emitted]));
    expect(db.projections.get(RUN, PROJECTION_NAME)).toBeUndefined();

    const recovered = db.projections.recover<EngineState>(RUN, PROJECTION_NAME, reduceEngineState, SEED_STATE());

    expect(recovered.state).toEqual(expected);
    expect(recovered.eventCursor).toBe(8); // (1 trigger+4 emitted) + (1 trigger+2 emitted) = events 1..8
    expect(db.projections.get(RUN, PROJECTION_NAME)?.state).toEqual(expected);
  });

  it('recover() is a no-op that returns the existing record unchanged when there is nothing pending and nothing stored', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const initial = initialEngineState();
    const recovered = handle.db.projections.recover<EngineState>(
      runId('run_never_seen'),
      PROJECTION_NAME,
      reduceEngineState,
      initial,
    );
    expect(recovered.state).toEqual(initial);
    expect(recovered.eventCursor).toBeUndefined();
  });
});
