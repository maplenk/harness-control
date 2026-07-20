/**
 * OpenCode ACP profile — lockfile-pinned command resolution.
 *
 * The `opencode-ai` npm package installs a platform-native `opencode` binary
 * through its own `package.json` `bin` entry. We resolve that exact local
 * package/binary and invoke its native ACP server as `opencode acp --pure`;
 * `--pure` disables external plugins and is one layer of the H-1 spawn
 * boundary. There is no PATH lookup and no runtime download/floating `npx`
 * fallback.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from '../../lib/result.js';
import { AdapterError, isAdapterError } from '../spi.js';
import { OPENCODE_HARNESS_ID } from './capabilities.js';

export const OPENCODE_PACKAGE_NAME = 'opencode-ai';
export const OPENCODE_BIN_NAME = 'opencode';
export const EXPECTED_OPENCODE_VERSION = '1.18.1';

export interface ResolvedAdapterCommand {
  /** The installed native OpenCode executable. */
  readonly command: string;
  /** Starts OpenCode's stdio Agent Client Protocol server. */
  readonly args: readonly string[];
  readonly packageName: string;
  readonly version: string;
  readonly binPath: string;
  readonly packageDir: string;
}

export interface ResolveCommandOptions {
  readonly fromDir?: string;
}

interface RawPackageJson {
  readonly version?: unknown;
  readonly bin?: unknown;
}

function defaultFromDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

function findPackageDir(fromDir: string): string {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', OPENCODE_PACKAGE_NAME);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new AdapterError(
        'spawn_failed',
        `Cannot locate installed package '${OPENCODE_PACKAGE_NAME}' walking up from ${fromDir}. ` +
          'Install the exact lockfile dependency; this adapter never falls back to PATH or npx.',
        { harnessId: OPENCODE_HARNESS_ID },
      );
    }
    dir = parent;
  }
}

function readPackageJson(packageDir: string): RawPackageJson {
  const packageJsonPath = path.join(packageDir, 'package.json');
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8')) as RawPackageJson;
  } catch (cause) {
    throw new AdapterError('spawn_failed', `Cannot read/parse ${packageJsonPath}`, {
      harnessId: OPENCODE_HARNESS_ID,
      cause,
    });
  }
}

function resolveBinPath(pkg: RawPackageJson, packageDir: string): string {
  const bin = pkg.bin;
  const relative =
    typeof bin === 'string'
      ? bin
      : bin !== null && typeof bin === 'object'
        ? (bin as Record<string, unknown>)[OPENCODE_BIN_NAME]
        : undefined;
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new AdapterError(
      'spawn_failed',
      `${path.join(packageDir, 'package.json')} has no bin.${OPENCODE_BIN_NAME} entry`,
      { harnessId: OPENCODE_HARNESS_ID },
    );
  }
  const binPath = path.resolve(packageDir, relative);
  if (!existsSync(binPath)) {
    throw new AdapterError(
      'spawn_failed',
      `Resolved OpenCode binary does not exist: ${binPath}. Re-run npm install for this platform.`,
      { harnessId: OPENCODE_HARNESS_ID },
    );
  }
  return binPath;
}

export function resolveOpenCodeCommand(
  options: ResolveCommandOptions = {},
): ResolvedAdapterCommand {
  const packageDir = findPackageDir(options.fromDir ?? defaultFromDir());
  const pkg = readPackageJson(packageDir);
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new AdapterError(
      'spawn_failed',
      `${path.join(packageDir, 'package.json')} has no version field`,
      { harnessId: OPENCODE_HARNESS_ID },
    );
  }
  const binPath = resolveBinPath(pkg, packageDir);
  return {
    command: binPath,
    args: ['acp', '--pure'],
    packageName: OPENCODE_PACKAGE_NAME,
    version: pkg.version,
    binPath,
    packageDir,
  };
}

export function tryResolveOpenCodeCommand(
  options: ResolveCommandOptions = {},
): Result<ResolvedAdapterCommand, AdapterError> {
  try {
    return ok(resolveOpenCodeCommand(options));
  } catch (error) {
    if (isAdapterError(error)) return err(error);
    return err(
      new AdapterError('spawn_failed', `Unexpected OpenCode resolution failure: ${String(error)}`, {
        harnessId: OPENCODE_HARNESS_ID,
        cause: error,
      }),
    );
  }
}

export interface VersionPinCheck {
  readonly pinned: boolean;
  readonly expectedVersion: string;
  readonly installedVersion: string;
}

export function checkVersionPin(installedVersion: string, expectedVersion: string): VersionPinCheck {
  return { pinned: installedVersion === expectedVersion, expectedVersion, installedVersion };
}

export function assertOpenCodeVersionPinned(
  options: ResolveCommandOptions = {},
): ResolvedAdapterCommand {
  const resolved = resolveOpenCodeCommand(options);
  const check = checkVersionPin(resolved.version, EXPECTED_OPENCODE_VERSION);
  if (!check.pinned) {
    throw new Error(
      '[RE-CHARACTERIZATION TRIGGER] ' +
        `${OPENCODE_PACKAGE_NAME} version drifted: expected ${check.expectedVersion}, ` +
        `found ${check.installedVersion} at ${resolved.packageDir}. Re-verify ACP initialize/session ` +
        'capabilities, config-option ids, permission routing, and provider-error envelopes before ' +
        'updating EXPECTED_OPENCODE_VERSION. Then refresh the committed hostile-config proof with ' +
        '`npm run smoke:opencode:isolation:record`; the offline evidence gate must match the new version.',
    );
  }
  return resolved;
}
