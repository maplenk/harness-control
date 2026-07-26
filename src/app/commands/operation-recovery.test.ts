/**
 * §3A.2 pure operation recovery planner tests (C1–C9).
 */
import { describe, expect, it } from 'vitest';
import { runId } from '../../domain/ids.js';
import {
  OPERATION_RECOVERY_ACTIONS,
  planOperationRecovery,
  reconcileOperationFromRunPhase,
  type OperationRecoveryInput,
} from './operation-recovery.js';
import type { ApplicationCommandKind } from './types.js';
import type { OperationLifecycleState } from '../../persistence/operation-repository.js';
import type { RunPhase } from '../../domain/state.js';

function base(overrides: Partial<OperationRecoveryInput> & Pick<OperationRecoveryInput, 'kind'>): OperationRecoveryInput {
  return {
    state: 'accepted',
    hasDurableRound: false,
    runClaimedByLiveOwner: false,
    ...overrides,
  };
}

describe('planOperationRecovery', () => {
  it('a start with no bound runId re-drives from the stored versioned payload', () => {
    const plan = planOperationRecovery(
      base({ kind: 'start', state: 'accepted' }),
    );
    expect(plan.action).toBe('redrive_from_payload');
    expect(OPERATION_RECOVERY_ACTIONS).toContain(plan.action);
  });

  it('a start whose run sits in created/specifying re-drives coordinator drafting', () => {
    for (const phase of ['created', 'specifying'] as const) {
      const plan = planOperationRecovery(
        base({
          kind: 'start',
          state: 'running',
          runId: runId('run_start_draft'),
          runPhase: phase,
        }),
      );
      expect(plan.action, phase).toBe('redrive_coordinator_drafting');
    }
  });

  it('a run whose run sits in approved with no durable round plans handle_run, not handle_resume', () => {
    const plan = planOperationRecovery(
      base({
        kind: 'run',
        state: 'running',
        runId: runId('run_approved'),
        runPhase: 'approved',
        hasDurableRound: false,
      }),
    );
    expect(plan.action).toBe('handle_run');
    expect(plan.action).not.toBe('handle_resume');
  });

  it('a run that crashed mid-loop plans handle_resume', () => {
    const plan = planOperationRecovery(
      base({
        kind: 'run',
        state: 'running',
        runId: runId('run_mid_loop'),
        runPhase: 'implementing',
        hasDurableRound: true,
      }),
    );
    expect(plan.action).toBe('handle_resume');
  });

  it('resume plans handle_resume and recheck plans handle_recheck', () => {
    const resume = planOperationRecovery(
      base({
        kind: 'resume',
        state: 'accepted',
        runId: runId('run_resume'),
        runPhase: 'implementing',
      }),
    );
    expect(resume.action).toBe('handle_resume');

    // recheck + merge_ready would hit reconcile_only first; use a phase that
    // does not settle so the per-kind branch is exercised.
    const recheck = planOperationRecovery(
      base({
        kind: 'recheck',
        state: 'accepted',
        runId: runId('run_recheck'),
        runPhase: 'implementing',
      }),
    );
    expect(recheck.action).toBe('handle_recheck');
  });

  it('a run claimed by a live owner withholds instead of double-driving', () => {
    const plan = planOperationRecovery(
      base({
        kind: 'run',
        state: 'running',
        runId: runId('run_owned'),
        runPhase: 'approved',
        hasDurableRound: false,
        runClaimedByLiveOwner: true,
      }),
    );
    expect(plan.action).toBe('withhold_claimed');
  });

  it('a terminal operation plans no action', () => {
    for (const state of ['succeeded', 'failed', 'cancelled'] as const) {
      const plan = planOperationRecovery(
        base({
          kind: 'start',
          state: state as OperationLifecycleState,
          runId: runId('run_done'),
          runPhase: 'merge_ready',
          runClaimedByLiveOwner: true,
        }),
      );
      expect(plan.action, state).toBe('none');
    }
  });

  it('an operation whose run already advanced reconciles from durable run state instead of re-driving', () => {
    const startPlan = planOperationRecovery(
      base({
        kind: 'start',
        state: 'running',
        runId: runId('run_start_adv'),
        runPhase: 'awaiting_approval',
      }),
    );
    expect(startPlan.action).toBe('reconcile_only');

    const runPlan = planOperationRecovery(
      base({
        kind: 'run',
        state: 'running',
        runId: runId('run_run_adv'),
        runPhase: 'merge_ready',
        hasDurableRound: true,
      }),
    );
    expect(runPlan.action).toBe('reconcile_only');
  });
});

describe('reconcileOperationFromRunPhase', () => {
  it('reconcileOperationFromRunPhase settles merge_ready/failed/cancelled and returns undefined otherwise', () => {
    // start: awaiting_approval and beyond → succeeded
    const startSuccessPhases: RunPhase[] = [
      'awaiting_approval',
      'approved',
      'implementing',
      'verifying',
      'needs_remediation',
      'merge_ready',
    ];
    for (const phase of startSuccessPhases) {
      expect(reconcileOperationFromRunPhase('start', phase), phase).toBe('succeeded');
    }
    expect(reconcileOperationFromRunPhase('start', 'created')).toBeUndefined();
    expect(reconcileOperationFromRunPhase('start', 'specifying')).toBeUndefined();

    // run (and non-start): merge_ready → succeeded
    expect(reconcileOperationFromRunPhase('run', 'merge_ready')).toBe('succeeded');
    expect(reconcileOperationFromRunPhase('run', 'approved')).toBeUndefined();
    expect(reconcileOperationFromRunPhase('resume', 'merge_ready')).toBe('succeeded');

    // all kinds: failed / cancelled
    const kinds: ApplicationCommandKind[] = [
      'start',
      'run',
      'resume',
      'recheck',
      'approve',
      'cancel',
    ];
    for (const kind of kinds) {
      expect(reconcileOperationFromRunPhase(kind, 'failed')).toBe('failed');
      expect(reconcileOperationFromRunPhase(kind, 'cancelled')).toBe('cancelled');
    }

    expect(reconcileOperationFromRunPhase('start', undefined)).toBeUndefined();
    expect(reconcileOperationFromRunPhase('recheck', 'implementing')).toBeUndefined();
  });
});
