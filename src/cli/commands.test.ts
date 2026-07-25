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
  idempotencyKey,
  mergeReadinessId,
  processGenerationId,
  runId as toRunId,
  segmentId,
  specHash,
  specVersionId,
  verificationId,
} from '../domain/ids.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import type { RoleName } from '../domain/state.js';
import { isoTimestamp } from '../lib/clock.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { OrchestrationService, type RoleAdapterFactory, type SpecDraftState } from '../app/index.js';
import { createRunFixture } from '../app/test-support.js';
import { ROLE_ROUND_PROJECTION, type RoleRoundProjection } from '../app/projections.js';
import { DurableDesiredModelStore } from '../app/desired-model-store.js';
import type { RunId } from '../domain/ids.js';
import { executeCommand, provisioningFailureView } from './commands.js';
import { makeTempGitRepo, type TempGitRepo } from '../worktree/test-support.js';

const NO_SPAWN_FACTORY: RoleAdapterFactory = {
  create() {
    throw new Error('CLI command tests must not spawn adapters');
  },
};

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;

let handle: TestDatabaseHandle | undefined;
let repo: TempGitRepo | undefined;

afterEach(async () => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
  await repo?.cleanup();
  repo = undefined;
});

async function setup(): Promise<{ service: OrchestrationService; db: TestDatabaseHandle['db'] }> {
  repo = await makeTempGitRepo('harness-cli-commands-');
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
  const { runId } = createRunFixture(service, { goal: 'g', workspacePath: repo!.dir, coordinator: CLAUDE_LOW });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  return runId;
}

/** A minimal persisted coordinator draft (what `start` writes) for W1-F3 binding tests. */
function draftState(
  version: string,
  hash: string,
  revision = 1,
  proposed: { implementor: string; verifier: string } = { implementor: 'implementor', verifier: 'verifier' },
): SpecDraftState {
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
    proposedImplementorProfile: proposed.implementor,
    proposedVerifierProfile: proposed.verifier,
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
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: repo!.dir, coordinator: CLAUDE_LOW });
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
    await service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: specHash('draft_hash_1') });
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

describe('executeCommand — resume waits for observed orphan exit', () => {
  it('reports signal-sent and leader-gone/live-tree states as pending without re-entry', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const identities = new Map<number, {
      pid: number;
      ppid: number;
      pgid: number;
      startedAt: string;
      executablePath: string;
    }>();
    let treeAlive = true;
    const pid = 77_701;
    const observed = {
      pid,
      ppid: 1,
      pgid: pid,
      startedAt: `started-${pid}`,
      executablePath: '/fake/agent',
    };
    identities.set(pid, observed);
    const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    const service = new OrchestrationService({
      db: handle.db,
      ids: new DeterministicIdFactory(),
      adapterFactory: NO_SPAWN_FACTORY,
      supervision: {
        selfPid: 77_700,
        ps: {
          sampleProcessTree: (pgid) =>
            treeAlive
              ? {
                  pgid,
                  rssBytes: 64_000,
                  processCount: 1,
                  pids: [pid + 1],
                  sampledAt: handle!.db.clock.nowIso(),
                }
              : undefined,
          sampleIdentity: (candidate) => identities.get(candidate),
          isAlive: (candidate) => identities.has(candidate),
        },
        envNonce: { verifyNonce: () => 'match' },
        sendSignal: (pgid, signal) => signals.push({ pgid, signal }),
      },
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const generationId = processGenerationId('pgen_resume_signal_pending');
    const segment = segmentId('seg_resume_signal_pending');
    service.ingest(
      draftEvent({
        type: 'child.spawn.initiated',
        runId,
        payload: { generationId, segmentId: segment, role: 'coordinator' },
        idempotencyKey: idempotencyKey('resume-signal-init'),
        occurredAt: handle.db.clock.nowIso(),
      }) as DomainEvent,
    );
    service.ingest(
      draftEvent({
        type: 'child.spawned',
        runId,
        payload: { generationId, segmentId: segment, role: 'coordinator', pins: [] },
        idempotencyKey: idempotencyKey('resume-signal-spawned'),
        occurredAt: handle.db.clock.nowIso(),
      }) as DomainEvent,
    );
    service.supervision.registry.store.put({
      generationId,
      pid,
      pgid: pid,
      startedAt: observed.startedAt,
      executablePath: observed.executablePath,
      spawnNonce: 'nonce-resume-pending',
      runId,
      segmentId: segment,
      ownerPid: 999_999,
      recordedAt: handle.db.clock.nowIso(),
    });

    const out = await executeCommand(service, handle.db, { kind: 'resume', json: true, runId }, {});
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({
      outcome: 'orphan_exit_pending',
      orphanReap: { signalSent: 1, exitPending: 0, confirmedGone: 0, withheld: 0 },
    });
    expect(signals).toEqual([{ pgid: pid, signal: 'SIGKILL' }]);
    expect(service.supervision.registry.store.get(generationId)).toBeDefined();
    expect(service.status(runId)).toMatchObject({ suspension: 'none', childActive: true });
    expect(handle.db.events.listByRun(runId).map((event) => event.type)).not.toContain('recovery.initiated');

    identities.delete(pid); // leader gone; descendant remains in the pgid
    const descendantPending = await executeCommand(
      service,
      handle.db,
      { kind: 'resume', json: true, runId },
      {},
    );
    expect(descendantPending.exitCode).toBe(1);
    expect(descendantPending.json).toMatchObject({
      outcome: 'orphan_exit_pending',
      orphanReap: { signalSent: 0, exitPending: 1, confirmedGone: 0, withheld: 0 },
    });
    // No second signal is allowed without the original leader identity.
    expect(signals).toEqual([{ pgid: pid, signal: 'SIGKILL' }]);
    expect(service.supervision.registry.store.get(generationId)).toBeDefined();
    expect(service.status(runId)).toMatchObject({ suspension: 'none', childActive: true });
    treeAlive = false;
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

  // F9: when NEITHER a --implementor/--verifier flag NOR a *resolvable* proposed
  // profile exists, `run` still errors clearly (exit 2). Here the approved
  // draft's proposals are bare role labels ('implementor'/'verifier') that carry
  // no harness:model — so there is no usable default and the run refuses.
  it('errors clearly when no flags AND the proposed profiles are not resolvable (exit 2)', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    service.saveSpecDraft(runId, draftState('spec_1', 'h1'));
    await service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: specHash('h1') });
    const out = await executeCommand(service, db, { kind: 'run', json: true, runId }, {});
    expect(out.exitCode).toBe(2);
    expect(out.json).toMatchObject({ error: 'missing_profiles' });
  });

  // F9 REGRESSION (fails without the fix): the stable contract is that `run`
  // with NO profile flags DEFAULTS to the approved spec draft's proposed
  // profiles. Before the fix this exited `missing_profiles` (exit 2) regardless
  // of the proposals. With resolvable proposals it must NOT be missing_profiles —
  // here (no flow runtime injected) it advances to the `flows_unavailable` gate,
  // proving the implementor/verifier were resolved from the draft.
  it('defaults implementor/verifier from the approved spec draft when no flags are passed', async () => {
    const { service, db } = await setup();
    const runId = toAwaitingApproval(service);
    service.saveSpecDraft(
      runId,
      draftState('spec_1', 'h1', 1, { implementor: 'codex:gpt-5.6-terra', verifier: 'claude:opus' }),
    );
    await service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: specHash('h1') });
    // No --implementor/--verifier: the draft's proposed profiles are the default.
    const out = await executeCommand(service, db, { kind: 'run', json: true, runId }, {});
    expect(out.json['error']).not.toBe('missing_profiles');
    expect(out.json).toMatchObject({ error: 'flows_unavailable' });
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — status', () => {
  it('reports phase/suspension/eta/vitals/checkpoints for a fresh run', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
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

  // W4-3 REGRESSION: before the raw fallback, status read aggregates ONLY, so
  // RSS stayed null until (and unless) a window closed. A single raw tick with
  // no aggregate must now surface as a non-null RSS.
  it('falls back to the latest RAW sample for RSS when no aggregate has been produced yet', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    db.telemetry.recordRawSample({ runId, sampledAt: isoTimestamp('2026-07-18T10:02:10.000Z'), rssBytes: 4242 });

    const out = await executeCommand(service, db, { kind: 'status', json: true, runId }, {});
    const vitals = out.json['vitals'] as { rssBytes: number | null };
    expect(vitals.rssBytes).toBe(4242);
  });

  it('prefers a raw sample newer than the latest closed aggregate window', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    // A closed window aggregate (10:00), then a newer in-progress raw tick (10:02).
    db.telemetry.recordRawSample({ runId, sampledAt: isoTimestamp('2026-07-18T10:00:05.000Z'), rssBytes: 1000 });
    db.telemetry.aggregateWindow({ runId, windowStart: isoTimestamp('2026-07-18T10:00:00.000Z') });
    db.telemetry.recordRawSample({ runId, sampledAt: isoTimestamp('2026-07-18T10:02:10.000Z'), rssBytes: 5000 });

    const out = await executeCommand(service, db, { kind: 'status', json: true, runId }, {});
    const vitals = out.json['vitals'] as { rssBytes: number | null };
    expect(vitals.rssBytes).toBe(5000);
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
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(service, db, { kind: 'resume', json: true, runId }, {});
    expect(out.exitCode).toBe(1);
    expect((out.json['error'] as { name: string }).name).toBe('WorkflowAdvanceError');
  });

  it('reports pause with no active child as an engine rejection (exit 1)', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(service, db, { kind: 'pause', json: true, runId }, {});
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ command: 'pause', outcome: 'rejected' });
  });

  it('reports breaker reset outside breaker_open as a rejection (exit 1)', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(service, db, { kind: 'breaker_reset', json: true, runId }, {});
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ command: 'breaker_reset', outcome: 'rejected' });
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — recheck (W2-2 §16 readiness re-probe)', () => {
  it('refuses when no blocked merge-readiness is recorded (exit 1)', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(service, db, { kind: 'recheck', json: true, runId }, {});
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({ command: 'recheck', ok: false, error: 'not_blocked' });
    expect(out.text).toContain('no blocked §16 merge-readiness');
  });

  it('refuses when the run is not in verifying (the blocked wait state no longer holds; exit 1)', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
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

/**
 * Seed a LIVE, idle child of `role` (with a durable `model` pin) by folding the
 * engine-folded W2-1 spawn events directly — the same shape a real spawn
 * commits. Gives the switch-model gate a live idle child WITHOUT a provider.
 */
function seedLiveChild(
  service: OrchestrationService,
  db: TestDatabaseHandle['db'],
  runId: RunId,
  role: RoleName,
  model: string,
): void {
  const generation = processGenerationId(`pgen_${role}`);
  const segment = segmentId(`seg_${role}`);
  const now = db.clock.nowIso();
  service.ingest(
    draftEvent({
      type: 'child.spawn.initiated',
      runId,
      payload: { generationId: generation, segmentId: segment, role },
      idempotencyKey: idempotencyKey(`si_${role}`),
      occurredAt: now,
    }) as DomainEvent,
  );
  service.ingest(
    draftEvent({
      type: 'child.spawned',
      runId,
      payload: {
        generationId: generation,
        segmentId: segment,
        role,
        pins: [{ purpose: 'model', optionId: 'model', value: model, effectiveValue: model, echoed: true }],
      },
      idempotencyKey: idempotencyKey(`sp_${role}`),
      occurredAt: now,
    }) as DomainEvent,
  );
}

describe('executeCommand — switch-model (HONEST desired-model; §5t)', () => {
  it('records a durable pending desired model on a run with NO live child — not applied, not a fabricated segment', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const out = await executeCommand(
      service,
      db,
      { kind: 'switch_model', json: true, runId, role: 'implementor', target: { harness: 'codex', model: 'gpt-5.6-terra' } },
      {},
    );
    // HONEST: recorded, exit 0 — never the old fabricated-segment rejection.
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({
      command: 'switch_model',
      outcome: 'desired_recorded',
      role: 'implementor',
      desiredModel: 'gpt-5.6-terra',
      liveOwner: false,
    });
    // NO fabricated segment: no operation flip, no model.switch.requested event.
    expect(service.status(runId).operation).not.toBe('model_switch');
    expect(db.events.listByRun(runId).map((event) => event.type)).not.toContain('model.switch.requested');
    // Visible in status as a DISTINCT pending desired, with no effective yet.
    const status = await executeCommand(service, db, { kind: 'status', json: true, runId }, {});
    const models = status.json['models'] as Record<string, { effective?: string; desired?: { model: string } }>;
    expect(models['implementor']?.desired).toMatchObject({ harness: 'codex', model: 'gpt-5.6-terra' });
    expect(models['implementor']?.effective).toBeUndefined();
  });

  it('surfaces durable child.spawned model-pin evidence instead of only a model label', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    seedLiveChild(service, db, runId, 'coordinator', 'opus');

    const status = await executeCommand(service, db, { kind: 'status', json: true, runId }, {});
    expect(status.json).toMatchObject({
      models: {
        coordinator: {
          effective: 'opus',
          spawnEvidence: {
            source: 'child.spawned',
            optionId: 'model',
            requested: 'opus',
            effective: 'opus',
            echoed: true,
          },
        },
      },
    });
  });

  it('NEVER produces operation=model_switch via the CLI path even when a live idle child owns the run (deleted T19 false-success)', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    seedLiveChild(service, db, runId, 'coordinator', 'opus');
    // Precondition the OLD path exploited: live child, idle, suspension none.
    expect(service.status(runId).childActive).toBe(true);
    expect(service.status(runId).operation).toBe('idle');

    const out = await executeCommand(
      service,
      db,
      { kind: 'switch_model', json: true, runId, role: 'coordinator', target: { harness: 'claude', model: 'opus', effort: 'high' } },
      {},
    );
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({ outcome: 'desired_recorded', liveOwner: true });
    // The regression: operation is NOT flipped to model_switch, no segment fabricated.
    expect(service.status(runId).operation).toBe('idle');
    expect(db.events.listByRun(runId).map((event) => event.type)).not.toContain('model.switch.requested');
  });

  it('on the EXACT old-exploit precondition (live idle child, suspension none) ingests ZERO new events — desired is durable, maps to NO transition (§5t S1/e)', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    seedLiveChild(service, db, runId, 'coordinator', 'opus');
    // Reproduce the exact segment-less T19 guard state the old CLI path drove:
    // suspension=none & operation=idle & child_active — what T19 gates on.
    expect(service.status(runId).suspension).toBe('none');
    expect(service.status(runId).operation).toBe('idle');
    expect(service.status(runId).childActive).toBe(true);
    const before = db.events.listByRun(runId).length;

    const out = await executeCommand(
      service,
      db,
      { kind: 'switch_model', json: true, runId, role: 'coordinator', target: { harness: 'claude', model: 'opus', effort: 'high' } },
      {},
    );

    // Honest desired record written, exit 0 — but NOT a single event appended,
    // so it can drive NO transition (the deleted fabricated-segment T19 ingest
    // would have appended model.switch.requested here and flipped operation).
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({ outcome: 'desired_recorded' });
    expect(db.events.listByRun(runId).length).toBe(before);
    expect(new DurableDesiredModelStore(db).get(runId, 'coordinator')?.model).toBe('opus');
    // status still shows effective (running) distinct from the pending desired.
    const status = await executeCommand(service, db, { kind: 'status', json: true, runId }, {});
    const models = status.json['models'] as Record<string, { effective?: string; desired?: { effort?: string } }>;
    expect(models['coordinator']?.effective).toBe('opus');
    expect(models['coordinator']?.desired?.effort).toBe('high');
  });

  it('reports the real per-role EFFECTIVE model from child.spawned pins (implementor), distinct from the desired', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    seedLiveChild(service, db, runId, 'implementor', 'gpt-5.6-terra');

    const status = await executeCommand(service, db, { kind: 'status', json: true, runId }, {});
    const models = status.json['models'] as Record<string, { effective?: string }>;
    expect(models['implementor']?.effective).toBe('gpt-5.6-terra');

    const out = await executeCommand(
      service,
      db,
      { kind: 'switch_model', json: true, runId, role: 'implementor', target: { harness: 'codex', model: 'gpt-5.6-sol' } },
      {},
    );
    // Effective (running, from pins) and desired (pending) are reported apart.
    expect(out.json).toMatchObject({ effectiveModel: 'gpt-5.6-terra', desiredModel: 'gpt-5.6-sol' });
  });
});

describe('executeCommand — set-budget --resume (F3 one-shot re-entry)', () => {
  it('reports the audited raise and pending re-entry honestly when flow dependencies are unavailable', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    seedLiveChild(service, db, runId, 'implementor', 'gpt-5.6-terra');
    const child = service.status(runId).activeChild;
    expect(child).toBeDefined();
    db.projections.save<RoleRoundProjection>(runId, ROLE_ROUND_PROJECTION, {
      round: 1,
      role: 'implementor',
      stage: 'active',
      modelSpec: { harness: 'codex', model: 'gpt-5.6-terra' },
      generationId: child!.generationId,
    });
    service.ingest(
      draftEvent({
        type: 'resource.exhausted',
        runId,
        payload: {
          generationId: child!.generationId,
          role: 'implementor',
          rssBytes: 1_100 * 1024 * 1024,
          budgetBytes: 1_024 * 1024 * 1024,
        },
        idempotencyKey: idempotencyKey('set-budget-unavailable-rss'),
        occurredAt: db.clock.nowIso(),
      }) as DomainEvent,
    );

    const out = await executeCommand(
      service,
      db,
      {
        kind: 'set_budget',
        json: true,
        runId,
        role: 'implementor',
        budgetMb: 2_048,
        resume: true,
      },
      {},
    );

    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({
      command: 'set_budget',
      ok: true,
      outcome: 'raised_resume_pending',
      durableRaise: true,
      reentry: 'unavailable',
    });
    expect(out.text).toContain('round was NOT re-entered');
    expect(db.events.listByRun(runId).map((event) => event.type)).toContain(
      'run.memory_budget.overridden',
    );
  });
});

// ---------------------------------------------------------------------------
describe('executeCommand — cancel (idempotent, one terminal result; T18)', () => {
  it('cancels, then reports a second cancel as an already-terminal no-op (exit 0)', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const first = await executeCommand(service, db, { kind: 'cancel', json: true, runId }, {});
    expect(first.exitCode).toBe(0);
    expect(first.json).toMatchObject({ outcome: 'applied', phase: 'cancelled' });

    const second = await executeCommand(service, db, { kind: 'cancel', json: true, runId }, {});
    expect(second.exitCode).toBe(0);
    expect(second.json).toMatchObject({ outcome: 'already_terminal', phase: 'cancelled' });
  });
});

// ---------------------------------------------------------------------------
// ROUND 6 (Finding 4) — the machine-readable provisioning cause must reach the
// STABLE JSON, not only the human text. The closed cause vocabulary exists for
// machine consumption; omitting it forced JSON consumers to parse prose.
// ---------------------------------------------------------------------------
describe('provisioningFailureView — the JSON payload carries the cause', () => {
  it('includes the closed-vocabulary cause alongside the prose detail', () => {
    const view = provisioningFailureView({
      kind: 'provisioning_failed',
      repoRoot: '/repo',
      worktreePath: '/repo.worktrees/asg',
      cause: 'primary_tree_stale',
      detail: 'the primary tree is stale',
      round: 2,
    });
    expect(view).toMatchObject({
      repoRoot: '/repo',
      worktreePath: '/repo.worktrees/asg',
      cause: 'primary_tree_stale',
      detail: 'the primary tree is stale',
      round: 2,
    });
  });

  it('omits the cause only when provisioning supplied none (pre-F9 refusals)', () => {
    const view = provisioningFailureView({
      kind: 'provisioning_failed',
      repoRoot: '/repo',
      worktreePath: '/wt',
      detail: 'node_modules is NOT git-ignored',
    });
    expect(view.cause).toBeUndefined();
    expect(view.detail).toBe('node_modules is NOT git-ignored');
  });
});
