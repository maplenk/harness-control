/**
 * Codex ACP profile — CapabilityRecord population (PLAN §3, §9).
 *
 * Merges REAL `initialize()`/`session/new` output (when the transport
 * supplies it — see `CodexCapabilityInput`) with STATIC per-provider
 * knowledge. The static knowledge below is verified against the actual
 * LOCKFILE-PINNED sources, not inferred:
 *  - `node_modules/@agentclientprotocol/codex-acp/dist/index.js`
 *    (`initialize()` ~line 28178: `protocolVersion: PROTOCOL_VERSION` (=1,
 *    ~line 3744), `agentCapabilities` with `loadSession: true,
 *    sessionCapabilities: {resume:{}, list:{}, close:{}, delete:{},
 *    additionalDirectories:{}}` — note: NO `fork` key at all, unlike
 *    Claude — `mcpCapabilities: {acp:false, http:true, sse:false}`;
 *    `buildPromptUsage()`/`toPromptUsage()` ~line 29451/29571 attach real
 *    per-turn token counts to every settled `PromptResponse` (`usage:
 *    this.buildPromptUsage(sessionState.lastTokenUsage)`); `setSessionConfigOption`
 *    ~line 21379-21380 wired to `session/set_config_option` (the modern
 *    mechanism), with a LEGACY `session/set_model` fallback also present
 *    (`LEGACY_SET_SESSION_MODEL_METHOD` ~line 23366) — no built-in
 *    subagent-dispatch tool analogous to Claude Code's "Task" was found
 *    anywhere in this adapter's tool-handling code.
 *  - `CODEX_API_KEY_ENV_VAR`/`OPENAI_API_KEY_ENV_VAR` ~line 24887-24888,
 *    checked in that order (~line 25876/25883-25884) — the two env vars
 *    Codex's own auth-readiness check recognizes.
 *
 * This module never spawns a process — offline/pure by construction (the
 * live gate, PLAN §3 P2, is the only place a real adapter is spawned; do NOT
 * spawn real adapters in tests here).
 */
import type {
  InitializeResponse,
  SessionConfigOption,
  SessionConfigOptionCategory,
  SessionConfigSelectGroup,
  SessionConfigSelectOption,
} from '@agentclientprotocol/sdk';
import type { Clock } from '../../lib/clock.js';
import type { SessionModePolicy } from '../acp/session.js';
import {
  deriveAuthReadiness,
  type AuthReadiness,
  type AuthValidationEvidence,
  type CapabilityRecord,
  type ConfigOptionDescriptor,
  type ExecutableInfo,
  type SessionOpSupport,
} from '../spi.js';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------
export const CODEX_HARNESS_ID = 'codex';

// ---------------------------------------------------------------------------
// Session-mode pinning policy (P2 live gate P-1 — NORMATIVE session setup)
// ---------------------------------------------------------------------------
/**
 * P-1 (live-verified): codex-acp's DEFAULT session mode is `agent` — a
 * workspace-write sandbox whose writable roots INCLUDE `/tmp`
 * (`excludeSlashTmp:false`), with approvals `on-request`; in-sandbox writes
 * happen with ZERO `session/request_permission` traffic. The pin (via the
 * TX-3-corrected `session/set_config_option`, configId `mode`, live values
 * `read-only|agent|agent-full-access`):
 *  - coordinator/verifier → `read-only` (any write must escalate through the
 *    permission channel, where the §10.2 role write-veto denies it);
 *  - implementor → `agent` (workspace-write ONLY — never
 *    `agent-full-access`); out-of-sandbox escalations route through
 *    `session/request_permission` → `decidePermission` default-deny.
 * Applied by the ACP session layer immediately after
 * `session/new`/`session/load`; failure fails the setup.
 */
export const CODEX_SESSION_MODE_POLICY: SessionModePolicy = {
  byRole: {
    coordinator: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'read-only' },
    implementor: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'agent' },
    verifier: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'read-only' },
  },
  defaultPin: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'read-only' },
};

/** ACP protocol version codex-acp@1.1.4 negotiates (verified: `var
 * PROTOCOL_VERSION = 1;`, echoed in `initialize()`'s return). */
export const CODEX_ACP_PROTOCOL_VERSION = 1;

/**
 * No built-in subagent-dispatch tool analogous to Claude Code's "Task" was
 * found anywhere in codex-acp's tool-handling code (verified by omission —
 * not merely unresearched). Kept as an explicit, honest empty list rather
 * than skipping the field, so a future re-check has a documented baseline
 * to diff against.
 */
export const CODEX_CONFLICTING_BUILTIN_TOOLS: readonly string[] = [];

/** Verified (codex-acp dist, `CODEX_API_KEY_ENV_VAR`): Codex-specific key,
 * checked FIRST. */
export const CODEX_API_KEY_ENV_VAR = 'CODEX_API_KEY';
/** Verified: `OPENAI_API_KEY_ENV_VAR`, checked second — PLAN D2's
 * "recommended for Codex automation" documented path. */
export const OPENAI_API_KEY_ENV_VAR = 'OPENAI_API_KEY';

/**
 * ACP auth-method ids codex-acp@1.1.4 advertises/accepts (H-2, source:
 * `getCodexAuthMethods()` + `isCodexAuthRequest()` in the pinned dist —
 * `api-key` always; `chat-gpt` unless `NO_BROWSER` is set in the adapter's
 * env; `gateway` only behind a client capability).
 *
 * WHICH ONE THE ORCHESTRATOR NEEDS (documented decision, H-2): a
 * chatgpt/subscription method id EXISTS (`chat-gpt`), but codex-acp's own
 * handler shows it is NOT required for the inherited-login path this machine
 * uses — `authenticate('chat-gpt')` first calls
 * `accountRead({refreshToken:true})` and returns immediately when a ChatGPT
 * login already exists in the core's `CODEX_HOME/auth.json`; only a MISSING
 * login makes it start an interactive browser OAuth flow (`accountLogin` +
 * `open(authUrl)`) — unusable and unsafe headless. Session creation is gated
 * by `checkAuthorization()` → `authRequired()`, which passes on the on-disk
 * login without any authenticate call (proven live: Run 2's codex sessions
 * rode the inherited ChatGPT login with zero ACP authenticate traffic).
 * Therefore: ChatGPT login is carried via H-1's isolated-home `auth.json`
 * copy, no ACP authenticate call is wired for it; `api-key` remains
 * available through the optional SPI `authenticate` seam for hosts with a
 * REAL key (D2 path) — and its ACP acceptance is never treated as validation
 * (the live H-2 probe: accepted in 3ms, then provider 401).
 */
export const CODEX_ACP_AUTH_METHOD_API_KEY = 'api-key';
export const CODEX_ACP_AUTH_METHOD_CHATGPT = 'chat-gpt';

/**
 * Fallback note (NOT wired into this profile's `modelMechanism`, which
 * codex-acp verified supports `session/set_config_option`): the underlying
 * `codex` CLI/core codex-acp wraps (resolved via `CODEX_PATH`, default
 * `codex` on PATH — see codex-acp's `login()`) also accepts `-c
 * key=value` config overrides at spawn time (e.g. `-c model=o3`), the
 * standard `codex` CLI TOML-override convention. Not something codex-acp's
 * OWN CLI arg parser forwards (verified: its `parseArgs()` only recognizes
 * `--client-name/-title/-version` for its `login` subcommand) — recorded
 * here purely as the env/cli_flag fallback PLAN §3 anticipates if
 * `session/set_config_option` ever regresses.
 */
export const CODEX_CLI_MODEL_OVERRIDE_FLAG_NOTE =
  "the underlying `codex` core (not codex-acp itself) accepts `-c model=<id>` config overrides at spawn time";

// ---------------------------------------------------------------------------
// Auth readiness (§17.1 live-gate H-2: evidence-honest, never presence-based
// `supported`)
// ---------------------------------------------------------------------------
/** Evidence/context input for the codex auth probe (H-2). */
export interface CodexAuthProbeContext {
  /**
   * True when codex auth MATERIAL was detected outside the environment —
   * e.g. `~/.codex/auth.json` found by the H-1 home-isolation step or by
   * doctor's read-only presence check (the inherited ChatGPT/Codex
   * subscription login — the real auth path on this machine). Presence is
   * material, never validation.
   */
  readonly authMaterialDetected?: boolean;
  /** Recorded turn evidence (e.g. `AcpStdioAdapter.authEvidence`). */
  readonly evidence?: AuthValidationEvidence;
}

/**
 * HONEST auth-readiness probe (H-2, falsified-live lesson): the P2 gate
 * proved this machine's present-and-forwarded `OPENAI_API_KEY` is
 * 401-invalid at the provider while every working codex session actually
 * rode the inherited `~/.codex` ChatGPT login — so presence (env keys,
 * checked in codex-acp's own `CODEX_API_KEY`-then-`OPENAI_API_KEY` order, or
 * on-disk auth material via `context.authMaterialDetected`) can only ever
 * yield `detected_but_unvalidated`. `supported` requires VALIDATED evidence:
 * a recorded successful provider turn (`evidence.validatedTurnAt`); a
 * recorded auth-classified failure without a newer validated turn yields
 * `detected_but_unsupported`. Nothing detected and no evidence → honest
 * `unknown` (this module never inspects provider-owned credential storage
 * itself). Mapping: `deriveAuthReadiness` (single documented rule, spi.ts).
 */
export function probeCodexAuthReadiness(
  env: NodeJS.ProcessEnv = process.env,
  context: CodexAuthProbeContext = {},
): AuthReadiness {
  const codexKey = env[CODEX_API_KEY_ENV_VAR];
  const openaiKey = env[OPENAI_API_KEY_ENV_VAR];
  const keyPresent =
    (typeof codexKey === 'string' && codexKey.length > 0) ||
    (typeof openaiKey === 'string' && openaiKey.length > 0);
  const materialDetected = keyPresent || context.authMaterialDetected === true;
  return deriveAuthReadiness(materialDetected, context.evidence ?? {});
}

// ---------------------------------------------------------------------------
// Config option mapping (session/new / session/load `configOptions` — the
// SAME generic ACP shape Claude uses; `@agentclientprotocol/sdk` is shared)
// ---------------------------------------------------------------------------
function mapConfigOptionCategory(
  category: SessionConfigOptionCategory | null | undefined,
): ConfigOptionDescriptor['kind'] {
  switch (category) {
    case 'model':
      return 'model';
    case 'mode':
      return 'mode';
    case 'thought_level':
      return 'reasoning';
    default:
      return 'other';
  }
}

function isSelectGroup(
  entry: SessionConfigSelectOption | SessionConfigSelectGroup,
): entry is SessionConfigSelectGroup {
  return 'group' in entry;
}

function flattenSelectValues(
  options: ReadonlyArray<SessionConfigSelectOption | SessionConfigSelectGroup>,
): string[] {
  const values: string[] = [];
  for (const entry of options) {
    if (isSelectGroup(entry)) {
      for (const grouped of entry.options) values.push(grouped.value);
    } else {
      values.push(entry.value);
    }
  }
  return values;
}

function toConfigOptionDescriptor(option: SessionConfigOption): ConfigOptionDescriptor {
  const kind = mapConfigOptionCategory(option.category);
  if (option.type === 'select') {
    const values = flattenSelectValues(
      option.options as ReadonlyArray<SessionConfigSelectOption | SessionConfigSelectGroup>,
    );
    return {
      id: option.id,
      kind,
      values,
      ...(typeof option.currentValue === 'string' ? { current: option.currentValue } : {}),
    };
  }
  return {
    id: option.id,
    kind,
    values: ['true', 'false'],
    ...(typeof option.currentValue === 'boolean' ? { current: String(option.currentValue) } : {}),
  };
}

// ---------------------------------------------------------------------------
// sessionOps derivation
// ---------------------------------------------------------------------------
/** Verified static defaults for codex-acp@1.1.4: `fork` is FALSE — no
 * `sessionCapabilities.fork` key is ever advertised (unlike Claude). */
const STATIC_SESSION_OPS_DEFAULT: SessionOpSupport = {
  create: true,
  load: true,
  resume: true,
  fork: false,
  cancel: true,
};

/** ACP's capability convention (verified across every `*Capabilities` field
 * in `@agentclientprotocol/sdk`'s schema): omitted/null means unsupported,
 * `{}` (or any object) means supported. */
function capabilityPresent(value: object | null | undefined): boolean {
  return value !== undefined && value !== null;
}

// ---------------------------------------------------------------------------
// CapabilityRecord builder
// ---------------------------------------------------------------------------
export interface CodexCapabilityInput {
  readonly executable: ExecutableInfo;
  readonly clock: Clock;
  /** Real `initialize()` RPC response, when the transport has one; offline/
   * static callers omit it and get the verified static defaults instead. */
  readonly initializeResponse?: InitializeResponse;
  /** Real `session/new` (or `session/load`) response's `configOptions`. */
  readonly sessionConfigOptions?: readonly SessionConfigOption[];
  /** Defaults to `probeCodexAuthReadiness()` off `process.env`. */
  readonly auth?: AuthReadiness;
}

/**
 * Builds the §9 CapabilityRecord for the Codex ACP profile. Pure: no I/O, no
 * process spawn.
 *
 * DEVIATION FROM THE ORIGINAL PLAN §3 SUMMARY, clearly flagged: PLAN §3/§13
 * describe Codex as having "no structured crossing (#227)" for usage-limit
 * signals, citing the codex app-server's `RateLimitSnapshot` telemetry type
 * (proactive quota-percentage updates — verified real, but confirmed to
 * be internal-only bookkeeping: `handleRateLimitsUpdated()` feeds
 * `formatRateLimitLines()`, a `/status`-style TEXT formatter, never an ACP
 * error field). Issue #227 is accurate about THAT signal. It is a SEPARATE
 * question from "does a TURN THAT ACTUALLY FAILS on a usage limit cross ACP
 * with a structured discriminator", and source verification of the pinned
 * codex-acp@1.1.4 shows it DOES: `createErrorEvent()` checks
 * `params.error.codexErrorInfo === "usageLimitExceeded"` (an exact,
 * purpose-built string-enum comparison — not a free-text pattern) and, when
 * true, raises `RequestError.internalError(this.createTurnErrorData(params.error))`
 * — JSON-RPC `-32603` with `data.codexErrorInfo === 'usageLimitExceeded'`.
 * See `classify.ts` + `fixtures/codex-error-envelopes.ts` for the full
 * citation trail. Because this is a genuine STRUCTURED discriminator (PLAN
 * §13: "until then only structured + unknown paths are active" — the P4a
 * corpus gate is specifically for the free-text "parsed" tier, which this is
 * NOT), `usageLimitReporting` is set to `'structured'` here rather than the
 * `'none'` the original task brief specified — an inconsistent capability
 * record (claiming 'none' while `classifyCodexError` demonstrably returns a
 * structured `usage_limit` classification for this exact envelope) would be
 * actively misleading to any downstream consumer. `retryAfterTier` remains
 * `'forecast_fallback'` exactly as directed: `createTurnErrorData()` never
 * attaches a resumesAt/retry-after value, so the KIND is structured but the
 * ETA genuinely is not.
 */
export function buildCodexCapabilityRecord(input: CodexCapabilityInput): CapabilityRecord {
  const agentCapabilities = input.initializeResponse?.agentCapabilities;
  const sessionCapabilities = agentCapabilities?.sessionCapabilities;
  const mcp = agentCapabilities?.mcpCapabilities;

  const sessionOps: SessionOpSupport =
    agentCapabilities === undefined
      ? STATIC_SESSION_OPS_DEFAULT
      : {
          create: true, // session/new: ACP baseline, always required of an agent
          load: agentCapabilities.loadSession ?? false,
          resume: capabilityPresent(sessionCapabilities?.resume),
          fork: capabilityPresent(sessionCapabilities?.fork), // verified: never advertised today
          cancel: true, // session/cancel: ACP baseline notification, never negotiated
        };

  return {
    harnessId: CODEX_HARNESS_ID,
    protocol: {
      name: 'acp',
      version: String(input.initializeResponse?.protocolVersion ?? CODEX_ACP_PROTOCOL_VERSION),
    },
    executable: input.executable,
    auth: input.auth ?? probeCodexAuthReadiness(),
    sessionOps,
    configOptions: (input.sessionConfigOptions ?? []).map(toConfigOptionDescriptor),
    // Verified: `setSessionConfigOption` wired to `session/set_config_option`
    // (the modern mechanism; a legacy `session/set_model` fallback also
    // exists — see module header note on `-c model=` for the underlying
    // `codex` CLI's own, unrelated override flag).
    modelMechanism: 'session_set_config_option',
    permissionRequests: true, // ACP baseline mechanism, not a negotiated toggle
    mcpConfig: {
      supported: mcp === undefined ? true : Boolean(mcp.http) || Boolean(mcp.sse),
      reportOnly: true, // D5: MCP passthrough deferred — report-only in the MVP
    },
    checkpointExport: false,
    // See the DEVIATION doc comment above this function: verified structured
    // via `codexErrorInfo === 'usageLimitExceeded'` on -32603 — NOT the
    // 'none' the original task brief specified, corrected against ground
    // truth from the pinned adapter source.
    usageLimitReporting: 'structured',
    // As directed: no resumesAt/retry-after value is ever attached to the
    // codexErrorInfo envelope — only HTTP 429's Retry-After (API-key mode)
    // reliably carries a real ETA today.
    retryAfterTier: 'forecast_fallback',
    // Verified: `buildPromptUsage(sessionState.lastTokenUsage)` attaches
    // real per-turn token counts to every settled PromptResponse (including
    // the cancelled-turn path).
    usageAccounting: 'per_turn',
    conflictingBuiltinTools: CODEX_CONFLICTING_BUILTIN_TOOLS,
    sessionIdentity: {
      exposesNativeSessionId: true,
      // Design default pending the PLAN §3 P2 live compatibility gate;
      // codex-acp advertises `session/resume` and exposes real native
      // session ids, so this is the reasonable static default, not a
      // hard-verified wire trace of the resume response.
      confirmsIdentityOnResume: true,
    },
    probedAt: input.clock.nowIso(),
  };
}
