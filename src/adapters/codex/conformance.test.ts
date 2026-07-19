/**
 * Codex ACP profile — classifyError conformance fixture + PLAN §19 test 21.
 *
 * Mirrors `../claude/conformance.test.ts`'s PLAN §13 discipline, extended to
 * Codex: pins the `codex-acp@1.1.4` error-envelope shape as a fixture file
 * with a test asserting the parser against it, backed by a version-pin
 * check that FAILS LOUDLY on drift (`command.ts`'s
 * `assertCodexAdapterVersionPinned`) — justified because this profile
 * relies on the verified `codexErrorInfo` discriminator (see
 * `capabilities.ts`'s DEVIATION doc comment), which is exactly the kind of
 * version-specific, unpublished adapter behavior PLAN §13's
 * re-characterization trigger exists to protect against drifting silently.
 *
 * "Write PLAN 19 test 21: envelope fixtures (structured, 429, unknown) ->
 * correct tier/ETA; assert agent-message text path cannot classify
 * (type-level + runtime guard test)."
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../lib/clock.js';
import { EXPECTED_CODEX_ADAPTER_VERSION, resolveCodexCommand } from './command.js';
import { classifyCodexError } from './classify.js';
import {
  CODEX_AGENT_TEXT_MENTIONING_LIMITS,
  CODEX_AUTH_CONFIGURED_INTERNAL_ERROR_ENVELOPE,
  CODEX_AUTH_REQUIRED_ENVELOPE,
  CODEX_GENERIC_INTERNAL_ERROR_ENVELOPE,
  CODEX_HTTP_429_ENVELOPE,
  CODEX_OPAQUE_ENVELOPE,
  CODEX_PROCESS_EXITED_ENVELOPE,
  CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE,
  CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE_BARE,
} from './fixtures/codex-error-envelopes.js';

const clock = new ManualClock('2026-07-18T00:00:00.000Z');

describe('conformance: fixture was captured against the currently-pinned version', () => {
  it('the installed codex-acp version matches what the fixture documents', () => {
    // If this fails, package.json's dependency was bumped without the
    // fixture (and this test file) being re-verified against the new
    // adapter source — see command.ts's assertCodexAdapterVersionPinned for
    // the loud, throwing form of this same check.
    expect(resolveCodexCommand().version).toBe(EXPECTED_CODEX_ADAPTER_VERSION);
    expect(EXPECTED_CODEX_ADAPTER_VERSION).toBe('1.1.4');
  });
});

describe('conformance: classifyCodexError against the pinned fixture (verified structured signal)', () => {
  it('the wrapped {jsonrpc,id,error} wire shape classifies as structured usage_limit', () => {
    expect(classifyCodexError(CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE, clock)).toEqual({
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
      provider: 'codex',
    });
  });

  it('the bare {code,message,data} shape classifies identically (wrapper-agnostic)', () => {
    expect(classifyCodexError(CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE_BARE, clock)).toEqual(
      classifyCodexError(CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE, clock),
    );
  });

  it('honestly carries NO resumesAt for the current envelope shape (no invented countdown)', () => {
    const result = classifyCodexError(CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE, clock);
    expect('resumesAt' in result).toBe(false);
  });
});

describe('§19 test 21: envelope fixtures → correct tier/ETA', () => {
  it('structured (codexErrorInfo=usageLimitExceeded, -32603) → usage_limit / structured tier', () => {
    const r = classifyCodexError(CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE, clock);
    expect(r.kind).toBe('usage_limit');
    expect(r.source).toBe('structured');
    expect(r.detectionTier).toBe('structured');
  });

  it('429 (+ Retry-After) → usage_limit / http_429 tier with a resolved ETA', () => {
    const r = classifyCodexError(CODEX_HTTP_429_ENVELOPE, clock);
    expect(r.kind).toBe('usage_limit');
    expect(r.detectionTier).toBe('http_429');
    expect(r.resumesAt).toBeDefined();
  });

  it('unknown (different codexErrorInfo, no codexErrorInfo, process-exit code routed generically, opaque code) → correct classification', () => {
    for (const envelope of [CODEX_AUTH_CONFIGURED_INTERNAL_ERROR_ENVELOPE, CODEX_GENERIC_INTERNAL_ERROR_ENVELOPE, CODEX_OPAQUE_ENVELOPE]) {
      const r = classifyCodexError(envelope, clock);
      expect(r.kind).toBe('unknown_provider_error');
      expect(r.detectionTier).toBe('unknown');
    }
  });

  it('a protocol-level auth code classifies distinctly from usage_limit/unknown', () => {
    expect(classifyCodexError(CODEX_AUTH_REQUIRED_ENVELOPE, clock).kind).toBe('auth');
  });

  it('the codex-specific process-exit code classifies as crash, distinctly from unknown', () => {
    expect(classifyCodexError(CODEX_PROCESS_EXITED_ENVELOPE, clock).kind).toBe('crash');
  });

  it('agent-message text that MENTIONS usage limits/codexErrorInfo still never classifies', () => {
    const r = classifyCodexError(CODEX_AGENT_TEXT_MENTIONING_LIMITS, clock);
    expect(r.kind).toBe('unknown_provider_error');
    expect(r.source).toBe('parsed');
    expect(r.confidence).toBe('low');
  });

  it('runtime guard: classifyError never distinguishes a string by its CONTENT, only its type', () => {
    const stringified = JSON.stringify(CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE);
    expect(classifyCodexError(stringified, clock).kind).toBe('unknown_provider_error');
    expect(classifyCodexError(JSON.parse(stringified), clock).kind).toBe('usage_limit');
  });
});
