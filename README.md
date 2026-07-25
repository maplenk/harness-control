# harness-orchestration

CLI-first orchestration across coding-agent harnesses. One headless TypeScript
engine drives **Claude Code**, **Codex**, **Grok Build**, and **OpenCode** as
child agents over their native headless protocols (Claude stream JSON;
Codex/Grok/OpenCode ACP), through three host-enforced roles:

- **Coordinator** — explores the workspace read-only and drafts an immutable,
  content-addressed specification with objectively testable acceptance
  criteria. Host-validated: ambiguous/untestable criteria are rejected and
  re-driven.
- **Implementor** — implements the *approved* spec inside an isolated git
  worktree (single writer; the primary checkout is never touched).
- **Verifier** — independently verifies every acceptance criterion against the
  implementation commit (read-only), records its own evidence, and drives a
  bounded remediation loop.

The run ends with a **merge-readiness report** — the harness never merges, never
pushes, and never approves its own work; it only prints the exact manual
integration commands (with repo paths/refs POSIX shell-quoted so they stay
copy-pasteable even with spaces). Every state change flows through a
single event-sourced application service (SQLite event log + projections), so a
run survives process restarts and is inspectable after the fact.

## Requirements

- **macOS only** in the MVP (`package.json` declares `"os": ["darwin"]`).
  Memory supervision (§14) samples process-group RSS through BSD/macOS `ps`
  flags; the GNU/Linux `ps` adapter is roadmap, so a Linux install is refused
  rather than silently mis-supervising (`doctor` also warns on a non-darwin
  host). Everything else is portable — only the supervisor is platform-bound.
- Node.js **>= 22.14** (ESM, TypeScript strict; `better-sqlite3` is bundled as
  a dependency).
- `git` on PATH (worktree isolation and the §16 merge-readiness probes).
- For live runs: the selected provider is authenticated (`doctor` reports the
  exact state). Claude always uses the installed first-party `claude` binary
  and its Claude Code subscription/keychain login; Codex uses its installed
  credentials;
  Grok Build uses the installed first-party `grok` binary (version 0.2.106 or
  newer) and its SuperGrok login; OpenCode is lockfile-pinned by this package
  and reuses credentials created by `opencode auth login`. The offline test
  suite needs no live provider.
- Optional planning chat: install
  [Agent Room](https://github.com/steviebuilds/agent-room) (or set
  `AGENT_ROOM_CLI` to its `scripts/agent_room.mjs`) before using
  `start --enable-chat`. Ordinary planning has no Agent Room dependency.

## Install / build

```sh
npm install
npm run build        # tsc → dist/, then marks the bin executable
npm test             # deterministic offline suite (vitest; no real spawns)
npm run typecheck
```

The built CLI is `dist/cli/index.js`, exposed as the `harness-orchestrator`
bin (`npm link` for a global command, or run `npx tsx src/cli/index.ts …`
during development). Run state lives under `HARNESS_HOME` (default
`~/.harness`): one SQLite database plus a content-addressed artifact store.

`dist/` is packaged (`files`/`bin`) but gitignored, so a `prepack` hook runs
`npm run build` before `npm pack`/`npm publish` — the tarball always reflects
current source, never a stale local `dist/`. CI should still assert
`dist/` matches a clean build (build from a clean checkout, diff the tree).

## Walkthrough (PLAN §18)

Every command accepts `--json` for a stable machine-readable payload.

`start` requires the primary workspace to be a clean Git checkout with a
resolvable full HEAD commit. That commit is pinned for the run. The coordinator
still reads the primary checkout, so any tracked, staged, modified, or
untracked path—or any HEAD change—during coordination, revision, re-entry, or
approval invalidates the result with a structured workspace-drift refusal.
Restore the checkout to the pinned clean state and retry the same round.
Ignored build/cache files are outside this policy. The engine deliberately
uses strict rejection here; it does not create or manage a detached coordinator
checkout.

```sh
# 1. Diagnose the environment: adapter binaries + versions, auth (validated
#    evidence only — key presence never reports as "supported"), host
#    provider-config safety, ACP handshake, git, sqlite, quotas.
harness-orchestrator doctor --json

# 2. Create a run: the coordinator drafts + validates a spec, then STOPS at
#    the human approval gate (unless the bound config sets approval:"auto",
#    in which case the engine signs the drafted hash and the run goes straight
#    to `approved` — see "Safety posture"). --config binds the engine config
#    (approval mode, bounds, budget, quotas, probe ladder) to this run — it is
#    persisted and every later command reloads it.
harness-orchestrator start --workspace /path/to/repo \
  --goal "Add a --verbose flag to the CLI" \
  --coordinator claude --model opus --effort low \
  --config harness.config.json

# Grok Build is a first-class profile; model and effort are pinned at spawn.
harness-orchestrator start --workspace /path/to/repo \
  --goal "Plan the requested change" \
  --coordinator grok:grok-build:high

# Add --enable-chat to make planning collaborative. The invitation is printed
# immediately on stderr; open it as a human or paste it into another local
# agent. The command stays in the room loop until the coordinator synthesizes
# a host-validated spec (or the room is closed).
harness-orchestrator start --workspace /path/to/repo \
  --goal "Add a --verbose flag to the CLI" \
  --coordinator claude:opus:low \
  --enable-chat

# 2b. Optional revision round before approving:
harness-orchestrator spec revise RUN_ID --feedback "Tighten AC-2; no new deps"

# 3. Explicit human approval — the ONLY production approval path. The hash
#    binds the exact SpecVersion; omit --spec-hash to bind the drafted spec's
#    hash, or pass it to have it validated against the draft.
harness-orchestrator approve RUN_ID --spec-version SPEC_ID --spec-hash HASH

# 4. Drive implement → verify → (bounded remediation) → merge-readiness.
#    Profiles are packed tokens: harness[:model[:effort]]. Each flag is OPTIONAL:
#    when omitted it DEFAULTS to the approved spec's proposed profile (the
#    coordinator's proposedImplementorProfile/proposedVerifierProfile); an
#    explicit flag always overrides. `run` refuses only when a role has neither
#    a flag nor a resolvable proposal.
harness-orchestrator run RUN_ID \
  --implementor codex:gpt-5.6-terra:medium \
  --verifier grok:grok-build:high

# 4b. …or let the approved spec's proposals stand in — no profile flags needed:
harness-orchestrator run RUN_ID

# 5. Inspect: phase, suspension, honest ETA, vitals (rss / context window /
#    measured + estimated cost with per-role and per-phase attribution),
#    checkpoints, budget. RSS = the newest closed per-minute aggregate, or the
#    latest raw watchdog sample while the current window is still open.
harness-orchestrator status RUN_ID --json

# 6. Resume a paused/interrupted run (crash recovery AND limit/user resume).
#    "interrupted" also covers a mid-round non-limit/non-crash failure — an
#    auth/protocol error, a budget refusal, or a local git error thrown by the
#    live role flow records a durable interrupt so the run stays resumable
#    (never stranded); a terminal composition breach stays terminal.
harness-orchestrator resume RUN_ID

# If RSS supervision paused the run, raise that role's audited memory budget
# and drive the same durable resume/re-entry path in one command. Success is
# reported only after re-entry actually occurs.
harness-orchestrator set-budget RUN_ID \
  --role implementor --memory-budget-mb 2048 --resume
```

Also available: `pause` (stop at a safe point), `cancel` (idempotent
terminal), `breaker reset` (after the restart circuit-breaker opens),
`switch-model` (records a durable per-role DESIRED model, applied at the
next spawn; `status` shows it pending, distinct from the effective/running
model. Live in-place switching at a completed-turn boundary is deferred).

## Claude harness invariant

`claude` has one production meaning in this repository: the installed
first-party Claude Code provider using the user's Claude subscription. This is
enforced for Coordinator, Implementor, Verifier, retries, probes, and model
switches. Production routing never falls back to `claude-agent-acp`, never
requires `ANTHROPIC_API_KEY`, and does not forward that environment variable to
the Claude child.

Role policy remains host-owned:

- Coordinator runs in `dontAsk` mode with only Read/Glob/Grep.
- Verifier runs in `dontAsk` mode with Read/Glob/Grep plus narrowly granted
  `Bash(command)` permissions for the approved spec's exact verification
  commands; it receives no blanket shell permission.
- Implementor runs in `acceptEdits` mode inside the harness-created isolated
  implementation worktree with only Read/Glob/Grep/Edit/Write.
- Bash, subagents, nested worktrees, session persistence, hooks, plugins, and
  MCP servers are unavailable to native Claude roles.

Unlike Codex's isolated `CODEX_HOME`, native Claude intentionally retains the
real `HOME` so Claude Code can reach its subscription/keychain login. Its
confinement boundary is therefore policy-based rather than a filesystem
sandbox: safe mode, empty strict MCP, the role-specific tool list, denied
tools, `dontAsk`, and exact verifier `Bash(command)` grants. The complete spawn
argv for every role is regression-tested as a security contract. A real
subscription-backed probe additionally proves that an exact verifier Bash
grant executes, a different Bash command is denied under `dontAsk`, and the
installed CLI's `rate_limit_event` envelope agrees with the production
classifier:

```sh
npm run smoke:claude:provider
```

Use `npm run smoke:claude:provider:record` when deliberately refreshing the
credential-free evidence in
`docs/reviews/evidence/claude-provider-live.json`.

The harness prevents the earlier wrong-transport/API-key failure class. No
local adapter can guarantee availability during a Claude outage, expired
login, or subscription usage limit; those remain explicit provider failures
and enter the existing pause/retry/failover machinery instead of silently
changing credentials or models.

## Grok Build harness

`grok` means the installed first-party Grok Build CLI using its native
`grok agent stdio` ACP server. Install Grok Build using the
[official instructions](https://docs.x.ai/build/cli/reference), sign in with
the SuperGrok account, and verify the characterized minimum version before a
live run:

```sh
grok login
grok --version             # 0.2.106 or newer
grok models                # confirm grok-build is available
harness-orchestrator doctor --json
```

The packed profile is `grok:MODEL[:EFFORT]`; for example,
`grok:grok-build:high`. Model and reasoning effort are passed to the Grok
process before ACP starts and are never silently substituted. Grok uses the
SuperGrok browser-login token in `~/.grok/auth.json`; the orchestrator does
not require an `XAI_API_KEY` for that subscription path and never parses or
logs the auth file.

Every spawned Grok role receives a disposable `GROK_HOME` containing only a
byte-copy of `auth.json` plus orchestrator-owned configuration. Auto-update,
leader sharing, memory, subagents, host hooks/plugins/MCP, and compatibility
imports are disabled. A workspace containing project-scoped hooks, plugins,
MCP, sandbox, or permission configuration is rejected before spawn rather
than trusted. Coordinator and verifier are read-only; only the implementor
may write, and only inside its assigned worktree. The isolated home is deleted
when the adapter closes and is never written back to `~/.grok`.

The live hostile-config probe is intentionally separate from the offline test
suite. It requires an explicit opt-in because it consumes SuperGrok usage; all
probe files and homes are disposable and credential contents are never parsed
or exposed:

```sh
HARNESS_GROK_LIVE_SMOKE=1 npm run smoke:grok:isolation

# Deliberately refresh the sanitized committed evidence:
HARNESS_GROK_LIVE_SMOKE=1 npm run smoke:grok:isolation:record
```

Authentication and weekly subscription limits remain provider-owned. Doctor
reports credential presence only as `detected_but_unvalidated`; a successful
live turn is required before auth can be called supported. Auth failures and
usage-limit envelopes enter the existing interrupt, retry, and failover state
machine without changing credentials or models.

## OpenCode providers and models

The OpenCode harness uses the pinned local `opencode-ai` dependency and its
native `opencode acp` server. Authenticate providers ahead of a run:

```sh
./node_modules/.bin/opencode auth login
./node_modules/.bin/opencode auth list
./node_modules/.bin/opencode models PROVIDER_ID
```

The orchestrator never parses or logs
`~/.local/share/opencode/auth.json`, never launches an interactive login, and
never assumes OpenRouter. Each spawn gets a private HOME/XDG tree: the auth
store is byte-copied in at `0600`, the real store is never written back, and
the tree is deleted on close. OpenCode runs as `opencode acp --pure`; host and
project config, external plugins/skills, custom agents, MCP servers, and
auto-allow permission rules are excluded. The orchestrator pins the exact
`provider_id/model_id` advertised by the new ACP session. For example:

```sh
harness-orchestrator start --workspace /path/to/repo \
  --goal "Plan the requested change" \
  --coordinator opencode:PROVIDER_ID/MODEL_ID:high
```

Provider/model catalogs are dynamic. Connect the provider first, run
`opencode models PROVIDER_ID`, and use the exact returned identifier. OpenCode
supports SuperGrok OAuth for xAI and the Z.AI Coding Plan credential path.
Use the first-party `grok:grok-build:EFFORT` harness for new SuperGrok runs;
the OpenCode xAI path remains supported only as an OpenCode-provider option.
Moonshot/Kimi currently uses a Moonshot API key rather than a Kimi consumer
subscription login. A requested model that the live session does not
advertise is rejected before a turn; it is never silently substituted.

OpenCode build-mode safety is source- and live-characterized for the pinned
`opencode-ai@1.18.1`. Workspace reads and structured implementor edits are
allowed; Bash, network, external-directory access, and every unlisted tool
must ask the ACP client and are default-denied in headless runs. Delegation
through OpenCode's `task` tool is denied because the orchestrator owns roles.
The offline suite pins the committed proof to the exact OpenCode version. A
version bump cannot pass until the hostile-config + real Grok acceptance
probe succeeds and refreshes that proof:

```sh
npm run smoke:opencode:isolation:record
```

## Opt-in planning chat

`start --enable-chat` adapts the coordinator phase to an Agent Room discussion
without changing the workflow or approval model:

- Agent Room is started only for opted-in runs and is forced to
  `127.0.0.1`; the normal planning path remains dependency-free.
- The coordinator publishes an opening position, then long-polls the room's
  server-managed unread queue. Humans can participate in the browser and other
  local agents can join with the printed invitation.
- The room's **Only when addressed** mode is honored: unaddressed messages are
  observed but do not trigger a coordinator response.
- A first draft is never accepted before at least one external contribution.
  The final room synthesis still passes the same schema/testability validator,
  becomes an immutable SpecVersion, and stops at explicit human approval.
- The choice is persisted in run metadata, so coordinator resume and
  `spec revise` keep chat enabled. `status --json` reports
  `planningChatEnabled`.

Room transcripts remain under Agent Room's local data directory. Planning
fails with an install hint if chat is enabled but the Agent Room script cannot
be found.

## Real end-to-end acceptance test

The committed live smoke is a repeatable, disposable test of the shipped CLI
with real provider sessions:

```sh
# Coordinator → approval seam → Implementor → Verifier → merge_ready
npm run smoke:live

# The same flow, plus a real Agent Room planning discussion and human review
npm run smoke:live:chat
```

Every Claude role uses the installed first-party `claude` provider in
persistent stream-JSON mode, backed by the authenticated Claude Code
subscription rather than an Anthropic API key. The role policies in
[Claude harness invariant](#claude-harness-invariant) apply unchanged during
the smoke.

`smoke:live:chat` creates a fresh temporary git repository containing a small
`missionStatus` implementation task and deterministic failing Node tests. It
waits for the real Coordinator's opening Agent Room message, posts an
adversarial human review through the real room API, and requires a second
Coordinator synthesis before proceeding. It then checks the immutable spec,
uses the test-only explicit-approval seam, drives a real Implementor and an
independent real Verifier, requires `merge_ready`, re-runs `npm test` itself,
and proves that only the requested source file changed while the primary
checkout remained untouched. Before cleanup it also reads each role's durable
`child.spawned` model pin, fails if it does not match the requested role
profile, prints the effective model and provider-echo status, and writes the
three-role evidence to `model-spawns.json`. The isolated room server and all
temporary repositories, worktrees, run data, transcripts, and model evidence
are removed afterward.

This is intentionally not part of `npm test`: it uses authenticated providers,
takes longer, and may incur provider usage. Run `npm run dev -- doctor --json`
first. Agent Room must be installed at its standard Codex skill path, or its
single-file CLI can be supplied explicitly:

```sh
AGENT_ROOM_CLI=/path/to/agent_room.mjs npm run smoke:live:chat
```

Each role profile is independently configurable with a packed
`harness:model[:effort]` token. For example, this runs all three roles through
separate Codex sessions:

```sh
HARNESS_SMOKE_COORDINATOR=codex:gpt-5.6-terra:low \
HARNESS_SMOKE_IMPLEMENTOR=codex:gpt-5.6-terra:medium \
HARNESS_SMOKE_VERIFIER=codex:gpt-5.6-terra:high \
npm run smoke:live:chat
```

Set `HARNESS_SMOKE_KEEP=1` to retain the disposable repository, run store, and
`model-spawns.json` proof artifact for diagnosis after a failure or successful
audit run. The smoke still does not bypass the production approval command:
automation is possible only through `--test-approve` with
`HARNESS_TEST_MODE=1`, binding the exact drafted spec version and hash.

## Safety posture

- **Review-before-integrate, always.** The implementor's work stays on an
  isolated worktree branch; `merge_ready` means "verified and clean to
  integrate", and the report prints the exact manual commands. Nothing is
  merged, committed to your branch, or pushed on your behalf — you review the
  diff and integrate yourself.
- **Approval is human and explicit by default.** The `--test-approve` seam
  refuses to run unless `HARNESS_TEST_MODE=1` and, when a draft exists, binds
  the real draft hash. `run` refuses to execute if the approved hash does not
  match the current draft.
- **Autonomy is opt-in, per run, and never silent.** Setting
  `approval: "auto"` in the config `start` binds (default: `"human"`) has the
  ENGINE sign the drafted spec so an autonomous run does not wait at the input
  gate. It is a signature, not a bypass: it binds the REAL drafted hash, runs
  the same draft-loss validation an explicit approval runs (a missing/stale
  draft still refuses), leaves the testability gate strict, and never touches
  the `--test-approve` synthetic-hash path. The mode is pinned into the run at
  creation, so it cannot be granted or revoked mid-run. Every auto-approval is
  recorded as `spec.approved {approvedBy:"auto"}`, and the merge-readiness
  report carries `specApprovedBy` plus an explicit warning — when you review a
  merge, you are told whether anyone reviewed the intent. **The merge gate is
  unchanged and still human: nothing auto-merges.**
- **Source pinning is fail-closed.** New runs are not created from non-Git,
  unborn, dirty, unresolvable, or drifting workspaces. Every fresh
  implementation worktree is created from the run's branded full commit SHA;
  symbolic, short, missing, or mismatched bases are rejected. The service
  itself guards coordination completion, revision/re-entry, approval, and
  worktree admission, closing direct-caller and in-check HEAD/status races.
  Both standalone and loop-driven implementation compare their supplied base
  exactly with the durable run pin before creating a worktree. There is no
  public production legacy-run creator; persisted legacy runs retain only the
  one-time audited pin compatibility path, modeled in tests by a production-
  build-excluded fixture. This is deliberately reject-all-drift in the primary
  checkout — no detached-checkout lifecycle subsystem exists.
- **RSS shutdown is durable and exit-confirmed.** The watchdog persists a
  generation-bound stop intent before a verified emergency signal, keeps
  sampling while graceful cleanup is pending, and retains supervision and
  concurrency ownership until observed WHOLE-PGID absence confirms an
  identity-backed exit. Successful transport disposal triggers a resample but
  is not confirmation: adapters may return after leader exit while descendants
  remain. Opaque handles without a process identity retain their owned-disposal
  contract because there is no PGID to sample. Signal delivery alone never
  confirms exit: startup recovery
  retains registry ownership and withholds re-entry until a later observation
  proves the entire process group gone. RSS and provider-limit stops share one
  generation barrier; it commits the durable terminal outcome before cleanup
  or reservation/concurrency release, and retries failures while capacity
  remains held. A late absent PGID after an abnormal/no-T22 ambiguity timeout
  records a breaker-exempt recovery interrupt before releasing ownership.
  Startup identity mismatch still withholds signaling, but an independently
  absent recorded PGID is reconciled instead of permanently skipped. Startup
  stop/recovery processing reloads durable state before removing that registry
  record; a rejected T17 that leaves the generation live retains the record
  for retry.
  Identityless cancel, confirmation, and outcome-retry timers
  stay referenced because no registry recovery route exists. Failed disposal
  without a captured identity also fails closed, while a failed graceful-
  intent write rolls back for retry. A rejected T22 write launches no cancel,
  dispose, signal, or taint side effect. Identity mismatch never records a
  false resource-exhaustion outcome.
- **Child-harness isolation (H-1).** Codex children run with an isolated
  `CODEX_HOME` carrying auth material only, plus orchestrator-owned config
  that routes approvals to the orchestrator — host-level provider config can
  never weaken permission mediation. Permission mediation is default-deny;
  the coordinator and verifier additionally carry a host-enforced write veto.
  OpenCode children likewise run with private HOME/XDG state, `acp --pure`,
  excluded host/project config and MCP, and a protected permission overlay;
  native `plan` is pinned for coordinator/verifier and `build` only for the
  implementor worktree. Grok Build children run with a disposable `GROK_HOME`
  carrying only SuperGrok auth plus orchestrator policy; model/effort, sandbox,
  tools, permissions, `--no-leader`, `--no-memory`, and `--no-subagents` are
  pinned before `grok agent stdio` starts.
- **Verification-command confinement (W3-1, MVP-honest).** The spec's declared
  verification commands are full command lines the HOST shell executes in the
  implementor worktree — they are **not fully sandboxed** in the MVP: there is
  no network confinement and no filesystem confinement beyond two enforced
  guards. Guard 1 — minimal env allowlist: the runner inherits only PATH +
  basic toolchain vars (the same §17.1 allowlist discipline as child spawns);
  credential-shaped variables never cross, per-run additions must be explicit
  config (`verification.envAllowlist`, credential-shaped names rejected at
  parse), and a blanket `process.env` inherit does not exist. Guard 2 —
  primary-checkout mutation guard: before the commands the primary repo's
  HEAD, `git status --porcelain --ignored` (so a **new gitignored file** is
  drift, not just tracked edits), a content manifest of the primary
  `.git/hooks` directory, and a hash of the primary `.git/config` are
  snapshotted and re-checked after; any drift fails the round's verification
  with a typed `verification_runner_violation`, blocks §16 merge-readiness, and
  records a durable incident event. Because `.git/hooks` and `.git/config` are
  the **shared git common-dir a linked worktree also reaches**, planting a
  `.git/hooks/pre-commit` (persistent code execution on the next primary
  commit) or rewriting `.git/config` (`core.pager` payload) — even from a
  command running in the worktree cwd — is now detected. Known residuals,
  kept deliberately: the guard is scoped to those enumerated dimensions, **not
  the whole `.git`** — it covers the executable persistence surfaces (hooks +
  config) but not the ref/object database or `.git/info/*`, so a
  non-code-execution primary git mutation (packed/loose refs, a loose object,
  `.git/info/exclude`/`attributes`) can drift undetected (none is a
  code-execution vector on its own — an `info/attributes` filter still needs a
  hashed `.git/config` driver); reads/exfiltration WITHOUT any mutation are also
  out of scope (it is a mutation detector); there is no network egress
  confinement, there is no OS-level sandbox, and a repeated write to an
  already-dirty porcelain path is invisible to the snapshot diff. The
  env-allowlist credential refusal also deliberately excludes bare `auth`/`key`
  names (`SSH_KEY`, `DEPLOY_KEY`, `AUTH`, `BEARER`, `COOKIE`, `SESSION_ID`),
  so those cross only if an operator explicitly opts them into
  `verification.envAllowlist` — an opt-in heuristic caveat, never a blanket
  inherit. Per-platform OS sandboxing (sandbox-exec / bwrap) is the roadmap
  item that closes the remaining gap. **Timeout kills the process TREE (W4-7):**
  the runner spawns each command `detached` in its own process group and, on
  timeout, drives the same graceful-then-forced ladder the ACP transport uses
  (SIGTERM the group → 2s grace → SIGKILL the group), so a verification command
  that starts a background server/watcher cannot leave a descendant surviving
  past the reported timeout (exit 124); a final group SIGKILL also sweeps any
  straggler the moment the shell exits.
- **Redaction before every sink.** Credentials/keys are scrubbed before
  anything reaches the DB, artifacts, logs, or checkpoints; artifact writes
  are quota-admitted (per-run/global) with a durable rejection audit trail.
  User-origin free text in run METADATA (W3-3) is redacted at the two single
  write boundaries every durable row funnels through — event append and
  projection save — via a REGISTERED field-level map, never a blind
  deep-walk: the registered fields are the run goal, `spec revise` feedback,
  the implement→verify loop's task scope, the role round's serialized
  inputs, and the spec draft's goal + canonical text; every other field
  (enums, ids, hashes, whole unregistered payloads) is stored byte-identical.
  The spec draft's canonical text uses the same plain `redactText` the
  artifact CAS applies before hashing (`ArtifactStore.put` redacts, then
  hashes; the SQL artifact repository refuses `redacted:false` writes), so
  the draft projection converges byte-for-byte with the spec artifact whose
  hash approval binds; the serialized round inputs are redacted structurally
  (parse → per-leaf redact → re-stringify) so they always remain parseable
  JSON for resume re-entry.
  Name-based assignment redaction covers quoted values too, and the quoted
  branches are JSON-string-grammar correct: a quoted value
  (`{"password":"correct horse battery staple"}`) is consumed to the nearest
  UNESCAPED closing quote — internal whitespace/commas/braces AND
  backslash-escaped quotes (`{"password":"\"whole\""}`) are secret material,
  not terminators. Sensitive pairs hidden inside STRINGIFIED JSON
  (`\"password\":\"...\"` at escape depth 1–3, backslash-run delimiters) are
  matched textually without parsing; the flat provider-error sink
  (`describeRawError` → durable probe detail, `status --json`, CLI text)
  adds a parse-based belt (`redactFlattenedJson`) that redacts embedded
  JSON structurally by key name at any stringification depth — fuzz-pinned
  for depth 0–3 — and always falls back to plain text redaction. A
  sensitive key whose quoted value is TRUNCATED before its closing quote
  redacts to end-of-string (unterminated-quote fallback, sensitive-key
  gated), and every site that bounds/slices provider-derived text redacts
  BEFORE truncating, so a cut can shorten a `[REDACTED:...]` marker but
  never un-terminate a quote ahead of redaction. Honest scope limit:
  redaction matches secrets by shape or by key name — a shapeless secret in
  free prose (no `KEY=value` form, no recognizable token shape) is out of
  pattern-redaction scope by design. Accepted, fixture-pinned residuals
  (kept deliberately): the unquoted `API_KEY=head,tail` form redacts only
  `head` (the comma must terminate unquoted values; the tail is shapeless
  prose); a digit-glued key (`1API_KEY=`) never matches (env names cannot
  start with a digit — the guard is what prevents false positives inside
  hex strings/ids); and at the pure-regex layer an escape-run value
  embedding a DEEPER-escaped quote can leave a tail fragment (never the
  whole secret) — the flat-error belt covers the full grammar at that sink.
  The pattern layer is CONVERGED: further text-path findings are
  documented-accepted residuals unless a whole shaped-or-keyed synthetic
  secret leaks through a durable sink.
- **Honest reporting.** Usage-limit pauses report their ETA as `unknown`
  unless the provider supplied one — never an invented countdown. Cost totals
  separate measured spend from conservative estimates, and `--max-budget` is
  an estimated soft budget (refusal gate), never claimed as a hard ceiling.
- **Opt-in failover on a usage limit.** With a per-assignment
  `failoverPolicy` of `switch_model`/`switch_harness` and an ORDERED
  `failoverLadder` of `{harness, model, effort?}` targets (each `harness`/`effort`
  validated at parse against the runtime vocabulary — an unadvertised value is
  rejected, not accepted only to fail later), a usage limit first
  pauses+checkpoints as usual, then self-drives the proven successor spine to
  the next ladder rung (a same-harness model swap, or a checkpoint-seeded
  successor on the other harness) instead of waiting — bounded per incident by
  `maxFailoversPerIncident`. The failover keeps the same assignment (so the
  crash breaker cannot be evaded) and raises a durable `failover` alert with
  the from→to lineage; when the ladder is exhausted the run honestly degrades
  to wait (stays paused for a probe or manual resume), never silently dropped.
  Failover works for BOTH the implementor and the verifier half: the re-drive
  re-enters at the role that paused (a verifier re-enters at verification), and
  the whole ladder advance commits atomically so a crash mid-failover retries
  the SAME rung rather than skipping one. Default `wait` is unchanged: pause and
  wait.

## Layout

- `src/domain` — event vocabulary + the §6.3 transition table (pure).
- `src/app` — the orchestration service, role flows, cost accounting.
- `src/adapters` — native Claude provider, Codex/Grok/OpenCode ACP transports, and
  offline fakes.
- `src/persistence` — SQLite event log, projections, quota-aware artifact CAS.
- `src/worktree`, `src/supervisor`, `src/checkpoint`, `src/memory` — worktree
  isolation, process supervision, mechanical checkpoints, provenance memory.
- `profiles/` — the three role profiles injected every turn.
- `PLAN.md` — the normative plan the code cites throughout (§ references).
