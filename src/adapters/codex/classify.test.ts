/**
 * Codex ACP profile — classifyError unit tests (PLAN §9, §13).
 *
 * General correctness coverage (AdapterError passthrough, malformed/absent
 * fields, the agent-text runtime + type-level guard). The conformance
 * fixture pin and the §19 test-21 fixture matrix live in
 * `conformance.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../lib/clock.js';
import { AdapterError, type AdapterErrorKind } from '../spi.js';
import { classifyCodexError, type EnvelopeRecord } from './classify.js';

const clock = new ManualClock('2026-07-18T00:00:00.000Z');

describe('classifyCodexError — agent-message text NEVER classifies', () => {
  it('a plain string always yields unknown_provider_error, low confidence, parsed source', () => {
    const result = classifyCodexError('the model is just talking', clock);
    expect(result).toEqual({
      kind: 'unknown_provider_error',
      source: 'parsed',
      confidence: 'low',
      detectionTier: 'unknown',
      provider: 'codex',
    });
  });

  it('strings that LOOK like structured envelopes are still never parsed as JSON', () => {
    const trickyStrings = [
      '{"code": -32603, "data": {"codexErrorInfo": "usageLimitExceeded"}}',
      "I've hit my usageLimitExceeded. codexErrorInfo: usageLimitExceeded.",
      'HTTP/1.1 429 Too Many Requests\nRetry-After: 60',
    ];
    for (const text of trickyStrings) {
      expect(classifyCodexError(text, clock).kind).toBe('unknown_provider_error');
    }
  });

  it('type-level guard: a plain string does not satisfy the internal EnvelopeRecord shape', () => {
    const agentText = 'talking about usageLimitExceeded and 429 and codexErrorInfo';
    // @ts-expect-error — EnvelopeRecord is an object/index-signature shape;
    // a bare string must NOT be assignable to it. If this stops erroring,
    // the classifier's envelope type has silently widened to admit agent
    // text and `npm run typecheck` must fail loudly.
    const guard: EnvelopeRecord = agentText;
    void guard;
    expect(classifyCodexError(agentText, clock).kind).toBe('unknown_provider_error');
  });
});

describe('classifyCodexError — non-object, non-string inputs never throw', () => {
  it.each([null, undefined, 42, true, false, [], [1, 2, 3]])('handles %j fail-safe', (value) => {
    expect(() => classifyCodexError(value, clock)).not.toThrow();
    expect(classifyCodexError(value, clock).kind).toBe('unknown_provider_error');
  });
});

describe('classifyCodexError — the -32603/codexErrorInfo convention (verified structured signal)', () => {
  it('codexErrorInfo="usageLimitExceeded" → usage_limit, structured, high confidence, structured tier', () => {
    const result = classifyCodexError(
      {
        error: {
          code: -32603,
          message: 'Internal error',
          data: { message: 'x', codexErrorInfo: 'usageLimitExceeded' },
        },
      },
      clock,
    );
    expect(result).toEqual({
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
      provider: 'codex',
    });
  });

  it('accepts the BARE {code,message,data} shape (no {error:...} wrapper)', () => {
    const result = classifyCodexError(
      { code: -32603, message: 'x', data: { codexErrorInfo: 'usageLimitExceeded' } },
      clock,
    );
    expect(result.kind).toBe('usage_limit');
  });

  it('parses resumesAt from data.resumesAt when present (forward-compat; not sent today)', () => {
    const result = classifyCodexError(
      {
        error: {
          code: -32603,
          data: { codexErrorInfo: 'usageLimitExceeded', resumesAt: '2026-07-18T02:00:00.000Z' },
        },
      },
      clock,
    );
    expect(result.resumesAt).toBe('2026-07-18T02:00:00.000Z');
  });

  it('computes resumesAt from data.retryAfterSeconds via the injected clock', () => {
    const result = classifyCodexError(
      { error: { code: -32603, data: { codexErrorInfo: 'usageLimitExceeded', retryAfterSeconds: 45 } } },
      clock,
    );
    expect(result.resumesAt).toBe(new Date(clock.nowMs() + 45_000).toISOString());
  });

  it('omits resumesAt entirely when absent (honest — matches the verified real shape today)', () => {
    const result = classifyCodexError(
      { error: { code: -32603, data: { codexErrorInfo: 'usageLimitExceeded' } } },
      clock,
    );
    expect('resumesAt' in result).toBe(false);
  });

  it('codexErrorInfo="unauthorized" (a DIFFERENT real value, ≠ usageLimitExceeded) → unknown_provider_error, fail-safe', () => {
    const result = classifyCodexError({ error: { code: -32603, data: { codexErrorInfo: 'unauthorized' } } }, clock);
    expect(result.kind).toBe('unknown_provider_error');
  });

  it('-32603 with NO codexErrorInfo at all → unknown_provider_error', () => {
    const result = classifyCodexError({ error: { code: -32603, data: { message: 'x' } } }, clock);
    expect(result.kind).toBe('unknown_provider_error');
    expect(classifyCodexError({ error: { code: -32603, message: 'x' } }, clock).kind).toBe('unknown_provider_error');
  });
});

describe('classifyCodexError — the -32000 authRequired convention (shared SDK factory)', () => {
  it('code -32000 → auth, even WITH data attached (codex-acp calls authRequired with data)', () => {
    const result = classifyCodexError(
      { error: { code: -32000, message: 'Unauthorized', data: { codexErrorInfo: 'unauthorized' } } },
      clock,
    );
    expect(result).toEqual({ kind: 'auth', source: 'structured', confidence: 'high', provider: 'codex' });
  });

  it('code -32000 → auth with no data field too', () => {
    expect(classifyCodexError({ code: -32000, message: 'Unauthorized' }, clock).kind).toBe('auth');
  });
});

describe('classifyCodexError — code 1001 (codex child process exited)', () => {
  it('classifies as crash — a verified non-standard codex-acp convention', () => {
    const result = classifyCodexError({ code: 1001, message: 'Codex process has exited with code 1' }, clock);
    expect(result.kind).toBe('crash');
    expect(result.source).toBe('structured');
  });
});

describe('classifyCodexError — HTTP 429/401/403 (API-key mode, §13)', () => {
  it('429 + numeric-seconds Retry-After → usage_limit/http_429 with computed ETA', () => {
    const result = classifyCodexError({ status: 429, headers: { 'retry-after': '30' } }, clock);
    expect(result.kind).toBe('usage_limit');
    expect(result.detectionTier).toBe('http_429');
    expect(result.resumesAt).toBe(new Date(clock.nowMs() + 30_000).toISOString());
  });

  it('429 with no Retry-After header → usage_limit, resumesAt honestly absent', () => {
    const result = classifyCodexError({ status: 429 }, clock);
    expect(result.kind).toBe('usage_limit');
    expect('resumesAt' in result).toBe(false);
  });

  it('401/403 → auth', () => {
    expect(classifyCodexError({ status: 401 }, clock).kind).toBe('auth');
    expect(classifyCodexError({ status: 403 }, clock).kind).toBe('auth');
  });
});

describe('classifyCodexError — AdapterError passthrough', () => {
  it('spawn_failed / unexpected_eof → crash', () => {
    expect(classifyCodexError(new AdapterError('spawn_failed', 'x'), clock).kind).toBe('crash');
    expect(classifyCodexError(new AdapterError('unexpected_eof', 'x'), clock).kind).toBe('crash');
  });

  it.each<AdapterErrorKind>([
    'handshake_timeout',
    'protocol_version_mismatch',
    'malformed_frame',
    'oversized_frame',
    'queue_overflow',
    'turn_timeout',
  ])('%s → protocol', (kind) => {
    expect(classifyCodexError(new AdapterError(kind, 'x'), clock).kind).toBe('protocol');
  });

  it('provider_error recurses into its carried envelope', () => {
    const wrapped = new AdapterError('provider_error', 'x', {
      envelope: { error: { code: -32603, data: { codexErrorInfo: 'usageLimitExceeded' } } },
    });
    expect(classifyCodexError(wrapped, clock).kind).toBe('usage_limit');
  });

  it('other AdapterError kinds (e.g. invalid_state) → unknown_provider_error', () => {
    expect(classifyCodexError(new AdapterError('invalid_state', 'x'), clock).kind).toBe('unknown_provider_error');
  });
});

describe('classifyCodexError — unrecognized JSON-RPC codes stay fail-safe', () => {
  it('an opaque negative code with no matching convention → unknown_provider_error', () => {
    const result = classifyCodexError({ error: { code: -32050, message: 'opaque' } }, clock);
    expect(result.kind).toBe('unknown_provider_error');
  });
});
