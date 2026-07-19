/**
 * Deterministic canonical JSON serialization for checkpoint content.
 *
 * Object keys are sorted recursively so that logically-identical content
 * ALWAYS produces the same string — and therefore the same content hash —
 * no matter what order the caller happened to build the object in. This is
 * what makes §14's no-progress detector meaningful ("identical
 * checkpoint content-hash across 2 consecutive restarts → breaker"): a
 * spurious key-order difference must never look like a content difference,
 * and a real content difference must always change the hash.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) out[key] = canonicalize(val);
    return out;
  }
  return value;
}
