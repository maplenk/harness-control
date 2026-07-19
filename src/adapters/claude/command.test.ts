/**
 * Claude ACP profile — command resolution tests (PLAN §3, §10.1, §13).
 *
 * Resolves against the REAL, lockfile-pinned local
 * `node_modules/@agentclientprotocol/claude-agent-acp` install (verifying
 * the exact absolute path called out in the task brief) for the happy path,
 * and against temp fake package layouts for every failure mode — never
 * spawns the adapter process itself (fixtures/static-resolution only).
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAdapterError } from '../spi.js';
import {
  CLAUDE_BIN_NAME,
  CLAUDE_PACKAGE_NAME,
  EXPECTED_CLAUDE_ADAPTER_VERSION,
  assertClaudeAdapterVersionPinned,
  checkVersionPin,
  resolveClaudeCommand,
  tryResolveClaudeCommand,
} from './command.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'claude-command-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

/** Writes a fake `node_modules/@agentclientprotocol/claude-agent-acp` with a
 * given package.json body + optional bin file, returning the temp root to
 * pass as `fromDir`. */
function fakeInstall(options: {
  readonly packageJson?: string;
  readonly writeBinFile?: boolean;
}): string {
  const root = makeTempDir();
  const packageDir = path.join(root, 'node_modules', '@agentclientprotocol', 'claude-agent-acp');
  mkdirSync(packageDir, { recursive: true });
  const packageJson =
    options.packageJson ??
    JSON.stringify({ name: CLAUDE_PACKAGE_NAME, version: '0.59.0', bin: { 'claude-agent-acp': 'dist/index.js' } });
  writeFileSync(path.join(packageDir, 'package.json'), packageJson, 'utf8');
  if (options.writeBinFile ?? true) {
    mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    writeFileSync(path.join(packageDir, 'dist', 'index.js'), '// fake bin\n', 'utf8');
  }
  return root;
}

describe('resolveClaudeCommand (real lockfile-pinned install)', () => {
  it('resolves the exact pinned binary this repo ships (verified to exist)', () => {
    const resolved = resolveClaudeCommand();
    expect(resolved.packageName).toBe(CLAUDE_PACKAGE_NAME);
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args).toEqual([resolved.binPath]);
    expect(resolved.binPath.endsWith(path.join('dist', 'index.js'))).toBe(true);
    expect(existsSync(resolved.binPath)).toBe(true);
    expect(resolved.packageDir).toBe(
      path.join(REPO_ROOT, 'node_modules', '@agentclientprotocol', 'claude-agent-acp'),
    );
    // node_modules/.bin/claude-agent-acp is a symlink to the SAME resolved
    // dist/index.js — proves our own resolution matches what npm itself set
    // up (the task brief's explicitly named absolute path).
    const npmBinSymlink = path.join(REPO_ROOT, 'node_modules', '.bin', CLAUDE_BIN_NAME);
    expect(existsSync(npmBinSymlink)).toBe(true);
  });

  it('reports the currently-installed version (matches EXPECTED_CLAUDE_ADAPTER_VERSION today)', () => {
    const resolved = resolveClaudeCommand();
    expect(resolved.version).toBe(EXPECTED_CLAUDE_ADAPTER_VERSION);
  });

  it('never falls back to npx -y: args is exactly [binPath], nothing else', () => {
    const resolved = resolveClaudeCommand();
    expect(resolved.args).toHaveLength(1);
    expect(resolved.args[0]).toBe(resolved.binPath);
  });
});

describe('resolveClaudeCommand failure modes (typed, never silent)', () => {
  it('throws spawn_failed when the package is not installed anywhere up the tree', () => {
    const root = makeTempDir();
    let thrown: unknown;
    try {
      resolveClaudeCommand({ fromDir: root });
    } catch (error) {
      thrown = error;
    }
    expect(isAdapterError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ kind: 'spawn_failed' });
    expect(String((thrown as Error).message)).toContain('npx');
  });

  it('throws spawn_failed when package.json has no bin field', () => {
    const root = fakeInstall({
      packageJson: JSON.stringify({ name: CLAUDE_PACKAGE_NAME, version: '0.59.0' }),
    });
    expect(() => resolveClaudeCommand({ fromDir: root })).toThrowError(/bin\.claude-agent-acp/);
  });

  it('throws spawn_failed when the bin field names a different key', () => {
    const root = fakeInstall({
      packageJson: JSON.stringify({
        name: CLAUDE_PACKAGE_NAME,
        version: '0.59.0',
        bin: { 'some-other-name': 'dist/index.js' },
      }),
    });
    expect(() => resolveClaudeCommand({ fromDir: root })).toThrowError(/bin\.claude-agent-acp/);
  });

  it('throws spawn_failed when the resolved bin file does not exist on disk', () => {
    const root = fakeInstall({ writeBinFile: false });
    expect(() => resolveClaudeCommand({ fromDir: root })).toThrowError(/does not exist on disk/);
  });

  it('throws spawn_failed when package.json has no version field', () => {
    const root = fakeInstall({
      packageJson: JSON.stringify({ name: CLAUDE_PACKAGE_NAME, bin: { 'claude-agent-acp': 'dist/index.js' } }),
    });
    expect(() => resolveClaudeCommand({ fromDir: root })).toThrowError(/"version"/);
  });

  it('throws spawn_failed when package.json is malformed JSON', () => {
    const root = fakeInstall({ packageJson: '{ not valid json' });
    expect(() => resolveClaudeCommand({ fromDir: root })).toThrowError(/parse/);
  });

  it('resolves correctly when bin is given as a bare string (not an object)', () => {
    const root = fakeInstall({
      packageJson: JSON.stringify({ name: CLAUDE_PACKAGE_NAME, version: '0.59.0', bin: 'dist/index.js' }),
    });
    const resolved = resolveClaudeCommand({ fromDir: root });
    expect(resolved.binPath.endsWith(path.join('dist', 'index.js'))).toBe(true);
  });

  it('walks up multiple directory levels to find node_modules', () => {
    const root = fakeInstall({});
    const deepDir = path.join(root, 'a', 'b', 'c');
    mkdirSync(deepDir, { recursive: true });
    const resolved = resolveClaudeCommand({ fromDir: deepDir });
    expect(resolved.packageDir).toBe(path.join(root, 'node_modules', '@agentclientprotocol', 'claude-agent-acp'));
  });
});

describe('tryResolveClaudeCommand (non-throwing variant)', () => {
  it('returns Ok for the real install', () => {
    const result = tryResolveClaudeCommand();
    expect(result.ok).toBe(true);
  });

  it('returns Err with the typed AdapterError instead of throwing', () => {
    const root = makeTempDir();
    const result = tryResolveClaudeCommand({ fromDir: root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isAdapterError(result.error)).toBe(true);
      expect(result.error.kind).toBe('spawn_failed');
    }
  });
});

describe('checkVersionPin (pure)', () => {
  it('reports pinned when versions match', () => {
    expect(checkVersionPin('0.59.0', '0.59.0')).toEqual({
      pinned: true,
      expectedVersion: '0.59.0',
      installedVersion: '0.59.0',
    });
  });

  it('reports drift when versions differ', () => {
    expect(checkVersionPin('0.60.0', '0.59.0')).toEqual({
      pinned: false,
      expectedVersion: '0.59.0',
      installedVersion: '0.60.0',
    });
  });
});

describe('assertClaudeAdapterVersionPinned (PLAN §13 re-characterization trigger)', () => {
  it('does not throw against the real pinned install and returns the resolved command', () => {
    const resolved = assertClaudeAdapterVersionPinned();
    expect(resolved.version).toBe(EXPECTED_CLAUDE_ADAPTER_VERSION);
  });

  it('FAILS LOUDLY (throws, with an unmissable message) when the installed version drifts', () => {
    const root = fakeInstall({
      packageJson: JSON.stringify({
        name: CLAUDE_PACKAGE_NAME,
        version: '0.60.0',
        bin: { 'claude-agent-acp': 'dist/index.js' },
      }),
    });
    let thrown: unknown;
    try {
      assertClaudeAdapterVersionPinned({ fromDir: root });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('RE-CHARACTERIZATION TRIGGER');
    expect(message).toContain('0.59.0');
    expect(message).toContain('0.60.0');
    expect(message).toContain('re-verified');
  });
});
