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

## 0. TL;DR

- **What the design is:** one self-contained, *interactive* React-runtime prototype (not a static canvas) that already covers **all 20** of the brief's §26.3 required screens plus extras (attention inbox, workspaces, command palette, context inspector, events inspector). It is dark-only, information-dense, and faithfully encodes the engine's three-axis state model.
- **Biggest match:** the prototype's data model *is* the engine's `phase × suspension × operation` model, event vocabulary, and resume-by-cursor semantics. Design and engine are unusually well-aligned.
- **Biggest gap (all on the backend):** the engine has a rich CLI + SQLite read-model core but **no network layer**. Nothing binds a browser to the engine yet. Confirmed absent: `harness serve` daemon, multi-run listing, live event relay, durable interactive-action queue, PTY broker.
- **Recommended stack:** React + TypeScript + Vite in a new `web/` workspace; a new `src/serve/` daemon inside the existing Node/TS engine (HTTP + WS on `127.0.0.1`); xterm.js + node-pty for terminals; Electron desktop wrapper last (per brief §13.6).
- **Build first:** the `harness serve` seam, proven by a **read-only vertical slice** — fleet list + one run's durable snapshot + live event tail with cursor-resume — against a real run created by the existing CLI. Then add the first *command* (approve) to prove the write path.

---

## 1. Design understanding (STEP 2 output)

### 1.1 Nature of the artifact

- **Format:** `.dc.html` = a claude.ai "design canvas" document. `<head>` loads `./support.js`; the body is a single `<x-dc>` custom element containing a `<helmet><style>…</style></helmet>` token block and one big template, followed by a `<script type="text/x-dc" data-dc-script>` carrying a `DCLogic` component class and a `data-props` schema.
- **Runtime:** `support.js` is `dc-runtime`, **generated from `dc-runtime/src/*.ts` via bun** (banner says so; do not treat as hand-authored). It is a **React renderer**: it needs `window.React`/`window.ReactDOM`, parses the `<x-dc>` template + the `data-dc-script`, and renders a live component. Templating is `{{ … }}` interpolation with control elements `sc-if` / `sc-for` and inline `style-hover`.
- **Therefore it is an *interactive prototype*, not a mockup.** It has real state, keyboard handlers (`⌘K`, `⌘J`, `[`/`]`), live view switching, density + accent theming knobs, and demo data for seven runs. The implication for production: **the natural implementation is a React app; the `.dc.html` is the visual + interaction contract, not shippable code.**
- **Scope of the single file:** one canvas renders ~16 view sections + shell chrome, switched by `sc-if` view flags (`isRuns`, `isOverview`, `isSpec`, …). Failure states render as composed suspension **banners** above the tab body, keyed off the selected run's `suspension`/`ui`.

### 1.2 Visual system (as actually authored — Foundations, brief §26.1)

Dark theme only (see gap in §3.4). CSS custom properties in the `<style>` block:

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
| (c) Live event relay (WS/SSE) | **PARTIAL → mostly ABSENT** | Underlying ordered query `readEvents(runId, sinceSeq)` exists; there is **no bus→socket fan-out** to push new events to clients. In-process event bus exists (PLAN §4.1) but is not network-exposed |
| (d) Durable interactive-action queue | **PARTIAL → ABSENT for UI** | `approve`/`reviseSpec` commands exist and are idempotent, but there is **no respond-to-permission verb** and no durable queue for UI-submitted actions that survives restart + dedups by idempotency key |
| (e) PTY broker / terminal streaming | **ABSENT** | No `node-pty`/`pty`; terminals are purely a design concept today. ACP children are stdio and must never be surfaced as terminals (brief §11.1) |
| (f) Native notification sink | **ABSENT** | `AlertSink` is `stderr｜status_json` only; native/in-product delivery is new (desktop phase) |

### 3.4 The one architectural rule to hold

`serve` is **in-process with `OrchestrationService`**: it reads the same SQLite read models and submits commands through the same service methods — it does **not** re-implement state, and it does **not** touch ACP child stdio. WS/SSE carry *observations* (snapshots, events, telemetry) and *command acknowledgements* only. This honors PLAN §1.4 and keeps the existing deterministic replay-by-sequence core authoritative.

---

## 4. Recommended tech stack & code layout (STEP 4)

### 4.1 Stack

| Concern | Choice | Justification |
|---|---|---|
| UI framework | **React + TypeScript** | `support.js`/`dc-runtime` proves the design is authored against React (`window.React`/`ReactDOM`). Porting the `<x-dc>` template + token system to React is near-mechanical; components map 1:1 to the `sc-for`/`sc-if` structure |
| Bundler/dev | **Vite** | Fast local dev, first-class TS, trivial static build to serve from the daemon; no CDN dependency (self-host fonts; tokens are already inline CSS vars) |
| Server data | **REST for snapshots + WS for the event tail**; a small typed client | Snapshot = durable truth on connect (brief §4.5/§12.1); WS streams ordered `(run_id, sequence)` deltas. Prefer **server-projected `UiState`** (reuse `uiStateOf`) so the client stays a thin renderer and never re-derives state |
| Client cache | TanStack Query (snapshots) + a reducer that folds WS events by sequence into the cached snapshot | Mirrors the engine's fold; gives cursor-resume + optimistic-free correctness |
| Terminal | **xterm.js** (client) + **node-pty** (server PTY broker) | Standard, loopback-only, token-scoped per brief §11.5 |
| Desktop | **Electron** (last) | Brief §13.6: lower-integration-risk wrapper for a Node/TS engine using **native Node modules** (better-sqlite3). Tauri only if footprint later justifies a Rust host + Node sidecar. No Electron-specific chrome in the UI |
| Transport lib | Node `http` + `ws` (or Fastify + `@fastify/websocket`) | Minimal; in-process with the engine. Avoid heavy frameworks |

Self-contained: no external CDN assumptions. The prototype references Google Fonts for JetBrains Mono, but production uses `ui-monospace`/system mono per the actual `<style>` block, so no remote font dependency is required.

### 4.2 Where code lives

```
harness-orchestration/
  src/
    serve/            ← NEW: the daemon (HTTP+WS), in-process with OrchestrationService
      http.ts         ← routes: /runs, /runs/:id/snapshot, /doctor, command POSTs
      ws.ts           ← event relay: subscribe(runId, sinceSeq) → ordered push
      auth.ts         ← loopback bind + session-token issuance/verification
      projections/    ← run-enumeration + snapshot assembly read models (NEW)
      actions.ts      ← durable interactive-action queue (approvals/permissions)
      pty.ts          ← PTY broker (later phase)
  web/                ← NEW workspace: Vite React app (the UI)
    src/{app,shell,screens,components,tokens,client}/
  desktop/            ← NEW (last): Electron wrapper + serve sidecar
```

Rationale: the engine stays the single source of truth; `src/serve/` is a thin, testable adapter over it; `web/` builds to static assets the daemon serves on loopback; `desktop/` wraps the same web build. This matches "browser UI first, then desktop" (brief §1, §13.6).

---

## 5. Phased plan (dependency-ordered, seam-first)

Each phase lists **delivers · seams (existing vs to-build) · screens · acceptance criteria**.

### Phase A — `harness serve` daemon (THE seam; build first)

- **Delivers:** a loopback HTTP+WS daemon, in-process with `OrchestrationService`, that exposes: run enumeration; per-run durable snapshot; ordered event relay with resume-by-cursor; and a command/action submit endpoint. Plus session-token auth and the connection state machine the client needs.
- **Seams — existing:** `OrchestrationService` methods; `projections.ts` (+ `uiStateOf`); `event-repository` replay `readEvents(runId, sinceSeq)`; `status/doctor --json`.
- **Seams — to build:** (b) multi-run enumeration read model; (a) HTTP+WS server on `127.0.0.1` (design port `7717`); (c) bus→socket fan-out that pushes new `(run_id, sequence)` events; (d) durable interactive-action queue with idempotency keys; session-token issuance + loopback guard.
- **Screens:** none yet (pure backend), but it is the precondition for every screen.
- **Acceptance:**
  - `GET /runs` returns each run's `uiStateOf` projection + meta; `GET /runs/:id/snapshot` returns a durable snapshot assembled purely from read models (no live process needed).
  - `WS /runs/:id/events?since=<seq>` replays from the cursor then streams new events **in `(run_id, sequence)` order**, no gaps, no dupes, resumable after a disconnect.
  - A command POST (start with `approve`) submits through `OrchestrationService`, is idempotent under retry, and emits the resulting events on the WS.
  - Binds loopback-only; rejects without a valid session token; a second client sees the same ordered stream.
  - Deterministic tests use the existing `fake` adapter + in-memory/temp SQLite; no live provider needed.

### Phase B — App shell + core read screens

- **Delivers:** the React shell (top bar, 5-nav, footer, `⌘K` palette, connection banner) + the three read screens that prove the model end-to-end: **Fleet rail/Attention, Run Overview (control room), Spec review**.
- **Seams — existing:** Phase A endpoints; `SPEC_DRAFT`, `ROLE_ROUND`, `RUN_CONFIG`, `COST_ACCOUNTING`.
- **Seams — to build:** client snapshot+WS fold; spec-version listing (prior revisions) for the diff; connection state machine (6 states, §12.1).
- **Screens:** 1 Doctor, 2 Fleet, 4 Overview, 5 Spec (+6 revision diff read-only), 18 Reconnect.
- **Acceptance:** fleet groups + attention badge reflect live `uiStateOf`; opening a run renders the composite status grammar (`[Phase] · [suspension/operation]`, brief §7.4); cost shows measured+estimated **separately**; reconnect keeps the last snapshot, disables commands, resumes from cursor, and does **not** replay toasts.

### Phase C — Failure & recovery screens (the product differentiator)

- **Delivers:** the composed suspension states that make this product distinct: **Paused—limit, Auto-recovering, Breaker open, Integration blocked, Merge-ready** — plus the write actions each needs.
- **Seams — existing:** `status --json` limit block (`buildLimitStatus`), `MERGE_READINESS_BLOCKED`, breaker/crash/respawn/failover events, checkpoints; service `resume`/`breakerReset`/`recheck`/`switch_model`/`driveFailoverOnLimit`.
- **Seams — to build:** command-submit wiring for these verbs via Phase A's action queue; `paused_user` state (deviation §2.2); "recheck readiness" git endpoint; integration-command copy (read-only, never executes merge).
- **Screens:** 10, 11, 12, 13, 14 (+ the Attention items that route into them).
- **Acceptance:** each failure state answers brief §4.4's five questions (what happened / what's safe / what's the orchestrator doing / must I act / safe next action); **"reset time unavailable"** is shown literally (never an invented ETA); merge-ready shows manual git commands and asserts nothing was merged/pushed; breaker reset is gated behind explicit inspection and preserves incident history.

### Phase D — Activity, Changes, Verify, Events

- **Delivers:** the inspection surfaces: filtered activity timeline (Follow-live), read-only diff viewer, verification/evidence table with criterion inspector, technical event log.
- **Seams — existing:** event replay; `WorktreeFactsState` + git diff; `IMPLEMENT_VERIFY_LOOP` + verification events; artifact repository (content-addressed evidence).
- **Seams — to build:** diff read endpoint (git), evidence-fetch endpoint (artifact CAS), activity filter projections, Follow-live backpressure.
- **Screens:** 7 Activity, 8 Changes, 9 Verify (+ criterion evidence inspector), Events tab.
- **Acceptance:** criteria show four distinct verdicts (verified/failed/**unproven**/running) — never collapsed; evidence artifacts open from the inspector; diff is strictly read-only (no merge/push affordance); Events shows the true `(seq,type,refs)` log; Follow-live inserts rows without losing scroll position and respects reduced-motion.

### Phase E — Terminal drawer + PTY broker

- **Delivers:** the operator-shell drawer: Worktree shell (input-locked + explicit takeover), Workspace shell (PTY), Orchestrator log (output-only, redacted); terminal-focus keyboard capture.
- **Seams — existing:** worktree lease/validation; redaction (`src/redaction/*`); supervisor stop/checkpoint path for safe takeover.
- **Seams — to build:** (e) node-pty broker; scoped, expiring terminal session token; takeover flow (pause → checkpoint → identity-verified stop → validate → enable input); optional tmux control-mode enumeration (brief §11.3, deferrable).
- **Screens:** 17 Terminal drawer.
- **Acceptance:** ACP children are **never** exposed as terminals (brief §11.1); worktree input stays locked while the run owns it; "Take over" pauses+checkpoints+stops safely before enabling input; terminal keystrokes win focus and `⌘K` does not steal input; loopback-only with an expiring token; redaction applies to the orchestrator log.

### Phase F — Desktop wrapper + native integration

- **Delivers:** Electron app wrapping the web build, spawning `serve` as a sidecar; native folder picker, notifications (new AlertSink), dock/tray attention badge, deep-link to run, secure token storage, close/quit semantics.
- **Seams — existing:** everything above; `alerts.ts` `NotifierRegistry` (add a native sink).
- **Seams — to build:** (f) native notification sink + delivery-state feedback; tray/menu-bar; window lifecycle ("keep service running"); `better-sqlite3` packaging in Electron.
- **Screens:** 19 Tray, 20 Mobile (responsive web, validated here), plus native chrome.
- **Acceptance:** closing the window does not stop runs (teaches the choice, brief §13.4); notifications are actionable + privacy-conscious (no raw prompts/paths/secrets, brief §13.5) and deep-link to the exact attention item; the same web UI runs unchanged in browser and desktop (no Electron-only chrome).

### Cross-cutting (every phase)

Foundations port (tokens, type scale, density, motion, **+ new light theme** and the empty/loading/error matrix §2.2); accessibility (roles/labels/keyboard order per brief §19); responsive collapse order (§18.2) validated at 1440/1280/1024/768/390; redlines/engineering notes per screen (§26.7): fields consumed, commands invoked, safety-confirmation rules.

---

## 6. Build FIRST + smallest vertical slice

**Build first: Phase A's seam, proven by a read-only slice.**

**Smallest end-to-end vertical slice (proves the architecture):**

1. Create a real run with the existing CLI (`harness start …` → `approve` → `run`) using the `fake` adapter so it runs offline and lands durable events + projections in SQLite.
2. Stand up `src/serve/` exposing exactly three read routes: `GET /runs` (new enumeration → `uiStateOf` per run), `GET /runs/:id/snapshot` (assembled from existing projections), and `WS /runs/:id/events?since=<seq>` (replay-from-cursor + live tail off the in-process bus), all loopback + session-token.
3. Build a minimal `web/` React shell that renders the **fleet rail + one Run Overview**, hydrating from the snapshot and folding WS events by sequence — **read-only, no command buttons**.
4. Prove **cursor-resume**: kill the socket, reconnect with the last `(run_id, sequence)`, and confirm the client catches up with no gaps/dupes and no toast replay.

This single slice exercises the whole spine: enumeration (gap b), snapshot assembly (existing projections), event relay + cursor-resume (gap c over existing replay), auth/loopback, and the client fold — everything else is additive. **Slice 2** adds the first write (`approve` through the durable action queue, gap d) to prove the command path and idempotency.

Why this and not a failure screen first: the failure screens are the differentiator, but they are worthless without the seam; and a read-only slice de-risks the *observation boundary* (the part PLAN §1.4 is strict about) before any command/write surface is introduced.

---

## 7. Risks & open questions (for the user to decide)

1. **Serve auth model.** Recommend: bind `127.0.0.1` only + a per-session token minted at daemon start (the design already shows "Loopback only · session token active"). Confirm whether multiple local clients/tabs share one token and how tokens rotate/expire. Terminal sessions need their own scoped, expiring token (brief §11.5).
2. **WS vs SSE for the event relay.** Recommend WS (bidirectional: also carries command acks and terminal I/O later). SSE is simpler but one-way and awkward for terminals. Decide once, since it shapes the client.
3. **Client-side vs server-side state projection.** Recommend the server project `UiState` (reuse `uiStateOf`) so the browser never re-implements the reducer and can't drift from the engine. Confirm acceptable.
4. **Multi-run enumeration source.** There is no `listRuns` today. Decide whether to add a dedicated `runs` index/projection or enumerate projection scopes — and how retention/§15 pruning interacts with "recently completed" in the rail.
5. **Interaction with the concurrent "Agent Room" work.** PLAN §4.1/§7 describe an optional localhost Agent Room chat during coordinator *planning* (`start --enable-chat`, forced to `127.0.0.1`, off the default path). It is **orthogonal** to `serve` (planning-time chat vs run-observation), but: (a) it sets a precedent for a second localhost server — decide whether `serve` should host/proxy it or stay separate; (b) the New-run/Spec-drafting flow *could* surface Agent Room in-UI later. **This plan does not depend on or modify that work** (coordinator.ts, planning-chat.ts, agent-room.ts, cli/*, service.ts are untouched). Confirm the boundary.
6. **`paused_user` and the full §12.1 connection-state machine** are under-modeled in the prototype — confirm they're in-scope for Phase B/C (recommended).
7. **Light theme + empty/loading/error matrix** are design gaps (§2.2); schedule the foundations work before or alongside Phase B.
8. **Terminal takeover safety** is the highest-risk write path (it stops a live child). Its checkpoint→identity-verified-stop→validate sequence must reuse the supervisor's existing identity checks (§14) exactly; do not build a parallel stop path.
9. **Desktop packaging:** Electron + `better-sqlite3` native module bundling is the main desktop risk; validate early in Phase F (or spike during Phase A) so the native-module choice isn't discovered late.

---

## Appendix — provenance

- Design imported to `docs/design/` at the session level (DesignSync was not reachable inside the planning subagent; the orchestrator fetched the current single-file `Harness Control.dc.html` + `support.js`).
- A stale predecessor snapshot ("Intent Next — design package," multi-file, dated earlier) exists only in the session scratchpad and was **not** used; this plan is built solely against the imported current files and the engine source.
