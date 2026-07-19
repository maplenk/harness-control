/**
 * Claude ACP profile — CapabilityRecord population tests (PLAN §3, §9).
 *
 * Covers both the STATIC-knowledge path (no live `initialize()` data — the
 * offline/pre-spawn case) and the LIVE-refinement path, using the ACTUAL
 * `initialize()` response shape verified against the installed
 * `claude-agent-acp@0.59.0` source (see `capabilities.ts`'s header for exact
 * citations) — never a spawned process.
 */
import type { InitializeResponse, SessionConfigOption } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { ManualClock, isoTimestamp } from '../../lib/clock.js';
import { capabilitySupported, requireCapability, type CapabilityRecord } from '../spi.js';
import {
  ANTHROPIC_API_KEY_ENV_VAR,
  CLAUDE_ACP_PROTOCOL_VERSION,
  CLAUDE_CONFLICTING_BUILTIN_TOOLS,
  CLAUDE_HARNESS_ID,
  buildClaudeCapabilityRecord,
  probeClaudeAuthReadiness,
} from './capabilities.js';

const AT = '2026-07-18T00:00:00.000Z';
const clock = new ManualClock(AT);

const EXECUTABLE = { packageName: '@agentclientprotocol/claude-agent-acp', version: '0.59.0' } as const;

/** The REAL `initialize()` shape claude-agent-acp@0.59.0 returns (verified —
 * see capabilities.ts header for the exact source citation). */
const REAL_INITIALIZE_RESPONSE: InitializeResponse = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    promptCapabilities: { image: true, embeddedContext: true },
    mcpCapabilities: { http: true, sse: true },
    auth: { logout: {} },
    sessionCapabilities: {
      additionalDirectories: {},
      close: {},
      delete: {},
      fork: {},
      list: {},
      resume: {},
    },
  },
  agentInfo: { name: '@agentclientprotocol/claude-agent-acp', title: 'Claude Agent', version: '0.59.0' },
  authMethods: [],
};

describe('probeClaudeAuthReadiness (§17.1 H-2: evidence-honest, presence is never supported)', () => {
  it('a present ANTHROPIC_API_KEY is MATERIAL only → detected_but_unvalidated', () => {
    // H-2 rule (PLAN §17.1): bare key presence never reports supported.
    expect(probeClaudeAuthReadiness({ [ANTHROPIC_API_KEY_ENV_VAR]: 'sk-ant-api03-fake' })).toBe(
      'detected_but_unvalidated',
    );
  });

  it('supported ONLY with a recorded successful provider turn', () => {
    expect(
      probeClaudeAuthReadiness(
        { [ANTHROPIC_API_KEY_ENV_VAR]: 'sk-ant-api03-fake' },
        { evidence: { validatedTurnAt: isoTimestamp('2026-07-18T01:00:00.000Z') } },
      ),
    ).toBe('supported');
  });

  it('a recorded auth failure → detected_but_unsupported', () => {
    expect(
      probeClaudeAuthReadiness(
        { [ANTHROPIC_API_KEY_ENV_VAR]: 'sk-ant-api03-fake' },
        { evidence: { authFailureAt: isoTimestamp('2026-07-18T01:00:00.000Z') } },
      ),
    ).toBe('detected_but_unsupported');
  });

  it('reports unknown (never a categorical negative) when absent', () => {
    expect(probeClaudeAuthReadiness({})).toBe('unknown');
  });

  it('reports unknown when the key is present but empty', () => {
    expect(probeClaudeAuthReadiness({ [ANTHROPIC_API_KEY_ENV_VAR]: '' })).toBe('unknown');
  });
});

describe('buildClaudeCapabilityRecord — static path (no live initialize() data)', () => {
  function record(overrides: Partial<Parameters<typeof buildClaudeCapabilityRecord>[0]> = {}): CapabilityRecord {
    return buildClaudeCapabilityRecord({ executable: EXECUTABLE, clock, ...overrides });
  }

  it('populates the verified static baseline', () => {
    const r = record({ auth: 'supported' });
    expect(r.harnessId).toBe(CLAUDE_HARNESS_ID);
    expect(r.protocol).toEqual({ name: 'acp', version: String(CLAUDE_ACP_PROTOCOL_VERSION) });
    expect(r.executable).toEqual(EXECUTABLE);
    expect(r.auth).toBe('supported');
    expect(r.sessionOps).toEqual({ create: true, load: true, resume: true, fork: true, cancel: true });
    expect(r.modelMechanism).toBe('session_set_config_option');
    expect(r.permissionRequests).toBe(true);
    expect(r.mcpConfig).toEqual({ supported: true, reportOnly: true });
    expect(r.checkpointExport).toBe(false);
    expect(r.usageLimitReporting).toBe('structured');
    expect(r.retryAfterTier).toBe('honored');
    expect(r.usageAccounting).toBe('per_turn');
    expect(r.conflictingBuiltinTools).toEqual([...CLAUDE_CONFLICTING_BUILTIN_TOOLS]);
    expect(r.sessionIdentity).toEqual({ exposesNativeSessionId: true, confirmsIdentityOnResume: true });
    expect(r.probedAt).toBe(AT);
    expect(r.configOptions).toEqual([]);
  });

  it('defaults auth to probeClaudeAuthReadiness() off process.env when omitted', () => {
    const r = record();
    expect(r.auth).toBe(probeClaudeAuthReadiness());
  });

  it('conflictingBuiltinTools denylists the Task subagent tool (§8)', () => {
    expect(record().conflictingBuiltinTools).toContain('Task');
  });

  it('every capability name resolves through the shared §9 gating function', () => {
    const r = record();
    expect(capabilitySupported(r, 'createSession')).toBe(true);
    expect(capabilitySupported(r, 'resumeSession')).toBe(true);
    expect(capabilitySupported(r, 'forkSession')).toBe(true);
    expect(capabilitySupported(r, 'modelSwitch')).toBe(true);
    expect(() => requireCapability(r, 'checkpointExport')).toThrow();
  });
});

describe('buildClaudeCapabilityRecord — live initialize() refinement', () => {
  it('derives sessionOps from the REAL verified agentCapabilities shape', () => {
    const r = buildClaudeCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      initializeResponse: REAL_INITIALIZE_RESPONSE,
      auth: 'unknown',
    });
    expect(r.sessionOps).toEqual({ create: true, load: true, resume: true, fork: true, cancel: true });
    expect(r.protocol.version).toBe('1');
    expect(r.mcpConfig.supported).toBe(true);
  });

  it('trusts LIVE data over static optimism: fork/resume omitted → false, not silently true', () => {
    const withoutForkOrResume: InitializeResponse = {
      ...REAL_INITIALIZE_RESPONSE,
      agentCapabilities: {
        ...REAL_INITIALIZE_RESPONSE.agentCapabilities,
        sessionCapabilities: { close: {}, delete: {}, list: {}, additionalDirectories: {} },
      },
    };
    const r = buildClaudeCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      initializeResponse: withoutForkOrResume,
      auth: 'unknown',
    });
    expect(r.sessionOps.fork).toBe(false);
    expect(r.sessionOps.resume).toBe(false);
    // create/cancel remain baseline-true regardless — never negotiated.
    expect(r.sessionOps.create).toBe(true);
    expect(r.sessionOps.cancel).toBe(true);
  });

  it('loadSession:false in live data is honored, not overridden by the static default', () => {
    const r = buildClaudeCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      auth: 'unknown',
      initializeResponse: {
        ...REAL_INITIALIZE_RESPONSE,
        agentCapabilities: { ...REAL_INITIALIZE_RESPONSE.agentCapabilities, loadSession: false },
      },
    });
    expect(r.sessionOps.load).toBe(false);
  });

  it('mcpConfig.supported is false only when BOTH http and sse are false', () => {
    const r = buildClaudeCapabilityRecord({
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
    const r = buildClaudeCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      auth: 'unknown',
      initializeResponse: REAL_INITIALIZE_RESPONSE,
    });
    expect(r.mcpConfig.reportOnly).toBe(true);
  });
});

describe('buildClaudeCapabilityRecord — sessionConfigOptions mapping', () => {
  const options: readonly SessionConfigOption[] = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'claude-opus-4-6',
      options: [
        { value: 'claude-opus-4-6', name: 'Opus' },
        { value: 'claude-sonnet-5', name: 'Sonnet' },
      ],
    },
    {
      id: 'mode',
      name: 'Mode',
      category: 'mode',
      type: 'select',
      currentValue: 'default',
      options: [{ value: 'default', name: 'Default' }, { value: 'plan', name: 'Plan' }],
    },
    {
      id: 'thinking',
      name: 'Extended thinking',
      category: 'thought_level',
      type: 'boolean',
      currentValue: true,
    },
    {
      id: 'misc',
      name: 'Misc',
      type: 'boolean',
      currentValue: false,
    },
  ];

  it('maps select/boolean options with category → kind, and preserves current value', () => {
    const r = buildClaudeCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      auth: 'unknown',
      sessionConfigOptions: options,
    });
    expect(r.configOptions).toEqual([
      { id: 'model', kind: 'model', values: ['claude-opus-4-6', 'claude-sonnet-5'], current: 'claude-opus-4-6' },
      { id: 'mode', kind: 'mode', values: ['default', 'plan'], current: 'default' },
      { id: 'thinking', kind: 'reasoning', values: ['true', 'false'], current: 'true' },
      { id: 'misc', kind: 'other', values: ['true', 'false'], current: 'false' },
    ]);
  });

  it('flattens grouped select options', () => {
    const grouped: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      currentValue: 'claude-opus-4-6',
      options: [
        { group: 'anthropic', name: 'Anthropic', options: [{ value: 'claude-opus-4-6', name: 'Opus' }] },
        { group: 'other', name: 'Other', options: [{ value: 'third-party-model', name: '3P' }] },
      ],
    };
    const r = buildClaudeCapabilityRecord({
      executable: EXECUTABLE,
      clock,
      auth: 'unknown',
      sessionConfigOptions: [grouped],
    });
    expect(r.configOptions).toEqual([
      { id: 'model', kind: 'model', values: ['claude-opus-4-6', 'third-party-model'], current: 'claude-opus-4-6' },
    ]);
  });
});
