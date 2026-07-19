/**
 * SPI contract tests (PLAN §9): typed error taxonomy, capability gating
 * (unsupported capability is a TYPED error, never silent), and the
 * CapabilityRecord shape guarantees the rest of the system relies on.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../lib/clock.js';
import { defaultCapabilityRecord } from './fake/in-process.js';
import {
  ADAPTER_CAPABILITY_NAMES,
  ADAPTER_ERROR_KINDS,
  AdapterError,
  UnsupportedCapabilityError,
  capabilitySupported,
  deriveAuthReadiness,
  isAdapterError,
  providerEnvelopeOf,
  requireCapability,
  type AdapterCapabilityName,
  type CapabilityRecord,
} from './spi.js';

const clock = new ManualClock('2026-07-18T00:00:00.000Z');

function record(overrides: Partial<CapabilityRecord> = {}): CapabilityRecord {
  return { ...defaultCapabilityRecord('fake-acp', clock), ...overrides };
}

describe('deriveAuthReadiness — the single H-2 evidence→readiness rule (§17.1)', () => {
  const T1 = isoTimestamp('2026-07-18T01:00:00.000Z');
  const T2 = isoTimestamp('2026-07-18T02:00:00.000Z');

  it('presence alone is NEVER supported — detected_but_unvalidated', () => {
    expect(deriveAuthReadiness(true)).toBe('detected_but_unvalidated');
    expect(deriveAuthReadiness(true, {})).toBe('detected_but_unvalidated');
  });

  it('nothing detected, no evidence → honest unknown', () => {
    expect(deriveAuthReadiness(false)).toBe('unknown');
  });

  it('a recorded successful provider turn → supported (even without detected material)', () => {
    expect(deriveAuthReadiness(true, { validatedTurnAt: T1 })).toBe('supported');
    expect(deriveAuthReadiness(false, { validatedTurnAt: T1 })).toBe('supported');
  });

  it('a recorded auth failure → detected_but_unsupported (the invalid-key case)', () => {
    expect(deriveAuthReadiness(true, { authFailureAt: T1 })).toBe('detected_but_unsupported');
    expect(deriveAuthReadiness(false, { authFailureAt: T1 })).toBe('detected_but_unsupported');
  });

  it('newest evidence wins; ties lose conservatively (never supported on a tie)', () => {
    expect(deriveAuthReadiness(true, { authFailureAt: T1, validatedTurnAt: T2 })).toBe('supported');
    expect(deriveAuthReadiness(true, { validatedTurnAt: T1, authFailureAt: T2 })).toBe(
      'detected_but_unsupported',
    );
    expect(deriveAuthReadiness(true, { validatedTurnAt: T1, authFailureAt: T1 })).toBe(
      'detected_but_unsupported',
    );
  });
});

describe('AdapterError taxonomy', () => {
  it('kinds are unique and include the §10.2 terminal causes', () => {
    expect(new Set(ADAPTER_ERROR_KINDS).size).toBe(ADAPTER_ERROR_KINDS.length);
    for (const kind of [
      'handshake_timeout',
      'protocol_version_mismatch',
      'malformed_frame',
      'oversized_frame',
      'unexpected_eof',
      'queue_overflow',
      'unsupported_capability',
      'provider_error',
    ] as const) {
      expect(ADAPTER_ERROR_KINDS).toContain(kind);
    }
  });

  it('carries kind, harnessId, envelope, and cause', () => {
    const cause = new Error('boom');
    const envelope = { code: -32603, data: { errorKind: 'rate_limit' } };
    const error = new AdapterError('provider_error', 'scripted', {
      harnessId: 'fake-acp',
      envelope,
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('AdapterError');
    expect(error.kind).toBe('provider_error');
    expect(error.harnessId).toBe('fake-acp');
    expect(error.envelope).toBe(envelope);
    expect(error.cause).toBe(cause);
    expect(isAdapterError(error)).toBe(true);
    expect(isAdapterError(new Error('plain'))).toBe(false);
  });

  it('providerEnvelopeOf extracts envelopes ONLY from provider_error kinds', () => {
    const envelope = { code: -32603 };
    expect(providerEnvelopeOf(new AdapterError('provider_error', 'x', { envelope }))).toBe(envelope);
    expect(providerEnvelopeOf(new AdapterError('turn_timeout', 'x', { envelope }))).toBeUndefined();
    expect(providerEnvelopeOf(new Error('plain'))).toBeUndefined();
    expect(providerEnvelopeOf('string')).toBeUndefined();
  });

  it('UnsupportedCapabilityError is a typed AdapterError with the capability name', () => {
    const error = new UnsupportedCapabilityError('resumeSession', { harnessId: 'fake-acp' });
    expect(error).toBeInstanceOf(AdapterError);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('UnsupportedCapabilityError');
    expect(error.kind).toBe('unsupported_capability');
    expect(error.capability).toBe('resumeSession');
    expect(error.harnessId).toBe('fake-acp');
    expect(error.message).toContain('resumeSession');
  });
});

describe('capability gating (§9: typed, never silent)', () => {
  it('the default record supports the baseline capability set', () => {
    const r = record();
    expect(capabilitySupported(r, 'createSession')).toBe(true);
    expect(capabilitySupported(r, 'loadSession')).toBe(true);
    expect(capabilitySupported(r, 'resumeSession')).toBe(true);
    expect(capabilitySupported(r, 'cancelTurn')).toBe(true);
    expect(capabilitySupported(r, 'setConfigOption')).toBe(true);
    expect(capabilitySupported(r, 'permissionRequests')).toBe(true);
    expect(capabilitySupported(r, 'modelSwitch')).toBe(true);
    // MVP defaults: fork unused, MCP report-only, no checkpoint export.
    expect(capabilitySupported(r, 'forkSession')).toBe(false);
    expect(capabilitySupported(r, 'mcpConfig')).toBe(false);
    expect(capabilitySupported(r, 'checkpointExport')).toBe(false);
  });

  it('every capability name maps to a record field (no fallthrough)', () => {
    const r = record();
    for (const name of ADAPTER_CAPABILITY_NAMES) {
      expect(typeof capabilitySupported(r, name)).toBe('boolean');
    }
  });

  it('flips with the record: sessionOps drive session capabilities', () => {
    const r = record({
      sessionOps: { create: true, load: false, resume: false, fork: true, cancel: false },
    });
    expect(capabilitySupported(r, 'loadSession')).toBe(false);
    expect(capabilitySupported(r, 'resumeSession')).toBe(false);
    expect(capabilitySupported(r, 'forkSession')).toBe(true);
    expect(capabilitySupported(r, 'cancelTurn')).toBe(false);
  });

  it('modelSwitch tracks modelMechanism, including the unsupported sentinel', () => {
    expect(capabilitySupported(record({ modelMechanism: 'session_set_model' }), 'modelSwitch')).toBe(true);
    expect(capabilitySupported(record({ modelMechanism: 'env' }), 'modelSwitch')).toBe(true);
    expect(capabilitySupported(record({ modelMechanism: 'unsupported' }), 'modelSwitch')).toBe(false);
  });

  it('setConfigOption is supported via session mechanisms OR probed options', () => {
    expect(
      capabilitySupported(record({ modelMechanism: 'unsupported', configOptions: [] }), 'setConfigOption'),
    ).toBe(false);
    expect(
      capabilitySupported(
        record({
          modelMechanism: 'unsupported',
          configOptions: [{ id: 'mode', kind: 'mode', values: ['a'] }],
        }),
        'setConfigOption',
      ),
    ).toBe(true);
  });

  it('requireCapability throws the TYPED error for unsupported, passes for supported', () => {
    const r = record({ sessionOps: { create: true, load: true, resume: false, fork: false, cancel: true } });
    expect(() => requireCapability(r, 'createSession')).not.toThrow();
    let thrown: unknown;
    try {
      requireCapability(r, 'resumeSession');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedCapabilityError);
    const typed = thrown as UnsupportedCapabilityError;
    expect(typed.capability).toBe('resumeSession');
    expect(typed.kind).toBe('unsupported_capability');
    expect(typed.harnessId).toBe('fake-acp');
  });

  it('the capability-name registry stays aligned with the checks above', () => {
    const expected: readonly AdapterCapabilityName[] = [
      'createSession',
      'loadSession',
      'resumeSession',
      'forkSession',
      'cancelTurn',
      'setConfigOption',
      'permissionRequests',
      'mcpConfig',
      'checkpointExport',
      'modelSwitch',
    ];
    expect([...ADAPTER_CAPABILITY_NAMES]).toEqual([...expected]);
  });
});

describe('CapabilityRecord shape (§9)', () => {
  it('default record carries every normative field with the PLAN vocabularies', () => {
    const r = record();
    expect(r.protocol).toEqual({ name: 'acp', version: '1' });
    expect(r.executable.version).toBeTypeOf('string');
    // H-2: 4-state vocabulary — supported requires validated turn evidence.
    expect(['supported', 'detected_but_unvalidated', 'detected_but_unsupported', 'unknown']).toContain(
      r.auth,
    );
    expect(['structured', 'parseable', 'none']).toContain(r.usageLimitReporting);
    expect(['honored', 'forecast_fallback', 'forecast_only']).toContain(r.retryAfterTier);
    expect(['per_turn', 'none']).toContain(r.usageAccounting);
    expect(r.mcpConfig.reportOnly).toBe(true); // D5: report-only in MVP
    expect(Array.isArray(r.conflictingBuiltinTools)).toBe(true);
    expect(r.sessionIdentity.exposesNativeSessionId).toBeTypeOf('boolean');
    expect(r.probedAt).toBe('2026-07-18T00:00:00.000Z');
  });
});
