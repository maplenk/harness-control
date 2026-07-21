# Engine Fixes — Round 7 Closure Record

> **Closed (2026-07-21).** Startup reconciliation now mirrors the live
> barrier's commit-before-release invariant. A rejected T17 leaves the matching
> live generation's registry record intact and retryable. The final gate passes
> 102 test files / 1,608 tests.

Round 6 closed A1 and R2. Round 7 addressed the one remaining startup mirror
of R1's commit-before-release invariant.

**Already CLOSED — do NOT regress:** A1, R2, R1 (live barrier), A2/A3/A4/B1, F1–F3, C1–C4, T22 replay-compat, `StopIntentCause` exhaustiveness.

## The hole
Startup identity-mismatch with an absent recorded PGID correctly returns `confirmed_gone` (`registry.ts:476`). But the service then **ignores the T17 `IngestResult` and unconditionally removes the sole registry retry record** (`service.ts:4613`, `:4620`). If durable state changed between the earlier read and the ingest — e.g. a raced `T4` left the generation `stopping`/live so the T17 transition **rejects** — the registry record is deleted **without a committed terminal recovery outcome**, and the only retry path is lost. This is the same commit-before-release invariant R1 enforces in the live barrier, missing on the startup path.

## Fix
- After the startup T17 / stop-recovery ingest, **reload the generation's durable state** and remove the registry record **only if** the durable state proves it stopped. If T17 was rejected or the generation remains live, **retain** the registry record and retry (fail-closed).
- Mirror the live-barrier R1 discipline exactly: the durable terminal-outcome commit **precedes** registry/ownership removal; a rejected/failed commit retains ownership and stays retryable.
- Anchors: `service.ts:4613`, `:4620`.

## Implemented behavior

- Every startup stop/recovery branch reloads the durable engine projection
  after ingest/finalization.
- The registry record is acknowledged only when the recorded generation is
  stopped, absent, or no longer the run's active generation.
- If the same generation remains `spawning`, `active`, or `stopping`, the
  record remains owned so a later startup pass can retry.
- This check uses durable post-ingest state rather than assuming that a
  non-throwing `ingest` committed; `transition.rejected` is therefore handled
  fail-closed.

## Test
- Add a **rejected-T17-leaves-generation-live startup test**: startup mismatch + absent PGID, but T17 rejects (raced live generation) → registry record **retained** (not removed), retryable. The existing happy-path test (`supervision.test.ts:1402`) and rejected-T17 test (`:1487`) do not couple rejection to registry retention — cover that coupling.

Implemented regression: T4 is injected after startup reads an active child but
before it emits T17. T17 rejects against the now-paused/stopping generation;
the test proves the registry record remains. A second startup pass confirms
the durable stop intent and only then removes the record.

## Closure criteria
- [x] Startup T17/stop reconciliation removes the registry record only after durable state proves the generation reconciled; otherwise it retains + retries.
- [x] A rejected-T17-leaves-generation-live startup test proves registry retention and successful later reconciliation.
- [x] Typecheck, production build, `git diff --check`, and the complete suite pass, including both SQLite drivers.

## Final verification

The corrected complete suite passes **102 test files / 1,608 tests**. Round 7
changes no public contract and introduces no new lifecycle subsystem; it
applies the existing durable-outcome-before-release rule to startup recovery.
