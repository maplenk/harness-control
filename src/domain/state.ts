/**
 * State model — three ORTHOGONAL axes, never a flat enum (PLAN.md §6.2) —
 * plus small shared domain vocabulary used by both entities and events.
 */
import type { IsoTimestamp } from '../lib/clock.js';
import type { ProcessGenerationId, SegmentId, TurnId } from './ids.js';

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
export type StopIntentCause = 'limit_pause' | 'unknown_error_pause' | 'user_pause';

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
}

export const ZERO_COUNTERS: RestartCounters = {
  restartsInWindow: 0,
  lifetimeRestarts: 0,
  probeCount: 0,
  remediationRounds: 0,
};

export interface EngineBounds {
  readonly restartWindowMax: number;
  readonly lifetimeRestartMax: number;
  readonly probeMax: number;
  readonly remediationMax: number;
}

export const DEFAULT_BOUNDS: EngineBounds = {
  restartWindowMax: 5, // §14: window bound default 5/10min
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
