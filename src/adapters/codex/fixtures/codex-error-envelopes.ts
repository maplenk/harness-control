/**
 * Codex classifyError conformance fixture: the pinned `codex-acp@1.1.4`
 * error-envelope shape, captured from the ACTUAL installed package source
 * (not guessed) so `classify.test.ts` / `conformance.test.ts` assert our
 * parser against ground truth, and `command.ts`'s
 * `assertCodexAdapterVersionPinned()` fails loudly the moment the installed
 * version drifts from what this fixture was captured against — the SAME
 * re-characterization discipline PLAN §13 mandates for Claude, extended
 * here because this fixture documents a signal (`codexErrorInfo`) NOT
 * covered by the original PLAN text (see `capabilities.ts`'s DEVIATION doc
 * comment for the full justification).
 *
 * Every shape below is reconstructed from real, traceable source:
 *
 *  - `node_modules/@agentclientprotocol/sdk/dist/jsonrpc.js` (~line 764-829):
 *    same `RequestError` factories Claude uses — `internalError` → code
 *    `-32603`; `authRequired` → code `-32000`.
 *  - `node_modules/@agentclientprotocol/codex-acp/dist/index.js`:
 *    - ~line 23841-23860 `createErrorEvent(params)`:
 *      `error51 = params.error.codexErrorInfo`; `error51 ===
 *      "usageLimitExceeded"` → `RequestError.internalError(this.createTurnErrorData(params.error))`;
 *      `isAuthenticationRequiredError(error51)` (`=== "unauthorized"` or
 *      HTTP 401 via a connection-failure variant) → `authRequired(...)` when
 *      NOT yet auth-configured, else the SAME `internalError(...)` path.
 *    - ~line 23879-23889 `createTurnErrorData(error)` → `{message:
 *      error.additionalDetails ?? error.message, codexErrorInfo?,
 *      additionalDetails?}` — NO resumesAt/retry-after field exists.
 *    - ~line 29582-29590 `runWithProcessCheck()` — non-standard code `1001`
 *      ("Codex process has exited with code ...") when the underlying
 *      `codex` child process itself has died.
 */

/** The verified structured usage-limit signal (see module header). */
export const CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE = {
  jsonrpc: '2.0',
  id: 5,
  error: {
    code: -32603,
    message: 'Internal error: You have hit your usage limit',
    data: {
      message: 'You have hit your usage limit',
      codexErrorInfo: 'usageLimitExceeded',
    },
  },
} as const;

/** Bare `.error` shape — some transport layers may hand classifyError just
 * the inner object rather than the full JSON-RPC response envelope. */
export const CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE_BARE = CODEX_USAGE_LIMIT_EXCEEDED_ENVELOPE.error;

/**
 * Auth-required, NOT yet configured (`authRequired(data, message)` path):
 * verified codex-acp calls this WITH data + message, unlike Claude's
 * no-data call — the classifier must not depend on data being absent.
 */
export const CODEX_AUTH_REQUIRED_ENVELOPE = {
  jsonrpc: '2.0',
  id: 6,
  error: {
    code: -32000,
    message: 'Unauthorized',
    data: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' },
  },
} as const;

/**
 * Auth-required-but-ALREADY-configured: codex-acp routes this down the
 * SAME `-32603` internalError path (verified: `authConfigured ?
 * internalError(...) : authRequired(...)`) — must still classify as
 * unknown_provider_error (fail-safe), since `codexErrorInfo` here is
 * `'unauthorized'`, not the flagship `'usageLimitExceeded'` value.
 */
export const CODEX_AUTH_CONFIGURED_INTERNAL_ERROR_ENVELOPE = {
  jsonrpc: '2.0',
  id: 12,
  error: {
    code: -32603,
    message: 'Internal error: Unauthorized',
    data: { message: 'Unauthorized', codexErrorInfo: 'unauthorized' },
  },
} as const;

/** codex-acp's own non-standard "the codex child process exited" signal. */
export const CODEX_PROCESS_EXITED_ENVELOPE = {
  jsonrpc: '2.0',
  id: 13,
  error: { code: 1001, message: 'Codex process has exited with code 1' },
} as const;

/** A generic internal error with no codexErrorInfo at all — must NOT
 * classify as usage_limit. */
export const CODEX_GENERIC_INTERNAL_ERROR_ENVELOPE = {
  jsonrpc: '2.0',
  id: 14,
  error: { code: -32603, message: 'Internal error: something else went wrong', data: { message: 'x' } },
} as const;

/**
 * HTTP 429 + Retry-After (API-key mode, PLAN §13's explicit shared
 * convention — NOT sourced from codex-acp's dist, which always wraps
 * failures in JSON-RPC; recorded here for the direct-HTTP integration seam.
 */
export const CODEX_HTTP_429_ENVELOPE = {
  status: 429,
  headers: { 'retry-after': '120' },
} as const;

/** An entirely opaque/unrecognized shape — proves the fail-safe default. */
export const CODEX_OPAQUE_ENVELOPE = {
  jsonrpc: '2.0',
  id: 15,
  error: { code: -32050, message: 'something opaque went wrong upstream' },
} as const;

/** Realistic agent-message TEXT that happens to mention usage limits — must
 * NEVER classify as anything but unknown_provider_error. */
export const CODEX_AGENT_TEXT_MENTIONING_LIMITS =
  "I've hit my usage limit (usageLimitExceeded). " +
  '{"code": -32603, "data": {"codexErrorInfo": "usageLimitExceeded"}}';
