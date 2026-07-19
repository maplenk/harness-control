/**
 * W2-7 CROSS-CUTTING pause matrix, service level (spec
 * docs/specs/hardening-p4a.md §W2-7; PLAN §13, §19 tests 21-extended + 24) —
 * the coverage no single build stage could write alone, against the
 * in-process fake and the REAL pinned adapter fixtures:
 *
 *  - the limit envelope lands on turn N (N=2 — after a COMPLETED turn) in
 *    all four envelope shapes end to end through `pauseForLimit`: Claude
 *    structured, Codex structured, HTTP 429 + Retry-After, and an unknown
 *    envelope (T16) — each with its exact incident facts (provider, tier,
 *    etaSource, honest ETA), checkpoint, clean stop, and zero respawns;
 *  - agent-message TEXT that mentions limits flows through a full service
 *    round and NEVER classifies (no pause, no incident — §9/§13);
 *  - repeated T16 incidents never feed the breaker (cross-incident);
 *  - the generation race through the REAL ingest path: a DELAYED
 *    `child.stopped` (and a stale T13 exit report) from the pre-pause
 *    generation must not touch the freshly re-entered generation;
 *  - T11 pause/stop-confirmed ordering through the service: `pause` records
 *    the stop-intent, suspension folds `paused_user` ONLY on the
 *    generation-matched confirmation, and T12 resumes.
 *
 * Per-stage scoped coverage this file deliberately does NOT duplicate:
 * classifier fixtures per profile (adapters/{claude,codex}/classify+
 * conformance tests), the pause spine's own crash windows + pin routing
 * (app/pause-spine.test.ts), probe outcomes and fencing
 * (app/limit-probe.test.ts), and the pure T11/generation folds
 * (domain/transitions.conformance.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { idempotencyKey, processGenerationId, type RunId } from '../domain/ids.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import {
  CLAUDE_AGENT_TEXT_MENTIONING_LIMITS,
  CLAUDE_HTTP_429_ENVELOPE,
  CLAUDE_RATE_LIMIT_ENVELOPE,
} from '../adapters/claude/fixtures/claude-error-envelopes.js';
import {
  CODEX_AGENT_TEXT_MENTIONING_LIMITS,
  CODEX_OPAQUE_ENVELOPE,
  CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE,
} from '../adapters/codex/fixtures/codex-error-envelopes.js';
import {
  InProcessFakeAdapter,
  limitOnTurnN,
  unknownProviderErrorEnvelope,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
} from '../adapters/index.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import {
  LimitPausedError,
  OrchestrationService,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from './service.js';
import type { RoleRunner } from './role-runner.js';
import type { Harness, RoleModelSpec } from './model-resolution.js';

// ---------------------------------------------------------------------------
// Harness (pause-spine conventions + a manual clock for ETA determinism)
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

/** Factory whose Nth created adapter takes the Nth turn script (last reused). */
function makeQueueFactory(scripts: readonly (readonly InProcessTurnScript[])[]): {
  factory: RoleAdapterFactory;
  created: CreatedFake[];
} {
  const created: CreatedFake[] = [];
  const factory: RoleAdapterFactory = {
    create(options) {
      const turns = scripts[Math.min(created.length, scripts.length - 1)] ?? [];
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        // The service's injected clock: Retry-After ETAs compute from the
        // manual test clock, never the wall clock.
        clock: options.clock,
        capabilities: { configOptions: fakeConfigOptions(options.resolved.harness) },
        turns,
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

const T0 = '2026-07-18T00:00:00.000Z';
const CLAUDE_LOW: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const CODEX_LOW: RoleModelSpec = { harness: 'codex', model: 'gpt-5.6-sol', effort: 'low' };

async function setup(scripts: readonly (readonly InProcessTurnScript[])[]): Promise<{
  service: OrchestrationService;
  db: TestDatabaseHandle['db'];
  created: CreatedFake[];
  clock: ManualClock;
}> {
  const clock = new ManualClock(T0);
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false, clock });
  const { factory, created } = makeQueueFactory(scripts);
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
  });
  return { service, db: handle.db, created, clock };
}

/** A coordinator runner that drives exactly `count` prompt turns. */
function promptTimesRunner(count: number): RoleRunner {
  return {
    role: 'coordinator',
    run: async (session) => {
      for (let i = 1; i <= count; i += 1) {
        await session.prompt({ prompt: `turn ${i}` });
      }
      return {};
    },
  };
}

function eventTypes(db: TestDatabaseHandle['db'], runId: RunId): string[] {
  return db.events.listByRun(runId).map((e) => e.type);
}

// ---------------------------------------------------------------------------
// The four envelope shapes, end to end (21-extended × the pause spine)
// ---------------------------------------------------------------------------
describe('W2-7: limit envelope on turn N — all four shapes through pauseForLimit', () => {
  interface ShapeCase {
    readonly name: string;
    readonly spec: RoleModelSpec;
    readonly envelope: unknown;
    readonly transitionId: 'T4' | 'T16';
    readonly trigger: 'limit.classified.prompt_turn' | 'provider.error.unknown';
    readonly incident: Record<string, unknown>;
    /** The exact structured ETA, or undefined for an honest unknown. */
    readonly resumesAt?: string;
  }

  const CASES: readonly ShapeCase[] = [
    {
      name: 'Claude structured (-32603 + errorKind=rate_limit)',
      spec: CLAUDE_LOW,
      envelope: CLAUDE_RATE_LIMIT_ENVELOPE,
      transitionId: 'T4',
      trigger: 'limit.classified.prompt_turn',
      incident: {
        provider: 'claude',
        incidentKind: 'usage_limit',
        detectionTier: 'structured',
        etaSource: 'unknown',
      },
    },
    {
      name: 'Codex structured (-32603 + codexErrorInfo=usageLimitExceeded)',
      spec: CODEX_LOW,
      envelope: CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE,
      transitionId: 'T4',
      trigger: 'limit.classified.prompt_turn',
      incident: {
        provider: 'codex',
        incidentKind: 'usage_limit',
        detectionTier: 'structured',
        etaSource: 'unknown',
      },
    },
    {
      name: 'HTTP 429 + Retry-After (API-key mode)',
      spec: CLAUDE_LOW,
      envelope: CLAUDE_HTTP_429_ENVELOPE, // retry-after: 120s
      transitionId: 'T4',
      trigger: 'limit.classified.prompt_turn',
      incident: {
        provider: 'claude',
        incidentKind: 'usage_limit',
        detectionTier: 'http_429',
        etaSource: 'retry_after',
      },
      resumesAt: '2026-07-18T00:02:00.000Z', // T0 + the Retry-After seconds
    },
    {
      name: 'unknown envelope (opaque code) — T16',
      spec: CODEX_LOW,
      envelope: CODEX_OPAQUE_ENVELOPE,
      transitionId: 'T16',
      trigger: 'provider.error.unknown',
      incident: {
        provider: 'codex',
        incidentKind: 'unknown',
        detectionTier: 'unknown',
        etaSource: 'unknown',
      },
    },
  ];

  it.each(CASES)('$name: pause on turn 2, exact incident facts, checkpoint, clean stop, zero respawns', async (c) => {
    const { service, db, created } = await setup([limitOnTurnN(2, c.envelope)]);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: c.spec });

    const error: unknown = await service
      .runCoordination(runId, promptTimesRunner(2))
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LimitPausedError);
    const paused = error as LimitPausedError;
    expect(paused.transitionId).toBe(c.transitionId);
    expect(paused.operation).toBe('prompt_turn');
    if (c.resumesAt !== undefined) {
      expect(paused.classification.resumesAt).toBe(c.resumesAt);
    } else {
      expect(paused.classification.resumesAt).toBeUndefined(); // honest: no invented countdown
    }

    // Turn N semantics: turn 1 COMPLETED before the pause — exactly one
    // completed turn.completed; the paused turn's operation folds via the
    // trigger row itself (never a turn.completed of its own).
    const log = db.events.listByRun(runId);
    expect(log.filter((e) => e.type === 'turn.started')).toHaveLength(2);
    const completions = log.filter((e) => e.type === 'turn.completed');
    expect(completions).toHaveLength(1);
    expect(completions[0]?.payload).toMatchObject({ outcome: 'completed' });

    // The trigger row and its exact incident facts.
    const types = eventTypes(db, runId);
    expect(types).toContain(c.trigger);
    const incident = log.find((e) => e.type === 'limit.incident.recorded');
    expect(incident?.payload).toMatchObject(c.incident);
    if (c.resumesAt !== undefined) {
      expect(incident?.payload).toMatchObject({ resumesAt: c.resumesAt });
    } else {
      expect((incident?.payload as { resumesAt?: string }).resumesAt).toBeUndefined();
    }

    // Durable pause + §12.2 checkpoint + clean stop + ZERO respawns.
    const st = service.status(runId);
    expect(st.suspension).toBe('paused_limit');
    expect(st.operation).toBe('idle');
    expect(st.activeChild).toMatchObject({ status: 'stopped' });
    expect(st.counters.restartsInWindow).toBe(0);
    expect(st.counters.lifetimeRestarts).toBe(0);
    expect(types).toContain('checkpoint.recorded');
    expect(types).toContain('child.stop.intent');
    expect(types).not.toContain('segment.restart.initiated');
    expect(paused.checkpointArtifactHash).toBeDefined();
    expect(created).toHaveLength(1); // one spawn, never respawned
    expect(created[0]!.adapter.log.some((e) => e.op === 'close')).toBe(true);

    // The schedule agrees with the ETA honesty: a structured retry_after
    // anchors probe 1 to the provider's own reset; otherwise the ladder.
    const plan = service.getResumePlan(runId);
    expect(plan?.kind).toBe('probe_at');
    if (plan?.kind !== 'probe_at') return;
    if (c.resumesAt !== undefined) {
      expect(plan.at).toBe(c.resumesAt);
      expect(plan.rung).toBe(0); // ETA_ANCHORED_RUNG
    } else {
      expect(plan.rung).toBe(30); // pinned default ladder rung 1
    }
  });
});

// ---------------------------------------------------------------------------
// Agent-message TEXT never classifies — through a full service round
// ---------------------------------------------------------------------------
describe('W2-7: agent TEXT mentioning limits NEVER pauses a run (§9/§13)', () => {
  it('both profiles’ fixture texts stream through completed turns with zero limit machinery engaged', async () => {
    const { service, db } = await setup([
      [
        { updates: [{ kind: 'agent_message_chunk', text: CLAUDE_AGENT_TEXT_MENTIONING_LIMITS }] },
        { updates: [{ kind: 'agent_message_chunk', text: CODEX_AGENT_TEXT_MENTIONING_LIMITS }] },
      ],
    ]);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    await service.runCoordination(runId, promptTimesRunner(2));

    const st = service.status(runId);
    expect(st.phase).toBe('awaiting_approval');
    expect(st.suspension).toBe('none');
    const types = eventTypes(db, runId);
    expect(types).not.toContain('limit.classified.prompt_turn');
    expect(types).not.toContain('provider.error.unknown');
    expect(types).not.toContain('limit.incident.recorded');
    expect(types).not.toContain('child.stop.intent');
    expect(types.filter((t) => t === 'turn.completed')).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// T16 never feeds the breaker — across REPEATED incidents
// ---------------------------------------------------------------------------
describe('W2-7: repeated T16 incidents never count toward the breaker', () => {
  it('pause (T16) → resume (T9) → pause (T16) again: two incidents, zero restart counting, no breaker', async () => {
    const { service, db } = await setup([
      [{ errorEnvelope: unknownProviderErrorEnvelope() }],
      [{ errorEnvelope: unknownProviderErrorEnvelope() }],
    ]);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const first: unknown = await service
      .runRole(runId, promptTimesRunner(1), CLAUDE_LOW, '/ws')
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(first).toBeInstanceOf(LimitPausedError);
    expect((first as LimitPausedError).transitionId).toBe('T16');
    expect(service.resume(runId).status).toBe('applied');

    const second: unknown = await service
      .runRole(runId, promptTimesRunner(1), CLAUDE_LOW, '/ws')
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(second).toBeInstanceOf(LimitPausedError);
    expect((second as LimitPausedError).transitionId).toBe('T16');

    const st = service.status(runId);
    expect(st.suspension).toBe('paused_limit');
    expect(st.counters.restartsInWindow).toBe(0);
    expect(st.counters.lifetimeRestarts).toBe(0);
    const log = db.events.listByRun(runId);
    expect(log.filter((e) => e.type === 'limit.incident.recorded')).toHaveLength(2);
    expect(
      log
        .filter((e) => e.type === 'limit.incident.recorded')
        .every((e) => (e.payload as { incidentKind: string }).incidentKind === 'unknown'),
    ).toBe(true);
    expect(eventTypes(db, runId)).not.toContain('breaker.opened');
  });
});

// ---------------------------------------------------------------------------
// Child death mid-turn through the HONEST fake knob (T13, no classify override)
// ---------------------------------------------------------------------------
describe('W2-7: dieMidTurn — child death mid-turn interrupts via T13, never pauses, never respawns', () => {
  it('the transport-shaped unexpected_eof classifies crash → interrupted; manual resume routes T12', async () => {
    const { service, db } = await setup([
      [
        {
          updates: [{ kind: 'agent_message_chunk', text: 'partial work before the crash' }],
          dieMidTurn: true,
        },
      ],
    ]);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const error: unknown = await service
      .runCoordination(runId, promptTimesRunner(1))
      .then(() => undefined)
      .catch((e: unknown) => e);

    // The raw typed error propagates (typed unwind, not a pause).
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain('died mid-turn');
    const st = service.status(runId);
    expect(st.suspension).toBe('interrupted');
    expect(st.counters.restartsInWindow).toBe(1); // T13 folds counters...
    expect(st.counters.lifetimeRestarts).toBe(1);
    expect(st.activeChild).toMatchObject({ status: 'stopped' });
    const types = eventTypes(db, runId);
    expect(types).toContain('child.exited.unexpectedly');
    expect(types).not.toContain('limit.incident.recorded'); // never the limit path
    expect(types).not.toContain('segment.restart.initiated'); // ...but NEVER auto-respawns (P4a)

    // Manual resume is the eligibility-checked re-entry (T12).
    const resumed = service.resume(runId);
    expect(resumed.status).toBe('applied');
    if (resumed.status === 'applied') expect(resumed.transitionId).toBe('T12');
  });
});

// ---------------------------------------------------------------------------
// Generation race through the REAL ingest path (delayed stop + stale report)
// ---------------------------------------------------------------------------
describe('W2-7: a DELAYED stop from the pre-pause generation never clears the re-entered one', () => {
  it('delayed child.stopped folds to nothing; a stale T13 exit report is REJECTED; the new round completes', async () => {
    const { service, db } = await setup([
      limitOnTurnN(1), // generation 1: pauses on its first turn
      [{}], // generation 2: the re-entered round completes
    ]);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(runId, promptTimesRunner(1)).catch(() => undefined);
    expect(service.status(runId).suspension).toBe('paused_limit');

    const gen1 = (
      db.events.listByRun(runId).find((e) => e.type === 'child.spawn.initiated')?.payload as {
        generationId: string;
      }
    ).generationId;
    expect(service.resume(runId).status).toBe('applied'); // T9, pending re-entry

    // Re-enter the round; while generation 2 is ACTIVE, the pre-pause
    // generation's DELAYED stop (and a stale exit report) arrive through the
    // real ingest path — neither may touch the live generation.
    await service.runRole(
      runId,
      {
        role: 'coordinator',
        run: async (session) => {
          const before = service.status(session.runId);
          expect(before.childActive).toBe(true);
          const gen2 = before.activeChild!.generationId;
          expect(String(gen2)).not.toBe(gen1);

          const delayedStop = service.ingest(
            draftEvent({
              type: 'child.stopped',
              runId: session.runId,
              payload: { generationId: processGenerationId(gen1), reason: 'terminated' },
              idempotencyKey: idempotencyKey('w27_delayed_stop_1'),
              occurredAt: db.clock.nowIso(),
            }) as DomainEvent,
          );
          expect(delayedStop.status).toBe('recorded'); // durable fact, folds to nothing
          const afterStop = service.status(session.runId);
          expect(afterStop.activeChild).toMatchObject({ generationId: gen2, status: 'active' });
          expect(afterStop.suspension).toBe('none');

          // A stale generation-stamped exit report must not interrupt (T13's
          // generation_matches_active payload check → durable rejection).
          const staleExit = service.ingest(
            draftEvent({
              type: 'child.exited.unexpectedly',
              runId: session.runId,
              payload: {
                segmentId: before.activeChild!.segmentId,
                generationId: processGenerationId(gen1),
                exitCode: 1,
                classifiedAs: 'crash' as const,
              },
              idempotencyKey: idempotencyKey('w27_stale_exit_1'),
              occurredAt: db.clock.nowIso(),
            }) as DomainEvent,
          );
          expect(staleExit.status).toBe('rejected');
          const afterExit = service.status(session.runId);
          expect(afterExit.suspension).toBe('none');
          expect(afterExit.counters.restartsInWindow).toBe(0);
          expect(afterExit.activeChild).toMatchObject({ generationId: gen2, status: 'active' });

          await session.prompt({ prompt: 'finish the round' });
          return {};
        },
      },
      CLAUDE_LOW,
      '/ws',
      { round: 1, completionAdvance: { from: 'specifying', to: 'awaiting_approval' } },
    );
    service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');

    // The re-entered round completed and acked its pending re-entry; the
    // stale events changed nothing.
    const st = service.status(runId);
    expect(st.phase).toBe('awaiting_approval');
    expect(st.suspension).toBe('none');
    expect(st.resumeReentryPending).toBeUndefined();
    expect(eventTypes(db, runId)).toContain('resume_reentry.completed');
    expect(eventTypes(db, runId)).toContain('transition.rejected'); // the stale T13 report
  });
});

// ---------------------------------------------------------------------------
// T11 stop-confirmed ordering through the service
// ---------------------------------------------------------------------------
describe('W2-7: T11 pause completes only on the generation-matched stop confirmation', () => {
  it('pause() marks stopping (suspension STILL none); paused_user folds on child.stopped; T12 resumes', async () => {
    const { service, db } = await setup([[{}, {}]]);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    await service.runRole(
      runId,
      {
        role: 'coordinator',
        run: async (session) => {
          await session.prompt({ prompt: 'turn 1' });
          // Between turns (child ACTIVE, operation idle): the user pauses.
          const result = service.pause(session.runId);
          expect(result.status).toBe('applied');
          if (result.status === 'applied') expect(result.transitionId).toBe('T11');
          // Pause = stop-INTENT: the suspension has NOT folded yet.
          const st = service.status(session.runId);
          expect(st.suspension).toBe('none');
          expect(st.activeChild).toMatchObject({ status: 'stopping', stopCause: 'user_pause' });
          return {};
        },
      },
      CLAUDE_LOW,
      '/ws',
    );

    // The generation-matched confirmation (runRole's dispose path) folded
    // the deferred suspension — pause = intent → confirmed stop → paused.
    const st = service.status(runId);
    expect(st.suspension).toBe('paused_user');
    expect(st.uiState).toBe('stopped');
    expect(st.activeChild).toMatchObject({ status: 'stopped' });
    const types = eventTypes(db, runId);
    expect(types.indexOf('pause.user.requested')).toBeLessThan(types.indexOf('child.stopped'));
    expect(types).toContain('child.stop.intent');

    // T12 resumes from paused_user (eligibility-checked re-entry).
    const resumed = service.resume(runId);
    expect(resumed.status).toBe('applied');
    if (resumed.status === 'applied') expect(resumed.transitionId).toBe('T12');
    expect(service.status(runId).resumeReentryPending).toBeDefined();
  });
});
