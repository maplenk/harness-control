/**
 * P3 IMPLEMENT → VERIFY → REMEDIATION orchestrator (PLAN §5, §16, §20 P3).
 *
 * This is the "surrounding orchestrator" the three role FLOWS deliberately
 * defer to (coordinator/implementor/verifier each own only their own turn logic
 * and never advance the workflow phase). It composes the already-built,
 * individually-tested seams into the post-approval half of the vertical slice:
 *
 *   approved → [implement in an isolated worktree] → verifying → [independent
 *   verify] → (needs_remediation → implement again, BOUNDED) → merge_ready.
 *
 * It resolves exactly the cross-flow seams no single flow owns:
 *  1. **Phase dispatch (§6.2, W2-3 pending/active split)** — the linear
 *     `approved|needs_remediation → implementing → verifying` advances the
 *     §6.3 table does NOT model are described here as `RoleDispatch`es:
 *     `service.runRole` persists the round `pending`, spawns+pins at the
 *     PREVIOUS stable phase, and advances only after pins succeed (a
 *     non-limit pin failure leaves the round retryable, nothing stranded);
 *     the §6.3 verdict transitions (T23/T24) still flow ONLY through the
 *     verifier driver's `ingest`. This orchestrator never touches the
 *     transition engine directly.
 *  2. **Commit threading** — the verifier binds to the EXACT implementation
 *     commit; this reads the worktree HEAD itself (never trusting the agent)
 *     after each implementor round and threads it into the verification binding
 *     and the §16 merge-readiness probe.
 *  3. **Worktree reuse across remediation rounds** — one worktree + one
 *     single-writer lease for the whole loop: round 1 creates it, each round
 *     re-acquires the lease, drives the implementor confined to it (round N>1
 *     with the verifier's structured fix-requests injected as the remediation
 *     payload), commits, then releases the lease so the read-only verifier can
 *     inspect the exact commit. The worktree is left on disk for the verifier
 *     and final human-controlled integration (§16) — never auto-removed here.
 *  4. **Bounded termination (§6.3)** — the loop breaks on `merge_ready` (T24)
 *     or `failed` (the engine's own remediation-bound exhaustion); it fabricates
 *     no completion and, if a caller-supplied `maxRounds` is hit first, returns
 *     honestly at `needs_remediation` rather than claiming success. A
 *     criteria-verified round whose §16 readiness is blocked by any
 *     AGENT-actionable blocker (W1-F1/W2-2, mixed sets included) loops the
 *     same bounded way — never a false `merge_ready`. A round blocked ONLY by
 *     user-actionable §16 blockers (destination dirty / base drift /
 *     conflicts) exits immediately with outcome `integration_blocked`: the
 *     run REMAINS in `verifying`, no remediation round is consumed, and
 *     `harness recheck` re-probes toward T24 (W2-2).
 *
 * H-1 isolation is untouched: every spawn still goes through the service's
 * injected `RoleAdapterFactory` (production = `defaultRoleAdapterFactory`, which
 * forwards no user `CODEX_HOME`); this module never touches `CODEX_HOME`.
 */
import type { Clock } from '../../lib/clock.js';
import type { IdFactory } from '../../lib/id-factory.js';
import { gitSha, type AssignmentId, type GitSha, type RunId, type SpecHash } from '../../domain/ids.js';
import type { AcceptanceCriterion, CheckpointContent, MergeReadiness } from '../../domain/entities.js';
import type { RunPhase } from '../../domain/state.js';
import * as git from '../../worktree/git.js';
import { GitWorktreeManager, WorktreeError, type WorktreeHandle } from '../../worktree/index.js';
import type { RoleModelSpec } from '../model-resolution.js';
import type { OrchestrationService } from '../service.js';
import type { RoleRoundProjection } from '../projections.js';
import {
  ImplementorFlow,
  verificationRunnerViolationEvent,
  type ImplementorContext,
  type ImplementorFlowOptions,
  type ImplementorResult,
  type VerificationRunner,
} from './implementor.js';
import {
  formatFixRequests,
  gitMergeReadinessProbe,
  runVerification,
  type EvidenceRecorder,
  type FixRequest,
  type RunVerificationResult,
  type UntrustedExplorationIndex,
  type VerificationBinding,
  type VerifierResumeState,
} from './verifier.js';

/**
 * Safety cap on total implement→verify rounds when the caller supplies none.
 * The AUTHORITATIVE bound is the engine's own remediation ceiling (§6.3 T23,
 * default 3 → `failed`); this only guards against a pathological non-converging
 * loop and is deliberately generous so the engine's bound governs in practice.
 */
export const DEFAULT_MAX_LOOP_ROUNDS = 12;

/** Raised when the loop is entered from a phase it cannot dispatch from. */
export class LoopCompositionError extends Error {
  override readonly name: string = 'LoopCompositionError';
}

export interface ImplementVerifyLoopDeps {
  readonly service: OrchestrationService;
  readonly worktrees: GitWorktreeManager;
  readonly ids: IdFactory;
  readonly clock: Clock;
}

export interface ImplementVerifyLoopInput {
  readonly runId: RunId;
  readonly assignmentId: AssignmentId;
  /** Resolved implementor harness/model/effort (§7 proposal → run default). */
  readonly implementor: RoleModelSpec;
  /** Resolved verifier harness/model/effort. */
  readonly verifier: RoleModelSpec;
  /** The approved immutable spec hash (§6.3 binds this exactly). */
  readonly specHash: SpecHash;
  /** The approved structured spec, serialized for implementor injection (§7). */
  readonly specDocument: string;
  readonly goal: string;
  readonly taskScope: string;
  /** Source of truth for both the implementor's context and the verifier (§7). */
  readonly criteria: readonly AcceptanceCriterion[];
  readonly constraints?: readonly string[];
  /** Coordinator exploration notes injected into IMPLEMENTOR context (§15). */
  readonly explorationArtifact?: string;
  /** Coordinator exploration index shown to the VERIFIER as untrusted (§8). */
  readonly explorationIndex?: UntrustedExplorationIndex;
  /** Sink for the verifier's OWN gathered evidence (§8, §17.1). */
  readonly evidence: EvidenceRecorder;
  /** §12.2 successor resume for the FIRST verification round (kill/restart). */
  readonly resumeFrom?: VerifierResumeState;
  /** Ref to branch the worktree from; defaults to `'HEAD'` → immutable base (§16 item 1). */
  readonly baseRef?: string;
  /** Runs the implementor's declared verification commands; injected in tests. */
  readonly runVerificationCommands?: VerificationRunner;
  readonly implementorOptions?: ImplementorFlowOptions;
  /** Label for the manual `git switch <dest>` integration hint. Default: the
   * primary repo's actual current branch (§16), falling back to `'main'` only
   * when it cannot be resolved (detached HEAD). */
  readonly destinationLabel?: string;
  /** Git ref the §16 probe resolves for base-drift/cleanliness (default `'HEAD'`). */
  readonly destinationRef?: string;
  /** Caller safety cap; the engine's remediation bound is the real terminal. */
  readonly maxRounds?: number;
  /**
   * W2-5 resume mode: re-enter the loop at implementing/verifying/
   * needs_remediation, driven ENTIRELY by the persisted `RoleRoundProjection`
   * + §12.2 checkpoint — the worktree is ADOPTED through the manager (mutex
   * + §16.3), never created. Omitted = the normal `approved` entry.
   */
  readonly resume?: ImplementVerifyResumeInput;
}

/** W2-5 resume re-entry input (see `ImplementVerifyLoopInput.resume`). */
export interface ImplementVerifyResumeInput {
  /** The persisted round being re-entered (implementor or verifier). */
  readonly round: RoleRoundProjection;
  /** The round's §12.2 pause checkpoint content, when one was recorded —
   * reconciliation baseline for the implementor, evidence carry-over source
   * for the verifier (binding-gated). */
  readonly checkpoint?: CheckpointContent;
  /** Remediation payload for a `needs_remediation` re-entry, rebuilt by the
   * caller from the durable T23 payload (the rich in-memory fix-requests
   * died with the paused process; criterion ids + §16 blockers are the
   * durable facts). */
  readonly fixRequests?: readonly FixRequest[];
}

export interface LoopRound {
  readonly round: number;
  /** Absent only for a resumed verify-only re-entry round (W2-5: the
   * implementor half ran in the PAUSED process; its durable facts live in
   * the round projection/commit, not in this process's memory). */
  readonly implementation?: ImplementorResult;
  readonly verification: RunVerificationResult;
  /** The worktree HEAD the verifier bound to this round (host-read, not agent-claimed). */
  readonly implementationCommit: GitSha;
}

/** W2-2: `integration_blocked` = criteria verified, ONLY user-actionable §16
 * blockers remain — the run REMAINS in `verifying` (no remediation round
 * consumed); `harness recheck` re-probes toward T24. */
export type LoopOutcome = 'merge_ready' | 'needs_remediation' | 'failed' | 'integration_blocked';

export interface ImplementVerifyLoopResult {
  readonly rounds: readonly LoopRound[];
  readonly finalPhase: RunPhase;
  readonly outcome: LoopOutcome;
  readonly worktree: WorktreeHandle;
  /** The final implementation commit (last round's worktree HEAD). */
  readonly implementationCommit: GitSha;
  /** The last §16 readiness report computed (criteria-verified rounds only).
   * `ready === true` iff the run reached `merge_ready` (W1-F1); a NOT-ready
   * report carries the blockers that forced the round back to T23 — or, on
   * the `integration_blocked` outcome (W2-2), the user-actionable blockers
   * the human must clear before `harness recheck`. */
  readonly mergeReadiness?: MergeReadiness;
}

/** Phases a W2-5 resume re-entry may find the run at (`approved` covers a
 * pin-window pause whose round never advanced the phase). */
const RESUME_ENTRY_PHASES: readonly RunPhase[] = [
  'approved',
  'implementing',
  'verifying',
  'needs_remediation',
];

/** What the FIRST resumed iteration does (everything after it is the normal
 * bounded loop). Derived from the persisted round + the durable phase. */
interface ResumeEntryPlan {
  readonly startRound: number;
  readonly first: 'implement' | 'verify';
}

function resolveResumeEntry(round: RoleRoundProjection, entryPhase: RunPhase): ResumeEntryPlan {
  if (round.role === 'implementor') {
    // pending/active → re-drive the implementor round itself; completed →
    // the implementor's work is durably committed, verification is next.
    return round.stage === 'completed'
      ? { startRound: round.round, first: 'verify' }
      : { startRound: round.round, first: 'implement' };
  }
  if (round.role === 'verifier') {
    // completed at needs_remediation → the T23 verdict landed; the NEXT
    // implementor round is the re-entry point. Anything else restarts
    // verification on the SAME immutable binding.
    if (round.stage === 'completed' && entryPhase === 'needs_remediation') {
      return { startRound: round.round + 1, first: 'implement' };
    }
    return { startRound: round.round, first: 'verify' };
  }
  throw new LoopCompositionError(
    `Cannot resume the implement→verify loop from a '${round.role}' round (coordinator rounds re-enter via runCoordination)`,
  );
}

/** The resumed implementor round's PERSISTED task scope (serialized round
 * inputs, W2-5) — the remediation payload it was dispatched with travels
 * inside it, so re-entry never reconstructs it from lost memory. */
function persistedTaskScope(round: RoleRoundProjection): string | undefined {
  if (round.inputs === undefined) return undefined;
  try {
    const parsed = JSON.parse(round.inputs) as { taskScope?: unknown };
    return typeof parsed.taskScope === 'string' ? parsed.taskScope : undefined;
  } catch {
    return undefined;
  }
}

/**
 * W2-5 evidence carry-over gate: checkpointed passed criteria carry into the
 * restarted verification ONLY when the checkpoint's evidence is bound to the
 * SAME spec and implementation commit the round re-verifies (the base is
 * pinned by the adopted worktree — asserted by the caller). Anything else
 * carries nothing; `worktreeClean` is NEVER carried — the §16 probe re-reads
 * it after adoption regardless.
 */
function carriedVerifierState(
  checkpoint: CheckpointContent | undefined,
  binding: VerificationBinding,
): VerifierResumeState | undefined {
  if (checkpoint === undefined) return undefined;
  const sameSpec = String(checkpoint.specHash) === String(binding.specHash);
  const sameCommit = String(checkpoint.worktree.headSha) === String(binding.implementationCommit);
  if (!sameSpec || !sameCommit) return undefined;
  return { criterionStates: checkpoint.criterionStates, evidenceRefs: checkpoint.artifactRefs };
}

/**
 * W2-5 worktree ADOPTION (resume never creates): reattach through the
 * manager when this process does not track the assignment (verifies the
 * path against `git worktree list`, mutex-serialized), then reconcile
 * role-specifically:
 *  - interrupted IMPLEMENTOR → §16.3 WIP-commit-or-reset against the
 *    checkpoint's recorded worktree state, outcome RECORDED durably on the
 *    persisted worktree facts (refuse_resume → typed refusal);
 *  - interrupted VERIFIER → force back to the persisted
 *    `implementationCommit`, DISCARD verifier dirt, assert clean
 *    (`discardToCommit`, mutex-protected) — a read-only verifier's evidence
 *    dirt is never preserved work.
 * The single-writer lease is held on return.
 */
async function adoptWorktree(
  deps: ImplementVerifyLoopDeps,
  input: ImplementVerifyLoopInput,
  resume: ImplementVerifyResumeInput,
): Promise<WorktreeHandle> {
  const { service, worktrees } = deps;
  const loopState = service.getImplementVerifyLoopState(input.runId);
  const facts = loopState?.worktree;
  if (loopState === undefined || facts === undefined) {
    throw new LoopCompositionError(
      'resume re-entry requires the worktree facts persisted at creation (W2-5) — none recorded for this run',
    );
  }
  if (worktrees.handleFor(input.assignmentId) === undefined) {
    await worktrees.reattach({
      assignmentId: input.assignmentId,
      worktreePath: facts.worktreePath,
      branch: facts.branch,
      baseSha: gitSha(String(facts.baseSha)),
    });
  }

  const recordValidation = (outcome: string, detail: string, wipCommitSha?: GitSha): void => {
    service.saveImplementVerifyLoopState(input.runId, {
      ...loopState,
      worktree: {
        ...facts,
        lastValidation: {
          outcome: outcome as 'clean' | 'wip_committed' | 'reset_and_recorded' | 'refuse_resume',
          detail,
          at: deps.clock.nowIso(),
          ...(wipCommitSha !== undefined ? { wipCommitSha } : {}),
        },
      },
    });
  };

  if (resume.round.role === 'verifier') {
    const forced = resume.round.implementationCommit;
    if (forced === undefined) {
      throw new LoopCompositionError(
        'resume re-entry of a verifier round requires its persisted implementationCommit (W2-5 immutable binding)',
      );
    }
    await worktrees.discardToCommit(input.assignmentId, forced);
    recordValidation(
      'clean',
      `verifier resume: worktree forced to ${String(forced)}; verifier dirt discarded, clean asserted`,
    );
  } else {
    const validation = await worktrees.validate(input.assignmentId, resume.checkpoint?.worktree);
    recordValidation(validation.outcome, validation.detail, validation.wipCommitSha);
    if (validation.outcome === 'refuse_resume') {
      throw new WorktreeError(
        'requires_validation',
        `§16.3 validation refused resume-in-place: ${validation.detail}`,
      );
    }
  }

  const tracked = worktrees.handleFor(input.assignmentId);
  if (tracked === undefined) {
    throw new WorktreeError('not_found', `Worktree handle vanished during adoption: ${String(input.assignmentId)}`);
  }
  return tracked.leased ? tracked : worktrees.reacquireLease(input.assignmentId);
}

/**
 * Drive the post-approval loop. Precondition: `runId` is at phase `approved`
 * (T1 already applied by the human approval step) with no active suspension —
 * or, in W2-5 resume mode, at any `RESUME_ENTRY_PHASES` member with the
 * persisted round driving where the loop re-enters. Owns the worktree
 * lifecycle for the whole loop (create in normal mode, ADOPT in resume mode);
 * on return the worktree is left on disk (lease released) for the verifier /
 * human integration (§16).
 */
export async function runImplementVerifyLoop(
  deps: ImplementVerifyLoopDeps,
  input: ImplementVerifyLoopInput,
): Promise<ImplementVerifyLoopResult> {
  const { service, worktrees } = deps;
  const resume = input.resume;

  const entryPhase = service.status(input.runId).phase;
  if (resume === undefined) {
    if (entryPhase !== 'approved') {
      throw new LoopCompositionError(
        `runImplementVerifyLoop must start at phase 'approved', got '${entryPhase}' (approval is T1, outside this loop)`,
      );
    }
  } else if (!RESUME_ENTRY_PHASES.includes(entryPhase)) {
    throw new LoopCompositionError(
      `resume re-entry is legal at ${RESUME_ENTRY_PHASES.join('/')}, got '${entryPhase}'`,
    );
  }

  let handle: WorktreeHandle;
  let destinationLabel: string;
  if (resume === undefined) {
    handle = await worktrees.createWorktree({
      assignmentId: input.assignmentId,
      ...(input.baseRef !== undefined ? { baseRef: input.baseRef } : {}),
    });
    // §16: the manual `git switch <dest>` hint targets the primary checkout's
    // ACTUAL branch (read from the repo, never trusting a hardcoded 'main'); an
    // explicit caller `destinationLabel` still wins, and a detached HEAD falls
    // back to 'main'. Resolved once — the primary branch is stable across rounds.
    destinationLabel = input.destinationLabel ?? (await git.currentBranch(handle.repoRoot)) ?? 'main';
    // W2-5: persist the loop binding + worktree facts AT CREATION so a later,
    // separate process can adopt the worktree and re-enter this loop.
    service.saveImplementVerifyLoopState(input.runId, {
      assignmentId: input.assignmentId,
      implementor: input.implementor,
      verifier: input.verifier,
      specHash: input.specHash,
      taskScope: input.taskScope,
      destinationLabel,
      destinationRef: input.destinationRef ?? 'HEAD',
      worktree: {
        assignmentId: input.assignmentId,
        repoRoot: handle.repoRoot,
        worktreePath: handle.worktreePath,
        branch: handle.branch,
        baseSha: handle.baseSha,
        createdAt: handle.createdAt,
      },
    });
  } else {
    handle = await adoptWorktree(deps, input, resume);
    const persisted = service.getImplementVerifyLoopState(input.runId);
    destinationLabel =
      input.destinationLabel ?? persisted?.destinationLabel ?? (await git.currentBranch(handle.repoRoot)) ?? 'main';
  }
  const destinationRef =
    input.destinationRef ??
    (resume !== undefined ? service.getImplementVerifyLoopState(input.runId)?.destinationRef : undefined) ??
    'HEAD';

  const entry: ResumeEntryPlan =
    resume !== undefined ? resolveResumeEntry(resume.round, entryPhase) : { startRound: 1, first: 'implement' };

  const maxRounds = Math.max(1, input.maxRounds ?? DEFAULT_MAX_LOOP_ROUNDS);
  const rounds: LoopRound[] = [];
  // A needs_remediation re-entry starts with the caller-rebuilt payload from
  // the durable T23 facts (W2-5); everything else starts clean.
  let fixRequests: readonly FixRequest[] = resume?.fixRequests ?? [];
  let mergeReadiness: MergeReadiness | undefined;
  let integrationBlocked = false;
  let implementationCommit: GitSha = handle.baseSha;

  // W2-6 (§14/§16.2-3): while this loop owns worktrees, the service's RSS
  // watchdog must taint through THIS manager on an emergency kill and respect
  // its git-op leases before a deadline termination.
  service.attachWorktreeSupervision(worktrees);
  try {
    for (let round = entry.startRound; round <= maxRounds; round += 1) {
      const resumedRound = resume !== undefined && round === entry.startRound;
      const skipImplement = resumedRound && entry.first === 'verify';
      // The resumed VERIFIER round restarts on its SAME immutable binding
      // (the forced commit); an implementor-completed re-entry verifies the
      // adopted worktree's own HEAD (host-read below).
      const forcedVerifierRound =
        skipImplement && resume !== undefined && resume.round.role === 'verifier' ? resume.round : undefined;

      let implementation: ImplementorResult | undefined;
      if (!skipImplement) {
        // --- Dispatch the implementor round (W2-3 pending/active split) ------
        // The workflow REMAINS at its previous stable phase
        // (approved/needs_remediation) through spawn+pin; `runRole` advances
        // to `implementing` only after every §11.2 pin succeeded. A non-limit
        // pin failure leaves the pending round retryable with no phase moved.
        const phaseBefore = service.status(input.runId).phase;
        if (
          phaseBefore !== 'approved' &&
          phaseBefore !== 'needs_remediation' &&
          phaseBefore !== 'implementing'
        ) {
          throw new LoopCompositionError(
            `Cannot dispatch the implementor from phase '${phaseBefore}' (expected approved/needs_remediation)`,
          );
        }

        // --- Implement (confined to the ONE worktree, single-writer lease) ---
        ensureLeased(worktrees, input.assignmentId);
        // A resumed implementor round re-runs its PERSISTED serialized task
        // scope verbatim (the remediation payload travels inside it, W2-5);
        // fresh rounds build it from this loop's own fix-requests.
        const persistedScope = resumedRound ? persistedTaskScope(resume!.round) : undefined;
        const context =
          persistedScope !== undefined
            ? { ...buildRoundContext(input, round, []), taskScope: persistedScope }
            : buildRoundContext(input, round, fixRequests);
        const flow = new ImplementorFlow(handle, context, buildImplementorOptions(input));
        implementation = await service.runRole(
          input.runId,
          flow,
          input.implementor,
          handle.worktreePath,
          {
            round,
            // Already at `implementing` (e.g. a re-entry): no advance to take.
            ...(phaseBefore !== 'implementing'
              ? { advance: { from: phaseBefore, to: 'implementing' as const } }
              : {}),
            completionAdvance: { from: 'implementing', to: 'verifying' },
            inputs: JSON.stringify({ taskScope: context.taskScope }),
            specHash: input.specHash,
            baseCommit: handle.baseSha,
            criterionIds: input.criteria.map((c) => c.id),
            assignmentId: input.assignmentId,
          },
        );
        worktrees.releaseLease(input.assignmentId);

        // W3-1: the confinement guard's primary-checkout drift is a durable
        // INCIDENT — append it NOW (before the verifier round renders any
        // verdict), then thread the violation into the §16 readiness gate
        // below so an all-verified round still blocks (T23, never T24). A
        // violation detected before a pause that later re-enters verify-only
        // (W2-5) is carried by this durable event only — the in-process
        // readiness wire covers the live path.
        if (implementation.runnerViolation !== undefined) {
          service.ingest(
            verificationRunnerViolationEvent({
              runId: input.runId,
              assignmentId: input.assignmentId,
              violation: implementation.runnerViolation,
              ids: deps.ids,
              clock: deps.clock,
            }),
          );
        }

        // The verifier binds to the EXACT commit — read the worktree HEAD
        // ourselves (§8: never trust the agent's claimed SHA). After a round
        // that committed nothing new, HEAD is unchanged from the prior round.
        implementationCommit = gitSha(await git.resolveSha(handle.worktreePath, 'HEAD'));
      } else if (forcedVerifierRound !== undefined) {
        // Adoption already forced the worktree to this exact commit and
        // asserted clean; the binding below re-states it immutably.
        implementationCommit = forcedVerifierRound.implementationCommit!;
        if (worktrees.handleFor(input.assignmentId)?.leased === true) {
          worktrees.releaseLease(input.assignmentId); // the verifier reads, never writes
        }
      } else {
        // Implementor round completed before the pause: verify ITS work — the
        // adopted worktree's host-read HEAD (a WIP reconciliation commit, if
        // one was taken, is preserved work and part of that HEAD).
        implementationCommit = gitSha(await git.resolveSha(handle.worktreePath, 'HEAD'));
        if (worktrees.handleFor(input.assignmentId)?.leased === true) {
          worktrees.releaseLease(input.assignmentId);
        }
      }

      // --- Independently verify (T23/T24). W2-3 split: the run stays at
      // `implementing` through the verifier's spawn+pin; runVerification's
      // dispatch advances `implementing → verifying` after pins succeed. ---
      const binding: VerificationBinding = {
        assignmentId: input.assignmentId,
        specHash: input.specHash,
        baseCommit: handle.baseSha,
        implementationCommit,
        repoRoot: handle.repoRoot,
        worktreeBranch: handle.branch,
        destinationRef: destinationLabel,
      };
      const probe = gitMergeReadinessProbe({
        repoRoot: handle.repoRoot,
        worktreePath: handle.worktreePath,
        baseCommit: handle.baseSha,
        verifiedCommit: implementationCommit,
        destinationRef,
      });
      const phaseBeforeVerify = service.status(input.runId).phase;
      // §12.2 evidence carry-over: a resumed VERIFIER round carries its own
      // checkpoint's passed criteria ONLY under the same-binding gate; the
      // caller-supplied `resumeFrom` still serves the first FRESH round.
      const resumeFrom =
        forcedVerifierRound !== undefined
          ? carriedVerifierState(resume?.checkpoint, binding)
          : round === 1 && !resumedRound
            ? input.resumeFrom
            : undefined;
      const verification = await runVerification({
        engine: service,
        runId: input.runId,
        verifierSpec: input.verifier,
        cwd: handle.worktreePath,
        binding,
        criteria: input.criteria,
        evidence: input.evidence,
        ...(input.explorationIndex !== undefined ? { explorationIndex: input.explorationIndex } : {}),
        ...(resumeFrom !== undefined ? { resumeFrom } : {}),
        mergeReadinessProbe: probe,
        // W2-2: the probe's destination ref travels with a blocked readiness
        // so `harness recheck` re-runs the SAME probe from a fresh process.
        probeDestinationRef: destinationRef,
        approvedSpecHash: input.specHash,
        // W3-1: a runner-confinement violation from THIS round's implementor
        // half blocks the §16 readiness gate.
        ...(implementation?.runnerViolation !== undefined
          ? { runnerViolation: implementation.runnerViolation }
          : {}),
        dispatch: {
          round,
          // A resumed verifier round may already sit at `verifying` (its
          // original dispatch advanced the phase before the pause).
          ...(phaseBeforeVerify === 'implementing'
            ? { advance: { from: 'implementing' as const, to: 'verifying' as const } }
            : {}),
          inputs: JSON.stringify({ implementationCommit: String(implementationCommit) }),
          specHash: input.specHash,
          baseCommit: handle.baseSha,
          implementationCommit,
          criterionIds: input.criteria.map((c) => c.id),
          assignmentId: input.assignmentId,
        },
        ids: deps.ids,
        clock: deps.clock,
      });

      rounds.push({
        round,
        ...(implementation !== undefined ? { implementation } : {}),
        verification,
        implementationCommit,
      });
      if (verification.mergeReadiness !== undefined) mergeReadiness = verification.mergeReadiness;

      // W2-2: criteria verified but ONLY user-actionable §16 blockers remain
      // — the driver recorded `merge.readiness.blocked` + the recheck
      // read-model and the run REMAINS in `verifying` with no remediation
      // round consumed. Exit immediately WITHOUT burning further rounds
      // (another implementor round cannot clear a dirty destination);
      // `harness recheck` re-probes toward T24 once the human clears them.
      if (verification.integrationBlocked) {
        integrationBlocked = true;
        break;
      }

      // W1-F1: `all_verified` alone is NOT merge_ready — the §16 readiness
      // gate may have routed the round to T23 (agent-actionable integration
      // blockers, W2-2). Exit only on what the engine actually holds:
      // `merge_ready` (T24 applied) or `failed` (remediation bound
      // exhausted). Anything else keeps iterating bounded, with this round's
      // fix-requests (criterion AND/OR integration_blocker) as the
      // remediation payload.
      const phaseAfterVerify = service.status(input.runId).phase;
      if (phaseAfterVerify === 'merge_ready' || phaseAfterVerify === 'failed') break;
      fixRequests = verification.fixRequests;
    }
  } finally {
    service.detachWorktreeSupervision();
    // Leave the worktree on disk for the verifier / human integration (§16);
    // just make sure the single-writer lease is not left dangling.
    const current = worktrees.handleFor(input.assignmentId);
    if (current?.leased === true) worktrees.releaseLease(input.assignmentId);
  }

  const finalPhase = service.status(input.runId).phase;
  return {
    rounds,
    finalPhase,
    // W2-2: the blocked path leaves the phase at `verifying` on purpose — the
    // outcome carries the distinction the phase alone cannot.
    outcome: integrationBlocked ? 'integration_blocked' : outcomeOf(finalPhase),
    worktree: handle,
    implementationCommit,
    ...(mergeReadiness !== undefined ? { mergeReadiness } : {}),
  };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
function outcomeOf(phase: RunPhase): LoopOutcome {
  if (phase === 'merge_ready') return 'merge_ready';
  if (phase === 'failed') return 'failed';
  return 'needs_remediation';
}

function ensureLeased(worktrees: GitWorktreeManager, assignmentId: AssignmentId): void {
  const handle = worktrees.handleFor(assignmentId);
  if (handle === undefined) {
    throw new WorktreeError('not_found', `No tracked worktree for assignment: ${String(assignmentId)}`);
  }
  if (!handle.leased) worktrees.reacquireLease(assignmentId);
}

function buildImplementorOptions(input: ImplementVerifyLoopInput): ImplementorFlowOptions {
  return {
    ...(input.implementorOptions ?? {}),
    ...(input.runVerificationCommands !== undefined
      ? { runVerification: input.runVerificationCommands }
      : {}),
  };
}

/**
 * The implementor context for a round. Round 1 is the base task; round N>1
 * appends the verifier's structured fix-requests (the REMEDIATION payload,
 * §8) to the task scope so the implementor addresses exactly what independent
 * verification blocked — while the immutable spec/criteria stay untouched.
 */
function buildRoundContext(
  input: ImplementVerifyLoopInput,
  round: number,
  fixRequests: readonly FixRequest[],
): ImplementorContext {
  const taskScope =
    round === 1 || fixRequests.length === 0
      ? input.taskScope
      : `${input.taskScope}\n\n## Remediation (round ${round}) — address the independent verifier's blocking findings\n${formatFixRequests(
          fixRequests,
        )}`;
  return {
    goal: input.goal,
    specHash: input.specHash,
    specDocument: input.specDocument,
    criteria: input.criteria,
    ...(input.constraints !== undefined ? { constraints: input.constraints } : {}),
    taskScope,
    ...(input.explorationArtifact !== undefined ? { explorationArtifact: input.explorationArtifact } : {}),
  };
}
