/**
 * ACP session adapter (PLAN §10) — implements the §9 `HarnessAdapter` SPI on
 * top of the generic stdio transport (`transport.ts`):
 *
 * - `initialize()` runs the ACP handshake under the 15s bound, verifies the
 *   protocol version, checks the `HARNESS_SPAWN_ID` echo (§10.1), and probes
 *   capabilities — load/resume/fork/set_config_option/set_mode support are
 *   recorded into the §9 `CapabilityRecord` (§10.1 "initialize + capability
 *   probe").
 * - Session identity is confirmed on create/load: `session/new` must return a
 *   session id; `session/load` must succeed for the EXACT requested id (an id
 *   echo that differs is `session_identity_mismatch`, §11.1).
 * - Turn boundary = the `session/prompt` RESPONSE. `session/update`
 *   notifications arriving after the response are attributed to the closed
 *   turn and MUST NOT throw (§10.2, issue #864): they are routed to the
 *   closed turn's `onUpdate` (exceptions swallowed and counted), or counted
 *   as orphans when no turn ever ran for that session.
 * - Cancellation: `cancelTurn` delivers `session/cancel`, then escalates —
 *   cancel grace 3s → SIGTERM group → 2s → SIGKILL group (§10.2). A child
 *   that dies after a cancel was requested yields `stopReason:'cancelled'`
 *   (the authoritative prompt-promise signal), never a crash.
 * - Permission mediation engine (§10.2, T20): interactive callback surface
 *   (config handler or SPI `resolvePermission`) + headless policy allowlist
 *   with EXACT-operation match; default DENY, unknown-operation DENY, and
 *   Coordinator/Verifier WRITE requests always denied — in every mode.
 *
 * REAL wire shapes (P2 live gate, docs/reviews/p2-live-gate.md — pinned by
 * the offline fakes so TX-class regressions fail offline):
 * - TX-1: `session/new` AND `session/load` REQUIRE `mcpServers` (we send
 *   `[]`; D5 keeps MCP passthrough report-only) — both pinned adapters
 *   `-32602`-reject cwd-only params.
 * - TX-2: session config options arrive as `{id, name, category, type,
 *   currentValue, options:[{value,…}]}` (`parseConfigOptionsWire`).
 * - TX-3: the `session/set_config_option` wire param is `configId` (the SPI
 *   field stays `optionId`); TX-3b: the effective-value echo arrives via the
 *   response's `configOptions[].currentValue` (and, on Claude, a
 *   `config_option_update` session update) — §11.2 confirm-by-echo reads it.
 * - P-1: headless permission mediation is paired with NORMATIVE session-mode
 *   pinning at session setup (`SessionModePolicy`, per-role): adapter default
 *   modes (claude `auto`, codex `agent`) never consult the ACP permission
 *   channel, so T20 default-deny could not engage until the mode is pinned.
 *   Pin failure fails the session setup loudly — never a silent fallback to
 *   the permissive default mode.
 * - P-3: live `session/update` kinds `usage_update` (§17.2 accounting feed),
 *   `session_info_update`, `available_commands_update`, `user_message_chunk`,
 *   `config_option_update`, `current_mode_update` normalize into typed
 *   events; unknown kinds still pass through un-dropped.
 */
import { existsSync, realpathSync } from 'node:fs';
import * as path from 'node:path';
import type { AcpStopReason, TurnUsage } from '../../domain/entities.js';
import { acpSessionId, nativeSessionId, type AcpSessionId } from '../../domain/ids.js';
import type { RoleName } from '../../domain/state.js';
import { SystemClock, type Clock } from '../../lib/clock.js';
import type { IsoTimestamp } from '../../lib/clock.js';
import { referenceClassifyError } from '../fake/in-process.js';
import {
  AdapterError,
  UnsupportedCapabilityError,
  isAdapterError,
  providerEnvelopeOf,
  requireCapability,
  type AuthValidationEvidence,
  type AuthenticateInput,
  type CancelTurnInput,
  type CapabilityRecord,
  type ConfigOptionDescriptor,
  type CreateSessionInput,
  type ErrorClassification,
  type HarnessAdapter,
  type LoadSessionInput,
  type PermissionOption,
  type PermissionOptionKind,
  type PermissionOutcome,
  type PermissionRequest,
  type PromptDiagnostics,
  type ProbeResult,
  type PromptInput,
  type PromptResult,
  type ResolvePermissionInput,
  type SessionHandle,
  type SessionUpdate,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../spi.js';
import {
  AcpStdioTransport,
  type AcpSpawnSpec,
  type AcpTransportLimits,
  type ExitInfo,
  type JsonRpcErrorEnvelope,
  type StderrSnapshot,
} from './transport.js';

// ---------------------------------------------------------------------------
// Permission mediation (PLAN §10.2, T20)
// ---------------------------------------------------------------------------
/**
 * Headless allowlist: exact operation strings (matched against the request's
 * tool title), plus an optional trusted provider-specific read-only
 * classifier. No globs or substring matching — anything else is DENIED.
 */
export interface HeadlessPermissionPolicy {
  readonly allow: readonly string[];
  /**
   * Optional fail-closed classifier for provider operation titles that can be
   * proven read-only after parsing. The harness supplies this only for Grok's
   * implementor `Execute` requests; a false result or throw is a denial.
   *
   * Title-only by design: binding the title to the EXECUTED payload is
   * `verifyOperationPayload`'s job, because that binding must gate every
   * approval path, not just this one.
   */
  readonly allowReadOnlyOperation?: (operation: string) => boolean;
  /**
   * Optional canonical workspace boundary for structured path-qualified
   * `Write` / `Edit` operations. Shell-shaped or unparseable operations never
   * match. The provider factory enables this only for the Grok implementor.
   */
  readonly workspaceWriteRoot?: string;
}

/**
 * HIGH-5 — a VETO consulted before EVERY approval, in EVERY mediation mode.
 *
 * A permission TITLE is human-readable prose the provider composes; ACP
 * `rawInput` is the payload it EXECUTES. Approving on the title alone authorizes
 * a string nothing runs. This lives on the config ROOT, not on the headless
 * policy, because it is not an allowlist concern: it is a precondition of any
 * approval. Round 4 placed it on the headless policy and evaluated it after the
 * interactive branch had already returned, so an interactive decider could
 * forward a `selected` option for an unbound payload.
 *
 * Return false to REFUSE an approval that would otherwise be granted; a THROW is
 * likewise a refusal. Return true only when there is genuinely nothing to bind.
 */
export type VerifyOperationPayload = (operation: string | undefined, rawInput: unknown) => boolean;

export type PermissionMediationConfig =
  | {
      readonly mode: 'interactive';
      readonly role?: RoleName;
      readonly verifyOperationPayload?: VerifyOperationPayload;
      /**
       * Interactive surface. When present, invoked per request (the outcome
       * is forwarded to the agent). When absent, the request is surfaced via
       * the update stream and WAITS for SPI `resolvePermission`.
       */
      readonly handler?: (request: PermissionRequest) => Promise<PermissionOutcome>;
    }
  | {
      readonly mode: 'headless';
      readonly role?: RoleName;
      readonly verifyOperationPayload?: VerifyOperationPayload;
      /** Omitted policy = empty allowlist = default DENY everything. */
      readonly policy?: HeadlessPermissionPolicy;
    };

export type PermissionDecisionReason =
  | 'allowlisted'
  | 'allowlisted_read_only_operation'
  | 'interactive'
  | 'allowlisted_workspace_write'
  | 'denied_default'
  | 'denied_unknown_operation'
  | 'denied_role_write'
  /** HIGH-5: the operation would otherwise have been approved, but the payload
   * the provider will actually EXECUTE could not be bound to its title. */
  | 'denied_raw_input_mismatch';

export interface PermissionDecision {
  readonly action: 'allow' | 'deny' | 'interactive';
  readonly reason: PermissionDecisionReason;
}

/**
 * Conservative write classifier: an operation is a WRITE unless its title
 * clearly names a read-only verb. Unknown/absent titles are writes. This
 * feeds the §10.2 rule "Coordinator/Verifier writes always denied" — the
 * conservative direction (false-positive write → deny) is the safe one.
 */
const READ_ONLY_OPERATION_RE =
  /^(read|list|view|get|stat|search|grep|glob|find|fetch|inspect|show|cat)\b/i;

export function isWriteOperation(operation: string | undefined): boolean {
  if (operation === undefined || operation.trim() === '') return true;
  return !READ_ONLY_OPERATION_RE.test(operation);
}

function isPathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function nearestExistingAncestor(candidate: string): string | undefined {
  let current = candidate;
  for (;;) {
    if (existsSync(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Grok's ACP permission title for a structured edit is path-qualified rather
 * than a stable tool id. Accept only the two observed structured verbs, one
 * absolute backtick-delimited path, and a target whose nearest existing
 * ancestor resolves inside the canonical assigned worktree. This rejects
 * traversal and symlink escapes before Grok's process sandbox independently
 * enforces the same workspace boundary.
 */
export function isWorkspaceWriteOperation(
  operation: string | undefined,
  workspaceRoot: string,
): boolean {
  if (operation === undefined) return false;
  const match = /^(?:Write|Edit) `([^`\r\n]+)`$/.exec(operation.trim());
  if (match === null) return false;
  const requested = match[1];
  if (requested === undefined || !path.isAbsolute(requested)) return false;
  try {
    const realRoot = realpathSync(workspaceRoot);
    const ancestor = nearestExistingAncestor(requested);
    if (ancestor === undefined) return false;
    return isPathInside(realRoot, realpathSync(ancestor));
  } catch {
    return false;
  }
}

/**
 * Decision core (unit-testable): §10.2 — interactive → surface;
 * headless → allowlist EXACT match else deny; unknown → deny;
 * coordinator/verifier write requests ALWAYS denied (every mode).
 */
export function decidePermission(
  config: PermissionMediationConfig,
  operation: string | undefined,
  /** HIGH-5: the tool call's `rawInput` — what the provider will actually
   * execute. The read-only classifier is never consulted without it. */
  rawInput?: unknown,
): PermissionDecision {
  const role = config.role;
  if ((role === 'coordinator' || role === 'verifier') && isWriteOperation(operation)) {
    return { action: 'deny', reason: 'denied_role_write' };
  }
  // HIGH-5 (round 5): the payload binding runs BEFORE ANY MEDIATION BRANCH.
  // Round 4 evaluated it only after the interactive branch had returned, so an
  // interactive decider — or a configured handler — could forward a `selected`
  // option for a payload never bound to its title. Every path that can end in an
  // approval now passes through here first, headless and interactive alike. A
  // throw is a refusal: a veto that cannot run must never widen a decision.
  //
  // The operation is passed through even when undefined/empty: deciding whether
  // an unreadable title is "not a shell request" or "a shell request we cannot
  // read" is the veto's job, not this function's (see
  // `grokShellPayloadMatchesTitle`).
  if (config.verifyOperationPayload !== undefined) {
    let vetoed: boolean;
    try {
      vetoed = config.verifyOperationPayload(operation, rawInput) !== true;
    } catch {
      vetoed = true;
    }
    if (vetoed) return { action: 'deny', reason: 'denied_raw_input_mismatch' };
  }
  if (config.mode === 'interactive') {
    return { action: 'interactive', reason: 'interactive' };
  }
  if (operation === undefined || operation.trim() === '') {
    return { action: 'deny', reason: 'denied_unknown_operation' };
  }
  if ((config.policy?.allow ?? []).includes(operation)) {
    return { action: 'allow', reason: 'allowlisted' };
  }
  try {
    if (config.policy?.allowReadOnlyOperation?.(operation) === true) {
      return { action: 'allow', reason: 'allowlisted_read_only_operation' };
    }
  } catch {
    // A classifier failure must never widen a headless permission decision.
  }
  if (
    role === 'implementor' &&
    config.policy?.workspaceWriteRoot !== undefined &&
    isWorkspaceWriteOperation(operation, config.policy.workspaceWriteRoot)
  ) {
    return { action: 'allow', reason: 'allowlisted_workspace_write' };
  }
  return { action: 'deny', reason: 'denied_default' };
}

/** Audit record of one mediated permission request (observable in tests). */
export interface PermissionDecisionRecord {
  readonly requestId: string;
  readonly sessionId: string;
  readonly operation: string | undefined;
  readonly action: 'allow' | 'deny' | 'interactive';
  readonly reason: PermissionDecisionReason;
  /** The ACP option actually answered; undefined = cancelled outcome. */
  readonly optionId: string | undefined;
  readonly at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// Session-mode pinning (P2 live gate P-1 — NORMATIVE part of session setup)
// ---------------------------------------------------------------------------
/** How a mode pin crosses the wire (both live-verified in the P2 gate). */
export type SessionModeMechanism = 'session_set_mode' | 'session_set_config_option';

export interface SessionModePin {
  readonly mechanism: SessionModeMechanism;
  /** Config option id when mechanism='session_set_config_option' (default 'mode'). */
  readonly optionId?: string;
  /** Mode id (`session/set_mode`) or option value (`session/set_config_option`). */
  readonly value: string;
}

/**
 * Per-role session-mode policy (P-1): applied immediately after `session/new`
 * AND `session/load`, BEFORE the session handle is returned. Provider
 * profiles supply the per-role pins (claude: `session/set_mode` `'default'`
 * for every role — never `'auto'`; codex: config option `mode` =
 * `'read-only'` for coordinator/verifier, workspace-write `'agent'` only for
 * the implementor). A configured pin that cannot be applied FAILS the session
 * setup — the permissive adapter default mode is never silently kept.
 */
export interface SessionModePolicy {
  readonly byRole: Readonly<Partial<Record<RoleName, SessionModePin>>>;
  /** Applied when no role is configured or the role has no entry (safe default). */
  readonly defaultPin?: SessionModePin;
}

/** Pure pin resolution: the role's own pin, else the policy's safe default. */
export function resolveModePin(
  policy: SessionModePolicy,
  role: RoleName | undefined,
): SessionModePin | undefined {
  return (role !== undefined ? policy.byRole[role] : undefined) ?? policy.defaultPin;
}

/** Audit record of one applied mode pin (session lineage surface). */
export interface SessionModePinRecord {
  readonly sessionId: string;
  readonly role: RoleName | undefined;
  readonly mechanism: SessionModeMechanism;
  readonly optionId?: string;
  readonly value: string;
  /** true when an effective-value echo CONFIRMED the pin (§11.2-style). */
  readonly echoed: boolean;
  readonly at: IsoTimestamp;
}

const PERMISSION_OPTION_KINDS: readonly PermissionOptionKind[] = [
  'allow_once',
  'allow_always',
  'reject_once',
  'reject_always',
];

function pickOption(
  options: readonly PermissionOption[],
  preference: readonly PermissionOptionKind[],
): PermissionOption | undefined {
  for (const kind of preference) {
    const found = options.find((option) => option.kind === kind);
    if (found !== undefined) return found;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Capability probe surface (§10.1: "initialize capability probe (records
// fork/resume/config-option/mode support)")
// ---------------------------------------------------------------------------
export interface AcpProbedCapabilities {
  readonly load: boolean;
  readonly resume: boolean;
  readonly fork: boolean;
  readonly setConfigOption: boolean;
  readonly setMode: boolean;
  /** Whether the initialize result echoed our HARNESS_SPAWN_ID (§10.1). */
  readonly spawnIdEchoed: boolean;
  /**
   * Auth-method ids the agent advertised at initialize (H-2). Live gate:
   * codex-acp@1.1.4 advertises `['api-key', 'chat-gpt']` (plus `gateway`
   * behind a client capability). Feeds the SPI `authenticate` seam — never
   * auth READINESS, which requires turn evidence (§17.1 H-2).
   */
  readonly authMethods: readonly string[];
}

export const ACP_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface AcpAdapterOptions {
  readonly harnessId: string;
  readonly spawn: AcpSpawnSpec;
  readonly clock?: Clock;
  readonly spawnId?: string;
  readonly limits?: Partial<AcpTransportLimits>;
  readonly permissions?: PermissionMediationConfig;
  /**
   * P-1 (normative): per-role session-mode pinning applied as part of
   * `createSession`/`loadSession`. The pin for `permissions.role` (else
   * `defaultPin`) is sent immediately after the session exists; failure to
   * pin fails the session setup. Omitted = no pinning (bare-transport tests
   * only — the provider factories always configure it).
   */
  readonly sessionMode?: SessionModePolicy;
  readonly protocolVersion?: number;
  /**
   * Per-harness profile layering (Claude/Codex profiles set auth readiness,
   * usage-limit reporting tiers, conflicting builtin tools, …) merged over
   * the probed record. The transport-probed fields stay authoritative for
   * what was actually observed on the wire — `src/adapters/factory.ts`
   * (the composition seam) passes ONLY provider-static fields here.
   */
  readonly capabilityOverrides?: Partial<CapabilityRecord>;
  /**
   * Provider-specific fail-closed validation over the initialize result.
   * Used when an ACP extension can expose executable host configuration that
   * the base protocol does not model (for example Grok's `_meta.mcpServers`).
   * The callback must never include raw credential-bearing payloads in a
   * thrown message.
   */
  readonly initializeGuard?: (result: unknown) => void;
  /**
   * Provider-specific fail-closed validation over non-core notifications.
   * A rejection terminates the transport instead of letting an extension
   * silently widen the orchestrator's tool boundary.
   */
  readonly notificationGuard?: (method: string, params: unknown) => void;
  /**
   * Provider-specific §13 classifier (Claude/Codex profiles supply
   * `classifyClaudeError`/`classifyCodexError`). Defaults to the reference
   * classifier. Same contract either way: envelopes ONLY, pure, and
   * unrecognizable input maps to `unknown_provider_error` (§9).
   */
  readonly classifyError?: (raw: unknown, clock: Clock) => ErrorClassification;
  /**
   * Invoked exactly once by `close()` after the transport is closed —
   * lifecycle hook for factory-owned resources tied to this child (§17.1
   * H-1: disposing the per-run isolated `CODEX_HOME`, which carries copied
   * auth material). Failures are swallowed: disposal must never break close.
   */
  readonly onClose?: () => void | Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal turn/permission state
// ---------------------------------------------------------------------------
interface ActiveTurn {
  readonly sessionId: string;
  readonly onUpdate: ((update: SessionUpdate) => void) | undefined;
  cancelRequested: boolean;
  settled: boolean;
  graceTimer?: NodeJS.Timeout;
}

interface PendingPermission {
  readonly jsonrpcId: number | string;
  readonly sessionId: string;
  readonly request: PermissionRequest;
  readonly operation: string | undefined;
}

/** Per-session wire-observed state (config options + mode state, mutable —
 * refreshed by set_config_option echoes and *_update notifications). */
interface SessionState {
  configOptions: readonly ConfigOptionDescriptor[];
  availableModeIds: readonly string[];
  currentModeId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const ACP_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'max_tokens',
  'max_turn_requests',
  'refusal',
  'cancelled',
]);

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------
export class AcpStdioAdapter implements HarnessAdapter {
  readonly harnessId: string;
  // NOTE (§9): `resumeSession`/`forkSession` are deliberately NOT members —
  // core ACP has no native fast-resume or fork; `session/load` (the replay
  // path) is `loadSession`. Their advertised support is still probed and
  // recorded (capability report only).

  readonly #options: AcpAdapterOptions;
  readonly #clock: Clock;
  #transport: AcpStdioTransport | undefined;
  #capabilities: CapabilityRecord | undefined;
  #probed: AcpProbedCapabilities | undefined;
  #closed = false;

  readonly #sessions = new Map<string, SessionState>();
  #activeTurn: ActiveTurn | undefined;
  readonly #closedTurnUpdate = new Map<string, ((update: SessionUpdate) => void) | undefined>();
  readonly #pendingPermissions = new Map<string, PendingPermission>();
  #permissionSeq = 0;

  // Diagnostics (§10.2: late updates must never crash projections).
  #orphanUpdateCount = 0;
  #callbackErrorCount = 0;
  readonly #permissionDecisions: PermissionDecisionRecord[] = [];
  readonly #modePins: SessionModePinRecord[] = [];
  #lastObserved: { acpSessionId?: string; nativeSessionId?: string } = {};
  // H-2 auth evidence (§17.1): the only source that may ever produce a
  // `supported` auth readiness is `validatedTurnAt` — a recorded successful
  // provider turn on THIS child. `authFailureAt` records auth-classified
  // provider failures (e.g. a live 401). ACP `authenticate` acceptance is
  // deliberately NOT tracked here (accepted-in-3ms ≠ valid — live-proven).
  #authEvidence: { validatedTurnAt?: IsoTimestamp; authFailureAt?: IsoTimestamp } = {};
  #onCloseRan = false;

  constructor(options: AcpAdapterOptions) {
    this.harnessId = options.harnessId;
    this.#options = options;
    this.#clock = options.clock ?? new SystemClock();
  }

  // ---- Introspection -------------------------------------------------------
  get permissionDecisions(): readonly PermissionDecisionRecord[] {
    return this.#permissionDecisions;
  }

  /** P-1 audit: every session-mode pin applied at setup (lineage surface). */
  get modePins(): readonly SessionModePinRecord[] {
    return this.#modePins;
  }

  get orphanUpdateCount(): number {
    return this.#orphanUpdateCount;
  }

  get callbackErrorCount(): number {
    return this.#callbackErrorCount;
  }

  get probedCapabilities(): AcpProbedCapabilities | undefined {
    return this.#probed;
  }

  /** H-2 evidence surface: what this child has actually PROVEN about auth
   * (see `deriveAuthReadiness`; feeds `probe*AuthReadiness` evidence). */
  get authEvidence(): AuthValidationEvidence {
    return { ...this.#authEvidence };
  }

  get exitInfo(): ExitInfo | undefined {
    return this.#transport?.exitInfo;
  }

  get transportPid(): number | undefined {
    return this.#transport?.pid;
  }

  /** The §10.1 `HARNESS_SPAWN_ID` identity nonce this child was stamped with
   * (W2-6: feeds the §14 `ProcessIdentity` capture); undefined until
   * `initialize()` constructed the transport. */
  get transportSpawnId(): string | undefined {
    return this.#transport?.spawnId;
  }

  stderrSnapshot(): StderrSnapshot | undefined {
    return this.#transport?.stderrSnapshot();
  }

  // ---- SPI: probe ----------------------------------------------------------
  async probe(): Promise<ProbeResult> {
    const command = this.#options.spawn.command;
    const isPathLike = command.includes(path.sep);
    const exists = isPathLike ? existsSync(command) : true; // PATH-resolved: optimistic
    const issues: string[] = [];
    if (isPathLike && !exists) issues.push(`executable not found: ${command}`);
    return {
      harnessId: this.harnessId,
      available: exists,
      executable: { version: 'unknown', resolvedPath: command },
      protocol: { name: 'acp', version: String(this.#options.protocolVersion ?? ACP_PROTOCOL_VERSION) },
      auth: 'unknown',
      issues,
    };
  }

  // ---- SPI: initialize (spawn + handshake + capability probe) --------------
  async initialize(): Promise<CapabilityRecord> {
    this.#requireOpen();
    if (this.#transport !== undefined) {
      throw new AdapterError('invalid_state', 'initialize() already ran', {
        harnessId: this.harnessId,
      });
    }
    const transport = new AcpStdioTransport({
      harnessId: this.harnessId,
      spawn: this.#options.spawn,
      ...(this.#options.spawnId !== undefined ? { spawnId: this.#options.spawnId } : {}),
      ...(this.#options.limits !== undefined ? { limits: this.#options.limits } : {}),
    });
    this.#transport = transport;
    transport.onNotification((method, params) => this.#onNotification(method, params));
    transport.onIncomingRequest((id, method, params) => this.#onIncomingRequest(id, method, params));

    await transport.start();

    const expectedVersion = this.#options.protocolVersion ?? ACP_PROTOCOL_VERSION;
    const raw = await transport.request(
      'initialize',
      {
        protocolVersion: expectedVersion,
        clientInfo: { name: 'harness-orchestration', version: '0.1.0' },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      },
      { timeoutMs: transport.limits.handshakeTimeoutMs, timeoutKind: 'handshake' },
    );

    const result = asRecord(raw) ?? {};
    try {
      this.#options.initializeGuard?.(result);
    } catch (cause) {
      const error = isAdapterError(cause)
        ? cause
        : new AdapterError('invalid_argument', 'Provider initialize metadata violated adapter policy', {
            harnessId: this.harnessId,
            cause,
          });
      transport.fail(error);
      throw error;
    }
    const advertisedVersion = result['protocolVersion'];
    if (advertisedVersion !== expectedVersion) {
      const error = new AdapterError(
        'protocol_version_mismatch',
        `Agent advertised protocol version ${String(advertisedVersion)}, expected ${expectedVersion} (§10.2)`,
        { harnessId: this.harnessId },
      );
      transport.fail(error); // terminal event + group cleanup
      throw error;
    }

    // §10.1 identity nonce echo: absent is tolerated (recorded), a DIFFERENT
    // echo means we are talking to a process we did not spawn — terminal.
    const meta = asRecord(result['_meta']);
    const echoedSpawnId = meta?.['spawnId'];
    const spawnIdEchoed = typeof echoedSpawnId === 'string' && echoedSpawnId.length > 0;
    if (spawnIdEchoed && echoedSpawnId !== transport.spawnId) {
      const error = new AdapterError(
        'internal',
        `Spawn identity nonce mismatch: expected ${transport.spawnId}, got ${String(echoedSpawnId)} (§10.1)`,
        { harnessId: this.harnessId },
      );
      transport.fail(error);
      throw error;
    }

    const agentCapabilities = asRecord(result['agentCapabilities']) ?? {};
    const sessionCapabilities = asRecord(agentCapabilities['sessionCapabilities']) ?? {};
    // P-2 (live gate): ACP's capability convention is presence-based — both
    // pinned adapters advertise sessionCapabilities entries as EMPTY OBJECTS
    // `{}` (omitted/null = unsupported). `true` and any object count as
    // advertised; false/null/undefined do not.
    const advertised = (...values: unknown[]): boolean =>
      values.some((value) => value === true || (typeof value === 'object' && value !== null));
    // H-2: record the advertised auth-method ids (codex-acp live:
    // `api-key`/`chat-gpt`) for the SPI `authenticate` seam.
    const authMethodsRaw = Array.isArray(result['authMethods']) ? result['authMethods'] : [];
    const authMethods = authMethodsRaw.flatMap((method) => {
      const record = asRecord(method);
      return record !== undefined && typeof record['id'] === 'string' ? [record['id']] : [];
    });
    const probed: AcpProbedCapabilities = {
      load: advertised(agentCapabilities['loadSession'], sessionCapabilities['load']),
      resume: advertised(agentCapabilities['resumeSession'], sessionCapabilities['resume']),
      fork: advertised(agentCapabilities['forkSession'], sessionCapabilities['fork']),
      setConfigOption: advertised(
        agentCapabilities['setSessionConfigOption'],
        agentCapabilities['sessionConfigOptions'],
        sessionCapabilities['setConfigOption'],
        sessionCapabilities['configOptions'],
      ),
      setMode: advertised(
        agentCapabilities['setSessionMode'],
        agentCapabilities['sessionModes'],
        sessionCapabilities['setMode'],
        sessionCapabilities['modes'],
      ),
      spawnIdEchoed,
      authMethods,
    };
    this.#probed = probed;

    const agentInfo = asRecord(result['agentInfo']);
    const record: CapabilityRecord = {
      harnessId: this.harnessId,
      protocol: { name: 'acp', version: String(expectedVersion) },
      executable: {
        ...(typeof agentInfo?.['name'] === 'string' ? { packageName: agentInfo['name'] } : {}),
        version: typeof agentInfo?.['version'] === 'string' ? agentInfo['version'] : 'unknown',
        resolvedPath: this.#options.spawn.command,
      },
      auth: 'unknown',
      sessionOps: {
        create: true, // session/new is core ACP
        load: probed.load,
        resume: probed.resume,
        fork: probed.fork,
        cancel: true, // session/cancel is core ACP
      },
      configOptions: [],
      modelMechanism: probed.setConfigOption ? 'session_set_config_option' : 'unsupported',
      permissionRequests: true, // session/request_permission is core ACP
      mcpConfig: { supported: false, reportOnly: true }, // D5: report-only
      checkpointExport: false,
      usageLimitReporting: 'none',
      retryAfterTier: 'forecast_only',
      usageAccounting: 'none',
      conflictingBuiltinTools: [],
      sessionIdentity: {
        exposesNativeSessionId: false,
        confirmsIdentityOnResume: probed.load,
      },
      probedAt: this.#clock.nowIso(),
      ...this.#options.capabilityOverrides,
    };
    this.#capabilities = record;
    return record;
  }

  // ---- SPI: sessions -------------------------------------------------------
  async createSession(input: CreateSessionInput): Promise<SessionHandle> {
    const { record, transport } = this.#requireInitialized();
    requireCapability(record, 'createSession');
    // TX-1 (live gate): `mcpServers` is wire-REQUIRED — both pinned adapters
    // `-32602`-reject cwd-only params. We send the empty list (D5: MCP
    // passthrough is report-only in the MVP).
    const raw = await transport.request('session/new', { cwd: input.cwd, mcpServers: [] });
    const result = asRecord(raw) ?? {};
    const id = result['sessionId'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new AdapterError('internal', 'session/new returned no sessionId (identity unconfirmed)', {
        harnessId: this.harnessId,
      });
    }
    this.#sessions.set(id, sessionStateFrom(result));
    this.#lastObserved = { ...this.#lastObserved, acpSessionId: id };
    // P-1 (normative): pin the session mode BEFORE the handle is usable. A
    // failed pin makes the session unusable — it is dropped so no later
    // operation can run it in the permissive default mode.
    try {
      await this.#pinSessionMode(id);
    } catch (error) {
      this.#sessions.delete(id);
      throw error;
    }
    const meta = asRecord(result['_meta']);
    const native = meta?.['nativeSessionId'];
    if (typeof native === 'string' && native.length > 0) {
      this.#lastObserved = { ...this.#lastObserved, nativeSessionId: native };
      return { acpSessionId: acpSessionId(id), nativeSessionId: nativeSessionId(native) };
    }
    return { acpSessionId: acpSessionId(id) };
  }

  async loadSession(input: LoadSessionInput): Promise<SessionHandle> {
    const { record, transport } = this.#requireInitialized();
    requireCapability(record, 'loadSession');
    const requested = String(input.acpSessionId);
    let raw: unknown;
    try {
      // TX-1: `session/load` requires `mcpServers` exactly like `session/new`.
      raw = await transport.request('session/load', {
        sessionId: requested,
        cwd: input.cwd,
        mcpServers: [],
      });
    } catch (error) {
      throw this.#mapMethodNotFound(error, 'loadSession');
    }
    const result = asRecord(raw) ?? {};
    const echoed = result['sessionId'];
    if (typeof echoed === 'string' && echoed.length > 0 && echoed !== requested) {
      // §11.1: adapter confirmed a DIFFERENT identity than expected.
      throw new AdapterError(
        'session_identity_mismatch',
        `session/load echoed ${echoed}, expected ${requested}`,
        { harnessId: this.harnessId },
      );
    }
    // Identity basis: the agent accepted a load of the EXACT requested id.
    this.#sessions.set(requested, sessionStateFrom(result));
    this.#lastObserved = { ...this.#lastObserved, acpSessionId: requested };
    // P-1: loaded sessions are pinned exactly like fresh ones; a failed pin
    // drops the session so it can never run in the permissive default mode.
    try {
      await this.#pinSessionMode(requested);
    } catch (error) {
      this.#sessions.delete(requested);
      throw error;
    }
    return { acpSessionId: acpSessionId(requested) };
  }

  // ---- SPI: authenticate (H-2 seam) ----------------------------------------
  /**
   * ACP `authenticate {methodId}` (H-2: the SPI can authenticate an isolated
   * child explicitly — proven live for `api-key` in 3ms through this exact
   * transport). Contract notes (source-verified against codex-acp@1.1.4):
   * - Resolution = ACP-level ACCEPTANCE only. It NEVER upgrades auth
   *   readiness and NEVER touches `authEvidence` — the accepted `api-key`
   *   401'd on the next live turn (docs/reviews/p2-live-gate.md, H-2 probe).
   * - `chat-gpt` is a VERIFY-or-INITIATE method: with a ChatGPT login already
   *   in `$CODEX_HOME/auth.json` it returns immediately (`accountRead`), but
   *   WITHOUT one it starts a browser OAuth flow (`accountLogin` +
   *   `open(authUrl)`) — headless callers must not invoke it speculatively.
   *   The factory therefore never auto-calls this method; inherited ChatGPT
   *   login rides the isolated home's `auth.json` instead (§17.1 H-1).
   * - Rejection surfaces as `AdapterError{kind:'provider_error'}` with the
   *   agent's envelope (codex-acp answers a failed authenticate with
   *   `RequestError.invalidParams()`).
   */
  async authenticate(input: AuthenticateInput): Promise<void> {
    const { transport } = this.#requireInitialized();
    await transport.request('authenticate', { methodId: input.methodId });
  }

  // ---- SPI: prompt turn ----------------------------------------------------
  async prompt(input: PromptInput): Promise<PromptResult> {
    const { transport } = this.#requireInitialized();
    const sessionKey = String(input.sessionId);
    this.#requireSession(sessionKey);
    if (this.#activeTurn !== undefined) {
      throw new AdapterError('invalid_state', 'At most one in-flight prompt per session (§6.2)', {
        harnessId: this.harnessId,
      });
    }
    const turn: ActiveTurn = {
      sessionId: sessionKey,
      onUpdate: input.onUpdate,
      cancelRequested: false,
      settled: false,
    };
    this.#activeTurn = turn;
    try {
      const raw = await transport.request(
        'session/prompt',
        { sessionId: sessionKey, prompt: [{ type: 'text', text: input.prompt }] },
        { timeoutMs: transport.limits.turnTimeoutMs, timeoutKind: 'turn' },
      );
      const result = asRecord(raw) ?? {};
      const stopReasonRaw = result['stopReason'];
      if (typeof stopReasonRaw !== 'string' || !ACP_STOP_REASONS.has(stopReasonRaw)) {
        throw new AdapterError(
          'internal',
          `session/prompt returned an unknown stopReason: ${String(stopReasonRaw)}`,
          { harnessId: this.harnessId },
        );
      }
      const usage = this.#usageFrom(result);
      // H-2 validated-turn evidence: a non-cancelled settled turn means the
      // provider actually served this child (a cancelled turn may have
      // settled before any provider round-trip — conservative exclusion).
      if (stopReasonRaw !== 'cancelled' && this.#authEvidence.validatedTurnAt === undefined) {
        this.#authEvidence = { ...this.#authEvidence, validatedTurnAt: this.#clock.nowIso() };
      }
      const diagnostics =
        stopReasonRaw !== 'end_turn' ? this.#promptDiagnostics(transport) : undefined;
      return {
        stopReason: stopReasonRaw as AcpStopReason,
        ...(usage !== undefined ? { usage } : {}),
        ...(diagnostics !== undefined ? { diagnostics } : {}),
      };
    } catch (error) {
      // A child that stops (EOF) after cancellation was requested is the
      // ESCALATION path completing, not a crash: the authoritative signal is
      // a cancelled turn (§10.2; SPI cancelTurn contract).
      if (
        turn.cancelRequested &&
        isAdapterError(error) &&
        (error.kind === 'unexpected_eof' || error.kind === 'queue_overflow')
      ) {
        const diagnostics = this.#promptDiagnostics(transport);
        return {
          stopReason: 'cancelled',
          ...(diagnostics !== undefined ? { diagnostics } : {}),
        };
      }
      // H-2 auth-failure evidence: a provider envelope this profile's own
      // classifier calls `auth` (codex live: -32000 authRequired / 401) is
      // recorded so readiness can honestly report detected_but_unsupported.
      if (isAdapterError(error) && error.kind === 'provider_error') {
        const envelope = providerEnvelopeOf(error);
        if (this.classifyError(envelope ?? error).kind === 'auth') {
          this.#authEvidence = { ...this.#authEvidence, authFailureAt: this.#clock.nowIso() };
        }
      }
      throw error;
    } finally {
      turn.settled = true;
      if (turn.graceTimer !== undefined) clearTimeout(turn.graceTimer);
      this.#activeTurn = undefined;
      // Late updates are attributed to this now-closed turn (§10.2, #864).
      this.#closedTurnUpdate.set(sessionKey, turn.onUpdate);
      this.#dropPendingPermissions(sessionKey);
    }
  }

  #promptDiagnostics(transport: AcpStdioTransport): PromptDiagnostics | undefined {
    const stderr = transport.stderrSnapshot();
    const childExit = transport.exitInfo;
    if (stderr.totalBytes === 0 && childExit === undefined) return undefined;
    return {
      ...(stderr.totalBytes > 0 ? { stderr } : {}),
      ...(childExit !== undefined ? { childExit } : {}),
    };
  }

  async cancelTurn(input: CancelTurnInput): Promise<void> {
    const { transport } = this.#requireInitialized();
    const sessionKey = String(input.sessionId);
    this.#requireSession(sessionKey);
    const turn = this.#activeTurn;
    if (turn === undefined || turn.sessionId !== sessionKey || turn.settled) {
      return; // idempotent: nothing in flight
    }
    turn.cancelRequested = true;
    // Answer any permission request the agent is blocked on as cancelled so
    // the cancel can take effect during permission-wait (§10.2, test 7).
    for (const [requestId, pending] of [...this.#pendingPermissions]) {
      if (pending.sessionId !== sessionKey) continue;
      this.#pendingPermissions.delete(requestId);
      transport.respond(pending.jsonrpcId, { result: { outcome: { outcome: 'cancelled' } } });
    }
    transport.notify('session/cancel', { sessionId: sessionKey });
    // §10.2 cancel grace 3s, then the transport's terminate ladder
    // (SIGTERM → 2s → SIGKILL, process group).
    turn.graceTimer = setTimeout(() => {
      if (!turn.settled) {
        void transport.terminate().catch(() => {
          /* reaped via fail/exit paths */
        });
      }
    }, transport.limits.cancelGraceMs);
  }

  // ---- SPI: config options -------------------------------------------------
  async listConfigOptions(sessionId: AcpSessionId): Promise<readonly ConfigOptionDescriptor[]> {
    this.#requireInitialized();
    const session = this.#requireSession(String(sessionId));
    return session.configOptions;
  }

  async setConfigOption(input: SetConfigOptionInput): Promise<SetConfigOptionResult> {
    const { record, transport } = this.#requireInitialized();
    requireCapability(record, 'setConfigOption');
    const session = this.#requireSession(String(input.sessionId));
    let raw: unknown;
    try {
      // TX-3 (live gate): the wire param is `configId` — both pinned adapters
      // `-32602`-reject `optionId`.
      raw = await transport.request('session/set_config_option', {
        sessionId: String(input.sessionId),
        configId: input.optionId,
        value: input.value,
      });
    } catch (error) {
      throw this.#mapMethodNotFound(error, 'setConfigOption');
    }
    const result = asRecord(raw) ?? {};
    // TX-3b/§11.2 confirm-by-echo: the effective value arrives via the
    // response's refreshed `configOptions[].currentValue` (both adapters) —
    // NOT a `result.value` field. The refreshed set replaces our view.
    const echoedOptions = parseConfigOptionsWire(result['configOptions']);
    if (echoedOptions.length > 0) {
      session.configOptions = echoedOptions;
      const current = echoedOptions.find((option) => option.id === input.optionId)?.current;
      if (current !== undefined) {
        return { effectiveValue: current, echoed: true };
      }
    }
    // Tolerated legacy/simple echo shape.
    const echoedValue = result['value'];
    if (typeof echoedValue === 'string' && echoedValue.length > 0) {
      return { effectiveValue: echoedValue, echoed: true };
    }
    // §11.2: no effective-value echo OBSERVED — report it honestly.
    return { effectiveValue: input.value, echoed: false };
  }

  // ---- SPI: permissions ----------------------------------------------------
  async resolvePermission(input: ResolvePermissionInput): Promise<void> {
    const { transport } = this.#requireInitialized();
    const pending = this.#pendingPermissions.get(input.requestId);
    if (pending === undefined || pending.sessionId !== String(input.sessionId)) {
      throw new AdapterError(
        'invalid_state',
        `No pending permission request ${input.requestId} on session ${String(input.sessionId)}`,
        { harnessId: this.harnessId },
      );
    }
    this.#pendingPermissions.delete(input.requestId);
    this.#respondPermission(pending, input.outcome, 'interactive', 'interactive');
  }

  // ---- SPI: classification -------------------------------------------------
  classifyError(raw: unknown): ErrorClassification {
    // §9/§13: envelopes ONLY; every classifier (provider-specific via
    // options, or the reference default) maps ANY string (i.e. agent-message
    // text) to unknown_provider_error.
    const classify = this.#options.classifyError ?? referenceClassifyError;
    return classify(raw, this.#clock);
  }

  // ---- SPI: close ----------------------------------------------------------
  async close(): Promise<void> {
    if (this.#closed) {
      await this.#transport?.close();
      await this.#runOnCloseHook();
      return;
    }
    this.#closed = true;
    const turn = this.#activeTurn;
    if (turn?.graceTimer !== undefined) clearTimeout(turn.graceTimer);
    await this.#transport?.close();
    await this.#runOnCloseHook();
  }

  /** Runs the factory's `onClose` hook exactly once (§17.1 H-1 disposal —
   * e.g. removing the isolated CODEX_HOME with its copied auth material).
   * Hook failures are swallowed: disposal must never break close. */
  async #runOnCloseHook(): Promise<void> {
    if (this.#onCloseRan) return;
    this.#onCloseRan = true;
    try {
      await this.#options.onClose?.();
    } catch {
      /* disposal must never break close */
    }
  }

  // ---- Internals: incoming traffic ----------------------------------------
  #onNotification(method: string, params: unknown): void {
    try {
      this.#options.notificationGuard?.(method, params);
    } catch (cause) {
      const error = isAdapterError(cause)
        ? cause
        : new AdapterError('invalid_argument', 'Provider notification violated adapter policy', {
            harnessId: this.harnessId,
            cause,
          });
      this.#transport?.fail(error);
      return;
    }
    if (method !== 'session/update') return; // unknown notifications ignored
    const record = asRecord(params) ?? {};
    const sessionKey = typeof record['sessionId'] === 'string' ? record['sessionId'] : undefined;
    const update = normalizeSessionUpdate(record['update']);
    // Keep the per-session view current from the live echo channels
    // (TX-3b/P-1: claude confirms switches via `config_option_update` and
    // mode changes via `current_mode_update`).
    if (sessionKey !== undefined) {
      const session = this.#sessions.get(sessionKey);
      if (session !== undefined) {
        if (update.kind === 'config_option_update' && update.configOptions.length > 0) {
          session.configOptions = update.configOptions;
        } else if (update.kind === 'current_mode_update') {
          session.currentModeId = update.currentModeId;
        }
      }
    }
    this.#routeUpdate(sessionKey, update);
  }

  #routeUpdate(sessionKey: string | undefined, update: SessionUpdate): void {
    const turn = this.#activeTurn;
    let target: ((update: SessionUpdate) => void) | undefined;
    if (turn !== undefined && (sessionKey === undefined || turn.sessionId === sessionKey)) {
      target = turn.onUpdate;
    } else if (sessionKey !== undefined && this.#closedTurnUpdate.has(sessionKey)) {
      // §10.2/#864: attributed to the closed turn — MUST NOT throw.
      target = this.#closedTurnUpdate.get(sessionKey);
    } else {
      this.#orphanUpdateCount += 1;
      return;
    }
    if (target === undefined) return;
    try {
      target(update);
    } catch {
      this.#callbackErrorCount += 1; // consumer bugs never crash the adapter
    }
  }

  #onIncomingRequest(id: number | string, method: string, params: unknown): void {
    const transport = this.#transport;
    if (transport === undefined) return;
    if (method !== 'session/request_permission') {
      transport.respond(id, {
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }
    const record = asRecord(params) ?? {};
    const sessionKey = typeof record['sessionId'] === 'string' ? record['sessionId'] : '';
    const toolCall = asRecord(record['toolCall']);
    const title = typeof toolCall?.['title'] === 'string' ? toolCall['title'] : undefined;
    this.#permissionSeq += 1;
    const requestId = `perm_${String(this.#permissionSeq).padStart(6, '0')}`;

    const options = normalizePermissionOptions(record['options']);
    const request: PermissionRequest = {
      requestId,
      sessionId: acpSessionId(sessionKey),
      description: title ?? 'Permission requested',
      ...(title !== undefined ? { toolTitle: title } : {}),
      // HIGH-5: an interactive decider must see what will EXECUTE, not only the
      // title describing it.
      ...(toolCall?.['rawInput'] !== undefined ? { rawInput: toolCall['rawInput'] } : {}),
      options,
    };
    const pending: PendingPermission = { jsonrpcId: id, sessionId: sessionKey, request, operation: title };

    // Surface on the update stream regardless of mode (observability, T20).
    this.#routeUpdate(sessionKey, { kind: 'permission_request', request });

    const config = this.#options.permissions ?? { mode: 'headless' };
    // HIGH-5: hand the classifier the tool call's `rawInput` — the payload the
    // provider actually executes — alongside the human-readable title.
    const decision = decidePermission(config, title, toolCall?.['rawInput']);

    if (decision.action === 'allow' || decision.action === 'deny') {
      const preference: readonly PermissionOptionKind[] =
        decision.action === 'allow'
          ? ['allow_once', 'allow_always']
          : ['reject_once', 'reject_always'];
      const option = pickOption(options, preference);
      const outcome: PermissionOutcome =
        option !== undefined
          ? { kind: 'selected', optionId: option.optionId }
          : { kind: 'cancelled' }; // no matching option — refuse the turn
      this.#respondPermission(pending, outcome, decision.action, decision.reason);
      return;
    }

    // Interactive: configured handler, or wait for SPI resolvePermission.
    this.#pendingPermissions.set(requestId, pending);
    if (config.mode === 'interactive' && config.handler !== undefined) {
      void config.handler(request).then(
        (outcome) => {
          if (!this.#pendingPermissions.delete(requestId)) return; // superseded
          this.#respondPermission(pending, outcome, 'interactive', 'interactive');
        },
        () => {
          if (!this.#pendingPermissions.delete(requestId)) return;
          this.#respondPermission(pending, { kind: 'cancelled' }, 'deny', 'interactive');
        },
      );
    }
  }

  #respondPermission(
    pending: PendingPermission,
    outcome: PermissionOutcome,
    action: 'allow' | 'deny' | 'interactive',
    reason: PermissionDecisionReason,
  ): void {
    const transport = this.#transport;
    if (transport === undefined) return;
    const wire =
      outcome.kind === 'selected'
        ? { outcome: { outcome: 'selected', optionId: outcome.optionId } }
        : { outcome: { outcome: 'cancelled' } };
    transport.respond(pending.jsonrpcId, { result: wire });
    this.#permissionDecisions.push({
      requestId: pending.request.requestId,
      sessionId: pending.sessionId,
      operation: pending.operation,
      action,
      reason,
      optionId: outcome.kind === 'selected' ? outcome.optionId : undefined,
      at: this.#clock.nowIso(),
    });
  }

  #dropPendingPermissions(sessionKey: string): void {
    for (const [requestId, pending] of [...this.#pendingPermissions]) {
      if (pending.sessionId === sessionKey) this.#pendingPermissions.delete(requestId);
    }
  }

  // ---- Internals: session-mode pinning (P-1) ------------------------------
  /**
   * Applies the configured per-role mode pin to a just-created/loaded
   * session. NORMATIVE (P-1): any failure — RPC rejection, value outside the
   * advertised set, or a contradicting effective-value echo — throws, failing
   * the session setup; the adapter's permissive default mode is never
   * silently kept.
   */
  async #pinSessionMode(sessionKey: string): Promise<void> {
    const policy = this.#options.sessionMode;
    if (policy === undefined) return;
    const role = this.#options.permissions?.role;
    const pin = resolveModePin(policy, role);
    if (pin === undefined) return;
    const transport = this.#transport;
    const session = this.#sessions.get(sessionKey);
    if (transport === undefined || session === undefined) return;

    if (pin.mechanism === 'session_set_mode') {
      if (session.availableModeIds.length > 0 && !session.availableModeIds.includes(pin.value)) {
        throw new AdapterError(
          'invalid_argument',
          `Session mode pin '${pin.value}' is not among the advertised modes [${session.availableModeIds.join(', ')}] (P-1)`,
          { harnessId: this.harnessId },
        );
      }
      await transport.request('session/set_mode', { sessionId: sessionKey, modeId: pin.value });
      session.currentModeId = pin.value; // response body is empty; acceptance = applied
      this.#recordModePin(sessionKey, role, pin, false);
      return;
    }

    const optionId = pin.optionId ?? 'mode';
    const descriptor = session.configOptions.find((option) => option.id === optionId);
    if (
      descriptor !== undefined &&
      descriptor.values.length > 0 &&
      !descriptor.values.includes(pin.value)
    ) {
      throw new AdapterError(
        'invalid_argument',
        `Session mode pin '${pin.value}' is not among the advertised values for config option '${optionId}' [${descriptor.values.join(', ')}] (P-1)`,
        { harnessId: this.harnessId },
      );
    }
    const raw = await transport.request('session/set_config_option', {
      sessionId: sessionKey,
      configId: optionId, // TX-3 wire param
      value: pin.value,
    });
    const result = asRecord(raw) ?? {};
    const echoedOptions = parseConfigOptionsWire(result['configOptions']);
    let echoed = false;
    if (echoedOptions.length > 0) {
      session.configOptions = echoedOptions;
      const current = echoedOptions.find((option) => option.id === optionId)?.current;
      if (current !== undefined) {
        echoed = true;
        if (current !== pin.value) {
          throw new AdapterError(
            'internal',
            `Session mode pin unconfirmed: requested '${pin.value}' for '${optionId}', agent echoed '${current}' (P-1)`,
            { harnessId: this.harnessId },
          );
        }
      }
    }
    this.#recordModePin(sessionKey, role, pin, echoed);
  }

  #recordModePin(
    sessionKey: string,
    role: RoleName | undefined,
    pin: SessionModePin,
    echoed: boolean,
  ): void {
    this.#modePins.push({
      sessionId: sessionKey,
      role,
      mechanism: pin.mechanism,
      ...(pin.mechanism === 'session_set_config_option' ? { optionId: pin.optionId ?? 'mode' } : {}),
      value: pin.value,
      echoed,
      at: this.#clock.nowIso(),
    });
  }

  // ---- Internals: shape helpers -------------------------------------------
  #usageFrom(result: Record<string, unknown>): TurnUsage | undefined {
    const usage = asRecord(result['usage']);
    if (usage === undefined) return undefined;
    const inputTokens = usage['inputTokens'];
    const outputTokens = usage['outputTokens'];
    return {
      ...(typeof inputTokens === 'number' ? { inputTokens } : {}),
      ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
      source: 'adapter',
    };
  }

  /** JSON-RPC -32601 on a gated method = advertised-but-missing capability. */
  #mapMethodNotFound(error: unknown, capability: 'loadSession' | 'setConfigOption'): unknown {
    if (isAdapterError(error) && error.kind === 'provider_error') {
      const envelope = error.envelope as JsonRpcErrorEnvelope | undefined;
      if (envelope !== undefined && envelope.code === -32601) {
        return new UnsupportedCapabilityError(capability, { harnessId: this.harnessId });
      }
    }
    return error;
  }

  // ---- Internals: state guards --------------------------------------------
  #requireOpen(): void {
    if (this.#closed) {
      throw new AdapterError('invalid_state', 'Adapter is closed', { harnessId: this.harnessId });
    }
  }

  #requireInitialized(): { record: CapabilityRecord; transport: AcpStdioTransport } {
    this.#requireOpen();
    const record = this.#capabilities;
    const transport = this.#transport;
    if (record === undefined || transport === undefined) {
      throw new AdapterError('invalid_state', 'initialize() must complete before session operations', {
        harnessId: this.harnessId,
      });
    }
    const fatal = transport.fatalError;
    if (fatal !== undefined) throw fatal;
    return { record, transport };
  }

  #requireSession(sessionKey: string): SessionState {
    const session = this.#sessions.get(sessionKey);
    if (session === undefined) {
      throw new AdapterError('session_not_found', `Unknown session: ${sessionKey}`, {
        harnessId: this.harnessId,
      });
    }
    return session;
  }
}

// ---------------------------------------------------------------------------
// Wire-shape parsing (REAL shapes — P2 live gate TX-2, SDK schema)
// ---------------------------------------------------------------------------
/**
 * Parses the REAL ACP `SessionConfigOption[]` shape (TX-2): `{id, name,
 * description?, category?, type:'select'|'boolean', currentValue,
 * options: [{value,…}] | [{group, options:[{value,…}]}]}` into SPI
 * descriptors — `category`→kind (`model`/`mode`/`thought_level`→reasoning),
 * `options[].value`→values (groups flattened), `currentValue`→current
 * (booleans stringified). Non-arrays and idless entries are skipped.
 */
export function parseConfigOptionsWire(rawOptions: unknown): readonly ConfigOptionDescriptor[] {
  if (!Array.isArray(rawOptions)) return [];
  const descriptors: ConfigOptionDescriptor[] = [];
  for (const entry of rawOptions) {
    const record = asRecord(entry);
    if (record === undefined || typeof record['id'] !== 'string') continue;
    const category = record['category'];
    const kind: ConfigOptionDescriptor['kind'] =
      category === 'model'
        ? 'model'
        : category === 'mode'
          ? 'mode'
          : category === 'thought_level'
            ? 'reasoning'
            : 'other';
    const values =
      record['type'] === 'boolean' ? ['true', 'false'] : flattenSelectValuesWire(record['options']);
    const currentRaw = record['currentValue'];
    const current =
      typeof currentRaw === 'string'
        ? currentRaw
        : typeof currentRaw === 'boolean'
          ? String(currentRaw)
          : undefined;
    descriptors.push({
      id: record['id'],
      kind,
      values,
      ...(current !== undefined ? { current } : {}),
    });
  }
  return descriptors;
}

/** Flattens `SessionConfigSelectOptions` (flat `{value}` list OR grouped
 * `{group, options:[{value}]}` list) into plain value ids. */
function flattenSelectValuesWire(rawOptions: unknown): string[] {
  if (!Array.isArray(rawOptions)) return [];
  const values: string[] = [];
  for (const entry of rawOptions) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    if (typeof record['value'] === 'string') {
      values.push(record['value']);
      continue;
    }
    if (Array.isArray(record['options'])) {
      for (const grouped of record['options']) {
        const groupedRecord = asRecord(grouped);
        if (groupedRecord !== undefined && typeof groupedRecord['value'] === 'string') {
          values.push(groupedRecord['value']);
        }
      }
    }
  }
  return values;
}

/** Builds per-session state from a `session/new`/`session/load` result:
 * REAL-shaped `configOptions` (TX-2) + `modes` SessionModeState (P-1). */
function sessionStateFrom(result: Record<string, unknown>): SessionState {
  const modes = asRecord(result['modes']);
  const availableModesRaw = Array.isArray(modes?.['availableModes']) ? modes['availableModes'] : [];
  const availableModeIds = availableModesRaw.flatMap((mode) => {
    const record = asRecord(mode);
    return record !== undefined && typeof record['id'] === 'string' ? [record['id']] : [];
  });
  const currentModeId = modes?.['currentModeId'];
  return {
    configOptions: parseConfigOptionsWire(result['configOptions']),
    availableModeIds,
    ...(typeof currentModeId === 'string' ? { currentModeId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Update normalization (ACP session/update → SPI SessionUpdate)
// ---------------------------------------------------------------------------
function textOf(content: unknown): string {
  const record = asRecord(content);
  if (record !== undefined && typeof record['text'] === 'string') return record['text'];
  return '';
}

function toolStatusOf(value: unknown): { status?: 'pending' | 'in_progress' | 'completed' | 'failed' } {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'failed'
    ? { status: value }
    : {};
}

/**
 * Anything the adapter cannot normalize passes through as `unknown` (§9).
 * The typed kinds cover the REAL live vocabulary (P2 live gate, P-3):
 * message/thought/user chunks, tool calls, plans, `usage_update`,
 * `session_info_update`, `available_commands_update`,
 * `config_option_update`, `current_mode_update`.
 */
export function normalizeSessionUpdate(update: unknown): SessionUpdate {
  const record = asRecord(update);
  if (record === undefined) return { kind: 'unknown', raw: update };
  switch (record['sessionUpdate']) {
    case 'agent_message_chunk':
      return { kind: 'agent_message_chunk', text: textOf(record['content']) };
    case 'agent_thought_chunk':
      return { kind: 'agent_thought_chunk', text: textOf(record['content']) };
    case 'user_message_chunk':
      // Live: seen during session/load history replay (both adapters).
      return { kind: 'user_message_chunk', text: textOf(record['content']) };
    case 'usage_update': {
      // REAL shape: {used, size, cost?:{amount, currency}} — the §17.2
      // per-turn token/cost accounting feed (arrives every live turn).
      const used = record['used'];
      const size = record['size'];
      if (typeof used !== 'number' || typeof size !== 'number') {
        return { kind: 'unknown', raw: update };
      }
      const cost = asRecord(record['cost']);
      const amount = cost?.['amount'];
      const currency = cost?.['currency'];
      return {
        kind: 'usage_update',
        usedTokens: used,
        contextWindowSize: size,
        ...(typeof amount === 'number' && typeof currency === 'string'
          ? { cost: { amount, currency } }
          : {}),
      };
    }
    case 'session_info_update': {
      const title = record['title'];
      const updatedAt = record['updatedAt'];
      return {
        kind: 'session_info_update',
        ...(typeof title === 'string' ? { title } : {}),
        ...(typeof updatedAt === 'string' ? { updatedAt } : {}),
      };
    }
    case 'available_commands_update': {
      const commandsRaw = Array.isArray(record['availableCommands'])
        ? record['availableCommands']
        : [];
      const commandNames = commandsRaw.flatMap((command) => {
        const commandRecord = asRecord(command);
        return commandRecord !== undefined && typeof commandRecord['name'] === 'string'
          ? [commandRecord['name']]
          : [];
      });
      return { kind: 'available_commands_update', commandNames };
    }
    case 'config_option_update':
      // REAL shape: the full refreshed config-option set (TX-3b echo channel).
      return {
        kind: 'config_option_update',
        configOptions: parseConfigOptionsWire(record['configOptions']),
      };
    case 'current_mode_update': {
      const currentModeId = record['currentModeId'];
      if (typeof currentModeId !== 'string') return { kind: 'unknown', raw: update };
      return { kind: 'current_mode_update', currentModeId };
    }
    case 'tool_call': {
      const toolCallId = record['toolCallId'];
      if (typeof toolCallId !== 'string') return { kind: 'unknown', raw: update };
      return {
        kind: 'tool_call',
        toolCallId,
        ...(typeof record['title'] === 'string' ? { title: record['title'] } : {}),
        ...toolStatusOf(record['status']),
      };
    }
    case 'tool_call_update': {
      const toolCallId = record['toolCallId'];
      if (typeof toolCallId !== 'string') return { kind: 'unknown', raw: update };
      return { kind: 'tool_call_update', toolCallId, ...toolStatusOf(record['status']) };
    }
    case 'plan': {
      const entriesRaw = Array.isArray(record['entries']) ? record['entries'] : [];
      type PlanEntry = { readonly content: string; readonly status?: 'pending' | 'in_progress' | 'completed' };
      const entries = entriesRaw.flatMap((entry): PlanEntry[] => {
        const entryRecord = asRecord(entry);
        if (entryRecord === undefined || typeof entryRecord['content'] !== 'string') return [];
        const status = entryRecord['status'];
        return [
          {
            content: entryRecord['content'],
            ...(status === 'pending' || status === 'in_progress' || status === 'completed'
              ? { status }
              : {}),
          },
        ];
      });
      return { kind: 'plan', entries };
    }
    default:
      return { kind: 'unknown', raw: update };
  }
}

function normalizePermissionOptions(raw: unknown): readonly PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: PermissionOption[] = [];
  for (const entry of raw) {
    const record = asRecord(entry);
    if (record === undefined) continue;
    const optionId = record['optionId'];
    const kind = record['kind'];
    if (typeof optionId !== 'string') continue;
    if (!PERMISSION_OPTION_KINDS.includes(kind as PermissionOptionKind)) continue;
    options.push({
      optionId,
      name: typeof record['name'] === 'string' ? record['name'] : optionId,
      kind: kind as PermissionOptionKind,
    });
  }
  return options;
}
