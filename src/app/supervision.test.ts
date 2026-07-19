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
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import {
  assignmentId,
  idempotencyKey,
  processGenerationId,
  segmentId,
  type ProcessGenerationId,
  type RunId,
} from '../domain/ids.js';
import { draftEvent, type DomainEvent, type LimitClassification } from '../domain/events.js';
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
import { unwrap } from '../lib/result.js';
import {
  LimitPausedError,
  OrchestrationService,
  captureAcpProcessIdentity,
  type RoleAdapterFactory,
  type SupervisionOptions,
} from './service.js';
import { ENGINE_STATE_PROJECTION } from './projections.js';
import { DurableProcessRegistryStore } from './process-registry-store.js';
import type { RoleRunner } from './role-runner.js';

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;

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
}

function makeSupervisedFactory(
  ps: FakePs,
  opts: SupervisedFactoryOptions = {},
): { factory: RoleAdapterFactory; adapters: InProcessFakeAdapter[] } {
  const adapters: InProcessFakeAdapter[] = [];
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
      const pid = nextPid;
      nextPid += 1;
      ps.identities.set(pid, sampleFor(pid));
      return {
        adapter,
        captureProcessIdentity: (generationId: ProcessGenerationId) =>
          identityFor(pid, generationId),
        dispose: (): Promise<void> => adapter.close(),
      };
    },
  };
  return { factory, adapters };
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
}

async function setup(opts: {
  readonly factory?: SupervisedFactoryOptions;
  readonly supervision?: Partial<SupervisionOptions>;
  readonly budgetMb?: number;
} = {}): Promise<SetupResult> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const db = handle.db;
  const ps = makeFakePs();
  const { factory, adapters } = makeSupervisedFactory(ps, opts.factory ?? {});
  const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  const config =
    opts.budgetMb !== undefined
      ? unwrap(parseEngineConfig({ memory: { budgetMb: opts.budgetMb } }))
      : undefined;
  const service = new OrchestrationService({
    db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
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
  return { service, db, ps, adapters, signals };
}

function eventTypes(db: TestDatabaseHandle['db'], runId: RunId): string[] {
  return db.events.listByRun(runId).map((e) => e.type);
}

function engineState(db: TestDatabaseHandle['db'], runId: RunId): EngineState {
  const record = db.projections.get<EngineState>(runId, ENGINE_STATE_PROJECTION);
  if (record === undefined) throw new Error('engine projection missing');
  return record.state;
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
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
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
    const { service } = await setup({
      factory: { turns: [{ errorEnvelope: rateLimitErrorEnvelope({}) }] },
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

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
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

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

    expect(summary.killedCount).toBe(1);
    expect(summary.skippedCount).toBe(3);
    expect(signals).toEqual([{ pgid: 42_001, signal: 'SIGKILL' }]);

    // Killed record removed; every withheld record retained (never silently dropped).
    const remaining = service.supervision.registry.store.list().map((r) => r.pid);
    expect(remaining.sort()).toEqual([42_002, 42_003, 42_004]);

    // §14 alerts are durable events on the owning run, naming the verdicts.
    const alerts = db.events
      .listByRun(runId)
      .filter((e) => e.type === 'process.identity.alert')
      .map((e) => (e.payload as { verdict: string }).verdict)
      .sort();
    expect(alerts).toEqual(['mismatch', 'nonce_mismatch', 'nonce_unverifiable']);
  });

  it('a provably-GONE generation reconciles the pause spine: stop-intent confirmed, record dropped, nothing signaled', async () => {
    const { service, db, signals } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

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

    const summary = service.reapOrphanProcesses();
    expect(summary.killedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
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
      adapterFactory: {
        create: () => {
          throw new Error('creator service never spawns in this test');
        },
      },
    });
    const { runId } = creator.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const ps = makeFakePs();
    const { factory } = makeSupervisedFactory(ps);
    const service = new OrchestrationService({
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: factory, // DEFAULT config: budget would be 1024MB
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
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    let closedDuringRun = false;
    await service.runRole(
      runId,
      runnerWith(async () => {
        const generation = service.supervision.registry.store.list()[0]!.generationId;
        ps.rssBytes = 70 * MB; // 109% of budget: graceful zone, under the 150% ceiling
        await service.supervision.watchdog.sampleOnce(generation);
        closedDuringRun = adapters[0]!.log.some((entry) => entry.op === 'close');
      }),
      CLAUDE_LOW,
      '/ws',
    );

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
    expect(closedDuringRun).toBe(true);
    // The stop was clean → the durable identity record is gone.
    expect(service.supervision.registry.store.list()).toEqual([]);
  });

  it('T22 emergency: ceiling crossing SIGKILLs identity-verified, taints via the ATTACHED manager, and folds the engine effects', async () => {
    const { service, db, ps, signals } = await setup({ budgetMb: 64 });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_wd_emergency');
    const taints: Array<{ assignmentId: string; taint: string }> = [];
    service.attachWorktreeSupervision({
      markTainted: (a, taint) => taints.push({ assignmentId: String(a), taint }),
      awaitGitOpIdle: async () => 'idle' as const,
    });

    await service.runRole(
      runId,
      runnerWith(async () => {
        const generation = service.supervision.registry.store.list()[0]!.generationId;
        ps.rssBytes = 100 * MB; // 156% of budget: over the 150% emergency ceiling
        await service.supervision.watchdog.sampleOnce(generation);
      }),
      CLAUDE_LOW,
      '/ws',
      { round: 1, assignmentId: asg },
    );
    service.detachWorktreeSupervision();

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
});

// ---------------------------------------------------------------------------
// §14 self-supervision heartbeat
// ---------------------------------------------------------------------------
describe('runRole heartbeat wiring (§14: stall observability)', () => {
  it('ticks orchestrator.heartbeat for the run while a spawn is active and stops afterward', async () => {
    const { service, db } = await setup({ supervision: { heartbeatIntervalMs: 20 } });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

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
    registry.registerCaptured(identity!);
    expect(registry.verify(generation).verdict).toBe('match');

    // The transport really stamped HARNESS_SPAWN_ID (§10.1): the REAL
    // best-effort env reader confirms it on this platform (darwin/linux).
    if (process.platform === 'darwin' || process.platform === 'linux') {
      expect(createEnvNonceVerifier().verifyNonce(identity!.pid, identity!.spawnNonce)).toBe('match');

      // Full §14 startup reap: ps identity AND nonce verified → killed.
      const summary = registry.reapOrphans('SIGKILL');
      expect(summary.killedCount).toBe(1);
      expect(signals).toEqual([{ pgid: identity!.pid, signal: 'SIGKILL' }]);
    }
  }, 20_000);
});
