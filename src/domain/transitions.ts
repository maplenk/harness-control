/**
 * §6.3 transition table AS DATA + pure transition engine.
 *
 * - `TRANSITION_TABLE` is the normative T1–T25 table encoded with typed
 *   precondition/effect DESCRIPTORS (plain data, machine-readable) so the P1
 *   conformance suite (PLAN §19 test 20) can be GENERATED from it.
 * - `applyTransition(state, event)` is pure and deterministic:
 *   `{applied, next, emitted}` or `{rejected, reason}`. Any (state, event)
 *   pair not licensed by the table is ILLEGAL and rejects with a
 *   ready-to-append `transition.rejected` event (§6.3 rule).
 * - Emitted events derive their idempotency keys deterministically from the
 *   trigger event's key — no clocks or randomness inside the engine.
 * - Each row triggers on exactly ONE event type (one type per transition).
 *   Where PLAN rows share a real-world signal (limit envelopes, T4/T5/T6/T8),
 *   the application service selects the precise event from the segment's
 *   `operation` axis; the row's preconditions re-assert it, so a mismatched
 *   emission still rejects.
 *
 * Non-table micro-flows (§11.2 model-switch confirm/fail bookkeeping) are
 * recorded via SUPPORTING events by their coordinators, not via this engine.
 */
import type { IsoTimestamp } from '../lib/clock.js';
import type { ProcessGenerationId, RunId, SegmentId, SpecHash } from './ids.js';
import {
  DEFAULT_BOUNDS,
  OPERATION_IDLE,
  SUSPENSION_NONE,
  ZERO_COUNTERS,
  isLiveChild,
  isTerminalPhase,
  type ActiveChild,
  type EngineBounds,
  type Operation,
  type OperationKind,
  type RestartCounters,
  type ResumeReentryPending,
  type RunPhase,
  type SpecApprovalMode,
  type StopIntentCause,
  stopIntentConfirmation,
  type SuccessorIntent,
  type SuccessorIntentSeed,
  type Suspension,
  type SuspensionKind,
} from './state.js';
import {
  deriveIdempotencyKey,
  draftEvent,
  type DomainEvent,
  type DomainEventType,
  type EventOfType,
  type EventPayloads,
  type LimitClassification,
  type NotifyTopic,
  type SpecDraftRef,
  type SuccessorReason,
} from './events.js';

// ---------------------------------------------------------------------------
// Trigger event types — exactly one per §6.3 row.
// ---------------------------------------------------------------------------
export const TRIGGER_EVENT_TYPES = [
  'spec.approved', // T1
  'spec.revise.requested', // T2
  'spec.superseded', // T3
  'limit.classified.prompt_turn', // T4
  'limit.classified.model_switch', // T5
  'limit.classified.git_op', // T6
  'limit.late_signal', // T7
  'limit.classified.no_child', // T8
  'resume.limit.requested', // T9
  'limit.probe.still_limited', // T10
  'pause.user.requested', // T11
  'resume.user.requested', // T12
  'child.exited.unexpectedly', // T13
  'restart.exhausted', // T14
  'breaker.reset.requested', // T15
  'provider.error.unknown', // T16
  'recovery.running_segment_found', // T17
  'cancel.requested', // T18
  'model.switch.requested', // T19
  'permission.requested', // T20
  'rss.soft_threshold', // T21
  'rss.hard_limit', // T22
  'verification.completed.failed', // T23
  'verification.completed.passed', // T24
  'failover.no_live_target', // T25
] as const satisfies readonly DomainEventType[];

export type TriggerEventType = (typeof TRIGGER_EVENT_TYPES)[number];

export type TransitionId =
  | 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8' | 'T9' | 'T10'
  | 'T11' | 'T12' | 'T13' | 'T14' | 'T15' | 'T16' | 'T17' | 'T18' | 'T19' | 'T20'
  | 'T21' | 'T22' | 'T23' | 'T24' | 'T25';

// ---------------------------------------------------------------------------
// Typed precondition descriptors (evaluated against EngineState — and, for
// `payload_check` rows, against the TRIGGER EVENT itself: W2-1 made two rows
// payload-validated, so a malformed trigger rejects exactly like a wrong
// state instead of silently escaping its generator)
// ---------------------------------------------------------------------------
/**
 * Named payload validations (W2-1):
 *  - `merge_readiness_ready` (T24): the event must CARRY a `MergeReadiness`
 *    with `ready === true` — reducer + conformance reject otherwise.
 *  - `generation_matches_active` (T13): a generation-stamped exit report must
 *    name the ACTIVE generation; a stale report from a superseded generation
 *    rejects (same rule as generation-matched `child.stopped`). An unstamped
 *    report (no `generationId`) is accepted against the active child.
 */
export type PayloadCheckName = 'merge_readiness_ready' | 'generation_matches_active';

export type Precondition =
  | { readonly kind: 'phase_in'; readonly phases: readonly RunPhase[] }
  | { readonly kind: 'phase_non_terminal' }
  | { readonly kind: 'suspension_in'; readonly suspensions: readonly SuspensionKind[] }
  | { readonly kind: 'operation_in'; readonly operations: readonly OperationKind[] }
  | { readonly kind: 'child_active'; readonly value: boolean }
  | { readonly kind: 'payload_check'; readonly check: PayloadCheckName };

// ---------------------------------------------------------------------------
// Typed effect descriptors (interpreted in row order by the engine)
// ---------------------------------------------------------------------------
export type EffectDescriptor =
  | { readonly kind: 'set_phase'; readonly phase: RunPhase }
  | { readonly kind: 'set_phase_from_event' } // T3: payload.nextPhase
  | { readonly kind: 'set_phase_to_return_phase' } // T9/T12
  | { readonly kind: 'bind_spec_hash' } // T1
  | { readonly kind: 'mark_assignments_stale' } // T3
  | {
      readonly kind: 'suspend';
      readonly to: Exclude<SuspensionKind, 'none'>;
      /** Capture the operation in flight at trigger time (§6.2). */
      readonly recordInFlightOperation: boolean;
    }
  | { readonly kind: 'clear_suspension' }
  | { readonly kind: 'set_operation_idle' }
  | { readonly kind: 'begin_model_switch' } // T19
  | { readonly kind: 'mechanical_checkpoint'; readonly reason: 'pre_pause' | 'pre_graceful_stop' }
  /**
   * W2-1 pause-path stop: mark the ACTIVE generation `stopping` with a
   * durable stop-intent (`child.stop.intent` in the same atomic append) and
   * request the graceful transport stop. The generation stays live until a
   * generation-matched `child.stopped` confirms; for `user_pause` the
   * `paused_user` suspension folds only at that confirmation (T11).
   */
  | { readonly kind: 'request_child_stop'; readonly cause: StopIntentCause }
  | { readonly kind: 'mark_generation_stopped' } // T17 (orchestrator lost the child)
  | { readonly kind: 'record_limit_incident'; readonly incidentKind: 'usage_limit' | 'unknown' }
  | { readonly kind: 'mark_switch_failed_indeterminate' } // T5
  | {
      readonly kind: 'require_successor';
      readonly reason: SuccessorReason;
      readonly reassertModel: boolean;
    }
  | { readonly kind: 'git_grace_outcome' } // T6
  /**
   * W2-1 T13: fold restart counters, mark the generation stopped, suspend
   * `interrupted` (manual resume required). NEVER emits
   * `segment.restart.initiated`, never marks a child active, never decides
   * breaker exhaustion — bounded auto-respawn is P4b machinery.
   */
  | { readonly kind: 'interrupt_on_child_exit' } // T13
  | { readonly kind: 'open_breaker' } // T14
  | { readonly kind: 'reset_counters' } // T15
  | { readonly kind: 'require_worktree_validation' }
  /** W2-1 T10 purified: fold the probe count ONLY — scheduling lives in the
   * pure scheduler (W2-4), recorded as `limit.probe.scheduled`. */
  | { readonly kind: 'fold_probe_count' } // T10
  /** W2-1 T9/T12: record `resume_reentry_pending`; NEVER marks a child
   * active — `child.spawned` sets the generation, `resume_reentry.completed`
   * acks the round. */
  | { readonly kind: 'initiate_resume' } // T9/T12
  | { readonly kind: 'mark_interrupted_recovery' } // T17
  | { readonly kind: 'cancel_terminal' } // T18
  | { readonly kind: 'record_permission_pending' } // T20
  | { readonly kind: 'warn_rss_soft' } // T21
  | { readonly kind: 'rss_hard_stop' } // T22
  | { readonly kind: 'remediation_or_fail' } // T23
  | { readonly kind: 'record_merge_readiness' } // T24
  | { readonly kind: 'notify'; readonly topic: NotifyTopic; readonly message: string };

/** Machine-checkable invariants the conformance suite asserts per row. */
export type TransitionInvariant =
  | 'restart_counters_unchanged'
  | 'never_counts_toward_breaker'
  | 'phase_unchanged'
  | 'suspension_unchanged'
  | 'respawn_count_zero';

export interface TransitionRow {
  readonly id: TransitionId;
  readonly event: TriggerEventType;
  readonly description: string;
  readonly preconditions: readonly Precondition[];
  /** Interpreted strictly in order. */
  readonly effects: readonly EffectDescriptor[];
  readonly invariants: readonly TransitionInvariant[];
}

// ---------------------------------------------------------------------------
// Normative constants referenced by effects (PLAN §14)
// ---------------------------------------------------------------------------
// NOTE (W2-1, pushback item 8): the §13 probe ladder deliberately does NOT
// live here anymore — the T10 reducer only folds probe counts; scheduling is
// computed by the pure scheduler from the run's pinned config (default:
// `DEFAULT_PROBE_LADDER_MINUTES` in ./state.ts).
/** §14 graceful-stop deadline on the RSS hard-limit path (default 30s). */
export const RSS_GRACEFUL_STOP_DEADLINE_MS = 30_000;

// ---------------------------------------------------------------------------
// THE TABLE (normative §6.3; one row per transition, one event per row)
// ---------------------------------------------------------------------------
export const TRANSITION_TABLE: readonly TransitionRow[] = [
  {
    id: 'T1',
    event: 'spec.approved',
    description:
      'Spec approved: bind spec hash + signer (human, or the engine under B2 ' +
      "`approval: 'auto'`); phase=approved.",
    preconditions: [{ kind: 'phase_in', phases: ['awaiting_approval'] }],
    effects: [{ kind: 'bind_spec_hash' }, { kind: 'set_phase', phase: 'approved' }],
    invariants: ['suspension_unchanged'],
  },
  {
    id: 'T2',
    event: 'spec.revise.requested',
    description: 'spec revise --feedback: back to specifying (same run; new SpecVersion supersedes on emit).',
    preconditions: [{ kind: 'phase_in', phases: ['awaiting_approval'] }],
    effects: [{ kind: 'set_phase', phase: 'specifying' }],
    invariants: ['suspension_unchanged'],
  },
  {
    id: 'T3',
    event: 'spec.superseded',
    description: 'Spec superseded: open assignments → stale; phase per new spec flow.',
    preconditions: [{ kind: 'phase_non_terminal' }],
    effects: [{ kind: 'mark_assignments_stale' }, { kind: 'set_phase_from_event' }],
    invariants: [],
  },
  {
    id: 'T4',
    event: 'limit.classified.prompt_turn',
    description:
      'Limit envelope during prompt_turn OR initial_config_pin (W2-1): mechanical checkpoint; operation→idle; paused_limit{return_phase=phase}; generation marked stopping with durable stop-intent (child.stopped confirms); restart counter unchanged.',
    preconditions: [
      { kind: 'suspension_in', suspensions: ['none'] },
      { kind: 'operation_in', operations: ['prompt_turn', 'initial_config_pin'] },
      { kind: 'child_active', value: true },
    ],
    effects: [
      { kind: 'mechanical_checkpoint', reason: 'pre_pause' },
      { kind: 'set_operation_idle' },
      { kind: 'suspend', to: 'paused_limit', recordInFlightOperation: true },
      { kind: 'request_child_stop', cause: 'limit_pause' },
      { kind: 'record_limit_incident', incidentKind: 'usage_limit' },
      { kind: 'notify', topic: 'paused_limit', message: 'Run paused: provider usage limit.' },
    ],
    invariants: ['restart_counters_unchanged', 'respawn_count_zero'],
  },
  {
    id: 'T5',
    event: 'limit.classified.model_switch',
    description:
      'Limit during requested-unconfirmed model switch: mark failed_indeterminate; then T4; resume is ALWAYS successor with explicit model re-assertion.',
    preconditions: [
      { kind: 'suspension_in', suspensions: ['none'] },
      { kind: 'operation_in', operations: ['model_switch'] },
    ],
    effects: [
      { kind: 'mark_switch_failed_indeterminate' },
      { kind: 'require_successor', reason: 'model_switch_indeterminate', reassertModel: true },
      { kind: 'mechanical_checkpoint', reason: 'pre_pause' },
      { kind: 'set_operation_idle' },
      { kind: 'suspend', to: 'paused_limit', recordInFlightOperation: true },
      { kind: 'request_child_stop', cause: 'limit_pause' },
      { kind: 'record_limit_incident', incidentKind: 'usage_limit' },
      { kind: 'notify', topic: 'paused_limit', message: 'Run paused: provider usage limit (model switch indeterminate).' },
    ],
    invariants: ['restart_counters_unchanged', 'respawn_count_zero'],
  },
  {
    id: 'T6',
    event: 'limit.classified.git_op',
    description:
      'Limit during git_op: git op completed within grace OR was terminated at deadline (worktree TAINTED); then T4.',
    preconditions: [
      { kind: 'suspension_in', suspensions: ['none'] },
      { kind: 'operation_in', operations: ['git_op'] },
    ],
    effects: [
      { kind: 'git_grace_outcome' },
      { kind: 'mechanical_checkpoint', reason: 'pre_pause' },
      { kind: 'set_operation_idle' },
      { kind: 'suspend', to: 'paused_limit', recordInFlightOperation: true },
      { kind: 'record_limit_incident', incidentKind: 'usage_limit' },
      { kind: 'notify', topic: 'paused_limit', message: 'Run paused: provider usage limit (during git operation).' },
    ],
    invariants: ['restart_counters_unchanged', 'respawn_count_zero'],
  },
  {
    id: 'T7',
    event: 'limit.late_signal',
    description:
      'Limit signal AFTER segment closed (late update, #864): incident against closed segment; run phase unchanged; no suspension; note provider-level limit for future spawns.',
    preconditions: [],
    effects: [
      { kind: 'record_limit_incident', incidentKind: 'usage_limit' },
      { kind: 'require_worktree_validation' }, // no-op safety: validation before any future spawn is idempotent
    ],
    invariants: ['phase_unchanged', 'suspension_unchanged', 'restart_counters_unchanged'],
  },
  {
    id: 'T8',
    event: 'limit.classified.no_child',
    description: 'Limit while awaiting_approval (no active child): as T7 — incident only; nothing to suspend.',
    preconditions: [
      { kind: 'phase_in', phases: ['awaiting_approval'] },
      { kind: 'child_active', value: false },
    ],
    effects: [{ kind: 'record_limit_incident', incidentKind: 'usage_limit' }],
    invariants: ['phase_unchanged', 'suspension_unchanged', 'restart_counters_unchanged'],
  },
  {
    id: 'T9',
    event: 'resume.limit.requested',
    description:
      'Resume (scheduled probe OK / manual): records resume_reentry_pending; suspension=none; phase=return_phase. Does NOT mark a child active (W2-1) — child.spawned sets the generation, resume_reentry.completed acks the round.',
    preconditions: [{ kind: 'suspension_in', suspensions: ['paused_limit'] }],
    effects: [
      { kind: 'initiate_resume' },
      { kind: 'set_phase_to_return_phase' },
      { kind: 'clear_suspension' },
    ],
    invariants: ['respawn_count_zero'],
  },
  {
    id: 'T10',
    event: 'limit.probe.still_limited',
    description:
      'Probe still-limited: remain paused; fold probe count ONLY (W2-1) — scheduling is a pure-scheduler concern computed from the pinned per-run config (limit.probe.scheduled).',
    preconditions: [{ kind: 'suspension_in', suspensions: ['paused_limit'] }],
    effects: [{ kind: 'fold_probe_count' }],
    invariants: ['phase_unchanged', 'suspension_unchanged'],
  },
  {
    id: 'T11',
    event: 'pause.user.requested',
    description:
      'User pause (W2-1 stop-confirmed): mechanical checkpoint + durable stop-intent, generation marked stopping; suspension=paused_user folds ONLY on the generation-matched child.stopped confirmation.',
    preconditions: [
      { kind: 'suspension_in', suspensions: ['none'] },
      { kind: 'child_active', value: true },
    ],
    effects: [
      { kind: 'mechanical_checkpoint', reason: 'pre_pause' },
      { kind: 'set_operation_idle' },
      { kind: 'request_child_stop', cause: 'user_pause' },
      { kind: 'notify', topic: 'paused_user', message: 'User pause requested: stopping child at a safe point (pause completes on confirmed stop).' },
    ],
    invariants: ['restart_counters_unchanged', 'respawn_count_zero'],
  },
  {
    id: 'T12',
    event: 'resume.user.requested',
    description:
      'User resume from paused_user, interrupted, OR resource_exhausted (W2-1: manual re-entry after T13/T17 — same eligibility-checked re-entry as T9, worktree validation first §16.3): as T9. F3: a resource_exhausted resume is additionally gated in the service on an audited per-run budget raise (never at the same budget).',
    preconditions: [
      { kind: 'suspension_in', suspensions: ['paused_user', 'interrupted', 'resource_exhausted'] },
    ],
    effects: [
      { kind: 'initiate_resume' },
      { kind: 'set_phase_to_return_phase' },
      { kind: 'clear_suspension' },
    ],
    invariants: ['respawn_count_zero'],
  },
  {
    id: 'T13',
    event: 'child.exited.unexpectedly',
    description:
      'Child crash/exit (non-limit, W2-1): fold restart counters; mark that generation stopped; suspension=interrupted (manual resume required). NO restart emission, NO auto-respawn — bounded respawn is P4b. Worktree validation before re-entry (§16.3).',
    preconditions: [
      { kind: 'suspension_in', suspensions: ['none'] },
      { kind: 'child_active', value: true },
      { kind: 'payload_check', check: 'generation_matches_active' },
    ],
    effects: [
      { kind: 'require_worktree_validation' },
      { kind: 'interrupt_on_child_exit' },
      {
        kind: 'notify',
        topic: 'interrupted',
        message: 'Child exited unexpectedly; run interrupted — manual resume required (no auto-respawn in P4a).',
      },
    ],
    invariants: ['respawn_count_zero'],
  },
  {
    id: 'T14',
    event: 'restart.exhausted',
    description:
      'Restart bounds exhausted / no-progress detected: breaker_open; notify. F4 (§5x): guarded like T13/T17 — generation-stamped so a stale/superseded/late report cannot open the breaker over a run that has moved on to a new generation, been paused for a limit, or reached a terminal phase (an unstamped `generation_matches_active` is a no-op, so the STAMP on `restart.exhausted` is what makes this guard bite).',
    preconditions: [
      { kind: 'suspension_in', suspensions: ['none'] },
      { kind: 'phase_non_terminal' },
      { kind: 'payload_check', check: 'generation_matches_active' },
    ],
    effects: [
      { kind: 'open_breaker' },
      { kind: 'notify', topic: 'breaker_open', message: 'Breaker open: restart bounds exhausted or no progress.' },
    ],
    invariants: [],
  },
  {
    id: 'T15',
    event: 'breaker.reset.requested',
    description:
      'breaker reset (user): suspension=none; window/probe counters reset (lifetime cap preserved — non-disableable, §14); worktree validation before next spawn.',
    preconditions: [{ kind: 'suspension_in', suspensions: ['breaker_open'] }],
    effects: [
      { kind: 'clear_suspension' },
      { kind: 'reset_counters' },
      { kind: 'require_worktree_validation' },
    ],
    invariants: ['phase_unchanged'],
  },
  {
    id: 'T16',
    event: 'provider.error.unknown',
    description:
      'Ambiguous provider-call error (unknown_provider_error): as T4 but incident kind=unknown; NEVER counts toward breaker; requires probe or manual resume.',
    preconditions: [
      { kind: 'suspension_in', suspensions: ['none'] },
      { kind: 'child_active', value: true },
    ],
    effects: [
      { kind: 'mechanical_checkpoint', reason: 'pre_pause' },
      { kind: 'set_operation_idle' },
      { kind: 'suspend', to: 'paused_limit', recordInFlightOperation: true },
      { kind: 'request_child_stop', cause: 'unknown_error_pause' },
      { kind: 'record_limit_incident', incidentKind: 'unknown' },
      { kind: 'notify', topic: 'unknown_provider_error', message: 'Run paused: ambiguous provider error (fail-safe pause).' },
    ],
    invariants: ['restart_counters_unchanged', 'never_counts_toward_breaker', 'respawn_count_zero'],
  },
  {
    id: 'T17',
    event: 'recovery.running_segment_found',
    description:
      'Orchestrator restart finds `running` segment: suspension=interrupted; recovery per §12.3 → resumed segment or successor; then suspension=none. W4-4: the PURPOSE-BUILT restart transition (distinct from T13, the child-crash row — using it keeps orchestrator restarts OUT of the RestartBreaker/respawn counters). Guarded like T13 so a reap can never clobber a paused_limit run or resurrect a terminal one.',
    preconditions: [
      { kind: 'suspension_in', suspensions: ['none'] },
      { kind: 'phase_non_terminal' },
      { kind: 'child_active', value: true },
      { kind: 'payload_check', check: 'generation_matches_active' },
    ],
    effects: [
      { kind: 'suspend', to: 'interrupted', recordInFlightOperation: true },
      { kind: 'set_operation_idle' },
      { kind: 'mark_generation_stopped' },
      { kind: 'mark_interrupted_recovery' },
    ],
    invariants: ['phase_unchanged'],
  },
  {
    id: 'T18',
    event: 'cancel.requested',
    description:
      'Cancel: cancel turn → terminate group → reap → phase=cancelled (idempotent at the application layer: a duplicate cancel on a terminal run rejects here and is reported as already-cancelled).',
    preconditions: [{ kind: 'phase_non_terminal' }],
    effects: [{ kind: 'cancel_terminal' }],
    invariants: [],
  },
  {
    id: 'T19',
    event: 'model.switch.requested',
    description:
      'Model switch requested at completed-turn boundary: operation=model_switch; §11.2 confirm flow (confirmed→idle; failed/timeout→checkpoint-successor) is recorded via supporting events.',
    preconditions: [
      { kind: 'suspension_in', suspensions: ['none'] },
      { kind: 'operation_in', operations: ['idle'] },
      { kind: 'child_active', value: true },
    ],
    effects: [{ kind: 'begin_model_switch' }],
    invariants: ['phase_unchanged', 'suspension_unchanged'],
  },
  {
    id: 'T20',
    event: 'permission.requested',
    description:
      'Permission request during prompt_turn: surface (interactive) or policy allowlist/deny (headless, §10.2); no phase change (projection shows Waiting on you).',
    preconditions: [{ kind: 'operation_in', operations: ['prompt_turn'] }],
    effects: [{ kind: 'record_permission_pending' }],
    invariants: ['phase_unchanged', 'suspension_unchanged'],
  },
  {
    id: 'T21',
    event: 'rss.soft_threshold',
    description: 'RSS soft threshold: warn event + notify; no transition.',
    preconditions: [{ kind: 'child_active', value: true }],
    effects: [
      { kind: 'warn_rss_soft' },
      { kind: 'notify', topic: 'rss_soft', message: 'Child process at RSS soft threshold.' },
    ],
    invariants: ['phase_unchanged', 'suspension_unchanged', 'restart_counters_unchanged'],
  },
  {
    id: 'T22',
    event: 'rss.hard_limit',
    description:
      'RSS hard-limit path (§14): legacy events retain their historical effects; semanticsVersion=2 additionally records a generation-bound resource_exhaustion stop intent, whose confirmed exit folds resource.exhausted (never T13).',
    preconditions: [{ kind: 'child_active', value: true }],
    effects: [{ kind: 'rss_hard_stop' }],
    invariants: ['phase_unchanged', 'suspension_unchanged'],
  },
  {
    id: 'T23',
    event: 'verification.completed.failed',
    description:
      'Verification: any criterion failed/unproven, OR agent-actionable §16 readiness blockers (worktree dirty post-verification; mixed agent+user sets included — W2-2) → needs_remediation (bounded, default 3); exhaustion → failed, never false completion. User-ONLY §16 blockers take the merge.readiness.blocked supporting path (remain verifying, no remediation round); probe absence / wrong-commit are typed orchestration errors, never this row.',
    preconditions: [{ kind: 'phase_in', phases: ['verifying'] }],
    effects: [{ kind: 'remediation_or_fail' }],
    invariants: ['suspension_unchanged'],
  },
  {
    id: 'T24',
    event: 'verification.completed.passed',
    description:
      'All criteria VERIFIED: phase=merge_ready + MergeReadiness record. W2-1: the event must CARRY the §16 MergeReadiness with ready=true — rejected otherwise (payload-validated).',
    preconditions: [
      { kind: 'phase_in', phases: ['verifying'] },
      { kind: 'payload_check', check: 'merge_readiness_ready' },
    ],
    effects: [
      { kind: 'set_phase', phase: 'merge_ready' },
      { kind: 'record_merge_readiness' },
      { kind: 'notify', topic: 'merge_ready', message: 'Run is merge-ready.' },
    ],
    invariants: ['suspension_unchanged'],
  },
  {
    id: 'T25',
    event: 'failover.no_live_target',
    description:
      'Dual/multi-provider limited, switch_harness has no live target: remain paused; incidents per provider; notify failover_exhausted; exit only via T9.',
    preconditions: [{ kind: 'suspension_in', suspensions: ['paused_limit'] }],
    effects: [
      { kind: 'record_limit_incident', incidentKind: 'usage_limit' },
      { kind: 'notify', topic: 'failover_exhausted', message: 'All failover targets limited; run remains paused.' },
    ],
    invariants: ['phase_unchanged', 'suspension_unchanged'],
  },
];

// ---------------------------------------------------------------------------
// Table index + self-checks (fail loudly at module load if malformed)
// ---------------------------------------------------------------------------
const TRANSITIONS_BY_EVENT: ReadonlyMap<DomainEventType, TransitionRow> = (() => {
  const map = new Map<DomainEventType, TransitionRow>();
  const ids = new Set<TransitionId>();
  for (const row of TRANSITION_TABLE) {
    if (ids.has(row.id)) throw new Error(`Duplicate transition id ${row.id}`);
    ids.add(row.id);
    if (map.has(row.event)) {
      throw new Error(`Event '${row.event}' is claimed by two transition rows`);
    }
    map.set(row.event, row);
  }
  if (TRANSITION_TABLE.length !== 25 || ids.size !== 25) {
    throw new Error(`Transition table must contain exactly the 25 rows T1–T25, got ${ids.size}`);
  }
  return map;
})();

export function transitionForEvent(type: DomainEventType): TransitionRow | undefined {
  return TRANSITIONS_BY_EVENT.get(type);
}

export function transitionById(id: TransitionId): TransitionRow {
  const row = TRANSITION_TABLE.find((r) => r.id === id);
  if (!row) throw new Error(`Unknown transition id ${id}`);
  return row;
}

// ---------------------------------------------------------------------------
// Engine state (the three orthogonal axes + counters the predicates need)
// ---------------------------------------------------------------------------
export interface EngineState {
  readonly phase: RunPhase;
  readonly suspension: Suspension;
  readonly operation: Operation;
  /**
   * W2-1: the child is GENERATION-tracked, never a boolean. Set ONLY by
   * folding `child.spawned`; pause/exit paths mark it `stopping`/`stopped`;
   * a generation-matched `child.stopped` confirms the stop (a late stop from
   * a superseded generation never clears the current one). `undefined` =
   * no child has ever spawned (or the record was superseded).
   */
  readonly activeChild?: ActiveChild;
  /** W2-1 T9/T12: recorded pending re-entry, cleared by `resume_reentry.completed`. */
  readonly resumeReentryPending?: ResumeReentryPending;
  /**
   * P4b-2 self-drive successor spine: the durable successor INTENT marker (a
   * `resumeReentryPending` sibling). Recorded by `initiate_resume` when the
   * resume trigger carries a `successor` seed — ONE atomic write with the
   * suspension-clear — and cleared by the SAME `resume_reentry.completed` ack.
   */
  readonly successorIntent?: SuccessorIntent;
  /**
   * B2 round 4 — the latest coordinator-completion draft ref, folded from the
   * `workflow.dispatch.advanced` that carried it. This is the run's own LOG
   * saying which SpecVersion was drafted, so `applyTransition` can check a T1's
   * provenance PURELY, with no database read: a `spec.approved` must name this
   * exact version+hash, and the ENGINE may not sign at all when it is absent.
   * That is what makes an unvalidated T1 unable to produce `approved` even when
   * it was written straight into the durable log and replayed by `recover()`.
   */
  readonly lastDraftRef?: SpecDraftRef;
  /**
   * B2 round 5 — was this state built from the run's COMPLETE history?
   *
   * `lastDraftRef` being absent used to mean two different things, and the
   * provenance check treated both as the permissive one:
   *   - "this run never completed a coordinator round" (legitimate — the
   *     imported/legacy human-approval case), and
   *   - "this projection never folded the event that would have established it"
   *     (UNKNOWN — `ProjectionRepository.recover` is INCREMENTAL: it resumes
   *     from a stored cursor and never backfills, so a projection written by a
   *     build that predates `lastDraftRef` resumes past the completion advance
   *     and never learns of it).
   *
   * `initialEngineState` sets this, so any state folded from sequence 1 by this
   * build carries it and every later fold preserves it. A projection persisted
   * by an older build does NOT, which is exactly the "cannot judge" case.
   *
   * B2 round 6 — the marker gates the ENGINE signature ONLY, and that is a
   * deliberate, load-bearing asymmetry rather than a softening:
   *  - it closes the hole, because it is checked BEFORE the reference branch,
   *    so a stale-but-present reference can no longer carry an `auto` approval;
   *  - it keeps the UPGRADE path open, because `recover()` is incremental and
   *    there is NO operation that rebuilds a projection from sequence 1. Gating
   *    human approval on the marker would strand every run already in the live
   *    store at `awaiting_approval` with no way forward.
   *
   * That is only sound because no run lacking the marker can be pinned `auto`:
   * `approval` did not exist before this branch, and `loadRunConfig` re-parses
   * a persisted config through the schema, so a config written without the key
   * resolves to `'human'`. The one exception is a run created by an
   * INTERMEDIATE commit of this branch (rounds 1–4, where `auto` existed but
   * this marker did not) — that state fails CLOSED here, and cannot exist
   * outside a developer's checkout of this unmerged branch.
   */
  readonly historyComplete?: true;
  /** Bound on T1. */
  readonly approvedSpecHash?: SpecHash;
  /**
   * B2: WHO signed the T1 that bound `approvedSpecHash` — folded from the
   * same `spec.approved` payload, in the same effect. Absent exactly when
   * `approvedSpecHash` is absent (never approved) OR the run was approved by
   * a pre-B2 build, whose only possible signer was a human; readers treat
   * absent as `'human'`. Never inferred from config: this records the actual
   * signature, so a human who approved a run pinned to `approval: 'auto'`
   * still shows as `human`.
   */
  readonly specApprovedBy?: SpecApprovalMode;
  readonly counters: RestartCounters;
  readonly bounds: EngineBounds;
}

export function initialEngineState(overrides: Partial<EngineState> = {}): EngineState {
  return {
    phase: 'created',
    suspension: SUSPENSION_NONE,
    operation: OPERATION_IDLE,
    counters: ZERO_COUNTERS,
    bounds: DEFAULT_BOUNDS,
    // B2 round 5: a state seeded here is folded from sequence 1, so its
    // `lastDraftRef` (present or absent) is TRUSTWORTHY. Everything that
    // resumes from a stored projection inherits whatever that projection
    // recorded — and a pre-round-5 projection records nothing, which is
    // precisely the "cannot judge provenance" case.
    historyComplete: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Precondition evaluation (exported for the generated conformance suite)
// ---------------------------------------------------------------------------
/** W2-1 named payload validations — evaluated against the TRIGGER event. */
function checkPayload(
  check: PayloadCheckName,
  state: EngineState,
  event: DomainEvent | undefined,
): string | undefined {
  if (event === undefined) {
    // Fail closed: a payload-validated row can never be judged satisfied
    // without the event it validates.
    return `payload check '${check}' requires the trigger event`;
  }
  switch (check) {
    case 'merge_readiness_ready': {
      const payload = event.payload as { mergeReadiness?: { ready?: unknown } };
      if (payload.mergeReadiness === undefined) {
        return 'payload must carry the §16 MergeReadiness (W2-1: T24 is payload-validated)';
      }
      return payload.mergeReadiness.ready === true
        ? undefined
        : `MergeReadiness.ready must be true, was ${JSON.stringify(payload.mergeReadiness.ready)}`;
    }
    case 'generation_matches_active': {
      const payload = event.payload as { generationId?: ProcessGenerationId };
      if (payload.generationId === undefined) return undefined; // unstamped report
      return payload.generationId === state.activeChild?.generationId
        ? undefined
        : `generationId '${payload.generationId}' is not the active generation ` +
            `('${state.activeChild?.generationId ?? 'none'}') — stale report ignored`;
    }
    default: {
      const exhaustive: never = check;
      return `unknown payload check ${String(exhaustive)}`;
    }
  }
}

/** Returns undefined when satisfied, else a human-readable failure detail.
 * `event` is required only by `payload_check` rows (W2-1); state-only checks
 * ignore it. */
export function checkPrecondition(
  pre: Precondition,
  state: EngineState,
  event?: DomainEvent,
): string | undefined {
  switch (pre.kind) {
    case 'phase_in':
      return pre.phases.includes(state.phase)
        ? undefined
        : `phase must be in [${pre.phases.join(', ')}], was '${state.phase}'`;
    case 'phase_non_terminal':
      return isTerminalPhase(state.phase)
        ? `phase must be non-terminal, was '${state.phase}'`
        : undefined;
    case 'suspension_in':
      return pre.suspensions.includes(state.suspension.kind)
        ? undefined
        : `suspension must be in [${pre.suspensions.join(', ')}], was '${state.suspension.kind}'`;
    case 'operation_in':
      return pre.operations.includes(state.operation.kind)
        ? undefined
        : `operation must be in [${pre.operations.join(', ')}], was '${state.operation.kind}'`;
    case 'child_active': {
      const live = isLiveChild(state.activeChild);
      return live === pre.value
        ? undefined
        : `a live child generation must be ${pre.value ? 'present' : 'absent'}, ` +
            `activeChild was ${state.activeChild === undefined ? 'undefined' : `status '${state.activeChild.status}'`}`;
    }
    case 'payload_check':
      return checkPayload(pre.check, state, event);
    default: {
      const exhaustive: never = pre;
      return `unknown precondition ${String(exhaustive)}`;
    }
  }
}

export function checkPreconditions(
  row: TransitionRow,
  state: EngineState,
  event?: DomainEvent,
): string[] {
  const failures: string[] = [];
  for (const pre of row.preconditions) {
    const failure = checkPrecondition(pre, state, event);
    if (failure !== undefined) failures.push(failure);
  }
  return failures;
}

// ---------------------------------------------------------------------------
// Engine outcome
// ---------------------------------------------------------------------------
export type RejectionReason = 'unlisted_event' | 'precondition_failed';

export interface AppliedTransition {
  readonly status: 'applied';
  readonly transitionId: TransitionId;
  readonly next: EngineState;
  /** Supporting events to append atomically with the trigger event. */
  readonly emitted: readonly DomainEvent[];
}

export interface RejectedTransition {
  readonly status: 'rejected';
  readonly reason: RejectionReason;
  readonly detail: string;
  /** Ready-to-append `transition.rejected` event (§6.3 rule). */
  readonly rejectionEvent: EventOfType<'transition.rejected'>;
}

export type TransitionOutcome = AppliedTransition | RejectedTransition;

// ---------------------------------------------------------------------------
// Pure engine
// ---------------------------------------------------------------------------
interface MutableDraft {
  phase: RunPhase;
  suspension: Suspension;
  operation: Operation;
  activeChild: ActiveChild | undefined;
  resumeReentryPending: ResumeReentryPending | undefined;
  successorIntent: SuccessorIntent | undefined;
  lastDraftRef: SpecDraftRef | undefined;
  approvedSpecHash: SpecHash | undefined;
  specApprovedBy: SpecApprovalMode | undefined;
  counters: RestartCounters;
}

/**
 * B2 round 4 — a `spec.approved` in the durable log whose provenance the LOG
 * ITSELF contradicts. Thrown (not rejected) because this is corruption, not an
 * illegal-but-expected transition: the same treatment, and the same reasoning,
 * as `WorkflowDispatchReplayError`. A rejection would silently no-op and leave
 * the caller believing the log is sound.
 *
 * Reachable only by writing a T1 into the event store directly — every service
 * route validates against the projection AND the completion ref first. This is
 * the backstop for exactly that: `recover()` replaying a hand-appended T1 must
 * not produce `approved`.
 */
export type SpecApprovalProvenanceReason =
  /** `approvedBy:'auto'` with no completed coordinator round in the log. */
  | 'no_completion_ref'
  /** The approval names a version/hash the completed round did not draft. */
  | 'binding_mismatch'
  /** B2 round 5: this state cannot see enough history to judge provenance. */
  | 'provenance_undeterminable';

export class SpecApprovalProvenanceError extends Error {
  override readonly name: string = 'SpecApprovalProvenanceError';
  readonly runId: RunId;
  readonly reason: SpecApprovalProvenanceReason;
  constructor(runId: RunId, reason: SpecApprovalProvenanceReason, detail: string) {
    super(`Corrupt event log for run ${runId}: ${detail}`);
    this.runId = runId;
    this.reason = reason;
  }
}

function classificationOf(event: DomainEvent): LimitClassification | undefined {
  const payload = event.payload as { classification?: LimitClassification };
  return payload.classification;
}

function segmentIdOf(event: DomainEvent): SegmentId | undefined {
  const payload = event.payload as { segmentId?: SegmentId };
  return payload.segmentId;
}

/**
 * F4 (§5x) DURABLE restart window fold (PURE): append `occurredAt` to the
 * bounded, time-decayed window and drop entries older than
 * `bounds.windowMinutes` — measured ONLY from `occurredAt` (the trigger
 * event's own timestamp), never `Date.now`, so a full log replay reconstructs
 * the exact same window. Hard-capped at `lifetimeRestartMax` (finite,
 * non-disableable) so a `windowMax: 'off'` run can never grow the list without
 * bound. A malformed persisted timestamp (`NaN`) is treated as fully decayed.
 */
function foldRestartWindow(
  existing: readonly IsoTimestamp[] | undefined,
  occurredAt: IsoTimestamp,
  bounds: EngineBounds,
): readonly IsoTimestamp[] {
  const nowMs = Date.parse(occurredAt);
  const spanMs = bounds.windowMinutes * 60_000;
  const kept = (existing ?? []).filter((ts) => {
    const tsMs = Date.parse(ts);
    return Number.isFinite(tsMs) && nowMs - tsMs <= spanMs;
  });
  kept.push(occurredAt);
  const cap = Number.isFinite(bounds.lifetimeRestartMax) ? bounds.lifetimeRestartMax : kept.length;
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
}

function suspensionReasonDetail(event: DomainEvent): string {
  const classification = classificationOf(event);
  if (classification) return `${classification.kind}:${classification.provider}`;
  const payload = event.payload as { reason?: unknown };
  if (typeof payload.reason === 'string') return payload.reason;
  return event.type;
}

function reject(
  state: EngineState,
  event: DomainEvent,
  reason: RejectionReason,
  detail: string,
): RejectedTransition {
  return {
    status: 'rejected',
    reason,
    detail,
    rejectionEvent: draftEvent({
      type: 'transition.rejected',
      runId: event.runId,
      payload: {
        attemptedEventType: event.type,
        attemptedIdempotencyKey: event.idempotencyKey,
        reason,
        detail,
        phase: state.phase,
        suspension: state.suspension.kind,
        operation: state.operation.kind,
      },
      idempotencyKey: deriveIdempotencyKey(event.idempotencyKey, 0, 'transition.rejected'),
      occurredAt: event.occurredAt,
    }),
  };
}

/**
 * B2 round 4 — PURE provenance check on a `spec.approved`, using only the
 * run's own folded log. No database read, so it is safe inside the reducer and
 * inside `recover()`'s replay, which is exactly where it is needed.
 *
 * Two rules, mirroring the service-side gate's log-derived half:
 *  - a completion ref folded from `workflow.dispatch.advanced` means the run
 *    HAS drafted provenance, and the approval must name that exact
 *    version+hash;
 *  - no completion ref means there is no drafted provenance at all, so the
 *    ENGINE may not sign (`approvedBy:'auto'`). A HUMAN may — that is the
 *    documented pre-B2 explicit-hash path for imported/legacy specs, and the
 *    same deliberate asymmetry the service applies: a person can attest to an
 *    externally produced hash, the engine must have provenance.
 *
 * What this canNOT see (and the service still must): the run's PINNED approval
 * mode, and whether the draft PROJECTION agrees with the ref. Both need reads a
 * reducer must not do. The residual, stated plainly: a raw-log writer can still
 * append a HUMAN approval that matches the log's own completion ref — which is
 * precisely the approval `approve()` would itself have accepted, so it is not
 * an escalation.
 */
function assertApprovalProvenance(state: EngineState, event: DomainEvent): void {
  if (event.type !== 'spec.approved') return;
  const payload = (event as EventOfType<'spec.approved'>).payload;
  const ref = state.lastDraftRef;
  // B2 round 6 — ORDER MATTERS, and this is the order:
  //   1. an ENGINE signature requires a judgeable state (this check),
  //   2. then it requires drafted provenance to exist,
  //   3. then the binding must match that provenance.
  //
  // Round 5 checked the marker only INSIDE the `ref === undefined` branch, so a
  // projection with no marker but a STALE reference still behind its cursor was
  // trusted — codex probed exactly that and an `approvedBy:'auto'` approval
  // matching the stale reference reached `approved`. Hoisting the check makes a
  // present-but-untrustworthy reference unable to carry an engine signature.
  //
  // It is gated on `auto` ALONE, and that is what keeps the upgrade path open:
  // a HUMAN signature never depends on the marker, so a run persisted by an
  // older build — which necessarily has no marker — is still approvable. See
  // the note on `historyComplete` for why no such run can be pinned `auto`.
  if (payload.approvedBy === 'auto' && state.historyComplete !== true) {
    throw new SpecApprovalProvenanceError(
      event.runId,
      'provenance_undeterminable',
      `spec.approved claims approvedBy='auto' but this projection was not built from the run's complete ` +
        `history (no history-complete marker), so its drafted provenance cannot be judged — a reference ` +
        `it happens to carry may be stale, and one it lacks may simply never have been folded. Absent ` +
        `provenance and UNKNOWN provenance are not the same thing, and the engine signs on neither. ` +
        `A human may still approve this run explicitly; otherwise cancel and re-start it.`,
    );
  }
  if (ref === undefined) {
    if (payload.approvedBy === 'auto') {
      throw new SpecApprovalProvenanceError(
        event.runId,
        'no_completion_ref',
        `spec.approved claims approvedBy='auto' but the log records no completed coordinator round ` +
          `(no workflow.dispatch.advanced carrying a draft ref). The engine never signs a spec it ` +
          `cannot prove was drafted.`,
      );
    }
    return;
  }
  if (
    String(payload.specVersionId) !== String(ref.specVersionId) ||
    String(payload.specHash) !== String(ref.specHash)
  ) {
    throw new SpecApprovalProvenanceError(
      event.runId,
      'binding_mismatch',
      `spec.approved binds spec ${payload.specVersionId} (hash ${payload.specHash}) but the latest ` +
        `completed coordinator round drafted ${ref.specVersionId} (hash ${ref.specHash}, revision ` +
        `${ref.revision}). Approval must bind the drafted SpecVersion exactly (W1-F3).`,
    );
  }
}

/**
 * Pure, deterministic transition engine over the §6.3 table.
 * Never throws for domain-level illegality; never mutates `state`.
 * (B2 round 4 exception: a `spec.approved` whose provenance the LOG itself
 * contradicts throws `SpecApprovalProvenanceError` — that is corruption, not
 * illegality, and is treated exactly as `WorkflowDispatchReplayError` is.)
 */
export function applyTransition(state: EngineState, event: DomainEvent): TransitionOutcome {
  const row = TRANSITIONS_BY_EVENT.get(event.type);
  if (!row) {
    return reject(state, event, 'unlisted_event', `No §6.3 row triggers on event '${event.type}'`);
  }
  // B2 round 4: the DEEPEST approval guard, and the only one a durable-log
  // writer cannot go under. Every §6.3 application funnels through here — the
  // engine reducer, `recover()`'s replay, the service's transition path, and
  // the direct `applyTransition` call in the limit-pause composite — so a T1
  // whose provenance the log contradicts can never become `approved`, no
  // matter which surface wrote it.
  assertApprovalProvenance(state, event);
  const failures = checkPreconditions(row, state, event);
  if (failures.length > 0) {
    return reject(state, event, 'precondition_failed', `${row.id}: ${failures.join('; ')}`);
  }

  const initial = state;
  const draft: MutableDraft = {
    phase: state.phase,
    suspension: state.suspension,
    operation: state.operation,
    activeChild: state.activeChild,
    resumeReentryPending: state.resumeReentryPending,
    successorIntent: state.successorIntent,
    lastDraftRef: state.lastDraftRef,
    approvedSpecHash: state.approvedSpecHash,
    specApprovedBy: state.specApprovedBy,
    counters: { ...state.counters },
  };

  const emitted: DomainEvent[] = [];
  const emit = <T extends DomainEventType>(type: T, payload: EventPayloads[T]): void => {
    emitted.push(
      draftEvent({
        type,
        runId: event.runId,
        payload,
        idempotencyKey: deriveIdempotencyKey(event.idempotencyKey, emitted.length, type),
        occurredAt: event.occurredAt,
      }) as DomainEvent,
    );
  };

  const emitIncident = (
    incidentKind: 'usage_limit' | 'unknown',
    classification: LimitClassification,
    segment: SegmentId | undefined,
  ): void => {
    emit('limit.incident.recorded', {
      provider: classification.provider,
      incidentKind,
      detectionTier: classification.detectionTier,
      etaSource: classification.resumesAt !== undefined ? 'retry_after' : 'unknown',
      source: classification.source,
      ...(classification.resumesAt !== undefined ? { resumesAt: classification.resumesAt } : {}),
      ...(segment !== undefined ? { segmentId: segment } : {}),
    });
  };

  for (const effect of row.effects) {
    switch (effect.kind) {
      case 'set_phase':
        draft.phase = effect.phase;
        break;
      case 'set_phase_from_event':
        draft.phase = (event as EventOfType<'spec.superseded'>).payload.nextPhase;
        break;
      case 'set_phase_to_return_phase':
        if (initial.suspension.kind !== 'none') draft.phase = initial.suspension.returnPhase;
        break;
      case 'bind_spec_hash': {
        // B2: hash AND signer are bound together from the ONE T1 payload — the
        // audit answer to "which spec, signed by whom" can never come apart.
        const approval = (event as EventOfType<'spec.approved'>).payload;
        draft.approvedSpecHash = approval.specHash;
        draft.specApprovedBy = approval.approvedBy;
        break;
      }
      case 'mark_assignments_stale': {
        const payload = (event as EventOfType<'spec.superseded'>).payload;
        emit('assignments.marked_stale', {
          supersededSpecVersionId: payload.supersededSpecVersionId,
        });
        break;
      }
      case 'suspend': {
        draft.suspension = {
          kind: effect.to,
          reasonDetail: suspensionReasonDetail(event),
          returnPhase: draft.phase,
          enteredAt: event.occurredAt,
          ...(effect.recordInFlightOperation && initial.operation.kind !== 'idle'
            ? { inFlightOperation: initial.operation.kind }
            : {}),
        };
        break;
      }
      case 'clear_suspension':
        draft.suspension = SUSPENSION_NONE;
        break;
      case 'set_operation_idle':
        draft.operation = OPERATION_IDLE;
        break;
      case 'begin_model_switch': {
        const payload = (event as EventOfType<'model.switch.requested'>).payload;
        draft.operation = {
          kind: 'model_switch',
          fromModel: payload.fromModel,
          toModel: payload.toModel,
          requestedAt: event.occurredAt,
        };
        break;
      }
      case 'mechanical_checkpoint': {
        const segment = segmentIdOf(event);
        emit('checkpoint.requested', {
          reason: effect.reason,
          ...(segment !== undefined ? { segmentId: segment } : {}),
        });
        break;
      }
      case 'request_child_stop': {
        const segment = segmentIdOf(event);
        // W2-1: the generation stays LIVE (status 'stopping') with a durable
        // stop-intent; only a generation-matched `child.stopped` confirms.
        if (isLiveChild(draft.activeChild) && draft.activeChild !== undefined) {
          draft.activeChild = { ...draft.activeChild, status: 'stopping', stopCause: effect.cause };
          emit('child.stop.intent', {
            generationId: draft.activeChild.generationId,
            segmentId: draft.activeChild.segmentId,
            cause: effect.cause,
          });
        }
        emit('segment.stop.requested', {
          mode: 'graceful',
          ...(segment !== undefined ? { segmentId: segment } : {}),
        });
        break;
      }
      case 'mark_generation_stopped':
        // T17: the orchestrator lost the child (restart) — the generation is
        // no longer under management; §14 startup reaping owns any orphan.
        if (draft.activeChild !== undefined && draft.activeChild.status !== 'stopped') {
          const { stopCause: _dropped, ...rest } = draft.activeChild;
          draft.activeChild = { ...rest, status: 'stopped' };
        }
        break;
      case 'record_limit_incident': {
        const payload = event.payload as {
          classification?: LimitClassification;
          classifications?: readonly LimitClassification[];
          limitedProviders?: readonly string[];
        };
        const segment = segmentIdOf(event);
        if (payload.classification) {
          emitIncident(effect.incidentKind, payload.classification, segment);
        } else if (payload.classifications && payload.classifications.length > 0) {
          for (const classification of payload.classifications) {
            emitIncident(effect.incidentKind, classification, segment);
          }
        } else {
          for (const provider of payload.limitedProviders ?? []) {
            emit('limit.incident.recorded', {
              provider,
              incidentKind: effect.incidentKind,
              detectionTier: 'unknown',
              etaSource: 'unknown',
              ...(segment !== undefined ? { segmentId: segment } : {}),
            });
          }
        }
        break;
      }
      case 'mark_switch_failed_indeterminate': {
        const operation = initial.operation;
        const segment = segmentIdOf(event);
        emit('model.switch.failed', {
          fromModel: operation.kind === 'model_switch' ? operation.fromModel : 'unknown',
          toModel: operation.kind === 'model_switch' ? operation.toModel : 'unknown',
          reason: 'failed_indeterminate',
          ...(segment !== undefined ? { segmentId: segment } : {}),
        });
        break;
      }
      case 'require_successor': {
        const segment = segmentIdOf(event);
        emit('segment.successor.required', {
          reason: effect.reason,
          reassertModel: effect.reassertModel,
          ...(segment !== undefined ? { predecessorSegmentId: segment } : {}),
        });
        break;
      }
      case 'git_grace_outcome': {
        const payload = (event as EventOfType<'limit.classified.git_op'>).payload;
        // W2-1: generation marked stopping (durable intent); `child.stopped`
        // confirms. The deadline branch never claims a clean stop.
        if (isLiveChild(draft.activeChild) && draft.activeChild !== undefined) {
          draft.activeChild = { ...draft.activeChild, status: 'stopping', stopCause: 'limit_pause' };
          emit('child.stop.intent', {
            generationId: draft.activeChild.generationId,
            segmentId: draft.activeChild.segmentId,
            cause: 'limit_pause',
          });
        }
        if (payload.outcome === 'deadline_terminated') {
          emit('segment.stop.requested', { mode: 'terminate', segmentId: payload.segmentId });
          emit('worktree.tainted', {
            taint: 'deadline_termination',
            segmentId: payload.segmentId,
          });
        } else {
          emit('segment.stop.requested', { mode: 'graceful', segmentId: payload.segmentId });
        }
        break;
      }
      case 'interrupt_on_child_exit': {
        // W2-1 T13: fold the counters (history for P4b's bounded respawn),
        // mark THAT generation stopped, suspend `interrupted` — manual
        // resume required. No restart emission, no breaker decision here:
        // supervision (T14) owns exhaustion, the reducer only folds.
        const payload = (event as EventOfType<'child.exited.unexpectedly'>).payload;
        draft.counters = {
          ...draft.counters,
          restartsInWindow: draft.counters.restartsInWindow + 1,
          lifetimeRestarts: draft.counters.lifetimeRestarts + 1,
          // F4 (§5x) DURABLE window: append this restart's own occurredAt and
          // PRUNE by it (never Date.now) against the configured span, then
          // hard-cap at the lifetime max so the list is always bounded. This
          // rides F1's single atomic T13 write — the RestartBreaker rehydrates
          // its fast 5/10min deque from here in a fresh process.
          restartWindow: foldRestartWindow(draft.counters.restartWindow, event.occurredAt, state.bounds),
        };
        if (draft.activeChild !== undefined && draft.activeChild.status !== 'stopped') {
          const { stopCause: _dropped, ...rest } = draft.activeChild;
          draft.activeChild = { ...rest, status: 'stopped' };
        }
        draft.operation = OPERATION_IDLE;
        draft.suspension = {
          kind: 'interrupted',
          reasonDetail:
            `child exit: ${payload.classifiedAs}` +
            (payload.exitCode !== undefined ? ` (exit ${payload.exitCode})` : '') +
            (payload.signal !== undefined ? ` (signal ${payload.signal})` : ''),
          returnPhase: draft.phase,
          enteredAt: event.occurredAt,
          ...(initial.operation.kind !== 'idle' ? { inFlightOperation: initial.operation.kind } : {}),
        };
        break;
      }
      case 'open_breaker': {
        const payload = (event as EventOfType<'restart.exhausted'>).payload;
        draft.suspension = {
          kind: 'breaker_open',
          reasonDetail: payload.reason,
          returnPhase: draft.phase,
          enteredAt: event.occurredAt,
        };
        if (draft.activeChild !== undefined && draft.activeChild.status !== 'stopped') {
          const { stopCause: _dropped, ...rest } = draft.activeChild;
          draft.activeChild = { ...rest, status: 'stopped' };
        }
        draft.operation = OPERATION_IDLE;
        emit('breaker.opened', { reason: payload.reason });
        break;
      }
      case 'reset_counters':
        // Lifetime cap is non-disableable (§14): NOT reset by breaker reset.
        draft.counters = {
          ...draft.counters,
          restartsInWindow: 0,
          probeCount: 0,
          // F4 (§5x): clear the DURABLE window too — T15 is the user's explicit
          // "start the window fresh" (the breaker mirrors this into its
          // in-memory deque via `RestartBreaker.reset`).
          restartWindow: [],
        };
        break;
      case 'require_worktree_validation': {
        const segment = segmentIdOf(event);
        emit('worktree.validation.required', {
          ...(segment !== undefined ? { segmentId: segment } : {}),
        });
        break;
      }
      case 'fold_probe_count': {
        // W2-1 (pushback item 8): the reducer ONLY folds the count. Ladder
        // deadlines, jitter, and per-incident exhaustion are computed by the
        // pure scheduler (W2-4) from the run's pinned config and recorded as
        // explicit `limit.probe.scheduled` events; manual resume always
        // remains available (§13).
        draft.counters = { ...draft.counters, probeCount: draft.counters.probeCount + 1 };
        break;
      }
      case 'initiate_resume': {
        const returnPhase =
          initial.suspension.kind === 'none' ? initial.phase : initial.suspension.returnPhase;
        // W2-1: resume NEVER marks a child active. Record the pending
        // re-entry (reclaimed idempotently by startup/`resume` until a
        // `resume_reentry.completed` ack clears it); `child.spawned` is the
        // only thing that sets the active generation.
        const mode =
          event.type === 'resume.limit.requested'
            ? (event as EventOfType<'resume.limit.requested'>).payload.mode
            : 'manual';
        draft.resumeReentryPending = { returnPhase, mode, recordedAt: event.occurredAt };
        draft.counters = { ...draft.counters, probeCount: 0 };
        // P4b-2 self-drive successor spine: a resume trigger MAY carry a
        // `successor` seed — fold the durable INTENT marker (a
        // resumeReentryPending sibling) in THIS same atomic write, BEFORE any
        // OS spawn, cleared by the SAME `resume_reentry.completed` ack. The
        // marker adds the derived returnPhase + recordedAt to the seed.
        const successor = (event.payload as { successor?: SuccessorIntentSeed }).successor;
        if (successor !== undefined) {
          draft.successorIntent = {
            target: successor.target,
            reason: successor.reason,
            reassertModel: successor.reassertModel,
            ...(successor.seedCheckpointHash !== undefined
              ? { seedCheckpointHash: successor.seedCheckpointHash }
              : {}),
            returnPhase,
            recordedAt: event.occurredAt,
          };
        }
        emit('segment.resume.initiated', {
          via: successor !== undefined ? 'successor' : 'undetermined',
          returnPhase,
        });
        break;
      }
      case 'mark_interrupted_recovery': {
        const payload = (event as EventOfType<'recovery.running_segment_found'>).payload;
        emit('recovery.initiated', { segmentId: payload.segmentId });
        break;
      }
      case 'cancel_terminal': {
        if (isLiveChild(draft.activeChild)) {
          emit('segment.stop.requested', { mode: 'terminate' });
        }
        emit('process_group.reap.requested', {});
        draft.phase = 'cancelled';
        draft.suspension = SUSPENSION_NONE;
        draft.operation = OPERATION_IDLE;
        // Terminal: one result, no deferred stop-confirmation dance — a late
        // `child.stopped` for this generation folds as a no-op.
        if (draft.activeChild !== undefined && draft.activeChild.status !== 'stopped') {
          const { stopCause: _dropped, ...rest } = draft.activeChild;
          draft.activeChild = { ...rest, status: 'stopped' };
        }
        draft.resumeReentryPending = undefined;
        // P4b-2: a terminal run drops any pending successor intent — no
        // successor is ever driven for a cancelled/failed run.
        draft.successorIntent = undefined;
        break;
      }
      case 'record_permission_pending': {
        const payload = (event as EventOfType<'permission.requested'>).payload;
        emit('permission.decision.required', {
          requestId: payload.requestId,
          segmentId: payload.segmentId,
        });
        break;
      }
      case 'warn_rss_soft': {
        const payload = (event as EventOfType<'rss.soft_threshold'>).payload;
        emit('warn.rss_soft', {
          rssBytes: payload.rssBytes,
          budgetBytes: payload.budgetBytes,
          ratio: payload.budgetBytes > 0 ? payload.rssBytes / payload.budgetBytes : 0,
        });
        break;
      }
      case 'rss_hard_stop': {
        const payload = (event as EventOfType<'rss.hard_limit'>).payload;
        const segment = payload.segmentId;
        // Replay compatibility: an absent version is a historical T22 and
        // deliberately keeps the old reducer behavior. Only new v2 producers
        // turn the event into a durable generation-bound stop intent.
        if (
          payload.semanticsVersion === 2 &&
          payload.generationId !== undefined &&
          isLiveChild(draft.activeChild) &&
          draft.activeChild?.generationId === payload.generationId
        ) {
          draft.activeChild = {
            ...draft.activeChild,
            status: 'stopping',
            stopCause: 'resource_exhaustion',
          };
          emit('child.stop.intent', {
            generationId: draft.activeChild.generationId,
            segmentId: draft.activeChild.segmentId,
            cause: 'resource_exhaustion',
          });
        }
        if (payload.escalation === 'graceful') {
          emit('checkpoint.requested', {
            reason: 'pre_graceful_stop',
            ...(segment !== undefined ? { segmentId: segment } : {}),
          });
          emit('segment.stop.requested', {
            mode: 'graceful',
            deadlineMs: RSS_GRACEFUL_STOP_DEADLINE_MS,
            ...(segment !== undefined ? { segmentId: segment } : {}),
          });
        } else {
          emit('segment.stop.requested', {
            mode: 'terminate',
            ...(segment !== undefined ? { segmentId: segment } : {}),
          });
          emit('worktree.tainted', {
            taint: 'emergency_kill',
            ...(segment !== undefined ? { segmentId: segment } : {}),
          });
        }
        break;
      }
      case 'remediation_or_fail': {
        if (draft.counters.remediationRounds < state.bounds.remediationMax) {
          draft.counters = {
            ...draft.counters,
            remediationRounds: draft.counters.remediationRounds + 1,
          };
          draft.phase = 'needs_remediation';
          emit('remediation.started', {
            round: draft.counters.remediationRounds,
            maxRounds: state.bounds.remediationMax,
          });
        } else {
          draft.phase = 'failed';
          emit('notify.requested', {
            topic: 'run_failed',
            message: 'Remediation bound exhausted; run failed (never false completion).',
          });
        }
        break;
      }
      case 'record_merge_readiness': {
        const payload = (event as EventOfType<'verification.completed.passed'>).payload;
        emit('merge.readiness.recorded', { verificationId: payload.verificationId });
        break;
      }
      case 'notify':
        emit('notify.requested', { topic: effect.topic, message: effect.message });
        break;
      default: {
        const exhaustive: never = effect;
        throw new Error(`Unhandled effect descriptor: ${String(exhaustive)}`);
      }
    }
  }

  const next: EngineState = {
    phase: draft.phase,
    suspension: draft.suspension,
    operation: draft.operation,
    counters: draft.counters,
    bounds: state.bounds,
    ...(draft.activeChild !== undefined ? { activeChild: draft.activeChild } : {}),
    ...(draft.resumeReentryPending !== undefined
      ? { resumeReentryPending: draft.resumeReentryPending }
      : {}),
    ...(draft.successorIntent !== undefined ? { successorIntent: draft.successorIntent } : {}),
    ...(state.historyComplete === true ? { historyComplete: true as const } : {}),
    ...(draft.lastDraftRef !== undefined ? { lastDraftRef: draft.lastDraftRef } : {}),
    ...(draft.approvedSpecHash !== undefined ? { approvedSpecHash: draft.approvedSpecHash } : {}),
    ...(draft.specApprovedBy !== undefined ? { specApprovedBy: draft.specApprovedBy } : {}),
  };

  return { status: 'applied', transitionId: row.id, next, emitted };
}

// ---------------------------------------------------------------------------
// Engine-folded SUPPORTING events (W2-1) — folded by `makeEngineReducer`
// (../app/projections.ts), NEVER by `applyTransition` (they are not §6.3
// rows and reject as unlisted here). Pure fold functions live beside the
// engine so replay and live ingest share one implementation.
// ---------------------------------------------------------------------------
/**
 * Fold `child.spawn.initiated` (W2-3): a fresh spawn's generation is recorded
 * with status `spawning` and the `initial_config_pin` operation window opens
 * (§6.2: initialize → option discovery → §11.2 pin enforcement). This is what
 * makes a limit envelope DURING pinning satisfy T4's preconditions
 * (operation ∈ {prompt_turn, initial_config_pin}, live child) in the durable
 * state — live ingest and replay alike — and lets T4's stop-intent name the
 * generation. Total on purpose — last spawn wins (same rationale as
 * `foldChildSpawned`).
 */
export function foldChildSpawnInitiated(
  state: EngineState,
  event: EventOfType<'child.spawn.initiated'>,
): EngineState {
  const activeChild: ActiveChild = {
    generationId: event.payload.generationId,
    segmentId: event.payload.segmentId,
    status: 'spawning',
  };
  return { ...state, activeChild, operation: { kind: 'initial_config_pin' } };
}

/**
 * Fold `child.spawned`: the ONLY thing that marks the generation ACTIVE
 * (W2-1; `child.spawn.initiated` only marks it `spawning`). Closes the
 * `initial_config_pin` window (W2-3: pins enforced → operation idle; any
 * other in-flight operation is left untouched). Total on purpose — last
 * spawn wins; the §14 max-children guard and process registry own the "no
 * concurrent generations" invariant, the fold just records.
 */
export function foldChildSpawned(
  state: EngineState,
  event: EventOfType<'child.spawned'>,
): EngineState {
  const activeChild: ActiveChild = {
    generationId: event.payload.generationId,
    segmentId: event.payload.segmentId,
    status: 'active',
  };
  return {
    ...state,
    activeChild,
    ...(state.operation.kind === 'initial_config_pin' ? { operation: OPERATION_IDLE } : {}),
  };
}

/**
 * Fold `turn.started` (W2-3): the prompt turn's provider call is in flight —
 * `operation = prompt_turn`, so a mid-turn limit envelope licenses T4 and
 * the suspension detail records the in-flight operation honestly (§6.2).
 * Total: the service serializes turns (at most one in flight per session).
 */
export function foldTurnStarted(state: EngineState): EngineState {
  return { ...state, operation: { kind: 'prompt_turn' } };
}

/**
 * Fold `turn.completed` (W2-3): the provider call settled → operation idle.
 * Only a `prompt_turn` operation is cleared (idempotent redelivery and a
 * late/duplicated completion after a pause — whose row already folded the
 * operation idle — both no-op).
 */
export function foldTurnCompleted(state: EngineState): EngineState {
  if (state.operation.kind !== 'prompt_turn') return state;
  return { ...state, operation: OPERATION_IDLE };
}

/**
 * Fold `child.stopped`: clears ONLY a matching generation — a late stop from
 * generation N must not clear N+1 (W2-1). Completes T11: a confirmed stop
 * whose recorded intent was `user_pause` folds `suspension=paused_user`
 * (only when nothing else suspended the run first — e.g. a limit pause that
 * superseded the user pause mid-stop keeps `paused_limit`).
 */
export function foldChildStopped(
  state: EngineState,
  event: EventOfType<'child.stopped'>,
): EngineState {
  const child = state.activeChild;
  if (child === undefined || child.generationId !== event.payload.generationId) {
    return state; // late/unknown generation: never clears the current one
  }
  if (child.status === 'stopped') return state; // idempotent redelivery
  // RSS stop confirmation carries role/RSS/budget on `resource.exhausted`.
  // A bare `child.stopped` cannot truthfully synthesize that suspension, so
  // leave the durable intent intact until the purpose-built confirmation
  // event lands (runtime and startup recovery both use that path).
  if (
    child.stopCause !== undefined &&
    stopIntentConfirmation(child.stopCause) === 'resource_exhaustion' &&
    event.payload.reason !== 'rss_race_completed'
  ) {
    return state;
  }
  const { stopCause, ...rest } = child;
  const next: EngineState = { ...state, activeChild: { ...rest, status: 'stopped' } };
  if (
    stopCause !== undefined &&
    stopIntentConfirmation(stopCause) === 'pause_user' &&
    state.suspension.kind === 'none'
  ) {
    return {
      ...next,
      suspension: {
        kind: 'paused_user',
        reasonDetail: 'user_pause (stop confirmed)',
        returnPhase: state.phase,
        enteredAt: event.occurredAt,
      },
    };
  }
  return next;
}

/**
 * Fold `resource.exhausted` (F1/F3): a generation crossed its RSS budget and
 * was terminated. Marks the matching generation stopped (a late/foreign
 * generation never clears the current one), clears the operation, and suspends
 * the run `resource_exhausted` with the phase preserved as the return phase.
 *
 * Deliberately NOT T13: this exit must not fold restart counters or auto-respawn
 * at the same budget, and it is a distinct suspension from `paused_limit`
 * (a provider incident). Idempotent and terminal-safe: a redelivery, a run a
 * racing pause already suspended, or a cancelled/failed run is a no-op — only a
 * running, unsuspended, non-terminal run enters the suspension.
 */
export function foldResourceExhausted(
  state: EngineState,
  event: EventOfType<'resource.exhausted'>,
): EngineState {
  const child = state.activeChild;
  // Generation-matched (like `foldChildStopped`): a late/foreign generation
  // never suspends the current run. Idempotent (a run already suspended is left
  // alone) and terminal-safe (a cancelled/failed run never re-suspends).
  if (child === undefined || child.generationId !== event.payload.generationId) return state;
  if (state.suspension.kind !== 'none' || isTerminalPhase(state.phase)) return state;
  const stoppedChild: ActiveChild =
    child.status === 'stopped'
      ? child
      : ((): ActiveChild => {
          const { stopCause: _dropped, ...rest } = child;
          return { ...rest, status: 'stopped' };
        })();
  return {
    ...state,
    activeChild: stoppedChild,
    operation: OPERATION_IDLE,
    suspension: {
      kind: 'resource_exhausted',
      reasonDetail:
        `RSS budget exhausted (${event.payload.role}: ${event.payload.rssBytes} bytes ` +
        `over ${event.payload.budgetBytes} budget)`,
      returnPhase: state.phase,
      enteredAt: event.occurredAt,
      ...(state.operation.kind !== 'idle' ? { inFlightOperation: state.operation.kind } : {}),
    },
  };
}

/**
 * Fold `resume_reentry.completed`: ack the pending re-entry (idempotent). P4b-2:
 * the SAME ack clears the successor INTENT marker — `child.spawned` acking the
 * re-entered round IS the successor going active, so the marker is consumed
 * exactly then (an un-acked marker after a crash re-drives one successor).
 */
export function foldResumeReentryCompleted(state: EngineState): EngineState {
  if (state.resumeReentryPending === undefined && state.successorIntent === undefined) return state;
  const { resumeReentryPending: _cleared, successorIntent: _successor, ...rest } = state;
  return rest;
}
