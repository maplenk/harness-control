# The autonomous base — plan

**Goal (user, 2026-07-25):** a base system that can build the UI on its own — auto-approval, coordinator, multiple implementors, worktrees optional, verifier. The human reviews merges, not specs.

---

## 1. The design consequence that shapes everything else

Today the run has **two** human gates: approve the spec (input) and merge the result (output). Auto-approval removes the first. That is a defensible trade — the merge gate is the more meaningful control, since it is where the actual code enters your repository — but it has a direct consequence:

> **With auto-approval, the verifier becomes the only automated check standing between a coordinator's plan and a `merge_ready` report.**

And the verifier's evidence is currently **model-authored prose**. `deriveRequiredTestsPassed` accepts `verdict === 'passed'` plus any non-empty evidence ref; the host already runs the declared commands and **discards the result** (`verificationPassed` has zero readers). Nothing enforces that the verifier is a different vendor from the implementor.

So: **F13 stops being a quality improvement and becomes the precondition for autonomy.** Without it, an autonomous run has no human reviewing the spec *and* no host-attested proof of the tests — a `merge_ready` would rest entirely on one model's say-so. With it, the trade is sound: the human moves from reviewing intentions to reviewing verified outcomes.

This also deliberately reverses a stated PLAN invariant ("immutable spec versions + explicit human approval — always, no auto-approve path"). That reversal should be recorded in PLAN.md rather than left as a silent contradiction.

---

## 2. What gets built

**B1 — F13, verification integrity** *(prerequisite, not optional)*
Spec: `docs/specs/f13-attested-verification-spec.md`. Three parts, smaller than they look:
- Wire the host's already-computed verification result so it **gates** (and fix the two comments at `implementor.ts:61`/`:720` that claim it already does).
- Role-independent stop-reason adjudication, so a verifier turn ending `refusal`/`max_turn_requests` after emitting a passing report cannot report success.
- Cross-vendor independence as an enforced invariant: refuse a verifier whose harness equals the implementor's, with a knowing opt-out, and record the resolved pair in the readiness report.

**B2 — Auto-approval mode** *(small)*
`approval: 'human' | 'auto'`, default `human`. Under `auto`, the engine binds the drafted spec hash itself and proceeds — the spec stays immutable and hash-bound, it is simply the engine that signs it. **Keep the testability gate strict** (`assessSpecSemantics` already rejects criteria with no concrete observable) — under autonomy it is the only thing filtering an unusable spec before work starts. Every auto-approval is evented so the audit trail shows no human signed it.

**B3 — In-place execution mode** *(medium; deletes more than it adds)*
Per the execution-modes spec: work directly in the checkout on a branch, with a durable start checkpoint (`{baseSha, headRef, porcelainDigest}`) recorded before any agent spawns, and revert-on-failure guarded so it never destroys a path outside the assignment's declared scope. Entry keeps today's clean-tree requirement, so nothing of yours is in the blast radius.

**Why this matters more than it looks:** in-place runs skip provisioning entirely — no clone, no fingerprint, no marker, no install lane. **The whole F7/F9 failure class, which has cost sixteen review rounds, structurally does not exist in this mode.**

**B4 — Multiple implementors, shared tree** *(medium)*
The coordinator decomposes the task into N assignments, each with disjoint `writeScope` paths. The approval gate refuses overlapping scopes (under auto-approval, this check is *mandatory* — it is the only thing preventing two agents clobbering each other). Write containment narrows from the worktree root to each assignment's own scope. N implementors work concurrently in the same checkout; the host produces **one commit**; **one verifier** checks it against the full criteria set. Remediation re-drives only the implementor whose criteria failed.

This works because implementors never run git — the host commits — so a single `HEAD` and index are not contended.

---

## 3. Sequence

1. **Land the current branch** (F8–F11, in final review). F10 is the blocker: the engine cannot commit on git 2.55 until it merges.
2. **B1 (F13)** — before any autonomy. This is the one item I would not compress.
3. **B2 (auto-approval)** — small; ships with B1 or immediately after.
4. **B3 (in-place)** — self-contained, immediate payoff, no schema change.
5. **B4 (multi-implementor)** — the largest piece; scope enforcement is the load-bearing part.

Then: point it at the UI plan and let it grind slices, with you reviewing merges.

---

## 4. What still stops a bad autonomous run

Worth being explicit, since removing a gate invites the question:

- The **testability gate** rejects specs whose criteria have no concrete observable (kept strict).
- **Scope disjointness** is enforced at approval and at the write boundary.
- **Host-attested evidence** (B1) means the tests actually ran, at that commit, with that exit code.
- **Cross-vendor verification** (B1) means the checker is not the author.
- **Bounded remediation** still terminates.
- **Nothing auto-merges.** You review every result.
- The **event log** records every decision, including that no human approved the spec.

The failure mode this cannot prevent: a coordinator producing a *coherent, testable, verifiable* spec that is nonetheless the wrong work. That is exactly what the merge review is for — and it is why the human gate moves rather than disappears.
