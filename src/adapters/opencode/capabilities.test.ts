import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../lib/clock.js';
import {
  OPENCODE_CONFLICTING_BUILTIN_TOOLS,
  OPENCODE_SESSION_MODE_POLICY,
  buildOpenCodeCapabilityRecord,
  probeOpenCodeAuthReadiness,
} from './capabilities.js';

const CLOCK = new ManualClock('2026-07-20T12:00:00.000Z');

describe('OpenCode capabilities', () => {
  it('uses plan/build/plan role modes and advertises the native ACP surface', () => {
    expect(OPENCODE_SESSION_MODE_POLICY.byRole.coordinator?.value).toBe('plan');
    expect(OPENCODE_SESSION_MODE_POLICY.byRole.implementor?.value).toBe('build');
    expect(OPENCODE_SESSION_MODE_POLICY.byRole.verifier?.value).toBe('plan');

    const record = buildOpenCodeCapabilityRecord({
      executable: { packageName: 'opencode-ai', version: '1.18.1' },
      clock: CLOCK,
      auth: 'unknown',
    });
    expect(record.sessionOps).toEqual({
      create: true,
      load: true,
      resume: true,
      fork: true,
      cancel: true,
    });
    expect(record.modelMechanism).toBe('session_set_config_option');
    expect(record.permissionRequests).toBe(true);
    expect(record.usageAccounting).toBe('per_turn');
    expect(record.conflictingBuiltinTools).toEqual(OPENCODE_CONFLICTING_BUILTIN_TOOLS);
  });

  it('treats OpenCode auth-store presence as unvalidated material only', () => {
    expect(probeOpenCodeAuthReadiness()).toBe('unknown');
    expect(probeOpenCodeAuthReadiness({ authMaterialDetected: true })).toBe(
      'detected_but_unvalidated',
    );
  });
});
