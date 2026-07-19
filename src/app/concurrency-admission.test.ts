/**
 * W3-5 CONCURRENCY ENFORCEMENT (spec docs/specs/hardening-p4a.md §W3-5; PLAN
 * §14 "Concurrency: simple max-live-children guard") — the `MaxLiveChildrenGuard`
 * wired into `runRole`'s spawn path, enforced BOTH in-process AND durably
 * across concurrent CLI processes (the shared registry store).
 *
 *  1. IN-PROCESS: with `maxLiveChildren: 2`, a third concurrent spawn is
 *     refused with `MaxLiveChildrenExceededError` while two children are live,
 *     and admitted again once one frees its slot.
 *  2. CROSS-PROCESS: with `maxLiveChildren: 1`, a SECOND service over the SAME
 *     durable database cannot spawn while the FIRST service's child is live —
 *     the durable registry record counts against the global cap.
 *
 * Deterministic: in-process fake adapters + injected fake `ps` (identity table
 * + liveness), mirroring supervision.test.ts.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isoTimestamp } from '../lib/clock.js';
import { DeterministicIdFactory, RandomIdFactory } from '../lib/id-factory.js';
import { processGenerationId, type ProcessGenerationId, type RunId } from '../domain/ids.js';
import {
  InProcessFakeAdapter,
  type ConfigOptionDescriptor,
} from '../adapters/index.js';
import {
  MaxLiveChildrenExceededError,
  type ProcessIdentity,
  type ProcessIdentitySample,
  type PsClient,
} from '../supervisor/index.js';
import {
  availableDriverKinds,
  openTestDatabase,
  type TestDatabaseHandle,
} from '../persistence/test-support.js';
import { parseEngineConfig } from '../config/loader.js';
import { unwrap } from '../lib/result.js';
import { OrchestrationService, type RoleAdapterFactory } from './service.js';
import { DurableSpawnReservationStore } from './spawn-reservation-store.js';
import type { Harness, RoleModelSpec } from './model-resolution.js';
import type { RoleRunner } from './role-runner.js';

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const CODEX_LOW: RoleModelSpec = { harness: 'codex', model: 'gpt-5.6-sol', effort: 'low' };

/** W3-5(a) runs the atomic-admission regression on EVERY available driver. */
const DRIVER_KINDS = await availableDriverKinds();

function fakeConfigOptions(harness: Harness = 'claude'): ConfigOptionDescriptor[] {
  if (harness === 'codex') {
    return [
      { id: 'model', kind: 'model', values: ['gpt-5.6-terra', 'gpt-5.6-sol'], current: 'gpt-5.6-sol' },
      { id: 'model_reasoning_effort', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
    ];
  }
  return [
    { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
    { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

interface FakePs {
  readonly client: PsClient;
  readonly identities: Map<number, ProcessIdentitySample>;
}

function makeFakePs(): FakePs {
  const fake: FakePs = {
    identities: new Map(),
    client: {
      sampleProcessTree(pgid: number) {
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
  return { generationId, pid, pgid: sample.pgid, startedAt: sample.startedAt, executablePath: sample.executablePath, spawnNonce: `nonce-${pid}` };
}

/** A factory whose handles expose §14 identities into a shared fake ps table. */
function makeFactory(ps: FakePs, firstPid: number): RoleAdapterFactory {
  let nextPid = firstPid;
  return {
    create() {
      const adapter = new InProcessFakeAdapter({ harnessId: 'claude', capabilities: { configOptions: fakeConfigOptions() } });
      const pid = nextPid;
      nextPid += 1;
      ps.identities.set(pid, sampleFor(pid));
      return {
        adapter,
        captureProcessIdentity: (generationId: ProcessGenerationId) => identityFor(pid, generationId),
        dispose: (): Promise<void> => adapter.close(),
      };
    },
  };
}

function runnerWith(body: () => Promise<void>): RoleRunner {
  return { role: 'coordinator', run: async () => { await body(); return {}; } };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(5);
  }
  throw new Error('waitFor: condition never became true');
}

let handle: TestDatabaseHandle | undefined;
afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

describe('W3-5 in-process max-live-children guard wired into runRole', () => {
  it('refuses the N+1th concurrent spawn with MaxLiveChildrenExceededError, then admits again once a slot frees', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const db = handle.db;
    const ps = makeFakePs();
    const service = new OrchestrationService({
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: makeFactory(ps, 61_001),
      config: unwrap(parseEngineConfig({ maxLiveChildren: 2 })),
      supervision: { ps: ps.client, sendSignal: () => undefined, envNonce: { verifyNonce: () => 'match' } },
    });

    const live = new Set<string>();
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const blocking = (tag: string): RoleRunner =>
      runnerWith(async () => {
        live.add(tag);
        await barrier;
      });

    const run1 = service.createRun({ goal: 'g1', workspacePath: '/ws', coordinator: CLAUDE_LOW }).runId;
    const run2 = service.createRun({ goal: 'g2', workspacePath: '/ws', coordinator: CLAUDE_LOW }).runId;
    const run3 = service.createRun({ goal: 'g3', workspacePath: '/ws', coordinator: CLAUDE_LOW }).runId;

    const p1 = service.runCoordination(run1, blocking('1'));
    const p2 = service.runCoordination(run2, blocking('2'));
    await waitFor(() => live.size === 2); // both slots held, both children live

    // The 3rd spawn is refused — the cap is 2.
    let refusal: unknown;
    await service.runCoordination(run3, runnerWith(async () => { live.add('3'); })).catch((e: unknown) => {
      refusal = e;
    });
    expect(refusal).toBeInstanceOf(MaxLiveChildrenExceededError);
    expect((refusal as MaxLiveChildrenExceededError).max).toBe(2);
    expect(live.has('3')).toBe(false); // never ran its flow

    // Free the two slots; run1/run2 complete.
    releaseBarrier();
    await Promise.all([p1, p2]);

    // A slot is free now — a fresh spawn is admitted (runs to completion).
    let ran4 = false;
    await service.runCoordination(run3, runnerWith(async () => { ran4 = true; }));
    expect(ran4).toBe(true);
  });
});

describe('W3-5 durable cross-process max-live-children cap', () => {
  it('a SECOND service on the SAME durable database cannot exceed the cap while the FIRST service holds a live child', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const db = handle.db;
    // One shared fake ps table = both "processes" observe the same live OS pids.
    const ps = makeFakePs();
    const config = unwrap(parseEngineConfig({ maxLiveChildren: 1 }));

    const serviceA = new OrchestrationService({
      db,
      ids: new RandomIdFactory(),
      adapterFactory: makeFactory(ps, 62_001),
      config,
      supervision: { ps: ps.client, sendSignal: () => undefined, envNonce: { verifyNonce: () => 'match' } },
    });
    const serviceB = new OrchestrationService({
      db,
      ids: new RandomIdFactory(),
      adapterFactory: makeFactory(ps, 63_001),
      config,
      supervision: { ps: ps.client, sendSignal: () => undefined, envNonce: { verifyNonce: () => 'match' } },
    });

    let started = false;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const runA = serviceA.createRun({ goal: 'gA', workspacePath: '/ws', coordinator: CLAUDE_LOW }).runId;
    const runB = serviceB.createRun({ goal: 'gB', workspacePath: '/ws', coordinator: CLAUDE_LOW }).runId;

    // A's child goes live and stays live (its identity is durably registered).
    const pA = serviceA.runCoordination(runA, runnerWith(async () => {
      started = true;
      await barrier;
    }));
    await waitFor(() => started);
    // The durable registry (shared DB) now holds A's live child.
    expect(serviceB.supervision.registry.store.list()).toHaveLength(1);

    // B, a distinct process on the SAME DB, is refused — the cap is global.
    let refusal: unknown;
    await serviceB.runCoordination(runB, runnerWith(async () => undefined)).catch((e: unknown) => {
      refusal = e;
    });
    expect(refusal).toBeInstanceOf(MaxLiveChildrenExceededError);

    // A finishes → its durable record clears → B is admitted.
    releaseBarrier();
    await pA;
    expect(serviceB.supervision.registry.store.list()).toHaveLength(0);
    let ranB = false;
    await serviceB.runCoordination(runB, runnerWith(async () => { ranB = true; }));
    expect(ranB).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// W3-5(a): atomic count-and-reserve — the TOCTOU a verifier proved.
// ---------------------------------------------------------------------------
describe('W3-5(a) atomic cross-process admission (count-and-reserve)', () => {
  it.each(DRIVER_KINDS)(
    'two admissions started concurrently with cap=1 → exactly one succeeds, the other throws [%s]',
    async (kind) => {
      handle = await openTestDatabase({ kind, file: false });
      const db = handle.db;
      // One shared fake ps table; the two services model two distinct OS
      // processes (distinct owner pids, both registered ALIVE) over one DB.
      const ps = makeFakePs();
      ps.identities.set(70_001, sampleFor(70_001));
      ps.identities.set(70_002, sampleFor(70_002));
      const config = unwrap(parseEngineConfig({ maxLiveChildren: 1 }));

      const makeService = (selfPid: number, firstChildPid: number): OrchestrationService =>
        new OrchestrationService({
          db,
          ids: new RandomIdFactory(),
          adapterFactory: makeFactory(ps, firstChildPid),
          config,
          supervision: {
            ps: ps.client,
            selfPid,
            sendSignal: () => undefined,
            envNonce: { verifyNonce: () => 'match' },
          },
        });
      const serviceA = makeService(70_001, 71_001);
      const serviceB = makeService(70_002, 72_001);

      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const blocking = runnerWith(async () => {
        await barrier;
      });

      const runA = serviceA.createRun({ goal: 'gA', workspacePath: '/ws', coordinator: CLAUDE_LOW }).runId;
      const runB = serviceB.createRun({ goal: 'gB', workspacePath: '/ws', coordinator: CLAUDE_LOW }).runId;

      // Fire BOTH without awaiting between them (concurrent admission). Each
      // runRole runs synchronously through #admitSpawn before its first await,
      // so the durable reservation of whichever admits first is committed and
      // visible to the other — the atom the fix guarantees.
      const outcomes: { ok: boolean; err?: unknown }[] = [];
      const track = (p: Promise<unknown>): Promise<void> =>
        p.then(
          () => void outcomes.push({ ok: true }),
          (err: unknown) => void outcomes.push({ ok: false, err }),
        );
      const tA = track(serviceA.runCoordination(runA, blocking));
      const tB = track(serviceB.runCoordination(runB, blocking));

      // The loser is refused at admission (synchronously) and settles fast.
      await waitFor(() => outcomes.some((o) => !o.ok));
      releaseBarrier();
      await Promise.all([tA, tB]);

      expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
      const refused = outcomes.filter((o) => !o.ok);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.err).toBeInstanceOf(MaxLiveChildrenExceededError);
      expect((refused[0]!.err as MaxLiveChildrenExceededError).max).toBe(1);
    },
  );

  it.each(DRIVER_KINDS)(
    'three admissions started concurrently with cap=2 → EXACTLY two succeed, the third throws [%s]',
    async (kind) => {
      handle = await openTestDatabase({ kind, file: false });
      const db = handle.db;
      // One shared fake ps table; three services model three distinct OS
      // processes (distinct owner pids, all registered ALIVE) over one DB.
      const ps = makeFakePs();
      ps.identities.set(80_001, sampleFor(80_001));
      ps.identities.set(80_002, sampleFor(80_002));
      ps.identities.set(80_003, sampleFor(80_003));
      const config = unwrap(parseEngineConfig({ maxLiveChildren: 2 }));

      const makeService = (selfPid: number, firstChildPid: number): OrchestrationService =>
        new OrchestrationService({
          db,
          ids: new RandomIdFactory(),
          adapterFactory: makeFactory(ps, firstChildPid),
          config,
          supervision: {
            ps: ps.client,
            selfPid,
            sendSignal: () => undefined,
            envNonce: { verifyNonce: () => 'match' },
          },
        });
      const services = [
        makeService(80_001, 81_001),
        makeService(80_002, 82_001),
        makeService(80_003, 83_001),
      ];

      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      const blocking = runnerWith(async () => {
        await barrier;
      });

      const runs = services.map(
        (svc, i) => svc.createRun({ goal: `g${i}`, workspacePath: '/ws', coordinator: CLAUDE_LOW }).runId,
      );

      // Fire ALL THREE without awaiting between them (concurrent admission).
      const outcomes: { ok: boolean; err?: unknown }[] = [];
      const track = (p: Promise<unknown>): Promise<void> =>
        p.then(
          () => void outcomes.push({ ok: true }),
          (err: unknown) => void outcomes.push({ ok: false, err }),
        );
      const tracked = services.map((svc, i) => track(svc.runCoordination(runs[i]!, blocking)));

      // The loser is refused at admission (synchronously) and settles fast.
      await waitFor(() => outcomes.some((o) => !o.ok));
      releaseBarrier();
      await Promise.all(tracked);

      // EXACTLY two admitted; EXACTLY one refused with the cap in the error.
      expect(outcomes.filter((o) => o.ok)).toHaveLength(2);
      const refused = outcomes.filter((o) => !o.ok);
      expect(refused).toHaveLength(1);
      expect(refused[0]!.err).toBeInstanceOf(MaxLiveChildrenExceededError);
      expect((refused[0]!.err as MaxLiveChildrenExceededError).max).toBe(2);
    },
  );

  it.each(DRIVER_KINDS)(
    'an orphaned reservation from a DEAD owner pid is reclaimed, never a deadlock [%s]',
    async (kind) => {
      handle = await openTestDatabase({ kind, file: false });
      const db = handle.db;
      const ps = makeFakePs();
      const config = unwrap(parseEngineConfig({ maxLiveChildren: 1 }));

      // Seed a durable reservation owned by a pid that ps does NOT know (a
      // crashed process). It must not permanently consume the only slot.
      new DurableSpawnReservationStore(db).reserveWithin({
        generationId: 'gen-from-crashed-peer',
        ownerPid: 999_999, // never registered alive in the fake ps
        ownerStartedAt: 'lstart-999999',
        reservedAt: isoTimestamp('2026-07-19T00:00:00.000Z'),
      });

      const service = new OrchestrationService({
        db,
        ids: new RandomIdFactory(),
        adapterFactory: makeFactory(ps, 73_001),
        config,
        supervision: {
          ps: ps.client,
          selfPid: 73_000,
          sendSignal: () => undefined,
          envNonce: { verifyNonce: () => 'match' },
        },
      });
      ps.identities.set(73_000, sampleFor(73_000));

      const run = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW }).runId;
      let ran = false;
      // The dead-owner reservation is reclaimed, so this admission succeeds.
      await service.runCoordination(run, runnerWith(async () => { ran = true; }));
      expect(ran).toBe(true);

      // The reclaimed reservation was pruned from the durable store.
      const remaining = new DurableSpawnReservationStore(db)
        .list()
        .map((r) => r.generationId);
      expect(remaining).not.toContain('gen-from-crashed-peer');
    },
  );
});

// ---------------------------------------------------------------------------
// W4-8: admission is refused BEFORE any provider resource or durable round is
// created. The regression the fix guarantees: `#admitSpawn` runs ahead of both
// the pending-round save AND `#adapterFactory.create` (which, for the real
// Codex path, prepares an isolated §17.1 H-1 `CODEX_HOME` at creation time).
// A cap rejection therefore leaks NEITHER a temp home NOR a durable pending
// round. Modelled with a factory whose `create()` allocates a real temp dir at
// creation time (a faithful stand-in for the Codex `CODEX_HOME`) and removes it
// on `dispose()`. Under the OLD ordering the refused Codex spawn would have had
// its home created (and never disposed) and a pending round persisted.
// ---------------------------------------------------------------------------
describe('W4-8 admission refusal creates no provider resource and no durable round', () => {
  it('a cap-exceeded rejection for a Codex role disposes no temp CODEX_HOME and leaves no pending round', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const db = handle.db;
    const ps = makeFakePs();

    // Each spawn allocates a real temp dir at adapter-CREATION time (the H-1
    // `CODEX_HOME` model), disposed on `handle.dispose()`. A leak — a refused
    // spawn's dir created but never disposed — is observable on disk.
    const tmpRoot = mkdtempSync(join(tmpdir(), 'w4-8-'));
    const createdHomes: { dir: string; disposed: boolean }[] = [];
    let nextPid = 64_001;
    const factory: RoleAdapterFactory = {
      create(options) {
        const adapter = new InProcessFakeAdapter({
          harnessId: options.resolved.harness,
          capabilities: { configOptions: fakeConfigOptions(options.resolved.harness) },
        });
        const pid = nextPid;
        nextPid += 1;
        ps.identities.set(pid, sampleFor(pid));
        const dir = mkdtempSync(join(tmpRoot, 'codex-home-'));
        const entry = { dir, disposed: false };
        createdHomes.push(entry);
        return {
          adapter,
          captureProcessIdentity: (generationId: ProcessGenerationId) => identityFor(pid, generationId),
          dispose: async (): Promise<void> => {
            await adapter.close();
            rmSync(dir, { recursive: true, force: true });
            entry.disposed = true;
          },
        };
      },
    };

    const service = new OrchestrationService({
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: factory,
      config: unwrap(parseEngineConfig({ maxLiveChildren: 1 })),
      supervision: { ps: ps.client, sendSignal: () => undefined, envNonce: { verifyNonce: () => 'match' } },
    });

    try {
      let releaseBarrier!: () => void;
      const barrier = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      let live = false;

      const run1 = service.createRun({ goal: 'g1', workspacePath: '/ws', coordinator: CODEX_LOW }).runId;
      const run2 = service.createRun({ goal: 'g2', workspacePath: '/ws', coordinator: CODEX_LOW }).runId;

      // One Codex child goes live and holds the only slot (cap=1).
      const p1 = service.runCoordination(
        run1,
        runnerWith(async () => {
          live = true;
          await barrier;
        }),
      );
      await waitFor(() => live);

      // The 2nd Codex spawn is refused — the cap is 1.
      let refusal: unknown;
      await service
        .runCoordination(run2, runnerWith(async () => undefined))
        .catch((e: unknown) => {
          refusal = e;
        });
      expect(refusal).toBeInstanceOf(MaxLiveChildrenExceededError);

      // No durable pending round leaked for the refused run (nothing was
      // persisted before admission).
      expect(service.getRoleRound(run2)).toBeUndefined();

      // No temp CODEX_HOME leaked: the refused spawn never reached
      // `#adapterFactory.create`, so ONLY the one live child's home exists on
      // disk (under the old ordering a second, undisposed home would remain).
      const onDisk = createdHomes.filter((h) => existsSync(h.dir));
      expect(onDisk).toHaveLength(1);
      expect(onDisk[0]!.disposed).toBe(false);
      expect(createdHomes).toHaveLength(1); // create() was never called for the refusal

      // Free the slot; the live child completes and its home is disposed.
      releaseBarrier();
      await p1;
      expect(createdHomes.every((h) => !existsSync(h.dir))).toBe(true);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
