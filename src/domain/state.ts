/**
 * State model — three ORTHOGONAL axes, never a flat enum (PLAN.md §6.2) —
 * plus small shared domain vocabulary used by both entities and events.
 */
import type { IsoTimestamp } from '../lib/clock.js';
import type { ArtifactHash, ProcessGenerationId, SegmentId, TurnId } from './ids.js';

// ---------------------------------------------------------------------------
// Axis 1: Run.phase (workflow position)
// ---------------------------------------------------------------------------
// Note: `superseded` in PLAN §6.2 marks SPEC supersession — it is a
// SpecVersion status ('superseded') plus Assignment status ('stale'), NOT a
// run phase: T3's effect is "open assignments → stale; phase per new spec
// flow", i.e. the run's phase always moves along the normal flow.
export const RUN_PHASES = [
  'created',
  'specifying',
  'awaiting_approval',
  'approved',
  'implementing',
  'verifying',
  'needs_remediation',
  'merge_ready',
  'cancelled',
  'failed',
] as const;
export type RunPhase = (typeof RUN_PHASES)[number];

export const TERMINAL_PHASES = ['cancelled', 'failed'] as const;
export type TerminalPhase = (typeof TERMINAL_PHASES)[number];

export function isTerminalPhase(phase: RunPhase): phase is TerminalPhase {
  return (TERMINAL_PHASES as readonly RunPhase[]).includes(phase);
}

// ---------------------------------------------------------------------------
// Axis 2: Assignment/Segment.suspension (orthogonal to phase)
// ---------------------------------------------------------------------------
export const SUSPENSION_KINDS = [
  'none',
  'paused_limit',
  'paused_user',
  'breaker_open',
  'interrupted',
  // F1/F3 (§review dogfood): a generation crossed its RSS budget and was
  // terminated (graceful checkpoint+stop, or emergency SIGKILL). Distinct from
  // `paused_limit` (a PROVIDER usage-limit incident that drives probe
  // scheduling + failover) — a LOCAL memory ceiling has no provider ETA, and
  // resuming at the SAME budget would just re-cross it, so resume is gated on
  // an audited per-run budget raise (never an automatic escalation).
  'resource_exhausted',
] as const;
export type SuspensionKind = (typeof SUSPENSION_KINDS)[number];
export type SuspendedKind = Exclude<SuspensionKind, 'none'>;

/**
 * PLAN §6.2: "Suspension records {reason detail, return_phase,
 * in_flight_operation?, entered_at}. Suspension never changes phase; resume
 * returns to return_phase."
 */
export interface SuspensionDetail {
  readonly reasonDetail: string;
  readonly returnPhase: RunPhase;
  readonly inFlightOperation?: OperationKind;
  readonly enteredAt: IsoTimestamp;
}

export type Suspension =
  | { readonly kind: 'none' }
  | ({ readonly kind: SuspendedKind } & SuspensionDetail);

export const SUSPENSION_NONE: Suspension = { kind: 'none' };

// ---------------------------------------------------------------------------
// Axis 3: Segment.operation (at most one in flight)
// ---------------------------------------------------------------------------
export const OPERATION_KINDS = [
  'idle',
  'prompt_turn',
  'initial_config_pin',
  'model_switch',
  'checkpoint_write',
  'git_op',
  'resume_probe',
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export type GitOpKind =
  | 'worktree_add'
  | 'worktree_remove'
  | 'commit'
  | 'checkout'
  | 'merge'
  | 'other';

export type Operation =
  | { readonly kind: 'idle' }
  | { readonly kind: 'prompt_turn'; readonly turnId?: TurnId }
  /**
   * W2-1 (P4a): the initial option-discovery → model/effort pin enforcement
   * window of a fresh spawn (§11.2 pre-work). A limit envelope here is a T4
   * pause exactly like one during a prompt turn (identical no-successor
   * effects); `prompt_turn` only ever wraps actual prompt turns.
   */
  | { readonly kind: 'initial_config_pin' }
  | {
      readonly kind: 'model_switch';
      readonly fromModel: string;
      readonly toModel: string;
      readonly requestedAt: IsoTimestamp;
    }
  | { readonly kind: 'checkpoint_write' }
  | { readonly kind: 'git_op'; readonly op: GitOpKind }
  | { readonly kind: 'resume_probe' };

export const OPERATION_IDLE: Operation = { kind: 'idle' };

// ---------------------------------------------------------------------------
// Active child — generation-tracked, never a boolean (W2-1, §6.2)
// ---------------------------------------------------------------------------
export const CHILD_STATUSES = ['spawning', 'active', 'stopping', 'stopped'] as const;
export type ChildStatus = (typeof CHILD_STATUSES)[number];

/** Why a durable stop-intent was recorded for the active generation (W2-3
 * pause spine causes; T18's terminal stop needs no intent — it is final). */
export const STOP_INTENT_CAUSES = [
  'limit_pause',
  'unknown_error_pause',
  'user_pause',
  'resource_exhaustion',
] as const;
export type StopIntentCause = (typeof STOP_INTENT_CAUSES)[number];

/**
 * The confirmation action for every durable child-stop intent. Keep this
 * switch exhaustive: adding a cause must fail typecheck until its stop
 * confirmation semantics are chosen deliberately.
 */
export function stopIntentConfirmation(
  cause: StopIntentCause,
): 'confirm_only' | 'pause_user' | 'resource_exhaustion' {
  switch (cause) {
    case 'limit_pause':
    case 'unknown_error_pause':
      return 'confirm_only';
    case 'user_pause':
      return 'pause_user';
    case 'resource_exhaustion':
      return 'resource_exhaustion';
    default: {
      const exhaustive: never = cause;
      return exhaustive;
    }
  }
}

/**
 * The run's child process, tracked BY GENERATION (W2-1): `child.spawned`
 * sets it, a stop path marks it `stopping` (with the durable stop-intent
 * cause), and ONLY a generation-matched `child.stopped` marks it `stopped` —
 * a late stop from generation N must never clear generation N+1. T11's
 * `paused_user` suspension folds only when the matching stop is confirmed
 * (`stopCause === 'user_pause'`).
 */
export interface ActiveChild {
  readonly generationId: ProcessGenerationId;
  readonly segmentId: SegmentId;
  readonly status: ChildStatus;
  /** Present while `status === 'stopping'`: the recorded stop-intent cause. */
  readonly stopCause?: StopIntentCause;
}

/** A child is LIVE (satisfies `child_active`) until its stop is confirmed. */
export function isLiveChild(child: ActiveChild | undefined): boolean {
  return child !== undefined && child.status !== 'stopped';
}

/**
 * W2-1 T9 amendment: resume does NOT mark a child active. It records the
 * pending re-entry; `child.spawned` later sets the active generation and a
 * `resume_reentry.completed` event acks the re-entered round (cleared then).
 * Startup and `resume` reclaim unacknowledged pending re-entries idempotently.
 */
export interface ResumeReentryPending {
  readonly returnPhase: RunPhase;
  readonly mode: 'scheduled_probe' | 'manual';
  readonly recordedAt: IsoTimestamp;
}

/**
 * P4b-2 self-drive successor spine — the {harness, model, effort} a successor
 * generation re-asserts on its first pin. Plain strings (not `RoleModelSpec`)
 * so the domain layer never depends on the app's model-resolution module; the
 * spine narrows it back through `resolveRoleModel` at spawn time. Wave 1 sets
 * this to the crashed/paused generation's OWN target (same-harness/same-model);
 * failover (a DIFFERENT target from the per-assignment ladder) is wave 2.
 */
export interface SuccessorTarget {
  readonly harness: string;
  /** Provider model slug, e.g. `opus` or `gpt-5.6-terra`. */
  readonly model: string;
  readonly effort?: string;
}

/**
 * P4b-2 self-drive successor spine — the request carried on a resume trigger's
 * `successor` payload field. `applyTransition`'s `initiate_resume` folds it
 * into the durable `SuccessorIntent` marker (adding the derived returnPhase +
 * recordedAt) in the SAME atomic write as the T9/T12 suspension-clear.
 */
export interface SuccessorIntentSeed {
  readonly target: SuccessorTarget;
  /** Why a successor was required (§6.3 T5 `require_successor`, or `recovery`). */
  readonly reason: SuccessorReason;
  /** T5: re-assert the model explicitly on the successor's first pin. */
  readonly reassertModel: boolean;
  /** §12.2 checkpoint the successor is seeded from (`resolveResumeCheckpointHash`;
   * absent when no eligible checkpoint exists yet — the safe direction). */
  readonly seedCheckpointHash?: ArtifactHash;
}

/**
 * P4b-2 self-drive successor spine — the durable INTENT marker, a
 * `resumeReentryPending` SIBLING in `EngineState`. Recorded ATOMICALLY (fused
 * with the T9/T12 `initiate_resume` suspension-clear, ONE `#atomicEngineWrite`)
 * BEFORE any OS spawn, and cleared by the SAME `child.spawned →
 * resume_reentry.completed` ack that clears `resumeReentryPending`. An un-acked
 * marker after a crash re-drives EXACTLY ONE successor on restart (reap kills a
 * mid-spawn orphan; the un-acked marker re-drives) — windows A/B/C.
 */
export interface SuccessorIntent extends SuccessorIntentSeed {
  readonly returnPhase: RunPhase;
  readonly recordedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Counters & bounds consumed by the transition engine (§13, §14, §6.3)
// ---------------------------------------------------------------------------
export interface RestartCounters {
  /** Restarts inside the sliding window (§14 default bound 5/10min). */
  readonly restartsInWindow: number;
  /** Non-disableable per-assignment lifetime restarts (§14 default cap 10). */
  readonly lifetimeRestarts: number;
  /** Limit-resume probes performed while paused (§13: bounded per incident,
   * default 6 — exhaustion is permanent for the incident, W2-4). */
  readonly probeCount: number;
  /** Remediation rounds consumed (§6.3 default bound 3; exhaustion → failed). */
  readonly remediationRounds: number;
  /**
   * F4 (§5x) DURABLE sliding-restart window: the `occurredAt` of each folded
   * T13 restart, PRUNED in the pure reducer by the trigger event's own
   * `occurredAt` (never `Date.now`) against `EngineBounds.windowMinutes` and
   * hard-capped at `lifetimeRestartMax`. Unlike the monotonic
   * `restartsInWindow` counter (which never decays), this genuinely
   * time-decays, so the fast 5/10min window survives a fresh process: the
   * `RestartBreaker` hydrates its in-memory deque from here lazily
   * per-assignment. Optional so a projection persisted before F4 (no field)
   * reads back as an empty window. This rides F1's single atomic T13 write —
   * NOT a second breaker store.
   */
  readonly restartWindow?: readonly IsoTimestamp[];
}

export const ZERO_COUNTERS: RestartCounters = {
  restartsInWindow: 0,
  lifetimeRestarts: 0,
  probeCount: 0,
  remediationRounds: 0,
  restartWindow: [],
};

export interface EngineBounds {
  readonly restartWindowMax: number;
  /** F4 (§5x): sliding-window SPAN in minutes for the durable `restartWindow`
   * prune (single source of truth: `EngineConfig.restarts.windowMinutes`).
   * The pure T13 reducer decays entries older than this from the trigger
   * event's own `occurredAt`. */
  readonly windowMinutes: number;
  readonly lifetimeRestartMax: number;
  readonly probeMax: number;
  readonly remediationMax: number;
}

export const DEFAULT_BOUNDS: EngineBounds = {
  restartWindowMax: 5, // §14: window bound default 5/10min
  windowMinutes: 10, // §14: window span default 10min
  lifetimeRestartMax: 10, // §14: lifetime cap default 10, non-disableable
  probeMax: 6, // §13: max 6 probes per incident
  remediationMax: 3, // §6.3: remediation bound default 3
};

/**
 * §13 unknown-ETA probe ladder default: 30m → 1h → 2h → 4h (then stays at
 * 4h). Lives HERE (domain vocabulary, consumed by the config schema as the
 * per-run default), deliberately NOT in transitions.ts: the T10 reducer only
 * FOLDS probe counts — probe scheduling is a pure-scheduler concern computed
 * from the run's PINNED config, recorded as an explicit
 * `limit.probe.scheduled {at, rung, probeIndex}` supporting event (W2-1
 * pushback item 8; scheduler lands in W2-4).
 */
export const DEFAULT_PROBE_LADDER_MINUTES = [30, 60, 120, 240] as const;

// ---------------------------------------------------------------------------
// Shared vocabulary (used by entities AND events; kept here to avoid cycles)
// ---------------------------------------------------------------------------
export type RoleName = 'coordinator' | 'implementor' | 'verifier';

/**
 * B2 — WHO signed the T1 approval. `human` is an operator running `harness
 * approve` (the historical only path); `auto` is the ENGINE binding the
 * drafted hash itself under a run pinned to `approval: 'auto'`. This is a
 * signature attribution, never a relaxation: both modes bind the exact
 * drafted SpecVersion hash through the same W1-F3/W3-4 validation, and the
 * spec stays immutable either way. Carried on the `spec.approved` payload,
 * folded into `EngineState.specApprovedBy`, and surfaced on the §16
 * merge-readiness report so a human reviewing a merge can see that nobody
 * reviewed the intent.
 */
export type SpecApprovalMode = 'human' | 'auto';

/**
 * B2 round 4 — what a REPORT may say about the signer. Adds `'unknown'` to the
 * two real modes, for the one case that genuinely arises: a persisted record
 * written by an older build whose attribution the event log cannot
 * substantiate. Codex's rule is that such a record is UNKNOWN and must never be
 * reported as `'human'` — so "unknown" has to be sayable, rather than
 * approximated by the safest-looking lie.
 *
 * Deliberately NOT accepted on the INPUT side: a freshly computed report always
 * knows its signer (it is derived from the event log at build time), so
 * `BuildMergeReadinessInput.specApprovedBy` stays a real `SpecApprovalMode` and
 * `'unknown'` can only ever come from migrating an old record on read.
 */
export type SpecApprovalAttribution = SpecApprovalMode | 'unknown';

/**
 * Why a checkpoint-successor generation is required (§11, §12.2): a limit
 * during an unconfirmed model switch (T5), a mid-turn limit, a cross-harness
 * switch, or crash/restart recovery. Shared vocabulary — consumed by both the
 * `require_successor` effect (transitions) and the `segment.successor.required`
 * event (events), and carried on the P4b-2 successor INTENT marker.
 */
export type SuccessorReason =
  | 'model_switch_indeterminate'
  | 'mid_turn_limit'
  | 'cross_harness_switch'
  | 'recovery';

/** §9 classifyError result kinds (adapter/protocol envelopes ONLY). */
export type ClassifiedErrorKind =
  | 'usage_limit'
  | 'auth'
  | 'crash'
  | 'protocol'
  | 'unknown_provider_error';

/** §13 detection tiers (parsed tier is gated behind the P4a corpus review). */
export type DetectionTier = 'structured' | 'http_429' | 'parsed' | 'unknown';

/** §13: structured resumes_at is labeled retry_after; otherwise honestly unknown. */
export type EtaSource = 'retry_after' | 'unknown';

export type LimitIncidentKind = 'usage_limit' | 'unknown';

/**
 * §12.1 quota admission scope: which quota an artifact write was checked
 * (and, on rejection, checked AGAINST) — per-run default 2GB, global default
 * 20GB. Canonical home for this vocabulary word: `../persistence/artifact-
 * repository.ts`'s `AdmissionRejectionScope` is a re-exported alias of this
 * type (persistence depends on domain, never the reverse), and
 * `EventPayloads['artifact.admission.rejected']` (./events.ts) uses it
 * directly.
 */
export type ArtifactQuotaScope = 'per_run' | 'global';

/** §12.2 checkpoint cadence triggers. */
export type CheckpointReason =
  | 'cadence'
  | 'pre_model_switch'
  | 'pre_pause'
  | 'pre_verify_handoff'
  | 'pre_graceful_stop';

/** §16.3 taint causes. */
export type WorktreeTaint = 'emergency_kill' | 'deadline_termination' | 'reconcile_mismatch';
