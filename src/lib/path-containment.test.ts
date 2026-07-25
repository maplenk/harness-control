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
  /** A symlink inside the root pointing at a FILE outside it — the exact shape
   * of `node_modules/.bin/tsx`, which is how the trailing-separator bypass was
   * demonstrated against this repo. */
  readonly fileLink: string;
  /** A REAL file named `<root>\` — a sibling of the root, OUTSIDE it. On darwin
   * (`"os": ["darwin"]`) a backslash is an ordinary filename byte. */
  readonly backslashSibling: string;
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
  // `node_modules/.bin/tsx`'s shape: a link inside the root naming a FILE
  // outside it.
  const fileLink = path.join(root, 'file-link');
  symlinkSync(path.join(outside, 'secret.txt'), fileLink);
  // A real entry named `<root>\`, living NEXT TO the root. Its last byte is a
  // backslash — an ordinary filename character here, not a separator.
  const backslashSibling = `${root}\\`;
  writeFileSync(backslashSibling, 'outside-secret\n', 'utf8');
  // ...and two entries INSIDE the root whose NAMES contain backslashes,
  // including one that spells a traversal in Windows syntax.
  writeFileSync(path.join(root, 'we\\ird.txt'), 'inside\n', 'utf8');
  writeFileSync(path.join(root, 'odd\\..\\name.txt'), 'inside\n', 'utf8');
  return { base, root, sibling, outside, dangling, danglingTarget, fileLink, backslashSibling };
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

  // -------------------------------------------------------------------------
  // A TRAILING SEPARATOR routed around the absent-vs-unresolvable switch before
  // the switch ever saw the real component.
  //
  //   lstat('link/')          -> ENOTDIR/ENOENT   (classified "absent")
  //   path.dirname('link/')   -> the GRANDparent  (the link is never probed)
  //
  // So the walk answered about a higher ancestor that is inside the root.
  // Demonstrated against this repo's own `node_modules/.bin`: with `.bin` as the
  // root, `tsx` correctly declines, `tsx/` admitted — same symlink, one byte
  // apart, and it resolves to `node_modules/tsx/dist/cli.mjs`, outside `.bin`.
  //
  // Note `link/.` was ALREADY correct: `path.dirname('link/.')` is `link`, so the
  // component still got probed. It is pinned below because the difference
  // between the two is exactly the thing that is easy to get wrong again.
  // -------------------------------------------------------------------------
  it('DECLINES a component named with a TRAILING SEPARATOR instead of skipping it', () => {
    const { root, fileLink, dangling } = fixture();
    // The mechanism, pinned: without normalisation these lstats are the ones
    // that get called "absent"...
    expect(() => lstatSync(`${fileLink}/`)).toThrow();
    // ...and this is the ancestor the walk would jump to.
    expect(path.dirname(`${fileLink}/`)).toBe(root);

    // codex's exact shape: a symlink to a FILE outside, probed with a trailing
    // separator.
    expect(resolvesInsideRoot(root, fileLink)).toBe(false);
    expect(resolvesInsideRoot(root, `${fileLink}/`)).toBe(false);
    expect(resolvesInsideRoot(root, `${fileLink}//`)).toBe(false);
    expect(resolvesInsideRoot(root, `${fileLink}/.`)).toBe(false);
    expect(resolvesInsideRoot(root, `${fileLink}/./`)).toBe(false);

    // A DANGLING link with a trailing separator — the same skip, reached through
    // ENOENT rather than ENOTDIR.
    expect(resolvesInsideRoot(root, `${dangling}/`)).toBe(false);
    expect(resolvesInsideRoot(root, `${dangling}//`)).toBe(false);
    expect(resolvesInsideRoot(root, `${dangling}/.`)).toBe(false);

    // A link to a DIRECTORY outside: `escape/` DENOTES that outside directory,
    // so normalising must keep declining it (this one lstat-ed as `present`
    // even before, and must not become an admit now).
    expect(resolvesInsideRoot(root, `${root}/escape/`)).toBe(false);
    expect(resolvesInsideRoot(root, `${root}/escape//`)).toBe(false);

    // And the walk itself now reports the component rather than its parent.
    expect(nearestExistingAncestor(`${fileLink}/`)).toEqual({ kind: 'found', path: fileLink });
  });

  it('a trailing separator changes no verdict for paths that really are inside', () => {
    const { root, outside } = fixture();
    expect(resolvesInsideRoot(root, `${root}/web/`)).toBe(true);
    expect(resolvesInsideRoot(root, `${root}/web//`)).toBe(true);
    expect(resolvesInsideRoot(root, `${root}/web/.`)).toBe(true);
    expect(resolvesInsideRoot(root, `${root}/inner-link/`)).toBe(true); // link INTO the root
    expect(resolvesInsideRoot(root, `${root}/`)).toBe(true);
    expect(resolvesInsideRoot(root, `${root}//`)).toBe(true);
    expect(resolvesInsideRoot(root, `${root}/never-existed/`)).toBe(true); // absent tail, still inside
    expect(resolvesInsideRoot(root, '/')).toBe(false);

    // The ROOT argument gets the same treatment: a root supplied with a trailing
    // separator behaves identically to one without, in both directions.
    for (const shaped of [`${root}/`, `${root}//`]) {
      expect(resolvesInsideRoot(shaped, path.join(root, 'web'))).toBe(true);
      expect(resolvesInsideRoot(shaped, `${root}/web/`)).toBe(true);
      expect(resolvesInsideRoot(shaped, outside)).toBe(false);
      expect(resolvesInsideRoot(shaped, `${root}/file-link/`)).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // The walk's OWN STEP can regenerate a trailing separator.
  //
  //     path.dirname('link//missing') === 'link/'
  //
  // Normalising only at entry assumed `path.dirname` never emits one. It does,
  // for any interior doubled separator — so the next probe is un-normalised, the
  // link component is skipped again, and the bypass closed one round earlier
  // comes straight back. Verified against this repo: with `.bin` as the root,
  // `.bin/tsx//missing`, `.bin/tsx//.` and `.bin/tsx//./` all admitted.
  //
  // The lesson, and the reason this test states the mechanism rather than just
  // the verdict: normalise what the ALGORITHM can produce, not the shapes you
  // happened to see. Each iteration is now independently safe.
  // -------------------------------------------------------------------------
  it('DECLINES when the walk itself would regenerate a trailing separator', () => {
    const { root, fileLink, dangling } = fixture();
    // The mechanism: dirname hands back a path ending in a separator.
    expect(path.dirname(`${fileLink}//missing`)).toBe(`${fileLink}/`);

    for (const candidate of [
      `${fileLink}//missing`, // codex's exact shape
      `${fileLink}//.`,
      `${fileLink}//./`,
      `${fileLink}//missing//deeper`,
      `${fileLink}///missing`,
      `${dangling}//missing`,
      `${root}/escape//missing`,
    ]) {
      expect(resolvesInsideRoot(root, candidate)).toBe(false);
    }

    // ...and a doubled separator over a path that really is inside still admits:
    // the tightening must not turn `//` itself into a refusal.
    expect(resolvesInsideRoot(root, `${root}/web//missing`)).toBe(true);
    expect(resolvesInsideRoot(root, `${root}//web//missing`)).toBe(true);
    expect(resolvesInsideRoot(root, `${root}/web//`)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // `\` IS A FILENAME BYTE. This package declares `"os": ["darwin"]`; POSIX has
  // exactly one separator. Stripping a trailing backslash rewrote `<root>\` —
  // which names a real SIBLING of the root — into `<root>` itself, and the
  // helper answered about a directory the caller never asked about. Both
  // consumers were reachable: the shell classifier admitted `cat '<root>\'`
  // (single-quoted, so the byte survives tokenisation) and the structured-write
  // rule returned `allowlisted_workspace_write` for ``Write `<root>\` ``.
  // -------------------------------------------------------------------------
  it('treats a backslash as a FILENAME byte, never as a separator', () => {
    const { root, backslashSibling } = fixture();
    // It is a real, distinct entry, and it is OUTSIDE the root.
    expect(lstatSync(backslashSibling).isFile()).toBe(true);
    expect(isPathInside(realpathSync(root), realpathSync(backslashSibling))).toBe(false);

    expect(resolvesInsideRoot(root, backslashSibling)).toBe(false);
    expect(resolvesInsideRoot(root, `${root}\\\\`)).toBe(false);
    expect(resolvesInsideRoot(root, `${root}\\dir`)).toBe(false);
    // A backslash-bearing ROOT is not silently rewritten either.
    expect(resolvesInsideRoot(backslashSibling, path.join(root, 'web'))).toBe(false);

    // The other direction: names containing backslashes INSIDE the root stay
    // admissible, including one that spells a traversal in Windows syntax and
    // must not be read as one.
    expect(resolvesInsideRoot(root, path.join(root, 'we\\ird.txt'))).toBe(true);
    expect(resolvesInsideRoot(root, path.join(root, 'odd\\..\\name.txt'))).toBe(true);
    expect(resolvesInsideRoot(root, `${root}/we\\ird.txt`)).toBe(true);
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
