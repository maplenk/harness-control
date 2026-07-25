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
below are present in the worktree, but the requested coherent commits could not
be created and HEAD remains the parent SHA.

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

## Verification status

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

1. The branch commits could not be created because Git metadata is in the
   forbidden, non-writable orchestration directory. No push was attempted.
2. A fully green repository-wide Vitest run could not be obtained under the
   host process-inspection restriction described above. It must be rerun in an
   environment where the repository's `ps` characterization tests are allowed.
3. F13 spec Part 4's provider-native shell-matcher characterization was not
   claimed. The repository can deterministically test the permission strings
   it constructs and its exact generic ACP allowlist, but it has no local
   deterministic oracle for Claude's external `Bash(command)` matcher
   semantics. No fabricated “cannot widen” green test was added. This remains
   a provider characterization task.
4. No live vendor call was made; all engine regressions use deterministic fake
   adapters and real host/CAS/database seams.
