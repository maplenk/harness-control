/**
 * Honest cost accounting (PLAN §17.2) — the per-role / per-phase token+cost
 * projection folded from two adapter signals:
 *  - the live `usage_update` SessionUpdate (§9): `{used, size, cost?}` — a
 *    per-session CUMULATIVE gauge (context tokens used, total context size,
 *    cumulative session cost). Cost is folded by DELTA against the last
 *    cumulative value seen for that session key, so re-observing the running
 *    total (every live turn emits one) never double-counts; `used`/`size`
 *    update the role's live context vitals.
 *  - the `PromptResult.usage` per-turn accounting (`TurnUsage`): additive
 *    input/output token counts (+ per-turn cost as a FALLBACK cost source used
 *    only for sessions that never streamed a cumulative cost, so the two
 *    sources are never summed for the same money).
 *
 * §17.2 is "honest": cost totals reflect what the adapter actually reported;
 * `--max-budget` is an ESTIMATED soft budget (`wouldExceedBudget`) — a pre-turn
 * refusal gate, never claimed as a hard ceiling. Everything here is PURE and
 * serializable (it is persisted as a run projection and reloaded across
 * restarts, which is exactly why the per-session cumulative baseline lives in
 * the state).
 */
import type { TurnUsage } from '../domain/entities.js';
import type { RoleName, RunPhase } from '../domain/state.js';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------
export interface CostBucket {
  readonly turns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** MEASURED cost — what the adapter actually reported (§17.2). */
  readonly costUsd: number;
  /**
   * §17.2 D-2 ESTIMATED cost: the conservative per-turn reservation folded for
   * turns that advertised token counts but carried NO per-token price
   * (subscription billing — e.g. a Codex ChatGPT login). Kept SEPARATE from
   * `costUsd` so measured and estimated money are never conflated; `status`
   * labels this as estimated, never as measured spend.
   */
  readonly estimatedCostUsd: number;
}

/** Live context-window gauge for a role (latest `usage_update`). */
export interface RoleVital {
  readonly contextUsedTokens?: number;
  readonly contextWindowSize?: number;
}

export interface CostProjectionState {
  readonly totalCostUsd: number;
  /** §17.2 D-2: total CONSERVATIVE estimate for subscription turns with no
   * measured price (sum of the per-turn reservations folded), kept apart from
   * the measured `totalCostUsd`. */
  readonly totalEstimatedCostUsd: number;
  /** True once ANY turn contributed estimated (not measured) cost — the honest
   * flag `status` shows so an operator knows the total includes an estimate. */
  readonly costEstimated: boolean;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly turns: number;
  readonly byRole: Readonly<Partial<Record<RoleName, CostBucket>>>;
  readonly byPhase: Readonly<Partial<Record<RunPhase, CostBucket>>>;
  readonly roleVitals: Readonly<Partial<Record<RoleName, RoleVital>>>;
  readonly currency?: string;
  /** Internal: last cumulative cost per session key (delta baseline). */
  readonly sessionCumulativeCost: Readonly<Record<string, number>>;
  /** Internal: session keys that streamed cumulative cost (per-turn cost is
   * then NOT folded for them, so the same money is counted once). */
  readonly sessionsWithStreamedCost: Readonly<Record<string, true>>;
}

const ZERO_BUCKET: CostBucket = { turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, estimatedCostUsd: 0 };

export function emptyCostProjection(): CostProjectionState {
  return {
    totalCostUsd: 0,
    totalEstimatedCostUsd: 0,
    costEstimated: false,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    turns: 0,
    byRole: {},
    byPhase: {},
    roleVitals: {},
    sessionCumulativeCost: {},
    sessionsWithStreamedCost: {},
  };
}

// ---------------------------------------------------------------------------
// Rounding (avoid float drift accumulating across many small deltas)
// ---------------------------------------------------------------------------
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function bumpBucket(bucket: CostBucket | undefined, delta: Partial<CostBucket>): CostBucket {
  const base = bucket ?? ZERO_BUCKET;
  return {
    turns: base.turns + (delta.turns ?? 0),
    inputTokens: base.inputTokens + (delta.inputTokens ?? 0),
    outputTokens: base.outputTokens + (delta.outputTokens ?? 0),
    costUsd: round(base.costUsd + (delta.costUsd ?? 0)),
    estimatedCostUsd: round(base.estimatedCostUsd + (delta.estimatedCostUsd ?? 0)),
  };
}

/** Fold a bucket delta into totals + the role bucket + the phase bucket. */
function applyDelta(
  state: CostProjectionState,
  role: RoleName,
  phase: RunPhase,
  delta: Partial<CostBucket>,
): CostProjectionState {
  const estimatedDelta = delta.estimatedCostUsd ?? 0;
  return {
    ...state,
    turns: state.turns + (delta.turns ?? 0),
    totalInputTokens: state.totalInputTokens + (delta.inputTokens ?? 0),
    totalOutputTokens: state.totalOutputTokens + (delta.outputTokens ?? 0),
    totalCostUsd: round(state.totalCostUsd + (delta.costUsd ?? 0)),
    totalEstimatedCostUsd: round(state.totalEstimatedCostUsd + estimatedDelta),
    costEstimated: state.costEstimated || estimatedDelta > 0,
    byRole: { ...state.byRole, [role]: bumpBucket(state.byRole[role], delta) },
    byPhase: { ...state.byPhase, [phase]: bumpBucket(state.byPhase[phase], delta) },
  };
}

// ---------------------------------------------------------------------------
// Folds
// ---------------------------------------------------------------------------
export interface SessionCost {
  readonly amount: number;
  readonly currency: string;
}

export interface UsageUpdateFold {
  readonly role: RoleName;
  readonly phase: RunPhase;
  /** The session key (ACP session id) the update belongs to — the delta baseline key. */
  readonly sessionKey: string;
  readonly usedTokens: number;
  readonly contextWindowSize: number;
  readonly cost?: SessionCost;
}

/**
 * Fold one live `usage_update`: refresh the role's context gauge and, when a
 * cumulative cost is present, add only the delta versus the last cumulative
 * value seen for this session (cumulative gauges never decrease; a negative
 * delta is treated as 0).
 */
export function foldUsageUpdate(
  state: CostProjectionState,
  input: UsageUpdateFold,
): CostProjectionState {
  const vital: RoleVital = {
    contextUsedTokens: input.usedTokens,
    contextWindowSize: input.contextWindowSize,
  };
  let next: CostProjectionState = {
    ...state,
    roleVitals: { ...state.roleVitals, [input.role]: vital },
  };

  if (input.cost !== undefined) {
    const previous = next.sessionCumulativeCost[input.sessionKey] ?? 0;
    const delta = input.cost.amount - previous;
    const addCost = delta > 0 ? delta : 0;
    next = applyDelta(next, input.role, input.phase, { costUsd: addCost });
    next = {
      ...next,
      currency: input.cost.currency,
      sessionCumulativeCost: { ...next.sessionCumulativeCost, [input.sessionKey]: input.cost.amount },
      sessionsWithStreamedCost: { ...next.sessionsWithStreamedCost, [input.sessionKey]: true },
    };
  }

  return next;
}

export interface TurnUsageFold {
  readonly role: RoleName;
  readonly phase: RunPhase;
  readonly sessionKey: string;
  readonly usage: TurnUsage;
  /**
   * §17.2 D-2 conservative per-turn reservation (config
   * `budget.conservativeReservationUsd`). Folded as ESTIMATED cost ONLY when
   * the turn advertised token counts but no measured price and the session
   * never streamed a cumulative cost — i.e. subscription billing. Omitted (or
   * on a turn with a measured price) → no estimate, so measured spend is never
   * inflated.
   */
  readonly reservationUsd?: number;
}

/**
 * Fold one settled turn's `TurnUsage`: additive input/output tokens and a turn
 * tally. Per-turn MEASURED cost is added ONLY for sessions that never streamed a
 * cumulative `usage_update` cost (avoids double-counting the same spend). When a
 * turn did work (advertised tokens) but reported NO price and none was streamed,
 * a conservative reservation is folded as ESTIMATED cost instead of $0.00 (§17.2
 * D-2), so a subscription-billed run reports honest, non-zero per-role/per-phase
 * cost clearly labeled as an estimate.
 */
export function foldTurnUsage(
  state: CostProjectionState,
  input: TurnUsageFold,
): CostProjectionState {
  const streamed = state.sessionsWithStreamedCost[input.sessionKey] === true;
  const hasMeasuredCost = streamed || typeof input.usage.costUsd === 'number';
  const costUsd = !streamed && typeof input.usage.costUsd === 'number' ? input.usage.costUsd : 0;

  const advertisedTokens = (input.usage.inputTokens ?? 0) + (input.usage.outputTokens ?? 0) > 0;
  const estimatedCostUsd =
    !hasMeasuredCost && advertisedTokens && input.reservationUsd !== undefined && input.reservationUsd > 0
      ? input.reservationUsd
      : 0;

  return applyDelta(state, input.role, input.phase, {
    turns: 1,
    inputTokens: input.usage.inputTokens ?? 0,
    outputTokens: input.usage.outputTokens ?? 0,
    costUsd,
    estimatedCostUsd,
  });
}

// ---------------------------------------------------------------------------
// §17.2 estimated soft budget
// ---------------------------------------------------------------------------
/**
 * True when starting one more turn would push spend + a conservative per-turn
 * reservation past the estimated soft budget (§17.2). Spend counts BOTH the
 * measured cost AND the estimated (reservation-folded) cost of already-run
 * subscription turns (W1-F5): a run whose every turn is unpriced would
 * otherwise never trip the refusal no matter how many turns it burns. This is
 * the refusal predicate for `--max-budget`; it is never a hard ceiling.
 */
export function wouldExceedBudget(
  state: CostProjectionState,
  reservationUsd: number,
  maxBudgetUsd: number,
): boolean {
  return state.totalCostUsd + state.totalEstimatedCostUsd + reservationUsd > maxBudgetUsd;
}
