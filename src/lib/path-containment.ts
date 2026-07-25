/**
 * Filesystem CONTAINMENT — "does this path really resolve inside that root?" —
 * as ONE implementation.
 *
 * Two independent boundaries need this question answered: the ACP
 * structured-write rule (`isWorkspaceWriteOperation`, which decides whether a
 * `Write`/`Edit` target is inside the assigned worktree) and the Grok read-only
 * shell classifier (F14, which decides whether an absolute path ARGUMENT is
 * inside it). They were one copy-paste away from being two implementations of a
 * security boundary, and this codebase has already paid for duplicated scanners
 * once: the F11 pre-quote character scan lived in two places, and fixing either
 * one alone changed nothing.
 *
 * The construction, and why each part is load-bearing:
 *
 *  - **`path.relative`, not a string prefix.** Assignment worktrees are created
 *    as SIBLINGS under `<repo>.worktrees/`, so `…/assignment-asg_run_a` is a
 *    string prefix of `…/assignment-asg_run_a-2`. A `startsWith` test calls the
 *    second one "inside" the first.
 *
 *  - **`realpathSync` on BOTH sides, not `path.resolve`.** `path.resolve`
 *    collapses `..` LEXICALLY, before any symlink resolves, so `<root>/link/../x`
 *    can look contained while landing outside. Only asking the filesystem what a
 *    path really names answers the question that matters.
 *
 *  - **The nearest EXISTING ancestor.** `realpathSync` fails on a path that does
 *    not exist yet, and "the file is not there yet" is a legitimate answer for a
 *    write target (and for a read that will simply fail). Walking up to the first
 *    existing ancestor and resolving THAT keeps the symlink resolution honest for
 *    every component that exists, which is every component an escape could use.
 *
 *  - **A `..` SEGMENT is refused, not resolved.** Node's `fs.realpathSync` is NOT
 *    POSIX `realpath(3)`: it begins with `path.resolve(p)`, which collapses `..`
 *    LEXICALLY, and only then walks the components resolving symlinks. Measured
 *    on this tree (node 24, darwin) with `escape` a symlink to a directory
 *    outside the root:
 *
 *        realpathSync(`${root}/escape`)     -> <outside>          (correct)
 *        realpathSync(`${root}/escape/..`)  -> <root>             (WRONG: the
 *                                                                  kernel says
 *                                                                  <outside>/..)
 *
 *    So the very tool used to defeat lexical collapse performs one itself as soon
 *    as the path contains `..`. Resolving such a path correctly means
 *    reimplementing `realpath(3)` component by component; declining to answer is
 *    the honest alternative, and `..` never appears in a path anyone needs.
 *    (This closed a live escape: a `Write` target of `<root>/link/../x` was
 *    ADMITTED by the pre-F14 workspace-write rule and lands outside the root.)
 *
 *  - **Every failure is a refusal.** An unresolvable root, a filesystem error, a
 *    relative path on either side: inability to determine containment is never
 *    evidence of containment.
 */
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';

/**
 * LEXICAL containment of two already-resolved paths. Not sufficient on its own —
 * it is the second half of `resolvesInsideRoot`, applied to realpaths.
 */
export function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * The first ancestor of `candidate` that exists on disk (the path itself when it
 * exists). `undefined` only when the walk reaches a filesystem root that does not
 * exist, which cannot happen on a mounted tree but is reported honestly rather
 * than assumed away.
 */
export function nearestExistingAncestor(candidate: string): string | undefined {
  let current = candidate;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** True when any component of `p` is `..` (either separator, so a Windows-shaped
 * path cannot smuggle one past a POSIX-only split). */
function hasParentSegment(p: string): boolean {
  return p.split(/[/\\]/u).includes('..');
}

/**
 * TRUE containment: `candidate` resolves inside `root` on the real filesystem.
 *
 * Both arguments must be ABSOLUTE. A relative path would be resolved against
 * `process.cwd()` by the fs calls below — an answer to a question nobody asked —
 * so it is refused instead. A `..` component on either side is refused for the
 * reason in the module header: `realpathSync` cannot be trusted to resolve one.
 */
export function resolvesInsideRoot(root: string, candidate: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) return false;
  if (hasParentSegment(root) || hasParentSegment(candidate)) return false;
  try {
    const realRoot = realpathSync(root);
    const ancestor = nearestExistingAncestor(candidate);
    if (ancestor === undefined) return false;
    return isPathInside(realRoot, realpathSync(ancestor));
  } catch {
    return false;
  }
}
