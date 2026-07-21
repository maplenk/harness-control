/**
 * Application-layer fixtures. This module is excluded from the production
 * build by tsconfig.build.json; it is the only supported way for tests to
 * manufacture metadata shaped like a run persisted before source pinning.
 */
import { execFileSync } from 'node:child_process';
import { gitSha, type GitSha } from '../domain/ids.js';
import type { Database } from '../persistence/database.js';
import {
  RUN_META_PROJECTION,
  type RunMeta,
} from './projections.js';
import type {
  CreateRunInput,
  CreateRunResult,
  OrchestrationService,
} from './service.js';

/** Stable synthetic commit for unit tests that do not exercise real Git. */
export const TEST_BASE_COMMIT: GitSha = gitSha('1111111111111111111111111111111111111111');

export type CreateRunFixtureInput = Omit<CreateRunInput, 'baseCommit'> & {
  readonly baseCommit?: GitSha;
};

function fixtureBaseCommit(workspacePath: string): GitSha {
  try {
    const resolved = execFileSync('git', ['rev-parse', '--verify', 'HEAD^{commit}'], {
      cwd: workspacePath,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^[0-9a-f]{40}$/.test(resolved)) return gitSha(resolved);
  } catch {
    // Synthetic unit-test workspaces use the stable fixture SHA below.
  }
  return TEST_BASE_COMMIT;
}

/** Create an ordinary fresh, pinned run for a unit test. */
export function createRunFixture(
  service: OrchestrationService,
  input: CreateRunFixtureInput,
): CreateRunResult {
  return service.createRun({
    ...input,
    baseCommit: input.baseCommit ?? fixtureBaseCommit(input.workspacePath),
  });
}

/**
 * Seed a pre-source-pinning history. The production service first creates a
 * valid pinned run, then this test-only persistence fixture removes the field
 * from immutable metadata to model a database written by an older version.
 */
export function createLegacyRunFixture(
  service: OrchestrationService,
  db: Database,
  input: CreateRunFixtureInput,
): CreateRunResult {
  const created = createRunFixture(service, input);
  const record = db.projections.get<RunMeta>(created.runId, RUN_META_PROJECTION);
  if (record === undefined) {
    throw new Error(`Missing run metadata fixture for ${created.runId}`);
  }
  const { baseCommit: _discarded, ...legacyMeta } = record.state;
  db.projections.save(created.runId, RUN_META_PROJECTION, legacyMeta, record.eventCursor);
  return created;
}

/** Clean, stable Git seam for tests whose workspace path is synthetic. */
export const CLEAN_PINNED_WORKSPACE_GIT = {
  resolveTopLevel: async (workspacePath: string): Promise<string> => workspacePath,
  readStableHeadAndStatus: async (): Promise<{
    headBefore: GitSha;
    headAfter: GitSha;
    statusPorcelain: string;
    stable: true;
  }> => ({
    headBefore: TEST_BASE_COMMIT,
    headAfter: TEST_BASE_COMMIT,
    statusPorcelain: '',
    stable: true,
  }),
  porcelainPaths: (): string[] => [],
} as const;
