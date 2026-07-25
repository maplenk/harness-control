# Operator-Mediated Auto-First Implementor Permissions — v2 (host-executed escalation)

**Status:** design draft, 2026-07-25. Supersedes v1. Land in `docs/` at the next LAND gate → codex spec review → executor implement → codex diff gate.

**Decision applied (user, 2026-07-25):** above-baseline operations are **host-executed**, not re-requested through the provider's native tool. v1's queued-grant→successor-generation→re-request→digest-match machinery is deleted.

---

## 1. Shape

- Every implementor keeps its provider's auto-first baseline (already shipped; §3).
- Above-baseline operations are rejected on the wire and enter a durable **permission wait**.
- The human operator — never a coordinator agent — decides, inline (attached) or via CLI (detached).
- On grant, **the host performs the operation itself** in the assigned worktree, from a strict argv grammar, with no shell. The successor generation is told it was done.
- No broker tool, no MCP passthrough (D5 intact), no provider auto-reviewer, no global bypass. The host stays the only authority for commits, verification, and now approved mutations.

### Why host-executed
The approved set is exact, reversible, worktree-local file operations. The host already owns an isolated command runner with credential-env refusal (`implementor.ts:242`) and already owns commits and verification. Executing the operation host-side removes: grant→generation binding, cross-generation reuse rules, exact-operation-text re-request matching, per-provider queued escalation plumbing, and the Claude-native gap (works identically with no permission channel).

### The residual operation set is smaller than v1 assumed
Structured `Write` creates missing parent directories (already asserted in the implementor prompt, `implementor.ts:822`), so `mkdir` and `touch` are already achievable; `cp` is Read+Write. The operations that are **genuinely impossible** with the structured verbs Grok exposes (`Write`, `Edit` — no delete) are:

- **`mv SRC DST`** — rename/move
- **`rm PATH`** — remove a single tracked path

`mkdir`/`cp`/`touch` stay in the grammar (harmless, cheap), but `mv`/`rm` are the load-bearing entries. This is also why v1's "scoped mkdir/cp/mv/touch" framing understated the need and overstated the risk surface.

---

## 2. Host-executed operation contract

### 2.1 Grammar (the only thing the host will ever run)
A pending request becomes **host-executable** only if its operation text reduces to exactly one of:

```
mkdir [-p] PATH
touch PATH
cp [-R] SRC DST
mv SRC DST
rm PATH                    # single path; -r/-f NEVER accepted in v1
```

Rules, all fail-closed:
- Parsed to a fixed argv and spawned **without a shell** (`spawn(cmd, args, {shell:false})`). No `bash -c`, no expansion, no globs, no redirection, no compound syntax, no heredoc, no substitution. Any of those → not host-executable.
- Exactly the flags listed. Any other flag → not host-executable.
- Every operand resolves **inside the canonical assigned worktree** by the same nearest-existing-ancestor + `path.relative` containment check already used for structured writes (`acp/session.ts:isWorkspaceWriteOperation`, `:nearestExistingAncestor`), rejecting traversal and symlink escape. Reuse that code; do not re-derive it.
- Operand count is exactly the grammar's arity (no multi-source `cp`/`mv`, no path lists).
- `rm` refuses a directory and refuses a path matching `(^|/)(\.git|node_modules)(/|$)`.
- Env: the verification runner's credential-refusing env policy (`VerificationRunnerEnvError`), cwd = the worktree, no inherited provider env.

Not host-executable ⇒ the request is **not grantable**. The operator's only options are deny, or (attached) deny with a note; the agent is told to report a blocker. This is what keeps "the host parses arbitrary shell" from sneaking back in.

### 2.2 Single-shot execution
`mv`/`cp`/`rm` are not idempotent. Execution is bound to one durable record: the decision and the `permission.operation.executed` outcome ride **one atomic engine write**. A second execution for the same request id is refused structurally, so a crash between the decision and the spawn re-drives at most... nothing: if the write is absent the operation never ran; if present it never runs again. Where the spawn itself is the crash window, the record carries `attempted` before `completed`, and an `attempted`-without-`completed` record is a **hard deny on re-entry** (reported to the operator, never silently retried).

### 2.3 Execution failure
A non-zero exit, a spawn failure, or a containment rejection is recorded, treated as a denial, and surfaced to the operator verbatim (redacted). The wait resolves; the agent is told the operation was refused, not performed.

### 2.4 Approval tier for grammar operations — permissive default (decision applied: user, 2026-07-25)
`permissions.grammarTier: 'auto-host' | 'operator'`, **default `'auto-host'`**.

- **`auto-host` (default — the permissive environment):** a request whose operation reduces to the §2.1 grammar and passes every §2.1 rule is **host-executed immediately, no operator involved** — recorded with the same atomic `permission.operation.executed` event, checkpoint `WorktreeState` re-write, and single-shot discipline as an operator grant (decision vocabulary value `auto_grant_host_execute`). The run never waits for anything the grammar can prove safe. Operator review (`permission_wait`) fires ONLY for requests the grammar/containment cannot prove — and the permanent-deny classifier (§3.1) still refuses outright regardless of tier.
- **`operator`:** every above-baseline request waits for the human, as in §4. For hostile-implementor or shared-repo contexts. W4-1: both values act.

Net posture under the default: **allow by default; ask only for the unprovable; deny the destructive.** What is ALWAYS blocked, in every tier, with no override: `rm -r`/`-f` and any multi-path or directory deletion; any path touching `.git/` or `node_modules/`; anything outside the worktree; git history/remote mutation (force-push, hard reset, destructive clean, hooks/config); privilege escalation, credential access, network egress/publishing; opaque evaluators (`bash -c`, `eval`, `python -c`, `node -e`, substitutions, heredocs); package managers and build/test execution (host-owned). Single-path `rm`, `mv`, `cp`, `mkdir`, `touch` inside the worktree are exactly the safe set — with one added rule: **`cp`/`mv` refuse an existing destination** (no-clobber, fail-closed; a genuine overwrite is expressed as `rm` then `mv`, each auditable). One pending wait per generation (the post-wait lockdown implies it; stated here for conformance).

---

## 3. Provider baselines (all shipped — this plan changes none of them)

| Provider | Baseline (already in tree) | Above-baseline review |
|---|---|---|
| Grok | implementor `auto` + `strict` sandbox (`grok/capabilities.ts:28-42`), structured edits, read-only shell classifier, project-MCP refusal, web/subagents off | `inline_operator_review` attached / `queued_operator_review` detached. Grok's `auto` **does** escalate — slice-1a runs 2/3 hit the compound-shell permission trap. |
| Codex | isolated `CODEX_HOME`, `workspace-write` for implementor (`codex/home-isolation.ts:96`), `approvals_reviewer='user'` (`:81`) | same two modes, via native ACP requests |
| OpenCode | `*=ask`, `read/glob/grep=allow`, `edit=allow` **implementor-only**, `task=deny` (`opencode/home-isolation.ts:83-88`) | same two modes |
| Claude **(ACP, claude-agent-acp)** | session mode pinned `default`, **never `auto`** — `auto` writes outside cwd without ever sending `session/request_permission` (`claude/capabilities.ts:55-70`, P2 gate P-1) | `inline_operator_review` / `queued_operator_review`. **Not auto-first, by design.** |
| Claude **(native subscription)** | `acceptEdits`, Read/Glob/Grep/Edit/Write, Bash denied (`claude/provider.ts:100-105`) | `no_dynamic_review` — no permission channel. Reports a blocker; host-executed grants are unavailable because there is no request to grant. |

Capability reporting: `inline_operator_review | queued_operator_review | no_dynamic_review`, per provider **and transport** — the two Claude adapters differ, so one Claude row is wrong.

### 3.1 Shared deny classifier
The permanent-deny list is **one** module consumed by every provider's native deny rules and by the host-executability check. Four per-provider copies will drift. Contents unchanged from v1 (privilege escalation; credential/keychain/SSH access; uploads, remote shells, publishing, deployment, delegation; writes outside the worktree; shared git config/hooks/remotes, force-push, hard reset, destructive clean, broad deletion; opaque evaluators). Note several entries are already structurally impossible (worktree escape via the sandbox + `workspaceWriteRoot`; delegation via `conflictingBuiltinTools` / `task:deny`) — the classifier is defense in depth, not the primary control.

---

## 4. Lifecycle, events, transitions

### 4.1 Attached (inline)
Interactive mediation is **net-new wiring**: `PermissionMediation.onRequest` exists in the type (`role-runner.ts:42-43`) and the service maps it (`service.ts:5798-5799`), but no CLI path ever sets it — every run today is `DEFAULT_HEADLESS_MEDIATION` deny-all (`service.ts:1025`, `:1515`). Add: a TTY prompt surface on attached `harness run`, wired to `mode:'interactive'`, with a non-TTY fallback to the queued path.

Inline decisions select **`allow_once` or `reject_once` only**. `acp/session.ts:1095-1099` currently prefers `['allow_once','allow_always']` and will pick `allow_always` when `allow_once` is absent — drop it. **[VERIFIED at 481e772, 2026-07-25: the preference array is literally `['allow_once','allow_always']` and `pickOption` falls through to `allow_always`; this is a live standing bypass — a provider omitting `allow_once` receives a PERSISTENT grant today. Also verified: `DEFAULT_HEADLESS_MEDIATION` (`service.ts:1025`) is the value at every construction site (`:1515`, `:2709`, `:4372`, `:4395`) and the interactive path (`:5799`) is unreachable without `mediation.onRequest` — no CLI sets it, exactly as this section states.]** A provider offering no `allow_once` therefore yields `cancelled` (turn refused); a per-provider smoke must prove `allow_once` is actually offered.

Inline grants may **either** select `allow_once` (the provider's own tool runs it) **or** route to host execution. Prefer `allow_once` inline when the operation is within the provider's sandbox; use host execution when it is not, or when the operation is not expressible for that provider.

### 4.2 Detached (queued) — corrected transition shapes
Add `permission_wait` to `SUSPENSION_KINDS` (`domain/state.ts:39-52`). Ripple is small: `projections.ts`, `service.ts`, `domain/{state,transitions,events}.ts` — no persistence enum (suspension is stored as JSON projection). Add the `uiStateOf` case (`projections.ts:455-470`) → `waiting_on_you`.

**T26 `permission.wait.requested`** — follows the **T11 stop-intent pattern**, not an inline fold:
- preconditions: `operation_in:['prompt_turn']`, `suspension_in:['none']`, `child_active:true`
- effects: reject the wire call (`reject_once`); write the mid-turn WIP checkpoint; record a **durable generation-bound stop intent** and mark the generation stopping
- `suspension=permission_wait{returnPhase, inFlightOperation, enteredAt}` folds **only** on the generation-matched `child.stopped`
- invariants: `phase_unchanged`, `never_counts_toward_breaker`, `restart_counters_unchanged`

v1's "checkpoint WIP, safely stop the generation, retain the phase" as a single fold would produce `suspension=permission_wait` with a live child, contradicting T11 and the conformance invariants.

**Post-wait lockdown (new rule):** the instant a wait is recorded, `decidePermission` returns `deny` for **every** subsequent request in that generation. Without this, the agent keeps working between the reject and the confirmed stop and can fall back to a destructive-but-permitted path (e.g. a whole-file `Write`) that the workspace-write rule allows.

**T27 `permission.wait.resolved`**:
- preconditions: `suspension_in:['permission_wait']`
- effects: record the decision + execution outcome; clear the wait; `initiate_resume` (the T9/T12 `resume_reentry_pending` spine)
- invariants: `phase_unchanged` (resume returns to `returnPhase`)

Internal decision vocabulary: `operator_grant_host_execute`, `operator_grant_inline_once` (attached only), `operator_deny`. No collision with ACP's `allow_once`. Denials hold for the current round to stop re-prompt loops.

Missing metadata, unparseable operation, non-host-executable grammar, timeout, ownership failure, persistence failure ⇒ **deny**.

### 4.3 The wait checkpoint must not commit — and that is load-bearing
`CheckpointReason` is a closed union (`checkpoint/cadence.ts:25-29`) and the only writer is `#writeStopCheckpoint` at prompt-turn boundaries (`service.ts:3983`, `:4064`). Add reason `pre_permission_wait` and a mid-turn write path.

**AC:** the wait checkpoint records the dirty worktree honestly (`headSha` + `statusPorcelain` + `diffHash`) and **nothing commits between the wait and re-entry**. §16.3 then reconciles `HEAD == checkpoint.headSha` with matching porcelain/diffHash → `clean` (`worktree/validate.ts:22-45`). A WIP *commit* would move HEAD past the checkpoint and land in the open **F8** refusal, making every permission wait an unresumable run.

**Corollary:** host execution mutates the worktree *after* the checkpoint was written. Re-entry therefore reconciles against a checkpoint whose `statusPorcelain`/`diffHash` no longer match → `wip_committed` (a commit! → F8). **Fix:** re-write the wait checkpoint's `WorktreeState` in the same atomic write as `permission.operation.executed`, so the recorded state matches post-execution reality. This ordering is mandatory, not an optimization.

### 4.4 Ownership
`DurableRunOwnershipStore.acquire` is a pid-keyed CAS (`run-ownership-store.ts:96-142`), so a separate `harness permission grant` process **cannot** acquire the lease while the owner lives. v1 asserted the impossible. Resolution: **the owner releases at the wait**, exactly like `pause`. The wait is a durable stop; the owning process exits; `harness permission grant` acquires the lease, binds the decision, executes, releases; `resume` re-enters as a fresh owner. Any ownership conflict denies.

### 4.5 Re-entry payload
The successor generation is told what happened, in the prompt, the way remediation rebuilds its payload from the durable T23 record (`cli/commands.ts:1869`, `:1896`): a `hostPerformedOperations` block listing each executed operation and its outcome, plus each denial with its reason. The agent does not re-request; it continues from the new tree state.

### 4.6 CLI
```
harness permission list  RUN_ID
harness permission grant RUN_ID REQUEST_ID     # host-executes; refuses non-grantable
harness permission deny  RUN_ID REQUEST_ID [--reason TEXT]
```
Additive to the command union (`cli/commands.ts:207-243`) — no collision. `list` shows, per pending request: operation text, host-executability verdict (and why not, if not), provider, role, round, worktree.

---

## 5. Execution ownership (unchanged intent, one live fix)

- Implementors edit only; they do not commit and do not run declared build/test commands.
- **`implementor.ts:883`** — `this.allowedShellCommands = resolveVerificationCommands(context)` is the one live misalignment: the prompt forbids the commands (`:818-826`, landed as `b9ca10c`), the allowlist grants them. Set it to `[]`. Keep the commands in the prompt's `commandsBlock` (`:795`, `:809`) as context. Ripple: `factory.ts:581` empties the Grok allow set, leaving the read-only classifier + `workspaceWriteRoot`; Claude native already gives implementors `[]` (`provider.ts:109`).
- Verifier keeps its exact per-criterion shell permissions (`verifier.ts:374`).
- Host paths stay authoritative: `addAll`/`addAllExceptNodeModules` + `commitAll` (`implementor.ts:973-978`) and the host verification runner (`:1019-1050`). Note both the host self-check **and** the verifier agent run the declared commands — that is intended, and the prompt is already accurate about it.
- Git mutation, build/test execution, and package-manager execution remain host-owned and are never grantable, even to host execution.

---

## 6. Sequencing (this plan is not first)

1. **F10 gates everything.** `addAllExceptNodeModules` (`worktree/git.ts:222`) is fatal under git 2.55 whenever an ignored `node_modules` exists — which F7 now guarantees in every worktree. Every implementor commit in every slice fails. No permission work can produce a green end-to-end run until F10 lands (with F8/F9, already on the executor branch).
2. **Characterize, independently:** (a) which operations Grok's `auto` self-approves vs escalates — this determines how often operator review actually fires; (b) `allow_once` availability per provider; (c) Codex `features.shell_tool` — the string appears **nowhere** in the tree, so this is a from-zero characterization and must not gate anything else. **[VERIFIED at 481e772: `grep -rn shell_tool src/` returns 0 hits — (c) is genuinely from-zero. Under §2.4 `auto-host` (the default), (a) matters less than v1 assumed: grammar-provable operations execute without any review, so escalation frequency only bounds the residual unprovable tail.]**
3. Then this plan: shared deny classifier → `allowedShellCommands=[]` → `allow_always` removal → T26/T27 + suspension kind + checkpoint reason → host executor → CLI → inline TTY surface.
4. **Delivery gate:** a fresh slice-1a run (Run 1 abandoned — base 8 commits behind main + §16.3; runs 2/3 cancelled). Drive it through edits → host commit → host verification → verifier verdict → `merge_ready`. Honor the repo freeze: no tracked-file edits or commits from `start` until the run is terminal.

---

## 7. Tests

Domain/engine:
- T26/T27 rows in the generated `§6.3` conformance suite; historic `T20` replay semantics unchanged.
- T26 stop-intent: suspension folds **only** on the generation-matched `child.stopped`; a stale-generation stop is a no-op.
- Post-wait lockdown: every subsequent request in the waiting generation denies.
- `permission_wait` → `uiStateOf` → `waiting_on_you`.

Host executor:
- Grammar: each accepted form; every rejected form (extra flags, `rm -r`, multi-operand, glob, redirection, compound, heredoc, substitution, `bash -c`).
- Containment: traversal, symlink escape, `.git`/`node_modules` targets, nearest-existing-ancestor resolution.
- Single-shot: crash between decision and spawn; `attempted`-without-`completed` is a hard deny.
- Failure paths: non-zero exit, spawn failure, credential-shaped env refusal.

Round-trip:
- Wait checkpoint → host execution → checkpoint `WorktreeState` re-write → `resume` yields `clean` from `validate.ts` (never `wip_committed`).
- Ownership: grant while another live process owns the run → denied; owner-released → grant succeeds; concurrent grant race.
- Duplicate decisions, decision after round change, decision after cancel, timeout, denial persistence for the round.
- Re-entry payload carries executed operations and denials.

Provider smokes:
- Grok: auto edits, safe inspection, escalation reaches the wait, harmful operation denied by the shared classifier.
- Codex: isolated approval routing; `shell_tool` characterization recorded.
- OpenCode: auto edit + native ACP escalation.
- Claude ACP: `default` mode pin holds, escalation reaches the wait. Claude native: `acceptEdits`, Bash denied, honest `no_dynamic_review`.
- `allow_once` offered by every escalating provider.
- No project/user MCP server or plugin leaks into any child.

Gates: typecheck, production build, full offline suite (real suite is 103 files / 1699 tests — beware leftover `.claude/worktrees` doubling), isolation smokes, `git diff --check`, then the **codex adversarial diff review** (green ≠ correct). Commit and push only after every gate passes; the user does the push.

---

## 8. Open items

- Inline grants: allow the operator to choose `allow_once` vs host execution, or always host-execute for uniformity? Draft says operator chooses, defaulting to `allow_once` when the operation is inside the provider's sandbox. (Under §2.4 `auto-host`, inline choice only arises for non-grammar requests.)
- Wait timeout default (v1 left it unspecified). Proposal: no timeout for a detached wait — a wait is a durable stop, and an expiring wait silently discards operator intent. Attached inline prompts time out to `reject_once`.
- `rm` of a directory stays out of v1. Revisit only with evidence from a real slice.
- §2.4 tests to add alongside §7: grammar-conforming request under `auto-host` executes with zero operator interaction and full event trail; the same request under `operator` waits; non-grammar request under `auto-host` still waits; permanent-deny classifier fires identically in both tiers; no-clobber refusal on existing `cp`/`mv` destination.
