/**
 * OperationRepository (§3A.2 / Phase A0 run 1b).
 *
 * Durable command-operation records with lifecycle accepted → claimed →
 * running → terminal, UNIQUE(actor, idempotencyKey) dedup, atomic start
 * binding, and lease-expiry reclaim. Domain-agnostic about the command
 * payload (opaque JSON + version + hash), matching ProjectionRepository's
 * opaque-state shape — this package does not import src/app/commands.
 */
import type { Brand } from '../lib/brand.js';
import type { Clock, IsoTimestamp } from '../lib/clock.js';
import { runId as asRunId, type RunId } from '../domain/ids.js';
import { sha256Hex } from '../artifacts/hash.js';
import { canonicalStringify } from '../checkpoint/serialize.js';
import type { SqlDriver } from './driver.js';
import { registerRun } from './runs.js';

// ---------------------------------------------------------------------------
// Ids, lifecycle, transitions
// ---------------------------------------------------------------------------

export type OperationId = Brand<string, 'OperationId'>;
export const operationId = (value: string): OperationId => value as OperationId;

export const OPERATION_LIFECYCLE_STATES = [
  'accepted',
  'claimed',
  'running',
  'waiting_for_input',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type OperationLifecycleState = (typeof OPERATION_LIFECYCLE_STATES)[number];

export const TERMINAL_OPERATION_STATES = ['succeeded', 'failed', 'cancelled'] as const;
export type TerminalOperationState = (typeof TERMINAL_OPERATION_STATES)[number];

export function isTerminalOperationState(
  state: OperationLifecycleState,
): state is TerminalOperationState {
  return (TERMINAL_OPERATION_STATES as readonly OperationLifecycleState[]).includes(state);
}

/**
 * Legal transitions. Lease-expiry reclaim uses claimed|running → accepted.
 * waiting_for_input is blocked on a human answer, not a worker, so it is
 * deliberately NOT reclaimable (no waiting_for_input → accepted).
 */
export const OPERATION_TRANSITIONS: Readonly<
  Record<OperationLifecycleState, readonly OperationLifecycleState[]>
> = {
  accepted: ['claimed', 'cancelled', 'failed'],
  claimed: ['running', 'accepted', 'cancelled', 'failed'],
  running: ['waiting_for_input', 'succeeded', 'failed', 'cancelled', 'accepted'],
  waiting_for_input: ['running', 'cancelled', 'failed'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function isLegalOperationTransition(
  from: OperationLifecycleState,
  to: OperationLifecycleState,
): boolean {
  return OPERATION_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Records & hashing
// ---------------------------------------------------------------------------

export interface OperationOwner {
  readonly pid: number;
  readonly startedAt?: IsoTimestamp;
}

export interface OperationRecord {
  readonly operationId: OperationId;
  readonly actor: string;
  readonly idempotencyKey: string;
  readonly origin: string;
  readonly kind: string;
  readonly commandVersion: number;
  readonly command: unknown;
  readonly commandHash: string;
  readonly state: OperationLifecycleState;
  readonly runId?: RunId;
  readonly owner?: OperationOwner;
  readonly leaseExpiresAt?: IsoTimestamp;
  readonly heartbeatAt?: IsoTimestamp;
  readonly attemptCount: number;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly acceptedAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly terminalAt?: IsoTimestamp;
}

/** Default command payload version stored with every accepted operation. */
export const OPERATION_COMMAND_PAYLOAD_VERSION = 1;

export function hashOperationCommand(input: {
  readonly commandVersion: number;
  readonly kind: string;
  readonly command: unknown;
}): string {
  return sha256Hex(
    canonicalStringify({
      v: input.commandVersion,
      kind: input.kind,
      command: input.command,
    }),
  );
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface AcceptOperationInput {
  readonly operationId: OperationId;
  readonly actor: string;
  readonly idempotencyKey: string;
  readonly origin: string;
  readonly kind: string;
  readonly command: unknown;
  readonly commandVersion?: number;
}

export type AcceptOperationResult =
  | { readonly outcome: 'accepted'; readonly operation: OperationRecord }
  | { readonly outcome: 'existing'; readonly operation: OperationRecord }
  | { readonly outcome: 'conflict'; readonly operation: OperationRecord };

export interface TransitionOperationInput {
  readonly to: OperationLifecycleState;
  readonly result?: unknown;
  readonly error?: unknown;
  readonly owner?: OperationOwner;
  readonly leaseExpiresAt?: IsoTimestamp;
  readonly heartbeatAt?: IsoTimestamp;
  /** When true, clears owner / lease / heartbeat columns. */
  readonly clearOwner?: boolean;
}

export type TransitionOperationResult =
  | { readonly status: 'applied'; readonly operation: OperationRecord }
  | { readonly status: 'rejected'; readonly operation: OperationRecord }
  | { readonly status: 'not_found' };

export class OperationRunBindingConflictError extends Error {
  readonly operationId: OperationId;
  readonly existingRunId: RunId;
  readonly attemptedRunId: RunId;

  constructor(operationId: OperationId, existingRunId: RunId, attemptedRunId: RunId) {
    super(
      `Operation '${operationId}' is already bound to run '${existingRunId}'; cannot rebind to '${attemptedRunId}'`,
    );
    this.name = 'OperationRunBindingConflictError';
    this.operationId = operationId;
    this.existingRunId = existingRunId;
    this.attemptedRunId = attemptedRunId;
  }
}

export interface OperationRepository {
  /**
   * Durably accept a command. Dedup read + insert run inside ONE
   * `transactionImmediate` so concurrent (actor, idempotencyKey) races
   * serialize on the SQLite write lock.
   */
  accept(input: AcceptOperationInput): AcceptOperationResult;
  get(operationId: OperationId): OperationRecord | undefined;
  getByIdempotency(actor: string, key: string): OperationRecord | undefined;
  listByRun(runId: RunId): readonly OperationRecord[];
  /** Non-terminal operations (accepted / claimed / running / waiting_for_input). */
  listUnsettled(): readonly OperationRecord[];
  /**
   * accepted → claimed with owner + lease. Returns the same status vocabulary
   * as `transition`.
   */
  claim(
    operationId: OperationId,
    owner: OperationOwner,
    leaseExpiresAt: IsoTimestamp,
  ): TransitionOperationResult;
  /** Refresh lease/heartbeat on a claimed or running operation. */
  heartbeat(operationId: OperationId, leaseExpiresAt: IsoTimestamp): TransitionOperationResult;
  transition(operationId: OperationId, input: TransitionOperationInput): TransitionOperationResult;
  /**
   * Bind `runId` to the operation. No-op when already bound to the same run;
   * throws `OperationRunBindingConflictError` on a rebind to a different run.
   */
  bindRun(operationId: OperationId, runId: RunId): void;
  /**
   * Move claimed/running rows whose `lease_expires_at <= now` back to accepted,
   * clear owner/lease/heartbeat, and increment attempt_count.
   */
  reclaimExpiredLeases(now: IsoTimestamp): readonly OperationRecord[];
}

// ---------------------------------------------------------------------------
// SQL row mapping
// ---------------------------------------------------------------------------

interface OperationRow {
  readonly operation_id: string;
  readonly actor: string;
  readonly idempotency_key: string;
  readonly origin: string;
  readonly kind: string;
  readonly command_version: number;
  readonly command_json: string;
  readonly command_hash: string;
  readonly state: string;
  readonly run_id: string | null;
  readonly owner_pid: number | null;
  readonly owner_started_at: string | null;
  readonly lease_expires_at: string | null;
  readonly heartbeat_at: string | null;
  readonly attempt_count: number;
  readonly result_json: string | null;
  readonly error_json: string | null;
  readonly accepted_at: string;
  readonly updated_at: string;
  readonly terminal_at: string | null;
}

const SELECT_COLUMNS = `
  operation_id, actor, idempotency_key, origin, kind, command_version,
  command_json, command_hash, state, run_id, owner_pid, owner_started_at,
  lease_expires_at, heartbeat_at, attempt_count, result_json, error_json,
  accepted_at, updated_at, terminal_at
`;

const SELECT_BY_ID_SQL = `SELECT ${SELECT_COLUMNS} FROM operations WHERE operation_id = ?`;
const SELECT_BY_IDEMPOTENCY_SQL = `SELECT ${SELECT_COLUMNS} FROM operations WHERE actor = ? AND idempotency_key = ?`;
const SELECT_BY_RUN_SQL = `SELECT ${SELECT_COLUMNS} FROM operations WHERE run_id = ? ORDER BY accepted_at ASC, operation_id ASC`;
const SELECT_UNSETTLED_SQL = `SELECT ${SELECT_COLUMNS} FROM operations WHERE state NOT IN ('succeeded', 'failed', 'cancelled') ORDER BY accepted_at ASC, operation_id ASC`;
const SELECT_EXPIRED_LEASES_SQL = `
  SELECT ${SELECT_COLUMNS} FROM operations
  WHERE state IN ('claimed', 'running')
    AND lease_expires_at IS NOT NULL
    AND lease_expires_at <= ?
  ORDER BY accepted_at ASC, operation_id ASC
`;

const INSERT_SQL = `
  INSERT INTO operations (
    operation_id, actor, idempotency_key, origin, kind, command_version,
    command_json, command_hash, state, run_id, owner_pid, owner_started_at,
    lease_expires_at, heartbeat_at, attempt_count, result_json, error_json,
    accepted_at, updated_at, terminal_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_STATE_SQL = `
  UPDATE operations SET
    state = ?,
    owner_pid = ?,
    owner_started_at = ?,
    lease_expires_at = ?,
    heartbeat_at = ?,
    attempt_count = ?,
    result_json = ?,
    error_json = ?,
    updated_at = ?,
    terminal_at = ?
  WHERE operation_id = ?
`;

const UPDATE_BIND_RUN_SQL = `
  UPDATE operations SET run_id = ?, updated_at = ? WHERE operation_id = ?
`;

function rowToRecord(row: OperationRow): OperationRecord {
  const owner: OperationOwner | undefined =
    row.owner_pid !== null
      ? {
          pid: row.owner_pid,
          ...(row.owner_started_at !== null
            ? { startedAt: row.owner_started_at as IsoTimestamp }
            : {}),
        }
      : undefined;

  return {
    operationId: operationId(row.operation_id),
    actor: row.actor,
    idempotencyKey: row.idempotency_key,
    origin: row.origin,
    kind: row.kind,
    commandVersion: row.command_version,
    command: JSON.parse(row.command_json) as unknown,
    commandHash: row.command_hash,
    state: row.state as OperationLifecycleState,
    ...(row.run_id !== null ? { runId: asRunId(row.run_id) } : {}),
    ...(owner !== undefined ? { owner } : {}),
    ...(row.lease_expires_at !== null
      ? { leaseExpiresAt: row.lease_expires_at as IsoTimestamp }
      : {}),
    ...(row.heartbeat_at !== null ? { heartbeatAt: row.heartbeat_at as IsoTimestamp } : {}),
    attemptCount: row.attempt_count,
    ...(row.result_json !== null ? { result: JSON.parse(row.result_json) as unknown } : {}),
    ...(row.error_json !== null ? { error: JSON.parse(row.error_json) as unknown } : {}),
    acceptedAt: row.accepted_at as IsoTimestamp,
    updatedAt: row.updated_at as IsoTimestamp,
    ...(row.terminal_at !== null ? { terminalAt: row.terminal_at as IsoTimestamp } : {}),
  };
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SqliteOperationRepository implements OperationRepository {
  readonly #driver: SqlDriver;
  readonly #clock: Clock;

  constructor(driver: SqlDriver, clock: Clock) {
    this.#driver = driver;
    this.#clock = clock;
  }

  accept(input: AcceptOperationInput): AcceptOperationResult {
    const commandVersion = input.commandVersion ?? OPERATION_COMMAND_PAYLOAD_VERSION;
    const commandHash = hashOperationCommand({
      commandVersion,
      kind: input.kind,
      command: input.command,
    });
    const commandJson = canonicalStringify(input.command);

    return this.#driver.transactionImmediate(() => {
      const existing = this.#selectByIdempotency(input.actor, input.idempotencyKey);
      if (existing) {
        if (existing.commandHash === commandHash) {
          return { outcome: 'existing' as const, operation: existing };
        }
        return { outcome: 'conflict' as const, operation: existing };
      }

      const now = this.#clock.nowIso();
      this.#driver.prepare(INSERT_SQL).run([
        input.operationId,
        input.actor,
        input.idempotencyKey,
        input.origin,
        input.kind,
        commandVersion,
        commandJson,
        commandHash,
        'accepted',
        null, // run_id
        null, // owner_pid
        null, // owner_started_at
        null, // lease_expires_at
        null, // heartbeat_at
        0, // attempt_count
        null, // result_json
        null, // error_json
        now,
        now,
        null, // terminal_at
      ]);

      const inserted = this.#selectById(input.operationId);
      if (!inserted) {
        throw new Error(
          `OperationRepository.accept: insert of '${input.operationId}' did not become readable`,
        );
      }
      return { outcome: 'accepted' as const, operation: inserted };
    });
  }

  get(id: OperationId): OperationRecord | undefined {
    return this.#selectById(id);
  }

  getByIdempotency(actor: string, key: string): OperationRecord | undefined {
    return this.#selectByIdempotency(actor, key);
  }

  listByRun(run: RunId): readonly OperationRecord[] {
    return this.#driver
      .prepare(SELECT_BY_RUN_SQL)
      .all<OperationRow>([run])
      .map(rowToRecord);
  }

  listUnsettled(): readonly OperationRecord[] {
    return this.#driver.prepare(SELECT_UNSETTLED_SQL).all<OperationRow>([]).map(rowToRecord);
  }

  claim(
    id: OperationId,
    owner: OperationOwner,
    leaseExpiresAt: IsoTimestamp,
  ): TransitionOperationResult {
    const now = this.#clock.nowIso();
    return this.transition(id, {
      to: 'claimed',
      owner,
      leaseExpiresAt,
      heartbeatAt: now,
    });
  }

  heartbeat(id: OperationId, leaseExpiresAt: IsoTimestamp): TransitionOperationResult {
    return this.#driver.transaction(() => {
      const existing = this.#selectById(id);
      if (!existing) return { status: 'not_found' as const };
      if (existing.state !== 'claimed' && existing.state !== 'running') {
        return { status: 'rejected' as const, operation: existing };
      }
      const now = this.#clock.nowIso();
      this.#driver.prepare(UPDATE_STATE_SQL).run([
        existing.state,
        existing.owner?.pid ?? null,
        existing.owner?.startedAt ?? null,
        leaseExpiresAt,
        now,
        existing.attemptCount,
        existing.result !== undefined ? canonicalStringify(existing.result) : null,
        existing.error !== undefined ? canonicalStringify(existing.error) : null,
        now,
        existing.terminalAt ?? null,
        id,
      ]);
      const updated = this.#selectById(id);
      if (!updated) return { status: 'not_found' as const };
      return { status: 'applied' as const, operation: updated };
    });
  }

  transition(id: OperationId, input: TransitionOperationInput): TransitionOperationResult {
    return this.#driver.transaction(() => {
      const existing = this.#selectById(id);
      if (!existing) return { status: 'not_found' as const };
      if (!isLegalOperationTransition(existing.state, input.to)) {
        return { status: 'rejected' as const, operation: existing };
      }

      const now = this.#clock.nowIso();
      const terminal =
        isTerminalOperationState(input.to) ? (existing.terminalAt ?? now) : (existing.terminalAt ?? null);

      let ownerPid: number | null;
      let ownerStartedAt: string | null;
      let leaseExpiresAt: string | null;
      let heartbeatAt: string | null;

      if (input.clearOwner) {
        ownerPid = null;
        ownerStartedAt = null;
        leaseExpiresAt = null;
        heartbeatAt = null;
      } else {
        const owner = input.owner ?? existing.owner;
        ownerPid = owner?.pid ?? null;
        ownerStartedAt = owner?.startedAt ?? null;
        leaseExpiresAt =
          input.leaseExpiresAt !== undefined
            ? input.leaseExpiresAt
            : (existing.leaseExpiresAt ?? null);
        heartbeatAt =
          input.heartbeatAt !== undefined ? input.heartbeatAt : (existing.heartbeatAt ?? null);
      }

      const resultJson =
        input.result !== undefined
          ? canonicalStringify(input.result)
          : existing.result !== undefined
            ? canonicalStringify(existing.result)
            : null;
      const errorJson =
        input.error !== undefined
          ? canonicalStringify(input.error)
          : existing.error !== undefined
            ? canonicalStringify(existing.error)
            : null;

      this.#driver.prepare(UPDATE_STATE_SQL).run([
        input.to,
        ownerPid,
        ownerStartedAt,
        leaseExpiresAt,
        heartbeatAt,
        existing.attemptCount,
        resultJson,
        errorJson,
        now,
        terminal,
        id,
      ]);

      const updated = this.#selectById(id);
      if (!updated) return { status: 'not_found' as const };
      return { status: 'applied' as const, operation: updated };
    });
  }

  bindRun(id: OperationId, run: RunId): void {
    this.#driver.transaction(() => {
      const existing = this.#selectById(id);
      if (!existing) {
        throw new Error(`OperationRepository.bindRun: operation '${id}' not found`);
      }
      if (existing.runId !== undefined) {
        if (existing.runId === run) return; // idempotent same-run bind
        throw new OperationRunBindingConflictError(id, existing.runId, run);
      }
      // Ensure the FK parent exists when the caller registered via createRun.
      registerRun(this.#driver, this.#clock, run);
      this.#driver.prepare(UPDATE_BIND_RUN_SQL).run([run, this.#clock.nowIso(), id]);
    });
  }

  reclaimExpiredLeases(now: IsoTimestamp): readonly OperationRecord[] {
    return this.#driver.transaction(() => {
      const expired = this.#driver
        .prepare(SELECT_EXPIRED_LEASES_SQL)
        .all<OperationRow>([now])
        .map(rowToRecord);

      const reclaimed: OperationRecord[] = [];
      for (const row of expired) {
        // Only claimed/running are reclaimable (SELECT already filters); stamp
        // accepted, clear owner/lease/heartbeat, increment attempt_count.
        this.#driver.prepare(UPDATE_STATE_SQL).run([
          'accepted',
          null,
          null,
          null,
          null,
          row.attemptCount + 1,
          row.result !== undefined ? canonicalStringify(row.result) : null,
          row.error !== undefined ? canonicalStringify(row.error) : null,
          now,
          row.terminalAt ?? null,
          row.operationId,
        ]);
        const updated = this.#selectById(row.operationId);
        if (updated) reclaimed.push(updated);
      }
      return reclaimed;
    });
  }

  #selectById(id: OperationId): OperationRecord | undefined {
    const row = this.#driver.prepare(SELECT_BY_ID_SQL).get<OperationRow>([id]);
    return row ? rowToRecord(row) : undefined;
  }

  #selectByIdempotency(actor: string, key: string): OperationRecord | undefined {
    const row = this.#driver.prepare(SELECT_BY_IDEMPOTENCY_SQL).get<OperationRow>([actor, key]);
    return row ? rowToRecord(row) : undefined;
  }
}

// ---------------------------------------------------------------------------
// Atomic start binding (§3A.2 bullet 5)
// ---------------------------------------------------------------------------

/**
 * Minimal facade needed by `bindRunToOperationAtomically` — avoids a cycle
 * with `database.ts` (which constructs the operations repository).
 */
export interface OperationBindingDatabase {
  transactionImmediate<T>(fn: () => T): T;
  readonly operations: OperationRepository;
}

/**
 * Runs the caller's run-creating closure AND the operation→run binding inside
 * ONE `transactionImmediate`. Either the run exists AND the operation is
 * bound, or neither happened (rollback on throw).
 */
export function bindRunToOperationAtomically(
  db: OperationBindingDatabase,
  options: {
    readonly operationId: OperationId;
    readonly createRun: () => RunId;
  },
): RunId {
  return db.transactionImmediate(() => {
    const created = options.createRun();
    db.operations.bindRun(options.operationId, created);
    return created;
  });
}
