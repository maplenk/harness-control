/** Grok Build ACP/provider error classification. */
import type { Clock, IsoTimestamp } from '../../lib/clock.js';
import { isoTimestamp } from '../../lib/clock.js';
import { AdapterError, type AdapterErrorKind, type ErrorClassification } from '../spi.js';
import { GROK_HARNESS_ID } from './capabilities.js';

type EnvelopeRecord = Record<string, unknown>;

const HTTP_PAYMENT_REQUIRED = 402;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_TOO_MANY_REQUESTS = 429;
const JSONRPC_AUTH_REQUIRED = -32000;

const AUTH_CODES = new Set([
  'auth_required',
  'authentication_required',
  'invalid_api_key',
  'invalid_token',
  'token_expired',
  'unauthorized',
]);
const LIMIT_CODES = new Set([
  'insufficient_quota',
  'payment_required',
  'rate_limit_exceeded',
  'spending_limit_reached',
  'subscription_required',
  'too_many_requests',
]);
const AUTH_NAMES = new Set(['AuthError', 'AuthenticationError', 'AuthRequiredError']);
const LIMIT_NAMES = new Set(['RateLimitError', 'TooManyRequestsError', 'PaymentRequiredError']);
const SPENDING_LIMIT_MACHINE_CODE = 'personal-team-blocked:spending-limit';

const UNKNOWN: ErrorClassification = {
  kind: 'unknown_provider_error',
  source: 'parsed',
  confidence: 'low',
  detectionTier: 'unknown',
  provider: GROK_HARNESS_ID,
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

function asRecord(value: unknown): EnvelopeRecord | undefined {
  return value !== null && typeof value === 'object' ? (value as EnvelopeRecord) : undefined;
}

function findNumericStatus(value: unknown, depth = 0): number | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of ['status', 'statusCode', 'httpStatus']) {
    const status = record[key];
    if (typeof status === 'number' && Number.isFinite(status)) return status;
  }
  for (const key of ['error', 'data', 'cause', 'response', 'body']) {
    const status = findNumericStatus(record[key], depth + 1);
    if (status !== undefined) return status;
  }
  return undefined;
}

function findMachineToken(value: unknown, allowedKeys: ReadonlySet<string>, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  for (const key of ['errorName', 'name', 'type', 'errorType', 'error_code']) {
    const token = record[key];
    if (typeof token === 'string' && allowedKeys.has(token)) return token;
  }
  const code = record['code'];
  if (typeof code === 'string' && allowedKeys.has(code)) return code;
  for (const key of ['error', 'data', 'cause', 'response', 'body']) {
    const token = findMachineToken(record[key], allowedKeys, depth + 1);
    if (token !== undefined) return token;
  }
  return undefined;
}

function findMessage(value: unknown, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const record = asRecord(value);
  if (record === undefined) return undefined;
  if (typeof record['message'] === 'string') return record['message'];
  for (const key of ['error', 'data', 'cause', 'response', 'body']) {
    const message = findMessage(record[key], depth + 1);
    if (message !== undefined) return message;
  }
  return undefined;
}

function resumeEta(value: unknown, clock: Clock, depth = 0): { resumesAt?: IsoTimestamp } {
  if (depth > 5) return {};
  const record = asRecord(value);
  if (record === undefined) return {};
  const resumesAt = record['resumesAt'] ?? record['retryAt'];
  if (typeof resumesAt === 'string' && !Number.isNaN(Date.parse(resumesAt))) {
    return { resumesAt: isoTimestamp(new Date(Date.parse(resumesAt)).toISOString()) };
  }
  const seconds = record['retryAfterSeconds'];
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
    return { resumesAt: isoTimestamp(new Date(clock.nowMs() + seconds * 1_000).toISOString()) };
  }
  const headers = asRecord(record['headers']);
  const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After'];
  if (typeof retryAfter === 'number' || typeof retryAfter === 'string') {
    const numeric = Number(retryAfter);
    if (Number.isFinite(numeric) && numeric >= 0) {
      return { resumesAt: isoTimestamp(new Date(clock.nowMs() + numeric * 1_000).toISOString()) };
    }
    const date = Date.parse(String(retryAfter));
    if (!Number.isNaN(date)) return { resumesAt: isoTimestamp(new Date(date).toISOString()) };
  }
  for (const key of ['error', 'data', 'cause', 'response', 'body']) {
    const nested = resumeEta(record[key], clock, depth + 1);
    if (nested.resumesAt !== undefined) return nested;
  }
  return {};
}

function classifyAdapterError(error: AdapterError, clock: Clock): ErrorClassification {
  if (error.kind === 'provider_error') return classifyGrokError(error.envelope, clock);
  if (CRASH_KINDS.includes(error.kind)) {
    return { kind: 'crash', source: 'structured', confidence: 'high', provider: GROK_HARNESS_ID };
  }
  if (PROTOCOL_KINDS.includes(error.kind)) {
    return { kind: 'protocol', source: 'structured', confidence: 'high', provider: GROK_HARNESS_ID };
  }
  return { ...UNKNOWN };
}

/** Never classifies bare model/agent prose, even when it mentions a 429. */
export function classifyGrokError(raw: unknown, clock: Clock): ErrorClassification {
  if (typeof raw === 'string') return { ...UNKNOWN };
  if (raw instanceof AdapterError) return classifyAdapterError(raw, clock);
  const record = asRecord(raw);
  if (record === undefined) return { ...UNKNOWN };

  const envelope = asRecord(record['error']) ?? record;
  const status = findNumericStatus(envelope);
  const code = envelope['code'];
  if (
    code === JSONRPC_AUTH_REQUIRED ||
    status === HTTP_UNAUTHORIZED ||
    status === HTTP_FORBIDDEN ||
    findMachineToken(envelope, AUTH_CODES) !== undefined ||
    findMachineToken(envelope, AUTH_NAMES) !== undefined
  ) {
    return { kind: 'auth', source: 'structured', confidence: 'high', provider: GROK_HARNESS_ID };
  }

  const structuredLimit =
    status === HTTP_TOO_MANY_REQUESTS ||
    status === HTTP_PAYMENT_REQUIRED ||
    findMachineToken(envelope, LIMIT_CODES) !== undefined ||
    findMachineToken(envelope, LIMIT_NAMES) !== undefined;
  if (structuredLimit) {
    return {
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: status === HTTP_TOO_MANY_REQUESTS ? 'http_429' : 'structured',
      provider: GROK_HARNESS_ID,
      ...resumeEta(envelope, clock),
    };
  }

  // Grok's subscription backend can preserve this stable machine code only
  // inside the JSON-RPC envelope message. Parsing is permitted after the
  // object-envelope guard above; bare agent text was already rejected.
  if (findMessage(envelope)?.includes(SPENDING_LIMIT_MACHINE_CODE) === true) {
    return {
      kind: 'usage_limit',
      source: 'parsed',
      confidence: 'medium',
      detectionTier: 'parsed',
      provider: GROK_HARNESS_ID,
      ...resumeEta(envelope, clock),
    };
  }
  return { ...UNKNOWN };
}
