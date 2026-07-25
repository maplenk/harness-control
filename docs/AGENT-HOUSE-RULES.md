# Agent house rules

*Derived from ~40 adversarial review rounds across F8–F14, B2 and F13 on 2026-07-25. Every rule here was paid for with rounds. Reference this file in agent prompts instead of restating it.*

---

## 1. Guard the state, not the routes — the most expensive lesson

**When a review names a location, ask what PROPERTY must hold and where ALL the places it must hold are. Then make omission structurally impossible.** Fixing the named site is how a defect survives four rounds while every individual fix is correct.

Paid for four separate times in one day:
- **The grok payload veto** (4 rounds): fixed inside the classifier → the exact-allowlist match ran first; moved to the config root → the factory installed it only for one role+mode; enumerated in a test → direct construction of the exported generic adapter bypassed it. Closed only when the field became **non-optional on the type used at every construction site**, so omitting it fails to compile.
- **F9's proof** (many rounds): every place that turned "I cannot determine X" into "refuse" was found one at a time until an exhaustive audit classified all 25 refuse sites at once.
- **B2's approval guard** (3 rounds): added to `approve()`, then to `completeCoordinationRound()` — public `ingest()` still accepted the transition directly.
- **F13's confinement** (2 rounds): each violation handled alone; an early return meant the *conjunction* of two violations skipped the hard stop.

**The test:** if your fix is a check at a call site, ask what a future contributor must remember in order not to reintroduce the bug. If the answer is "to add the check", it is not fixed. Prefer a required constructor parameter, a type that cannot be constructed without the guarantee, a single chokepoint every path must cross, or a test that enumerates constructible paths and fails when a new one appears.

## 2. "I could not determine X" is never "X is false"

The engine's characteristic bug, in both directions:
- **Toward false refusal:** a scan capped at N reporting "zero found"; an `lstat` returning EACCES read as "absent"; a lockfile whose structure *resembles* a supported version; a parse failure read as "not a shell command".
- **Toward false acceptance:** `require()` succeeding while the native binding loads lazily inside a constructor; a populated `.bin/` standing in for a built addon; model prose standing in for execution.

**Rule:** a bounded search that found nothing is not a finding. An observation that failed is not an observation. Say which it is, and fail closed on ambiguity — but see rule 3 for the limit.

## 3. Never refuse what the status quo accepts

A guard that rejects valid inputs is a false verdict pointing the other way. F9 produced ~10 blocking regressions by making its proof progressively stricter than real npm layouts (`file:` deps installed as symlinks, v2/v3 link descriptors, subpath-only exports, deep nesting, corporate registries).

**Rule:** positively-identified breakage refuses; anything indeterminate warns loudly and proceeds. State the rule in the code, not just the notes, so the next unfamiliar shape is not the next regression.

## 4. Prove the fix fails on the parent

A test that passes before your change tests nothing. Run it against the parent commit and record the exact command and output.

Two refinements paid for the hard way:
- **Interrogate weak proofs.** B2's first proof showed 21 failures, but most died at a *config gate* — proving only that a knob was new. The real proof needed the parent patched to force the config through, which yielded 20 genuine behavioural failures.
- **`git checkout --` to revert a simulation wiped the real fix, twice.** Restore from a copy, and grep for your new symbols afterwards to confirm the fix survived.

## 5. A guard needs a test that proves it FIRES

Repeatedly found: guards that exist and do not guard.
- The verifier-boundary independence check had no test, and the one file covering its exact scenario globally disabled it.
- A preflight battery certified a machine whose real staging helper was broken, because the drill simulated the helper instead of executing it.
- A selftest asserted a refusal *message* without asserting the non-zero exit, so `printf correct-message; return 0` would have passed.

**Rule:** assert the refusal, not just the success. Where a fix distinguishes two severities, pin **both directions** — conflating "blocking violation" with "hard stop" is what let a laundered commit through.

## 6. Never claim coverage you do not have

An honest "I could not build a deterministic test for this, and here is why" has been **accepted** every time it was offered. Fabricated or unexplained green has not. If a proof passes and you cannot explain why, that is a finding about the proof.

## 7. Comments that lie are defects

`verificationPassed` was documented at two sites as gating merge-readiness and had **zero readers**. A safety-critical field described as load-bearing and inert is how the next reader concludes a hole is already closed. If you change what a guard does, change what the code says about it — and if you find a comment asserting an invariant no code implements, that is a bug, not a doc nit.

## 8. Green is necessary, not sufficient

The suite has been wrong about itself: the reported total was **exactly double** for weeks because a leftover agent worktree was collected twice. A codex-authored fix reported "the focused bar is green" and missed a full-suite failure. Always run the FULL suite and report exact counts; investigate a total that moved in a direction you did not intend.

## 9. Persisted state predates your change — treat it as untrusted input

An event-sourced store holds records written by every prior version of the code. A new required field is absent in every record written before it existed.

Found live: `merge_readiness_blocked` projections created before F13 contain no `evidenceReceipts` and no `resolvedHarnesses`; the read path returned that JSON unvalidated and recheck called `.map` on the missing array — **stranding runs that the previous code could recheck successfully.** There were such runs in the live store at the time.

**Rule:** validate and migrate at the READ boundary, and give absence its honest meaning. "Recorded before receipts existed" is legitimately empty, not an error — and equally, it is not evidence of a pass. Never crash on an old shape, and never fabricate a modern attestation from a record that predates attestation.

## 10. `fs.realpathSync` is not `realpath(3)` — a measured platform trap

Node's `fs.realpathSync` calls `path.resolve` FIRST, collapsing `..` **lexically** before resolving symlinks. Measured on this project: `realpathSync('<root>/escape/..')` returns `<root>`, where the kernel would give `<outside>/..`.

Live consequence found on main: `isWorkspaceWriteOperation` **admitted** `Write '<root>/escape/../pwned.txt'` — a structured write landing in the worktree's **parent**. A containment check built on `realpathSync` was therefore not containing.

**Rule:** for containment, refuse a `..` segment rather than resolving one, and resolve through real filesystem state component-by-component. Any check that normalises before resolving is lexical, whatever its name suggests. The same trap appeared independently in the dogfood tooling's path canonicaliser — assume it is everywhere until proven otherwise.

## 11. Report the deviation, do not hide it

Judgement calls that were flagged got endorsed or corrected on the merits; the process only breaks when a deviation is silent. Flag: instructions you did not follow and why, residuals your fix introduces, and anything a reviewer should attack hardest. An agent that corrected a *premise in its instruction* (a signal could not stay where the orchestrator assumed, because it was computed from code that had moved) produced the single best outcome of the day.
