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
import { decidePermission, noPayloadToVerify, type PermissionMediationConfig } from '../acp/session.js';
import { buildGrokMediation } from './permissions.js';

const ROLES: readonly (RoleName | undefined)[] = [undefined, 'coordinator', 'implementor', 'verifier'];

/** Every mediation shape a caller can hand the Grok factory. */
const MEDIATIONS: ReadonlyArray<{ readonly label: string; readonly permissions?: PermissionMediationConfig }> = [
  { label: 'no mediation supplied at all' },
  { label: 'headless, no policy', permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'headless' } },
  {
    label: 'headless with an exact allowlist',
    permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'headless', policy: { allow: ['Execute `npm run typecheck`'] } },
  },
  { label: 'interactive, no handler', permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'interactive' } },
  {
    label: 'interactive with a configured handler',
    permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'interactive', handler: async () => ({ kind: 'cancelled' as const }) },
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

  // -------------------------------------------------------------------------
  // ROUND 7 (Finding 3) — the enumeration above covers HELPER inputs. The hole
  // was a CONSTRUCTOR: the publicly exported generic `AcpStdioAdapter` accepted
  // an arbitrary Grok harnessId/spawn plus an OPTIONAL-veto mediation config, so
  // building one directly with an approve-all interactive handler bypassed
  // `buildGrokMediation` entirely and compiled fine.
  //
  // The fix is a TYPE obligation at the construction site, so this test is a
  // compile-time assertion as much as a runtime one: the object literal below
  // cannot omit `verifyOperationPayload` and still typecheck. `noPayloadToVerify`
  // exists so "this path has no payload to bind" is a stated decision someone
  // typed, never an absence.
  // -------------------------------------------------------------------------
  it('a mediation config cannot be constructed without SOME veto decision', () => {
    // Every field here is required by the type; dropping the last line is a
    // compile error, which is the actual enforcement.
    const explicitNoop: PermissionMediationConfig = {
      mode: 'interactive',
      handler: async () => ({ kind: 'selected', optionId: 'allow_once' }),
      verifyOperationPayload: noPayloadToVerify,
    };
    expect(explicitNoop.verifyOperationPayload).toBe(noPayloadToVerify);
    // The named no-op is honest about what it does: it binds nothing.
    expect(noPayloadToVerify('Execute `ls`', { command: 'rm -rf /' })).toBe(true);
  });

  it('shapes the implementor headless policy exactly as before (allowlist + classifier + write root)', () => {
    const config = buildGrokMediation({
      permissions: { verifyOperationPayload: noPayloadToVerify, mode: 'headless', policy: { allow: ['keep me'] } },
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
      verifyOperationPayload: noPayloadToVerify, mode: 'headless',
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
