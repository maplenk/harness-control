# Codex diff-review of F7 implementation (commit a43eeaf) — 2026-07-22

Verdict: NEEDS-FIX (8 blockers + 1 high + 1 medium).

## 1. Prioritized findings

1. **Blocker — no-dependency shortcut can commit `node_modules`, green the run, or retain a write-through primary symlink.** The implementor commits with `git add -A` before provisioning (`src/app/flows/implementor.ts:941`, `:967`). Provisioning then derives `declaresDeps` only from package manifests and returns before tracked/ignored/symlink checks (`src/worktree/provision.ts:319`, `:425`, versus `:433`, `:444`). Scenario: a remediation round already has provisioned `node_modules`; the implementor removes dependency fields and the ignore rule. `node_modules` enters the commit, provisioning reports success, and verifier commands can use the now-tracked toolchain and reach `merge_ready`. An ignored `node_modules` symlink to primary likewise survives the shortcut, allowing commands to write through it.

2. **Blocker — a populated-but-broken tree is accepted without the required `.bin/` proof.** Clone eligibility tests only “non-empty” (`src/worktree/provision.ts:530`, `:535`), and short-circuit checks only directory plus marker (`:461`, `:462`); staged output is marked without validating `.bin` (`:501`, `:504`). Scenario: primary contains only `.package-lock.json`/one package, or a matching worktree marker remains after `.bin` disappears. Provisioning succeeds, then verifier commands may resolve a global `tsc`/`vitest` and falsely green the run.

3. **Blocker — Git/manifests errors are classified as safe absence.** `readFileAtHead` returns `undefined` for every nonzero status (`src/worktree/git.ts:323`, `:325`); `isPathTracked` treats exit 128/spawn failure as “not tracked” (`:315`, `:317`); malformed package JSON is treated as declaring no dependencies (`src/worktree/provision.ts:279`, `:285`). A transient `git show HEAD:package.json` failure therefore reaches the no-dependency success path and can dispatch self-check/verifier instead of failing closed.

4. **Blocker — crash recovery deletes the only rollback copy.** The first swap rename removes the old tree from the worktree (`src/worktree/provision.ts:597`, `:600`). After a crash before move-in, next-call GC blindly deletes the entire stage, including `old-*` (`:404`, `:408`, `:620`, `:630`), rather than restoring it when the target is absent. If rebuilding subsequently fails, the previously valid worktree tree is permanently lost.

5. **Blocker — the fingerprint does not bind all valid workspace manifests.** Workspace matching supports only literal segments and single `*`; `**` is explicitly unsupported (`src/worktree/provision.ts:245`, `:272`, `:276`). Scenario: root uses `workspaces: ["packages/**"]` and has no root dependencies, while a nested workspace declares dependencies. No workspace is collected (`:320`), the repository is classified dependency-free (`:326`, `:425`), and verification can run against a global/stale toolchain. With root dependencies, nested package-only edits are omitted from the fingerprint and can stale-short-circuit or clone.

6. **Blocker — symlink containment is not fail-closed on traversal errors.** A failed directory read is silently skipped (`src/worktree/provision.ts:357`, `:360`), and the scan can return no violations (`:385`). An unreadable cloned subtree containing an absolute or escaping symlink is therefore marked and installed; after permissions change, commands can follow it into primary or outside the worktree.

7. **High — hypothesis: normal npm workspace links are rejected as escaping.** The scan bounds links to the staged `node_modules` root (`src/worktree/provision.ts:351`, `:378`), not their eventual location inside the worktree. Standard npm workspace output such as `node_modules/pkg -> ../packages/pkg` is safe after move-in but appears to escape this root. Clone falls back to install, then the identical installed link fails closed (`:485`, `:489`, `:493`). This likely breaks real npm-workspace repositories.

8. **Blocker — a tracked `node_modules` symlink is deleted before the tracked-path preflight.** The link is removed at `src/worktree/provision.ts:433-435`; tracking is checked only afterward at `:444-448`. A dependency-bearing repository with a tracked symlink is mutated into a dirty deletion before returning `provisioning_failed`. The target is not deleted, but worktree state is corrupted.

9. **Medium — some provisioning failures never surface as `provisioning_failed`, and successful reporting is stale.** The deliverable adjudicator prioritizes abnormal/no-commit results without checking `provisioningFailed` (`src/app/flows/deliverable.ts:11`, `:20`). In a remediation round with no new commit, provisioning failure becomes `NoDeliverableError` before the loop’s flag check (`src/app/flows/orchestrate.ts:613`, `:657`). When the flag is observed, the loop breaks before resolving the new HEAD (`:657`, `:688`) or recording the round (`:795`), so `implementationCommit`/round count can describe older state.

## 2. Verdict

**NEEDS-FIX.**

Required changes: protect the implementor commit from staging `node_modules`; run definitive tracked/ignore and symlink checks before every trivial success; require a real `.bin/`; distinguish Git absence from Git failure; restore `old-*` before stage GC when the target is missing; support or fail closed on all workspace patterns; scan against the eventual worktree boundary with traversal errors fatal; check tracking before unlinking; and prioritize provisioning failure over deliverable adjudication while capturing the committed HEAD/round.

## 3. Must-add tests

- Remediation with an existing provisioned tree where dependencies and the ignore rule are removed; assert no `node_modules` enters HEAD and no verifier runs.
- No-dependency repository with tracked `node_modules`, plus an ignored symlink to primary; assert fail-closed and primary unchanged.
- Matching marker and populated primary with missing/non-directory `.bin`; assert rebuild or failure, never short-circuit.
- Crash immediately after move-aside, followed by a failing rebuild; assert the old tree is restored.
- Inject `git show`/`ls-files` exit 128 and malformed package JSON; assert `provisioning_failed`.
- `packages/**` workspace fingerprint tests and a real `npm ci` workspace-link test.
- Tracked `node_modules` symlink failure must leave the link/worktree unchanged.
- Round-2 no-commit provisioning failure must return `provisioning_failed` with the actual HEAD and round recorded.
