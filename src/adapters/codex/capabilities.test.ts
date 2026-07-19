/**
 * Codex ACP profile — CapabilityRecord population tests (PLAN §3, §9).
 *
 * Covers both the STATIC-knowledge path (no live `initialize()` data) and
 * the LIVE-refinement path, using the ACTUAL `initialize()` response shape
 * verified against the installed `codex-acp@1.1.4` source (see
 * `capabilities.ts`'s header for exact citations) — never a spawned
 * process.
 */
import type { InitializeResponse, SessionConfigOption } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../../lib/clock.js';
import { capabilitySupported, requireCapability, type CapabilityRecord } from '../spi.js';
import {
  CODEX_ACP_PROTOCOL_VERSION,
  CODEX_API_KEY_ENV_VAR,
  CODEX_CONFLICTING_BUILTIN_TOOLS,
  CODEX_HARNESS_ID,
  OPENAI_API_KEY_ENV_VAR,
  buildCodexCapabilityRecord,
  probeCodexAuthReadiness,
} from './capabilities.js';

const AT = '2026-07-18T00:00:00.000Z';
const clock = new ManualClock(AT);

const EXECUTABLE = { packageName: '@agentclientprotocol/codex-acp', version: '1.1.4' } as const;

/** The REAL `initialize()` shape codex-acp@1.1.4 returns (verified — see
 * capabilities.ts header for the exact source citation). Note: NO `fork`
 * key, unlike Claude. */
const REAL_INITIALIZE_RESPONSE: InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: {
    auth: { logout: {} },
    providers: {},
    loadSession: true,
    promptCapabilities: { embeddedContext: true, image: true },
    sessionCapabilities: { resume: {}, list: {}, close: {}, delete: {}, additionalDirectories: {} },
    mcpCapabilities: { acp: false, http: true, sse: false },
  },
  agentInfo: { name: '@agentclientprotocol/codex-acp', title: 'Codex', version: '1.1.4' },
  authMethods: [],
};

describe('probeCodexAuthReadiness (§17.1 H-2: evidence-honest, presence is never supported)', () => {
  const VALIDATED = isoTimestamp('2026-07-18T01:00:00.000Z');
  const FAILED = isoTimestamp('2026-07-18T02:00:00.000Z');

  it('a present CODEX_API_KEY is MATERIAL only → detected_but_unvalidated (never supported)', () => {
    expect(probeCodexAuthReadiness({ [CODEX_API_KEY_ENV_VAR]: 'fake-codex-key' })).toBe(
      'detected_but_unvalidated',
    );
  });

  it('a present OPENAI_API_KEY is likewise unvalidated — the exact live-falsified H-2 case', () => {
    // Run 2 proved a present, forwarded OPENAI_API_KEY 401-invalid at the
    // provider while doctor claimed `supported` from its presence.
    expect(probeCodexAuthReadiness({ [OPENAI_API_KEY_ENV_VAR]: 'sk-fake' })).toBe(
      'detected_but_unvalidated',
    );
  });

  it('both keys present (codex-acp check order) still only detected_but_unvalidated', () => {
    expect(
      probeCodexAuthReadiness({ [CODEX_API_KEY_ENV_VAR]: 'a', [OPENAI_API_KEY_ENV_VAR]: 'b' }),
    ).toBe('detected_but_unvalidated');
  });

  it('ChatGPT auth material carried by the isolated home → detected_but_unvalidated', () => {
    expect(probeCodexAuthReadiness({}, { authMaterialDetected: true })).toBe(
      'detected_but_unvalidated',
    );
  });

  it('reports unknown (never a categorical negative) when nothing is detected', () => {
    expect(probeCodexAuthReadiness({})).toBe('unknown');
    expect(
      probeCodexAuthReadiness({ [CODEX_API_KEY_ENV_VAR]: '', [OPENAI_API_KEY_ENV_VAR]: '' }),
    ).toBe('unknown');
  });

  it('supported ONLY with a recorded successful provider turn (validated evidence)', () => {
    expect(
      probeCodexAuthReadiness(
        {},
        { authMaterialDetected: true, evidence: { validatedTurnAt: VALIDATED } },
      ),
    ).toBe('supported');
    // Even with zero detected material: the turn itself is the proof.
    expect(probeCodexAuthReadiness({}, { evidence: { validatedTurnAt: VALIDATED } })).toBe('supported');
  });

  it('an invalid key (present, but recorded 401/auth failure) → detected_but_unsupported', () => {
    expect(
      probeCodexAuthReadiness(
        { [OPENAI_API_KEY_ENV_VAR]: 'sk-proj-invalid' },
        { evidence: { authFailureAt: FAILED } },
      ),
    ).toBe('detected_but_unsupported');
  });

  it('a validated turn NEWER than the failure recovers to supported; older/tied does not', () => {
    expect(
      probeCodexAuthReadiness(
        { [OPENAI_API_KEY_ENV_VAR]: 'sk' },
        { evidence: { authFailureAt: VALIDATED, validatedTurnAt: FAILED } },
      ),
    ).toBe('supported');
    expect(
      probeCodexAuthReadiness(
        { [OPENAI_API_KEY_ENV_VAR]: 'sk' },
        { evidence: { validatedTurnAt: VALIDATED, authFailureAt: VALIDATED } },
      ),
    ).toBe('detected_but_unsupported');
  });
});

describe('buildCodexCapabilityRecord — static path (no live initialize() data)', () => {
  function record(overrides: Partial<Parameters<typeof buildCodexCapabilityRecord>[0]> = {}): CapabilityRecord {
    return buildCodexCapabilityRecord({ executable: EXECUTABLE, clock, ...overrides });
  }

  it('populates the verified static baseline, including fork:false (unlike Claude)', () => {
    const r = record({ auth: 'supported' });
    expect(r.harnessId).toBe(CODEX_HARNESS_ID);
    expect(r.protocol).toEqual({ name: 'acp', version: String(CODEX_ACP_PROTOCOL_VERSION) });
    expect(r.executable).toEqual(EXECUTABLE);
    expect(r.auth).toBe('supported');
    expect(r.sessionOps).toEqual({ create: true, load: true, resume: true, fork: false, cancel: true });
    expect(r.modelMechanism).toBe('session_set_config_option');
    expect(r.permissionRequests).toBe(true);
    expect(r.mcpConfig).toEqual({ supported: true, reportOnly: true });
    expect(r.checkpointExport).toBe(false);
    // DEVIATION FROM THE ORIGINAL PLAN §3 SUMMARY: verified structured (see
    // capabilities.ts's DEVIATION doc comment) — not the 'none' the
    // original task brief specified.
    expect(r.usageLimitReporting).toBe('structured');
    expect(r.retryAfterTier).toBe('forecast_fallback');
    expect(r.usageAccounting).toBe('per_turn');
    expect(r.conflictingBuiltinTools).toEqual([...CODEX_CONFLICTING_BUILTIN_TOOLS]);
    expect(r.sessionIdentity).toEqual({ exposesNativeSessionId: true, confirmsIdentityOnResume: true });
    expect(r.probedAt).toBe(AT);
    expect(r.configOptions).toEqual([]);
  });

  it('defaults auth to probeCodexAuthReadiness() off process.env when omitted', () => {
    const r = record();
    expect(r.auth).toBe(probeCodexAuthReadiness());
  });

  it('conflictingBuiltinTools is honestly empty (no Task-equivalent found)', () => {
    expect(record().conflictingBuiltinTools).toEqual([]);
  });

  it('every capability name resolves through the shared §9 gating function; fork is gated off', () => {
    const r = record();
    expect(capabilitySupported(r, 'createSession')).toBe(true);
    expect(capabilitySupported(r, 'resumeSession')).toBe(true);
    expect(capabilitySupported(r, 'forkSession')).toBe(false);
    expect(capabilitySupported(r, 'modelSwitch')).toBe(true);
    expect(() => requireCapability(r, 'forkSession')).toThrow();
    expect(() => requireCapability(r, 'checkpointExport')).toThrow();
  });
});

describe('buildCodexCapabilityRecord — live initialize() refinement', () => {
  it('derives sessionOps from the REAL verified agentCapabilities shape (fork stays false — no key advertised)', () => {
    const r = buildCodexCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      initializeResponse: REAL_INITIALIZE_RESPONSE,
      auth: 'unknown',
    });
    expect(r.sessionOps).toEqual({ create: true, load: true, resume: true, fork: false, cancel: true });
    expect(r.protocol.version).toBe('1');
    expect(r.mcpConfig.supported).toBe(true); // http:true, even though sse:false
  });

  it('trusts LIVE data over static optimism: resume omitted → false, not silently true', () => {
    const withoutResume: InitializeResponse = {
      ...REAL_INITIALIZE_RESPONSE,
      agentCapabilities: {
        ...REAL_INITIALIZE_RESPONSE.agentCapabilities,
        sessionCapabilities: { close: {}, delete: {}, list: {}, additionalDirectories: {} },
      },
    };
    const r = buildCodexCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      initializeResponse: withoutResume,
      auth: 'unknown',
    });
    expect(r.sessionOps.resume).toBe(false);
    expect(r.sessionOps.create).toBe(true);
    expect(r.sessionOps.cancel).toBe(true);
  });

  it('mcpConfig.supported is false only when BOTH http and sse are false', () => {
    const r = buildCodexCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      auth: 'unknown',
      initializeResponse: {
        ...REAL_INITIALIZE_RESPONSE,
        agentCapabilities: { ...REAL_INITIALIZE_RESPONSE.agentCapabilities, mcpCapabilities: { http: false, sse: false } },
      },
    });
    expect(r.mcpConfig).toEqual({ supported: false, reportOnly: true });
  });

  it('reportOnly is ALWAYS true regardless of live mcpCapabilities (D5)', () => {
    const r = buildCodexCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      auth: 'unknown',
      initializeResponse: REAL_INITIALIZE_RESPONSE,
    });
    expect(r.mcpConfig.reportOnly).toBe(true);
  });
});

describe('buildCodexCapabilityRecord — sessionConfigOptions mapping', () => {
  const options: readonly SessionConfigOption[] = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'gpt-5-4-codex',
      options: [
        { value: 'gpt-5-4-codex', name: 'GPT-5.4 Codex' },
        { value: 'o3', name: 'o3' },
      ],
    },
    {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      category: 'thought_level',
      type: 'select',
      currentValue: 'medium',
      options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }],
    },
  ];

  it('maps select options with category → kind, and preserves current value', () => {
    const r = buildCodexCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      auth: 'unknown',
      sessionConfigOptions: options,
    });
    expect(r.configOptions).toEqual([
      { id: 'model', kind: 'model', values: ['gpt-5-4-codex', 'o3'], current: 'gpt-5-4-codex' },
      { id: 'reasoning_effort', kind: 'reasoning', values: ['low', 'medium', 'high'], current: 'medium' },
    ]);
  });
});
