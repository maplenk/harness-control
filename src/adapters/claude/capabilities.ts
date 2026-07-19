/**
 * Claude ACP profile — CapabilityRecord population (PLAN §3, §9).
 *
 * Merges REAL `initialize()`/`session/new` output (when the transport
 * supplies it — see `ClaudeCapabilityInput`) with STATIC per-provider
 * knowledge. The static knowledge below is verified against the actual
 * LOCKFILE-PINNED sources, not inferred:
 *  - `node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`
 *    (`initialize()`, ~line 445: `protocolVersion: 1`, `agentCapabilities`
 *    with `loadSession: true`, `sessionCapabilities: {fork:{}, resume:{},
 *    close:{}, delete:{}, list:{}, additionalDirectories:{}}`,
 *    `mcpCapabilities: {http:true, sse:true}`; `sessionUsage()` ~line 4081
 *    attaches real per-turn token counts to the settled `PromptResponse`;
 *    `tools.js` case `"Task"` ~line 20/586 is the built-in subagent-dispatch
 *    tool).
 *  - `node_modules/@anthropic-ai/sdk/client.mjs` (~line 72: `readEnv('ANTHROPIC_API_KEY')`
 *    — the env var the transitive HTTP client reads; claude-agent-acp itself
 *    never touches env vars directly, it delegates entirely to
 *    `@anthropic-ai/claude-agent-sdk` → `@anthropic-ai/sdk`).
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
export const CLAUDE_HARNESS_ID = 'claude';

// ---------------------------------------------------------------------------
// Session-mode pinning policy (P2 live gate P-1 — NORMATIVE session setup)
// ---------------------------------------------------------------------------
/**
 * P-1 (live-verified): claude-agent-acp's DEFAULT session mode is `auto`,
 * which writes inside AND outside the cwd without EVER sending
 * `session/request_permission` — the T20 default-deny machinery never
 * engages. The pin: `session/set_mode` with mode `'default'` (never
 * `'auto'`) for EVERY role, forcing tool use through the ACP permission
 * channel where `decidePermission` enforces default-deny and the
 * coordinator/verifier write veto (§10.2). Applied by the ACP session layer
 * immediately after `session/new`/`session/load`; failure fails the setup.
 */
export const CLAUDE_SESSION_MODE_POLICY: SessionModePolicy = {
  byRole: {
    coordinator: { mechanism: 'session_set_mode', value: 'default' },
    implementor: { mechanism: 'session_set_mode', value: 'default' },
    verifier: { mechanism: 'session_set_mode', value: 'default' },
  },
  defaultPin: { mechanism: 'session_set_mode', value: 'default' },
};

/** ACP protocol version claude-agent-acp@0.59.0 negotiates (verified literal
 * `protocolVersion: 1` in `initialize()`'s return, acp-agent.js ~line 543). */
export const CLAUDE_ACP_PROTOCOL_VERSION = 1;

/**
 * Claude Code's built-in subagent-dispatch tool (verified: `tools.js` case
 * `"Task"`; `acp-agent.js` tracks `message.subagent_type` on assistant
 * frames it produces). This is exactly the kind of "harness-native subagent
 * tool that conflicts with orchestration" PLAN §8 denylists per profile —
 * the host enforces delegation depth ≤ 2 and role boundaries itself; letting
 * an Implementor/Verifier session dispatch its own Task subagents would
 * bypass both.
 */
export const CLAUDE_CONFLICTING_BUILTIN_TOOLS = ['Task'] as const;

/**
 * Documented, MVP-recommended auth path for Claude (PLAN D2). Verified as
 * the standard env var the transitive HTTP client reads (see module header);
 * claude-agent-acp itself never inspects it — this is what our OWN
 * pre-spawn `doctor`-style probe checks, independent of the adapter.
 */
export const ANTHROPIC_API_KEY_ENV_VAR = 'ANTHROPIC_API_KEY';

// ---------------------------------------------------------------------------
// Auth readiness (§17.1 live-gate H-2: evidence-honest, never presence-based
// `supported`)
// ---------------------------------------------------------------------------
/** Evidence input for the claude auth probe (H-2). */
export interface ClaudeAuthProbeContext {
  /** Recorded turn evidence (e.g. `AcpStdioAdapter.authEvidence`). */
  readonly evidence?: AuthValidationEvidence;
}

/**
 * HONEST auth-readiness probe (H-2 rule, PLAN §17.1: "`supported` requires
 * validated evidence (a recorded successful provider turn); bare
 * key/credential presence reports as detected-but-unvalidated, never
 * `supported`"). A present, non-empty API key is MATERIAL →
 * `'detected_but_unvalidated'` until a successful provider turn validates it
 * (`evidence.validatedTurnAt` → `'supported'`; a recorded auth failure
 * without a newer validated turn → `'detected_but_unsupported'`). Absence is
 * NOT evidence of unavailability — OAuth/subscription login may still be
 * active on disk (`~/.claude`) and this module deliberately never inspects
 * provider-owned credential storage — so the honest default is `'unknown'`.
 * Mapping: `deriveAuthReadiness` (single documented rule, spi.ts).
 */
export function probeClaudeAuthReadiness(
  env: NodeJS.ProcessEnv = process.env,
  context: ClaudeAuthProbeContext = {},
): AuthReadiness {
  const key = env[ANTHROPIC_API_KEY_ENV_VAR];
  const keyPresent = typeof key === 'string' && key.length > 0;
  return deriveAuthReadiness(keyPresent, context.evidence ?? {});
}

// ---------------------------------------------------------------------------
// Config option mapping (session/new / session/load `configOptions`, NOT
// something `initialize()` itself returns — populated once a session exists)
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

/** Flattens the SDK's `SessionConfigSelectOptions` union (a flat option list
 * OR a grouped option list — see `@agentclientprotocol/sdk`'s
 * `SessionConfigSelect.options`) into plain value ids. */
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
  // boolean
  return {
    id: option.id,
    kind,
    values: ['true', 'false'],
    ...(typeof option.currentValue === 'boolean' ? { current: String(option.currentValue) } : {}),
  };
}

// ---------------------------------------------------------------------------
// sessionOps derivation (verified defaults used when no live initialize()
// response is available — offline/static capability construction)
// ---------------------------------------------------------------------------
const STATIC_SESSION_OPS_DEFAULT: SessionOpSupport = {
  create: true,
  load: true,
  resume: true,
  // Verified advertised (`sessionCapabilities.fork: {}`) but UNUSED in MVP —
  // native fork is probed and recorded only (PLAN §9).
  fork: true,
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
export interface ClaudeCapabilityInput {
  readonly executable: ExecutableInfo;
  readonly clock: Clock;
  /** Real `initialize()` RPC response, when the transport has one; offline/
   * static callers (e.g. `doctor` before ever spawning) omit it and get the
   * verified static defaults instead. */
  readonly initializeResponse?: InitializeResponse;
  /** Real `session/new` (or `session/load`) response's `configOptions`. */
  readonly sessionConfigOptions?: readonly SessionConfigOption[];
  /** Defaults to `probeClaudeAuthReadiness()` off `process.env`. */
  readonly auth?: AuthReadiness;
}

/**
 * Builds the §9 CapabilityRecord for the Claude ACP profile. Pure: no I/O,
 * no process spawn. `input.initializeResponse` lets a real transport layer
 * (not built here — see the module header) refine the record with live
 * observed capabilities; every field the response doesn't cover falls back
 * to the verified static default.
 */
export function buildClaudeCapabilityRecord(input: ClaudeCapabilityInput): CapabilityRecord {
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
          fork: capabilityPresent(sessionCapabilities?.fork),
          cancel: true, // session/cancel: ACP baseline notification, never negotiated
        };

  return {
    harnessId: CLAUDE_HARNESS_ID,
    protocol: {
      name: 'acp',
      version: String(input.initializeResponse?.protocolVersion ?? CLAUDE_ACP_PROTOCOL_VERSION),
    },
    executable: input.executable,
    auth: input.auth ?? probeClaudeAuthReadiness(),
    sessionOps,
    configOptions: (input.sessionConfigOptions ?? []).map(toConfigOptionDescriptor),
    // Verified: `setSessionConfigOption` (acp-agent.js ~line 2861), wired to
    // `session/set_config_option` (PLAN §3's "current SDK" mechanism).
    modelMechanism: 'session_set_config_option',
    // session/request_permission is an ACP baseline mechanism (not a
    // negotiated capability toggle in AgentCapabilities) — always available.
    permissionRequests: true,
    mcpConfig: {
      supported: mcp === undefined ? true : Boolean(mcp.http) || Boolean(mcp.sse),
      reportOnly: true, // D5: MCP passthrough deferred — report-only in the MVP
    },
    checkpointExport: false, // no adapter-side checkpoint/export surface exists
    // §13: Claude's `-32603` + `data.errorKind==='rate_limit'` convention
    // (PR #582) is a verified structured signal — see classify.ts + fixtures.
    usageLimitReporting: 'structured',
    // Verified structured for the rate_limit convention itself, but the
    // CURRENT envelope shape (`errorKindData()`, acp-agent.js ~line 4113)
    // never attaches a resumesAt/retryAfterSeconds value — only HTTP 429's
    // Retry-After header (API-key mode) reliably carries a real ETA today.
    // 'honored': when a structured ETA IS present (429/Retry-After, or a
    // future adapter version that adds one to the errorKind envelope), we
    // use it as-is rather than forecasting.
    retryAfterTier: 'honored',
    // Verified: `sessionUsage(session)` (acp-agent.js ~line 4081) attaches
    // real per-turn input/output/cache token counts to every settled
    // PromptResponse.
    usageAccounting: 'per_turn',
    conflictingBuiltinTools: CLAUDE_CONFLICTING_BUILTIN_TOOLS,
    sessionIdentity: {
      exposesNativeSessionId: true,
      // Design default pending the PLAN §3 P2 live compatibility gate's
      // actual identity-confirmed-resume verification; claude-agent-acp
      // advertises `session/resume` and exposes real native session ids, so
      // this is the reasonable static default, not a hard-verified wire
      // trace of the resume response.
      confirmsIdentityOnResume: true,
    },
    probedAt: input.clock.nowIso(),
  };
}
