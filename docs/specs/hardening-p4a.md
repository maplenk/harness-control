# Hardening + P4a Specification

Input: external review (2026-07-18, 8 findings + hygiene) — every finding independently
verified by the orchestrator against the cited lines before this spec was written.
Wave 1 = findings 1,3,4,5,6,7,8 + hygiene. Wave 2 = P4a proper (finding 2 is its mandate).
Normative context: PLAN.md §6.3, §12.2, §13, §14, §16, §17.2, §20.

Standing constraints for every agent working from this spec:
- NEVER `git commit`/`git push`/`git add`. All changes stay unstaged in the working tree.
- Never touch `~/.codex` or `~/.claude`; never log credential contents; H-1 CODEX_HOME
  isolation (`src/adapters/codex/home-isolation.ts`, `src/adapters/factory.ts`) must hold.
- TypeScript ESM strict; match existing style/comment density; vitest.
- Definition of done per stage: scoped tests green AND `npx vitest run` fully green AND
  `npx tsc --noEmit` clean. Update existing tests whose asserted behavior this spec
  deliberately corrects — never weaken a gate to make a test pass.
- Where a fix amends normative PLAN.md text, make the minimal edit in PLAN.md and note it
  in the return payload (section + one-line description).

---

## W1-F1 — merge_ready must assert the full §16 gate (CRITICAL)

Defect: `src/app/flows/verifier.ts` `runVerification` — when `verification.outcome ===
'all_verified'` it builds `MergeReadiness` from git facts but then ingests the T24
"passed" trigger unconditionally (~line 856). A dirty destination, base drift, conflict,
wrong commit, or failed required tests still yields phase `merge_ready`;
`orchestrate.ts:250` then exits the loop reporting success.

Corrected semantics (normative): **phase `merge_ready` asserts criteria-all-verified AND
`MergeReadiness.ready === true`.**
- If criteria pass but the readiness probe blocks → do NOT ingest T24. Ingest T23 instead,
  with the §16 blockers mapped to structured `FixRequest`s (kind label
  `integration_blocker`; human-actionable blockers like destination-dirty say so in the
  text). The loop continues bounded; exhaustion → `failed` (honest, never false success).
- If NO probe was supplied → readiness is unprovable → treat as blocked (fail-safe, §16).
  Production callers (orchestrate.ts) always supply the git probe. Update unit tests that
  relied on probe-less T24 to supply a clean fake probe.
- PLAN.md amendment: §6.3 T23 precondition becomes "verification: any criterion
  failed/unproven, OR §16 readiness probe blocked/absent"; regenerate/extend the
  conformance test for the amended row.
- Regression tests: each §16 blocker (dirty destination, base drift, conflicts, wrong
  commit, required tests not passed, probe absent) individually forces NOT-merge_ready and
  produces T23 fix requests naming the blocker.

## W1-F3 — approval must bind execution to the approved spec (CRITICAL)

Defect: `src/cli/commands.ts` — human approve (~:257) accepts any `--spec-hash` verbatim;
`--test-approve` (~:242) fabricates `toSpecHash('test-approve:...')`; `handleRun` (~:304)
uses `draft.specHash` and never compares `status().approvedSpecHash`.

Fix:
- `approve`: load `service.getSpecDraft(runId)`. If a draft exists: `--spec-hash`, when
  given, MUST equal `draft.specHash` (mismatch → refusal `approved_hash_mismatch`, exit 2,
  show both hashes); `--spec-hash` may be omitted and binds `draft.specHash`; the
  `--spec-version` id must match the draft's version id when the draft records one.
  If no draft exists: keep the current explicit `--spec-hash` requirement.
- `--test-approve`: when a draft exists, bind `draft.specHash` (kills the synthetic-hash
  residual F-2); synthetic hash only when no draft exists (pure-unit runs), unchanged.
- `run`: refuse unless `status().approvedSpecHash` is defined AND equals
  `draft.specHash` (`approved_spec_mismatch`, exit 1, both hashes shown).
- Tests: approve-with-wrong-hash refused; approve-omitting-hash binds draft hash;
  run-with-mismatched-approved-hash refused; test-approve binds real draft hash.

## W1-F4 — verification must not validate content missing from the commit (CRITICAL)

Defect: `src/app/flows/implementor.ts` commits (~:442) then runs the spec's verification
commands (~:463) in the same worktree; those commands can mutate the tree after the
commit. `gitMergeReadinessProbe` (`verifier.ts` ~:695) checks only the DESTINATION's
cleanliness, never the worktree's.

Fix (keep the commit-then-verify order — it exists so the recorded diff is not polluted;
enforce instead):
- After the verification commands, the implementor flow records a post-verification
  `git status --porcelain` snapshot of the worktree in its result (`postVerificationDirty:
  boolean` + bounded file list).
- `gitMergeReadinessProbe` gains a `worktreeClean` fact (porcelain status of
  `worktreePath` at probe time — this also catches dirt from the verifier's own evidence
  commands).
- `buildMergeReadiness` blockers include `worktree dirty after verification commands
  (files: …)` when `worktreeClean === false`; combined with W1-F1 this forces T23, and the
  fix-request text tells the implementor to make verification side-effect-free or commit
  the generated files.
- PLAN.md §16 readiness list: add "implementation worktree dirty post-verification".
- Tests: a verification command that mutates a file → NOT merge_ready, blocker names the
  file; clean commands → unaffected.

## W1-F5 — durable config, wired quotas, honest budget (HIGH)

Defects: `src/cli/index.ts` loads `--config` only for `start` (~:87) and never persists
it; `openDatabase` (~:103) receives no quotas; `buildCliFlows` (~:127) uses a bare
`ArtifactStore` instead of the quota-aware repository; `wouldExceedBudget`
(`src/app/cost.ts:239`) ignores `totalEstimatedCostUsd`.

Fix:
- Persist the resolved `EngineConfig` at `start` into a per-run projection (e.g.
  `RUN_CONFIG_PROJECTION`; plain bounds/budget/ladder — no secrets). Every later command
  resolving that run loads it (defaults only when absent, with a stderr warning).
  `--config` on non-start run-scoped commands → usage error "config binds at start".
- Thread the effective config's quotas into `openDatabase` (it already accepts quota
  options — wire them) and make CLI artifact writes go through the quota-aware
  database artifact repository rather than a bare store, for both `start` and `run` paths.
- Budget: refusal predicate becomes `totalCostUsd + totalEstimatedCostUsd +
  reservationUsd > maxBudgetUsd`; `status` budget block shows measured and estimated
  spend separately (§17.2 stays an estimated soft budget — honest wording).
- PLAN.md §17.2: one-line amendment that estimated spend counts toward refusal.
- Tests: config persisted at start is honored by a later `status`/`run` invocation
  (fresh service instance); artifact admission over quota rejects through the CLI path;
  repeated unpriced (estimated-only) turns trip the budget refusal.

## W1-F6 — event-log replay must reconstruct workflow phase (HIGH)

Defect: `advanceWorkflowPhase` (`src/app/service.ts` ~:398-417) validates then saves the
projection directly at the same cursor — no event. `recover()` replays only the event
log, so a lost/corrupt projection rebuilds to the wrong phase and later transitions
reject.

Fix:
- New domain event `workflow.dispatch.advanced { from, to }` (supporting event, not a
  §6.3 table row). `advanceWorkflowPhase` appends it through the same
  `appendTriggerWithEffects` write path (idempotency key included) with the projection
  update in one transaction.
- The engine reducer folds it: validates the edge against `WORKFLOW_DISPATCH_EDGES` +
  current phase during replay (illegal on replay = corrupt log → loud typed error, not
  silent acceptance).
- Tests: extend test 10 — delete/corrupt the EngineState projection after a run that used
  dispatch advances; `recover()` rebuilds the exact phase; subsequent transitions apply.

## W1-F7 — `spec revise` must complete the revision round (HIGH)

Defect: `commands.ts` (~:110) only ingests T2 (phase → `specifying`) and stops; the
coordinator is never re-run, no new draft is stored, the run never returns to
`awaiting_approval`.

Fix: after a successful T2 ingest, when the flow runtime is available (same
`deps.flows` gate as `start`): re-run the coordinator through
`service.runRole`/the coordinator flow with revision context (previous draft + user
feedback — `coordinator.ts` already supports revision context; read it first), persist
the new draft via `saveSpecDraft` (superseding version lineage fields as the draft state
supports), advance `specifying → awaiting_approval`, and print the new version/hash for
approval. Without a flow runtime → keep T2-only behavior but say explicitly that the
coordinator re-run is unavailable in this invocation. Tests: revise round with a fake
coordinator produces a NEW draft hash, phase back at `awaiting_approval`, old approval
hash no longer valid for `run` (ties into W1-F3).

## W1-F8 — model/effort pins are enforced, never silent (HIGH)

Defect: `applyRoleModel` (`src/app/model-resolution.ts` ~:190) converts per-intent
failures to `ok:false` results; `runRole` (`service.ts` ~:529) proceeds regardless — a
role can silently run on the provider's default model.

Fix: in `runRole`, after `applyRoleModel`: any intent with `ok === false` → retry that
intent ONCE (§11.2's one-retry); still failing → dispose the session and throw a typed
`ModelPinError` naming role/intent/error — the spawn fails honestly (initial-spawn
pinning is pre-work, so hard-fail is clean; the §11.2 checkpoint-successor fallback
applies to mid-run switches and lands in P4b). An `ok:true` result without an
effective-value echo stays accepted but is recorded (`echoed:false`) and surfaced in the
role-spawn event payload — the live gate showed some adapters do not echo; do not turn
that into a failure. Tests: pin failure → retry → typed error, session disposed, no turn
run; echo-less success proceeds with `echoed:false` recorded.

## W1-H — release hygiene

- `src/cli/index.ts`: add `#!/usr/bin/env node` first line (tsc preserves it); add a
  `postbuild` chmod or equivalent so the declared bin is executable.
- `tsconfig.build.json`: exclude `**/*.test.ts` (and test-support files not imported by
  production code — verify with the build) from `dist`.
- `package.json`: add `files` whitelist (dist, profiles, README, LICENSE-if-present) so
  the pack contains no `.claude`/local settings; declare `zod` as a direct dependency
  (it is imported directly).
- `README.md`: real content — what the harness is, requirements, install/build, the §18
  command walkthrough (doctor → start → approve → run → status → resume), safety posture
  (unstaged-review workflow, H-1 isolation, honest ETAs). Keep it accurate to what ships.
- Do NOT commit anything (user reviews the unstaged tree; that finding is by design).

---

## W2 (Rev 2) — P4a: usage-limit detection → honest pause → durable resume (flagship)

Rev 2 incorporates the Codex gpt-5.6-sol xhigh design pushback (11 items, verdict
"redesign"; full text relayed in the session transcript; dispositions in
ORCHESTRATOR-NOTES §5e). Items 1,2,4,5,6,7,8,9,10,11 adopted; item 3 adopted with one
reasoned deviation (probe stays a fresh session — see W2-4 rationale). Wave 1 is landed;
this wave also REWORKS one Wave-1 behavior (readiness blockers, W2-2) per pushback item 1.

### W2-0 Wave-1 follow-ups (unchanged from Rev 1)
- `ingest()` guard: public ingest rejects `workflow.dispatch.advanced` with a typed error
  directing callers to `advanceWorkflowPhase` (only legal producer). Test included.
- Echo-mismatch pins: an `ok:true` pin whose echoed `effectiveValue` differs from the
  requested value = failed pin → same classify-then-retry path as W2-3 step 2.
- Watch-list (no W2 work): transient tinypool crash (once, unreproduced); dist ships
  adapter fixture files (harmless); `"private": true` deliberate.

### W2-1 Domain rework (pushback items 6, 7, and table amendments)
- **Operation axis** gains `initial_config_pin` (§6.2): set from option discovery through
  pin enforcement; `prompt_turn` only wraps actual prompt turns. T4's precondition
  becomes `operation = prompt_turn | initial_config_pin` (identical no-successor pause
  effects). T5 stays reserved for requested mid-run switches (operation=model_switch).
- **activeChild is generation-tracked, not boolean**: `{generationId, segmentId, status:
  'spawning'|'active'|'stopping'|'stopped'}`. New supporting events `child.spawned
  {generationId, segmentId, role, pins[] (incl. echoed values)}` and `child.stopped
  {generationId, reason}`; `child.stopped` clears ONLY a matching active generation (a
  late stop from generation N must not clear N+1). T11 (user pause) completes only after
  stop confirmation: pause = stop-intent → confirmed stop → suspension folds.
- **T13 amended for P4a**: unexpected non-limit child exit → fold counters, mark that
  generation stopped, suspension=`interrupted` (manual resume required); NO
  `segment.restart.initiated`, NO childActive=true, NO auto-respawn (real bounded respawn
  is P4b, built on the successor machinery). Resume from `interrupted` = the same
  eligibility-checked re-entry as T9/T12 (worktree validation first, §16.3).
- **T9 amended**: does NOT set childActive. T9 atomically records a
  `resume_reentry_pending` projection (which round/role will re-enter); `child.spawned`
  later sets the active generation; a `resume_reentry.completed` supporting event acks
  the re-entered round. Startup and `resume` reclaim unacknowledged pending re-entries
  idempotently (pushback item 4).
- **T24 payload-validated**: the T24 event carries the MergeReadiness (ready:true
  required); the reducer/conformance suite rejects a T24 with ready!=true or absent
  readiness — closes item 1's "silently escapes the generator" gap.
- **T10 reducer purified** (item 8): scheduling decisions move OUT of the reducer (no
  hard-coded PROBE_LADDER_MINUTES in transitions.ts); the reducer only folds probe
  counts/incident state; the pure scheduler (W2-4) computes deadlines from the pinned
  per-run config and appends one explicit `limit.probe.scheduled {at, rung, probeIndex}`
  supporting event.
- All §6.3 table changes are mirrored in PLAN.md and the generated conformance tests
  (T4 operation set, T9 no-childActive + pending, T11 stop-confirmed, T13 interrupted,
  T24 payload validation, T23 narrowing per W2-2).

### W2-2 Readiness rework (pushback item 1 — reworks part of Wave 1)
Split §16 blockers by who can act:
- **Agent-actionable — stays T23** (Wave-1 behavior preserved): implementation-worktree
  dirty after verification commands (only a new implementor round fixes it; the
  fix-request guidance already ships).
- **User/environment-actionable — new blocked path**: destination dirty, base drifted,
  merge conflicts. Criteria pass + only these blockers → append durable supporting event
  `merge.readiness.blocked {blockers, mergeReadiness}` + projection, REMAIN in
  `verifying`, do NOT increment remediation, CLI outcome `integration_blocked` (distinct
  exit code, prints blockers + exact manual commands). New CLI `harness recheck RUN_ID`:
  re-runs ONLY the git probe against the SAME immutable Verification/binding (worktree
  re-validated first); ready → ingest T24 now; still blocked → updated blocked event.
  `wrong commit` is neither: it means the tree moved under us → typed orchestration
  error (loud), not a waitable blocker.
- **Probe absence = typed orchestration error** (caller bug — production always supplies
  the probe), replacing Wave-1's fail-safe-blocked. Update the Wave-1 tests that asserted
  probe-absent→T23 to assert the typed error instead (deliberate correction, note it).
- T23's PLAN wording narrows to: criteria failed/unproven OR agent-actionable readiness
  blockers (worktree-dirt). Conformance updated. Mixed blockers (agent + user) → T23
  (remediation must run anyway; user blockers re-probe next round).

### W2-3 Pause spine (pushback items 9, 7, 5 — crash-safe by construction)
- **`pauseForLimit` transaction** (§12.2-conformant, item 9): (1) write + fsync the
  mechanical checkpoint artifact to CAS (`incomplete_operation` honestly set); (2) ONE
  atomic append: T4 (or T16) + `checkpoint.recorded{hash}` + `limit.incident.recorded` +
  durable stop-intent, active generation marked `stopping`; (3) THEN cancel/dispose the
  child (transport ladder); (4) append generation-matched `child.stopped`. Crash after
  (1): artifact unreferenced → invisible + GC'd (§12.2 already guarantees). Crash after
  (2): restart sees committed stop-intent → identity-verified cleanup (§14) → appends
  `child.stopped`; run is durably paused with incident + checkpoint. Extend the
  write-path for this composite atomic append if needed.
- **Classification precedes retry** (item 7): every provider-call failure (pin attempts
  AND prompt turns) is classified FIRST: `usage_limit` → pauseForLimit (T4 family, via
  the current operation: initial_config_pin or prompt_turn); `unknown_provider_error` →
  pauseForLimit as T16 (kind unknown; NEVER feeds the breaker — test); auth/protocol →
  typed failure path; child-death → T13 (interrupted). ONLY a non-limit configuration
  rejection gets W1-F8's single pin retry. Rework `#enforceRolePins` accordingly.
- **Pending/active dispatch split** (item 5): before any spawn, persist the intended
  role round (RoleRoundProjection, W2-5) as `pending` while the workflow REMAINS at its
  previous stable phase; create/initialize/pin; only after pins succeed: advance the
  workflow phase, mark the round `active` (child.spawned). A non-limit pin failure
  closes the candidate and leaves the pending round retryable by `run`/`resume` (typed
  error still returned; no phase advanced, nothing stranded). Coordinator, implementor,
  and verifier dispatches all follow this shape.
- Parsed-tier text patterns remain DISABLED (corpus gate unmet — structured + 429 +
  unknown only). Code comment + PLAN note.

### W2-4 Durable schedule + probes (pushback items 3, 4, 8)
- Pure scheduler `src/scheduler/limit-schedule.ts`: `computeResumePlan(incident,
  probeEvents, runConfig, now)` → `resume_now | probe_at{at, rung, probeIndex} |
  ladder_exhausted`. Deadlines anchor to EVENT timestamps (incident/T10 times), never
  `now`-relative on restart (item 3). Ladder from the PER-RUN pinned config (W1-F5's
  RUN_CONFIG_PROJECTION). Cap renamed **`maxProbesPerIncident`** (default 6) with
  permanent per-incident exhaustion documented — honest and simple; a sliding 24h window
  is deliberately rejected complexity (schema + PLAN §13 wording updated). Jitter
  deterministic from (runId, probeIndex) hash. `ladder_exhausted` → remain paused,
  notify; manual resume always available.
- **Fenced probe claims** (item 4): a durable probe-attempt claim keyed
  `(runId, incidentId, probeIndex)` is written before probing and is the idempotency key
  for the resulting T9/T10/inconclusive event — two concurrent `run --wait`/`resume
  --wait` processes cannot double-probe a rung or double-count T10.
- **Probe execution**: fresh throwaway session on the SAME profile, pinned to the SAME
  model/effort as the role it would resume, minimal prompt, classify, close. DEVIATION
  from pushback item 3 (retain-the-candidate), with rationale: under this architecture
  every work round is a fresh session, so a fresh probe session pinned identically IS
  equivalent evidence to "the actual successor session"; retaining it would thread a
  live session through the runRole seam for no additional proof. Item 3's real defects
  are fixed instead: identical pinning, and the non-limit probe failure path.
- **Probe outcome classification** (item 3): OK → T9 (mode scheduled_probe). Limit
  envelope → T10, next rung. ANY other failure (auth/protocol/crash/budget/unknown) →
  durable supporting event `limit.probe.inconclusive {classifiedKind, detail}`: run
  STAYS paused, automatic probing STOPS (no T10 increment, never the breaker), status
  surfaces the error, manual `resume` remains. Conformance: inconclusive is legal under
  `paused_limit` (it is a supporting event, not a T16 — T16 requires suspension=none and
  MUST NOT be reused here).

### W2-5 Resume re-entry (pushback items 2, 8, 11)
- **`RoleRoundProjection`** (generic across coordinator/implementor/verifier, item 11):
  {round, role, serialized role inputs, spec/base binding, exact implementationCommit
  (verifier), checkpoint ref, stage: pending|active|completed, intended completion
  advance}. Written at dispatch (W2-3), updated at completion; the resume path is driven
  ENTIRELY from this projection + checkpoint (never from in-memory loop state).
- **Resume eligibility — one transactional check BEFORE T9/T12/interrupted-resume**
  (item 8): assignment open + non-stale AND `checkpoint.specHash == assignment.specHash
  == engine approvedSpecHash == current draft.specHash`. Any mismatch → typed refusal
  WITHOUT clearing suspension (a superseded spec can never resurrect an old round).
- **Worktree adoption, role-specific** (item 2): persist worktree facts (assignment,
  path, branch, baseSha) at creation. Resume: adopt via the manager (mutex + §16.3
  validation). Interrupted IMPLEMENTOR stage → WIP-commit-or-reset reconciliation
  (recorded). Interrupted VERIFIER stage → adopt, force back to the persisted
  implementationCommit, DISCARD verifier-created dirt, assert clean, restart
  verification on the SAME immutable binding; checkpointed passed criteria carry over
  ONLY when their evidence is bound to the same spec/base/implementation commit.
  `worktreeClean` is always RE-PROBED after adoption, never carried from a checkpoint.
- **Loop re-entry**: `runImplementVerifyLoop` gains a resume mode driven by
  RoleRoundProjection (enters at implementing/verifying/needs_remediation, adopts the
  worktree, does NOT create a new one). `runCoordination` equally re-enterable: a
  coordinator pause during `start` or the W1-F7 revision re-run resumes the coordinator
  round and, on completion, stores the draft + advances specifying→awaiting_approval
  (item 11). ONE shared LimitPausedError policy handler serves start/spec-revise/run.
- **CLI**: `run` on pause: policy `wait` (default) runs the schedule loop in-process
  (injectable clock/timer); `--no-wait` exits code 3 with resume instructions. `resume`
  = eligibility check + immediate re-entry attempt; `--wait` = schedule loop.
  `recheck` per W2-2. `status`/`--json` limit block: {incident{provider, kind, source,
  confidence, at}, resumesAt: ISO|'unknown', etaSource: retry_after|unknown,
  probes{used, max, nextAt|null, inconclusive?}, policy} — the word `unknown`, never an
  invented countdown.

### W2-6 Supervision wiring (pushback item 10)
- `RoleAdapterHandle` exposes a captured `ProcessIdentity` {pid, pgid, startTime,
  executablePath, generationId, spawnNonce} (the transport already stamps
  HARNESS_SPAWN_ID).
- `ProcessRegistryStore` backed by the durable SQLite projection layer; registry
  identity persisted BEFORE `child.spawned` commits. Startup reaping: only persisted,
  identity-VERIFIED generations (§14); nonce re-verified where the platform allows
  reading child env (macOS/linux best-effort); verification unavailable → withhold the
  signal and surface the §14 alert (never kill on ambiguity).
- Watchdog (RSS budget from run config) + 60s heartbeat wired in runRole for every
  spawn; T21 soft-warn and T22 hard-limit paths ingest through the service (T22
  graceful-checkpoint-stop by deadline else emergency kill → worktree TAINT).

### W2-7 Fake adapter + tests (exit gate)
- Fake scenarios: limit envelope on turn N (Claude structured / Codex structured / 429 /
  unknown shapes); limit during initial pinning; probe scripts (still-limited ×k → OK;
  and a non-limit auth failure → inconclusive); child-death mid-turn; delayed
  `child.stopped` from a prior generation (must not clear the new one).
- Tests: **24 matrix** — pause→resume e2e for implementor AND coordinator AND
  revision-coordinator rounds (fake clock; checkpoint recorded; clean stop; ZERO
  respawns; honest `unknown` ETA; scheduled probe T10 then T9; re-entry completes to
  merge_ready). **Crash-injection** at every boundary: after checkpoint-write /
  after atomic append / before child.stopped / after probe claim / after T9 before
  spawn / after spawn before ack — restart recovers idempotently every time (items 4,
  9). **21-extended** classifier matrix + agent-TEXT-never-classifies. Scheduler unit
  tests (anchoring, determinism, exhaustion, config-pinned ladder). T16-never-breaker.
  Eligibility refusals (stale assignment, superseded spec). Verifier-dirt discard on
  resume. Readiness rework: blocked event path, `recheck` → T24, probe-absent typed
  error, worktree-dirt still T23. Pin-failure classification (limit → pause; config
  rejection → one retry; auth → typed). Generation race (delayed stop). `pause`/T11
  stop-confirmed ordering.
- Exit: full suite green; typecheck/build clean; parsed-tier gate documented unmet;
  PLAN §6.2/6.3/§12.2/§13/§14/§16/§18 amendments landed; all changes unstaged.

---

## W3 — External review 2 (mid-Wave-2 snapshot) — live findings

Triage 2026-07-19: reviewer ran against a mid-Wave-2 tree (1,009 tests). Findings 1 and 7
(resume execution layer, --wait/--no-wait, structured ETA) were already landed and
adversarially verified in the final Wave-2 tree — STALE. Five findings are LIVE:

### W3-1 [P0] Verification-runner confinement (review F2)
`defaultVerificationRunner` (src/app/flows/implementor.ts ~104) runs spec verification
commands via the host shell with FULL inherited env and only a cwd. An implementor that
edits the scripts those commands invoke gets arbitrary host execution with credentials.
Fix (MVP-honest layers):
- Minimal env allowlist for the runner (PATH + the minimum node/toolchain vars needed to
  run typical test commands; NO credential-shaped vars — reuse/extend the §17.1 child
  allowlist machinery in the transport). Config override possible per-run
  (explicit allowlist additions), never a blanket inherit.
- Primary-checkout mutation guard: snapshot the PRIMARY repo state before the
  verification commands; re-check after; any drift → typed
  `verification_runner_violation`, run fails verification honestly, worktree readiness
  blocked, incident recorded. The snapshot covers HEAD, `git status --porcelain
  --ignored` (a NEW gitignored file is drift), a content manifest of the primary
  `.git/hooks` directory, and a hash of the primary `.git/config` — hooks + config are
  the SHARED git common-dir a linked worktree also reaches, so planting
  `.git/hooks/pre-commit` or rewriting `.git/config` (even from the worktree cwd) is
  detected (W3-1(b), closing the worktree→primary hook-planting RCE vector).
- Documented residual (patterns.ts-style honesty, in implementor.ts header + README
  security section): host-shell verification commands are NOT fully sandboxed in MVP —
  reads/exfiltration WITHOUT mutation are out of the mutation guard's scope, no network
  egress confinement, no OS-level sandbox; per-platform OS sandboxing (sandbox-exec /
  bwrap) is the roadmap item. The env-allowlist credential refusal (`SECRET_KEY_NAME_RE`)
  deliberately excludes bare `auth`/`key`, so `SSH_KEY`/`DEPLOY_KEY`/`AUTH`/`BEARER`/
  `COOKIE`/`SESSION_ID` cross only on explicit operator opt-in via
  `verification.envAllowlist` (opt-in heuristic caveat, never a blanket inherit). The env
  allowlist + checkout guard close the credential-theft and repo-mutation vectors the
  probe demonstrated.
- Tests: env probe (planted secret env var invisible to the runner); out-of-worktree
  write to the primary checkout detected + verification fails; normal npm-style command
  still works with the allowlist.

### W3-2 [P1] Cross-process child control (review F3)
`pause`/`cancel` from a second CLI process only append events; the live child keeps
running. Fix: those commands execute the stop through the DURABLE process registry —
identity-verified signal (§14: pid+start-time+exe+nonce; ambiguity → withhold + alert)
after appending the intent; the running process's transport observes child death and
folds the generation-matched stop honestly (already built). `cancel` escalates per the
§10.2 ladder. In-process paths (limit pause, run-owned cancel) unchanged. switch-model
stays P4b. Tests: second-process pause/cancel actually terminates a fake child;
identity-ambiguous case withholds and alerts.

### W3-3 [P1] Metadata-sink redaction (review F4, live half)
User-origin free text (goal, revision feedback, task scope, role-input serializations)
persists verbatim in events/projections. Fix: apply redactText at the single
event-append + projection-save boundary for registered free-text fields (field-level
map, not blind deep-walk of every payload — enums/ids/hashes skip). SPEC content is
already artifact-backed (artifact writes redact); ensure SPEC_DRAFT projection's
canonicalSpec passes redactText too. Update README wording to exactly match reality.
Tests: goal/feedback with planted KEY=value secret → redacted in the DB row and every
readback surface; hashes/ids untouched.

### W3-4 [P1] Coordinator completion atomicity (review F5)
`start` advances specifying→awaiting_approval, RETURNS, then saves the draft; both
draft + role-round records are projection-only. Fix: (1) order — persist the draft
(and its artifact) BEFORE the final advance; (2) replayability — the completion event
(coordinator round completed / dispatch advance) carries the draft's artifact hash +
version so replay can re-derive or at least detect a missing draft and refuse approve
with a recovery hint (`spec revise` re-drafts); (3) crash test at the window.

### W3-5 [P2] Concurrency enforcement (review F6)
Wire MaxLiveChildrenGuard into the runRole spawn path (config maxLiveChildren).
Cross-process git-op serialization: file-based advisory lease (lock dir under the
primary repo's .git, stale-lease detection via §14 identity) around worktree add/remove;
same-process mutex stays. Tests: guard refuses the N+1th spawn; two managers on one
repo serialize worktree ops; stale lock from a dead pid is reclaimed.

Exit: all five fixed + adversarially verified; full suite green; README security
section updated; everything unstaged.
