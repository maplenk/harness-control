/**
 * OpenCode H-1 spawn isolation tests. Every source HOME is a fixture; the
 * developer's real OpenCode config/auth store is never read.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OPENCODE_AUTH_JSON_RELATIVE_PATH } from './auth.js';
import {
  OPENCODE_CONFIG_CONTENT_ENV_VAR,
  OPENCODE_DISABLE_PROJECT_CONFIG_ENV_VAR,
  OPENCODE_ISOLATION_ENV_KEYS,
  OPENCODE_PERMISSION_ENV_VAR,
  openCodePermissionPolicyForRole,
  prepareOpenCodeHomeIsolation,
  renderOrchestratorOpenCodeConfig,
} from './home-isolation.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(options: { auth?: string | false; hostileConfig?: boolean } = {}): {
  readonly realHome: string;
  readonly tempRoot: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'opencode-home-isolation-test-'));
  roots.push(root);
  const realHome = path.join(root, 'real-home');
  const tempRoot = path.join(root, 'isolated');
  mkdirSync(realHome, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  if (options.auth !== false) {
    const authPath = path.join(realHome, OPENCODE_AUTH_JSON_RELATIVE_PATH);
    mkdirSync(path.dirname(authPath), { recursive: true });
    writeFileSync(authPath, options.auth ?? 'opaque-auth-bytes', { mode: 0o600 });
  }
  if (options.hostileConfig === true) {
    const configDir = path.join(realHome, '.config', 'opencode');
    mkdirSync(path.join(configDir, 'agents'), { recursive: true });
    writeFileSync(
      path.join(configDir, 'opencode.json'),
      JSON.stringify({
        permission: 'allow',
        mcp: { hostile_mcp: { type: 'local', command: ['false'] } },
      }),
    );
    writeFileSync(
      path.join(configDir, 'agents', 'hostile.md'),
      '---\ndescription: hostile\npermission:\n  "*": allow\n---\n',
    );
  }
  return { realHome, tempRoot };
}

const modeBits = (p: string): number => statSync(p).mode & 0o777;

describe('OpenCode role permission policy', () => {
  it('allows structured worktree edits only for implementor and asks for every unlisted tool', () => {
    const implementor = openCodePermissionPolicyForRole('implementor');
    expect(implementor).toEqual({
      '*': 'ask',
      read: 'allow',
      glob: 'allow',
      grep: 'allow',
      edit: 'allow',
      task: 'deny',
    });
    expect(openCodePermissionPolicyForRole('coordinator').edit).toBe('deny');
    expect(openCodePermissionPolicyForRole('verifier').edit).toBe('deny');
    expect(openCodePermissionPolicyForRole(undefined).edit).toBe('deny');
  });

  it('pins the same policy globally and onto the built-in plan/build agents', () => {
    const config = JSON.parse(renderOrchestratorOpenCodeConfig('implementor')) as {
      permission: unknown;
      agent: { plan: { permission: unknown }; build: { permission: unknown } };
      mcp: unknown;
      plugin: unknown;
    };
    const expected = openCodePermissionPolicyForRole('implementor');
    expect(config.permission).toEqual(expected);
    expect(config.agent.plan.permission).toEqual(expected);
    expect(config.agent.build.permission).toEqual(expected);
    expect(config.mcp).toEqual({});
    expect(config.plugin).toEqual([]);
  });
});

describe('prepareOpenCodeHomeIsolation', () => {
  it('creates private HOME/XDG/config paths and injects every isolation lever', () => {
    const { realHome, tempRoot } = fixture();
    const prepared = prepareOpenCodeHomeIsolation({
      realHome,
      tempRoot,
      role: 'implementor',
    });
    expect(modeBits(prepared.dir)).toBe(0o700);
    expect(modeBits(prepared.configPath)).toBe(0o600);
    expect(prepared.env['HOME']).toBe(prepared.dir);
    expect(prepared.env['XDG_CONFIG_HOME']).toBe(path.join(prepared.dir, '.config'));
    expect(prepared.env['XDG_DATA_HOME']).toBe(path.join(prepared.dir, '.local', 'share'));
    expect(prepared.env[OPENCODE_DISABLE_PROJECT_CONFIG_ENV_VAR]).toBe('true');
    expect(JSON.parse(prepared.env[OPENCODE_PERMISSION_ENV_VAR]!)).toEqual(
      prepared.permissionPolicy,
    );
    expect(prepared.env[OPENCODE_CONFIG_CONTENT_ENV_VAR]).toBe(
      readFileSync(prepared.configPath, 'utf8'),
    );
    for (const key of OPENCODE_ISOLATION_ENV_KEYS) {
      if (key === 'OPENCODE_CONFIG') continue; // deliberately absent, therefore un-overridable
      expect(prepared.env[key], `${key} must be pinned`).toBeDefined();
    }
    prepared.dispose();
  });

  it('byte-copies auth.json at 0600 and never writes refreshes back', () => {
    const { realHome, tempRoot } = fixture({ auth: 'subscription-auth-fixture' });
    const realAuth = path.join(realHome, OPENCODE_AUTH_JSON_RELATIVE_PATH);
    const prepared = prepareOpenCodeHomeIsolation({ realHome, tempRoot });
    expect(prepared.authMaterial).toBe('auth_json');
    expect(readFileSync(prepared.authPath, 'utf8')).toBe('subscription-auth-fixture');
    expect(modeBits(prepared.authPath)).toBe(0o600);
    writeFileSync(prepared.authPath, 'isolated-refresh');
    expect(readFileSync(realAuth, 'utf8')).toBe('subscription-auth-fixture');
    prepared.dispose();
  });

  it('copies no host config, custom agents, MCP definitions, or permissions', () => {
    const { realHome, tempRoot } = fixture({ hostileConfig: true });
    const prepared = prepareOpenCodeHomeIsolation({ realHome, tempRoot, role: 'verifier' });
    const config = readFileSync(prepared.configPath, 'utf8');
    expect(config).not.toContain('hostile');
    expect(JSON.parse(config)).toMatchObject({
      permission: { '*': 'ask', edit: 'deny', task: 'deny' },
      mcp: {},
      plugin: [],
    });
    expect(readdirSync(path.dirname(prepared.configPath))).toEqual(['opencode.json']);
    expect(existsSync(path.join(path.dirname(prepared.configPath), 'agents'))).toBe(false);
    prepared.dispose();
  });

  it('missing auth still produces a complete isolated config boundary', () => {
    const { realHome, tempRoot } = fixture({ auth: false });
    const prepared = prepareOpenCodeHomeIsolation({ realHome, tempRoot });
    expect(prepared.authMaterial).toBe('none');
    expect(existsSync(prepared.authPath)).toBe(false);
    expect(existsSync(prepared.configPath)).toBe(true);
    prepared.dispose();
  });

  it('refuses a symlink credential source instead of copying an arbitrary file', () => {
    const { realHome, tempRoot } = fixture({ auth: false });
    const target = path.join(realHome, 'unrelated-secret');
    writeFileSync(target, 'must-not-copy');
    const authPath = path.join(realHome, OPENCODE_AUTH_JSON_RELATIVE_PATH);
    mkdirSync(path.dirname(authPath), { recursive: true });
    symlinkSync(target, authPath);
    expect(() => prepareOpenCodeHomeIsolation({ realHome, tempRoot })).toThrow(
      /Refusing non-regular OpenCode credential store/,
    );
    expect(lstatSync(authPath).isSymbolicLink()).toBe(true);
  });

  it('dispose removes the whole per-run tree and is idempotent', () => {
    const { realHome, tempRoot } = fixture();
    const prepared = prepareOpenCodeHomeIsolation({ realHome, tempRoot });
    expect(existsSync(prepared.dir)).toBe(true);
    prepared.dispose();
    expect(existsSync(prepared.dir)).toBe(false);
    prepared.dispose();
  });
});
