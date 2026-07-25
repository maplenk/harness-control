/**
 * Event vocabulary (PLAN.md §6.1, §6.3).
 *
 * Two families:
 *  - TRIGGER events — exactly one event type per transition row T1–T25.
 *    These are the ONLY inputs the transition engine accepts.
 *  - SUPPORTING events — facts/directives appended to the log (either emitted
 *    by the engine as transition effects or recorded by other components):
 *    transition.rejected, budget.exceeded, checkpoint.recorded,
 *    model.switch.requested/confirmed/failed family, warn events, etc.
 *
 * Every event carries: runId, monotonic per-run sequence (placeholder
 * `SEQUENCE_UNASSIGNED` until the event log assigns it at append), and an
 * idempotency key (§6.1, §12.1).
 */
import type { IsoTimestamp } from '../lib/clock.js';
import {
  SEQUENCE_UNASSIGNED,
  idempotencyKey,
  type ArtifactHash,
  type AlertId,
  type AssignmentId,
  type CheckpointId,
  type CriterionId,
  type EventSequence,
  type GitSha,
  type IdempotencyKey,
  type LimitIncidentId,
  type ProcessGenerationId,
  type RunId,
  type SegmentId,
  type SpecHash,
  type SpecVersionId,
  type VerificationId,
} from './ids.js';
import type { MergeReadiness } from './entities.js';
import type {
  ArtifactQuotaScope,
  CheckpointReason,
  ClassifiedErrorKind,
  DetectionTier,
  EtaSource,
  GitOpKind,
  LimitIncidentKind,
  OperationKind,
  RoleName,
  RunPhase,
  SpecApprovalMode,
  StopIntentCause,
  SuccessorIntentSeed,
  SuccessorReason,
  SuspensionKind,
  WorktreeTaint,
} from './state.js';
export type { SuccessorReason } from './state.js';

// ---------------------------------------------------------------------------
// Classification payload (§9 classifyError — adapter/protocol envelopes ONLY;
// free text inside agent messages is NEVER classified)
// ---------------------------------------------------------------------------
export interface LimitClassification {
  readonly kind: ClassifiedErrorKind;
  readonly provider: string;
  readonly source: 'structured' | 'parsed';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly detectionTier: DetectionTier;
  /** Structured resume ETA when present; otherwise honestly absent (§13). */
  readonly resumesAt?: IsoTimestamp;
}

export type NotifyTopic =
  | 'paused_limit'
  | 'paused_user'
  | 'breaker_open'
  | 'failover_exhausted'
  | 'rss_soft'
  | 'unknown_provider_error'
  | 'run_failed'
  | 'merge_ready'
  /** W2-1 T13: child exited unexpectedly → manual resume required (P4a has no auto-respawn). */
  | 'interrupted'
  /**
   * P4b-2 (§5cc): a same-harness bounded auto-respawn was driven for a crashed
   * child (the crash's generation-matched T13 was `restart`-advised and
   * `autoRespawn=bounded`). Not emitted as a `notify.requested` engine effect —
   * the successor spine raises the `respawn` alert DIRECTLY (this topic is only
   * the alert's audit back-reference), so it never fans out as an operator notify.
   */
  | 'respawn'
  /**
   * P4b wave 2 FAILOVER (§5cc/§5ee): a usage limit under a `switch_model` /
   * `switch_harness` policy self-drove the successor spine to the NEXT ladder
   * target. Like `respawn`, this is NOT a `notify.requested` engine effect — the
   * spine raises the `failover` alert DIRECTLY (this topic is only the alert's
   * audit back-reference), so it never fans out as an operator notify.
   */
  | 'failover'
  /**
   * F1/F3 (§review dogfood): a generation crossed its RSS memory budget and was
   * terminated (graceful stop or emergency SIGKILL) → the run is
   * `resource_exhausted` and needs a human-gated, audited budget raise before it
   * can resume. Surfaced as an operator notify + alert (distinct from a provider
   * `paused_limit`, which drives probe scheduling / failover).
   */
  | 'resource_exhausted';

/**
 * P4b-1 alert taxonomy (§5cc): the kinds of durable operator alert raised as a
 * supporting event folded into its triggering transition. `limit_paused`,
 * `crash`, and `breaker_open` ship in wave 1 (derived from the `paused_limit` /
 * `interrupted` / `breaker_open` notify effects); `respawn` is RESERVED for the
 * P4b-2 auto-respawn wave (the successor spine emits it) — declared now so the
 * projection/sink vocabulary is stable and wave 2 is a small delta.
 */
export type AlertKind =
  | 'limit_paused'
  | 'crash'
  | 'respawn'
  | 'breaker_open'
  | 'failover'
  // F1/F3: an RSS budget was exhausted and the generation terminated — a
  // human-actionable alert (raise the budget, then resume).
  | 'resource_exhausted';

/**
 * A named delivery sink for a raised alert. Built-ins are process `stderr`
 * (CLI) and the `status --json` alerts section; the `Notifier` seam
 * (webhook/push/desktop, wave 2) registers further named sinks. A plain string
 * so the event log never constrains which sinks a deployment wires.
 */
export type AlertSink = string;

/**
 * One model/effort pin applied during a spawn's `initial_config_pin` window
 * (§11.2 pre-work), carried on `child.spawned` so the log records exactly
 * what the generation runs under — including whether the adapter ECHOED the
 * effective value (W1-F8: echo-less success is recorded, never invented).
 */
export interface ChildPinRecord {
  readonly purpose: 'model' | 'effort';
  readonly optionId: string;
  readonly value: string;
  readonly effectiveValue?: string;
  readonly echoed: boolean;
}

/** How a generation's stop was confirmed (`child.stopped`, W2-1/W2-3). */
export type ChildStopReason =
  | 'graceful'
  | 'terminated'
  | 'exited'
  | 'startup_cleanup'
  /** A natural end_turn committed after a T22 v2 stop intent. */
  | 'rss_race_completed';

type Empty = Record<string, never>;

/**
 * (P4a W3-4) The durable identity of a persisted coordinator spec draft,
 * carried on the coordinator COMPLETION advance (`specifying →
 * awaiting_approval` taken by `completeCoordinationRound`). The draft
 * projection itself is projection-only, so this ref is what makes the
 * completion durable-detectable: replay/`approve`/`run` compare the CURRENT
 * `SPEC_DRAFT_PROJECTION` against the latest completion ref and refuse a
 * missing/stale draft with a recovery hint (`spec revise` re-drafts,
 * rebuilding revision context from the CAS artifact — whose hash, per §7,
 * IS the spec content hash — when readable). Ids/hashes only; no free text.
 */
export interface SpecDraftRef {
  /** CAS ref of the canonical spec bytes (== the spec content hash, §7). */
  readonly artifactHash: ArtifactHash;
  readonly specVersionId: SpecVersionId;
  readonly specHash: SpecHash;
  /** 1-based revision counter within the run. */
  readonly revision: number;
}

// ---------------------------------------------------------------------------
// Payload registry — single source of truth for the vocabulary.
// ---------------------------------------------------------------------------
export interface EventPayloads {
  // ---- Trigger events (one per §6.3 row) ---------------------------------
  /**
   * T1 — spec approved; binds the exact SpecVersion hash.
   *
   * B2: `approvedBy` names WHO signed — `human` (an operator ran `harness
   * approve`) or `auto` (the engine signed it under a run pinned to
   * `approval: 'auto'`). Both bind the REAL drafted hash through the same
   * W1-F3/W3-4 validation; the distinction exists so the audit trail can
   * show, for any run, that no human reviewed the intent.
   */
  'spec.approved': {
    readonly specVersionId: SpecVersionId;
    readonly specHash: SpecHash;
    readonly approvedBy: SpecApprovalMode;
  };
  /** T2 — `spec revise --feedback` during awaiting_approval. */
  'spec.revise.requested': {
    readonly specVersionId?: SpecVersionId;
    readonly feedback: string;
  };
  /** T3 — new SpecVersion supersedes; open assignments go stale. */
  'spec.superseded': {
    readonly supersededSpecVersionId: SpecVersionId;
    readonly newSpecVersionId?: SpecVersionId;
    /** "phase per new spec flow" — target phase decided by the spec flow. */
    readonly nextPhase: RunPhase;
  };
  /** T4 — limit envelope classified during `prompt_turn` OR the spawn's
   * `initial_config_pin` window (W2-1: identical no-successor pause effects). */
  'limit.classified.prompt_turn': {
    readonly segmentId: SegmentId;
    readonly classification: LimitClassification;
  };
  /** T5 — limit envelope while a model switch is requested, unconfirmed. */
  'limit.classified.model_switch': {
    readonly segmentId: SegmentId;
    readonly classification: LimitClassification;
  };
  /**
   * T6 — limit envelope during a git op. The application service waits for
   * git-op completion up to the grace deadline BEFORE emitting this event and
   * reports which way it went in `outcome`.
   */
  'limit.classified.git_op': {
    readonly segmentId: SegmentId;
    readonly classification: LimitClassification;
    readonly gitOp: GitOpKind;
    readonly outcome: 'completed_within_grace' | 'deadline_terminated';
  };
  /** T7 — limit signal arrives AFTER the segment closed (late update, #864). */
  'limit.late_signal': {
    readonly segmentId: SegmentId;
    readonly classification: LimitClassification;
  };
  /** T8 — limit while awaiting_approval with no active child. */
  'limit.classified.no_child': {
    readonly classification: LimitClassification;
  };
  /** T9 — resume from paused_limit (scheduled probe OK or manual). */
  'resume.limit.requested': {
    readonly mode: 'scheduled_probe' | 'manual';
    /**
     * P4b-2 self-drive successor spine: when present, the `initiate_resume`
     * fold ALSO records the durable `SuccessorIntent` marker in the SAME
     * atomic write (a `resumeReentryPending` sibling) so a T5/limit resume can
     * seed a checkpoint successor with an explicit target re-assertion. Absent
     * on an ordinary limit resume.
     */
    readonly successor?: SuccessorIntentSeed;
  };
  /** T10 — probe found the provider still limited. */
  'limit.probe.still_limited': {
    readonly classification?: LimitClassification;
  };
  /** T11 — user pause. */
  'pause.user.requested': Empty;
  /** T12 — user resume from paused_user OR interrupted (W2-1 manual re-entry).
   * P4b-2: an optional `successor` seed makes this the crash-recovery entry of
   * the self-drive successor spine — the marker rides the T12 `initiate_resume`
   * write atomically (see `resume.limit.requested.successor`). */
  'resume.user.requested': {
    readonly successor?: SuccessorIntentSeed;
  };
  /** T13 — child crash/exit (non-limit). W2-1: when the reporter stamps the
   * process generation, the row only applies to the ACTIVE generation — a
   * stale exit report from a superseded generation must not interrupt the
   * run (same rule as generation-matched `child.stopped`). */
  'child.exited.unexpectedly': {
    readonly segmentId: SegmentId;
    readonly generationId?: ProcessGenerationId;
    readonly exitCode?: number;
    readonly signal?: string;
    readonly classifiedAs: 'crash' | 'nonzero_exit' | 'clean_exit_unexpected';
  };
  /** T14 — restart bounds exhausted / no-progress detected by supervisor.
   * F4 (§5x): STAMPED with the process generation (same rule as T13) so the
   * `generation_matches_active` guard can reject a stale/superseded/late
   * report — WITHOUT a stamp that guard is a no-op (an unstamped generationId
   * passes), so a late breaker-open could clobber a moved-on / paused_limit /
   * terminal run. Optional only for the module-level breaker unit tests that
   * drive the reducer with an unstamped trigger. */
  'restart.exhausted': {
    readonly reason: 'window_bound' | 'lifetime_cap' | 'no_progress' | 'max_elapsed_recovery';
    readonly generationId?: ProcessGenerationId;
  };
  /** T15 — user `breaker reset`. */
  'breaker.reset.requested': Empty;
  /** T16 — ambiguous provider-call error (classifier=unknown_provider_error). */
  'provider.error.unknown': {
    readonly segmentId: SegmentId;
    readonly classification: LimitClassification;
  };
  /** T17 — orchestrator restart found a `running` segment. W4-4: the reap
   * producer stamps the reaped generation so `generation_matches_active`
   * gates the interrupt onto EXACTLY the run's active generation (a stale
   * generation is a benign no-op — same rule as T13's exit report). */
  'recovery.running_segment_found': {
    readonly segmentId: SegmentId;
    readonly generationId?: ProcessGenerationId;
  };
  /** T18 — cancel (idempotent, one terminal result). */
  'cancel.requested': Empty;
  /** T19 — model switch requested at a completed-turn boundary (§11.2). */
  'model.switch.requested': {
    readonly segmentId: SegmentId;
    readonly fromModel: string;
    readonly toModel: string;
    readonly mechanism?: string;
  };
  /** T20 — permission request from the agent during prompt_turn. */
  'permission.requested': {
    readonly segmentId: SegmentId;
    readonly requestId: string;
    readonly description: string;
    readonly options?: readonly string[];
  };
  /** T21 — RSS soft threshold (§14: 75% of budget). */
  'rss.soft_threshold': {
    readonly segmentId?: SegmentId;
    readonly rssBytes: number;
    readonly budgetBytes: number;
  };
  /** T22 — RSS hard-limit path (§14): graceful by deadline, else emergency.
   * F3: carries the `role` + `generationId` so the incident is structured
   * (which role's generation crossed which budget) and the service can bind a
   * generation-scoped resource-exhaustion cause off it. */
  'rss.hard_limit': {
    /**
     * Version 2 turns T22 into a durable generation stop-intent. Absent means
     * the historical T22 semantics and MUST replay unchanged.
     */
    readonly semanticsVersion?: 2;
    readonly segmentId?: SegmentId;
    readonly generationId?: ProcessGenerationId;
    readonly role?: RoleName;
    readonly rssBytes: number;
    readonly budgetBytes: number;
    readonly escalation: 'graceful' | 'emergency_kill';
  };
  /**
   * F1/F3 (§review dogfood) — engine-folded supporting event: a generation was
   * terminated because it crossed its RSS budget (graceful cancel or emergency
   * SIGKILL). Its fold marks that generation stopped and suspends the run
   * `resource_exhausted` (return phase preserved) — distinct from T13 (which
   * would fold restart counters + auto-respawn at the SAME budget) and from
   * `paused_limit` (a provider incident). Idempotent: a no-op once the run is
   * already suspended. NOT a §6.3 transition row — `applyTransition` rejects it.
   */
  'resource.exhausted': {
    readonly segmentId?: SegmentId;
    readonly generationId: ProcessGenerationId;
    readonly role: RoleName;
    readonly rssBytes: number;
    readonly budgetBytes: number;
  };
  /**
   * F3 (§review dogfood) — the ONE sanctioned, AUDITED exception to run-config
   * immutability: an operator raised a role's RSS memory budget on an EXISTING
   * `resource_exhausted` run so it can resume with more headroom. A plain
   * durable fact (no state transition); `#runMemoryBudgetBytes` reads the
   * latest override per role, and `resume` refuses a resource-exhausted run
   * until the effective budget exceeds the one that was exhausted.
   */
  'run.memory_budget.overridden': {
    readonly role: RoleName;
    readonly budgetMb: number;
    readonly previousBudgetMb: number;
    /** The budget (bytes) that was exhausted — the raise must exceed it. */
    readonly exhaustedBudgetBytes?: number;
  };
  /**
   * F5 (§review dogfood) — a run's implementation base commit was pinned at
   * RUNTIME rather than at `start` (a LEGACY run created before base-at-start
   * pinning). A plain, AUDITED durable fact so the one-time live-HEAD resolution
   * is explicit and visible — never a silent fallback. New runs pin their base
   * in `RunMeta` at `createRun`; `getRunBaseCommit` reads `RunMeta` first, then
   * the latest of these.
   */
  'run.base_commit.pinned': {
    readonly baseCommit: GitSha;
    readonly reason: 'legacy_runtime_pin';
  };
  /** T23 — verification finished blocked: any criterion failed/unproven, OR
   * (W2-2, narrowing W1-F1) every criterion verified but AGENT-actionable §16
   * readiness blockers remain (implementation worktree dirty
   * post-verification; mixed agent+user blocker sets included — remediation
   * must run anyway, user blockers re-probe next round). User-ONLY blockers
   * (destination dirty / base drift / conflicts) take the
   * `merge.readiness.blocked` supporting path instead (REMAIN `verifying`,
   * no remediation round); a missing probe and a wrong-commit probe result
   * are typed orchestration errors, never this row. */
  'verification.completed.failed': {
    readonly verificationId: VerificationId;
    readonly failedCriteria: readonly CriterionId[];
    readonly unprovenCriteria: readonly CriterionId[];
    /** §16 blockers that forced T23 despite all criteria verified (W1-F1;
     * W2-2: the set always includes at least one agent-actionable blocker —
     * user-only sets route to `merge.readiness.blocked`). */
    readonly readinessBlockers?: readonly string[];
  };
  /** T24 — all criteria VERIFIED. W2-1 (pushback item 1): the event CARRIES
   * the §16 `MergeReadiness` and the reducer rejects it unless
   * `mergeReadiness.ready === true` — a T24 can no longer silently escape a
   * generator that skipped (or failed) the readiness gate. */
  'verification.completed.passed': {
    readonly verificationId: VerificationId;
    readonly mergeReadiness: MergeReadiness;
  };
  /** T25 — multi-provider limited; switch_harness has no live target. */
  'failover.no_live_target': {
    readonly limitedProviders: readonly string[];
    readonly classifications?: readonly LimitClassification[];
  };

  // ---- Supporting events --------------------------------------------------
  /** Unlisted (state, event) pair or failed precondition (§6.3 rule). */
  'transition.rejected': {
    readonly attemptedEventType: string;
    readonly attemptedIdempotencyKey: IdempotencyKey;
    readonly reason: 'unlisted_event' | 'precondition_failed';
    readonly detail: string;
    readonly phase: RunPhase;
    readonly suspension: SuspensionKind;
    readonly operation: OperationKind;
  };
  /**
   * §6.2 linear forward workflow dispatch advance (W1-F6) — the role-DISPATCH
   * phase steps the §6.3 table deliberately does not model
   * (`created→specifying`, `approved→implementing`, …). Appended by
   * `advanceWorkflowPhase` through the same one-transaction write path as
   * transitions, so `recover()`'s event-log replay reconstructs the phase
   * instead of losing it with the projection. The engine reducer folds it,
   * validating the edge against `WORKFLOW_DISPATCH_EDGES` and the current
   * phase; an illegal edge during replay marks a corrupt log and throws a
   * typed error — loud, never silent.
   */
  'workflow.dispatch.advanced': {
    readonly from: RunPhase;
    readonly to: RunPhase;
    /** (P4a W3-4) Coordinator COMPLETION advances only (`specifying →
     * awaiting_approval` appended by `completeCoordinationRound`, which
     * persists the draft projection FIRST in the same transaction): the
     * persisted draft's identity, so an event-log replay can DETECT a
     * missing/stale draft projection instead of leaving an
     * approval-ready run with nothing to approve. Absent on every other
     * dispatch advance (including the bare unit-test advances of runs
     * that never drafted). */
    readonly draft?: SpecDraftRef;
  };
  /** §17.2 — measured + estimated spend + reservation exceeded the estimated soft budget. */
  'budget.exceeded': {
    readonly spentUsd: number;
    /** W1-F5: estimated (reservation-folded) spend of unpriced turns — counts toward refusal. */
    readonly estimatedUsd?: number;
    readonly reservationUsd: number;
    readonly budgetUsd: number;
    readonly role?: RoleName;
  };
  /**
   * §12.1 — "Quotas (normative): per-run artifact quota 2GB, global 20GB
   * (admission rejection + event when exceeded)." Emitted by
   * `SqliteArtifactRepository.write()` (../persistence/artifact-
   * repository.ts) alongside its append-only `artifact_admission_rejections`
   * audit row whenever the rejection has an owning run (a purely global,
   * run-less write has no `RunId` to attach a per-run event to and is
   * recorded in the audit table only). P1 verifier punch-list item 2: this
   * promotes what used to be an audit-table-only fact into a real event
   * flowing through the unified log.
   */
  'artifact.admission.rejected': {
    readonly attemptedHash: ArtifactHash;
    readonly attemptedSizeBytes: number;
    readonly scope: ArtifactQuotaScope;
    readonly limitBytes: number;
    /** Usage BEFORE this attempt (i.e. what it would have pushed over the limit). */
    readonly currentUsageBytes: number;
  };
  /** Engine directive: perform a mechanical checkpoint (§12.2). */
  'checkpoint.requested': {
    readonly reason: CheckpointReason;
    readonly segmentId?: SegmentId;
  };
  /**
   * §12.2 atomicity — commits with artifact hash in the same transaction.
   *
   * F3 (§5x, Approach B): the binding fields (`specHash`, `role`, and — when
   * a role round is dispatched — `round`/`assignmentId`) are DENORMALIZED onto
   * the event so resume can DERIVE the latest binding-compatible checkpoint
   * from the LOG ALONE, without loading every checkpoint artifact. This is
   * what makes `resolveResumeCheckpoint` (and the "resume re-derives from the
   * log" contract) real: a crash between the `checkpoint.recorded` append and
   * the separate `round.checkpointRef` save no longer loses the checkpoint,
   * and cadence checkpoints (which never touch `checkpointRef`) become
   * visible to resume. The `specHash` filter is the superseded-spec guard.
   */
  'checkpoint.recorded': {
    readonly checkpointId: CheckpointId;
    readonly artifactHash: ArtifactHash;
    readonly reason: CheckpointReason;
    readonly segmentId?: SegmentId;
    /** The spec hash this checkpoint is bound to (the documented empty
     * sentinel `''` means no spec existed at checkpoint time — never a
     * mismatch). The superseded-spec guard filters on this. */
    readonly specHash: SpecHash;
    /** The role whose round produced this checkpoint (absent only on a
     * checkpoint written outside a role spawn — none exist today). */
    readonly role?: RoleName;
    /** The 1-based dispatch round, when a role round is dispatched (absent for
     * a coordinator pause taken before any round dispatch). */
    readonly round?: number;
    /** The assignment whose worktree the round runs in — the resume
     * derivation's open/non-stale assignment filter key. */
    readonly assignmentId?: AssignmentId;
  };
  /** §11.2 — effective-value echo confirmed the switch. */
  'model.switch.confirmed': {
    readonly segmentId: SegmentId;
    readonly fromModel: string;
    readonly toModel: string;
    readonly effectiveValue: string;
  };
  /** §11.2 — timeout/error/T5 indeterminate. */
  'model.switch.failed': {
    readonly segmentId?: SegmentId;
    readonly fromModel: string;
    readonly toModel: string;
    readonly reason: 'timeout' | 'error' | 'failed_indeterminate';
  };
  /** T21 warn event. */
  'warn.rss_soft': {
    readonly rssBytes: number;
    readonly budgetBytes: number;
    readonly ratio: number;
  };
  /** Human notification request (breaker open, paused_limit, failover…). */
  'notify.requested': {
    readonly topic: NotifyTopic;
    readonly message: string;
  };
  /**
   * P4b-1 (§5cc) — a durable operator alert RAISED as a supporting event folded
   * into the SAME `#atomicEngineWrite` transaction as its triggering transition
   * (the `paused_limit`/`interrupted`/`breaker_open` notify effect), so an alert
   * can NEVER exist without its cause and vice-versa. `alertId`/`idempotencyKey`
   * are DERIVED from the trigger's key (replay-stable, dedupe-safe). `detail` is
   * redacted through the §17.1 path before it is stored. `runId`/`occurredAt`
   * live on the envelope. Delivery is best-effort/at-least-once and DERIVED from
   * the log (an `alert.raised` with no matching `alert.delivered`, the F3
   * derive-from-log pattern) — never a separate delivered cursor as the source
   * of truth.
   */
  'alert.raised': {
    readonly alertId: AlertId;
    readonly kind: AlertKind;
    readonly role: RoleName;
    readonly generationId?: ProcessGenerationId;
    /** The notify topic this alert was derived from (audit back-reference). */
    readonly topic: NotifyTopic;
    /** REDACTED (§17.1) human-readable detail. */
    readonly detail: string;
  };
  /**
   * P4b-1 (§5cc) — an `alert.raised` was delivered to `sink`. Dedup key is
   * `(alertId, sink)`; the presence of ANY `alert.delivered` for an alert marks
   * it acked so a restart re-derives only the still-un-acked alerts.
   */
  'alert.delivered': {
    readonly alertId: AlertId;
    readonly sink: AlertSink;
  };
  /** LimitIncident fact (id assigned by the repository at persist time). */
  'limit.incident.recorded': {
    readonly incidentId?: LimitIncidentId;
    readonly segmentId?: SegmentId;
    readonly provider: string;
    readonly incidentKind: LimitIncidentKind;
    readonly detectionTier: DetectionTier;
    readonly etaSource: EtaSource;
    readonly resumesAt?: IsoTimestamp;
    readonly source?: 'structured' | 'parsed';
  };
  /** T7/T8 — provider-level limit noted for future spawns. */
  'scheduler.provider_limit.noted': {
    readonly provider: string;
    readonly resumesAt?: IsoTimestamp;
  };
  /** Engine directive: stop the child (graceful cancel or terminate). */
  'segment.stop.requested': {
    readonly segmentId?: SegmentId;
    readonly mode: 'graceful' | 'terminate';
    readonly deadlineMs?: number;
  };
  /** Engine directive: reap the identity-verified process group (§14). */
  'process_group.reap.requested': {
    readonly segmentId?: SegmentId;
  };
  /**
   * W2-6 — a §14 signal/reap was WITHHELD because full identity
   * re-verification could not positively confirm the recorded process
   * ("ambiguity → never kill, surface an alert"): the ps identity
   * mismatched, the process was gone, the env nonce contradicted the
   * record, or nonce re-verification was unavailable on this platform.
   * Durable fact appended by the service's registry wiring so an operator
   * can see exactly which generation was left un-signaled and why.
   */
  'process.identity.alert': {
    readonly generationId: ProcessGenerationId;
    readonly segmentId?: SegmentId;
    readonly attemptedAction: 'signal' | 'reap';
    readonly attemptedSignal?: string;
    /** `IdentityVerdict` (../supervisor/registry.ts) minus 'match'. */
    readonly verdict: 'mismatch' | 'gone' | 'nonce_mismatch' | 'nonce_unverifiable';
    readonly reason?: string;
  };
  /**
   * P4b bounded-respawn vocabulary. W2-1: the amended T13 NEVER emits this —
   * an unexpected child exit folds counters and suspends `interrupted`
   * (manual resume; zero auto-respawns in P4a). Retained for the P4b
   * successor-based respawn machinery.
   */
  'segment.restart.initiated': {
    readonly segmentId?: SegmentId;
    readonly attempt: number;
    readonly lifetimeRestarts: number;
  };
  /** T9/T12 — resume path chosen later per §11.1 capability checks. */
  'segment.resume.initiated': {
    readonly via: 'native' | 'replayed' | 'successor' | 'undetermined';
    readonly returnPhase: RunPhase;
  };
  /**
   * W2-3 — a fresh role spawn began: the process exists and its
   * `initial_config_pin` window (§6.2: initialize → option discovery → §11.2
   * pin enforcement) is OPEN. Folded by the engine reducer: records the
   * generation with status `spawning` and sets `operation =
   * initial_config_pin`, which is exactly what licenses a T4 pause for a
   * limit envelope during pinning (classification precedes retry) and lets
   * the engine's stop-intent name the generation. `child.spawned` closes the
   * window; the round is NOT active and the workflow phase has NOT advanced
   * until then (pending/active dispatch split).
   */
  'child.spawn.initiated': {
    readonly generationId: ProcessGenerationId;
    readonly segmentId: SegmentId;
    readonly role: RoleName;
  };
  /**
   * W2-1 — a role child finished spawning: session created AND every §11.2
   * pin enforced. Folded by the engine reducer as the ONLY thing that marks
   * the generation ACTIVE (T9/T12 record a pending re-entry, never a live
   * child; `child.spawn.initiated` only marks it `spawning`) — and it closes
   * the `initial_config_pin` window (operation → idle). Appended by the
   * role-spawn path (W2-3) strictly AFTER pins succeed; the workflow phase
   * advance follows it (pending/active dispatch split).
   */
  'child.spawned': {
    readonly generationId: ProcessGenerationId;
    readonly segmentId: SegmentId;
    readonly role: RoleName;
    /** The enforced pins, echo facts included (W1-F8 `echoed:false` visible). */
    readonly pins: readonly ChildPinRecord[];
  };
  /**
   * W2-3 — a prompt turn began on the active generation. Folded by the
   * engine reducer: `operation = prompt_turn`, keeping the §6.2 operation
   * axis truthful in the DURABLE state so a limit envelope mid-turn licenses
   * T4 (and the suspension detail records the in-flight operation honestly)
   * on live ingest AND on replay.
   */
  'turn.started': {
    readonly segmentId: SegmentId;
    readonly generationId?: ProcessGenerationId;
  };
  /**
   * W2-3 — the prompt turn's provider call settled: `operation → idle`.
   * `outcome:'failed'` records a typed (auth/protocol) turn failure that did
   * NOT suspend the run — the pause paths never append this (T4/T16/T13 fold
   * the operation idle themselves as part of their own rows).
   */
  'turn.completed': {
    readonly segmentId: SegmentId;
    readonly generationId?: ProcessGenerationId;
    // F1: `resource_exhausted` closes an in-flight turn the RSS watchdog
    // terminated (graceful cancel → `stopReason:'cancelled'`, or emergency
    // SIGKILL mid-turn) — it is NOT a `completed` turn (no cadence, no round
    // completion), and NOT a typed `failed` (which never suspends the run).
    // `cancelled` closes a NON-RSS cancelled turn honestly (user/cross-process
    // cancel that resolved the prompt `stopReason:'cancelled'` with no RSS
    // cause): also NOT `completed` — it counts no cadence and never lets the
    // round complete as a deliverable.
    readonly outcome: 'completed' | 'failed' | 'resource_exhausted' | 'cancelled';
  };
  /**
   * W2-1 — a generation's stop was CONFIRMED (transport ladder completed,
   * child reaped, or startup cleanup §14). Generation-matched fold: clears
   * ONLY the matching active generation — a late stop from generation N must
   * not clear N+1. Completes T11: a pending `user_pause` stop-intent folds
   * `suspension=paused_user` here, not at pause-request time.
   */
  'child.stopped': {
    readonly generationId: ProcessGenerationId;
    readonly segmentId?: SegmentId;
    readonly reason: ChildStopReason;
  };
  /**
   * W2-1/W2-3 — durable stop-intent for the active generation, committed in
   * the SAME atomic append as its pause transition (T4/T5/T6/T11/T16). A
   * restart that finds a committed intent with no matching `child.stopped`
   * performs identity-verified cleanup (§14) and appends the confirmation —
   * the pause spine is crash-safe by construction (pushback item 9).
   */
  'child.stop.intent': {
    readonly generationId: ProcessGenerationId;
    readonly segmentId?: SegmentId;
    readonly cause: StopIntentCause;
  };
  /**
   * W2-1 — acks a T9/T12 pending re-entry once the resumed round is actually
   * re-entered (RoleRoundProjection-driven, W2-5). Folded by the engine
   * reducer: clears `resumeReentryPending` idempotently, so startup/`resume`
   * can reclaim unacknowledged re-entries (pushback item 4).
   */
  'resume_reentry.completed': {
    readonly role?: RoleName;
    readonly round?: number;
  };
  /** Checkpoint-successor required (T5, mid-turn limits, cross-harness). */
  'segment.successor.required': {
    readonly predecessorSegmentId?: SegmentId;
    readonly reason: SuccessorReason;
    /** T5: resume is ALWAYS successor with explicit model re-assertion. */
    readonly reassertModel: boolean;
  };
  /** T13 exhausted / T14. */
  'breaker.opened': {
    readonly reason:
      | 'window_bound'
      | 'lifetime_cap'
      | 'no_progress'
      | 'max_elapsed_recovery';
  };
  /** §16.3 taint fact. */
  'worktree.tainted': {
    readonly segmentId?: SegmentId;
    readonly taint: WorktreeTaint;
  };
  /** §16.3 — validation must run before next spawn/verification. */
  'worktree.validation.required': {
    readonly segmentId?: SegmentId;
  };
  /** T3 — open assignments marked stale. */
  'assignments.marked_stale': {
    readonly supersededSpecVersionId?: SpecVersionId;
  };
  /** T23 bounded remediation round started. */
  'remediation.started': {
    readonly round: number;
    readonly maxRounds: number;
  };
  /** T24 — MergeReadiness record to be produced for the verified commit. */
  'merge.readiness.recorded': {
    readonly verificationId: VerificationId;
  };
  /**
   * W2-2: criteria all verified but ONLY user/environment-actionable §16
   * blockers remain (destination dirty, base drifted, conflicts) — the run
   * REMAINS in `verifying` without consuming a remediation round. Appended by
   * the verification driver (initial block) and by every still-blocked
   * `harness recheck` (updated blocker set); the durable recheck read-model
   * (`MERGE_READINESS_BLOCKED_PROJECTION`) is persisted alongside. `harness
   * recheck` re-probes and ingests T24 once clear.
   */
  'merge.readiness.blocked': {
    readonly blockers: readonly string[];
    readonly mergeReadiness: MergeReadiness;
  };
  /**
   * W3-1 — verification-runner confinement incident: the PRIMARY checkout's
   * git state (HEAD + porcelain) drifted across the implementor round's
   * host-run spec verification commands — proof they escaped the worktree.
   * A plain durable supporting event appended by the implement→verify loop
   * driver at detection (before the verifier round); the round's
   * verification fails honestly and the §16 readiness gate blocks with the
   * `verification-runner violation` blocker.
   */
  'verification.runner.violation': {
    readonly assignmentId: AssignmentId;
    /** The PRIMARY checkout root that mutated. */
    readonly repoRoot: string;
    readonly headBefore: GitSha;
    /** Absent when the primary checkout became unreadable after the commands. */
    readonly headAfter?: GitSha;
    /** Porcelain paths whose status changed across the commands (bounded). */
    readonly changedPaths: readonly string[];
    /** Redacted human-readable summary of the drift. */
    readonly detail: string;
  };
  /** T17 — recovery per §12.3 begins for the interrupted segment. */
  'recovery.initiated': {
    readonly segmentId: SegmentId;
  };
  /** T20 — decision pending (projection shows "Waiting on you"). */
  'permission.decision.required': {
    readonly segmentId?: SegmentId;
    readonly requestId: string;
  };
  /**
   * W2-1 (pushback item 8) — the next resume probe, computed by the PURE
   * scheduler (W2-4) from the run's pinned config and appended explicitly;
   * the T10 reducer only folds probe counts and never schedules. `at` is an
   * absolute deadline anchored to EVENT timestamps (incident/T10 times) so a
   * restart never re-anchors it to `now`.
   */
  'limit.probe.scheduled': {
    /** Absolute probe deadline (event-timestamp-anchored, jitter folded in). */
    readonly at: IsoTimestamp;
    /** The ladder rung in minutes (from the per-run pinned config);
     * 0 = retry_after-anchored — the deadline is the provider's own
     * `resumes_at`, not a ladder rung (W2-4 `ETA_ANCHORED_RUNG`). */
    readonly rung: number;
    /** 1-based probe index within the incident (bounded per incident). */
    readonly probeIndex: number;
  };
  /**
   * W2-4 — fenced probe claim keyed (runId, incidentId, probeIndex),
   * committed BEFORE probing (`probeClaimKey` is its idempotency key); its
   * derived `probeOutcomeKey` is the idempotency fence for the resulting
   * T9/T10/inconclusive event, so two concurrent waiters can never
   * double-probe a rung or double-count T10 (../scheduler/limit-schedule.ts).
   */
  'limit.probe.claimed': {
    readonly incidentId: LimitIncidentId;
    readonly probeIndex: number;
  };
  /**
   * W2-4 — a probe failed for a NON-limit reason (auth/protocol/crash/
   * budget/unknown): the run STAYS paused, automatic probing STOPS (no T10
   * increment, never the breaker), manual `resume` remains available. A
   * supporting event on purpose: legal under `paused_limit`, where T16
   * (which requires suspension=none) must never be reused.
   */
  'limit.probe.inconclusive': {
    readonly classifiedKind: ClassifiedErrorKind;
    readonly detail: string;
    readonly probeIndex?: number;
  };
  /** §14 self-supervision heartbeat (60s) so a stall is observable. */
  'orchestrator.heartbeat': {
    readonly rssBytes?: number;
  };
}

export type DomainEventType = keyof EventPayloads;

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------
export interface EventBase<TType extends DomainEventType, TPayload> {
  readonly type: TType;
  readonly runId: RunId;
  /** Monotonic per-run sequence; SEQUENCE_UNASSIGNED until appended. */
  readonly sequence: EventSequence;
  readonly idempotencyKey: IdempotencyKey;
  readonly occurredAt: IsoTimestamp;
  readonly payload: TPayload;
}

export type EventOfType<T extends DomainEventType> = EventBase<T, EventPayloads[T]>;

/** The `Event` entity of PLAN §6.1. */
export type DomainEvent = { [K in DomainEventType]: EventOfType<K> }[DomainEventType];

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------
export interface EventDraftInput<T extends DomainEventType> {
  readonly type: T;
  readonly runId: RunId;
  readonly payload: EventPayloads[T];
  readonly idempotencyKey: IdempotencyKey;
  readonly occurredAt: IsoTimestamp;
  readonly sequence?: EventSequence;
}

/** Build an event with an unassigned sequence placeholder by default. */
export function draftEvent<T extends DomainEventType>(input: EventDraftInput<T>): EventOfType<T> {
  return {
    type: input.type,
    runId: input.runId,
    sequence: input.sequence ?? SEQUENCE_UNASSIGNED,
    idempotencyKey: input.idempotencyKey,
    occurredAt: input.occurredAt,
    payload: input.payload,
  };
}

/**
 * Deterministic idempotency key for an event DERIVED from another event
 * (e.g. engine-emitted effects derive from the trigger's key), so replays
 * produce identical keys with no randomness inside the engine.
 */
export function deriveIdempotencyKey(
  base: IdempotencyKey,
  index: number,
  type: DomainEventType,
): IdempotencyKey {
  return idempotencyKey(`${base}#${index}:${type}`);
}
