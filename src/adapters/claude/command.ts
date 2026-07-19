/**
 * Claude ACP profile — command resolution (PLAN §3, §10.1).
 *
 * Resolves the LOCKFILE-PINNED local `claude-agent-acp` binary strictly via
 * the installed package's OWN `package.json` `bin` field — never `npx -y`
 * (which would silently fetch whatever version npm feels like resolving at
 * run time, defeating the entire "lockfile-pinned binaries only" guarantee
 * PLAN §3/§17.1 relies on for supply-chain provenance).
 *
 * Resolution walks UP the directory tree from this module's own location
 * (not `process.cwd()`, which is caller-dependent) looking for
 * `node_modules/@agentclientprotocol/claude-agent-acp/package.json` — the
 * same shape Node's own module resolution uses, and portable across both the
 * `src/` (tsx/vitest) and built `dist/` layouts since both sit exactly three
 * directories below the repo root (mirrors `fake/child.ts`'s
 * `fakeAcpChildPath()`).
 */
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from '../../lib/result.js';
import { AdapterError, isAdapterError } from '../spi.js';
import { CLAUDE_HARNESS_ID } from './capabilities.js';

export const CLAUDE_PACKAGE_NAME = '@agentclientprotocol/claude-agent-acp';
export const CLAUDE_BIN_NAME = 'claude-agent-acp';

/**
 * Version pinned in `package.json` (`dependencies["@agentclientprotocol/claude-agent-acp"]`)
 * and the version the classifyError conformance fixture
 * (`fixtures/claude-error-envelopes.ts`) was captured against (PLAN §13:
 * "conformance fixture pins this convention at adapter v0.59.0; startup
 * probe verifies; version bump → re-characterization + loud downgrade").
 */
export const EXPECTED_CLAUDE_ADAPTER_VERSION = '0.59.0';

export interface ResolvedAdapterCommand {
  /** Always `process.execPath` — the bin is invoked as a script argument,
   * never relying on the file's executable bit or a shebang (portable,
   * matches `fake/child.ts`'s `spawnFakeAcpChild` convention). */
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
        { harnessId: CLAUDE_HARNESS_ID },
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
      harnessId: CLAUDE_HARNESS_ID,
      cause,
    });
  }
  try {
    return JSON.parse(raw) as RawPackageJson;
  } catch (cause) {
    throw new AdapterError('spawn_failed', `Cannot parse ${packageJsonPath} as JSON`, {
      harnessId: CLAUDE_HARNESS_ID,
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
      { harnessId: CLAUDE_HARNESS_ID },
    );
  }
  const binPath = path.join(packageDir, binRel);
  if (!existsSync(binPath)) {
    throw new AdapterError(
      'spawn_failed',
      `Resolved bin path for '${binName}' does not exist on disk: ${binPath}`,
      { harnessId: CLAUDE_HARNESS_ID },
    );
  }
  return binPath;
}

/**
 * Resolves the pinned `claude-agent-acp` binary. Throws a typed
 * `AdapterError{kind:'spawn_failed'}` (never silent) when the package, its
 * `bin` entry, or the resolved file itself is missing.
 */
export function resolveClaudeCommand(options: ResolveCommandOptions = {}): ResolvedAdapterCommand {
  const fromDir = options.fromDir ?? defaultFromDir();
  const packageDir = findPackageDir(CLAUDE_PACKAGE_NAME, fromDir);
  const pkg = readPackageJson(packageDir);
  if (typeof pkg.version !== 'string' || pkg.version.length === 0) {
    throw new AdapterError(
      'spawn_failed',
      `${path.join(packageDir, 'package.json')} has no "version" field`,
      { harnessId: CLAUDE_HARNESS_ID },
    );
  }
  const binPath = resolveBinPath(pkg, CLAUDE_BIN_NAME, packageDir);
  return {
    command: process.execPath,
    args: [binPath],
    packageName: CLAUDE_PACKAGE_NAME,
    version: pkg.version,
    binPath,
    packageDir,
  };
}

/** Non-throwing variant for `doctor`-style callers that collect issues
 * instead of catching exceptions. */
export function tryResolveClaudeCommand(
  options: ResolveCommandOptions = {},
): Result<ResolvedAdapterCommand, AdapterError> {
  try {
    return ok(resolveClaudeCommand(options));
  } catch (error) {
    if (isAdapterError(error)) return err(error);
    return err(
      new AdapterError('spawn_failed', `Unexpected error resolving ${CLAUDE_BIN_NAME}: ${String(error)}`, {
        harnessId: CLAUDE_HARNESS_ID,
        cause: error,
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Version pin (PLAN §13 re-characterization trigger)
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
 * `EXPECTED_CLAUDE_ADAPTER_VERSION`. FAILS LOUDLY (throws, with an
 * unmissable message — never a silent downgrade) when the installed
 * `claude-agent-acp` version has drifted, per PLAN §13's explicit
 * re-characterization trigger: "startup probe verifies; version bump →
 * re-characterization + loud downgrade". A drift means the
 * `errorKind`/JSON-RPC-code conventions the classifyError conformance
 * fixture pins (`fixtures/claude-error-envelopes.ts`) may no longer match
 * the installed adapter's real behavior and MUST be re-verified before this
 * check is updated to the new version.
 */
export function assertClaudeAdapterVersionPinned(
  options: ResolveCommandOptions = {},
): ResolvedAdapterCommand {
  const resolved = resolveClaudeCommand(options);
  const check = checkVersionPin(resolved.version, EXPECTED_CLAUDE_ADAPTER_VERSION);
  if (!check.pinned) {
    throw new Error(
      '[RE-CHARACTERIZATION TRIGGER] ' +
        `${CLAUDE_PACKAGE_NAME} version drifted: expected ${check.expectedVersion} ` +
        `(pinned by src/adapters/claude/fixtures/claude-error-envelopes.ts and PLAN §13), ` +
        `found ${check.installedVersion} installed at ${resolved.packageDir}. ` +
        'The classifyError envelope-shape fixture MUST be re-verified against the new ' +
        'adapter source (errorKind values, JSON-RPC codes) before EXPECTED_CLAUDE_ADAPTER_VERSION ' +
        'is updated to silence this check (PLAN §13: "version bump → re-characterization + loud downgrade").',
    );
  }
  return resolved;
}
