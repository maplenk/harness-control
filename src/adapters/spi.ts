/**
 * Harness adapter SPI (PLAN.md §9) — the transport-agnostic contract every
 * harness adapter implements (generic ACP stdio transport in the MVP; the
 * tier-2 headless-JSON / native-SDK seam implements the SAME interface,
 * PLAN §3, §5).
 *
 * Operations (PLAN §9, verbatim): `probe() · initialize() · createSession() ·
 * loadSession() · resumeSession?() · forkSession?() · prompt() · cancelTurn()
 * · listConfigOptions() · setConfigOption() · resolvePermission() ·
 * classifyError(raw) · close()`.
 *
 * Contract rules:
 * - Ordering: `probe()` may be called at any time (cheap, pre-spawn
 *   diagnostics). `initialize()` must complete before any session operation.
 *   After `close()` only `close()` itself is legal (idempotent). Violations
 *   are `AdapterError{kind:'invalid_state'}` — typed, never undefined
 *   behavior.
 * - Unsupported capability is a TYPED error (`UnsupportedCapabilityError`),
 *   never silent degradation (PLAN §9). `resumeSession`/`forkSession` are
 *   optional MEMBERS: an adapter that cannot natively resume/fork omits the
 *   method entirely; an adapter that advertises it but fails at runtime
 *   throws (conformance tests cover advertised-but-failed resume and
 *   identity mismatch).
 * - `classifyError` operates ONLY on adapter/protocol error envelopes
 *   (JSON-RPC error responses, typed adapter errors, HTTP 429/Retry-After in
 *   API-key mode). Free text inside agent messages is NEVER classified — a
 *   model merely *talking about* limits must not pause a run (PLAN §9, §13).
 * - Late `session/update` notifications after the prompt response are
 *   tolerated: the `onUpdate` callback MAY fire after the prompt promise
 *   settles and is attributed to the closed turn (PLAN §10.2, issue #864).
 */
import type { AcpStopReason, TurnUsage } from '../domain/entities.js';
import type { AcpSessionId, NativeSessionId } from '../domain/ids.js';
import type { ClassifiedErrorKind, DetectionTier } from '../domain/state.js';
import type { IsoTimestamp } from '../lib/clock.js';

// ---------------------------------------------------------------------------
// Capability record (PLAN §9 — assembled at initialize + capability probe)
// ---------------------------------------------------------------------------
/**
 * §3/D2 + §17.1 (live-gate H-2): auth readiness — never a categorical claim
 * beyond evidence, and NEVER `supported` from bare key/credential presence.
 * The P2 live gate proved presence-based reporting over-claims: this
 * machine's `OPENAI_API_KEY` was doctor-`supported` yet 401-invalid on the
 * first turn that actually depended on it (docs/reviews/p2-live-gate.md H-2).
 * - `supported`: VALIDATED evidence exists — a recorded successful provider
 *   turn (`AuthValidationEvidence.validatedTurnAt`).
 * - `detected_but_unvalidated`: auth material present (env key, ChatGPT
 *   `auth.json`, …) but not yet exercised by a successful turn.
 * - `detected_but_unsupported`: material present but the evidence (recorded
 *   auth failure) or provider policy (e.g. Claude subscription-OAuth ToS bar)
 *   says it does NOT work as an automation path.
 * - `unknown`: no material detected, no evidence either way.
 */
export type AuthReadiness =
  | 'supported'
  | 'detected_but_unvalidated'
  | 'detected_but_unsupported'
  | 'unknown';

/**
 * H-2 evidence record. `validatedTurnAt` is the timestamp of a RECORDED
 * successful provider turn (the only thing that may produce `supported`);
 * `authFailureAt` is the timestamp of a recorded auth-classified provider
 * failure (kind `auth` from `classifyError`, e.g. a live 401). The ACP
 * adapter tracks both — see `AcpStdioAdapter.authEvidence`.
 */
export interface AuthValidationEvidence {
  readonly validatedTurnAt?: IsoTimestamp;
  readonly authFailureAt?: IsoTimestamp;
}

/**
 * Single documented evidence→readiness mapping (H-2), shared by both
 * provider probes and `doctor`:
 * 1. a validated turn STRICTLY newer than any recorded auth failure →
 *    `supported` (ties lose — the conservative direction);
 * 2. else a recorded auth failure → `detected_but_unsupported`;
 * 3. else material present → `detected_but_unvalidated` — never `supported`;
 * 4. else `unknown`.
 * ISO-8601 UTC timestamps compare lexicographically.
 */
export function deriveAuthReadiness(
  materialDetected: boolean,
  evidence: AuthValidationEvidence = {},
): AuthReadiness {
  const { validatedTurnAt, authFailureAt } = evidence;
  if (validatedTurnAt !== undefined && (authFailureAt === undefined || validatedTurnAt > authFailureAt)) {
    return 'supported';
  }
  if (authFailureAt !== undefined) return 'detected_but_unsupported';
  return materialDetected ? 'detected_but_unvalidated' : 'unknown';
}

/** §9: how limit signals cross the adapter boundary (§13 classifier tiers). */
export type UsageLimitReporting = 'structured' | 'parseable' | 'none';

/** §9: whether a structured resume ETA is honored or must be forecast. */
export type RetryAfterTier = 'honored' | 'forecast_fallback' | 'forecast_only';

/** §17.2: honest cost accounting — adapter-reported per turn, or nothing. */
export type UsageAccounting = 'per_turn' | 'none';

/**
 * §3: model mechanisms are declarative per provider — current SDK =
 * `session/set_config_option`; older deployments used `session/set_model`;
 * others use env/CLI flags. Probed at initialize.
 */
export type ModelMechanism =
  | 'session_set_config_option'
  | 'session_set_model'
  | 'env'
  | 'cli_flag'
  | 'unsupported';

/** Control-plane protocol the adapter speaks (§3, §5 tier-2 seam). */
export interface ProtocolInfo {
  readonly name: 'acp' | 'headless_json' | 'native_sdk';
  readonly version: string;
}

/** Lockfile-pinned executable/package identity (§10.1, §17.1 provenance). */
export interface ExecutableInfo {
  readonly packageName?: string;
  readonly version: string;
  readonly resolvedPath?: string;
}

/** §9: create/load/resume/fork/cancel support flags. */
export interface SessionOpSupport {
  readonly create: boolean;
  readonly load: boolean;
  readonly resume: boolean;
  readonly fork: boolean;
  readonly cancel: boolean;
}

/** One probed config option (model / mode / reasoning …) with advertised values. */
export interface ConfigOptionDescriptor {
  readonly id: string;
  readonly kind: 'model' | 'mode' | 'reasoning' | 'other';
  readonly values: readonly string[];
  readonly current?: string;
}

/** §9 "observed session identity": what identity evidence the adapter exposes. */
export interface ObservedSessionIdentity {
  readonly exposesNativeSessionId: boolean;
  readonly confirmsIdentityOnResume: boolean;
  /** Last identity actually observed (plain strings — reporting surface). */
  readonly lastObserved?: {
    readonly acpSessionId?: string;
    readonly nativeSessionId?: string;
  };
}

/**
 * Capability record per PLAN §9: protocol+version, executable/package
 * version, auth readiness (4-state, §17.1 H-2), create/load/resume/fork/cancel,
 * model+mode+reasoning options, modelMechanism, permission-request support,
 * MCP config support (report-only in MVP), checkpoint/export,
 * usageLimitReporting, retryAfterTier, usageAccounting,
 * conflictingBuiltinTools[], observed session identity.
 */
export interface CapabilityRecord {
  readonly harnessId: string;
  readonly protocol: ProtocolInfo;
  readonly executable: ExecutableInfo;
  readonly auth: AuthReadiness;
  readonly sessionOps: SessionOpSupport;
  /** Probed model + mode + reasoning options with advertised values. */
  readonly configOptions: readonly ConfigOptionDescriptor[];
  readonly modelMechanism: ModelMechanism;
  readonly permissionRequests: boolean;
  /** D5: MCP passthrough deferred — capability REPORTING only in the MVP. */
  readonly mcpConfig: { readonly supported: boolean; readonly reportOnly: true };
  readonly checkpointExport: boolean;
  readonly usageLimitReporting: UsageLimitReporting;
  readonly retryAfterTier: RetryAfterTier;
  readonly usageAccounting: UsageAccounting;
  /** §8: harness-native subagent tools denylisted per profile. */
  readonly conflictingBuiltinTools: readonly string[];
  readonly sessionIdentity: ObservedSessionIdentity;
  readonly probedAt: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Probe (cheap, pre-spawn: binary resolution, versions, auth readiness)
// ---------------------------------------------------------------------------
export interface ProbeResult {
  readonly harnessId: string;
  readonly available: boolean;
  readonly executable?: ExecutableInfo;
  readonly protocol?: ProtocolInfo;
  readonly auth: AuthReadiness;
  /** Human-readable diagnostics for `doctor` (§18). */
  readonly issues: readonly string[];
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------
export interface SessionHandle {
  readonly acpSessionId: AcpSessionId;
  /** Provider-native session id when the adapter exposes one (§6.1, §11.1). */
  readonly nativeSessionId?: NativeSessionId;
}

export interface CreateSessionInput {
  readonly cwd: string;
}

export interface LoadSessionInput {
  readonly acpSessionId: AcpSessionId;
  readonly cwd: string;
}

export interface ResumeSessionInput {
  readonly acpSessionId: AcpSessionId;
  readonly cwd: string;
  /** When known, the adapter must confirm identity against this (§11.1). */
  readonly expectedNativeSessionId?: NativeSessionId;
}

/**
 * §9: `resumeSession?` = native fast resume (no replay); `loadSession` = the
 * replay path. `identityConfirmed:false` means the host must fall back to a
 * checkpoint-linked successor (§11.1 — the portable correctness path).
 */
export interface ResumeResult {
  readonly resumed: 'native' | 'replayed';
  readonly identityConfirmed: boolean;
  readonly session: SessionHandle;
}

export interface ForkSessionInput {
  readonly acpSessionId: AcpSessionId;
  readonly cwd: string;
}

// ---------------------------------------------------------------------------
// Authentication (live-gate H-2: the SPI must be able to authenticate an
// isolated child instead of silently depending on inherited credentials)
// ---------------------------------------------------------------------------
/**
 * One ACP `authenticate` call. `methodId` must be one of the agent's
 * advertised auth-method ids (codex-acp@1.1.4 advertises `api-key`,
 * `chat-gpt` unless `NO_BROWSER` is set, and conditionally `gateway` —
 * source: dist `getCodexAuthMethods()`; the H-2 probe exercised `api-key`
 * live through our transport).
 *
 * HONESTY CONTRACT (H-2): ACP-level acceptance is NOT auth validation — the
 * live gate saw `authenticate {methodId:'api-key'}` accepted in 3ms for a
 * key that 401'd on the very next turn. A resolved `authenticate` therefore
 * never upgrades `AuthReadiness`; only a recorded successful provider turn
 * does (`AuthValidationEvidence.validatedTurnAt`).
 */
export interface AuthenticateInput {
  readonly methodId: string;
}

// ---------------------------------------------------------------------------
// Prompt streaming (normalized updates; ACP session/update ⊂ this vocabulary)
// ---------------------------------------------------------------------------
export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** ACP permission option kinds (session/request_permission). */
export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: PermissionOptionKind;
}

/** A pending permission request; answered later via `resolvePermission` (T20). */
export interface PermissionRequest {
  readonly requestId: string;
  readonly sessionId: AcpSessionId;
  readonly description: string;
  readonly toolTitle?: string;
  /**
   * HIGH-5: the tool call's ACP `rawInput` — the payload the provider will
   * actually EXECUTE, as opposed to the human-readable `toolTitle`. Surfaced so
   * an INTERACTIVE decider judges what will run rather than the prose describing
   * it; the headless path binds the two through `verifyOperationPayload`.
   * Absent when the provider sent none (itself a reason to refuse a shell call).
   */
  readonly rawInput?: unknown;
  readonly options: readonly PermissionOption[];
}

/** Cumulative session cost as reported by `usage_update` (ACP `Cost`). */
export interface SessionCost {
  readonly amount: number;
  /** ISO 4217 currency code (e.g. "USD"). */
  readonly currency: string;
}

export type SessionUpdate =
  | { readonly kind: 'agent_message_chunk'; readonly text: string }
  | { readonly kind: 'agent_thought_chunk'; readonly text: string }
  /** Replayed user input (live: seen during `session/load` history replay). */
  | { readonly kind: 'user_message_chunk'; readonly text: string }
  | {
      readonly kind: 'tool_call';
      readonly toolCallId: string;
      readonly title?: string;
      readonly status?: ToolCallStatus;
    }
  | {
      readonly kind: 'tool_call_update';
      readonly toolCallId: string;
      readonly status?: ToolCallStatus;
    }
  | {
      readonly kind: 'plan';
      readonly entries: ReadonlyArray<{
        readonly content: string;
        readonly status?: 'pending' | 'in_progress' | 'completed';
      }>;
    }
  | { readonly kind: 'permission_request'; readonly request: PermissionRequest }
  /**
   * REAL wire kind (P2 live gate, both adapters, every turn): context/cost
   * telemetry — `used` tokens in context, total context `size`, cumulative
   * session `cost`. This is the live feed for §17.2 per-turn token/cost
   * accounting.
   */
  | {
      readonly kind: 'usage_update';
      readonly usedTokens: number;
      readonly contextWindowSize: number;
      readonly cost?: SessionCost;
    }
  /** REAL wire kind: session metadata (title / last-activity) changed. */
  | { readonly kind: 'session_info_update'; readonly title?: string; readonly updatedAt?: string }
  /** REAL wire kind: the agent's slash-command surface changed. */
  | { readonly kind: 'available_commands_update'; readonly commandNames: readonly string[] }
  /**
   * REAL wire kind (`config_option_update`): the full refreshed config-option
   * set — the §11.2 effective-value echo channel next to the
   * `session/set_config_option` response itself.
   */
  | { readonly kind: 'config_option_update'; readonly configOptions: readonly ConfigOptionDescriptor[] }
  /** REAL wire kind (`current_mode_update`): the session mode changed (P-1 pinning echo). */
  | { readonly kind: 'current_mode_update'; readonly currentModeId: string }
  /** Anything the adapter cannot normalize — passed through, never dropped silently. */
  | { readonly kind: 'unknown'; readonly raw: unknown };

export interface PromptInput {
  readonly sessionId: AcpSessionId;
  readonly prompt: string;
  /**
   * Streaming updates callback. MAY be invoked after the returned promise
   * settles (late updates are attributed to the closed turn — §10.2, #864).
   */
  readonly onUpdate?: (update: SessionUpdate) => void;
}

/**
 * Sink-safe diagnostics captured at an abnormal ACP turn boundary. Stderr is
 * already redacted and bounded by the transport before it reaches this SPI
 * surface; an absent childExit means the provider returned the stop reason
 * while its ACP process was still alive.
 */
export interface PromptDiagnostics {
  readonly stderr?: {
    readonly head: string;
    readonly tail: string;
    readonly totalBytes: number;
    readonly truncated: boolean;
  };
  readonly childExit?: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  };
}

/** Final turn result: ACP's closed StopReason enum + honest usage (§17.2). */
export interface PromptResult {
  readonly stopReason: AcpStopReason;
  readonly usage?: TurnUsage;
  /** Present only when an abnormal stop had transport evidence to preserve. */
  readonly diagnostics?: PromptDiagnostics;
}

export interface CancelTurnInput {
  readonly sessionId: AcpSessionId;
}

// ---------------------------------------------------------------------------
// Config options (§11.2 model switching awaits the effective-value echo)
// ---------------------------------------------------------------------------
export interface SetConfigOptionInput {
  readonly sessionId: AcpSessionId;
  /**
   * SPI-level option id. NOTE (P2 live gate, TX-3): the ACP wire parameter
   * is named `configId` — the ACP session layer maps this field onto it.
   */
  readonly optionId: string;
  readonly value: string;
}

export interface SetConfigOptionResult {
  readonly effectiveValue: string;
  /** true only when the adapter OBSERVED an effective-value echo (§11.2). */
  readonly echoed: boolean;
}

// ---------------------------------------------------------------------------
// Permission resolution (T20; ACP RequestPermissionOutcome shape)
// ---------------------------------------------------------------------------
export type PermissionOutcome =
  | { readonly kind: 'selected'; readonly optionId: string }
  | { readonly kind: 'cancelled' };

export interface ResolvePermissionInput {
  readonly sessionId: AcpSessionId;
  readonly requestId: string;
  readonly outcome: PermissionOutcome;
}

// ---------------------------------------------------------------------------
// Error classification (§9, §13 — envelopes ONLY, never agent-message text)
// ---------------------------------------------------------------------------
export interface ErrorClassification {
  readonly kind: ClassifiedErrorKind;
  /** Structured resume ETA when present; otherwise honestly absent (§13). */
  readonly resumesAt?: IsoTimestamp;
  readonly source: 'structured' | 'parsed';
  readonly confidence: 'high' | 'medium' | 'low';
  /** §13 detection tier feeding LimitIncident.detectionTier. */
  readonly detectionTier?: DetectionTier;
  readonly provider?: string;
}

// ---------------------------------------------------------------------------
// Typed error taxonomy (§9: unsupported capability is a typed error, never
// silent; §10.2: malformed JSON, oversized lines, protocol mismatch,
// unexpected EOF → explicit terminal events)
// ---------------------------------------------------------------------------
export const ADAPTER_ERROR_KINDS = [
  /** §9 — operation/capability not supported by this adapter. */
  'unsupported_capability',
  /** SPI misuse: not initialized, closed, overlapping prompt, unknown request id. */
  'invalid_state',
  /** Bad argument: unknown config option id, value outside advertised set. */
  'invalid_argument',
  /** §10.1 — lockfile-pinned binary could not be resolved/spawned. */
  'spawn_failed',
  /** §10.2 — handshake exceeded the 15s bound. */
  'handshake_timeout',
  /** §10.2 — protocol mismatch at initialize. */
  'protocol_version_mismatch',
  /** §10.2 — malformed JSON on the wire. */
  'malformed_frame',
  /** §10.2 — protocol line exceeded the 1MiB bound. */
  'oversized_frame',
  /** §10.2 — decoded-event queue overflow (terminal event + cleanup). */
  'queue_overflow',
  /** §10.2 — unexpected EOF / child exited while a call was outstanding. */
  'unexpected_eof',
  /** §10.2 — turn exceeded the 30min bound. */
  'turn_timeout',
  /** Unknown session id (load/resume/prompt against nothing). */
  'session_not_found',
  /** §11.1 — adapter confirmed a DIFFERENT identity than expected. */
  'session_identity_mismatch',
  /**
   * Provider/agent error envelope (JSON-RPC error response). Carries the raw
   * envelope in `.envelope` — feed it to `classifyError` (§13).
   */
  'provider_error',
  /** Adapter-internal invariant violation. */
  'internal',
] as const;

export type AdapterErrorKind = (typeof ADAPTER_ERROR_KINDS)[number];

export interface AdapterErrorOptions {
  readonly harnessId?: string;
  /** Raw error envelope for `kind:'provider_error'` (classifyError input). */
  readonly envelope?: unknown;
  readonly cause?: unknown;
}

export class AdapterError extends Error {
  override readonly name: string = 'AdapterError';
  readonly kind: AdapterErrorKind;
  readonly harnessId?: string;
  readonly envelope?: unknown;

  constructor(kind: AdapterErrorKind, message: string, options: AdapterErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.kind = kind;
    if (options.harnessId !== undefined) this.harnessId = options.harnessId;
    if (options.envelope !== undefined) this.envelope = options.envelope;
  }
}

export function isAdapterError(value: unknown): value is AdapterError {
  return value instanceof AdapterError;
}

/** The raw envelope of a provider_error, if `value` is one. */
export function providerEnvelopeOf(value: unknown): unknown {
  return isAdapterError(value) && value.kind === 'provider_error' ? value.envelope : undefined;
}

// ---------------------------------------------------------------------------
// Capability gating (typed, never silent — PLAN §9)
// ---------------------------------------------------------------------------
export const ADAPTER_CAPABILITY_NAMES = [
  'createSession',
  'loadSession',
  'resumeSession',
  'forkSession',
  'cancelTurn',
  'setConfigOption',
  'permissionRequests',
  'mcpConfig',
  'checkpointExport',
  'modelSwitch',
] as const;

export type AdapterCapabilityName = (typeof ADAPTER_CAPABILITY_NAMES)[number];

export class UnsupportedCapabilityError extends AdapterError {
  override readonly name: string = 'UnsupportedCapabilityError';
  readonly capability: AdapterCapabilityName;

  constructor(capability: AdapterCapabilityName, options: AdapterErrorOptions = {}) {
    super(
      'unsupported_capability',
      `Capability not supported by this adapter: ${capability}`,
      options,
    );
    this.capability = capability;
  }
}

/** Pure predicate over the capability record (single mapping, documented). */
export function capabilitySupported(
  record: CapabilityRecord,
  capability: AdapterCapabilityName,
): boolean {
  switch (capability) {
    case 'createSession':
      return record.sessionOps.create;
    case 'loadSession':
      return record.sessionOps.load;
    case 'resumeSession':
      return record.sessionOps.resume;
    case 'forkSession':
      return record.sessionOps.fork;
    case 'cancelTurn':
      return record.sessionOps.cancel;
    case 'setConfigOption':
      // Session-scoped config mechanisms, or any probed option to set.
      return (
        record.modelMechanism === 'session_set_config_option' ||
        record.modelMechanism === 'session_set_model' ||
        record.configOptions.length > 0
      );
    case 'permissionRequests':
      return record.permissionRequests;
    case 'mcpConfig':
      return record.mcpConfig.supported;
    case 'checkpointExport':
      return record.checkpointExport;
    case 'modelSwitch':
      return record.modelMechanism !== 'unsupported';
  }
}

/** Throws the TYPED unsupported-capability error (§9: never silent). */
export function requireCapability(
  record: CapabilityRecord,
  capability: AdapterCapabilityName,
): void {
  if (!capabilitySupported(record, capability)) {
    throw new UnsupportedCapabilityError(capability, { harnessId: record.harnessId });
  }
}

// ---------------------------------------------------------------------------
// The SPI
// ---------------------------------------------------------------------------
export interface HarnessAdapter {
  readonly harnessId: string;

  /** Cheap pre-spawn diagnostics: binary resolution, versions, auth (§18 doctor). */
  probe(): Promise<ProbeResult>;

  /** Spawn + handshake + capability probe (§10.1). Must precede session ops. */
  initialize(): Promise<CapabilityRecord>;

  createSession(input: CreateSessionInput): Promise<SessionHandle>;

  /** Replay path (§9). Unsupported → UnsupportedCapabilityError. */
  loadSession(input: LoadSessionInput): Promise<SessionHandle>;

  /**
   * OPTIONAL native fast resume (no replay). Adapters without native resume
   * omit the member. Advertised-but-failed resume throws; identity mismatch
   * throws `session_identity_mismatch` or returns `identityConfirmed:false`
   * (either forces the checkpoint-successor path, §11.1).
   */
  resumeSession?(input: ResumeSessionInput): Promise<ResumeResult>;

  /** OPTIONAL native fork. Unused in MVP — probed and recorded only (§9). */
  forkSession?(input: ForkSessionInput): Promise<SessionHandle>;

  /**
   * OPTIONAL explicit auth step (H-2). Adapters whose control plane exposes
   * an authenticate operation (ACP `authenticate`) implement it; rejection
   * surfaces as `AdapterError{kind:'provider_error'}`. Resolution means
   * ACP-level ACCEPTANCE only — never validated auth (see AuthenticateInput).
   * NOT required for the codex inherited-ChatGPT path: the codex core reads
   * `$CODEX_HOME/auth.json` directly and codex-acp's session gate
   * (`checkAuthorization()` → `authRequired()`) passes without any
   * authenticate call when that login exists (source-verified; §17.1 H-1
   * isolation carries the material into the isolated home instead).
   */
  authenticate?(input: AuthenticateInput): Promise<void>;

  /**
   * One turn: streams normalized updates via `input.onUpdate`, resolves with
   * the final stop reason (+usage when advertised). At most ONE in-flight
   * prompt per session (§6.2 operation axis). Provider error envelopes
   * reject with `AdapterError{kind:'provider_error', envelope}` — the host
   * feeds `.envelope` to `classifyError` (§13).
   */
  prompt(input: PromptInput): Promise<PromptResult>;

  /**
   * Request cancellation of the in-flight turn. The authoritative signal is
   * the prompt promise resolving with `stopReason:'cancelled'` (ACP
   * semantics); this call only delivers the request. Escalation on
   * ignored/late cancels is the transport's job (§10.2 grace bounds).
   */
  cancelTurn(input: CancelTurnInput): Promise<void>;

  listConfigOptions(sessionId: AcpSessionId): Promise<readonly ConfigOptionDescriptor[]>;

  /** §11.2: resolves only with the effective value; `echoed` says how. */
  setConfigOption(input: SetConfigOptionInput): Promise<SetConfigOptionResult>;

  /** Answer a pending permission request surfaced in the update stream (T20). */
  resolvePermission(input: ResolvePermissionInput): Promise<void>;

  /**
   * Classify a raw adapter/protocol error envelope (§9, §13). Synchronous and
   * pure. Inputs are envelopes ONLY — implementations MUST NOT classify free
   * text from agent messages, and unrecognizable input maps to
   * `unknown_provider_error` (fail-safe: pauses via T16, never breaker).
   */
  classifyError(raw: unknown): ErrorClassification;

  /** Close streams, terminate + reap the identity-verified process group (§10.1, §14). Idempotent. */
  close(): Promise<void>;
}
