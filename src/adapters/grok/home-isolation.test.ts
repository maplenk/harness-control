import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grokAuthJsonPath } from './auth.js';
import {
  GROK_ISOLATION_ENV_KEYS,
  prepareGrokHomeIsolation,
  renderOrchestratorGrokConfig,
} from './home-isolation.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'grok-home-test-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('prepareGrokHomeIsolation', () => {
  it('copies only auth.json and writes a private orchestrator config', () => {
    const realHome = root();
    const tempRoot = root();
    const sourceAuth = grokAuthJsonPath(realHome);
    mkdirSync(path.dirname(sourceAuth), { recursive: true });
    writeFileSync(sourceAuth, 'super-secret', { mode: 0o600 });
    writeFileSync(path.join(realHome, '.grok', 'host-config.toml'), 'must not copy');

    const prepared = prepareGrokHomeIsolation({ realHome, tempRoot, role: 'implementor' });
    expect(prepared.env.HOME).toBe(prepared.dir);
    expect(prepared.env.GROK_HOME).toBe(prepared.dir);
    expect(prepared.authMaterial).toBe('auth_json');
    expect(readFileSync(prepared.authPath, 'utf8')).toBe('super-secret');
    expect(statSync(prepared.dir).mode & 0o777).toBe(0o700);
    expect(statSync(prepared.authPath).mode & 0o777).toBe(0o600);
    expect(statSync(prepared.configPath).mode & 0o777).toBe(0o600);
    expect(existsSync(path.join(prepared.dir, 'host-config.toml'))).toBe(false);
    expect(prepared.sandboxProfile).toBe('strict');
    prepared.dispose();
    expect(existsSync(prepared.dir)).toBe(false);
    prepared.dispose();
  });

  it('works with XAI_API_KEY-only auth and defaults unknown roles to read-only', () => {
    const prepared = prepareGrokHomeIsolation({ realHome: root(), tempRoot: root() });
    expect(prepared.authMaterial).toBe('none');
    expect(prepared.sandboxProfile).toBe('read-only');
    expect(existsSync(prepared.authPath)).toBe(false);
    prepared.dispose();
  });

  it('pins every security-load-bearing environment key', () => {
    const prepared = prepareGrokHomeIsolation({ realHome: root(), tempRoot: root() });
    expect(Object.keys(prepared.env).sort()).toEqual([...GROK_ISOLATION_ENV_KEYS].sort());
    prepared.dispose();
  });
});

describe('renderOrchestratorGrokConfig', () => {
  it('disables update, leader, memory, subagents and vendor compatibility', () => {
    const config = renderOrchestratorGrokConfig();
    expect(config).toContain('auto_update = false');
    expect(config).toContain('use_leader = false');
    expect(config).toContain('[memory]\nenabled = false');
    expect(config).toContain('[subagents]\nenabled = false');
    expect(config).toContain('[compat.claude]');
    expect(config).toContain('[compat.cursor]');
    expect(config.match(/mcps = false/g)).toHaveLength(2);
  });
});
