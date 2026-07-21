import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '../lib/clock.js';
import {
  SEQUENCE_UNASSIGNED,
  artifactHash,
  checkpointId,
  idempotencyKey,
  processGenerationId,
  runId,
  segmentId,
  specHash,
  specVersionId,
  verificationId,
} from './ids.js';
import { draftEvent, type DomainEventType, type EventOfType, type EventPayloads, type LimitClassification } from './events.js';
import { isLiveChild, type ActiveChild } from './state.js';
import {
  TRANSITION_TABLE,
  TRIGGER_EVENT_TYPES,
  applyTransition,
  foldResourceExhausted,
  initialEngineState,
  transitionForEvent,
  type AppliedTransition,
  type EngineState,
  type RejectedTransition,
  type TransitionOutcome,
} from './transitions.js';

const RUN = runId('run_000001');
const SEG = segmentId('seg_000001');
const GEN = processGenerationId('pgen_000001');
const AT = isoTimestamp('2026-07-18T10:00:00.000Z');

/** W2-1: a live generation-tracked child (replaces the old boolean). */
function liveChild(status: ActiveChild['status'] = 'active'): ActiveChild {
  return { generationId: GEN, segmentId: SEG, status };
}

function ev<T extends DomainEventType>(
  type: T,
  payload: EventPayloads[T],
  key = 'trigger-1',
): EventOfType<T> {
  return draftEvent({ type, runId: RUN, payload, idempotencyKey: idempotencyKey(key), occurredAt: AT });
}

const CLASSIFICATION: LimitClassification = {
  kind: 'usage_limit',
  provider: 'claude',
  source: 'structured',
  confidence: 'high',
  detectionTier: 'structured',
  resumesAt: isoTimestamp('2026-07-18T12:00:00.000Z'),
};

const UNKNOWN_CLASSIFICATION: LimitClassification = {
  kind: 'unknown_provider_error',
  provider: 'codex',
  source: 'structured',
  confidence: 'low',
  detectionTier: 'unknown',
};

function expectApplied(outcome: TransitionOutcome): AppliedTransition {
  if (outcome.status !== 'applied') {
    throw new Error(`Expected applied, got rejection: ${outcome.detail}`);
  }
  return outcome;
}

function expectRejected(outcome: TransitionOutcome): RejectedTransition {
  if (outcome.status !== 'rejected') {
    throw new Error(`Expected rejection, got applied ${outcome.transitionId}`);
  }
  return outcome;
}

describe('transition table shape (machine-readability for the conformance generator)', () => {
  it('has exactly 25 rows T1–T25, each triggered by a distinct event type', () => {
    expect(TRANSITION_TABLE).toHaveLength(25);
    expect(new Set(TRANSITION_TABLE.map((r) => r.id)).size).toBe(25);
    expect(new Set(TRANSITION_TABLE.map((r) => r.event)).size).toBe(25);
    expect(TRIGGER_EVENT_TYPES).toHaveLength(25);
    for (const type of TRIGGER_EVENT_TYPES) {
      expect(transitionForEvent(type)).toBeDefined();
    }
  });
});

describe('T1 spec approved', () => {
  it('binds the spec hash and moves awaiting_approval → approved', () => {
    const state = initialEngineState({ phase: 'awaiting_approval' });
    const outcome = expectApplied(
      applyTransition(
        state,
        ev('spec.approved', {
          specVersionId: specVersionId('spec_000001'),
          specHash: specHash('abc123'),
          approvedBy: 'human',
        }),
      ),
    );
    expect(outcome.transitionId).toBe('T1');
    expect(outcome.next.phase).toBe('approved');
    expect(outcome.next.approvedSpecHash).toBe('abc123');
    expect(outcome.next.suspension.kind).toBe('none');
  });
});

describe('T4 limit envelope during prompt_turn', () => {
  const state = initialEngineState({
    phase: 'implementing',
    operation: { kind: 'prompt_turn' },
    activeChild: liveChild(),
  });
  const event = ev('limit.classified.prompt_turn', {
    segmentId: SEG,
    classification: CLASSIFICATION,
  });

  it('pauses on limit: checkpoint, operation→idle, paused_limit{return_phase}, generation stopping w/ durable intent, counters unchanged', () => {
    const outcome = expectApplied(applyTransition(state, event));
    expect(outcome.transitionId).toBe('T4');
    expect(outcome.next.phase).toBe('implementing'); // suspension never changes phase
    expect(outcome.next.operation.kind).toBe('idle');
    // W2-1: the generation is marked stopping (stop-intent recorded); a
    // generation-matched child.stopped later confirms the clean stop.
    expect(outcome.next.activeChild).toMatchObject({
      generationId: GEN,
      status: 'stopping',
      stopCause: 'limit_pause',
    });
    expect(outcome.next.suspension).toMatchObject({
      kind: 'paused_limit',
      returnPhase: 'implementing',
      inFlightOperation: 'prompt_turn',
      enteredAt: AT,
    });
    // restart counter unchanged; respawn count stays 0 (never respawn on limit)
    expect(outcome.next.counters).toEqual(state.counters);

    const types = outcome.emitted.map((e) => e.type);
    expect(types).toEqual([
      'checkpoint.requested',
      'child.stop.intent',
      'segment.stop.requested',
      'limit.incident.recorded',
      'notify.requested',
    ]);
    const intent = outcome.emitted.find((e) => e.type === 'child.stop.intent');
    expect(intent?.payload).toMatchObject({ generationId: GEN, segmentId: SEG, cause: 'limit_pause' });
    const incident = outcome.emitted.find((e) => e.type === 'limit.incident.recorded');
    expect(incident?.payload).toMatchObject({
      provider: 'claude',
      incidentKind: 'usage_limit',
      detectionTier: 'structured',
      etaSource: 'retry_after',
      segmentId: SEG,
    });
  });

  it('emits events carrying runId, unassigned sequence placeholder, and derived unique idempotency keys', () => {
    const outcome = expectApplied(applyTransition(state, event));
    const keys = new Set<string>();
    for (const emitted of outcome.emitted) {
      expect(emitted.runId).toBe(RUN);
      expect(emitted.sequence).toBe(SEQUENCE_UNASSIGNED);
      expect(emitted.occurredAt).toBe(AT);
      expect(String(emitted.idempotencyKey)).toContain('trigger-1#');
      keys.add(String(emitted.idempotencyKey));
    }
    expect(keys.size).toBe(outcome.emitted.length);
  });

  it('is deterministic and does not mutate the input state', () => {
    const before = JSON.stringify(state);
    const a = applyTransition(state, event);
    const b = applyTransition(state, event);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(state)).toBe(before);
  });
});

describe('T7 late limit signal after segment closed', () => {
  it('records the incident + provider note without touching phase/suspension/counters', () => {
    const state = initialEngineState({ phase: 'implementing', activeChild: liveChild('stopped') });
    const outcome = expectApplied(
      applyTransition(state, ev('limit.late_signal', { segmentId: SEG, classification: CLASSIFICATION })),
    );
    expect(outcome.transitionId).toBe('T7');
    // no suspension, phase unchanged, nothing stopped
    expect(outcome.next).toEqual(state);
    const types = outcome.emitted.map((e) => e.type);
    expect(types).toContain('limit.incident.recorded');
    expect(types).not.toContain('segment.stop.requested');
    expect(types).not.toContain('checkpoint.requested');
  });
});

describe('T9 resume from paused_limit', () => {
  it('returns to return_phase, clears suspension, resets probe count, records the pending re-entry — NO child marked active (W2-1)', () => {
    const state = initialEngineState({
      phase: 'implementing',
      suspension: {
        kind: 'paused_limit',
        reasonDetail: 'usage_limit:claude',
        returnPhase: 'implementing',
        enteredAt: AT,
      },
      activeChild: liveChild('stopped'),
      counters: { restartsInWindow: 1, lifetimeRestarts: 2, probeCount: 3, remediationRounds: 0 },
    });
    const outcome = expectApplied(
      applyTransition(state, ev('resume.limit.requested', { mode: 'manual' })),
    );
    expect(outcome.transitionId).toBe('T9');
    expect(outcome.next.phase).toBe('implementing');
    expect(outcome.next.suspension.kind).toBe('none');
    // W2-1: resume never marks a child active — child.spawned does, later.
    expect(isLiveChild(outcome.next.activeChild)).toBe(false);
    expect(outcome.next.resumeReentryPending).toMatchObject({
      returnPhase: 'implementing',
      mode: 'manual',
      recordedAt: AT,
    });
    expect(outcome.next.counters.probeCount).toBe(0);
    expect(outcome.next.counters.lifetimeRestarts).toBe(2); // untouched
    const resume = outcome.emitted.find((e) => e.type === 'segment.resume.initiated');
    expect(resume?.payload).toMatchObject({ returnPhase: 'implementing' });
  });
});

describe('T16 ambiguous provider error (fail-safe pause)', () => {
  it('pauses like T4 but with incident kind=unknown and NO breaker counting', () => {
    const state = initialEngineState({
      phase: 'verifying',
      operation: { kind: 'prompt_turn' },
      activeChild: liveChild(),
      counters: { restartsInWindow: 4, lifetimeRestarts: 9, probeCount: 0, remediationRounds: 1 },
    });
    const outcome = expectApplied(
      applyTransition(
        state,
        ev('provider.error.unknown', { segmentId: SEG, classification: UNKNOWN_CLASSIFICATION }),
      ),
    );
    expect(outcome.transitionId).toBe('T16');
    expect(outcome.next.suspension).toMatchObject({ kind: 'paused_limit', returnPhase: 'verifying' });
    // never counts toward breaker: all counters untouched
    expect(outcome.next.counters).toEqual(state.counters);
    const incident = outcome.emitted.find((e) => e.type === 'limit.incident.recorded');
    expect(incident?.payload).toMatchObject({ incidentKind: 'unknown', etaSource: 'unknown' });
    expect(outcome.emitted.map((e) => e.type)).not.toContain('breaker.opened');
  });
});

// W2-1 deliberate correction: T13 no longer auto-respawns (that was the old
// `restart_or_breaker` behavior) — an unexpected non-limit exit folds the
// counters, marks the generation stopped, and suspends `interrupted` for a
// MANUAL resume; bounded respawn is P4b, and exhaustion (T14) is the
// supervisor's decision, never the reducer's.
describe('T13 child crash: fold counters, mark generation stopped, interrupted (manual resume)', () => {
  const crash = ev('child.exited.unexpectedly', {
    segmentId: SEG,
    generationId: GEN,
    exitCode: 1,
    classifiedAs: 'crash',
  });

  it('interrupts and folds both counters — no restart event, no live child, no breaker decision', () => {
    const state = initialEngineState({ phase: 'implementing', activeChild: liveChild() });
    const outcome = expectApplied(applyTransition(state, crash));
    expect(outcome.transitionId).toBe('T13');
    expect(outcome.next.suspension).toMatchObject({ kind: 'interrupted', returnPhase: 'implementing' });
    expect(outcome.next.activeChild).toMatchObject({ generationId: GEN, status: 'stopped' });
    expect(isLiveChild(outcome.next.activeChild)).toBe(false);
    expect(outcome.next.counters.restartsInWindow).toBe(1);
    expect(outcome.next.counters.lifetimeRestarts).toBe(1);
    expect(outcome.emitted.map((e) => e.type)).toEqual([
      'worktree.validation.required',
      'notify.requested',
    ]);
    expect(outcome.emitted.map((e) => e.type)).not.toContain('segment.restart.initiated');
  });

  it('keeps folding counters on later crashes — exhaustion is T14 (supervisor), never decided here', () => {
    const state = initialEngineState({
      phase: 'implementing',
      activeChild: liveChild(),
      counters: { restartsInWindow: 0, lifetimeRestarts: 10, probeCount: 0, remediationRounds: 0 },
    });
    const outcome = expectApplied(applyTransition(state, crash));
    // Even past the old lifetime cap the reducer only folds + interrupts;
    // `breaker_open` arrives via T14 from the supervisor's own evaluation.
    expect(outcome.next.suspension.kind).toBe('interrupted');
    expect(outcome.next.counters.lifetimeRestarts).toBe(11);
    expect(outcome.emitted.map((e) => e.type)).not.toContain('breaker.opened');
  });

  it('rejects a crash report stamped with a superseded generation (stale report never interrupts the new child)', () => {
    const state = initialEngineState({
      phase: 'implementing',
      activeChild: { generationId: processGenerationId('pgen_000002'), segmentId: SEG, status: 'active' },
    });
    const outcome = expectRejected(applyTransition(state, crash));
    expect(outcome.reason).toBe('precondition_failed');
    expect(outcome.detail).toContain('not the active generation');
  });
});

// F4 (§5x) — T14 (`restart.exhausted`) is GUARDED like T13/T17: a
// stale/superseded/late breaker-open must NOT clobber a moved-on / paused_limit
// / terminal run. These FAIL on the pre-fix table (T14 `preconditions: []`,
// unstamped payload), where every restart.exhausted opened the breaker
// unconditionally.
describe('T14 restart.exhausted: generation-stamped + guarded (F4 §5x)', () => {
  const exhausted = (
    generationId = GEN,
    reason: EventPayloads['restart.exhausted']['reason'] = 'window_bound',
  ): EventOfType<'restart.exhausted'> => ev('restart.exhausted', { reason, generationId });

  it('opens the breaker for the ACTIVE generation from a live, non-terminal, unsuspended run', () => {
    const state = initialEngineState({ phase: 'implementing', activeChild: liveChild() });
    const outcome = expectApplied(applyTransition(state, exhausted()));
    expect(outcome.transitionId).toBe('T14');
    expect(outcome.next.suspension.kind).toBe('breaker_open');
    expect(outcome.emitted.find((e) => e.type === 'breaker.opened')?.payload).toEqual({ reason: 'window_bound' });
  });

  it('REJECTS a breaker-open stamped with a SUPERSEDED generation (the run already moved on to a new child)', () => {
    const state = initialEngineState({
      phase: 'implementing',
      activeChild: { generationId: processGenerationId('pgen_000009'), segmentId: SEG, status: 'active' },
    });
    const outcome = expectRejected(applyTransition(state, exhausted(processGenerationId('pgen_stale_1'))));
    expect(outcome.reason).toBe('precondition_failed');
    expect(outcome.detail).toContain('not the active generation');
    // The moved-on run is untouched — no breaker.
    expect(outcome).not.toHaveProperty('next');
  });

  it('REJECTS a late breaker-open over a paused_limit run (a limit pause must never be converted to a breaker)', () => {
    const state = initialEngineState({
      phase: 'implementing',
      suspension: { kind: 'paused_limit', reasonDetail: 'usage_limit:claude', returnPhase: 'implementing', enteredAt: AT },
      activeChild: liveChild(),
    });
    const outcome = expectRejected(applyTransition(state, exhausted()));
    expect(outcome.reason).toBe('precondition_failed');
    expect(outcome.detail).toContain('suspension must be in [none]');
  });

  it('REJECTS a late breaker-open over a TERMINAL run (cancelled cannot be resurrected into breaker_open)', () => {
    const state = initialEngineState({ phase: 'cancelled', activeChild: liveChild() });
    const outcome = expectRejected(applyTransition(state, exhausted()));
    expect(outcome.reason).toBe('precondition_failed');
    expect(outcome.detail).toContain('phase must be non-terminal');
  });
});

describe('T23 verification failure: bounded remediation, exhaustion → failed', () => {
  const failedEvent = ev('verification.completed.failed', {
    verificationId: verificationId('verif_000001'),
    failedCriteria: [],
    unprovenCriteria: [],
  });

  it('moves verifying → needs_remediation within the bound', () => {
    const state = initialEngineState({ phase: 'verifying' });
    const outcome = expectApplied(applyTransition(state, failedEvent));
    expect(outcome.next.phase).toBe('needs_remediation');
    expect(outcome.next.counters.remediationRounds).toBe(1);
  });

  it('fails the run when the remediation bound is exhausted (never false completion)', () => {
    const state = initialEngineState({
      phase: 'verifying',
      counters: { restartsInWindow: 0, lifetimeRestarts: 0, probeCount: 0, remediationRounds: 3 },
    });
    const outcome = expectApplied(applyTransition(state, failedEvent));
    expect(outcome.next.phase).toBe('failed');
    expect(outcome.emitted.map((e) => e.type)).toContain('notify.requested');
  });
});

describe('rejection of illegal (state, event) pairs', () => {
  it('rejects a listed event whose preconditions fail, with a ready transition.rejected event', () => {
    const state = initialEngineState({ phase: 'implementing' });
    const outcome = expectRejected(
      applyTransition(
        state,
        ev('spec.approved', {
          specVersionId: specVersionId('spec_000001'),
          specHash: specHash('abc123'),
          approvedBy: 'human',
        }),
      ),
    );
    expect(outcome.reason).toBe('precondition_failed');
    expect(outcome.detail).toContain('T1');
    expect(outcome.rejectionEvent.type).toBe('transition.rejected');
    expect(outcome.rejectionEvent.runId).toBe(RUN);
    expect(outcome.rejectionEvent.payload).toMatchObject({
      attemptedEventType: 'spec.approved',
      reason: 'precondition_failed',
      phase: 'implementing',
    });
  });

  it('rejects supporting/unlisted event types outright', () => {
    const state = initialEngineState({ phase: 'implementing' });
    const outcome = expectRejected(
      applyTransition(
        state,
        ev('checkpoint.recorded', {
          checkpointId: checkpointId('ckpt_000001'),
          artifactHash: artifactHash('deadbeef'),
          reason: 'cadence',
          specHash: specHash(''),
        }),
      ),
    );
    expect(outcome.reason).toBe('unlisted_event');
  });

  it('rejects cancel on an already-terminal run (idempotency handled by the caller)', () => {
    const state = initialEngineState({ phase: 'cancelled' });
    const outcome = expectRejected(applyTransition(state, ev('cancel.requested', {})));
    expect(outcome.reason).toBe('precondition_failed');
  });

  it('rejects a limit event when already suspended (no double pause)', () => {
    const paused: EngineState = initialEngineState({
      phase: 'implementing',
      suspension: {
        kind: 'paused_limit',
        reasonDetail: 'usage_limit:claude',
        returnPhase: 'implementing',
        enteredAt: AT,
      },
    });
    const outcome = expectRejected(
      applyTransition(
        paused,
        ev('limit.classified.prompt_turn', { segmentId: SEG, classification: CLASSIFICATION }),
      ),
    );
    expect(outcome.reason).toBe('precondition_failed');
  });
});

describe('T18 cancel', () => {
  it('produces one terminal result with stop + reap directives', () => {
    const state = initialEngineState({
      phase: 'implementing',
      activeChild: liveChild(),
      operation: { kind: 'prompt_turn' },
    });
    const outcome = expectApplied(applyTransition(state, ev('cancel.requested', {})));
    expect(outcome.next.phase).toBe('cancelled');
    expect(outcome.next.suspension.kind).toBe('none');
    expect(outcome.next.operation.kind).toBe('idle');
    expect(outcome.next.activeChild).toMatchObject({ generationId: GEN, status: 'stopped' });
    expect(isLiveChild(outcome.next.activeChild)).toBe(false);
    expect(outcome.emitted.map((e) => e.type)).toEqual([
      'segment.stop.requested',
      'process_group.reap.requested',
    ]);
  });
});

describe('foldResourceExhausted (F1/F3) + T12 resume from resource_exhausted', () => {
  const exhausted = (gen = GEN, key = 'rx-1'): EventOfType<'resource.exhausted'> =>
    ev('resource.exhausted', { generationId: gen, segmentId: SEG, role: 'implementor', rssBytes: 200, budgetBytes: 100 }, key);

  it('suspends resource_exhausted, marks the matching generation stopped, idles the operation, preserves the return phase', () => {
    const state = initialEngineState({
      phase: 'implementing',
      activeChild: liveChild(),
      operation: { kind: 'prompt_turn' },
    });
    const next = foldResourceExhausted(state, exhausted());
    expect(next.suspension.kind).toBe('resource_exhausted');
    if (next.suspension.kind === 'resource_exhausted') {
      expect(next.suspension.returnPhase).toBe('implementing');
      expect(next.suspension.inFlightOperation).toBe('prompt_turn');
    }
    expect(next.activeChild?.status).toBe('stopped');
    expect(next.operation.kind).toBe('idle');
  });

  it('is idempotent — a redelivery (or a run already suspended) is an unchanged no-op', () => {
    const once = foldResourceExhausted(
      initialEngineState({ phase: 'implementing', activeChild: liveChild() }),
      exhausted(),
    );
    const twice = foldResourceExhausted(once, exhausted(GEN, 'rx-2'));
    expect(twice).toBe(once); // same reference — no second suspension
  });

  it('never suspends on a late/FOREIGN generation, and is a no-op on a terminal run', () => {
    const foreign = foldResourceExhausted(
      initialEngineState({ phase: 'implementing', activeChild: liveChild() }),
      exhausted(processGenerationId('pgen_other'), 'rx-foreign'),
    );
    expect(foreign.suspension.kind).toBe('none'); // the current generation is untouched
    expect(foreign.activeChild?.status).toBe('active');

    const terminal = foldResourceExhausted(
      initialEngineState({ phase: 'failed', activeChild: liveChild() }),
      exhausted(),
    );
    expect(terminal.suspension.kind).toBe('none');
  });

  it('T12 resumes from resource_exhausted (like paused_user/interrupted) to the return phase', () => {
    const suspended = foldResourceExhausted(
      initialEngineState({ phase: 'implementing', activeChild: liveChild('stopped') }),
      exhausted(),
    );
    expect(suspended.suspension.kind).toBe('resource_exhausted');
    const resumed = expectApplied(applyTransition(suspended, ev('resume.user.requested', {}, 'resume-1')));
    expect(resumed.transitionId).toBe('T12');
    expect(resumed.next.suspension.kind).toBe('none');
    expect(resumed.next.phase).toBe('implementing');
  });
});
