# Engine Fixes — Completion Status

> **Round 7 closure (2026-07-21).** Round 6 closed the live-barrier A1/R2
> defects. The [Round 7 review](./engine-fixes-round7-spec.md) found the same
> commit-before-release invariant missing from one startup T17 path. Startup
> reconciliation now retains its registry retry record until durable state
> proves the generation reconciled. No detached-checkout subsystem was
> introduced: the completed F5 policy rejects all primary-checkout drift.

| Fix | State | Result |
|---|---|---|
| **F1** RSS lifecycle | ✅ complete | Durable T22 v2 intent, observed whole-PGID exit confirmation, replay-safe legacy compatibility, and fail-closed ambiguous exits |
| **F2** deliverable gate | ✅ complete | Implementor adjudication is mandatory and verifier dispatch cannot bypass `no_deliverable` |
| **F3** budget resume | ✅ complete | `set-budget --resume` raises, resumes, and drives durable re-entry before reporting success |
| **F4** per-role memory | ✅ complete | Per-role budgets retain their existing precedence and compatibility behavior |
| **F5** pinned source | ✅ complete | Reject-all-drift is enforced at service boundaries and every fresh worktree receives the exact durable pin |
| **F6** shutdown ownership | ✅ complete | Disposal cannot confirm an identity-backed exit; late absence commits recovery before cleanup/capacity release |

## F1 + F6 — Durable RSS lifecycle and shutdown ownership

- New `rss.hard_limit` events carry `semanticsVersion: 2`; legacy events with
  no version retain their historical reducer behavior.
- `StopIntentCause` includes `resource_exhaustion`, with one exhaustive
  cause-to-confirmation switch and compile-time `never` enforcement.
- T22 v2 marks the matching generation `stopping`. Confirmed exit appends the
  `resource.exhausted` facts, closes an active turn as `resource_exhausted`,
  marks its role round `no_deliverable`, and records the alert/notification in
  one immediate transaction. It never enters the T13 crash/restart path.
- Emergency signaling identity-verifies first, synchronously persists T22 v2
  through the pre-signal hook, then sends SIGKILL and taints the worktree. An
  identity mismatch sends no signal and persists no false RSS termination.
- A rejected graceful or emergency T22 write triggers no checkpoint/cancel,
  dispose, signal, or taint side effect. The graceful watchdog state is rolled
  back so a later tick can retry.
- Graceful-stop work is detached from watchdog sampling. Hung callbacks do not
  prevent later samples or deadline escalation. If durable T22 persistence
  fails, the watchdog rolls the generation back out of `graceful_pending` so a
  later tick retries instead of latching an unarmed stop.
- A single per-generation barrier owns the bounded cancel path and memoized
  disposal for RSS and provider-limit stops. For identity-backed handles,
  disposal resolution triggers a watchdog resample but never confirms exit;
  only observed whole-PGID absence permits finalization. A dead group leader
  with live descendants remains `exit_pending` with all ownership retained.
  Opaque identityless handles keep their separate owned-disposal contract
  because no process identity or PGID exists to sample.
- The barrier commits the generation's durable terminal outcome before it
  removes supervision or releases reservation/concurrency ownership. Commit,
  cleanup, or reservation-release failure retains a retry path and continues
  to count against capacity.
- Identityless children have no registry/startup recovery path, so their
  bounded cancel, exit-confirmation, and durable-outcome retry timers remain
  referenced. Failed or hung disposal therefore settles fail-closed instead of
  letting normal process exit silently skip shutdown work.
- Startup SIGKILL delivery is not treated as exit confirmation. The durable
  registry record remains owned and `resume` reports `orphan_exit_pending`
  until a later process-group sample independently observes the whole tree
  gone.
- If an ambiguity timeout first fails the live waiter closed, a later absent
  PGID still commits the appropriate durable outcome. An abnormal/no-T22
  generation takes the breaker-exempt T17 recovery-interrupt path before
  cleanup and capacity release, so retained ownership cannot leak forever.
- Startup identity mismatch still withholds signaling and records its alert,
  but now samples the recorded PGID. Independently observed absence is
  reconciled as `confirmed_gone`; a present tree remains skipped and owned.
- A startup T17/stop-recovery ingest is not assumed to have committed merely
  because it returned without throwing. The service reloads durable engine
  state and removes the registry record only when the recorded generation is
  stopped, absent, or superseded. A rejected T17 that leaves it live retains
  the sole retry record.
- Startup recovery reconciles T22 v2 directly and forward-reconciles legacy
  T22-only histories only when matching generation and stopped-process facts
  make the conclusion provable. Reconciliation is idempotent.
- The natural `end_turn` race is preserved: a turn that completed before the
  stop took effect remains completed; idle, cancelled, or verified emergency
  termination becomes `resource_exhausted`.

## F2 — Deliverable and verifier invariants

- `RoleRunner` is role-discriminated. Implementors require
  `adjudicateRoundOutcome`; coordinator and verifier runners cannot supply it.
  A runtime guard covers JavaScript, casts, and direct callers. Dispatchless
  and standalone implementor entry points are adjudicated too; they cannot
  bypass `no_deliverable` by omitting round-dispatch metadata.
- A committed result must include `commitSha` exactly equal to the host-read
  worktree HEAD. Only a clean round-one zero-diff no-op may proceed without a
  commit; no-commit remediation rounds are rejected.
- Adjudication executes inside the protected role-flow boundary. Host HEAD
  failures record a recoverable T17 interrupt and the same round can resume.
- Every verifier spawn checks the persisted role-round projection based on the
  runner role, independent of optional dispatch metadata. The public workflow
  transition guard remains as defense in depth.
- Cancelled/resource-exhausted turns do not count checkpoint cadence and cannot
  complete a role round. Non-RSS cancellation and `no_deliverable` persist
  atomically, so a late normal return cannot overwrite the result.

## F3 + F4 — Budget behavior

- Per-role memory budgets remain supported with the global fallback.
- `set-budget --resume` is asynchronous and shares the same T12 plus
  `driveReentry` composition as `harness resume`.
- `raised_and_resumed` is returned only after durable re-entry completes. If
  flow dependencies are unavailable, the CLI reports the durable raise and a
  pending/unavailable re-entry instead of claiming success.

## F5 — Strict pinned-source policy

The explicit design choice is strict primary-checkout rejection. No detached
checkout lifecycle subsystem was added.

- `start` canonicalizes the repository root, resolves full `HEAD^{commit}`, and
  requires an empty porcelain status before creating a run. Non-git, unborn,
  unresolvable, or dirty workspaces create no run.
- The shared pinned-workspace guard rejects `workspace_unresolvable`,
  `workspace_dirty`, or `base_drift` before and after coordination/revision
  and re-entry, before approval, and before the first fresh implementation
  worktree.
- Any source edit during coordination invalidates that result. The operator
  restores a clean primary checkout at the pinned HEAD and re-enters the same
  round. Ignored build/cache files remain outside this Git dirty-state policy.
- Fresh worktree APIs require a branded full `GitSha` named `baseCommit`.
  Missing, symbolic, short, unresolvable, or mismatched values are rejected at
  runtime; `baseRef` fallbacks are removed.
- Production `createRun` requires that exact full pin at both the type and
  runtime boundary. The public production legacy creator is removed; an
  explicitly test-only, production-build-excluded fixture models old metadata.
- The one-time audited pin remains only for already-persisted legacy runs.
- Source-sensitive service methods perform the guard themselves, so direct
  callers cannot bypass the CLI checks. Both the standalone implementor entry
  and the implement/verify loop also compare their supplied base exactly with
  the run's durable pin before creating a worktree.

## Compatibility and verification

- Full replay fixtures prove old T22 logs reproduce their historical
  projections on both SQLite drivers.
- The `StopIntentCause` confirmation mapping is exhaustive: its compile-time
  `never` default and serialized-cause table both include
  `resource_exhaustion`, so a future enum widening fails typecheck until every
  confirmation behavior is defined.
- Recovery coverage includes legacy T22-only, legacy T22 plus an existing
  confirmation, T22 v2 plus confirmation, mixed histories, and repeated
  startup recovery.
- The suite covers identity mismatch, graceful idle/cancelled/emergency paths,
  signal-delivery versus observed-absence recovery, restart between intent and
  confirmation, T22 persistence retry, identityless disposal failure,
  shutdown races and hung callbacks, standalone adjudicator/runtime bypasses,
  verifier direct calls, host-HEAD resume, budget re-entry, source drift at
  every boundary, and strict worktree bases.

Typecheck, the production build, and `git diff --check` pass; the corrected
complete suite passes **102 test files / 1,608 tests**. The Round 6 regressions
cover disposal with live descendants, abnormal/no-T22 late absence and
capacity release, and startup identity mismatch with an absent recorded PGID.
Round 7 additionally covers a raced T4 that makes startup T17 reject, proving
the registry record remains until a later durable stop confirmation. No
detached-checkout subsystem or destructive event migration was introduced.
