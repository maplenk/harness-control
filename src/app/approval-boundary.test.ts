/**
 * B2 round 2 — the APPROVAL BOUNDARY is the service, not the CLI.
 *
 * Codex's adversarial review of B2 reproduced three holes, each of which this
 * suite pins with the reviewer's exact scenario:
 *
 *  F1 (HIGH) — `service.approve` trusted the caller's `mode`, version and hash.
 *      A run pinned to `approval:'human'`, with NO draft at all, reached
 *      `approved` carrying a FABRICATED hash and a durable `approvedBy:'auto'`.
 *      That is not an auto-approval bug: it is a hole in the whole approval
 *      gate, reachable by any in-process caller. The service must enforce the
 *      run's PINNED mode and validate the binding ITSELF.
 *
 *  F2 (HIGH) — draft-loss detection compared only the content HASH, and read
 *      BEFORE the separate T1 transaction. A stale projection carrying the same
 *      hash under a SUPERSEDED version/revision passed, and a concurrent
 *      revision could replace the draft between validation and T1. Hash,
 *      version AND revision must be compared against the durable completion
 *      ref, inside the SAME transaction that appends T1.
 *
 *  F3 (MEDIUM) — auto-approval was a CLI post-step, so an `approval:'auto'`
 *      run driven through the durable completion API stayed at
 *      `awaiting_approval`, and a crash between the completion and the
 *      post-step stranded the run at a gate it is pinned not to have.
 *      Auto-approval belongs INSIDE `completeCoordinationRound`'s transaction.
 *
 * Both SQLite drivers: the pinned mode lives in a projection and the signature
 * lives in the event log.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { CLEAN_PINNED_WORKSPACE_GIT, createRunFixture } from './test-support.js';
import { specHash as toSpecHash, specVersionId as toSpecVersionId, type RunId } from '../domain/ids.js';
import { InProcessFakeAdapter, type ConfigOptionDescriptor } from '../adapters/index.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import {
  availableDriverKinds,
  openTestDatabase,
  type TestDatabaseHandle,
} from '../persistence/test-support.js';
import type { DriverKind } from '../persistence/index.js';
import { parseEngineConfig } from '../config/loader.js';
import type { EngineConfig } from '../config/schema.js';
import { unwrap } from '../lib/result.js';
import { OrchestrationService, SpecApprovalRefusedError, type RoleAdapterFactory } from './service.js';
import { SPEC_DRAFT_PROJECTION, type SpecDraftState } from './projections.js';

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;

const HUMAN_CONFIG = (): EngineConfig => unwrap(parseEngineConfig({}));
/** B2 F4: autonomy REQUIRES a declared verification-command allowlist. */
const AUTO_CONFIG = (): EngineConfig =>
  unwrap(parseEngineConfig({ approval: 'auto', verification: { allowedCommands: ['npm test'] } }));

function fakeConfigOptions(): ConfigOptionDescriptor[] {
  return [
    { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
    { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

function makeFakeFactory(): RoleAdapterFactory {
  return {
    create() {
      const adapter = new InProcessFakeAdapter({
        harnessId: 'claude',
        capabilities: { configOptions: fakeConfigOptions() },
      });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
}

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

interface Wired {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
}

async function setup(kind: DriverKind, config: EngineConfig): Promise<Wired> {
  handle = await openTestDatabase({ kind, file: false });
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: makeFakeFactory(),
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
    config,
  });
  return { service, db: handle.db };
}

function draftFor(n: number): SpecDraftState {
  return {
    specVersionId: toSpecVersionId(`spec_${n}`),
    specHash: toSpecHash(`hash_${n}`),
    canonicalSpec: `{"goal":"g${n}"}`,
    goal: `g${n}`,
    criteria: [],
    proposedImplementorProfile: 'codex:gpt-5.6-terra',
    proposedVerifierProfile: 'claude:opus',
    revision: n,
  };
}

/** A run parked at `awaiting_approval` with NO drafting round ever completed. */
function runAtGateWithoutDraft(service: OrchestrationService): RunId {
  const { runId } = createRunFixture(service, {
    goal: 'g',
    workspacePath: '/ws',
    coordinator: CLAUDE_LOW,
  });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  return runId;
}

/** A run whose durable coordinator completion recorded `draft`. */
async function runWithCompletedDraft(
  service: OrchestrationService,
  draft: SpecDraftState,
): Promise<RunId> {
  const { runId } = createRunFixture(service, {
    goal: 'g',
    workspacePath: '/ws',
    coordinator: CLAUDE_LOW,
  });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  await service.completeCoordinationRound(runId, draft);
  return runId;
}

function approvalEvents(db: TestDatabaseHandle['db'], runId: RunId): readonly { payload: unknown }[] {
  return db.events.listByRun(runId).filter((e) => e.type === 'spec.approved');
}

const DRIVER_KINDS = await availableDriverKinds();

describe.each(DRIVER_KINDS)('B2 F1 — the service enforces the run\'s PINNED approval mode [%s]', (kind) => {
  it("CODEX REPRO: a 'human'-pinned run with NO draft cannot be auto-approved with a fabricated hash", async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service);

    await expect(
      service.approve(runId, {
        specVersionId: toSpecVersionId('spec_fabricated'),
        specHash: toSpecHash('totally-made-up-hash'),
        mode: 'auto',
      }),
    ).rejects.toBeInstanceOf(SpecApprovalRefusedError);

    // Nothing was written: no transition, no durable `approvedBy:'auto'` lie.
    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(service.status(runId).approvedSpecHash).toBeUndefined();
    expect(service.status(runId).specApprovedBy).toBeUndefined();
    expect(approvalEvents(db, runId)).toHaveLength(0);
  });

  it("a 'human'-pinned run with a REAL completed draft still refuses mode:'auto'", async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));

    await expect(
      service.approve(runId, {
        specVersionId: toSpecVersionId('spec_1'),
        specHash: toSpecHash('hash_1'),
        mode: 'auto',
      }),
    ).rejects.toBeInstanceOf(SpecApprovalRefusedError);
    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(approvalEvents(db, runId)).toHaveLength(0);

    // The HUMAN signature on the very same binding is accepted — the refusal
    // is about the claimed signer, not about the spec.
    const human = await service.approve(runId, {
      specVersionId: toSpecVersionId('spec_1'),
      specHash: toSpecHash('hash_1'),
    });
    expect(human.status).toBe('applied');
    expect(service.status(runId).specApprovedBy).toBe('human');
  });

  it("an 'auto'-pinned run accepts BOTH signers (a human may always sign in person)", async () => {
    const { service } = await setup(kind, AUTO_CONFIG());
    // `completeCoordinationRound` now auto-approves (F3), so drive the human
    // case from a run that never completed a round.
    const humanRun = runAtGateWithoutDraft(service);
    const human = await service.approve(humanRun, {
      specVersionId: toSpecVersionId('spec_h'),
      specHash: toSpecHash('hash_h'),
    });
    expect(human.status).toBe('applied');
    expect(service.status(humanRun).specApprovedBy).toBe('human');

    const autoRun = await runWithCompletedDraft(service, draftFor(1));
    expect(service.status(autoRun).specApprovedBy).toBe('auto');
  });
});

describe.each(DRIVER_KINDS)('B2 F2 — binding validated against the durable completion ref [%s]', (kind) => {
  it('CODEX REPRO: a stale draft with the SAME hash but a SUPERSEDED version/revision is refused', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    // Completion ref says revision 2 / spec_2 @ hash_shared…
    const runId = await runWithCompletedDraft(service, {
      ...draftFor(2),
      specHash: toSpecHash('hash_shared'),
    });
    // …but the projection is rolled back to the SUPERSEDED revision 1 / spec_1
    // carrying the SAME content hash. Hash-only detection saw no loss.
    db.projections.save(runId, SPEC_DRAFT_PROJECTION, {
      ...draftFor(1),
      specHash: toSpecHash('hash_shared'),
    });

    await expect(
      service.approve(runId, {
        specVersionId: toSpecVersionId('spec_1'),
        specHash: toSpecHash('hash_shared'),
      }),
    ).rejects.toBeInstanceOf(SpecApprovalRefusedError);
    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(approvalEvents(db, runId)).toHaveLength(0);
  });

  it('a version/hash that disagrees with the completion ref is refused even when the projection agrees', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));

    // Right run, right phase, real draft — but the caller names another spec.
    await expect(
      service.approve(runId, {
        specVersionId: toSpecVersionId('spec_1'),
        specHash: toSpecHash('hash_2'),
      }),
    ).rejects.toBeInstanceOf(SpecApprovalRefusedError);
    await expect(
      service.approve(runId, {
        specVersionId: toSpecVersionId('spec_2'),
        specHash: toSpecHash('hash_1'),
      }),
    ).rejects.toBeInstanceOf(SpecApprovalRefusedError);
    expect(approvalEvents(db, runId)).toHaveLength(0);
  });

  it('a MISSING draft projection is refused at the SERVICE, not only in the CLI', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    // W3-4 damage: the completion ref survives in the log, the projection does not.
    db.driver
      .prepare('DELETE FROM run_projections WHERE run_id = ? AND projection_name = ?')
      .run([String(runId), SPEC_DRAFT_PROJECTION]);
    expect(service.getSpecDraft(runId)).toBeUndefined();

    await expect(
      service.approve(runId, {
        specVersionId: toSpecVersionId('spec_1'),
        specHash: toSpecHash('hash_1'),
      }),
    ).rejects.toBeInstanceOf(SpecApprovalRefusedError);
    expect(approvalEvents(db, runId)).toHaveLength(0);
  });

  it('a run that never completed a drafting round keeps the pre-B2 explicit-hash path (no ref to check)', async () => {
    const { service } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service);
    const applied = await service.approve(runId, {
      specVersionId: toSpecVersionId('spec_unit'),
      specHash: toSpecHash('hash_unit'),
    });
    expect(applied.status).toBe('applied');
    expect(service.status(runId).specApprovedBy).toBe('human');
  });
});

describe.each(DRIVER_KINDS)('B2 F3 — auto-approval is part of the durable completion [%s]', (kind) => {
  it("CODEX REPRO: completeCoordinationRound on an 'auto' run reaches `approved`, not `awaiting_approval`", async () => {
    const { service, db } = await setup(kind, AUTO_CONFIG());
    const { runId } = createRunFixture(service, {
      goal: 'g',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    service.advanceWorkflowPhase(runId, 'created', 'specifying');

    const state = await service.completeCoordinationRound(runId, draftFor(1));

    // The returned state is post-T1 — no caller has to run a second step.
    expect(state.phase).toBe('approved');
    expect(state.specApprovedBy).toBe('auto');
    expect(String(state.approvedSpecHash)).toBe('hash_1');
    expect(service.status(runId).phase).toBe('approved');

    const events = approvalEvents(db, runId);
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toEqual({
      specVersionId: 'spec_1',
      specHash: 'hash_1',
      approvedBy: 'auto',
    });
  });

  it("the SAME API on a 'human' run still stops at awaiting_approval", async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const { runId } = createRunFixture(service, {
      goal: 'g',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    service.advanceWorkflowPhase(runId, 'created', 'specifying');
    const state = await service.completeCoordinationRound(runId, draftFor(1));
    expect(state.phase).toBe('awaiting_approval');
    expect(state.specApprovedBy).toBeUndefined();
    expect(approvalEvents(db, runId)).toHaveLength(0);
  });

  it('completion + auto-approval are ONE atomic unit — a rejected T1 rolls the whole completion back', async () => {
    const { service, db } = await setup(kind, AUTO_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    expect(service.status(runId).phase).toBe('approved');

    // A second completion cannot advance `specifying → awaiting_approval` from
    // `approved`; the whole call must fail and leave the FIRST draft/approval
    // untouched — never a half-applied second draft.
    await expect(service.completeCoordinationRound(runId, draftFor(2))).rejects.toThrow();
    expect(service.status(runId).phase).toBe('approved');
    expect(String(service.status(runId).approvedSpecHash)).toBe('hash_1');
    expect(service.getSpecDraft(runId)?.specVersionId).toBe('spec_1');
    expect(approvalEvents(db, runId)).toHaveLength(1);
  });
});
