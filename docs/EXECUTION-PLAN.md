# Execution Plan — Road to the Finish Line

*Owner: Claude (orchestrator lead). Written 2026-07-25, after full-repo recon. Companions: `docs/ONBOARDING.md` (history), `docs/UI-IMPLEMENTATION-PLAN.md` §6A (the slice ladder), `docs/HANDOFF-dogfood-F7.md` (F7 detail).*

The framing is dynamic-programming-like on purpose: a defined value function (the finish line), memoized subproblems (solved — never re-solve), one recurrence (the dogfood slice loop we run ~16×), transition rules for every failure state, and an ordering chosen to burn down the highest-uncertainty subproblems earliest.

---

## 0. The finish line (value function — user to confirm)

**Done =** the Harness Control UI fully built **by the harness itself** (zero hand-written UI), all §6A slices merged via legitimate `merge_ready` reports, engine stable, suite + typecheck green on every merge.

Two checkpoints worth naming inside that:

- **M-MVP (usable control room):** slices 1a → 1b → 2a → 2b → 2c → 3 → 4 landed. You can open a browser, see the fleet, watch a live run. This is the demoable product.
- **M-FULL (finish line):** + 5 (write actions), 6a/6b (failure screens + management), 7 (inspection tabs), 8a/8b (terminals), 9a/9b (desktop). ~16 runs total, strictly serial (§6A merge/rebuild gate).

## 1. Verified state of the world (2026-07-25, all checked against the tree/DB — not the docs)

| Fact | Evidence |
|---|---|
| F7 landed **and pushed** — `main` == `origin/main` == `5669d22` | `git rev-parse` both refs. ONBOARDING's "user must push" step is already done. |
| Grok prompt-steering WIP now committed as `b9ca10c` (implement-and-stop; verifier owns the commands) | Was the preserved uncommitted edit; landing it makes engine-binary provenance clean. Already live in `dist` (rebuilt at `b9ca10c`). |
| Run 1 (`run_8aa51aea…`, slice 1a) is **unresumable** | `resume` failed closed: §16.3 (`src/worktree/validate.ts:251`) refuses resume-in-place because HEAD (`ef952b1`) drifted past the last cadence checkpoint (`36101cf1`). See F8 below. |
| Grok's three commits survive on the assignment branch | `77cfd09 → 36101cf → ef952b1`, base `01ff719` (8 commits behind main — salvage would have bought a merge conflict with F7's `commands.ts` rewrite). |
| **Fresh slice-1a run started** (2026-07-25) | `start-slice.sh` with §3A.1 scope pinned to plan SHA `b9ca10c`; coordinator `claude:opus:xhigh`; stops at the human-approval gate. |
| Run 2 (`run_992e9598…`) is a cancelled opencode-era run | Event tail: limit incident → pause → cancel. Historical only; its worktree is cleanup noise. |
| Engine suite green at F7 land | **Real suite: 103 files / 1699 tests (~17s), both SQLite drivers**, typecheck 0. The historically reported 206/3398 was exactly **doubled**: the leftover gitignored `.claude/worktrees/agent-ad6b0180db834588b` (an F7 agent worktree) mirrors `src/` with its own `node_modules`, and vitest's default excludes don't cover `.claude/`, so a bare `npm test` discovers the whole suite twice (1699×2 = 3398). Verified via `npx vitest run --exclude '**/.claude/**'`; now fixed permanently by the root `vitest.config.ts` exclude (risk #9). |

## 2. The recurrence — one dogfood slice (run this loop ~16×)

```
slice(i):
  PREFLIGHT   scripts/dogfood/preflight.sh — the L11 battery (toolchain provenance ·
              engine git-path drill · native-toolchain runtime proof · build + doctor ·
              collection floor ≥103 · clean tree). Exit 0 or do not start.
              Then: budget sanity · SECTION/SLICE/PATHS written · plan SHA pinned.
              REPO FREEZE begins at `start` — no commits and no tracked-file edits
              until the run is terminal. Queue doc edits in the scratchpad.
  START       scripts/dogfood/start-slice.sh  → coordinator drafts spec → awaiting_approval
  GATE-1      HUMAN reviews spec (contradictions! AC-3-vs-AC-5 class) → approve EXACT hash
              (revise via `spec_revise` if needed — the gate caught a bad spec once already)
  RUN         scripts/dogfood/run-slice.sh → grok implements in worktree → host commits →
              F7 provisions node_modules at the verify boundary → codex verifies →
              ≤3 remediation rounds
  GATE-2      merge_ready report → HUMAN merges (never the engine)
  LAND        full suite + typecheck on merged tree → SUITE HYGIENE: confirm ~103 files /
              1699 tests (not doubled) and no stray `.claude/worktrees` checkouts →
              npm run build (next run uses the NEW binary) → clean tree →
              per-run manifest recorded ($HARNESS_HOME/logs)
  LEARN       triage anything surprising → engine-fix queue or prompt/config tweak →
              memory + docs updated
```

Cost basis (run 1 actuals): coordinator ≈ $1.5 (532k in / 31k out, opus xhigh); grok implementor cheap; codex xhigh verification is the variable part. Budget rough order: **$3–8 per clean slice**, more with remediation rounds.

**Operational notes (verified against the scripts, not the docs):**

- `run-slice.sh RUN_ID SPEC_VERSION SPEC_HASH` is the approve+run step. Its `--implementor` / `--verifier` flags (`grok:grok-build:high` / `codex:gpt-5.6-sol:xhigh`) are what actually dispatch — the coordinator spec's "proposed profiles" are **advisory only**.
- `run-slice.sh` exit codes: **0** = terminal (check for `merge_ready`) · **3** = provider usage-limit pause (`resume --wait`) · **4** = `integration_blocked` (`recheck` after fixing).
- `watch.sh` uses `sqlite3 -readonly`, which transiently fails `SQLITE_CANTOPEN` right after any CLI command deletes the WAL sidecars (last-connection cleanup). Cosmetic; self-heals on the next 5s tick.
- `~/.harness/.current-dogfood-run` is a **stale pointer** (points at the cancelled run). No script reads it — ignore it.
- The live grok binary is **0.2.111**; `src/adapters/grok/capabilities.ts:1` documents the baseline against **0.2.106**. If grok misbehaves in a new way, check this skew first.
- RSS recovery if a role trips the ceiling: `node dist/cli/index.js set-budget RUN_ID --role implementor --memory-budget-mb <MB> --resume` — an audited raise, never a silent one.
- Per-slice preconditions, predicted failure modes and spec mitigations live in **`docs/DOGFOOD-FEASIBILITY.md`** §4 (the slice table) and §1 (the transition laws L1–L11). Read the row for slice *i* before writing its SECTION/SLICE/PATHS.

## 3. Milestones + ordering (and why this order)

| # | Milestone | Slices | Why now |
|---|---|---|---|
| M0 | Base secured | — | ✅ done today: F7 pushed, WIP committed, F8 diagnosed, fresh 1a in flight |
| M1 | **The loop is proven end-to-end** | 1a | First legitimate `merge_ready` through the fixed engine. Everything else compounds on this. |
| M2 | Grok-on-React de-risked | B0 (fixture shell) | Optional slice, zero engine deps, first *visible* UI. Resolves the biggest unknown (can grok write our React?) while it's cheap. Classic DP: probe the high-uncertainty branch early. |
| M3 | The spine (daemon) | 1b → 2a → 2b → 2c | Hardest engineering: durable operations, writer lease, security gate, WS relay. Serial, engine-adjacent, codex earns its keep here. |
| M4 | **M-MVP: visible control room** | 3 → 4 | Read-only proof slice against real `serve`, then the app shell + read screens. Decision point: demo/ship posture. |
| M5 | Write path + differentiators | 5 → 6a → 6b → 7 | Approvals/permissions in the UI, the five failure screens (the product's identity), management surfaces, inspection tabs. |
| M6 | **M-FULL: finish line** | 8a → 8b → 9a → 9b | PTY broker + takeover, Electron/tray/notifications/packaging. |

Throughput lever list (the chain is serial by design): fewer remediation rounds (spec quality + implementor steering), faster human gates (approve/merge latency dominates wall-clock), engine fixes that prevent redo (F8). Realistic pace: ~1 slice per focused session; M-MVP in ~1.5–2 weeks of steady cadence, M-FULL roughly double that. The pace lever you control is gate latency.

## 4. Transition playbook (what each run outcome means + the move)

| Outcome | Meaning | Move |
|---|---|---|
| `merge_ready` | Criteria verified + §16 readiness clean | Human merges → LAND gate → next slice |
| `failed` w/ real findings | Implementation wrong | Engine already remediates (≤3); if exhausted → fresh slice with sharpened SECTION/SLICE/PATHS |
| all-`unproven` verdicts | Verifier couldn't gather evidence — infra, not code | STOP: engine/provisioning bug class (F7's signature). Fix engine via codex-gated loop; **re-verify, don't re-drive** |
| `provisioning_failed` | F7 failed closed | Inspect manifests/node_modules state; usually env drift; fix + re-run |
| `no_deliverable` | Implementor produced nothing | Permission/prompt policy problem (grok denial class) — fix steering/config, fresh run |
| RSS / limit pause | Watchdog or provider limit | `set-budget --resume` / `resume` per §13; budgets live in `scripts/dogfood/dogfood.config.json` |
| crash mid-run | Process died | Today: resume — **but see F8**; if §16.3 refuses, fresh slice (until F8 lands) |

Three vocabulary nuances that change how you read the table:

- **`no_deliverable` is not a `LoopOutcome`.** It surfaces as a thrown `NoDeliverableError` from `runRole` (`service.ts:2694`), so it appears as an error, not a verdict. And it fires whenever a remediation round produces no new commit (`deliverable.ts:30`) — which is why acceptance criteria must be code-fixable (feasibility law L10).
- **`merge_ready` is deliberately NOT in `TERMINAL_PHASES`** (`state.ts:29` = `cancelled`, `failed`), so `cancel` stays legal from it. A `merge_ready` run is finished for you, not for the engine.
- **Worktrees are always left on disk** (`orchestrate.ts:926`) for verifier/human integration; only the lease is released. Cleanup is manual (see risk #11).

House rules that stay absolute: green ≠ correct (codex diff-review is the merge gate for engine changes AND for each dogfood merge); review the artifact at the exact commit (`codex -C <worktree>`, never feed it prior reviews, `< /dev/null` for stdin); human owns approve/merge/push.

## 5. Risk register

1. **F8: cadence checkpoints make crashed runs unresumable — and the root cause is structural.** A cadence checkpoint fires at a *turn* boundary and captures the *pre-commit* HEAD; the implementor commits after its turn loop (`implementor.ts:969-978`); §16.3 then refuses on **any** drift (`validate.ts:244-253`). So every round's tail is unresumable, not some edge case. Fix shape locked for spec review: **(A)** forward-containment acceptance (`merge-base --is-ancestor`) + **(C)** write the missing `pre_verify_handoff` checkpoint after `commitAll` — PLAN §12.2 mandates it and the vocabulary exists (`state.ts:349-354`, `src/checkpoint/cadence.ts:27,38`) with **zero production writers**. (B) deferred. Spec: `docs/engine-fix-f8-resume-spec.md`. **Land before the expensive daemon slices (2a+)**; until then the only recovery is a fresh slice.
2. **Grok on React/Vite is unproven** — engine slices were backend TS. B0 exists to burn this down early. Watch: file-scope discipline in `web/`, RSS budget (2048MB set), permission denials on new tool shapes.
3. **Coordinator spec variance** — the approval gate caught a self-contradictory spec once. Mitigation is the gate itself + SECTION/SLICE/PATHS tightness + "mutually satisfiable, machine-checkable" now written into the goal template.
4. **Codex verifier wall-clock/cost at xhigh** — bounded per-slice contracts (§6A table) keep it tractable; watch the F7 `npm ci` path (slow) vs APFS clone path (fast) in provisioning.
5. **Serial human gates dominate latency** — two decisions per slice (approve, merge). Consider fixed daily windows; the UI being built is itself the long-term fix (attention inbox).
6. **Engine self-modification risk** — slice 1a rewrites the very command layer the harness runs on; 2a adds a writer lease the CLI must respect. The LAND gate (suite + typecheck + rebuild) plus codex diff-review of each merge is the defense; never skip the rebuild step.
7. **macOS Seatbelt network no-op** (accepted, "KEEP AUTO"): grok isn't network-sandboxed on macOS; home-isolation keeps its native telemetry/web off. Standing accepted risk on your own repo.
8. **Old-run debris** — two stale assignment worktrees + branches (`ef952b1` chain, `28485ea`). Keep `ef952b1` as reference until fresh 1a merges, then clean.
9. **Test-suite contamination by agent worktrees.** Any `.claude/worktrees/*` copy of the repo doubles `npm test` (vitest's default excludes miss `.claude/`). A stale copy passes self-consistently, silently inflating counts and wall-time; a diverged copy could fail a green tree. Fixed at this LAND gate: (a) the root `vitest.config.ts` excludes `**/.claude/**` — it survives future agent worktrees, which we use routinely — plus the standing floor `vitest list --filesOnly` ≥ 103; (b) `git worktree remove .claude/worktrees/agent-ad6b0180db834588b && git worktree prune` — the F7 history branch `worktree-agent-ad6b0180db834588b` (`59d002d`) survives, only the checkout directory goes. Note: assignment worktrees are engine-created from the committed tree, so the **verifier was never affected**; this is a primary-checkout issue only.
10. **UI docs are missing engine states.** `resource_exhausted` (suspension), `provisioning_failed` and `no_deliverable` appear zero times in `UI-DESIGN-BRIEF.md` / `UI-IMPLEMENTATION-PLAN.md`, while the engine defines six `SUSPENSION_KINDS` (`state.ts:39`). A UI built from those docs renders an RSS-killed run blank. Recorded as **Revision 12** of the UI plan; slices 4 and 6a must carry the full vocabulary into their specs *before* they are drafted.
11. **Cleanup is designed-but-absent.** `removeWorktree` (`manager.ts:532`) and `gcSweep` (`store.ts:209`) have **zero production callers** — worktrees and the CAS grow forever, and every run leaves its worktree on disk by design (`orchestrate.ts:926`). Not urgent; schedule as an ops-hygiene engine slice ("harness clean", designed in `ORCHESTRATOR-NOTES.md:354`).
12. **The claude adapter is the only one with no home isolation** (`factory.ts:22` acknowledges it) — and the coordinator runs under it. Accepted for now (trusted role, reads-only workspace); revisit at the daemon phase.

## 5A. Engine-fix queue (land at this LAND gate, codex-gated)

Four fixes, all surfaced by real runs rather than by review, all specced against the current tree. Each lands through the same loop: codex spec-review → implementation on a branch → codex diff-review → merge → suite + typecheck + rebuild.

| Fix | What breaks today | Severity | Spec |
|---|---|---|---|
| **F8** | any implementor round that commits and then dies is permanently unresumable | HIGH | `docs/engine-fix-f8-resume-spec.md` |
| **F9** | provisioning stamps unproven trees as proven — broken script-less installs, sticky broken trees, the false clone | HIGH | `docs/engine-fix-f9-provisioning-spec.md` |
| **F10** | on git 2.55 the staging helper's `:(exclude)node_modules` pathspec exits 1, so **every** harness commit path dies | BLOCKER | `docs/engine-fix-f10-staging-spec.md` |
| **F11** | the grok read-only classifier rejects `$`/backslash/backtick even inside quotes — one backslash in a quoted regex killed slice-1a round 1 | HIGH | `docs/engine-fix-f11-grok-shell-quoting-spec.md` |

F10 and F11 are the two 2026-07-25 misses that a green suite could never have caught; both are now permanently drilled by `scripts/dogfood/preflight.sh` (F10 directly, F11 by removing the trap). That battery is the durable lesson of this queue: **prove the engine against the current machine, not only against itself.**

## 6. Operating agreement (who does what)

- **Claude (this session + successors): lead orchestrator.** Plans, writes/pins slice scopes, fires runs, monitors the event log, triages outcomes, drives engine-fix loops through executor agents, does surgical git (merge + rebuild), maintains docs/memory. **Never** builds UI by hand, never approves specs, never pushes.
- **Executor agents** (opus thinker / sonnet mechanical): engine fixes only, on branches, always through the codex diff gate.
- **Codex: the adversarial gate.** Every engine diff, every landed slice. This is the load-bearing quality mechanism; a green suite is necessary, never sufficient.
- **You (the human):** spec approvals (exact hash), merges, pushes, budget/risk calls, scope changes. Two touchpoints per slice, plus any pause/resume calls.

## 7. Metrics (read from `~/.harness/harness.db` + per-run manifests; later from the UI itself)

Per slice: remediation rounds used · verdict mix (passed/failed/unproven) · wall-clock per stage · $ per role (cost_accounting projection) · engine bugs surfaced. Trend target: rounds → 1.0, unproven → 0, $/slice stable. The dogfood's dividend: slice 2b+ makes these visible in the product.

## 8. Landscape (why we keep building this)

**"Augment by Intent" is actually *Intent* by Augment Code** (macOS app, public beta Feb 2026): coordinator drafts spec → human approves plan → parallel implementors in worktrees → a verifier agent checks against the spec. That is the closest shape to ours — but its verifier is not cross-vendor by design, there is no hash-bound immutable spec, no fail-closed verdict taxonomy, and no durable audit trail (the source material is silent on all four).

Survey of Conductor, Vibe Kanban, Claude Squad, Sculptor (Imbue), Terragon (shut down, OSS'd), Omnara, cmux, Claude Code Agent Teams, and Codex manager/workers: **nobody combines** (a) an immutable spec gate + (b) cross-vendor verification + (c) fail-closed / no-auto-merge readiness + (d) event-sourced audit + (e) an ACP cross-harness abstraction. Most reduce to "parallel worktrees + dashboard + human eyeballs the diff". Native vendor features structurally *cannot* do (b) — a vendor grading its own homework. **(b)+(c)+(d) together is the gap we own**, and nobody builds on ACP despite 25+ agents supporting it.

**Steal for the Control UI:** Intent's always-visible living-spec pane next to diffs/evidence; Sculptor's inline surfacing of "agent claimed tests passed but didn't" (exactly our verifier-discrepancy rendering); Omnara's push-notification + mobile approval flow (which directly attacks our gate-latency lever, §3).

**Second-round verification (READMEs read directly):** agent-teams-ai — peer review is possible but not enforced, human approval is the real gate, no verdicts. **Agent Orchestrator** — 23 bespoke adapters plus a separately-configurable *reviewer-harness pool*: the best prior art for (b) anywhere, but user-configured rather than enforced, with no verdict/report layer and unconfirmed audit. agent-deck — the conductor escalates, it does not verify. **kodo** — the closest philosophical cousin: real ACCEPTED/REJECTED loops with an off-tools orchestrator, but its verifier is role-independent rather than vendor-independent, and it **auto-commits after each stage by default**, a genuine fail-closed divergence. Vibe Kanban correction: Bloop shut down 2026-04-10; the project is community-maintained OSS now.

**Thesis after two survey rounds:** vendor-**enforced** independent verification + formal fail-closed verdicts + a durable event-sourced audit, *together*, remains unoccupied. Cite Agent Orchestrator's split worker/reviewer pools and kodo's reject/accept loop as prior art in any positioning writeup.

## 9. Decisions needed from you

1. **Confirm the finish-line definition** (§0) — and whether M-MVP is a ship point or just a checkpoint.
2. **Slice 1a spec approval** — the fresh coordinator run will stop at `awaiting_approval`; review + approve the exact hash (command printed by `start-slice.sh`, also in my session summary).
3. **B0 next** (recommended) — yes/no on running the fixture-shell slice right after 1a merges.
4. **Engine-fix landing order** — F8 is now specced (`docs/engine-fix-f8-resume-spec.md`), and F9/F10/F11 joined it (§5A). F10 is a BLOCKER on the current git, so it lands regardless; the call you own is whether F8+F9 land before slice 2a as recommended, or after.
5. ~~**Docs hygiene**~~ — **RESOLVED.** Forced by the engine's clean-workspace gate; the review-trail docs were committed as `481e772`.

## 10. Known doc bugs (LAND-gate chores)

Found while cross-checking the docs against the tree. None are urgent; all are cheap, and each one has already cost someone a wrong assumption.

- **`--max-budget` does not exist** (`README.md:534`, `PLAN.md:168`). The real knob is `budget.maxBudgetUsd` via `--config`.
- **Binary name vs help text** — the bin is `harness-orchestrator` while the usage banner says `usage: harness` (`args.ts:31`).
- **`PLAN.md:31` says opencode/grok are deferred** — both adapters are fully built and grok is the dogfood implementor.
- **The "F7" label is reused for three unrelated items.** Fix indices when touching those docs; the engine fix is the one specced in `docs/engine-fix-worktree-deps-spec.md`.
