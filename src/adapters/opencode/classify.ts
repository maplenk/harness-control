/**
 * OpenCode ACP provider-error classification.
 *
 * Inputs are adapter/JSON-RPC/HTTP envelopes only. Plain strings are always
 * rejected so model prose mentioning "429" or "rate limit" cannot pause a
 * run. OpenCode multiplexes many providers, so positive classification is
 * intentionally limited to structural status codes and exact error names.
 */
import type { Clock, IsoTimestamp } from '../../lib/clock.js';
import { isoTimestamp } from '../../lib/clock.js';
import { AdapterError, type AdapterErrorKind, type ErrorClassification } from '../spi.js';
import { OPENCODE_HARNESS_ID } from './capabilities.js';

type EnvelopeRecord = Record<string, unknown>;

const JSONRPC_AUTH_REQUIRED = -32000;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

const UNKNOWN: ErrorClassification = {
  kind: 'unknown_provider_error',
  source: 'parsed',
  confidence: 'low',
  detectionTier: 'unknown',
  provider: OPENCODE_HARNESS_ID,
};

const CRASH_KINDS: readonly AdapterErrorKind[] = ['spawn_failed', 'unexpected_eof'];
const PROTOCOL_KINDS: readonly AdapterErrorKind[] = [
  'handshake_timeout',
  'protocol_version_mismatch',
  'malformed_frame',
  'oversized_frame',
  'queue_overflow',
  'turn_timeout',
];
const AUTH_ERROR_NAMES = new Set(['ProviderAuthError', 'AuthRequiredError']);
const LIMIT_ERROR_NAMES = new Set(['RateLimitError', 'TooManyRequestsError']);
/**
 * Live xAI/SuperGrok failure observed through OpenCode ACP 1.18.1. The ACP
 * server removes the HTTP 402 field but preserves this stable machine code in
 * the JSON-RPC error envelope's message. Matching is allowed only after the
 * input has been proven to be an envelope object; free agent text still exits
 * at the string guard above.
 */
const XAI_SPENDING_LIMIT_CODE = 'personal-team-blocked:spending-limit';

function asRecord(value: unknown): EnvelopeRecord | undefined {
  return value !== null && typeof value === 'object' ? (value as EnvelopeRecord) : undefined;
}

function findNumericStatus(value: unknown, depth = 0): number | undefined {
  if (depth > 4) return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const candidate = record[key];
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  for (const key of ['data', 'error', 'cause', 'response']) {
    const nested = findNumericStatus(record[key], depth + 1);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function resumeEta(data: EnvelopeRecord | undefined, clock: Clock): { resumesAt?: IsoTimestamp } {
  if (data === undefined) return {};
  const resumesAt = data['resumesAt'];
  if (typeof resumesAt === 'string' && !Number.isNaN(Date.parse(resumesAt))) {
    return { resumesAt: isoTimestamp(new Date(Date.parse(resumesAt)).toISOString()) };
  }
  const seconds = data['retryAfterSeconds'];
  if (typeof seconds === 'number' && Number.isFinite(seconds)) {
    return { resumesAt: isoTimestamp(new Date(clock.nowMs() + seconds * 1000).toISOString()) };
  }
  return {};
}

function classifyAdapterError(error: AdapterError, clock: Clock): ErrorClassification {
  if (error.kind === 'provider_error') return classifyOpenCodeError(error.envelope, clock);
  if (CRASH_KINDS.includes(error.kind)) {
    return { kind: 'crash', source: 'structured', confidence: 'high', provider: OPENCODE_HARNESS_ID };
  }
  if (PROTOCOL_KINDS.includes(error.kind)) {
    return { kind: 'protocol', source: 'structured', confidence: 'high', provider: OPENCODE_HARNESS_ID };
  }
  return { ...UNKNOWN };
}

export function classifyOpenCodeError(raw: unknown, clock: Clock): ErrorClassification {
  if (typeof raw === 'string') return { ...UNKNOWN };
  if (raw instanceof AdapterError) return classifyAdapterError(raw, clock);

  const record = asRecord(raw);
  if (record === undefined) return { ...UNKNOWN };
  const envelope = asRecord(record['error']) ?? record;
  const data = asRecord(envelope['data']);
  const code = envelope['code'];
  const status = findNumericStatus(envelope);
  const errorName =
    typeof data?.['errorName'] === 'string'
      ? data['errorName']
      : typeof envelope['name'] === 'string'
        ? envelope['name']
        : undefined;
  const envelopeMessage =
    typeof envelope['message'] === 'string' ? envelope['message'] : undefined;

  if (code === JSONRPC_AUTH_REQUIRED || status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
    return { kind: 'auth', source: 'structured', confidence: 'high', provider: OPENCODE_HARNESS_ID };
  }
  if (errorName !== undefined && AUTH_ERROR_NAMES.has(errorName)) {
    return { kind: 'auth', source: 'structured', confidence: 'high', provider: OPENCODE_HARNESS_ID };
  }
  if (
    status === HTTP_TOO_MANY_REQUESTS ||
    status === HTTP_PAYMENT_REQUIRED ||
    (errorName !== undefined && LIMIT_ERROR_NAMES.has(errorName)) ||
    envelopeMessage?.includes(XAI_SPENDING_LIMIT_CODE) === true
  ) {
    return {
      kind: 'usage_limit',
      source:
        status === HTTP_TOO_MANY_REQUESTS || status === HTTP_PAYMENT_REQUIRED
          ? 'structured'
          : 'parsed',
      confidence:
        status === HTTP_TOO_MANY_REQUESTS || status === HTTP_PAYMENT_REQUIRED
          ? 'high'
          : 'medium',
      detectionTier:
        status === HTTP_TOO_MANY_REQUESTS
          ? 'http_429'
          : status === HTTP_PAYMENT_REQUIRED
            ? 'structured'
            : 'parsed',
      provider: OPENCODE_HARNESS_ID,
      ...resumeEta(data, clock),
    };
  }
  return { ...UNKNOWN };
}
