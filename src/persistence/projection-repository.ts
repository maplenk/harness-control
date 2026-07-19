/**
 * ProjectionRepository (PLAN.md §6.3, §12.1, §12.3, §19 test 10).
 *
 * Stores named, opaque (JSON) projection state per run — e.g. the
 * workflow-engine's `EngineState` (../domain/transitions.ts) keyed as
 * `'engine_state'` — alongside the event sequence it was last folded
 * through (`eventCursor`). Deliberately domain-agnostic: this repository
 * doesn't know what `EngineState` or `applyTransition` are; the caller
 * supplies a plain `(state, event) => state` reducer.
 *
 * `recover()` is the crash-recovery primitive from §12.3: "replay
 * idempotent events to rebuild projections." It is INCREMENTAL — it starts
 * from whatever is currently stored (or `initialState` if nothing is) and
 * folds only the events after the stored cursor — so it works both as
 * "rebuild from nothing after a restart with an empty projections table"
 * and as the ordinary steady-state catch-up path.
 */
import type { Clock, IsoTimestamp } from '../lib/clock.js';
import { eventSequence, type EventSequence, type RunId } from '../domain/ids.js';
import type { DomainEvent } from '../domain/events.js';
import type { SqlDriver } from './driver.js';
import type { EventRepository } from './event-repository.js';
import { redactProjectionState } from './metadata-redaction.js';
import { registerRun } from './runs.js';

export interface ProjectionRecord<S> {
  readonly state: S;
  readonly eventCursor?: EventSequence;
  readonly updatedAt: IsoTimestamp;
}

export interface ProjectionRepository {
  get<S>(runId: RunId, name: string): ProjectionRecord<S> | undefined;
  /**
   * Upserts a projection's state + cursor. Meant to be called from inside
   * the SAME transaction as the event append it derives from (see
   * `./write-path.ts`), which is how §6.3's "one idempotent event append +
   * projection update in one transaction" is actually achieved: both
   * repositories share one driver/connection, so wrapping both calls in
   * `driver.transaction(() => {...})` makes them atomic together.
   */
  save<S>(runId: RunId, name: string, state: S, eventCursor?: EventSequence): void;
  /**
   * Rebuilds (or catches up) a projection by folding `reduceEvent` over
   * every event after the stored cursor (or from the beginning, if there
   * is no stored projection yet — e.g. right after a restart that lost
   * whatever was cached in memory). Persists the recovered state before
   * returning it, so a second call with nothing new to fold is a cheap
   * no-op that returns the existing record unchanged.
   */
  recover<S>(
    runId: RunId,
    name: string,
    reduceEvent: (state: S, event: DomainEvent) => S,
    initialState: S,
  ): ProjectionRecord<S>;
}

interface ProjectionRow {
  readonly run_id: string;
  readonly projection_name: string;
  readonly state_json: string;
  readonly event_cursor: number | null;
  readonly updated_at: string;
}

const SELECT_SQL =
  'SELECT run_id, projection_name, state_json, event_cursor, updated_at FROM run_projections WHERE run_id = ? AND projection_name = ?';
const UPSERT_SQL = `
  INSERT INTO run_projections (run_id, projection_name, state_json, event_cursor, updated_at)
  VALUES (?, ?, ?, ?, ?)
  ON CONFLICT (run_id, projection_name) DO UPDATE SET
    state_json = excluded.state_json,
    event_cursor = excluded.event_cursor,
    updated_at = excluded.updated_at
`;

function rowToRecord<S>(row: ProjectionRow): ProjectionRecord<S> {
  return {
    state: JSON.parse(row.state_json) as S,
    ...(row.event_cursor !== null ? { eventCursor: eventSequence(row.event_cursor) } : {}),
    updatedAt: row.updated_at as IsoTimestamp,
  };
}

export class SqliteProjectionRepository implements ProjectionRepository {
  readonly #driver: SqlDriver;
  readonly #clock: Clock;
  readonly #events: EventRepository;

  constructor(driver: SqlDriver, clock: Clock, events: EventRepository) {
    this.#driver = driver;
    this.#clock = clock;
    this.#events = events;
  }

  get<S>(runId: RunId, name: string): ProjectionRecord<S> | undefined {
    const row = this.#driver.prepare(SELECT_SQL).get<ProjectionRow>([runId, name]);
    return row ? rowToRecord<S>(row) : undefined;
  }

  save<S>(runId: RunId, name: string, state: S, eventCursor?: EventSequence): void {
    registerRun(this.#driver, this.#clock, runId);
    // W3-3 (§17.1): registered user-origin free-text state fields — and ONLY
    // those, never enums/ids/hashes/counters — are redacted HERE, the single
    // boundary every durable projection row funnels through (write-path
    // folds, service read-model saves, and `recover`'s catch-up save alike).
    const redacted = redactProjectionState(name, state);
    this.#driver
      .prepare(UPSERT_SQL)
      .run([runId, name, JSON.stringify(redacted), eventCursor ?? null, this.#clock.nowIso()]);
  }

  recover<S>(
    runId: RunId,
    name: string,
    reduceEvent: (state: S, event: DomainEvent) => S,
    initialState: S,
  ): ProjectionRecord<S> {
    return this.#driver.transaction(() => {
      const existing = this.get<S>(runId, name);
      const startState = existing ? existing.state : initialState;
      const fromSequence =
        existing?.eventCursor !== undefined
          ? (((existing.eventCursor as number) + 1) as EventSequence)
          : undefined;
      const pending = this.#events.listByRun(
        runId,
        fromSequence !== undefined ? { fromSequence } : {},
      );
      if (pending.length === 0) {
        return existing ?? { state: startState, updatedAt: this.#clock.nowIso() };
      }
      const recovered = pending.reduce(reduceEvent, startState);
      const lastCursor = pending[pending.length - 1]!.sequence;
      this.save(runId, name, recovered, lastCursor);
      return { state: recovered, eventCursor: lastCursor, updatedAt: this.#clock.nowIso() };
    });
  }
}
