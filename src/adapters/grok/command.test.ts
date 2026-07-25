import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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
        undefined,
      ),
    ).toBe(true);
    expect(
      isGrokReadOnlyShellPermissionTitle('Execute `rg -n "foo|bar" src | head -50`', undefined),
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
    expect(isGrokReadOnlyShellPermissionTitle(operation, undefined)).toBe(false);
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
    expect(isGrokReadOnlyShellPermissionTitle(operation, undefined)).toBe(true);
  });

  it('accepts the exact command whose denial killed the implementor turn (single-quoted regex)', () => {
    expect(
      isGrokReadOnlyShellPermissionTitle(
        "Execute `git show 481e772:docs/UI-IMPLEMENTATION-PLAN.md | head -n 5; rg -n '3A\\.1|ApplicationCommand|Phase A0' docs/UI-IMPLEMENTATION-PLAN.md | head -50; ls -la src/cli/ src/app/ 2>/dev/null | head -80`",
        undefined,
      ),
    ).toBe(true);
  });

  it.each([
    ["a backslash escape in a single-quoted regex", "Execute `rg -n '3A\\.1' docs/plan.md`"],
    ['a literal $ anchor in a single-quoted regex', "Execute `rg -n 'foo$' src`"],
    ['single-quoted command-substitution TEXT (inert: sh never expands it)', "Execute `rg -n '$(rm -rf /)' src`"],
    ['single-quoted parentheses/braces', "Execute `rg -n '(a|b){2}' src`"],
  ])('accepts %s', (_label, operation) => {
    expect(isGrokReadOnlyShellPermissionTitle(operation, undefined)).toBe(true);
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
    expect(isGrokReadOnlyShellPermissionTitle(operation, undefined)).toBe(false);
  });

  it('a single-quoted span never smuggles a segment separator or a redirection', () => {
    // `;` / `&&` / `|` / `>` inside single quotes are literal ARGUMENT bytes, so
    // the command stays ONE segment whose leading token is still an allowlisted
    // reader — it cannot introduce a second, unclassified command.
    expect(isGrokReadOnlyShellPermissionTitle("Execute `rg -n 'a; rm -rf /' src`", undefined)).toBe(true);
    expect(isGrokReadOnlyShellPermissionTitle("Execute `rg -n 'a > out.txt' src`", undefined)).toBe(true);
    // ...while the UNQUOTED forms are classified as what they are.
    expect(isGrokReadOnlyShellPermissionTitle('Execute `rg -n a src; rm -rf /`', undefined)).toBe(false);
    expect(isGrokReadOnlyShellPermissionTitle('Execute `rg -n a src > out.txt`', undefined)).toBe(false);
  });

  it('a single-quoted ESCAPING path argument is still refused (quoting is not a bypass)', () => {
    expect(isGrokReadOnlyShellPermissionTitle("Execute `cat '/etc/passwd'`", undefined)).toBe(false);
    expect(isGrokReadOnlyShellPermissionTitle("Execute `cat '../outside.txt'`", undefined)).toBe(false);
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
    expect(isGrokReadOnlyShellPermissionTitle(operation, undefined)).toBe(false);
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
    expect(isGrokReadOnlyShellPermissionTitle(operation, undefined)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // MED-9 — the title wrapper is parsed STRUCTURALLY, so a literal backtick
  // inside quotes can reach the quote-aware scanners instead of being rejected
  // by a no-backtick capture that could never see the quoting.
  // -------------------------------------------------------------------------
  it('accepts a literal backtick INSIDE single quotes (the old capture made this impossible)', () => {
    const bt = String.fromCharCode(96);
    expect(isGrokReadOnlyShellPermissionTitle('Execute `ls ' + "'x" + bt + "y'" + '`', undefined)).toBe(true);
    expect(isGrokReadOnlyShellPermissionTitle('Execute `rg -n ' + "'a" + bt + "b'" + ' src`', undefined)).toBe(true);
  });

  it('still refuses an UNQUOTED backtick (command substitution) and a malformed wrapper', () => {
    const bt = String.fromCharCode(96);
    expect(isGrokReadOnlyShellPermissionTitle('Execute `ls ' + bt + 'whoami' + bt + '`', undefined)).toBe(false);
    expect(isGrokReadOnlyShellPermissionTitle('Execute `', undefined)).toBe(false); // empty interior
    expect(isGrokReadOnlyShellPermissionTitle('Execute ls`', undefined)).toBe(false); // no prefix backtick
    expect(isGrokReadOnlyShellPermissionTitle('Run `ls`', undefined)).toBe(false); // wrong verb
    expect(isGrokReadOnlyShellPermissionTitle('Execute `ls', undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// F14 — an absolute path INSIDE the assigned worktree is admissible.
//
// THE DEFECT. `hasEscapingPathArgument` refused EVERY argument starting with
// `/`, so no absolute path was ever admissible — not even the agent's OWN
// worktree, which the implementor prompt hands it BY ABSOLUTE PATH ("You may
// create, modify, or delete files ONLY inside your assigned worktree: <abs>").
// The engine named a path and then denied every command that used it. A denied
// permission ends the turn before the work is committed, so the run dies
// `no_deliverable` — that is how four dogfood runs were lost.
//
// THE RULE THAT REPLACES IT. An absolute argument is admissible IFF it resolves
// inside the worktree root — `path.relative` containment against the REALPATH of
// both sides, via the nearest EXISTING ancestor (the same construction as
// `isWorkspaceWriteOperation` in `../acp/session.ts`). Everything else is refused
// exactly as before, and anything that cannot be DECIDED is refused too: no root,
// an unresolvable root, a filesystem error. Inability to determine safety is
// never evidence of safety.
//
// WHY REALPATH AND NOT `path.resolve`. `path.resolve` collapses `..` LEXICALLY,
// before symlinks resolve, so `<root>/link/../x` can look inside while landing
// outside. `symlinkEscape` below pins exactly that: the test asserts the lexical
// answer is "inside" and the classifier still refuses.
// ---------------------------------------------------------------------------
interface WorktreeFixture {
  /** The assignment worktree root — what production passes as the mediation cwd. */
  readonly root: string;
  /** A SHARED-PREFIX sibling worktree: `root` is a string prefix of it. */
  readonly sibling: string;
  /** The directory holding the worktrees (`<repo>.worktrees/` in production). */
  readonly parent: string;
  /** A directory outside the worktree tree entirely. */
  readonly outside: string;
}

/**
 * A hermetic stand-in for a production assignment worktree, in the REAL shape:
 * the engine creates them as siblings under `<repo>.worktrees/` (verified on
 * disk for run_60ccbfda), which is precisely the layout in which a prefix-string
 * containment test is wrong.
 */
function worktreeFixture(): WorktreeFixture {
  const base = tempDir();
  const parent = path.join(base, 'harness-orchestration.worktrees');
  const root = path.join(parent, 'assignment-asg_run_60ccbfda-c514-4b71-aa90-bf7328e11e5c');
  const sibling = `${root}-2`; // `root` IS a string prefix of this path.
  const outside = path.join(base, 'outside');
  mkdirSync(path.join(root, 'web'), { recursive: true });
  mkdirSync(path.join(root, 'docs'), { recursive: true });
  mkdirSync(path.join(root, 'src', 'adapters'), { recursive: true });
  mkdirSync(sibling, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(path.join(root, 'package.json'), '{"name":"harness"}\n', 'utf8');
  writeFileSync(path.join(root, 'docs', 'HANDOFF-dogfood-F7.md'), '# handoff\n', 'utf8');
  writeFileSync(path.join(sibling, 'secret.txt'), 'sibling\n', 'utf8');
  writeFileSync(path.join(outside, 'secret.txt'), 'outside\n', 'utf8');
  // A symlink INSIDE the worktree pointing OUT of it — the escape a lexical
  // check cannot see.
  symlinkSync(outside, path.join(root, 'escape'));
  return { root, sibling, parent, outside };
}

describe('F14 — absolute paths are judged by CONTAINMENT, not by their first byte', () => {
  it('classifies grok’s EXACT denied command from run_60ccbfda as read-only', () => {
    const { root } = worktreeFixture();
    // The first exploration of the fourth killed dogfood run. Every token is
    // individually safe; the ONLY reason it was denied is that `ls -la <root>`
    // names the worktree the prompt had just handed the agent.
    const operation =
      'Execute `ls -la ' +
      root +
      ' && ls -la web 2>/dev/null; head -n 5 docs/HANDOFF-dogfood-F7.md; git rev-parse HEAD; git status --porcelain | head -20`';
    expect(isGrokReadOnlyShellPermissionTitle(operation, root)).toBe(true);
    // ...and the SAME command with no worktree root to judge against stays
    // denied: not knowing where the boundary is is not permission to cross it.
    expect(isGrokReadOnlyShellPermissionTitle(operation, undefined)).toBe(false);
  });

  it.each([
    ['the worktree root itself', (f: WorktreeFixture) => `ls -la ${f.root}`],
    ['the worktree root with a trailing slash', (f: WorktreeFixture) => `ls -la ${f.root}/`],
    ['a subdirectory of the worktree', (f: WorktreeFixture) => `ls -la ${f.root}/web`],
    ['a file inside the worktree', (f: WorktreeFixture) => `head -n 5 ${f.root}/package.json`],
    ['a SINGLE-QUOTED absolute path inside the worktree', (f: WorktreeFixture) => `cat '${f.root}/package.json'`],
    ['several absolute paths inside the worktree', (f: WorktreeFixture) => `ls -la ${f.root}/web ${f.root}/docs`],
    ['a deep path inside the worktree', (f: WorktreeFixture) => `rg -n 'foo' ${f.root}/src/adapters`],
    [
      'a not-yet-existing file whose nearest EXISTING ancestor is inside',
      (f: WorktreeFixture) => `cat ${f.root}/docs/not-created-yet.md`,
    ],
    ['a git read scoped to an absolute path inside', (f: WorktreeFixture) => `git log --oneline -5 ${f.root}/docs`],
    ['relative paths, exactly as before', () => 'ls -la . && ls -la web && head -n 5 docs/x.md'],
  ])('ADMITS %s', (_label, build) => {
    const fixture = worktreeFixture();
    expect(isGrokReadOnlyShellPermissionTitle(`Execute \`${build(fixture)}\``, fixture.root)).toBe(true);
  });

  it.each([
    ['a genuinely outside absolute path', (f: WorktreeFixture) => `ls -la /etc`],
    ['a secret outside the worktree', () => 'cat /etc/passwd'],
    ['the same path SINGLE-QUOTED (quoting is not a bypass)', () => "cat '/etc/passwd'"],
    ['/tmp', () => 'ls -la /tmp'],
    ['the PARENT of the worktree (every sibling assignment lives there)', (f: WorktreeFixture) => `ls -la ${f.parent}`],
    ['a SHARED-PREFIX sibling worktree (string prefixes are not containment)', (f: WorktreeFixture) => `cat ${f.sibling}/secret.txt`],
    ['a symlink inside the worktree pointing OUT (no `..` anywhere — containment alone catches it)', (f: WorktreeFixture) => `cat ${f.root}/escape/secret.txt`],
    ['the symlink itself', (f: WorktreeFixture) => `ls -la ${f.root}/escape`],
    ['a symlink escape that `path.resolve` collapses to a path INSIDE the root', (f: WorktreeFixture) => `cat ${f.root}/escape/../secret.txt`],
    ['`/../` inside an otherwise-contained absolute path', (f: WorktreeFixture) => `cat ${f.root}/web/../package.json`],
    ['a trailing `/..` on an absolute path', (f: WorktreeFixture) => `ls -la ${f.root}/..`],
    ['an absolute path that does not exist at all', () => 'cat /no-such-root/no-such-file'],
    ['ONE outside argument among admissible ones', (f: WorktreeFixture) => `ls -la ${f.root} /etc`],
    ['a `=/` option value, even one pointing INSIDE the worktree', (f: WorktreeFixture) => `rg -n foo --file=${f.root}/pat.txt`],
    ['a bare `..`', () => 'cat ..'],
    ['a leading `../`', () => 'cat ../outside.txt'],
    ['an interior `/../`', () => 'cat web/../../etc/passwd'],
    ['a `~/` home path', () => 'cat ~/.ssh/id_ed25519'],
  ])('REFUSES %s', (_label, build) => {
    const fixture = worktreeFixture();
    expect(isGrokReadOnlyShellPermissionTitle(`Execute \`${build(fixture)}\``, fixture.root)).toBe(false);
  });

  it('the symlink escape is one `path.resolve` — and `realpathSync` — would have called contained', () => {
    const { root, outside } = worktreeFixture();
    // Built as a STRING: `path.join` would collapse the `..` before we could
    // show the collapse is the bug.
    const lexicalEscape = `${root}/escape/../secret.txt`;

    // (1) What a `path.resolve`-only check sees: a path inside the root.
    expect(path.resolve(lexicalEscape).startsWith(`${root}${path.sep}`)).toBe(true);

    // (2) What the filesystem really has: `escape` points OUT of the worktree,
    // so the `..` after it leaves from THERE — the shell opens
    // `<parent-of-outside>/secret.txt`, not `<root>/secret.txt`.
    expect(realpathSync(path.join(root, 'escape'))).toBe(realpathSync(outside));

    // (3) And the trap that makes "just call realpathSync" wrong: Node's
    // `realpathSync` is not POSIX `realpath(3)` — it `path.resolve`s FIRST, so
    // it collapses the `..` lexically and reports the escape as the root itself.
    // This is why a `..` segment is REFUSED rather than resolved. If a future
    // Node makes this assertion fail, the refusal is still correct — but the
    // reasoning in `lib/path-containment.ts` needs re-reading.
    expect(realpathSync(`${root}/escape/..`)).toBe(realpathSync(root));

    expect(isGrokReadOnlyShellPermissionTitle(`Execute \`cat ${lexicalEscape}\``, root)).toBe(false);
  });

  it.each([
    ['no worktree root at all', undefined],
    ['an empty root', ''],
    ['a relative root', 'relative/not/absolute'],
    ['a root that does not exist', '/no-such-worktree-root-f14'],
  ])('FAILS CLOSED when containment cannot be decided: %s', (_label, root) => {
    const { root: real } = worktreeFixture();
    // The argument is inside the REAL worktree; the root we are judging against
    // is unusable. Undecidable is refused, never approved.
    expect(isGrokReadOnlyShellPermissionTitle(`Execute \`ls -la ${real}\``, root)).toBe(false);
    // ...while relative inspection still works with an unusable root, so a
    // misconfigured root degrades to today's behaviour rather than to nothing.
    expect(isGrokReadOnlyShellPermissionTitle('Execute `ls -la .`', root)).toBe(true);
  });

  it('supplying a root does not widen anything else the classifier refuses', () => {
    const { root } = worktreeFixture();
    for (const operation of [
      `Execute \`ls -la ${root} && rm -rf ${root}\``,
      `Execute \`cat ${root}/package.json > ${root}/owned.txt\``,
      `Execute \`mkdir -p ${root}/src/app\``,
      `Execute \`npm run typecheck\``,
      `Execute \`git log --output=${root}/history.txt\``,
      `Execute \`rg --pre ./steal needle ${root}\``,
      `Execute \`cat $(echo ${root}/package.json)\``,
      `Execute \`curl https://example.invalid/${path.basename(root)}\``,
    ]) {
      expect(isGrokReadOnlyShellPermissionTitle(operation, root)).toBe(false);
    }
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

  it('ROUND 6: an unparseable title with NO payload is still refused (parse failure is not safety evidence)', () => {
    // The exact reported shape: an exactly-allowlisted but MALFORMED shell title
    // with no rawInput used to return true, because "non-shell" was concluded
    // from two failed parses. Non-shell is now recognised POSITIVELY.
    expect(grokShellPayloadMatchesTitle('Execute ls', undefined)).toBe(false);
    expect(grokShellPayloadMatchesTitle('Execute ls', {})).toBe(false);
    expect(grokShellPayloadMatchesTitle('npm run typecheck', undefined)).toBe(false);
    expect(grokShellPayloadMatchesTitle('Execute `ls`', { command: { nested: 1 } })).toBe(false);
    expect(grokShellPayloadMatchesTitle('Execute `ls`', 'not an object')).toBe(false);
  });

  it('ROUND 7: a MALFORMED command is not an ABSENT one — it is unknown, and refused', () => {
    // Collapsing malformed into absent made `{command: 42}` read as 'no command
    // here', so a Write title carrying it was waved through as structured_file.
    expect(grokShellPayloadMatchesTitle('Write `/repo/a.ts`', { command: 42 })).toBe(false);
    expect(grokShellPayloadMatchesTitle('Write `/repo/a.ts`', { command: { nested: 1 } })).toBe(false);
    expect(grokShellPayloadMatchesTitle('Write `/repo/a.ts`', ['array'])).toBe(false);
    expect(grokShellPayloadMatchesTitle('Write `/repo/a.ts`', 'a string payload')).toBe(false);
  });

  it('ROUND 7: the PATH the title asserts is bound too (the containment check is not decorative)', () => {
    // `isWorkspaceWriteOperation` checks the TITLE's path, so a payload writing
    // somewhere else entirely passed both it and the veto.
    expect(
      grokShellPayloadMatchesTitle('Write `/repo/wt/a.ts`', { path: '/etc/passwd' }),
    ).toBe(false);
    expect(
      grokShellPayloadMatchesTitle('Edit `/repo/wt/a.ts`', { path: '/repo/wt/../../outside.ts' }),
    ).toBe(false);
    expect(grokShellPayloadMatchesTitle('Write `/repo/wt/a.ts`', { path: 42 })).toBe(false);
    // A payload agreeing with the title is fine, as is one asserting no path.
    expect(grokShellPayloadMatchesTitle('Write `/repo/wt/a.ts`', { path: '/repo/wt/a.ts' })).toBe(true);
    expect(grokShellPayloadMatchesTitle('Write `/repo/wt/a.ts`', undefined)).toBe(true);
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
