import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryStore } from './store.js';
import {
  DEFAULT_ROLE,
  DEFAULT_RUN,
  OTHER_ROLE,
  OTHER_RUN,
  makeMemoryEntry,
  resetMemoryFixtureCounter,
} from './test-support.js';

beforeEach(() => {
  resetMemoryFixtureCounter();
});

describe('MemoryStore basic operations', () => {
  it('adds and retrieves entries by id', () => {
    const store = new MemoryStore();
    const entry = makeMemoryEntry();
    store.add(entry);
    expect(store.get(entry.id)).toEqual(entry);
    expect(store.size()).toBe(1);
  });

  it('replaces an entry when re-added with the same id (idempotent re-apply on replay)', () => {
    const store = new MemoryStore();
    const entry = makeMemoryEntry({ id: 'mem_dup', content: 'v1' });
    store.add(entry);
    store.add({ ...entry, content: 'v2' });
    expect(store.size()).toBe(1);
    expect(store.get(entry.id)?.content).toBe('v2');
  });

  it('addMany inserts a batch', () => {
    const store = new MemoryStore();
    store.addMany([makeMemoryEntry(), makeMemoryEntry(), makeMemoryEntry()]);
    expect(store.size()).toBe(3);
    expect(store.all()).toHaveLength(3);
  });

  it('returns undefined for a missing id', () => {
    const store = new MemoryStore();
    expect(store.get(makeMemoryEntry().id)).toBeUndefined();
  });
});

describe('MemoryStore scope shape validation (PLAN §15: run/role scope must carry identifiers)', () => {
  it('rejects a run-scoped entry with no runId', () => {
    const store = new MemoryStore();
    // Destructure the (optional) field OUT rather than setting it to
    // `undefined` — exactOptionalPropertyTypes forbids the latter, and the
    // former is exactly the "field absent" shape the guard checks for.
    const { runId: _runId, ...malformed } = makeMemoryEntry({ scope: 'run' });
    expect(() => store.add(malformed)).toThrow(/scope 'run' requires runId/);
  });

  it('rejects a role-scoped entry missing runId or role', () => {
    const store = new MemoryStore();
    const { role: _role, ...missingRole } = makeMemoryEntry({ scope: 'role' });
    expect(() => store.add(missingRole)).toThrow(/scope 'role' requires runId and role/);

    const { runId: _runId, ...missingRun } = makeMemoryEntry({ scope: 'role' });
    expect(() => store.add(missingRun)).toThrow(/scope 'role' requires runId and role/);
  });

  it('accepts a project-scoped entry with no runId/role', () => {
    const store = new MemoryStore();
    expect(() => store.add(makeMemoryEntry({ scope: 'project', runId: undefined }))).not.toThrow();
  });
});

describe('MemoryStore.visibleTo (PLAN §15 scope: run|role|project, no global)', () => {
  it('project-scoped entries are visible regardless of runId/role', () => {
    const store = new MemoryStore();
    const project = makeMemoryEntry({ scope: 'project', runId: undefined });
    store.add(project);
    expect(store.visibleTo({ runId: DEFAULT_RUN, role: DEFAULT_ROLE })).toEqual([project]);
    expect(store.visibleTo({ runId: OTHER_RUN, role: OTHER_ROLE })).toEqual([project]);
    expect(store.visibleTo({})).toEqual([project]);
  });

  it('run-scoped entries are visible only within the same run', () => {
    const store = new MemoryStore();
    const mine = makeMemoryEntry({ scope: 'run', runId: DEFAULT_RUN });
    const theirs = makeMemoryEntry({ scope: 'run', runId: OTHER_RUN });
    store.addMany([mine, theirs]);
    expect(store.visibleTo({ runId: DEFAULT_RUN, role: DEFAULT_ROLE })).toEqual([mine]);
    expect(store.visibleTo({ runId: OTHER_RUN, role: DEFAULT_ROLE })).toEqual([theirs]);
    expect(store.visibleTo({ role: DEFAULT_ROLE })).toEqual([]); // no runId at all → matches neither
  });

  it('role-scoped entries require both the same run AND the same role', () => {
    const store = new MemoryStore();
    const mine = makeMemoryEntry({ scope: 'role', runId: DEFAULT_RUN, role: DEFAULT_ROLE });
    store.add(mine);
    expect(store.visibleTo({ runId: DEFAULT_RUN, role: DEFAULT_ROLE })).toEqual([mine]);
    expect(store.visibleTo({ runId: DEFAULT_RUN, role: OTHER_ROLE })).toEqual([]);
    expect(store.visibleTo({ runId: OTHER_RUN, role: DEFAULT_ROLE })).toEqual([]);
  });

  it('the optional `scope` filter narrows independently of run/role matching', () => {
    const store = new MemoryStore();
    const project = makeMemoryEntry({ scope: 'project', runId: undefined });
    const run = makeMemoryEntry({ scope: 'run', runId: DEFAULT_RUN });
    store.addMany([project, run]);
    expect(store.visibleTo({ runId: DEFAULT_RUN, role: DEFAULT_ROLE, scope: 'project' })).toEqual([
      project,
    ]);
    expect(store.visibleTo({ runId: DEFAULT_RUN, role: DEFAULT_ROLE, scope: 'run' })).toEqual([run]);
  });
});
