/**
 * Durable per-incident FAILOVER ladder position (P4b wave 2, §5cc/§5ee).
 *
 * FAILOVER routes on the PROVEN successor spine: when a role hits a usage limit
 * and its assignment `failoverPolicy` is `switch_model`/`switch_harness`, the
 * lease-holding owner self-drives `recordSuccessorIntent` with the NEXT ladder
 * target instead of waiting for the probe ladder. The ladder walk is bounded
 * PER INCIDENT (`maxFailoversPerIncident`) by its OWN counter — deliberately
 * DISTINCT from, and never fed into, the §14 crash breaker (a failover
 * successor's LATER crash still feeds the breaker under the same assignmentId).
 *
 * This store is that counter's durable home: one row per (runId, assignmentId)
 * holding the next ladder POSITION to escalate to. It is crash-safe by riding
 * the existing SQLite projection layer under a reserved scope id (mirrors
 * `DurableDesiredModelStore` / `DurableRunOwnershipStore` / the spawn-reservation
 * store), so a crash mid-failover leaves the ladder position exactly where the
 * last committed step left it and the restarted owner re-reads it verbatim.
 *
 * The position is RESET (cleared) the moment the run makes real progress past a
 * limit — a role dispatch that returns normally (the successor ran a turn) ends
 * the incident, so a fresh limit much later restarts the ladder from the top
 * rather than inheriting a stale position. This is a plain durable record, never
 * an event (recording a ladder position drives no §6.3 transition).
 */
import { runId as toRunId, type AssignmentId, type RunId } from '../domain/ids.js';
import type { Database } from '../persistence/index.js';

/** Reserved projection scope for cross-process failover-incident records. */
export const FAILOVER_INCIDENT_SCOPE: RunId = toRunId('run__failover_incident');
export const FAILOVER_INCIDENT_PROJECTION = 'failover_incident';

/** One durable failover-incident record — no secrets, JSON-serializable. */
export interface FailoverIncidentRecord {
  readonly runId: string;
  readonly assignmentId: string;
  /** The NEXT ladder index to escalate to (0-based). Incremented per step. */
  readonly position: number;
}

interface FailoverIncidentProjectionState {
  readonly incidents: Record<string, FailoverIncidentRecord>;
}

const EMPTY_STATE: FailoverIncidentProjectionState = { incidents: {} };

/** Composite key: one failover incident per (run, assignment) at a time. */
function keyOf(runIdValue: string, assignmentId: string): string {
  return `${runIdValue}::${assignmentId}`;
}

export class DurableFailoverStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** The NEXT ladder position for a (run, assignment); 0 when no incident. */
  position(runIdValue: RunId, assignmentId: AssignmentId): number {
    return this.#load().incidents[keyOf(String(runIdValue), String(assignmentId))]?.position ?? 0;
  }

  /**
   * Persist the NEXT ladder position for a (run, assignment). Runs in one
   * transaction so a concurrent writer for a DIFFERENT (run, assignment) never
   * clobbers this row.
   */
  set(runIdValue: RunId, assignmentId: AssignmentId, position: number): void {
    this.#db.transaction(() => {
      const incidents = { ...this.#load().incidents };
      incidents[keyOf(String(runIdValue), String(assignmentId))] = {
        runId: String(runIdValue),
        assignmentId: String(assignmentId),
        position,
      };
      this.#save(incidents);
    });
  }

  /** Clear the ladder position once the run made progress past the limit. */
  clear(runIdValue: RunId, assignmentId: AssignmentId): void {
    this.#db.transaction(() => {
      const incidents = { ...this.#load().incidents };
      const key = keyOf(String(runIdValue), String(assignmentId));
      if (incidents[key] === undefined) return;
      delete incidents[key];
      this.#save(incidents);
    });
  }

  #load(): FailoverIncidentProjectionState {
    return (
      this.#db.projections.get<FailoverIncidentProjectionState>(
        FAILOVER_INCIDENT_SCOPE,
        FAILOVER_INCIDENT_PROJECTION,
      )?.state ?? EMPTY_STATE
    );
  }

  #save(incidents: Record<string, FailoverIncidentRecord>): void {
    this.#db.projections.save(FAILOVER_INCIDENT_SCOPE, FAILOVER_INCIDENT_PROJECTION, { incidents });
  }
}
