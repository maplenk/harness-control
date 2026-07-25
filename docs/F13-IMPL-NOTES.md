# F13 implementation notes

Date: 2026-07-25  
Worktree: `/Users/tagtaste/Documents/QBApps/harness-f13`  
Branch: `f13-attested-verification`  
Parent/unchanged HEAD: `7e4b1ff91262129cade6f500931accf5e17edd77`

## Repository constraint

The worktree is writable, but its `.git` file points at
`/Users/tagtaste/Documents/QBApps/harness-orchestration/.git/worktrees/harness-f13`.
That directory is outside the writable roots and is also explicitly forbidden
by the task. The first intended test commit therefore failed before staging
anything:

```text
fatal: Unable to create '/Users/tagtaste/Documents/QBApps/harness-orchestration/.git/worktrees/harness-f13/index.lock': Operation not permitted
```

No attempt was made to bypass that boundary. Consequently the source changes
below were present in the worktree but uncommitted at the time of writing.

> **Superseded 2026-07-25.** The work was subsequently committed on codex's
> behalf from a context that could write the worktree's git metadata, as
> `49c7e18` and `be5cc49`. HEAD is no longer the parent SHA; the paragraph
> above describes only the original authoring sandbox.

Intended commit sequence:

1. `test(f13): prove discarded host verification can false-positive`
2. `fix(f13): make implementor host verification load-bearing`
3. `test(f13): require bound per-command evidence receipts`
4. `fix(f13): execute and enforce host evidence receipts`
5. `test(f13): prove abnormal verifier stop can false-positive`
6. `fix(f13): adjudicate every role turn at the shared wrapper`
7. `test(f13): prove same-harness verification is accepted`
8. `fix(f13): enforce and audit cross-vendor verification`

## Defect 1 — host-attested evidence

### Fails-on-parent proof

Step 1 was tested before wiring `verificationPassed`:

```text
$ rtk npx vitest run src/app/flows/verifier.test.ts -t "fabricated verifier prose with no passing host execution cannot reach merge_ready"
Test Files  1 failed (1)
Tests       1 failed | 36 skipped (37)
AssertionError: expected false to be true
```

The unfixed engine set `mergeReadiness.requiredTestsPassed` to `true` from the
model's fabricated prose even though host verification had not passed.

After step 1 was implemented and proved green, the receipt regression was added
before step 2:

```text
$ rtk npx vitest run src/app/flows/verifier.test.ts -t "a passing transitional host boolean without per-command receipts is unproven"
Test Files  1 failed (1)
Tests       1 failed | 37 skipped (38)
```

The transitional boolean alone still admitted the model's `passed` result;
the expected `unproven` host-receipt note was absent.

### Implementation

- `src/app/flows/implementor.ts:61` and `:715` now describe the field's real
  load-bearing behavior rather than claiming an inert invariant.
- `src/app/projections.ts:308` persists the host result with its exact
  implementation round and commit.
- `src/app/flows/orchestrate.ts:613-720` carries the fresh host result, while
  `:1071-1099` reuses it on resume only for an exact round/commit match.
  Missing and legacy state fail closed.
- `src/app/flows/verifier.ts:1410` and `:1493` make the host result part of the
  readiness calculation.
- `src/domain/entities.ts:253` defines the immutable `EvidenceReceipt`.
- `src/app/flows/verifier.ts:157-223` executes every declared command after
  provisioning at the verifier boundary, redacts stdout/stderr, stores both
  outputs and the receipt body through the quota-aware evidence sink, and
  records argv, cwd, exit code, run/spec/commit binding, timestamps, digest,
  and toolchain/provisioning data.
- `src/app/flows/verifier.ts:679-729` enforces one unique, zero-exit, current
  receipt per declared command. The receipt must match run, spec, commit, cwd,
  and argv. Model narrative cannot override a missing, failed, or stale host
  receipt.
- `src/app/flows/orchestrate.ts:800-889` executes receipts only after
  provisioning succeeds and passes them to the verifier prompt and gate.
- `src/domain/entities.ts:330` and `src/cli/commands.ts:1175` surface receipt
  references in merge-readiness.
- `src/app/flows/verifier.test.ts:341` asserts redaction, CAS readability, and
  quota accounting through every `availableDriverKinds()` SQLite driver.

### Failed receipt judgment

A non-zero exit or host launch failure maps to `unproven`, not `failed`.
Exit code alone cannot distinguish an implementation defect from a broken
toolchain, missing service, transient resource failure, or other environment
problem. The host receipt proves what was executed and observed; the model
judges criterion satisfaction, but it cannot turn absent execution proof into
a pass. Marking the implementation `failed` from exit code alone would claim a
causal diagnosis the host does not possess.

On verifier resume the engine re-executes commands at the post-provisioning
boundary. Prior model evidence is carried only when the newly produced current
receipt gate holds; a prior-commit receipt is never accepted as current.

## Defect 2 — role-independent stop adjudication

### Fails-on-parent proof

```text
$ rtk npx vitest run src/app/flows/verifier.test.ts -t "voids a complete passing verifier report when the turn stops with refusal"
Test Files  1 failed (1)
Tests       1 failed | 44 skipped (45)
AssertionError: expected 'all_verified' to be 'blocked'
```

The report was complete, parseable, and passing, but the turn ended in
`refusal`; the unfixed wrapper still allowed `all_verified`.

### Implementation

- `src/app/role-runner.ts:65-113` defines the one shared adjudication point.
  Only `end_turn` produces `kind:'completed'`; all other stop reasons produce
  `kind:'aborted'` with role policy `retry`, `no_deliverable`, or
  `void_verification`.
- `src/app/service.ts:2785-2871` marks fresh versus resumed turn origin, and
  `:5591-5609` applies the shared wrapper before cadence or a completed turn
  can be recorded.
- `src/app/service.ts:3430-3455` closes abnormal turns without cadence and
  persists `no_deliverable` only for implementors.
- `src/app/flows/coordinator.ts:430-449` and `:477-494` discard partial aborted
  drafts and retry within the existing bounded rounds.
- `src/app/flows/verifier.ts:557-578` discards the entire aborted verifier
  payload. Every criterion, including any reported before the abort, becomes
  `unproven` with an empty evidence set and a note naming the stop reason.
- `src/domain/events.ts:672-690` records non-cancel abnormal turn closure as
  `outcome:'aborted'`.
- `src/app/role-runner.test.ts:11-59` is the required 30-cell matrix:
  five stop reasons × three roles × fresh/resumed.

The focused matrix plus live refusal regression passed:

```text
Test Files  2 passed (2)
Tests       31 passed | 44 skipped (75)
```

## Defect 3 — cross-vendor independence

### Fails-on-parent proof

```text
$ rtk npx vitest run src/app/flows/vertical-slice.test.ts -t "refuses same-harness implementor/verifier profiles by default"
Test Files  1 failed (1)
Tests       1 failed | 27 skipped (28)
AssertionError: expected undefined to match object { code: "independence_violation", ... }
```

The same-harness Codex implementor/verifier run completed without any error on
the unfixed engine.

### Implementation

- `src/app/model-resolution.ts:128-222` resolves both role profiles together,
  throws typed `independence_violation` with both resolved profiles on harness
  equality, and produces explicit warnings for opted-out same-harness and
  same-model operation.
- `src/config/schema.ts:336` adds
  `verification.allowSameHarness`, default `false`.
- `src/app/flows/orchestrate.ts:469-480` refuses an invalid initial pair before
  run ownership, worktree creation, or role allocation. `:821-845` repeats the
  check against the effective failover profiles at the verifier boundary.
- `src/domain/entities.ts:308-321` adds the resolved harness pair to
  `MergeReadiness`; `src/cli/commands.ts:1169` exposes it in the report.
- `src/cli/commands.ts:2458-2475` preserves the typed error code and both
  profiles in JSON error output.
- `src/app/flows/vertical-slice.test.ts:499-552` proves the explicit opt-out
  acts, same-model use warns rather than refuses, and the resulting report
  records the same-harness audit pair.
- `src/app/flows/vertical-slice.test.ts:613` proves the normal cross-vendor
  happy path records `{implementor:'codex', verifier:'claude'}`.

---

# Merge with main (F8–F11), 2026-07-25

F13 was built off `7e4b1ff`. Main advanced to `a77f3da` (itself the F8–F11
merge), so this branch merges `a77f3da` in rather than rebasing — matching the
precedent main set for its own track. Three files conflicted; all four hunks
were resolved semantically, keeping BOTH sides.

## The conflicts, and why each resolved the way it did

**1. `src/app/role-runner.ts` — `RoleSession`.** A pure additive collision: F13
changed `prompt()`'s return type from `PromptResult` to `RoleTurnResult` (its
adjudicated turn), and F8 appended `checkpointVerifyHandoff()` immediately
after it. Neither touches the other's meaning. Kept F13's signature and F8's
method with its full doc comment, including the BLOCKER-2 note that the write
is fatal.

**2. `src/app/service.ts` — imports.** F13 widened the `role-runner.js` import
to bring in `adjudicateRoleTurn`, `AbortedRoleTurn` and `RoleTurnOrigin`; F8
added `noPayloadToVerify` from the ACP session module on the adjacent line.
Kept both.

**3 and 4. `src/app/flows/orchestrate.ts` — the verifier's binding.** Both
hunks are the same collision in two places (the live implementor path and the
completed-implementor resume path), and this is the one place the two tracks
genuinely interact rather than merely colliding.

F13 added a line reading the round's host verification result. F8 had, in the
same statement, *removed* the `git.resolveSha(...)` re-read of mutable HEAD
that F13's side still contained — its ROUND 9 Blocker 1 and ROUND 8 Blocker 1b
both established that re-reading HEAD after adjudication discards the very
guarantee just proven, because a commit landing in the gap becomes the binding.

F8's binding wins in both hunks: `adjudicatedHead ?? …` on the live path,
`adoptedBinding ?? …` on the resume path. F13's host-result carry survives on
top, and is now **keyed on that binding**.

That ordering is not cosmetic. `recordImplementationCommit` persists
`{round, commit, verificationPassed}`, and `persistedHostVerificationPassed`
re-accepts the host result only on an exact round + commit match. Under F13
alone, the key was a re-read HEAD, which could drift from what was recorded —
failing closed, but non-deterministically. Under the merge, the key on both the
write and the read is F8's receipt-proven commit, which F8 guarantees equals
the round's `pre_verify_handoff` receipt or the round hard-errors. **The merge
makes F13's carry-over deterministic rather than merely fail-closed** — the two
mechanisms reinforce each other, and a reviewer should read those two hunks
together.

## Where F8 and F13 genuinely interact — read this closely

F8's BLOCKER-1 guard (`adjudicateImplementorDeliverable` refusing when the
worktree HEAD disagrees with the round's receipt) was built for one concrete
vector: **a declared verification command that COMMITS**, which used to run
inside the implementor round, in the window between the receipt and
adjudication, and silently rebind the verifier.

The double-execution fix below moves declared-command execution out of that
window entirely. F8's guard is NOT dead — it still refuses any HEAD movement
between the receipt and adjudication, whatever the cause — but *its motivating
vector moved*. The commands now run at the verify boundary, against an
already-bound commit, where adjudication has already happened and cannot see
them.

So the same invariant is now enforced at the new location:
`executeEvidenceReceiptsUnderConfinement` records the worktree HEAD before the
receipts run and refuses if it moved, with the detail "verification commands
must observe the bound implementation commit, never author one" — F8's rule,
restated where the commands live now. F8's own test keeps proving the
adjudicator by mutating through the provisioning seam, which still sits in the
receipt→adjudication window.

## The double-execution fix (reviewer Medium finding)

**Before, measured on the happy path** (`vertical-slice.test.ts`, spec with two
criteria declaring one command each), counting invocations of the injected host
runner:

```text
{ total: 4, ac1: 2, ac2: 2 }
```

Each declared command ran twice: once at the implementor boundary
(`implementor.ts`, via `resolveVerificationCommands`, deduped across criteria)
and once at the verify boundary (`executeEvidenceReceipts`, per criterion).

**After:**

```text
{ total: 2, ac1: 1, ac2: 1 }
```

The receipts are now the sole and authoritative command proof — they are
post-provisioning, commit-bound, spec-bound and argv-bound, and they are the
only execution that exists on the paths the implementor round never reaches
(forced verifier re-entry, verify-only resume). The implementor boundary no
longer runs the commands at all.

Two signals were produced *by* that duplicate execution, and both moved with
it rather than being left behind as inert checks — leaving either in place
while production stopped exercising it is precisely the "safety-critical field
documented as load-bearing and inert" defect F13 was written to kill:

- **W3-1 primary-checkout confinement** now wraps the receipts. The guard has
  to observe the commands it confines. All six escape vectors (out-of-worktree
  write, primary HEAD move, planted `.git/hooks/pre-commit`, mutated
  `.git/config`, new gitignored file, worktree-cwd reach into the shared common
  dir) moved with it and are asserted against
  `executeEvidenceReceiptsUnderConfinement`.
- **F8's authorship rule** is the worktree-HEAD check described above.

What the implementor boundary still uniquely produces, and still gates on, is
`provisioningFailed`. `ImplementorResult.verificationPassed` now means exactly
"the host preconditions this boundary can attest hold", and the §16 gate
requires both it and a current zero-exit receipt per declared command
(`#hostReceiptIssue`), so nothing about F13's Defect 1 is weakened: fabricated
prose still cannot reach `merge_ready`, because the receipt gate is what
enforces that and it is untouched.

Removed as newly-dead rather than left inert: `ImplementorFlowOptions.runVerification`
(no production consumer once the boundary stopped executing) and
`ImplementorResult.runnerViolation` (no producer). `buildImplementorOptions` no
longer forwards the runner to the implementor.

### Test relocations, stated plainly

- The six W3-1 tests moved from driving `ImplementorFlow` to driving
  `executeEvidenceReceiptsUnderConfinement`; one new test covers the
  commit-authoring vector there.
- `vertical-slice.test.ts`'s verifier-boundary independence test used the
  implementor-boundary command as its injection hook to flip the verifier's
  durable desired model mid-round. That hook now fires *after* the boundary
  check, so the test was re-pointed at a new `onAdapterCreated` seam in the
  slice factory, which fires as the implementor adapter is created — after loop
  entry, before verifier dispatch. Confirmed it still discriminates: it fails
  when the boundary re-check is the only thing standing between the flip and a
  report claiming independent verification.
- W1-F4's unit-level form (a command dirtying the tree at the implementor
  boundary) is no longer reachable and was replaced by an assertion that the
  round hands over a clean tree. The property itself is still proven
  end-to-end by "a mutating verification command never yields merge_ready",
  where the §16 readiness probe — which runs after the receipts — catches the
  dirt and names the file.

## Round 2 — codex adversarial review of the merge (`07d4af0`): 3 blockers

The F13 side, the once-per-round execution, and all three claimed interactions
were confirmed. Three merge-blocking findings, all in code this merge
introduced, all fixed regression-first.

### BLOCKER 1 — detection was preserved, SEVERITY was not

I correctly saw that F8's command-authorship vector had moved past
adjudication, and added a worktree-HEAD check. But I reported it as an ordinary
`runnerViolation`, which means blocked verification — and the loop then advances
into another same-process implementation round with **no `discardToCommit`**.
That round's commit descends from the command-authored commit, making it an
ancestor of the delivered work: exactly the laundering F8 spent a full round
refusing, downgraded to a soft signal.

On main this threw `NoDeliverableError` immediately. The fix restores that
severity at the new boundary. `executeEvidenceReceiptsUnderConfinement` now
reports `authoredCommit` separately from `runnerViolation`, and the loop raises
the new typed `VerificationAuthoredCommitError` — after the durable incident is
recorded, so the audit trail survives the throw. No remediation path is kept, so
the "must `discardToCommit` first" alternative does not arise.

**The severity split is the point** and is asserted in both directions: a
primary-checkout escape carries no `authoredCommit` and stays a blocking
violation; only an authored commit hard-stops. Conflating them is what caused
this.

The hard stop is deliberately a direct HEAD comparison, **not** a §16 readiness
probe result: that probe only runs on the all-verified path, so it would not
fire for a round that is already failing.

Regression (`vertical-slice.test.ts`): asserts the loop throws
`VerificationAuthoredCommitError`, that exactly ONE implementor ran, that HEAD
still equals the authored commit (nothing descended from it), and that the
incident was recorded anyway. Proven to discriminate by flipping the assertions
to the pre-fix expectations (run continues, two implementors, HEAD advanced) and
confirming they fail.

### BLOCKER 2 — a CAS failure could mask a confinement violation

The commands run BEFORE the three evidence writes (stdout, stderr, receipt
body). A §12.1 quota rejection or CAS failure threw straight past drift
detection, so a primary-checkout mutation the command had **already made** went
unrecorded, and a later retry would baseline the mutated checkout. This is the
masking family F8 spent four rounds on, reappearing at the boundary this merge
created.

Fixed by capturing the execution error instead of propagating it: both guards
now always run, and the caller records any violation FIRST, then fails the round
on the original cause. Regression drives an evidence recorder that throws while
the runner escapes into the primary, and asserts the violation still surfaces
and the original error is reported rather than swallowed.

### BLOCKER 3 — a superseded provisioning failure outlived its attempt

A round whose first provisioning attempt failed persisted
`verificationPassed:false`. On resume — with the unconditional verify-boundary
provisioning succeeding AND current receipts passing — that stale negative still
forced every command-bearing criterion to `unproven`. A negative about a
superseded attempt is not evidence about the current one; this is the
indeterminate-becomes-refusal class, in F13's territory.

Fixed at the root rather than by re-scoping the lookup: **the persisted record
no longer carries a host verdict at all.** `hostVerificationPassed` is now
derived where the truth is, immediately after the verify boundary's
unconditional, fail-closed provisioning succeeds — which is reached on every
entry (fresh, remediation, resume, failover, auto-respawn). There are now
exactly three assignments: `false` at declaration, `true` on proven
provisioning, `false` on a confinement violation. `persistedHostVerificationPassed`
is gone.

The regression asserts the durable record's keys are exactly `{round, commit}` —
a tripwire if a host verdict is ever persisted there again — and that the resume
reaches `merge_ready` with every criterion `passed`.

### Noted, not blocking

`runImplementor` invoked directly now runs zero declared commands. There is no
production callsite that relies on it doing so (the loop is the only caller, and
it delegates execution to the receipts), but it is a module-level behaviour
change for anyone driving the flow directly — the flow commits and provisions,
and command execution belongs to the verify boundary.

Also unchanged and accepted: receipts consume CAS quota per command per round,
which is F13's intended cost.

## Green bar after the merge

```text
$ npm run typecheck
exit 0

$ npx vitest run
Tests  1994 passed, 0 failed   (1991 at 07d4af0, +3 blocker regressions)
```

Main alone was 1945; F13 alone was 1743 on its older base. The +46 over main is
accounted for: role-runner.test.ts is new in F13 and contributes its 30-case
stop-reason × role × fresh/resumed matrix, verifier/vertical-slice/config/
implementor contribute ~10 more static cases, the remainder comes from
per-SQLite-driver parameterization, and 2 are new here (the double-execution
regression and the commit-authoring violation). No test file lost cases.

Symbol survival was re-checked after the merge for both sides
(`checkpointVerifyHandoff`, `resolveRoundReceiptHead`, `acceptDriftToCommit`,
`adoptedBinding`, `adjudicatedHead`, `RoundReceiptError`, `addAllExceptNodeModules`,
`primary_tree_stale`; `adjudicateRoleTurn`, `EvidenceReceipt`, `hostReceipts`,
`allowSameHarness`, `independence_violation`, `void_verification`,
`hostVerificationPassed`). Two names from the F8–F11 log — `probeForwardContainment`
and `isGrokReadOnlyShellToolCall` — are absent, and were verified absent on
`a77f3da` too: they were superseded within F8–F11's own later rounds, not lost
here.

---

## Verification status (pre-merge, on the original F13 base)

Green checks completed in this worktree:

```text
$ rtk npm run typecheck
exit 0

$ rtk npx vitest run src/app/flows/vertical-slice.test.ts src/app/flows/verifier.test.ts src/app/role-runner.test.ts src/config/config.test.ts
Test Files  4 passed (4)
Tests       153 passed (153)
```

The mandated full-suite command was run but cannot be reported green in this
execution sandbox:

```text
$ rtk npx vitest run
Test Files  76 passed, 28 failed (104 total)
Tests       1415 passed, 315 failed, 11 skipped (1741 total)
Unhandled   1
```

The common root failure is the sandbox refusing the repository's real
`execFileSync('ps', ...)` process-identity probe:

```text
Error: spawnSync ps EPERM
  at runPs (src/supervisor/ps.ts:71)
```

247 failures surfaced that error directly; the remaining failures are
downstream expectations after the same pause/crash/ownership paths failed or
unwound early. The F13-focused suites inject the existing deterministic
`PsClient` seam and are green. Production `ps` behavior was not weakened or
mocked globally merely to manufacture a green full-suite result.

## Explicitly not verified or not done

1. ~~The branch commits could not be created…~~ **Closed:** committed as
   `49c7e18` / `be5cc49`. Still no push.
2. ~~A fully green repository-wide Vitest run could not be obtained…~~
   **Closed at the merge:** `npx vitest run` is 1991 passed / 0 failed in the
   merge worktree, where the `ps` process-identity probe is permitted. The
   `ps` failures above were an artifact of the original authoring sandbox, not
   of the code.
3. F13 spec Part 4's provider-native shell-matcher characterization was not
   claimed. The repository can deterministically test the permission strings
   it constructs and its exact generic ACP allowlist, but it has no local
   deterministic oracle for Claude's external `Bash(command)` matcher
   semantics. No fabricated “cannot widen” green test was added. This remains
   a provider characterization task.
4. No live vendor call was made; all engine regressions use deterministic fake
   adapters and real host/CAS/database seams.
