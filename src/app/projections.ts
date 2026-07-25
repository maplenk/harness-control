/**
 * Run projections owned by the application service (PLAN §6.2, §6.3, §12.3).
 *
 * - `ENGINE_STATE_PROJECTION`: the §6.2 three-axis `EngineState`
 *   (phase × suspension × operation + counters), advanced ONLY by folding
 *   events through `makeEngineReducer` — §6.3 trigger events via the pure
 *   `applyTransition`, plus the `workflow.dispatch.advanced` supporting event
 *   (W1-F6: the linear role-dispatch phase steps the §6.3 table deliberately
 *   does not model). This is the reducer used both by the one-transaction
 *   ingest write-path and by crash recovery (`ProjectionRepository.recover`,
 *   §12.3), so replaying the event log rebuilds the exact same state.
 * - `COST_PROJECTION`: the §17.2 per-role/per-phase cost accounting (folded
 *   from adapter usage, not from the transition engine — see `./cost.ts`).
 * - `RUN_META_PROJECTION`: immutable run facts (goal, workspace, coordinator
 *   model spec) captured at `createRun`.
 *
 * The reducer INJECTS the run's engine bounds on every fold: bounds are
 * config-derived, not run state, and (with `windowMax:'off'`) can be
 * `Infinity`, which does not survive JSON — so stored bounds are never
 * trusted, they are always re-applied from config.
 */
import type { DomainEvent, DomainEventType } from '../domain/events.js';
import type { AcceptanceCriterion, MergeReadiness, Verification } from '../domain/entities.js';
import type { IsoTimestamp } from '../lib/clock.js';
import type {
  ArtifactHash,
  AssignmentId,
  GitSha,
  ProcessGenerationId,
  RunId,
  SegmentId,
  SpecHash,
  SpecVersionId,
} from '../domain/ids.js';
import type { ValidationOutcome } from '../worktree/validate.js';
// Type-only (erased at runtime — no import cycle): the §16 binding shape the
// blocked-readiness read-model persists belongs to the verifier flow.
import type { VerificationBinding } from './flows/verifier.js';
import type {
  EngineBounds,
  OperationKind,
  RoleName,
  RunPhase,
  SpecApprovalMode,
  SuspensionKind,
} from '../domain/state.js';
import {
  applyTransition,
  foldChildSpawnInitiated,
  foldChildSpawned,
  foldChildStopped,
  foldResourceExhausted,
  foldResumeReentryCompleted,
  foldTurnCompleted,
  foldTurnStarted,
  type EngineState,
} from '../domain/transitions.js';
import type { RoleModelSpec } from './model-resolution.js';

// ---------------------------------------------------------------------------
// Workflow dispatch edges (§6.2 linear forward advances NOT in the §6.3 table)
// ---------------------------------------------------------------------------
/**
 * The role-dispatch phase advances the §6.3 transition table does not model.
 * Each is a linear forward step taken when the service dispatches a role; they
 * carry no preconditions beyond "the run is at `from` and not suspended".
 * Lives here (not in `service.ts`) because the engine reducer below validates
 * `workflow.dispatch.advanced` events against it during replay (W1-F6).
 */
export const WORKFLOW_DISPATCH_EDGES: readonly (readonly [RunPhase, RunPhase])[] = [
  ['created', 'specifying'],
  ['specifying', 'awaiting_approval'],
  ['approved', 'implementing'],
  ['needs_remediation', 'implementing'],
  ['implementing', 'verifying'],
];

/**
 * W1-F6 — replay folded a `workflow.dispatch.advanced` event whose edge is
 * not a `WORKFLOW_DISPATCH_EDGES` entry or does not depart from the folded
 * phase. The live path validates before appending, so hitting this during
 * replay means the event log is corrupt — fail loudly, never accept silently.
 */
export class WorkflowDispatchReplayError extends Error {
  override readonly name: string = 'WorkflowDispatchReplayError';
  readonly runId: RunId;
  readonly from: RunPhase;
  readonly to: RunPhase;
  readonly phase: RunPhase;
  constructor(runId: RunId, from: RunPhase, to: RunPhase, phase: RunPhase) {
    super(
      `Corrupt event log for run ${runId}: workflow.dispatch.advanced ${from} -> ${to} is illegal at phase '${phase}'`,
    );
    this.runId = runId;
    this.from = from;
    this.to = to;
    this.phase = phase;
  }
}

export const ENGINE_STATE_PROJECTION = 'engine_state';
export const COST_PROJECTION = 'cost_accounting';
export const RUN_META_PROJECTION = 'run_meta';
export const SPEC_DRAFT_PROJECTION = 'spec_draft';
/**
 * W2-3 pending/active dispatch split: the CURRENT role round, persisted
 * `pending` BEFORE any spawn (while the workflow remains at its previous
 * stable phase), marked `active` only after every §11.2 pin succeeded
 * (`child.spawned` committed, phase advanced), and `completed` when the
 * round's flow returns. A non-limit pin failure leaves the round `pending`
 * and RETRYABLE by `run`/`resume` — nothing stranded, no phase advanced.
 * This is the minimal shape with the W2-5 field list; the resume stage
 * (W2-5) drives re-entry ENTIRELY from this projection + the checkpoint and
 * extends the serialized-inputs side.
 */
export const ROLE_ROUND_PROJECTION = 'role_round';
/**
 * W1-F5 config durability: the resolved `EngineConfig` the run was created
 * under (plain bounds/budget/ladder/quota knobs — the schema carries no
 * secrets), persisted by `createRun` in the same transaction as the other
 * initial projections. Every LATER run-scoped CLI invocation reloads it
 * (`loadRunConfig` in ../app/service.ts) so bounds/budget/quotas stay the
 * ones bound at `start` — never whatever a later process happens to default
 * to. Config binds at start: there is deliberately no re-save path.
 */
export const RUN_CONFIG_PROJECTION = 'run_config';
/**
 * W2-2 readiness rework: the durable read-model of a `merge.readiness.blocked`
 * round — criteria all verified, ONLY user/environment-actionable §16 blockers
 * (destination dirty / base drifted / conflicts) remain, the run REMAINS in
 * `verifying` with no remediation round consumed. Persisted BEFORE the
 * supporting event is appended (the projection is what a later, separate
 * `harness recheck` process re-probes from), carrying the SAME immutable
 * Verification/binding plus the probe geometry so recheck re-runs ONLY the
 * git probe. `stage:'resolved'` once a recheck ingested T24.
 */
export const MERGE_READINESS_BLOCKED_PROJECTION = 'merge_readiness_blocked';

/** Immutable run facts captured at `createRun` (serializable). */
export interface RunMeta {
  readonly goal: string;
  readonly workspacePath: string;
  readonly coordinator: RoleModelSpec;
  /** Opt-in Agent Room discussion remains bound to coordinator re-entry and
   * later spec-revision rounds for this run. */
  readonly planningChatEnabled?: boolean;
  /**
   * F5 (§review dogfood): the implementation base commit, pinned at `start`
   * (the earliest reproducible snapshot — the coordinator reads the repo
   * immediately after). Immutable: every fresh implement→verify worktree
   * branches from THIS SHA, so a commit landing between `start` and `run` can
   * never drift the base. Optional only for legacy runs created before F5 (which
   * get a one-time audited `run.base_commit.pinned` instead).
   */
  readonly baseCommit?: GitSha;
}

/**
 * Durable read-model of the coordinator's PROPOSED spec (§7), persisted by
 * `start` once `runCoordination` returns so a LATER, separate CLI process
 * (`run`, in a fresh Node process over the shared SQLite store) can reconstruct
 * the implement→verify loop input — the immutable spec document, its content
 * hash, the acceptance criteria, and the coordinator's proposed
 * implementor/verifier profiles that become the `run` defaults. NOT a §6.3
 * transition and NOT authoritative for phase (the engine owns that); it is the
 * coordinator's output captured for reuse. Approval still binds the hash
 * through the transition engine.
 */
export interface SpecDraftState {
  readonly specVersionId: SpecVersionId;
  readonly specHash: SpecHash;
  /** The exact canonical bytes the coordinator stored (injected to the implementor as the immutable spec, §7). */
  readonly canonicalSpec: string;
  readonly goal: string;
  readonly criteria: readonly AcceptanceCriterion[];
  readonly proposedImplementorProfile: string;
  readonly proposedVerifierProfile: string;
  readonly revision: number;
}

/**
 * W2-2 `MERGE_READINESS_BLOCKED_PROJECTION` state. Everything `harness
 * recheck RUN_ID` needs to re-run ONLY the §16 git probe against the SAME
 * immutable Verification/binding from a fresh process: the verification and
 * binding are stored verbatim (never recomputed), `worktreePath` +
 * `probeDestinationRef` reconstruct the exact probe, and
 * `requiredTestsPassed`/`approvedSpecHash` are the round's immutable non-git
 * gate inputs. `mergeReadiness`/`blockers` always hold the LATEST probe's
 * report (each recheck overwrites them).
 */
export interface MergeReadinessBlockedState {
  /** The immutable §6.1 Verification the blocked readiness was computed for. */
  readonly verification: Verification;
  /** The §16 binding (spec/base/impl commits + integration hints), verbatim. */
  readonly binding: VerificationBinding;
  /** The implementation worktree the verifier ran in (the probe's worktree). */
  readonly worktreePath: string;
  /** The git ref the §16 probe resolves for drift/cleanliness (not the
   * human-facing `binding.destinationRef` label — the probe's own ref). */
  readonly probeDestinationRef: string;
  /** §16 "required tests" gate input — a verification fact, immutable. */
  readonly requiredTestsPassed: boolean;
  /** Spec-drift gate input the blocked round checked against. */
  readonly approvedSpecHash?: SpecHash;
  // B2 (codex F5): the approval SIGNER is deliberately NOT stored here. A
  // recheck re-reads it from the run's event-derived engine state, so there is
  // exactly one place a missing signer is resolved and no persisted record —
  // possibly written by an older build — can quietly report `'human'`.
  /** The latest §16 readiness report (`ready === false` while `blocked`). */
  readonly mergeReadiness: MergeReadiness;
  /** The latest probe's blockers (all user-actionable while `blocked`). */
  readonly blockers: readonly string[];
  /** `blocked` until a recheck ingests T24; then `resolved`. */
  readonly stage: 'blocked' | 'resolved';
  readonly recordedAt: IsoTimestamp;
  /**
   * F13: this record was written BEFORE host attestation existed, and was
   * normalized on read. It carries no receipts and no resolved harness pair —
   * not because verification failed, but because the concepts postdate it.
   * Set by `migrateMergeReadinessBlockedState`, never persisted by a writer.
   */
  readonly predatesHostAttestation?: true;
}

/**
 * Normalize a persisted `merge_readiness_blocked` projection at the READ
 * boundary. An event-sourced store holds records written by every prior version
 * of this code, so a field added by F13 is simply ABSENT from every record
 * written before it — the read path must treat the JSON as untrusted input
 * rather than as a current-shape object.
 *
 * The concrete failure this closes: projections written by main carry neither
 * `Verification.evidenceReceipts` nor `VerificationBinding.resolvedHarnesses`,
 * and `buildMergeReadiness` called `.map` on the missing array. A run main
 * could recheck successfully — after its destination was cleaned — instead
 * threw and was STRANDED with no way forward.
 *
 * Absence is given its honest meaning, in both directions:
 *
 *  - **Never crash on an old shape.** A missing receipt array becomes `[]`:
 *    "recorded before receipts existed" is legitimately empty, not an error.
 *  - **Never fabricate a modern attestation from a record that predates it.**
 *    An empty receipt set is not proof of execution, so it forces the same
 *    `unproven` outcome a missing receipt produces today — `requiredTestsPassed`
 *    cannot stand on the model-evidence-only basis main used. Likewise a
 *    missing harness pair stays ABSENT rather than being reported as a verified
 *    pair; the run's independence was never recorded, so nothing may claim it.
 */
export function migrateMergeReadinessBlockedState(
  state: MergeReadinessBlockedState | undefined,
): MergeReadinessBlockedState | undefined {
  if (state === undefined) return undefined;
  const verification = state.verification as Verification | undefined;
  const receipts = verification?.evidenceReceipts;
  if (Array.isArray(receipts)) return state;

  return {
    ...state,
    predatesHostAttestation: true,
    verification: { ...(verification as Verification), evidenceReceipts: [] },
    // Fail closed: no host attestation exists for this record, so its gate
    // input cannot be carried forward as a pass.
    requiredTestsPassed: false,
    mergeReadiness: {
      ...state.mergeReadiness,
      evidenceReceiptRefs: state.mergeReadiness?.evidenceReceiptRefs ?? [],
    },
  };
}

/**
 * The round's dispatch/completion lifecycle stage (W2-3).
 *
 * F2 (§review dogfood): `no_deliverable` is a TERMINAL round outcome distinct
 * from `completed` — an implementor round whose turn ended abnormally
 * (cancelled/refusal) or a remediation round that produced no new commit. It
 * must NOT be read as "durably committed → verify next": the resume readers
 * (`resolveResumeEntry`, the CLI resume boundary) re-drive the IMPLEMENTOR from
 * it, so a persisted no-deliverable round can never bypass the verifier gate on
 * restart/resume.
 */
export type RoleRoundStage = 'pending' | 'active' | 'completed' | 'no_deliverable';

/** A linear workflow advance recorded on the round (dispatch or completion). */
export interface RoleRoundAdvance {
  readonly from: RunPhase;
  readonly to: RunPhase;
}

/**
 * The COMPLETE generic `RoleRoundProjection` (W2-3 introduced it; W2-5
 * completes it — the resume path is driven ENTIRELY from this projection +
 * the §12.2 checkpoint, never from in-memory loop state): round + role +
 * stage, serialized role inputs, the spec/base binding, the exact
 * `implementationCommit` for verifier rounds, the §12.2 checkpoint ref the
 * pause path records, and the intended completion advance. `generationId` /
 * `segmentId` are stamped when the round goes active so the resume side can
 * correlate the round with its `child.spawned` generation; `assignmentId`
 * keys the worktree adoption (§16.3) and `dispatchedAtSequence` is the
 * event-log watermark the W2-5 eligibility check compares against
 * `assignments.marked_stale` events (a supersession AFTER dispatch makes
 * the round's assignment stale — it can never be resurrected).
 */
export interface RoleRoundProjection {
  readonly round: number;
  readonly role: RoleName;
  readonly stage: RoleRoundStage;
  /** Redacted, bounded abnormal-turn evidence retained across resume. */
  readonly diagnostic?: string;
  /** The round's `{harness, model, effort}` spec, stamped at dispatch (W2-4:
   * a scheduled resume probe runs a fresh throwaway session pinned to
   * EXACTLY this — the same profile/model/effort the round would resume). */
  readonly modelSpec?: RoleModelSpec;
  /** Serialized role inputs (opaque here; W2-5 drives re-entry from them). */
  readonly inputs?: string;
  readonly specHash?: SpecHash;
  readonly baseCommit?: GitSha;
  /** Verifier rounds: the exact implementation commit being verified (§8). */
  readonly implementationCommit?: GitSha;
  /** §12.2 checkpoint artifact recorded for this round (pause path sets it). */
  readonly checkpointRef?: ArtifactHash;
  /** The advance the round's COMPLETION takes (W2-5 re-entry replays it). */
  readonly intendedCompletionAdvance?: RoleRoundAdvance;
  readonly generationId?: ProcessGenerationId;
  readonly segmentId?: SegmentId;
  /** The assignment whose worktree the round runs in (W2-5 adoption key). */
  readonly assignmentId?: AssignmentId;
  /** Event-log sequence watermark at dispatch (W2-5 staleness check). */
  readonly dispatchedAtSequence?: number;
}

/**
 * W2-5 worktree facts, persisted AT CREATION so a later, separate process
 * can ADOPT the worktree through the manager (mutex + §16.3 validation)
 * instead of ever creating a new one on resume. `lastValidation` records the
 * most recent §16.3 reconciliation outcome (WIP-commit-or-reset) taken on an
 * adoption — durable, so the operator can see exactly what a resume did to
 * an interrupted implementor's dirt.
 */
export interface WorktreeFactsState {
  readonly assignmentId: AssignmentId;
  readonly repoRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseSha: GitSha;
  readonly createdAt: IsoTimestamp;
  readonly lastValidation?: {
    readonly outcome: ValidationOutcome;
    readonly detail: string;
    readonly wipCommitSha?: GitSha;
    readonly at: IsoTimestamp;
  };
  /**
   * F7 (#1): the last HOST-verified implementation commit the loop read after a
   * completed implementor round (host-read worktree HEAD, never agent-claimed),
   * ROUND-SCOPED. A completed-round resume (which re-enters at VERIFICATION) RESETS
   * the adopted worktree to EXACTLY this commit — never WIP-commits post-commit dirt
   * (provisioning residue / an un-ignored node_modules) onto a new, unadjudicated
   * HEAD. The `round` binds the commit to the round that produced it: it is used ONLY
   * when it equals the resuming round, so a record left STALE by an EARLIER round (a
   * later round durably completed at a NEW commit but crashed before updating this)
   * can never reset/verify the WRONG commit — resume falls back to the current HEAD
   * (which is exactly that later round's durable commit). Absent until the first
   * implementor round completes.
   */
  /**
   * F13: deliberately carries NO host-verification verdict. A provisioning
   * failure is evidence about the attempt that failed, never about a later
   * one, and the verify boundary re-provisions unconditionally and fails
   * closed — so the current attestation is always derivable there. Persisting
   * a verdict let a superseded negative outlive its attempt and force every
   * command-bearing criterion `unproven` on a resume whose tree had just been
   * re-proven.
   */
  readonly lastImplementationCommit?: {
    readonly round: number;
    readonly commit: GitSha;
  };
}

/**
 * W2-5: the durable input binding of ONE `runImplementVerifyLoop` invocation
 * — everything a fresh process needs (beyond the spec draft, which is its own
 * projection) to re-enter the loop at implementing/verifying/
 * needs_remediation: the assignment, both role model specs, the bound spec
 * hash, the base task scope (round-N remediation scopes live in the round's
 * own serialized inputs), the probe's destination geometry, and the worktree
 * facts once created. Saved by the loop at entry (before any dispatch) and
 * updated in place when the worktree is created/adopted.
 */
export const IMPLEMENT_VERIFY_LOOP_PROJECTION = 'implement_verify_loop';

export interface ImplementVerifyLoopState {
  readonly assignmentId: AssignmentId;
  readonly implementor: RoleModelSpec;
  readonly verifier: RoleModelSpec;
  readonly specHash: SpecHash;
  /** The base (round-1) task scope; remediation rounds append fix-requests. */
  readonly taskScope: string;
  /** Label for the manual `git switch <dest>` integration hint (§16). */
  readonly destinationLabel: string;
  /** Git ref the §16 probe resolves for drift/cleanliness. */
  readonly destinationRef: string;
  /** Worktree facts, persisted at creation (W2-5 adoption input). */
  readonly worktree?: WorktreeFactsState;
}

/**
 * W2-1/W2-3: the SUPPORTING events the engine reducer folds into
 * `EngineState` (beyond §6.3 trigger events). `workflow.dispatch.advanced`
 * is W1-F6; `child.spawn.initiated` / `child.spawned` / `child.stopped` are
 * the generation-tracked child lifecycle (spawn-initiated marks the
 * generation `spawning` + opens the `initial_config_pin` window; `spawned`
 * marks it ACTIVE after pins succeed; a generation-MATCHED stop confirms —
 * completing T11's deferred `paused_user`); `turn.started` /
 * `turn.completed` keep the §6.2 operation axis truthful across prompt
 * turns; `resume_reentry.completed` acks a T9/T12 pending re-entry. `ingest`
 * routes these through the same one-transaction append+projection write path
 * as transitions so `recover()` replays them identically (§12.3).
 */
export const ENGINE_FOLDED_SUPPORTING_EVENTS = [
  'workflow.dispatch.advanced',
  'child.spawn.initiated',
  'child.spawned',
  'child.stopped',
  'turn.started',
  'turn.completed',
  'resume_reentry.completed',
  // F1/F3: folds the RSS-exhaustion suspension (mark generation stopped +
  // suspend `resource_exhausted`) — like the child-lifecycle events above it
  // mutates EngineState and is replayed identically, but is NOT a §6.3 row.
  'resource.exhausted',
] as const satisfies readonly DomainEventType[];

export type EngineFoldedSupportingEvent = (typeof ENGINE_FOLDED_SUPPORTING_EVENTS)[number];

export function isEngineFoldedSupportingEvent(
  type: DomainEventType,
): type is EngineFoldedSupportingEvent {
  return (ENGINE_FOLDED_SUPPORTING_EVENTS as readonly DomainEventType[]).includes(type);
}

/**
 * The canonical EngineState reducer for a run: fold a domain event through the
 * pure `applyTransition` engine, injecting `bounds` (config, not state) first.
 * Trigger events advance state; `workflow.dispatch.advanced` (W1-F6) applies
 * the linear phase step after validating the edge (illegal on replay = corrupt
 * log → `WorkflowDispatchReplayError`, loud, never silent); the W2-1
 * engine-folded supporting events (`ENGINE_FOLDED_SUPPORTING_EVENTS`) fold
 * the generation-tracked child lifecycle and re-entry acks; every other event
 * (supporting/effect events, `transition.rejected`, late provider
 * notifications) rejects as unlisted and leaves state unchanged — which is
 * exactly what makes a full event-log replay reconstruct the live state
 * (§12.3).
 */
export function makeEngineReducer(
  bounds: EngineBounds,
): (state: EngineState, event: DomainEvent) => EngineState {
  return (state, event) => {
    const withBounds: EngineState = { ...state, bounds };
    if (event.type === 'workflow.dispatch.advanced') {
      const { from, to, draft } = event.payload;
      const listed = WORKFLOW_DISPATCH_EDGES.some(([a, b]) => a === from && b === to);
      if (!listed || withBounds.phase !== from) {
        throw new WorkflowDispatchReplayError(event.runId, from, to, withBounds.phase);
      }
      // B2 round 4: fold the coordinator-completion draft ref. This is the run's
      // own LOG recording which SpecVersion was drafted, and it is what lets
      // `applyTransition` check a T1's provenance purely — including during
      // `recover()`, where no database read is permissible.
      //
      // B2 round 5: an advance INTO `awaiting_approval` REPLACES the reference,
      // clearing it when the advance carries none. Round 4 only ever set it, so
      // a revise round that completed BARE (no draft ref — the pure-runner seam)
      // left the SUPERSEDED reference in place, and an approval matching the old
      // version/hash satisfied the check. The latest completion is the only one
      // that can be approved, so it is the only one the state may remember.
      if (to === 'awaiting_approval') {
        const { lastDraftRef: _superseded, ...rest } = withBounds;
        return { ...rest, phase: to, ...(draft !== undefined ? { lastDraftRef: draft } : {}) };
      }
      return { ...withBounds, phase: to };
    }
    if (event.type === 'child.spawn.initiated') {
      return foldChildSpawnInitiated(withBounds, event);
    }
    if (event.type === 'child.spawned') {
      return foldChildSpawned(withBounds, event);
    }
    if (event.type === 'child.stopped') {
      return foldChildStopped(withBounds, event);
    }
    if (event.type === 'turn.started') {
      return foldTurnStarted(withBounds);
    }
    if (event.type === 'turn.completed') {
      return foldTurnCompleted(withBounds);
    }
    if (event.type === 'resume_reentry.completed') {
      return foldResumeReentryCompleted(withBounds);
    }
    if (event.type === 'resource.exhausted') {
      return foldResourceExhausted(withBounds, event);
    }
    const outcome = applyTransition(withBounds, event);
    return outcome.status === 'applied' ? outcome.next : withBounds;
  };
}

// ---------------------------------------------------------------------------
// UI vocabulary projection (§6.2) — never stored, derived on read
// ---------------------------------------------------------------------------
export type UiState =
  | 'starting'
  | 'working'
  | 'waiting_on_you'
  | 'paused_limit'
  | 'stopped'
  | 'done'
  | 'breaker_open'
  | 'handed_off'
  | 'idle';

export interface UiStateInput {
  readonly phase: RunPhase;
  readonly suspension: SuspensionKind;
  readonly operation: OperationKind;
  /** A permission decision is pending (projection shows "Waiting on you", T20). */
  readonly permissionPending?: boolean;
}

/**
 * §6.2 UI vocabulary as a pure projection: Starting · Working · Waiting on
 * you · Paused—limit · Stopped · Done · Breaker open · Handed off. Suspension
 * and terminal phase take precedence over the active operation.
 */
export function uiStateOf(input: UiStateInput): UiState {
  switch (input.suspension) {
    case 'paused_limit':
      return 'paused_limit';
    case 'breaker_open':
      return 'breaker_open';
    case 'paused_user':
      return 'stopped';
    case 'interrupted':
      return 'starting'; // recovery in progress (§12.3)
    case 'resource_exhausted':
      // F3: the run stopped at its RSS ceiling and needs operator action
      // (raise the budget, then resume) — not auto-recovering like `interrupted`.
      return 'stopped';
    case 'none':
      break;
  }

  if (input.phase === 'cancelled' || input.phase === 'failed') return 'stopped';
  if (input.phase === 'merge_ready') return 'done';
  if (input.phase === 'awaiting_approval' || input.permissionPending === true) return 'waiting_on_you';
  if (input.operation === 'prompt_turn' && (input.phase === 'implementing' || input.phase === 'verifying')) {
    return 'working';
  }
  return 'idle';
}
