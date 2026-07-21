/**
 * W2-6 SUPERVISION WIRING (spec docs/specs/hardening-p4a.md §W2-6; PLAN §14)
 * — the §14 seams assembled into the application service:
 *
 *  - `RoleAdapterHandle.captureProcessIdentity` → the durable
 *    `ProcessRegistryStore` (SQLite projection layer), with the identity
 *    persisted BEFORE `child.spawned` commits and removed on clean dispose;
 *  - startup reaping through `reapOrphanProcesses`: identity-VERIFIED kills
 *    only (ps identity AND env-nonce where readable), §14 alerts as durable
 *    `process.identity.alert` events, and the pause spine's stop-intent
 *    reconciliation for provably-absent generations;
 *  - RSS watchdog wired into `runRole` (budget from the run's PINNED
 *    config): T21 soft-warn and T22 hard-limit ingest through the service —
 *    graceful checkpoint (`pre_graceful_stop`) + stop, else identity-verified
 *    emergency kill + worktree TAINT via the attached manager;
 *  - 60s heartbeat (§14 self-supervision) ticking for every active spawn;
 *  - watchers deregistered on every dispose path (completion, limit pause).
 *
 * Deterministic: in-process fake adapters + injected fake `ps`/signal/nonce
 * seams — except the LAST describe, which captures a REAL child process
 * (the fake ACP child) through the real transport + real `ps`.
 */
import { CLEAN_PINNED_WORKSPACE_GIT, createRunFixture } from './test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualClock, isoTimestamp } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import {
  assignmentId,
  idempotencyKey,
  processGenerationId,
  segmentId,
  type EventSequence,
  type ProcessGenerationId,
  type RunId,
} from '../domain/ids.js';
import { draftEvent, type DomainEvent, type LimitClassification } from '../domain/events.js';
import type { RoleName } from '../domain/state.js';
import type { EngineState } from '../domain/transitions.js';
import {
  AcpStdioAdapter,
  InProcessFakeAdapter,
  fakeAcpChildPath,
  rateLimitErrorEnvelope,
  writeScenarioFile,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../adapters/index.js';
import {
  ProcessRegistry,
  createEnvNonceVerifier,
  createPsClient,
  type ProcessIdentity,
  type ProcessIdentityRecord,
  type ProcessIdentitySample,
  type PsClient,
} from '../supervisor/index.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { parseEngineConfig } from '../config/loader.js';
import type { EngineConfig } from '../config/schema.js';
import { unwrap } from '../lib/result.js';
import {
  LimitPausedError,
  OrchestrationService,
  ProcessExitUnconfirmedError,
  ResourceExhaustedError,
  captureAcpProcessIdentity,
  type RoleAdapterFactory,
  type SupervisionOptions,
} from './service.js';
import {
  ENGINE_STATE_PROJECTION,
  ROLE_ROUND_PROJECTION,
  RUN_CONFIG_PROJECTION,
} from './projections.js';
import { DurableProcessRegistryStore } from './process-registry-store.js';
import {
  SPAWN_RESERVATION_PROJECTION,
  SPAWN_RESERVATION_SCOPE,
} from './spawn-reservation-store.js';
import type { RoleRunner } from './role-runner.js';

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const TEST_MB = 1024 * 1024;

function fakeConfigOptions(): ConfigOptionDescriptor[] {
  return [
    { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
    { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

// ---------------------------------------------------------------------------
// Fake `ps` — one mutable knob set per test (rss / identity table / liveness)
// ---------------------------------------------------------------------------
interface FakePs {
  readonly client: PsClient;
  rssBytes: number;
  treeGone: boolean;
  readonly identities: Map<number, ProcessIdentitySample>;
}

function makeFakePs(): FakePs {
  const fake: FakePs = {
    rssBytes: 0,
    treeGone: false,
    identities: new Map(),
    client: {
      sampleProcessTree(pgid: number) {
        if (fake.treeGone) return undefined;
        return {
          pgid,
          rssBytes: fake.rssBytes,
          processCount: 1,
          pids: [pgid],
          sampledAt: isoTimestamp('2026-07-19T00:00:00.000Z'),
        };
      },
      sampleIdentity(pid: number) {
        return fake.identities.get(pid);
      },
      isAlive(pid: number) {
        return fake.identities.has(pid);
      },
    },
  };
  return fake;
}

function sampleFor(pid: number): ProcessIdentitySample {
  return { pid, ppid: 1, pgid: pid, startedAt: `lstart-${pid}`, executablePath: '/fake/agent' };
}

function identityFor(pid: number, generationId: ProcessGenerationId): ProcessIdentity {
  const sample = sampleFor(pid);
  return {
    generationId,
    pid,
    pgid: sample.pgid,
    startedAt: sample.startedAt,
    executablePath: sample.executablePath,
    spawnNonce: `nonce-${pid}`,
  };
}

// ---------------------------------------------------------------------------
// Fake factory whose handles EXPOSE a §14 ProcessIdentity (W2-6) — the fake
// adapter itself stays an honest in-process fake; the identity is the
// HANDLE's contract, mirrored into the fake ps table so verification matches.
// ---------------------------------------------------------------------------
interface SupervisedFactoryOptions {
  readonly turns?: readonly InProcessTurnScript[];
  readonly onSetConfigOption?: (input: SetConfigOptionInput) => SetConfigOptionResult;
  readonly captureIdentity?: boolean;
  readonly disposeError?: Error;
  readonly hangDispose?: boolean;
  readonly hangCancel?: boolean;
  /** Defaults to true: a successful fake disposal is accompanied by the
   * independent fake-ps observation that its whole group disappeared. Set
   * false to model a dead leader with surviving descendants. */
  readonly treeGoneOnDispose?: boolean;
}

function makeSupervisedFactory(
  ps: FakePs,
  opts: SupervisedFactoryOptions = {},
): { factory: RoleAdapterFactory; adapters: InProcessFakeAdapter[]; disposeCalls: () => number } {
  const adapters: InProcessFakeAdapter[] = [];
  let disposeCalls = 0; // must-fix 5: count RAW handle.dispose() invocations (shared-dispose proof)
  let nextPid = 41_001;
  const factory: RoleAdapterFactory = {
    create() {
      const adapter = new InProcessFakeAdapter({
        harnessId: 'claude',
        capabilities: { configOptions: fakeConfigOptions() },
        ...(opts.turns !== undefined ? { turns: opts.turns } : {}),
        ...(opts.onSetConfigOption !== undefined
          ? { onSetConfigOption: opts.onSetConfigOption }
          : {}),
      });
      adapters.push(adapter);
      if (opts.hangCancel === true) {
        Object.defineProperty(adapter, 'cancelTurn', {
          configurable: true,
          value: (): Promise<void> => new Promise<void>(() => undefined),
        });
      }
      const pid = nextPid;
      nextPid += 1;
      if (opts.captureIdentity !== false) {
        ps.treeGone = false;
        ps.identities.set(pid, sampleFor(pid));
      }
      return {
        adapter,
        ...(opts.captureIdentity !== false
          ? {
              captureProcessIdentity: (generationId: ProcessGenerationId) =>
                identityFor(pid, generationId),
            }
          : {}),
        dispose: async (): Promise<void> => {
          disposeCalls += 1;
          if (opts.hangDispose === true) await new Promise<void>(() => undefined);
          if (opts.disposeError !== undefined) throw opts.disposeError;
          await adapter.close();
          if (opts.captureIdentity !== false && opts.treeGoneOnDispose !== false) {
            ps.treeGone = true;
          }
        },
      };
    },
  };
  return { factory, adapters, disposeCalls: () => disposeCalls };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

interface SetupResult {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly ps: FakePs;
  readonly adapters: InProcessFakeAdapter[];
  readonly signals: Array<{ pgid: number; signal: NodeJS.Signals }>;
  /** must-fix 5: raw handle.dispose() invocation count (shared-dispose proof). */
  readonly disposeCalls: () => number;
}

async function setup(opts: {
  readonly factory?: SupervisedFactoryOptions;
  readonly supervision?: Partial<SupervisionOptions>;
  readonly budgetMb?: number;
  /** A fully-parsed config to pin on the run (takes precedence over `budgetMb`). */
  readonly config?: EngineConfig;
} = {}): Promise<SetupResult> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const db = handle.db;
  const ps = makeFakePs();
  const { factory, adapters, disposeCalls } = makeSupervisedFactory(ps, opts.factory ?? {});
  const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  const config =
    opts.config ??
    (opts.budgetMb !== undefined
      ? unwrap(parseEngineConfig({ memory: { budgetMb: opts.budgetMb } }))
      : undefined);
  const service = new OrchestrationService({
    db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
    ...(config !== undefined ? { config } : {}),
    supervision: {
      ps: ps.client,
      sendSignal: (pgid, signal) => signals.push({ pgid, signal }),
      // Deterministic default for the fake-ps tests: the env of a fake pid
      // is not readable anywhere — individual tests override.
      envNonce: { verifyNonce: () => 'match' },
      ...(opts.supervision ?? {}),
    },
  });
  return { service, db, ps, adapters, signals, disposeCalls };
}

function eventTypes(db: TestDatabaseHandle['db'], runId: RunId): string[] {
  return db.events.listByRun(runId).map((e) => e.type);
}

function engineState(db: TestDatabaseHandle['db'], runId: RunId): EngineState {
  const record = db.projections.get<EngineState>(runId, ENGINE_STATE_PROJECTION);
  if (record === undefined) throw new Error('engine projection missing');
  return record.state;
}

function spawnReservationCount(db: TestDatabaseHandle['db']): number {
  const state = db.projections.get<{ readonly reservations: Record<string, unknown> }>(
    SPAWN_RESERVATION_SCOPE,
    SPAWN_RESERVATION_PROJECTION,
  )?.state;
  return Object.keys(state?.reservations ?? {}).length;
}

/** A coordinator runner delegating its body to the test. */
function runnerWith(body: (session: Parameters<RoleRunner['run']>[0]) => Promise<void>): RoleRunner {
  return {
    role: 'coordinator',
    run: async (session) => {
      await body(session);
      return {};
    },
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Durable ProcessRegistryStore (SQLite projection layer)
// ---------------------------------------------------------------------------
describe('DurableProcessRegistryStore — §14 identity survives the process', () => {
  it('put/get/list/remove round-trip, visible to a SECOND store instance over the same database', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const db = handle.db;
    const store = new DurableProcessRegistryStore(db);
    const record: ProcessIdentityRecord = {
      ...identityFor(500, processGenerationId('pgen_store_1')),
      recordedAt: db.clock.nowIso(),
    };
    expect(store.list()).toEqual([]);
    store.put(record);
    expect(store.get(record.generationId)).toEqual(record);

    // "Restart": a fresh store instance over the same persistence sees it —
    // exactly what startup orphan reaping across a crashed orchestrator needs.
    const successor = new DurableProcessRegistryStore(db);
    expect(successor.list()).toEqual([record]);
    successor.remove(record.generationId);
    expect(store.get(record.generationId)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Registry identity persisted BEFORE child.spawned; deregistered on dispose
// ---------------------------------------------------------------------------
describe('runRole §14 identity registration (W2-6)', () => {
  it('rejects a graceful T22 before launching cancel/dispose side effects when the generation is no longer active', async () => {
    const { service, db, ps, adapters, disposeCalls } = await setup({ budgetMb: 64 });
    const { runId } = createRunFixture(service, {
      goal: 'reject stale graceful T22',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    let sampleError: unknown;
    let disposeCallsAtRejection = -1;
    let cancelCallsAtRejection = -1;

    await service.runCoordination(
      runId,
      runnerWith(async () => {
        const generation = service.supervision.registry.store.list()[0]!.generationId;
        const state = engineState(db, runId);
        db.projections.save(runId, ENGINE_STATE_PROJECTION, { ...state, activeChild: undefined });
        ps.rssBytes = 70 * TEST_MB;
        sampleError = await service.supervision.watchdog
          .sampleOnce(generation)
          .then(() => undefined)
          .catch((error: unknown) => error);
        // The only later dispose is runRole's ordinary finally cleanup. The
        // rejected watchdog decision itself launched no transport callback.
        disposeCallsAtRejection = disposeCalls();
        cancelCallsAtRejection = adapters[0]!.log.filter((entry) => entry.op === 'cancelTurn').length;
      }),
    );

    expect(String(sampleError)).toContain('T22 stop intent was not durably applied');
    expect(disposeCallsAtRejection).toBe(0);
    expect(cancelCallsAtRejection).toBe(0);
    expect(disposeCalls()).toBe(1);
    expect(eventTypes(db, runId)).not.toContain('rss.hard_limit');
  });

  it('rejects an emergency T22 before SIGKILL or taint when the generation is no longer active', async () => {
    const { service, db, ps, signals, disposeCalls } = await setup({ budgetMb: 64 });
    const { runId } = createRunFixture(service, {
      goal: 'reject stale emergency T22',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const asg = assignmentId('asg_rejected_emergency');
    const taints: string[] = [];
    service.attachWorktreeSupervision({
      markTainted: (_assignment, taint) => taints.push(taint),
      awaitGitOpIdle: async () => 'idle' as const,
    });
    let sampleError: unknown;

    await service.runRole(
      runId,
      runnerWith(async () => {
        const generation = service.supervision.registry.store.list()[0]!.generationId;
        const state = engineState(db, runId);
        db.projections.save(runId, ENGINE_STATE_PROJECTION, { ...state, activeChild: undefined });
        ps.rssBytes = 100 * TEST_MB;
        sampleError = await service.supervision.watchdog
          .sampleOnce(generation)
          .then(() => undefined)
          .catch((error: unknown) => error);
        expect(disposeCalls()).toBe(0);
      }),
      CLAUDE_LOW,
      '/ws',
      { round: 1, assignmentId: asg },
    );
    service.detachWorktreeSupervision();

    expect(String(sampleError)).toContain('T22 stop intent was not durably applied');
    expect(signals).toEqual([]);
    expect(taints).toEqual([]);
    expect(eventTypes(db, runId)).not.toContain('rss.hard_limit');
  });

  it('fails closed when opaque disposal fails and retains the concurrency reservation', async () => {
    const config = unwrap(parseEngineConfig({ maxLiveChildren: 1 }));
    const { service } = await setup({
      config,
      factory: {
        captureIdentity: false,
        disposeError: new Error('synthetic opaque disposal failure'),
      },
    });
    const first = createRunFixture(service, { goal: 'first', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const error = await service
      .runCoordination(first.runId, runnerWith(async () => undefined))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProcessExitUnconfirmedError);
    expect(String(error)).toContain('shutdown ownership retained');
    expect(service.supervision.registry.store.list()).toEqual([]);

    // No identity existed and disposal failed, so neither permitted exit
    // confirmation source fired. A later spawn is refused at capacity: the
    // slot/reservation was not released merely because cleanup threw.
    const second = createRunFixture(service, { goal: 'second', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const capacity = await service
      .runCoordination(second.runId, runnerWith(async () => undefined))
      .catch((caught: unknown) => caught);
    expect(String(capacity)).toMatch(/max-live-children guard: at capacity/i);
  });

  it('bounds an identity-less hung disposal without confirming exit or releasing capacity', async () => {
    const config = unwrap(
      parseEngineConfig({
        maxLiveChildren: 1,
        memory: { gracefulStopDeadlineMs: 25 },
      }),
    );
    const { service, disposeCalls } = await setup({
      config,
      factory: { captureIdentity: false, hangDispose: true },
    });
    const first = createRunFixture(service, {
      goal: 'identityless hung disposal',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });

    const error = await Promise.race([
      service
        .runCoordination(first.runId, runnerWith(async () => undefined))
        .catch((caught: unknown) => caught),
      sleep(1_000).then(() => new Error('identityless disposal remained unbounded')),
    ]);
    expect(error).toBeInstanceOf(ProcessExitUnconfirmedError);
    expect(String(error)).not.toContain('remained unbounded');
    expect(disposeCalls()).toBe(1);
    expect(service.status(first.runId).activeChild?.status).toBe('active');

    const second = createRunFixture(service, {
      goal: 'capacity remains owned',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const capacity = await service
      .runCoordination(second.runId, runnerWith(async () => undefined))
      .catch((caught: unknown) => caught);
    expect(String(capacity)).toMatch(/max-live-children guard: at capacity/i);
  });

  it('A1 does not treat identity-backed disposal as exit while descendants remain in the PGID', async () => {
    const config = unwrap(
      parseEngineConfig({
        maxLiveChildren: 1,
        memory: { gracefulStopDeadlineMs: 25 },
      }),
    );
    const { service, db, ps, disposeCalls } = await setup({
      config,
      factory: { treeGoneOnDispose: false },
    });
    const { runId } = createRunFixture(service, {
      goal: 'leader exits but descendant survives',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });

    const error = await Promise.race([
      service
        .runCoordination(runId, runnerWith(async () => undefined))
        .catch((caught: unknown) => caught),
      sleep(1_000).then(() => new Error('live whole-PGID confirmation remained unbounded')),
    ]);

    expect(error).toBeInstanceOf(ProcessExitUnconfirmedError);
    expect(String(error)).not.toContain('remained unbounded');
    expect(disposeCalls()).toBe(1);
    const generation = service.supervision.registry.store.list()[0]!.generationId;
    // The transport/leader closed, but fake ps still observes a descendant in
    // the recorded group. No durable stop or ownership release is permitted.
    expect(engineState(db, runId).activeChild).toMatchObject({
      generationId: generation,
      status: 'active',
    });
    expect(eventTypes(db, runId)).not.toContain('child.stopped');
    expect(service.supervision.watchdog.isWatching(generation)).toBe(true);
    expect(spawnReservationCount(db)).toBe(1);

    ps.treeGone = true;
    await service.supervision.watchdog.sampleOnce(generation);
    for (let attempt = 0; attempt < 50 && service.supervision.registry.store.list().length > 0; attempt += 1) {
      await sleep(5);
    }
    expect(engineState(db, runId).activeChild?.status).toBe('stopped');
    expect(service.supervision.registry.store.list()).toEqual([]);
    expect(service.supervision.watchdog.isWatching(generation)).toBe(false);
    expect(spawnReservationCount(db)).toBe(0);
  });

  it('R1 retains all ownership when durable RSS finalization fails, then retries after a later absence sample', async () => {
    const { service, db, ps } = await setup({ budgetMb: 64 });
    const { runId } = createRunFixture(service, {
      goal: 'durable ordering',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const realTransactionImmediate = db.transactionImmediate.bind(db);
    let failFinalization = false;
    Object.defineProperty(db, 'transactionImmediate', {
      configurable: true,
      value: <T>(fn: () => T): T => {
        if (failFinalization) {
          failFinalization = false;
          throw new Error('synthetic durable finalization failure');
        }
        return realTransactionImmediate(fn);
      },
    });

    const error = await service
      .runCoordination(
        runId,
        runnerWith(async () => {
          const record = service.supervision.registry.store.list()[0]!;
          service.ingest(
            draftEvent({
              type: 'rss.hard_limit',
              runId,
              idempotencyKey: idempotencyKey('r1-finalization-intent'),
              occurredAt: db.clock.nowIso(),
              payload: {
                semanticsVersion: 2,
                generationId: record.generationId,
                role: 'coordinator',
                rssBytes: 70 * 1024 * 1024,
                budgetBytes: 64 * 1024 * 1024,
                escalation: 'graceful',
              },
            }),
          );
          // The next immediate transaction is the terminal RSS fold. Its
          // failure must precede every cleanup/release side effect.
          failFinalization = true;
        }),
      )
      .catch((caught: unknown) => caught);

    expect(String(error)).toContain('synthetic durable finalization failure');
    const retained = service.supervision.registry.store.list()[0]!;
    expect(retained).toBeDefined();
    expect(service.supervision.watchdog.isWatching(retained.generationId)).toBe(true);
    expect(eventTypes(db, runId)).not.toContain('resource.exhausted');
    expect(engineState(db, runId).activeChild).toMatchObject({
      generationId: retained.generationId,
      status: 'stopping',
    });

    // The retained watchdog/registry record is a real retry path. A later
    // tree-absence observation re-runs the idempotent durable fold, then (and
    // only then) removes supervision and admission ownership.
    ps.treeGone = true;
    await service.supervision.watchdog.sampleOnce(retained.generationId);
    for (let attempt = 0; attempt < 50 && service.supervision.registry.store.list().length > 0; attempt += 1) {
      await sleep(5);
    }
    expect(eventTypes(db, runId)).toContain('resource.exhausted');
    expect(service.supervision.registry.store.list()).toEqual([]);
    expect(service.supervision.watchdog.isWatching(retained.generationId)).toBe(false);
  });

  it('R2 bounds an ambiguous emergency wait without orphaning supervision, then accepts later absence', async () => {
    const config = unwrap(
      parseEngineConfig({
        maxLiveChildren: 1,
        memory: { budgetMb: 64, gracefulStopDeadlineMs: 25 },
      }),
    );
    const { service, db, ps, signals } = await setup({
      config,
      factory: { disposeError: new Error('synthetic identity-backed disposal failure') },
    });
    const { runId } = createRunFixture(service, {
      goal: 'ambiguous supervision',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    let generation: ProcessGenerationId | undefined;

    const error = await Promise.race([
      service
        .runCoordination(
          runId,
          runnerWith(async () => {
            const record = service.supervision.registry.store.list()[0]!;
            generation = record.generationId;
            // Recycle the leader identity while the PGID tree remains alive.
            // Emergency signaling must be withheld, but supervision retained.
            ps.identities.set(record.pid, {
              ...sampleFor(record.pid),
              startedAt: 'recycled-leader',
            });
            ps.rssBytes = 100 * 1024 * 1024;
            await service.supervision.watchdog.sampleOnce(record.generationId);
          }),
        )
        .catch((caught: unknown) => caught),
      sleep(1_000).then(() => new Error('ambiguous exit barrier timed out')),
    ]);

    expect(error).toBeInstanceOf(ProcessExitUnconfirmedError);
    expect(String(error)).not.toContain('ambiguous exit barrier timed out');
    expect(generation).toBeDefined();
    expect(signals).toEqual([]);
    expect(eventTypes(db, runId)).not.toContain('rss.hard_limit');
    expect(service.supervision.watchdog.phaseOf(generation!)).toBe('ambiguous');
    expect(service.supervision.watchdog.isWatching(generation!)).toBe(true);
    expect(service.supervision.registry.store.get(generation!)).toBeDefined();

    // The timeout failed the waiter closed; it did not permanently latch the
    // barrier. Whole-tree absence still confirms, folds child.stopped, and
    // releases retained ownership through the late-recovery path.
    ps.treeGone = true;
    await service.supervision.watchdog.sampleOnce(generation!);
    for (let attempt = 0; attempt < 50 && service.supervision.registry.store.list().length > 0; attempt += 1) {
      await sleep(5);
    }
    expect(service.supervision.registry.store.list()).toEqual([]);
    expect(service.supervision.watchdog.isWatching(generation!)).toBe(false);
    expect(engineState(db, runId).activeChild?.status).toBe('stopped');
  });

  it('R2 late absence interrupts an abnormal no-T22 generation and releases all ownership', async () => {
    const config = unwrap(
      parseEngineConfig({
        maxLiveChildren: 1,
        memory: { budgetMb: 64, gracefulStopDeadlineMs: 25 },
      }),
    );
    const { service, db, ps, signals } = await setup({
      config,
      factory: { disposeError: new Error('synthetic abnormal disposal failure') },
    });
    const { runId } = createRunFixture(service, {
      goal: 'abnormal no-T22 late absence',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const countersBefore = engineState(db, runId).counters;
    let generation: ProcessGenerationId | undefined;

    const error = await Promise.race([
      service
        .runCoordination(
          runId,
          runnerWith(async () => {
            const record = service.supervision.registry.store.list()[0]!;
            generation = record.generationId;
            ps.identities.set(record.pid, {
              ...sampleFor(record.pid),
              startedAt: 'recycled-abnormal-leader',
            });
            ps.rssBytes = 100 * TEST_MB;
            await service.supervision.watchdog.sampleOnce(record.generationId);
            throw new Error('synthetic abnormal runner exit');
          }),
        )
        .catch((caught: unknown) => caught),
      sleep(1_000).then(() => new Error('abnormal ambiguity waiter remained unbounded')),
    ]);

    expect(error).toBeInstanceOf(ProcessExitUnconfirmedError);
    expect(String(error)).not.toContain('remained unbounded');
    expect(generation).toBeDefined();
    expect(signals).toEqual([]);
    expect(eventTypes(db, runId)).not.toContain('rss.hard_limit');
    expect(service.supervision.watchdog.isWatching(generation!)).toBe(true);
    expect(spawnReservationCount(db)).toBe(1);

    ps.treeGone = true;
    await service.supervision.watchdog.sampleOnce(generation!);
    for (let attempt = 0; attempt < 50 && service.supervision.registry.store.list().length > 0; attempt += 1) {
      await sleep(5);
    }

    const state = engineState(db, runId);
    expect(state.suspension.kind).toBe('interrupted');
    expect(state.activeChild?.status).toBe('stopped');
    expect(state.counters).toEqual(countersBefore);
    expect(eventTypes(db, runId)).toContain('recovery.initiated');
    expect(eventTypes(db, runId)).not.toContain('child.exited.unexpectedly');
    expect(service.supervision.registry.store.list()).toEqual([]);
    expect(service.supervision.watchdog.isWatching(generation!)).toBe(false);
    expect(spawnReservationCount(db)).toBe(0);
  });

  it('keeps a provider-limit stop watched and unconfirmed after identity-backed disposal fails', async () => {
    const config = unwrap(
      parseEngineConfig({
        maxLiveChildren: 1,
        memory: { gracefulStopDeadlineMs: 25 },
      }),
    );
    const { service, db, ps, disposeCalls } = await setup({
      config,
      factory: {
        turns: [{ errorEnvelope: rateLimitErrorEnvelope({}) }],
        disposeError: new Error('synthetic provider-pause disposal failure'),
      },
    });
    const { runId } = createRunFixture(service, {
      goal: 'provider limit barrier',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });

    const error = await Promise.race([
      service
        .runCoordination(
          runId,
          runnerWith(async (session) => {
            await session.prompt({ prompt: 'limit' });
          }),
        )
        .catch((caught: unknown) => caught),
      sleep(1_000).then(() => new Error('provider-limit barrier timed out')),
    ]);

    expect(error).toBeInstanceOf(ProcessExitUnconfirmedError);
    expect(String(error)).not.toContain('provider-limit barrier timed out');
    expect(disposeCalls()).toBe(1);
    const generation = service.supervision.registry.store.list()[0]!.generationId;
    expect(service.supervision.watchdog.isWatching(generation)).toBe(true);
    expect(engineState(db, runId).activeChild).toMatchObject({
      generationId: generation,
      status: 'stopping',
    });
    expect(eventTypes(db, runId)).not.toContain('child.stopped');

    ps.treeGone = true;
    await service.supervision.watchdog.sampleOnce(generation);
    for (let attempt = 0; attempt < 50 && service.supervision.registry.store.list().length > 0; attempt += 1) {
      await sleep(5);
    }
    expect(eventTypes(db, runId)).toContain('child.stopped');
    expect(
      db.events.listByRun(runId).find((event) => event.type === 'child.stopped')?.payload,
    ).toMatchObject({ reason: 'terminated' });
    expect(service.supervision.registry.store.list()).toEqual([]);
    expect(service.supervision.watchdog.isWatching(generation)).toBe(false);
  });

  it('bounds a hung provider-limit cancel and still reaches the one shared identity-less disposal', async () => {
    const config = unwrap(
      parseEngineConfig({ memory: { gracefulStopDeadlineMs: 25 } }),
    );
    const { service, db, disposeCalls } = await setup({
      config,
      factory: {
        captureIdentity: false,
        hangCancel: true,
        turns: [{ errorEnvelope: rateLimitErrorEnvelope({}) }],
      },
    });
    const { runId } = createRunFixture(service, {
      goal: 'hung provider cancel',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });

    const result = await Promise.race([
      service
        .runCoordination(
          runId,
          runnerWith(async (session) => {
            await session.prompt({ prompt: 'limit' });
          }),
        )
        .catch((caught: unknown) => caught),
      sleep(1_000).then(() => new Error('hung cancel was not bounded')),
    ]);

    expect(result).toBeInstanceOf(LimitPausedError);
    expect(String(result)).not.toContain('hung cancel was not bounded');
    expect(disposeCalls()).toBe(1);
    expect(service.status(runId).activeChild).toMatchObject({ status: 'stopped' });
    const stopped = db.events.listByRun(runId).find((event) => event.type === 'child.stopped');
    expect(stopped?.payload).toMatchObject({ reason: 'terminated' });
  });

  it('fails a provider-limit barrier closed without an unhandled rejection when stop setup throws', async () => {
    const config = unwrap(
      parseEngineConfig({ memory: { gracefulStopDeadlineMs: 25 } }),
    );
    const { service, db, disposeCalls } = await setup({
      config,
      factory: { turns: [{ errorEnvelope: rateLimitErrorEnvelope({}) }] },
    });
    const { runId } = createRunFixture(service, {
      goal: 'provider stop setup failure',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const realGet = db.projections.get.bind(db.projections);
    let setupFailures = 0;
    Object.defineProperty(db.projections, 'get', {
      configurable: true,
      value: (scope: RunId, name: string): unknown => {
        if (
          setupFailures === 0 &&
          scope === runId &&
          name === RUN_CONFIG_PROJECTION &&
          eventTypes(db, runId).includes('limit.classified.prompt_turn')
        ) {
          setupFailures += 1;
          throw new Error('synthetic provider-stop config failure');
        }
        return realGet(scope, name);
      },
    });

    const result = await Promise.race([
      service
        .runCoordination(
          runId,
          runnerWith(async (session) => {
            await session.prompt({ prompt: 'limit' });
          }),
        )
        .catch((caught: unknown) => caught),
      sleep(1_000).then(() => new Error('provider stop setup failure hung the barrier')),
    ]);

    expect(String(result)).not.toContain('hung the barrier');
    expect(setupFailures).toBe(1);
    // The throw occurred before cancel setup completed, but `finally` still
    // reached the shared disposal exactly once.
    expect(disposeCalls()).toBe(1);
    for (let attempt = 0; attempt < 50 && !eventTypes(db, runId).includes('child.stopped'); attempt += 1) {
      await sleep(5);
    }
    const stopped = db.events.listByRun(runId).find((event) => event.type === 'child.stopped');
    expect(stopped?.payload).toMatchObject({ reason: 'terminated' });
  });

  it('commits a durable T22 outcome on observed absence while the role runner is still hung', async () => {
    const { service, db, ps } = await setup({ budgetMb: 64 });
    const { runId } = createRunFixture(service, {
      goal: 'hung runner exit confirmation',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    let releaseRunner!: () => void;
    const holdRunner = new Promise<void>((resolve) => {
      releaseRunner = resolve;
    });
    let thresholdSampled!: () => void;
    const thresholdReached = new Promise<void>((resolve) => {
      thresholdSampled = resolve;
    });

    const running = service
      .runCoordination(
        runId,
        runnerWith(async () => {
          const generation = service.supervision.registry.store.list()[0]!.generationId;
          ps.rssBytes = 70 * TEST_MB;
          await service.supervision.watchdog.sampleOnce(generation);
          ps.treeGone = true;
          await service.supervision.watchdog.sampleOnce(generation);
          thresholdSampled();
          await holdRunner;
        }),
      )
      .catch((caught: unknown) => caught);

    await thresholdReached;
    for (let attempt = 0; attempt < 50 && !eventTypes(db, runId).includes('resource.exhausted'); attempt += 1) {
      await sleep(5);
    }
    expect(eventTypes(db, runId)).toContain('resource.exhausted');
    expect(service.status(runId).suspension).toBe('resource_exhausted');

    releaseRunner();
    expect(await running).toBeInstanceOf(ResourceExhaustedError);
  });

  it('retries an identity-less confirmed RSS outcome after a transient durable commit failure', async () => {
    const config = unwrap(parseEngineConfig({ maxLiveChildren: 1, memory: { budgetMb: 64 } }));
    const { service, db } = await setup({
      config,
      factory: { captureIdentity: false },
      supervision: { terminateGraceMs: 250 },
    });
    const first = createRunFixture(service, {
      goal: 'identityless durable retry',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const realTransactionImmediate = db.transactionImmediate.bind(db);
    let failFinalization = false;
    let injectedFailures = 0;
    Object.defineProperty(db, 'transactionImmediate', {
      configurable: true,
      value: <T>(fn: () => T): T => {
        if (failFinalization) {
          failFinalization = false;
          injectedFailures += 1;
          throw new Error('synthetic identityless finalization failure');
        }
        return realTransactionImmediate(fn);
      },
    });

    const firstError = await service
      .runCoordination(
        first.runId,
        runnerWith(async () => {
          const state = engineState(db, first.runId);
          const generation = state.activeChild!.generationId;
          service.ingest(
            draftEvent({
              type: 'rss.hard_limit',
              runId: first.runId,
              idempotencyKey: idempotencyKey('identityless-retry-t22'),
              occurredAt: db.clock.nowIso(),
              payload: {
                semanticsVersion: 2,
                generationId: generation,
                role: 'coordinator',
                rssBytes: 70 * TEST_MB,
                budgetBytes: 64 * TEST_MB,
                escalation: 'graceful',
              },
            }),
          );
          failFinalization = true;
        }),
      )
      .catch((caught: unknown) => caught);
    expect(String(firstError)).toContain('synthetic identityless finalization failure');
    expect(injectedFailures).toBe(1);

    // The failed commit did not release the sole capacity slot.
    const second = createRunFixture(service, {
      goal: 'capacity probe',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const beforeRetry = await service
      .runCoordination(second.runId, runnerWith(async () => undefined))
      .catch((caught: unknown) => caught);
    expect(String(beforeRetry)).toMatch(/max-live-children guard: at capacity/i);

    for (let attempt = 0; attempt < 100 && !eventTypes(db, first.runId).includes('resource.exhausted'); attempt += 1) {
      await sleep(5);
    }
    expect(eventTypes(db, first.runId)).toContain('resource.exhausted');
    // Retry success released ownership; the previously refused run can now
    // acquire the slot normally.
    await expect(
      service.runCoordination(second.runId, runnerWith(async () => undefined)),
    ).resolves.toBeDefined();
  });

  it('does not mark ownership released when durable reservation deletion fails, then retries it', async () => {
    const config = unwrap(parseEngineConfig({ maxLiveChildren: 1 }));
    const { service, db } = await setup({
      config,
      factory: { captureIdentity: false },
      supervision: { terminateGraceMs: 250 },
    });
    const realSave = db.projections.save.bind(db.projections);
    let failRelease = false;
    let releaseFailures = 0;
    Object.defineProperty(db.projections, 'save', {
      configurable: true,
      value: <S>(scope: RunId, name: string, state: S, eventCursor?: EventSequence): void => {
        if (
          failRelease &&
          scope === SPAWN_RESERVATION_SCOPE &&
          name === SPAWN_RESERVATION_PROJECTION
        ) {
          failRelease = false;
          releaseFailures += 1;
          throw new Error('synthetic reservation deletion failure');
        }
        realSave(scope, name, state, eventCursor);
      },
    });
    const first = createRunFixture(service, {
      goal: 'reservation release retry',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const releaseError = await service
      .runCoordination(
        first.runId,
        runnerWith(async () => {
          failRelease = true;
        }),
      )
      .catch((caught: unknown) => caught);
    expect(String(releaseError)).toContain('synthetic reservation deletion failure');
    expect(releaseFailures).toBe(1);

    const second = createRunFixture(service, {
      goal: 'reservation capacity check',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const retained = await service
      .runCoordination(second.runId, runnerWith(async () => undefined))
      .catch((caught: unknown) => caught);
    expect(String(retained)).toMatch(/max-live-children guard: at capacity/i);

    await sleep(300);
    await expect(
      service.runCoordination(second.runId, runnerWith(async () => undefined)),
    ).resolves.toBeDefined();
  });

  it('persists the identity in the DURABLE store before child.spawned commits, and removes it on clean dispose', async () => {
    let storeAtPinTime: readonly ProcessIdentityRecord[] | undefined;
    let spawnedAtPinTime: boolean | undefined;
    let serviceRef: OrchestrationService | undefined;
    let dbRef: TestDatabaseHandle['db'] | undefined;
    let runRef: RunId | undefined;
    const { service, db } = await setup({
      factory: {
        onSetConfigOption: (input) => {
          // Pin enforcement runs BETWEEN spawn and child.spawned: the durable
          // registry must already hold the identity here (a crash in this
          // window must leave a reapable record), while child.spawned has
          // not committed yet (pending/active split).
          if (serviceRef !== undefined && dbRef !== undefined && runRef !== undefined) {
            storeAtPinTime = serviceRef.supervision.registry.store.list();
            spawnedAtPinTime = eventTypes(dbRef, runRef).includes('child.spawned');
          }
          return { effectiveValue: input.value, echoed: true };
        },
      },
    });
    serviceRef = service;
    dbRef = db;
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    runRef = runId;

    await service.runCoordination(runId, runnerWith(async () => undefined));

    expect(storeAtPinTime).toBeDefined();
    expect(storeAtPinTime).toHaveLength(1);
    expect(storeAtPinTime![0]).toMatchObject({
      pid: 41_001,
      pgid: 41_001,
      runId,
      spawnNonce: 'nonce-41001',
    });
    expect(spawnedAtPinTime).toBe(false);

    // Clean dispose deregistered everything: no watcher, no durable record.
    expect(service.supervision.registry.store.list()).toEqual([]);
    expect(service.supervision.watchdog.isWatching(storeAtPinTime![0]!.generationId)).toBe(false);
  });

  it('a limit pause (T4) also stops the watchdog and deregisters the durable record on its dispose path', async () => {
    const { service, db } = await setup({
      factory: { turns: [{ errorEnvelope: rateLimitErrorEnvelope({}) }] },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const error: unknown = await service
      .runCoordination(
        runId,
        runnerWith(async (session) => {
          await session.prompt({ prompt: 'go' });
        }),
      )
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LimitPausedError);
    expect(service.status(runId).suspension).toBe('paused_limit');
    expect(service.supervision.registry.store.list()).toEqual([]);
    const stopped = db.events.listByRun(runId).find((event) => event.type === 'child.stopped');
    expect(stopped?.payload).toMatchObject({ reason: 'graceful' });
  });
});

// ---------------------------------------------------------------------------
// Startup reaping (§14): identity-verified only, nonce re-verified, alerts
// ---------------------------------------------------------------------------
describe('reapOrphanProcesses — §14 startup reaping over the durable registry', () => {
  function seedRecord(
    service: OrchestrationService,
    pid: number,
    generation: string,
    runId: RunId,
    overrides: Partial<ProcessIdentityRecord> = {},
  ): ProcessIdentityRecord {
    const record: ProcessIdentityRecord = {
      ...identityFor(pid, processGenerationId(generation)),
      runId,
      recordedAt: isoTimestamp('2026-07-19T00:00:00.000Z'),
      ...overrides,
    };
    service.supervision.registry.store.put(record);
    return record;
  }

  it('kills ONLY the ps-identity + nonce verified record; ambiguity withholds and surfaces durable §14 alerts', async () => {
    const { service, db, ps, signals } = await setup({
      supervision: {
        envNonce: {
          // pid 42001 verifies; 42002's env contradicts; 42003's env is unreadable.
          verifyNonce: (pid) =>
            pid === 42_001 ? 'match' : pid === 42_002 ? 'mismatch' : 'unavailable',
        },
      },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // Verified orphan: live, identity matches, nonce matches → killed.
    ps.identities.set(42_001, sampleFor(42_001));
    seedRecord(service, 42_001, 'pgen_reap_ok', runId);
    // Live process whose env nonce CONTRADICTS the record → withheld.
    ps.identities.set(42_002, sampleFor(42_002));
    seedRecord(service, 42_002, 'pgen_reap_noncemm', runId);
    // Live process whose env cannot be read → withheld (never kill on ambiguity).
    ps.identities.set(42_003, sampleFor(42_003));
    seedRecord(service, 42_003, 'pgen_reap_nonceua', runId);
    // Recycled pid: ps identity mismatches outright → withheld.
    ps.identities.set(42_004, { ...sampleFor(42_004), startedAt: 'someone-else' });
    seedRecord(service, 42_004, 'pgen_reap_mismatch', runId);

    const summary = service.reapOrphanProcesses();

    expect(summary.signalSentCount).toBe(1);
    expect(summary.confirmedGoneCount).toBe(0);
    expect(summary.skippedCount).toBe(3);
    expect(signals).toEqual([{ pgid: 42_001, signal: 'SIGKILL' }]);

    // Signal-sent is not exit-confirmed: all records remain owned until a
    // later sample observes absence; withheld records are also retained.
    const remaining = service.supervision.registry.store.list().map((r) => r.pid);
    expect(remaining.sort()).toEqual([42_001, 42_002, 42_003, 42_004]);

    // §14 alerts are durable events on the owning run, naming the verdicts.
    const alerts = db.events
      .listByRun(runId)
      .filter((e) => e.type === 'process.identity.alert')
      .map((e) => (e.payload as { verdict: string }).verdict)
      .sort();
    expect(alerts).toEqual(['mismatch', 'nonce_mismatch', 'nonce_unverifiable']);
  });

  it('a provably-GONE generation reconciles the pause spine: stop-intent confirmed, record dropped, nothing signaled', async () => {
    const { service, db, ps, signals } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // Build the crash window the spine documents: committed T4 (generation
    // STOPPING with a durable stop-intent) and NO child.stopped confirmation.
    const generation = processGenerationId('pgen_reap_gone');
    const segment = segmentId('seg_reap_gone');
    const now = db.clock.nowIso();
    service.ingest(
      draftEvent({
        type: 'child.spawn.initiated',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'coordinator' },
        idempotencyKey: idempotencyKey('reap_spawn_init'),
        occurredAt: now,
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'coordinator', pins: [] },
        idempotencyKey: idempotencyKey('reap_spawned'),
        occurredAt: now,
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'turn.started',
        runId,
        payload: { segmentId: segment, generationId: generation },
        idempotencyKey: idempotencyKey('reap_turn'),
        occurredAt: now,
      }) as DomainEvent,
    );
    const classification: LimitClassification = {
      kind: 'usage_limit',
      provider: 'claude',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
    };
    const paused = service.ingest(
      draftEvent({
        type: 'limit.classified.prompt_turn',
        runId,
        payload: { segmentId: segment, classification },
        idempotencyKey: idempotencyKey('reap_t4'),
        occurredAt: now,
      }) as DomainEvent,
    );
    expect(paused.status).toBe('applied');
    expect(engineState(db, runId).activeChild?.status).toBe('stopping');

    // The child's identity record survived the "crash" — but the process is
    // GONE (fake ps knows no pid 43001).
    seedRecord(service, 43_001, 'pgen_reap_gone', runId);

    ps.treeGone = true;
    const summary = service.reapOrphanProcesses();
    expect(summary.signalSentCount).toBe(0);
    expect(summary.confirmedGoneCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
    expect(summary.entries[0]!.action).toBe('confirmed_gone');
    expect(summary.entries[0]!.verification.verdict).toBe('gone');
    expect(signals).toEqual([]); // absent process: nothing to signal

    // §12.2/W2-3: identity-verified cleanup done → the confirmation lands.
    const stopped = db.events.listByRun(runId).find((e) => e.type === 'child.stopped');
    expect(stopped?.payload).toMatchObject({ generationId: generation, reason: 'startup_cleanup' });
    const state = engineState(db, runId);
    expect(state.activeChild?.status).toBe('stopped');
    expect(state.suspension.kind).toBe('paused_limit'); // the pause survives
    // Spent bookkeeping dropped: a later reap stays quiet.
    expect(service.supervision.registry.store.list()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// W4-0 peer safety + W4-4 T17 restart-safety producer (§14:139, §12.3, PLAN §5o)
// ---------------------------------------------------------------------------
describe('reapOrphanProcesses — W4-0 owner-liveness + W4-4 T17 producer', () => {
  const OWNER_A = 60_001;
  const OWNER_B = 60_002;
  const DEAD_OWNER = 59_999; // never in the fake ps identity table → provably dead

  /** Drive the run's engine to an ACTIVE generation (spawn-initiated → spawned). */
  function seedActiveChild(
    service: OrchestrationService,
    db: TestDatabaseHandle['db'],
    runId: RunId,
    generation: ProcessGenerationId,
    segment: ReturnType<typeof segmentId>,
  ): void {
    const now = db.clock.nowIso();
    service.ingest(
      draftEvent({
        type: 'child.spawn.initiated',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'coordinator' },
        idempotencyKey: idempotencyKey(`${generation}-init`),
        occurredAt: now,
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'coordinator', pins: [] },
        idempotencyKey: idempotencyKey(`${generation}-spawned`),
        occurredAt: now,
      }) as DomainEvent,
    );
  }

  it('a LIVE PEER orchestrator\'s active child is NEVER reaped, signaled, or interrupted (regression: fails without the ownerPid gate)', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const db = handle.db;
    const ps = makeFakePs();
    // Both orchestrator processes are alive; so is the peer's real child.
    ps.identities.set(OWNER_A, sampleFor(OWNER_A));
    ps.identities.set(OWNER_B, sampleFor(OWNER_B));
    const childPid = 61_001;
    ps.identities.set(childPid, sampleFor(childPid));

    const signalsA: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    const signalsB: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    // Process A owns a live run + child, registered in the SHARED durable store.
    const serviceA = new OrchestrationService({
      db,
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      supervision: {
        ps: ps.client,
        selfPid: OWNER_A,
        sendSignal: (pgid, signal) => signalsA.push({ pgid, signal }),
        envNonce: { verifyNonce: () => 'match' },
      },
    });
    const { runId } = createRunFixture(serviceA, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_peer_live');
    const segment = segmentId('seg_peer_live');
    seedActiveChild(serviceA, db, runId, generation, segment);
    serviceA.supervision.registry.registerCaptured(identityFor(childPid, generation), {
      runId,
      segmentId: segment,
    });
    expect(serviceA.supervision.registry.store.get(generation)?.ownerPid).toBe(OWNER_A);
    expect(engineState(db, runId).activeChild).toMatchObject({ generationId: generation, status: 'active' });

    // Process B (a DIFFERENT live orchestrator) reaps over the SAME store.
    const serviceB = new OrchestrationService({
      db,
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      supervision: {
        ps: ps.client,
        selfPid: OWNER_B,
        sendSignal: (pgid, signal) => signalsB.push({ pgid, signal }),
        envNonce: { verifyNonce: () => 'match' },
      },
    });
    const summary = serviceB.reapOrphanProcesses();

    // The peer's child was left entirely alone — the whole point of the gate.
    expect(summary.ownerLiveSkippedCount).toBe(1);
    expect(summary.signalSentCount).toBe(0);
    expect(summary.confirmedGoneCount).toBe(0);
    expect(signalsA).toEqual([]);
    expect(signalsB).toEqual([]);
    expect(serviceB.supervision.registry.store.get(generation)).toBeDefined();
    const state = engineState(db, runId);
    expect(state.activeChild).toMatchObject({ generationId: generation, status: 'active' });
    expect(state.suspension.kind).toBe('none'); // NOT interrupted
    expect(eventTypes(db, runId)).not.toContain('recovery.initiated');
    expect(eventTypes(db, runId)).not.toContain('child.exited.unexpectedly');
  });

  it('a dead-owner ACTIVE generation is interrupted only after post-signal absence is observed, never on signal acceptance', async () => {
    const { service, db, ps, signals } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_deadowner_active');
    const segment = segmentId('seg_deadowner_active');
    seedActiveChild(service, db, runId, generation, segment);
    const childPid = 62_001;
    ps.identities.set(childPid, sampleFor(childPid)); // child still alive → reapable
    service.supervision.registry.store.put({
      ...identityFor(childPid, generation),
      runId,
      segmentId: segment,
      recordedAt: db.clock.nowIso(),
      ownerPid: DEAD_OWNER, // the orchestrator that spawned it crashed
    });
    const before = engineState(db, runId).counters;

    const summary = service.reapOrphanProcesses();

    expect(summary.signalSentCount).toBe(1);
    expect(summary.confirmedGoneCount).toBe(0);
    expect(signals).toEqual([{ pgid: childPid, signal: 'SIGKILL' }]);
    expect(engineState(db, runId).suspension.kind).toBe('none');
    expect(engineState(db, runId).activeChild?.status).toBe('active');
    expect(service.supervision.registry.store.get(generation)).toBeDefined();

    ps.identities.delete(childPid); // later observation: process tree is absent
    ps.treeGone = true;
    const confirmed = service.reapOrphanProcesses();
    expect(confirmed.confirmedGoneCount).toBe(1);
    const state = engineState(db, runId);
    expect(state.suspension.kind).toBe('interrupted'); // T17
    expect(state.activeChild?.status).toBe('stopped');
    // T17, NOT T13: the recovery marker lands, no child-crash event, and the
    // RestartBreaker/respawn counters are untouched (orchestrator crash ≠ child crash).
    expect(eventTypes(db, runId)).toContain('recovery.initiated');
    expect(eventTypes(db, runId)).not.toContain('child.exited.unexpectedly');
    expect(state.counters).toEqual(before);
  });

  it('startup reconciles an identity-mismatched record when its recorded PGID is independently absent', async () => {
    const { service, db, ps, signals } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_startup_mismatch_absent');
    const segment = segmentId('seg_startup_mismatch_absent');
    const childPid = 62_101;
    seedActiveChild(service, db, runId, generation, segment);
    // The recorded leader pid now resolves to an unrelated identity, but an
    // independent whole-PGID sample proves that the old group has no members.
    ps.identities.set(childPid, { ...sampleFor(childPid), startedAt: 'recycled-start' });
    ps.treeGone = true;
    service.supervision.registry.store.put({
      ...identityFor(childPid, generation),
      runId,
      segmentId: segment,
      recordedAt: db.clock.nowIso(),
      ownerPid: DEAD_OWNER,
    });
    const before = engineState(db, runId).counters;

    const summary = service.reapOrphanProcesses();

    expect(summary.signalSentCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
    expect(summary.confirmedGoneCount).toBe(1);
    expect(summary.entries[0]).toMatchObject({
      generationId: generation,
      action: 'confirmed_gone',
      verification: { verdict: 'mismatch' },
    });
    expect(signals).toEqual([]);
    expect(service.supervision.registry.store.get(generation)).toBeUndefined();
    const state = engineState(db, runId);
    expect(state.suspension.kind).toBe('interrupted');
    expect(state.activeChild?.status).toBe('stopped');
    expect(state.counters).toEqual(before);
    expect(eventTypes(db, runId)).toContain('process.identity.alert');
    expect(eventTypes(db, runId)).toContain('recovery.initiated');
    expect(eventTypes(db, runId)).not.toContain('child.exited.unexpectedly');
  });

  it('retains the startup retry record when a raced T4 makes T17 reject with the generation still live', async () => {
    const classification: LimitClassification = {
      kind: 'usage_limit',
      provider: 'claude',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
    };
    const { service, db, ps, signals } = await setup();
    const { runId } = createRunFixture(service, {
      goal: 'startup T17 commit-before-release',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const generation = processGenerationId('pgen_startup_t17_rejected');
    const segment = segmentId('seg_startup_t17_rejected');
    const childPid = 62_151;
    seedActiveChild(service, db, runId, generation, segment);
    ps.identities.set(childPid, { ...sampleFor(childPid), startedAt: 'recycled-start' });
    ps.treeGone = true;
    service.supervision.registry.store.put({
      ...identityFor(childPid, generation),
      runId,
      segmentId: segment,
      recordedAt: db.clock.nowIso(),
      ownerPid: DEAD_OWNER,
    });

    // Race T4 after reapOrphanProcesses has loaded the ACTIVE child but before
    // it emits T17. getRoleRound is the next service seam in that exact gap.
    const getRoleRound = service.getRoleRound.bind(service);
    let raced = false;
    const roundSpy = vi.spyOn(service, 'getRoleRound').mockImplementation((queriedRunId) => {
      if (!raced && queriedRunId === runId) {
        raced = true;
        const now = db.clock.nowIso();
        service.ingest(
          draftEvent({
            type: 'turn.started',
            runId,
            payload: { segmentId: segment, generationId: generation },
            idempotencyKey: idempotencyKey('startup-t17-race-turn'),
            occurredAt: now,
          }) as DomainEvent,
        );
        service.ingest(
          draftEvent({
            type: 'limit.classified.prompt_turn',
            runId,
            payload: { segmentId: segment, classification },
            idempotencyKey: idempotencyKey('startup-t17-race-t4'),
            occurredAt: now,
          }) as DomainEvent,
        );
      }
      return getRoleRound(queriedRunId);
    });

    const first = service.reapOrphanProcesses();
    roundSpy.mockRestore();

    expect(raced).toBe(true);
    expect(first.confirmedGoneCount).toBe(1);
    expect(signals).toEqual([]);
    expect(engineState(db, runId).activeChild).toMatchObject({
      generationId: generation,
      status: 'stopping',
    });
    expect(engineState(db, runId).suspension.kind).toBe('paused_limit');
    expect(
      db.events.listByRun(runId).some(
        (event) =>
          event.type === 'transition.rejected' &&
          event.payload.attemptedEventType === 'recovery.running_segment_found',
      ),
    ).toBe(true);
    expect(eventTypes(db, runId)).not.toContain('recovery.initiated');
    // The durable recovery did not commit, so startup ownership remains as
    // the only retry path even though the PGID is already confirmed absent.
    expect(service.supervision.registry.store.get(generation)).toBeDefined();

    // A later startup pass sees the durable T4 stop intent, confirms it, and
    // only then acknowledges the retained registry record.
    expect(service.reapOrphanProcesses().confirmedGoneCount).toBe(1);
    expect(engineState(db, runId).activeChild?.status).toBe('stopped');
    expect(service.supervision.registry.store.get(generation)).toBeUndefined();
  });

  it('a completed reaped generation is confirmed stopped only after observed absence — no interrupt or counter', async () => {
    const { service, db, ps, signals } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_completed_round');
    const segment = segmentId('seg_completed_round');
    seedActiveChild(service, db, runId, generation, segment);
    const childPid = 63_001;
    ps.identities.set(childPid, sampleFor(childPid));
    service.supervision.registry.store.put({
      ...identityFor(childPid, generation),
      runId,
      segmentId: segment,
      recordedAt: db.clock.nowIso(),
      ownerPid: DEAD_OWNER,
    });
    // The round had already SUCCEEDED when the orchestrator crashed.
    db.projections.save(runId, ROLE_ROUND_PROJECTION, {
      round: 1,
      role: 'implementor',
      stage: 'completed',
    });
    const before = engineState(db, runId).counters;

    const summary = service.reapOrphanProcesses();

    expect(summary.signalSentCount).toBe(1);
    expect(summary.confirmedGoneCount).toBe(0);
    expect(signals).toEqual([{ pgid: childPid, signal: 'SIGKILL' }]);
    expect(engineState(db, runId).activeChild?.status).toBe('active');
    expect(service.supervision.registry.store.get(generation)).toBeDefined();

    ps.identities.delete(childPid);
    ps.treeGone = true;
    expect(service.reapOrphanProcesses().confirmedGoneCount).toBe(1);
    const state = engineState(db, runId);
    expect(state.activeChild?.status).toBe('stopped'); // confirmed stopped
    expect(state.suspension.kind).toBe('none'); // NOT interrupted — the round succeeded
    expect(eventTypes(db, runId)).not.toContain('recovery.initiated');
    expect(eventTypes(db, runId)).not.toContain('child.exited.unexpectedly');
    const stopped = db.events.listByRun(runId).find((e) => e.type === 'child.stopped');
    expect(stopped?.payload).toMatchObject({ generationId: generation, reason: 'startup_cleanup' });
    expect(state.counters).toEqual(before);
  });

  it('T17 is REJECTED (benign no-op) on a paused_limit run and on a terminal run', async () => {
    const { service, db } = await setup();

    // (1) paused_limit: an active generation driven to T4 (child STOPPING).
    const paused = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const gen1 = processGenerationId('pgen_t17_paused');
    const seg1 = segmentId('seg_t17_paused');
    seedActiveChild(service, db, paused.runId, gen1, seg1);
    const now = db.clock.nowIso();
    service.ingest(
      draftEvent({
        type: 'turn.started',
        runId: paused.runId,
        payload: { segmentId: seg1, generationId: gen1 },
        idempotencyKey: idempotencyKey('t17-paused-turn'),
        occurredAt: now,
      }) as DomainEvent,
    );
    const classification: LimitClassification = {
      kind: 'usage_limit',
      provider: 'claude',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
    };
    service.ingest(
      draftEvent({
        type: 'limit.classified.prompt_turn',
        runId: paused.runId,
        payload: { segmentId: seg1, classification },
        idempotencyKey: idempotencyKey('t17-paused-t4'),
        occurredAt: now,
      }) as DomainEvent,
    );
    expect(engineState(db, paused.runId).suspension.kind).toBe('paused_limit');
    const rejectedPaused = service.ingest(
      draftEvent({
        type: 'recovery.running_segment_found',
        runId: paused.runId,
        payload: { segmentId: seg1, generationId: gen1 },
        idempotencyKey: idempotencyKey('t17-paused-reject'),
        occurredAt: db.clock.nowIso(),
      }) as DomainEvent,
    );
    expect(rejectedPaused.status).toBe('rejected');
    expect(engineState(db, paused.runId).suspension.kind).toBe('paused_limit'); // unchanged

    // (2) terminal: a cancelled run.
    const terminal = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const gen2 = processGenerationId('pgen_t17_terminal');
    const seg2 = segmentId('seg_t17_terminal');
    seedActiveChild(service, db, terminal.runId, gen2, seg2);
    service.cancel(terminal.runId);
    expect(engineState(db, terminal.runId).phase).toBe('cancelled');
    const rejectedTerminal = service.ingest(
      draftEvent({
        type: 'recovery.running_segment_found',
        runId: terminal.runId,
        payload: { segmentId: seg2, generationId: gen2 },
        idempotencyKey: idempotencyKey('t17-terminal-reject'),
        occurredAt: db.clock.nowIso(),
      }) as DomainEvent,
    );
    expect(rejectedTerminal.status).toBe('rejected');
    expect(engineState(db, terminal.runId).phase).toBe('cancelled'); // unchanged
  });
});

// ---------------------------------------------------------------------------
// RSS watchdog wired into runRole (T21 soft warn / T22 hard limit)
// ---------------------------------------------------------------------------
describe('runRole watchdog wiring — T21/T22 ingest through the service', () => {
  const MB = 1024 * 1024;

  it('T21: soft-threshold crossing ingests rss.soft_threshold with the run-PINNED budget (warn + notify emitted)', async () => {
    // The run is created under a 64MB pinned config; the driving service is
    // constructed with DEFAULT config (1024MB) — the watchdog must use the
    // run's pinned budget, not the process's (W1-F5 / W2-6).
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const db = handle.db;
    const pinned = unwrap(parseEngineConfig({ memory: { budgetMb: 64 } }));
    const creator = new OrchestrationService({
      db,
      ids: new DeterministicIdFactory(),
      config: pinned,
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      adapterFactory: {
        create: () => {
          throw new Error('creator service never spawns in this test');
        },
      },
    });
    const { runId } = createRunFixture(creator, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const ps = makeFakePs();
    const { factory } = makeSupervisedFactory(ps);
    const service = new OrchestrationService({
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: factory, // DEFAULT config: budget would be 1024MB
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      supervision: { ps: ps.client, sendSignal: () => undefined, envNonce: { verifyNonce: () => 'match' } },
    });

    await service.runRole(
      runId,
      runnerWith(async () => {
        const generation = service.supervision.registry.store.list()[0]!.generationId;
        // 52MB = 81% of the PINNED 64MB budget (would be 5% of the default
        // 1024MB — no warn at all under the wrong budget).
        ps.rssBytes = 52 * MB;
        await service.supervision.watchdog.sampleOnce(generation);
      }),
      CLAUDE_LOW,
      '/ws',
    );

    const types = eventTypes(db, runId);
    expect(types).toContain('rss.soft_threshold');
    expect(types).toContain('warn.rss_soft'); // T21 effect
    const notify = db.events
      .listByRun(runId)
      .filter((e) => e.type === 'notify.requested')
      .map((e) => (e.payload as { topic: string }).topic);
    expect(notify).toContain('rss_soft');
    const soft = db.events.listByRun(runId).find((e) => e.type === 'rss.soft_threshold');
    expect((soft?.payload as { budgetBytes: number }).budgetBytes).toBe(64 * MB);
  });

  it('T22 graceful: 100% crossing checkpoints (pre_graceful_stop) and drives the stop ladder through the service', async () => {
    const { service, db, ps, adapters } = await setup({ budgetMb: 64 });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    let closedDuringRun = false;
    const stopped = await service.runRole(
      runId,
      runnerWith(async () => {
        const generation = service.supervision.registry.store.list()[0]!.generationId;
        ps.rssBytes = 70 * MB; // 109% of budget: graceful zone, under the 150% ceiling
        await service.supervision.watchdog.sampleOnce(generation);
        closedDuringRun = adapters[0]!.log.some((entry) => entry.op === 'close');
      }),
      CLAUDE_LOW,
      '/ws',
    ).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(ResourceExhaustedError);

    const events = db.events.listByRun(runId);
    const hard = events.find((e) => e.type === 'rss.hard_limit');
    expect((hard?.payload as { escalation: string }).escalation).toBe('graceful');
    // T22 engine effects: checkpoint + graceful stop directives...
    const types = events.map((e) => e.type);
    expect(types).toContain('checkpoint.requested');
    expect(types).toContain('segment.stop.requested');
    // ...and the service EXECUTED them: mechanical checkpoint recorded with
    // the graceful-stop reason, then cancel + dispose (the fake logged both).
    const recorded = events.find((e) => e.type === 'checkpoint.recorded');
    expect((recorded?.payload as { reason: string }).reason).toBe('pre_graceful_stop');
    expect(adapters[0]!.log.some((entry) => entry.op === 'cancelTurn')).toBe(true);
    expect(closedDuringRun).toBe(false); // callback is deliberately non-blocking
    // The stop was clean → the durable identity record is gone.
    expect(service.supervision.registry.store.list()).toEqual([]);
  });

  it('T22 emergency: ceiling crossing SIGKILLs identity-verified, taints via the ATTACHED manager, and folds the engine effects', async () => {
    const { service, db, ps, signals } = await setup({ budgetMb: 64 });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_wd_emergency');
    const taints: Array<{ assignmentId: string; taint: string }> = [];
    service.attachWorktreeSupervision({
      markTainted: (a, taint) => taints.push({ assignmentId: String(a), taint }),
      awaitGitOpIdle: async () => 'idle' as const,
    });

    const err: unknown = await service
      .runRole(
        runId,
        runnerWith(async () => {
          const generation = service.supervision.registry.store.list()[0]!.generationId;
          ps.rssBytes = 100 * MB; // 156% of budget: over the 150% emergency ceiling
          await service.supervision.watchdog.sampleOnce(generation);
        }),
        CLAUDE_LOW,
        '/ws',
        { round: 1, assignmentId: asg },
      )
      .then(() => undefined)
      .catch((e: unknown) => e);
    service.detachWorktreeSupervision();

    // F1/F3: an emergency RSS kill DEFINITIVELY terminates the generation — the
    // run enters the distinct resource_exhausted suspension (durably, at kill
    // time), and the role flow aborts (never a T13 crash / auto-respawn).
    expect(err).toBeInstanceOf(ResourceExhaustedError);
    expect(service.status(runId).suspension).toBe('resource_exhausted');
    // Identity-verified SIGKILL to the process GROUP (§14 — via the registry,
    // never a raw kill).
    expect(signals).toEqual([{ pgid: 41_001, signal: 'SIGKILL' }]);
    // §16.3 taint through the attached worktree manager...
    expect(taints).toEqual([{ assignmentId: String(asg), taint: 'emergency_kill' }]);
    // ...and the durable T22 emergency effects.
    const events = db.events.listByRun(runId);
    const hard = events.find(
      (e) =>
        e.type === 'rss.hard_limit' &&
        (e.payload as { escalation: string }).escalation === 'emergency_kill',
    );
    expect(hard).toBeDefined();
    const stop = events.find((e) => e.type === 'segment.stop.requested');
    expect((stop?.payload as { mode: string }).mode).toBe('terminate');
    expect(events.some((e) => e.type === 'worktree.tainted')).toBe(true);
  });

  // W4-3 REGRESSION: aggregateWindow had NO production caller — the watchdog
  // recorded raw RSS ticks but nothing folded or pruned them, so aggregates
  // never appeared and raw_process_samples grew unbounded. The onSample hook
  // must now BOTH record the raw tick AND drive aggregateClosedWindows. Neuter
  // the aggregateClosedWindows call in service.ts#onSample and this fails:
  // the raw row survives (countRawSamples === 1) and no aggregate is produced.
  it('W4-3: onSample records the raw tick AND folds+prunes every closed window through the service', async () => {
    // Clock sits 5 minutes past the fake ps sample timestamp (2026-07-19T00:00:00Z),
    // so that sample's per-minute window has fully CLOSED and must be folded+pruned.
    const clock = new ManualClock('2026-07-19T00:05:00.000Z');
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false, clock });
    const db = handle.db;
    const ps = makeFakePs();
    const { factory } = makeSupervisedFactory(ps);
    const service = new OrchestrationService({
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: factory,
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      supervision: { ps: ps.client, sendSignal: () => undefined, envNonce: { verifyNonce: () => 'match' } },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    ps.rssBytes = 12 * MB; // ~1% of the default 1024MB budget — no soft/hard crossing
    await service.runRole(
      runId,
      runnerWith(async () => {
        const generation = service.supervision.registry.store.list()[0]!.generationId;
        await service.supervision.watchdog.sampleOnce(generation);
      }),
      CLAUDE_LOW,
      '/ws',
    );

    // The raw tick was recorded (recordRawSample) then the closed window was
    // folded into ONE aggregate and its raw rows PRUNED (bounded growth).
    expect(db.telemetry.countRawSamples(runId)).toBe(0);
    const aggregates = db.telemetry.listAggregates(runId);
    expect(aggregates).toHaveLength(1);
    expect(aggregates[0]!.rssMaxBytes).toBe(12 * MB);
    expect(aggregates[0]!.sampleCount).toBe(1);
  });

  // F4 (§review dogfood): the watchdog budget is keyed by the SPAWNING role, so
  // a per-role override applies to the right generation while a role without an
  // override falls back to the global budget — proven through the budgetBytes
  // the run-pinned config puts on `rss.soft_threshold` (as in the T21 test).
  it('F4: the watchdog uses the spawning role\'s pinned per-role budget, else the global fallback', async () => {
    const pinned = unwrap(
      parseEngineConfig({
        memory: { budgetMb: 64, perRole: { coordinator: { budgetMb: 32 }, implementor: { budgetMb: 48 } } },
      }),
    );
    const { service, db, ps } = await setup({ config: pinned });

    async function budgetSeenFor(role: RoleName, rssMb: number): Promise<number> {
      const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
      const run = async (): Promise<{}> => {
        const generation = service.supervision.registry.store.list()[0]!.generationId;
        ps.rssBytes = rssMb * MB;
        await service.supervision.watchdog.sampleOnce(generation);
        return {};
      };
      const runner: RoleRunner =
        role === 'implementor'
          ? { role, run, adjudicateRoundOutcome: () => 'completed' }
          : { role, run };
      await service.runRole(
        runId,
        runner,
        CLAUDE_LOW,
        '/ws',
      );
      const soft = db.events.listByRun(runId).find((e) => e.type === 'rss.soft_threshold');
      return (soft?.payload as { budgetBytes: number }).budgetBytes;
    }

    // coordinator override 32MB: 26MB = 81% of 32 (only ~40% of the global 64MB
    // — it would NOT even warn under the wrong, global budget).
    expect(await budgetSeenFor('coordinator', 26)).toBe(32 * MB);
    // implementor override 48MB: 40MB = 83% of 48.
    expect(await budgetSeenFor('implementor', 40)).toBe(48 * MB);
    // verifier has NO override → falls back to the global 64MB: 52MB = 81%.
    expect(await budgetSeenFor('verifier', 52)).toBe(64 * MB);
  });
});

// ---------------------------------------------------------------------------
// §14 self-supervision heartbeat
// ---------------------------------------------------------------------------
describe('runRole heartbeat wiring (§14: stall observability)', () => {
  it('ticks orchestrator.heartbeat for the run while a spawn is active and stops afterward', async () => {
    const { service, db } = await setup({ supervision: { heartbeatIntervalMs: 20 } });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    await service.runCoordination(
      runId,
      runnerWith(async () => {
        await sleep(120);
      }),
    );

    const during = eventTypes(db, runId).filter((t) => t === 'orchestrator.heartbeat').length;
    expect(during).toBeGreaterThanOrEqual(1);

    // The interval is stopped once no spawn is active: the count stays put.
    await sleep(80);
    const after = eventTypes(db, runId).filter((t) => t === 'orchestrator.heartbeat').length;
    expect(after).toBe(during);
  });
});

// ---------------------------------------------------------------------------
// REAL capture path: fake ACP child over the real transport + real ps
// ---------------------------------------------------------------------------
describe('captureAcpProcessIdentity — real child process through the real transport', () => {
  const clock = new ManualClock('2026-07-19T09:00:00.000Z');
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  it('captures {pid, pgid, start-time, executable, nonce}; the registry verifies, the env nonce matches, and reaping kills it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'supervision-capture-'));
    const scenarioPath = await writeScenarioFile({}, dir);
    const adapter = new AcpStdioAdapter({
      harnessId: 'fake-acp-child',
      spawn: { command: process.execPath, args: [fakeAcpChildPath(), scenarioPath] },
      spawnId: 'supervision-capture-nonce',
      clock,
    });
    cleanups.push(async () => {
      await adapter.close();
      await rm(dir, { recursive: true, force: true });
    });

    await adapter.initialize();
    const ps = createPsClient(clock);
    const generation = processGenerationId('pgen_capture_real');
    const identity = captureAcpProcessIdentity(adapter, generation, ps);

    expect(identity).toBeDefined();
    expect(identity!.pid).toBe(adapter.transportPid);
    expect(identity!.pgid).toBe(adapter.transportPid); // detached: own group leader (§10.1)
    expect(identity!.spawnNonce).toBe('supervision-capture-nonce');
    expect(identity!.executablePath).toBe(process.execPath);
    expect(identity!.startedAt.length).toBeGreaterThan(0);

    // The capture IS the verification baseline (§14).
    const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    const registry = new ProcessRegistry({
      clock,
      ps,
      envNonce: createEnvNonceVerifier(),
      sendSignal: (pgid, signal) => {
        signals.push({ pgid, signal });
        process.kill(-pgid, signal);
      },
    });
    const captured = registry.registerCaptured(identity!);
    expect(registry.verify(generation).verdict).toBe('match');
    // W4-0 (§14:139): startup reaping runs in a NEW process — the record it
    // finds was written by the PRIOR, now-crashed orchestrator. Re-stamp a
    // dead owner so the reaper treats this as a genuine orphan (a self-owned
    // LIVE record is never reaped — the peer-kill safety gate).
    registry.store.put({ ...captured, ownerPid: 999_999 });

    // The transport really stamped HARNESS_SPAWN_ID (§10.1): the REAL
    // best-effort env reader confirms it on this platform (darwin/linux).
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(createEnvNonceVerifier().verifyNonce(identity!.pid, identity!.spawnNonce)).toBe('match');

      // Full §14 startup reap: ps identity AND nonce verified → killed.
      const summary = registry.reapOrphans('SIGKILL');
      expect(summary.signalSentCount).toBe(1);
      expect(summary.confirmedGoneCount).toBe(0);
      expect(signals).toEqual([{ pgid: identity!.pid, signal: 'SIGKILL' }]);
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// F1/F3 (§review dogfood) — RSS resource-exhaustion is its OWN outcome +
// suspension (never a completed turn, a T13 crash, or a paused_limit).
// ---------------------------------------------------------------------------
describe('runRole RSS resource-exhaustion (F1/F3)', () => {
  const MB = 1024 * 1024;
  const DISPATCH = { round: 1, assignmentId: assignmentId('asg_re') } as const;

  function outcomes(db: TestDatabaseHandle['db'], runId: RunId): string[] {
    return db.events
      .listByRun(runId)
      .filter((e) => e.type === 'turn.completed')
      .map((e) => (e.payload as { outcome: string }).outcome);
  }

  it('F1 graceful: a watchdog cancel closes the turn resource_exhausted, suspends the run, and does NOT complete the round or count cadence', async () => {
    const { service, db, ps, disposeCalls } = await setup({
      budgetMb: 64,
      // A permission-scripted turn stays IN FLIGHT until the watchdog cancels it.
      factory: { turns: [{ permission: { description: 'need approval' } }] },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const err: unknown = await service
      .runRole(
        runId,
        {
          role: 'implementor',
          adjudicateRoundOutcome: () => 'completed',
          run: async (session) => {
            const generation = service.supervision.registry.store.list()[0]!.generationId;
            const promptPromise = session.prompt({ prompt: 'go' });
            ps.rssBytes = 70 * MB; // 109% of the 64MB budget → graceful zone
            await service.supervision.watchdog.sampleOnce(generation);
            await promptPromise; // rejects: the cancelled prompt is resource_exhausted
            return {};
          },
        },
        CLAUDE_LOW,
        '/ws',
        DISPATCH,
      )
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResourceExhaustedError);
    // The turn was closed resource_exhausted — never a `completed` turn, so the
    // cadence boundary (which only runs AFTER a completed turn) is never reached.
    // The ONLY checkpoint is the graceful stop's own `pre_graceful_stop` one —
    // never a `cadence` checkpoint counted against this exhausted turn.
    expect(outcomes(db, runId)).toEqual(['resource_exhausted']);
    const checkpointReasons = db.events
      .listByRun(runId)
      .filter((e) => e.type === 'checkpoint.recorded')
      .map((e) => (e.payload as { reason: string }).reason);
    expect(checkpointReasons).not.toContain('cadence');
    expect(checkpointReasons.every((r) => r === 'pre_graceful_stop')).toBe(true);
    // The run entered the DISTINCT resource_exhausted suspension (not paused_limit).
    expect(service.status(runId).suspension).toBe('resource_exhausted');
    // The role round did NOT complete — resume will re-drive the implementor.
    expect(service.getRoleRound(runId)?.stage).not.toBe('completed');
    // NOT a T13 crash — no restart counter, no auto-respawn.
    expect(eventTypes(db, runId)).not.toContain('child.exited.unexpectedly');
    expect(service.status(runId).counters.restartsInWindow).toBe(0);
    // The resource.exhausted incident is structured (role + budget).
    const incident = db.events.listByRun(runId).find((e) => e.type === 'resource.exhausted');
    expect(incident?.payload).toMatchObject({ role: 'implementor', budgetBytes: 64 * MB });
    // must-fix 5: the watchdog graceful stop and runRole's finally SHARE ONE
    // dispose — `handle.dispose()` was invoked exactly once (no concurrent
    // double-dispose), and the finally awaited the graceful stop before releasing.
    expect(disposeCalls()).toBe(1);
  });

  it('F1 SIGKILL: an emergency-kill during a turn is classified resource_exhausted, not a T13 crash', async () => {
    const { service, db, ps, adapters } = await setup({
      budgetMb: 64,
      factory: { turns: [{ permission: { description: 'need approval' } }] },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const err: unknown = await service
      .runRole(
        runId,
        {
          role: 'implementor',
          adjudicateRoundOutcome: () => 'completed',
          run: async (session) => {
            const generation = service.supervision.registry.store.list()[0]!.generationId;
            const promptPromise = session.prompt({ prompt: 'go' });
            ps.rssBytes = 100 * MB; // 156% of budget → over the emergency ceiling
            await service.supervision.watchdog.sampleOnce(generation); // rss.hard_limit{emergency_kill} → cause bound
            // The SIGKILL'd transport dies mid-turn: the in-flight prompt rejects
            // with a crash-shaped error, which routeProviderFailure must classify
            // resource_exhausted (the cause is bound), never a crash → T13.
            await adapters[0]!.close();
            await promptPromise;
            return {};
          },
        },
        CLAUDE_LOW,
        '/ws',
        DISPATCH,
      )
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ResourceExhaustedError);
    expect(outcomes(db, runId)).toEqual(['resource_exhausted']);
    expect(service.status(runId).suspension).toBe('resource_exhausted');
    expect(eventTypes(db, runId)).not.toContain('child.exited.unexpectedly'); // NOT T13
    expect(service.status(runId).counters.restartsInWindow).toBe(0);
  });

  it('F1 (1a): after an RSS emergency kill, a LATE child-crash for that generation can never fold T13 / auto-respawn', async () => {
    const { service, db, ps } = await setup({ budgetMb: 64 });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    let generation: ProcessGenerationId | undefined;
    const err: unknown = await service
      .runRole(
        runId,
        runnerWith(async () => {
          generation = service.supervision.registry.store.list()[0]!.generationId;
          ps.rssBytes = 100 * MB; // emergency → resource_exhausted DURABLY at kill time
          await service.supervision.watchdog.sampleOnce(generation);
        }),
        CLAUDE_LOW,
        '/ws',
        DISPATCH,
      )
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResourceExhaustedError);
    expect(service.status(runId).suspension).toBe('resource_exhausted');
    const before = service.status(runId).counters.restartsInWindow;

    // The pin-retry / late-detection crash path for the RSS-killed generation is
    // REJECTED — the durable suspension + already-stopped generation mean a T13
    // (crash → restart-window fold → AutoRespawnSignal) can NEVER apply.
    const segment = service.getRoleRound(runId)?.segmentId ?? segmentId('seg_late_crash');
    const rejected = service.ingest(
      draftEvent({
        type: 'child.exited.unexpectedly',
        runId,
        payload: { segmentId: segment, generationId: generation!, classifiedAs: 'crash' },
        idempotencyKey: idempotencyKey('late-crash'),
        occurredAt: db.clock.nowIso(),
      }) as DomainEvent,
    );
    expect(rejected.status).toBe('rejected');
    expect(service.status(runId).counters.restartsInWindow).toBe(before);
  });

  it('F1 race: a natural end_turn committed AFTER T22 v2 remains completed', async () => {
    const { service, db } = await setup({
      budgetMb: 64,
      factory: { turns: [{ updates: [{ kind: 'agent_message_chunk', text: 'done' }] }] },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    await service.runRole(
      runId,
      {
        role: 'implementor',
        adjudicateRoundOutcome: () => 'completed',
        run: async (session) => {
          const generation = service.supervision.registry.store.list()[0]!.generationId;
          let emitted = false;
          await session.prompt({
            prompt: 'go',
            onUpdate: () => {
              if (emitted) return;
              emitted = true;
              service.ingest(
                draftEvent({
                  type: 'rss.hard_limit',
                  runId,
                  idempotencyKey: idempotencyKey('rss-race'),
                  occurredAt: db.clock.nowIso(),
                  payload: {
                    semanticsVersion: 2,
                    generationId: generation,
                    role: 'implementor',
                    rssBytes: 70 * MB,
                    budgetBytes: 64 * MB,
                    escalation: 'graceful',
                  },
                }),
              );
            },
          });
          return {};
        },
      },
      CLAUDE_LOW,
      '/ws',
      DISPATCH,
    );

    expect(outcomes(db, runId)).toEqual(['completed']);
    expect(service.status(runId).suspension).not.toBe('resource_exhausted');
    expect(db.events.listByRun(runId).some((e) => e.type === 'resource.exhausted')).toBe(false);
  });

  it('F1 race: a natural end_turn after T22 confirms rss_race_completed even when adjudication later throws', async () => {
    const { service, db } = await setup({
      budgetMb: 64,
      factory: { turns: [{ updates: [{ kind: 'agent_message_chunk', text: 'done' }] }] },
    });
    const { runId } = createRunFixture(service, {
      goal: 'natural T22 race with adjudication failure',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });

    const failure = await service
      .runRole(
        runId,
        {
          role: 'implementor',
          adjudicateRoundOutcome: () => {
            throw new Error('synthetic adjudication failure after end_turn');
          },
          run: async (session) => {
            const generation = service.supervision.registry.store.list()[0]!.generationId;
            let emitted = false;
            await session.prompt({
              prompt: 'go',
              onUpdate: () => {
                if (emitted) return;
                emitted = true;
                service.ingest(
                  draftEvent({
                    type: 'rss.hard_limit',
                    runId,
                    idempotencyKey: idempotencyKey('rss-race-adjudication'),
                    occurredAt: db.clock.nowIso(),
                    payload: {
                      semanticsVersion: 2,
                      generationId: generation,
                      role: 'implementor',
                      rssBytes: 70 * MB,
                      budgetBytes: 64 * MB,
                      escalation: 'graceful',
                    },
                  }),
                );
              },
            });
            return {};
          },
        },
        CLAUDE_LOW,
        '/ws',
        DISPATCH,
      )
      .catch((caught: unknown) => caught);

    expect(String(failure)).toContain('synthetic adjudication failure after end_turn');
    expect(outcomes(db, runId)).toEqual(['completed']);
    expect(eventTypes(db, runId)).not.toContain('resource.exhausted');
    const stopped = db.events.listByRun(runId).find((event) => event.type === 'child.stopped');
    expect(stopped?.payload).toMatchObject({ reason: 'rss_race_completed' });
  });

  it('F1 (1d): a NON-RSS cancelled turn is recorded `cancelled` (not `completed`), counts no cadence', async () => {
    const { service, db, adapters } = await setup({
      budgetMb: 64,
      factory: { turns: [{ permission: { description: 'need approval' } }] },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const cancelled = await service.runRole(
      runId,
      {
        role: 'implementor',
        adjudicateRoundOutcome: () => 'completed',
        run: async (session) => {
          const promptPromise = session.prompt({ prompt: 'go' });
          // A plain (non-RSS) cancel — no rss.hard_limit was ever emitted, so no
          // exhaustion cause is bound; the prompt resolves `stopReason:'cancelled'`.
          await adapters[0]!.cancelTurn({ sessionId: session.handle.acpSessionId });
          await promptPromise;
          return {};
        },
      },
      CLAUDE_LOW,
      '/ws',
      DISPATCH,
    ).catch((error: unknown) => error);
    expect(cancelled).toMatchObject({ name: 'NoDeliverableError' });

    // Recorded `cancelled`, NOT `completed`; never resource_exhausted (no RSS cause).
    expect(outcomes(db, runId)).toEqual(['cancelled']);
    expect(service.status(runId).suspension).toBe('none');
    expect(service.getRoleRound(runId)?.stage).toBe('no_deliverable');
    // No cadence checkpoint counted against a cancelled turn.
    expect(
      db.events
        .listByRun(runId)
        .filter((e) => e.type === 'checkpoint.recorded')
        .map((e) => (e.payload as { reason: string }).reason),
    ).not.toContain('cadence');
  });

  it('F3: rss.hard_limit carries the role + generation (structured incident)', async () => {
    const { service, db, ps } = await setup({ budgetMb: 64 });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const stopped = await service.runRole(
      runId,
      runnerWith(async () => {
        const generation = service.supervision.registry.store.list()[0]!.generationId;
        ps.rssBytes = 70 * MB;
        await service.supervision.watchdog.sampleOnce(generation);
      }),
      CLAUDE_LOW,
      '/ws',
    ).catch((error: unknown) => error);
    expect(stopped).toBeInstanceOf(ResourceExhaustedError);
    const hard = db.events.listByRun(runId).find((e) => e.type === 'rss.hard_limit');
    expect(hard?.payload).toMatchObject({ role: 'coordinator', escalation: 'graceful' });
    expect((hard?.payload as { generationId?: string }).generationId).toBeDefined();
  });

  // -- F3 resume gating: no resume at the same budget; only after an audited raise
  async function driveToResourceExhausted(): Promise<{
    service: OrchestrationService;
    db: TestDatabaseHandle['db'];
    runId: RunId;
  }> {
    const { service, db, ps } = await setup({
      budgetMb: 64,
      factory: { turns: [{ permission: { description: 'need approval' } }] },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service
      .runRole(
        runId,
        {
          role: 'implementor',
          adjudicateRoundOutcome: () => 'completed',
          run: async (session) => {
            const generation = service.supervision.registry.store.list()[0]!.generationId;
            const p = session.prompt({ prompt: 'go' });
            ps.rssBytes = 70 * MB;
            await service.supervision.watchdog.sampleOnce(generation);
            await p;
            return {};
          },
        },
        CLAUDE_LOW,
        '/ws',
        DISPATCH,
      )
      .catch(() => undefined);
    expect(service.status(runId).suspension).toBe('resource_exhausted');
    return { service, db, runId };
  }

  it('F3: resume is REFUSED until an audited budget raise; ALLOWED after raiseRoleMemoryBudget', async () => {
    const { service, runId } = await driveToResourceExhausted();

    // Same budget → resume refused (it would re-cross the ceiling immediately).
    expect(() => service.resume(runId)).toThrow(/resource_exhausted|raise the role/i);

    // A lowering / equal is refused; a non-resource-exhausted run is refused elsewhere.
    expect(() => service.raiseRoleMemoryBudget(runId, 'implementor', 64)).toThrow(/must EXCEED/i);

    // An AUDITED raise above the exhausted budget unlocks the resume.
    const raised = service.raiseRoleMemoryBudget(runId, 'implementor', 256);
    expect(raised.status).toBe('recorded');
    const override = service
      .status(runId); // sanity: still resource_exhausted until the resume lands
    expect(override.suspension).toBe('resource_exhausted');

    const resumed = service.resume(runId);
    expect(resumed.status).toBe('applied'); // T12
    expect(service.status(runId).suspension).not.toBe('resource_exhausted');
  });

  it('F3: raiseRoleMemoryBudget is refused on a run that is not resource_exhausted', async () => {
    const { service } = await setup({ budgetMb: 64 });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    expect(() => service.raiseRoleMemoryBudget(runId, 'implementor', 256)).toThrow(
      /not resource_exhausted/i,
    );
  });

  it('F3: replay reconstructs the resource_exhausted suspension identically', async () => {
    const { db, runId } = await driveToResourceExhausted();
    // A fresh service over the SAME durable log re-derives the identical state.
    const replayed = new OrchestrationService({ db, ids: new DeterministicIdFactory() });
    expect(replayed.status(runId).suspension).toBe('resource_exhausted');
  });

  it('F3 (3b): entering resource_exhausted raises the operator notify + alert (distinct taxonomy)', async () => {
    const { db, runId } = await driveToResourceExhausted();
    const events = db.events.listByRun(runId);
    const notifies = events
      .filter((e) => e.type === 'notify.requested')
      .map((e) => (e.payload as { topic: string }).topic);
    expect(notifies).toContain('resource_exhausted');
    const alerts = events
      .filter((e) => e.type === 'alert.raised')
      .map((e) => (e.payload as { kind: string }).kind);
    expect(alerts).toContain('resource_exhausted');
  });

  it('F3 (3c): a directly-folded resource_exhausted run refuses resume at the same budget', async () => {
    // Drive resource_exhausted by folding `resource.exhausted` directly (not via
    // the watchdog), then assert the resume guard refuses at the same budget.
    // (The guard now also fails CLOSED if the suspension somehow existed with NO
    // discoverable incident — a defensive branch: a resource_exhausted suspension
    // is only ever produced by a `resource.exhausted` event, so that state is
    // unreachable through the normal folds, but the guard no longer trusts it.)
    const { service, db } = await setup({ budgetMb: 64 });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_re_orphan');
    const segment = segmentId('seg_re_orphan');
    const now = db.clock.nowIso();
    // Drive a live active generation, then fold resource.exhausted directly.
    service.ingest(
      draftEvent({
        type: 'child.spawn.initiated',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'implementor' },
        idempotencyKey: idempotencyKey('re-orphan-init'),
        occurredAt: now,
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'implementor', pins: [] },
        idempotencyKey: idempotencyKey('re-orphan-spawned'),
        occurredAt: now,
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'resource.exhausted',
        runId,
        payload: {
          generationId: generation,
          segmentId: segment,
          role: 'implementor',
          rssBytes: 100 * MB,
          budgetBytes: 64 * MB,
        },
        idempotencyKey: idempotencyKey('re-orphan-exhausted'),
        occurredAt: now,
      }) as DomainEvent,
    );
    expect(service.status(runId).suspension).toBe('resource_exhausted');
    // Now a discoverable incident EXISTS (the resource.exhausted above), and the
    // budget was NOT raised → refused as a same-budget re-entry.
    expect(() => service.resume(runId)).toThrow(/resource_exhausted|raise the role|re-cross/i);
  });
});
