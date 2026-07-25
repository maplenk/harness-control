# F13 — Attested verification: host-proven execution + role-independent stop adjudication

**Status:** design draft, 2026-07-25. Source: `docs/reviews/harness-review-5.6-pro.md` P0-1 and P0-2, both independently verified against main `481e772` before drafting. Sequencing: the **next engine track after the LAND window**, before further dogfood slices depend on verification integrity.

**Why this outranks everything else queued.** F8–F11 fix bugs where the engine failed *safe* — refusals, dead runs, false negatives. These two are the opposite polarity: reachable paths to certifying work that was never proven. The product's entire differentiating claim is fail-closed cross-vendor verification; these are the two holes in it.

---

## Part 1 — Role-independent stop adjudication (P0-1)

### Verified defect
`AcpStopReason` includes `end_turn | max_tokens | max_turn_requests | refusal | cancelled`. The implementor is protected — `deliverable.ts:21`: `if (result.stopReason !== 'end_turn') return 'no_deliverable'`. **The verifier is not.** It records the stop reason (`verifier.ts:454`) and then computes `outcome: allPassed ? 'all_verified' : 'blocked'` with no reference to it. A verifier truncated by `max_tokens` — having already emitted syntactically valid passing JSON for the criteria it reached — can therefore produce `all_verified` and feed T24.

This is structurally identical to the F1–F6 defect that opened this project (a watchdog kill recorded as a successful `turn.completed`), reappearing in the one role where it produces a **false positive** rather than a false negative.

**Severity correction (triage, 2026-07-25) — narrower than the source review claims.** A `max_tokens` truncation typically fails `extractJson` → empty map → every criterion `unproven`, i.e. already fail-safe by accident. The genuinely live vectors are **`refusal`** and **`max_turn_requests`**, where the model emits a complete, parseable, passing report and *then* terminates abnormally. The fix is unchanged — adjudication must not depend on whether a truncated payload happens to be unparseable — but the finding is "two reachable stop reasons," not "any of five." Also confirmed: the contract *structurally* forbids read-only roles from adjudicating (`role-runner.ts:137` types `adjudicateRoundOutcome?: never`; `service.ts:2911-2914` hardcodes `'completed'`), so this must be fixed at the wrapper, not by giving the verifier an adjudicator.

### Contract
1. **One adjudication point, role-independent.** A resolved turn yields either `{kind:'completed', stopReason:'end_turn'}` or `{kind:'aborted', stopReason: <any other>}`. Only `completed` may supply a successful flow result — for every role, fresh or resumed.
2. **Per-role abort mapping** (each fail-closed):
   - implementor → `no_deliverable` (today's behavior, now inherited rather than special-cased);
   - **verifier → the verification is void**: every criterion in that turn becomes `unproven` with a note naming the stop reason; the round is `blocked` and remediation proceeds on evidence-not-gathered, never on a partial pass;
   - coordinator → the draft is rejected; re-draft within the existing bounded rounds.
3. **No partial credit from an aborted turn.** Criteria the verifier *did* report before truncation are not carried; a truncated turn proves nothing about the criteria it never reached, and accepting the ones it did is precisely the false-positive path.
4. **Matrix test — required:** all five stop reasons × three roles × {fresh, resumed} = 30 cases, asserting the mapping above. The absence of this matrix is why the asymmetry survived.

---

## Part 2 — Host-attested evidence (P0-2)

### Verified defect
`deriveRequiredTestsPassed` (`verifier.ts:1077-1080`) admits a command-bearing criterion when `verdict === 'passed' && evidenceRefs.length > 0`. Those refs point at the **model's own free-text prose**, written to the CAS by the verifier flow. Nothing binds that text to a command, an argv, an exit code, a commit, a working directory, or an execution that ever occurred. A verifier can write `"npm test: 147 tests passed"` and the system persists it as evidence.

**The sharpening the source review missed:** the host *already executes* the declared commands (`defaultVerificationRunner`, `implementor.ts:242` — real spawn, real exit codes, W3-1 env allowlist, W4-7 process-group reaping) and then **throws the result away** — `ImplementorResult.verificationPassed` is written at `implementor.ts:1084` and read nowhere in non-test source. So the engine computes host-observed truth, discards it, and gates merge-readiness on model prose about the same commands.

**Worse: two comments assert an invariant no code implements.** `implementor.ts:61` states "the §16 readiness gate blocks" on that field and `:720` states "the loop driver halts"; `orchestrate.ts` reads only the commit off `ImplementorResult` (`:225`, `:655`). A safety-critical field is documented as load-bearing and is inert. Reconciling those comments is part of this work — a lying comment about a safety property is how the next reader concludes the hole is already closed.

**Build order correction (triage):** do NOT design the full receipt schema first. **Step 1 is making `verificationPassed` load-bearing** — the smallest change that converts host-observed truth from discarded to gating, and it can ship in hours. The full `EvidenceReceipt` (per-command argv/exit/commit binding) is step 2, once the wiring exists and the comments tell the truth.

### Contract

**Division of labor (the design principle):** the **host proves execution happened**; the **model judges whether the result satisfies the criterion**. Merge-readiness requires **both**. Neither alone is sufficient — a host receipt cannot know if exit 0 means the criterion is met, and a model verdict cannot prove anything ran.

1. **`EvidenceReceipt` — host-created, immutable, CAS-stored.** Per declared command execution: `{receiptId, runId, criterionId, specHash, implementationCommit, argv, cwd, exitCode, startedAt, endedAt, stdoutRef, stderrRef, outputDigest, toolchain: {node, platform, arch, provisioningMarker}}`. Redacted before persistence (§17.1), like every other artifact.
2. **Executed at the verify boundary**, after F7/F9 provisioning proves the toolchain and against the exact implementation commit — not in the implementor's turn, whose results are discarded today and whose tree state precedes provisioning.
3. **The gate changes:** a command-bearing criterion passes only when **every** declared command has a host receipt with `exitCode === 0`, bound to the current `specHash` **and** `implementationCommit`, **and** the verifier's verdict is `passed`. Any missing/failed/mismatched receipt ⇒ `unproven` (never `failed` — absence of proof is not proof of failure). Criteria declaring no commands are unchanged.
4. **Model evidence keeps its role** as narrative and judgment, and remains required — it just can no longer *substitute* for execution proof. The existing "passed with no evidence ⇒ unproven" downgrade (`verifier.ts:491`) stays.
5. **Receipts are the verifier's input, not just the gate's.** Hand the verifier its receipts (exit codes + output refs) in the prompt so its judgment is grounded in host-observed reality rather than its own re-execution. It may still run its own probes; those remain narrative, never gating.
6. **Resume/carry-over:** a carried criterion must carry its receipt, and the receipt's `implementationCommit` must equal the round's. A receipt from a prior commit is stale — re-execute rather than carry.

### Acceptance criteria
- AC-1: verifier reports `passed` for a command-bearing criterion with **no** host receipt ⇒ `unproven`; readiness blocked.
- AC-2: host receipt exists with non-zero exit, verifier says `passed` ⇒ `unproven`, readiness blocked, receipt surfaced.
- AC-3: receipt bound to a different `implementationCommit` or `specHash` than the round ⇒ rejected as stale, criterion `unproven`.
- AC-4: fabricated model evidence with no receipt ⇒ cannot reach `merge_ready` (the P0-2 regression, and it must fail on parent).
- AC-5: verifier turn ends `max_tokens` after emitting valid passing JSON ⇒ all criteria `unproven`, no `all_verified` (the P0-1 regression, must fail on parent).
- AC-6: happy path unchanged — clean run with real commands and honest verdicts still reaches `merge_ready`.
- AC-7: receipts are redacted and quota-accounted like all CAS artifacts; both SQLite drivers asserted.

---

---

## Part 3 — Cross-vendor independence must be an invariant, not a convention

**Verified defect (2026-07-25):** nothing in the engine compares the implementor's harness to the verifier's. No such check exists in `orchestrate.ts`, `model-resolution.ts`, or `service.ts`. The product's central claim — *independently verified by a different vendor* — is enforced today only by whoever typed the CLI flags. A run configured `grok` implements / `grok` verifies is accepted silently and reported as independently verified.

**Contract:** at role resolution, a verifier whose **harness** equals the implementor's is refused by default (`independence_violation`, naming both roles' resolved profiles), with an explicit opt-out (`verification.allowSameHarness: true`) for users who knowingly want single-vendor runs. W4-1: the opt-out acts. Merge-readiness records the resolved harness pair, so the audit trail proves independence rather than assuming it. Model-level sameness within one vendor is a weaker signal — warn, do not refuse.

## Part 4 — Test the verifier's shell confinement (the layer below the P0s)

F11 just found a write-bypass in grok's read-only classifier. Nobody has tested the equivalent boundary for the **verifier**. `claude/provider.ts:84-93` builds an allowlist entry as `Bash(${command})` rejecting only newlines and NULs; whether that string confines execution to exactly that command depends on Claude's matcher semantics, which this repo has never characterized. Deliverable: a characterization test per verifier-capable provider proving that an allowlisted command cannot be widened (argument injection, chaining, substitution) — the same treatment F11 gave the implementor path. If it *can* be widened, that is a P0 of its own and this spec grows a Part 5.

---

## Interim compensating control (until F13 lands)
The orchestrator inspects `stopReason` on every verifier turn in the event log and refuses to recommend a merge on anything other than `end_turn`. This is a manual stand-in for Part 1 only; **Part 2 has no manual substitute** — which is the strongest argument for building F13 before the dogfood accumulates merged slices whose evidence was never host-proven.

## Codex spec-review focus
(i) Does the host receipt genuinely bind the *toolchain* it ran under, given F9's provisioning marker is the only proof the tree was sound? (ii) Should a failed host receipt be `unproven` or `failed` — I chose `unproven` because a broken environment is not a broken implementation, but a passing implementation with a genuinely failing test deserves `failed`; is exit-code-alone enough to distinguish? (iii) Receipt volume/quota under repeated remediation rounds. (iv) Whether Part 1's "no partial credit" rule is too strict for a `refusal` stop, where the model deliberately declined a specific criterion. (v) Does handing the verifier its receipts create an anchoring bias that weakens independent judgment — and is that a fair price for grounding?
