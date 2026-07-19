/**
 * Claude ACP profile — PLAN §13 conformance fixture + §19 test 21.
 *
 * "errorKind CONFORMANCE FIXTURE: pin the claude-agent-acp@0.59.0 error
 * envelope shape as a fixture file with a test asserting our parser against
 * it, plus a version-pin check ... FAILS LOUDLY ... if it differs from
 * 0.59.0."
 *
 * "Write PLAN 19 test 21: envelope fixtures (structured, 429, unknown) ->
 * correct tier/ETA; assert agent-message text path cannot classify
 * (type-level + runtime guard test)."
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../lib/clock.js';
import { EXPECTED_CLAUDE_ADAPTER_VERSION, resolveClaudeCommand } from './command.js';
import { classifyClaudeError } from './classify.js';
import {
  CLAUDE_AGENT_TEXT_MENTIONING_LIMITS,
  CLAUDE_AUTH_REQUIRED_ENVELOPE,
  CLAUDE_HTTP_429_ENVELOPE,
  CLAUDE_HTTP_429_ENVELOPE_HTTP_DATE,
  CLAUDE_NO_RESULT_ENVELOPE,
  CLAUDE_OPAQUE_ENVELOPE,
  CLAUDE_OVERLOADED_ENVELOPE,
  CLAUDE_RATE_LIMIT_ENVELOPE,
  CLAUDE_RATE_LIMIT_ENVELOPE_BARE,
} from './fixtures/claude-error-envelopes.js';

const clock = new ManualClock('2026-07-18T00:00:00.000Z');

describe('conformance: fixture was captured against the currently-pinned version', () => {
  it('the installed claude-agent-acp version matches what the fixture documents', () => {
    // If this fails, `package.json`'s dependency was bumped without the
    // fixture (and this test file) being re-verified against the new
    // adapter source — see command.ts's assertClaudeAdapterVersionPinned
    // for the loud, throwing form of this same check.
    expect(resolveClaudeCommand().version).toBe(EXPECTED_CLAUDE_ADAPTER_VERSION);
    expect(EXPECTED_CLAUDE_ADAPTER_VERSION).toBe('0.59.0');
  });
});

describe('conformance: classifyClaudeError against the pinned fixture (PLAN §13 flagship)', () => {
  it('the wrapped {jsonrpc,id,error} wire shape classifies as structured usage_limit', () => {
    expect(classifyClaudeError(CLAUDE_RATE_LIMIT_ENVELOPE, clock)).toEqual({
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
      provider: 'claude',
    });
  });

  it('the bare {code,message,data} shape classifies identically (wrapper-agnostic)', () => {
    expect(classifyClaudeError(CLAUDE_RATE_LIMIT_ENVELOPE_BARE, clock)).toEqual(
      classifyClaudeError(CLAUDE_RATE_LIMIT_ENVELOPE, clock),
    );
  });

  it('honestly carries NO resumesAt for the current envelope shape (no invented countdown)', () => {
    const result = classifyClaudeError(CLAUDE_RATE_LIMIT_ENVELOPE, clock);
    expect('resumesAt' in result).toBe(false);
  });
});

describe('§19 test 21: envelope fixtures → correct tier/ETA', () => {
  it('structured (rate_limit, -32603) → usage_limit / structured tier', () => {
    const r = classifyClaudeError(CLAUDE_RATE_LIMIT_ENVELOPE, clock);
    expect(r.kind).toBe('usage_limit');
    expect(r.source).toBe('structured');
    expect(r.detectionTier).toBe('structured');
  });

  it('429 (+ Retry-After) → usage_limit / http_429 tier with a resolved ETA', () => {
    const seconds = classifyClaudeError(CLAUDE_HTTP_429_ENVELOPE, clock);
    expect(seconds.kind).toBe('usage_limit');
    expect(seconds.detectionTier).toBe('http_429');
    expect(seconds.resumesAt).toBeDefined();

    const httpDate = classifyClaudeError(CLAUDE_HTTP_429_ENVELOPE_HTTP_DATE, clock);
    expect(httpDate.kind).toBe('usage_limit');
    expect(httpDate.resumesAt).toBe(new Date('2026-10-21T07:28:00.000Z').toISOString());
  });

  it('unknown (structured-but-ungated errorKind, adapter-internal marker, opaque code) → unknown_provider_error', () => {
    for (const envelope of [CLAUDE_OVERLOADED_ENVELOPE, CLAUDE_NO_RESULT_ENVELOPE, CLAUDE_OPAQUE_ENVELOPE]) {
      const r = classifyClaudeError(envelope, clock);
      expect(r.kind).toBe('unknown_provider_error');
      expect(r.detectionTier).toBe('unknown');
    }
  });

  it('a protocol-level auth code classifies distinctly from usage_limit/unknown', () => {
    expect(classifyClaudeError(CLAUDE_AUTH_REQUIRED_ENVELOPE, clock).kind).toBe('auth');
  });

  it('agent-message text that MENTIONS rate limits/429/errorKind still never classifies', () => {
    const r = classifyClaudeError(CLAUDE_AGENT_TEXT_MENTIONING_LIMITS, clock);
    expect(r.kind).toBe('unknown_provider_error');
    expect(r.source).toBe('parsed');
    expect(r.confidence).toBe('low');
  });

  it('runtime guard: classifyError never distinguishes a string by its CONTENT, only its type', () => {
    // Same fixture-derived text, but also fed through JSON.stringify of the
    // REAL structured envelope — proves the guard is type-based (typeof
    // raw === 'string'), not a content heuristic that happens to miss this
    // one string.
    const stringified = JSON.stringify(CLAUDE_RATE_LIMIT_ENVELOPE);
    expect(classifyClaudeError(stringified, clock).kind).toBe('unknown_provider_error');
    // ...while the parsed OBJECT form of the exact same content DOES classify.
    expect(classifyClaudeError(JSON.parse(stringified), clock).kind).toBe('usage_limit');
  });
});
