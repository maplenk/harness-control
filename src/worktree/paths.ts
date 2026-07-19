/**
 * Deterministic, pure path/name resolution for worktrees (PLAN.md §16 item
 * 2: "create a dedicated branch and worktree OUTSIDE the primary
 * checkout"). No I/O, no clock, no randomness — everything here is a pure
 * function of its inputs, so it is trivially unit-testable and so that
 * `manager.ts` can compute (and validate) a worktree's path BEFORE doing
 * any filesystem or git work.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { AssignmentId } from '../domain/ids.js';

export type WorktreeBaseDirStrategy =
  | { readonly kind: 'sibling' }
  | { readonly kind: 'os_tmp' }
  | { readonly kind: 'explicit'; readonly dir: string };

/** PLAN §16 item 2: "default sibling dir or os tmp per config" — sibling is the default. */
export const DEFAULT_BASE_DIR_STRATEGY: WorktreeBaseDirStrategy = { kind: 'sibling' };

const SIBLING_SUFFIX = '.worktrees';
const OS_TMP_SUBDIR = 'harness-orchestration-worktrees';

/**
 * Resolves the directory UNDER which every worktree for `primaryRepoRoot`
 * is created. Both built-in strategies are deliberately never a
 * subdirectory of `primaryRepoRoot` itself: a worktree nested INSIDE the
 * primary checkout would show up as untracked content in the primary
 * checkout's OWN `git status`, defeating "outside the primary checkout"
 * and PLAN §19 test 17 ("worktree isolation leaves primary checkout
 * untouched"). `manager.ts` additionally guards this at runtime via
 * `isPathInside` in case an `explicit` strategy is misconfigured.
 */
export function resolveBaseDir(primaryRepoRoot: string, strategy: WorktreeBaseDirStrategy): string {
  const resolvedRepoRoot = path.resolve(primaryRepoRoot);
  switch (strategy.kind) {
    case 'sibling':
      return `${resolvedRepoRoot}${SIBLING_SUFFIX}`;
    case 'os_tmp':
      return path.join(os.tmpdir(), OS_TMP_SUBDIR);
    case 'explicit':
      return path.resolve(strategy.dir);
    default: {
      const exhaustive: never = strategy;
      throw new Error(`Unknown worktree base dir strategy: ${String(exhaustive)}`);
    }
  }
}

const DIR_PREFIX = 'assignment-';
const BRANCH_PREFIX = 'harness/assignment/';

/**
 * Filesystem+git-ref-safe slug from an id string. Today's `AssignmentId`s
 * are already shaped like `asg_000001` (safe as-is on both fronts), but
 * this defends against any future id shape (or a foreign/imported id)
 * that isn't.
 */
function sanitizeSlug(raw: string): string {
  const slug = raw.replace(/[^a-zA-Z0-9._-]/g, '-');
  if (slug.length === 0) {
    throw new Error(`Assignment id sanitizes to an empty slug: ${JSON.stringify(raw)}`);
  }
  return slug;
}

export function worktreePathFor(baseDir: string, assignmentId: AssignmentId): string {
  return path.join(baseDir, `${DIR_PREFIX}${sanitizeSlug(String(assignmentId))}`);
}

export function branchNameFor(assignmentId: AssignmentId): string {
  return `${BRANCH_PREFIX}${sanitizeSlug(String(assignmentId))}`;
}

/** True when `candidate` IS `ancestor`, or is nested inside it. Used to guard against a worktree landing inside the primary checkout. */
export function isPathInside(ancestor: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(ancestor), path.resolve(candidate));
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}
