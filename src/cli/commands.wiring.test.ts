/**
 * D-1 wiring proof (PLAN §18, §20 P3): the SHIPPED CLI surface — `executeCommand`
 * — drives the full post-`start` P3 slice through the one `OrchestrationService`.
 * Uses IN-PROCESS FAKE adapters + a REAL temp git repo (no real spawns), exactly
 * as `start`/`run` do in production once the `CliFlowDeps` runtime is injected:
 *
 *   start  → service.runCoordination (coordinator drafts + validates a §7 spec) → awaiting_approval
 *   approve → T1 (explicit human gate; --test-approve seam, HARNESS_TEST_MODE=1)  → approved
 *   run    → runImplementVerifyLoop (implement → verify → §16 merge-readiness)    → merge_ready
 *   status → phase merge_ready / ui done
 *
 * This is the composition the CLI was missing (docs/reviews/p3-live-acceptance.md
 * Defect D-1). It asserts the shipped commands reach `merge_ready` and surface the
 * §16 manual integration commands — every transition still going through the
 * service, no CLI-only state.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { artifactHash, gitSha, specHash as toSpecHash, specVersionId as toSpecVersionId, type RunId } from '../domain/ids.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { ArtifactStore } from '../artifacts/store.js';
import { loadProfileFile, type Profile } from '../config/profile.js';
import {
  AdapterError,
  InProcessFakeAdapter,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
} from '../adapters/index.js';
import { GitWorktreeManager } from '../worktree/index.js';
import { makeTempGitRepo, type TempGitRepo } from '../worktree/test-support.js';
import {
  OrchestrationService,
  type Harness,
  type RoleAdapterFactory,
  type RoleModelSpec,
} from '../app/index.js';
import { CoordinatorRunner } from '../app/flows/coordinator.js';
import type { EvidenceRecorder } from '../app/flows/verifier.js';
import type { VerificationRunner } from '../app/flows/implementor.js';
import { createLegacyRunFixture, createRunFixture } from '../app/test-support.js';
import { executeCommand, type CliFlowDeps } from './commands.js';
import { buildCliFlows, renderFatalError } from './index.js';

const GOAL = 'Add a --verbose flag to the CLI so debug lines print to stderr.';
const COORDINATOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const IMPLEMENTOR: RoleModelSpec = { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const PROFILE_PATH = fileURLToPath(new URL('../../profiles/coordinator.md', import.meta.url));

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

function validSpec(): Record<string, unknown> {
  return {
    goal: GOAL,
    assumptions: ['The CLI entrypoint is src/cli/index.ts.'],
    openQuestions: [],
    constraints: ['Touch only files under src/cli'],
    permissions: ['read and write within the assigned worktree'],
    nonGoals: ['No change to the existing log format'],
    tasks: [{ id: 'T1', description: 'Recognize --verbose in the arg parser', dependsOn: [] }],
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
  };
}

const fence = (o: unknown): string => '```json\n' + JSON.stringify(o, null, 2) + '\n```';

const coordinatorTurn = (spec: unknown): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text: `Here is the specification.\n\n${fence(spec)}` }],
  result: { stopReason: 'end_turn' },
});

const implementorTurn = (text: string): InProcessTurnScript => ({
  updates: [
    { kind: 'agent_message_chunk', text },
    // A Codex subscription-style turn: tokens advertised, no per-token price (§17.2 D-2).
    { kind: 'usage_update', usedTokens: 500, contextWindowSize: 200_000 },
  ],
  result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 40, source: 'adapter' } },
});

const verifierTurn = (
  rows: ReadonlyArray<{ id: string; verdict: string; evidence?: string }>,
): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text: JSON.stringify({ criteria: rows }) }],
  result: { stopReason: 'end_turn' },
});

const PASS_VERIFY: VerificationRunner = async (command) => ({
  exitCode: 0,
  stdout: `ran ${command}`,
  stderr: '',
  launchFailed: false,
});

interface AdapterScript {
  readonly writes?: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly turns: readonly InProcessTurnScript[];
  /** Reject every `prompt()` with EXACTLY this raw error (transport-faithful
   * shapes, e.g. the `${method} failed: ${envelope.message}` composition). */
  readonly promptRejection?: unknown;
}

function makeFactory(scripts: {
  readonly coordinator?: readonly AdapterScript[];
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}): RoleAdapterFactory {
  const cursors: Record<string, number> = {};
  return {
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
      const orig = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (input) => {
        if (script.promptRejection !== undefined) throw script.promptRejection;
        for (const write of script.writes ?? []) {
          const target = path.join(options.cwd, write.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, write.content, 'utf8');
        }
        return orig(input);
      };
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
}

function fakeEvidence(): EvidenceRecorder {
  let n = 0;
  return {
    async record(input) {
      n += 1;
      return artifactHash(`ev_${String(input.criterionId)}_${n}`);
    },
  };
}

let dbHandle: TestDatabaseHandle | undefined;
let repo: TempGitRepo | undefined;
let worktrees: GitWorktreeManager | undefined;

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
});

interface Wired {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly flows: CliFlowDeps;
  readonly deps: { readonly ids: DeterministicIdFactory; readonly flows: CliFlowDeps };
  readonly coordinatorBaseCommits: Array<ReturnType<typeof gitSha> | undefined>;
}

async function setup(scripts: {
  readonly coordinator?: readonly AdapterScript[];
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}): Promise<Wired> {
  repo = await makeTempGitRepo('harness-cli-wiring-');
  dbHandle = await openTestDatabase({ kind: 'better-sqlite3', file: true });
  worktrees = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: dbHandle.db.clock });
  const ids = new DeterministicIdFactory();
  const flowIds = new DeterministicIdFactory();
  const service = new OrchestrationService({ db: dbHandle.db, ids, adapterFactory: makeFactory(scripts) });
  const store = new ArtifactStore({ rootDir: dbHandle.casRoot, clock: dbHandle.db.clock, ids: flowIds });
  const profileResult = loadProfileFile(PROFILE_PATH);
  if (!profileResult.ok) throw new Error(`coordinator profile failed to load: ${JSON.stringify(profileResult.error)}`);
  const profile: Profile = profileResult.value;
  const mgr = worktrees;
  const coordinatorBaseCommits: Array<ReturnType<typeof gitSha> | undefined> = [];
  const flows: CliFlowDeps = {
    ids,
    clock: dbHandle.db.clock,
    // `revise` forwarded so a `spec revise` re-drive carries the T2 revision
    // context (prior version + feedback) into the coordinator flow (W1-F7).
    buildCoordinatorRunner: ({ goal, revise, baseCommit }) => {
      coordinatorBaseCommits.push(baseCommit);
      return new CoordinatorRunner({
        goal,
        profile,
        artifactStore: store,
        ids: flowIds,
        clock: dbHandle!.db.clock,
        baseCommit,
        ...(revise !== undefined ? { revise } : {}),
      });
    },
    openWorktrees: async () => mgr,
    evidence: fakeEvidence(),
    runVerification: PASS_VERIFY,
  };
  return { service, db: dbHandle.db, flows, deps: { ids, flows }, coordinatorBaseCommits };
}

function seedLegacyApprovalDraft(
  service: OrchestrationService,
  db: TestDatabaseHandle['db'],
): {
  readonly runId: RunId;
  readonly specVersionId: ReturnType<typeof toSpecVersionId>;
  readonly specHash: ReturnType<typeof toSpecHash>;
} {
  const { runId } = createLegacyRunFixture(service, db, {
    goal: GOAL,
    workspacePath: repo!.dir,
    coordinator: COORDINATOR,
  });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  const specVersionId = toSpecVersionId('spec_legacy_1');
  const specHash = toSpecHash('hash_legacy_1');
  service.saveSpecDraft(runId, {
    specVersionId,
    specHash,
    canonicalSpec: JSON.stringify(validSpec()),
    goal: GOAL,
    criteria: [],
    proposedImplementorProfile: 'implementor',
    proposedVerifierProfile: 'verifier',
    revision: 1,
  });
  return { runId, specVersionId, specHash };
}

describe('D-1: the shipped CLI (executeCommand) drives the full P3 slice', () => {
  it('F5: start creates no run for non-git, unborn, or dirty workspaces', async () => {
    const { service, db, deps } = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
    });
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-nongit-'));
    const unborn = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-unborn-'));
    try {
      execFileSync('git', ['init'], { cwd: unborn, stdio: 'ignore' });
      for (const workspace of [nonGit, unborn]) {
        const refused = await executeCommand(
          service,
          db,
          { kind: 'start', json: true, workspace, goal: GOAL, coordinator: COORDINATOR },
          {},
          deps,
        );
        expect(refused.exitCode).toBe(2);
        expect(refused.json).toMatchObject({ refused: 'workspace_unresolvable' });
        expect(refused.json['runId']).toBeUndefined();
      }
      const dirty = path.join(repo!.dir, 'untracked-before-start.txt');
      fs.writeFileSync(dirty, 'dirty\n', 'utf8');
      const refused = await executeCommand(
        service,
        db,
        { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
        {},
        deps,
      );
      expect(refused.exitCode).toBe(2);
      expect(refused.json).toMatchObject({ refused: 'workspace_dirty' });
      expect(refused.json['runId']).toBeUndefined();
      fs.rmSync(dirty);

      // Refusals consumed no run id and never invoked the coordinator.
      const accepted = await executeCommand(
        service,
        db,
        { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
        {},
        deps,
      );
      expect(accepted.exitCode).toBe(0);
      expect(accepted.json['runId']).toBe('run_000001');
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
      fs.rmSync(unborn, { recursive: true, force: true });
    }
  });

  it('F5: coordinator dirt is refused inside the role boundary before any draft completes', async () => {
    const { service, db, deps } = await setup({
      coordinator: [
        {
          writes: [{ relPath: 'coordinator-drift.txt', content: 'changed during coordination\n' }],
          turns: [coordinatorTurn(validSpec())],
        },
      ],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(start.exitCode).toBe(2);
    expect(start.json).toMatchObject({ refused: 'workspace_dirty' });
    const runId = start.json['runId'] as RunId;
    expect(service.status(runId).phase).toBe('specifying');
    expect(service.getSpecDraft(runId)).toBeUndefined();
  });

  it('F5: approval refuses a dirty or HEAD-drifted primary checkout with structured fields', async () => {
    const { service, db, deps } = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };
    const dirty = path.join(repo!.dir, 'dirty-before-approve.txt');
    fs.writeFileSync(dirty, 'dirty\n', 'utf8');
    const dirtyApproval = await executeCommand(
      service,
      db,
      {
        kind: 'approve', json: true, runId,
        specVersionId: toSpecVersionId(spec.specVersionId), specHash: toSpecHash(spec.specHash), testApprove: false,
      },
      {},
      deps,
    );
    expect(dirtyApproval.json).toMatchObject({ refused: 'workspace_dirty' });
    expect(dirtyApproval.json['dirtyPaths']).toContain('dirty-before-approve.txt');
    fs.rmSync(dirty);
    await repo!.writeFile('ADVANCED.md', 'new head\n');
    await repo!.commitAll('advance before approval');
    const driftApproval = await executeCommand(
      service,
      db,
      {
        kind: 'approve', json: true, runId,
        specVersionId: toSpecVersionId(spec.specVersionId), specHash: toSpecHash(spec.specHash), testApprove: false,
      },
      {},
      deps,
    );
    expect(driftApproval.json).toMatchObject({ refused: 'base_drift' });
    expect(driftApproval.json['pinnedSha']).toBeTruthy();
    expect(driftApproval.json['currentSha']).toBeTruthy();
    expect(driftApproval.text).toContain(`pinned SHA: ${String(driftApproval.json['pinnedSha'])}`);
    expect(driftApproval.text).toContain(`current SHA: ${String(driftApproval.json['currentSha'])}`);
  });

  it('C2/C3: legacy approval refuses dirt, then takes one audited clean pin and renders both SHAs', async () => {
    const { service, db, deps } = await setup({});
    const legacy = seedLegacyApprovalDraft(service, db);
    const dirty = path.join(repo!.dir, 'legacy-dirty.txt');
    fs.writeFileSync(dirty, 'dirty\n', 'utf8');

    const refused = await executeCommand(
      service,
      db,
      {
        kind: 'approve', json: true, runId: legacy.runId,
        specVersionId: legacy.specVersionId, specHash: legacy.specHash, testApprove: false,
      },
      {},
      deps,
    );
    expect(refused.exitCode).toBe(2);
    expect(refused.json).toMatchObject({ refused: 'workspace_dirty' });
    expect(refused.json['pinnedSha']).toBeTruthy();
    expect(refused.json['currentSha']).toBe(refused.json['pinnedSha']);
    expect(refused.text).toContain(`pinned SHA: ${String(refused.json['pinnedSha'])}`);
    expect(refused.text).toContain(`current SHA: ${String(refused.json['currentSha'])}`);
    expect(service.getRunBaseCommit(legacy.runId)).toBeUndefined();

    fs.rmSync(dirty);
    const approved = await executeCommand(
      service,
      db,
      {
        kind: 'approve', json: true, runId: legacy.runId,
        specVersionId: legacy.specVersionId, specHash: legacy.specHash, testApprove: false,
      },
      {},
      deps,
    );
    expect(approved.exitCode).toBe(0);
    expect(service.getRunBaseCommit(legacy.runId)).toBe(gitSha(await repo!.headSha()));
    expect(db.events.listByRun(legacy.runId).filter((event) => event.type === 'run.base_commit.pinned')).toHaveLength(1);
  });

  it('C2: legacy spec revise pins once before T2 and forwards that base to the coordinator', async () => {
    const revisedSpec = { ...validSpec(), constraints: ['No dependency changes'] };
    const { service, db, deps, coordinatorBaseCommits } = await setup({
      coordinator: [{ turns: [coordinatorTurn(revisedSpec)] }],
    });
    const legacy = seedLegacyApprovalDraft(service, db);
    const expectedBase = gitSha(await repo!.headSha());

    const revised = await executeCommand(
      service,
      db,
      { kind: 'spec_revise', json: true, runId: legacy.runId, feedback: 'No dependency changes.' },
      {},
      deps,
    );
    expect(revised.exitCode).toBe(0);
    expect(revised.json).toMatchObject({ outcome: 'applied', phase: 'awaiting_approval' });
    expect(service.getRunBaseCommit(legacy.runId)).toBe(expectedBase);
    expect(coordinatorBaseCommits).toEqual([expectedBase]);
    expect(db.events.listByRun(legacy.runId).filter((event) => event.type === 'run.base_commit.pinned')).toHaveLength(1);
  });

  it('start → approve → run → status reaches merge_ready with §16 integration commands', async () => {
    const { service, db, deps } = await setup({
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
              { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0, stderr has debug prefix' },
              { id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0, no debug line on stdout' },
            ]),
          ],
        },
      ],
    });

    // --- start: DRIVES the coordinator flow → awaiting_approval ---------------
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(start.exitCode).toBe(0);
    const runId = start.json['runId'] as RunId;
    expect(service.status(runId).phase).toBe('awaiting_approval');
    const spec = start.json['spec'] as { specVersionId: string; specHash: string; criteria: unknown[] };
    expect(spec.specHash).toBeTruthy();
    expect(spec.criteria).toHaveLength(2);
    expect(start.text).toContain(`approve ${runId}`);

    // --- approve: explicit human gate (test seam, binds the REAL spec hash) ----
    const approve = await executeCommand(
      service,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId(spec.specVersionId),
        specHash: toSpecHash(spec.specHash),
        testApprove: true,
      },
      { HARNESS_TEST_MODE: '1' },
    );
    expect(approve.exitCode).toBe(0);
    expect(service.status(runId).phase).toBe('approved');

    // --- run: DRIVES the implement→verify→merge-readiness loop → merge_ready ---
    const run = await executeCommand(
      service,
      db,
      { kind: 'run', json: true, runId, implementor: IMPLEMENTOR, verifier: VERIFIER },
      {},
      deps,
    );
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({
      command: 'run',
      ok: true,
      outcome: 'merge_ready',
      phase: 'merge_ready',
      rounds: 1,
    });
    const mr = run.json['mergeReadiness'] as { ready: boolean; manualIntegrationCommands: string[] };
    expect(mr.ready).toBe(true);
    expect(mr.manualIntegrationCommands.some((c) => c.includes('merge --no-ff'))).toBe(true);
    // §16: the temp repo's default branch is `main` → the switch hint targets it.
    expect(mr.manualIntegrationCommands.some((c) => /\bswitch main\b/.test(c))).toBe(true);

    // --- status: the run is done; every transition went through the service ---
    const status = await executeCommand(service, db, { kind: 'status', json: true, runId }, {});
    expect(status.json).toMatchObject({ phase: 'merge_ready', uiState: 'done' });
    // §17.2 D-2: the Codex subscription turn (tokens, no price) shows an estimate.
    const cost = (status.json['vitals'] as { cost: { costEstimated: boolean; totalEstimatedCostUsd: number } }).cost;
    expect(cost.costEstimated).toBe(true);
    expect(cost.totalEstimatedCostUsd).toBeGreaterThan(0);

    const types = db.events.listByRun(runId).map((e) => e.type);
    expect(types).toContain('spec.approved'); // T1
    expect(types).toContain('verification.completed.passed'); // T24
    expect(types).toContain('merge.readiness.recorded');
  });

  // F9 REGRESSION (fails without the fix): `run` with NO --implementor/--verifier
  // flags DEFAULTS to the approved spec draft's proposed profiles (PLAN §18). The
  // coordinator here proposes resolvable profiles; the flagless run must reach
  // merge_ready and the plan must reflect the PROPOSED harness/model — not exit
  // `missing_profiles` (the pre-fix behavior).
  it('run with NO profile flags defaults to the approved spec draft proposed profiles → merge_ready', async () => {
    const specWithProfiles = {
      ...validSpec(),
      proposedImplementorProfile: 'codex:gpt-5.6-terra',
      proposedVerifierProfile: 'claude:opus',
    };
    const { service, db, deps } = await setup({
      coordinator: [{ turns: [coordinatorTurn(specWithProfiles)] }],
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

    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };

    const approve = await executeCommand(
      service,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId(spec.specVersionId),
        specHash: toSpecHash(spec.specHash),
        testApprove: true,
      },
      { HARNESS_TEST_MODE: '1' },
    );
    expect(approve.exitCode).toBe(0);

    // No --implementor/--verifier — the approved spec's proposals are the default.
    const run = await executeCommand(service, db, { kind: 'run', json: true, runId }, {}, deps);
    expect(run.json['error']).toBeUndefined();
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ command: 'run', ok: true, outcome: 'merge_ready', phase: 'merge_ready' });
    const plan = run.json['plan'] as {
      implementor: { harness: string; model: string };
      verifier: { harness: string; model: string };
    };
    expect(plan.implementor).toMatchObject({ harness: 'codex', model: 'gpt-5.6-terra' });
    expect(plan.verifier).toMatchObject({ harness: 'claude', model: 'opus' });
  });

  // F9: an explicit flag still OVERRIDES the approved spec's proposal.
  it('run with an explicit --implementor overrides the approved spec proposal', async () => {
    const specWithProfiles = {
      ...validSpec(),
      proposedImplementorProfile: 'codex:gpt-5.6-terra',
      proposedVerifierProfile: 'claude:opus',
    };
    const { service, db, deps } = await setup({
      coordinator: [{ turns: [coordinatorTurn(specWithProfiles)] }],
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

    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };
    await executeCommand(
      service,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId(spec.specVersionId),
        specHash: toSpecHash(spec.specHash),
        testApprove: true,
      },
      { HARNESS_TEST_MODE: '1' },
    );

    // Explicit --implementor (claude:opus) must win over the proposed codex:gpt-5.6-terra;
    // --verifier omitted still defaults to the proposed claude:opus.
    const run = await executeCommand(
      service,
      db,
      { kind: 'run', json: true, runId, implementor: { harness: 'claude', model: 'opus', effort: 'low' } },
      {},
      deps,
    );
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ outcome: 'merge_ready' });
    const plan = run.json['plan'] as {
      implementor: { harness: string; model: string };
      verifier: { harness: string; model: string };
    };
    expect(plan.implementor).toMatchObject({ harness: 'claude', model: 'opus' });
    expect(plan.verifier).toMatchObject({ harness: 'claude', model: 'opus' });
  });

  it('spec revise completes the round: T2 → coordinator re-drive → NEW draft → awaiting_approval (W1-F7)', async () => {
    const revisedSpec = {
      ...validSpec(),
      constraints: ['Touch only files under src/cli', 'No new dependencies'],
    };
    const { service, db, deps } = await setup({
      // Coordinator adapter #1 drafts the original; #2 drafts the revision.
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }, { turns: [coordinatorTurn(revisedSpec)] }],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec1 = start.json['spec'] as { specVersionId: string; specHash: string };

    const revise = await executeCommand(
      service,
      db,
      { kind: 'spec_revise', json: true, runId, feedback: 'Add a no-new-dependencies constraint.' },
      {},
      deps,
    );
    expect(revise.exitCode).toBe(0);
    expect(revise.json).toMatchObject({
      command: 'spec_revise',
      outcome: 'applied',
      transitionId: 'T2',
      phase: 'awaiting_approval', // the round COMPLETED — back at the human gate
    });
    const spec2 = revise.json['spec'] as {
      specVersionId: string;
      specHash: string;
      revision: number;
      supersedes?: string;
    };
    expect(spec2.specHash).not.toBe(spec1.specHash); // a NEW immutable version
    expect(spec2.revision).toBe(2);
    expect(spec2.supersedes).toBe(spec1.specVersionId);
    expect(service.status(runId).phase).toBe('awaiting_approval');
    // The persisted draft is the NEW version — what approve/run now bind (W1-F3).
    expect(service.getSpecDraft(runId)?.specHash).toBe(spec2.specHash);

    // The OLD approval hash is no longer valid…
    const stale = await executeCommand(
      service,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId(spec2.specVersionId),
        specHash: toSpecHash(spec1.specHash),
        testApprove: false,
      },
      {},
    );
    expect(stale.exitCode).toBe(2);
    expect(stale.json).toMatchObject({ refused: 'approved_hash_mismatch' });

    // …and omitting --spec-hash binds the NEW draft hash.
    const approve = await executeCommand(
      service,
      db,
      { kind: 'approve', json: true, runId, specVersionId: toSpecVersionId(spec2.specVersionId), testApprove: false },
      {},
    );
    expect(approve.exitCode).toBe(0);
    expect(service.status(runId).approvedSpecHash).toBe(spec2.specHash);
  });

  it('F5: run refuses primary-checkout dirt before creating the first implementation worktree', async () => {
    const { service, db, deps } = await setup({
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
              { id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0, stderr has debug prefix' },
              { id: 'AC-2', verdict: 'passed', evidence: 'ran check-ac2: exit 0, no debug line on stdout' },
            ]),
          ],
        },
      ],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };
    const approve = await executeCommand(
      service,
      db,
      {
        kind: 'approve',
        json: true,
        runId,
        specVersionId: toSpecVersionId(spec.specVersionId),
        specHash: toSpecHash(spec.specHash),
        testApprove: true,
      },
      { HARNESS_TEST_MODE: '1' },
    );
    expect(approve.exitCode).toBe(0);

    // Dirty the DESTINATION (primary checkout) — the one §16 blocker only a
    // human can clear; criteria will all verify.
    const junkPath = path.join(repo!.dir, 'uncommitted-local-change.txt');
    fs.writeFileSync(junkPath, 'operator scratch\n', 'utf8');
    const spawnsBefore = db.events.listByRun(runId).filter((event) => event.type === 'child.spawn.initiated').length;

    const run = await executeCommand(
      service,
      db,
      { kind: 'run', json: true, runId, implementor: IMPLEMENTOR, verifier: VERIFIER },
      {},
      deps,
    );
    expect(run.exitCode).toBe(2);
    expect(run.json).toMatchObject({ command: 'run', ok: false, refused: 'workspace_dirty' });
    expect(run.json['dirtyPaths']).toContain('uncommitted-local-change.txt');
    expect(service.status(runId).phase).toBe('approved');
    expect(service.status(runId).counters.remediationRounds).toBe(0);
    expect(db.events.listByRun(runId).filter((event) => event.type === 'child.spawn.initiated')).toHaveLength(spawnsBefore);
    fs.rmSync(junkPath);
  });

  it('run before approve is rejected (not_approved, exit 1) — no CLI-only state advances it', async () => {
    const { service, db, deps } = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
    });
    const start = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    const runId = start.json['runId'] as RunId;
    // Skip approve → run must refuse (the loop only starts from `approved`).
    const run = await executeCommand(
      service,
      db,
      { kind: 'run', json: true, runId, implementor: IMPLEMENTOR, verifier: VERIFIER },
      {},
      deps,
    );
    expect(run.exitCode).toBe(1);
    expect(run.json).toMatchObject({ command: 'run', error: 'not_approved', phase: 'awaiting_approval' });
    expect(service.status(runId).phase).toBe('awaiting_approval');
  });
});

// ---------------------------------------------------------------------------
// W1-F5: the SHIPPED CLI flow runtime (buildCliFlows) meters every flow
// artifact write through the quota-aware database repository — over-quota
// admission REJECTS through the CLI path instead of silently landing in an
// unmetered store.
// ---------------------------------------------------------------------------
describe('W1-F5: CLI artifact writes go through quota admission (buildCliFlows)', () => {
  it('start fails cleanly when the coordinator spec artifact exceeds the per-run quota', async () => {
    repo = await makeTempGitRepo('harness-cli-quota-');
    // Quotas far below the canonical spec document's size → admission refuses.
    dbHandle = await openTestDatabase({
      kind: 'better-sqlite3',
      file: true,
      quotas: { perRunBytes: 256, globalBytes: 512 },
    });
    const service = new OrchestrationService({
      db: dbHandle.db,
      ids: new DeterministicIdFactory(),
      adapterFactory: makeFactory({ coordinator: [{ turns: [coordinatorTurn(validSpec())] }] }),
    });
    const flows = buildCliFlows(dbHandle.db);
    const out = await executeCommand(
      service,
      dbHandle.db,
      { kind: 'start', json: true, workspace: repo.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      { ids: flows.ids, flows },
    );
    expect(out.exitCode).toBe(1);
    expect((out.json['error'] as { name: string }).name).toBe('ArtifactAdmissionError');
    // The refusal was durably recorded by the repository (§12.1 audit + event).
    const rejections = dbHandle.db.artifacts.listAdmissionRejections();
    expect(rejections.length).toBeGreaterThan(0);
    expect(rejections[0]?.scope).toBe('per_run');
  });
});

// ---------------------------------------------------------------------------
// §17.1: the typed auth/protocol failure path must never leak provider text
// (raw-throw CLI bypass, verifier-demonstrated). A -32000 provider_error is
// classified `auth` → #routeProviderFailure's typed branch rethrows → the
// error unwinds to `executeCommand`'s generic catch → `errorOutput`. Both
// LAYERS are pinned: the SOURCE (the service rethrows a redacted-message
// typed error) and the SINK (errorOutput / the fatal handler redact whatever
// they render). All secret fragments are SYNTHETIC.
// ---------------------------------------------------------------------------
describe('§17.1: typed provider failures reach the CLI redacted (raw-throw bypass closed)', () => {
  /** Five synthetic secret shapes — one per §17.1 rule family. The KEY=value
   * fragment goes FIRST so the transport's `... failed: ` prefix immediately
   * precedes it (the historical assignment-shielding composition). */
  const SECRET_FRAGMENTS = [
    'kv-0paque-fragment-value', // via API_KEY=<value> (name-based assignment)
    'sk-ant-api03-Fak3Fragment000111222', // sk- API key shape
    'AKIAFAKEFRAGMENT0002', // AWS access key id shape
    'ghp_Fak3Fragment00011122233344455', // GitHub token shape
    'leakuser:leakp4ss', // credential URL user:pass
  ] as const;
  const LEAKY_PROVIDER_MESSAGE =
    `API_KEY=${SECRET_FRAGMENTS[0]} rejected; bearer ${SECRET_FRAGMENTS[1]} aws ${SECRET_FRAGMENTS[2]} ` +
    `github ${SECRET_FRAGMENTS[3]} url https://${SECRET_FRAGMENTS[4]}@provider.example.com/v1`;

  /** EXACTLY what the real transport rejects with (transport.ts:#deliver):
   * message = `${method} failed: ${envelope.message}`, envelope carried for
   * the classifier. code -32000 = the shared ACP-SDK authRequired factory →
   * classified `auth` → the typed rethrow path. */
  function rawProviderError(): AdapterError {
    return new AdapterError('provider_error', `session/prompt failed: ${LEAKY_PROVIDER_MESSAGE}`, {
      harnessId: 'claude',
      envelope: { code: -32000, message: LEAKY_PROVIDER_MESSAGE },
    });
  }

  it('start: a -32000 provider_error echoing five secret shapes exits with ALL FIVE redacted in text AND --json', async () => {
    const { service, db, deps } = await setup({
      coordinator: [{ turns: [], promptRejection: rawProviderError() }],
    });
    const out = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      deps,
    );
    expect(out.exitCode).toBe(1);
    // The typed failure surfaced as the honest AdapterError — not a pause.
    expect((out.json['error'] as { name: string }).name).toBe('AdapterError');
    const rendered = `${out.text}\n${JSON.stringify(out.json)}`;
    for (const fragment of SECRET_FRAGMENTS) {
      expect(rendered).not.toContain(fragment);
    }
    expect(rendered).toContain('[REDACTED:');
    // Honest context survives redaction (never over-redacts the frame).
    expect(out.text).toContain('session/prompt failed:');
  });

  it('the SOURCE layer alone is safe: the service rethrows a typed error whose message is already redacted', async () => {
    const { service, flows } = await setup({
      coordinator: [{ turns: [], promptRejection: rawProviderError() }],
    });
    const { runId } = createRunFixture(service, {
      goal: GOAL,
      workspacePath: repo!.dir,
      coordinator: COORDINATOR,
      baseCommit: gitSha(await repo!.headSha()),
    });
    const runner = flows.buildCoordinatorRunner({
      runId,
      goal: GOAL,
      coordinator: COORDINATOR,
      workspacePath: repo!.dir,
      baseCommit: gitSha(await repo!.headSha()),
    });
    const thrown: unknown = await service.runCoordination(runId, runner).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(thrown).toBeInstanceOf(AdapterError);
    const typed = thrown as AdapterError;
    expect(typed.kind).toBe('provider_error'); // shape preserved for upstream checks
    for (const fragment of SECRET_FRAGMENTS) {
      expect(typed.message).not.toContain(fragment);
    }
    expect(typed.message).toContain('[REDACTED:');
  });

  it('the SINK layer alone is safe: errorOutput redacts a NON-routed failure (belt, independent of the source fix)', async () => {
    const { service, db, deps, flows } = await setup({});
    // This error never passes through the service's failure routers — it
    // exercises ONLY the errorOutput sink belt.
    const beltFlows: CliFlowDeps = {
      ...flows,
      buildCoordinatorRunner: () => {
        throw new Error(
          'profile exploded: DB_PASSWORD=belt-0paque-value and sk-ant-api03-BeltFake000111222',
        );
      },
    };
    const out = await executeCommand(
      service,
      db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      { ...deps, flows: beltFlows },
    );
    expect(out.exitCode).toBe(1);
    const rendered = `${out.text}\n${JSON.stringify(out.json)}`;
    expect(rendered).not.toContain('belt-0paque-value');
    expect(rendered).not.toContain('sk-ant-api03-BeltFake000111222');
    expect(rendered).toContain('[REDACTED:');
    expect(rendered).toContain('profile exploded:');
  });

  it('renderFatalError (the top-level CLI handler) redacts message AND stack renderings', () => {
    const error = new Error(
      'fatal: API_KEY=fatal-0paque-value with sk-ant-api03-FatalFake000111222',
    );
    const rendered = renderFatalError(error); // Error path renders the stack
    expect(rendered).not.toContain('fatal-0paque-value');
    expect(rendered).not.toContain('sk-ant-api03-FatalFake000111222');
    expect(rendered).toContain('[REDACTED:');
    // Non-Error throwables are stringified and redacted too.
    expect(renderFatalError('AKIAIOSFODNN7EXAMPLE leaked')).toBe('[REDACTED:aws_access_key] leaked');
  });
});
