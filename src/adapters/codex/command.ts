/**
 * Codex ACP profile — command resolution (PLAN §3, §10.1).
 *
 * Resolves the LOCKFILE-PINNED local `codex-acp` binary strictly via the
 * installed package's OWN `package.json` `bin` field — never `npx -y`
 * (which would silently fetch whatever version npm feels like resolving at
 * run time, defeating the "lockfile-pinned binaries only" guarantee PLAN
 * §3/§17.1 relies on for supply-chain provenance; PLAN §3 also notes
 * codex-acp's platform binary arrives via its OWN dependency
 * `@openai/codex`'s lockfile-pinned `optionalDependencies` — a supply-chain
 * concern this module doesn't need to re-solve, only codex-acp's own `bin`
 * entry).
 *
 * Resolution walks UP the directory tree from this module's own location
 * (not `process.cwd()`) looking for
 * `node_modules/@agentclientprotocol/codex-acp/package.json` — mirrors
 * `../claude/command.ts` exactly (kept independent/duplicated rather than
 * shared, so this profile directory stays self-contained per its ownership
 * boundary).
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from '../../lib/result.js';
import { AdapterError, isAdapterError } from '../spi.js';
import { CODEX_HARNESS_ID } from './capabilities.js';

export const CODEX_PACKAGE_NAME = '@agentclientprotocol/codex-acp';
export const CODEX_BIN_NAME = 'codex-acp';

/**
 * Version pinned in `package.json` (`dependencies["@agentclientprotocol/codex-acp"]`)
 * and the version the classifyError conformance fixture
 * (`fixtures/codex-error-envelopes.ts`) was captured against (PLAN §13's
 * re-characterization-trigger discipline, extended to Codex for the same
 * reason it applies to Claude: the `codexErrorInfo` shape this profile
 * relies on is version-specific, verified source, not a documented public
 * contract).
 */
export const EXPECTED_CODEX_ADAPTER_VERSION = '1.1.4';

export interface ResolvedAdapterCommand {
  /** Always `process.execPath` — the bin is invoked as a script argument,
   * never relying on the file's executable bit or a shebang. */
  readonly command: string;
  readonly args: readonly string[];
  readonly packageName: string;
  readonly version: string;
  readonly binPath: string;
  readonly packageDir: string;
}

export interface ResolveCommandOptions {
  /** Directory to start the upward `node_modules` search from. Defaults to
   * this module's own directory — NOT `process.cwd()`. */
  readonly fromDir?: string;
}

function defaultFromDir(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

interface RawPackageJson {
  readonly version?: unknown;
  readonly bin?: unknown;
}

function findPackageDir(packageName: string, fromDir: string): string {
  const segments = packageName.split('/');
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', ...segments);
    if (existsSync(path.join(candidate, 'package.json'))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new AdapterError(
        'spawn_failed',
        `Cannot locate installed package '${packageName}': no node_modules/${packageName}/package.json ` +
          `found walking up from ${fromDir} to the filesystem root. Never falls back to npx -y — ` +
          `install the pinned dependency (see package.json).`,
        { harnessId: CODEX_HARNESS_ID },
      );
    }
    dir = parent;
  }
}

function readPackageJson(packageDir: string): RawPackageJson {
  const packageJsonPath = path.join(packageDir, 'package.json');
  let raw: string;
  try {
    raw = readFileSync(packageJsonPath, 'utf8');
  } catch (cause) {
    throw new AdapterError('spawn_failed', `Cannot read ${packageJsonPath}`, {
      harnessId: CODEX_HARNESS_ID,
      cause,
    });
  }
  try {
    return JSON.parse(raw) as RawPackageJson;
  } catch (cause) {
    throw new AdapterError('spawn_failed', `Cannot parse ${packageJsonPath} as JSON`, {
      harnessId: CODEX_HARNESS_ID,
      cause,
    });
  }
}

function resolveBinPath(pkg: RawPackageJson, binName: string, packageDir: string): string {
  const bin = pkg.bin;
  const binRel =
    typeof bin === 'string'
      ? bin
      : bin !== null && typeof bin === 'object'
        ? (bin as Record<string, unknown>)[binName]
        : undefined;
  if (typeof binRel !== 'string' || binRel.length === 0) {
    throw new AdapterError(
      'spawn_failed',
      `${path.join(packageDir, 'package.json')} has no "bin.${binName}" entry ` +
        '(resolution is via package.json bin only — never npx -y)',
      { harnessId: CODEX_HARNESS_ID },
    );
  }
  const binPath = path.join(packageDir, binRel);
  if (!existsSync(binPath)) {
    throw new AdapterError(
      'spawn_failed',
      `Resolved bin path for '${binName}' does not exist on disk: ${binPath}`,
      { harnessId: CODEX_HARNESS_ID },
    );
  }
  return binPath;
}

/**
 * Resolves the pinned `codex-acp` binary. Throws a typed
 * `AdapterError{kind:'spawn_failed'}` (never silent) when the package, its
 * `bin` entry, or the resolved file itself is missing.
 */
export function resolveCodexCommand(options: ResolveCommandOptions = {}): ResolvedAdapterCommand {
  const fromDir = options.fromDir ?? defaultFromDir();
  const packageDir = findPackageDir(CODEX_PACKAGE_NAME, fromDir);
  const pkg = readPackageJson(packageDir);
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new AdapterError(
      'spawn_failed',
      `${path.join(packageDir, 'package.json')} has no "version" field`,
      { harnessId: CODEX_HARNESS_ID },
    );
  }
  const binPath = resolveBinPath(pkg, CODEX_BIN_NAME, packageDir);
  return {
    command: process.execPath,
    args: [binPath],
    packageName: CODEX_PACKAGE_NAME,
    version: pkg.version,
    binPath,
    packageDir,
  };
}

/** Non-throwing variant for `doctor`-style callers that collect issues
 * instead of catching exceptions. */
export function tryResolveCodexCommand(
  options: ResolveCommandOptions = {},
): Result<ResolvedAdapterCommand, AdapterError> {
  try {
    return ok(resolveCodexCommand(options));
  } catch (error) {
    if (isAdapterError(error)) return err(error);
    return err(
      new AdapterError('spawn_failed', `Unexpected error resolving ${CODEX_BIN_NAME}: ${String(error)}`, {
        harnessId: CODEX_HARNESS_ID,
        cause: error,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Version pin (PLAN §13 re-characterization trigger, extended to Codex)
// ---------------------------------------------------------------------------
export interface VersionPinCheck {
  readonly pinned: boolean;
  readonly expectedVersion: string;
  readonly installedVersion: string;
}

/** Pure comparison — unit-testable without touching the filesystem. */
export function checkVersionPin(installedVersion: string, expectedVersion: string): VersionPinCheck {
  return { pinned: installedVersion === expectedVersion, expectedVersion, installedVersion };
}

/**
 * Resolves the pinned binary AND asserts its version matches
 * `EXPECTED_CODEX_ADAPTER_VERSION`. FAILS LOUDLY (throws, with an unmissable
 * message — never a silent downgrade) when the installed `codex-acp`
 * version has drifted. A drift means the `codexErrorInfo`/JSON-RPC-code
 * conventions the classifyError conformance fixture pins
 * (`fixtures/codex-error-envelopes.ts`) — including the
 * `usageLimitReporting:'structured'` capability this profile now claims,
 * see `capabilities.ts`'s DEVIATION doc comment — may no longer match the
 * installed adapter's real behavior and MUST be re-verified before this
 * check is updated to the new version.
 */
export function assertCodexAdapterVersionPinned(
  options: ResolveCommandOptions = {},
): ResolvedAdapterCommand {
  const resolved = resolveCodexCommand(options);
  const check = checkVersionPin(resolved.version, EXPECTED_CODEX_ADAPTER_VERSION);
  if (!check.pinned) {
    throw new Error(
      '[RE-CHARACTERIZATION TRIGGER] ' +
        `${CODEX_PACKAGE_NAME} version drifted: expected ${check.expectedVersion} ` +
        `(pinned by src/adapters/codex/fixtures/codex-error-envelopes.ts), ` +
        `found ${check.installedVersion} installed at ${resolved.packageDir}. ` +
        'The classifyError envelope-shape fixture MUST be re-verified against the new ' +
        'adapter source (codexErrorInfo values, JSON-RPC codes) before EXPECTED_CODEX_ADAPTER_VERSION ' +
        'is updated to silence this check (PLAN §13: "version bump → re-characterization + loud downgrade").',
    );
  }
  return resolved;
}
