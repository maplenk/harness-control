/**
 * First-party Claude Code provider adapter.
 *
 * The lockfile-pinned `claude-agent-acp` package is an API-key automation
 * path. This adapter is the tier-2 `headless_json` seam from the SPI: it
 * drives the user's installed first-party `claude` binary in persistent
 * stream-json mode, allowing Claude Code subscription/provider auth to remain
 * owned by Claude Code itself.
 *
 * This is the ONLY production Claude transport. Every role uses the user's
 * installed Claude Code provider/subscription; API-key environment variables
 * are deliberately absent from the minimal child environment.
 *
 * Security remains role-specific. Coordinator and Verifier run in `dontAsk`
 * mode with read-only tools; Verifier receives narrow `Bash(command)` grants
 * for the approved spec's exact evidence commands. Implementor runs in
 * `acceptEdits` mode, but only
 * receives Claude's built-in Read/Glob/Grep/Edit/Write tools inside the
 * harness-created implementation worktree: no shell, subagents, extra
 * worktrees, hooks, plugins, or MCP servers.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants as fsConstants } from 'node:fs';
import * as path from 'node:path';
import type { RoleName } from '../../domain/state.js';
import { acpSessionId, nativeSessionId, type AcpSessionId } from '../../domain/ids.js';
import type { ReasoningEffort } from '../../app/model-resolution.js';
import type { Clock } from '../../lib/clock.js';
import { SystemClock, isoTimestamp } from '../../lib/clock.js';
import { err, ok, type Result } from '../../lib/result.js';
import { CHILD_ENV_ALLOWLIST } from '../acp/transport.js';
import {
  AdapterError,
  UnsupportedCapabilityError,
  type CancelTurnInput,
  type CapabilityRecord,
  type ConfigOptionDescriptor,
  type CreateSessionInput,
  type ErrorClassification,
  type HarnessAdapter,
  type LoadSessionInput,
  type ProbeResult,
  type PromptInput,
  type PromptResult,
  type ResolvePermissionInput,
  type SessionHandle,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../spi.js';
import { CLAUDE_CONFLICTING_BUILTIN_TOOLS, CLAUDE_HARNESS_ID } from './capabilities.js';

export const CLAUDE_PROVIDER_PACKAGE_NAME = '@anthropic-ai/claude-code';
export const CLAUDE_PROVIDER_BIN_NAME = 'claude';
export const CLAUDE_PROVIDER_PROTOCOL_VERSION = 'stream-json-v1';
export const CLAUDE_PROVIDER_BIN_ENV = 'CLAUDE_PROVIDER_BIN';
/** Oldest native provider version characterized by this adapter. */
export const MIN_CLAUDE_PROVIDER_VERSION = '2.1.215';
/** Durable production-routing invariant; exported for diagnostics/tests. */
export const CLAUDE_RUNTIME_AUTH_POLICY = 'installed_subscription_provider_only';
export const CLAUDE_PROVIDER_SCOPE_PROMPT =
  'Harness invariant: operate only inside the current working directory. Do not access or modify paths outside it.';
const MAX_LINE_BYTES = 1024 * 1024;
const CLOSE_GRACE_MS = 2000;

export interface ClaudeProviderRolePolicy {
  readonly permissionMode: 'dontAsk' | 'acceptEdits';
  readonly tools: readonly string[];
  readonly deniedTools: readonly string[];
  readonly allowedTools: readonly string[];
}

const READ_ONLY_TOOLS = ['Read', 'Glob', 'Grep'] as const;
const IMPLEMENTOR_TOOLS = ['Read', 'Glob', 'Grep', 'Edit', 'Write'] as const;
const ALWAYS_DENIED_TOOLS = [
  'Task',
  'NotebookEdit',
  'EnterWorktree',
  'ExitWorktree',
] as const;
const IMPLEMENTOR_DENIED_TOOLS = [...ALWAYS_DENIED_TOOLS, 'Bash'] as const;
const READ_ONLY_DENIED_TOOLS = [...ALWAYS_DENIED_TOOLS, 'Write', 'Edit'] as const;

function bashPermission(command: string): string {
  if (command.includes('\n') || command.includes('\r') || command.includes('\0')) {
    throw new AdapterError(
      'invalid_argument',
      'Claude verifier shell permissions require a single-line command without NUL bytes',
      { harnessId: CLAUDE_HARNESS_ID },
    );
  }
  return `Bash(${command})`;
}

/** Host-owned launch policy for each native Claude role. */
export function claudeProviderRolePolicy(
  role: RoleName,
  allowedShellCommands: readonly string[] = [],
): ClaudeProviderRolePolicy {
  if (role === 'implementor') {
    return {
      permissionMode: 'acceptEdits',
      tools: IMPLEMENTOR_TOOLS,
      deniedTools: IMPLEMENTOR_DENIED_TOOLS,
      allowedTools: [],
    };
  }
  const allowedTools =
    role === 'verifier' ? [...new Set(allowedShellCommands)].map(bashPermission) : [];
  return {
    permissionMode: 'dontAsk',
    tools: allowedTools.length > 0 ? [...READ_ONLY_TOOLS, 'Bash'] : READ_ONLY_TOOLS,
    deniedTools: READ_ONLY_DENIED_TOOLS,
    allowedTools,
  };
}

export interface BuildClaudeProviderArgsInput {
  readonly resolvedArgs?: readonly string[];
  readonly role: RoleName;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly sessionId: string;
  readonly allowedShellCommands?: readonly string[];
}

/**
 * The security-critical native Claude launch contract. Kept pure so tests can
 * assert the complete argv, not merely the higher-level policy object.
 */
export function buildClaudeProviderArgs(
  input: BuildClaudeProviderArgsInput,
): readonly string[] {
  const policy = claudeProviderRolePolicy(
    input.role,
    input.allowedShellCommands ?? [],
  );
  return [
    ...(input.resolvedArgs ?? []),
    '-p',
    '--model',
    input.model,
    ...(input.effort !== undefined ? ['--effort', input.effort] : []),
    '--permission-mode',
    policy.permissionMode,
    '--safe-mode',
    '--strict-mcp-config',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--tools',
    policy.tools.join(','),
    ...(policy.allowedTools.length > 0
      ? [
          '--allowedTools',
          ...policy.allowedTools,
          // Claude Code 2.1.215 exposes the scoped Bash call but does not
          // honor the CLI allow rule under dontAsk by itself. Mirror the
          // exact same rule through an explicit, in-memory settings source;
          // the real-provider smoke proves the allowed call executes while a
          // different command remains denied.
          '--settings',
          JSON.stringify({ permissions: { allow: policy.allowedTools } }),
        ]
      : []),
    '--disallowedTools',
    policy.deniedTools.join(','),
    '--append-system-prompt',
    CLAUDE_PROVIDER_SCOPE_PROMPT,
    '--no-session-persistence',
    '--session-id',
    input.sessionId,
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
  ];
}

export interface ResolvedClaudeProviderCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly packageName: string;
  readonly version: string;
  readonly binPath: string;
  readonly packageDir: string;
}

export interface ResolveClaudeProviderOptions {
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly binPath?: string;
}

function parseVersionTriplet(value: string): readonly [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(value.trim());
  if (match === null) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Native Claude auto-updates, so enforce a characterized minimum, not an exact pin. */
export function checkClaudeProviderVersion(
  installed: string,
  minimum = MIN_CLAUDE_PROVIDER_VERSION,
): { readonly pinned: boolean } {
  const current = parseVersionTriplet(installed);
  const floor = parseVersionTriplet(minimum);
  if (current === undefined || floor === undefined) return { pinned: false };
  for (let index = 0; index < current.length; index += 1) {
    const currentPart = current[index] ?? 0;
    const floorPart = floor[index] ?? 0;
    if (currentPart > floorPart) return { pinned: true };
    if (currentPart < floorPart) return { pinned: false };
  }
  return { pinned: true };
}

function minimalChildEnv(
  processEnv: NodeJS.ProcessEnv,
  spawnId?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    const value = processEnv[key];
    if (value !== undefined) env[key] = value;
  }
  if (spawnId !== undefined) env['HARNESS_SPAWN_ID'] = spawnId;
  return env;
}

function executableOnPath(binName: string, env: NodeJS.ProcessEnv): string | undefined {
  const rawPath = env['PATH'];
  if (rawPath === undefined) return undefined;
  for (const dir of rawPath.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, binName);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep searching the caller's PATH.
    }
  }
  return undefined;
}

/** Resolve the installed first-party provider binary and record its live version. */
export function resolveClaudeProviderCommand(
  options: ResolveClaudeProviderOptions = {},
): ResolvedClaudeProviderCommand {
  const processEnv = options.processEnv ?? process.env;
  const configured = options.binPath ?? processEnv[CLAUDE_PROVIDER_BIN_ENV];
  const binPath =
    configured !== undefined && configured.trim().length > 0
      ? path.resolve(configured)
      : executableOnPath(CLAUDE_PROVIDER_BIN_NAME, processEnv);
  if (binPath === undefined) {
    throw new AdapterError(
      'spawn_failed',
      `Cannot locate the first-party Claude Code provider binary. Install 'claude' on PATH or set ${CLAUDE_PROVIDER_BIN_ENV}.`,
      { harnessId: CLAUDE_HARNESS_ID },
    );
  }
  try {
    accessSync(binPath, fsConstants.X_OK);
  } catch (cause) {
    throw new AdapterError('spawn_failed', `Claude provider binary is not executable: ${binPath}`, {
      harnessId: CLAUDE_HARNESS_ID,
      cause,
    });
  }
  const checked = spawnSync(binPath, ['--version'], {
    encoding: 'utf8',
    env: minimalChildEnv(processEnv),
    timeout: 5000,
  });
  if (checked.error !== undefined || checked.status !== 0) {
    const detail =
      checked.error?.message ??
      (checked.stderr.trim().length > 0 ? checked.stderr.trim() : `exit ${String(checked.status)}`);
    throw new AdapterError(
      'spawn_failed',
      `Cannot read Claude provider version from ${binPath}: ${detail}`,
      { harnessId: CLAUDE_HARNESS_ID, ...(checked.error !== undefined ? { cause: checked.error } : {}) },
    );
  }
  const version = checked.stdout.trim();
  if (version.length === 0) {
    throw new AdapterError('spawn_failed', `Claude provider returned an empty version from ${binPath}`, {
      harnessId: CLAUDE_HARNESS_ID,
    });
  }
  return {
    command: binPath,
    args: [],
    packageName: CLAUDE_PROVIDER_PACKAGE_NAME,
    version,
    binPath,
    packageDir: path.dirname(binPath),
  };
}

/** Non-throwing resolver for doctor/startup diagnostics. */
export function tryResolveClaudeProviderCommand(
  options: ResolveClaudeProviderOptions = {},
): Result<ResolvedClaudeProviderCommand, AdapterError> {
  try {
    return ok(resolveClaudeProviderCommand(options));
  } catch (cause) {
    return err(
      cause instanceof AdapterError
        ? cause
        : new AdapterError('spawn_failed', `Unexpected Claude provider resolution failure: ${String(cause)}`, {
            harnessId: CLAUDE_HARNESS_ID,
            cause,
          }),
    );
  }
}

export interface ClaudeProviderAdapterOptions {
  readonly role: RoleName;
  readonly cwd: string;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  readonly clock?: Clock;
  readonly processEnv?: NodeJS.ProcessEnv;
  readonly spawnId?: string;
  /** Exact approved verifier evidence commands; never a blanket Bash grant. */
  readonly allowedShellCommands?: readonly string[];
  readonly resolved?: ResolvedClaudeProviderCommand;
}

export interface CreatedClaudeProviderAdapter {
  readonly adapter: ClaudeProviderAdapter;
  readonly resolved: ResolvedClaudeProviderCommand;
}

/**
 * Credential-free characterization of a native stream-json rate-limit frame.
 * Live smoke evidence records this shape so provider envelope drift is visible
 * without persisting prompts, responses, or authentication material.
 */
export interface ClaudeRateLimitObservation {
  readonly infoKey: 'rate_limit_info' | 'rateLimitInfo' | 'missing';
  readonly fields: readonly string[];
  readonly status?: string;
  readonly resetsAt?: number;
  readonly rateLimitType?: string;
  readonly classification: ErrorClassification;
}

/** Sanitized tool-use echo from the native provider's completed assistant frame. */
export interface ClaudeToolInvocationObservation {
  readonly name: string;
  readonly inputKeys: readonly string[];
  /** Present only for Bash, where exact-command verification is load-bearing. */
  readonly command?: string;
}

interface PendingTurn {
  readonly input: PromptInput;
  readonly resolve: (result: PromptResult) => void;
  readonly reject: (error: unknown) => void;
  readonly toolCalls: Map<number, string>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function httpStatusNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d{3}$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

function structuredHttpStatus(record: Record<string, unknown>): number | undefined {
  const nestedError = asRecord(record['error']);
  const nestedResponse = asRecord(record['response']);
  return (
    httpStatusNumber(record['api_error_status']) ??
    httpStatusNumber(record['status']) ??
    httpStatusNumber(record['statusCode']) ??
    httpStatusNumber(nestedError?.['status']) ??
    httpStatusNumber(nestedError?.['statusCode']) ??
    httpStatusNumber(nestedResponse?.['status'])
  );
}

function unixSecondsToIso(value: unknown): ReturnType<typeof isoTimestamp> | undefined {
  const seconds = finiteNumber(value);
  if (seconds === undefined) return undefined;
  return isoTimestamp(new Date(seconds * 1000).toISOString());
}

function observeClaudeRateLimitEvent(
  record: Record<string, unknown>,
): ClaudeRateLimitObservation {
  const snakeInfo = asRecord(record['rate_limit_info']);
  const camelInfo = asRecord(record['rateLimitInfo']);
  const info = snakeInfo ?? camelInfo;
  const infoKey =
    snakeInfo !== undefined
      ? 'rate_limit_info'
      : camelInfo !== undefined
        ? 'rateLimitInfo'
        : 'missing';
  const rawStatus = info?.['status'];
  const rawResetsAt = info?.['resetsAt'] ?? info?.['resets_at'];
  const rawRateLimitType = info?.['rateLimitType'] ?? info?.['rate_limit_type'];
  return Object.freeze({
    infoKey,
    fields: Object.freeze(Object.keys(info ?? {}).sort()),
    ...(typeof rawStatus === 'string' ? { status: rawStatus } : {}),
    ...(finiteNumber(rawResetsAt) !== undefined ? { resetsAt: rawResetsAt as number } : {}),
    ...(typeof rawRateLimitType === 'string' ? { rateLimitType: rawRateLimitType } : {}),
    classification: classifyClaudeProviderError(record),
  });
}

/**
 * Native provider error classifier. Only structured stream/result envelopes
 * are recognized; free text is never parsed as a limit signal.
 */
export function classifyClaudeProviderError(raw: unknown): ErrorClassification {
  if (raw instanceof AdapterError) {
    if (raw.kind === 'provider_error') return classifyClaudeProviderError(raw.envelope);
    if (raw.kind === 'spawn_failed' || raw.kind === 'unexpected_eof') {
      return { kind: 'crash', source: 'structured', confidence: 'high', provider: 'claude' };
    }
    if (
      raw.kind === 'malformed_frame' ||
      raw.kind === 'oversized_frame' ||
      raw.kind === 'turn_timeout'
    ) {
      return { kind: 'protocol', source: 'structured', confidence: 'high', provider: 'claude' };
    }
  }
  const record = asRecord(raw);
  if (record === undefined) {
    return {
      kind: 'unknown_provider_error',
      source: 'parsed',
      confidence: 'low',
      detectionTier: 'unknown',
      provider: 'claude',
    };
  }
  if (record['type'] === 'rate_limit_event') {
    const info = asRecord(record['rate_limit_info']) ?? asRecord(record['rateLimitInfo']);
    const rawStatus = info?.['status'];
    const status = typeof rawStatus === 'string' ? rawStatus.trim().toLowerCase() : undefined;
    if (status !== 'allowed' && status !== 'allowed_warning') {
      const resumesAt = unixSecondsToIso(info?.['resetsAt'] ?? info?.['resets_at']);
      return {
        kind: 'usage_limit',
        source: 'structured',
        confidence: 'high',
        detectionTier: 'structured',
        provider: 'claude',
        ...(resumesAt !== undefined ? { resumesAt } : {}),
      };
    }
  }
  const status = structuredHttpStatus(record);
  if (status === 401 || status === 403) {
    return { kind: 'auth', source: 'structured', confidence: 'high', provider: 'claude' };
  }
  if (status === 429) {
    return {
      kind: 'usage_limit',
      source: 'structured',
      confidence: 'high',
      detectionTier: 'http_429',
      provider: 'claude',
    };
  }
  return {
    kind: 'unknown_provider_error',
    source: 'parsed',
    confidence: 'low',
    detectionTier: 'unknown',
    provider: 'claude',
  };
}

export class ClaudeProviderAdapter implements HarnessAdapter {
  readonly harnessId = CLAUDE_HARNESS_ID;
  readonly #role: RoleName;
  readonly #cwd: string;
  readonly #requestedModel: string;
  readonly #effort: ReasoningEffort | undefined;
  readonly #clock: Clock;
  readonly #processEnv: NodeJS.ProcessEnv;
  readonly #resolved: ResolvedClaudeProviderCommand;
  readonly #allowedShellCommands: readonly string[];
  readonly #spawnId: string;
  readonly #nativeId = randomUUID();
  readonly #acpId = acpSessionId(`claude-provider:${this.#nativeId}`);
  #capabilities: CapabilityRecord | undefined;
  #child: ChildProcessWithoutNullStreams | undefined;
  #sessionCreated = false;
  #closed = false;
  /** must-fix 5: the ONE shared close/exit promise. A concurrent second `close()`
   * AWAITS the first close's confirmed process exit rather than returning
   * immediately (which would let the caller clear the watchdog deadline before
   * the child is actually dead). */
  #closePromise: Promise<void> | undefined;
  #stdoutBuffer = '';
  #stderrTail = '';
  #pending: PendingTurn | undefined;
  #observedModel: string | undefined;
  readonly #rateLimitObservations: ClaudeRateLimitObservation[] = [];
  readonly #toolInvocationObservations: ClaudeToolInvocationObservation[] = [];
  #exitPromise: Promise<number | null> | undefined;

  constructor(options: ClaudeProviderAdapterOptions) {
    this.#role = options.role;
    this.#allowedShellCommands = options.allowedShellCommands ?? [];
    this.#cwd = options.cwd;
    this.#requestedModel = options.model;
    this.#effort = options.effort;
    this.#clock = options.clock ?? new SystemClock();
    this.#processEnv = options.processEnv ?? process.env;
    this.#resolved =
      options.resolved ?? resolveClaudeProviderCommand({ processEnv: this.#processEnv });
    this.#spawnId = options.spawnId ?? randomUUID();
  }

  get transportPid(): number | undefined {
    return this.#child?.pid;
  }

  get transportSpawnId(): string {
    return this.#spawnId;
  }

  get observedModel(): string | undefined {
    return this.#observedModel;
  }

  get rateLimitObservations(): readonly ClaudeRateLimitObservation[] {
    return [...this.#rateLimitObservations];
  }

  get toolInvocationObservations(): readonly ClaudeToolInvocationObservation[] {
    return [...this.#toolInvocationObservations];
  }

  async probe(): Promise<ProbeResult> {
    return {
      harnessId: this.harnessId,
      available: true,
      executable: {
        packageName: this.#resolved.packageName,
        version: this.#resolved.version,
        resolvedPath: this.#resolved.binPath,
      },
      protocol: { name: 'headless_json', version: CLAUDE_PROVIDER_PROTOCOL_VERSION },
      auth: this.#capabilities?.auth ?? 'detected_but_unvalidated',
      issues: [],
    };
  }

  async initialize(): Promise<CapabilityRecord> {
    this.#assertOpen();
    if (this.#capabilities !== undefined) return this.#capabilities;
    const args = buildClaudeProviderArgs({
      resolvedArgs: this.#resolved.args,
      role: this.#role,
      model: this.#requestedModel,
      ...(this.#effort !== undefined ? { effort: this.#effort } : {}),
      sessionId: this.#nativeId,
      allowedShellCommands: this.#allowedShellCommands,
    });
    const child = spawn(this.#resolved.command, args, {
      cwd: this.#cwd,
      env: minimalChildEnv(this.#processEnv, this.#spawnId),
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#child = child;
    this.#exitPromise = new Promise((resolve) => child.once('close', resolve));
    child.stdout.on('data', (chunk: Buffer) => this.#consumeStdout(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      this.#stderrTail = (this.#stderrTail + chunk.toString('utf8')).slice(-64 * 1024);
    });
    child.once('close', (code, signal) => {
      const pending = this.#pending;
      this.#pending = undefined;
      if (pending !== undefined) {
        pending.reject(
          new AdapterError(
            'unexpected_eof',
            `Claude provider exited during a turn (code=${String(code)}, signal=${String(signal)}): ${this.#stderrTail}`,
            { harnessId: this.harnessId },
          ),
        );
      }
    });
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', (cause) =>
        reject(
          new AdapterError('spawn_failed', `Cannot spawn Claude provider: ${String(cause)}`, {
            harnessId: this.harnessId,
            cause,
          }),
        ),
      );
    });
    this.#capabilities = this.#buildCapabilities();
    return this.#capabilities;
  }

  async createSession(input: CreateSessionInput): Promise<SessionHandle> {
    this.#requireInitialized();
    if (path.resolve(input.cwd) !== path.resolve(this.#cwd)) {
      throw new AdapterError(
        'invalid_argument',
        `Claude provider cwd mismatch: initialized for ${this.#cwd}, got ${input.cwd}`,
        { harnessId: this.harnessId },
      );
    }
    if (this.#sessionCreated) {
      throw new AdapterError('invalid_state', 'Claude provider adapter supports one live session', {
        harnessId: this.harnessId,
      });
    }
    this.#sessionCreated = true;
    return { acpSessionId: this.#acpId, nativeSessionId: nativeSessionId(this.#nativeId) };
  }

  async loadSession(_input: LoadSessionInput): Promise<SessionHandle> {
    throw new UnsupportedCapabilityError('loadSession', { harnessId: this.harnessId });
  }

  async listConfigOptions(sessionId: AcpSessionId): Promise<readonly ConfigOptionDescriptor[]> {
    this.#requireSession(sessionId);
    return this.#configOptions();
  }

  async setConfigOption(input: SetConfigOptionInput): Promise<SetConfigOptionResult> {
    this.#requireSession(input.sessionId);
    if (input.optionId === 'model') {
      if (input.value !== this.#requestedModel) {
        throw new AdapterError(
          'invalid_argument',
          `Claude provider process was spawned with model '${this.#requestedModel}', not '${input.value}'`,
          { harnessId: this.harnessId },
        );
      }
      return { effectiveValue: this.#requestedModel, echoed: true };
    }
    if (input.optionId === 'thinking') {
      if (this.#effort === undefined || input.value !== this.#effort) {
        throw new AdapterError(
          'invalid_argument',
          `Claude provider process was spawned with effort '${this.#effort ?? '(default)'}', not '${input.value}'`,
          { harnessId: this.harnessId },
        );
      }
      return { effectiveValue: this.#effort, echoed: true };
    }
    throw new AdapterError('invalid_argument', `Unknown Claude provider config option '${input.optionId}'`, {
      harnessId: this.harnessId,
    });
  }

  async prompt(input: PromptInput): Promise<PromptResult> {
    this.#requireSession(input.sessionId);
    if (this.#pending !== undefined) {
      throw new AdapterError('invalid_state', 'Claude provider already has a turn in flight', {
        harnessId: this.harnessId,
      });
    }
    const child = this.#child;
    if (child === undefined || child.stdin.destroyed || child.exitCode !== null) {
      throw new AdapterError('unexpected_eof', 'Claude provider process is not running', {
        harnessId: this.harnessId,
      });
    }
    return new Promise<PromptResult>((resolve, reject) => {
      this.#pending = { input, resolve, reject, toolCalls: new Map() };
      const frame = {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: input.prompt }],
        },
      };
      child.stdin.write(`${JSON.stringify(frame)}\n`, (error) => {
        if (error === null || error === undefined) return;
        const pending = this.#pending;
        this.#pending = undefined;
        pending?.reject(
          new AdapterError('unexpected_eof', `Cannot write Claude provider turn: ${String(error)}`, {
            harnessId: this.harnessId,
            cause: error,
          }),
        );
      });
    });
  }

  async cancelTurn(input: CancelTurnInput): Promise<void> {
    this.#requireSession(input.sessionId);
    const pending = this.#pending;
    if (pending === undefined) return;
    this.#pending = undefined;
    pending.resolve({ stopReason: 'cancelled' });
    this.#terminate('SIGTERM');
  }

  async resolvePermission(_input: ResolvePermissionInput): Promise<void> {
    throw new UnsupportedCapabilityError('permissionRequests', { harnessId: this.harnessId });
  }

  classifyError(raw: unknown): ErrorClassification {
    return classifyClaudeProviderError(raw);
  }

  close(): Promise<void> {
    // must-fix 5: a second `close()` returns the FIRST close's promise — it
    // AWAITS confirmed process exit instead of returning immediately while the
    // first close is still terminating the child (which let runRole clear the
    // watchdog deadline prematurely).
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = this.#doClose();
    return this.#closePromise;
  }

  async #doClose(): Promise<void> {
    const child = this.#child;
    if (child === undefined || child.exitCode !== null) return;
    child.stdin.end();
    const exited = await Promise.race([
      this.#exitPromise?.then(() => true) ?? Promise.resolve(true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), CLOSE_GRACE_MS)),
    ]);
    if (!exited) {
      this.#terminate('SIGKILL');
      await this.#exitPromise;
    }
  }

  #buildCapabilities(): CapabilityRecord {
    return {
      harnessId: this.harnessId,
      protocol: { name: 'headless_json', version: CLAUDE_PROVIDER_PROTOCOL_VERSION },
      executable: {
        packageName: this.#resolved.packageName,
        version: this.#resolved.version,
        resolvedPath: this.#resolved.binPath,
      },
      auth: 'detected_but_unvalidated',
      sessionOps: { create: true, load: false, resume: false, fork: false, cancel: true },
      configOptions: this.#configOptions(),
      modelMechanism: 'cli_flag',
      permissionRequests: false,
      mcpConfig: { supported: false, reportOnly: true },
      checkpointExport: false,
      usageLimitReporting: 'structured',
      retryAfterTier: 'honored',
      usageAccounting: 'per_turn',
      conflictingBuiltinTools: [...CLAUDE_CONFLICTING_BUILTIN_TOOLS],
      sessionIdentity: {
        exposesNativeSessionId: true,
        confirmsIdentityOnResume: false,
        lastObserved: {
          acpSessionId: String(this.#acpId),
          nativeSessionId: this.#nativeId,
        },
      },
      probedAt: this.#clock.nowIso(),
    };
  }

  #configOptions(): ConfigOptionDescriptor[] {
    return [
      {
        id: 'model',
        kind: 'model',
        values: [this.#requestedModel],
        current: this.#observedModel ?? this.#requestedModel,
      },
      ...(this.#effort !== undefined
        ? [{ id: 'thinking', kind: 'reasoning' as const, values: [this.#effort], current: this.#effort }]
        : []),
    ];
  }

  #consumeStdout(chunk: Buffer): void {
    this.#stdoutBuffer += chunk.toString('utf8');
    if (Buffer.byteLength(this.#stdoutBuffer, 'utf8') > MAX_LINE_BYTES && !this.#stdoutBuffer.includes('\n')) {
      this.#failPending(
        new AdapterError('oversized_frame', 'Claude provider emitted an oversized JSON line', {
          harnessId: this.harnessId,
        }),
      );
      this.#terminate('SIGKILL');
      return;
    }
    for (;;) {
      const newline = this.#stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.#stdoutBuffer.slice(0, newline);
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (line.trim().length === 0) continue;
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        this.#failPending(
          new AdapterError('oversized_frame', 'Claude provider emitted an oversized JSON line', {
            harnessId: this.harnessId,
          }),
        );
        this.#terminate('SIGKILL');
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch (cause) {
        this.#failPending(
          new AdapterError('malformed_frame', 'Claude provider emitted malformed JSON', {
            harnessId: this.harnessId,
            cause,
          }),
        );
        this.#terminate('SIGKILL');
        return;
      }
      this.#handleFrame(frame);
    }
  }

  #handleFrame(frame: unknown): void {
    const record = asRecord(frame);
    if (record === undefined) return;
    const pending = this.#pending;
    if (record['type'] === 'system' && record['subtype'] === 'init') {
      const sessionId = record['session_id'];
      if (typeof sessionId === 'string' && sessionId !== this.#nativeId) {
        this.#failPending(
          new AdapterError(
            'session_identity_mismatch',
            `Claude provider reported session '${sessionId}', expected '${this.#nativeId}'`,
            { harnessId: this.harnessId },
          ),
        );
        return;
      }
      if (typeof record['model'] === 'string') {
        this.#observedModel = record['model'];
        pending?.input.onUpdate?.({
          kind: 'config_option_update',
          configOptions: this.#configOptions(),
        });
      }
      return;
    }
    if (record['type'] === 'assistant') {
      const message = asRecord(record['message']);
      const content = message?.['content'];
      if (Array.isArray(content)) {
        for (const rawBlock of content) {
          const block = asRecord(rawBlock);
          if (block?.['type'] !== 'tool_use' || typeof block['name'] !== 'string') continue;
          const input = asRecord(block['input']);
          const rawCommand = input?.['command'];
          this.#toolInvocationObservations.push(
            Object.freeze({
              name: block['name'],
              inputKeys: Object.freeze(Object.keys(input ?? {}).sort()),
              ...(block['name'] === 'Bash' && typeof rawCommand === 'string'
                ? { command: rawCommand }
                : {}),
            }),
          );
        }
      }
      return;
    }
    if (record['type'] === 'stream_event') {
      this.#handleStreamEvent(asRecord(record['event']), pending);
      return;
    }
    if (record['type'] === 'rate_limit_event') {
      const observation = observeClaudeRateLimitEvent(record);
      this.#rateLimitObservations.push(observation);
      const { classification } = observation;
      if (classification.kind === 'usage_limit') {
        this.#failPending(
          new AdapterError('provider_error', 'Claude provider reported a usage limit', {
            harnessId: this.harnessId,
            envelope: record,
          }),
        );
      }
      return;
    }
    if (record['type'] !== 'result' || pending === undefined) return;
    this.#pending = undefined;
    if (record['is_error'] === true || record['subtype'] !== 'success') {
      pending.reject(
        new AdapterError(
          'provider_error',
          `Claude provider turn failed (${String(record['subtype'] ?? 'unknown')})`,
          { harnessId: this.harnessId, envelope: record },
        ),
      );
      return;
    }
    const usage = asRecord(record['usage']);
    const inputTokens =
      (finiteNumber(usage?.['input_tokens']) ?? 0) +
      (finiteNumber(usage?.['cache_creation_input_tokens']) ?? 0) +
      (finiteNumber(usage?.['cache_read_input_tokens']) ?? 0);
    const outputTokens = finiteNumber(usage?.['output_tokens']) ?? 0;
    const costUsd = finiteNumber(record['total_cost_usd']);
    pending.resolve({
      stopReason: record['stop_reason'] === 'max_tokens' ? 'max_tokens' : 'end_turn',
      usage: {
        inputTokens,
        outputTokens,
        ...(costUsd !== undefined ? { costUsd } : {}),
        source: 'adapter',
      },
    });
  }

  #handleStreamEvent(
    event: Record<string, unknown> | undefined,
    pending: PendingTurn | undefined,
  ): void {
    if (event === undefined || pending === undefined) return;
    if (event['type'] === 'content_block_start') {
      const index = finiteNumber(event['index']);
      const block = asRecord(event['content_block']);
      if (index !== undefined && block?.['type'] === 'tool_use' && typeof block['id'] === 'string') {
        pending.toolCalls.set(index, block['id']);
        pending.input.onUpdate?.({
          kind: 'tool_call',
          toolCallId: block['id'],
          ...(typeof block['name'] === 'string' ? { title: block['name'] } : {}),
          status: 'in_progress',
        });
      }
      return;
    }
    if (event['type'] === 'content_block_delta') {
      const delta = asRecord(event['delta']);
      if (delta?.['type'] === 'text_delta' && typeof delta['text'] === 'string') {
        pending.input.onUpdate?.({ kind: 'agent_message_chunk', text: delta['text'] });
      } else if (delta?.['type'] === 'thinking_delta' && typeof delta['thinking'] === 'string') {
        pending.input.onUpdate?.({ kind: 'agent_thought_chunk', text: delta['thinking'] });
      }
      return;
    }
    if (event['type'] === 'content_block_stop') {
      const index = finiteNumber(event['index']);
      const toolCallId = index !== undefined ? pending.toolCalls.get(index) : undefined;
      if (toolCallId !== undefined) {
        pending.input.onUpdate?.({ kind: 'tool_call_update', toolCallId, status: 'completed' });
      }
    }
  }

  #failPending(error: unknown): void {
    const pending = this.#pending;
    this.#pending = undefined;
    pending?.reject(error);
  }

  #terminate(signal: NodeJS.Signals): void {
    const pid = this.#child?.pid;
    if (pid === undefined) return;
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        this.#child?.kill(signal);
      } catch {
        // Already gone.
      }
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AdapterError('invalid_state', 'Claude provider adapter is closed', {
        harnessId: this.harnessId,
      });
    }
  }

  #requireInitialized(): void {
    this.#assertOpen();
    if (this.#capabilities === undefined) {
      throw new AdapterError('invalid_state', 'Claude provider adapter is not initialized', {
        harnessId: this.harnessId,
      });
    }
  }

  #requireSession(sessionId: AcpSessionId): void {
    this.#requireInitialized();
    if (!this.#sessionCreated || sessionId !== this.#acpId) {
      throw new AdapterError('session_not_found', `Unknown Claude provider session '${String(sessionId)}'`, {
        harnessId: this.harnessId,
      });
    }
  }
}

export function createClaudeProviderAdapter(
  options: ClaudeProviderAdapterOptions,
): CreatedClaudeProviderAdapter {
  const resolved =
    options.resolved ??
    resolveClaudeProviderCommand({ processEnv: options.processEnv ?? process.env });
  return {
    adapter: new ClaudeProviderAdapter({ ...options, resolved }),
    resolved,
  };
}
