/**
 * Verifier FLOW + remediation + merge-readiness (PLAN §8, §16, §6.1) — offline
 * deterministic tests against the in-process fake adapter + a real
 * OrchestrationService (no real spawns). Covers the PLAN §19 rows this flow
 * owns:
 *  - 12 missing verifier evidence blocks `merge_ready` (passed-without-evidence
 *    → unproven → T23);
 *  - 18 merge-readiness rejects dirty/drift/conflict/wrong-commit/failed-criteria
 *    (the §16 gate, plus a real-git probe for the git-side facts);
 *  - 22 mechanical checkpoint sufficiency on a successor (resume from a
 *    checkpoint's criterionStates + artifactRefs ALONE → completes → merge_ready);
 *  plus the core §8 contract: verifier maps every criterion to its OWN evidence;
 *  the coordinator exploration artifact is an untrusted index, never evidence;
 *  mixed verdicts drive T23 (needs_remediation) with structured fix-requests;
 *  and the W1-F1/W2-2 gate: `merge_ready` asserts criteria-all-verified AND
 *  `MergeReadiness.ready`, with blockers SPLIT by actionability (W2-2):
 *  agent-actionable blockers (worktree-dirt, required-tests; mixed sets
 *  included) force T23 with `integration_blocker` fix-requests; user-ONLY
 *  blockers (destination dirty / base drift / conflicts) take the durable
 *  `merge.readiness.blocked` path (REMAIN `verifying`, no remediation round,
 *  rechecked via `recheckMergeReadiness`); a missing probe and a wrong-commit
 *  probe result are TYPED orchestration errors (deliberate Rev-2 correction
 *  of Wave 1's probe-absent→T23 fail-safe).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactHash,
  assignmentId,
  criterionId,
  eventSequence,
  gitSha,
  runId as mkRunId,
  specHash,
  specVersionId,
  type ArtifactHash,
} from '../../domain/ids.js';
import type { AcceptanceCriterion, CriterionResult, WorktreeState } from '../../domain/entities.js';
import {
  InProcessFakeAdapter,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
} from '../../adapters/index.js';
import { DeterministicIdFactory } from '../../lib/id-factory.js';
import { ManualClock } from '../../lib/clock.js';
import { openTestDatabase, type TestDatabaseHandle } from '../../persistence/test-support.js';
import { buildCheckpointContent } from '../../checkpoint/content.js';
import { makeTempGitRepo } from '../../worktree/test-support.js';
import { OrchestrationService, type RoleAdapterFactory } from '../service.js';
import type { Harness, RoleModelSpec } from '../model-resolution.js';
import { CLEAN_PINNED_WORKSPACE_GIT, createRunFixture } from '../test-support.js';
import {
  MergeReadinessCommitMismatchError,
  MergeReadinessProbeMissingError,
  buildMergeReadiness,
  buildVerification,
  buildVerifierPrompt,
  deriveRequiredTestsPassed,
  formatFixRequests,
  gitMergeReadinessProbe,
  parseVerifierReport,
  recheckMergeReadiness,
  runVerification,
  splitReadinessBlockers,
  verificationTriggerEvent,
  type EvidenceRecorder,
  type GitMergeFacts,
  type MergeReadinessProbe,
  type UntrustedExplorationIndex,
  type VerificationBinding,
  type VerifierGathering,
  type VerifierResumeState,
} from './verifier.js';
import type { RunId } from '../../domain/ids.js';
import type { Verification } from '../../domain/entities.js';

// ---------------------------------------------------------------------------
// Fakes
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

interface CreatedFake {
  readonly adapter: InProcessFakeAdapter;
}

function makeFakeFactory(turns?: readonly InProcessTurnScript[]): {
  factory: RoleAdapterFactory;
  created: CreatedFake[];
} {
  const created: CreatedFake[] = [];
  const factory: RoleAdapterFactory = {
    create(options) {
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: fakeConfigOptions(options.resolved.harness) },
        ...(turns !== undefined ? { turns } : {}),
      });
      created.push({ adapter });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory, created };
}

/** Deterministic in-memory evidence sink (records every gathered evidence). */
function fakeEvidence(): {
  recorder: EvidenceRecorder;
  records: Array<{ criterionId: string; content: string; hash: string }>;
} {
  const records: Array<{ criterionId: string; content: string; hash: string }> = [];
  let n = 0;
  const recorder: EvidenceRecorder = {
    async record(input) {
      n += 1;
      const hash = `ev_${String(input.criterionId)}_${n}`;
      records.push({ criterionId: String(input.criterionId), content: input.content, hash });
      return artifactHash(hash);
    },
  };
  return { recorder, records };
}

function fixedProbe(facts: GitMergeFacts): MergeReadinessProbe {
  return { probe: async (): Promise<GitMergeFacts> => facts };
}

// ---------------------------------------------------------------------------
// Small builders
// ---------------------------------------------------------------------------
const CLAUDE_LOW: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const SPEC_HASH = specHash('spec_hash_1');
const IMPL_COMMIT = gitSha('a'.repeat(40));
const BASE_COMMIT = gitSha('b'.repeat(40));

function crit(id: string, commands: readonly string[] = [`run-${id}`]): AcceptanceCriterion {
  return { id: criterionId(id), description: `Criterion ${id}`, verificationCommands: commands };
}

function reportTurn(
  rows: ReadonlyArray<{ id: string; verdict: string; evidence?: string; fix?: string }>,
): InProcessTurnScript {
  const payload = {
    criteria: rows.map((r) => ({
      id: r.id,
      verdict: r.verdict,
      ...(r.evidence !== undefined ? { evidence: r.evidence } : {}),
      ...(r.fix !== undefined ? { fix: r.fix } : {}),
    })),
  };
  return { updates: [{ kind: 'agent_message_chunk', text: JSON.stringify(payload) }], result: { stopReason: 'end_turn' } };
}

function binding(overrides: Partial<VerificationBinding> = {}): VerificationBinding {
  return {
    assignmentId: assignmentId('asg_1'),
    specHash: SPEC_HASH,
    baseCommit: BASE_COMMIT,
    implementationCommit: IMPL_COMMIT,
    repoRoot: '/repo',
    worktreeBranch: 'harness/asg_1',
    destinationRef: 'main',
    ...overrides,
  };
}

function goodFacts(): GitMergeFacts {
  return {
    currentImplementationCommit: IMPL_COMMIT,
    destinationClean: true,
    baseDrifted: false,
    conflicts: false,
    worktreeClean: true,
    worktreeDirtyFiles: [],
  };
}

function promptCount(adapter: InProcessFakeAdapter): number {
  return adapter.log.filter((e) => e.op === 'prompt').length;
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let dbHandle: TestDatabaseHandle | undefined;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  dbHandle?.close();
  dbHandle?.cleanup();
  dbHandle = undefined;
  for (const c of cleanups.splice(0)) await c();
});

async function setup(turns?: readonly InProcessTurnScript[]): Promise<{
  service: OrchestrationService;
  db: TestDatabaseHandle['db'];
  ids: DeterministicIdFactory;
  created: CreatedFake[];
  runId: RunId;
}> {
  dbHandle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const db = dbHandle.db;
  const ids = new DeterministicIdFactory();
  const { factory, created } = makeFakeFactory(turns);
  const service = new OrchestrationService({
    db,
    ids,
    adapterFactory: factory,
    workspaceGit: CLEAN_PINNED_WORKSPACE_GIT,
  });
  const { runId } = createRunFixture(service, { goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
  return { service, db, ids, created, runId };
}

/** Drive the run created → … → verifying (the phase T23/T24 require). */
async function driveToVerifying(service: OrchestrationService, runId: RunId): Promise<void> {
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  const approved = await service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: SPEC_HASH });
  expect(approved.status).toBe('applied');
  service.advanceWorkflowPhase(runId, 'approved', 'implementing');
  service.advanceWorkflowPhase(runId, 'implementing', 'verifying');
  expect(service.status(runId).phase).toBe('verifying');
}

// ===========================================================================
// Pure: prompt + parse
// ===========================================================================
describe('verifier prompt + report parsing (§8)', () => {
  it('builds a prompt that labels the exploration index UNTRUSTED and never shows its hash as content', () => {
    const explorationIndex: UntrustedExplorationIndex = {
      sourceCommit: gitSha('c'.repeat(40)),
      artifactHash: artifactHash('explore_hash'),
      entries: ['src/flag.ts', 'src/cli.ts'],
    };
    const prompt = buildVerifierPrompt({ criteria: [crit('C1')], implementationCommit: IMPL_COMMIT, explorationIndex });
    expect(prompt).toContain('UNTRUSTED');
    expect(prompt).toContain('NOT EVIDENCE');
    expect(prompt).toContain(String(explorationIndex.sourceCommit));
    expect(prompt).toContain('src/flag.ts');
    // §8: the artifact hash itself is never injected as evidence-shaped content.
    expect(prompt).not.toContain(String(explorationIndex.artifactHash));
    expect(prompt).toContain(String(IMPL_COMMIT));
  });

  it('parses a well-formed report, tolerates surrounding prose, and normalizes unknown verdicts', () => {
    const clean = parseVerifierReport('{"criteria":[{"id":"C1","verdict":"passed","evidence":"ok"}]}');
    expect(clean.get('C1')).toEqual({ verdict: 'passed', evidence: 'ok' });

    const prosey = parseVerifierReport('Here is my report:\n{"criteria":[{"id":"C2","verdict":"bogus"}]}\nDone.');
    expect(prosey.get('C2')?.verdict).toBe('unproven'); // unknown → fail-safe unproven

    expect(parseVerifierReport('not json at all').size).toBe(0);
    expect(parseVerifierReport('').size).toBe(0);
  });
});

// ===========================================================================
// Flow: mixed verdicts → remediation (T23)
// ===========================================================================
describe('verifier flow — mixed verdicts drive remediation (T23, §8)', () => {
  it('any failed/unproven → verification.completed.failed → needs_remediation with structured fix-requests', async () => {
    const turns = [
      reportTurn([
        { id: 'C1', verdict: 'passed', evidence: 'ran run-C1: exit 0' },
        { id: 'C2', verdict: 'failed', evidence: 'grep flag src → empty', fix: 'wire the flag in src/cli.ts' },
      ]),
    ];
    const { service, db, ids, runId } = await setup(turns);
    await driveToVerifying(service, runId);
    const { recorder } = fakeEvidence();

    const result = await runVerification({
      engine: service,
      runId,
      verifierSpec: CLAUDE_LOW,
      cwd: '/worktree',
      binding: binding(),
      criteria: [crit('C1'), crit('C2')],
      evidence: recorder,
      ids,
      clock: db.clock,
    });

    expect(result.gathering.outcome).toBe('blocked');
    expect(result.transition.status).toBe('applied');
    if (result.transition.status === 'applied') expect(result.transition.transitionId).toBe('T23');
    expect(service.status(runId).phase).toBe('needs_remediation');
    expect(service.status(runId).counters.remediationRounds).toBe(1);
    expect(result.mergeReadiness).toBeUndefined();

    // Structured fix-request for the blocking criterion (the REMEDIATION payload).
    expect(result.gathering.fixRequests).toHaveLength(1);
    const fix = result.gathering.fixRequests[0]!;
    expect(fix.kind).toBe('criterion');
    expect(result.fixRequests).toEqual(result.gathering.fixRequests); // criteria path: same payload
    expect(fix.criterionId).toBe('C2');
    expect(fix.verdict).toBe('failed');
    expect(fix.requestedChange).toBe('wire the flag in src/cli.ts');
    expect(formatFixRequests(result.gathering.fixRequests)).toContain('wire the flag in src/cli.ts');

    // Went through the ONE authoritative path: trigger + remediation effect logged.
    const types = db.events.listByRun(runId).map((e) => e.type);
    expect(types).toContain('verification.completed.failed');
    expect(types).toContain('remediation.started');
  });
});

// ===========================================================================
// Flow: all pass → merge_ready (T24) with evidence
// ===========================================================================
describe('verifier flow — all criteria verified → merge_ready (T24, §16)', () => {
  it('all passed with evidence → verification.completed.passed → merge_ready + a ready MergeReadiness', async () => {
    const turns = [
      reportTurn([
        { id: 'C1', verdict: 'passed', evidence: 'ran run-C1: 12 passing' },
        { id: 'C2', verdict: 'passed', evidence: 'ran run-C2: exit 0' },
      ]),
    ];
    const { service, db, ids, runId } = await setup(turns);
    await driveToVerifying(service, runId);
    const { recorder, records } = fakeEvidence();

    const result = await runVerification({
      engine: service,
      runId,
      verifierSpec: CLAUDE_LOW,
      cwd: '/worktree',
      binding: binding(),
      criteria: [crit('C1'), crit('C2')],
      evidence: recorder,
      mergeReadinessProbe: fixedProbe(goodFacts()),
      ids,
      clock: db.clock,
    });

    expect(result.gathering.outcome).toBe('all_verified');
    expect(result.transition.status).toBe('applied');
    if (result.transition.status === 'applied') expect(result.transition.transitionId).toBe('T24');
    expect(service.status(runId).phase).toBe('merge_ready');

    // Every criterion is backed by the verifier's OWN gathered evidence (§8).
    expect(records).toHaveLength(2);
    for (const c of result.verification.criteria) {
      expect(c.verdict).toBe('passed');
      expect(c.evidenceRefs).toHaveLength(1);
    }

    // §16: MergeReadiness binds spec hash + base + impl commit and is ready.
    const mr = result.mergeReadiness!;
    expect(mr).toBeDefined();
    expect(mr.ready).toBe(true);
    expect(mr.specHash).toBe(SPEC_HASH);
    expect(mr.baseCommit).toBe(BASE_COMMIT);
    expect(mr.verifiedCommit).toBe(IMPL_COMMIT);
    expect(mr.worktreeClean).toBe(true); // W1-F4 clean-worktree gate held
    expect(mr.blockers).toEqual([]); // ready ⇒ no blockers (W1-F1)
    expect(result.fixRequests).toEqual([]); // nothing to remediate
    // Reports the exact manual command — never executes it.
    expect(mr.manualIntegrationCommands.some((c) => c.includes('merge --no-ff'))).toBe(true);

    const types = db.events.listByRun(runId).map((e) => e.type);
    expect(types).toContain('verification.completed.passed');
    expect(types).toContain('merge.readiness.recorded');
  });

  it('never lets the coordinator exploration artifact become evidence (§8)', async () => {
    const explorationIndex: UntrustedExplorationIndex = {
      sourceCommit: gitSha('c'.repeat(40)),
      artifactHash: artifactHash('explore_hash'),
      entries: ['src/flag.ts'],
    };
    const turns = [reportTurn([{ id: 'C1', verdict: 'passed', evidence: 'ran run-C1: ok' }])];
    const { service, db, ids, runId } = await setup(turns);
    await driveToVerifying(service, runId);
    const { recorder } = fakeEvidence();

    const result = await runVerification({
      engine: service,
      runId,
      verifierSpec: CLAUDE_LOW,
      cwd: '/worktree',
      binding: binding(),
      criteria: [crit('C1')],
      evidence: recorder,
      explorationIndex,
      mergeReadinessProbe: fixedProbe(goodFacts()),
      ids,
      clock: db.clock,
    });

    const allRefs: ArtifactHash[] = result.verification.criteria.flatMap((c) => [...c.evidenceRefs]);
    expect(allRefs.map(String)).not.toContain(String(explorationIndex.artifactHash));
    expect(result.gathering.outcome).toBe('all_verified');
  });
});

// ===========================================================================
// §19 test 12 — missing verifier evidence blocks merge_ready
// ===========================================================================
describe('verifier flow — missing evidence blocks merge_ready (§19 test 12)', () => {
  it('a passed verdict with NO gathered evidence is downgraded to unproven → T23', async () => {
    const turns = [
      reportTurn([
        { id: 'C1', verdict: 'passed' }, // claims passed but supplies no evidence
        { id: 'C2', verdict: 'passed', evidence: 'ran run-C2: ok' },
      ]),
    ];
    const { service, db, ids, runId } = await setup(turns);
    await driveToVerifying(service, runId);
    const { recorder, records } = fakeEvidence();

    const result = await runVerification({
      engine: service,
      runId,
      verifierSpec: CLAUDE_LOW,
      cwd: '/worktree',
      binding: binding(),
      criteria: [crit('C1'), crit('C2')],
      evidence: recorder,
      mergeReadinessProbe: fixedProbe(goodFacts()),
      ids,
      clock: db.clock,
    });

    const c1 = result.verification.criteria.find((c) => String(c.criterionId) === 'C1')!;
    expect(c1.verdict).toBe('unproven'); // downgraded — no evidence
    expect(c1.evidenceRefs).toHaveLength(0);
    expect(records.map((r) => r.criterionId)).toEqual(['C2']); // only C2 recorded evidence

    expect(result.gathering.outcome).toBe('blocked');
    expect(result.mergeReadiness).toBeUndefined();
    if (result.transition.status === 'applied') expect(result.transition.transitionId).toBe('T23');
    expect(service.status(runId).phase).toBe('needs_remediation');

    // The blocking event names C1 as unproven, not failed.
    const failedEvent = db.events
      .listByRun(runId)
      .find((e) => e.type === 'verification.completed.failed');
    expect(failedEvent).toBeDefined();
    const payload = failedEvent!.payload as unknown as { unprovenCriteria: readonly string[] };
    expect(payload.unprovenCriteria).toContain('C1');
  });
});

// ===========================================================================
// W1-F1/W2-2 — merge_ready asserts criteria-all-verified AND §16 readiness;
// blockers are SPLIT by actionability (W2-2 rework of the Wave-1 behavior)
// ===========================================================================
describe('W1-F1/W2-2 — the merge_ready gate asserts the FULL §16 readiness, split by actionability', () => {
  /** Drive one round where EVERY criterion verifies; the §16 probe facts are
   * the variable under test. */
  async function runAllPassingVerification(options: {
    /** Omitted → NO probe supplied (W2-2: the typed-error path). */
    readonly facts?: GitMergeFacts;
    readonly criteria?: readonly AcceptanceCriterion[];
    readonly resumeFrom?: VerifierResumeState;
    readonly turns?: readonly InProcessTurnScript[];
  }): Promise<{
    service: OrchestrationService;
    db: TestDatabaseHandle['db'];
    ids: DeterministicIdFactory;
    runId: RunId;
    result: Awaited<ReturnType<typeof runVerification>>;
  }> {
    const criteria = options.criteria ?? [crit('C1')];
    const turns =
      options.turns ??
      [reportTurn(criteria.map((c) => ({ id: String(c.id), verdict: 'passed', evidence: `ran run-${String(c.id)}: ok` })))];
    const { service, db, ids, runId } = await setup(turns);
    await driveToVerifying(service, runId);
    const { recorder } = fakeEvidence();
    const result = await runVerification({
      engine: service,
      runId,
      verifierSpec: CLAUDE_LOW,
      cwd: '/worktree',
      binding: binding(),
      criteria,
      evidence: recorder,
      ...(options.resumeFrom !== undefined ? { resumeFrom: options.resumeFrom } : {}),
      ...(options.facts !== undefined ? { mergeReadinessProbe: fixedProbe(options.facts) } : {}),
      ids,
      clock: db.clock,
    });
    return { service, db, ids, runId, result };
  }

  /** Every assertion an AGENT-actionable blocked round must satisfy (W2-2:
   * the preserved Wave-1 T23 route): T23 (never a false merge_ready), an
   * `integration_blocker` fix-request naming the blocker, the T23 trigger
   * carrying the blockers with EMPTY criteria lists (the criteria all
   * verified) — and NEVER the user-actionable blocked path. */
  function expectReadinessBlocked(
    outcome: Awaited<ReturnType<typeof runAllPassingVerification>>,
    blockerText: string,
  ): void {
    const { service, db, runId, result } = outcome;
    expect(result.gathering.outcome).toBe('all_verified');
    expect(result.transition.status).toBe('applied');
    if (result.transition.status === 'applied') expect(result.transition.transitionId).toBe('T23');
    expect(service.status(runId).phase).toBe('needs_remediation'); // NEVER a false merge_ready
    expect(service.status(runId).counters.remediationRounds).toBe(1); // bounded loop engaged

    expect(result.fixRequests.length).toBeGreaterThan(0);
    expect(result.fixRequests.every((f) => f.kind === 'integration_blocker')).toBe(true);
    expect(result.fixRequests.some((f) => f.summary.includes(blockerText))).toBe(true);

    const types = db.events.listByRun(runId).map((e) => e.type);
    expect(types).toContain('verification.completed.failed'); // T23
    expect(types).not.toContain('verification.completed.passed'); // no T24
    expect(types).not.toContain('merge.readiness.blocked'); // not the W2-2 waitable path
    const failed = db.events.listByRun(runId).find((e) => e.type === 'verification.completed.failed')!;
    const payload = failed.payload as unknown as {
      failedCriteria: readonly string[];
      unprovenCriteria: readonly string[];
      readinessBlockers?: readonly string[];
    };
    expect(payload.failedCriteria).toEqual([]);
    expect(payload.unprovenCriteria).toEqual([]);
    expect(payload.readinessBlockers?.some((b) => b.includes(blockerText))).toBe(true);

    expect(result.integrationBlocked).toBe(false);
    expect(service.getMergeReadinessBlocked(runId)).toBeUndefined();
  }

  /** Every assertion a USER-actionable blocked round must satisfy (W2-2 new
   * path): the durable `merge.readiness.blocked` supporting event is
   * RECORDED (no §6.3 transition), the run REMAINS in `verifying` with NO
   * remediation round consumed, no agent fix-request is produced, and the
   * recheck read-model persists the SAME immutable verification. */
  function expectIntegrationBlocked(
    outcome: Awaited<ReturnType<typeof runAllPassingVerification>>,
    blockerText: string,
  ): void {
    const { service, db, runId, result } = outcome;
    expect(result.gathering.outcome).toBe('all_verified');
    expect(result.integrationBlocked).toBe(true);
    expect(result.transition.status).toBe('recorded');
    if (result.transition.status === 'recorded') {
      expect(result.transition.event.type).toBe('merge.readiness.blocked');
    }
    expect(service.status(runId).phase).toBe('verifying'); // REMAINS — no T23
    expect(service.status(runId).counters.remediationRounds).toBe(0); // no round consumed
    expect(result.fixRequests).toEqual([]); // no agent action requested — the point
    expect(result.mergeReadiness?.ready).toBe(false);
    expect(result.mergeReadiness?.blockers.some((b) => b.includes(blockerText))).toBe(true);

    const types = db.events.listByRun(runId).map((e) => e.type);
    expect(types).toContain('merge.readiness.blocked');
    expect(types).not.toContain('verification.completed.failed'); // no T23
    expect(types).not.toContain('verification.completed.passed'); // no T24
    const blockedEvent = db.events.listByRun(runId).find((e) => e.type === 'merge.readiness.blocked')!;
    const payload = blockedEvent.payload as unknown as {
      blockers: readonly string[];
      mergeReadiness: { ready: boolean };
    };
    expect(payload.blockers.some((b) => b.includes(blockerText))).toBe(true);
    expect(payload.mergeReadiness.ready).toBe(false);

    // The durable recheck read-model: SAME immutable Verification/binding +
    // the probe geometry (`cwd` IS the worktree the verifier ran in).
    const blocked = service.getMergeReadinessBlocked(runId);
    expect(blocked?.stage).toBe('blocked');
    expect(blocked?.verification.id).toBe(result.verification.id);
    expect(String(blocked?.binding.implementationCommit)).toBe(String(IMPL_COMMIT));
    expect(blocked?.worktreePath).toBe('/worktree');
    expect(blocked?.probeDestinationRef).toBe('HEAD');
    expect(blocked?.blockers.some((b) => b.includes(blockerText))).toBe(true);
  }

  // W2-2: the ONLY user/environment-actionable §16 blockers — the new
  // waitable blocked path (a human clears them on the destination; no agent
  // round can help).
  const USER_FACT_BLOCKERS: ReadonlyArray<{ name: string; facts: GitMergeFacts; blockerText: string }> = [
    {
      name: 'dirty destination',
      facts: { ...goodFacts(), destinationClean: false },
      blockerText: 'destination working tree is dirty',
    },
    {
      name: 'base drift',
      facts: { ...goodFacts(), baseDrifted: true },
      blockerText: 'base commit drifted',
    },
    {
      name: 'merge conflicts',
      facts: { ...goodFacts(), conflicts: true },
      blockerText: 'would conflict',
    },
  ];

  for (const c of USER_FACT_BLOCKERS) {
    it(`${c.name}: criteria verify, ONLY user-actionable blockers → merge.readiness.blocked, REMAIN verifying, no remediation round (W2-2)`, async () => {
      const outcome = await runAllPassingVerification({ facts: c.facts });
      expectIntegrationBlocked(outcome, c.blockerText);
    });
  }

  it('worktree dirty after verification commands (W1-F4): agent-actionable → stays T23 with an integration_blocker naming the files', async () => {
    const outcome = await runAllPassingVerification({
      facts: { ...goodFacts(), worktreeClean: false, worktreeDirtyFiles: ['build/generated.lock'] },
    });
    expectReadinessBlocked(outcome, 'build/generated.lock');
    expect(outcome.result.mergeReadiness?.ready).toBe(false);
    expect(outcome.result.mergeReadiness?.blockers.some((b) => b.includes('build/generated.lock'))).toBe(true);
  });

  it('MIXED agent+user blockers → T23 (remediation must run anyway); the user blockers travel for the next round re-probe (W2-2)', async () => {
    const outcome = await runAllPassingVerification({
      facts: { ...goodFacts(), worktreeClean: false, worktreeDirtyFiles: ['gen.out'], destinationClean: false },
    });
    expectReadinessBlocked(outcome, 'gen.out');
    const failed = outcome.db.events.listByRun(outcome.runId).find((e) => e.type === 'verification.completed.failed')!;
    const payload = failed.payload as unknown as { readinessBlockers?: readonly string[] };
    expect(payload.readinessBlockers?.some((b) => b.includes('destination working tree is dirty'))).toBe(true);
  });

  it('wrong commit (worktree HEAD moved): typed MergeReadinessCommitMismatchError — loud, NO transition, nothing recorded (W2-2)', async () => {
    // Deliberate Rev-2 correction: Wave 1 routed this to T23; the tree moving
    // under us is neither agent- nor user-actionable — a waitable blocker or
    // a remediation round would both be dishonest.
    const criteria = [crit('C1')];
    const { service, db, ids, runId } = await setup([
      reportTurn([{ id: 'C1', verdict: 'passed', evidence: 'ran run-C1: ok' }]),
    ]);
    await driveToVerifying(service, runId);
    const { recorder } = fakeEvidence();
    await expect(
      runVerification({
        engine: service,
        runId,
        verifierSpec: CLAUDE_LOW,
        cwd: '/worktree',
        binding: binding(),
        criteria,
        evidence: recorder,
        mergeReadinessProbe: fixedProbe({ ...goodFacts(), currentImplementationCommit: gitSha('d'.repeat(40)) }),
        ids,
        clock: db.clock,
      }),
    ).rejects.toThrow(MergeReadinessCommitMismatchError);
    expect(service.status(runId).phase).toBe('verifying');
    expect(service.status(runId).counters.remediationRounds).toBe(0);
    const types = db.events.listByRun(runId).map((e) => e.type);
    expect(types).not.toContain('verification.completed.failed');
    expect(types).not.toContain('verification.completed.passed');
    expect(types).not.toContain('merge.readiness.blocked');
    expect(service.getMergeReadinessBlocked(runId)).toBeUndefined();
  });

  it('splitReadinessBlockers: exactly the three destination blockers are user-actionable; anything unrecognized is agent-actionable (fail-safe)', () => {
    const split = splitReadinessBlockers([
      'the destination working tree is dirty (human action: commit or stash the destination changes)',
      'the base commit drifted (destination advanced)',
      'merging the verified commit would conflict',
      'implementation worktree dirty after verification commands (files: gen.out)',
      'required verification commands were not run/passed',
      'some future blocker text this build does not know',
    ]);
    expect(split.userActionable).toHaveLength(3);
    expect(split.agentActionable).toHaveLength(3);
    expect(split.agentActionable).toContain('some future blocker text this build does not know');
  });

  it('required tests not run/passed: a carried criterion with commands but NO evidence blocks readiness → T23', async () => {
    // §12.2 carry-forward with an EMPTY evidence bundle: the criterion counts
    // as passed, but its declared commands have no evidence of a run — the
    // distinct §16 "required tests" gate must still block.
    const resumeFrom: VerifierResumeState = {
      criterionStates: [{ criterionId: criterionId('C1'), state: 'passed' }],
      evidenceRefs: [],
    };
    const outcome = await runAllPassingVerification({
      criteria: [crit('C1')],
      resumeFrom,
      turns: [], // everything carried — no verifier turn runs
      facts: goodFacts(),
    });
    expectReadinessBlocked(outcome, 'required verification commands were not run/passed');
    expect(outcome.result.mergeReadiness?.requiredTestsPassed).toBe(false);
  });

  it('NO probe supplied: typed MergeReadinessProbeMissingError (caller bug) — NO transition, never a fail-safe round (W2-2)', async () => {
    // Deliberate Rev-2 correction: Wave 1 turned a missing probe into a
    // fail-safe-blocked T23 round; production always supplies the probe, so
    // absence is an orchestration wiring bug and must be LOUD instead of
    // silently consuming a remediation round.
    const criteria = [crit('C1')];
    const { service, db, ids, runId } = await setup([
      reportTurn([{ id: 'C1', verdict: 'passed', evidence: 'ran run-C1: ok' }]),
    ]);
    await driveToVerifying(service, runId);
    const { recorder } = fakeEvidence();
    await expect(
      runVerification({
        engine: service,
        runId,
        verifierSpec: CLAUDE_LOW,
        cwd: '/worktree',
        binding: binding(),
        criteria,
        evidence: recorder,
        // no mergeReadinessProbe
        ids,
        clock: db.clock,
      }),
    ).rejects.toThrow(MergeReadinessProbeMissingError);
    expect(service.status(runId).phase).toBe('verifying');
    expect(service.status(runId).counters.remediationRounds).toBe(0);
    const types = db.events.listByRun(runId).map((e) => e.type);
    expect(types).not.toContain('verification.completed.failed');
    expect(types).not.toContain('verification.completed.passed');
    expect(types).not.toContain('merge.readiness.blocked');
  });

  it('the worktree-dirty fix-request carries the W1-F4 guidance and formats into the remediation block', async () => {
    const outcome = await runAllPassingVerification({
      facts: { ...goodFacts(), worktreeClean: false, worktreeDirtyFiles: ['gen.out'] },
    });
    const fix = outcome.result.fixRequests[0]!;
    expect(fix.kind).toBe('integration_blocker');
    // The text tells the implementor to make verification side-effect-free
    // or commit the generated files (W1-F4).
    expect(fix.requestedChange).toMatch(/side-effect-free/);
    expect(fix.requestedChange).toMatch(/commit the files they generate/);
    const block = formatFixRequests(outcome.result.fixRequests);
    expect(block).toContain('§16 integration blocker');
    expect(block).toContain('gen.out');
    expect(block).toMatch(/side-effect-free/);
  });

  // =========================================================================
  // W2-2 — `recheckMergeReadiness`: re-run ONLY the git probe against the
  // SAME immutable Verification/binding a blocked round persisted
  // =========================================================================
  describe('W2-2 — recheck of a merge.readiness.blocked run', () => {
    /** Drive one user-actionable blocked round and return its handles. */
    async function blockedRound(): Promise<
      Awaited<ReturnType<typeof runAllPassingVerification>>
    > {
      const outcome = await runAllPassingVerification({
        facts: { ...goodFacts(), destinationClean: false },
      });
      expectIntegrationBlocked(outcome, 'destination working tree is dirty');
      return outcome;
    }

    it('still blocked (fresh blocker set) → an UPDATED blocked event + read-model; never a remediation round', async () => {
      const outcome = await blockedRound();
      const blocked = outcome.service.getMergeReadinessBlocked(outcome.runId)!;
      // The destination was cleaned meanwhile, but the base DRIFTED — the
      // fresh probe decides; the verification is never recomputed.
      const recheck = await recheckMergeReadiness({
        engine: outcome.service,
        runId: outcome.runId,
        blocked,
        probe: fixedProbe({ ...goodFacts(), baseDrifted: true }),
        ids: outcome.ids,
        clock: outcome.db.clock,
      });
      expect(recheck.outcome).toBe('still_blocked');
      expect(recheck.mergeReadiness.blockers).toEqual(['the base commit drifted (destination advanced)']);
      expect(recheck.transition.status).toBe('recorded');

      expect(outcome.service.status(outcome.runId).phase).toBe('verifying');
      expect(outcome.service.status(outcome.runId).counters.remediationRounds).toBe(0);
      const blockedEvents = outcome.db.events
        .listByRun(outcome.runId)
        .filter((e) => e.type === 'merge.readiness.blocked');
      expect(blockedEvents).toHaveLength(2); // original + the UPDATED event

      const updated = outcome.service.getMergeReadinessBlocked(outcome.runId)!;
      expect(updated.stage).toBe('blocked');
      expect(updated.blockers).toEqual(['the base commit drifted (destination advanced)']);
      // SAME immutable verification — recheck re-ran ONLY the git probe.
      expect(updated.verification.id).toBe(blocked.verification.id);
    });

    it('ready → T24 is ingested NOW: run → merge_ready, read-model resolved', async () => {
      const outcome = await blockedRound();
      const blocked = outcome.service.getMergeReadinessBlocked(outcome.runId)!;
      const recheck = await recheckMergeReadiness({
        engine: outcome.service,
        runId: outcome.runId,
        blocked,
        probe: fixedProbe(goodFacts()),
        ids: outcome.ids,
        clock: outcome.db.clock,
      });
      expect(recheck.outcome).toBe('ready');
      expect(recheck.mergeReadiness.ready).toBe(true);
      expect(recheck.transition.status).toBe('applied');
      if (recheck.transition.status === 'applied') expect(recheck.transition.transitionId).toBe('T24');

      expect(outcome.service.status(outcome.runId).phase).toBe('merge_ready');
      const types = outcome.db.events.listByRun(outcome.runId).map((e) => e.type);
      expect(types).toContain('verification.completed.passed'); // T24 (payload-validated)
      expect(types).toContain('merge.readiness.recorded');
      // No NEW blocked event on the ready path — just the original one.
      expect(types.filter((t) => t === 'merge.readiness.blocked')).toHaveLength(1);

      const resolved = outcome.service.getMergeReadinessBlocked(outcome.runId)!;
      expect(resolved.stage).toBe('resolved');
      expect(resolved.blockers).toEqual([]);
      expect(resolved.mergeReadiness.ready).toBe(true);
    });

    it('worktreeClean is RE-PROBED: a worktree dirtied since the block keeps the run blocked (updated event), never merge_ready', async () => {
      const outcome = await blockedRound();
      const blocked = outcome.service.getMergeReadinessBlocked(outcome.runId)!;
      const recheck = await recheckMergeReadiness({
        engine: outcome.service,
        runId: outcome.runId,
        blocked,
        probe: fixedProbe({ ...goodFacts(), worktreeClean: false, worktreeDirtyFiles: ['late.out'] }),
        ids: outcome.ids,
        clock: outcome.db.clock,
      });
      expect(recheck.outcome).toBe('still_blocked');
      expect(recheck.mergeReadiness.blockers.some((b) => b.includes('late.out'))).toBe(true);
      expect(outcome.service.status(outcome.runId).phase).toBe('verifying');
      expect(outcome.service.status(outcome.runId).counters.remediationRounds).toBe(0);
    });

    it('wrong commit at recheck → typed MergeReadinessCommitMismatchError; nothing recorded', async () => {
      const outcome = await blockedRound();
      const blocked = outcome.service.getMergeReadinessBlocked(outcome.runId)!;
      const before = outcome.db.events.listByRun(outcome.runId).length;
      await expect(
        recheckMergeReadiness({
          engine: outcome.service,
          runId: outcome.runId,
          blocked,
          probe: fixedProbe({ ...goodFacts(), currentImplementationCommit: gitSha('e'.repeat(40)) }),
          ids: outcome.ids,
          clock: outcome.db.clock,
        }),
      ).rejects.toThrow(MergeReadinessCommitMismatchError);
      expect(outcome.db.events.listByRun(outcome.runId)).toHaveLength(before);
      expect(outcome.service.status(outcome.runId).phase).toBe('verifying');
      expect(outcome.service.getMergeReadinessBlocked(outcome.runId)!.stage).toBe('blocked');
    });
  });
});

// ===========================================================================
// §19 test 22 — mechanical checkpoint sufficiency on a successor
// ===========================================================================
describe('verifier flow — successor resumes from checkpoint alone (§19 test 22, §12.2)', () => {
  it('carries an already-passed criterion forward from the checkpoint and only re-verifies the rest', async () => {
    // A predecessor mechanical checkpoint: C1 already passed with its evidence,
    // C2 still pending. This is the ONLY thing the successor consumes.
    const worktree: WorktreeState = {
      headSha: IMPL_COMMIT,
      statusPorcelain: '',
      diffHash: artifactHash('diff0'),
      lockfileCleanupPerformed: false,
      taintFlags: [],
    };
    const checkpoint = buildCheckpointContent({
      lineage: { harnessId: 'claude', model: 'opus' },
      eventCursor: eventSequence(1),
      specHash: SPEC_HASH,
      criterionStates: [
        { criterionId: criterionId('C1'), state: 'passed' },
        { criterionId: criterionId('C2'), state: 'pending' },
      ],
      permissionPolicy: { mode: 'headless', allowlist: [] },
      worktree,
      artifactRefs: [artifactHash('ev_C1_from_checkpoint')],
    });
    const resumeFrom: VerifierResumeState = {
      criterionStates: checkpoint.criterionStates,
      evidenceRefs: checkpoint.artifactRefs,
    };

    // The successor only needs to verify C2.
    const turns = [reportTurn([{ id: 'C2', verdict: 'passed', evidence: 'ran run-C2: ok' }])];
    const { service, db, ids, created, runId } = await setup(turns);
    await driveToVerifying(service, runId);
    const { recorder } = fakeEvidence();

    const result = await runVerification({
      engine: service,
      runId,
      verifierSpec: CLAUDE_LOW,
      cwd: '/worktree',
      binding: binding(),
      criteria: [crit('C1'), crit('C2')],
      evidence: recorder,
      resumeFrom,
      mergeReadinessProbe: fixedProbe(goodFacts()),
      ids,
      clock: db.clock,
    });

    // Only ONE turn ran — C1 was NOT re-verified (no predecessor replay).
    expect(promptCount(created[0]!.adapter)).toBe(1);
    expect(result.gathering.carriedCriterionIds.map(String)).toEqual(['C1']);
    expect(result.gathering.verifiedCriterionIds.map(String)).toEqual(['C2']);

    const c1 = result.verification.criteria.find((c) => String(c.criterionId) === 'C1')!;
    expect(c1.verdict).toBe('passed');
    expect(c1.evidenceRefs.map(String)).toEqual(['ev_C1_from_checkpoint']); // the checkpoint's own evidence

    // The successor completed the verification from the checkpoint alone.
    expect(result.gathering.outcome).toBe('all_verified');
    expect(result.mergeReadiness?.ready).toBe(true);
    expect(service.status(runId).phase).toBe('merge_ready');
  });
});

// ===========================================================================
// §19 test 18 — merge-readiness gate rejections (pure §16)
// ===========================================================================
describe('buildMergeReadiness — §16 gate (§19 test 18)', () => {
  const ids = new DeterministicIdFactory();
  const clock = new ManualClock();

  function verified(outcome: 'all_verified' | 'blocked'): Verification {
    const results: CriterionResult[] =
      outcome === 'all_verified'
        ? [{ criterionId: criterionId('C1'), verdict: 'passed', evidenceRefs: [artifactHash('ev1')] }]
        : [{ criterionId: criterionId('C1'), verdict: 'failed', evidenceRefs: [artifactHash('ev1')] }];
    const gathering: VerifierGathering = {
      criteria: results,
      fixRequests: [],
      outcome,
      verifiedCriterionIds: [criterionId('C1')],
      carriedCriterionIds: [],
    };
    return buildVerification({ runId: mkRunId('run_1'), binding: binding(), gathering, ids, clock });
  }

  function readiness(
    v: Verification,
    facts: GitMergeFacts,
    requiredTestsPassed = true,
    approvedSpecHash = SPEC_HASH,
  ): ReturnType<typeof buildMergeReadiness> {
    return buildMergeReadiness({
      runId: mkRunId('run_1'),
      verification: v,
      binding: binding(),
      gitFacts: facts,
      requiredTestsPassed,
      approvedSpecHash,
      ids,
      clock,
    });
  }

  it('ready only when every gate passes', () => {
    const mr = readiness(verified('all_verified'), goodFacts());
    expect(mr.ready).toBe(true);
    expect(mr.manualIntegrationCommands[0]).toContain('§16');
    expect(mr.manualIntegrationCommands.some((c) => c.includes('merge --no-ff'))).toBe(true);
  });

  it('rejects failed/unproven criteria', () => {
    expect(readiness(verified('blocked'), goodFacts()).ready).toBe(false);
  });

  it('rejects a dirty destination', () => {
    const mr = readiness(verified('all_verified'), { ...goodFacts(), destinationClean: false });
    expect(mr.ready).toBe(false);
    expect(mr.destinationClean).toBe(false);
    expect(mr.manualIntegrationCommands.join('\n')).toContain('NOT READY');
  });

  it('rejects base drift', () => {
    expect(readiness(verified('all_verified'), { ...goodFacts(), baseDrifted: true }).ready).toBe(false);
  });

  it('rejects conflicts', () => {
    expect(readiness(verified('all_verified'), { ...goodFacts(), conflicts: true }).ready).toBe(false);
  });

  it('rejects a wrong-commit (worktree HEAD ≠ verified commit)', () => {
    const mr = readiness(verified('all_verified'), {
      ...goodFacts(),
      currentImplementationCommit: gitSha('d'.repeat(40)),
    });
    expect(mr.ready).toBe(false);
  });

  it('rejects a changed spec hash', () => {
    expect(readiness(verified('all_verified'), goodFacts(), true, specHash('DIFFERENT')).ready).toBe(false);
  });

  it('rejects when required tests did not run/pass', () => {
    const mr = readiness(verified('all_verified'), goodFacts(), false);
    expect(mr.ready).toBe(false);
    expect(mr.requiredTestsPassed).toBe(false);
  });

  it('rejects a worktree left dirty by post-commit verification commands (W1-F4), naming the files', () => {
    const mr = readiness(verified('all_verified'), {
      ...goodFacts(),
      worktreeClean: false,
      worktreeDirtyFiles: ['build/generated.lock', 'coverage/report.txt'],
    });
    expect(mr.ready).toBe(false);
    expect(mr.worktreeClean).toBe(false);
    expect(
      mr.blockers.some(
        (b) => b.includes('worktree dirty after verification commands') && b.includes('build/generated.lock'),
      ),
    ).toBe(true);
    expect(mr.manualIntegrationCommands.join('\n')).toContain('NOT READY');
  });

  it('W4-6: shell-quotes a repoRoot/ref with spaces into a valid copy-pasteable command', () => {
    const mr = buildMergeReadiness({
      runId: mkRunId('run_1'),
      verification: verified('all_verified'),
      binding: binding({
        repoRoot: '/Users/me/My Repos/proj',
        destinationRef: 'release candidate',
        worktreeBranch: "harness/it's a branch",
      }),
      gitFacts: goodFacts(),
      requiredTestsPassed: true,
      approvedSpecHash: SPEC_HASH,
      ids,
      clock,
    });
    const text = mr.manualIntegrationCommands.join('\n');
    // Each interpolated value is single-quoted so spaces/metacharacters survive copy-paste.
    expect(text).toContain(`git -C '/Users/me/My Repos/proj' switch 'release candidate'`);
    expect(text).toContain(`merge --no-ff 'harness/it'\\''s a branch'`);
  });

  it('W4-6: leaves normal paths/refs unquoted (unchanged in spirit)', () => {
    const mr = readiness(verified('all_verified'), goodFacts());
    const text = mr.manualIntegrationCommands.join('\n');
    expect(text).toContain('git -C /repo switch main');
    expect(text).toContain('merge --no-ff harness/asg_1');
  });
});

// ===========================================================================
// verification trigger + requiredTests derivation (pure)
// ===========================================================================
describe('verification trigger event + requiredTests derivation', () => {
  const ids = new DeterministicIdFactory();
  const clock = new ManualClock();

  it('all_verified → T24 event carrying the ready MergeReadiness (W2-1); blocked → T23 event carrying the blocking ids', () => {
    const passing: Verification = buildVerification({
      runId: mkRunId('run_1'),
      binding: binding(),
      gathering: {
        criteria: [{ criterionId: criterionId('C1'), verdict: 'passed', evidenceRefs: [artifactHash('e')] }],
        fixRequests: [],
        outcome: 'all_verified',
        verifiedCriterionIds: [criterionId('C1')],
        carriedCriterionIds: [],
      },
      ids,
      clock,
    });
    const readyReadiness = buildMergeReadiness({
      runId: mkRunId('run_1'),
      verification: passing,
      binding: binding(),
      gitFacts: goodFacts(),
      requiredTestsPassed: true,
      approvedSpecHash: passing.specHash,
      ids,
      clock,
    });
    expect(readyReadiness.ready).toBe(true);
    const t24 = verificationTriggerEvent(passing, { ids, clock, mergeReadiness: readyReadiness });
    expect(t24.type).toBe('verification.completed.passed');
    expect((t24.payload as { mergeReadiness?: { ready?: boolean } }).mergeReadiness?.ready).toBe(true);
    // W2-1: the generator itself refuses a T24 without a ready readiness —
    // the payload-validated event can no longer silently escape it.
    expect(() => verificationTriggerEvent(passing, { ids, clock })).toThrow(/ready=true/);

    const blocked: Verification = buildVerification({
      runId: mkRunId('run_1'),
      binding: binding(),
      gathering: {
        criteria: [
          { criterionId: criterionId('C1'), verdict: 'failed', evidenceRefs: [] },
          { criterionId: criterionId('C2'), verdict: 'unproven', evidenceRefs: [] },
        ],
        fixRequests: [],
        outcome: 'blocked',
        verifiedCriterionIds: [criterionId('C1'), criterionId('C2')],
        carriedCriterionIds: [],
      },
      ids,
      clock,
    });
    const event = verificationTriggerEvent(blocked, { ids, clock });
    expect(event.type).toBe('verification.completed.failed');
    const payload = event.payload as unknown as { failedCriteria: readonly string[]; unprovenCriteria: readonly string[] };
    expect(payload.failedCriteria).toEqual(['C1']);
    expect(payload.unprovenCriteria).toEqual(['C2']);
  });

  it('requiredTests: a criterion with commands must have passed WITH evidence', () => {
    const criteria = [crit('C1', ['run-C1']), crit('C2', [])];
    const passed: CriterionResult[] = [
      { criterionId: criterionId('C1'), verdict: 'passed', evidenceRefs: [artifactHash('e')] },
      { criterionId: criterionId('C2'), verdict: 'passed', evidenceRefs: [] },
    ];
    expect(deriveRequiredTestsPassed(criteria, passed)).toBe(true);

    const noEvidence: CriterionResult[] = [
      { criterionId: criterionId('C1'), verdict: 'passed', evidenceRefs: [] }, // commands but no evidence
      { criterionId: criterionId('C2'), verdict: 'passed', evidenceRefs: [] },
    ];
    expect(deriveRequiredTestsPassed(criteria, noEvidence)).toBe(false);
  });
});

// ===========================================================================
// §16 git facts probe against a REAL temp git worktree
// ===========================================================================
const execFileAsync = promisify(execFile);
async function gitIn(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t.invalid',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t.invalid',
    },
  });
  return stdout.toString().trim();
}

describe('gitMergeReadinessProbe — real §16 git facts', () => {
  it('reads worktree HEAD, destination cleanliness, and base drift', async () => {
    const repo = await makeTempGitRepo('harness-verif-');
    cleanups.push(() => repo.cleanup());
    const base = await repo.headSha();

    const wtParent = await mkdtemp(path.join(tmpdir(), 'harness-verif-wt-'));
    cleanups.push(() => rm(wtParent, { recursive: true, force: true }));
    const wtPath = path.join(wtParent, 'feat');
    await repo.run(['worktree', 'add', '-b', 'feat', wtPath, base]);
    await writeFile(path.join(wtPath, 'feature.ts'), 'export const x = 1;\n');
    await gitIn(wtPath, ['add', '-A']);
    await gitIn(wtPath, ['commit', '-m', 'feature']);
    const verified = await gitIn(wtPath, ['rev-parse', 'HEAD']);

    const probe = gitMergeReadinessProbe({
      repoRoot: repo.dir,
      worktreePath: wtPath,
      baseCommit: gitSha(base),
      verifiedCommit: gitSha(verified),
    });

    const facts = await probe.probe();
    expect(facts.currentImplementationCommit).toBe(verified);
    expect(facts.destinationClean).toBe(true);
    expect(facts.baseDrifted).toBe(false);
    expect(facts.conflicts).toBe(false);
    expect(facts.worktreeClean).toBe(true); // W1-F4: committed worktree is clean
    expect(facts.worktreeDirtyFiles).toEqual([]);

    // Destination advances → base drift; a new uncommitted file → dirty.
    await repo.writeFile('other.ts', 'export const y = 2;\n');
    await repo.commitAll('advance main');
    await repo.writeFile('scratch.ts', 'wip\n');
    const drifted = await probe.probe();
    expect(drifted.baseDrifted).toBe(true);
    expect(drifted.destinationClean).toBe(false);
    expect(drifted.worktreeClean).toBe(true); // destination dirt is NOT worktree dirt

    // W1-F4: dirt in the WORKTREE (post-commit verification leftovers) is a
    // distinct fact, and the dirty paths are named.
    await writeFile(path.join(wtPath, 'side-effect.log'), 'generated during verification\n');
    const wtDirty = await probe.probe();
    expect(wtDirty.worktreeClean).toBe(false);
    expect(wtDirty.worktreeDirtyFiles).toContain('side-effect.log');
  });

  it('detects a real merge conflict (§16 conflict gate)', async () => {
    const repo = await makeTempGitRepo('harness-verif-conflict-');
    cleanups.push(() => repo.cleanup());
    const base = await repo.headSha();

    // Destination (main) edits README one way.
    await repo.writeFile('README.md', '# main version\n');
    await repo.commitAll('main edit');

    // A worktree branched from base edits the SAME file another way.
    const wtParent = await mkdtemp(path.join(tmpdir(), 'harness-verif-conflict-wt-'));
    cleanups.push(() => rm(wtParent, { recursive: true, force: true }));
    const wtPath = path.join(wtParent, 'feat');
    await repo.run(['worktree', 'add', '-b', 'feat', wtPath, base]);
    await writeFile(path.join(wtPath, 'README.md'), '# feat version\n');
    await gitIn(wtPath, ['add', '-A']);
    await gitIn(wtPath, ['commit', '-m', 'feat edit']);
    const verified = await gitIn(wtPath, ['rev-parse', 'HEAD']);

    const probe = gitMergeReadinessProbe({
      repoRoot: repo.dir,
      worktreePath: wtPath,
      baseCommit: gitSha(base),
      verifiedCommit: gitSha(verified),
    });
    const facts = await probe.probe();
    expect(facts.conflicts).toBe(true);
  });
});
