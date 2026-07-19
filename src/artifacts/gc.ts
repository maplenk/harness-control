/**
 * Reference-aware GC support (PLAN.md §12.1 "reference-aware artifact GC";
 * §12.2 atomicity: "artifact-without-event is invisible to replay and
 * GC'd"). This module computes the LIVE set from committed events; the
 * actual sweep (filesystem removal) is `ArtifactStore.gcSweep` in store.ts,
 * which simply deletes anything not in the live set.
 */
import type { ArtifactHash } from '../domain/ids.js';
import type { DomainEvent } from '../domain/events.js';

/**
 * Property-name pattern for fields that carry ArtifactHash value(s) across
 * the domain vocabulary (`checkpoint.recorded.artifactHash`,
 * `SpecVersion.contentArtifact`, `CheckpointContent.artifactRefs`,
 * `CriterionResult.evidenceRefs`, `WorktreeState.diffHash`, ...). Branding
 * (`Brand<Base, Tag>`, see lib/brand.ts) is compile-time-only and costs
 * nothing at runtime, so at the JS-value level an ArtifactHash IS just a
 * string — reference collection over persisted/serialized data is
 * necessarily structural (name-based), not type-based.
 */
export const ARTIFACT_HASH_FIELD_RE = /(artifactHash|artifactRefs|evidenceRefs|contentArtifact|diffHash)$/i;

const MAX_WALK_DEPTH = 12;

function collectFrom(
  value: unknown,
  keyPattern: RegExp,
  out: Set<string>,
  depth: number,
  parentKeyMatched: boolean,
): void {
  if (depth > MAX_WALK_DEPTH || value === null || value === undefined) return;
  if (typeof value === 'string') {
    if (parentKeyMatched && value.length > 0) out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFrom(item, keyPattern, out, depth + 1, parentKeyMatched);
    return;
  }
  if (typeof value === 'object') {
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      collectFrom(val, keyPattern, out, depth + 1, keyPattern.test(key));
    }
  }
}

/**
 * Structurally collect every ArtifactHash referenced by a set of committed
 * events. Heuristic: any string value reachable under a property whose name
 * matches `keyPattern` (default `ARTIFACT_HASH_FIELD_RE`) is treated as
 * live. Pass ONLY events that actually made it into the committed log —
 * this is exactly what makes the crash-before-event scenario (§19 test 23)
 * correct: an artifact whose referencing event never committed is simply
 * absent from `events`, so its hash is absent here too, so
 * `ArtifactStore.gcSweep` reclaims it.
 */
export function collectReferencedArtifactHashes(
  events: readonly DomainEvent[],
  keyPattern: RegExp = ARTIFACT_HASH_FIELD_RE,
): ReadonlySet<ArtifactHash> {
  const out = new Set<string>();
  for (const event of events) {
    collectFrom(event.payload, keyPattern, out, 0, false);
  }
  return out as unknown as ReadonlySet<ArtifactHash>;
}
