# Engine Fixes — Round 5 Closure Record (superseded by Round 6)

> Historical note: Round 5 closed its stated findings, but its 1,603-test gate
> still treated identity-backed disposal as live exit confirmation. Round 6
> corrected that test-encoded bug and the related late-absence leak. See
> [`engine-fixes-round6-spec.md`](./engine-fixes-round6-spec.md) for the current
> closure record and [`engine-fixes-status.md`](./engine-fixes-status.md) for
> final verification.

> **Closed (2026-07-21).** Round 5 began as a correction to the premature
> Round 4 completion claim. The implementation now closes A1, R1, R2, and
> C1–C4 below. This file preserves the Round 5 findings and implemented
> resolution; it is no longer the authoritative final lifecycle status.

## A1 — confirm exit by whole process-tree absence

The review found that `confirmed_gone` was derived from the process-group
leader alone. A dead leader with live descendants could therefore finalize
T22 prematurely.

Resolution:

- Startup recovery and live supervision confirm exit only after observing the
  entire process group absent. A missing leader with live descendants remains
  `exit_pending` and retains ownership.
- Sending SIGKILL and resolving an identity-backed disposal are not exit
  confirmation. Registry, watchdog, reservation, and concurrency ownership
  remain until whole-PGID absence is observed. Only identityless opaque
  handles use successful owned disposal as their separate confirmation
  contract.
- Recovery tests cover the leader-gone/descendants-alive case and require no
  premature `resource.exhausted` finalization.

## R1 — durable outcome commits precede ownership release

The review found that a finalization failure could still allow cleanup and
capacity release, leaving a durably `stopping` generation without a live retry
path.

Resolution:

- The generation barrier first commits the terminal outcome, then removes the
  registry/watchdog records, and releases reservation/concurrency ownership
  last. A failure at any stage retains the remaining ownership and is
  retryable.
- Confirmed-but-uncommitted outcomes have a memoized retry path. For an
  identityless handle, the retry timer remains referenced because no process
  registry or watchdog can recover it after the host exits.
- Reservation release is part of barrier completion rather than a swallowed
  best-effort cleanup. A failed release remains retryable and still counts
  against capacity.

## R2 — ambiguous or opaque exits remain fail-closed

The review found that emergency mismatch/gone and opaque disposal failures
could remove supervision or leave an unresolved waiter with no liveness path.

Resolution:

- Identity mismatch sends no signal and persists no T22 v2, stopped-child,
  taint, or `resource.exhausted` fact. Identity-backed ambiguous processes stay
  watched until whole-tree absence is observed.
- Identityless cancellation and exit-confirmation deadlines remain referenced;
  identityless durable-outcome retry timers do as well. The CLI therefore
  cannot normally exit while its only shutdown/recovery path is pending.
- Provider-limit shutdown uses the same generation barrier as RSS shutdown:
  one bounded cancel path, one memoized disposal, exit confirmation, durable
  outcome commit, cleanup, and capacity release.
- A rejected graceful or emergency T22 persistence attempt launches no cancel,
  dispose, signal, or taint side effect. A failed graceful persist rolls
  `graceful_pending` back so a later watchdog tick can retry.

## C — reject-all-drift is consistent and engine-enforced

Round 5 retained the explicit strict-rejection design. Coordination runs in
the primary checkout; no detached-checkout mutex or lifecycle subsystem was
introduced.

### C1 — fresh runs require a durable pin at the service boundary

- Production `createRun` requires an exact branded full `GitSha` and also
  validates the value at runtime for JavaScript/cast callers.
- The old public production legacy-run creator was removed. Tests model old
  databases through an explicitly test-only fixture excluded from the
  production build.
- The one-time audited pin path remains available only when an already-
  persisted legacy run lacks a base commit.

### C2 — every source-sensitive service boundary refuses drift

- The shared service-layer guard takes a stable HEAD/status snapshot, rechecks
  HEAD to close the in-check race, and rejects unresolvable, dirty, or drifted
  workspaces.
- Initial coordination, coordinator completion, revision, coordinator
  re-entry, approval, and first fresh implementation worktree creation all use
  the same guard. Legacy-unpinned runs are audited and pinned once rather than
  skipping it.

### C3 — approval reports stable structured drift details

- Approval is asynchronous and applies the same source guard, including for
  legacy runs.
- Refusals expose `workspace_unresolvable`, `workspace_dirty`, or `base_drift`
  with pinned/current SHAs and dirty paths where available; human output shows
  both SHAs.

### C4 — exact pinned bases reach every fresh worktree entry

- Coordinator re-entry receives the durable `baseCommit`; exploration
  artifacts no longer persist a null base for a pinned run.
- Fresh worktree APIs accept `baseCommit: GitSha` only and reject missing,
  symbolic, short, unresolvable, or mismatched values.
- Both the standalone implementor entry point and the implement/verify loop
  compare their supplied `baseCommit` with the run's durable pin before
  creating a worktree.

## Compatibility closure

- T22 v2 supplies the durable, generation-bound RSS stop semantics.
- T22 without `semanticsVersion` stays on the historical replay reducer branch;
  recovery forward-appends confirmation facts only when generation and stopped-
  process evidence makes reconciliation provable.
- Legacy-only, legacy-plus-confirmation, v2, and mixed histories are covered for
  idempotent replay/recovery on both SQLite drivers.
- `StopIntentCause` includes `resource_exhaustion`; the exhaustive confirmation
  switch has a compile-time `never` default, and the contract table covers every
  serialized cause.

## Closure criteria

- [x] Reject-all-drift is enforced at start, revision/re-entry, approval, and
      worktree admission at the engine boundary.
- [x] Identity-backed exit confirmation requires observed whole-PGID absence;
      only identityless opaque handles may use successful owned disposal.
- [x] Durable finalization precedes cleanup and capacity release, with retryable
      failure paths.
- [x] Ambiguous and identityless shutdown paths stay fail-closed and live.
- [x] T22 replay compatibility and `StopIntentCause` exhaustiveness are covered.
- [x] Round 5 audit closed its stated scope; Round 6 later corrected the
      remaining live-barrier confirmation assumptions.

The historical Round 5 gate passed 102 test files / 1,603 tests. It was
superseded by the corrected Round 6 gate recorded in
[`engine-fixes-status.md`](./engine-fixes-status.md).
