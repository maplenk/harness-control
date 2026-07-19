/**
 * W2-5 resume re-entry, service level (spec docs/specs/hardening-p4a.md
 * §W2-5; PLAN §11.1, §13) — offline tests against the IN-PROCESS fake
 * adapter (no real spawns):
 *
 *  - the transactional resume-ELIGIBILITY check runs BEFORE T9/T12 (and
 *    before any scheduled probe): assignment open + non-stale AND
 *    `checkpoint.specHash == assignment.specHash == engine approvedSpecHash
 *    == current draft.specHash`; any mismatch is a typed
 *    `ResumeEligibilityError` WITHOUT clearing the suspension;
 *  - the COMPLETE `RoleRoundProjection` shape: serialized inputs, spec/base
 *    binding, assignment binding, staleness watermark, checkpoint ref,
 *    intended completion advance — for dispatched rounds of every role;
 *  - `resume_reentry.completed` acks a pending T9/T12 re-entry exactly when
 *    the re-entered round goes ACTIVE (inside runRole), idempotently — the
 *    reclaim marker survives a crash-before-re-entry and clears on re-entry.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactHash,
  assignmentId,
  checkpointId,
  criterionId,
  gitSha,
  idempotencyKey,
  specHash,
  specVersionId,
  type RunId,
} from '../domain/ids.js';
import { isoTimestamp } from '../lib/clock.js';
import { draftEvent, type DomainEvent } from '../domain/events.js';
import {
  AdapterError,
  InProcessFakeAdapter,
  rateLimitErrorEnvelope,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../adapters/index.js';
import { DeterministicIdFactory, RandomIdFactory } from '../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import {
  LimitPausedError,
  OrchestrationService,
  ResumeEligibilityError,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from './service.js';
import { ROLE_ROUND_PROJECTION, type RoleRoundProjection, type SpecDraftState } from './projections.js';
import type { RoleRunner } from './role-runner.js';
import type { Harness } from './model-resolution.js';

// ---------------------------------------------------------------------------
// Harness (pause-spine conventions)
// ---------------------------------------------------------------------------
function fakeConfigOptions(harness: Harness): ConfigOptionDescriptor[] {
  if (harness === 'claude') {
    return [
      { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
      { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
    ];
  }
  return [
    { id: 'model', kind: 'model', values: ['gpt-5.6-terra', 'gpt-5.6-sol'], current: 'gpt-5.6-sol' },
    { id: 'model_reasoning_effort', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

interface FakeScript {
  readonly turns?: readonly InProcessTurnScript[];
  readonly onSetConfigOption?: (input: SetConfigOptionInput) => SetConfigOptionResult;
}

/** Factory whose Nth created adapter takes the Nth script (last one reused). */
function makeQueueFactory(scripts: readonly FakeScript[]): { factory: RoleAdapterFactory } {
  let cursor = 0;
  const factory: RoleAdapterFactory = {
    create(options: RoleAdapterOptions) {
      const script = scripts[Math.min(cursor, scripts.length - 1)] ?? {};
      cursor += 1;
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: fakeConfigOptions(options.resolved.harness) },
        ...(script.turns !== undefined ? { turns: script.turns } : {}),
        ...(script.onSetConfigOption !== undefined ? { onSetConfigOption: script.onSetConfigOption } : {}),
      });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory };
}

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

async function setup(scripts: readonly FakeScript[]): Promise<{
  service: OrchestrationService;
  db: TestDatabaseHandle['db'];
}> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const { factory } = makeQueueFactory(scripts);
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
  });
  return { service, db: handle.db };
}

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const HASH_1 = specHash('hash_1');
const LIMIT_TURN: FakeScript = { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] };
const OK_TURN: FakeScript = { turns: [{}] };

function promptOnceRunner(role: 'coordinator' | 'implementor' | 'verifier' = 'implementor'): RoleRunner {
  return {
    role,
    run: async (session) => {
      await session.prompt({ prompt: 'go' });
      return {};
    },
  };
}

function draft(hash: string): SpecDraftState {
  return {
    specVersionId: specVersionId('spec_1'),
    specHash: specHash(hash),
    canonicalSpec: '{"goal":"g"}',
    goal: 'g',
    criteria: [
      { id: criterionId('AC-1'), description: 'd', verificationCommands: ['echo ok'], expectedEvidence: 'exit code 0' },
    ],
    proposedImplementorProfile: 'implementor',
    proposedVerifierProfile: 'verifier',
    revision: 1,
  };
}

/** Approve HASH_1, then pause an implementor round bound to it mid-turn (T4). */
async function pauseImplementorRound(
  service: OrchestrationService,
): Promise<RunId> {
  const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  service.saveSpecDraft(runId, draft('hash_1'));
  expect(service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: HASH_1 }).status).toBe('applied');
  const error: unknown = await service
    .runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
      round: 1,
      advance: { from: 'approved', to: 'implementing' },
      completionAdvance: { from: 'implementing', to: 'verifying' },
      inputs: JSON.stringify({ taskScope: 'implement it' }),
      specHash: HASH_1,
      baseCommit: gitSha('a'.repeat(40)),
      criterionIds: [criterionId('AC-1')],
    })
    .then(() => undefined)
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(LimitPausedError);
  expect(service.status(runId).suspension).toBe('paused_limit');
  return runId;
}

// ---------------------------------------------------------------------------
// The COMPLETE RoleRoundProjection shape (W2-5 deliverable 1)
// ---------------------------------------------------------------------------
describe('RoleRoundProjection — complete generic shape', () => {
  it('a paused implementor round persists inputs, spec/base binding, checkpoint ref, completion advance, and the staleness watermark', async () => {
    const { service } = await setup([LIMIT_TURN]);
    const runId = await pauseImplementorRound(service);
    const round = service.getRoleRound(runId);
    expect(round).toMatchObject({
      round: 1,
      role: 'implementor',
      stage: 'active',
      modelSpec: CLAUDE_LOW,
      inputs: JSON.stringify({ taskScope: 'implement it' }),
      specHash: 'hash_1',
      baseCommit: 'a'.repeat(40),
      intendedCompletionAdvance: { from: 'implementing', to: 'verifying' },
    });
    expect(round?.checkpointRef).toBeDefined(); // §12.2 pause checkpoint linked
    expect(round?.generationId).toBeDefined();
    expect(round?.segmentId).toBeDefined();
    expect(typeof round?.dispatchedAtSequence).toBe('number'); // W2-5 staleness watermark
  });

  it('a verifier-shaped dispatch persists the exact implementationCommit binding', async () => {
    const { service } = await setup([OK_TURN]);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const impl = gitSha('b'.repeat(40));
    await service.runRole(runId, promptOnceRunner('verifier'), CLAUDE_LOW, '/ws', {
      round: 1,
      inputs: JSON.stringify({ implementationCommit: String(impl) }),
      specHash: HASH_1,
      baseCommit: gitSha('a'.repeat(40)),
      implementationCommit: impl,
    });
    expect(service.getRoleRound(runId)).toMatchObject({
      role: 'verifier',
      stage: 'completed',
      implementationCommit: 'b'.repeat(40),
    });
  });
});

// ---------------------------------------------------------------------------
// Resume eligibility (W2-5 deliverable 2) — typed refusals, suspension intact
// ---------------------------------------------------------------------------
describe('resume eligibility — the four-way spec binding chain', () => {
  it('a superseding draft (draft.specHash != round.specHash) refuses resume WITHOUT clearing the suspension', async () => {
    const { service, db } = await setup([LIMIT_TURN]);
    const runId = await pauseImplementorRound(service);

    // A revise round persisted a NEW superseding draft while paused.
    service.saveSpecDraft(runId, draft('hash_2'));

    const error: unknown = await Promise.resolve()
      .then(() => service.resume(runId))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResumeEligibilityError);
    expect((error as ResumeEligibilityError).reason).toBe('spec_binding_mismatch');
    // Suspension NOT cleared; no T9 landed.
    expect(service.status(runId).suspension).toBe('paused_limit');
    expect(db.events.listByRun(runId).some((e) => e.type === 'resume.limit.requested')).toBe(false);

    // The scheduled-probe path refuses identically (eligibility precedes
    // EVERY T9 producer).
    const probeError: unknown = await service.runScheduledProbe(runId).catch((e: unknown) => e);
    expect(probeError).toBeInstanceOf(ResumeEligibilityError);
  });

  it('a checkpoint bound to a DIFFERENT spec hash refuses resume (checkpoint leg of the chain)', async () => {
    const { service, db } = await setup([LIMIT_TURN]);
    const runId = await pauseImplementorRound(service);

    // Corrupt-state simulation: the round claims a checkpoint whose content
    // records a different spec hash. (The live pause path always writes the
    // round's own hash; this proves the chain checks the checkpoint leg.)
    const round = service.getRoleRound(runId)!;
    const content = service.getCheckpointContent(round.checkpointRef!)!;
    expect(String(content.specHash)).toBe('hash_1'); // sanity: the honest pause binding
    const forged: RoleRoundProjection = { ...round, specHash: specHash('hash_1') };
    db.projections.save(runId, ROLE_ROUND_PROJECTION, forged);
    service.saveSpecDraft(runId, draft('hash_1')); // draft + approved legs hold
    // Point the ROUND at a different spec while checkpoint/draft/approved say hash_1.
    db.projections.save(runId, ROLE_ROUND_PROJECTION, { ...forged, specHash: specHash('hash_x') });

    const error: unknown = await Promise.resolve()
      .then(() => service.resume(runId))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResumeEligibilityError);
    expect((error as ResumeEligibilityError).reason).toBe('spec_binding_mismatch');
    expect(service.status(runId).suspension).toBe('paused_limit');
  });

  it('assignments marked stale AFTER the round dispatched refuse resume (assignment_stale)', async () => {
    const { service } = await setup([LIMIT_TURN]);
    const runId = await pauseImplementorRound(service);

    // T3-style supersession effect lands after the round's watermark.
    service.ingest(
      draftEvent({
        type: 'assignments.marked_stale',
        runId,
        payload: { supersededSpecVersionId: specVersionId('spec_1') },
        idempotencyKey: idempotencyKey('stale_1'),
        occurredAt: isoTimestamp('2026-07-18T00:00:00.000Z'),
      }) as DomainEvent,
    );

    const error: unknown = await Promise.resolve()
      .then(() => service.resume(runId))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResumeEligibilityError);
    expect((error as ResumeEligibilityError).reason).toBe('assignment_stale');
    expect(service.status(runId).suspension).toBe('paused_limit');
  });

  it('an intact chain resumes (T9) and a coordinator round with no spec binding is vacuously eligible', async () => {
    const { service } = await setup([LIMIT_TURN, LIMIT_TURN]);
    const runId = await pauseImplementorRound(service);
    service.saveSpecDraft(runId, draft('hash_1')); // matches round + approved + checkpoint
    const resumed = service.resume(runId);
    expect(resumed.status).toBe('applied');
    if (resumed.status === 'applied') expect(resumed.transitionId).toBe('T9');
    expect(service.status(runId).resumeReentryPending).toMatchObject({ returnPhase: 'implementing' });

    // Coordinator round (no specHash) — pause + resume applies untouched.
    const { runId: run2 } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(run2, promptOnceRunner('coordinator')).catch(() => undefined);
    expect(service.status(run2).suspension).toBe('paused_limit');
    expect(service.resume(run2).status).toBe('applied');
  });
});

// ---------------------------------------------------------------------------
// resume_reentry.completed ack (W2-1/W2-5, pushback item 4)
// ---------------------------------------------------------------------------
describe('re-entry ack — resume_reentry.completed when the re-entered round runs', () => {
  it('the pending re-entry survives until the re-entered round goes ACTIVE, then acks idempotently', async () => {
    const { service, db } = await setup([LIMIT_TURN, OK_TURN]);
    const runId = await pauseImplementorRound(service);
    service.saveSpecDraft(runId, draft('hash_1'));

    expect(service.resume(runId).status).toBe('applied');
    // T9 recorded the pending re-entry; NOTHING is active yet (W2-1).
    let st = service.status(runId);
    expect(st.suspension).toBe('none');
    expect(st.phase).toBe('implementing');
    expect(st.resumeReentryPending).toBeDefined();
    expect(st.childActive).toBe(false);
    expect(db.events.listByRun(runId).some((e) => e.type === 'resume_reentry.completed')).toBe(false);

    // "Crash before re-entry": a fresh service over the same store still sees
    // the unacknowledged pending re-entry (reclaimable, idempotent). Random
    // ids: a restarted process never re-mints the dead one's key sequence.
    const successor = new OrchestrationService({
      db,
      ids: new RandomIdFactory(),
      adapterFactory: makeQueueFactory([OK_TURN]).factory,
    });
    expect(successor.recover(runId).resumeReentryPending).toBeDefined();

    // Re-enter the round (same dispatch, no advance — already at implementing):
    // going ACTIVE acks the re-entry.
    await successor.runRole(runId, promptOnceRunner(), CLAUDE_LOW, '/ws', {
      round: 1,
      completionAdvance: { from: 'implementing', to: 'verifying' },
      inputs: JSON.stringify({ taskScope: 'implement it' }),
      specHash: HASH_1,
      baseCommit: gitSha('a'.repeat(40)),
    });
    st = successor.status(runId);
    expect(st.resumeReentryPending).toBeUndefined();
    const acks = db.events.listByRun(runId).filter((e) => e.type === 'resume_reentry.completed');
    expect(acks).toHaveLength(1);
    expect(acks[0]?.payload).toMatchObject({ role: 'implementor', round: 1 });
    expect(successor.getRoleRound(runId)).toMatchObject({ stage: 'completed', round: 1 });
  });

  it('a normal (non-resume) dispatch never appends an ack', async () => {
    const { service, db } = await setup([OK_TURN]);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(runId, promptOnceRunner('coordinator'));
    expect(db.events.listByRun(runId).some((e) => e.type === 'resume_reentry.completed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Echo-mismatch pin (W2-0) — regression pin on the already-landed behavior
// ---------------------------------------------------------------------------
describe('W2-0 echo-mismatch pins (regression)', () => {
  it('an ok:true pin whose echoed effectiveValue contradicts the request is a FAILED pin on the classify-then-retry path', async () => {
    let modelAttempts = 0;
    const { service } = await setup([
      {
        onSetConfigOption: (input) => {
          if (input.optionId === 'model') {
            modelAttempts += 1;
            // First attempt echoes a CONTRADICTING value; the single retry
            // hits a limit envelope → classification precedes retry → pause.
            if (modelAttempts === 1) return { effectiveValue: 'sonnet', echoed: true };
            throw new AdapterError('provider_error', 'limited', { envelope: rateLimitErrorEnvelope() });
          }
          return { effectiveValue: input.value, echoed: true };
        },
      },
    ]);
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    const error: unknown = await service
      .runCoordination(runId, promptOnceRunner('coordinator'))
      .then(() => undefined)
      .catch((e: unknown) => e);
    // The retry's failure was CLASSIFIED (usage_limit) → paused via T4, never
    // a silent acceptance of the mismatched pin.
    expect(error).toBeInstanceOf(LimitPausedError);
    expect((error as LimitPausedError).operation).toBe('initial_config_pin');
    expect(modelAttempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// F3 (§5x, Approach B) — resume DERIVES the checkpoint from the LOG, never
// trusts the separately-saved `round.checkpointRef` pointer. These fail on
// the pre-fix path (which read `round.checkpointRef` only).
// ---------------------------------------------------------------------------
describe('F3 (§5x) — resume derives the checkpoint from the log', () => {
  /** Append a `checkpoint.recorded` fact to the log directly (mimics a cadence
   * checkpoint / a superseded-spec checkpoint that never touches
   * `checkpointRef`). The artifact hash need not resolve — the DERIVATION
   * reads the enriched event payload, not the CAS. */
  function appendCheckpointFact(
    service: OrchestrationService,
    runId: RunId,
    opts: {
      readonly reason: 'cadence' | 'pre_pause';
      readonly specHash: string;
      readonly hash: string;
      readonly key: string;
      readonly assignmentId?: string;
    },
  ): string {
    service.ingest(
      draftEvent({
        type: 'checkpoint.recorded',
        runId,
        payload: {
          checkpointId: checkpointId(`ckpt_${opts.key}`),
          artifactHash: artifactHash(opts.hash),
          reason: opts.reason,
          specHash: specHash(opts.specHash),
          role: 'implementor',
          round: 1,
          ...(opts.assignmentId !== undefined ? { assignmentId: assignmentId(opts.assignmentId) } : {}),
        },
        idempotencyKey: idempotencyKey(`ckpt_fact_${opts.key}`),
        occurredAt: isoTimestamp('2026-07-20T00:00:00.000Z'),
      }) as DomainEvent,
    );
    return opts.hash;
  }

  it('a crash AFTER the checkpoint.recorded append but BEFORE the checkpointRef save still resolves the checkpoint via derivation', async () => {
    const { service, db } = await setup([LIMIT_TURN]);
    const runId = await pauseImplementorRound(service);
    const round = service.getRoleRound(runId)!;
    const ref = round.checkpointRef!;
    expect(ref).toBeDefined();

    // Simulate the F3 crash window: the atomic `checkpoint.recorded` committed,
    // but the process died BEFORE `#saveRoleRound` persisted `checkpointRef`.
    const withoutRef: RoleRoundProjection = { ...round };
    delete (withoutRef as { checkpointRef?: unknown }).checkpointRef;
    db.projections.save(runId, ROLE_ROUND_PROJECTION, withoutRef);
    expect(service.getRoleRound(runId)?.checkpointRef).toBeUndefined();

    // Pre-fix (read `round.checkpointRef` only) → the checkpoint is lost. The
    // derivation re-finds it from the committed log.
    expect(service.resolveResumeCheckpointHash(runId)).toBe(ref);
    const derived = service.resolveResumeCheckpoint(runId);
    expect(derived).toBeDefined();
    expect(String(derived!.specHash)).toBe('hash_1');
  });

  it('a cadence checkpoint (which never writes checkpointRef) is visible to resume', async () => {
    const { service } = await setup([LIMIT_TURN]);
    const runId = await pauseImplementorRound(service);
    const pauseRef = service.getRoleRound(runId)!.checkpointRef!;

    // A later cadence checkpoint on the same spec binding. Cadence NEVER
    // touches `checkpointRef`, so the pre-fix path could never see it.
    const cadenceHash = appendCheckpointFact(service, runId, {
      reason: 'cadence',
      specHash: 'hash_1',
      hash: 'cadence00hash',
      key: 'cadence1',
    });
    expect(cadenceHash).not.toBe(pauseRef);

    // `checkpointRef` still points at the pause checkpoint (untouched)…
    expect(service.getRoleRound(runId)?.checkpointRef).toBe(pauseRef);
    // …but derivation adopts the LATEST-by-sequence compatible checkpoint.
    expect(service.resolveResumeCheckpointHash(runId)).toBe(cadenceHash);
  });

  it('a superseded-spec checkpoint is NEVER resurrected, even when later by sequence (specHash filter)', async () => {
    const { service } = await setup([LIMIT_TURN]);
    const runId = await pauseImplementorRound(service);
    const pauseRef = service.getRoleRound(runId)!.checkpointRef!; // bound to hash_1

    // A checkpoint bound to a DIFFERENT (superseded) spec lands LATER by
    // sequence. Latest-by-sequence alone would wrongly pick it; the specHash
    // filter must exclude it — the round remains bound to hash_1.
    appendCheckpointFact(service, runId, {
      reason: 'cadence',
      specHash: 'hash_2',
      hash: 'superseded0hash',
      key: 'superseded1',
    });

    // The superseded checkpoint is filtered out → the hash_1-bound pause
    // checkpoint (earlier by sequence) still wins.
    expect(service.resolveResumeCheckpointHash(runId)).toBe(pauseRef);
  });

  it('a same-spec checkpoint from a DIFFERENT assignment is NEVER resurrected (assignment filter)', async () => {
    const { service, db } = await setup([LIMIT_TURN]);
    const runId = await pauseImplementorRound(service);
    // Bind the current round to assignment A1 (production dispatches always
    // thread `assignmentId`; the pause helper omits it). The pause checkpoint
    // fact this round already committed carries no assignmentId, so append an
    // A1-bound checkpoint to serve as the correct resume target.
    const round = service.getRoleRound(runId)!;
    db.projections.save(runId, ROLE_ROUND_PROJECTION, { ...round, assignmentId: assignmentId('asg_A1') });

    const a1Hash = appendCheckpointFact(service, runId, {
      reason: 'cadence',
      specHash: 'hash_1',
      hash: 'a1000000hash',
      key: 'a1',
      assignmentId: 'asg_A1',
    });
    // A checkpoint on the SAME spec but a DIFFERENT assignment (A2) lands LATER
    // by sequence. A bare latest-by-sequence (or spec-only) scan would wrongly
    // pick it; the assignment filter must exclude it — resume must never adopt
    // another assignment's worktree/evidence.
    appendCheckpointFact(service, runId, {
      reason: 'cadence',
      specHash: 'hash_1',
      hash: 'a2000000hash',
      key: 'a2',
      assignmentId: 'asg_A2',
    });

    expect(service.resolveResumeCheckpointHash(runId)).toBe(a1Hash);
  });
});
