# Project Onboarding — Harness Orchestration + the UI Dogfood

*Everything a new person needs to get oriented fast. Last updated 2026-07-25.*
Deeper docs: `PLAN.md` (architecture), `docs/UI-IMPLEMENTATION-PLAN.md` (the UI build), `docs/HANDOFF-dogfood-F7.md` (the current engine fix in detail), `docs/engine-fix-worktree-deps-spec.md` (F7 contract).

---

## 1. What this project IS (the one-paragraph mental model)

**The harness is a cross-harness agent-orchestration engine.** It drives multiple coding-agent CLIs — "harnesses" like Claude Code, Codex, and Grok — through the **ACP** (Agent Client Protocol, stdio JSON-RPC) to complete software tasks safely. A task runs through a fixed lifecycle: a **coordinator** drafts an immutable spec, a **human approves** it (binding an exact hash), an **implementor** writes the code inside an isolated git worktree, and an **independent verifier** re-runs the acceptance checks and gathers its own evidence. The engine never auto-merges — it produces a **merge-readiness report** for a human. It adds process supervision (per-agent RSS watchdog), usage-limit pause/resume, checkpoints, and provenance memory on top.

Repo: `harness-orchestration` · remote `github.com/maplenk/harness-control` · TypeScript/ESM, Node ≥ 22.14, vitest + tsc. The engine was originally bootstrapped by Codex (see `PLAN.md`, a 20-section architecture doc).

---

## 2. Core vocabulary (learn these 12 terms and the rest reads easily)

| Term | Meaning |
|---|---|
| **harness** | A coding-agent CLI the engine drives (claude, codex, grok, …). |
| **ACP** | Agent Client Protocol — the stdio JSON-RPC the engine speaks to each harness. |
| **coordinator / implementor / verifier** | The three roles in a run. Coordinator drafts the spec; implementor writes code; verifier independently checks it. |
| **spec-approval gate** | A run cannot implement until a human approves the coordinator's spec (binds an immutable spec hash). |
| **worktree isolation** | Each assignment implements in its own `git worktree` (a sibling dir), never the primary checkout. |
| **remediation round** | If verification fails, the implementor is re-driven — **bounded** (default 3 rounds) then the run fails. |
| **merge_ready** | Terminal success: criteria verified + §16 readiness clean. The engine reports it; a **human merges**. |
| **fail-closed** | On any doubt the engine refuses/halts rather than risk a false pass. The #1 safety property. |
| **verdict: passed / failed / unproven** | Per-criterion verifier result. `unproven` = "I couldn't gather evidence" (a fail-safe — never a fabricated pass). |
| **no_deliverable / provisioning_failed** | Distinct terminal outcomes: the implementor produced nothing / dependency provisioning couldn't be proven. |
| **event store / CAS** | Durable state. Event log = `~/.harness/harness.db` (SQLite `events` table: `sequence,type,payload_json`). Artifacts/evidence = `~/.harness/artifacts/` (content-addressed). |
| **the dogfood** | We build the harness's *own* Control UI by *running the harness on itself* — one run per slice. |

---

## 3. The run lifecycle (what actually happens)

```
start ──► (coordinator drafts spec, blocks) ──► human approve (binds spec hash)
      ──► run ──► implement (grok writes code + commits in a worktree)
              ──► [F7] provision node_modules at the verify boundary
              ──► verify (codex re-runs typecheck/vitest, gathers evidence)
              ──► pass? ─► merge_ready (human merges)
                  fail? ─► bounded remediation (≤3 rounds) ─► else terminal fail
```

CLI (`node ./dist/cli/index.js <cmd>`): `start → approve → run → status | resume | recheck | cancel | pause`. There is **no serve daemon yet** — monitoring reads the SQLite event log directly.

**Three-vendor split (deliberate — independent verification across vendors):**
- coordinator = `claude:opus:xhigh` (Anthropic)
- implementor = `grok:grok-build:high` (xAI, native ACP)
- verifier = `codex:gpt-5.6-sol:xhigh` (OpenAI)

---

## 4. What's BUILT

- **The engine** (per `PLAN.md`): ACP adapters (claude, codex, grok), SQLite event store, spec-approval gate, worktree isolation + single-writer lease, checkpoint/successor sessions, RSS watchdog + supervision, usage-limit pause/resume, merge-readiness reporting.
- **Engine fixes F1–F6 + 7 hardening rounds** — the *first* dogfood run surfaced 6 real engine bugs (see §6); fixed and codex-verified. Landed.
- **F7 — worktree dependency provisioning** (just landed, `main` @ `5669d22`): provisions a real, git-ignored, manifest-bound `node_modules` into each worktree at the verify boundary (APFS copy-on-write clone when manifests match the primary checkout, else `npm ci --ignore-scripts`), transactional + **fail-closed**. This is what makes verification actually runnable. See §6.
- **Native Grok adapter** (`grok:grok-build`) — added first-class; replaced opencode as the implementor.
- **Dogfood tooling**: `scripts/dogfood/{start-slice,run-slice,monitor,slice-1a,reverify,watch}.sh` + `dogfood.config.json` (per-role RSS budget).

## 5. What we're DOING (the dogfood) & who does what

**Goal:** build the harness's own Control UI (`docs/UI-IMPLEMENTATION-PLAN.md`, ~16 slices) **only** by running the harness on itself — grok implements each slice, codex verifies, a human merges. **Hard rule: no UI is built by hand.**

**Roles in *our* workflow:**
- **Claude (orchestrator)** — plans, designs, delegates to executor agents, reviews, monitors, does surgical git. Does *not* build the UI directly.
- **Executor agents** — opus (thinker) / sonnet (mechanical) subagents do implementation work on branches.
- **Codex** — the **adversarial review gate**. Every plan and every diff passes codex before it lands. *This is the load-bearing quality mechanism.*
- **The human (user)** — makes the key calls (scope, risk, approach), does the final `git push` and merges to `main`.

**The process loop:** plan → codex pushback on the plan → implement (agent, on a branch) → **codex diff-review** → land → human push.

---

## 6. Issues we faced (the real story — this is where the learning is)

1. **Stale `dist` rejected the run (exit 2).** The CLI runs the *built* binary; a stale `dist/` (gitignored) used old code. **→ always `npm run build` before a run.**
2. **Self-contradictory spec (AC-3 vs AC-5).** The coordinator's spec asked for two impossible-together things; the human caught it at the approval gate. **→ the approval gate works; use `spec revise`.**
3. **opencode blew the RSS budget** (1.08 GiB at startup) and an empty implementation marched into verify. This **surfaced 6 real engine bugs** (a watchdog graceful-stop was recorded as a *successful* `turn.completed`, so an empty-handed implementor looped remediation). **→ F1–F6 + 7 codex rounds; opencode replaced by native grok.**
4. **Engine-fix rounds kept regressing.** Each "green" round had codex-found holes + new regressions — the **tests literally encoded the wrong behavior**. **→ THE lesson: a green suite ≠ correct. Codex's adversarial diff-review is the real merge gate, not `npm test`.**
5. **Grok produced "no deliverable" six times** (whack-a-mole: it got denied on `mkdir`/`cp`/`echo`/`/dev/null`, each denial fatal). **→ fixed with grok `--permission-mode auto` (auto-approves its own tools) + an "implement and stop, don't self-run the verify commands" prompt.**
6. **macOS `--sandbox strict` is a network no-op** (Seatbelt network block is Linux-only). So grok under `auto` is not network-sandboxed on macOS. **→ the human accepted the residual risk ("KEEP AUTO") on their own repo; grok's native web/telemetry stays off via home-isolation.**
7. **THE BIG ONE — Dogfood Run 1 (§3A.1) false-negatived.** It ran the full loop and ended `NoDeliverableError`. Root cause = **F7**: the engine created worktrees **without `node_modules`**, so `npm run typecheck`/`npx vitest` exited **127** (`tsc`/`vitest: command not found`); the read-only verifier couldn't gather evidence → every criterion `unproven` → remediation exhausted. **Grok's code (`ef952b1`) was actually correct** — proven by manually providing `node_modules`: typecheck 0, 40/40 tests. **The engine failed *safe* (a false *negative*, never a false positive) — the correct direction to err.**
8. **F7 took 8 codex rounds to get right** — 2 on the spec, 6 on the diff:
   - *Spec v1* (symlink `node_modules`) — codex killed it: a symlink isn't matched by `.gitignore node_modules/`, so it gets committed + breaks resume. *Spec v2* (provision at worktree-create) — killed: the implementor edits manifests *after* create; must provision at the post-commit boundary + fail-closed. → **v3**: real git-ignored dir, boundary provisioning, fail-closed, out-of-worktree transaction.
   - *Diff review*: findings converged **10 → 8 → 7 → 4 → 1 → 0**. Every single round, a fully-green suite (1655→1699 tests) still hid real blockers (stale trees, error-vs-absence, backup loss on crash, resume verifying the wrong commit, …). Scope was deliberately capped to **MVP-correct**, deferring adversarial-implementor hardening (spec §5).
9. **Two tooling gotchas worth knowing:**
   - **Codex echo bug:** feeding codex the *prior review doc* as context made it regurgitate stale findings and review the *parent* commit. **→ always run codex reading the on-disk files at the fix commit (`-C <worktree>`), never hand it the previous review.**
   - **Codex stdin hang:** `codex exec` in the background waits on stdin. **→ add `< /dev/null`.**

---

## 7. Current state (as of 2026-07-25)

- **F7 is LANDED** on `main` as `5669d22` (squash of the 6-round codex-reviewed branch). `dist` rebuilt; full suite **green: 206 files / 3398 tests on both SQLite drivers**, typecheck 0.
- **Preserved uncommitted:** a grok prompt-steering edit in `src/app/flows/implementor.ts` (the human's WIP — do not discard).
- **Untracked:** the codex review docs + handoff (process artifacts; keep-or-drop is the human's call).
- **The F7 branch** is preserved at `59d002d` (`worktree-agent-ad6b0180db834588b`) for granular history / a `--no-ff` re-merge if preferred over the squash.

## 8. What's LEFT

1. **`git push`** the F7 merge — the human does this (Claude never pushes).
2. **Re-verify grok's `ef952b1`** through the now-fixed engine → expect a legitimate `merge_ready`. Scripts ready: `scripts/dogfood/reverify.sh` (resume the run; it drops the manual salvage-proof `node_modules` symlink first — F7 fails closed on a symlinked `node_modules`) + `scripts/dogfood/watch.sh` (live monitor). If the *old* run is remediation-exhausted, start a **fresh** slice instead (`scripts/dogfood/start-slice.sh`).
3. **Continue the ~16 UI slices** via the dogfood (order ≈ B0 fixture shell → A0 1a[done-pending-merge]/1b → Phase A serve daemon → first visible proof slice → …). See `docs/UI-IMPLEMENTATION-PLAN.md`.
4. **F7 deferred hardening** (spec §5, 8 items) — only if/when needed: real npm-workspace support, nested `node_modules`, realpath symlink-chain containment, npm-env/`.npmrc` isolation, runtime toolchain-provenance attestation, full npm lifecycle sandbox, writable-tree integrity re-check, journaled crash-recovery. All are malicious-implementor / rare-crash hardening; the cooperative dogfood doesn't need them.
5. **Separate track (human-owned):** the native grok harness integration.

---

## 9. Key files & where state lives

| Path | What |
|---|---|
| `PLAN.md` | Codex's 20-section engine architecture (source of truth for design). |
| `docs/UI-IMPLEMENTATION-PLAN.md` | The ~16-slice UI build the dogfood is executing. |
| `docs/HANDOFF-dogfood-F7.md` | Detailed F7 state + merge/rebuild plan (the immediate handoff). |
| `docs/engine-fix-worktree-deps-spec.md` | F7 design contract (v3) + §5 deferred list. |
| `docs/engine-fix-worktree-deps-review-codex-*.md` | The codex review trail (v2 spec, diff rounds 1–3). |
| `docs/F7-IMPL-NOTES.md` | Per-finding fix log from the implementing agents. |
| `docs/engine-fixes-status.md`, `engine-fixes-round{5,6,7}-spec.md` | The F1–F6 engine-fix record. |
| `src/worktree/provision.ts` | The F7 provisioning engine (new). |
| `src/app/flows/{coordinator,implementor,verifier,orchestrate,deliverable}.ts` | The run flows. |
| `scripts/dogfood/*.sh` | Dogfood run/monitor tooling. |
| `~/.harness/harness.db` | The run event log (SQLite). Query: `sqlite3 -readonly ~/.harness/harness.db "SELECT sequence,type,payload_json FROM events WHERE run_id='…' ORDER BY sequence"`. |
| `~/.harness/artifacts/` | Content-addressed store: verifier evidence, checkpoints, specs. |

## 10. Principles that keep being proven right

- **Green ≠ correct.** Tests repeatedly encoded wrong behavior. Codex's adversarial diff-review is the gate.
- **Fail closed.** The engine errs toward false negatives, never false positives — a good implementation rejected beats a bad one merged.
- **Dogfooding finds what nothing else does.** F7 was invisible until the harness ran on itself.
- **Review the artifact, not the story.** Codex must read on-disk code at the exact commit; a prior review as "context" corrupts the next one.
- **Human owns the irreversible steps** — approvals, merges, pushes, and risk calls. Claude plans, delegates, reviews, and monitors.
