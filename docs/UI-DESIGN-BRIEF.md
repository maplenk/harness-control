# Harness Control — Web and Desktop Design Brief

Status: design-agent handoff  
Product: `harness-orchestration`  
Platforms: local web control room first; macOS desktop application using the same UI second  
Audience for this document: product designer, UX designer, design-system designer, interaction designer, and prototyping agent

---

## 1. The assignment

Design a local-first control room for managing long-running coding-agent workflows across multiple harnesses such as Claude Code and Codex.

The product is not a chat client and not a terminal multiplexer. It is a durable workflow orchestrator that:

1. asks a coordinator agent to explore a repository and draft a testable specification;
2. requires explicit human approval of that exact specification;
3. lets an implementor agent work in an isolated git worktree;
4. asks an independent verifier agent to check every acceptance criterion;
5. runs bounded remediation rounds when verification fails;
6. stops at a merge-readiness report and leaves integration to the human;
7. survives provider limits, crashes, process restarts, model changes, and UI disconnections;
8. records lineage, events, checkpoints, evidence, cost, resource usage, alerts, and recovery state.

Design one coherent product that works as:

- a browser UI connected to a local `harness serve` daemon;
- a desktop app wrapping the same UI and adding native notifications, file selection, tray/menu-bar presence, and optional terminal windows.

The recommended product name in designs is **Harness Control**. Treat this as a working name, not final branding.

---

## 2. One-sentence product definition

Harness Control is a local operations console where a developer can start, supervise, approve, recover, inspect, and hand off coding-agent runs without giving up control of specifications, permissions, git state, or final integration.

---

## 3. Product character

The product should feel:

- operational, not conversational;
- calm under failure;
- information-dense but legible;
- explicit about uncertainty;
- honest about what is running, queued, estimated, or merely desired;
- safe by default;
- designed for hours-long runs and repeated daily use;
- useful to terminal-native developers without forcing every workflow into a terminal.

Avoid:

- “AI magic” visual language;
- anthropomorphic agent avatars;
- glowing gradients, decorative neural-network motifs, or excessive animation;
- a chat-first layout;
- vague progress percentages invented from elapsed time;
- green success states that imply code was merged or deployed;
- treating raw terminal output as the primary source of truth;
- rendering raw model chain-of-thought.

---

## 4. Core product principles

### 4.1 Structured workflow first, terminal second

Coordinator, implementor, and verifier are structured roles with plans, turns, tool calls, permissions, evidence, checkpoints, and state. They are not three shell panes.

The terminal is an operator tool for inspection, testing, diagnostics, and manual integration. It is never the agent control channel.

### 4.2 Human authority remains visible

The interface must repeatedly reinforce:

- the human approves the specification;
- the orchestrator mediates permissions;
- the implementor only writes in an isolated worktree;
- the verifier independently checks the result;
- “merge-ready” does not mean merged;
- model changes may be pending until the next spawn;
- terminal takeover pauses and checkpoints the automated run first.

### 4.3 Honest uncertainty

Never invent an ETA, completion percentage, reset time, cost, or active model.

Examples:

- say “Reset time unavailable” instead of “Try again in approximately 2 hours”;
- show “$0.55 measured + $0.50 estimated” instead of “$1.05 spent”;
- show “Desired model: Sonnet — applies on next spawn” separately from “Running model: Opus”;
- show criterion counts such as “2 of 3 verified,” not “67% complete” unless it is clearly just a criterion count.

### 4.4 Failure is a first-class state

Paused, interrupted, recovering, breaker-open, integration-blocked, and failed runs must have composed, useful interfaces—not generic error pages.

Every failure state should answer:

1. What happened?
2. What work is safe?
3. What is the orchestrator doing now?
4. Does the user need to act?
5. What action is safe next?

### 4.5 Durable state beats live animation

The UI may disconnect while a run continues. On reconnect, the user should see a fresh durable snapshot followed by ordered events.

Do not design important state that exists only as an ephemeral toast, animation, or terminal line.

---

## 5. Users and primary jobs

### 5.1 Primary user: individual developer/operator

Needs to:

- start a run against a local repository;
- choose or accept suggested harness/model profiles;
- review and approve a specification;
- watch meaningful progress without reading every token;
- answer permission requests;
- understand pauses and recovery;
- inspect changes and verification evidence;
- use a shell when needed;
- manually integrate verified work.

### 5.2 Secondary user: technical lead/reviewer

Needs to:

- inspect the exact approved spec;
- understand which agent/model performed each role;
- review the implementation diff and commit;
- inspect evidence criterion by criterion;
- understand remediation history and cost;
- confirm the destination branch is still safe to integrate.

### 5.3 Secondary user: power user running several jobs

Needs to:

- see several runs at once;
- prioritize items needing attention;
- distinguish working, waiting, paused, recovering, and done runs;
- control resource usage;
- jump between runs using keyboard navigation;
- keep terminal access available without losing structured context.

---

## 6. Domain model the interface must respect

Use this object hierarchy in navigation, labels, filters, and drill-down:

```text
Workspace / repository
└── Run
    ├── Spec versions
    ├── Assignment: coordinator | implementor | verifier
    │   └── Session segment
    │       └── Process generation
    │           └── Turn
    │               ├── message/update
    │               ├── plan
    │               ├── tool call
    │               ├── permission request
    │               └── usage update
    ├── Checkpoints
    ├── Artifacts
    ├── Verification
    │   └── Criterion result + evidence
    ├── Alerts/incidents
    └── Merge-readiness report
```

Do not flatten segment, process generation, and turn into one vague “agent session” when the distinction matters for crash/recovery lineage.

In everyday UI, progressively disclose this complexity:

- fleet rows show run + current role;
- run detail shows role lanes and current segment;
- the technical inspector exposes segment, generation, event sequence, and process identity.

---

## 7. State model

The engine stores three orthogonal axes. The UI must preserve them.

### 7.1 Phase: where the workflow is

- `created`
- `specifying`
- `awaiting_approval`
- `approved`
- `implementing`
- `verifying`
- `needs_remediation`
- `merge_ready`
- `cancelled`
- `failed`

### 7.2 Suspension: why progress is paused

- `none`
- `paused_limit`
- `paused_user`
- `breaker_open`
- `interrupted`

### 7.3 Operation: what is happening now

- `idle`
- `prompt_turn`
- `initial_config_pin`
- `model_switch`
- `checkpoint_write`
- `git_op`
- `resume_probe`

### 7.4 Human-readable UI states

Use a simple projection for fleet scanning:

- Starting
- Working
- Waiting on you
- Paused—limit
- Stopped
- Done
- Breaker open
- Handed off

The simplified label does not replace the stored axes. In run detail, show a composite:

```text
Verifying
Paused—limit · reset time unavailable
Last operation: prompt turn
```

Preferred status grammar:

```text
[Phase] · [suspension or operation detail]
```

Examples:

- “Implementing · working”
- “Verifying · waiting for permission”
- “Implementing · paused—limit”
- “Verifying · interrupted; manual resume required”
- “Implementing · auto-recovering, attempt 2”
- “Verifying · integration blocked”
- “Merge-ready · manual integration”

Never collapse `failed`, `cancelled`, `breaker_open`, and `interrupted` into one generic red “error.”

---

## 8. Shared information architecture

### 8.1 Primary navigation

Use five primary destinations:

1. **Runs** — fleet and run control room.
2. **Attention** — approvals, permissions, alerts, pauses, breakers, and integration blockers.
3. **Workspaces** — known repositories and their run history.
4. **Models & harnesses** — capabilities, auth readiness, versions, defaults, and failover ladders.
5. **Settings** — limits, budgets, terminal behavior, notifications, appearance, retention, and security.

Do not make “Agents” the primary navigation noun. Runs and workspaces are the durable user objects; agent processes are transient.

### 8.2 Global utilities

- global run search;
- command palette;
- new run;
- daemon/connection state;
- total live-child usage, for example “2 / 3 live”;
- attention count;
- help/keyboard shortcuts;
- user menu is unnecessary in a strictly local single-user product.

### 8.3 Default landing page

Open to **Runs**.

If any item requires action, place an “Attention” group above ordinary active runs without hiding the rest of the fleet.

---

## 9. Shared application shell

### 9.1 Wide layout

Recommended structure:

```text
┌ Global navigation / workspace / connection / New run ┐
├ Run rail ┬ Main work area ┬ Context inspector         ┤
│          │                │                           │
│          │                │                           │
├──────────┴────────────────┴───────────────────────────┤
│ Optional terminal drawer                             │
└──────────────────────────────────────────────────────┘
```

### 9.2 Run rail

The left rail is a fleet switcher, not a file tree.

Each run row should include:

- concise goal/title;
- projected UI state;
- current role;
- harness/model short label when useful;
- attention marker;
- cost or elapsed time only as secondary information;
- workspace name when runs from several repositories are mixed.

Group order:

1. Needs attention
2. Active
3. Paused/recovering
4. Recently completed

Allow collapsing completed runs.

### 9.3 Main work area

The main area changes by selected run tab:

- Overview
- Spec
- Activity
- Changes
- Verify
- Events

Do not put every panel on one endlessly scrolling page.

### 9.4 Context inspector

The right inspector is selection-sensitive:

- select run → status, vitals, models, ownership;
- select role → session and model details;
- select tool call → arguments/status/output metadata;
- select criterion → evidence;
- select event → event payload and sequence;
- select file → diff metadata;
- select checkpoint → binding and incomplete-operation state.

The inspector may collapse on narrower screens.

### 9.5 Terminal drawer

The terminal is a bottom drawer with tabs and optional pop-out:

- Worktree shell
- Workspace shell
- Orchestrator log

It is closed by default for new users and remembers its last state per device.

---

## 10. Screen specifications

## 10.1 First launch / environment doctor

Purpose: explain what is ready before the first run.

Show:

- Node, git, SQLite, and platform checks;
- installed harnesses;
- adapter/package versions;
- authentication readiness with honest labels:
  - Validated
  - Detected, not validated
  - Detected, unsupported
  - Not detected
- permission/config safety warnings;
- available models/modes when probed;
- storage location and quota;
- “Re-run checks” action;
- “Continue with available harnesses” when at least one usable path exists.

Do not show bare environment-variable values or credential paths beyond safe, redacted metadata.

Use explanation copy for ambiguous auth:

> Credentials were found, but no successful provider turn has validated them yet.

Desktop variant:

- repository folder picker;
- Open Terminal action for installation/auth remediation;
- native notification permission request only after the user understands why notifications are useful.

## 10.2 Runs / fleet dashboard

Purpose: answer “What is running, what needs me, and what is safe?”

Top area:

- New run;
- active children count versus configured limit;
- daemon state;
- optional cost/budget summary for today or current session—only if real data exists.

Run groups:

- Needs attention
- Active
- Paused/recovering
- Completed recently

Fleet row content:

- goal;
- workspace;
- workflow mini-rail: Spec → Approve → Implement → Verify → Ready;
- phase/suspension label;
- current role/harness/model;
- criterion count when verifying;
- alerts/permission/approval count;
- cost split when relevant;
- last activity time.

Fleet actions should be restrained:

- Open
- Pause or Resume when unambiguous
- overflow menu for Cancel and technical actions

No destructive action should be one accidental click from a dense row.

## 10.3 New run

Use a focused wizard or single progressive form.

Fields:

1. Workspace
2. Goal
3. Coordinator profile
4. Optional budget and limits
5. Advanced settings

Workspace:

- recent repositories;
- folder picker in desktop;
- validated git repository state;
- current branch and HEAD;
- warning if repository is dirty—starting may still be allowed if the engine supports it, but explain downstream merge-readiness implications.

Goal:

- multiline;
- concise example prompts;
- never pre-populate a long “magic” template;
- show that the coordinator will turn the goal into a testable spec.

Profiles:

- harness;
- model;
- effort/mode;
- capability/auth readiness;
- default derived from configuration;
- advanced ability to set proposed implementor/verifier profiles.

Before submit, summarize:

- coordinator target;
- workspace;
- approval will be required before implementation;
- implementation will occur in an isolated worktree;
- no automatic merge or push.

Primary action: **Draft specification**

Not “Run agents” or “Start coding.”

## 10.4 Run overview / control room

This is the primary product screen.

Header:

- editable display title only if separate from immutable goal;
- full goal on hover/expand;
- workspace and base commit;
- phase + suspension + operation;
- Pause/Resume;
- context action such as Approve, Recheck, or Copy integration commands;
- Cancel in overflow or secondary danger treatment.

Workflow rail:

- Spec
- Approval
- Implement
- Verify
- Merge-ready

Show remediation as a loop between Verify and Implement, not a sixth linear step.

Role lanes:

### Coordinator

- harness/model/effort;
- spec revision produced;
- start/end times;
- session/segment status;
- validation retries;
- open spec.

### Implementor

- harness/model/effort;
- worktree branch/path;
- implementation commit;
- current plan/tool call;
- files changed;
- verification commands run by the implementation flow;
- remediation round.

### Verifier

- harness/model/effort;
- immutable commit being verified;
- criteria verified/failed/unproven;
- evidence count;
- current criterion;
- independence/read-only marker.

Activity summary:

- show structured milestones and latest meaningful update;
- collapse token chunks into coherent messages;
- group tool-call start/update/end into one row;
- show “Reasoning” only as a safe activity indicator or provider-supplied summary—never raw chain-of-thought.

Right inspector summary:

- Operator inbox
- Acceptance criteria
- Vitals
- Models
- Latest checkpoint
- Alerts

## 10.5 Specification review and approval

Purpose: make approval deliberate without making it ceremonial.

Show:

- revision number;
- immutable spec hash, shortened by default and copyable in full;
- goal;
- summary;
- in-scope/out-of-scope;
- constraints;
- acceptance criteria;
- verification commands;
- proposed implementor/verifier profiles;
- risks/open questions.

For revisions:

- side-by-side or inline diff between current and prior spec;
- clearly mark added/changed/removed acceptance criteria;
- retain earlier revisions in history;
- never allow editing the approved immutable version in place.

Actions:

- **Approve spec vN**
- **Request revision**

Approve confirmation should summarize:

- exact revision and hash;
- proposed execution profiles;
- budget/limits;
- that implementation will begin only after a separate Run action if that remains the command contract.

Revision feedback:

- multiline feedback;
- show it becomes input to a new coordinator round;
- do not frame as editing the agent’s response directly.

## 10.6 Activity

Purpose: provide observability without becoming a raw transcript dump.

Default timeline event types:

- role started/completed;
- turn started/completed;
- plan update;
- tool call;
- permission request/resolution;
- checkpoint;
- model pin or desired-model change;
- limit incident;
- crash/recovery;
- verification result;
- alert;
- workflow phase change.

Default grouping:

- group streaming chunks into one message;
- group a tool call and its updates;
- group repetitive resource samples into charts/aggregates;
- group remediation by round;
- group repeated auto-respawn attempts but retain expandability.

Filters:

- All
- Milestones
- Agent activity
- Tools
- Permissions
- Recovery
- System

Do not expose a filter merely because data exists. Start with the above set only if the timeline becomes dense enough to require it.

Each row may show:

- timestamp;
- role;
- event summary;
- state;
- sequence number in technical details;
- expand for redacted payload.

Support “follow live” and “pause scrolling.” New activity should not steal scroll position when follow-live is off.

## 10.7 Changes

Purpose: review implementor output without leaving the control room.

Show:

- base commit;
- implementation commit;
- branch/worktree;
- changed file tree;
- additions/deletions;
- unified or side-by-side diff;
- generated/binary/too-large states;
- implementation summary;
- test/verification-command outcomes;
- worktree cleanliness.

Safety:

- viewer is read-only;
- “Open in editor” is a desktop action;
- “Open worktree terminal” follows terminal ownership rules;
- do not include merge/push buttons.

When implementation is still running:

- label diff as “Live worktree changes — not yet verified”;
- avoid implying the current working tree is the final commit;
- visually distinguish committed versus uncommitted changes.

## 10.8 Verification and evidence

Purpose: make independent verification understandable and auditable.

Use an acceptance-criteria table or stacked list:

- criterion ID;
- criterion text;
- verdict: Verified / Failed / Unproven / Running;
- evidence count;
- note;
- verification command/result;
- remediation request when applicable.

Selecting a criterion opens:

- exact criterion;
- immutable spec hash;
- implementation commit;
- verifier session;
- evidence artifacts;
- notes;
- previous-round result when remediation occurred.

Overall results:

- all criteria verified;
- agent-actionable blockers → remediation;
- user/environment blockers → integration blocked;
- wrong binding or missing probe → orchestration error.

Do not use “Passed” as the only language if evidence is absent. “Unproven” is a real, distinct state.

## 10.9 Attention inbox

Purpose: collect every item requiring a human decision.

Item kinds:

- Spec approval
- Spec revision result
- Permission request
- Paused—limit
- Unknown provider error
- Breaker open
- Integration blocker
- Merge-ready handoff
- Environment/auth issue

Each item answers:

- run and workspace;
- what happened;
- urgency;
- safe next action;
- whether the run is currently blocked;
- expiry/deadline if one actually exists.

Permission item:

- requesting role;
- tool title and description;
- exact available options;
- policy context;
- Allow once / Allow always / Deny once / Deny always only when those options actually exist;
- coordinator/verifier write veto explanation when applicable.

If the UI disconnects while an interactive permission is pending, default to safe behavior. The design should represent “request expired/denied because operator disconnected” rather than silently allowing.

## 10.10 Alerts and incidents

Alert kinds currently important:

- limit paused;
- crash;
- auto-respawn;
- breaker open;
- failover;
- failover exhausted.

Incident detail should include:

- kind;
- role;
- harness/model;
- process generation;
- detected at;
- redacted detail;
- delivery status;
- related checkpoint;
- related recovery attempts;
- current resolution.

Severity is not identical to color:

- informational: auto-respawn succeeded;
- attention: paused limit with no immediate work required;
- warning: manual resume required;
- critical: breaker open or run failed.

Use durable in-product history. Native notifications are only an additional delivery channel.

## 10.11 Paused—limit

This state deserves a purpose-built panel.

Show:

- provider/harness;
- role and phase;
- detection source/confidence;
- time paused;
- reset time:
  - exact timestamp if provider supplied one;
  - otherwise “Reset time unavailable”;
- probe ladder:
  - probes used / maximum;
  - next probe time when scheduled;
  - latest inconclusive detail;
- checkpoint status;
- failover policy and ladder when configured;
- current owner/process state.

Actions depend on policy:

- Wait
- Resume now
- Switch model
- Switch harness
- Edit failover policy

Never show a fake countdown for unknown reset time.

If failover happens, show a visible lineage card:

```text
Codex / model A
paused at checkpoint X
↓ successor
Claude / model B
resumed from checkpoint X
```

Explain that raw provider session history does not cross harnesses; the successor continues from a mechanical checkpoint.

## 10.12 Crash, auto-recovery, and breaker

Auto-recovery state:

- “Auto-recovering”
- attempt number;
- backoff until next attempt if known;
- last checkpoint;
- same or changed target;
- recent crash history;
- Pause recovery / Cancel only if supported safely.

Breaker-open state:

- plain-language reason:
  - too many restarts;
  - lifetime cap;
  - no progress;
  - recovery exceeded time bound;
- work preserved at checkpoint;
- current worktree state/taint;
- recent generation history;
- **Inspect and reset breaker** action;
- explain that reset does not guarantee success.

Reset confirmation:

- shows what counter/state will reset;
- confirms worktree validation occurs before the next spawn;
- does not hide the underlying incident history.

## 10.13 Integration blocked

This is not a failed verification and not agent remediation.

Examples:

- destination checkout dirty;
- base branch drifted;
- conflicts;
- user/environment condition.

Show:

- all criteria verified;
- immutable verified commit;
- blockers grouped by responsible party;
- exact corrective guidance;
- **Recheck readiness** action;
- no extra remediation round consumed.

Avoid red failure treatment when the code is verified but the local environment needs attention. Use a clear waiting/blocked state.

## 10.14 Merge-ready handoff

Title: **Verified and ready for manual integration**

Show:

- exact spec revision/hash;
- base and implementation commits;
- destination branch;
- all criteria and evidence summary;
- final diff;
- cost and duration;
- role/model lineage;
- exact shell-quoted manual commands;
- Copy commands;
- Open workspace terminal;
- Open worktree;
- Recheck readiness.

State explicitly:

> Harness Control has not merged, pushed, or changed your destination branch.

Do not use “Complete” alone. Prefer “Merge-ready.”

## 10.15 Events / technical inspector

For advanced users and debugging.

Features:

- ordered per-run sequence;
- event type;
- timestamp;
- idempotency key;
- role/segment/generation references;
- redacted JSON payload;
- replay cursor;
- projection snapshot;
- copy event reference.

Default to a compact table with detail panel.

Do not allow mutation from this screen.

## 10.16 Models and harnesses

Show one row/card per harness:

- installed/available;
- adapter/package version;
- protocol/version;
- auth readiness;
- session capabilities;
- permission request support;
- model-switch mechanism;
- model/mode/effort options;
- usage-limit reporting quality;
- retry-after support;
- usage accounting;
- last successful validation;
- issues/warnings.

Distinguish:

- Running/effective model
- Desired model
- Proposed model
- Failover target

Never write “Model switched” when only a desired-model record exists.

## 10.17 Settings

Groups:

### General

- appearance;
- open behavior;
- completed-run retention display;
- keyboard shortcuts.

### Runtime

- maximum live children;
- restart bounds;
- memory thresholds;
- heartbeat/watchdog display;
- auto-respawn bounded/off.

### Limits and failover

- default wait/switch/ask policy;
- ordered per-role failover ladders;
- probe ladder;
- maximum probes.

### Budget

- maximum estimated budget;
- conservative per-turn reservation;
- show measured and estimated separately.

### Verification

- allowed environment additions;
- warning about credential-shaped variable refusal;
- command timeout.

### Terminal

- shell;
- direct PTY or tmux-backed operator sessions;
- scrollback;
- restore sessions;
- require explicit takeover while run owns worktree;
- close behavior.

### Notifications

- approval;
- permission;
- limit pause;
- crash/recovery;
- breaker;
- merge-ready;
- native notification and in-product delivery.

### Storage and privacy

- `HARNESS_HOME`;
- event/artifact usage;
- quotas;
- retention;
- clear completed-run artifacts with impact explanation;
- redaction information.

Do not expose “unsafe-dev” controls in ordinary settings. If included at all, place them behind an explicit advanced/developer mode with strong warnings.

---

## 11. Terminal and tmux design

### 11.1 Mental model

There are two unrelated process surfaces:

1. **ACP child processes** — structured agent control over direct stdio; never shown as interactive terminals.
2. **Operator shells** — PTY sessions opened by the human; rendered with a web terminal component.

The UI must never imply that typing into an operator shell steers the active agent session.

### 11.2 Default terminal tabs

#### Worktree shell

- CWD: isolated implementor worktree;
- label includes run and branch;
- input locked while the automated run owns the worktree;
- output may remain visible;
- “Take over” pauses, checkpoints, stops the child safely, validates ownership, then enables input;
- after takeover, resuming automation requires validation.

#### Workspace shell

- CWD: primary repository checkout;
- intended for inspection and final manual integration;
- persistent warning when destination is dirty;
- never automatically runs integration commands.

#### Orchestrator log

- output-only structured/log view;
- not necessarily a shell;
- includes daemon, adapter stderr summary, supervision, and diagnostics;
- sensitive values remain redacted.

### 11.3 tmux mode

tmux is optional and for operator shells only.

Possible behavior:

- one tmux session per run;
- windows: `worktree`, `workspace`, `logs`;
- UI enumerates/attaches using tmux control mode;
- detach preserves shells when the browser or desktop window closes;
- terminal tabs map to tmux windows/panes.

tmux must not:

- own run state;
- replace SQLite events/checkpoints;
- host ACP JSON-RPC children;
- decide whether worktree ownership is safe;
- bypass pause/takeover rules.

### 11.4 Terminal focus and keyboard behavior

When terminal has focus:

- terminal keystrokes win;
- global letter shortcuts are disabled;
- use a visible focus indicator;
- provide a discoverable escape sequence to return focus to the app;
- Cmd/Ctrl+K command palette should not steal input unless explicitly configured;
- copy/paste behavior follows platform conventions.

### 11.5 Terminal security

Design as privileged local access:

- loopback only by default;
- scoped, expiring terminal session token;
- clear CWD and run identity;
- explicit reconnect state;
- no automatic remote sharing;
- no hidden privilege escalation;
- opening links from terminal output requires safe handling;
- show when a shell is direct PTY versus tmux-backed.

---

## 12. Web application behavior

The web UI connects to a long-running local daemon.

### 12.1 Connection states

- Connecting
- Connected
- Reconnecting
- Read-only snapshot
- Daemon unavailable
- Version mismatch

During reconnect:

- keep the last snapshot visible;
- show that data may be stale;
- disable commands until command-channel safety is known;
- reconnect from the last `(run_id, sequence)` cursor;
- never replay toasts as if they were new; restore durable attention items instead.

### 12.2 Browser lifecycle

- closing a tab does not cancel a run;
- reopening reconstructs from durable state;
- before closing with pending unsent revision feedback, use standard unsaved-form protection;
- do not show “Are you sure?” merely because agents are running.

### 12.3 Local security framing

The web design should make the local scope clear without constantly alarming the user.

Settings/about may state:

- listening on loopback;
- session token status;
- connected clients;
- daemon version;
- storage path.

If remote access is ever added, it is a separate product mode and must not silently reuse the local design assumptions.

---

## 13. Desktop application behavior

The desktop app uses the same web UI, with native capabilities around it.

### 13.1 Window model

Recommended:

- one primary control-room window;
- optional pop-out terminal window;
- optional pop-out diff/evidence window only if research shows real need;
- avoid one window per agent or run by default.

### 13.2 Native additions

- macOS folder picker;
- notifications;
- dock badge for attention count;
- menu-bar/tray status;
- “Open in editor” and “Reveal in Finder”;
- custom URL/deep-link routing to a run;
- secure token storage;
- auto-start daemon option;
- reopen last run.

### 13.3 Menu-bar/tray

Keep it operational and compact:

- daemon status;
- live children count;
- items needing attention;
- open Harness Control;
- new run;
- notification mute;
- quit UI;
- stop daemon, separated and guarded.

Do not include a global “Cancel all” shortcut.

### 13.4 Close and quit semantics

Closing the window should not silently stop the daemon or active runs.

On first close with active runs, teach:

> Runs continue in the local Harness Control service. You will still receive enabled notifications.

Offer:

- Close window
- Quit UI, keep service running
- Stop service… with active-run consequences explained

Remember the user’s preference only when safe.

### 13.5 Native notifications

Notifications should be actionable but privacy-conscious.

Good:

- “Spec approval needed — Add verbose flag”
- “Run paused by provider limit”
- “Auto-recovery succeeded”
- “Breaker opened after repeated crashes”
- “Verified and merge-ready”

Avoid including:

- raw prompts;
- agent messages;
- secret-shaped content;
- full filesystem paths;
- unredacted error payloads.

Notification click opens the exact run and attention item.

### 13.6 Desktop packaging choice

Design must remain wrapper-agnostic, but engineering currently favors:

- browser UI first;
- Electron as the lower-integration-risk desktop wrapper for a Node/TypeScript engine using native Node modules;
- Tauri only if smaller footprint justifies a Rust host plus Node sidecar.

Do not create designs that depend on Electron-specific chrome.

---

## 14. Primary user flows

## 14.1 First run

```text
Launch
→ Doctor checks
→ Select workspace
→ Enter goal
→ Choose coordinator
→ Draft spec
→ Review
→ Approve or request revision
→ Run implementation
→ Monitor
→ Verify
→ Review merge-ready handoff
→ Manually integrate
```

## 14.2 Spec revision

```text
Awaiting approval
→ Compare current revision
→ Request revision
→ Enter feedback
→ Coordinator drafts new immutable version
→ Compare revisions
→ Approve exact new hash
```

## 14.3 Permission request

```text
Agent tool request
→ Durable attention item
→ User inspects role/tool/policy
→ Select available permission outcome
→ Activity records resolution
→ Agent continues or handles denial
```

## 14.4 Limit pause with wait

```text
Provider limit detected
→ Mechanical checkpoint
→ Child stops safely
→ Paused—limit panel
→ Known reset: schedule
   or unknown reset: probe ladder
→ Resume
→ Re-entry/successor
→ Continue same round
```

## 14.5 Limit pause with failover

```text
Provider limit detected
→ Checkpoint
→ Select next configured ladder target
→ Record desired target and successor intent
→ Spawn successor
→ Resume from checkpoint
→ Show lineage and provider-split cost
```

## 14.6 Crash with bounded auto-respawn

```text
Unexpected child exit
→ Record crash + alert
→ Fold restart counters
→ Auto-recovering
→ Backoff
→ Successor from checkpoint
→ Continue
→ If bounds exhausted: breaker open
```

## 14.7 Verification remediation

```text
Verifier marks failed/unproven criteria
→ Structured fix requests
→ Needs remediation
→ Same worktree returns to implementor
→ New implementation commit
→ Independent verifier checks exact new commit
→ Bounded until verified or failed
```

## 14.8 Integration blocked

```text
All criteria verified
→ Git readiness finds user/environment blocker
→ Run remains verifying
→ User clears destination condition
→ Recheck
→ Merge-ready
```

## 14.9 Terminal takeover

```text
User opens worktree terminal
→ Automated owner active
→ Terminal input locked
→ User chooses Take over
→ Explain consequence
→ Checkpoint + pause + safe stop
→ Validate worktree/lease
→ Enable shell input
→ Later resume requires validation
```

---

## 15. Actions and safety rules

### 15.1 Approval

- always name spec revision;
- make full hash available;
- confirmation is appropriate;
- never provide auto-approve in ordinary product UI.

### 15.2 Pause

- normal action, no heavy confirmation;
- explain “finishes at a safe point” when not immediate;
- show checkpoint progress.

### 15.3 Resume

- validate eligibility;
- show target harness/model;
- show whether native resume, replay, or successor is expected when known;
- refuse honestly on spec/assignment mismatch.

### 15.4 Cancel

- confirmation required;
- explain run becomes terminal;
- explain worktree/artifacts are retained;
- never combine Cancel with Delete.

### 15.5 Delete/retention

- separate from cancel;
- show events/artifacts/worktree impact;
- prevent deletion of active runs;
- support storage cleanup without pretending history still has evidence.

### 15.6 Switch model

- running and desired values displayed separately;
- copy: “Applies at the next spawn”;
- never fake an in-place switch;
- show pending indicator until `child.spawned` confirms effective pins.

### 15.7 Reset breaker

- requires inspection context;
- confirmation explains validation and remaining risk;
- incident history remains.

### 15.8 Terminal takeover

- always explicit;
- automation must pause/checkpoint first;
- shell input remains locked until ownership transfer is confirmed.

---

## 16. Content design and terminology

Use:

- Run
- Workspace
- Specification / Spec
- Acceptance criterion
- Coordinator
- Implementor
- Verifier
- Worktree
- Checkpoint
- Evidence
- Remediation round
- Merge-ready
- Integration blocked
- Paused—limit
- Auto-recovering
- Breaker open
- Running model
- Desired model
- Estimated cost

Avoid:

- Task when it could mean run, tool call, or criterion;
- Agent swarm;
- Worker terminal;
- AI session as a universal object;
- Done when only implementation is complete;
- Success when merge-readiness is blocked;
- Failed when merely paused;
- Spend when cost is estimated;
- Resume ETA when reset time is unknown.

Canonical copy:

```text
Waiting for spec approval
Approve spec v3
Request revision
Implementation is isolated in a worktree
Verifier is checking commit c254435
2 of 3 criteria verified
Reset time unavailable
Next probe scheduled for 14:30
Auto-recovering · attempt 2
Model change queued for the next spawn
All criteria verified; integration is blocked by your destination checkout
Verified and ready for manual integration
Harness Control has not merged or pushed these changes
Terminal takeover will pause and checkpoint this run
```

---

## 17. Visual design direction

### 17.1 Overall

Use a restrained developer-tool aesthetic:

- neutral application chrome;
- strong type hierarchy;
- thin separators;
- limited card usage;
- data aligned in rows and lanes;
- status conveyed by label + shape + color;
- subtle motion only for real state changes.

### 17.2 Density

Support two density modes eventually:

- Comfortable
- Compact

Design comfortable first, but ensure fleet rows and event tables can become compact without redesigning their hierarchy.

### 17.3 Color semantics

Suggested semantic families:

- neutral: idle, historical, unknown;
- blue/accent: active/current;
- amber: waiting, paused, attention;
- red: failed, breaker, destructive;
- green: verified/merge-ready, never merged/deployed;
- purple or secondary accent: successor/failover lineage if another category is needed.

Never rely on color alone.

### 17.4 Typography

Use:

- highly readable UI sans for navigation and content;
- monospace for commits, hashes, paths, commands, event types, model IDs, and terminal;
- tabular numerals for costs, tokens, durations, RSS, counts, and sequences.

Raw JSON and commands must not dominate ordinary screens.

### 17.5 Motion

Appropriate:

- workflow node changes state;
- terminal drawer opens;
- new durable attention item appears;
- recovering state advances attempts;
- follow-live timeline inserts rows.

Avoid:

- continuous pulsing on every active agent;
- simulated typing for agent messages;
- indefinite spinners without explanatory text;
- animated “AI thinking” decoration.

Use reduced-motion preferences.

---

## 18. Responsive behavior

### 18.1 Target widths

Design explicitly at:

- 1440px wide web/desktop;
- 1280px standard laptop;
- 1024px compact desktop;
- 768px narrow browser;
- 390px mobile inspection mode.

The product is desktop-first. Mobile is for monitoring and simple decisions, not full terminal/diff workflows.

### 18.2 Collapse order

As width decreases:

1. collapse right inspector into a slide-over;
2. reduce run rail to icons/state indicators or a run switcher;
3. stack role lanes;
4. turn wide tables into selected-item lists;
5. terminal becomes full-width overlay/dedicated screen;
6. side-by-side diff becomes unified diff.

### 18.3 Mobile-safe actions

Allow:

- inspect status;
- approve/request revision;
- answer well-described permissions;
- pause/resume;
- view alerts/evidence summary.

Avoid or require desktop:

- terminal takeover;
- complex diff review;
- advanced breaker repair;
- model/failover configuration;
- storage cleanup.

---

## 19. Accessibility

Minimum requirements:

- WCAG AA contrast;
- complete keyboard operation;
- visible focus;
- landmarks for run rail, main work area, inspector, and terminal;
- status never color-only;
- live-region announcements only for items requiring attention, not every event;
- tables have proper headers;
- workflow rail has an accessible text summary;
- terminal has a clear accessible label and focus boundary;
- reduced motion;
- zoom to 200% without losing commands;
- timestamps have full accessible values;
- abbreviations such as RSS and ACP explained on first use or via help;
- charts have textual summaries;
- diff additions/deletions identifiable without color;
- approval dialogs read spec revision/hash context before actions.

Keyboard concepts:

- Cmd/Ctrl+K: command palette;
- Cmd/Ctrl+N: new run when not in terminal;
- Cmd/Ctrl+J: toggle terminal;
- `[` / `]` or documented alternatives: previous/next run only when focus is not in a text field or terminal;
- Escape: close inspector/dialog, never cancel a run.

No destructive action gets a single-key shortcut.

---

## 20. Empty, loading, disconnected, and error states

Design these explicitly:

### No runs

- explain the workflow;
- Draft specification;
- link to environment readiness.

### No harness available

- doctor summary;
- remediation instructions;
- open terminal;
- retry.

### Loading run

- snapshot skeleton;
- do not show fake run values;
- distinguish loading from daemon unavailable.

### Reconnecting

- stale snapshot remains;
- commands disabled;
- sequence cursor displayed only in technical details.

### Daemon unavailable

- start/restart service in desktop;
- CLI command in browser mode;
- diagnostics.

### Version mismatch

- UI and daemon versions;
- reload/update guidance;
- no unsafe commands.

### Missing artifact

- metadata remains;
- explain retention/GC;
- criterion cannot claim evidence if required artifact is absent.

### Corrupt or unreplayable state

- stop ordinary actions;
- preserve diagnostics;
- export sanitized report;
- never “repair” silently.

### Terminal disconnected

- shell process alive versus dead;
- reconnect;
- create new shell;
- do not conflate terminal loss with agent/run interruption.

---

## 21. Data visualization guidance

Use visualization only where it improves decisions.

Good:

- workflow rail;
- role lanes over time;
- context-window gauge;
- measured versus estimated cost;
- RSS over time with soft/hard thresholds;
- remediation rounds;
- crash/recovery generation lineage;
- failover target lineage.

Avoid:

- vanity “AI productivity” scores;
- arbitrary agent confidence;
- invented progress curves;
- colorful dashboards without operational decisions.

Cost:

- measured and estimated must be separate series/segments;
- show by role and phase;
- remediation should be visible as a cost centre.

Context:

- current used tokens / context window;
- threshold/compaction state only when real;
- do not infer remaining turns.

---

## 22. Design-system component inventory

Create reusable components and variants for:

### Navigation

- app navigation item;
- run row;
- run switcher;
- command palette item;
- connection indicator.

### Status

- phase badge;
- suspension badge;
- operation label;
- composite run status;
- attention count;
- live-child capacity;
- measured/estimated marker.

### Workflow

- workflow rail;
- workflow node;
- remediation loop;
- role lane;
- segment/generation marker;
- successor/failover connector.

### Activity

- event row;
- grouped tool call;
- agent message;
- plan;
- permission request;
- checkpoint;
- alert;
- technical payload detail.

### Review

- spec criterion;
- spec revision diff;
- approval panel;
- file tree;
- diff hunk;
- criterion verdict;
- evidence item;
- merge-readiness blocker;
- manual command block.

### Operations

- run action bar;
- paused-limit panel;
- auto-recovery panel;
- breaker panel;
- model effective/desired pair;
- cost/context/RSS metric;
- terminal tab and ownership lock;
- daemon state banner.

### Feedback

- inline validation;
- durable attention item;
- toast for transient confirmation only;
- confirmation dialog;
- reconnect banner;
- empty state;
- loading skeleton;
- redacted-value treatment.

Every component should include:

- light/dark;
- comfortable/compact where relevant;
- default/hover/focus/selected/disabled;
- loading;
- error;
- long text;
- redacted text;
- keyboard/accessibility annotations.

---

## 23. Canonical prototype data

Use these five runs to exercise the system:

### Run A — active verification

- Goal: “Add a `--verbose` flag to the CLI”
- Workspace: `harness-orchestration`
- Coordinator: Claude / Opus / low
- Implementor: Codex / gpt-5.6-terra / medium
- Verifier: Claude / Sonnet / medium
- Phase: verifying
- Suspension: none
- Operation: prompt turn
- Criteria: 2 verified, 1 running
- Commit: `c254435`
- Cost: `$0.55 measured + $0.50 estimated`
- One pending permission request

### Run B — awaiting spec approval

- Goal: “Fix retry behavior in the job queue”
- Spec revision: v3
- Current state: Waiting on you
- Previous revision available for comparison
- Proposed implementor/verifier profiles present

### Run C — paused by provider limit

- Goal: “Refactor import boundaries”
- Phase: implementing
- Suspension: paused_limit
- Reset: unavailable
- Probe: 1 of 6 used; next scheduled
- Checkpoint recorded
- Failover ladder configured but not yet used

### Run D — breaker open

- Goal: “Replace legacy config loader”
- Phase: implementing
- Suspension: breaker_open
- Reason: no progress across repeated restarts
- Three generations visible
- Worktree tainted then validated
- Reset requires inspection

### Run E — merge-ready

- Goal: “Update CLI documentation”
- All criteria verified
- Clean readiness
- Manual commands available
- No automatic merge or push

Also create variants:

- integration blocked by dirty destination;
- failover from Codex to Claude;
- interrupted run requiring manual resume;
- model desired but not yet effective;
- daemon disconnected while run continues.

---

## 24. Backend assumptions the design may rely on

The UI is expected to receive:

- list of runs and durable snapshots;
- ordered events by `(run_id, sequence)`;
- normalized session updates;
- structured tool/plan/permission/usage updates;
- alerts with delivery state;
- checkpoint metadata;
- models/effective pins/desired model;
- costs by role and phase;
- context-window vitals;
- RSS telemetry;
- spec versions and hash;
- verification criteria and evidence;
- diff/commit/worktree facts;
- terminal session descriptors.

Expected command surfaces:

- create/start;
- revise spec;
- approve;
- run;
- pause;
- resume;
- cancel;
- reset breaker;
- recheck readiness;
- set desired model;
- respond to permission;
- open/close/reconnect terminal;
- explicit worktree takeover.

Important implementation gap:

- the current CLI and SQLite read models exist;
- the network `serve` layer, multi-run listing API, live event relay, durable interactive action queue, and PTY broker still need implementation.

Do not let designs assume unsupported features are already effortless.

---

## 25. Non-goals

Do not design:

- automatic merge, push, deploy, or PR creation;
- collaborative multi-user cloud tenancy;
- remote workers;
- mobile terminal administration;
- a general code editor replacing VS Code or another IDE;
- direct editing of immutable specs;
- raw chain-of-thought viewer;
- direct PTY control of Claude/Codex ACP children;
- a visual node-based workflow builder in the first version;
- arbitrary parallel agent swarms in the first version;
- a terminal-sharing product;
- an “AI chat with your repository” home screen.

Preserve seams for future parallel waves and remote access, but do not surface empty controls.

---

## 26. Required design deliverables

The design agent should produce:

### 26.1 Foundations

- color tokens and semantic state mapping;
- typography;
- spacing/grid;
- icon principles;
- elevation/border rules;
- light and dark themes;
- density behavior;
- motion guidance.

### 26.2 Information architecture

- sitemap;
- desktop/web shell;
- navigation behavior;
- run hierarchy;
- inspector model;
- terminal placement.

### 26.3 High-fidelity screens

At minimum:

1. First launch / doctor
2. Fleet dashboard
3. New run
4. Run overview — active verification
5. Spec approval
6. Spec revision comparison
7. Activity timeline
8. Changes/diff
9. Verification/evidence
10. Paused—limit
11. Auto-recovering
12. Breaker open
13. Integration blocked
14. Merge-ready handoff
15. Models/harnesses
16. Settings
17. Terminal drawer
18. Web reconnect state
19. Desktop menu-bar/tray
20. Mobile inspection variant

### 26.4 Interactive prototypes

Prototype these flows:

- create run → draft spec → approve;
- active run → permission request → resolve;
- limit pause → wait/probe → resume;
- limit pause → failover successor;
- crash → auto-respawn → breaker open;
- verifier failure → remediation → verified;
- integration blocked → recheck → merge-ready;
- open worktree terminal → explicit takeover;
- disconnect → reconnect and replay.

### 26.5 Component library

All components in §22 with interaction and state variants.

### 26.6 Responsive and desktop annotations

- 1440, 1280, 1024, 768, and 390 layouts;
- web versus desktop differences;
- terminal-focus keyboard behavior;
- window close/daemon behavior;
- native notification content.

### 26.7 Redlines and engineering notes

For each important screen:

- layout dimensions;
- responsive behavior;
- truncation/wrapping;
- loading/empty/error;
- keyboard order;
- accessible name/announcement;
- event/state fields consumed;
- commands invoked;
- safety confirmation rules.

---

## 27. Design review checklist

Before calling the design complete, verify:

- Can a user tell what needs attention within five seconds?
- Can they distinguish phase, suspension, and operation?
- Does any screen imply that “merge-ready” means merged?
- Are running and desired models separate?
- Are measured and estimated cost separate?
- Is unknown ETA represented honestly?
- Can a verifier failure be distinguished from an integration blocker?
- Can a crash, auto-recovery, and breaker-open state be understood?
- Is terminal takeover explicit and safe?
- Are ACP child processes kept out of terminal/tmux concepts?
- Does reconnect preserve context without replaying stale notifications?
- Can spec revision and exact approval identity be understood?
- Is every criterion linked to evidence?
- Can the UI operate without exposing raw chain-of-thought?
- Are important states accessible without color?
- Are destructive actions separated from common actions?
- Does the desktop window explain that closing it does not stop active runs?
- Does mobile remain inspection-first?
- Are empty and failure states as carefully designed as the happy path?

---

## 28. Source-of-truth references for the design agent

Read these repository files when implementation-level clarification is needed:

- `README.md` — concise product behavior and CLI walkthrough.
- `PLAN.md` — normative architecture, state model, safety rules, CLI contract, and roadmap.
- `docs/ORCHESTRATOR-NOTES.md` — decision history and current build status.
- `src/domain/state.ts` — phase, suspension, operation, active-child, and successor vocabulary.
- `src/domain/entities.ts` — run, assignment, segment, turn, artifact, verification, and merge-readiness entities.
- `src/domain/events.ts` — event, alert, incident, permission, limit, and recovery vocabulary.
- `src/adapters/spi.ts` — normalized live session updates and adapter capabilities.
- `src/app/service.ts` — orchestration service, status projection, alerts, pause/resume, recovery, failover, cost, and supervision.
- `src/cli/commands.ts` — current machine-readable status payloads and user-facing command behavior.
- `src/app/flows/orchestrate.ts` — implement → verify → remediation composition and worktree ownership.

When a design idea conflicts with these invariants, change the design or explicitly propose an engine change. Do not silently design around the invariant.

---

## 29. Final direction

The signature interface is a run control room:

- fleet on the left;
- workflow and role lanes in the centre;
- operator inbox and evidence context on the right;
- terminal as a bottom drawer;
- durable state and honest recovery throughout.

The user should be able to glance at it and understand:

> what the agents are doing, what the system knows, what is safe, and whether I need to act.

That is the standard against which every screen and interaction should be judged.
