# Harness Control — UI Implementation Plan

Status: implementation-planning handoff
Scope: turn the imported `Harness Control` design into a shippable local-first control room, seam-first.
Companion inputs (read these alongside this plan):

- `docs/design/Harness Control.dc.html` — the single-file interactive prototype (visual + interaction source of truth).
- `docs/design/support.js` — the `dc-runtime` React renderer that drives the prototype (generated; not production code).
- `docs/UI-DESIGN-BRIEF.md` — the normative brief this design realizes (§ references below point here).
- `PLAN.md` / `README.md` — the engine contract this UI binds to.

> This document is a PLAN, not an implementation. No UI source has been written. The only new files produced by this handoff are the design import under `docs/design/` and this plan. Every existing engine file is read-only context.

---

## Revision 2 — architectural review response

An architectural review returned **"approve after architectural revision."** The visual/product work was endorsed; the weakness was the backend boundary — the plan treated `src/serve/` as a thin transport adapter when it must be a real **application/execution layer**. This revision folds in all six blocking changes and the corrections. Every cited code claim was re-verified against the current tree before folding in:

| Cited claim | Verified? | Where folded |
|---|---|---|
| Command composition/validation lives in CLI; `handleApprove` (`src/cli/commands.ts:593`) does spec-draft + hash validation a direct `service.approve()` bypasses; `start/run/recheck/resume` composed via `handleX` from `executeCommand` (`commands.ts:178`) | ✅ | §3.4, §3.5, Phase A0 |
| No engine event bus (only `BoundedQueue`, scoped to `src/adapters/acp/transport.ts`); events written to SQLite by whatever process runs the command → cross-process writes | ✅ | §3.3(c), §3.7 |
| Browser must not re-reduce: plan asked the client to fold raw WS events into its snapshot (old §4.1/§6) | ✅ (self) | §4.1, Phase B, §6 |
| `OrchestrationService` constructor-binds `#config`/`#bounds`/`#breaker` (`service.ts:1107-1117`); `#worktreeSupervision` is a single "CURRENT" manager; CLI builds a fresh service per run from persisted config (`cli/index.ts:104`) | ✅ | §3.6, Phase A |
| Local HTTP security: `PLAN.md:182` already mandates loopback + scoped tokens + **Origin validation** + bounded drop+replay subscriber queues + cursor=(run_id,sequence) + read-only isolation from the writer | ✅ | §3.8, Phase A gate |
| Desktop: `package.json:22` build is `tsc` only (no Vite/Electron); Phase F sidecar contradicts "quit UI, keep service running" | ✅ | Phase F |
| `model-resolution.ts` `HARNESSES` is a **closed** production allowlist (claude/codex/opencode at time of writing — actively growing) + `asHarness` throws on unknowns → no shipped "fake harness" | ✅ | §6 |
| `event-repository.ts:34` `fromSequence` is **inclusive** (`sequence >= ?`) → reconnect returns a duplicate | ✅ | §3.7, Phase A, §6 |
| Activity overpromise: only usage is folded centrally (`role-runner.ts:15,57-61`, `cost.ts:foldUsageUpdate`); agent message chunks consumed privately | ✅ | Phase D |
| Design now committed at `46ac79a` (Agent Room extension) | ✅ | Appendix |

**Two precision notes (refinements, not rebuttals — neither changes a recommendation):**
1. `executeCommand` (`commands.ts:178`) already takes a structured `(service, db, RunCommand, env, deps)` signature, not `argv` — so Phase A0 is a **lift-and-formalize** of the `handleX` composition out of `src/cli/`, not a from-scratch build. The review's core point stands: the validation and orchestration live in the CLI module and a direct `service.*` call bypasses them.
2. The review calls the bounded queue "future"; it is in fact **implemented and in use**, but only inside the ACP transport (`src/adapters/acp/transport.ts`), not as an engine-wide event bus. The conclusion is unchanged: there is no bus for `serve` to subscribe to.

**Endorsed and kept unchanged:** React + Vite, browser-first sequencing, the two-surface terminal model, durable-first UX, the failure/recovery screens as the differentiator, and Electron-last.

---

## 0. TL;DR

- **What the design is:** one self-contained, *interactive* React-runtime prototype (not a static canvas) that already covers **all 20** of the brief's §26.3 required screens plus extras (attention inbox, workspaces, command palette, context inspector, events inspector). It is dark-only, information-dense, and faithfully encodes the engine's three-axis state model.
- **Biggest match:** the prototype's data model *is* the engine's `phase × suspension × operation` model, event vocabulary, and resume-by-cursor semantics. Design and engine are unusually well-aligned.
- **Biggest gap (all on the backend):** the engine has a rich CLI + SQLite read-model core but **no network layer**. Nothing binds a browser to the engine yet. Confirmed absent: `harness serve` daemon, multi-run listing, live event relay, durable interactive-action queue, PTY broker.
- **Recommended stack:** React + TypeScript + Vite in a new `web/` workspace; a new `src/serve/` **application/execution layer** inside the existing Node/TS engine (loopback HTTP + multiplexed WS) — **not** a thin transport: it reuses a shared command executor, runs per-run execution contexts, relays events cross-process-safely, and ships behind a security gate (§3.4–§3.8); xterm.js + node-pty for terminals; Electron desktop wrapper last (per brief §13.6).
- **Build first:** **Phase A0** — extract the CLI-independent command executor (today command validation/composition lives in `src/cli/commands.ts`, e.g. `handleApprove`'s spec-draft/hash checks that a direct `service.approve()` would bypass) — *then* **Phase A** (`serve`), proven by a **read-only vertical slice**: fleet list + one run's durable snapshot + live event tail with **exclusive** cursor-resume, behind the security gate, against a run created through the shared executor with injected fake deps. Then add the first *command* (approve, through the executor) to prove the *validated* write path.

---

## 1. Design understanding (STEP 2 output)

### 1.1 Nature of the artifact

- **Format:** `.dc.html` = a claude.ai "design canvas" document. `<head>` loads `./support.js`; the body is a single `<x-dc>` custom element containing a `<helmet><style>…</style></helmet>` token block and one big template, followed by a `<script type="text/x-dc" data-dc-script>` carrying a `DCLogic` component class and a `data-props` schema.
- **Runtime:** `support.js` is `dc-runtime`, **generated from `dc-runtime/src/*.ts` via bun** (banner says so; do not treat as hand-authored). It is a **React renderer**: it needs `window.React`/`window.ReactDOM`, parses the `<x-dc>` template + the `data-dc-script`, and renders a live component. Templating is `{{ … }}` interpolation with control elements `sc-if` / `sc-for` and inline `style-hover`.
- **Therefore it is an *interactive prototype*, not a mockup.** It has real state, keyboard handlers (`⌘K`, `⌘J`, `[`/`]`), live view switching, density + accent theming knobs, and demo data for seven runs. The implication for production: **the natural implementation is a React app; the `.dc.html` is the visual + interaction contract, not shippable code.**
- **Scope of the single file:** one canvas renders ~16 view sections + shell chrome, switched by `sc-if` view flags (`isRuns`, `isOverview`, `isSpec`, …). Failure states render as composed suspension **banners** above the tab body, keyed off the selected run's `suspension`/`ui`.

### 1.2 Visual system (as actually authored — Foundations, brief §26.1)

Dark theme only (see gap in §2.2). CSS custom properties in the `<style>` block:

| Token group | Values |
|---|---|
| Background ramp | `--bg-0 #0b0e13` · `--bg-1 #0f1319` · `--bg-2 #141922` · `--bg-3 #1a2029` · `--bg-hover #212834` |
| Borders | `--bd #242b35` · `--bd-2 #323b47` |
| Text ramp | `--tx-1 #e6eaf0` · `--tx-2 #97a2b1` · `--tx-3 #616c7e` |
| Accent (active/current) | `--accent #35b0b5` (teal) · `--accent-bg #0f2625` · `--accent-bd #1f4d4e` |
| Amber (waiting/paused/attention) | `--amber #e0a641` (+bg/bd) |
| Red (failed/breaker/destructive) | `--red #e0655a` (+bg/bd) |
| Green (verified/merge-ready — never "merged") | `--green #4fb87e` (+bg/bd) |
| Purple (successor / failover lineage) | `--purple #9a86ff` (+bg/bd) |

- **Typography:** `system-ui` sans for UI; `ui-monospace, Menlo, Consolas` for commits, hashes, paths, commands, event types, model IDs, terminal; `font-variant-numeric: tabular-nums` globally. Base 13px / 1.45. This matches brief §17.4 exactly.
- **Density:** `--row-pad` swaps `9px 12px` (comfortable) ↔ `5px 12px` (compact) via a `density` prop (brief §17.2). Accent is themeable via an `accent` prop (default teal, with blue/purple/grey alternates in the prop schema).
- **Motion:** single `hcpulse` opacity keyframe used only on genuinely-active indicators; `@media (prefers-reduced-motion: reduce)` disables all animation. Matches brief §17.5 ("subtle motion only for real state changes").
- **Aesthetic:** neutral chrome, thin separators, rows-and-lanes, status by label+shape+color (glyphs `◐ ● ‖ ▲ ✓ ↻ ◇ ◫`), limited cards. Squarely the "restrained developer-tool" direction of §17.1. Color is never the sole signal (glyph + label always present).

### 1.3 Screen / component inventory (what's in the file)

Shell chrome (always present in the Runs view): top bar (product mark, workspace switcher, primary nav with attention badge, `⌘K` search/command palette, live-children `2/3` meter, daemon connection dot, New run); reconnect banner (durable-snapshot + `cursor (run-a, seq 27)`); status footer ("Loopback only · session token active", "daemon v0.4.2 · read models ready", "durable snapshot current").

| # | Section (design flag) | Purpose | Notable state it displays |
|---|---|---|---|
| 1 | Run rail (`groups`) | Persistent fleet scan | Groups: Needs attention / Active / Paused-recovering / Recently completed; per-run glyph+label+color, role tag, attention badge |
| 2 | Run header + workflow rail | Selected-run identity & pipeline | goal, id, workspace, base commit, worktree branch, phase label, detail line, last operation, **cost `$0.55 measured + $0.50 est`**, elapsed, node rail (Spec→Approval→Implement→Verify→Merge-ready), remediation-round pill |
| 3 | Overview tab (`isOverview`) | Control room | 3 **role lanes** (Coordinator/Implementor/Verifier) with harness/model/effort, facts, current activity, "independent · read-only worktree" flag; activity summary feed |
| 4 | Spec tab (`isSpec`) | Spec review + approval | revision, `sha256` hash, immutability, in/out scope, acceptance criteria (id/text/cmd), **spec diff v2→v3** (add/chg/del/same), approval panel with proposed profiles |
| 5 | Activity tab (`isActivity`) | Human-readable timeline | filter chips (all/milestones/agent/tools/permissions/recovery), Follow-live toggle, role-colored events with detail + tags |
| 6 | Changes tab (`isChanges`) | Read-only diff viewer | base→impl commit, +/- totals, "live worktree — not yet verified" badge, file list + unified diff; empty state |
| 7 | Verify tab (`isVerify`) | Evidence review | criteria table with verdicts **verified / failed / unproven / running** + evidence counts; verdict legend; empty state |
| 8 | Events tab (`isEvents`) | Technical inspector | ordered per-run log: **seq / time / type / refs / payload size**; read-only |
| 9 | Context inspector | Right rail (run or criterion mode) | operator inbox (permission request w/ allow-deny once/always; spec approval; paused; breaker; blocked); criteria mini; **vitals: context-window used/max, RSS + soft threshold**; **models running vs "desired · next spawn"**; latest checkpoint; alerts w/ delivery meta |
| 10 | Suspension banners | Failure-as-first-class | `pausedPanel` (reset-time-unavailable, probe ladder 1/6, checkpoint, failover ladder), `mergePanel` (manual git commands, "not merged/pushed"), `breakerPanel` (generations, work preserved, worktree tainted→revalidated), `recoverPanel` (attempt N/M, backoff, resume-from ckpt), `blockedPanel` (dirty destination, base drift) |
| 11 | Attention view (`isAttention`) | Cross-run inbox | severity (critical/warning/attention/info), kind, run, text, action, "run blocked" flag, when |
| 12 | Workspaces view (`isWorkspaces`) | Repo registry | name, path, branch, HEAD, dirty/clean, active/done counts, last-activity |
| 13 | Models & harnesses (`isModels`) | Adapter readiness | per-harness auth (validated/detected/unsupported/none), adapter ver, **ACP protocol ver**, model chips, limit-reporting quality, retry-after support, notes |
| 14 | Settings (`isSettings`) | Local config | 8 groups: General, Runtime, Limits & failover, Budget, Verification, Terminal, Notifications, Storage & privacy |
| 15 | Doctor (`isDoctor`) | First-launch readiness | Platform (Node/git/SQLite/OS), Harnesses (adapter+validated), Storage (HARNESS_HOME, quota) |
| 16 | New run (`isNewRun`) | Start flow | workspace picker (git clean badge), goal, coordinator profile, budget cap, pre-submit safety notes |
| — | Terminal drawer (`termOpen`) | Operator shells | 3 tabs: **Worktree shell (input-locked + takeover), Workspace shell (PTY), Orchestrator log (output-only, redacted)**; the log even shows `[daemon] serve listening on 127.0.0.1:7717` |
| — | Command palette (`paletteOpen`) | ⌘K navigation/actions | run jumps, view jumps, simulate-reconnect, tray, mobile |
| — | Desktop tray (`tray`) | Menu-bar status | daemon status, live children, needs-attention list, quit-UI-keep-service, stop-service |
| — | Mobile inspection (`mobile`) | 390px monitor mode | approve / permission / pause only; "takeover, diff, breaker repair require desktop" |

### 1.4 Interaction & navigation model

- **Primary nav (5):** Runs · Attention · Workspaces · Models & harnesses · Settings (brief §8.1). Runs is the default landing view; Attention carries a live count badge.
- **Runs view = rail | main | inspector**, with the main area tabbed (Overview / Spec / Activity / Changes / Verify / Events). The **fleet is the always-present left rail**, not a separate page (see deviation §2.2).
- **Inspector** is a right rail on wide widths; collapses to a slide-over below ~1180px (`narrow`), matching brief §18.2 collapse order.
- **Command palette** (`⌘K`), **terminal drawer** (`⌘J`), run cycling (`[`/`]`), `Esc` to close overlays. Global letter shortcuts must yield to terminal focus (brief §11.4 — not yet modeled in the prototype's key handler; a production requirement).
- **Durable-first:** reconnect banner shows the last snapshot + a `(run_id, sequence)` cursor and disables commands until the command channel is confirmed safe — the design bakes in brief §4.5 / §12.1.

### 1.5 Data/state the screens display (maps to engine, §3)

The prototype's `DCLogic` demo model directly mirrors the engine:

- `phase`: `created · specifying · awaiting_approval · approved · implementing · verifying · needs_remediation · merge_ready · cancelled · failed` (10 — matches engine §7.1).
- `suspension`: `none · paused_limit · breaker_open · interrupted` (design omits `paused_user`; engine has it — see §2.2).
- `operation`: `idle · prompt_turn · model_switch · checkpoint_write · git_op · resume_probe · initial_config_pin` (matches engine §7.3).
- Derived fleet label ("Waiting on you / Working / Verifying / Paused—limit / Breaker open / Merge-ready / Auto-recovering / Interrupted / Integration blocked").
- Event vocab in the Events tab (`run.created`, `turn.started/completed`, `spec.produced`, `permission.requested`, `checkpoint.written`, `verification.result`, `phase.changed`, `child.spawned`, `commit.recorded`, `tool.call`) — a friendly projection of the engine's richer log.
- Cost split, criteria counts ("2 of 3 verified"), model desired-vs-running, alerts with delivery state, context-window + RSS vitals, checkpoints, failover ladders, generations — every one has an engine home (§3.2).
- Canonical runs A–E from brief §23 are all present, plus the two required variants (F interrupted/auto-recovering, G integration-blocked).

---

## 2. Cross-reference vs the brief (STEP 3a)

### 2.1 Screen coverage vs §26.3 (20 required)

**All 20 are realized.** 1 Doctor ✓ · 2 Fleet dashboard ✓* · 3 New run ✓ · 4 Overview/active-verification ✓ · 5 Spec approval ✓ · 6 Spec revision comparison ✓ · 7 Activity ✓ · 8 Changes/diff ✓ · 9 Verification/evidence ✓ · 10 Paused—limit ✓ · 11 Auto-recovering ✓ · 12 Breaker open ✓ · 13 Integration blocked ✓ · 14 Merge-ready ✓ · 15 Models/harnesses ✓ · 16 Settings ✓ · 17 Terminal drawer ✓ · 18 Web reconnect ✓ · 19 Desktop tray ✓ · 20 Mobile inspection ✓. Plus non-required extras: Attention inbox (§10.9), Workspaces (§8.1), command palette, context inspector, Events (§10.15).

### 2.2 Deviations / gaps vs the brief

1. **Fleet "dashboard" is a rail, not a page (*).** §10.2 implies a scannable fleet surface; the design delivers it as the persistent 264px left rail beside a single-run control room (with the Attention view covering triage). This is a reasonable, arguably superior choice (fleet context is always visible) — but there is **no dedicated multi-run grid/table** with sortable columns, cross-run cost totals, etc. Decide whether the rail + Attention is sufficient or a full dashboard page is still wanted.
2. **`paused_user` suspension is not represented.** Engine `events.ts` defines `paused_user`; the prototype models only `none/paused_limit/breaker_open/interrupted`. A user-initiated pause needs its own composed state (banner + rail label) — currently it would fall through to a generic "working"/blank. **Add it.**
3. **Dark-only; no light theme.** Brief §26.1 requires light *and* dark. The token system is CSS-var based, so a light theme is additive, but it is **not designed** yet. Treat as a foundations gap.
4. **Light on empty/loading/error inventory (§20).** The design has a couple (no-changes, no-verify, reconnect); the full matrix (daemon-unavailable, version-mismatch, missing-artifact, corrupt/unreplayable, terminal-disconnected) is not drawn. Needed for production, especially given the durable-first posture.
5. **Terminal keyboard capture (§11.4)** and the six connection states (§12.1) are only partially modeled (reconnect is a boolean; the other five are implicit). Formalize the connection state machine on the client.
6. **Notifications:** the Settings screen lists "Native + in-product," but native delivery is a new backend sink (§3.4). The design promises it; the engine can't deliver it yet.

None of these are blockers; they are the design/engineering backlog once the seam exists.

---

## 3. Engine seam map (STEP 3b) — the heart of the plan

Verified by reading `src/domain/*`, `src/app/*`, `src/cli/*`, `src/persistence/*`, `PLAN.md`. **Normative constraint (PLAN §1.4, §4.2):** *agent control stays on stdio; WebSockets appear only at the observation boundary; `harness serve` is deferred-but-seam-preserved.* The UI is an **observer + command submitter**, never an agent control channel.

### 3.1 What already exists (bind directly)

| Capability | Where | Notes |
|---|---|---|
| Three-axis state + transition table | `src/domain/state.ts`, `src/domain/transitions.ts`, `src/domain/entities.ts` | Source of the phase/suspension/operation vocab the whole UI renders |
| Event vocab, alert & incident kinds | `src/domain/events.ts` | `AlertKind = limit_paused｜crash｜respawn｜breaker_open｜failover`; suspension/topic incl. `paused_user`, `failover_exhausted`, `rss_soft`, `merge_ready`; rich typed event discriminants |
| **Append-only event log w/ resume-by-cursor** | `src/persistence/event-repository.ts`, `migrations.ts` | `events` table `UNIQUE(run_id, sequence)`, `run_sequence_counters` (O(1) next-seq), replay `WHERE run_id=? AND sequence>=? ORDER BY sequence ASC`; projections track `event_cursor`. **This is exactly the design's `(run_id, sequence)` cursor.** |
| Durable read-model projections | `src/app/projections.ts` | `ENGINE_STATE`, `COST_ACCOUNTING`, `RUN_META`, `SPEC_DRAFT`, `ROLE_ROUND`, `RUN_CONFIG`, `MERGE_READINESS_BLOCKED`, `IMPLEMENT_VERIFY_LOOP`; `WorktreeFactsState`; **`uiStateOf(input) → UiState`** (the fleet human-state projection) + `makeEngineReducer` |
| Command surface (in-process) | `src/app/service.ts` (`OrchestrationService`) | `approve`, `reviseSpec`, `cancel`, `pause`, `resume`, `breakerReset`, `alertStatus`, `deliverPendingAlerts`, `checkResumeEligibility`, `effectiveRoleSpec`, `driveFailoverOnLimit`, … |
| CLI clients w/ stable `--json` | `src/cli/commands.ts` | `start · spec_revise · approve · run · recheck · status · resume · pause · breaker_reset · switch_model · cancel · events`. `status --json` already emits the **limit block** (`buildLimitStatus`, shape spec'd in PLAN §13) and **alerts block** (`buildAlertsStatus`) |
| Readiness JSON | `src/cli/doctor.ts` | `--json` platform/harnesses/sqlite/storage → the Doctor screen binds here 1:1 |
| Cost split + role vitals | `src/app/cost.ts` | `CostBucket`, `RoleVital`, `CostProjectionState`, `SessionCost`, `foldUsageUpdate`, `foldTurnUsage`, `wouldExceedBudget` → measured/estimated + context-window vitals |
| Alerts + delivery sinks | `src/app/alerts.ts` | `AlertSink = stderr｜status_json`, `Notifier`, `NotifierRegistry` → alerts-with-delivery-state |
| Process identity + RSS | `src/supervisor/{registry,ps,heartbeat,watchdog}.ts` | `ProcessSample` (RSS telemetry for the inspector vitals) |
| Worktree facts / lease | `src/worktree/{manager,advisory-lease,validate}.ts` | base/commit/branch/dirty facts for Changes + merge-ready + integration-blocked |
| ACP adapters (stdio) | `src/adapters/acp/*`, `claude/*`, `codex/*`, `fake/*` | Capability records → Models & harnesses screen |
| Persistence | `src/persistence/{database,driver,migrations,event-repository,artifact-repository}.ts` | better-sqlite3 / node:sqlite; content-addressed artifacts (evidence) |

### 3.2 Screen → data/command binding (existing vs to-build)

| Screen | Reads (existing projection/query) | Writes (command) | New seam needed |
|---|---|---|---|
| Doctor | `doctor --json` | — | none (wrap existing) |
| Fleet rail / Attention | `uiStateOf` per run + `RUN_META` + alerts | — | **multi-run enumeration** (none today) |
| New run | workspace facts, capability records | `start` | serve POST + workspace/folder picker |
| Overview | `ENGINE_STATE`, `ROLE_ROUND`, `RUN_CONFIG`, `COST_ACCOUNTING`, activity fold | `pause` | snapshot assembly + event tail |
| Spec + revision diff | `SPEC_DRAFT` (+ prior versions), spec hash | `approve`, `reviseSpec` | **durable action submit** + spec-version list |
| Activity / Events | event log replay (`event-repository`) | — | **live event relay** (WS/SSE) |
| Changes | `WorktreeFactsState`, artifact repo, git diff | — | diff read endpoint (git) |
| Verify | `IMPLEMENT_VERIFY_LOOP`, verification events, artifact repo (evidence) | `recheck` | evidence fetch endpoint |
| Inspector: permission inbox | `permission.requested` / `permission.decision.required` events | **respond-to-permission (missing verb)** | **durable interactive-action queue** |
| Paused—limit | `status --json` limit block (`buildLimitStatus`) | `resume`, `switch_model` | serve command submit |
| Breaker open | breaker events, generations, checkpoints | `breaker_reset` | serve command submit |
| Auto-recovering | crash/respawn events, backoff schedule | `pause`/`cancel` | live event relay |
| Integration blocked | `MERGE_READINESS_BLOCKED`, worktree/destination facts | `recheck` | git readiness endpoint |
| Merge-ready | merge-readiness projection, integration commands | (copy only; **never** merge) | none write; read endpoint |
| Models & harnesses | capability records, `desired-model-store`, `failover-store` | `switch_model` | serve command submit |
| Settings | run/global config projections | config writes | config endpoints |
| Terminal drawer | orchestrator log stream; operator shells | takeover (pause+checkpoint+stop) | **PTY broker** + terminal token |
| Reconnect / footer | connection state, cursor, daemon version | — | connection state machine (client) + WS |

### 3.3 Confirmed backend gaps (brief §24) — with evidence

| Gap | Status | Evidence |
|---|---|---|
| (a) `harness serve` daemon (HTTP/WS) | **ABSENT** | No `createServer` / `WebSocketServer` / `.listen(` in `src/`; every `serve`/`ws` grep hit is `preserve`/`reserve`/`observe`. PLAN §4.2 lists `harness serve (WS)` as deferred, seams preserved |
| (b) Multi-run listing API | **ABSENT** | No `listRuns`/`getRuns`/`enumerateRuns` anywhere; the engine is single-`runId`-addressed. Fleet needs a new enumeration read model over the runs/projection scopes |
| (c) Live event relay (WS/SSE) | **ABSENT — and no bus to tap** | The ordered replay *query* exists (`event-repository.ts` `listByRun(runId, {fromSequence})`), but there is **no engine event bus** to subscribe to. PLAN §4.1's "internal event bus (in-process)" is design intent not present in code — the only `BoundedQueue` is scoped to `src/adapters/acp/transport.ts`, not engine-wide. New-event delivery needs either a single-writer daemon (in-process post-append notify) or a SQLite watermark tail (§3.7). Also `fromSequence` is **inclusive** (`:34`) so the public cursor must be exclusive (§3.7, §6) |
| (d) Durable interactive-action queue | **PARTIAL → ABSENT for UI** | `approve`/`reviseSpec` commands exist and are idempotent, but there is **no respond-to-permission verb** and no durable queue for UI-submitted actions that survives restart + dedups by idempotency key |
| (e) PTY broker / terminal streaming | **ABSENT** | No `node-pty`/`pty`; terminals are purely a design concept today. ACP children are stdio and must never be surfaced as terminals (brief §11.1) |
| (f) Native notification sink | **ABSENT** | `AlertSink` is `stderr｜status_json` only; native/in-product delivery is new (desktop phase) |

### 3.4 `serve` is an application/execution layer, not a thin transport

The read models are directly bindable, but **commands are not**. The composition + validation that make a command *safe* live in the CLI layer today, not in `OrchestrationService`:

- `handleApprove` (`src/cli/commands.ts:593`) runs the W1-F3/W3-4 spec-draft + hash binding/validation (`getSpecDraft` → `detectDraftLoss` → bind/verify the approved hash) **before** `service.approve()`. A `serve` route that calls `service.approve()` directly **bypasses** that and can approve a stale/missing draft.
- `handleStart` / `handleRun` / `handleRecheck` / `handleResume` (dispatched from `executeCommand`, `commands.ts:178`) compose service calls with injected `deps.flows` and map engine errors to clean results.

So `serve` **cannot** be a pass-through to the service. Within the boundary it still (a) never touches ACP child stdio, (b) keeps the event-sourced store authoritative, and (c) carries only observations + command submissions over WS (PLAN §1.4) — but it is a real app-layer that reuses the shared command executor and adds operation management, an attention queue, per-run execution contexts, and a security gate. §3.5–§3.8 make that concrete.

### 3.5 Separate three conflated concepts: envelope · operation · attention

The daemon must model these distinctly (Phase A0 formalizes them):

- **Command envelope** — validation, authorization (token), idempotency/retry. Synchronous accept/reject; returns fast.
- **Operation (job)** — the long-running coordinator/implementor/verifier execution driven by `handleStart`/`handleRun`/`handleResume`/`handleRecheck`. Returns a durable `operationId`; the UI tracks progress through **events**, never a blocked HTTP call. Define daemon-restart behavior (an operation whose owner died is recovered through the existing `handleResume` path, gated on the durable run-ownership lease) and run-ownership (only the lease holder drives — `isRunClaimedByLiveProcess`).
- **Attention request** — permission responses, spec approvals, human answers: the **durable interactive-action queue** (gap d), idempotent, surviving restart. Note there is **no respond-to-permission verb** today; it must be added here.

### 3.6 Multi-run execution model (blocking)

**Fact:** `OrchestrationService` constructor-binds `#config`/`#bounds`/`#breaker` (`service.ts:1107-1117`), `#worktreeSupervision` is a single "CURRENT" manager (one-at-a-time, `:1096-1098`), and the CLI builds a **fresh service per run** from that run's persisted config (`cli/index.ts:104`). A single long-lived multi-run service would apply the **wrong** budget/bounds/supervision.

**Decision (recommended):** the daemon holds a small set of per-run **execution contexts** — one service instance (or config-scoped facade) per *actively-driven* run, each resolving that run's pinned config + its own worktree supervision — while **sharing the global durable admission** (`spawn-reservation-store`), **run-ownership leases** (`run-ownership-store`), and **process registry** so the max-live-children cap and §14 identity checks stay global. *Alternative:* refactor `OrchestrationService` to resolve config + supervision per run (a larger change to a load-bearing, review-hardened class). Either way, **read-only** enumeration/snapshot/event endpoints need **no** execution context (they hit the store) — so the fleet + inspection UI works before this lands.

### 3.7 Cross-process event & write model (blocking)

**Fact:** there is no engine bus; events are appended to SQLite by whichever process runs the command, and a CLI in a *separate* process is a real writer. A bus living inside `serve` would not see those writes. Pick one explicit model:

- **A (recommended) — daemon is the single command writer.** When a daemon is running, the CLI **forwards** commands to it over loopback instead of writing directly; the daemon appends in-process and notifies subscribers synchronously. Needs a CLI→daemon forward path + a "no daemon ⇒ write directly" fallback. Cleanest ordering + backpressure; matches PLAN §182's "read-only isolation from the writer."
- **B — daemon tails SQLite by per-run sequence watermark.** Supports arbitrary external CLI writers, but needs a change signal (better-sqlite3 `update_hook` / WAL poll) and careful watermark advance. More robust to unknown writers, more moving parts.

**Cursor is EXCLUSIVE at the public boundary.** `event-repository` `listByRun`'s `fromSequence` is *inclusive* (`:34`, `sequence >= ?`), so a client reconnecting with its last-seen sequence would get that event **again**. Define the wire cursor as `after=<lastSeen>` and translate to `fromSequence = lastSeen + 1` (or require documented client-side dedup). The Phase A "no dupes" acceptance depends on this.

**WS must be MULTIPLEXED.** A single `/events` socket carries a **fleet channel** + **per-run cursor subscriptions**. A per-run-only socket cannot discover a newly-active run and cannot drive the Attention view; the fleet channel announces new/became-active runs and the client opens per-run subscriptions on demand.

### 3.8 Local HTTP security — a Phase A acceptance GATE (blocking)

`PLAN.md:182` already requires, *when `serve` is built:* "loopback-only, random scoped tokens, **Origin validation**, bounded drop+replay subscriber queues, cursor = (run_id, sequence), read-only isolation from the writer." This is a privileged command (and later PTY) server, so security is **not deferrable**. Phase A ships only when all of these hold:

- **Host + Origin allowlist** — reject any non-loopback `Host`/`Origin` (defeats **DNS-rebinding**; loopback bind alone does not).
- **CSRF protection for REST writes** — require a custom header / the session token, never rely on ambient cookie auth.
- **Explicit WebSocket auth** — token in the WS subprotocol or first message, **not** the query string (no token leakage into logs/history).
- **One-time bootstrap-token delivery** without query-string leakage; tokens random + scoped + expiring.
- **Restrictive permissions (0600)** on the daemon **connection-metadata** file (host/port/token).
- **Single-daemon locking + stale recovery + port discovery** — a lockfile carrying `{pid, port, start-time}`; a dead/recycled owner is reclaimed; clients discover the port from the metadata file, not a hard-coded `7717`.

---

## 4. Recommended tech stack & code layout (STEP 4)

### 4.1 Stack

| Concern | Choice | Justification |
|---|---|---|
| UI framework | **React + TypeScript** | `support.js`/`dc-runtime` proves the design is authored against React (`window.React`/`ReactDOM`). Porting the `<x-dc>` template + token system to React is near-mechanical; components map 1:1 to the `sc-for`/`sc-if` structure |
| Bundler/dev | **Vite** | Fast local dev, first-class TS, trivial static build to serve from the daemon; no CDN dependency (self-host fonts; tokens are already inline CSS vars) |
| Command path | **Shared command executor** extracted to `src/app/commands/` (Phase A0), called by BOTH the CLI and `serve` | Every write runs the same validation (e.g. `handleApprove`'s W3-4 draft/hash checks); `serve` never calls `service.*` directly (§3.4) |
| Server data | **REST snapshots + a MULTIPLEXED WS** (`/events`: fleet channel + per-run cursor subscriptions); server projects `UiState` and emits **typed read-model deltas** or plain invalidations | Snapshot = durable truth on connect (brief §4.5/§12.1). The server owns projection (`uiStateOf`); the wire carries applied deltas/invalidations, not raw engine events |
| Client cache | TanStack Query for snapshots; WS messages are **(i) invalidation → refetch** or **(ii) typed deltas applied verbatim** — **no client-side reducer**. Raw events feed **only** the Activity/Events views | The browser must never re-run engine reduction (blocking 3); authoritative run state always comes from a server projection |
| Security | Host/Origin allowlist + scoped token + CSRF + WS-subprotocol auth + daemon lockfile/port-discovery | Phase A acceptance gate (§3.8), not deferred |
| Terminal | **xterm.js** (client) + **node-pty** (server PTY broker) | Standard, loopback-only, token-scoped per brief §11.5 |
| Desktop | **Electron** (last) | Brief §13.6: lower-integration-risk wrapper for a Node/TS engine using **native Node modules** (better-sqlite3). Tauri only if footprint later justifies a Rust host + Node sidecar. No Electron-specific chrome in the UI |
| Transport lib | Node `http` + `ws` (or Fastify + `@fastify/websocket`) | Minimal; in-process with the engine. Avoid heavy frameworks |

Self-contained: no external CDN assumptions. The prototype references Google Fonts for JetBrains Mono, but production uses `ui-monospace`/system mono per the actual `<style>` block, so no remote font dependency is required.

### 4.2 Where code lives

```
harness-orchestration/
  src/
    app/
      commands/       ← NEW (Phase A0): CLI-independent command executor + handleX
                         composition + validation, lifted from src/cli/commands.ts.
                         Models envelope · operation · attention (§3.5). Used by CLI + serve.
    serve/            ← NEW: the daemon — an application/execution layer (NOT a thin transport)
      http.ts         ← REST: /runs, /runs/:id/snapshot, /doctor, POST /commands (envelope)
      ws.ts           ← MULTIPLEXED relay: /events (fleet channel + per-run cursor subs)
      execution/      ← per-run execution contexts (config/supervision-scoped, §3.6);
                         global admission + run-ownership + registry shared
      actions.ts      ← durable interactive-action / attention queue (§3.5), idempotent
      security.ts     ← Host/Origin allowlist, token, CSRF, WS auth, lockfile + port discovery (§3.8)
      writer.ts       ← the single-writer path OR the SQLite watermark tail (§3.7)
      projections/    ← run-enumeration + snapshot assembly read models
      pty.ts          ← PTY broker (Phase E)
  cli/
    commands.ts       ← becomes a THIN client over src/app/commands (CLI contract unchanged)
  web/                ← NEW workspace: Vite React app (the UI)
    src/{app,shell,screens,components,tokens,client}/
  desktop/            ← NEW (Phase F): Electron wrapper — see lifecycle decision in Phase F
```

Rationale: the engine's event-sourced SQLite store stays the single source of truth. `src/serve/` is a real **application/execution layer** that (a) reuses the shared command executor so it never bypasses command validation, (b) runs per-run execution contexts for driven runs, and (c) enforces the security gate — while read-only endpoints hit the store directly. `web/` builds to static assets the daemon serves on loopback; `desktop/` wraps the same web build. This matches "browser UI first, then desktop" (brief §1, §13.6).

---

## 5. Phased plan (dependency-ordered, seam-first)

Each phase lists **delivers · seams (existing vs to-build) · screens · acceptance criteria**.

### Phase A0 — Extract the shared command executor (build FIRST, before any HTTP route)

- **Delivers:** a CLI-independent command layer in `src/app/commands/` that BOTH the CLI and `serve` call — the **envelope** (validate/authorize/idempotency), the `handleStart`/`handleRun`/`handleRecheck`/`handleResume`/`handleApprove` composition (incl. `handleApprove`'s W1-F3/W3-4 draft+hash validation), and the **operation/attention** split (§3.5). No behavior change to the CLI contract.
- **Seams — existing:** `executeCommand(service, db, RunCommand, env, deps)` already has a CLI-independent signature (`commands.ts:178`) with `deps.flows`/`adapterFactory` injection — this is a **lift-and-formalize**, not a from-scratch build.
- **Seams — to build:** relocate `handleX` + validation out of `src/cli/`; define `Command envelope` vs `Operation` (returns a durable `operationId` for `start`/`run`/`resume`/`recheck`) vs `Attention request` (+ the missing respond-to-permission verb); define **daemon-restart + run-ownership** behavior for in-flight operations (recover through the existing `handleResume` path, gated on the run-ownership lease).
- **Screens:** none (backend refactor).
- **Acceptance:** the existing CLI suite passes unchanged (it now calls the shared layer); a non-CLI caller invoking `approve` gets the **same** W3-4 draft/hash validation a direct `service.approve()` would skip; a long-running `start` returns a durable `operationId`; a parity test proves CLI-vs-executor outcomes are identical.

### Phase A — `serve` daemon (the seam every screen binds to)

- **Delivers:** a loopback **HTTP + multiplexed WS** daemon exposing run enumeration, per-run durable snapshots, an ordered event relay with **exclusive** cursor resume, and a command/attention submit endpoint over the Phase-A0 executor — behind the §3.8 security gate, with the §3.7 write model chosen and §3.6 per-run execution contexts for driven runs.
- **Seams — existing:** the A0 executor; `projections.ts` (+ `uiStateOf`); `event-repository` `listByRun(runId, {fromSequence})`; `status`/`doctor --json`; global admission (`spawn-reservation-store`), `run-ownership-store`, process registry.
- **Seams — to build:** (b) multi-run **enumeration** read model (no `listRuns` today); (a) HTTP + multiplexed WS on loopback with **port discovery** (not a hard-coded `7717`); (c) the chosen event-delivery mechanism — **single-writer notify** (recommended) or **SQLite watermark tail** (§3.7); (d) the durable **attention** queue; per-run **execution contexts** (§3.6); the **security gate** (§3.8); daemon **lockfile** + stale reclaim.
- **Screens:** none yet, but the precondition for every screen.
- **Acceptance:**
  - `GET /runs` returns each run's `uiStateOf` projection + meta; `GET /runs/:id/snapshot` is assembled purely from read models (no live process needed).
  - **Exclusive cursor:** `/events` replays from `after=<lastSeen>` (→ `fromSequence = lastSeen+1`, because the repo query is inclusive, `:34`) then streams new events in `(run_id, sequence)` order — reconnect returns **no duplicate** and no gap.
  - **Multiplexed WS:** a newly-created/became-active run appears on the fleet channel **without a page reload**; the client opens a per-run subscription on demand; the Attention view is driven from the fleet channel.
  - **Cross-process:** a run advanced by a **separate CLI process** still streams to connected clients (proves the §3.7 model); `command-accepted → daemon-crash` leaves a **recoverable** durable operation.
  - **Multi-run:** two active runs with **different pinned configs** each execute under the correct budget/bounds/supervision (proves §3.6); the global max-live-children cap still holds across them.
  - **Security gate (BLOCKS SHIP):** rejects non-loopback `Host`/`Origin` (DNS-rebind); requires a scoped token; CSRF on REST writes; WS auth off the query string; `0600` connection-metadata; single-daemon lock with stale reclaim.
  - Deterministic tests drive the flows through the A0 executor with **injected fake deps** (see §6) + temp SQLite; no live provider.

### Phase B — App shell + core read screens

- **Delivers:** the React shell (top bar, 5-nav, footer, `⌘K` palette, connection banner) + the three read screens that prove the model end-to-end: **Fleet rail/Attention, Run Overview (control room), Spec review**.
- **Seams — existing:** Phase A endpoints; `SPEC_DRAFT`, `ROLE_ROUND`, `RUN_CONFIG`, `COST_ACCOUNTING`.
- **Seams — to build:** client snapshot hydration + **delta-apply / invalidation-refetch (no client reducer, blocking 3)**; spec-version listing (prior revisions) for the diff; connection state machine (6 states, §12.1).
- **Screens:** 1 Doctor, 2 Fleet, 4 Overview, 5 Spec (+6 revision diff read-only), 18 Reconnect.
- **Acceptance:** fleet groups + attention badge reflect live `uiStateOf`; opening a run renders the composite status grammar (`[Phase] · [suspension/operation]`, brief §7.4); cost shows measured+estimated **separately**; authoritative run state comes only from server projections (the client holds **no** engine reducer; raw events feed only Activity/Events); reconnect keeps the last snapshot, disables commands, resumes from the **exclusive** cursor, and does **not** replay toasts.

### Phase C — Failure & recovery screens (the product differentiator)

- **Delivers:** the composed suspension states that make this product distinct: **Paused—limit, Auto-recovering, Breaker open, Integration blocked, Merge-ready** — plus the write actions each needs.
- **Seams — existing:** `status --json` limit block (`buildLimitStatus`), `MERGE_READINESS_BLOCKED`, breaker/crash/respawn/failover events, checkpoints; service `resume`/`breakerReset`/`recheck`/`switch_model`/`driveFailoverOnLimit`.
- **Seams — to build:** command-submit wiring for these verbs via Phase A's action queue; `paused_user` state (deviation §2.2); "recheck readiness" git endpoint; integration-command copy (read-only, never executes merge).
- **Screens:** 10, 11, 12, 13, 14 (+ the Attention items that route into them).
- **Acceptance:** each failure state answers brief §4.4's five questions (what happened / what's safe / what's the orchestrator doing / must I act / safe next action); **"reset time unavailable"** is shown literally (never an invented ETA); merge-ready shows manual git commands and asserts nothing was merged/pushed; breaker reset is gated behind explicit inspection and preserves incident history.

### Phase C2 — Core management screens (+ write APIs)

- **Delivers:** the four management surfaces the earlier phases don't schedule, **with their write paths**: New Run (start), Workspaces (repo registry + add), Models & harnesses (effective/desired model, failover ladder), Settings (runtime/limits/budget/verification/terminal/notifications/storage).
- **Seams — existing:** capability records; `desired-model-store`; `failover-store`; `run-config`/global config; `doctor --json`.
- **Seams — to build:** `start` via the A0 executor + a workspace/folder picker (native in desktop, path entry in browser); config **write** endpoints; a desired-model / failover-ladder write path. Validation must reject unsupported values at the boundary, mirroring `model-resolution.ts` (the closed `HARNESSES` allowlist; `asHarness` throws on unknowns) and the failover-ladder parse gate (harness ∈ the runtime vocabulary, effort in the reasoning ladder).
- **Screens:** 3 New run, 12 Workspaces, 13 Models & harnesses, 14 Settings.
- **Acceptance:** writes are validated + idempotent; an invalid harness/effort is rejected with a clear message (never accepted then failed deep in dispatch); **no empty controls** for unsupported/deferred features (brief §25); "desired model" is shown distinctly from "running" and only applies on next spawn (brief §4.3).

### Phase D — Activity, Changes, Verify, Events

- **Delivers:** the inspection surfaces: filtered activity timeline (Follow-live), read-only diff viewer, verification/evidence table with criterion inspector, technical event log.
- **Seams — existing:** event replay; `WorktreeFactsState` + git diff; `IMPLEMENT_VERIFY_LOOP` + verification events; artifact repository (content-addressed evidence). **Note:** only **usage** is folded centrally today (`role-runner.ts:15,57-61` wraps `onUpdate`; `cost.ts:foldUsageUpdate`); coordinator/verifier **message chunks** are consumed *privately* by the flows (`implementor.ts` `child.stdout.on('data')`) and are not on the durable event stream.
- **Seams — to build:** diff read endpoint (git), evidence-fetch endpoint (artifact CAS), activity filter projections, Follow-live backpressure — and, for a full agent-activity feed, a **bounded, redacted observation sink** (decide durable vs ephemeral; redact at the sink via `src/redaction/*`). Until that exists, Activity shows the **milestone/event-log-derived** timeline (phase changes, verifications, permissions, checkpoints, commits), not raw agent narration.
- **Screens:** 7 Activity, 8 Changes, 9 Verify (+ criterion evidence inspector), Events tab.
- **Acceptance:** criteria show four distinct verdicts (verified/failed/**unproven**/running) — never collapsed; evidence artifacts open from the inspector; diff is strictly read-only (no merge/push affordance); Events shows the true `(seq,type,refs)` log; Activity clearly distinguishes durable milestones from any (redacted, bounded) live narration; Follow-live inserts rows without losing scroll position and respects reduced-motion.

### Phase E — Terminal drawer + PTY broker

- **Delivers:** the operator-shell drawer: Worktree shell (input-locked + explicit takeover), Workspace shell (PTY), Orchestrator log (output-only, redacted); terminal-focus keyboard capture.
- **Seams — existing:** worktree lease/validation; redaction (`src/redaction/*`); supervisor stop/checkpoint path for safe takeover.
- **Seams — to build:** (e) node-pty broker; scoped, expiring terminal session token; takeover flow (pause → checkpoint → identity-verified stop → validate → enable input); optional tmux control-mode enumeration (brief §11.3, deferrable).
- **Screens:** 17 Terminal drawer.
- **Acceptance:** ACP children are **never** exposed as terminals (brief §11.1); worktree input stays locked while the run owns it; "Take over" pauses+checkpoints+stops safely before enabling input; terminal keystrokes win focus and `⌘K` does not steal input; loopback-only with an expiring token; redaction applies to the orchestrator log.

### Phase F — Desktop wrapper + native integration

- **Delivers:** Electron app wrapping the web build; native folder picker, notifications (new AlertSink), dock/tray attention badge, deep-link to run, secure token storage, close/quit semantics.
- **Daemon lifecycle (resolve the contradiction):** a normal child sidecar dies with the app, which breaks "quit UI, keep service running." Pick one:
  - **(i) separately-installed background daemon / LaunchAgent** — Electron only connects; never owns lifecycle.
  - **(ii) detached, independently-managed daemon** — spawned detached with `{pid, port, token}` in the connection-metadata file (§3.8), reaped only on explicit "Stop service…". *Recommended* — matches the tray's "Quit UI · keep service running" + "Stop service…" most literally.
  - **(iii) Electron stays alive as a tray process** — "quit UI" only closes windows; the app (and its child `serve`) keep running in the tray.
- **Seams — existing:** everything above; `alerts.ts` `NotifierRegistry` (add a native sink); the daemon lockfile/port-discovery from §3.8.
- **Seams — to build:** (f) native notification sink + delivery-state feedback; tray/menu-bar; the chosen lifecycle + reaping; `better-sqlite3` **native-module rebuild** for Electron's ABI. **Packaging is greenfield:** `package.json:22` `build` is `tsc` only — there is **no** Vite asset build and **no** desktop packaging yet; both are new work.
- **Screens:** 19 Tray, 20 Mobile (responsive web, validated here), plus native chrome.
- **Acceptance:** closing the window does not stop runs (teaches the choice, brief §13.4); notifications are actionable + privacy-conscious (no raw prompts/paths/secrets, brief §13.5) and deep-link to the exact attention item; the same web UI runs unchanged in browser and desktop (no Electron-only chrome). **Packaging/CI tests:** code signing + notarization, `better-sqlite3` rebuild for the Electron ABI, clean install, and upgrade/migration.

### Cross-cutting (every phase)

Foundations port (tokens, type scale, density, motion, **+ new light theme** and the empty/loading/error matrix §2.2); accessibility (roles/labels/keyboard order per brief §19); responsive collapse order (§18.2) validated at 1440/1280/1024/768/390; redlines/engineering notes per screen (§26.7): fields consumed, commands invoked, safety-confirmation rules.

**Testing & acceptance (failure-first).** Beyond happy-path, the `serve` layer must have explicit tests for: cross-process writers (a CLI in another process advancing a run the daemon serves); daemon restart **mid-operation** (recover via resume + run-ownership lease); slow / backpressured WS subscribers (bounded **drop + replay**, PLAN §182); `SQLITE_BUSY` / DB contention; stale connection-metadata (dead pid/port reclaim); multiple browser clients on one run seeing identical ordered streams; command **idempotency** under retry; **command-accepted-then-daemon-crash** leaving a recoverable operation; and **exclusive-cursor no-duplicate** on reconnect. Drive all of these through the A0 executor with injected fake deps (§6) — no live provider.

---

## 6. Build FIRST + smallest vertical slice

**Build first: Phase A0 (shared command executor) → Phase A's seam, proven by a read-only slice.**

**Smallest end-to-end vertical slice (proves the architecture):**

1. Create a real run **without a production harness**: call the A0 executor (or the current `executeCommand`) with **injected fake flow + adapter deps** — `src/adapters/fake/*` via `deps.flows` + `OrchestrationServiceOptions.adapterFactory` — so it runs offline and lands durable events + projections in SQLite. A shipped "fake harness" *value* is impossible: `model-resolution.ts` defines a **closed** production `HARNESSES` allowlist (claude/codex/opencode at time of writing — actively growing) and `asHarness` throws on anything outside it, so the fake path is a **test/fixture injection** (`src/adapters/fake/*` via `deps`), never a production harness id.
2. Stand up `src/serve/` with three read routes behind the **§3.8 security gate** (loopback + Host/Origin + token — even the read-only slice is gated): `GET /runs` (new enumeration → `uiStateOf`), `GET /runs/:id/snapshot` (from existing projections), and the **multiplexed** `WS /events` with a per-run subscription at `after=<lastSeen>` (**exclusive** cursor → `fromSequence = lastSeen+1`, because the repo query is inclusive, `event-repository.ts:34`).
3. Build a minimal `web/` React shell that renders the **fleet rail + one Run Overview**, hydrating from the snapshot and **applying server deltas / refetching on invalidation — no client-side reducer**, read-only.
4. Prove **cursor-resume with no duplicate**: reconnect with `after=<lastSeen>` and assert the first replayed event is `lastSeen+1` (not `lastSeen`), no gaps, no toast replay; and prove the **fleet channel** surfaces a second run created meanwhile without a reload.

This exercises the whole spine: the shared executor (A0), enumeration (gap b), snapshot assembly (existing projections), multiplexed relay + exclusive cursor (gap c), the security gate (§3.8), and server-projected client state — everything else is additive. **Slice 2** adds the first write: `approve` **through the A0 executor** (so the W3-4 draft/hash validation runs) via the durable attention queue (gap d), proving the validated, idempotent command path.

Why this and not a failure screen first: the failure screens are the differentiator, but they are worthless without the seam; a read-only slice de-risks the *observation boundary* (the part PLAN §1.4 is strict about) before any write surface — but note security and the shared executor are in from slice 1, not bolted on later.

---

## 7. Risks & open questions (for the user to decide)

**Resolved by this revision (were open; now decided):** WS (multiplexed), not SSE — §3.7/§4.1. Server-projected `UiState` + deltas/invalidation, **no** client reducer — §3.4/§4.1. Security is a Phase A **gate**, not a deferral — §3.8.

**New decisions for the user (each shapes the daemon):**

1. **Event-delivery + write model (§3.7).** Single-writer daemon with **CLI-forwarding** (recommended, model A) vs SQLite **watermark tail** (model B). Model A implies the CLI's default changes: *when a daemon is running, the CLI forwards commands to it instead of writing directly* — confirm that behavior change is acceptable (it is what gives clean ordering + backpressure + PLAN §182 writer-isolation).
2. **Multi-run execution (§3.6).** Per-run **execution contexts** sharing global admission/registries (recommended) vs refactoring `OrchestrationService` for per-run config/supervision (larger change to a review-hardened class).
3. **Desktop daemon lifecycle (Phase F).** Detached independently-managed daemon (recommended, matches the tray copy) vs tray-process vs separately-installed LaunchAgent.
4. **Multi-run enumeration source.** Add a dedicated `runs` index/projection vs enumerate projection scopes — and how §15 retention/pruning interacts with "recently completed" in the rail.
5. **Agent Room boundary.** PLAN §4.1/§7's optional localhost planning chat (`start --enable-chat`, forced `127.0.0.1`, off the default path) is **orthogonal** to `serve` (planning-time chat vs run-observation), but shares the localhost-server precedent. Decide whether `serve` hosts/proxies it or stays separate, and whether the New-run/Spec flow surfaces it in-UI. (Now committed in the design at `46ac79a`.)

**Still-standing design/build risks (not new):** `paused_user` + the full §12.1 six-state connection machine are under-modeled in the prototype (in-scope Phase A/B); light theme + the empty/loading/error matrix are foundations gaps (§2.2); **terminal takeover** is the highest-risk write path — its checkpoint→identity-verified-stop→validate sequence must reuse the supervisor's existing §14 identity checks, never a parallel stop path; terminal sessions need their own scoped, expiring token (brief §11.5).

---

## Appendix — provenance & source-of-truth lock

- **Design source-of-truth (lock before implementation):** `docs/design/Harness Control.dc.html` at commit **`46ac79a`** ("Add the Agent Room planning-chat feature to the design"); the canonical claude.ai/design copy was updated to match. Implementation should pin this hash and re-verify screen/field bindings if the design changes.
- Design imported to `docs/design/` at the session level (DesignSync was not reachable inside the planning subagent; the orchestrator fetched the current single-file `Harness Control.dc.html` + `support.js`, then committed the Agent Room extension at `46ac79a`).
- A stale predecessor snapshot ("Intent Next — design package," multi-file, dated earlier) exists only in the session scratchpad and was **not** used; this plan is built solely against the imported current files and the engine source.
- **Revision 2 (this doc):** every code claim from the architectural review was re-verified against the current tree (line refs in the "Revision 2" section) before folding in; the two precision notes there are refinements, not rebuttals.
