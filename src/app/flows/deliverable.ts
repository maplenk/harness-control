import type { GitSha } from '../../domain/ids.js';
import type { RoleRoundOutcome } from '../role-runner.js';
import type { ImplementorResult } from './implementor.js';

/** Host-side deliverable invariant for every implementor completion. */
export function adjudicateImplementorDeliverable(
  result: ImplementorResult,
  round: number,
  hostHead: GitSha,
): RoleRoundOutcome {
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
