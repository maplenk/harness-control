/**
 * Shared test scaffolding for the memory store/selector tests. NOT a test
 * file itself (no top-level `describe`/`it`) — vitest's default include
 * pattern only picks up `*.test.ts`, so this module is safe to import from
 * every `*.test.ts` file in this package without being run as its own
 * (empty) suite. (Mirrors src/persistence/test-support.ts's convention.)
 */
import type { MemoryEntry, MemoryScope, MemoryTrust, MemoryType } from '../domain/entities.js';
import { artifactHash, memoryEntryId, runId, type ArtifactHash, type MemoryEntryId, type RunId } from '../domain/ids.js';
import type { RoleName } from '../domain/state.js';
import { isoTimestamp, type IsoTimestamp } from '../lib/clock.js';

export const DEFAULT_RUN: RunId = runId('run_mem_001');
export const OTHER_RUN: RunId = runId('run_mem_002');
export const DEFAULT_ROLE: RoleName = 'implementor';
export const OTHER_ROLE: RoleName = 'verifier';
export const DEFAULT_NOW: IsoTimestamp = isoTimestamp('2026-07-18T12:00:00.000Z');

let counter = 0;

/** Resets the fixture id/hash counter — call in `beforeEach` for readable, stable ids per test. */
export function resetMemoryFixtureCounter(): void {
  counter = 0;
}

export interface MakeEntryOptions {
  readonly id?: string;
  readonly type?: MemoryType;
  readonly scope?: MemoryScope;
  /** Explicit `undefined` is meaningful for `scope: 'project'` fixtures (omits runId entirely). */
  readonly runId?: RunId | undefined;
  readonly role?: RoleName | undefined;
  readonly trust?: MemoryTrust;
  readonly content?: string;
  readonly createdAt?: IsoTimestamp;
  readonly expiresAt?: IsoTimestamp;
  readonly contentHash?: ArtifactHash;
}

/**
 * Builds a valid MemoryEntry fixture with sensible defaults; every field is
 * overridable. Defaults: scope 'run' under DEFAULT_RUN, type 'fact', trust
 * 'trusted', createdAt DEFAULT_NOW. `role` scope defaults to DEFAULT_ROLE;
 * `project` scope defaults to no runId/role.
 */
export function makeMemoryEntry(options: MakeEntryOptions = {}): MemoryEntry {
  counter += 1;
  const id: MemoryEntryId = memoryEntryId(options.id ?? `mem_${String(counter).padStart(6, '0')}`);
  const scope = options.scope ?? 'run';
  const resolvedRunId =
    options.runId !== undefined ? options.runId : scope === 'project' ? undefined : DEFAULT_RUN;
  const resolvedRole =
    options.role !== undefined ? options.role : scope === 'role' ? DEFAULT_ROLE : undefined;

  return {
    id,
    type: options.type ?? 'fact',
    scope,
    trust: options.trust ?? 'trusted',
    contentHash: options.contentHash ?? artifactHash(`hash_${String(counter).padStart(6, '0')}`),
    content: options.content ?? `entry-${counter}`,
    createdAt: options.createdAt ?? DEFAULT_NOW,
    ...(options.expiresAt !== undefined ? { expiresAt: options.expiresAt } : {}),
    ...(resolvedRunId !== undefined ? { runId: resolvedRunId } : {}),
    ...(resolvedRole !== undefined ? { role: resolvedRole } : {}),
  };
}
