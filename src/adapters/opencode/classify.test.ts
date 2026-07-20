import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../lib/clock.js';
import { AdapterError } from '../spi.js';
import { classifyOpenCodeError } from './classify.js';

const CLOCK = new ManualClock('2026-07-20T12:00:00.000Z');

describe('OpenCode error classification', () => {
  it('classifies structural auth and rate-limit envelopes', () => {
    expect(classifyOpenCodeError({ code: -32000, data: {} }, CLOCK).kind).toBe('auth');
    expect(
      classifyOpenCodeError(
        { code: -32603, data: { errorName: 'ProviderError', response: { status: 429 } } },
        CLOCK,
      ),
    ).toMatchObject({ kind: 'usage_limit', detectionTier: 'http_429' });
    expect(
      classifyOpenCodeError({ code: -32603, data: { errorName: 'ProviderAuthError' } }, CLOCK).kind,
    ).toBe('auth');
  });

  it('classifies xAI subscription/credit exhaustion (HTTP 402) as a usage limit', () => {
    expect(
      classifyOpenCodeError(
        {
          name: 'APIError',
          data: {
            message:
              'personal-team-blocked:spending-limit: You have run out of credits or need a Grok subscription.',
            statusCode: 402,
          },
        },
        CLOCK,
      ),
    ).toMatchObject({
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
      provider: 'opencode',
    });
  });

  it('classifies the xAI spending-limit machine code preserved by ACP', () => {
    const envelope = {
      code: -32603,
      message:
        'Internal error: personal-team-blocked:spending-limit: You have run out of credits or need a Grok subscription.',
    };
    expect(classifyOpenCodeError(envelope, CLOCK)).toMatchObject({
      kind: 'usage_limit',
      source: 'parsed',
      confidence: 'medium',
      detectionTier: 'parsed',
      provider: 'opencode',
    });
    // The same words as free agent prose remain untrusted.
    expect(classifyOpenCodeError(envelope.message, CLOCK).kind).toBe(
      'unknown_provider_error',
    );
  });

  it('never classifies agent prose and recurses through provider AdapterError', () => {
    expect(classifyOpenCodeError('I hit a 429 rate limit', CLOCK).kind).toBe(
      'unknown_provider_error',
    );
    const wrapped = new AdapterError('provider_error', 'provider failed', {
      envelope: { status: 429 },
    });
    expect(classifyOpenCodeError(wrapped, CLOCK).kind).toBe('usage_limit');
  });
});
