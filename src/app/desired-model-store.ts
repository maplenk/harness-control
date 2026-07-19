/**
 * Durable DESIRED-model records (W4-2 switch-model, §11.2 / §5t).
 *
 * `switch-model` at the CLI holds NO live session — the effective model per role
 * is already durable in `child.spawned` pins (the read-model), but a NEW target
 * the user asks for BEFORE the next spawn has nowhere durable to live. This
 * store is that home: a DISTINCT desired-model row per (runId, role) that maps
 * to NO transition (§5t S1: the intent CANNOT be `model.switch.requested` —
 * ingest is 1:1 with a transition and would DRIVE T19, fabricating a segment on
 * an idle live child). It is a plain durable record, never an event.
 *
 * The gate is honest (§5t (3)): recording a desired model NEVER fabricates a
 * segment and NEVER silently no-ops. When no live child owns the run the desired
 * model is applied at the next spawn via the existing `initial_config_pin` /
 * model-pin (F8) machinery; when a live child owns the run the record is still
 * written and the user is told it is queued for the next spawn/turn boundary
 * (live in-place apply is the deferred follow-up). `status` reads this store to
 * show the pending desired model DISTINCT from the effective (running) one.
 *
 * Backed by the existing SQLite projection layer under a reserved scope id
 * (mirrors `DurableSpawnReservationStore` / `DurableRunOwnershipStore`), so the
 * record survives a crash and `list()` sees every run's desired models under one
 * blob. A later `switch-model` for the same (runId, role) OVERWRITES the row
 * (last-write-wins — one desired model per role at a time).
 */
import { runId, type RunId } from '../domain/ids.js';
import type { RoleName } from '../domain/state.js';
import type { Database } from '../persistence/index.js';

/** Reserved projection scope for cross-process desired-model records. */
export const DESIRED_MODEL_SCOPE: RunId = runId('run__desired_model');
export const DESIRED_MODEL_PROJECTION = 'desired_model';

/** One durable desired-model record — no secrets, JSON-serializable. */
export interface DesiredModelRecord {
  /** The run the desired model applies to. */
  readonly runId: string;
  /** The role whose model the user wants to switch. */
  readonly role: RoleName;
  readonly harness: string;
  /** The requested provider model slug (e.g. `opus`, `gpt-5.6-terra`). */
  readonly model: string;
  readonly effort?: string;
  readonly requestedAt: string;
}

interface DesiredModelProjectionState {
  readonly desired: Record<string, DesiredModelRecord>;
}

const EMPTY_STATE: DesiredModelProjectionState = { desired: {} };

/** Composite key: one desired model per (run, role) at a time. */
function keyOf(runIdValue: string, role: RoleName): string {
  return `${runIdValue}::${role}`;
}

export class DurableDesiredModelStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Every desired-model record across every run (as persisted). */
  list(): readonly DesiredModelRecord[] {
    return Object.values(this.#load().desired);
  }

  /** The desired model pending for a (run, role), if any. */
  get(runIdValue: RunId, role: RoleName): DesiredModelRecord | undefined {
    return this.#load().desired[keyOf(String(runIdValue), role)];
  }

  /** Every desired-model record for a single run (one per role at most). */
  listForRun(runIdValue: RunId): readonly DesiredModelRecord[] {
    const prefix = `${String(runIdValue)}::`;
    return Object.entries(this.#load().desired)
      .filter(([key]) => key.startsWith(prefix))
      .map(([, record]) => record);
  }

  /**
   * Record (upsert, last-write-wins) the desired model for a (run, role). Runs
   * in one transaction so a concurrent writer for a DIFFERENT (run, role) never
   * clobbers this row.
   */
  set(record: DesiredModelRecord): void {
    this.#db.transaction(() => {
      const desired = { ...this.#load().desired };
      desired[keyOf(record.runId, record.role)] = record;
      this.#save(desired);
    });
  }

  /** Clear the desired model for a (run, role) once it has been applied. */
  clear(runIdValue: RunId, role: RoleName): void {
    this.#db.transaction(() => {
      const desired = { ...this.#load().desired };
      if (desired[keyOf(String(runIdValue), role)] === undefined) return;
      delete desired[keyOf(String(runIdValue), role)];
      this.#save(desired);
    });
  }

  #load(): DesiredModelProjectionState {
    return (
      this.#db.projections.get<DesiredModelProjectionState>(
        DESIRED_MODEL_SCOPE,
        DESIRED_MODEL_PROJECTION,
      )?.state ?? EMPTY_STATE
    );
  }

  #save(desired: Record<string, DesiredModelRecord>): void {
    this.#db.projections.save(DESIRED_MODEL_SCOPE, DESIRED_MODEL_PROJECTION, { desired });
  }
}
