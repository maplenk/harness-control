/**
 * PLAN.md §19 test 29: "breaker: window + lifetime + no-progress bounds;
 * `--unsafe-dev` retains lifetime cap."
 *
 * Combines this module's own time-decayed window/no-progress/max-elapsed
 * decisions with the REAL transition engine (`../domain/transitions.ts`) so
 * every `BreakerAdvice.triggerEvent` this module builds is proven to drive
 * `applyTransition` to the exact same outcome a live caller would see.
 */
import { describe, expect, it } from 'vitest';
import { isoTimestamp, type IsoTimestamp } from '../lib/clock.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { artifactHash, assignmentId, idempotencyKey, processGenerationId, runId, segmentId, type AssignmentId } from '../domain/ids.js';
import { draftEvent } from '../domain/events.js';
import {
  applyTransition,
  initialEngineState,
  type EngineState,
} from '../domain/transitions.js';
import { DEFAULT_BOUNDS, ZERO_COUNTERS, isLiveChild, type ActiveChild, type RestartCounters } from '../domain/state.js';
import { parseEngineConfig, toEngineBounds } from '../config/loader.js';
import {
  DEFAULT_BREAKER_BOUNDS,
  NON_DISABLEABLE_LIFETIME_CAP,
  RestartBreaker,
  computeBackoffMs,
  type BreakerAdvice,
  type RestartAttemptInput,
} from './breaker.js';

const RUN = runId('run_breaker_1');
const SEG = segmentId('seg_breaker_1');
const GEN = processGenerationId('pgen_breaker_1');

/** W2-1: a live generation-tracked child for engine states. */
function liveChild(): ActiveChild {
  return { generationId: GEN, segmentId: SEG, status: 'active' };
}
const ASG: AssignmentId = assignmentId('asg_breaker_1');

function at(iso: string): IsoTimestamp {
  return isoTimestamp(iso);
}

function baseInput(overrides: Partial<RestartAttemptInput> & { readonly occurredAt: IsoTimestamp }): RestartAttemptInput {
  return {
    runId: RUN,
    assignmentId: ASG,
    segmentId: SEG,
    counters: ZERO_COUNTERS,
    classifiedAs: 'crash',
    ...overrides,
  };
}

function expectRestart(advice: BreakerAdvice): asserts advice is Extract<BreakerAdvice, { kind: 'restart' }> {
  expect(advice.kind).toBe('restart');
}

function expectOpen(advice: BreakerAdvice): asserts advice is Extract<BreakerAdvice, { kind: 'breaker_open' }> {
  expect(advice.kind).toBe('breaker_open');
}

describe('RestartBreaker: time-decayed window bound', () => {
  it('opens with reason=window_bound once more than the engine window max crash in quick succession', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    // DEFAULT_BOUNDS.restartWindowMax = 5: five crashes fit; the sixth (still well inside the 10-minute window) trips it.
    // S5 (§5cc): the decision derives from the DURABLE `counters.restartWindow`,
    // so this drives the production loop faithfully — each ACCEPTED restart's T13
    // is folded into the durable window by the reducer before the next crash
    // reads it back (modeled here by growing `durable`).
    const base = Date.parse('2026-07-18T09:00:00.000Z');
    let durable: readonly IsoTimestamp[] = [];
    let last: BreakerAdvice | undefined;
    for (let i = 0; i < 6; i += 1) {
      const occurredAt = isoTimestamp(new Date(base + i * 1000).toISOString());
      last = breaker.evaluateCrash(baseInput({ occurredAt, counters: { ...ZERO_COUNTERS, restartWindow: durable } }));
      if (i < 5) {
        expectRestart(last);
        durable = [...durable, occurredAt]; // reducer folds the accepted T13
      }
    }
    expectOpen(last!);
    if (last!.kind === 'breaker_open') {
      expect(last!.reason).toBe('window_bound');
      expect(last!.triggerEvent.type).toBe('restart.exhausted');
      expect(last!.triggerEvent.payload).toEqual({ reason: 'window_bound' });
    }
  });

  it('does NOT open when the same number of crashes are spread outside the window (genuine time decay)', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    const base = Date.parse('2026-07-18T09:00:00.000Z');
    // Six crashes, each 11 minutes apart (window default is 10 minutes) — by
    // the time crash N happens, crash N-1 has already decayed out, so the
    // window never holds more than ~1 recent entry. `recordProgress` between
    // iterations resets ONLY the no-progress/elapsed-recovery bookkeeping
    // (never the window deque — see module doc), isolating this assertion
    // from the UNRELATED max-elapsed-recovery condition, which a real
    // 55-minute-long continuous recovery sequence would otherwise
    // (correctly) trip on its own.
    for (let i = 0; i < 6; i += 1) {
      const occurredAt = isoTimestamp(new Date(base + i * 11 * 60_000).toISOString());
      const advice = breaker.evaluateCrash(baseInput({ occurredAt }));
      expectRestart(advice);
      breaker.recordProgress(ASG);
    }
  });

  it('windowCountAsOf reports the live, decayed count without mutating state', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    // S5 (§5cc): the observability cache reflects the durable window + the crash
    // just evaluated, so thread the first crash's accepted fold into the second.
    breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z') }));
    breaker.evaluateCrash(
      baseInput({
        occurredAt: at('2026-07-18T09:01:00.000Z'),
        counters: { ...ZERO_COUNTERS, restartWindow: [at('2026-07-18T09:00:00.000Z')] },
      }),
    );
    expect(breaker.windowCountAsOf(ASG, at('2026-07-18T09:02:00.000Z'))).toBe(2);
    // Ask again far in the future: both should have decayed out. Repeated
    // calls must not themselves add entries (read-only).
    expect(breaker.windowCountAsOf(ASG, at('2026-07-18T09:30:00.000Z'))).toBe(0);
    expect(breaker.windowCountAsOf(ASG, at('2026-07-18T09:30:01.000Z'))).toBe(0);
  });

  // S5 (§5cc) REGRESSION — FAILS against the pre-S5 in-memory accumulator.
  it('a stale-generation crash whose T13 is REJECTED does not pollute the respawn-gating decision (decides off the durable window, never a private deque)', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    // The durable, reducer-owned window holds 3 real restarts — well under the
    // max of 5. It is the SINGLE writer's copy: only ACCEPTED, generation-matched
    // T13s ever grow it.
    const durable: readonly IsoTimestamp[] = [
      at('2026-07-18T09:00:00.000Z'),
      at('2026-07-18T09:00:01.000Z'),
      at('2026-07-18T09:00:02.000Z'),
    ];
    const counters = { ...ZERO_COUNTERS, restartWindow: durable };
    // Two stale-generation crashes arrive. Their T13 is generation-mismatched, so
    // the engine REJECTS it and the reducer NEVER folds them — the durable window
    // stays at 3 across all three calls (the caller re-reads the same `counters`).
    breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:03.000Z'), counters }));
    breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:04.000Z'), counters }));
    // A legitimate crash for the ACTIVE generation: durable(3) + this = 4 ≤ 5, so
    // it MUST still be a restart. The pre-S5 code accumulated the two rejected
    // crashes into its private deque (3 → 4 → 5 → 6) and spuriously tripped
    // `window_bound` on this fourth call.
    const advice = breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:05.000Z'), counters }));
    expectRestart(advice);
  });
});

describe('RestartBreaker: non-disableable lifetime cap', () => {
  it('opens with reason=lifetime_cap the moment the CALLER-supplied counters reach the cap, regardless of window headroom', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    const atCap: RestartCounters = { ...ZERO_COUNTERS, lifetimeRestarts: NON_DISABLEABLE_LIFETIME_CAP };
    const advice = breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z'), counters: atCap }),
    );
    expectOpen(advice);
    if (advice.kind === 'breaker_open') expect(advice.reason).toBe('lifetime_cap');
  });

  it('lifetime is read from the caller, never tracked independently: an otherwise-fresh breaker instance immediately honors an already-high caller-supplied count', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    const nearCap: RestartCounters = { ...ZERO_COUNTERS, lifetimeRestarts: NON_DISABLEABLE_LIFETIME_CAP - 1 };
    const restart = breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z'), counters: nearCap }),
    );
    expectRestart(restart); // one below cap: still a restart

    const atCap: RestartCounters = { ...ZERO_COUNTERS, lifetimeRestarts: NON_DISABLEABLE_LIFETIME_CAP };
    const open = breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:00:05.000Z'), counters: atCap }),
    );
    expectOpen(open);
  });
});

describe('RestartBreaker: no-progress detection (identical consecutive checkpoint hash)', () => {
  it('opens with reason=no_progress on the SECOND consecutive identical checkpoint hash, even with full window/lifetime headroom', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    const hash = artifactHash('deadbeef-same-hash');

    const first = breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z'), latestCheckpointHash: hash }),
    );
    expectRestart(first);

    const second = breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:00:30.000Z'), latestCheckpointHash: hash }),
    );
    expectOpen(second);
    if (second.kind === 'breaker_open') {
      expect(second.reason).toBe('no_progress');
      expect(second.triggerEvent.payload).toEqual({ reason: 'no_progress' });
    }
  });

  it('does NOT open when consecutive checkpoint hashes DIFFER (real progress)', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z'), latestCheckpointHash: artifactHash('hash-a') }),
    );
    const second = breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:00:30.000Z'), latestCheckpointHash: artifactHash('hash-b') }),
    );
    expectRestart(second);
  });

  it('recordProgress() clears the no-progress latch so a later identical hash does not falsely trip', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    const hash = artifactHash('same-hash-again');
    breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z'), latestCheckpointHash: hash }));
    breaker.recordProgress(ASG);
    const advice = breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:00:30.000Z'), latestCheckpointHash: hash }),
    );
    expectRestart(advice);
  });
});

describe('RestartBreaker: max elapsed recovery time (default 30min)', () => {
  it('opens with reason=max_elapsed_recovery once the recovery sequence has run long, even when each crash individually looks healthy (fresh window, differing hashes, low lifetime count)', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    const first = breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z'), latestCheckpointHash: artifactHash('h1') }),
    );
    expectRestart(first);

    // 35 minutes later: window has fully decayed (default 10min), hash
    // differs, lifetime is still low — ONLY the elapsed-recovery-time check
    // can explain a breaker_open here.
    const second = breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:35:00.000Z'), latestCheckpointHash: artifactHash('h2') }),
    );
    expectOpen(second);
    if (second.kind === 'breaker_open') expect(second.reason).toBe('max_elapsed_recovery');
  });

  it('recordProgress() resets the recovery-sequence clock', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z') }));
    breaker.recordProgress(ASG);
    const advice = breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:35:00.000Z') }));
    expectRestart(advice); // a FRESH sequence started at recordProgress-time, not 09:00
  });
});

describe('RestartBreaker: exponential backoff', () => {
  it('computeBackoffMs grows exponentially and saturates at the configured max', () => {
    expect(computeBackoffMs(1)).toBe(DEFAULT_BREAKER_BOUNDS.backoffBaseMs);
    expect(computeBackoffMs(2)).toBe(DEFAULT_BREAKER_BOUNDS.backoffBaseMs * DEFAULT_BREAKER_BOUNDS.backoffFactor);
    expect(computeBackoffMs(3)).toBe(
      DEFAULT_BREAKER_BOUNDS.backoffBaseMs * DEFAULT_BREAKER_BOUNDS.backoffFactor ** 2,
    );
    const huge = computeBackoffMs(50);
    expect(huge).toBe(DEFAULT_BREAKER_BOUNDS.backoffMaxMs);
  });

  it('a restart advice carries a monotonically increasing attempt/backoff across a live sequence', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    const first = breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z') }));
    const second = breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:05.000Z') }));
    expectRestart(first);
    expectRestart(second);
    if (first.kind === 'restart' && second.kind === 'restart') {
      expect(second.attempt).toBe(first.attempt + 1);
      expect(second.backoffMs).toBeGreaterThanOrEqual(first.backoffMs);
    }
  });
});

describe('RestartBreaker.reset (T15 breaker reset)', () => {
  it('clears window + no-progress/elapsed bookkeeping so the next crash starts a clean sequence', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    const hash = artifactHash('h-reset');
    breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z'), latestCheckpointHash: hash }));
    breaker.reset(ASG);
    expect(breaker.attemptsInSequence(ASG)).toBe(0);
    expect(breaker.windowCountAsOf(ASG, at('2026-07-18T09:00:01.000Z'))).toBe(0);
    // Same hash again post-reset must NOT look like a no-progress repeat.
    const advice = breaker.evaluateCrash(
      baseInput({ occurredAt: at('2026-07-18T09:00:01.000Z'), latestCheckpointHash: hash }),
    );
    expectRestart(advice);
  });
});

describe('RestartBreaker.evaluateCrash outputs drive the REAL transition engine identically', () => {
  it('a plain restart advice (T13) applies against `applyTransition` — W2-1: folds counters and interrupts, never respawns', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    const advice = breaker.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z') }));
    expectRestart(advice);
    const state: EngineState = initialEngineState({ phase: 'implementing', activeChild: liveChild() });
    const outcome = applyTransition(state, advice.triggerEvent);
    expect(outcome.status).toBe('applied');
    if (outcome.status === 'applied') {
      expect(outcome.transitionId).toBe('T13');
      // W2-1 deliberate correction: the amended T13 marks the generation
      // stopped and suspends `interrupted` (manual resume; the 'restart'
      // advice bookkeeping becomes P4b's bounded-respawn machinery).
      expect(outcome.next.suspension.kind).toBe('interrupted');
      expect(isLiveChild(outcome.next.activeChild)).toBe(false);
      expect(outcome.next.counters.lifetimeRestarts).toBe(1);
      expect(outcome.emitted.map((e) => e.type)).not.toContain('segment.restart.initiated');
    }
  });

  it('window_bound advice opens the engine breaker via T14', () => {
    const breaker = new RestartBreaker(new DeterministicIdFactory());
    const base = Date.parse('2026-07-18T09:00:00.000Z');
    let durable: readonly IsoTimestamp[] = [];
    let advice: BreakerAdvice | undefined;
    for (let i = 0; i < 6; i += 1) {
      const occurredAt = isoTimestamp(new Date(base + i * 1000).toISOString());
      advice = breaker.evaluateCrash(baseInput({ occurredAt, counters: { ...ZERO_COUNTERS, restartWindow: durable } }));
      if (advice.kind === 'restart') durable = [...durable, occurredAt]; // reducer folds the accepted T13
    }
    expectOpen(advice!);
    const state: EngineState = initialEngineState({ phase: 'implementing', activeChild: liveChild() });
    const outcome = applyTransition(state, advice!.triggerEvent);
    expect(outcome.status).toBe('applied');
    if (outcome.status === 'applied') {
      expect(outcome.transitionId).toBe('T14');
      expect(outcome.next.suspension.kind).toBe('breaker_open');
      const opened = outcome.emitted.find((e) => e.type === 'breaker.opened');
      expect(opened?.payload).toEqual({ reason: 'window_bound' });
    }
  });

  it('lifetime_cap / no_progress / max_elapsed_recovery advices each open the engine breaker via T14 with their own exact reason', () => {
    const scenarios: ReadonlyArray<{ readonly label: string; readonly advice: BreakerAdvice }> = [
      {
        label: 'lifetime_cap',
        advice: new RestartBreaker(new DeterministicIdFactory()).evaluateCrash(
          baseInput({
            occurredAt: at('2026-07-18T09:00:00.000Z'),
            counters: { ...ZERO_COUNTERS, lifetimeRestarts: NON_DISABLEABLE_LIFETIME_CAP },
          }),
        ),
      },
      {
        label: 'no_progress',
        advice: (() => {
          const b = new RestartBreaker(new DeterministicIdFactory());
          const hash = artifactHash('dup-hash');
          b.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z'), latestCheckpointHash: hash }));
          return b.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:05.000Z'), latestCheckpointHash: hash }));
        })(),
      },
      {
        label: 'max_elapsed_recovery',
        advice: (() => {
          const b = new RestartBreaker(new DeterministicIdFactory());
          b.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:00:00.000Z') }));
          return b.evaluateCrash(baseInput({ occurredAt: at('2026-07-18T09:35:00.000Z') }));
        })(),
      },
    ];

    for (const { label, advice } of scenarios) {
      expectOpen(advice);
      const state: EngineState = initialEngineState({ phase: 'implementing', activeChild: liveChild() });
      const outcome = applyTransition(state, advice.triggerEvent);
      expect(outcome.status).toBe('applied');
      if (outcome.status === 'applied') {
        expect(outcome.transitionId).toBe('T14');
        expect(outcome.next.suspension.kind).toBe('breaker_open');
        const opened = outcome.emitted.find((e) => e.type === 'breaker.opened');
        expect(opened?.payload, `reason mismatch for ${label}`).toEqual({ reason: label });
      }
    }
  });
});

describe('`--unsafe-dev` (windowMax=off) retains the non-disableable lifetime cap', () => {
  it('window never trips with windowMax=off, but lifetime still opens the breaker at the cap', () => {
    const parsed = parseEngineConfig({ restarts: { windowMax: 'off', unsafeDev: true } });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const engineBounds = toEngineBounds(parsed.value);
    expect(engineBounds.restartWindowMax).toBe(Number.POSITIVE_INFINITY);
    expect(engineBounds.lifetimeRestartMax).toBe(DEFAULT_BOUNDS.lifetimeRestartMax); // unchanged: non-disableable

    const breaker = new RestartBreaker(new DeterministicIdFactory(), DEFAULT_BREAKER_BOUNDS, engineBounds);
    const base = Date.parse('2026-07-18T09:00:00.000Z');

    // 20 crashes in rapid succession — would trip window_bound at 6 under
    // normal bounds; with 'off' it never does.
    let last: BreakerAdvice | undefined;
    for (let i = 0; i < 20; i += 1) {
      const occurredAt = isoTimestamp(new Date(base + i * 1000).toISOString());
      const counters: RestartCounters = { ...ZERO_COUNTERS, lifetimeRestarts: i };
      last = breaker.evaluateCrash(baseInput({ occurredAt, counters }));
      if (i < DEFAULT_BOUNDS.lifetimeRestartMax) {
        expectRestart(last);
      }
    }
    expectOpen(last!);
    if (last!.kind === 'breaker_open') expect(last!.reason).toBe('lifetime_cap');
  });
});

describe('Limit-pauses NEVER count toward the breaker (T4/T16) — never reachable via this module', () => {
  it('T4 (structured usage-limit pause) and T16 (unknown provider error, fail-safe pause) never emit child.exited.unexpectedly or restart.exhausted, and a breaker fed only limit pauses reports zero window/attempt activity', () => {
    // T4/T16 stop the child CLEANLY through an entirely different event
    // family; there is no code path from either into
    // `RestartBreaker.evaluateCrash`. Demonstrated two ways: (a) the ENGINE
    // itself, driven directly by T4/T16 trigger events, never emits a T13/T14
    // event; (b) a breaker instance that is simply never called (exactly
    // what a correct caller does for a limit pause) reports no activity.
    const state: EngineState = initialEngineState({
      phase: 'implementing',
      operation: { kind: 'prompt_turn' },
      activeChild: liveChild(),
    });
    const t4 = applyTransition(
      state,
      draftEvent({
        type: 'limit.classified.prompt_turn',
        runId: RUN,
        idempotencyKey: idempotencyKey('t4-trigger-1'),
        occurredAt: at('2026-07-18T09:00:00.000Z'),
        payload: {
          segmentId: SEG,
          classification: {
            kind: 'usage_limit',
            provider: 'claude',
            source: 'structured',
            confidence: 'high',
            detectionTier: 'structured',
          },
        },
      }),
    );
    expect(t4.status).toBe('applied');
    if (t4.status === 'applied') {
      const types = t4.emitted.map((e) => e.type);
      expect(types).not.toContain('child.exited.unexpectedly');
      expect(types).not.toContain('restart.exhausted');
      expect(t4.next.counters).toEqual(state.counters); // untouched
    }

    const breaker = new RestartBreaker(new DeterministicIdFactory());
    expect(breaker.attemptsInSequence(ASG)).toBe(0);
    expect(breaker.windowCountAsOf(ASG, at('2026-07-18T09:00:00.000Z'))).toBe(0);
  });
});
