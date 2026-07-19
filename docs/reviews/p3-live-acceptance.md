# P3 Live Acceptance Smoke — Verdict & Transcript

Date: 2026-07-18
Scope: PLAN §20 P3 exit-gate "user-defined live acceptance smoke" — coordinator = Claude Opus (effort low), implementor = Codex `gpt-5.6-terra`, verifier = Claude Opus (low), one trivial task, driven against REAL adapters with EXISTING auth.
Goal under test: *"Create a file greeting.txt in the repo root containing exactly the line: Hello from the orchestrator."*

> **This document has two runs.** The **primary result (Run 2)** below is the *shipped-CLI* smoke, run **after** the D-1 fix, through `harness start → status → approve → run → status` with **ZERO composition shims** — every state change went through the `OrchestrationService` seams the CLI now calls itself (`commands.ts:178 service.runCoordination`, `commands.ts:321 runImplementVerifyLoop`). **Run 1** (the prior seam-driven drive, pre-D-1-fix, which required a shim because the CLI did not yet wire the slice) is preserved verbatim as an **Appendix**.

---

## 1. Verdict (headline) — Run 2 (shipped CLI, post-D-1-fix)

**The shipped-CLI live acceptance smoke COMPLETED end-to-end and reached `merge_ready`, with NO shim.** Every step was a literal `npx tsx src/cli/index.ts …` invocation against the built CLI, sharing one SQLite run store across processes. Claude Opus (low) really coordinated inside `harness start`; Codex `gpt-5.6-terra` really implemented + committed `greeting.txt` inside `harness run`; Claude Opus (low) really verified all three criteria inside the same `harness run`. `greeting.txt` was created byte-exact. The primary checkout is byte-for-byte untouched; work is isolated on a per-run worktree branch. The manual-integration hint now targets the **correct** destination branch (`master`, resolved from the repo — the prior run's hardcoded `main` is fixed).

| Question (from the task) | Answer |
|---|---|
| Did the full cross-harness loop work **through the shipped CLI**? | **Yes** — `start`→`status`→`approve`→`run`→`status` reached `merge_ready`; no shim. |
| Did opus-low actually coordinate (inside `harness start`)? | **Yes** — real `claude-agent-acp@0.59.0`, ~36 s, valid §7 spec (AC-1/AC-2/AC-3), 1 round, cost $0.233684. |
| Did codex-terra actually implement (inside `harness run`)? | **Yes** — real `codex-acp@1.1.4`, created `greeting.txt` = `"Hello from the orchestrator\n"` (28 bytes), committed `c254435`. |
| Did opus-low actually verify (inside `harness run`)? | **Yes** — read-only on `c254435`, gathered its OWN evidence for AC-1/AC-2/AC-3, all passed → `all_verified` (T24). |
| Reached merge-readiness with the correct destination branch? | **Yes** — `ready:true`; manual hint `git … switch master` (repo's actual default branch, §16). |
| Primary/temp repo left in expected state? | **Yes** — primary HEAD still `975d926` on `master`, clean; work on `harness/assignment/asg_run_764ede94…` in a separate worktree (§16). |
| Any shim needed? | **No** — `shimUsed = false`. The CLI drove the flows itself. |
| Real defects found? | None blocking. Two minor findings (F-1 `run` requires explicit `--verifier`; F-2 `--test-approve` fabricates a placeholder hash when `--spec-hash` is omitted). See §6. |

`cliLoopCompleted = true`. `reachedState = merge_ready`. `fileCreatedCorrectly = true`. `mergeReadiness = READY (merge_ready)`. `destinationBranchCorrect = true`. `shimUsed = false`. Total agent wall-clock ≈ 107 s (36 + 71); well under the 15-min cap.

---

## 2. Environment (real, from shipped `harness doctor --json`)

Identical to Run 1's environment (same host, same logins):

- Adapters resolved & version-pinned: `@agentclientprotocol/claude-agent-acp@0.59.0`, `@agentclientprotocol/codex-acp@1.1.4` (lockfile-pinned bins, no `npx -y`). Node 22.14.0, git 2.55.0, better-sqlite3 (WAL, FK, busy 5000 ms).
- Auth (H-2, presence-only, never opened): Claude = `detected_but_unsupported` (on-disk OAuth state only; third-party subscription OAuth ToS-barred; no validated API key). Codex = `detected_but_unvalidated` (rides `~/.codex/auth.json` ChatGPT login carried into children by H-1 `CODEX_HOME` isolation; a present `OPENAI_API_KEY` is separately unvalidated). **`overall: warn`.** Doctor's conservative labels notwithstanding, the live drive below turned both providers' `detected_but_*` material into recorded successful provider turns — the same H-2 validation evidence Run 1 produced.
- Host-config flag (H-1): `~/.codex/config.toml` has `approvals_reviewer = "auto_review"` → doctor marks it **unsafe** for non-isolated codex use; orchestrator spawns are protected by per-run `CODEX_HOME` isolation. `CODEX_HOME` was **unset** in the driving shell throughout, and `buildCliFlows()` never reads or forwards it (H-1 intact).

---

## 3. Run 2 transcript — shipped CLI, each command + its `--json`

Isolated run store `HARNESS_HOME=<scratch>/harness-home-cli` (single SQLite DB shared across all four processes). Fresh temp repo `<scratch>/p3-cli-workspace.3nushc` (`git init`; one initial commit `975d926` on default branch **`master`**). `CODEX_HOME` unset. Runner: `npx tsx src/cli/index.ts`.

### 3.1 `harness start` → drives the coordinator FLOW → `awaiting_approval`

```
$ harness start --workspace <tmp> \
    --goal "Create a file greeting.txt in the repo root containing exactly the line: Hello from the orchestrator" \
    --coordinator claude --model opus --effort low --json      # exit 0, ~36 s (real Claude Opus spawn)
```
```json
{ "command":"start","ok":true,
  "runId":"run_764ede94-8e80-4713-80f3-20973a92c38a",
  "phase":"awaiting_approval","uiState":"waiting_on_you",
  "coordinator":{"harness":"claude","model":"opus","effort":"low", ...},
  "spec":{ "specVersionId":"spec_a778f08a-3efb-42e8-81ef-9f1ac693e4b4",
           "specHash":"ba6875a20b731d3f871f89bbc0a7764ee7309c4a020332e9f236be931fc802bf",
           "revision":1,"rounds":1,
           "criteria":[{"id":"AC-1", ...},{"id":"AC-2", ...},{"id":"AC-3", ...}],
           "proposedImplementor":"implementor-default","proposedVerifier":"verifier-default",
           "document":"{…full §7 spec…}" } }
```
The text surface also printed the full spec and a `next:` hint: `approve run_764ede94… --spec-version spec_a778f08a… --spec-hash ba6875a2…`. This proves `handleStart` called `service.runCoordination(runId, runner)` (commands.ts:178) on a real adapter (created→specifying→awaiting_approval) and persisted the draft via `service.saveSpecDraft` (SPEC_DRAFT projection).

### 3.2 `harness status` #1 → `awaiting_approval` (fresh process reads the persisted run)

```
$ harness status run_764ede94… --json      # exit 0
```
```json
{ "command":"status","ok":true,"phase":"awaiting_approval","suspension":"none",
  "uiState":"waiting_on_you","childActive":false,
  "vitals":{"cost":{"totalCostUsd":0.233684,"turns":1,
    "byRole":{"coordinator":{"turns":1,"inputTokens":4,"outputTokens":1757,"costUsd":0.233684}},
    "byPhase":{"specifying":{ …$0.233684… }}},
    "context":{"coordinator":{"contextUsedTokens":33740,"contextWindowSize":1000000}}},
  "budget":{"spentUsd":0.233684,"reservationUsd":0.5} }
```

### 3.3 `harness approve` → T1 (automated human-gate stand-in) → `approved`

```
$ HARNESS_TEST_MODE=1 harness approve run_764ede94… \
    --spec-version spec_a778f08a… --spec-hash ba6875a2… --test-approve --json   # exit 0
```
```json
{ "command":"approve","ok":true,"outcome":"applied","transitionId":"T1","phase":"approved",
  "specVersionId":"spec_a778f08a-3efb-42e8-81ef-9f1ac693e4b4",
  "specHash":"ba6875a20b731d3f871f89bbc0a7764ee7309c4a020332e9f236be931fc802bf","mode":"test" }
```
`--test-approve` is the ONLY test seam and is correctly gated on `HARNESS_TEST_MODE=1`. `--spec-hash` was included **on the CLI's own `next:` instruction** so the T1 record binds the *real* spec hash (matching what the loop and merge-readiness use); see finding F-2 for the omit-hash behavior.

### 3.4 `harness run` (literal task command — no `--verifier`) → rejected, no spawn

```
$ harness run run_764ede94… --implementor codex:gpt-5.6-terra --json      # exit 2
```
```json
{ "command":"run","ok":false,"phase":"approved","error":"missing_profiles",
  "detail":"run needs --verifier: pass the implementor/verifier profiles explicitly. The approved spec proposed implementor='implementor-default', verifier='verifier-default'." }
```
The shipped `run` requires BOTH `--implementor` and `--verifier`; the literal step-5 command in the task omits `--verifier` and is rejected on a synchronous guard **before any adapter spawn** (phase re-checked `approved`, unchanged). Recorded as finding **F-1**. The proposed profiles are profile *names* (`implementor-default`/`verifier-default`), not resolvable `harness:model` specs, so they are surfaced as a hint, not auto-used.

### 3.5 `harness run` (with `--verifier`) → drives the implement→verify FLOW → `merge_ready`

```
$ harness run run_764ede94… --implementor codex:gpt-5.6-terra \
    --verifier claude:opus:low --json      # exit 0, ~71 s (real Codex + real Claude Opus)
```
```json
{ "command":"run","ok":true,"phase":"merge_ready","uiState":"done","outcome":"merge_ready","rounds":1,
  "implementationCommit":"c254435439c3e732cfaf2a20b069f7e2152c1b51",
  "worktreePath":"<tmp>.worktrees/assignment-asg_run_764ede94-8e80-4713-80f3-20973a92c38a",
  "plan":{"implementor":{"harness":"codex","model":"gpt-5.6-terra"},
          "verifier":{"harness":"claude","model":"opus","effort":"low"}},
  "mergeReadiness":{"ready":true,
    "verifiedCommit":"c254435439c3e732cfaf2a20b069f7e2152c1b51",
    "baseCommit":"975d926594daa942eeb2fec127435670bc198b34",
    "specHash":"ba6875a20b731d3f871f89bbc0a7764ee7309c4a020332e9f236be931fc802bf",
    "destinationClean":true,"baseDrifted":false,"conflicts":false,"requiredTestsPassed":true,
    "manualIntegrationCommands":[
      "# Manual integration for verified commit c254435… (§16 — the harness never runs these).",
      "git -C <tmp> switch master",
      "git -C <tmp> merge --no-ff harness/assignment/asg_run_764ede94-8e80-4713-80f3-20973a92c38a" ]}}
```
This proves `handleRun` called `runImplementVerifyLoop({service, worktrees, …})` (commands.ts:321): approved→implementing (isolated worktree)→verifying→merge_ready. `verifiedCommit == implementationCommit` (the loop reads the worktree HEAD itself, §8 — never the agent's claim). Exit 0 gated on `outcome === 'merge_ready'` (§16).

### 3.6 `harness status` #2 → final `merge_ready` + per-role cost (§17.2)

```
$ harness status run_764ede94… --json      # exit 0
```
```json
{ "command":"status","ok":true,"phase":"merge_ready","uiState":"done","childActive":false,
  "approvedSpecHash":"ba6875a20b731d3f871f89bbc0a7764ee7309c4a020332e9f236be931fc802bf",
  "vitals":{"cost":{
    "totalCostUsd":0.554695,"totalEstimatedCostUsd":0.5,"costEstimated":true,
    "totalInputTokens":399,"totalOutputTokens":3890,"turns":3,"currency":"USD",
    "byRole":{
      "coordinator":{"turns":1,"inputTokens":4,"outputTokens":1757,"costUsd":0.233684,"estimatedCostUsd":0},
      "implementor":{"turns":1,"inputTokens":385,"outputTokens":149,"costUsd":0,"estimatedCostUsd":0.5},
      "verifier":{"turns":1,"inputTokens":10,"outputTokens":1984,"costUsd":0.321011,"estimatedCostUsd":0}},
    "byPhase":{"specifying":{…$0.233684…},"implementing":{…$0 + est $0.5…},"verifying":{…$0.321011…}}},
    "context":{"coordinator":{33740,"/1M"},"implementor":{16662,"/258400"},"verifier":{35910,"/1M"}}},
  "budget":{"spentUsd":0.554695,"reservationUsd":0.5},"checkpoints":{"count":0} }
```

Event log (authoritative, from the run store): `spec.approved` → `verification.completed.passed` → `merge.readiness.recorded` → `notify.requested`. Final phase `merge_ready`, uiState `done`.

---

## 4. Generated spec, implementor diff, verifier verdict (Run 2)

### 4.1 Generated spec (Claude Opus, real) — abridged

Goal restated; 3 assumptions (incl. "'exactly the line' = text + single trailing newline (28 bytes)"); 1 honest open question (the no-newline ambiguity); constraints/permissions/non-goals; task T1; base correctly observed as `975d926` on branch **master**; **3 objectively-testable acceptance criteria**:

- **AC-1** `greeting.txt` exists & is a regular file — cmd `test -f greeting.txt && echo EXISTS`, evidence "exit 0, prints EXISTS".
- **AC-2** content is exactly the line + single `\n` (28 bytes) — cmds `cat`, `wc -l < …`, `wc -c < …`, evidence "cat prints 'Hello from the orchestrator'; wc -l = 1; wc -c = 28".
- **AC-3** no other tracked file changed — cmd `git status --porcelain`, evidence "only greeting.txt in the change-set relative to base".

Spec hash `ba6875a20b731d3f871f89bbc0a7764ee7309c4a020332e9f236be931fc802bf`. The coordinator's exploration artifact (CAS `14fad29d…`) records: "Repo root contains only README.md (40 bytes) and .git. greeting.txt does not exist" — consistent read-only exploration (§10.2 write/tool veto; the coordinator never mutated the workspace).

### 4.2 Implementor diff + commit (Codex gpt-5.6-terra, real)

Commit `c254435439c3e732cfaf2a20b069f7e2152c1b51`, author `harness-orchestration-implementor`, on branch `harness/assignment/asg_run_764ede94-8e80-4713-80f3-20973a92c38a`. Message binds goal + spec hash.

```diff
 greeting.txt | 1 +
 1 file changed, 1 insertion(+)

diff --git a/greeting.txt b/greeting.txt
new file mode 100644
index 0000000..2f1379f
--- /dev/null
+++ b/greeting.txt
@@ -0,0 +1 @@
+Hello from the orchestrator
```

Host-read verification of the file at HEAD `c254435`: `cat` → `Hello from the orchestrator`; `wc -c` → **28**; `wc -l` → **1**; `od -c` → `H e l l o   f r o m   t h e   o r c h e s t r a t o r \n` (exactly 28 bytes, one trailing `\n`). **Byte-exact match** to the goal.

### 4.3 Verifier per-criterion verdict (Claude Opus low, real, read-only on `c254435`)

Evidence below was gathered by the **verifier itself** (§8 — the implementor's self-checks are never reused as evidence); stored in CAS:

| Criterion | Verdict | Verifier-gathered evidence (CAS) |
|---|---|---|
| AC-1 | **passed** | `e38fe63f…` — "Ran `test -f greeting.txt && echo EXISTS` at repo root on HEAD c254435 → printed 'EXISTS'. File exists and is a regular file." |
| AC-2 | **passed** | `dd1896f4…` — "`cat` → 'Hello from the orchestrator'; `wc -l` → 1; `wc -c` → 28. Matches exactly the required content plus one trailing newline (28 bytes), no other lines." |
| AC-3 | **passed** | `57aa28e4…` — "`git status --porcelain` empty (committed); `git diff --name-status 975d926 HEAD` → single line 'A\tgreeting.txt'. No other tracked files added/modified." |

`outcome = all_verified` → **T24** → `merge_ready`. (The `verification.completed.passed` event is the T24 pathway; a single failing criterion would have emitted `verification.completed.failed` (T23) → `needs_remediation`/`failed` instead — so reaching `merge_ready` is itself proof all three passed.)

### 4.4 Merge-readiness (§16) — destination branch now correct

```
ready: true
verifiedCommit: c254435…   (== implementationCommit, host-read worktree HEAD)
baseCommit:     975d926…   (temp repo initial commit)
specHash:       ba6875a2…  (== approvedSpecHash, == loop specHash)
destinationClean: true | baseDrifted: false | conflicts: false | requiredTestsPassed: true
manualIntegrationCommands (NEVER executed by the harness):
  # Manual integration for verified commit c254435… (§16 — the harness never runs these).
  git -C <tmp> switch master           ← CORRECT: resolved from the repo's actual branch (was 'main' in Run 1)
  git -C <tmp> merge --no-ff harness/assignment/asg_run_764ede94-8e80-4713-80f3-20973a92c38a
```
The temp repo's default branch is `master`; the loop resolves `destinationLabel = git.currentBranch(handle.repoRoot) ?? 'main'` (orchestrate.ts:174-175), so the hint targets `master`. Run 1's "non-defect note" (hint said `main`) is now resolved. `destinationBranchCorrect = true`.

### 4.5 Per-role token/cost (final `status.cost`, real, §17.2)

| Role | Model | Turns | In / Out tokens | Measured (USD) | Estimated reservation (USD) | Context |
|---|---|---|---|---|---|---|
| coordinator | Claude Opus (low) | 1 | 4 / 1757 | **$0.233684** | $0 | 33 740 / 1M |
| implementor | Codex gpt-5.6-terra | 1 | 385 / 149 | **$0.00** (subscription; no per-token price) | **$0.50** (§17.2 conservative) | 16 662 / 258 400 |
| verifier | Claude Opus (low) | 1 | 10 / 1984 | **$0.321011** | $0 | 35 910 / 1M |
| **total** | | **3** | 399 / 3890 | **$0.554695** | **$0.50** (`costEstimated:true`) | |

Per-phase attribution mirrors per-role (specifying $0.233684 / implementing $0.00 measured + $0.50 est / verifying $0.321011). **The prior run's D-2 honesty gap is now surfaced**: the status cost object reports `costEstimated:true` and `totalEstimatedCostUsd:0.5`, and the implementor row carries `estimatedCostUsd:0.5` — the subscription-billed Codex turn is no longer invisible as a cost center (measured Codex spend is still $0, now covered by an explicit conservative reservation).

---

## 5. Isolation, cleanup, safety (Run 2)

- **Primary checkout untouched (§16):** after the loop, the primary temp repo HEAD is still `975d926` on `master`, `git status --porcelain` empty, and `greeting.txt` is **absent** from the primary root (root holds only `.git` + `README.md`). `git worktree list` shows primary `975d926 [master]` and the work worktree `c254435 [harness/assignment/asg_run_764ede94…]`.
- **H-1 held:** `CODEX_HOME` was unset in the driving shell throughout; the Codex spawn used the service's `defaultRoleAdapterFactory()` isolated home. `buildCliFlows()` (index.ts:125) never reads or forwards a user `CODEX_HOME`.
- **No orphans:** post-run `ps` scan for `codex-acp` / `claude-agent-acp` / `tsx src/cli` / the temp workspace path → **0** matches (pre-run baseline of 15 matches were all pre-existing user processes — ChatGPT.app desktop, VSCode/Claude codex plugins — none harness ACP children). Every adapter's `dispose()` reaped its process group on clean completion; existing user sessions untouched. No wedge, no cancellation needed.
- **Credentials never mutated:** presence/existing-login used read-only only.
- **Budget:** agent wall-clock ≈ 107 s (start 36 s + run 71 s); well under the 15-min cap.

---

## 6. Findings (Run 2) — minor, none block the P3 gate

### F-1 (low, CLI ergonomics) — `harness run` requires an explicit `--verifier` (and `--implementor`) even though the approved spec carries proposed profiles

`handleRun` (commands.ts:283-297) rejects with exit 2 `missing_profiles` unless BOTH `--implementor` and `--verifier` are passed. The literal task step-5 command `harness run <id> --implementor codex:gpt-5.6-terra` (no verifier) does not run; the CLI *suggests* the spec draft's `proposedImplementorProfile`/`proposedVerifierProfile` but does not use them as defaults. Compounding it, those proposals are profile-*names* (`implementor-default`, `verifier-default`), not resolvable `harness:model` specs, so wiring them as run defaults also needs profile-name resolution (not yet present). Impact: cosmetic/ergonomic — the loop works when both profiles are passed explicitly (as done here with `--verifier claude:opus:low`). Not fixed.

### F-2 (low, honesty/consistency) — `--test-approve` fabricates a placeholder spec hash when `--spec-hash` is omitted

`handleApprove` (commands.ts:242) computes `hash = cmd.specHash ?? toSpecHash("test-approve:" + specVersionId)`. Omitting `--spec-hash` with `--test-approve` therefore binds a *synthetic* `approvedSpecHash` (`test-approve:spec_…`) into the T1 record, which then diverges from the real spec hash the loop uses (from the SPEC_DRAFT projection) for the verifier binding and merge-readiness. It is **not** a correctness bug in the loop (the loop is driven by the draft's real hash independently — verifier.ts:614 compares the loop's own specHash, not the T1 record), but `status.approvedSpecHash` would display a placeholder inconsistent with `mergeReadiness.specHash`. This run sidestepped it by passing the real `--spec-hash` (per the `start` command's own `next:` hint). Fix direction: have the test-approve seam resolve the real hash from the spec draft (as `run` already does) rather than fabricating one. Not fixed.

### Prior D-1 — CLOSED (this run is its acceptance)

D-1 ("shipped CLI does not wire the P3 slice into `start`/`run`") is closed: `start` drives `service.runCoordination` (commands.ts:178) and `run` drives `runImplementVerifyLoop` (commands.ts:321), wired in production by `buildCliFlows()` (index.ts:109-145). This entire Run 2 is the shipped-CLI acceptance the Run 1 report said was blocked.

### Prior D-2 — substantially addressed

Codex/ChatGPT-subscription turns still surface `costUsd:0` (no per-token price), but the status surface now reports a conservative estimated reservation (`costEstimated:true`, `totalEstimatedCostUsd:0.5`, per-role `estimatedCostUsd`), so subscription spend is no longer an invisible cost center (§17.2).

---

## 7. Bottom line for the P3 gate

- Offline vertical slice: green (unchanged). ✔
- Real adapters + real auth + the full coordinator→implementor→verifier→merge-readiness loop **through the shipped CLI** (`start → status → approve → run → status`): **proven working live, no shim** (this report, §3-§5). ✔
- The one thing the P3 exit gate explicitly requires — the loop *through the shipped CLI* — is now **met**. The correct destination branch is surfaced (§16). Two minor ergonomic/honesty findings (F-1, F-2) remain, neither blocking.

**P3 exit-gate live acceptance: PASSED via the shipped CLI.**

---
---

# APPENDIX — Run 1 (seam-driven, pre-D-1-fix)

> Preserved verbatim. At the time of Run 1 the shipped CLI did **not** wire the P3 slice (Defect D-1), so the loop had to be driven directly against the flow seams (`service.runCoordination` → `service.approve` → `runImplementVerifyLoop`) — an explicit shim, which was itself the finding. D-1 has since been fixed and re-accepted through the shipped CLI as Run 2 above.

## A.1 Verdict (headline)

**The shipped-CLI live acceptance smoke did NOT complete — blocked by a wiring gap, not by auth.** The shipped `harness` CLI's `start` and `run` commands are plan-reporting stubs: they never invoke the P3 role flows. A run created with `harness start` stays at phase `created` forever, so `approve` and `run` are both rejected on precondition. The greeting file is never created through the CLI.

**The underlying cross-harness loop itself is fully functional and was proven end-to-end** by driving the exact same flow seams the CLI *should* wire (`service.runCoordination` → `service.approve` → `runImplementVerifyLoop`) with the production `defaultRoleAdapterFactory()` and real auth. That drive reached **`merge_ready`**: Claude Opus (low) really coordinated, Codex `gpt-5.6-terra` really implemented + committed the file, Claude Opus (low) really verified all criteria. This drive is explicitly a **shim** — its necessity is the finding (the task predicted "there should be none").

| Question (from the task) | Answer |
|---|---|
| Did the full cross-harness loop work **through the shipped CLI**? | **No** — CLI `start`/`run` don't wire the flows; run stalls at `created`. |
| Did the loop work **through the flow seams** (real adapters, real auth)? | **Yes** — reached `merge_ready` in one round. |
| Did opus-low actually coordinate? | **Yes** — real `claude-agent-acp@0.59.0`, 36.0s, valid §7 spec (AC-1/AC-2/AC-3) in 1 round. |
| Did codex-terra actually implement? | **Yes** — real `codex-acp@1.1.4`, 26.0s, created `greeting.txt` = `"Hello from the orchestrator\n"`, ran all 5 verification commands (pass), committed `834a00e5`. |
| Primary/temp repo left in expected state? | **Yes** — primary checkout byte-for-byte untouched (HEAD `7243fa5` on `master`, clean); work isolated on branch `harness/assignment/asg_p3_live` in a separate worktree (§16). |
| Anything need a shim? | **Yes** — a shim was REQUIRED because the CLI does not wire the flows (contradicts "there should be none"). See Defect D-1. |
| Real defect found? | **Yes** — D-1 (CLI does not drive the P3 vertical slice). Recorded, not fixed. |

`loopCompleted = false` (the deliverable smoke — through the shipped CLI — did not complete). Blocker: **D-1, a CLI→flow wiring gap** (NOT auth; auth + adapters are proven working below).

## A.2 Environment (real, from shipped `harness doctor --json`)

- Adapters resolved & version-pinned: `@agentclientprotocol/claude-agent-acp@0.59.0`, `@agentclientprotocol/codex-acp@1.1.4` (lockfile-pinned bins, no `npx`). Node 22.14.0, git 2.55.0, better-sqlite3 (WAL, FK, busy 5000ms).
- CLIs present: `claude` 2.1.214, `codex` 0.144.5.
- Auth (3/4-state, H-2): Claude = `detected_but_unsupported` (on-disk OAuth state only; third-party subscription OAuth ToS-barred; no validated API key). Codex = `detected_but_unvalidated` (rides `~/.codex/auth.json` ChatGPT login carried into children by H-1 `CODEX_HOME` isolation; a present `OPENAI_API_KEY` is separately unvalidated).
- Host-config flag (H-1): `~/.codex/config.toml` has `approvals_reviewer = "auto_review"` → doctor marks it **unsafe** for non-isolated codex use; orchestrator spawns are protected by per-run `CODEX_HOME` isolation. `overall: warn`.
- **The live drive below turned both providers' `detected_but_*` auth into a recorded successful provider turn** — i.e. it is the H-2 validation evidence doctor was waiting for. (doctor itself never mutates or opens credentials; the drive used the existing logins read-only.)

## A.3 Part A — Shipped-CLI drive (the literal task) → STALLED at `created`

Fresh temp repo (`mktemp`; `git init`; one initial commit `1ac543a`), isolated `HARNESS_HOME`, `CODEX_HOME` unset. Commands run against the built `dist/cli/index.js`.

```
$ harness start --workspace <tmp> \
    --goal "Create a file greeting.txt ... Hello from the orchestrator" \
    --coordinator claude --model opus --effort low --json
  → { runId, phase: "created", uiState: "idle",
      coordinator: claude/opus effort=low, configOptions:[model=opus, thinking=low] }   # exit 0

$ harness status <runId> --json
  → phase: created | uiState: idle | childActive: false     # coordinator NEVER ran; no spec drafted

$ HARNESS_TEST_MODE=1 harness approve <runId> --spec-version v1 --test-approve --json
  → REJECTED  reason=precondition_failed
     detail="T1: phase must be in [awaiting_approval], was 'created'"   # exit 1

$ harness run <runId> --implementor codex:gpt-5.6-terra --verifier claude:opus:low --json
  → REJECTED  error=not_approved
     detail="run requires an approved spec; run ... is at 'created'."   # exit 1

final: phase=created, cost.turns=0, greeting.txt NOT created.
```

**Where it stalls:** at `start`. `harness start` only calls `service.createRun()` + `service.status()` and prints the coordinator plan; it never calls `service.runCoordination()`, so no coordinator adapter is ever spawned and no spec is drafted. There is nothing to "wait for" or "print." Because the run never advances to `awaiting_approval`, even the clearly-marked automated approval seam (`--test-approve`, correctly gated on `HARNESS_TEST_MODE=1`) is rejected by T1's precondition, and `run` is rejected as `not_approved`. `harness run` likewise only resolves `resolveRoleModel()` and prints a plan; it never calls `runImplementVerifyLoop()`.

This is **Defect D-1** (§A.6). *(Now fixed — see Run 2.)*

## A.4 Part B — Real cross-harness drive via the flow seams (the shim) → `merge_ready`

Because the CLI cannot drive the slice, the flows were composed directly (the composition the CLI is missing): `service.runCoordination(runId, CoordinatorRunner)` → `service.approve(...)` → `runImplementVerifyLoop(...)`, using the production `defaultRoleAdapterFactory()` (real Claude/Codex ACP spawns; **no user `CODEX_HOME` forwarded** — H-1 held). Fresh temp repo (base `7243fa5`). One round, no remediation.

### A.4.1 Transitions (real, timestamped)

```
created → specifying    (runCoordination advance)
[coordinator: Claude Opus low]  36.0s, rounds=1  → spec proposed
specifying → awaiting_approval
spec.approved (T1, automated human-gate stand-in, binds hash 293bc3dd…) → approved
approved → implementing
[implementor: Codex gpt-5.6-terra medium]  26.0s  → committed 834a00e5
implementing → verifying
[verifier: Claude Opus low]  22.0s  → all_verified
verification.completed.passed (T24) → merge_ready ; merge.readiness.recorded ; notify.requested
```

Event log (authoritative): `spec.approved`, `verification.completed.passed`, `merge.readiness.recorded`, `notify.requested`. Final phase `merge_ready`, uiState `done`.

### A.4.2 Generated spec (Claude Opus, real) — abridged

Goal restated; 4 assumptions (incl. "'exactly the line' = text + single trailing newline"); 1 open question (flags the no-newline ambiguity honestly); constraints/permissions/non-goals; task T1; **3 objectively-testable acceptance criteria**:

- **AC-1** `greeting.txt` exists — cmd `test -f greeting.txt && echo PRESENT`, evidence "stdout exactly 'PRESENT', exit 0".
- **AC-2** content is exactly the line + single `\n` — cmds `cat`, `wc -l`, `od -c`, evidence "cat prints 'Hello from the orchestrator'; wc -l = 1; od -c ends with one `\n`, file length 28 bytes".
- **AC-3** no other file changed — cmd `git status --porcelain`, evidence "exactly one line ending in 'greeting.txt'".

Spec hash `293bc3dd911bf36789fc892b3c806649de23e66542ea653c493092a04c401ec8`. (Notably, the coordinator's exploration note records that a `Bash` workspace listing "was declined (consistent with the read-only permission profile)" — the §10.2 coordinator write/tool veto engaged live, and the coordinator adapted by making absence independently verifiable via AC-1/AC-3.)

### A.4.3 Implementor diff + commit (Codex gpt-5.6-terra, real)

Commit `834a00e5feb9c82fc8304857879ee544094f1836`, changed files `["greeting.txt"]`, `committed=true`, model pins echoed (`model=gpt-5.6-terra`, `reasoning_effort=medium`).

```diff
diff --git a/greeting.txt b/greeting.txt
new file mode 100644
index 0000000..2f1379f
--- /dev/null
+++ b/greeting.txt
@@ -0,0 +1 @@
+Hello from the orchestrator
```

`greeting.txt` = `"Hello from the orchestrator\n"` (exact). Host-run declared verification commands (implementor self-check, §8) — all 5 passed: `test -f … → PRESENT`, `cat → Hello from the orchestrator`, `wc -l → 1`, `od -c → …\n (28 bytes)`, `git status --porcelain → ?? greeting.txt` (empty after commit). The agent explicitly declined to self-declare pass/fail ("without making a pass/fail declaration") — the §8 "implementor cannot mark complete" contract held in the model's own words.

### A.4.4 Verifier per-criterion verdict (Claude Opus low, real, read-only on `834a00e5`)

| Criterion | Verdict | Evidence (verifier-gathered, §8) |
|---|---|---|
| AC-1 | **passed** | `7d0f62e3…` |
| AC-2 | **passed** | `320af28f…` |
| AC-3 | **passed** | `216b8d61…` |

`outcome = all_verified` → T24 applied.

### A.4.5 Merge-readiness (§16)

```
ready: true
specHash:       293bc3dd…            (== approved)
verifiedCommit: 834a00e5…            (== implementation HEAD, host-read)
manualIntegrationCommands (NEVER executed by the harness):
  # Manual integration for verified commit 834a00e5… (§16 — the harness never runs these).
  git -C <tmp> switch main
  git -C <tmp> merge --no-ff harness/assignment/asg_p3_live
```

*(Run 1 note: the hint said `main` while the temp repo default branch was `master` — the shim passed the flows' default `destinationLabel:'main'`. Fixed in Run 2, where the CLI resolves the destination from the repo → `master`.)*

### A.4.6 Per-role token/cost (`status.cost`, real)

| Role | Model | Turns | Out tokens | Cost (USD) |
|---|---|---|---|---|
| coordinator | Claude Opus (low) | 1 | 2145 | **$0.393705** |
| implementor | Codex gpt-5.6-terra (med) | 1 | 172 | **$0.00** (ChatGPT-subscription session — no per-token price surfaced) |
| verifier | Claude Opus (low) | 1 | 1088 | **$0.25697** |
| **total** | | **3** | 3405 | **$0.650675** |

Per-phase attribution mirrors per-role (specifying $0.393705 / implementing $0.00 / verifying $0.25697). Context vitals surfaced per role (coordinator 34.3k/1M, implementor 16.2k/258k, verifier 35.1k/1M).

## A.5 Isolation, cleanup, safety

- **Primary checkout untouched (§16/§19-17):** after the loop, the primary temp repo HEAD is still `7243fa5` on `master`, `git status --porcelain` empty, no `greeting.txt` in the primary root. All work lives on branch `harness/assignment/asg_p3_live` in `…/p3-live2-workspace.*.worktrees/assignment-asg_p3_live` (HEAD `834a00e`).
- **H-1 held:** `CODEX_HOME` was unset in the driving shell throughout; the Codex spawn used `defaultRoleAdapterFactory()`'s isolated home. The production call site never forwarded a user-controlled `CODEX_HOME`.
- **No orphans:** a pre-drive PID snapshot vs. post-drive diff shows zero new `*-acp` processes and no process referencing the temp paths — every adapter's `dispose()` reaped its process group on clean completion. Existing user sessions were never touched.
- **Credentials never mutated:** only presence/existing-login were used, read-only.
- **Budget:** whole live drive wall-clock ≈ 84s of agent turns (36 + 26 + 22); well under the 15-min cap. No turn wedged; no cancellation needed.

## A.6 Defects found (Run 1)

### D-1 (high, P3 exit-gate) — Shipped CLI does not wire the P3 vertical slice into `start`/`run` — **NOW FIXED (see Run 2)**

- `src/cli/commands.ts` `handleStart` (≈L110–131): calls only `service.createRun()` + `service.status()` and returns a "next: the coordinator drafts a spec (P3 flow)" plan. It never calls `service.runCoordination(runId, new CoordinatorRunner(...))`. Result: the run is stuck at phase `created`.
- `src/cli/commands.ts` `handleRun` (≈L174–208): resolves `resolveRoleModel()` for implementor/verifier and returns a plan; it never calls `runImplementVerifyLoop(...)`. The comment states the flows run "behind this command," but nothing wires them.
- Corroboration: `grep -rn 'runCoordination\|runImplementVerifyLoop' src --include=*.ts | grep -v test` shows **zero** callers outside `src/app/service.ts` and `src/app/flows/*`. The whole slice is exercised only in `src/app/flows/vertical-slice.test.ts` with an **injected fake `RoleAdapterFactory`**; production has no wiring.
- Impact: the PLAN §20 P3 exit gate — "the user-defined live acceptance smoke … through the full CLI flow (`start` → user approves → `run` → `status` → merge-readiness)" — is **not met by the shipped CLI**. (The offline vertical-slice test IS green, but it bypasses the CLI.)
- Fix direction (applied post-Run-1): wire `handleStart` to run the coordinator flow (constructing `CoordinatorRunner` with a loaded profile + `ArtifactStore` + ids/clock, then `service.runCoordination`), persist the proposed `SpecVersion`/hash so `approve --spec-version` can resolve a real hash, and wire `handleRun` to `runImplementVerifyLoop` (constructing a `GitWorktreeManager` + evidence recorder). These are exactly the pieces Run 2 exercises through the shipped CLI.

### D-2 (low, cosmetic/honesty) — Codex/ChatGPT-subscription turns record cost `$0.00`, not a conservative estimate — **substantially addressed in Run 2**

The implementor turn surfaced `costUsd: 0` (codex-acp advertised token counts but no price for a ChatGPT-subscription session). Per §17.2 the intent is a *conservative per-turn reservation* when authoritative cost is absent; in Run 1 the dollar attribution for subscription-billed Codex was literally `$0`. Run 2's status surface now reports `costEstimated:true` + `totalEstimatedCostUsd` + per-role `estimatedCostUsd`, surfacing the reservation.

### Non-defect note (Run 1) — merge-readiness destination label — **now resolved in Run 2**

`manualIntegrationCommands` referenced `git switch main` while the temp repo's default branch is `master`. This came from the shim passing the flows' default `destinationLabel: 'main'`; the flows take it as input. When the CLI was wired (D-1 fix), it resolves the destination branch from the repo rather than defaulting to `main` — Run 2 correctly shows `git switch master`.

## A.7 Bottom line for the P3 gate (Run 1 — superseded)

- Offline vertical slice: green (unchanged). ✔
- Real adapters + real auth + the full coordinator→implementor→verifier→merge-readiness loop: **proven working live** (Run 1 §A.4). ✔
- **The one thing the P3 exit gate explicitly requires — the same loop *through the shipped CLI* — was blocked by D-1.** *(D-1 has since been fixed; Run 2 above re-runs this exact smoke through the shipped CLI with no shim and PASSES.)*
