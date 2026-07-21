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
  alertId,
  artifactHash,
  eventSequence,
  gitSha,
  idempotencyKey,
  newIdempotencyKey,
  newProcessGenerationId,
  newRunId,
  newSegmentId,
  specHash,
  type AcpSessionId,
  type AlertId,
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
  buildAlertStatusEntries,
  deriveAlertRaisedEvents,
  deriveUnackedAlertDeliveries,
  alertDeliveredIdempotencyKey,
  type AlertRaisedContext,
  type AlertStatusEntry,
} from '../domain/alerts.js';
import { defaultNotifierRegistry, NotifierRegistry, type Notifier } from './alerts.js';
import {
  applyTransition,
  initialEngineState,
  transitionForEvent,
  type EngineState,
  type RejectionReason,
  type TransitionId,
  type TransitionOutcome,
} from '../domain/transitions.js';
import {
  isLiveChild,
  OPERATION_IDLE,
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
  type SuccessorIntent,
  type SuccessorIntentSeed,
  type SuccessorReason,
  type SuccessorTarget,
  type SuspensionKind,
} from '../domain/state.js';
import type {
  CheckpointContent,
  PermissionPolicy,
  TurnUsage,
  WorktreeState,
} from '../domain/entities.js';
import { DEFAULT_ENGINE_CONFIG, parseEngineConfig, toEngineBounds } from '../config/loader.js';
import type { AutoRespawnMode, EngineConfig } from '../config/schema.js';
import { isErr, unwrap } from '../lib/result.js';
import {
  appendTriggerWithEffects,
  registerRun,
  type AppendWithProjectionResult,
  type Database,
  type ProjectionRecord,
} from '../persistence/index.js';
import {
  AdapterError,
  createClaudeProviderAdapter,
  createCodexAcpAdapter,
  createGrokBuildAcpAdapter,
  createOpenCodeAcpAdapter,
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
import { CadenceTracker } from '../checkpoint/cadence.js';
import { redactFlattenedJson, redactText } from '../redaction/index.js';
import { sha256Hex } from '../artifacts/hash.js';
import * as git from '../worktree/git.js';
import { isWorktreeError } from '../worktree/errors.js';
import {
  HeartbeatEmitter,
  DEFAULT_BREAKER_BOUNDS,
  MaxLiveChildrenGuard,
  MaxLiveChildrenExceededError,
  ProcessRegistry,
  RestartBreaker,
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
  DurableRunOwnershipStore,
  RunOwnershipConflictError,
  type RunOwnershipRecord,
} from './run-ownership-store.js';
import {
  applyRoleModel,
  asHarness,
  resolveRoleModel,
  type AppliedConfigOption,
  type ConfigOptionPurpose,
  type Harness,
  type ReasoningEffort,
  type ResolvedRoleModel,
  type RoleModelSpec,
} from './model-resolution.js';
import { DurableDesiredModelStore } from './desired-model-store.js';
import { DurableFailoverStore } from './failover-store.js';
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
 * P4b wave 2 FAILOVER (§5cc/§5ee) — the decision the lease-holding owner makes
 * AFTER `#pauseForLimit` has atomically landed `paused_limit` + checkpoint +
 * incident. `driveFailoverOnLimit` returns it so the loop knows whether to
 * re-drive the (already-seeded) successor or leave the run paused.
 *
 *  - `failover`: the spine was self-driven to `target` (the next ladder rung);
 *    the loop re-dispatches the SAME round + assignmentId on the new target.
 *  - `exhausted`: the ladder ran out (or `maxFailoversPerIncident` was hit, or
 *    no rung narrows to a live harness) — T25 `failover.no_live_target` kept the
 *    run `paused_limit` and raised the `failover` alert (DEGRADE TO WAIT, never a
 *    silent drop). The loop unwinds; the run waits for a probe / manual resume.
 *  - `wait`: the policy is `wait`/`ask` (unchanged pause+wait behaviour).
 */
export type FailoverDecision =
  | { readonly kind: 'failover'; readonly target: SuccessorTarget; readonly from: SuccessorTarget }
  | { readonly kind: 'exhausted'; readonly position: number }
  | { readonly kind: 'wait' };

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

/**
 * P4b-2 (§5cc) — a control-flow SIGNAL (not a failure): a crashed child's
 * generation-matched T13 was `restart`-advised, `restarts.autoRespawn` is
 * `bounded`, and the lease-holding loop opted in — so instead of unwinding to a
 * manual interrupt, `#interruptOnChildDeath` returns this so the call site can
 * hand control back to `runImplementVerifyLoop`, which waits `backoffMs` and
 * re-drives the successor spine (same-harness/same-model in wave 1). The T13 is
 * ALREADY durably applied (suspension=`interrupted`, generation stopped, the
 * restart window grown) before this is raised — the breaker bounds the loop, and
 * an exhausting crash opens the breaker (T14) instead of raising this signal.
 * Caught ONLY by the loop; anywhere else it surfaces as an ordinary error.
 */
export class AutoRespawnSignal extends Error {
  override readonly name: string = 'AutoRespawnSignal';
  readonly runId: RunId;
  /** The breaker's in-sequence attempt count for this crash (1-based). */
  readonly attempt: number;
  /** Real-time delay before the loop re-drives (exponential backoff, breaker). */
  readonly backoffMs: number;
  /** The crashed generation whose T13 licensed this respawn. */
  readonly generationId: ProcessGenerationId;
  constructor(input: {
    runId: RunId;
    attempt: number;
    backoffMs: number;
    generationId: ProcessGenerationId;
  }) {
    super(
      `auto-respawn (bounded) requested for run ${input.runId} after a child crash ` +
        `(attempt ${input.attempt}, backoff ${input.backoffMs}ms)`,
    );
    this.runId = input.runId;
    this.attempt = input.attempt;
    this.backoffMs = input.backoffMs;
    this.generationId = input.generationId;
  }
}

/**
 * P4b-2: the disposition `#interruptOnChildDeath` hands its call sites — either
 * unwind with a sink-safe error (the manual/P4a path) OR hand a control signal
 * back to the loop for a bounded auto-respawn.
 */
type CrashDisposition =
  | { readonly kind: 'throw'; readonly error: unknown }
  | { readonly kind: 'respawn'; readonly signal: AutoRespawnSignal };

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

/**
 * F1/F3 (§review dogfood) — a role generation crossed its RSS budget and was
 * terminated by the watchdog (graceful cancel → `stopReason:'cancelled'`, or an
 * emergency SIGKILL mid-turn). Thrown at the generic `RoleSession.prompt` /
 * provider-failure seam so the role flow ABORTS: the turn is closed
 * `resource_exhausted` (no cadence, no round completion) and the run enters the
 * distinct `resource_exhausted` suspension — never counted as a completed turn,
 * never a T13 crash (which would auto-respawn at the SAME budget). The run stays
 * suspended until an audited per-run budget raise (F3), then a manual resume.
 */
export class ResourceExhaustedError extends Error {
  override readonly name: string = 'ResourceExhaustedError';
  readonly runId: RunId;
  readonly role: RoleName;
  readonly rssBytes: number;
  readonly budgetBytes: number;
  constructor(runId: RunId, role: RoleName, rssBytes: number, budgetBytes: number) {
    super(
      `Run ${runId} resource-exhausted (${role}): RSS ${rssBytes} bytes crossed the ` +
        `${budgetBytes}-byte budget; the generation was terminated. Raise the role's memory ` +
        `budget (audited) before resuming — the run will re-cross the same ceiling otherwise.`,
    );
    this.runId = runId;
    this.role = role;
    this.rssBytes = rssBytes;
    this.budgetBytes = budgetBytes;
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
  /** Exact approved evidence commands needed by this role, if any. */
  readonly allowedShellCommands?: readonly string[];
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

/** Seam over the provider adapter factories; tests inject an in-process fake
 * to avoid real harness spawns. */
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
 * Production factory: the first-party Claude Code subscription provider for
 * EVERY Claude role, plus real Codex-ACP/OpenCode-ACP/Grok Build adapters.
 * There is no production Claude ACP/API-key fallback: selecting harness
 * `claude` always means the installed native provider. §17.1 H-1 — the Codex
 * path relies on `createCodexAcpAdapter`'s default isolated `CODEX_HOME`; this
 * call site NEVER forwards a user-controlled `CODEX_HOME`.
 */
export function defaultRoleAdapterFactory(): RoleAdapterFactory {
  return {
    create(options: RoleAdapterOptions): RoleAdapterHandle {
      if (options.resolved.harness === 'claude') {
        const created = createClaudeProviderAdapter({
          role: options.role,
          cwd: options.cwd,
          clock: options.clock,
          model: options.resolved.model,
          ...(options.resolved.effort !== undefined ? { effort: options.resolved.effort } : {}),
          ...(options.allowedShellCommands !== undefined
            ? { allowedShellCommands: options.allowedShellCommands }
            : {}),
        });
        const ps = createPsClient(options.clock);
        return {
          adapter: created.adapter,
          captureProcessIdentity: (generationId: ProcessGenerationId) =>
            captureAcpProcessIdentity(created.adapter, generationId, ps),
          dispose: (): Promise<void> => created.adapter.close(),
        };
      }
      const base: CreateProviderAdapterOptions = {
        cwd: options.cwd,
        clock: options.clock,
        permissions: options.permissions,
      };
      const created =
        options.resolved.harness === 'codex'
          ? createCodexAcpAdapter(base)
          : options.resolved.harness === 'opencode'
            ? createOpenCodeAcpAdapter(base)
            : createGrokBuildAcpAdapter({
                ...base,
                role: options.role,
                model: options.resolved.model,
                ...(options.resolved.effort !== undefined
                  ? { reasoningEffort: options.resolved.effort }
                  : {}),
              });
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
  /** Keep the coordinator's planning/revision rounds attached to an Agent Room. */
  readonly planningChatEnabled?: boolean;
  /** Default `{mode:'headless'}` (deny-all, §10.2). */
  readonly mediation?: PermissionMediation;
  /**
   * F5: the implementation base commit, resolved from the workspace HEAD at
   * `start` and pinned immutably into `RunMeta`. Production `start` always
   * supplies it; omit only for a legacy/test run that pins later (or never).
   */
  readonly baseCommit?: GitSha;
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
  /**
   * P4b-2 (§5cc): the caller is the lease-holding implement→verify loop and is
   * prepared to CATCH an `AutoRespawnSignal` and re-drive the successor spine.
   * Set ONLY by `runImplementVerifyLoop`; a coordinator round or a bare
   * `runRole` never opts in, so a crash there stays P4a (interrupted → manual).
   * The auto-respawn decision additionally requires `restarts.autoRespawn ===
   * 'bounded'`, a generation-matched T13, and in-process run ownership.
   */
  readonly autoRespawn?: boolean;
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
  /** P4b-2: unacknowledged self-drive successor INTENT marker (a
   * `resumeReentryPending` sibling), cleared by the same `child.spawned` ack. */
  readonly successorIntent?: SuccessorIntent;
  /**
   * P4b-2: present iff the run is `interrupted` under `autoRespawn=bounded` (the
   * breaker is not yet exhausted — an exhausted run is `breaker_open`, not
   * `interrupted`). Signals the CLI to render "interrupted — auto-recovering
   * (attempt N)" rather than a manual-resume prompt. `attempt` is the durable
   * count of restarts folded into the current window so far.
   */
  readonly autoRecovering?: { readonly attempt: number };
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

/**
 * P4b-1 alert delivery seams (§5cc). Omit for production defaults (a `stderr`
 * push sink over `process.stderr` + the `status_json` pull view). Provide
 * `notifiers` to REPLACE the sink set (e.g. a capturing stderr in tests, or a
 * wave-2 webhook adapter), or `stderrWrite` to only redirect the default
 * stderr sink's output.
 */
export interface AlertOptions {
  readonly notifiers?: readonly Notifier[];
  readonly stderrWrite?: (line: string) => void;
}

/** One `(alertId, sink)` delivery an alert-delivery pass freshly appended. */
export interface AlertDeliveredRecord {
  readonly alertId: AlertId;
  readonly sink: string;
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
  /** P4b-1 alert delivery seams; omit for production defaults. */
  readonly alerts?: AlertOptions;
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

/** F1/F3: the structured cause bound to a generation the RSS watchdog is
 * terminating — read at the prompt / provider-failure seam to close the turn
 * `resource_exhausted` and suspend the run. */
interface ResourceExhaustionCause {
  readonly role: RoleName;
  readonly rssBytes: number;
  readonly budgetBytes: number;
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
 * F3 (§5ff/§5hh review-7): is an error thrown by the ACTIVE role flow a
 * RECOVERABLE typed failure — one that leaves the run genuinely reclaimable, so
 * `#interruptActiveRoundOnFlowError` records a durable INTERRUPTED outcome
 * instead of stranding it? Positive identification by error TYPE (the diagnosis
 * mandates the recoverable/terminal split be type-based): the typed
 * provider/flow errors are recoverable —
 *  - any `AdapterError` the profile `classifyError` recognizes (auth/protocol
 *    reach here sink-safe from `#routeProviderFailure`);
 *  - a `BudgetExceededError` (§17.2 estimated-budget refusal — operational, not
 *    a bug);
 *  - a `WorktreeError` (every local git subprocess failure throws one, §16).
 * Everything else — a `LoopCompositionError`/`RunOwnershipConflictError`/other
 * composition/ownership/invariant breach, or any untyped `Error` (e.g. a plain
 * artifact-IO `Error`, which has no discriminable type and could equally be an
 * invariant breach) — is DELIBERATELY treated as terminal. Defaulting an
 * unrecognized error to terminal is the safe direction: a falsely-resumable
 * terminal error would make `resume` re-enter and re-throw forever, whereas a
 * conservatively-terminal recoverable error is no worse than today's strand.
 */
function isRecoverableRoundFlowError(error: unknown): boolean {
  return isAdapterError(error) || error instanceof BudgetExceededError || isWorktreeError(error);
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
  /** W4-4: durable RUN-ownership leases held ACROSS child rounds for the whole
   * time this process actively drives a run — the owner/control channel the
   * consumer resume gates consult so a between-rounds gap (child record already
   * disposed) never lets a concurrent `resume` double-drive a live owner's
   * worktree (see `run-ownership-store.ts`). */
  readonly #runOwnership: DurableRunOwnershipStore;
  /** W3-5(a): the pid this process stamps as the OWNER of its reservations
   * (its OWN reservations are always live — it is, by definition, running). */
  readonly #selfPid: number;
  readonly #watchdog: Watchdog;
  /** W4-1 (§14 breaker): the supervision-owned crash evaluator wired into the
   * CHILD-crash site (`#interruptOnChildDeath`). A real (non-orchestrator)
   * child crash consults it for restart-window / lifetime exhaustion → the
   * breaker opens (T14) instead of a plain interrupt (T13). Orchestrator
   * restarts (the T17 reap producer) DELIBERATELY never reach it — they must
   * not pollute the child-crash counters. */
  readonly #breaker: RestartBreaker;
  /** W4-1 (§12.2 cadence): per-run "completed turns since last checkpoint"
   * bookkeeping. A cadence checkpoint fires once `checkpoint.cadenceTurns`
   * completed turns elapse (the completed-turn boundary in the role session's
   * `prompt` closure); the counter resets on ANY checkpoint write (cadence or
   * a safe-boundary pause/stop) so the next window starts fresh. */
  readonly #cadenceTrackers = new Map<RunId, CadenceTracker>();
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
  /** F1/F3: generation-scoped RSS-exhaustion cause, set when the watchdog
   * reports an `rss.hard_limit` for a generation (BEFORE it cancels/kills the
   * turn) and consulted at the prompt / provider-failure seam to classify the
   * termination as `resource_exhausted` rather than a completed turn or a T13
   * crash. Cleared when the generation's supervision is released. */
  readonly #resourceExhaustion = new Map<ProcessGenerationId, ResourceExhaustionCause>();
  /** F6: generations whose graceful-stop callback is already running — the
   * watchdog's deadline escalation, a re-sample, and runRole's dispose must not
   * re-drive the checkpoint/cancel/dispose work; it runs at most once. */
  readonly #gracefulStopsInFlight = new Set<ProcessGenerationId>();
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

  /** P4b-1: the alert delivery sinks (`stderr` push + `status_json` pull view
   * by default). Delivery is best-effort/at-least-once, driven from the log. */
  readonly #notifiers: NotifierRegistry;

  constructor(options: OrchestrationServiceOptions) {
    this.#db = options.db;
    this.#clock = options.clock ?? options.db.clock;
    this.#ids = options.ids ?? new RandomIdFactory();
    this.#config = options.config ?? DEFAULT_ENGINE_CONFIG;
    this.#bounds = toEngineBounds(this.#config);
    this.#engineReducer = makeEngineReducer(this.#bounds);
    // W4-1: the breaker reads the SAME engine bounds (lifetime cap +
    // restart-window max) the reducer folds against, so its exhaustion
    // decision is consistent with the durable counters.
    this.#breaker = new RestartBreaker(this.#ids, DEFAULT_BREAKER_BOUNDS, this.#bounds);
    this.#adapterFactory = options.adapterFactory ?? defaultRoleAdapterFactory();
    // P4b-1: alert delivery sinks. `notifiers` REPLACES the set; otherwise the
    // default `stderr` + `status_json` sinks (with an optional stderr redirect).
    this.#notifiers =
      options.alerts?.notifiers !== undefined
        ? new NotifierRegistry(options.alerts.notifiers)
        : defaultNotifierRegistry(options.alerts?.stderrWrite);

    // W2-6 §14 assembly. The registry store is DURABLE by default (SQLite
    // projection layer) so identity survives an orchestrator crash; every
    // kill anywhere in the service goes through `#registry.signalVerified`.
    const supervision = options.supervision ?? {};
    const ps = supervision.ps ?? createPsClient(this.#clock);
    this.#ps = ps;
    this.#concurrency = new MaxLiveChildrenGuard({ maxLiveChildren: this.#config.maxLiveChildren });
    this.#reservations = new DurableSpawnReservationStore(this.#db);
    this.#runOwnership = new DurableRunOwnershipStore(this.#db);
    this.#selfPid = supervision.selfPid ?? process.pid;
    this.#onIdentityAlert = supervision.onIdentityAlert;
    this.#registry = new ProcessRegistry({
      clock: this.#clock,
      store: supervision.registryStore ?? new DurableProcessRegistryStore(this.#db),
      ps,
      // W4-0: the registry stamps this owner pid on every record and reaps
      // ONLY records whose owner is provably dead — never a live peer's child.
      selfPid: this.#selfPid,
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
      // every other event takes; a throw must never escape into a timer. F1/F3:
      // an `rss.hard_limit` (graceful OR emergency) BINDS a generation-scoped
      // exhaustion cause BEFORE the watchdog cancels/kills the turn — this runs
      // synchronously before `requestGracefulStop`, so the cause is present when
      // the cancelled prompt resolves (or the SIGKILL'd transport throws) at the
      // prompt / provider-failure seam. Set before the ingest so a folding
      // failure can never leave the cause unbound.
      onEvent: (event) => {
        if (event.type === 'rss.hard_limit') this.#bindResourceExhaustionCause(event);
        this.#ingestFromSupervisor(event);
      },
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
          // W4-3 (§12.1): fold + prune every window that has fully closed
          // relative to now. Without this the raw ticks recorded above grow
          // unbounded and `status` never sees an aggregate. Each fold is its
          // own transaction (aggregateWindow); the in-progress window is left
          // for the raw-sample fallback in `status`.
          this.#db.telemetry.aggregateClosedWindows({
            runId: target.runId,
            now: this.#clock.nowIso(),
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
      ...(input.planningChatEnabled === true ? { planningChatEnabled: true } : {}),
      // F5: pin the base commit at create/start — the earliest reproducible
      // snapshot. Immutable (RunMeta is never re-saved).
      ...(input.baseCommit !== undefined ? { baseCommit: input.baseCommit } : {}),
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
        // F1: read fresh + fold in ONE transactionImmediate — a folded child
        // lifecycle / re-entry ack must never fold a stale snapshot either.
        const { written } = this.#atomicEngineWrite(event.runId, () => ({
          trigger: event,
          meta: undefined,
        }));
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

    return this.#ingestTransition(event);
  }

  /**
   * The §6.3 transition write-path (extracted from `ingest`): read + validate +
   * append atomically. When `alertCtx` is supplied (P4b-1, the pause/crash/
   * breaker sites), the transition's engine-emitted alertable `notify.requested`
   * effects fold one `alert.raised` EACH as an extra supporting event IN THE
   * SAME transaction — so an alert can never exist without its cause and the
   * rejected path (a stale-generation crash, a double-pause) appends NO alert.
   */
  #ingestTransition(event: DomainEvent, alertCtx?: AlertRaisedContext): IngestResult {
    // F1 (§5x, Approach A): read + validate + append atomically. The read is
    // INSIDE the write-locked transaction, so `applyTransition` sees any
    // transition a concurrent CLI committed since this caller decided to
    // ingest — an incompatible trigger is rejected against FRESH state, never
    // appended folding a stale snapshot (the old lost-update/illegal-append).
    const { written, meta: outcome } = this.#atomicEngineWrite<TransitionOutcome>(event.runId, (currentState) => {
      const outcome = applyTransition(currentState, event);
      if (outcome.status === 'rejected') {
        return { trigger: outcome.rejectionEvent as DomainEvent, meta: outcome };
      }
      const extraEvents =
        alertCtx !== undefined
          ? this.#deriveAlertEvents(currentState, event, outcome.emitted, alertCtx)
          : [];
      return { trigger: event, emitted: outcome.emitted, extraEvents, meta: outcome };
    });

    if (outcome.status === 'rejected') {
      return {
        status: 'rejected',
        reason: outcome.reason,
        detail: outcome.detail,
        rejection: written.appended[0]?.event ?? (outcome.rejectionEvent as DomainEvent),
      };
    }

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

  // ---- P4b-1 alerts (§5cc) -------------------------------------------------
  /**
   * The SINGLE alert emit point: scan a transition's engine-emitted effects for
   * an alertable `notify.requested` (paused_limit / interrupted / breaker_open)
   * and derive one `alert.raised` per hit, redacting `detail` through the §17.1
   * path. Returned as extra supporting events the caller folds into the SAME
   * `#atomicEngineWrite` transaction as the trigger. `generationId` defaults to
   * the crashing/paused live child on the pre-transition state.
   */
  #deriveAlertEvents(
    currentState: EngineState,
    trigger: DomainEvent,
    emitted: readonly DomainEvent[],
    ctx: AlertRaisedContext,
  ): DomainEvent[] {
    const context: AlertRaisedContext = {
      role: ctx.role,
      ...(ctx.generationId !== undefined
        ? { generationId: ctx.generationId }
        : currentState.activeChild !== undefined
          ? { generationId: currentState.activeChild.generationId }
          : {}),
      ...(ctx.detail !== undefined ? { detail: ctx.detail } : {}),
    };
    return deriveAlertRaisedEvents({ trigger, emitted, context, redact: redactText }) as DomainEvent[];
  }

  /**
   * P4b-1 best-effort, at-least-once alert delivery. DERIVES the un-acked
   * `(alert, sink)` pairs from the log (an `alert.raised` with no matching
   * `alert.delivered` for that sink — the F3 derive-from-log pattern), delivers
   * each to its registered `Notifier`, then appends `alert.delivered` (dedup by
   * `(alertId, sink)`). A `Notifier` THROW leaves the alert un-acked so a later
   * pass retries. Idempotent: a second call with nothing un-acked is a no-op, so
   * a restart re-delivers exactly the alerts that were never acked — once more.
   * Safe on an unknown run (empty log → nothing to do).
   */
  deliverPendingAlerts(runId: RunId): { readonly delivered: readonly AlertDeliveredRecord[] } {
    const events = this.#db.events.listByRun(runId);
    const pending = deriveUnackedAlertDeliveries(events, this.#notifiers.sinks());
    const delivered: AlertDeliveredRecord[] = [];
    for (const { alert, sink } of pending) {
      const notifier = this.#notifiers.get(sink);
      if (notifier === undefined) continue;
      try {
        notifier.deliver(alert);
      } catch {
        // Best-effort: leave un-acked (no `alert.delivered`) — a later pass
        // (or a restart's re-derive) retries. This is the at-least-once edge.
        continue;
      }
      const ackEvent = this.#trigger(
        runId,
        'alert.delivered',
        { alertId: alert.alertId, sink },
        { idempotencyKey: idempotencyKey(alertDeliveredIdempotencyKey(alert.alertId, sink)) },
      ) as DomainEvent;
      const [outcome] = this.#db.events.appendBatch([ackEvent]);
      if (outcome !== undefined && !outcome.deduped) {
        delivered.push({ alertId: alert.alertId, sink });
      }
    }
    return { delivered };
  }

  /** P4b-1 — the alert read-model (the `status --json` alerts section), folded
   * from the run's log (`alert.raised` + per-sink `alert.delivered`). */
  alertStatus(runId: RunId): readonly AlertStatusEntry[] {
    return buildAlertStatusEntries(this.#db.events.listByRun(runId));
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
    // F1: the phase/suspension guard reads FRESH state inside the write lock
    // (a concurrent transition that changed the phase or suspended the run
    // between decision and append is seen, and the advance is refused rather
    // than folding a stale snapshot).
    const { written } = this.#atomicEngineWrite(runId, (state) => {
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
      return { trigger: advance, meta: undefined };
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
    const result = this.ingest(this.#trigger(runId, 'breaker.reset.requested', {}, opts) as DomainEvent);
    // W4-1: T15 clears the durable window/probe counters (the lifetime cap is
    // non-disableable, §14); mirror it into the in-memory breaker so a
    // window-tripped breaker does not immediately re-open on the next crash.
    // Clears BOTH possible bucket keys this run's crashes could have used (its
    // implement→verify assignment, and the run-id fallback for assignment-less
    // spawns) — `reset` on an untracked key is a harmless no-op.
    if (result.status === 'applied') {
      const assignment = this.getImplementVerifyLoopState(runId)?.assignmentId;
      if (assignment !== undefined) this.#breaker.reset(assignment);
      this.#breaker.reset(runId as unknown as AssignmentId);
    }
    return result;
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
    // F1: `BEGIN IMMEDIATE` (not a deferred `transaction`) so the
    // eligibility read + the trigger append are one write-locked unit AND the
    // inner `ingest` `transactionImmediate` nests as a shared no-op —
    // IMMEDIATE stays outermost (the write lock is taken before the read).
    return this.#db.transactionImmediate(() => {
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
      if (suspension === 'resource_exhausted') {
        // F3: a resource-exhausted run must NEVER resume at the same budget — it
        // would re-cross the ceiling immediately. Require an audited per-run
        // budget raise (recorded via `raiseRoleMemoryBudget`) that lifts the
        // exhausted role's effective budget ABOVE the exhausted budget first.
        this.#assertResumableFromResourceExhaustion(runId);
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
   * F3 — the ONE sanctioned, AUDITED exception to run-config immutability: raise
   * `role`'s RSS memory budget on an EXISTING `resource_exhausted` run so it can
   * resume with more headroom. Records a durable `run.memory_budget.overridden`
   * fact (the audit trail) that `#runMemoryBudgetBytes` then reads with top
   * precedence. Refuses a run that is not resource-exhausted (the exception is
   * ONLY for recovery) and refuses anything but a genuine RAISE above the
   * current effective budget. Default posture is human-gated — there is NO
   * automatic escalation (that would mask a leak and weaken the hard ceiling).
   */
  raiseRoleMemoryBudget(
    runId: RunId,
    role: RoleName,
    budgetMb: number,
    opts?: CommandOptions,
  ): IngestResult {
    if (!Number.isInteger(budgetMb) || budgetMb <= 0) {
      throw new WorkflowAdvanceError(
        `raiseRoleMemoryBudget: budgetMb must be a positive integer (got ${budgetMb})`,
      );
    }
    return this.#db.transactionImmediate(() => {
      const suspension = this.#loadEngineRecord(runId).state.suspension.kind;
      if (suspension !== 'resource_exhausted') {
        throw new WorkflowAdvanceError(
          `raiseRoleMemoryBudget: run ${runId} is not resource_exhausted (suspension=${suspension}); ` +
            `the audited per-run budget override exists ONLY to recover a resource-exhausted run`,
        );
      }
      const previousBudgetMb = Math.floor(this.#runMemoryBudgetBytes(runId, role) / BYTES_PER_MB);
      if (budgetMb <= previousBudgetMb) {
        throw new WorkflowAdvanceError(
          `raiseRoleMemoryBudget: new budget ${budgetMb}MB for ${role} must EXCEED the current ` +
            `effective ${previousBudgetMb}MB (a raise, never a lowering)`,
        );
      }
      const exhausted = this.#latestResourceExhaustion(runId);
      return this.ingest(
        this.#trigger(
          runId,
          'run.memory_budget.overridden',
          {
            role,
            budgetMb,
            previousBudgetMb,
            ...(exhausted !== undefined ? { exhaustedBudgetBytes: exhausted.budgetBytes } : {}),
          },
          opts,
        ) as DomainEvent,
      );
    });
  }

  /** F3: the latest `resource.exhausted` incident (role + exhausted budget) for
   * a run, or undefined if none was recorded. */
  #latestResourceExhaustion(runId: RunId): { role: RoleName; budgetBytes: number } | undefined {
    let latest: { role: RoleName; budgetBytes: number } | undefined;
    for (const event of this.#db.events.listByRun(runId)) {
      if (event.type !== 'resource.exhausted') continue;
      const payload = event.payload as EventPayloads['resource.exhausted'];
      latest = { role: payload.role, budgetBytes: payload.budgetBytes };
    }
    return latest;
  }

  /** F3: refuse a resume from `resource_exhausted` until the exhausted role's
   * effective budget was raised (audited) above the budget that was exhausted. */
  #assertResumableFromResourceExhaustion(runId: RunId): void {
    const exhausted = this.#latestResourceExhaustion(runId);
    if (exhausted === undefined) return; // no incident recorded — nothing to gate
    const currentBudgetBytes = this.#runMemoryBudgetBytes(runId, exhausted.role);
    if (currentBudgetBytes <= exhausted.budgetBytes) {
      throw new WorkflowAdvanceError(
        `resume: run ${runId} is resource_exhausted (${exhausted.role}) — raise the role's memory ` +
          `budget above the exhausted ${Math.floor(exhausted.budgetBytes / BYTES_PER_MB)}MB ` +
          `(raiseRoleMemoryBudget, audited) before resuming; it would re-cross the ceiling otherwise`,
      );
    }
  }

  /**
   * P4b-2 self-drive SUCCESSOR spine — STEP 1 (the durable INTENT marker,
   * FIRST, BEFORE any OS spawn). Records the successor INTENT marker (a
   * `resumeReentryPending` sibling on `EngineState`) in ONE `#atomicEngineWrite`
   * fused with the T9/T12 `initiate_resume` suspension-clear: the marker carries
   * the seed §12.2 checkpoint hash (`resolveResumeCheckpointHash`) and the
   * target {harness, model, effort} the successor re-asserts. The predecessor
   * T13 (crash → `interrupted`, restart-window folded + generation stopped) or
   * T4/T5 (limit → `paused_limit`) already recorded the crash/limit bookkeeping
   * — that IS the "prior durable state" observed at crash-window A — so this
   * write only fuses the marker with the suspension-clear.
   *
   * The eligibility chain runs INSIDE the write-locked transaction exactly like
   * `resume` (a superseded spec can never seed a successor). The reason and
   * `reassertModel` come from any un-consumed `segment.successor.required` (T5's
   * emitted-but-previously-zero-consumer event — the spine is now its consumer);
   * absent, this is a plain `recovery` successor. Wave 1: the target defaults to
   * the crashed/paused round's OWN role spec (same-harness/same-model);
   * `opts.target` supplies an explicit target for wave-2 failover.
   *
   * STEP 2 (the OS spawn) is the POST-COMMIT side-effect, driven by the
   * lease-holding owner through the EXISTING resume re-entry machinery
   * (`reenterImplementVerify` → `runImplementVerifyLoop` resume → `adoptWorktree`
   * + `runRole`); `child.spawned` ACKS the marker (the `resume_reentry.completed`
   * path). Crash between STEP 1 and `child.spawned` (window B): reaping kills the
   * mid-spawn orphan and the un-acked marker re-drives — EXACTLY ONE successor.
   */
  recordSuccessorIntent(
    runId: RunId,
    opts?: CommandOptions & { readonly target?: SuccessorTarget; readonly reason?: SuccessorReason },
  ): IngestResult {
    // F1: `BEGIN IMMEDIATE` so the eligibility read + the trigger append (which
    // folds the marker) are one write-locked unit and the inner `ingest`
    // `transactionImmediate` nests as a shared no-op — IMMEDIATE stays outermost.
    return this.#db.transactionImmediate(() => {
      const state = this.#loadEngineRecord(runId).state;
      const suspension = state.suspension.kind;
      if (suspension !== 'paused_limit' && suspension !== 'interrupted') {
        throw new WorkflowAdvanceError(
          `successor spine: run ${runId} must be paused_limit or interrupted to seed a successor (suspension=${suspension})`,
        );
      }
      const eligibility = this.checkResumeEligibility(runId);
      if (!eligibility.eligible) {
        throw new ResumeEligibilityError(runId, eligibility.reason, eligibility.detail);
      }
      const target = opts?.target ?? this.#defaultSuccessorTarget(runId);
      if (target === undefined) {
        throw new WorkflowAdvanceError(
          `successor spine: run ${runId} has no resolvable target (no role round / loop binding recorded)`,
        );
      }
      const requirement = this.#pendingSuccessorRequired(runId);
      const seedCheckpointHash = this.resolveResumeCheckpointHash(runId);
      const successor: SuccessorIntentSeed = {
        target,
        // An explicit `opts.reason` wins (P4b wave-2 FAILOVER stamps
        // `cross_harness_switch`/`model_switch_indeterminate` for lineage); else
        // the un-consumed T5 `segment.successor.required` reason; else a plain
        // crash/restart recovery successor.
        reason: opts?.reason ?? requirement?.reason ?? 'recovery',
        reassertModel: requirement?.reassertModel ?? true,
        ...(seedCheckpointHash !== undefined ? { seedCheckpointHash } : {}),
      };
      // The marker rides the SAME resume trigger the manual path uses (T12 from
      // interrupted, T9 from paused_limit) — maximal reuse of the proven
      // reclaim + `child.spawned` ack + startup-reclaim machinery.
      if (suspension === 'interrupted') {
        return this.ingest(
          this.#trigger(runId, 'resume.user.requested', { successor }, opts) as DomainEvent,
        );
      }
      return this.ingest(
        this.#trigger(runId, 'resume.limit.requested', { mode: 'manual', successor }, opts) as DomainEvent,
      );
    });
  }

  /**
   * P4b-2: an un-consumed `segment.successor.required` (T5's emitted-but-
   * zero-consumer event, PLAN §6.3 gap) — the LATEST one whose sequence is
   * beyond the latest resume trigger (a resume that recorded a marker consumes
   * it). The spine is its consumer: `recordSuccessorIntent` reads the reason +
   * `reassertModel` from here. Public so the CLI resume path can route a T5
   * pause through the successor spine rather than a plain resume.
   */
  hasPendingSuccessorRequirement(runId: RunId): boolean {
    return this.#pendingSuccessorRequired(runId) !== undefined;
  }

  #pendingSuccessorRequired(
    runId: RunId,
  ): { readonly reason: SuccessorReason; readonly reassertModel: boolean } | undefined {
    let requirement: { reason: SuccessorReason; reassertModel: boolean; sequence: number } | undefined;
    let latestResumeSeq = -1;
    for (const event of this.#db.events.listByRun(runId)) {
      if (event.type === 'segment.successor.required') {
        const payload = event.payload;
        requirement = {
          reason: payload.reason,
          reassertModel: payload.reassertModel,
          sequence: Number(event.sequence),
        };
      } else if (event.type === 'resume.limit.requested' || event.type === 'resume.user.requested') {
        latestResumeSeq = Number(event.sequence);
      }
    }
    if (requirement === undefined || requirement.sequence <= latestResumeSeq) return undefined;
    return { reason: requirement.reason, reassertModel: requirement.reassertModel };
  }

  /**
   * P4b-2 wave-1 default target — the crashed/paused round's OWN role spec
   * (same-harness/same-model): the coordinator spec for a coordinator round,
   * else the loop binding's implementor/verifier spec. `undefined` when nothing
   * durable resolves a target (no round or no loop binding) — the caller
   * refuses honestly rather than seeding a target-less successor.
   */
  #defaultSuccessorTarget(runId: RunId): SuccessorTarget | undefined {
    const round = this.getRoleRound(runId);
    if (round === undefined) return undefined;
    if (round.role === 'coordinator') return this.#requireMeta(runId).coordinator;
    const loop = this.getImplementVerifyLoopState(runId);
    if (loop === undefined) return undefined;
    return round.role === 'verifier' ? loop.verifier : loop.implementor;
  }

  /**
   * P4b wave 2 FAILOVER — the EFFECTIVE spec a role dispatch should spawn on:
   * the durable desired-model record (set by `driveFailoverOnLimit` to the next
   * ladder rung, applied by the existing `initial_config_pin` / model-pin
   * machinery) if one exists, else the caller's `fallback` (the run default).
   * The loop reads this at EVERY dispatch so a same-process re-drive AND a
   * cross-process `resume` both spawn the failover successor on the ladder
   * target. Pure read — never fabricates a segment.
   */
  effectiveRoleSpec(runId: RunId, role: RoleName, fallback: RoleModelSpec): RoleModelSpec {
    const desired = new DurableDesiredModelStore(this.#db).get(runId, role);
    if (desired === undefined) return fallback;
    const harness = this.#narrowHarness(desired.harness);
    if (harness === undefined) return fallback;
    return desired.effort !== undefined
      ? { harness, model: desired.model, effort: desired.effort as ReasoningEffort }
      : { harness, model: desired.model };
  }

  /**
   * P4b wave 2 FAILOVER — clear the per-incident ladder position once the run
   * has made real progress PAST a limit (a role dispatch returned normally). A
   * fresh limit later then restarts the ladder from the top rather than
   * inheriting a stale position. Idempotent; safe to call on every healthy
   * dispatch. The desired-model record is deliberately LEFT in place: the
   * successor is legitimately running on the escalated target and `status`
   * should keep showing it as effective until a human changes it.
   */
  resetFailoverIncident(runId: RunId, assignmentId: AssignmentId): void {
    new DurableFailoverStore(this.#db).clear(runId, assignmentId);
  }

  /**
   * P4b wave 2 FAILOVER routing on the PROVEN spine (§5cc/§5ee). Called by the
   * lease-holding owner AFTER `#pauseForLimit` has ALREADY landed `paused_limit`
   * + checkpoint + incident atomically (that half is UNCHANGED). This does NOT
   * wait for the probe ladder: when the assignment's `failoverPolicy` is
   * `switch_model`/`switch_harness` it self-drives `recordSuccessorIntent` with
   * the NEXT `failoverLadder` rung — the adapter factory creates the other
   * harness for `switch_harness`; the successor seeds from the mechanical
   * checkpoint (`resolveResumeCheckpointHash`) and re-asserts the target pin.
   *
   * RULES (§5cc): the caller keeps the SAME `assignmentId` across the failover
   * (the breaker buckets by assignmentId — a new one would be breaker-evasion),
   * and this NEVER routes through `evaluateCrash` (a limit is not a crash) — but
   * a failover successor that LATER crashes DOES feed the breaker, intentionally,
   * under that same assignmentId. The per-incident ladder counter is its OWN
   * durable bound (`maxFailoversPerIncident`), distinct from the crash breaker.
   * On exhaustion the run DEGRADES TO WAIT (T25, stays paused_limit + alert),
   * never a silent drop.
   */
  driveFailoverOnLimit(cause: LimitPausedError, assignmentId: AssignmentId): FailoverDecision {
    const runId = cause.runId;
    const config = loadRunConfig(this.#db, runId) ?? this.#config;
    const policy = config.failoverPolicy;
    if (policy !== 'switch_model' && policy !== 'switch_harness') return { kind: 'wait' };

    const ladder = config.failoverLadder;
    // The per-incident walk stops at the SHORTER of the ladder length and the
    // own counter bound — either way it never oscillates forever.
    const bound = Math.min(ladder.length, config.maxFailoversPerIncident);
    const store = new DurableFailoverStore(this.#db);

    // §review-7 F2: the whole failover ADVANCE — desired-target pin + ladder
    // position advance + `failover` alert + successor intent — commits as ONE
    // atomic unit (`#atomicEngineWrite` discipline). `BEGIN IMMEDIATE` takes the
    // write lock up front and every inner `store.set` / `DesiredModelStore.set` /
    // `ingest` / `recordSuccessorIntent` transparently JOINS this transaction, so
    // there is NO window where the counter is advanced without the intent
    // recorded: a crash mid-advance rolls back the position too, and a retry
    // re-reads the SAME rung it selected rather than skipping one. The position
    // read is INSIDE the lock so the select→advance is a single serialized atom.
    // The SPAWN is the post-commit side-effect (the loop's re-dispatch).
    return this.#db.transactionImmediate((): FailoverDecision => {
      const position = store.position(runId, assignmentId);
      const from =
        this.#defaultSuccessorTarget(runId) ?? { harness: 'claude' as Harness, model: cause.classification.provider };

      // The next rung must both exist (within the bound) AND narrow to a live
      // harness; otherwise there is NO live target → DEGRADE TO WAIT via T25.
      const entry = position < bound ? ladder[position] : undefined;
      const targetHarness = entry !== undefined ? this.#narrowHarness(entry.harness) : undefined;
      // §review-7 F4(b): a `switch_model` failover is model-ONLY — it must keep
      // the role's EFFECTIVE (currently-running) harness. The parse-time
      // cross-field check only proves the ladder entries agree with EACH OTHER;
      // it cannot know which harness the role is actually running on. If a
      // `switch_model` rung names a harness other than `from.harness`, REFUSE it
      // at dispatch (degrade to wait via the same T25 no-live-target path) rather
      // than silently applying it as a cross-harness switch. `switch_harness` is
      // free to cross harnesses, so it is exempt from this guard.
      const crossesHarnessUnderSwitchModel =
        policy === 'switch_model' &&
        targetHarness !== undefined &&
        targetHarness !== from.harness;
      if (entry === undefined || targetHarness === undefined || crossesHarnessUnderSwitchModel) {
        // T25 `failover.no_live_target`: precondition suspension_in [paused_limit]
        // (already true), invariants phase/suspension unchanged → the run STAYS
        // paused_limit. NEVER drops the failover intent silently. The operator
        // `failover` alert (topic `failover_exhausted`) is emitted DIRECTLY here
        // (T25 is not driven at an alert-context fold site).
        const limitedProviders = [...new Set([from.harness, ...ladder.map((e) => e.harness)])];
        this.ingest(
          this.#trigger(runId, 'failover.no_live_target', { limitedProviders }) as DomainEvent,
        );
        this.#raiseFailoverExhaustedAlert(runId, cause.role, position, limitedProviders);
        return { kind: 'exhausted', position };
      }

      const target: SuccessorTarget = {
        harness: targetHarness,
        model: entry.model,
        ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
      };
      // Reuse the desired-model store as the escalation target's durable home so
      // the successor spawn (this loop's re-dispatch OR a cross-process resume)
      // pins it through the existing model-pin machinery (§5cc: reuse the store).
      new DurableDesiredModelStore(this.#db).set({
        runId: String(runId),
        role: cause.role,
        harness: target.harness,
        model: target.model,
        ...(target.effort !== undefined ? { effort: target.effort } : {}),
        requestedAt: this.#clock.nowIso(),
      });
      // Advance the durable per-incident counter WITH the intent in this one
      // atomic unit — the crash-safety comes from the enclosing transaction, not
      // from ordering (the pre-fix ordering skipped a rung on a crash between the
      // advance and the intent).
      store.set(runId, assignmentId, position + 1);
      const reason: SuccessorReason =
        target.harness !== from.harness ? 'cross_harness_switch' : 'model_switch_indeterminate';
      // Cross-harness successor is checkpoint-only (no NL digest, §12.2 deferred)
      // — the seed is `resolveResumeCheckpointHash`, which recordSuccessorIntent
      // reads. Record the from→to lineage on the durable `failover` alert.
      this.#raiseFailoverAlert(runId, cause.role, from, target, position + 1, bound);
      this.recordSuccessorIntent(runId, { target, reason });
      return { kind: 'failover', target, from };
    });
  }

  /** P4b wave 2 — narrow a stored/config harness id to a live `Harness`, or
   * `undefined` when it is not one of the MVP harnesses (a misconfigured rung is
   * treated as no-live-target rather than throwing inside the loop's catch). */
  #narrowHarness(value: string): Harness | undefined {
    try {
      return asHarness(value);
    } catch {
      return undefined;
    }
  }

  /**
   * P4b wave 2 — raise the durable operator `alert.raised{failover}` for a
   * ladder step. Like the `respawn` alert it is emitted DIRECTLY by the spine
   * (there is no `failover` notify effect), carrying the from→to lineage
   * (predecessor harness/model → successor harness/model), the ladder step, and
   * the estimated new-session note (the cross-harness successor continues from
   * the mechanical checkpoint, NOT the dead session's raw history). Detail is
   * §17.1-redacted; the idempotency key derives from (run, role, step) so replay
   * reproduces identical bytes and re-delivery dedups per `(alertId, sink)`.
   */
  #raiseFailoverAlert(
    runId: RunId,
    role: RoleName,
    from: SuccessorTarget,
    to: SuccessorTarget,
    step: number,
    bound: number,
  ): void {
    const key = idempotencyKey(`alert.raised:failover:${String(runId)}:${role}:${step}`);
    const note =
      to.harness !== from.harness
        ? 'cross-harness successor continues from the mechanical checkpoint (new session, no raw history)'
        : 'same-harness successor continues from the mechanical checkpoint';
    const detail =
      `failover ${role} ${from.harness}/${from.model} → ${to.harness}/${to.model}` +
      `${to.effort !== undefined ? ` (${to.effort})` : ''} — ladder step ${step}/${bound}; ${note}`;
    this.ingest(
      draftEvent({
        type: 'alert.raised',
        runId,
        idempotencyKey: key,
        occurredAt: this.#clock.nowIso(),
        payload: {
          alertId: alertId(String(key)),
          kind: 'failover',
          role,
          topic: 'failover',
          detail: redactText(detail),
        },
      }) as DomainEvent,
    );
  }

  /**
   * P4b wave 2 — raise the durable operator `alert.raised{failover}` for the
   * DEGRADE-TO-WAIT case (T25 `failover.no_live_target`): the ladder ran out (or
   * `maxFailoversPerIncident` was hit, or no rung narrows to a live harness), so
   * the run stays `paused_limit`. Topic `failover_exhausted` distinguishes it
   * from a per-step `failover` alert. Idempotency keyed on (run, role, position).
   */
  #raiseFailoverExhaustedAlert(
    runId: RunId,
    role: RoleName,
    position: number,
    limitedProviders: readonly string[],
  ): void {
    const key = idempotencyKey(`alert.raised:failover_exhausted:${String(runId)}:${role}:${position}`);
    const detail =
      `failover ladder exhausted for ${role} after ${position} step${position === 1 ? '' : 's'} ` +
      `(providers tried: ${limitedProviders.join(', ')}) — DEGRADING TO WAIT: the run stays paused_limit ` +
      `for a probe or a manual resume`;
    this.ingest(
      draftEvent({
        type: 'alert.raised',
        runId,
        idempotencyKey: key,
        occurredAt: this.#clock.nowIso(),
        payload: {
          alertId: alertId(String(key)),
          kind: 'failover',
          role,
          topic: 'failover_exhausted',
          detail: redactText(detail),
        },
      }) as DomainEvent,
    );
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

  /**
   * F3 (§5x, Approach B) — DERIVE the checkpoint the resume path should adopt
   * from the LOG, not from the separately-saved `round.checkpointRef` pointer.
   *
   * The old resume read only `round.checkpointRef` (saved AFTER the atomic
   * `checkpoint.recorded` append), so a crash in that window lost the
   * checkpoint, and cadence checkpoints — which never touch `checkpointRef` —
   * were invisible to resume. This makes the "resume re-derives from the log"
   * contract true: scan `checkpoint.recorded` for the LATEST-by-sequence one
   * whose enriched binding is compatible with the CURRENT round.
   *
   * Compatibility REUSES `checkResumeEligibility`'s binding-equality chain
   * (assignment open + non-stale, spec-hash chain) rather than reimplementing
   * it: if the round is not resume-eligible, NO checkpoint may be resurrected.
   * Among the eligible set, a checkpoint is compatible iff (a) it belongs to
   * the current round's assignment (when the round has one), and (b) its
   * `specHash` matches the round's binding — the empty sentinel `''` (no spec
   * at checkpoint time) never counts as a mismatch, and a SUPERSEDED-spec
   * checkpoint (different hash, post spec-revise) is excluded. `checkpointRef`
   * remains only an optional fast-path cache hint — never authoritative,
   * never made atomic.
   *
   * Note the ordering is by event sequence, so a cadence checkpoint recorded
   * LATER than a verifier completion checkpoint wins — that regresses
   * EVIDENCE (re-verify), not CORRECTNESS, which is the safe direction (§5x).
   */
  resolveResumeCheckpoint(runId: RunId): CheckpointContent | undefined {
    const hash = this.resolveResumeCheckpointHash(runId);
    return hash !== undefined ? this.getCheckpointContent(hash) : undefined;
  }

  /** The derived resume checkpoint's artifact hash (see
   * `resolveResumeCheckpoint`); split out so callers that only need the hash
   * (or want to compare it to the `checkpointRef` cache) avoid a CAS read. */
  resolveResumeCheckpointHash(runId: RunId): ArtifactHash | undefined {
    const round = this.getRoleRound(runId);
    if (round === undefined) return undefined;
    // Reuse the exact binding-equality chain: an ineligible round (stale
    // assignment / superseded spec) can never resurrect ANY checkpoint.
    if (!this.checkResumeEligibility(runId).eligible) return undefined;

    const bindingSpecHash = round.specHash !== undefined ? String(round.specHash) : undefined;
    const assignmentId = round.assignmentId;

    let best: { readonly sequence: number; readonly hash: ArtifactHash } | undefined;
    for (const event of this.#db.events.listByRun(runId)) {
      if (event.type !== 'checkpoint.recorded') continue;
      const payload = event.payload;
      // Assignment filter: the checkpoint must belong to the current round's
      // (open, non-stale) assignment. A round with no assignment (coordinator
      // drafting before any assignment exists) skips this filter.
      if (assignmentId !== undefined) {
        if (payload.assignmentId === undefined || String(payload.assignmentId) !== String(assignmentId)) {
          continue;
        }
      }
      // Superseded-spec guard: a checkpoint bound to a DIFFERENT spec than the
      // current round is never resurrected. The empty sentinel is not a spec.
      const cpSpec = String(payload.specHash);
      if (bindingSpecHash !== undefined && cpSpec !== '' && cpSpec !== bindingSpecHash) continue;
      const sequence = Number(event.sequence);
      if (best === undefined || sequence > best.sequence) {
        best = { sequence, hash: payload.artifactHash };
      }
    }
    return best?.hash;
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
    // W4-2 S4 / review-6 F2: a coordinator round DRIVES the run just like the
    // implement/verify loop, so it must hold the same EXCLUSIVE run-ownership
    // lease — acquired BEFORE any role work. Without this the lease was FALSE
    // during a live coordinator round, so `isRunClaimedByLiveProcess` was a
    // no-op and a concurrent `resume` carve-out could double-drive the same
    // coordinator round. The CAS also serializes a true race: if a still-live
    // PEER already owns the run, we lose the swap and WITHHOLD (honest error)
    // rather than double-drive. Released in the `finally` on EVERY path.
    if (!this.acquireRunOwnership(runId)) {
      throw new RunOwnershipConflictError(String(runId));
    }
    try {
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
    } finally {
      this.releaseRunOwnership(runId);
    }
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
    // F1: `BEGIN IMMEDIATE` so the draft persist + the final advance are one
    // write-locked unit and the inner `advanceWorkflowPhase`
    // `transactionImmediate` nests as a shared no-op (IMMEDIATE outermost).
    return this.#db.transactionImmediate(() => {
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

    // The §14 identity for this spawn, allocated up front: `#admitSpawn` needs
    // it to key the durable reservation, and it must be stable BEFORE admission
    // so the same generation reconciles the reservation with the later
    // `child.spawned` registry record. (`seg`/`pgen` are independent counters,
    // so this allocation order is deterministic-ID-safe.)
    const generationId = newProcessGenerationId(this.#ids);

    // W3-5 (§14 concurrency) / W4-8: admit this spawn against `maxLiveChildren`
    // or REFUSE (throws before ANYTHING durable OR any provider resource is
    // created — BEFORE the pending round is persisted AND before
    // `#adapterFactory.create` prepares resources, incl. the Codex §17.1 H-1
    // isolated `CODEX_HOME`). This upholds "refuse before anything durable
    // happens": a cap rejection leaks neither a durable pending round nor a
    // temp `CODEX_HOME`. Enforced BOTH in-process (this service's guard) AND
    // durably across concurrent CLI processes (the shared registry store counts
    // every OTHER process's live children). The slot is released in this
    // method's `finally` on every in-flight exit path (or the setup guard below
    // if resource creation throws after admission was granted).
    this.#admitSpawn(generationId);

    // W2-3: the intended round persists PENDING before any spawn, while the
    // workflow remains at its previous stable phase — a crash or pin failure
    // from here on leaves a retryable pending round, never a stranded phase.
    // Persisted AFTER admission (W4-8) so a REFUSED spawn leaves nothing durable
    // to unwind. The record is built ONCE (with the W2-5 staleness watermark
    // stamped at dispatch time) and re-staged from it, so assignment binding and
    // watermark survive the pending→active→completed re-saves.
    const baseRound =
      dispatch !== undefined ? this.#roundRecord(runId, runner.role, dispatch, spec) : undefined;
    let handle: RoleAdapterHandle;
    try {
      if (baseRound !== undefined) {
        this.#saveRoleRound(runId, { ...baseRound, stage: 'pending' });
      }
      handle = this.#adapterFactory.create({
        role: runner.role,
        cwd,
        clock: this.#clock,
        permissions,
        resolved,
        ...(runner.allowedShellCommands !== undefined
          ? { allowedShellCommands: runner.allowedShellCommands }
          : {}),
      });
    } catch (error) {
      // W4-8: resource setup failed AFTER admission was granted (e.g. the
      // factory could not prepare the Codex isolated `CODEX_HOME` — the factory
      // disposes its OWN temp home on a failed build, H-1). Release the durable
      // reservation + in-process mirror so the failed setup holds no slot, then
      // rethrow. No handle to dispose (creation threw) and no heartbeat has been
      // started yet, so the `finally` machinery below never runs for this path.
      this.#releaseSpawnReservation(generationId);
      this.#concurrency.release(generationId);
      throw error;
    }
    const ctx: SpawnContext = {
      runId,
      role: runner.role,
      resolved,
      adapter: handle.adapter,
      handle,
      segmentId: newSegmentId(this.#ids),
      generationId,
      cwd,
      mediation,
      ...(dispatch !== undefined ? { dispatch } : {}),
    };

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
      // re-entry and appends nothing. P4b-2: the SAME ack clears the successor
      // INTENT marker — `child.spawned` acking the re-entered round IS the
      // successor going active (the marker rides `resumeReentryPending`, but
      // the gate fires on EITHER so a successor-only marker is acked too).
      const ackState = this.#loadEngineRecord(runId).state;
      if (ackState.resumeReentryPending !== undefined || ackState.successorIntent !== undefined) {
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
      let result: T;
      try {
        result = await runner.run(roleSession);
      } catch (flowError) {
        // F3 (§5ff/§5hh review-7): an error thrown by the ACTIVE role flow
        // itself — a non-limit/non-crash TYPED failure (auth/protocol after the
        // prompt closure's `#routeProviderFailure`, a budget refusal, or a local
        // git/worktree flow error) while the child is still alive and this round
        // is durably ACTIVE — would otherwise skip the `completed` write below
        // and STRAND the run: the round stays `active`, suspension `none`, so
        // BOTH `resume` (paused/interrupted-only) and `run` (approved-only)
        // refuse, with no operator path forward. Route it through the SAME
        // interrupt discipline the crash/orchestrator-restart paths use so a
        // RECOVERABLE typed failure records a durable INTERRUPTED outcome (T17)
        // and the run stays reclaimable; a genuinely-terminal error is left
        // untouched (terminal). The error still unwinds (the CLI renders it).
        this.#interruptActiveRoundOnFlowError(ctx, flowError);
        throw flowError;
      }
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
        // F4 (§5x): a round reaching `completed` is durable, real forward
        // progress — reset the breaker's recovery sequence so a LATER, unrelated
        // crash starts a fresh no-progress / max-elapsed-recovery clock instead
        // of inheriting stale history (without this reset an assignment that
        // crashed once, recovered, then ran clean past maxElapsedRecoveryMs would
        // false-trip the breaker on its next unrelated crash). The durable window
        // deque is deliberately NOT cleared (real restarts still count).
        this.#breaker.recordProgress(this.#breakerAssignmentKey(ctx));
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

  /**
   * F5: the run's pinned implementation base commit — `RunMeta.baseCommit`
   * (pinned at `start`) if present, else the latest audited
   * `run.base_commit.pinned` (a legacy run's one-time runtime pin). `undefined`
   * only for a legacy run that has never been pinned — the CLI pins it (audited)
   * before the loop rather than silently resolving live HEAD.
   */
  getRunBaseCommit(runId: RunId): GitSha | undefined {
    const meta = this.#db.projections.get<RunMeta>(runId, RUN_META_PROJECTION)?.state;
    if (meta?.baseCommit !== undefined) return meta.baseCommit;
    let pinned: GitSha | undefined;
    for (const event of this.#db.events.listByRun(runId)) {
      if (event.type === 'run.base_commit.pinned') {
        pinned = (event.payload as EventPayloads['run.base_commit.pinned']).baseCommit;
      }
    }
    return pinned;
  }

  /**
   * F5: one-time AUDITED base pin for a LEGACY run (created before base-at-start
   * pinning, so `RunMeta.baseCommit` is absent). Records the resolved SHA as an
   * explicit durable fact so the runtime resolution is visible, never a silent
   * live-HEAD fallback. Idempotent by content: refuses to re-pin a run that
   * already has a base (RunMeta or a prior pin) to a DIFFERENT SHA.
   */
  pinRunBaseCommit(runId: RunId, baseCommit: GitSha, opts?: CommandOptions): IngestResult | undefined {
    this.#requireMeta(runId);
    const existing = this.getRunBaseCommit(runId);
    if (existing !== undefined) {
      if (String(existing) !== String(baseCommit)) {
        throw new WorkflowAdvanceError(
          `pinRunBaseCommit: run ${runId} already has a pinned base ${existing}; refusing to re-pin to ${baseCommit}`,
        );
      }
      return undefined; // already pinned to this SHA — no-op
    }
    return this.ingest(
      this.#trigger(runId, 'run.base_commit.pinned', { baseCommit, reason: 'legacy_runtime_pin' }, opts) as DomainEvent,
    );
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
      ...(state.successorIntent !== undefined ? { successorIntent: state.successorIntent } : {}),
      // P4b-2: an `interrupted` run under `autoRespawn=bounded` whose interrupt
      // folded at least one CHILD restart is auto-recovering (breaker not
      // exhausted — exhaustion is `breaker_open`, a distinct suspension). The
      // `restartsInWindow > 0` gate excludes a breaker-EXEMPT T17 orchestrator
      // crash (which never folds a restart) — that stays a manual interrupt.
      // `attempt` = restarts folded into the current window so far.
      ...(state.suspension.kind === 'interrupted' &&
      state.counters.restartsInWindow > 0 &&
      this.#autoRespawnMode(runId) === 'bounded'
        ? { autoRecovering: { attempt: state.counters.restartsInWindow } }
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
        // P4b-2: RETURN advice, not THROW — a bounded, generation-matched crash
        // hands the loop an `AutoRespawnSignal` to catch and re-drive; every
        // other case unwinds with the sink-safe error exactly as P4a did.
        throw this.#unwrapCrashDisposition(await this.#interruptOnChildDeath(ctx, raw));
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
   * F1/F3: enter the distinct `resource_exhausted` state for a generation the
   * RSS watchdog terminated. Drives the supporting `resource.exhausted` fold
   * (marks the generation stopped, suspends the run — return phase preserved),
   * then closes an in-flight turn `resource_exhausted` (a pin-window exhaustion
   * has no `turn.started` to close). Returns the typed error the caller throws
   * so the role flow aborts WITHOUT counting cadence or completing the round.
   */
  #enterResourceExhaustion(
    ctx: SpawnContext,
    cause: ResourceExhaustionCause,
    operation: PausedOperation,
  ): ResourceExhaustedError {
    this.ingest(
      this.#trigger(ctx.runId, 'resource.exhausted', {
        generationId: ctx.generationId,
        segmentId: ctx.segmentId,
        role: cause.role,
        rssBytes: cause.rssBytes,
        budgetBytes: cause.budgetBytes,
      }) as DomainEvent,
    );
    if (operation === 'prompt_turn') {
      this.ingest(
        this.#trigger(ctx.runId, 'turn.completed', {
          segmentId: ctx.segmentId,
          generationId: ctx.generationId,
          outcome: 'resource_exhausted',
        }) as DomainEvent,
      );
    }
    return new ResourceExhaustedError(ctx.runId, ctx.role, cause.rssBytes, cause.budgetBytes);
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
    // F1: an emergency SIGKILL for RSS exhaustion kills the child mid-call, so
    // the transport surfaces a crash here. If THIS generation was terminated for
    // RSS exhaustion, that is `resource_exhausted` — NOT a `crash` → T13 (which
    // would fold restart counters and auto-respawn at the SAME budget). Close an
    // in-flight turn `resource_exhausted` and suspend the run BEFORE the
    // classifier ever runs. Covers both a mid-turn SIGKILL and a pin-window one.
    const exhaustion = this.#resourceExhaustion.get(ctx.generationId);
    if (exhaustion !== undefined) {
      throw this.#enterResourceExhaustion(ctx, exhaustion, operation);
    }
    const classification = ctx.adapter.classifyError(raw);
    switch (classification.kind) {
      case 'usage_limit':
      case 'unknown_provider_error':
        throw await this.#pauseForLimit(ctx, classification, operation);
      case 'crash':
        // P4b-2: RETURN advice, not THROW (see `#routePinFailure`'s crash case).
        throw this.#unwrapCrashDisposition(await this.#interruptOnChildDeath(ctx, raw));
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
   * F3 (§5ff/§5hh review-7): route an error thrown by `runner.run()` — the
   * ACTIVE role flow, AFTER `child.spawned` advanced the phase and marked the
   * round `active` — so a strand becomes a resumable interrupt. This is the
   * SAME class of bug the restart-safety work fixed for a different trigger
   * (F1: a reaped `active` generation whose owner died), now for a CAUGHT
   * non-limit/non-crash typed error where the child was still alive.
   *
   * The recoverable/terminal split is by error TYPE (the diagnosis's crux):
   *  - `LimitPausedError` / `AutoRespawnSignal`: the limit (T4/T16) and crash
   *    (T13) spines already recorded their durable outcome from inside the
   *    prompt closure and the loop consumes these as control signals — nothing
   *    to add (the caller re-throws them byte-for-byte).
   *  - a round the crash/pause spine ALREADY suspended (e.g. `autoRespawn=off`
   *    landed T13 → `interrupted` before its sink-safe error reached here):
   *    nothing to add — the guard below keeps that path byte-for-byte.
   *  - a RECOVERABLE typed flow error (`isRecoverableRoundFlowError`: any
   *    provider `AdapterError` the classifier handles — auth/protocol arrive
   *    sink-safe from `#routeProviderFailure`; a `BudgetExceededError`; a local
   *    `WorktreeError`/git flow failure): emit T17
   *    `recovery.running_segment_found` — the PURPOSE-BUILT interrupt for a
   *    still-running segment (suspension=`interrupted`, generation stopped,
   *    round left reclaimable, breaker-EXEMPT — NOT T13, so a flow error never
   *    pollutes the child-crash / respawn counters, exactly like the reap
   *    producer). `resume` then reclaims the SAME round via T12 →
   *    `resolveResumeEntry` — the identical path a T13 crash-interrupt uses.
   *  - anything else (a composition/ownership/invariant breach, or any untyped
   *    `Error`): left TERMINAL with NO interrupt. Relabeling it resumable would
   *    make `resume` re-enter and re-throw forever.
   *
   * Scoped to a dispatched implementor/verifier round: a coordinator strand is
   * already reclaimed by the W3-4 unsuspended re-drive (`handleResume`), and a
   * bare `runRole` (no dispatch) has no round to interrupt. Emitting via the
   * public `ingest` (not `#ingestTransition`) so a T17 rejected by its own
   * preconditions is a benign no-op that never throws — mirroring the reap
   * producer's contract.
   */
  #interruptActiveRoundOnFlowError(ctx: SpawnContext, error: unknown): void {
    if (error instanceof LimitPausedError || error instanceof AutoRespawnSignal) return;
    // F1/F3: a resource-exhausted flow already recorded its OWN durable outcome
    // (the `resource.exhausted` suspension) at the seam — this must not overlay a
    // T17 `interrupted` on top (the suspension-not-none guard below also covers
    // it; this is the explicit, self-documenting form).
    if (error instanceof ResourceExhaustedError) return;
    if (ctx.dispatch === undefined) return;
    if (ctx.role !== 'implementor' && ctx.role !== 'verifier') return;
    // The crash/pause spine may already hold this round suspended (an
    // `autoRespawn=off` T13 interrupt, or a prompt-window T16) — re-recording
    // would append a spurious rejected transition. Keep those paths untouched.
    if (this.#loadEngineRecord(ctx.runId).state.suspension.kind !== 'none') return;
    if (!isRecoverableRoundFlowError(error)) return;
    this.ingest(
      this.#trigger(ctx.runId, 'recovery.running_segment_found', {
        generationId: ctx.generationId,
        segmentId: ctx.segmentId,
      }) as DomainEvent,
    );
  }

  /**
   * W2-3 / P4b-2: a provider-call failure classified `crash` = the child died →
   * T13 (`child.exited.unexpectedly`, generation-stamped): counters fold, that
   * generation is marked stopped, suspension=`interrupted`. The DISPOSITION the
   * call site acts on:
   *  - `throw` — unwind with the SINK-SAFE (redacted §17.1, shape-preserved) raw
   *    error. This is the P4a path and covers `autoRespawn=off`, a stale/rejected
   *    (non-generation-matched) T13, a non-loop caller (coordinator / bare
   *    `runRole`), and a `breaker_open` (T14) exhaustion.
   *  - `respawn` — the lease-holding loop must catch an `AutoRespawnSignal` and
   *    re-drive the successor spine after `backoffMs`. Reached ONLY when the T13
   *    was APPLIED (generation-matched — NOT `evaluateCrash`'s generation-blind
   *    advice, S4), `restarts.autoRespawn==='bounded'`, the dispatch opted in,
   *    and this process owns the run in-process (owner-alive). The crash is
   *    recorded as an `alert.raised{respawn}` instead of `{crash}` — it
   *    auto-recovered, so it is not an operator-actionable interrupt.
   * T17 (orchestrator-restart) never reaches here, so orchestrator crashes never
   * feed this window/lifetime bookkeeping NOR auto-respawn.
   */
  async #interruptOnChildDeath(ctx: SpawnContext, raw: unknown): Promise<CrashDisposition> {
    // W4-1: consult the breaker for THIS child crash. `evaluateCrash` folds the
    // crash into the time-decayed restart window and reads the authoritative
    // lifetime counter from the durable projection — on exhaustion it returns
    // `breaker_open` and we open the breaker (T14) instead of a plain interrupt.
    // The breaker's own trigger event is UNSTAMPED (no generationId); we consult
    // it only for the DECISION and build the transition ourselves so the T13
    // interrupt stays generation-matched (a stale generation's crash must never
    // interrupt a newer active child). T17 (orchestrator-restart) never reaches
    // here, so orchestrator crashes never feed this window/lifetime bookkeeping.
    // F4 (§5x): feed the no-progress detector the latest checkpoint hash DERIVED
    // from the log (F3's binding-compatible derivation) — without it no_progress
    // could never fire. undefined (no eligible checkpoint yet) is the safe
    // direction: no_progress simply cannot trip on this crash.
    const latestCheckpointHash = this.resolveResumeCheckpointHash(ctx.runId);
    const advice = this.#breaker.evaluateCrash({
      runId: ctx.runId,
      assignmentId: this.#breakerAssignmentKey(ctx),
      segmentId: ctx.segmentId,
      occurredAt: this.#clock.nowIso(),
      classifiedAs: 'crash',
      generationId: ctx.generationId,
      ...(latestCheckpointHash !== undefined ? { latestCheckpointHash } : {}),
      counters: this.#loadEngineRecord(ctx.runId).state.counters,
    });
    // P4b-1: the crash detail carried onto the alert is the SINK-SAFE (redacted
    // §17.1) raw error message — never the raw text. `#deriveAlertEvents` re-runs
    // the redaction path defensively when it composes the stored detail.
    const alertCtx: AlertRaisedContext = {
      role: ctx.role,
      generationId: ctx.generationId,
      detail: raw instanceof Error ? raw.message : String(raw),
    };
    if (advice.kind === 'breaker_open') {
      // F4 (§5x): STAMP the generation so T14's `generation_matches_active`
      // guard keeps a stale/late breaker-open off a moved-on/paused/terminal
      // run (mirrors the T13 stamp below). P4b-1: T14's `breaker_open` notify
      // rides an `alert.raised` in the SAME transaction. Breaker exhaustion is
      // ALWAYS a manual interrupt — never auto-respawned (the bound was hit).
      this.#ingestTransition(
        this.#trigger(ctx.runId, 'restart.exhausted', {
          reason: advice.reason,
          generationId: ctx.generationId,
        }) as DomainEvent,
        alertCtx,
      );
      return { kind: 'throw', error: toSinkSafeTypedError(raw) };
    }

    // P4b-2: decide auto-respawn eligibility. `evaluateCrash`'s `restart` advice
    // is generation-BLIND (S4) — so we gate on whether the T13 we build below is
    // actually APPLIED (generation-matched); a stale/superseded crash's T13 is
    // rejected and must NOT respawn. The other gates are known up front.
    const wantRespawn =
      advice.kind === 'restart' &&
      this.#autoRespawnMode(ctx.runId) === 'bounded' &&
      ctx.dispatch?.autoRespawn === true &&
      this.#ownsRunInProcess(ctx.runId);

    // P4b-1/P4b-2: T13's `interrupted` notify rides an `alert.raised{crash}`
    // atomically ON THE MANUAL PATH. When auto-respawning we SUPPRESS the crash
    // alert (it auto-recovered — not operator-actionable) and raise an
    // `alert.raised{respawn}` instead, once the T13 is confirmed generation-matched.
    const t13 = this.#ingestTransition(
      this.#trigger(ctx.runId, 'child.exited.unexpectedly', {
        segmentId: ctx.segmentId,
        generationId: ctx.generationId,
        classifiedAs: 'crash',
      }) as DomainEvent,
      wantRespawn ? undefined : alertCtx,
    );

    if (wantRespawn && t13.status === 'applied' && advice.kind === 'restart') {
      // The crash interrupted the ACTIVE generation (generation-matched) AND
      // auto-respawn is enabled/opted-in/owned → record the informational
      // respawn alert and hand a control signal back to the loop.
      this.#raiseRespawnAlert(ctx, alertCtx.detail);
      return {
        kind: 'respawn',
        signal: new AutoRespawnSignal({
          runId: ctx.runId,
          attempt: advice.attempt,
          backoffMs: advice.backoffMs,
          generationId: ctx.generationId,
        }),
      };
    }
    // Manual interrupt: `autoRespawn=off`, a non-loop caller, no in-process
    // ownership, OR a stale-generation crash whose T13 was rejected (a benign
    // no-op — nothing to respawn). Unwind with the sink-safe error.
    return { kind: 'throw', error: toSinkSafeTypedError(raw) };
  }

  /** P4b-2: the value a crash call site throws — the `AutoRespawnSignal` (a
   * control signal the loop catches) or the sink-safe error (the manual unwind).
   * Both branches THROW at the call site; only the loop treats the signal as
   * non-fatal (re-drive), so a non-loop caller surfaces it as an ordinary error. */
  #unwrapCrashDisposition(disposition: CrashDisposition): unknown {
    return disposition.kind === 'respawn' ? disposition.signal : disposition.error;
  }

  /** P4b-2: the effective `autoRespawn` mode for a run — the pinned per-run
   * config (W1-F5) if present, else this service's config. */
  #autoRespawnMode(runId: RunId): AutoRespawnMode {
    return (loadRunConfig(this.#db, runId) ?? this.#config).restarts.autoRespawn;
  }

  /** P4b-2 owner-alive gate: THIS process currently holds `runId`'s exclusive
   * run-ownership lease (the implement→verify loop acquired it at entry). A
   * bare `runRole` with no acquired lease is never auto-respawned — it has no
   * in-process driver to re-drive the spine, so it stays P4a (manual). */
  #ownsRunInProcess(runId: RunId): boolean {
    const key = String(runId);
    return this.#runOwnership.list().some(
      (record) => record.runId === key && record.ownerPid === this.#selfPid,
    );
  }

  /**
   * P4b-2: raise the informational `alert.raised{respawn}` for a healthy
   * auto-respawn. Emitted DIRECTLY by the spine (not derived from a
   * `notify.requested` — there is no `respawn` notify), as a standalone
   * supporting event AFTER the generation-matched T13 committed. `detail` is the
   * already-redacted crash summary the T13's alertCtx carried. The idempotency
   * key derives from the crashed generation so replay reproduces identical bytes
   * and re-delivery dedups per `(alertId, sink)`.
   */
  #raiseRespawnAlert(ctx: SpawnContext, detail: string | undefined): void {
    const key = idempotencyKey(`alert.raised:respawn:${String(ctx.generationId)}`);
    this.ingest(
      draftEvent({
        type: 'alert.raised',
        runId: ctx.runId,
        idempotencyKey: key,
        occurredAt: this.#clock.nowIso(),
        payload: {
          alertId: alertId(String(key)),
          kind: 'respawn',
          role: ctx.role,
          generationId: ctx.generationId,
          topic: 'respawn',
          detail: redactText(detail ?? 'child crash — bounded auto-respawn'),
        },
      }) as DomainEvent,
    );
  }

  /**
   * W4-1: the per-assignment key the breaker's sliding restart window is
   * bucketed by. A role round carries its assignment on the dispatch; a spawn
   * with no assignment (a coordinator round, a throwaway probe) falls back to
   * the run id so its crashes still bucket together — the non-disableable
   * lifetime cap (read from the durable per-run counters) bounds it regardless.
   */
  #breakerAssignmentKey(ctx: SpawnContext): AssignmentId {
    return ctx.dispatch?.assignmentId ?? (ctx.runId as unknown as AssignmentId);
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
    // F1 (§5x): read + validate the pause trigger + append (trigger + engine
    // effects + `checkpoint.recorded`) atomically. The read is inside the
    // write lock, so a pause committed by a concurrent CLI since this call
    // started is seen — the double-pause branch below decides off FRESH state
    // (the checkpoint artifact was fsynced BEFORE this txn; on the rejected
    // path it is simply left unreferenced and GC'd). The checkpoint extra is
    // appended ONLY on the applied path (never with the rejection).
    const { currentState, meta: outcome } = this.#atomicEngineWrite<TransitionOutcome>(ctx.runId, (state) => {
      const outcome = applyTransition(state, trigger);
      if (outcome.status === 'rejected') {
        return { trigger: outcome.rejectionEvent as DomainEvent, meta: outcome };
      }
      // P4b-1: the T4/T16 `paused_limit` notify effect rides an `alert.raised`
      // (kind `limit_paused`) in the SAME transaction as the pause + its
      // `checkpoint.recorded` — an alert can never exist without its cause.
      const alerts = this.#deriveAlertEvents(state, trigger, outcome.emitted, {
        role: ctx.role,
        generationId: ctx.generationId,
        detail: `provider=${limit.provider} tier=${limit.detectionTier} operation=${operation}`,
      });
      return {
        trigger,
        emitted: outcome.emitted,
        extraEvents: [
          ...(checkpoint.event !== undefined ? [checkpoint.event as DomainEvent] : []),
          ...alerts,
        ],
        meta: outcome,
      };
    });
    if (outcome.status === 'rejected') {
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
   * Step (1) of `pauseForLimit` — the T22 graceful-stop checkpoint (W2-6) and
   * the W4-1 completed-turn cadence checkpoint: assemble + write the §12.2
   * mechanical checkpoint (redact → CAS → fsync happen inside the artifact
   * repository) under the given reason (`pre_pause` | `pre_graceful_stop` |
   * `cadence`), recording the interrupted operation honestly (a cadence
   * checkpoint passes the idle operation — a completed turn interrupts
   * nothing). A §12.1 quota admission rejection is a REAL possible
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
        // F3 (§5x): denormalize the round binding onto `checkpoint.recorded`
        // so resume derives the latest compatible checkpoint from the log.
        role: ctx.role,
        ...(ctx.dispatch?.round !== undefined ? { round: ctx.dispatch.round } : {}),
      },
    );
    if (isErr(written)) return {};
    const ok = unwrap(written);
    // W4-1 (§12.2): ANY written checkpoint — a safe-boundary pause/stop as
    // much as a cadence one — restarts the turn-count window so cadence does
    // not fire a few turns early right after a boundary checkpoint.
    this.#cadenceTrackers.get(ctx.runId)?.recordCheckpointWritten();
    return { event: ok.event, hash: ok.checkpoint.artifactHash };
  }

  /**
   * W4-1 (§12.2 "every N completed turns"): the completed-turn cadence hook.
   * Called once per completed prompt turn from the role session's `prompt`
   * closure. A `CadenceTracker` (policy = `checkpoint.cadenceTurns`) counts
   * turns since the last checkpoint of ANY reason; when the window elapses a
   * `cadence` mechanical checkpoint is written (idle operation — a completed
   * turn leaves no interrupted work) and its `checkpoint.recorded` fact
   * committed. `cadenceTurns <= 0` disables turn-based cadence (the tracker
   * never returns `shouldCheckpoint` for a turn), leaving only the safe
   * boundaries. A failed checkpoint write (quota admission) is non-fatal — the
   * turn already completed; the next window simply carries on.
   */
  async #maybeCadenceCheckpoint(ctx: SpawnContext): Promise<void> {
    let tracker = this.#cadenceTrackers.get(ctx.runId);
    if (tracker === undefined) {
      tracker = new CadenceTracker({ everyNTurns: this.#config.checkpoint.cadenceTurns });
      this.#cadenceTrackers.set(ctx.runId, tracker);
    }
    const decision = tracker.recordCompletedTurn();
    if (!decision.shouldCheckpoint) return;
    const checkpoint = await this.#writeStopCheckpoint(ctx, 'cadence', OPERATION_IDLE);
    if (checkpoint.event !== undefined) this.ingest(checkpoint.event as DomainEvent);
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
    // W4-8/F8 (§14 concurrency): a probe spawns a REAL child process, so it
    // must pass the SAME admission guard as a role spawn — admit against
    // `maxLiveChildren` (or REFUSE with `MaxLiveChildrenExceededError`) BEFORE
    // any provider resource is created (incl. the Codex §17.1 H-1 isolated
    // `CODEX_HOME`), exactly like `runRole`. The §14 identity is allocated up
    // front so `#admitSpawn` can key the durable reservation and so the same
    // generation reconciles with the later registry record. The slot is
    // released in this method's `finally` on every exit path (or the setup
    // guard below if adapter resource creation throws after admission).
    const generationId = newProcessGenerationId(this.#ids);
    this.#admitSpawn(generationId);
    let handle: RoleAdapterHandle;
    try {
      handle = this.#adapterFactory.create({
        role,
        cwd: meta.workspacePath,
        clock: this.#clock,
        // Deny-all headless mediation: a probe never needs tool permissions.
        permissions: toPermissionConfig(DEFAULT_HEADLESS_MEDIATION, role),
        resolved,
      });
    } catch (error) {
      // Resource setup failed AFTER admission was granted (e.g. the factory
      // could not prepare the Codex isolated `CODEX_HOME` — the factory
      // disposes its OWN temp home on a failed build, H-1). Release the durable
      // reservation + in-process mirror so the failed setup holds no slot, then
      // rethrow. No handle to dispose and no heartbeat has started yet, so the
      // `finally` machinery below never runs for this path.
      this.#releaseSpawnReservation(generationId);
      this.#concurrency.release(generationId);
      throw error;
    }
    const ctx: SpawnContext = {
      runId,
      role,
      resolved,
      adapter: handle.adapter,
      handle,
      segmentId: newSegmentId(this.#ids),
      generationId,
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
      // W4-8/F8: free the admitted concurrency slot on EVERY exit path (probe
      // OK, still-limited, inconclusive, budget refusal, dispose failure) —
      // both the durable reservation (cross-process cap) and the in-process
      // mirror. The durable registry record's lifecycle is owned by
      // `#releaseSpawnSupervision` above.
      this.#releaseSpawnReservation(ctx.generationId);
      this.#concurrency.release(ctx.generationId);
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
  /**
   * W4-4 (§14:139): is `runId` currently claimed by a still-alive orchestrator
   * (this process or a live peer)? The consumer resume-routing gates consult
   * this before re-driving a run stranded at a role-completion boundary — or a
   * coordinator round (W3-4) — so a peer genuinely still driving the run is
   * never double-driven by a concurrent `harness resume`.
   *
   * Reads the durable RUN-ownership lease (NOT the per-child registry): the
   * lease is held for the WHOLE duration a process drives the run, ACROSS child
   * rounds, so it survives the between-rounds gap where a clean child dispose
   * has already removed the child record. A lease whose owner pid is gone or
   * recycled (a crashed owner) does NOT count — that run is freely reclaimable,
   * which is the intended crash recovery.
   */
  isRunClaimedByLiveProcess(runId: RunId): boolean {
    return this.#runOwnership
      .list()
      .some((record) => record.runId === String(runId) && this.#runOwnershipOwnerLive(record));
  }

  /**
   * W4-4 / review-6 F2: acquire this process's EXCLUSIVE durable RUN-ownership
   * lease via a compare-and-swap — called at the outer entry of every execution
   * driver (the implement/verify loop AND `runCoordination`), BEFORE any
   * worktree or role work, on both a fresh start-that-drives and a
   * resume-that-drives. Returns `true` when this process now holds the lease
   * (the run was unclaimed, already ours, or held by a provably dead/recycled
   * owner it reclaims); returns `false` when a still-LIVE peer already owns the
   * run — the caller must then WITHHOLD (not double-drive). §14 owner-liveness
   * is evaluated INSIDE the CAS transaction. MUST be paired with
   * `releaseRunOwnership` in the driver's outer `finally`.
   */
  acquireRunOwnership(runId: RunId): boolean {
    return this.#runOwnership.acquire(this.#selfRunOwnership(runId), (existing) =>
      this.#runOwnershipOwnerLive(existing),
    );
  }

  /** W4-4: release this process's RUN-ownership lease (driver's outer
   * `finally` — normal completion, pause, error, or process-exit path).
   * Best-effort: a failure here must never mask the flow outcome — a stranded
   * lease from this LIVE process still (correctly) claims the run and is
   * reclaimed if the process later dies (§14 owner-liveness). Only removes the
   * lease when THIS process still owns it. */
  releaseRunOwnership(runId: RunId): void {
    try {
      this.#runOwnership.release(runId, this.#selfPid);
    } catch {
      // swallow — see doc comment
    }
  }

  /** This process's run-ownership lease record for `runId` (§14 owner identity). */
  #selfRunOwnership(runId: RunId): RunOwnershipRecord {
    const startedAt = this.#ps.sampleIdentity(this.#selfPid)?.startedAt;
    return {
      runId: String(runId),
      ownerPid: this.#selfPid,
      ...(startedAt !== undefined ? { ownerStartedAt: startedAt } : {}),
      acquiredAt: this.#clock.nowIso(),
    };
  }

  /**
   * §14 liveness of a run-ownership lease's OWNER (the orchestrator process):
   * OUR OWN lease is always live (we are running); another process's lease is
   * live only while its pid resolves to the SAME start-time (a gone pid, or one
   * recycled by an unrelated process, is a crashed holder whose run is
   * reclaimable). Mirrors `#reservationOwnerLive` / registry `#ownerLive`.
   */
  #runOwnershipOwnerLive(record: RunOwnershipRecord): boolean {
    if (record.ownerPid === this.#selfPid) return true;
    if (!this.#ps.isAlive(record.ownerPid)) return false;
    if (record.ownerStartedAt === undefined) return true;
    const sample = this.#ps.sampleIdentity(record.ownerPid);
    return sample !== undefined && sample.startedAt === record.ownerStartedAt;
  }

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
      // Only the run's OWN active generation is reconciled (a late/superseded
      // generation clears nothing).
      if (child === undefined || child.generationId !== entry.generationId || !isLiveChild(child)) {
        continue;
      }
      if (child.status === 'stopping') {
        // W2-3 pause-spine crash window: a committed stop-intent with no
        // matching child.stopped — confirm the stop (idempotent). NO
        // interrupt: the pause is intentional, the suspension already holds.
        this.confirmStopIntentAfterCleanup(record.runId);
        continue;
      }
      // W4-4: an `active`/`spawning` generation whose OWNER was DEAD (only
      // dead-owner records reach here — W4-0 skips live-owner ones) is a
      // segment that was running when the orchestrator died. Stage-aware
      // recovery via the run's RoleRoundProjection:
      //  - completed  → the round SUCCEEDED before the crash; just confirm the
      //    stop (generation-matched child.stopped). NO interrupt, NO counter.
      //  - pending/active (or no round) → T17 `recovery.running_segment_found`
      //    (interrupted; manual resume). T17 (NOT T13) keeps orchestrator
      //    restarts out of the child-crash breaker/respawn counters.
      // A T17 rejected by its preconditions (e.g. a run that is actually
      // paused/terminal) is a benign no-op — ingest records a
      // `transition.rejected` and never throws in this loop.
      const round = this.getRoleRound(record.runId);
      if (round?.stage === 'completed') {
        this.ingest(
          this.#trigger(record.runId, 'child.stopped', {
            generationId: child.generationId,
            segmentId: child.segmentId,
            reason: 'startup_cleanup',
          }) as DomainEvent,
        );
      } else {
        this.ingest(
          this.#trigger(record.runId, 'recovery.running_segment_found', {
            generationId: child.generationId,
            segmentId: child.segmentId,
          }) as DomainEvent,
        );
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
      // F3: the spawning role rides onto `rss.hard_limit` so the incident is
      // structured and the generation-scoped exhaustion cause names it.
      role: ctx.role,
      // §14/W1-F5: the RSS budget comes from the run's PINNED config, not
      // whatever this process happens to be configured with. F4: keyed by the
      // spawning ROLE so a per-role override applies to the right generation.
      budgetBytes: this.#runMemoryBudgetBytes(ctx.runId, ctx.role),
    });
  }

  /** W2-6: stop watchers on EVERY dispose path. The durable identity record
   * is removed only when the dispose ladder confirmed the group's exit —
   * otherwise it stays for §14 startup reaping. */
  #releaseSpawnSupervision(ctx: SpawnContext, disposedCleanly: boolean): void {
    this.#watchdog.unwatch(ctx.generationId);
    this.#liveSpawns.delete(ctx.generationId);
    // F1/F3/F6: the generation is gone — drop its exhaustion cause and any
    // in-flight graceful-stop guard so the maps never leak across generations.
    this.#resourceExhaustion.delete(ctx.generationId);
    this.#gracefulStopsInFlight.delete(ctx.generationId);
    if (ctx.identity !== undefined && disposedCleanly) {
      this.#registry.store.remove(ctx.generationId);
    }
  }

  /** The effective RSS budget (§14 default 1024MB) for `role`, in bytes.
   * Precedence: an F3 AUDITED per-run override (`run.memory_budget.overridden`,
   * the sanctioned exception to config immutability, set only to recover a
   * resource-exhausted run) → the F4 pinned per-role `memory.perRole.<role>`
   * → the pinned global `memory.budgetMb`. The pinned config is always the
   * run's, never live config. */
  #runMemoryBudgetBytes(runId: RunId, role: RoleName): number {
    const pinned = loadRunConfig(this.#db, runId) ?? this.#config;
    const pinnedMb = pinned.memory.perRole?.[role]?.budgetMb ?? pinned.memory.budgetMb;
    const overrideMb = this.#latestRoleMemoryBudgetOverrideMb(runId, role);
    return (overrideMb ?? pinnedMb) * BYTES_PER_MB;
  }

  /** F3: the budgetMb of the LATEST audited `run.memory_budget.overridden` for
   * `role`, or undefined if none was recorded. */
  #latestRoleMemoryBudgetOverrideMb(runId: RunId, role: RoleName): number | undefined {
    let latest: number | undefined;
    for (const event of this.#db.events.listByRun(runId)) {
      if (event.type !== 'run.memory_budget.overridden') continue;
      const payload = event.payload as EventPayloads['run.memory_budget.overridden'];
      if (payload.role === role) latest = payload.budgetMb;
    }
    return latest;
  }

  /** F1/F3: bind (or refresh) the generation-scoped RSS-exhaustion cause from an
   * `rss.hard_limit` incident so the prompt / provider-failure seam can classify
   * the impending termination. A late incident for the same generation just
   * refreshes the observed RSS. No-op if the event omitted its generation
   * (defensive — the watchdog always stamps it). */
  #bindResourceExhaustionCause(event: EventOfType<'rss.hard_limit'>): void {
    const { generationId, role, rssBytes, budgetBytes } = event.payload;
    if (generationId === undefined) return;
    const resolvedRole = role ?? this.#liveSpawns.get(generationId)?.role;
    if (resolvedRole === undefined) return;
    this.#resourceExhaustion.set(generationId, { role: resolvedRole, rssBytes, budgetBytes });
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
    // F6: idempotent — the checkpoint+cancel+dispose work runs at most once per
    // generation (the deadline escalation, a re-sample, and runRole's own
    // dispose must never re-drive it).
    if (this.#gracefulStopsInFlight.has(generationId)) return;
    this.#gracefulStopsInFlight.add(generationId);
    try {
      try {
        const state = this.#loadEngineRecord(ctx.runId).state;
        const checkpoint = await this.#writeStopCheckpoint(ctx, 'pre_graceful_stop', state.operation);
        if (checkpoint.event !== undefined) this.ingest(checkpoint.event as DomainEvent);
      } catch {
        // A failed checkpoint never blocks the stop — RSS pressure is the
        // emergency here; resume revalidates everything (§16.3) regardless.
        this.#supervisionIngestErrors += 1;
      }
      // F6: do NOT unregister the generation here. The watchdog owns dereg once
      // the tree is confirmed gone (a later sample → `#finish`) or the deadline
      // (armed BEFORE this callback, watchdog.ts) escalates to the emergency
      // kill. Releasing the watcher mid-flight is exactly what let a hung
      // dispose evade the deadline; runRole's `finally` releases supervision on
      // the flow's own exit. Stop ladder (bounded, idempotent): cancel the
      // in-flight turn — the cancelled prompt resolves `stopReason:'cancelled'`,
      // which the prompt seam classifies `resource_exhausted` (F1) — then dispose.
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
    } finally {
      this.#gracefulStopsInFlight.delete(generationId);
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

  /**
   * F2 (§review dogfood): re-stamp `round`'s implementor projection as
   * `no_deliverable` — the PERSISTED verifier gate. `runRole` marks a round
   * `completed` on flow success before the orchestrator can judge the
   * deliverable, and both resume readers (`resolveResumeEntry`, the CLI resume
   * boundary) treat `completed` as "durably committed → verify next". Overwriting
   * the stage here means a restart/resume re-drives the IMPLEMENTOR instead, so a
   * no-deliverable round can never bypass the verifier. Guarded to the current
   * implementor round so a stale caller can never clobber a later projection.
   */
  markRoundNoDeliverable(runId: RunId, round: number): void {
    const current = this.getRoleRound(runId);
    if (current === undefined || current.round !== round || current.role !== 'implementor') return;
    this.#saveRoleRound(runId, { ...current, stage: 'no_deliverable' });
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
        // F1: a watchdog RSS GRACEFUL stop cancels the in-flight turn — the
        // prompt RESOLVES `stopReason:'cancelled'` (it does not throw). Classify
        // as `resource_exhausted` ONLY on BOTH signals: this generation has an
        // RSS-exhaustion cause AND the stop reason is 'cancelled'. A natural
        // `end_turn` that raced in after the threshold but before the cancel took
        // effect carries stopReason 'end_turn' and stays a completed turn (no
        // cadence lost, round completes) — the codex-flagged race. Abort here so
        // the turn is never stamped `completed` and the round never completes.
        const exhaustion = this.#resourceExhaustion.get(ctx.generationId);
        if (exhaustion !== undefined && result.stopReason === 'cancelled') {
          throw this.#enterResourceExhaustion(ctx, exhaustion, 'prompt_turn');
        }
        this.ingest(
          this.#trigger(runId, 'turn.completed', {
            segmentId: ctx.segmentId,
            generationId: ctx.generationId,
            outcome: 'completed',
          }) as DomainEvent,
        );
        if (result.usage !== undefined) this.#foldTurnUsage(runId, role, sessionKey, result.usage);
        // W4-1 (§12.2): a completed turn is the cadence boundary — take a
        // checkpoint once `checkpoint.cadenceTurns` turns have elapsed.
        await this.#maybeCadenceCheckpoint(ctx);
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

  /**
   * F1 (§5x, Approach A) — THE atomic engine-write primitive every state
   * change funnels through. Runs `#loadEngineRecord` + the caller's `build`
   * (which runs the pure `applyTransition` on the transition paths) +
   * `appendTriggerWithEffects` INSIDE one `transactionImmediate` (BEGIN
   * IMMEDIATE — the write lock is taken at BEGIN). Because the read happens
   * inside the write-locked transaction, a trigger is ALWAYS validated
   * against FRESH state: a second CLI that committed a transition between
   * this caller's decision and its write is SEEN, so an incompatible trigger
   * is REJECTED — never appended folding stale state (the old lost-update /
   * illegal-append §5w/§5x bug), never a silent overwrite. All four legacy
   * read→`appendTriggerWithEffects` sites route through here: `ingest`'s
   * transition and engine-folded-supporting branches, `advanceWorkflowPhase`,
   * and `#pauseForLimit`.
   *
   * `build` runs with the freshly-read state (bounds re-injected); it may
   * THROW to abort (the transaction rolls back untouched) and returns the
   * trigger to append plus its engine-emitted effects, any extra supporting
   * events (only appended on the non-rejected path by the caller's choice),
   * and an opaque `meta` handed straight back (the `applyTransition` outcome
   * on the transition paths, so the caller can shape its result / detect a
   * double-pause off the FRESH state). `appendTriggerWithEffects` runs with
   * `alreadyInTransaction` so it joins THIS transaction rather than nesting a
   * second BEGIN. These call sites are fully SYNCHRONOUS read→write (no await
   * between load and append), which is what lets the whole sequence live
   * inside one `transactionImmediate`; `ingest` is never invoked from within
   * an already-open transaction except `resume`/`completeCoordinationRound`,
   * which themselves open `transactionImmediate` so IMMEDIATE stays outermost.
   *
   * BOUNDARY: this does NOT cover `RoleRoundProjection` `#saveRoleRound`
   * (no reducer/cursor, last-write-wins) — that is protected by the F2
   * run-ownership lease, not by this primitive.
   */
  #atomicEngineWrite<M>(
    runId: RunId,
    build: (currentState: EngineState) => {
      readonly trigger: DomainEvent;
      readonly emitted?: readonly DomainEvent[];
      readonly extraEvents?: readonly DomainEvent[];
      readonly meta: M;
    },
  ): {
    readonly currentState: EngineState;
    readonly written: AppendWithProjectionResult<EngineState>;
    readonly meta: M;
  } {
    return this.#db.transactionImmediate(() => {
      const record = this.#loadEngineRecord(runId);
      const currentState: EngineState = { ...record.state, bounds: this.#bounds };
      const built = build(currentState);
      const written = appendTriggerWithEffects(
        this.#db,
        built.trigger,
        built.emitted ?? [],
        { name: ENGINE_STATE_PROJECTION, currentState, reduceEvent: this.#engineReducer },
        built.extraEvents ?? [],
        { alreadyInTransaction: true },
      );
      return { currentState, written, meta: built.meta };
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
