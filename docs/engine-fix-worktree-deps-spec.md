# Engine Fix — Worktree Dependency Provisioning (F7) — v3

**Status:** spec v3 (post codex reviews v1+v2), pending implementation → codex diff-review → land
**Severity:** HIGH — blocks every dogfood run whose acceptance criteria use `npm run typecheck`/`npx vitest`. False-negative run failures.
**Surfaced by:** dogfood run `run_8aa51aea` (§3A.1), 2026-07-22.
**Primitive (user decision):** real git-ignored `node_modules` **directory** via APFS copy-on-write clone when manifests match primary, else `npm ci`. NOT a symlink (codex v1).
**Scope (user decision, 2026-07-22):** **MVP-correct, defer adversarial hardening.** Rationale: the dogfood implementor is cooperative and FS-sandboxed; the realistic failure is "verification can't run," not "malicious implementor forges a green." The accidental false-green is closed by the fail-closed gate. Hardening against a *malicious* implementor is deferred + tracked (§5). Reviews: `docs/engine-fix-worktree-deps-review-codex-v2.md` + codex job logs.

---

## 1. Problem
`git worktree add` (`manager.ts:248`) never provisions deps; `node_modules` is git-ignored, so the worktree has source but no toolchain. Both the host-side implementor self-check runner (`implementor.ts:927`, cwd=worktree) and the independent verifier (`verifier.ts:989`, cwd=worktree) then get `tsc`/`vitest` → **exit 127**; the read-only verifier can't gather evidence → all criteria `unproven` → remediation burns rounds on unactionable fixes → terminal `NoDeliverableError`. **Empirically:** with deps present at grok's commit `ef952b1`, `npm run typecheck` → exit 0 and `npx vitest run src/app/commands src/cli/commands.test.ts` → 40/40 pass. The implementation was correct; the run false-negatived because verification couldn't execute.

---

## 2. Design v3 — MVP core

### 2.1 The boundary (codex v2 BLOCKER-1)
Provisioning happens **once per round, after the implementor commit and before ANY host command execution** — i.e. before the implementor flow's self-check runner (`implementor.ts:927`) and before verifier dispatch (`orchestrate.ts:701`). NOT at worktree-create (the implementor may edit manifests in its turn). It is keyed to the **committed HEAD's** manifests, so remediation rounds re-provision against whatever the implementor just committed.

### 2.2 The locked operation — `provisionForVerification(assignmentId)`
A new **composite, mutex+advisory-lease-held** manager method (codex v2 HIGH-5: one lock around reconcile→provision→register; do not scatter across `reattach`/`reacquireLease`). Called unconditionally at the boundary for the round, covering both roles. Steps:

1. **check-ignore preflight (codex v2 HIGH-7 / BLOCKER-1).** Verify `node_modules` is ignored in *this* repo (`git check-ignore node_modules` / `git ls-files --error-unmatch` negative). If it is NOT ignored, or a `node_modules` path is tracked → **fail closed** (do not provision, do not verify; distinct outcome). Never risk staging deps into a commit.
2. **Read committed manifests.** From the worktree HEAD: `package.json` (root + any workspaces), `package-lock.json`, and effective `.npmrc`. Compute a **dependency fingerprint** = hash over all of them (codex v2 BLOCKER-1: not lockfile-only). This fingerprint is the provenance key.
3. **Short-circuit (idempotent).** If `<worktree>/node_modules` is a real directory (reject a symlink) with `.bin/` and a `.harness-provisioned` marker whose fingerprint == current → no-op.
4. **Choose strategy:**
   - **Clone** iff the worktree fingerprint == the primary checkout's fingerprint AND primary `node_modules` exists AND APFS clone is supported: `cp -c -R` the primary tree into an **out-of-worktree stage** (§2.3).
   - **Install** otherwise (fingerprint differs, primary absent, or non-APFS): `npm ci --prefer-offline --no-audit --fund=false --ignore-scripts` (codex v2 HIGH-6: `--ignore-scripts` is the MVP script mitigation) with `cwd` = the **stage** (a checkout-free copy is not needed; run in a stage dir seeded with the worktree's manifests, then move node_modules in — or run in-worktree only when no valid tree exists to lose; see §2.3).
   - If manifests declare **no** dependencies → provisioned-trivially-true (skip is legitimate ONLY here). If they declare deps and neither path can produce a tree → **fail closed**.
5. **Symlink containment scan (codex v2 HIGH-4).** After clone/install, scan the tree for **absolute** or **worktree-escaping relative** symlinks. Relative in-tree links (e.g. `.bin/tsc → ../typescript/bin/tsc`) are fine. Any escaping/absolute link → discard the tree and `npm ci` fresh, or fail closed. (This repo currently has only safe relative `.bin` links.)
6. **Purge transient caches (codex v2 HIGH-4).** Remove any cloned `node_modules/.vite` (and other known build caches) so stale cache state is never inherited; a fresh per-worktree cache is created on first use.
7. **Write marker** `.harness-provisioned` = the dependency fingerprint (after install, so `npm ci` can't wipe it).

### 2.3 Transaction — out-of-worktree, recoverable (codex v2 BLOCKER-3)
- **Stage OUTSIDE the git worktree**, on the same filesystem (e.g. `<managerBaseDir>/.provision/<assignmentId>-<rand>/node_modules`), so no `node_modules.tmp-*` ever exists inside the worktree (that path is NOT gitignored → would be committed on crash — the exact footgun v2 reintroduced).
- Build fully in the stage; then a **move-aside/move-in** swap: if a prior `<worktree>/node_modules` exists, `rename` it to a stage-side `old-<rand>`; `rename` the new tree into place; delete `old-<rand>`. (Plain `rename` cannot overwrite a non-empty dir — POSIX `ENOTEMPTY` — so it is a two-rename swap, not one, all under the lock.)
- **Rollback:** any failure before the final move-in leaves the pre-existing tree untouched; a failure mid-swap is recovered by a **stage-GC preflight** on the next `provisionForVerification` call (adopt-or-remove any `old-*`/stage dirs for this assignment). Never leave a partial tree in the worktree.

### 2.4 Fail-closed gate (codex v2 BLOCKER-2, MVP core)
If `provisionForVerification` returns unproven or throws, the round **halts before any host command or verifier dispatch** with a distinct terminal outcome `provisioning_failed` (a new run/verification outcome, surfaced with an operator-actionable message: which repo, which manifest fingerprint, clone-vs-install path, and the failure). **No self-check runner, no verifier, no `merge_ready`.** This is the safe direction: a run can never be greened by an inherited global `tsc`/`vitest` or an `npx` download when local provisioning didn't happen. (Full host-attested runtime provenance woven into merge-readiness is DEFERRED — §5 — but fail-closed already prevents the *accidental* false-green, which is the MVP threat.)

### 2.5 Removal (confirmed safe by codex v2)
`removeWorktree`→`git worktree remove --force` deletes only the worktree's own real `node_modules` (a COW copy) — no symlink, no footgun. Add a stage-GC on removal for this assignment's `.provision/` entries. Regression test asserts the primary `node_modules` survives every deletion path.

---

## 3. Config (codex v2 HIGH-8)
- `src/config/schema.ts`: add `worktree?: { provision?: 'auto' | 'clone' | 'install' | 'none' }`, default `'auto'`.
- `WorktreeManagerOptions` (`manager.ts:52`): `provision` strategy + a structured `warn(event)` sink + the managerBaseDir stage root.
- `src/cli/index.ts:264`: plumb config + warning sink.
- **Platform:** `cp -c` is macOS/APFS; on unsupported platforms `'auto'`/`'clone'` fall back to `'install'`; log the path taken.

---

## 4. Acceptance criteria (v3)
- **AC-1 git-invisibility** — after a real round, `node_modules` (and any staging path) is absent from `git status`, `git diff --name-only <base>`, and the commit; survives `git clean -fd`. Includes a `git check-ignore` assertion.
- **AC-2 primary safety** — `removeWorktree`, `discardToCommit` (`git clean -fd`), and `rm(baseDir)` each leave the primary `node_modules` fully intact.
- **AC-3 boundary + manifest binding** — provisioning runs AFTER the implementor commit and BEFORE both host self-check and verifier, keyed to the committed manifests. Lock-only, package.json-only, workspace, and `.npmrc` changes each re-provision correctly (clone when fingerprint matches primary, else `npm ci`). Never clones an unproven source.
- **AC-4 fail-closed (no accidental false pass)** — a provisioning failure (or a repo where `node_modules` isn't ignored / is tracked) yields terminal `provisioning_failed`; **no** verifier dispatch and **no** `merge_ready`. Test: with local provisioning forced to fail but a global `tsc`/`vitest` on PATH, the run does NOT go green.
- **AC-5 isolation + idempotency** — cache writes stay in `<worktree>/node_modules/.vite`; cloned `.vite` is purged; provisioning twice is a no-op (fingerprint marker); the symlink-containment scan rejects absolute/escaping links.
- **AC-6 transactional degrade** — injected failure during clone/`npm ci`/swap/marker-write leaves any pre-existing tree intact, no staging artifact inside the worktree, and is recovered on the next call; worktree lifecycle still succeeds.
- **AC-7 locking coverage** — provisioning is one mutex+lease-held op at the boundary, exercised for fresh verify, remediation re-verify, resume-after-`discardToCommit`, and verifier failover/auto-respawn; none WIP-commit dependency plumbing or race.
- **AC-8 end-to-end** — re-verifying `ef952b1` through the fixed engine reaches `merge_ready`; full suite + `npm run typecheck` green on both SQLite drivers.

## 5. DEFERRED hardening (tracked follow-ups — malicious-implementor / crash-edge threat)
Documented, not built now (user scope decision; justified by cooperative FS-sandboxed implementor + fail-closed already closing the accidental false-green):
1. **Runtime toolchain provenance in merge-readiness** — host captures the resolved `tsc`/`vitest` path+version and threads an attestation into the runner outcome + merge-readiness trust logic, so a forged marker or global/npx binary cannot be trusted even past the gate (codex v2 BLOCKER-2 full).
2. **Full npm lifecycle sandbox** — beyond `--ignore-scripts`: minimal env, credential stripping, PGID+timeout cleanup, FS/network confinement for any install (codex v2 HIGH-6).
3. **Writable-tree integrity re-check** — verify the agent-writable provisioned tree wasn't mutated between provisioning and verification.
4. **Full crash-recovery state machine** — richer than the §2.3 stage-GC (journaled provisioning states).
5. **Real npm-workspace provisioning** — repos declaring `workspaces` currently FAIL CLOSED (never false-green); cloning/installing workspace-local `packages/*/node_modules` trees is deferred (codex diff-review round 2, #2/#7).
6. **Nested `packages/*/node_modules` handling** — the implementor-commit exclusion + preflight cover the root `node_modules` only; nested trees are out of scope while workspaces fail closed (round 2, #3).
7. **Realpath filesystem symlink-chain containment** — the containment scan is lexical (resolves each link against its eventual worktree path); a `realpath`-based check that follows symlink *chains* to their real target is deferred. This repo has no tracked in-tree symlinks (round 2, #5).
8. **npm environment / `.npmrc` isolation** — the `npm ci` install path runs with the full orchestrator environment and trusts a committed `.npmrc`; a *malicious* committed `.npmrc` could redirect npm cache/log writes into the primary checkout or expand ambient tokens into registry auth. Deferred: minimal env, isolated HOME/userconfig/cache, and rejecting path-escaping npm settings (part of the §5.2 npm-sandbox hardening). Malicious-implementor threat; the dogfood uses the CLONE path (not `npm ci`) and grok is cooperative (codex diff-review round 3, #4).

## 6. Test matrix (codex v2 must-add, MVP-scoped)
package-only / lock-only / both / workspace / `.npmrc` change → reprovision-after-commit asserted • primary absent/hollow/stale/root-symlink → never clone unproven source, install or fail-closed • forced-local-fail + global `tsc`/`vitest`/populated npx cache → never `passed` • relative/absolute/escaping/symlinked-root `.bin` links → safe pass or fail-closed • crash after backup/install/move-in/marker → recover, nothing staged visible to git • fresh verify / remediation / resume-after-discard / verifier failover → ensure runs after final manifest state • no-ignore-rule & tracked-`node_modules` repos → fail closed, nothing enters a commit • clone containing `.vite` → purged.
