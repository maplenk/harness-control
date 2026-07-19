/**
 * Durable spawn-slot reservations (W3-5(a); PLAN.md §14 "Concurrency").
 *
 * The `MaxLiveChildrenGuard` (../supervisor/concurrency.ts) caps live children
 * WITHIN one orchestrator process. The durable `ProcessRegistry` records a
 * child's §14 identity, but only AFTER the OS process exists (`child.spawned`).
 * That leaves a cross-process TOCTOU window: between admitting a spawn and
 * registering the spawned child's identity, this process has NOTHING durable
 * recording that it intends to occupy a slot — so a SECOND CLI process,
 * counting live children concurrently, sees the slot as free and also admits.
 * Two processes started at once with `maxLiveChildren = 1` both spawn.
 *
 * A reservation closes that window: it is written at admission time (BEFORE the
 * spawn) inside the SAME serialized `BEGIN IMMEDIATE` transaction that counts
 * live slots, and released on every `runRole` exit path. A concurrent process's
 * immediate transaction blocks on the write lock until this one commits, then
 * observes the reservation — so the count-and-reserve is atomic across
 * processes and the N+1th admission is refused.
 *
 * Liveness (§14): a reservation records the OWNING orchestrator process's
 * {pid, start-time}. A reservation whose owner pid is gone — or resolves to a
 * DIFFERENT start-time (an unrelated process that recycled the pid) — is a
 * CRASHED holder; it is not counted and is reclaimable, so a dead process never
 * permanently consumes a slot (no deadlock). The owning process's OWN
 * reservations are always live (it is, by definition, running).
 *
 * Backed by the existing SQLite projection layer under a reserved scope id
 * (like `DurableProcessRegistryStore`), so the reservations survive a crash and
 * `list()` sees every process's reservations under one blob.
 */
import { runId, type RunId } from '../domain/ids.js';
import type { ProcessGenerationId } from '../domain/ids.js';
import type { Database } from '../persistence/index.js';

/** Reserved projection scope for cross-process spawn reservations. */
export const SPAWN_RESERVATION_SCOPE: RunId = runId('run__spawn_reservations');
export const SPAWN_RESERVATION_PROJECTION = 'spawn_reservations';

/** One durable slot reservation — no secrets, JSON-serializable. */
export interface SpawnReservationRecord {
  readonly generationId: string;
  /** OS pid of the orchestrator process that reserved the slot. */
  readonly ownerPid: number;
  /** §14 start-time of the owner (opaque `ps lstart` token); absent when unreadable. */
  readonly ownerStartedAt?: string;
  /** Owning run (diagnostics/attribution only — never part of the count). */
  readonly runId?: string;
  readonly reservedAt: string;
}

interface SpawnReservationProjectionState {
  readonly reservations: Record<string, SpawnReservationRecord>;
}

const EMPTY_STATE: SpawnReservationProjectionState = { reservations: {} };

export class DurableSpawnReservationStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Every reservation across every process (as persisted). */
  list(): readonly SpawnReservationRecord[] {
    return Object.values(this.#load().reservations);
  }

  /**
   * Upsert this process's reservation for `generationId`, optionally pruning
   * `deadGenerations` (reclaimed crashed-owner reservations) in the SAME write.
   * Meant to be called from INSIDE the enclosing `transactionImmediate` that
   * counted the slots, so the count and the reserve commit atomically.
   */
  reserveWithin(record: SpawnReservationRecord, deadGenerations: readonly string[] = []): void {
    const reservations = { ...this.#load().reservations };
    for (const gen of deadGenerations) delete reservations[gen];
    reservations[record.generationId] = record;
    this.#save(reservations);
  }

  /** Drop this process's reservation for `generationId` (runRole `finally`). */
  release(generationId: ProcessGenerationId): void {
    this.#db.transaction(() => {
      const reservations = { ...this.#load().reservations };
      if (reservations[String(generationId)] === undefined) return;
      delete reservations[String(generationId)];
      this.#save(reservations);
    });
  }

  #load(): SpawnReservationProjectionState {
    return (
      this.#db.projections.get<SpawnReservationProjectionState>(
        SPAWN_RESERVATION_SCOPE,
        SPAWN_RESERVATION_PROJECTION,
      )?.state ?? EMPTY_STATE
    );
  }

  #save(reservations: Record<string, SpawnReservationRecord>): void {
    this.#db.projections.save(SPAWN_RESERVATION_SCOPE, SPAWN_RESERVATION_PROJECTION, { reservations });
  }
}
