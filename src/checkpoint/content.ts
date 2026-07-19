/**
 * CheckpointContent assembly helpers (PLAN.md §12.2 contract fields).
 */
import type { IsoTimestamp } from '../lib/clock.js';
import type { ArtifactHash, EventSequence, SpecHash, TurnId } from '../domain/ids.js';
import type {
  CheckpointContent,
  IncompleteOperation,
  PermissionPolicy,
  SegmentLineage,
  WorktreeState,
} from '../domain/entities.js';
import type { Operation } from '../domain/state.js';

/**
 * Honestly derive the `incomplete_operation` field (§12.2: "a mid-turn
 * checkpoint does NOT claim completed work") from the operation that was
 * actually in flight at the moment the checkpoint was triggered.
 *
 * `idle` means nothing was interrupted, so this returns `undefined` — the
 * field is OMITTED, never fabricated as a false "no operation" claim. Any
 * non-idle operation means the checkpoint is being taken MID-operation: the
 * field records exactly what was interrupted so a successor can never
 * mistake a mid-turn checkpoint for completed work.
 *
 * `startedAt` prefers, in order: an explicit caller-supplied value (the
 * caller usually has richer context, e.g. `Turn.startedAt`), the
 * operation's own timestamp when the `Operation` variant carries one
 * (`model_switch.requestedAt`), and otherwise the checkpoint trigger's own
 * timestamp as an honest fallback (never a fabricated earlier time).
 */
export function deriveIncompleteOperation(
  operationAtTrigger: Operation,
  triggerOccurredAt: IsoTimestamp,
  opts?: { readonly startedAt?: IsoTimestamp; readonly detail?: string },
): IncompleteOperation | undefined {
  if (operationAtTrigger.kind === 'idle') return undefined;
  const startedAt =
    opts?.startedAt ??
    (operationAtTrigger.kind === 'model_switch' ? operationAtTrigger.requestedAt : triggerOccurredAt);
  return {
    operation: operationAtTrigger.kind,
    startedAt,
    ...(opts?.detail !== undefined ? { detail: opts.detail } : {}),
  };
}

export interface BuildCheckpointContentInput {
  readonly lineage: SegmentLineage;
  readonly lastCompletedTurnId?: TurnId;
  readonly eventCursor: EventSequence;
  readonly specHash: SpecHash;
  readonly criterionStates: CheckpointContent['criterionStates'];
  readonly permissionPolicy: PermissionPolicy;
  readonly worktree: WorktreeState;
  readonly constraints?: readonly string[];
  readonly confirmedDecisions?: readonly string[];
  readonly unresolvedRisks?: readonly string[];
  readonly failingTests?: readonly string[];
  readonly artifactRefs?: readonly ArtifactHash[];
  readonly incompleteOperation?: IncompleteOperation;
}

/**
 * Assemble a full §12.2 CheckpointContent, defaulting the list fields to
 * empty arrays so callers cannot accidentally omit them, while requiring
 * the fields that have no safe default (lineage, spec hash, criterion
 * states, permission policy, worktree state). `incompleteOperation` passes
 * through exactly as given — present or absent, never fabricated either way
 * (pair with `deriveIncompleteOperation` to derive it honestly).
 */
export function buildCheckpointContent(input: BuildCheckpointContentInput): CheckpointContent {
  return {
    lineage: input.lineage,
    ...(input.lastCompletedTurnId !== undefined ? { lastCompletedTurnId: input.lastCompletedTurnId } : {}),
    eventCursor: input.eventCursor,
    specHash: input.specHash,
    criterionStates: input.criterionStates,
    constraints: input.constraints ?? [],
    permissionPolicy: input.permissionPolicy,
    confirmedDecisions: input.confirmedDecisions ?? [],
    unresolvedRisks: input.unresolvedRisks ?? [],
    failingTests: input.failingTests ?? [],
    artifactRefs: input.artifactRefs ?? [],
    worktree: input.worktree,
    ...(input.incompleteOperation !== undefined ? { incompleteOperation: input.incompleteOperation } : {}),
  };
}
