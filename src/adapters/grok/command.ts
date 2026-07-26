/** First-party Grok Build binary resolution and ACP launch arguments. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import * as path from 'node:path';
import type { RoleName } from '../../domain/state.js';
import {
  commandFromPermissionTitle,
  parseShellCommandArgv,
  pathFromStructuredFileTitle,
} from '../../lib/operation-parse.js';
import { escapesWorktree, isSafeGitRead } from '../../lib/permanent-deny.js';
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

const SAFE_SIMPLE_READ_COMMANDS = new Set([
  'cat',
  'grep',
  'head',
  'ls',
  'pwd',
  'rg',
  'tail',
  'true',
  'wc',
  // Read-only shell builtins Grok leans on in exploration idioms (e.g.
  // `… || echo "no dir yet"`). None can mutate state: `echo`/`printf` only
  // print, `test`/`[`/`true`/`false` only evaluate, and `dirname`/`basename`
  // only parse path strings. Writes-via-redirection are already blocked by
  // `stripSafeRedirections`, and out-of-worktree paths by `escapesWorktree`.
  'echo',
  'printf',
  'test',
  '[',
  'false',
  'dirname',
  'basename',
]);
function isSafeReadOnlyArgv(argv: readonly string[], worktreeRoot: string | undefined): boolean {
  if (escapesWorktree(argv, worktreeRoot)) return false;
  if (argv[0] === 'git') return isSafeGitRead(argv);
  if (argv[0] === 'rg' && argv.slice(1).some((arg) => arg === '--pre' || arg.startsWith('--pre='))) {
    return false;
  }
  return argv[0] !== undefined && SAFE_SIMPLE_READ_COMMANDS.has(argv[0]);
}

/**
 * Recognizes only shell compositions whose every segment is a conservative
 * read-only repository inspection. This intentionally rejects shell
 * expansions, subshells, backgrounding, arbitrary redirection,
 * parent-traversing paths, absolute paths that do not resolve inside
 * `worktreeRoot`, executable ripgrep preprocessors, mutating git forms, network
 * clients, and all unknown commands.
 *
 * `worktreeRoot` is the agent's ASSIGNED WORKTREE — the same path the prompt
 * confines it to and the same path `workspaceWriteRoot` uses. It is required,
 * and `undefined` is a legitimate value meaning "this call site has no root":
 * the classifier then admits no absolute path at all (F14). Production binds it
 * in exactly one place, `buildGrokMediation`.
 */
export function isGrokReadOnlyShellPermissionTitle(
  operation: string,
  worktreeRoot: string | undefined,
): boolean {
  const command = commandFromPermissionTitle(operation);
  if (command === undefined) return false;
  const segments = parseShellCommandArgv(command);
  if (segments === undefined) return false;
  return segments.every((argv) => isSafeReadOnlyArgv(argv, worktreeRoot));
}

/**
 * HIGH-5 — the command a Grok shell tool call will ACTUALLY execute, recovered
 * from its ACP `rawInput`. Returns `undefined` for anything that is not an
 * object carrying a string `command`, so a missing or malformed payload can only
 * ever produce a DENIAL, never an approval.
 */
export function grokRawShellCommand(rawInput: unknown): string | undefined {
  const field = readPayloadField(rawInput, 'command');
  return field.kind === 'string' ? field.value : undefined;
}

/**
 * ROUND 7 (Finding 4) — reading ONE payload field, distinguishing the three
 * outcomes that matter: the field is a usable string, the field is ABSENT, or
 * the field is PRESENT BUT MALFORMED.
 *
 * Collapsing the last two into `undefined` is the same logical error corrected
 * twice already at other layers: absence can be evidence about an operation's
 * kind, but a value we could not read never is. `{command: 42}` said something
 * about this call and we failed to understand it; treating that as "there is no
 * command here" is exactly the inference a fail-closed gate must not make.
 */
type PayloadField =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' };

function readPayloadField(rawInput: unknown, name: string): PayloadField {
  if (rawInput === undefined || rawInput === null) return { kind: 'absent' };
  if (typeof rawInput !== 'object' || Array.isArray(rawInput)) return { kind: 'malformed' };
  const record = rawInput as Record<string, unknown>;
  if (!(name in record) || record[name] === undefined) return { kind: 'absent' };
  const value = record[name];
  return typeof value === 'string' ? { kind: 'string', value } : { kind: 'malformed' };
}

/**
 * HIGH-5 — the payload VETO the permission policy wires as
 * `verifyOperationPayload`. It is consulted before EVERY approval the mediator
 * can grant, which is the whole point: binding the title to the payload INSIDE
 * the read-only classifier left the exact-allowlist path (checked first)
 * approving `Execute \`npm run typecheck\`` with a missing or hostile payload.
 *
 * A permission TITLE is human-readable prose the provider composes; ACP
 * `rawInput` is the payload it EXECUTES. A provider — or anything able to shape
 * a tool call — could present `Execute \`ls\`` while `rawInput.command` is
 * `rm -rf /`. For a SHELL title the two must be BYTE-IDENTICAL.
 *
 * Returns true for a NON-shell operation (a structured `Write`/`Edit` title):
 * there is no shell payload to bind, and the workspace-write rule adjudicates
 * those on the path itself. Fail-closed for shell titles on every gap: absent
 * `rawInput`, a non-object, a missing/non-string `command`, or any divergence.
 */
export function grokShellPayloadMatchesTitle(operation: string | undefined, rawInput: unknown): boolean {
  const classified = classifyGrokOperation(operation, rawInput);
  switch (classified.kind) {
    case 'shell':
      // The command the provider will EXECUTE must be byte-identical to the one
      // the title displays.
      return classified.executed !== undefined && classified.executed === classified.titled;
    case 'structured_file':
      // Positively a structured file operation with no shell payload at all —
      // there is nothing to bind, and the workspace-write rule adjudicates it on
      // the PATH.
      return true;
    case 'unknown':
      // ROUND 6 — inability to understand something is never evidence of its
      // safety. Previously "non-shell" was CONCLUDED from two failed parses, so
      // an exactly-allowlisted but malformed title like `Execute ls` with no
      // rawInput was vacuously approvable. Anything not POSITIVELY recognised as
      // non-shell must carry a bound command, and by definition an unrecognised
      // operation has no title command to bind against — so it is refused.
      return false;
  }
}

/** Positively-recognised operation shapes; everything else is `unknown`. */
type GrokOperationClass =
  | { readonly kind: 'shell'; readonly titled: string; readonly executed: string | undefined }
  | { readonly kind: 'structured_file' }
  | { readonly kind: 'unknown' };

/**
 * ROUND 6 — determine the operation KIND AFFIRMATIVELY, from the title shape AND
 * the payload shape together, rather than inferring "not a shell request" from a
 * parse that failed.
 *
 * The distinction matters because this is a fail-closed gate: a title we cannot
 * parse is not evidence of anything, so it can only ever be `unknown`. A
 * structured file operation is recognised POSITIVELY — a `Write`/`Edit` title
 * with a readable path AND a payload carrying no `command` — which is why a
 * `Write` title smuggling `{command: …}` falls through to `unknown` instead of
 * being waved past as "not shell".
 *
 * `Write`/`Edit` matching mirrors `isWorkspaceWriteOperation`'s own shape, so the
 * two rules cannot disagree about what a structured file operation looks like.
 */
function classifyGrokOperation(operation: string | undefined, rawInput: unknown): GrokOperationClass {
  if (operation === undefined) return { kind: 'unknown' };
  const command = readPayloadField(rawInput, 'command');
  const titled = commandFromPermissionTitle(operation);
  if (titled !== undefined) {
    return { kind: 'shell', titled, executed: command.kind === 'string' ? command.value : undefined };
  }

  // ROUND 7 (Finding 4): a structured file operation is recognised only when the
  // payload is POSITIVELY free of a command. A MALFORMED command
  // (`{command: 42}`) is not an absent one — we failed to read something that
  // was there — so it can only be `unknown`.
  if (command.kind !== 'absent') return { kind: 'unknown' };
  const titledPath = pathFromStructuredFileTitle(operation);
  if (titledPath === undefined) return { kind: 'unknown' };

  // ...and BIND the path the title asserts. Without this the veto never compared
  // `rawInput.path` to the title's, so `Write \`<inside-worktree>\`` carrying
  // `{path: "<outside>"}` passed both the veto and the title-based
  // workspace-containment check — which inspects the TITLE — making that
  // containment check decorative. Every field the title asserts must be bound,
  // not just the command.
  const payloadPath = readPayloadField(rawInput, 'path');
  switch (payloadPath.kind) {
    case 'absent':
      // Nothing asserted twice; the workspace rule adjudicates the title's path.
      return { kind: 'structured_file' };
    case 'string':
      return payloadPath.value === titledPath ? { kind: 'structured_file' } : { kind: 'unknown' };
    case 'malformed':
      return { kind: 'unknown' };
  }
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
