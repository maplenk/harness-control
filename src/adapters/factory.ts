/**
 * Provider adapter factory (PLAN §5, §9, §10) — the composition seam that
 * assembles a ready-to-`initialize()` `AcpStdioAdapter` from a per-provider
 * ACP profile (PLAN §5: generic ACP stdio transport + per-harness profiles).
 * The profiles (`./claude`, `./codex`, `./opencode`, `./grok`) deliberately
 * never spawn anything and the generic transport/session (`./acp`)
 * deliberately knows nothing provider-specific; THIS module is where the two
 * meet:
 *
 * 1. **Command**: resolve the lockfile-pinned binary via the profile's
 *    resolver AND assert the §13 version pin (loud re-characterization
 *    trigger on drift — never a silent downgrade).
 * 2. **Credentials + spawn isolation** (§17.1): the transport's child-env
 *    allowlist strips provider API keys by design; the factory re-injects
 *    EXACTLY the provider's own documented key variable(s) when present —
 *    credentials only when the provider requires them, and only that
 *    provider's own. For CODEX the factory additionally prepares the H-1
 *    per-run isolated `CODEX_HOME` (see `codex/home-isolation.ts`) so the
 *    spawned core cannot inherit host-global provider config that would
 *    re-route approvals away from the ACP client. OpenCode receives an
 *    equivalent boundary through a fresh HOME/XDG tree, auth-only copy-in,
 *    `--pure`, disabled project/external config, and an ACP-routing
 *    permission overlay (see `opencode/home-isolation.ts`). (Claude
 *    watch-list, PLAN
 *    §17.1: the SDK child inherits user-global MCP servers despite
 *    `mcpServers:[]` — `CLAUDE_CONFIG_DIR`-class isolation is promoted only
 *    if that becomes load-bearing; not implemented here.)
 * 3. **Capability layering** (§9): the session adapter's `initialize()`
 *    builds a live wire-probed record; the factory contributes ONLY the
 *    provider-STATIC fields as `capabilityOverrides` (auth readiness,
 *    usage-limit reporting tier, retry-after tier, usage accounting,
 *    conflicting builtin tools, session-identity knowledge, executable
 *    identity, model mechanism). Wire-observed fields — protocol version,
 *    sessionOps, configOptions, permissionRequests, mcpConfig — are NOT
 *    overridden: what was actually observed on the wire stays authoritative.
 *    (`modelMechanism` IS static here: claude-agent-acp@0.59.0/codex-acp@1.1.4
 *    implement `session/set_config_option` — source-verified in the profile
 *    modules — but do not advertise it in `initialize()`'s agentCapabilities,
 *    so the wire heuristic under-reports; the raw probed view stays visible
 *    via `adapter.probedCapabilities`.)
 * 4. **Classification** (§13): wires the profile's own `classifyError`
 *    (structured provider conventions) into the SPI method.
 *
 * The factory never spawns a process; `initialize()` is the caller's
 * explicit act. Its only filesystem I/O is command resolution (reading the
 * installed package's `package.json` or first-party executable) plus the Codex/OpenCode/Grok H-1
 * isolated-home preparation (temp dir + orchestrator config +
 * auth-material byte copy — disposed via `adapter.close()`). Real-adapter
 * spawning belongs to the P2
 * live gate — offline tests exercise this factory against the fake child via
 * `spawnOverride` (documented below).
 */
import type { Clock } from '../lib/clock.js';
import { SystemClock } from '../lib/clock.js';
import type { RoleName } from '../domain/state.js';
import {
  AcpStdioAdapter,
  SpawnPinnedAcpAdapter,
  type AcpAdapterOptions,
  type AcpSpawnSpec,
  type AcpTransportLimits,
  type PermissionMediationConfig,
  type SessionModePolicy,
  type SpawnPinnedAcpAdapterOptions,
} from './acp/index.js';
import { AdapterError, type CapabilityRecord, type ErrorClassification } from './spi.js';
import {
  ANTHROPIC_API_KEY_ENV_VAR,
  CLAUDE_SESSION_MODE_POLICY,
  assertClaudeAdapterVersionPinned,
  buildClaudeCapabilityRecord,
  classifyClaudeError,
  probeClaudeAuthReadiness,
  CLAUDE_HARNESS_ID,
  // NOTE: `ResolvedAdapterCommand` is declared per provider package (claude/
  // codex own their command modules without a shared parent); the two
  // interfaces are structurally identical, so the claude declaration serves
  // as the factory-level type for both.
  type ResolvedAdapterCommand,
} from './claude/index.js';
import {
  CODEX_API_KEY_ENV_VAR,
  CODEX_HOME_ENV_VAR,
  CODEX_HARNESS_ID,
  CODEX_SESSION_MODE_POLICY,
  OPENAI_API_KEY_ENV_VAR,
  assertCodexAdapterVersionPinned,
  buildCodexCapabilityRecord,
  classifyCodexError,
  prepareCodexHomeIsolation,
  probeCodexAuthReadiness,
  type PreparedCodexHome,
} from './codex/index.js';
import {
  OPENCODE_HARNESS_ID,
  OPENCODE_SESSION_MODE_POLICY,
  assertOpenCodeVersionPinned,
  buildOpenCodeCapabilityRecord,
  classifyOpenCodeError,
  detectOpenCodeAuthMaterial,
  OPENCODE_ISOLATION_ENV_KEYS,
  prepareOpenCodeHomeIsolation,
  probeOpenCodeAuthReadiness,
  type PreparedOpenCodeHome,
} from './opencode/index.js';
import {
  GROK_HARNESS_ID,
  GROK_ISOLATION_ENV_KEYS,
  XAI_API_KEY_ENV_VAR,
  assertGrokMinimumVersion,
  assertSafeGrokInitializeExtensions,
  assertSafeGrokMcpServersUpdated,
  assertSafeGrokProjectConfig,
  buildGrokCapabilityRecord,
  classifyGrokError,
  grokShellPermissionTitle,
  isGrokReadOnlyShellPermissionTitle,
  prepareGrokHomeIsolation,
  probeGrokAuthReadiness,
  type PreparedGrokHome,
} from './grok/index.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------
export interface CreateProviderAdapterOptions {
  /** Working directory for the spawned agent process. */
  readonly cwd?: string;
  readonly clock?: Clock;
  /** §10.1 identity nonce; generated by the transport when omitted. */
  readonly spawnId?: string;
  readonly limits?: Partial<AcpTransportLimits>;
  readonly permissions?: PermissionMediationConfig;
  /**
   * P-1 session-mode pinning policy override. Defaults to the provider
   * profile's normative policy (claude: `session/set_mode` `'default'` for
   * every role; codex: config option `mode` = `read-only` for
   * coordinator/verifier, `agent` for implementor). Overriding is a test/dev
   * seam — production callers keep the profile policy.
   */
  readonly sessionMode?: SessionModePolicy;
  /**
   * Extra child env, layered over credential forwarding. Isolation-owned
   * keys (for example CODEX_HOME and OpenCode's HOME/XDG policy) cannot be
   * supplied here.
   */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Environment consulted for credential forwarding + auth-readiness
   * probing. Defaults to `process.env`; injectable for deterministic tests.
   */
  readonly processEnv?: NodeJS.ProcessEnv;
  /** Start dir for the upward lockfile-pinned `node_modules` search. */
  readonly resolveFromDir?: string;
  /**
   * TEST/DEV SEAM: spawn THIS spec instead of the resolved pinned binary
   * (e.g. the fake ACP child), while command resolution + the version-pin
   * assertion still run so provider identity stays honest. Offline suites
   * use it because real adapters are never spawned outside the live gate.
   * The factory-assembled child env (credentials + §17.1 isolation env) is
   * merged under the override's own env. Isolation-owned keys cannot be
   * supplied by the override.
   */
  readonly spawnOverride?: AcpSpawnSpec;
  /**
   * §17.1 H-1 — codex spawn isolation controls (codex factory only; ignored
   * by claude). Default: `mode:'isolated'` — every codex spawn gets a
   * per-run isolated `CODEX_HOME` (0700) carrying ONLY the copied
   * `auth.json` (0600, inherited ChatGPT/Codex subscription login) plus the
   * orchestrator-owned `config.toml` that routes approvals to the ACP
   * client (`approvals_reviewer="user"`) and pins the per-role sandbox
   * baseline. `mode:'inherit_host'` disables isolation — TEST/DEV ONLY (it
   * reproduces the live H-1 bypass class: the child reads the host's
   * user-global `~/.codex/config.toml`, whose `approvals_reviewer` can
   * replace the ACP client as the approval authority). Tests MUST set
   * `realCodexHome` to a fixture — never the developer's real `~/.codex`.
   */
  readonly codexHome?: {
    readonly mode?: 'isolated' | 'inherit_host';
    readonly realCodexHome?: string;
    readonly tempRoot?: string;
  };
  /**
   * OpenCode H-1 isolation controls. Production defaults to `isolated`.
   * `inherit_host` exists only to reproduce/characterize the unsafe legacy
   * behavior in tests and diagnostics.
   */
  readonly openCodeHome?: {
    readonly mode?: 'isolated' | 'inherit_host';
    readonly realHome?: string;
    readonly tempRoot?: string;
  };
}

/**
 * Grok Build pins model, effort, and the role sandbox in process argv because
 * its ACP v1 server does not expose mutable config or mode setters.
 */
export interface CreateGrokBuildAcpAdapterOptions extends CreateProviderAdapterOptions {
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly role?: RoleName;
  /** Exact approved commands the implementor may run while self-checking. */
  readonly allowedShellCommands?: readonly string[];
  /** Production defaults to an isolated HOME/GROK_HOME containing auth only. */
  readonly grokHome?: {
    readonly mode?: 'isolated' | 'inherit_host';
    readonly realHome?: string;
    readonly tempRoot?: string;
  };
}

export interface CreatedProviderAdapter {
  readonly adapter: AcpStdioAdapter;
  /** The lockfile-pinned command that was resolved (and version-asserted). */
  readonly resolved: ResolvedAdapterCommand;
  /** The exact spec the adapter will spawn (§17.1: inspectable, incl. which
   * credential vars were forwarded — values live only inside `env`). */
  readonly spawn: AcpSpawnSpec;
  /** The profile's full static capability record (offline knowledge). */
  readonly staticCapabilities: CapabilityRecord;
  /** Exactly the provider-static subset passed as `capabilityOverrides`. */
  readonly overrides: Partial<CapabilityRecord>;
  /**
   * §17.1 H-1: the per-run isolated CODEX_HOME backing this adapter (codex
   * with isolation active only). Disposal is wired to `adapter.close()`;
   * `dispose()` stays callable directly (idempotent) for abnormal paths.
   */
  readonly codexHome?: PreparedCodexHome;
  /** Per-run isolated OpenCode HOME/XDG tree (OpenCode only). */
  readonly openCodeHome?: PreparedOpenCodeHome;
  /** Per-run isolated HOME/GROK_HOME tree (Grok Build only). */
  readonly grokHome?: PreparedGrokHome;
}

// ---------------------------------------------------------------------------
// Provider-static capability subset (§9 layering rule — see module header)
// ---------------------------------------------------------------------------
/**
 * Picks the fields of a profile's static `CapabilityRecord` that represent
 * PROVIDER knowledge rather than wire observations. This is the single
 * documented answer to "which side wins" for every CapabilityRecord field
 * when a profile and a live probe disagree (the session adapter spreads
 * these over its probed record).
 */
export function providerStaticOverrides(
  record: CapabilityRecord,
  resolvedPath: string,
): Partial<CapabilityRecord> {
  return {
    executable: {
      ...(record.executable.packageName !== undefined
        ? { packageName: record.executable.packageName }
        : {}),
      version: record.executable.version,
      resolvedPath,
    },
    auth: record.auth,
    modelMechanism: record.modelMechanism,
    usageLimitReporting: record.usageLimitReporting,
    retryAfterTier: record.retryAfterTier,
    usageAccounting: record.usageAccounting,
    conflictingBuiltinTools: record.conflictingBuiltinTools,
    sessionIdentity: record.sessionIdentity,
  };
}

// ---------------------------------------------------------------------------
// Shared assembly
// ---------------------------------------------------------------------------
interface ProviderWiring {
  readonly harnessId: string;
  readonly resolve: (fromDir: string | undefined) => ResolvedAdapterCommand;
  readonly credentialEnvVars: readonly string[];
  readonly buildStaticRecord: (
    executable: CapabilityRecord['executable'],
    clock: Clock,
    processEnv: NodeJS.ProcessEnv,
  ) => CapabilityRecord;
  readonly classifyError: (raw: unknown, clock: Clock) => ErrorClassification;
  /** Provider extension metadata that must fail closed before use. */
  readonly initializeGuard?: AcpAdapterOptions['initializeGuard'];
  readonly notificationGuard?: AcpAdapterOptions['notificationGuard'];
  /** Immutable model/reasoning values already present in the child argv. */
  readonly spawnPins?: Pick<SpawnPinnedAcpAdapterOptions, 'model' | 'reasoning'>;
  /** P-1: the provider's normative per-role session-mode pinning policy.
   * Omitted for providers such as Grok Build whose role/model policy is
   * fixed in process argv and whose ACP server advertises no session mode. */
  readonly sessionModePolicy?: SessionModePolicy;
  /** §17.1 H-1: isolation env layered over credentials, under caller env for
   * non-protected keys. Per-call, closed over by the provider factory. */
  readonly spawnEnv?: Readonly<Record<string, string>>;
  /** Isolation-owned keys that caller/override env must never replace. */
  readonly protectedSpawnEnvKeys?: readonly string[];
  /** §17.1 H-1: resource disposal wired into `adapter.close()` (idempotent). */
  readonly onClose?: () => void | Promise<void>;
}

function createProviderAdapter(
  wiring: ProviderWiring,
  options: CreateProviderAdapterOptions,
): CreatedProviderAdapter {
  const clock = options.clock ?? new SystemClock();
  const processEnv = options.processEnv ?? process.env;

  // 1. Lockfile-pinned resolution + loud §13 version-pin assertion.
  const resolved = wiring.resolve(options.resolveFromDir);

  // 2. §17.1 credential forwarding: only this provider's own documented
  //    key variable(s), only when present and non-empty. Layering (last
  //    wins): credentials → provider isolation env → caller env for
  //    non-protected keys. Isolation-owned keys are rejected below.
  const credentialEnv: Record<string, string> = {};
  for (const name of wiring.credentialEnvVars) {
    const value = processEnv[name];
    if (typeof value === 'string' && value.length > 0) credentialEnv[name] = value;
  }
  for (const key of wiring.protectedSpawnEnvKeys ?? []) {
    if (
      Object.prototype.hasOwnProperty.call(options.env ?? {}, key) ||
      Object.prototype.hasOwnProperty.call(options.spawnOverride?.env ?? {}, key)
    ) {
      throw new AdapterError(
        'invalid_argument',
        `Child env '${key}' is owned by ${wiring.harnessId} spawn isolation and cannot be overridden`,
        { harnessId: wiring.harnessId },
      );
    }
  }
  const childEnv = { ...credentialEnv, ...(wiring.spawnEnv ?? {}), ...(options.env ?? {}) };

  // The factory-assembled env applies to the spawnOverride seam too (merged
  // UNDER the override's own non-protected env) — H-1 isolation must remain
  // testable against the fake child exactly as it ships for real spawns.
  const spawn: AcpSpawnSpec =
    options.spawnOverride !== undefined
      ? {
          ...options.spawnOverride,
          ...(Object.keys(childEnv).length > 0 || options.spawnOverride.env !== undefined
            ? { env: { ...childEnv, ...(options.spawnOverride.env ?? {}) } }
            : {}),
        }
      : {
          command: resolved.command,
          args: resolved.args,
          ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
          ...(Object.keys(childEnv).length > 0 ? { env: childEnv } : {}),
        };
  // The path actually spawned (override-aware) keeps `executable` honest.
  const spawnedPath = options.spawnOverride?.args[0] ?? resolved.binPath;

  // 3. Provider-static capability layering (see providerStaticOverrides).
  const staticCapabilities = wiring.buildStaticRecord(
    { packageName: resolved.packageName, version: resolved.version, resolvedPath: resolved.binPath },
    clock,
    processEnv,
  );
  const overrides = providerStaticOverrides(staticCapabilities, spawnedPath);
  const sessionMode = options.sessionMode ?? wiring.sessionModePolicy;

  const adapterOptions: AcpAdapterOptions = {
    harnessId: wiring.harnessId,
    spawn,
    clock,
    ...(options.spawnId !== undefined ? { spawnId: options.spawnId } : {}),
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
    // 5. P-1: NORMATIVE per-role session-mode pinning at session setup (the
    //    profile policy unless the caller's test/dev override says otherwise).
    ...(sessionMode !== undefined ? { sessionMode } : {}),
    capabilityOverrides: overrides,
    // 4. §13 provider classifier on the SPI surface.
    classifyError: wiring.classifyError,
    ...(wiring.initializeGuard !== undefined
      ? { initializeGuard: wiring.initializeGuard }
      : {}),
    ...(wiring.notificationGuard !== undefined
      ? { notificationGuard: wiring.notificationGuard }
      : {}),
    // 6. §17.1 H-1: dispose factory-owned spawn resources on close.
    ...(wiring.onClose !== undefined ? { onClose: wiring.onClose } : {}),
  };

  const adapter =
    wiring.spawnPins !== undefined
      ? new SpawnPinnedAcpAdapter({ ...adapterOptions, ...wiring.spawnPins })
      : new AcpStdioAdapter(adapterOptions);
  return { adapter, resolved, spawn, staticCapabilities, overrides };
}

// ---------------------------------------------------------------------------
// Public factories
// ---------------------------------------------------------------------------
/** Claude ACP profile × generic stdio transport (PLAN §5, §10). */
export function createClaudeAcpAdapter(
  options: CreateProviderAdapterOptions = {},
): CreatedProviderAdapter {
  return createProviderAdapter(
    {
      harnessId: CLAUDE_HARNESS_ID,
      resolve: (fromDir) =>
        assertClaudeAdapterVersionPinned(fromDir !== undefined ? { fromDir } : {}),
      credentialEnvVars: [ANTHROPIC_API_KEY_ENV_VAR],
      buildStaticRecord: (executable, clock, processEnv) =>
        buildClaudeCapabilityRecord({
          executable,
          clock,
          auth: probeClaudeAuthReadiness(processEnv),
        }),
      classifyError: classifyClaudeError,
      sessionModePolicy: CLAUDE_SESSION_MODE_POLICY,
    },
    options,
  );
}

/**
 * Codex ACP profile × generic stdio transport (PLAN §5, §10) — WITH §17.1
 * H-1 spawn isolation by default: prepares a per-run isolated `CODEX_HOME`
 * (orchestrator-owned `config.toml` routing approvals to the ACP client +
 * the byte-copied `auth.json` carrying the inherited ChatGPT/Codex
 * subscription login) and injects `CODEX_HOME` into the child env, so the
 * spawned core CANNOT inherit `~/.codex/config.toml`'s
 * `approvals_reviewer="auto_review"` (the live-gate permission bypass).
 * This is the one factory path that performs filesystem I/O at creation
 * time (documented H-1 exception to the "no I/O beyond command resolution"
 * rule); disposal is wired to `adapter.close()`. NO ACP `authenticate` call
 * is made for the ChatGPT path — see `CODEX_ACP_AUTH_METHOD_CHATGPT`'s doc
 * for the source-verified decision (the login rides the isolated home's
 * `auth.json`; the optional SPI `authenticate` seam remains available for
 * the `api-key` path).
 */
export function createCodexAcpAdapter(
  options: CreateProviderAdapterOptions = {},
): CreatedProviderAdapter {
  const isolationMode = options.codexHome?.mode ?? 'isolated';
  const prepared: PreparedCodexHome | undefined =
    isolationMode === 'isolated'
      ? prepareCodexHomeIsolation({
          ...(options.codexHome?.realCodexHome !== undefined
            ? { realCodexHome: options.codexHome.realCodexHome }
            : {}),
          ...(options.codexHome?.tempRoot !== undefined
            ? { tempRoot: options.codexHome.tempRoot }
            : {}),
          ...(options.permissions?.role !== undefined ? { role: options.permissions.role } : {}),
        })
      : undefined;
  try {
    const created = createProviderAdapter(
      {
        harnessId: CODEX_HARNESS_ID,
        resolve: (fromDir) =>
          assertCodexAdapterVersionPinned(fromDir !== undefined ? { fromDir } : {}),
        credentialEnvVars: [CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR],
        ...(prepared !== undefined
          ? {
              spawnEnv: prepared.env,
              protectedSpawnEnvKeys: [CODEX_HOME_ENV_VAR],
              onClose: prepared.dispose,
            }
          : {}),
        buildStaticRecord: (executable, clock, processEnv) =>
          buildCodexCapabilityRecord({
            executable,
            clock,
            // H-2: presence (env keys OR carried auth.json) is never more
            // than detected_but_unvalidated; `supported` needs turn evidence.
            auth: probeCodexAuthReadiness(processEnv, {
              authMaterialDetected: prepared?.authMaterial === 'auth_json',
            }),
          }),
        classifyError: classifyCodexError,
        sessionModePolicy: CODEX_SESSION_MODE_POLICY,
      },
      options,
    );
    return { ...created, ...(prepared !== undefined ? { codexHome: prepared } : {}) };
  } catch (error) {
    // Never leak a temp dir holding copied auth material on a failed build.
    prepared?.dispose();
    throw error;
  }
}

/**
 * OpenCode's native ACP server × the generic stdio transport, isolated by
 * default. A fresh HOME/XDG tree carries only a byte-copy of the OpenCode auth
 * store and orchestrator-owned config. `--pure`, disabled project/external
 * config, and the final permission overlay keep ACP as the approval authority.
 */
export function createOpenCodeAcpAdapter(
  options: CreateProviderAdapterOptions = {},
): CreatedProviderAdapter {
  const processEnv = options.processEnv ?? process.env;
  const isolationMode = options.openCodeHome?.mode ?? 'isolated';
  const authHome = options.openCodeHome?.realHome ?? processEnv['HOME'];
  const prepared: PreparedOpenCodeHome | undefined =
    isolationMode === 'isolated'
      ? prepareOpenCodeHomeIsolation({
          ...(authHome !== undefined ? { realHome: authHome } : {}),
          ...(options.openCodeHome?.tempRoot !== undefined
            ? { tempRoot: options.openCodeHome.tempRoot }
            : {}),
          ...(options.permissions?.role !== undefined ? { role: options.permissions.role } : {}),
        })
      : undefined;
  const authMaterialDetected =
    prepared?.authMaterial === 'auth_json' ||
    (prepared === undefined && authHome !== undefined && detectOpenCodeAuthMaterial(authHome));
  try {
    const created = createProviderAdapter(
      {
        harnessId: OPENCODE_HARNESS_ID,
        resolve: (fromDir) =>
          assertOpenCodeVersionPinned(fromDir !== undefined ? { fromDir } : {}),
        credentialEnvVars: [],
        ...(prepared !== undefined
          ? {
              spawnEnv: prepared.env,
              protectedSpawnEnvKeys: OPENCODE_ISOLATION_ENV_KEYS,
              onClose: prepared.dispose,
            }
          : {}),
        buildStaticRecord: (executable, clock) =>
          buildOpenCodeCapabilityRecord({
            executable,
            clock,
            auth: probeOpenCodeAuthReadiness({ authMaterialDetected }),
          }),
        classifyError: classifyOpenCodeError,
        sessionModePolicy: OPENCODE_SESSION_MODE_POLICY,
      },
      options,
    );
    return { ...created, ...(prepared !== undefined ? { openCodeHome: prepared } : {}) };
  } catch (error) {
    prepared?.dispose();
    throw error;
  }
}

/**
 * First-party Grok Build ACP server × generic stdio transport. The child gets
 * an auth-only HOME/GROK_HOME, immutable model/effort argv pins, and a
 * role-specific process sandbox. Project sources that can add executable
 * integrations or widen permissions are refused before any process is
 * spawned; provider extension metadata is separately guarded on the wire.
 */
export function createGrokBuildAcpAdapter(
  options: CreateGrokBuildAcpAdapterOptions,
): CreatedProviderAdapter {
  if (options.model.length === 0) {
    throw new AdapterError('invalid_argument', 'Grok Build model must not be empty', {
      harnessId: GROK_HARNESS_ID,
    });
  }

  const processEnv = options.processEnv ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const role = options.role ?? options.permissions?.role;
  if (
    options.role !== undefined &&
    options.permissions?.role !== undefined &&
    options.role !== options.permissions.role
  ) {
    throw new AdapterError('invalid_argument', 'Grok Build role and permission role must match', {
      harnessId: GROK_HARNESS_ID,
    });
  }
  assertSafeGrokProjectConfig(cwd);

  const permissions: PermissionMediationConfig | undefined =
    role === 'implementor' && options.permissions?.mode === 'headless'
      ? {
          ...options.permissions,
          policy: {
            allow: [
              ...new Set([
                ...(options.permissions.policy?.allow ?? []),
                ...(options.allowedShellCommands ?? []).map(grokShellPermissionTitle),
              ]),
            ],
            allowReadOnlyOperation: isGrokReadOnlyShellPermissionTitle,
            workspaceWriteRoot: cwd,
          },
        }
      : options.permissions;
  const providerOptions: CreateProviderAdapterOptions = {
    ...options,
    ...(permissions !== undefined ? { permissions } : {}),
  };

  const isolationMode = options.grokHome?.mode ?? 'isolated';
  const authHome = options.grokHome?.realHome ?? processEnv['HOME'];
  const prepared: PreparedGrokHome | undefined =
    isolationMode === 'isolated'
      ? prepareGrokHomeIsolation({
          ...(authHome !== undefined ? { realHome: authHome } : {}),
          ...(options.grokHome?.tempRoot !== undefined
            ? { tempRoot: options.grokHome.tempRoot }
            : {}),
          ...(role !== undefined ? { role } : {}),
        })
      : undefined;

  try {
    const created = createProviderAdapter(
      {
        harnessId: GROK_HARNESS_ID,
        resolve: () =>
          assertGrokMinimumVersion({
            env: processEnv,
            cwd,
            model: options.model,
            ...(options.reasoningEffort !== undefined
              ? { reasoningEffort: options.reasoningEffort }
              : {}),
            ...(role !== undefined ? { role } : {}),
          }),
        credentialEnvVars: [XAI_API_KEY_ENV_VAR],
        ...(prepared !== undefined
          ? {
              spawnEnv: prepared.env,
              protectedSpawnEnvKeys: GROK_ISOLATION_ENV_KEYS,
              onClose: prepared.dispose,
            }
          : {}),
        buildStaticRecord: (executable, clock, env) =>
          buildGrokCapabilityRecord({
            executable,
            clock,
            auth: probeGrokAuthReadiness(env, {
              authMaterialDetected: prepared?.authMaterial === 'auth_json',
            }),
          }),
        classifyError: classifyGrokError,
        initializeGuard: assertSafeGrokInitializeExtensions,
        notificationGuard: (method, params) => {
          if (method === '_x.ai/mcp/servers_updated') assertSafeGrokMcpServersUpdated(params);
        },
        spawnPins: {
          model: options.model,
          ...(options.reasoningEffort !== undefined
            ? {
                reasoning: {
                  optionId: 'reasoning_effort',
                  value: options.reasoningEffort,
                },
              }
            : {}),
        },
      },
      providerOptions,
    );
    return { ...created, ...(prepared !== undefined ? { grokHome: prepared } : {}) };
  } catch (error) {
    prepared?.dispose();
    throw error;
  }
}
