/**
 * Implementor FLOW (PLAN §8, §16, §20 P3) — offline tests against the
 * in-process fake adapter + a REAL temp git repo (PLAN §19 test 17: "worktree
 * isolation leaves primary checkout untouched").
 *
 * The fake "implements" by writing a file through a permitted tool INTO its
 * worktree cwd during the prompt turn (the sandbox/permission enforcement that
 * confines writes is a real-adapter concern verified elsewhere — the
 * in-process fake ignores mediation at the SPI level by design). The flow then
 * commits that work, gathers the diff/SHA ITSELF, runs the declared
 * verification commands, and returns the §8 report — while the primary checkout
 * stays byte-for-byte untouched and the run phase never advances (the
 * implementor cannot mark completion).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { artifactHash, assignmentId, criterionId, gitSha, specHash, type ArtifactHash } from '../../domain/ids.js';
import { DeterministicIdFactory } from '../../lib/id-factory.js';
import { availableDriverKinds, openTestDatabase, type TestDatabaseHandle } from '../../persistence/test-support.js';
import type { DriverKind } from '../../persistence/database.js';
import { GitWorktreeManager, runGit, WorktreeError, type WorktreeHandle } from '../../worktree/index.js';
import {
  assertPrimaryCheckoutUntouched,
  makeTempGitRepo,
  snapshotPrimaryCheckout,
  type TempGitRepo,
} from '../../worktree/test-support.js';
import {
  InProcessFakeAdapter,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
} from '../../adapters/index.js';
import {
  NoDeliverableError,
  OrchestrationService,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from '../service.js';
import type { RoleSession } from '../role-runner.js';
import { createRunFixture } from '../test-support.js';
import {
  ImplementorFlow,
  VerificationRunnerEnvError,
  defaultVerificationRunner,
  runImplementor,
  type ImplementorContext,
  type ImplementorResult,
  type VerificationRunner,
  type RunImplementorInput,
} from './implementor.js';
import { adjudicateImplementorDeliverable } from './deliverable.js';
import { err } from '../../lib/result.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
// LOW-10: the F8 (C) receipt tests exercise CAS checkpoint persistence, so they
// run on every available driver rather than only better-sqlite3.
const DRIVER_KINDS = await availableDriverKinds();

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const CODEX_IMPLEMENTOR = { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' } as const;

function codexConfigOptions(): ConfigOptionDescriptor[] {
  return [
    { id: 'model', kind: 'model', values: ['gpt-5.6-terra', 'gpt-5.6-sol'], current: 'gpt-5.6-sol' },
    { id: 'model_reasoning_effort', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

interface CreatedFake {
  readonly options: RoleAdapterOptions;
  readonly adapter: InProcessFakeAdapter;
  /** Every prompt string the flow sent, in order. */
  readonly prompts: string[];
}

/**
 * A factory whose adapter, on each prompt, simulates the agent using a
 * permitted WRITE tool inside its worktree cwd (`options.cwd`) — the exact
 * seam the real workspace-write sandbox would allow — then streams a tool_call
 * and delegates to the scripted in-process turn (agent message + usage).
 */
function makeWritingFactory(opts: {
  readonly writes: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly turns?: readonly InProcessTurnScript[];
  /** round-4 #3: after writing, the "agent" runs `git add -A` in its worktree —
   * STAGING everything it wrote (incl. any node_modules), so the flow's commit path
   * must UNSTAGE node_modules, not merely avoid re-adding it. */
  readonly stageAfterWrite?: boolean;
}): { factory: RoleAdapterFactory; created: CreatedFake[] } {
  const created: CreatedFake[] = [];
  const factory: RoleAdapterFactory = {
    create(options) {
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: codexConfigOptions() },
        ...(opts.turns !== undefined ? { turns: opts.turns } : {}),
      });
      const prompts: string[] = [];
      const origPrompt = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (
        input,
      ) => {
        prompts.push(input.prompt);
        for (const write of opts.writes) {
          const target = path.join(options.cwd, write.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, write.content, 'utf8');
        }
        if (opts.stageAfterWrite === true) {
          execFileSync('git', ['add', '-A'], { cwd: options.cwd });
        }
        input.onUpdate?.({ kind: 'tool_call', toolCallId: 'tc_write', title: 'Write file', status: 'completed' });
        return origPrompt(input);
      };
      created.push({ options, adapter, prompts });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory, created };
}

const REPORTING_TURN: InProcessTurnScript = {
  updates: [
    { kind: 'agent_message_chunk', text: 'Implemented the feature flag. Risk: no integration test added yet.' },
    { kind: 'usage_update', usedTokens: 800, contextWindowSize: 200_000, cost: { amount: 0.1, currency: 'USD' } },
  ],
  result: { stopReason: 'end_turn', usage: { inputTokens: 100, outputTokens: 50, source: 'adapter' } },
};

function baseContext(overrides: Partial<ImplementorContext> = {}): ImplementorContext {
  return {
    goal: 'Add a --feature flag to the CLI',
    specHash: specHash('spec_hash_1'),
    specDocument: 'Add a --feature flag to the CLI entrypoint that toggles the new behavior.',
    criteria: [
      {
        id: criterionId('C1'),
        description: 'CLI accepts --feature and toggles behavior',
        verificationCommands: ['echo verify-c1'],
      },
    ],
    constraints: ['No new runtime dependencies'],
    taskScope: 'Implement the --feature flag end to end in the CLI.',
    explorationArtifact: 'The CLI entrypoint is src/cli.ts (bound to source commit deadbeef).',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
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

async function setup(opts: {
  readonly writes: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly turns?: readonly InProcessTurnScript[];
  /** F7 (round-2 #3): the manager's dependency-provisioning strategy. `'none'`
   * disables managed provisioning (the operator owns node_modules), so the
   * implementor commit keeps normal `git add -A` semantics. Default `'auto'`. */
  readonly provision?: 'auto' | 'clone' | 'install' | 'none';
  /** round-4 #3: the "agent" stages everything it wrote (`git add -A`) during its turn. */
  readonly stageAfterWrite?: boolean;
  /** LOW-10: persistence driver under test; defaults to better-sqlite3. */
  readonly driver?: DriverKind;
}): Promise<{
  service: OrchestrationService;
  worktrees: GitWorktreeManager;
  repo: TempGitRepo;
  created: CreatedFake[];
}> {
  repo = await makeTempGitRepo();
  dbHandle = await openTestDatabase({ kind: opts.driver ?? 'better-sqlite3', file: false });
  const db = dbHandle.db;
  worktrees = await GitWorktreeManager.open({
    primaryRepoRoot: repo.dir,
    clock: db.clock,
    ...(opts.provision !== undefined ? { provision: opts.provision } : {}),
  });
  const { factory, created } = makeWritingFactory({
    writes: opts.writes,
    ...(opts.turns !== undefined ? { turns: opts.turns } : {}),
    ...(opts.stageAfterWrite !== undefined ? { stageAfterWrite: opts.stageAfterWrite } : {}),
  });
  const service = new OrchestrationService({
    db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
  });
  return { service, worktrees, repo, created };
}

const PASS_VERIFY: VerificationRunner = async (command) => ({
  exitCode: 0,
  stdout: `ran: ${command}`,
  stderr: '',
  launchFailed: false,
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('ImplementorFlow — worktree-confined implementation (§8, §16, §19 test 17)', () => {
  it('implements in an isolated worktree, commits, reports diff/SHA, and leaves the primary checkout untouched', async () => {
    const { service, worktrees: wt, repo: r, created } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'the new feature flag\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, {
      goal: 'Add a --feature flag to the CLI',
      workspacePath: r.dir,
      coordinator: CLAUDE_LOW,
    });

    const before = await snapshotPrimaryCheckout(r.dir);
    const asg = assignmentId('asg_impl_1');

    const input: RunImplementorInput = {
      runId,
      assignmentId: asg,
      implementor: CODEX_IMPLEMENTOR,
      baseCommit: gitSha(await r.headSha()), context: baseContext(),
      options: { runVerification: PASS_VERIFY },
    };
    const result = await runImplementor({ service, worktrees: wt }, input);

    // --- §8 report: committed work, gathered facts ------------------------
    expect(result.committed).toBe(true);
    expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(result.changedFiles).toEqual(['feature.txt']);
    expect(result.diff).toContain('the new feature flag');
    expect(result.diffTruncated).toBe(false);

    // --- verification commands ran; results captured honestly -------------
    expect(result.verification).toHaveLength(1);
    expect(result.verification[0]).toMatchObject({ command: 'echo verify-c1', exitCode: 0, passed: true });
    expect(result.verificationPassed).toBe(true);
    // W1-F4: clean (side-effect-free) commands leave no post-verification dirt.
    expect(result.postVerificationDirty).toBe(false);
    expect(result.postVerificationDirtyFiles).toEqual([]);
    // W3-1: a confined command trips no primary-checkout guard.
    expect(result.runnerViolation).toBeUndefined();

    // --- the agent's own narrative (risks live here) captured -------------
    expect(result.agentMessages.join('\n')).toContain('Risk');
    expect(result.toolCalls.some((t) => t.toolCallId === 'tc_write')).toBe(true);
    expect(result.stopReason).toBe('end_turn');

    // --- spawned as the implementor, confined to the worktree cwd ---------
    const handle = wt.handleFor(asg);
    expect(handle).toBeDefined();
    const impl = created[0];
    expect(impl).toBeDefined();
    expect(impl!.options.role).toBe('implementor');
    expect(path.resolve(impl!.options.cwd)).toBe(path.resolve(handle!.worktreePath));
    expect(impl!.options.allowedShellCommands).toEqual(['echo verify-c1']);

    // --- §11.2 model + effort pinned on the implementor session -----------
    const setConfig = impl!.adapter.log.filter((e) => e.op === 'setConfigOption').map((e) => e.detail);
    expect(setConfig).toEqual([
      { optionId: 'model', value: 'gpt-5.6-terra' },
      { optionId: 'model_reasoning_effort', value: 'medium' },
    ]);

    // --- context injection (§8, §15): spec + task scope + exploration + rules
    const prompt = impl!.prompts[0] ?? '';
    expect(prompt).toContain('Add a --feature flag to the CLI entrypoint'); // spec document
    expect(prompt).toContain('Implement the --feature flag end to end'); // assigned task scope
    expect(prompt).toContain('src/cli.ts (bound to source commit deadbeef)'); // exploration artifact
    expect(prompt).toContain('No new runtime dependencies'); // constraint
    expect(prompt).toContain(handle!.worktreePath); // confinement path
    expect(prompt).toMatch(/structured repository tools \(Read, Grep\/Glob, Write, and Edit\)/i);
    expect(prompt).toMatch(/Shell access is limited to read-only repository inspection/i);
    // LOW-11: assert the F11 shell-quoting guidance as a LINE, located by its own
    // content — never by whole-prompt text or position — so an unrelated rebase
    // that adds/reorders prompt rules cannot break this. It must also stay scoped
    // to INSPECTION: the prompt separately forbids using the shell to change
    // files or self-verify, and this guidance must not read as widening that.
    // MERGE COHERENCE: no Hard Rule may GRANT what another FORBIDS. The shell
    // rule once also granted "the exact declared verification commands below",
    // which contradicts the (main-side) rule reserving verification for the host
    // — a prompt that both permits and forbids the same act is worse than either
    // rule alone, because the agent obeys whichever it reads last.
    //
    // Written to hold on BOTH sides of the pending rebase: this branch carries
    // zero such statements, main's b9ca10c adds exactly one (a prohibition), and
    // the merged prompt must never carry two or contain a grant.
    const hardRulesSection = prompt.slice(prompt.indexOf('## Hard Rules'));
    const hardRules = hardRulesSection
      .slice(0, hardRulesSection.indexOf('\n## '))
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(hardRules.length).toBeGreaterThan(0);
    const verificationRules = hardRules.filter((line) =>
      /verification command|verification\/build\/test|declared verification/i.test(line),
    );
    expect(verificationRules.length).toBeLessThanOrEqual(1);
    // No rule may GRANT execution of the verification commands, in any wording.
    for (const rule of hardRules) {
      expect(rule).not.toMatch(/shell access is limited to[^.]*verification/i);
      expect(rule).not.toMatch(/(may|can|should|are allowed to) run the (declared )?verification/i);
    }

    const quotingLine = prompt.split('\n').find((line) => line.includes('single-quote pattern/regex arguments'));
    expect(quotingLine).toBeDefined();
    expect(quotingLine).toMatch(/inspecting the repository/i);
    expect(quotingLine).toMatch(/will be denied/i);
    expect(quotingLine).not.toMatch(/verify|test|build|write|modify/i);
    expect(prompt).toMatch(/Do NOT use shell commands such as mkdir, cp, mv, rm, touch/i);
    expect(prompt).toMatch(/MUST NOT declare the task complete/i); // hard rule: cannot mark complete
    expect(prompt).toMatch(/MUST NOT add, remove, or change any acceptance criterion/i); // cannot change criteria

    // --- ISOLATION (§19 test 17): primary checkout byte-for-byte untouched
    await assertPrimaryCheckoutUntouched(r.dir, before);
    expect(result.commitSha).not.toBe(await r.headSha()); // commit landed on the assignment branch, not main
    const primaryStatus = await r.statusPorcelain();
    expect(primaryStatus).toBe(''); // no stray files leaked into the primary checkout

    // --- the implementor did NOT advance the workflow / mark completion ---
    expect(service.status(runId).phase).toBe('created');

    await wt.removeWorktree(asg);
  });

  it('standalone runImplementor persists and rejects a no-deliverable verdict', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [],
      turns: [{ result: { stopReason: 'refusal' } }],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_impl_standalone_refusal');

    const error = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext(),
        options: { runVerification: PASS_VERIFY },
      },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(NoDeliverableError);
    expect(String(error)).toContain('stopReason=refusal');
    expect(String(error)).toContain('providerStderr=(empty)');
    expect(service.getRoleRound(runId)).toMatchObject({
      role: 'implementor',
      round: 1,
      assignmentId: asg,
      stage: 'no_deliverable',
      diagnostic: expect.stringContaining('stopReason=refusal'),
    });
    await wt.removeWorktree(asg);
  });

  it('must-fix 4: runImplementor REFUSES a fresh worktree with NO pinned base (never live HEAD)', async () => {
    const { service, worktrees: wt, repo: r } = await setup({ writes: [], turns: [REPORTING_TURN] });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const err: unknown = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: assignmentId('asg_impl_nobase'),
        implementor: CODEX_IMPLEMENTOR,
        // Runtime callers can still bypass the required TypeScript field.
        context: baseContext(),
        options: { runVerification: PASS_VERIFY },
      } as never,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorktreeError);
    expect(String(err)).toMatch(/requires baseCommit .*exact 40-character/i);
  });

  it('F5: standalone runImplementor refuses a valid SHA that differs from the run pin before creating a worktree', async () => {
    const { service, worktrees: wt, repo: r } = await setup({ writes: [], turns: [REPORTING_TURN] });
    const pinned = gitSha(await r.headSha());
    const { runId } = createRunFixture(service, {
      goal: 'g',
      workspacePath: r.dir,
      coordinator: CLAUDE_LOW,
      baseCommit: pinned,
    });
    await r.writeFile('later.txt', 'another commit\n');
    const other = gitSha(await r.commitAll('later'));
    await r.run(['reset', '--hard', pinned]);
    const asg = assignmentId('asg_impl_wrong_run_base');

    const err: unknown = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: other,
        context: baseContext(),
        options: { runVerification: PASS_VERIFY },
      },
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorktreeError);
    expect(err).toMatchObject({ kind: 'invalid_base_commit' });
    expect(String(err)).toContain(`does not match run ${runId} pinned base ${pinned}`);
    expect(wt.handleFor(asg)).toBeUndefined();
  });

  it('F5: standalone runImplementor refuses primary-checkout dirt before creating a worktree', async () => {
    const { service, worktrees: wt, repo: r } = await setup({ writes: [], turns: [REPORTING_TURN] });
    const pinned = gitSha(await r.headSha());
    const { runId } = createRunFixture(service, {
      goal: 'g',
      workspacePath: r.dir,
      coordinator: CLAUDE_LOW,
      baseCommit: pinned,
    });
    await r.writeFile('operator-scratch.txt', 'dirty\n');
    const asg = assignmentId('asg_impl_dirty_primary');

    const err: unknown = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: pinned,
        context: baseContext(),
        options: { runVerification: PASS_VERIFY },
      },
    ).catch((e: unknown) => e);

    expect(err).toMatchObject({ kind: 'workspace_dirty' });
    expect(wt.handleFor(asg)).toBeUndefined();
  });

  it('captures a FAILING verification command without hiding it, and still commits the work', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'partial.txt', content: 'work in progress\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const failing: VerificationRunner = async () => ({
      exitCode: 1,
      stdout: '',
      stderr: 'assertion failed',
      launchFailed: false,
    });
    const asg = assignmentId('asg_impl_fail');

    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext({ verificationCommands: ['run-the-suite'] }),
        options: { runVerification: failing },
      },
    );

    // Work is still committed (the implementor never withholds its diff)...
    expect(result.committed).toBe(true);
    expect(result.changedFiles).toEqual(['partial.txt']);
    // ...but the failing self-check is reported honestly, not marked passing.
    expect(result.verification[0]).toMatchObject({ command: 'run-the-suite', exitCode: 1, passed: false });
    expect(result.verificationPassed).toBe(false);
    // The implementor cannot mark completion; the run stays where it was.
    expect(service.status(runId).phase).toBe('created');

    await wt.removeWorktree(asg);
  });

  it('W1-F4: a verification command that MUTATES the tree is caught — the dirt is named and is in NO commit', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'the real work\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    // Simulates a build-style self-check that writes into the worktree.
    const mutating: VerificationRunner = async (command, cwd) => {
      fs.writeFileSync(path.join(cwd, 'generated.lock'), 'produced by the verification build\n');
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };
    const asg = assignmentId('asg_impl_mutating');

    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()), context: baseContext(),
        options: { runVerification: mutating },
      },
    );

    // The commit-then-verify order held: the recorded commit/diff carry ONLY
    // the implementation — the mutation never pollutes them.
    expect(result.committed).toBe(true);
    expect(result.changedFiles).toEqual(['feature.txt']);
    expect(result.diff).not.toContain('generated.lock');
    // ...and the post-verification snapshot catches the dirt, naming the file.
    expect(result.postVerificationDirty).toBe(true);
    expect(result.postVerificationDirtyFiles).toContain('generated.lock');

    await wt.removeWorktree(asg); // manager removal defaults to --force
  });

  it('honestly reports an empty implementation when the agent writes nothing', async () => {
    const { service, worktrees: wt, repo: r } = await setup({ writes: [], turns: [REPORTING_TURN] });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_impl_empty');

    const before = await snapshotPrimaryCheckout(r.dir);
    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()), context: baseContext(),
        options: { runVerification: PASS_VERIFY },
      },
    );

    expect(result.committed).toBe(false);
    expect(result.commitSha).toBeUndefined();
    expect(result.changedFiles).toEqual([]);
    expect(result.diff).toBe('');
    await assertPrimaryCheckoutUntouched(r.dir, before);

    await wt.removeWorktree(asg);
  });

  it('releases the single-writer lease after the run (worktree kept for the verifier)', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'f.txt', content: 'x\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_impl_lease');

    await runImplementor(
      { service, worktrees: wt },
      { runId, assignmentId: asg, implementor: CODEX_IMPLEMENTOR, baseCommit: gitSha(await r.headSha()), context: baseContext(), options: { runVerification: PASS_VERIFY } },
    );

    const handle = wt.handleFor(asg);
    expect(handle).toBeDefined();
    expect(handle!.leased).toBe(false); // lease released...
    expect(fs.existsSync(handle!.worktreePath)).toBe(true); // ...but the worktree stays on disk

    await wt.removeWorktree(asg);
  });
});

describe('W3-1 — defaultVerificationRunner env confinement (§17.1)', () => {
  // SYNTHETIC values only — planted to PROVE invisibility, never real secrets.
  const PLANTED_KEY = 'HARNESS_W3_PLANTED_SECRET_TOKEN';
  const PLANTED_VALUE = 'synthetic-w3-planted-value-not-a-real-secret';
  const EXTRA_KEY = 'HARNESS_W3_EXTRA_TOOLCHAIN_DIR';
  const EXTRA_VALUE = '/opt/synthetic-toolchain';
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-w3-runner-'));
    process.env[PLANTED_KEY] = PLANTED_VALUE;
    process.env[EXTRA_KEY] = EXTRA_VALUE;
  });

  afterEach(() => {
    delete process.env[PLANTED_KEY];
    delete process.env[EXTRA_KEY];
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** Writes a probe script (quoting-safe vs. inline `node -e`) and returns its command line. */
  function writeProbe(): string {
    const probe = [
      'const planted = process.env["HARNESS_W3_PLANTED_SECRET_TOKEN"] ?? null;',
      'const extra = process.env["HARNESS_W3_EXTRA_TOOLCHAIN_DIR"] ?? null;',
      'process.stdout.write(JSON.stringify({',
      '  planted,',
      '  extra,',
      '  pathPresent: typeof process.env.PATH === "string" && process.env.PATH.length > 0,',
      '}));',
    ].join('\n');
    fs.writeFileSync(path.join(scratch, 'probe.cjs'), probe, 'utf8');
    return 'node probe.cjs';
  }

  it('a planted (synthetic) secret env var is INVISIBLE to the command while PATH survives', async () => {
    const runner = defaultVerificationRunner();
    const outcome = await runner(writeProbe(), scratch);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.launchFailed).toBe(false);
    const seen = JSON.parse(outcome.stdout) as { planted: string | null; extra: string | null; pathPresent: boolean };
    expect(seen.planted).toBeNull(); // the credential-shaped var never crossed
    expect(seen.extra).toBeNull(); // non-allowlisted vars do not cross either — no blanket inherit
    expect(seen.pathPresent).toBe(true); // the minimal toolchain surface did
    // Belt: the planted value appears NOWHERE in the captured output.
    expect(outcome.stdout).not.toContain(PLANTED_VALUE);
    expect(outcome.stderr).not.toContain(PLANTED_VALUE);
  });

  it('per-run EXPLICIT allowlist additions are inherited; the planted secret still is not', async () => {
    const runner = defaultVerificationRunner({ inheritEnvKeys: [EXTRA_KEY] });
    const outcome = await runner(writeProbe(), scratch);
    expect(outcome.exitCode).toBe(0);
    const seen = JSON.parse(outcome.stdout) as { planted: string | null; extra: string | null };
    expect(seen.extra).toBe(EXTRA_VALUE); // the explicit addition crossed…
    expect(seen.planted).toBeNull(); // …the planted secret still did not
  });

  it('credential-shaped additions are refused LOUDLY at construction (typed error)', () => {
    expect(() => defaultVerificationRunner({ inheritEnvKeys: ['MY_API_KEY'] })).toThrow(
      VerificationRunnerEnvError,
    );
    expect(() => defaultVerificationRunner({ inheritEnvKeys: [PLANTED_KEY] })).toThrow(
      /credential-shaped/,
    );
    expect(() => defaultVerificationRunner({ env: { NPM_TOKEN: 'synthetic' } })).toThrow(
      VerificationRunnerEnvError,
    );
  });

  it('a normal npm-style command still runs under the minimal allowlist', async () => {
    const runner = defaultVerificationRunner();
    const outcome = await runner('npm --version', scratch);
    expect(outcome.launchFailed).toBe(false);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ---------------------------------------------------------------------------
// W4-7 — verification timeout reaps the descendant process TREE
// ---------------------------------------------------------------------------
describe('W4-7 — verification timeout kills the descendant process group', () => {
  let scratch: string;
  let survivorPid: number | undefined;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-w4-7-'));
    survivorPid = undefined;
  });

  afterEach(() => {
    // Safety net: if the fix regressed and the descendant leaked, do not let it
    // outlive the test run. SYNTHETIC pid from THIS test only.
    if (survivorPid !== undefined) {
      try {
        process.kill(survivorPid, 'SIGKILL');
      } catch {
        /* already gone — the intended outcome */
      }
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** True once `pid` is gone (ESRCH from a signal-0 probe). */
  function isDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }

  async function waitDead(pid: number, budgetMs: number): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      if (isDead(pid)) return true;
      await new Promise((r) => setTimeout(r, 25));
    }
    return isDead(pid);
  }

  it('a detached descendant that outlives the shell is ALSO terminated on timeout (no survivor), exit still 124', async () => {
    // A background child that records its pid then stays alive far longer than
    // the runner timeout — the "background server/watcher" of the finding. It
    // is spawned via shell `&`, so it shares the shell's process GROUP.
    const bg = [
      'const fs = require("fs");',
      'fs.writeFileSync(process.argv[2], String(process.pid));',
      'setTimeout(() => {}, 60000);',
    ].join('\n');
    // The FOREGROUND command also blocks past the timeout, so the runner's own
    // timer fires (rather than the command exiting on its own).
    const hang = 'setTimeout(() => {}, 60000);';
    fs.writeFileSync(path.join(scratch, 'bg.cjs'), bg, 'utf8');
    fs.writeFileSync(path.join(scratch, 'hang.cjs'), hang, 'utf8');
    const pidFile = path.join(scratch, 'survivor.pid');

    const runner = defaultVerificationRunner({ timeoutMs: 300, terminateGraceMs: 100 });
    const command = `node bg.cjs ${JSON.stringify(pidFile)} & node hang.cjs`;
    const outcome = await runner(command, scratch);

    // The timeout is still reported honestly.
    expect(outcome.exitCode).toBe(124);
    expect(outcome.launchFailed).toBe(false);

    // The descendant recorded its pid and — with the process-GROUP reap — is
    // gone. Without the fix (`exec` signalling only the immediate shell) this
    // orphan survives and the assertion fails.
    expect(fs.existsSync(pidFile)).toBe(true);
    survivorPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(Number.isInteger(survivorPid)).toBe(true);
    expect(await waitDead(survivorPid, 3000)).toBe(true);
  });
});

describe('W3-1 — primary-checkout mutation guard', () => {
  it('an out-of-worktree write into the PRIMARY checkout is a typed violation and fails verification honestly', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'legitimate in-worktree work\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    // Simulates the proven probe: a verification command (or a script it
    // invokes) writing OUTSIDE the worktree into the primary checkout.
    const escaping: VerificationRunner = async (command) => {
      fs.writeFileSync(path.join(r.dir, 'planted-outside-worktree.txt'), 'runner escaped the worktree\n');
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };
    const asg = assignmentId('asg_impl_w3_escape');

    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()), context: baseContext(),
        options: { runVerification: escaping },
      },
    );

    // Every command exited 0 — but the guard caught the escape, so the
    // self-check fails honestly with the typed violation.
    expect(result.verification[0]!.passed).toBe(true);
    expect(result.runnerViolation).toBeDefined();
    expect(result.runnerViolation!.kind).toBe('verification_runner_violation');
    expect(result.runnerViolation!.changedPaths).toContain('planted-outside-worktree.txt');
    expect(result.runnerViolation!.detail).toMatch(/primary checkout mutated/);
    expect(String(result.runnerViolation!.headBefore)).toMatch(/^[0-9a-f]{40}$/);
    expect(result.verificationPassed).toBe(false);
    // The work itself is still committed and reported (never withheld).
    expect(result.committed).toBe(true);

    await wt.removeWorktree(asg);
  });

  it('a HEAD move in the primary checkout across the commands is drift (even with a clean porcelain)', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'work\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const committing: VerificationRunner = async (command) => {
      fs.writeFileSync(path.join(r.dir, 'sneaky.txt'), 'committed into the primary\n');
      await r.commitAll('malicious commit from a verification command');
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };
    const asg = assignmentId('asg_impl_w3_head');

    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()), context: baseContext(),
        options: { runVerification: committing },
      },
    );

    expect(result.runnerViolation).toBeDefined();
    expect(result.runnerViolation!.detail).toMatch(/HEAD moved/);
    expect(String(result.runnerViolation!.headBefore)).not.toBe(String(result.runnerViolation!.headAfter));
    expect(result.verificationPassed).toBe(false);

    await wt.removeWorktree(asg);
  });

  // W3-1(b): three primary mutations that leave HEAD + tracked porcelain
  // UNCHANGED and so evaded the pre-fix snapshot (which hashed only HEAD +
  // `git status --porcelain`). The extended snapshot (hooks manifest + config
  // hash + `--ignored` porcelain) catches each. Without the fix these all
  // report `runnerViolation === undefined` and `verificationPassed === true`.
  it('planting a primary .git/hooks/pre-commit is drift (persistent-RCE vector)', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'work\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    // A verification command (or a script it invokes) plants a hook in the
    // primary .git/hooks — it would execute on the next primary commit.
    const plantingHook: VerificationRunner = async (command) => {
      const hook = path.join(r.dir, '.git', 'hooks', 'pre-commit');
      fs.writeFileSync(hook, '#!/bin/sh\nexfiltrate-secrets\n', { mode: 0o755 });
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };
    const asg = assignmentId('asg_impl_w3_hook');

    const result = await runImplementor(
      { service, worktrees: wt },
      { runId, assignmentId: asg, implementor: CODEX_IMPLEMENTOR, baseCommit: gitSha(await r.headSha()), context: baseContext(), options: { runVerification: plantingHook } },
    );

    expect(result.verification[0]!.passed).toBe(true); // command exited 0…
    expect(result.runnerViolation).toBeDefined(); // …but the guard caught it
    expect(result.runnerViolation!.kind).toBe('verification_runner_violation');
    expect(result.runnerViolation!.detail).toMatch(/\.git\/hooks manifest changed/);
    expect(result.verificationPassed).toBe(false); // §16 readiness blocks on this

    await wt.removeWorktree(asg);
  });

  it('mutating the primary .git/config (git config core.pager) is drift', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'work\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const mutatingConfig: VerificationRunner = async (command) => {
      // `git config core.pager <payload>` writes .git/config — HEAD + porcelain
      // are untouched. Uses git plumbing (argv, no shell) into the primary.
      execFileSync('git', ['config', 'core.pager', 'evil-payload'], { cwd: r.dir });
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };
    const asg = assignmentId('asg_impl_w3_config');

    const result = await runImplementor(
      { service, worktrees: wt },
      { runId, assignmentId: asg, implementor: CODEX_IMPLEMENTOR, baseCommit: gitSha(await r.headSha()), context: baseContext(), options: { runVerification: mutatingConfig } },
    );

    expect(result.runnerViolation).toBeDefined();
    expect(result.runnerViolation!.detail).toMatch(/\.git\/config changed/);
    expect(result.verificationPassed).toBe(false);

    await wt.removeWorktree(asg);
  });

  it('writing a NEW gitignored file into the primary is drift (--ignored porcelain)', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'work\n' }],
      turns: [REPORTING_TURN],
    });
    // Commit a .gitignore so the planted file is IGNORED — plain
    // `git status --porcelain` would NOT list it; only `--ignored` does.
    await r.writeFile('.gitignore', '*.log\n');
    await r.commitAll('add gitignore');
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const writingIgnored: VerificationRunner = async (command) => {
      fs.writeFileSync(path.join(r.dir, 'exfiltrated.log'), 'gitignored payload\n');
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };
    const asg = assignmentId('asg_impl_w3_ignored');

    const result = await runImplementor(
      { service, worktrees: wt },
      { runId, assignmentId: asg, implementor: CODEX_IMPLEMENTOR, baseCommit: gitSha(await r.headSha()), context: baseContext(), options: { runVerification: writingIgnored } },
    );

    expect(result.runnerViolation).toBeDefined();
    expect(result.runnerViolation!.changedPaths).toContain('exfiltrated.log');
    expect(result.verificationPassed).toBe(false);

    await wt.removeWorktree(asg);
  });

  it('a worktree-cwd command reaching the SHARED common .git/hooks is caught', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'work\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    // The runner's cwd is the linked WORKTREE. `git rev-parse --git-common-dir`
    // from there resolves to the PRIMARY shared .git — so the command can plant
    // a hook that runs on the next PRIMARY commit. Prove the guard catches it.
    const plantingViaWorktree: VerificationRunner = async (command, cwd) => {
      const common = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd }).toString().trim();
      const commonAbs = path.isAbsolute(common) ? common : path.resolve(cwd, common);
      // Sanity: the worktree's common-dir IS the primary .git (shared) — compare
      // realpaths (macOS /var vs /private/var symlink would break a raw compare).
      expect(fs.realpathSync(commonAbs)).toBe(fs.realpathSync(path.join(r.dir, '.git')));
      fs.writeFileSync(path.join(commonAbs, 'hooks', 'pre-commit'), '#!/bin/sh\nowned\n', { mode: 0o755 });
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };
    const asg = assignmentId('asg_impl_w3_wt_hook');

    const result = await runImplementor(
      { service, worktrees: wt },
      { runId, assignmentId: asg, implementor: CODEX_IMPLEMENTOR, baseCommit: gitSha(await r.headSha()), context: baseContext(), options: { runVerification: plantingViaWorktree } },
    );

    expect(result.runnerViolation).toBeDefined();
    expect(result.runnerViolation!.detail).toMatch(/\.git\/hooks manifest changed/);
    expect(result.verificationPassed).toBe(false);

    await wt.removeWorktree(asg);
  });
});

describe('ImplementorFlow — confinement guard (§16 item 4)', () => {
  function fakeHandle(worktreePath: string): WorktreeHandle {
    return {
      assignmentId: assignmentId('asg_guard'),
      repoRoot: '/repo',
      worktreePath,
      branch: 'harness/assignment/asg_guard',
      baseSha: 'a'.repeat(40),
      createdAt: '2026-07-18T00:00:00.000Z',
      leased: true,
    } as unknown as WorktreeHandle;
  }

  it('refuses to run when the session cwd is not the worktree (a write would escape isolation)', async () => {
    const flow = new ImplementorFlow(fakeHandle('/wt/assignment-a'), baseContext());
    const session = { role: 'implementor', cwd: '/somewhere/else' } as unknown as RoleSession;
    await expect(flow.run(session)).rejects.toThrow(/confinement violated/i);
  });

  it('refuses a non-implementor session', async () => {
    const flow = new ImplementorFlow(fakeHandle('/wt/assignment-a'), baseContext());
    const session = { role: 'coordinator', cwd: '/wt/assignment-a' } as unknown as RoleSession;
    await expect(flow.run(session)).rejects.toThrow(/expects role 'implementor'/i);
  });
});

// ---------------------------------------------------------------------------
// F7 (§2.1/§2.4): dependency provisioning at the post-commit boundary, and the
// fail-closed gate — the host self-check runner must NEVER run (nor be greened by
// a tool on PATH) when provisioning cannot be proven.
// ---------------------------------------------------------------------------
describe('ImplementorFlow — F7 dependency provisioning fail-closed (§2.1/§2.4)', () => {
  it('skips the host self-check runner and reports provisioningFailed when provisioning fails closed', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'work\n' }],
      turns: [REPORTING_TURN],
    });
    // A repo that DECLARES deps but has NO `node_modules` ignore rule → the F7
    // check-ignore preflight fails closed (deps could otherwise enter a commit).
    await r.writeFile('package.json', JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }));
    await r.writeFile('package-lock.json', '{"name":"x","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{}}');
    await r.commitAll('deps without an ignore rule');
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });

    // A self-check runner that WOULD pass (exit 0) if it ever ran — standing in for
    // a global `tsc`/`vitest` on PATH that must NOT be allowed to green the round.
    let selfCheckCalls = 0;
    const spyVerify: VerificationRunner = async () => {
      selfCheckCalls += 1;
      return { exitCode: 0, stdout: '', stderr: '', launchFailed: false };
    };

    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: assignmentId('asg_f7_failclosed'),
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext({
          criteria: [{ id: criterionId('C1'), description: 'x', verificationCommands: ['echo would-pass'] }],
        }),
        options: { runVerification: spyVerify },
      },
    );

    expect(result.provisioningFailed).toBeDefined();
    expect(result.provisioningFailed?.kind).toBe('provisioning_failed');
    expect(result.provisioningFailed?.detail).toMatch(/not git-ignored/i);
    expect(result.verification).toEqual([]); // the self-check block was skipped
    expect(result.verificationPassed).toBe(false); // never reads as passed
    expect(selfCheckCalls).toBe(0); // the runner was NEVER invoked (fail closed)
    expect(result.committed).toBe(true); // the work IS committed — only verification halts
  });

  it('a no-dependency repo provisions trivially-true and runs the self-check normally', async () => {
    // Sanity: the default provisioning wiring never disturbs a no-deps repo (the
    // makeTempGitRepo base has no package.json → trivially-true, no fail-closed).
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'work\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    let selfCheckCalls = 0;
    const spyVerify: VerificationRunner = async () => {
      selfCheckCalls += 1;
      return { exitCode: 0, stdout: '', stderr: '', launchFailed: false };
    };
    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: assignmentId('asg_f7_trivial'),
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext(),
        options: { runVerification: spyVerify },
      },
    );
    expect(result.provisioningFailed).toBeUndefined();
    expect(selfCheckCalls).toBeGreaterThan(0); // the self-check DID run
    expect(result.verification.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// F7 round-2 #3: the implementor commit excludes node_modules only while managed
// provisioning is ACTIVE; under worktree.provision='none' (the operator owns
// node_modules) it keeps normal `git add -A` semantics so a repo that legitimately
// tracks node_modules changes still commits them.
// ---------------------------------------------------------------------------
describe('ImplementorFlow — F7 round-2 #3 node_modules commit semantics follow the provision strategy', () => {
  async function runOnceTrackingNodeModules(provision: 'none' | 'auto', asg: string) {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [
        { relPath: 'feature.txt', content: 'work\n' },
        { relPath: 'node_modules/tracked.js', content: 'module.exports = 2;\n' }, // an EDIT to a tracked path
      ],
      turns: [REPORTING_TURN],
      provision,
    });
    // The repo legitimately TRACKS a node_modules path (no ignore rule).
    await r.writeFile('node_modules/tracked.js', 'module.exports = 1;\n');
    await r.commitAll('track a node_modules file');
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    return runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: assignmentId(asg),
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext(),
        options: { runVerification: PASS_VERIFY },
      },
    );
  }

  // What actually landed in the COMMIT (base..HEAD) — not `changedFiles`, which is a
  // base→worktree diff and would still show an EXCLUDED (uncommitted) node_modules edit.
  async function committedFiles(result: ImplementorResult): Promise<string[]> {
    const { stdout } = await runGit(['diff', '--name-only', `${String(result.baseSha)}..HEAD`], result.worktreePath);
    return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  }

  it("under provision='none', a change to a TRACKED node_modules path IS committed (normal git add -A)", async () => {
    const result = await runOnceTrackingNodeModules('none', 'asg_f7_none_addall');
    expect(result.provisioningFailed).toBeUndefined(); // 'none' skips the preflight entirely
    expect(result.committed).toBe(true);
    const files = await committedFiles(result);
    expect(files).toContain('feature.txt');
    expect(files).toContain('node_modules/tracked.js'); // committed, not excluded
  });

  // ROUND 10 (Regression 4): a TRACKED node_modules is committed user content —
  // a vendored dependency tree main commits without complaint — so provisioning
  // being ACTIVE does not make it ours to strip. The exclusion is scoped to the
  // ENGINE's tree: git-ignored, or carrying the provisioner's marker.
  it('with provisioning ACTIVE, a TRACKED node_modules edit is still COMMITTED (it is user content)', async () => {
    const result = await runOnceTrackingNodeModules('auto', 'asg_f7_active_exclude');
    expect(result.committed).toBe(true);
    const files = await committedFiles(result);
    expect(files).toContain('feature.txt');
    expect(files).toContain('node_modules/tracked.js'); // main commits this; so do we
  });
});

// ---------------------------------------------------------------------------
// F7 round-3 #6: the standalone runImplementor derives the commit's node_modules
// exclusion from the manager's ACTUAL provisioning strategy and REJECTS a caller
// override that contradicts it — an active-provisioning run can never commit with
// unrestricted `git add -A` (which would stage the provisioned toolchain into HEAD).
// ---------------------------------------------------------------------------
describe('runImplementor — F7 round-3 #6 rejects an inconsistent provisionActive override', () => {
  it('provisionActive=false against an ACTIVE manager is REFUSED before any worktree is created', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'work\n' }],
      turns: [REPORTING_TURN],
      // provision defaults to 'auto' → managed provisioning is ACTIVE.
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_f7_override');

    const err: unknown = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext(),
        // The inconsistent override: the manager provisions (active) but the caller
        // asks to keep normal `git add -A` — which would stage the provisioned,
        // git-ignored toolchain into HEAD.
        options: { provisionActive: false, runVerification: PASS_VERIFY },
      },
    )
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(WorktreeError);
    expect((err as WorktreeError).kind).toBe('provisioning_failed');
    expect(String((err as Error).message)).toMatch(/provisionActive|git add -A/i);
    // Refused BEFORE any side effect — no worktree was created, nothing was staged.
    expect(wt.handleFor(asg)).toBeUndefined();
  });

  it("a MATCHING override (provisionActive=false under provision='none') is accepted", async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'work\n' }],
      turns: [REPORTING_TURN],
      provision: 'none', // the operator owns node_modules → provisioning INACTIVE
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: assignmentId('asg_f7_override_ok'),
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext(),
        options: { provisionActive: false, runVerification: PASS_VERIFY }, // matches 'none' → accepted
      },
    );
    expect(result.committed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// F7 round-4 #3: the implementor commit UNSTAGES an already-staged node_modules —
// the exclusion pathspec (`git add -A -- . :(exclude)node_modules`) prevents ADDING
// it but does not remove an index entry a prior `git add` already placed.
// ---------------------------------------------------------------------------
describe('ImplementorFlow — F7 round-4 #3 a pre-staged node_modules is unstaged before the commit', () => {
  it('an already-STAGED node_modules never enters the implementor commit', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [
        { relPath: 'feature.txt', content: 'work\n' },
        {
          relPath: 'package.json',
          content: JSON.stringify({ name: 'x', version: '1.0.0', dependencies: { 'left-pad': '1.0.0' } }),
        },
        { relPath: 'node_modules/.bin/tsc', content: '#!/bin/sh\nexit 0\n' }, // provisioned-toolchain dirt
      ],
      turns: [REPORTING_TURN],
      stageAfterWrite: true, // the "implementor" runs `git add -A`, STAGING node_modules
    });
    // ROUND 10: IGNORE node_modules so the planted tree is the ENGINE's.
    await r.writeFile('.gitignore', 'node_modules/\n');
    await r.commitAll('ignore node_modules');
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: assignmentId('asg_prestage_impl'),
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext(),
        options: { runVerification: PASS_VERIFY },
      },
    );

    // The work IS committed, and the pre-staged ENGINE tree is NOT in it.
    // ROUND 10 (Regression 4): the fixture now IGNORES node_modules, which is what
    // makes the tree the engine's — force-adding an ignored tree must not launder
    // it past the guard (that is the round-4 #3 invariant). An UNIGNORED, unmarked
    // node_modules would now be user content and stay.
    expect(result.committed).toBe(true);
    const committed = (
      await runGit(['diff', '--name-only', `${String(result.baseSha)}..HEAD`], result.worktreePath)
    ).stdout;
    expect(committed).toContain('feature.txt');
    expect(committed.split('\n').some((p) => p.startsWith('node_modules'))).toBe(false); // pre-staged but excluded
  });
});

// ---------------------------------------------------------------------------
// F10: the post-turn commit with a git-IGNORED node_modules on disk — the exact
// F7-provisioned production shape. Every existing node_modules test above uses an
// UNIGNORED/tracked tree, which is why none of them caught the git 2.55
// exclude-pathspec regression that killed run_756ce21b's resume.
// ---------------------------------------------------------------------------
describe('ImplementorFlow — F10 commit with a provisioned (git-ignored) node_modules present', () => {
  it('commits the work when an IGNORED node_modules exists in the worktree', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [
        { relPath: 'feature.txt', content: 'the real work\n' },
        // What F7 provisioning leaves in the worktree before the commit.
        { relPath: 'node_modules/.bin/tsc', content: '#!/bin/sh\nexit 0\n' },
        { relPath: 'node_modules/left-pad/index.js', content: 'module.exports = () => {};\n' },
      ],
      turns: [REPORTING_TURN],
    });
    // The repo git-ignores node_modules — the normal, correct target-repo shape.
    await r.writeFile('.gitignore', 'node_modules/\n');
    await r.commitAll('ignore node_modules');
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });

    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: assignmentId('asg_ignored_nm_commit'),
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext(),
        options: { runVerification: PASS_VERIFY },
      },
    );

    expect(result.committed).toBe(true);
    expect(result.changedFiles).toEqual(['feature.txt']);
    const committed = (
      await runGit(['diff', '--name-only', `${String(result.baseSha)}..HEAD`], result.worktreePath)
    ).stdout;
    expect(committed.split('\n').some((p) => p.includes('node_modules'))).toBe(false);
    // ...and it is in NO commit reachable from HEAD, not merely absent from the delta.
    const tree = (await runGit(['ls-tree', '-r', '--name-only', 'HEAD'], result.worktreePath)).stdout;
    expect(tree.split('\n').some((p) => p.includes('node_modules'))).toBe(false);
    // (What happens to the tree ON DISK afterwards is F7's business: this fixture
    // repo declares no dependencies, so provisioning legitimately removes the stale
    // toolchain — covered by provision.test.ts, not asserted here.)

    await wt.removeWorktree(assignmentId('asg_ignored_nm_commit'));
  });
});

// ---------------------------------------------------------------------------
// F7 round-2 #6: a provisioning failure must NOT mask the deliverable verdict.
// A provisioning failure is adjudicated on the deliverable ALONE — an abnormal /
// no-commit round stays `no_deliverable` (so `runRole` persists that durable stage
// and a resume RE-DRIVES the implementor rather than skipping to verify — the
// resume re-drive itself is proven in vertical-slice.test.ts
// "restart/resume does NOT bypass the gate ... re-drives the IMPLEMENTOR"); a good
// committed deliverable stays `completed` and the loop still HALTS on the returned
// `result.provisioningFailed` with the terminal provisioning_failed outcome.
// ---------------------------------------------------------------------------
describe('adjudicateImplementorDeliverable — F7 round-2 #6 provisioning-failure does not mask the verdict', () => {
  const HEAD = gitSha('a'.repeat(40));
  function result(overrides: Partial<ImplementorResult>): ImplementorResult {
    return {
      stopReason: 'end_turn',
      committed: false,
      commitSha: undefined,
      changedFiles: [],
      diff: '',
      postVerificationDirty: false,
      // Every case here has a provisioning failure — the point is that it no longer
      // overrides the deliverable adjudication.
      provisioningFailed: {
        kind: 'provisioning_failed',
        repoRoot: '/repo',
        worktreePath: '/wt',
        detail: 'node_modules is NOT git-ignored',
      },
      ...overrides,
    } as unknown as ImplementorResult;
  }

  it('a round>1 with NO new commit + provisioningFailed is `no_deliverable` (NOT masked as completed → resume re-drives)', () => {
    expect(adjudicateImplementorDeliverable(result({ committed: false }), 2, HEAD)).toBe('no_deliverable');
  });

  it('an abnormal stop + provisioningFailed is `no_deliverable` (the abnormal verdict wins)', () => {
    expect(adjudicateImplementorDeliverable(result({ stopReason: 'refusal' }), 1, HEAD)).toBe('no_deliverable');
  });

  it('a GOOD committed deliverable + provisioningFailed stays `completed` (the loop still surfaces provisioning_failed)', () => {
    expect(adjudicateImplementorDeliverable(result({ committed: true, commitSha: HEAD }), 1, HEAD)).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// F8 (C) — the `pre_verify_handoff` checkpoint at the commit boundary.
//
// Cadence checkpoints fire at PROMPT-TURN boundaries, so every one taken during
// an implementor round records the PRE-COMMIT head (the service captures live
// HEAD). The round then commits AFTER its turn loop, opening a window in which a
// crash leaves a committed HEAD that no checkpoint has ever seen — which §16.3
// read as tamper (`refuse_resume`). PLAN §12.2 mandates a `pre_verify_handoff`
// checkpoint at exactly this boundary; the reason existed in the vocabulary
// (`state.ts`, `cadence.ts`) with NO writer in production code.
// ---------------------------------------------------------------------------
describe.each(DRIVER_KINDS)('ImplementorFlow — F8 (C) pre_verify_handoff checkpoint (§12.2) (%s)', (driver) => {
  /** Every `checkpoint.recorded` payload for the run, in log order. */
  function checkpointsOf(runId: ReturnType<typeof createRunFixture>['runId']): Array<{
    readonly reason: string;
    readonly artifactHash: ArtifactHash;
  }> {
    return dbHandle!.db.events
      .listByRun(runId)
      .filter((e) => e.type === 'checkpoint.recorded')
      .map((e) => e.payload as { reason: string; artifactHash: ArtifactHash });
  }

  it('writes exactly ONE pre_verify_handoff checkpoint carrying the COMMITTED head', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      driver,
      writes: [{ relPath: 'feature.txt', content: 'the new feature\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_impl_handoff_checkpoint');

    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext(),
        options: { runVerification: PASS_VERIFY },
      },
    );
    expect(result.committed).toBe(true);

    const handoffs = checkpointsOf(runId).filter((p) => p.reason === 'pre_verify_handoff');
    expect(handoffs).toHaveLength(1);

    // The checkpoint carries the round's COMMITTED head — the whole point.
    const content = service.getCheckpointContent(handoffs[0]!.artifactHash);
    expect(content).toBeDefined();
    expect(String(content!.worktree.headSha)).toBe(String(result.commitSha));
    expect(content!.worktree.statusPorcelain).toBe(''); // committed tree, nothing outstanding
    // Honest §12.2 bookkeeping: a completed commit interrupts nothing.
    expect(content!.incompleteOperation).toBeUndefined();

    await wt.removeWorktree(asg);
  });

  // ---------------------------------------------------------------------------
  // ROUND 8 (Blocker 1a) — codex's exact path, deterministic rather than racy:
  //   1. a round-ONE no-op (the agent writes nothing, so the tree is clean);
  //   2. the receipt and the diff are captured BEFORE verification runs;
  //   3. a declared verification command CREATES AND COMMITS code;
  //   4. the tree is clean again, so the no-commit adjudication saw empty
  //      changedFiles/diff/postVerificationDirty and completed the round;
  //   5. the command-created commit became both `lastImplementationCommit` and
  //      the verifier's binding — disagreeing with the receipt.
  // ---------------------------------------------------------------------------
  it('BLOCKER-1: a verification command that COMMITS is a hard error, never a silent rebinding', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      driver,
      writes: [], // round-one no-op: the agent changes nothing
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_impl_verify_commits');

    // A declared verification command that creates a file AND commits it, then
    // leaves the tree clean — exactly the shape that used to slip through.
    const committingVerify: VerificationRunner = async (command, cwd) => {
      fs.writeFileSync(path.join(cwd, 'made-by-verification.ts'), 'export const x = 1;\n');
      execFileSync('git', ['add', '-A'], { cwd });
      execFileSync('git', ['commit', '--no-verify', '-m', 'committed by a verification command'], {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'verify',
          GIT_AUTHOR_EMAIL: 'verify@harness.invalid',
          GIT_COMMITTER_NAME: 'verify',
          GIT_COMMITTER_EMAIL: 'verify@harness.invalid',
        },
      });
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };

    const thrown: unknown = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await r.headSha()),
        context: baseContext({ verificationCommands: ['make-a-commit'] }),
        options: { runVerification: committingVerify },
      },
    ).catch((error: unknown) => error);

    // The round is REFUSED rather than completing with a rebound head.
    expect(thrown).toBeInstanceOf(NoDeliverableError);

    // The receipt still names the pre-verification head, and the worktree HEAD is
    // the command's commit — the disagreement the adjudication caught.
    const receipt = service.resolveRoundReceiptHead(runId, 1, asg);
    expect(receipt).toBeDefined();
    const handle = wt.handleFor(asg)!;
    const head = await runGit(['rev-parse', 'HEAD'], handle.worktreePath);
    expect(head.stdout.trim()).not.toBe(String(receipt));

    await wt.removeWorktree(asg);
  });

  it('BLOCKER-2: a round whose RECEIPT cannot be recorded FAILS rather than continuing unreceipted', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      driver,
      writes: [{ relPath: 'feature.txt', content: 'the new feature\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_impl_receipt_fatal');
    // The artifact store REJECTS the receipt write the way §12.1 quota admission
    // does — an `Err`, not a throw, which is the subtler of the two branches
    // (`#writeStopCheckpoint` returns no event and the round must still fail).
    const artifacts = dbHandle!.db.artifacts;
    const realWrite = artifacts.write.bind(artifacts);
    let failReceipt = true;
    (artifacts as unknown as { write: typeof artifacts.write }).write = ((
      input: Parameters<typeof artifacts.write>[0],
    ) => {
      if (!failReceipt) return realWrite(input);
      return err({
        attemptedHash: artifactHash('a'.repeat(64)),
        attemptedSizeBytes: 1,
        scope: 'per_run' as const,
        limitBytes: 0,
        currentUsageBytes: 0,
        occurredAt: dbHandle!.db.clock.nowIso(),
      });
    }) as typeof artifacts.write;

    try {
      const thrown: unknown = await runImplementor(
        { service, worktrees: wt },
        {
          runId,
          assignmentId: asg,
          implementor: CODEX_IMPLEMENTOR,
          baseCommit: gitSha(await r.headSha()),
          context: baseContext(),
          options: { runVerification: PASS_VERIFY },
        },
      ).catch((error: unknown) => error);

      expect(thrown).toBeInstanceOf(Error);
      expect(String(thrown)).toMatch(/receipt could not be recorded/i);
      // The COMMIT is still durable — nothing was rolled back, only auto-resume
      // is withheld until the operator resolves the store failure.
      const handle = wt.handleFor(asg)!;
      const committed = (await runGit(['log', '--format=%s', '-1'], handle.worktreePath)).stdout;
      expect(committed.trim().length).toBeGreaterThan(0);
      // ...and no receipt exists for the round, so resume cannot adopt on topology.
      expect(service.resolveRoundReceiptHead(runId, 1, asg)).toBeUndefined();
    } finally {
      failReceipt = false;
      (artifacts as unknown as { write: typeof artifacts.write }).write = realWrite;
    }

    await wt.removeWorktree(asg);
  });

  it('a round that commits NOTHING still checkpoints the handoff honestly (HEAD unchanged)', async () => {
    const { service, worktrees: wt, repo: r } = await setup({ driver, writes: [], turns: [REPORTING_TURN] });
    const base = await r.headSha();
    const { runId } = createRunFixture(service, { goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_impl_handoff_empty');

    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(base),
        context: baseContext(),
        options: { runVerification: PASS_VERIFY },
      },
    );
    expect(result.committed).toBe(false);

    const handoffs = checkpointsOf(runId).filter((p) => p.reason === 'pre_verify_handoff');
    expect(handoffs).toHaveLength(1);
    expect(String(service.getCheckpointContent(handoffs[0]!.artifactHash)!.worktree.headSha)).toBe(base);

    await wt.removeWorktree(asg);
  });
});
