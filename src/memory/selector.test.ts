import { beforeEach, describe, expect, it } from 'vitest';
import { isoTimestamp } from '../lib/clock.js';
import { selectMemory, type MemorySelectorContext } from './selector.js';
import {
  DEFAULT_ROLE,
  DEFAULT_RUN,
  OTHER_ROLE,
  OTHER_RUN,
  makeMemoryEntry,
  resetMemoryFixtureCounter,
} from './test-support.js';

const NOW = isoTimestamp('2026-07-18T12:00:00.000Z');
const BEFORE_NOW = isoTimestamp('2026-07-18T11:00:00.000Z');
const AFTER_NOW = isoTimestamp('2026-07-18T13:00:00.000Z');

function ctx(budgetChars: number, overrides: Partial<MemorySelectorContext> = {}): MemorySelectorContext {
  return { runId: DEFAULT_RUN, role: DEFAULT_ROLE, now: NOW, budgetChars, ...overrides };
}

function idsOf(entries: readonly { readonly id: unknown }[]): unknown[] {
  return entries.map((e) => e.id);
}

beforeEach(() => {
  resetMemoryFixtureCounter();
});

describe('rule 1: expired/out-of-scope rejection (PLAN §15)', () => {
  it('rejects an entry whose expiresAt has passed, with reason "expired"', () => {
    const expired = makeMemoryEntry({ type: 'fact', expiresAt: BEFORE_NOW, content: 'stale' });
    const fresh = makeMemoryEntry({ type: 'fact', expiresAt: AFTER_NOW, content: 'fresh' });
    const result = selectMemory([expired, fresh], ctx(1000));
    expect(result.selected).toEqual([fresh]);
    expect(result.rejected).toEqual([{ entry: expired, reason: 'expired' }]);
  });

  it('treats expiresAt exactly equal to now as expired (inclusive boundary)', () => {
    const entry = makeMemoryEntry({ type: 'fact', expiresAt: NOW });
    const result = selectMemory([entry], ctx(1000));
    expect(result.rejected).toEqual([{ entry, reason: 'expired' }]);
  });

  it('entries with no expiresAt never expire', () => {
    const entry = makeMemoryEntry({ type: 'fact' });
    const result = selectMemory([entry], ctx(1000));
    expect(result.selected).toEqual([entry]);
  });

  it('rejects run-scoped entries from a different run, reason "out_of_scope"', () => {
    const mine = makeMemoryEntry({ scope: 'run', runId: DEFAULT_RUN, type: 'fact' });
    const theirs = makeMemoryEntry({ scope: 'run', runId: OTHER_RUN, type: 'fact' });
    const result = selectMemory([mine, theirs], ctx(1000));
    expect(result.selected).toEqual([mine]);
    expect(result.rejected).toEqual([{ entry: theirs, reason: 'out_of_scope' }]);
  });

  it('rejects role-scoped entries from a different role in the same run', () => {
    const mine = makeMemoryEntry({ scope: 'role', runId: DEFAULT_RUN, role: DEFAULT_ROLE, type: 'fact' });
    const theirs = makeMemoryEntry({ scope: 'role', runId: DEFAULT_RUN, role: OTHER_ROLE, type: 'fact' });
    const result = selectMemory([mine, theirs], ctx(1000));
    expect(result.selected).toEqual([mine]);
    expect(result.rejected).toEqual([{ entry: theirs, reason: 'out_of_scope' }]);
  });

  it('project-scoped entries are visible across every run/role', () => {
    const entry = makeMemoryEntry({ scope: 'project', runId: undefined, type: 'fact' });
    const result = selectMemory([entry], ctx(1000, { runId: OTHER_RUN, role: OTHER_ROLE }));
    expect(result.selected).toEqual([entry]);
  });

  it('an entry that is both expired AND out of scope is reported once, as "expired"', () => {
    const entry = makeMemoryEntry({
      scope: 'run',
      runId: OTHER_RUN,
      type: 'fact',
      expiresAt: BEFORE_NOW,
    });
    const result = selectMemory([entry], ctx(1000));
    expect(result.rejected).toEqual([{ entry, reason: 'expired' }]);
  });
});

describe('PLAN §19 test 16: selection preserves criteria/constraints/decisions/failures/evidence under tight budgets', () => {
  // One fixture per named §15 category, each exactly 10 characters, so
  // budgets can be reasoned about as "N tens". "criteria" and "constraints"
  // both project onto `type: 'constraint'` (see selector.ts's doc comment
  // for why — MemoryType has no separate `criterion` literal); "current
  // failures" is represented by `type: 'risk'`.
  const constraint = makeMemoryEntry({ type: 'constraint', content: 'constraint', id: 'mem_c1' });
  const criterion = makeMemoryEntry({ type: 'constraint', content: 'criterionX', id: 'mem_c2' });
  const decision = makeMemoryEntry({
    type: 'decision',
    trust: 'trusted',
    content: 'decisionXX',
    id: 'mem_d1',
  });
  const failure = makeMemoryEntry({ type: 'risk', content: 'failureXXX', id: 'mem_r1' });
  const evidence = makeMemoryEntry({ type: 'evidence', content: 'evidenceXX', id: 'mem_e1' });
  const all = [constraint, criterion, decision, failure, evidence];

  it('a budget that exactly fits one of each keeps all five and rejects none', () => {
    const result = selectMemory(all, ctx(50));
    expect(new Set(idsOf(result.selected))).toEqual(new Set(idsOf(all)));
    expect(result.rejected).toEqual([]);
    expect(result.usedChars).toBe(50);
  });

  it('an impossibly tight budget still keeps constraints AND criteria (rule 2: always preserved)', () => {
    const result = selectMemory(all, ctx(0));
    expect(result.selected).toEqual([constraint, criterion]);
    expect(result.usedChars).toBe(20); // tier 0 is exempt from the cutoff, not from accounting
    expect(result.rejected).toHaveLength(3);
    expect(result.rejected.every((r) => r.reason === 'budget_exhausted')).toBe(true);
  });

  it('budget for constraints + one more admits the highest remaining tier (trusted decision) first', () => {
    const result = selectMemory(all, ctx(30)); // 20 (tier0) + 10
    expect(result.selected).toEqual([constraint, criterion, decision]);
    expect(result.rejected).toEqual([
      { entry: failure, reason: 'budget_exhausted' },
      { entry: evidence, reason: 'budget_exhausted' },
    ]);
  });

  it('budget for constraints + two more admits decision then failure, still cutting evidence', () => {
    const result = selectMemory(all, ctx(40)); // 20 (tier0) + 10 + 10
    expect(result.selected).toEqual([constraint, criterion, decision, failure]);
    expect(result.rejected).toEqual([{ entry: evidence, reason: 'budget_exhausted' }]);
  });
});

describe('rule 3: untrusted decisions and background facts rank below the named tiers', () => {
  it('an untrusted decision is cut before evidence when budget is tight', () => {
    const evidence = makeMemoryEntry({ type: 'evidence', content: '0123456789', id: 'mem_e1' });
    const untrustedDecision = makeMemoryEntry({
      type: 'decision',
      trust: 'untrusted',
      content: '0123456789',
      id: 'mem_d1',
    });
    const result = selectMemory([untrustedDecision, evidence], ctx(10));
    expect(result.selected).toEqual([evidence]);
    expect(result.rejected).toEqual([{ entry: untrustedDecision, reason: 'budget_exhausted' }]);
  });

  it('a background fact is cut before evidence when budget is tight', () => {
    const evidence = makeMemoryEntry({ type: 'evidence', content: '0123456789', id: 'mem_e1' });
    const fact = makeMemoryEntry({ type: 'fact', content: '0123456789', id: 'mem_f1' });
    const result = selectMemory([fact, evidence], ctx(10));
    expect(result.selected).toEqual([evidence]);
    expect(result.rejected).toEqual([{ entry: fact, reason: 'budget_exhausted' }]);
  });
});

describe('rule 4: stable, deterministic tie-break within a tier', () => {
  it('same-tier, same-timestamp entries order by id ascending, regardless of input order', () => {
    const a = makeMemoryEntry({ type: 'evidence', createdAt: NOW, id: 'mem_aaa', content: 'x' });
    const z = makeMemoryEntry({ type: 'evidence', createdAt: NOW, id: 'mem_zzz', content: 'x' });

    const forward = selectMemory([z, a], ctx(1000));
    const reversed = selectMemory([a, z], ctx(1000));
    expect(idsOf(forward.selected)).toEqual(['mem_aaa', 'mem_zzz']);
    expect(idsOf(reversed.selected)).toEqual(['mem_aaa', 'mem_zzz']);
  });

  it('newer entries outrank older same-tier entries under a budget that fits only one', () => {
    const older = makeMemoryEntry({
      type: 'evidence',
      createdAt: BEFORE_NOW,
      id: 'mem_aaa', // alphabetically first — must lose to recency anyway
      content: '0123456789',
    });
    const newer = makeMemoryEntry({
      type: 'evidence',
      createdAt: AFTER_NOW,
      id: 'mem_zzz',
      content: '0123456789',
    });
    const result = selectMemory([older, newer], ctx(10));
    expect(result.selected).toEqual([newer]);
    expect(result.rejected).toEqual([{ entry: older, reason: 'budget_exhausted' }]);
  });
});

describe('accounting and validation', () => {
  it('reports usedChars/budgetChars honestly when nothing is rejected', () => {
    const entry = makeMemoryEntry({ type: 'constraint', content: 'abcde' });
    const result = selectMemory([entry], ctx(100));
    expect(result.usedChars).toBe(5);
    expect(result.budgetChars).toBe(100);
  });

  it('rejects a negative or non-integer budget', () => {
    expect(() => selectMemory([], ctx(-1))).toThrow(/non-negative integer/);
    expect(() => selectMemory([], ctx(1.5))).toThrow(/non-negative integer/);
  });

  it('rejects an unparseable `now`', () => {
    // @ts-expect-error deliberately invalid input at the boundary
    expect(() => selectMemory([], ctx(10, { now: 'not-a-timestamp' }))).toThrow(/not a parseable timestamp/);
  });
});

describe('determinism', () => {
  it('never mutates its input and produces byte-identical output across repeated calls', () => {
    const entries = [
      makeMemoryEntry({ type: 'constraint', content: 'c' }),
      makeMemoryEntry({ type: 'decision', trust: 'trusted', content: 'd' }),
      makeMemoryEntry({ type: 'risk', content: 'r' }),
      makeMemoryEntry({ type: 'evidence', content: 'e' }),
      makeMemoryEntry({ type: 'fact', content: 'f' }),
    ];
    const before = JSON.stringify(entries);
    const context = ctx(2);
    const a = selectMemory(entries, context);
    const b = selectMemory(entries, context);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(entries)).toBe(before);
  });
});
