# Engine Fixes — Round 6 Closure Record (superseded by Round 7)

> Historical note: Round 6 closed A1 and R2, but startup reconciliation still
> acknowledged a registry record after a rejected T17. Round 7 mirrors the
> live barrier's commit-before-release rule on that path. See
> [`engine-fixes-round7-spec.md`](./engine-fixes-round7-spec.md) for the current
> closure record.

> **Closed (2026-07-21).** Round 6 corrected the last two live-barrier
> confirmation gaps left by the 1,603-test Round 5 gate. Identity-backed
> disposal is no longer treated as process exit, late abnormal absence cannot
> leak ownership, and startup mismatch recovery now checks the recorded PGID.
> The final gate passes 102 test files / 1,607 tests.

**Already CLOSED — do NOT regress:** C1–C4 (reject-all-drift, engine-enforced), R1 (commit-before-release + retry), A2/A3/A4/B1, the 3 original regressions, T22 replay-compat, `StopIntentCause` exhaustiveness.

## A1 — live finalization requires observed whole-PGID absence, not "disposal resolved"
The live barrier treats `handle.dispose()` resolving as process-tree exit confirmation (`service.ts:5071`, `:5080`), immediately enabling durable finalization + registry/watchdog cleanup + capacity release (`service.ts:5222`). This is invalid: adapter `close()` returns on **leader** exit without resampling the tree —
- ACP waits for leader exit, sends a final group SIGKILL, returns without resampling the PGID (`transport.ts:359`);
- Claude returns immediately if the leader already exited, regardless of descendants (`provider.ts:743`).

**Resolution:**
- For identity-backed handles, never confirm merely because disposal resolved;
  require an **observed absent PGID** (whole tree). Gate
  finalization/cleanup/release on watchdog-observed whole-tree absence.
  Startup recovery already follows this rule; mirror it in the live barrier.
- **Fix the bug-encoding test:** `supervision.test.ts:107/199` (fake disposal closes the adapter without `treeGone`) and `:462` (expects finalization immediately after disposal). Then **add a live leader-gone/descendants-alive test**: disposal resolves but the tree is NOT gone → assert NO terminal fold and NO ownership release until absence is observed.

Implemented behavior:

- Successful identity-backed disposal triggers an immediate watchdog sample,
  but only `sampleProcessTree(pgid) === undefined` confirms exit. A surviving
  descendant keeps the registry, watchdog, reservation, and concurrency slot.
- Opaque identityless handles retain their separate owned-disposal contract
  because no PGID exists to observe; failed or hung disposal remains
  fail-closed.
- The old fake was corrected to publish process-tree disappearance through its
  fake `ps` seam. A dedicated survivor case deliberately withholds that
  observation and proves that disposal alone finalizes nothing.

## R2 — late whole-tree absence must drive completion even for abnormal / no-T22 exits
After an ambiguous mismatch settles the waiter unconfirmed, a later whole-tree absence commits durable completion **only** when a stop intent exists or `completedNormally === true` (`service.ts:4811`). For an abnormal runner exit with no accepted T22: `completedNormally` stays false → ambiguity timeout abandons the waiter → later PGID absence sets `confirmed=true` → the gate (`service.ts:4816–4819`) **suppresses** `#commitGenerationShutdown` → the watchdog callback returns false and retains the entry (`service.ts:1386`, `watchdog.ts:517`). Registry/watchdog/reservation/concurrency ownership can then leak **forever**.

**Resolution:**
- Make **late whole-tree absence** drive the appropriate durable terminal outcome + cleanup + release **even after** abnormal/no-T22 waiter abandonment — do not suppress the commit once the tree is confirmed absent. Pick the correct terminal outcome for an abnormal no-T22 exit (the crash/interrupt path).
- **Add a test:** abnormal exit, no T22, ambiguity timeout, then PGID absence → ownership **released**, not leaked (`supervision.test.ts:553` currently returns normally and misses this branch).

Implemented behavior:

- The barrier records that the waiter failed closed. If a later whole-PGID
  sample proves absence and no durable stop intent or completed outcome exists,
  it applies the generation-matched T17 recovery interrupt.
- The interrupt is breaker-exempt, leaves the round resumable, and must be
  durably visible before registry/watchdog cleanup or capacity release. A
  rejected transition that leaves the generation live fails closed and retries.

## Startup reconciliation (secondary)
Startup identity-mismatch goes straight to permanent `skipped` even if the recorded PGID is independently absent (`registry.ts:476`).
- **Fix:** on startup identity-mismatch, sample the recorded PGID; if it is independently absent, reconcile/finalize appropriately instead of a permanent skip.

Resolution: startup reaping still withholds every signal and records the
identity alert, then independently samples the recorded PGID. An absent group
returns `confirmed_gone`, allowing the service to commit T17/stop recovery and
remove the registry record; a present group remains `skipped` and owned.

## Closure criteria
- [x] Identity-backed live barriers finalize/clean up/release only after
      observed whole-PGID absence, never from disposal resolution alone.
- [x] Late whole-tree absence drives a durable terminal outcome and ownership
      release, including abnormal/no-T22 waiter abandonment.
- [x] Startup identity mismatch with an absent recorded PGID reconciles rather
      than remaining permanently skipped.
- [x] Bug-encoding fakes are corrected; the live descendant-survival
      regression proves no premature fold or release.
- [x] Typecheck, production build, `git diff --check`, and the complete suite
      pass. Both SQLite drivers remain covered by the replay/integration tests.

## Trajectory
The shared root is now enforced: for identity-backed children, exit is
confirmed only when the whole process tree is observably gone, and that
observation always drives a durable outcome before ownership release. Final
verification: **102 test files / 1,607 tests**.
