import { describe, expect, it } from 'vitest';
import { ManualClock, SystemClock, isoTimestamp } from './clock.js';
import { DeterministicIdFactory } from './id-factory.js';
import { err, isErr, isOk, ok, unwrap } from './result.js';

describe('ManualClock', () => {
  it('is fixed until advanced explicitly', () => {
    const clock = new ManualClock('2026-07-18T00:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-07-18T00:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-07-18T00:00:00.000Z');
    clock.advanceMs(90_000);
    expect(clock.nowIso()).toBe('2026-07-18T00:01:30.000Z');
    expect(clock.nowMs()).toBe(Date.parse('2026-07-18T00:01:30.000Z'));
  });

  it('rejects negative advances and invalid starts', () => {
    expect(() => new ManualClock('not-a-date')).toThrow();
    expect(() => new ManualClock().advanceMs(-1)).toThrow();
  });
});

describe('SystemClock', () => {
  it('produces a parseable ISO timestamp', () => {
    expect(() => isoTimestamp(new SystemClock().nowIso())).not.toThrow();
  });
});

describe('DeterministicIdFactory', () => {
  it('produces stable per-kind sequences', () => {
    const ids = new DeterministicIdFactory();
    expect(ids.nextId('run')).toBe('run_000001');
    expect(ids.nextId('seg')).toBe('seg_000001');
    expect(ids.nextId('seg')).toBe('seg_000002');
    expect(ids.nextId('run')).toBe('run_000002');
    ids.reset();
    expect(ids.nextId('run')).toBe('run_000001');
  });
});

describe('Result', () => {
  it('narrows and unwraps', () => {
    const good = ok(42);
    const bad = err('boom');
    expect(isOk(good)).toBe(true);
    expect(isErr(bad)).toBe(true);
    expect(unwrap(good)).toBe(42);
    expect(() => unwrap(bad)).toThrow(/boom/);
  });
});
