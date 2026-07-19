/**
 * W2-4 pure scheduler unit tests (spec docs/specs/hardening-p4a.md §W2-4;
 * PLAN §13): anchoring (deadlines from EVENT timestamps, never re-anchored
 * to `now` on restart), determinism (identical inputs → identical plans;
 * jitter from a (runId, probeIndex) hash), per-incident exhaustion
 * (`maxProbesPerIncident`, permanent), the config-pinned ladder, the
 * inconclusive stop, and the claim-fence decision.
 */
import { describe, expect, it } from 'vitest';
import { isoTimestamp, type IsoTimestamp } from '../lib/clock.js';
import {
  eventSequence,
  idempotencyKey,
  limitIncidentId,
  runId,
  type LimitIncidentId,
} from '../domain/ids.js';
import { draftEvent, type DomainEvent, type EventOfType } from '../domain/events.js';
import { parseEngineConfig } from '../config/loader.js';
import { unwrap } from '../lib/result.js';
import type { EngineConfig } from '../config/schema.js';
import {
  DEFAULT_PROBE_ADOPT_AFTER_MS,
  ETA_ANCHORED_RUNG,
  JITTER_CAP_MS,
  collectIncidentProbeState,
  computeResumePlan,
  decideClaim,
  deterministicJitterMs,
  incidentIdOf,
  latestIncidentEvent,
  probeClaimKey,
  probeOutcomeKey,
  probeScheduleKey,
} from './limit-schedule.js';

const RUN = runId('run_sched_1');
const T0 = '2026-07-18T00:00:00.000Z';
const CONFIG: EngineConfig = unwrap(parseEngineConfig({}));
const MINUTE_MS = 60_000;

function at(iso: string): IsoTimestamp {
  return isoTimestamp(iso);
}

function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString();
}

function incidentEvent(opts?: {
  readonly resumesAt?: string;
  readonly sequence?: number;
  readonly occurredAt?: string;
  readonly incidentId?: LimitIncidentId;
}): EventOfType<'limit.incident.recorded'> {
  const sequence = opts?.sequence ?? 10;
  return draftEvent({
    type: 'limit.incident.recorded',
    runId: RUN,
    payload: {
      provider: 'claude',
      incidentKind: 'usage_limit',
      detectionTier: 'structured',
      etaSource: opts?.resumesAt !== undefined ? 'retry_after' : 'unknown',
      ...(opts?.resumesAt !== undefined ? { resumesAt: at(opts.resumesAt) } : {}),
      ...(opts?.incidentId !== undefined ? { incidentId: opts.incidentId } : {}),
    },
    idempotencyKey: idempotencyKey(`inc_${sequence}`),
    occurredAt: at(opts?.occurredAt ?? T0),
    sequence: eventSequence(sequence),
  });
}

function stillLimitedEvent(sequence: number, occurredAt: string): DomainEvent {
  return draftEvent({
    type: 'limit.probe.still_limited',
    runId: RUN,
    payload: {},
    idempotencyKey: idempotencyKey(`t10_${sequence}`),
    occurredAt: at(occurredAt),
    sequence: eventSequence(sequence),
  }) as DomainEvent;
}

function claimedEvent(
  incidentId: LimitIncidentId,
  probeIndex: number,
  sequence: number,
  occurredAt: string,
): DomainEvent {
  return draftEvent({
    type: 'limit.probe.claimed',
    runId: RUN,
    payload: { incidentId, probeIndex },
    idempotencyKey: probeClaimKey(incidentId, probeIndex),
    occurredAt: at(occurredAt),
    sequence: eventSequence(sequence),
  }) as DomainEvent;
}

function inconclusiveEvent(sequence: number, occurredAt: string): DomainEvent {
  return draftEvent({
    type: 'limit.probe.inconclusive',
    runId: RUN,
    payload: { classifiedKind: 'auth', detail: 'scripted auth failure' },
    idempotencyKey: idempotencyKey(`inconclusive_${sequence}`),
    occurredAt: at(occurredAt),
    sequence: eventSequence(sequence),
  }) as DomainEvent;
}

// ---------------------------------------------------------------------------
// Anchoring — deadlines from EVENT timestamps, never now-relative
// ---------------------------------------------------------------------------
describe('computeResumePlan — anchoring (pushback item 3)', () => {
  it('anchors the FIRST unknown-ETA probe to the incident event: incident + ladder[0] + jitter', () => {
    const incident = incidentEvent();
    const plan = computeResumePlan(incident, [], CONFIG, at(T0));
    expect(plan.kind).toBe('probe_at');
    if (plan.kind !== 'probe_at') return;
    expect(plan.probeIndex).toBe(1);
    expect(plan.rung).toBe(30); // default ladder rung 1
    const rungMs = 30 * MINUTE_MS;
    expect(plan.at).toBe(at(plus(T0, rungMs + deterministicJitterMs(RUN, 1, rungMs))));
  });

  it('a restart long after the deadline computes the SAME deadline — never re-anchored to now', () => {
    const incident = incidentEvent();
    const early = computeResumePlan(incident, [], CONFIG, at(T0));
    const lateNow = at(plus(T0, 10 * 60 * MINUTE_MS)); // 10h of downtime
    const late = computeResumePlan(incident, [], CONFIG, lateNow);
    expect(late).toEqual(early); // identical plan; `at` is now in the past → probe immediately
    if (late.kind === 'probe_at') expect(Date.parse(late.at)).toBeLessThan(Date.parse(lateNow));
  });

  it('anchors each subsequent rung to the latest T10 timestamp', () => {
    const incident = incidentEvent();
    const t10At = plus(T0, 31 * MINUTE_MS);
    const plan = computeResumePlan(incident, [stillLimitedEvent(20, t10At)], CONFIG, at(t10At));
    expect(plan.kind).toBe('probe_at');
    if (plan.kind !== 'probe_at') return;
    expect(plan.probeIndex).toBe(2);
    expect(plan.rung).toBe(60); // default ladder rung 2
    const rungMs = 60 * MINUTE_MS;
    expect(plan.at).toBe(at(plus(t10At, rungMs + deterministicJitterMs(RUN, 2, rungMs))));
  });

  it('a structured retry_after in the FUTURE schedules probe 1 at the provider’s own reset time, no jitter', () => {
    const resumesAt = plus(T0, 45 * MINUTE_MS);
    const incident = incidentEvent({ resumesAt });
    const plan = computeResumePlan(incident, [], CONFIG, at(T0));
    expect(plan).toEqual({
      kind: 'probe_at',
      at: at(resumesAt),
      rung: ETA_ANCHORED_RUNG,
      probeIndex: 1,
    });
  });

  it('an ELAPSED structured retry_after → resume_now (restart after the ETA lands here directly)', () => {
    const resumesAt = plus(T0, 45 * MINUTE_MS);
    const incident = incidentEvent({ resumesAt });
    const plan = computeResumePlan(incident, [], CONFIG, at(plus(T0, 46 * MINUTE_MS)));
    expect(plan).toEqual({ kind: 'resume_now', resumesAt: at(resumesAt) });
  });

  it('once ANY probe concluded still-limited, the provider’s retry_after is spent — the ladder governs', () => {
    const resumesAt = plus(T0, 45 * MINUTE_MS);
    const incident = incidentEvent({ resumesAt });
    const t10At = plus(T0, 46 * MINUTE_MS);
    const plan = computeResumePlan(
      incident,
      [stillLimitedEvent(20, t10At)],
      CONFIG,
      at(plus(T0, 47 * MINUTE_MS)),
    );
    expect(plan.kind).toBe('probe_at');
    if (plan.kind !== 'probe_at') return;
    expect(plan.probeIndex).toBe(2);
    expect(plan.rung).toBe(60); // ladder, anchored at the T10 — resumesAt is ignored
    const rungMs = 60 * MINUTE_MS;
    expect(plan.at).toBe(at(plus(t10At, rungMs + deterministicJitterMs(RUN, 2, rungMs))));
  });
});

// ---------------------------------------------------------------------------
// Determinism — identical inputs, identical plans; hash-derived jitter
// ---------------------------------------------------------------------------
describe('computeResumePlan — determinism (no Math.random anywhere)', () => {
  it('identical inputs produce identical plans', () => {
    const incident = incidentEvent();
    const events = [stillLimitedEvent(20, plus(T0, 30 * MINUTE_MS))];
    const a = computeResumePlan(incident, events, CONFIG, at(T0));
    const b = computeResumePlan(incident, events, CONFIG, at(T0));
    expect(a).toEqual(b);
  });

  it('jitter is a stable (runId, probeIndex) hash, bounded by min(rung/10, JITTER_CAP_MS)', () => {
    const rungMs = 30 * MINUTE_MS;
    const first = deterministicJitterMs(RUN, 1, rungMs);
    expect(deterministicJitterMs(RUN, 1, rungMs)).toBe(first); // stable
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThanOrEqual(rungMs / 10);

    // A 240m rung would allow 24m of 10% jitter — the absolute cap holds it.
    const bigRung = 240 * MINUTE_MS;
    expect(deterministicJitterMs(RUN, 5, bigRung)).toBeLessThanOrEqual(JITTER_CAP_MS);

    // Different probe indexes de-synchronize (deterministically).
    const spread = new Set([1, 2, 3, 4, 5, 6].map((i) => deterministicJitterMs(RUN, i, rungMs)));
    expect(spread.size).toBeGreaterThan(1);
    // And a different run hashes differently for at least one index.
    const other = runId('run_sched_2');
    const differs = [1, 2, 3, 4, 5, 6].some(
      (i) => deterministicJitterMs(other, i, rungMs) !== deterministicJitterMs(RUN, i, rungMs),
    );
    expect(differs).toBe(true);
  });

  it('claim/outcome/schedule keys are deterministic and distinct per probe index', () => {
    const incidentId = limitIncidentId('li_x');
    expect(probeClaimKey(incidentId, 1)).toBe(probeClaimKey(incidentId, 1));
    expect(probeClaimKey(incidentId, 1)).not.toBe(probeClaimKey(incidentId, 2));
    expect(probeOutcomeKey(probeClaimKey(incidentId, 1))).not.toBe(probeClaimKey(incidentId, 1));
    expect(probeScheduleKey(incidentId, 2)).not.toBe(probeClaimKey(incidentId, 2));
  });

  it('incidentIdOf honors a payload id and otherwise derives a stable id from run + sequence', () => {
    const explicit = incidentEvent({ incidentId: limitIncidentId('li_explicit') });
    expect(incidentIdOf(explicit)).toBe('li_explicit');
    const derived = incidentEvent({ sequence: 42 });
    expect(incidentIdOf(derived)).toBe(`li_${RUN}_seq42`);
    expect(incidentIdOf(derived)).toBe(incidentIdOf(incidentEvent({ sequence: 42 })));
  });
});

// ---------------------------------------------------------------------------
// Exhaustion — per-incident cap, PERMANENT (no sliding window)
// ---------------------------------------------------------------------------
describe('computeResumePlan — per-incident exhaustion (maxProbesPerIncident)', () => {
  function nStillLimited(n: number): DomainEvent[] {
    return Array.from({ length: n }, (_, i) =>
      stillLimitedEvent(20 + i, plus(T0, (30 + i) * MINUTE_MS)),
    );
  }

  it('the default cap (6) exhausts after 6 still-limited probes — permanently', () => {
    const incident = incidentEvent();
    const exhausted = computeResumePlan(incident, nStillLimited(6), CONFIG, at(T0));
    expect(exhausted).toEqual({
      kind: 'ladder_exhausted',
      reason: 'probe_cap',
      probesUsed: 6,
      maxProbesPerIncident: 6,
    });
    // No sliding window: a year later the incident is STILL exhausted.
    const muchLater = at(plus(T0, 365 * 24 * 60 * MINUTE_MS));
    expect(computeResumePlan(incident, nStillLimited(6), CONFIG, muchLater)).toEqual(exhausted);
  });

  it('the ladder saturates at its last rung until the cap', () => {
    const incident = incidentEvent();
    const plan = computeResumePlan(incident, nStillLimited(4), CONFIG, at(T0));
    expect(plan.kind).toBe('probe_at');
    if (plan.kind !== 'probe_at') return;
    expect(plan.probeIndex).toBe(5);
    expect(plan.rung).toBe(240); // default ladder [30, 60, 120, 240] — stays at 240
  });
});

// ---------------------------------------------------------------------------
// Config-pinned ladder — the run's PINNED config, never process defaults
// ---------------------------------------------------------------------------
describe('computeResumePlan — ladder and cap from the pinned per-run config', () => {
  const pinned: EngineConfig = unwrap(
    parseEngineConfig({ limitProbe: { ladderMinutes: [5, 7], maxProbesPerIncident: 3 } }),
  );

  it('uses the pinned rungs (5m, 7m, 7m) and the pinned cap (3)', () => {
    const incident = incidentEvent();
    const p1 = computeResumePlan(incident, [], pinned, at(T0));
    expect(p1).toMatchObject({ kind: 'probe_at', probeIndex: 1, rung: 5 });

    const t10s = [stillLimitedEvent(20, plus(T0, 6 * MINUTE_MS))];
    const p2 = computeResumePlan(incident, t10s, pinned, at(T0));
    expect(p2).toMatchObject({ kind: 'probe_at', probeIndex: 2, rung: 7 });

    t10s.push(stillLimitedEvent(21, plus(T0, 14 * MINUTE_MS)));
    const p3 = computeResumePlan(incident, t10s, pinned, at(T0));
    expect(p3).toMatchObject({ kind: 'probe_at', probeIndex: 3, rung: 7 }); // saturated

    t10s.push(stillLimitedEvent(22, plus(T0, 22 * MINUTE_MS)));
    expect(computeResumePlan(incident, t10s, pinned, at(T0))).toEqual({
      kind: 'ladder_exhausted',
      reason: 'probe_cap',
      probesUsed: 3,
      maxProbesPerIncident: 3,
    });
  });
});

// ---------------------------------------------------------------------------
// Inconclusive — automatic probing STOPS; manual resume remains
// ---------------------------------------------------------------------------
describe('computeResumePlan — inconclusive probes stop the schedule', () => {
  it('any limit.probe.inconclusive after the incident halts automatic probing', () => {
    const incident = incidentEvent();
    const plan = computeResumePlan(
      incident,
      [inconclusiveEvent(20, plus(T0, 31 * MINUTE_MS))],
      CONFIG,
      at(T0),
    );
    expect(plan).toEqual({
      kind: 'ladder_exhausted',
      reason: 'inconclusive',
      probesUsed: 0,
      maxProbesPerIncident: 6,
    });
  });

  it('an inconclusive halts the schedule even when a structured retry_after exists', () => {
    // The automatic schedule is OVER for the incident (the probe path is
    // broken for a non-limit reason) — only a manual resume moves the run.
    const incident = incidentEvent({ resumesAt: plus(T0, 45 * MINUTE_MS) });
    const plan = computeResumePlan(
      incident,
      [inconclusiveEvent(20, plus(T0, 5 * MINUTE_MS))],
      CONFIG,
      at(plus(T0, 60 * MINUTE_MS)),
    );
    expect(plan.kind).toBe('ladder_exhausted');
    if (plan.kind === 'ladder_exhausted') expect(plan.reason).toBe('inconclusive');
  });

  it('probe events from a PREVIOUS incident never leak into the current one (sequence-scoped)', () => {
    const incident = incidentEvent({ sequence: 10 });
    const staleEvents = [
      inconclusiveEvent(5, plus(T0, -60 * MINUTE_MS)), // previous incident's failure
      stillLimitedEvent(6, plus(T0, -50 * MINUTE_MS)), // previous incident's T10
    ];
    const plan = computeResumePlan(incident, staleEvents, CONFIG, at(T0));
    expect(plan).toMatchObject({ kind: 'probe_at', probeIndex: 1, rung: 30 });
  });
});

// ---------------------------------------------------------------------------
// Claims — attempts, not conclusions
// ---------------------------------------------------------------------------
describe('collectIncidentProbeState — claims', () => {
  it('an unresolved claim does not advance the probe index (the executor re-probes the SAME rung)', () => {
    const incident = incidentEvent();
    const incidentId = incidentIdOf(incident);
    const events = [claimedEvent(incidentId, 1, 20, plus(T0, 30 * MINUTE_MS))];
    const state = collectIncidentProbeState(incident, events);
    expect(state.claims).toHaveLength(1);
    expect(state.stillLimitedCount).toBe(0);
    const plan = computeResumePlan(incident, events, CONFIG, at(T0));
    expect(plan).toMatchObject({ kind: 'probe_at', probeIndex: 1 });
  });

  it('claims for a DIFFERENT incident id are ignored', () => {
    const incident = incidentEvent();
    const state = collectIncidentProbeState(incident, [
      claimedEvent(limitIncidentId('li_other'), 1, 20, plus(T0, 30 * MINUTE_MS)),
    ]);
    expect(state.claims).toHaveLength(0);
  });
});

describe('latestIncidentEvent', () => {
  it('returns the LAST limit.incident.recorded on the log', () => {
    const first = incidentEvent({ sequence: 10 });
    const second = incidentEvent({ sequence: 30, occurredAt: plus(T0, 120 * MINUTE_MS) });
    const found = latestIncidentEvent([
      first as DomainEvent,
      stillLimitedEvent(20, plus(T0, 30 * MINUTE_MS)),
      second as DomainEvent,
    ]);
    expect(found?.sequence).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// Claim-fence decision (the pure leg; the service wires the durable append)
// ---------------------------------------------------------------------------
describe('decideClaim', () => {
  const base = {
    claimedFresh: false,
    outcomeExists: false,
    claimOccurredAt: at(T0),
    now: at(T0),
    adoptAfterMs: DEFAULT_PROBE_ADOPT_AFTER_MS,
    locallyInFlight: false,
  };

  it('a FRESH claim insert wins the fence', () => {
    expect(decideClaim({ ...base, claimedFresh: true })).toBe('proceed');
  });

  it('an existing outcome resolves the claim — never probe again', () => {
    expect(decideClaim({ ...base, claimedFresh: true, outcomeExists: true })).toBe('already_resolved');
  });

  it('a deduped claim younger than the adoption grace is presumed LIVE — no double-probe', () => {
    expect(
      decideClaim({ ...base, now: at(plus(T0, DEFAULT_PROBE_ADOPT_AFTER_MS - 1)) }),
    ).toBe('in_flight');
  });

  it('a deduped, outcome-less claim past the grace is ADOPTED (crashed claimant never deadlocks)', () => {
    expect(decideClaim({ ...base, now: at(plus(T0, DEFAULT_PROBE_ADOPT_AFTER_MS)) })).toBe('proceed');
  });

  it('a claim this process is already executing is in_flight regardless of age', () => {
    expect(
      decideClaim({
        ...base,
        locallyInFlight: true,
        now: at(plus(T0, 10 * DEFAULT_PROBE_ADOPT_AFTER_MS)),
      }),
    ).toBe('in_flight');
  });
});
