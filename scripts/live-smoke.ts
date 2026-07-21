/**
 * Live acceptance smoke (PLAN §20 P3) — the committed, repeatable entrypoint
 * referenced by `package.json` `smoke:live` and `smoke:live:chat`. It drives
 * the SHIPPED `harness` CLI end to end as the user would, each command a
 * SEPARATE process over one shared `HARNESS_HOME` store:
 *
 *   start  →  approve (--test-approve, HARNESS_TEST_MODE=1)  →  run  →  status
 *
 * against a FRESH temp git repo, using the production `defaultRoleAdapterFactory`
 * (REAL native Claude subscription/Codex ACP/Grok ACP/OpenCode ACP spawns + existing logins — H-1 isolation
 * holds, no user `CODEX_HOME` is forwarded). This exercises the exact D-1 wiring the shipped CLI
 * now carries: `start` drives the coordinator flow to `awaiting_approval`, and
 * `run` drives implement→verify→merge-readiness.
 *
 * `--chat` adds the complete Agent Room path:
 *   - starts a REAL isolated localhost Agent Room server;
 *   - waits until the REAL coordinator publishes its opening position;
 *   - posts an adversarial HUMAN review through Agent Room's viewer API;
 *   - proves the room closes with a transcript and the validated spec reflects
 *     the reviewed task;
 *   - continues through real Implementor + independent Verifier sessions.
 *
 * It is a MANUAL/LIVE entrypoint — NOT a unit test (it spawns real providers, so
 * it never runs under vitest). It exits NON-ZERO on any failure and always
 * cleans up (temp repo + worktrees + HARNESS_HOME + isolated Agent Room state
 * removed; every CLI child is awaited and the room server is stopped, so no
 * orphan processes are left behind).
 *
 * Usage:
 *   npm run smoke:live
 *   npm run smoke:live:chat
 *
 * Environment overrides (packed harness:model[:effort] tokens):
 *   HARNESS_SMOKE_COORDINATOR, HARNESS_SMOKE_IMPLEMENTOR, HARNESS_SMOKE_VERIFIER
 *   AGENT_ROOM_CLI (required for --chat when not installed under ~/.codex)
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRoleProfile } from '../src/cli/profile.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
const CLI_ENTRY = path.join(REPO_ROOT, 'src', 'cli', 'index.ts');

const GOAL =
  'Implement missionStatus(tasks) in src/mission-status.mjs. It must accept an array of non-empty strings; entries prefixed with "done:" are completed. Return exactly { total, completed, pending, label }, where label is "ready" when pending is 0 and "in-progress" otherwise. Reject non-array input or blank/non-string entries with TypeError containing "non-empty strings". Do not modify package.json or test/. Add no dependencies. Make npm test pass.';
const COORDINATOR = process.env.HARNESS_SMOKE_COORDINATOR ?? 'claude:opus:low';
const IMPLEMENTOR = process.env.HARNESS_SMOKE_IMPLEMENTOR ?? 'codex:gpt-5.6-terra';
const VERIFIER = process.env.HARNESS_SMOKE_VERIFIER ?? 'claude:opus:low';
const CHAT_ENABLED = process.argv.slice(2).includes('--chat');
const KEEP_ARTIFACTS = process.env.HARNESS_SMOKE_KEEP === '1';
const ROLE_PROFILES = {
  coordinator: COORDINATOR,
  implementor: IMPLEMENTOR,
  verifier: VERIFIER,
} as const;
type SmokeRole = keyof typeof ROLE_PROFILES;

/** Per-command wall-clock cap (real provider turns can take tens of seconds). */
const CLI_TIMEOUT_MS = 8 * 60 * 1000;
const ROOM_OPENING_TIMEOUT_MS = 90_000;
const ROOM_URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+\/rooms\/(AM-[A-HJ-NP-Z2-9]{4})/;

interface CliResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface RunHooks {
  readonly onStderr?: (chunk: string, child: ChildProcessWithoutNullStreams) => void;
}

/** Run a child process to completion, capturing output; never throws. */
function run(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  hooks: RunHooks = {},
): Promise<CliResult> {
  return new Promise<CliResult>((resolve) => {
    const child = spawn(bin, [...args], { env, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => {
      const chunk = d.toString('utf8');
      stderr += chunk;
      hooks.onStderr?.(chunk, child);
    });
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
  hooks: RunHooks = {},
): Promise<{ result: CliResult; json: Record<string, unknown> }> {
  const env: NodeJS.ProcessEnv = { ...process.env, HARNESS_HOME: home, ...extraEnv };
  // H-1: never forward a user CODEX_HOME into orchestrator spawns.
  delete env.CODEX_HOME;
  const result = await run(TSX_BIN, [CLI_ENTRY, ...args], env, workspace, hooks);
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

interface SpawnEvidenceView {
  readonly source?: unknown;
  readonly optionId?: unknown;
  readonly requested?: unknown;
  readonly effective?: unknown;
  readonly echoed?: unknown;
}

interface ModelStatusView {
  readonly effective?: unknown;
  readonly spawnEvidence?: SpawnEvidenceView;
}

interface ModelSpawnProofEntry {
  readonly requestedProfile: string;
  readonly requestedHarness: string;
  readonly requestedModel: string;
  readonly requestedEffort?: string;
  readonly effectiveModel: string;
  readonly providerEchoed: boolean;
  readonly pinOptionId: string;
  readonly source: 'durable child.spawned model pin';
}

/**
 * Turn the shipped `status --json` read-model into a human-auditable artifact.
 * A role is accepted only when it has durable `child.spawned` evidence whose
 * requested model matches the exact profile passed to this smoke. The
 * provider's effective echo (or honest absence of one) remains visible.
 */
async function writeModelSpawnProof(
  status: Record<string, unknown>,
  runId: string,
  workRoot: string,
): Promise<string> {
  const rawModels = status['models'];
  if (rawModels === null || typeof rawModels !== 'object' || Array.isArray(rawModels)) {
    fail('model spawn proof', 'status --json did not return a models object');
  }
  const models = rawModels as Record<string, ModelStatusView>;
  const roles = {} as Record<SmokeRole, ModelSpawnProofEntry>;

  for (const role of Object.keys(ROLE_PROFILES) as SmokeRole[]) {
    const requestedProfile = ROLE_PROFILES[role];
    const parsed = parseRoleProfile({ profile: requestedProfile });
    if (!parsed.ok) {
      fail('model spawn proof', `cannot parse ${role} profile '${requestedProfile}': ${parsed.error}`);
    }
    const evidence = models[role]?.spawnEvidence;
    if (
      evidence?.source !== 'child.spawned' ||
      typeof evidence.optionId !== 'string' ||
      typeof evidence.requested !== 'string' ||
      typeof evidence.effective !== 'string' ||
      typeof evidence.echoed !== 'boolean'
    ) {
      fail('model spawn proof', `${role} has no complete durable child.spawned model-pin evidence`);
    }
    if (evidence.requested !== parsed.value.model) {
      fail(
        'model spawn proof',
        `${role} requested '${parsed.value.model}' but child.spawned recorded '${evidence.requested}'`,
      );
    }
    roles[role] = {
      requestedProfile,
      requestedHarness: parsed.value.harness,
      requestedModel: parsed.value.model,
      ...(parsed.value.effort !== undefined ? { requestedEffort: parsed.value.effort } : {}),
      effectiveModel: evidence.effective,
      providerEchoed: evidence.echoed,
      pinOptionId: evidence.optionId,
      source: 'durable child.spawned model pin',
    };
  }

  const proofPath = path.join(workRoot, 'model-spawns.json');
  await writeFile(
    proofPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        runId,
        recordedAt: new Date().toISOString(),
        roles,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  process.stdout.write(`[smoke:live] model spawn proof written to ${proofPath}\n`);
  for (const role of Object.keys(ROLE_PROFILES) as SmokeRole[]) {
    const entry = roles[role];
    process.stdout.write(
      `[smoke:live] spawned ${role}: ${entry.requestedHarness}:${entry.effectiveModel}` +
        `${entry.requestedEffort !== undefined ? `:${entry.requestedEffort}` : ''}` +
        ` (child.spawned model pin; provider echoed=${String(entry.providerEchoed)})\n`,
    );
  }
  return proofPath;
}

interface AgentRoomMessage {
  readonly id: number;
  readonly sender: string;
  readonly content: string;
  readonly kind: string;
}

interface AgentRoomSnapshot {
  readonly code: string;
  readonly status: string;
  readonly summary?: string;
  readonly messages: readonly AgentRoomMessage[];
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  const res = await run('git', args, { ...process.env }, cwd);
  if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
}

async function capture(bin: string, args: readonly string[], cwd: string): Promise<string> {
  const result = await run(bin, args, { ...process.env }, cwd);
  if (result.code !== 0) throw new Error(`${bin} ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function unusedLocalPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not allocate an Agent Room test port'));
        return;
      }
      const { port } = address;
      server.close((error) => (error !== undefined ? reject(error) : resolve(port)));
    });
  });
}

function resolveAgentRoomCli(): string {
  const configured = process.env.AGENT_ROOM_CLI;
  if (configured !== undefined && configured.trim() !== '') return configured;
  return path.join(homedir(), '.codex', 'skills', 'agent-room', 'scripts', 'agent_room.mjs');
}

async function roomRequest(
  url: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, init);
  const value = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `Agent Room ${response.status}: ${
        typeof value['error'] === 'string' ? value['error'] : response.statusText
      }`,
    );
  }
  return value;
}

async function readRoom(viewerUrl: string): Promise<AgentRoomSnapshot> {
  return (await roomRequest(viewerUrl.replace('/rooms/', '/api/rooms/'))) as unknown as AgentRoomSnapshot;
}

/**
 * Behave like a real human reviewer: wait for the coordinator's opening
 * position, then challenge it through Agent Room's browser-viewer endpoint.
 */
async function participateInPlanning(viewerUrl: string): Promise<void> {
  const deadline = Date.now() + ROOM_OPENING_TIMEOUT_MS;
  let room: AgentRoomSnapshot | undefined;
  while (Date.now() < deadline) {
    try {
      room = await readRoom(viewerUrl);
      if (
        room.messages.some(
          (message) => message.kind === 'agent' && message.sender.toLowerCase() === 'coordinator',
        )
      ) {
        break;
      }
    } catch {
      // The detached Agent Room server may still be finishing startup.
    }
    await delay(250);
  }
  if (
    room === undefined ||
    !room.messages.some(
      (message) => message.kind === 'agent' && message.sender.toLowerCase() === 'coordinator',
    )
  ) {
    throw new Error('Coordinator did not publish an Agent Room opening before the live timeout');
  }

  const endpoint = viewerUrl.replace('/rooms/', '/api/rooms/') + '/viewer/messages';
  await roomRequest(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      content:
        '@Coordinator Live-smoke review: make the plan resistant to a superficial implementation. ' +
        'The final spec must preserve package.json and test/, require the exact object fields and labels from the goal, ' +
        'require TypeError for invalid entries, and use npm test as deterministic verification. ' +
        'Address this review, then synthesize the final host-valid spec.',
    }),
  });
  process.stdout.write(`[smoke:live:chat] adversarial human review posted to ${viewerUrl}\n`);
}

async function stopAgentRoom(
  cliPath: string,
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  const result = await run(process.execPath, [cliPath, 'stop'], env, cwd);
  if (result.code !== 0 && !result.stdout.includes('not running')) {
    process.stderr.write(
      `[smoke:live:chat] warning: Agent Room stop failed: ${result.stderr || result.stdout}\n`,
    );
  }
}

async function writeFixture(repo: string): Promise<void> {
  await writeFile(
    path.join(repo, 'package.json'),
    JSON.stringify(
      {
        name: 'mission-status-live-smoke',
        private: true,
        type: 'module',
        scripts: { test: 'node --test' },
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );
  await writeFile(
    path.join(repo, 'src', 'mission-status.mjs'),
    [
      'export function missionStatus(_tasks) {',
      "  throw new Error('TODO: implement missionStatus');",
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(
    path.join(repo, 'test', 'mission-status.test.mjs'),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { missionStatus } from '../src/mission-status.mjs';",
      '',
      "test('empty mission is ready', () => {",
      "  assert.deepEqual(missionStatus([]), { total: 0, completed: 0, pending: 0, label: 'ready' });",
      '});',
      '',
      "test('mixed mission reports exact progress', () => {",
      "  assert.deepEqual(missionStatus(['done:plan', 'build', 'done:verify']), {",
      "    total: 3, completed: 2, pending: 1, label: 'in-progress',",
      '  });',
      '});',
      '',
      "test('fully completed mission is ready', () => {",
      "  assert.deepEqual(missionStatus(['done:plan', 'done:build']), {",
      "    total: 2, completed: 2, pending: 0, label: 'ready',",
      '  });',
      '});',
      '',
      "test('invalid task entries are rejected', () => {",
      "  assert.throws(() => missionStatus('done:plan'), { name: 'TypeError', message: /non-empty strings/ });",
      "  assert.throws(() => missionStatus(['done:plan', '  ']), { name: 'TypeError', message: /non-empty strings/ });",
      '  assert.throws(() => missionStatus([42]), { name: \'TypeError\', message: /non-empty strings/ });',
      '});',
      '',
    ].join('\n'),
    'utf8',
  );
}

async function main(): Promise<void> {
  const workRoot = await mkdtemp(path.join(tmpdir(), 'harness-live-smoke-'));
  const home = path.join(workRoot, 'harness-home');
  const repo = path.join(workRoot, 'repo');
  const agentRoomHome = path.join(workRoot, 'agent-room-home');
  let agentRoomCli: string | undefined;
  let agentRoomEnv: NodeJS.ProcessEnv | undefined;

  try {
    // --- Fresh temp repo (worktrees land in a sibling under workRoot) ---------
    await git(['init', '--initial-branch=main', repo], workRoot);
    await git(['config', 'user.name', 'harness-live-smoke'], repo);
    await git(['config', 'user.email', 'smoke@harness-orchestration.localhost'], repo);
    await mkdir(path.join(repo, 'src'), { recursive: true });
    await mkdir(path.join(repo, 'test'), { recursive: true });
    await writeFixture(repo);
    await git(['add', '-A'], repo);
    await git(['commit', '-m', 'initial commit'], repo);

    const initialHead = (await capture('git', ['rev-parse', 'HEAD'], repo)).trim();
    const extraEnv: NodeJS.ProcessEnv = {};
    if (CHAT_ENABLED) {
      agentRoomCli = resolveAgentRoomCli();
      try {
        await access(agentRoomCli);
      } catch {
        fail(
          'chat preflight',
          `Agent Room is not installed at ${agentRoomCli}. Install https://github.com/steviebuilds/agent-room or set AGENT_ROOM_CLI.`,
        );
      }
      const port = await unusedLocalPort();
      agentRoomEnv = {
        ...process.env,
        AGENT_ROOM_CLI: agentRoomCli,
        AGENT_ROOM_HOME: agentRoomHome,
        AGENT_ROOM_HOST: '127.0.0.1',
        AGENT_ROOM_PORT: String(port),
      };
      Object.assign(extraEnv, {
        AGENT_ROOM_CLI: agentRoomCli,
        AGENT_ROOM_HOME: agentRoomHome,
        AGENT_ROOM_PORT: String(port),
      });
    }

    process.stdout.write(
      `[smoke:live${CHAT_ENABLED ? ':chat' : ''}] repo=${repo}\n` +
        `[smoke:live${CHAT_ENABLED ? ':chat' : ''}] HARNESS_HOME=${home}\n` +
        `[smoke:live${CHAT_ENABLED ? ':chat' : ''}] profiles: coordinator=${COORDINATOR}, implementor=${IMPLEMENTOR}, verifier=${VERIFIER}\n`,
    );

    // --- start: coordinator drafts a spec → awaiting_approval -----------------
    process.stdout.write(`[smoke:live${CHAT_ENABLED ? ':chat' : ''}] start${CHAT_ENABLED ? ' --enable-chat' : ''} …\n`);
    let roomBuffer = '';
    let roomViewerUrl: string | undefined;
    let participation: Promise<void> | undefined;
    let participationError: unknown;
    const started = await harness(
      [
        'start',
        '--workspace',
        repo,
        '--goal',
        GOAL,
        '--coordinator',
        COORDINATOR,
        ...(CHAT_ENABLED ? ['--enable-chat'] : []),
        '--json',
      ],
      home,
      repo,
      extraEnv,
      CHAT_ENABLED
        ? {
            onStderr: (chunk, child) => {
              roomBuffer = (roomBuffer + chunk).slice(-64 * 1024);
              const match = roomBuffer.match(ROOM_URL_PATTERN);
              if (match?.[0] === undefined || participation !== undefined) return;
              roomViewerUrl = match[0];
              participation = participateInPlanning(roomViewerUrl).catch((error: unknown) => {
                participationError = error;
                child.kill('SIGKILL');
              });
            },
          }
        : {},
    );
    await participation;
    if (CHAT_ENABLED && participation === undefined) {
      fail('planning chat', `no Agent Room invitation appeared: ${started.result.stderr}`);
    }
    if (participationError !== undefined) {
      fail(
        'planning chat',
        participationError instanceof Error ? participationError.message : String(participationError),
      );
    }
    if (started.result.code !== 0) fail('start', `exit ${started.result.code}: ${started.result.stderr || started.result.stdout}`);
    const runId = started.json['runId'];
    const spec = started.json['spec'] as {
      specVersionId?: string;
      specHash?: string;
      document?: string;
      criteria?: readonly unknown[];
    } | undefined;
    if (typeof runId !== 'string') fail('start', 'no runId in output');
    if (started.json['phase'] !== 'awaiting_approval') {
      fail('start', `expected phase awaiting_approval, got '${String(started.json['phase'])}'`);
    }
    if (spec?.specVersionId === undefined || spec.specHash === undefined) {
      fail('start', 'coordinator did not surface spec version id + hash');
    }
    if (typeof spec.document !== 'string' || !spec.document.includes('missionStatus')) {
      fail('start', 'validated spec did not retain the missionStatus task');
    }
    if (!Array.isArray(spec.criteria) || spec.criteria.length === 0) {
      fail('start', 'validated spec has no acceptance criteria');
    }
    if (CHAT_ENABLED) {
      const planningChat = started.json['planningChat'] as
        | { readonly roomCode?: unknown; readonly viewerUrl?: unknown }
        | undefined;
      if (
        planningChat?.roomCode === undefined ||
        typeof planningChat.viewerUrl !== 'string' ||
        planningChat.viewerUrl !== roomViewerUrl
      ) {
        fail('planning chat', 'start output did not bind the completed Agent Room');
      }
      const room = await readRoom(planningChat.viewerUrl);
      const coordinatorTurns = room.messages.filter(
        (message) => message.kind === 'agent' && message.sender.toLowerCase() === 'coordinator',
      );
      const humanReviews = room.messages.filter((message) => message.kind === 'human');
      if (room.status !== 'closed' || coordinatorTurns.length < 2 || humanReviews.length < 1) {
        fail(
          'planning chat transcript',
          `expected closed room with >=2 coordinator turns and >=1 human review; got status=${room.status}, coordinator=${coordinatorTurns.length}, human=${humanReviews.length}`,
        );
      }
      if (typeof room.summary !== 'string' || !room.summary.includes('host-validated specification')) {
        fail('planning chat transcript', 'room summary did not record validated synthesis');
      }
      process.stdout.write(
        `[smoke:live:chat] room ${room.code} closed with ${coordinatorTurns.length} coordinator turns and ${humanReviews.length} human review(s)\n`,
      );
    }
    process.stdout.write(`[smoke:live] drafted spec ${spec.specVersionId} (hash ${spec.specHash})\n`);

    // --- approve: explicit-human gate via the automated seam ------------------
    process.stdout.write('[smoke:live] approve --test-approve …\n');
    const approved = await harness(
      ['approve', runId, '--spec-version', spec.specVersionId, '--spec-hash', spec.specHash, '--test-approve', '--json'],
      home,
      repo,
      { ...extraEnv, HARNESS_TEST_MODE: '1' },
    );
    if (approved.result.code !== 0) fail('approve', `exit ${approved.result.code}: ${approved.result.stderr || approved.result.stdout}`);
    if (approved.json['phase'] !== 'approved') fail('approve', `expected phase approved, got '${String(approved.json['phase'])}'`);

    // --- run: implement → verify → §16 merge-readiness ------------------------
    process.stdout.write('[smoke:live] run (implement → verify) …\n');
    const ran = await harness(
      ['run', runId, '--implementor', IMPLEMENTOR, '--verifier', VERIFIER, '--json'],
      home,
      repo,
      extraEnv,
    );
    process.stdout.write(`[smoke:live] run outcome=${String(ran.json['outcome'])} phase=${String(ran.json['phase'])}\n`);
    if (ran.result.code !== 0) fail('run', `exit ${ran.result.code}: ${ran.result.stderr || ran.result.stdout}`);
    if (ran.json['outcome'] !== 'merge_ready') {
      fail('run', `expected outcome merge_ready, got '${String(ran.json['outcome'])}'`);
    }
    const worktreePath = ran.json['worktreePath'];
    const implementationCommit = ran.json['implementationCommit'];
    const readiness = ran.json['mergeReadiness'] as
      | { readonly ready?: unknown; readonly requiredTestsPassed?: unknown }
      | undefined;
    if (typeof worktreePath !== 'string' || typeof implementationCommit !== 'string') {
      fail('run', 'missing implementation worktree/commit in output');
    }
    if (readiness?.ready !== true || readiness.requiredTestsPassed !== true) {
      fail('run', 'independent verification did not produce ready=true with requiredTestsPassed=true');
    }
    const changedFiles = (await capture(
      'git',
      ['diff', '--name-only', `${initialHead}..${implementationCommit}`],
      worktreePath,
    ))
      .trim()
      .split('\n')
      .filter(Boolean);
    if (
      changedFiles.length !== 1 ||
      changedFiles[0] !== 'src/mission-status.mjs'
    ) {
      fail('implementation scope', `expected only src/mission-status.mjs to change, got ${changedFiles.join(', ')}`);
    }
    const liveTests = await run('npm', ['test'], { ...process.env }, worktreePath);
    if (liveTests.code !== 0) fail('post-run behavior', liveTests.stderr || liveTests.stdout);
    const implementedSource = await readFile(
      path.join(worktreePath, 'src', 'mission-status.mjs'),
      'utf8',
    );
    if (implementedSource.includes('TODO: implement missionStatus')) {
      fail('post-run behavior', 'implementation worktree still contains the TODO stub');
    }
    const primaryHead = (await capture('git', ['rev-parse', 'HEAD'], repo)).trim();
    const primaryStatus = (await capture('git', ['status', '--porcelain'], repo)).trim();
    if (primaryHead !== initialHead || primaryStatus !== '') {
      fail('worktree isolation', 'primary checkout changed during the live run');
    }

    // --- status: confirm the terminal state -----------------------------------
    const status = await harness(['status', runId, '--json'], home, repo, extraEnv);
    if (status.result.code !== 0) fail('status', `exit ${status.result.code}: ${status.result.stderr}`);
    if (status.json['phase'] !== 'merge_ready') fail('status', `expected phase merge_ready, got '${String(status.json['phase'])}'`);
    if (CHAT_ENABLED && status.json['planningChatEnabled'] !== true) {
      fail('status', 'planningChatEnabled was not persisted');
    }
    await writeModelSpawnProof(status.json, runId, workRoot);

    process.stdout.write(
      `\n[smoke:live${CHAT_ENABLED ? ':chat' : ''}] PASSED — ` +
        `${CHAT_ENABLED ? 'Agent Room → reviewed planning → ' : ''}` +
        'approval → real implementation → independent verification → merge_ready; ' +
        'host re-ran npm test and confirmed worktree isolation.\n',
    );
  } finally {
    if (agentRoomCli !== undefined && agentRoomEnv !== undefined) {
      await stopAgentRoom(agentRoomCli, agentRoomEnv, workRoot).catch(() => undefined);
    }
    if (KEEP_ARTIFACTS) {
      process.stdout.write(`[smoke:live] preserving artifacts at ${workRoot}\n`);
    } else {
      await rm(workRoot, { recursive: true, force: true }).catch(() => undefined);
    }
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
