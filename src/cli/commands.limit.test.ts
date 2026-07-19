/**
 * W2-5 CLI surface (spec docs/specs/hardening-p4a.md §W2-5; PLAN §13, §18) —
 * the shipped `executeCommand` handling of provider-limit pauses, against
 * in-process fake adapters + a REAL temp git repo + a MANUAL clock (the
 * schedule loop's timer is injected — no real sleeping):
 *
 *  - `run --no-wait` on a limit pause exits `EXIT_LIMIT_PAUSED` (3) with the
 *    honest limit block + exact resume instructions;
 *  - `run` (default policy `wait`) runs the schedule loop in-process: a
 *    structured retry_after elapses on the fake clock → T9 (mode
 *    `scheduled_probe`) → the round re-enters and completes to merge_ready;
 *  - `resume` = eligibility check + immediate re-entry; a superseded draft
 *    is a typed refusal (exit 1) WITHOUT clearing the suspension;
 *  - `resume --wait` = the probe schedule loop (fenced claims, T10 then T9);
 *  - `status --json` carries the limit block EXACTLY per spec — resumesAt is
 *    the word `unknown`, never an invented countdown;
 *  - startup reclaim: an unacknowledged pending re-entry (T9 landed, process
 *    died) is driven idempotently by the next `resume`;
 *  - a coordinator pause during `start` waits + re-enters + completes the
 *    draft to awaiting_approval (the ONE shared policy handler).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { artifactHash, specHash as toSpecHash, specVersionId as toSpecVersionId, type RunId } from '../domain/ids.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { ArtifactStore } from '../artifacts/store.js';
import { loadProfileFile, type Profile } from '../config/profile.js';
import {
  AdapterError,
  InProcessFakeAdapter,
  rateLimitErrorEnvelope,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
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
import {
  EXIT_LIMIT_PAUSED,
  executeCommand,
  type CliFlowDeps,
  type CommandDeps,
  type WaitScheduler,
} from './commands.js';

const GOAL = 'Add a --verbose flag to the CLI so debug lines print to stderr.';
const COORDINATOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const IMPLEMENTOR: RoleModelSpec = { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const PROFILE_PATH = fileURLToPath(new URL('../../profiles/coordinator.md', import.meta.url));
const T0 = '2026-07-18T00:00:00.000Z';

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
    assumptions: [],
    openQuestions: [],
    constraints: ['Touch only files under src/cli'],
    permissions: ['read and write within the assigned worktree'],
    nonGoals: [],
    tasks: [{ id: 'T1', description: 'Recognize --verbose in the arg parser', dependsOn: [] }],
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'The --verbose flag enables debug output',
        verificationCommands: ['echo check-ac1'],
        expectedEvidence: 'exits with code 0 and stderr contains the debug prefix',
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

const implementorTurn = (): InProcessTurnScript => ({
  updates: [{ kind: 'agent_message_chunk', text: 'implemented' }],
  result: { stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 40, source: 'adapter' } },
});

const verifierPassTurn = (): InProcessTurnScript => ({
  updates: [
    {
      kind: 'agent_message_chunk',
      text: JSON.stringify({
        criteria: [{ id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' }],
      }),
    },
  ],
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
  /** Per-adapter pin scripting (e.g. a probe whose setConfigOption fails). */
  readonly onSetConfigOption?: (input: SetConfigOptionInput) => SetConfigOptionResult;
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
        ...(script.onSetConfigOption !== undefined ? { onSetConfigOption: script.onSetConfigOption } : {}),
      });
      const orig = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (input) => {
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
  readonly clock: ManualClock;
  readonly deps: CommandDeps;
  readonly sleeps: number[];
}

/** A waiter that ADVANCES the manual clock instead of sleeping (W2-5 seam). */
function clockWaiter(clock: ManualClock, sleeps: number[]): WaitScheduler {
  return {
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advanceMs(ms);
    },
  };
}

async function setup(scripts: {
  readonly coordinator?: readonly AdapterScript[];
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}): Promise<Wired> {
  repo = await makeTempGitRepo('harness-cli-limit-');
  const clock = new ManualClock(T0);
  dbHandle = await openTestDatabase({ kind: 'better-sqlite3', file: true, clock });
  worktrees = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock });
  const ids = new DeterministicIdFactory();
  const flowIds = new DeterministicIdFactory();
  const service = new OrchestrationService({ db: dbHandle.db, ids, adapterFactory: makeFactory(scripts) });
  const store = new ArtifactStore({ rootDir: dbHandle.casRoot, clock, ids: flowIds });
  const profileResult = loadProfileFile(PROFILE_PATH);
  if (!profileResult.ok) throw new Error('coordinator profile failed to load');
  const profile: Profile = profileResult.value;
  const mgr = worktrees;
  const flows: CliFlowDeps = {
    ids,
    clock,
    buildCoordinatorRunner: ({ goal, revise }) =>
      new CoordinatorRunner({
        goal,
        profile,
        artifactStore: store,
        ids: flowIds,
        clock,
        ...(revise !== undefined ? { revise } : {}),
      }),
    openWorktrees: async () => mgr,
    evidence: fakeEvidence(),
    runVerification: PASS_VERIFY,
  };
  const sleeps: number[] = [];
  const deps: CommandDeps = { ids, flows, waiter: clockWaiter(clock, sleeps) };
  return { service, db: dbHandle.db, clock, deps, sleeps };
}

/** start → approve, returning the runId (coordinator adapter #1 consumed). */
async function startAndApprove(w: Wired): Promise<RunId> {
  const start = await executeCommand(
    w.service,
    w.db,
    { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
    {},
    w.deps,
  );
  expect(start.exitCode).toBe(0);
  const runId = start.json['runId'] as RunId;
  const spec = start.json['spec'] as { specVersionId: string; specHash: string };
  const approve = await executeCommand(
    w.service,
    w.db,
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
  return runId;
}

const RUN_CMD = (runId: RunId, noWait?: boolean) =>
  ({
    kind: 'run' as const,
    json: true,
    runId,
    implementor: IMPLEMENTOR,
    verifier: VERIFIER,
    ...(noWait === true ? { noWait: true } : {}),
  });

// ---------------------------------------------------------------------------
// run --no-wait → exit 3 with instructions; then resume re-enters
// ---------------------------------------------------------------------------
describe('run on a limit pause', () => {
  it('--no-wait exits EXIT_LIMIT_PAUSED with the honest limit block and resume instructions; a later resume completes the round', async () => {
    const w = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }, // round 1: limit mid-turn
        { writes: [{ relPath: 'src/f.ts', content: 'export const f = 1;\n' }], turns: [implementorTurn()] },
      ],
      verifier: [{ turns: [verifierPassTurn()] }],
    });
    const runId = await startAndApprove(w);

    const run = await executeCommand(w.service, w.db, RUN_CMD(runId, true), {}, w.deps);
    expect(run.exitCode).toBe(EXIT_LIMIT_PAUSED);
    expect(run.json).toMatchObject({ command: 'run', ok: false, outcome: 'paused_limit' });
    expect(run.json['limit']).toMatchObject({
      resumesAt: 'unknown',
      etaSource: 'unknown',
      policy: 'wait',
    });
    expect(run.text).toContain(`harness resume ${runId}`);
    expect(w.service.status(runId).suspension).toBe('paused_limit');
    expect(w.sleeps).toHaveLength(0); // --no-wait never entered the loop

    // `resume` = eligibility + immediate re-entry: the implementor round
    // re-drives and the loop completes to merge_ready.
    const resume = await executeCommand(w.service, w.db, { kind: 'resume', json: true, runId }, {}, w.deps);
    expect(resume.exitCode).toBe(0);
    expect(resume.json).toMatchObject({ command: 'resume', ok: true, outcome: 'merge_ready', phase: 'merge_ready' });
    expect(w.service.status(runId).phase).toBe('merge_ready');
    const types = w.db.events.listByRun(runId).map((e) => e.type);
    expect(types).toContain('resume.limit.requested');
    expect(types).toContain('resume_reentry.completed'); // acked when the round ran
    expect(w.service.status(runId).resumeReentryPending).toBeUndefined();
  });

  it('default policy WAITS in-process: a structured retry_after elapses on the injected clock → T9 (scheduled_probe) → re-entry → merge_ready', async () => {
    const RESUMES_AT = '2026-07-18T00:45:00.000Z';
    const w = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope({ resumesAt: RESUMES_AT }) }] },
        { writes: [{ relPath: 'src/f.ts', content: 'export const f = 1;\n' }], turns: [implementorTurn()] },
      ],
      verifier: [{ turns: [verifierPassTurn()] }],
    });
    const runId = await startAndApprove(w);

    const run = await executeCommand(w.service, w.db, RUN_CMD(runId), {}, w.deps);
    expect(run.exitCode).toBe(0);
    expect(run.json).toMatchObject({ command: 'run', ok: true, outcome: 'merge_ready' });
    // The loop slept exactly to the provider's own reset time — no probe
    // spawn, no claim; the resume is labeled scheduled (not manual).
    expect(w.sleeps.length).toBeGreaterThan(0);
    const log = w.db.events.listByRun(runId);
    expect(log.some((e) => e.type === 'limit.probe.claimed')).toBe(false);
    const t9 = log.find((e) => e.type === 'resume.limit.requested');
    expect(t9?.payload).toEqual({ mode: 'scheduled_probe' });
    expect(Date.parse(w.clock.nowIso())).toBeGreaterThanOrEqual(Date.parse(RESUMES_AT));
  });
});

// ---------------------------------------------------------------------------
// resume --wait — the probe schedule loop (unknown ETA → T10 → T9)
// ---------------------------------------------------------------------------
describe('resume --wait', () => {
  it('probes at the event-anchored deadlines: still-limited folds T10 + next rung, then a healthy probe resumes and re-enters', async () => {
    const w = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }, // round 1: pause (no ETA)
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }, // probe 1: still limited
        { turns: [{}] }, // probe 2: healthy
        { writes: [{ relPath: 'src/f.ts', content: 'export const f = 1;\n' }], turns: [implementorTurn()] },
      ],
      verifier: [{ turns: [verifierPassTurn()] }],
    });
    const runId = await startAndApprove(w);
    const paused = await executeCommand(w.service, w.db, RUN_CMD(runId, true), {}, w.deps);
    expect(paused.exitCode).toBe(EXIT_LIMIT_PAUSED);

    const resume = await executeCommand(
      w.service,
      w.db,
      { kind: 'resume', json: true, runId, wait: true },
      {},
      w.deps,
    );
    expect(resume.exitCode).toBe(0);
    expect(resume.json).toMatchObject({ command: 'resume', ok: true, outcome: 'merge_ready' });
    const types = w.db.events.listByRun(runId).map((e) => e.type);
    expect(types.filter((t) => t === 'limit.probe.claimed')).toHaveLength(2); // fenced, one per rung
    expect(types).toContain('limit.probe.still_limited'); // T10 folded once
    expect(types).toContain('limit.probe.scheduled'); // the explicit next rung
    const t9 = w.db.events.listByRun(runId).find((e) => e.type === 'resume.limit.requested');
    expect(t9?.payload).toEqual({ mode: 'scheduled_probe' });
  });

  it('§17.1: an inconclusive probe with a leaky provider message is redacted in the CLI text, the JSON detail, status --json, and the durable event', async () => {
    // A deliberately FAKE key fragment shaped like a real sk- credential
    // (mirrors src/redaction/fixtures.ts — never a live secret).
    const FAKE_KEY = 'sk-ant-api03-FAKE1234567890abcdef';
    const w = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }, // round 1: pause (no ETA)
        {
          // probe 1: a NON-limit pin failure whose message echoes request
          // credentials (the transport embeds envelope messages verbatim
          // into AdapterError.message) → limit.probe.inconclusive.
          turns: [],
          onSetConfigOption: (input) => {
            if (input.optionId === 'model') {
              throw new AdapterError(
                'invalid_argument',
                `setConfigOption failed: model pin rejected (request used api key ${FAKE_KEY})`,
              );
            }
            return { effectiveValue: input.value, echoed: true };
          },
        },
      ],
    });
    const runId = await startAndApprove(w);
    const paused = await executeCommand(w.service, w.db, RUN_CMD(runId, true), {}, w.deps);
    expect(paused.exitCode).toBe(EXIT_LIMIT_PAUSED);

    const resume = await executeCommand(
      w.service,
      w.db,
      { kind: 'resume', json: true, runId, wait: true },
      {},
      w.deps,
    );
    expect(resume.exitCode).toBe(EXIT_LIMIT_PAUSED);
    expect(resume.json).toMatchObject({ outcome: 'probe_inconclusive' });
    // (c) the CLI text output and its JSON detail are redacted;
    expect(resume.text).toContain('probe inconclusive');
    expect(resume.text).toContain('[REDACTED:api_key]');
    expect(resume.text).not.toContain(FAKE_KEY);
    expect(String(resume.json['detail'])).toContain('[REDACTED:api_key]');
    expect(String(resume.json['detail'])).not.toContain(FAKE_KEY);

    // (b) status --json carries the redacted detail in its probes block;
    const status = await executeCommand(w.service, w.db, { kind: 'status', json: true, runId }, {});
    expect(status.exitCode).toBe(0);
    const probes = (status.json['limit'] as Record<string, unknown>)['probes'] as Record<string, unknown>;
    const inconclusive = probes['inconclusive'] as { classifiedKind: string; detail: string };
    expect(inconclusive.detail).toContain('[REDACTED:api_key]');
    expect(inconclusive.detail).not.toContain(FAKE_KEY);

    // (a) the durable event payload read back from the DB is redacted.
    const event = w.db.events.listByRun(runId).find((e) => e.type === 'limit.probe.inconclusive');
    const payload = event?.payload as { detail: string };
    expect(payload.detail).toContain('[REDACTED:api_key]');
    expect(payload.detail).not.toContain(FAKE_KEY);
  });

  it('§17.1: an assignment-carried OPAQUE secret (no recognizable shape) is redacted in the durable inconclusive event, status --json, and the CLI text — a non-sensitive prefix must not shield it', async () => {
    // A deliberately FAKE opaque value — no sk-/AKIA/ghp_ shape, so ONLY the
    // name-based `API_KEY=value` rule can catch it. `describeRawError`
    // composes `invalid_argument: setConfigOption failed: API_KEY=...`, the
    // exact prefix composition that used to CONSUME the assignment as a
    // non-sensitive pair's "value" and shield it from redaction
    // (verifier-demonstrated bypass).
    const OPAQUE = 'sup3r-s3cret-token-value';
    const w = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }, // round 1: pause (no ETA)
        {
          // probe 1: a NON-limit pin failure whose message carries the
          // secret ONLY as a KEY=value assignment → limit.probe.inconclusive.
          turns: [],
          onSetConfigOption: (input) => {
            if (input.optionId === 'model') {
              throw new AdapterError('invalid_argument', `setConfigOption failed: API_KEY=${OPAQUE}`);
            }
            return { effectiveValue: input.value, echoed: true };
          },
        },
      ],
    });
    const runId = await startAndApprove(w);
    const paused = await executeCommand(w.service, w.db, RUN_CMD(runId, true), {}, w.deps);
    expect(paused.exitCode).toBe(EXIT_LIMIT_PAUSED);

    const resume = await executeCommand(
      w.service,
      w.db,
      { kind: 'resume', json: true, runId, wait: true },
      {},
      w.deps,
    );
    expect(resume.exitCode).toBe(EXIT_LIMIT_PAUSED);
    expect(resume.json).toMatchObject({ outcome: 'probe_inconclusive' });
    // (c) the CLI text output and its JSON detail are redacted;
    expect(resume.text).toContain('[REDACTED:credential]');
    expect(resume.text).not.toContain(OPAQUE);
    expect(String(resume.json['detail'])).toContain('API_KEY=[REDACTED:credential]');
    expect(String(resume.json['detail'])).not.toContain(OPAQUE);

    // (b) status --json carries the redacted detail in its probes block;
    const status = await executeCommand(w.service, w.db, { kind: 'status', json: true, runId }, {});
    expect(status.exitCode).toBe(0);
    const probes = (status.json['limit'] as Record<string, unknown>)['probes'] as Record<string, unknown>;
    const inconclusive = probes['inconclusive'] as { classifiedKind: string; detail: string };
    expect(inconclusive.detail).toContain('API_KEY=[REDACTED:credential]');
    expect(inconclusive.detail).not.toContain(OPAQUE);

    // (a) the durable event payload read back from the DB is redacted — and
    // the honest non-secret frame (incl. the kind prefix) survives.
    const event = w.db.events.listByRun(runId).find((e) => e.type === 'limit.probe.inconclusive');
    const payload = event?.payload as { detail: string };
    expect(payload.detail).toContain('invalid_argument: setConfigOption failed:');
    expect(payload.detail).toContain('API_KEY=[REDACTED:credential]');
    expect(payload.detail).not.toContain(OPAQUE);
  });

  it('§17.1: a QUOTED secret value with internal whitespace (the round-3 JSON fuzzing probe) is redacted in the durable inconclusive event, status --json, and the CLI text', async () => {
    // The exact adversarial-fuzzing probe: a JSON body whose quoted password
    // value contains spaces. The old `(["']?)value\3` backreference form put
    // the closing quote AFTER a value class that terminated on whitespace,
    // so this value never matched and reached the durable
    // `limit.probe.inconclusive.detail` row VERBATIM. All material is
    // SYNTHETIC (the canonical xkcd-style passphrase, never a live secret).
    const QUOTED_SECRET = 'correct horse battery staple';
    const PROBE_JSON = `{"password":"${QUOTED_SECRET}"}`;
    const w = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }, // round 1: pause (no ETA)
        {
          // probe 1: a NON-limit pin failure whose message echoes the raw
          // JSON request body → limit.probe.inconclusive.
          turns: [],
          onSetConfigOption: (input) => {
            if (input.optionId === 'model') {
              throw new AdapterError('invalid_argument', `setConfigOption failed: request body was ${PROBE_JSON}`);
            }
            return { effectiveValue: input.value, echoed: true };
          },
        },
      ],
    });
    const runId = await startAndApprove(w);
    const paused = await executeCommand(w.service, w.db, RUN_CMD(runId, true), {}, w.deps);
    expect(paused.exitCode).toBe(EXIT_LIMIT_PAUSED);

    const resume = await executeCommand(
      w.service,
      w.db,
      { kind: 'resume', json: true, runId, wait: true },
      {},
      w.deps,
    );
    expect(resume.exitCode).toBe(EXIT_LIMIT_PAUSED);
    expect(resume.json).toMatchObject({ outcome: 'probe_inconclusive' });
    // (c) the CLI text output and its JSON detail are redacted — the whole
    // quoted value, quotes preserved;
    expect(resume.text).toContain('{"password":"[REDACTED:credential]"}');
    expect(resume.text).not.toContain(QUOTED_SECRET);
    expect(String(resume.json['detail'])).toContain('{"password":"[REDACTED:credential]"}');
    expect(String(resume.json['detail'])).not.toContain(QUOTED_SECRET);

    // (b) status --json carries the redacted detail in its probes block;
    const status = await executeCommand(w.service, w.db, { kind: 'status', json: true, runId }, {});
    expect(status.exitCode).toBe(0);
    const probes = (status.json['limit'] as Record<string, unknown>)['probes'] as Record<string, unknown>;
    const inconclusive = probes['inconclusive'] as { classifiedKind: string; detail: string };
    expect(inconclusive.detail).toContain('{"password":"[REDACTED:credential]"}');
    expect(inconclusive.detail).not.toContain(QUOTED_SECRET);

    // (a) the durable event payload read back from the DB is redacted — and
    // the honest non-secret frame survives.
    const event = w.db.events.listByRun(runId).find((e) => e.type === 'limit.probe.inconclusive');
    const payload = event?.payload as { detail: string };
    expect(payload.detail).toContain('invalid_argument: setConfigOption failed: request body was');
    expect(payload.detail).toContain('{"password":"[REDACTED:credential]"}');
    expect(payload.detail).not.toContain(QUOTED_SECRET);
  });
});

// ---------------------------------------------------------------------------
// Eligibility refusal + status limit block + startup reclaim
// ---------------------------------------------------------------------------
describe('resume eligibility and status while paused', () => {
  it('a superseded draft refuses resume (typed, exit 1) WITHOUT clearing the suspension', async () => {
    const w = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [{ turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }],
    });
    const runId = await startAndApprove(w);
    const paused = await executeCommand(w.service, w.db, RUN_CMD(runId, true), {}, w.deps);
    expect(paused.exitCode).toBe(EXIT_LIMIT_PAUSED);

    // A superseding draft lands while paused → the old round can never resurrect.
    const draft = w.service.getSpecDraft(runId)!;
    w.service.saveSpecDraft(runId, { ...draft, specHash: toSpecHash('superseded_hash') });

    const refused = await executeCommand(w.service, w.db, { kind: 'resume', json: true, runId }, {}, w.deps);
    expect(refused.exitCode).toBe(1);
    expect(refused.json).toMatchObject({ command: 'resume', ok: false, refused: 'spec_binding_mismatch' });
    expect(w.service.status(runId).suspension).toBe('paused_limit'); // NOT cleared
  });

  it('status --json carries the spec-exact limit block: incident, resumesAt "unknown", etaSource, probes{used,max,nextAt}, policy', async () => {
    const w = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [{ turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }],
    });
    const runId = await startAndApprove(w);
    await executeCommand(w.service, w.db, RUN_CMD(runId, true), {}, w.deps);

    const status = await executeCommand(w.service, w.db, { kind: 'status', json: true, runId }, {});
    expect(status.exitCode).toBe(0);
    expect(status.json['suspension']).toBe('paused_limit');
    expect(status.json['eta']).toBe('unknown');
    const limit = status.json['limit'] as Record<string, unknown>;
    expect(limit).toMatchObject({
      incident: {
        provider: 'codex', // the paused implementor's provider
        kind: 'usage_limit',
        source: 'structured',
        confidence: 'high',
      },
      resumesAt: 'unknown', // the WORD — never an invented countdown (§13)
      etaSource: 'unknown',
      policy: 'wait',
    });
    expect((limit['incident'] as Record<string, unknown>)['at']).toEqual(expect.any(String));
    const probes = limit['probes'] as Record<string, unknown>;
    expect(probes['used']).toBe(0);
    expect(probes['max']).toBe(6); // pinned per-run default (W1-F5)
    expect(typeof probes['nextAt']).toBe('string'); // the event-anchored first rung
    expect(probes['inconclusive']).toBeUndefined();

    // Not paused → no limit block (the block is a pause fact, not a fixture).
    const w2 = w; // same rig; a fresh run without a pause
    const fresh = w2.service.createRun({ goal: 'g', workspacePath: repo!.dir, coordinator: COORDINATOR });
    const freshStatus = await executeCommand(w2.service, w2.db, { kind: 'status', json: true, runId: fresh.runId }, {});
    expect(freshStatus.json['limit']).toBeUndefined();
  });

  it('startup reclaim: an unacknowledged pending re-entry (T9 landed, process died) is driven idempotently by the next resume', async () => {
    const w = await setup({
      coordinator: [{ turns: [coordinatorTurn(validSpec())] }],
      implementor: [
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] },
        { writes: [{ relPath: 'src/f.ts', content: 'export const f = 1;\n' }], turns: [implementorTurn()] },
      ],
      verifier: [{ turns: [verifierPassTurn()] }],
    });
    const runId = await startAndApprove(w);
    await executeCommand(w.service, w.db, RUN_CMD(runId, true), {}, w.deps);

    // T9 lands... and the process "dies" before re-entering.
    expect(w.service.resume(runId).status).toBe('applied');
    expect(w.service.status(runId).resumeReentryPending).toBeDefined();

    // The next `resume` reclaims the pending re-entry (no fresh T9 needed).
    const reclaimed = await executeCommand(w.service, w.db, { kind: 'resume', json: true, runId }, {}, w.deps);
    expect(reclaimed.exitCode).toBe(0);
    expect(reclaimed.json).toMatchObject({ command: 'resume', ok: true, outcome: 'merge_ready' });
    expect(w.db.events.listByRun(runId).filter((e) => e.type === 'resume.limit.requested')).toHaveLength(1);
    expect(w.service.status(runId).resumeReentryPending).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Coordinator pause during start — the ONE shared policy handler
// ---------------------------------------------------------------------------
describe('coordinator pause during start (shared handler)', () => {
  it('start waits out a structured retry_after, re-enters the coordinator round, and completes the draft to awaiting_approval', async () => {
    const RESUMES_AT = '2026-07-18T01:00:00.000Z';
    const w = await setup({
      coordinator: [
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope({ resumesAt: RESUMES_AT }) }] },
        { turns: [coordinatorTurn(validSpec())] },
      ],
    });
    const start = await executeCommand(
      w.service,
      w.db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      w.deps,
    );
    expect(start.exitCode).toBe(0);
    expect(start.json).toMatchObject({ command: 'start', ok: true, outcome: 'resumed', reentry: 'coordinator' });
    const runId = start.json['runId'] as RunId;
    expect(w.service.status(runId).phase).toBe('awaiting_approval');
    const spec = start.json['spec'] as { specVersionId: string; specHash: string };
    // The draft persisted on re-entry completion binds approval (W1-F3).
    expect(w.service.getSpecDraft(runId)?.specHash).toBe(spec.specHash);
    const approve = await executeCommand(
      w.service,
      w.db,
      { kind: 'approve', json: true, runId, specVersionId: toSpecVersionId(spec.specVersionId), testApprove: false },
      {},
    );
    expect(approve.exitCode).toBe(0);
  });

  it('a paused spec-revise re-run resumes WITH the revision context: the superseding draft lands and returns to approval', async () => {
    const RESUMES_AT = '2026-07-18T02:00:00.000Z';
    const revisedSpec = { ...validSpec(), constraints: ['Touch only files under src/cli', 'No new dependencies'] };
    const w = await setup({
      coordinator: [
        { turns: [coordinatorTurn(validSpec())] }, // start: initial draft
        { turns: [{ errorEnvelope: rateLimitErrorEnvelope({ resumesAt: RESUMES_AT }) }] }, // revise re-run: pauses
        { turns: [coordinatorTurn(revisedSpec)] }, // re-entry: revision 2
      ],
    });
    const start = await executeCommand(
      w.service,
      w.db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR },
      {},
      w.deps,
    );
    const runId = start.json['runId'] as RunId;
    const spec1 = start.json['spec'] as { specVersionId: string; specHash: string };

    const revise = await executeCommand(
      w.service,
      w.db,
      { kind: 'spec_revise', json: true, runId, feedback: 'Add a no-new-dependencies constraint.' },
      {},
      w.deps,
    );
    // The shared handler waited out the pause and re-entered the revise round
    // WITH the revision context: a NEW superseding revision, back at approval.
    expect(revise.exitCode).toBe(0);
    expect(revise.json).toMatchObject({ command: 'spec_revise', ok: true, outcome: 'resumed', reentry: 'coordinator' });
    expect(w.service.status(runId).phase).toBe('awaiting_approval');
    const spec2 = (revise.json['spec'] as { specVersionId: string; specHash: string; revision: number; supersedes?: string });
    expect(spec2.revision).toBe(2);
    expect(spec2.specHash).not.toBe(spec1.specHash);
    expect(spec2.supersedes).toBe(spec1.specVersionId);
    expect(w.service.getSpecDraft(runId)?.specHash).toBe(spec2.specHash);
  });

  it('start --no-wait on a coordinator pause exits EXIT_LIMIT_PAUSED honestly', async () => {
    const w = await setup({
      coordinator: [{ turns: [{ errorEnvelope: rateLimitErrorEnvelope() }] }],
    });
    const start = await executeCommand(
      w.service,
      w.db,
      { kind: 'start', json: true, workspace: repo!.dir, goal: GOAL, coordinator: COORDINATOR, noWait: true },
      {},
      w.deps,
    );
    expect(start.exitCode).toBe(EXIT_LIMIT_PAUSED);
    expect(start.json).toMatchObject({ command: 'start', ok: false, outcome: 'paused_limit' });
    const runId = start.json['runId'] as RunId;
    expect(w.service.status(runId).suspension).toBe('paused_limit');
  });
});
