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
import { redactText } from '../../redaction/index.js';
import type { RoleModelSpec } from '../model-resolution.js';
import {
  AutoRespawnSignal,
  LimitPausedError,
  NoDeliverableError,
  type OrchestrationService,
} from '../service.js';
import { waitMs } from '../../supervisor/breaker.js';
import { RunOwnershipConflictError } from '../run-ownership-store.js';
import type { RoleRoundProjection } from '../projections.js';
import type { RoleRunner } from '../role-runner.js';
import {
  describeImplementorRoundDiagnostic,
  ImplementorFlow,
  verificationRunnerViolationEvent,
  type ImplementorContext,
  type ImplementorFlowOptions,
  type ImplementorResult,
  type ProvisioningFailure,
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

// F2 (§review dogfood): `NoDeliverableError` now lives in `../service.js` (thrown
// by `runRole` when it adjudicates a round `no_deliverable` ATOMICALLY with the
// round-completion write). Re-exported here so existing importers keep working.
export { NoDeliverableError } from '../service.js';

/**
 * F2: adjudicate an implementor round's deliverable — called by `runRole` at
 * round completion (ATOMIC with the stage write). A round delivers nothing it
 * stands behind when its turn ended ABNORMALLY (any non-`end_turn` stop:
 * cancelled / refusal / max_tokens / max_turn_requests — the RSS case already
 * aborted in `runRole`), when a claimed commit disagrees with the HOST-read
 * worktree HEAD (§8: never trust the agent's SHA), or when a REMEDIATION round
 * (round > 1) produced NO new commit. A FRESH round-1 clean zero-diff is a
 * legitimate pre-existing-satisfaction no-op and IS allowed into verification.
 */
export { adjudicateImplementorDeliverable } from './deliverable.js';
import { adjudicateImplementorDeliverable } from './deliverable.js';

export interface ImplementVerifyLoopDeps {
  readonly service: OrchestrationService;
  readonly worktrees: GitWorktreeManager;
  readonly ids: IdFactory;
  readonly clock: Clock;
  /**
   * P4b-2: the real-time wait before a bounded auto-respawn re-drives (the
   * breaker's exponential `backoffMs`). Defaults to `waitMs` (a real timer);
   * tests inject a no-op to avoid waiting through backoff.
   */
  readonly delay?: (ms: number) => Promise<void>;
}

export interface ImplementVerifyLoopCommonInput {
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

/**
 * A fresh loop must carry the exact pinned base. Resume adopts an existing
 * worktree and therefore neither resolves nor creates a base-bound worktree.
 */
export type ImplementVerifyLoopInput = ImplementVerifyLoopCommonInput &
  (
    | { readonly resume?: undefined; readonly baseCommit: GitSha }
    | { readonly resume: ImplementVerifyResumeInput; readonly baseCommit?: GitSha }
  );

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
 * consumed); `harness recheck` re-probes toward T24.
 * F7: `provisioning_failed` = the post-commit dependency provisioning could not be
 * PROVEN, so the round HALTED before any host self-check or verifier dispatch (no
 * `merge_ready` possible) — an operator-actionable environment failure. */
export type LoopOutcome =
  | 'merge_ready'
  | 'needs_remediation'
  | 'failed'
  | 'integration_blocked'
  | 'provisioning_failed';

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
  /** F7: present iff `outcome === 'provisioning_failed'` — the operator-actionable
   * detail of the dependency-provisioning failure that halted the round. */
  readonly provisioningFailure?: ProvisioningFailure;
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

/** A same-process re-drive re-entry override (§review-7 F1). */
interface RedriveReentry {
  readonly plan: ResumeEntryPlan;
  readonly round: RoleRoundProjection;
}

/**
 * §review-7 F1 — after a SAME-PROCESS re-drive (a `switch_model`/`switch_harness`
 * failover on a limit, OR a bounded `AutoRespawnSignal` on a crash) records the
 * successor intent, resolve WHERE the retried round re-enters from the durable
 * `RoleRoundProjection` — exactly as the cross-process `resume` path does. A
 * VERIFIER round re-enters at VERIFICATION on its immutable binding (returns the
 * override); an IMPLEMENTOR round re-enters at the loop's default implementor
 * branch (returns `undefined` — the branch is unchanged, so the proven
 * implementor-side failover/respawn path is byte-for-byte preserved).
 *
 * Without this, the re-drive returns to the loop top with `resume` undefined →
 * `skipImplement` false → it unconditionally enters the implementor branch, and
 * when the paused/crashed role was the VERIFIER the phase guard rejects it with
 * `LoopCompositionError`. This carries the failed role through the re-drive so
 * BOTH drivers (failover AND auto-respawn) re-enter the correct half.
 */
function resolveRedriveReentry(service: OrchestrationService, runId: RunId): RedriveReentry | undefined {
  const round = service.getRoleRound(runId);
  if (round === undefined) return undefined;
  const plan = resolveResumeEntry(round, service.status(runId).phase);
  // Only the verifier half needs a re-entry override; an implementor re-entry
  // (`first: 'implement'`) is the loop's default and must not be perturbed.
  return plan.first === 'verify' ? { plan, round } : undefined;
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
/**
 * ROUND 7 (Finding 1) — the durable binding a COMPLETED implementor round
 * re-enters verification against.
 *
 * The receipt (the round's own `pre_verify_handoff` checkpoint) is authoritative:
 * it is the round asserting which commit it stands behind. The round-scoped
 * `lastImplementationCommit` pointer is equally durable but written LATER by the
 * loop driver, so it is accepted only when it AGREES with the receipt — a
 * disagreement means one of the two records is stale, which is not a state to
 * silently pick a winner in.
 *
 * `undefined` = no durable source; the caller REFUSES. There is deliberately no
 * fallback to current HEAD: that is authorization by topology.
 */
function completedImplementorBinding(
  receipt: GitSha | undefined,
  persistedForRound: GitSha | undefined,
): GitSha | undefined {
  if (receipt !== undefined) {
    if (persistedForRound !== undefined && String(persistedForRound) !== String(receipt)) return undefined;
    return receipt;
  }
  return persistedForRound;
}

/**
 * ROUND 8 (Blocker 1b): returns the DURABLE BINDING it forced, not just the
 * handle. The completed-implementor branch used to force the worktree to a
 * receipt-derived commit and then RE-READ HEAD afterwards — a TOCTOU window in
 * which anything that moved HEAD between the two became the verifier binding,
 * defeating the very forcing that had just happened.
 */
async function adoptWorktree(
  deps: ImplementVerifyLoopDeps,
  input: ImplementVerifyLoopInput,
  resume: ImplementVerifyResumeInput,
): Promise<{ readonly handle: WorktreeHandle; readonly forcedBinding?: GitSha }> {
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

  let forcedBinding: GitSha | undefined;
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

  // #1: a COMPLETED implementor round re-enters at VERIFICATION (resolveResumeEntry
  // → first: 'verify') exactly like a verifier round — its deliverable is already
  // durably committed. So, like the verifier, FORCE the worktree to the EXACT
  // implementation commit and DISCARD any post-commit dirt (verifier evidence,
  // provisioning residue, an un-ignored node_modules) — NEVER WIP-commit it. Doing
  // otherwise (the old `validate()` path) would WIP-commit that dirt onto a new HEAD,
  // corrupting the branch and making unadjudicated dirt the verifier's binding. An
  // INTERRUPTED implementor round (first: 'implement') still takes the §16.3
  // WIP-commit-or-reset path below, so partial work is preserved.
  const completedImplementorResume =
    resume.round.role === 'implementor' && resume.round.stage === 'completed';
  if (resume.round.role === 'verifier' || completedImplementorResume) {
    const persisted = facts.lastImplementationCommit;
    const forced =
      resume.round.role === 'verifier'
        ? resume.round.implementationCommit
        : // ROUND 7 (Finding 1) — the COMPLETED-implementor path is bound to a
          // DURABLE source, never to bare current HEAD. It used to fall back to
          // `git rev-parse HEAD` whenever no round-scoped
          // `lastImplementationCommit` existed, so a crash between `runRole`
          // recording completion and the loop recording that pointer let ANY
          // commit subsequently appended to the worktree become the verification
          // binding. That is the original F8 defect — topology is not
          // authorization — on the other resume path.
          //
          // The round's `pre_verify_handoff` RECEIPT is consulted FIRST: it is
          // what the round itself published for the commit it stands behind.
          // `lastImplementationCommit` is accepted only when it AGREES with the
          // receipt (or when no receipt exists, since it is equally durable and
          // round-scoped). Neither present → REFUSE below.
          completedImplementorBinding(
            service.resolveRoundReceiptHead(input.runId, resume.round.round, input.assignmentId),
            persisted !== undefined && persisted.round === resume.round.round ? persisted.commit : undefined,
          );
    if (forced === undefined) {
      throw new WorktreeError(
        'requires_validation',
        resume.round.role === 'verifier'
          ? 'resume re-entry of a verifier round requires its persisted implementationCommit (W2-5 immutable binding)'
          : `resume re-entry of COMPLETED implementor round ${resume.round.round} has no durable binding: neither a ` +
            'pre_verify_handoff receipt nor a round-scoped lastImplementationCommit was recorded. Refusing rather ' +
            'than verifying whatever the worktree HEAD happens to be — a commit this round did not publish is ' +
            'never adopted. The commit is intact in the worktree for an operator to inspect.',
      );
    }
    await worktrees.discardToCommit(input.assignmentId, forced);
    // The binding the caller MUST use — never a later re-read of HEAD.
    forcedBinding = forced;
    recordValidation(
      'clean',
      resume.round.role === 'verifier'
        ? `verifier resume: worktree forced to ${String(forced)}; verifier dirt discarded, clean asserted`
        : `completed-implementor resume: worktree forced to the persisted implementation commit ${String(forced)}; ` +
            'post-commit dirt discarded, clean asserted (never WIP-committed)',
    );
  } else {
    // F8 (A) / BLOCKER-2: this is the INTERRUPTED-implementor branch — the ONE
    // place where a HEAD ahead of the checkpoint can be explained as the round's
    // own commit (cadence checkpoints fire at prompt-turn boundaries and record
    // the PRE-commit head; the implementor commits AFTER its turn loop).
    //
    // Acceptance is bound to the round's RECEIPT, never to topology: the
    // `pre_verify_handoff` checkpoint it published at its commit boundary
    // (derived from the log), else the round-scoped `lastImplementationCommit`
    // the loop driver persisted. Both are round-SCOPED, so a receipt from
    // another round authorizes nothing. With no receipt we pass nothing and
    // `validate.ts` keeps the strict any-drift-refuses policy — ancestry alone
    // must never adopt a worktree, because it proves reachability, not
    // authorship. The completed-implementor and verifier branches above are
    // unaffected: they bind to an exact commit via `discardToCommit`.
    const persistedForRound =
      facts.lastImplementationCommit?.round === resume.round.round
        ? facts.lastImplementationCommit.commit
        : undefined;
    const receiptHead =
      service.resolveRoundReceiptHead(input.runId, resume.round.round, input.assignmentId) ?? persistedForRound;
    const validation = await worktrees.validate(input.assignmentId, resume.checkpoint?.worktree, {
      ...(receiptHead !== undefined ? { acceptDriftToCommit: receiptHead } : {}),
    });
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
  const adopted = tracked.leased ? tracked : worktrees.reacquireLease(input.assignmentId);
  return { handle: adopted, ...(forcedBinding !== undefined ? { forcedBinding } : {}) };
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

  // W4-4 / review-6 F2: claim the EXCLUSIVE run-ownership lease BEFORE any
  // worktree create/adopt or role work, and CHECK the compare-and-swap result.
  // Acquisition must PRECEDE (not follow) the worktree I/O so a concurrent
  // driver of the SAME run cannot race us through worktree setup; a `false`
  // result means a still-LIVE peer already owns the run, so we WITHHOLD (an
  // honest error) rather than double-drive its worktree (attack-e content
  // double-write) — a plain fire-and-forget acquire could not close this. The
  // lease is held ACROSS child rounds — surviving the between-rounds gap where an
  // implementor's clean dispose has already removed the per-child registry record
  // but the verifier is not yet dispatched — so a concurrent `harness resume`
  // sees this LIVE owner and WITHHOLDS. Released in the outer `finally` on EVERY
  // exit (completion, pause, error, worktree-setup failure, teardown); a crash
  // leaves a dead-owner lease that a resuming process correctly reclaims.
  if (!service.acquireRunOwnership(input.runId)) {
    throw new RunOwnershipConflictError(String(input.runId));
  }

  let handle!: WorktreeHandle;
  const rounds: LoopRound[] = [];
  let mergeReadiness: MergeReadiness | undefined;
  let integrationBlocked = false;
  // F7: set when a round's post-commit dependency provisioning could not be proven
  // — the loop HALTS before the verifier and returns the terminal
  // `provisioning_failed` outcome (no `merge_ready` possible).
  let provisioningFailure: ProvisioningFailure | undefined;
  let implementationCommit!: GitSha;
  // ROUND 8 (Blocker 1b): the commit  FORCED the worktree to, when
  // it forced one. Used verbatim by the completed-implementor branch below.
  let adoptedBinding: GitSha | undefined;
  try {
    let destinationLabel: string;
    if (resume === undefined) {
      // Last primary-checkout source boundary before any implementation
      // worktree exists. A commit or edit after approval refuses here.
      const pinnedWorkspace = await service.assertOrPinLegacyCleanWorkspace(input.runId);
      if (String(input.baseCommit) !== String(pinnedWorkspace.pinnedSha)) {
        throw new WorktreeError(
          'invalid_base_commit',
          `runImplementVerifyLoop baseCommit ${input.baseCommit} does not match run ${input.runId} pinned base ${pinnedWorkspace.pinnedSha}`,
        );
      }
      // F5: branch only from the run's start-time immutable commit. The
      // worktree manager revalidates the branded value at runtime.
      handle = await worktrees.createWorktree({
        assignmentId: input.assignmentId,
        baseCommit: input.baseCommit,
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
      const adoption = await adoptWorktree(deps, input, resume);
      handle = adoption.handle;
      adoptedBinding = adoption.forcedBinding;
      const persisted = service.getImplementVerifyLoopState(input.runId);
      destinationLabel =
        input.destinationLabel ?? persisted?.destinationLabel ?? (await git.currentBranch(handle.repoRoot)) ?? 'main';
    }
    implementationCommit = handle.baseSha;
    const destinationRef =
      input.destinationRef ??
      (resume !== undefined ? service.getImplementVerifyLoopState(input.runId)?.destinationRef : undefined) ??
      'HEAD';

    const entry: ResumeEntryPlan =
      resume !== undefined ? resolveResumeEntry(resume.round, entryPhase) : { startRound: 1, first: 'implement' };

    const maxRounds = Math.max(1, input.maxRounds ?? DEFAULT_MAX_LOOP_ROUNDS);
    // A needs_remediation re-entry starts with the caller-rebuilt payload from
    // the durable T23 facts (W2-5); everything else starts clean.
    let fixRequests: readonly FixRequest[] = resume?.fixRequests ?? [];

    // W2-6 (§14/§16.2-3): while this loop owns worktrees, the service's RSS
    // watchdog must taint through THIS manager on an emergency kill and respect
    // its git-op leases before a deadline termination.
    service.attachWorktreeSupervision(worktrees);
    // §review-7 F1: a same-process re-drive (failover / bounded auto-respawn) may
    // record a VERIFIER re-entry override that the NEXT iteration consumes so the
    // verifier half re-enters at verification instead of the implementor branch.
    let redrive: RedriveReentry | undefined;
    // P4b-2: manual increment — a round that completes advances `round`; a round
    // that CRASHES under bounded auto-respawn is re-driven at the SAME `round`
    // (the `catch` below), so the retry rebuilds a fresh dispatch from the live
    // phase rather than re-running a stale one.
    for (let round = entry.startRound; round <= maxRounds; ) {
      try {
      // Re-entry for THIS iteration: a same-process re-drive override (§review-7
      // F1) wins; else the cross-process `resume` entry on its start round; else
      // a fresh round. Both non-fresh sources drive skip/forced-verifier the same
      // way, so a verifier re-drive re-enters at verification exactly like resume.
      const reentry: RedriveReentry | undefined =
        redrive ??
        (resume !== undefined && round === entry.startRound ? { plan: entry, round: resume.round } : undefined);
      redrive = undefined; // consumed for this iteration
      const resumedRound = reentry !== undefined;
      const skipImplement = reentry?.plan.first === 'verify';
      // The resumed VERIFIER round restarts on its SAME immutable binding
      // (the forced commit); an implementor-completed re-entry verifies the
      // adopted worktree's own HEAD (host-read below).
      const forcedVerifierRound =
        skipImplement && reentry !== undefined && reentry.round.role === 'verifier' ? reentry.round : undefined;

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
        const persistedScope = reentry !== undefined ? persistedTaskScope(reentry.round) : undefined;
        const context =
          persistedScope !== undefined
            ? { ...buildRoundContext(input, round, []), taskScope: persistedScope }
            : buildRoundContext(input, round, fixRequests);
        // F7 (§2.1): provision deps at the post-commit / pre-self-check boundary,
        // keyed to the manifests the implementor JUST committed. The composite,
        // idempotent, mutex+lease-held manager op is run from inside the flow after
        // the commit; a failure fails closed (self-check skipped, `provisioningFailed`
        // carried out for the halt below).
        const flow = new ImplementorFlow(handle, context, {
          ...buildImplementorOptions(input),
          // Round-2 #3: exclude node_modules from the commit only while provisioning
          // is active; `worktree.provision='none'` keeps normal `git add -A`.
          provisionActive: worktrees.provisionStrategy !== 'none',
          provisionForVerification: () => worktrees.provisionForVerification(input.assignmentId),
        });
        // F2: wrap the flow with the deliverable adjudicator — `runRole` persists
        // the verdict ATOMICALLY at round completion (no `completed`-then-overwrite
        // crash window a resume could read as "verify next"). The adjudicator reads
        // the HOST worktree HEAD itself so a claimed commit is checked against it.
        // ROUND 9 (Blocker 1): the head adjudication ACCEPTED. The verifier binds
        // to THIS, verbatim — never to a later re-read of mutable HEAD. Re-reading
        // after adjudication reopened the whole hole: a delayed verification child
        // committing in the gap became the binding despite disagreeing with the
        // receipt, and readiness could not see it because both the binding and
        // current HEAD contained the raced-in commit.
        let adjudicatedHead: GitSha | undefined;
        // ROUND 9 (LOW): why a receipt disagreement refused, so the operator is
        // told the reason rather than a bare "no deliverable adjudicated".
        let receiptMismatch: string | undefined;
        const runner: RoleRunner<ImplementorResult> = {
          role: flow.role,
          allowedShellCommands: flow.allowedShellCommands,
          run: (session) => flow.run(session),
          diagnoseRoundOutcome: (result) => receiptMismatch ?? describeImplementorRoundDiagnostic(result),
          adjudicateRoundOutcome: async (result) => {
            const hostHead = gitSha(await git.resolveSha(handle.worktreePath, 'HEAD'));
            // ROUND 8 (Blocker 1a): the round`s own receipt is authoritative.
            const receipt = service.resolveRoundReceiptHead(input.runId, round, input.assignmentId);
            if (receipt !== undefined && String(hostHead) !== String(receipt)) {
              receiptMismatch =
                `the round's worktree HEAD (${String(hostHead)}) does not match the pre_verify_handoff receipt ` +
                `it published (${String(receipt)}). A declared VERIFICATION COMMAND that creates a commit causes ` +
                'this — verification commands must observe, never author. Fix the spec so no verification command ' +
                'commits, then re-run.';
            }
            adjudicatedHead = hostHead;
            return adjudicateImplementorDeliverable(result, round, hostHead, receipt);
          },
        };
        // P4b wave 2 FAILOVER: spawn on the EFFECTIVE spec — the ladder rung a
        // prior limit escalated to (durable desired-model record), else the run
        // default. A same-process failover re-drive AND a cross-process resume
        // both land on the escalated target this way.
        const implementorSpec = service.effectiveRoleSpec(input.runId, 'implementor', input.implementor);
        implementation = await service.runRole(
          input.runId,
          runner,
          implementorSpec,
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
            // P4b-2: this loop OWNS the run lease and catches AutoRespawnSignal
            // (the `catch` above), so it opts this dispatch into bounded respawn.
            autoRespawn: true,
          },
        );
        worktrees.releaseLease(input.assignmentId);
        // P4b wave 2: the implementor ran a turn PAST any limit — the failover
        // incident is resolved, so reset the per-incident ladder position (a
        // fresh limit later restarts the ladder from the top).
        service.resetFailoverIncident(input.runId, input.assignmentId);

        // The verifier binds to the EXACT commit the deliverable gate ADJUDICATED
        // (§8: never the agent's claimed SHA; ROUND 9: never a re-read either). The
        // gate ran INSIDE runRole, ATOMIC with round completion — a no_deliverable
        // round threw `NoDeliverableError` and never reaches here — so this is the
        // head proven to match the round`s receipt. Re-reading HEAD here discarded
        // exactly that proof. The fallback is defensive: adjudication always runs
        // for an implementor round before this point.
        implementationCommit =
          adjudicatedHead ?? gitSha(await git.resolveSha(handle.worktreePath, 'HEAD'));
        // F7 (#1): PERSIST this host-verified implementation commit (ROUND-SCOPED)
        // BEFORE the fail-closed break so a completed implementor round that later
        // RESUMES (re-entering at verification) resets the adopted worktree to EXACTLY
        // it — never WIP-committing post-commit dirt onto a new, unadjudicated HEAD.
        recordImplementationCommit(deps, input, round, implementationCommit);

        // F7 (§2.4) FAIL CLOSED: the implementor's post-commit provisioning could
        // not be proven, so its self-check runner was already skipped. HALT the
        // round here — before verifier dispatch — with the terminal
        // `provisioning_failed` outcome. No verifier, no `merge_ready`; a global
        // `tsc`/`vitest` on PATH can never green this run. M9: `implementationCommit`
        // is the ACTUAL committed HEAD read above, never stale (the implementor DID
        // commit before provisioning ran).
        if (implementation.provisioningFailed !== undefined) {
          provisioningFailure = { ...implementation.provisioningFailed, round, implementationCommit };
          break;
        }

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
      } else if (forcedVerifierRound !== undefined) {
        const boundCommit = forcedVerifierRound.implementationCommit;
        if (boundCommit === undefined) {
          throw new LoopCompositionError(
            "forced verifier re-entry requires the round's persisted implementationCommit (immutable binding)",
          );
        }
        // round-5: FORCE the worktree to EXACTLY the bound implementation commit and
        // DISCARD any dirt BEFORE provisioning/dispatch — the SAME guarantee
        // cross-process adoption (`adoptWorktree`) gives. A SAME-process verifier
        // failover / bounded auto-respawn whose prior attempt moved HEAD or dirtied
        // files would otherwise be PROVISIONED + VERIFIED against a contaminated /
        // wrong state (provisioning fingerprints the current HEAD while the binding
        // is the old commit; the §16 readiness probe is too late). Idempotent for the
        // cross-process path (`adoptWorktree` already discarded to this commit).
        await worktrees.discardToCommit(input.assignmentId, boundCommit);
        implementationCommit = boundCommit;
        if (worktrees.handleFor(input.assignmentId)?.leased === true) {
          worktrees.releaseLease(input.assignmentId); // the verifier reads, never writes
        }
      } else {
        // Implementor round completed before the pause: verify ITS work. ROUND 8
        // (Blocker 1b): use the binding adoption FORCED — derived from the round's
        // durable receipt — never a fresh HEAD read. Re-reading here reopened a
        // TOCTOU window in which anything that moved HEAD after the forcing became
        // the verifier binding, discarding the guarantee just established. Adoption
        // always forces on this path, so the fallback is defensive only.
        implementationCommit =
          adoptedBinding ?? gitSha(await git.resolveSha(handle.worktreePath, 'HEAD'));
        if (worktrees.handleFor(input.assignmentId)?.leased === true) {
          worktrees.releaseLease(input.assignmentId);
        }
      }

      // --- F7 (§2.1): the ONE unconditional pre-dispatch ensure covering the
      // VERIFIER for EVERY entry — fresh, remediation, resume-after-discardToCommit,
      // and verifier failover/auto-respawn (which skip the implementor branch). The
      // manager op is idempotent: after a same-round implementor round already
      // provisioned the matching fingerprint this short-circuits on the marker;
      // otherwise (skipImplement paths, or a discardToCommit that changed HEAD) it
      // does the real work against the forced/committed HEAD. A rejection FAILS
      // CLOSED — no verifier dispatch, no `merge_ready`. -------------------------
      try {
        await worktrees.provisionForVerification(input.assignmentId);
      } catch (error) {
        // M9: implementationCommit is already the host-read HEAD for this round.
        provisioningFailure = { ...toProvisioningFailure(error, handle), round, implementationCommit };
        break;
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
        // P4b wave 2 FAILOVER: verify on the EFFECTIVE spec (ladder rung or run
        // default), same as the implementor half.
        verifierSpec: service.effectiveRoleSpec(input.runId, 'verifier', input.verifier),
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
          // P4b-2: a verifier crash auto-respawns through this loop too.
          autoRespawn: true,
        },
        ids: deps.ids,
        clock: deps.clock,
      });
      // P4b wave 2: the verifier ran a turn PAST any limit — resolve the
      // failover incident (reset the ladder position for a future fresh limit).
      service.resetFailoverIncident(input.runId, input.assignmentId);

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
      round += 1; // round completed → advance
      } catch (crashOrSignal) {
        // P4b-2 bounded AUTO-RESPAWN: a child crash under `autoRespawn=bounded`
        // whose generation-matched T13 was `restart`-advised surfaces here as an
        // `AutoRespawnSignal` (the service already durably recorded the T13 —
        // suspension=`interrupted`, generation stopped, restart window grown —
        // and raised the `respawn` alert). Anything else (a real error, a
        // breaker_open unwind, an `autoRespawn=off` interrupt) propagates and
        // unwinds the loop as before. Wait the breaker's backoff, then re-drive
        // the SAME round through the successor spine: `recordSuccessorIntent`
        // clears the `interrupted` suspension and writes the durable successor
        // marker; the retry's `runRole` spawns the successor whose `child.spawned`
        // acks it. `round` is NOT advanced — the crashed round is retried. The
        // loop is bounded by the breaker: each crash grows the durable window and
        // an exhausting crash is `breaker_open` (thrown, not signalled) → unwind.
        if (crashOrSignal instanceof LimitPausedError) {
          // P4b wave 2 FAILOVER: `#pauseForLimit` ALREADY landed `paused_limit`
          // + checkpoint + incident atomically (unchanged). Do NOT wait for the
          // probe ladder — ask the spine to self-drive the NEXT ladder rung
          // (same assignmentId). On `failover` the run is un-paused and re-driven
          // at the SAME round on the escalated target (the retry's `runRole`
          // spawns the successor whose `child.spawned` acks the marker). On
          // `wait` (policy=wait/ask) or `exhausted` (ladder ran out → T25 kept
          // the run paused_limit + alerted), unwind and leave the run paused —
          // a probe or a manual resume takes it from here.
          //
          // §review-7 F1: the re-drive re-enters at the ROLE that paused — derived
          // from the durable RoleRoundProjection via `resolveRedriveReentry` — so a
          // VERIFIER-side limit re-enters at VERIFICATION (its immutable binding),
          // never the implementor branch (which the phase guard would reject with
          // `LoopCompositionError`). This is now the proven path for BOTH halves.
          const decision = service.driveFailoverOnLimit(crashOrSignal, input.assignmentId);
          if (decision.kind !== 'failover') throw crashOrSignal;
          redrive = resolveRedriveReentry(service, input.runId);
          continue; // `round` NOT advanced — retry the paused round on the new target
        }
        // P4b-2 bounded AUTO-RESPAWN (crash): re-drive after the breaker backoff.
        if (!(crashOrSignal instanceof AutoRespawnSignal)) throw crashOrSignal;
        await (deps.delay ?? waitMs)(crashOrSignal.backoffMs);
        service.recordSuccessorIntent(input.runId);
        // §review-7 F1: a VERIFIER-side crash re-enters at verification too — the
        // same role-aware re-entry the failover path uses.
        redrive = resolveRedriveReentry(service, input.runId);
      }
    }
  } finally {
    // W4-4: release the RUN-ownership lease FIRST so a legitimate sequential
    // resume after this driver returns is never blocked by our own stale lease.
    service.releaseRunOwnership(input.runId);
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
    // W2-2 / F7: the blocked and provisioning-failed paths leave the phase where it
    // was (no false advance) — the outcome carries the distinction the phase alone
    // cannot. `provisioning_failed` takes precedence (the round never verified).
    outcome:
      provisioningFailure !== undefined
        ? 'provisioning_failed'
        : integrationBlocked
          ? 'integration_blocked'
          : outcomeOf(finalPhase),
    worktree: handle,
    implementationCommit,
    ...(mergeReadiness !== undefined ? { mergeReadiness } : {}),
    ...(provisioningFailure !== undefined ? { provisioningFailure } : {}),
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

/** F7: normalize a verifier-boundary `provisionForVerification` rejection into the
 * typed, operator-actionable `ProvisioningFailure` the loop result carries. #7: the
 * detail is REDACTED before it crosses into the durable failure the CLI prints
 * (commands.ts) — the SAME redaction the implementor-boundary path (implementor.ts)
 * already applies, so a secret-shaped install/clone error at the VERIFIER boundary is
 * never surfaced raw. Exported for a focused redaction unit test. */
export function toProvisioningFailure(error: unknown, handle: WorktreeHandle): ProvisioningFailure {
  // ROUND 8 (LOW): same as the implementor boundary — the rich message carries
  // the evidence (package, installed version, lockfile version); `.detail` is the
  // terse hint.
  const detail =
    error instanceof WorktreeError
      ? error.kind === 'provisioning_failed'
        ? error.message
        : (error.detail ?? error.message)
      : error instanceof Error
        ? error.message
        : String(error);
  return {
    kind: 'provisioning_failed',
    repoRoot: handle.repoRoot,
    worktreePath: handle.worktreePath,
    // MED-7: carry the closed-vocabulary CAUSE across this boundary too. Without
    // it the CLI fell back to the obsolete generic remedy for every VERIFIER-side
    // provisioning refusal, while the implementor-side adapter reported the
    // specific one — the same failure printing two different next steps depending
    // on which boundary happened to raise it. The cause is a constant, never free
    // text, so it needs no redaction (unlike `detail`).
    ...(error instanceof WorktreeError && error.provisioningCause !== undefined
      ? { cause: error.provisioningCause }
      : {}),
    detail: redactText(detail),
  };
}

/**
 * F7 (#1): persist the host-verified implementation commit onto the loop's durable
 * worktree facts so a COMPLETED implementor round that later RESUMES (re-entering at
 * verification) can RESET the adopted worktree to EXACTLY it — never WIP-committing
 * post-commit dirt (provisioning residue / an un-ignored node_modules) onto a new,
 * unadjudicated HEAD (see `adoptWorktree`). A no-op when the loop state / its worktree
 * facts are not yet persisted (never the case once the worktree exists).
 */
function recordImplementationCommit(
  deps: ImplementVerifyLoopDeps,
  input: ImplementVerifyLoopInput,
  round: number,
  commit: GitSha,
): void {
  const loopState = deps.service.getImplementVerifyLoopState(input.runId);
  if (loopState?.worktree === undefined) return;
  deps.service.saveImplementVerifyLoopState(input.runId, {
    ...loopState,
    // ROUND-SCOPED so a resume can only trust it for the SAME round (#1, round-4):
    // a record left stale by an earlier round never resets/verifies the wrong commit.
    worktree: { ...loopState.worktree, lastImplementationCommit: { round, commit } },
  });
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
