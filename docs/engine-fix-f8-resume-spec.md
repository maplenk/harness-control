# Engine Fix — Resumable Interrupted Implementor Rounds (F8) — v2

**Status:** spec v2 (receipt-bound acceptance, after codex review of v1) — implementation → codex diff-review → land
**Severity:** HIGH — an implementor round that dies inside the window between `commitAll` and **durable round completion** is permanently unresumable. That window is narrow in wall-clock, but it is precisely the moment when the round's entire output exists only as a commit the engine has not yet recorded, so a crash there costs the whole round.
**Surfaced by:** dogfood run `run_8aa51aea…` (slice 1a), diagnosed 2026-07-25. `resume` failed closed: checkpoint `36101cf1`, HEAD `ef952b1` — the implementor's OWN final commit read as tamper.
**Root cause (structural, not a bug in any one line):** the checkpoint boundary and the commit boundary are different boundaries, and §16.3 compares across them.
**Fix shape:** **(C)** write the `pre_verify_handoff` checkpoint PLAN §12.2 already mandates, and accept drift **only against a durable engine receipt** (§2.1). v1 proposed bare forward-containment (`merge-base --is-ancestor`); codex demonstrated the bypass, so ancestry is demoted to a secondary sanity check and the former "(B)" — binding validation to the engine's persisted round commit — is now the **core** of the rule rather than a deferral.
**Schedule:** engine track with F9/F10/F11; lands before slice 2a, where a mid-run crash costs a full expensive redo. Until it lands the only recovery is a fresh slice.

---

## 1. Problem

Cadence checkpoints fire at **prompt-turn boundaries**: `service.ts:4064` → `#maybeCadenceCheckpoint` → `#writeStopCheckpoint` (the only writer, `service.ts:3983`), capturing `WorktreeState.headSha` from **live HEAD** (`service.ts:5824,5828`).

The implementor commits only **after** its turn loop: turns at `implementor.ts:945-954`, then stage+commit at `implementor.ts:969-978`.

So every cadence checkpoint taken during an implementor round records the **pre-commit** HEAD. On resume, the interrupted-implementor branch (`orchestrate.ts:430`) calls `validateWorktree` (`validate.ts:210`), whose drift test (`validate.ts:244-253`) refuses on **any** `HEAD ≠ checkpoint.headSha`:

```
HEAD drifted since the last checkpoint (checkpoint=…, current=…); refusing to resume in place.
```

→ `refuse_resume` → re-tainted `reconcile_mismatch` (`manager.ts:431`).

The refusal is correct in intent (tamper detection) and wrong in discrimination: it cannot tell **the implementor's own forward commit** from **a rewritten history**. PLAN §12.2 mandates a `pre_verify_handoff` checkpoint that would carry the committed HEAD and close the window; the reason exists in the vocabulary (`state.ts:349-354`, `src/checkpoint/cadence.ts:27,38`) with **zero writers** in production code (only tests reference it).

---

## 2. Contract

### 2.1 Receipt-bound acceptance in §16.3

In the **interrupted-implementor validation path only**, drift from `checkpoint.headSha` is accepted **if and only if current HEAD equals a commit the engine itself durably recorded for this round** — the `pre_verify_handoff` checkpoint's `headSha` (§2.2) or the persisted `lastImplementationCommit`. On a receipt match, do not refuse on drift alone; continue the remaining §16.3 checks (dirt policy, taint, identity) unchanged.

**Bare ancestry is NOT sufficient and must not be used as the acceptance rule.** "Current HEAD is a descendant of the checkpoint" is trivially satisfiable by anyone who can write to the worktree: append any commit — arbitrary content, arbitrary author — and containment holds. That turns the tamper check into a formality, which is the opposite of §16.3's purpose. Ancestry may remain as an **additional** sanity assertion layered on top of the receipt match (the receipt should also be a descendant of the checkpoint; if it is not, something is wrong on the engine's side and the fail-closed answer is still refusal). It may never substitute for the receipt.

Everything else stays `refuse_resume`: no receipt recorded for the round, HEAD matching no receipt, diverged branch, reset, amend, unknown or detached HEAD. **Probe and lookup errors are refusals, never acceptances** (fail-closed): a corrupt object store, an unreadable checkpoint, or any git failure during the comparison is treated exactly like divergence.

### 2.2 (C) Write the `pre_verify_handoff` checkpoint

Immediately after `commitAll` in the implementor flow (`implementor.ts:978`), **before** the provisioning boundary / verify handoff, write a checkpoint with the already-declared reason `pre_verify_handoff` carrying the **committed** HEAD. It resets the cadence window like any checkpoint (`service.ts:4042`).

This closes the flow-to-loop window in which a commit exists but `lastImplementationCommit` (written at `orchestrate.ts:695`, read at `:986-1000`) is not yet recorded — and under §2.1 it is not merely a nicety: **it is the receipt** that makes the resume acceptable at all. Without it, a crash inside that window leaves no engine record of the commit, and §2.1 correctly refuses. (C) is therefore load-bearing, not cosmetic, and it is exactly what PLAN §12.2 asked for.

The checkpoint write must be durable **before** the round can be considered resumable-with-drift; a receipt that is only in memory is not a receipt.

### 2.3 Unchanged

- Verifier re-entry semantics — already forced to the round's `implementationCommit` via `discardToCommit` (`orchestrate.ts:742,353`).
- Completed-implementor adoption — already binds the persisted `lastImplementationCommit` (`orchestrate.ts:399-415`).
- The F7 provisioning boundary; all dirty-tree, symlink, and taint policies outside the drift test.

### 2.4 Superseded

- v1's **(A) bare forward-containment acceptance** is withdrawn — see §2.1 for why containment alone is bypassable.
- v1's **(B) binding interrupted-round validation to the persisted round commit** is no longer deferred; it *is* the acceptance rule now, generalized to "any durable engine receipt for this round" so that the `pre_verify_handoff` checkpoint and `lastImplementationCommit` are both admissible.

---

## 3. Acceptance criteria (each machine-checkable)

- **AC-1 resume the real shape** — simulated crash after `commitAll` (with its `pre_verify_handoff` receipt durably written) but before any later checkpoint → `resume` adopts the worktree and verification dispatches against the committed HEAD; no `refuse_resume`.
- **AC-2 tamper still refused** — a worktree whose HEAD is NOT a descendant of the checkpoint (amend / reset / diverge) → `refuse_resume` + `reconcile_mismatch`.
- **AC-2b the bypass is closed (the point of v2)** — HEAD is a *descendant* of the checkpoint but matches **no** engine receipt (an extra commit appended into the worktree after the round's own commit) → `refuse_resume`. A bare-ancestry implementation passes AC-1 and AC-2 and **fails this one**; it is the discriminating test between v1 and v2.
- **AC-2c no receipt, no acceptance** — crash after `commitAll` but *before* the receipt is durable → `refuse_resume` (the engine cannot vouch for that commit). This is the honest cost of fail-closed, and it bounds the vulnerable window rather than papering over it.
- **AC-3 the checkpoint exists** — a committing implementor round writes exactly **one** `pre_verify_handoff` checkpoint whose `worktree.headSha` equals the implementation commit, and the cadence window resets.
- **AC-4 fail-closed probe** — receipt lookup or ancestry-probe failure (corrupt object store / unreadable checkpoint / git error) → `refuse_resume`, never acceptance.
- **AC-5 regression discipline** — AC-1's test demonstrably FAILS on pre-F8 code. Run it against the parent commit first, as with the F7 round-5 failover test.

---

## 4. Codex spec-review focus

Attack specifically:

1. **Taint lifecycle interaction with receipt acceptance.** Does an accepted receipt-matched drift clear or carry taint (`manager.ts:431` clears `#taints` only on non-refusal)?
2. **Invariant meaningfulness of (C).** Must the new checkpoint also snapshot `statusPorcelain`/`diffHash` post-commit to keep the rest of `validate.ts`'s comparisons meaningful, or does a post-commit-clean tree make them trivially equal?
3. **Re-adjudication vs re-driving.** When a commit already exists for the round, should the interrupted path route to the *completed-round* path (adjudicate the deliverable) instead of re-driving a turn?
4. **Other consumers.** Any resume path outside `orchestrate.ts:353` that consumes `checkpoint.worktree`.
