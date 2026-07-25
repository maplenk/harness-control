# Source-level review of the current repository

I reviewed the public repository at current `main`, commit `481e772`. I inspected the onboarding and execution plans, the orchestration service, verifier and implementor flows, checkpoint/recovery logic, worktree provisioning, event persistence, cost accounting, and representative tests. The repository reports 3,398 tests across both SQLite drivers and a clean typecheck, but I did not independently execute that suite in this environment.

The earlier uploaded Claude HTML is only the artifact shell and iframe wrapper, not meaningful source material, so none of the findings below rely on it. 

## Revised verdict

My previous answer substantially **understated what you have already built**.

This is not an early terminal wrapper. You already have a serious orchestration kernel:

* Immutable, hash-bound specification approval
* Coordinator → implementor → independent verifier roles
* Git worktree isolation and host-read commit binding
* SQLite event log and durable projections
* Process-generation identity and process-group supervision
* Run ownership and cross-process spawn reservations
* RSS watchdogs and audited memory-budget overrides
* Usage-limit suspension, probing, failover and restart recovery
* Content-addressed evidence and checkpoint storage
* Bounded remediation
* Merge-readiness without automatic merging

That is materially stronger than most “multi-agent coding” projects. The core product direction—**governed coding runs rather than an unbounded autonomous agent team**—is correct.

The problem is different now:

> You have reached the stage where additional local hardening inside the existing architecture will create as many bugs as it fixes.

Your next bugs will come from mismatches between:

* What an event says happened and what a projection currently contains
* What an agent claims it verified and what the host can prove
* What a checkpoint records and what the current Git state legitimately became afterward
* A CLI architecture built around one run at a time and a daemon expected to manage many
* Prompt-level policy and actual adapter-level enforcement

I would fix those seams before proceeding into the serve daemon.

---

# The strongest parts

## 1. Your failure direction is correct

The repeated preference for false negatives over false positives is right. F7 rejected a correct implementation because verification could not run, but it did not manufacture a passing result. The worktree provisioning design now binds a real `node_modules` directory to committed manifests and halts before verification when it cannot prove the dependency tree.

## 2. Your Git binding is unusually disciplined

You bind together:

* Approved specification hash
* Pinned base commit
* Assignment/worktree
* Host-read implementation commit
* Verification
* Merge-readiness

You also refuse wrong-commit verification and destination drift rather than quietly rebasing assumptions. That is the right foundation for trustworthy agent work.

## 3. Process lifecycle work is real engineering

The generation-scoped shutdown ownership, process registry, identity verification, run leases, durable spawn reservations, process-group cancellation and retryable shutdown finalization are substantive. This is not “call `child.kill()` and hope.” The current service explicitly keeps supervision until process absence and durable outcome commitment have both been established.

## 4. The product shape is differentiated

The moat is not merely cross-provider support. It is the combination of:

> immutable human approval + isolated implementation + independent verification + recovery/audit + human-owned merge

That is genuinely differentiated from session multiplexers and agent farms. The planned failure and recovery screens are more strategically important than a visual workflow builder or ten additional providers.

---

# Findings to fix before trusting `merge_ready`

## P0 — Incomplete verifier turns can still produce a passing verification

Your stop-reason vocabulary includes:

```text
end_turn
max_tokens
max_turn_requests
refusal
cancelled
```

But the common role-session wrapper treats only `cancelled` as abnormal. For every other resolved stop reason—including `max_tokens`, `max_turn_requests` and `refusal`—it records `turn.completed` with outcome `completed` and proceeds with cadence handling.

The implementor is protected because its host-side adjudicator explicitly rejects any stop reason other than `end_turn`. Read-only roles are not. `runRole()` automatically assigns them `stage: completed`; the role contract does not permit coordinator or verifier adjudication.

The verifier then:

1. Buffers whatever model output arrived.
2. Parses it.
3. Checks whether all reported criterion verdicts are `passed`.
4. Does not require `stopReason === 'end_turn'`.

Therefore, a verifier that emits a syntactically complete-looking passing report and then stops with `max_tokens`, `max_turn_requests` or `refusal` can still reach `all_verified` and potentially T24.

### Fix

Make stop adjudication role-independent:

```ts
type TurnCompletion =
  | { kind: 'completed'; stopReason: 'end_turn' }
  | {
      kind: 'aborted';
      stopReason: 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
    };
```

Only `end_turn` may supply a successful flow result. Every other resolved stop must either:

* Close the round as `no_deliverable`/`unproven`, or
* Produce an explicit resumable interruption when appropriate.

Add a matrix test covering all five stop reasons across coordinator, implementor and verifier, both fresh and resumed.

This is the first fix I would make because it is a direct route to a false-positive `merge_ready`.

---

## P0 — Verification evidence is model-authored, not host-attested

The documentation repeatedly calls the verifier’s evidence independent and self-gathered. In the implementation, the verifier does have permission to run approved commands through its provider tools. But Harness Control does not independently capture and attest those executions.

The verifier flow collects only `agent_message_chunk` output, parses the model-generated JSON, and writes the model’s free-text `evidence` field to the CAS.

Then `deriveRequiredTestsPassed()` considers a command-bearing criterion satisfied when:

* The verifier says `passed`
* There is at least one evidence reference

It does not verify that the evidence reference represents:

* The exact declared command
* A host-observed execution
* Exit code zero
* The intended implementation commit
* The intended working directory
* The expected toolchain

A verifier can currently write:

```json
{
  "id": "AC-3",
  "verdict": "passed",
  "evidence": "npm test: 147 tests passed"
}
```

and the system can persist that text as evidence without proving the command was executed.

This does not mean Codex is likely to deliberately lie. It means your strongest product claim is enforced by model cooperation rather than by the host.

### Fix

Introduce a host-created `EvidenceReceipt`:

```ts
interface EvidenceReceipt {
  receiptId: string;
  runId: RunId;
  criterionId: CriterionId;

  specHash: SpecHash;
  implementationCommit: GitSha;

  command: {
    argv: readonly string[];
    cwd: string;
  };

  startedAt: IsoTimestamp;
  completedAt: IsoTimestamp;
  exitCode: number;
  launchFailed: boolean;

  stdoutArtifact?: ArtifactHash;
  stderrArtifact?: ArtifactHash;

  runner: {
    platform: string;
    nodeVersion?: string;
    sandboxMode: string;
    dependencyFingerprint?: string;
  };
}
```

The host should run the deterministic commands and produce these receipts. The verifier’s job should be to:

* Interpret receipts
* Inspect code
* Gather qualitative evidence
* Detect missing tests and flawed assertions
* Decide whether a receipt actually proves a criterion

It should not be able to create the command-execution proof itself.

That would make your moat substantially more defensible:

> Host-attested evidence, independently interpreted by a different provider.

---

## P0/P1 — Checkpoint evidence is not bound to individual criteria

`CheckpointContent` stores:

* Per-criterion states
* One global `artifactRefs` array

When a verifier resumes, every criterion marked `passed` receives the entire global evidence bundle:

```ts
carried.push({
  criterionId: c.id,
  verdict: 'passed',
  evidenceRefs: resumeFrom.evidenceRefs,
});
```

Because `deriveRequiredTestsPassed()` only checks that each passed criterion has at least one evidence ref, one unrelated evidence artifact can make multiple carried criteria appear evidenced after a restart.

The existing test demonstrates mechanical carry-forward with one passed criterion, so it does not expose the multi-criterion aliasing problem.

### Fix

Replace the split state and global evidence bundle with:

```ts
interface CheckpointCriterionResult {
  criterionId: CriterionId;
  state: CriterionCheckpointState;
  evidenceRefs: readonly ArtifactHash[];
  evidenceReceiptIds: readonly string[];
}
```

Bind every result to:

* `specHash`
* `implementationCommit`
* `criterionId`

A successor may carry only evidence belonging to that exact criterion and binding.

---

# Recovery and provisioning risks

## P1 — F8 is a real architectural recovery bug, not a minor backlog item

The repository already identifies F8 correctly.

`validateWorktree()` refuses resume whenever current HEAD differs from the last checkpoint’s HEAD.

But a legitimate implementor can:

1. Take a cadence checkpoint.
2. Continue working.
3. Commit a valid implementation.
4. Crash later.

Now HEAD has legitimately advanced beyond the cadence checkpoint, and the run is permanently refused. Your execution plan documents that this already happened.

The conceptual error is using one checkpoint for two distinct purposes:

* **Conversation/operation recovery context**
* **Authoritative Git reconciliation baseline**

Cadence checkpoints are valid for the first purpose. They are not always valid for the second.

### Fix

Create a durable host-authored commit fact:

```text
implementation.committed {
  assignmentId,
  round,
  baseCommit,
  implementationCommit,
  specHash
}
```

Commit that fact and the completed implementor-round state together.

Resume rules should then be:

* Interrupted implementor with no completed commit: reconcile against the latest relevant worktree checkpoint.
* Completed implementor re-entering verification: force to the persisted `implementationCommit`.
* Interrupted verifier: force to the verifier round’s persisted immutable commit.
* A cadence checkpoint never overrides a later host-recorded implementation commit.

I would land F8 **before the serve daemon**, not merely alongside it.

---

## P1 — F7 and the planned `web/` workspace are on a collision course

The UI plan recommends React, TypeScript and Vite in a new `web/` workspace.

F7 currently refuses any root `package.json` containing a `workspaces` key, regardless of its form.

Therefore, if “new `web/` workspace” becomes an actual npm workspace, the dogfood run will fail closed by design. If `web/` has a separate package and nested dependency tree without being a root workspace, the current root-only provisioning model can still leave its dependencies unresolved.

This is exactly the sort of mismatch that will generate another F7-shaped false negative.

### Decide before B0

Use one of these two designs:

**Option A — fastest MVP**

Keep a single root package:

```text
package.json
src/
web/
```

Place React/Vite dependencies at the root and treat `web/` as source, not a separate package workspace.

**Option B — proper long-term layout**

Implement package-manager/workspace-aware provisioning first:

* Root and child manifests
* Workspace lockfile semantics
* Nested/unhoisted dependencies
* Package-manager identification
* Per-package verification working directories

Do not casually add `"workspaces": ["web"]` and discover the conflict during verification.

---

## P1 — F7 provisioning inherits the full orchestrator environment and has no execution timeout

The verification runner deliberately builds a minimal environment, but the F7 `npm ci` path does this:

```ts
env: {
  ...process.env,
  npm_config_ignore_scripts: 'true'
}
```

and does not specify a timeout.

`--ignore-scripts` removes one attack vector, but not:

* `.npmrc` environment interpolation
* Registry credential forwarding
* Proxy credentials
* Custom registry exfiltration
* An indefinitely hanging install
* Arbitrary network access
* Global npm configuration contamination

### Fix

Give provisioning its own bounded execution environment:

* Minimal environment allowlist
* Isolated temporary `HOME`
* Isolated npm cache and user config
* Explicit registry/network policy
* `.npmrc` inspection or refusal for credential-bearing directives
* Process-group timeout and kill ladder
* Maximum output size
* Persisted installation receipt and dependency fingerprint

For a trusted self-dogfood repo, the current design is understandable. For public use against arbitrary repositories, it is not a sufficiently strong boundary.

---

# State architecture problems

## P1 — The system is event-sourced in its core state, but not in several recovery-critical states

Your `EngineState` transition path is carefully atomic. That part is strong.

But several operationally important pieces are direct last-write-wins projection saves:

* Current role round
* Implement→verify loop binding
* Blocked merge-readiness state

`saveMergeReadinessBlocked()` and `saveImplementVerifyLoopState()` directly save projections.

On the blocked-readiness path, the projection is deliberately saved first and the corresponding event is appended afterward. A crash can therefore leave:

* A recovery projection saying the run is blocked
* No matching audit event, fleet update or notification

`RoleRoundProjection` is also directly overwritten, and the service explicitly acknowledges that the atomic engine-write primitive does not cover it.

This is manageable in a serial CLI because the run-ownership lease limits concurrent writers. It becomes more dangerous once you introduce:

* Long-running daemon writes
* UI commands
* Fleet updates
* WebSocket subscriptions
* Recovery workers
* Multiple run kernels

### Fix

For every state required to recover or render control-plane truth, choose one model:

**Event-derived state**

Append a domain/application event, then project it.

or:

**Transactional operation state**

Commit the operation row, revision increment and outbox event in one SQLite transaction.

Do not maintain a third category of mutable projection that is authoritative but not fully represented in the ledger.

---

## P1 — `OrchestrationService` should not become the serve daemon

`OrchestrationService` currently owns:

* Engine config and bounds
* Database access
* Adapter creation
* Permission mediation
* Process registry
* Concurrency guard
* Durable reservations
* Run ownership
* Watchdog
* Breaker
* Checkpoint cadence
* Heartbeat scheduling
* Shutdown state
* Alerts
* Worktree-supervision attachment

The config, bounds and breaker are constructor-bound. More importantly, worktree supervision is held through one mutable `#worktreeSupervision` field described as the current manager, with one manager attached at a time.

That matches the serial CLI model. It does not match a multi-run daemon.

Do not create one global instance and let it drive several simultaneous runs.

### Direction

Split the architecture into:

```text
DaemonKernel
├── Database / migrations
├── Global process registry
├── Global spawn-capacity manager
├── Event publisher / outbox
├── RunKernelRegistry
└── Security / authentication

RunKernel
├── Pinned run config and bounds
├── Run ownership
├── State writer
├── Role executor
├── Recovery planner
├── Worktree context
├── Checkpoint service
├── Failover service
└── Cost ledger
```

The existing Phase A0 application-command executor is the right next architectural move, but it should sit on this split rather than merely wrapping the current CLI handlers. The UI plan is already correct that `src/serve/` must be an execution/application layer, not a thin HTTP adapter.

---

# Smaller correctness traps worth fixing now

## Duplicate criterion rows silently overwrite one another

`parseVerifierReport()` stores reports in a `Map`, so duplicate IDs are last-write-wins. A response containing:

```json
[
  {"id":"AC-1","verdict":"failed"},
  {"id":"AC-1","verdict":"passed","evidence":"looks good"}
]
```

ends as `passed`.

Reject the entire report on:

* Duplicate IDs
* Unknown IDs
* Missing requested IDs
* Unexpected extra fields where relevant

Use an exact schema and require one row per requested criterion.

## Event idempotency checks type but not payload identity

When an idempotency key already exists, the repository rejects a different event type but silently accepts the same type even when the new payload differs.

That can conceal a caller bug or corrupted retry.

Persist a canonical payload hash. Same key plus different payload should return `CONFLICT`, not a successful dedupe.

## Event cursor semantics are easy to misuse

`fromSequence` is inclusive and implemented using `sequence >= ?`.

The planned browser protocol wants resume-after-cursor semantics. Expose an explicitly named exclusive API:

```ts
listAfter(runId, lastSeenSequence)
```

implemented as `sequence > ?`.

Do not make each WebSocket client remember to add one.

## Out-of-order cost updates can overcount

For cumulative session cost:

1. Previous amount = 10
2. Late update arrives with amount = 8
3. No cost is added, but baseline is set backward to 8
4. Next amount = 11
5. Delta 3 is added instead of delta 1

The fold assumes monotonic gauges but stores the lower value anyway.

Store:

```ts
nextBaseline = Math.max(previous, incoming)
```

Also reject or separately record currency changes within one session.

## Prompt policy and permission policy disagree

The implementor prompt now explicitly says not to run verification commands.

But `ImplementorFlow.allowedShellCommands` is still populated from those exact verification commands and passed to the adapter.

That means “implement and stop” is prompt steering, not a host invariant.

Make the implementor’s verification-command allowlist empty. The host runner and verifier should own those commands. Maintain a separate, narrowly defined read-only inspection vocabulary when a provider needs it.

---

# Where you will keep getting bugs unless the pattern changes

| Recurring bug class                     | Current pattern                                       | Structural correction                                  |
| --------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| A run resumes from the wrong place      | Checkpoint used as both context and Git authority     | Separate context checkpoints from committed-work facts |
| “Green” verification without proof      | Model-authored evidence treated as execution evidence | Host-attested receipts                                 |
| Crash leaves confusing state            | Direct projection save plus later event               | Transactional event/outbox or event-derived projection |
| One fix breaks another failure path     | Lifecycle logic concentrated in one large service     | Per-run kernel and smaller stateful services           |
| Provider edge case becomes success      | Non-exhaustive handling of semantic enums             | Exhaustive adjudication at one boundary                |
| Daemon exposes stale fleet state        | Mutable projections not revisioned atomically         | Server-owned snapshot revision/outbox                  |
| Dogfood fails after UI topology changes | Provisioner understands one package shape             | Lock package topology or implement workspace support   |

---

# Direction I would steer

## Before the daemon

Land these in order:

1. **Stop-reason correctness** for coordinator and verifier.
2. **Host-attested verification receipts.**
3. **Criterion-bound checkpoint evidence.**
4. **F8 recovery correction.**
5. **Exact verifier-report schema**, including duplicate-ID rejection.
6. **F7 package-topology decision**, provisioning timeout and environment isolation.

I would not begin the expensive serve-daemon slices before the first four are landed.

## During Phase A0

Use Phase A0 to create a genuinely application-neutral executor:

```ts
executeApplicationCommand(
  command,
  actor,
  idempotencyKey,
  dependencies
): Promise<OperationResult>
```

It should not return CLI text or consume `NodeJS.ProcessEnv`. The current `executeCommand()` still combines application behavior, CLI presentation, environment and exit-code policy.

The CLI and HTTP server should both become renderers/adapters around the same operation API.

At the same time:

* Create per-run kernels
* Add versioned operation records
* Add an outbox for committed event publication
* Add exclusive cursor APIs
* Add fleet revisioning from server-owned projections

## Then build the UI

The UI order in your plan is mostly right:

1. Read-only fleet/snapshot/event tail
2. Connection and recovery state
3. Exact-spec approval through the shared executor
4. Permission interactions
5. Failure/recovery screens
6. Diff/evidence inspection
7. Terminal takeover
8. Electron last

Do not pull PTY brokerage or Electron forward. They add considerable lifecycle complexity but do not validate your core product thesis.

---

# Product-level opinion

## Keep the governed-verification positioning

Your best product is not:

> A UI to run multiple coding agents.

It is:

> A local control plane that makes coding-agent work approvable, independently verifiable, recoverable and auditable.

The five failure screens and evidence views are more strategically valuable than a graph editor.

## Stop treating “zero hand-written UI” as the definition of done

The execution plan currently defines success partly as building the entire UI through the harness with zero manually written UI.

That is a useful dogfood benchmark. It is not a product requirement.

It can create distorted decisions:

* Preserving weak automation paths merely to keep the experiment pure
* Spending more on remediation than the feature is worth
* Refusing surgical human fixes that would teach you more quickly
* Optimizing the engine for self-modification rather than for users’ repositories

Track two separate outcomes:

**Product done**

The UI is usable, trustworthy and recoverable.

**Dogfood score**

What percentage of the implementation was completed through a legitimate governed run.

Do not let the second definition control the first.

## Codex review should be a pressure test, not the safety boundary

The repository repeatedly calls Codex the “load-bearing quality mechanism.”

The same repository documents that:

* Green tests encoded wrong behavior
* Review rounds repeatedly missed later defects
* Supplying prior reviews caused Codex to echo stale findings and inspect the wrong commit

Adversarial LLM review is valuable, but the safety hierarchy should be:

1. Host-enforced invariants
2. State-machine/property tests
3. Fault injection and crash-window tests
4. Real dogfood runs
5. Independent LLM review

Not the reverse.

## Freeze provider expansion

Claude, Codex and Grok are sufficient to prove the product. Do not add more providers until:

* `merge_ready` has host-attested evidence
* Resume is trustworthy
* The daemon handles multiple runs correctly
* The UI can explain every blocked state

More adapters would multiply your test matrix without improving the core proposition.

## Be explicit about the trust model

Today this is a **trusted local repository, trusted local user, macOS-oriented MVP**. Host-shell verification is not filesystem- or network-confined; your own comments correctly acknowledge that commands can read and exfiltrate anything the orchestrator user can access.

That is acceptable for self-dogfood when clearly labelled. It is not yet a safe generic runner for arbitrary cloned repositories.

Eventually expose explicit modes:

```text
trusted-local
sandboxed-local
remote-isolated
```

Never imply the first provides the guarantees of the second.

---

# Bottom line

**Continue building it. The direction is good, and the engine is far more substantial than I initially understood.**

But stop adding surface area temporarily.

Your next milestone should not be “serve daemon exists.” It should be:

> A `merge_ready` result is impossible unless the role ended successfully, every passed criterion has criterion-bound host-attested evidence, and the run can recover from any supported crash window without confusing an old checkpoint with newer committed work.

My exact priority order would be:

1. Verifier/coordinator stop semantics
2. Host-attested evidence receipts
3. Criterion-bound checkpoint evidence
4. F8
5. Package topology and F7 isolation
6. Per-run kernel plus application executor
7. Read-only serve slice
8. UI write actions
9. PTY and Electron
10. Additional providers

That sequence preserves what is distinctive about Harness Control instead of letting the UI and daemon harden around verification and recovery assumptions you already know are incomplete.
