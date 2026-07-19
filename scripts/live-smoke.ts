/**
 * Live acceptance smoke (PLAN §20 P3) — the committed, repeatable entrypoint
 * referenced by `package.json` `smoke:live`. It drives the SHIPPED `harness` CLI
 * end to end as the user would, each command a SEPARATE process over one shared
 * `HARNESS_HOME` store:
 *
 *   start  →  approve (--test-approve, HARNESS_TEST_MODE=1)  →  run  →  status
 *
 * against a FRESH temp git repo, using the production `defaultRoleAdapterFactory`
 * (REAL Claude/Codex ACP spawns + existing logins — H-1 isolation holds, no user
 * `CODEX_HOME` is forwarded). This exercises the exact D-1 wiring the shipped CLI
 * now carries: `start` drives the coordinator flow to `awaiting_approval`, and
 * `run` drives implement→verify→merge-readiness.
 *
 * It is a MANUAL/LIVE entrypoint — NOT a unit test (it spawns real providers, so
 * it never runs under vitest). It exits NON-ZERO on any failure and always
 * cleans up (temp repo + worktrees + HARNESS_HOME removed; every CLI child is
 * awaited to completion, so no orphan processes are left behind).
 *
 * Usage:  npm run smoke:live      (requires working Claude + Codex logins)
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const GOAL =
  'Create a file greeting.txt in the repo root containing exactly the line: Hello from the orchestrator';
const COORDINATOR = ['--coordinator', 'claude', '--model', 'opus', '--effort', 'low'];
const IMPLEMENTOR = 'codex:gpt-5.6-terra';
const VERIFIER = 'claude:opus:low';

/** Per-command wall-clock cap (real provider turns can take tens of seconds). */
const CLI_TIMEOUT_MS = 8 * 60 * 1000;

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Run a child process to completion, capturing output; never throws. */
function run(bin: string, args: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    const child = spawn(bin, [...args], { env, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, CLI_TIMEOUT_MS);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}\nspawn error: ${String(error)}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Invoke the shipped harness CLI (a fresh process), returning parsed --json. */
async function harness(
  args: readonly string[],
  home: string,
  workspace: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ result: CliResult; json: Record<string, unknown> }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_HOME: home, ...extraEnv };
  // H-1: never forward a user CODEX_HOME into orchestrator spawns.
  delete env.CODEX_HOME;
  const result = await run(TSX_BIN, [CLI_ENTRY, ...args], env, workspace);
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    /* non-JSON (or empty) output — caller inspects result.code/stderr */
  }
  return { result, json };
}

function fail(step: string, detail: string): never {
  process.stderr.write(`\n[smoke:live] FAILED at ${step}: ${detail}\n`);
  throw new SmokeFailure(`${step}: ${detail}`);
}

class SmokeFailure extends Error {}

async function git(args: readonly string[], cwd: string): Promise<void> {
  const res = await run('git', args, { ...process.env }, cwd);
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
}

async function main(): Promise<void> {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'harness-live-smoke-'));
  const home = path.join(workRoot, 'harness-home');
  const repo = path.join(workRoot, 'repo');

  try {
    // --- Fresh temp repo (worktrees land in a sibling under workRoot) ---------
    await git(['init', '--initial-branch=main', repo], workRoot);
    await git(['config', 'user.name', 'harness-live-smoke'], repo);
    await git(['config', 'user.email', 'smoke@harness-orchestration.localhost'], repo);
    await writeFile(path.join(repo, 'README.md'), '# live smoke repo\n', 'utf8');
    await git(['add', '-A'], repo);
    await git(['commit', '-m', 'initial commit'], repo);

    process.stdout.write(`[smoke:live] repo=${repo}\n[smoke:live] HARNESS_HOME=${home}\n`);

    // --- start: coordinator drafts a spec → awaiting_approval -----------------
    process.stdout.write('[smoke:live] start …\n');
    const started = await harness(
      ['start', '--workspace', repo, '--goal', GOAL, ...COORDINATOR, '--json'],
      home,
      repo,
    );
    if (started.result.code !== 0) fail('start', `exit ${started.result.code}: ${started.result.stderr || started.result.stdout}`);
    const runId = started.json['runId'];
    const spec = started.json['spec'] as { specVersionId?: string; specHash?: string } | undefined;
    if (typeof runId !== 'string') fail('start', 'no runId in output');
    if (started.json['phase'] !== 'awaiting_approval') {
      fail('start', `expected phase awaiting_approval, got '${String(started.json['phase'])}'`);
    }
    if (spec?.specVersionId === undefined || spec.specHash === undefined) {
      fail('start', 'coordinator did not surface spec version id + hash');
    }
    process.stdout.write(`[smoke:live] drafted spec ${spec.specVersionId} (hash ${spec.specHash})\n`);

    // --- approve: explicit-human gate via the automated seam ------------------
    process.stdout.write('[smoke:live] approve --test-approve …\n');
    const approved = await harness(
      ['approve', runId, '--spec-version', spec.specVersionId, '--spec-hash', spec.specHash, '--test-approve', '--json'],
      home,
      repo,
      { HARNESS_TEST_MODE: '1' },
    );
    if (approved.result.code !== 0) fail('approve', `exit ${approved.result.code}: ${approved.result.stderr || approved.result.stdout}`);
    if (approved.json['phase'] !== 'approved') fail('approve', `expected phase approved, got '${String(approved.json['phase'])}'`);

    // --- run: implement → verify → §16 merge-readiness ------------------------
    process.stdout.write('[smoke:live] run (implement → verify) …\n');
    const ran = await harness(
      ['run', runId, '--implementor', IMPLEMENTOR, '--verifier', VERIFIER, '--json'],
      home,
      repo,
    );
    process.stdout.write(`[smoke:live] run outcome=${String(ran.json['outcome'])} phase=${String(ran.json['phase'])}\n`);
    if (ran.result.code !== 0) fail('run', `exit ${ran.result.code}: ${ran.result.stderr || ran.result.stdout}`);
    if (ran.json['outcome'] !== 'merge_ready') {
      fail('run', `expected outcome merge_ready, got '${String(ran.json['outcome'])}'`);
    }

    // --- status: confirm the terminal state -----------------------------------
    const status = await harness(['status', runId, '--json'], home, repo);
    if (status.result.code !== 0) fail('status', `exit ${status.result.code}: ${status.result.stderr}`);
    if (status.json['phase'] !== 'merge_ready') fail('status', `expected phase merge_ready, got '${String(status.json['phase'])}'`);

    process.stdout.write('\n[smoke:live] PASSED — shipped CLI drove start → approve → run → status to merge_ready.\n');
  } finally {
    await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (error) => {
    if (!(error instanceof SmokeFailure)) {
      process.stderr.write(`\n[smoke:live] ERROR: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    process.exitCode = 1;
  },
);
