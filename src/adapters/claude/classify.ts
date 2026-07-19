/**
 * Claude ACP profile — classifyError (PLAN §9, §13).
 *
 * Ground truth (verified against the pinned `claude-agent-acp@0.59.0` +
 * `@agentclientprotocol/sdk@1.2.1` sources — see
 * `fixtures/claude-error-envelopes.ts` for exact citations):
 *
 *  - Every turn-failure the adapter reports uses
 *    `RequestError.internalError(data, message)` → JSON-RPC code `-32603`,
 *    with `data = {errorKind}` when a categorical error is known
 *    (`errorKindData()`, acp-agent.js). `errorKind` is fed from the Claude
 *    Agent SDK's `SDKAssistantMessage.error?: SDKAssistantMessageError`
 *    (`sdk.d.ts`), a CLOSED union: `'authentication_failed' |
 *    'oauth_org_not_allowed' | 'billing_error' | 'rate_limit' | 'overloaded'
 *    | 'invalid_request' | 'model_not_found' | 'server_error' | 'unknown' |
 *    'max_output_tokens'` — plus the adapter's own internal `'no_result'`
 *    marker. PLAN §13 normatively pins ONLY `'rate_limit'` as the flagship
 *    structured usage-limit signal; every other value (even though
 *    STRUCTURED data, not free text) is gated behind the P4a real-transcript
 *    corpus review and therefore classifies as `unknown_provider_error` —
 *    fail-safe by construction (PLAN §13: "Misclassification is fail-safe by
 *    construction ... pauses (T16) and never feeds the breaker").
 *  - `RequestError.authRequired()` → JSON-RPC code `-32000`, called with NO
 *    data (acp-agent.js: `failActive(RequestError.authRequired())` on the
 *    "Please run /login" message match). This is a dedicated PROTOCOL-LEVEL
 *    code from the shared `@agentclientprotocol/sdk`'s `RequestError` static
 *    factory — a "positive ... protocol match" (PLAN §13), not a text
 *    pattern — so it classifies as `auth`.
 *  - HTTP 429 (+ `Retry-After`) is recognized defensively for API-key mode
 *    (PLAN §13, shared convention with Codex) even though claude-agent-acp's
 *    own dist always wraps failures in JSON-RPC — a direct HTTP-layer
 *    integration bypassing the ACP subprocess would still need this.
 *
 * Absolutely NO free-text pattern matching: `raw` is inspected ONLY for its
 * envelope SHAPE (JSON-RPC `code`/`data`, or `status`/`headers`) — string
 * inputs (agent-message text) are rejected outright, before any parsing, by
 * construction (see the type-level guard below the string check).
 */
import type { Clock, IsoTimestamp } from '../../lib/clock.js';
import { isoTimestamp } from '../../lib/clock.js';
import { AdapterError, type AdapterErrorKind, type ErrorClassification } from '../spi.js';
import { CLAUDE_HARNESS_ID } from './capabilities.js';

/** `RequestError.internalError` (`@agentclientprotocol/sdk/dist/jsonrpc.js`). */
const JSONRPC_INTERNAL_ERROR = -32603;
/** `RequestError.authRequired` (same source) — Claude's "Please run /login"
 * path calls this with NO data (acp-agent.js ~line 2036). */
const JSONRPC_AUTH_REQUIRED = -32000;
/** HTTP status codes recognized in API-key mode (PLAN §13). */
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

const UNKNOWN_CLASSIFICATION: ErrorClassification = {
  kind: 'unknown_provider_error',
  source: 'parsed',
  confidence: 'low',
  detectionTier: 'unknown',
  provider: CLAUDE_HARNESS_ID,
};

// ---------------------------------------------------------------------------
// Envelope shape narrowing. `EnvelopeRecord` EXCLUDES `string` by
// construction (an object/index-signature shape, not a primitive) — no
// downstream branch can ever see agent-message text as a classifiable
// shape. Exported ONLY so `classify.test.ts` can prove this at the type
// level with `@ts-expect-error` (a plain string must fail to satisfy this
// type — if that assignment ever stops erroring, the envelope shape has
// silently widened to admit text, and `npm run typecheck` fails loudly).
// ---------------------------------------------------------------------------
export type EnvelopeRecord = Record<string, unknown>;

function asRecord(value: unknown): EnvelopeRecord | undefined {
  return value !== null && typeof value === 'object' ? (value as EnvelopeRecord) : undefined;
}

function resumesAtFromData(data: EnvelopeRecord | undefined, clock: Clock): { resumesAt?: IsoTimestamp } {
  if (data === undefined) return {};
  const resumesAt = data['resumesAt'];
  if (typeof resumesAt === 'string' && !Number.isNaN(Date.parse(resumesAt))) {
    return { resumesAt: isoTimestamp(new Date(Date.parse(resumesAt)).toISOString()) };
  }
  const retryAfterSeconds = data['retryAfterSeconds'];
  if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds)) {
    return { resumesAt: isoTimestamp(new Date(clock.nowMs() + retryAfterSeconds * 1000).toISOString()) };
  }
  return {};
}

function retryAfterHeaderEta(
  headers: EnvelopeRecord | undefined,
  clock: Clock,
): { resumesAt?: IsoTimestamp } {
  const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof raw !== 'string' && typeof raw !== 'number') return {};
  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    return { resumesAt: isoTimestamp(new Date(clock.nowMs() + asNumber * 1000).toISOString()) };
  }
  const asDate = Date.parse(String(raw));
  if (!Number.isNaN(asDate)) {
    return { resumesAt: isoTimestamp(new Date(asDate).toISOString()) };
  }
  return {};
}

/** HTTP-shaped envelope recognized in API-key mode — shared convention with
 * Codex (PLAN §13). Returns `undefined` when `record` isn't HTTP-shaped. */
function classifyHttpEnvelope(record: EnvelopeRecord, clock: Clock): ErrorClassification | undefined {
  const status = record['status'];
  if (status === HTTP_TOO_MANY_REQUESTS) {
    return {
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'http_429',
      provider: CLAUDE_HARNESS_ID,
      ...retryAfterHeaderEta(asRecord(record['headers']), clock),
    };
  }
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
    return { kind: 'auth', source: 'structured', confidence: 'high', provider: CLAUDE_HARNESS_ID };
  }
  return undefined;
}

/** Transport-level `AdapterError` kinds (§10.2 wire bounds / process
 * lifecycle) map to `crash`/`protocol` directly; `provider_error` recurses
 * into its carried envelope. Kept local (not imported from the test-only
 * `fake/in-process.ts`) — a real adapter profile must not depend on test
 * scaffolding. */
const CRASH_ADAPTER_ERROR_KINDS: readonly AdapterErrorKind[] = ['spawn_failed', 'unexpected_eof'];
const PROTOCOL_ADAPTER_ERROR_KINDS: readonly AdapterErrorKind[] = [
  'handshake_timeout',
  'protocol_version_mismatch',
  'malformed_frame',
  'oversized_frame',
  'queue_overflow',
  'turn_timeout',
];

function classifyAdapterError(error: AdapterError, clock: Clock): ErrorClassification {
  if (error.kind === 'provider_error') return classifyClaudeError(error.envelope, clock);
  if (CRASH_ADAPTER_ERROR_KINDS.includes(error.kind)) {
    return { kind: 'crash', source: 'structured', confidence: 'high', provider: CLAUDE_HARNESS_ID };
  }
  if (PROTOCOL_ADAPTER_ERROR_KINDS.includes(error.kind)) {
    return { kind: 'protocol', source: 'structured', confidence: 'high', provider: CLAUDE_HARNESS_ID };
  }
  return { ...UNKNOWN_CLASSIFICATION };
}

/**
 * Claude's §9 `classifyError`. Operates ONLY on adapter/protocol error
 * envelopes — see the module header for the exact verified shapes. ANY
 * string input (agent-message text) is rejected immediately, before any
 * parsing: `typeof raw === 'string'` short-circuits to
 * `unknown_provider_error` without ever attempting `JSON.parse` or a
 * substring scan, so a model merely *talking about* "rate limit" or "429"
 * can never pause a run.
 */
export function classifyClaudeError(raw: unknown, clock: Clock): ErrorClassification {
  if (typeof raw === 'string') return { ...UNKNOWN_CLASSIFICATION }; // agent text: NEVER classified
  if (raw instanceof AdapterError) return classifyAdapterError(raw, clock);

  const record = asRecord(raw);
  if (record === undefined) return { ...UNKNOWN_CLASSIFICATION };

  const http = classifyHttpEnvelope(record, clock);
  if (http !== undefined) return http;

  // Accept either the bare JSON-RPC error object ({code,message,data}, e.g.
  // AdapterError('provider_error').envelope) or a wrapped {error:{...}} /
  // RequestError.toResult() shape.
  const envelope = asRecord(record['error']) ?? record;
  const code = envelope['code'];
  const data = asRecord(envelope['data']);
  const errorKind = typeof data?.['errorKind'] === 'string' ? data['errorKind'] : undefined;

  if (code === JSONRPC_INTERNAL_ERROR && errorKind === 'rate_limit') {
    return {
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
      provider: CLAUDE_HARNESS_ID,
      ...resumesAtFromData(data, clock),
    };
  }
  if (code === JSONRPC_AUTH_REQUIRED) {
    return { kind: 'auth', source: 'structured', confidence: 'high', provider: CLAUDE_HARNESS_ID };
  }
  // Any other -32xxx (incl. -32603 with a DIFFERENT errorKind, e.g.
  // 'overloaded'/'billing_error'/'no_result') — no positive crash/auth/
  // protocol match — falls through fail-safe (PLAN §13).
  return { ...UNKNOWN_CLASSIFICATION };
}
