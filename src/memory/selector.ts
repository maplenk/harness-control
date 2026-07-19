/**
 * Deterministic memory selection (PLAN.md §15; ranking language normative in
 * both §15 and the Rev 1 source it carries forward, docs/archive/PLAN-v1-codex.md
 * §13). Rules, applied in order:
 *
 *  1. Reject entries that are expired (relative to an injected `now`) or
 *     out of scope for the requesting (runId, role) — unconditional, before
 *     anything else. An entry can be BOTH expired and out of scope; it is
 *     reported once, under 'expired' (checked first).
 *  2. Approved constraints are ALWAYS preserved — exempt from the budget
 *     cutoff (rule 5) entirely, though they still count against `usedChars`
 *     for honest accounting. §15 says "always preserve approved constraints
 *     + criteria"; `MemoryType` (domain/entities.ts) has no separate
 *     `criterion` literal, so acceptance criteria projected into memory are
 *     modeled as `type: 'constraint'` entries — every surviving `constraint`
 *     entry is tier 0, whether it originated from an approved constraint or
 *     a criterion.
 *  3. Remaining entries rank into tiers: trusted decisions > current
 *     failures > evidence > everything else. §15's five MemoryTypes are
 *     `constraint | decision | fact | risk | evidence`; "current failures"
 *     has no dedicated literal, so this selector treats `type: 'risk'` (an
 *     open/active risk to the run) as that tier — the closest first-class
 *     representation available. Untrusted decisions and background `fact`
 *     entries are not named by §15's ranking sentence, so they fall to the
 *     lowest (first-cut) tier rather than being silently dropped.
 *  4. Within a tier, entries sort by (createdAt DESC, id ASC): newest first
 *     so budget pressure drops stale context before fresh context, with id
 *     as the final deterministic tie-break for equal timestamps — "stable"
 *     in the sense of being reproducible, not dependent on input/map order.
 *  5. Walk tiers in priority order accumulating `content.length` (character
 *     budget, §15's MVP-tight token/char cutoff); stop admitting once the
 *     per-role budget would be exceeded. Tier 0 is exempt (rule 2).
 *
 * Pure and deterministic: `now` and `budgetChars` are injected — never a
 * direct clock read — so calling this twice with the same input is
 * byte-for-byte identical (see selector.test.ts).
 */
import type { IsoTimestamp } from '../lib/clock.js';
import type { MemoryEntry } from '../domain/entities.js';
import type { RunId } from '../domain/ids.js';
import type { RoleName } from '../domain/state.js';
import { isVisibleTo } from './scope.js';

export type MemoryRejectionReason = 'expired' | 'out_of_scope' | 'budget_exhausted';

export interface RejectedMemoryEntry {
  readonly entry: MemoryEntry;
  readonly reason: MemoryRejectionReason;
}

export interface MemorySelectorContext {
  readonly runId: RunId;
  readonly role: RoleName;
  /** Injected "now" for expiry checks (determinism rule: no Date.now() here). */
  readonly now: IsoTimestamp;
  /** Per-role context budget in characters (§15 rule 5; MVP uses chars, not tokens). */
  readonly budgetChars: number;
}

export interface MemorySelection {
  readonly selected: readonly MemoryEntry[];
  readonly rejected: readonly RejectedMemoryEntry[];
  readonly usedChars: number;
  readonly budgetChars: number;
}

/** Tier 0 = always preserved; 1..4 = descending priority, budget-limited. */
type Tier = 0 | 1 | 2 | 3 | 4;
const RANKED_TIERS = [1, 2, 3, 4] as const;

function isExpired(entry: MemoryEntry, nowMs: number): boolean {
  if (entry.expiresAt === undefined) return false;
  return Date.parse(entry.expiresAt) <= nowMs;
}

function tierOf(entry: MemoryEntry): Tier {
  if (entry.type === 'constraint') return 0; // constraints + criteria (§15 rule 2)
  if (entry.type === 'decision' && entry.trust === 'trusted') return 1; // trusted decisions
  if (entry.type === 'risk') return 2; // current failures
  if (entry.type === 'evidence') return 3; // evidence
  return 4; // untrusted decisions + fact: unnamed by §15, lowest priority
}

function compareWithinTier(a: MemoryEntry, b: MemoryEntry): number {
  const byRecency = Date.parse(b.createdAt) - Date.parse(a.createdAt); // newest first
  if (byRecency !== 0) return byRecency;
  const aId = String(a.id);
  const bId = String(b.id);
  if (aId < bId) return -1;
  if (aId > bId) return 1;
  return 0;
}

export function selectMemory(
  entries: readonly MemoryEntry[],
  ctx: MemorySelectorContext,
): MemorySelection {
  const nowMs = Date.parse(ctx.now);
  if (Number.isNaN(nowMs)) {
    throw new Error(`MemorySelectorContext.now is not a parseable timestamp: ${ctx.now}`);
  }
  if (!Number.isInteger(ctx.budgetChars) || ctx.budgetChars < 0) {
    throw new Error(`budgetChars must be a non-negative integer, got ${ctx.budgetChars}`);
  }

  // Rule 1: reject expired/out-of-scope, unconditionally and first.
  const rejected: RejectedMemoryEntry[] = [];
  const survivors: MemoryEntry[] = [];
  for (const entry of entries) {
    if (isExpired(entry, nowMs)) {
      rejected.push({ entry, reason: 'expired' });
      continue;
    }
    if (!isVisibleTo(entry, { runId: ctx.runId, role: ctx.role })) {
      rejected.push({ entry, reason: 'out_of_scope' });
      continue;
    }
    survivors.push(entry);
  }

  // Rules 2-3: bucket survivors into priority tiers.
  const byTier = new Map<Tier, MemoryEntry[]>();
  for (const entry of survivors) {
    const tier = tierOf(entry);
    const bucket = byTier.get(tier);
    if (bucket) bucket.push(entry);
    else byTier.set(tier, [entry]);
  }
  // Rule 4: stable (createdAt desc, id asc) order within each tier.
  for (const bucket of byTier.values()) bucket.sort(compareWithinTier);

  const selected: MemoryEntry[] = [];
  let usedChars = 0;

  // Tier 0 (constraints + criteria): always preserved, exempt from budget.
  for (const entry of byTier.get(0) ?? []) {
    selected.push(entry);
    usedChars += entry.content.length;
  }

  // Rule 5: remaining tiers, ranked, budget-limited.
  for (const tier of RANKED_TIERS) {
    for (const entry of byTier.get(tier) ?? []) {
      const size = entry.content.length;
      if (usedChars + size <= ctx.budgetChars) {
        selected.push(entry);
        usedChars += size;
      } else {
        rejected.push({ entry, reason: 'budget_exhausted' });
      }
    }
  }

  return { selected, rejected, usedChars, budgetChars: ctx.budgetChars };
}
