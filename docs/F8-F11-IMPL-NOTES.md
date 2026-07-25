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

---

# Round 2 — codex NEEDS-FIX on `77ea93e`

Eleven findings. Per-finding fix, proof, and disputes below. Commit map:

| finding | commit |
| --- | --- |
| BLOCKER-1 | `3ae9c96` |
| BLOCKER-2 | `a03e782` |
| HIGH-5, MED-9 | `5e65168` |
| HIGH-3, HIGH-4, HIGH-6, MED-7, MED-8, LOW-10, LOW-11 | `df5b8d9` |

## BLOCKER-1 — a mixed-quote token laundered a redirection operator

`tokenizeShellSegment` set ONE `quoted` flag per token, and
`stripSafeRedirections` only looked for `>`/`<` on a NOT-quoted token. Tokens can
mix quoted and unquoted spans with no whitespace between them, so
`echo '$HOME'>owned.txt` became one token marked quoted and classified READ-ONLY
for a command sh executes as a WRITE.

Probe before the fix — broader than reported: `>`, `>>` and `2>owned` all
returned true. `<` escaped only by accident (the segment splitter rejects `<`
outside quotes; `>` was never in that list).

**The hole predates F11.** `echo 'x'>owned.txt` (no `$`) bypassed the pre-F11
classifier identically. F11 widened the reachable payloads; it did not create the
bug. Both shapes are asserted.

Fix: per-CHARACTER provenance. `ShellToken.unquotedRedirect` is set only by a
`>`/`<` seen outside quotes; a token is dropped as a safe null redirection only
when STRUCTURALLY standalone (entirely unquoted AND exactly allowlisted), and any
other token carrying the flag is refused. This mirrors the shell's own rule —
token recognition happens BEFORE quote removal.

Preserved and asserted: standalone `2>/dev/null` / `1>/dev/null` / `>/dev/null`;
`rg -n '>' src` (a quoted `>` is an argument); a quoted redirection-looking token
used as a FILENAME; and `echo x'2>/dev/null'`, which sh does not treat as a
redirection either.

Proof: `pass 48 fail 6` on `77ea93e` → 54/54.

## BLOCKER-2 — topology-as-authorization

Ancestry proves REACHABILITY, not AUTHORSHIP. Confirmed pre-fix: a foreign
descendant appended to the worktree was ADOPTED, and `taintsFor` came back empty
— `emergency_kill` cleared along with everything else.

Fixed exactly as directed:

- **(a) receipt is fatal.** `#writeVerifyHandoffCheckpoint` no longer swallows.
  An artifact-write throw AND a §12.1 quota rejection (no event) both raise the
  new typed `RoundReceiptError`. Tested via an `Err`-returning artifact store —
  the subtler branch, since it is a rejection rather than a throw.
- **(b) receipt-bound acceptance.** `acceptForwardContainment: boolean` became
  `acceptDriftToCommit?: GitSha`. Deliberately not a boolean: a boolean re-admits
  authorization-by-reachability. HEAD must EQUAL the receipt; ancestry remains
  only as a corroborating sanity check on top.
- **(c) taint clears only on receipt match.** Proven by planting
  `emergency_kill`, resuming without a receipt, and asserting BOTH
  `emergency_kill` and `reconcile_mismatch` survive.

New `resolveRoundReceiptHead(runId, round, assignment)` derives the receipt from
the LOG (latest `pre_verify_handoff` matching role+round+assignment), never a
mutable pointer, and rejects the empty-sha sentinel. `adoptWorktree` falls back
to the round-scoped `lastImplementationCommit`. Both are round-SCOPED — a
receipt from another round authorizes nothing (asserted).

**Consequence I am logging, not disputing:** the commit→receipt window is now a
REFUSAL rather than an acceptance. That is the intended trade (resume only what
we can prove we authored), and the window is milliseconds because publishing
happens immediately after `commitAll` and is fatal-on-failure. It does mean my
round-1 open question #3 (round scoping) is now answered structurally rather
than left open.

Proof: orchestrate-resume `pass 12 fail 5` on `3ae9c96` → 37/37 with validate.

## HIGH-5 — title vs rawInput

`decidePermission` only ever saw the human-readable TITLE. `allowReadOnlyOperation`
now takes `(operation, rawInput)` — REQUIRED, so no caller can classify without
the payload — and the session hands it `toolCall.rawInput`. New
`isGrokReadOnlyShellToolCall` is the authorization entry point the factory wires:
it recovers the command from `rawInput`, requires it BYTE-IDENTICAL to the
title's, and only then classifies. `isGrokReadOnlyShellPermissionTitle` stays as
the pure classifier so its suite keeps testing one thing.

Denies on: absent/null rawInput, non-object, array, missing or non-string
`command`, any divergence (including a trailing space). A matching rawInput never
rescues a non-read-only command. Also driven END-TO-END through the fake ACP wire
(the child now forwards a scenario's `rawInput`), not only as a unit.

## MED-9 — the outer title regex

`/^Execute \`([^\`\r\n]+)\`$/` forbade a backtick anywhere in the interior, so a
literal backtick inside single quotes could never classify. Replaced with a
structural prefix/suffix parse taking the first prefix and last suffix, so inner
backticks are unambiguous. The scanners still reject an UNQUOTED backtick and all
control bytes; the wrapper still requires the exact verb, a non-empty interior,
and no CR/LF.

**Logged asymmetry:** `grokShellPermissionTitle` (the allowlist BUILDER) still
refuses backticks in a declared verification command. That is an input
restriction on SPEC content, not a classification bug — and it means a
backtick-bearing title can only arrive from the provider, which is exactly the
path MED-9 opens to classification. Say the word if you want the builder relaxed
too.

## HIGH-3 — legacy marker short-circuit

v1 markers recorded only the fingerprint, so an install-lane tree carried a
matching marker and skipped the smoke — P2 surviving the upgrade. Marker proof
format is now versioned; only v2 (fingerprint + smoke attestation)
short-circuits. A v1 marker re-proves the tree IN PLACE (no rebuild) and upgrades
on success, or refuses `native_toolchain_unproven`.

## HIGH-4 — the native filter

A package with a `binding.gyp` and NO `scripts` object still gets an implicit
`node-gyp rebuild` from npm; the filter required a scripts object first and
returned early. `binding.gyp` is now decisive on its own, checked BEFORE any
script lookup. The walk recurses nested `node_modules` and names a nested package
by its NESTED specifier — requiring bare `b` would resolve the hoisted copy and
prove the wrong artifact.

This also answers round-1 open question #13 (transitive natives) in the
affirmative for the smoke. `proveePrimaryTree` still checks only root-declared
names; the smoke is what covers transitive natives.

## HIGH-6 — withDeadline cannot cancel

Confirmed (it was my own #18). `withDeadline` stops WAITING; the producer keeps
running. A timed-out stage is now QUARANTINED — atomic same-filesystem rename to
`quarantine-*`, out of the active namespace — and never force-deleted; a failed
rename leaves it in place, still safer than racing an unknown writer. Proven with
a producer that writes into the stage AFTER the deadline fires.

**Partial against the directive.** The prescription's first choice was threading
AbortSignal/kill handles through `runtime.install`/`cloneDir`/`runGit` and
awaiting confirmed termination. I implemented the stated fallback (quarantine)
rather than that, because `ProvisionRuntime` is an INJECTED seam: the harness
cannot make an arbitrary implementation abortable, and awaiting "confirmed
termination" of a seam that never settles is exactly the unbounded wait the
deadline exists to escape. The default runtime's own `execFile` calls DO carry
`timeout`, so the real `cp`/`npm` children are killed; quarantine covers the
injected-seam case the kill cannot reach. Flagging explicitly for your call.

## MED-7 — dropped cause at the verifier boundary

`toProvisioningFailure` now copies `provisioningCause`, so the same failure no
longer prints two different next steps depending on which boundary raised it.

## MED-8 — untyped refusal + magic pathspec + a test that never reached it

Two real defects, both confirmed against real git:

- the targeted reset used raw pathspecs, so `:(top)foo/node_modules` was parsed
  as pathspec MAGIC — the reset matched nothing, exited 0, and left node_modules
  STAGED. Every pathspec is now `:(literal)`-prefixed.
- the refusal was `git_command_failed`, which is wrong (no git command failed).
  New kind `node_modules_still_staged`, raised by a new exported
  `assertIndexFreeOfNodeModules` so the invariant is checkable on its own.

The old test never reached the branch (a stale `index.lock` made `git add` throw
first). Replaced by: a magic-pathspec test (the shape that genuinely reached the
branch pre-fix), a test driving the guard directly, and a no-op-reset case that
makes the second index read load-bearing.

## LOW-10 / LOW-11

LOW-10: both new F8 blocks run under `describe.each(await availableDriverKinds())`
with the driver threaded through `setup()`/`openRig()`. Only one driver is
available in this environment, so the fan-out is 1 here; it widens automatically
elsewhere.

LOW-11: the F11 guidance is asserted as a LINE located by its own content — never
whole-prompt text or position — so an unrelated prompt rebase cannot break it,
and the assertion pins that it stays scoped to repository INSPECTION. The line
was reworded to "When inspecting the repository with the shell…".

## Round-2 regression proofs

| suite | pre-fix | post-fix |
| --- | --- | --- |
| `grok/command.test.ts` (BLOCKER-1) | pass 48 fail 6 | 54/54 |
| `orchestrate-resume.test.ts` (BLOCKER-2) | pass 12 fail 5 | 37/37 with validate |
| `provision.test.ts` (HIGH-3/4/6) | pass 71 fail 7 | 78/78 |
| `git.test.ts` (MED-8) | pass 11 fail 3 | 14/14 |

Pre-fix runs were done by stashing ONLY the source files and keeping the tests.

## Round-2 open questions

23. **HIGH-6 shape** — quarantine instead of true cancellation, for the reason
    above. Accept, or do you want `ProvisionRuntime` to grow a mandatory
    `AbortSignal` parameter (a breaking seam change affecting every test fake)?
24. **BLOCKER-2 fatal receipt** — a round that commits but cannot record its
    receipt now fails and is not auto-resumable. The commit is durable and an
    operator can recover, but this converts an artifact-store hiccup into a
    stopped run. Confirm that is the intended severity.
25. **MED-9 builder asymmetry** — should `grokShellPermissionTitle` also accept
    backticks, or is refusing them in spec-declared commands correct?
26. **BLOCKER-1 residue** — `stripSafeRedirections` retains one branch that is
    unreachable while every allowlisted null redirection contains `>`. Kept so
    the "entirely unquoted, exactly allowlisted" reading stays true if the
    allowlist ever gains a redirection-free entry. Delete instead?

---

---

# Round 4 — codex round-3 verdict on `37c04a6`

11 → 3 surviving, 8 confirmed. Commit map:

| finding | commit |
| --- | --- |
| HIGH-5, Q26 | `346474f` |
| HIGH-4, HIGH-6 | `af8d5f8` |
| merge-time prompt defect | `46ac978` |

All three survivors reproduced exactly as reported before being fixed.

## HIGH-5 — the binding was in the wrong place

Confirmed: `decidePermission` checks the exact allowlist BEFORE the read-only
classifier, and the binding lived INSIDE the classifier. So an allowlisted title
was approved with a missing or hostile payload and the binding never ran at all.
The factory test asserting `Execute \`npm run typecheck\`` → `allow/allowlisted`
with no rawInput was encoding the bug.

The fix moves the binding OUT of the classifier and makes it a VETO
(`verifyOperationPayload`) evaluated once and applied at every `allow` site
through a single `approve()` helper — allowlist, read-only classifier, and
workspace-write — so a future approval path cannot be added that forgets it. A
throw from the veto is a refusal. `allowReadOnlyOperation` reverts to the pure
title classifier.

I did **not** lean on the permissions track emptying the implementor allowlist,
per your note: the veto is unconditional, so the verifier's exact per-criterion
allowlisted commands are covered by the same gate.

Non-shell titles (`Write`/`Edit`) return true from the veto — there is no shell
payload to bind, and the workspace-write rule adjudicates those on the path
itself. Asserted, so the veto can never deny them for lacking a command.

## HIGH-6 — the quarantine trade was wrong, and your mechanism was right

Every step of the rejection checked out: the deadline catch deleted `dst` before
rethrowing (so the producer recreated it), renaming the parent cannot redirect a
writer holding the original pathname, and GC swept `quarantine-*` indiscriminately.
My round-3 test released the producer without asserting where its writes went,
which is exactly why none of that showed up.

Reworked to the directed shape: **delete and move nothing.** The stage is MARKED
in place (`.harness-quarantined`, carrying the owning pid and timestamp) and GC
skips it until a 24h TTL expires; an unreadable or malformed marker is treated as
LIVE. Since the writer cannot be redirected, leaving the tree where it expects it
is the only sound option. Stage names are already unique per attempt (`mkdtemp`),
so a recreated `stage-*` is always that attempt's own directory.

**Where the released producer's writes land** — now asserted, as requested:
`path.dirname(producerDst)` equals the marked stage directory, and
`late-write.txt` is readable there after the refusal. Not a resurrected copy
beside it, not a renamed one. The test also drives a SUBSEQUENT provisioning
attempt on the same assignment namespace: it succeeds on its own fresh stage, and
its GC pass leaves both the quarantine marker and the producer's bytes intact.

## HIGH-4 — silent truncation

Confirmed at `provision.ts:1296`: `if (depth > 8) return;`. A native package
below the cap was never smoked, yet the tree still got a v2 smoke-attested marker
— unexamined stamped proven, sticky thereafter. Now fails closed
(`native_toolchain_unproven`, naming the limit and the path), with the cap raised
to 16 levels.

## Merge-time prompt defect

Fixed on-branch, not at merge. The granting clause ("and the exact declared
verification commands below") is removed; shell is read-only inspection only.

The coherence assertion is written to hold on **both sides** of the rebase, since
main's prohibition is not on this branch: at most ONE Hard Rule may speak about
executing verification commands, and NO rule may GRANT it in any wording. This
branch has zero, main adds one prohibition, the merge must never have two or a
grant.

Proof it bites: simulating the contradictory merged state (restoring the clause
AND adding main's prohibition) fails with `expected 2 to be less than or equal
to 1`.

## Round-4 regression proofs

| suite | pre-fix | post-fix |
| --- | --- | --- |
| `session.test.ts` + `factory.test.ts` (HIGH-5) | pass 68 fail 5 | 446/446 adapters |
| `provision.test.ts` (HIGH-4, HIGH-6) | pass 77 fail 2 | 79/79 |
| prompt coherence | fails on simulated merge | passes on branch |

Pre-fix runs stashed ONLY the source files and kept the tests.

## Adjudications recorded

- **Q23** → superseded by HIGH-6 above; the quarantine trade is withdrawn.
- **Q24** → accepted as-is; fatal receipt publication stands. A durable
  receipt-retry path is noted as a later option, not built.
- **Q25** → confirmed; `grokShellPermissionTitle` keeps refusing backticks.
- **Q26** → applied; the unreachable strip branch is deleted so a future
  redirection-free allowlist member cannot be stripped as a redirection.

---

---

# Round 5 — codex round-4 verdict on `6bd6693`

Six findings, all narrow edges of the three survivors. Commit map:

| finding | commit |
| --- | --- |
| HIGH-5 #1, HIGH-5 #2 | `ba39f4a` |
| HIGH-4 #3, HIGH-6 #4/#5/#6, MED-6 | `2263c9a` |

All six reproduced before being fixed. Nothing else was touched.

## HIGH-5 — two reachable bypasses

**#1 interactive.** Confirmed: the interactive branch returned before the veto,
so a configured handler or `resolvePermission` could forward a `selected` option
for an unbound payload. The veto now runs before ANY mediation branch and returns
its denial directly.

This forced a type move: `verifyOperationPayload` lived on
`HeadlessPermissionPolicy`, and the interactive config variant has no `policy`
field at all. It now sits on the config ROOT (exported `VerifyOperationPayload`),
which is also the honest place for it — the binding is not an allowlist concern
but a precondition of any approval.

`PermissionRequest` now carries `rawInput`, so an interactive decider sees what
will execute rather than the prose describing it. Asserted on both the
divergent-payload and absent-payload requests.

**#2 vacuous validity.** Confirmed: "non-shell" was inferred from untrusted title
SYNTAX, so a malformed exact-allowlisted shell title, or a `Write` title carrying
`{command: …}`, bound nothing. The default is inverted — an unparseable title is
non-shell ONLY when the payload also carries no command. `operation` is
`string | undefined` end-to-end so an absent title reaches the same judgement.

Side effect asserted rather than hidden: the factory scenario's
`Execute \`mkdir -p src/app/commands\`` turn (sent with no rawInput) is now
refused as `denied_raw_input_mismatch` — caught by the veto before the read-only
classifier runs, a strictly earlier denial than the previous `denied_default`.

## HIGH-4 #3 — swallowed scan errors

Confirmed at the `@scope` `continue`. Audited the whole scan; every "could not
examine" path is now fail-closed, naming the path: unreadable scope directory,
unreadable manifest (only genuine ENOENT/ENOTDIR is a skip), and malformed
manifest (matching `parsePackageJson`'s existing B3 posture).

**Honest scope note:** for an unreadable DIRECTORY the symlink containment scan
(B6) refuses first, since it walks directories too. So the native scan's own
enumeration guard is defence-in-depth for the race where a directory becomes
unreadable between the two walks. The MANIFEST cases are the reachable ones, and
those are what the tests drive.

## HIGH-6 #4/#5/#6 — the quarantine was dishonest in three ways

All three confirmed and fixed:

- **#4** a failed marker write still emitted `stage_quarantined`. It now emits
  `stage_quarantine_failed` with the reason and claims nothing.
- **#5** a marker READ error was classified "ordinary stage", so the next sweep
  deleted it — the exact opposite of the rule I had documented. Only genuine
  ENOENT/ENOTDIR means "no marker" now.
- **#6** post-TTL deletion ran on timestamp alone. GC now consults a §14 owner
  probe (`QuarantineOwnerProbe`: recorded `ownerPid` + `ownerStartedAt`
  start-time identity, built on `createPsClient` exactly as the advisory lease
  does). A live owner EXTENDS the quarantine; only a proven-gone or recycled
  owner releases it, and a probe that throws is not a proof of death.

**MED-6** — malformed markers are no longer protected forever: with no usable
timestamp the stage's own mtime is the fallback clock, so they expire like any
other once the owner is gone.

### Documented residual (per your instruction to say so honestly)

Bounded retention is only as good as the sweeps that run. Quarantine GC runs from
two places: `provisionWorktreeDeps`'s per-assignment preflight, and
`gcProvisionStages` (called by `removeWorktree`, which has **no production
callers**). So:

- repeated timeouts on an assignment that KEEPS provisioning are bounded — each
  new attempt sweeps the previous stages once their owners die;
- an assignment that times out and then never provisions again retains its
  quarantined stage until something calls `gcProvisionStages`.

Fully closing that needs a GC entry point that does not exist yet (a startup or
periodic sweep across `.provision`). I did not invent one — it is outside this
round's six findings and would be untested surface. **Residual, not a blocker.**

### Found while proving #3

The `finally`'s stage cleanup could THROW and thereby MASK the outcome: `rmSync`
over a tree containing an unreadable directory replaced a precise cause-coded
refusal with a bare EACCES. That is the same swallowed/misreported-error family
this round is about, so it is fixed here — cleanup failure is swallowed, the
refusal is what the caller sees.

## Round-5 regression proofs

| suite | pre-fix | post-fix |
| --- | --- | --- |
| `session.test.ts` + `grok/command.test.ts` (HIGH-5) | pass 113 fail 2 | 448/448 adapters |
| `provision.test.ts` (HIGH-4 #3, HIGH-6, MED-6) | pass 79 fail 7 | 86/86 |

Pre-fix runs stashed ONLY the source files and kept the tests.

**Not started, as directed:** F13 (role-independent stop-reason adjudication,
host-attested evidence receipts).

---

---

# Round 6 — codex round-5 verdict on `fbbc670`

Three confirmed, one residual explicitly accepted, four to fix. Commit map:

| finding | commit |
| --- | --- |
| Finding 1 (veto universality), Finding 2 (positive kind) | `88d48ad` |
| Finding 3 (masking sweep), Finding 4 (JSON cause) | `c11b982` |

## The pattern, and how I broke it

The diagnosis was right and worth restating: three rounds, three fixes, each at
the layer the previous finding named.

| round | where the veto was | what remained |
| --- | --- | --- |
| R4 | inside `allowReadOnlyOperation` | the exact-allowlist match ran first |
| R5 | on `HeadlessPermissionPolicy` → moved to the config root | the FACTORY installed it only for `implementor` + `headless` |
| R6 | — | (this round) |

Each fix was correct and each left a different layer uncovered, because I was
fixing *instances* of "the veto did not run here" rather than establishing "the
veto always runs". So this round does not add a fourth placement — it makes the
property unforgeable.

**How veto-universality is now structural, not another point fix:**

1. **It cannot be omitted without failing to compile.**
   `src/adapters/grok/permissions.ts` defines
   `VetoedMediation = PermissionMediationConfig & { verifyOperationPayload: VerifyOperationPayload }`
   — REQUIRED, not optional. A plain `PermissionMediationConfig` is not
   assignable to it. The factory's local is typed `VetoedMediation`, so a future
   construction path that forgets the veto is a type error, not a production
   fail-open. This is the "non-optional constructor parameter" option, scoped to
   Grok (where the property lives) rather than churning every unrelated
   `PermissionMediationConfig` construction site in the repo.
2. **There is exactly one producer, and it cannot branch past the veto.**
   `buildGrokMediation` stamps `verifyOperationPayload` UNCONDITIONALLY, on the
   final return, outside every role/mode branch. Role-specific shaping happens on
   the way in. It also always returns a config (defaulting to
   headless/default-deny) so there is no "no config, therefore no veto" path.
3. **The paths are enumerated by test.** `permissions.test.ts` walks 4 roles x 5
   caller-supplied mediation shapes (absent / headless / headless+allowlist /
   interactive / interactive+handler) and asserts each result carries a WORKING
   veto and denies an exactly-allowlisted title with a hostile payload. A new
   path shows up as a missing case.
4. **The wiring itself is tested end-to-end.** A factory-level test drives a real
   INTERACTIVE Grok session whose handler approves anything it is shown — so the
   only thing that can refuse is the veto. Pre-fix that test fails; it is the
   direct discriminator for Finding 1.

## Finding 2 — non-shell recognised positively

Confirmed: an unparseable title with an absent/malformed payload returned true,
because "non-shell" was CONCLUDED from two failed parses. For a fail-closed gate
that is backwards — inability to understand something is not evidence of its
safety.

`classifyGrokOperation` now determines kind AFFIRMATIVELY:

- `shell` — a parsed Execute-backtick title; requires a byte-identical
  `rawInput.command`.
- `structured_file` — a parsed `Write`/`Edit` title AND a payload carrying no
  `command`. Matching mirrors `isWorkspaceWriteOperation`'s own shape so the two
  rules cannot disagree about what a structured file operation looks like.
- `unknown` — everything else, REFUSED.

So `Execute ls` with no rawInput, a `Write` title smuggling `{command: …}`, and a
malformed `{command: {nested}}` payload are all refused.

## Finding 3 — the masking sweep

Both named sites fixed: `probe.self()` was called outside `quarantineStage`'s
try (and that function runs from the timeout `finally`, so a `ps` failure would
have replaced the refusal); and the clone-failure catch did an unguarded
`rmSync(dst)` before rethrowing.

**Did I find others?** I swept every changed file for fs mutations reachable
inside a `catch`/`finally` — a script walking brace depth across `provision.ts`,
`git.ts`, `validate.ts`, `manager.ts`, `acp/session.ts`, `service.ts`,
`implementor.ts`, `orchestrate.ts`. **No further in-handler cases.**

One ADJACENT case fixed on the same rule, found by reading rather than by the
sweep (it is on a success path, not in a handler): `swapIntoPlace` deleted the
moved-aside backup AFTER the swap had already succeeded, unguarded — so a
cleanup failure would have turned a completed provisioning into a spurious
"could not swap into place" refusal. Same principle, opposite direction: cleanup
must not manufacture a failure any more than it may mask one.

## Finding 4 — cause in the JSON

The projection is extracted as `provisioningFailureView`, sibling of the file's
existing `mergeReadinessView`, so the stable payload is asserted directly rather
than through a full loop run. It carries `cause`.

## Finding 5 — retention residual

Accepted as non-blocking. **Not touched.**

## Round-6 regression proofs

| suite | pre-fix | post-fix |
| --- | --- | --- |
| `factory.test.ts` + `grok/command.test.ts` + `cli/commands.test.ts` | pass 123 fail 4 | see below |

The 4 pre-fix failures are exactly one per finding: the interactive-veto wiring
(F1), the two JSON-cause assertions (F4), and the unparseable-title refusal (F2).
Finding 3's guards are defence-in-depth against a secondary throw and are covered
by the sweep plus the round-5 masking test.

**Not started, as directed:** F13.

---

## Green bar

- `npm run typecheck` → exit 0
- `npx vitest run` (full, from this worktree) → **1881 passed, 0 failed**, 106 files

Provisioning for this worktree was an APFS copy-on-write clone of the primary's
`node_modules` (`cp -c -R`); no `npm install`/`npm ci` was run anywhere, and the
primary checkout was never written to.
