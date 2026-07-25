/**
 * OFFLINE VERTICAL SLICE (PLAN §19, §20 P3 exit gate) — the full loop composed
 * end-to-end against the IN-PROCESS FAKE adapter + a REAL temp git repo, with no
 * real spawns. This file owns the two §19 rows that are pure COMPOSITION (the
 * per-flow rows 12/17/18/30 are proven in their own flows' suites):
 *
 *  - test 19: `goal → spec → approve → implement → verify → merge_ready`, the
 *    whole post-`start` slice threaded through `OrchestrationService`,
 *    `CoordinatorRunner`, `runImplementVerifyLoop`, and the verifier driver —
 *    plus the REMEDIATION branch (round 1 blocks → `needs_remediation` → round 2
 *    passes → `merge_ready`) to prove that seam composes too;
 *  - test 22: mechanical checkpoint sufficiency — a predecessor verifies one
 *    criterion, writes a MECHANICAL checkpoint (no LLM), and is "killed"; a
 *    fresh successor service recovers phase from the event log, reads the
 *    checkpoint back from the CAS ALONE, and completes verification without
 *    replaying any predecessor turn;
 *  - W1-F1/W1-F4 composition: a verification command that mutates the
 *    worktree dirties it AFTER the recorded commit → the §16 gate blocks →
 *    T23 rounds (bounded), never a false merge_ready.
 *
 * Every §6.3 verdict transition (T1/T23/T24) goes through the service's single
 * authoritative `ingest`; the §6.2 linear dispatch advances go through
 * `advanceWorkflowPhase` inside the orchestrator; and the primary checkout is
 * asserted byte-for-byte untouched throughout (§16 / §19 test 17 invariant).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  artifactHash,
  assignmentId,
  criterionId,
  eventSequence,
  gitSha,
  segmentId as mkSegmentId,
  type ArtifactHash,
  type CriterionId,
  type RunId,
} from '../../domain/ids.js';
import type { CriterionCheckpointState, WorktreeState } from '../../domain/entities.js';
import { DeterministicIdFactory, RandomIdFactory } from '../../lib/id-factory.js';
import { unwrap } from '../../lib/result.js';
import { openTestDatabase, type TestDatabaseHandle } from '../../persistence/test-support.js';
import { ArtifactStore } from '../../artifacts/store.js';
import { loadProfileFile, type Profile } from '../../config/profile.js';
import { buildCheckpointContent } from '../../checkpoint/content.js';
import { writeCheckpoint } from '../../checkpoint/writer.js';
import {
  InProcessFakeAdapter,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
} from '../../adapters/index.js';
import { GitWorktreeManager, WorktreeError, type WorktreeHandle } from '../../worktree/index.js';
import * as git from '../../worktree/git.js';
import {
  assertPrimaryCheckoutUntouched,
  makeTempGitRepo,
  snapshotPrimaryCheckout,
  type TempGitRepo,
} from '../../worktree/test-support.js';
import {
  OrchestrationService,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from '../service.js';
import type { Harness, RoleModelSpec } from '../model-resolution.js';
import type { RoleRunner } from '../role-runner.js';
import { createLegacyRunFixture, createRunFixture } from '../test-support.js';
import { CoordinatorRunner, type CoordinatorOutcome } from './coordinator.js';
import {
  adjudicateImplementorDeliverable,
  NoDeliverableError,
  runImplementVerifyLoop,
  toProvisioningFailure,
} from './orchestrate.js';
import type { ImplementorResult } from './implementor.js';
import {
  gitMergeReadinessProbe,
  runVerification,
  VerifierRunner,
  type EvidenceRecorder,
  type VerificationBinding,
  type VerifierResumeState,
} from './verifier.js';
import type { VerificationRunner } from './implementor.js';

// ---------------------------------------------------------------------------
// Role model specs (mirrors the P3 live smoke: coordinator=Claude, impl=Codex)
// ---------------------------------------------------------------------------
const COORDINATOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const IMPLEMENTOR: RoleModelSpec = { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const PROFILE_PATH = fileURLToPath(new URL('../../../profiles/coordinator.md', import.meta.url));

function configOptionsFor(harness: Harness): ConfigOptionDescriptor[] {
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

// ---------------------------------------------------------------------------
// Spec fixture (§7) — two concretely-testable criteria (AC-1, AC-2)
// ---------------------------------------------------------------------------
const GOAL = 'Add a --verbose flag to the CLI so debug lines print to stderr.';

function validSpec(): Record<string, unknown> {
  return {
    goal: GOAL,
    assumptions: ['The CLI entrypoint is src/cli/index.ts.'],
    openQuestions: [],
    constraints: ['Touch only files under src/cli'],
    permissions: ['read and write within the assigned worktree'],
    nonGoals: ['No change to the existing log format'],
    tasks: [
      { id: 'T1', description: 'Recognize --verbose in the arg parser', dependsOn: [] },
      { id: 'T2', description: 'Gate debug output on the flag', dependsOn: ['T1'] },
    ],
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'The --verbose flag enables debug output',
        verificationCommands: ['echo check-ac1'],
        expectedEvidence: 'exits with code 0 and stderr contains the debug prefix',
      },
      {
        id: 'AC-2',
        description: 'Without the flag no debug output is printed',
        verificationCommands: ['echo check-ac2'],
        expectedEvidence: 'exit code is 0 and stdout has no line matching the debug prefix',
      },
    ],
    rollback: 'Revert the single commit on the worktree branch.',
    proposedImplementorProfile: 'implementor',
    proposedVerifierProfile: 'verifier',
    explorationNotes: 'The arg parser lives in src/cli/index.ts around lines 20 to 40.',
  };
}

const fence = (o: unknown): string => '```json\n' + JSON.stringify(o, null, 2) + '\n```';

function coordinatorTurn(spec: unknown): InProcessTurnScript {
  return {
    updates: [{ kind: 'agent_message_chunk', text: `Here is the specification.\n\n${fence(spec)}` }],
    result: { stopReason: 'end_turn' },
  };
}

const implementorTurn = (text: string): InProcessTurnScript => ({
  updates: [
    { kind: 'agent_message_chunk', text },
    { kind: 'usage_update', usedTokens: 500, contextWindowSize: 200_000, cost: { amount: 0.05, currency: 'USD' } },
  ],
  result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 40, source: 'adapter' } },
});

function verifierTurn(
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

const PASS_VERIFY: VerificationRunner = async (command) => ({
  exitCode: 0,
  stdout: `ran ${command}`,
  stderr: '',
  launchFailed: false,
});

// ---------------------------------------------------------------------------
// Slice adapter factory: routes by role, applies per-adapter worktree writes,
// records prompt text. Each role has an ordered queue of adapter scripts (the
// Nth adapter of that role gets the Nth entry).
// ---------------------------------------------------------------------------
interface AdapterScript {
  /** Files the "agent" writes into its worktree cwd on each prompt (implementor). */
  readonly writes?: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly turns: readonly InProcessTurnScript[];
}

interface CreatedAdapter {
  readonly role: string;
  readonly options: RoleAdapterOptions;
  readonly adapter: InProcessFakeAdapter;
  readonly prompts: string[];
}

function makeSliceFactory(scripts: {
  readonly coordinator?: readonly AdapterScript[];
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}): { factory: RoleAdapterFactory; created: CreatedAdapter[] } {
  const created: CreatedAdapter[] = [];
  const cursors: Record<string, number> = {};
  const factory: RoleAdapterFactory = {
    create(options) {
      const role = options.role;
      const idx = cursors[role] ?? 0;
      cursors[role] = idx + 1;
      const queue = scripts[role as keyof typeof scripts] ?? [];
      const script: AdapterScript = queue[idx] ?? { turns: [] };
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: configOptionsFor(options.resolved.harness) },
        turns: script.turns,
      });
      const prompts: string[] = [];
      const orig = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (
        input,
      ) => {
        prompts.push(input.prompt);
        for (const write of script.writes ?? []) {
          const target = path.join(options.cwd, write.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, write.content, 'utf8');
        }
        return orig(input);
      };
      created.push({ role, options, adapter, prompts });
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

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
let dbHandle: TestDatabaseHandle | undefined;
let repo: TempGitRepo | undefined;
let worktrees: GitWorktreeManager | undefined;
let casDir: string | undefined;

afterEach(async () => {
  if (worktrees !== undefined) {
    try {
      fs.rmSync(worktrees.baseDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
  worktrees = undefined;
  dbHandle?.close();
  dbHandle?.cleanup();
  dbHandle = undefined;
  await repo?.cleanup();
  repo = undefined;
  if (casDir !== undefined) await rm(casDir, { recursive: true, force: true });
  casDir = undefined;
});

interface Slice {
  readonly service: OrchestrationService;
  readonly worktrees: GitWorktreeManager;
  readonly repo: TempGitRepo;
  readonly store: ArtifactStore;
  readonly ids: DeterministicIdFactory;
  readonly flowIds: DeterministicIdFactory;
  readonly created: CreatedAdapter[];
  readonly profile: Profile;
  readonly baseCommit: ReturnType<typeof gitSha>;
}

async function openSlice(scripts: {
  readonly coordinator?: readonly AdapterScript[];
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}): Promise<Slice> {
  repo = await makeTempGitRepo('harness-slice-');
  dbHandle = await openTestDatabase({ kind: 'better-sqlite3', file: true });
  casDir = await mkdtemp(path.join(tmpdir(), 'harness-slice-cas-'));
  worktrees = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: dbHandle.db.clock });
  const ids = new DeterministicIdFactory();
  const flowIds = new DeterministicIdFactory();
  const store = new ArtifactStore({ rootDir: casDir, clock: dbHandle.db.clock, ids: flowIds });
  const { factory, created } = makeSliceFactory(scripts);
  const service = new OrchestrationService({ db: dbHandle.db, ids, adapterFactory: factory });
  const profileResult = loadProfileFile(PROFILE_PATH);
  if (!profileResult.ok) throw new Error(`coordinator profile failed to load: ${JSON.stringify(profileResult.error)}`);
  return {
    service,
    worktrees,
    repo,
    store,
    ids,
    flowIds,
    created,
    profile: profileResult.value,
    baseCommit: gitSha(await repo.headSha()),
  };
}

/** created → specifying → awaiting_approval (coordinator) → approved (human T1). */
async function coordinateAndApprove(slice: Slice): Promise<{ runId: RunId; outcome: CoordinatorOutcome }> {
  const { runId } = createRunFixture(slice.service, {
    goal: GOAL,
    workspacePath: slice.repo.dir,
    coordinator: COORDINATOR,
    baseCommit: slice.baseCommit,
  });
  const runner = new CoordinatorRunner({
    goal: GOAL,
    profile: slice.profile,
    artifactStore: slice.store,
    ids: slice.flowIds,
    clock: dbHandle!.db.clock,
    baseCommit: slice.baseCommit,
    explorationContext: 'src/cli/index.ts (base deadbeef): a hand-rolled arg parser.',
  });
  const outcome = await slice.service.runCoordination(runId, runner);
  expect(slice.service.status(runId).phase).toBe('awaiting_approval');
  const approved = await slice.service.approve(runId, {
    specVersionId: outcome.specVersion.id,
    specHash: outcome.specVersion.contentHash,
  });
  expect(approved.status).toBe('applied');
  expect(slice.service.status(runId).phase).toBe('approved');
  return { runId, outcome };
}

// ===========================================================================
// PLAN §19 test 19 — full offline slice → merge_ready
// ===========================================================================
describe('PLAN §19 test 19 — goal → spec → approve → implement → verify → merge_ready (offline, fakes)', () => {
  it('composes the whole loop end to end and reaches a READY merge-readiness in one round', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        {
          writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const verbose = true;\n' }],
          turns: [implementorTurn('Implemented --verbose. Risk: no integration test added.')],
        },
      ],
      verifier: [
        {
          turns: [
            verifierTurn([
              { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0, stderr has debug prefix' },
              { id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0, no debug line on stdout' },
            ]),
          ],
        },
      ],
    });

    const before = await snapshotPrimaryCheckout(slice.repo.dir);
    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder, records } = fakeEvidence();
    const asg = assignmentId('asg_slice_happy');

    const result = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      {
        runId,
        assignmentId: asg,
        implementor: IMPLEMENTOR,
        verifier: VERIFIER,
        specHash: outcome.specVersion.contentHash,
        // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
        specApprovedBy: 'human',
        specDocument: outcome.canonicalSpec,
        goal: GOAL,
        taskScope: 'Implement the --verbose flag end to end in the CLI.',
        criteria: outcome.specVersion.criteria,
        constraints: ['Touch only files under src/cli'],
        explorationArtifact: 'The arg parser lives in src/cli/index.ts (bound to base deadbeef).',
        baseCommit: slice.baseCommit,
        evidence: recorder,
        runVerificationCommands: PASS_VERIFY,
      },
    );

    // --- The whole loop converged to merge_ready in one round (T24) ---------
    expect(result.outcome).toBe('merge_ready');
    expect(result.finalPhase).toBe('merge_ready');
    expect(result.rounds).toHaveLength(1);
    expect(slice.service.status(runId).phase).toBe('merge_ready');
    expect(slice.service.status(runId).uiState).toBe('done');

    // --- §16 MergeReadiness: ready, binds spec hash + base + verified commit
    const mr = result.mergeReadiness;
    expect(mr).toBeDefined();
    expect(mr!.ready).toBe(true);
    expect(mr!.specHash).toBe(outcome.specVersion.contentHash);
    expect(String(mr!.verifiedCommit)).toBe(String(result.implementationCommit));
    expect(mr!.manualIntegrationCommands.some((c) => c.includes('merge --no-ff'))).toBe(true);

    // --- The verifier bound to the EXACT worktree HEAD (host-read) ----------
    const worktreeHead = await git.resolveSha(result.worktree.worktreePath, 'HEAD');
    expect(worktreeHead).toBe(String(result.implementationCommit));
    expect(result.rounds[0]!.implementation!.commitSha).toBeDefined();

    // --- Every criterion is backed by the verifier's OWN evidence (§8) ------
    expect(records.map((r) => r.criterionId).sort()).toEqual(['AC-1', 'AC-2']);
    for (const c of result.rounds[0]!.verification.verification.criteria) {
      expect(c.verdict).toBe('passed');
      expect(c.evidenceRefs).toHaveLength(1);
    }

    // --- Every §6.3 verdict transition went through the authoritative log ---
    const types = dbHandle!.db.events.listByRun(runId).map((e) => e.type);
    expect(types).toContain('spec.approved'); // T1
    expect(types).toContain('verification.completed.passed'); // T24
    expect(types).toContain('merge.readiness.recorded');
    expect(types).not.toContain('verification.completed.failed');

    // --- §11.2 pins actually applied on both spawned roles ------------------
    const impl = slice.created.find((c) => c.role === 'implementor')!;
    const implPins = impl.adapter.log.filter((e) => e.op === 'setConfigOption').map((e) => e.detail);
    expect(implPins).toEqual([
      { optionId: 'model', value: 'gpt-5.6-terra' },
      { optionId: 'model_reasoning_effort', value: 'medium' },
    ]);
    expect(path.resolve(impl.options.cwd)).toBe(path.resolve(result.worktree.worktreePath));
    const verifier = slice.created.find((c) => c.role === 'verifier')!;
    expect(path.resolve(verifier.options.cwd)).toBe(path.resolve(result.worktree.worktreePath));

    // --- §16/§19 test 17: the primary checkout is byte-for-byte untouched ---
    await assertPrimaryCheckoutUntouched(slice.repo.dir, before);
    expect(String(result.implementationCommit)).not.toBe(await slice.repo.headSha());

    await slice.worktrees.removeWorktree(asg);
  });

  it('§16: the merge-readiness switch command targets the repo\'s ACTUAL branch (master), not a hardcoded main', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        {
          writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const verbose = true;\n' }],
          turns: [implementorTurn('Implemented --verbose.')],
        },
      ],
      verifier: [
        {
          turns: [
            verifierTurn([
              { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' },
              { id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0' },
            ]),
          ],
        },
      ],
    });

    // Rename the primary checkout's branch main → master BEFORE the loop, so the
    // §16 destination hint must be resolved from the repo (not defaulted to main).
    await slice.repo.run(['branch', '-m', 'master']);

    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_slice_master');

    const result = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      {
        runId,
        assignmentId: asg,
        implementor: IMPLEMENTOR,
        verifier: VERIFIER,
        specHash: outcome.specVersion.contentHash,
        // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
        specApprovedBy: 'human',
        specDocument: outcome.canonicalSpec,
        goal: GOAL,
        taskScope: 'Implement the --verbose flag end to end in the CLI.',
        criteria: outcome.specVersion.criteria,
        baseCommit: slice.baseCommit,
        evidence: recorder,
        runVerificationCommands: PASS_VERIFY,
        // NB: no destinationLabel — the loop must read the branch from the repo.
      },
    );

    expect(result.outcome).toBe('merge_ready');
    const commands = result.mergeReadiness!.manualIntegrationCommands;
    expect(commands.some((c) => /\bswitch master\b/.test(c))).toBe(true);
    expect(commands.some((c) => /\bswitch main\b/.test(c))).toBe(false);

    await slice.worktrees.removeWorktree(asg);
  });

  it('composes the REMEDIATION branch: round 1 blocks (T23 → needs_remediation) → round 2 passes (T24 → merge_ready)', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        // Round 1: only AC-1 is satisfied.
        {
          writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const verbose = true;\n' }],
          turns: [implementorTurn('Wired --verbose. AC-2 (no-flag path) still open.')],
        },
        // Round 2: the remediation commit closes AC-2 (new file → HEAD advances).
        {
          writes: [{ relPath: 'src/cli/quiet.ts', content: 'export const quietByDefault = true;\n' }],
          turns: [implementorTurn('Addressed the verifier fix-request for AC-2.')],
        },
      ],
      verifier: [
        // Round 1: AC-2 fails with a structured fix-request.
        {
          turns: [
            verifierTurn([
              { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' },
              { id: 'AC-2', verdict: 'failed', evidence: 'ran check-ac2: debug line leaked', fix: 'gate debug on the flag' },
            ]),
          ],
        },
        // Round 2: both pass.
        {
          turns: [
            verifierTurn([
              { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' },
              { id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0, quiet by default' },
            ]),
          ],
        },
      ],
    });

    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_slice_remediate');

    const result = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      {
        runId,
        assignmentId: asg,
        implementor: IMPLEMENTOR,
        verifier: VERIFIER,
        specHash: outcome.specVersion.contentHash,
        // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
        specApprovedBy: 'human',
        specDocument: outcome.canonicalSpec,
        goal: GOAL,
        taskScope: 'Implement the --verbose flag end to end in the CLI.',
        criteria: outcome.specVersion.criteria,
        baseCommit: slice.baseCommit,
        evidence: recorder,
        runVerificationCommands: PASS_VERIFY,
      },
    );

    // --- Two rounds; ended at merge_ready ----------------------------------
    expect(result.rounds).toHaveLength(2);
    expect(result.outcome).toBe('merge_ready');
    expect(slice.service.status(runId).phase).toBe('merge_ready');
    // Round 1 blocked; round 2 all-verified.
    expect(result.rounds[0]!.verification.verification.outcome).toBe('blocked');
    expect(result.rounds[1]!.verification.verification.outcome).toBe('all_verified');
    expect(result.mergeReadiness!.ready).toBe(true);

    // --- The engine drove T23 (needs_remediation) then T24 (merge_ready) ----
    const types = dbHandle!.db.events.listByRun(runId).map((e) => e.type);
    expect(types).toContain('verification.completed.failed'); // T23
    expect(types).toContain('remediation.started');
    expect(types).toContain('verification.completed.passed'); // T24
    expect(slice.service.status(runId).counters.remediationRounds).toBe(1);

    // --- Round 2's implementor prompt carried the structured fix-request ----
    const implAdapters = slice.created.filter((c) => c.role === 'implementor');
    expect(implAdapters).toHaveLength(2);
    const round2Prompt = implAdapters[1]!.prompts[0] ?? '';
    expect(round2Prompt).toContain('Remediation');
    expect(round2Prompt).toContain('AC-2');
    expect(round2Prompt).toContain('gate debug on the flag');

    // --- The final verified commit advanced past round 1 (remediation commit)
    expect(String(result.rounds[1]!.implementationCommit)).not.toBe(
      String(result.rounds[0]!.implementationCommit),
    );

    await slice.worktrees.removeWorktree(asg);
  });
});

// ===========================================================================
// W1-F1 + W1-F4 composition — §16 readiness gates merge_ready end to end
// ===========================================================================
describe('W1-F1/W1-F4 — a mutating verification command never yields merge_ready', () => {
  it('criteria verify every round but the §16 worktree-dirty blocker forces T23 rounds (bounded) — never a false merge_ready', async () => {
    const allPass = verifierTurn([
      { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' },
      { id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0' },
    ]);
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        {
          writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const verbose = true;\n' }],
          turns: [implementorTurn('Implemented --verbose.')],
        },
        {
          writes: [{ relPath: 'src/cli/quiet.ts', content: 'export const quietByDefault = true;\n' }],
          turns: [implementorTurn('Round 2: addressed the integration blocker as far as in-scope.')],
        },
      ],
      // BOTH rounds: every criterion verifies — only §16 readiness blocks.
      verifier: [{ turns: [allPass] }, { turns: [allPass] }],
    });

    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_slice_mutating');

    // A verification command that MUTATES the worktree on every run (unique
    // content per call, so a later round's commit never masks it).
    let calls = 0;
    const mutatingVerify: VerificationRunner = async (command, cwd) => {
      calls += 1;
      fs.writeFileSync(path.join(cwd, 'verify-side-effect.txt'), `verification run ${calls}\n`);
      return { exitCode: 0, stdout: `ran ${command}`, stderr: '', launchFailed: false };
    };

    const result = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      {
        runId,
        assignmentId: asg,
        implementor: IMPLEMENTOR,
        verifier: VERIFIER,
        specHash: outcome.specVersion.contentHash,
        // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
        specApprovedBy: 'human',
        specDocument: outcome.canonicalSpec,
        goal: GOAL,
        taskScope: 'Implement the --verbose flag end to end in the CLI.',
        criteria: outcome.specVersion.criteria,
        baseCommit: slice.baseCommit,
        evidence: recorder,
        runVerificationCommands: mutatingVerify,
        maxRounds: 2,
      },
    );

    // --- NEVER a false merge_ready: both rounds blocked on §16 (W1-F1) -----
    expect(result.outcome).toBe('needs_remediation');
    expect(result.finalPhase).toBe('needs_remediation');
    expect(slice.service.status(runId).phase).toBe('needs_remediation');
    expect(result.rounds).toHaveLength(2);
    expect(slice.service.status(runId).counters.remediationRounds).toBe(2);

    // --- W1-F4: the implementor report caught the post-commit dirt ----------
    expect(result.rounds[0]!.implementation!.postVerificationDirty).toBe(true);
    expect(result.rounds[0]!.implementation!.postVerificationDirtyFiles).toContain('verify-side-effect.txt');

    // --- The §16 report is honest: not ready, blocker names the file --------
    const mr = result.mergeReadiness!;
    expect(mr).toBeDefined();
    expect(mr.ready).toBe(false);
    expect(mr.worktreeClean).toBe(false);
    expect(mr.blockers.some((b) => b.includes('verify-side-effect.txt'))).toBe(true);

    // --- The engine saw ONLY T23 (readiness-blocked shape), never T24 -------
    const events = dbHandle!.db.events.listByRun(runId);
    const failedEvents = events.filter((e) => e.type === 'verification.completed.failed');
    expect(failedEvents.length).toBe(2);
    for (const e of failedEvents) {
      const payload = e.payload as unknown as {
        failedCriteria: readonly string[];
        readinessBlockers?: readonly string[];
      };
      expect(payload.failedCriteria).toEqual([]); // criteria verified — §16 blocked
      expect(payload.readinessBlockers?.some((b) => b.includes('verify-side-effect.txt'))).toBe(true);
    }
    expect(events.map((e) => e.type)).not.toContain('verification.completed.passed');
    expect(events.map((e) => e.type)).not.toContain('merge.readiness.recorded');

    // --- Round 2's implementor prompt carried the integration blocker + the
    // --- W1-F4 guidance (make verification side-effect-free / commit files).
    const implAdapters = slice.created.filter((c) => c.role === 'implementor');
    expect(implAdapters).toHaveLength(2);
    const round2Prompt = implAdapters[1]!.prompts[0] ?? '';
    expect(round2Prompt).toContain('§16 integration blocker');
    expect(round2Prompt).toContain('verify-side-effect.txt');
    expect(round2Prompt).toMatch(/side-effect-free/);

    await slice.worktrees.removeWorktree(asg); // force-removes the dirty worktree
  });
});

// ===========================================================================
// W3-1 composition — a verification command that ESCAPES into the PRIMARY
// checkout: typed violation, durable incident event, §16 readiness blocked
// (T23), never merge_ready.
// ===========================================================================
describe('W3-1 — a verification command that writes into the PRIMARY checkout never yields merge_ready', () => {
  it('records the typed violation + durable incident and blocks §16 readiness (T23) despite all criteria verifying', async () => {
    const allPass = verifierTurn([
      { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' },
      { id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0' },
    ]);
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        {
          writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const verbose = true;\n' }],
          turns: [implementorTurn('Implemented --verbose.')],
        },
      ],
      verifier: [{ turns: [allPass] }],
    });

    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_slice_w3_escape');

    // The reviewer-proven probe: the verification command writes OUTSIDE the
    // worktree, into the primary checkout, and still exits 0.
    const escapingVerify: VerificationRunner = async (command) => {
      fs.writeFileSync(
        path.join(slice.repo.dir, 'planted-by-verification.txt'),
        'escaped the worktree\n',
      );
      return { exitCode: 0, stdout: `ran ${command}`, stderr: '', launchFailed: false };
    };

    const result = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      {
        runId,
        assignmentId: asg,
        implementor: IMPLEMENTOR,
        verifier: VERIFIER,
        specHash: outcome.specVersion.contentHash,
        // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
        specApprovedBy: 'human',
        specDocument: outcome.canonicalSpec,
        goal: GOAL,
        taskScope: 'Implement the --verbose flag end to end in the CLI.',
        criteria: outcome.specVersion.criteria,
        baseCommit: slice.baseCommit,
        evidence: recorder,
        runVerificationCommands: escapingVerify,
        maxRounds: 1,
      },
    );

    // --- NEVER merge_ready: the poisoned round fails verification (T23) -----
    expect(result.outcome).toBe('needs_remediation');
    expect(result.finalPhase).toBe('needs_remediation');
    expect(slice.service.status(runId).phase).toBe('needs_remediation');

    // --- The round report carries the typed violation, self-check failed ----
    const impl = result.rounds[0]!.implementation!;
    expect(impl.runnerViolation).toBeDefined();
    expect(impl.runnerViolation!.kind).toBe('verification_runner_violation');
    expect(impl.runnerViolation!.changedPaths).toContain('planted-by-verification.txt');
    expect(impl.verificationPassed).toBe(false); // commands exited 0; the guard failed it

    // --- The durable incident event landed BEFORE the verifier verdict ------
    const events = dbHandle!.db.events.listByRun(runId);
    const incidents = events.filter((e) => e.type === 'verification.runner.violation');
    expect(incidents).toHaveLength(1);
    const incidentPayload = incidents[0]!.payload as unknown as {
      assignmentId: string;
      changedPaths: readonly string[];
      headBefore: string;
      detail: string;
    };
    expect(incidentPayload.assignmentId).toBe(String(asg));
    expect(incidentPayload.changedPaths).toContain('planted-by-verification.txt');
    expect(incidentPayload.headBefore).toMatch(/^[0-9a-f]{40}$/);
    const incidentSeq = Number(incidents[0]!.sequence);
    const verdictSeq = Number(
      events.find((e) => e.type === 'verification.completed.failed')!.sequence,
    );
    expect(incidentSeq).toBeLessThan(verdictSeq);

    // --- §16 blocked: criteria ALL verified, the violation blocker forced T23
    const failed = events.filter((e) => e.type === 'verification.completed.failed');
    expect(failed).toHaveLength(1);
    const t23Payload = failed[0]!.payload as unknown as {
      failedCriteria: readonly string[];
      unprovenCriteria: readonly string[];
      readinessBlockers?: readonly string[];
    };
    expect(t23Payload.failedCriteria).toEqual([]);
    expect(t23Payload.unprovenCriteria).toEqual([]);
    expect(
      t23Payload.readinessBlockers?.some((b) => b.startsWith('verification-runner violation')),
    ).toBe(true);
    expect(events.map((e) => e.type)).not.toContain('verification.completed.passed');

    // --- The readiness report is honest: not ready, both blockers present ---
    const mr = result.mergeReadiness!;
    expect(mr.ready).toBe(false);
    expect(mr.blockers.some((b) => b.startsWith('verification-runner violation'))).toBe(true);
    expect(mr.destinationClean).toBe(false); // the planted file also dirtied the destination

    // --- The remediation payload tells the next round exactly what happened -
    expect(
      result.rounds[0]!.verification.fixRequests.some(
        (fr) =>
          fr.kind === 'integration_blocker' &&
          fr.summary.startsWith('verification-runner violation') &&
          fr.requestedChange !== undefined &&
          /strictly inside the assignment worktree/.test(fr.requestedChange),
      ),
    ).toBe(true);

    await slice.worktrees.removeWorktree(asg);
  });
});

// ===========================================================================
// PLAN §19 test 22 — mechanical checkpoint sufficiency across a kill
// ===========================================================================
describe('PLAN §19 test 22 — kill mid-run; successor resumes from the checkpoint ALONE and completes', () => {
  it('predecessor checkpoints AC-1=passed and dies; a fresh successor recovers, reads the CAS checkpoint, and reaches merge_ready without replay', async () => {
    // The predecessor implements + commits, then verifies only AC-1 before the
    // "crash"; the successor gets its own verifier adapter (scripted for AC-2).
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        {
          writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const verbose = true;\n' }],
          turns: [implementorTurn('Implemented --verbose.')],
        },
      ],
      // Predecessor verifier (AC-1 only) + successor verifier (AC-2 only).
      verifier: [
        { turns: [verifierTurn([{ id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' }])] },
        { turns: [verifierTurn([{ id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0' }])] },
      ],
    });
    const db = dbHandle!.db;

    const { runId, outcome } = await coordinateAndApprove(slice);
    const criteria = outcome.specVersion.criteria;
    const specHash = outcome.specVersion.contentHash;
    const asg = assignmentId('asg_slice_kill');

    // --- Predecessor implements + commits (real worktree, real commit) ------
    const handle = await slice.worktrees.createWorktree({ assignmentId: asg, baseCommit: slice.baseCommit });
    slice.service.advanceWorkflowPhase(runId, 'approved', 'implementing');
    // Reuse the implementor flow via the loop's own machinery is overkill here;
    // drive it directly for the one predecessor round.
    const { ImplementorFlow } = await import('./implementor.js');
    const implFlow = new ImplementorFlow(
      handle,
      {
        goal: GOAL,
        specHash,
        specDocument: outcome.canonicalSpec,
        criteria,
        taskScope: 'Implement --verbose.',
      },
      { runVerification: PASS_VERIFY },
    );
    const implResult = await slice.service.runRole(
      runId,
      {
        role: 'implementor',
        run: (session) => implFlow.run(session),
        adjudicateRoundOutcome: () => 'completed',
      },
      IMPLEMENTOR,
      handle.worktreePath,
    );
    slice.worktrees.releaseLease(asg);
    const implCommit = implResult.commitSha!;
    expect(implCommit).toBeDefined();
    slice.service.advanceWorkflowPhase(runId, 'implementing', 'verifying');

    // --- Predecessor verifies AC-1 (its own evidence), then checkpoints -----
    const { recorder, records } = fakeEvidence();
    const ac1Runner = new VerifierRunner({
      criteria: [criteria[0]!], // AC-1 only
      implementationCommit: implCommit,
      evidence: recorder,
    });
    const ac1Gathering = await slice.service.runRole(runId, ac1Runner, VERIFIER, handle.worktreePath);
    expect(ac1Gathering.criteria[0]!.verdict).toBe('passed');
    const ac1EvidenceRef = ac1Gathering.criteria[0]!.evidenceRefs[0]!;
    expect(records).toHaveLength(1); // AC-1 evidence gathered by the predecessor

    // Mechanical checkpoint (§12.2 — no LLM): AC-1 passed w/ its evidence,
    // AC-2 still pending. Written to the CAS, event appended via `ingest`.
    const worktreeState: WorktreeState = {
      headSha: implCommit,
      statusPorcelain: '',
      diffHash: artifactHash('diff_pred'),
      lockfileCleanupPerformed: false,
      taintFlags: [],
    };
    const criterionStates: ReadonlyArray<{ criterionId: CriterionId; state: CriterionCheckpointState }> = [
      { criterionId: criteria[0]!.id, state: 'passed' },
      { criterionId: criteria[1]!.id, state: 'pending' },
    ];
    const checkpointContent = buildCheckpointContent({
      lineage: { harnessId: VERIFIER.harness, model: VERIFIER.model },
      eventCursor: eventSequence(1),
      specHash,
      criterionStates,
      permissionPolicy: { mode: 'headless', allowlist: [] },
      worktree: worktreeState,
      artifactRefs: [ac1EvidenceRef],
    });
    const written = unwrap(
      await writeCheckpoint(
        { artifacts: db.artifacts, clock: db.clock, ids: slice.ids },
        {
          runId,
          segmentId: mkSegmentId('seg_predecessor'),
          assignmentId: asg,
          reason: 'pre_verify_handoff',
          content: checkpointContent,
        },
      ),
    );
    const recorded = slice.service.ingest(written.event);
    expect(recorded.status).toBe('recorded');
    const checkpointArtifactHash = written.checkpoint.artifactHash;

    // ===== KILL: drop the predecessor service; build a FRESH successor on the
    // ===== same durable store (fresh in-memory engine state, §12.3). A real
    // ===== restarted process gets UUID-based ids (RandomIdFactory), so its
    // ===== idempotency keys never collide with the predecessor's — modeling
    // ===== that faithfully here rather than reusing a deterministic counter.
    const successorIds = new RandomIdFactory();
    const { factory: successorFactory, created: successorCreated } = makeSliceFactory({
      // The successor gets its own verifier adapter, scripted for AC-2 only.
      verifier: [
        { turns: [verifierTurn([{ id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0' }])] },
      ],
    });
    const successor = new OrchestrationService({ db, ids: successorIds, adapterFactory: successorFactory });

    // §12.3: ORCHESTRATOR state is recovered from the event log (phase=verifying).
    const recovered = successor.recover(runId);
    expect(recovered.phase).toBe('verifying');

    // The AGENT's in-context progress is recovered ONLY from the checkpoint:
    // read it back from the CAS by its committed event — nothing else.
    // Target the handoff checkpoint by reason: the §12.2 completed-turn
    // cadence (W4-1) legitimately writes earlier `cadence` checkpoints as the
    // slice drives its turns, so "the first checkpoint.recorded" is no longer
    // unambiguous — the resume path wants the pre_verify_handoff one. F8 (C):
    // the IMPLEMENTOR round now writes a real `pre_verify_handoff` checkpoint
    // at its own commit boundary too, so take the LATEST one — the
    // predecessor-verifier checkpoint this test just appended — exactly as
    // `resolveResumeCheckpointHash` does (latest-by-sequence).
    const checkpointEvent = db.events
      .listByRun(runId)
      .findLast(
        (e) =>
          e.type === 'checkpoint.recorded' &&
          (e.payload as { reason?: string }).reason === 'pre_verify_handoff',
      );
    expect(checkpointEvent).toBeDefined();
    const storedHash = (checkpointEvent!.payload as { artifactHash: ArtifactHash }).artifactHash;
    expect(String(storedHash)).toBe(String(checkpointArtifactHash));
    const bytes = db.artifacts.readBytes(storedHash);
    expect(bytes).toBeDefined();
    const parsed = JSON.parse(Buffer.from(bytes!).toString('utf8')) as {
      criterionStates: ReadonlyArray<{ criterionId: string; state: CriterionCheckpointState }>;
      artifactRefs: readonly string[];
    };
    const resumeFrom: VerifierResumeState = {
      criterionStates: parsed.criterionStates.map((s) => ({
        criterionId: criterionId(s.criterionId),
        state: s.state,
      })),
      evidenceRefs: parsed.artifactRefs.map((r) => artifactHash(r)),
    };
    // The checkpoint alone establishes AC-1=passed with the predecessor's evidence.
    expect(resumeFrom.criterionStates).toContainEqual({ criterionId: criteria[0]!.id, state: 'passed' });
    expect(resumeFrom.evidenceRefs.map(String)).toEqual([String(ac1EvidenceRef)]);

    // --- Successor completes verification from the checkpoint ALONE ----------
    const { recorder: successorRecorder } = fakeEvidence();
    const binding: VerificationBinding = {
      assignmentId: asg,
      specHash,
      baseCommit: handle.baseSha,
      implementationCommit: implCommit,
      repoRoot: handle.repoRoot,
      worktreeBranch: handle.branch,
      destinationRef: 'main',
    };
    const probe = gitMergeReadinessProbe({
      repoRoot: handle.repoRoot,
      worktreePath: handle.worktreePath,
      baseCommit: handle.baseSha,
      verifiedCommit: implCommit,
      destinationRef: 'HEAD',
    });
    const successorResult = await runVerification({
      engine: successor,
      runId,
      verifierSpec: VERIFIER,
      cwd: handle.worktreePath,
      binding,
      criteria,
      evidence: successorRecorder,
      resumeFrom,
      mergeReadinessProbe: probe,
      approvedSpecHash: specHash,
      // B2 (codex F5): required signer — this slice approved as a human.
      specApprovedBy: 'human',
      ids: successorIds,
      clock: db.clock,
    });

    // AC-1 was carried from the checkpoint (NOT re-verified); only AC-2 ran.
    expect(successorResult.gathering.carriedCriterionIds.map(String)).toEqual([String(criteria[0]!.id)]);
    expect(successorResult.gathering.verifiedCriterionIds.map(String)).toEqual([String(criteria[1]!.id)]);
    const ac1 = successorResult.verification.criteria.find((c) => String(c.criterionId) === String(criteria[0]!.id))!;
    expect(ac1.verdict).toBe('passed');
    expect(ac1.evidenceRefs.map(String)).toEqual([String(ac1EvidenceRef)]); // the checkpoint's own evidence

    // Exactly ONE successor verifier turn ran — no predecessor turn replayed.
    const successorVerifier = successorCreated.find((c) => c.role === 'verifier')!;
    expect(successorVerifier.prompts).toHaveLength(1);
    expect(successorVerifier.prompts[0]).toContain('AC-2');
    expect(successorVerifier.prompts[0]).not.toContain('[AC-1]'); // AC-1 not re-verified

    // The successor reached merge_ready from the checkpoint alone (T24, §16).
    expect(successorResult.gathering.outcome).toBe('all_verified');
    expect(successorResult.transition.status).toBe('applied');
    if (successorResult.transition.status === 'applied') {
      expect(successorResult.transition.transitionId).toBe('T24');
    }
    expect(successorResult.mergeReadiness?.ready).toBe(true);
    expect(successor.status(runId).phase).toBe('merge_ready');

    await slice.worktrees.removeWorktree(asg);
  });
});

// ===========================================================================
// F2 (§review dogfood) — the verifier deliverable gate
// ===========================================================================
describe('F2 — a round with no real deliverable never dispatches a verifier (persisted)', () => {
  function loopInput(
    slice: Slice,
    runId: RunId,
    outcome: CoordinatorOutcome,
    recorder: EvidenceRecorder,
    asg: ReturnType<typeof assignmentId>,
  ): Parameters<typeof runImplementVerifyLoop>[1] {
    return {
      runId,
      assignmentId: asg,
      implementor: IMPLEMENTOR,
      verifier: VERIFIER,
      specHash: outcome.specVersion.contentHash,
      // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
      specApprovedBy: 'human',
      specDocument: outcome.canonicalSpec,
      goal: GOAL,
      taskScope: 'Implement the --verbose flag end to end in the CLI.',
      criteria: outcome.specVersion.criteria,
      constraints: ['Touch only files under src/cli'],
      explorationArtifact: 'The arg parser lives in src/cli/index.ts (bound to base deadbeef).',
      baseCommit: slice.baseCommit,
      evidence: recorder,
      runVerificationCommands: PASS_VERIFY,
    };
  }

  const bothPass = verifierTurn([
    { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' },
    { id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0' },
  ]);

  it('abnormal stop (refusal): blocks the verifier, persists no_deliverable, throws NoDeliverableError', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        // Refusal turn — no writes, so nothing is committed either.
        { turns: [{ ...implementorTurn('I will not do this.'), result: { stopReason: 'refusal' } }] },
      ],
      verifier: [{ turns: [bothPass] }], // must never be reached
    });
    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_f2_refusal');

    const err: unknown = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      loopInput(slice, runId, outcome, recorder, asg),
    ).then(() => undefined).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoDeliverableError);
    // No verifier was EVER spawned.
    expect(slice.created.some((c) => c.role === 'verifier')).toBe(false);
    // The gate is PERSISTED as no_deliverable (resume can't read it as "verify next").
    expect(slice.service.getRoleRound(runId)?.stage).toBe('no_deliverable');
    const types = dbHandle!.db.events.listByRun(runId).map((e) => e.type);
    expect(types).not.toContain('verification.completed.passed');
    expect(types).not.toContain('verification.completed.failed');
    // Direct verifier call with no dispatch metadata still hits the role-based
    // engine choke point before admission.
    const direct = await slice.service.runRole(
      runId,
      { role: 'verifier', run: async () => ({}) },
      VERIFIER,
      slice.repo.dir,
    ).catch((e: unknown) => e);
    expect(direct).toBeInstanceOf(NoDeliverableError);
    expect(slice.created.some((c) => c.role === 'verifier')).toBe(false);
    await slice.worktrees.removeWorktree(asg);
  });

  it('runtime-refuses an implementor runner missing adjudication before admission', async () => {
    const slice = await openSlice({ coordinator: [{ turns: [coordinatorTurn(validSpec())] }] });
    const { runId } = await coordinateAndApprove(slice);
    const before = slice.created.length;
    const missing = { role: 'implementor', run: async () => ({}) } as unknown as RoleRunner<{}>;
    const err = await slice.service
      .runRole(runId, missing, IMPLEMENTOR, slice.repo.dir)
      .catch((e: unknown) => e);
    expect(String(err)).toMatch(/require adjudicateRoundOutcome/i);
    expect(slice.created).toHaveLength(before);
  });

  it('dispatchless runRole still adjudicates and rejects an implementor no-deliverable verdict', async () => {
    const slice = await openSlice({ coordinator: [{ turns: [coordinatorTurn(validSpec())] }] });
    const { runId } = await coordinateAndApprove(slice);
    const error = await slice.service
      .runRole(
        runId,
        {
          role: 'implementor',
          run: async () => ({ attempted: true }),
          adjudicateRoundOutcome: () => 'no_deliverable',
        },
        IMPLEMENTOR,
        slice.repo.dir,
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NoDeliverableError);
  });

  it('valid zero-diff no-op on a FRESH round is ALLOWED into verification (not blocked)', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      // No writes → the implementor cleanly ends `end_turn` with nothing to commit.
      implementor: [{ turns: [implementorTurn('The spec is already satisfied; no change needed.')] }],
      verifier: [{ turns: [bothPass] }],
    });
    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_f2_zerodiff');

    // Bound to a single round: whatever the merge-readiness verdict on an empty
    // diff, the point is that the verifier RAN (F2 did not block a clean fresh
    // no-op) — it never throws NoDeliverableError and never persists that stage.
    const result = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      { ...loopInput(slice, runId, outcome, recorder, asg), maxRounds: 1 },
    );

    // The round was a clean zero-diff no-op...
    expect(result.rounds[0]!.implementation!.committed).toBe(false);
    // ...and the verifier WAS dispatched to prove the criteria against the base
    // (F2 policy: a legitimate no-op candidate is allowed, never auto-failed).
    expect(slice.created.some((c) => c.role === 'verifier')).toBe(true);
    expect(result.rounds[0]!.verification).toBeDefined();
    await slice.worktrees.removeWorktree(asg);
  });

  it('remediation with no new commit is BLOCKED — round-1 verifier runs, round-2 verifier never does', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        // Round 1 commits a real change.
        { writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const v = 1;\n' }], turns: [implementorTurn('Round 1.')] },
        // Round 2 (remediation) writes NOTHING → no new commit → blocked.
        { turns: [implementorTurn('Round 2: I could not make further progress.')] },
      ],
      verifier: [
        // Round 1: AC-1 fails → T23 remediation.
        { turns: [verifierTurn([
          { id: 'AC-1', verdict: 'failed', fix: 'AC-1 still not wired' },
          { id: 'AC-2', verdict: 'passed', evidence: 'ok' },
        ])] },
        { turns: [bothPass] }, // round-2 verifier — must never run
      ],
    });
    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_f2_remediation');

    const err: unknown = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      loopInput(slice, runId, outcome, recorder, asg),
    ).then(() => undefined).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoDeliverableError);
    // Exactly ONE verifier ran (round 1); the no-progress round-2 verifier did not.
    expect(slice.created.filter((c) => c.role === 'verifier')).toHaveLength(1);
    expect(slice.service.getRoleRound(runId)?.stage).toBe('no_deliverable');
    await slice.worktrees.removeWorktree(asg);
  });

  it('restart/resume does NOT bypass the gate — a no_deliverable round re-drives the IMPLEMENTOR, not the verifier', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        // Round-1 implementor refuses → no_deliverable.
        { turns: [{ ...implementorTurn('Refusing.'), result: { stopReason: 'refusal' } }] },
        // On resume, the SECOND implementor delivers a real change.
        { writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const v = 2;\n' }], turns: [implementorTurn('Now implemented.')] },
      ],
      verifier: [{ turns: [bothPass] }],
    });
    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_f2_resume');
    const deps = { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock };

    // First pass: the refusal is blocked and persisted no_deliverable.
    await runImplementVerifyLoop(deps, loopInput(slice, runId, outcome, recorder, asg))
      .catch(() => undefined);
    expect(slice.service.getRoleRound(runId)?.stage).toBe('no_deliverable');
    expect(slice.created.some((c) => c.role === 'verifier')).toBe(false);

    // Resume from the persisted no_deliverable round: it must re-enter the
    // IMPLEMENTOR (first: 'implement'), NOT skip to the verifier.
    const round = slice.service.getRoleRound(runId)!;
    const result = await runImplementVerifyLoop(deps, {
      ...loopInput(slice, runId, outcome, recorder, asg),
      resume: { round },
    });

    // The implementor was re-driven (a second implementor adapter) and only THEN
    // did a verifier run — the gate held across the resume.
    expect(slice.created.filter((c) => c.role === 'implementor')).toHaveLength(2);
    expect(slice.created.some((c) => c.role === 'verifier')).toBe(true);
    expect(result.outcome).toBe('merge_ready');
    await slice.worktrees.removeWorktree(asg);
  });

  it('the gate is an ENGINE invariant — a direct advanceWorkflowPhase to verifying is refused for a no_deliverable round', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [{ turns: [{ ...implementorTurn('Refusing.'), result: { stopReason: 'refusal' } }] }],
      verifier: [{ turns: [bothPass] }],
    });
    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_f2_invariant');
    await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      loopInput(slice, runId, outcome, recorder, asg),
    ).catch(() => undefined);

    // Persisted no_deliverable, run left at `implementing`.
    expect(slice.service.getRoleRound(runId)?.stage).toBe('no_deliverable');
    expect(slice.service.status(runId).phase).toBe('implementing');
    // The engine itself refuses the implementing → verifying advance — a caller
    // reaching past the orchestrator (public advanceWorkflowPhase / direct
    // runVerification) cannot bypass the deliverable gate.
    expect(() => slice.service.advanceWorkflowPhase(runId, 'implementing', 'verifying')).toThrow(
      /no deliverable/i,
    );
    await slice.worktrees.removeWorktree(asg);
  });
});

// ===========================================================================
// F5 (§review dogfood) — base commit pinned at start, threaded through the loop
// ===========================================================================
describe('F5 — the implementation base is pinned at start, not resolved live at run', () => {
  it('createRun records an immutable base commit; getRunBaseCommit reads it', async () => {
    const slice = await openSlice({ coordinator: [{ turns: [coordinatorTurn(validSpec())] }] });
    const base = gitSha(await slice.repo.headSha());
    const { runId } = createRunFixture(slice.service, {
      goal: GOAL,
      workspacePath: slice.repo.dir,
      coordinator: COORDINATOR,
      baseCommit: base,
    });
    expect(String(slice.service.getRunBaseCommit(runId))).toBe(String(base));
  });

  it('a LEGACY run (no pinned base) is pinned ONCE, audited; a re-pin to a DIFFERENT sha is refused', async () => {
    const slice = await openSlice({ coordinator: [{ turns: [coordinatorTurn(validSpec())] }] });
    // Legacy: created without a base.
    const { runId } = createLegacyRunFixture(slice.service, dbHandle!.db, {
      goal: GOAL,
      workspacePath: slice.repo.dir,
      coordinator: COORDINATOR,
    });
    expect(slice.service.getRunBaseCommit(runId)).toBeUndefined();

    const base = gitSha(await slice.repo.headSha());
    slice.service.pinRunBaseCommit(runId, base); // audited one-time pin
    expect(String(slice.service.getRunBaseCommit(runId))).toBe(String(base));
    expect(dbHandle!.db.events.listByRun(runId).some((e) => e.type === 'run.base_commit.pinned')).toBe(true);

    // Re-pinning to the SAME sha is a benign no-op; a DIFFERENT sha is refused.
    expect(slice.service.pinRunBaseCommit(runId, base)).toBeUndefined();
    expect(() => slice.service.pinRunBaseCommit(runId, gitSha('0'.repeat(40)))).toThrow(/already has a pinned base/i);
  });

  it('strict F5 refuses HEAD drift before the first fresh implementation worktree', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        { writes: [{ relPath: 'src/cli/verbose.ts', content: 'export const v = 1;\n' }], turns: [implementorTurn('Implemented.')] },
      ],
      verifier: [
        {
          turns: [
            verifierTurn([
              { id: 'AC-1', verdict: 'passed', evidence: 'ok' },
              { id: 'AC-2', verdict: 'passed', evidence: 'ok' },
            ]),
          ],
        },
      ],
    });
    // The base is pinned at "start" (before any drift).
    const pinnedBase = gitSha(await slice.repo.headSha());
    const { runId, outcome } = await coordinateAndApprove(slice);

    // A commit lands AFTER start but BEFORE run — the exact dogfood drift.
    await slice.repo.writeFile('UNRELATED.md', 'landed between start and run\n');
    const advancedHead = await slice.repo.commitAll('unrelated commit after start');
    expect(advancedHead).not.toBe(String(pinnedBase));

    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_f5_pin');
    const err: unknown = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      {
        runId,
        assignmentId: asg,
        baseCommit: pinnedBase,
        implementor: IMPLEMENTOR,
        verifier: VERIFIER,
        specHash: outcome.specVersion.contentHash,
        // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
        specApprovedBy: 'human',
        specDocument: outcome.canonicalSpec,
        goal: GOAL,
        taskScope: 'Implement --verbose.',
        criteria: outcome.specVersion.criteria,
        constraints: [],
        explorationArtifact: 'bound to base',
        evidence: recorder,
        runVerificationCommands: PASS_VERIFY,
      },
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ name: 'WorkspaceDriftError', kind: 'base_drift' });
    expect(slice.service.status(runId).phase).toBe('approved');
    expect(slice.service.getImplementVerifyLoopState(runId)).toBeUndefined();
    expect(advancedHead).not.toBe(String(pinnedBase));
  });

  it('strict F5 refuses a different exact base SHA before the first fresh implementation worktree', async () => {
    const slice = await openSlice({ coordinator: [{ turns: [coordinatorTurn(validSpec())] }] });
    const pinnedBase = gitSha(await slice.repo.headSha());
    const { runId, outcome } = await coordinateAndApprove(slice);

    await slice.repo.writeFile('OTHER.md', 'another reachable commit\n');
    const otherBase = gitSha(await slice.repo.commitAll('other reachable base'));
    await slice.repo.run(['reset', '--hard', pinnedBase]);

    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_f5_wrong_exact_base');
    const err: unknown = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      {
        runId,
        assignmentId: asg,
        baseCommit: otherBase,
        implementor: IMPLEMENTOR,
        verifier: VERIFIER,
        specHash: outcome.specVersion.contentHash,
        // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
        specApprovedBy: 'human',
        specDocument: outcome.canonicalSpec,
        goal: GOAL,
        taskScope: 'Implement --verbose.',
        criteria: outcome.specVersion.criteria,
        constraints: [],
        explorationArtifact: 'bound to base',
        evidence: recorder,
        runVerificationCommands: PASS_VERIFY,
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorktreeError);
    expect(err).toMatchObject({ kind: 'invalid_base_commit' });
    expect(String(err)).toContain(`does not match run ${runId} pinned base ${pinnedBase}`);
    expect(slice.worktrees.handleFor(asg)).toBeUndefined();
    expect(slice.service.getImplementVerifyLoopState(runId)).toBeUndefined();
    expect(slice.service.status(runId).phase).toBe('approved');
  });

  it('must-fix 4: the loop REFUSES a fresh worktree with NO pinned base (never live HEAD)', async () => {
    const slice = await openSlice({ coordinator: [{ turns: [coordinatorTurn(validSpec())] }] });
    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const err: unknown = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      {
        runId,
        assignmentId: assignmentId('asg_f5_nobase'),
        implementor: IMPLEMENTOR,
        verifier: VERIFIER,
        specHash: outcome.specVersion.contentHash,
        // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
        specApprovedBy: 'human',
        specDocument: outcome.canonicalSpec,
        goal: GOAL,
        taskScope: 'x',
        criteria: outcome.specVersion.criteria,
        evidence: recorder,
        runVerificationCommands: PASS_VERIFY,
        // Runtime callers can still bypass the required TypeScript field.
      } as never,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreeError);
    expect(err).toMatchObject({ kind: 'invalid_base_commit' });
  });
});

// ===========================================================================
// F2 (must-fix 2) — the deliverable adjudicator: every non-end_turn stop,
// commit-vs-host-HEAD, and the round>1 no-progress rule
// ===========================================================================
describe('F2 adjudicateImplementorDeliverable — every non-normal stop + host-HEAD check', () => {
  const HEAD = gitSha('a'.repeat(40));
  function result(overrides: Partial<ImplementorResult>): ImplementorResult {
    return {
      changedFiles: [],
      diff: '',
      committed: false,
      stopReason: 'end_turn',
      baseSha: gitSha('b'.repeat(40)),
      ...overrides,
    } as ImplementorResult;
  }

  it('every non-end_turn stop is no_deliverable (cancelled/refusal/max_tokens/max_turn_requests)', () => {
    for (const stopReason of ['cancelled', 'refusal', 'max_tokens', 'max_turn_requests'] as const) {
      expect(adjudicateImplementorDeliverable(result({ stopReason, committed: true, commitSha: HEAD }), 1, HEAD)).toBe(
        'no_deliverable',
      );
    }
  });

  it('a claimed commit that DISAGREES with host HEAD is no_deliverable (§8: never trust the agent SHA)', () => {
    const claimed = gitSha('c'.repeat(40));
    expect(
      adjudicateImplementorDeliverable(result({ committed: true, commitSha: claimed }), 1, HEAD),
    ).toBe('no_deliverable');
  });

  it('a claimed commit that MATCHES host HEAD is a deliverable', () => {
    expect(adjudicateImplementorDeliverable(result({ committed: true, commitSha: HEAD }), 1, HEAD)).toBe('completed');
  });

  it('committed=true without a commitSha is never a deliverable', () => {
    expect(adjudicateImplementorDeliverable(result({ committed: true }), 1, HEAD)).toBe('no_deliverable');
  });

  it('a REMEDIATION round (round > 1) with no new commit is no_deliverable; round 1 zero-diff is allowed', () => {
    expect(adjudicateImplementorDeliverable(result({ committed: false }), 2, HEAD)).toBe('no_deliverable');
    // Fresh round-1 clean zero-diff no-op → allowed into independent verification.
    expect(adjudicateImplementorDeliverable(result({ committed: false }), 1, HEAD)).toBe('completed');
    expect(
      adjudicateImplementorDeliverable(
        result({ committed: false, changedFiles: ['dirty.ts'], diff: '+dirty' }),
        1,
        HEAD,
      ),
    ).toBe('no_deliverable');
  });
});

// ===========================================================================
// F7 — dependency-provisioning fail-closed HALTS the loop before the verifier
// ===========================================================================
describe('F7 — provisioning fail-closed halts the loop before verifier dispatch (§2.1/§2.4)', () => {
  it('an implementor commit that declares deps without an ignore rule → provisioning_failed, NO verifier, NO merge_ready', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        {
          // The implementor introduces a package.json declaring deps AND writes a
          // node_modules file — but the repo has NO `node_modules` ignore rule. B1:
          // the commit must EXCLUDE node_modules (addAllExceptNodeModules), and the
          // post-commit F7 preflight then fails closed (unignored node_modules).
          writes: [
            {
              relPath: 'package.json',
              content: JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }),
            },
            {
              relPath: 'package-lock.json',
              content: '{"name":"x","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{}}',
            },
            { relPath: 'node_modules/evil.js', content: 'module.exports = "toolchain";\n' },
          ],
          turns: [implementorTurn('Added a dependency.')],
        },
      ],
      verifier: [{ turns: [verifierTurn([{ id: 'AC-1', verdict: 'passed', evidence: 'unreached' }])] }], // must NEVER run
    });
    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_f7_loop_failclosed');

    const result = await runImplementVerifyLoop(
      { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock },
      {
        runId,
        assignmentId: asg,
        implementor: IMPLEMENTOR,
        verifier: VERIFIER,
        specHash: outcome.specVersion.contentHash,
        // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
        specApprovedBy: 'human',
        specDocument: outcome.canonicalSpec,
        goal: GOAL,
        taskScope: 'Implement the --verbose flag end to end in the CLI.',
        criteria: outcome.specVersion.criteria,
        baseCommit: slice.baseCommit,
        evidence: recorder,
        runVerificationCommands: PASS_VERIFY,
      },
    );

    expect(result.outcome).toBe('provisioning_failed');
    expect(result.provisioningFailure).toBeDefined();
    expect(result.provisioningFailure?.detail).toMatch(/not git-ignored/i);
    // M9: the failure carries the round and the ACTUAL committed HEAD (not stale).
    expect(result.provisioningFailure?.round).toBe(1);
    expect(result.provisioningFailure?.implementationCommit).toBeDefined();
    // B1: node_modules never entered the committed tree (excluded from the commit),
    // despite the missing ignore rule. ROUND 13 (ITEM 1) restored this: the commit
    // happens BEFORE provisioning, so at staging time an agent-created tree is
    // always unignored and unmarked — requiring a positive signal there meant the
    // generated tree was committed permanently. The ROOT tree is main's
    // unconditional exclusion and is excluded again.
    const tracked = (await slice.repo.run(['ls-tree', '-r', '--name-only', String(result.implementationCommit)])).split('\n');
    expect(tracked.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(tracked).toContain('package.json');
    // The verifier was NEVER dispatched, and no verification verdict was recorded.
    expect(slice.created.some((c) => c.role === 'verifier')).toBe(false);
    const types = dbHandle!.db.events.listByRun(runId).map((e) => e.type);
    expect(types).not.toContain('verification.completed.passed');
    expect(types).not.toContain('verification.completed.failed');
    expect(slice.service.status(runId).phase).not.toBe('merge_ready');
    await slice.worktrees.removeWorktree(asg);
  });

  // Round-3 #1: a COMPLETED implementor round whose provisioning failed is persisted
  // `completed` and re-enters at VERIFICATION on resume. The old adoption path called
  // validate(), whose dirty-tree recovery WIP-committed the ENTIRE tree (`git add -A`)
  // — corrupting the branch with node_modules and making unadjudicated dirt the
  // verifier's HEAD. The fix RESETS the adopted worktree to EXACTLY the persisted
  // implementation commit and DISCARDS the dirt. (The abnormal/no-commit → resume
  // re-drives the implementor path is re-confirmed by the F2 "restart/resume does NOT
  // bypass the gate" test above.)
  it('#1 — a completed round that failed provisioning RESUMES by resetting to the persisted commit (NO dirt WIP-committed)', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        {
          // Round 1 commits a feature AND leaves a provisioned (un-ignored)
          // node_modules in the worktree; the repo has NO ignore rule → the post-commit
          // preflight fails closed. The commit EXCLUDES node_modules (B1), so c1's tree
          // is clean and node_modules is untracked worktree DIRT at resume time.
          writes: [
            {
              relPath: 'package.json',
              content: JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }),
            },
            {
              relPath: 'package-lock.json',
              content: '{"name":"x","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{}}',
            },
            { relPath: 'src/cli/verbose.ts', content: 'export const v = 1;\n' },
            { relPath: 'node_modules/.bin/tsc', content: '#!/bin/sh\nexit 0\n' }, // the provisioned-toolchain dirt
          ],
          turns: [implementorTurn('Added a dependency.')],
        },
      ],
      verifier: [{ turns: [verifierTurn([{ id: 'AC-1', verdict: 'passed', evidence: 'unreached' }])] }], // must NEVER run
    });
    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_f7_resume_reset');
    const deps = { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock };
    const loopInput: Parameters<typeof runImplementVerifyLoop>[1] = {
      runId,
      assignmentId: asg,
      implementor: IMPLEMENTOR,
      verifier: VERIFIER,
      specHash: outcome.specVersion.contentHash,
      // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
      specApprovedBy: 'human',
      specDocument: outcome.canonicalSpec,
      goal: GOAL,
      taskScope: 'Implement the --verbose flag end to end in the CLI.',
      criteria: outcome.specVersion.criteria,
      baseCommit: slice.baseCommit,
      evidence: recorder,
      runVerificationCommands: PASS_VERIFY,
    };

    // First pass: round 1 commits, provisioning fails closed → the loop HALTS with the
    // round persisted `completed` and the implementation commit c1 recorded.
    const first = await runImplementVerifyLoop(deps, loopInput);
    expect(first.outcome).toBe('provisioning_failed');
    expect(slice.service.getRoleRound(runId)?.role).toBe('implementor');
    expect(slice.service.getRoleRound(runId)?.stage).toBe('completed');
    const c1 = first.implementationCommit;
    const worktreePath = first.worktree.worktreePath;
    expect(await git.resolveSha(worktreePath, 'HEAD')).toBe(String(c1));

    // Resume the COMPLETED implementor round (re-enters at verification).
    const round = slice.service.getRoleRound(runId)!;
    const resumed = await runImplementVerifyLoop(deps, { ...loopInput, resume: { round } });

    // The worktree HEAD is STILL exactly c1 — no WIP commit was made on top of it.
    expect(await git.resolveSha(worktreePath, 'HEAD')).toBe(String(c1));
    expect(String(resumed.implementationCommit)).toBe(String(c1));
    // The branch has exactly ONE commit past the base (round-1's) — proof the resume
    // did NOT WIP-commit the node_modules dirt onto a new, unadjudicated HEAD.
    const commitCount = (
      await git.runGit(['rev-list', '--count', `${String(slice.baseCommit)}..HEAD`], worktreePath)
    ).stdout.trim();
    expect(commitCount).toBe('1');
    // node_modules NEVER entered any commit (not in c1's tree, and c1 is still HEAD)
    // — ROUND 13 (ITEM 1) again: the ROOT tree is excluded unconditionally while
    // provisioning is active, so it stays untracked worktree dirt for the resume
    // path to reconcile rather than becoming part of the branch.
    const tracked = (await slice.repo.run(['ls-tree', '-r', '--name-only', String(c1)])).split('\n');
    expect(tracked.some((p) => p.startsWith('node_modules'))).toBe(false);
    expect(tracked).toContain('package.json');
    // The re-provision at the verifier boundary still fails closed on the un-ignored
    // tree (#7: its detail is redacted by toProvisioningFailure), so no verifier ran.
    expect(resumed.outcome).toBe('provisioning_failed');
    expect(resumed.provisioningFailure?.detail).toMatch(/not git-ignored/i);
    expect(slice.created.some((c) => c.role === 'verifier')).toBe(false);
    await slice.worktrees.removeWorktree(asg);
  });

  // Round-4 #1: the persisted implementation commit is ROUND-SCOPED. A record left
  // STALE by a DIFFERENT round (a later round durably completed at a new commit but
  // crashed before updating it) must NEVER be used to reset/verify the wrong commit —
  // resume falls back to the current HEAD (exactly the resuming round's durable commit).
  it('#1 (round-4) — a persisted implementation commit from a DIFFERENT round is NOT used on resume (round-scoped)', async () => {
    const slice = await openSlice({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        {
          writes: [
            {
              relPath: 'package.json',
              content: JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }),
            },
            {
              relPath: 'package-lock.json',
              content: '{"name":"x","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{}}',
            },
            { relPath: 'src/cli/verbose.ts', content: 'export const v = 1;\n' },
            { relPath: 'node_modules/.bin/tsc', content: '#!/bin/sh\nexit 0\n' },
          ],
          turns: [implementorTurn('Added a dependency.')],
        },
      ],
      verifier: [{ turns: [verifierTurn([{ id: 'AC-1', verdict: 'passed', evidence: 'unreached' }])] }],
    });
    const { runId, outcome } = await coordinateAndApprove(slice);
    const { recorder } = fakeEvidence();
    const asg = assignmentId('asg_f7_roundscope');
    const deps = { service: slice.service, worktrees: slice.worktrees, ids: slice.ids, clock: dbHandle!.db.clock };
    const loopInput: Parameters<typeof runImplementVerifyLoop>[1] = {
      runId,
      assignmentId: asg,
      implementor: IMPLEMENTOR,
      verifier: VERIFIER,
      specHash: outcome.specVersion.contentHash,
      // B2 (codex F5): required signer — the slice approves as a human (T1 via the service).
      specApprovedBy: 'human',
      specDocument: outcome.canonicalSpec,
      goal: GOAL,
      taskScope: 'Implement the --verbose flag end to end in the CLI.',
      criteria: outcome.specVersion.criteria,
      baseCommit: slice.baseCommit,
      evidence: recorder,
      runVerificationCommands: PASS_VERIFY,
    };

    // Round 1 commits c1, provisioning fails closed → completed round persisted at c1.
    const first = await runImplementVerifyLoop(deps, loopInput);
    expect(first.outcome).toBe('provisioning_failed');
    const c1 = first.implementationCommit;
    const worktreePath = first.worktree.worktreePath;
    expect(await git.resolveSha(worktreePath, 'HEAD')).toBe(String(c1));

    // Simulate the multi-round crash: poison the persisted record to a MISMATCHED round
    // pointing at the WRONG commit (the base). The round-scoped guard must reject it and
    // fall back to the current HEAD (c1) — never hard-reset/verify the base.
    const state = slice.service.getImplementVerifyLoopState(runId)!;
    slice.service.saveImplementVerifyLoopState(runId, {
      ...state,
      worktree: { ...state.worktree!, lastImplementationCommit: { round: 0, commit: slice.baseCommit } },
    });

    const round = slice.service.getRoleRound(runId)!;
    const resumed = await runImplementVerifyLoop(deps, { ...loopInput, resume: { round } });
    const headAfter = await git.resolveSha(worktreePath, 'HEAD');
    expect(headAfter).toBe(String(c1)); // reset to the CORRECT round-1 commit (current HEAD)
    expect(headAfter).not.toBe(String(slice.baseCommit)); // NEVER the stale/wrong commit
    expect(String(resumed.implementationCommit)).toBe(String(c1));
    await slice.worktrees.removeWorktree(asg);
  });
});

// ===========================================================================
// F7 round-3 #7 — a verifier-boundary provisioning error is REDACTED before it is
// surfaced (the CLI prints ProvisioningFailure.detail; a secret-shaped install/clone
// error must never reach that sink raw — the same redaction the implementor boundary
// already applies).
// ===========================================================================
describe('F7 round-3 #7 — toProvisioningFailure redacts the surfaced detail', () => {
  it('scrubs a secret-shaped detail from the verifier-boundary provisioning failure', () => {
    const handle = { repoRoot: '/repo', worktreePath: '/wt' } as WorktreeHandle;
    const secret = 'AKIAIOSFODNN7EXAMPLE'; // a canonical AWS-access-key-id-shaped token
    // ROUND 8 (LOW): a provisioning refusal now surfaces the operator-facing
    // MESSAGE (it carries the evidence — package, installed vs lockfile version)
    // rather than the terse `.detail` hint. Redaction is what is under test, so
    // the secret is planted in the surfaced field.
    const error = new WorktreeError('provisioning_failed', `npm ci failed: registry auth key ${secret} was rejected`, {
      detail: 'dependency install failed',
    });
    const pf = toProvisioningFailure(error, handle);
    expect(pf.kind).toBe('provisioning_failed');
    expect(pf.repoRoot).toBe('/repo');
    expect(pf.detail).not.toContain(secret); // the raw secret never reaches the CLI/sink
    expect(pf.detail).toContain('REDACTED'); // replaced by the redaction marker

    // ...and the OTHER field is not a bypass: a secret in `.detail` is simply not
    // surfaced for a provisioning refusal, so it cannot leak either.
    const inDetail = new WorktreeError('provisioning_failed', 'dependency install failed', {
      detail: `npm ci failed: registry auth key ${secret} was rejected`,
    });
    expect(toProvisioningFailure(inDetail, handle).detail).not.toContain(secret);
  });
});
