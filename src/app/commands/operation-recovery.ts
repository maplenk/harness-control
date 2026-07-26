/**
 * Pure operation recovery planner (§3A.2 bullets 6–7).
 *
 * Maps (operation kind × operation state × durable run stage × lease) → a
 * recovery ACTION TAG. No I/O, no service/CLI wiring — later slices invoke
 * the real `handleRun` / `handleResume` / `handleRecheck` paths from the
 * tags this module returns.
 *
 * Imports from persistence/domain are type-only so the module stays pure and
 * never inverts the existing layering.
 */
import type { ApplicationCommandKind } from './types.js';
import type { OperationLifecycleState, TerminalOperationState } from '../../persistence/operation-repository.js';
import type { RunId } from '../../domain/ids.js';
import type { RunPhase } from '../../domain/state.js';

export const OPERATION_RECOVERY_ACTIONS = [
  'redrive_from_payload',
  'redrive_coordinator_drafting',
  'handle_run',
  'handle_resume',
  'handle_recheck',
  'reconcile_only',
  'withhold_claimed',
  'none',
] as const;

export type OperationRecoveryAction = (typeof OPERATION_RECOVERY_ACTIONS)[number];

export interface OperationRecoveryInput {
  readonly kind: ApplicationCommandKind;
  readonly state: OperationLifecycleState;
  readonly runId?: RunId;
  readonly runPhase?: RunPhase;
  /** True when the run already has a durable implement/verify round. */
  readonly hasDurableRound: boolean;
  /** True when the run-ownership lease is held by a live peer process. */
  readonly runClaimedByLiveOwner: boolean;
}

export interface OperationRecoveryPlan {
  readonly action: OperationRecoveryAction;
  readonly reason: string;
}

const TERMINAL: readonly OperationLifecycleState[] = ['succeeded', 'failed', 'cancelled'];

function isTerminal(state: OperationLifecycleState): state is TerminalOperationState {
  return (TERMINAL as readonly OperationLifecycleState[]).includes(state);
}

/**
 * When the run advanced but the operation result never persisted, settle the
 * operation from the run's durable phase — never double-drive.
 *
 * - kind `start`: awaiting_approval and beyond → succeeded
 * - kind `run` (and others): merge_ready → succeeded
 * - all kinds: phase failed → failed, phase cancelled → cancelled
 * - undefined when there is nothing to settle (normal per-command re-drive)
 */
export function reconcileOperationFromRunPhase(
  kind: ApplicationCommandKind,
  runPhase: RunPhase | undefined,
): TerminalOperationState | undefined {
  if (runPhase === undefined) return undefined;
  if (runPhase === 'failed') return 'failed';
  if (runPhase === 'cancelled') return 'cancelled';

  if (kind === 'start') {
    const startSuccess: readonly RunPhase[] = [
      'awaiting_approval',
      'approved',
      'implementing',
      'verifying',
      'needs_remediation',
      'merge_ready',
    ];
    if (startSuccess.includes(runPhase)) return 'succeeded';
    return undefined;
  }

  if (runPhase === 'merge_ready') return 'succeeded';
  return undefined;
}

/**
 * Recovery precedence:
 * 1. terminal operation → none
 * 2. run claimed by a live owner → withhold_claimed
 * 3. non-undefined reconcile target → reconcile_only
 * 4. per-kind re-drive
 */
export function planOperationRecovery(input: OperationRecoveryInput): OperationRecoveryPlan {
  if (isTerminal(input.state)) {
    return { action: 'none', reason: 'operation already terminal' };
  }

  if (input.runClaimedByLiveOwner) {
    return {
      action: 'withhold_claimed',
      reason: 'run-ownership lease held by a live owner',
    };
  }

  const reconcileTarget = reconcileOperationFromRunPhase(input.kind, input.runPhase);
  if (reconcileTarget !== undefined) {
    return {
      action: 'reconcile_only',
      reason: `run phase '${input.runPhase}' already settles the operation to '${reconcileTarget}'`,
    };
  }

  switch (input.kind) {
    case 'start': {
      if (input.runId === undefined) {
        return {
          action: 'redrive_from_payload',
          reason: 'start never bound a runId; re-drive from stored versioned payload',
        };
      }
      if (input.runPhase === 'created' || input.runPhase === 'specifying') {
        return {
          action: 'redrive_coordinator_drafting',
          reason: `start run sits in '${input.runPhase}'; re-drive coordinator drafting`,
        };
      }
      return {
        action: 'redrive_from_payload',
        reason: 'start with bound run but no reconcile target; re-drive from payload',
      };
    }
    case 'run': {
      if (input.hasDurableRound) {
        return {
          action: 'handle_resume',
          reason: 'run crashed mid-loop (durable round exists); re-drive via handle_resume',
        };
      }
      if (input.runPhase === 'approved') {
        return {
          action: 'handle_run',
          reason: 'run sits in approved with no durable round; re-invoke handle_run',
        };
      }
      return {
        action: 'redrive_from_payload',
        reason: 'run command with no durable round and phase not approved; re-drive from payload',
      };
    }
    case 'resume':
      return { action: 'handle_resume', reason: 'resume command re-drives via handle_resume' };
    case 'recheck':
      return { action: 'handle_recheck', reason: 'recheck command re-drives via handle_recheck' };
    case 'reviseSpec':
    case 'approve':
    case 'pause':
    case 'cancel':
    case 'breakerReset':
    case 'switchModel':
    case 'respondToPermission':
      return {
        action: 'redrive_from_payload',
        reason: `kind '${input.kind}' re-drives from the stored versioned payload`,
      };
    default: {
      // Exhaustiveness: ApplicationCommandKind is a closed set.
      const _exhaustive: never = input.kind;
      return {
        action: 'redrive_from_payload',
        reason: `unknown kind '${String(_exhaustive)}'; re-drive from payload`,
      };
    }
  }
}
