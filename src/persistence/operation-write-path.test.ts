/**
 * §3A.2 atomic start binding + projection cursor landmine tests (B1–B6).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { isoTimestamp } from '../lib/clock.js';
import { eventSequence, idempotencyKey, runId, type RunId } from '../domain/ids.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import { appendableEvent } from '../domain/events.js';
import {
  bindRunToOperationAtomically,
  operationId,
  type AcceptOperationInput,
} from './operation-repository.js';
import { registerRun } from './runs.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from './test-support.js';

const DRIVER_KINDS = await availableDriverKinds();
const AT = isoTimestamp('2026-07-18T10:00:00.000Z');
const PROJECTION_NAME = 'op_bind_counter';

interface CounterState {
  readonly count: number;
}

function acceptStart(operationIdValue: string, key: string): AcceptOperationInput {
  return {
    operationId: operationId(operationIdValue),
    actor: 'user-1',
    idempotencyKey: key,
    origin: 'cli',
    kind: 'start',
    command: { kind: 'start', workspace: '/tmp/ws', goal: 'bind' },
  };
}

function countEvents(key: string, owner: RunId): DomainEvent {
  return draftEvent({
    type: 'pause.user.requested',
    runId: owner,
    payload: {},
    idempotencyKey: idempotencyKey(key),
    occurredAt: AT,
  }) as DomainEvent;
}

function countRuns(db: TestDatabaseHandle['db']): number {
  return db.driver.prepare('SELECT COUNT(*) AS n FROM runs').get<{ n: number }>()?.n ?? 0;
}

function rawEventCursor(
  db: TestDatabaseHandle['db'],
  owner: RunId,
  name: string,
): number | null {
  const row = db.driver
    .prepare(
      'SELECT event_cursor FROM run_projections WHERE run_id = ? AND projection_name = ?',
    )
    .get<{ event_cursor: number | null }>([owner, name]);
  return row === undefined ? null : row.event_cursor;
}

describe.each(DRIVER_KINDS)('operation write path (%s)', (kind) => {
  let handle: TestDatabaseHandle | undefined;

  afterEach(() => {
    handle?.close();
    handle?.cleanup();
    handle = undefined;
  });

  it('createRun and the operation→run binding commit in ONE transaction', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;
    const opId = operationId('op-bind-ok');
    db.operations.accept(acceptStart('op-bind-ok', 'idem-bind-ok'));

    const created = runId('run_bind_ok');
    const bound = bindRunToOperationAtomically(db, {
      operationId: opId,
      createRun: () => {
        registerRun(db.driver, db.clock, created);
        return created;
      },
    });

    expect(bound).toBe(created);
    expect(db.operations.get(opId)?.runId).toBe(created);
    expect(countRuns(db)).toBe(1);
    const runRow = db.driver
      .prepare('SELECT run_id FROM runs WHERE run_id = ?')
      .get<{ run_id: string }>([created]);
    expect(runRow?.run_id).toBe(created);
  });

  it('a throw inside the binding transaction leaves neither the run nor the binding — no orphan run', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;
    const opId = operationId('op-bind-fail');
    db.operations.accept(acceptStart('op-bind-fail', 'idem-bind-fail'));
    const runsBefore = countRuns(db);

    const attempted = runId('run_bind_orphan');
    expect(() =>
      bindRunToOperationAtomically(db, {
        operationId: opId,
        createRun: () => {
          registerRun(db.driver, db.clock, attempted);
          throw new Error('simulated crash after registerRun');
        },
      }),
    ).toThrow(/simulated crash/);

    expect(db.operations.get(opId)?.runId).toBeUndefined();
    expect(countRuns(db)).toBe(runsBefore);
    const orphan = db.driver
      .prepare('SELECT run_id FROM runs WHERE run_id = ?')
      .get<{ run_id: string }>([attempted]);
    expect(orphan).toBeUndefined();
  });

  it('replaying a rolled-back start binds exactly one run and creates no duplicate', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;
    const opId = operationId('op-bind-replay');
    db.operations.accept(acceptStart('op-bind-replay', 'idem-bind-replay'));

    const firstAttempt = runId('run_bind_first');
    expect(() =>
      bindRunToOperationAtomically(db, {
        operationId: opId,
        createRun: () => {
          registerRun(db.driver, db.clock, firstAttempt);
          throw new Error('first attempt rolled back');
        },
      }),
    ).toThrow(/first attempt rolled back/);

    const secondAttempt = runId('run_bind_second');
    const bound = bindRunToOperationAtomically(db, {
      operationId: opId,
      createRun: () => {
        registerRun(db.driver, db.clock, secondAttempt);
        return secondAttempt;
      },
    });

    expect(bound).toBe(secondAttempt);
    expect(db.operations.get(opId)?.runId).toBe(secondAttempt);
    // Only the successful run row survives.
    expect(countRuns(db)).toBe(1);
    const rows = db.driver.prepare('SELECT run_id FROM runs').all<{ run_id: string }>();
    expect(rows.map((r) => r.run_id)).toEqual([secondAttempt]);

    // Re-binding the same run is a no-op; a different run would conflict.
    const again = bindRunToOperationAtomically(db, {
      operationId: opId,
      createRun: () => secondAttempt,
    });
    expect(again).toBe(secondAttempt);
    expect(countRuns(db)).toBe(1);
  });

  it('every projections.save call in the new operation modules passes an explicit eventCursor', async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(here, '../..');
    const targets = [
      path.join(here, 'operation-repository.ts'),
      path.join(here, 'database.ts'),
      path.join(repoRoot, 'src/app/commands/operation-recovery.ts'),
    ];

    const offenders: string[] = [];
    // Structural landmine guard: any `projections.save(...)` in the new
    // modules must pass the 4th eventCursor argument.
    const saveCall = /projections\s*\.\s*save\s*\(/g;

    for (const file of targets) {
      const source = fs.readFileSync(file, 'utf8');
      // Strip line comments so docs mentioning projections.save do not trip.
      const stripped = source.replace(/\/\/.*$/gm, '');
      let match: RegExpExecArray | null;
      const re = new RegExp(saveCall.source, 'g');
      while ((match = re.exec(stripped)) !== null) {
        const openIdx = (match.index ?? 0) + match[0].length - 1; // at '('
        // Walk the argument list with paren depth so nested calls are fine.
        let depth = 0;
        let args = '';
        for (let i = openIdx; i < stripped.length; i++) {
          const ch = stripped[i]!;
          if (ch === '(') depth += 1;
          else if (ch === ')') {
            depth -= 1;
            if (depth === 0) {
              args = stripped.slice(openIdx + 1, i);
              break;
            }
          }
        }
        // Top-level comma count → arity (empty args → 0).
        let arity = 0;
        if (args.trim().length > 0) {
          let d = 0;
          arity = 1;
          for (const ch of args) {
            if (ch === '(') d += 1;
            else if (ch === ')') d -= 1;
            else if (ch === ',' && d === 0) arity += 1;
          }
        }
        if (arity < 4) {
          offenders.push(
            `${path.basename(file)}: projections.save has ${arity} argument(s) (need ≥ 4)`,
          );
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('save-then-recover on the operation binding path does not double-fold', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;
    const opId = operationId('op-cursor-ok');
    db.operations.accept(acceptStart('op-cursor-ok', 'idem-cursor-ok'));

    const owner = runId('run_cursor_ok');
    bindRunToOperationAtomically(db, {
      operationId: opId,
      createRun: () => {
        registerRun(db.driver, db.clock, owner);
        // Append events and fold a counter WITH an explicit eventCursor —
        // the contract every new write path in this slice must uphold.
        const e1 = appendableEvent(countEvents('c-ok-1', owner));
        const e2 = appendableEvent(countEvents('c-ok-2', owner));
        const outcomes = db.events.appendBatch([e1, e2]);
        const last = outcomes[outcomes.length - 1]!.event.sequence;
        const folded: CounterState = { count: outcomes.length };
        db.projections.save(owner, PROJECTION_NAME, folded, last);
        return owner;
      },
    });

    const saved = db.projections.get<CounterState>(owner, PROJECTION_NAME);
    expect(saved?.state).toEqual({ count: 2 });
    expect(saved?.eventCursor).toBe(eventSequence(2));
    expect(rawEventCursor(db, owner, PROJECTION_NAME)).not.toBeNull();

    const recovered = db.projections.recover<CounterState>(
      owner,
      PROJECTION_NAME,
      (state) => ({ count: state.count + 1 }),
      { count: 0 },
    );

    // Cursor was non-NULL, so recover folds nothing further.
    expect(recovered.state).toEqual({ count: 2 });
    expect(recovered.eventCursor).toBe(eventSequence(2));
    expect(rawEventCursor(db, owner, PROJECTION_NAME)).toBe(2);
  });

  it('the cursor-less save landmine is real: the same sequence without a cursor double-folds', async () => {
    handle = await openTestDatabase({ kind, file: false });
    const db = handle.db;
    const owner = runId('run_cursor_landmine');
    registerRun(db.driver, db.clock, owner);

    const e1 = appendableEvent(countEvents('c-bad-1', owner));
    const e2 = appendableEvent(countEvents('c-bad-2', owner));
    const outcomes = db.events.appendBatch([e1, e2]);
    const folded: CounterState = { count: outcomes.length };

    // Deliberate 3-arg save — the hazard in projection-repository.ts:102-112.
    db.projections.save(owner, PROJECTION_NAME, folded);
    expect(rawEventCursor(db, owner, PROJECTION_NAME)).toBeNull();

    const recovered = db.projections.recover<CounterState>(
      owner,
      PROJECTION_NAME,
      (state) => ({ count: state.count + 1 }),
      { count: 0 },
    );

    // fromSequence is undefined → re-fold both events over already-folded state.
    expect(recovered.state).toEqual({ count: 4 });
    expect(recovered.eventCursor).toBe(eventSequence(2));
  });
});
