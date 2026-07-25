/**
 * The containment primitive shared by the ACP structured-write rule and the Grok
 * read-only shell classifier (F14). Both consumers have their own end-to-end
 * tests; these pin the PRIMITIVE's own edges — the ones a consumer's test would
 * only reach by accident.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isPathInside, nearestExistingAncestor, resolvesInsideRoot } from './path-containment.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  readonly base: string;
  readonly root: string;
  readonly sibling: string;
  readonly outside: string;
  /** A symlink inside the root whose target does not exist. */
  readonly dangling: string;
  /** The path that symlink would create/name if anything followed it. */
  readonly danglingTarget: string;
}

function fixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), 'path-containment-test-'));
  tempDirs.push(base);
  const root = path.join(base, 'worktrees', 'assignment-a');
  const sibling = `${root}-2`; // `root` is a STRING PREFIX of this path.
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'web'), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(outside, 'secret.txt'), 'x', 'utf8');
  symlinkSync(outside, path.join(root, 'escape'));
  symlinkSync(path.join(root, 'web'), path.join(root, 'inner-link'));
  // A DANGLING symlink pointing out of the root: the link exists, its target
  // does not (yet).
  const danglingTarget = path.join(base, 'not-created-yet');
  const dangling = path.join(root, 'dangling');
  symlinkSync(danglingTarget, dangling);
  // A symlink LOOP: resolving it raises ELOOP, which is neither presence nor
  // absence.
  symlinkSync(path.join(root, 'loop-b'), path.join(root, 'loop-a'));
  symlinkSync(path.join(root, 'loop-a'), path.join(root, 'loop-b'));
  return { base, root, sibling, outside, dangling, danglingTarget };
}

describe('resolvesInsideRoot', () => {
  it('admits the root itself and anything that really lives under it', () => {
    const { root } = fixture();
    expect(resolvesInsideRoot(root, root)).toBe(true);
    expect(resolvesInsideRoot(root, path.join(root, 'web'))).toBe(true);
    // Not created yet: the nearest EXISTING ancestor decides.
    expect(resolvesInsideRoot(root, path.join(root, 'web', 'deep', 'new.txt'))).toBe(true);
    // A symlink that stays inside is inside.
    expect(resolvesInsideRoot(root, path.join(root, 'inner-link', 'file.txt'))).toBe(true);
  });

  it('refuses everything outside, including a SHARED-PREFIX sibling', () => {
    const { root, sibling, outside, base } = fixture();
    expect(resolvesInsideRoot(root, outside)).toBe(false);
    expect(resolvesInsideRoot(root, base)).toBe(false);
    expect(resolvesInsideRoot(root, path.dirname(root))).toBe(false);
    expect(resolvesInsideRoot(root, '/etc/passwd')).toBe(false);
    // `sibling.startsWith(root)` is TRUE — a prefix test would admit this.
    expect(sibling.startsWith(root)).toBe(true);
    expect(resolvesInsideRoot(root, path.join(sibling, 'secret.txt'))).toBe(false);
  });

  it('refuses a symlink that leaves the root, with no `..` involved', () => {
    const { root, outside } = fixture();
    expect(realpathSync(path.join(root, 'escape'))).toBe(realpathSync(outside));
    expect(resolvesInsideRoot(root, path.join(root, 'escape'))).toBe(false);
    expect(resolvesInsideRoot(root, path.join(root, 'escape', 'secret.txt'))).toBe(false);
  });

  it('REFUSES a `..` segment rather than resolving one (realpathSync cannot be trusted with it)', () => {
    const { root } = fixture();
    // The trap, asserted: Node's realpathSync `path.resolve`s FIRST, so it
    // collapses this `..` lexically and reports the root — even though the
    // kernel would leave from `escape`'s target, outside the root.
    expect(realpathSync(`${root}/escape/..`)).toBe(realpathSync(root));
    expect(resolvesInsideRoot(root, `${root}/escape/../pwned.txt`)).toBe(false);
    expect(resolvesInsideRoot(root, `${root}/web/../web/file.txt`)).toBe(false);
    expect(resolvesInsideRoot(root, `${root}/..`)).toBe(false);
    // Either separator, so a Windows-shaped path cannot smuggle one past a
    // POSIX-only split.
    expect(resolvesInsideRoot(root, `${root}\\..\\pwned.txt`)).toBe(false);
    // ...and a `..` in the ROOT is refused for the same reason.
    expect(resolvesInsideRoot(`${root}/escape/..`, path.join(root, 'web'))).toBe(false);
  });

  // -------------------------------------------------------------------------
  // A component that EXISTS but cannot be RESOLVED is not an absent component.
  // `existsSync` conflates them: it follows symlinks, so a dangling link reports
  // `false`, and it swallows every error code, so an unreadable or ELOOP
  // component reports `false` too. The ancestor walk then STEPS OVER the
  // undecidable component and answers about a shallower path that really is
  // inside the root — an approval derived from a question we failed to ask.
  //
  // `Write <root>/dangling` is the sharpest form: the link exists, `existsSync`
  // says it does not, the walk selects `<root>`, containment says yes — and the
  // write follows the link and CREATES a file outside the worktree. No race
  // required.
  // -------------------------------------------------------------------------
  it('DECLINES a dangling symlink component instead of treating it as absent', () => {
    const { root, dangling, danglingTarget } = fixture();
    // The conflation, pinned: `existsSync` cannot tell these two apart...
    expect(existsSync(dangling)).toBe(false);
    expect(existsSync(path.join(root, 'never-existed'))).toBe(false);
    // ...but one of them is a real directory entry that names a path OUTSIDE.
    expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
    expect(resolvesInsideRoot(root, danglingTarget)).toBe(false);

    expect(resolvesInsideRoot(root, dangling)).toBe(false);
    expect(resolvesInsideRoot(root, path.join(root, 'dangling', 'file.txt'))).toBe(false);
    // ...while a genuinely absent tail component is still admissible — that is
    // the case this walk exists to serve, and it must survive the tightening.
    expect(resolvesInsideRoot(root, path.join(root, 'never-existed'))).toBe(true);
    expect(resolvesInsideRoot(root, path.join(root, 'web', 'a', 'b.txt'))).toBe(true);
  });

  it('DECLINES when a component cannot be stat-ed at all (errors are not absence)', () => {
    const { root } = fixture();
    // ELOOP: `loop-a` -> `loop-b` -> `loop-a`. The link exists; resolving it
    // cannot terminate.
    expect(lstatSync(path.join(root, 'loop-a')).isSymbolicLink()).toBe(true);
    expect(existsSync(path.join(root, 'loop-a'))).toBe(false); // indistinguishable from absent
    expect(resolvesInsideRoot(root, path.join(root, 'loop-a'))).toBe(false);
    expect(resolvesInsideRoot(root, path.join(root, 'loop-a', 'file.txt'))).toBe(false);

    // ENAMETOOLONG: a component longer than NAME_MAX. `existsSync` reports
    // `false` — the same answer it gives for a path that simply is not there —
    // and the walk would step over it to `<root>`.
    const tooLong = path.join(root, 'x'.repeat(5_000), 'file.txt');
    expect(existsSync(tooLong)).toBe(false);
    expect(resolvesInsideRoot(root, tooLong)).toBe(false);
  });

  it('fails closed on anything it cannot decide', () => {
    const { root } = fixture();
    expect(resolvesInsideRoot(root, 'web/file.txt')).toBe(false); // relative candidate
    expect(resolvesInsideRoot('worktrees/assignment-a', path.join(root, 'web'))).toBe(false); // relative root
    expect(resolvesInsideRoot('', path.join(root, 'web'))).toBe(false);
    expect(resolvesInsideRoot(root, '')).toBe(false);
    expect(resolvesInsideRoot('/no-such-root-path-containment', path.join(root, 'web'))).toBe(false);
    expect(resolvesInsideRoot(root, '/no-such-absolute-path/file.txt')).toBe(false);
    // A NUL-bearing component can name nothing on disk, so the ancestor walk
    // steps PAST the root and the containment test refuses it.
    expect(resolvesInsideRoot(root, `${root}\0/file.txt`)).toBe(false);
  });
});

describe('isPathInside / nearestExistingAncestor', () => {
  it('treats identity as inside and a prefix-sharing sibling as outside', () => {
    expect(isPathInside('/a/b', '/a/b')).toBe(true);
    expect(isPathInside('/a/b', '/a/b/c')).toBe(true);
    expect(isPathInside('/a/b', '/a/bc')).toBe(false);
    expect(isPathInside('/a/b', '/a')).toBe(false);
    expect(isPathInside('/a/b', '/')).toBe(false);
  });

  it('walks up to the first path that exists, and reports what it could not decide', () => {
    const { root, dangling } = fixture();
    expect(nearestExistingAncestor(path.join(root, 'web'))).toEqual({
      kind: 'found',
      path: path.join(root, 'web'),
    });
    expect(nearestExistingAncestor(path.join(root, 'web', 'a', 'b', 'c.txt'))).toEqual({
      kind: 'found',
      path: path.join(root, 'web'),
    });
    expect(nearestExistingAncestor('/definitely/not/here')).toEqual({ kind: 'found', path: '/' });
    // A dangling symlink is an ENTRY, so the walk stops AT it and hands the
    // caller a path `realpathSync` will refuse — never steps over it.
    expect(nearestExistingAncestor(dangling)).toEqual({ kind: 'found', path: dangling });
    expect(nearestExistingAncestor(path.join(dangling, 'file.txt'))).toEqual({
      kind: 'found',
      path: dangling,
    });
    // An error that is not absence is reported as exactly that.
    expect(nearestExistingAncestor(path.join(root, 'x'.repeat(5_000), 'f'))).toEqual({
      kind: 'undecidable',
    });
  });
});
