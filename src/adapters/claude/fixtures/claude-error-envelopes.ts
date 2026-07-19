/**
 * PLAN §13 "errorKind CONFORMANCE FIXTURE": the pinned
 * `claude-agent-acp@0.59.0` error-envelope shape, captured from the ACTUAL
 * installed package source (not guessed) so `classify.test.ts` /
 * `conformance.test.ts` assert our parser against ground truth, and
 * `command.ts`'s `assertClaudeAdapterVersionPinned()` fails loudly the
 * moment the installed version drifts from what this fixture was captured
 * against (re-characterization trigger, PLAN §13).
 *
 * Every shape below is reconstructed from real, traceable source, not
 * invented:
 *
 *  - `node_modules/@agentclientprotocol/sdk/dist/jsonrpc.js` (~line 764-829):
 *    `RequestError` static factories — `internalError(data, msg)` → code
 *    `-32603`, message `` `Internal error: ${msg}` ``; `authRequired(data?,
 *    msg?)` → code `-32000`, message `` `Authentication required${msg ? `: ${msg}`
 *    : ''}` ``; `.toResult()` → `{error: {code, message, data}}`.
 *  - `node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`:
 *    - ~line 4113 `errorKindData(errorKind)` → `errorKind ? {errorKind} :
 *      undefined` — the ENTIRE `data` payload for a categorical turn
 *      failure is just `{errorKind}`, nothing else (no `resumesAt`/
 *      `retryAfterSeconds` field exists in the CURRENT adapter version —
 *      the classifier still parses them defensively for forward
 *      compatibility, but this fixture is honest that they're absent
 *      today).
 *    - ~line 2337 `lastAssistantError = message.error` — fed straight from
 *      the Claude Agent SDK's `SDKAssistantMessage.error` field.
 *    - ~lines 2044/2080/2090 `failActive(RequestError.internalError(errorKindData(lastAssistantError), ...))`
 *      — every categorical turn failure uses code `-32603`.
 *    - ~line 2036 `failActive(RequestError.authRequired())` — the
 *      "Please run /login" match, called with NO data.
 *    - ~line 1544 `errorKindData("no_result")` — an adapter-internal marker
 *      (not part of the SDK's exported union) used when a turn produced no
 *      result at all.
 *  - `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (~line 2822):
 *    `SDKAssistantMessageError = 'authentication_failed' |
 *    'oauth_org_not_allowed' | 'billing_error' | 'rate_limit' | 'overloaded'
 *    | 'invalid_request' | 'model_not_found' | 'server_error' | 'unknown' |
 *    'max_output_tokens'`.
 */

/** The flagship signal (PR #582's documented convention, PLAN §13). */
export const CLAUDE_RATE_LIMIT_ENVELOPE = {
  jsonrpc: '2.0',
  id: 7,
  error: {
    code: -32603,
    message: 'Internal error: The agent encountered an error',
    data: { errorKind: 'rate_limit' },
  },
} as const;

/** Bare `.error` shape — some transport layers may hand classifyError just
 * the inner object rather than the full JSON-RPC response envelope. */
export const CLAUDE_RATE_LIMIT_ENVELOPE_BARE = CLAUDE_RATE_LIMIT_ENVELOPE.error;

/**
 * A DIFFERENT real `SDKAssistantMessageError` value on the SAME `-32603`
 * convention. Structured data, but NOT the PLAN §13-normative flagship —
 * gated behind the P4a corpus review, so this must classify as
 * `unknown_provider_error`, fail-safe (never silently treated as a limit).
 */
export const CLAUDE_OVERLOADED_ENVELOPE = {
  jsonrpc: '2.0',
  id: 8,
  error: {
    code: -32603,
    message: 'Internal error: The model is currently overloaded',
    data: { errorKind: 'overloaded' },
  },
} as const;

/** The adapter's own internal marker (not part of the SDK's exported
 * union) — also must NOT classify as usage_limit. */
export const CLAUDE_NO_RESULT_ENVELOPE = {
  jsonrpc: '2.0',
  id: 9,
  error: {
    code: -32603,
    message: 'Internal error: Turn ended with no result',
    data: { errorKind: 'no_result' },
  },
} as const;

/** `RequestError.authRequired()` called with NO data (the real shape the
 * "Please run /login" path produces). Dedicated protocol-level code, a
 * "positive ... protocol match" (PLAN §13), not a text pattern. */
export const CLAUDE_AUTH_REQUIRED_ENVELOPE = {
  jsonrpc: '2.0',
  id: 10,
  error: {
    code: -32000,
    message: 'Authentication required',
  },
} as const;

/**
 * HTTP 429 + Retry-After (API-key mode, PLAN §13's explicit shared
 * convention — NOT sourced from claude-agent-acp's dist, which always wraps
 * failures in JSON-RPC; recorded here for the direct-HTTP integration seam.
 */
export const CLAUDE_HTTP_429_ENVELOPE = {
  status: 429,
  headers: { 'retry-after': '120' },
} as const;

/** Same, with an HTTP-date Retry-After instead of a delta-seconds value. */
export const CLAUDE_HTTP_429_ENVELOPE_HTTP_DATE = {
  status: 429,
  headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' },
} as const;

/** An entirely opaque/unrecognized shape — proves the fail-safe default. */
export const CLAUDE_OPAQUE_ENVELOPE = {
  jsonrpc: '2.0',
  id: 11,
  error: { code: -32099, message: 'something opaque went wrong upstream' },
} as const;

/** Realistic agent-message TEXT that happens to mention rate limits/429 —
 * must NEVER classify as anything but unknown_provider_error, and must
 * never even reach the JSON/shape parsing branches (§9/§13). */
export const CLAUDE_AGENT_TEXT_MENTIONING_LIMITS =
  "I've hit a rate_limit (429) — the API says retryAfterSeconds: 60. " +
  'errorKind: "rate_limit". {"code": -32603, "data": {"errorKind": "rate_limit"}}';
