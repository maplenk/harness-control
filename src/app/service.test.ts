/**
 * Application service engine (PLAN §5, §6, §20 P3) — offline unit tests
 * against the IN-PROCESS fake adapter (no real spawns). Covers:
 *  - run lifecycle: created → specifying → awaiting_approval on a fake
 *    coordinator turn, with model/effort pinned via setConfigOption (§11.2);
 *  - the single authoritative `ingest` path: illegal transition rejected with
 *    `transition.rejected`, supervisor DomainEvents ingested (breaker T13,
 *    heartbeat), applied transitions durable + atomic;
 *  - §17.2 cost accounting folded into per-role/per-phase status;
 *  - §12.3 recover-by-replay, including W1-F6 workflow dispatch advances
 *    rebuilt from the event log after the projection is deleted/corrupted;
 *  - §11.2 model-pin enforcement (W1-F8): one retry, then typed failure.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  assignmentId,
  gitSha,
  mergeReadinessId,
  processGenerationId,
  segmentId,
  specHash,
  specVersionId,
  idempotencyKey,
  verificationId,
} from '../domain/ids.js';
import type { MergeReadiness } from '../domain/entities.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import { initialEngineState } from '../domain/transitions.js';
import {
  AdapterError,
  InProcessFakeAdapter,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../adapters/index.js';
import { RestartBreaker } from '../supervisor/breaker.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { parseEngineConfig } from '../config/loader.js';
import type { EngineConfig } from '../config/schema.js';
import {
  BudgetExceededError,
  ModelPinError,
  OrchestrationService,
  WorkflowDispatchIngestError,
  loadRunConfig,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from './service.js';
import {
  ENGINE_STATE_PROJECTION,
  RUN_CONFIG_PROJECTION,
  RUN_META_PROJECTION,
  WorkflowDispatchReplayError,
  type RunMeta,
} from './projections.js';
import type { RoleRunner } from './role-runner.js';
import type { AppliedConfigOption, Harness } from './model-resolution.js';

// ---------------------------------------------------------------------------
// Fake adapter factory (records every adapter it spawns for assertions)
// ---------------------------------------------------------------------------
function fakeConfigOptions(harness: Harness): ConfigOptionDescriptor[] {
  if (harness === 'claude') {
    return [
      { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
      { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
    ];
  }
  if (harness === 'opencode') {
    return [
      { id: 'model', kind: 'model', values: ['openai/gpt-4.1'], current: 'openai/gpt-4.1' },
      { id: 'effort', kind: 'reasoning', values: ['low', 'medium', 'high'], current: 'low' },
      { id: 'mode', kind: 'mode', values: ['build', 'plan'], current: 'plan' },
    ];
  }
  if (harness === 'grok') {
    return [
      { id: 'model', kind: 'model', values: ['grok-build'], current: 'grok-build' },
      {
        id: 'reasoning_effort',
        kind: 'reasoning',
        values: ['minimal', 'low', 'medium', 'high', 'xhigh'],
        current: 'medium',
      },
    ];
  }
  return [
    { id: 'model', kind: 'model', values: ['gpt-5.6-terra', 'gpt-5.6-sol'], current: 'gpt-5.6-sol' },
    { id: 'model_reasoning_effort', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

interface CreatedFake {
  readonly options: RoleAdapterOptions;
  readonly adapter: InProcessFakeAdapter;
}

interface FakeFactoryOptions {
  readonly turns?: readonly InProcessTurnScript[];
  /** Advertised config options per harness (defaults to `fakeConfigOptions`). */
  readonly configOptions?: (harness: Harness) => ConfigOptionDescriptor[];
  /** Scripted `setConfigOption` behavior (W1-F8: pin failures / echo-less). */
  readonly onSetConfigOption?: (input: SetConfigOptionInput) => SetConfigOptionResult;
}

function makeFakeFactory(opts?: FakeFactoryOptions): {
  factory: RoleAdapterFactory;
  created: CreatedFake[];
} {
  const created: CreatedFake[] = [];
  const factory: RoleAdapterFactory = {
    create(options) {
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: {
          configOptions: (opts?.configOptions ?? fakeConfigOptions)(options.resolved.harness),
        },
        ...(opts?.turns !== undefined ? { turns: opts.turns } : {}),
        ...(opts?.onSetConfigOption !== undefined
          ? { onSetConfigOption: opts.onSetConfigOption }
          : {}),
      });
      created.push({ options, adapter });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory, created };
}

function setConfigCalls(adapter: InProcessFakeAdapter): unknown[] {
  return adapter.log.filter((e) => e.op === 'setConfigOption').map((e) => e.detail);
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

async function setup(opts?: FakeFactoryOptions, config?: EngineConfig): Promise<{
  service: OrchestrationService;
  db: TestDatabaseHandle['db'];
  created: CreatedFake[];
}> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const db = handle.db;
  const { factory, created } = makeFakeFactory(opts);
  const service = new OrchestrationService({
    db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    ...(config !== undefined ? { config } : {}),
  });
  return { service, db, created };
}

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const OPENCODE_HIGH = {
  harness: 'opencode',
  model: 'openai/gpt-4.1',
  effort: 'high',
} as const;
const GROK_HIGH = { harness: 'grok', model: 'grok-build', effort: 'high' } as const;

/** W2-1: T24 is payload-validated — a READY §16 MergeReadiness fixture. */
function readyMergeReadiness(forRunId: Parameters<OrchestrationService['status']>[0]): MergeReadiness {
  return {
    id: mergeReadinessId('mrg_svc_1'),
    runId: forRunId,
    verificationId: verificationId('ver_f6'),
    specHash: specHash('hash_f6'),
    baseCommit: gitSha('base_svc_1'),
    verifiedCommit: gitSha('impl_svc_1'),
    destinationClean: true,
    worktreeClean: true,
    baseDrifted: false,
    conflicts: false,
    requiredTestsPassed: true,
    ready: true,
    blockers: [],
    manualIntegrationCommands: [],
    createdAt: '2026-07-18T00:00:00.000Z' as MergeReadiness['createdAt'],
  };
}

// ---------------------------------------------------------------------------
// Run lifecycle + role-flow seam
// ---------------------------------------------------------------------------
describe('OrchestrationService — run lifecycle', () => {
  it('forwards a verifier flow exact evidence commands to the provider factory', async () => {
    const { service, created } = await setup();
    const { runId } = service.createRun({
      goal: 'Verify exact commands',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const runner: RoleRunner = {
      role: 'verifier',
      allowedShellCommands: ['npm test', 'git diff --stat'],
      run: async (session) => {
        await session.prompt({ prompt: 'verify' });
        return {};
      },
    };

    await service.runRole(runId, runner, CLAUDE_LOW, '/ws');

    expect(created).toHaveLength(1);
    expect(created[0]?.options.allowedShellCommands).toEqual([
      'npm test',
      'git diff --stat',
    ]);
  });

  it('persists the opt-in planning-chat choice in immutable run metadata', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({
      goal: 'Discuss the plan',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
      planningChatEnabled: true,
    });

    expect(db.projections.get<RunMeta>(runId, RUN_META_PROJECTION)?.state).toMatchObject({
      planningChatEnabled: true,
    });
  });

  it('advances created → specifying → awaiting_approval on a fake coordinator turn (§6.2, §20 P3)', async () => {
    const { service, created } = await setup();
    const { runId } = service.createRun({ goal: 'Add a flag', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    expect(service.status(runId).phase).toBe('created');
    expect(service.status(runId).uiState).toBe('idle');

    const observed: string[] = [];
    const runner: RoleRunner = {
      role: 'coordinator',
      run: async (session) => {
        observed.push(service.status(session.runId).phase); // mid-run phase
        await session.prompt({ prompt: 'Draft the spec.' });
        return {};
      },
    };
    await service.runCoordination(runId, runner);

    expect(observed).toEqual(['specifying']); // the coordinator ran during specifying
    const status = service.status(runId);
    expect(status.phase).toBe('awaiting_approval');
    expect(status.uiState).toBe('waiting_on_you');

    // §11.2: model + effort pinned via setConfigOption on the coordinator session.
    const coordinatorFake = created[0]?.adapter;
    expect(coordinatorFake).toBeDefined();
    expect(setConfigCalls(coordinatorFake!)).toEqual([
      { optionId: 'model', value: 'opus' },
      { optionId: 'thinking', value: 'low' },
    ]);
  });

  it('runs an OpenCode coordinator with its exact dynamic model and effort pins', async () => {
    const { service, created } = await setup();
    const { runId } = service.createRun({
      goal: 'Draft with OpenCode',
      workspacePath: '/ws',
      coordinator: OPENCODE_HIGH,
    });
    const runner: RoleRunner = {
      role: 'coordinator',
      run: async (session) => {
        await session.prompt({ prompt: 'Draft the spec.' });
        return {};
      },
    };

    await service.runCoordination(runId, runner);

    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(created[0]?.options.resolved).toMatchObject(OPENCODE_HIGH);
    expect(setConfigCalls(created[0]!.adapter)).toEqual([
      { optionId: 'model', value: 'openai/gpt-4.1' },
      { optionId: 'effort', value: 'high' },
    ]);
  });

  it('runs a Grok Build coordinator with its exact spawn-pin vocabulary', async () => {
    const { service, created } = await setup();
    const { runId } = service.createRun({
      goal: 'Draft with first-party Grok Build',
      workspacePath: '/ws',
      coordinator: GROK_HIGH,
    });
    const runner: RoleRunner = {
      role: 'coordinator',
      run: async (session) => {
        await session.prompt({ prompt: 'Draft the spec.' });
        return {};
      },
    };

    await service.runCoordination(runId, runner);

    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(created[0]?.options.resolved).toMatchObject(GROK_HIGH);
    expect(setConfigCalls(created[0]!.adapter)).toEqual([
      { optionId: 'model', value: 'grok-build' },
      { optionId: 'reasoning_effort', value: 'high' },
    ]);
  });

  it('applies T1 approval atomically, then permits a workflow dispatch advance to implementing', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    service.advanceWorkflowPhase(runId, 'created', 'specifying');
    service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');

    const approved = service.approve(runId, {
      specVersionId: specVersionId('spec_1'),
      specHash: specHash('hash_abc'),
    });
    expect(approved.status).toBe('applied');
    const st = service.status(runId);
    expect(st.phase).toBe('approved');
    expect(st.approvedSpecHash).toBe('hash_abc');
    // One atomic write: the trigger event is durable and the projection reflects it.
    expect(db.events.listByRun(runId).map((e) => e.type)).toContain('spec.approved');

    service.advanceWorkflowPhase(runId, 'approved', 'implementing');
    expect(service.status(runId).phase).toBe('implementing');
    // A non-dispatch edge is refused (those are §6.3 transitions, or illegal).
    expect(() => service.advanceWorkflowPhase(runId, 'implementing', 'merge_ready')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The single authoritative ingest path
// ---------------------------------------------------------------------------
describe('OrchestrationService.ingest — the single authoritative §6.3 path', () => {
  it('rejects an illegal transition with transition.rejected and leaves state unchanged', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // T1 requires phase=awaiting_approval; the run is at created → precondition_failed.
    const result = service.approve(runId, {
      specVersionId: specVersionId('spec_1'),
      specHash: specHash('hash_1'),
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.reason).toBe('precondition_failed');
      expect(result.rejection.type).toBe('transition.rejected');
    }
    expect(service.status(runId).phase).toBe('created'); // unchanged
    expect(db.events.listByRun(runId).map((e) => e.type)).toContain('transition.rejected');
  });

  it('ingests supervisor DomainEvents: breaker T13 interrupts (W2-1) + emits effects; heartbeat is recorded', async () => {
    const { service, db } = await setup();
    const ids = new DeterministicIdFactory();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const now = db.clock.nowIso();

    // W2-1: a generation must be ACTIVE for a crash to interrupt anything —
    // `child.spawned` (engine-folded supporting event) sets it via ingest.
    const spawned = service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: {
          generationId: processGenerationId('pgen_svc_1'),
          segmentId: segmentId('seg_1'),
          role: 'implementor',
          pins: [{ purpose: 'model', optionId: 'model', value: 'opus', effectiveValue: 'opus', echoed: true }],
        },
        idempotencyKey: idempotencyKey('spawn_svc_1'),
        occurredAt: now,
      }) as DomainEvent,
    );
    expect(spawned.status).toBe('recorded');
    expect(service.status(runId).childActive).toBe(true);
    expect(service.status(runId).activeChild).toMatchObject({ status: 'active' });

    // The breaker hands back a ready `child.exited.unexpectedly` DomainEvent (T13).
    const breaker = new RestartBreaker(ids);
    const advice = breaker.evaluateCrash({
      runId,
      assignmentId: assignmentId('asg_1'),
      segmentId: segmentId('seg_1'),
      occurredAt: now,
      exitCode: 1,
      classifiedAs: 'crash',
      counters: service.status(runId).counters,
    });
    expect(advice.kind).toBe('restart');

    const applied = service.ingest(advice.triggerEvent);
    expect(applied.status).toBe('applied');
    if (applied.status === 'applied') {
      expect(applied.transitionId).toBe('T13');
      // W2-1 deliberate correction: no restart emission — counters fold,
      // the generation stops, suspension=interrupted (manual resume).
      expect(applied.emitted.map((e) => e.type)).toEqual([
        'worktree.validation.required',
        'notify.requested',
      ]);
    }
    const after = service.status(runId);
    expect(after.childActive).toBe(false);
    expect(after.suspension).toBe('interrupted');
    expect(after.activeChild).toMatchObject({ status: 'stopped' });
    expect(after.counters.restartsInWindow).toBe(1);
    expect(after.counters.lifetimeRestarts).toBe(1);

    // A supporting event (heartbeat) is a durable fact — recorded, never a transition.
    const heartbeat = draftEvent({
      type: 'orchestrator.heartbeat',
      runId,
      payload: { rssBytes: 12_345 },
      idempotencyKey: idempotencyKey('hb_1'),
      occurredAt: now,
    }) as DomainEvent;
    const recorded = service.ingest(heartbeat);
    expect(recorded.status).toBe('recorded');
    expect(db.events.listByRun(runId).map((e) => e.type)).toContain('orchestrator.heartbeat');
    // The heartbeat did NOT change the engine state.
    expect(service.status(runId).phase).toBe('created');
  });

  it('W2-0: rejects workflow.dispatch.advanced through public ingest with a typed error — advanceWorkflowPhase stays the only producer', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const forged = draftEvent({
      type: 'workflow.dispatch.advanced',
      runId,
      payload: { from: 'created', to: 'specifying' },
      idempotencyKey: idempotencyKey('forged_advance_1'),
      occurredAt: db.clock.nowIso(),
    }) as DomainEvent;

    expect(() => service.ingest(forged)).toThrowError(WorkflowDispatchIngestError);
    expect(() => service.ingest(forged)).toThrowError(/advanceWorkflowPhase/);
    // Nothing was appended, nothing advanced.
    expect(db.events.listByRun(runId).map((e) => e.type)).not.toContain('workflow.dispatch.advanced');
    expect(service.status(runId).phase).toBe('created');

    // The legal producer still works.
    const advanced = service.advanceWorkflowPhase(runId, 'created', 'specifying');
    expect(advanced.phase).toBe('specifying');
    expect(db.events.listByRun(runId).map((e) => e.type)).toContain('workflow.dispatch.advanced');
  });

  it('W2-1: pause (T11) completes only on the generation-matched child.stopped; resume records the pending re-entry; replay reconstructs it all', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const now = db.clock.nowIso();
    const generation = processGenerationId('pgen_pause_1');

    // Spawn a generation (engine-folded supporting event through ingest).
    service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId: generation, segmentId: segmentId('seg_pause_1'), role: 'implementor', pins: [] },
        idempotencyKey: idempotencyKey('spawn_pause_1'),
        occurredAt: now,
      }) as DomainEvent,
    );

    // T11: pause requested — stop-intent recorded, suspension NOT yet folded.
    const paused = service.pause(runId, { idempotencyKey: idempotencyKey('pause_1') });
    expect(paused.status).toBe('applied');
    expect(service.status(runId).suspension).toBe('none'); // stop not confirmed yet
    expect(service.status(runId).activeChild).toMatchObject({ status: 'stopping', stopCause: 'user_pause' });
    expect(db.events.listByRun(runId).map((e) => e.type)).toContain('child.stop.intent');

    // A LATE stop from a superseded generation must clear nothing.
    service.ingest(
      draftEvent({
        type: 'child.stopped',
        runId,
        payload: { generationId: processGenerationId('pgen_stale_1'), reason: 'exited' },
        idempotencyKey: idempotencyKey('stale_stop_1'),
        occurredAt: now,
      }) as DomainEvent,
    );
    expect(service.status(runId).suspension).toBe('none');
    expect(service.status(runId).activeChild).toMatchObject({ status: 'stopping' });

    // The generation-matched confirmation folds paused_user.
    service.ingest(
      draftEvent({
        type: 'child.stopped',
        runId,
        payload: { generationId: generation, reason: 'graceful' },
        idempotencyKey: idempotencyKey('stop_pause_1'),
        occurredAt: now,
      }) as DomainEvent,
    );
    expect(service.status(runId).suspension).toBe('paused_user');
    expect(service.status(runId).childActive).toBe(false);

    // T12: resume records the pending re-entry (no child marked active).
    const resumed = service.resume(runId, { idempotencyKey: idempotencyKey('resume_pause_1') });
    expect(resumed.status).toBe('applied');
    expect(service.status(runId).suspension).toBe('none');
    expect(service.status(runId).childActive).toBe(false);
    expect(service.status(runId).resumeReentryPending).toMatchObject({ returnPhase: 'created', mode: 'manual' });

    // The ack clears it idempotently.
    service.ingest(
      draftEvent({
        type: 'resume_reentry.completed',
        runId,
        payload: { role: 'implementor' },
        idempotencyKey: idempotencyKey('reentry_ack_1'),
        occurredAt: now,
      }) as DomainEvent,
    );
    expect(service.status(runId).resumeReentryPending).toBeUndefined();

    // §12.3: delete the projection — replaying the log (triggers AND the
    // engine-folded supporting events) rebuilds the exact same state.
    const before = service.status(runId);
    db.driver
      .prepare('DELETE FROM run_projections WHERE run_id = ? AND projection_name = ?')
      .run([runId, ENGINE_STATE_PROJECTION]);
    const recovered = service.recover(runId);
    expect(recovered.suspension.kind).toBe('none');
    expect(recovered.activeChild).toEqual(before.activeChild);
    expect(recovered.resumeReentryPending).toBeUndefined();
    const after = service.status(runId);
    expect(after.suspension).toBe(before.suspension);
    expect(after.childActive).toBe(before.childActive);
  });

  it('W2-1: resume() routes interrupted through T12 (manual re-entry after a crash)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const now = db.clock.nowIso();
    const generation = processGenerationId('pgen_int_1');

    service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId: generation, segmentId: segmentId('seg_int_1'), role: 'implementor', pins: [] },
        idempotencyKey: idempotencyKey('spawn_int_1'),
        occurredAt: now,
      }) as DomainEvent,
    );
    const crashed = service.ingest(
      draftEvent({
        type: 'child.exited.unexpectedly',
        runId,
        payload: { segmentId: segmentId('seg_int_1'), generationId: generation, exitCode: 1, classifiedAs: 'crash' },
        idempotencyKey: idempotencyKey('crash_int_1'),
        occurredAt: now,
      }) as DomainEvent,
    );
    expect(crashed.status).toBe('applied');
    expect(service.status(runId).suspension).toBe('interrupted');

    const resumed = service.resume(runId, { idempotencyKey: idempotencyKey('resume_int_1') });
    expect(resumed.status).toBe('applied');
    if (resumed.status === 'applied') expect(resumed.transitionId).toBe('T12');
    expect(service.status(runId).suspension).toBe('none');
    expect(service.status(runId).resumeReentryPending).toMatchObject({ mode: 'manual' });
  });
});

// ---------------------------------------------------------------------------
// Cost accounting (§17.2)
// ---------------------------------------------------------------------------
describe('OrchestrationService — cost accounting (§17.2)', () => {
  it('folds usage_update + turn usage into per-role/per-phase cost on the run projection', async () => {
    const turns: InProcessTurnScript[] = [
      {
        updates: [
          {
            kind: 'usage_update',
            usedTokens: 1200,
            contextWindowSize: 200_000,
            cost: { amount: 0.42, currency: 'USD' },
          },
        ],
        result: { stopReason: 'end_turn', usage: { inputTokens: 500, outputTokens: 300, source: 'adapter' } },
      },
    ];
    const { service } = await setup({ turns });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const runner: RoleRunner = {
      role: 'coordinator',
      run: async (session) => {
        await session.prompt({ prompt: 'Draft.' });
        return {};
      },
    };
    await service.runCoordination(runId, runner);

    const { cost } = service.status(runId);
    expect(cost.totalCostUsd).toBe(0.42); // streamed cumulative cost
    expect(cost.totalInputTokens).toBe(500);
    expect(cost.totalOutputTokens).toBe(300);
    expect(cost.turns).toBe(1);
    expect(cost.byRole.coordinator?.costUsd).toBe(0.42);
    expect(cost.byRole.coordinator?.turns).toBe(1);
    // Cost was folded while the run was in `specifying` (the coordinator phase).
    expect(cost.byPhase.specifying?.costUsd).toBe(0.42);
    expect(cost.roleVitals.coordinator?.contextUsedTokens).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// Run-config durability (W1-F5)
// ---------------------------------------------------------------------------
function mustParseConfig(input: unknown): EngineConfig {
  const parsed = parseEngineConfig(input);
  if (!parsed.ok) throw new Error(`test config invalid: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

describe('OrchestrationService — run-config durability (W1-F5)', () => {
  it('createRun persists the engine config; a FRESH service instance honors it', async () => {
    const config = mustParseConfig({
      budget: { maxBudgetUsd: 7.5, conservativeReservationUsd: 0.25 },
      quotas: { perRunBytes: 1024, globalBytes: 2048 },
    });
    const { service, db } = await setup(undefined, config);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // The projection round-trips (schema-validated on the way out).
    const loaded = loadRunConfig(db, runId);
    expect(loaded).toBeDefined();
    expect(loaded?.budget.maxBudgetUsd).toBe(7.5);
    expect(loaded?.budget.conservativeReservationUsd).toBe(0.25);
    expect(loaded?.quotas.perRunBytes).toBe(1024);

    // A FRESH service constructed from the loaded config (exactly what a
    // later CLI invocation does) reports the run's own budget — not whatever
    // this process would default to.
    const fresh = new OrchestrationService({
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: {
        create: () => {
          throw new Error('config-durability test must not spawn adapters');
        },
      },
      config: loaded as EngineConfig,
    });
    const budget = fresh.status(runId).budget;
    expect(budget.maxBudgetUsd).toBe(7.5);
    expect(budget.reservationUsd).toBe(0.25);
    expect(fresh.getRunConfig(runId)?.quotas.globalBytes).toBe(2048);
  });

  it('loadRunConfig is undefined for a pre-durability run (caller falls back to defaults)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    db.driver
      .prepare('DELETE FROM run_projections WHERE run_id = ? AND projection_name = ?')
      .run([runId, RUN_CONFIG_PROJECTION]);
    expect(loadRunConfig(db, runId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Estimated-only spend trips the soft budget (§17.2, W1-F5)
// ---------------------------------------------------------------------------
describe('OrchestrationService — estimated-only spend trips the soft budget (§17.2, W1-F5)', () => {
  it('repeated unpriced turns accrue estimated spend until the refusal fires', async () => {
    // Subscription-style turns: tokens advertised, NO price anywhere.
    const unpriced: InProcessTurnScript = {
      result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50, source: 'adapter' } },
    };
    const config = mustParseConfig({ budget: { maxBudgetUsd: 1.2, conservativeReservationUsd: 0.5 } });
    const { service, db } = await setup({ turns: [unpriced, unpriced] }, config);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    let prompts = 0;
    const runner: RoleRunner = {
      role: 'coordinator',
      run: async (session) => {
        // turn 1: 0+0+0.5 ≤ 1.2 ok → est 0.5 · turn 2: 0+0.5+0.5 ≤ 1.2 ok →
        // est 1.0 · turn 3: 0+1.0+0.5 > 1.2 → refused BEFORE the provider
        // ever sees the prompt.
        for (;;) {
          prompts += 1;
          await session.prompt({ prompt: `turn ${prompts}` });
        }
      },
    };
    const error: unknown = await service.runRole(runId, runner, CLAUDE_LOW, '/ws').catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BudgetExceededError);
    const refusal = error as BudgetExceededError;
    expect(refusal.spentUsd).toBe(0); // nothing measured — the estimate alone tripped it
    expect(refusal.estimatedUsd).toBe(1);
    expect(refusal.reservationUsd).toBe(0.5);
    expect(refusal.budgetUsd).toBe(1.2);
    expect(prompts).toBe(3);

    const st = service.status(runId);
    expect(st.cost.turns).toBe(2);
    expect(st.cost.totalCostUsd).toBe(0);
    expect(st.cost.totalEstimatedCostUsd).toBe(1);
    // The status budget block shows measured and estimated spend separately.
    expect(st.budget).toMatchObject({ spentUsd: 0, estimatedSpendUsd: 1, reservationUsd: 0.5, maxBudgetUsd: 1.2 });

    const exceeded = db.events.listByRun(runId).find((e) => e.type === 'budget.exceeded');
    expect(exceeded?.payload).toMatchObject({
      spentUsd: 0,
      estimatedUsd: 1,
      reservationUsd: 0.5,
      budgetUsd: 1.2,
      role: 'coordinator',
    });
  });
});

// ---------------------------------------------------------------------------
// Crash recovery (§12.3)
// ---------------------------------------------------------------------------
describe('OrchestrationService.recover — replay-by-sequence (§12.3)', () => {
  it('rebuilds EngineState by folding events the projection never saw (crash between append and projection)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // Simulate a crash: a cancel trigger reaches the event log but the
    // projection update is lost (append directly, bypassing ingest).
    const cancel = draftEvent({
      type: 'cancel.requested',
      runId,
      payload: {},
      idempotencyKey: idempotencyKey('cancel_1'),
      occurredAt: db.clock.nowIso(),
    }) as DomainEvent;
    db.events.append(cancel);

    // The stale projection still says created; recovery folds the event.
    expect(service.status(runId).phase).toBe('created');
    const recovered = service.recover(runId);
    expect(recovered.phase).toBe('cancelled');
    // recover() persisted the rebuilt state.
    expect(service.status(runId).phase).toBe('cancelled');
  });

  it('rebuilds workflow dispatch advances from the event log after the projection is corrupted (W1-F6)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    service.advanceWorkflowPhase(runId, 'created', 'specifying');
    service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
    const approved = service.approve(runId, {
      specVersionId: specVersionId('spec_1'),
      specHash: specHash('hash_f6'),
    });
    expect(approved.status).toBe('applied');
    service.advanceWorkflowPhase(runId, 'approved', 'implementing');

    // Every advance is a durable supporting event, appended atomically with
    // the projection update through the transition write path.
    const advances = db.events
      .listByRun(runId)
      .filter((e) => e.type === 'workflow.dispatch.advanced')
      .map((e) => e.payload);
    expect(advances).toEqual([
      { from: 'created', to: 'specifying' },
      { from: 'specifying', to: 'awaiting_approval' },
      { from: 'approved', to: 'implementing' },
    ]);

    // Corrupt the projection: overwrite it with the initial state, no cursor
    // (a lost/garbage projection — the defect scenario the fix targets).
    db.projections.save(runId, ENGINE_STATE_PROJECTION, initialEngineState());
    expect(service.status(runId).phase).toBe('created');

    // Full replay reconstructs the exact phase, dispatch advances included.
    const recovered = service.recover(runId);
    expect(recovered.phase).toBe('implementing');
    expect(recovered.approvedSpecHash).toBe('hash_f6');
    expect(service.status(runId).phase).toBe('implementing');

    // Subsequent transitions apply from the recovered state.
    service.advanceWorkflowPhase(runId, 'implementing', 'verifying');
    const passed = service.ingest(
      draftEvent({
        type: 'verification.completed.passed',
        runId,
        // W2-1: T24 is payload-validated — it must CARRY a ready MergeReadiness.
        payload: { verificationId: verificationId('ver_f6'), mergeReadiness: readyMergeReadiness(runId) },
        idempotencyKey: idempotencyKey('t24_f6'),
        occurredAt: db.clock.nowIso(),
      }) as DomainEvent,
    );
    expect(passed.status).toBe('applied');
    expect(service.status(runId).phase).toBe('merge_ready');
  });

  it('rebuilds the exact phase from NOTHING after the projection row is deleted outright (W1-F6)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    service.advanceWorkflowPhase(runId, 'created', 'specifying');
    service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');

    db.driver
      .prepare('DELETE FROM run_projections WHERE run_id = ? AND projection_name = ?')
      .run([runId, ENGINE_STATE_PROJECTION]);

    const recovered = service.recover(runId);
    expect(recovered.phase).toBe('awaiting_approval');

    // A subsequent §6.3 transition applies against the recovered phase.
    const approved = service.approve(runId, {
      specVersionId: specVersionId('spec_2'),
      specHash: specHash('hash_f6b'),
    });
    expect(approved.status).toBe('applied');
    expect(service.status(runId).phase).toBe('approved');
  });

  it('throws a loud typed error when replay meets an illegal dispatch edge (corrupt log, W1-F6)', async () => {
    const { service, db } = await setup();

    // A LISTED edge folded from the wrong phase (run is still at created).
    const { runId: wrongPhaseRun } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    db.events.append(
      draftEvent({
        type: 'workflow.dispatch.advanced',
        runId: wrongPhaseRun,
        payload: { from: 'approved', to: 'implementing' },
        idempotencyKey: idempotencyKey('corrupt_wrong_phase'),
        occurredAt: db.clock.nowIso(),
      }) as DomainEvent,
    );
    expect(() => service.recover(wrongPhaseRun)).toThrow(WorkflowDispatchReplayError);

    // An edge that is not in WORKFLOW_DISPATCH_EDGES at all.
    const { runId: nonEdgeRun } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    db.events.append(
      draftEvent({
        type: 'workflow.dispatch.advanced',
        runId: nonEdgeRun,
        payload: { from: 'created', to: 'implementing' },
        idempotencyKey: idempotencyKey('corrupt_non_edge'),
        occurredAt: db.clock.nowIso(),
      }) as DomainEvent,
    );
    expect(() => service.recover(nonEdgeRun)).toThrow(WorkflowDispatchReplayError);
  });
});

// ---------------------------------------------------------------------------
// Model-pin enforcement (§11.2, W1-F8)
// ---------------------------------------------------------------------------
describe('OrchestrationService.runRole — §11.2 model-pin enforcement (W1-F8)', () => {
  const runnerProbe = (): {
    runner: RoleRunner;
    ran: () => boolean;
    pins: () => readonly AppliedConfigOption[];
  } => {
    let didRun = false;
    let seenPins: readonly AppliedConfigOption[] = [];
    const runner: RoleRunner = {
      role: 'coordinator',
      run: async (session) => {
        didRun = true;
        seenPins = session.configApplied;
        await session.prompt({ prompt: 'go' });
        return {};
      },
    };
    return { runner, ran: () => didRun, pins: () => seenPins };
  };

  it('retries a failed pin ONCE, then throws ModelPinError — session disposed, no turn run', async () => {
    // Advertised reasoning values exclude 'low' → every set attempt fails
    // with invalid_argument (deterministically, initial + the one retry).
    const { service, created } = await setup({
      configOptions: () => [
        { id: 'model', kind: 'model', values: ['opus', 'sonnet'], current: 'sonnet' },
        { id: 'thinking', kind: 'reasoning', values: ['medium', 'high'], current: 'medium' },
      ],
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const probe = runnerProbe();

    const error: unknown = await service
      .runRole(runId, probe.runner, CLAUDE_LOW, '/ws')
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelPinError);
    const pinError = error as ModelPinError;
    expect(pinError.role).toBe('coordinator');
    expect(pinError.purpose).toBe('reasoning');
    expect(pinError.optionId).toBe('thinking');
    expect(pinError.value).toBe('low');
    expect(pinError.firstError).toContain('invalid_argument');
    expect(pinError.retryError).toContain('invalid_argument');

    const adapter = created[0]!.adapter;
    // Model pinned once; the failing reasoning pin attempted exactly twice.
    expect(setConfigCalls(adapter)).toEqual([
      { optionId: 'model', value: 'opus' },
      { optionId: 'thinking', value: 'low' },
      { optionId: 'thinking', value: 'low' },
    ]);
    // No turn ran and the spawn was disposed.
    expect(probe.ran()).toBe(false);
    expect(adapter.log.some((e) => e.op === 'prompt')).toBe(false);
    expect(adapter.log.some((e) => e.op === 'close')).toBe(true);
  });

  it('a pin that fails once and succeeds on its one retry proceeds normally', async () => {
    // W2-3 deliberate correction: classification precedes retry — ONLY a
    // typed non-limit CONFIGURATION rejection (invalid_argument /
    // unsupported_capability) earns the single retry. (An opaque
    // provider_error now pauses fail-safe as T16 — covered in
    // pause-spine.test.ts.)
    let thinkingAttempts = 0;
    const { service, created } = await setup({
      onSetConfigOption: (input) => {
        if (input.optionId === 'thinking') {
          thinkingAttempts += 1;
          if (thinkingAttempts === 1) {
            throw new AdapterError('invalid_argument', 'transient config rejection');
          }
        }
        return { effectiveValue: input.value, echoed: true };
      },
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const probe = runnerProbe();

    await service.runRole(runId, probe.runner, CLAUDE_LOW, '/ws');

    expect(probe.ran()).toBe(true);
    expect(thinkingAttempts).toBe(2); // initial + the one retry
    // The retried pin is recorded as ok with its echo.
    expect(
      probe.pins().map((p) => ({ id: p.resolvedOptionId, ok: p.ok, echoed: p.echoed })),
    ).toEqual([
      { id: 'model', ok: true, echoed: true },
      { id: 'thinking', ok: true, echoed: true },
    ]);
    expect(created[0]!.adapter.log.some((e) => e.op === 'prompt')).toBe(true);
  });

  it('an ok pin WITHOUT an effective-value echo proceeds, recorded as echoed:false (never a failure)', async () => {
    // Live-gate evidence: some adapters do not echo — that is an unconfirmed
    // pin, not a pin failure.
    const { service, created } = await setup({
      onSetConfigOption: (input) => ({ effectiveValue: input.value, echoed: false }),
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const probe = runnerProbe();

    await service.runRole(runId, probe.runner, CLAUDE_LOW, '/ws');

    expect(probe.ran()).toBe(true);
    expect(
      probe.pins().map((p) => ({ id: p.resolvedOptionId, ok: p.ok, echoed: p.echoed })),
    ).toEqual([
      { id: 'model', ok: true, echoed: false },
      { id: 'thinking', ok: true, echoed: false },
    ]);
    // Exactly one attempt per pin — no retry for an accepted echo-less result.
    expect(setConfigCalls(created[0]!.adapter)).toEqual([
      { optionId: 'model', value: 'opus' },
      { optionId: 'thinking', value: 'low' },
    ]);
  });
});
