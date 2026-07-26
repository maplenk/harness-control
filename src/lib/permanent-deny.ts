/**
 * THE permanent-deny classifier (spec §3.1) — **one** module, consumed by every
 * provider's rules and by the host-executability check.
 *
 * ## Why this module exists
 *
 * The approved implementor posture (spec §2.4) is:
 *
 *     allow by default; ask only for the unprovable; deny the destructive.
 *
 * The engine did the opposite. `decidePermission` was an ALLOWLIST with a
 * default deny: an operation was permitted only if it matched a declared
 * verification command exactly, passed the read-only classifier, or was a
 * workspace write. Every other operation — including every harmless exploratory
 * read — was denied, and a denied permission ends the implementor turn, closes
 * the round `no_deliverable`, and needs a manual resume.
 *
 * That is not a theoretical cost. Dogfood run `run_c4648778` lost FOUR
 * implementor turns in a row this way — on `git tag -l`, then `2>&1`, then
 * `git ls-tree` — and each one was separately patched into the read-only
 * classifier afterwards. Patching the classifier per denial is treating the
 * secondary guard as the primary control, which §3.1 says it is not: *"the
 * classifier is defense in depth, not the primary control."*
 *
 * So the gate is inverted, and THIS list is the real gate.
 *
 * ## The three verdicts, and why there are three
 *
 * `denied` / `admissible` / `unprovable`. The third is the whole point of house
 * rule 2 — *"I could not determine X" is never "X is false"*:
 *
 *  - `denied` is a POSITIVE identification of something on the §2.4
 *    never-allowed list. It is never grantable, in any tier, by any operator.
 *  - `admissible` is a POSITIVE reading of an operation that is not on that
 *    list. Under the permissive posture it is allowed with no operator.
 *  - `unprovable` is "I could not read this". It is NOT safe, so it must never
 *    fall through into the permissive default — it denies today, and it is the
 *    set spec §2.4 routes to operator review (`permission_wait`) later.
 *
 * Collapsing `unprovable` into `admissible` would turn this whole fix into a
 * hole; collapsing it into `denied` would make every unreadable command
 * permanently ungrantable and re-create the problem in a new place.
 *
 * ## Scope: what this gates, and what it deliberately does not
 *
 * It gates the AGENT-DISCRETIONARY admissions — the new permissive default, the
 * read-only classifier and the workspace-write rule (`decidePermission`). It
 * does NOT gate the exact-operation allowlist, because those strings are HOST
 * declarations (the run's declared verification commands, which the verifier
 * legitimately runs and which spec §5 removes from the implementor separately
 * by setting `allowedShellCommands = []`). Gating them here would newly refuse
 * what the status quo accepts — house rule 3 — and would break the verifier.
 * `permanentDenyGatesExactAllowlist` states that decision in code so the next
 * reader sees a decision rather than an oversight.
 *
 * ## Containment is defense in depth here, not the primary control
 *
 * Per §3.1, worktree escape is already structurally prevented by the provider
 * process sandbox plus the workspace write boundary. This module re-checks
 * ABSOLUTE path arguments (the F14 rule, moved here verbatim) and refuses `..`
 * and `~/` forms, but it deliberately does NOT resolve every RELATIVE argument
 * against the root: doing so would newly refuse reads that work today (a
 * `node_modules` provisioned through a symlink, for one) to close a hole the
 * sandbox already closes.
 */
import { lstatSync } from 'node:fs';
import * as path from 'node:path';
import {
  detectOpaqueEvaluatorSyntax,
  parseOperationTitle,
  parseShellCommandSegments,
} from './operation-parse.js';
import { resolvesInsideRoot } from './path-containment.js';

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------
/**
 * The §2.4 never-allowed categories, one id per category so every entry can be
 * pinned by a test that proves it FIRES (house rule 5).
 */
export type PermanentDenyRuleId =
  /** `rm -r`/`-f`, multi-path deletion, directory deletion. */
  | 'destructive_delete'
  /** A MUTATION whose target touches `.git/` or `node_modules/`. */
  | 'protected_path'
  /** A path argument that does not resolve inside the assigned worktree. */
  | 'outside_worktree'
  /** git history/remote/config/hook mutation — host-owned, never grantable. */
  | 'git_mutation'
  /** sudo/su/doas and friends. */
  | 'privilege_escalation'
  /** keychain, ssh keys, credential stores, the environment block. */
  | 'credential_access'
  /** uploads, remote shells, publishing, deployment. */
  | 'network_egress'
  /** `bash -c`, `eval`, `python -c`, `node -e`, substitutions, heredocs. */
  | 'opaque_evaluator'
  /** package managers and build/test execution — host-owned. */
  | 'package_or_build_execution'
  /** §2.4 no-clobber: `cp`/`mv` onto an existing destination. */
  | 'clobbering_destination';

export type PermanentDenyVerdict =
  | {
      readonly kind: 'denied';
      readonly rule: PermanentDenyRuleId;
      /** Operator-facing, already free of payload bytes we did not parse. */
      readonly detail: string;
    }
  | { readonly kind: 'admissible' }
  | { readonly kind: 'unprovable'; readonly detail: string };

const ADMISSIBLE: PermanentDenyVerdict = { kind: 'admissible' };

function denied(rule: PermanentDenyRuleId, detail: string): PermanentDenyVerdict {
  return { kind: 'denied', rule, detail };
}

function unprovable(detail: string): PermanentDenyVerdict {
  return { kind: 'unprovable', detail };
}

/**
 * A `denied` anywhere beats an `unprovable` anywhere.
 *
 * Order matters and is not cosmetic: `cat <unreadable> && rm -rf .` must be
 * DENIED, not "unprovable". If the first failing segment won, a hostile
 * compound could launder a permanently-denied tail behind an unreadable head
 * and reach the operator-review path that `unprovable` is destined for.
 */
function worst(verdicts: readonly PermanentDenyVerdict[]): PermanentDenyVerdict {
  const hardDeny = verdicts.find((verdict) => verdict.kind === 'denied');
  if (hardDeny !== undefined) return hardDeny;
  const unknown = verdicts.find((verdict) => verdict.kind === 'unprovable');
  return unknown ?? ADMISSIBLE;
}

// ---------------------------------------------------------------------------
// The posture value (house rule 1: the state is guarded, not the routes)
// ---------------------------------------------------------------------------
/**
 * Which admission posture an implementor session runs under.
 *
 * This is a VALUE, not a boolean, and `permissiveImplementorPosture` is its only
 * producer, for the reason `WriteBoundary` is a value: a permissive posture
 * cannot exist without a validated containment root, so there is no state in
 * which the permissive default is on and the worktree rule has nothing to judge
 * against. The classifier itself is NOT injectable — `decidePermission` imports
 * it directly from this module — so there is no seam at which a construction
 * site could enable the permissive default while omitting the deny list. That
 * combination is the failure this file exists to make unconstructible.
 */
export type ImplementorAdmissionPosture =
  | { readonly kind: 'deny_by_default' }
  | { readonly kind: 'permissive'; readonly worktreeRoot: string };

/**
 * The pre-§2.4 posture: nothing is admitted except by an explicit allow path.
 * Named, not defaulted, because `HeadlessPermissionPolicy.implementorPosture` is
 * REQUIRED — a construction site must SAY which posture it wants, so a new
 * provider adapter cannot silently inherit the deny-by-default that cost four
 * implementor turns, and cannot silently inherit permissive either.
 */
export const denyByDefaultPosture: ImplementorAdmissionPosture = { kind: 'deny_by_default' };

/**
 * The §2.4 default posture, bound to the agent's assigned worktree.
 *
 * Throws on a root that cannot answer a containment question (relative, or
 * carrying a `..` segment `path-containment` refuses to resolve). Failing here
 * is loud; accepting it would leave a posture whose `outside_worktree` rule can
 * never say yes — fail-closed, but silently and confusingly so.
 */
export function permissiveImplementorPosture(worktreeRoot: string): ImplementorAdmissionPosture {
  if (!path.isAbsolute(worktreeRoot) || worktreeRoot.split('/').includes('..')) {
    throw new Error(
      `permissive implementor posture requires an absolute worktree root with no ".." segment, received ${JSON.stringify(worktreeRoot)}`,
    );
  }
  return { kind: 'permissive', worktreeRoot };
}

/**
 * Whether the permanent-deny list gates the EXACT-operation allowlist.
 *
 * `false`, deliberately — see the module header. Exported as a named constant so
 * the decision is greppable, testable and impossible to mistake for an omission.
 */
export const permanentDenyGatesExactAllowlist = false;

// ---------------------------------------------------------------------------
// §2.4 — the permanently-denied command table
// ---------------------------------------------------------------------------
/**
 * Commands that are NEVER admissible, whatever their arguments.
 *
 * Reproduced from spec §2.4 + §3.1, category by category. Membership rule: the
 * command's PURPOSE is on the never-allowed list, so no argument shape makes it
 * safe. A command whose read and write forms differ only by argument shape does
 * NOT belong here — it belongs in a shape-aware rule below (`git`, `rm`, `find`,
 * `cp`/`mv`), because guessing read-from-write by inspecting positionals is the
 * inference that turns a write into an "apparently safe" read.
 */
const DENIED_COMMANDS: ReadonlyMap<string, PermanentDenyRuleId> = new Map<string, PermanentDenyRuleId>([
  // --- privilege escalation -------------------------------------------------
  ...(['sudo', 'su', 'doas', 'pkexec', 'chroot', 'visudo', 'launchctl', 'systemctl', 'dscl', 'dseditgroup', 'csrutil', 'spctl'] as const).map(
    (name) => [name, 'privilege_escalation' as const] as const,
  ),
  // --- credential / keychain / SSH access -----------------------------------
  // `printenv` dumps the environment block, which is where every provider token
  // this engine isolates actually lives.
  ...(['security', 'keychain', 'ssh-add', 'ssh-agent', 'ssh-keygen', 'gpg', 'gpg2', 'gpgconf', 'pass', 'op', 'printenv', 'defaults', 'codesign', 'keytool'] as const).map(
    (name) => [name, 'credential_access' as const] as const,
  ),
  // --- network egress / publishing / deployment / delegation ----------------
  ...([
    'curl', 'wget', 'nc', 'netcat', 'ncat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp', 'socat', 'ngrok',
    'gh', 'glab', 'hub', 'aws', 'gcloud', 'az', 'doctl', 'heroku', 'vercel', 'netlify', 'flyctl', 'fly', 'wrangler',
    'docker', 'podman', 'kubectl', 'helm', 'terraform', 'ansible', 'nomad', 'pulumi',
    'mail', 'mailx', 'sendmail', 'open', 'nscurl', 'httpie', 'xh', 'ping', 'dig', 'host', 'nslookup', 'whois',
  ] as const).map((name) => [name, 'network_egress' as const] as const),
  // --- opaque evaluators ----------------------------------------------------
  // Every entry runs a program supplied as a STRING or read from stdin, so what
  // it will do is not visible in the argv this classifier can see. `sed` is here
  // for its `e` command and `-i`; `awk` for `system()`; `env`/`xargs`/`timeout`
  // and friends because they exist to run something ELSE.
  ...([
    'bash', 'sh', 'zsh', 'ksh', 'dash', 'fish', 'csh', 'tcsh', 'rbash', 'busybox',
    'eval', 'exec', 'source', '.', 'command', 'builtin',
    'node', 'deno', 'ts-node', 'tsx', 'python', 'python2', 'python3', 'perl', 'perl5', 'ruby', 'irb', 'php', 'lua', 'luajit', 'Rscript', 'osascript', 'expect',
    'awk', 'gawk', 'mawk', 'nawk', 'sed',
    'xargs', 'env', 'nice', 'nohup', 'time', 'timeout', 'watch', 'script', 'parallel', 'screen', 'tmux', 'at', 'crontab', 'systemd-run',
  ] as const).map((name) => [name, 'opaque_evaluator' as const] as const),
  // --- package managers and build/test execution (host-owned, §5) -----------
  ...([
    'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'bunx', 'corepack', 'node-gyp',
    'pip', 'pip3', 'pipx', 'poetry', 'pipenv', 'uv', 'conda',
    'cargo', 'rustc', 'rustup', 'go', 'gradle', 'gradlew', 'mvn', 'make', 'gmake', 'cmake', 'ninja', 'bazel', 'buck', 'rake', 'bundle', 'bundler', 'gem', 'composer', 'dotnet', 'swift', 'swiftc', 'xcodebuild', 'xcrun',
    'tsc', 'vitest', 'jest', 'mocha', 'ava', 'pytest', 'tox', 'nox', 'karma', 'cypress', 'playwright',
    'webpack', 'vite', 'rollup', 'esbuild', 'turbo', 'nx', 'lerna',
    'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman', 'port',
    'gcc', 'g++', 'clang', 'clang++', 'cc', 'ld', 'ar', 'install_name_tool',
  ] as const).map((name) => [name, 'package_or_build_execution' as const] as const),
  // --- broad deletion -------------------------------------------------------
  // `rmdir` deletes a DIRECTORY, which §2.4 excludes from the safe set outright;
  // `srm`/`shred -u` destroy irrecoverably.
  ...(['rmdir', 'srm'] as const).map((name) => [name, 'destructive_delete' as const] as const),
]);

/**
 * Commands that MUTATE the filesystem. Only these have their operands checked
 * against `.git/` and `node_modules/`.
 *
 * §2.4's "any path touching `.git/` or `node_modules/`" sits in a paragraph
 * about the host-executable grammar — `mkdir`/`touch`/`cp`/`mv`/`rm`, all
 * mutations — and §2.1 states the same rule as "`rm` … refuses a path matching
 * `(^|/)(\.git|node_modules)(/|$)`". Applying it to READS as well would newly
 * refuse `ls node_modules`, `cat node_modules/x/package.json` and
 * `cat .git/HEAD`, every one of which the status quo ADMITS through the
 * read-only classifier. House rule 3: this change only widens.
 */
const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  'rm', 'rmdir', 'unlink', 'mv', 'cp', 'mkdir', 'touch', 'ln', 'chmod', 'chown', 'chgrp',
  'truncate', 'dd', 'tee', 'install', 'patch', 'shred', 'ditto', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'xattr', 'plutil',
]);

/** `.git` and `node_modules` as PATH SEGMENTS — `.gitignore` is not `.git`. */
const PROTECTED_PATH_RE = /(^|\/)(\.git|node_modules)(\/|$)/;

/**
 * Credential material, refused for READS as well as writes — reading is the
 * threat here, and §2.4 blocks "credential access" without qualification.
 *
 * `.env` is deliberately ABSENT. A repo-local `.env` is an ordinary tracked or
 * ignored source-tree file that implementors legitimately read, and refusing it
 * would be a false denial of the kind that ends turns. The credential store
 * entries below have no such honest in-worktree reading.
 */
const CREDENTIAL_PATH_RE =
  /(^|\/)(\.ssh|\.aws|\.gnupg|\.netrc|\.npmrc|\.pgpass|\.docker|Keychains|id_rsa|id_dsa|id_ecdsa|id_ed25519)(\/|$)/;

// ---------------------------------------------------------------------------
// git — the one command where MUTATION is the norm
// ---------------------------------------------------------------------------
/**
 * Git subcommands with NO writing form at all.
 *
 * Moved here from `adapters/grok/command.ts` unchanged, so the read set and the
 * deny set are stated in one file and cannot drift apart.
 *
 * This list was previously six entries, extended one at a time as each new
 * denial killed a paying implementor round — `git tag -l`, then `git ls-tree`.
 * That is guarding the routes instead of the state (house rule 1): every
 * individual addition was correct, and the next unlisted-but-harmless read
 * would have cost another round.
 *
 * So it is enumerated from what git IS, not from what an agent happened to try.
 * Membership rule: the subcommand must have no argument form that mutates the
 * repository, the index, the working tree, or the network. Anything whose READ
 * and WRITE forms are distinguished only by argument shape is deliberately
 * absent — guessing read-from-write by inspecting positionals is exactly the
 * inference that turns a write into an "apparently safe" read.
 *
 * Deliberately EXCLUDED, with reasons, so nobody adds them casually:
 *   config      `--get` reads, `config k v` WRITES
 *   symbolic-ref  reads with one arg, WRITES with two
 *   hash-object   `-w` writes an object
 *   stash/worktree/remote/notes/bisect  read via a `list`/`show` SUBcommand,
 *                 write via others; the shape differs from the `-l` flag gate
 *                 used for `tag`/`branch` and needs its own handling
 *   ls-remote, fetch, clone, pull   network
 *   fsck, gc, repack, prune         maintenance; may rewrite object storage
 */
export const SAFE_GIT_READ_SUBCOMMANDS: ReadonlySet<string> = new Set([
  // history / content inspection
  'diff',
  'diff-files',
  'diff-index',
  'diff-tree',
  'log',
  'show',
  'status',
  'shortlog',
  'whatchanged',
  'blame',
  'annotate',
  'cherry',
  'grep',
  // object / ref plumbing
  'cat-file',
  'ls-files',
  'ls-tree',
  'for-each-ref',
  'show-ref',
  'rev-list',
  'rev-parse',
  'name-rev',
  'describe',
  'merge-base',
  'count-objects',
  'var',
  'patch-id',
  // attribute / ignore queries
  'check-ignore',
  'check-attr',
  'check-mailmap',
]);

/**
 * Subcommands that READ in list mode but WRITE in their bare form: `git tag -l`
 * lists tags, `git tag NAME` CREATES one; `git branch --list` lists, `git branch
 * NAME` creates. They are admitted only with an explicit list flag, because with
 * `-l`/`--list` every positional is a glob PATTERN and no form of the command
 * can create a ref.
 *
 * Found live: an implementor's first turn ran
 * `git show --stat <tag> …; git rev-parse <tag> …; git tag -l 'dogfood/*' …`.
 * Every other segment classified read-only; `git tag` was not on the list, and
 * because a compound command is admitted only when EVERY segment is, the whole
 * request was denied. The implementor treated the denial as fatal and stopped
 * with no deliverable — twice, on the round and on its resume.
 */
const GIT_LIST_MODE_SUBCOMMANDS: ReadonlySet<string> = new Set(['tag', 'branch']);
const GIT_LIST_FLAGS: ReadonlySet<string> = new Set(['-l', '--list']);
/**
 * Present-tense refusal, not a fallback: a list flag alone is NOT sufficient,
 * because `git branch -l -d NAME` still deletes. Requiring `-l` and refusing
 * every mutating flag are two different conditions and both must hold.
 */
const GIT_LIST_MODE_MUTATING_FLAGS: ReadonlySet<string> = new Set([
  '-d', '-D', '--delete',
  '-m', '-M', '--move',
  '-C', '--copy',
  '-f', '--force',
  '-a', '-s', '-u', '--annotate', '--sign', '--local-user',
  '--edit', '--create-reflog', '--set-upstream', '--set-upstream-to', '--unset-upstream',
]);

/**
 * Global git options that relocate the repository, inject configuration, or
 * choose the helper binaries git will execute. Every one of them is the
 * "shared git config/hooks/remotes" entry of §3.1 wearing a flag.
 */
const GIT_CONFIG_INJECTING_FLAGS: ReadonlySet<string> = new Set([
  '-c', '--exec-path', '--config-env', '--git-dir', '--work-tree', '--namespace',
]);

/**
 * Subcommands that are PERMANENTLY denied (never grantable, §5 "git mutation …
 * remains host-owned"). Anything git-shaped that is neither a proven read nor on
 * this list is `unprovable`, not denied — `git stash list` is a read this module
 * cannot yet prove, and permanently refusing it would repeat the mistake the
 * whole inversion exists to undo.
 */
const GIT_PERMANENT_DENY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  // history mutation
  'commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am', 'apply', 'reset', 'restore', 'checkout', 'switch',
  'filter-branch', 'filter-repo', 'replace', 'update-ref', 'update-index', 'symbolic-ref', 'reflog', 'stash',
  'add', 'rm', 'mv', 'clean', 'sparse-checkout', 'notes', 'bisect',
  // remotes / network
  'push', 'pull', 'fetch', 'clone', 'remote', 'submodule', 'ls-remote', 'send-email', 'request-pull', 'bundle', 'svn', 'p4', 'daemon',
  // configuration, hooks, credentials, object storage
  'config', 'credential', 'credential-cache', 'credential-store', 'hash-object', 'init', 'gc', 'repack', 'prune', 'fsck', 'maintenance', 'worktree',
]);

/**
 * The Grok read-only classifier's git rule, verbatim, exported so the classifier
 * and the deny list judge git identically.
 */
export function isSafeGitRead(argv: readonly string[]): boolean {
  const subcommand = argv[1];
  if (subcommand === undefined) return false;
  if (!SAFE_GIT_READ_SUBCOMMANDS.has(subcommand)) {
    // Not a plain read. It may still be a list-mode read — but ONLY with an
    // explicit list flag. Absent one, refuse: `git tag v1` creates a tag, and
    // guessing from the shape of the positionals is exactly the inference that
    // turns a write into an "apparently safe" read.
    if (!GIT_LIST_MODE_SUBCOMMANDS.has(subcommand)) return false;
    const args = argv.slice(2);
    if (!args.some((arg) => GIT_LIST_FLAGS.has(arg))) return false;
    if (args.some((arg) => GIT_LIST_MODE_MUTATING_FLAGS.has(arg) || arg.startsWith('--set-upstream-to='))) {
      return false;
    }
  }
  return !argv.slice(2).some((arg) =>
    arg === '-c' ||
    arg === '--ext-diff' ||
    arg === '--textconv' ||
    arg === '--output' ||
    arg.startsWith('--output=') ||
    arg === '--exec-path' ||
    arg.startsWith('--exec-path=') ||
    arg === '--config-env' ||
    arg.startsWith('--config-env=') ||
    arg === '--git-dir' ||
    arg.startsWith('--git-dir=') ||
    arg === '--work-tree' ||
    arg.startsWith('--work-tree=') ||
    arg === '--namespace' ||
    arg.startsWith('--namespace=') ||
    arg === '--help' ||
    arg === '-h'
  );
}

/**
 * The UNCONDITIONAL half of the git rule, evaluated before the generic path
 * checks so a `git push` reports `git_mutation` rather than whatever its
 * operands happen to look like. Split out because ordering here is
 * documentation, not behaviour: both halves deny, and a reader tracing a refusal
 * should land on the rule that actually describes it.
 */
function gitPermanentDenial(argv: readonly string[]): PermanentDenyVerdict | undefined {
  const injected = argv
    .slice(1)
    .find((arg) => GIT_CONFIG_INJECTING_FLAGS.has(arg) || [...GIT_CONFIG_INJECTING_FLAGS].some((flag) => arg.startsWith(`${flag}=`)));
  if (injected !== undefined) {
    return denied('git_mutation', `git option ${injected} relocates the repository or injects configuration/hooks`);
  }
  const subcommand = argv[1];
  if (subcommand !== undefined && GIT_PERMANENT_DENY_SUBCOMMANDS.has(subcommand)) {
    return denied('git_mutation', `git ${subcommand} mutates history, refs, remotes or configuration (host-owned, §5)`);
  }
  return undefined;
}

function classifyGit(argv: readonly string[]): PermanentDenyVerdict {
  // The generic escape/credential checks have already run by the time we get
  // here, so a `git grep foo /etc` is refused even though `grep` is a proven
  // read form.
  if (isSafeGitRead(argv)) return ADMISSIBLE;
  return unprovable(
    `git ${argv[1] ?? '(no subcommand)'} is not a proven read form and is not on the permanent-deny list`,
  );
}

// ---------------------------------------------------------------------------
// Shape-aware rules for the §2.4 safe set
// ---------------------------------------------------------------------------
/** `-rf` is `-r` and `-f`; `--recursive` is `-r` spelled out. */
const RM_DESTRUCTIVE_LONG_FLAGS: ReadonlySet<string> = new Set(['--recursive', '--force', '--dir']);

/** Split argv into (flags, operands), honouring the `--` end-of-options marker. */
function splitOperands(argv: readonly string[]): { flags: readonly string[]; operands: readonly string[] } {
  const flags: string[] = [];
  const operands: string[] = [];
  let optionsEnded = false;
  for (const arg of argv.slice(1)) {
    if (!optionsEnded && arg === '--') {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && arg.startsWith('-') && arg !== '-') flags.push(arg);
    else operands.push(arg);
  }
  return { flags, operands };
}

function classifyRemove(argv: readonly string[]): PermanentDenyVerdict {
  const { flags, operands } = splitOperands(argv);
  for (const flag of flags) {
    if (RM_DESTRUCTIVE_LONG_FLAGS.has(flag)) {
      return denied('destructive_delete', `rm ${flag} is recursive or forced deletion`);
    }
    if (!flag.startsWith('--') && /[rRfd]/u.test(flag.slice(1))) {
      return denied('destructive_delete', `rm ${flag} carries a recursive/force/directory flag`);
    }
  }
  if (operands.length > 1) {
    return denied('destructive_delete', `rm names ${String(operands.length)} paths; only single-path deletion is in the §2.4 safe set`);
  }
  return ADMISSIBLE;
}

const FIND_EXECUTING_FLAGS: ReadonlySet<string> = new Set([
  '-exec', '-execdir', '-ok', '-okdir', '-fprint', '-fprintf', '-fls',
]);

function classifyFind(argv: readonly string[]): PermanentDenyVerdict {
  for (const arg of argv.slice(1)) {
    if (arg === '-delete') {
      return denied('destructive_delete', 'find -delete removes every matched path');
    }
    if (FIND_EXECUTING_FLAGS.has(arg)) {
      return denied('opaque_evaluator', `find ${arg} runs or writes something this classifier cannot see`);
    }
  }
  return ADMISSIBLE;
}

/**
 * §2.4's added rule: **`cp`/`mv` refuse an existing destination** (no-clobber,
 * fail-closed). "A genuine overwrite is expressed as `rm` then `mv`, each
 * auditable."
 *
 * `lstat`, not `exists`: a DANGLING symlink is a real entry, and `mv` onto it
 * writes through the link to wherever it points — the exact case an
 * existence check reports as "nothing there".
 *
 * An `lstat` that fails for any reason OTHER than plain absence is `unprovable`,
 * never "absent" (house rule 2).
 */
function classifyCopyOrMove(argv: readonly string[], worktreeRoot: string): PermanentDenyVerdict {
  const { operands } = splitOperands(argv);
  const name = argv[0] ?? '';
  if (operands.length !== 2) {
    return unprovable(
      `${name} with ${String(operands.length)} operands is outside the §2.4 grammar (exactly one source and one destination)`,
    );
  }
  const destination = operands[1] ?? '';
  const absolute = path.isAbsolute(destination) ? destination : path.join(worktreeRoot, destination);
  try {
    lstatSync(absolute);
    return denied('clobbering_destination', `${name} destination ${destination} already exists (§2.4 no-clobber)`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return ADMISSIBLE;
    return unprovable(`${name} destination ${destination} could not be probed (${code ?? 'unknown error'})`);
  }
}

// ---------------------------------------------------------------------------
// Path arguments
// ---------------------------------------------------------------------------
/**
 * F14 — an argument ESCAPES when it can name something outside the agent's own
 * worktree. The predicate used to answer that with `arg.startsWith('/')`, i.e.
 * every absolute path escapes. It does not: the implementor prompt hands the
 * agent its worktree BY ABSOLUTE PATH ("You may create, modify, or delete files
 * ONLY inside your assigned worktree: <abs>"), so the engine named a path and
 * then denied every command that used it. A denied permission ends the turn
 * before the work is committed, so the run dies `no_deliverable` — four dogfood
 * runs were lost to it, the last (run_60ccbfda) on nothing but
 * `ls -la <worktree> && ls -la web …`.
 *
 * The rule: an absolute argument is admissible IFF it RESOLVES inside
 * `worktreeRoot` — realpath containment via the nearest existing ancestor
 * (`resolvesInsideRoot`, shared with the ACP structured-write rule). Everything
 * else is refused byte-for-byte as before:
 *
 *  - the `..` forms are still refused, and now apply to ABSOLUTE paths too
 *    (`<root>/web/../x`, `<root>/link/..`) rather than being skipped by the
 *    blanket `/` rejection they used to hide behind. Refusing more here can only
 *    cost a denial the agent can trivially rewrite; admitting a `..` we did not
 *    have to admit is how a symlink escape gets in.
 *  - `~/` (the shell would expand it to a home outside the worktree) and `=/`
 *    (an option value naming an absolute path) stay refused unconditionally.
 *
 * FAIL CLOSED: no root, a relative or unresolvable root, a path with no existing
 * ancestor, any filesystem error — all refusals. `worktreeRoot` is a REQUIRED
 * parameter (`string | undefined`) precisely so a call site must state which one
 * it has: a caller that cannot supply a root must say so, and gets the
 * pre-F14 behaviour (no absolute path admissible) rather than silently getting
 * it.
 */
export function escapesWorktree(argv: readonly string[], worktreeRoot: string | undefined): boolean {
  return argv.slice(1).some((arg) => argumentEscapes(arg, worktreeRoot));
}

function argumentEscapes(arg: string, worktreeRoot: string | undefined): boolean {
  if (
    arg === '..' ||
    arg.startsWith('../') ||
    arg.includes('/../') ||
    arg.endsWith('/..') ||
    arg.startsWith('~/') ||
    arg.includes('=/')
  ) {
    return true;
  }
  if (!arg.startsWith('/')) return false;
  return worktreeRoot === undefined || !resolvesInsideRoot(worktreeRoot, arg);
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------
/** One shell segment's argv, already stripped of safe null redirections. */
function classifyArgv(argv: readonly string[], worktreeRoot: string): PermanentDenyVerdict {
  const executable = argv[0];
  if (executable === undefined || executable.length === 0) {
    return unprovable('a shell segment with no command word');
  }
  // The BASENAME, so `/usr/bin/sudo` and `/bin/rm -rf` cannot walk past a table
  // keyed on bare names. The executable itself is exempt from the worktree
  // containment rule below — interpreters legitimately live in /usr/bin.
  const name = path.basename(executable);

  const tableRule = DENIED_COMMANDS.get(name);
  if (tableRule !== undefined) {
    return denied(tableRule, `${name} is permanently denied for implementors (spec §2.4 ${tableRule})`);
  }
  if (name === 'git') {
    const gitDenial = gitPermanentDenial(argv);
    if (gitDenial !== undefined) return gitDenial;
  }

  // An executable NAMED BY PATH that lands inside the agent's own worktree is a
  // program the agent wrote, and running it executes code no classifier can see.
  //
  // This is the hole an inverted default opens that an allowlist never had: under
  // "allow by default" an unrecognised command word is ADMITTED, which is right
  // for `jq`/`tree`/`xxd` resolved off PATH and catastrophically wrong for
  // `./build.sh`. The agent can already `Write` a script and `chmod +x` it inside
  // its worktree, so without this rule the whole §2.4 list is one file away from
  // being bypassed. A bare command word (no `/`) is a system tool resolved off
  // PATH; an absolute path OUTSIDE the worktree is likewise a system tool and
  // stays admissible, judged by its basename against the table above.
  //
  // Not a narrowing: `./script` and `scripts/x.sh` are refused by the status quo
  // too (they are on no read-only allowlist).
  if (executable.includes('/')) {
    if (executable.split('/').includes('..') || executable.startsWith('~')) {
      return denied('outside_worktree', `the executable ${executable} is named through a parent or home traversal`);
    }
    const resolved = path.isAbsolute(executable) ? executable : path.join(worktreeRoot, executable);
    if (resolvesInsideRoot(worktreeRoot, resolved)) {
      return denied(
        'opaque_evaluator',
        `${executable} is a program inside the agent's own worktree; running it executes code this classifier cannot read`,
      );
    }
  }

  // Path-shaped arguments, for EVERY command: escape first (it is the cheapest
  // and the most consequential), then credential material.
  const escaping = argv.slice(1).find((arg) => argumentEscapes(arg, worktreeRoot));
  if (escaping !== undefined) {
    return denied('outside_worktree', `argument ${escaping} does not resolve inside the assigned worktree`);
  }
  const credential = argv.slice(1).find((arg) => CREDENTIAL_PATH_RE.test(arg));
  if (credential !== undefined) {
    return denied('credential_access', `argument ${credential} names credential material`);
  }
  // `.git/` and `node_modules/` are protected against MUTATION only — reading
  // them is admitted today and stays admitted (see MUTATING_COMMANDS).
  if (MUTATING_COMMANDS.has(name)) {
    const protectedPath = argv.slice(1).find((arg) => PROTECTED_PATH_RE.test(arg));
    if (protectedPath !== undefined) {
      return denied('protected_path', `${name} would mutate ${protectedPath}, which is under .git/ or node_modules/`);
    }
  }

  if (name === 'git') return classifyGit(argv);
  if (name === 'rm' || name === 'unlink') return classifyRemove(argv);
  if (name === 'find') return classifyFind(argv);
  if (name === 'cp' || name === 'mv') return classifyCopyOrMove(argv, worktreeRoot);
  return ADMISSIBLE;
}

/**
 * Classify a raw shell command string against the §2.4 permanent-deny list.
 *
 * Exported for the provider rules and the future host-executability check —
 * §3.1's "one module consumed by every provider's native deny rules and by the
 * host-executability check. Four per-provider copies will drift."
 */
export function classifyShellCommand(command: string, worktreeRoot: string): PermanentDenyVerdict {
  // POSITIVELY-identified metasyntax first, because §2.4 names substitutions and
  // heredocs on the never-allowed list. Doing this before the tokenizer is what
  // keeps them `denied` rather than collapsing into the tokenizer's
  // `unprovable`.
  const opaque = detectOpaqueEvaluatorSyntax(command);
  if (opaque !== undefined) {
    return denied('opaque_evaluator', `the command contains ${opaque}`);
  }
  const segments = parseShellCommandSegments(command);
  if (segments === undefined) {
    // House rule 2. This is the single most important line in the file: an
    // operation whose payload cannot be parsed is NOT provably safe, so it must
    // never reach the permissive default.
    return unprovable('the command could not be split into shell segments (quoting or control syntax this engine does not model)');
  }
  // Per SEGMENT, so an unreadable segment cannot hide a permanently-denied one
  // behind it — `ls > out.txt && rm -rf src` is a destructive delete, not an
  // unknown, and `worst` makes the denial win.
  return worst(
    segments.map((segment) =>
      segment.kind === 'argv'
        ? classifyArgv(segment.argv, worktreeRoot)
        : unprovable('a shell segment could not be parsed into argv (redirection or quoting this engine does not model)'),
    ),
  );
}

/**
 * Classify a structured `Write`/`Edit` target path.
 *
 * **Never returns `admissible`, and that is deliberate.** This module is bound to
 * the EXECUTION root — the read boundary, the same one the shell classifier
 * judges path arguments against. A structured write is adjudicated against the
 * B4 WRITE BOUNDARY, which may be strictly narrower (`in_place` mode with a
 * declared scope), and only `admitsWorkspaceWrite` holds that boundary.
 *
 * Returning `admissible` here therefore silently widened every implementor's
 * writes back to the whole execution root. Caught by
 * `scoped-write.test.ts` — "binds the SUPPLIED boundary for the implementor" —
 * which went from `deny` to `allow` for a write into `web/` under a
 * `declaredScope: ['src']`. The verdicts this function CAN return are the
 * refusals; admission stays with the boundary rule, so the permissive default
 * cannot outrank a narrower declared scope.
 */
export function classifyFileTarget(target: string, worktreeRoot: string): PermanentDenyVerdict {
  if (PROTECTED_PATH_RE.test(target)) {
    return denied('protected_path', `${target} is under .git/ or node_modules/`);
  }
  if (CREDENTIAL_PATH_RE.test(target)) {
    return denied('credential_access', `${target} names credential material`);
  }
  if (!path.isAbsolute(target) || !resolvesInsideRoot(worktreeRoot, target)) {
    return denied('outside_worktree', `${target} does not resolve inside the assigned worktree`);
  }
  return unprovable(
    `${target} carries no permanent-deny rule, but only the write BOUNDARY may admit a structured write — this module holds the execution root, which can be wider`,
  );
}

/**
 * THE entry point `decidePermission` calls.
 *
 * `rawInput` is consulted as well as the title, and deliberately so. The payload
 * veto (`verifyOperationPayload`) already binds the two before any mediation
 * branch runs, but a construction site may legitimately install
 * `noPayloadToVerify` — so classifying the title ALONE would let that
 * combination present `Execute \`ls\`` while executing something else. Both the
 * titled command and the executed command must classify admissible; a payload
 * that is present but unreadable is `unprovable`, never absent.
 */
export function classifyImplementorOperation(
  operation: string | undefined,
  rawInput: unknown,
  posture: ImplementorAdmissionPosture,
): PermanentDenyVerdict {
  if (posture.kind !== 'permissive') {
    return unprovable('the session is not running the permissive implementor posture');
  }
  const root = posture.worktreeRoot;
  const title = parseOperationTitle(operation);
  switch (title.kind) {
    case 'shell': {
      const verdicts = [classifyShellCommand(title.command, root)];
      const executed = readCommandField(rawInput);
      switch (executed.kind) {
        case 'string':
          verdicts.push(classifyShellCommand(executed.value, root));
          break;
        case 'malformed':
          verdicts.push(unprovable('the tool call carried a `command` field that is not a string'));
          break;
        case 'absent':
          break;
      }
      return worst(verdicts);
    }
    case 'structured_file':
      return classifyFileTarget(title.path, root);
    case 'unrecognized':
      // Not a shape this engine can read. Under the permissive posture that is
      // exactly the "unprovable" tail §2.4 routes to operator review — it is
      // never admitted by default.
      return unprovable('the operation title is not a shape this engine can classify');
  }
}

type CommandField =
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'absent' }
  | { readonly kind: 'malformed' };

/**
 * Reading the executed `command`, distinguishing the three outcomes that matter:
 * a usable string, ABSENT, or PRESENT BUT MALFORMED. Collapsing the last two is
 * the same logical error corrected twice already at other layers.
 */
function readCommandField(rawInput: unknown): CommandField {
  if (rawInput === undefined || rawInput === null) return { kind: 'absent' };
  if (typeof rawInput !== 'object' || Array.isArray(rawInput)) return { kind: 'malformed' };
  const record = rawInput as Record<string, unknown>;
  if (!('command' in record) || record['command'] === undefined) return { kind: 'absent' };
  const value = record['command'];
  return typeof value === 'string' ? { kind: 'string', value } : { kind: 'malformed' };
}
