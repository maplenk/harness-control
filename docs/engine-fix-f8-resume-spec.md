# Engine Fix — Resumable Interrupted Implementor Rounds (F8) — v1

**Status:** spec v1 — codex spec-review, then implementation → codex diff-review → land
**Severity:** HIGH — **any** implementor round that commits and then dies before the next cadence checkpoint is permanently unresumable. Not an edge case: committing is the round's last act, so the window is every round's tail.
**Surfaced by:** dogfood run `run_8aa51aea…` (slice 1a), diagnosed 2026-07-25. `resume` failed closed: checkpoint `36101cf1`, HEAD `ef952b1` — the implementor's OWN final commit read as tamper.
**Root cause (structural, not a bug in any one line):** the checkpoint boundary and the commit boundary are different boundaries, and §16.3 compares across them.
**Fix shape (locked for review):** **(A)** forward-containment acceptance + **(C)** write the `pre_verify_handoff` checkpoint PLAN §12.2 already mandates. **(B)** deferred (§4).
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

### 2.1 (A) Forward-containment acceptance in §16.3

In the **interrupted-implementor validation path only**: if `checkpoint.headSha` is a strict ancestor of current HEAD (`git merge-base --is-ancestor`), the drift is implementor-authored forward motion — **do not refuse on drift alone**; continue the remaining §16.3 checks (dirt policy, taint, identity) unchanged.

Any **non-descendant** divergence — diverged branch, reset, amend, unknown or detached HEAD — stays `refuse_resume`. **Ancestry-probe errors are refusals, never acceptances** (fail-closed): a corrupt object store or any git failure during the probe is treated exactly like divergence.

### 2.2 (C) Write the `pre_verify_handoff` checkpoint

Immediately after `commitAll` in the implementor flow (`implementor.ts:978`), **before** the provisioning boundary / verify handoff, write a checkpoint with the already-declared reason `pre_verify_handoff` carrying the **committed** HEAD. It resets the cadence window like any checkpoint (`service.ts:4042`).

This closes the flow-to-loop window in which a commit exists but `lastImplementationCommit` (written at `orchestrate.ts:695`, read at `:986-1000`) is not yet recorded. (A) alone would already accept the resume; (C) makes the checkpoint *true* rather than merely *tolerated*, and is the thing PLAN §12.2 asked for.

### 2.3 Unchanged

- Verifier re-entry semantics — already forced to the round's `implementationCommit` via `discardToCommit` (`orchestrate.ts:742,353`).
- Completed-implementor adoption — already binds the persisted `lastImplementationCommit` (`orchestrate.ts:399-415`).
- The F7 provisioning boundary; all dirty-tree, symlink, and taint policies outside the drift test.

### 2.4 Explicitly deferred

- **(B) binding interrupted-round validation to `lastImplementationCommit`** — redundant once (C) exists. Revisit only if codex finds a hole (C) leaves open.

---

## 3. Acceptance criteria (each machine-checkable)

- **AC-1 resume the real shape** — simulated crash after `commitAll` but before any later checkpoint → `resume` adopts the worktree and verification dispatches against the committed HEAD; no `refuse_resume`.
- **AC-2 tamper still refused** — a worktree whose HEAD is NOT a descendant of the checkpoint (amend / reset / diverge) → `refuse_resume` + `reconcile_mismatch`.
- **AC-3 the checkpoint exists** — a committing implementor round writes exactly **one** `pre_verify_handoff` checkpoint whose `worktree.headSha` equals the implementation commit, and the cadence window resets.
- **AC-4 fail-closed probe** — ancestry-probe failure (corrupt object store / git error) → `refuse_resume`, never acceptance.
- **AC-5 regression discipline** — AC-1's test demonstrably FAILS on pre-F8 code. Run it against the parent commit first, as with the F7 round-5 failover test.

---

## 4. Codex spec-review focus

Attack specifically:

1. **Taint lifecycle interaction with (A).** Does an accepted forward-drift clear or carry taint (`manager.ts:431` clears `#taints` only on non-refusal)?
2. **Invariant meaningfulness of (C).** Must the new checkpoint also snapshot `statusPorcelain`/`diffHash` post-commit to keep the rest of `validate.ts`'s comparisons meaningful, or does a post-commit-clean tree make them trivially equal?
3. **Re-adjudication vs re-driving.** When a commit already exists for the round, should the interrupted path route to the *completed-round* path (adjudicate the deliverable) instead of re-driving a turn?
4. **Other consumers.** Any resume path outside `orchestrate.ts:353` that consumes `checkpoint.worktree`.
