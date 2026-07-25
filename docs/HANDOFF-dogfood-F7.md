# HANDOFF — Dogfood + Engine Fix F7 (worktree dependency provisioning)

**Purpose:** full state for a new agent to continue if this Claude session ends. Durable artifacts = **git commits + these repo docs** (session task-IDs / agent-IDs / scratchpad files do NOT transfer). Last updated: 2026-07-22, mid-F7-fix-round-1.

**Companion durable logs:** subagent keeps `docs/F7-IMPL-NOTES.md` (per-blocker fix status). Codex reviews: `docs/engine-fix-worktree-deps-review-codex-{v2,diff}.md`. Spec: `docs/engine-fix-worktree-deps-spec.md`. Cross-session memory index: `~/.claude/projects/-Users-tagtaste-Documents-QBApps-harness-orchestration/memory/`.

---

## ✅ F7 LANDED (2026-07-22) — merged to main, awaiting user push
Squash-merged the codex-approved F7 branch (`59d002d`) into `main` as **`5669d22`** (6 codex diff-review rounds → MERGE; findings 10→8→7→4→1→0). Rebuilt `dist/`; full suite GREEN (206 files / **3398 tests** both SQLite drivers) + typecheck 0. The grok prompt-steering edit to `implementor.ts` is preserved UNCOMMITTED in the primary tree (user's). Review/handoff docs left untracked. **REMAINING: the user does `git push`** (Claude does not push). Then: re-verify grok's `ef952b1` through the fixed engine → expect `merge_ready` → next UI slice. F7 branch `worktree-agent-ad6b0180db834588b` preserved at `59d002d` (use `--no-ff` re-merge before push if you want the granular 7-commit history instead of the squash).

## TL;DR — where we are + next action
Dogfooding the harness on its own UI plan. First real run false-negatived due to **F7**: the engine creates git worktrees without `node_modules`, so verification commands (`npm run typecheck`, `npx vitest`) exit 127 and the verifier can't gather evidence. grok's implementation was actually correct. F7 fix is spec'd (v3) + implemented on a branch; a codex diff-review found **8 blockers**; the implementor agent is fixing them now.
**NEXT ACTION:** when the fix lands on the branch, re-run the codex diff-review (see §7); iterate to MERGE; then rebase→merge→`npm run build` (do NOT push — user pushes).

---

## 1. The mission
- Repo: `/Users/tagtaste/Documents/QBApps/harness-orchestration` (remote github.com/maplenk/harness-control).
- Goal: run the harness (a cross-harness agent-orchestration engine) on its own UI-implementation plan `docs/UI-IMPLEMENTATION-PLAN.md`, one `harness` run per bounded slice.
- Roles: coordinator=claude:opus:xhigh, implementor=**grok:grok-build:high** (native, `--permission-mode auto` — user's informed choice "KEEP AUTO"), verifier=codex:gpt-5.6-sol:xhigh.
- **CONSTRAINT — "no UI WILL BE BUILT BY THE HARNESS ITSELF":** the UI is built ONLY via the dogfood (grok implements), NEVER by hand / by Claude / by a helper agent. Claude is the **orchestrator**: plan, design, delegate to executors, review, surgical commits, monitor — do NOT implement the UI directly.
- Landing division: **Claude does merge + `npm run build`; the USER does the `git push`** (user decision 2026-07-22). Claude never pushes to origin without explicit go-ahead.

## 2. What the dogfood run surfaced (F7)
- Run `run_8aa51aea-2bf0-4906-afba-7f0bdc8ba7e3` (§3A.1 command-executor slice, spec 14bcdad4) ran the full loop (coordinator→approve→grok implements+commits→codex verifies→3 remediation rounds) and ended terminal `NoDeliverableError`.
- Root cause = **F7**: `git worktree add` never installs deps; `node_modules` is git-ignored, so the worktree has source but no toolchain → `tsc`/`vitest` → exit 127 → verifier reports all criteria `unproven` (correct fail-safe, never a fake pass) → remediation burns rounds on unactionable "provide evidence" → `NoDeliverableError`.
- **grok's code is actually CORRECT.** Proof: symlinked primary `node_modules` into grok's commit `ef952b1` → `npm run typecheck` **exit 0**, `npx vitest run src/app/commands src/cli/commands.test.ts` **40/40 pass**. The run was a false-negative caused entirely by F7.
- Decision: after F7, **re-verify `ef952b1` (do NOT re-drive grok)** → it should reach `merge_ready`.

## 3. F7 fix — design + scope
- Spec (contract): **`docs/engine-fix-worktree-deps-spec.md`** (v3). Primitive: a **real git-ignored `node_modules` DIRECTORY** (NOT a symlink), produced by APFS copy-on-write clone (`cp -c -R` primary→worktree) when the committed manifests match the primary checkout, else `npm ci --ignore-scripts`. Provision at the **post-implementor-commit / pre-verification boundary**. **FAIL CLOSED** (`provisioning_failed`, no verifier dispatch, no `merge_ready`) if provisioning can't be proven. Out-of-worktree transactional staging.
- **Scope = MVP-correct, hardening DEFERRED** (user decision). Deferred (spec §5, do NOT build now): runtime toolchain-provenance attestation woven into merge-readiness, full npm lifecycle-script sandbox, writable-tree integrity re-check, journaled crash-recovery. Rationale: grok is cooperative + FS-sandboxed; fail-closed already prevents the accidental false-green.
- Codex SPEC reviews (both NEEDS-REVISION, shaped v3): v1 killed the symlink primitive; v2 killed provision-at-create timing + demanded fail-closed/transactional/manifest-binding. Record: `docs/engine-fix-worktree-deps-review-codex-v2.md`.

## 4. Implementation status
- Implemented by an opus subagent (session name `f7impl`) in an isolated worktree.
- **Branch `worktree-agent-ad6b0180db834588b`, commit `a43eeaf`** (parent `d318df1`). Full suite green at that commit: `typecheck` exit 0, **1655/1655 tests** (SqlDriver contract runs on both better-sqlite3 + node:sqlite).
- New module `src/worktree/provision.ts` (+ `provision.test.ts`, 27 tests). Wiring: `worktree/{manager,git,errors,index}.ts`, `config/{schema,config.test}.ts`, `cli/{index,commands}.ts`, `app/flows/{implementor,implementor.test,orchestrate,vertical-slice.test}.ts`. New `provisioning_failed` WorktreeError + LoopOutcome.
- **Codex DIFF-review round 1 = NEEDS-FIX** (8 blockers+high+medium; `docs/engine-fix-worktree-deps-review-codex-diff.md`). Fixed by `f7impl` in commits `2a56ac7`+`6e33827` (1665 green).
- **Codex DIFF-review round 2 = NEEDS-FIX** (5 blockers + 3 high; `docs/engine-fix-worktree-deps-review-codex-diff2.md`). Triage: MOST findings are npm-workspace generality (moot for this single-package repo); a few are real cheap correctness.
- **Scope decision (user, 2026-07-22):** fix dogfood-relevant correctness (stale-tree-on-no-deps #1, restore-failure #4, M9 safe-resume #6, LC_ALL=C locale #8) + make npm-workspace repos FAIL CLOSED completely; **DEFER** real workspace provisioning (#2/#7), nested node_modules (#3), realpath symlink-chain containment (#5) — added to spec §5. Consistent with "MVP-correct, defer hardening."
- **Round-2 scoped fixes DONE** — `f7fix2op` (opus) committed `5994b49` (parent 6e33827): #1 transactional stale-removal, #4 restore-preserves-backup, #6 M9 route-to-`no_deliverable`-so-resume-re-drives, #8 structural `git ls-tree` absence, #5 `assertNoWorkspaces` fail-closed (+ removed workspace-support machinery), #3 exclusion-only-when-provisioning-active. `typecheck` 0, **1679 tests green**. Spec §5 updated (this session) with the 3 new deferrals. Agent's per-fix detail in `docs/F7-IMPL-NOTES.md`.
- **Round-2 fixes CONFIRMED good** by codex round-3 (VALID, on-disk 5994b49): workspaces fail-closed, ls-tree absence, fail-closed verifier boundary all verified. (NOTE: the FIRST round-3 codex run was INVALID — it echoed the round-2 doc + reviewed parent 6e33827; re-ran with codex reading on-disk files at the fix commit, no parent/prior-review reference.)
- **Codex round-3 (valid) = NEEDS-FIX** (4 blk + 2 high + 1 med; `docs/engine-fix-worktree-deps-review-codex-diff3.md`). All on FAILURE/EDGE paths — the dogfood happy path (clone, no failure) works with 5994b49 as-is.
- **Scope decision (user):** ONE bounded fix round for the 6 cheap-real robustness findings — #1 resume/validate-exclude+bind-commit, #2 swap-backup-preserve, #3 lstat-ENOENT-only, #5 GC-preserve+namespace, #6 standalone-consistency, #7 redaction. DEFER #4 (npm-env/.npmrc isolation) → spec §5.8 (malicious-implementor; dogfood uses clone path).
- **Round-3 fixes DONE** — `f7fix3` committed `79ae2ee` (6 fixes, 1689 green). Spec §5 now has 8 deferred items.
- **Codex round-4 (valid, on-disk 79ae2ee) = NEEDS-FIX** — only 1 blocker + 2 high + 1 medium, all narrow refinements of the round-3 fixes: (blk) round-scope `lastImplementationCommit` (multi-round crash can verify/reset to wrong commit); (high) primary manifest reads must be ENOENT-only; (high) unstage already-staged node_modules before commit/WIP; (med) namespace-root enum error → fail-closed. Converging (8→5+3→4+2+1→1+2+1). `docs/engine-fix-worktree-deps-review-codex-diff3.md` covers round 3; round-4 findings are in scratchpad + this line.
- **Round-4 refinements DONE** — `f7fix3` committed `14b7d1b` (4 fixes, 1695 green).
- **Codex round-5 (valid, on-disk 14b7d1b) = NEEDS-FIX, ONE finding** — codex explicitly confirmed the 4 round-4 fixes are correct and NO other non-deferred blocker/high remains. The last item (HIGH): the SAME-process verifier failover/auto-respawn re-entry (`orchestrate.ts:727`/`:894`) doesn't `discardToCommit` to the persisted commit like cross-process adoption does (`:421`) — a verifier that dirtied files/moved HEAD then crashed could verify the wrong/contaminated commit. Convergence: 10→8→7→4→1.
- **NOW:** `f7fix3` (resumed) applying that final fix (mirror the `:421` reset on the same-process path) + its test, same branch, background. Codex says this should be the last → next re-review expected MERGE → rebase onto main → merge → `npm run build` → STOP for user push.

## 5. Git state + merge plan
- `main` = `d9c1615` (grok "auto" + prior engine fixes landed). F7 base `d318df1` is a **clean ancestor of main**.
- Commits `main` is ahead of `d318df1` (`e792c6a`,`1170bc4`,`d9c1615`) touch ONLY `adapters/grok/*` + `factory.test.ts` — **zero overlap** with F7's files → **F7 rebases onto main conflict-free**.
- **Wrinkle:** the primary working tree has ONE uncommitted edit — `src/app/flows/implementor.ts` (grok prompt-steering; the user's, got grok to success). F7 also edits `implementor.ts` (different region). At merge: stash the uncommitted edit → merge F7 → reapply (or ask user to commit it first). Do NOT discard it.
- Merge sequence (after codex says MERGE): rebase F7 branch onto `main` → merge to `main` → `npm run build` (refresh `dist/` — gitignored; the run uses the built binary, a stale dist bit us at the start) → **STOP, user pushes**.

## 6. After F7 lands
1. Re-verify grok's `ef952b1` through the fixed engine → expect `merge_ready`. (Two dogfood worktrees are intact for this: `…worktrees/assignment-asg_run_8aa51aea…` [ef952b1; NOTE: I added a `node_modules` symlink to it for the manual salvage-proof — remove it before a clean harness re-verify] and `…assignment-asg_run_992e9598…`.)
2. Merge that slice; then the next UI slice per `docs/UI-IMPLEMENTATION-PLAN.md` (order ~ B0 fixture shell → A0 1a[done-pending-merge]→1b → Phase A serve daemon → first visible proof slice → …).

## 7. How to run a codex review (the gate — "green ≠ correct")
Pattern (background): `codex exec -s read-only -c approval_policy="never" --skip-git-repo-check -C <repo> "$(cat <promptfile>)" > <result> 2>&1`. codex 0.144.5 at `/Users/tagtaste/.local/bin/codex`. It reads the repo + runs read-only git (`git diff d318df1 a43eeaf`, `git show a43eeaf:<file>`). The result file is large (streamed tool logs, ~400KB) — extract the FINAL message: `python3` split on `] Assistant message`, take the last block (or `rfind('## 1. Prioritized findings')`). Prompts used are in the session scratchpad (`codex-diffreview-prompt.txt` etc.) — reconstruct from the spec + this doc if gone. Reviews land NEEDS-FIX/NEEDS-REVISION vs MERGE/SOUND.

## 8. Constraints checklist (do NOT violate)
- [ ] No UI built by hand — only via the dogfood (grok).
- [ ] grok implementor stays `--permission-mode auto` (KEEP AUTO).
- [ ] Codex adversarial review is the merge gate; a green suite is NOT sufficient.
- [ ] F7 = MVP scope; §5 hardening stays deferred.
- [ ] Claude does merge + build; USER does the push.
- [ ] Preserve the uncommitted `implementor.ts` prompt edit through any merge.

## 9. Session-specific (will NOT transfer; noted for THIS session only)
- Subagent `f7impl` (agentId `ad6b0180db834588b`) — fixing the 8 blockers, background.
- Scratchpad: `…/9ee8dcb5-…/scratchpad/` holds codex prompts + result files + `resume-run6.log`.
- Run store / event log: `~/.harness/harness.db`; CAS + verifier evidence: `~/.harness/artifacts/`.
