import { describe, expect, it } from 'vitest';
import {
  EXPECTED_OPENCODE_VERSION,
  OPENCODE_PACKAGE_NAME,
  assertOpenCodeVersionPinned,
  checkVersionPin,
  resolveOpenCodeCommand,
} from './command.js';

describe('OpenCode command resolution', () => {
  it('resolves the exact lockfile package native binary and ACP subcommand', () => {
    const resolved = resolveOpenCodeCommand();
    expect(resolved.packageName).toBe(OPENCODE_PACKAGE_NAME);
    expect(resolved.version).toBe(EXPECTED_OPENCODE_VERSION);
    expect(resolved.command).toBe(resolved.binPath);
    expect(resolved.args).toEqual(['acp', '--pure']);
    expect(resolved.binPath).toContain('node_modules/opencode-ai/');
  });

  it('pins the characterized version loudly', () => {
    expect(assertOpenCodeVersionPinned().version).toBe(EXPECTED_OPENCODE_VERSION);
    expect(checkVersionPin('other', EXPECTED_OPENCODE_VERSION).pinned).toBe(false);
  });
});
