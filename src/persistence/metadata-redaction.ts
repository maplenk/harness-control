/**
 * Metadata-sink redaction (P4a W3-3; §17.1 "redaction before every sink"
 * applied to the DB METADATA sinks — event rows and projection rows).
 *
 * The external review planted an `API_KEY=...` secret in `start --goal` and
 * read it back verbatim out of run metadata: user-origin free text (the run
 * goal, `spec revise --feedback`, the loop's task scope, the role round's
 * serialized inputs, the spec draft's canonical text) reached
 * `JSON.stringify` in the event/projection repositories with no redaction
 * pass, while every OTHER sink (artifact CAS, checkpoints, error strings,
 * probe details) already redacted. This module closes that gap with a
 * REGISTERED FIELD MAP applied at the two single choke points every durable
 * metadata row funnels through:
 *
 *  - event append — `SqliteEventRepository.#appendOne` (both `append` and
 *    `appendBatch` land there, so `ingest`, `appendTriggerWithEffects`, and
 *    direct supporting-event appends are all covered);
 *  - projection save — `SqliteProjectionRepository.save` (the write-path's
 *    transactional fold, every service `save*` read-model method, and
 *    `recover()`'s catch-up save all land there).
 *
 * Deliberately FIELD-REGISTERED, never a blind deep-walk: enums, branded
 * ids, spec/artifact hashes, git SHAs, counters, and every other structured
 * field pass through BYTE-IDENTICAL — a deep-walk over event payloads would
 * risk rewriting identifiers that merely LOOK secret-shaped (e.g. a
 * `...token...` substring inside an opaque id) and would make replay
 * equality a property of the redactor instead of the data. Only the fields
 * named below are ever touched, and only when their value is a string.
 *
 * Two registered forms:
 *  - `'prose'` — plain `redactText` (the §17.1 pattern layer). Used for
 *    free-prose fields AND for `spec_draft.canonicalSpec`, which MUST use
 *    exactly `redactText` so the projection copy stays byte-identical to
 *    the CAS spec artifact: `ArtifactStore.put` redacts string content with
 *    `redactText` BEFORE hashing (src/artifacts/store.ts), so the spec
 *    content hash the approval binds is computed over the REDACTED bytes —
 *    applying the same function here CONVERGES the draft projection with
 *    those bytes instead of diverging from them.
 *  - `'stringified_json'` — parse → structural `redactDeep` → re-stringify
 *    (fallback to plain `redactText` when the value does not parse). Used
 *    for `role_round.inputs`, whose value is BY CONSTRUCTION a
 *    `JSON.stringify`'d document that resume re-entry parses back
 *    (`persistedTaskScope` in src/app/flows/orchestrate.ts,
 *    `parseRoundInputs` in src/cli/commands.ts): every string LEAF gets the
 *    full `redactText` pass (at escape depth 0, where the quoted-value
 *    branches are grammar-correct) and `JSON.stringify` re-escapes the
 *    result, so the stored value always remains valid JSON. Any FLAT pass
 *    over the depth-1 text — `redactText` directly, or
 *    `redactFlattenedJson`'s closing full-text sweep — can consume the lone
 *    backslash of an `\"` escape and un-terminate the embedded string,
 *    silently costing a resumed round its remediation scope; the
 *    structural form cannot.
 *
 * Idempotent by composition: both redactors map their own output to itself
 * (documented per-rule in ../redaction/patterns.ts), so the pending→active→
 * completed re-saves of a role round — and `recover()` re-folding events
 * that were already redacted at append — are byte-stable.
 */
import type { DomainEventType } from '../domain/events.js';
import {
  DEFAULT_REDACTION_CONFIG,
  redactDeep,
  redactText,
  type RedactionConfig,
} from '../redaction/index.js';

/** How a registered field's free text is redacted (see module doc). */
export type FreeTextForm = 'prose' | 'stringified_json';

export interface RegisteredFreeTextField {
  /** Top-level field name inside the event payload / projection state. */
  readonly field: string;
  readonly form: FreeTextForm;
}

/**
 * Event payload fields carrying USER-ORIGIN free text, by event type. The
 * only registered entry is T2's revision feedback — every other payload
 * string in the vocabulary is an id/hash/enum/classification or
 * provider-derived text that its composer already redacts at the source
 * (`describeRawError`, `redactError`, checkpoint/artifact writers).
 */
export const EVENT_FREE_TEXT_FIELDS: Readonly<
  Partial<Record<DomainEventType, readonly RegisteredFreeTextField[]>>
> = {
  /** `spec revise --feedback` (T2): human free text, persisted on the trigger row. */
  'spec.revise.requested': [{ field: 'feedback', form: 'prose' }],
};

/**
 * Projection state fields carrying user-origin free text, by projection
 * name. The names are owned by src/app/projections.ts (`RUN_META_PROJECTION`
 * etc.); this map deliberately holds the literal strings so the persistence
 * layer never imports app-layer modules — the linkage is pinned by the
 * app-level test suite (src/app/metadata-redaction.test.ts).
 */
export const PROJECTION_FREE_TEXT_FIELDS: Readonly<Record<string, readonly RegisteredFreeTextField[]>> = {
  /** `RUN_META_PROJECTION`: the `start --goal` text (the review's planted-secret probe). */
  run_meta: [{ field: 'goal', form: 'prose' }],
  /** `SPEC_DRAFT_PROJECTION`: the goal echo + the canonical spec text — the
   * latter MUST be `'prose'` (plain `redactText`) to stay byte-identical to
   * the CAS artifact whose hash `specHash` binds (module doc). */
  spec_draft: [
    { field: 'goal', form: 'prose' },
    { field: 'canonicalSpec', form: 'prose' },
  ],
  /** `ROLE_ROUND_PROJECTION`: serialized round inputs (goal / task scope /
   * revision feedback travel inside) — stringified JSON, parsed on resume. */
  role_round: [{ field: 'inputs', form: 'stringified_json' }],
  /** `IMPLEMENT_VERIFY_LOOP_PROJECTION`: the base task scope (plain string). */
  implement_verify_loop: [{ field: 'taskScope', form: 'prose' }],
};

/**
 * `'stringified_json'` redactor: parse the (by-construction) JSON document,
 * run the structural walk (`redactDeep`: full `redactText` on every string
 * leaf + wholesale replacement under secret-shaped KEY names), and
 * re-stringify — output is ALWAYS valid JSON. A value that unexpectedly
 * fails to parse falls back to plain `redactText` (never weaker; mirrors
 * `redactFlattenedJson`'s fallback philosophy — but WITHOUT that belt's
 * closing flat-text sweep, which is exactly the pass that can un-terminate
 * a depth-1 `\"` escape; see the module doc).
 */
function redactStringifiedJson(text: string, config: RedactionConfig): string {
  const trimmed = text.trimStart();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed !== null && typeof parsed === 'object') {
        return JSON.stringify(redactDeep(parsed, config));
      }
    } catch {
      // not parseable JSON after all — take the plain-text pass below
    }
  }
  return redactText(text, config);
}

function redactByForm(text: string, form: FreeTextForm, config: RedactionConfig): string {
  return form === 'stringified_json' ? redactStringifiedJson(text, config) : redactText(text, config);
}

/**
 * Apply the registered redactors to `value`'s top-level fields. Returns the
 * SAME reference when nothing is registered or nothing changed (strings
 * compare by value, so a secret-free field costs one pattern pass and no
 * allocation) — unregistered payloads/states are structurally untouched.
 */
function applyRegisteredFields<T>(
  value: T,
  fields: readonly RegisteredFreeTextField[] | undefined,
  config: RedactionConfig,
): T {
  if (fields === undefined || fields.length === 0) return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  let out: Record<string, unknown> | undefined;
  for (const { field, form } of fields) {
    const current = record[field];
    if (typeof current !== 'string' || current.length === 0) continue;
    const redacted = redactByForm(current, form, config);
    if (redacted !== current) {
      out ??= { ...record };
      out[field] = redacted;
    }
  }
  return (out ?? value) as T;
}

/**
 * The event-append boundary applier (`SqliteEventRepository.#appendOne`):
 * redact the registered free-text fields of `payload` for `type`, leaving
 * every other event type/field byte-identical.
 */
export function redactEventPayload<P>(
  type: DomainEventType,
  payload: P,
  config: RedactionConfig = DEFAULT_REDACTION_CONFIG,
): P {
  return applyRegisteredFields(payload, EVENT_FREE_TEXT_FIELDS[type], config);
}

/**
 * The projection-save boundary applier (`SqliteProjectionRepository.save`):
 * redact the registered free-text fields of `state` for the projection
 * `name`, leaving every other projection byte-identical.
 */
export function redactProjectionState<S>(
  name: string,
  state: S,
  config: RedactionConfig = DEFAULT_REDACTION_CONFIG,
): S {
  return applyRegisteredFields(state, PROJECTION_FREE_TEXT_FIELDS[name], config);
}
