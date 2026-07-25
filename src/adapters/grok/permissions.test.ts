/**
 * ROUND 6 — the STRUCTURAL proof that the payload veto is universal.
 *
 * This property had been "fixed" twice at whatever layer the previous review
 * named, and a different layer remained each time. These tests do not assert the
 * fix at one layer; they ENUMERATE every Grok mediation-construction path (role
 * x mediation mode x caller-supplied-or-not) and assert each one carries a
 * working veto, so a future path cannot be added without one being noticed here.
 *
 * The compile-time half of the enforcement lives in the types:
 * `buildGrokMediation` is the only producer of `VetoedMediation`, whose
 * `verifyOperationPayload` is REQUIRED — a plain `PermissionMediationConfig` is
 * not assignable, so omitting the veto fails to compile rather than failing in
 * production.
 */
import { describe, expect, it } from 'vitest';
import type { RoleName } from '../../domain/state.js';
import { decidePermission, type PermissionMediationConfig } from '../acp/session.js';
import { buildGrokMediation } from './permissions.js';

const ROLES: readonly (RoleName | undefined)[] = [undefined, 'coordinator', 'implementor', 'verifier'];

/** Every mediation shape a caller can hand the Grok factory. */
const MEDIATIONS: ReadonlyArray<{ readonly label: string; readonly permissions?: PermissionMediationConfig }> = [
  { label: 'no mediation supplied at all' },
  { label: 'headless, no policy', permissions: { mode: 'headless' } },
  {
    label: 'headless with an exact allowlist',
    permissions: { mode: 'headless', policy: { allow: ['Execute `npm run typecheck`'] } },
  },
  { label: 'interactive, no handler', permissions: { mode: 'interactive' } },
  {
    label: 'interactive with a configured handler',
    permissions: { mode: 'interactive', handler: async () => ({ kind: 'cancelled' as const }) },
  },
];

describe('buildGrokMediation — the payload veto is universal', () => {
  for (const role of ROLES) {
    for (const mediation of MEDIATIONS) {
      it(`installs a veto for role=${String(role)} / ${mediation.label}`, () => {
        const config = buildGrokMediation({
          ...(mediation.permissions !== undefined ? { permissions: mediation.permissions } : {}),
          ...(role !== undefined ? { role } : {}),
          cwd: '/repo/worktree',
          allowedShellCommands: ['npm run typecheck'],
        });

        // Present...
        expect(typeof config.verifyOperationPayload).toBe('function');
        // ...and actually a VETO: a divergent payload is refused, a matching one
        // passes, an absent one is refused.
        expect(config.verifyOperationPayload('Execute `ls`', { command: 'rm -rf /' })).toBe(false);
        expect(config.verifyOperationPayload('Execute `ls`', { command: 'ls' })).toBe(true);
        expect(config.verifyOperationPayload('Execute `ls`', undefined)).toBe(false);
      });

      it(`no approval escapes the veto for role=${String(role)} / ${mediation.label}`, () => {
        const config = buildGrokMediation({
          ...(mediation.permissions !== undefined ? { permissions: mediation.permissions } : {}),
          ...(role !== undefined ? { role } : {}),
          cwd: '/repo/worktree',
          allowedShellCommands: ['npm run typecheck'],
        });
        // The exact-allowlisted title with a hostile payload — the shape that
        // slipped past when the veto was installed only for implementor+headless
        // (interactive) or checked after the allowlist match (headless).
        const decision = decidePermission(config, 'Execute `npm run typecheck`', { command: 'rm -rf /' });
        expect(decision).toEqual({ action: 'deny', reason: 'denied_raw_input_mismatch' });
      });
    }
  }

  it('shapes the implementor headless policy exactly as before (allowlist + classifier + write root)', () => {
    const config = buildGrokMediation({
      permissions: { mode: 'headless', policy: { allow: ['keep me'] } },
      role: 'implementor',
      cwd: '/repo/worktree',
      allowedShellCommands: ['npm run typecheck'],
    });
    expect(config.mode).toBe('headless');
    const policy = (config as { policy?: { allow: readonly string[]; workspaceWriteRoot?: string } }).policy;
    expect(policy?.allow).toEqual(['keep me', 'Execute `npm run typecheck`']);
    expect(policy?.workspaceWriteRoot).toBe('/repo/worktree');
  });

  it('leaves a NON-implementor policy untouched apart from the veto', () => {
    const supplied: PermissionMediationConfig = {
      mode: 'headless',
      role: 'verifier',
      policy: { allow: ['Execute `npm test`'] },
    };
    const config = buildGrokMediation({ permissions: supplied, role: 'verifier', cwd: '/repo/worktree' });
    expect((config as { policy?: { allow: readonly string[] } }).policy?.allow).toEqual(['Execute `npm test`']);
    // The verifier keeps exact per-criterion allowlisted commands, and they are
    // gated by the same veto — this path must never be exempt.
    expect(config.verifyOperationPayload('Execute `npm test`', undefined)).toBe(false);
  });
});
