/**
 * W3-2 CROSS-PROCESS CHILD CONTROL (spec docs/specs/hardening-p4a.md §W3-2;
 * PLAN §14 / §10.2) — a `pause`/`cancel` issued from a SECOND CLI process
 * must actually STOP the live child that a FIRST process is driving, not just
 * append the intent. The stop is routed through the DURABLE §14 process
 * registry: an identity-verified signal (pid + start-time + executable +
 * `HARNESS_SPAWN_ID` nonce) to the child's process GROUP. The owning process
 * observes the death through its transport and folds the generation-matched
 * `child.stopped` (that fold is pre-existing — runRole's `finally`/T13).
 *
 * Two layers of coverage:
 *  - DETERMINISTIC (fake `ps` + injected signal/nonce/sleep seams): the
 *    identity-verified SIGTERM delivery, the §10.2 SIGTERM→grace→SIGKILL
 *    cancel ladder, the identity-ambiguous WITHHOLD+alert, and the guard that
 *    a child still LIVE IN THIS PROCESS is left to the in-process stop path.
 *  - REAL CHILD (fake ACP child over the real transport + real `ps` + real
 *    `process.kill`): a second service over the SAME durable database
 *    PHYSICALLY terminates the running child.
 */
import { CLEAN_PINNED_WORKSPACE_GIT, createRunFixture } from './test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import {
  idempotencyKey,
  processGenerationId,
  segmentId,
  type ProcessGenerationId,
  type RunId,
  type SegmentId,
} from '../domain/ids.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import {
  AcpStdioAdapter,
  InProcessFakeAdapter,
  fakeAcpChildPath,
  writeScenarioFile,
  type ConfigOptionDescriptor,
} from '../adapters/index.js';
import {
  createPsClient,
  type EnvNonceVerifier,
  type ProcessIdentity,
  type ProcessIdentityRecord,
  type ProcessIdentitySample,
  type PsClient,
} from '../supervisor/index.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { OrchestrationService, captureAcpProcessIdentity, type RoleAdapterFactory } from './service.js';
import type { RoleRunner } from './role-runner.js';

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;

// ---------------------------------------------------------------------------
// Fake `ps` (identity table + liveness) — mirrors supervision.test.ts
// ---------------------------------------------------------------------------
interface FakePs {
  readonly client: PsClient;
  readonly identities: Map<number, ProcessIdentitySample>;
}

function makeFakePs(): FakePs {
  const fake: FakePs = {
    identities: new Map(),
    client: {
      sampleProcessTree(pgid: number) {
        if (!fake.identities.has(pgid)) return undefined;
        return { pgid, rssBytes: 0, processCount: 1, pids: [pgid], sampledAt: isoTimestamp('2026-07-19T00:00:00.000Z') };
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

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

function eventTypes(db: TestDatabaseHandle['db'], runId: RunId): string[] {
  return db.events.listByRun(runId).map((e) => e.type);
}

function runnerWith(body: (session: Parameters<RoleRunner['run']>[0]) => Promise<void>): RoleRunner {
  return {
    role: 'coordinator',
    run: async (session) => {
      await body(session);
      return {};
    },
  };
}

// ---------------------------------------------------------------------------
// DETERMINISTIC harness: the "second process" is a fresh service that never
// ran runRole for the seeded generation, so it is NOT in its `#liveSpawns`.
// ---------------------------------------------------------------------------
interface SeedSetup {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly ps: FakePs;
  readonly signals: Array<{ pgid: number; signal: NodeJS.Signals }>;
}

async function setupSeed(opts: {
  readonly envNonce?: EnvNonceVerifier;
  readonly sleep?: (ms: number) => Promise<void>;
} = {}): Promise<SeedSetup> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const db = handle.db;
  const ps = makeFakePs();
  const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
  const service = new OrchestrationService({
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
    db,
    ids: new DeterministicIdFactory(),
    // The second process drives no spawns of its own in these tests.
    adapterFactory: { create: () => { throw new Error('seed setup never spawns'); } },
    supervision: {
      ps: ps.client,
      sendSignal: (pgid, signal) => signals.push({ pgid, signal }),
      envNonce: opts.envNonce ?? { verifyNonce: () => 'match' },
      // Instant terminate grace by default (deterministic ladder timing).
      sleep: opts.sleep ?? (async () => undefined),
    },
  });
  return { service, db, ps, signals };
}

/**
 * Model what the FIRST process durably committed: a live active child for
 * `runId` plus its §14 identity record, mirrored into the fake `ps` table.
 */
function seedLiveChild(
  s: SeedSetup,
  runId: RunId,
  pid: number,
  generation: ProcessGenerationId,
  segment: SegmentId,
): void {
  const now = s.db.clock.nowIso();
  s.service.ingest(
    draftEvent({
      type: 'child.spawn.initiated',
      runId,
      payload: { generationId: generation, segmentId: segment, role: 'coordinator' },
      idempotencyKey: idempotencyKey(`si_${pid}`),
      occurredAt: now,
    }) as DomainEvent,
  );
  s.service.ingest(
    draftEvent({
      type: 'child.spawned',
      runId,
      payload: { generationId: generation, segmentId: segment, role: 'coordinator', pins: [] },
      idempotencyKey: idempotencyKey(`sp_${pid}`),
      occurredAt: now,
    }) as DomainEvent,
  );
  s.service.supervision.registry.store.put({
    ...identityFor(pid, generation),
    runId,
    segmentId: segment,
    recordedAt: now,
  } satisfies ProcessIdentityRecord);
  s.ps.identities.set(pid, sampleFor(pid));
}

describe('W3-2 second-process pause/cancel — identity-verified stop via the durable registry', () => {
  it('second-process pause appends the intent AND delivers an identity-verified SIGTERM to the child group', async () => {
    const s = await setupSeed();
    const { runId } = createRunFixture(s.service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_xp_pause');
    seedLiveChild(s, runId, 51_001, generation, segmentId('seg_xp_pause'));

    const paused = s.service.pause(runId);
    expect(paused.status).toBe('applied');
    expect(eventTypes(s.db, runId)).toContain('pause.user.requested');

    const outcome = await s.service.stopExternalChild(runId, { escalate: false });

    expect(outcome).toEqual({ delivered: true, signal: 'SIGTERM', escalated: false });
    // The identity-verified signal reached the child's process GROUP (§14 —
    // via the registry, a single graceful SIGTERM; pause never force-kills).
    expect(s.signals).toEqual([{ pgid: 51_001, signal: 'SIGTERM' }]);
  });

  it('second-process cancel escalates the §10.2 ladder — SIGTERM then SIGKILL — when the child outlives the terminate grace', async () => {
    const s = await setupSeed(); // instant grace; fake ps keeps the pid alive across it
    const { runId } = createRunFixture(s.service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_xp_cancel');
    seedLiveChild(s, runId, 52_001, generation, segmentId('seg_xp_cancel'));

    const cancelled = s.service.cancel(runId);
    expect(cancelled.status).toBe('applied');
    expect(eventTypes(s.db, runId)).toContain('cancel.requested');

    const outcome = await s.service.stopExternalChild(runId, { escalate: true });

    expect(outcome).toEqual({ delivered: true, signal: 'SIGKILL', escalated: true });
    expect(s.signals).toEqual([
      { pgid: 52_001, signal: 'SIGTERM' },
      { pgid: 52_001, signal: 'SIGKILL' },
    ]);
  });

  it('cancel stops at the graceful SIGTERM when the child dies within the terminate grace (no SIGKILL onto a dead/recycled pid)', async () => {
    const pid = 52_101;
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const db = handle.db;
    const ps = makeFakePs();
    const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    const service = new OrchestrationService({
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: { create: () => { throw new Error('never spawns'); } },
      supervision: {
        ps: ps.client,
        sendSignal: (p, signal) => signals.push({ pgid: p, signal }),
        envNonce: { verifyNonce: () => 'match' },
        // The child exits DURING the terminate grace: the pid stops resolving.
        sleep: async () => { ps.identities.delete(pid); },
      },
    });
    const s: SeedSetup = { service, db, ps, signals };
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    seedLiveChild(s, runId, pid, processGenerationId('pgen_xp_grace'), segmentId('seg_xp_grace'));

    expect(service.cancel(runId).status).toBe('applied');
    const outcome = await service.stopExternalChild(runId, { escalate: true });

    expect(outcome).toEqual({ delivered: true, signal: 'SIGTERM', escalated: false });
    expect(signals).toEqual([{ pgid: pid, signal: 'SIGTERM' }]); // no SIGKILL
  });

  it('identity-ambiguous (recycled pid) WITHHOLDS the signal and raises a durable §14 alert — never signals', async () => {
    const s = await setupSeed();
    const { runId } = createRunFixture(s.service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_xp_recycled');
    seedLiveChild(s, runId, 53_001, generation, segmentId('seg_xp_recycled'));
    // The pid now names a DIFFERENT process (recycled): start-time diverges.
    s.ps.identities.set(53_001, { ...sampleFor(53_001), startedAt: 'someone-else' });

    expect(s.service.pause(runId).status).toBe('applied');
    const outcome = await s.service.stopExternalChild(runId, { escalate: false });

    expect(outcome).toEqual({ delivered: false, reason: 'withheld', verdict: 'mismatch' });
    expect(s.signals).toEqual([]); // never signal a recycled pid

    const alerts = s.db.events
      .listByRun(runId)
      .filter((e) => e.type === 'process.identity.alert')
      .map((e) => e.payload as Record<string, unknown>);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      generationId: String(generation),
      attemptedAction: 'signal',
      attemptedSignal: 'SIGTERM',
      verdict: 'mismatch',
    });
  });

  it('identity-ambiguous (nonce contradiction) also WITHHOLDS + alerts even when the ps identity matches', async () => {
    const s = await setupSeed({ envNonce: { verifyNonce: () => 'mismatch' } });
    const { runId } = createRunFixture(s.service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_xp_nonce');
    seedLiveChild(s, runId, 54_001, generation, segmentId('seg_xp_nonce'));

    expect(s.service.cancel(runId).status).toBe('applied');
    const outcome = await s.service.stopExternalChild(runId, { escalate: true });

    expect(outcome).toEqual({ delivered: false, reason: 'withheld', verdict: 'nonce_mismatch' });
    expect(s.signals).toEqual([]);
    const verdicts = s.db.events
      .listByRun(runId)
      .filter((e) => e.type === 'process.identity.alert')
      .map((e) => (e.payload as { verdict: string }).verdict);
    expect(verdicts).toEqual(['nonce_mismatch']);
  });

  it('a child still LIVE IN THIS PROCESS is left to the in-process stop path — never cross-signaled', async () => {
    // The IN-process path: runRole owns a live spawn; stopExternalChild must
    // recognize the generation in `#liveSpawns` and decline to signal.
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const db = handle.db;
    const ps = makeFakePs();
    const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    let nextPid = 55_001;
    const factory: RoleAdapterFactory = {
      create() {
        const adapter = new InProcessFakeAdapter({
          harnessId: 'claude',
          capabilities: { configOptions: fakeConfigOptions() },
        });
        const pid = nextPid;
        nextPid += 1;
        ps.identities.set(pid, sampleFor(pid));
        return {
          adapter,
          captureProcessIdentity: (generationId: ProcessGenerationId) => identityFor(pid, generationId),
          dispose: async (): Promise<void> => {
            await adapter.close();
            // The fake transport returning is not exit evidence; fake ps
            // separately removes the group so the live barrier can observe
            // whole-PGID absence.
            ps.identities.delete(pid);
          },
        };
      },
    };
    const service = new OrchestrationService({
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: factory,
      supervision: {
        ps: ps.client,
        sendSignal: (pgid, signal) => signals.push({ pgid, signal }),
        envNonce: { verifyNonce: () => 'match' },
        sleep: async () => undefined,
      },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    let inProcessOutcome: unknown;
    await service.runCoordination(
      runId,
      runnerWith(async () => {
        // The generation is live in THIS process right now.
        inProcessOutcome = await service.stopExternalChild(runId, { escalate: true });
      }),
    );

    expect(inProcessOutcome).toEqual({ delivered: false, reason: 'in_process' });
    expect(signals).toEqual([]); // the in-process dispose ladder owns this stop
  });

  it('no active child / no durable record → honest non-delivery, no signal', async () => {
    const s = await setupSeed();
    const { runId } = createRunFixture(s.service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    // No spawn seeded at all.
    expect(await s.service.stopExternalChild(runId, { escalate: true })).toEqual({
      delivered: false,
      reason: 'no_active_child',
    });
    // Active child in durable state, but the §14 record is gone (clean dispose
    // by the owner already removed it): nothing to reach it by.
    seedLiveChild(s, runId, 56_001, processGenerationId('pgen_xp_norecord'), segmentId('seg_xp_norecord'));
    s.service.supervision.registry.store.remove(processGenerationId('pgen_xp_norecord'));
    expect(await s.service.stopExternalChild(runId, { escalate: false })).toEqual({
      delivered: false,
      reason: 'no_record',
    });
    expect(s.signals).toEqual([]);
  });
});

function fakeConfigOptions(): ConfigOptionDescriptor[] {
  return [
    { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
    { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

// ---------------------------------------------------------------------------
// REAL CHILD: a second service over the SAME durable database physically
// terminates a running fake ACP child through the real signal path.
// ---------------------------------------------------------------------------
describe('W3-2 real fake ACP child — a second service physically terminates the running child', () => {
  const clock = new ManualClock('2026-07-19T09:00:00.000Z');
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  async function waitUntilDead(ps: PsClient, pid: number, timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!ps.isAlive(pid)) return true;
      await sleepReal(25);
    }
    return false;
  }

  /**
   * Bring a REAL fake ACP child up (process A's child), register its §14
   * identity + commit the durable spawn events, and hand back a second
   * service (process B) wired to the SAME database with real `ps` + real
   * `process.kill`. The env-nonce verifier is stubbed to `match` so the test
   * is platform-independent (the real best-effort nonce reader is covered in
   * supervision.test.ts); everything else — identity, signal, kill — is real.
   */
  async function bringUpChild(runId: RunId, generation: ProcessGenerationId): Promise<{
    readonly serviceB: OrchestrationService;
    readonly ps: PsClient;
    readonly pid: number;
  }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'w3-2-realchild-'));
    const scenarioPath = await writeScenarioFile({}, dir);
    const adapter = new AcpStdioAdapter({
      harnessId: 'fake-acp-child',
      spawn: { command: process.execPath, args: [fakeAcpChildPath(), scenarioPath] },
      spawnId: `w3-2-real-${String(generation)}`,
      clock,
    });
    cleanups.push(async () => {
      await adapter.close();
      await rm(dir, { recursive: true, force: true });
    });
    await adapter.initialize();
    const ps = createPsClient(clock);
    const pid = adapter.transportPid!;
    const identity = captureAcpProcessIdentity(adapter, generation, ps);
    expect(identity).toBeDefined();
    expect(ps.isAlive(pid)).toBe(true);

    const db = handle!.db;
    const segment = segmentId(`seg_real_${String(generation)}`);
    // Process B: a fresh service over the SAME durable database — it never ran
    // runRole for this generation, so it is genuinely cross-process.
    const serviceB = new OrchestrationService({
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: { create: () => { throw new Error('service B never spawns'); } },
      // Short terminate grace: the child dies on SIGTERM (no custom handler),
      // so a brief grace keeps the ladder fast whether it settles at SIGTERM
      // or escalates to a (harmless, already-dead) SIGKILL.
      supervision: { ps, envNonce: { verifyNonce: () => 'match' }, terminateGraceMs: 300 },
    });
    const now = db.clock.nowIso();
    serviceB.ingest(
      draftEvent({
        type: 'child.spawn.initiated',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'coordinator' },
        idempotencyKey: idempotencyKey(`real_si_${String(generation)}`),
        occurredAt: now,
      }) as DomainEvent,
    );
    serviceB.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'coordinator', pins: [] },
        idempotencyKey: idempotencyKey(`real_sp_${String(generation)}`),
        occurredAt: now,
      }) as DomainEvent,
    );
    serviceB.supervision.registry.store.put({ ...identity!, runId, segmentId: segment, recordedAt: now });
    return { serviceB, ps, pid };
  }

  it('second-process PAUSE terminates the real child (its transport observes the death)', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const creator = new OrchestrationService({
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      db: handle.db,
      ids: new DeterministicIdFactory(),
      adapterFactory: { create: () => { throw new Error('creator never spawns'); } },
    });
    const { runId } = createRunFixture(creator, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_real_pause');
    const { serviceB, ps, pid } = await bringUpChild(runId, generation);

    expect(serviceB.pause(runId).status).toBe('applied');
    const outcome = await serviceB.stopExternalChild(runId, { escalate: false });

    expect(outcome).toMatchObject({ delivered: true, signal: 'SIGTERM' });
    expect(await waitUntilDead(ps, pid)).toBe(true); // the real child is gone
  }, 20_000);

  it('second-process CANCEL terminates the real child', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const creator = new OrchestrationService({
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      db: handle.db,
      ids: new DeterministicIdFactory(),
      adapterFactory: { create: () => { throw new Error('creator never spawns'); } },
    });
    const { runId } = createRunFixture(creator, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generation = processGenerationId('pgen_real_cancel');
    const { serviceB, ps, pid } = await bringUpChild(runId, generation);

    expect(serviceB.cancel(runId).status).toBe('applied');
    const outcome = await serviceB.stopExternalChild(runId, { escalate: true });

    expect(outcome).toMatchObject({ delivered: true });
    expect(await waitUntilDead(ps, pid)).toBe(true);
  }, 20_000);
});
