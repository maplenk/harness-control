/**
 * PLAN.md §14 "Concurrency": simple max-live-children guard (default 3).
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_LIVE_CHILDREN,
  MaxLiveChildrenExceededError,
  MaxLiveChildrenGuard,
} from './concurrency.js';

describe('MaxLiveChildrenGuard', () => {
  it('defaults to a max of 3 (§14)', () => {
    const guard = new MaxLiveChildrenGuard();
    expect(guard.max).toBe(3);
    expect(DEFAULT_MAX_LIVE_CHILDREN).toBe(3);
  });

  it('acquire() admits up to the max and rejects beyond it', () => {
    const guard = new MaxLiveChildrenGuard({ maxLiveChildren: 2 });
    expect(guard.acquire('a')).toBe(true);
    expect(guard.acquire('b')).toBe(true);
    expect(guard.canSpawn()).toBe(false);
    expect(guard.acquire('c')).toBe(false);
    expect(guard.liveCount).toBe(2);
  });

  it('acquire() is idempotent for an already-live key (does not double-count against the cap)', () => {
    const guard = new MaxLiveChildrenGuard({ maxLiveChildren: 1 });
    expect(guard.acquire('a')).toBe(true);
    expect(guard.acquire('a')).toBe(true);
    expect(guard.liveCount).toBe(1);
  });

  it('release() frees a slot for a subsequent acquire()', () => {
    const guard = new MaxLiveChildrenGuard({ maxLiveChildren: 1 });
    expect(guard.acquire('a')).toBe(true);
    expect(guard.acquire('b')).toBe(false);
    guard.release('a');
    expect(guard.acquire('b')).toBe(true);
    expect(guard.liveKeys).toEqual(['b']);
  });

  it('requireCapacity() throws MaxLiveChildrenExceededError at capacity instead of returning false', () => {
    const guard = new MaxLiveChildrenGuard({ maxLiveChildren: 1 });
    guard.requireCapacity('a');
    expect(() => guard.requireCapacity('b')).toThrow(MaxLiveChildrenExceededError);
    try {
      guard.requireCapacity('b');
    } catch (error) {
      expect(error).toBeInstanceOf(MaxLiveChildrenExceededError);
      expect((error as MaxLiveChildrenExceededError).max).toBe(1);
      expect((error as MaxLiveChildrenExceededError).current).toBe(1);
    }
  });

  it('rejects a non-positive-integer maxLiveChildren at construction', () => {
    expect(() => new MaxLiveChildrenGuard({ maxLiveChildren: 0 })).toThrow();
    expect(() => new MaxLiveChildrenGuard({ maxLiveChildren: -1 })).toThrow();
    expect(() => new MaxLiveChildrenGuard({ maxLiveChildren: 1.5 })).toThrow();
  });
});
