import type { GitSha } from '../../domain/ids.js';
import type { RoleRoundOutcome } from '../role-runner.js';
import type { ImplementorResult } from './implementor.js';

/** Host-side deliverable invariant for every implementor completion. */
export function adjudicateImplementorDeliverable(
  result: ImplementorResult,
  round: number,
  hostHead: GitSha,
  /**
   * ROUND 8 (Blocker 1a) — the commit this round PUBLISHED for itself in its
   * `pre_verify_handoff` receipt, when one exists.
   *
   * The receipt is captured immediately after `commitAll`, BEFORE the declared
   * verification commands run. A verification command that creates and COMMITS
   * code leaves a clean tree, so the no-commit branch below saw
   * `changedFiles`/`diff`/`postVerificationDirty` all empty and completed the
   * round — and the command-created commit silently became both
   * `lastImplementationCommit` and the verifier's binding, disagreeing with the
   * receipt. That is not a race: the ordering is deterministic.
   *
   * Comparing here makes the receipt authoritative wherever it exists, the same
   * posture the resume paths already take. IMPLICATION, stated plainly: a
   * declared verification command that commits is now a HARD ERROR (the round is
   * `no_deliverable`, `runRole` throws) rather than a silent rebinding.
   */
  receipt?: GitSha,
): RoleRoundOutcome {
  // Checked BEFORE the branches below: whatever the round claims about its own
  // deliverable, a HEAD that is not what it published is not this round's work.
  if (receipt !== undefined && String(hostHead) !== String(receipt)) return 'no_deliverable';
  // F7 (round-2 #6): a post-commit provisioning failure is adjudicated on the
  // DELIVERABLE alone — it must NOT override the abnormal/no-commit verdict. When
  // the implementor DID deliver (a real committed HEAD), the round is `completed`
  // and the loop driver still HALTS on `result.provisioningFailed` with the terminal
  // `provisioning_failed` outcome. When the round did NOT deliver (abnormal stop, or
  // a remediation round with no new commit), it stays `no_deliverable` so `runRole`
  // persists that durable stage and a later resume RE-DRIVES the implementor — never
  // skips it to VERIFY a round that required `NoDeliverableError`. (An earlier
  // revision forced `completed` on any provisioning failure, persisting an unsafe
  // resume state that could bypass the verifier gate — round-2 #6.)
  if (result.stopReason !== 'end_turn') return 'no_deliverable';
  if (result.committed) {
    if (result.commitSha === undefined) return 'no_deliverable';
    if (String(result.commitSha) !== String(hostHead)) return 'no_deliverable';
    return 'completed';
  }
  // Remediation always needs a new commit. Round one alone may legitimately
  // discover that the pinned tree already satisfies the spec, but only when
  // both the recorded diff and post-verification status are clean.
  if (round > 1) return 'no_deliverable';
  if (result.changedFiles.length > 0 || result.diff.length > 0 || result.postVerificationDirty) {
    return 'no_deliverable';
  }
  return 'completed';
}
