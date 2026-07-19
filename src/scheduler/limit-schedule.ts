/**
 * W2-4 pure resume scheduler (spec docs/specs/hardening-p4a.md §W2-4;
 * PLAN §13) — every scheduling DECISION for a `paused_limit` run lives here,
 * pure and deterministic; the T10 reducer only folds probe counts (W2-1,
 * pushback item 8) and the application service only EXECUTES what this
 * module computes.
 *
 * Anchoring (pushback item 3): every deadline is computed from EVENT
 * timestamps — the `limit.incident.recorded` event for the first probe, the
 * latest T10 (`limit.probe.still_limited`) for each subsequent rung — NEVER
 * from `now`. A restart therefore recomputes the exact same deadline; a
 * deadline that elapsed while the orchestrator was down comes back as a
 * `probe_at` in the past (probe immediately) or, for an elapsed structured
 * `resumes_at`, as `resume_now` — the schedule is never silently re-anchored
 * to the restart time.
 *
 * Ladder + cap: taken from the run's PINNED config (W1-F5
 * `RUN_CONFIG_PROJECTION`), never from whatever the current process defaults
 * to. The cap is `maxProbesPerIncident` (default 6) and exhaustion is
 * PERMANENT for the incident — a sliding 24h window is deliberately rejected
 * complexity; manual `resume` always remains (§13).
 *
 * Jitter: deterministic from a (runId, probeIndex) hash — no `Math.random`
 * anywhere — so replays and concurrent evaluators compute identical
 * deadlines. Applied to LADDER rungs only; a structured `resumes_at` is the
 * provider's own word and is used verbatim (`rung: 0`).
 *
 * Probe-claim fencing (pushback item 4): `probeClaimKey(incidentId,
 * probeIndex)` is the idempotency key of the durable `limit.probe.claimed`
 * event written BEFORE probing, and `probeOutcomeKey(claim)` is the shared
 * idempotency key of the resulting T9/T10/`limit.probe.inconclusive` event —
 * two concurrent `run --wait`/`resume --wait` processes cannot double-probe
 * a rung (the claim insert dedupes; `decideClaim`) or double-count T10 (the
 * outcome key collapses duplicates to one logical event).
 */
import type { IsoTimestamp } from '../lib/clock.js';
import { isoTimestamp } from '../lib/clock.js';
import {
  idempotencyKey,
  limitIncidentId,
  type IdempotencyKey,
  type LimitIncidentId,
  type RunId,
} from '../domain/ids.js';
import type { DomainEvent, EventOfType } from '../domain/events.js';
import type { EngineConfig } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Plan vocabulary
// ---------------------------------------------------------------------------
/**
 * `rung` value for a probe whose deadline is the incident's structured
 * `resumes_at` (etaSource `retry_after`) rather than a ladder rung: the
 * provider named its own reset time, so no ladder minutes (and no jitter)
 * apply.
 */
export const ETA_ANCHORED_RUNG = 0;

/** The incident's structured `resumes_at` has ELAPSED (per the provider's
 * own retry_after): re-enter now — no probe required, no claim consumed. A
 * restart long after the ETA lands here directly (anchoring, item 3). */
export interface ResumeNowPlan {
  readonly kind: 'resume_now';
  /** The elapsed structured ETA that licensed the immediate resume. */
  readonly resumesAt: IsoTimestamp;
}

/** Execute probe `probeIndex` once `at` arrives (already-elapsed `at` =
 * probe immediately — the deadline is event-anchored, never re-anchored). */
export interface ProbeAtPlan {
  readonly kind: 'probe_at';
  /** Absolute deadline (event-timestamp-anchored; ladder jitter folded in). */
  readonly at: IsoTimestamp;
  /** Ladder rung in minutes; `ETA_ANCHORED_RUNG` (0) = retry_after-anchored. */
  readonly rung: number;
  /** 1-based probe index within the incident (bounded per incident). */
  readonly probeIndex: number;
}

/**
 * Automatic probing is OVER for this incident — permanently:
 *  - `probe_cap`: `maxProbesPerIncident` probes concluded still-limited
 *    (§13: exhaustion is per-incident and permanent; no sliding window);
 *  - `inconclusive`: a probe failed for a NON-limit reason
 *    (`limit.probe.inconclusive` recorded) — automatic probing STOPS.
 * Either way the run stays paused and manual `resume` remains available.
 */
export interface LadderExhaustedPlan {
  readonly kind: 'ladder_exhausted';
  readonly reason: 'probe_cap' | 'inconclusive';
  /** Probes that CONCLUDED still-limited (T10 count for the incident). */
  readonly probesUsed: number;
  readonly maxProbesPerIncident: number;
}

export type ResumePlan = ResumeNowPlan | ProbeAtPlan | LadderExhaustedPlan;

// ---------------------------------------------------------------------------
// Deterministic jitter — (runId, probeIndex) hash, never Math.random
// ---------------------------------------------------------------------------
/** Jitter never exceeds 5 minutes, however long the rung. */
export const JITTER_CAP_MS = 5 * 60_000;

/** FNV-1a 32-bit — tiny, stable, dependency-free. */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Deterministic ladder jitter: hash of `(runId, probeIndex)` mapped into
 * `[0, min(rungMs/10, JITTER_CAP_MS)]`. The same inputs always produce the
 * same offset (replay/restart-stable); distinct runs de-synchronize their
 * probes against a shared provider reset (§13 "jittered").
 */
export function deterministicJitterMs(runId: RunId, probeIndex: number, rungMs: number): number {
  const cap = Math.min(Math.floor(rungMs / 10), JITTER_CAP_MS);
  if (cap <= 0) return 0;
  return fnv1a32(`${runId}#${probeIndex}`) % (cap + 1);
}

// ---------------------------------------------------------------------------
// Durable identities and idempotency fences
// ---------------------------------------------------------------------------
/**
 * The incident identity used to key claims/schedules. The engine's
 * `limit.incident.recorded` effect events carry no repository-assigned id,
 * so the identity is derived deterministically from the DURABLE event
 * (run + assigned sequence) — stable across replays and processes.
 */
export function incidentIdOf(incident: EventOfType<'limit.incident.recorded'>): LimitIncidentId {
  return incident.payload.incidentId ?? limitIncidentId(`li_${incident.runId}_seq${incident.sequence}`);
}

/** Idempotency key of the durable probe-attempt claim (`limit.probe.claimed`)
 * for `(runId, incidentId, probeIndex)` — the run scoping is the event log's
 * own `(run_id, idempotency_key)` uniqueness. Written BEFORE probing. */
export function probeClaimKey(incidentId: LimitIncidentId, probeIndex: number): IdempotencyKey {
  return idempotencyKey(`probe_claim:${incidentId}:${probeIndex}`);
}

/**
 * Idempotency key of the claim's OUTCOME event — shared across the three
 * possible outcome types (T9 `resume.limit.requested` / T10
 * `limit.probe.still_limited` / `limit.probe.inconclusive`) so a claim can
 * ever resolve to exactly ONE logical event: a duplicate append of the same
 * type dedupes; a conflicting type throws loudly in the event repository.
 */
export function probeOutcomeKey(claim: IdempotencyKey): IdempotencyKey {
  return idempotencyKey(`${claim}#outcome`);
}

/** Idempotency key of the explicit `limit.probe.scheduled {at, rung,
 * probeIndex}` supporting event for a probe index (dedupes re-appends after
 * a crash between the T10 and the schedule event). */
export function probeScheduleKey(incidentId: LimitIncidentId, probeIndex: number): IdempotencyKey {
  return idempotencyKey(`probe_sched:${incidentId}:${probeIndex}`);
}

// ---------------------------------------------------------------------------
// Incident + probe-event extraction (pure folds over the log)
// ---------------------------------------------------------------------------
/** The CURRENT incident = the latest `limit.incident.recorded` on the log
 * (probe events are scoped to it by sequence; see `collectIncidentProbeState`). */
export function latestIncidentEvent(
  events: readonly DomainEvent[],
): EventOfType<'limit.incident.recorded'> | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === 'limit.incident.recorded') {
      return event as EventOfType<'limit.incident.recorded'>;
    }
  }
  return undefined;
}

export interface IncidentProbeState {
  /** Probes that CONCLUDED still-limited (T10s after the incident). */
  readonly stillLimitedCount: number;
  /** The latest T10's timestamp — the anchor for the next rung. */
  readonly lastStillLimitedAt?: IsoTimestamp;
  /** Durable probe-attempt claims for THIS incident. */
  readonly claims: readonly EventOfType<'limit.probe.claimed'>[];
  /** Non-limit probe failures — any present stops automatic probing. */
  readonly inconclusive: readonly EventOfType<'limit.probe.inconclusive'>[];
}

/**
 * Fold the probe-relevant events belonging to `incident` out of a (possibly
 * full) event list: only events strictly AFTER the incident's assigned
 * sequence count (probes from a PREVIOUS incident never leak forward), and
 * claims additionally match the derived incident id.
 */
export function collectIncidentProbeState(
  incident: EventOfType<'limit.incident.recorded'>,
  events: readonly DomainEvent[],
): IncidentProbeState {
  const incidentId = incidentIdOf(incident);
  let stillLimitedCount = 0;
  let lastStillLimitedAt: IsoTimestamp | undefined;
  const claims: EventOfType<'limit.probe.claimed'>[] = [];
  const inconclusive: EventOfType<'limit.probe.inconclusive'>[] = [];
  for (const event of events) {
    if (event.sequence <= incident.sequence) continue;
    if (event.type === 'limit.probe.still_limited') {
      stillLimitedCount += 1;
      lastStillLimitedAt = event.occurredAt;
    } else if (event.type === 'limit.probe.claimed') {
      if (event.payload.incidentId === incidentId) {
        claims.push(event as EventOfType<'limit.probe.claimed'>);
      }
    } else if (event.type === 'limit.probe.inconclusive') {
      inconclusive.push(event as EventOfType<'limit.probe.inconclusive'>);
    }
  }
  return {
    stillLimitedCount,
    claims,
    inconclusive,
    ...(lastStillLimitedAt !== undefined ? { lastStillLimitedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------
/**
 * Compute the resume plan for a `paused_limit` run — pure and total.
 *
 *  1. Any `limit.probe.inconclusive` for the incident → `ladder_exhausted`
 *     (`reason: 'inconclusive'`): automatic probing has STOPPED; only manual
 *     `resume` moves the run (W2-4 outcome rules).
 *  2. Structured `resumes_at` present and NO probe has concluded yet:
 *     elapsed → `resume_now`; future → `probe_at` AT the provider's own
 *     reset time (`rung: ETA_ANCHORED_RUNG`, no jitter). Once a probe
 *     concluded still-limited, the provider's word is spent — the ladder
 *     governs from the T10 anchor.
 *  3. Ladder: probe `i` fires `ladder[min(i, len)-1]` minutes (+ jitter)
 *     after the ANCHOR — the incident event for probe 1, the latest T10 for
 *     every later probe. Past `maxProbesPerIncident` → `ladder_exhausted`
 *     (`reason: 'probe_cap'`, permanent for the incident).
 *
 * `now` decides only resume_now-vs-probe_at for an ETA incident; every
 * deadline is event-anchored (item 3 — restarts recompute identical plans).
 */
export function computeResumePlan(
  incident: EventOfType<'limit.incident.recorded'>,
  probeEvents: readonly DomainEvent[],
  runConfig: EngineConfig,
  now: IsoTimestamp,
): ResumePlan {
  const config = runConfig.limitProbe;
  const state = collectIncidentProbeState(incident, probeEvents);

  if (state.inconclusive.length > 0) {
    return {
      kind: 'ladder_exhausted',
      reason: 'inconclusive',
      probesUsed: state.stillLimitedCount,
      maxProbesPerIncident: config.maxProbesPerIncident,
    };
  }

  const resumesAt = incident.payload.resumesAt;
  if (state.stillLimitedCount === 0 && resumesAt !== undefined) {
    if (Date.parse(now) >= Date.parse(resumesAt)) {
      return { kind: 'resume_now', resumesAt };
    }
    return { kind: 'probe_at', at: resumesAt, rung: ETA_ANCHORED_RUNG, probeIndex: 1 };
  }

  const probeIndex = state.stillLimitedCount + 1;
  if (probeIndex > config.maxProbesPerIncident) {
    return {
      kind: 'ladder_exhausted',
      reason: 'probe_cap',
      probesUsed: state.stillLimitedCount,
      maxProbesPerIncident: config.maxProbesPerIncident,
    };
  }

  const anchor = state.lastStillLimitedAt ?? incident.occurredAt;
  const ladder = config.ladderMinutes;
  const rung = ladder[Math.min(probeIndex, ladder.length) - 1]!; // schema: min(1) — never empty
  const rungMs = rung * 60_000;
  const at = isoTimestamp(
    new Date(
      Date.parse(anchor) + rungMs + deterministicJitterMs(incident.runId, probeIndex, rungMs),
    ).toISOString(),
  );
  return { kind: 'probe_at', at, rung, probeIndex };
}

// ---------------------------------------------------------------------------
// Claim fencing decision (pure; the service wires the durable append)
// ---------------------------------------------------------------------------
/**
 * A deduped claim younger than this is presumed to belong to a LIVE prober
 * (a probe is one spawn + one no-op turn); older with no outcome = the
 * claimant died mid-probe → adopt it, reusing the SAME claim so the outcome
 * stays one logical event (W2-7 crash-injection "after probe claim" recovers
 * through exactly this adoption).
 */
export const DEFAULT_PROBE_ADOPT_AFTER_MS = 2 * 60_000;

export type ClaimDecision = 'proceed' | 'in_flight' | 'already_resolved';

export interface ClaimEvaluationInput {
  /** Our append INSERTED the claim (not deduped) — we own the probe. */
  readonly claimedFresh: boolean;
  /** An event already exists under `probeOutcomeKey(claim)`. */
  readonly outcomeExists: boolean;
  /** The DURABLE claim event's timestamp (ours or the pre-existing one). */
  readonly claimOccurredAt: IsoTimestamp;
  readonly now: IsoTimestamp;
  /** Adoption grace for a deduped, outcome-less claim (crashed claimant). */
  readonly adoptAfterMs: number;
  /** THIS process is already executing this very claim (in-memory guard). */
  readonly locallyInFlight: boolean;
}

/**
 * Decide whether the caller may execute the probe behind a claim append:
 *  - an outcome already exists → `already_resolved` (never probe again);
 *  - this process is mid-probe on the claim → `in_flight`;
 *  - our append inserted the claim → `proceed` (we won the fence);
 *  - deduped claim, no outcome: presumed live for `adoptAfterMs` since the
 *    claim's own timestamp (`in_flight`), adoptable after (`proceed`) — a
 *    crashed claimant never deadlocks the schedule, and the shared outcome
 *    key bounds even a pathological double-adopt to one logical outcome.
 */
export function decideClaim(input: ClaimEvaluationInput): ClaimDecision {
  if (input.outcomeExists) return 'already_resolved';
  if (input.locallyInFlight) return 'in_flight';
  if (input.claimedFresh) return 'proceed';
  return Date.parse(input.now) - Date.parse(input.claimOccurredAt) >= input.adoptAfterMs
    ? 'proceed'
    : 'in_flight';
}
