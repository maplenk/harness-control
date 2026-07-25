/**
 * B3 — the READ boundary for a persisted execution mode.
 *
 * This is an event-sourced store: it holds records written by every prior
 * version of this code, and every one of them predates execution modes. The
 * failure this closes is the one `migrateMergeReadinessBlockedState` (F13)
 * already paid for once — a reader that treats persisted JSON as a
 * current-shape object turns a resumable run into a stranded one.
 */
import { describe, expect, it } from 'vitest';
import { assignmentId, gitSha } from '../domain/ids.js';
import { isoTimestamp } from '../lib/clock.js';
import {
  DEFAULT_EXECUTION_MODE,
  EXECUTION_MODES,
  isExecutionMode,
  resolveExecutionMode,
} from '../domain/execution-mode.js';
import { resolvePersistedExecutionMode, type WorktreeFactsState } from './projections.js';
import type { InPlaceCheckpoint } from '../worktree/in-place.js';

const CHECKPOINT: InPlaceCheckpoint = {
  rootPath: '/repo',
  baseSha: gitSha('a'.repeat(40)),
  headRef: 'main',
  headRefKind: 'branch',
  entryPorcelainDigest: 'd',
  branch: 'harness/assignment/asg_a',
  createdAt: isoTimestamp('2026-07-26T00:00:00.000Z'),
};

function facts(overrides: Partial<WorktreeFactsState> = {}): WorktreeFactsState {
  return {
    assignmentId: assignmentId('asg_a'),
    repoRoot: '/repo',
    worktreePath: '/repo',
    branch: 'harness/assignment/asg_a',
    baseSha: gitSha('a'.repeat(40)),
    createdAt: isoTimestamp('2026-07-26T00:00:00.000Z'),
    ...overrides,
  };
}

describe('resolveExecutionMode — absence has exactly one honest meaning', () => {
  it('maps undefined to `worktree` (the status quo, and what every old record was)', () => {
    expect(resolveExecutionMode(undefined)).toBe('worktree');
    expect(DEFAULT_EXECUTION_MODE).toBe('worktree');
  });

  it('never throws on a record from the future or a corrupted one', () => {
    for (const junk of [null, 42, {}, [], 'IN_PLACE', 'in place', { mode: 'in_place' }]) {
      expect(resolveExecutionMode(junk)).toBe('worktree');
    }
  });

  it('accepts exactly the closed vocabulary', () => {
    for (const mode of EXECUTION_MODES) {
      expect(resolveExecutionMode(mode)).toBe(mode);
      expect(isExecutionMode(mode)).toBe(true);
    }
    expect(isExecutionMode('yolo')).toBe(false);
  });
});

describe('resolvePersistedExecutionMode — worktree facts', () => {
  it('a pre-B3 record (no mode field at all) resolves to worktree', () => {
    expect(resolvePersistedExecutionMode(facts())).toBe('worktree');
  });

  it('no facts at all resolves to worktree rather than crashing', () => {
    expect(resolvePersistedExecutionMode(undefined)).toBe('worktree');
  });

  it('an in_place record WITH its start checkpoint resolves to in_place', () => {
    expect(resolvePersistedExecutionMode(facts({ executionMode: 'in_place', inPlaceCheckpoint: CHECKPOINT }))).toBe(
      'in_place',
    );
  });

  it('an in_place record WITHOUT a checkpoint is DOWNGRADED, never trusted', () => {
    // An in-place workspace whose revert target was not durably recorded cannot
    // be resumed as in-place: arming `reset --hard` against a target nobody
    // wrote down is exactly the destruction the checkpoint exists to prevent.
    // Degrading to `worktree` makes the destructive paths refuse instead.
    expect(resolvePersistedExecutionMode(facts({ executionMode: 'in_place' }))).toBe('worktree');
  });

  it('a garbage mode with a checkpoint present is still worktree', () => {
    expect(
      resolvePersistedExecutionMode(facts({ executionMode: 'in-place', inPlaceCheckpoint: CHECKPOINT })),
    ).toBe('worktree');
  });
});
