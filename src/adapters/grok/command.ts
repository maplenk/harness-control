/** First-party Grok Build binary resolution and ACP launch arguments. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import * as path from 'node:path';
import type { RoleName } from '../../domain/state.js';
import { err, ok, type Result } from '../../lib/result.js';
import { AdapterError, isAdapterError } from '../spi.js';
import {
  GROK_HARNESS_ID,
  grokPermissionModeForRole,
  grokSandboxProfileForRole,
} from './capabilities.js';

export const GROK_BIN_NAME = 'grok';
export const GROK_PACKAGE_NAME = 'grok-build';
export const GROK_PROVIDER_BIN_ENV_VAR = 'GROK_PROVIDER_BIN';
export const MINIMUM_GROK_VERSION = '0.2.106';

export interface GrokAcpArgsOptions {
  readonly model?: string;
  readonly reasoningEffort?: string;
  readonly role?: RoleName;
}

/**
 * Pure, inspectable launch policy. Model and reasoning effort are spawn-time
 * pins because Grok 0.2.106 advertises no ACP config-option setter. Security
 * switches precede `agent`; `stdio` itself accepts no options.
 */
export function buildGrokAcpArgs(options: GrokAcpArgsOptions = {}): readonly string[] {
  const args: string[] = [
    '--no-auto-update',
    '--no-memory',
    '--no-subagents',
    '--disable-web-search',
    '--sandbox',
    grokSandboxProfileForRole(options.role),
    '--permission-mode',
    grokPermissionModeForRole(options.role),
  ];
  if (options.model !== undefined && options.model.length > 0) {
    args.push('--model', options.model);
  }
  if (options.reasoningEffort !== undefined && options.reasoningEffort.length > 0) {
    args.push('--reasoning-effort', options.reasoningEffort);
  }
  args.push('agent', '--no-leader', 'stdio');
  return args;
}

/**
 * Exact ACP permission title Grok 0.2.106 emits for a shell request. Grok's
 * raw tool input calls the variant "Bash", but its ACP operation title is
 * `Execute \`<command>\``. The shared permission engine compares this string
 * by equality, so an approved verification command cannot widen into a
 * command prefix or chained suffix.
 */
export function grokShellPermissionTitle(command: string): string {
  if (
    command.length === 0 ||
    command.includes('\n') ||
    command.includes('\r') ||
    command.includes('\0') ||
    command.includes('`')
  ) {
    throw new AdapterError(
      'invalid_argument',
      'Grok shell permissions require a non-empty single-line command without NUL or backtick bytes',
      { harnessId: GROK_HARNESS_ID },
    );
  }
  return `Execute \`${command}\``;
}

export interface ResolvedGrokCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** Structural compatibility with the shared provider factory. */
  readonly packageName: typeof GROK_PACKAGE_NAME;
  readonly version: string;
  readonly binPath: string;
  readonly packageDir: string;
}

export interface ResolveGrokCommandOptions extends GrokAcpArgsOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Base for a relative GROK_PROVIDER_BIN and empty PATH entries. */
  readonly cwd?: string;
}

function executable(pathname: string): boolean {
  try {
    const stat = statSync(pathname);
    if (!stat.isFile()) return false;
    accessSync(pathname, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveFromPath(env: NodeJS.ProcessEnv, cwd: string): string | undefined {
  for (const entry of (env['PATH'] ?? '').split(path.delimiter)) {
    const candidate = path.resolve(entry.length > 0 ? entry : cwd, GROK_BIN_NAME);
    if (executable(candidate)) return candidate;
  }
  return undefined;
}

function resolveBin(options: ResolveGrokCommandOptions): string {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const override = env[GROK_PROVIDER_BIN_ENV_VAR];
  if (typeof override === 'string' && override.length > 0) {
    const candidate = path.resolve(cwd, override);
    if (!executable(candidate)) {
      throw new AdapterError(
        'spawn_failed',
        `${GROK_PROVIDER_BIN_ENV_VAR} does not name an executable regular file: ${candidate}`,
        { harnessId: GROK_HARNESS_ID },
      );
    }
    return candidate;
  }
  const candidate = resolveFromPath(env, cwd);
  if (candidate !== undefined) return candidate;
  throw new AdapterError(
    'spawn_failed',
    `Cannot locate '${GROK_BIN_NAME}' on PATH. Install Grok Build or set ${GROK_PROVIDER_BIN_ENV_VAR} to its executable.`,
    { harnessId: GROK_HARNESS_ID },
  );
}

/** Parses `grok 0.2.106 (commit) [channel]` without accepting unrelated text. */
export function parseGrokVersion(output: string): string | undefined {
  return /^grok\s+(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/m.exec(output.trim())?.[1];
}

function readInstalledVersion(binPath: string, env: NodeJS.ProcessEnv): string {
  let output: string;
  try {
    output = execFileSync(binPath, ['--version'], {
      encoding: 'utf8',
      env,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (cause) {
    throw new AdapterError('spawn_failed', `Cannot execute ${binPath} --version`, {
      harnessId: GROK_HARNESS_ID,
      cause,
    });
  }
  const version = parseGrokVersion(output);
  if (version === undefined) {
    throw new AdapterError('spawn_failed', `Unrecognized Grok Build version output from ${binPath}`, {
      harnessId: GROK_HARNESS_ID,
    });
  }
  return version;
}

interface ParsedVersion {
  readonly numbers: readonly [number, number, number];
  readonly prerelease: boolean;
}

function parseComparableVersion(version: string): ParsedVersion | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?$/.exec(version);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { numbers: [major, minor, patch], prerelease: match[4] !== undefined };
}

export interface GrokMinimumVersionCheck {
  readonly supported: boolean;
  readonly minimumVersion: string;
  readonly installedVersion: string;
}

export function checkGrokMinimumVersion(
  installedVersion: string,
  minimumVersion: string = MINIMUM_GROK_VERSION,
): GrokMinimumVersionCheck {
  const installed = parseComparableVersion(installedVersion);
  const minimum = parseComparableVersion(minimumVersion);
  let supported = false;
  if (installed !== undefined && minimum !== undefined) {
    supported = true;
    for (let index = 0; index < 3; index += 1) {
      const left = installed.numbers[index] ?? 0;
      const right = minimum.numbers[index] ?? 0;
      if (left !== right) {
        supported = left > right;
        break;
      }
      if (index === 2) supported = !(installed.prerelease && !minimum.prerelease);
    }
  }
  return { supported, minimumVersion, installedVersion };
}

export function resolveGrokCommand(options: ResolveGrokCommandOptions = {}): ResolvedGrokCommand {
  const env = options.env ?? process.env;
  const binPath = resolveBin(options);
  return {
    command: binPath,
    args: buildGrokAcpArgs(options),
    packageName: GROK_PACKAGE_NAME,
    version: readInstalledVersion(binPath, env),
    binPath,
    packageDir: path.dirname(binPath),
  };
}

export function tryResolveGrokCommand(
  options: ResolveGrokCommandOptions = {},
): Result<ResolvedGrokCommand, AdapterError> {
  try {
    return ok(resolveGrokCommand(options));
  } catch (error) {
    if (isAdapterError(error)) return err(error);
    return err(
      new AdapterError('spawn_failed', `Unexpected Grok Build resolution failure: ${String(error)}`, {
        harnessId: GROK_HARNESS_ID,
        cause: error,
      }),
    );
  }
}

export function assertGrokMinimumVersion(
  options: ResolveGrokCommandOptions = {},
): ResolvedGrokCommand {
  const resolved = resolveGrokCommand(options);
  const check = checkGrokMinimumVersion(resolved.version);
  if (!check.supported) {
    throw new AdapterError(
      'protocol_version_mismatch',
      `[RE-CHARACTERIZATION TRIGGER] Grok Build ${check.installedVersion} is older than the supported minimum ${check.minimumVersion}. Upgrade Grok and re-verify ACP capabilities and provider-error envelopes.`,
      { harnessId: GROK_HARNESS_ID },
    );
  }
  return resolved;
}
