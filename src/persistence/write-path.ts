/**
 * The concrete write pattern §6.3 requires: "Every transition is one
 * idempotent event append + projection update in one transaction." The
 * application/engine layer (not owned by this package) calls
 * `../domain/transitions.js`'s pure `applyTransition(state, event)` to get
 * `{next, emitted}`, then calls this function to make it durable. Provided
 * as a tested primitive rather than left as "wrap two repository calls in
 * `db.transaction`" — §19 tests 9 and 10 both exercise it.
 */
import type { AppendableEvent, DomainEvent } from '../domain/events.js';
import type { Database } from './database.js';
import type { AppendOutcome } from './event-repository.js';
import type { ProjectionRecord } from './projection-repository.js';

export interface ProjectionUpdate<S> {
  readonly name: string;
  readonly currentState: S;
  /** Folds only the TRIGGER event (mirrors `applyTransition`'s own contract: `emitted` are effects, not further inputs). */
  readonly reduceEvent: (state: S, event: DomainEvent) => S;
}

export interface AppendWithProjectionResult<S> {
  readonly appended: readonly AppendOutcome[];
  readonly projection: ProjectionRecord<S>;
}

export interface AppendTriggerOptions {
  /**
   * F1 (§5x, Approach A): the caller has ALREADY opened the enclosing
   * (`BEGIN IMMEDIATE`) transaction — the atomic read-validate-append the
   * service funnels every state change through. When true, this append+fold
   * JOINS that outer transaction instead of nesting a second `db.transaction`
   * (a needless SAVEPOINT on better-sqlite3, a shared-transaction no-op on
   * node:sqlite). The read that produced `projection.currentState` MUST live
   * inside the same write-locked transaction so a concurrently committed
   * transition is seen and an incompatible trigger is rejected — hence the
   * caller owns the `BEGIN` and this function must not re-wrap.
   */
  readonly alreadyInTransaction?: boolean;
}

/**
 * Appends `trigger` followed by `emitted` (matching `applyTransition`'s
 * `{transitionId, next, emitted}` output shape) and folds the trigger event
 * through `projection.reduceEvent`, persisting the resulting state — all
 * inside ONE transaction. Idempotent: replaying the same trigger+emitted
 * batch (e.g. after a crash of unknown outcome) dedupes every event via
 * `EventRepository` and leaves the projection where it already was — a
 * DEDUPED trigger skips the reducer fold and the projection save entirely
 * (the fold already happened when the trigger first committed; re-folding
 * over the current state would double-count), and the result carries the
 * stored projection unchanged with `appended[0].deduped === true`.
 *
 * `extraEvents` (W2-3): additional supporting events committed in the SAME
 * transaction, after the engine-emitted effects. The `pauseForLimit`
 * composite append uses it for `checkpoint.recorded` — the §12.2 rule
 * ("event commits after artifact fsync, in the same transaction as the state
 * transition") plus the pause spine's "ONE atomic append" both land here.
 * Like `emitted`, extras are effects/facts, never further reducer inputs.
 */
export function appendTriggerWithEffects<S, E extends DomainEvent = DomainEvent>(
  db: Database,
  // B2 round 4: the trigger reaches the durable log, so it carries the same
  // brand requirement as `EventRepository.append` — a precisely typed
  // `spec.approved` must be a `ValidatedApproval`. See `AppendableEvent`.
  trigger: AppendableEvent<E>,
  emitted: readonly DomainEvent[],
  projection: ProjectionUpdate<S>,
  extraEvents: readonly DomainEvent[] = [],
  options: AppendTriggerOptions = {},
): AppendWithProjectionResult<S> {
  const body = (): AppendWithProjectionResult<S> => {
    // The brand requirement is discharged at THIS function's boundary (above),
    // so the batch is widened here rather than re-asserted per element.
    const batch: readonly DomainEvent[] = [trigger as DomainEvent, ...emitted, ...extraEvents];
    const appended = db.events.appendBatch(batch);
    const triggerOutcome = appended[0];
    const lastOutcome = appended[appended.length - 1];
    if (!triggerOutcome || !lastOutcome) {
      throw new Error('appendTriggerWithEffects: appendBatch returned no outcome for the trigger event');
    }
    if (triggerOutcome.deduped) {
      // §6.1 "duplicate insert = one logical event": the trigger is ALREADY
      // durable, so its fold already happened in the transaction that first
      // committed it. Re-folding here would apply the reducer a second time
      // over the CURRENT (already-folded) state — double-counting counters —
      // so the fold AND the projection save are skipped; the caller
      // distinguishes the replay via `appended[0].deduped` (the event
      // repository's own status vocabulary).
      const existing = db.projections.get<S>(trigger.runId, projection.name);
      return {
        appended,
        projection: existing ?? { state: projection.currentState, updatedAt: db.clock.nowIso() },
      };
    }
    const nextState = projection.reduceEvent(projection.currentState, triggerOutcome.event);
    // Cursor advances to the LAST event in the batch (trigger + all its
    // emitted effects + extras), not just the trigger's own sequence: the
    // reducer contract only reacts to trigger events, so the emitted/extra
    // ones are already "accounted for" and a future `recover()` call
    // shouldn't re-scan them.
    db.projections.save(trigger.runId, projection.name, nextState, lastOutcome.event.sequence);
    const saved = db.projections.get<S>(trigger.runId, projection.name);
    if (!saved) {
      throw new Error('appendTriggerWithEffects: projection save/get round-trip failed unexpectedly');
    }
    return { appended, projection: saved };
  };
  // §6.3 "one transaction": when the caller already holds the enclosing
  // `BEGIN IMMEDIATE` (F1's atomic read-validate-append), join it; otherwise
  // open our own so a bare `appendTriggerWithEffects` stays self-contained.
  return options.alreadyInTransaction ? body() : db.transaction(body);
}
