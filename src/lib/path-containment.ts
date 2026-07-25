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

/**
 * Drop TRAILING separators, because they route around the probe above.
 *
 *     lstat('link/')        -> ENOTDIR / ENOENT      ("absent")
 *     path.dirname('link/') -> the GRANDparent       (the link is never probed)
 *
 * One byte turns "this component resolves outside the root" into "this component
 * is not here, ask its parent" — and the parent IS inside. Demonstrated against
 * this repo: with `node_modules/.bin` as the root, `tsx` declines and `tsx/`
 * admitted, the same symlink to `node_modules/tsx/dist/cli.mjs`.
 *
 * Stripping preserves meaning rather than merely deleting bytes: `link/` denotes
 * the directory `link` points at, and probing `link` resolves exactly that
 * target — so an escaping link still declines and an inside one still admits.
 * `path.normalize` is NOT usable here: it keeps one trailing separator and it
 * collapses `..` lexically, which is the behaviour this module exists to refuse.
 *
 * ONLY `/`. A backslash is an ordinary FILENAME byte on this platform — the
 * package declares `"os": ["darwin"]`, and POSIX has exactly one separator. An
 * earlier version stripped `\` too, which rewrote `<root>\` — a real SIBLING
 * entry of the root — into `<root>` itself, so the helper answered about a
 * directory the caller never named and both consumers admitted an outside path.
 * Treating a byte as structure is how a filename becomes a boundary crossing.
 *
 * The `> 1` floor keeps the filesystem root `/` intact.
 */
function withoutTrailingSlashes(p: string): string {
  let end = p.length;
  while (end > 1 && p[end - 1] === '/') end -= 1;
  return p.slice(0, end);
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
  // EVERY iteration is normalised, not just the entry. An earlier version
  // normalised once and argued that `path.dirname` never emits a trailing
  // separator, so the walk could not regenerate the condition. That is false:
  //
  //     path.dirname('link//missing') === 'link/'
  //
  // — any interior doubled separator makes the step produce exactly the shape
  // the entry normalisation existed to remove, and the next probe then skips the
  // `link` component. Rather than reason about which inputs can reach which
  // step, each iteration is made independently safe. It is one string scan per
  // level; the property it buys is that no step's OUTPUT can be un-normalised,
  // whatever the input was.
  let current = withoutTrailingSlashes(candidate);
  for (;;) {
    const probe = probeComponent(current);
    if (probe === 'present') return { kind: 'found', path: current };
    if (probe === 'undecidable') return { kind: 'undecidable' };
    const parent = withoutTrailingSlashes(path.dirname(current));
    // Terminates: `withoutTrailingSlashes` and `dirname` are both non-lengthening,
    // so `current` strictly shrinks until it stops changing — at the filesystem
    // root, whose non-existence cannot happen on a mounted tree but is reported
    // honestly rather than assumed away.
    if (parent === current) return { kind: 'undecidable' };
    current = parent;
  }
}

/**
 * True when any component of `p` is `..`.
 *
 * Split on `/` ONLY. A backslash is a filename byte here (`"os": ["darwin"]`),
 * so `a\..\b` is one legitimate component, not a traversal — reading it as three
 * would refuse a real in-worktree file, and a false denial ends an agent's turn
 * before its work is committed. That is the failure this whole item is about.
 */
function hasParentSegment(p: string): boolean {
  return p.split('/').includes('..');
}

/**
 * TRUE containment: `candidate` resolves inside `root` on the real filesystem.
 *
 * Both arguments must be ABSOLUTE. A relative path would be resolved against
 * `process.cwd()` by the fs calls below — an answer to a question nobody asked —
 * so it is refused instead. A `..` component on either side is refused for the
 * reason in the module header: `realpathSync` cannot be trusted to resolve one.
 *
 * Trailing SLASHES are stripped from BOTH sides — the candidate on every step of
 * the ancestor walk, the root here — so `<root>/` and `<root>` are the same
 * boundary and `link/` is judged as the `link` it is. Only `/`: a backslash is a
 * filename byte on this platform, never structure.
 */
export function resolvesInsideRoot(root: string, candidate: string): boolean {
  if (!path.isAbsolute(root) || !path.isAbsolute(candidate)) return false;
  if (hasParentSegment(root) || hasParentSegment(candidate)) return false;
  try {
    const realRoot = realpathSync(withoutTrailingSlashes(root));
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
