/**
 * §17.2 honest cost accounting folds — cumulative `usage_update` cost as a
 * per-session delta, additive per-turn tokens, no double-counting, and the
 * estimated soft-budget predicate.
 */
import { describe, expect, it } from 'vitest';
import {
  emptyCostProjection,
  foldTurnUsage,
  foldUsageUpdate,
  wouldExceedBudget,
} from './cost.js';

describe('foldUsageUpdate (cumulative cost → per-session delta)', () => {
  it('folds only the delta of a cumulative session cost and tracks the context gauge', () => {
    let state = emptyCostProjection();
    state = foldUsageUpdate(state, {
      role: 'coordinator',
      phase: 'specifying',
      sessionKey: 's1',
      usedTokens: 100,
      contextWindowSize: 200_000,
      cost: { amount: 0.1, currency: 'USD' },
    });
    state = foldUsageUpdate(state, {
      role: 'coordinator',
      phase: 'specifying',
      sessionKey: 's1',
      usedTokens: 900,
      contextWindowSize: 200_000,
      cost: { amount: 0.25, currency: 'USD' }, // cumulative → +0.15
    });

    expect(state.totalCostUsd).toBe(0.25);
    expect(state.byRole.coordinator?.costUsd).toBe(0.25);
    expect(state.byPhase.specifying?.costUsd).toBe(0.25);
    expect(state.roleVitals.coordinator).toEqual({ contextUsedTokens: 900, contextWindowSize: 200_000 });
    expect(state.currency).toBe('USD');
  });

  it('attributes distinct sessions independently (no cross-session delta bleed)', () => {
    let state = emptyCostProjection();
    state = foldUsageUpdate(state, {
      role: 'coordinator', phase: 'specifying', sessionKey: 's1',
      usedTokens: 10, contextWindowSize: 100, cost: { amount: 0.2, currency: 'USD' },
    });
    state = foldUsageUpdate(state, {
      role: 'implementor', phase: 'implementing', sessionKey: 's2',
      usedTokens: 10, contextWindowSize: 100, cost: { amount: 0.3, currency: 'USD' },
    });
    expect(state.totalCostUsd).toBe(0.5);
    expect(state.byRole.coordinator?.costUsd).toBe(0.2);
    expect(state.byRole.implementor?.costUsd).toBe(0.3);
    expect(state.byPhase.specifying?.costUsd).toBe(0.2);
    expect(state.byPhase.implementing?.costUsd).toBe(0.3);
  });
});

describe('foldTurnUsage (additive tokens; no cost double-count)', () => {
  it('adds tokens + a turn tally, but not per-turn cost for a session that streamed cumulative cost', () => {
    let state = emptyCostProjection();
    state = foldUsageUpdate(state, {
      role: 'coordinator', phase: 'specifying', sessionKey: 's1',
      usedTokens: 100, contextWindowSize: 100, cost: { amount: 0.4, currency: 'USD' },
    });
    state = foldTurnUsage(state, {
      role: 'coordinator', phase: 'specifying', sessionKey: 's1',
      usage: { inputTokens: 500, outputTokens: 300, costUsd: 9.99, source: 'adapter' },
    });

    expect(state.totalInputTokens).toBe(500);
    expect(state.totalOutputTokens).toBe(300);
    expect(state.turns).toBe(1);
    expect(state.byRole.coordinator?.turns).toBe(1);
    // Cost stays the streamed 0.40 — the per-turn 9.99 is NOT double-counted.
    expect(state.totalCostUsd).toBe(0.4);
  });

  it('DOES fold per-turn cost for a session that never streamed cumulative cost', () => {
    let state = emptyCostProjection();
    state = foldTurnUsage(state, {
      role: 'verifier', phase: 'verifying', sessionKey: 's3',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.05, source: 'adapter' },
    });
    expect(state.totalCostUsd).toBe(0.05);
    expect(state.byRole.verifier?.costUsd).toBe(0.05);
    expect(state.byPhase.verifying).toEqual({
      turns: 1,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.05,
      estimatedCostUsd: 0,
    });
    // A measured-price turn contributes NO estimate.
    expect(state.totalEstimatedCostUsd).toBe(0);
    expect(state.costEstimated).toBe(false);
  });
});

describe('foldTurnUsage §17.2 D-2 (subscription turn: tokens, no price → conservative estimate)', () => {
  it('folds the conservative reservation as ESTIMATED (not measured) per-role/per-phase cost', () => {
    let state = emptyCostProjection();
    state = foldTurnUsage(state, {
      role: 'implementor',
      phase: 'implementing',
      sessionKey: 'codex-sub',
      // A Codex ChatGPT-login turn: real token counts, but NO per-token price.
      usage: { inputTokens: 800, outputTokens: 200, source: 'adapter' },
      reservationUsd: 0.5,
    });

    // Measured spend stays honest at $0 (no price was advertised)…
    expect(state.totalCostUsd).toBe(0);
    expect(state.byRole.implementor?.costUsd).toBe(0);
    // …while the conservative reservation is surfaced as an ESTIMATE, flagged.
    expect(state.totalEstimatedCostUsd).toBe(0.5);
    expect(state.costEstimated).toBe(true);
    expect(state.byRole.implementor?.estimatedCostUsd).toBe(0.5);
    expect(state.byPhase.implementing?.estimatedCostUsd).toBe(0.5);
    // Tokens + turn tally are still recorded.
    expect(state.totalInputTokens).toBe(800);
    expect(state.turns).toBe(1);
  });

  it('does NOT estimate when a measured price is present, nor when no tokens were advertised', () => {
    // Measured price present → no estimate.
    let priced = emptyCostProjection();
    priced = foldTurnUsage(priced, {
      role: 'implementor', phase: 'implementing', sessionKey: 'p1',
      usage: { inputTokens: 10, outputTokens: 5, costUsd: 0.2, source: 'adapter' },
      reservationUsd: 0.5,
    });
    expect(priced.totalCostUsd).toBe(0.2);
    expect(priced.totalEstimatedCostUsd).toBe(0);
    expect(priced.costEstimated).toBe(false);

    // A silent turn (no tokens, no price) → no fabricated estimate.
    let silent = emptyCostProjection();
    silent = foldTurnUsage(silent, {
      role: 'implementor', phase: 'implementing', sessionKey: 's1',
      usage: { source: 'adapter' },
      reservationUsd: 0.5,
    });
    expect(silent.totalEstimatedCostUsd).toBe(0);
    expect(silent.costEstimated).toBe(false);
    expect(silent.turns).toBe(1);
  });

  it('does NOT estimate for a session that streamed a cumulative usage_update cost', () => {
    let state = emptyCostProjection();
    state = foldUsageUpdate(state, {
      role: 'implementor', phase: 'implementing', sessionKey: 'streamed',
      usedTokens: 100, contextWindowSize: 100, cost: { amount: 0.4, currency: 'USD' },
    });
    state = foldTurnUsage(state, {
      role: 'implementor', phase: 'implementing', sessionKey: 'streamed',
      usage: { inputTokens: 500, outputTokens: 300, source: 'adapter' }, // no per-turn price
      reservationUsd: 0.5,
    });
    // Cost is the streamed 0.40 (measured); no estimate is layered on top.
    expect(state.totalCostUsd).toBe(0.4);
    expect(state.totalEstimatedCostUsd).toBe(0);
    expect(state.costEstimated).toBe(false);
  });
});

describe('wouldExceedBudget (§17.2 estimated soft budget)', () => {
  it('refuses a turn only when spend + reservation strictly exceeds the budget', () => {
    const state = { ...emptyCostProjection(), totalCostUsd: 0.3 };
    expect(wouldExceedBudget(state, 0.5, 1.0)).toBe(false); // 0.8 <= 1.0
    expect(wouldExceedBudget(state, 0.5, 0.8)).toBe(false); // 0.8 == 0.8 (not strictly over)
    expect(wouldExceedBudget(state, 0.5, 0.7)).toBe(true); // 0.8 > 0.7
  });

  // W1-F5 corrected semantics: ESTIMATED spend counts toward refusal too — a
  // run whose every turn is unpriced (subscription billing) must still trip
  // the refusal instead of never charging the predicate.
  it('counts estimated (reservation-folded) spend toward the refusal', () => {
    const state = { ...emptyCostProjection(), totalCostUsd: 0.3, totalEstimatedCostUsd: 0.4 };
    expect(wouldExceedBudget(state, 0.5, 1.2)).toBe(false); // 0.3+0.4+0.5 == 1.2 (not strictly over)
    expect(wouldExceedBudget(state, 0.5, 1.1)).toBe(true); // 1.2 > 1.1
    const estimatedOnly = { ...emptyCostProjection(), totalEstimatedCostUsd: 1.0 };
    expect(wouldExceedBudget(estimatedOnly, 0.5, 1.2)).toBe(true); // 0+1.0+0.5 > 1.2
  });
});
