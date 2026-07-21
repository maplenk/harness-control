/**
 * `harness doctor` (PLAN §18): "adapters, versions, auth status,
 * ACP handshake, git, sqlite, quotas" — with stable `--json` — plus the
 * §17.1 H-1 host provider-config safety flags. Auth reporting follows the
 * §17.1 H-2 evidence-honest 4-state vocabulary.
 *
 * Every check is READ-ONLY and offline-deterministic:
 *  - **Adapters** (§3, §17.1): Claude resolves the user's installed
 *    first-party `claude` provider and enforces the characterized minimum
 *    version; Grok resolves the user's installed first-party `grok` provider
 *    and enforces its characterized minimum; Codex ACP and OpenCode remain
 *    lockfile-pinned local packages.
 *    No adapter uses `npx -y`. Provenance is reported,
 *    including codex-acp's platform binary arriving via lockfile-pinned
 *    `optionalDependencies` with no postinstall (§17.1).
 *  - **Auth** (§3/D2 + §17.1 live-gate H-2 — evidence-honest, never
 *    presence-based `supported`): the P2 gate proved a present, forwarded
 *    `OPENAI_API_KEY` can be 401-invalid while sessions actually ride the
 *    inherited `~/.codex` ChatGPT login — so PRESENCE (env key, or on-disk
 *    credential artifacts checked for presence only, never opened/parsed/
 *    mutated) reports at most `detected_but_unvalidated`; `supported`
 *    requires a recorded successful provider turn, which a static doctor run
 *    never has. OpenCode's `auth.json` is treated the same way: provider
 *    credentials from `opencode auth login` are detected without reading the
 *    file, and remain unvalidated until a turn succeeds. Claude's native
 *    provider owns its subscription/keychain authentication; the harness
 *    never forwards `ANTHROPIC_API_KEY`. On-disk Claude state is therefore
 *    `detected_but_unvalidated` until a provider turn succeeds. Codex's
 *    `~/.codex/auth.json` (ChatGPT/Codex subscription login — the real path
 *    on this machine, H-1 isolation copies it into spawned children) →
 *    `detected_but_unvalidated`. Nothing found → honest `unknown`.
 *    Grok's `~/.grok/auth.json` is handled identically for SuperGrok: doctor
 *    checks presence only, while spawned children receive an isolated copy.
 *  - **Host config safety (H-1)**: `~/.codex/config.toml` is read
 *    READ-ONLY and FLAGGED (warn, never mutated) when `approvals_reviewer`
 *    is anything but the safe client-routing `"user"` — `auto_review` /
 *    `guardian_subagent` re-route approval requests to a provider-side
 *    reviewer (the live-gate permission bypass). Spawn-time CODEX_HOME
 *    isolation protects orchestrator-spawned children; the flag covers any
 *    NON-isolated codex use on the host.
 *  - **ACP handshake**: performed against the FAKE ACP child
 *    (`src/adapters/fake/fake-acp-child.mjs`) through the real
 *    `AcpStdioTransport`/`AcpStdioAdapter` stack — this validates OUR wire
 *    machinery end-to-end (spawn, §10.1 nonce echo, §10.2 bounds,
 *    capability probe) without spawning a real provider. The REAL adapter
 *    handshake is deliberately NOT run here: that is the P2 live
 *    compatibility gate (PLAN §3, §20), which requires explicit approval.
 *  - **Git**: `git --version` (spawn, read-only).
 *  - **SQLite** (§12.1): opens a throwaway database file under a temp dir
 *    through the real `openDatabase` (default driver better-sqlite3), reads
 *    back the normative pragmas (WAL, foreign_keys, busy_timeout), reports
 *    whether the `node:sqlite` contract-test driver is available, then
 *    deletes the temp dir.
 *  - **Quotas** (§12.1): the effective artifact quotas from the engine
 *    config (defaults, or `--config FILE`), with all validation issues
 *    reported at once.
 *
 * Overall verdict: `fail` when a structural check fails (adapter
 * resolution/pin, handshake, git, sqlite, config file); `warn` when
 * everything structural passes but no provider has VALIDATED (`supported`)
 * auth evidence — which a static doctor run never has (H-2) — or when the
 * host-config safety check flags a dangerous `approvals_reviewer`; `ok`
 * otherwise.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { SystemClock, type Clock, type IsoTimestamp } from '../lib/clock.js';
import { isOk } from '../lib/result.js';
import {
  CLAUDE_HARNESS_ID,
  CLAUDE_PROVIDER_BIN_NAME,
  CLAUDE_PROVIDER_PACKAGE_NAME,
  MIN_CLAUDE_PROVIDER_VERSION,
  checkClaudeProviderVersion,
  tryResolveClaudeProviderCommand,
} from '../adapters/claude/index.js';
import {
  CODEX_API_KEY_ENV_VAR,
  CODEX_BIN_NAME,
  CODEX_HARNESS_ID,
  CODEX_PACKAGE_NAME,
  CODEX_SAFE_APPROVALS_REVIEWER,
  EXPECTED_CODEX_ADAPTER_VERSION,
  OPENAI_API_KEY_ENV_VAR,
  checkCodexHostApprovalsConfig,
  probeCodexAuthReadiness,
  tryResolveCodexCommand,
} from '../adapters/codex/index.js';
import { checkVersionPin as checkCodexVersionPin } from '../adapters/codex/command.js';
import {
  GROK_BIN_NAME,
  GROK_HARNESS_ID,
  GROK_PACKAGE_NAME,
  MINIMUM_GROK_VERSION,
  XAI_API_KEY_ENV_VAR,
  checkGrokMinimumVersion,
  grokAuthJsonPath,
  probeGrokAuthReadiness,
  tryResolveGrokCommand,
} from '../adapters/grok/index.js';
import {
  EXPECTED_OPENCODE_VERSION,
  OPENCODE_BIN_NAME,
  OPENCODE_HARNESS_ID,
  OPENCODE_PACKAGE_NAME,
  openCodeAuthJsonPath,
  probeOpenCodeAuthReadiness,
  tryResolveOpenCodeCommand,
} from '../adapters/opencode/index.js';
import { checkVersionPin as checkOpenCodeVersionPin } from '../adapters/opencode/command.js';
import type { AuthReadiness } from '../adapters/spi.js';
import { AcpStdioAdapter } from '../adapters/acp/index.js';
import { fakeAcpChildPath, writeScenarioFile } from '../adapters/fake/index.js';
import { openDatabase, isNodeSqliteAvailable } from '../persistence/database.js';
import {
  loadEngineConfigFromFile,
  parseEngineConfig,
  type ConfigIssue,
} from '../config/loader.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Report shapes (stable `--json` surface, §18)
// ---------------------------------------------------------------------------
export interface DoctorAdapterReport {
  readonly harnessId: string;
  readonly packageName: string;
  readonly binName: string;
  readonly expectedVersion: string;
  readonly resolved: boolean;
  readonly installedVersion?: string;
  readonly binPath?: string;
  readonly packageDir?: string;
  /** §13: fixture conventions are version-specific; drift fails doctor. */
  readonly versionPinned?: boolean;
  readonly issues: readonly string[];
  readonly provenance: string;
  /** Spawn-time boundary that prevents host config from widening access. */
  readonly isolation: string;
}

export interface DoctorAuthReport {
  readonly provider: string;
  readonly readiness: AuthReadiness;
  /** What produced the verdict (env var present, which artifact found, …). */
  readonly evidence: readonly string[];
  /** Everything consulted, found or not (all READ-ONLY presence checks). */
  readonly checked: {
    readonly envVars: readonly string[];
    readonly paths: readonly string[];
  };
  readonly note: string;
}

/** H-1 host-config safety section (read-only; never mutates `~/.codex`). */
export interface DoctorHostConfigReport {
  readonly codex: {
    readonly configPath: string;
    readonly exists: boolean;
    /** Every `approvals_reviewer` value found in the file (document order). */
    readonly approvalsReviewers: readonly string[];
    /** false when any routing signal is not the safe client-routing value. */
    readonly safe: boolean;
    readonly issues: readonly string[];
    readonly note: string;
  };
}

export interface DoctorHandshakeReport {
  /** Always 'fake' here — the REAL handshake is the P2 live gate (§20). */
  readonly target: 'fake';
  readonly ok: boolean;
  readonly durationMs?: number;
  readonly protocolVersion?: string;
  /** §10.1 identity nonce echoed by the child. */
  readonly spawnIdEchoed?: boolean;
  readonly error?: string;
  readonly note: string;
}

export interface DoctorGitReport {
  readonly available: boolean;
  readonly version?: string;
  readonly error?: string;
}

export interface DoctorSqliteReport {
  readonly ok: boolean;
  readonly driver: string;
  readonly pragmas?: {
    readonly journalMode: string;
    readonly foreignKeys: boolean;
    readonly busyTimeoutMs: number;
  };
  /** §3/D6: whether the `node:sqlite` contract-test driver can load here. */
  readonly nodeSqliteAvailable: boolean;
  readonly error?: string;
}

export interface DoctorQuotasReport {
  readonly source: 'defaults' | 'file';
  readonly configPath?: string;
  readonly perRunBytes?: number;
  readonly globalBytes?: number;
  readonly issues: readonly ConfigIssue[];
}

export type DoctorOverall = 'ok' | 'warn' | 'fail';

export interface DoctorReport {
  readonly generatedAt: IsoTimestamp;
  readonly overall: DoctorOverall;
  readonly adapters: readonly DoctorAdapterReport[];
  readonly auth: readonly DoctorAuthReport[];
  /** H-1: host provider-config safety (read-only flags, never mutations). */
  readonly hostConfig: DoctorHostConfigReport;
  readonly acpHandshake: DoctorHandshakeReport;
  readonly git: DoctorGitReport;
  readonly sqlite: DoctorSqliteReport;
  readonly quotas: DoctorQuotasReport;
  readonly notes: readonly string[];
}

export interface DoctorOptions {
  /** Injectable for deterministic tests; defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Injectable for deterministic tests; defaults to `os.homedir()`. */
  readonly homeDir?: string;
  readonly clock?: Clock;
  /** `--config FILE` → quota section reads this engine config file. */
  readonly configPath?: string;
  /** Start dir for lockfile-pinned adapter resolution (tests). */
  readonly resolveFromDir?: string;
  /** Injectable native Claude resolution; keeps doctor tests offline. */
  readonly claudeProviderResolver?: () => ReturnType<typeof tryResolveClaudeProviderCommand>;
  /** Injectable first-party Grok resolution; keeps doctor tests offline. */
  readonly grokProviderResolver?: () => ReturnType<typeof tryResolveGrokCommand>;
  /** Handshake bound for the fake-adapter check (default 15s, §10.2). */
  readonly handshakeTimeoutMs?: number;
  /** Injectable for deterministic tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------
const LOCKFILE_PROVENANCE =
  'resolved from the installed lockfile-pinned package via its own package.json bin ' +
  '(never npx -y; PLAN §3/§17.1)';
const CLAUDE_PROVIDER_PROVENANCE =
  'resolved from the installed first-party Claude Code CLI on PATH (or CLAUDE_PROVIDER_BIN); ' +
  'never npx -y; the harness uses its native subscription/keychain provider directly and never routes Claude through an API-key ACP adapter';
const CLAUDE_PROVIDER_ISOLATION =
  'native stream-json spawn pins --safe-mode, empty strict MCP config, role-scoped tools, and dontAsk/acceptEdits permission mode; verify live with `npm run smoke:claude:provider`';
const CODEX_ISOLATION =
  'per-run CODEX_HOME carries auth.json plus orchestrator config; caller and spawn-override CODEX_HOME replacement is rejected';
const GROK_PROVIDER_PROVENANCE =
  'resolved from the installed first-party Grok Build CLI on PATH (or GROK_PROVIDER_BIN); ' +
  'never npx -y; the harness uses its native ACP server and SuperGrok subscription login';
const GROK_PROVIDER_ISOLATION =
  'per-run GROK_HOME carries only auth.json plus orchestrator policy; model/effort and role sandbox are pinned, leader sharing/memory/subagents/host extensions are disabled, and permission-bearing project config is rejected before spawn; verify live with `npm run smoke:grok:isolation`';
const OPENCODE_ISOLATION =
  'per-run HOME/XDG carries auth only; `acp --pure`, project/external config disabled, empty MCP/plugins, and protected OPENCODE_PERMISSION keep ACP authoritative; verify live with `npm run smoke:opencode:isolation`';

function claudeProviderAdapterReport(
  resolve: () => ReturnType<typeof tryResolveClaudeProviderCommand>,
): DoctorAdapterReport {
  const result = resolve();
  if (!isOk(result)) {
    return {
      harnessId: CLAUDE_HARNESS_ID,
      packageName: CLAUDE_PROVIDER_PACKAGE_NAME,
      binName: CLAUDE_PROVIDER_BIN_NAME,
      expectedVersion: MIN_CLAUDE_PROVIDER_VERSION,
      resolved: false,
      issues: [result.error.message],
      provenance: CLAUDE_PROVIDER_PROVENANCE,
      isolation: CLAUDE_PROVIDER_ISOLATION,
    };
  }
  const resolved = result.value;
  const compatible = checkClaudeProviderVersion(resolved.version);
  return {
    harnessId: CLAUDE_HARNESS_ID,
    packageName: CLAUDE_PROVIDER_PACKAGE_NAME,
    binName: CLAUDE_PROVIDER_BIN_NAME,
    expectedVersion: MIN_CLAUDE_PROVIDER_VERSION,
    resolved: true,
    installedVersion: resolved.version,
    binPath: resolved.binPath,
    packageDir: resolved.packageDir,
    versionPinned: compatible.pinned,
    issues: compatible.pinned
      ? []
      : [
          `unsupported Claude provider version ${resolved.version}; minimum characterized version is ${MIN_CLAUDE_PROVIDER_VERSION}`,
        ],
    provenance: CLAUDE_PROVIDER_PROVENANCE,
    isolation: CLAUDE_PROVIDER_ISOLATION,
  };
}

function grokProviderAdapterReport(
  resolve: () => ReturnType<typeof tryResolveGrokCommand>,
): DoctorAdapterReport {
  const result = resolve();
  if (!isOk(result)) {
    return {
      harnessId: GROK_HARNESS_ID,
      packageName: GROK_PACKAGE_NAME,
      binName: GROK_BIN_NAME,
      expectedVersion: MINIMUM_GROK_VERSION,
      resolved: false,
      issues: [result.error.message],
      provenance: GROK_PROVIDER_PROVENANCE,
      isolation: GROK_PROVIDER_ISOLATION,
    };
  }
  const resolved = result.value;
  const compatible = checkGrokMinimumVersion(resolved.version);
  return {
    harnessId: GROK_HARNESS_ID,
    packageName: resolved.packageName,
    binName: GROK_BIN_NAME,
    expectedVersion: MINIMUM_GROK_VERSION,
    resolved: true,
    installedVersion: resolved.version,
    binPath: resolved.binPath,
    packageDir: resolved.packageDir,
    versionPinned: compatible.supported,
    issues: compatible.supported
      ? []
      : [
          `unsupported Grok Build version ${resolved.version}; minimum characterized version is ${MINIMUM_GROK_VERSION}`,
        ],
    provenance: GROK_PROVIDER_PROVENANCE,
    isolation: GROK_PROVIDER_ISOLATION,
  };
}

function adapterReport(
  harnessId: string,
  packageName: string,
  binName: string,
  expectedVersion: string,
  resolve: () => ReturnType<typeof tryResolveCodexCommand>,
  checkPin: (installed: string, expected: string) => { pinned: boolean },
  isolation: string,
  extraProvenance?: string,
): DoctorAdapterReport {
  const provenance =
    extraProvenance !== undefined ? `${LOCKFILE_PROVENANCE}; ${extraProvenance}` : LOCKFILE_PROVENANCE;
  const result = resolve();
  if (!isOk(result)) {
    return {
      harnessId,
      packageName,
      binName,
      expectedVersion,
      resolved: false,
      issues: [result.error.message],
      provenance,
      isolation,
    };
  }
  const resolved = result.value;
  const pin = checkPin(resolved.version, expectedVersion);
  const issues: string[] = [];
  if (!pin.pinned) {
    issues.push(
      `version drift: installed ${resolved.version}, expected ${expectedVersion} — ` +
        'classifyError conformance fixtures are version-specific and MUST be re-verified (PLAN §13)',
    );
  }
  return {
    harnessId,
    packageName,
    binName,
    expectedVersion,
    resolved: true,
    installedVersion: resolved.version,
    binPath: resolved.binPath,
    packageDir: resolved.packageDir,
    versionPinned: pin.pinned,
    issues,
    provenance,
    isolation,
  };
}

// ---------------------------------------------------------------------------
// Auth (evidence-honest, read-only — §3/D2 + §17.1 H-2)
// ---------------------------------------------------------------------------
/**
 * One provider's auth section. `envReadiness` comes from the profile's own
 * probe (H-2: never `supported` without turn evidence — statically that
 * means `detected_but_unvalidated` at most); `readinessArtifacts` are
 * credential files whose PRESENCE (checked read-only, never opened) maps to
 * `diskReadiness` when the env probe found nothing; `contextArtifacts` are
 * reported when found but carry no readiness weight (e.g. a bare `~/.codex`
 * directory is codex usage, not auth material).
 */
function authReport(
  provider: string,
  envReadiness: AuthReadiness,
  envVars: readonly string[],
  env: NodeJS.ProcessEnv,
  readinessArtifacts: readonly string[],
  diskReadiness: AuthReadiness,
  contextArtifacts: readonly string[],
  note: string,
): DoctorAuthReport {
  const evidence: string[] = [];
  for (const name of envVars) {
    const value = env[name];
    if (typeof value === 'string' && value.length > 0) evidence.push(`env ${name} present`);
  }
  const foundReadinessArtifacts = readinessArtifacts.filter((artifact) => existsSync(artifact));
  for (const artifact of [...foundReadinessArtifacts, ...contextArtifacts.filter((a) => existsSync(a))]) {
    evidence.push(`found ${artifact} (presence only; never opened)`);
  }

  let readiness: AuthReadiness;
  if (envReadiness !== 'unknown') {
    readiness = envReadiness;
  } else if (foundReadinessArtifacts.length > 0) {
    readiness = diskReadiness;
  } else {
    readiness = 'unknown';
  }
  return {
    provider,
    readiness,
    evidence,
    checked: { envVars, paths: [...readinessArtifacts, ...contextArtifacts] },
    note,
  };
}

// ---------------------------------------------------------------------------
// Fake-adapter handshake (real transport machinery, fake agent)
// ---------------------------------------------------------------------------
const FAKE_HANDSHAKE_NOTE =
  'handshake ran against the fake ACP child through the real stdio transport (spawn, ' +
  '§10.1 nonce echo, §10.2 bounds, capability probe); the REAL adapter handshake is the ' +
  'P2 live compatibility gate and never runs inside doctor (PLAN §3, §20)';

async function fakeHandshakeReport(handshakeTimeoutMs: number | undefined): Promise<DoctorHandshakeReport> {
  let scenarioDir: string | undefined;
  const adapterHolder: { adapter?: AcpStdioAdapter } = {};
  const startedMs = Date.now();
  try {
    scenarioDir = await mkdtemp(path.join(tmpdir(), 'harness-doctor-handshake-'));
    const scenarioPath = await writeScenarioFile({}, scenarioDir);
    const adapter = new AcpStdioAdapter({
      harnessId: 'doctor-fake-acp',
      spawn: { command: process.execPath, args: [fakeAcpChildPath(), scenarioPath] },
      ...(handshakeTimeoutMs !== undefined ? { limits: { handshakeTimeoutMs } } : {}),
    });
    adapterHolder.adapter = adapter;
    const record = await adapter.initialize();
    const spawnIdEchoed = adapter.probedCapabilities?.spawnIdEchoed ?? false;
    return {
      target: 'fake',
      ok: true,
      durationMs: Date.now() - startedMs,
      protocolVersion: record.protocol.version,
      spawnIdEchoed,
      note: FAKE_HANDSHAKE_NOTE,
    };
  } catch (error) {
    return {
      target: 'fake',
      ok: false,
      durationMs: Date.now() - startedMs,
      error: error instanceof Error ? error.message : String(error),
      note: FAKE_HANDSHAKE_NOTE,
    };
  } finally {
    await adapterHolder.adapter?.close().catch(() => undefined);
    if (scenarioDir !== undefined) await rm(scenarioDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------
async function gitReport(): Promise<DoctorGitReport> {
  try {
    const { stdout } = await execFileAsync('git', ['--version']);
    return { available: true, version: stdout.toString().trim() };
  } catch (error) {
    return { available: false, error: error instanceof Error ? error.message : String(error) };
  }
}

// ---------------------------------------------------------------------------
// SQLite (§12.1 pragmas read back from a real connection)
// ---------------------------------------------------------------------------
async function sqliteReport(): Promise<DoctorSqliteReport> {
  const nodeSqliteAvailable = await isNodeSqliteAvailable();
  let dir: string | undefined;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'harness-doctor-sqlite-'));
    const db = await openDatabase({
      filename: path.join(dir, 'doctor.db'),
      casRoot: path.join(dir, 'cas'),
    });
    try {
      const journalMode = String(db.driver.getPragma('journal_mode') ?? '');
      const foreignKeys = Number(db.driver.getPragma('foreign_keys') ?? 0) === 1;
      const busyTimeoutMs = Number(db.driver.getPragma('busy_timeout') ?? 0);
      return {
        ok: journalMode.toLowerCase() === 'wal' && foreignKeys,
        driver: db.driver.kind,
        pragmas: { journalMode, foreignKeys, busyTimeoutMs },
        nodeSqliteAvailable,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ok: false,
      driver: 'better-sqlite3',
      nodeSqliteAvailable,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Quotas (§12.1)
// ---------------------------------------------------------------------------
function quotasReport(configPath: string | undefined): DoctorQuotasReport {
  const parsed = configPath !== undefined ? loadEngineConfigFromFile(configPath) : parseEngineConfig({});
  if (!isOk(parsed)) {
    return {
      source: configPath !== undefined ? 'file' : 'defaults',
      ...(configPath !== undefined ? { configPath } : {}),
      issues: parsed.error,
    };
  }
  return {
    source: configPath !== undefined ? 'file' : 'defaults',
    ...(configPath !== undefined ? { configPath } : {}),
    perRunBytes: parsed.value.quotas.perRunBytes,
    globalBytes: parsed.value.quotas.globalBytes,
    issues: [],
  };
}

// ---------------------------------------------------------------------------
// runDoctor
// ---------------------------------------------------------------------------
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const clock = options.clock ?? new SystemClock();
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const resolveOptions =
    options.resolveFromDir !== undefined ? { fromDir: options.resolveFromDir } : {};

  const adapters: DoctorAdapterReport[] = [
    claudeProviderAdapterReport(
      options.claudeProviderResolver ?? (() => tryResolveClaudeProviderCommand()),
    ),
    adapterReport(
      CODEX_HARNESS_ID,
      CODEX_PACKAGE_NAME,
      CODEX_BIN_NAME,
      EXPECTED_CODEX_ADAPTER_VERSION,
      () => tryResolveCodexCommand(resolveOptions),
      checkCodexVersionPin,
      CODEX_ISOLATION,
      'codex-acp platform binary arrives via lockfile-pinned optionalDependencies, no postinstall (PLAN §3, §17.1)',
    ),
    grokProviderAdapterReport(
      options.grokProviderResolver ?? (() => tryResolveGrokCommand({ env })),
    ),
    adapterReport(
      OPENCODE_HARNESS_ID,
      OPENCODE_PACKAGE_NAME,
      OPENCODE_BIN_NAME,
      EXPECTED_OPENCODE_VERSION,
      () => tryResolveOpenCodeCommand(resolveOptions),
      checkOpenCodeVersionPin,
      OPENCODE_ISOLATION,
      'native ACP server is invoked as the pinned local binary with `acp --pure`; provider/model discovery stays dynamic',
    ),
  ];

  const auth: DoctorAuthReport[] = [
    authReport(
      CLAUDE_HARNESS_ID,
      'unknown',
      [],
      env,
      [
        path.join(home, '.claude', '.credentials.json'),
        path.join(home, '.claude.json'),
      ],
      'detected_but_unvalidated',
      [path.join(home, '.claude')],
      'Claude roles always use the installed first-party Claude Code provider and its subscription/keychain login. ' +
        'ANTHROPIC_API_KEY is intentionally not inherited by the child. Credential presence is only ' +
        'detected_but_unvalidated; supported requires a successful native provider turn.',
    ),
    authReport(
      CODEX_HARNESS_ID,
      probeCodexAuthReadiness(env),
      [CODEX_API_KEY_ENV_VAR, OPENAI_API_KEY_ENV_VAR],
      env,
      [path.join(home, '.codex', 'auth.json')],
      'detected_but_unvalidated',
      [path.join(home, '.codex')],
      'H-2 (live-falsified presence claims): a present API-key env var is UNVALIDATED until a successful ' +
        'provider turn is recorded — the P2 gate proved a present OPENAI_API_KEY 401-invalid while sessions ' +
        'rode the inherited ~/.codex ChatGPT login. ~/.codex/auth.json (ChatGPT/Codex subscription login — ' +
        'carried into spawned children by H-1 CODEX_HOME isolation) is likewise detected_but_unvalidated; ' +
        'contents are never inspected (read-only presence check). supported requires validated turn evidence.',
    ),
    authReport(
      GROK_HARNESS_ID,
      probeGrokAuthReadiness(env),
      [XAI_API_KEY_ENV_VAR],
      env,
      [grokAuthJsonPath(home)],
      'detected_but_unvalidated',
      [path.join(home, '.grok')],
      'Grok Build reuses the SuperGrok browser login from ~/.grok/auth.json through an isolated per-run ' +
        'GROK_HOME. The auth file is byte-copied, never parsed or logged, and never written back. ' +
        'XAI_API_KEY is supported as a separate credential path but presence alone remains ' +
        'detected_but_unvalidated; supported requires a successful provider turn.',
    ),
    authReport(
      OPENCODE_HARNESS_ID,
      probeOpenCodeAuthReadiness(),
      [],
      env,
      [openCodeAuthJsonPath(home)],
      'detected_but_unvalidated',
      [path.join(home, '.local', 'share', 'opencode')],
      'OpenCode reuses provider credentials created by `opencode auth login` through an H-1 isolated ' +
        'per-run HOME/XDG tree. The store is byte-copied in at spawn, never parsed or logged, and never ' +
        'written back; host/project config, plugins, MCP, and auto-allow rules are excluded. The orchestrator ' +
        'never starts an interactive login. ' +
        'Presence is detected_but_unvalidated; supported requires a successful provider turn.',
    ),
  ];

  // H-1: host provider-config safety (READ-ONLY; never mutates ~/.codex).
  const codexHostCheck = checkCodexHostApprovalsConfig(path.join(home, '.codex'));
  const hostConfig: DoctorHostConfigReport = {
    codex: {
      configPath: codexHostCheck.configPath,
      exists: codexHostCheck.exists,
      approvalsReviewers: codexHostCheck.approvalsReviewers,
      safe: codexHostCheck.safe,
      issues: codexHostCheck.issues,
      note:
        `read-only check: approvals_reviewer must be the client-routing "${CODEX_SAFE_APPROVALS_REVIEWER}" ` +
        '(the core default). Orchestrator codex spawns are protected by per-run CODEX_HOME isolation (H-1); ' +
        'this flag covers any non-isolated codex use on the host. Nothing is ever modified.',
    },
  };

  const [acpHandshake, git, sqlite] = await Promise.all([
    fakeHandshakeReport(options.handshakeTimeoutMs),
    gitReport(),
    sqliteReport(),
  ]);
  const quotas = quotasReport(options.configPath);

  const failures: string[] = [];
  for (const adapter of adapters) {
    if (!adapter.resolved) failures.push(`adapter ${adapter.harnessId}: not resolved`);
    else if (adapter.versionPinned === false) failures.push(`adapter ${adapter.harnessId}: version drift`);
  }
  if (!acpHandshake.ok) failures.push('acp handshake (fake) failed');
  if (!git.available) failures.push('git unavailable');
  if (!sqlite.ok) failures.push('sqlite check failed');
  if (quotas.issues.length > 0) failures.push('engine config invalid');

  const anySupportedAuth = auth.some((report) => report.readiness === 'supported');
  const anyDetectedAuth = auth.some(
    (report) =>
      report.readiness === 'detected_but_unvalidated' || report.readiness === 'detected_but_unsupported',
  );
  // Supervision (§14 ps process-group/RSS sampling) is macOS-only in MVP — the
  // `ps` adapter targets BSD/macOS flags; a GNU/Linux adapter is roadmap
  // (package.json `os: ["darwin"]`). Flag a non-darwin host so the limitation
  // is observable rather than silently mis-supervising.
  const supervisionSupported = (options.platform ?? process.platform) === 'darwin';
  const overall: DoctorOverall =
    failures.length > 0
      ? 'fail'
      : anySupportedAuth && hostConfig.codex.safe && supervisionSupported
        ? 'ok'
        : 'warn';

  const notes: string[] = [...failures];
  if (failures.length === 0 && !anySupportedAuth) {
    notes.push(
      anyDetectedAuth
        ? 'no provider has VALIDATED (supported) auth evidence — auth material was detected but stays ' +
            'detected_but_unvalidated until a successful provider turn is recorded (H-2)'
        : 'no provider has positive auth evidence — live runs will need an API key or a supported login',
    );
  }
  if (!hostConfig.codex.safe) {
    notes.push(
      `host codex config flagged (H-1): ${hostConfig.codex.configPath} routes approvals to a provider-side ` +
        'reviewer — see hostConfig.codex.issues (read-only check; orchestrator spawns are isolated, nothing was mutated)',
    );
  }
  if (!supervisionSupported) {
    notes.push(
      `memory supervision is macOS-only in MVP: this host is '${options.platform ?? process.platform}', but the ` +
        'ps process-group/RSS adapter (PLAN §14) targets BSD/macOS flags (package.json os: ["darwin"]). A ' +
        'GNU/Linux ps adapter is roadmap — supervision would mis-sample here until it lands.',
    );
  }

  return {
    generatedAt: clock.nowIso(),
    overall,
    adapters,
    auth,
    hostConfig,
    acpHandshake,
    git,
    sqlite,
    quotas,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Text rendering (the non-`--json` surface)
// ---------------------------------------------------------------------------
function mark(ok: boolean): string {
  return ok ? 'ok  ' : 'FAIL';
}

export function renderDoctorText(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`harness doctor — overall: ${report.overall.toUpperCase()} (${report.generatedAt})`);
  lines.push('');
  lines.push('adapters (resolved and version-characterized):');
  for (const adapter of report.adapters) {
    const state = adapter.resolved
      ? `${adapter.installedVersion}${adapter.versionPinned === true ? ' (pinned)' : ' (VERSION DRIFT)'} at ${adapter.binPath}`
      : 'NOT RESOLVED';
    lines.push(`  [${mark(adapter.resolved && adapter.versionPinned !== false)}] ${adapter.harnessId}: ${adapter.packageName} ${state}`);
    lines.push(`         provenance: ${adapter.provenance}`);
    lines.push(`         isolation: ${adapter.isolation}`);
    for (const issue of adapter.issues) lines.push(`         - ${issue}`);
  }
  lines.push('');
  lines.push('auth (evidence-honest, read-only; supported requires a validated turn — H-2):');
  for (const auth of report.auth) {
    lines.push(`  [${auth.readiness}] ${auth.provider}${auth.evidence.length > 0 ? ` — ${auth.evidence.join('; ')}` : ''}`);
  }
  lines.push('');
  const host = report.hostConfig.codex;
  lines.push(
    `host config (read-only, H-1): [${host.safe ? 'ok  ' : 'WARN'}] codex ${host.configPath} ` +
      `${host.exists ? `approvals_reviewer=${host.approvalsReviewers.length > 0 ? host.approvalsReviewers.join(',') : '<unset → user>'}` : 'absent (core default: user)'}`,
  );
  for (const issue of host.issues) lines.push(`  - ${issue}`);
  lines.push('');
  const hs = report.acpHandshake;
  lines.push(
    `acp handshake (fake adapter): [${mark(hs.ok)}]${hs.ok ? ` protocol v${hs.protocolVersion}, spawn-id echoed: ${String(hs.spawnIdEchoed)}, ${hs.durationMs}ms` : ` ${hs.error ?? ''}`}`,
  );
  lines.push(`git: [${mark(report.git.available)}] ${report.git.version ?? report.git.error ?? ''}`);
  const sq = report.sqlite;
  lines.push(
    `sqlite: [${mark(sq.ok)}] driver=${sq.driver}${sq.pragmas !== undefined ? ` journal_mode=${sq.pragmas.journalMode} foreign_keys=${String(sq.pragmas.foreignKeys)} busy_timeout=${sq.pragmas.busyTimeoutMs}ms` : ''} node:sqlite available=${String(sq.nodeSqliteAvailable)}`,
  );
  const q = report.quotas;
  lines.push(
    `quotas (${q.source}): ${q.perRunBytes !== undefined ? `per-run ${q.perRunBytes} bytes, global ${q.globalBytes} bytes` : 'UNAVAILABLE'}`,
  );
  for (const issue of q.issues) lines.push(`  - config issue at '${issue.path}': ${issue.message}`);
  if (report.notes.length > 0) {
    lines.push('');
    lines.push('notes:');
    for (const note of report.notes) lines.push(`  - ${note}`);
  }
  return lines.join('\n');
}
