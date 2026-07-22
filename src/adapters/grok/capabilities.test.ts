import { describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../../lib/clock.js';
import {
  GROK_ACP_AUTH_METHOD,
  GROK_CONFLICTING_BUILTIN_TOOLS,
  buildGrokCapabilityRecord,
  grokPermissionModeForRole,
  grokSandboxProfileForRole,
  probeGrokAuthReadiness,
} from './capabilities.js';

const clock = new ManualClock('2026-07-21T00:00:00.000Z');

describe('Grok capability profile', () => {
  it('reports the characterized ACP baseline and spawn-time model mechanism', () => {
    const record = buildGrokCapabilityRecord({
      executable: { packageName: 'grok-build', version: '0.2.106' },
      clock,
      auth: 'supported',
    });
    expect(record).toMatchObject({
      harnessId: 'grok',
      protocol: { name: 'acp', version: '1' },
      auth: 'supported',
      sessionOps: { create: true, load: true, resume: false, fork: false, cancel: true },
      modelMechanism: 'cli_flag',
      permissionRequests: true,
      mcpConfig: { supported: false, reportOnly: true },
      usageLimitReporting: 'parseable',
      retryAfterTier: 'forecast_only',
      usageAccounting: 'none',
    });
    expect(record.configOptions).toEqual([]);
    expect(record.conflictingBuiltinTools).toEqual([...GROK_CONFLICTING_BUILTIN_TOOLS]);
    expect(GROK_ACP_AUTH_METHOD).toBe('grok.com');
  });

  it('keeps material detection evidence-honest', () => {
    expect(probeGrokAuthReadiness({ XAI_API_KEY: 'xai-key' })).toBe('detected_but_unvalidated');
    expect(probeGrokAuthReadiness({}, { authMaterialDetected: true })).toBe(
      'detected_but_unvalidated',
    );
    expect(
      probeGrokAuthReadiness({}, {
        evidence: { validatedTurnAt: isoTimestamp('2026-07-21T01:00:00.000Z') },
      }),
    ).toBe('supported');
    expect(probeGrokAuthReadiness({})).toBe('unknown');
  });

  it('maps role to an OS-enforced spawn sandbox', () => {
    expect(grokSandboxProfileForRole('implementor')).toBe('strict');
    expect(grokSandboxProfileForRole('coordinator')).toBe('read-only');
    expect(grokSandboxProfileForRole('verifier')).toBe('read-only');
    expect(grokSandboxProfileForRole(undefined)).toBe('read-only');
    expect(grokPermissionModeForRole('implementor')).toBe('acceptEdits');
    expect(grokPermissionModeForRole('coordinator')).toBe('dontAsk');
    expect(grokPermissionModeForRole('verifier')).toBe('dontAsk');
    expect(grokPermissionModeForRole(undefined)).toBe('dontAsk');
  });
});
