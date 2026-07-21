/** Per-run Grok Build home/config isolation for SuperGrok subscription auth. */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import type { RoleName } from '../../domain/state.js';
import { grokAuthJsonPath } from './auth.js';
import { grokSandboxProfileForRole, type GrokSandboxProfile } from './capabilities.js';

export const GROK_HOME_ENV_VAR = 'GROK_HOME';
export const GROK_ISOLATION_ENV_KEYS: readonly string[] = [
  'HOME',
  GROK_HOME_ENV_VAR,
  'GROK_SUBAGENTS',
  'GROK_MEMORY',
  'GROK_TELEMETRY_ENABLED',
  'GROK_FEEDBACK_ENABLED',
] as const;

/**
 * The compatibility cells are load-bearing: Grok otherwise scans host
 * Claude/Cursor skills, hooks, plugins and MCP definitions even when
 * GROK_HOME is isolated. HOME is separately pinned to stop those scans at
 * the fresh tree. Project executable extensions stay behind Grok's folder
 * trust gate; the isolated home deliberately carries no trust database.
 */
export function renderOrchestratorGrokConfig(): string {
  return `[cli]
auto_update = false
use_leader = false

[features]
support_permission = true
telemetry = false
feedback = false
lsp_tools = false
codebase_indexing = false

[session]
load_envrc = false

[memory]
enabled = false

[subagents]
enabled = false

[compat.cursor]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.claude]
skills = false
rules = false
agents = false
mcps = false
hooks = false
sessions = false

[compat.codex]
sessions = false

[plugins]
paths = []
disabled = []

[mcp_servers]
`;
}

export interface PrepareGrokHomeOptions {
  /** Source HOME containing `.grok/auth.json`; never modified. */
  readonly realHome?: string;
  readonly tempRoot?: string;
  readonly role?: RoleName;
}

export type GrokAuthMaterial = 'auth_json' | 'none';

export interface PreparedGrokHome {
  readonly dir: string;
  readonly configPath: string;
  readonly authPath: string;
  readonly authMaterial: GrokAuthMaterial;
  readonly sandboxProfile: GrokSandboxProfile;
  readonly env: Readonly<Record<string, string>>;
  readonly dispose: () => void;
}

export function prepareGrokHomeIsolation(
  options: PrepareGrokHomeOptions = {},
): PreparedGrokHome {
  const realHome = options.realHome ?? homedir();
  const dir = mkdtempSync(path.join(options.tempRoot ?? tmpdir(), 'harness-grok-home-'));
  try {
    chmodSync(dir, 0o700);
    const configPath = path.join(dir, 'config.toml');
    writeFileSync(configPath, renderOrchestratorGrokConfig(), { encoding: 'utf8', mode: 0o600 });
    chmodSync(configPath, 0o600);

    // GROK_HOME points directly at `dir`, so the isolated credential sits at
    // `${GROK_HOME}/auth.json` rather than `${HOME}/.grok/auth.json`.
    const authPath = path.join(dir, 'auth.json');
    const realAuthPath = grokAuthJsonPath(realHome);
    let authMaterial: GrokAuthMaterial = 'none';
    if (existsSync(realAuthPath)) {
      const source = lstatSync(realAuthPath);
      if (!source.isFile() || source.isSymbolicLink()) {
        throw new Error(
          `Refusing non-regular Grok credential store at ${realAuthPath}; expected a regular auth.json file`,
        );
      }
      copyFileSync(realAuthPath, authPath);
      chmodSync(authPath, 0o600);
      authMaterial = 'auth_json';
    }

    const sandboxProfile = grokSandboxProfileForRole(options.role);
    const env = Object.freeze({
      HOME: dir,
      GROK_HOME: dir,
      GROK_SUBAGENTS: '0',
      GROK_MEMORY: '0',
      GROK_TELEMETRY_ENABLED: 'false',
      GROK_FEEDBACK_ENABLED: 'false',
    });
    let disposed = false;
    return {
      dir,
      configPath,
      authPath,
      authMaterial,
      sandboxProfile,
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
