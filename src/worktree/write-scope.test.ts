/**
 * B4 write scopes — R1's primitive.
 *
 * Every test here is about a REFUSAL or a FALSE POSITIVE, because those are the
 * two ways a disjointness check fails: missing an overlap admits two writers to
 * one path, and inventing one refuses a legitimate decomposition. Both are
 * asserted; neither is inferred from the happy path.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeError } from './errors.js';
import {
  boundariesOverlap,
  boundaryAdmits,
  declaredPathsOverlap,
  declaredScopesOverlap,
  disjointWriteBoundaries,
  isWholeRootBoundary,
  normalizeDeclaredScope,
  normalizeDeclaredScopePath,
  pathsOutsideBoundary,
  writeBoundary,
} from './write-scope.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'write-scope-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('declared scope paths', () => {
  it('REFUSES an absolute path, a `..`, a `.` and an empty segment', () => {
    for (const bad of ['/etc/passwd', '../outside', 'src/../..', 'src/./app', 'src//app', '']) {
      expect(() => normalizeDeclaredScopePath(bad), bad).toThrow(WorktreeError);
    }
  });

  it('keeps a backslash as a FILENAME byte, never as a separator', () => {
    // The platform is darwin (`"os": ["darwin"]`), where `a\..\b` is ONE
    // component. Reading it as three would refuse a legitimate file name — the
    // same rule `lib/path-containment.ts` states for the containment side.
    expect(normalizeDeclaredScopePath('a\\..\\b')).toBe('a\\..\\b');
  });

  it('REFUSES a duplicate rather than silently collapsing it', () => {
    expect(() => normalizeDeclaredScope(['src', 'src'])).toThrow(WorktreeError);
    expect(normalizeDeclaredScope(['src', 'web'])).toEqual(['src', 'web']);
  });
});

describe('R1 — declared overlap', () => {
  it('is SEGMENT-wise, so `src/app` does not contain `src/application`', () => {
    // A `startsWith` test calls these overlapping and refuses a decomposition
    // that is genuinely disjoint. `lib/path-containment.ts` documents the
    // sibling-worktree version of this exact bug.
    expect(declaredPathsOverlap('src/app', 'src/application')).toBe(false);
    expect(declaredScopesOverlap(['src/app'], ['src/application'])).toBeUndefined();
  });

  it('catches nesting in BOTH directions and equality', () => {
    expect(declaredPathsOverlap('src', 'src/app/flows')).toBe(true);
    expect(declaredPathsOverlap('src/app/flows', 'src')).toBe(true);
    expect(declaredPathsOverlap('src', 'src')).toBe(true);
  });

  it('treats an EMPTY scope as the whole root, so it overlaps everything', () => {
    // Two assignments that both declared nothing is the shape a careless
    // decomposition actually takes, and it is the maximal overlap.
    expect(declaredScopesOverlap([], [])).toBeDefined();
    expect(declaredScopesOverlap([], ['src'])).toBeDefined();
    expect(declaredScopesOverlap(['web'], [])).toBeDefined();
  });

  it('finds an overlap anywhere in a MULTI-path scope, not just the first pair', () => {
    expect(declaredScopesOverlap(['a', 'b', 'c/d'], ['x', 'y', 'c/d/e'])).toEqual({ a: 'c/d', b: 'c/d/e' });
  });
});

describe('writeBoundary — the only producer', () => {
  it('REFUSES a relative root and a root containing `..`', () => {
    expect(() => writeBoundary({ mode: 'worktree', executionRoot: 'relative/root' })).toThrow(WorktreeError);
    expect(() => writeBoundary({ mode: 'worktree', executionRoot: '/repo/../etc' })).toThrow(WorktreeError);
  });

  it('with NO declared scope is the whole root — the pre-B4 shape', () => {
    const boundary = writeBoundary({ mode: 'worktree', executionRoot: '/repo/wt' });
    expect(isWholeRootBoundary(boundary)).toBe(true);
    expect(boundary.roots).toEqual(['/repo/wt']);
  });

  it('binds each declared path under the execution root', () => {
    const boundary = writeBoundary({
      mode: 'in_place',
      executionRoot: '/repo',
      declaredScope: ['src/app', 'web'],
    });
    expect(boundary.roots).toEqual(['/repo/src/app', '/repo/web']);
    expect(isWholeRootBoundary(boundary)).toBe(false);
  });
});

describe('boundaryAdmits — the write decision', () => {
  it('admits inside the scope and DENIES a sibling inside the same execution root', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'web'), { recursive: true });
    const boundary = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src'] });

    expect(boundaryAdmits(boundary, path.join(root, 'src', 'a.ts'))).toBe(true);
    // THE B4 REFUSAL: inside the checkout, outside the assignment. A pre-B4
    // whole-root boundary admits this — which is exactly why two implementors
    // sharing a checkout needed a narrower boundary than the root.
    expect(boundaryAdmits(boundary, path.join(root, 'web', 'a.ts'))).toBe(false);
    expect(boundaryAdmits(boundary, path.join(root, 'package.json'))).toBe(false);
  });

  it('DENIES a symlink escape out of the scope (the containment primitive, unchanged)', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'web'), { recursive: true });
    symlinkSync(path.join(root, 'web'), path.join(root, 'src', 'escape'));
    const boundary = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src'] });
    expect(boundaryAdmits(boundary, path.join(root, 'src', 'escape', 'a.ts'))).toBe(false);
    // …and a `..` is declined outright rather than resolved (see path-containment).
    expect(boundaryAdmits(boundary, `${root}/src/../web/a.ts`)).toBe(false);
  });

  it('DENIES a relative path — inability to determine containment is never containment', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'src'), { recursive: true });
    const boundary = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src'] });
    expect(boundaryAdmits(boundary, 'src/a.ts')).toBe(false);
  });

  it('pathsOutsideBoundary reports exactly the unattributable paths', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'src'), { recursive: true });
    mkdirSync(path.join(root, 'web'), { recursive: true });
    const boundary = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src'] });
    expect(
      pathsOutsideBoundary(boundary, [
        path.join(root, 'src', 'ok.ts'),
        path.join(root, 'web', 'nope.ts'),
        path.join(root, 'README.md'),
      ]),
    ).toEqual([path.join(root, 'web', 'nope.ts'), path.join(root, 'README.md')]);
  });
});

describe('boundariesOverlap — lexical AND physical, because neither alone is enough', () => {
  it('catches nesting between directories that DO NOT EXIST YET', () => {
    // A realpath-only test cannot see this: neither path resolves, so the
    // ancestor walk answers about their common existing parent and reports
    // "disjoint". A missed overlap is the one answer this check cannot give.
    const root = tempRoot();
    const outer = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src/app'] });
    const inner = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src/app/flows'] });
    expect(boundariesOverlap(outer, inner)).toBeDefined();
    expect(boundariesOverlap(inner, outer)).toBeDefined();
  });

  it('catches a SYMLINK ALIAS that is lexically disjoint', () => {
    // `src/link -> src/a`: two different names for one directory. A lexical-only
    // test calls them disjoint and admits two writers to the same files.
    const root = tempRoot();
    mkdirSync(path.join(root, 'src', 'a'), { recursive: true });
    symlinkSync(path.join(root, 'src', 'a'), path.join(root, 'src', 'link'));
    const first = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src/a'] });
    const second = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src/link'] });
    expect(declaredPathsOverlap('src/a', 'src/link')).toBe(false); // lexically clean…
    expect(boundariesOverlap(first, second)).toBeDefined(); // …and physically the same dir
  });

  it('does NOT invent an overlap between genuinely disjoint scopes', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'src', 'app'), { recursive: true });
    mkdirSync(path.join(root, 'src', 'application'), { recursive: true });
    const a = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src/app'] });
    const b = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src/application'] });
    expect(boundariesOverlap(a, b)).toBeUndefined();
  });

  it('two SIBLING worktree roots stay disjoint (the string-prefix trap)', () => {
    const base = tempRoot();
    const first = writeBoundary({ mode: 'worktree', executionRoot: path.join(base, 'assignment-asg_a') });
    const second = writeBoundary({ mode: 'worktree', executionRoot: path.join(base, 'assignment-asg_a-2') });
    expect(boundariesOverlap(first, second)).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// B5 — `disjointWriteBoundaries`: the ONE producer of a fan-out's boundaries.
// ---------------------------------------------------------------------------
describe('disjointWriteBoundaries — the fan-out chokepoint', () => {
  it('returns per-assignment boundaries AND their union from one construction', () => {
    const root = tempRoot();
    const built = disjointWriteBoundaries('in_place', root, [
      { id: 'backend', declaredScope: ['src', 'server'] },
      { id: 'frontend', declaredScope: ['web'] },
    ]);
    expect(built.perAssignment.map((b) => b.declared)).toEqual([['src', 'server'], ['web']]);
    // The union covers every declared path exactly once — the commit gate's
    // boundary and the session boundaries come from the SAME call, so they
    // cannot be derived inconsistently.
    expect(built.union.declared).toEqual(['src', 'server', 'web']);
    expect(built.union.roots).toEqual([
      path.join(root, 'src'),
      path.join(root, 'server'),
      path.join(root, 'web'),
    ]);
  });

  it('REFUSES nested scopes (the overlap a plain equality check would miss)', () => {
    const root = tempRoot();
    const thrown = (): unknown =>
      disjointWriteBoundaries('in_place', root, [
        { id: 'outer', declaredScope: ['src'] },
        { id: 'inner', declaredScope: ['src/app'] },
      ]);
    expect(thrown).toThrow(WorktreeError);
    expect(thrown).toThrow(/write scopes overlap/);
  });

  it('REFUSES a SYMLINK ALIAS that is lexically disjoint and physically the same dir', () => {
    const root = tempRoot();
    mkdirSync(path.join(root, 'real'), { recursive: true });
    symlinkSync(path.join(root, 'real'), path.join(root, 'alias'));
    expect(() =>
      disjointWriteBoundaries('in_place', root, [
        { id: 'a', declaredScope: ['real'] },
        { id: 'b', declaredScope: ['alias'] },
      ]),
    ).toThrow(/write scopes overlap/);
  });

  it('REFUSES an empty scope in a decomposition, in its OWN words', () => {
    const root = tempRoot();
    expect(() =>
      disjointWriteBoundaries('in_place', root, [
        { id: 'scoped', declaredScope: ['src'] },
        { id: 'everything', declaredScope: [] },
      ]),
    ).toThrow(/declares no write scope/);
  });

  it('ALLOWS a lone assignment to declare nothing — that is the whole root, today s shape', () => {
    const root = tempRoot();
    const built = disjointWriteBoundaries('worktree', root, [{ id: 'solo', declaredScope: [] }]);
    expect(built.perAssignment[0]!.declared).toEqual([]);
    expect(built.union.declared).toEqual([]);
    expect(built.union.roots).toEqual([root]);
  });

  it('REFUSES an empty decomposition rather than producing a boundary-less commit gate', () => {
    expect(() => disjointWriteBoundaries('in_place', tempRoot(), [])).toThrow(WorktreeError);
  });

  it('does NOT invent an overlap between sibling-prefixed names', () => {
    const root = tempRoot();
    const built = disjointWriteBoundaries('in_place', root, [
      { id: 'a', declaredScope: ['src/app'] },
      { id: 'b', declaredScope: ['src/application'] },
    ]);
    expect(built.union.declared).toEqual(['src/app', 'src/application']);
  });
});
