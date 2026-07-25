# F8 / F9 / F10 / F11 — implementation log

Branch `worktree-agent-a3095dba421e6648a`, parent `5669d22` (F7).
Written for the codex adversarial diff-review. Every fix below has a
regression test that was run against its parent commit FIRST and observed to
fail; the exact command + counts are recorded per fix.

**A green suite is not the gate here.** The open questions at the end of each
section are where I want the review pressure.

---

## Commit sequence

| sha | what |
| --- | --- |
| `20f7e57` | F8 tests (failing on `5669d22`) |
| `483695c` | F8 fix |
| `fac1b93` | F10 tests (failing on `483695c`) |
| `a2844f4` | F10 fix |
| `8989ec6` | F9 tests (failing on `a2844f4`) |
| `8b4b4ce` | F9 fix |
| `3c857b3` | F11 tests (failing on `8b4b4ce`) |
| `30772eb` | F11 fix |

---

## F8 — resumable interrupted implementor rounds

> Path note for anyone reading the F8 spec draft alongside this: the cadence
> module is `src/checkpoint/cadence.ts`, NOT `src/domain/cadence.ts` (the draft's
> line references `:27`/`:38` are correct; only the directory was wrong). The
> `CheckpointReason` union itself does live in `src/domain/state.ts:349-354`. The
> draft's claim that `pre_verify_handoff` had ZERO production writers is
> confirmed: the only writer was `#writeStopCheckpoint`, reachable solely from
> `pre_pause` / `pre_graceful_stop` / `cadence` call sites.

### (A) Forward-containment acceptance in §16.3

**What changed**

- `src/worktree/git.ts` — new `isAncestor(worktreePath, ancestor, descendant)`.
  Splits `git merge-base --is-ancestor` exit 0 (ancestor) / exit 1 (not) from
  every other exit (128 unknown-or-non-commit object, -1 spawn failure), which
  THROW. Both revs are peeled with `^{commit}`.
- `src/worktree/validate.ts` — new input `acceptForwardContainment` (default
  false) and a new decision-tree row 3b in the module doc comment. The drift
  branch now calls `probeForwardContainment`, which returns
  `{accepted, reason}`. Acceptance requires: caller opted in AND the probe
  answered YES. A probe that THROWS is reported as a refusal carrying the
  probe's own message. On acceptance `forwardDrift` is set, which (i) forces
  `exactMatch` false so an incidental porcelain/diffHash equality is never
  reported as "matches the checkpoint exactly", and (ii) makes
  `mismatchDetected` true on both remaining outcomes. `git hardReset` on the
  clean path targets `initialRead.headSha`, never the checkpoint's — HEAD is
  never moved back.
- `src/worktree/manager.ts` — `validate(assignmentId, checkpointState?, options?)`
  with a new `ValidateOptions.acceptForwardContainment`.
- `src/app/flows/orchestrate.ts:430` region — the interrupted-implementor branch
  of `adoptWorktree` passes `{acceptForwardContainment: true}`. The verifier and
  completed-implementor branches are untouched (they bind an exact commit via
  `discardToCommit`). The CLI `validate` command (`commands.ts:1251`) is
  untouched and keeps the strict any-drift-refuses policy.

**Regression proof (run on `5669d22`, before any production change)**

```
npx vitest run src/worktree/validate.test.ts
  -> PASS (12) FAIL (5)
     failing: the 5 F8 (A) forward-containment rows.
     e.g. "expected 'refuse_resume' not to be 'refuse_resume'"

npx vitest run src/app/flows/orchestrate-resume.test.ts -t "F8"
  -> PASS (2) FAIL (1)
     AC-1 fails with the EXACT production error:
     WorktreeError: §16.3 validation refused resume-in-place: HEAD drifted
     since the last checkpoint (checkpoint=a9cb0a8e…, current=da2c3a6b…)
     AC-2 (tamper) and AC-4 (probe error) already refuse — they are guards,
     not regressions.
```

`src/worktree/validate.test.ts` is NEW: `validate.ts` had no dedicated test
file, so the whole pre-existing outcome matrix (clean / wip_committed /
reset_and_recorded / refuse_resume / HEAD-unreadable / stale index.lock / the F7
node_modules exclusion) is pinned there before the module was touched.

**Open questions for codex**

1. **Taint lifecycle.** An accepted forward drift returns
   `reset_and_recorded`/`wip_committed`, so `manager.validate` CLEARS any prior
   taint (`#taints.delete`). Is clearing right when the round was interrupted by
   an emergency kill (`emergency_kill` taint) and the only evidence it is
   healthy is "HEAD moved forward"? I think yes — validation's whole point is to
   resolve staleness and the tree is now a known-exact state — but it is a
   deliberate widening of what clears a taint.
2. **The `reset_and_recorded` outcome on a clean forward-drifted tree.** The
   `git reset --hard HEAD` is a genuine no-op, but the outcome NAME now covers a
   case its original prose ("checkpoint recorded a dirty worktree that is
   already clean now") does not describe. I chose "continue the remaining checks
   unchanged" over inventing a fifth outcome. Should there be a
   `forward_accepted` outcome instead? That would ripple into
   `ValidationOutcome`, the persisted `lastValidation.outcome` union in
   `orchestrate.ts`, and the CLI.
3. **Round scoping.** Forward containment does not check that the descendant
   commits belong to THIS round. A worktree left ahead by a PREVIOUS round whose
   successor crashed would also be accepted. `lastImplementationCommit` is
   round-scoped (`orchestrate.ts:413`) and the completed-implementor path uses
   it; the interrupted path does not. Is that the hole fix shape (B) was for?
   The spec deferred (B) as "redundant once (C) exists" — but (C) is best-effort
   (see below), so (B)'s redundancy is conditional.
4. **`capturePauseWorktreeState`'s error path** records `headSha: gitSha('')`.
   That reaches `isAncestor` as `'^{commit}'`, which errors → refusal. Covered
   by a test. Confirm there is no other sentinel that could resolve.

### (C) The `pre_verify_handoff` writer

**What changed**

- `src/app/role-runner.ts` — `RoleSession` gains
  `checkpointVerifyHandoff(): Promise<{written: boolean}>`.
- `src/app/service.ts` — `#buildRoleSession` wires it to a new
  `#writeVerifyHandoffCheckpoint(ctx)`, closed over the SAME `SpawnContext` the
  cadence hook uses. It mirrors `#maybeCadenceCheckpoint` exactly: same
  `#writeStopCheckpoint` assembler, `OPERATION_IDLE`, `ingest` of the resulting
  `checkpoint.recorded`, and the cadence-window reset that lives inside
  `#writeStopCheckpoint`.
- `src/app/flows/implementor.ts` — called immediately after `commitAll`, before
  the provisioning boundary. Result surfaced as
  `ImplementorResult.verifyHandoffCheckpointed`.

**Why this seam.** The flow does not own the service and cannot reach
`#writeStopCheckpoint`, which needs a `SpawnContext`. The service already hands
the flow exactly one object built from that context — the `RoleSession` — and
the cadence path is the precedent for using it. This is the "existing seam the
cadence path uses, mirrored", not a new layering hole: the flow still never
touches the assembler, the CAS, or the event log.

**Deliberately NON-FATAL.** A failed checkpoint write does not unwind the round.
The deliverable is already durably committed, so failing it would be strictly
worse, and (A) accepts the forward drift on resume without the checkpoint. This
mirrors `#maybeCadenceCheckpoint` ("a failed checkpoint write is non-fatal") and
the T22 graceful-stop catch. Failures bump `#supervisionIngestErrors` and are
reported honestly on the result rather than silently swallowed.

**Regression proof (on `5669d22`)**

```
npx vitest run src/app/flows/implementor.test.ts -t "pre_verify_handoff"
  -> PASS (0) FAIL (2)   "expected [] to have a length of 1"
```

**Open questions for codex**

5. **Should (C) be fatal after all?** I argued no. But the consequence of
   non-fatal is that (A) is load-bearing on its own, which re-opens question 3.
6. **Post-commit `statusPorcelain`/`diffHash`.** The checkpoint records the
   post-commit tree, so porcelain is `''` and diffHash is the empty hash. On
   resume, if verification commands then dirtied the tree, §16.3 sees same-HEAD
   + mismatch + dirty → `wip_committed`, which WIP-commits build output onto the
   verified HEAD. That behaviour predates F8, but (C) makes it reachable in a
   new place. Worth a look.
7. **Ordering vs. provisioning.** The checkpoint is written BEFORE
   `provisionForVerification`. So the recorded porcelain does not include a
   provisioned `node_modules` — which is correct only because it is gitignored.
   Under `provision:'none'` in a repo that tracks node_modules, is that still
   true?
8. `vertical-slice.test.ts`'s §19-test-22 fixture hand-appends its own
   `pre_verify_handoff` checkpoint and located it with `.find`; the implementor
   round now writes a real one earlier, so it takes the LATEST (`.findLast`) —
   the same disambiguation the fixture already applied for W4-1 cadence
   checkpoints, and what `resolveResumeCheckpointHash` itself does. Confirm this
   is a fixture correction and not a masked behaviour change.

---

## F10 — `git add -A -- . ':(exclude)node_modules'` is dead on git 2.55

### The bug

git 2.55 treats the `:(exclude)node_modules` pathspec ITEM as explicitly naming
an ignored path, so the command exits 1 with
`The following paths are ignored by one of your .gitignore files: node_modules`
whenever an ignored `node_modules` exists ON DISK. F7 provisions exactly such a
tree into every worktree, so from git 2.55 onward BOTH callers fail on every
provisioned round: the implementor post-turn commit
(`implementor.ts`, provisioning-active branch) and the §16.3 WIP-reconciliation
commit (`validate.ts`). `run_756ce21b`'s resume died there.

Standalone repro (git 2.55.0, scratch repo — never a real checkout):

```
git init -q -b main .
printf 'node_modules/\n' > .gitignore
printf 'x\n' > tracked.txt && git add -A && git commit -q -m init
mkdir -p node_modules/left-pad && printf 'm\n' > node_modules/left-pad/index.js
printf 'y\n' > tracked.txt && printf 'new\n' > added.txt
git add -A -- . ':(exclude)node_modules'    # RC=1, advice text verbatim
```

Empirically validated fix shape, same git (all four scenarios are now tests):

| # | scenario | result |
| --- | --- | --- |
| r1 | ignored + present, plain `git add -A -- .` | RC 0, stages nothing under node_modules; `git reset --quiet -- node_modules` RC 0 |
| r2 | NO gitignore | plain add stages node_modules → targeted reset clears it → post-check re-verifies, fails closed if any remain |
| r3 | nested `web/node_modules`, no gitignore | staged by the plain add, caught by the post-check regex, cleared by the targeted reset |
| r4 | control: the OLD pathspec, ignored + present | still fatal — AND it staged `src/feature.ts` before dying, i.e. the old helper threw over a HALF-STAGED index |

### What changed (`src/worktree/git.ts`)

`addAllExceptNodeModules` now stages with a plain `git add -A -- .`
(.gitignore alone already keeps an ignored tree out), then PROVES the index
carries nothing node_modules-shaped: enumerate `git diff --cached --name-only -z`,
unstage every match, re-check, and FAIL CLOSED (`WorktreeError`, paths named) if
any survives. The invariant "a provisioned tree can never enter a harness
commit" is now an assertion over the index rather than a property of a pathspec.

Strictly stronger than what it replaced:

- **Any depth.** The old pathspec was root-only and silently staged a nested
  `web/node_modules` (proven by test). Matching is segment-anchored
  `(^|/)node_modules(/|$)`, so `src/node_modules_helper.ts` and
  `src/my_node_modules/` are untouched (also tested).
- **`unstageNodeModules` is folded IN** rather than called separately by each
  caller. It stays exported as the depth-aware unstage primitive the helper
  itself uses, and both call sites now make ONE call. It returns the paths it
  unstaged.
- **`-z` parsing** keeps paths with spaces/newlines/non-ASCII verbatim (git's
  path quoting is off under `-z`); the trailing empty field from the final NUL
  is dropped.
- **ARG_MAX.** The reset uses OUTERMOST `node_modules` DIRECTORY pathspecs
  (`node_modules`, `web/node_modules`), not one argument per file, so a
  100k-entry tree cannot overflow the argument list.
- **Never deletes.** Unstaging leaves the provisioned bytes on disk; a
  tracked-in-HEAD node_modules is reset to its HEAD content (so it is no longer
  a staged CHANGE, exactly what the old exclusion achieved) and the working-tree
  bytes are untouched (tested).

### Regression proof (on `483695c`)

```
npx vitest run src/worktree/git.test.ts
  -> PASS (6) FAIL (5)
     3 fail with the verbatim git 2.55 advice error; 2 fail on the depth hole.
npx vitest run src/worktree/validate.test.ts -t "F10"
  -> FAIL: the §16.3 WIP path with a provisioned ignored tree dies in commitWip.
npx vitest run src/app/flows/implementor.test.ts -t "F10"
  -> PASS (0) FAIL (1): the flow's own commit with an IGNORED node_modules.
```

`src/worktree/git.test.ts` is NEW.

**Why the bug shipped — corrected diagnosis.** Not "the flow tests fake git";
they do not. `implementor.test.ts` drives this helper against REAL git
(`makeTempGitRepo`, :188). The suite was **fixture-shape-blind**: the four
conditions needed to trigger the git 2.55 path never co-occurred in one test.

| file | real git | committed `node_modules/` rule | node_modules present | calls the staging helper |
| --- | --- | --- | --- | --- |
| `implementor.test.ts` (pre-F10) | yes | **no** — its only rule was `*.log` (:836), so its node_modules fixtures were UNIGNORED and the old pathspec exited 0 | yes | yes |
| `provision.test.ts` | yes | **yes** (:105 etc.) | yes | **no** — it never calls the staging helper |
| `git-stable.test.ts` | yes | no | no | no (stable HEAD/status read only) |

So the new regression test deliberately combines all four in ONE test, and the
F10 flow-level test in `implementor.test.ts` commits a real `node_modules/` rule
for the same reason.

Two behaviours captured while verifying, both now asserted:

- `git add` stages the non-excluded paths and THEN exits 1 with the ignored-path
  advice — so pre-fix the helper threw over a HALF-STAGED index and the commit
  never ran. The main test now asserts the post-fix absence of that half-state
  (index is exactly the work, the commit lands, the tree ends clean); the CONTROL
  test asserts the pre-fix half-state explicitly.
- `git reset --quiet -- node_modules` with a non-matching pathspec is a clean
  rc=0 no-op, so calling it is safe regardless. (The implementation still only
  calls it when the index scan found something, which is strictly cheaper.)

**Open questions for codex**

9. **Should the post-check also guard `.provision` stage dirs?** They live
   under the manager base dir, OUTSIDE the worktree, so `git add -A -- .` cannot
   reach them. But `baseDirStrategy` is configurable — is there a configuration
   under which a stage lands inside a worktree? If so the post-check should
   cover `.provision` too.
10. **Fail-closed reachability.** With the targeted reset in place, I could not
    construct a case where entries genuinely REMAIN staged except by breaking
    the index (the test uses a stale `index.lock`, which makes the reset itself
    throw rather than exercising the "remaining" branch). Is the
    remaining-entries branch dead code, or is there a real shape — an unmerged
    index entry, a submodule at `node_modules`? — that reaches it?
11. **`git add -A -- .` vs `git add -A`.** cwd is the repo root at both call
    sites, so they are equivalent. Confirm no caller can pass a subdirectory.

---

## F9 — provisioning must prove the tree it provides

### What changed (`src/worktree/provision.ts` and around)

**The install lane is gone.** `npm ci --ignore-scripts` cannot build a
script-installed native dependency, so a tree it produced could never be PROVEN
(P1) — and `hasBinDir` stamped it "proven" anyway, because `.bin/` is populated
at UNPACK time from `bin` fields, entirely independent of lifecycle scripts. The
marker then matched, so every later round short-circuited onto the broken tree
(P2). `buildViaInstall` is deleted. `buildStagedTree` returns
`strategyTaken: 'clone'` only.

1. **Mismatch → cause-coded refusal naming the diverged manifest.** Two
   ManifestSets cannot say WHICH side moved, so the primary's own HEAD is read
   as a third reference (`manifestDivergenceFailure`):
   worktree-HEAD ≠ primary-HEAD → `deps_changed_in_worktree`; otherwise the
   drift is primary-on-disk vs primary-HEAD → `primary_manifests_diverged`. An
   unreadable primary HEAD refuses naming BOTH remedies
   (`manifest_divergence_unclassified`) rather than guessing.
   `divergedManifestNames` names the exact files; when the manifests are
   byte-identical the message says the platform key differs instead.
2. **The false clone is closed** (`proveePrimaryTree`): every root
   `dependencies` + `devDependencies` name must resolve to a DIRECTORY under the
   primary's `node_modules` before it is cloned, else `primary_tree_stale` with
   the missing names listed. Scoped names resolve under their scope dir.
3. **The toolchain proof is a RUNTIME smoke** (`runNativeSmoke`), on the STAGED
   tree, BEFORE the marker write, on the CLONE lane too:
   `node -e "require(pkg)"` from the staged tree's PARENT (bare-specifier
   resolution walks into the staged `node_modules` on both lanes), under a local
   `SMOKE_ENV_ALLOWLIST` and a per-package deadline. Failure →
   `native_toolchain_unproven` naming the package and quoting its stderr.
4. **Honest config.** `'auto'` and `'clone'` are both clone-or-fail-closed (the
   unsafe-symlink retry-as-install is gone → `unsafe_clone_symlinks`).
   `'install'` is refused at config parse (`schema.ts`, with
   `INSTALL_PROVISIONING_REMOVED_MESSAGE`) AND again at this module's entry as
   the programmatic belt. `'none'` unchanged.
5. **Bounded commands.** `withDeadline` races every injected seam call
   (`boundedGit` wraps all three `ProvisionGit` methods; `runtime.cloneDir` is
   wrapped at its call site) against `PROVISION_COMMAND_TIMEOUT_MS` (10 min).
   Separately, `defaultProvisionRuntime`'s own `execFile` calls carry `timeout`
   so a wedged child is KILLED, and `runGit`/`runGitStatus` gained an optional
   timeout that `REAL_PROVISION_GIT` binds. Both are needed: the promise race
   covers a seam that never settles at all; the execFile timeout actually reaps
   the process.
6. **CLI hint by cause** (`provisioningNextHint`). The old single generic line
   actively misled the commonest case — a dep-adding implementor commit, which
   reinstalling the primary cannot fix.
7. **Warn-event fixes.** `clone_source_fingerprint_mismatch.worktreePath` →
   `primaryRepoRoot` (it always carried the primary root);
   `clone_symlinks_unsafe.fallback` dropped (there is no fallback);
   `native_smoke_passed` added.
8. **Cause plumbing.** `WorktreeErrorOptions.provisioningCause` /
   `WorktreeError.provisioningCause` (named explicitly at both ends so it never
   collides with `Error.cause`), threaded into `ProvisioningFailure.cause` and
   out to the CLI. The cause is a closed-vocabulary constant, so it needs no
   redaction (codex focus (iii)) — the free-text `detail` is still redacted as
   before.
9. **`runtime.install` survives with NO production caller**, documented as a
   transition seam, and its env is now pinned to the allowlist (codex focus
   (ii)) so it can never leak orchestrator credentials to an npm lifecycle.

Preserved and still proven: transactional staging/swap, the three fail-closed
stage-GC paths, marker semantics for PROVEN trees, workspaces refusal, `'none'`,
`recheck`.

### The native-smoke candidate filter — a deliberate deviation

The spec says "derive packages with install/postinstall scripts from the
installed tree … and `node -e require()` each". Taken literally that breaks: on
THIS repo's real tree the script-bearing set is `better-sqlite3`, `esbuild` and
`opencode-ai`, and the last two are not meaningfully `require`-able (a CLI
package with no usable entry point would fail the smoke for a reason that is not
breakage, failing every provisioning run).

So the candidate set is narrowed to script-bearing packages that are NATIVE
BUILDS: a `binding.gyp` is present, OR an install/pre/postinstall script matches
`node-gyp|node-pre-gyp|prebuild|cmake-js`. That is exactly the set whose
`require()` genuinely dlopens a built artifact — a real proof with no false
positives, and it includes better-sqlite3, the spec's stated minimum.

Cost measured on the real tree: 212 top-level packages scanned in 53 ms.

### Regression proof (on `a2844f4`)

```
npx vitest run src/worktree/provision.test.ts -t "F9"
  -> PASS (4) FAIL (13)
```

The 4 passes are behaviours F9 must PRESERVE (healthy clone + marker
short-circuit, a scoped declared package, forced-clone unsafe-symlink refusal,
`'none'`). Post-fix the whole file is PASS (73) FAIL (0).

Pre-existing F7 rows that asserted the install fallback were UPDATED, not
deleted: each still proves its invariant ("never clone an unproven source", "a
failed build leaves the prior tree intact", "the mutex is held for the whole
operation") — only the alternative changed from install to refusal. Two
rollback/crash-recovery rows now fault the CLONE, since that is the only build.

**Open questions for codex**

12. **Is the native-smoke filter the right narrowing?** It leaves
    `esbuild`-class packages (postinstall DOWNLOADS a platform binary) unproven.
    `require('esbuild')` would succeed with the binary missing, so requiring it
    proves nothing; proving it needs a different check (does the declared
    platform binary exist / does `--version` run). Should F9 add that, or is it
    scope creep?
13. **Transitive natives.** The smoke enumerates the staged tree's TOP LEVEL
    (npm hoists, so that is the installed set) — so a transitive native IS
    covered. But `proveePrimaryTree` only checks ROOT-declared names. A primary
    missing only a transitive dependency passes the tree proof and is cloned.
    Acceptable (the smoke then catches the native ones), or a hole?
14. **`manifest_divergence_unclassified` is a third cause** the spec did not
    name. I added it rather than guessing an attribution when the primary's HEAD
    cannot be read. Is the extra vocabulary worth it, or should that case reuse
    `primary_manifests_diverged` with hedged prose?
15. **The primary-HEAD probe reads the PRIMARY repo through `ProvisionGit`,**
    whose methods are documented in terms of a worktree path. It is a git repo
    root so `git ls-tree HEAD` works, but confirm there is no linked-worktree
    indirection that makes "the primary's HEAD" ambiguous when the orchestrator
    itself runs from a worktree.
16. **`runtime.install` with no caller.** Keep as a documented transition seam,
    or delete `ProvisionRuntime.install` outright (which churns
    `WorktreeManagerOptions`, `defaultProvisionRuntime`, and every F7 test fake)?
17. **`ProvisionStrategyTaken` still includes `'install'`,** now unreachable.
    Same question.
18. **Timeout double-coverage.** `withDeadline` rejects but does NOT cancel the
    underlying operation — a hung `cloneDir` keeps running after the refusal,
    writing into a stage dir that the `finally` may then delete. Is that a real
    hazard (a late write recreating a GC'd stage), and should the deadline path
    quarantine the stage instead of deleting it?
19. **Smoke env.** `SMOKE_ENV_ALLOWLIST` is a LOCAL copy of the transport's
    `CHILD_ENV_ALLOWLIST` minus TERM/SHELL/USER/LOGNAME, because
    `src/worktree` must not import `src/adapters`. Is duplicating it right, or
    should the allowlist move to a shared low-level module?

---

## F11 — the grok read-only shell classifier rejected quoted regexes

### The bug — and the fact that it lives in TWO places

The `$`/`\`/backtick scan is DUPLICATED. `splitShellSegments` has one
(`command.ts:130` pre-fix) and `tokenizeShellSegment` has its own
(`:179-181` pre-fix), each positioned BEFORE that function's own quote tracking.
Both scanned those bytes as fatal ANYWHERE — including inside SINGLE quotes,
where POSIX guarantees no parameter expansion, no command substitution and no
escape processing. A read-only search whose pattern is a regex was therefore
unclassifiable: `rg -n '3A\.1|…'` → permission denied → implementor turn dead.

**Fixing either site alone accomplishes nothing.**
`isGrokReadOnlyShellPermissionTitle` runs BOTH (split → tokenize → strip
redirections → classify) and a rejection at either stage is a denial. Verified
by experiment: with ONLY `splitShellSegments` reordered,
`src/adapters/grok/command.test.ts` still reported `pass 35 fail 4` —
byte-identical to the wholly-unfixed state. Both sites are reordered, and every
assertion in the F11 block drives the FULL pipeline rather than a single
scanner, so a one-site fix cannot green them. A dedicated test
("needs BOTH scanners fixed") pins this with a single-segment command, where the
splitter has nothing to split and the tokenizer's own scan is the only thing
that can reject.

### What changed

Both scanners now: (1) reject control bytes in every context — a NUL or embedded
newline is never a legitimate literal, quoted or not; (2) treat a SINGLE-quoted
span as an opaque literal, ending only at its closing quote; (3) apply the
UNCHANGED conservative rejection everywhere else, INCLUDING inside double
quotes, where the shell really does expand.

Why the relaxation is not a hole (each is a test):

- the span ends only at its closing quote, so `;`/`&&`/`|` inside it stay
  argument bytes and cannot introduce a second, unclassified segment;
- `stripSafeRedirections` only treats an UNQUOTED `>`/`<` as a redirection —
  the shell's own rule;
- `hasEscapingPathArgument` inspects the RESOLVED token value, so
  `cat '/etc/passwd'` is still refused: quoting is not a bypass;
- `'$(rm -rf /)'` is a literal string argument in every POSIX shell, so
  classifying it read-only is ACCURATE, not permissive;
- the 8KB / 24-segment caps, `SAFE_NULL_REDIRECTIONS`, the command allowlist and
  the `<`/`(`/`{` rejections outside single quotes are untouched.

Also: one line added to `buildImplementorPrompt` telling the agent to
single-quote pattern/regex arguments and avoid `$`, backslashes, backticks and
parens outside single quotes — turning a turn-killing denial into a command it
writes correctly the first time.

### Regression proof (on `8b4b4ce`)

```
npx vitest run src/adapters/grok/command.test.ts
  -> pass 35 fail 4
```

The 4 are the single-quoted forms (the verbatim command from the dead turn, a
backslash escape, a `$` anchor, command-substitution TEXT). Single-quoted
parentheses already passed — the `(`/`{` check already sat AFTER the quote
branch; only `$`, `\` and the backtick were checked before it.

**Open questions for codex**

20. **Is "the classified string is the executed string" actually guaranteed?**
    The whole safety argument rests on the command being run by a POSIX shell
    with the quotes intact. If anything re-quotes, unescapes, or re-parses the
    operation title between classification and execution, single-quoted content
    could stop being inert. Worth confirming at the ACP permission boundary.
21. **Double-quoted `\` stays refused,** even though inside double quotes a
    backslash only escapes `` $ ` " \ `` and a newline. That is more conservative
    than POSIX requires. Deliberate — should it be relaxed too, or is the
    asymmetry the right posture?
22. **`grokShellPermissionTitle`'s `Execute \`…\`` wrapper** already excludes
    CR/LF and a backtick from the command, so the scanners' backtick and
    CR/LF branches are unreachable through THAT entry point. They are kept as
    defence for any future caller. Confirm no other caller bypasses the wrapper.

---

## Green bar

- `npm run typecheck` → exit 0
- `npx vitest run` (full, from this worktree) → **1767 passed, 0 failed**

Provisioning for this worktree was an APFS copy-on-write clone of the primary's
`node_modules` (`cp -c -R`); no `npm install`/`npm ci` was run anywhere, and the
primary checkout was never written to.
