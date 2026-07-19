/**
 * In-process scriptable fake adapter (PLAN §19: "Fake ACP subprocesses" have
 * a sibling: this fake implements the SPI DIRECTLY, no child process), for
 * conformance tests that exercise SPI semantics — capability gating, prompt
 * streaming, permission flow, cancellation, resume variants, error
 * classification — without wire concerns. Wire-level behaviors (fragmented
 * NDJSON, oversized lines, stderr noise, handshake stalls, process exits)
 * belong to the child-process fake (`./child.ts` + `fake-acp-child.mjs`).
 *
 * Scripting model: `InProcessFakeOptions.turns[n]` scripts the Nth `prompt()`
 * call (across all sessions, in call order); overflow yields a benign
 * `end_turn` with no updates. Determinism: no timers — updates are emitted
 * synchronously, late updates on the microtask queue directly after the
 * prompt promise settles (attributed to the closed turn, §10.2/#864).
 *
 * REAL-shape fidelity (P2 live gate): the wire-level truths (TX-1 `mcpServers`
 * requirement, TX-3 `configId` param, TX-3b `configOptions[].currentValue`
 * echoes, per-turn `usage_update`) live BELOW the SPI and are pinned by the
 * child-process fake; this fake pins the SPI-level consequences — the
 * `setConfigOption` effective-value echo contract (`echoed:true` only after
 * validation against advertised values), the live mode vocabulary with the
 * dangerous `auto` default (P-1), and the §9 `SessionUpdate` union including
 * `usage_update` (scriptable per turn).
 */
import type { AcpStopReason } from '../../domain/entities.js';
import { authRequiredErrorEnvelope, rateLimitErrorEnvelope } from './scenario.js';
import {
  acpSessionId,
  nativeSessionId,
  type AcpSessionId,
} from '../../domain/ids.js';
import { SystemClock, isoTimestamp, type Clock, type IsoTimestamp } from '../../lib/clock.js';
import {
  AdapterError,
  requireCapability,
  type AdapterErrorKind,
  type CancelTurnInput,
  type CapabilityRecord,
  type ConfigOptionDescriptor,
  type CreateSessionInput,
  type ErrorClassification,
  type ForkSessionInput,
  type HarnessAdapter,
  type LoadSessionInput,
  type PermissionOption,
  type PermissionRequest,
  type ProbeResult,
  type PromptInput,
  type PromptResult,
  type ResolvePermissionInput,
  type ResumeResult,
  type ResumeSessionInput,
  type SessionHandle,
  type SessionUpdate,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../spi.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------
export const DEFAULT_FAKE_HARNESS_ID = 'fake-acp';

export const DEFAULT_PERMISSION_OPTIONS: readonly PermissionOption[] = [
  { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
];

/** A fully-populated §9 capability record with honest fake defaults. */
export function defaultCapabilityRecord(harnessId: string, clock: Clock): CapabilityRecord {
  return {
    harnessId,
    protocol: { name: 'acp', version: '1' },
    executable: { packageName: 'fake-acp', version: '0.0.0' },
    auth: 'unknown',
    sessionOps: { create: true, load: true, resume: true, fork: false, cancel: true },
    configOptions: [
      { id: 'model', kind: 'model', values: ['fake-small', 'fake-large'], current: 'fake-small' },
      // Mode vocabulary = the union both live adapters advertised in the P2
      // gate (claude default/plan/auto ∪ codex read-only/agent/agent-full-
      // access), current = the DANGEROUS live default 'auto' (P-1) so mode
      // pinning is exercisable — and its absence observable — against this
      // fake too.
      {
        id: 'mode',
        kind: 'mode',
        values: ['auto', 'default', 'plan', 'read-only', 'agent', 'agent-full-access'],
        current: 'auto',
      },
    ],
    modelMechanism: 'session_set_config_option',
    permissionRequests: true,
    mcpConfig: { supported: false, reportOnly: true },
    checkpointExport: false,
    usageLimitReporting: 'structured',
    retryAfterTier: 'honored',
    usageAccounting: 'per_turn',
    conflictingBuiltinTools: [],
    sessionIdentity: { exposesNativeSessionId: true, confirmsIdentityOnResume: true },
    probedAt: clock.nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Reference classifier (§9/§13 semantics; test-21 substrate)
// ---------------------------------------------------------------------------
const UNKNOWN_CLASSIFICATION: ErrorClassification = {
  kind: 'unknown_provider_error',
  source: 'parsed',
  confidence: 'low',
  detectionTier: 'unknown',
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function resumesAtFrom(
  data: Record<string, unknown> | undefined,
  clock: Clock,
): { resumesAt?: IsoTimestamp } {
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
  headers: Record<string, unknown> | undefined,
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

/**
 * Reference `classifyError` implementation for the fakes: structured tiers
 * only (§13 P4a gate — no free-text patterns anywhere). Recognizes BOTH
 * pinned real-adapter conventions (the fake models claude AND codex
 * profiles — W2-7):
 *  - JSON-RPC `-32603` + `data.errorKind='rate_limit'` (Claude adapter
 *    convention, PR #582) → usage_limit/structured, ETA from `data.resumesAt`
 *    or `data.retryAfterSeconds`;
 *  - JSON-RPC `-32603` + `data.codexErrorInfo='usageLimitExceeded'` (the
 *    verified codex-acp@1.1.4 signal) → usage_limit/structured — no reset
 *    field exists on the real shape, so the ETA stays honestly absent
 *    (forward-compat `data.resumesAt`/`retryAfterSeconds` still honored);
 *  - JSON-RPC `-32000` (the shared ACP-SDK `authRequired` factory both
 *    adapters use) or `data.errorKind='auth'|'auth_required'` → auth;
 *  - HTTP-ish `{status:429}` (+Retry-After header) → usage_limit/http_429;
 *    `{status:401|403}` → auth;
 *  - typed AdapterErrors → crash (spawn/EOF) or protocol (wire bounds),
 *    provider_error recursing on its envelope.
 * Everything else — including ANY plain string, i.e. agent-message text —
 * maps to `unknown_provider_error` (fail-safe T16, never text-classified).
 */
export function referenceClassifyError(raw: unknown, clock: Clock): ErrorClassification {
  if (raw instanceof AdapterError) {
    switch (raw.kind) {
      case 'provider_error':
        return referenceClassifyError(raw.envelope, clock);
      case 'spawn_failed':
      case 'unexpected_eof':
        return { kind: 'crash', source: 'structured', confidence: 'high' };
      case 'handshake_timeout':
      case 'protocol_version_mismatch':
      case 'malformed_frame':
      case 'oversized_frame':
      case 'queue_overflow':
      case 'turn_timeout':
        return { kind: 'protocol', source: 'structured', confidence: 'high' };
      default:
        return UNKNOWN_CLASSIFICATION;
    }
  }

  const record = asRecord(raw);
  if (record === undefined) return UNKNOWN_CLASSIFICATION; // strings NEVER classified

  const envelope = asRecord(record['error']) ?? record;
  const data = asRecord(envelope['data']);
  const errorKind = typeof data?.['errorKind'] === 'string' ? data['errorKind'] : undefined;
  const codexErrorInfo =
    typeof data?.['codexErrorInfo'] === 'string' ? data['codexErrorInfo'] : undefined;

  if (
    envelope['code'] === -32603 &&
    (errorKind === 'rate_limit' || codexErrorInfo === 'usageLimitExceeded')
  ) {
    return {
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'structured',
      ...resumesAtFrom(data, clock),
    };
  }
  if (envelope['code'] === -32000 || errorKind === 'auth' || errorKind === 'auth_required') {
    return { kind: 'auth', source: 'structured', confidence: 'high' };
  }

  const status = record['status'];
  if (status === 429) {
    return {
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'http_429',
      ...retryAfterHeaderEta(asRecord(record['headers']), clock),
    };
  }
  if (status === 401 || status === 403) {
    return { kind: 'auth', source: 'structured', confidence: 'high' };
  }
  if (typeof status === 'number' && status >= 500 && status <= 599) {
    return { kind: 'unknown_provider_error', source: 'structured', confidence: 'medium', detectionTier: 'unknown' };
  }
  return UNKNOWN_CLASSIFICATION;
}

// ---------------------------------------------------------------------------
// Scripting surface
// ---------------------------------------------------------------------------
export interface InProcessPermissionScript {
  readonly requestId?: string;
  readonly description?: string;
  readonly toolTitle?: string;
  readonly options?: readonly PermissionOption[];
}

/** Script for the Nth `prompt()` call (across sessions, in call order). */
export interface InProcessTurnScript {
  /** Emitted synchronously via `onUpdate` before anything else. */
  readonly updates?: readonly SessionUpdate[];
  /**
   * W2-7: the child process DIES mid-turn — after the scripted `updates`,
   * the prompt rejects with the SAME typed error the real transport
   * surfaces when the child exits with a turn in flight
   * (`AdapterError('unexpected_eof')` → classified `crash` → T13
   * interrupted). Mirrors the child fake's `exit.when='mid_updates'` at the
   * SPI level. Overrides `permission`/`result`/`errorEnvelope`.
   */
  readonly dieMidTurn?: boolean;
  /** Surface a permission request and WAIT for `resolvePermission` (T20). */
  readonly permission?: InProcessPermissionScript;
  /** Final result (default `{stopReason:'end_turn'}`). */
  readonly result?: PromptResult;
  /** Reject with `provider_error` carrying THIS envelope instead (§13). */
  readonly errorEnvelope?: unknown;
  /** Delivered on the microtask queue AFTER the promise settles (#864). */
  readonly lateUpdates?: readonly SessionUpdate[];
  /** `cancelTurn` is swallowed; complete via `forceCompleteTurn` (grace-bound tests). */
  readonly ignoreCancel?: boolean;
}

export type InProcessResumeScript =
  | { readonly behavior: 'native' | 'replayed'; readonly identityConfirmed: boolean }
  | { readonly behavior: 'fail'; readonly errorKind: AdapterErrorKind; readonly message?: string };

export interface InProcessFakeOptions {
  readonly harnessId?: string;
  /** Injected for deterministic `probedAt`/ETA arithmetic (defaults to SystemClock). */
  readonly clock?: Clock;
  /**
   * Shallow-merged over `defaultCapabilityRecord` (nested objects REPLACED,
   * not deep-merged). Deliberately independent of which optional METHODS
   * exist, so tests can script advertised-but-missing / advertised-but-failed
   * capability skews (§9 conformance).
   */
  readonly capabilities?: Partial<CapabilityRecord>;
  readonly probe?: Partial<ProbeResult>;
  readonly turns?: readonly InProcessTurnScript[];
  /** 'omit' removes the optional `resumeSession` member entirely. */
  readonly resume?: InProcessResumeScript | 'omit';
  /** Default 'omit' (MVP: fork probed and recorded only, §9). */
  readonly fork?: 'omit' | 'supported';
  /** Make `loadSession` fail with this typed kind (advertised-but-failed load). */
  readonly loadError?: AdapterErrorKind;
  readonly onSetConfigOption?: (input: SetConfigOptionInput) => SetConfigOptionResult;
  /** Returning undefined falls through to `referenceClassifyError`. */
  readonly classifyOverride?: (raw: unknown) => ErrorClassification | undefined;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------
interface InFlightTurn {
  readonly script: InProcessTurnScript;
  readonly onUpdate: ((update: SessionUpdate) => void) | undefined;
  readonly resolve: (result: PromptResult) => void;
  readonly reject: (error: unknown) => void;
  pendingPermissionRequestId: string | undefined;
}

interface FakeSessionState {
  readonly handle: SessionHandle;
  inFlight: InFlightTurn | undefined;
}

export interface FakeCallLogEntry {
  readonly op: string;
  readonly detail?: unknown;
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------
export class InProcessFakeAdapter implements HarnessAdapter {
  readonly harnessId: string;
  /** Present unless scripted 'omit' (optional SPI member, §9). */
  readonly resumeSession?: (input: ResumeSessionInput) => Promise<ResumeResult>;
  readonly forkSession?: (input: ForkSessionInput) => Promise<SessionHandle>;

  readonly #options: InProcessFakeOptions;
  readonly #clock: Clock;
  readonly #sessions = new Map<string, FakeSessionState>();
  readonly #loadable = new Map<string, SessionHandle>();
  readonly #configCurrent = new Map<string, string>();
  readonly #log: FakeCallLogEntry[] = [];
  #capabilities: CapabilityRecord | undefined;
  #closed = false;
  #turnCursor = 0;
  #sessionSeq = 0;
  #permissionSeq = 0;
  #cancelRequestCount = 0;

  constructor(options: InProcessFakeOptions = {}) {
    this.#options = options;
    this.harnessId = options.harnessId ?? DEFAULT_FAKE_HARNESS_ID;
    this.#clock = options.clock ?? new SystemClock();
    if (options.resume !== 'omit') {
      this.resumeSession = (input) => this.#resumeSession(input);
    }
    if (options.fork === 'supported') {
      this.forkSession = (input) => this.#forkSession(input);
    }
  }

  // ---- Introspection for assertions ---------------------------------------
  get log(): readonly FakeCallLogEntry[] {
    return this.#log;
  }

  get cancelRequestCount(): number {
    return this.#cancelRequestCount;
  }

  get capabilities(): CapabilityRecord | undefined {
    return this.#capabilities;
  }

  /** Preload a session id that `loadSession`/`resumeSession` can find. */
  registerLoadableSession(acpId: string, nativeId?: string): SessionHandle {
    const handle: SessionHandle = {
      acpSessionId: acpSessionId(acpId),
      ...(nativeId !== undefined ? { nativeSessionId: nativeSessionId(nativeId) } : {}),
    };
    this.#loadable.set(acpId, handle);
    return handle;
  }

  /** Test hook: complete a turn whose cancel was scripted-ignored. */
  forceCompleteTurn(sessionId: AcpSessionId, result?: PromptResult): void {
    const session = this.#requireSession(sessionId);
    const turn = session.inFlight;
    if (turn === undefined) {
      throw new AdapterError('invalid_state', 'forceCompleteTurn: no in-flight turn', {
        harnessId: this.harnessId,
      });
    }
    session.inFlight = undefined;
    turn.resolve(result ?? { stopReason: 'end_turn' as AcpStopReason });
  }

  // ---- SPI ----------------------------------------------------------------
  async probe(): Promise<ProbeResult> {
    this.#log.push({ op: 'probe' });
    return {
      harnessId: this.harnessId,
      available: true,
      auth: 'unknown',
      issues: [],
      ...this.#options.probe,
    };
  }

  async initialize(): Promise<CapabilityRecord> {
    this.#requireOpen();
    this.#log.push({ op: 'initialize' });
    this.#capabilities = {
      ...defaultCapabilityRecord(this.harnessId, this.#clock),
      ...this.#options.capabilities,
    };
    return this.#capabilities;
  }

  async createSession(input: CreateSessionInput): Promise<SessionHandle> {
    const record = this.#requireInitialized();
    requireCapability(record, 'createSession');
    this.#sessionSeq += 1;
    const acpId = `fake_acp_sess_${String(this.#sessionSeq).padStart(6, '0')}`;
    const handle: SessionHandle = {
      acpSessionId: acpSessionId(acpId),
      ...(record.sessionIdentity.exposesNativeSessionId
        ? { nativeSessionId: nativeSessionId(`fake_native_sess_${String(this.#sessionSeq).padStart(6, '0')}`) }
        : {}),
    };
    this.#sessions.set(acpId, { handle, inFlight: undefined });
    this.#loadable.set(acpId, handle);
    this.#log.push({ op: 'createSession', detail: { cwd: input.cwd, acpSessionId: acpId } });
    return handle;
  }

  async loadSession(input: LoadSessionInput): Promise<SessionHandle> {
    const record = this.#requireInitialized();
    requireCapability(record, 'loadSession');
    this.#log.push({ op: 'loadSession', detail: { acpSessionId: String(input.acpSessionId) } });
    if (this.#options.loadError !== undefined) {
      throw new AdapterError(this.#options.loadError, 'scripted loadSession failure', {
        harnessId: this.harnessId,
      });
    }
    const handle = this.#loadable.get(String(input.acpSessionId));
    if (handle === undefined) {
      throw new AdapterError('session_not_found', `Unknown session: ${String(input.acpSessionId)}`, {
        harnessId: this.harnessId,
      });
    }
    if (!this.#sessions.has(String(input.acpSessionId))) {
      this.#sessions.set(String(input.acpSessionId), { handle, inFlight: undefined });
    }
    return handle;
  }

  async prompt(input: PromptInput): Promise<PromptResult> {
    this.#requireInitialized();
    const session = this.#requireSession(input.sessionId);
    if (session.inFlight !== undefined) {
      throw new AdapterError('invalid_state', 'At most one in-flight prompt per session (§6.2)', {
        harnessId: this.harnessId,
      });
    }
    const script = this.#options.turns?.[this.#turnCursor] ?? {};
    this.#turnCursor += 1;
    // The prompt text is logged so callers can assert exactly what was sent
    // (e.g. W2-4's minimal probe prompt) — observation only, never behavior.
    this.#log.push({
      op: 'prompt',
      detail: { sessionId: String(input.sessionId), prompt: input.prompt },
    });

    return new Promise<PromptResult>((resolve, reject) => {
      const turn: InFlightTurn = {
        script,
        onUpdate: input.onUpdate,
        resolve,
        reject,
        pendingPermissionRequestId: undefined,
      };
      session.inFlight = turn;

      for (const update of script.updates ?? []) {
        turn.onUpdate?.(update);
      }

      if (script.dieMidTurn === true) {
        // The transport's honest surface for a mid-turn child death: any
        // streamed updates arrived, then the pipe ended without a response.
        session.inFlight = undefined;
        turn.reject(
          new AdapterError('unexpected_eof', 'Fake child process died mid-turn (scripted)', {
            harnessId: this.harnessId,
          }),
        );
        return;
      }

      if (script.permission !== undefined) {
        this.#permissionSeq += 1;
        const requestId =
          script.permission.requestId ?? `perm_${String(this.#permissionSeq).padStart(6, '0')}`;
        turn.pendingPermissionRequestId = requestId;
        const request: PermissionRequest = {
          requestId,
          sessionId: session.handle.acpSessionId,
          description: script.permission.description ?? 'Permission required',
          ...(script.permission.toolTitle !== undefined
            ? { toolTitle: script.permission.toolTitle }
            : {}),
          options: script.permission.options ?? DEFAULT_PERMISSION_OPTIONS,
        };
        turn.onUpdate?.({ kind: 'permission_request', request });
        return; // settled later by resolvePermission (or cancelTurn)
      }

      this.#settleTurn(session, turn);
    });
  }

  async cancelTurn(input: CancelTurnInput): Promise<void> {
    this.#requireInitialized();
    const session = this.#requireSession(input.sessionId);
    this.#cancelRequestCount += 1;
    this.#log.push({ op: 'cancelTurn', detail: { sessionId: String(input.sessionId) } });
    const turn = session.inFlight;
    if (turn === undefined) return; // idempotent: nothing in flight
    if (turn.script.ignoreCancel === true) return; // scripted: swallow the cancel
    turn.pendingPermissionRequestId = undefined;
    session.inFlight = undefined;
    turn.resolve({ stopReason: 'cancelled' });
  }

  async listConfigOptions(sessionId: AcpSessionId): Promise<readonly ConfigOptionDescriptor[]> {
    const record = this.#requireInitialized();
    this.#requireSession(sessionId);
    return record.configOptions.map((option) => {
      const current = this.#configCurrent.get(option.id) ?? option.current;
      return { ...option, ...(current !== undefined ? { current } : {}) };
    });
  }

  async setConfigOption(input: SetConfigOptionInput): Promise<SetConfigOptionResult> {
    const record = this.#requireInitialized();
    requireCapability(record, 'setConfigOption');
    this.#requireSession(input.sessionId);
    this.#log.push({ op: 'setConfigOption', detail: { optionId: input.optionId, value: input.value } });
    const descriptor = record.configOptions.find((option) => option.id === input.optionId);
    if (descriptor === undefined) {
      throw new AdapterError('invalid_argument', `Unknown config option: ${input.optionId}`, {
        harnessId: this.harnessId,
      });
    }
    if (descriptor.values.length > 0 && !descriptor.values.includes(input.value)) {
      throw new AdapterError(
        'invalid_argument',
        `Value ${JSON.stringify(input.value)} not among advertised values for ${input.optionId}`,
        { harnessId: this.harnessId },
      );
    }
    if (this.#options.onSetConfigOption !== undefined) {
      return this.#options.onSetConfigOption(input);
    }
    this.#configCurrent.set(input.optionId, input.value);
    // §11.2 effective-value echo, observed.
    return { effectiveValue: input.value, echoed: true };
  }

  async resolvePermission(input: ResolvePermissionInput): Promise<void> {
    this.#requireInitialized();
    const session = this.#requireSession(input.sessionId);
    const turn = session.inFlight;
    if (turn === undefined || turn.pendingPermissionRequestId !== input.requestId) {
      throw new AdapterError(
        'invalid_state',
        `No pending permission request ${input.requestId} on session ${String(input.sessionId)}`,
        { harnessId: this.harnessId },
      );
    }
    this.#log.push({ op: 'resolvePermission', detail: { requestId: input.requestId, outcome: input.outcome.kind } });
    turn.pendingPermissionRequestId = undefined;
    if (input.outcome.kind === 'cancelled') {
      session.inFlight = undefined;
      turn.resolve({ stopReason: 'cancelled' });
      return;
    }
    this.#settleTurn(session, turn);
  }

  classifyError(raw: unknown): ErrorClassification {
    const overridden = this.#options.classifyOverride?.(raw);
    return overridden ?? referenceClassifyError(raw, this.#clock);
  }

  async close(): Promise<void> {
    if (this.#closed) return; // idempotent
    this.#closed = true;
    this.#log.push({ op: 'close' });
    for (const session of this.#sessions.values()) {
      const turn = session.inFlight;
      if (turn !== undefined) {
        session.inFlight = undefined;
        turn.reject(
          new AdapterError('unexpected_eof', 'Adapter closed with a turn in flight', {
            harnessId: this.harnessId,
          }),
        );
      }
    }
  }

  // ---- Internals ----------------------------------------------------------
  #settleTurn(session: FakeSessionState, turn: InFlightTurn): void {
    session.inFlight = undefined;
    const script = turn.script;
    if (script.errorEnvelope !== undefined) {
      turn.reject(
        new AdapterError('provider_error', 'Scripted provider error envelope', {
          harnessId: this.harnessId,
          envelope: script.errorEnvelope,
        }),
      );
    } else {
      turn.resolve(script.result ?? { stopReason: 'end_turn' });
    }
    const lateUpdates = script.lateUpdates ?? [];
    if (lateUpdates.length > 0 && turn.onUpdate !== undefined) {
      // Delivered behind a deep microtask chain so a caller awaiting the
      // prompt promise (including the async-method thenable-adoption ticks)
      // observes the RESULT first; the late updates then arrive on the CLOSED
      // turn's callback (§10.2, issue #864) and never crash anything. Still
      // no real timers — drain microtasks (or one macrotask) to observe.
      let chain: Promise<void> = Promise.resolve();
      for (let i = 0; i < 6; i += 1) chain = chain.then(() => undefined);
      void chain.then(() => {
        for (const update of lateUpdates) turn.onUpdate?.(update);
      });
    }
  }

  #requireOpen(): void {
    if (this.#closed) {
      throw new AdapterError('invalid_state', 'Adapter is closed', { harnessId: this.harnessId });
    }
  }

  #requireInitialized(): CapabilityRecord {
    this.#requireOpen();
    if (this.#capabilities === undefined) {
      throw new AdapterError('invalid_state', 'initialize() must complete before session operations', {
        harnessId: this.harnessId,
      });
    }
    return this.#capabilities;
  }

  #requireSession(sessionId: AcpSessionId): FakeSessionState {
    const session = this.#sessions.get(String(sessionId));
    if (session === undefined) {
      throw new AdapterError('session_not_found', `Unknown session: ${String(sessionId)}`, {
        harnessId: this.harnessId,
      });
    }
    return session;
  }

  #resumeSession(input: ResumeSessionInput): Promise<ResumeResult> {
    const record = this.#requireInitialized();
    requireCapability(record, 'resumeSession');
    this.#log.push({ op: 'resumeSession', detail: { acpSessionId: String(input.acpSessionId) } });
    const script =
      this.#options.resume === 'omit' || this.#options.resume === undefined
        ? ({ behavior: 'native', identityConfirmed: true } as const)
        : this.#options.resume;
    if (script.behavior === 'fail') {
      return Promise.reject(
        new AdapterError(script.errorKind, script.message ?? 'Scripted resume failure', {
          harnessId: this.harnessId,
        }),
      );
    }
    const handle = this.#loadable.get(String(input.acpSessionId));
    if (handle === undefined) {
      return Promise.reject(
        new AdapterError('session_not_found', `Unknown session: ${String(input.acpSessionId)}`, {
          harnessId: this.harnessId,
        }),
      );
    }
    if (
      input.expectedNativeSessionId !== undefined &&
      handle.nativeSessionId !== undefined &&
      String(handle.nativeSessionId) !== String(input.expectedNativeSessionId)
    ) {
      return Promise.reject(
        new AdapterError(
          'session_identity_mismatch',
          `Expected native session ${String(input.expectedNativeSessionId)}, found ${String(handle.nativeSessionId)}`,
          { harnessId: this.harnessId },
        ),
      );
    }
    if (!this.#sessions.has(String(input.acpSessionId))) {
      this.#sessions.set(String(input.acpSessionId), { handle, inFlight: undefined });
    }
    return Promise.resolve({
      resumed: script.behavior,
      identityConfirmed: script.identityConfirmed,
      session: handle,
    });
  }

  #forkSession(input: ForkSessionInput): Promise<SessionHandle> {
    const record = this.#requireInitialized();
    requireCapability(record, 'forkSession');
    const source = this.#loadable.get(String(input.acpSessionId));
    if (source === undefined) {
      return Promise.reject(
        new AdapterError('session_not_found', `Unknown session: ${String(input.acpSessionId)}`, {
          harnessId: this.harnessId,
        }),
      );
    }
    this.#sessionSeq += 1;
    const acpId = `fake_acp_sess_${String(this.#sessionSeq).padStart(6, '0')}`;
    const handle: SessionHandle = {
      acpSessionId: acpSessionId(acpId),
      ...(source.nativeSessionId !== undefined
        ? { nativeSessionId: nativeSessionId(`fake_native_sess_${String(this.#sessionSeq).padStart(6, '0')}`) }
        : {}),
    };
    this.#sessions.set(acpId, { handle, inFlight: undefined });
    this.#loadable.set(acpId, handle);
    this.#log.push({ op: 'forkSession', detail: { from: String(input.acpSessionId), to: acpId } });
    return Promise.resolve(handle);
  }
}

// ---------------------------------------------------------------------------
// Declarative turn-script builders (W2-7 scenario extensions)
// ---------------------------------------------------------------------------
/**
 * Turns for "the limit envelope lands on turn N": N-1 benign completed turns,
 * then the envelope (default: the Claude structured shape). Turn N > 1 proves
 * a mid-round pause AFTER completed work — the checkpoint must record the
 * interrupted turn honestly, never the completed ones as lost.
 */
export function limitOnTurnN(n: number, envelope?: unknown): InProcessTurnScript[] {
  if (!Number.isInteger(n) || n < 1) throw new Error(`limitOnTurnN: n must be a positive integer, got ${n}`);
  return [
    ...Array.from({ length: n - 1 }, (): InProcessTurnScript => ({})),
    { errorEnvelope: envelope ?? rateLimitErrorEnvelope() },
  ];
}

/**
 * W2-4 probe script "still-limited ×k → OK": the first k probe turns answer
 * with the limit envelope (each folds one T10 and schedules the next rung),
 * then a healthy turn resolves T9. One script entry per PROBE SESSION when
 * fed through a per-creation factory queue; as a single adapter's `turns`
 * when probes share the adapter.
 */
export function probeScriptStillLimitedThenOk(
  stillLimitedCount: number,
  envelope?: unknown,
): InProcessTurnScript[] {
  return [
    ...Array.from(
      { length: stillLimitedCount },
      (): InProcessTurnScript => ({ errorEnvelope: envelope ?? rateLimitErrorEnvelope() }),
    ),
    {},
  ];
}

/**
 * W2-4 probe script "non-limit auth failure → inconclusive": the probe turn
 * fails with the shared -32000 authRequired shape — classified `auth`,
 * which must land `limit.probe.inconclusive` (stays paused, automatic
 * probing STOPS, no T10, never the breaker).
 */
export function probeScriptAuthFailure(): InProcessTurnScript[] {
  return [{ errorEnvelope: authRequiredErrorEnvelope() }];
}
