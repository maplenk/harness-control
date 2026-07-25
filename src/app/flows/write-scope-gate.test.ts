/**
 * B4 — the HOST-SIDE write-scope gate, at the moment the host decides what
 * enters HEAD.
 *
 * Implementors never run git; the host stages and commits. So whatever an agent
 * managed to write, nothing becomes part of the deliverable except through the
 * commit path — which makes it the one chokepoint that holds for EVERY harness,
 * including the ones whose writes this engine does not mediate at the ACP layer.
 *
 * The fake adapter here writes files directly into the session cwd, deliberately
 * bypassing permission mediation (that is what `implementor.test.ts`'s own
 * factory does, and it is exactly the threat model: a provider that wrote
 * somewhere the ACP rule never saw).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assignmentId, criterionId, gitSha, specHash } from '../../domain/ids.js';
import { DeterministicIdFactory } from '../../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../../persistence/test-support.js';
import { GitWorktreeManager, resolveSha } from '../../worktree/index.js';
import { makeTempGitRepo, type TempGitRepo } from '../../worktree/test-support.js';
import { InProcessFakeAdapter, type InProcessTurnScript, type PromptInput, type PromptResult } from '../../adapters/index.js';
import { OrchestrationService, type RoleAdapterFactory } from '../service.js';
import { createRunFixture } from '../test-support.js';
import { runImplementor, WriteScopeViolationError, type ImplementorContext } from './implementor.js';

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;
const CODEX_IMPLEMENTOR = { harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' } as const;

const REPORTING_TURN: InProcessTurnScript = {
  updates: [{ kind: 'agent_message_chunk', text: 'done' }],
  result: { stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, source: 'adapter' } },
};

let repo: TempGitRepo | undefined;
let dbHandle: TestDatabaseHandle | undefined;
afterEach(async () => {
  await dbHandle?.close();
  dbHandle = undefined;
  await repo?.cleanup();
  repo = undefined;
});

function context(): ImplementorContext {
  return {
    goal: 'g',
    specHash: specHash('spec_hash_scope'),
    specDocument: 'doc',
    criteria: [{ id: criterionId('C1'), description: 'x', verificationCommands: ['echo ok'] }],
    taskScope: 'scoped work',
  };
}

/** A fake provider that writes exactly `writes` into its session cwd. */
function writingFactory(writes: ReadonlyArray<{ readonly relPath: string; readonly content: string }>): {
  factory: RoleAdapterFactory;
  boundaries: Array<readonly string[] | undefined>;
} {
  const boundaries: Array<readonly string[] | undefined> = [];
  const factory: RoleAdapterFactory = {
    create(options) {
      boundaries.push(options.writeBoundary?.declared);
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        // §11.2 model/effort pins must succeed or `runRole` pauses the run;
        // these are the same descriptors `implementor.test.ts` uses.
        capabilities: {
          configOptions: [
            { id: 'model', kind: 'model', values: ['gpt-5.6-terra', 'gpt-5.6-sol'], current: 'gpt-5.6-sol' },
            {
              id: 'model_reasoning_effort',
              kind: 'reasoning',
              values: ['minimal', 'low', 'medium', 'high'],
              current: 'medium',
            },
          ],
        },
        turns: [REPORTING_TURN],
      });
      const origPrompt = adapter.prompt.bind(adapter);
      (adapter as unknown as { prompt: (input: PromptInput) => Promise<PromptResult> }).prompt = async (input) => {
        for (const write of writes) {
          const target = path.join(options.cwd, write.relPath);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, write.content, 'utf8');
        }
        return origPrompt(input);
      };
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
  return { factory, boundaries };
}

async function rig(writes: ReadonlyArray<{ readonly relPath: string; readonly content: string }>) {
  repo = await makeTempGitRepo('harness-write-scope-gate-');
  await repo.writeFile('src/keep.ts', 'export const a = 1;\n');
  await repo.writeFile('web/keep.ts', 'export const b = 2;\n');
  await repo.commitAll('seed');
  dbHandle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const worktrees = await GitWorktreeManager.open({
    primaryRepoRoot: repo.dir,
    clock: dbHandle.db.clock,
  });
  const { factory, boundaries } = writingFactory(writes);
  const service = new OrchestrationService({
    db: dbHandle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: factory,
  });
  const { runId } = createRunFixture(service, {
    goal: 'g',
    workspacePath: repo.dir,
    coordinator: CLAUDE_LOW,
  });
  return { service, worktrees, repo, runId, boundaries };
}

describe('the commit gate refuses a round that wrote outside its declared scope', () => {
  it('REFUSES, and nothing is committed', async () => {
    const rigged = await rig([
      { relPath: 'src/mine.ts', content: 'export const m = 1;\n' },
      // The violation: a provider write the ACP rule never mediated.
      { relPath: 'web/not-mine.ts', content: 'export const n = 1;\n' },
    ]);
    const headBefore = await rigged.repo.headSha();

    const error: unknown = await runImplementor(
      { service: rigged.service, worktrees: rigged.worktrees },
      {
        runId: rigged.runId,
        assignmentId: assignmentId('asg_scoped'),
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(headBefore),
        writeScope: ['src'],
        context: context(),
      },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WriteScopeViolationError);
    const violation = error as WriteScopeViolationError;
    expect(violation.declaredScope).toEqual(['src']);
    expect(violation.outsidePaths.some((p) => p.endsWith('/web/not-mine.ts'))).toBe(true);
    // The in-scope write is NOT named: the refusal reports only what it cannot
    // account for.
    expect(violation.outsidePaths.some((p) => p.endsWith('/src/mine.ts'))).toBe(false);

    // Nothing was committed: the worktree HEAD is still the base, so no verifier
    // could ever bind to a commit carrying content this assignment does not own.
    const handle = rigged.worktrees.handleFor(assignmentId('asg_scoped'));
    expect(handle).toBeDefined();
    expect(await resolveSha(handle!.worktreePath, 'HEAD')).toBe(headBefore);
    // The out-of-scope file is still on disk, unstaged, for an operator to see —
    // the refusal reports the violation, it does not tidy it away.
    expect(fs.existsSync(path.join(handle!.worktreePath, 'web/not-mine.ts'))).toBe(true);
  });

  it('ADMITS a round that stayed inside its scope', async () => {
    const rigged = await rig([{ relPath: 'src/mine.ts', content: 'export const m = 1;\n' }]);
    const result = await runImplementor(
      { service: rigged.service, worktrees: rigged.worktrees },
      {
        runId: rigged.runId,
        assignmentId: assignmentId('asg_ok'),
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await rigged.repo.headSha()),
        writeScope: ['src'],
        context: context(),
      },
    );
    expect(result.committed).toBe(true);
    expect(result.changedFiles).toEqual(['src/mine.ts']);
    // …and the boundary really reached the provider, so the ACP write rule was
    // narrowed for the same round the commit gate narrowed.
    expect(rigged.boundaries).toContainEqual(['src']);
  });

  it('is a NO-OP in worktree mode with no declared scope (the status quo)', async () => {
    // The identical out-of-scope write, with no scope declared: the boundary is
    // the whole worktree, nothing is outside it, and the round commits exactly
    // as it always has. This is what "worktree mode behaves as it did" means.
    const rigged = await rig([
      { relPath: 'src/mine.ts', content: 'export const m = 1;\n' },
      { relPath: 'web/anywhere.ts', content: 'export const n = 1;\n' },
    ]);
    const result = await runImplementor(
      { service: rigged.service, worktrees: rigged.worktrees },
      {
        runId: rigged.runId,
        assignmentId: assignmentId('asg_unscoped'),
        implementor: CODEX_IMPLEMENTOR,
        baseCommit: gitSha(await rigged.repo.headSha()),
        context: context(),
      },
    );
    expect(result.committed).toBe(true);
    expect([...result.changedFiles].sort()).toEqual(['src/mine.ts', 'web/anywhere.ts']);
    expect(rigged.boundaries).toContainEqual([]); // whole-root boundary, no scope
  });
});
