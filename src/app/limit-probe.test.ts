/**
 * W2-4 durable schedule + probes, service level (spec
 * docs/specs/hardening-p4a.md §W2-4; PLAN §13) — offline tests against the
 * IN-PROCESS fake adapter and a manual clock:
 *
 *  - `runScheduledProbe` executes the pure scheduler's plan: `not_due`
 *    before the event-anchored deadline, fenced claim → throwaway probe
 *    session (SAME profile, SAME model/effort pins as the round it would
 *    resume) → exactly ONE outcome under the claim-derived key;
 *  - outcomes: OK → T9 `{mode:'scheduled_probe'}`; limit envelope → T10 +
 *    the next `limit.probe.scheduled` rung (or the exhaustion notify at the
 *    per-incident cap); ANY other failure → `limit.probe.inconclusive` —
 *    stays paused, automatic probing STOPS, no T10, never the breaker,
 *    manual resume remains;
 *  - claim fencing: a concurrent waiter cannot double-probe a rung; a
 *    crashed claimant's rung is adopted after the grace and still resolves
 *    to one logical outcome;
 *  - the probe is INVISIBLE to the engine state axes (no child/turn
 *    lifecycle events) and its usage folds into cost (§17.2);
 *  - retry_after incidents resume directly (`resume_now`) once the
 *    provider's own ETA elapses — including from a fresh process (anchoring).
 */
import { CLEAN_PINNED_WORKSPACE_GIT, createRunFixture } from './test-support.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../lib/clock.js';
import { acpSessionId, runId, type RunId } from '../domain/ids.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import {
  AdapterError,
  InProcessFakeAdapter,
  rateLimitErrorEnvelope,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../adapters/index.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { parseEngineConfig } from '../config/loader.js';
import { unwrap } from '../lib/result.js';
import {
  MaxLiveChildrenExceededError,
  type ProcessIdentitySample,
  type PsClient,
} from '../supervisor/index.js';
import { DurableSpawnReservationStore } from './spawn-reservation-store.js';
import type { EngineConfig } from '../config/schema.js';
import {
  DEFAULT_PROBE_ADOPT_AFTER_MS,
  ETA_ANCHORED_RUNG,
  deterministicJitterMs,
  incidentIdOf,
  latestIncidentEvent,
  probeClaimKey,
  probeOutcomeKey,
} from '../scheduler/limit-schedule.js';
import {
  LimitPausedError,
  OrchestrationService,
  PROBE_PROMPT,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from './service.js';
import type { RoleRunner } from './role-runner.js';
import type { Harness } from './model-resolution.js';

// ---------------------------------------------------------------------------
// Harness (pause-spine conventions + per-CREATION adapter scripting: the
// first created adapter is the paused role's, the second is the probe's)
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

interface FakeScript {
  readonly turns?: readonly InProcessTurnScript[];
  readonly onSetConfigOption?: (input: SetConfigOptionInput) => SetConfigOptionResult;
}

interface CreatedFake {
  readonly options: RoleAdapterOptions;
  readonly adapter: InProcessFakeAdapter;
}

/** Factory whose Nth created adapter takes the Nth script (last one reused). */
function makeQueueFactory(scripts: readonly FakeScript[]): {
  factory: RoleAdapterFactory;
  created: CreatedFake[];
} {
  const created: CreatedFake[] = [];
  const factory: RoleAdapterFactory = {
    create(options) {
      const script = scripts[Math.min(created.length, scripts.length - 1)] ?? {};
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: fakeConfigOptions(options.resolved.harness) },
        ...(script.turns !== undefined ? { turns: script.turns } : {}),
        ...(script.onSetConfigOption !== undefined
          ? { onSetConfigOption: script.onSetConfigOption }
          : {}),
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
const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;
/** DeterministicIdFactory mints run_000001 for the first run of every test. */
const RUN1 = runId('run_000001');
const RUNG1_MS = 30 * 60_000;
/** First unknown-ETA deadline offset from the incident: ladder[0] + jitter. */
const DEADLINE1_OFFSET_MS = RUNG1_MS + deterministicJitterMs(RUN1, 1, RUNG1_MS);

async function setup(
  scripts: readonly FakeScript[],
  config?: EngineConfig,
): Promise<{
  service: OrchestrationService;
  db: TestDatabaseHandle['db'];
  created: CreatedFake[];
  clock: ManualClock;
}> {
  const clock = new ManualClock(T0);
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false, clock });
  const db = handle.db;
  const { factory, created } = makeQueueFactory(scripts);
  const service = new OrchestrationService({
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
    db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    ...(config !== undefined ? { config } : {}),
  });
  return { service, db, created, clock };
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

/** Drive the run into `paused_limit` via a scripted limit turn (T4). */
async function pauseRun(
  service: OrchestrationService,
): Promise<RunId> {
  const { runId: id } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
  const error: unknown = await service
    .runCoordination(id, promptOnceRunner())
    .then(() => undefined)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(LimitPausedError);
  return id;
}

function eventTypes(db: TestDatabaseHandle['db'], id: RunId): string[] {
  return db.events.listByRun(id).map((e) => e.type);
}

function countType(db: TestDatabaseHandle['db'], id: RunId, type: string): number {
  return eventTypes(db, id).filter((t) => t === type).length;
}

const PAUSE_SCRIPT: FakeScript = { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] };
const AUTH_ENVELOPE = { code: -32603, message: 'auth', data: { errorKind: 'auth' } };

// ---------------------------------------------------------------------------
// Schedule answers (nothing probed)
// ---------------------------------------------------------------------------
describe('runScheduledProbe — schedule answers', () => {
  it('not_paused on a run without a limit pause', async () => {
    const { service } = await setup([PAUSE_SCRIPT]);
    const { runId: id } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    expect(await service.runScheduledProbe(id)).toEqual({ outcome: 'not_paused', suspension: 'none' });
  });

  it('not_due before the event-anchored first deadline: no claim, no probe adapter', async () => {
    const { service, db, created } = await setup([PAUSE_SCRIPT]);
    const id = await pauseRun(service);
    const result = await service.runScheduledProbe(id);
    expect(result.outcome).toBe('not_due');
    if (result.outcome !== 'not_due') return;
    expect(result.plan).toEqual({
      kind: 'probe_at',
      at: new Date(Date.parse(T0) + DEADLINE1_OFFSET_MS).toISOString(),
      rung: 30,
      probeIndex: 1,
    });
    expect(created).toHaveLength(1); // only the paused role's adapter — no probe spawn
    expect(eventTypes(db, id)).not.toContain('limit.probe.claimed');
  });
});

// ---------------------------------------------------------------------------
// Probe outcomes
// ---------------------------------------------------------------------------
describe('runScheduledProbe — still limited (T10 + next rung)', () => {
  it('claims the rung, probes on an identically-pinned throwaway session, folds T10, schedules the next rung', async () => {
    const { service, db, created, clock } = await setup([
      PAUSE_SCRIPT,
      { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }, // the probe: still limited
    ]);
    const id = await pauseRun(service);
    const spawnEventsBefore = countType(db, id, 'child.spawn.initiated');
    const turnEventsBefore = countType(db, id, 'turn.started');

    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);
    const result = await service.runScheduledProbe(id);
    expect(result.outcome).toBe('still_limited');
    if (result.outcome !== 'still_limited') return;
    expect(result.probeIndex).toBe(1);
    expect(result.nextPlan).toMatchObject({ kind: 'probe_at', probeIndex: 2, rung: 60 });

    // The durable trail: fenced claim → T10 (probe count folds) → the next
    // explicit schedule fact — in order.
    const types = eventTypes(db, id);
    const claimAt = types.indexOf('limit.probe.claimed');
    expect(claimAt).toBeGreaterThanOrEqual(0);
    expect(types.indexOf('limit.probe.still_limited')).toBeGreaterThan(claimAt);
    expect(types.indexOf('limit.probe.scheduled')).toBeGreaterThan(types.indexOf('limit.probe.still_limited'));
    const scheduled = db.events.listByRun(id).find((e) => e.type === 'limit.probe.scheduled');
    expect(scheduled?.payload).toMatchObject({ rung: 60, probeIndex: 2 });

    // The run REMAINS durably paused; the reducer folded the count ONLY.
    const st = service.status(id);
    expect(st.suspension).toBe('paused_limit');
    expect(st.counters.probeCount).toBe(1);
    expect(st.counters.restartsInWindow).toBe(0); // never the breaker

    // The probe ran on a FRESH throwaway session, SAME profile pinned to the
    // SAME model/effort as the paused round (the spec's deliberate deviation
    // from retain-the-candidate) — and was INVISIBLE to the engine axes.
    expect(created).toHaveLength(2);
    const probe = created[1]!;
    expect(probe.options.role).toBe('coordinator');
    expect(probe.options.resolved).toMatchObject({ harness: 'claude', model: 'opus', effort: 'low' });
    const pins = probe.adapter.log
      .filter((e) => e.op === 'setConfigOption')
      .map((e) => e.detail);
    expect(pins).toEqual([
      { optionId: 'model', value: 'opus' },
      { optionId: 'thinking', value: 'low' },
    ]);
    expect(probe.adapter.log.filter((e) => e.op === 'prompt')).toHaveLength(1);
    expect(probe.adapter.log.some((e) => e.op === 'close')).toBe(true);
    expect(countType(db, id, 'child.spawn.initiated')).toBe(spawnEventsBefore);
    expect(countType(db, id, 'turn.started')).toBe(turnEventsBefore);
  });

  it('exhaustion at the pinned per-incident cap: notify, permanent, manual resume remains', async () => {
    const pinned = unwrap(
      parseEngineConfig({ limitProbe: { ladderMinutes: [1], maxProbesPerIncident: 1 } }),
    );
    const { service, db, created, clock } = await setup(
      [PAUSE_SCRIPT, { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }],
      pinned,
    );
    const id = await pauseRun(service);
    clock.advanceMs(60_000 + deterministicJitterMs(RUN1, 1, 60_000) + 1000);

    const result = await service.runScheduledProbe(id);
    expect(result.outcome).toBe('still_limited');
    if (result.outcome !== 'still_limited') return;
    expect(result.nextPlan).toEqual({
      kind: 'ladder_exhausted',
      reason: 'probe_cap',
      probesUsed: 1,
      maxProbesPerIncident: 1,
    });
    const notifies = db.events.listByRun(id).filter((e) => e.type === 'notify.requested');
    expect(String((notifies[notifies.length - 1]?.payload as { message?: string }).message)).toMatch(
      /ladder exhausted/i,
    );

    // Permanent: no further automatic probe, however much time passes.
    clock.advanceMs(365 * 24 * 60 * 60_000);
    const after = await service.runScheduledProbe(id);
    expect(after.outcome).toBe('ladder_exhausted');
    expect(created).toHaveLength(2); // no third adapter — probing is over

    // Manual resume is ALWAYS available (§13).
    const resumed = service.resume(id);
    expect(resumed.status).toBe('applied');
    if (resumed.status === 'applied') expect(resumed.transitionId).toBe('T9');
  });
});

describe('runScheduledProbe — OK (T9, mode scheduled_probe)', () => {
  it('a healthy probe resumes the run: T9 applied, re-entry pending, probe count reset, usage folded into cost', async () => {
    const { service, db, created, clock } = await setup([
      PAUSE_SCRIPT,
      {
        turns: [
          {
            result: {
              stopReason: 'end_turn',
              usage: { inputTokens: 7, outputTokens: 3, costUsd: 0.01, source: 'adapter' },
            },
          },
        ],
      },
    ]);
    const id = await pauseRun(service);
    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);

    const result = await service.runScheduledProbe(id);
    expect(result).toEqual({ outcome: 'resumed', probeIndex: 1 });

    const st = service.status(id);
    expect(st.suspension).toBe('none');
    expect(st.phase).toBe('specifying'); // return_phase honored (T9)
    expect(st.counters.probeCount).toBe(0);
    expect(st.resumeReentryPending).toMatchObject({ mode: 'scheduled_probe', returnPhase: 'specifying' });
    expect(st.childActive).toBe(false); // T9 never marks a child active (W2-1)

    const log = db.events.listByRun(id);
    const t9 = log.find((e) => e.type === 'resume.limit.requested');
    expect(t9?.payload).toEqual({ mode: 'scheduled_probe' });
    // The outcome is keyed by the claim fence.
    const incident = latestIncidentEvent(log)!;
    expect(t9?.idempotencyKey).toBe(probeOutcomeKey(probeClaimKey(incidentIdOf(incident), 1)));

    // The probe's minimal prompt (the cheapest no-op turn, §13) + its usage
    // folded into cost (§17.2).
    const probe = created[1]!;
    const promptOps = probe.adapter.log.filter((e) => e.op === 'prompt');
    expect(promptOps).toHaveLength(1);
    expect((promptOps[0]?.detail as { prompt?: string }).prompt).toBe(PROBE_PROMPT);
    expect(st.cost.totalCostUsd).toBeCloseTo(0.01, 10);
  });

  it('a duplicate T10 under the already-used probe-outcome key DEDUPES: probeCount stays 1, ONE T10 in the log, never a fresh applied', async () => {
    const { service, db, clock } = await setup([
      PAUSE_SCRIPT,
      { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }, // the probe: still limited
    ]);
    const id = await pauseRun(service);
    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);
    const result = await service.runScheduledProbe(id);
    expect(result.outcome).toBe('still_limited');
    expect(service.status(id).counters.probeCount).toBe(1);

    // The P4a R-B defect: replay the SAME T10 under the SAME outcome key (a
    // crashed waiter re-delivering its outcome append). §6.1 "duplicate
    // insert = one logical event" — the projection must NOT double-increment
    // and the caller must see the dedupe, not a fresh 'applied'.
    const incident = latestIncidentEvent(db.events.listByRun(id))!;
    const outcomeKey = probeOutcomeKey(probeClaimKey(incidentIdOf(incident), 1));
    const replay = service.ingest(
      draftEvent({
        type: 'limit.probe.still_limited',
        runId: id,
        payload: {
          classification: {
            kind: 'usage_limit',
            provider: 'claude',
            source: 'structured',
            confidence: 'high',
            detectionTier: 'structured',
          },
        },
        idempotencyKey: outcomeKey,
        occurredAt: db.clock.nowIso(),
      }) as DomainEvent,
    );
    expect(replay.status).toBe('deduped');
    expect(countType(db, id, 'limit.probe.still_limited')).toBe(1); // the log was already right...
    expect(service.status(id).counters.probeCount).toBe(1); // ...and the projection now agrees
    // recover() (§12.3 replay) and the live projection tell the same story.
    expect(service.recover(id).counters.probeCount).toBe(1);
  });
});

describe('runScheduledProbe — inconclusive (automatic probing STOPS)', () => {
  it('an auth-failing probe appends limit.probe.inconclusive: stays paused, no T10, never the breaker, probing stops', async () => {
    const { service, db, created, clock } = await setup([
      PAUSE_SCRIPT,
      { turns: [{ errorEnvelope: AUTH_ENVELOPE }] },
    ]);
    const id = await pauseRun(service);
    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);

    const result = await service.runScheduledProbe(id);
    expect(result).toMatchObject({ outcome: 'inconclusive', probeIndex: 1, classifiedKind: 'auth' });

    const st = service.status(id);
    expect(st.suspension).toBe('paused_limit'); // stays paused
    expect(st.counters.probeCount).toBe(0); // NO T10 increment
    expect(st.counters.restartsInWindow).toBe(0); // never the breaker
    expect(st.counters.lifetimeRestarts).toBe(0);
    const types = eventTypes(db, id);
    expect(types).not.toContain('limit.probe.still_limited');
    expect(types).not.toContain('breaker.opened');
    const inconclusive = db.events.listByRun(id).find((e) => e.type === 'limit.probe.inconclusive');
    expect(inconclusive?.payload).toMatchObject({ classifiedKind: 'auth', probeIndex: 1 });
    // Conformance: legal under paused_limit as a SUPPORTING event — no T16.
    expect(countType(db, id, 'provider.error.unknown')).toBe(0);

    // Automatic probing has STOPPED — permanently for the incident.
    clock.advanceMs(24 * 60 * 60_000);
    const after = await service.runScheduledProbe(id);
    expect(after.outcome).toBe('ladder_exhausted');
    if (after.outcome === 'ladder_exhausted') expect(after.plan.reason).toBe('inconclusive');
    expect(created).toHaveLength(2); // no new probe adapter

    // Manual resume remains available.
    const resumed = service.resume(id);
    expect(resumed.status).toBe('applied');
  });

  it('a probe PIN failure is inconclusive too — and the probe never takes the W1-F8 pin retry', async () => {
    let modelPinAttempts = 0;
    const { service, db, clock } = await setup([
      PAUSE_SCRIPT,
      {
        onSetConfigOption: (input) => {
          if (input.optionId === 'model') {
            modelPinAttempts += 1;
            throw new AdapterError('invalid_argument', 'scripted probe pin rejection');
          }
          return { effectiveValue: input.value, echoed: true };
        },
      },
    ]);
    const id = await pauseRun(service);
    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);

    const result = await service.runScheduledProbe(id);
    expect(result).toMatchObject({ outcome: 'inconclusive', classifiedKind: 'unknown_provider_error' });
    expect(modelPinAttempts).toBe(1); // no retry — the probe IS the retry
    expect(eventTypes(db, id)).toContain('limit.probe.inconclusive');
    expect(service.status(id).suspension).toBe('paused_limit');
  });

  it('§17.1: a provider message leaking an sk-style key into a probe failure is REDACTED in the durable detail and the outcome consumers read', async () => {
    // A deliberately FAKE key fragment shaped like a real sk- credential
    // (mirrors src/redaction/fixtures.ts — never a live secret).
    const FAKE_KEY = 'sk-ant-api03-FAKE1234567890abcdef';
    const { service, db, clock } = await setup([
      PAUSE_SCRIPT,
      {
        onSetConfigOption: (input) => {
          if (input.optionId === 'model') {
            // The real transport embeds the provider envelope message into
            // AdapterError.message (adapters/acp/transport.ts) — this is
            // that shape, with the message echoing request credentials.
            throw new AdapterError(
              'invalid_argument',
              `setConfigOption failed: model pin rejected (request used api key ${FAKE_KEY})`,
            );
          }
          return { effectiveValue: input.value, echoed: true };
        },
      },
    ]);
    const id = await pauseRun(service);
    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);

    const result = await service.runScheduledProbe(id);
    expect(result.outcome).toBe('inconclusive');
    if (result.outcome !== 'inconclusive') return;

    // (a) the durable event payload, read back from the DB, is redacted;
    const inconclusive = db.events.listByRun(id).find((e) => e.type === 'limit.probe.inconclusive');
    const payload = inconclusive?.payload as { detail: string };
    expect(payload.detail).toContain('[REDACTED:api_key]');
    expect(payload.detail).not.toContain(FAKE_KEY);
    expect(payload.detail).toContain('invalid_argument'); // non-secret context survives

    // ...and the outcome detail every consumer (CLI text, status --json)
    // prints is the SAME redacted string — redaction happened at the source.
    expect(result.detail).toBe(payload.detail);
    expect(result.detail).not.toContain(FAKE_KEY);
  });
});

// ---------------------------------------------------------------------------
// Claim fencing (pushback item 4)
// ---------------------------------------------------------------------------
describe('runScheduledProbe — fenced probe claims', () => {
  it('a concurrent waiter cannot double-probe a rung: one claim, one probe, one outcome', async () => {
    const { service, db, created, clock } = await setup([
      PAUSE_SCRIPT,
      { turns: [{ permission: {} }] }, // the probe turn HOLDS until released
    ]);
    const id = await pauseRun(service);
    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);

    // Waiter A claims and starts probing (its prompt is held open).
    const a = service.runScheduledProbe(id);
    await new Promise((resolve) => setImmediate(resolve)); // let A reach the held prompt
    expect(created).toHaveLength(2);
    expect(countType(db, id, 'limit.probe.claimed')).toBe(1);

    // Waiter B: the claim append dedupes and the probe is locally in flight.
    const b = await service.runScheduledProbe(id);
    expect(b).toEqual({ outcome: 'claim_in_flight', probeIndex: 1 });
    expect(created).toHaveLength(2); // B spawned NOTHING

    // Release A's held probe turn → it completes as OK → T9.
    const probeAdapter = created[1]!.adapter;
    const sessionDetail = probeAdapter.log.find((e) => e.op === 'createSession')?.detail as {
      acpSessionId: string;
    };
    probeAdapter.forceCompleteTurn(acpSessionId(sessionDetail.acpSessionId));
    expect(await a).toEqual({ outcome: 'resumed', probeIndex: 1 });

    // Exactly one claim and one outcome landed.
    expect(countType(db, id, 'limit.probe.claimed')).toBe(1);
    expect(countType(db, id, 'resume.limit.requested')).toBe(1);
  });

  it('a crashed claimant’s rung is presumed live within the grace, then ADOPTED — one logical outcome', async () => {
    const { service, db, created, clock } = await setup([
      PAUSE_SCRIPT,
      { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] },
    ]);
    const id = await pauseRun(service);
    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);

    // Simulate a claimant that died right after committing its claim: the
    // durable claim exists, no outcome, no local in-flight marker.
    const incident = latestIncidentEvent(db.events.listByRun(id))!;
    const incidentId = incidentIdOf(incident);
    const claimKey = probeClaimKey(incidentId, 1);
    service.ingest(
      draftEvent({
        type: 'limit.probe.claimed',
        runId: id,
        payload: { incidentId, probeIndex: 1 },
        idempotencyKey: claimKey,
        occurredAt: db.clock.nowIso(),
      }) as DomainEvent,
    );

    // Within the grace the claimant is presumed live: no probe.
    const young = await service.runScheduledProbe(id);
    expect(young).toEqual({ outcome: 'claim_in_flight', probeIndex: 1 });
    expect(created).toHaveLength(1);

    // Past the grace the claim is adopted and the SAME fence keys the outcome.
    clock.advanceMs(DEFAULT_PROBE_ADOPT_AFTER_MS + 1000);
    const adopted = await service.runScheduledProbe(id);
    expect(adopted.outcome).toBe('still_limited');
    expect(countType(db, id, 'limit.probe.claimed')).toBe(1); // still one logical claim
    const t10 = db.events.listByRun(id).find((e) => e.type === 'limit.probe.still_limited');
    expect(t10?.idempotencyKey).toBe(probeOutcomeKey(claimKey));
    expect(service.status(id).counters.probeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// retry_after incidents — the provider's own ETA, event-anchored
// ---------------------------------------------------------------------------
describe('runScheduledProbe — structured retry_after', () => {
  const RESUMES_AT = '2026-07-18T00:45:00.000Z';
  const ETA_SCRIPT: FakeScript = {
    turns: [{ errorEnvelope: rateLimitErrorEnvelope({ resumesAt: RESUMES_AT }) }],
  };

  it('waits until the provider’s own reset time, then answers resume_now — no probe consumed', async () => {
    const { service, db, created, clock } = await setup([ETA_SCRIPT]);
    const id = await pauseRun(service);

    expect(service.getResumePlan(id)).toEqual({
      kind: 'probe_at',
      at: RESUMES_AT,
      rung: ETA_ANCHORED_RUNG,
      probeIndex: 1,
    });
    const before = await service.runScheduledProbe(id);
    expect(before.outcome).toBe('not_due');

    clock.advanceMs(46 * 60_000);
    const after = await service.runScheduledProbe(id);
    expect(after).toEqual({
      outcome: 'resume_now',
      plan: { kind: 'resume_now', resumesAt: RESUMES_AT },
    });
    expect(created).toHaveLength(1); // no probe spawn, no claim
    expect(eventTypes(db, id)).not.toContain('limit.probe.claimed');
  });

  it('a FRESH process long after the ETA computes resume_now from the log alone (never re-anchored)', async () => {
    const { service, db } = await setup([ETA_SCRIPT]);
    const id = await pauseRun(service);

    // "Restart": a new service over the same store, hours later.
    (db.clock as ManualClock).advanceMs(6 * 60 * 60_000);
    const successor = new OrchestrationService({
      workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
      db,
      ids: new DeterministicIdFactory(),
      adapterFactory: {
        create: () => {
          throw new Error('plan computation must not spawn adapters');
        },
      },
    });
    expect(successor.getResumePlan(id)).toEqual({ kind: 'resume_now', resumesAt: RESUMES_AT });
  });
});

// ---------------------------------------------------------------------------
// F8 (external review 6): the limit-probe spawn is a REAL child process and
// MUST pass the SAME concurrency admission guard (#admitSpawn) as a role spawn
// — reserve a slot before spawn (refusing with MaxLiveChildrenExceededError
// when maxLiveChildren is at the cap, rather than exceeding it), and release
// it in `finally` on every exit path. Before the fix the probe path bypassed
// admission entirely, so probes could exceed the global cap.
//
// Deterministic: an injected fake `ps` (identity + liveness) so a seeded
// durable reservation owned by a LIVE peer counts against the global cap,
// exactly like #admitSpawn's cross-process tally.
// ---------------------------------------------------------------------------
const PROBE_STILL_LIMITED: FakeScript = { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] };
const PROBE_SELF_PID = 90_000;

interface FakePs {
  readonly client: PsClient;
  readonly alive: Set<number>;
}

function makeFakePs(): FakePs {
  const alive = new Set<number>([PROBE_SELF_PID]);
  const sample = (pid: number): ProcessIdentitySample => ({
    pid,
    ppid: 1,
    pgid: pid,
    startedAt: `lstart-${pid}`,
    executablePath: '/fake/agent',
  });
  return {
    alive,
    client: {
      sampleProcessTree: (pgid) => ({
        pgid,
        rssBytes: 0,
        processCount: 1,
        pids: [pgid],
        sampledAt: isoTimestamp('2026-07-19T00:00:00.000Z'),
      }),
      sampleIdentity: (pid) => (alive.has(pid) ? sample(pid) : undefined),
      isAlive: (pid) => alive.has(pid),
    },
  };
}

async function setupWithPs(
  scripts: readonly FakeScript[],
  config: EngineConfig,
): Promise<{
  service: OrchestrationService;
  db: TestDatabaseHandle['db'];
  created: CreatedFake[];
  clock: ManualClock;
  ps: FakePs;
  seedLiveReservation: (generationId: string, ownerPid: number) => void;
}> {
  const clock = new ManualClock(T0);
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false, clock });
  const db = handle.db;
  const { factory, created } = makeQueueFactory(scripts);
  const ps = makeFakePs();
  const service = new OrchestrationService({
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
    db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    config,
    supervision: {
      ps: ps.client,
      selfPid: PROBE_SELF_PID,
      sendSignal: () => undefined,
      envNonce: { verifyNonce: () => 'match' },
    },
  });
  const seedLiveReservation = (generationId: string, ownerPid: number): void => {
    ps.alive.add(ownerPid);
    new DurableSpawnReservationStore(db).reserveWithin({
      generationId,
      ownerPid,
      ownerStartedAt: `lstart-${ownerPid}`,
      reservedAt: clock.nowIso(),
    });
  };
  return { service, db, created, clock, ps, seedLiveReservation };
}

describe('runScheduledProbe — F8 concurrency admission (maxLiveChildren)', () => {
  it('refuses a due probe when maxLiveChildren is at the cap (never exceeds it), spawning nothing and leaking no reservation', async () => {
    const cap1 = unwrap(parseEngineConfig({ maxLiveChildren: 1 }));
    const { service, db, created, clock, seedLiveReservation } = await setupWithPs(
      [PAUSE_SCRIPT, PROBE_STILL_LIMITED],
      cap1,
    );
    const id = await pauseRun(service);
    // The paused role's spawn admitted then released its slot on the pause path.
    expect(new DurableSpawnReservationStore(db).list()).toHaveLength(0);
    expect(created).toHaveLength(1); // only the paused role's adapter so far

    // A live peer now holds the ONLY slot (cap=1) via a durable reservation.
    seedLiveReservation('gen-live-peer', 90_001);

    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);
    const refusal: unknown = await service
      .runScheduledProbe(id)
      .then(() => undefined)
      .catch((e: unknown) => e);

    // The probe was REFUSED admission — it did not exceed the cap.
    expect(refusal).toBeInstanceOf(MaxLiveChildrenExceededError);
    expect((refusal as MaxLiveChildrenExceededError).max).toBe(1);
    // Admission precedes adapter/resource creation → no probe adapter spawned.
    expect(created).toHaveLength(1);
    // No probe reservation leaked — only the seeded live peer remains.
    expect(new DurableSpawnReservationStore(db).list().map((r) => r.generationId)).toEqual([
      'gen-live-peer',
    ]);
  });

  it('admits a probe when a slot is free and RELEASES it afterward, so the slot is reusable', async () => {
    // cap=1, ladder of two rungs so a second probe can be scheduled.
    const cap1 = unwrap(
      parseEngineConfig({ maxLiveChildren: 1, limitProbe: { ladderMinutes: [30, 60] } }),
    );
    const { service, db, created, clock, seedLiveReservation } = await setupWithPs(
      [PAUSE_SCRIPT, PROBE_STILL_LIMITED],
      cap1,
    );
    const id = await pauseRun(service);

    // Probe #1 admits the only slot (nothing else live), runs, and releases.
    clock.advanceMs(DEADLINE1_OFFSET_MS + 1000);
    const first = await service.runScheduledProbe(id);
    expect(first.outcome).toBe('still_limited');
    expect(created).toHaveLength(2); // the probe DID spawn
    // The slot is free again — the probe released its reservation in `finally`.
    expect(new DurableSpawnReservationStore(db).list()).toHaveLength(0);

    // Occupy the freed slot with a live peer, then advance to rung 2's probe:
    // it is now refused — proving admission is enforced per probe, not once.
    seedLiveReservation('gen-live-peer', 90_002);
    const plan2 = service.getResumePlan(id);
    expect(plan2?.kind).toBe('probe_at');
    if (plan2?.kind !== 'probe_at') return;
    clock.advanceMs(Date.parse(plan2.at) - Date.parse(clock.nowIso()) + 1000);
    const refusal: unknown = await service
      .runScheduledProbe(id)
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(MaxLiveChildrenExceededError);
    expect(created).toHaveLength(2); // rung-2 probe spawned nothing
  });
});
