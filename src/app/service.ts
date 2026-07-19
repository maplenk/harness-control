/**
 * Application service engine (PLAN §5, §6, §20 P3) — the orchestration core
 * that ties the domain engine, persistence write-path, adapters, supervisor,
 * and config together.
 *
 * THE authority for state (§6.3): a SINGLE `ingest(event)` path runs the pure
 * `applyTransition` and, for an applied transition, makes it durable through
 * `appendTriggerWithEffects` — one idempotent event append + projection update
 * in ONE transaction. Illegal transitions are rejected with a
 * `transition.rejected` event (also one atomic write). No source — adapter
 * updates, supervisor/watchdog/breaker/heartbeat events, or CLI commands —
 * ever mutates run state except by feeding an event through `ingest`.
 *
 * Two kinds of state change, kept cleanly separate:
 *  1. **§6.3 engine transitions (T1–T25)** — approval, revise, supersession,
 *     every suspension/resume/limit/breaker path, verification outcomes, and
 *     the terminals — flow through `ingest`.
 *  2. **Linear forward workflow advances** — `created→specifying`,
 *     `specifying→awaiting_approval`, `approved→implementing`,
 *     `needs_remediation→implementing`, `implementing→verifying` — are the
 *     role-DISPATCH points the §6.3 table deliberately does NOT model (they
 *     have no preconditions and no orthogonal-axis interaction). They are
 *     driven through `advanceWorkflowPhase`, which appends a
 *     `workflow.dispatch.advanced` supporting event atomically with the
 *     EngineState projection update (W1-F6) so `recover()`'s event-log replay
 *     reconstructs the phase (§12.3). W2-3: production dispatches are
 *     pending/active SPLIT — the dispatch advance is taken inside `runRole`
 *     only after every §11.2 pin succeeded (see `RoleDispatch`).
 *
 * Role-flow SEAM: `runRole` owns the whole provider lifecycle (spawn via the
 * adapter factory → `child.spawn.initiated` → initialize → create session →
 * pin model/effort §11.2 with classification-precedes-retry (W2-3) →
 * `child.spawned` + dispatch advance → wire permission mediation §10.2 and
 * cost accounting §17.2 → run the flow (turns bracketed by
 * `turn.started`/`turn.completed`) → dispose → generation-matched
 * `child.stopped`). A `RoleRunner` (the three flows) only supplies turn
 * logic against the live `RoleSession`. Provider usage limits pause the run
 * durably via `pauseForLimit` (T4/T16), unwinding as `LimitPausedError`.
 */
import type { IsoTimestamp } from '../lib/clock.js';
import { type Clock } from '../lib/clock.js';
import { RandomIdFactory, type IdFactory } from '../lib/id-factory.js';
import {
  artifactHash,
  eventSequence,
  gitSha,
  newIdempotencyKey,
  newProcessGenerationId,
  newRunId,
  newSegmentId,
  specHash,
  type AcpSessionId,
  type ArtifactHash,
  type AssignmentId,
  type CriterionId,
  type GitSha,
  type IdempotencyKey,
  type NativeSessionId,
  type ProcessGenerationId,
  type RunId,
  type SegmentId,
  type SpecHash,
  type SpecVersionId,
} from '../domain/ids.js';
import {
  deriveIdempotencyKey,
  draftEvent,
  type ChildPinRecord,
  type ChildStopReason,
  type DomainEvent,
  type DomainEventType,
  type EventOfType,
  type EventPayloads,
  type LimitClassification,
  type SpecDraftRef,
} from '../domain/events.js';
import {
  applyTransition,
  initialEngineState,
  transitionForEvent,
  type EngineState,
  type RejectionReason,
  type TransitionId,
} from '../domain/transitions.js';
import {
  isLiveChild,
  type ActiveChild,
  type CheckpointReason,
  type ClassifiedErrorKind,
  type EngineBounds,
  type LimitIncidentKind,
  type Operation,
  type OperationKind,
  type RestartCounters,
  type ResumeReentryPending,
  type RoleName,
  type RunPhase,
  type SuspensionKind,
} from '../domain/state.js';
import type {
  CheckpointContent,
  PermissionPolicy,
  TurnUsage,
  WorktreeState,
} from '../domain/entities.js';
import { DEFAULT_ENGINE_CONFIG, parseEngineConfig, toEngineBounds } from '../config/loader.js';
import type { EngineConfig } from '../config/schema.js';
import { isErr, unwrap } from '../lib/result.js';
import {
  appendTriggerWithEffects,
  registerRun,
  type Database,
  type ProjectionRecord,
  type ProjectionUpdate,
} from '../persistence/index.js';
import {
  AdapterError,
  createClaudeAcpAdapter,
  createCodexAcpAdapter,
  isAdapterError,
  type CreateProviderAdapterOptions,
  type ErrorClassification,
  type HarnessAdapter,
  type PermissionMediationConfig,
  type SessionUpdate,
} from '../adapters/index.js';
import {
  DEFAULT_PROBE_ADOPT_AFTER_MS,
  computeResumePlan,
  decideClaim,
  incidentIdOf,
  latestIncidentEvent,
  probeClaimKey,
  probeOutcomeKey,
  probeScheduleKey,
  type LadderExhaustedPlan,
  type ProbeAtPlan,
  type ResumeNowPlan,
  type ResumePlan,
} from '../scheduler/limit-schedule.js';
import { buildCheckpointContent, deriveIncompleteOperation } from '../checkpoint/content.js';
import { writeCheckpoint } from '../checkpoint/writer.js';
import { redactFlattenedJson, redactText } from '../redaction/index.js';
import { sha256Hex } from '../artifacts/hash.js';
import * as git from '../worktree/git.js';
import {
  HeartbeatEmitter,
  MaxLiveChildrenGuard,
  MaxLiveChildrenExceededError,
  ProcessRegistry,
  Watchdog,
  createEnvNonceVerifier,
  createPsClient,
  startHeartbeat,
  type EnvNonceVerifier,
  type GitOpLeaseObserver,
  type HeartbeatScheduleHandle,
  type IdentityAlert,
  type IdentityVerdict,
  type ProcessIdentity,
  type ProcessRegistryStore,
  type PsClient,
  type ReapSummary,
  type WorktreeTaintSink,
} from '../supervisor/index.js';
import { BYTES_PER_MB } from '../config/schema.js';
import { DurableProcessRegistryStore } from './process-registry-store.js';
import { DurableSpawnReservationStore, type SpawnReservationRecord } from './spawn-reservation-store.js';
import {
  applyRoleModel,
  resolveRoleModel,
  type AppliedConfigOption,
  type ConfigOptionPurpose,
  type ResolvedRoleModel,
  type RoleModelSpec,
} from './model-resolution.js';
import {
  emptyCostProjection,
  foldTurnUsage,
  foldUsageUpdate,
  wouldExceedBudget,
  type CostProjectionState,
} from './cost.js';
import type { PermissionMediation, RoleRunner, RoleSession } from './role-runner.js';
import {
  COST_PROJECTION,
  ENGINE_STATE_PROJECTION,
  IMPLEMENT_VERIFY_LOOP_PROJECTION,
  MERGE_READINESS_BLOCKED_PROJECTION,
  ROLE_ROUND_PROJECTION,
  RUN_CONFIG_PROJECTION,
  RUN_META_PROJECTION,
  SPEC_DRAFT_PROJECTION,
  WORKFLOW_DISPATCH_EDGES,
  isEngineFoldedSupportingEvent,
  makeEngineReducer,
  uiStateOf,
  type ImplementVerifyLoopState,
  type MergeReadinessBlockedState,
  type RoleRoundAdvance,
  type RoleRoundProjection,
  type RunMeta,
  type SpecDraftState,
  type UiState,
} from './projections.js';

// Re-exported so existing `./service.js` importers keep the historical name;
// the definition moved to `./projections.js` where the engine reducer
// validates replayed `workflow.dispatch.advanced` events against it (W1-F6).
export { WORKFLOW_DISPATCH_EDGES } from './projections.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export class RunNotFoundError extends Error {
  override readonly name: string = 'RunNotFoundError';
  readonly runId: RunId;
  constructor(runId: RunId) {
    super(`Run not found: ${runId}`);
    this.runId = runId;
  }
}

export class WorkflowAdvanceError extends Error {
  override readonly name: string = 'WorkflowAdvanceError';
}

/**
 * W2-0 — `workflow.dispatch.advanced` was fed to the PUBLIC `ingest` path.
 * `advanceWorkflowPhase` is its only legal producer (it validates the edge +
 * suspension axis before appending); accepting it here would let any caller
 * fabricate phase advances that bypass that validation.
 */
export class WorkflowDispatchIngestError extends Error {
  override readonly name: string = 'WorkflowDispatchIngestError';
  readonly runId: RunId;
  constructor(runId: RunId) {
    super(
      `ingest: 'workflow.dispatch.advanced' cannot be ingested directly for run ${runId} — ` +
        `call advanceWorkflowPhase(runId, from, to), its only legal producer`,
    );
    this.runId = runId;
  }
}

/**
 * §11.2 (W1-F8) — a model/effort pin failed and its ONE retry failed too: the
 * spawn fails honestly instead of letting the role silently run on the
 * provider's default model. Names the role, the failed intent (purpose +
 * resolved wire option id + requested value), and both attempts' errors.
 */
export class ModelPinError extends Error {
  override readonly name: string = 'ModelPinError';
  readonly runId: RunId;
  readonly role: RoleName;
  readonly purpose: ConfigOptionPurpose;
  readonly optionId: string;
  readonly value: string;
  readonly firstError: string;
  readonly retryError: string;
  constructor(
    runId: RunId,
    role: RoleName,
    purpose: ConfigOptionPurpose,
    optionId: string,
    value: string,
    firstError: string,
    retryError: string,
  ) {
    super(
      `Model pin failed for run ${runId} (${role}): ${purpose} option '${optionId}'=${JSON.stringify(value)} ` +
        `failed after one retry (§11.2) — first: ${firstError}; retry: ${retryError}`,
    );
    this.runId = runId;
    this.role = role;
    this.purpose = purpose;
    this.optionId = optionId;
    this.value = value;
    this.firstError = firstError;
    this.retryError = retryError;
  }
}

/** The operation window a provider-call failure was classified under (W2-3):
 * the spawn's §11.2 pin window, or an actual prompt turn. */
export type PausedOperation = 'initial_config_pin' | 'prompt_turn';

/**
 * W2-3 — the run was DURABLY paused by `pauseForLimit` (T4 family for a
 * classified `usage_limit`, T16 for `unknown_provider_error`): checkpoint
 * fsynced, ONE atomic append committed (trigger + checkpoint.recorded +
 * incident + stop-intent), child cancelled/disposed, generation-matched
 * `child.stopped` confirmed. Thrown out of `runRole` so every caller
 * (start / spec-revise / run loops) unwinds — the run is left suspended
 * `paused_limit`, resumable via the scheduler (W2-4) or manual `resume`.
 */
export class LimitPausedError extends Error {
  override readonly name: string = 'LimitPausedError';
  readonly runId: RunId;
  readonly role: RoleName;
  readonly transitionId: 'T4' | 'T16';
  readonly incidentKind: LimitIncidentKind;
  readonly operation: PausedOperation;
  readonly classification: LimitClassification;
  /** §12.2 checkpoint artifact — absent only when quota admission rejected
   * the checkpoint write (the pause still committed; documented below). */
  readonly checkpointArtifactHash?: ArtifactHash;
  constructor(input: {
    readonly runId: RunId;
    readonly role: RoleName;
    readonly transitionId: 'T4' | 'T16';
    readonly incidentKind: LimitIncidentKind;
    readonly operation: PausedOperation;
    readonly classification: LimitClassification;
    readonly checkpointArtifactHash?: ArtifactHash;
  }) {
    super(
      `Run ${input.runId} paused (${input.transitionId}): ${input.classification.kind} from ` +
        `${input.classification.provider} during ${input.operation} (${input.role}); ` +
        `resumes at ${input.classification.resumesAt ?? 'unknown'} — scheduled probe or manual resume.`,
    );
    this.runId = input.runId;
    this.role = input.role;
    this.transitionId = input.transitionId;
    this.incidentKind = input.incidentKind;
    this.operation = input.operation;
    this.classification = input.classification;
    if (input.checkpointArtifactHash !== undefined) {
      this.checkpointArtifactHash = input.checkpointArtifactHash;
    }
  }
}

/**
 * W2-3 — `pauseForLimit` composed a T4/T16 trigger the engine REJECTED for a
 * reason other than an already-paused run (a wiring bug: wrong operation
 * axis, no live generation, …). The rejection is durable
 * (`transition.rejected` appended); this error is loud on purpose.
 */
export class PauseCompositionError extends Error {
  override readonly name: string = 'PauseCompositionError';
  readonly runId: RunId;
  readonly detail: string;
  constructor(runId: RunId, detail: string) {
    super(`pauseForLimit: the pause trigger was rejected for run ${runId} — ${detail}`);
    this.runId = runId;
    this.detail = detail;
  }
}

/**
 * W2-4 — the scheduled-probe path hit a WIRING bug, not a provider failure:
 * a `paused_limit` run whose log has no `limit.incident.recorded`, or a
 * paused non-coordinator round with no recorded `modelSpec` to pin the probe
 * identically. Loud on purpose — provider-shaped probe failures never land
 * here (they resolve as still-limited or `limit.probe.inconclusive`).
 */
export class ProbeSchedulingError extends Error {
  override readonly name: string = 'ProbeSchedulingError';
  readonly runId: RunId;
  constructor(runId: RunId, detail: string) {
    super(`runScheduledProbe: ${detail} (run ${runId})`);
    this.runId = runId;
  }
}

/** W2-5 eligibility refusal reasons: the assignment went stale (a supersession
 * landed after the round's dispatch), or the four-way spec binding chain broke
 * (`checkpoint.specHash == assignment.specHash == engine approvedSpecHash ==
 * current draft.specHash`). */
export type ResumeRefusalReason = 'assignment_stale' | 'spec_binding_mismatch';

export type ResumeEligibility =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly reason: ResumeRefusalReason;
      readonly detail: string;
    };

/**
 * W2-5 (pushback item 8) — resume was REFUSED by the transactional
 * eligibility check that runs BEFORE any T9/T12/interrupted re-entry: the
 * round's assignment is stale, or the spec binding chain
 * (checkpoint == assignment == approved == current draft) broke. The
 * suspension is NOT cleared — a superseded spec can never resurrect an old
 * round; re-approve/re-dispatch under the current spec instead.
 */
export class ResumeEligibilityError extends Error {
  override readonly name: string = 'ResumeEligibilityError';
  readonly runId: RunId;
  readonly reason: ResumeRefusalReason;
  readonly detail: string;
  constructor(runId: RunId, reason: ResumeRefusalReason, detail: string) {
    super(`resume refused for run ${runId} (${reason}): ${detail} — suspension unchanged (W2-5)`);
    this.runId = runId;
    this.reason = reason;
    this.detail = detail;
  }
}

/** §17.2 — a new turn was refused because measured + estimated spend + reservation
 * exceeds the estimated soft budget (W1-F5: estimated spend counts too — a run of
 * purely unpriced subscription turns must still trip the refusal). */
export class BudgetExceededError extends Error {
  override readonly name: string = 'BudgetExceededError';
  readonly runId: RunId;
  readonly role: RoleName;
  readonly spentUsd: number;
  readonly estimatedUsd: number;
  readonly reservationUsd: number;
  readonly budgetUsd: number;
  constructor(
    runId: RunId,
    role: RoleName,
    spentUsd: number,
    estimatedUsd: number,
    reservationUsd: number,
    budgetUsd: number,
  ) {
    super(
      `Estimated budget exceeded for run ${runId} (${role}): spent ${spentUsd} + estimated ${estimatedUsd} ` +
        `+ reservation ${reservationUsd} > budget ${budgetUsd} (§17.2)`,
    );
    this.runId = runId;
    this.role = role;
    this.spentUsd = spentUsd;
    this.estimatedUsd = estimatedUsd;
    this.reservationUsd = reservationUsd;
    this.budgetUsd = budgetUsd;
  }
}

// ---------------------------------------------------------------------------
// Adapter factory seam (production spawns real adapters; tests inject fakes)
// ---------------------------------------------------------------------------
export interface RoleAdapterOptions {
  readonly role: RoleName;
  readonly cwd: string;
  readonly clock: Clock;
  readonly permissions: PermissionMediationConfig;
  readonly resolved: ResolvedRoleModel;
}

export interface RoleAdapterHandle {
  readonly adapter: HarnessAdapter;
  /**
   * W2-6 (§14): capture the live child's `ProcessIdentity` — {pid, pgid,
   * process start-time, executable path, generation id, `HARNESS_SPAWN_ID`
   * nonce} — sampled RIGHT NOW as the baseline every later §14
   * re-verification compares against. `undefined` when there is no OS
   * process to identify: not spawned yet (capture runs after
   * `initialize()`), already exited, or an in-process fake — the service
   * then supervises nothing, honestly, rather than registering a
   * fabricated identity. Optional so bare test handles stay valid.
   */
  captureProcessIdentity?(generationId: ProcessGenerationId): ProcessIdentity | undefined;
  /** Terminate + reap the process group / dispose factory resources (§10.1, §17.1). Idempotent. */
  dispose(): Promise<void>;
}

/** Seam over the provider adapter factories (`createClaudeAcpAdapter` /
 * `createCodexAcpAdapter`); tests inject an in-process fake to avoid spawns. */
export interface RoleAdapterFactory {
  create(options: RoleAdapterOptions): RoleAdapterHandle;
}

/**
 * W2-6: capture the §14 `ProcessIdentity` of a live ACP child. The pid and
 * the `HARNESS_SPAWN_ID` nonce come from the transport the adapter spawned;
 * start-time / executable / pgid are sampled via `ps` AT CAPTURE TIME — this
 * sample IS the verification baseline (`ProcessRegistry.registerCaptured`
 * stores it verbatim, never re-samples). Returns `undefined` when no process
 * exists (pre-`initialize()`, already exited, or the ps row is gone) or when
 * the sampled pid no longer names the transport's pid.
 */
export function captureAcpProcessIdentity(
  adapter: {
    readonly transportPid?: number | undefined;
    readonly transportSpawnId?: string | undefined;
  },
  generationId: ProcessGenerationId,
  ps: PsClient,
): ProcessIdentity | undefined {
  const pid = adapter.transportPid;
  const spawnNonce = adapter.transportSpawnId;
  if (pid === undefined || spawnNonce === undefined) return undefined;
  const sample = ps.sampleIdentity(pid);
  if (sample === undefined || sample.pid !== pid) return undefined;
  return {
    generationId,
    pid,
    pgid: sample.pgid,
    startedAt: sample.startedAt,
    executablePath: sample.executablePath,
    spawnNonce,
  };
}

/**
 * Production factory: real Claude/Codex ACP adapters. §17.1 H-1 — the Codex
 * path relies on `createCodexAcpAdapter`'s default isolated `CODEX_HOME`; this
 * call site NEVER forwards a user-controlled `CODEX_HOME` (no `codexHome`
 * override, no `env.CODEX_HOME`), so the isolation that routes approvals to
 * the ACP client cannot be bypassed.
 */
export function defaultRoleAdapterFactory(): RoleAdapterFactory {
  return {
    create(options: RoleAdapterOptions): RoleAdapterHandle {
      const base: CreateProviderAdapterOptions = {
        cwd: options.cwd,
        clock: options.clock,
        permissions: options.permissions,
      };
      const created =
        options.resolved.harness === 'claude'
          ? createClaudeAcpAdapter(base)
          : createCodexAcpAdapter(base);
      const ps = createPsClient(options.clock);
      return {
        adapter: created.adapter,
        // W2-6: real spawns expose their §14 identity for the durable
        // registry + watchdog wiring in `runRole`.
        captureProcessIdentity: (generationId: ProcessGenerationId) =>
          captureAcpProcessIdentity(created.adapter, generationId, ps),
        dispose: (): Promise<void> => created.adapter.close(),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------
export interface CreateRunInput {
  readonly goal: string;
  readonly workspacePath: string;
  /** The coordinator's resolved harness/model/effort (PLAN §7 proposes the
   * implementor/verifier profiles; those become `run` defaults later). */
  readonly coordinator: RoleModelSpec;
  /** Default `{mode:'headless'}` (deny-all, §10.2). */
  readonly mediation?: PermissionMediation;
}

export interface CreateRunResult {
  readonly runId: RunId;
}

/** Optional determinism/idempotency controls for a CLI command → trigger. */
export interface CommandOptions {
  readonly idempotencyKey?: IdempotencyKey;
  readonly occurredAt?: IsoTimestamp;
}

/**
 * W2-3 pending/active dispatch split — how a production role dispatch
 * (coordinator / implementor / verifier) is described to `runRole`:
 * the intended round persists `pending` BEFORE any spawn while the workflow
 * REMAINS at its previous stable phase; `advance` is taken (and the round
 * marked `active`) only after every §11.2 pin succeeded (`child.spawned`);
 * a non-limit pin failure leaves the `pending` round retryable by
 * `run`/`resume` with NO phase advanced. `binding`/`criterionIds` also feed
 * the §12.2 pause checkpoint (spec hash + per-criterion state).
 */
export interface RoleDispatch {
  /** 1-based round number within this role's dispatch lineage. */
  readonly round: number;
  /** The workflow advance taken ONLY after pins succeed. Omitted when the
   * run already sits at the round's phase (e.g. a T2 revise re-drive at
   * `specifying`, or a resume re-entry). */
  readonly advance?: RoleRoundAdvance;
  /** The advance the round's COMPLETION takes (recorded for W2-5 re-entry;
   * still performed by the dispatching caller). */
  readonly completionAdvance?: RoleRoundAdvance;
  /** Serialized role inputs (opaque; W2-5 drives re-entry from them). */
  readonly inputs?: string;
  readonly specHash?: SpecHash;
  readonly baseCommit?: GitSha;
  /** Verifier rounds: the exact implementation commit being verified. */
  readonly implementationCommit?: GitSha;
  /** Criterion ids known at dispatch — a pause checkpoint records them all
   * as `pending` (honest: nothing established mid-round; W2-5 refines). */
  readonly criterionIds?: readonly CriterionId[];
  readonly assignmentId?: AssignmentId;
}

export type IngestResult =
  | {
      readonly status: 'applied';
      readonly transitionId: TransitionId;
      readonly next: EngineState;
      /** The engine-emitted effect events, in append order (excludes the trigger). */
      readonly emitted: readonly DomainEvent[];
    }
  | {
      readonly status: 'rejected';
      readonly reason: RejectionReason;
      readonly detail: string;
      readonly rejection: DomainEvent;
    }
  | {
      /** A supporting event: a durable fact, not a transition. Most append
       * without touching state; the W2-1 engine-folded ones (child.spawned /
       * child.stopped / resume_reentry.completed) also fold the EngineState
       * projection in the same transaction. */
      readonly status: 'recorded';
      readonly event: DomainEvent;
      /** True when `(runId, idempotencyKey)` already existed — the append was
       * a no-op and `event` is the PRE-EXISTING durable event. Surfaced for
       * idempotency fences (W2-4 probe claims: a deduped claim append means
       * another waiter holds the probe). */
      readonly deduped: boolean;
    }
  | {
      /** A TRANSITION trigger whose append deduped under its idempotency key
       * (§6.1 "duplicate insert = one logical event"): the transition already
       * committed in an earlier append — nothing was appended, nothing was
       * re-folded, the projection is untouched — and `event` is the
       * PRE-EXISTING durable event. Distinct from 'applied' so a replay is
       * never mistaken for a fresh transition (W2-4: a duplicate T10 under a
       * used probe-outcome key must not read as a fresh probe outcome). */
      readonly status: 'deduped';
      readonly event: DomainEvent;
    };

/**
 * W2-4 — one `runScheduledProbe` step's honest result. `resumed` /
 * `still_limited` / `inconclusive` are PROBE outcomes (a claim was consumed);
 * the rest are schedule answers (nothing probed): `not_due` carries the
 * event-anchored wake time, `resume_now` the elapsed structured ETA,
 * `ladder_exhausted` the permanent per-incident stop, `claim_in_flight` /
 * `already_resolved` the claim-fence arbitration, `not_paused` the guard.
 */
export type ScheduledProbeOutcome =
  | { readonly outcome: 'resumed'; readonly probeIndex: number }
  | { readonly outcome: 'still_limited'; readonly probeIndex: number; readonly nextPlan: ResumePlan }
  | {
      readonly outcome: 'inconclusive';
      readonly probeIndex: number;
      readonly classifiedKind: ClassifiedErrorKind;
      readonly detail: string;
    }
  | { readonly outcome: 'not_due'; readonly plan: ProbeAtPlan }
  | { readonly outcome: 'resume_now'; readonly plan: ResumeNowPlan }
  | { readonly outcome: 'ladder_exhausted'; readonly plan: LadderExhaustedPlan }
  | { readonly outcome: 'not_paused'; readonly suspension: SuspensionKind }
  | { readonly outcome: 'claim_in_flight'; readonly probeIndex: number }
  | { readonly outcome: 'already_resolved'; readonly probeIndex: number };

export interface BudgetStatus {
  readonly spentUsd: number;
  /** §17.2 D-2 (W1-F5): estimated (reservation-folded) spend of unpriced turns,
   * shown APART from measured spend — both count toward the refusal predicate. */
  readonly estimatedSpendUsd: number;
  readonly reservationUsd: number;
  readonly maxBudgetUsd?: number;
}

export interface RunStatus {
  readonly runId: RunId;
  readonly phase: RunPhase;
  readonly suspension: SuspensionKind;
  readonly operation: OperationKind;
  /** §6.2 UI vocabulary projection (never stored). */
  readonly uiState: UiState;
  /** Derived from `activeChild` (W2-1): live until the stop is confirmed. */
  readonly childActive: boolean;
  /** W2-1 generation-tracked child record, when one has spawned. */
  readonly activeChild?: ActiveChild;
  /** W2-1: unacknowledged T9/T12 re-entry awaiting `resume_reentry.completed`. */
  readonly resumeReentryPending?: ResumeReentryPending;
  readonly counters: RestartCounters;
  readonly approvedSpecHash?: SpecHash;
  readonly cost: CostProjectionState;
  readonly budget: BudgetStatus;
  readonly goal?: string;
  readonly workspacePath?: string;
}

/**
 * W2-6 supervision wiring seams (§14). Everything defaults to the REAL
 * OS-facing implementations (durable SQLite registry store, `ps` sampling,
 * best-effort env-nonce verification, 60s heartbeat); tests inject fakes to
 * exercise the wiring deterministically. Supervision only ENGAGES for spawns
 * whose `RoleAdapterHandle` exposes a captured `ProcessIdentity` — an
 * in-process fake with no OS child is honestly left unsupervised.
 */
export interface SupervisionOptions {
  /** Defaults to `DurableProcessRegistryStore` over the service's database
   * (registry identity survives an orchestrator crash for startup reaping). */
  readonly registryStore?: ProcessRegistryStore;
  readonly ps?: PsClient;
  /** §14 nonce re-verification for startup reaping; defaults to the
   * platform best-effort reader (`createEnvNonceVerifier`). */
  readonly envNonce?: EnvNonceVerifier;
  /** Test seam for `ProcessRegistry`'s group-signal delivery. */
  readonly sendSignal?: (pgid: number, signal: NodeJS.Signals) => void;
  /** §14 self-supervision heartbeat cadence. Default 60_000ms. */
  readonly heartbeatIntervalMs?: number;
  /** Watchdog base sampling cadence (§14: 5s adaptive). Test seam. */
  readonly watchdogSampleIntervalMs?: number;
  /** Extra sink for §14 identity alerts (the durable
   * `process.identity.alert` event is always appended when the record
   * names its owning run). */
  readonly onIdentityAlert?: (alert: IdentityAlert) => void;
  /** W3-2: §10.2 terminate grace between the cross-process SIGTERM and the
   * SIGKILL escalation (`cancel` only). Default 2000ms. */
  readonly terminateGraceMs?: number;
  /** W3-2 test seam for the cross-process terminate-ladder grace sleep;
   * defaults to a real `setTimeout`. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** W3-5(a): the OS pid this service stamps as the OWNER of its durable
   * spawn reservations (§14 cross-process admission). Defaults to
   * `process.pid`; a test injects distinct pids to model two real CLI
   * processes over one database. */
  readonly selfPid?: number;
}

export interface OrchestrationServiceOptions {
  readonly db: Database;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly config?: EngineConfig;
  /** Defaults to `defaultRoleAdapterFactory()` (real spawns). */
  readonly adapterFactory?: RoleAdapterFactory;
  /** W2-6 §14 supervision seams; omit for production defaults. */
  readonly supervision?: SupervisionOptions;
}

const DEFAULT_HEADLESS_MEDIATION: PermissionMediation = { mode: 'headless' };

interface RoleSessionArgs {
  readonly runId: RunId;
  readonly role: RoleName;
  readonly resolved: ResolvedRoleModel;
  readonly adapter: HarnessAdapter;
  readonly handle: RoleSession['handle'];
  readonly capabilities: RoleSession['capabilities'];
  readonly configApplied: RoleSession['configApplied'];
  readonly cwd: string;
  readonly workspacePath: string;
}

/**
 * Everything the W2-3 pause spine needs about one spawn, threaded through
 * pin enforcement and the prompt wrapper so any provider-call failure can be
 * classified and routed (pause / interrupt / typed) with full context.
 * `acpSessionId`/`nativeSessionId` fill in once `createSession` succeeds.
 */
interface SpawnContext {
  readonly runId: RunId;
  readonly role: RoleName;
  readonly resolved: ResolvedRoleModel;
  readonly adapter: HarnessAdapter;
  readonly handle: RoleAdapterHandle;
  readonly segmentId: SegmentId;
  readonly generationId: ProcessGenerationId;
  readonly cwd: string;
  readonly mediation: PermissionMediation;
  readonly dispatch?: RoleDispatch;
  acpSessionId?: AcpSessionId;
  nativeSessionId?: NativeSessionId;
  /** W2-6: the §14 identity captured after spawn, when the handle exposes
   * one — its presence is what turns registry + watchdog supervision on. */
  identity?: ProcessIdentity;
}

/** Map the enforced §11.2 pins onto the `child.spawned` wire records
 * (`reasoning` intents are the EFFORT pins; echo facts preserved, W1-F8). */
function toChildPinRecords(applied: readonly AppliedConfigOption[]): ChildPinRecord[] {
  return applied.map((pin) => ({
    purpose: pin.intent.purpose === 'model' ? 'model' : 'effort',
    optionId: pin.resolvedOptionId,
    value: pin.intent.value,
    ...(pin.effectiveValue !== undefined ? { effectiveValue: pin.effectiveValue } : {}),
    echoed: pin.echoed === true,
  }));
}

/** W2-4: the probe's minimal prompt — the cheapest no-op turn (§13). */
export const PROBE_PROMPT = 'ping';

/** W2-4 — how one throwaway probe session concluded (before outcome append). */
type ProbeSessionResult =
  | { readonly kind: 'ok' }
  | { readonly kind: 'still_limited'; readonly classification: LimitClassification }
  | {
      readonly kind: 'inconclusive';
      readonly classifiedKind: ClassifiedErrorKind;
      readonly detail: string;
    };

/**
 * W2-3: a TYPED adapter-level configuration rejection — the adapter itself
 * refused the option/value (unknown option id, value outside the advertised
 * set, capability absent). This — and ONLY this — earns W1-F8's single pin
 * retry; an opaque provider failure that classifies `unknown_provider_error`
 * pauses fail-safe via T16 instead.
 */
function isConfigurationRejection(raw: unknown): boolean {
  return isAdapterError(raw) && (raw.kind === 'invalid_argument' || raw.kind === 'unsupported_capability');
}

/**
 * Flatten a raw provider failure into sink-safe text. The provider envelope
 * message is UNTRUSTED free text that can echo request details (API keys,
 * auth headers, credential URLs) — §17.1 requires redaction before EVERY
 * sink, so it is applied here, at the single choke point, and every
 * consumer (the durable `limit.probe.inconclusive.detail` payload, `status
 * --json`, CLI output, `ModelPinError` text) gets redacted text.
 * `redactFlattenedJson` (not plain `redactText`) because this is a FLAT
 * string sink where `redactDeep` is architecturally unreachable: the belt
 * locates balanced JSON substrings (including STRINGIFIED-JSON-in-JSON at
 * escape depth 0–3+), redacts them structurally by key name, and always
 * finishes with — or falls back to — a full `redactText` pass, so it is
 * never weaker than the previous behavior.
 */
function describeRawError(raw: unknown): string {
  return redactFlattenedJson(isAdapterError(raw) ? `${raw.kind}: ${raw.message}` : String(raw));
}

/**
 * §17.1 companion to `describeRawError` for the TYPED failure paths
 * (`auth`/`protocol`/`crash` in `#routePinFailure`/`#routeProviderFailure`):
 * those branches RETHROW the provider failure and it unwinds all the way to
 * the CLI's error rendering, so the rethrown error must already carry a
 * REDACTED message — the raw one embeds untrusted provider text (the
 * transport composes `${method} failed: ${envelope.message}` verbatim).
 * Shape is preserved (AdapterError kind / Error name) so upstream
 * `instanceof`/kind checks and re-classification keep working; the RAW
 * envelope is kept ONLY on the internal `envelope` field the profile
 * classifier consumes (`classifyError` recurses into it) — no sink renders
 * or persists it (`errorOutput` and the CLI fatal handler print
 * name/message/stack only, and both redact again at the sink: defense in
 * depth). The original stack is deliberately dropped — its first line
 * repeats the unredacted message.
 */
function toSinkSafeTypedError(raw: unknown): unknown {
  if (isAdapterError(raw)) {
    return new AdapterError(raw.kind, redactText(raw.message), {
      ...(raw.harnessId !== undefined ? { harnessId: raw.harnessId } : {}),
      ...(raw.envelope !== undefined ? { envelope: raw.envelope } : {}),
    });
  }
  if (raw instanceof Error) {
    const safe = new Error(redactText(raw.message));
    safe.name = raw.name;
    return safe;
  }
  return typeof raw === 'string' ? redactText(raw) : raw;
}

/**
 * W3-2 outcome of a cross-process child stop (`stopExternalChild`). `delivered`
 * says whether an OS signal actually went out to the child's process group.
 * Non-delivery is always honest about WHY: nothing to stop
 * (`no_active_child`), the child is live in THIS process so the in-process
 * stop path owns it (`in_process`), no durable registry record to reach it by
 * (`no_record`), the process was already gone (`already_gone`), or the §14
 * identity could not be confirmed so the signal was WITHHELD and an alert
 * raised (`withheld`, carrying the ambiguous verdict).
 */
export type CrossProcessStopOutcome =
  | {
      readonly delivered: false;
      readonly reason: 'no_active_child' | 'in_process' | 'no_record' | 'already_gone';
    }
  | { readonly delivered: false; readonly reason: 'withheld'; readonly verdict: IdentityVerdict }
  | { readonly delivered: true; readonly signal: NodeJS.Signals; readonly escalated: boolean };

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------
export class OrchestrationService {
  readonly #db: Database;
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #config: EngineConfig;
  readonly #bounds: EngineBounds;
  readonly #engineReducer: (state: EngineState, event: DomainEvent) => EngineState;
  readonly #adapterFactory: RoleAdapterFactory;
  readonly #mediation = new Map<string, PermissionMediation>();

  // ---- W2-6 supervision (§14) ---------------------------------------------
  readonly #registry: ProcessRegistry;
  readonly #ps: PsClient;
  /** W3-5 (§14 concurrency): in-process max-live-children guard; the cap is
   * ALSO enforced durably across processes via the shared reservation store. */
  readonly #concurrency: MaxLiveChildrenGuard;
  /** W3-5(a): durable spawn-slot reservations closing the cross-process
   * count-and-reserve TOCTOU (see `spawn-reservation-store.ts`). */
  readonly #reservations: DurableSpawnReservationStore;
  /** W3-5(a): the pid this process stamps as the OWNER of its reservations
   * (its OWN reservations are always live — it is, by definition, running). */
  readonly #selfPid: number;
  readonly #watchdog: Watchdog;
  readonly #heartbeat: HeartbeatEmitter;
  readonly #heartbeatIntervalMs: number;
  readonly #onIdentityAlert: ((alert: IdentityAlert) => void) | undefined;
  /** W3-2: §10.2 terminate grace + injectable sleep for the cross-process
   * cancel escalation ladder (SIGTERM → grace → SIGKILL). */
  readonly #terminateGraceMs: number;
  readonly #crossProcessStopSleep: (ms: number) => Promise<void>;
  /** Live spawn contexts by generation — the watchdog's graceful-stop path
   * resolves its target through this. */
  readonly #liveSpawns = new Map<ProcessGenerationId, SpawnContext>();
  /** Runs with a role spawn in flight (heartbeat refcount, §14). */
  readonly #activeSpawnRuns = new Map<RunId, number>();
  /** W2-4: probe claims THIS process is currently executing (in-memory leg of
   * the claim fence — the durable leg is the `limit.probe.claimed` event). */
  readonly #probeClaimsInFlight = new Set<string>();
  #heartbeatHandle: HeartbeatScheduleHandle | undefined;
  /** §16.3/§14: the CURRENT worktree manager (taint + git-op lease), attached
   * by whoever owns worktrees for the run (the implement→verify loop). */
  #worktreeSupervision: (WorktreeTaintSink & GitOpLeaseObserver) | undefined;
  /** Supervision callbacks must never throw into watchdog timers; failures
   * are counted (observable) instead of crashing the sampling loop. */
  #supervisionIngestErrors = 0;

  constructor(options: OrchestrationServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? options.db.clock;
    this.#ids = options.ids ?? new RandomIdFactory();
    this.#config = options.config ?? DEFAULT_ENGINE_CONFIG;
    this.#bounds = toEngineBounds(this.#config);
    this.#engineReducer = makeEngineReducer(this.#bounds);
    this.#adapterFactory = options.adapterFactory ?? defaultRoleAdapterFactory();

    // W2-6 §14 assembly. The registry store is DURABLE by default (SQLite
    // projection layer) so identity survives an orchestrator crash; every
    // kill anywhere in the service goes through `#registry.signalVerified`.
    const supervision = options.supervision ?? {};
    const ps = supervision.ps ?? createPsClient(this.#clock);
    this.#ps = ps;
    this.#concurrency = new MaxLiveChildrenGuard({ maxLiveChildren: this.#config.maxLiveChildren });
    this.#reservations = new DurableSpawnReservationStore(this.#db);
    this.#selfPid = supervision.selfPid ?? process.pid;
    this.#onIdentityAlert = supervision.onIdentityAlert;
    this.#registry = new ProcessRegistry({
      clock: this.#clock,
      store: supervision.registryStore ?? new DurableProcessRegistryStore(this.#db),
      ps,
      envNonce: supervision.envNonce ?? createEnvNonceVerifier(),
      ...(supervision.sendSignal !== undefined ? { sendSignal: supervision.sendSignal } : {}),
      onAlert: (alert) => this.#recordIdentityAlert(alert),
    });
    this.#watchdog = new Watchdog({
      clock: this.#clock,
      ids: this.#ids,
      registry: this.#registry,
      ps,
      memory: this.#config.memory,
      ...(supervision.watchdogSampleIntervalMs !== undefined
        ? { sampleIntervalMs: supervision.watchdogSampleIntervalMs }
        : {}),
      // §14/§16.2: routed through the CURRENTLY attached worktree manager —
      // absent one there is no lease system to wait on and no taint book to
      // mark (the engine's own `worktree.tainted` effect event still lands).
      gitOpLease: {
        awaitGitOpIdle: (deadlineMs) =>
          this.#worktreeSupervision !== undefined
            ? this.#worktreeSupervision.awaitGitOpIdle(deadlineMs)
            : Promise.resolve('idle' as const),
      },
      worktreeTaint: {
        markTainted: (assignmentId, taint) =>
          this.#worktreeSupervision?.markTainted(assignmentId, taint),
      },
      requestGracefulStop: (target) => this.#onWatchdogGracefulStop(target.generationId),
      // T21/T22 ingest through the service — the SAME single transition path
      // every other event takes; a throw must never escape into a timer.
      onEvent: (event) => this.#ingestFromSupervisor(event),
      // §12.1: raw RSS ticks land in the telemetry repository (aggregated
      // per-minute there; raw samples pruned by its own retention).
      onSample: (target, sample) => {
        try {
          this.#db.telemetry.recordRawSample({
            runId: target.runId,
            processGenerationId: target.generationId,
            sampledAt: sample.sampledAt,
            rssBytes: sample.rssBytes,
            ...(target.segmentId !== undefined ? { segmentId: target.segmentId } : {}),
          });
        } catch {
          this.#supervisionIngestErrors += 1;
        }
      },
    });
    this.#heartbeat = new HeartbeatEmitter({
      clock: this.#clock,
      ids: this.#ids,
      onEvent: (event) => this.#ingestFromSupervisor(event),
      sampleOwnRssBytes: () => process.memoryUsage().rss,
    });
    this.#heartbeatIntervalMs = supervision.heartbeatIntervalMs ?? 60_000;
    this.#terminateGraceMs = supervision.terminateGraceMs ?? 2_000;
    this.#crossProcessStopSleep =
      supervision.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))));
  }

  /**
   * W2-6 introspection surface: the assembled §14 components. The CLI's
   * startup path uses `reapOrphanProcesses()`/`confirmStopIntentAfterCleanup`
   * rather than reaching in here; tests drive `watchdog.sampleOnce` and read
   * `registry.store` through it.
   */
  get supervision(): {
    readonly registry: ProcessRegistry;
    readonly watchdog: Watchdog;
    readonly heartbeat: HeartbeatEmitter;
    readonly ingestErrorCount: number;
  } {
    return {
      registry: this.#registry,
      watchdog: this.#watchdog,
      heartbeat: this.#heartbeat,
      ingestErrorCount: this.#supervisionIngestErrors,
    };
  }

  /**
   * §14/§16.2-3: attach the worktree manager whose taint book + git-op lease
   * the watchdog's T22 kill path must respect. One at a time (the MVP is
   * serial-per-run); the implement→verify loop attaches its manager for the
   * loop's duration and detaches in its finally.
   */
  attachWorktreeSupervision(manager: WorktreeTaintSink & GitOpLeaseObserver): void {
    this.#worktreeSupervision = manager;
  }

  detachWorktreeSupervision(): void {
    this.#worktreeSupervision = undefined;
  }

  // ---- Run lifecycle -------------------------------------------------------
  /** Create a run at phase `created` (§6.2) with an initial EngineState, empty
   * cost projection, immutable meta, and the resolved engine config the run
   * binds to (W1-F5 durability) — all in one transaction. */
  createRun(input: CreateRunInput): CreateRunResult {
    const runId = newRunId(this.#ids);
    const initial = initialEngineState({ bounds: this.#bounds });
    const meta: RunMeta = {
      goal: input.goal,
      workspacePath: input.workspacePath,
      coordinator: input.coordinator,
    };
    this.#db.transaction(() => {
      registerRun(this.#db.driver, this.#clock, runId);
      this.#db.projections.save(runId, ENGINE_STATE_PROJECTION, initial);
      this.#db.projections.save(runId, COST_PROJECTION, emptyCostProjection());
      this.#db.projections.save(runId, RUN_META_PROJECTION, meta);
      // W1-F5: config binds at start — persist the resolved EngineConfig so a
      // later, separate CLI process resolves this run under the SAME
      // bounds/budget/quotas (see `loadRunConfig`). Never re-saved.
      this.#db.projections.save(runId, RUN_CONFIG_PROJECTION, this.#config);
    });
    this.#mediation.set(runId, input.mediation ?? DEFAULT_HEADLESS_MEDIATION);
    return { runId };
  }

  /**
   * THE authoritative state-change path (§6.3). Trigger events (T1–T25) run
   * `applyTransition`; an applied transition is one atomic event+projection
   * write, an illegal one appends a `transition.rejected` event (also atomic).
   * Supporting events (heartbeat, checkpoint.recorded, notify.requested, late
   * provider notifications, …) are durable FACTS, appended without a
   * transition — except the W2-1 engine-folded ones (child lifecycle +
   * re-entry acks), which fold the EngineState projection atomically, and
   * `workflow.dispatch.advanced`, which public ingest REFUSES (W2-0:
   * `advanceWorkflowPhase` is its only legal producer). No source bypasses
   * this method.
   */
  ingest(event: DomainEvent): IngestResult {
    // W2-0: `workflow.dispatch.advanced` has exactly one legal producer —
    // `advanceWorkflowPhase` (which validates edge + phase + suspension
    // before appending). Public ingest refuses it with a typed error.
    if (event.type === 'workflow.dispatch.advanced') {
      throw new WorkflowDispatchIngestError(event.runId);
    }
    const row = transitionForEvent(event.type);
    if (row === undefined) {
      // W2-1/W2-3: the engine-folded supporting events (child.spawn.initiated
      // / child.spawned / child.stopped / turn.started / turn.completed /
      // resume_reentry.completed) mutate EngineState — they go through the
      // same one-transaction append+projection write path as transitions so
      // `recover()` replays them identically. All other supporting events
      // are plain durable facts.
      if (isEngineFoldedSupportingEvent(event.type)) {
        const record = this.#loadEngineRecord(event.runId);
        const written = appendTriggerWithEffects(this.#db, event, [], {
          name: ENGINE_STATE_PROJECTION,
          currentState: { ...record.state, bounds: this.#bounds },
          reduceEvent: this.#engineReducer,
        });
        const appended = written.appended[0];
        if (appended === undefined) {
          throw new Error('ingest: appendTriggerWithEffects returned no outcome for a folded supporting event');
        }
        return { status: 'recorded', event: appended.event, deduped: appended.deduped };
      }
      const [outcome] = this.#db.events.appendBatch([event]);
      if (outcome === undefined) {
        throw new Error('ingest: appendBatch returned no outcome for a supporting event');
      }
      return { status: 'recorded', event: outcome.event, deduped: outcome.deduped };
    }

    const record = this.#loadEngineRecord(event.runId);
    const currentState: EngineState = { ...record.state, bounds: this.#bounds };
    const outcome = applyTransition(currentState, event);
    const projection: ProjectionUpdate<EngineState> = {
      name: ENGINE_STATE_PROJECTION,
      currentState,
      reduceEvent: this.#engineReducer,
    };

    if (outcome.status === 'rejected') {
      const rejectionEvent = outcome.rejectionEvent as DomainEvent;
      const written = appendTriggerWithEffects(this.#db, rejectionEvent, [], projection);
      return {
        status: 'rejected',
        reason: outcome.reason,
        detail: outcome.detail,
        rejection: written.appended[0]?.event ?? rejectionEvent,
      };
    }

    const written = appendTriggerWithEffects(this.#db, event, outcome.emitted, projection);
    const triggerOutcome = written.appended[0];
    if (triggerOutcome !== undefined && triggerOutcome.deduped) {
      // The trigger key was already consumed by an earlier append: the write
      // path skipped the fold (no projection change) and this replay must
      // not report a fresh 'applied' transition (W2-4: a duplicate T10 would
      // otherwise read as a fresh probe outcome).
      return { status: 'deduped', event: triggerOutcome.event };
    }
    return {
      status: 'applied',
      transitionId: outcome.transitionId,
      // Re-inject bounds (config, not state — can be Infinity, which JSON drops).
      next: { ...written.projection.state, bounds: this.#bounds },
      emitted: written.appended.slice(1).map((o) => o.event),
    };
  }

  /**
   * A linear forward workflow dispatch advance (§6.2) — NOT a §6.3 transition.
   * Validated against `WORKFLOW_DISPATCH_EDGES`, the current phase, and the
   * suspension axis, then made durable as a `workflow.dispatch.advanced`
   * supporting event appended through the same `appendTriggerWithEffects`
   * write path as transitions — one idempotent event append + projection fold
   * in ONE transaction (W1-F6: a projection-only save is invisible to
   * `recover()`'s event-log replay, which would rebuild the wrong phase and
   * reject later transitions).
   *
   * `opts.draft` (W3-4) stamps the coordinator-completion draft ref on the
   * event and is legal ONLY on the `specifying → awaiting_approval` edge —
   * `completeCoordinationRound` is its producer; every other advance carries
   * the plain `{from, to}` payload.
   */
  advanceWorkflowPhase(
    runId: RunId,
    from: RunPhase,
    to: RunPhase,
    opts?: { readonly draft?: SpecDraftRef },
  ): EngineState {
    if (!WORKFLOW_DISPATCH_EDGES.some(([a, b]) => a === from && b === to)) {
      throw new WorkflowAdvanceError(
        `Not a workflow dispatch advance: ${from} -> ${to} (§6.3 transitions go through ingest)`,
      );
    }
    if (opts?.draft !== undefined && !(from === 'specifying' && to === 'awaiting_approval')) {
      throw new WorkflowAdvanceError(
        `A spec-draft ref rides only the coordinator completion advance (specifying -> awaiting_approval), not ${from} -> ${to} (W3-4)`,
      );
    }
    const record = this.#loadEngineRecord(runId);
    const state: EngineState = { ...record.state, bounds: this.#bounds };
    if (state.phase !== from) {
      throw new WorkflowAdvanceError(`Run ${runId} is at '${state.phase}', not '${from}'`);
    }
    if (state.suspension.kind !== 'none') {
      throw new WorkflowAdvanceError(
        `Run ${runId} is suspended (${state.suspension.kind}); cannot advance workflow`,
      );
    }
    const advance = this.#trigger(runId, 'workflow.dispatch.advanced', {
      from,
      to,
      ...(opts?.draft !== undefined ? { draft: opts.draft } : {}),
    }) as DomainEvent;
    const written = appendTriggerWithEffects(this.#db, advance, [], {
      name: ENGINE_STATE_PROJECTION,
      currentState: state,
      reduceEvent: this.#engineReducer,
    });
    // Re-inject bounds (config, not state — can be Infinity, which JSON drops).
    return { ...written.projection.state, bounds: this.#bounds };
  }

  /**
   * Rebuild (or catch up) the EngineState projection by replaying the event
   * log through the transition reducer (§12.3). Bounds are re-injected from
   * config (stored bounds are never trusted).
   */
  recover(runId: RunId): EngineState {
    const initial = initialEngineState({ bounds: this.#bounds });
    const record = this.#db.projections.recover<EngineState>(
      runId,
      ENGINE_STATE_PROJECTION,
      this.#engineReducer,
      initial,
    );
    return { ...record.state, bounds: this.#bounds };
  }

  // ---- CLI command wrappers (each normalizes into `ingest`) ----------------
  /** T1 — spec approved (human). */
  approve(
    runId: RunId,
    input: { readonly specVersionId: SpecVersionId; readonly specHash: SpecHash },
    opts?: CommandOptions,
  ): IngestResult {
    return this.ingest(
      this.#trigger(
        runId,
        'spec.approved',
        { specVersionId: input.specVersionId, specHash: input.specHash, approvedBy: 'human' },
        opts,
      ) as DomainEvent,
    );
  }

  /** T2 — `spec revise --feedback`. */
  reviseSpec(runId: RunId, feedback: string, opts?: CommandOptions): IngestResult {
    return this.ingest(this.#trigger(runId, 'spec.revise.requested', { feedback }, opts) as DomainEvent);
  }

  /** T18 — cancel (idempotent, one terminal result). */
  cancel(runId: RunId, opts?: CommandOptions): IngestResult {
    return this.ingest(this.#trigger(runId, 'cancel.requested', {}, opts) as DomainEvent);
  }

  /** T11 — user pause. */
  pause(runId: RunId, opts?: CommandOptions): IngestResult {
    return this.ingest(this.#trigger(runId, 'pause.user.requested', {}, opts) as DomainEvent);
  }

  /**
   * W3-2 — deliver a `pause`/`cancel` stop to a child that is running in
   * ANOTHER process. A pause/cancel issued from a SECOND CLI process only
   * appends the intent; the live child keeps running in the FIRST process. To
   * actually stop it, the intent's owner routes the stop through the DURABLE
   * §14 process registry: an identity-verified signal
   * (pid + start-time + executable + `HARNESS_SPAWN_ID` nonce) to the child's
   * process GROUP. The owning process observes the child's death through its
   * transport and folds the generation-matched `child.stopped` (that fold —
   * runRole's `finally` / T13 — already exists; this never appends a stop).
   *
   * Call AFTER appending the intent (the CLI does, on an applied `pause`/
   * `cancel`). A generation still LIVE in THIS process is left to the
   * in-process stop path (limit pause, run-owned cancel, dispose ladder) and
   * is NEVER signaled from here. On any §14 identity ambiguity — a recycled
   * pid, a contradicting or unreadable nonce — the signal is WITHHELD and a
   * durable alert raised (never signal a recycled pid).
   *
   * `escalate` (cancel) walks the §10.2 terminate ladder: a graceful SIGTERM
   * to the group, then — if the SAME identity is still alive after the
   * terminate grace — an identity-verified SIGKILL. `pause` delivers a single
   * graceful SIGTERM and never force-kills (the durable pause intent stands
   * regardless).
   */
  async stopExternalChild(
    runId: RunId,
    opts: { readonly escalate: boolean },
  ): Promise<CrossProcessStopOutcome> {
    const child = this.#loadEngineRecord(runId).state.activeChild;
    if (child === undefined) return { delivered: false, reason: 'no_active_child' };
    const generation = child.generationId;
    // In-process children are stopped by the in-process path — never
    // double-signaled from here (limit pause / run-owned cancel unchanged).
    if (this.#liveSpawns.has(generation)) return { delivered: false, reason: 'in_process' };
    if (this.#registry.store.get(generation) === undefined) {
      return { delivered: false, reason: 'no_record' };
    }
    // Graceful terminate first (§10.2): identity-verified SIGTERM to the group.
    const first = this.#registry.signalVerifiedStrict(generation, 'SIGTERM');
    if (first.verdict === 'gone') return { delivered: false, reason: 'already_gone' };
    if (first.verdict !== 'match') {
      return { delivered: false, reason: 'withheld', verdict: first.verdict };
    }
    if (!opts.escalate) return { delivered: true, signal: 'SIGTERM', escalated: false };
    // §10.2 terminate ladder: give the group the terminate grace to exit, then
    // escalate to SIGKILL only if the SAME process is still alive (re-verified
    // — never escalate onto a recycled pid; a raced `gone`/mismatch withholds).
    await this.#crossProcessStopSleep(this.#terminateGraceMs);
    if (this.#registry.verify(generation).verdict !== 'match') {
      return { delivered: true, signal: 'SIGTERM', escalated: false };
    }
    const second = this.#registry.signalVerifiedStrict(generation, 'SIGKILL');
    return { delivered: true, signal: 'SIGKILL', escalated: second.verdict === 'match' };
  }

  /** T15 — `breaker reset`. */
  breakerReset(runId: RunId, opts?: CommandOptions): IngestResult {
    return this.ingest(this.#trigger(runId, 'breaker.reset.requested', {}, opts) as DomainEvent);
  }

  /**
   * T9/T12 — resume from the current suspension (limit, user, or — W2-1 —
   * `interrupted`: the manual re-entry T13/T17 require). W2-5: the
   * transactional resume-ELIGIBILITY check runs first, in the SAME
   * transaction as the trigger append — an open, non-stale assignment whose
   * spec binding chain (checkpoint == assignment == approved == current
   * draft) holds. A mismatch throws the typed `ResumeEligibilityError`
   * WITHOUT clearing the suspension (the transaction rolls back untouched).
   * `mode` labels a T9 driven by the schedule loop's elapsed structured
   * retry_after (`scheduled_probe`) vs a human `resume` (`manual`, default).
   */
  resume(
    runId: RunId,
    opts?: CommandOptions & { readonly mode?: 'manual' | 'scheduled_probe' },
  ): IngestResult {
    return this.#db.transaction(() => {
      const suspension = this.#loadEngineRecord(runId).state.suspension.kind;
      if (suspension === 'none' || suspension === 'breaker_open') {
        throw new WorkflowAdvanceError(`resume: run ${runId} is not paused (suspension=${suspension})`);
      }
      const eligibility = this.checkResumeEligibility(runId);
      if (!eligibility.eligible) {
        throw new ResumeEligibilityError(runId, eligibility.reason, eligibility.detail);
      }
      if (suspension === 'paused_user' || suspension === 'interrupted') {
        return this.ingest(this.#trigger(runId, 'resume.user.requested', {}, opts) as DomainEvent);
      }
      return this.ingest(
        this.#trigger(
          runId,
          'resume.limit.requested',
          { mode: opts?.mode ?? 'manual' },
          opts,
        ) as DomainEvent,
      );
    });
  }

  /**
   * W2-5 (pushback item 8) — the resume-eligibility check evaluated BEFORE
   * every T9/T12/interrupted re-entry (wired into `resume` and the scheduled
   * probe path): the CURRENT role round's assignment must be open and
   * non-stale, and the spec binding chain must hold end to end —
   * `checkpoint.specHash == assignment(round).specHash == engine
   * approvedSpecHash == current draft.specHash`. Rounds with no spec binding
   * (a coordinator drafting BEFORE any spec exists) are vacuously eligible;
   * a checkpoint's documented empty-sentinel hash (no spec at pause time)
   * never counts as a mismatch.
   */
  checkResumeEligibility(runId: RunId): ResumeEligibility {
    const round = this.getRoleRound(runId);
    if (round === undefined) return { eligible: true };

    // Staleness: a T3 supersession marks every open assignment stale
    // (`assignments.marked_stale`); any such event AFTER the round's
    // dispatch watermark means this round's assignment is stale.
    if (round.dispatchedAtSequence !== undefined) {
      const stale = this.#db.events
        .listByRun(runId)
        .find(
          (event) =>
            event.type === 'assignments.marked_stale' &&
            Number(event.sequence) > round.dispatchedAtSequence!,
        );
      if (stale !== undefined) {
        return {
          eligible: false,
          reason: 'assignment_stale',
          detail:
            `the round's assignment was marked stale (spec superseded, event seq ${Number(stale.sequence)}) ` +
            `after the round dispatched (watermark ${round.dispatchedAtSequence})`,
        };
      }
    }

    if (round.specHash === undefined) return { eligible: true };
    const bindingMismatch = (label: string, actual: string): ResumeEligibility => ({
      eligible: false,
      reason: 'spec_binding_mismatch',
      detail:
        `the round is bound to spec hash ${round.specHash} but ${label} is ${actual} — ` +
        'a superseded spec can never resurrect an old round',
    });

    const draft = this.getSpecDraft(runId);
    if (draft !== undefined && String(draft.specHash) !== String(round.specHash)) {
      return bindingMismatch('the current draft.specHash', String(draft.specHash));
    }
    const approved = this.#loadEngineRecord(runId).state.approvedSpecHash;
    if (approved !== undefined && String(approved) !== String(round.specHash)) {
      return bindingMismatch('the engine approvedSpecHash', String(approved));
    }
    if (round.checkpointRef !== undefined) {
      const checkpoint = this.getCheckpointContent(round.checkpointRef);
      if (
        checkpoint !== undefined &&
        String(checkpoint.specHash) !== '' && // documented no-spec sentinel
        String(checkpoint.specHash) !== String(round.specHash)
      ) {
        return bindingMismatch('the checkpoint.specHash', String(checkpoint.specHash));
      }
    }
    return { eligible: true };
  }

  /** Parse a §12.2 checkpoint's content back out of the CAS (W2-5: the
   * resume path is driven from the RoleRoundProjection + this checkpoint). */
  getCheckpointContent(hash: ArtifactHash): CheckpointContent | undefined {
    const bytes = this.#db.artifacts.readBytes(hash);
    if (bytes === undefined) return undefined;
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as CheckpointContent;
  }

  // ---- Role-flow SEAM ------------------------------------------------------
  /**
   * Coordinator drafting sub-flow (§7): dispatch the coordinator round
   * pending/active-split (W2-3 — the run REMAINS at `created` through
   * spawn+pin; `created→specifying` advances only after pins succeed), run
   * the coordinator RoleRunner to produce a spec, then advance
   * `specifying→awaiting_approval` (where human approval — T1 — is
   * required). The runner (the coordinator FLOW) is supplied by the caller.
   * A pin failure leaves the pending round retryable — re-invoking this
   * method retries the same round with no phase ever advanced.
   *
   * `toDraft` (W3-4): the production callers (`start`, the W2-5 re-entry)
   * supply the outcome→`SpecDraftState` mapping so completion routes through
   * `completeCoordinationRound` — draft persisted BEFORE the final advance,
   * both in ONE transaction. Without it (pure-unit runs that never draft)
   * the bare advance is taken, carrying no draft ref — exactly the
   * "no draft exists" shape W1-F3's approve path already accepts.
   */
  async runCoordination<T>(
    runId: RunId,
    runner: RoleRunner<T>,
    toDraft?: (outcome: T) => SpecDraftState,
  ): Promise<T> {
    const meta = this.#requireMeta(runId);
    const result = await this.runRole(runId, runner, meta.coordinator, meta.workspacePath, {
      round: 1,
      advance: { from: 'created', to: 'specifying' },
      completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
      inputs: JSON.stringify({ goal: meta.goal }),
    });
    if (toDraft !== undefined) {
      this.completeCoordinationRound(runId, toDraft(result));
    } else {
      this.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
    }
    return result;
  }

  /**
   * W3-4 — the ONE coordinator round-COMPLETION handler shared by `start`,
   * `spec revise`, and the W2-5 re-entry: persist the (artifact-backed)
   * draft projection FIRST, then take the final `specifying →
   * awaiting_approval` advance with the draft's identity stamped on the
   * advance event — all inside ONE transaction. Ordering + atomicity close
   * the old crash window (advance committed, RETURN, draft saved by the
   * CLI): a crash anywhere in here rolls the WHOLE completion back, leaving
   * the run still `specifying` with the round re-drivable; after commit the
   * run is `awaiting_approval` WITH the draft and with a durable
   * `SpecDraftRef` replay can check the projection against — never an
   * approval-ready run whose draft is silently gone.
   */
  completeCoordinationRound(runId: RunId, draft: SpecDraftState): EngineState {
    return this.#db.transaction(() => {
      this.saveSpecDraft(runId, draft);
      return this.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval', {
        draft: {
          // §7: the CAS artifact hash IS the spec content hash, so the
          // artifact ref is derivable from the draft alone (same identity
          // `draftAsSpecVersion` reconstructs on the revise path).
          artifactHash: artifactHash(String(draft.specHash)),
          specVersionId: draft.specVersionId,
          specHash: draft.specHash,
          revision: draft.revision,
        },
      });
    });
  }

  /**
   * W3-4 — the latest durable coordinator-completion draft ref: the newest
   * `workflow.dispatch.advanced` event into `awaiting_approval` that carries
   * one. `undefined` for runs that never completed a drafting round through
   * `completeCoordinationRound` (pure-unit runs advanced bare). This is the
   * replay-side truth `approve`/`run`/`spec revise` compare the CURRENT
   * `SPEC_DRAFT_PROJECTION` against — projection absent or hash-mismatched
   * ⇒ the draft was lost/corrupted after the completion committed.
   */
  getCoordinatorCompletion(runId: RunId): SpecDraftRef | undefined {
    const events = this.#db.events.listByRun(runId);
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]!;
      if (event.type !== 'workflow.dispatch.advanced') continue;
      const payload = event.payload;
      if (payload.to === 'awaiting_approval' && payload.draft !== undefined) return payload.draft;
    }
    return undefined;
  }

  /**
   * Spawn a role via the adapter factory and drive its turns. Owns the full
   * provider lifecycle: spawn → `child.spawn.initiated` (generation
   * `spawning`, `initial_config_pin` window open) → initialize → (W2-6 §14)
   * capture the process identity into the DURABLE registry + arm the RSS
   * watchdog (budget from the run's pinned config) → create session → pin
   * model/effort (§11.2, classification-precedes-retry W2-3) → pins
   * succeeded: `child.spawned` (generation ACTIVE, pins + echo facts on the
   * log) and, for a dispatched round, the workflow-phase advance + round
   * `active` (pending/active split) → hand the flow a live `RoleSession`
   * (permissions mediated §10.2, usage folded into cost §17.2, every
   * provider-call failure classified FIRST) → dispose (watchers
   * deregistered) → generation-matched `child.stopped`. A §14 heartbeat
   * ticks for the run throughout. The `RoleRunner` supplies only the turn
   * logic.
   *
   * Failure routing (W2-3, all through the profile `classifyError`; only
   * structured + 429 + unknown tiers are active — parsed-tier text patterns
   * stay corpus-gated, PLAN §13): `usage_limit` → `pauseForLimit` (T4 via
   * the in-flight operation); `unknown_provider_error` → `pauseForLimit` as
   * T16 (never the breaker); `auth`/`protocol` → the typed failure path
   * (the raw typed error propagates; no pause, no retry); `crash` → T13
   * (suspension `interrupted`, manual resume). ONLY a non-limit
   * configuration rejection gets W1-F8's single pin retry.
   */
  async runRole<T>(
    runId: RunId,
    runner: RoleRunner<T>,
    spec: RoleModelSpec,
    cwd: string,
    dispatch?: RoleDispatch,
  ): Promise<T> {
    const meta = this.#requireMeta(runId);
    const resolved = resolveRoleModel(spec);
    const mediation = this.#mediation.get(runId) ?? DEFAULT_HEADLESS_MEDIATION;
    const permissions = toPermissionConfig(mediation, runner.role);

    // W2-3: the intended round persists PENDING before any spawn, while the
    // workflow remains at its previous stable phase — a crash or pin failure
    // from here on leaves a retryable pending round, never a stranded phase.
    // The record is built ONCE (with the W2-5 staleness watermark stamped at
    // dispatch time) and re-staged from it, so assignment binding and
    // watermark survive the pending→active→completed re-saves.
    const baseRound =
      dispatch !== undefined ? this.#roundRecord(runId, runner.role, dispatch, spec) : undefined;
    if (baseRound !== undefined) {
      this.#saveRoleRound(runId, { ...baseRound, stage: 'pending' });
    }

    const handle = this.#adapterFactory.create({
      role: runner.role,
      cwd,
      clock: this.#clock,
      permissions,
      resolved,
    });
    const ctx: SpawnContext = {
      runId,
      role: runner.role,
      resolved,
      adapter: handle.adapter,
      handle,
      segmentId: newSegmentId(this.#ids),
      generationId: newProcessGenerationId(this.#ids),
      cwd,
      mediation,
      ...(dispatch !== undefined ? { dispatch } : {}),
    };

    // W3-5 (§14 concurrency): admit this spawn against `maxLiveChildren` or
    // REFUSE (throws before anything durable happens). Enforced BOTH in-process
    // (this service's guard) AND durably across concurrent CLI processes (the
    // shared registry store counts every OTHER process's live children). The
    // slot is released in this method's `finally`, on every exit path.
    this.#admitSpawn(ctx.generationId);

    let completedNormally = false;
    // §14 self-supervision: heartbeat for this run while any spawn is in
    // flight (60s default, refcounted across concurrent spawns).
    this.#beginHeartbeat(runId);
    try {
      // Open the initial_config_pin window: the spawning generation is live
      // in the DURABLE state, so a limit envelope anywhere from initialize
      // through pin enforcement licenses T4 (and T13/T16 name the
      // generation) on live ingest and replay alike.
      this.ingest(
        this.#trigger(runId, 'child.spawn.initiated', {
          generationId: ctx.generationId,
          segmentId: ctx.segmentId,
          role: runner.role,
        }) as DomainEvent,
      );

      let spawned:
        | {
            capabilities: Awaited<ReturnType<HarnessAdapter['initialize']>>;
            session: Awaited<ReturnType<HarnessAdapter['createSession']>>;
            attempted: readonly AppliedConfigOption[];
          }
        | undefined;
      try {
        const capabilities = await handle.adapter.initialize();
        // W2-6 (§14): the OS process exists NOW — capture its identity and
        // persist it in the durable registry BEFORE anything else can
        // commit `child.spawned`; from here a crash leaves a record startup
        // reaping can identity-verify. Also arms the RSS watchdog.
        this.#registerSpawnSupervision(ctx);
        const session = await handle.adapter.createSession({ cwd });
        ctx.acpSessionId = session.acpSessionId;
        if (session.nativeSessionId !== undefined) ctx.nativeSessionId = session.nativeSessionId;
        const advertised = await handle.adapter.listConfigOptions(session.acpSessionId);
        const attempted = await applyRoleModel(handle.adapter, session.acpSessionId, resolved, advertised);
        spawned = { capabilities, session, attempted };
      } catch (error) {
        // Classification precedes everything (W2-3): a limit during the
        // spawn/pin window pauses via T4, unknown pauses via T16, crash
        // interrupts via T13, auth/protocol propagates typed. Always throws.
        await this.#routeProviderFailure(ctx, error, 'initial_config_pin');
      }
      const { capabilities, session } = spawned!;
      const configApplied = await this.#enforceRolePins(ctx, spawned!.attempted);

      // Pins succeeded → the generation goes ACTIVE (child.spawned carries
      // the enforced pins incl. echo facts) — and ONLY NOW the workflow
      // phase advances and the round is marked active (pending/active
      // dispatch split, W2-3).
      this.ingest(
        this.#trigger(runId, 'child.spawned', {
          generationId: ctx.generationId,
          segmentId: ctx.segmentId,
          role: runner.role,
          pins: toChildPinRecords(configApplied),
        }) as DomainEvent,
      );
      if (baseRound !== undefined && dispatch !== undefined) {
        if (dispatch.advance !== undefined) {
          this.advanceWorkflowPhase(runId, dispatch.advance.from, dispatch.advance.to);
        }
        this.#saveRoleRound(runId, {
          ...baseRound,
          stage: 'active',
          generationId: ctx.generationId,
          segmentId: ctx.segmentId,
        });
      }
      // W2-5 (pushback item 4): a round going ACTIVE while a T9/T12 pending
      // re-entry is recorded IS the re-entered round running — ack it with
      // `resume_reentry.completed` so startup/`resume` stop reclaiming it.
      // Folded idempotently; a normal (non-resume) dispatch has no pending
      // re-entry and appends nothing.
      if (this.#loadEngineRecord(runId).state.resumeReentryPending !== undefined) {
        this.ingest(
          this.#trigger(runId, 'resume_reentry.completed', {
            role: runner.role,
            ...(dispatch !== undefined ? { round: dispatch.round } : {}),
          }) as DomainEvent,
        );
      }

      const roleSession = this.#buildRoleSession(
        {
          runId,
          role: runner.role,
          resolved,
          adapter: handle.adapter,
          handle: session,
          capabilities,
          configApplied,
          cwd,
          workspacePath: meta.workspacePath,
        },
        ctx,
      );
      const result = await runner.run(roleSession);
      if (baseRound !== undefined) {
        // Preserve a checkpoint ref a mid-round pause recorded on THIS round
        // (a resumed round completing keeps its §12.2 lineage visible).
        const current = this.getRoleRound(runId);
        this.#saveRoleRound(runId, {
          ...baseRound,
          stage: 'completed',
          generationId: ctx.generationId,
          segmentId: ctx.segmentId,
          ...(current?.checkpointRef !== undefined && current.round === baseRound.round
            ? { checkpointRef: current.checkpointRef }
            : {}),
        });
      }
      completedNormally = true;
      return result;
    } finally {
      let disposedCleanly = true;
      try {
        await handle.dispose();
      } catch {
        // Disposal failure never masks the flow outcome; the §14 registry /
        // startup reaping (W2-6) owns any process left behind.
        disposedCleanly = false;
      }
      // W2-6: every dispose path deregisters its watchers. The registry
      // record is removed only on a CLEAN dispose (the transport ladder
      // awaited the group's exit); a failed dispose leaves it durable for
      // §14 startup reaping — never silently dropped.
      this.#releaseSpawnSupervision(ctx, disposedCleanly);
      // Confirm the stop for any path that did not already do so (normal
      // completion, ModelPinError, typed auth/protocol failures, flow
      // errors, and a pending T11 user pause — whose `paused_user` folds
      // exactly here, on the generation-matched confirmation). The pause
      // spine (`pauseForLimit`) and T13 already marked the generation
      // stopped, so this is a no-op for them.
      this.#confirmChildStopped(runId, ctx, completedNormally ? 'graceful' : 'terminated');
      this.#endHeartbeat(runId);
      // W3-5: free the admitted concurrency slot on EVERY exit path (normal
      // completion, pin failure, flow error, pause/cancel) — both the durable
      // reservation (cross-process cap) and the in-process mirror. The durable
      // registry record's own lifecycle is owned by #releaseSpawnSupervision.
      this.#releaseSpawnReservation(ctx.generationId);
      this.#concurrency.release(ctx.generationId);
    }
  }

  // ---- Coordinator spec draft (durable read-model, cross-process) ----------
  /**
   * Persist the coordinator's proposed spec (§7) as a durable read-model so a
   * later, separate `run` process can reconstruct the implement→verify loop
   * input. W3-4: production coordinator completions write it through
   * `completeCoordinationRound` (draft BEFORE the final advance, one
   * transaction); this method alone is the projection save. Not a §6.3
   * transition — approval still binds the hash through `ingest` (T1).
   */
  saveSpecDraft(runId: RunId, draft: SpecDraftState): void {
    this.#requireMeta(runId); // reject an unknown run (same guard as status)
    this.#db.projections.save(runId, SPEC_DRAFT_PROJECTION, draft);
  }

  /** The persisted coordinator spec draft for a run, if `start` drafted one. */
  getSpecDraft(runId: RunId): SpecDraftState | undefined {
    return this.#db.projections.get<SpecDraftState>(runId, SPEC_DRAFT_PROJECTION)?.state;
  }

  /** The engine config this run was created under (W1-F5), if persisted. */
  getRunConfig(runId: RunId): EngineConfig | undefined {
    return loadRunConfig(this.#db, runId);
  }

  // ---- W2-2 blocked merge-readiness (durable recheck read-model) -----------
  /**
   * Persist the W2-2 blocked-readiness read-model: criteria all verified but
   * ONLY user-actionable §16 blockers remain (`merge.readiness.blocked`
   * recorded; the run REMAINS in `verifying`). Written by the verification
   * driver BEFORE the supporting event, and updated by every `recheck`
   * (`stage:'resolved'` once a recheck ingested T24) — the projection is what
   * a later, separate `harness recheck` process re-probes from.
   */
  saveMergeReadinessBlocked(runId: RunId, state: MergeReadinessBlockedState): void {
    this.#requireMeta(runId); // reject an unknown run (same guard as status)
    this.#db.projections.save(runId, MERGE_READINESS_BLOCKED_PROJECTION, state);
  }

  /** The persisted W2-2 blocked-readiness read-model, if a round recorded one. */
  getMergeReadinessBlocked(runId: RunId): MergeReadinessBlockedState | undefined {
    return this.#db.projections.get<MergeReadinessBlockedState>(runId, MERGE_READINESS_BLOCKED_PROJECTION)
      ?.state;
  }

  // ---- W2-5 implement→verify loop binding (durable resume input) -----------
  /**
   * Persist the loop's durable input binding — assignment, both role model
   * specs, spec hash, base task scope, probe geometry, and (once created)
   * the worktree facts. Written by `runImplementVerifyLoop` at entry and
   * updated at worktree creation/adoption so a later, separate process can
   * re-enter the loop from this projection + the spec draft + the role round
   * (W2-5: resume adopts, never creates).
   */
  saveImplementVerifyLoopState(runId: RunId, state: ImplementVerifyLoopState): void {
    this.#requireMeta(runId); // reject an unknown run (same guard as status)
    this.#db.projections.save(runId, IMPLEMENT_VERIFY_LOOP_PROJECTION, state);
  }

  /** The persisted loop binding, if a `run` invocation recorded one. */
  getImplementVerifyLoopState(runId: RunId): ImplementVerifyLoopState | undefined {
    return this.#db.projections.get<ImplementVerifyLoopState>(runId, IMPLEMENT_VERIFY_LOOP_PROJECTION)
      ?.state;
  }

  // ---- Status --------------------------------------------------------------
  status(runId: RunId): RunStatus {
    const engineRecord = this.#loadEngineRecord(runId);
    const state: EngineState = { ...engineRecord.state, bounds: this.#bounds };
    const costRecord = this.#db.projections.get<CostProjectionState>(runId, COST_PROJECTION);
    const cost = costRecord?.state ?? emptyCostProjection();
    const metaRecord = this.#db.projections.get<RunMeta>(runId, RUN_META_PROJECTION);
    return {
      runId,
      phase: state.phase,
      suspension: state.suspension.kind,
      operation: state.operation.kind,
      uiState: uiStateOf({
        phase: state.phase,
        suspension: state.suspension.kind,
        operation: state.operation.kind,
      }),
      childActive: isLiveChild(state.activeChild),
      ...(state.activeChild !== undefined ? { activeChild: state.activeChild } : {}),
      ...(state.resumeReentryPending !== undefined
        ? { resumeReentryPending: state.resumeReentryPending }
        : {}),
      counters: state.counters,
      ...(state.approvedSpecHash !== undefined ? { approvedSpecHash: state.approvedSpecHash } : {}),
      cost,
      budget: {
        spentUsd: cost.totalCostUsd,
        estimatedSpendUsd: cost.totalEstimatedCostUsd,
        reservationUsd: this.#config.budget.conservativeReservationUsd,
        ...(this.#config.budget.maxBudgetUsd !== undefined
          ? { maxBudgetUsd: this.#config.budget.maxBudgetUsd }
          : {}),
      },
      ...(metaRecord !== undefined
        ? { goal: metaRecord.state.goal, workspacePath: metaRecord.state.workspacePath }
        : {}),
    };
  }

  // ---- Internals -----------------------------------------------------------
  /**
   * §11.2 pin enforcement, reworked for W2-3 (classification precedes
   * retry): every failed pin attempt is CLASSIFIED via the profile
   * `classifyError` FIRST — `usage_limit` pauses via `pauseForLimit` (T4,
   * operation `initial_config_pin`; a limit envelope on a pin attempt is
   * never retried), `unknown_provider_error` pauses as T16, `crash`
   * interrupts via T13, `auth`/`protocol` propagate typed. ONLY a non-limit
   * CONFIGURATION rejection (typed `invalid_argument` /
   * `unsupported_capability`) gets W1-F8's single retry; a second
   * configuration failure throws `ModelPinError` — the spawn fails honestly,
   * `runRole`'s finally disposes, no turn runs, the pending round stays
   * retryable.
   *
   * Echo handling (W1-F8 + W2-0): an `ok:true` result WITHOUT an echo stays
   * accepted (`echoed:false` recorded — some adapters do not echo). An
   * `ok:true` result whose ECHOED effective value CONTRADICTS the requested
   * value is a failed pin (trivially non-limit — there is no envelope to
   * classify) → the same single retry, then `ModelPinError`.
   */
  async #enforceRolePins(
    ctx: SpawnContext,
    attempted: readonly AppliedConfigOption[],
  ): Promise<readonly AppliedConfigOption[]> {
    const sessionId = ctx.acpSessionId;
    if (sessionId === undefined) {
      throw new Error('enforceRolePins: no session — pin enforcement runs after createSession');
    }
    const enforced: AppliedConfigOption[] = [];
    for (const pin of attempted) {
      const echoMismatch =
        pin.ok &&
        pin.echoed === true &&
        pin.effectiveValue !== undefined &&
        pin.effectiveValue !== pin.intent.value;
      if (pin.ok && !echoMismatch) {
        enforced.push(pin);
        continue;
      }
      const firstError = pin.ok
        ? `echoed effective value ${JSON.stringify(pin.effectiveValue)} != requested ${JSON.stringify(pin.intent.value)}`
        : (pin.error ?? 'unknown error');
      if (!pin.ok) {
        // Returns ONLY for a retry-eligible non-limit configuration
        // rejection; every other classification throws (pause/interrupt/
        // typed) — classification precedes the retry.
        await this.#routePinFailure(ctx, pin.rawError ?? new Error(firstError));
      }
      try {
        const result = await ctx.adapter.setConfigOption({
          sessionId,
          optionId: pin.resolvedOptionId,
          value: pin.intent.value,
        });
        if (
          result.echoed &&
          result.effectiveValue !== pin.intent.value
        ) {
          throw new ModelPinError(
            ctx.runId,
            ctx.role,
            pin.intent.purpose,
            pin.resolvedOptionId,
            pin.intent.value,
            firstError,
            `echoed effective value ${JSON.stringify(result.effectiveValue)} != requested ${JSON.stringify(pin.intent.value)}`,
          );
        }
        enforced.push({
          intent: pin.intent,
          resolvedOptionId: pin.resolvedOptionId,
          ok: true,
          effectiveValue: result.effectiveValue,
          echoed: result.echoed,
        });
      } catch (error) {
        if (error instanceof ModelPinError) throw error;
        // The RETRY failed: classify it the same way (a limit envelope on
        // the retry still pauses); only another configuration rejection
        // falls through to the honest typed pin failure.
        await this.#routePinFailure(ctx, error);
        throw new ModelPinError(
          ctx.runId,
          ctx.role,
          pin.intent.purpose,
          pin.resolvedOptionId,
          pin.intent.value,
          firstError,
          describeRawError(error),
        );
      }
    }
    return enforced;
  }

  /**
   * Route a PIN-window provider failure through the profile classifier
   * (W2-3). RETURNS only for a non-limit configuration rejection (the caller
   * performs W1-F8's single retry); throws for everything else:
   * `usage_limit` → `pauseForLimit` T4 (operation `initial_config_pin`);
   * `unknown_provider_error` (non-configuration) → `pauseForLimit` T16;
   * `crash` → T13 interrupt; `auth`/`protocol` → the raw typed error.
   */
  async #routePinFailure(ctx: SpawnContext, raw: unknown): Promise<void> {
    const classification = ctx.adapter.classifyError(raw);
    switch (classification.kind) {
      case 'usage_limit':
        throw await this.#pauseForLimit(ctx, classification, 'initial_config_pin');
      case 'crash':
        throw await this.#interruptOnChildDeath(ctx, raw);
      case 'auth':
      case 'protocol':
        // Typed unwind reaches CLI output → the message must already be
        // redacted (§17.1); shape/kind preserved for upstream checks.
        throw toSinkSafeTypedError(raw);
      case 'unknown_provider_error': {
        if (isConfigurationRejection(raw)) return; // W1-F8 single retry
        throw await this.#pauseForLimit(ctx, classification, 'initial_config_pin');
      }
      default: {
        const exhaustive: never = classification.kind;
        throw new Error(`Unhandled classification kind: ${String(exhaustive)}`);
      }
    }
  }

  /**
   * Route a non-pin provider-call failure (spawn window before pinning, or a
   * prompt turn) through the profile classifier (W2-3). Always throws — the
   * caller's control flow ends here. Only structured + 429 + unknown
   * classifier tiers are active; parsed-tier text patterns remain
   * corpus-gated (PLAN §13 evidence gate — unmet).
   */
  async #routeProviderFailure(
    ctx: SpawnContext,
    raw: unknown,
    operation: PausedOperation,
  ): Promise<never> {
    const classification = ctx.adapter.classifyError(raw);
    switch (classification.kind) {
      case 'usage_limit':
      case 'unknown_provider_error':
        throw await this.#pauseForLimit(ctx, classification, operation);
      case 'crash':
        throw await this.#interruptOnChildDeath(ctx, raw);
      case 'auth':
      case 'protocol': {
        // Typed failure path: no pause, no retry. For a failed prompt turn
        // the operation folds back to idle honestly (`turn.completed`
        // outcome 'failed'); the pin window needs no fold — the spawn is
        // failing and the generation stop is confirmed in runRole's finally.
        if (operation === 'prompt_turn') {
          this.ingest(
            this.#trigger(ctx.runId, 'turn.completed', {
              segmentId: ctx.segmentId,
              generationId: ctx.generationId,
              outcome: 'failed',
            }) as DomainEvent,
          );
        }
        // Typed unwind reaches CLI output → the message must already be
        // redacted (§17.1); shape/kind preserved for upstream checks.
        throw toSinkSafeTypedError(raw);
      }
      default: {
        const exhaustive: never = classification.kind;
        throw new Error(`Unhandled classification kind: ${String(exhaustive)}`);
      }
    }
  }

  /**
   * W2-3: a provider-call failure classified `crash` = the child died →
   * T13 (`child.exited.unexpectedly`, generation-stamped): counters fold,
   * that generation is marked stopped, suspension=`interrupted` — manual
   * resume required, ZERO auto-respawns in P4a. Returns the SINK-SAFE
   * wrapping of the raw error (message redacted §17.1, shape preserved)
   * for the caller to throw (typed unwind reaches CLI output).
   */
  async #interruptOnChildDeath(ctx: SpawnContext, raw: unknown): Promise<unknown> {
    this.ingest(
      this.#trigger(ctx.runId, 'child.exited.unexpectedly', {
        segmentId: ctx.segmentId,
        generationId: ctx.generationId,
        classifiedAs: 'crash',
      }) as DomainEvent,
    );
    return toSinkSafeTypedError(raw);
  }

  // ---- W2-3 pause spine (crash-safe by construction) -----------------------
  /**
   * `pauseForLimit` — the §12.2-conformant pause transaction (W2-3):
   *
   *  1. Write + fsync the mechanical checkpoint artifact to CAS
   *     (`incomplete_operation` honestly set from the in-flight operation).
   *     CRASH here → the artifact is referenced by NO committed event:
   *     invisible to replay, reclaimed by GC (§12.2 already guarantees).
   *  2. ONE atomic append: the T4-family trigger (via the current operation
   *     — `initial_config_pin` or `prompt_turn`) or T16 (`unknown`), plus
   *     the engine-emitted effects (`child.stop.intent` marking the
   *     generation STOPPING, `segment.stop.requested`,
   *     `limit.incident.recorded`, `notify.requested`) plus
   *     `checkpoint.recorded{hash}` — one transaction. CRASH after this
   *     commit → restart replays a run that is durably `paused_limit` with
   *     incident + checkpoint and a committed stop-intent with no matching
   *     `child.stopped`; startup/`resume` performs identity-verified cleanup
   *     (§14) and appends the confirmation via
   *     `confirmStopIntentAfterCleanup` — idempotently.
   *  3. THEN cancel/dispose the child (transport ladder). Failures never
   *     unwind the durable pause (the §14 registry owns any leftover
   *     process). CRASH between dispose and step 4 → same recovery as 2.
   *  4. Append the generation-matched `child.stopped` confirming the stop.
   *     CRASH after → everything is durable; re-delivery folds idempotently.
   *
   * Returns the `LimitPausedError` the caller throws (unwinding runRole).
   */
  async #pauseForLimit(
    ctx: SpawnContext,
    classification: ErrorClassification,
    operation: PausedOperation,
  ): Promise<LimitPausedError> {
    const limit: LimitClassification = {
      kind: classification.kind === 'usage_limit' ? 'usage_limit' : 'unknown_provider_error',
      provider: classification.provider ?? ctx.resolved.harness,
      source: classification.source,
      confidence: classification.confidence,
      detectionTier: classification.detectionTier ?? 'unknown',
      ...(classification.resumesAt !== undefined ? { resumesAt: classification.resumesAt } : {}),
    };
    const transitionId: 'T4' | 'T16' = limit.kind === 'usage_limit' ? 'T4' : 'T16';
    const incidentKind: LimitIncidentKind = limit.kind === 'usage_limit' ? 'usage_limit' : 'unknown';

    // (1) Checkpoint artifact first — fsynced inside the repository write.
    const checkpoint = await this.#writeStopCheckpoint(ctx, 'pre_pause', { kind: operation });

    // (2) The ONE atomic append.
    const type: 'limit.classified.prompt_turn' | 'provider.error.unknown' =
      limit.kind === 'usage_limit' ? 'limit.classified.prompt_turn' : 'provider.error.unknown';
    const trigger = this.#trigger(ctx.runId, type, {
      segmentId: ctx.segmentId,
      classification: limit,
    }) as DomainEvent;
    const record = this.#loadEngineRecord(ctx.runId);
    const currentState: EngineState = { ...record.state, bounds: this.#bounds };
    const outcome = applyTransition(currentState, trigger);
    const projection: ProjectionUpdate<EngineState> = {
      name: ENGINE_STATE_PROJECTION,
      currentState,
      reduceEvent: this.#engineReducer,
    };
    if (outcome.status === 'rejected') {
      appendTriggerWithEffects(this.#db, outcome.rejectionEvent as DomainEvent, [], projection);
      if (currentState.suspension.kind === 'paused_limit') {
        // Double-pause race: an earlier pause already won — the run IS
        // durably paused; this attempt's checkpoint artifact stays
        // unreferenced (GC'd) and the caller still unwinds.
        return new LimitPausedError({
          runId: ctx.runId,
          role: ctx.role,
          transitionId,
          incidentKind,
          operation,
          classification: limit,
        });
      }
      throw new PauseCompositionError(ctx.runId, outcome.detail);
    }
    appendTriggerWithEffects(
      this.#db,
      trigger,
      outcome.emitted,
      projection,
      checkpoint.event !== undefined ? [checkpoint.event as DomainEvent] : [],
    );
    // Record the round's checkpoint ref (W2-5 resume reads it; a crash
    // before this save is fine — the committed `checkpoint.recorded` event
    // is the authoritative link and resume re-derives from the log).
    if (checkpoint.hash !== undefined && ctx.dispatch !== undefined) {
      const current = this.getRoleRound(ctx.runId);
      if (current !== undefined && current.round === ctx.dispatch.round && current.role === ctx.role) {
        this.#saveRoleRound(ctx.runId, { ...current, checkpointRef: checkpoint.hash });
      }
    }

    // (3) Cancel/dispose the child — transport ladder; never unwinds the
    // pause. W2-6: the watchdog stands down first (this IS a dispose path);
    // registry/heartbeat release follows in runRole's finally as the throw
    // unwinds through it.
    this.#watchdog.unwatch(ctx.generationId);
    let stoppedCleanly = true;
    if (operation === 'prompt_turn' && ctx.acpSessionId !== undefined) {
      try {
        await ctx.adapter.cancelTurn({ sessionId: ctx.acpSessionId });
      } catch {
        stoppedCleanly = false;
      }
    }
    try {
      await ctx.handle.dispose();
    } catch {
      stoppedCleanly = false;
    }

    // (4) Generation-matched confirmation.
    this.ingest(
      this.#trigger(ctx.runId, 'child.stopped', {
        generationId: ctx.generationId,
        segmentId: ctx.segmentId,
        reason: stoppedCleanly ? 'graceful' : 'terminated',
      }) as DomainEvent,
    );

    return new LimitPausedError({
      runId: ctx.runId,
      role: ctx.role,
      transitionId,
      incidentKind,
      operation,
      classification: limit,
      ...(checkpoint.hash !== undefined ? { checkpointArtifactHash: checkpoint.hash } : {}),
    });
  }

  /**
   * Step (1) of `pauseForLimit` — and (W2-6) the T22 graceful-stop
   * checkpoint: assemble + write the §12.2 mechanical checkpoint (redact →
   * CAS → fsync happen inside the artifact repository) under the given
   * reason (`pre_pause` | `pre_graceful_stop`), recording the interrupted
   * operation honestly. A §12.1 quota admission rejection is a REAL possible
   * outcome: the repository already appended `artifact.admission.rejected`,
   * and the PAUSE/stop still proceeds — hammering a limited provider (or
   * holding an over-budget process alive) because the checkpoint could not
   * be stored would be strictly worse — just without a `checkpoint.recorded`
   * event (resume then relies on the previous checkpoint / full re-entry
   * validation; W2-5 re-probes everything).
   */
  async #writeStopCheckpoint(
    ctx: SpawnContext,
    reason: CheckpointReason,
    operation: Operation,
  ): Promise<{ readonly event?: EventOfType<'checkpoint.recorded'>; readonly hash?: ArtifactHash }> {
    const state = this.#loadEngineRecord(ctx.runId).state;
    const worktree = await capturePauseWorktreeState(ctx.cwd);
    const occurredAt = this.#clock.nowIso();
    // The bound spec hash: the dispatched round's binding, else the approved
    // hash, else the documented empty sentinel (a coordinator pause BEFORE
    // any spec exists — there is honestly no spec to bind).
    const boundSpecHash = ctx.dispatch?.specHash ?? state.approvedSpecHash ?? specHash('');
    const content = buildCheckpointContent({
      lineage: {
        harnessId: ctx.resolved.harness,
        model: ctx.resolved.model,
        ...(ctx.acpSessionId !== undefined ? { acpSessionId: ctx.acpSessionId } : {}),
        ...(ctx.nativeSessionId !== undefined ? { nativeSessionId: ctx.nativeSessionId } : {}),
      },
      eventCursor: eventSequence(this.#db.events.countByRun(ctx.runId)),
      specHash: boundSpecHash,
      // Honest mid-round state: nothing is established by a pause — every
      // known criterion records `pending` (W2-5's evidence carry-over
      // refines this on the verifier's own completion checkpoints).
      criterionStates: (ctx.dispatch?.criterionIds ?? []).map((id) => ({
        criterionId: id,
        state: 'pending' as const,
      })),
      permissionPolicy: toPermissionPolicy(ctx.mediation),
      worktree: worktree.state,
      unresolvedRisks: worktree.note !== undefined ? [worktree.note] : [],
      // The interrupted operation, recorded honestly (§12.2: never claims
      // completed work). Pause paths always carry a non-idle operation
      // (prompt_turn/initial_config_pin); a T22 graceful stop between turns
      // is legitimately idle → no incomplete_operation, equally honest.
      ...(() => {
        const incomplete = deriveIncompleteOperation(operation, occurredAt);
        return incomplete !== undefined ? { incompleteOperation: incomplete } : {};
      })(),
    });
    const written = await writeCheckpoint(
      { artifacts: this.#db.artifacts, clock: this.#clock, ids: this.#ids },
      {
        runId: ctx.runId,
        segmentId: ctx.segmentId,
        ...(ctx.dispatch?.assignmentId !== undefined ? { assignmentId: ctx.dispatch.assignmentId } : {}),
        reason,
        content,
      },
    );
    if (isErr(written)) return {};
    const ok = unwrap(written);
    return { event: ok.event, hash: ok.checkpoint.artifactHash };
  }

  /**
   * W2-3 restart reconciliation for the pause spine's crash windows: a
   * COMMITTED stop-intent (generation `stopping`) with no matching
   * `child.stopped` means the process died between the atomic append and
   * the confirmation. The caller performs the §14 identity-verified cleanup
   * FIRST (startup reaping — W2-6 wires it; never kill on ambiguity), then
   * calls this to append the generation-matched confirmation. Idempotent:
   * no stopping generation → no-op (`undefined`).
   */
  confirmStopIntentAfterCleanup(runId: RunId, opts?: CommandOptions): IngestResult | undefined {
    const child = this.#loadEngineRecord(runId).state.activeChild;
    if (child === undefined || child.status !== 'stopping') return undefined;
    return this.ingest(
      this.#trigger(
        runId,
        'child.stopped',
        {
          generationId: child.generationId,
          segmentId: child.segmentId,
          reason: 'startup_cleanup',
        },
        opts,
      ) as DomainEvent,
    );
  }

  /** Confirm the stop of THIS spawn's generation unless a pause/T13 path
   * already did (generation-matched; late generations never touched). */
  #confirmChildStopped(runId: RunId, ctx: SpawnContext, reason: ChildStopReason): void {
    const child = this.#loadEngineRecord(runId).state.activeChild;
    if (child === undefined || child.generationId !== ctx.generationId || child.status === 'stopped') {
      return;
    }
    this.ingest(
      this.#trigger(runId, 'child.stopped', {
        generationId: ctx.generationId,
        segmentId: ctx.segmentId,
        reason,
      }) as DomainEvent,
    );
  }

  // ---- W2-4 durable schedule + scheduled resume probes ---------------------
  /**
   * The current resume plan for a `paused_limit` run, computed by the PURE
   * scheduler (../scheduler/limit-schedule.ts) from the durable log, the
   * run's PINNED config (W1-F5), and the injected clock — deadlines are
   * event-anchored, so a restart computes the identical plan. `undefined`
   * when the run is not `paused_limit`.
   */
  getResumePlan(runId: RunId): ResumePlan | undefined {
    const state = this.#loadEngineRecord(runId).state;
    if (state.suspension.kind !== 'paused_limit') return undefined;
    const events = this.#db.events.listByRun(runId);
    const incident = latestIncidentEvent(events);
    if (incident === undefined) return undefined;
    const pinned = loadRunConfig(this.#db, runId) ?? this.#config;
    return computeResumePlan(incident, events, pinned, this.#clock.nowIso());
  }

  /**
   * Execute the schedule's CURRENT step for a `paused_limit` run (W2-4).
   * The wait loop (W2-5) drives this; each call is one honest step:
   *
   *  - plan `resume_now` (elapsed structured retry_after): returned to the
   *    caller for direct re-entry — no probe, no claim consumed;
   *  - plan `probe_at` still in the future: `not_due` (sleep until `at`,
   *    call again — an ETA-anchored wake re-evaluates to `resume_now`);
   *  - plan `probe_at` due: write the FENCED claim
   *    (`limit.probe.claimed`, key `probeClaimKey`; `decideClaim` arbitrates
   *    concurrent waiters and crashed-claimant adoption), run the throwaway
   *    probe session, and append EXACTLY ONE outcome under
   *    `probeOutcomeKey(claim)`:
   *      OK              → T9 `resume.limit.requested {mode:'scheduled_probe'}`
   *      limit envelope  → T10 (probe count folds) + the next
   *                        `limit.probe.scheduled` rung — or the exhaustion
   *                        notify when the per-incident cap is reached
   *      ANY other error → `limit.probe.inconclusive {classifiedKind, detail}`:
   *                        stays paused, automatic probing STOPS, no T10,
   *                        never the breaker; manual `resume` remains;
   *  - plan `ladder_exhausted` (cap or inconclusive): nothing to execute —
   *    permanent for the incident, manual `resume` always available.
   */
  async runScheduledProbe(
    runId: RunId,
    opts?: { readonly adoptAfterMs?: number },
  ): Promise<ScheduledProbeOutcome> {
    const state = this.#loadEngineRecord(runId).state;
    if (state.suspension.kind !== 'paused_limit') {
      return { outcome: 'not_paused', suspension: state.suspension.kind };
    }
    // W2-5 (item 8): eligibility precedes EVERY T9 producer — probing toward
    // a resume the eligibility check would refuse (stale assignment,
    // superseded spec) is refused up front, before any claim is consumed.
    const eligibility = this.checkResumeEligibility(runId);
    if (!eligibility.eligible) {
      throw new ResumeEligibilityError(runId, eligibility.reason, eligibility.detail);
    }
    const events = this.#db.events.listByRun(runId);
    const incident = latestIncidentEvent(events);
    if (incident === undefined) {
      throw new ProbeSchedulingError(
        runId,
        'run is paused_limit but the log has no limit.incident.recorded',
      );
    }
    const pinned = loadRunConfig(this.#db, runId) ?? this.#config;
    const now = this.#clock.nowIso();
    const plan = computeResumePlan(incident, events, pinned, now);
    if (plan.kind === 'resume_now') return { outcome: 'resume_now', plan };
    if (plan.kind === 'ladder_exhausted') return { outcome: 'ladder_exhausted', plan };
    if (Date.parse(plan.at) > Date.parse(now)) return { outcome: 'not_due', plan };

    // Fenced probe claim (pushback item 4): the durable claim commits BEFORE
    // any probing; a deduped insert means another waiter holds (or held) the
    // probe, and the shared outcome key bounds even a crashed-claimant
    // adoption race to ONE logical T9/T10/inconclusive.
    const incidentId = incidentIdOf(incident);
    const claimKey = probeClaimKey(incidentId, plan.probeIndex);
    const outcomeKey = probeOutcomeKey(claimKey);
    const outcomeExists = this.#db.events.getByIdempotencyKey(runId, outcomeKey) !== undefined;
    const locallyInFlight = this.#probeClaimsInFlight.has(String(claimKey));
    const claimed = this.ingest(
      this.#trigger(
        runId,
        'limit.probe.claimed',
        { incidentId, probeIndex: plan.probeIndex },
        { idempotencyKey: claimKey },
      ) as DomainEvent,
    );
    if (claimed.status !== 'recorded') {
      throw new ProbeSchedulingError(runId, `probe claim did not record (status '${claimed.status}')`);
    }
    const decision = decideClaim({
      claimedFresh: !claimed.deduped,
      outcomeExists,
      claimOccurredAt: claimed.event.occurredAt,
      now,
      adoptAfterMs: opts?.adoptAfterMs ?? DEFAULT_PROBE_ADOPT_AFTER_MS,
      locallyInFlight,
    });
    if (decision === 'already_resolved') {
      return { outcome: 'already_resolved', probeIndex: plan.probeIndex };
    }
    if (decision === 'in_flight') return { outcome: 'claim_in_flight', probeIndex: plan.probeIndex };

    this.#probeClaimsInFlight.add(String(claimKey));
    try {
      const probe = await this.#executeProbeSession(runId);
      if (probe.kind === 'ok') {
        const resumed = this.ingest(
          this.#trigger(
            runId,
            'resume.limit.requested',
            { mode: 'scheduled_probe' },
            { idempotencyKey: outcomeKey },
          ) as DomainEvent,
        );
        if (resumed.status === 'applied') return { outcome: 'resumed', probeIndex: plan.probeIndex };
        // T9 rejected (the run is no longer paused_limit — a manual resume
        // won the race) or deduped (this outcome key already resolved the
        // rung): either way the fact is durable; the probe's answer is moot.
        return { outcome: 'already_resolved', probeIndex: plan.probeIndex };
      }
      if (probe.kind === 'still_limited') {
        const t10 = this.ingest(
          this.#trigger(
            runId,
            'limit.probe.still_limited',
            { classification: probe.classification },
            { idempotencyKey: outcomeKey },
          ) as DomainEvent,
        );
        if (t10.status !== 'applied') {
          return { outcome: 'already_resolved', probeIndex: plan.probeIndex };
        }
        // The reducer only FOLDED the probe count (W2-1 item 8); the pure
        // scheduler computes the next deadline from the pinned config and
        // the explicit schedule fact — or the exhaustion notify — lands here.
        const nextPlan = computeResumePlan(
          incident,
          this.#db.events.listByRun(runId),
          pinned,
          this.#clock.nowIso(),
        );
        if (nextPlan.kind === 'probe_at') {
          this.ingest(
            this.#trigger(
              runId,
              'limit.probe.scheduled',
              { at: nextPlan.at, rung: nextPlan.rung, probeIndex: nextPlan.probeIndex },
              { idempotencyKey: probeScheduleKey(incidentId, nextPlan.probeIndex) },
            ) as DomainEvent,
          );
        } else if (nextPlan.kind === 'ladder_exhausted') {
          this.ingest(
            this.#trigger(
              runId,
              'notify.requested',
              {
                topic: 'paused_limit',
                message:
                  `Probe ladder exhausted (${nextPlan.probesUsed}/${nextPlan.maxProbesPerIncident} probes ` +
                  'still limited); the run remains paused — manual resume is always available.',
              },
              { idempotencyKey: deriveIdempotencyKey(outcomeKey, 0, 'notify.requested') },
            ) as DomainEvent,
          );
        }
        return { outcome: 'still_limited', probeIndex: plan.probeIndex, nextPlan };
      }
      this.ingest(
        this.#trigger(
          runId,
          'limit.probe.inconclusive',
          { classifiedKind: probe.classifiedKind, detail: probe.detail, probeIndex: plan.probeIndex },
          { idempotencyKey: outcomeKey },
        ) as DomainEvent,
      );
      return {
        outcome: 'inconclusive',
        probeIndex: plan.probeIndex,
        classifiedKind: probe.classifiedKind,
        detail: probe.detail,
      };
    } finally {
      this.#probeClaimsInFlight.delete(String(claimKey));
    }
  }

  /**
   * The probe itself (W2-4): a fresh THROWAWAY session on the SAME profile,
   * pinned to the SAME model/effort as the role it would resume, one minimal
   * prompt, classify, close — usage folded into cost (§17.2).
   *
   * DELIBERATE DEVIATION from pushback item 3's retain-the-candidate design,
   * with the spec's rationale: under this architecture every work round is a
   * fresh session, so a fresh probe session pinned identically IS equivalent
   * evidence to "the actual successor session"; retaining the candidate
   * would thread a live session through the runRole seam for no additional
   * proof. Item 3's real defects are fixed instead — identical pinning
   * (`RoleRoundProjection.modelSpec`), and the non-limit failure path
   * (`limit.probe.inconclusive`, never T10, never the breaker).
   *
   * Deliberately NO `child.*`/`turn.*` events: the run REMAINS durably
   * paused — the throwaway generation never appears on the engine's state
   * axes. §14 supervision still engages (identity registry, watchdog,
   * heartbeat) so a probe child cannot orphan silently.
   */
  async #executeProbeSession(runId: RunId): Promise<ProbeSessionResult> {
    const meta = this.#requireMeta(runId);
    const round = this.getRoleRound(runId);
    const role: RoleName = round?.role ?? 'coordinator';
    const spec =
      round?.modelSpec ??
      (round === undefined || round.role === 'coordinator' ? meta.coordinator : undefined);
    if (spec === undefined) {
      throw new ProbeSchedulingError(
        runId,
        `paused ${role} round has no recorded modelSpec — cannot pin the probe identically`,
      );
    }
    const resolved = resolveRoleModel(spec);
    const handle = this.#adapterFactory.create({
      role,
      cwd: meta.workspacePath,
      clock: this.#clock,
      // Deny-all headless mediation: a probe never needs tool permissions.
      permissions: toPermissionConfig(DEFAULT_HEADLESS_MEDIATION, role),
      resolved,
    });
    const ctx: SpawnContext = {
      runId,
      role,
      resolved,
      adapter: handle.adapter,
      handle,
      segmentId: newSegmentId(this.#ids),
      generationId: newProcessGenerationId(this.#ids),
      cwd: meta.workspacePath,
      mediation: DEFAULT_HEADLESS_MEDIATION,
    };
    this.#beginHeartbeat(runId);
    try {
      try {
        await handle.adapter.initialize();
        this.#registerSpawnSupervision(ctx);
        const session = await handle.adapter.createSession({ cwd: meta.workspacePath });
        ctx.acpSessionId = session.acpSessionId;
        const advertised = await handle.adapter.listConfigOptions(session.acpSessionId);
        const attempted = await applyRoleModel(handle.adapter, session.acpSessionId, resolved, advertised);
        // Identical pinning IS the probe's evidence: any failed pin fails the
        // probe (classified below) — a probe never takes W1-F8's retry.
        for (const pin of attempted) {
          if (!pin.ok) throw pin.rawError ?? new Error(pin.error ?? 'probe pin failed');
        }
        this.#assertWithinBudget(runId, role);
        const sessionKey = String(session.acpSessionId);
        const result = await handle.adapter.prompt({
          sessionId: session.acpSessionId,
          prompt: PROBE_PROMPT,
          onUpdate: (update) => {
            if (update.kind === 'usage_update') this.#foldUsageUpdate(runId, role, sessionKey, update);
          },
        });
        if (result.usage !== undefined) this.#foldTurnUsage(runId, role, sessionKey, result.usage);
        return { kind: 'ok' };
      } catch (raw) {
        const classification = handle.adapter.classifyError(raw);
        if (classification.kind === 'usage_limit') {
          return {
            kind: 'still_limited',
            classification: {
              kind: 'usage_limit',
              provider: classification.provider ?? resolved.harness,
              source: classification.source,
              confidence: classification.confidence,
              detectionTier: classification.detectionTier ?? 'unknown',
              ...(classification.resumesAt !== undefined
                ? { resumesAt: classification.resumesAt }
                : {}),
            },
          };
        }
        // ANY other failure — auth/protocol/crash/budget/unknown — proves
        // nothing about the limit either way: INCONCLUSIVE, never T10, never
        // the breaker (W2-4 outcome rules).
        return {
          kind: 'inconclusive',
          classifiedKind: classification.kind,
          detail: describeRawError(raw),
        };
      }
    } finally {
      let disposedCleanly = true;
      try {
        await handle.dispose();
      } catch {
        disposedCleanly = false;
      }
      this.#releaseSpawnSupervision(ctx, disposedCleanly);
      this.#endHeartbeat(runId);
    }
  }

  // ---- W2-6 supervision wiring (§14) ---------------------------------------
  /**
   * §14 startup reaping over the DURABLE registry: kill exactly the
   * identity-VERIFIED orphans (ps identity AND — where readable — the
   * `HARNESS_SPAWN_ID` nonce; anything less withholds the signal and
   * surfaces the alert). Then reconcile the pause spine's crash window: a
   * generation that is provably ABSENT (`gone`) or was just reaped
   * (`killed`) satisfies the "§14 identity-verified cleanup" a committed
   * stop-intent waits for, so its run's `child.stopped` confirmation is
   * appended (idempotent). Ambiguous verdicts (mismatch / nonce trouble)
   * confirm NOTHING — the process wearing that pid may still be live.
   * Call at CLI startup (`resume` does) before re-entering any run.
   */
  reapOrphanProcesses(): ReapSummary {
    const store = this.#registry.store;
    // Snapshot before reaping: killed entries are removed from the store by
    // the registry itself, but their run attribution is needed below.
    const recordsByGeneration = new Map(store.list().map((r) => [r.generationId, r] as const));
    const summary = this.#registry.reapOrphans('SIGKILL');
    for (const entry of summary.entries) {
      const record = recordsByGeneration.get(entry.generationId);
      if (record === undefined) continue;
      const provablyStopped = entry.action === 'killed' || entry.verification.verdict === 'gone';
      if (!provablyStopped) continue;
      // A gone process's record is spent bookkeeping — drop it so later
      // reaps stay quiet about it (killed records were already removed).
      if (entry.verification.verdict === 'gone') store.remove(entry.generationId);
      if (record.runId === undefined) continue;
      const child = this.#db.projections.get<EngineState>(record.runId, ENGINE_STATE_PROJECTION)?.state
        .activeChild;
      if (child?.status === 'stopping' && child.generationId === entry.generationId) {
        this.confirmStopIntentAfterCleanup(record.runId);
      }
    }
    return summary;
  }

  /**
   * W3-5(a) (§14 concurrency): count live slots and reserve one — or REFUSE
   * with `MaxLiveChildrenExceededError` — ATOMICALLY across concurrent CLI
   * processes. `maxLiveChildren` is a GLOBAL cap: the count-and-reserve runs
   * inside ONE `BEGIN IMMEDIATE` transaction so a second process's admission
   * blocks on the write lock until this one commits, then observes this
   * process's reservation. This closes the TOCTOU where two processes, each
   * having NOT YET written a durable child record, both saw zero and both
   * admitted (durable = N+1). The durable reservation (written HERE, before the
   * spawn) is the slot record; the registry's `child.spawned` identity record
   * lands later and is folded into the same tally by generation to avoid
   * double counting.
   *
   * Crashed peers never hold capacity hostage (§14): a reservation whose owner
   * pid is gone/recycled — or a registry record whose child pid is not
   * identity-alive — is not counted and is reclaimed, so no deadlock.
   *
   * Called BEFORE any spawn; the slot is released in `runRole`'s `finally`.
   * Throwing here leaves nothing durable to unwind (the reservation is rolled
   * back with the transaction; the pending round stays retryable).
   */
  #admitSpawn(generationId: ProcessGenerationId): void {
    const max = this.#config.maxLiveChildren;
    this.#db.transactionImmediate(() => {
      // Distinct occupied slots by generation, unioned across durable
      // reservations (written at admit) and registry identity records
      // (written at child.spawned) so a generation that has both counts once.
      const occupied = new Set<string>();
      const deadReservations: string[] = [];
      for (const reservation of this.#reservations.list()) {
        if (reservation.generationId === String(generationId)) continue; // idempotent self
        if (this.#reservationOwnerLive(reservation)) occupied.add(reservation.generationId);
        else deadReservations.push(reservation.generationId); // crashed owner → reclaim
      }
      for (const record of this.#registry.store.list()) {
        if (String(record.generationId) === String(generationId)) continue;
        if (occupied.has(String(record.generationId))) continue;
        if (this.#ps.isAlive(record.pid)) occupied.add(String(record.generationId));
      }
      const live = occupied.size;
      if (live >= max) {
        // Rolls back the whole transaction (no reservation, no prune) — dead
        // reservations were never counted, so refusing without pruning them
        // cannot deadlock; the next admission reclaims them.
        throw new MaxLiveChildrenExceededError(max, live + 1);
      }
      this.#reservations.reserveWithin(this.#selfReservation(generationId), deadReservations);
    });
    // In-process mirror (never the gate now — the durable reservation above is
    // authoritative): keeps same-process bookkeeping consistent and idempotent.
    this.#concurrency.acquire(generationId);
  }

  /** Release this process's durable reservation for a generation (runRole
   * `finally`). Best-effort: a failure here must never mask the flow outcome —
   * a stranded reservation from this LIVE process still counts (correctly) and
   * is reclaimed if the process later dies (§14 owner-liveness). */
  #releaseSpawnReservation(generationId: ProcessGenerationId): void {
    try {
      this.#reservations.release(generationId);
    } catch {
      // swallow — see doc comment
    }
  }

  /** This process's reservation record for `generationId` (§14 owner identity). */
  #selfReservation(generationId: ProcessGenerationId): SpawnReservationRecord {
    const startedAt = this.#ps.sampleIdentity(this.#selfPid)?.startedAt;
    return {
      generationId: String(generationId),
      ownerPid: this.#selfPid,
      ...(startedAt !== undefined ? { ownerStartedAt: startedAt } : {}),
      reservedAt: this.#clock.nowIso(),
    };
  }

  /**
   * §14 liveness of a reservation's OWNER (the orchestrator process, not a
   * child): OUR OWN reservations are always live (we are running); another
   * process's reservation is live only while its pid resolves to the SAME
   * start-time (a gone pid, or one recycled by an unrelated process, is a
   * crashed holder whose slot is reclaimable).
   */
  #reservationOwnerLive(reservation: SpawnReservationRecord): boolean {
    if (reservation.ownerPid === this.#selfPid) return true;
    if (!this.#ps.isAlive(reservation.ownerPid)) return false;
    if (reservation.ownerStartedAt === undefined) return true;
    const sample = this.#ps.sampleIdentity(reservation.ownerPid);
    return sample !== undefined && sample.startedAt === reservation.ownerStartedAt;
  }

  /** Capture + persist the §14 identity (durable registry, BEFORE
   * `child.spawned` commits) and arm the RSS watchdog for this generation.
   * A handle with no identity to expose supervises nothing — honestly. A
   * capture/registration FAILURE (a `ps` infra error) is counted, never
   * thrown: it must not enter the provider-failure classification path and
   * kill an otherwise healthy spawn. */
  #registerSpawnSupervision(ctx: SpawnContext): void {
    let identity: ProcessIdentity | undefined;
    try {
      identity = ctx.handle.captureProcessIdentity?.(ctx.generationId);
    } catch {
      this.#supervisionIngestErrors += 1;
      return;
    }
    if (identity === undefined) return;
    ctx.identity = identity;
    this.#registry.registerCaptured(identity, {
      runId: ctx.runId,
      segmentId: ctx.segmentId,
      ...(ctx.dispatch?.assignmentId !== undefined
        ? { assignmentId: ctx.dispatch.assignmentId }
        : {}),
    });
    this.#liveSpawns.set(ctx.generationId, ctx);
    this.#watchdog.watch({
      runId: ctx.runId,
      generationId: ctx.generationId,
      pgid: identity.pgid,
      segmentId: ctx.segmentId,
      ...(ctx.dispatch?.assignmentId !== undefined
        ? { assignmentId: ctx.dispatch.assignmentId }
        : {}),
      // §14/W1-F5: the RSS budget comes from the run's PINNED config, not
      // whatever this process happens to be configured with.
      budgetBytes: this.#runMemoryBudgetBytes(ctx.runId),
    });
  }

  /** W2-6: stop watchers on EVERY dispose path. The durable identity record
   * is removed only when the dispose ladder confirmed the group's exit —
   * otherwise it stays for §14 startup reaping. */
  #releaseSpawnSupervision(ctx: SpawnContext, disposedCleanly: boolean): void {
    this.#watchdog.unwatch(ctx.generationId);
    this.#liveSpawns.delete(ctx.generationId);
    if (ctx.identity !== undefined && disposedCleanly) {
      this.#registry.store.remove(ctx.generationId);
    }
  }

  /** The run-pinned RSS budget (§14 default 1024MB), in bytes. */
  #runMemoryBudgetBytes(runId: RunId): number {
    const pinned = loadRunConfig(this.#db, runId) ?? this.#config;
    return pinned.memory.budgetMb * BYTES_PER_MB;
  }

  /**
   * T22 graceful path (§14: "graceful checkpoint+stop by deadline"): invoked
   * once by the watchdog when a generation first crosses 100% of its RSS
   * budget, right after it emitted `rss.hard_limit{escalation:'graceful'}`
   * (whose T22 fold emits the `checkpoint.requested` +
   * `segment.stop.requested` directives this method executes). Writes the
   * mechanical checkpoint FIRST (§12.2: artifact fsync, then the
   * `checkpoint.recorded` fact), then drives the transport stop ladder
   * (cancel the in-flight turn, dispose the child). If the tree is still
   * alive at the watchdog's deadline, the watchdog escalates to the
   * emergency kill (identity-verified SIGKILL → worktree TAINT via the
   * attached manager). The child's death then reaches T13 through the SAME
   * provider-failure classification path every child death takes — the
   * watchdog never ingests T13 itself (one producer, no double-fold races).
   */
  async #onWatchdogGracefulStop(generationId: ProcessGenerationId): Promise<void> {
    const ctx = this.#liveSpawns.get(generationId);
    if (ctx === undefined) return;
    try {
      const state = this.#loadEngineRecord(ctx.runId).state;
      const checkpoint = await this.#writeStopCheckpoint(ctx, 'pre_graceful_stop', state.operation);
      if (checkpoint.event !== undefined) this.ingest(checkpoint.event as DomainEvent);
    } catch {
      // A failed checkpoint never blocks the stop — RSS pressure is the
      // emergency here; resume revalidates everything (§16.3) regardless.
      this.#supervisionIngestErrors += 1;
    }
    // Stop ladder. Deliberately bounded (cancel grace + terminate ladder),
    // and watchers are released before the dispose like every other path.
    this.#watchdog.unwatch(ctx.generationId);
    if (ctx.acpSessionId !== undefined) {
      try {
        await ctx.adapter.cancelTurn({ sessionId: ctx.acpSessionId });
      } catch {
        // Cancel failing is fine — dispose escalates.
      }
    }
    try {
      await ctx.handle.dispose();
    } catch {
      // The registry record stays; §14 reaping owns any survivor.
    }
  }

  /** §14 "ambiguity → never kill, surface an alert": persist the alert as a
   * durable `process.identity.alert` event on the owning run (when known)
   * and forward to the optional supervision callback. Never throws. */
  #recordIdentityAlert(alert: IdentityAlert): void {
    try {
      this.#onIdentityAlert?.(alert);
    } catch {
      this.#supervisionIngestErrors += 1;
    }
    if (alert.record.runId === undefined) return;
    const verdict = alert.verification.verdict;
    if (verdict === 'match') return; // alerts are only ever raised for non-matches
    try {
      this.ingest(
        this.#trigger(alert.record.runId, 'process.identity.alert', {
          generationId: alert.record.generationId,
          attemptedAction: alert.attemptedAction,
          verdict,
          ...(alert.record.segmentId !== undefined ? { segmentId: alert.record.segmentId } : {}),
          ...(alert.attemptedSignal !== undefined ? { attemptedSignal: alert.attemptedSignal } : {}),
          ...('reason' in alert.verification ? { reason: alert.verification.reason } : {}),
        }) as DomainEvent,
      );
    } catch {
      this.#supervisionIngestErrors += 1;
    }
  }

  /** Supervisor-originated events (watchdog T21/T22, heartbeat) ingest
   * through the SAME single transition path as everything else — but from
   * timer context, where a throw would crash the sampling loop; failures
   * are counted, never thrown. */
  #ingestFromSupervisor(event: DomainEvent): void {
    try {
      this.ingest(event);
    } catch {
      this.#supervisionIngestErrors += 1;
    }
  }

  #beginHeartbeat(runId: RunId): void {
    this.#activeSpawnRuns.set(runId, (this.#activeSpawnRuns.get(runId) ?? 0) + 1);
    if (this.#heartbeatHandle === undefined) {
      this.#heartbeatHandle = startHeartbeat(
        this.#heartbeat,
        () => [...this.#activeSpawnRuns.keys()],
        this.#heartbeatIntervalMs,
      );
    }
  }

  #endHeartbeat(runId: RunId): void {
    const count = this.#activeSpawnRuns.get(runId) ?? 0;
    if (count <= 1) this.#activeSpawnRuns.delete(runId);
    else this.#activeSpawnRuns.set(runId, count - 1);
    if (this.#activeSpawnRuns.size === 0 && this.#heartbeatHandle !== undefined) {
      this.#heartbeatHandle.stop();
      this.#heartbeatHandle = undefined;
    }
  }

  // ---- W2-3 role-round projection (pending/active dispatch split) ----------
  /** Build the round's base record at DISPATCH time (stage stamped by the
   * caller): the W2-5-complete shape incl. the assignment binding and the
   * staleness watermark — the last event-log sequence already assigned when
   * the round dispatched (an `assignments.marked_stale` after it means the
   * round's assignment is stale; `checkResumeEligibility` refuses). */
  #roundRecord(
    runId: RunId,
    role: RoleName,
    dispatch: RoleDispatch,
    spec: RoleModelSpec,
  ): RoleRoundProjection {
    return {
      round: dispatch.round,
      role,
      stage: 'pending',
      // W2-4: the round's spec is durable so a scheduled resume probe can pin
      // a throwaway session to EXACTLY the model/effort the round would
      // resume under — never whatever the probing process happens to default.
      modelSpec: spec,
      dispatchedAtSequence: this.#db.events.countByRun(runId),
      ...(dispatch.inputs !== undefined ? { inputs: dispatch.inputs } : {}),
      ...(dispatch.specHash !== undefined ? { specHash: dispatch.specHash } : {}),
      ...(dispatch.baseCommit !== undefined ? { baseCommit: dispatch.baseCommit } : {}),
      ...(dispatch.implementationCommit !== undefined
        ? { implementationCommit: dispatch.implementationCommit }
        : {}),
      ...(dispatch.completionAdvance !== undefined
        ? { intendedCompletionAdvance: dispatch.completionAdvance }
        : {}),
      ...(dispatch.assignmentId !== undefined ? { assignmentId: dispatch.assignmentId } : {}),
    };
  }

  #saveRoleRound(runId: RunId, round: RoleRoundProjection): void {
    this.#db.projections.save(runId, ROLE_ROUND_PROJECTION, round);
  }

  /** The current role round (W2-3), if a dispatch persisted one. */
  getRoleRound(runId: RunId): RoleRoundProjection | undefined {
    return this.#db.projections.get<RoleRoundProjection>(runId, ROLE_ROUND_PROJECTION)?.state;
  }

  #buildRoleSession(args: RoleSessionArgs, ctx: SpawnContext): RoleSession {
    const { runId, role, resolved, adapter, handle, capabilities, configApplied, cwd, workspacePath } = args;
    const sessionKey = String(handle.acpSessionId);
    return {
      runId,
      role,
      model: resolved,
      configApplied,
      capabilities,
      handle,
      workspacePath,
      cwd,
      prompt: async (input) => {
        this.#assertWithinBudget(runId, role);
        // W2-3: the prompt_turn operation is DURABLE state — `turn.started`
        // folds it so a mid-turn limit envelope licenses T4 on live ingest
        // and replay alike; the pause rows fold it back to idle themselves.
        this.ingest(
          this.#trigger(runId, 'turn.started', {
            segmentId: ctx.segmentId,
            generationId: ctx.generationId,
          }) as DomainEvent,
        );
        const wrapped = (update: SessionUpdate): void => {
          if (update.kind === 'usage_update') this.#foldUsageUpdate(runId, role, sessionKey, update);
          input.onUpdate?.(update);
        };
        let result;
        try {
          result = await adapter.prompt({
            sessionId: handle.acpSessionId,
            prompt: input.prompt,
            onUpdate: wrapped,
          });
        } catch (error) {
          // Classification precedes everything (W2-3): limit → pauseForLimit
          // (T4), unknown → T16, crash → T13, auth/protocol → typed. Throws.
          await this.#routeProviderFailure(ctx, error, 'prompt_turn');
          throw error; // unreachable — routeProviderFailure never returns
        }
        this.ingest(
          this.#trigger(runId, 'turn.completed', {
            segmentId: ctx.segmentId,
            generationId: ctx.generationId,
            outcome: 'completed',
          }) as DomainEvent,
        );
        if (result.usage !== undefined) this.#foldTurnUsage(runId, role, sessionKey, result.usage);
        return result;
      },
    };
  }

  #foldUsageUpdate(
    runId: RunId,
    role: RoleName,
    sessionKey: string,
    update: Extract<SessionUpdate, { kind: 'usage_update' }>,
  ): void {
    const phase = this.#loadEngineRecord(runId).state.phase;
    const record = this.#db.projections.get<CostProjectionState>(runId, COST_PROJECTION);
    const next = foldUsageUpdate(record?.state ?? emptyCostProjection(), {
      role,
      phase,
      sessionKey,
      usedTokens: update.usedTokens,
      contextWindowSize: update.contextWindowSize,
      ...(update.cost !== undefined ? { cost: update.cost } : {}),
    });
    this.#db.projections.save(runId, COST_PROJECTION, next);
  }

  #foldTurnUsage(runId: RunId, role: RoleName, sessionKey: string, usage: TurnUsage): void {
    const phase = this.#loadEngineRecord(runId).state.phase;
    const record = this.#db.projections.get<CostProjectionState>(runId, COST_PROJECTION);
    // §17.2 D-2: hand the fold the conservative reservation so a token-bearing
    // turn with no measured price (subscription billing) is counted as an
    // honest estimate rather than $0.00.
    const next = foldTurnUsage(record?.state ?? emptyCostProjection(), {
      role,
      phase,
      sessionKey,
      usage,
      reservationUsd: this.#config.budget.conservativeReservationUsd,
    });
    this.#db.projections.save(runId, COST_PROJECTION, next);
  }

  /** §17.2 pre-turn estimated-budget refusal (measured + estimated spend +
   * reservation, W1-F5): append `budget.exceeded` + throw. */
  #assertWithinBudget(runId: RunId, role: RoleName): void {
    const max = this.#config.budget.maxBudgetUsd;
    if (max === undefined) return;
    const record = this.#db.projections.get<CostProjectionState>(runId, COST_PROJECTION);
    const state = record?.state ?? emptyCostProjection();
    const reservation = this.#config.budget.conservativeReservationUsd;
    if (!wouldExceedBudget(state, reservation, max)) return;
    this.#db.events.append(
      this.#trigger(runId, 'budget.exceeded', {
        spentUsd: state.totalCostUsd,
        estimatedUsd: state.totalEstimatedCostUsd,
        reservationUsd: reservation,
        budgetUsd: max,
        role,
      }) as DomainEvent,
    );
    throw new BudgetExceededError(
      runId,
      role,
      state.totalCostUsd,
      state.totalEstimatedCostUsd,
      reservation,
      max,
    );
  }

  #trigger<T extends DomainEventType>(
    runId: RunId,
    type: T,
    payload: EventPayloads[T],
    opts?: CommandOptions,
  ): EventOfType<T> {
    return draftEvent({
      type,
      runId,
      payload,
      idempotencyKey: opts?.idempotencyKey ?? newIdempotencyKey(this.#ids),
      occurredAt: opts?.occurredAt ?? this.#clock.nowIso(),
    });
  }

  #loadEngineRecord(runId: RunId): ProjectionRecord<EngineState> {
    const record = this.#db.projections.get<EngineState>(runId, ENGINE_STATE_PROJECTION);
    if (record === undefined) throw new RunNotFoundError(runId);
    return record;
  }

  #requireMeta(runId: RunId): RunMeta {
    const record = this.#db.projections.get<RunMeta>(runId, RUN_META_PROJECTION);
    if (record === undefined) throw new RunNotFoundError(runId);
    return record.state;
  }
}

// ---------------------------------------------------------------------------
// Run-config durability (W1-F5) — load side of the createRun persist
// ---------------------------------------------------------------------------
/**
 * The `EngineConfig` a run was created under (`RUN_CONFIG_PROJECTION`,
 * persisted by `createRun`), re-validated through the schema on the way out so
 * a corrupt/hand-edited projection fails LOUDLY instead of silently running
 * the run under wrong bounds/budget/quotas. Standalone (not only a service
 * method) on purpose: the CLI must load this BEFORE constructing the
 * `OrchestrationService` — the service binds bounds/budget from its config at
 * construction, and quotas are constructor-bound in the artifact repository.
 * `undefined` = no persisted config (a run created before config durability);
 * callers fall back to defaults with a warning.
 */
export function loadRunConfig(db: Database, runId: RunId): EngineConfig | undefined {
  const record = db.projections.get<unknown>(runId, RUN_CONFIG_PROJECTION);
  if (record === undefined) return undefined;
  const parsed = parseEngineConfig(record.state);
  if (isErr(parsed)) {
    throw new Error(
      `Run ${runId}: persisted engine config is invalid — ${parsed.error
        .map((issue) => `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`)
        .join('; ')}`,
    );
  }
  return parsed.value;
}

// ---------------------------------------------------------------------------
// Permission mediation mapping (run-level config → adapter config, with role)
// ---------------------------------------------------------------------------
/**
 * Map the run's `PermissionMediation` onto the adapter's
 * `PermissionMediationConfig`, attaching the role so the §10.2
 * coordinator/verifier write-veto engages. Interactive forwards the callback;
 * headless carries the exact-operation allowlist (omitted = deny everything).
 */
export function toPermissionConfig(
  mediation: PermissionMediation,
  role: RoleName,
): PermissionMediationConfig {
  if (mediation.mode === 'interactive') {
    return { mode: 'interactive', role, handler: mediation.onRequest };
  }
  return {
    mode: 'headless',
    role,
    ...(mediation.allow !== undefined ? { policy: { allow: mediation.allow } } : {}),
  };
}

/** The §12.2 checkpoint's `permissionPolicy` view of the run mediation. */
function toPermissionPolicy(mediation: PermissionMediation): PermissionPolicy {
  return mediation.mode === 'interactive'
    ? { mode: 'interactive', allowlist: [] }
    : { mode: 'headless', allowlist: mediation.allow !== undefined ? [...mediation.allow] : [] };
}

/**
 * W2-3: the §12.2 "exact worktree state" snapshot for a PAUSE checkpoint,
 * probed from the role's cwd with real git. When the cwd is not a usable git
 * tree (read-only coordinator workspace in unit tests, non-repo cwd) the
 * snapshot records empty SENTINELS and the reason travels as an
 * `unresolvedRisks` note — never a fabricated clean state passed off as
 * probed. §16.3/W2-5 re-validate and RE-PROBE on every resume regardless;
 * this snapshot is successor context, not a cleanliness proof.
 */
async function capturePauseWorktreeState(
  cwd: string,
): Promise<{ readonly state: WorktreeState; readonly note?: string }> {
  try {
    const [head, status] = await Promise.all([git.resolveSha(cwd, 'HEAD'), git.statusPorcelain(cwd)]);
    const diff = await git.diffText(cwd, 'HEAD');
    return {
      state: {
        headSha: gitSha(head),
        statusPorcelain: status,
        diffHash: artifactHash(sha256Hex(diff)),
        lockfileCleanupPerformed: false,
        taintFlags: [],
      },
    };
  } catch (error) {
    return {
      state: {
        headSha: gitSha(''),
        statusPorcelain: '',
        diffHash: artifactHash(sha256Hex('')),
        lockfileCleanupPerformed: false,
        taintFlags: [],
      },
      note:
        // §17.1 REDACT BEFORE TRUNCATE: the bound is applied to the REDACTED
        // message, so the slice may cut a `[REDACTED:...]` marker but can
        // never un-terminate a quote before redaction has seen the full text.
        `worktree state not probed at pause (${redactText(error instanceof Error ? error.message : String(error)).slice(0, 200)}); ` +
        '§16.3 validation re-probes before any resume',
    };
  }
}
