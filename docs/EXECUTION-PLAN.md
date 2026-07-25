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
| Engine suite green at F7 land | 206 files / 3398 tests on both SQLite drivers, typecheck 0 (recorded at merge; the gate re-proves it every merge). |

## 2. The recurrence — one dogfood slice (run this loop ~16×)

```
slice(i):
  PREFLIGHT   clean tree · dist rebuilt from merged HEAD · budget sanity ·
              SECTION/SLICE/PATHS written · plan SHA pinned
  START       scripts/dogfood/start-slice.sh  → coordinator drafts spec → awaiting_approval
  GATE-1      HUMAN reviews spec (contradictions! AC-3-vs-AC-5 class) → approve EXACT hash
              (revise via `spec_revise` if needed — the gate caught a bad spec once already)
  RUN         scripts/dogfood/run-slice.sh → grok implements in worktree → host commits →
              F7 provisions node_modules at the verify boundary → codex verifies →
              ≤3 remediation rounds
  GATE-2      merge_ready report → HUMAN merges (never the engine)
  LAND        full suite + typecheck on merged tree → npm run build (next run uses the
              NEW binary) → clean tree → per-run manifest recorded ($HARNESS_HOME/logs)
  LEARN       triage anything surprising → engine-fix queue or prompt/config tweak →
              memory + docs updated
```

Cost basis (run 1 actuals): coordinator ≈ $1.5 (532k in / 31k out, opus xhigh); grok implementor cheap; codex xhigh verification is the variable part. Budget rough order: **$3–8 per clean slice**, more with remediation rounds.

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

House rules that stay absolute: green ≠ correct (codex diff-review is the merge gate for engine changes AND for each dogfood merge); review the artifact at the exact commit (`codex -C <worktree>`, never feed it prior reviews, `< /dev/null` for stdin); human owns approve/merge/push.

## 5. Risk register

1. **F8 (new today): cadence checkpoints make crashed runs unresumable.** §16.3 resume-in-place compares HEAD to the *last cadence checkpoint*; an implementor commit after the last checkpoint → permanent refusal (`validate.ts:251`). Mirror of the F7-round-4 verifier fix: validation should bind to the engine's *persisted implementation commits* (accept HEAD == recorded round commit; else refuse), and/or checkpoint at the post-commit boundary F7 already owns. **Schedule: spec + codex review in parallel with slices 1a/B0; land before the expensive daemon slices (2a+)** where a mid-run crash would force a costly redo. Until then: fresh-slice fallback.
2. **Grok on React/Vite is unproven** — engine slices were backend TS. B0 exists to burn this down early. Watch: file-scope discipline in `web/`, RSS budget (2048MB set), permission denials on new tool shapes.
3. **Coordinator spec variance** — the approval gate caught a self-contradictory spec once. Mitigation is the gate itself + SECTION/SLICE/PATHS tightness + "mutually satisfiable, machine-checkable" now written into the goal template.
4. **Codex verifier wall-clock/cost at xhigh** — bounded per-slice contracts (§6A table) keep it tractable; watch the F7 `npm ci` path (slow) vs APFS clone path (fast) in provisioning.
5. **Serial human gates dominate latency** — two decisions per slice (approve, merge). Consider fixed daily windows; the UI being built is itself the long-term fix (attention inbox).
6. **Engine self-modification risk** — slice 1a rewrites the very command layer the harness runs on; 2a adds a writer lease the CLI must respect. The LAND gate (suite + typecheck + rebuild) plus codex diff-review of each merge is the defense; never skip the rebuild step.
7. **macOS Seatbelt network no-op** (accepted, "KEEP AUTO"): grok isn't network-sandboxed on macOS; home-isolation keeps its native telemetry/web off. Standing accepted risk on your own repo.
8. **Old-run debris** — two stale assignment worktrees + branches (`ef952b1` chain, `28485ea`). Keep `ef952b1` as reference until fresh 1a merges, then clean.

## 6. Operating agreement (who does what)

- **Claude (this session + successors): lead orchestrator.** Plans, writes/pins slice scopes, fires runs, monitors the event log, triages outcomes, drives engine-fix loops through executor agents, does surgical git (merge + rebuild), maintains docs/memory. **Never** builds UI by hand, never approves specs, never pushes.
- **Executor agents** (opus thinker / sonnet mechanical): engine fixes only, on branches, always through the codex diff gate.
- **Codex: the adversarial gate.** Every engine diff, every landed slice. This is the load-bearing quality mechanism; a green suite is necessary, never sufficient.
- **You (the human):** spec approvals (exact hash), merges, pushes, budget/risk calls, scope changes. Two touchpoints per slice, plus any pause/resume calls.

## 7. Metrics (read from `~/.harness/harness.db` + per-run manifests; later from the UI itself)

Per slice: remediation rounds used · verdict mix (passed/failed/unproven) · wall-clock per stage · $ per role (cost_accounting projection) · engine bugs surfaced. Trend target: rounds → 1.0, unproven → 0, $/slice stable. The dogfood's dividend: slice 2b+ makes these visible in the product.

## 8. Landscape (why we keep building this)

*(Full survey to be appended when the research agent reports.)* Working thesis, to be validated: the crowded space is "parallel agent session managers" (worktree/tab orchestrators) and cloud task farms; almost none combine an **immutable spec-approval gate + cross-vendor independent verification + fail-closed verdicts + event-sourced audit + merge-readiness (never auto-merge)**. That governed-verification stack is the moat; the dogfood is the demo.

## 9. Decisions needed from you

1. **Confirm the finish-line definition** (§0) — and whether M-MVP is a ship point or just a checkpoint.
2. **Slice 1a spec approval** — the fresh coordinator run will stop at `awaiting_approval`; review + approve the exact hash (command printed by `start-slice.sh`, also in my session summary).
3. **B0 next** (recommended) — yes/no on running the fixture-shell slice right after 1a merges.
4. **F8 priority** — approve spec'ing it now (parallel track, lands before slice 2a) vs deferring until it bites again.
5. **Docs hygiene** — the review-trail docs (`engine-fix-worktree-deps-review-codex-*.md`, handoffs, this plan) are untracked; commit them (recommended: `docs/` is the provenance record) or drop them.
