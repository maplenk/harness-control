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
import {
  OrchestrationService,
  SpecApprovalIngestError,
  SpecApprovalRefusedError,
  type RoleAdapterFactory,
} from './service.js';
import {
  ENGINE_STATE_PROJECTION,
  SPEC_DRAFT_PROJECTION,
  type MergeReadinessBlockedState,
  type SpecDraftState,
} from './projections.js';
import {
  appendableEvent,
  appendableEvents,
  draftEvent,
  UnvalidatedApprovalAppendError,
  type AppendableEvent,
  type DomainEvent,
  type EventOfType,
} from '../domain/events.js';
import { SpecApprovalProvenanceError } from '../domain/transitions.js';
import type { Verification } from '../domain/entities.js';
import {
  artifactHash,
  assignmentId,
  gitSha,
  idempotencyKey,
  mergeReadinessId,
  verificationId,
} from '../domain/ids.js';
import type { Clock } from '../lib/clock.js';

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

/**
 * B2 round 3/5: codex's bypass — a hand-built T1 handed straight to public
 * `ingest` or to `db.events.append`. Round 5 made the append boundary bind, so
 * reaching the log now needs `forcedIntoLog()` below: the explicit cast a
 * determined attacker would have to write, since `appendableEvent()` REFUSES an
 * approval at runtime. Everything after that point still has to hold.
 *
 * Public `ingest` appends transitions and never saw round 2's per-route checks,
 * which is how the original bypass worked. `as DomainEvent` is exactly how a
 * real bypass would be written (and how the ~70 existing `ingest` call sites are
 * written); the PRECISELY typed form is a compile error, which vitest cannot
 * express, so it is asserted by `@ts-expect-error` under `npm run typecheck`.
 */
function handBuiltApproval(
  runId: RunId,
  input: { readonly specVersionId: string; readonly specHash: string; readonly approvedBy: 'human' | 'auto' },
  key: string,
): DomainEvent {
  return draftEvent({
    type: 'spec.approved',
    runId,
    payload: {
      specVersionId: toSpecVersionId(input.specVersionId),
      specHash: toSpecHash(input.specHash),
      approvedBy: input.approvedBy,
    },
    idempotencyKey: idempotencyKey(key),
    occurredAt: '2026-07-25T00:00:00.000Z' as ReturnType<Clock['nowIso']>,
  }) as DomainEvent;
}

/**
 * A blocked-readiness record shaped exactly as round-2 code persisted them:
 * the whole `MergeReadiness` embedded, carrying whatever signer that build
 * computed — including the stale `'human'` the optional-signer default produced.
 */
function staleBlockedState(runId: RunId, claimedSigner: 'human' | 'auto'): MergeReadinessBlockedState {
  const verification: Verification = {
    id: verificationId('ver_stale_1'),
    runId,
    assignmentId: assignmentId('asg_stale_1'),
    specHash: toSpecHash('hash_1'),
    baseCommit: gitSha('b'.repeat(40)),
    implementationCommit: gitSha('a'.repeat(40)),
    criteria: [],
    outcome: 'all_verified',
    completedAt: '2026-07-25T00:00:00.000Z' as ReturnType<Clock['nowIso']>,
    // B2 × F13 MERGE: this fixture models a record persisted by round-2 code,
    // which predates F13 host attestation entirely. Empty is the HONEST value —
    // "recorded before receipts existed" — and it is deliberately NOT evidence
    // of a pass. That is exactly the distinction F13's read-boundary migration
    // draws, so the legacy fixture must carry it rather than fabricate receipts.
    evidenceReceipts: [],
  };
  return {
    verification,
    binding: {
      assignmentId: assignmentId('asg_stale_1'),
      specHash: toSpecHash('hash_1'),
      baseCommit: gitSha('b'.repeat(40)),
      implementationCommit: gitSha('a'.repeat(40)),
      // Cross-vendor pair, so F13's independence check has something real to
      // read; this fixture is about the SIGNER, not about harness identity.
      resolvedHarnesses: { implementor: 'grok', verifier: 'codex' },
    },
    worktreePath: '/worktree',
    probeDestinationRef: 'HEAD',
    requiredTestsPassed: true,
    approvedSpecHash: toSpecHash('hash_1'),
    mergeReadiness: {
      id: mergeReadinessId('mrg_stale_1'),
      runId,
      verificationId: verificationId('ver_stale_1'),
      specHash: toSpecHash('hash_1'),
      baseCommit: gitSha('b'.repeat(40)),
      verifiedCommit: gitSha('a'.repeat(40)),
      destinationClean: false,
      worktreeClean: true,
      baseDrifted: false,
      conflicts: false,
      requiredTestsPassed: true,
      specApprovedBy: claimedSigner,
      // Same reasoning as `evidenceReceipts` above: a round-2 record carries no
      // receipt refs, and empty here means "predates attestation", not "passed".
      evidenceReceiptRefs: [],
      ready: false,
      blockers: ['the destination working tree is dirty (human action: commit or stash the destination changes)'],
      manualIntegrationCommands: [],
      createdAt: '2026-07-25T00:00:00.000Z' as ReturnType<Clock['nowIso']>,
    },
    blockers: ['the destination working tree is dirty (human action: commit or stash the destination changes)'],
    stage: 'blocked',
    recordedAt: '2026-07-25T00:00:00.000Z' as ReturnType<Clock['nowIso']>,
  };
}


/**
 * Force an unvalidated approval past the (now binding) append boundary. There
 * is no supported way to do this — `appendableEvent()` throws on an approval
 * and the type requires a `ValidatedApproval` — so the test states the cast
 * openly. It is the exact shape the durable-log guard is defence against, and
 * the point of the tests below is that the FOLD still refuses it.
 */
function forcedIntoLog(event: DomainEvent): AppendableEvent {
  return event as unknown as AppendableEvent;
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

// ===========================================================================
// B2 ROUND 3 — the bypass codex found: public `ingest()`
//
// Round 2 asserted the binding in `approve()` and `completeCoordinationRound()`.
// Codex walked past both by handing a hand-built T1 to public `ingest`, which
// appends transitions and never saw those checks. Round 3's answer is to guard
// the STATE: `#ingestTransition` asserts for EVERY `spec.approved` it applies,
// whatever produced it. These tests drive the attack itself.
// ===========================================================================
describe.each(DRIVER_KINDS)('B2 round 3 — T1 is unreachable unvalidated [%s]', (kind) => {
  it('CODEX REPRO: a hand-built T1 through public ingest() cannot auto-approve a human-pinned, draft-less run', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service);

    expect(() =>
      service.ingest(
        handBuiltApproval(
          runId,
          { specVersionId: 'spec_fabricated', specHash: 'totally-made-up-hash', approvedBy: 'auto' },
          'bypass_1',
        ),
      ),
    ).toThrow(SpecApprovalIngestError);

    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(service.status(runId).approvedSpecHash).toBeUndefined();
    expect(service.status(runId).specApprovedBy).toBeUndefined();
    expect(approvalEvents(db, runId)).toHaveLength(0);
  });

  it('CODEX REPRO: a hand-built T1 through ingest() cannot approve a STALE revision sharing the completion hash', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, {
      ...draftFor(2),
      specHash: toSpecHash('hash_shared'),
    });
    db.projections.save(runId, SPEC_DRAFT_PROJECTION, {
      ...draftFor(1),
      specHash: toSpecHash('hash_shared'),
    });

    expect(() =>
      service.ingest(
        handBuiltApproval(
          runId,
          { specVersionId: 'spec_1', specHash: 'hash_shared', approvedBy: 'human' },
          'bypass_2',
        ),
      ),
    ).toThrow(SpecApprovalIngestError);
    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(approvalEvents(db, runId)).toHaveLength(0);
  });

  it('the gate is on the TRANSITION, not on the door: approve() carries no check of its own and still refuses', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));

    // `approve()` no longer asserts anything itself — round 3 deleted its
    // route-level check and sends the trigger straight to the transition path,
    // never through public `ingest`. So a refusal here can ONLY come from the
    // assertion on the transition. That is what makes the bypass structural:
    // the two producers and the public door all converge on one check.
    await expect(
      service.approve(runId, {
        specVersionId: toSpecVersionId('spec_1'),
        specHash: toSpecHash('hash_2'), // right run, wrong spec
      }),
    ).rejects.toBeInstanceOf(SpecApprovalRefusedError);
    expect(approvalEvents(db, runId)).toHaveLength(0);

    // …and the public door is shut for the same event type.
    expect(() =>
      service.ingest(
        handBuiltApproval(runId, { specVersionId: 'spec_1', specHash: 'hash_1', approvedBy: 'human' }, 'bypass_3'),
      ),
    ).toThrow(SpecApprovalIngestError);
    expect(approvalEvents(db, runId)).toHaveLength(0);
  });

  // NOTE ON ENFORCEMENT: this assertion is carried by `npm run typecheck`, not
  // by vitest — vitest does not typecheck, so at RUNTIME this test is trivially
  // true. Its teeth are the `@ts-expect-error` directive: tsc reports TS2578
  // "Unused '@ts-expect-error' directive" if the call below ever becomes legal,
  // so a regression in the compile-time guard FAILS the typecheck gate.
  it('a PRECISELY typed spec.approved event is a COMPILE error at ingest() (enforced by tsc, not vitest)', () => {
    const event = undefined as unknown as EventOfType<'spec.approved'>;
    const svc = undefined as unknown as OrchestrationService;
    // @ts-expect-error -- B2 round 3: `NotServiceOwned` resolves the parameter
    // to `never` for a precisely-typed service-owned event.
    const refused = (): unknown => svc.ingest(event);
    expect(typeof refused).toBe('function');
  });

  it('every other event type still ingests normally through the public surface', async () => {
    const { service } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service);
    // A plain supporting event — the guard must be surgical, not a blanket ban.
    const result = service.ingest(
      draftEvent({
        type: 'notify.requested',
        runId,
        payload: { topic: 'merge_ready', message: 'round-3 guard is surgical' },
        idempotencyKey: idempotencyKey('surgical_1'),
        occurredAt: '2026-07-25T00:00:00.000Z' as ReturnType<Clock['nowIso']>,
      }) as DomainEvent,
    );
    expect(result.status).toBe('recorded');
  });
});

// ===========================================================================
// B2 ROUND 3 — F5: the signer is derived from the durable EVENT
// ===========================================================================
describe.each(DRIVER_KINDS)('B2 round 3 — the approval signer never lies [%s]', (kind) => {
  it('CODEX REPRO: a durable approvedBy:\'auto\' event is NEVER reported as \'human\' when the projection loses the signer', async () => {
    const { service, db } = await setup(kind, AUTO_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    expect(service.status(runId).specApprovedBy).toBe('auto');

    // Damage the projection exactly as an older build would have left it:
    // hash bound, signer absent. Round 2 answered 'human' here.
    const record = db.projections.get<Record<string, unknown>>(runId, ENGINE_STATE_PROJECTION);
    expect(record).toBeDefined();
    const { specApprovedBy: _dropped, ...withoutSigner } = record!.state;
    db.projections.save(runId, ENGINE_STATE_PROJECTION, withoutSigner, record!.eventCursor);

    // The LOG still says who signed, so that is what is reported.
    expect(service.status(runId).specApprovedBy).toBe('auto');
    const signedBy = (
      db.events.listByRun(runId).find((e) => e.type === 'spec.approved')?.payload as {
        approvedBy: string;
      }
    ).approvedBy;
    expect(service.status(runId).specApprovedBy).toBe(signedBy);
  });

  it('a bound hash with NO approval event is UNKNOWN — absent, never \'human\'', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    await service.approve(runId, {
      specVersionId: toSpecVersionId('spec_1'),
      specHash: toSpecHash('hash_1'),
    });
    expect(service.status(runId).specApprovedBy).toBe('human');

    // Strip BOTH the folded signer and the event that could substantiate it.
    const record = db.projections.get<Record<string, unknown>>(runId, ENGINE_STATE_PROJECTION);
    const { specApprovedBy: _dropped, ...withoutSigner } = record!.state;
    db.projections.save(runId, ENGINE_STATE_PROJECTION, withoutSigner, record!.eventCursor);
    db.driver.prepare('DELETE FROM events WHERE run_id = ? AND type = ?').run([String(runId), 'spec.approved']);

    // Unsubstantiated approval: report nothing rather than assert a human.
    expect(service.status(runId).specApprovedBy).toBeUndefined();
    expect(service.status(runId).approvedSpecHash).toBeDefined();
  });

  it('an unapproved run reports no signer at all', async () => {
    const { service } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service);
    expect(service.status(runId).specApprovedBy).toBeUndefined();
  });
});

// ===========================================================================
// B2 ROUND 3 — the fail-open codex named: no completion ref is not permission
// ===========================================================================
describe.each(DRIVER_KINDS)('B2 round 3 — absence of a completion ref refuses the ENGINE [%s]', (kind) => {
  it("mode:'auto' on a run with NO durable completion record is REFUSED", async () => {
    const { service, db } = await setup(kind, AUTO_CONFIG());
    const runId = runAtGateWithoutDraft(service); // no drafting round ever completed
    await expect(
      service.approve(runId, {
        specVersionId: toSpecVersionId('spec_x'),
        specHash: toSpecHash('hash_x'),
        mode: 'auto',
      }),
    ).rejects.toMatchObject({ reason: 'auto_approve_without_completion' });
    expect(service.status(runId).phase).toBe('awaiting_approval');
    expect(approvalEvents(db, runId)).toHaveLength(0);
  });

  it('a HUMAN approval of the same run is still allowed (the documented pre-B2 explicit-hash path)', async () => {
    const { service } = await setup(kind, AUTO_CONFIG());
    const runId = runAtGateWithoutDraft(service);
    const applied = await service.approve(runId, {
      specVersionId: toSpecVersionId('spec_x'),
      specHash: toSpecHash('hash_x'),
    });
    expect(applied.status).toBe('applied');
    expect(service.status(runId).specApprovedBy).toBe('human');
  });
});

// ===========================================================================
// B2 ROUND 4 — the DURABLE LOG boundary
//
// Round 3 converged every SERVICE producer on one assertion. Codex then went
// under it: `db.events.append`/`appendBatch` and `appendTriggerWithEffects` are
// PUBLIC and used to accept any DomainEvent, and `recover()` folds whatever is
// in the log. Round 4's answer is two-layered:
//   compile — the append signatures require a `ValidatedApproval` brand that
//             only the service's validated path mints;
//   STATE   — `applyTransition` refuses a T1 whose provenance the LOG ITSELF
//             contradicts, so a row written straight into the store cannot fold
//             into `approved` even on replay.
// ===========================================================================
describe.each(DRIVER_KINDS)('B2 round 4 — an unvalidated T1 in the durable log [%s]', (kind) => {
  it('CODEX REPRO: a hand-built T1 appended straight to db.events cannot be RECOVERED into approved', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));

    // Straight past every service check, into the durable log.
    db.events.append(
      forcedIntoLog(
        handBuiltApproval(
          runId,
          { specVersionId: 'spec_fabricated', specHash: 'totally-made-up-hash', approvedBy: 'auto' },
          'log_bypass_1',
        ),
      ),
    );
    // It IS in the log — the append boundary is a compile-time guard, not a
    // runtime one, and this test deliberately widened past it.
    expect(db.events.listByRun(runId).some((e) => e.type === 'spec.approved')).toBe(true);

    // …and it can never become state: the fold refuses, naming the run.
    expect(() => service.recover(runId)).toThrow(SpecApprovalProvenanceError);
    expect(service.status(runId).phase).toBe('awaiting_approval');
  });

  it('a hand-built T1 that claims auto with NO completed round is refused by the fold', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service); // no completion ref in the log

    db.events.append(
      forcedIntoLog(
        handBuiltApproval(runId, { specVersionId: 's', specHash: 'h', approvedBy: 'auto' }, 'log_bypass_2'),
      ),
    );
    expect(() => service.recover(runId)).toThrow(SpecApprovalProvenanceError);
    expect(service.status(runId).phase).toBe('awaiting_approval');
  });

  it('a hand-built T1 naming a STALE version/hash is refused by the fold', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(2));

    db.events.append(
      forcedIntoLog(
        handBuiltApproval(
          runId,
          { specVersionId: 'spec_1', specHash: 'hash_1', approvedBy: 'human' }, // superseded
          'log_bypass_3',
        ),
      ),
    );
    expect(() => service.recover(runId)).toThrow(SpecApprovalProvenanceError);
    expect(service.status(runId).phase).toBe('awaiting_approval');
  });

  it('a LEGITIMATE approval still recovers cleanly — the guard is surgical, not a blanket refusal', async () => {
    const { service } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    await service.approve(runId, {
      specVersionId: toSpecVersionId('spec_1'),
      specHash: toSpecHash('hash_1'),
    });
    expect(service.status(runId).phase).toBe('approved');

    // Full replay from the log reproduces the same state, no throw.
    const recovered = service.recover(runId);
    expect(recovered.phase).toBe('approved');
    expect(recovered.specApprovedBy).toBe('human');
    expect(String(recovered.approvedSpecHash)).toBe('hash_1');
  });

  it('a run that never drafted still recovers a HUMAN approval (the deliberate asymmetry, on the log side too)', async () => {
    const { service } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service);
    await service.approve(runId, {
      specVersionId: toSpecVersionId('spec_imported'),
      specHash: toSpecHash('hash_imported'),
    });
    const recovered = service.recover(runId);
    expect(recovered.phase).toBe('approved');
    expect(recovered.specApprovedBy).toBe('human');
  });

  // ENFORCEMENT: these three assertions are carried by `npm run typecheck`, not
  // by vitest (which does not typecheck) — at RUNTIME they are trivially true.
  // Their teeth are the `@ts-expect-error` directives: tsc reports TS2578
  // "Unused '@ts-expect-error' directive" the moment any of these calls becomes
  // legal again, so a regression fails the typecheck gate. Measured on the
  // round-4 parent, all three COMPILED — which is why round 5 exists.
  it('the append boundary rejects an unbranded approval in all three shapes (enforced by tsc, not vitest)', () => {
    const event = undefined as unknown as EventOfType<'spec.approved'>;
    const other = undefined as unknown as EventOfType<'pause.user.requested'>;
    const widened = undefined as unknown as DomainEvent;
    const events = undefined as unknown as TestDatabaseHandle['db']['events'];

    // 1. precisely typed, single
    // @ts-expect-error -- `AppendableEvent` requires the `ValidatedApproval`
    // brand, which only the service's validated path mints.
    const single = (): unknown => events.append(event);

    // 2. codex (c): a UNION batch. Round 4's non-distributive conditional
    // tested the union's `type` as one type, so this compiled.
    // @ts-expect-error -- the conditional now DISTRIBUTES over union members.
    const union = (): unknown => events.appendBatch([event, other]);

    // 3. codex (c): a widened `DomainEvent`. Round 4 accepted this too, which
    // is exactly why the zero-churn result was the tell, not the win.
    // @ts-expect-error -- `DomainEvent` includes the unbranded approval member.
    const wide = (): unknown => events.append(widened);

    expect([single, union, wide].every((f) => typeof f === 'function')).toBe(true);
  });
});

// ===========================================================================
// B2 ROUND 4 — BLOCKER 2: a persisted projection is UNTRUSTED INPUT
// ===========================================================================
describe.each(DRIVER_KINDS)('B2 round 4 — stale persisted attribution is migrated on read [%s]', (kind) => {
  it("CODEX REPRO: a round-2 blocked record claiming 'human' is corrected from the event log, not republished", async () => {
    const { service, db } = await setup(kind, AUTO_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    expect(service.status(runId).specApprovedBy).toBe('auto'); // the LOG says auto

    // A record as round-2 code would have written it: the stale 'human' lie.
    service.saveMergeReadinessBlocked(runId, staleBlockedState(runId, 'human'));

    const read = service.getMergeReadinessBlocked(runId);
    expect(read?.mergeReadiness.specApprovedBy).toBe('auto');
  });

  it("a record whose signer the log cannot substantiate reads as 'unknown', never 'human'", async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service); // never approved at all
    service.saveMergeReadinessBlocked(runId, staleBlockedState(runId, 'human'));

    const read = service.getMergeReadinessBlocked(runId);
    expect(read?.mergeReadiness.specApprovedBy).toBe('unknown');
    expect(read?.mergeReadiness.specApprovedBy).not.toBe('human');
  });

  it('a record that already agrees with the log is returned untouched', async () => {
    const { service } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    await service.approve(runId, {
      specVersionId: toSpecVersionId('spec_1'),
      specHash: toSpecHash('hash_1'),
    });
    const stored = staleBlockedState(runId, 'human');
    service.saveMergeReadinessBlocked(runId, stored);
    expect(service.getMergeReadinessBlocked(runId)?.mergeReadiness.specApprovedBy).toBe('human');
  });
});

// ===========================================================================
// B2 ROUND 5 — codex's three exact shapes
//
// (b) `lastDraftRef` was not reliable in every supported state, so the pure
//     comparison could be satisfied by stale or missing provenance:
//       - recovery is INCREMENTAL, so a projection whose cursor is already past
//         the completion advance has no ref and never backfills it;
//       - a BARE `specifying → awaiting_approval` advance did not CLEAR the
//         previous ref, so a superseded version still matched.
//     Both were the same error: an absent ref meant two different things and
//     the check took the permissive one. Round 5 makes them distinguishable.
//
// (c) the brand did not bind: `AppendableEvent` tested `E['type']`
//     NON-DISTRIBUTIVELY, so a union — `appendBatch([approval, other])` — and a
//     widened `DomainEvent` both slipped through unbranded.
// ===========================================================================
describe.each(DRIVER_KINDS)('B2 round 5 — provenance is UNDETERMINABLE, not absent [%s]', (kind) => {
  it('CODEX REPRO: a projection resumed PAST the completion advance refuses an ENGINE signature', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));

    // Exactly what a pre-round-4 build leaves behind: a projection whose cursor
    // is past the completion advance and which never recorded `lastDraftRef`.
    const record = db.projections.get<Record<string, unknown>>(runId, ENGINE_STATE_PROJECTION);
    expect(record).toBeDefined();
    const { lastDraftRef: _noRef, historyComplete: _noMarker, ...legacyState } = record!.state;
    db.projections.save(runId, ENGINE_STATE_PROJECTION, legacyState, record!.eventCursor);

    // The attack is a DIRECT append plus a recovery — the service's own check
    // reads the log and would catch an `approve()` call, so the fold is the
    // layer under test.
    //
    // B2 round 6 NOTE: this originally used an `approvedBy:'human'` payload,
    // and round 6 deliberately made that case permissive again — gating human
    // approval on the marker would strand every run already in the live store,
    // since `recover()` is incremental and nothing rebuilds from sequence 1.
    // The ENGINE signature is what may never rest on unjudgeable provenance, so
    // that is what this asserts. The human half of the same state is covered by
    // the round-6 upgrade-path test below.
    db.events.append(
      forcedIntoLog(
        handBuiltApproval(
          runId,
          { specVersionId: 'spec_anything', specHash: 'hash_anything', approvedBy: 'auto' },
          'undeterminable_1',
        ),
      ),
    );
    expect(() => service.recover(runId)).toThrow(SpecApprovalProvenanceError);
    try {
      service.recover(runId);
    } catch (error) {
      expect((error as SpecApprovalProvenanceError).reason).toBe('provenance_undeterminable');
    }
    expect(service.status(runId).phase).toBe('awaiting_approval');
  });

  it('a state built from the COMPLETE history keeps the permissive human path (the retained asymmetry)', async () => {
    const { service } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service); // folded from sequence 1, no completion
    const applied = await service.approve(runId, {
      specVersionId: toSpecVersionId('spec_imported'),
      specHash: toSpecHash('hash_imported'),
    });
    expect(applied.status).toBe('applied');
    expect(service.status(runId).specApprovedBy).toBe('human');
  });

  it('CODEX REPRO: a revise followed by a BARE completion clears the superseded reference', async () => {
    const { service, db } = await setup(kind, AUTO_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    expect(service.status(runId).phase).toBe('approved'); // auto-signed round 1

    // Back to specifying, then complete BARE — the pure-runner seam, which
    // advances WITHOUT a draft ref. Round 4 only ever SET the reference, so
    // `spec_1`'s ref survived and an approval naming it still "matched".
    service.advanceWorkflowPhase(runId, 'approved', 'implementing');
    db.projections.save(runId, ENGINE_STATE_PROJECTION, {
      ...service.status(runId),
      phase: 'specifying',
      suspension: { kind: 'none' },
      operation: { kind: 'idle' },
      counters: { restartsInWindow: 0, lifetimeRestarts: 0, remediationRounds: 0, probesInIncident: 0 },
      historyComplete: true,
      lastDraftRef: {
        artifactHash: artifactHash('hash_1'),
        specVersionId: toSpecVersionId('spec_1'),
        specHash: toSpecHash('hash_1'),
        revision: 1,
      },
    });
    service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval'); // BARE

    // The security-relevant consequence: with the superseded reference cleared
    // there is no drafted provenance, so the ENGINE may not sign at all. (A
    // HUMAN still may — the asymmetry codex told me to retain: a person can
    // attest an unbacked hash, the engine cannot.)
    await expect(
      service.approve(runId, {
        specVersionId: toSpecVersionId('spec_1'),
        specHash: toSpecHash('hash_1'),
        mode: 'auto',
      }),
    ).rejects.toMatchObject({ reason: 'auto_approve_without_completion' });
    expect(approvalEvents(db, runId).filter((e) => (e.payload as { approvedBy: string }).approvedBy === 'auto'))
      .toHaveLength(1); // only round 1's, none from this attempt
  });
});

describe.each(DRIVER_KINDS)('B2 round 5 — the append brand actually binds [%s]', (kind) => {
  it('CODEX REPRO: appendBatch([approval, other]) — the UNION no longer slips an unbranded approval through', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    const approval = handBuiltApproval(
      runId,
      { specVersionId: 'spec_1', specHash: 'hash_1', approvedBy: 'human' },
      'union_bypass_1',
    );
    const other = draftEvent({
      type: 'notify.requested',
      runId,
      payload: { topic: 'merge_ready', message: 'filler' },
      idempotencyKey: idempotencyKey('union_bypass_filler'),
      occurredAt: '2026-07-25T00:00:00.000Z' as ReturnType<Clock['nowIso']>,
    }) as DomainEvent;

    // The runtime half of the boundary: the batch helper refuses the approval,
    // so the mixed batch cannot be laundered through a union.
    expect(() => appendableEvents([approval, other])).toThrow(UnvalidatedApprovalAppendError);
    // …and nothing partial was written.
    expect(approvalEvents(db, runId)).toHaveLength(0);
  });

  it('a widened DomainEvent approval is REFUSED by appendableEvent (round 4 accepted it silently)', async () => {
    const { service } = await setup(kind, HUMAN_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    const widened: DomainEvent = handBuiltApproval(
      runId,
      { specVersionId: 'spec_1', specHash: 'hash_1', approvedBy: 'human' },
      'widened_bypass_1',
    );
    expect(() => appendableEvent(widened)).toThrow(UnvalidatedApprovalAppendError);
  });

  it('non-approval events pass the boundary unchanged — the guard is surgical', async () => {
    const { service } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service);
    const fact = draftEvent({
      type: 'notify.requested',
      runId,
      payload: { topic: 'merge_ready', message: 'ok' },
      idempotencyKey: idempotencyKey('surgical_r5'),
      occurredAt: '2026-07-25T00:00:00.000Z' as ReturnType<Clock['nowIso']>,
    }) as DomainEvent;
    expect(() => appendableEvent(fact)).not.toThrow();
    expect(appendableEvents([fact, fact])).toHaveLength(2);
  });
});

// ===========================================================================
// B2 ROUND 6 — the marker gates the ENGINE only, checked FIRST
//
// Round 5 checked `historyComplete` only inside the `ref === undefined` branch,
// so a projection with NO marker but a STALE reference still behind its cursor
// was trusted, and an `approvedBy:'auto'` approval matching that stale
// reference reached `approved`. Round 6 hoists the check and gates it on `auto`
// alone — which also keeps the parent-to-branch UPGRADE path open, because
// `recover()` is incremental and nothing rebuilds a projection from sequence 1.
// ===========================================================================
describe.each(DRIVER_KINDS)('B2 round 6 — an UNVOUCHABLE reference cannot carry an engine signature [%s]', (kind) => {
  /** A projection as a pre-marker build left it: reference present, marker absent. */
  function stripMarkerKeepingRef(db: TestDatabaseHandle['db'], runId: RunId): void {
    const record = db.projections.get<Record<string, unknown>>(runId, ENGINE_STATE_PROJECTION);
    expect(record).toBeDefined();
    expect(record!.state['lastDraftRef']).toBeDefined(); // the reference survives
    const { historyComplete: _dropped, ...withoutMarker } = record!.state;
    db.projections.save(runId, ENGINE_STATE_PROJECTION, withoutMarker, record!.eventCursor);
  }

  // ACCURACY NOTE (round-6 review): this constructs a reference that is CURRENT
  // but unvouchable — round 1's own completion ref, with the marker stripped so
  // the projection cannot testify that it saw enough history to judge it. No
  // later bare advance supersedes it, so calling it "stale" (as the first draft
  // of this test did) overstated the setup. The branch under test is the one
  // that matters and is unchanged: marker absent + reference present + ENGINE
  // signature must refuse, because round 5 checked the marker only INSIDE the
  // `ref === undefined` arm and so never reached it when a reference existed.
  it("no marker + a PRESENT reference + an 'auto' approval MATCHING it → refused", async () => {
    const { service, db } = await setup(kind, AUTO_CONFIG());
    // Round 1 completes and is auto-signed, leaving a reference in the state.
    const runId = await runWithCompletedDraft(service, draftFor(1));
    expect(service.status(runId).phase).toBe('approved');

    // Rewind to awaiting_approval with the reference intact and the marker
    // stripped — exactly the pre-round-5 shape codex probed.
    const record = db.projections.get<Record<string, unknown>>(runId, ENGINE_STATE_PROJECTION);
    db.projections.save(
      runId,
      ENGINE_STATE_PROJECTION,
      { ...record!.state, phase: 'awaiting_approval' },
      record!.eventCursor,
    );
    stripMarkerKeepingRef(db, runId);

    // The approval MATCHES the reference, so round 5's binding comparison was
    // satisfied and the marker check never ran. It must be refused now.
    await expect(
      service.approve(runId, {
        specVersionId: toSpecVersionId('spec_1'),
        specHash: toSpecHash('hash_1'),
        mode: 'auto',
      }),
    ).rejects.toMatchObject({ reason: 'provenance_undeterminable' });
    expect(service.status(runId).phase).toBe('awaiting_approval');
    // Only round 1's own approval is in the log — this attempt appended nothing.
    expect(approvalEvents(db, runId)).toHaveLength(1);
  });

  it('the SAME state still accepts a HUMAN approval — the upgrade path is not stranded', async () => {
    const { service, db } = await setup(kind, AUTO_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    const record = db.projections.get<Record<string, unknown>>(runId, ENGINE_STATE_PROJECTION);
    db.projections.save(
      runId,
      ENGINE_STATE_PROJECTION,
      { ...record!.state, phase: 'awaiting_approval' },
      record!.eventCursor,
    );
    stripMarkerKeepingRef(db, runId);

    const applied = await service.approve(runId, {
      specVersionId: toSpecVersionId('spec_1'),
      specHash: toSpecHash('hash_1'),
    });
    expect(applied.status).toBe('applied');
    expect(service.status(runId).specApprovedBy).toBe('human');
  });

  it('BLOCKER 2: a PARENT-SHAPED human run (no marker, no reference) is still approvable', async () => {
    const { service, db } = await setup(kind, HUMAN_CONFIG());
    const runId = runAtGateWithoutDraft(service);
    // Strip the marker to model a projection persisted by an older build — the
    // shape every run in the live store has today.
    const record = db.projections.get<Record<string, unknown>>(runId, ENGINE_STATE_PROJECTION);
    const { historyComplete: _dropped, ...legacy } = record!.state;
    db.projections.save(runId, ENGINE_STATE_PROJECTION, legacy, record!.eventCursor);
    expect(db.projections.get<Record<string, unknown>>(runId, ENGINE_STATE_PROJECTION)!.state['historyComplete'])
      .toBeUndefined();

    // There is no rebuild-from-sequence-1 operation, so refusing here would
    // strand the run permanently. It must approve.
    const applied = await service.approve(runId, {
      specVersionId: toSpecVersionId('spec_legacy'),
      specHash: toSpecHash('hash_legacy'),
    });
    expect(applied.status).toBe('applied');
    expect(service.status(runId).phase).toBe('approved');
    expect(service.status(runId).specApprovedBy).toBe('human');
  });

  it('a marker-carrying run still auto-approves normally — the gate is surgical', async () => {
    const { service } = await setup(kind, AUTO_CONFIG());
    const runId = await runWithCompletedDraft(service, draftFor(1));
    expect(service.status(runId).phase).toBe('approved');
    expect(service.status(runId).specApprovedBy).toBe('auto');
  });
});
