/**
 * B5 — THE MULTI-IMPLEMENTOR DRIVER, end to end through the real loop.
 *
 * Everything here drives `runImplementVerifyLoop` — not the fan-out in
 * isolation — because the claim being tested is "the engine runs N implementors",
 * and a driver that only works when called directly would not be that.
 *
 * CONCURRENCY IS PROVEN, NOT ASSUMED. Each implementor's fake turn blocks on a
 * shared barrier that only releases once BOTH implementors have entered it. A
 * sequential driver deadlocks on that barrier and the test times out; there is no
 * ordering of a serial implementation that passes it.
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
} from '../../domain/ids.js';
import type { AcceptanceCriterion } from '../../domain/entities.js';
import { DeterministicIdFactory, RandomIdFactory } from '../../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../../persistence/test-support.js';
import { GitWorktreeManager, WorktreeError, resolveSha } from '../../worktree/index.js';
import { makeTempGitRepo, type TempGitRepo } from '../../worktree/test-support.js';
import {
  InProcessFakeAdapter,
  rateLimitErrorEnvelope,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type PromptInput,
  type PromptResult,
} from '../../adapters/index.js';
import { unwrap } from '../../lib/result.js';
import { parseEngineConfig } from '../../config/loader.js';
import type { EngineConfig } from '../../config/schema.js';
import { OrchestrationService, type RoleAdapterFactory, type RoleAdapterOptions } from '../service.js';
import { createRunFixture } from '../test-support.js';
import { assignmentRoundProjectionName, resolveAssignmentRoundState } from '../projections.js';
import { runImplementVerifyLoop, type LoopAssignment } from './orchestrate.js';
import type { VerificationRunner } from './implementor.js';
import type { EvidenceRecorder } from './verifier.js';
import { joinAssignmentOutcomes } from './multi-implementor.js';

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const IMPLEMENTOR = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const VERIFIER = { harness: 'claude', model: 'sonnet', effort: 'medium' } as const;
const SPEC_HASH = toSpecHash('spec_hash_multi');
const CRITERIA: readonly AcceptanceCriterion[] = [
  {
    id: criterionId('AC-1'),
    description: 'both halves exist',
    verificationCommands: ['echo check-ac1'],
    expectedEvidence: 'exit 0',
  },
];

/**
 * The fan-out spawns N implementors at once, so `maxLiveChildren` (default 3) is
 * raised here to what the spec calls for when N > 1 — the cap is a real,
 * cross-process guard and a fan-out that ignored it would just be an unbounded
 * spawn. `allowSameHarness` keeps these fixtures about the fan-out rather than
 * about vendor independence.
 */
const MULTI_CONFIG: EngineConfig = unwrap(
  parseEngineConfig({
    verification: { allowSameHarness: true },
    maxLiveChildren: 6,
  }),
);

const PASS_VERIFY: VerificationRunner = async (command) => ({
  exitCode: 0,
  stdout: `ran ${command}`,
  stderr: '',
  launchFailed: false,
});

const VERIFY_PASS: InProcessTurnScript = {
  updates: [
    {
      kind: 'agent_message_chunk',
      text: JSON.stringify({ criteria: [{ id: 'AC-1', verdict: 'passed', evidence: 'ran check-ac1: exit 0' }] }),
    },
  ],
  result: { stopReason: 'end_turn' },
};

function claudeConfigOptions(): ConfigOptionDescriptor[] {
  return [
    { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
    { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
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

/**
 * A barrier that releases only once `size` participants have arrived. This is the
 * concurrency proof: with a serial driver the first implementor waits forever for
 * a second that is never started.
 */
function barrier(size: number, timeoutMs = 10_000) {
  let arrived = 0;
  let release!: () => void;
  const open = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    async arrive(): Promise<void> {
      arrived += 1;
      if (arrived >= size) release();
      await Promise.race([
        open,
        new Promise<void>((_, reject) =>
          setTimeout(
            () => reject(new Error(`barrier(${size}) never filled — only ${arrived} implementor(s) ran concurrently`)),
            timeoutMs,
          ).unref?.(),
        ),
      ]);
    },
    get arrived(): number {
      return arrived;
    },
  };
}

interface ImplementorScript {
  /** Matched against the session's declared write scope, joined by ','. */
  readonly scope: string;
  readonly writes?: ReadonlyArray<{ readonly relPath: string; readonly content: string }>;
  readonly stopReason?: 'end_turn' | 'refusal';
  /** This assignment's provider answers with a usage-LIMIT envelope. */
  readonly limit?: boolean;
  /** Awaited at the START of the turn — the concurrency barrier. */
  readonly gate?: () => Promise<void>;
}

interface Observed {
  /** Declared write scope of every implementor session the engine created. */
  readonly implementorScopes: string[][];
  readonly verifierSpawns: number;
}

function makeFactory(scripts: readonly ImplementorScript[]): {
  factory: RoleAdapterFactory;
  observed: Observed;
} {
  const observed: Observed = { implementorScopes: [], verifierSpawns: 0 };
  const factory: RoleAdapterFactory = {
    create(options: RoleAdapterOptions) {
      const declared = [...(options.writeBoundary?.declared ?? [])];
      if (options.role === 'implementor') observed.implementorScopes.push(declared);
      else if (options.role === 'verifier') (observed as { verifierSpawns: number }).verifierSpawns += 1;
      const script =
        options.role === 'implementor'
          ? scripts.find((candidate) => candidate.scope === declared.join(','))
          : undefined;
      const turn: InProcessTurnScript =
        options.role === 'verifier'
          ? VERIFY_PASS
          : script?.limit === true
            ? { errorEnvelope: rateLimitErrorEnvelope() }
            : {
                updates: [{ kind: 'agent_message_chunk', text: `done ${declared.join(',')}` }],
                result: {
                  stopReason: script?.stopReason ?? 'end_turn',
                  usage: { inputTokens: 1, outputTokens: 1, source: 'adapter' },
                },
              };
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        clock: options.clock,
        capabilities: { configOptions: claudeConfigOptions() },
        turns: [turn],
      });
      const orig = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (
        input,
      ) => {
        if (script !== undefined) {
          // The writes land BEFORE the barrier so both trees are dirty while both
          // agents are still live — the genuinely concurrent shared-tree state.
          for (const write of script.writes ?? []) {
            const target = path.join(options.cwd, write.relPath);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, write.content, 'utf8');
          }
          if (script.gate !== undefined) await script.gate();
        }
        return orig(input);
      };
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory, observed };
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

interface Rig {
  readonly service: OrchestrationService;
  readonly db: TestDatabaseHandle['db'];
  readonly worktrees: GitWorktreeManager;
  readonly runId: RunId;
  readonly repo: TempGitRepo;
  readonly baseCommit: ReturnType<typeof gitSha>;
  readonly observed: Observed;
}

async function openRig(
  scripts: readonly ImplementorScript[],
  config: EngineConfig = MULTI_CONFIG,
): Promise<Rig> {
  const repo = await makeTempGitRepo('harness-multi-implementor-');
  cleanups.push(() => repo.cleanup());
  await repo.writeFile('src/keep.ts', 'export const a = 1;\n');
  await repo.writeFile('web/keep.ts', 'export const b = 2;\n');
  await repo.commitAll('seed');
  const handle = await openTestDatabase({ kind: 'better-sqlite3', file: true });
  cleanups.push(() => {
    handle.close();
    handle.cleanup();
  });
  const worktrees = await GitWorktreeManager.open({
    primaryRepoRoot: repo.dir,
    clock: handle.db.clock,
  });
  cleanups.push(() => {
    try {
      fs.rmSync(worktrees.baseDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
  const { factory, observed } = makeFactory(scripts);
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
    // One vendor across both roles keeps these fixtures about the fan-out.
    config,
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
  expect(
    (await service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: SPEC_HASH })).status,
  ).toBe('applied');
  return { service, db: handle.db, worktrees, runId, repo, baseCommit, observed };
}

function loopInput(rig: Rig, assignments?: readonly LoopAssignment[]) {
  return {
    runId: rig.runId,
    assignmentId: toAssignmentId(`asg_${rig.runId}`),
    implementor: IMPLEMENTOR,
    verifier: VERIFIER,
    specHash: SPEC_HASH,
    specApprovedBy: 'human' as const,
    specDocument: '{"goal":"g"}',
    goal: 'g',
    taskScope: 'Implement the approved specification end to end.',
    criteria: CRITERIA,
    evidence: fakeEvidence(),
    runVerificationCommands: PASS_VERIFY,
    baseCommit: rig.baseCommit,
    ...(assignments !== undefined ? { assignments } : {}),
  };
}

function loopDeps(rig: Rig) {
  return {
    service: rig.service,
    worktrees: rig.worktrees,
    ids: new RandomIdFactory(),
    clock: rig.db.clock,
    delay: async (): Promise<void> => undefined,
  };
}

/** Commits reachable from a worktree HEAD, excluding the base — must be exactly 1. */
async function commitsSinceBase(cwd: string, base: string): Promise<number> {
  const { runGit } = await import('../../worktree/index.js');
  const out = (await runGit(['rev-list', '--count', `${base}..HEAD`], cwd)).stdout.trim();
  return Number(out);
}

const TWO_ASSIGNMENTS: readonly LoopAssignment[] = [
  { id: 'backend', taskScope: 'Build the API half.', writeScope: ['src'] },
  { id: 'frontend', taskScope: 'Build the UI half.', writeScope: ['web'] },
];

// ---------------------------------------------------------------------------
describe('B5 — two CONCURRENT implementors with disjoint scopes reach ONE host commit', () => {
  it('drives both implementors at once and commits their work exactly once', async () => {
    const gate = barrier(2);
    const rig = await openRig([
      {
        scope: 'src',
        writes: [{ relPath: 'src/api.ts', content: 'export const api = 1;\n' }],
        gate: () => gate.arrive(),
      },
      {
        scope: 'web',
        writes: [{ relPath: 'web/ui.ts', content: 'export const ui = 1;\n' }],
        gate: () => gate.arrive(),
      },
    ]);

    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig, TWO_ASSIGNMENTS));

    // The barrier could only have filled with both implementors live at once.
    expect(gate.arrived).toBe(2);
    // Each implementor session carried its OWN narrower boundary to the provider.
    expect(rig.observed.implementorScopes).toEqual(
      expect.arrayContaining([['src'], ['web']]),
    );
    expect(rig.observed.implementorScopes).toHaveLength(2);

    // §R2 — ONE host commit, carrying BOTH assignments' work.
    const round = result.rounds[0];
    expect(round).toBeDefined();
    const implementation = round!.implementation;
    expect(implementation).toBeDefined();
    expect(implementation!.committed).toBe(true);
    expect([...implementation!.changedFiles].sort()).toEqual(['src/api.ts', 'web/ui.ts']);
    expect(await commitsSinceBase(result.worktree.worktreePath, String(rig.baseCommit))).toBe(1);
    expect(await resolveSha(result.worktree.worktreePath, 'HEAD')).toBe(
      String(result.implementationCommit),
    );

    // The round reports per-assignment outcomes, both delivered.
    expect(implementation!.assignments).toEqual([
      { id: 'backend', writeScope: ['src'], stage: 'delivered', stopReason: 'end_turn' },
      { id: 'frontend', writeScope: ['web'], stage: 'delivered', stopReason: 'end_turn' },
    ]);

    // ONE verification of the ONE commit against the full criteria set.
    expect(rig.observed.verifierSpawns).toBe(1);
    expect(result.outcome).toBe('merge_ready');

    // Per-assignment projections are durable, bound to the round that wrote them.
    for (const id of ['backend', 'frontend']) {
      const persisted = rig.service.getAssignmentRound(rig.runId, id);
      expect(persisted?.stage).toBe('delivered');
      expect(persisted?.round).toBe(1);
    }
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('B5 — the R1 guard FIRES on concurrent overlapping scopes', () => {
  it('REFUSES a decomposition whose scopes overlap, before any implementor spawns', async () => {
    const rig = await openRig([]);
    const overlapping: readonly LoopAssignment[] = [
      { id: 'backend', taskScope: 'a', writeScope: ['src'] },
      // Nested inside the first: `src/app` is covered by `src`.
      { id: 'inner', taskScope: 'b', writeScope: ['src/app'] },
    ];

    const thrown: unknown = await runImplementVerifyLoop(
      loopDeps(rig),
      loopInput(rig, overlapping),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(WorktreeError);
    expect((thrown as WorktreeError).kind).toBe('already_leased');
    expect((thrown as Error).message).toContain('write scopes overlap');
    // Nothing was spawned and nothing was committed: the refusal is BEFORE the
    // first session, so no agent was ever confined to a boundary another owned.
    expect(rig.observed.implementorScopes).toEqual([]);
    const handle = rig.worktrees.handleFor(toAssignmentId(`asg_${rig.runId}`));
    if (handle !== undefined) {
      expect(await resolveSha(handle.worktreePath, 'HEAD')).toBe(String(rig.baseCommit));
    }
  }, 60_000);

  it('REFUSES a decomposition where one assignment declares no scope at all', async () => {
    const rig = await openRig([]);
    const thrown: unknown = await runImplementVerifyLoop(
      loopDeps(rig),
      loopInput(rig, [
        { id: 'backend', taskScope: 'a', writeScope: ['src'] },
        { id: 'everything', taskScope: 'b', writeScope: [] },
      ]),
    ).catch((error: unknown) => error);

    expect(thrown).toBeInstanceOf(WorktreeError);
    expect((thrown as Error).message).toContain('declares no write scope');
    expect(rig.observed.implementorScopes).toEqual([]);
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('B5 — the JOIN is honest about partial failure', () => {
  it('one assignment refusing makes the ROUND no-deliverable, and still commits what landed', async () => {
    const gate = barrier(2);
    const rig = await openRig([
      {
        scope: 'src',
        writes: [{ relPath: 'src/api.ts', content: 'export const api = 1;\n' }],
        gate: () => gate.arrive(),
      },
      {
        // Writes nothing and ends abnormally — the assignment that produced no
        // deliverable while its sibling produced one.
        scope: 'web',
        stopReason: 'refusal',
        gate: () => gate.arrive(),
      },
    ]);

    const thrown: unknown = await runImplementVerifyLoop(
      loopDeps(rig),
      loopInput(rig, TWO_ASSIGNMENTS),
    ).catch((error: unknown) => error);

    // NOT a successful round: the loop unwound on the no-deliverable verdict.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).name).toBe('NoDeliverableError');

    // The durable round record says no_deliverable and NAMES the assignment that
    // failed — "2 of 2 tried, 1 delivered" is what an operator reads.
    const round = rig.service.getRoleRound(rig.runId);
    expect(round?.stage).toBe('no_deliverable');
    expect(round?.diagnostic).toContain('1/2 assignment(s) finished normally');
    expect(round?.diagnostic).toContain('frontend');
    expect(round?.diagnostic).not.toContain('backend [');

    // The DELIVERING sibling's work is committed and inspectable — a partial
    // fan-out loses nothing.
    const handle = rig.worktrees.handleFor(toAssignmentId(`asg_${rig.runId}`));
    expect(handle).toBeDefined();
    expect(fs.existsSync(path.join(handle!.worktreePath, 'src/api.ts'))).toBe(true);
    expect(await commitsSinceBase(handle!.worktreePath, String(rig.baseCommit))).toBe(1);

    // Per-assignment projections record BOTH verdicts distinctly.
    expect(rig.service.getAssignmentRound(rig.runId, 'backend')?.stage).toBe('delivered');
    expect(rig.service.getAssignmentRound(rig.runId, 'frontend')?.stage).toBe('no_deliverable');

    // …and no verifier was dispatched for a round with no deliverable.
    expect(rig.observed.verifierSpawns).toBe(0);
  }, 60_000);

  it('classifies the join by how many assignments delivered', () => {
    const outcome = (stage: 'delivered' | 'no_deliverable') =>
      ({
        assignment: { id: stage, taskScope: 't', writeScope: ['x'] },
        boundary: undefined as never,
        stage,
        stopReason: stage === 'delivered' ? ('end_turn' as const) : ('refusal' as const),
      }) as never;
    expect(joinAssignmentOutcomes([outcome('delivered'), outcome('delivered')]).kind).toBe('complete');
    expect(joinAssignmentOutcomes([outcome('delivered'), outcome('no_deliverable')]).kind).toBe('partial');
    expect(joinAssignmentOutcomes([outcome('no_deliverable')]).kind).toBe('none');
    // A partial join reports an ABNORMAL stop reason, which is what makes the
    // round's own deliverable adjudication refuse it.
    expect(joinAssignmentOutcomes([outcome('delivered'), outcome('no_deliverable')]).stopReason).toBe(
      'refusal',
    );
    expect(joinAssignmentOutcomes([outcome('delivered')]).stopReason).toBe('end_turn');
  });
});

// ---------------------------------------------------------------------------
describe('B5 — a crash mid fan-out does not lose a completed assignment', () => {
  it('skips an assignment already recorded delivered for THIS round', async () => {
    const rig = await openRig([
      { scope: 'src', writes: [{ relPath: 'src/api.ts', content: 'export const api = 1;\n' }] },
      { scope: 'web', writes: [{ relPath: 'web/ui.ts', content: 'export const ui = 1;\n' }] },
    ]);
    // The record a crashed first attempt would have left behind for `backend`.
    rig.service.saveAssignmentRound(rig.runId, {
      id: 'backend',
      round: 1,
      stage: 'delivered',
      writeScope: ['src'],
      stopReason: 'end_turn',
      at: rig.db.clock.nowIso(),
    });

    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig, TWO_ASSIGNMENTS));

    // ONLY the unfinished assignment was re-driven — the delivered one was not
    // prompted (and therefore not paid for) a second time.
    expect(rig.observed.implementorScopes).toEqual([['web']]);
    // …and it is still reported as delivered in the joined round.
    const implementation = result.rounds[0]?.implementation;
    expect(implementation?.assignments?.map((a) => `${a.id}:${a.stage}`)).toEqual([
      'backend:delivered',
      'frontend:delivered',
    ]);
    expect(result.outcome).toBe('merge_ready');
  }, 60_000);

  it('a record from a DIFFERENT round never skips an assignment', async () => {
    const rig = await openRig([
      { scope: 'src', writes: [{ relPath: 'src/api.ts', content: 'export const api = 1;\n' }] },
      { scope: 'web', writes: [{ relPath: 'web/ui.ts', content: 'export const ui = 1;\n' }] },
    ]);
    rig.service.saveAssignmentRound(rig.runId, {
      id: 'backend',
      round: 7, // some earlier/other round — says nothing about round 1
      stage: 'delivered',
      writeScope: ['src'],
      at: rig.db.clock.nowIso(),
    });
    await runImplementVerifyLoop(loopDeps(rig), loopInput(rig, TWO_ASSIGNMENTS));
    expect(rig.observed.implementorScopes).toEqual(expect.arrayContaining([['src'], ['web']]));
    expect(rig.observed.implementorScopes).toHaveLength(2);
  }, 60_000);
});

// ---------------------------------------------------------------------------
describe('B5 — persisted state predates this change (rule 9)', () => {
  it('an unreadable / pre-B5 assignment record resolves to "no record", never a throw', () => {
    expect(resolveAssignmentRoundState(undefined)).toBeUndefined();
    expect(resolveAssignmentRoundState(null)).toBeUndefined();
    expect(resolveAssignmentRoundState('nonsense')).toBeUndefined();
    expect(resolveAssignmentRoundState({})).toBeUndefined();
    expect(resolveAssignmentRoundState({ id: 'a' })).toBeUndefined();
    expect(resolveAssignmentRoundState({ id: 'a', round: 1 })).toBeUndefined();
    // A record from a FUTURE version with an unknown stage is not a stage we can
    // act on — it must not read as "delivered".
    expect(resolveAssignmentRoundState({ id: 'a', round: 1, stage: 'partially' })).toBeUndefined();
    // A well-formed record with a missing writeScope survives as an empty list.
    expect(resolveAssignmentRoundState({ id: 'a', round: 2, stage: 'delivered' })).toMatchObject({
      id: 'a',
      round: 2,
      stage: 'delivered',
      writeScope: [],
    });
  });

  it('the service read path returns undefined for a corrupt stored record', async () => {
    const rig = await openRig([]);
    rig.db.projections.save(rig.runId, assignmentRoundProjectionName('ghost'), { legacy: true });
    expect(rig.service.getAssignmentRound(rig.runId, 'ghost')).toBeUndefined();
    expect(rig.service.getAssignmentRound(rig.runId, 'never-written')).toBeUndefined();
  }, 30_000);
});

// ---------------------------------------------------------------------------
describe('B5 — the status quo is untouched', () => {
  it('a run with NO assignments drives exactly ONE implementor with the whole-root boundary', async () => {
    const rig = await openRig([
      { scope: '', writes: [{ relPath: 'src/api.ts', content: 'export const api = 1;\n' }] },
    ]);
    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig));
    expect(rig.observed.implementorScopes).toEqual([[]]);
    expect(result.outcome).toBe('merge_ready');
    expect(result.rounds[0]?.implementation?.assignments).toBeUndefined();
  }, 60_000);

  it('a SINGLE-entry decomposition is not a fan-out — one implementor, its declared scope', async () => {
    const rig = await openRig([
      { scope: 'src', writes: [{ relPath: 'src/api.ts', content: 'export const api = 1;\n' }] },
    ]);
    const result = await runImplementVerifyLoop(
      loopDeps(rig),
      loopInput(rig, [{ id: 'only', taskScope: 'everything', writeScope: ['src'] }]),
    );
    // The scope still narrows the round (B4), but nothing is fanned out.
    expect(rig.observed.implementorScopes).toEqual([[]]);
    expect(result.rounds[0]?.implementation?.assignments).toBeUndefined();
    expect(result.outcome).toBe('merge_ready');
  }, 60_000);
});


// ---------------------------------------------------------------------------
describe('B5 — a decomposition that cannot fit the spawn cap is refused up front', () => {
  it('REFUSES when the run is pinned to fewer live children than it has assignments', async () => {
    const rig = await openRig([], unwrap(parseEngineConfig({ verification: { allowSameHarness: true }, maxLiveChildren: 1 })));
    const thrown: unknown = await runImplementVerifyLoop(
      loopDeps(rig),
      loopInput(rig, TWO_ASSIGNMENTS),
    ).catch((error: unknown) => error);
    expect((thrown as Error).message).toContain('maxLiveChildren=1');
    // Refused BEFORE anything spawned — never half a fan-out reported as one
    // assignment mysteriously failing.
    expect(rig.observed.implementorScopes).toEqual([]);
  }, 60_000);

  it('does NOT refuse a decomposition that fits (the cap is a floor, not a guess)', async () => {
    const rig = await openRig(
      [
        { scope: 'src', writes: [{ relPath: 'src/api.ts', content: 'export const api = 1;\n' }] },
        { scope: 'web', writes: [{ relPath: 'web/ui.ts', content: 'export const ui = 1;\n' }] },
      ],
      unwrap(parseEngineConfig({ verification: { allowSameHarness: true }, maxLiveChildren: 2 })),
    );
    const result = await runImplementVerifyLoop(loopDeps(rig), loopInput(rig, TWO_ASSIGNMENTS));
    expect(result.outcome).toBe('merge_ready');
  }, 60_000);
});


// ---------------------------------------------------------------------------
describe('B5 — a SIBLING hitting a provider limit pauses the RUN, it does not just fail itself', () => {
  it('re-raises the run-level pause instead of committing a round whose run is suspended', async () => {
    const rig = await openRig([
      { scope: 'src', writes: [{ relPath: 'src/api.ts', content: 'export const api = 1;\n' }] },
      // The sibling's provider answers with a usage-limit envelope: the engine
      // durably pauses the RUN (T4) before the error reaches the fan-out.
      { scope: 'web', limit: true },
    ]);

    const thrown: unknown = await runImplementVerifyLoop(
      loopDeps(rig),
      loopInput(rig, TWO_ASSIGNMENTS),
    ).catch((error: unknown) => error);

    // The pause is what surfaces — NOT "the frontend assignment produced nothing".
    expect((thrown as Error).name).toBe('LimitPausedError');
    expect(rig.service.status(rig.runId).suspension).toBe('paused_limit');
    // …and NOTHING was committed: committing while the run is durably paused is
    // precisely the fan-out overruling the pause spine.
    const handle = rig.worktrees.handleFor(toAssignmentId(`asg_${rig.runId}`));
    expect(handle).toBeDefined();
    expect(await resolveSha(handle!.worktreePath, 'HEAD')).toBe(String(rig.baseCommit));
    // The sibling's verdict is still durable, so a resume knows it must re-drive.
    expect(rig.service.getAssignmentRound(rig.runId, 'frontend')?.stage).toBe('no_deliverable');
  }, 60_000);
});
