/**
 * P4b-2 same-harness bounded AUTO-RESPAWN (§5cc / §5dd) — the control-flow layer
 * on the successor spine. A child crash whose GENERATION-MATCHED T13 is
 * `restart`-advised and whose run is under `autoRespawn=bounded` no longer
 * unwinds to a manual interrupt: the lease-holding `runImplementVerifyLoop`
 * catches an `AutoRespawnSignal`, waits the breaker's backoff, and re-drives the
 * successor spine in-process. The breaker bounds it — an exhausting crash opens
 * the breaker (T14) and unwinds.
 *
 * Real-path coverage (both sqlite drivers — crash-safety is driver-sensitive):
 *  1. a crash-LOOP auto-respawns up to the breaker bound, then `breaker_open` +
 *     one `breaker_open` alert (and one `respawn` alert per healthy attempt);
 *  2. `autoRespawn=off` reproduces P4a EXACTLY (crash → interrupted → manual);
 *  3. a HEALTHY auto-respawn (crash once, then succeed) raises a `respawn` alert
 *     and completes the run;
 *  4. an orchestrator crash (T17) does NOT auto-respawn and is breaker-exempt;
 *  5. a STALE-generation crash does NOT respawn (gate on the applied,
 *     generation-matched T13 — NOT `evaluateCrash`'s generation-blind advice, S4).
 */
import { CLEAN_PINNED_WORKSPACE_GIT, createRunFixture } from './test-support.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assignmentId as toAssignmentId,
  criterionId,
  gitSha,
  idempotencyKey,
  processGenerationId,
  segmentId,
  specHash as toSpecHash,
  specVersionId,
  type RunId,
} from '../domain/ids.js';
import type { AcceptanceCriterion } from '../domain/entities.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import { DeterministicIdFactory, RandomIdFactory } from '../lib/id-factory.js';
import { unwrap } from '../lib/result.js';
import { parseEngineConfig } from '../config/loader.js';
import type { EngineConfig } from '../config/schema.js';
import {
  InProcessFakeAdapter,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
} from '../adapters/index.js';
import {
  openTestDatabase,
  availableDriverKinds,
  type TestDatabaseHandle,
} from '../persistence/test-support.js';
import { GitWorktreeManager } from '../worktree/index.js';
import { makeTempGitRepo, type TempGitRepo } from '../worktree/test-support.js';
import type { ProcessIdentitySample, PsClient } from '../supervisor/index.js';
import {
  AutoRespawnSignal,
  OrchestrationService,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from './service.js';
import type { RoleRunner } from './role-runner.js';
import { runImplementVerifyLoop } from './flows/orchestrate.js';
import type { VerificationRunner } from './flows/implementor.js';
import type { EvidenceRecorder } from './flows/verifier.js';
import type { Harness, RoleModelSpec } from './model-resolution.js';

const DRIVER_KINDS = await availableDriverKinds();

const CLAUDE_LOW: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const IMPLEMENTOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const SPEC_HASH = toSpecHash('spec_hash_ar');
const AC1 = criterionId('AC-1');
const CRITERIA: readonly AcceptanceCriterion[] = [
  { id: AC1, description: 'flag exists', verificationCommands: ['echo check-ac1'], expectedEvidence: 'exit 0' },
];
const NOOP_DELAY = async (): Promise<void> => undefined;

function cfg(restarts: Record<string, unknown>): EngineConfig {
  // These crash/restart fixtures intentionally exercise a single Claude vendor.
  return unwrap(
    parseEngineConfig({
      restarts,
      verification: { allowSameHarness: true },
    }),
  );
}

function configOptionsFor(harness: Harness): ConfigOptionDescriptor[] {
  if (harness === 'claude') {
    return [
      { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
      { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
    ];
  }
  return [
    { id: 'model', kind: 'model', values: ['gpt-5.6-terra', 'gpt-5.6-sol'], current: 'gpt-5.6-sol' },
    { id: 'model_reasoning_effort', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

const DIE: InProcessTurnScript = { dieMidTurn: true };
const IMPL_DONE: InProcessTurnScript = {
  updates: [{ kind: 'agent_message_chunk', text: 'done' }],
  result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, source: 'adapter' } },
};
const VERIFY_PASS: InProcessTurnScript = {
  updates: [
    {
      kind: 'agent_message_chunk',
      text: JSON.stringify({ criteria: [{ id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' }] }),
    },
  ],
  result: { stopReason: 'end_turn' },
};
const PASS_VERIFY: VerificationRunner = async (command) => ({
  exitCode: 0,
  stdout: `ran ${command}`,
  stderr: '',
  launchFailed: false,
});

interface AdapterScript {
  readonly writes?: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly turns: readonly InProcessTurnScript[];
}

/** A per-role factory whose Nth creation takes the Nth script — the LAST script
 * REPEATS, so a crash-loop (one dying script) dies forever and a "die then
 * succeed" pair recovers on every respawn. */
function makeRepeatingFactory(scripts: {
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
  readonly coordinator?: readonly AdapterScript[];
}): RoleAdapterFactory {
  const cursors: Record<string, number> = {};
  return {
    create(options: RoleAdapterOptions) {
      const role = options.role;
      const queue = scripts[role as keyof typeof scripts] ?? [];
      const idx = cursors[role] ?? 0;
      cursors[role] = idx + 1;
      const script: AdapterScript = queue[Math.min(idx, queue.length - 1)] ?? { turns: [] };
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        clock: options.clock,
        capabilities: { configOptions: configOptionsFor(options.resolved.harness) },
        turns: script.turns,
      });
      const orig = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (
        input,
      ) => {
        for (const write of script.writes ?? []) {
          const target = path.join(options.cwd, write.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, write.content, 'utf8');
        }
        return orig(input);
      };
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
}

function fakeEvidence(): EvidenceRecorder {
  let n = 0;
  return {
    async record() {
      n += 1;
      return `ev_${n}` as never;
    },
  };
}

function promptOnceRunner(): RoleRunner {
  return {
    role: 'coordinator',
    run: async (session) => {
      await session.prompt({ prompt: 'go' });
      return {};
    },
  };
}

function eventTypes(db: TestDatabaseHandle['db'], id: RunId): string[] {
  return db.events.listByRun(id).map((e) => e.type);
}
function countType(db: TestDatabaseHandle['db'], id: RunId, type: string): number {
  return eventTypes(db, id).filter((t) => t === type).length;
}
function alertKinds(db: TestDatabaseHandle['db'], id: RunId): string[] {
  return db.events
    .listByRun(id)
    .filter((e) => e.type === 'alert.raised')
    .map((e) => (e.payload as { kind: string }).kind);
}

// ---------------------------------------------------------------------------
// Loop rig — a real temp git repo + in-process fakes (no real spawns).
// ---------------------------------------------------------------------------
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface LoopRig {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly worktrees: GitWorktreeManager;
  readonly runId: RunId;
  readonly assignmentId: ReturnType<typeof toAssignmentId>;
  readonly baseCommit: ReturnType<typeof gitSha>;
}

async function openLoopRig(
  kind: (typeof DRIVER_KINDS)[number],
  opts: {
    readonly config: EngineConfig;
    readonly implementor?: readonly AdapterScript[];
    readonly verifier?: readonly AdapterScript[];
  },
): Promise<LoopRig> {
  const repo: TempGitRepo = await makeTempGitRepo('harness-auto-respawn-');
  cleanups.push(() => repo.cleanup());
  const handle = await openTestDatabase({ kind, file: true });
  cleanups.push(() => {
    handle.close();
    handle.cleanup();
  });
  const worktrees = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: handle.db.clock });
  cleanups.push(() => {
    try {
      fs.rmSync(worktrees.baseDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  const factory = makeRepeatingFactory({
    ...(opts.implementor !== undefined ? { implementor: opts.implementor } : {}),
    ...(opts.verifier !== undefined ? { verifier: opts.verifier } : {}),
  });
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    config: opts.config,
  });
  const baseCommit = gitSha(await repo.headSha());
  const { runId } = createRunFixture(service, {
    goal: 'g',
    workspacePath: repo.dir,
    coordinator: CLAUDE_LOW,
    baseCommit,
  });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  expect((await service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: SPEC_HASH })).status).toBe(
    'applied',
  );
  return {
    service,
    db: handle.db,
    worktrees,
    runId,
    assignmentId: toAssignmentId(`asg_${runId}`),
    baseCommit,
  };
}

function loopInput(rig: LoopRig) {
  return {
    runId: rig.runId,
    assignmentId: rig.assignmentId,
    implementor: IMPLEMENTOR,
    verifier: VERIFIER,
    specHash: SPEC_HASH,
    // B2 (codex F5): required signer — these fixtures model human-approved runs.
    specApprovedBy: 'human' as const,
    specDocument: '{"goal":"g"}',
    goal: 'g',
    taskScope: 'Implement the approved specification end to end.',
    criteria: CRITERIA,
    evidence: fakeEvidence(),
    runVerificationCommands: PASS_VERIFY,
    baseCommit: rig.baseCommit,
  };
}

function loopDeps(rig: LoopRig) {
  return {
    service: rig.service,
    worktrees: rig.worktrees,
    ids: new RandomIdFactory(),
    clock: rig.db.clock,
    delay: NOOP_DELAY,
  };
}

// ---------------------------------------------------------------------------
// Service rig (no git) — for the direct-runRole / recover paths.
// ---------------------------------------------------------------------------
async function serviceRig(
  kind: (typeof DRIVER_KINDS)[number],
  opts: {
    readonly config?: EngineConfig;
    readonly factory?: RoleAdapterFactory;
    readonly supervision?: {
      readonly ps?: PsClient;
      readonly selfPid?: number;
      readonly envNonce?: { verifyNonce: () => 'match' };
      readonly sendSignal?: () => void;
    };
  } = {},
): Promise<{ service: OrchestrationService; db: TestDatabaseHandle['db'] }> {
  const handle = await openTestDatabase({ kind, file: false });
  cleanups.push(() => {
    handle.close();
    handle.cleanup();
  });
  const service = new OrchestrationService({
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: opts.factory ?? makeRepeatingFactory({ coordinator: [{ turns: [DIE] }] }),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.supervision !== undefined ? { supervision: opts.supervision } : {}),
  });
  return { service, db: handle.db };
}

interface FakePs {
  readonly client: PsClient;
  readonly identities: Map<number, ProcessIdentitySample>;
}
function makeFakePs(): FakePs {
  const identities = new Map<number, ProcessIdentitySample>();
  return {
    identities,
    client: {
      sampleProcessTree: () => undefined,
      sampleIdentity: (pid: number) => identities.get(pid),
      isAlive: (pid: number) => identities.has(pid),
    },
  };
}
function sampleFor(pid: number): ProcessIdentitySample {
  return { pid, ppid: 1, pgid: pid, startedAt: `lstart-${pid}`, executablePath: '/fake/agent' };
}

describe.each(DRIVER_KINDS)('P4b-2 auto-respawn (%s)', (kind) => {
  // -------------------------------------------------------------------------
  // 1. Crash-LOOP → bounded auto-respawn up to the breaker, then breaker_open.
  // -------------------------------------------------------------------------
  it('a same-harness crash-loop auto-respawns up to the breaker bound, then breaker_open + alert', async () => {
    // windowMax 3 → the 4th crash within the window opens the breaker.
    const rig = await openLoopRig(kind, {
      config: cfg({ windowMax: 3, autoRespawn: 'bounded' }),
      implementor: [{ turns: [DIE] }], // dies on EVERY respawn (last script repeats)
    });

    const outcome: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch((e: unknown) => e);
    // The exhausting crash unwinds (breaker_open is NOT an AutoRespawnSignal).
    expect(outcome).not.toBeInstanceOf(AutoRespawnSignal);

    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('breaker_open');
    // Three healthy respawns (attempts 1-3) each raised a `respawn` alert; the
    // 4th, exhausting crash raised the `breaker_open` alert and did NOT respawn.
    const kinds = alertKinds(rig.db, rig.runId);
    expect(kinds.filter((k) => k === 'respawn')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'breaker_open')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'crash')).toHaveLength(0); // auto-recovered → no crash alerts
    // Each auto-respawn spawned a fresh generation (gen1 + 3 successors = 4);
    // the 3 folded T13s are the durable restart budget the breaker bounded.
    expect(countType(rig.db, rig.runId, 'child.spawned')).toBe(4);
    expect(countType(rig.db, rig.runId, 'child.exited.unexpectedly')).toBe(3);
    expect(countType(rig.db, rig.runId, 'restart.exhausted')).toBe(1);
    expect(st.counters.lifetimeRestarts).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 2. autoRespawn=off reproduces P4a EXACTLY (crash → interrupted → manual).
  // -------------------------------------------------------------------------
  it('autoRespawn=off reproduces P4a: a crash interrupts and waits for a manual resume (no respawn)', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({ windowMax: 3, autoRespawn: 'off' }),
      implementor: [{ turns: [DIE] }],
    });

    const outcome: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch((e: unknown) => e);
    expect(outcome).not.toBeInstanceOf(AutoRespawnSignal); // never signalled under `off`

    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('interrupted');
    expect(st.autoRecovering).toBeUndefined(); // manual — NOT auto-recovering
    // Exactly ONE crash: the loop did not re-drive.
    expect(countType(rig.db, rig.runId, 'child.exited.unexpectedly')).toBe(1);
    expect(countType(rig.db, rig.runId, 'child.spawned')).toBe(1);
    expect(alertKinds(rig.db, rig.runId).filter((k) => k === 'crash')).toHaveLength(1);
    expect(alertKinds(rig.db, rig.runId).filter((k) => k === 'respawn')).toHaveLength(0);
    expect(st.counters.lifetimeRestarts).toBe(1);
    // Manual resume is reachable and clears the interrupt.
    expect(rig.service.recordSuccessorIntent(rig.runId).status).toBe('applied');
    expect(rig.service.status(rig.runId).suspension).toBe('none');
  });

  // -------------------------------------------------------------------------
  // 3. HEALTHY auto-respawn: crash once, respawn, then succeed → respawn alert.
  // -------------------------------------------------------------------------
  it('raises a respawn alert on a healthy auto-respawn and drives the run to completion', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({ windowMax: 5, autoRespawn: 'bounded' }),
      // Implementor: dies on the first attempt, succeeds on the respawn.
      implementor: [
        { turns: [DIE] },
        { writes: [{ relPath: 'src/feature.ts', content: 'export const feature = true;\n' }], turns: [IMPL_DONE] },
      ],
      verifier: [{ turns: [VERIFY_PASS] }],
    });

    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig));
    expect(result.outcome).toBe('merge_ready');

    const kinds = alertKinds(rig.db, rig.runId);
    expect(kinds.filter((k) => k === 'respawn')).toHaveLength(1);
    expect(kinds.filter((k) => k === 'crash')).toHaveLength(0);
    // Exactly one crash + one successor that went active (acked its marker).
    expect(countType(rig.db, rig.runId, 'child.exited.unexpectedly')).toBe(1);
    expect(countType(rig.db, rig.runId, 'resume_reentry.completed')).toBe(1);
    expect(rig.service.status(rig.runId).suspension).toBe('none');
    expect(rig.service.status(rig.runId).counters.lifetimeRestarts).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. Orchestrator crash (T17) does NOT auto-respawn and is breaker-exempt.
  // -------------------------------------------------------------------------
  it('an orchestrator crash (T17) does NOT auto-respawn and is breaker-exempt (bounded config)', async () => {
    const ps = makeFakePs();
    const DEAD_OWNER = 61_100; // absent from the fake ps table → provably dead
    const SELF = 61_200;
    ps.identities.set(SELF, sampleFor(SELF));
    const { service, db } = await serviceRig(kind, {
      config: cfg({ autoRespawn: 'bounded' }),
      supervision: {
        ps: ps.client,
        selfPid: SELF,
        envNonce: { verifyNonce: () => 'match' },
        sendSignal: () => undefined, // synthetic pids: never touch a real process
      },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    service.advanceWorkflowPhase(runId, 'created', 'specifying');
    service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
    expect((await service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: SPEC_HASH })).status).toBe(
      'applied',
    );
    service.advanceWorkflowPhase(runId, 'approved', 'implementing'); // non-terminal home

    // Seed an ACTIVE implementor generation whose OWNER crashed (DEAD_OWNER) —
    // the stage-aware reap reconciles a still-running segment through T17, NOT
    // the child-crash T13 (no completed RoleRoundProjection is persisted).
    const generation = processGenerationId('pgen_orch');
    const segment = segmentId('seg_orch');
    const now = db.clock.nowIso();
    service.ingest(
      draftEvent({
        type: 'child.spawn.initiated',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'implementor' },
        idempotencyKey: idempotencyKey('orch-init'),
        occurredAt: now,
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'implementor', pins: [] },
        idempotencyKey: idempotencyKey('orch-spawned'),
        occurredAt: now,
      }) as DomainEvent,
    );
    const childPid = 61_300;
    ps.identities.set(childPid, sampleFor(childPid)); // live child → first reap only signals it
    service.supervision.registry.store.put({
      generationId: generation,
      pid: childPid,
      pgid: childPid,
      startedAt: `lstart-${childPid}`,
      executablePath: '/fake/agent',
      spawnNonce: `nonce-${childPid}`,
      recordedAt: now,
      runId,
      segmentId: segment,
      ownerPid: DEAD_OWNER,
    });

    const signaled = service.reapOrphanProcesses();

    expect(signaled.signalSentCount).toBe(1);
    expect(signaled.confirmedGoneCount).toBe(0);
    expect(eventTypes(db, runId)).not.toContain('recovery.running_segment_found');
    expect(service.status(runId).suspension).toBe('none');
    expect(service.supervision.registry.store.get(generation)).toBeDefined();

    // Signal delivery is not exit confirmation. Only a later reap that
    // independently observes absence may release ownership and append T17.
    ps.identities.delete(childPid);
    const confirmed = service.reapOrphanProcesses();
    expect(confirmed.signalSentCount).toBe(0);
    expect(confirmed.confirmedGoneCount).toBe(1);

    const types = eventTypes(db, runId);
    expect(types).toContain('recovery.running_segment_found'); // T17
    expect(types).not.toContain('child.exited.unexpectedly'); // NOT T13
    const st = service.status(runId);
    expect(st.suspension).toBe('interrupted');
    // Breaker-exempt: no restart folded → not auto-recovering, manual only.
    expect(st.counters.lifetimeRestarts).toBe(0);
    expect(st.counters.restartsInWindow).toBe(0);
    expect(st.autoRecovering).toBeUndefined();
    expect(alertKinds(db, runId).filter((k) => k === 'respawn')).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 5. A stale-generation crash does NOT respawn (S4: gate on the applied,
  //    generation-matched T13 — not evaluateCrash's generation-blind advice).
  // -------------------------------------------------------------------------
  it('a stale-generation crash does NOT respawn — the T13 is generation-mismatched (rejected), so the generation-blind restart advice is ignored', async () => {
    const factory = makeRepeatingFactory({ coordinator: [{ turns: [DIE] }] });
    const { service, db } = await serviceRig(kind, { config: cfg({ autoRespawn: 'bounded' }), factory });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    // The loop-equivalent owner: in-process run ownership (the owner-alive gate).
    expect(service.acquireRunOwnership(runId)).toBe(true);

    // A runner that, mid-turn, SUPERSEDES its own generation by activating a
    // NEWER one — so when its prompt dies, the crash's T13 names a stale
    // generation and is REJECTED. A generation-blind respawn would fire here.
    const newer = processGenerationId('pgen_newer');
    const runner: RoleRunner = {
      role: 'coordinator',
      run: async (session) => {
        service.ingest(
          draftEvent({
            type: 'child.spawned',
            runId,
            payload: { generationId: newer, segmentId: segmentId('seg_newer'), role: 'coordinator', pins: [] },
            idempotencyKey: idempotencyKey('newer-spawned'),
            occurredAt: db.clock.nowIso(),
          }) as DomainEvent,
        );
        await session.prompt({ prompt: 'go' }); // dies mid-turn → crash for the STALE gen
        return {};
      },
    };

    const thrown: unknown = await service
      .runRole(runId, runner, CLAUDE_LOW, '/ws', {
        round: 1,
        autoRespawn: true,
        completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
      })
      .then(() => undefined)
      .catch((e: unknown) => e);

    // The stale crash did NOT auto-respawn: no signal, no respawn alert, and the
    // rejected T13 grew no restart window (S5 — decide off the durable window).
    expect(thrown).not.toBeInstanceOf(AutoRespawnSignal);
    expect(alertKinds(db, runId).filter((k) => k === 'respawn')).toHaveLength(0);
    expect(service.status(runId).counters.restartsInWindow).toBe(0);
    expect(service.status(runId).counters.lifetimeRestarts).toBe(0);
  });
});
