/**
 * Redaction entry points (PLAN.md §17.1: "Redaction before every sink (DB,
 * artifacts, logs, checkpoints, memory, errors)"). Pure, deterministic,
 * synchronous — no clock/id/network dependency, safe to call on any hot
 * path right before a value crosses into a sink.
 */
import { DEFAULT_REDACTION_RULES, isSecretKeyName, type RedactionRule } from './patterns.js';

export interface ProjectPattern {
  readonly id: string;
  readonly regex: RegExp;
}

export interface RedactionConfig {
  readonly rules: readonly RedactionRule[];
  /** §17.1 "configurable project patterns" — applied after the built-ins. */
  readonly projectPatterns: readonly ProjectPattern[];
}

export const DEFAULT_REDACTION_CONFIG: RedactionConfig = {
  rules: DEFAULT_REDACTION_RULES,
  projectPatterns: [],
};

function withGlobalFlag(regex: RegExp): RegExp {
  return regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
}

function projectRuleFor(pattern: ProjectPattern): RedactionRule {
  const regex = withGlobalFlag(pattern.regex);
  return {
    id: pattern.id,
    description: `Project-configured pattern '${pattern.id}'.`,
    apply: (text) => text.replace(regex, `[REDACTED:${pattern.id}]`),
  };
}

/**
 * Apply every configured rule, in order, to a single string. Pure and
 * deterministic: identical input + config always yields identical output.
 * Every sink that accepts free text (artifact files, checkpoint content
 * fields, error/log strings) MUST route through this (or `redactDeep`)
 * before persisting/emitting (§17.1).
 */
export function redactText(input: string, config: RedactionConfig = DEFAULT_REDACTION_CONFIG): string {
  let text = input;
  for (const rule of config.rules) {
    text = rule.apply(text);
  }
  for (const pattern of config.projectPatterns) {
    text = projectRuleFor(pattern).apply(text);
  }
  return text;
}

const MAX_REDACTION_DEPTH = 25;
const CREDENTIAL_LABEL = 'credential';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Date) &&
    !(value instanceof RegExp)
  );
}

function redactDeepInner(value: unknown, config: RedactionConfig, depth: number): unknown {
  if (depth > MAX_REDACTION_DEPTH) return value;
  if (typeof value === 'string') return redactText(value, config);
  if (Array.isArray(value)) {
    return value.map((item) => redactDeepInner(item, config, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string' && isSecretKeyName(key)) {
        // Structural redaction: the KEY name alone is enough justification,
        // regardless of whether the value happens to match a shape rule
        // (opaque internal tokens, plain-English passwords, ...).
        out[key] = val.length === 0 ? val : `[REDACTED:${CREDENTIAL_LABEL}]`;
      } else {
        out[key] = redactDeepInner(val, config, depth + 1);
      }
    }
    return out;
  }
  return value; // numbers, booleans, null, undefined, Date, RegExp pass through
}

/**
 * Structural + textual redaction over arbitrary JSON-shaped data (DB row
 * objects, CheckpointContent, MemoryEntry payloads, ...): every string leaf
 * is text-redacted via `redactText`; additionally, any property whose KEY
 * name looks secret-shaped (§17.1) has its string value replaced wholesale,
 * even when the value itself has no recognizable secret shape. Non-string
 * primitives (numbers, booleans, null, undefined, Date, RegExp) pass through
 * unchanged. Returns a new value; never mutates the input.
 */
export function redactDeep<T>(value: T, config: RedactionConfig = DEFAULT_REDACTION_CONFIG): T {
  return redactDeepInner(value, config, 0) as T;
}

// ---------------------------------------------------------------------------
// Flat-text belt for stringified JSON (round-4 escape/truncation class)
// ---------------------------------------------------------------------------

/** Inputs larger than this skip the balanced-JSON scan (pathological brace
 * runs would be quadratic) and take the plain `redactText` fallback. */
const FLATTENED_JSON_MAX_INPUT = 64 * 1024;
/** Cap on balanced-scan attempts per input — same pathological-input guard. */
const FLATTENED_JSON_MAX_SCANS = 256;
/** Recursion bound for string values that themselves parse as JSON. */
const MAX_EMBEDDED_JSON_DEPTH = 6;

/**
 * Find the exclusive end index of a balanced JSON object/array starting at
 * `start` (which must hold `{` or `[`), honoring string literals and
 * backslash escapes. Returns -1 when the text ends before balance.
 * Bracket-KIND mismatches are not checked here — `JSON.parse` is the
 * authority on well-formedness and rejects them.
 */
function findBalancedJsonEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') {
        i += 1; // skip the escaped character
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{' || ch === '[') {
      depth += 1;
    } else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/**
 * `redactDeep`'s walk PLUS recursion into string values that themselves
 * parse as JSON objects/arrays (stringified-JSON-in-JSON, any depth up to
 * MAX_EMBEDDED_JSON_DEPTH): parse → redact structurally → re-stringify.
 * Sensitive KEY names still replace the whole string value first — the
 * key-name rule outranks embedded-JSON recursion.
 */
function redactParsedWithStringRecursion(value: unknown, config: RedactionConfig, depth: number): unknown {
  if (depth > MAX_EMBEDDED_JSON_DEPTH) return redactDeepInner(value, config, 0);
  if (typeof value === 'string') {
    const trimmed = value.trimStart();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed !== null && typeof parsed === 'object') {
          return JSON.stringify(redactParsedWithStringRecursion(parsed, config, depth + 1));
        }
      } catch {
        // not embedded JSON — fall through to plain text redaction
      }
    }
    return redactText(value, config);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactParsedWithStringRecursion(item, config, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'string' && isSecretKeyName(key)) {
        out[key] = val.length === 0 ? val : `[REDACTED:${CREDENTIAL_LABEL}]`;
      } else {
        out[key] = redactParsedWithStringRecursion(val, config, depth + 1);
      }
    }
    return out;
  }
  return value;
}

/**
 * §17.1 belt for FLAT provider text that may embed (arbitrarily re-)
 * stringified JSON — the `describeRawError` sink (durable
 * `limit.probe.inconclusive.detail`, `status --json`, CLI text), where
 * `redactDeep` is architecturally unreachable because the payload is a
 * single string. Locates balanced JSON substrings, parses them, applies the
 * structural walk WITH recursion into string values that themselves parse
 * as JSON (so a secret keyed at stringification depth 0–3+ is replaced
 * WHOLE by key name), re-stringifies in place, then runs `redactText` over
 * the entire composed string (which also covers the non-JSON remainder and
 * any span that failed to parse — including truncation-cut JSON, via the
 * pattern layer's unterminated-quote fallback). NEVER weaker than plain
 * `redactText`: every path ends in a full-text `redactText`, and any
 * unexpected failure falls back to `redactText(input)` wholesale.
 *
 * Note: re-stringification NORMALIZES a parsed span (whitespace,
 * escaping) — acceptable for detail/preview strings, which is why this is
 * applied at the flat-error sink and not to arbitrary artifact content.
 */
export function redactFlattenedJson(input: string, config: RedactionConfig = DEFAULT_REDACTION_CONFIG): string {
  try {
    if (input.length > FLATTENED_JSON_MAX_INPUT) return redactText(input, config);
    let out = '';
    let cursor = 0;
    let scans = 0;
    while (cursor < input.length) {
      const brace = input.indexOf('{', cursor);
      const bracket = input.indexOf('[', cursor);
      const open = brace === -1 ? bracket : bracket === -1 ? brace : Math.min(brace, bracket);
      if (open === -1 || scans >= FLATTENED_JSON_MAX_SCANS) {
        out += input.slice(cursor);
        break;
      }
      out += input.slice(cursor, open);
      scans += 1;
      const end = findBalancedJsonEnd(input, open);
      let handled = false;
      if (end !== -1) {
        const span = input.slice(open, end);
        try {
          const parsed: unknown = JSON.parse(span);
          if (parsed !== null && typeof parsed === 'object') {
            out += JSON.stringify(redactParsedWithStringRecursion(parsed, config, 0));
            cursor = end;
            handled = true;
          }
        } catch {
          // not valid JSON — treat the opening char as plain text below
        }
      }
      if (!handled) {
        out += input[open];
        cursor = open + 1;
      }
    }
    return redactText(out, config);
  } catch {
    return redactText(input, config);
  }
}

/**
 * Redact an error before it reaches a sink (log line, DB row, notification).
 * Errors often echo back request details (URLs, headers, raw payloads) that
 * carry secrets. Returns a plain string — the smallest honest shape that
 * every sink (DB text column, log line, notification body) can accept.
 */
export function redactError(error: unknown, config: RedactionConfig = DEFAULT_REDACTION_CONFIG): string {
  if (error instanceof Error) {
    const name = error.name || 'Error';
    return `${name}: ${redactText(error.message, config)}`;
  }
  if (typeof error === 'string') return redactText(error, config);
  try {
    return redactText(JSON.stringify(error), config);
  } catch {
    return redactText(String(error), config);
  }
}
