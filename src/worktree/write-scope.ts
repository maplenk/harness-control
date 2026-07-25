/**
 * B4 — WRITE SCOPES: the boundary an assignment's writes may land inside, and
 * the disjointness rule (R1) that makes N concurrent implementors in ONE
 * checkout safe.
 *
 * ## Why this type exists at all
 *
 * Before B4 there was exactly one containment root per assignment — the
 * worktree directory — and it travelled as a bare `string` (`cwd` →
 * `policy.workspaceWriteRoot` → `isWorkspaceWriteOperation`). A bare string can
 * only express "everything under here". Shared-tree parallelism needs the
 * strictly richer statement:
 *
 *     reads may span the whole execution root; WRITES may land only in THESE
 *     N sub-paths.
 *
 * A second optional field next to the old one would have been the forgettable
 * kind of fix this codebase has already paid for four times. So the boundary
 * became a VALUE — branded, constructible only here, and REQUIRED on the
 * worktree handle. Every consumer that can admit a write takes the boundary; a
 * consumer that took a bare root would not compile.
 *
 * ## Two layers, deliberately
 *
 *  - **Pure (no filesystem).** `normalizeDeclaredScope` /
 *    `declaredScopesOverlap` work on repo-RELATIVE declared paths. The
 *    spec-approval gate runs before any root exists on disk (and in a process
 *    that may not even hold the repo), so R1 has to be answerable without
 *    touching the filesystem. Segment-wise prefix containment is EXACT for that
 *    question and has no false negatives from a directory that does not exist
 *    yet — which a realpath-based test would have, and a missed overlap is the
 *    one failure this module cannot have.
 *
 *  - **Bound (filesystem).** `boundaryAdmits` answers "does this absolute write
 *    target really resolve inside one of my roots" through the SHARED
 *    `resolvesInsideRoot` (`lib/path-containment.ts`) — never a new path check.
 *    `fs.realpathSync` collapses `..` lexically before resolving symlinks, which
 *    is exactly why that module exists and why nothing here re-derives it.
 *
 * `boundariesOverlap` uses BOTH: the lexical test catches nesting between
 * directories that do not exist yet, and the realpath test catches a SYMLINK
 * ALIAS (`src/link -> src/a`) that is lexically disjoint and physically the same
 * directory. Neither is sufficient alone; the union is what R1 needs.
 */
import * as path from 'node:path';
import { resolvesInsideRoot } from '../lib/path-containment.js';
import { type ExecutionMode } from '../domain/execution-mode.js';
import { WorktreeError } from './errors.js';

/**
 * A declared scope path is repo-RELATIVE and structural. Rejected outright:
 * absolute paths (they would silently escape the root), `..` (the traversal
 * `path-containment` refuses to resolve at all), `.` and empty segments (they
 * denote the root while looking like a narrowing — a scope that reads as
 * `src/./` must never quietly become "everything").
 *
 * A backslash is an ordinary FILENAME byte on this platform (`"os": ["darwin"]`),
 * never a separator — the same rule `lib/path-containment.ts` states and for the
 * same reason: treating a byte as structure is how a filename becomes a boundary
 * crossing.
 */
export function normalizeDeclaredScopePath(declared: string): string {
  if (path.isAbsolute(declared)) {
    throw new WorktreeError(
      'unsafe_path',
      `write-scope path must be repo-relative, got the absolute path ${JSON.stringify(declared)}`,
    );
  }
  const segments = declared.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new WorktreeError(
        'unsafe_path',
        `write-scope path ${JSON.stringify(declared)} contains the segment ${JSON.stringify(segment)}; ` +
          'declared scopes must be plain relative paths (no "..", no "." and no empty segments) so the ' +
          'boundary they name is the boundary they appear to name',
      );
    }
  }
  return segments.join('/');
}

/**
 * Normalize a whole declared scope list. An EMPTY list is legal and means "the
 * entire execution root" — which is precisely today's single-assignment
 * behaviour and therefore what the default must be.
 *
 * Duplicates are refused rather than de-duplicated: a spec that names the same
 * path twice inside one assignment is a spec its author did not proofread, and
 * silently collapsing it would also silently collapse `["src", "src"]` across a
 * copy-paste that was MEANT to name two different paths.
 */
export function normalizeDeclaredScope(declared: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of declared) {
    const normalized = normalizeDeclaredScopePath(entry);
    if (seen.has(normalized)) {
      throw new WorktreeError(
        'unsafe_path',
        `write scope names ${JSON.stringify(normalized)} more than once`,
      );
    }
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * R1, the PURE half: do two normalized declared paths cover any common path?
 *
 * Segment-wise, not `startsWith`: `src/app` must not be read as containing
 * `src/application`. (`lib/path-containment.ts` documents the sibling-worktree
 * version of exactly this bug.)
 */
export function declaredPathsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  const as = a.split('/');
  const bs = b.split('/');
  const shorter = as.length < bs.length ? as : bs;
  const longer = as.length < bs.length ? bs : as;
  return shorter.every((segment, i) => segment === longer[i]);
}

/**
 * R1 across two whole declared scopes. An EMPTY scope means the whole root, so
 * it overlaps EVERYTHING in that root, including another empty scope — the case
 * that matters most, because "two assignments that both declared nothing" is the
 * shape a careless decomposition actually takes.
 */
export function declaredScopesOverlap(
  a: readonly string[],
  b: readonly string[],
): { readonly a: string; readonly b: string } | undefined {
  if (a.length === 0 || b.length === 0) {
    return { a: a[0] ?? '.', b: b[0] ?? '.' };
  }
  for (const left of a) {
    for (const right of b) {
      if (declaredPathsOverlap(left, right)) return { a: left, b: right };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The bound boundary
// ---------------------------------------------------------------------------
declare const WRITE_BOUNDARY_BRAND: unique symbol;

/**
 * WHERE an assignment may write, as a value.
 *
 * Branded so `writeBoundary()` is the ONLY producer: an object literal shaped
 * like this is not assignable, so no call site can hand a permission policy a
 * boundary that skipped validation. `roots` is non-empty by construction.
 */
export interface WriteBoundary {
  readonly [WRITE_BOUNDARY_BRAND]: 'write-boundary';
  readonly mode: ExecutionMode;
  /** Canonical absolute root the agent READS from (worktree dir, or checkout). */
  readonly executionRoot: string;
  /** Repo-relative declared scope; EMPTY = the whole execution root. */
  readonly declared: readonly string[];
  /** Absolute roots writes may land inside. Never empty. */
  readonly roots: readonly string[];
}

export interface WriteBoundaryInput {
  readonly mode: ExecutionMode;
  readonly executionRoot: string;
  /** Repo-relative; omit or pass `[]` for "the whole execution root". */
  readonly declaredScope?: readonly string[];
}

/**
 * The only producer of a `WriteBoundary`.
 *
 * Validation here is PURE — absolute root, no `..` on either side, structural
 * declared paths. It deliberately does NOT stat anything: the manager builds the
 * boundary while the worktree is being created, and a constructor that consulted
 * the filesystem would either refuse a root that is about to exist or bake in a
 * realpath that a later symlink change invalidates. The filesystem question
 * belongs at the moment a write is judged (`boundaryAdmits`) and at the moment
 * two live scopes are compared (`boundariesOverlap`), and it is asked there.
 */
export function writeBoundary(input: WriteBoundaryInput): WriteBoundary {
  const { executionRoot } = input;
  if (!path.isAbsolute(executionRoot)) {
    throw new WorktreeError(
      'unsafe_path',
      `write boundary requires an absolute execution root, got ${JSON.stringify(executionRoot)}`,
    );
  }
  if (executionRoot.split('/').includes('..')) {
    throw new WorktreeError(
      'unsafe_path',
      `write boundary execution root must not contain a '..' segment: ${JSON.stringify(executionRoot)} ` +
        '(realpath collapses it lexically, so containment could not be answered honestly)',
    );
  }
  const declared = normalizeDeclaredScope(input.declaredScope ?? []);
  const roots =
    declared.length === 0
      ? [executionRoot]
      : declared.map((relative) => path.join(executionRoot, relative));
  // The brand is a `declare const ... unique symbol`: a TYPE-level marker with no
  // runtime existence, so it must not appear as a computed key here (it would be
  // a ReferenceError). The cast is confined to this one line, which is exactly
  // what makes this function the only producer — no other module can even NAME
  // the symbol, so no other module can build a value of this type.
  return { mode: input.mode, executionRoot, declared, roots } as unknown as WriteBoundary;
}

/** True when the boundary is the whole execution root (today's single-assignment shape). */
export function isWholeRootBoundary(boundary: WriteBoundary): boolean {
  return boundary.declared.length === 0;
}

/**
 * Does `candidate` — an ABSOLUTE path — really resolve inside this boundary?
 *
 * Delegates every path question to the shared `resolvesInsideRoot`, which
 * refuses relative paths, refuses `..`, resolves symlinks on both sides, and
 * treats every failure as a refusal. A boundary with one root is byte-for-byte
 * the pre-B4 decision; N roots is a disjunction over the same test.
 */
export function boundaryAdmits(boundary: WriteBoundary, candidate: string): boolean {
  return boundary.roots.some((root) => resolvesInsideRoot(root, candidate));
}

/** The paths in `candidates` this boundary does NOT admit (absolute paths in). */
export function pathsOutsideBoundary(
  boundary: WriteBoundary,
  candidates: readonly string[],
): readonly string[] {
  return candidates.filter((candidate) => !boundaryAdmits(boundary, candidate));
}

/**
 * R1 across two BOUND boundaries — the union of the lexical and the physical
 * test, because each catches what the other cannot:
 *
 *  - two scope directories that do not exist yet cannot be realpath'd, so only
 *    the lexical test sees `src/a` inside `src/a/b`;
 *  - a symlink alias (`src/link -> src/a`) is lexically disjoint and physically
 *    identical, so only `resolvesInsideRoot` sees it.
 *
 * Boundaries in DIFFERENT execution roots are compared by the same rule rather
 * than assumed disjoint: worktree roots are siblings under `<repo>.worktrees/`,
 * and "different root" has never been a safe proxy for "different directory".
 */
export function boundariesOverlap(
  a: WriteBoundary,
  b: WriteBoundary,
): { readonly a: string; readonly b: string } | undefined {
  for (const left of a.roots) {
    for (const right of b.roots) {
      if (
        left === right ||
        declaredPathsOverlap(left, right) ||
        resolvesInsideRoot(left, right) ||
        resolvesInsideRoot(right, left)
      ) {
        return { a: left, b: right };
      }
    }
  }
  return undefined;
}

/**
 * Raised when two assignments could write the same path — at spec approval, or
 * when a second live workspace is opened against a scope a live one already
 * covers. `already_leased` is the honest kind: the overlapping region is
 * genuinely already claimed by another assignment.
 */
export function writeScopeConflictError(
  holderLabel: string,
  requesterLabel: string,
  overlap: { readonly a: string; readonly b: string },
): WorktreeError {
  return new WorktreeError(
    'already_leased',
    `write scopes overlap: ${requesterLabel} would write ${JSON.stringify(overlap.b)} which is already ` +
      `covered by ${holderLabel}'s scope ${JSON.stringify(overlap.a)}. Two concurrently-driven assignments ` +
      'must never be able to write the same path (R1) — the run is refused rather than letting one ' +
      "implementor silently clobber the other's work and the verifier certify whichever write landed last.",
  );
}
