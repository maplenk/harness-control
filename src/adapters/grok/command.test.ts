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
  isGrokReadOnlyShellPermissionTitle,
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
      'strict',
      '--permission-mode',
      'auto',
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

describe('isGrokReadOnlyShellPermissionTitle', () => {
  it('accepts the observed multi-command repository inspection and quoted search pipelines', () => {
    expect(
      isGrokReadOnlyShellPermissionTitle(
        'Execute `git log --oneline -5 && git rev-parse HEAD && ls -la scripts/dogfood/ 2>/dev/null; head -50 scripts/dogfood/slice-1a.sh 2>/dev/null || true`',
      ),
    ).toBe(true);
    expect(
      isGrokReadOnlyShellPermissionTitle('Execute `rg -n "foo|bar" src | head -50`'),
    ).toBe(true);
  });

  it.each([
    'Execute `git status && rm -rf .`',
    'Execute `git status && curl https://example.invalid/upload`',
    'Execute `mkdir -p src/app/commands`',
    'Execute `echo changed > output.txt`',
    'Execute `cat /Users/example/.ssh/id_ed25519`',
    'Execute `cat ../outside.txt`',
    'Execute `rg --pre ./steal needle .`',
    'Execute `git diff --ext-diff`',
    'Execute `git log --output=history.txt`',
    'Execute `git log $(curl https://example.invalid)`',
    'Execute `git log & curl https://example.invalid`',
    'Execute `npm run typecheck`',
  ])('rejects unsafe or undeclared shell operation: %s', (operation) => {
    expect(isGrokReadOnlyShellPermissionTitle(operation)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // F11 — SINGLE-quoted spans are opaque literals.
  //
  // The scanners rejected `$`, `\` and a backtick ANYWHERE, because the
  // character check ran BEFORE the quote-state handling. POSIX single quotes are
  // expansion-free, so those bytes are inert inside them — and a regex argument
  // is where they naturally appear. The live consequence: an implementor turn
  // died because `rg -n '3A\.1|…'` was UNCLASSIFIABLE and therefore denied.
  //
  // Outside single quotes (INCLUDING inside double quotes, where the shell does
  // expand) the conservative rejection is unchanged.
  // -------------------------------------------------------------------------
  it('accepts the exact command whose denial killed the implementor turn (single-quoted regex)', () => {
    expect(
      isGrokReadOnlyShellPermissionTitle(
        "Execute `git show 481e772:docs/UI-IMPLEMENTATION-PLAN.md | head -n 5; rg -n '3A\\.1|ApplicationCommand|Phase A0' docs/UI-IMPLEMENTATION-PLAN.md | head -50; ls -la src/cli/ src/app/ 2>/dev/null | head -80`",
      ),
    ).toBe(true);
  });

  it.each([
    ["a backslash escape in a single-quoted regex", "Execute `rg -n '3A\\.1' docs/plan.md`"],
    ['a literal $ anchor in a single-quoted regex', "Execute `rg -n 'foo$' src`"],
    ['single-quoted command-substitution TEXT (inert: sh never expands it)', "Execute `rg -n '$(rm -rf /)' src`"],
    ['single-quoted parentheses/braces', "Execute `rg -n '(a|b){2}' src`"],
  ])('accepts %s', (_label, operation) => {
    expect(isGrokReadOnlyShellPermissionTitle(operation)).toBe(true);
  });

  it.each([
    ['the same regex DOUBLE-quoted (the shell WOULD expand it)', 'Execute `rg -n "3A\\.1|ApplicationCommand" docs/plan.md`'],
    ['a double-quoted $ (parameter expansion is live)', 'Execute `rg -n "$HOME" src`'],
    ['a double-quoted command substitution', 'Execute `rg -n "$(cat /etc/passwd)" src`'],
    ['an UNQUOTED command substitution', 'Execute `rg -n $(cat /etc/passwd) src`'],
    ['an unquoted backslash', 'Execute `rg -n 3A\\.1 docs/plan.md`'],
    ['an unquoted parenthesis (subshell)', 'Execute `(rg -n foo src)`'],
    ['an UNTERMINATED single quote', "Execute `rg -n 'unterminated src`"],
  ])('still rejects %s', (_label, operation) => {
    expect(isGrokReadOnlyShellPermissionTitle(operation)).toBe(false);
  });

  it('a single-quoted span never smuggles a segment separator or a redirection', () => {
    // `;` / `&&` / `|` / `>` inside single quotes are literal ARGUMENT bytes, so
    // the command stays ONE segment whose leading token is still an allowlisted
    // reader — it cannot introduce a second, unclassified command.
    expect(isGrokReadOnlyShellPermissionTitle("Execute `rg -n 'a; rm -rf /' src`")).toBe(true);
    expect(isGrokReadOnlyShellPermissionTitle("Execute `rg -n 'a > out.txt' src`")).toBe(true);
    // ...while the UNQUOTED forms are classified as what they are.
    expect(isGrokReadOnlyShellPermissionTitle('Execute `rg -n a src; rm -rf /`')).toBe(false);
    expect(isGrokReadOnlyShellPermissionTitle('Execute `rg -n a src > out.txt`')).toBe(false);
  });

  it('a single-quoted ESCAPING path argument is still refused (quoting is not a bypass)', () => {
    expect(isGrokReadOnlyShellPermissionTitle("Execute `cat '/etc/passwd'`")).toBe(false);
    expect(isGrokReadOnlyShellPermissionTitle("Execute `cat '../outside.txt'`")).toBe(false);
  });

  it('control characters are refused inside single quotes too (a NUL is never a literal)', () => {
    // CR/LF cannot even reach the scanner (the `Execute ...` wrapper excludes
    // them), but a NUL can — and single-quoting must not make it acceptable.
    const nul = String.fromCharCode(0);
    expect(isGrokReadOnlyShellPermissionTitle("Execute `rg -n 'a" + nul + "b' src`")).toBe(false);
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
