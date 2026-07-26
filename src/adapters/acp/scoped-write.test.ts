/**
 * B4 at the PERMISSION chokepoint — the write rule decides against the
 * assignment's SCOPE, not against the execution root.
 *
 * `session.test.ts` already pins the containment primitive against a single root
 * (F14) and is untouched by B4. What is new is the narrowing, so what is
 * asserted here is the REFUSAL: a path that a whole-root boundary admits — and
 * that the pre-B4 code did admit — must now be denied when it falls outside the
 * assignment's scope.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { admitsWorkspaceWrite, decidePermission, noPayloadToVerify } from './session.js';
import { buildGrokMediation } from '../grok/permissions.js';
import { writeBoundary } from '../../worktree/write-scope.js';
import { denyByDefaultPosture } from '../../lib/permanent-deny.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function checkout(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'scoped-write-test-'));
  tempDirs.push(root);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'web'), { recursive: true });
  return root;
}

function policyFor(root: string, declaredScope?: readonly string[]) {
  return {
    mode: 'headless',
    role: 'implementor',
    verifyOperationPayload: noPayloadToVerify,
    policy: { implementorPosture: denyByDefaultPosture,
      allow: [],
      workspaceWriteBoundary: writeBoundary({
        mode: 'in_place',
        executionRoot: root,
        ...(declaredScope !== undefined ? { declaredScope } : {}),
      }),
    },
  } as const;
}

describe('admitsWorkspaceWrite', () => {
  it('a WHOLE-ROOT boundary is byte-for-byte the pre-B4 decision', () => {
    const root = checkout();
    const boundary = writeBoundary({ mode: 'worktree', executionRoot: root });
    expect(admitsWorkspaceWrite(`Write \`${path.join(root, 'src', 'a.ts')}\``, boundary)).toBe(true);
    expect(admitsWorkspaceWrite(`Write \`${path.join(root, 'web', 'a.ts')}\``, boundary)).toBe(true);
    expect(admitsWorkspaceWrite(`Write \`${path.join(root, '..', 'a.ts')}\``, boundary)).toBe(false);
  });

  it('a SCOPED boundary denies a sibling the whole-root boundary admits', () => {
    const root = checkout();
    const scoped = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src'] });
    expect(admitsWorkspaceWrite(`Write \`${path.join(root, 'src', 'a.ts')}\``, scoped)).toBe(true);
    expect(admitsWorkspaceWrite(`Edit \`${path.join(root, 'web', 'a.ts')}\``, scoped)).toBe(false);
    expect(admitsWorkspaceWrite(`Write \`${path.join(root, 'package.json')}\``, scoped)).toBe(false);
  });

  it('admits a write in ANY of several declared roots', () => {
    const root = checkout();
    const scoped = writeBoundary({
      mode: 'in_place',
      executionRoot: root,
      declaredScope: ['src', 'web'],
    });
    expect(admitsWorkspaceWrite(`Write \`${path.join(root, 'src', 'a.ts')}\``, scoped)).toBe(true);
    expect(admitsWorkspaceWrite(`Write \`${path.join(root, 'web', 'a.ts')}\``, scoped)).toBe(true);
    expect(admitsWorkspaceWrite(`Write \`${path.join(root, 'docs', 'a.md')}\``, scoped)).toBe(false);
  });

  it('still refuses a SYMLINK escape out of the scope', () => {
    const root = checkout();
    symlinkSync(path.join(root, 'web'), path.join(root, 'src', 'escape'));
    const scoped = writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src'] });
    expect(admitsWorkspaceWrite(`Write \`${path.join(root, 'src', 'escape', 'a.ts')}\``, scoped)).toBe(false);
  });
});

describe('decidePermission threads the boundary', () => {
  it('allows in-scope and DENIES out-of-scope for the same implementor session', () => {
    const root = checkout();
    const policy = policyFor(root, ['src']);
    expect(decidePermission(policy, `Write \`${path.join(root, 'src', 'a.ts')}\``)).toEqual({
      action: 'allow',
      reason: 'allowlisted_workspace_write',
    });
    expect(decidePermission(policy, `Write \`${path.join(root, 'web', 'a.ts')}\``)).toEqual({
      action: 'deny',
      reason: 'denied_default',
    });
  });

  it('with NO scope declared, both are allowed — the status quo is preserved', () => {
    const root = checkout();
    const policy = policyFor(root);
    expect(decidePermission(policy, `Write \`${path.join(root, 'src', 'a.ts')}\``).action).toBe('allow');
    expect(decidePermission(policy, `Write \`${path.join(root, 'web', 'a.ts')}\``).action).toBe('allow');
  });
});

describe('buildGrokMediation — the only producer', () => {
  it('binds the SUPPLIED boundary for the implementor', () => {
    const root = checkout();
    const config = buildGrokMediation({
      // `decidePermission` reads the role off the CONFIG, so the supplied
      // mediation carries it too — otherwise the workspace-write branch is never
      // reached and this would assert `denied_default` for the wrong reason.
      permissions: {
        verifyOperationPayload: noPayloadToVerify,
        mode: 'headless',
        role: 'implementor',
        policy: { implementorPosture: denyByDefaultPosture, allow: [] },
      },
      role: 'implementor',
      cwd: root,
      writeBoundary: writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src'] }),
    });
    // The real Grok veto binds the payload to the title, so the rawInput is
    // supplied exactly as the provider sends it — otherwise this would assert the
    // veto rather than the boundary.
    const inside = path.join(root, 'src', 'a.ts');
    const outside = path.join(root, 'web', 'a.ts');
    expect(decidePermission(config, `Write \`${inside}\``, { path: inside }).action).toBe('allow');
    expect(decidePermission(config, `Write \`${outside}\``, { path: outside }).action).toBe('deny');
  });

  it('falls back to the whole `cwd` when none is supplied (pre-B4 behaviour)', () => {
    const root = checkout();
    const config = buildGrokMediation({
      // `decidePermission` reads the role off the CONFIG, so the supplied
      // mediation carries it too — otherwise the workspace-write branch is never
      // reached and this would assert `denied_default` for the wrong reason.
      permissions: {
        verifyOperationPayload: noPayloadToVerify,
        mode: 'headless',
        role: 'implementor',
        policy: { implementorPosture: denyByDefaultPosture, allow: [] },
      },
      role: 'implementor',
      cwd: root,
    });
    const inside = path.join(root, 'web', 'a.ts');
    const outside = path.join(root, '..', 'a.ts');
    expect(decidePermission(config, `Write \`${inside}\``, { path: inside }).action).toBe('allow');
    expect(decidePermission(config, `Write \`${outside}\``, { path: outside }).action).toBe('deny');
  });

  it('leaves READS at the execution root even when writes are narrowed', () => {
    // Narrowing reads to the scope would deny the exploration the implementor
    // prompt tells the agent to do, and a denied request ends the turn before any
    // work is committed — the F14 failure, reintroduced by over-narrowing.
    const root = checkout();
    const config = buildGrokMediation({
      // `decidePermission` reads the role off the CONFIG, so the supplied
      // mediation carries it too — otherwise the workspace-write branch is never
      // reached and this would assert `denied_default` for the wrong reason.
      permissions: {
        verifyOperationPayload: noPayloadToVerify,
        mode: 'headless',
        role: 'implementor',
        policy: { implementorPosture: denyByDefaultPosture, allow: [] },
      },
      role: 'implementor',
      cwd: root,
      writeBoundary: writeBoundary({ mode: 'in_place', executionRoot: root, declaredScope: ['src'] }),
    });
    const readOutsideScope = `Execute \`cat ${path.join(root, 'web', 'keep.ts')}\``;
    expect(decidePermission(config, readOutsideScope, { command: `cat ${path.join(root, 'web', 'keep.ts')}` })).toEqual(
      { action: 'allow', reason: 'allowlisted_read_only_operation' },
    );
  });
});
