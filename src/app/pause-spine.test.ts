/**
 * W2-3 PAUSE SPINE (spec docs/specs/hardening-p4a.md §W2-3; PLAN §12.2, §13)
 * — offline unit tests against the IN-PROCESS fake adapter (no real spawns).
 *
 *  - `pauseForLimit` transaction: checkpoint artifact fsynced FIRST
 *    (`incomplete_operation` honest), then ONE atomic append (T4-or-T16 +
 *    checkpoint.recorded + limit.incident.recorded + durable stop-intent,
 *    generation marked stopping), THEN cancel/dispose, THEN the
 *    generation-matched `child.stopped` — with the restart behavior at every
 *    crash boundary (append-failure window; committed-intent reclaim;
 *    full replay).
 *  - Classification precedes retry: limit envelopes on PIN attempts pause
 *    via T4 (operation `initial_config_pin`, never retried);
 *    `unknown_provider_error` pauses via T16 and NEVER feeds the breaker;
 *    auth takes the typed failure path (no retry, no pause); crash takes
 *    T13 (`interrupted`); ONLY a typed non-limit configuration rejection
 *    gets W1-F8's single retry — and a limit on the RETRY still pauses.
 *  - Pending/active dispatch split: the intended round persists `pending`
 *    before any spawn, the workflow REMAINS at its previous stable phase
 *    through spawn+pin, `child.spawned` + the phase advance land only after
 *    pins succeed, and a non-limit pin failure leaves the pending round
 *    retryable (nothing stranded).
 *  - The §6.2 operation axis is DURABLE: `turn.started`/`turn.completed`
 *    and the `child.spawn.initiated` pin window license T4 on live ingest
 *    and on replay identically.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  idempotencyKey,
  processGenerationId,
  segmentId,
  specHash,
  specVersionId,
  type ArtifactHash,
  type RunId,
} from '../domain/ids.js';
import type { CheckpointContent } from '../domain/entities.js';
import {
  draftEvent,
  type DomainEvent,
  type LimitClassification,
} from '../domain/events.js';
import type { EngineState } from '../domain/transitions.js';
import {
  AdapterError,
  InProcessFakeAdapter,
  rateLimitErrorEnvelope,
  unknownProviderErrorEnvelope,
  type ConfigOptionDescriptor,
  type ErrorClassification,
  type InProcessTurnScript,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../adapters/index.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { parseEngineConfig } from '../config/loader.js';
import {
  LimitPausedError,
  ModelPinError,
  OrchestrationService,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from './service.js';
import { ENGINE_STATE_PROJECTION } from './projections.js';
import type { RoleRunner } from './role-runner.js';
import type { Harness } from './model-resolution.js';

// ---------------------------------------------------------------------------
// Harness (mirrors service.test.ts; extended with per-test adapter scripting)
// ---------------------------------------------------------------------------
function fakeConfigOptions(harness: Harness): ConfigOptionDescriptor[] {
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

interface CreatedFake {
  readonly options: RoleAdapterOptions;
  readonly adapter: InProcessFakeAdapter;
}

interface FakeFactoryOptions {
  readonly turns?: readonly InProcessTurnScript[];
  readonly onSetConfigOption?: (input: SetConfigOptionInput) => SetConfigOptionResult;
  readonly classifyOverride?: (raw: unknown) => ErrorClassification | undefined;
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
        capabilities: { configOptions: fakeConfigOptions(options.resolved.harness) },
        ...(opts?.turns !== undefined ? { turns: opts.turns } : {}),
        ...(opts?.onSetConfigOption !== undefined ? { onSetConfigOption: opts.onSetConfigOption } : {}),
        ...(opts?.classifyOverride !== undefined ? { classifyOverride: opts.classifyOverride } : {}),
      });
      created.push({ options, adapter });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory, created };
}

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

async function setup(opts?: FakeFactoryOptions, quotas?: { perRunBytes: number; globalBytes: number }): Promise<{
  service: OrchestrationService;
  db: TestDatabaseHandle['db'];
  created: CreatedFake[];
}> {
  handle = await openTestDatabase({
    kind: 'better-sqlite3',
    file: false,
    ...(quotas !== undefined ? { quotas } : {}),
  });
  const db = handle.db;
  const { factory, created } = makeFakeFactory(opts);
  const service = new OrchestrationService({
    db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
  });
  return { service, db, created };
}

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;

/** A coordinator runner that drives exactly one prompt turn. */
function promptOnceRunner(onPhase?: (phase: string) => void): RoleRunner {
  return {
    role: 'coordinator',
    run: async (session) => {
      onPhase?.('run');
      await session.prompt({ prompt: 'go' });
      return {};
    },
  };
}

function eventTypes(db: TestDatabaseHandle['db'], runId: RunId): string[] {
  return db.events.listByRun(runId).map((e) => e.type);
}

function engineProjection(db: TestDatabaseHandle['db'], runId: RunId): EngineState {
  const record = db.projections.get<EngineState>(runId, ENGINE_STATE_PROJECTION);
  if (record === undefined) throw new Error('engine projection missing');
  return record.state;
}

function readCheckpointContent(db: TestDatabaseHandle['db'], hash: ArtifactHash): CheckpointContent {
  const bytes = db.artifacts.readBytes(hash);
  if (bytes === undefined) throw new Error(`checkpoint artifact ${String(hash)} not in the CAS`);
  return JSON.parse(Buffer.from(bytes).toString('utf8')) as CheckpointContent;
}

// ---------------------------------------------------------------------------
// pauseForLimit — limit envelope on a prompt turn (T4)
// ---------------------------------------------------------------------------
describe('pauseForLimit — limit envelope on a prompt turn (T4)', () => {
  it('checkpoint fsynced first, ONE atomic append, clean stop, zero respawns, honest ETA', async () => {
    const { service, db, created } = await setup({
      turns: [
        {
          errorEnvelope: rateLimitErrorEnvelope({ resumesAt: '2026-07-19T12:00:00.000Z' }),
        },
      ],
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // W2-7 R-A ordering probe: snapshot the adapter op log at the exact
    // moment the atomic pause append executes — §12.2 step (2) precedes
    // step (3), so the child must have NO cancel/dispose ops yet.
    const events = db.events as { appendBatch: typeof db.events.appendBatch };
    const originalAppend = db.events.appendBatch.bind(db.events);
    let stopOpsAtPauseAppend: number | undefined;
    events.appendBatch = (drafts) => {
      if (drafts.some((d) => d.type === 'limit.classified.prompt_turn')) {
        stopOpsAtPauseAppend = created[0]!.adapter.log.filter(
          (e) => e.op === 'close' || e.op === 'cancelTurn',
        ).length;
      }
      return originalAppend(drafts);
    };

    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);
    events.appendBatch = originalAppend;

    expect(error).toBeInstanceOf(LimitPausedError);
    const paused = error as LimitPausedError;
    expect(paused.transitionId).toBe('T4');
    expect(paused.operation).toBe('prompt_turn');
    expect(paused.incidentKind).toBe('usage_limit');
    expect(paused.classification.kind).toBe('usage_limit');
    expect(paused.classification.resumesAt).toBe('2026-07-19T12:00:00.000Z');
    expect(paused.checkpointArtifactHash).toBeDefined();

    // Durable pause: suspension paused_limit, phase UNCHANGED (return_phase
    // = specifying), operation folded idle, generation stop CONFIRMED.
    const st = service.status(runId);
    expect(st.suspension).toBe('paused_limit');
    expect(st.phase).toBe('specifying');
    expect(st.operation).toBe('idle');
    expect(st.uiState).toBe('paused_limit');
    expect(st.childActive).toBe(false);
    expect(st.activeChild).toMatchObject({ status: 'stopped' });
    // Never counts toward restarts/breaker; zero respawns.
    expect(st.counters.restartsInWindow).toBe(0);
    expect(st.counters.lifetimeRestarts).toBe(0);
    expect(created).toHaveLength(1);
    expect(created[0]!.adapter.log.some((e) => e.op === 'close')).toBe(true);
    // W2-7 R-A: the ONE atomic append committed BEFORE any cancel/dispose —
    // at the moment the pause batch was appended, the child had NO stop ops
    // (a dispose-before-append mutation logs close/cancelTurn first and
    // fails here).
    expect(stopOpsAtPauseAppend).toBe(0);

    // The suspension detail records the interrupted operation honestly.
    const state = engineProjection(db, runId);
    expect(state.suspension).toMatchObject({
      kind: 'paused_limit',
      returnPhase: 'specifying',
      inFlightOperation: 'prompt_turn',
    });

    // The ONE atomic append: trigger + engine effects + checkpoint.recorded +
    // the P4b-1 alert.raised (rides the SAME transaction as its `paused_limit`
    // notify cause), then the generation-matched confirmation.
    const types = eventTypes(db, runId);
    const pauseSlice = types.slice(types.indexOf('limit.classified.prompt_turn'));
    expect(pauseSlice).toEqual([
      'limit.classified.prompt_turn',
      'checkpoint.requested',
      'child.stop.intent',
      'segment.stop.requested',
      'limit.incident.recorded',
      'notify.requested',
      'checkpoint.recorded',
      'alert.raised',
      'child.stopped',
    ]);

    // Honest incident: structured tier, retry_after ETA carried verbatim.
    const incident = db.events.listByRun(runId).find((e) => e.type === 'limit.incident.recorded');
    expect(incident?.payload).toMatchObject({
      provider: 'claude',
      incidentKind: 'usage_limit',
      detectionTier: 'structured',
      etaSource: 'retry_after',
      resumesAt: '2026-07-19T12:00:00.000Z',
    });

    // §12.2: the checkpoint artifact is durable in the CAS and honestly
    // records the interrupted prompt turn (never claims completed work).
    const content = readCheckpointContent(db, paused.checkpointArtifactHash!);
    expect(content.incompleteOperation?.operation).toBe('prompt_turn');
    expect(String(content.lineage.harnessId)).toBe('claude');
    // No approved spec at coordinator time — the documented empty sentinel.
    expect(String(content.specHash)).toBe('');
    // The cwd is not a git repo here: the worktree snapshot says so honestly.
    expect(content.unresolvedRisks.some((r) => r.includes('not probed at pause'))).toBe(true);

    // The paused round stays ACTIVE (resumable) with the checkpoint ref.
    const round = service.getRoleRound(runId);
    expect(round).toMatchObject({ role: 'coordinator', round: 1, stage: 'active' });
    expect(round?.checkpointRef).toBe(paused.checkpointArtifactHash);
  });

  it('replay rebuilds the paused state exactly (operation-axis events make T4 apply on replay)', async () => {
    const { service, db } = await setup({
      turns: [{ errorEnvelope: rateLimitErrorEnvelope() }],
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(runId, promptOnceRunner()).catch(() => undefined);

    const before = engineProjection(db, runId);
    db.driver
      .prepare('DELETE FROM run_projections WHERE run_id = ? AND projection_name = ?')
      .run([runId, ENGINE_STATE_PROJECTION]);

    const recovered = service.recover(runId);
    expect(recovered.suspension.kind).toBe('paused_limit');
    expect(recovered.phase).toBe('specifying');
    expect(recovered.operation.kind).toBe('idle');
    expect(recovered.activeChild).toEqual(before.activeChild);
    expect(recovered.activeChild?.status).toBe('stopped');
  });
});

// ---------------------------------------------------------------------------
// pauseForLimit — limit during initial pinning (T4 via initial_config_pin)
// ---------------------------------------------------------------------------
describe('pauseForLimit — limit envelope during initial pinning (T4, initial_config_pin)', () => {
  it('pauses with NO phase advance, NO pin retry; the pending round is preserved', async () => {
    let modelPinAttempts = 0;
    const { service, db } = await setup({
      onSetConfigOption: (input) => {
        if (input.optionId === 'model') {
          modelPinAttempts += 1;
          throw new AdapterError('provider_error', 'limited', {
            envelope: rateLimitErrorEnvelope(),
          });
        }
        return { effectiveValue: input.value, echoed: true };
      },
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LimitPausedError);
    const paused = error as LimitPausedError;
    expect(paused.transitionId).toBe('T4');
    expect(paused.operation).toBe('initial_config_pin');
    // Classification PRECEDES retry: a limit envelope on a pin attempt is
    // never retried (W2-3).
    expect(modelPinAttempts).toBe(1);

    // Pending/active split: the workflow REMAINED at `created` — no advance,
    // no active generation, the round is still pending (retryable by resume).
    const st = service.status(runId);
    expect(st.phase).toBe('created');
    expect(st.suspension).toBe('paused_limit');
    const types = eventTypes(db, runId);
    expect(types).not.toContain('workflow.dispatch.advanced');
    expect(types).not.toContain('child.spawned');
    expect(types).toContain('child.spawn.initiated');
    expect(types).toContain('child.stop.intent');
    expect(types).toContain('child.stopped');
    expect(service.getRoleRound(runId)).toMatchObject({ role: 'coordinator', stage: 'pending' });

    // The checkpoint honestly records the interrupted pin window.
    const content = readCheckpointContent(db, paused.checkpointArtifactHash!);
    expect(content.incompleteOperation?.operation).toBe('initial_config_pin');

    const state = engineProjection(db, runId);
    expect(state.suspension).toMatchObject({
      kind: 'paused_limit',
      returnPhase: 'created',
      inFlightOperation: 'initial_config_pin',
    });
  });
});

// ---------------------------------------------------------------------------
// T16 — unknown provider error: fail-safe pause, NEVER the breaker
// ---------------------------------------------------------------------------
describe('pauseForLimit — unknown_provider_error (T16, never the breaker)', () => {
  it('pauses with incident kind unknown, honest unknown ETA, zero breaker counting', async () => {
    const { service, db } = await setup({
      turns: [{ errorEnvelope: unknownProviderErrorEnvelope() }],
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LimitPausedError);
    const paused = error as LimitPausedError;
    expect(paused.transitionId).toBe('T16');
    expect(paused.incidentKind).toBe('unknown');
    expect(paused.classification.resumesAt).toBeUndefined(); // honest: no invented countdown

    const st = service.status(runId);
    expect(st.suspension).toBe('paused_limit');
    // T16 NEVER counts toward the breaker (spec W2-3; §6.3 invariant).
    expect(st.counters.restartsInWindow).toBe(0);
    expect(st.counters.lifetimeRestarts).toBe(0);
    const types = eventTypes(db, runId);
    expect(types).toContain('provider.error.unknown');
    expect(types).not.toContain('breaker.opened');
    const incident = db.events.listByRun(runId).find((e) => e.type === 'limit.incident.recorded');
    expect(incident?.payload).toMatchObject({ incidentKind: 'unknown', etaSource: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// Classification precedes retry — pin failure routing
// ---------------------------------------------------------------------------
describe('classification precedes retry — pin failures (W2-3)', () => {
  it('an auth-classified pin failure takes the typed path (no retry, no pause) and the pending round is retryable', async () => {
    let authAttempts = 0;
    const { service, db } = await setup({
      onSetConfigOption: (input) => {
        if (input.optionId === 'model' && authAttempts === 0) {
          authAttempts += 1;
          throw new AdapterError('provider_error', 'auth required', {
            envelope: { code: -32603, message: 'auth', data: { errorKind: 'auth' } },
          });
        }
        return { effectiveValue: input.value, echoed: true };
      },
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);

    // The RAW typed error propagates: no retry, no pause, no phase advance.
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).kind).toBe('provider_error');
    expect(authAttempts).toBe(1);
    const st = service.status(runId);
    expect(st.suspension).toBe('none');
    expect(st.phase).toBe('created');
    expect(eventTypes(db, runId)).not.toContain('limit.incident.recorded');
    expect(service.getRoleRound(runId)).toMatchObject({ stage: 'pending', round: 1 });

    // The pending round is RETRYABLE: the next dispatch completes normally.
    await service.runCoordination(runId, promptOnceRunner());
    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(service.getRoleRound(runId)).toMatchObject({ stage: 'completed', round: 1 });
  });

  it('a limit envelope on the RETRY of a configuration rejection still pauses (classification runs again)', async () => {
    let thinkingAttempts = 0;
    const { service } = await setup({
      onSetConfigOption: (input) => {
        if (input.optionId === 'thinking') {
          thinkingAttempts += 1;
          if (thinkingAttempts === 1) {
            throw new AdapterError('invalid_argument', 'bad value'); // config rejection → retry
          }
          throw new AdapterError('provider_error', 'limited', { envelope: rateLimitErrorEnvelope() });
        }
        return { effectiveValue: input.value, echoed: true };
      },
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LimitPausedError);
    expect((error as LimitPausedError).operation).toBe('initial_config_pin');
    expect(thinkingAttempts).toBe(2); // initial + the single retry, then paused — never a third
    expect(service.status(runId).suspension).toBe('paused_limit');
  });

  it('an ECHOED effective value contradicting the requested pin is a failed pin: one retry, then ModelPinError (W2-0 via W2-3)', async () => {
    let thinkingAttempts = 0;
    const { service, created } = await setup({
      onSetConfigOption: (input) => {
        if (input.optionId === 'thinking') {
          thinkingAttempts += 1;
          return { effectiveValue: 'high', echoed: true }; // contradicts 'low'
        }
        return { effectiveValue: input.value, echoed: true };
      },
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ModelPinError);
    const pinError = error as ModelPinError;
    expect(pinError.firstError).toContain('echoed effective value');
    expect(pinError.retryError).toContain('echoed effective value');
    expect(thinkingAttempts).toBe(2); // the applyRoleModel attempt + the single retry
    // No turn ran; the run is not suspended (typed failure, retryable round).
    expect(created[0]!.adapter.log.some((e) => e.op === 'prompt')).toBe(false);
    expect(service.status(runId).suspension).toBe('none');
    expect(service.getRoleRound(runId)).toMatchObject({ stage: 'pending' });
  });

  it('an ok pin WITHOUT an echo still proceeds (echoed:false accepted, never a failure)', async () => {
    const { service } = await setup({
      onSetConfigOption: (input) => ({ effectiveValue: input.value, echoed: false }),
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(runId, promptOnceRunner());
    expect(service.status(runId).phase).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// Child death (T13) — crash classification interrupts, never pauses
// ---------------------------------------------------------------------------
describe('child death during a turn — T13 (interrupted, manual resume)', () => {
  it('folds counters, marks the generation stopped, suspends interrupted; the raw error propagates', async () => {
    const { service, db } = await setup({
      turns: [{ errorEnvelope: { marker: 'child-died' } }],
      classifyOverride: (raw) => {
        const envelope = raw instanceof AdapterError ? raw.envelope : raw;
        if (
          envelope !== null &&
          typeof envelope === 'object' &&
          (envelope as { marker?: string }).marker === 'child-died'
        ) {
          return { kind: 'crash', source: 'structured', confidence: 'high' };
        }
        return undefined;
      },
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdapterError); // typed unwind, not a pause
    const st = service.status(runId);
    expect(st.suspension).toBe('interrupted');
    expect(st.counters.restartsInWindow).toBe(1);
    expect(st.counters.lifetimeRestarts).toBe(1);
    expect(st.childActive).toBe(false);
    expect(st.activeChild).toMatchObject({ status: 'stopped' });
    const types = eventTypes(db, runId);
    expect(types).toContain('child.exited.unexpectedly');
    expect(types).not.toContain('limit.incident.recorded');
    expect(types).not.toContain('segment.restart.initiated'); // zero auto-respawns in P4a

    // Manual resume routes T12 (the eligibility-checked re-entry).
    const resumed = service.resume(runId, { idempotencyKey: idempotencyKey('resume_t13_1') });
    expect(resumed.status).toBe('applied');
    if (resumed.status === 'applied') expect(resumed.transitionId).toBe('T12');
  });
});

// ---------------------------------------------------------------------------
// Crash-safety at the pause boundaries (spec W2-3 crash points)
// ---------------------------------------------------------------------------
describe('pauseForLimit crash windows', () => {
  it('append-failure after the checkpoint fsync: no pause events land; the artifact is unreferenced (GC-invisible); the child was STILL ALIVE at the failed append', async () => {
    const { service, db, created } = await setup({
      turns: [{ errorEnvelope: rateLimitErrorEnvelope() }],
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    // Inject the crash exactly between step (1) artifact fsync and step (2)
    // the atomic append: the batch carrying the T4 trigger throws.
    const events = db.events as { appendBatch: typeof db.events.appendBatch };
    const original = db.events.appendBatch.bind(db.events);
    let stopOpsAtCrash: number | undefined;
    events.appendBatch = (drafts) => {
      if (drafts.some((d) => d.type === 'limit.classified.prompt_turn')) {
        // W2-7 R-A: capture the child's stop ops AT the crash-at-append
        // moment — §12.2 orders the append BEFORE cancel/dispose, so the
        // child must still be alive when the append fails.
        stopOpsAtCrash = created[0]!.adapter.log.filter(
          (e) => e.op === 'close' || e.op === 'cancelTurn',
        ).length;
        throw new Error('injected crash: power loss before the pause append');
      }
      return original(drafts);
    };

    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(String(error)).toContain('injected crash');
    // W2-7 R-A (ordering enforced): the append failed while the child had
    // NO close/cancelTurn ops — a dispose-before-append mutation fails here.
    expect(stopOpsAtCrash).toBe(0);
    // Nothing of the pause landed — the run is NOT suspended...
    const st = service.status(runId);
    expect(st.suspension).toBe('none');
    const types = eventTypes(db, runId);
    expect(types).not.toContain('limit.classified.prompt_turn');
    expect(types).not.toContain('checkpoint.recorded');
    expect(types).not.toContain('child.stop.intent');
    expect(types).not.toContain('limit.incident.recorded');
    // ...but the checkpoint ARTIFACT was already fsynced (step 1 precedes
    // step 2) and is referenced by NO committed event → invisible to replay
    // and reclaimable by GC (§12.2 guarantee, proven in artifacts tests).
    expect(db.artifacts.usedBytesForRun(runId)).toBeGreaterThan(0);
  });

  it('crash between the committed append and the stop confirmation: restart reclaims the stop-intent idempotently', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const now = db.clock.nowIso();
    const generation = processGenerationId('pgen_crash_1');
    const segment = segmentId('seg_crash_1');

    // Build the exact durable state the pause spine leaves when the process
    // dies after step (2): spawn window + turn + committed T4, NO
    // child.stopped confirmation.
    service.ingest(
      draftEvent({
        type: 'child.spawn.initiated',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'coordinator' },
        idempotencyKey: idempotencyKey('spawn_init_crash_1'),
        occurredAt: now,
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId: generation, segmentId: segment, role: 'coordinator', pins: [] },
        idempotencyKey: idempotencyKey('spawn_crash_1'),
        occurredAt: now,
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'turn.started',
        runId,
        payload: { segmentId: segment, generationId: generation },
        idempotencyKey: idempotencyKey('turn_crash_1'),
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
    const pausedOutcome = service.ingest(
      draftEvent({
        type: 'limit.classified.prompt_turn',
        runId,
        payload: { segmentId: segment, classification },
        idempotencyKey: idempotencyKey('t4_crash_1'),
        occurredAt: now,
      }) as DomainEvent,
    );
    expect(pausedOutcome.status).toBe('applied');
    expect(service.status(runId).activeChild).toMatchObject({ status: 'stopping', stopCause: 'limit_pause' });

    // "Restart": a FRESH service over the same store recovers the committed
    // stop-intent, performs the (§14, W2-6) identity-verified cleanup, and
    // appends the generation-matched confirmation.
    const successor = new OrchestrationService({
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: {
        create: () => {
          throw new Error('the reclaim path must not spawn adapters');
        },
      },
    });
    const recovered = successor.recover(runId);
    expect(recovered.suspension.kind).toBe('paused_limit');
    expect(recovered.activeChild?.status).toBe('stopping');

    const confirmed = successor.confirmStopIntentAfterCleanup(runId, {
      idempotencyKey: idempotencyKey('reclaim_crash_1'),
    });
    expect(confirmed?.status).toBe('recorded');
    const after = successor.status(runId);
    expect(after.suspension).toBe('paused_limit'); // the pause survives the stop
    expect(after.activeChild).toMatchObject({ status: 'stopped' });
    const stopped = db.events.listByRun(runId).find((e) => e.type === 'child.stopped');
    expect(stopped?.payload).toMatchObject({ generationId: generation, reason: 'startup_cleanup' });

    // Idempotent: a second reclaim is a no-op.
    expect(
      successor.confirmStopIntentAfterCleanup(runId, { idempotencyKey: idempotencyKey('reclaim_crash_2') }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Pending/active dispatch split (W2-3)
// ---------------------------------------------------------------------------
describe('pending/active dispatch split', () => {
  it('coordinator: phase remains created through spawn+pin; child.spawned precedes the advance; round pending→active→completed', async () => {
    const phasesAtPinTime: string[] = [];
    let serviceRef: OrchestrationService | undefined;
    let runRef: RunId | undefined;
    const { service, db } = await setup({
      onSetConfigOption: (input) => {
        if (serviceRef !== undefined && runRef !== undefined) {
          phasesAtPinTime.push(serviceRef.status(runRef).phase);
        }
        return { effectiveValue: input.value, echoed: true };
      },
    });
    serviceRef = service;
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    runRef = runId;

    const phasesInRun: string[] = [];
    await service.runCoordination(runId, {
      role: 'coordinator',
      run: async (session) => {
        phasesInRun.push(service.status(session.runId).phase);
        await session.prompt({ prompt: 'draft' });
        return {};
      },
    });

    // Spawn+pin happened at the PREVIOUS stable phase; the flow ran after
    // the advance; completion advanced to awaiting_approval.
    expect(phasesAtPinTime).toEqual(['created', 'created']); // model + thinking pins
    expect(phasesInRun).toEqual(['specifying']);
    expect(service.status(runId).phase).toBe('awaiting_approval');

    // Event ORDER: spawn-initiated < spawned < dispatch advance (the phase
    // advances only after pins succeed).
    const log = db.events.listByRun(runId);
    const seqOf = (type: string): number => log.findIndex((e) => e.type === type);
    expect(seqOf('child.spawn.initiated')).toBeGreaterThanOrEqual(0);
    expect(seqOf('child.spawn.initiated')).toBeLessThan(seqOf('child.spawned'));
    expect(seqOf('child.spawned')).toBeLessThan(seqOf('workflow.dispatch.advanced'));

    // child.spawned carries the enforced pins with echo facts (W1-F8).
    const spawned = log.find((e) => e.type === 'child.spawned');
    expect(spawned?.payload).toMatchObject({
      role: 'coordinator',
      pins: [
        { purpose: 'model', optionId: 'model', value: 'opus', effectiveValue: 'opus', echoed: true },
        { purpose: 'effort', optionId: 'thinking', value: 'low', effectiveValue: 'low', echoed: true },
      ],
    });

    const round = service.getRoleRound(runId);
    expect(round).toMatchObject({ role: 'coordinator', round: 1, stage: 'completed' });
    expect(round?.generationId).toBeDefined();
    expect(round?.intendedCompletionAdvance).toEqual({ from: 'specifying', to: 'awaiting_approval' });
  });

  it('implementor-shaped dispatch: approved holds through pinning; runRole advances approved→implementing after pins succeed', async () => {
    const phases: string[] = [];
    let serviceRef: OrchestrationService | undefined;
    let runRef: RunId | undefined;
    const { service } = await setup({
      onSetConfigOption: (input) => {
        if (serviceRef !== undefined && runRef !== undefined) {
          phases.push(`pin:${serviceRef.status(runRef).phase}`);
        }
        return { effectiveValue: input.value, echoed: true };
      },
    });
    serviceRef = service;
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    runRef = runId;
    service.advanceWorkflowPhase(runId, 'created', 'specifying');
    service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
    expect(
      service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: specHash('hash_1') }).status,
    ).toBe('applied');

    const result = await service.runRole(
      runId,
      {
        role: 'implementor',
        run: async (session) => {
          phases.push(`run:${service.status(session.runId).phase}`);
          await session.prompt({ prompt: 'implement' });
          return 'done';
        },
      },
      CLAUDE_LOW,
      '/ws',
      {
        round: 1,
        advance: { from: 'approved', to: 'implementing' },
        completionAdvance: { from: 'implementing', to: 'verifying' },
        specHash: specHash('hash_1'),
      },
    );
    expect(result).toBe('done');
    expect(phases).toEqual(['pin:approved', 'pin:approved', 'run:implementing']);
    expect(service.status(runId).phase).toBe('implementing'); // completion advance is the caller's
    expect(service.getRoleRound(runId)).toMatchObject({
      role: 'implementor',
      stage: 'completed',
      specHash: 'hash_1',
    });
  });
});

// ---------------------------------------------------------------------------
// Durable operation axis across prompt turns
// ---------------------------------------------------------------------------
describe('turn operation axis (durable prompt_turn window)', () => {
  it('operation is prompt_turn during the provider call and idle after; turn events land on the log', async () => {
    const { service, db } = await setup({
      turns: [{ updates: [{ kind: 'agent_message_chunk', text: 'working' }] }],
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const operationsSeen: string[] = [];
    await service.runCoordination(runId, {
      role: 'coordinator',
      run: async (session) => {
        await session.prompt({
          prompt: 'go',
          onUpdate: () => {
            operationsSeen.push(service.status(runId).operation);
          },
        });
        operationsSeen.push(service.status(runId).operation);
        return {};
      },
    });

    expect(operationsSeen).toEqual(['prompt_turn', 'idle']);
    const types = eventTypes(db, runId);
    expect(types).toContain('turn.started');
    expect(types).toContain('turn.completed');
    const completed = db.events.listByRun(runId).find((e) => e.type === 'turn.completed');
    expect(completed?.payload).toMatchObject({ outcome: 'completed' });
  });

  it('a typed (auth) turn failure folds the operation back to idle with outcome failed — no pause', async () => {
    const { service, db } = await setup({
      turns: [
        { errorEnvelope: { code: -32603, message: 'auth', data: { errorKind: 'auth' } } },
      ],
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AdapterError);
    const st = service.status(runId);
    expect(st.suspension).toBe('none');
    expect(st.operation).toBe('idle');
    const completed = db.events.listByRun(runId).find((e) => e.type === 'turn.completed');
    expect(completed?.payload).toMatchObject({ outcome: 'failed' });
    expect(eventTypes(db, runId)).not.toContain('limit.incident.recorded');
  });
});

// ---------------------------------------------------------------------------
// Quota-rejected checkpoint: the pause still lands, honestly
// ---------------------------------------------------------------------------
describe('pauseForLimit under artifact-quota exhaustion', () => {
  it('a quota-rejected checkpoint write never blocks the pause; no checkpoint.recorded is fabricated', async () => {
    const { service, db } = await setup(
      { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] },
      { perRunBytes: 1, globalBytes: 1024 * 1024 },
    );
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner())
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LimitPausedError);
    expect((error as LimitPausedError).checkpointArtifactHash).toBeUndefined();
    expect(service.status(runId).suspension).toBe('paused_limit');
    const types = eventTypes(db, runId);
    expect(types).not.toContain('checkpoint.recorded');
    expect(types).toContain('artifact.admission.rejected'); // the honest audit trail
    expect(types).toContain('limit.incident.recorded');
  });
});

// ---------------------------------------------------------------------------
// W4-1 §12.2 — completed-turn cadence checkpoint (CadenceTracker WIRED)
// ---------------------------------------------------------------------------
/** A coordinator runner that drives exactly `n` successful prompt turns. */
function promptNRunner(n: number): RoleRunner {
  return {
    role: 'coordinator',
    run: async (session) => {
      for (let i = 0; i < n; i += 1) await session.prompt({ prompt: 'go' });
      return {};
    },
  };
}

function cadenceCheckpoints(db: TestDatabaseHandle['db'], runId: RunId) {
  return db.events
    .listByRun(runId)
    .filter(
      (e) => e.type === 'checkpoint.recorded' && (e.payload as { reason?: string }).reason === 'cadence',
    );
}

describe('W4-1 §12.2 completed-turn cadence checkpoint', () => {
  it('takes a `cadence` checkpoint every N completed turns (default 3) — fails without the CadenceTracker wiring', async () => {
    // Three benign completed turns cross the default cadence window exactly
    // once. Before W4-1 the CadenceTracker had no production caller, so ZERO
    // cadence checkpoints were ever written — this expectation is the
    // regression guard (0 !== 1 without the fix).
    const { service, db } = await setup({ turns: [{}, {}, {}] });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(runId, promptNRunner(3));

    const cadence = cadenceCheckpoints(db, runId);
    expect(cadence).toHaveLength(1);

    // A completed-turn cadence checkpoint interrupts no work: idle operation,
    // no `incompleteOperation` fabricated (§12.2 honesty).
    const hash = (cadence[0]!.payload as { artifactHash: ArtifactHash }).artifactHash;
    const content = readCheckpointContent(db, hash);
    expect(content.incompleteOperation).toBeUndefined();
  });

  it('does NOT checkpoint before the window elapses (2 of 3 turns → no cadence checkpoint)', async () => {
    const { service, db } = await setup({ turns: [{}, {}] });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(runId, promptNRunner(2));
    expect(cadenceCheckpoints(db, runId)).toHaveLength(0);
  });

  it('resets the window after each checkpoint (6 turns → exactly 2 cadence checkpoints)', async () => {
    const { service, db } = await setup({ turns: [{}, {}, {}, {}, {}, {}] });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(runId, promptNRunner(6));
    expect(cadenceCheckpoints(db, runId)).toHaveLength(2);
  });
});
