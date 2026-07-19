/**
 * Durable RUN-ownership leases (W4-4 consumer residual; PLAN.md §14
 * "Concurrency" / §12.3 recovery).
 *
 * The per-CHILD process registry records a child's §14 identity, but a clean
 * child dispose REMOVES that record (`OrchestrationService.#releaseSpawnSupervision`)
 * and its spawn reservation. So BETWEEN an implementor's clean stop and the
 * verifier's dispatch — a gap of real worktree/git I/O inside
 * `runImplementVerifyLoop` — a LIVE, healthy orchestrator that is still actively
 * driving the run holds NO durable record for it. A concurrent `harness resume`
 * in that window could therefore not tell "owner crashed" from "owner alive
 * between rounds" and would DOUBLE-DRIVE the same worktree (two writers).
 *
 * A run-ownership lease closes that gap. It is a RUN-level (not per-child)
 * record — {runId, ownerPid, ownerStartedAt} — ACQUIRED when an orchestrator
 * begins actively driving a run's execution (the outer entry of the
 * implement/verify driver, covering BOTH a fresh start-that-drives and a
 * resume-that-drives) and RELEASED in that driver's outer `finally` (normal
 * completion, pause, error, or process-exit path). Unlike the per-child
 * registry record, the lease is held ACROSS child rounds, so it survives the
 * between-rounds dispose gap. The consumer resume-routing gates
 * (`isRunClaimedByLiveProcess`) consult it: present AND owner-alive → the run is
 * claimed and the gate WITHHOLDS; absent or dead/recycled owner → not claimed,
 * so the gate may fire (the intended crash recovery — a crashed owner's stale
 * lease carries a dead pid, so a resuming process correctly reclaims and
 * proceeds; a legitimate sequential resume after the owner released is never
 * blocked).
 *
 * Liveness (§14): the record carries the OWNING orchestrator process's
 * {pid, start-time}. A lease whose owner pid is gone — or resolves to a
 * DIFFERENT start-time (an unrelated process that recycled the pid) — is a
 * CRASHED holder; it does not claim the run and is reclaimable, so a dead
 * process never permanently blocks a legitimate resume (no deadlock). The
 * owning process's OWN lease is always live (it is, by definition, running).
 *
 * Backed by the existing SQLite projection layer under a reserved scope id
 * (like `DurableSpawnReservationStore`), so the lease survives a crash and
 * `list()` sees every process's leases under one blob.
 */
import { runId, type RunId } from '../domain/ids.js';
import type { Database } from '../persistence/index.js';

/** Reserved projection scope for cross-process run-ownership leases. */
export const RUN_OWNERSHIP_SCOPE: RunId = runId('run__run_ownership');
export const RUN_OWNERSHIP_PROJECTION = 'run_ownership';

/** One durable run-ownership lease — no secrets, JSON-serializable. */
export interface RunOwnershipRecord {
  /** The owned run. */
  readonly runId: string;
  /** OS pid of the orchestrator process actively driving the run. */
  readonly ownerPid: number;
  /** §14 start-time of the owner (opaque `ps lstart` token); absent when unreadable. */
  readonly ownerStartedAt?: string;
  readonly acquiredAt: string;
}

interface RunOwnershipProjectionState {
  readonly owners: Record<string, RunOwnershipRecord>;
}

const EMPTY_STATE: RunOwnershipProjectionState = { owners: {} };

/**
 * Raised when a would-be driver LOSES the run-ownership compare-and-swap — a
 * still-live peer already exclusively owns the run (attack-e). The engine
 * WITHHOLDS rather than double-drive the same worktree/round (content
 * double-write). A benign, expected race outcome: it surfaces as an honest
 * exit-1 error, never a crash.
 */
export class RunOwnershipConflictError extends Error {
  override readonly name: string = 'RunOwnershipConflictError';
  readonly runId: string;

  constructor(id: string) {
    super(
      `run ${id} is already being driven by a live owner process — withholding to avoid a double-drive`,
    );
    this.runId = id;
  }
}

export class DurableRunOwnershipStore {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /** Every run-ownership lease across every process (as persisted). */
  list(): readonly RunOwnershipRecord[] {
    return Object.values(this.#load().owners);
  }

  /**
   * COMPARE-AND-SWAP acquire of the ownership lease for `record.runId` — the
   * EXCLUSIVITY primitive (review-6 F2 / attack-e). Runs inside ONE
   * `BEGIN IMMEDIATE` transaction (the same shape as the W3-5a count-and-reserve
   * in `service.ts #admitSpawn`) so two concurrent reclaimers of the SAME
   * crashed run serialize on the write lock: the first commits its claim, the
   * second's immediate transaction then observes it and the loser gets `false`.
   *
   * The claim is ACCEPTED — `record` written, `true` returned — IFF the run is:
   *  - currently UNCLAIMED (no stored lease), OR
   *  - already owned by `record.ownerPid` (idempotent SELF re-acquire — checked
   *    BEFORE liveness because §14 always reports our own pid live), OR
   *  - held by a provably DEAD/recycled owner (`isOwnerLive(existing)` — §14
   *    liveness evaluated INSIDE the txn — returns `false`; the crashed owner's
   *    stale lease is reclaimed, so a dead process never deadlocks a resume).
   *
   * Otherwise a LIVE peer still exclusively owns the run: the stored lease is
   * left UNTOUCHED and `false` is returned (the caller withholds). `isOwnerLive`
   * is a caller-supplied predicate because §14 liveness needs the owning
   * process's `ps` identity, which lives in the service (mirrors how
   * `reserveWithin` takes its dead-generation set from `#admitSpawn`).
   */
  acquire(
    record: RunOwnershipRecord,
    isOwnerLive: (existing: RunOwnershipRecord) => boolean,
  ): boolean {
    return this.#db.transactionImmediate(() => {
      const owners = { ...this.#load().owners };
      const existing = owners[record.runId];
      if (
        existing !== undefined &&
        existing.ownerPid !== record.ownerPid &&
        isOwnerLive(existing)
      ) {
        return false; // a live peer owns it — CAS fails, lease untouched
      }
      owners[record.runId] = record;
      this.#save(owners);
      return true;
    });
  }

  /**
   * Release this process's ownership lease for `runId` (the driver's outer
   * `finally`). Only removes the lease when `ownerPid` still matches the stored
   * owner — if another process has already reclaimed it (this owner was
   * declared dead and superseded), the newer lease is left untouched.
   */
  release(runId: RunId, ownerPid: number): void {
    this.#db.transaction(() => {
      const owners = { ...this.#load().owners };
      const existing = owners[String(runId)];
      if (existing === undefined || existing.ownerPid !== ownerPid) return;
      delete owners[String(runId)];
      this.#save(owners);
    });
  }

  #load(): RunOwnershipProjectionState {
    return (
      this.#db.projections.get<RunOwnershipProjectionState>(
        RUN_OWNERSHIP_SCOPE,
        RUN_OWNERSHIP_PROJECTION,
      )?.state ?? EMPTY_STATE
    );
  }

  #save(owners: Record<string, RunOwnershipRecord>): void {
    this.#db.projections.save(RUN_OWNERSHIP_SCOPE, RUN_OWNERSHIP_PROJECTION, { owners });
  }
}
