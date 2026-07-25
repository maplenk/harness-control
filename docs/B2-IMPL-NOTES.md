# B2 — auto-approval: implementation notes

Branch: `worktree-agent-a5af67e014eaeee62` · Parent: `a77f3da` ("F8-F11: resumable rounds, proven
provisioning, git-2.55 staging, grok permission veto"). Note this worktree branched from `a77f3da`,
which is NOT the tip of `main` at the time of writing (`main` is at `5669d22`, F7); the green-bar
numbers below are measured against `a77f3da`.
Spec: `docs/AUTONOMOUS-BASE-PLAN.md` §1 + B2. Invariant reversal recorded in `PLAN.md` §7.1.

> **ROUND 2 (post-codex review of `c45eccf`).** Codex returned NEEDS-FIX with five findings and
> REPRODUCED every one. Sections 1–5 below describe round 1; **§6 is the round-2 record and
> supersedes them wherever they disagree** — in particular the approval gate moved from the CLI to
> the service, auto-approval moved into the coordinator-completion transaction, the signer became
> required end to end, and the §7 testability gate acquired a structural companion. Read §6 first.

---

## 1. What changed and where

### The contract in one sentence
`EngineConfig.approval: 'human' | 'auto'` (default `'human'`) decides **who signs the T1
spec approval**; under `'auto'` the ENGINE binds the real drafted hash the moment a
coordinator drafting round completes, through the same validation a human approval runs.

### Domain vocabulary
| File:line | Change |
| --- | --- |
| `src/domain/state.ts:319` | `export type SpecApprovalMode = 'human' \| 'auto'` — shared vocabulary, kept in `state.ts` beside `RoleName`/`SuccessorReason` so `events`/`entities`/`config` can all reference it without a cycle. |
| `src/domain/events.ts:195` | `spec.approved.approvedBy` widened from the literal `'human'` to `SpecApprovalMode`. The approval event itself distinguishes the mode — no second event type. |
| `src/domain/transitions.ts:621` | `EngineState.specApprovedBy?: SpecApprovalMode`. |
| `src/domain/transitions.ts:905-912` | The `bind_spec_hash` effect now folds **hash and signer together from the one T1 payload**, so "which spec, signed by whom" can never come apart. |
| `src/domain/transitions.ts:764,862,1301` | `MutableDraft` field, carry-in, and the conditional spread into the next `EngineState`. |
| `src/domain/transitions.ts:217-219` | T1 row description updated (it said "Spec approved (human)"). |
| `src/domain/entities.ts:301` | `MergeReadiness.specApprovedBy: SpecApprovalMode` — **required**, deliberately (see §3). |

### Config
| File:line | Change |
| --- | --- |
| `src/config/schema.ts:376-401` | `SPEC_APPROVAL_MODES` (`as const satisfies readonly SpecApprovalMode[]`, matching the `FAILOVER_POLICIES`/`PROVISION_STRATEGIES` precedent) + `DEFAULT_SPEC_APPROVAL_MODE`, with the full contract in the block comment above them. |
| `src/config/schema.ts:457` | `approval: z.enum(SPEC_APPROVAL_MODES).default(DEFAULT_SPEC_APPROVAL_MODE)` on the top-level schema. |

Pinning is free: `createRun` already persists the whole resolved `EngineConfig` into
`RUN_CONFIG_PROJECTION` (W1-F5, `src/app/service.ts:1538`) and never re-saves it, and every
non-`start` CLI invocation reloads the run's persisted config (`src/cli/index.ts:126-142`).
So `approval` is immutable for a run's life with no new machinery — and the auto path reads
it via `service.getRunConfig(runId)`, i.e. from the **pin**, never from the ambient config.

### Application service
| File:line | Change |
| --- | --- |
| `src/app/service.ts:1817-1843` | `approve()` accepts `mode?: SpecApprovalMode`, defaulting to `'human'`. There is still exactly ONE approval path into the engine. |
| `src/app/service.ts:975`, `:3303` | `RunStatus.specApprovedBy` surfaced from the folded engine state. |
| `src/app/projections.ts:212` | `MergeReadinessBlockedState.specApprovedBy?` so a later `harness recheck` process re-reports the same signer. |

### Flows
| File:line | Change |
| --- | --- |
| `src/app/flows/verifier.ts:680`, `:844` | `BuildMergeReadinessInput.specApprovedBy?` → `MergeReadiness.specApprovedBy` (`?? 'human'`). It is set **outside** the `blockers` computation and therefore can never affect `ready`. |
| `src/app/flows/verifier.ts:1043`, `:1196`, `:1278`, `:1349` | Threaded through `RunVerificationInput`, into `buildMergeReadiness`, into the persisted blocked read-model, and back out on `recheckMergeReadiness`. |
| `src/app/flows/orchestrate.ts:149`, `:923` | `ImplementVerifyLoopCommonInput.specApprovedBy?` forwarded to `runVerification`. |

### CLI
| File:line | Change |
| --- | --- |
| `src/cli/commands.ts:388` | `draftLossRefusal()` — extracted verbatim from `handleApprove` so the explicit and automatic paths refuse **identically** (same code, same text, same exit 1). |
| `src/cli/commands.ts:456-520` | `autoApproveDraftedSpec()` — the whole feature. Reads the pinned mode; runs `detectDraftLoss`; refuses a missing/stale draft; refuses when there is no draft at all rather than fabricating a hash; otherwise calls `service.approve(..., { mode: 'auto' })` with the **real** `draft.specHash`. |
| `src/cli/commands.ts:522-543` | `autoApprovalView` / `autoApprovalLines` — the `--json` block and the human-surface "AUTO-APPROVED … no human reviewed this spec" lines. |
| `src/cli/commands.ts:713-766` | Wired into `handleStart`, **after** the F5 coordinator base-drift check (autonomy must never sign a spec drafted against a moved tree). |
| `src/cli/commands.ts:908-963` | Wired into `handleSpecRevise`'s completion (judgement call — see §4). |
| `src/cli/commands.ts:1232` | `handleRun` threads `st.specApprovedBy ?? 'human'` into the loop — read from the **actual T1 fold**, not from config. |
| `src/cli/commands.ts:1424`, `:1436-1444`, `:1301`, `:1574`, `:1581` | `mergeReadinessView` gains `specApprovedBy`; `autoApprovalMergeNotice()` adds the reviewer warning to `run` and both `recheck` renderings. |
| `src/cli/commands.ts:1553-1562` | `handleRecheck`'s inline merge-readiness JSON (a field-for-field duplicate of `mergeReadinessView`) replaced by a call to it, so a future field cannot reach one readiness surface and silently miss the other. |
| `src/cli/commands.ts:13-20` | Module header invariant list corrected — it claimed "never an auto-approve". |

### Docs
- `PLAN.md` §4.1 — the "always — no auto-approve path" phrase now points at §7.1.
- `PLAN.md` §7 + **new §7.1** — the reversal, why, what is *not* relaxed, and the failure mode it does not prevent.
- `README.md` "Safety posture" — the flat claim "There is no auto-approve path" was false after this change and is replaced with the opt-in description; the `start` example comment updated.

---

## 2. The fails-on-parent proof

Method: never mutated this worktree. Extracted the parent tree to a scratch dir,
symlinked `node_modules`, copied ONLY the new/changed test files in, ran there.

```
git archive a77f3da | tar -x -C $SCRATCH/parent-proof
ln -s <worktree>/node_modules $SCRATCH/parent-proof/node_modules
cp src/cli/commands.auto-approval.test.ts  $SCRATCH/parent-proof/src/cli/
cp src/config/config.test.ts               $SCRATCH/parent-proof/src/config/
cd $SCRATCH/parent-proof && npx vitest run src/cli/commands.auto-approval.test.ts src/config/config.test.ts
```

**Run 1 — as committed** (measured on the 20-test revision of the file; two tests were added
afterwards, see Run 2 for the final totals):
```
 ❯ src/config/config.test.ts              (50 tests |  3 failed)
 ❯ src/cli/commands.auto-approval.test.ts (20 tests | 18 failed)
 Test Files  2 failed (2)
      Tests  21 failed | 49 passed (70)
```
Sample: `expected undefined to deeply equal [ 'human', 'auto' ]` (`SPEC_APPROVAL_MODES` absent);
`unwrap() called on Err` (`parseEngineConfig({approval:'auto'})` is a `.strict()` violation on parent).

Run 1 is honest but weak on its own: most CLI tests die at the config gate, which only proves
the *knob* is new. So:

**Run 2 — config gate bypassed, to prove the ENGINE ignores the value.** One line patched in the
parent-proof copy only:
```ts
- const AUTO_CONFIG = (): EngineConfig => unwrap(parseEngineConfig({ approval: 'auto' }));
+ const AUTO_CONFIG = (): EngineConfig => ({ ...unwrap(parseEngineConfig({})), approval: 'auto' } as unknown as EngineConfig);
```
```
 Test Files  1 failed (1)
      Tests  20 failed | 2 passed (22)
```
with genuine behavioural assertion failures, e.g.
- `approval:'auto' — start reaches approved …` → `expected 1 to be +0` (start did not reach `approved`)
- `a MISSING draft refuses …` → `expected undefined to be 'spec_draft_missing'`
- `with NO draft and NO completion ref …` → `expected undefined to be 'auto_approve_no_draft'`
- `§16 merge-readiness reports specApprovedBy:'auto'` → `expected undefined to be 'approved'`
- `a human-approved run's report says specApprovedBy:'human'` → `expected undefined to be 'human'`
- `a REFUSED auto-approval is repaired by \`spec revise\`…` → `expected undefined to be 'spec_draft_missing'`

The **2 that pass on the parent are the two that must**: the `approval:'human'` default guards
(`start` waits at `awaiting_approval`, emits no `spec.approved`). They encode UNCHANGED behaviour,
so passing on the parent is the correct signal, not a gap.

Green bar on this branch: `npm run typecheck` exit 0; `npx vitest run` → **107 files / 1969 tests, 0 failed**
(parent baseline re-measured on this worktree before any edit: 106 files / 1945 tests, 0 failed).
Delta: +1 file, +24 tests = 22 in `src/cli/commands.auto-approval.test.ts` (11 × 2 SQLite drivers)
plus 2 in `src/config/config.test.ts`.

---

## 3. Judgement calls

**a) `MergeReadiness.specApprovedBy` is REQUIRED on the entity, optional on the flow inputs.**
Required on the entity means a future `MergeReadiness` literal cannot be constructed without
deciding the signer — the compiler caught exactly three test fixtures, each updated to an explicit
`'human'`. Optional on `BuildMergeReadinessInput`/`RunVerificationInput`/`ImplementVerifyLoopCommonInput`
(defaulting to `'human'`) mirrors how `approvedSpecHash` is already threaded and avoids touching
every existing flow-test input. The default is the fail-safe direction: absent never invents an
"a human checked this" claim, it only withholds the auto WARNING. A regression test asserts the
production CLI path actually threads it, so the default is not doing load-bearing work.

**b) Signer is read from the EVENT FOLD, not from config, at report time.**
`handleRun` uses `st.specApprovedBy`, not `getRunConfig().approval`. If a human races in and runs
`harness approve` on a run pinned to `'auto'`, the report correctly says `human`. Config decides
what the engine *will do*; the event records what *happened*.

**c) Auto-approval also fires on a completed `spec revise` round** (beyond `start`, which the
contract names). Reasoning: T2 lands at `awaiting_approval` exactly as `start` does, so the same
pinned mode should decide; otherwise a run whose auto-approval was REFUSED (draft loss) and then
repaired via `spec revise` — the documented W3-4 recovery — would silently strand at the input
gate the run is pinned not to have. Note that after a *successful* auto-approval `spec revise` is
already impossible (T2 requires `awaiting_approval`), which a test asserts; so this path only ever
serves the refusal-recovery case. If a reviewer disagrees, deleting the `handleSpecRevise` call
site (`src/cli/commands.ts:908-921`) reverts just this decision.

**d) No new CLI flag.** Approval mode is config-only (`--config FILE`), like every other engine
knob, so it is automatically pinned per run by the existing W1-F5 machinery. A `--auto-approve`
flag would have created a second, unpinned way to say the same thing.

**e) `handleRecheck`'s duplicated readiness JSON was collapsed onto `mergeReadinessView`.** Strictly
beyond B2's scope, but the duplicate was the mechanism by which this exact change could have shipped
half-wired. Byte-identical output before and after.

**f) The refusal replaces the whole `start` output when auto-approval is refused.** A draft that
vanishes between the completion write and the read microseconds later is corruption; the loud
refusal (exit 1, `refused: spec_draft_missing`) matches `handleApprove` and is the safer surface.
Cost: the drafted spec document is not printed in that (already pathological) case.

---

## 4. What I could NOT verify

- **No live run.** Everything here is offline: in-process fake adapters, a real temp git repo, real
  SQLite (both drivers). No real coordinator/implementor/verifier was spawned under `approval:'auto'`,
  so "an autonomous run end-to-end on real models" is unproven by me.
- **The draft-loss refusals are reached via a `Proxy` over the service** (`withDamagedDraft`,
  `src/cli/commands.auto-approval.test.ts`). `start` drafts and auto-approves back-to-back in ONE
  process, so there is no natural window to corrupt the projection in. The Proxy makes
  `getSpecDraft` (and optionally `getCoordinatorCompletion`) return `undefined` while every other
  method is the real service. It proves the branch behaves correctly; it does not prove that a real
  crash produces exactly that state — the pre-existing W3-4 tests cover that shape for `approve`.
- **`auto_approve_no_draft` is unreachable through the shipped CLI** (production `start` always
  drafts). It is defence-in-depth against a future caller, tested only via the Proxy.
- **The event log's approval mode is not migrated.** A run approved by a pre-B2 build has no
  `approvedBy` fold and reads as `human` everywhere. That is correct for those runs (human was the
  only possible signer), but it is an assumption about history, not a check.
- **Concurrency.** I did not test two processes racing `start`+`approve` on the same run.
- **`--enable-chat` + `approval:'auto'` was not exercised.** The chat path completes a drafting
  round through the same `completeCoordinationRound`, so it should behave identically, but I did
  not assert it.

---

## 5. What still stops a bad autonomous run

Enumerated from the code, with what each actually catches.

**Guards that exist and act**

1. **§7 testability gate** — `assessSpecSemantics` (`src/app/flows/coordinator.ts:153`) rejects any
   criterion whose expected evidence names no concrete observable, and a spec that fails all
   validation rounds throws `CoordinatorSpecError` — no draft, nothing to approve. Untouched by B2
   and regression-tested under `approval:'auto'`. **The only automated filter on spec CONTENT.**
2. **Schema validation** — the §7 shape (≥1 task, ≥1 criterion, ≥1 verification command per
   criterion, unique ids, resolvable `dependsOn`) is enforced before the semantic gate.
3. **W1-F3 hash binding** — `run` refuses when the engine's approved hash ≠ the current draft, so
   nothing implements a document nobody (human *or* engine) signed.
4. **W3-4 draft-loss detection** — now on both approval paths.
5. **F5 base pinning** — non-git/unborn/dirty/drifting workspaces refuse at `start`; coordinator
   base drift refuses *before* auto-approval can sign.
6. **Worktree isolation + write containment + single-writer lease** — the implementor cannot touch
   the primary checkout.
7. **W3-1 verification-runner confinement** — if the implementor's own verification commands mutate
   the primary checkout, readiness blocks with an agent-actionable blocker.
8. **Independent verification** — a separate role, separate session, read-only on the implementation
   commit, judged per criterion.
9. **§16 merge-readiness gate** — `ready` requires all criteria passed, spec hash unchanged, worktree
   HEAD == verified commit, clean destination, no base drift, no conflicts, required tests passed,
   clean worktree, no runner violation.
10. **Bounded remediation (T23) + restart breaker + limit pause + budget** — the run terminates
    rather than grinding.
11. **The merge gate** — nothing is ever merged, committed to your branch, or pushed. This is the
    load-bearing human control after B2.
12. **The event log** — every decision durable and replayable, now including `approvedBy:'auto'`,
    with the signer repeated on the merge-readiness record.

**Failure modes NONE of these catch**

- **A coherent, testable, verifiable spec for the WRONG WORK.** The gates check *form* and
  *self-consistency*, never *intent*. If the coordinator misreads the goal, every gate passes and the
  run reaches `merge_ready`. Only the merge review catches this. This is the fundamental trade B2 makes.
- **Criteria that are concrete but trivial.** `CONCRETE_EVIDENCE_ANCHOR` is a keyword/shape regex and
  is deliberately broad ("never reject genuinely concrete evidence"). "exit code is 0" passes it.
  A coordinator can satisfy the testability gate with criteria that assert almost nothing — and under
  autonomy nobody reads them before work starts. **This is the most exploitable hole B2 opens, because
  the gate the plan calls "the only filter" is a lexical one.**
- **Model-authored verification evidence.** `deriveRequiredTestsPassed`
  (`src/app/flows/verifier.ts:1093`) accepts `verdict === 'passed'` + any non-empty evidence ref. The
  host DOES run the declared commands but the result is not what gates `merge_ready` — this is
  exactly the F13/B1 gap, and `docs/AUTONOMOUS-BASE-PLAN.md` §1 states it is the **precondition** for
  autonomy. **B2 shipping before B1 means a `merge_ready` currently rests on one model's say-so with
  no human having read the spec.** I implemented B2 as asked; this ordering risk is real and I am
  flagging it rather than assuming the sequencing was reconsidered.
- **Implementor and verifier on the same vendor.** Nothing enforces independence today (also B1).
  Two instances of the same model share failure modes; the "independent" check may not be independent.
- **Scope collision between concurrent assignments.** Not applicable yet (one implementor), but B4
  makes disjoint `writeScope` mandatory *because* auto-approval removes the human who would have
  noticed.
- **Runaway cost/quantity.** Autonomy removes the natural per-run pause. Budget is a soft, opt-in
  ceiling (`maxBudgetUsd` undefined by default) and there is no cap on how many autonomous runs may
  be started. Nothing here rate-limits an autonomous loop.
- **A malicious/prompt-injected coordinator.** Its output is schema-validated but its *content* is
  trusted to become the implementor's instructions. The human approval step was the de facto
  injection barrier; `auto` removes it. Worktree containment limits the blast radius to the
  worktree — not to what the spec asks for.
- **Semantic drift across remediation rounds.** Remediation is bounded in count, not in scope; each
  round re-reads the same spec, but nothing re-checks that the accumulated diff still matches intent.

---

## 6. ROUND 2 — the codex review, and what it changed

Codex reviewed `c45eccf` and returned **NEEDS-FIX with five findings, every one reproduced**. It
found no regression on the default `'human'` path. All five are fixed below; each has a regression
test that stages codex's own scenario, and each was proven to fail on `c45eccf`.

### F1 (HIGH) — the approval gate was in the CLI, not the engine

**Reproduced:** a run pinned to `approval:'human'`, with **no draft at all**, reached `approved`
carrying a **fabricated hash** and a durable `approvedBy:'auto'`. `service.approve` trusted the
caller's `mode`, version and hash outright, so the CLI's pre-checks were the only thing in the way —
and the CLI is not the only caller. Codex is right that this is not an auto-approval bug: it was a
hole in the entire approval gate.

**Fix.** `OrchestrationService.#assertApprovalBinding` (`src/app/service.ts:1905`), called inside the
approving transaction by BOTH approval routes:
- the run's **PINNED** `approval` (W1-F5) decides whether `mode:'auto'` is even legal — a `'human'`
  run refuses it, so `approvedBy:'auto'` can never appear on a run that never opted in;
- the binding is validated against the durable completion ref by the SERVICE.

Refusals are the typed `SpecApprovalRefusedError` (`src/app/service.ts:310`), rendered by the CLI as
an ordinary structured refusal (`approvalRefusalOutput`, `src/cli/commands.ts:493`) rather than a crash.

### F2 (HIGH) — hash-only identity, and a read outside the write

**Reproduced:** a stale draft projection carrying the **same content hash** under a **superseded
version/revision** passed draft-loss detection (human approval caught it only via its separate
`--spec-version` check; the auto path had no second look). And validation ran in the CLI, in a
different transaction from the T1 append, so a concurrent revision could slip in between.

**Fix.** Identity is now hash **and** version **and** revision — in `detectDraftLoss`
(`src/cli/commands.ts:362`, the early friendly rendering) and authoritatively in
`#assertApprovalBinding`. `approve` wraps validation + `ingest` in ONE `transactionImmediate`
(`src/app/service.ts:1881`), so nothing observes a half-checked approval and nothing races.

### F3 (MEDIUM) — auto-approval was a CLI post-step

**Reproduced:** an `approval:'auto'` run driven through the durable completion API completed and
**stayed at `awaiting_approval`**; the W2-5 coordinator re-entry likewise printed `next: approve`;
and a crash between the completion and the post-step stranded the run at a gate it is pinned not to
have.

**Fix.** The T1 now rides `completeCoordinationRound`'s transaction (`src/app/service.ts:2778`), so
**every** durable coordinator completion signs atomically — `start`, `spec revise`, W2-5 re-entry,
and any direct API caller alike — and a refused signature rolls the whole round back. The CLI keeps
only the *rendering* (`autoApprovalOf`, `src/cli/commands.ts:458`), derived from the resulting engine
state; the re-entry surface no longer tells an already-approved run to approve.

Codex explicitly endorsed round-1 judgement call (c) — auto-approving a completed `spec revise` is
correct recovery, not a second route. Centralizing has an interesting consequence: because a refused
auto-approval now rolls the completion back, an `'auto'` run is **never** parked at
`awaiting_approval`, so `spec revise` (which requires that phase) is unreachable on such a run. The
recovery path it existed for cannot arise. That is a strictly better outcome, and the test that used
to cover the revise-repair case was deleted rather than left asserting a state the engine can no
longer produce.

### F5 (MEDIUM) — an optional signer that silently became `'human'`

**Reproduced:** a ready readiness record built with no signer input reported
`specApprovedBy:'human'`. Codex **rejected** round-1 judgement call (a): requiring the field on the
final entity is worthless while every upstream input is optional and defaults to human. It is right —
that is a lie in the one field that exists to prevent one.

**Fix.** The signer is REQUIRED through the whole production flow —
`ImplementVerifyLoopCommonInput`, `RunVerificationInput`, `RecheckMergeReadinessInput`,
`BuildMergeReadinessInput`, `MergeReadiness` — and legacy compatibility resolves at **exactly one
point**: `status()` maps a pre-B2 approval (hash bound, no signer folded) to `'human'`
(`src/app/service.ts:3475`). `MergeReadinessBlockedState.specApprovedBy` was **removed** rather than
made optional, so a persisted record written by an older build cannot re-introduce a default;
`recheck` re-reads the signer from engine state. Where the value could still be absent, the CLI
REFUSES (`approval_signer_missing`, `src/cli/commands.ts:1123`, `:1474`, `:2132`) instead of guessing.
The compiler found 72 construction sites; every one now states its signer.

### F4 (HIGH) — the testability gate is lexical, and gameable

**Reproduced:** the validator accepted a task **"Remove the authorization check"**, verification
command **`true`**, expected evidence **"exit code is 0"**. Codex's conclusion is the sharpest line in
the review: *F13 makes execution evidence honest, but it does not make the criteria meaningful* —
after F13 the host would truthfully attest that a meaningless command passed. The code comment and
`profiles/coordinator.md` both still assumed a human always reads the spec, which under `'auto'` is
false.

**Fix — structural, not a smarter regex.** The verification commands come from the RUN:
- `verification.allowedCommands` in `EngineConfig` (`src/config/schema.ts:352`), pinned per run at
  `start` like every other knob;
- `assessSpecSemantics` requires every cited command to be an exact member of that set
  (`src/app/flows/coordinator.ts:231`) — near-misses (`… || true`, `true; …`, padding, prefixes) are
  refused, and the refusal names the legal set so the bounded re-prompt is actionable;
- `approval: 'auto'` **refuses an empty set at config parse** (`src/config/schema.ts:498`), mirroring
  the existing `switch_*`-requires-a-ladder rule. Under the human gate a person reads the spec; under
  autonomy nobody does, so autonomy may not also let the model choose what counts as proof;
- the coordinator is TOLD the set up front in the emission contract
  (`src/app/flows/coordinator.ts:846`) so it does not burn a bounded round discovering the rule —
  but telling it is a courtesy, the host check is the gate;
- the stale comment at `CONCRETE_EVIDENCE_ANCHOR` and the false "human-only" / "always explicitly
  human-approved" claims in `profiles/coordinator.md` are corrected, and the profile now states
  plainly that under `'auto'` **nobody reads the spec before work starts**.

**The residual, stated plainly:** a criterion can still be VACUOUS even when it cites a real command.
"the suite passes" is satisfied by a no-op change. Neither the testability gate nor the allowlist
catches that. Two things do, and neither is this gate: the **deliverable adjudicator requires a NEW
COMMIT**, and the **human reviews the merge**. The allowlist raises the floor from "any string the
model invents" to "a command you declared"; it does not make criteria meaningful.

### Round-2 fails-on-parent proof

Same method as §2 (extract the parent, symlink node_modules, copy only test files — this worktree is
never mutated), parent `c45eccf`:

```
git archive c45eccf | tar -x -C $SCRATCH/pp2
cp src/app/approval-boundary.test.ts $SCRATCH/pp2/src/app/
cp src/config/config.test.ts         $SCRATCH/pp2/src/config/
cp src/app/flows/coordinator.test.ts $SCRATCH/pp2/src/app/flows/
cd $SCRATCH/pp2 && npx vitest run <those three>
```

| Finding | Parent failure (verbatim) |
| --- | --- |
| F1 | `promise resolved "{ status: 'applied', …(3) }" instead of rejecting` — the `'human'`-pinned, draft-less run WAS auto-approved with a fabricated hash |
| F2 | `promise resolved "{ status: 'applied', …(3) }" instead of rejecting` — the same-hash/superseded-revision draft passed, as did a version/hash disagreeing with the completion ref |
| F3 | `expected 'awaiting_approval' to be 'approved'` (with the parent's config gate bypassed by a one-line local patch, exactly as in §2 Run 2) — the durable completion API left the `'auto'` run at the gate |
| F4 | `expected true to be false` — the validator ACCEPTED codex's `true` + "exit code is 0" spec even with an allowlist supplied |
| config | 4 failures (`SPEC_APPROVAL_MODES` absent; `allowedCommands` absent; `approval:'auto'` accepted with no allowlist) |

Totals on the parent: `approval-boundary.test.ts` 16/20 failed as committed and 16/20 with the F3
config bypass (the bypass converts two setup failures into behavioural ones), `config.test.ts` 4/52
failed, `coordinator.test.ts` 2/19 failed. The tests that PASS on the parent are the ones that must:
the `approval:'human'` guards, which encode unchanged behavior — consistent with codex finding no
default-path regression.

**Green bar after round 2:** `npm run typecheck` exit 0; `npx vitest run` → **108 files / 1992 tests,
0 failed** (round 1: 107 / 1969; original parent baseline: 106 / 1945).

### Round-2 judgement calls

- **`MergeReadinessBlockedState.specApprovedBy` was deleted, not made required.** Persisting it would
  have created a second place where a missing value could become `'human'` — exactly F5's complaint.
  `recheck` re-reads the signer from engine state instead.
- **A missing signer REFUSES rather than defaults, in three CLI paths.** After the single resolution
  point in `status()`, an approved run always has a signer; its absence means the engine bound a hash
  without folding a signer. Printing a guess there would be the precise lie F5 is about.
- **Empty `allowedCommands` stays unrestricted under `approval:'human'`.** Making it mandatory
  everywhere would have broken every existing run and test for no safety gain — a human reads those
  specs. The cross-field refusal is what makes the permissive default unreachable under autonomy.
- **Exact string matching, no normalization.** Any normalization (trimming, shell-splitting,
  prefix-matching) is a new attack surface: `npm test` and `npm test || true` must never be the same
  command. Padded allowlist entries are refused at parse so exactness can never be a silent trap.
- **`--test-approve` is now strictly narrower**: it still binds the real drafted hash, but the service
  compares the caller's `--spec-version` to the completion ref, so it can no longer approve under a
  foreign version id. The `HARNESS_TEST_MODE` guard itself is unchanged. This is a deliberate,
  tested tightening of a test-only seam.

### Still not verified after round 2

Everything in §4 still stands (no live run; no concurrency testing; `--enable-chat` + `'auto'` not
exercised). Newly relevant:
- **The transactional atomicity claims are tested by outcome, not by crash injection.** The "rejected
  T1 rolls the whole completion back" test drives a real rejection and asserts nothing was written;
  it does not kill the process mid-transaction.
- **The allowlist is enforced at spec VALIDATION only.** Nothing re-checks, at verification time,
  that the commands actually executed are the declared ones. Under F13/B1 the host attests what ran;
  tying that attestation back to the pinned allowlist is not implemented here.
- **§5's guard analysis is now partly superseded.** Its "criteria that are concrete but trivial"
  bullet described the hole F4 fixes structurally; the residual (a vacuous criterion citing a real
  command) is restated above. Its F13/B1 ordering warning still stands unchanged.
