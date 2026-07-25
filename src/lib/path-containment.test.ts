/**
 * The containment primitive shared by the ACP structured-write rule and the Grok
 * read-only shell classifier (F14). Both consumers have their own end-to-end
 * tests; these pin the PRIMITIVE's own edges — the ones a consumer's test would
 * only reach by accident.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
  return { base, root, sibling, outside };
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

  it('walks up to the first path that exists', () => {
    const { root } = fixture();
    expect(nearestExistingAncestor(path.join(root, 'web'))).toBe(path.join(root, 'web'));
    expect(nearestExistingAncestor(path.join(root, 'web', 'a', 'b', 'c.txt'))).toBe(
      path.join(root, 'web'),
    );
    expect(nearestExistingAncestor('/definitely/not/here')).toBe('/');
  });
});
