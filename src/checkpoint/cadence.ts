/**
 * Checkpoint cadence policy (PLAN.md §12.2: "every N completed turns
 * (default 3) + before model switch, pause, verify handoff, graceful
 * stop."). Pure decision logic — no I/O, no clock, no ids — plus a small
 * stateful convenience wrapper for callers that don't want to track
 * "turns since last checkpoint" themselves.
 */
import type { CheckpointReason } from '../domain/state.js';

export interface CadencePolicy {
  /**
   * Checkpoint once this many completed turns have elapsed since the last
   * checkpoint (of ANY reason — see `CadenceTracker.recordCheckpointWritten`).
   * §12.2 default 3. 0 or negative disables turn-based cadence; the boundary
   * triggers below are unaffected either way (they always fire).
   */
  readonly everyNTurns: number;
}

export const DEFAULT_CADENCE_POLICY: CadencePolicy = { everyNTurns: 3 };

/** §12.2 cadence triggers: turn-count cadence, or one of the four safe-boundary events. */
export type CheckpointTrigger =
  | { readonly kind: 'turn_completed'; readonly completedSinceLastCheckpoint: number }
  | { readonly kind: 'pre_model_switch' }
  | { readonly kind: 'pre_pause' }
  | { readonly kind: 'pre_verify_handoff' }
  | { readonly kind: 'pre_graceful_stop' };

export interface CadenceDecision {
  readonly shouldCheckpoint: boolean;
  readonly reason?: CheckpointReason;
}

const BOUNDARY_REASON: Record<Exclude<CheckpointTrigger['kind'], 'turn_completed'>, CheckpointReason> = {
  pre_model_switch: 'pre_model_switch',
  pre_pause: 'pre_pause',
  pre_verify_handoff: 'pre_verify_handoff',
  pre_graceful_stop: 'pre_graceful_stop',
};

/**
 * Pure policy decision. The four boundary triggers ALWAYS checkpoint (§12.2
 * — a switch/pause/handoff/stop must never proceed without one); the
 * turn-count trigger fires once `completedSinceLastCheckpoint` reaches
 * `policy.everyNTurns`.
 */
export function decideCheckpoint(
  trigger: CheckpointTrigger,
  policy: CadencePolicy = DEFAULT_CADENCE_POLICY,
): CadenceDecision {
  if (trigger.kind === 'turn_completed') {
    if (policy.everyNTurns <= 0) return { shouldCheckpoint: false };
    if (trigger.completedSinceLastCheckpoint < policy.everyNTurns) return { shouldCheckpoint: false };
    return { shouldCheckpoint: true, reason: 'cadence' };
  }
  return { shouldCheckpoint: true, reason: BOUNDARY_REASON[trigger.kind] };
}

/**
 * Stateful convenience wrapper around `decideCheckpoint` for callers that
 * want the "turns since last checkpoint" bookkeeping done for them. Pure
 * counter arithmetic — no hidden clock/id/random use.
 */
export class CadenceTracker {
  #completedSinceLastCheckpoint = 0;
  readonly #policy: CadencePolicy;

  constructor(policy: CadencePolicy = DEFAULT_CADENCE_POLICY) {
    this.#policy = policy;
  }

  get completedSinceLastCheckpoint(): number {
    return this.#completedSinceLastCheckpoint;
  }

  /**
   * Call once per completed turn. Returns the cadence decision; when it is
   * due, the internal counter auto-resets (the caller is still expected to
   * actually write the checkpoint — this only tracks the policy state).
   */
  recordCompletedTurn(): CadenceDecision {
    this.#completedSinceLastCheckpoint += 1;
    const decision = decideCheckpoint(
      { kind: 'turn_completed', completedSinceLastCheckpoint: this.#completedSinceLastCheckpoint },
      this.#policy,
    );
    if (decision.shouldCheckpoint) this.#completedSinceLastCheckpoint = 0;
    return decision;
  }

  /**
   * Call after writing ANY checkpoint, including boundary-triggered ones
   * (pre_pause, pre_model_switch, ...), so the next turn-count cadence
   * window starts fresh rather than firing again a few turns early.
   */
  recordCheckpointWritten(): void {
    this.#completedSinceLastCheckpoint = 0;
  }
}
