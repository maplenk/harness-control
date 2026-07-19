/**
 * Restart breaker (PLAN.md §14 "Restarts/breaker"):
 *
 *   "window bound (default 5/10min, configurable 3|5|8) AND non-disableable
 *   per-assignment lifetime cap (default 10) AND no-progress detection
 *   (identical checkpoint content-hash across 2 consecutive restarts →
 *   breaker). `off` exists only behind an explicit `--unsafe-dev` flag and
 *   retains the lifetime cap. Exponential backoff between restarts; max
 *   elapsed recovery time (default 30min) → breaker. Limit-pauses never
 *   count (T4/T16)."
 *
 * `../domain/transitions.ts`'s T13 (`interrupt_on_child_exit` effect, W2-1)
 * FOLDS window/lifetime as a pair of simple MONOTONIC counters
 * (`EngineState.counters`, reset only by an explicit T15 `breaker reset`) —
 * history this module and P4b's bounded respawn read; the engine itself
 * makes no restart/breaker decision on T13. The monotonic fold is correct
 * for the LIFETIME cap (which really is "N restarts, ever, until a human
 * intervenes"), but not a true "N restarts in the last M minutes" SLIDING
 * window: the pure, timer-free engine has no way to decay an old
 * restart back out of the count as real time passes (`EngineConfig`'s
 * `restarts.windowMinutes` field — `../config/schema.ts` — exists for
 * exactly this and, prior to this module, had no consumer anywhere in the
 * codebase). This module is that consumer: it tracks each assignment's
 * restart timestamps itself (from each input's own `occurredAt` — no live
 * `Clock` reference needed here, exactly like `applyTransition` itself) and
 * decides `window_bound` from a genuinely time-decayed count, independent of — and MORE PERMISSIVE
 * than — the engine's own non-decaying counter can ever be. Lifetime is
 * deliberately NOT re-tracked independently here: `evaluateCrash` takes the
 * CALLER-supplied authoritative `RestartCounters` (read from the durably
 * persisted `EngineState` projection) as the single source of truth for
 * `lifetimeRestarts`, so a restarted orchestrator can never "forget" restarts
 * that happened before it crashed — a fresh in-memory window tracker
 * starting empty after an orchestrator restart is a SAFE direction to err in
 * for the window bound specifically (it only ever makes the window check
 * MORE permissive, never less), whereas the same amnesia for the
 * non-disableable lifetime cap would not be safe, hence reading it from the
 * caller instead of tracking it here.
 *
 * `no_progress` and `max_elapsed_recovery` are information the engine has NO
 * way to know regardless of decay (checkpoint content hashes; wall-clock
 * recovery-sequence duration) — this module is authoritative for both.
 *
 * Whenever window/lifetime/no-progress/max-elapsed trips, `evaluateCrash`
 * returns a ready `restart.exhausted` (T14) trigger DIRECTLY — T14 has no
 * preconditions and opens the breaker with whatever `reason` its payload
 * carries, so this module can drive all four reasons uniformly, bypassing
 * T13 entirely. When NONE trips, it returns a ready
 * `child.exited.unexpectedly` (T13) trigger. W2-1 (P4a): the amended T13
 * only FOLDS the counters, marks the generation stopped, and suspends
 * `interrupted` — manual resume required, zero auto-respawns; the `restart`
 * advice kind (attempt/backoff bookkeeping) is retained as the P4b
 * bounded-respawn machinery this module already computes, and the engine
 * no longer makes any breaker decision of its own on T13 (supervision —
 * this module — owns exhaustion; the reducer only folds).
 *
 * Exponential backoff is a THIRD, independent piece of local bookkeeping
 * (real-time delay before actually respawning — the synchronous, timer-free
 * engine cannot own this either).
 *
 * "Limit-pauses NEVER count" (T4/T16) holds here BY CONSTRUCTION: a limit
 * pause stops the child CLEANLY (§13) via an entirely different event
 * family and is never routed through `evaluateCrash` — there is no code
 * path in this module a limit pause could reach. `breaker.test.ts` asserts
 * this explicitly against the real transition engine.
 */
import type { IsoTimestamp } from '../lib/clock.js';
import type { IdFactory } from '../lib/id-factory.js';
import { newIdempotencyKey, type ArtifactHash, type AssignmentId, type RunId, type SegmentId } from '../domain/ids.js';
import { draftEvent, type EventOfType } from '../domain/events.js';
import { DEFAULT_BOUNDS, type EngineBounds, type RestartCounters } from '../domain/state.js';
import { DEFAULT_ENGINE_CONFIG } from '../config/schema.js';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------
export interface BreakerBounds {
  /** Real sliding-window span for the window-bound check (§14 default 10min; single source of truth: `EngineConfig.restarts.windowMinutes`). */
  readonly windowMinutes: number;
  /** Elapsed time since the recovery sequence's first crash beyond which a NEW crash opens the breaker outright (§14 default 30min). */
  readonly maxElapsedRecoveryMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly backoffFactor: number;
}

export const DEFAULT_BREAKER_BOUNDS: BreakerBounds = {
  windowMinutes: DEFAULT_ENGINE_CONFIG.restarts.windowMinutes,
  maxElapsedRecoveryMs: 30 * 60 * 1000,
  backoffBaseMs: 1_000,
  backoffMaxMs: 5 * 60 * 1000,
  backoffFactor: 2,
};

/** Referenced by tests/callers wanting the canonical lifetime cap without importing `../domain/state.ts` themselves. */
export const NON_DISABLEABLE_LIFETIME_CAP = DEFAULT_BOUNDS.lifetimeRestartMax;

export type RestartExhaustedReason = 'window_bound' | 'lifetime_cap' | 'no_progress' | 'max_elapsed_recovery';

// ---------------------------------------------------------------------------
// Inputs / outcomes
// ---------------------------------------------------------------------------
export interface RestartAttemptInput {
  readonly runId: RunId;
  readonly assignmentId: AssignmentId;
  /** Required: `child.exited.unexpectedly` (T13) always names the segment that crashed. */
  readonly segmentId: SegmentId;
  readonly occurredAt: IsoTimestamp;
  /** Content hash of the checkpoint most recently recorded for this assignment, if any (§14 no-progress detector input). */
  readonly latestCheckpointHash?: ArtifactHash;
  readonly exitCode?: number;
  readonly signal?: string;
  readonly classifiedAs?: 'crash' | 'nonzero_exit' | 'clean_exit_unexpected';
  /**
   * Current AUTHORITATIVE counters — read by the caller from the durably
   * persisted `EngineState` projection. This module is never the source of
   * truth for `lifetimeRestarts` (see module doc); it only reads it here.
   */
  readonly counters: RestartCounters;
}

export type BreakerAdvice =
  | {
      readonly kind: 'restart';
      readonly attempt: number;
      readonly backoffMs: number;
      /** Feed into `applyTransition` (T13). */
      readonly triggerEvent: EventOfType<'child.exited.unexpectedly'>;
    }
  | {
      readonly kind: 'breaker_open';
      readonly reason: RestartExhaustedReason;
      /** Feed into `applyTransition` (T14) — unconditional; bypasses the engine's own counters entirely. */
      readonly triggerEvent: EventOfType<'restart.exhausted'>;
    };

interface RecoverySequenceState {
  attemptsInSequence: number;
  recoverySequenceStartedAt: IsoTimestamp;
  lastCheckpointHash: ArtifactHash | undefined;
}

// ---------------------------------------------------------------------------
// Pure backoff computation (unit-testable with no clock/timer involved)
// ---------------------------------------------------------------------------
export function computeBackoffMs(attempt: number, bounds: BreakerBounds = DEFAULT_BREAKER_BOUNDS): number {
  const exponent = Math.max(0, attempt - 1);
  const raw = bounds.backoffBaseMs * bounds.backoffFactor ** exponent;
  return Math.min(raw, bounds.backoffMaxMs);
}

/** Real-timer wait helper for the `backoffMs` a `restart` advice returns. Trivial by design — tests exercise `computeBackoffMs` instead of waiting through real backoff delays. */
export function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Breaker
// ---------------------------------------------------------------------------
export class RestartBreaker {
  readonly #ids: IdFactory;
  readonly #bounds: BreakerBounds;
  readonly #engineBounds: EngineBounds;
  readonly #sequences = new Map<AssignmentId, RecoverySequenceState>();
  readonly #windowTimestampsMs = new Map<AssignmentId, number[]>();

  /**
   * No `Clock` dependency: exactly like `applyTransition` itself, every
   * timing decision derives from `input.occurredAt` (which the CALLER
   * already stamped from its own clock) rather than from a live clock
   * reference held here — deterministic given its inputs, nothing hidden.
   */
  constructor(
    ids: IdFactory,
    bounds: BreakerBounds = DEFAULT_BREAKER_BOUNDS,
    engineBounds: EngineBounds = DEFAULT_BOUNDS,
  ) {
    this.#ids = ids;
    this.#bounds = bounds;
    this.#engineBounds = engineBounds;
  }

  /** Current in-sequence attempt count for `assignmentId` (0 if no active recovery sequence is tracked). Exposed for observability/tests. */
  attemptsInSequence(assignmentId: AssignmentId): number {
    return this.#sequences.get(assignmentId)?.attemptsInSequence ?? 0;
  }

  /** Time-decayed restart count within the current window, as of `asOf` (does not mutate tracked state). Exposed for observability/tests. */
  windowCountAsOf(assignmentId: AssignmentId, asOf: IsoTimestamp): number {
    return this.#prunedWindow(assignmentId, Date.parse(asOf)).length;
  }

  /**
   * Call when an assignment achieves real forward progress (e.g. a
   * checkpoint whose hash differs from the prior one, or the segment
   * reaches a stable/completed state) — clears the no-progress/elapsed-time
   * bookkeeping so a LATER, unrelated crash starts a fresh recovery
   * sequence instead of inheriting stale history. The window-timestamp
   * deque is deliberately NOT cleared here: "N restarts in the last M
   * minutes" should keep counting real restarts that happened in that span
   * even if one of them was followed by transient progress — only actual
   * time decay or an explicit `reset()` (T15) removes a window entry.
   */
  recordProgress(assignmentId: AssignmentId): void {
    this.#sequences.delete(assignmentId);
  }

  /** T15 `breaker reset` (user): clears ALL local bookkeeping (window + no-progress/elapsed-time). The non-disableable lifetime cap lives in the caller-supplied `EngineState.counters`, untouched by T15 — this module never resets it because it never owns it. */
  reset(assignmentId: AssignmentId): void {
    this.#sequences.delete(assignmentId);
    this.#windowTimestampsMs.delete(assignmentId);
  }

  /**
   * Evaluate one crash/unexpected-exit for `input.assignmentId`, checking
   * (in order) lifetime cap → time-decayed window bound → no-progress →
   * max-elapsed-recovery. The FIRST condition that trips returns a ready
   * T14 trigger (unconditional breaker-open); if none trip, returns a ready
   * T13 trigger for the engine's own counters to apply normally.
   */
  evaluateCrash(input: RestartAttemptInput): BreakerAdvice {
    const nowMs = Date.parse(input.occurredAt);

    if (input.counters.lifetimeRestarts >= this.#engineBounds.lifetimeRestartMax) {
      return this.#breakerOpen(input, 'lifetime_cap');
    }

    const window = this.#prunedWindow(input.assignmentId, nowMs);
    window.push(nowMs);
    this.#windowTimestampsMs.set(input.assignmentId, window);
    if (window.length > this.#engineBounds.restartWindowMax) {
      return this.#breakerOpen(input, 'window_bound');
    }

    const existing = this.#sequences.get(input.assignmentId);
    const state: RecoverySequenceState = existing ?? {
      attemptsInSequence: 0,
      recoverySequenceStartedAt: input.occurredAt,
      lastCheckpointHash: undefined,
    };
    state.attemptsInSequence += 1;

    const noProgress =
      input.latestCheckpointHash !== undefined &&
      state.lastCheckpointHash !== undefined &&
      input.latestCheckpointHash === state.lastCheckpointHash;
    state.lastCheckpointHash = input.latestCheckpointHash ?? state.lastCheckpointHash;

    const elapsedMs = nowMs - Date.parse(state.recoverySequenceStartedAt);
    const maxElapsedExceeded = elapsedMs > this.#bounds.maxElapsedRecoveryMs;

    this.#sequences.set(input.assignmentId, state);

    if (noProgress) return this.#breakerOpen(input, 'no_progress');
    if (maxElapsedExceeded) return this.#breakerOpen(input, 'max_elapsed_recovery');

    return {
      kind: 'restart',
      attempt: state.attemptsInSequence,
      backoffMs: computeBackoffMs(state.attemptsInSequence, this.#bounds),
      triggerEvent: this.#childExited(input),
    };
  }

  #prunedWindow(assignmentId: AssignmentId, nowMs: number): number[] {
    const spanMs = this.#bounds.windowMinutes * 60_000;
    const existing = this.#windowTimestampsMs.get(assignmentId) ?? [];
    return existing.filter((ts) => nowMs - ts <= spanMs);
  }

  #breakerOpen(input: RestartAttemptInput, reason: RestartExhaustedReason): BreakerAdvice {
    return { kind: 'breaker_open', reason, triggerEvent: this.#restartExhausted(input, reason) };
  }

  #childExited(input: RestartAttemptInput): EventOfType<'child.exited.unexpectedly'> {
    return draftEvent({
      type: 'child.exited.unexpectedly',
      runId: input.runId,
      payload: {
        segmentId: input.segmentId,
        classifiedAs: input.classifiedAs ?? 'crash',
        ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
      },
      idempotencyKey: newIdempotencyKey(this.#ids),
      occurredAt: input.occurredAt,
    });
  }

  #restartExhausted(input: RestartAttemptInput, reason: RestartExhaustedReason): EventOfType<'restart.exhausted'> {
    return draftEvent({
      type: 'restart.exhausted',
      runId: input.runId,
      payload: { reason },
      idempotencyKey: newIdempotencyKey(this.#ids),
      occurredAt: input.occurredAt,
    });
  }
}
