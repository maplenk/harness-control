/**
 * The §3.1 permanent-deny classifier — BOTH directions, for every rule.
 *
 * House rule 5: "a guard needs a test that proves it FIRES". Under an ALLOWLIST
 * a refusal test proves nothing — everything is refused by construction. Under
 * the §2.4 inverted default it proves everything, so every rule below is pinned
 * twice:
 *
 *   - the destructive form is `denied`, with the RULE id, and
 *   - the nearest harmless form of the SAME command is `admissible`.
 *
 * The second assertion is what makes the first meaningful: delete the rule and
 * the denial becomes an admission, so the pair fails. A test that only asserted
 * the refusal would still pass against a blanket deny.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyImplementorOperation,
  classifyShellCommand,
  denyByDefaultPosture,
  permanentDenyGatesExactAllowlist,
  permissiveImplementorPosture,
  type ImplementorAdmissionPosture,
  type PermanentDenyRuleId,
  type PermanentDenyVerdict,
} from './permanent-deny.js';

let root: string;
let outside: string;
let posture: ImplementorAdmissionPosture;

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'permanent-deny-root-'));
  outside = mkdtempSync(path.join(tmpdir(), 'permanent-deny-outside-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, '.git', 'hooks'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'left-pad'), { recursive: true });
  mkdirSync(path.join(root, '.ssh'), { recursive: true });
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'existing.txt'), 'already here\n');
  writeFileSync(path.join(root, '.env'), 'API_BASE=http://localhost\n');
  writeFileSync(path.join(root, '.gitignore'), 'dist\n');
  writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(root, 'node_modules', 'left-pad', 'package.json'), '{}\n');
  writeFileSync(path.join(outside, 'secret.txt'), 'not yours\n');
  symlinkSync(outside, path.join(root, 'escape-link'));
  posture = permissiveImplementorPosture(root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

/** Classify a bare shell command under the permissive posture. */
function shell(command: string): PermanentDenyVerdict {
  return classifyShellCommand(command, root);
}

function expectDenied(command: string, rule: PermanentDenyRuleId): void {
  const verdict = shell(command);
  expect(verdict.kind, `${command} should be DENIED, got ${verdict.kind}`).toBe('denied');
  if (verdict.kind === 'denied') expect(verdict.rule, `${command} denied by the wrong rule`).toBe(rule);
}

function expectAdmissible(command: string): void {
  const verdict = shell(command);
  expect(verdict.kind, `${command} should be ADMISSIBLE, got ${verdict.kind}`).toBe('admissible');
}

function expectUnprovable(command: string): void {
  const verdict = shell(command);
  expect(verdict.kind, `${command} should be UNPROVABLE, got ${verdict.kind}`).toBe('unprovable');
}

// ---------------------------------------------------------------------------
// §2.4, rule by rule
// ---------------------------------------------------------------------------
describe('§2.4 permanent-deny list — every rule fires, and its safe form still passes', () => {
  it('destructive_delete: -r/-f, multi-path and directory deletion — single-path rm still passes', () => {
    expectDenied('rm -rf src', 'destructive_delete');
    expectDenied('rm -r src', 'destructive_delete');
    expectDenied('rm -f src/a.ts', 'destructive_delete');
    expectDenied('rm -R src', 'destructive_delete');
    expectDenied('rm --recursive src', 'destructive_delete');
    expectDenied('rm --force src/a.ts', 'destructive_delete');
    expectDenied('rm -d src', 'destructive_delete');
    expectDenied('rm src/a.ts src/b.ts', 'destructive_delete');
    expectDenied('rmdir src', 'destructive_delete');
    expectDenied('find . -delete', 'destructive_delete');
    // THE OTHER DIRECTION — §2.4's safe set is single-path rm inside the worktree.
    expectAdmissible('rm src/a.ts');
    expectAdmissible('rm -v src/a.ts');
    expectAdmissible('rm -- -weird-name');
    expectAdmissible('find . -name "*.ts"');
  });

  it('protected_path: MUTATION of .git/ or node_modules/ — READING them still passes', () => {
    expectDenied('rm .git/HEAD', 'protected_path');
    expectDenied('mv src/a.ts node_modules/a.ts', 'protected_path');
    expectDenied('touch .git/hooks/pre-commit', 'protected_path');
    expectDenied('chmod +x .git/hooks/pre-commit', 'protected_path');
    expectDenied('cp src/a.ts node_modules/left-pad/index.js', 'protected_path');
    // THE OTHER DIRECTION, and the most important pair in this file: the status
    // quo ADMITS these reads through the read-only classifier, and house rule 3
    // says this change only widens. Applying the protected-path rule to reads
    // would have refused them.
    expectAdmissible('cat .git/HEAD');
    expectAdmissible('ls node_modules');
    expectAdmissible('cat node_modules/left-pad/package.json');
    expectAdmissible('grep -r foo node_modules');
    // `.gitignore` is not `.git` — the rule matches path SEGMENTS.
    expectAdmissible('rm .gitignore');
  });

  it('outside_worktree: absolute escapes, .. and ~ — in-worktree paths still pass', () => {
    expectDenied(`cat ${path.join(outside, 'secret.txt')}`, 'outside_worktree');
    expectDenied('cat ../secret.txt', 'outside_worktree');
    expectDenied('cat ~/.bashrc', 'outside_worktree');
    expectDenied('cat /etc/passwd', 'outside_worktree');
    // An ABSOLUTE path through a symlink that leaves the root is refused by
    // realpath containment, trailing slash and all.
    expectDenied(`ls ${path.join(root, 'escape-link')}/`, 'outside_worktree');
    // THE OTHER DIRECTION — F14: the prompt hands the agent its worktree BY
    // ABSOLUTE PATH, so absolute in-worktree paths must stay admissible.
    expectAdmissible(`cat ${path.join(root, 'src', 'a.ts')}`);
    expectAdmissible(`ls -la ${root}`);
    expectAdmissible('cat src/a.ts');
  });

  it('RESIDUAL, stated on purpose: a RELATIVE path through an escaping symlink is not caught here', () => {
    // `ls escape-link/` resolves outside the worktree and this classifier admits
    // it. That is deliberate, not an oversight:
    //
    //  - the STATUS QUO admits it too (`ls` is on the read-only classifier's
    //    safe list and relative arguments were never containment-checked), and
    //    house rule 3 says this change only widens;
    //  - spec §3.1 says worktree escape is already structurally prevented by the
    //    provider process sandbox plus `workspaceWriteRoot`, and that "the
    //    classifier is defense in depth, not the primary control";
    //  - resolving EVERY relative argument against the root would refuse a
    //    `node_modules` provisioned through a symlink, and a false denial ends
    //    the implementor turn — the exact failure this whole change undoes.
    //
    // Pinned as a test so the residual is visible and a future change to it is a
    // decision rather than an accident.
    expectAdmissible('ls escape-link/');
  });

  it('git_mutation: history/remote/config/hooks — proven git READS still pass', () => {
    expectDenied('git push origin main', 'git_mutation');
    expectDenied('git push --force', 'git_mutation');
    expectDenied('git reset --hard HEAD~1', 'git_mutation');
    expectDenied('git clean -fdx', 'git_mutation');
    expectDenied('git config core.hooksPath hooks', 'git_mutation');
    expectDenied('git config --get user.email', 'git_mutation');
    expectDenied('git commit -m wip', 'git_mutation');
    expectDenied('git checkout main', 'git_mutation');
    expectDenied('git rebase main', 'git_mutation');
    expectDenied('git fetch origin', 'git_mutation');
    // …and the config/hook INJECTION flags, whatever the subcommand.
    expectDenied('git -c core.pager=cat log', 'git_mutation');
    expectDenied('git --git-dir=/tmp/x log', 'git_mutation');
    expectDenied('git --exec-path=/tmp status', 'git_mutation');
    // THE OTHER DIRECTION — the four reads that cost run_c4648778 its turns.
    expectAdmissible('git status');
    expectAdmissible('git log --oneline -5');
    expectAdmissible('git ls-tree HEAD');
    expectAdmissible("git tag -l 'dogfood/*'");
    expectAdmissible('git branch --list');
    expectAdmissible('git rev-parse HEAD');
    // A git form that is neither a proven read nor a known mutation is
    // UNPROVABLE, never permanently denied — refusing every unrecognised git
    // form forever would repeat the mistake this inversion undoes.
    expectUnprovable('git help log');
    expectUnprovable('git version');
    // CONSERVATIVE RESIDUAL, pinned so it is visible: the mixed-mode families
    // (`stash`/`worktree`/`remote`/`notes`/`bisect`) are judged at the
    // SUBCOMMAND level, so their genuine `list`/`show` read forms are refused
    // along with their mutating ones. Denied today too, so nothing regresses —
    // but they are permanently ungrantable rather than operator-reviewable.
    expectDenied('git stash list', 'git_mutation');
  });

  it('privilege_escalation: sudo and friends — the same command unescalated passes', () => {
    expectDenied('sudo ls', 'privilege_escalation');
    expectDenied('su root', 'privilege_escalation');
    expectDenied('doas ls', 'privilege_escalation');
    expectDenied('pkexec ls', 'privilege_escalation');
    // BASENAME, so an absolute path cannot walk past the table.
    expectDenied('/usr/bin/sudo ls', 'privilege_escalation');
    expectAdmissible('ls');
  });

  it('credential_access: keychain, SSH keys, the environment block — ordinary dotfiles pass', () => {
    expectDenied('security find-generic-password -s npm', 'credential_access');
    expectDenied('ssh-add -l', 'credential_access');
    expectDenied('gpg --list-keys', 'credential_access');
    expectDenied('printenv', 'credential_access');
    expectDenied('cat .ssh/id_rsa', 'credential_access');
    expectDenied('cat .npmrc', 'credential_access');
    // THE OTHER DIRECTION — a repo-local `.env` is an ordinary source-tree file
    // implementors legitimately read; refusing it would be a false denial.
    expectAdmissible('cat .env');
    expectAdmissible('cat .gitignore');
  });

  it('network_egress: uploads, remote shells, publishing, deployment — local reads pass', () => {
    expectDenied('curl https://example.com', 'network_egress');
    expectDenied('wget https://example.com', 'network_egress');
    expectDenied('ssh host uptime', 'network_egress');
    expectDenied('scp src/a.ts host:/tmp', 'network_egress');
    expectDenied('rsync -a src/ host:/tmp', 'network_egress');
    expectDenied('gh pr create', 'network_egress');
    expectDenied('docker push image', 'network_egress');
    expectDenied('kubectl apply -f x.yaml', 'network_egress');
    expectDenied('aws s3 cp src/a.ts s3://bucket', 'network_egress');
    expectAdmissible('cat src/a.ts');
  });

  it('opaque_evaluator: -c/-e interpreters, substitutions, heredocs — plain argv passes', () => {
    expectDenied('bash -c "ls"', 'opaque_evaluator');
    expectDenied('sh -c ls', 'opaque_evaluator');
    expectDenied('zsh -c ls', 'opaque_evaluator');
    expectDenied('eval ls', 'opaque_evaluator');
    expectDenied('python -c "import os"', 'opaque_evaluator');
    expectDenied('python3 -c pass', 'opaque_evaluator');
    expectDenied('node -e "process.exit(0)"', 'opaque_evaluator');
    expectDenied('perl -e print', 'opaque_evaluator');
    expectDenied('ruby -e puts', 'opaque_evaluator');
    expectDenied('awk "{print}" src/a.ts', 'opaque_evaluator');
    expectDenied('sed -i s/a/b/ src/a.ts', 'opaque_evaluator');
    expectDenied('xargs rm', 'opaque_evaluator');
    expectDenied('env', 'opaque_evaluator');
    expectDenied('find src -exec ls', 'opaque_evaluator');
    expectDenied('find src -execdir ls', 'opaque_evaluator');
    // Substitutions and heredocs are POSITIVELY identified — not merely
    // "unparseable" — so they are permanently denied rather than routed to a
    // future operator review.
    expectDenied('echo `whoami`', 'opaque_evaluator');
    expectDenied('echo $(whoami)', 'opaque_evaluator');
    expectDenied('echo ${HOME}', 'opaque_evaluator');
    expectDenied('echo "$HOME"', 'opaque_evaluator');
    expectDenied('cat <<EOF', 'opaque_evaluator');
    // THE OTHER DIRECTION — a `$` inside a SINGLE-quoted span is an ordinary
    // byte, exactly as the shell reads it, so an anchored regex still passes.
    expectAdmissible("rg -n 'cost: 5' src");
    expectAdmissible('echo hello');
  });

  it('opaque_evaluator: a program inside the agent OWN WORKTREE — system tools off PATH still pass', () => {
    // The hole an inverted default opens that an allowlist never had. The agent
    // can `Write` a script into its worktree and `chmod +x` it, both admissible;
    // if running it were admissible too, the entire §2.4 list would be one file
    // away from being bypassed.
    expectDenied('./build.sh', 'opaque_evaluator');
    expectDenied('src/tool', 'opaque_evaluator');
    expectDenied(`${path.join(root, 'src', 'tool')} --flag`, 'opaque_evaluator');
    expectDenied('node_modules/.bin/whatever', 'opaque_evaluator');
    expectDenied('../evil', 'outside_worktree');
    // THE OTHER DIRECTION — a bare command word is a system tool resolved off
    // PATH, and an absolute path OUTSIDE the worktree is one too. Both stay
    // admissible; only the table above judges them, by basename.
    expectAdmissible('jq . package.json');
    expectAdmissible('/usr/bin/jq . package.json');
    expectAdmissible('/bin/ls -la src');
    expectDenied('/usr/bin/sudo ls', 'privilege_escalation');
  });

  it('package_or_build_execution: host-owned build/test/package commands — inspection passes', () => {
    expectDenied('npm test', 'package_or_build_execution');
    expectDenied('npm run typecheck', 'package_or_build_execution');
    expectDenied('npx tsc --noEmit', 'package_or_build_execution');
    expectDenied('pnpm install', 'package_or_build_execution');
    expectDenied('yarn build', 'package_or_build_execution');
    expectDenied('pip install requests', 'package_or_build_execution');
    expectDenied('cargo build', 'package_or_build_execution');
    expectDenied('make all', 'package_or_build_execution');
    expectDenied('vitest run', 'package_or_build_execution');
    expectDenied('pytest -q', 'package_or_build_execution');
    expectDenied('brew install jq', 'package_or_build_execution');
    // THE OTHER DIRECTION — reading the manifest that describes those commands
    // is not running them.
    expectAdmissible('cat package.json');
  });

  it('clobbering_destination: §2.4 no-clobber on cp/mv — a fresh destination passes', () => {
    expectDenied('mv src/a.ts existing.txt', 'clobbering_destination');
    expectDenied('cp src/a.ts existing.txt', 'clobbering_destination');
    expectDenied(`mv src/a.ts ${path.join(root, 'existing.txt')}`, 'clobbering_destination');
    // A dangling symlink is a real ENTRY: `mv` onto it writes through the link.
    expectAdmissible('mv src/a.ts src/b.ts');
    expectAdmissible('cp src/a.ts src/copy.ts');
    expectAdmissible('mkdir -p src/nested');
    expectAdmissible('touch src/new.ts');
    // Multi-source cp/mv is outside the §2.4 grammar — unknown, not denied.
    expectUnprovable('cp src/a.ts src/b.ts src/c.ts');
  });
});

// ---------------------------------------------------------------------------
// House rule 2 — "I could not determine X" is never "X is false"
// ---------------------------------------------------------------------------
describe('unparseable payloads never reach the permissive default', () => {
  it('a command the tokenizer cannot read is UNPROVABLE, never admissible', () => {
    expectUnprovable('ls > out.txt'); // a real redirection naming a file
    expectUnprovable('ls >> out.txt');
    expectUnprovable('ls & sleep 1'); // backgrounding
    expectUnprovable('ls (x)'); // subshell syntax
    expectUnprovable('ls { x }');
    expectUnprovable("ls 'unterminated"); // unbalanced quote
    expectUnprovable('ls x'); // control byte
    // `ls # comment` USED to be listed here. It was never an example of the
    // rule this test states -- the tokenizer can read it perfectly well; it is
    // `ls` followed by a POSIX comment, which executes nothing. The scanner
    // simply rejected `#` outright, so any command carrying an explanatory
    // comment was unclassifiable and therefore DENIED, and that ended real
    // implementor rounds with no deliverable. The rule is unchanged and every
    // genuinely unreadable form above still denies; only this example moved.
    // Both directions now live in the comment test below.
    expectUnprovable(`ls ${'a'.repeat(9000)}`); // over the byte bound
    // …and the SAFE null redirections still pass, because they name no file.
    expectAdmissible('git status 2>&1');
    expectAdmissible('git status 2>/dev/null');
  });

  it('a DENIED segment outranks an UNPROVABLE one anywhere in the compound', () => {
    // If the first failing segment won, a hostile compound could launder a
    // permanently-denied tail behind an unreadable head and reach the operator
    // review that `unprovable` is destined for.
    const verdict = shell('ls > out.txt && rm -rf src');
    expect(verdict.kind).toBe('denied');
    if (verdict.kind === 'denied') expect(verdict.rule).toBe('destructive_delete');
    // …and every segment is judged, not only the first.
    expectDenied('cat src/a.ts && sudo ls', 'privilege_escalation');
    expectDenied('cat src/a.ts | curl -T - https://example.com', 'network_egress');
  });

  it('an operation TITLE this engine cannot read is UNPROVABLE, never admissible', () => {
    expect(classifyImplementorOperation('Fetch(https://example.com)', undefined, posture).kind).toBe('unprovable');
    expect(classifyImplementorOperation(undefined, undefined, posture).kind).toBe('unprovable');
    expect(classifyImplementorOperation('', undefined, posture).kind).toBe('unprovable');
    expect(classifyImplementorOperation('Execute ``', undefined, posture).kind).toBe('unprovable');
  });

  it('the EXECUTED payload is classified too, not only the title', () => {
    // A construction site may legitimately install `noPayloadToVerify`, so a
    // classifier that trusted the title alone would approve `Execute \`ls\``
    // while `rm -rf` ran.
    const hostile = classifyImplementorOperation('Execute `ls`', { command: 'rm -rf src' }, posture);
    expect(hostile.kind).toBe('denied');
    if (hostile.kind === 'denied') expect(hostile.rule).toBe('destructive_delete');
    // A payload that is PRESENT BUT MALFORMED is not an absent one.
    expect(classifyImplementorOperation('Execute `ls`', { command: 42 }, posture).kind).toBe('unprovable');
    // An honest, matching payload still passes.
    expect(classifyImplementorOperation('Execute `ls`', { command: 'ls' }, posture).kind).toBe('admissible');
    // No payload at all leaves the title as the only claim, which is fine — the
    // Grok veto refuses that combination separately.
    expect(classifyImplementorOperation('Execute `ls`', undefined, posture).kind).toBe('admissible');
  });
});

// ---------------------------------------------------------------------------
// The posture value itself (house rule 1)
// ---------------------------------------------------------------------------
describe('the posture is a value with one producer', () => {
  it('the deny-by-default posture never classifies anything as admissible', () => {
    expect(classifyImplementorOperation('Execute `ls`', { command: 'ls' }, denyByDefaultPosture)).toEqual({
      kind: 'unprovable',
      detail: 'the session is not running the permissive implementor posture',
    });
  });

  it('a permissive posture cannot be built on a root that cannot answer containment', () => {
    expect(() => permissiveImplementorPosture('relative/path')).toThrow(/absolute/);
    expect(() => permissiveImplementorPosture('/a/../b')).toThrow(/\.\./);
    expect(permissiveImplementorPosture('/a/b')).toEqual({ kind: 'permissive', worktreeRoot: '/a/b' });
  });

  it('a structured file target is never ADMITTED here — only the write boundary may admit', () => {
    // Returning `admissible` for a structured write silently widened every
    // implementor back to the whole execution root, past a narrower B4 declared
    // scope. The refusals are this module's; the admission is not.
    expect(classifyImplementorOperation(`Write \`${path.join(root, 'src', 'a.ts')}\``, undefined, posture).kind).toBe(
      'unprovable',
    );
    const hooks = classifyImplementorOperation(
      `Write \`${path.join(root, '.git', 'hooks', 'pre-commit')}\``,
      undefined,
      posture,
    );
    expect(hooks.kind).toBe('denied');
    if (hooks.kind === 'denied') expect(hooks.rule).toBe('protected_path');
    const escaped = classifyImplementorOperation(`Edit \`${path.join(outside, 'secret.txt')}\``, undefined, posture);
    expect(escaped.kind).toBe('denied');
    if (escaped.kind === 'denied') expect(escaped.rule).toBe('outside_worktree');
  });

  it('states in code that the EXACT-operation allowlist is not gated', () => {
    // Host DECLARATIONS, not agent-chosen operations. The verifier's
    // per-criterion commands travel that path, and spec §5 removes the
    // implementor's list separately. Pinned so the next reader sees a decision.
    expect(permanentDenyGatesExactAllowlist).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// POSIX comments — readable, not unparseable.
//
// A `#` that STARTS A WORD outside quotes begins a comment: everything after it
// executes nothing. The scanner used to reject `#` outright, which made a
// command like `# check state` or `ls -la  # look around` unclassifiable and
// therefore denied. Agents write comments constantly, and this cost implementor
// rounds on run_6c3ff460 before it was traced.
//
// The word-start condition mirrors the shell exactly: in `ls a#b` the `#` is an
// ordinary filename byte. And a trailing comment must never LAUNDER whatever
// precedes it — the segment before the `#` is still classified.
// ---------------------------------------------------------------------------
describe('POSIX comments are read, not refused', () => {
  it('admits a command carrying an explanatory comment', () => {
    expectAdmissible('ls -la   # look around');
    expectAdmissible('git status --short && git log -3 --oneline  # check state');
  });

  it('admits a comment-only command, which executes nothing at all', () => {
    expectAdmissible('# read-only inspection of worktree git state');
  });

  it('treats a `#` that does NOT start a word as an ordinary byte', () => {
    expectAdmissible('ls a#b');
    expectAdmissible("echo 'a#b'");
  });

  it('REFUSES what precedes the comment — a trailing comment launders nothing', () => {
    expectDenied('rm -rf src   # cleanup', 'destructive_delete');
    expectDenied('sudo rm x # oops', 'privilege_escalation');
    expectDenied("bash -c 'x' # hi", 'opaque_evaluator');
    // Still unreadable, so still refused — via `unprovable`, as it was before.
    expectUnprovable('ls > out.txt # write');
  });
});
