/**
 * Codex ACP profile — classifyError (PLAN §9, §13).
 *
 * Ground truth (verified against the pinned `codex-acp@1.1.4` +
 * `@agentclientprotocol/sdk@1.2.1` sources — see
 * `fixtures/codex-error-envelopes.ts` for exact citations):
 *
 *  - `createErrorEvent(params)` (codex-acp `dist/index.js` ~line 23841)
 *    checks `params.error.codexErrorInfo === "usageLimitExceeded"` — an
 *    EXACT string-enum comparison, not a free-text pattern — and when true
 *    raises `RequestError.internalError(this.createTurnErrorData(params.error))`:
 *    JSON-RPC code `-32603` with `data = {message, codexErrorInfo:
 *    'usageLimitExceeded', additionalDetails?}` (`createTurnErrorData()`
 *    ~line 23879). THIS IS A GENUINE STRUCTURED SIGNAL, distinct from the
 *    `RateLimitSnapshot` proactive telemetry PLAN §3/§13 cites issue #227
 *    for (that one really is internal-only bookkeeping — see
 *    `capabilities.ts`'s DEVIATION doc comment for the full distinction).
 *  - The SAME `createErrorEvent` also raises `RequestError.authRequired(data,
 *    message)` (code `-32000`, the SAME shared `@agentclientprotocol/sdk`
 *    factory Claude uses) when `isAuthenticationRequiredError(error)` is
 *    true AND auth isn't yet configured (`sessionState.authConfigured`) —
 *    OTHERWISE (auth IS configured) it uses the SAME `-32603` internalError
 *    path instead. `isAuthenticationRequiredError` checks
 *    `error === 'unauthorized'` or an HTTP 401 status embedded in specific
 *    connection-failure variants.
 *  - `runWithProcessCheck()` (~line 29577) uses a NON-standard positive
 *    JSON-RPC code `1001` ("Codex process has exited with code ...") when
 *    the underlying `codex` child process itself has died mid-request — a
 *    crash signal that can arrive as an ordinary JSON-RPC error response to
 *    a pending `session/prompt`, ahead of the transport's own process-exit
 *    detection.
 *  - HTTP 429 (+ `Retry-After`) is recognized defensively for API-key mode
 *    (PLAN §13, shared convention with Claude).
 *
 * Absolutely NO free-text pattern matching: `raw` is inspected ONLY for its
 * envelope SHAPE — string inputs (agent-message text) are rejected outright,
 * before any parsing.
 */
import type { Clock, IsoTimestamp } from '../../lib/clock.js';
import { isoTimestamp } from '../../lib/clock.js';
import { AdapterError, type AdapterErrorKind, type ErrorClassification } from '../spi.js';
import { CODEX_HARNESS_ID } from './capabilities.js';

/** `RequestError.internalError` (`@agentclientprotocol/sdk/dist/jsonrpc.js`),
 * the SAME factory Claude uses (shared SDK). */
const JSONRPC_INTERNAL_ERROR = -32603;
/** `RequestError.authRequired` (same shared source). */
const JSONRPC_AUTH_REQUIRED = -32000;
/** codex-acp's OWN non-standard code for "the codex child process itself
 * exited" (`runWithProcessCheck()`, verified ~line 29582). */
const CODEX_PROCESS_EXITED_CODE = 1001;
/** The exact string-enum discriminator `createErrorEvent()` compares
 * against (verified, not inferred). */
const CODEX_ERROR_INFO_USAGE_LIMIT_EXCEEDED = 'usageLimitExceeded';
/** HTTP status codes recognized in API-key mode (PLAN §13). */
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

const UNKNOWN_CLASSIFICATION: ErrorClassification = {
  kind: 'unknown_provider_error',
  source: 'parsed',
  confidence: 'low',
  detectionTier: 'unknown',
  provider: CODEX_HARNESS_ID,
};

// ---------------------------------------------------------------------------
// Envelope shape narrowing. `EnvelopeRecord` EXCLUDES `string` by
// construction — exported ONLY so `classify.test.ts` can prove this at the
// type level with `@ts-expect-error` (mirrors ../claude/classify.ts).
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
 * Claude (PLAN §13). Returns `undefined` when `record` isn't HTTP-shaped. */
function classifyHttpEnvelope(record: EnvelopeRecord, clock: Clock): ErrorClassification | undefined {
  const status = record['status'];
  if (status === HTTP_TOO_MANY_REQUESTS) {
    return {
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'http_429',
      provider: CODEX_HARNESS_ID,
      ...retryAfterHeaderEta(asRecord(record['headers']), clock),
    };
  }
  if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
    return { kind: 'auth', source: 'structured', confidence: 'high', provider: CODEX_HARNESS_ID };
  }
  return undefined;
}

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
  if (error.kind === 'provider_error') return classifyCodexError(error.envelope, clock);
  if (CRASH_ADAPTER_ERROR_KINDS.includes(error.kind)) {
    return { kind: 'crash', source: 'structured', confidence: 'high', provider: CODEX_HARNESS_ID };
  }
  if (PROTOCOL_ADAPTER_ERROR_KINDS.includes(error.kind)) {
    return { kind: 'protocol', source: 'structured', confidence: 'high', provider: CODEX_HARNESS_ID };
  }
  return { ...UNKNOWN_CLASSIFICATION };
}

/**
 * Codex's §9 `classifyError`. Operates ONLY on adapter/protocol error
 * envelopes — see the module header for the exact verified shapes. ANY
 * string input (agent-message text) is rejected immediately, before any
 * parsing.
 */
export function classifyCodexError(raw: unknown, clock: Clock): ErrorClassification {
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
  const codexErrorInfo = typeof data?.['codexErrorInfo'] === 'string' ? data['codexErrorInfo'] : undefined;

  if (code === JSONRPC_INTERNAL_ERROR && codexErrorInfo === CODEX_ERROR_INFO_USAGE_LIMIT_EXCEEDED) {
    return {
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
      provider: CODEX_HARNESS_ID,
      ...resumesAtFromData(data, clock),
    };
  }
  if (code === JSONRPC_AUTH_REQUIRED) {
    return { kind: 'auth', source: 'structured', confidence: 'high', provider: CODEX_HARNESS_ID };
  }
  if (code === CODEX_PROCESS_EXITED_CODE) {
    return { kind: 'crash', source: 'structured', confidence: 'high', provider: CODEX_HARNESS_ID };
  }
  // Any other code (incl. -32603 with a DIFFERENT/absent codexErrorInfo) —
  // no positive crash/auth/protocol match — falls through fail-safe.
  return { ...UNKNOWN_CLASSIFICATION };
}
