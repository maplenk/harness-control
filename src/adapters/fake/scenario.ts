/**
 * Scenario schema for the child-process fake ACP agent
 * (`fake-acp-child.mjs`). The child reads ONE JSON file (path = argv[2])
 * whose shape is `FakeAcpScenario`; these types are the authoritative,
 * documented contract for scripting it per test (PLAN §19 tests 1–8/21).
 *
 * The child itself is plain `.mjs` (spawnable with `process.execPath`, no
 * compile step); it mirrors this schema exactly and treats every field as
 * optional with well-behaved defaults, so `{}` (or no file at all) yields a
 * cooperative ACP-ish agent.
 *
 * See the header of `fake-acp-child.mjs` for the wire-level behavior of each
 * knob; `child.ts` provides `spawnFakeAcpChild(scenario)` which writes the
 * JSON for you.
 */

// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------
/**
 * One scripted `session/update` notification. Sugar forms wrap into ACP
 * shapes; `raw` is sent verbatim as the `update` object (for malformed or
 * exotic update payloads).
 */
export type FakeUpdateScript =
  | { readonly text: string }
  | { readonly thought: string }
  | { readonly raw: unknown };

// ---------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------
export interface FakeHandshakeScript {
  /**
   * - 'ok' (default): respond to `initialize` normally.
   * - 'stall': NEVER respond (client's 15s handshake timeout must fire).
   * - 'exit': exit with `exitCode` instead of responding.
   */
  readonly behavior?: 'ok' | 'stall' | 'exit';
  /** Delay before the initialize response (test timeouts below 15s). */
  readonly delayMs?: number;
  /** Advertise THIS protocol version (script a mismatch by diverging). */
  readonly protocolVersion?: number;
  readonly exitCode?: number;
  readonly agentInfoName?: string;
  /**
   * Advertised `agentCapabilities.sessionCapabilities` (P-2 substrate). Real
   * adapters advertise entries as EMPTY OBJECTS `{}` (presence = supported),
   * e.g. `{resume: {}, fork: {}}`. Omitted = not advertised at all.
   */
  readonly sessionCapabilities?: Readonly<Record<string, unknown>>;
  /**
   * Advertised auth methods (H-2 substrate). Real codex-acp advertises
   * `[{id:'api-key',…}, {id:'chat-gpt',…}]`; default `[]` (unchanged
   * historical behavior).
   */
  readonly authMethods?: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
}

/** H-2 substrate: scripted `authenticate` handling. Default (no script):
 * accept any string methodId with the empty `{}` result — mirroring the live
 * observation that ACP acceptance is instant and says NOTHING about
 * credential validity. */
export interface FakeAuthenticateScript {
  /** Respond with this error envelope instead of accepting. */
  readonly error?: FakeErrorEnvelope;
}

/**
 * H-1 substrate: models the codex core's HOST-CONFIG INHERITANCE class
 * (docs/reviews/p2-live-gate.md, finding H-1) so spawn-time `CODEX_HOME`
 * isolation is provable offline. Resolution mirrors the real core:
 * - env `CODEX_HOME` SET → the child reads `$CODEX_HOME/config.toml` and its
 *   `approvals_reviewer = "…"` wins; a missing file/key falls back to the
 *   core's documented default `user` (client-routing) — the host value below
 *   is NEVER consulted (isolation replaces the whole config home);
 * - env `CODEX_HOME` UNSET → `inheritedApprovalsReviewer` applies (models the
 *   user-global `~/.codex/config.toml` the live gate caught with
 *   `auto_review`), default `user`.
 * Effect (see `FakeTurnScript.escalation`): `auto_review`/`guardian_subagent`
 * auto-approve out-of-sandbox writes via an internal "Guardian Review" with
 * ZERO `session/request_permission` traffic; `user` routes them to the
 * client.
 */
export interface FakeCodexHostScript {
  readonly inheritedApprovalsReviewer?: string;
  /**
   * Models the core's auth dependency (H-2): when true AND env `CODEX_HOME`
   * is set AND `$CODEX_HOME/auth.json` is missing, every prompt turn fails
   * with the -32000 auth envelope (the live H-2 probe's provider-401 class)
   * — proving isolation must CARRY auth material, not just config. With
   * `CODEX_HOME` unset the inherited host login is modeled as present.
   */
  readonly requireAuthJson?: boolean;
}

// ---------------------------------------------------------------------------
// Wire shaping
// ---------------------------------------------------------------------------
export interface FakeFragmentationScript {
  /**
   * >0 splits EVERY stdout line (including the trailing newline) into chunks
   * of this many bytes, so NDJSON frames arrive fragmented across chunk
   * boundaries (test 1). 0/absent disables.
   */
  readonly chunkBytes?: number;
  /** Delay between chunks (default 2ms) so the reader observes fragments. */
  readonly interChunkDelayMs?: number;
}

export interface FakeStderrScript {
  /** Lines written to stderr immediately at boot (test 3: noise isolation). */
  readonly onStart?: readonly string[];
  /** Lines written to stderr at the start of every prompt turn. */
  readonly perTurn?: readonly string[];
}

// ---------------------------------------------------------------------------
// Turns
// ---------------------------------------------------------------------------
export interface FakePermissionScript {
  readonly toolTitle?: string;
  /** Defaults to one allow_once + one reject_once option. */
  readonly options?: ReadonlyArray<{
    readonly optionId: string;
    readonly name: string;
    readonly kind: string;
  }>;
}

/** JSON-RPC error envelope sent INSTEAD of a prompt result (tests 8, 21). */
export interface FakeErrorEnvelope {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

export interface FakeTurnExitScript {
  /** Where in the turn the child exits abruptly (test: unexpected exit). */
  readonly when: 'mid_updates' | 'before_response' | 'after_response';
  readonly code?: number;
}

/**
 * Script for the Nth `session/prompt` (scenario.turns[n]; overflow falls
 * back to `defaultTurn`, then to a built-in benign turn). Order of play:
 * auth-material gate (`codexHost.requireAuthJson` → -32000 failure) →
 * per-turn stderr → updates (with optional `exit.when='mid_updates'`) →
 * malformed/oversized lines → `escalation` (approval-routed write, H-1) →
 * permission request (awaits the client's response) →
 * `delayBeforeResponseMs` → response OR error envelope → late updates after
 * `lateUpdateDelayMs`.
 */
export interface FakeTurnScript {
  readonly updates?: readonly FakeUpdateScript[];
  /** Delay between scripted updates (default 0). */
  readonly updateDelayMs?: number;
  /**
   * REAL-shaped per-turn `usage` attached to the settled PromptResponse
   * (ACP `Usage`: totalTokens/inputTokens/outputTokens). Defaults to the
   * gate-recorded `{totalTokens:24, inputTokens:2, outputTokens:22}`;
   * `false` suppresses it.
   */
  readonly usage?:
    | { readonly totalTokens?: number; readonly inputTokens?: number; readonly outputTokens?: number }
    | false;
  /**
   * REAL-shaped `usage_update` session update emitted before the successful
   * response (ACP `UsageUpdate`: {used, size, cost?}; P-3/§17.2 feed).
   * Defaults to `{used:1200, size:200000}`; `false` suppresses it.
   */
  readonly usageUpdate?:
    | {
        readonly used?: number;
        readonly size?: number;
        readonly cost?: { readonly amount: number; readonly currency: string };
      }
    | false;
  /**
   * Write ALL scripted `updates` as ONE stdout write (a single burst that
   * arrives in one/few chunks), instead of one write per line. Test 5's
   * substrate: the producer provably outruns any per-tick consumer because
   * the whole burst is decoded within one data event — deterministic queue
   * overflow, immune to scheduler/load timing. Ignores `updateDelayMs`,
   * `fragmentation`, and mid-updates `exit` for these lines.
   */
  readonly updatesCoalesced?: boolean;
  /** Raw lines injected verbatim on stdout before the response (test 2). */
  readonly malformedLines?: readonly string[];
  /** Emit one valid-JSON line padded past this many bytes (test 2: >1MiB). */
  readonly oversizedLineBytes?: number;
  /**
   * Emit `session/request_permission` and WAIT for the client's response
   * before responding to the prompt (test 6/7). A `cancelled` outcome makes
   * the prompt respond `stopReason:'cancelled'`.
   */
  readonly permission?: FakePermissionScript;
  /**
   * H-1 substrate: this turn ATTEMPTS AN OUT-OF-SANDBOX WRITE subject to
   * approval routing (`FakeCodexHostScript` resolution):
   * - reviewer `auto_review`/`guardian_subagent` → "Guardian Review"
   *   tool-call, then the write executes (`WROTE` marker) with ZERO
   *   permission requests — the live bypass, reproduced;
   * - reviewer `user` → a real `session/request_permission` round-trip:
   *   allow → write executes (`WROTE`); reject → blocked (`DENIED`);
   *   cancelled outcome → prompt settles `stopReason:'cancelled'`.
   */
  readonly escalation?: { readonly toolTitle?: string };
  readonly delayBeforeResponseMs?: number;
  /** Default `{stopReason:'end_turn'}`. Ignored when `error` is present. */
  readonly response?: { readonly stopReason?: string };
  readonly error?: FakeErrorEnvelope;
  /** Sent AFTER the prompt response — late updates, issue #864 (§10.2). */
  readonly lateUpdates?: readonly FakeUpdateScript[];
  /** Default 10ms. */
  readonly lateUpdateDelayMs?: number;
  readonly exit?: FakeTurnExitScript;
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------
export interface FakeCancelScript {
  /**
   * - 'acknowledge' (default): settle the in-flight prompt with
   *   `stopReason:'cancelled'` after `delayMs` (default 0).
   * - 'delay': same, but `delayMs` defaults to 1000 (test the grace bound).
   * - 'ignore': never settle — the client's cancel-grace escalation must act.
   */
  readonly behavior?: 'acknowledge' | 'delay' | 'ignore';
  readonly delayMs?: number;
}

// ---------------------------------------------------------------------------
// session/load
// ---------------------------------------------------------------------------
export interface FakeLoadScript {
  /** Replayed as session/update notifications before the load response. */
  readonly replayUpdates?: readonly FakeUpdateScript[];
  /** Respond with this error envelope instead (advertised-but-failed load). */
  readonly error?: FakeErrorEnvelope;
}

// ---------------------------------------------------------------------------
// session/set_config_option (P4a W2-7)
// ---------------------------------------------------------------------------
/**
 * W2-7 substrate: scripted PROVIDER-level failure of
 * `session/set_config_option` — the wire shape of a usage limit (or any
 * provider error) landing DURING the spawn's `initial_config_pin` window
 * (§6.2/W2-1: T4 covers `initial_config_pin`). The child still enforces the
 * REAL frame contract first (missing `configId` → the zod-shaped -32602,
 * unknown values → the data-less -32602, exactly as live); only a
 * frame-valid request gets the scripted envelope instead of applying.
 */
export interface FakeSetConfigOptionScript {
  /** Respond with this error envelope instead of applying the change. */
  readonly error?: FakeErrorEnvelope;
}

// ---------------------------------------------------------------------------
// Session state (REAL wire shapes — TX-2/P-1 fidelity)
// ---------------------------------------------------------------------------
/** One REAL-shaped `SessionConfigSelectOption` value. */
export interface FakeConfigValueScript {
  readonly value: string;
  readonly name?: string;
  readonly description?: string;
}

/**
 * One REAL-shaped ACP `SessionConfigOption` served by `session/new`/`load`
 * and mutated by `session/set_config_option`:
 * `{id, name, category, type, currentValue, options:[{value,…}]}` (TX-2).
 */
export interface FakeConfigOptionScript {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  /** Semantic category: 'model' | 'mode' | 'thought_level' | custom. */
  readonly category?: string;
  readonly type?: 'select' | 'boolean';
  readonly currentValue?: string | boolean;
  readonly options?: ReadonlyArray<
    | FakeConfigValueScript
    | { readonly group: string; readonly name?: string; readonly options: readonly FakeConfigValueScript[] }
  >;
}

/** REAL-shaped `SessionModeState` (`session/new`/`load` `modes`; P-1). */
export interface FakeSessionModesScript {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<{ readonly id: string; readonly name?: string }>;
}

export interface FakeSessionScript {
  readonly sessionId?: string;
  /** Overrides the default REAL-shaped config options (model + mode). */
  readonly configOptions?: readonly FakeConfigOptionScript[];
  /** Overrides the default mode state (default currentModeId: 'auto'). */
  readonly modes?: FakeSessionModesScript;
}

// ---------------------------------------------------------------------------
// Scenario root
// ---------------------------------------------------------------------------
export interface FakeAcpScenario {
  readonly handshake?: FakeHandshakeScript;
  readonly fragmentation?: FakeFragmentationScript;
  readonly stderr?: FakeStderrScript;
  readonly session?: FakeSessionScript;
  readonly turns?: readonly FakeTurnScript[];
  readonly defaultTurn?: FakeTurnScript;
  readonly cancel?: FakeCancelScript;
  readonly load?: FakeLoadScript;
  /** H-2 substrate: scripted `authenticate` handling (default: accept). */
  readonly authenticate?: FakeAuthenticateScript;
  /** H-1 substrate: host-config inheritance + auth-material modeling. */
  readonly codexHost?: FakeCodexHostScript;
  /** W2-7 substrate: scripted `session/set_config_option` provider failure. */
  readonly setConfigOption?: FakeSetConfigOptionScript;
}

// ---------------------------------------------------------------------------
// Fixture helpers (PLAN §13 / test 21 substrate)
// ---------------------------------------------------------------------------
/**
 * The Claude-adapter limit convention pinned by conformance tests (§13):
 * `-32603` + `data.errorKind='rate_limit'` (adapter v0.59.0, PR #582).
 */
export function rateLimitErrorEnvelope(options?: {
  readonly resumesAt?: string;
  readonly retryAfterSeconds?: number;
}): FakeErrorEnvelope {
  return {
    code: -32603,
    message: 'Provider rate limit reached',
    data: {
      errorKind: 'rate_limit',
      ...(options?.resumesAt !== undefined ? { resumesAt: options.resumesAt } : {}),
      ...(options?.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: options.retryAfterSeconds }
        : {}),
    },
  };
}

/**
 * The Codex-adapter limit convention pinned by conformance tests:
 * `-32603` + `data.codexErrorInfo='usageLimitExceeded'` — the verified
 * structured signal of the pinned codex-acp@1.1.4 dist (see
 * `../codex/fixtures/codex-error-envelopes.ts`, which documents the source
 * lines; NO reset field crosses ACP — the ETA is honestly `unknown`).
 */
export function codexUsageLimitErrorEnvelope(): FakeErrorEnvelope {
  return {
    code: -32603,
    message: 'Internal error: You have hit your usage limit',
    data: {
      message: 'You have hit your usage limit',
      codexErrorInfo: 'usageLimitExceeded',
    },
  };
}

/**
 * The shared ACP-SDK `authRequired` factory shape: code `-32000` (both
 * pinned adapters use the same jsonrpc.js factory). Claude calls it with no
 * data; codex-acp attaches `data.codexErrorInfo='unauthorized'` — the
 * classifiers key on the CODE, never on data presence, so this helper models
 * the minimal common shape. W2-4 probe scripts use it for the
 * non-limit-auth → `limit.probe.inconclusive` path.
 */
export function authRequiredErrorEnvelope(): FakeErrorEnvelope {
  return { code: -32000, message: 'Authentication required' };
}

/** An envelope no classifier tier recognizes → unknown_provider_error (T16). */
export function unknownProviderErrorEnvelope(): FakeErrorEnvelope {
  return { code: -32099, message: 'something opaque went wrong upstream' };
}

/**
 * The API-key-mode HTTP 429 (+ Retry-After seconds) shape of PLAN §13's
 * shared convention. NOT an ACP wire frame — it never crosses the
 * child-process fake's NDJSON stream; it is the SPI-level `classifyError`
 * input the direct-HTTP integration seam produces, scriptable through the
 * in-process fake's `errorEnvelope`.
 */
export function http429RetryAfterShape(retryAfterSeconds = 120): {
  readonly status: 429;
  readonly headers: { readonly 'retry-after': string };
} {
  return { status: 429, headers: { 'retry-after': String(retryAfterSeconds) } };
}
