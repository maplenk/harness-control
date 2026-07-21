/**
 * GENERATED conformance suite (PLAN.md §19 tests 11 & 20), driven entirely by
 * `TRANSITION_TABLE` (transitions.ts) as data — this file does not hand-author
 * per-row expectations beyond a small "targeted effect-branch" block at the
 * bottom that exercises the second branch of a couple of conditional effects
 * (`git_grace_outcome`, `rss_hard_stop`) the single generated case per row
 * doesn't reach.
 *
 * Coverage:
 *  - Every row T1-T25 gets a satisfying `EngineState`, built purely by
 *    reading its `preconditions[]` (phase_in / phase_non_terminal /
 *    suspension_in / operation_in / child_active), and a trigger event built
 *    purely by reading its `event` key against the `EventPayloads` registry
 *    via `BUILDERS` (a mapped type indexed by `TriggerEventType`, so it fails
 *    to typecheck the moment the table's event set changes). The transition
 *    must apply, and every declared `invariants[]` entry is asserted.
 *  - Rejection coverage = (a) each row, under each precondition violated one
 *    at a time with all others still satisfied, rejects with
 *    'precondition_failed' and a ready `transition.rejected` event —
 *    state-shaped preconditions are violated through the STATE, and (W2-1)
 *    `payload_check` preconditions through violating EVENTS (T24 without a
 *    ready MergeReadiness; T13 stamped with a stale generation); (b)
 *    every event type NOT claimed by any row (`DomainEventType` minus
 *    `TRIGGER_EVENT_TYPES`) rejects with 'unlisted_event' from an arbitrary
 *    active state — including the W2-1 engine-folded supporting events
 *    (child.spawned / child.stopped / resume_reentry.completed), which are
 *    folded by `makeEngineReducer`, never by `applyTransition`.
 *  - PLAN §19 test 11: `spec.superseded` (T3) marks open assignments stale
 *    from every non-terminal phase and is rejected once terminal.
 *  - W2-1 targeted block: T4 from `initial_config_pin`; T11's stop-confirmed
 *    pause (suspension folds only on the generation-matched `child.stopped`,
 *    and a late stop from a superseded generation clears nothing); T13 →
 *    `interrupted` with zero respawns; T9/T12 pending re-entry + ack; T10's
 *    purified fold (counts only, no scheduling).
 */
import { describe, expect, it } from 'vitest';
import { isoTimestamp } from '../lib/clock.js';
import {
  SEQUENCE_UNASSIGNED,
  criterionId,
  gitSha,
  idempotencyKey,
  mergeReadinessId,
  processGenerationId,
  runId,
  segmentId,
  specHash,
  specVersionId,
  verificationId,
  type ProcessGenerationId,
  type SegmentId,
  type VerificationId,
} from './ids.js';
import type { MergeReadiness } from './entities.js';
import {
  draftEvent,
  type DomainEvent,
  type DomainEventType,
  type EventOfType,
  type EventPayloads,
  type LimitClassification,
} from './events.js';
import {
  OPERATION_IDLE,
  OPERATION_KINDS,
  RUN_PHASES,
  SUSPENSION_KINDS,
  SUSPENSION_NONE,
  TERMINAL_PHASES,
  isLiveChild,
  isTerminalPhase,
  type ActiveChild,
  type Operation,
  type OperationKind,
  type RunPhase,
  type Suspension,
  type SuspensionKind,
} from './state.js';
import {
  TRANSITION_TABLE,
  TRIGGER_EVENT_TYPES,
  applyTransition,
  checkPrecondition,
  checkPreconditions,
  foldChildSpawnInitiated,
  foldChildSpawned,
  foldChildStopped,
  foldResumeReentryCompleted,
  foldTurnCompleted,
  foldTurnStarted,
  initialEngineState,
  transitionById,
  transitionForEvent,
  type AppliedTransition,
  type EngineState,
  type Precondition,
  type RejectedTransition,
  type TransitionInvariant,
  type TransitionOutcome,
  type TransitionRow,
  type TriggerEventType,
} from './transitions.js';

const RUN = runId('run_conf_000001');
const AT = isoTimestamp('2026-07-18T09:00:00.000Z');

// ---------------------------------------------------------------------------
// Shared fixture context for trigger-payload construction.
// ---------------------------------------------------------------------------
interface PayloadContext {
  readonly segment: SegmentId;
  /** W2-1: the ACTIVE generation — `stateFor` and generation-stamped trigger
   * payloads (T13) share it so payload_check rows apply by construction. */
  readonly generation: ProcessGenerationId;
  readonly classification: LimitClassification;
  readonly unknownClassification: LimitClassification;
  /** W2-1: T24 is payload-validated — a READY §16 MergeReadiness fixture. */
  readonly readyMergeReadiness: (verification: VerificationId) => MergeReadiness;
}

function readyMergeReadinessFor(verification: VerificationId): MergeReadiness {
  return {
    id: mergeReadinessId('mrg_conf_000001'),
    runId: RUN,
    verificationId: verification,
    specHash: specHash('spechash_conf_000001'),
    baseCommit: gitSha('base_conf_1'),
    verifiedCommit: gitSha('impl_conf_1'),
    destinationClean: true,
    worktreeClean: true,
    baseDrifted: false,
    conflicts: false,
    requiredTestsPassed: true,
    ready: true,
    blockers: [],
    manualIntegrationCommands: ['git merge --no-ff impl_conf_1'],
    createdAt: AT,
  };
}

const CTX: PayloadContext = {
  segment: segmentId('seg_conf_000001'),
  generation: processGenerationId('pgen_conf_000001'),
  classification: {
    kind: 'usage_limit',
    provider: 'claude',
    source: 'structured',
    confidence: 'high',
    detectionTier: 'structured',
    resumesAt: isoTimestamp('2026-07-18T12:00:00.000Z'),
  },
  unknownClassification: {
    kind: 'unknown_provider_error',
    provider: 'codex',
    source: 'structured',
    confidence: 'low',
    detectionTier: 'unknown',
  },
  readyMergeReadiness: readyMergeReadinessFor,
};

// ---------------------------------------------------------------------------
// Trigger payload factories — one per TriggerEventType. A mapped type keyed
// by `TriggerEventType` (itself derived from `TRIGGER_EVENT_TYPES`, which is
// self-checked against the table at transitions.ts module load): if a row's
// event changes, or the table gains/loses a row, this object literal fails
// to typecheck (missing/excess property) until updated.
// ---------------------------------------------------------------------------
type PayloadBuilder<T extends TriggerEventType> = (ctx: PayloadContext) => EventPayloads[T];
type PayloadBuilders = { [T in TriggerEventType]: PayloadBuilder<T> };

const BUILDERS: PayloadBuilders = {
  'spec.approved': () => ({
    specVersionId: specVersionId('spec_conf_000001'),
    specHash: specHash('spechash_conf_000001'),
    approvedBy: 'human',
  }),
  'spec.revise.requested': () => ({
    specVersionId: specVersionId('spec_conf_000001'),
    feedback: 'please tighten criterion 2',
  }),
  'spec.superseded': () => ({
    supersededSpecVersionId: specVersionId('spec_conf_000001'),
    newSpecVersionId: specVersionId('spec_conf_000002'),
    nextPhase: 'specifying',
  }),
  'limit.classified.prompt_turn': (ctx) => ({ segmentId: ctx.segment, classification: ctx.classification }),
  'limit.classified.model_switch': (ctx) => ({ segmentId: ctx.segment, classification: ctx.classification }),
  'limit.classified.git_op': (ctx) => ({
    segmentId: ctx.segment,
    classification: ctx.classification,
    gitOp: 'commit',
    outcome: 'completed_within_grace',
  }),
  'limit.late_signal': (ctx) => ({ segmentId: ctx.segment, classification: ctx.classification }),
  'limit.classified.no_child': (ctx) => ({ classification: ctx.classification }),
  'resume.limit.requested': () => ({ mode: 'manual' }),
  'limit.probe.still_limited': (ctx) => ({ classification: ctx.classification }),
  'pause.user.requested': () => ({}),
  'resume.user.requested': () => ({}),
  'child.exited.unexpectedly': (ctx) => ({
    segmentId: ctx.segment,
    generationId: ctx.generation, // matches the active generation (payload_check)
    exitCode: 1,
    classifiedAs: 'crash',
  }),
  'restart.exhausted': () => ({ reason: 'window_bound' }),
  'breaker.reset.requested': () => ({}),
  'provider.error.unknown': (ctx) => ({ segmentId: ctx.segment, classification: ctx.unknownClassification }),
  'recovery.running_segment_found': (ctx) => ({ segmentId: ctx.segment }),
  'cancel.requested': () => ({}),
  'model.switch.requested': (ctx) => ({ segmentId: ctx.segment, fromModel: 'model-a', toModel: 'model-b' }),
  'permission.requested': (ctx) => ({
    segmentId: ctx.segment,
    requestId: 'perm-conf-1',
    description: 'write a file inside the assigned worktree',
  }),
  'rss.soft_threshold': (ctx) => ({
    segmentId: ctx.segment,
    rssBytes: 800_000_000,
    budgetBytes: 1_024_000_000,
  }),
  'rss.hard_limit': (ctx) => ({
    segmentId: ctx.segment,
    rssBytes: 1_600_000_000,
    budgetBytes: 1_024_000_000,
    escalation: 'graceful',
  }),
  'verification.completed.failed': () => ({
    verificationId: verificationId('verif_conf_000001'),
    failedCriteria: [criterionId('crit_conf_1')],
    unprovenCriteria: [],
  }),
  'verification.completed.passed': (ctx) => {
    const verification = verificationId('verif_conf_000002');
    // W2-1: T24 is payload-validated — must CARRY a ready MergeReadiness.
    return { verificationId: verification, mergeReadiness: ctx.readyMergeReadiness(verification) };
  },
  'failover.no_live_target': () => ({ limitedProviders: ['claude', 'codex'] }),
};

// ---------------------------------------------------------------------------
// Supporting (non-trigger) event types — every DomainEventType NOT claimed
// by a §6.3 row. Compile-time guarded against drift below.
// ---------------------------------------------------------------------------
const SUPPORTING_EVENT_TYPES = [
  'transition.rejected',
  'workflow.dispatch.advanced',
  'budget.exceeded',
  'artifact.admission.rejected',
  'checkpoint.requested',
  'checkpoint.recorded',
  'model.switch.confirmed',
  'model.switch.failed',
  'warn.rss_soft',
  'notify.requested',
  'limit.incident.recorded',
  'scheduler.provider_limit.noted',
  'segment.stop.requested',
  'process_group.reap.requested',
  'process.identity.alert', // W2-6: §14 withheld-signal alert (durable fact)
  'segment.restart.initiated',
  'segment.resume.initiated',
  // W2-1/W2-3 generation-tracked child lifecycle + operation-axis events +
  // re-entry ack: folded by `makeEngineReducer`, still NOT §6.3 rows —
  // `applyTransition` rejects them.
  'child.spawn.initiated',
  'child.spawned',
  'child.stopped',
  'child.stop.intent',
  'turn.started',
  'turn.completed',
  'resume_reentry.completed',
  'segment.successor.required',
  'breaker.opened',
  'worktree.tainted',
  'worktree.validation.required',
  'assignments.marked_stale',
  'remediation.started',
  'merge.readiness.recorded',
  'merge.readiness.blocked', // W2-2: user-actionable blocked path (remains verifying — supporting on purpose)
  'verification.runner.violation', // W3-1: runner-confinement incident (durable fact — supporting on purpose)
  'recovery.initiated',
  'permission.decision.required',
  'limit.probe.scheduled',
  'limit.probe.claimed', // W2-4 vocabulary (defined in W2-1)
  'limit.probe.inconclusive', // W2-4 vocabulary (defined in W2-1)
  'orchestrator.heartbeat',
  'alert.raised', // P4b-1: durable operator alert, folded into its trigger's txn
  'alert.delivered', // P4b-1: at-least-once delivery ack (dedup by alertId/sink)
  'resource.exhausted', // F1/F3: engine-folded RSS-exhaustion suspension (not a §6.3 row)
  'run.memory_budget.overridden', // F3: audited per-run budget raise (plain durable fact)
] as const satisfies readonly DomainEventType[];

type SupportingEventType = (typeof SUPPORTING_EVENT_TYPES)[number];

/**
 * Compile-time exhaustiveness guard: if `EventPayloads` (events.ts) ever
 * gains a key that is neither a trigger row's event nor listed above,
 * `_MissingFromRejectionSample` stops being `never`, the conditional type
 * resolves to the object-shaped branch, and assigning the literal `true`
 * below fails to typecheck — this file cannot silently under-cover
 * rejection sampling as the event vocabulary grows.
 */
type _MissingFromRejectionSample = Exclude<DomainEventType, TriggerEventType | SupportingEventType>;
type _ExhaustivenessCheck = [_MissingFromRejectionSample] extends [never]
  ? true
  : { readonly addMissingEventTypesToSupportingList: _MissingFromRejectionSample };
const _assertNoMissingEventTypes: _ExhaustivenessCheck = true;
void _assertNoMissingEventTypes;

// ---------------------------------------------------------------------------
// State construction from preconditions.
// ---------------------------------------------------------------------------
function operationOfKind(kind: OperationKind): Operation {
  switch (kind) {
    case 'idle':
      return OPERATION_IDLE;
    case 'prompt_turn':
      return { kind: 'prompt_turn' };
    case 'initial_config_pin':
      return { kind: 'initial_config_pin' };
    case 'model_switch':
      return { kind: 'model_switch', fromModel: 'model-a', toModel: 'model-b', requestedAt: AT };
    case 'checkpoint_write':
      return { kind: 'checkpoint_write' };
    case 'git_op':
      return { kind: 'git_op', op: 'commit' };
    case 'resume_probe':
      return { kind: 'resume_probe' };
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unhandled operation kind: ${String(exhaustive)}`);
    }
  }
}

function suspensionOfKind(kind: SuspensionKind, returnPhase: RunPhase): Suspension {
  if (kind === 'none') return SUSPENSION_NONE;
  return { kind, reasonDetail: `conformance-fixture:${kind}`, returnPhase, enteredAt: AT };
}

/** The fixture ACTIVE generation (W2-1): shares `CTX.generation`/`CTX.segment`
 * with the payload builders so `generation_matches_active` rows apply by
 * construction. */
function liveChildFixture(status: ActiveChild['status'] = 'active'): ActiveChild {
  return { generationId: CTX.generation, segmentId: CTX.segment, status };
}

/** Builds an EngineState satisfying exactly `row.preconditions`, defaulting
 * everything else to a plain "mid-implementation, nothing unusual" baseline.
 * (`payload_check` preconditions constrain the EVENT, not the state — they
 * contribute nothing here.) */
function stateFor(row: TransitionRow): EngineState {
  let phase: RunPhase = 'implementing';
  let suspensionKind: SuspensionKind = 'none';
  let operationKind: OperationKind = 'idle';
  let childActive: boolean | undefined;

  for (const pre of row.preconditions) {
    switch (pre.kind) {
      case 'phase_in':
        phase = pre.phases[0] ?? phase;
        break;
      case 'phase_non_terminal':
        phase = 'implementing';
        break;
      case 'suspension_in':
        suspensionKind = pre.suspensions[0] ?? suspensionKind;
        break;
      case 'operation_in':
        operationKind = pre.operations[0] ?? operationKind;
        break;
      case 'child_active':
        childActive = pre.value;
        break;
      case 'payload_check':
        break; // event-shaped: no state contribution
      default: {
        const exhaustive: never = pre;
        throw new Error(`Unhandled precondition kind: ${String(exhaustive)}`);
      }
    }
  }
  // An in-flight operation implies a live child unless the row says otherwise.
  if (childActive === undefined) childActive = operationKind !== 'idle';

  return initialEngineState({
    phase,
    suspension: suspensionOfKind(suspensionKind, phase),
    operation: operationOfKind(operationKind),
    ...(childActive ? { activeChild: liveChildFixture() } : {}),
  });
}

/** A state satisfying every precondition of `row` EXCEPT `target`, which is
 * flipped to a value `checkPrecondition` rejects. `payload_check` targets are
 * violated through EVENTS (`violatingEventsFor`), never through state. */
function violatedState(row: TransitionRow, target: Precondition): EngineState {
  const base = stateFor(row);
  switch (target.kind) {
    case 'phase_in': {
      const bad = RUN_PHASES.find((p) => !target.phases.includes(p)) ?? 'cancelled';
      return { ...base, phase: bad };
    }
    case 'phase_non_terminal':
      return { ...base, phase: 'cancelled' };
    case 'suspension_in': {
      const bad = SUSPENSION_KINDS.find((k) => !target.suspensions.includes(k)) ?? 'breaker_open';
      return { ...base, suspension: suspensionOfKind(bad, base.phase) };
    }
    case 'operation_in': {
      const bad = OPERATION_KINDS.find((k) => !target.operations.includes(k)) ?? 'idle';
      return { ...base, operation: operationOfKind(bad) };
    }
    case 'child_active':
      // Flip liveness while PRESERVING the generation record: a required-live
      // child becomes the same generation with its stop confirmed, so a
      // sibling `generation_matches_active` check stays satisfied (only the
      // targeted precondition is violated).
      return target.value
        ? { ...base, activeChild: liveChildFixture('stopped') }
        : { ...base, activeChild: liveChildFixture() };
    case 'payload_check':
      throw new Error('payload_check is violated via violatingEventsFor(), not via state');
    default: {
      const exhaustive: never = target;
      throw new Error(`Unhandled precondition kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * W2-1: the violating EVENTS for a `payload_check` precondition — the state
 * stays fully satisfying, the payload alone causes the rejection.
 */
function violatingEventsFor(
  row: TransitionRow,
  check: 'merge_readiness_ready' | 'generation_matches_active',
): ReadonlyArray<readonly [label: string, event: DomainEvent]> {
  switch (check) {
    case 'merge_readiness_ready': {
      const verification = verificationId('verif_conf_bad_001');
      const notReady: DomainEvent = {
        type: 'verification.completed.passed',
        runId: RUN,
        sequence: SEQUENCE_UNASSIGNED,
        idempotencyKey: idempotencyKey(`conf-${row.id}-payload-notready`),
        occurredAt: AT,
        payload: {
          verificationId: verification,
          mergeReadiness: {
            ...CTX.readyMergeReadiness(verification),
            ready: false,
            destinationClean: false,
            blockers: ['the destination working tree is dirty'],
          },
        },
      } as DomainEvent;
      // Absent readiness cannot be built through the typed payload (the
      // registry REQUIRES it — that is the generator-side gate); cast to
      // prove the reducer independently rejects an untyped/legacy event.
      const absent = {
        type: 'verification.completed.passed',
        runId: RUN,
        sequence: SEQUENCE_UNASSIGNED,
        idempotencyKey: idempotencyKey(`conf-${row.id}-payload-absent`),
        occurredAt: AT,
        payload: { verificationId: verification },
      } as DomainEvent;
      return [
        ['MergeReadiness.ready !== true', notReady],
        ['MergeReadiness absent from the payload', absent],
      ];
    }
    case 'generation_matches_active': {
      // Build the ROW'S OWN event type (T13 exit report, T17 recovery
      // notice, …) from its canonical builder, then override the stamped
      // generation to a superseded one — the state stays satisfying, the
      // payload alone forces rejection ON THAT ROW.
      const basePayload = BUILDERS[row.event](CTX) as Record<string, unknown>;
      const stale: DomainEvent = {
        type: row.event,
        runId: RUN,
        sequence: SEQUENCE_UNASSIGNED,
        idempotencyKey: idempotencyKey(`conf-${row.id}-payload-stalegen`),
        occurredAt: AT,
        payload: { ...basePayload, generationId: processGenerationId('pgen_conf_stale_1') },
      } as DomainEvent;
      return [['event stamped with a superseded generation', stale]];
    }
    default: {
      const exhaustive: never = check;
      throw new Error(`Unhandled payload check: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Event construction.
// ---------------------------------------------------------------------------
/** Builds `row`'s trigger event from `BUILDERS`. A single documented cast:
 * the pairing of `type`/`payload` is correct by construction (BUILDERS is a
 * mapped type keyed by the same TriggerEventType), but a union-indexed
 * lookup like `BUILDERS[row.event]` doesn't let plain inference re-derive
 * that through `draftEvent`'s generic, so the envelope is built directly. */
function eventFor(row: TransitionRow, ctx: PayloadContext): DomainEvent {
  const payload = BUILDERS[row.event](ctx);
  return {
    type: row.event,
    runId: RUN,
    sequence: SEQUENCE_UNASSIGNED,
    idempotencyKey: idempotencyKey(`conf-${row.id}-trigger`),
    occurredAt: AT,
    payload,
  } as DomainEvent;
}

/** Single-literal-type event builder for explicit/manual test cases, where
 * ordinary generic inference (T from a literal, not a union) just works. */
function eventOf<T extends TriggerEventType>(
  type: T,
  payload: EventPayloads[T],
  key = `conf-explicit-${type}`,
): EventOfType<T> {
  return draftEvent({ type, runId: RUN, payload, idempotencyKey: idempotencyKey(key), occurredAt: AT });
}

/** An event of a type with no §6.3 row. Payload content is irrelevant: the
 * engine rejects purely on `event.type` before ever reading `payload`. */
function unlistedEvent(type: SupportingEventType): DomainEvent {
  return {
    type,
    runId: RUN,
    sequence: SEQUENCE_UNASSIGNED,
    idempotencyKey: idempotencyKey(`conf-unlisted-${type}`),
    occurredAt: AT,
    payload: {},
  } as DomainEvent;
}

// ---------------------------------------------------------------------------
// Outcome / invariant assertions.
// ---------------------------------------------------------------------------
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

function assertInvariant(
  invariant: TransitionInvariant,
  before: EngineState,
  outcome: AppliedTransition,
): void {
  switch (invariant) {
    case 'restart_counters_unchanged':
      expect(outcome.next.counters).toEqual(before.counters);
      break;
    case 'never_counts_toward_breaker':
      expect(outcome.next.counters).toEqual(before.counters);
      expect(outcome.next.suspension.kind).not.toBe('breaker_open');
      expect(outcome.emitted.map((e) => e.type)).not.toContain('breaker.opened');
      break;
    case 'phase_unchanged':
      expect(outcome.next.phase).toBe(before.phase);
      break;
    case 'suspension_unchanged':
      expect(outcome.next.suspension).toEqual(before.suspension);
      break;
    case 'respawn_count_zero': {
      // W2-1: the row never ACTIVATES a child — no restart/spawn emissions,
      // no new generation, and no child sprung to life that was not already
      // live before (a pause row's `stopping` child is the SAME generation
      // mid-confirmation, not a respawn).
      const types = outcome.emitted.map((e) => e.type);
      expect(types).not.toContain('segment.restart.initiated');
      expect(types).not.toContain('child.spawned');
      expect(outcome.next.activeChild?.generationId).toBe(before.activeChild?.generationId);
      if (!isLiveChild(before.activeChild)) {
        expect(isLiveChild(outcome.next.activeChild)).toBe(false);
      }
      break;
    }
    default: {
      const exhaustive: never = invariant;
      throw new Error(`Unhandled invariant: ${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Meta: guards the generator's own inputs against drift.
// ---------------------------------------------------------------------------
describe('conformance-suite event vocabulary bookkeeping', () => {
  it('has exactly 25 trigger rows and 43 supporting types partitioning the full vocabulary', () => {
    expect(TRANSITION_TABLE).toHaveLength(25);
    expect(TRIGGER_EVENT_TYPES).toHaveLength(25);
    expect(SUPPORTING_EVENT_TYPES).toHaveLength(43); // +resource.exhausted, +run.memory_budget.overridden (F1/F3)

    const triggerSet = new Set<string>(TRIGGER_EVENT_TYPES);
    const supportingSet = new Set<string>(SUPPORTING_EVENT_TYPES);
    expect(triggerSet.size).toBe(TRIGGER_EVENT_TYPES.length); // no dupes
    expect(supportingSet.size).toBe(SUPPORTING_EVENT_TYPES.length); // no dupes
    for (const type of supportingSet) {
      expect(triggerSet.has(type)).toBe(false); // disjoint
    }
  });
});

// ---------------------------------------------------------------------------
// PLAN §19 test 20 (positive): every row applies from a satisfying state.
// ---------------------------------------------------------------------------
describe('PLAN §19 test 20: generated positive-case coverage (every T1-T25 row)', () => {
  for (const row of TRANSITION_TABLE) {
    it(`${row.id} (${row.event}) applies from a satisfying state and honors its declared invariants`, () => {
      const state = stateFor(row);
      const event = eventFor(row, CTX);
      // Sanity on the generator itself: the fixture must satisfy the row's
      // own preconditions (payload_check rows validate the event too), or a
      // "positive" case would be vacuous.
      expect(checkPreconditions(row, state, event)).toEqual([]);

      const applied = expectApplied(applyTransition(state, event));
      expect(applied.transitionId).toBe(row.id);

      for (const invariant of row.invariants) {
        assertInvariant(invariant, state, applied);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// PLAN §19 test 20 (negative, per-row): violate one precondition at a time.
// ---------------------------------------------------------------------------
describe('PLAN §19 test 20: rejection coverage — each row rejects when any single precondition is violated', () => {
  for (const row of TRANSITION_TABLE) {
    row.preconditions.forEach((pre, index) => {
      if (pre.kind === 'payload_check') {
        // W2-1: payload-validated rows are violated through the EVENT — the
        // state stays fully satisfying, the payload alone forces rejection.
        for (const [label, badEvent] of violatingEventsFor(row, pre.check)) {
          it(`${row.id}: rejects when payload check '${pre.check}' is violated (${label})`, () => {
            const state = stateFor(row);
            expect(checkPrecondition(pre, state, badEvent)).toBeDefined();
            const otherFailures = row.preconditions
              .filter((p) => p !== pre)
              .map((p) => checkPrecondition(p, state, badEvent))
              .filter((failure): failure is string => failure !== undefined);
            expect(otherFailures).toEqual([]);

            const rejected = expectRejected(applyTransition(state, badEvent));
            expect(rejected.reason).toBe('precondition_failed');
            expect(rejected.detail).toContain(row.id);
            expect(rejected.rejectionEvent.type).toBe('transition.rejected');
            expect(rejected.rejectionEvent.payload).toMatchObject({
              attemptedEventType: row.event,
              reason: 'precondition_failed',
            });
          });
        }
        return;
      }
      it(`${row.id}: rejects when precondition #${index} (${pre.kind}) is violated (others held satisfied)`, () => {
        const state = violatedState(row, pre);
        const event = eventFor(row, CTX);
        // Sanity: violatedState broke EXACTLY the targeted precondition.
        expect(checkPrecondition(pre, state, event)).toBeDefined();
        const otherFailures = row.preconditions
          .filter((p) => p !== pre)
          .map((p) => checkPrecondition(p, state, event))
          .filter((failure): failure is string => failure !== undefined);
        expect(otherFailures).toEqual([]);

        const rejected = expectRejected(applyTransition(state, event));
        expect(rejected.reason).toBe('precondition_failed');
        expect(rejected.detail).toContain(row.id);
        expect(rejected.rejectionEvent.type).toBe('transition.rejected');
        expect(rejected.rejectionEvent.runId).toBe(RUN);
        expect(rejected.rejectionEvent.payload).toMatchObject({
          attemptedEventType: row.event,
          reason: 'precondition_failed',
        });
      });
    });
  }
});

// ---------------------------------------------------------------------------
// PLAN §19 test 20 (negative, global): every unlisted event type is illegal.
// ---------------------------------------------------------------------------
describe('PLAN §19 test 20: rejection coverage — every supporting/unlisted event type is illegal engine input', () => {
  for (const type of SUPPORTING_EVENT_TYPES) {
    it(`${type} has no §6.3 row and is rejected as unlisted_event from an arbitrary active state`, () => {
      expect(transitionForEvent(type)).toBeUndefined();
      const state = initialEngineState({
        phase: 'implementing',
        activeChild: liveChildFixture(),
        operation: { kind: 'prompt_turn' },
      });
      const rejected = expectRejected(applyTransition(state, unlistedEvent(type)));
      expect(rejected.reason).toBe('unlisted_event');
      expect(rejected.rejectionEvent.type).toBe('transition.rejected');
      expect(rejected.rejectionEvent.payload).toMatchObject({ attemptedEventType: type });
    });
  }
});

// ---------------------------------------------------------------------------
// PLAN §19 test 11: supersession makes open assignments stale.
// ---------------------------------------------------------------------------
describe('PLAN §19 test 11: supersession (T3) marks open assignments stale', () => {
  const supersededId = specVersionId('spec_super_000001');
  const newId = specVersionId('spec_super_000002');
  const nonTerminalPhases = RUN_PHASES.filter((phase) => !isTerminalPhase(phase));

  it.each(nonTerminalPhases)(
    'from phase=%s: emits assignments.marked_stale referencing the superseded spec version, and adopts the new-spec-flow phase',
    (phase) => {
      const state = initialEngineState({ phase });
      const outcome = expectApplied(
        applyTransition(
          state,
          eventOf('spec.superseded', {
            supersededSpecVersionId: supersededId,
            newSpecVersionId: newId,
            nextPhase: 'specifying',
          }),
        ),
      );
      expect(outcome.transitionId).toBe('T3');
      expect(outcome.next.phase).toBe('specifying');
      const stale = outcome.emitted.find((e) => e.type === 'assignments.marked_stale');
      expect(stale).toBeDefined();
      expect(stale?.payload).toMatchObject({ supersededSpecVersionId: supersededId });
    },
  );

  it('rejects supersession once the run is already terminal (nothing left to mark stale)', () => {
    for (const phase of TERMINAL_PHASES) {
      const state = initialEngineState({ phase });
      const rejected = expectRejected(
        applyTransition(
          state,
          eventOf('spec.superseded', {
            supersededSpecVersionId: supersededId,
            nextPhase: 'specifying',
          }),
        ),
      );
      expect(rejected.reason).toBe('precondition_failed');
    }
  });
});

// ---------------------------------------------------------------------------
// Targeted effect-branch coverage: the second branch of conditional effects
// the single generated case per row (above) doesn't reach.
// ---------------------------------------------------------------------------
describe('targeted effect-branch coverage (beyond the one generated case per row)', () => {
  it('T6: a git_op limit terminated at the grace deadline taints the worktree (never claims a clean stop)', () => {
    const row = transitionById('T6');
    const state = stateFor(row);
    const event = eventOf('limit.classified.git_op', {
      segmentId: CTX.segment,
      classification: CTX.classification,
      gitOp: 'commit',
      outcome: 'deadline_terminated',
    });
    const applied = expectApplied(applyTransition(state, event));
    const types = applied.emitted.map((e) => e.type);
    expect(types).toContain('worktree.tainted');
    const stop = applied.emitted.find((e) => e.type === 'segment.stop.requested');
    expect(stop?.payload).toMatchObject({ mode: 'terminate' });
    const taint = applied.emitted.find((e) => e.type === 'worktree.tainted');
    expect(taint?.payload).toMatchObject({ taint: 'deadline_termination' });
  });

  it('T22: RSS hard-limit emergency escalation terminates and taints — no checkpoint is claimed', () => {
    const row = transitionById('T22');
    const state = stateFor(row);
    const event = eventOf('rss.hard_limit', {
      segmentId: CTX.segment,
      rssBytes: 2_000_000_000,
      budgetBytes: 1_024_000_000,
      escalation: 'emergency_kill',
    });
    const applied = expectApplied(applyTransition(state, event));
    expect(applied.emitted.map((e) => e.type)).toEqual(['segment.stop.requested', 'worktree.tainted']);
  });

  it('T5: a limit mid model-switch marks failed_indeterminate and always requires a successor with model re-assertion', () => {
    const row = transitionById('T5');
    const state = stateFor(row);
    const applied = expectApplied(applyTransition(state, eventFor(row, CTX)));
    const failed = applied.emitted.find((e) => e.type === 'model.switch.failed');
    expect(failed?.payload).toMatchObject({
      fromModel: 'model-a',
      toModel: 'model-b',
      reason: 'failed_indeterminate',
    });
    const successor = applied.emitted.find((e) => e.type === 'segment.successor.required');
    expect(successor?.payload).toMatchObject({
      reason: 'model_switch_indeterminate',
      reassertModel: true,
    });
  });

  it('T24 (amended row, W2-1): a ready-carrying T24 reaches merge_ready and records the readiness', () => {
    const row = transitionById('T24');
    const state = stateFor(row);
    const applied = expectApplied(applyTransition(state, eventFor(row, CTX)));
    expect(applied.next.phase).toBe('merge_ready');
    const recorded = applied.emitted.find((e) => e.type === 'merge.readiness.recorded');
    expect(recorded?.payload).toMatchObject({ verificationId: verificationId('verif_conf_000002') });
  });

  it('T23 (amended row, W2-2 narrowing W1-F1): agent-actionable §16 blockers — zero failed/unproven criteria, mixed agent+user blockers — still drive needs_remediation, never merge_ready', () => {
    // The narrowed §6.3 T23 trigger (W2-2): "verification: any criterion
    // failed/unproven, OR agent-actionable §16 readiness blockers (worktree
    // dirty post-verification; mixed agent+user sets included)". The
    // readiness-blocked shape carries EMPTY criteria lists (they all
    // verified) plus the blockers — the row must apply identically. A MIXED
    // set (agent worktree-dirt + user destination-dirt) is the T23 case the
    // generator still produces; a user-ONLY set routes to the
    // `merge.readiness.blocked` supporting path and never reaches this row.
    const row = transitionById('T23');
    const state = stateFor(row);
    const event = eventOf('verification.completed.failed', {
      verificationId: verificationId('verif_conf_000003'),
      failedCriteria: [],
      unprovenCriteria: [],
      readinessBlockers: [
        'implementation worktree dirty after verification commands (files: build/generated.lock)',
        'the destination working tree is dirty (human action: commit or stash the destination changes)',
      ],
    });
    const applied = expectApplied(applyTransition(state, event));
    expect(applied.transitionId).toBe('T23');
    expect(applied.next.phase).toBe('needs_remediation');
    expect(applied.emitted.map((e) => e.type)).toContain('remediation.started');
    // The readiness-blocked shape NEVER routes to the T24 effects.
    expect(applied.emitted.map((e) => e.type)).not.toContain('merge.readiness.recorded');
  });
});

// ---------------------------------------------------------------------------
// W2-1 targeted coverage: amended rows + the engine-folded child lifecycle.
// ---------------------------------------------------------------------------
describe('W2-1: T4 covers the initial_config_pin operation (limit during pin enforcement)', () => {
  it('a limit envelope during initial pinning pauses exactly like a prompt-turn limit (no successor, generation stopping)', () => {
    const state = initialEngineState({
      phase: 'implementing',
      operation: { kind: 'initial_config_pin' },
      activeChild: liveChildFixture(),
    });
    const applied = expectApplied(
      applyTransition(
        state,
        eventOf('limit.classified.prompt_turn', { segmentId: CTX.segment, classification: CTX.classification }),
      ),
    );
    expect(applied.transitionId).toBe('T4');
    expect(applied.next.suspension).toMatchObject({
      kind: 'paused_limit',
      returnPhase: 'implementing',
      inFlightOperation: 'initial_config_pin',
    });
    expect(applied.next.activeChild).toMatchObject({
      generationId: CTX.generation,
      status: 'stopping',
      stopCause: 'limit_pause',
    });
    const types = applied.emitted.map((e) => e.type);
    expect(types).toContain('child.stop.intent');
    expect(types).not.toContain('segment.successor.required'); // identical no-successor effects
    expect(types).not.toContain('segment.restart.initiated');
  });
});

describe('W2-1: T11 user pause completes only on the generation-matched stop confirmation', () => {
  const pauseState = initialEngineState({
    phase: 'implementing',
    operation: { kind: 'prompt_turn' },
    activeChild: liveChildFixture(),
  });

  function pausedDraft(): { state: EngineState; emittedTypes: string[] } {
    const applied = expectApplied(applyTransition(pauseState, eventOf('pause.user.requested', {})));
    return { state: applied.next, emittedTypes: applied.emitted.map((e) => e.type) };
  }

  it('T11 records the durable stop-intent and marks the generation stopping — suspension does NOT fold yet', () => {
    const { state, emittedTypes } = pausedDraft();
    expect(state.suspension.kind).toBe('none'); // pause = intent, not yet paused
    expect(state.activeChild).toMatchObject({
      generationId: CTX.generation,
      status: 'stopping',
      stopCause: 'user_pause',
    });
    expect(emittedTypes).toEqual([
      'checkpoint.requested',
      'child.stop.intent',
      'segment.stop.requested',
      'notify.requested',
    ]);
  });

  it('the generation-matched child.stopped folds suspension=paused_user{return_phase} and confirms the stop', () => {
    const { state } = pausedDraft();
    const stopped = draftEvent({
      type: 'child.stopped',
      runId: RUN,
      payload: { generationId: CTX.generation, segmentId: CTX.segment, reason: 'graceful' },
      idempotencyKey: idempotencyKey('conf-w21-t11-stop'),
      occurredAt: AT,
    });
    const next = foldChildStopped(state, stopped);
    expect(next.suspension).toMatchObject({ kind: 'paused_user', returnPhase: 'implementing' });
    expect(next.activeChild).toMatchObject({ generationId: CTX.generation, status: 'stopped' });
    expect(next.activeChild).not.toHaveProperty('stopCause');
    // Idempotent redelivery: folding the same confirmation again changes nothing.
    expect(foldChildStopped(next, stopped)).toEqual(next);
  });

  it('a LATE child.stopped from a superseded generation clears nothing (generation-matched)', () => {
    const { state } = pausedDraft();
    const staleStop = draftEvent({
      type: 'child.stopped',
      runId: RUN,
      payload: { generationId: processGenerationId('pgen_conf_old_1'), reason: 'exited' },
      idempotencyKey: idempotencyKey('conf-w21-t11-stale-stop'),
      occurredAt: AT,
    });
    const next = foldChildStopped(state, staleStop);
    expect(next).toEqual(state); // still stopping, still un-paused
    expect(next.activeChild?.status).toBe('stopping');
    expect(next.suspension.kind).toBe('none');
  });

  it('a limit pause that superseded the user pause mid-stop keeps paused_limit at confirmation (no overwrite)', () => {
    const { state } = pausedDraft();
    // A T16-style suspension landed before the stop confirmation arrived.
    const suspended: EngineState = {
      ...state,
      suspension: {
        kind: 'paused_limit',
        reasonDetail: 'unknown_provider_error:codex',
        returnPhase: state.phase,
        enteredAt: AT,
      },
    };
    const stopped = draftEvent({
      type: 'child.stopped',
      runId: RUN,
      payload: { generationId: CTX.generation, reason: 'graceful' },
      idempotencyKey: idempotencyKey('conf-w21-t11-superseded'),
      occurredAt: AT,
    });
    const next = foldChildStopped(suspended, stopped);
    expect(next.suspension.kind).toBe('paused_limit'); // never downgraded to paused_user
    expect(next.activeChild?.status).toBe('stopped');
  });
});

describe('W2-1: T13 interrupts (fold counters, mark generation stopped, manual resume) — never respawns', () => {
  const crashState = initialEngineState({
    phase: 'implementing',
    operation: { kind: 'prompt_turn' },
    activeChild: liveChildFixture(),
  });
  const crash = eventOf('child.exited.unexpectedly', {
    segmentId: CTX.segment,
    generationId: CTX.generation,
    exitCode: 1,
    classifiedAs: 'crash',
  });

  it('folds both restart counters, suspends interrupted{return_phase}, and emits NO restart', () => {
    const applied = expectApplied(applyTransition(crashState, crash));
    expect(applied.transitionId).toBe('T13');
    expect(applied.next.suspension).toMatchObject({
      kind: 'interrupted',
      returnPhase: 'implementing',
      inFlightOperation: 'prompt_turn',
    });
    expect(applied.next.counters.restartsInWindow).toBe(1);
    expect(applied.next.counters.lifetimeRestarts).toBe(1);
    expect(applied.next.activeChild).toMatchObject({ generationId: CTX.generation, status: 'stopped' });
    expect(isLiveChild(applied.next.activeChild)).toBe(false);
    const types = applied.emitted.map((e) => e.type);
    expect(types).toEqual(['worktree.validation.required', 'notify.requested']);
    const notify = applied.emitted.find((e) => e.type === 'notify.requested');
    expect(notify?.payload).toMatchObject({ topic: 'interrupted' });
  });

  it('an UNSTAMPED exit report (no generationId) still applies against the active generation', () => {
    const unstamped = eventOf('child.exited.unexpectedly', {
      segmentId: CTX.segment,
      exitCode: 137,
      signal: 'SIGKILL',
      classifiedAs: 'crash',
    });
    const applied = expectApplied(applyTransition(crashState, unstamped));
    expect(applied.next.suspension.kind).toBe('interrupted');
  });

  it('resume from interrupted is legal via T12 (manual re-entry) and records the pending re-entry', () => {
    const interrupted = expectApplied(applyTransition(crashState, crash)).next;
    const resumed = expectApplied(applyTransition(interrupted, eventOf('resume.user.requested', {})));
    expect(resumed.transitionId).toBe('T12');
    expect(resumed.next.phase).toBe('implementing');
    expect(resumed.next.suspension.kind).toBe('none');
    expect(isLiveChild(resumed.next.activeChild)).toBe(false); // never marks a child active
    expect(resumed.next.resumeReentryPending).toMatchObject({ returnPhase: 'implementing', mode: 'manual' });
  });
});

describe('W2-1: T9/T12 record a pending re-entry; child.spawned/resume_reentry.completed close the loop', () => {
  const paused = initialEngineState({
    phase: 'verifying',
    suspension: {
      kind: 'paused_limit',
      reasonDetail: 'usage_limit:claude',
      returnPhase: 'verifying',
      enteredAt: AT,
    },
    activeChild: liveChildFixture('stopped'),
    counters: { restartsInWindow: 0, lifetimeRestarts: 2, probeCount: 4, remediationRounds: 0 },
  });

  it('T9 (scheduled probe) clears the suspension, resets the probe count, and records resume_reentry_pending — NO childActive', () => {
    const applied = expectApplied(
      applyTransition(paused, eventOf('resume.limit.requested', { mode: 'scheduled_probe' })),
    );
    expect(applied.transitionId).toBe('T9');
    expect(applied.next.phase).toBe('verifying');
    expect(applied.next.suspension.kind).toBe('none');
    expect(isLiveChild(applied.next.activeChild)).toBe(false);
    expect(applied.next.counters.probeCount).toBe(0);
    expect(applied.next.resumeReentryPending).toMatchObject({
      returnPhase: 'verifying',
      mode: 'scheduled_probe',
      recordedAt: AT,
    });
    expect(applied.emitted.map((e) => e.type)).toEqual(['segment.resume.initiated']);
  });

  it('child.spawned sets the ACTIVE generation; resume_reentry.completed acks and clears the pending re-entry (idempotently)', () => {
    const resumed = expectApplied(
      applyTransition(paused, eventOf('resume.limit.requested', { mode: 'manual' })),
    ).next;
    const nextGeneration = processGenerationId('pgen_conf_000002');
    const spawned = foldChildSpawned(
      resumed,
      draftEvent({
        type: 'child.spawned',
        runId: RUN,
        payload: {
          generationId: nextGeneration,
          segmentId: segmentId('seg_conf_000002'),
          role: 'verifier',
          pins: [
            { purpose: 'model', optionId: 'model', value: 'model-b', effectiveValue: 'model-b', echoed: true },
            { purpose: 'effort', optionId: 'effort', value: 'high', echoed: false },
          ],
        },
        idempotencyKey: idempotencyKey('conf-w21-spawned'),
        occurredAt: AT,
      }),
    );
    expect(spawned.activeChild).toEqual({
      generationId: nextGeneration,
      segmentId: segmentId('seg_conf_000002'),
      status: 'active',
    });
    expect(spawned.resumeReentryPending).toBeDefined(); // spawn alone is NOT the ack

    const acked = foldResumeReentryCompleted(spawned);
    expect(acked.resumeReentryPending).toBeUndefined();
    expect(foldResumeReentryCompleted(acked)).toEqual(acked); // idempotent reclaim
  });

  it('P4b-2: a resume trigger carrying a `successor` seed folds the successor INTENT marker in the SAME write as the T9 suspension-clear (marker rides one txn; the ack clears BOTH)', () => {
    const applied = expectApplied(
      applyTransition(
        paused,
        eventOf('resume.limit.requested', {
          mode: 'manual',
          successor: {
            target: { harness: 'claude', model: 'opus', effort: 'low' },
            reason: 'model_switch_indeterminate',
            reassertModel: true,
          },
        }),
      ),
    );
    // One write: suspension cleared, resume-reentry recorded, AND the successor
    // marker folded — all in this single applied transition.
    expect(applied.next.suspension.kind).toBe('none');
    expect(applied.next.resumeReentryPending).toBeDefined();
    expect(applied.next.successorIntent).toMatchObject({
      target: { harness: 'claude', model: 'opus', effort: 'low' },
      reason: 'model_switch_indeterminate',
      reassertModel: true,
      returnPhase: 'verifying',
    });
    // The resume-initiated effect signals the spine via `via: 'successor'`.
    const init = applied.emitted.find((e) => e.type === 'segment.resume.initiated');
    expect((init?.payload as { via?: string }).via).toBe('successor');
    // A plain resume (no seed) records NO successor marker (`via: undetermined`).
    const plain = expectApplied(applyTransition(paused, eventOf('resume.limit.requested', { mode: 'manual' })));
    expect(plain.next.successorIntent).toBeUndefined();
    // The SAME `resume_reentry.completed` ack clears BOTH markers (idempotent).
    const acked = foldResumeReentryCompleted(applied.next);
    expect(acked.resumeReentryPending).toBeUndefined();
    expect(acked.successorIntent).toBeUndefined();
    expect(foldResumeReentryCompleted(acked)).toEqual(acked);
  });

  it('a LATE child.stopped from the pre-pause generation does not clear the freshly spawned one', () => {
    const resumed = expectApplied(
      applyTransition(paused, eventOf('resume.limit.requested', { mode: 'manual' })),
    ).next;
    const spawned = foldChildSpawned(
      resumed,
      draftEvent({
        type: 'child.spawned',
        runId: RUN,
        payload: {
          generationId: processGenerationId('pgen_conf_000002'),
          segmentId: segmentId('seg_conf_000002'),
          role: 'implementor',
          pins: [],
        },
        idempotencyKey: idempotencyKey('conf-w21-spawned-2'),
        occurredAt: AT,
      }),
    );
    const lateStop = draftEvent({
      type: 'child.stopped',
      runId: RUN,
      payload: { generationId: CTX.generation, reason: 'terminated' }, // generation N, already superseded
      idempotencyKey: idempotencyKey('conf-w21-late-stop'),
      occurredAt: AT,
    });
    const next = foldChildStopped(spawned, lateStop);
    expect(next).toEqual(spawned);
    expect(next.activeChild?.status).toBe('active'); // N+1 untouched
  });
});

describe('W2-1: T10 purified — the reducer folds the probe count and NOTHING else', () => {
  const paused = initialEngineState({
    phase: 'implementing',
    suspension: {
      kind: 'paused_limit',
      reasonDetail: 'usage_limit:codex',
      returnPhase: 'implementing',
      enteredAt: AT,
    },
  });

  it('increments probeCount with zero emissions (scheduling is the pure scheduler via limit.probe.scheduled)', () => {
    const applied = expectApplied(
      applyTransition(paused, eventOf('limit.probe.still_limited', { classification: CTX.classification })),
    );
    expect(applied.next.counters.probeCount).toBe(1);
    expect(applied.emitted).toEqual([]); // no limit.probe.scheduled from the reducer — ever
    expect(applied.next.phase).toBe(paused.phase);
    expect(applied.next.suspension).toEqual(paused.suspension);
  });

  it('keeps folding beyond the ladder cap — per-incident exhaustion is a scheduler decision, not a reducer one', () => {
    let state = paused;
    for (let i = 1; i <= state.bounds.probeMax + 2; i += 1) {
      const applied = expectApplied(
        applyTransition(state, eventOf('limit.probe.still_limited', {}, `conf-w21-t10-${i}`)),
      );
      expect(applied.next.counters.probeCount).toBe(i);
      expect(applied.emitted).toEqual([]);
      state = applied.next;
    }
  });
});

describe('W2-3: spawn/turn operation-axis folds license the pause rows durably', () => {
  const idle = initialEngineState({ phase: 'implementing' });
  const spawnInitiated = draftEvent({
    type: 'child.spawn.initiated',
    runId: RUN,
    payload: { generationId: CTX.generation, segmentId: CTX.segment, role: 'implementor' },
    idempotencyKey: idempotencyKey('conf-w23-spawn-init'),
    occurredAt: AT,
  });

  it('child.spawn.initiated marks the generation SPAWNING and opens the initial_config_pin window — T4 applies mid-pin', () => {
    const pinning = foldChildSpawnInitiated(idle, spawnInitiated);
    expect(pinning.activeChild).toEqual({
      generationId: CTX.generation,
      segmentId: CTX.segment,
      status: 'spawning',
    });
    expect(pinning.operation.kind).toBe('initial_config_pin');
    expect(isLiveChild(pinning.activeChild)).toBe(true); // a spawning child is live

    // A limit envelope DURING pinning now satisfies T4's preconditions.
    const applied = expectApplied(
      applyTransition(
        pinning,
        eventOf('limit.classified.prompt_turn', { segmentId: CTX.segment, classification: CTX.classification }),
      ),
    );
    expect(applied.transitionId).toBe('T4');
    expect(applied.next.activeChild).toMatchObject({ status: 'stopping', stopCause: 'limit_pause' });
    expect(applied.next.suspension).toMatchObject({
      kind: 'paused_limit',
      inFlightOperation: 'initial_config_pin',
    });
  });

  it('child.spawned closes the pin window (operation → idle) and marks the generation ACTIVE', () => {
    const pinning = foldChildSpawnInitiated(idle, spawnInitiated);
    const active = foldChildSpawned(
      pinning,
      draftEvent({
        type: 'child.spawned',
        runId: RUN,
        payload: { generationId: CTX.generation, segmentId: CTX.segment, role: 'implementor', pins: [] },
        idempotencyKey: idempotencyKey('conf-w23-spawned'),
        occurredAt: AT,
      }),
    );
    expect(active.activeChild?.status).toBe('active');
    expect(active.operation.kind).toBe('idle');
  });

  it('turn.started/turn.completed bracket the prompt_turn operation; completion is idempotent and never clears other operations', () => {
    const pinning = foldChildSpawnInitiated(idle, spawnInitiated);
    const active = foldChildSpawned(
      pinning,
      draftEvent({
        type: 'child.spawned',
        runId: RUN,
        payload: { generationId: CTX.generation, segmentId: CTX.segment, role: 'implementor', pins: [] },
        idempotencyKey: idempotencyKey('conf-w23-spawned-2'),
        occurredAt: AT,
      }),
    );
    const inTurn = foldTurnStarted(active);
    expect(inTurn.operation.kind).toBe('prompt_turn');

    // A mid-turn limit envelope licenses T4 from the DURABLE state.
    const applied = expectApplied(
      applyTransition(
        inTurn,
        eventOf('limit.classified.prompt_turn', { segmentId: CTX.segment, classification: CTX.classification }),
      ),
    );
    expect(applied.next.suspension).toMatchObject({ inFlightOperation: 'prompt_turn' });

    const done = foldTurnCompleted(inTurn);
    expect(done.operation.kind).toBe('idle');
    expect(foldTurnCompleted(done)).toEqual(done); // idempotent redelivery

    // A late/duplicated completion after T4 folded the operation idle (and
    // T4's own row set it) must not disturb a non-prompt_turn operation.
    const pinWindow = foldChildSpawnInitiated(idle, spawnInitiated);
    expect(foldTurnCompleted(pinWindow).operation.kind).toBe('initial_config_pin');
  });
});
