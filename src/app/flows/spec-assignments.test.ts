/**
 * B4 — the APPROVAL-time R1 gate on the coordinator spec (§3.2).
 *
 * The gate is attached to the SCHEMA, not to a helper beside it, so these tests
 * drive `coordinatorSpecSchema.safeParse` directly as well as
 * `validateCoordinatorSpec`: a future route that parses without going through
 * the validator must get the same refusal, and that is only true if the
 * refusal lives in the type's own construction.
 */
import { describe, expect, it } from 'vitest';
import {
  assessAssignmentDecomposition,
  canonicalizeSpec,
  coordinatorSpecSchema,
  validateCoordinatorSpec,
} from './coordinator.js';

function baseSpec(assignments?: unknown): Record<string, unknown> {
  return {
    goal: 'ship the thing',
    tasks: [{ id: 'T1', description: 'do it' }],
    acceptanceCriteria: [
      {
        id: 'AC-1',
        description: 'backend compiles',
        verificationCommands: ['npm run typecheck'],
        expectedEvidence: 'exit code 0',
      },
      {
        id: 'AC-2',
        description: 'frontend builds',
        verificationCommands: ['npm run build'],
        expectedEvidence: 'exit code 0',
      },
    ],
    rollback: 'git revert',
    proposedImplementorProfile: 'impl',
    proposedVerifierProfile: 'verify',
    ...(assignments !== undefined ? { assignments } : {}),
  };
}

const DISJOINT = [
  { id: 'backend', taskScope: 'server work', writeScope: ['src/server'], criteria: ['AC-1'] },
  { id: 'frontend', taskScope: 'ui work', writeScope: ['web'], criteria: ['AC-2'] },
];

describe('a spec with NO assignments is exactly today’s run', () => {
  it('parses, validates, and canonicalizes byte-for-byte as before', () => {
    const parsed = coordinatorSpecSchema.safeParse(baseSpec());
    expect(parsed.success).toBe(true);
    const result = validateCoordinatorSpec(baseSpec());
    expect(result.ok).toBe(true);
    // The canonical form — and therefore the spec HASH — is unchanged: no
    // `assignments` key is emitted when none was declared, so every previously
    // approved spec still hashes to the same bytes.
    expect(canonicalizeSpec(parsed.success ? parsed.data : ({} as never))).not.toContain('assignments');
  });

  it('assessAssignmentDecomposition is vacuous with none declared', () => {
    expect(assessAssignmentDecomposition({ acceptanceCriteria: [{ id: 'AC-1' }] })).toEqual([]);
  });
});

describe('R1 — overlapping write scopes are REFUSED at approval', () => {
  it('refuses a NESTED scope, naming both sides', () => {
    const overlapping = [
      { id: 'a', taskScope: 'x', writeScope: ['src'], criteria: ['AC-1'] },
      { id: 'b', taskScope: 'y', writeScope: ['src/app'], criteria: ['AC-2'] },
    ];
    const result = validateCoordinatorSpec(baseSpec(overlapping));
    expect(result.ok).toBe(false);
    const issues = result.ok ? [] : result.error;
    expect(issues.some((i) => i.message.includes('write scopes overlap'))).toBe(true);
    expect(issues.some((i) => i.message.includes('"src/app"') && i.message.includes('"src"'))).toBe(true);
  });

  it('refuses through the SCHEMA itself, not only through the validator', () => {
    // The structural claim: `CoordinatorSpecDocument` is `z.infer` of this
    // schema, so a document that would produce overlapping write scopes cannot
    // be constructed by parsing — whatever route a future caller takes.
    const overlapping = [
      { id: 'a', taskScope: 'x', writeScope: ['src'], criteria: ['AC-1'] },
      { id: 'b', taskScope: 'y', writeScope: ['src'], criteria: ['AC-2'] },
    ];
    expect(coordinatorSpecSchema.safeParse(baseSpec(overlapping)).success).toBe(false);
    expect(() => coordinatorSpecSchema.parse(baseSpec(overlapping))).toThrow();
  });

  it('refuses a DECOMPOSITION with an empty write scope (empty = everything)', () => {
    const result = validateCoordinatorSpec(
      baseSpec([
        { id: 'a', taskScope: 'x', writeScope: [], criteria: ['AC-1'] },
        { id: 'b', taskScope: 'y', writeScope: ['web'], criteria: ['AC-2'] },
      ]),
    );
    expect(result.ok).toBe(false);
    expect((result.ok ? [] : result.error).some((i) => i.message.includes('declares no write scope'))).toBe(true);
  });

  it('ALLOWS an empty scope for a LONE assignment (one implementor owns the tree)', () => {
    expect(
      validateCoordinatorSpec(
        baseSpec([{ id: 'solo', taskScope: 'everything', writeScope: [], criteria: ['AC-1', 'AC-2'] }]),
      ).ok,
    ).toBe(true);
  });

  it('does NOT invent an overlap between `src/app` and `src/application`', () => {
    expect(
      validateCoordinatorSpec(
        baseSpec([
          { id: 'a', taskScope: 'x', writeScope: ['src/app'], criteria: ['AC-1'] },
          { id: 'b', taskScope: 'y', writeScope: ['src/application'], criteria: ['AC-2'] },
        ]),
      ).ok,
    ).toBe(true);
  });
});

describe('the rest of the decomposition contract', () => {
  it('refuses a criterion claimed by two assignments', () => {
    const result = validateCoordinatorSpec(
      baseSpec([
        { id: 'a', taskScope: 'x', writeScope: ['src'], criteria: ['AC-1'] },
        { id: 'b', taskScope: 'y', writeScope: ['web'], criteria: ['AC-1', 'AC-2'] },
      ]),
    );
    expect(result.ok).toBe(false);
    expect((result.ok ? [] : result.error).some((i) => i.message.includes('is claimed by both'))).toBe(true);
  });

  it('refuses a criterion that does not exist', () => {
    const result = validateCoordinatorSpec(
      baseSpec([{ id: 'a', taskScope: 'x', writeScope: ['src'], criteria: ['AC-9'] }]),
    );
    expect(result.ok).toBe(false);
    expect((result.ok ? [] : result.error).some((i) => i.message.includes('unknown acceptance criterion'))).toBe(
      true,
    );
  });

  it('refuses duplicate assignment ids', () => {
    const result = validateCoordinatorSpec(
      baseSpec([
        { id: 'same', taskScope: 'x', writeScope: ['src'], criteria: ['AC-1'] },
        { id: 'same', taskScope: 'y', writeScope: ['web'], criteria: ['AC-2'] },
      ]),
    );
    expect(result.ok).toBe(false);
    expect((result.ok ? [] : result.error).some((i) => i.message.includes('duplicate assignment id'))).toBe(true);
  });

  it('refuses a scope path the RUNTIME boundary would reject, with the same message', () => {
    for (const bad of ['/absolute', '../escape', 'src/./app']) {
      const result = validateCoordinatorSpec(
        baseSpec([
          { id: 'a', taskScope: 'x', writeScope: [bad], criteria: ['AC-1'] },
          { id: 'b', taskScope: 'y', writeScope: ['web'], criteria: ['AC-2'] },
        ]),
      );
      expect(result.ok, bad).toBe(false);
    }
  });
});

describe('the decomposition is HASH-BOUND', () => {
  it('canonicalizes into the spec, so approval binds who may write what', () => {
    const parsed = coordinatorSpecSchema.parse(baseSpec(DISJOINT));
    const canonical = canonicalizeSpec(parsed);
    expect(canonical).toContain('"assignments"');
    expect(canonical).toContain('"src/server"');

    // Change ONLY the write scope: the canonical bytes must differ, otherwise an
    // approved hash would not determine the decomposition and the approval-time
    // gate would be advisory.
    const moved = coordinatorSpecSchema.parse(
      baseSpec([{ ...DISJOINT[0], writeScope: ['src/other'] }, DISJOINT[1]]),
    );
    expect(canonicalizeSpec(moved)).not.toBe(canonical);
  });

  it('carries the per-assignment execution mode into the canonical form', () => {
    const parsed = coordinatorSpecSchema.parse(
      baseSpec([
        { ...DISJOINT[0], executionMode: 'in_place' },
        { ...DISJOINT[1], executionMode: 'in_place' },
      ]),
    );
    expect(canonicalizeSpec(parsed)).toContain('"executionMode": "in_place"');
  });

  it('refuses an execution mode outside the closed vocabulary', () => {
    expect(
      coordinatorSpecSchema.safeParse(baseSpec([{ ...DISJOINT[0], executionMode: 'yolo' }])).success,
    ).toBe(false);
  });
});
