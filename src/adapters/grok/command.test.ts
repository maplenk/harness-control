import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isAdapterError } from '../spi.js';
import {
  GROK_PROVIDER_BIN_ENV_VAR,
  MINIMUM_GROK_VERSION,
  assertGrokMinimumVersion,
  buildGrokAcpArgs,
  checkGrokMinimumVersion,
  grokShellPermissionTitle,
  parseGrokVersion,
  resolveGrokCommand,
  tryResolveGrokCommand,
} from './command.js';

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'grok-command-test-'));
  tempDirs.push(dir);
  return dir;
}

function fakeGrok(version: string, root = tempDir()): string {
  const bin = path.join(root, 'grok');
  writeFileSync(bin, `#!/bin/sh\nprintf 'grok ${version} (test) [stable]\\n'\n`, 'utf8');
  chmodSync(bin, 0o700);
  return bin;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

describe('buildGrokAcpArgs', () => {
  it('pins security, model, effort, role sandbox, and official ACP subcommands', () => {
    expect(
      buildGrokAcpArgs({ model: 'grok-build', reasoningEffort: 'high', role: 'implementor' }),
    ).toEqual([
      '--no-auto-update',
      '--no-memory',
      '--no-subagents',
      '--disable-web-search',
      '--sandbox',
      'workspace',
      '--permission-mode',
      'acceptEdits',
      '--model',
      'grok-build',
      '--reasoning-effort',
      'high',
      'agent',
      '--no-leader',
      'stdio',
    ]);
  });

  it('fails closed to the read-only sandbox for non-implementors and an absent role', () => {
    for (const args of [
      buildGrokAcpArgs({ role: 'coordinator' }),
      buildGrokAcpArgs({ role: 'verifier' }),
      buildGrokAcpArgs(),
    ]) {
      expect(args).toContain('read-only');
      expect(args).toContain('dontAsk');
    }
  });
});

describe('grokShellPermissionTitle', () => {
  it('maps one declared command to Grok\'s exact ACP operation title', () => {
    expect(grokShellPermissionTitle('npm run typecheck')).toBe('Execute `npm run typecheck`');
  });

  it('fails closed for ambiguous operation-title bytes', () => {
    for (const command of ['', 'npm test\nrm -rf /', 'echo `whoami`', 'echo\0x']) {
      expect(() => grokShellPermissionTitle(command)).toThrow(/single-line command/i);
    }
  });
});

describe('Grok command resolution and minimum version', () => {
  it('prefers the explicit GROK_PROVIDER_BIN and parses the installed version', () => {
    const override = fakeGrok('0.2.106');
    const otherDir = tempDir();
    fakeGrok('9.9.9', otherDir);
    const resolved = resolveGrokCommand({
      env: { [GROK_PROVIDER_BIN_ENV_VAR]: override, PATH: otherDir },
      model: 'grok-build',
    });
    expect(resolved.command).toBe(override);
    expect(resolved.binPath).toBe(override);
    expect(resolved.version).toBe('0.2.106');
    expect(resolved.packageName).toBe('grok-build');
    expect(resolved.args).toContain('grok-build');
  });

  it('resolves grok from PATH when no override is configured', () => {
    const root = tempDir();
    const bin = fakeGrok('0.2.107', root);
    expect(resolveGrokCommand({ env: { PATH: root } }).binPath).toBe(bin);
  });

  it('does not fall back to PATH when an explicit override is invalid', () => {
    const root = tempDir();
    fakeGrok('9.9.9', root);
    const result = tryResolveGrokCommand({
      env: { PATH: root, [GROK_PROVIDER_BIN_ENV_VAR]: path.join(root, 'missing') },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('spawn_failed');
  });

  it('returns a typed spawn failure when no executable is available', () => {
    const result = tryResolveGrokCommand({ env: { PATH: tempDir() } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(isAdapterError(result.error)).toBe(true);
  });

  it('accepts the characterized minimum or newer and rejects older/prerelease equivalents', () => {
    expect(checkGrokMinimumVersion('0.2.106').supported).toBe(true);
    expect(checkGrokMinimumVersion('0.2.107').supported).toBe(true);
    expect(checkGrokMinimumVersion('0.3.0').supported).toBe(true);
    expect(checkGrokMinimumVersion('0.2.105').supported).toBe(false);
    expect(checkGrokMinimumVersion('0.2.106-beta.1').supported).toBe(false);
  });

  it('fails loudly when the installed binary predates the minimum', () => {
    const bin = fakeGrok('0.2.105');
    expect(() =>
      assertGrokMinimumVersion({ env: { [GROK_PROVIDER_BIN_ENV_VAR]: bin } }),
    ).toThrowError(new RegExp(MINIMUM_GROK_VERSION.replaceAll('.', '\\.')));
  });

  it('parses only Grok version output', () => {
    expect(parseGrokVersion('grok 0.2.106 (abc) [stable]')).toBe('0.2.106');
    expect(parseGrokVersion('other 0.2.106')).toBeUndefined();
  });
});
