/**
 * Codex ACP profile — command resolution tests (PLAN §3, §10.1, §13).
 *
 * Resolves against the REAL, lockfile-pinned local
 * `node_modules/@agentclientprotocol/codex-acp` install (verifying the
 * exact absolute path called out in the task brief) for the happy path, and
 * against temp fake package layouts for every failure mode — never spawns
 * the adapter process itself.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAdapterError } from '../spi.js';
import {
  CODEX_BIN_NAME,
  CODEX_PACKAGE_NAME,
  EXPECTED_CODEX_ADAPTER_VERSION,
  assertCodexAdapterVersionPinned,
  checkVersionPin,
  resolveCodexCommand,
  tryResolveCodexCommand,
} from './command.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-command-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function fakeInstall(options: {
  readonly packageJson?: string;
  readonly writeBinFile?: boolean;
}): string {
  const root = makeTempDir();
  const packageDir = path.join(root, 'node_modules', '@agentclientprotocol', 'codex-acp');
  mkdirSync(packageDir, { recursive: true });
  const packageJson =
    options.packageJson ??
    JSON.stringify({ name: CODEX_PACKAGE_NAME, version: '1.1.4', bin: { 'codex-acp': 'dist/index.js' } });
  writeFileSync(path.join(packageDir, 'package.json'), packageJson, 'utf8');
  if (options.writeBinFile ?? true) {
    mkdirSync(path.join(packageDir, 'dist'), { recursive: true });
    writeFileSync(path.join(packageDir, 'dist', 'index.js'), '// fake bin\n', 'utf8');
  }
  return root;
}

describe('resolveCodexCommand (real lockfile-pinned install)', () => {
  it('resolves the exact pinned binary this repo ships (verified to exist)', () => {
    const resolved = resolveCodexCommand();
    expect(resolved.packageName).toBe(CODEX_PACKAGE_NAME);
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.args).toEqual([resolved.binPath]);
    expect(resolved.binPath.endsWith(path.join('dist', 'index.js'))).toBe(true);
    expect(existsSync(resolved.binPath)).toBe(true);
    expect(resolved.packageDir).toBe(
      path.join(REPO_ROOT, 'node_modules', '@agentclientprotocol', 'codex-acp'),
    );
    const npmBinSymlink = path.join(REPO_ROOT, 'node_modules', '.bin', CODEX_BIN_NAME);
    expect(existsSync(npmBinSymlink)).toBe(true);
  });

  it('reports the currently-installed version (matches EXPECTED_CODEX_ADAPTER_VERSION today)', () => {
    const resolved = resolveCodexCommand();
    expect(resolved.version).toBe(EXPECTED_CODEX_ADAPTER_VERSION);
  });

  it('never falls back to npx -y: args is exactly [binPath], nothing else', () => {
    const resolved = resolveCodexCommand();
    expect(resolved.args).toHaveLength(1);
    expect(resolved.args[0]).toBe(resolved.binPath);
  });
});

describe('resolveCodexCommand failure modes (typed, never silent)', () => {
  it('throws spawn_failed when the package is not installed anywhere up the tree', () => {
    const root = makeTempDir();
    let thrown: unknown;
    try {
      resolveCodexCommand({ fromDir: root });
    } catch (error) {
      thrown = error;
    }
    expect(isAdapterError(thrown)).toBe(true);
    expect(thrown).toMatchObject({ kind: 'spawn_failed' });
    expect(String((thrown as Error).message)).toContain('npx');
  });

  it('throws spawn_failed when package.json has no bin field', () => {
    const root = fakeInstall({ packageJson: JSON.stringify({ name: CODEX_PACKAGE_NAME, version: '1.1.4' }) });
    expect(() => resolveCodexCommand({ fromDir: root })).toThrowError(/bin\.codex-acp/);
  });

  it('throws spawn_failed when the bin field names a different key', () => {
    const root = fakeInstall({
      packageJson: JSON.stringify({
        name: CODEX_PACKAGE_NAME,
        version: '1.1.4',
        bin: { 'some-other-name': 'dist/index.js' },
      }),
    });
    expect(() => resolveCodexCommand({ fromDir: root })).toThrowError(/bin\.codex-acp/);
  });

  it('throws spawn_failed when the resolved bin file does not exist on disk', () => {
    const root = fakeInstall({ writeBinFile: false });
    expect(() => resolveCodexCommand({ fromDir: root })).toThrowError(/does not exist on disk/);
  });

  it('throws spawn_failed when package.json has no version field', () => {
    const root = fakeInstall({
      packageJson: JSON.stringify({ name: CODEX_PACKAGE_NAME, bin: { 'codex-acp': 'dist/index.js' } }),
    });
    expect(() => resolveCodexCommand({ fromDir: root })).toThrowError(/"version"/);
  });

  it('throws spawn_failed when package.json is malformed JSON', () => {
    const root = fakeInstall({ packageJson: '{ not valid json' });
    expect(() => resolveCodexCommand({ fromDir: root })).toThrowError(/parse/);
  });

  it('walks up multiple directory levels to find node_modules', () => {
    const root = fakeInstall({});
    const deepDir = path.join(root, 'a', 'b', 'c');
    mkdirSync(deepDir, { recursive: true });
    const resolved = resolveCodexCommand({ fromDir: deepDir });
    expect(resolved.packageDir).toBe(path.join(root, 'node_modules', '@agentclientprotocol', 'codex-acp'));
  });
});

describe('tryResolveCodexCommand (non-throwing variant)', () => {
  it('returns Ok for the real install', () => {
    const result = tryResolveCodexCommand();
    expect(result.ok).toBe(true);
  });

  it('returns Err with the typed AdapterError instead of throwing', () => {
    const root = makeTempDir();
    const result = tryResolveCodexCommand({ fromDir: root });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(isAdapterError(result.error)).toBe(true);
      expect(result.error.kind).toBe('spawn_failed');
    }
  });
});

describe('checkVersionPin (pure)', () => {
  it('reports pinned when versions match', () => {
    expect(checkVersionPin('1.1.4', '1.1.4')).toEqual({
      pinned: true,
      expectedVersion: '1.1.4',
      installedVersion: '1.1.4',
    });
  });

  it('reports drift when versions differ', () => {
    expect(checkVersionPin('1.2.0', '1.1.4')).toEqual({
      pinned: false,
      expectedVersion: '1.1.4',
      installedVersion: '1.2.0',
    });
  });
});

describe('assertCodexAdapterVersionPinned (re-characterization trigger, extended from PLAN §13)', () => {
  it('does not throw against the real pinned install and returns the resolved command', () => {
    const resolved = assertCodexAdapterVersionPinned();
    expect(resolved.version).toBe(EXPECTED_CODEX_ADAPTER_VERSION);
  });

  it('FAILS LOUDLY (throws, with an unmissable message) when the installed version drifts', () => {
    const root = fakeInstall({
      packageJson: JSON.stringify({
        name: CODEX_PACKAGE_NAME,
        version: '1.2.0',
        bin: { 'codex-acp': 'dist/index.js' },
      }),
    });
    let thrown: unknown;
    try {
      assertCodexAdapterVersionPinned({ fromDir: root });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('RE-CHARACTERIZATION TRIGGER');
    expect(message).toContain('1.1.4');
    expect(message).toContain('1.2.0');
    expect(message).toContain('re-verified');
  });
});
