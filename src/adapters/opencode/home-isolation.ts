/**
 * OpenCode spawn-time provider isolation (H-1).
 *
 * OpenCode 1.18.1 loads executable policy from several host-controlled
 * locations: the user XDG config directory, project `opencode.json` and
 * `.opencode/` directories, external plugins/skills, MCP definitions, and
 * managed config. Its default permission posture also allows most tools
 * without asking. A build-mode child that inherits those defaults can execute
 * edits or shell commands without ever emitting ACP
 * `session/request_permission`.
 *
 * Every harness spawn therefore gets a fresh HOME/XDG tree containing only a
 * byte-copy of OpenCode's auth store and an orchestrator-owned config. The
 * child is additionally started with `--pure`; project config and external
 * skills are disabled; a private empty config-extension/managed-config
 * directory is selected; and OPENCODE_PERMISSION is applied last by the
 * pinned binary so lower-precedence config cannot turn guarded tools back to
 * `allow`.
 *
 * The role policy intentionally allows only non-executable workspace
 * discovery (`read`/`glob`/`grep`). The implementor may also use OpenCode's
 * structured `edit` tool inside its assigned worktree. Everything else asks
 * the ACP client (and is default-denied headlessly); `task` is denied outright
 * because orchestration owns delegation. Coordinator/verifier edits are
 * denied outright.
 *
 * Credential hygiene matches Codex isolation: auth.json is copied kernel-side
 * with 0600 permissions into a 0700 per-run tree. Its contents never enter
 * orchestrator memory, logs, errors, or durable state. The copy is deleted
 * when the adapter closes and is never written back to the real store.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import type { RoleName } from '../../domain/state.js';
import { OPENCODE_AUTH_JSON_RELATIVE_PATH } from './auth.js';

export const OPENCODE_DISABLE_PROJECT_CONFIG_ENV_VAR = 'OPENCODE_DISABLE_PROJECT_CONFIG';
export const OPENCODE_PERMISSION_ENV_VAR = 'OPENCODE_PERMISSION';
export const OPENCODE_CONFIG_CONTENT_ENV_VAR = 'OPENCODE_CONFIG_CONTENT';

/** Every env key that is security-load-bearing for the isolated spawn. */
export const OPENCODE_ISOLATION_ENV_KEYS: readonly string[] = [
  'HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_CONFIG',
  'OPENCODE_CONFIG_CONTENT',
  'OPENCODE_CONFIG_DIR',
  'OPENCODE_PERMISSION',
  'OPENCODE_DISABLE_PROJECT_CONFIG',
  'OPENCODE_DISABLE_EXTERNAL_SKILLS',
  'OPENCODE_DISABLE_CLAUDE_CODE',
  'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS',
  'OPENCODE_DISABLE_LSP_DOWNLOAD',
  'OPENCODE_DISABLE_AUTOUPDATE',
  'OPENCODE_DISABLE_SHARE',
  'OPENCODE_TEST_MANAGED_CONFIG_DIR',
] as const;

export type OpenCodePermissionAction = 'allow' | 'ask' | 'deny';
export type OpenCodePermissionPolicy = Readonly<Record<string, OpenCodePermissionAction>>;

/**
 * Final permission overlay for OpenCode 1.18.1. The binary applies
 * OPENCODE_PERMISSION after file, remote-account, and managed JSON configs.
 */
export function openCodePermissionPolicyForRole(
  role: RoleName | undefined,
): OpenCodePermissionPolicy {
  return Object.freeze({
    '*': 'ask',
    read: 'allow',
    glob: 'allow',
    grep: 'allow',
    edit: role === 'implementor' ? 'allow' : 'deny',
    task: 'deny',
  });
}

/** Inline/global config duplicates the final env overlay at the agent level.
 * This prevents built-in `plan`/`build` agent defaults from widening the
 * global policy. OPENCODE_PERMISSION remains the last global safety belt. */
export function renderOrchestratorOpenCodeConfig(role: RoleName | undefined): string {
  const permission = openCodePermissionPolicyForRole(role);
  return `${JSON.stringify(
    {
      $schema: 'https://opencode.ai/config.json',
      permission,
      agent: {
        plan: { permission },
        build: { permission },
      },
      mcp: {},
      plugin: [],
    },
    null,
    2,
  )}\n`;
}

export interface PrepareOpenCodeHomeOptions {
  /** Source HOME containing `.local/share/opencode/auth.json`. */
  readonly realHome?: string;
  readonly tempRoot?: string;
  readonly role?: RoleName;
}

export type OpenCodeAuthMaterial = 'auth_json' | 'none';

export interface PreparedOpenCodeHome {
  /** Fresh 0700 HOME, removed by dispose(). */
  readonly dir: string;
  readonly configPath: string;
  readonly authPath: string;
  readonly authMaterial: OpenCodeAuthMaterial;
  readonly permissionPolicy: OpenCodePermissionPolicy;
  readonly env: Readonly<Record<string, string>>;
  readonly dispose: () => void;
}

function privateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

export function prepareOpenCodeHomeIsolation(
  options: PrepareOpenCodeHomeOptions = {},
): PreparedOpenCodeHome {
  const realHome = options.realHome ?? homedir();
  const tempRoot = options.tempRoot ?? tmpdir();
  const dir = mkdtempSync(path.join(tempRoot, 'harness-opencode-home-'));
  try {
    chmodSync(dir, 0o700);
    const xdgConfigHome = path.join(dir, '.config');
    const xdgDataHome = path.join(dir, '.local', 'share');
    const xdgCacheHome = path.join(dir, '.cache');
    const xdgStateHome = path.join(dir, '.local', 'state');
    const openCodeConfigDir = path.join(xdgConfigHome, 'opencode');
    const extensionConfigDir = path.join(dir, 'config-extension');
    const managedConfigDir = path.join(dir, 'managed-config');
    for (const directory of [
      xdgConfigHome,
      xdgDataHome,
      xdgCacheHome,
      xdgStateHome,
      openCodeConfigDir,
      extensionConfigDir,
      managedConfigDir,
    ]) {
      privateDir(directory);
    }

    const configText = renderOrchestratorOpenCodeConfig(options.role);
    const configPath = path.join(openCodeConfigDir, 'opencode.json');
    writeFileSync(configPath, configText, { encoding: 'utf8', mode: 0o600 });
    chmodSync(configPath, 0o600);

    const authPath = path.join(dir, OPENCODE_AUTH_JSON_RELATIVE_PATH);
    const realAuthPath = path.join(realHome, OPENCODE_AUTH_JSON_RELATIVE_PATH);
    let authMaterial: OpenCodeAuthMaterial = 'none';
    if (existsSync(realAuthPath)) {
      const source = lstatSync(realAuthPath);
      if (!source.isFile() || source.isSymbolicLink()) {
        throw new Error(
          `Refusing non-regular OpenCode credential store at ${realAuthPath}; expected a regular auth.json file`,
        );
      }
      privateDir(path.dirname(authPath));
      copyFileSync(realAuthPath, authPath);
      chmodSync(authPath, 0o600);
      authMaterial = 'auth_json';
    }

    const permissionPolicy = openCodePermissionPolicyForRole(options.role);
    const env = Object.freeze({
      HOME: dir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      XDG_STATE_HOME: xdgStateHome,
      OPENCODE_CONFIG_CONTENT: configText,
      OPENCODE_CONFIG_DIR: extensionConfigDir,
      OPENCODE_PERMISSION: JSON.stringify(permissionPolicy),
      OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
      OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE: 'true',
      OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: 'true',
      OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
      OPENCODE_DISABLE_AUTOUPDATE: 'true',
      OPENCODE_DISABLE_SHARE: 'true',
      // Source-characterized 1.18.1 lever: redirects file-based system
      // managed config away from the host. OS-admin mobileconfig remains an
      // OS trust boundary, not a user-config inheritance path.
      OPENCODE_TEST_MANAGED_CONFIG_DIR: managedConfigDir,
    });

    let disposed = false;
    return {
      dir,
      configPath,
      authPath,
      authMaterial,
      permissionPolicy,
      env,
      dispose: (): void => {
        if (disposed) return;
        disposed = true;
        rmSync(dir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
