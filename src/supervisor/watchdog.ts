/**
 * Memory watchdog (PLAN.md §14 "Watchdog").
 *
 * "RSS of full process tree sampled 5s adaptive → aggregated projection.
 * Budget default 1024MB: soft 75% → warn event + notify; 100% → graceful
 * path (mechanical checkpoint + stop) under deadline (default 30s); hard
 * emergency ceiling (default 150% of budget) → immediate SIGKILL → worktree
 * TAINTED (§16.3). Watchdog termination participates in the worktree mutex:
 * while a segment holds a git-op lease, kill waits for op completion or the
 * emergency ceiling (which taints)."
 *
 * Three thresholds, edge-triggered per target:
 *   ratio ∈ [soft, 1.0)   → `rss.soft_threshold` (T21) once per crossing.
 *   ratio ∈ [1.0, hard)   → `rss.hard_limit{escalation:'graceful'}` (T22)
 *                           once; asks the caller (`requestGracefulStop`) to
 *                           request a mechanical checkpoint + clean stop;
 *                           if the process tree is still alive when
 *                           `memory.gracefulStopDeadlineMs` elapses, escalates
 *                           to the same emergency-kill path below.
 *   ratio >= hard          → immediate emergency kill, no grace, no lease
 *                           wait — the ceiling always wins.
 *
 * `rss.soft_threshold`/`rss.hard_limit` are built as READY `DomainEvent`s
 * handed to `onEvent` (mirrors `../checkpoint/writer.ts`'s "returns a ready
 * event; does not append it" contract) — the caller feeds them through
 * `applyTransition` + `appendTriggerWithEffects` (`../domain/transitions.js`,
 * `../persistence/write-path.js`), which is where the T22 `rss_hard_stop`
 * effect's OWN `checkpoint.requested`/`segment.stop.requested`/
 * `worktree.tainted` bookkeeping actually lands in the durable log. The
 * DIRECT `worktreeTaint.markTainted(...)` call this module also makes on an
 * emergency kill is a SEPARATE, more immediate signal for the exact same
 * fact — see `../worktree/manager.ts`'s own doc comment: "Pure bookkeeping —
 * the transition engine independently emits the DOMAIN event... this only
 * gates THIS manager's own reuse operations." Both are needed: the event is
 * the durable log; the direct call is what makes `GitWorktreeManager`
 * refuse to reacquire the lease before the event has even been persisted.
 *
 * `GitOpLeaseObserver`/`WorktreeTaintSink` are minimal STRUCTURAL interfaces
 * (duck-typed against `../worktree/manager.ts`'s `GitWorktreeManager` —
 * `awaitGitOpIdle`/`markTainted` — without this package taking a hard
 * compile-time dependency on `src/worktree/**`, which this task does not
 * own). A real `GitWorktreeManager` instance satisfies both with zero
 * adapter code.
 *
 * Every kill goes through `registry: VerifiedSignaler`
 * (`./registry.ts`'s `ProcessRegistry.signalVerified`) — never a raw
 * `process.kill` — so identity re-verification-before-signal (§14 bullet 1)
 * applies uniformly across the whole supervisor, not just orphan reaping.
 */
import type { Clock } from '../lib/clock.js';
import type { IdFactory } from '../lib/id-factory.js';
import { newIdempotencyKey, type AssignmentId, type ProcessGenerationId, type RunId, type SegmentId } from '../domain/ids.js';
import { draftEvent, type DomainEvent, type EventOfType } from '../domain/events.js';
import type { RoleName, WorktreeTaint } from '../domain/state.js';
import { BYTES_PER_MB, DEFAULT_ENGINE_CONFIG, type MemoryConfig } from '../config/schema.js';
import { createPsClient, type PsClient, type ProcessTreeSample } from './ps.js';
import type { VerifiedSignaler } from './registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export interface WatchdogTarget {
  readonly runId: RunId;
  /** Identity-registry key this target's kill signals are verified against (`./registry.ts`). */
  readonly generationId: ProcessGenerationId;
  readonly pgid: number;
  readonly segmentId?: SegmentId;
  /** Needed for `WorktreeTaintSink.markTainted`; omit for worktree-less (read-only) segments. */
  readonly assignmentId?: AssignmentId;
  /** Overrides `memory.budgetMb` for this one target. */
  readonly budgetBytes?: number;
  /** F3: the spawning role — carried onto `rss.hard_limit` so the incident is
   * structured and the host can bind a generation-scoped exhaustion cause. */
  readonly role?: RoleName;
}

/** Structurally compatible with `GitWorktreeManager` (`../worktree/manager.ts`) — see module doc. */
export interface GitOpLeaseObserver {
  awaitGitOpIdle(deadlineMs: number): Promise<'idle' | 'timed_out'>;
}

/** Structurally compatible with `GitWorktreeManager` (`../worktree/manager.ts`) — see module doc. */
export interface WorktreeTaintSink {
  markTainted(assignmentId: AssignmentId, taint: WorktreeTaint): void;
}

export interface WatchdogDeps {
  readonly clock: Clock;
  readonly ids: IdFactory;
  /** Every kill is identity-verified through this (§14 bullet 1) — mandatory, never bypassable. */
  readonly registry: VerifiedSignaler;
  readonly ps?: PsClient;
  /** Defaults to `DEFAULT_ENGINE_CONFIG.memory` (§14 defaults: 1024MB budget, 75%/150% thresholds, 30s graceful deadline). */
  readonly memory?: MemoryConfig;
  /** Base sampling cadence away from danger. Default 5000ms (§14). */
  readonly sampleIntervalMs?: number;
  /** Adaptive cadence once ratio >= soft threshold — samples more often near the danger zone. Default 1000ms. */
  readonly elevatedSampleIntervalMs?: number;
  /** §14/§16.2: observe an in-flight git op for the target's repo; omit to never wait on a lease. */
  readonly gitOpLease?: GitOpLeaseObserver;
  /** Granularity of the lease-wait-vs-ceiling race. Default 250ms. */
  readonly leaseWaitPollMs?: number;
  /** §16.3 taint hook ("worktree manager provides it"). Omit to rely on the emitted `rss.hard_limit` event alone. */
  readonly worktreeTaint?: WorktreeTaintSink;
  /**
   * Called once when a target first crosses the graceful (100%) threshold.
   * Must NOT block waiting for the child to actually exit — that
   * observation happens via this watchdog's own subsequent samples/deadline
   * timer; this is only the "kick off a checkpoint + clean-stop request"
   * signal. Defaults to a no-op (the deadline will simply always be hit).
   */
  readonly requestGracefulStop?: (target: WatchdogTarget, sample: ProcessTreeSample) => void | Promise<void>;
  /** Ready `rss.soft_threshold`/`rss.hard_limit` events for the caller to persist via `applyTransition`. */
  readonly onEvent: (event: DomainEvent) => void;
  /** Raw RSS tick sink — wire to `ProcessSampleRepository.recordRawSample` (§12.1). Defaults to a no-op. */
  readonly onSample?: (target: WatchdogTarget, sample: ProcessTreeSample) => void;
  /**
   * Durable supervision-failure alert. Invoked when a background sample tick
   * THROWS (e.g. `ps`/`execFile` blew up, not a routine "process gone"): the
   * scheduler swallows the rejection — so a throwing tick can never become an
   * unhandled rejection that crashes the host or silently kills supervision —
   * surfaces it here, and (fail-open-with-alert) reschedules the next sample
   * so supervision continues. Defaults to a no-op; a real deployment SHOULD
   * wire this to an operator-visible sink so the degradation is observable.
   */
  readonly onSupervisionFailure?: (target: WatchdogTarget, error: unknown) => void;
}

// ---------------------------------------------------------------------------
// Internal runtime state
// ---------------------------------------------------------------------------
type TargetPhase = 'normal' | 'soft_warned' | 'graceful_pending' | 'killing' | 'done';

interface TargetRuntime {
  phase: TargetPhase;
  tickInFlight: boolean;
  sampleTimer?: ReturnType<typeof setTimeout> | undefined;
  deadlineTimer?: ReturnType<typeof setTimeout> | undefined;
}

interface TargetEntry {
  readonly target: WatchdogTarget;
  readonly runtime: TargetRuntime;
}

type LeaseRaceOutcome = 'proceed' | 'ceiling' | 'gone';

// ---------------------------------------------------------------------------
// Watchdog
// ---------------------------------------------------------------------------
export class Watchdog {
  readonly #clock: Clock;
  readonly #ids: IdFactory;
  readonly #registry: VerifiedSignaler;
  readonly #ps: PsClient;
  readonly #memory: MemoryConfig;
  readonly #sampleIntervalMs: number;
  readonly #elevatedSampleIntervalMs: number;
  readonly #gitOpLease: GitOpLeaseObserver | undefined;
  readonly #leaseWaitPollMs: number;
  readonly #worktreeTaint: WorktreeTaintSink | undefined;
  readonly #requestGracefulStop: (target: WatchdogTarget, sample: ProcessTreeSample) => void | Promise<void>;
  readonly #onEvent: (event: DomainEvent) => void;
  readonly #onSample: (target: WatchdogTarget, sample: ProcessTreeSample) => void;
  readonly #onSupervisionFailure: (target: WatchdogTarget, error: unknown) => void;

  readonly #entries = new Map<ProcessGenerationId, TargetEntry>();

  constructor(deps: WatchdogDeps) {
    this.#clock = deps.clock;
    this.#ids = deps.ids;
    this.#registry = deps.registry;
    this.#ps = deps.ps ?? createPsClient(deps.clock);
    this.#memory = deps.memory ?? DEFAULT_ENGINE_CONFIG.memory;
    this.#sampleIntervalMs = deps.sampleIntervalMs ?? 5_000;
    this.#elevatedSampleIntervalMs = deps.elevatedSampleIntervalMs ?? 1_000;
    this.#gitOpLease = deps.gitOpLease;
    this.#leaseWaitPollMs = deps.leaseWaitPollMs ?? 250;
    this.#worktreeTaint = deps.worktreeTaint;
    this.#requestGracefulStop = deps.requestGracefulStop ?? ((): void => undefined);
    this.#onEvent = deps.onEvent;
    this.#onSample = deps.onSample ?? ((): void => undefined);
    this.#onSupervisionFailure = deps.onSupervisionFailure ?? ((): void => undefined);
  }

  /** Idempotent: watching an already-tracked generation id is a no-op. */
  watch(target: WatchdogTarget): void {
    if (this.#entries.has(target.generationId)) return;
    this.#entries.set(target.generationId, { target, runtime: { phase: 'normal', tickInFlight: false } });
    this.#scheduleNext(target.generationId, this.#sampleIntervalMs);
  }

  isWatching(generationId: ProcessGenerationId): boolean {
    return this.#entries.has(generationId);
  }

  phaseOf(generationId: ProcessGenerationId): TargetPhase | undefined {
    return this.#entries.get(generationId)?.runtime.phase;
  }

  unwatch(generationId: ProcessGenerationId): void {
    const entry = this.#entries.get(generationId);
    if (!entry) return;
    this.#clearTimers(entry.runtime);
    this.#entries.delete(generationId);
  }

  stopAll(): void {
    for (const generationId of [...this.#entries.keys()]) this.unwatch(generationId);
  }

  /**
   * Forces one immediate sample+decision cycle for `generationId`, bypassing
   * the interval scheduler. Deterministic tests use this instead of waiting
   * on real interval timing; the background interval loop keeps running
   * regardless (this does not replace or reset it), and a call while a tick
   * is already in flight for the same target is a safe no-op (returns
   * `undefined`).
   */
  async sampleOnce(generationId: ProcessGenerationId): Promise<ProcessTreeSample | undefined> {
    if (!this.#entries.has(generationId)) return undefined;
    return this.#tick(generationId);
  }

  // -------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------
  #scheduleNext(generationId: ProcessGenerationId, delayMs: number): void {
    const entry = this.#entries.get(generationId);
    if (!entry) return;
    const timer = setTimeout(() => {
      void this.#tick(generationId)
        .then((sample) => {
          const stillEntry = this.#entries.get(generationId);
          if (!stillEntry) return; // unwatched / finished mid-tick
          const ratio = sample ? this.#ratio(stillEntry.target, sample) : 0;
          const nextDelay =
            ratio >= this.#memory.softThresholdRatio ? this.#elevatedSampleIntervalMs : this.#sampleIntervalMs;
          this.#scheduleNext(generationId, nextDelay);
        })
        .catch((error: unknown) => {
          // A throwing tick (ps/execFile failure) must NEVER become an
          // unhandled rejection — that could crash the host or silently kill
          // supervision. Surface a durable alert and reschedule at the base
          // cadence so supervision keeps running (fail-open-with-alert §14).
          const stillEntry = this.#entries.get(generationId);
          if (!stillEntry) return; // unwatched / finished mid-tick — nothing to keep supervising
          // The tick's own `finally` already cleared `tickInFlight`, so the
          // rescheduled tick is free to run.
          this.#onSupervisionFailure(stillEntry.target, error);
          this.#scheduleNext(generationId, this.#sampleIntervalMs);
        });
    }, delayMs);
    timer.unref?.();
    entry.runtime.sampleTimer = timer;
  }

  // -------------------------------------------------------------------
  // Core per-tick decision
  // -------------------------------------------------------------------
  async #tick(generationId: ProcessGenerationId): Promise<ProcessTreeSample | undefined> {
    const entry = this.#entries.get(generationId);
    if (!entry) return undefined;
    const { target, runtime } = entry;
    if (runtime.tickInFlight) return undefined;
    if (runtime.phase === 'killing' || runtime.phase === 'done') return undefined;
    runtime.tickInFlight = true;
    try {
      const sample = this.#ps.sampleProcessTree(target.pgid);
      if (!sample) {
        // Process tree gone: whatever phase we were in (including a
        // successful graceful stop), there is nothing left to supervise.
        this.#finish(generationId);
        return undefined;
      }
      this.#onSample(target, sample);

      const ratio = this.#ratio(target, sample);

      if (ratio >= this.#memory.hardCeilingRatio) {
        await this.#emergencyKill(generationId, sample, 'ceiling');
        return sample;
      }

      if (ratio >= 1) {
        if (runtime.phase !== 'graceful_pending') {
          runtime.phase = 'graceful_pending';
          this.#emit(this.#buildRssHardLimitEvent(target, sample, 'graceful'));
          // F6: arm the SIGKILL deadline BEFORE launching the graceful stop
          // callback. Previously the callback was awaited first and the deadline
          // armed only after it returned — but the host callback unregisters the
          // generation and awaits child disposal, so a hung/slow checkpoint,
          // cancel, or dispose meant the deadline was never armed (or was armed
          // on an already-deleted entry) and the emergency escalation never
          // fired. Arming first makes the deadline independent of the callback:
          // a stuck stop still escalates to the identity-verified kill. The
          // callback must not block on child exit (contract) and must NOT
          // unregister the generation — the entry stays watched until the tree
          // is confirmed gone (a later sample → `#finish`) or the deadline
          // escalates.
          const deadlineTimer = setTimeout(() => {
            void this.#onGracefulDeadline(generationId);
          }, this.#memory.gracefulStopDeadlineMs);
          deadlineTimer.unref?.();
          runtime.deadlineTimer = deadlineTimer;
          await this.#requestGracefulStop(target, sample);
        }
        return sample;
      }

      if (ratio >= this.#memory.softThresholdRatio) {
        if (runtime.phase === 'normal') {
          runtime.phase = 'soft_warned';
          this.#emit(this.#buildRssSoftThresholdEvent(target, sample));
        }
        return sample;
      }

      // Below soft threshold: clear the warn latch so a future re-crossing warns again.
      if (runtime.phase === 'soft_warned') runtime.phase = 'normal';
      return sample;
    } finally {
      runtime.tickInFlight = false;
    }
  }

  async #onGracefulDeadline(generationId: ProcessGenerationId): Promise<void> {
    const entry = this.#entries.get(generationId);
    if (!entry || entry.runtime.phase !== 'graceful_pending') return;
    const sample = this.#ps.sampleProcessTree(entry.target.pgid);
    if (!sample) {
      this.#finish(generationId);
      return;
    }
    await this.#emergencyKill(generationId, sample, 'deadline');
  }

  // -------------------------------------------------------------------
  // Emergency kill (§14: immediate at the ceiling; lease-aware at a
  // graceful-deadline escalation)
  // -------------------------------------------------------------------
  async #emergencyKill(
    generationId: ProcessGenerationId,
    sample: ProcessTreeSample,
    cause: 'ceiling' | 'deadline',
  ): Promise<void> {
    const entry = this.#entries.get(generationId);
    if (!entry) return;
    const { target, runtime } = entry;
    if (runtime.phase === 'killing' || runtime.phase === 'done') return;
    runtime.phase = 'killing';
    if (runtime.deadlineTimer) {
      clearTimeout(runtime.deadlineTimer);
      runtime.deadlineTimer = undefined;
    }

    let taintReason: WorktreeTaint = cause === 'ceiling' ? 'emergency_kill' : 'deadline_termination';

    // The ceiling ALWAYS wins immediately (no lease consultation at all).
    // A deadline-triggered escalation, still under the ceiling, respects an
    // in-flight git op — waiting for it to finish OR for RSS to cross the
    // ceiling while waiting, whichever comes first (§14/§16.2).
    if (cause === 'deadline' && this.#gitOpLease) {
      const outcome = await this.#raceLeaseAgainstCeiling(target);
      if (outcome === 'gone') {
        this.#finish(generationId);
        return;
      }
      if (outcome === 'ceiling') taintReason = 'emergency_kill';
    }

    this.#emit(this.#buildRssHardLimitEvent(target, sample, 'emergency_kill'));

    const verification = this.#registry.signalVerified(target.generationId, 'SIGKILL');
    if (verification.verdict === 'match' && target.assignmentId !== undefined) {
      this.#worktreeTaint?.markTainted(target.assignmentId, taintReason);
    }
    // On mismatch/gone, `registry.signalVerified` already withheld the
    // signal and raised its own alert (§14: "ambiguity -> never kill") —
    // nothing further to do here.

    this.#finish(generationId);
  }

  /** Polls `gitOpLease.awaitGitOpIdle` in short slices so RSS can be re-checked between waits; the ceiling short-circuits the wait the instant it's crossed. */
  async #raceLeaseAgainstCeiling(target: WatchdogTarget): Promise<LeaseRaceOutcome> {
    const lease = this.#gitOpLease;
    if (!lease) return 'proceed';
    for (;;) {
      const outcome = await lease.awaitGitOpIdle(this.#leaseWaitPollMs);
      if (outcome === 'idle') return 'proceed';
      const sample = this.#ps.sampleProcessTree(target.pgid);
      if (!sample) return 'gone';
      if (this.#ratio(target, sample) >= this.#memory.hardCeilingRatio) return 'ceiling';
      // else: still under the ceiling and the lease is still held — loop.
    }
  }

  // -------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------
  #finish(generationId: ProcessGenerationId): void {
    const entry = this.#entries.get(generationId);
    if (!entry) return;
    this.#clearTimers(entry.runtime);
    entry.runtime.phase = 'done';
    this.#entries.delete(generationId);
  }

  #clearTimers(runtime: TargetRuntime): void {
    if (runtime.sampleTimer) clearTimeout(runtime.sampleTimer);
    if (runtime.deadlineTimer) clearTimeout(runtime.deadlineTimer);
    runtime.sampleTimer = undefined;
    runtime.deadlineTimer = undefined;
  }

  #budgetBytes(target: WatchdogTarget): number {
    return target.budgetBytes ?? this.#memory.budgetMb * BYTES_PER_MB;
  }

  #ratio(target: WatchdogTarget, sample: ProcessTreeSample): number {
    const budget = this.#budgetBytes(target);
    return budget > 0 ? sample.rssBytes / budget : 0;
  }

  #emit(event: DomainEvent): void {
    this.#onEvent(event);
  }

  #buildRssSoftThresholdEvent(target: WatchdogTarget, sample: ProcessTreeSample): EventOfType<'rss.soft_threshold'> {
    return draftEvent({
      type: 'rss.soft_threshold',
      runId: target.runId,
      payload: {
        rssBytes: sample.rssBytes,
        budgetBytes: this.#budgetBytes(target),
        ...(target.segmentId !== undefined ? { segmentId: target.segmentId } : {}),
      },
      idempotencyKey: newIdempotencyKey(this.#ids),
      occurredAt: this.#clock.nowIso(),
    });
  }

  #buildRssHardLimitEvent(
    target: WatchdogTarget,
    sample: ProcessTreeSample,
    escalation: 'graceful' | 'emergency_kill',
  ): EventOfType<'rss.hard_limit'> {
    return draftEvent({
      type: 'rss.hard_limit',
      runId: target.runId,
      payload: {
        rssBytes: sample.rssBytes,
        budgetBytes: this.#budgetBytes(target),
        escalation,
        generationId: target.generationId,
        ...(target.segmentId !== undefined ? { segmentId: target.segmentId } : {}),
        ...(target.role !== undefined ? { role: target.role } : {}),
      },
      idempotencyKey: newIdempotencyKey(this.#ids),
      occurredAt: this.#clock.nowIso(),
    });
  }
}
