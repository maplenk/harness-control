import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../lib/clock.js';
import { AdapterError } from '../spi.js';
import { classifyGrokError } from './classify.js';

const clock = new ManualClock('2026-07-21T12:00:00.000Z');

describe('Grok provider-error classification', () => {
  it('classifies structured auth envelopes', () => {
    expect(classifyGrokError({ status: 401 }, clock).kind).toBe('auth');
    expect(classifyGrokError({ error: { data: { code: 'invalid_token' } } }, clock).kind).toBe(
      'auth',
    );
  });

  it('classifies 429 with a structured retry ETA', () => {
    expect(
      classifyGrokError(
        { error: { response: { statusCode: 429, headers: { 'retry-after': '30' } } } },
        clock,
      ),
    ).toMatchObject({
      kind: 'usage_limit',
      source: 'structured',
      detectionTier: 'http_429',
      resumesAt: '2026-07-21T12:00:30.000Z',
    });
  });

  it('classifies 402 and exact subscription/quota machine codes', () => {
    expect(classifyGrokError({ data: { status: 402 } }, clock).kind).toBe('usage_limit');
    expect(classifyGrokError({ error: { type: 'subscription_required' } }, clock)).toMatchObject({
      kind: 'usage_limit',
      source: 'structured',
    });
    expect(
      classifyGrokError(
        { code: -32603, message: 'personal-team-blocked:spending-limit: upgrade required' },
        clock,
      ),
    ).toMatchObject({ kind: 'usage_limit', source: 'parsed', confidence: 'medium' });
  });

  it('never classifies bare agent prose', () => {
    expect(classifyGrokError('I received a 429 rate limit', clock).kind).toBe(
      'unknown_provider_error',
    );
    expect(
      classifyGrokError('personal-team-blocked:spending-limit: upgrade required', clock).kind,
    ).toBe('unknown_provider_error');
  });

  it('maps typed adapter crash/protocol/provider errors', () => {
    expect(classifyGrokError(new AdapterError('unexpected_eof', 'exit'), clock).kind).toBe('crash');
    expect(classifyGrokError(new AdapterError('malformed_frame', 'bad'), clock).kind).toBe('protocol');
    expect(
      classifyGrokError(
        new AdapterError('provider_error', 'provider', { envelope: { status: 429 } }),
        clock,
      ).kind,
    ).toBe('usage_limit');
  });
});
