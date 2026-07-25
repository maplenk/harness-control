/**
 * B3 — the W3-1 confinement guard under `in_place` execution.
 *
 * W3-1 asks "did the declared verification commands touch a tree they were NOT
 * given?". In `worktree` mode the primary checkout is exactly such a tree (the
 * manager refuses to place a worktree inside it), and that behaviour is
 * unchanged. In `in_place` mode the primary checkout IS the tree the commands
 * were given, so comparing it before/after would report every `dist/` file a
 * build command legitimately emits as an escape — and block every in-place round
 * on its own build output.
 *
 * Both directions are asserted here, because "the guard is unchanged where it
 * means something" is the load-bearing half of the claim.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { artifactHash, criterionId, gitSha, runId, specHash } from '../../domain/ids.js';
import { DeterministicIdFactory } from '../../lib/id-factory.js';
import { ManualClock } from '../../lib/clock.js';
import { makeTempGitRepo, type TempGitRepo } from '../../worktree/test-support.js';
import { executeEvidenceReceiptsUnderConfinement } from './verifier.js';
import type { VerificationRunner } from './implementor.js';

let repo: TempGitRepo | undefined;
afterEach(async () => {
  await repo?.cleanup();
  repo = undefined;
});

/** Runs the confinement wrapper with `cwd` and `repoRoot` supplied explicitly. */
async function confined(opts: {
  readonly cwd: string;
  readonly repoRoot: string;
  readonly runner: VerificationRunner;
  readonly head: string;
}) {
  return executeEvidenceReceiptsUnderConfinement({
    runId: runId('run_inplace'),
    criteria: [
      {
        id: criterionId('AC-1'),
        description: 'a criterion whose declared command is host-executed',
        verificationCommands: ['declared-check'],
      },
    ],
    binding: { specHash: specHash('spec_inplace'), implementationCommit: gitSha(opts.head) },
    cwd: opts.cwd,
    repoRoot: opts.repoRoot,
    runner: opts.runner,
    evidence: { record: async () => artifactHash('sha256:inplace-evidence') },
    provisioningMarker: 'in_place:',
    ids: new DeterministicIdFactory(),
    clock: new ManualClock('2026-07-26T00:00:00.000Z'),
  });
}

/** A declared command that emits ordinary untracked build output. */
function buildOutputRunner(root: string): VerificationRunner {
  return async (command) => {
    fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(root, 'dist', 'bundle.js'), '// built\n', 'utf8');
    return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
  };
}

describe('in_place: the execution root IS the primary checkout', () => {
  it('does NOT report ordinary build output as a primary-checkout escape', async () => {
    repo = await makeTempGitRepo('harness-in-place-confinement-');
    await repo.writeFile('src/keep.ts', 'export const a = 1;\n');
    await repo.commitAll('seed');
    const head = await repo.headSha();

    const result = await confined({
      cwd: repo.dir,
      repoRoot: repo.dir, // in_place: one tree
      runner: buildOutputRunner(repo.dir),
      head,
    });

    expect(result.runnerViolations).toEqual([]);
    expect(result.authoredCommit).toBeUndefined();
    expect(result.receipts).toHaveLength(1);
  });

  it('STILL refuses a command that AUTHORS a commit (check 2 is unconditional)', async () => {
    // The half that must never be skipped: a declared command committing in the
    // tree is laundering, in-place or not.
    repo = await makeTempGitRepo('harness-in-place-confinement-');
    await repo.writeFile('src/keep.ts', 'export const a = 1;\n');
    await repo.commitAll('seed');
    const head = await repo.headSha();
    const committingRunner: VerificationRunner = async (command) => {
      await repo!.writeFile('src/sneaky.ts', 'export const s = 1;\n');
      await repo!.commitAll('authored by a verification command');
      return { exitCode: 0, stdout: `ran: ${command}`, stderr: '', launchFailed: false };
    };

    const result = await confined({ cwd: repo.dir, repoRoot: repo.dir, runner: committingRunner, head });

    expect(result.authoredCommit).toBeDefined();
    expect(result.authoredCommit?.before).toBe(head);
    expect(result.runnerViolations.length).toBeGreaterThan(0);
  });
});

describe('worktree mode is unchanged: a DIFFERENT primary checkout still catches an escape', () => {
  it('reports a write into the primary checkout as a runner violation', async () => {
    repo = await makeTempGitRepo('harness-in-place-confinement-');
    await repo.writeFile('src/keep.ts', 'export const a = 1;\n');
    await repo.commitAll('seed');
    const head = await repo.headSha();
    // A separate execution root, as `git worktree add` produces (the manager
    // refuses any worktree path inside the primary checkout).
    const executionRoot = fs.mkdtempSync(path.join(path.dirname(repo.dir), 'exec-root-'));
    fs.cpSync(path.join(repo.dir, '.git'), path.join(executionRoot, '.git'), { recursive: true });
    fs.writeFileSync(path.join(executionRoot, 'src.ts'), 'x\n', 'utf8');

    try {
      const result = await confined({
        cwd: executionRoot,
        repoRoot: repo.dir,
        runner: buildOutputRunner(repo.dir), // the command escapes into the PRIMARY
        head,
      });
      expect(result.runnerViolations.length).toBeGreaterThan(0);
      expect(result.runnerViolations[0]?.detail).toMatch(/primary checkout/i);
    } finally {
      fs.rmSync(executionRoot, { recursive: true, force: true });
    }
  });
});
