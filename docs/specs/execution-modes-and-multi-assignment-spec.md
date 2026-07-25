# Execution modes + multi-assignment runs — design spec v1

**Status:** design draft, 2026-07-25. Author: orchestrator, from three user directives. Sequencing: **after** the current LAND window (F8–F11 + gate kit); codex spec review before any implementation.

**Directives being served (user, 2026-07-25):**
1. Worktrees become optional — a git start-checkpoint + revert is sufficient isolation for many runs.
2. Multiple implementors, spawned by coordinator decision based on the task.
3. Multiple folders (e.g. `backend/` + `frontend/`) → one agent per folder, or more.

These are one feature. Today's run model is `1 run = 1 assignment = 1 worktree = 1 implementor = 1 workspace root`. This spec generalizes it to `1 run = N assignments`, each with an **execution root**, an **execution mode**, and a **write scope**.

**The primary target shape (user, 2026-07-25): a single repository, no worktrees, multiple implementors.** Directives 1 and 2 compose directly in one checkout — see R2 below. Multiple folders/repos (directive 3) is a *generalization* of the same machinery, not a precondition for it.

---

## 1. The soundness rules everything else follows from

**R1 — Disjoint write scopes.** Two concurrently-driven assignments must never be able to write the same path. Enforced at spec-approval time (reject overlapping scopes) *and* at write time (each implementor's write-containment boundary is **its own scope**, not merely its root). Without R1, parallel implementors silently clobber each other and the verifier certifies whichever write landed last. This is the one property that makes parallelism safe in every shape below.

**R2 — Git state is per-tree; agent work is per-scope.** A single checkout has one `HEAD` and one index, so N assignments sharing a tree cannot land on N branches. But **implementors never perform git operations** — the host stages and commits after the turn (`implementor.ts:973-978`), and the agent only reads and writes files. Therefore N implementors CAN share one checkout: they write disjoint scopes concurrently, and the host produces **one commit** containing all of it.

That gives two parallel shapes, both valid, chosen per run:

| Shape | Physical layout | Commits | Verification | Cost / benefit |
|---|---|---|---|---|
| **Shared-tree parallelism** | one checkout (`in_place`), N implementors, disjoint scopes | **one** host commit | **one** verification against the full criteria set | No worktrees, no provisioning, no merge, no integration stage. Remediation re-drives only the implementor whose criteria failed — its writes land in the same tree and the host re-commits. **This is the "single repo, no worktrees, multiple implementors" shape.** |
| **Isolated parallelism** | N worktrees, one per assignment | N commits on N branches | per-assignment, then an integration stage (§3.4) | Full isolation and independent rollback per assignment; costs provisioning per worktree and an integration verification. |

Multi-repo (§3.5) is a variant of either: each repo is its own tree, so it is shared-tree parallelism per repo, composed for verification.

**The one real hazard in shared-tree mode is read consistency, not corruption.** Agent B may read a file agent A is mid-write. Writes cannot collide (R1 guarantees disjoint *write* sets), but a reader can observe an inconsistent intermediate. This is the same exposure two humans have working one checkout, and it is acceptable for cooperative agents — it must be documented, not designed away.

---

## 2. Execution modes (directive 1)

`assignment.executionMode: 'worktree' | 'in_place'`, resolved per assignment; run-level default via config `execution.defaultMode` (ships `'worktree'`).

### 2.1 `worktree` (today's behavior, unchanged)
`git worktree add` at the pinned base, single-writer lease, F7/F9 provisioning at the verify boundary, §16.3 validation, F8 receipt-bound resume. Full physical isolation; the primary checkout is never written.

### 2.2 `in_place` — the checkpoint/revert model
Work happens **in the actual checkout**, on a branch, with a durable start checkpoint.

**Entry (all fail-closed, in order):**
1. The existing §16.1 gate already applies: canonical root, resolved `HEAD^{commit}`, **empty ordinary porcelain status**. In-place mode does not relax it — it *depends* on it. A dirty checkout refuses, so no human work is ever inside the revert blast radius at entry.
2. Record the **start checkpoint**: `{ rootPath, baseSha, headRef, entryPorcelainDigest }` in one atomic engine write, before any agent spawns. This is the revert target and the F8-style receipt for the assignment.
3. Create and check out the assignment branch (`harness/assignment/<id>`) at `baseSha` — so the work is *always* on a branch, never on the user's branch. Record the pre-run `headRef` so exit can restore it.

**Why no provisioning:** the checkout already has `node_modules`. F7/F9 are structurally moot in this mode — no clone, no fingerprint, no marker, no install lane. **This is the mode's main practical win: the entire F7/F9/F10 failure class does not exist here.**

**Exit — success:** the implementor's work is committed on the assignment branch exactly as today; the verifier reads that commit; `merge_ready` reports it. Then restore the user's original `headRef` (branch survives for the human to merge). Identical downstream contract to worktree mode.

**Exit — failure/abandon (the revert):** `git reset --hard <baseSha>` + `git clean -fd` (never `-x`: ignored `node_modules` survives), then restore `headRef`. **Guarded:** before reverting, every dirty path must be attributable to this assignment — i.e. contained in the assignment's declared scope (R1). Any dirty path outside scope ⇒ **refuse to revert**, leave the tree exactly as-is, and surface it as an operator blocker. Never destroy work the engine cannot prove it created.

**The honest cost, stated:** in worktree mode the W3-1 drift guard can treat *any* primary-checkout change as contamination, because the implementor writes elsewhere. In-place mode makes the implementor the expected writer, so drift detection degrades from "any change is drift" to "any out-of-scope change is drift." A human editing an in-scope file mid-run is therefore indistinguishable from the agent. Mitigation: in-place runs record a per-assignment scope and the revert guard above; documentation states the contract as **do not edit files inside an active assignment's scope while it runs**. This is a real reduction in safety versus worktree mode and is why `worktree` stays the default.

**Crash recovery:** the start checkpoint is the receipt. On resume, `HEAD` must equal either `baseSha` (nothing committed yet → re-drive) or a durably-recorded assignment commit (F8 receipt semantics, unchanged). Anything else refuses — same fail-closed rule F8 establishes, just with the checkpoint's `baseSha` as the anchor.

---

## 3. Multi-assignment runs (directives 2 + 3)

### 3.1 Spec shape
The coordinator's spec gains an optional `assignments[]`. Each entry: `{ id, taskScope, writeScope: string[] (paths), executionRoot (default: the run's workspace root), executionMode?, proposedImplementor?, criteria: [ids] }`. A spec with no `assignments[]` is exactly today's single-assignment run — **full backward compatibility, no migration of existing runs.**

**The coordinator decides the decomposition** (directive 2), because it is the only role that has read the plan section and can judge task boundaries. It must justify each split and declare disjoint `writeScope`s.

### 3.2 Approval-time enforcement (R1)
At the spec-approval gate, refuse the spec if: any two `writeScope`s overlap (prefix containment or equality); any assignment's `writeScope` escapes its `executionRoot`; two `in_place` assignments share a root (R2); or any acceptance criterion is claimed by two assignments. Refusal is a spec-revision request, not a run failure — the human sees exactly which scopes collided. **This is the gate that makes parallelism safe, and it belongs at approval because the spec hash must bind the decomposition.**

### 3.3 Execution
Assignments run concurrently, each an independent implement→verify loop with its own worktree-or-root, lease, remediation budget, and role-round state. Existing infrastructure that already supports this: worktree handles are keyed `Map<AssignmentId, WorktreeHandle>` and leases are a path set (`manager.ts:146-147`) — the manager was written for N assignments; `maxLiveChildren` is a global, atomically-reserved, cross-process cap (raise its default when N > 1); `WaveId` is already reserved in the domain model (`entities.ts:124`). **What is missing is the flow layer, not the substrate.**

**Failure isolation:** an assignment that exhausts remediation fails *itself*. Sibling assignments continue. The run's terminal outcome is the join: all `merge_ready` → run `merge_ready`; any failed → run reports partial with per-assignment detail. A human decides whether a partial result is mergeable.

### 3.4 Verification (the part that needs a real decision)
Two-stage, because per-assignment verification alone cannot see integration breakage:
1. **Per-assignment verification** (parallel, cheap, bounded): the existing contract, scoped to that assignment's criteria and commit. This is what remediation loops against.
2. **Integration verification** (once, after all assignments reach per-assignment `merge_ready`). Two forms, by workspace topology:
   - **Same repository** (multiple scopes in one repo): an **integration branch** — base + each assignment commit merged in a deterministic order — verified as one tree. A merge conflict here is an **R1 violation that escaped approval**: report it as a scope-check hole, never attempt resolution.
   - **Separate repositories** (§3.5, the chosen shape): a **verification composition** — each repo checked out at its assignment's verified commit, verified side by side. Nothing is merged, so nothing can conflict.

   In both forms the engine **never merges to `main`**; the artifact is evidence for a human.

### 3.5 Multi-repository workspaces (directive 3 — **separate repos, user decision 2026-07-25**)

A run holds **N workspaces**, each an independent git repository (`backend/`, `frontend/`, …). Each assignment binds to exactly one workspace. Sub-directories of a single repo remain supported as the degenerate case (one workspace, multiple scopes).

**Per-workspace state — all of it, independently:**
- Its own pinned base commit + §16.1 clean-tree gate at entry (a dirty `frontend/` refuses the run, not just its assignment).
- Its own advisory lease. Already per-repo-root today (`advisory-lease.ts` writes under each repo's real `.git`), so concurrent runs across different repos are *already* mutually safe.
- Its own worktree manager (`GitWorktreeManager.open(repoRoot)` is per-root today) or, in `in_place` mode, its own checkpoint/revert.
- Its own F7/F9 provisioning — manifests, fingerprint, and `node_modules` are per-repo by construction. No change to `provision.ts`, which already takes a root.

**`RUN_META` gains `workspaces[]`** (replacing the single `workspacePath`). `RUN_META` is immutable and written once at creation (`projections.ts:14`), so this is a creation-time shape change with no migration of live runs; the single-workspace form remains valid.

**Integration verification, restated for separate repos.** There is no merged branch — there cannot be. Instead the engine composes a **verification composition**: each repo checked out at its assignment's verified commit, side by side, with the cross-repo verification commands run against that composition. This is strictly *better* than the single-repo merge-branch approach: nothing is merged, so nothing can conflict, and the composition is exactly what production would look like. The composition is identified durably as the tuple `{repoA@shaA, repoB@shaB, …}` and recorded as evidence.

**The hard limit, stated plainly: cross-repo merges are not atomic, and nothing can make them so.** The engine produces **N merge-readiness reports** — one per repo — plus a **composition binding** asserting these N commits were verified *together*. The report must say, in the operator-facing text: merging a subset breaks the verified composition. This is inherent to separate repositories (it is the reason monorepos exist); the engine's job is to make the coupling **visible and precise**, never to pretend it owns it.

**Base drift is now an N-way problem.** Each repo re-checks its pinned base at merge-readiness (§16 does this per-repo already). If repo B's default branch moved while the run was in flight, the composition verified is not the composition that will exist after merging — that is an `integration_blocked` condition naming the drifted repo, exactly like today's single-repo case, and the human re-checks after rebasing.

**Config:** run-level engine config with optional per-workspace overrides (provisioning strategy, execution mode, RSS budget). Anything not overridden inherits the run's pinned config, preserving today's immutability rule.

---

## 4. What this changes that is worth knowing

- **`merge_ready` becomes per-assignment plus a run-level join.** The UI's fleet/run model gains an assignment dimension (rail → run → assignments). Feed this into the UI plan before the Phase-B slices spec.
- **Cost scales with N** — N implementors + N verifiers + one integration verifier. Budget accounting is already per-role; it needs a per-assignment dimension.
- **The RSS watchdog and `maxLiveChildren`** need defaults revisited for N concurrent implementors (today's default of 3 total children is sized for serial runs).
- **In-place mode weakens drift detection** (§2.2) — documented, defaulted off, and the reason `worktree` remains the default.

## 5. Sequencing (recommended)

1. **LAND window first** (F8–F11 + gate kit) — nothing here is safe to build on a tree that cannot commit.
2. **Track A — `in_place` execution mode (directive 1).** Self-contained: no spec-schema change, no parallelism, immediate payoff (in-place runs skip the entire F7/F9 provisioning subsystem and its whole failure class). Ship with `worktree` as the default; `in_place` opt-in per run.
3. **Track B — shared-tree parallelism (directive 2, the target shape).** Spec gains `assignments[]` with write scopes; approval-time disjointness enforcement (R1); **write-time containment narrowed from root to scope** — the load-bearing change; concurrent implementor driving; one host commit; one verification. Deliberately EXCLUDES per-assignment branches, integration verification, and multi-root — none are needed for single-repo shared-tree parallelism, which keeps this track small.
4. **Track C — isolated parallelism + multi-root** (N worktrees / N repos, integration verification, composition bindings, §3.4–§3.5). The expensive generalization; do it only when a run genuinely needs per-assignment rollback or spans repositories. Best after the Control-UI MVP — supervising N isolated assignments through a CLI tail is exactly the misery the fleet rail exists to remove.

**Tracks A and B together deliver the user's stated need** (single repo, no worktrees, multiple implementors) and are individually small. Track C is optional and can be deferred indefinitely without blocking them.

Open questions for codex spec review: (a) is approval-time scope disjointness sufficient, or must write-time containment be per-assignment-scope rather than per-root? (b) integration-branch merge order determinism and its interaction with the verifier's exact-commit rule (same-repo form only); (c) whether an in-place assignment should hold the run-ownership lease for its whole life (it mutates a shared checkout, so probably yes, exclusively per root); (d) whether per-assignment remediation budgets should share a run-level ceiling; (e) **multi-repo specific:** the run-ownership lease is per-run but leases are per-repo — does an N-workspace run need an all-or-nothing lease acquisition across N repos (deadlock risk with two multi-repo runs acquiring in different orders → require a canonical ordering), and what is the correct partial-failure behavior when repo B's lease is held but repo A's is not; (f) **multi-repo specific:** how the composition binding is represented durably so a later `recheck` can re-verify the exact tuple, and whether a per-repo `merge_ready` should be *withheld* until the composition passes (safer, but blocks a legitimately independent repo) or issued with an explicit composition caveat (chosen default: issue with the caveat, because withholding would let one repo's failure hostage another's verified work).
