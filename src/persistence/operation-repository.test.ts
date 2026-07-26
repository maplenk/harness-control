/**
 * §3A.2 operation repository contract tests (A1–A13).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../lib/clock.js';
import { runId } from '../domain/ids.js';
import { openDatabase } from './database.js';
import { MIGRATIONS } from './migrations.js';
import {
  OPERATION_COMMAND_PAYLOAD_VERSION,
  OPERATION_LIFECYCLE_STATES,
  OPERATION_TRANSITIONS,
  TERMINAL_OPERATION_STATES,
  hashOperationCommand,
  isLegalOperationTransition,
  isTerminalOperationState,
  operationId,
  type AcceptOperationInput,
  type OperationLifecycleState,
  type OperationRecord,
} from './operation-repository.js';
import { registerRun } from './runs.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';

const DRIVER_KINDS = await availableDriverKinds();

const REQUIRED_COLUMNS = [
  'operation_id',
  'actor',
  'idempotency_key',
  'origin',
  'kind',
  'command_version',
  'command_json',
  'command_hash',
  'state',
  'run_id',
  'owner_pid',
  'owner_started_at',
  'lease_expires_at',
  'heartbeat_at',
  'attempt_count',
  'result_json',
  'error_json',
  'accepted_at',
  'updated_at',
  'terminal_at',
] as const;

function acceptInput(
  overrides: Partial<AcceptOperationInput> & Pick<AcceptOperationInput, 'operationId' | 'idempotencyKey'>,
): AcceptOperationInput {
  return {
    operationId: overrides.operationId,
    actor: overrides.actor ?? 'user-1',
    idempotencyKey: overrides.idempotencyKey,
    origin: overrides.origin ?? 'cli',
    kind: overrides.kind ?? 'start',
    command: overrides.command ?? { kind: 'start', workspace: '/tmp/ws', goal: 'ship it' },
    ...(overrides.commandVersion !== undefined ? { commandVersion: overrides.commandVersion } : {}),
  };
}

function countOperations(db: TestDatabaseHandle['db'], actor: string, key: string): number {
  const row = db.driver
    .prepare('SELECT COUNT(*) AS n FROM operations WHERE actor = ? AND idempotency_key = ?')
    .get<{ n: number }>([actor, key]);
  return row?.n ?? 0;
}

describe.each(DRIVER_KINDS)('OperationRepository (%s)', (kind) => {
  let handle: TestDatabaseHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('accepted → claimed → running → succeeded walks the full lifecycle and stamps a terminal timestamp', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const ops = handle.db.operations;
    const id = operationId('op-lifecycle-1');

    const accepted = ops.accept(acceptInput({ operationId: id, idempotencyKey: 'idem-life-1' }));
    expect(accepted.outcome).toBe('accepted');
    expect(accepted.operation.state).toBe('accepted');
    expect(accepted.operation.attemptCount).toBe(0);
    expect(accepted.operation.terminalAt).toBeUndefined();

    const claimed = ops.claim(id, { pid: 42, startedAt: handle.db.clock.nowIso() }, isoTimestamp('2026-07-18T01:00:00.000Z'));
    expect(claimed.status).toBe('applied');
    if (claimed.status !== 'applied') throw new Error('expected applied');
    expect(claimed.operation.state).toBe('claimed');
    expect(claimed.operation.owner?.pid).toBe(42);

    const running = ops.transition(id, { to: 'running' });
    expect(running.status).toBe('applied');
    if (running.status !== 'applied') throw new Error('expected applied');
    expect(running.operation.state).toBe('running');

    const succeeded = ops.transition(id, { to: 'succeeded', result: { ok: true } });
    expect(succeeded.status).toBe('applied');
    if (succeeded.status !== 'applied') throw new Error('expected applied');
    expect(succeeded.operation.state).toBe('succeeded');
    expect(succeeded.operation.terminalAt).toBeDefined();
    expect(succeeded.operation.result).toEqual({ ok: true });
    expect(isTerminalOperationState(succeeded.operation.state)).toBe(true);
  });

  it('running ⇄ waiting_for_input moves both ways, including waiting_for_input → running', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const ops = handle.db.operations;
    const id = operationId('op-wait-1');
    ops.accept(acceptInput({ operationId: id, idempotencyKey: 'idem-wait-1' }));
    ops.claim(id, { pid: 7 }, isoTimestamp('2026-07-18T01:00:00.000Z'));
    ops.transition(id, { to: 'running' });

    const waiting = ops.transition(id, { to: 'waiting_for_input' });
    expect(waiting.status).toBe('applied');
    if (waiting.status !== 'applied') throw new Error('expected applied');
    expect(waiting.operation.state).toBe('waiting_for_input');

    const back = ops.transition(id, { to: 'running' });
    expect(back.status).toBe('applied');
    if (back.status !== 'applied') throw new Error('expected applied');
    expect(back.operation.state).toBe('running');
    expect(isLegalOperationTransition('waiting_for_input', 'running')).toBe(true);
  });

  it('cancellation is legal from every pre-terminal state, including accepted and claimed', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const ops = handle.db.operations;
    const preTerminal: OperationLifecycleState[] = [
      'accepted',
      'claimed',
      'running',
      'waiting_for_input',
    ];

    for (const state of preTerminal) {
      const id = operationId(`op-cancel-${state}`);
      ops.accept(acceptInput({ operationId: id, idempotencyKey: `idem-cancel-${state}` }));
      if (state === 'claimed' || state === 'running' || state === 'waiting_for_input') {
        ops.claim(id, { pid: 1 }, isoTimestamp('2026-07-18T01:00:00.000Z'));
      }
      if (state === 'running' || state === 'waiting_for_input') {
        ops.transition(id, { to: 'running' });
      }
      if (state === 'waiting_for_input') {
        ops.transition(id, { to: 'waiting_for_input' });
      }

      const cancelled = ops.transition(id, { to: 'cancelled' });
      expect(cancelled.status, `cancel from ${state}`).toBe('applied');
      if (cancelled.status !== 'applied') throw new Error('expected applied');
      expect(cancelled.operation.state).toBe('cancelled');
      expect(cancelled.operation.terminalAt).toBeDefined();
    }

    for (const state of preTerminal) {
      expect(isLegalOperationTransition(state, 'cancelled')).toBe(true);
    }
  });

  it('a lapsed lease returns a claimed/running operation to accepted with attemptCount incremented and owner/lease cleared', async () => {
    handle = await openTestDatabase({
      kind,
      file: false,
      clock: new ManualClock('2026-07-18T00:00:00.000Z'),
    });
    const ops = handle.db.operations;
    const leaseEnd = isoTimestamp('2026-07-18T00:30:00.000Z');
    const now = isoTimestamp('2026-07-18T01:00:00.000Z');

    const claimedId = operationId('op-lease-claimed');
    ops.accept(acceptInput({ operationId: claimedId, idempotencyKey: 'idem-lease-c' }));
    ops.claim(claimedId, { pid: 99, startedAt: handle.db.clock.nowIso() }, leaseEnd);

    const runningId = operationId('op-lease-running');
    ops.accept(acceptInput({ operationId: runningId, idempotencyKey: 'idem-lease-r' }));
    ops.claim(runningId, { pid: 100 }, leaseEnd);
    ops.transition(runningId, { to: 'running' });

    // waiting_for_input must NOT be reclaimed even with a lapsed lease stamp.
    const waitingId = operationId('op-lease-waiting');
    ops.accept(acceptInput({ operationId: waitingId, idempotencyKey: 'idem-lease-w' }));
    ops.claim(waitingId, { pid: 101 }, leaseEnd);
    ops.transition(waitingId, { to: 'running' });
    ops.transition(waitingId, { to: 'waiting_for_input' });

    const reclaimed = ops.reclaimExpiredLeases(now);
    expect(reclaimed.map((r) => r.operationId).sort()).toEqual([claimedId, runningId].sort());

    for (const id of [claimedId, runningId]) {
      const row = ops.get(id);
      expect(row?.state).toBe('accepted');
      expect(row?.attemptCount).toBe(1);
      expect(row?.owner).toBeUndefined();
      expect(row?.leaseExpiresAt).toBeUndefined();
      expect(row?.heartbeatAt).toBeUndefined();
    }

    const waiting = ops.get(waitingId);
    expect(waiting?.state).toBe('waiting_for_input');
    expect(waiting?.attemptCount).toBe(0);
    expect(waiting?.owner?.pid).toBe(101);
  });

  it('an illegal transition is rejected without mutating the stored row', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const ops = handle.db.operations;
    const id = operationId('op-illegal-1');
    ops.accept(acceptInput({ operationId: id, idempotencyKey: 'idem-illegal-1' }));
    const before = ops.get(id);
    expect(before).toBeDefined();

    // accepted → running is illegal (must go through claimed).
    expect(isLegalOperationTransition('accepted', 'running')).toBe(false);
    const rejected = ops.transition(id, { to: 'running' });
    expect(rejected.status).toBe('rejected');
    if (rejected.status !== 'rejected') throw new Error('expected rejected');

    const after = ops.get(id);
    expect(after).toEqual(before);
    // Terminal self-transition is also illegal.
    ops.transition(id, { to: 'cancelled' });
    const terminal = ops.get(id);
    const again = ops.transition(id, { to: 'succeeded' });
    expect(again.status).toBe('rejected');
    expect(ops.get(id)).toEqual(terminal);
  });

  it('the operations table carries every §3A.2 column and enforces UNIQUE(actor, idempotencyKey)', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const cols = handle.db.driver
      .prepare('PRAGMA table_info(operations)')
      .all<{ name: string; notnull: number }>();
    const names = cols.map((c) => c.name);
    for (const col of REQUIRED_COLUMNS) {
      expect(names, `missing column ${col}`).toContain(col);
    }
    const runIdCol = cols.find((c) => c.name === 'run_id');
    expect(runIdCol?.notnull).toBe(0); // nullable

    // Seed one row via the repository, then prove UNIQUE with a raw insert.
    const ops = handle.db.operations;
    ops.accept(
      acceptInput({
        operationId: operationId('op-unique-1'),
        idempotencyKey: 'idem-unique',
        actor: 'actor-a',
      }),
    );
    expect(() => {
      handle!.db.driver
        .prepare(
          `INSERT INTO operations (
            operation_id, actor, idempotency_key, origin, kind, command_version,
            command_json, command_hash, state, attempt_count, accepted_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run([
          'op-unique-2',
          'actor-a',
          'idem-unique',
          'cli',
          'start',
          1,
          '{}',
          'hash',
          'accepted',
          0,
          '2026-07-18T00:00:00.000Z',
          '2026-07-18T00:00:00.000Z',
        ]);
    }).toThrow();
  });

  it('the operations schema ships as a NEW migration and leaves migration 1 untouched', async () => {
    handle = await openTestDatabase({ kind, file: false });
    expect(MIGRATIONS.map((m) => m.id)).toEqual([1, 2]);
    expect(MIGRATIONS[0]?.name).toBe('init');
    expect(MIGRATIONS[1]?.name).toBe('operations');
    // ids unique and strictly ascending
    for (let i = 1; i < MIGRATIONS.length; i++) {
      expect(MIGRATIONS[i]!.id).toBeGreaterThan(MIGRATIONS[i - 1]!.id);
    }
    const applied = handle.db.appliedMigrations.map((m) => ({ id: m.id, name: m.name }));
    expect(applied).toEqual([
      { id: 1, name: 'init' },
      { id: 2, name: 'operations' },
    ]);
    // migration 1 still creates the original tables
    const tables = handle.db.driver
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>()
      .map((r) => r.name);
    expect(tables).toContain('runs');
    expect(tables).toContain('events');
    expect(tables).toContain('operations');
  });

  it('a retry with a matching commandHash returns the existing operation and inserts no second row', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const ops = handle.db.operations;
    const command = { kind: 'start', workspace: '/tmp/a', goal: 'g' };
    const first = ops.accept(
      acceptInput({
        operationId: operationId('op-idem-match'),
        idempotencyKey: 'idem-match',
        command,
      }),
    );
    expect(first.outcome).toBe('accepted');

    const second = ops.accept(
      acceptInput({
        operationId: operationId('op-idem-match-retry'),
        idempotencyKey: 'idem-match',
        command,
      }),
    );
    expect(second.outcome).toBe('existing');
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(countOperations(handle.db, 'user-1', 'idem-match')).toBe(1);
    expect(second.operation.commandHash).toBe(
      hashOperationCommand({
        commandVersion: OPERATION_COMMAND_PAYLOAD_VERSION,
        kind: 'start',
        command,
      }),
    );
  });

  it('a retry with a mismatched payload returns conflict and inserts no second row', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const ops = handle.db.operations;
    const first = ops.accept(
      acceptInput({
        operationId: operationId('op-idem-conflict'),
        idempotencyKey: 'idem-conflict',
        command: { kind: 'start', workspace: '/tmp/a', goal: 'one' },
      }),
    );
    expect(first.outcome).toBe('accepted');

    const second = ops.accept(
      acceptInput({
        operationId: operationId('op-idem-conflict-retry'),
        idempotencyKey: 'idem-conflict',
        command: { kind: 'start', workspace: '/tmp/a', goal: 'TWO' },
      }),
    );
    expect(second.outcome).toBe('conflict');
    expect(second.operation.operationId).toBe(first.operation.operationId);
    expect(countOperations(handle.db, 'user-1', 'idem-conflict')).toBe(1);
  });

  it('the same idempotencyKey under a different actor is a distinct operation', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const ops = handle.db.operations;
    const key = 'shared-key';
    const a = ops.accept(
      acceptInput({
        operationId: operationId('op-actor-a'),
        actor: 'alice',
        idempotencyKey: key,
      }),
    );
    const b = ops.accept(
      acceptInput({
        operationId: operationId('op-actor-b'),
        actor: 'bob',
        idempotencyKey: key,
      }),
    );
    expect(a.outcome).toBe('accepted');
    expect(b.outcome).toBe('accepted');
    expect(a.operation.operationId).not.toBe(b.operation.operationId);
    expect(countOperations(handle.db, 'alice', key)).toBe(1);
    expect(countOperations(handle.db, 'bob', key)).toBe(1);
  });

  it('the stored versioned payload survives to re-drive a start that never bound a runId', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const ops = handle.db.operations;
    const command = {
      kind: 'start',
      workspace: '/Users/me/proj',
      goal: 'implement §3A.2',
      enableChat: true,
    };
    const accepted = ops.accept(
      acceptInput({
        operationId: operationId('op-payload-1'),
        idempotencyKey: 'idem-payload-1',
        kind: 'start',
        command,
        commandVersion: 1,
      }),
    );
    expect(accepted.outcome).toBe('accepted');
    const stored = ops.get(operationId('op-payload-1'));
    expect(stored?.runId).toBeUndefined();
    expect(stored?.kind).toBe('start');
    expect(stored?.commandVersion).toBe(1);
    expect(stored?.command).toEqual(command);
    // Re-drive input is fully reconstructible from the stored row alone.
    expect(stored?.commandHash).toBe(
      hashOperationCommand({
        commandVersion: stored!.commandVersion,
        kind: stored!.kind,
        command: stored!.command,
      }),
    );
  });

  it('accept() commits the accepted row before returning: a close+reopen still sees it', async () => {
    handle = await openTestDatabase({ kind, file: true });
    const id = operationId('op-durable-1');
    const result = handle.db.operations.accept(
      acceptInput({ operationId: id, idempotencyKey: 'idem-durable-1' }),
    );
    expect(result.outcome).toBe('accepted');
    expect(result.operation.state).toBe('accepted');

    const filename = handle.filename;
    const casRoot = handle.casRoot;
    handle.close();

    const reopened = await openDatabase({
      filename,
      driver: kind,
      casRoot,
      clock: new ManualClock('2026-07-18T02:00:00.000Z'),
    });
    try {
      const row = reopened.operations.get(id);
      expect(row?.state).toBe('accepted');
      expect(row?.operationId).toBe(id);
      expect(row?.idempotencyKey).toBe('idem-durable-1');
    } finally {
      reopened.close();
    }
  });

  it('get / getByIdempotency / listByRun / listUnsettled expose operation state for polling', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;
    const ops = db.operations;

    const startId = operationId('op-poll-start');
    ops.accept(
      acceptInput({
        operationId: startId,
        idempotencyKey: 'idem-poll-start',
        kind: 'start',
      }),
    );

    const run = runId('run_poll_1');
    registerRun(db.driver, db.clock, run);
    const runOpId = operationId('op-poll-run');
    ops.accept(
      acceptInput({
        operationId: runOpId,
        idempotencyKey: 'idem-poll-run',
        kind: 'run',
        command: { kind: 'run', runId: run },
      }),
    );
    ops.bindRun(runOpId, run);
    ops.claim(runOpId, { pid: 55 }, isoTimestamp('2026-07-18T03:00:00.000Z'));
    ops.transition(runOpId, { to: 'running' });

    const terminalId = operationId('op-poll-done');
    ops.accept(
      acceptInput({
        operationId: terminalId,
        idempotencyKey: 'idem-poll-done',
        kind: 'cancel',
        command: { kind: 'cancel', runId: run },
      }),
    );
    ops.transition(terminalId, { to: 'cancelled' });

    const byId = ops.get(runOpId);
    expect(byId?.state).toBe('running');
    expect(byId?.attemptCount).toBe(0);
    expect(byId?.owner?.pid).toBe(55);
    expect(byId?.updatedAt).toBeDefined();

    const byKey = ops.getByIdempotency('user-1', 'idem-poll-start');
    expect(byKey?.operationId).toBe(startId);
    expect(byKey?.state).toBe('accepted');

    const byRun = ops.listByRun(run);
    expect(byRun.map((r: OperationRecord) => r.operationId)).toEqual([runOpId]);
    expect(byRun[0]?.state).toBe('running');

    const unsettled = ops.listUnsettled();
    const unsettledIds = unsettled.map((r) => r.operationId);
    expect(unsettledIds).toContain(startId);
    expect(unsettledIds).toContain(runOpId);
    expect(unsettledIds).not.toContain(terminalId);
    for (const row of unsettled) {
      expect(TERMINAL_OPERATION_STATES as readonly string[]).not.toContain(row.state);
      expect(row.updatedAt).toBeDefined();
    }

    // Reachable from a plain openDatabase facade (operations is on Database).
    expect(db.operations).toBe(ops);
    expect(OPERATION_LIFECYCLE_STATES).toContain('accepted');
    expect(OPERATION_TRANSITIONS.accepted).toContain('claimed');
  });
});
