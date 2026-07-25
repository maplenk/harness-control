/**
 * P4b wave 2 FAILOVER (§5cc/§5ee) — usage-limit escalation on the PROVEN
 * successor spine. When a role hits a usage limit and its assignment
 * `failoverPolicy` is `switch_model`/`switch_harness`, `#pauseForLimit` lands
 * `paused_limit` + checkpoint + incident FIRST (unchanged), then the lease-holding
 * owner self-drives `recordSuccessorIntent` with the NEXT ladder target instead
 * of waiting for the probe ladder. Failover is NOT a new mechanism — it is the
 * spine driven with a ladder target on a limit.
 *
 * Real-path coverage (both sqlite drivers — the spine is crash-safety-sensitive):
 *  1. `switch_model` spawns a SAME-harness successor pinned to the next ladder
 *     MODEL, keeps the SAME assignmentId, and continues to completion;
 *  2. `switch_harness` spawns a DIFFERENT-harness successor seeded from the
 *     mechanical checkpoint (checkpoint-only, no NL digest);
 *  3. the per-incident ladder is BOUNDED by `maxFailoversPerIncident` — no
 *     infinite claude<->codex oscillation;
 *  4. ladder exhaustion DEGRADES TO WAIT (stays `paused_limit` + a `failover`
 *     alert via T25) — it never silently drops the run;
 *  5. a failover successor that then CRASHES feeds the §14 breaker under the
 *     SAME assignmentId (bounded → breaker_open);
 *  6. `wait` policy is unchanged (pause + wait, no failover).
 */
import { createRunFixture } from './test-support.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assignmentId as toAssignmentId,
  criterionId,
  gitSha,
  specHash as toSpecHash,
  specVersionId,
  type RunId,
} from '../domain/ids.js';
import type { AcceptanceCriterion } from '../domain/entities.js';
import { DeterministicIdFactory, RandomIdFactory } from '../lib/id-factory.js';
import { unwrap } from '../lib/result.js';
import { parseEngineConfig } from '../config/loader.js';
import type { EngineConfig } from '../config/schema.js';
import {
  InProcessFakeAdapter,
  rateLimitErrorEnvelope,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
} from '../adapters/index.js';
import {
  openTestDatabase,
  availableDriverKinds,
  type TestDatabaseHandle,
} from '../persistence/test-support.js';
import { GitWorktreeManager } from '../worktree/index.js';
import { resolveSha, runGit } from '../worktree/git.js';
import { makeTempGitRepo, type TempGitRepo } from '../worktree/test-support.js';
import {
  LimitPausedError,
  OrchestrationService,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from './service.js';
import { DurableDesiredModelStore } from './desired-model-store.js';
import { DurableFailoverStore } from './failover-store.js';
import { runImplementVerifyLoop } from './flows/orchestrate.js';
import type { VerificationRunner } from './flows/implementor.js';
import type { EvidenceRecorder } from './flows/verifier.js';
import type { Harness, ResolvedRoleModel, RoleModelSpec } from './model-resolution.js';

const DRIVER_KINDS = await availableDriverKinds();

const CLAUDE_LOW: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const IMPLEMENTOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const SPEC_HASH = toSpecHash('spec_hash_fo');
const AC1 = criterionId('AC-1');
const CRITERIA: readonly AcceptanceCriterion[] = [
  { id: AC1, description: 'flag exists', verificationCommands: ['echo check-ac1'], expectedEvidence: 'exit 0' },
];
const NOOP_DELAY = async (): Promise<void> => undefined;

function cfg(overrides: Record<string, unknown>): EngineConfig {
  return unwrap(parseEngineConfig(overrides));
}

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

const CLAUDE_LIMIT: InProcessTurnScript = { errorEnvelope: rateLimitErrorEnvelope() };
const DIE: InProcessTurnScript = { dieMidTurn: true };
const IMPL_DONE: InProcessTurnScript = {
  updates: [{ kind: 'agent_message_chunk', text: 'done' }],
  result: { stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5, source: 'adapter' } },
};
const VERIFY_PASS: InProcessTurnScript = {
  updates: [
    {
      kind: 'agent_message_chunk',
      text: JSON.stringify({ criteria: [{ id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' }] }),
    },
  ],
  result: { stopReason: 'end_turn' },
};
const PASS_VERIFY: VerificationRunner = async (command) => ({
  exitCode: 0,
  stdout: `ran ${command}`,
  stderr: '',
  launchFailed: false,
});

interface AdapterScript {
  readonly writes?: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly turns: readonly InProcessTurnScript[];
  /** round-5: runs in the worktree cwd at the START of this creation's turn (after
   * `writes`, before the scripted turn) — lets a test CONTAMINATE the worktree
   * (dirty files / move HEAD) on a verifier's failing attempt to prove the
   * same-process re-entry resets to the bound commit. */
  readonly beforeTurn?: (cwd: string) => void;
}

interface ResolvedByRole {
  implementor: ResolvedRoleModel[];
  verifier: ResolvedRoleModel[];
  coordinator: ResolvedRoleModel[];
}

/** Records the RESOLVED spec each creation was called with (per role, in order)
 * so a test can assert the successor's harness/model changed under failover. The
 * Nth creation for a role takes the Nth script; the LAST script REPEATS. */
function makeRecordingFactory(scripts: {
  readonly implementor?: readonly AdapterScript[];
  readonly verifier?: readonly AdapterScript[];
}): { factory: RoleAdapterFactory; resolved: ResolvedByRole } {
  const cursors: Record<string, number> = {};
  const resolved: ResolvedByRole = { implementor: [], verifier: [], coordinator: [] };
  const factory: RoleAdapterFactory = {
    create(options: RoleAdapterOptions) {
      const role = options.role;
      resolved[role as keyof ResolvedByRole].push(options.resolved);
      const queue = scripts[role as keyof typeof scripts] ?? [];
      const idx = cursors[role] ?? 0;
      cursors[role] = idx + 1;
      const script: AdapterScript = queue[Math.min(idx, queue.length - 1)] ?? { turns: [] };
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        clock: options.clock,
        capabilities: { configOptions: configOptionsFor(options.resolved.harness) },
        turns: script.turns,
      });
      const orig = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (
        input,
      ) => {
        for (const write of script.writes ?? []) {
          const target = path.join(options.cwd, write.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, write.content, 'utf8');
        }
        script.beforeTurn?.(options.cwd);
        return orig(input);
      };
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory, resolved };
}

function fakeEvidence(): EvidenceRecorder {
  let n = 0;
  return {
    async record() {
      n += 1;
      return `ev_${n}` as never;
    },
  };
}

function eventTypes(db: TestDatabaseHandle['db'], id: RunId): string[] {
  return db.events.listByRun(id).map((e) => e.type);
}
function countType(db: TestDatabaseHandle['db'], id: RunId, type: string): number {
  return eventTypes(db, id).filter((t) => t === type).length;
}
/** Per-STEP failover alerts (topic `failover`); the exhaustion alert (topic
 * `failover_exhausted`) is deliberately excluded — it is checked separately. */
function failoverAlertDetails(db: TestDatabaseHandle['db'], id: RunId): string[] {
  return db.events
    .listByRun(id)
    .filter(
      (e) =>
        e.type === 'alert.raised' &&
        (e.payload as { kind: string }).kind === 'failover' &&
        (e.payload as { topic: string }).topic === 'failover',
    )
    .map((e) => (e.payload as { detail: string }).detail);
}
function alertTopics(db: TestDatabaseHandle['db'], id: RunId): string[] {
  return db.events
    .listByRun(id)
    .filter((e) => e.type === 'alert.raised')
    .map((e) => (e.payload as { topic: string }).topic);
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface LoopRig {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly worktrees: GitWorktreeManager;
  readonly runId: RunId;
  readonly assignmentId: ReturnType<typeof toAssignmentId>;
  readonly resolved: ResolvedByRole;
  readonly baseCommit: ReturnType<typeof gitSha>;
}

async function openLoopRig(
  kind: (typeof DRIVER_KINDS)[number],
  opts: {
    readonly config: EngineConfig;
    readonly implementor?: readonly AdapterScript[];
    readonly verifier?: readonly AdapterScript[];
  },
): Promise<LoopRig> {
  const repo: TempGitRepo = await makeTempGitRepo('harness-failover-');
  cleanups.push(() => repo.cleanup());
  const handle = await openTestDatabase({ kind, file: true });
  cleanups.push(() => {
    handle.close();
    handle.cleanup();
  });
  const worktrees = await GitWorktreeManager.open({ primaryRepoRoot: repo.dir, clock: handle.db.clock });
  cleanups.push(() => {
    try {
      fs.rmSync(worktrees.baseDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  const { factory, resolved } = makeRecordingFactory({
    ...(opts.implementor !== undefined ? { implementor: opts.implementor } : {}),
    ...(opts.verifier !== undefined ? { verifier: opts.verifier } : {}),
  });
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    config: opts.config,
  });
  const baseCommit = gitSha(await repo.headSha());
  const { runId } = createRunFixture(service, {
    goal: 'g',
    workspacePath: repo.dir,
    coordinator: CLAUDE_LOW,
    baseCommit,
  });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  expect((await service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: SPEC_HASH })).status).toBe(
    'applied',
  );
  return {
    service,
    db: handle.db,
    worktrees,
    runId,
    assignmentId: toAssignmentId(`asg_${runId}`),
    resolved,
    baseCommit,
  };
}

function loopInput(rig: LoopRig) {
  return {
    runId: rig.runId,
    assignmentId: rig.assignmentId,
    implementor: IMPLEMENTOR,
    verifier: VERIFIER,
    specHash: SPEC_HASH,
    // B2 (codex F5): required signer — these fixtures model human-approved runs.
    specApprovedBy: 'human' as const,
    specDocument: '{"goal":"g"}',
    goal: 'g',
    taskScope: 'Implement the approved specification end to end.',
    criteria: CRITERIA,
    evidence: fakeEvidence(),
    runVerificationCommands: PASS_VERIFY,
    baseCommit: rig.baseCommit,
  };
}

function loopDeps(rig: LoopRig) {
  return {
    service: rig.service,
    worktrees: rig.worktrees,
    ids: new RandomIdFactory(),
    clock: rig.db.clock,
    delay: NOOP_DELAY,
  };
}

const CONTAMINATION_GIT_ENV = {
  GIT_AUTHOR_NAME: 'fo-tests',
  GIT_AUTHOR_EMAIL: 'fo@harness.invalid',
  GIT_COMMITTER_NAME: 'fo-tests',
  GIT_COMMITTER_EMAIL: 'fo@harness.invalid',
} as const;

/** round-5: on a verifier's FAILING attempt, CONTAMINATE the worktree — write a
 * tracked file AND move HEAD with a bogus commit — so the same-process re-entry must
 * reset back to the bound implementation commit before verifying/provisioning. */
function contaminateWorktree(cwd: string): void {
  fs.mkdirSync(path.join(cwd, 'src'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'src', 'contamination.ts'), 'export const CONTAMINATION = true;\n');
  execFileSync('git', ['add', '-A'], { cwd });
  execFileSync('git', ['commit', '--no-verify', '-m', 'bogus verifier-attempt-1 commit'], {
    cwd,
    env: { ...process.env, ...CONTAMINATION_GIT_ENV },
  });
}

/** After a same-process verifier re-entry: the worktree is at EXACTLY the bound
 * implementation commit, attempt-1's contamination (moved HEAD + tracked dirt) is
 * gone, and the run reached merge_ready (verified the correct, clean commit). */
async function assertVerifierResetToBoundCommit(
  rig: LoopRig,
  result: Awaited<ReturnType<typeof runImplementVerifyLoop>>,
): Promise<void> {
  expect(result.outcome).toBe('merge_ready');
  const worktreePath = rig.worktrees.handleFor(rig.assignmentId)!.worktreePath;
  expect(await resolveSha(worktreePath, 'HEAD')).toBe(String(result.implementationCommit));
  expect(fs.existsSync(path.join(worktreePath, 'src', 'contamination.ts'))).toBe(false);
  expect((await runGit(['status', '--porcelain'], worktreePath)).stdout.trim()).toBe('');
}

describe.each(DRIVER_KINDS)('P4b wave 2 FAILOVER (%s)', (kind) => {
  // -------------------------------------------------------------------------
  // 1. switch_model → same-harness successor on the next ladder MODEL, same
  //    assignmentId, continues to completion.
  // -------------------------------------------------------------------------
  it('switch_model on a limit spawns a same-harness successor pinned to the next ladder model and continues', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        failoverPolicy: 'switch_model',
        failoverLadder: [{ harness: 'claude', model: 'sonnet' }],
        maxFailoversPerIncident: 2,
      }),
      implementor: [
        { turns: [CLAUDE_LIMIT] }, // opus limits on its first turn
        { writes: [{ relPath: 'src/feature.ts', content: 'export const f = true;\n' }], turns: [IMPL_DONE] },
      ],
      verifier: [{ turns: [VERIFY_PASS] }],
    });

    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig));
    expect(result.outcome).toBe('merge_ready');

    // Exactly one failover step (opus → sonnet), same harness.
    const details = failoverAlertDetails(rig.db, rig.runId);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatch(/claude\/opus → claude\/sonnet/);
    // The successor's SECOND implementor creation resolved to the SONNET model
    // (the first was opus, which limited).
    const implModels = rig.resolved.implementor.map((r) => `${r.harness}/${r.model}`);
    expect(implModels[0]).toBe('claude/opus');
    expect(implModels[1]).toBe('claude/sonnet');
    // The desired-model store carries the escalated target (same assignmentId
    // preserved — the run reached merge_ready under it).
    const desired = new DurableDesiredModelStore(rig.db).get(rig.runId, 'implementor');
    expect(desired).toMatchObject({ harness: 'claude', model: 'sonnet' });
    // The failover incident resets once the successor ran past the limit.
    expect(new DurableFailoverStore(rig.db).position(rig.runId, rig.assignmentId)).toBe(0);
    expect(rig.service.status(rig.runId).suspension).toBe('none');
  });

  // -------------------------------------------------------------------------
  // 2. switch_harness → DIFFERENT-harness successor seeded from the checkpoint.
  // -------------------------------------------------------------------------
  it('switch_harness on a limit spawns a different-harness successor seeded from the mechanical checkpoint', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        failoverPolicy: 'switch_harness',
        failoverLadder: [{ harness: 'codex', model: 'gpt-5.6-terra', effort: 'high' }],
        maxFailoversPerIncident: 2,
      }),
      implementor: [
        { turns: [CLAUDE_LIMIT] }, // claude/opus limits
        { writes: [{ relPath: 'src/feature.ts', content: 'export const f = true;\n' }], turns: [IMPL_DONE] },
      ],
      verifier: [{ turns: [VERIFY_PASS] }],
    });

    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig));
    expect(result.outcome).toBe('merge_ready');

    const details = failoverAlertDetails(rig.db, rig.runId);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatch(/claude\/opus → codex\/gpt-5\.6-terra/);
    // Cross-harness successor continues from the mechanical checkpoint (a
    // checkpoint was recorded by the limit pause), never the dead session's raw
    // history — the alert states the new-session tradeoff.
    expect(details[0]).toMatch(/cross-harness/);
    expect(countType(rig.db, rig.runId, 'checkpoint.recorded')).toBeGreaterThanOrEqual(1);
    // The successor actually ran on the OTHER harness.
    const implHarnesses = rig.resolved.implementor.map((r) => r.harness);
    expect(implHarnesses[0]).toBe('claude');
    expect(implHarnesses[1]).toBe('codex');
    expect(rig.service.status(rig.runId).suspension).toBe('none');
  });

  // -------------------------------------------------------------------------
  // 3. Bounded ladder: maxFailoversPerIncident stops the walk — no infinite
  //    claude<->codex oscillation.
  // -------------------------------------------------------------------------
  it('bounds the per-incident ladder at maxFailoversPerIncident (no infinite oscillation)', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        failoverPolicy: 'switch_harness',
        failoverLadder: [
          { harness: 'codex', model: 'gpt-5.6-terra' },
          { harness: 'claude', model: 'sonnet' },
        ],
        maxFailoversPerIncident: 2,
      }),
      // EVERY implementor attempt limits (last script repeats forever).
      implementor: [{ turns: [CLAUDE_LIMIT] }],
      verifier: [{ turns: [VERIFY_PASS] }],
    });

    const thrown: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch(
      (e: unknown) => e,
    );
    // The exhausting walk unwinds as the underlying limit pause — the loop did
    // NOT spin forever (reaching this assertion IS the bound).
    expect(thrown).toBeInstanceOf(LimitPausedError);

    // Exactly maxFailoversPerIncident=2 failover steps, then one T25 exhaustion.
    expect(failoverAlertDetails(rig.db, rig.runId)).toHaveLength(2);
    expect(countType(rig.db, rig.runId, 'failover.no_live_target')).toBe(1);
    // original opus + 2 ladder successors (codex, then claude/sonnet) = 3 spawns.
    expect(rig.resolved.implementor.map((r) => `${r.harness}/${r.model}`)).toEqual([
      'claude/opus',
      'codex/gpt-5.6-terra',
      'claude/sonnet',
    ]);
    expect(countType(rig.db, rig.runId, 'child.spawned')).toBe(3);
    // The run remains paused_limit (waiting), never dropped.
    expect(rig.service.status(rig.runId).suspension).toBe('paused_limit');
  });

  // -------------------------------------------------------------------------
  // 4. Ladder exhaustion DEGRADES TO WAIT (paused_limit + alert), not a drop.
  // -------------------------------------------------------------------------
  it('degrades to wait (paused_limit + failover alert via T25) when the ladder is exhausted', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        failoverPolicy: 'switch_model',
        failoverLadder: [{ harness: 'claude', model: 'sonnet' }],
        maxFailoversPerIncident: 5, // ladder length (1) is the tighter bound
      }),
      implementor: [{ turns: [CLAUDE_LIMIT] }], // every attempt limits
      verifier: [{ turns: [VERIFY_PASS] }],
    });

    const thrown: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch(
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(LimitPausedError);

    // One failover step (opus → sonnet), then exhaustion (T25) with an alert.
    expect(failoverAlertDetails(rig.db, rig.runId)).toHaveLength(1);
    expect(countType(rig.db, rig.runId, 'failover.no_live_target')).toBe(1);
    // T25's `failover_exhausted` notify is now alertable → a `failover` alert.
    expect(alertTopics(rig.db, rig.runId).filter((t) => t === 'failover_exhausted')).toHaveLength(1);
    // NOT dropped: still paused_limit, and a manual resume is reachable.
    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('paused_limit');
    expect(rig.service.recordSuccessorIntent(rig.runId).status).toBe('applied');
    expect(rig.service.status(rig.runId).suspension).toBe('none');
  });

  // -------------------------------------------------------------------------
  // 4b. §review-7 F4(b) — a `switch_model` ladder whose harness differs from the
  //     role's EFFECTIVE (currently-running) harness is REFUSED at dispatch (it
  //     must never be silently applied as a cross-harness switch). The parse-time
  //     same-harness check only proves the entries agree with EACH OTHER — here
  //     they all agree (codex) but the role runs on CLAUDE — so the guard lives
  //     at dispatch: degrade to wait, no codex successor is ever spawned.
  // -------------------------------------------------------------------------
  it('refuses a switch_model failover whose harness differs from the role effective harness (no silent cross-harness switch)', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        // Single-harness ladder (passes parse) — but codex, while the implementor
        // runs on claude. A model-only switch cannot cross to codex.
        failoverPolicy: 'switch_model',
        failoverLadder: [{ harness: 'codex', model: 'gpt-5.6-terra' }],
        maxFailoversPerIncident: 5,
      }),
      implementor: [{ turns: [CLAUDE_LIMIT] }], // opus (claude) limits
      verifier: [{ turns: [VERIFY_PASS] }],
    });

    const thrown: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch(
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(LimitPausedError);

    // Refused, not applied: NO per-step failover alert, and the T25 no-live-target
    // degrade fired instead (paused_limit + failover_exhausted alert).
    expect(failoverAlertDetails(rig.db, rig.runId)).toHaveLength(0);
    expect(countType(rig.db, rig.runId, 'failover.no_live_target')).toBe(1);
    expect(alertTopics(rig.db, rig.runId).filter((t) => t === 'failover_exhausted')).toHaveLength(1);
    // No codex successor was ever spawned — only the original claude/opus.
    expect(rig.resolved.implementor.map((r) => r.harness)).toEqual(['claude']);
    expect(rig.resolved.implementor.some((r) => r.harness === 'codex')).toBe(false);
    // No escalation target was recorded (the switch was refused before the pin).
    expect(new DurableDesiredModelStore(rig.db).get(rig.runId, 'implementor')).toBeUndefined();
    expect(rig.service.status(rig.runId).suspension).toBe('paused_limit');
  });

  // -------------------------------------------------------------------------
  // 5. A failover successor that then CRASHES feeds the §14 breaker under the
  //    SAME assignmentId (bounded → breaker_open, no new bucket).
  // -------------------------------------------------------------------------
  it('a failover successor that then crashes feeds the breaker under the same assignmentId', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        failoverPolicy: 'switch_harness',
        failoverLadder: [{ harness: 'codex', model: 'gpt-5.6-terra' }],
        maxFailoversPerIncident: 2,
        // windowMax 3 → the 4th crash within the window opens the breaker.
        restarts: { windowMax: 3, autoRespawn: 'bounded' },
      }),
      // claude/opus limits once → failover to codex → the codex successor then
      // crashes on EVERY respawn (the DIE script repeats).
      implementor: [{ turns: [CLAUDE_LIMIT] }, { turns: [DIE] }],
      verifier: [{ turns: [VERIFY_PASS] }],
    });

    const thrown: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch(
      (e: unknown) => e,
    );
    // The exhausting crash unwinds (breaker_open, not a limit or a signal).
    expect(thrown).not.toBeInstanceOf(LimitPausedError);

    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('breaker_open');
    // Exactly ONE failover (claude → codex) happened first…
    expect(failoverAlertDetails(rig.db, rig.runId)).toHaveLength(1);
    expect(failoverAlertDetails(rig.db, rig.runId)[0]).toMatch(/claude\/opus → codex\/gpt-5\.6-terra/);
    // …and then the CODEX successor's crashes fed the §14 breaker under the SAME
    // assignmentId (the loop NEVER re-keyed it — a new assignmentId would be
    // breaker-evasion). The crashes accumulated in ONE bucket and OPENED the
    // breaker: at least one bounded auto-respawn, a durable restart counted, and
    // exactly one breaker_open. (Failover itself never fed the breaker — only the
    // successor's LATER crashes did, which is the intended §5cc behaviour.)
    const kinds = alertTopics(rig.db, rig.runId);
    expect(kinds.filter((k) => k === 'respawn').length).toBeGreaterThanOrEqual(1);
    expect(kinds.filter((k) => k === 'breaker_open')).toHaveLength(1);
    expect(st.counters.lifetimeRestarts).toBeGreaterThanOrEqual(1);
    expect(countType(rig.db, rig.runId, 'restart.exhausted')).toBe(1);
    // The generation that crashed into the breaker was the CODEX failover
    // successor (the escalated target persisted across the respawns).
    const codexSpawns = rig.resolved.implementor.filter((r) => r.harness === 'codex');
    expect(codexSpawns.length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // 6. `wait` policy is unchanged: pause + wait, no failover.
  // -------------------------------------------------------------------------
  it('wait policy is unchanged — a limit pauses and waits, with no failover successor', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({ failoverPolicy: 'wait' }),
      implementor: [{ turns: [CLAUDE_LIMIT] }],
      verifier: [{ turns: [VERIFY_PASS] }],
    });

    const thrown: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch(
      (e: unknown) => e,
    );
    expect(thrown).toBeInstanceOf(LimitPausedError);

    // No failover: exactly one spawn (the original opus), no failover alert,
    // no ladder walk — the run just waits at paused_limit.
    expect(failoverAlertDetails(rig.db, rig.runId)).toHaveLength(0);
    expect(countType(rig.db, rig.runId, 'failover.no_live_target')).toBe(0);
    expect(countType(rig.db, rig.runId, 'child.spawned')).toBe(1);
    expect(rig.resolved.implementor.map((r) => `${r.harness}/${r.model}`)).toEqual(['claude/opus']);
    expect(rig.service.status(rig.runId).suspension).toBe('paused_limit');
  });

  // -------------------------------------------------------------------------
  // 7. §review-7 F1 — a VERIFIER-side limit under switch_model re-enters at
  //    VERIFICATION (its immutable binding), NOT the implementor branch: it must
  //    reach a terminal outcome, never throw LoopCompositionError. Before the fix
  //    the re-drive fell into the implementor branch and the phase guard rejected
  //    it (a verifier-side limit was forced to DEGRADE TO WAIT).
  // -------------------------------------------------------------------------
  it('a verifier-side limit under switch_model re-enters at VERIFICATION and reaches merge_ready (not LoopCompositionError)', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        failoverPolicy: 'switch_model',
        failoverLadder: [{ harness: 'claude', model: 'haiku' }],
        maxFailoversPerIncident: 2,
      }),
      // The implementor completes on its first try (writes the feature);
      implementor: [
        { writes: [{ relPath: 'src/feature.ts', content: 'export const f = true;\n' }], turns: [IMPL_DONE] },
      ],
      // …then the VERIFIER limits on its first turn and passes after failover.
      verifier: [{ turns: [CLAUDE_LIMIT] }, { turns: [VERIFY_PASS] }],
    });

    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig));
    // The verifier half re-entered at VERIFICATION and drove to a terminal
    // outcome (no LoopCompositionError, no forced degrade-to-wait).
    expect(result.outcome).toBe('merge_ready');

    // Exactly one VERIFIER failover step (sonnet → haiku), same harness.
    const details = failoverAlertDetails(rig.db, rig.runId);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatch(/verifier claude\/sonnet → claude\/haiku/);
    // The successor's SECOND verifier creation resolved to the escalated model.
    const verifierModels = rig.resolved.verifier.map((r) => `${r.harness}/${r.model}`);
    expect(verifierModels).toEqual(['claude/sonnet', 'claude/haiku']);
    // The escalated verifier target is durable; the incident reset after progress.
    expect(new DurableDesiredModelStore(rig.db).get(rig.runId, 'verifier')).toMatchObject({
      harness: 'claude',
      model: 'haiku',
    });
    expect(new DurableFailoverStore(rig.db).position(rig.runId, rig.assignmentId)).toBe(0);
    expect(rig.service.status(rig.runId).suspension).toBe('none');
  });

  // -------------------------------------------------------------------------
  // 8. §review-7 F1 — a VERIFIER-side CRASH under bounded auto-respawn ALSO
  //    re-enters at VERIFICATION (the shared role-aware re-entry), not the
  //    implementor branch → terminal, never LoopCompositionError.
  // -------------------------------------------------------------------------
  it('a verifier-side crash under bounded auto-respawn re-enters at VERIFICATION and reaches merge_ready (not LoopCompositionError)', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        failoverPolicy: 'wait', // a crash, not a limit — failover policy is irrelevant
        restarts: { windowMax: 5, autoRespawn: 'bounded' },
      }),
      implementor: [
        { writes: [{ relPath: 'src/feature.ts', content: 'export const f = true;\n' }], turns: [IMPL_DONE] },
      ],
      // The VERIFIER crashes mid-turn once, then passes on the bounded respawn.
      verifier: [{ turns: [DIE] }, { turns: [VERIFY_PASS] }],
    });

    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig));
    expect(result.outcome).toBe('merge_ready');

    // Exactly one bounded respawn of the verifier, same spec (no failover here).
    expect(alertTopics(rig.db, rig.runId).filter((t) => t === 'respawn')).toHaveLength(1);
    expect(rig.resolved.verifier.map((r) => `${r.harness}/${r.model}`)).toEqual([
      'claude/sonnet',
      'claude/sonnet',
    ]);
    expect(failoverAlertDetails(rig.db, rig.runId)).toHaveLength(0);
    expect(rig.service.status(rig.runId).suspension).toBe('none');
  });

  // -------------------------------------------------------------------------
  // 8b. round-5 — a SAME-process verifier re-entry (limit failover OR bounded
  //    auto-respawn) whose FAILING attempt-1 dirtied files AND moved HEAD must RESET
  //    the worktree to EXACTLY the bound implementation commit before it provisions +
  //    verifies. Without the fix the forced-verifier branch only restored the SHA
  //    variable, so provisioning fingerprinted the moved HEAD while verification bound
  //    the old commit (contaminated / wrong state).
  // -------------------------------------------------------------------------
  it('round-5 — a verifier LIMIT whose attempt-1 moved HEAD + dirtied files re-enters at the BOUND commit (reset, not the moved HEAD)', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        failoverPolicy: 'switch_model',
        failoverLadder: [{ harness: 'claude', model: 'haiku' }],
        maxFailoversPerIncident: 2,
      }),
      implementor: [
        { writes: [{ relPath: 'src/feature.ts', content: 'export const f = true;\n' }], turns: [IMPL_DONE] },
      ],
      // Attempt 1 CONTAMINATES (bogus commit + tracked dirt) then limits; the failover
      // successor (attempt 2) passes — it must start from the reset, bound commit.
      verifier: [{ beforeTurn: contaminateWorktree, turns: [CLAUDE_LIMIT] }, { turns: [VERIFY_PASS] }],
    });

    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig));
    await assertVerifierResetToBoundCommit(rig, result);
  });

  it('round-5 — a verifier CRASH (bounded auto-respawn) whose attempt-1 moved HEAD + dirtied files re-enters at the BOUND commit', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        failoverPolicy: 'wait', // a crash, not a limit
        restarts: { windowMax: 5, autoRespawn: 'bounded' },
      }),
      implementor: [
        { writes: [{ relPath: 'src/feature.ts', content: 'export const f = true;\n' }], turns: [IMPL_DONE] },
      ],
      verifier: [{ beforeTurn: contaminateWorktree, turns: [DIE] }, { turns: [VERIFY_PASS] }],
    });

    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig));
    await assertVerifierResetToBoundCommit(rig, result);
  });

  // -------------------------------------------------------------------------
  // 9. §review-7 F2 — the failover advance is ONE atomic unit. A crash injected
  //    BETWEEN the durable position-advance and the successor-intent commit must
  //    leave the run retrying the SAME rung it selected, never skipping one (and
  //    leave no desired-model pinned). Before the fix the separate writes left the
  //    position advanced with no intent → a retry skipped a rung.
  // -------------------------------------------------------------------------
  it('a crash between the failover position-advance and the successor-intent leaves the run retrying the SAME rung', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({
        failoverPolicy: 'switch_model',
        failoverLadder: [
          { harness: 'claude', model: 'sonnet' },
          { harness: 'claude', model: 'haiku' },
        ],
        maxFailoversPerIncident: 2,
      }),
      implementor: [{ turns: [CLAUDE_LIMIT] }], // limits while selecting rung 0
      verifier: [{ turns: [VERIFY_PASS] }],
    });

    // Inject a crash EXACTLY between the position-advance and the intent commit:
    // the successor-intent write throws on its first (failover) invocation.
    const realRecord = rig.service.recordSuccessorIntent.bind(rig.service);
    let injected = false;
    (
      rig.service as unknown as { recordSuccessorIntent: (...a: unknown[]) => unknown }
    ).recordSuccessorIntent = (...args: unknown[]): unknown => {
      if (!injected) {
        injected = true;
        throw new Error('injected crash between position-advance and successor-intent');
      }
      return (realRecord as (...a: unknown[]) => unknown)(...args);
    };

    const thrown: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch(
      (e: unknown) => e,
    );
    expect((thrown as Error).message).toMatch(/injected crash/);

    // The atomic advance rolled BACK with the failed intent: the ladder position
    // is still 0 (a retry re-reads the SAME rung, never skipping to 1) and no
    // desired-model was left pinned.
    expect(new DurableFailoverStore(rig.db).position(rig.runId, rig.assignmentId)).toBe(0);
    expect(new DurableDesiredModelStore(rig.db).get(rig.runId, 'implementor')).toBeUndefined();
  });
});
