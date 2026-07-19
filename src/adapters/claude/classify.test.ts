/**
 * Claude ACP profile — classifyError unit tests (PLAN §9, §13).
 *
 * General correctness coverage (AdapterError passthrough, malformed/absent
 * fields, the agent-text runtime + type-level guard). The PLAN §13
 * conformance-fixture pin and the §19 test-21 fixture matrix live in
 * `conformance.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../lib/clock.js';
import { AdapterError, type AdapterErrorKind } from '../spi.js';
import { classifyClaudeError, type EnvelopeRecord } from './classify.js';

const clock = new ManualClock('2026-07-18T00:00:00.000Z');

describe('classifyClaudeError — agent-message text NEVER classifies', () => {
  it('a plain string always yields unknown_provider_error, low confidence, parsed source', () => {
    const result = classifyClaudeError('the model is just talking', clock);
    expect(result).toEqual({
      kind: 'unknown_provider_error',
      source: 'parsed',
      confidence: 'low',
      detectionTier: 'unknown',
      provider: 'claude',
    });
  });

  it('strings that LOOK like structured envelopes are still never parsed as JSON', () => {
    const trickyStrings = [
      '{"code": -32603, "data": {"errorKind": "rate_limit"}}',
      "I've hit a rate_limit (429). errorKind: rate_limit. resumesAt: 2026-07-18T01:00:00.000Z",
      'HTTP/1.1 429 Too Many Requests\nRetry-After: 60',
    ];
    for (const text of trickyStrings) {
      expect(classifyClaudeError(text, clock).kind).toBe('unknown_provider_error');
    }
  });

  it('type-level guard: a plain string does not satisfy the internal EnvelopeRecord shape', () => {
    const agentText = 'talking about rate_limit and 429 and errorKind';
    // @ts-expect-error — EnvelopeRecord is an object/index-signature shape;
    // a bare string must NOT be assignable to it. If this stops erroring,
    // the classifier's envelope type has silently widened to admit agent
    // text and `npm run typecheck` must fail loudly.
    const guard: EnvelopeRecord = agentText;
    void guard;
    // Runtime confirmation of the same property.
    expect(classifyClaudeError(agentText, clock).kind).toBe('unknown_provider_error');
  });
});

describe('classifyClaudeError — non-object, non-string inputs never throw', () => {
  it.each([null, undefined, 42, true, false, [], [1, 2, 3]])('handles %j fail-safe', (value) => {
    expect(() => classifyClaudeError(value, clock)).not.toThrow();
    expect(classifyClaudeError(value, clock).kind).toBe('unknown_provider_error');
  });
});

describe('classifyClaudeError — the -32603/errorKind convention', () => {
  it('rate_limit → usage_limit, structured, high confidence, structured tier', () => {
    const result = classifyClaudeError(
      { error: { code: -32603, message: 'Internal error', data: { errorKind: 'rate_limit' } } },
      clock,
    );
    expect(result).toEqual({
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
      provider: 'claude',
    });
  });

  it('accepts the BARE {code,message,data} shape (no {error:...} wrapper)', () => {
    const result = classifyClaudeError({ code: -32603, message: 'x', data: { errorKind: 'rate_limit' } }, clock);
    expect(result.kind).toBe('usage_limit');
  });

  it('parses resumesAt from data.resumesAt when present (forward-compat)', () => {
    const result = classifyClaudeError(
      {
        error: {
          code: -32603,
          data: { errorKind: 'rate_limit', resumesAt: '2026-07-18T02:00:00.000Z' },
        },
      },
      clock,
    );
    expect(result.resumesAt).toBe('2026-07-18T02:00:00.000Z');
  });

  it('computes resumesAt from data.retryAfterSeconds via the injected clock', () => {
    const result = classifyClaudeError(
      { error: { code: -32603, data: { errorKind: 'rate_limit', retryAfterSeconds: 90 } } },
      clock,
    );
    expect(result.resumesAt).toBe(new Date(clock.nowMs() + 90_000).toISOString());
  });

  it('omits resumesAt entirely when absent (honest — no invented countdown)', () => {
    const result = classifyClaudeError(
      { error: { code: -32603, data: { errorKind: 'rate_limit' } } },
      clock,
    );
    expect('resumesAt' in result).toBe(false);
  });

  it.each<[string, AdapterErrorKind | undefined]>([
    ['overloaded', undefined],
    ['billing_error', undefined],
    ['authentication_failed', undefined],
    ['no_result', undefined],
    ['unknown', undefined],
  ])(
    'errorKind %s (real SDKAssistantMessageError value, ≠ rate_limit) → unknown_provider_error, fail-safe',
    (errorKind) => {
      const result = classifyClaudeError({ error: { code: -32603, data: { errorKind } } }, clock);
      expect(result.kind).toBe('unknown_provider_error');
    },
  );

  it('-32603 with NO data at all → unknown_provider_error', () => {
    const result = classifyClaudeError({ error: { code: -32603, message: 'Internal error' } }, clock);
    expect(result.kind).toBe('unknown_provider_error');
  });
});

describe('classifyClaudeError — the -32000 authRequired convention', () => {
  it('code -32000 → auth (a protocol-level code, not a text match)', () => {
    const result = classifyClaudeError({ error: { code: -32000, message: 'Authentication required' } }, clock);
    expect(result).toEqual({ kind: 'auth', source: 'structured', confidence: 'high', provider: 'claude' });
  });

  it('classifies -32000 as auth even with no data field at all', () => {
    const result = classifyClaudeError({ code: -32000, message: 'Authentication required' }, clock);
    expect(result.kind).toBe('auth');
  });
});

describe('classifyClaudeError — HTTP 429/401/403 (API-key mode, §13)', () => {
  it('429 + numeric-seconds Retry-After → usage_limit/http_429 with computed ETA', () => {
    const result = classifyClaudeError({ status: 429, headers: { 'retry-after': '30' } }, clock);
    expect(result.kind).toBe('usage_limit');
    expect(result.detectionTier).toBe('http_429');
    expect(result.resumesAt).toBe(new Date(clock.nowMs() + 30_000).toISOString());
  });

  it('429 + HTTP-date Retry-After → usage_limit/http_429 with the parsed date', () => {
    const result = classifyClaudeError(
      { status: 429, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } },
      clock,
    );
    expect(result.kind).toBe('usage_limit');
    expect(result.resumesAt).toBe(new Date('2026-10-21T07:28:00.000Z').toISOString());
  });

  it('429 with no Retry-After header → usage_limit, resumesAt honestly absent', () => {
    const result = classifyClaudeError({ status: 429 }, clock);
    expect(result.kind).toBe('usage_limit');
    expect('resumesAt' in result).toBe(false);
  });

  it('401/403 → auth', () => {
    expect(classifyClaudeError({ status: 401 }, clock).kind).toBe('auth');
    expect(classifyClaudeError({ status: 403 }, clock).kind).toBe('auth');
  });
});

describe('classifyClaudeError — AdapterError passthrough', () => {
  it('spawn_failed / unexpected_eof → crash', () => {
    expect(classifyClaudeError(new AdapterError('spawn_failed', 'x'), clock).kind).toBe('crash');
    expect(classifyClaudeError(new AdapterError('unexpected_eof', 'x'), clock).kind).toBe('crash');
  });

  it.each<AdapterErrorKind>([
    'handshake_timeout',
    'protocol_version_mismatch',
    'malformed_frame',
    'oversized_frame',
    'queue_overflow',
    'turn_timeout',
  ])('%s → protocol', (kind) => {
    expect(classifyClaudeError(new AdapterError(kind, 'x'), clock).kind).toBe('protocol');
  });

  it('provider_error recurses into its carried envelope', () => {
    const wrapped = new AdapterError('provider_error', 'x', {
      envelope: { error: { code: -32603, data: { errorKind: 'rate_limit' } } },
    });
    expect(classifyClaudeError(wrapped, clock).kind).toBe('usage_limit');
  });

  it('other AdapterError kinds (e.g. invalid_state) → unknown_provider_error', () => {
    expect(classifyClaudeError(new AdapterError('invalid_state', 'x'), clock).kind).toBe('unknown_provider_error');
  });
});

describe('classifyClaudeError — unrecognized JSON-RPC codes stay fail-safe', () => {
  it('an opaque negative code with no matching convention → unknown_provider_error', () => {
    const result = classifyClaudeError({ error: { code: -32099, message: 'opaque' } }, clock);
    expect(result.kind).toBe('unknown_provider_error');
  });
});
