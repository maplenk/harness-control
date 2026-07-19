/**
 * Durable `ProcessRegistryStore` (P4a W2-6; PLAN §14 bullet 1, §12.3).
 *
 * The supervisor's `ProcessRegistry` (../supervisor/registry.ts) is
 * deliberately storage-agnostic; startup orphan reaping across a CRASHED
 * orchestrator requires the identity records to have survived the crash.
 * This implementation backs the store with the EXISTING SQLite projection
 * layer (`run_projections` via `ProjectionRepository` — no new table): all
 * records live in ONE projection blob under a reserved registry scope id,
 * so `list()` sees every persisted generation across every run at startup.
 *
 * A reserved scope id (not the owning run's id) is used because the reaper
 * runs BEFORE any particular run is resolved — §14 startup reaping must
 * enumerate all persisted generations, and the projection repository is
 * (runId, name)-keyed with no cross-run listing. Each record still carries
 * its owning `runId`/`segmentId`, so the service can attribute alerts and
 * stop-intent reclaims per run.
 *
 * Concurrency: read-modify-write per mutation, wrapped in a DB transaction.
 * Safe under §12.1's "one logical writer" discipline (the same discipline
 * every projection here already relies on).
 */
import { runId, type RunId } from '../domain/ids.js';
import type { ProcessGenerationId } from '../domain/ids.js';
import type { Database } from '../persistence/index.js';
import type { ProcessIdentityRecord, ProcessRegistryStore } from '../supervisor/index.js';

/** Reserved projection scope for the cross-run registry (see module doc). */
export const PROCESS_REGISTRY_SCOPE: RunId = runId('run__process_registry');
export const PROCESS_REGISTRY_PROJECTION = 'process_registry';

interface ProcessRegistryProjectionState {
  /** generationId → identity record (JSON-serializable, no secrets). */
  readonly records: Record<string, ProcessIdentityRecord>;
}

const EMPTY_STATE: ProcessRegistryProjectionState = { records: {} };

export class DurableProcessRegistryStore implements ProcessRegistryStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  put(record: ProcessIdentityRecord): void {
    this.#mutate((records) => {
      records[String(record.generationId)] = record;
    });
  }

  get(generationId: ProcessGenerationId): ProcessIdentityRecord | undefined {
    return this.#load().records[String(generationId)];
  }

  remove(generationId: ProcessGenerationId): void {
    this.#mutate((records) => {
      delete records[String(generationId)];
    });
  }

  list(): readonly ProcessIdentityRecord[] {
    return Object.values(this.#load().records);
  }

  #load(): ProcessRegistryProjectionState {
    return (
      this.#db.projections.get<ProcessRegistryProjectionState>(
        PROCESS_REGISTRY_SCOPE,
        PROCESS_REGISTRY_PROJECTION,
      )?.state ?? EMPTY_STATE
    );
  }

  #mutate(fn: (records: Record<string, ProcessIdentityRecord>) => void): void {
    this.#db.transaction(() => {
      const records = { ...this.#load().records };
      fn(records);
      this.#db.projections.save(PROCESS_REGISTRY_SCOPE, PROCESS_REGISTRY_PROJECTION, { records });
    });
  }
}
