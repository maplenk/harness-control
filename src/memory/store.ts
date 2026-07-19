/**
 * In-memory MemoryEntry store (PLAN.md §15).
 *
 * Deterministic and dependency-free: no clock, no id generation, no I/O —
 * this is the in-process structure the selector (./selector.ts) reads from,
 * and the read/write shape a future SQLite-backed repository sits behind.
 * Entries are immutable content (redacted, content-hashed) per §15/§17.1;
 * the store itself never mutates a stored entry, only replaces-by-id.
 */
import type { MemoryEntry, MemoryScope } from '../domain/entities.js';
import { assertScopeShape, isVisibleTo, type ScopeQuery } from './scope.js';

export interface MemoryQuery extends ScopeQuery {
  /** Restrict to one MemoryType-independent scope tier; omit for all scopes visible to the query. */
  readonly scope?: MemoryScope;
}

export class MemoryStore {
  readonly #entries = new Map<string, MemoryEntry>();

  /** Insert, or idempotently replace-by-id (e.g. safe to re-apply on replay). */
  add(entry: MemoryEntry): void {
    assertScopeShape(entry);
    this.#entries.set(String(entry.id), entry);
  }

  addMany(entries: Iterable<MemoryEntry>): void {
    for (const entry of entries) this.add(entry);
  }

  get(id: MemoryEntry['id']): MemoryEntry | undefined {
    return this.#entries.get(String(id));
  }

  /** All entries. No ordering is promised beyond insertion order; the
   * selector (./selector.ts) is responsible for ranking. */
  all(): readonly MemoryEntry[] {
    return [...this.#entries.values()];
  }

  /** Entries visible to `query` per §15 scope rules (run|role|project, no global). */
  visibleTo(query: MemoryQuery): readonly MemoryEntry[] {
    return this.all().filter(
      (entry) =>
        (query.scope === undefined || entry.scope === query.scope) && isVisibleTo(entry, query),
    );
  }

  size(): number {
    return this.#entries.size;
  }
}
