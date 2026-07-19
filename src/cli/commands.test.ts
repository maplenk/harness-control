/**
 * CLI command execution (PLAN §18) against a FAKE-backed engine: a real
 * `OrchestrationService` over a temp SQLite DB, with an adapter factory that
 * THROWS if used — proving these commands drive the engine without ever
 * spawning a provider. Asserts the stable `--json` payload shapes and exit codes
 * that scripts (and the P3 acceptance smoke) depend on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import {
  assignmentId,
  criterionId,
  gitSha,
  mergeReadinessId,
  runId as toRunId,
  specHash,
  specVersionId,
  verificationId,
} from '../domain/ids.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { OrchestrationService, type RoleAdapterFactory, type SpecDraftState } from '../app/index.js';
import type { RunId } from '../domain/ids.js';
import { executeCommand } from './commands.js';

const NO_SPAWN_FACTORY: RoleAdapterFactory = {
  create() {
    throw new Error('CLI command tests must not spawn adapters');
  },
};

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

async function setup(): Promise<{ service: OrchestrationService; db: TestDatabaseHandle['db'] }> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: NO_SPAWN_FACTORY,
  });
  return { service, db: handle.db };
}

/** Create a run and drive it to `awaiting_approval` via the linear dispatch advances. */
function toAwaitingApproval(service: OrchestrationService): RunId {
  const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  return runId;
}

/** A minimal persisted coordinator draft (what `start` writes) for W1-F3 binding tests. */
function draftState(version: string, hash: string, revision = 1): SpecDraftState {
  return {
    specVersionId: specVersionId(version),
    specHash: specHash(hash),
    canonicalSpec: `{"goal":"g","rev":${revision}}`,
    goal: 'g',
    criteria: [
      {
        id: criterionId('AC-1'),
        description: 'd',
        verificationCommands: ['echo ok'],
        expectedEvidence: 'exit code 0',
      },
    ],
    proposedImplementorProfile: 'implementor',
    proposedVerifierProfile: 'verifier',
    revision,
  };
}

// NOTE: `start` and the approved `run` DRIVE the P3 role flows through the
// service (coordinator draft; implement→verify→merge-readiness). Because that
// spawns adapters and touches a real worktree, the end-to-end wiring is proven
// in `commands.wiring.test.ts` (in-process fakes + a temp git repo). The tests
// here stay on the pure command surface a `no-spawn` engine can assert.

// ---------------------------------------------------------------------------
describe('executeCommand — approve (explicit human only; §4.1/§18)', () => {
  it('refuses production approve without --spec-hash (exit 2)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    const out = await executeCommand(
      service,
      db,
      { kind: 'approve', json: true, runId, specVersionId: specVersionId('spec_1'), testApprove: false },
      {},
    );
    expect(out.exitCode).toBe(2);
    expect(out.json).toMatchObject({ command: 'approve', ok: false, error: 'spec_hash_required' });
    expect(service.status(runId).phase).toBe('awaiting_approval'); // unchanged
  });

  it('refuses --test-approve unless HARNESS_TEST_MODE=1 (exit 2)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    const out = await executeCommand(
      service,
      db,
      { kind: 'approve', json: true, runId, specVersionId: specVersionId('spec_1'), testApprove: true },
      {},
    );
    expect(out.exitCode).toBe(2);
    expect(out.json).toMatchObject({ refused: 'test_approve_guard' });
    expect(service.status(runId).phase).toBe('awaiting_approval');
  });

  it('applies --test-approve when HARNESS_TEST_MODE=1 (T1 → approved)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    const out = await executeCommand(
      service,
      db,
      { kind: 'approve', json: true, runId, specVersionId: specVersionId('spec_1'), testApprove: true },
      { HARNESS_TEST_MODE: '1' },
    );
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({ outcome: 'applied', transitionId: 'T1', phase: 'approved', mode: 'test' });
    expect(service.status(runId).phase).toBe('approved');
  });

  it('applies a production approve with --spec-hash (human path)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    const out = await executeCommand(
      service,
      db,
      { kind: 'approve', json: true, runId, specVersionId: specVersionId('spec_1'), specHash: specHash('h1'), testApprove: false },
      {},
    );
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({ outcome: 'applied', transitionId: 'T1', mode: 'human', specHash: 'h1' });
    expect(service.status(runId).approvedSpecHash).toBe('h1');
  });

  it('reports the engine rejection when approving outside awaiting_approval (exit 1)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(
      service,
      db,
      { kind: 'approve', json: true, runId, specVersionId: specVersionId('spec_1'), specHash: specHash('h1'), testApprove: false },
      {},
    );
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ outcome: 'rejected', reason: 'precondition_failed' });
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — approve binds the drafted spec (W1-F3)', () => {
  it('refuses a --spec-hash that mismatches the draft (exit 2, both hashes shown)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    service.saveSpecDraft(runId, draftState('spec_1', 'draft_hash_1'));
    const out = await executeCommand(
      service,
      db,
      { kind: 'approve', json: true, runId, specVersionId: specVersionId('spec_1'), specHash: specHash('wrong_hash'), testApprove: false },
      {},
    );
    expect(out.exitCode).toBe(2);
    expect(out.json).toMatchObject({
      refused: 'approved_hash_mismatch',
      providedSpecHash: 'wrong_hash',
      draftSpecHash: 'draft_hash_1',
    });
    expect(out.text).toContain('wrong_hash');
    expect(out.text).toContain('draft_hash_1');
    expect(service.status(runId).phase).toBe('awaiting_approval'); // unchanged
  });

  it('omitting --spec-hash binds the draft hash (T1 → approved)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    service.saveSpecDraft(runId, draftState('spec_1', 'draft_hash_1'));
    const out = await executeCommand(
      service,
      db,
      { kind: 'approve', json: true, runId, specVersionId: specVersionId('spec_1'), testApprove: false },
      {},
    );
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({ outcome: 'applied', transitionId: 'T1', specHash: 'draft_hash_1', mode: 'human' });
    expect(service.status(runId).approvedSpecHash).toBe('draft_hash_1');
  });

  it('refuses a --spec-version that mismatches the draft (exit 2)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    service.saveSpecDraft(runId, draftState('spec_1', 'draft_hash_1'));
    const out = await executeCommand(
      service,
      db,
      { kind: 'approve', json: true, runId, specVersionId: specVersionId('spec_other'), testApprove: false },
      {},
    );
    expect(out.exitCode).toBe(2);
    expect(out.json).toMatchObject({
      refused: 'approved_version_mismatch',
      providedSpecVersionId: 'spec_other',
      draftSpecVersionId: 'spec_1',
    });
    expect(service.status(runId).phase).toBe('awaiting_approval');
  });

  it('--test-approve binds the REAL draft hash when a draft exists (no synthetic hash)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    service.saveSpecDraft(runId, draftState('spec_1', 'draft_hash_1'));
    const out = await executeCommand(
      service,
      db,
      { kind: 'approve', json: true, runId, specVersionId: specVersionId('spec_1'), testApprove: true },
      { HARNESS_TEST_MODE: '1' },
    );
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({ outcome: 'applied', transitionId: 'T1', specHash: 'draft_hash_1', mode: 'test' });
    expect(service.status(runId).approvedSpecHash).toBe('draft_hash_1');
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — run refuses on approved-hash drift (W1-F3)', () => {
  it('refuses when the drafted hash no longer matches the bound approval (exit 1, both hashes shown)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    service.saveSpecDraft(runId, draftState('spec_1', 'draft_hash_1'));
    service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: specHash('draft_hash_1') });
    // A superseding draft lands AFTER approval (revision drift): run must refuse.
    service.saveSpecDraft(runId, draftState('spec_2', 'draft_hash_2', 2));
    const out = await executeCommand(
      service,
      db,
      { kind: 'run', json: true, runId, implementor: { harness: 'codex', model: 'x' }, verifier: { harness: 'claude', model: 'opus' } },
      {},
    );
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({
      command: 'run',
      error: 'approved_spec_mismatch',
      approvedSpecHash: 'draft_hash_1',
      draftSpecHash: 'draft_hash_2',
    });
    expect(service.status(runId).phase).toBe('approved'); // nothing ran
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — spec revise', () => {
  it('applies T2 (awaiting_approval → specifying); without a flow runtime it says the re-run is unavailable', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    const out = await executeCommand(service, db, { kind: 'spec_revise', json: true, runId, feedback: 'tighten criteria' }, {});
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({ command: 'spec_revise', outcome: 'applied', transitionId: 'T2', phase: 'specifying' });
    // W1-F7: no `flows` injected here — the output must say so, not pretend a
    // revision round completed (the full round is proven in commands.wiring.test.ts).
    expect(out.json).toMatchObject({ coordinatorRerun: 'unavailable' });
    expect(out.text).toContain('UNAVAILABLE');
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — run', () => {
  it('refuses when the run is not approved (exit 1)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    const out = await executeCommand(
      service,
      db,
      { kind: 'run', json: true, runId, implementor: { harness: 'codex', model: 'x' }, verifier: { harness: 'claude', model: 'opus' } },
      {},
    );
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ command: 'run', error: 'not_approved', phase: 'awaiting_approval' });
  });

  it('requires explicit profiles when none are passed, once approved (exit 2)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: specHash('h1') });
    // No --implementor/--verifier: rejected before any flow work (exit 2).
    const out = await executeCommand(service, db, { kind: 'run', json: true, runId }, {});
    expect(out.exitCode).toBe(2);
    expect(out.json).toMatchObject({ error: 'missing_profiles' });
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — status', () => {
  it('reports phase/suspension/eta/vitals/checkpoints for a fresh run', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(service, db, { kind: 'status', json: true, runId }, {});
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({
      command: 'status',
      phase: 'created',
      suspension: 'none',
      uiState: 'idle',
      eta: null, // §13: only 'unknown' while paused_limit
      childActive: false,
    });
    const vitals = out.json['vitals'] as { rssBytes: number | null; cost: { totalCostUsd: number } };
    expect(vitals.rssBytes).toBeNull();
    expect(vitals.cost.totalCostUsd).toBe(0);
    expect(out.json['checkpoints']).toEqual({ count: 0, entries: [] });
  });

  it('reports a RunNotFoundError as a clean exit 1', async () => {
    const { service, db } = await setup();
    const out = await executeCommand(service, db, { kind: 'status', json: true, runId: toRunId('nope') }, {});
    expect(out.exitCode).toBe(1);
    expect((out.json['error'] as { name: string }).name).toBe('RunNotFoundError');
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — suspension controls', () => {
  it('reports resume on a non-paused run as a clean error (exit 1)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {});
    expect(out.exitCode).toBe(1);
    expect((out.json['error'] as { name: string }).name).toBe('WorkflowAdvanceError');
  });

  it('reports pause with no active child as an engine rejection (exit 1)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(service, db, { kind: 'pause', json: true, runId }, {});
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ command: 'pause', outcome: 'rejected' });
  });

  it('reports breaker reset outside breaker_open as a rejection (exit 1)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(service, db, { kind: 'breaker_reset', json: true, runId }, {});
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ command: 'breaker_reset', outcome: 'rejected' });
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — recheck (W2-2 §16 readiness re-probe)', () => {
  it('refuses when no blocked merge-readiness is recorded (exit 1)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(service, db, { kind: 'recheck', json: true, runId }, {});
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ command: 'recheck', ok: false, error: 'not_blocked' });
    expect(out.text).toContain('no blocked §16 merge-readiness');
  });

  it('refuses when the run is not in verifying (the blocked wait state no longer holds; exit 1)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    // A synthetic persisted blocked state on a run still at `created`: the
    // phase guard must refuse before any worktree/probe work.
    service.saveMergeReadinessBlocked(runId, syntheticBlockedState(runId));
    const out = await executeCommand(service, db, { kind: 'recheck', json: true, runId }, {});
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ command: 'recheck', ok: false, error: 'not_verifying', phase: 'created' });
  });

  it('reports an unknown run as a clean exit 1', async () => {
    const { service, db } = await setup();
    const out = await executeCommand(
      service,
      db,
      { kind: 'recheck', json: true, runId: toRunId('run_missing') },
      {},
    );
    expect(out.exitCode).toBe(1);
    expect(out.json['command']).toBe('recheck');
  });
});

/** A minimal syntactically-complete W2-2 blocked read-model for guard tests
 * (never probed — the guards refuse before any git work). */
function syntheticBlockedState(runId: RunId): Parameters<OrchestrationService['saveMergeReadinessBlocked']>[1] {
  const sha = (c: string): string => c.repeat(40);
  return {
    verification: {
      id: verificationId('verif_guard_1'),
      runId,
      assignmentId: assignmentId('asg_guard_1'),
      specHash: specHash('h1'),
      baseCommit: gitSha(sha('b')),
      implementationCommit: gitSha(sha('a')),
      criteria: [],
      outcome: 'all_verified',
      completedAt: '2026-01-01T00:00:00.000Z' as never,
    },
    binding: {
      assignmentId: assignmentId('asg_guard_1'),
      specHash: specHash('h1'),
      baseCommit: gitSha(sha('b')),
      implementationCommit: gitSha(sha('a')),
    },
    worktreePath: '/worktree',
    probeDestinationRef: 'HEAD',
    requiredTestsPassed: true,
    approvedSpecHash: specHash('h1'),
    mergeReadiness: {
      id: mergeReadinessId('mr_guard_1'),
      runId,
      verificationId: verificationId('verif_guard_1'),
      specHash: specHash('h1'),
      baseCommit: gitSha(sha('b')),
      verifiedCommit: gitSha(sha('a')),
      destinationClean: false,
      worktreeClean: true,
      baseDrifted: false,
      conflicts: false,
      requiredTestsPassed: true,
      ready: false,
      blockers: ['the destination working tree is dirty (human action: commit or stash the destination changes)'],
      manualIntegrationCommands: [],
      createdAt: '2026-01-01T00:00:00.000Z' as never,
    },
    blockers: ['the destination working tree is dirty (human action: commit or stash the destination changes)'],
    stage: 'blocked',
    recordedAt: '2026-01-01T00:00:00.000Z' as never,
  };
}

describe('executeCommand — switch-model (T19; §11.2)', () => {
  it('routes the request through ingest and reports the engine rejection with no live session', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(
      service,
      db,
      { kind: 'switch_model', json: true, runId, role: 'implementor', target: { harness: 'codex', model: 'gpt-5.6-terra' } },
      {},
    );
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({
      command: 'switch_model',
      outcome: 'rejected',
      reason: 'precondition_failed',
      role: 'implementor',
    });
    expect(out.json['target']).toMatchObject({ harness: 'codex', model: 'gpt-5.6-terra' });
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — cancel (idempotent, one terminal result; T18)', () => {
  it('cancels, then reports a second cancel as an already-terminal no-op (exit 0)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const first = await executeCommand(service, db, { kind: 'cancel', json: true, runId }, {});
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ outcome: 'applied', phase: 'cancelled' });

    const second = await executeCommand(service, db, { kind: 'cancel', json: true, runId }, {});
    expect(second.exitCode).toBe(0);
    expect(second.json).toMatchObject({ outcome: 'already_terminal', phase: 'cancelled' });
  });
});
