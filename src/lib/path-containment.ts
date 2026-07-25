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
 *  - **The nearest EXISTING ancestor, probed with `lstat`.** `realpathSync` fails
 *    on a path that does not exist yet, and "the file is not there yet" is a
 *    legitimate answer for a write target (and for a read that will simply fail).
 *    Walking up to the first existing ancestor and resolving THAT keeps the
 *    symlink resolution honest for every component that exists, which is every
 *    component an escape could use. The walk probes with `lstat` and acts on the
 *    error CODE, because an unresolvable component is not an absent one: a
 *    dangling symlink is a real entry that `existsSync` calls `false`, and
 *    stepping over it approves a shallower path while `Write <root>/dangling`
 *    follows the link and creates a file OUTSIDE the root — no race required.
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
import { lstatSync, realpathSync } from 'node:fs';
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
 * What one path component turned out to be.
 *
 * `existsSync` cannot express this, and that is the whole problem: it FOLLOWS
 * symlinks (so a dangling link reports `false`) and it swallows every error code
 * (so ELOOP, EACCES and ENAMETOOLONG report `false` too). An ancestor walk built
 * on it steps OVER an undecidable component and answers about a shallower path
 * that really is inside the root — an approval derived from a question we failed
 * to ask.
 *
 * `ENOENT`/`ENOTDIR` are the only definitive non-existence answers (the F9
 * `lstatSafe` contract, `worktree/provision.ts`). Everything else is an unknown,
 * and unknowns refuse.
 */
type ComponentProbe = 'present' | 'absent' | 'undecidable';

function probeComponent(target: string): ComponentProbe {
  try {
    // lstat, NOT stat: a symlink is an ENTRY whether or not its target exists.
    // Stopping AT the link hands `realpathSync` the job of resolving it, which
    // is exactly who should decide whether it lands inside the root.
    lstatSync(target);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'undecidable';
  }
}

/** The outcome of the ancestor walk — `undecidable` is a first-class answer. */
export type AncestorResolution =
  | { readonly kind: 'found'; readonly path: string }
  | { readonly kind: 'undecidable' };

/**
 * The first ancestor of `candidate` that EXISTS as a directory entry (the path
 * itself when it does). A genuinely absent tail component is skipped — that is
 * what makes a not-yet-created target answerable — but a component that exists
 * and cannot be resolved, or whose stat fails for any reason other than plain
 * absence, ends the walk as `undecidable`.
 */
export function nearestExistingAncestor(candidate: string): AncestorResolution {
  let current = candidate;
  for (;;) {
    const probe = probeComponent(current);
    if (probe === 'present') return { kind: 'found', path: current };
    if (probe === 'undecidable') return { kind: 'undecidable' };
    const parent = path.dirname(current);
    // A filesystem root that does not exist cannot happen on a mounted tree;
    // reported honestly rather than assumed away.
    if (parent === current) return { kind: 'undecidable' };
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
    if (ancestor.kind !== 'found') return false;
    // `realpathSync` on a DANGLING link throws ENOENT and on a LOOP throws
    // ELOOP; both land in the catch below, which is the correct answer — the
    // path exists and names nothing we can place.
    return isPathInside(realRoot, realpathSync(ancestor.path));
  } catch {
    return false;
  }
}
