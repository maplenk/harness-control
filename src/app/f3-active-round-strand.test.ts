/**
 * F3 (§5ff/§5hh review-7) — a NON-limit/NON-crash error thrown by the ACTIVE
 * role flow no longer STRANDS the run. Before this fix, an auth/protocol/budget/
 * local-git error thrown by `runner.run()` (the child still alive, the round
 * durably `active`) skipped the `completed` write and left suspension `none` —
 * so `resume` (paused/interrupted-only) AND `run` (approved-only) both refused,
 * with no operator path forward. `runRole` now routes such an error through the
 * SAME interrupt discipline the crash / orchestrator-restart paths use:
 *
 *  - a RECOVERABLE typed flow error (auth/protocol AdapterError, a
 *    `BudgetExceededError`, or a local `WorktreeError`/git failure) records a
 *    durable INTERRUPTED outcome (T17 `recovery.running_segment_found` — the
 *    PURPOSE-BUILT interrupt for a still-running segment, BREAKER-EXEMPT, NOT the
 *    child-crash T13), so `resume` reclaims the SAME round via T12 →
 *    `resolveResumeEntry` and drives it to a terminal outcome — the identical
 *    machinery a T13 crash-interrupt uses;
 *  - a GENUINELY-TERMINAL error (a `LoopCompositionError` composition breach)
 *    stays terminal: NO interrupt, suspension unchanged, so `resume` can never
 *    re-enter it and re-throw forever;
 *  - the limit (LimitPausedError → driveFailoverOnLimit) and crash
 *    (AutoRespawnSignal / autoRespawn=off T13) paths are BYTE-FOR-BYTE unchanged
 *    — the new catch re-throws their control signals untouched and never
 *    double-records an already-suspended round.
 *
 * Real-path coverage (BOTH sqlite drivers — durable interrupt/resume is
 * driver-sensitive), each FAILING without the fix (the strand: round active,
 * suspension none, resume + run both refuse):
 *  A. an auth error (through the real `#routeProviderFailure` prompt path) on an
 *     ACTIVE IMPLEMENTOR round leaves the run interrupted (breaker-exempt) and a
 *     subsequent `resume` reclaims the SAME round → merge_ready;
 *  B. the SAME on an ACTIVE VERIFIER round re-enters at VERIFICATION (not the
 *     implementor branch — the F1 role-aware re-entry) → merge_ready;
 *  C. protocol / budget / local-git errors each interrupt an active round,
 *     breaker-exempt;
 *  D. a LoopCompositionError stays terminal (NOT falsely resumable);
 *  E. the crash path (autoRespawn=off) is unchanged — no spurious T17.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
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
  AdapterError,
  InProcessFakeAdapter,
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
import { GitWorktreeManager, WorktreeError } from '../worktree/index.js';
import { makeTempGitRepo, type TempGitRepo } from '../worktree/test-support.js';
import {
  AutoRespawnSignal,
  BudgetExceededError,
  LimitPausedError,
  OrchestrationService,
  type RoleAdapterFactory,
  type RoleAdapterOptions,
} from './service.js';
import type { RoleRunner } from './role-runner.js';
import { LoopCompositionError, runImplementVerifyLoop } from './flows/orchestrate.js';
import type { VerificationRunner } from './flows/implementor.js';
import type { EvidenceRecorder } from './flows/verifier.js';
import type { Harness, RoleModelSpec } from './model-resolution.js';

const DRIVER_KINDS = await availableDriverKinds();

const COORDINATOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const IMPLEMENTOR: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const VERIFIER: RoleModelSpec = { harness: 'claude', model: 'sonnet', effort: 'medium' };
const SPEC_HASH = toSpecHash('spec_hash_f3');
const AC1 = criterionId('AC-1');
const CRITERIA: readonly AcceptanceCriterion[] = [
  { id: AC1, description: 'flag exists', verificationCommands: ['echo check-ac1'], expectedEvidence: 'exit 0' },
];

/** An AUTH provider envelope (JSON-RPC -32000 = the shared ACP-SDK authRequired
 * factory both adapters use → classified `auth`). Routed through the REAL
 * `#routeProviderFailure('prompt_turn')` auth arm. */
const AUTH_ENVELOPE = { code: -32000, message: 'authentication required' };
const AUTH_TURN: InProcessTurnScript = { errorEnvelope: AUTH_ENVELOPE };
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

interface AdapterScript {
  readonly writes?: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly turns: readonly InProcessTurnScript[];
}

interface CreatedCount {
  implementor: number;
  verifier: number;
  coordinator: number;
}

/** Nth-creation-takes-Nth-script factory (last script repeats), with a
 * per-turn file-write side effect — mirrors the loop-rig factories. */
function makeFactory(
  scripts: {
    readonly implementor?: readonly AdapterScript[];
    readonly verifier?: readonly AdapterScript[];
    readonly coordinator?: readonly AdapterScript[];
  },
  created: CreatedCount,
): RoleAdapterFactory {
  const cursors: Record<string, number> = {};
  return {
    create(options: RoleAdapterOptions) {
      const role = options.role;
      created[role as keyof CreatedCount] += 1;
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
        return orig(input);
      };
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
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

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

// ---------------------------------------------------------------------------
// Loop rig — a real temp git repo + in-process fakes (no real spawns).
// ---------------------------------------------------------------------------
interface LoopRig {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly worktrees: GitWorktreeManager;
  readonly runId: RunId;
  readonly assignmentId: ReturnType<typeof toAssignmentId>;
  readonly created: CreatedCount;
}

async function openLoopRig(
  kind: (typeof DRIVER_KINDS)[number],
  opts: {
    readonly config?: EngineConfig;
    readonly implementor?: readonly AdapterScript[];
    readonly verifier?: readonly AdapterScript[];
  },
): Promise<LoopRig> {
  const repo: TempGitRepo = await makeTempGitRepo('harness-f3-');
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
  const created: CreatedCount = { implementor: 0, verifier: 0, coordinator: 0 };
  const factory = makeFactory(
    {
      ...(opts.implementor !== undefined ? { implementor: opts.implementor } : {}),
      ...(opts.verifier !== undefined ? { verifier: opts.verifier } : {}),
    },
    created,
  );
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  });
  const { runId } = service.createRun({ goal: 'g', workspacePath: repo.dir, coordinator: COORDINATOR });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  expect(service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: SPEC_HASH }).status).toBe(
    'applied',
  );
  return { service, db: handle.db, worktrees, runId, assignmentId: toAssignmentId(`asg_${runId}`), created };
}

function loopInput(rig: LoopRig) {
  return {
    runId: rig.runId,
    assignmentId: rig.assignmentId,
    implementor: IMPLEMENTOR,
    verifier: VERIFIER,
    specHash: SPEC_HASH,
    specDocument: '{"goal":"g"}',
    goal: 'g',
    taskScope: 'Implement the approved specification end to end.',
    criteria: CRITERIA,
    evidence: fakeEvidence(),
    runVerificationCommands: PASS_VERIFY,
  };
}

function loopDeps(rig: LoopRig) {
  return {
    service: rig.service,
    worktrees: rig.worktrees,
    ids: new RandomIdFactory(),
    clock: rig.db.clock,
  };
}

// ---------------------------------------------------------------------------
// Service rig (no git) — direct `runRole` producer coverage of the type-split.
// ---------------------------------------------------------------------------
interface ServiceRig {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly runId: RunId;
  readonly assignmentId: ReturnType<typeof toAssignmentId>;
}

async function openServiceRig(
  kind: (typeof DRIVER_KINDS)[number],
  opts: { readonly config?: EngineConfig } = {},
): Promise<ServiceRig> {
  const handle = await openTestDatabase({ kind, file: false });
  cleanups.push(() => {
    handle.close();
    handle.cleanup();
  });
  const created: CreatedCount = { implementor: 0, verifier: 0, coordinator: 0 };
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    // A default fake for every role — the spawn/pin window succeeds, then the
    // custom RoleRunner (or a scripted turn) produces the flow error.
    adapterFactory: makeFactory({ implementor: [{ turns: [] }] }, created),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  });
  const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: COORDINATOR });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  expect(service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: SPEC_HASH }).status).toBe(
    'applied',
  );
  return { service, db: handle.db, runId, assignmentId: toAssignmentId(`asg_${runId}`) };
}

/** A RoleRunner that throws `error` from `run()` (no prompt) — models a local
 * flow error (git/artifact) or a composition breach reaching the F3 catch. */
function throwingRunner(role: 'implementor' | 'verifier', error: unknown): RoleRunner {
  return {
    role,
    run: async () => {
      throw error;
    },
  };
}

/** Dispatch an ACTIVE implementor round via a DIRECT `runRole` and return the
 * error it unwinds with. The round goes `active` (phase implementing) before
 * `run()` throws — exactly the strand window. */
async function dispatchActiveImplementorRound(
  rig: ServiceRig,
  runner: RoleRunner,
): Promise<unknown> {
  return rig.service
    .runRole(rig.runId, runner, IMPLEMENTOR, '/ws', {
      round: 1,
      advance: { from: 'approved', to: 'implementing' },
      completionAdvance: { from: 'implementing', to: 'verifying' },
      inputs: JSON.stringify({ taskScope: 'implement it' }),
      specHash: SPEC_HASH,
      baseCommit: gitSha('a'.repeat(40)),
      criterionIds: [AC1],
      assignmentId: rig.assignmentId,
    })
    .then(() => undefined)
    .catch((e: unknown) => e);
}

// ---------------------------------------------------------------------------
describe.each(DRIVER_KINDS)('F3 non-limit active-round strand (%s)', (kind) => {
  // =========================================================================
  // A. Recoverable auth error on an ACTIVE IMPLEMENTOR round → interrupted →
  //    resume reclaims the SAME round → merge_ready.
  // =========================================================================
  it('an auth error on an active IMPLEMENTOR round interrupts (breaker-exempt) and resume reclaims the SAME round to merge_ready', async () => {
    const rig = await openLoopRig(kind, {
      implementor: [
        { turns: [AUTH_TURN] }, // round-1 attempt: auth fails mid-turn
        { writes: [{ relPath: 'src/feature.ts', content: 'export const feature = true;\n' }], turns: [IMPL_DONE] },
      ],
      verifier: [{ turns: [VERIFY_PASS] }],
    });

    const unwound: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch((e: unknown) => e);
    // Unwinds with the sink-safe provider error — NOT a limit/crash signal.
    expect(unwound).toBeInstanceOf(AdapterError);
    expect(unwound).not.toBeInstanceOf(LimitPausedError);
    expect(unwound).not.toBeInstanceOf(AutoRespawnSignal);

    // The run is RESUMABLE, not stranded: durable INTERRUPTED, breaker-exempt.
    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('interrupted');
    expect(st.phase).toBe('implementing'); // NOT approved → the OLD `run` path refuses
    expect(st.counters.lifetimeRestarts).toBe(0); // T17, never the child-crash T13
    expect(st.counters.restartsInWindow).toBe(0);
    expect(countType(rig.db, rig.runId, 'recovery.running_segment_found')).toBe(1);
    expect(countType(rig.db, rig.runId, 'child.exited.unexpectedly')).toBe(0);
    const round = rig.service.getRoleRound(rig.runId);
    expect(round).toMatchObject({ role: 'implementor', round: 1, stage: 'active' });

    // `resume` reclaims: eligibility-checked T12 lifts the interrupt, then the
    // SAME round re-drives from the durable projection → merge_ready.
    expect(rig.service.resume(rig.runId).status).toBe('applied');
    const result = await runImplementVerifyLoop(loopDeps(rig), {
      ...loopInput(rig),
      resume: { round: round! },
    });
    expect(result.outcome).toBe('merge_ready');
    expect(rig.service.status(rig.runId).suspension).toBe('none');
    // Round numbering resumed at 1 (reclaimed, not a fresh round).
    expect(result.rounds[0]?.round).toBe(1);
  });

  // =========================================================================
  // B. Recoverable auth error on an ACTIVE VERIFIER round → interrupted →
  //    resume RE-ENTERS AT VERIFICATION (F1 role-aware re-entry) → merge_ready.
  // =========================================================================
  it('an auth error on an active VERIFIER round interrupts and resume re-enters at VERIFICATION (not the implementor branch) to merge_ready', async () => {
    const rig = await openLoopRig(kind, {
      implementor: [
        { writes: [{ relPath: 'src/feature.ts', content: 'export const feature = true;\n' }], turns: [IMPL_DONE] },
      ],
      verifier: [
        { turns: [AUTH_TURN] }, // verifier round-1: auth fails mid-turn
        { turns: [VERIFY_PASS] }, // re-entered verification passes
      ],
    });

    const unwound: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch((e: unknown) => e);
    expect(unwound).toBeInstanceOf(AdapterError);

    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('interrupted');
    expect(st.phase).toBe('verifying');
    expect(st.counters.lifetimeRestarts).toBe(0);
    expect(countType(rig.db, rig.runId, 'recovery.running_segment_found')).toBe(1);
    const round = rig.service.getRoleRound(rig.runId);
    expect(round).toMatchObject({ role: 'verifier', stage: 'active' });
    const implementorCreationsBeforeResume = rig.created.implementor;
    expect(implementorCreationsBeforeResume).toBe(1); // implementor ran exactly once

    // Resume: the verifier round re-enters at VERIFICATION on its immutable
    // binding — the implementor branch is NOT re-run (it would throw
    // LoopCompositionError). resolveResumeEntry(verifier, verifying) → verify.
    expect(rig.service.resume(rig.runId).status).toBe('applied');
    const result = await runImplementVerifyLoop(loopDeps(rig), {
      ...loopInput(rig),
      resume: { round: round! },
    });
    expect(result.outcome).toBe('merge_ready');
    expect(rig.service.status(rig.runId).suspension).toBe('none');
    // The implementor was NOT dispatched again on resume — proof of verify-only
    // re-entry (a fresh implementor branch would create another adapter).
    expect(rig.created.implementor).toBe(implementorCreationsBeforeResume);
  });

  // =========================================================================
  // C. Each recoverable typed flow error interrupts an active round (breaker-
  //    exempt) — protocol, budget, local-git.
  // =========================================================================
  it('a protocol AdapterError on an active implementor round records a durable interrupt (breaker-exempt)', async () => {
    const rig = await openServiceRig(kind);
    const unwound = await dispatchActiveImplementorRound(
      rig,
      throwingRunner('implementor', new AdapterError('malformed_frame', 'wire bounds exceeded')),
    );
    expect(unwound).toBeInstanceOf(AdapterError);
    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('interrupted');
    expect(st.counters.lifetimeRestarts).toBe(0);
    expect(countType(rig.db, rig.runId, 'recovery.running_segment_found')).toBe(1);
    expect(countType(rig.db, rig.runId, 'child.exited.unexpectedly')).toBe(0);
    expect(rig.service.getRoleRound(rig.runId)).toMatchObject({ role: 'implementor', stage: 'active' });
  });

  it('a BudgetExceededError on an active implementor round records a durable interrupt (breaker-exempt)', async () => {
    // reservation 0.5 > maxBudget 0.01 → the first turn is refused pre-prompt.
    const rig = await openServiceRig(kind, { config: cfg({ budget: { maxBudgetUsd: 0.01 } }) });
    const promptOnce: RoleRunner = {
      role: 'implementor',
      run: async (session) => {
        await session.prompt({ prompt: 'go' });
        return {};
      },
    };
    const unwound = await dispatchActiveImplementorRound(rig, promptOnce);
    expect(unwound).toBeInstanceOf(BudgetExceededError);
    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('interrupted');
    expect(st.counters.lifetimeRestarts).toBe(0);
    expect(countType(rig.db, rig.runId, 'budget.exceeded')).toBe(1);
    expect(countType(rig.db, rig.runId, 'recovery.running_segment_found')).toBe(1);
  });

  it('a local WorktreeError (git flow) on an active implementor round records a durable interrupt (breaker-exempt)', async () => {
    const rig = await openServiceRig(kind);
    const unwound = await dispatchActiveImplementorRound(
      rig,
      throwingRunner('implementor', new WorktreeError('git_command_failed', 'git commit failed: index.lock')),
    );
    expect(unwound).toBeInstanceOf(WorktreeError);
    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('interrupted');
    expect(st.counters.lifetimeRestarts).toBe(0);
    expect(countType(rig.db, rig.runId, 'recovery.running_segment_found')).toBe(1);
    expect(rig.service.getRoleRound(rig.runId)).toMatchObject({ role: 'implementor', stage: 'active' });
  });

  // =========================================================================
  // D. A genuinely-TERMINAL error stays terminal — NOT falsely resumable.
  // =========================================================================
  it('a LoopCompositionError stays TERMINAL: no interrupt, suspension unchanged, NOT resumable', async () => {
    const rig = await openServiceRig(kind);
    const unwound = await dispatchActiveImplementorRound(
      rig,
      throwingRunner('implementor', new LoopCompositionError('cannot dispatch from this phase')),
    );
    // Propagated UNTOUCHED — the caller sees the real composition error.
    expect(unwound).toBeInstanceOf(LoopCompositionError);
    const st = rig.service.status(rig.runId);
    // No durable interrupt was recorded — a resume would only re-enter and
    // re-throw forever, so the strand for a terminal error is intentional.
    expect(st.suspension).toBe('none');
    expect(countType(rig.db, rig.runId, 'recovery.running_segment_found')).toBe(0);
    expect(countType(rig.db, rig.runId, 'child.exited.unexpectedly')).toBe(0);
    // `resume` REFUSES (not paused/interrupted) — proof it is not resumable.
    const resumeErr = await Promise.resolve()
      .then(() => rig.service.resume(rig.runId))
      .catch((e: unknown) => e);
    expect(resumeErr).toBeInstanceOf(Error);
    expect(rig.service.status(rig.runId).suspension).toBe('none');
  });

  // =========================================================================
  // E. The crash path (autoRespawn=off) is BYTE-FOR-BYTE unchanged — the new
  //    catch re-throws the crash's sink-safe error and never double-records an
  //    ALREADY-interrupted round (exactly one T13, ZERO T17).
  // =========================================================================
  it('the crash path (autoRespawn=off) is unchanged: one T13 interrupt, ZERO spurious recovery.running_segment_found', async () => {
    const rig = await openLoopRig(kind, {
      config: cfg({ restarts: { autoRespawn: 'off' } }),
      implementor: [{ turns: [DIE] }],
    });
    const unwound: unknown = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig)).catch((e: unknown) => e);
    expect(unwound).not.toBeInstanceOf(AutoRespawnSignal);

    const st = rig.service.status(rig.runId);
    expect(st.suspension).toBe('interrupted');
    expect(st.counters.lifetimeRestarts).toBe(1); // the child-crash T13 DID fold
    expect(countType(rig.db, rig.runId, 'child.exited.unexpectedly')).toBe(1);
    // The F3 catch must NOT re-interrupt an already-interrupted round.
    expect(countType(rig.db, rig.runId, 'recovery.running_segment_found')).toBe(0);
  });
});
