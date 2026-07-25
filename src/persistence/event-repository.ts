/**
 * EventRepository (PLAN.md §6.1, §12.1, §19 test 9).
 *
 * "Repositories (P1 persistence) should assign Event.sequence at append and
 * dedupe on idempotencyKey" — this module is that repository. Domain events
 * arrive with `sequence: SEQUENCE_UNASSIGNED` (../domain/events.ts); this
 * repository assigns the real, monotonic-per-run sequence at insert time
 * and treats a repeat append under an already-seen `(run_id,
 * idempotency_key)` as the SAME logical event: no new row, no new
 * sequence — "duplicate insert = one logical event."
 */
import type { Clock, IsoTimestamp } from '../lib/clock.js';
import {
  eventSequence,
  idempotencyKey,
  runId,
  type EventSequence,
  type IdempotencyKey,
  type RunId,
} from '../domain/ids.js';
import type { AppendableEvent, DomainEvent, DomainEventType } from '../domain/events.js';
import type { SqlDriver } from './driver.js';
import { redactEventPayload } from './metadata-redaction.js';
import { registerRun } from './runs.js';

export interface AppendOutcome {
  /** The persisted event: real assigned sequence (or the pre-existing one on dedup). */
  readonly event: DomainEvent;
  /** True when `(runId, idempotencyKey)` already existed — no row was inserted. */
  readonly deduped: boolean;
}

export interface ListByRunOptions {
  /** Inclusive lower bound; omit for a full replay from sequence 1. */
  readonly fromSequence?: EventSequence;
}

export interface EventRepository {
  /**
   * Appends one event; see `appendBatch` for the transactional/dedup contract.
   *
   * B2 round 4: a precisely typed `spec.approved` must be a `ValidatedApproval`
   * — the brand only the service's binding gate mints — so an unvalidated T1
   * cannot be written into the durable log through this API without an
   * explicit, greppable cast. See `AppendableEvent`.
   */
  append(draft: AppendableEvent): AppendOutcome;
  /**
   * Appends a batch of events belonging to ONE run inside a single
   * transaction (§6.3: "one idempotent event append ... in one
   * transaction"). Each event is deduped independently against
   * `(run_id, idempotency_key)`; a mix of new and already-seen events in
   * one call is fine (e.g. re-applying a trigger + its emitted effects
   * after a crash of unknown outcome — some may already be durable).
   */
  appendBatch(drafts: readonly AppendableEvent[]): readonly AppendOutcome[];
  /** Ordered ascending by sequence; empty array if the run has no events. */
  listByRun(runId: RunId, options?: ListByRunOptions): readonly DomainEvent[];
  getByIdempotencyKey(runId: RunId, key: IdempotencyKey): DomainEvent | undefined;
  countByRun(runId: RunId): number;
}

interface EventRow {
  readonly run_id: string;
  readonly sequence: number;
  readonly type: string;
  readonly idempotency_key: string;
  readonly occurred_at: string;
  readonly payload_json: string;
}

function rowToEvent(row: EventRow): DomainEvent {
  return {
    type: row.type as DomainEventType,
    runId: runId(row.run_id),
    sequence: eventSequence(row.sequence),
    idempotencyKey: idempotencyKey(row.idempotency_key),
    occurredAt: row.occurred_at as IsoTimestamp,
    payload: JSON.parse(row.payload_json),
  } as DomainEvent;
}

const SELECT_BY_KEY_SQL =
  'SELECT run_id, sequence, type, idempotency_key, occurred_at, payload_json FROM events WHERE run_id = ? AND idempotency_key = ?';
const SELECT_COUNTER_SQL = 'SELECT next_sequence FROM run_sequence_counters WHERE run_id = ?';
const INSERT_COUNTER_SQL = 'INSERT INTO run_sequence_counters (run_id, next_sequence) VALUES (?, 2)';
const BUMP_COUNTER_SQL = 'UPDATE run_sequence_counters SET next_sequence = next_sequence + 1 WHERE run_id = ?';
const INSERT_EVENT_SQL = `
  INSERT INTO events (run_id, sequence, type, idempotency_key, occurred_at, recorded_at, payload_json)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;
const SELECT_BY_RUN_SQL =
  'SELECT run_id, sequence, type, idempotency_key, occurred_at, payload_json FROM events WHERE run_id = ? ORDER BY sequence ASC';
const SELECT_BY_RUN_FROM_SQL =
  'SELECT run_id, sequence, type, idempotency_key, occurred_at, payload_json FROM events WHERE run_id = ? AND sequence >= ? ORDER BY sequence ASC';
const COUNT_BY_RUN_SQL = 'SELECT COUNT(*) AS n FROM events WHERE run_id = ?';

export class SqliteEventRepository implements EventRepository {
  readonly #driver: SqlDriver;
  readonly #clock: Clock;

  constructor(driver: SqlDriver, clock: Clock) {
    this.#driver = driver;
    this.#clock = clock;
  }

  append(draft: AppendableEvent): AppendOutcome {
    const [outcome] = this.appendBatch([draft]);
    // appendBatch([draft]) always returns exactly one outcome for one input.
    return outcome as AppendOutcome;
  }

  appendBatch(input: readonly AppendableEvent[]): readonly AppendOutcome[] {
    const drafts = input as readonly DomainEvent[];
    if (drafts.length === 0) return [];
    const owner = drafts[0]!.runId;
    for (const draft of drafts) {
      if (draft.runId !== owner) {
        throw new Error(
          `EventRepository.appendBatch: all events in one batch must share one runId (got '${draft.runId}' and '${owner}')`,
        );
      }
    }
    return this.#driver.transaction(() => {
      registerRun(this.#driver, this.#clock, owner);
      return drafts.map((draft) => this.#appendOne(draft));
    });
  }

  #appendOne(draft: DomainEvent): AppendOutcome {
    const existing = this.#selectByKey(draft.runId, draft.idempotencyKey);
    if (existing) {
      if (existing.type !== draft.type) {
        throw new Error(
          `EventRepository: idempotency key '${draft.idempotencyKey}' for run '${draft.runId}' is already ` +
            `recorded against event type '${existing.type}' — cannot reuse it for '${draft.type}'`,
        );
      }
      return { event: existing, deduped: true };
    }
    const sequence = this.#nextSequence(draft.runId);
    // W3-3 (§17.1): registered user-origin free-text payload fields — and
    // ONLY those, never enums/ids/hashes — are redacted HERE, the single
    // boundary every durable event row funnels through. The returned event
    // carries the SAME redacted payload as the row, so the live projection
    // fold and a later replay (`listByRun` → reducer) fold identical bytes.
    const payload = redactEventPayload(draft.type, draft.payload);
    this.#driver.prepare(INSERT_EVENT_SQL).run([
      draft.runId,
      sequence,
      draft.type,
      draft.idempotencyKey,
      draft.occurredAt,
      this.#clock.nowIso(),
      JSON.stringify(payload),
    ]);
    const persisted = { ...draft, payload, sequence: eventSequence(sequence) } as DomainEvent;
    return { event: persisted, deduped: false };
  }

  #nextSequence(owner: RunId): number {
    const row = this.#driver.prepare(SELECT_COUNTER_SQL).get<{ next_sequence: number }>([owner]);
    if (row === undefined) {
      this.#driver.prepare(INSERT_COUNTER_SQL).run([owner]);
      return 1;
    }
    this.#driver.prepare(BUMP_COUNTER_SQL).run([owner]);
    return row.next_sequence;
  }

  #selectByKey(owner: RunId, key: IdempotencyKey): DomainEvent | undefined {
    const row = this.#driver.prepare(SELECT_BY_KEY_SQL).get<EventRow>([owner, key]);
    return row ? rowToEvent(row) : undefined;
  }

  listByRun(owner: RunId, options: ListByRunOptions = {}): readonly DomainEvent[] {
    const rows =
      options.fromSequence !== undefined
        ? this.#driver.prepare(SELECT_BY_RUN_FROM_SQL).all<EventRow>([owner, options.fromSequence])
        : this.#driver.prepare(SELECT_BY_RUN_SQL).all<EventRow>([owner]);
    return rows.map(rowToEvent);
  }

  getByIdempotencyKey(owner: RunId, key: IdempotencyKey): DomainEvent | undefined {
    return this.#selectByKey(owner, key);
  }

  countByRun(owner: RunId): number {
    const row = this.#driver.prepare(COUNT_BY_RUN_SQL).get<{ n: number }>([owner]);
    return row?.n ?? 0;
  }
}
