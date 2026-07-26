/**
 * CLI command execution (PLAN §18) — turns a parsed `RunCommand` into calls on
 * the one `OrchestrationService`, producing a stable `--json` payload, a human
 * text rendering, and a process exit code. This is the layer the acceptance
 * tests drive against a FAKE-backed engine (test DB + fake adapter factory, no
 * real spawns): the CLI holds no state of its own, so asserting these outputs
 * asserts the wiring end-to-end.
 *
 * Invariants honored here:
 *  - every state change goes through the service (`createRun`, the CLI wrappers
 *    `approve/reviseSpec/pause/resume/breakerReset/cancel`, or a trigger event
 *    fed to the single `ingest` path for `switch-model`);
 *  - approval is explicit-human-only BY DEFAULT, and the ONE opt-in (B2's
 *    `approval: 'auto'`, pinned per run) has the ENGINE sign the REAL drafted
 *    hash through the SAME validation — `--test-approve` remains a separate,
 *    clearly-named test seam REFUSED unless `HARNESS_TEST_MODE=1` (§4.1/§18),
 *    and is the only path that can ever bind a fabricated hash;
 *  - approval BINDS execution (W1-F3): approve validates/binds the persisted
 *    draft's hash, and `run` refuses when the engine's approved hash no longer
 *    matches the draft it is about to inject;
 *  - honest reporting: an ETA is `unknown` while `paused_limit` (never an
 *    invented countdown, §13); vitals with no data read `null`; a switch with
 *    no live session is reported as the engine's honest rejection (§11.2).
 *
 * Commands whose full behavior needs the P3 role flows (the coordinator drafting
 * a spec inside `start`; the implementor/verifier turns inside `run`) resolve
 * and validate everything the engine exposes today and report the plan; the
 * flow execution slots in behind these same commands without changing the surface.
 */
import { realpath } from 'node:fs/promises';
import type { Database } from '../persistence/index.js';
import type { LimitClassification, SpecDraftRef } from '../domain/events.js';
import {
  artifactHash,
  assignmentId,
  criterionId,
  gitSha,
  specHash as toSpecHash,
  type GitSha,
  type RunId,
  type SpecHash,
  type SpecVersionId,
} from '../domain/ids.js';
import * as git from '../worktree/git.js';
import type { AcceptanceCriterion, MergeReadiness, SpecVersion } from '../domain/entities.js';
import { normalizeVerificationCommands } from '../domain/verification-command.js';
import type { RoleName } from '../domain/state.js';
import type { Clock } from '../lib/clock.js';
import type { IdFactory } from '../lib/id-factory.js';
import {
  DurableDesiredModelStore,
  IndependenceViolationError,
  LimitPausedError,
  RUN_META_PROJECTION,
  ResumeEligibilityError,
  SpecApprovalRefusedError,
  WorkspaceDriftError,
  resolvePersistedExecutionMode,
  resolveRoleModel,
  type DesiredModelRecord,
  type IngestResult,
  type OrchestrationService,
  type ResolvedRoleModel,
  type RoleModelSpec,
  type RoleRoundProjection,
  type RoleRunner,
  type RunMeta,
  type SpecDraftState,
} from '../app/index.js';
import {
  runImplementVerifyLoop,
  type ImplementVerifyLoopResult,
  type ImplementVerifyResumeInput,
  type LoopAssignment,
} from '../app/flows/orchestrate.js';
import {
  validateCoordinatorSpec,
  type CoordinatorOutcome,
  type CoordinatorReviseContext,
} from '../app/flows/coordinator.js';
import {
  gitMergeReadinessProbe,
  rebuildFixRequestsFromT23,
  recheckMergeReadiness,
  type EvidenceRecorder,
  type FixRequest,
} from '../app/flows/verifier.js';
import type { ProvisioningFailure, VerificationRunner } from '../app/flows/implementor.js';
import { collectIncidentProbeState, latestIncidentEvent } from '../scheduler/limit-schedule.js';
import { redactText } from '../redaction/index.js';
import { parseRoleProfile } from './profile.js';
import { isErr, ok, type Result } from '../lib/result.js';
import { DEFAULT_ENGINE_CONFIG } from '../config/loader.js';
import { DEFAULT_SPEC_APPROVAL_MODE } from '../config/schema.js';
import type { GitWorktreeManager, ProvisioningCause } from '../worktree/index.js';
import type { RunCommand } from './args.js';

export interface CommandOutput {
  /** The stable `--json` payload (always includes `command` and `ok`). */
  readonly json: Record<string, unknown>;
  /** Human-facing rendering for the non-`--json` surface. */
  readonly text: string;
  /** Process exit code: 0 ok, 1 engine-level failure/rejection, 2 misuse/guard,
   * 4 `integration_blocked` (W2-2: §16 user-actionable blockers — the run
   * REMAINS in `verifying`; resolve them, then `harness recheck`). */
  readonly exitCode: number;
}

/** W2-2 distinct exit code: criteria verified but user-actionable §16 blockers
 * remain (`integration_blocked` / a still-blocked `recheck`). Distinct from
 * 1 (failure) so wrappers can wait+recheck instead of treating it as a
 * defect. */
export const EXIT_INTEGRATION_BLOCKED = 4;

/** W2-5 distinct exit code: the run is durably `paused_limit` and this
 * invocation is NOT waiting it out (`--no-wait`, a plain `resume` whose
 * re-entry paused again, or a wait loop that stopped honestly — ladder
 * exhausted / probe inconclusive). Distinct from 1 (failure): the run is
 * healthy, the provider is limited; resume instructions are printed. */
export const EXIT_LIMIT_PAUSED = 3;

/**
 * W2-5 injectable timer for the in-process schedule loop (`run` on pause,
 * `resume --wait`): production sleeps on real time; tests inject a sleeper
 * that advances a manual clock so probe deadlines elapse deterministically.
 */
export interface WaitScheduler {
  sleep(ms: number): Promise<void>;
}

const REAL_WAITER: WaitScheduler = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** Backoff between claim-fence arbitrations (another waiter holds the rung). */
const WAIT_FENCE_BACKOFF_MS = 5_000;

/** Defensive bound on wait-loop iterations — the ladder is bounded per
 * incident, so hitting this means a livelock bug, not a long wait. */
const MAX_WAIT_ITERATIONS = 10_000;

/** Defensive bound on successive pause→wait→re-enter→pause cycles. */
const MAX_PAUSE_CYCLES = 100;

/**
 * The P3 flow runtime the shipped CLI injects so `start`/`run` DRIVE the role
 * flows (not merely report a plan). Behind an interface so the CLI runtime
 * wires the real components — the coordinator profile + CAS-backed spec store, a
 * git worktree manager over the workspace, the verifier evidence sink — while
 * tests inject in-process fakes. Every state change still flows through the
 * `OrchestrationService`; this only supplies the flow ingredients, never state.
 */
export interface CliFlowDeps {
  readonly ids: IdFactory;
  readonly clock: Clock;
  /** Build the coordinator `RoleRunner` the service drives during `start` (§7)
   * and during the `spec revise` re-drive (W1-F7, `revise` present). */
  buildCoordinatorRunner(input: {
    readonly runId: RunId;
    readonly goal: string;
    readonly coordinator: RoleModelSpec;
    readonly workspacePath: string;
    /** F5 (must-fix 4): the run's PINNED base commit — the coordinator binds its
     * exploration artifact to it, so a spec drafted against a drifted tree is
     * detectable (and refused at coordination completion). */
    readonly baseCommit: GitSha;
    /** Opt-in Agent Room discussion before final spec synthesis. */
    readonly enableChat?: boolean;
    /** T2 revision context (prior version + human feedback); absent for the initial draft. */
    readonly revise?: CoordinatorReviseContext;
  }): RoleRunner<CoordinatorOutcome>;
  /** Open a git worktree manager over the run's workspace repo for `run` (§16). */
  openWorktrees(workspacePath: string): Promise<GitWorktreeManager>;
  /** Sink for the verifier's OWN gathered evidence (§8, §17.1). */
  readonly evidence: EvidenceRecorder;
  /** Runs the implementor's declared verification commands (prod default; tests fake). */
  readonly runVerification?: VerificationRunner;
}

export interface CommandDeps {
  /** Injected IdFactory (tests use a deterministic one); currently unused by the
   * dispatch itself — the flow runtime carries its own `ids`. */
  readonly ids?: IdFactory;
  /** The P3 flow runtime; the shipped CLI always injects it (see `CliFlowDeps`). */
  readonly flows?: CliFlowDeps;
  /** W2-5 schedule-loop timer; defaults to real `setTimeout` sleeping. */
  readonly waiter?: WaitScheduler;
}

/**
 * Execute one run-oriented command against the engine. ASYNC: `start` and `run`
 * drive the P3 role flows through the `OrchestrationService` (coordinator draft;
 * implement→verify→remediation→merge-readiness), streaming real adapters when a
 * `flows` runtime is injected. Known engine errors (`RunNotFoundError`,
 * `WorkflowAdvanceError`, `BudgetExceededError`, worktree/loop errors) are
 * mapped to a clean exit-1 output rather than thrown.
 */
export async function executeCommand(
  service: OrchestrationService,
  db: Database,
  command: RunCommand,
  env: NodeJS.ProcessEnv,
  deps: CommandDeps = {},
): Promise<CommandOutput> {
  try {
    // P4b-1: every CLI invocation over the shared store is a "startup" for the
    // best-effort/at-least-once alert delivery — flush any un-acked alerts to
    // their sinks (stderr push + status_json view) before serving the command.
    // Best-effort: never let a delivery hiccup fail the command.
    if ('runId' in command) {
      try {
        service.deliverPendingAlerts(command.runId);
      } catch {
        /* best-effort — delivery retries on the next invocation */
      }
    }
    switch (command.kind) {
      case 'start':
        return await handleStart(service, command, deps.flows);
      case 'spec_revise':
        return await handleSpecRevise(service, db, command, deps.flows);
      case 'approve':
        return await handleApprove(service, command, env);
      case 'run':
        return await handleRun(service, command, deps.flows);
      case 'recheck':
        return await handleRecheck(service, command, deps.flows);
      case 'status':
        return handleStatus(service, db, command.runId);
      case 'resume':
        return await handleResume(service, db, command, deps);
      case 'pause': {
        const paused = service.pause(command.runId);
        // W3-2: route the stop through the durable §14 registry so a child
        // running in ANOTHER process actually stops (the intent alone leaves
        // it running); the owning process folds the generation-matched stop.
        if (paused.status === 'applied') {
          await service.stopExternalChild(command.runId, { escalate: false });
        }
        return ingestOutput('pause', command.runId, paused, {
          appliedText: `run ${command.runId} pausing at a safe point (T11 -> paused_user).`,
          rejectedHint: 'pause needs an active child and no existing suspension (T11).',
        });
      }
      case 'breaker_reset':
        return ingestOutput('breaker_reset', command.runId, service.breakerReset(command.runId), {
          appliedText: `breaker reset for run ${command.runId} (T15); counters cleared, worktree re-validated before next spawn.`,
          rejectedHint: 'breaker reset applies only while the breaker is open (T15).',
        });
      case 'switch_model':
        return handleSwitchModel(service, db, command);
      case 'set_budget':
        return await handleSetBudget(service, db, command, deps);
      case 'cancel':
        return await handleCancel(service, command);
    }
  } catch (error) {
    const runId = 'runId' in command ? command.runId : undefined;
    if (error instanceof LimitPausedError) {
      // The ONE shared LimitPausedError policy handler (W2-5): serves
      // start / spec-revise / run — and a `resume` whose re-entry paused
      // again. Policy `wait` (default) runs the schedule loop in-process;
      // `--no-wait` (or a plain non-`--wait` resume) exits 3 with resume
      // instructions. The run itself is already durably paused.
      return await handleLimitPaused(service, db, command, error, deps);
    }
    if (error instanceof ResumeEligibilityError) {
      return resumeRefusedOutput(command.kind, error);
    }
    return errorOutput(command.kind, runId, error);
  }
}

// ---------------------------------------------------------------------------
// Coordinator draft persistence (shared by start / spec revise / W2-5 re-entry)
// ---------------------------------------------------------------------------
/** The durable spec-draft read-model a completed coordinator round persists. */
function draftFromOutcome(goal: string, outcome: CoordinatorOutcome): SpecDraftState {
  return {
    specVersionId: outcome.specVersion.id,
    specHash: outcome.specVersion.contentHash,
    canonicalSpec: outcome.canonicalSpec,
    goal,
    criteria: outcome.specVersion.criteria,
    proposedImplementorProfile: outcome.spec.proposedImplementorProfile,
    proposedVerifierProfile: outcome.spec.proposedVerifierProfile,
    revision: outcome.specVersion.revision,
  };
}

/** Reconstruct a `SpecVersion` from the durable draft (§7: the CAS artifact
 * hash IS the spec content hash, so the artifact ref is recoverable). */
function draftAsSpecVersion(runId: RunId, draft: SpecDraftState, clock: Clock): SpecVersion {
  return {
    id: draft.specVersionId,
    runId,
    revision: draft.revision,
    contentHash: draft.specHash,
    contentArtifact: artifactHash(String(draft.specHash)),
    criteria: draft.criteria,
    source: 'coordinator',
    status: 'proposed',
    createdAt: clock.nowIso(),
  };
}

/**
 * W3-4 recovery — rebuild the PRIOR `SpecVersion` (and, when the CAS still
 * holds the canonical bytes, the prior spec text) from the durable
 * coordinator-completion ref, for a `spec revise` whose draft projection was
 * lost: id/revision/hashes come from the completion event verbatim; criteria
 * are re-parsed from the artifact-backed canonical spec (validated with the
 * same §7 gate that admitted it). When the artifact is unreadable the
 * version carries EMPTY criteria and no prior text — honest "lost" markers
 * that only feed the coordinator's revision context (revision numbering +
 * supersedes lineage), never any approval or verification surface.
 */
function rebuildPriorVersionFromCompletion(
  db: Database,
  runId: RunId,
  completion: SpecDraftRef,
  clock: Clock,
): { readonly version: SpecVersion; readonly text?: string } {
  const bytes = db.artifacts.readBytes(completion.artifactHash);
  const text = bytes !== undefined ? Buffer.from(bytes).toString('utf8') : undefined;
  let criteria: readonly AcceptanceCriterion[] = [];
  if (text !== undefined) {
    try {
      const validated = validateCoordinatorSpec(JSON.parse(text));
      if (validated.ok) {
        criteria = validated.value.acceptanceCriteria.map((c) => ({
          id: criterionId(c.id),
          description: c.description,
          // F15: normalized on this read boundary as well — the stored artifact
          // may have been written by any prior version of the coordinator.
          verificationCommands: normalizeVerificationCommands(c.verificationCommands),
          expectedEvidence: c.expectedEvidence,
        }));
      }
    } catch {
      // Unparseable stored spec: keep the empty-criteria reconstruction.
    }
  }
  return {
    version: {
      id: completion.specVersionId,
      runId,
      revision: completion.revision,
      contentHash: completion.specHash,
      contentArtifact: completion.artifactHash,
      criteria,
      source: 'coordinator',
      status: 'proposed',
      createdAt: clock.nowIso(),
    },
    ...(text !== undefined ? { text } : {}),
  };
}

/**
 * W3-4 draft-loss detection: the durable completion ref says a draft was
 * persisted; the CURRENT projection is absent (lost) or carries a different
 * hash (stale/corrupt — production writes both atomically, so divergence is
 * damage, not an in-flight revision: during a T2 re-drive the projection
 * still IS the prior version the latest completion named). `undefined` when
 * the run never completed a drafting round (pure-unit runs) or the draft
 * matches.
 */
function detectDraftLoss(
  service: OrchestrationService,
  runId: RunId,
  draft: SpecDraftState | undefined,
): { readonly completion: SpecDraftRef; readonly kind: 'missing' | 'stale' } | undefined {
  const completion = service.getCoordinatorCompletion(runId);
  if (completion === undefined) return undefined;
  if (draft === undefined) return { completion, kind: 'missing' };
  // B2 round 2 (codex F2): identity is hash AND version AND revision. Hash
  // alone let a SUPERSEDED revision carrying the same content hash pass as
  // current — human approval caught it via its separate --spec-version check,
  // auto-approval had no such second look. Same comparison the service now
  // performs authoritatively inside the approving transaction.
  if (
    String(draft.specHash) !== String(completion.specHash) ||
    String(draft.specVersionId) !== String(completion.specVersionId) ||
    draft.revision !== completion.revision
  ) {
    return { completion, kind: 'stale' };
  }
  return undefined;
}

/** The W3-4 recovery hint shared by the approve/run refusals. */
function draftLossRecoveryHint(runId: RunId): string {
  return (
    `Recovery: \`harness spec revise ${runId} --feedback TEXT\` re-drafts (from awaiting_approval, ` +
    'rebuilding revision context from the durable completion ref + CAS artifact); a run already ' +
    'past approval must be cancelled and re-started.'
  );
}

/**
 * The W3-4 draft-loss REFUSAL, shared by explicit `approve` and B2's
 * auto-approval so both paths refuse identically (same code, same text, same
 * exit) — the engine signing is not a softer gate than a human signing.
 */
function draftLossRefusal(
  command: string,
  runId: RunId,
  draft: SpecDraftState | undefined,
  loss: { readonly completion: SpecDraftRef; readonly kind: 'missing' | 'stale' },
): CommandOutput {
  const text =
    `refusing ${command === 'approve' ? 'approve' : `${command}: auto-approval`}: the run's spec draft is ` +
    `${loss.kind === 'missing' ? 'MISSING' : 'STALE'} — the event log records a completed drafting round ` +
    `(spec ${loss.completion.specVersionId}, hash ${loss.completion.specHash}, revision ` +
    `${loss.completion.revision}) but the draft projection ` +
    `${
      loss.kind === 'missing'
        ? 'is gone'
        : `carries a different identity (spec ${draft?.specVersionId} rev ${draft?.revision}, hash ${draft?.specHash})`
    } (W3-4). ` +
    'There is no draft to bind approval to. ' +
    draftLossRecoveryHint(runId);
  return finish(
    command,
    {
      runId,
      refused: loss.kind === 'missing' ? 'spec_draft_missing' : 'spec_draft_stale',
      completionSpecHash: String(loss.completion.specHash),
      completionSpecVersionId: String(loss.completion.specVersionId),
      ...(draft !== undefined ? { draftSpecHash: String(draft.specHash) } : {}),
      detail: text,
    },
    text,
    1,
  );
}

// ---------------------------------------------------------------------------
// B2 — auto-approval reporting (docs/AUTONOMOUS-BASE-PLAN.md §1)
//
// The auto-approval ITSELF is NOT here. Codex F3: it used to be a CLI
// post-step, so the durable completion API left an `approval:'auto'` run at
// `awaiting_approval`, the W2-5 coordinator re-entry printed `next: approve`,
// and a crash between the completion and the post-step stranded the run at a
// gate it is pinned not to have. It now rides `completeCoordinationRound`'s
// transaction (src/app/service.ts), so EVERY durable coordinator completion
// auto-approves atomically. What is left here is rendering: read the resulting
// engine state and say, on both surfaces, that no human signed.
// ---------------------------------------------------------------------------
/** A completed drafting round's approval outcome, as observed after the fact. */
interface AutoApprovalReport {
  readonly specVersionId: SpecVersionId;
  readonly specHash: SpecHash;
}

/**
 * Did THIS drafting round end auto-approved? Derived from the run's durable
 * post-completion state (`approved` + an engine signature bound to the draft
 * this round produced), never from config — so the report describes what
 * actually happened, and a human who raced in and signed in person is never
 * mis-reported as the engine.
 */
function autoApprovalOf(
  service: OrchestrationService,
  runId: RunId,
  version: { readonly id: SpecVersionId; readonly contentHash: SpecHash },
): AutoApprovalReport | undefined {
  const st = service.status(runId);
  if (st.phase !== 'approved' || st.specApprovedBy !== 'auto') return undefined;
  if (String(st.approvedSpecHash) !== String(version.contentHash)) return undefined;
  return { specVersionId: version.id, specHash: version.contentHash };
}

/** The `--json` projection of a completed auto-approval (B2). */
function autoApprovalView(approved: AutoApprovalReport): Record<string, unknown> {
  return {
    mode: 'auto',
    specVersionId: String(approved.specVersionId),
    specHash: String(approved.specHash),
  };
}

/** The human-facing lines a completed auto-approval adds (B2). */
function autoApprovalLines(runId: RunId, approved: AutoApprovalReport): string[] {
  return [
    `AUTO-APPROVED (approval='auto'): the ENGINE bound spec ${approved.specVersionId} ` +
      `[hash ${approved.specHash}] — no human reviewed this spec. Recorded as spec.approved ` +
      `{approvedBy:'auto'}; the merge-readiness report repeats it.`,
    `next: run ${runId}`,
  ];
}

/**
 * Render a `SpecApprovalRefusedError` — the SERVICE's approval gate (codex
 * F1/F2) saying no — as an ordinary structured refusal rather than a crash.
 * The service is the authority; the CLI only reports its verdict.
 */
function approvalRefusalOutput(command: string, error: SpecApprovalRefusedError): CommandOutput {
  const text =
    error.reason === 'spec_draft_missing' || error.reason === 'spec_draft_stale'
      ? `${error.message} ${draftLossRecoveryHint(error.runId)}`
      : error.message;
  return finish(command, { runId: error.runId, refused: error.reason, detail: text }, text, 1);
}

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------
/**
 * F5: canonicalize and pin the source before a run exists. Non-git,
 * unborn/unresolvable HEAD, and ordinary porcelain dirt are fail-closed: the
 * caller returns a structured refusal and creates no run.
 */
async function resolveStartBase(workspace: string): Promise<{ repoRoot: string; baseCommit: GitSha }> {
  let repoRoot: string;
  let baseCommit: GitSha;
  let status: string;
  try {
    repoRoot = await realpath(await git.resolveTopLevel(workspace));
    const snapshot = await git.readStableHeadAndStatus(repoRoot);
    baseCommit = gitSha(snapshot.headAfter);
    status = snapshot.statusPorcelain;
    if (!snapshot.stable) {
      throw new WorkspaceDriftError({
        kind: 'base_drift',
        pinnedSha: gitSha(snapshot.headBefore),
        currentSha: baseCommit,
        detail:
          `workspace HEAD changed while the start-time source pin was being established ` +
          `(${snapshot.headBefore} -> ${snapshot.headAfter}); retry from a stable checkout`,
      });
    }
  } catch (error) {
    if (error instanceof WorkspaceDriftError) throw error;
    throw new WorkspaceDriftError({
      kind: 'workspace_unresolvable',
      detail:
        `workspace '${workspace}' must be a Git worktree with a resolvable HEAD commit: ` +
        redactText(error instanceof Error ? error.message : String(error)),
    });
  }
  const dirtyPaths = git.porcelainPaths(status);
  if (dirtyPaths.length > 0) {
    throw new WorkspaceDriftError({
      kind: 'workspace_dirty',
      pinnedSha: baseCommit,
      currentSha: baseCommit,
      dirtyPaths,
      detail: `workspace must be clean before start; found ${dirtyPaths.length} dirty path(s)`,
    });
  }
  return { repoRoot, baseCommit };
}

/**
 * F5 (must-fix 4): detect drift of the workspace HEAD from a run's pinned base
 * commit. Returns the pair when they disagree, else undefined (no pinned base,
 * an unresolvable HEAD, or an exact match). Used to close coordinator drift.
 */
async function detectBaseDrift(
  workspace: string,
  pinnedBase: GitSha | undefined,
): Promise<{ pinnedBase: string; currentHead: string } | undefined> {
  if (pinnedBase === undefined) return undefined;
  let head: string;
  try {
    head = await git.resolveSha(workspace, 'HEAD');
  } catch {
    return undefined; // an unresolvable HEAD is handled by the start/run refusal
  }
  return head === String(pinnedBase)
    ? undefined
    : { pinnedBase: String(pinnedBase), currentHead: head };
}

function workspaceRefusalOutput(
  command: string,
  error: WorkspaceDriftError,
  runId?: RunId,
): CommandOutput {
  const body = {
    ...(runId !== undefined ? { runId } : {}),
    refused: error.kind,
    ...(error.pinnedSha !== undefined ? { pinnedSha: String(error.pinnedSha) } : {}),
    ...(error.currentSha !== undefined ? { currentSha: String(error.currentSha) } : {}),
    ...(error.dirtyPaths !== undefined ? { dirtyPaths: error.dirtyPaths } : {}),
    detail: error.message,
  };
  const text = [
    `${command} refused: ${error.message}`,
    ...(error.pinnedSha !== undefined ? [`pinned SHA: ${error.pinnedSha}`] : []),
    ...(error.currentSha !== undefined ? [`current SHA: ${error.currentSha}`] : []),
  ].join('\n');
  return finish(command, body, text, 2);
}

async function handleStart(
  service: OrchestrationService,
  cmd: Extract<RunCommand, { kind: 'start' }>,
  flows: CliFlowDeps | undefined,
): Promise<CommandOutput> {
  if (flows === undefined) {
    // The shipped CLI runtime always injects `flows`; without it there is no
    // coordinator adapter/spec store to draft against — fail honestly (exit 2)
    // rather than create a run that would stall with no way to draft a spec.
    const text =
      'start cannot draft a spec: the coordinator flow runtime is not configured. ' +
      'This is an internal wiring error — the `harness` runtime must provide the P3 flow runtime.';
    return finish('start', { error: 'flows_unavailable', detail: text }, text, 2);
  }

  // F5: pin the implementation base commit at START — the earliest reproducible
  // snapshot (the coordinator reads the repo immediately below). Every fresh
  // implement→verify worktree branches from THIS SHA, so a commit landing
  // between `start` and `run` can never drift the base (the exact dogfood bug).
  // C1: a non-git/unborn/dirty/unstable workspace is refused BEFORE createRun;
  // the service boundary independently requires the exact full commit, so no
  // fresh caller can create an unpinned run by bypassing this CLI check.
  let startBase: Awaited<ReturnType<typeof resolveStartBase>>;
  try {
    startBase = await resolveStartBase(cmd.workspace);
  } catch (error) {
    if (error instanceof WorkspaceDriftError) return workspaceRefusalOutput('start', error);
    throw error;
  }
  const { runId } = service.createRun({
    goal: cmd.goal,
    workspacePath: startBase.repoRoot,
    coordinator: cmd.coordinator,
    baseCommit: startBase.baseCommit,
    ...(cmd.enableChat === true ? { planningChatEnabled: true } : {}),
  });

  // DRIVE the coordinator FLOW through the service: created → specifying →
  // [coordinator drafts + validates a §7 spec on a real adapter] →
  // awaiting_approval, where explicit human approval (T1) is required.
  // W3-4: the durable draft read-model (the later `run` process's loop
  // input, §7 → run defaults) is persisted INSIDE the completion — draft
  // BEFORE the final advance, one transaction — never saved here after the
  // advance already returned.
  const runner = flows.buildCoordinatorRunner({
    runId,
    goal: cmd.goal,
    coordinator: cmd.coordinator,
    workspacePath: startBase.repoRoot,
    baseCommit: startBase.baseCommit,
    ...(cmd.enableChat === true ? { enableChat: true } : {}),
  });
  // B2 (codex F3): `runCoordination` → `completeCoordinationRound` performs the
  // auto-approval ATOMICALLY with the draft + advance when the run is pinned to
  // `approval: 'auto'`. Nothing is approved here afterwards; the service is the
  // gate, and its refusals surface as `SpecApprovalRefusedError`.
  let outcome: CoordinatorOutcome;
  try {
    outcome = await service.runCoordination(runId, runner, (o) => draftFromOutcome(cmd.goal, o));
  } catch (error) {
    if (error instanceof WorkspaceDriftError) return workspaceRefusalOutput('start', error, runId);
    if (error instanceof SpecApprovalRefusedError) return approvalRefusalOutput('start', error);
    throw error;
  }

  // F5 (must-fix 4): close coordinator drift — if the workspace HEAD moved DURING
  // drafting, the coordinator read a tree different from the immutable base
  // pinned at start. Refuse (the drafted spec cannot be trusted against the
  // pinned base); the operator restarts to re-pin.
  const drift = await detectBaseDrift(startBase.repoRoot, startBase.baseCommit);
  if (drift !== undefined) {
    const text =
      `start: workspace HEAD (${drift.currentHead}) DRIFTED from the base pinned at start ` +
      `(${drift.pinnedBase}) during coordination — the spec may have been drafted against a ` +
      `different tree than the immutable implementation base. Cancel this run and start again ` +
      `(a commit landed between the base pin and coordination completion).`;
    return finish(
      'start',
      { runId, error: 'coordinator_base_drift', pinnedBase: drift.pinnedBase, currentHead: drift.currentHead, detail: text },
      text,
      2,
    );
  }

  const autoApproval = autoApprovalOf(service, runId, outcome.specVersion);
  const st = service.status(runId);
  const body = {
    runId,
    phase: st.phase,
    uiState: st.uiState,
    goal: cmd.goal,
    workspacePath: startBase.repoRoot,
    ...(autoApproval !== undefined ? { approval: autoApprovalView(autoApproval) } : {}),
    // F5: the pinned base commit (and any dirty-tree warning) is surfaced so the
    // operator sees exactly which snapshot the run implements against.
    baseCommit: String(startBase.baseCommit),
    coordinator: resolvedView(resolveRoleModel(cmd.coordinator)),
    ...(cmd.enableChat === true ? { planningChat: outcome.planningChat ?? { enabled: true } } : {}),
    spec: {
      specVersionId: outcome.specVersion.id,
      specHash: outcome.specVersion.contentHash,
      revision: outcome.specVersion.revision,
      rounds: outcome.rounds,
      criteria: outcome.specVersion.criteria.map((c) => ({ id: c.id, description: c.description })),
      proposedImplementor: outcome.spec.proposedImplementorProfile,
      proposedVerifier: outcome.spec.proposedVerifierProfile,
      document: outcome.canonicalSpec,
    },
  };
  const text = [
    `run ${runId} coordinated (phase ${st.phase}).`,
    `coordinator: ${describeSpec(cmd.coordinator)} drafted spec ${outcome.specVersion.id} (rev ${outcome.specVersion.revision}) in ${outcome.rounds} round(s).`,
    ...(outcome.planningChat !== undefined
      ? [`planning chat: ${outcome.planningChat.viewerUrl} (${outcome.planningChat.roomCode}, closed after synthesis)`]
      : []),
    `spec hash: ${outcome.specVersion.contentHash}`,
    `acceptance criteria: ${outcome.specVersion.criteria.map((c) => String(c.id)).join(', ')}`,
    '',
    outcome.canonicalSpec,
    '',
    ...(autoApproval !== undefined
      ? autoApprovalLines(runId, autoApproval)
      : [
          `next: approve ${runId} --spec-version ${outcome.specVersion.id} --spec-hash ${outcome.specVersion.contentHash}`,
        ]),
  ].join('\n');
  return finish('start', body, text, 0);
}

// ---------------------------------------------------------------------------
// spec revise (T2 + the coordinator re-drive that completes the round; W1-F7)
// ---------------------------------------------------------------------------
/**
 * `spec revise RUN_ID --feedback TEXT`: ingest T2 (awaiting_approval →
 * specifying), then — when the flow runtime is available — COMPLETE the
 * revision round: re-drive the coordinator with the revision context (the
 * persisted prior draft + the human feedback), persist the superseding draft
 * via `saveSpecDraft`, advance `specifying → awaiting_approval`, and print the
 * new version/hash for approval (which then binds the NEW hash — W1-F3, so
 * the old approval hash is no longer valid for `run`). Without a flow runtime
 * (or with no persisted prior draft) the T2 ingest still applies, and the
 * output says explicitly that the coordinator re-run did not happen.
 */
async function handleSpecRevise(
  service: OrchestrationService,
  db: Database,
  cmd: Extract<RunCommand, { kind: 'spec_revise' }>,
  flows: CliFlowDeps | undefined,
): Promise<CommandOutput> {
  let pinnedWorkspace: Awaited<ReturnType<OrchestrationService['assertOrPinLegacyCleanWorkspace']>>;
  try {
    pinnedWorkspace = await service.assertOrPinLegacyCleanWorkspace(cmd.runId);
  } catch (error) {
    if (error instanceof WorkspaceDriftError) {
      return workspaceRefusalOutput('spec_revise', error, cmd.runId);
    }
    throw error;
  }
  const priorDraft = service.getSpecDraft(cmd.runId);
  let revised: IngestResult;
  try {
    revised = await service.reviseSpec(cmd.runId, cmd.feedback);
  } catch (error) {
    if (error instanceof WorkspaceDriftError) {
      return workspaceRefusalOutput('spec_revise', error, cmd.runId);
    }
    throw error;
  }
  if (revised.status !== 'applied') {
    return ingestOutput('spec_revise', cmd.runId, revised, {
      appliedText: `spec revise accepted; run ${cmd.runId} -> specifying (T2).`,
      rejectedHint: 'spec revise is legal only while awaiting_approval (T2).',
    });
  }
  if (flows === undefined) {
    return ingestOutput('spec_revise', cmd.runId, revised, {
      appliedText:
        `spec revise accepted; run ${cmd.runId} -> specifying (T2). The coordinator re-run is ` +
        'UNAVAILABLE in this invocation (no flow runtime injected): no new SpecVersion was drafted — ' +
        'complete the round through the shipped `harness` CLI.',
      extra: { coordinatorRerun: 'unavailable' },
    });
  }
  const meta = db.projections.get<RunMeta>(cmd.runId, RUN_META_PROJECTION)?.state;
  // Build the revision context: from the persisted prior draft (normal
  // W1-F7 path), or — W3-4 recovery, when the draft projection was LOST
  // after a completion durably committed — rebuilt from the completion ref
  // + CAS artifact, so `spec revise` re-drafts exactly as the approve/run
  // refusal hints promise.
  let revise: CoordinatorReviseContext | undefined;
  let goal = meta?.goal ?? '';
  let round = 1;
  let recovered = false;
  if (meta !== undefined && priorDraft !== undefined) {
    // Reconstruct the prior SpecVersion from the durable draft (§7: the CAS
    // artifact hash IS the spec content hash, so the artifact ref is recoverable).
    const priorVersion: SpecVersion = draftAsSpecVersion(cmd.runId, priorDraft, db.clock);
    revise = { feedback: cmd.feedback, priorVersion, priorSpecText: priorDraft.canonicalSpec };
    goal = priorDraft.goal;
    round = priorDraft.revision + 1;
  } else if (meta !== undefined) {
    const completion = service.getCoordinatorCompletion(cmd.runId);
    if (completion !== undefined) {
      const rebuilt = rebuildPriorVersionFromCompletion(db, cmd.runId, completion, db.clock);
      revise = {
        feedback: cmd.feedback,
        priorVersion: rebuilt.version,
        ...(rebuilt.text !== undefined ? { priorSpecText: rebuilt.text } : {}),
      };
      round = completion.revision + 1;
      recovered = true;
    }
  }
  if (meta === undefined || revise === undefined) {
    return ingestOutput('spec_revise', cmd.runId, revised, {
      appliedText:
        `spec revise accepted; run ${cmd.runId} -> specifying (T2), but no persisted spec draft exists ` +
        'to revise against — the coordinator re-run was skipped. Was this run created with `harness start` ' +
        '(which drafts + persists the spec)?',
      extra: { coordinatorRerun: 'skipped_no_draft' },
    });
  }

  const runner = flows.buildCoordinatorRunner({
    runId: cmd.runId,
    goal,
    coordinator: meta.coordinator,
    workspacePath: meta.workspacePath,
    // F5 (must-fix 4): the revise round binds the SAME pinned base as the run.
    baseCommit: pinnedWorkspace.pinnedSha,
    ...(meta.planningChatEnabled === true ? { enableChat: true } : {}),
    revise,
  });
  // W2-3 pending/active split: the revise round dispatches at `specifying`
  // (T2 already moved the phase — no advance to take at activation); the
  // pending round is retryable on a non-limit pin failure, and completion
  // advances `specifying → awaiting_approval` below.
  let outcome: CoordinatorOutcome;
  try {
    outcome = await service.runRole(cmd.runId, runner, meta.coordinator, meta.workspacePath, {
      round,
      completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
      inputs: JSON.stringify({
        goal,
        revise: { feedback: cmd.feedback, priorSpecVersionId: String(revise.priorVersion.id) },
      }),
    });
    await service.assertPinnedCleanWorkspace(cmd.runId);
  } catch (error) {
    if (error instanceof WorkspaceDriftError) {
      return workspaceRefusalOutput('spec_revise', error, cmd.runId);
    }
    throw error;
  }

  // W3-4: the superseding draft (revision N+1) persists BEFORE the final
  // advance — one transaction — so approve/run bind the NEW hash and a crash
  // can never leave `awaiting_approval` without it. B2 (codex F3): under
  // `approval: 'auto'` the SAME transaction also signs the SUPERSEDING draft
  // (W1-F3 rebinds the new hash, so the pre-revise approval never carries over).
  try {
    await service.completeCoordinationRound(cmd.runId, draftFromOutcome(goal, outcome));
  } catch (error) {
    if (error instanceof WorkspaceDriftError) {
      return workspaceRefusalOutput('spec_revise', error, cmd.runId);
    }
    if (error instanceof SpecApprovalRefusedError) return approvalRefusalOutput('spec_revise', error);
    throw error;
  }

  const autoApproval = autoApprovalOf(service, cmd.runId, outcome.specVersion);
  const st = service.status(cmd.runId);
  const body = {
    runId: cmd.runId,
    outcome: 'applied',
    transitionId: 'T2',
    phase: st.phase,
    uiState: st.uiState,
    ...(autoApproval !== undefined ? { approval: autoApprovalView(autoApproval) } : {}),
    ...(recovered ? { draftRecovered: true } : {}),
    ...(outcome.planningChat !== undefined ? { planningChat: outcome.planningChat } : {}),
    spec: {
      specVersionId: outcome.specVersion.id,
      specHash: outcome.specVersion.contentHash,
      revision: outcome.specVersion.revision,
      rounds: outcome.rounds,
      ...(outcome.supersedes !== undefined ? { supersedes: outcome.supersedes } : {}),
      criteria: outcome.specVersion.criteria.map((c) => ({ id: c.id, description: c.description })),
      document: outcome.canonicalSpec,
    },
  };
  const text = [
    `spec revised for run ${cmd.runId} (T2): the coordinator drafted revision ${outcome.specVersion.revision} ` +
      `(${outcome.specVersion.id})${outcome.supersedes !== undefined ? `, superseding ${outcome.supersedes}` : ''} ` +
      `in ${outcome.rounds} round(s); phase ${st.phase}.`,
    ...(outcome.planningChat !== undefined
      ? [`planning chat: ${outcome.planningChat.viewerUrl} (${outcome.planningChat.roomCode}, closed after synthesis)`]
      : []),
    ...(recovered
      ? [
          'note: the persisted draft was missing (W3-4 draft loss); the revision context was rebuilt ' +
            'from the durable completion ref + CAS artifact.',
        ]
      : []),
    `new spec hash: ${outcome.specVersion.contentHash}`,
    `acceptance criteria: ${outcome.specVersion.criteria.map((c) => String(c.id)).join(', ')}`,
    '',
    outcome.canonicalSpec,
    '',
    ...(autoApproval !== undefined
      ? autoApprovalLines(cmd.runId, autoApproval)
      : [
          `next: approve ${cmd.runId} --spec-version ${outcome.specVersion.id} --spec-hash ${outcome.specVersion.contentHash}`,
        ]),
  ].join('\n');
  return finish('spec_revise', body, text, 0);
}

// ---------------------------------------------------------------------------
// approve (explicit human approval; B2's `approval: 'auto'` is the engine
// signing the same drafted hash through the same validation — see
// `autoApproveDraftedSpec`. §4.1/§18)
// ---------------------------------------------------------------------------
async function handleApprove(
  service: OrchestrationService,
  cmd: Extract<RunCommand, { kind: 'approve' }>,
  env: NodeJS.ProcessEnv,
): Promise<CommandOutput> {
  try {
    await service.assertOrPinLegacyCleanWorkspace(cmd.runId);
  } catch (error) {
    if (error instanceof WorkspaceDriftError) {
      return workspaceRefusalOutput('approve', error, cmd.runId);
    }
    throw error;
  }
  const applyApproval = async (
    input: Parameters<OrchestrationService['approve']>[1],
    text: IngestText,
  ): Promise<CommandOutput> => {
    try {
      return ingestOutput('approve', cmd.runId, await service.approve(cmd.runId, input), text);
    } catch (error) {
      if (error instanceof WorkspaceDriftError) {
        return workspaceRefusalOutput('approve', error, cmd.runId);
      }
      // The SERVICE is the approval gate (codex F1/F2). Its refusal — including
      // one that only becomes true between these CLI pre-checks and the T1
      // transaction — is reported, not crashed on.
      if (error instanceof SpecApprovalRefusedError) return approvalRefusalOutput('approve', error);
      throw error;
    }
  };
  // W1-F3: approval BINDS execution to the drafted spec. When `start` (or a
  // completed revise round) persisted a draft, the approved hash MUST be that
  // draft's hash — a supplied --spec-hash is validated against it, an omitted
  // one binds it, and the fabricated test-approve hash is dead whenever a
  // real draft exists. These are EARLY, friendlier renderings of checks the
  // service re-runs authoritatively inside the approving transaction.
  const draft = service.getSpecDraft(cmd.runId);

  // W3-4: the durable completion ref proves a draft WAS persisted; a
  // missing/stale projection is damage — refuse (both human and test
  // approve: a lost draft must never fall through to the explicit-hash or
  // synthetic-hash paths) and point at the recovery.
  const loss = detectDraftLoss(service, cmd.runId, draft);
  if (loss !== undefined) return draftLossRefusal('approve', cmd.runId, draft, loss);

  if (cmd.testApprove) {
    if (env.HARNESS_TEST_MODE !== '1') {
      const text =
        'refusing --test-approve: HARNESS_TEST_MODE=1 is not set. The production approval paths are ' +
        "explicit human approval (the default) and, on a run pinned approval:'auto', the engine " +
        'signing the REAL drafted hash (PLAN §4.1/§7.1/§18). --test-approve is neither: it exists ' +
        'solely for automated acceptance runs, and it alone may bind a synthetic hash.';
      return finish('approve', { runId: cmd.runId, refused: 'test_approve_guard', detail: text }, text, 2);
    }
    // Bind the REAL draft hash when a draft exists (W1-F3); the synthetic
    // hash remains only for pure-unit runs that never drafted a spec.
    const hash = draft?.specHash ?? cmd.specHash ?? toSpecHash(`test-approve:${cmd.specVersionId}`);
    return applyApproval({ specVersionId: cmd.specVersionId, specHash: hash }, {
      appliedText: `TEST approval applied (HARNESS_TEST_MODE=1) for ${cmd.specVersionId} [hash ${hash}]; run -> approved.`,
      rejectedHint: 'approval is legal only while awaiting_approval (T1).',
      extra: { specVersionId: cmd.specVersionId, specHash: hash, mode: 'test' },
    });
  }

  if (draft !== undefined) {
    if (cmd.specHash !== undefined && cmd.specHash !== draft.specHash) {
      const text =
        `refusing approve: --spec-hash ${cmd.specHash} does not match the drafted spec's hash ` +
        `${draft.specHash} (W1-F3: approval binds the exact SpecVersion the run will implement). ` +
        'Re-read the draft (`harness start`/`spec revise` output) and approve its hash.';
      return finish(
        'approve',
        {
          runId: cmd.runId,
          refused: 'approved_hash_mismatch',
          providedSpecHash: cmd.specHash,
          draftSpecHash: draft.specHash,
          detail: text,
        },
        text,
        2,
      );
    }
    if (cmd.specVersionId !== draft.specVersionId) {
      const text =
        `refusing approve: --spec-version ${cmd.specVersionId} does not match the drafted spec's version ` +
        `${draft.specVersionId} (W1-F3: approval binds the exact SpecVersion the run will implement).`;
      return finish(
        'approve',
        {
          runId: cmd.runId,
          refused: 'approved_version_mismatch',
          providedSpecVersionId: cmd.specVersionId,
          draftSpecVersionId: draft.specVersionId,
          detail: text,
        },
        text,
        2,
      );
    }
    const hash = cmd.specHash ?? draft.specHash; // omitted --spec-hash binds the draft hash
    return applyApproval({ specVersionId: cmd.specVersionId, specHash: hash }, {
      appliedText: `approved ${cmd.specVersionId} [hash ${hash}]; run -> approved.`,
      rejectedHint: 'approval is legal only while awaiting_approval (T1).',
      extra: { specVersionId: cmd.specVersionId, specHash: hash, mode: 'human' },
    });
  }

  if (cmd.specHash === undefined) {
    const text =
      'approve requires --spec-hash HASH binding the exact SpecVersion (§6.3): this run has no ' +
      'persisted spec draft to resolve a hash from. Pass --spec-hash, or use --test-approve ' +
      '(HARNESS_TEST_MODE=1) for automated acceptance.';
    return finish('approve', { runId: cmd.runId, error: 'spec_hash_required', detail: text }, text, 2);
  }
  return applyApproval({ specVersionId: cmd.specVersionId, specHash: cmd.specHash }, {
    appliedText: `approved ${cmd.specVersionId} [hash ${cmd.specHash}]; run -> approved.`,
    rejectedHint: 'approval is legal only while awaiting_approval (T1).',
    extra: { specVersionId: cmd.specVersionId, specHash: cmd.specHash, mode: 'human' },
  });
}

// ---------------------------------------------------------------------------
// run (resolve the implementor/verifier plan for the approved spec)
// ---------------------------------------------------------------------------
async function handleRun(
  service: OrchestrationService,
  cmd: Extract<RunCommand, { kind: 'run' }>,
  flows: CliFlowDeps | undefined,
): Promise<CommandOutput> {
  const st = service.status(cmd.runId);
  if (st.phase !== 'approved') {
    const hint =
      st.phase === 'awaiting_approval'
        ? ` approve it first: \`harness approve ${cmd.runId} --spec-version ID --spec-hash HASH\`.`
        : st.phase === 'needs_remediation'
          ? ' remediation re-entry is not yet a CLI entry point; the implement→verify loop starts from `approved`.'
          : '';
    const text = `run requires an approved spec; run ${cmd.runId} is at '${st.phase}'.${hint}`;
    return finish('run', { runId: cmd.runId, phase: st.phase, error: 'not_approved', detail: text }, text, 1);
  }
  const draft = service.getSpecDraft(cmd.runId);
  if (draft === undefined) {
    // W3-4: distinguish "never drafted" from "drafted, durably completed,
    // projection lost" — the completion ref makes the loss detectable and
    // the refusal carries the recovery hint.
    const loss = detectDraftLoss(service, cmd.runId, draft);
    const text =
      loss !== undefined
        ? `run ${cmd.runId}: the spec draft is MISSING — the event log records a completed drafting round ` +
          `(spec ${loss.completion.specVersionId}, hash ${loss.completion.specHash}) but the draft ` +
          `projection is gone (W3-4); the implement→verify loop cannot reconstruct its input. ` +
          draftLossRecoveryHint(cmd.runId)
        : `run ${cmd.runId}: no drafted spec found — the implement→verify loop needs the approved spec ` +
          'document/criteria. Was this run created with `harness start` (which drafts + persists the spec)?';
    return finish(
      'run',
      {
        runId: cmd.runId,
        phase: st.phase,
        error: 'spec_draft_missing',
        ...(loss !== undefined
          ? {
              completionSpecHash: String(loss.completion.specHash),
              completionSpecVersionId: String(loss.completion.specVersionId),
            }
          : {}),
        detail: text,
      },
      text,
      1,
    );
  }
  // W1-F3: execution binds to the APPROVED spec — the hash the engine bound at
  // T1 must equal the draft this loop is about to inject. Drift (e.g. a
  // superseding draft persisted after approval) refuses instead of silently
  // implementing a document no human approved.
  if (st.approvedSpecHash === undefined || st.approvedSpecHash !== draft.specHash) {
    const text =
      `run ${cmd.runId}: the approved spec hash ${st.approvedSpecHash ?? '(none)'} does not match the ` +
      `drafted spec's hash ${draft.specHash} — the draft superseded the approval (or approval never bound ` +
      'a hash). Approve the current draft first (W1-F3).';
    return finish(
      'run',
      {
        runId: cmd.runId,
        phase: st.phase,
        error: 'approved_spec_mismatch',
        approvedSpecHash: st.approvedSpecHash ?? null,
        draftSpecHash: draft.specHash,
        detail: text,
      },
      text,
      1,
    );
  }
  // B2 (codex F5): the §16 report must state WHO signed, from the event log.
  // `status()` resolves a pre-B2 approval to 'human' at the one legacy point,
  // so an approved run always has a signer; its absence here would mean the
  // engine bound a hash without folding a signer — an invariant violation, so
  // refuse loudly rather than pick a value and print a possible lie.
  const specApprovedBy = st.specApprovedBy;
  if (specApprovedBy === undefined) {
    const text =
      `run ${cmd.runId}: the engine bound approved spec hash ${st.approvedSpecHash} but recorded NO ` +
      'approval signer. The merge-readiness report could not state whether a human reviewed this spec, ' +
      'and the harness will not guess. This is an engine invariant violation (B2) — report it.';
    return finish(
      'run',
      { runId: cmd.runId, phase: st.phase, error: 'approval_signer_missing', detail: text },
      text,
      1,
    );
  }
  // F9: the stable CLI contract (PLAN §18) is that `run`'s implementor/verifier
  // DEFAULT to the approved spec draft's proposed profiles (persisted from the
  // coordinator round). An explicit flag always overrides. We refuse ONLY when a
  // role has NEITHER an explicit flag NOR a usable (parseable) proposed profile.
  const implementor = resolveRunProfile(cmd.implementor, draft.proposedImplementorProfile);
  const verifier = resolveRunProfile(cmd.verifier, draft.proposedVerifierProfile);
  if (isErr(implementor) || isErr(verifier)) {
    const problems = [
      isErr(implementor) ? `--implementor (${implementor.error})` : undefined,
      isErr(verifier) ? `--verifier (${verifier.error})` : undefined,
    ].filter((v): v is string => v !== undefined);
    const text =
      `run needs a usable ${problems.join(' and ')}: pass the profile flag explicitly, or have the ` +
      `approved spec propose a resolvable one. The approved spec proposed ` +
      `implementor='${draft.proposedImplementorProfile}', verifier='${draft.proposedVerifierProfile}'.`;
    return finish('run', { runId: cmd.runId, phase: st.phase, error: 'missing_profiles', detail: text }, text, 2);
  }
  const implementorSpec = implementor.value;
  const verifierSpec = verifier.value;
  if (flows === undefined) {
    const text =
      'run cannot drive the implement→verify loop: the flow runtime is not configured. ' +
      'This is an internal wiring error — the `harness` runtime must provide the P3 flow runtime.';
    return finish('run', { runId: cmd.runId, phase: st.phase, error: 'flows_unavailable', detail: text }, text, 2);
  }
  if (st.workspacePath === undefined) {
    const text = `run ${cmd.runId}: no workspace path recorded for this run.`;
    return finish('run', { runId: cmd.runId, phase: st.phase, error: 'workspace_missing', detail: text }, text, 1);
  }

  // DRIVE the post-approval loop through the service + orchestrator: approved →
  // implement (isolated worktree) → verify → (bounded remediation) →
  // merge_ready | failed. One assignment/worktree per run, derived from runId.
  const asg = assignmentId(`asg_${cmd.runId}`);
  const worktrees = await flows.openWorktrees(st.workspacePath);
  // F5: branch from the run's PINNED base commit (start-time HEAD). A LEGACY run
  // (created before base-at-start pinning) is pinned ONCE here from current HEAD
  // with an audited `run.base_commit.pinned` (transactional). must-fix 4: REFUSE
  // (never a silent live-HEAD fallback) if no base can be established — the loop
  // requires an immutable base for every fresh worktree.
  let baseCommit = service.getRunBaseCommit(cmd.runId);
  if (baseCommit === undefined) {
    let resolved: GitSha;
    try {
      resolved = gitSha(await git.resolveSha(st.workspacePath, 'HEAD'));
    } catch {
      const text =
        `run: run ${cmd.runId} has no pinned base and workspace '${st.workspacePath}' HEAD ` +
        `cannot be resolved (not a git repository, or no commit) — cannot run without an ` +
        `immutable base (F5).`;
      return finish('run', { runId: cmd.runId, error: 'base_unpinnable', detail: text }, text, 2);
    }
    service.pinRunBaseCommit(cmd.runId, resolved); // one-time audited legacy pin (transactional)
    baseCommit = resolved;
  }
  let result: ImplementVerifyLoopResult;
  try {
    await service.assertPinnedCleanWorkspace(cmd.runId);
    result = await runImplementVerifyLoop(
      { service, worktrees, ids: flows.ids, clock: flows.clock },
      {
        runId: cmd.runId,
        assignmentId: asg,
        baseCommit,
        implementor: implementorSpec,
        verifier: verifierSpec,
        specHash: draft.specHash,
        // B2: WHO signed the approval this loop implements — the run's ACTUAL
        // T1 fold, never config, reported on the §16 merge-readiness record.
        // `specApprovedBy` is present whenever `approvedSpecHash` is (the
        // refusal above already proved that), and the value is required all the
        // way down (codex F5) so it cannot silently become 'human'.
        specApprovedBy,
        specDocument: draft.canonicalSpec,
        goal: draft.goal,
        taskScope: `Implement the approved specification end to end: ${draft.goal}`,
        criteria: draft.criteria,
        evidence: flows.evidence,
        // B3: `--in-place` is the ONLY way an operator reaches the non-default
        // mode, and it is passed only when they asked for it — an omitted flag
        // never becomes an explicit `'worktree'`, so the loop's own default (and
        // every existing test asserting it) is untouched.
        ...(cmd.inPlace === true ? { executionMode: 'in_place' as const } : {}),
        // B5: the decomposition comes from the APPROVED spec's canonical bytes —
        // the exact bytes `approvedSpecHash` binds — so the fan-out that runs is
        // provably the fan-out a human (or the pinned auto-approval) signed.
        ...(() => {
          const assignments = approvedSpecAssignments(draft.canonicalSpec);
          return assignments.length > 0 ? { assignments } : {};
        })(),
        ...(flows.runVerification !== undefined ? { runVerificationCommands: flows.runVerification } : {}),
      },
    );
  } catch (error) {
    if (error instanceof WorkspaceDriftError) return workspaceRefusalOutput('run', error, cmd.runId);
    throw error;
  }

  return loopResultOutput('run', service, cmd.runId, result, implementorSpec, verifierSpec);
}

/**
 * B5 — the approved decomposition, read from the CANONICAL SPEC BYTES.
 *
 * Those bytes are what `approvedSpecHash` binds (`canonicalizeSpec` emits
 * `assignments` into them), so reading the fan-out from here means the
 * decomposition that executes is the decomposition that was approved. Reading it
 * from a separate projection would have introduced a second source that could
 * disagree with the hash — and a decomposition that is not hash-bound makes the
 * approval-time R1 gate advisory.
 *
 * TOTAL: unparseable bytes, a missing/!array `assignments`, or an entry missing
 * the fields the driver needs all yield NO decomposition — i.e. today's
 * single-implementor run. A spec written before B4 has no `assignments` at all,
 * and that absence is not an error (rule 9); it is the status quo.
 */
export function approvedSpecAssignments(canonicalSpec: string): readonly LoopAssignment[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(canonicalSpec);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object') return [];
  const raw = (parsed as { assignments?: unknown }).assignments;
  if (!Array.isArray(raw)) return [];
  const assignments: LoopAssignment[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return [];
    const candidate = entry as { id?: unknown; taskScope?: unknown; writeScope?: unknown };
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) return [];
    if (typeof candidate.taskScope !== 'string' || candidate.taskScope.length === 0) return [];
    const writeScope = Array.isArray(candidate.writeScope)
      ? candidate.writeScope.filter((path): path is string => typeof path === 'string')
      : [];
    assignments.push({ id: candidate.id, taskScope: candidate.taskScope, writeScope });
  }
  return assignments;
}

/**
 * F9: resolve a `run` role profile — an explicit `--implementor`/`--verifier`
 * flag always wins; otherwise DEFAULT to the approved spec draft's proposed
 * profile token, parsed the same way the flag would be. Returns an `Err` (with
 * the reason) only when no flag was given AND the proposed token is not a
 * resolvable `harness[:model[:effort]]`.
 */
function resolveRunProfile(
  flag: RoleModelSpec | undefined,
  proposed: string,
): Result<RoleModelSpec, string> {
  if (flag !== undefined) return ok(flag);
  return parseRoleProfile({ profile: proposed });
}

/** Shared renderer for an implement→verify loop result — `run` and the W2-5
 * resume re-entry produce byte-identical surfaces. */
function loopResultOutput(
  kind: string,
  service: OrchestrationService,
  runId: RunId,
  result: ImplementVerifyLoopResult,
  implementor: RoleModelSpec,
  verifier: RoleModelSpec,
): CommandOutput {
  const mr = result.mergeReadiness;
  const body = {
    runId,
    phase: result.finalPhase,
    uiState: service.status(runId).uiState,
    outcome: result.outcome,
    rounds: result.rounds.length,
    implementationCommit: String(result.implementationCommit),
    worktreePath: result.worktree.worktreePath,
    // B3: WHICH mode actually ran, from the handle the loop returned — never
    // from the flag that was asked for. In `in_place` the "worktreePath" IS the
    // operator's checkout, and a reader who cannot tell the two apart cannot
    // tell whether that path is a scratch directory or their own tree.
    executionMode: result.worktree.executionMode,
    warnings: result.warnings,
    plan: {
      implementor: resolvedView(resolveRoleModel(implementor)),
      verifier: resolvedView(resolveRoleModel(verifier)),
    },
    ...(mr !== undefined ? { mergeReadiness: mergeReadinessView(mr) } : {}),
    ...(result.provisioningFailure !== undefined
      ? { provisioningFailure: provisioningFailureView(result.provisioningFailure) }
      : {}),
  };
  const lines = [
    `run ${runId} — ${result.outcome} (phase ${result.finalPhase}) after ${result.rounds.length} round(s).`,
    `  implementor: ${describeSpec(implementor)}`,
    `  verifier:    ${describeSpec(verifier)}`,
    `  implementation commit: ${String(result.implementationCommit)}`,
    `  execution mode: ${result.worktree.executionMode}`,
    `  worktree: ${result.worktree.worktreePath}`,
  ];
  if (result.inPlaceHeadRestored === false) {
    lines.push(
      `  WARNING: the checkout is still on ${result.worktree.branch} — restoring your original HEAD failed ` +
        '(git refuses to switch away from a dirty tree). Inspect and switch back manually.',
    );
  }
  for (const warning of result.warnings) lines.push(`  warning: ${warning}`);
  if (mr !== undefined) {
    lines.push(`  merge-readiness: ${mr.ready ? 'READY' : 'NOT READY'} (§16 — the harness never merges).`);
    lines.push(...autoApprovalMergeNotice(mr));
    for (const command of mr.manualIntegrationCommands) lines.push(`    ${command}`);
  }
  // W2-2 `integration_blocked`: criteria verified, ONLY user-actionable §16
  // blockers remain — no remediation round was consumed and the run REMAINS
  // in `verifying`. Print the blockers + the exact manual commands (above)
  // and the recheck instruction, with the distinct exit code.
  if (result.outcome === 'integration_blocked' && mr !== undefined) {
    lines.push(`  integration blocked on user-actionable §16 state (no remediation round consumed):`);
    for (const blocker of mr.blockers) lines.push(`    - ${blocker}`);
    lines.push(`  next: resolve the blockers, then \`harness recheck ${runId}\` (T24 once clear).`);
  }
  // F7: the round HALTED because worktree dependency provisioning could not be
  // proven — an operator-actionable ENVIRONMENT failure (no verifier ran, no
  // merge_ready possible). Print the repo, the worktree, and the failure detail.
  if (result.outcome === 'provisioning_failed' && result.provisioningFailure !== undefined) {
    const pf = result.provisioningFailure;
    lines.push(
      `  provisioning failed — worktree dependencies could not be provisioned; verification did not run:`,
      ...(pf.round !== undefined ? [`    round:    ${pf.round}`] : []),
      `    repo:     ${pf.repoRoot}`,
      `    worktree: ${pf.worktreePath}`,
      ...(pf.implementationCommit !== undefined ? [`    commit:   ${String(pf.implementationCommit)}`] : []),
      ...(pf.cause !== undefined ? [`    cause:    ${pf.cause}`] : []),
      `    detail:   ${pf.detail}`,
      `  next: ${provisioningNextHint(pf.cause)}`,
    );
  }
  const exitCode =
    result.outcome === 'merge_ready'
      ? 0
      : result.outcome === 'integration_blocked'
        ? EXIT_INTEGRATION_BLOCKED
        : 1;
  return finish(kind, body, lines.join('\n'), exitCode);
}

/**
 * F9 — the operator's NEXT STEP, chosen by the refusal's cause code. The pre-F9
 * text was a single generic line ("ensure the primary checkout's node_modules is
 * installed and node_modules is git-ignored"), which is actively misleading for
 * the two commonest causes: it tells someone whose IMPLEMENTOR added a dependency
 * to reinstall the primary (which cannot help), and says nothing at all about a
 * present-but-unbuilt native toolchain. Unknown/absent causes (the pre-F9
 * refusals, which keep their prose detail) fall back to the generic hint.
 */
function provisioningNextHint(cause: ProvisioningCause | undefined): string {
  switch (cause) {
    case 'primary_tree_stale':
      return 'run `npm install` in the primary checkout (its node_modules does not match its own manifests), then re-run.';
    case 'native_toolchain_unproven':
      return (
        'a dependency with a native build step is present but was never built. Run `npm install` (NOT ' +
        '`--ignore-scripts`) in the primary checkout so its lifecycle scripts compile the bindings, verify with ' +
        '`node -e "require(\'<package>\')"`, then re-run.'
      );
    case 'unsafe_clone_symlinks':
      return (
        "the primary checkout's node_modules contains absolute or escaping symlinks; remove and reinstall it " +
        '(`rm -rf node_modules && npm install`), then re-run.'
      );
    case 'install_failed':
      return (
        'the dependency install for this round failed — check the npm output above, that the committed manifests ' +
        'are installable, and that the host can reach the registry, then re-run.'
      );
    case 'clone_unsupported':
      return (
        'this host cannot copy-on-write clone (no APFS `cp -c`), and there is no install lane. Set ' +
        "worktree.provision='none' and provision each worktree's node_modules yourself."
      );
    case 'clone_failed':
      return (
        'the clone itself failed — check free space and that the worktree base dir is on the SAME filesystem as ' +
        'the primary checkout, then re-run.'
      );
    case 'provisioning_timeout':
      return 'a provisioning command exceeded its deadline; check for a stalled npm/git process, then re-run.';
    case 'quarantine_cap_reached':
      return (
        'repeated provisioning timeouts have left this assignment at its quarantined-stage cap, and those stages are ' +
        'not deleted while a stalled command may still be writing into them. Kill any stalled npm/git/cp process for ' +
        'this assignment, then re-run; the stages are released automatically 24h after quarantine.'
      );
    default:
      return "ensure the primary checkout's node_modules is installed and node_modules is git-ignored, then re-run.";
  }
}

/**
 * The STABLE JSON projection of a provisioning failure. Sibling of
 * `mergeReadinessView`, extracted so the payload is asserted directly.
 *
 * ROUND 6 (Finding 4): `cause` is part of it. The closed cause vocabulary exists
 * for MACHINE consumption — omitting it here forced JSON consumers (the future
 * UI included) to parse the human prose in `detail` to recover what the text
 * renderer already had.
 */
export function provisioningFailureView(pf: ProvisioningFailure): Record<string, unknown> {
  return {
    repoRoot: pf.repoRoot,
    worktreePath: pf.worktreePath,
    ...(pf.cause !== undefined ? { cause: pf.cause } : {}),
    detail: pf.detail,
    ...(pf.round !== undefined ? { round: pf.round } : {}),
    ...(pf.implementationCommit !== undefined
      ? { implementationCommit: String(pf.implementationCommit) }
      : {}),
  };
}

function mergeReadinessView(mr: MergeReadiness): Record<string, unknown> {
  return {
    ready: mr.ready,
    verifiedCommit: String(mr.verifiedCommit),
    baseCommit: String(mr.baseCommit),
    specHash: String(mr.specHash),
    resolvedHarnesses: mr.resolvedHarnesses,
    destinationClean: mr.destinationClean,
    worktreeClean: mr.worktreeClean,
    baseDrifted: mr.baseDrifted,
    conflicts: mr.conflicts,
    requiredTestsPassed: mr.requiredTestsPassed,
    evidenceReceiptRefs: mr.evidenceReceiptRefs.map(String),
    // B2: the human about to merge is told WHO approved the intent.
    specApprovedBy: mr.specApprovedBy,
    blockers: mr.blockers,
    manualIntegrationCommands: mr.manualIntegrationCommands,
  };
}

/**
 * B2: the merge-reviewer's warning line, emitted whenever the spec this commit
 * implements was signed by the ENGINE. Deliberately not a blocker — the run can
 * be fully merge-ready — but the reviewer must not have to dig for the fact
 * that nobody reviewed the intent. Empty for a human-approved run.
 */
function autoApprovalMergeNotice(mr: MergeReadiness): string[] {
  if (mr.specApprovedBy === 'auto') {
    return [
      `  spec approval: AUTO — the ENGINE approved this spec (spec.approved {approvedBy:'auto'}); ` +
        `NO human reviewed the intent. Review WHAT was built, not only that it verified.`,
    ];
  }
  // B2 round 4: a report migrated from an older persisted record whose signer
  // the event log cannot substantiate. Louder than the auto notice on purpose —
  // "we cannot tell you who approved this" is worse news than "the engine did".
  if (mr.specApprovedBy === 'unknown') {
    return [
      `  spec approval: UNKNOWN — this readiness record predates event-derived attribution and the ` +
        `event log cannot substantiate who approved the spec. Do NOT assume a human did. Verify the ` +
        `intent yourself before merging.`,
    ];
  }
  return [];
}

// ---------------------------------------------------------------------------
// recheck (W2-2: re-probe §16 readiness for a merge.readiness.blocked run)
// ---------------------------------------------------------------------------
/**
 * `harness recheck RUN_ID`: re-run ONLY the §16 git probe against the SAME
 * immutable Verification/binding a `merge.readiness.blocked` round persisted
 * (`MERGE_READINESS_BLOCKED_PROJECTION`). The worktree is §16.3-re-validated
 * FIRST (reattach in a fresh process, stale-lock cleanup, HEAD readable —
 * `worktreeClean` is then RE-PROBED by the probe itself, never carried);
 * ready → T24 is ingested NOW (run → `merge_ready`); still blocked → an
 * updated blocked event + read-model, exit `EXIT_INTEGRATION_BLOCKED`. A
 * wrong-commit probe result is the typed `MergeReadinessCommitMismatchError`
 * (the tree moved under us — loud, exit 1 via the error path).
 */
async function handleRecheck(
  service: OrchestrationService,
  cmd: Extract<RunCommand, { kind: 'recheck' }>,
  flows: CliFlowDeps | undefined,
): Promise<CommandOutput> {
  const blocked = service.getMergeReadinessBlocked(cmd.runId);
  if (blocked === undefined || blocked.stage !== 'blocked') {
    const text =
      blocked === undefined
        ? `recheck ${cmd.runId}: no blocked §16 merge-readiness is recorded for this run — recheck ` +
          'applies only after a verification round ended integration_blocked (merge.readiness.blocked).'
        : `recheck ${cmd.runId}: the blocked §16 merge-readiness was already resolved (T24 ingested); ` +
          'nothing to recheck.';
    return finish(
      'recheck',
      { runId: cmd.runId, error: blocked === undefined ? 'not_blocked' : 'already_resolved', detail: text },
      text,
      1,
    );
  }
  const st = service.status(cmd.runId);
  if (st.phase !== 'verifying') {
    const text =
      `recheck ${cmd.runId}: the run is at phase '${st.phase}', not 'verifying' — the blocked round's ` +
      'wait state no longer holds (the run moved on).';
    return finish('recheck', { runId: cmd.runId, phase: st.phase, error: 'not_verifying', detail: text }, text, 1);
  }
  if (flows === undefined) {
    const text =
      'recheck cannot re-probe §16 readiness: the flow runtime is not configured. ' +
      'This is an internal wiring error — the `harness` runtime must provide the P3 flow runtime.';
    return finish('recheck', { runId: cmd.runId, error: 'flows_unavailable', detail: text }, text, 2);
  }
  if (st.workspacePath === undefined) {
    const text = `recheck ${cmd.runId}: no workspace path recorded for this run.`;
    return finish('recheck', { runId: cmd.runId, error: 'workspace_missing', detail: text }, text, 1);
  }
  // B2 (codex F5): same rule as `run` — the rebuilt §16 report must state the
  // event-derived signer, and a missing one is refused, never defaulted.
  const specApprovedBy = st.specApprovedBy;
  if (specApprovedBy === undefined) {
    const text =
      `recheck ${cmd.runId}: the run is verifying but records NO approval signer, so the rebuilt ` +
      'merge-readiness report could not state whether a human reviewed this spec. This is an engine ' +
      'invariant violation (B2) — report it.';
    return finish(
      'recheck',
      { runId: cmd.runId, error: 'approval_signer_missing', detail: text },
      text,
      1,
    );
  }

  // §16.3 FIRST: adopt the worktree through the manager (mutex + validation)
  // before any probe — a fresh CLI process reattaches from the persisted
  // blocked state; the same-process path revalidates the tracked handle.
  const asg = blocked.binding.assignmentId;
  const worktrees = await flows.openWorktrees(st.workspacePath);
  let reattached = false;
  try {
    if (worktrees.handleFor(asg) === undefined) {
      const branch = blocked.binding.worktreeBranch;
      if (branch === undefined) {
        const text =
          `recheck ${cmd.runId}: the persisted blocked state carries no worktree branch — cannot ` +
          'reattach the implementation worktree for §16.3 validation.';
        return finish('recheck', { runId: cmd.runId, error: 'worktree_branch_missing', detail: text }, text, 1);
      }
      await worktrees.reattach({
        assignmentId: asg,
        worktreePath: blocked.worktreePath,
        branch,
        baseSha: blocked.binding.baseCommit,
      });
      reattached = true;
    }
    const validation = await worktrees.validate(asg);
    if (validation.outcome === 'refuse_resume') {
      const text =
        `recheck ${cmd.runId}: §16.3 worktree validation refused — ${validation.detail} ` +
        'Resolve the worktree state before rechecking.';
      return finish(
        'recheck',
        { runId: cmd.runId, error: 'worktree_validation_refused', detail: validation.detail },
        text,
        1,
      );
    }

    // Re-run ONLY the git probe, rebuilt from the persisted geometry against
    // the SAME immutable Verification/binding (worktreeClean re-probed).
    const probe = gitMergeReadinessProbe({
      repoRoot: blocked.binding.repoRoot ?? worktrees.primaryRepoRoot,
      worktreePath: blocked.worktreePath,
      baseCommit: blocked.binding.baseCommit,
      verifiedCommit: blocked.verification.implementationCommit,
      destinationRef: blocked.probeDestinationRef,
    });
    const result = await recheckMergeReadiness({
      engine: service,
      runId: cmd.runId,
      blocked,
      probe,
      // B2 (codex F5): event-derived, re-read here rather than carried on the
      // persisted blocked record — a fresh process must not be able to report
      // 'human' just because an older build wrote the record. Guarded above,
      // never defaulted: there is exactly ONE place a missing signer resolves.
      specApprovedBy,
      ids: flows.ids,
      clock: flows.clock,
    });

    const phase = service.status(cmd.runId).phase;
    const mr = result.mergeReadiness;
    const body = {
      runId: cmd.runId,
      outcome: result.outcome,
      phase,
      blockers: mr.blockers,
      // One projection for both readiness surfaces (`run` and `recheck`) — the
      // recheck copy was a field-for-field duplicate of `mergeReadinessView`,
      // so B2's `specApprovedBy` (and anything after it) cannot reach one
      // surface and silently miss the other.
      mergeReadiness: mergeReadinessView(mr),
    };
    if (result.outcome === 'ready') {
      if (result.transition.status !== 'applied') {
        const detail =
          result.transition.status === 'rejected' ? result.transition.detail : 'unexpected ingest outcome';
        const text = `recheck ${cmd.runId}: readiness is clear but the T24 ingest was rejected — ${detail}`;
        return finish('recheck', { ...body, error: 't24_rejected', detail }, text, 1);
      }
      const lines = [
        `recheck ${cmd.runId} — READY: §16 blockers cleared; T24 ingested, run -> ${phase}.`,
        `  merge-readiness: READY (§16 — the harness never merges).`,
        ...autoApprovalMergeNotice(mr),
      ];
      for (const command of mr.manualIntegrationCommands) lines.push(`    ${command}`);
      return finish('recheck', body, lines.join('\n'), 0);
    }
    const lines = [
      `recheck ${cmd.runId} — STILL BLOCKED (run remains in 'verifying'; no remediation round consumed).`,
      ...autoApprovalMergeNotice(mr),
      `  blockers:`,
    ];
    for (const blocker of mr.blockers) lines.push(`    - ${blocker}`);
    for (const command of mr.manualIntegrationCommands) lines.push(`    ${command}`);
    lines.push(`  next: resolve the blockers, then \`harness recheck ${cmd.runId}\` again.`);
    return finish('recheck', body, lines.join('\n'), EXIT_INTEGRATION_BLOCKED);
  } finally {
    // Reattach acquires the lease; recheck is read-only — never leave it held.
    if (reattached) {
      try {
        worktrees.releaseLease(asg);
      } catch {
        /* lease bookkeeping is best-effort on the read-only path */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// W2-5 — limit-pause policy handler, schedule loop, resume re-entry
// ---------------------------------------------------------------------------
function resumeRefusedOutput(kind: string, error: ResumeEligibilityError): CommandOutput {
  const text =
    `resume refused for run ${error.runId} (${error.reason}): ${error.detail}\n` +
    'The suspension is unchanged — a superseded spec can never resurrect an old round (W2-5).';
  return finish(kind, { runId: error.runId, refused: error.reason, detail: error.detail }, text, 1);
}

/** Merge extra json keys into an already-built output (e.g. orphan-reap facts). */
function withExtraJson(output: CommandOutput, extra: Record<string, unknown>): CommandOutput {
  return Object.keys(extra).length === 0 ? output : { ...output, json: { ...output.json, ...extra } };
}

/**
 * `harness resume RUN_ID` (W2-5): §14 startup cleanup, then reclaim any
 * unacknowledged pending re-entry, then — by suspension — the
 * eligibility-checked T9/T12 and the immediate re-entry attempt. `--wait`
 * runs the probe schedule loop instead of an immediate manual T9.
 */
async function handleResume(
  service: OrchestrationService,
  db: Database,
  cmd: Extract<RunCommand, { kind: 'resume' }>,
  deps: CommandDeps,
): Promise<CommandOutput> {
  // W2-6 (§14/§12.3): startup cleanup BEFORE re-entry — reap
  // identity-VERIFIED orphans from the durable registry and reconcile
  // any committed stop-intent whose confirmation the crash swallowed.
  // Ambiguous identities are never signaled (durable
  // `process.identity.alert` events carry the withholds).
  const reap = service.reapOrphanProcesses();
  const reapExtra =
    reap.entries.length > 0
      ? {
          orphanReap: {
            signalSent: reap.signalSentCount,
            exitPending: reap.exitPendingCount,
            confirmedGone: reap.confirmedGoneCount,
            withheld: reap.skippedCount,
          },
        }
      : {};
  const thisRunExitPending = reap.entries.some(
    (entry) =>
      (entry.action === 'signal_sent' || entry.action === 'exit_pending') &&
      entry.runId === cmd.runId,
  );
  if (thisRunExitPending) {
    return withExtraJson(
      finish(
        'resume',
        { runId: cmd.runId, outcome: 'orphan_exit_pending' },
        `run ${cmd.runId}: orphan cleanup is pending; process-tree exit is not yet confirmed. ` +
          'No re-entry was started; retry `harness resume` after the process tree is absent.',
        1,
      ),
      reapExtra,
    );
  }

  const st = service.status(cmd.runId);
  // W2-5 startup reclaim: T9/T12 already landed but the process died before
  // the round re-entered — drive the unacknowledged pending re-entry now,
  // idempotently (the ack lands inside runRole when the round goes active).
  // W4-4 / review-6 F2: GATED on §14 owner-liveness like every other resume
  // carve-out — an unacknowledged pending re-entry can be double-driven too, so
  // if a still-alive PEER orchestrator owns this run, WITHHOLD (the owner carries
  // it; a later resume after that owner dies reclaims the stale lease).
  if (
    st.suspension === 'none' &&
    st.resumeReentryPending !== undefined &&
    !service.isRunClaimedByLiveProcess(cmd.runId)
  ) {
    return withExtraJson(await driveReentry(service, db, 'resume', cmd.runId, deps), reapExtra);
  }
  // W3-4: an UNSUSPENDED run stranded mid-coordination — a crash before the
  // durable draft+advance completion committed (phase still `specifying`),
  // or a typed pin failure that left the W2-3 pending round (phase still
  // `created`) — has no suspension to lift; `resume` re-drives the
  // coordinator round directly (the re-drive completes atomically, W3-4).
  // Deliberately coordinator-only: implementor/verifier crash recovery goes
  // through the §12.3 interrupted/reclaim machinery above.
  // W4-4: GATED on §14 owner-liveness (the run-ownership lease) — a coordinator
  // round can be double-driven too, so if a still-alive PEER orchestrator owns
  // this run, WITHHOLD (the owner carries it; a later resume after that owner
  // dies reclaims the stale lease and re-drives).
  if (
    st.suspension === 'none' &&
    (st.phase === 'created' || st.phase === 'specifying') &&
    service.getRoleRound(cmd.runId)?.role === 'coordinator' &&
    !service.isRunClaimedByLiveProcess(cmd.runId)
  ) {
    return withExtraJson(await driveReentry(service, db, 'resume', cmd.runId, deps), reapExtra);
  }
  // W4-4 (restart-safety): an UNSUSPENDED implementor/verifier run stranded at
  // a role-completion boundary — the orchestrator crashed AFTER the round's
  // `child.stopped` folded but BEFORE the next dispatch/transition landed:
  //   - implementor completed, verifier not yet dispatched (phase
  //     `implementing`, round implementor/completed) → re-enter verify;
  //   - verifier round completed, the T23/T24 merge-readiness transition never
  //     landed (phase `verifying`, round verifier/completed) → re-enter verify
  //     on the SAME immutable binding (§16.3 discards the read-only dirt).
  //   - F2: implementor round persisted `no_deliverable` (abnormal stop or a
  //     remediation with no new commit) → re-enter the IMPLEMENTOR (never the
  //     verifier — `resolveResumeEntry` maps a non-`completed` implementor round
  //     to `first: 'implement'`), so a no-deliverable round is recoverable
  //     without ever bypassing the deliverable gate.
  // `resolveResumeEntry` derives the right next step from the durable stage;
  // WITHOUT this gate the run has no suspension to lift → `resume` errored
  // ("not paused") and the run was unreclaimable. GATED on §14 owner-liveness:
  // if a still-alive PEER orchestrator owns this run (its live child would be
  // double-driven), withhold — the peer will carry it (or a later resume,
  // after that peer dies, reclaims it).
  const boundaryRound = service.getRoleRound(cmd.runId);
  if (
    st.suspension === 'none' &&
    (boundaryRound?.role === 'implementor' || boundaryRound?.role === 'verifier') &&
    (boundaryRound.stage === 'completed' || boundaryRound.stage === 'no_deliverable') &&
    (st.activeChild === undefined || st.activeChild.status === 'stopped') &&
    st.phase !== 'merge_ready' &&
    st.phase !== 'cancelled' &&
    st.phase !== 'failed' &&
    !service.isRunClaimedByLiveProcess(cmd.runId)
  ) {
    return withExtraJson(await driveReentry(service, db, 'resume', cmd.runId, deps), reapExtra);
  }
  if (cmd.wait === true && st.suspension === 'paused_limit') {
    const waited = await waitForLimitResume(service, db, 'resume', cmd.runId, deps);
    if (waited !== undefined) return withExtraJson(waited, reapExtra);
    return withExtraJson(await driveReentry(service, db, 'resume', cmd.runId, deps), reapExtra);
  }
  // P4b-2 self-drive successor spine (T5 gap-close): a limit during an
  // unconfirmed model switch (T5) paused the run AND emitted
  // `segment.successor.required` — an event with zero consumers until now.
  // "Resume is ALWAYS successor with explicit model re-assertion" (§6.3 T5):
  // route this resume through the successor spine, which records the durable
  // INTENT marker (seed checkpoint + target) atomically BEFORE the spawn, then
  // re-enters via the SAME machinery. Wave 1 re-asserts the SAME target
  // (same-harness/same-model); failover to a DIFFERENT target is wave 2.
  const seedsSuccessor =
    st.suspension === 'paused_limit' && service.hasPendingSuccessorRequirement(cmd.runId);
  // Eligibility-checked immediate re-entry (T9/T12). Typed refusals
  // (`ResumeEligibilityError`) and not-paused errors surface through
  // executeCommand's shared catch.
  const result = seedsSuccessor
    ? service.recordSuccessorIntent(cmd.runId)
    : service.resume(cmd.runId);
  if (result.status !== 'applied') {
    return ingestOutput('resume', cmd.runId, result, {
      appliedText: `resume requested for run ${cmd.runId} (T9/T12).`,
      extra: reapExtra,
    });
  }
  return withExtraJson(await driveReentry(service, db, 'resume', cmd.runId, deps), reapExtra);
}

/**
 * The ONE shared `LimitPausedError` policy handler (W2-5) — every command
 * whose flow work paused on a provider limit (start / spec revise / run /
 * a resume re-entry) lands here from executeCommand's catch. Policy `wait`
 * (default) runs the in-process schedule loop and re-enters; `--no-wait`
 * (and a plain non-`--wait` resume) exits `EXIT_LIMIT_PAUSED` with resume
 * instructions. A re-entry that pauses AGAIN cycles back into the wait.
 */
async function handleLimitPaused(
  service: OrchestrationService,
  db: Database,
  command: RunCommand,
  paused: LimitPausedError,
  deps: CommandDeps,
): Promise<CommandOutput> {
  const kind = command.kind;
  const runId = paused.runId;
  const noWait =
    ('noWait' in command && command.noWait === true) ||
    (command.kind === 'resume' && command.wait !== true);
  try {
    for (let cycle = 0; cycle < MAX_PAUSE_CYCLES; cycle += 1) {
      if (noWait) return limitPausedOutput(kind, service, db, runId);
      const waited = await waitForLimitResume(service, db, kind, runId, deps);
      if (waited !== undefined) return waited;
      try {
        return await driveReentry(service, db, kind, runId, deps);
      } catch (error) {
        if (error instanceof LimitPausedError) continue; // paused again → wait again
        throw error;
      }
    }
    throw new Error(`limit pause/resume cycled ${MAX_PAUSE_CYCLES} times (wiring bug)`);
  } catch (error) {
    if (error instanceof ResumeEligibilityError) return resumeRefusedOutput(kind, error);
    return errorOutput(kind, runId, error);
  }
}

/** The `--no-wait` (or plain-resume re-pause) surface: durable pause facts +
 * exact resume instructions, exit `EXIT_LIMIT_PAUSED`. */
function limitPausedOutput(
  kind: string,
  service: OrchestrationService,
  db: Database,
  runId: RunId,
): CommandOutput {
  const limit = buildLimitStatus(service, db, runId);
  const lines = [
    `run ${runId} paused: provider usage limit (durable, checkpointed; zero respawns).`,
    `  resumes at: ${String(limit?.['resumesAt'] ?? 'unknown')} (etaSource ${String(limit?.['etaSource'] ?? 'unknown')} — §13: never an invented countdown)`,
    `  next: \`harness resume ${runId}\` (immediate, eligibility-checked) or \`harness resume ${runId} --wait\` (probe schedule loop).`,
  ];
  return finish(
    kind,
    { runId, outcome: 'paused_limit', ...(limit !== undefined ? { limit } : {}) },
    lines.join('\n'),
    EXIT_LIMIT_PAUSED,
  );
}

/**
 * The W2-5 in-process schedule loop: execute the pure scheduler's CURRENT
 * step through `runScheduledProbe`, sleep (injectable `WaitScheduler`) until
 * the event-anchored deadline, repeat. Returns `undefined` when the run is
 * ready for re-entry (T9 landed or the suspension cleared elsewhere), or a
 * terminal `CommandOutput` when waiting honestly stops: ladder exhausted /
 * probe inconclusive (both permanent for the incident; manual resume
 * remains) or a suspension change that is not the schedule's to wait out.
 */
async function waitForLimitResume(
  service: OrchestrationService,
  db: Database,
  kind: string,
  runId: RunId,
  deps: CommandDeps,
): Promise<CommandOutput | undefined> {
  const waiter = deps.waiter ?? REAL_WAITER;
  for (let i = 0; i < MAX_WAIT_ITERATIONS; i += 1) {
    const st = service.status(runId);
    if (st.suspension === 'none') return undefined;
    if (st.suspension !== 'paused_limit') {
      return finish(
        kind,
        { runId, outcome: 'suspension_changed', suspension: st.suspension },
        `run ${runId} is now ${st.suspension} — the limit wait no longer applies; use \`harness resume ${runId}\`.`,
        1,
      );
    }
    const outcome = await service.runScheduledProbe(runId);
    switch (outcome.outcome) {
      case 'resumed':
      case 'not_paused':
        return undefined;
      case 'resume_now':
        // The provider's own retry_after elapsed — an eligibility-checked T9
        // driven by the schedule (mode scheduled_probe); no probe consumed.
        service.resume(runId, { mode: 'scheduled_probe' });
        return undefined;
      case 'not_due': {
        const ms = Date.parse(outcome.plan.at) - Date.parse(db.clock.nowIso());
        await waiter.sleep(Math.max(1, ms));
        break;
      }
      case 'still_limited':
        break; // next iteration computes the next event-anchored deadline
      case 'claim_in_flight':
      case 'already_resolved':
        await waiter.sleep(WAIT_FENCE_BACKOFF_MS);
        break;
      case 'inconclusive':
        return finish(
          kind,
          {
            runId,
            outcome: 'probe_inconclusive',
            classifiedKind: outcome.classifiedKind,
            detail: outcome.detail,
          },
          `probe inconclusive (${outcome.classifiedKind}): ${outcome.detail}\n` +
            `automatic probing STOPPED; the run stays paused — \`harness resume ${runId}\` remains available.`,
          EXIT_LIMIT_PAUSED,
        );
      case 'ladder_exhausted':
        return finish(
          kind,
          {
            runId,
            outcome: 'ladder_exhausted',
            reason: outcome.plan.reason,
            probesUsed: outcome.plan.probesUsed,
            maxProbesPerIncident: outcome.plan.maxProbesPerIncident,
          },
          `probe ladder exhausted (${outcome.plan.probesUsed}/${outcome.plan.maxProbesPerIncident} still limited; ` +
            `permanent for this incident) — the run stays paused; \`harness resume ${runId}\` remains available.`,
          EXIT_LIMIT_PAUSED,
        );
      default: {
        const exhaustive: never = outcome;
        throw new Error(`Unhandled probe outcome: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
  throw new Error(`limit wait loop exceeded ${MAX_WAIT_ITERATIONS} iterations (wiring bug)`);
}

/**
 * W2-5 re-entry: after T9/T12 (or a startup reclaim), drive the re-entered
 * round ENTIRELY from its durable state — the `RoleRoundProjection` +
 * checkpoint + persisted loop binding decide everything; nothing is
 * reconstructed from the paused process's memory. The
 * `resume_reentry.completed` ack lands inside `runRole` the moment the
 * re-entered round actually goes active.
 */
async function driveReentry(
  service: OrchestrationService,
  db: Database,
  kind: string,
  runId: RunId,
  deps: CommandDeps,
): Promise<CommandOutput> {
  const flows = deps.flows;
  const st = service.status(runId);
  const round = service.getRoleRound(runId);
  if (st.phase === 'merge_ready' || st.phase === 'cancelled' || st.phase === 'failed') {
    // Nothing left to drive (e.g. a reclaim raced a completed run).
    return finish(
      kind,
      { runId, outcome: 'resumed', phase: st.phase, reentry: 'already_complete' },
      `run ${runId} is already at ${st.phase}; nothing to re-enter.`,
      st.phase === 'merge_ready' ? 0 : 1,
    );
  }
  if (round === undefined) {
    return finish(
      kind,
      { runId, outcome: 'resumed', phase: st.phase, reentry: 'none' },
      `run ${runId} resumed at phase ${st.phase}; no dispatched round to re-enter.`,
      0,
    );
  }
  if (flows === undefined) {
    return finish(
      kind,
      { runId, outcome: 'resumed', phase: st.phase, reentry: 'unavailable' },
      `run ${runId} resumed (phase ${st.phase}), but the flow runtime is unavailable in this ` +
        'invocation — the round was NOT re-entered; complete it through the shipped `harness` CLI.',
      0,
    );
  }
  if (round.role === 'coordinator') {
    return reenterCoordinator(service, db, kind, runId, round, flows);
  }
  return reenterImplementVerify(service, db, kind, runId, round, flows);
}

/** Round inputs a coordinator dispatch serialized (W2-5 re-entry reads them). */
function parseRoundInputs(serialized: string | undefined): {
  readonly goal?: string;
  readonly reviseFeedback?: string;
} {
  if (serialized === undefined) return {};
  try {
    const parsed = JSON.parse(serialized) as { goal?: unknown; revise?: { feedback?: unknown } };
    return {
      ...(typeof parsed.goal === 'string' ? { goal: parsed.goal } : {}),
      ...(typeof parsed.revise?.feedback === 'string'
        ? { reviseFeedback: parsed.revise.feedback }
        : {}),
    };
  } catch {
    return {};
  }
}

/**
 * Re-enter a paused coordinator round (W2-5, pushback item 11): a pause
 * during `start` (phase still `created` — the pending round re-dispatches
 * whole) or after activation / during the W1-F7 revise re-run (phase
 * `specifying` — re-drive without an activation advance). Completion stores
 * the draft and advances `specifying → awaiting_approval`, exactly like the
 * un-paused paths.
 */
async function reenterCoordinator(
  service: OrchestrationService,
  db: Database,
  kind: string,
  runId: RunId,
  round: RoleRoundProjection,
  flows: CliFlowDeps,
): Promise<CommandOutput> {
  const meta = db.projections.get<RunMeta>(runId, RUN_META_PROJECTION)?.state;
  if (meta === undefined) {
    const text = `run ${runId}: no run metadata persisted — cannot re-enter the coordinator round.`;
    return finish(kind, { runId, error: 'meta_missing', detail: text }, text, 1);
  }
  let pinnedWorkspace: Awaited<ReturnType<OrchestrationService['assertOrPinLegacyCleanWorkspace']>>;
  try {
    pinnedWorkspace = await service.assertOrPinLegacyCleanWorkspace(runId);
  } catch (error) {
    if (error instanceof WorkspaceDriftError) return workspaceRefusalOutput(kind, error, runId);
    throw error;
  }
  const phase = service.status(runId).phase;
  if (phase === 'awaiting_approval') {
    return finish(
      kind,
      { runId, outcome: 'resumed', phase, reentry: 'already_complete' },
      `run ${runId} is back at awaiting_approval; the coordinator round already completed.`,
      0,
    );
  }
  if (phase !== 'created' && phase !== 'specifying') {
    const text = `run ${runId}: a coordinator round cannot re-enter from phase '${phase}'.`;
    return finish(kind, { runId, error: 'reentry_phase_mismatch', phase, detail: text }, text, 1);
  }
  const inputs = parseRoundInputs(round.inputs);
  const goal = inputs.goal ?? meta.goal;
  let revise: CoordinatorReviseContext | undefined;
  if (inputs.reviseFeedback !== undefined) {
    // The W1-F7 revise re-run paused: the superseding draft is only saved on
    // completion, so the CURRENT persisted draft is still the prior version
    // being revised — rebuild the revision context from it.
    const priorDraft = service.getSpecDraft(runId);
    if (priorDraft !== undefined) {
      revise = {
        feedback: inputs.reviseFeedback,
        priorVersion: draftAsSpecVersion(runId, priorDraft, db.clock),
        priorSpecText: priorDraft.canonicalSpec,
      };
    }
  }
  const runner = flows.buildCoordinatorRunner({
    runId,
    goal,
    coordinator: meta.coordinator,
    workspacePath: meta.workspacePath,
    baseCommit: pinnedWorkspace.pinnedSha,
    ...(meta.planningChatEnabled === true ? { enableChat: true } : {}),
    ...(revise !== undefined ? { revise } : {}),
  });
  // W3-4: BOTH branches complete through `completeCoordinationRound` (inside
  // `runCoordination` via `toDraft` on the created-phase re-dispatch) — the
  // draft persists BEFORE the final advance, atomically, exactly like the
  // un-paused start/revise paths.
  let outcome: CoordinatorOutcome;
  try {
    outcome =
      phase === 'created'
        ? // The pin-window pause left the round PENDING and the phase at
          // `created` — the whole coordination dispatch re-drives.
          await service.runCoordination(runId, runner, (o) => draftFromOutcome(goal, o))
        : await (async () => {
            const result = await service.runRole(runId, runner, meta.coordinator, meta.workspacePath, {
              round: round.round,
              completionAdvance: { from: 'specifying', to: 'awaiting_approval' },
              ...(round.inputs !== undefined ? { inputs: round.inputs } : {}),
            });
            await service.assertPinnedCleanWorkspace(runId);
            await service.completeCoordinationRound(runId, draftFromOutcome(goal, result));
            return result;
          })();
  } catch (error) {
    if (error instanceof WorkspaceDriftError) return workspaceRefusalOutput(kind, error, runId);
    if (error instanceof SpecApprovalRefusedError) return approvalRefusalOutput(kind, error);
    throw error;
  }

  // B2 (codex F3): both re-entry branches complete through
  // `completeCoordinationRound`, so an `approval:'auto'` run is ALREADY
  // approved here — this surface must not keep telling the operator to approve.
  const autoApproval = autoApprovalOf(service, runId, outcome.specVersion);
  const st = service.status(runId);
  const body = {
    runId,
    outcome: 'resumed',
    reentry: 'coordinator',
    phase: st.phase,
    uiState: st.uiState,
    ...(autoApproval !== undefined ? { approval: autoApprovalView(autoApproval) } : {}),
    ...(outcome.planningChat !== undefined ? { planningChat: outcome.planningChat } : {}),
    spec: {
      specVersionId: outcome.specVersion.id,
      specHash: outcome.specVersion.contentHash,
      revision: outcome.specVersion.revision,
      rounds: outcome.rounds,
      ...(outcome.supersedes !== undefined ? { supersedes: outcome.supersedes } : {}),
      criteria: outcome.specVersion.criteria.map((c) => ({ id: c.id, description: c.description })),
      document: outcome.canonicalSpec,
    },
  };
  const text = [
    `run ${runId} resumed: the coordinator round re-entered and completed (phase ${st.phase}).`,
    ...(outcome.planningChat !== undefined
      ? [`planning chat: ${outcome.planningChat.viewerUrl} (${outcome.planningChat.roomCode}, closed after synthesis)`]
      : []),
    `spec hash: ${outcome.specVersion.contentHash}`,
    '',
    outcome.canonicalSpec,
    '',
    ...(autoApproval !== undefined
      ? autoApprovalLines(runId, autoApproval)
      : [
          `next: approve ${runId} --spec-version ${outcome.specVersion.id} --spec-hash ${outcome.specVersion.contentHash}`,
        ]),
  ].join('\n');
  return finish(kind, body, text, 0);
}

/**
 * Re-enter a paused implementor/verifier round (W2-5): everything comes from
 * durable state — the spec draft (document/criteria), the persisted loop
 * binding (assignment, both role specs, task scope), the round projection,
 * and the round's §12.2 checkpoint. A `needs_remediation` re-entry rebuilds
 * the remediation payload from the durable T23 record. The loop ADOPTS the
 * worktree (mutex + §16.3) — it never creates one on resume.
 */
async function reenterImplementVerify(
  service: OrchestrationService,
  db: Database,
  kind: string,
  runId: RunId,
  round: RoleRoundProjection,
  flows: CliFlowDeps,
): Promise<CommandOutput> {
  const st = service.status(runId);
  const draft = service.getSpecDraft(runId);
  const loopState = service.getImplementVerifyLoopState(runId);
  if (draft === undefined || loopState === undefined) {
    const text =
      `run ${runId}: cannot re-enter the ${round.role} round — the ` +
      `${draft === undefined ? 'spec draft' : 'implement→verify loop binding'} is not persisted.`;
    return finish(kind, { runId, error: 'reentry_state_missing', detail: text }, text, 1);
  }
  if (st.workspacePath === undefined) {
    const text = `run ${runId}: no workspace path recorded for this run.`;
    return finish(kind, { runId, error: 'workspace_missing', detail: text }, text, 1);
  }
  // B2 (codex F5): a resumed loop rebuilds the SAME §16 report, so it needs the
  // same event-derived signer — refused, never defaulted (see `handleRun`).
  const specApprovedBy = st.specApprovedBy;
  if (specApprovedBy === undefined) {
    const text =
      `run ${runId}: cannot re-enter the ${round.role} round — the run records NO approval signer, so ` +
      'the merge-readiness report could not state whether a human reviewed this spec. This is an ' +
      'engine invariant violation (B2) — report it.';
    return finish(kind, { runId, error: 'approval_signer_missing', detail: text }, text, 1);
  }
  // F3 (§5x): DERIVE the checkpoint from the log rather than trusting the
  // separately-saved `round.checkpointRef` pointer — a crash between the
  // atomic `checkpoint.recorded` append and the `checkpointRef` save, or a
  // cadence checkpoint (which saves no pointer), would otherwise be invisible
  // to resume. `checkpointRef` stays only as an optional fast-path cache hint.
  const checkpoint = service.resolveResumeCheckpoint(runId);
  const fixRequests = st.phase === 'needs_remediation' ? latestT23FixRequests(db, runId) : undefined;
  const resume: ImplementVerifyResumeInput = {
    round,
    ...(checkpoint !== undefined ? { checkpoint } : {}),
    ...(fixRequests !== undefined ? { fixRequests } : {}),
  };
  const worktrees = await flows.openWorktrees(st.workspacePath);
  const result = await runImplementVerifyLoop(
    { service, worktrees, ids: flows.ids, clock: flows.clock },
    {
      runId,
      assignmentId: loopState.assignmentId,
      implementor: loopState.implementor,
      verifier: loopState.verifier,
      specHash: draft.specHash,
      specApprovedBy,
      specDocument: draft.canonicalSpec,
      goal: draft.goal,
      taskScope: loopState.taskScope,
      criteria: draft.criteria,
      evidence: flows.evidence,
      // B5: a RESUMED multi-assignment run must resume as a multi-assignment run.
      // The decomposition comes from the same hash-bound canonical bytes the
      // original dispatch read, so the resumed round drives the SAME assignments
      // — and the per-assignment projections tell it which of them already
      // finished. Reading it from anywhere else could resume a different fan-out
      // than the one the crash interrupted.
      ...(() => {
        const assignments = approvedSpecAssignments(draft.canonicalSpec);
        return assignments.length > 0 ? { assignments } : {};
      })(),
      ...(flows.runVerification !== undefined ? { runVerificationCommands: flows.runVerification } : {}),
      resume,
    },
  );
  return loopResultOutput(kind, service, runId, result, loopState.implementor, loopState.verifier);
}

/** The latest durable T23 payload → rebuilt remediation payload (W2-5). */
function latestT23FixRequests(db: Database, runId: RunId): readonly FixRequest[] | undefined {
  const events = db.events.listByRun(runId);
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.type === 'verification.completed.failed') {
      return rebuildFixRequestsFromT23(event.payload);
    }
  }
  return undefined;
}

/**
 * The W2-5 `status --json` limit block — exactly the spec'd shape:
 * `{incident{provider, kind, source, confidence, at}, resumesAt ISO|'unknown',
 * etaSource retry_after|unknown, probes{used, max, nextAt|null,
 * inconclusive?}, policy}`. Honest by construction: `resumesAt` is the WORD
 * `unknown` when no structured reset crossed the envelope — never an
 * invented countdown (§13).
 */
function buildLimitStatus(
  service: OrchestrationService,
  db: Database,
  runId: RunId,
): Record<string, unknown> | undefined {
  const events = db.events.listByRun(runId);
  const incident = latestIncidentEvent(events);
  if (incident === undefined) return undefined;
  const payload = incident.payload;
  // Confidence lives on the classifying TRIGGER (T4/T16/…), not the incident
  // effect event — read the latest classification at/before the incident.
  let confidence = 'low';
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (Number(event.sequence) > Number(incident.sequence)) continue;
    const classification = (event.payload as { classification?: LimitClassification }).classification;
    if (classification !== undefined) {
      confidence = classification.confidence;
      break;
    }
  }
  const pinned = service.getRunConfig(runId) ?? DEFAULT_ENGINE_CONFIG;
  const plan = service.getResumePlan(runId);
  const probes = collectIncidentProbeState(incident, events);
  const inconclusive = probes.inconclusive.at(-1);
  return {
    incident: {
      provider: payload.provider,
      kind: payload.incidentKind,
      source: payload.source ?? payload.detectionTier,
      confidence,
      at: incident.occurredAt,
    },
    resumesAt: payload.resumesAt ?? 'unknown',
    etaSource: payload.etaSource,
    probes: {
      used: probes.stillLimitedCount,
      max: pinned.limitProbe.maxProbesPerIncident,
      nextAt: plan !== undefined && plan.kind === 'probe_at' ? plan.at : null,
      ...(inconclusive !== undefined
        ? {
            inconclusive: {
              classifiedKind: inconclusive.payload.classifiedKind,
              detail: inconclusive.payload.detail,
            },
          }
        : {}),
    },
    // §13/§review-7 F8 per-assignment failover policy: report the ACTUAL
    // configured/effective policy for the run (`wait` | `switch_model` |
    // `switch_harness`), never a hard-coded `wait` — status must not contradict
    // the durable pinned config now that P4b implements the switch_* policies.
    policy: pinned.failoverPolicy,
  };
}

/**
 * P4b-1 — the `status --json` alerts section: each raised alert with its kind,
 * role, generation, redacted detail, occurredAt, and per-sink delivery state.
 * Derived from the log via the service's alert projection.
 */
function buildAlertsStatus(
  service: OrchestrationService,
  runId: RunId,
): readonly Record<string, unknown>[] {
  return service.alertStatus(runId).map((alert) => ({
    alertId: alert.alertId,
    kind: alert.kind,
    role: alert.role,
    ...(alert.generationId !== undefined ? { generationId: alert.generationId } : {}),
    topic: alert.topic,
    detail: alert.detail,
    occurredAt: alert.occurredAt,
    delivered: alert.delivered,
    sinks: alert.sinks,
  }));
}

// ---------------------------------------------------------------------------
// status (phase, suspension, ETA|unknown, vitals rss/context/cost, checkpoints)
// ---------------------------------------------------------------------------
function handleStatus(service: OrchestrationService, db: Database, runId: RunId): CommandOutput {
  const st = service.status(runId);
  const checkpoints = collectCheckpoints(db, runId);
  const rssBytes = latestRssBytes(db, runId);
  // §review-7 F8: build the limit block ONCE so both the top-level ETA and the
  // block agree. A structured `resumesAt` (an ISO string, not the WORD
  // `unknown`) is the exact reset time that crossed the ACP.
  const limit = st.suspension === 'paused_limit' ? buildLimitStatus(service, db, runId) : undefined;
  const resumesAt = limit?.['resumesAt'];
  const limitResumesAt =
    typeof resumesAt === 'string' && resumesAt !== 'unknown' ? resumesAt : undefined;
  const view: Record<string, unknown> = {
    runId,
    phase: st.phase,
    suspension: st.suspension,
    // P4b-2: an `interrupted` run under `autoRespawn=bounded` is auto-recovering
    // (breaker not yet exhausted) — surface it distinctly from a manual interrupt.
    suspensionDetail:
      st.autoRecovering !== undefined
        ? `interrupted — auto-recovering (attempt ${st.autoRecovering.attempt})`
        : st.suspension === 'interrupted'
          ? 'interrupted — manual resume required'
          : st.suspension === 'resource_exhausted'
            ? // F3: a LOCAL RSS ceiling (not a provider limit) — the remedy is an
              // audited per-run budget raise, then resume (never at the same budget).
              `resource_exhausted — RSS memory budget crossed; recover with ` +
              `\`harness set-budget ${runId} --role <role> --memory-budget-mb <N> --resume\``
            : null,
    ...(st.autoRecovering !== undefined ? { autoRecovering: st.autoRecovering } : {}),
    operation: st.operation,
    uiState: st.uiState,
    childActive: st.childActive,
    // §13/§review-7 F8: honest ETA — while limit-paused, surface the incident's
    // EXACT structured `resumesAt` when one crossed the ACP; otherwise the WORD
    // `unknown` (never an invented countdown). `null` (n/a) when not limit-paused.
    eta: st.suspension === 'paused_limit' ? (limitResumesAt ?? 'unknown') : null,
    // W2-5: the honest limit block — incident/resumesAt/probes/policy — is
    // present exactly while the run is limit-paused with a recorded incident.
    ...(limit !== undefined ? { limit } : {}),
    ...(st.resumeReentryPending !== undefined ? { resumeReentryPending: st.resumeReentryPending } : {}),
    counters: st.counters,
    ...(st.approvedSpecHash !== undefined ? { approvedSpecHash: st.approvedSpecHash } : {}),
    ...(st.goal !== undefined ? { goal: st.goal } : {}),
    ...(st.workspacePath !== undefined ? { workspacePath: st.workspacePath } : {}),
    // B3: WHICH execution mode this run's workspace was created under, through
    // the persisted read boundary. `worktree` is what every run predating
    // execution modes was actually created under, so absence is not "unknown" —
    // it is the status quo, and `resolvePersistedExecutionMode` is the ONE
    // reader allowed to say so. Reported before any workspace exists too: a run
    // that has not reached `run` yet has not chosen, and `worktree` is what it
    // will get unless the operator passes `--in-place`.
    executionMode: resolvePersistedExecutionMode(
      service.getImplementVerifyLoopState(runId)?.worktree,
    ),
    planningChatEnabled:
      db.projections.get<RunMeta>(runId, RUN_META_PROJECTION)?.state.planningChatEnabled === true,
    vitals: {
      rssBytes, // null until process samples exist (§14 telemetry)
      cost: {
        totalCostUsd: st.cost.totalCostUsd,
        // §17.2 D-2: estimated (conservative-reservation) spend for subscription
        // turns with no measured price, reported apart from measured cost so the
        // total is honest and clearly flagged as including an estimate.
        totalEstimatedCostUsd: st.cost.totalEstimatedCostUsd ?? 0,
        costEstimated: st.cost.costEstimated ?? false,
        totalInputTokens: st.cost.totalInputTokens,
        totalOutputTokens: st.cost.totalOutputTokens,
        turns: st.cost.turns,
        ...(st.cost.currency !== undefined ? { currency: st.cost.currency } : {}),
        byRole: st.cost.byRole, // §17.2 per-role attribution (measured + estimated)
        byPhase: st.cost.byPhase, // §17.2 per-phase attribution (remediation is visible)
      },
      context: st.cost.roleVitals, // per-role context-window gauge
    },
    budget: st.budget,
    checkpoints,
    // §5t (4): the effective (running) model per role AND, when set, a DISTINCT
    // pending desired model — never conflated.
    models: buildModelsView(db, runId),
    // P4b-1: the alerts section — every raised alert with its per-sink delivery
    // state (derived from the log). Omitted when there are none.
    ...(() => {
      const alerts = buildAlertsStatus(service, runId);
      return alerts.length > 0 ? { alerts } : {};
    })(),
  };
  return finish('status', view, renderStatusText(view, st.suspension), 0);
}

interface RoleModelView {
  readonly effective?: string;
  /**
   * Durable proof that this role reached `child.spawned` after its model pin
   * succeeded. `echoed:false` is intentionally visible: it proves the
   * requested pin crossed the adapter boundary, but not that the provider
   * echoed an effective value.
   */
  readonly spawnEvidence?: {
    readonly source: 'child.spawned';
    readonly optionId: string;
    readonly requested: string;
    readonly effective: string;
    readonly echoed: boolean;
  };
  readonly desired?: { readonly harness: string; readonly model: string; readonly effort?: string };
}

/**
 * §5t (4): per-role EFFECTIVE (running) model from `child.spawned` pins, plus a
 * DISTINCT pending DESIRED model when `switch-model` recorded one — reported
 * apart so status never presents a not-yet-applied switch as confirmed.
 */
function buildModelsView(db: Database, runId: RunId): Record<string, RoleModelView> {
  const desired = new DurableDesiredModelStore(db).listForRun(runId);
  const out: Record<string, RoleModelView> = {};
  for (const role of ['coordinator', 'implementor', 'verifier'] as const) {
    const spawnEvidence = currentModelPinFor(db, runId, role);
    const effective =
      spawnEvidence?.effective ??
      (role === 'coordinator'
        ? db.projections.get<RunMeta>(runId, RUN_META_PROJECTION)?.state.coordinator.model
        : undefined);
    const want = desired.find((record) => record.role === role);
    if (effective === undefined && want === undefined) continue;
    out[role] = {
      ...(effective !== undefined ? { effective } : {}),
      ...(spawnEvidence !== undefined ? { spawnEvidence } : {}),
      ...(want !== undefined
        ? {
            desired: {
              harness: want.harness,
              model: want.model,
              ...(want.effort !== undefined ? { effort: want.effort } : {}),
            },
          }
        : {}),
    };
  }
  return out;
}

interface CheckpointEntry {
  readonly checkpointId: string;
  readonly reason: string;
  readonly artifactHash: string;
  readonly sequence: number;
}

function collectCheckpoints(db: Database, runId: RunId): { count: number; entries: readonly CheckpointEntry[] } {
  const entries: CheckpointEntry[] = [];
  for (const event of db.events.listByRun(runId)) {
    if (event.type !== 'checkpoint.recorded') continue;
    entries.push({
      checkpointId: String(event.payload.checkpointId),
      reason: event.payload.reason,
      artifactHash: String(event.payload.artifactHash),
      sequence: Number(event.sequence),
    });
  }
  return { count: entries.length, entries };
}

function latestRssBytes(db: Database, runId: RunId): number | null {
  // Prefer the newest signal: the in-progress window's raw ticks are more
  // recent than any closed aggregate, so a raw sample newer than the latest
  // aggregate window wins. W4-3: without the raw fallback RSS stayed null
  // until a window closed (and null forever if none ever did).
  const aggregates = db.telemetry.listAggregates(runId);
  const latestAggregate = aggregates.at(-1);
  const latestRaw = db.telemetry.listRawSamples(runId).at(-1);
  if (latestAggregate === undefined) return latestRaw?.rssBytes ?? null;
  if (latestRaw === undefined) return latestAggregate.rssMaxBytes;
  return Date.parse(latestRaw.sampledAt) >= Date.parse(latestAggregate.windowStart)
    ? latestRaw.rssBytes
    : latestAggregate.rssMaxBytes;
}

// ---------------------------------------------------------------------------
// switch-model (§11.2 / §5t) — HONEST desired-model recording, never a
// fabricated T19 segment, never a silent no-op.
// ---------------------------------------------------------------------------
// §5t: the old CLI path fabricated `segmentId(runId:pending)` and drove
// `model.switch.requested` straight into `service.ingest`. T19 gates ONLY on
// suspension=none & operation=idle & child_active (NO segment check), so with a
// live idle child it ACCEPTED and set operation=model_switch — a segment the CLI
// never owned, silently clobbered by the next turn fold: a false success. That
// direct-ingest path is DELETED. `switch-model` now records a DISTINCT durable
// desired-model record (mapping to NO transition) and reports it honestly; live
// in-place apply at a completed-turn boundary is the deferred follow-up.
function handleSwitchModel(
  service: OrchestrationService,
  db: Database,
  cmd: Extract<RunCommand, { kind: 'switch_model' }>,
): CommandOutput {
  const resolved = resolveRoleModel(cmd.target);
  const fromModel = currentModelFor(db, cmd.runId, cmd.role);

  // Durable desired-model record: a distinct row per (runId, role) that maps to
  // NO transition. Applied at the NEXT spawn via the existing
  // initial_config_pin / model-pin (F8) machinery; visible in `status` as
  // pending until then. NEVER an ingest, so it can never fabricate a segment.
  const desired: DesiredModelRecord = {
    runId: String(cmd.runId),
    role: cmd.role,
    harness: resolved.harness,
    model: resolved.model,
    ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
    requestedAt: db.clock.nowIso(),
  };
  new DurableDesiredModelStore(db).set(desired);

  // Honest gate: a live child owning the run means the switch cannot apply until
  // the next spawn/turn boundary (the live in-place apply loop is deferred); no
  // live child means the desired model simply applies at the next spawn.
  const liveOwner = service.isRunClaimedByLiveProcess(cmd.runId) || service.status(cmd.runId).childActive;
  const boundaryText = liveOwner
    ? `queued; applies at the next spawn/turn boundary (a live child currently owns run ${cmd.runId})`
    : `pending; applies at the next spawn of ${cmd.role} on run ${cmd.runId}`;

  return finish(
    'switch_model',
    {
      runId: cmd.runId,
      outcome: 'desired_recorded',
      role: cmd.role,
      target: resolvedView(resolved),
      desiredModel: resolved.model,
      liveOwner,
      ...(fromModel !== undefined ? { effectiveModel: fromModel } : {}),
    },
    `desired model for ${cmd.role} set to ${describeSpec(cmd.target)} — ${boundaryText}. ` +
      `Effective (running) model: ${fromModel ?? 'none yet'}.`,
    0,
  );
}

/**
 * F3 (§review dogfood) — the audited per-run RSS memory-budget override, the ONE
 * sanctioned exception to config immutability, used to recover a
 * `resource_exhausted` run at a higher budget. `raiseRoleMemoryBudget` refuses a
 * run that is not resource-exhausted, and refuses anything but a genuine raise
 * (both surface as a WorkflowAdvanceError the outer handler renders). `--resume`
 * re-enters the run after raising it (the resume guard requires the effective
 * budget to now exceed the exhausted one).
 */
async function handleSetBudget(
  service: OrchestrationService,
  db: Database,
  cmd: Extract<RunCommand, { kind: 'set_budget' }>,
  deps: CommandDeps,
): Promise<CommandOutput> {
  service.raiseRoleMemoryBudget(cmd.runId, cmd.role, cmd.budgetMb);
  if (cmd.resume === true) {
    const completedBefore = db.events
      .listByRun(cmd.runId)
      .filter((event) => event.type === 'resume_reentry.completed').length;
    const resumed = service.resume(cmd.runId);
    if (resumed.status !== 'applied') {
      const st = service.status(cmd.runId);
      return finish(
        'set_budget',
        {
          runId: cmd.runId,
          outcome: 'raised_resume_pending',
          role: cmd.role,
          budgetMb: cmd.budgetMb,
          suspension: st.suspension,
          phase: st.phase,
          reentry: 'resume_not_applied',
          resumeStatus: resumed.status,
        },
        `run ${cmd.runId}: raised ${cmd.role} memory budget to ${cmd.budgetMb}MB (audited), ` +
          `but T12 did not apply (${resumed.status}); the durable raise remains recorded and the round ` +
          'was not re-entered.',
        1,
      );
    }

    // `--resume` is the one-shot form of `set-budget` followed by `resume`:
    // after the audited raise and T12, drive the exact same durable re-entry
    // composition as `harness resume`. Do not call the operation "resumed"
    // merely because T12 cleared the suspension — the round is only re-entered
    // once runRole appends `resume_reentry.completed`.
    const reentry = await driveReentry(service, db, 'set_budget', cmd.runId, deps);
    const st = service.status(cmd.runId);
    const completedAfter = db.events
      .listByRun(cmd.runId)
      .filter((event) => event.type === 'resume_reentry.completed').length;
    if (completedAfter <= completedBefore) {
      const reentryState =
        typeof reentry.json['reentry'] === 'string' ? reentry.json['reentry'] : 'pending';
      return finish(
        'set_budget',
        {
          runId: cmd.runId,
          outcome: 'raised_resume_pending',
          role: cmd.role,
          budgetMb: cmd.budgetMb,
          suspension: st.suspension,
          phase: st.phase,
          reentry: reentryState,
          durableRaise: true,
        },
        `run ${cmd.runId}: raised ${cmd.role} memory budget to ${cmd.budgetMb}MB (audited) and ` +
          `applied T12, but the round was NOT re-entered (${reentryState}). ` +
          'The durable raise and pending re-entry remain recoverable with `harness resume`.\n' +
          reentry.text,
        reentry.exitCode,
      );
    }

    return finish(
      'set_budget',
      {
        runId: cmd.runId,
        outcome: 'raised_and_resumed',
        role: cmd.role,
        budgetMb: cmd.budgetMb,
        suspension: st.suspension,
        phase: st.phase,
        reentry: 'completed',
        ...(reentry.json['outcome'] !== undefined
          ? { reentryOutcome: reentry.json['outcome'] }
          : {}),
      },
      `run ${cmd.runId}: raised ${cmd.role} memory budget to ${cmd.budgetMb}MB (audited); ` +
        `the resumed round re-entered (now ${st.suspension}/${st.phase}).\n` +
        reentry.text,
      reentry.exitCode,
    );
  }
  return finish(
    'set_budget',
    { runId: cmd.runId, outcome: 'raised', role: cmd.role, budgetMb: cmd.budgetMb },
    `run ${cmd.runId}: raised ${cmd.role} memory budget to ${cmd.budgetMb}MB (audited). ` +
      `Resume with \`harness resume ${cmd.runId}\`.`,
    0,
  );
}

/**
 * The latest durable `child.spawned` model-pin evidence per role (§5t #1 / S6
 * — a READ-MODEL over F8 truth, no parallel store). The public status view
 * keeps both the requested value and the provider echo fact so live acceptance
 * tests can prove which model crossed the actual spawn boundary.
 */
function modelPinsFromSpawnEvents(
  db: Database,
  runId: RunId,
): Partial<Record<RoleName, NonNullable<RoleModelView['spawnEvidence']>>> {
  const byRole: Partial<Record<RoleName, NonNullable<RoleModelView['spawnEvidence']>>> = {};
  for (const event of db.events.listByRun(runId)) {
    if (event.type !== 'child.spawned') continue;
    const modelPin = event.payload.pins.find((pin) => pin.purpose === 'model');
    if (modelPin === undefined) continue;
    // Later events win (the newest spawn's pin is the running model).
    byRole[event.payload.role] = {
      source: 'child.spawned',
      optionId: modelPin.optionId,
      requested: modelPin.value,
      effective: modelPin.effectiveValue ?? modelPin.value,
      echoed: modelPin.echoed,
    };
  }
  return byRole;
}

function currentModelPinFor(
  db: Database,
  runId: RunId,
  role: RoleName,
): NonNullable<RoleModelView['spawnEvidence']> | undefined {
  return modelPinsFromSpawnEvents(db, runId)[role];
}

function currentModelFor(db: Database, runId: RunId, role: RoleName): string | undefined {
  const fromPins = currentModelPinFor(db, runId, role);
  if (fromPins !== undefined) return fromPins.effective;
  if (role !== 'coordinator') return undefined;
  const meta = db.projections.get<RunMeta>(runId, RUN_META_PROJECTION);
  return meta?.state.coordinator.model;
}

// ---------------------------------------------------------------------------
// cancel (idempotent, one terminal result — T18)
// ---------------------------------------------------------------------------
async function handleCancel(
  service: OrchestrationService,
  cmd: Extract<RunCommand, { kind: 'cancel' }>,
): Promise<CommandOutput> {
  const result = service.cancel(cmd.runId);
  if (result.status === 'rejected') {
    const phase = service.status(cmd.runId).phase;
    if (phase === 'cancelled' || phase === 'failed') {
      return finish(
        'cancel',
        { runId: cmd.runId, outcome: 'already_terminal', phase },
        `run ${cmd.runId} is already terminal (${phase}); cancel is a no-op (T18 idempotent).`,
        0,
      );
    }
  }
  // W3-2: route the terminal stop through the durable §14 registry so a child
  // running in ANOTHER process is actually terminated — a graceful SIGTERM
  // then, if it outlives the terminate grace, an identity-verified SIGKILL
  // (§10.2 ladder). The owning process folds the generation-matched stop.
  if (result.status === 'applied') {
    await service.stopExternalChild(cmd.runId, { escalate: true });
  }
  return ingestOutput('cancel', cmd.runId, result, { appliedText: `run ${cmd.runId} cancelled (T18).` });
}

// ---------------------------------------------------------------------------
// Shared output helpers
// ---------------------------------------------------------------------------
interface IngestText {
  readonly appliedText: string;
  readonly rejectedHint?: string;
  readonly extra?: Record<string, unknown>;
}

function ingestOutput(kind: string, runId: RunId, result: IngestResult, opts: IngestText): CommandOutput {
  const extra = opts.extra ?? {};
  if (result.status === 'applied') {
    return finish(
      kind,
      {
        runId,
        outcome: 'applied',
        transitionId: result.transitionId,
        phase: result.next.phase,
        suspension: result.next.suspension.kind,
        operation: result.next.operation.kind,
        emitted: result.emitted.map((event) => event.type),
        ...extra,
      },
      opts.appliedText,
      0,
    );
  }
  if (result.status === 'rejected') {
    const text = `rejected (${result.reason}): ${result.detail}${opts.rejectedHint !== undefined ? `\n${opts.rejectedHint}` : ''}`;
    return finish(kind, { runId, outcome: 'rejected', reason: result.reason, detail: result.detail, ...extra }, text, 1);
  }
  if (result.status === 'deduped') {
    // §6.1 idempotent replay: the trigger key was already consumed — one
    // logical event, nothing re-applied. Success (exit 0), but never
    // presented as a fresh transition.
    return finish(
      kind,
      { runId, outcome: 'deduped', eventType: result.event.type, ...extra },
      `already recorded ${result.event.type} (idempotent replay — one logical event).`,
      0,
    );
  }
  return finish(kind, { runId, outcome: 'recorded', eventType: result.event.type, ...extra }, `recorded ${result.event.type}.`, 0);
}

function errorOutput(kind: string, runId: RunId | undefined, error: unknown): CommandOutput {
  const name = error instanceof Error ? error.name : 'Error';
  // §17.1 sink belt (defense in depth): whatever unwound to here may embed
  // untrusted provider text (the typed auth/protocol path rethrows provider
  // failures), so the message is redacted AT THE SINK — covering both
  // surfaces (human text and the stable `--json` payload) regardless of
  // where the error originated.
  const message = redactText(error instanceof Error ? error.message : String(error));
  if (error instanceof IndependenceViolationError) {
    return finish(
      kind,
      {
        ...(runId !== undefined ? { runId } : {}),
        error: {
          name,
          code: error.code,
          message,
          implementor: error.implementor,
          verifier: error.verifier,
        },
      },
      `error: ${message}`,
      1,
    );
  }
  return finish(
    kind,
    { ...(runId !== undefined ? { runId } : {}), error: { name, message } },
    `error: ${message}`,
    1,
  );
}

function finish(command: string, body: Record<string, unknown>, text: string, exitCode: number): CommandOutput {
  return { json: { command, ok: exitCode === 0, ...body }, text, exitCode };
}

// ---------------------------------------------------------------------------
// Views / rendering
// ---------------------------------------------------------------------------
function resolvedView(resolved: ResolvedRoleModel): Record<string, unknown> {
  return {
    harness: resolved.harness,
    model: resolved.model,
    ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
    configOptions: resolved.configOptions.map((option) => ({
      purpose: option.purpose,
      optionId: option.optionId,
      value: option.value,
    })),
  };
}

function describeSpec(spec: RoleModelSpec): string {
  return `${spec.harness}/${spec.model}${spec.effort !== undefined ? ` (effort ${spec.effort})` : ''}`;
}

function renderStatusText(view: Record<string, unknown>, suspension: string): string {
  const vitals = view['vitals'] as { rssBytes: number | null; cost: Record<string, unknown> };
  const checkpoints = view['checkpoints'] as { count: number };
  const estimated = Number(vitals.cost['totalEstimatedCostUsd'] ?? 0);
  const costLabel =
    estimated > 0
      ? `$${String(vitals.cost['totalCostUsd'])} measured (+ $${estimated} estimated, §17.2)`
      : `$${String(vitals.cost['totalCostUsd'])}`;
  const lines = [
    `run ${String(view['runId'])} — phase ${String(view['phase'])}, ui ${String(view['uiState'])}`,
    // §review-7 F8: when the incident carries a structured reset time, surface it
    // as the exact ETA; keep `unknown` only when no reset crossed the ACP (§13).
    `  suspension: ${suspension}${
      suspension === 'paused_limit'
        ? typeof view['eta'] === 'string' && view['eta'] !== 'unknown'
          ? ` (ETA ${String(view['eta'])} — structured reset from the incident, §13)`
          : ' (ETA unknown — no reset time crosses ACP, §13)'
        : ''
    }`,
    `  operation:  ${JSON.stringify(view['operation'])}`,
    `  child active: ${String(view['childActive'])}`,
    // B3: an operator has to be able to tell, from `status` alone, whether this
    // run is writing in their own checkout.
    `  execution mode: ${String(view['executionMode'])}${
      view['executionMode'] === 'in_place'
        ? ' (works in THIS checkout on an assignment branch; revert target is the start checkpoint)'
        : ''
    }`,
    `  planning chat: ${view['planningChatEnabled'] === true ? 'enabled' : 'disabled'}`,
    `  cost: ${costLabel} over ${String(vitals.cost['turns'])} turn(s); ` +
      `rss: ${vitals.rssBytes === null ? 'n/a' : `${vitals.rssBytes} bytes`}`,
    `  checkpoints: ${checkpoints.count}`,
  ];
  const models = (view['models'] ?? {}) as Record<string, RoleModelView>;
  for (const [role, model] of Object.entries(models)) {
    const effective = model.effective ?? 'none yet';
    const desired =
      model.desired !== undefined
        ? ` — pending desired: ${model.desired.harness}/${model.desired.model}` +
          `${model.desired.effort !== undefined ? ` (effort ${model.desired.effort})` : ''}`
        : '';
    lines.push(`  model[${role}]: ${effective}${desired}`);
  }
  return lines.join('\n');
}
