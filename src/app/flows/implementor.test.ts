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
import { assignmentId, criterionId, specHash } from '../../domain/ids.js';
import { DeterministicIdFactory } from '../../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../../persistence/test-support.js';
import { GitWorktreeManager, type WorktreeHandle } from '../../worktree/index.js';
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
  OrchestrationService,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from '../service.js';
import type { RoleSession } from '../role-runner.js';
import {
  ImplementorFlow,
  VerificationRunnerEnvError,
  defaultVerificationRunner,
  runImplementor,
  type ImplementorContext,
  type VerificationRunner,
  type RunImplementorInput,
} from './implementor.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------
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
}): Promise<{
  service: OrchestrationService;
  worktrees: GitWorktreeManager;
  repo: TempGitRepo;
  created: CreatedFake[];
}> {
  repo = await makeTempGitRepo();
  dbHandle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const db = dbHandle.db;
  worktrees = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: db.clock });
  const { factory, created } = makeWritingFactory({
    writes: opts.writes,
    ...(opts.turns !== undefined ? { turns: opts.turns } : {}),
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
    const { runId } = service.createRun({
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
      context: baseContext(),
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

  it('captures a FAILING verification command without hiding it, and still commits the work', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'partial.txt', content: 'work in progress\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
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
    const { runId } = service.createRun({ goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
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
        context: baseContext(),
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
    const { runId } = service.createRun({ goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_impl_empty');

    const before = await snapshotPrimaryCheckout(r.dir);
    const result = await runImplementor(
      { service, worktrees: wt },
      {
        runId,
        assignmentId: asg,
        implementor: CODEX_IMPLEMENTOR,
        context: baseContext(),
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
    const { runId } = service.createRun({ goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const asg = assignmentId('asg_impl_lease');

    await runImplementor(
      { service, worktrees: wt },
      { runId, assignmentId: asg, implementor: CODEX_IMPLEMENTOR, context: baseContext(), options: { runVerification: PASS_VERIFY } },
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

describe('W3-1 — primary-checkout mutation guard', () => {
  it('an out-of-worktree write into the PRIMARY checkout is a typed violation and fails verification honestly', async () => {
    const { service, worktrees: wt, repo: r } = await setup({
      writes: [{ relPath: 'feature.txt', content: 'legitimate in-worktree work\n' }],
      turns: [REPORTING_TURN],
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
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
        context: baseContext(),
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
    const { runId } = service.createRun({ goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
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
        context: baseContext(),
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
    const { runId } = service.createRun({ goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
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
      { runId, assignmentId: asg, implementor: CODEX_IMPLEMENTOR, context: baseContext(), options: { runVerification: plantingHook } },
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
    const { runId } = service.createRun({ goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const mutatingConfig: VerificationRunner = async (command) => {
      // `git config core.pager <payload>` writes .git/config — HEAD + porcelain
      // are untouched. Uses git plumbing (argv, no shell) into the primary.
      execFileSync('git', ['config', 'core.pager', 'evil-payload'], { cwd: r.dir });
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };
    const asg = assignmentId('asg_impl_w3_config');

    const result = await runImplementor(
      { service, worktrees: wt },
      { runId, assignmentId: asg, implementor: CODEX_IMPLEMENTOR, context: baseContext(), options: { runVerification: mutatingConfig } },
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
    const { runId } = service.createRun({ goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
    const writingIgnored: VerificationRunner = async (command) => {
      fs.writeFileSync(path.join(r.dir, 'exfiltrated.log'), 'gitignored payload\n');
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };
    const asg = assignmentId('asg_impl_w3_ignored');

    const result = await runImplementor(
      { service, worktrees: wt },
      { runId, assignmentId: asg, implementor: CODEX_IMPLEMENTOR, context: baseContext(), options: { runVerification: writingIgnored } },
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
    const { runId } = service.createRun({ goal: 'g', workspacePath: r.dir, coordinator: CLAUDE_LOW });
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
      { runId, assignmentId: asg, implementor: CODEX_IMPLEMENTOR, context: baseContext(), options: { runVerification: plantingViaWorktree } },
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
