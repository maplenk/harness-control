# harness-orchestration

CLI-first orchestration across coding-agent harnesses. One headless TypeScript
engine drives **Claude Code** and **Codex** as child agents over the Agent
Client Protocol (ACP), through three host-enforced roles:

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
- For live runs: the provider CLIs the adapters spawn — Claude Code and/or
  Codex — installed and authenticated (`doctor` reports the exact state).
  The offline test suite needs none of them.

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

```sh
# 1. Diagnose the environment: adapter binaries + versions, auth (validated
#    evidence only — key presence never reports as "supported"), host
#    provider-config safety, ACP handshake, git, sqlite, quotas.
harness-orchestrator doctor --json

# 2. Create a run: the coordinator drafts + validates a spec, then STOPS at
#    the human approval gate. --config binds the engine config (bounds,
#    budget, quotas, probe ladder) to this run — it is persisted and every
#    later command reloads it.
harness-orchestrator start --workspace /path/to/repo \
  --goal "Add a --verbose flag to the CLI" \
  --coordinator claude --model opus --effort low \
  --config harness.config.json

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
  --verifier claude:sonnet:medium

# 4b. …or let the approved spec's proposals stand in — no profile flags needed:
harness-orchestrator run RUN_ID

# 5. Inspect: phase, suspension, honest ETA, vitals (rss / context window /
#    measured + estimated cost with per-role and per-phase attribution),
#    checkpoints, budget. RSS = the newest closed per-minute aggregate, or the
#    latest raw watchdog sample while the current window is still open.
harness-orchestrator status RUN_ID --json

# 6. Resume a paused/interrupted run (crash recovery AND limit/user resume).
harness-orchestrator resume RUN_ID
```

Also available: `pause` (stop at a safe point), `cancel` (idempotent
terminal), `breaker reset` (after the restart circuit-breaker opens),
`switch-model` (records a durable per-role DESIRED model, applied at the
next spawn; `status` shows it pending, distinct from the effective/running
model. Live in-place switching at a completed-turn boundary is deferred).

## Safety posture

- **Review-before-integrate, always.** The implementor's work stays on an
  isolated worktree branch; `merge_ready` means "verified and clean to
  integrate", and the report prints the exact manual commands. Nothing is
  merged, committed to your branch, or pushed on your behalf — you review the
  diff and integrate yourself.
- **Approval is human and explicit.** There is no auto-approve path; the
  `--test-approve` seam refuses to run unless `HARNESS_TEST_MODE=1` and, when
  a draft exists, binds the real draft hash. `run` refuses to execute if the
  approved hash does not match the current draft.
- **Child-harness isolation (H-1).** Codex children run with an isolated
  `CODEX_HOME` carrying auth material only, plus orchestrator-owned config
  that routes approvals to the orchestrator — host-level provider config can
  never weaken permission mediation. Permission mediation is default-deny;
  the coordinator and verifier additionally carry a host-enforced write veto.
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

## Layout

- `src/domain` — event vocabulary + the §6.3 transition table (pure).
- `src/app` — the orchestration service, role flows, cost accounting.
- `src/adapters` — ACP transport + Claude/Codex profiles + offline fakes.
- `src/persistence` — SQLite event log, projections, quota-aware artifact CAS.
- `src/worktree`, `src/supervisor`, `src/checkpoint`, `src/memory` — worktree
  isolation, process supervision, mechanical checkpoints, provenance memory.
- `profiles/` — the three role profiles injected every turn.
- `PLAN.md` — the normative plan the code cites throughout (§ references).
