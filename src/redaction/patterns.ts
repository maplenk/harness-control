/**
 * Redaction pattern library (PLAN.md §17.1): text-level rules composed by
 * `redact.ts` into `redactText`/`redactDeep`, applied before EVERY sink (DB,
 * artifacts, checkpoints, memory, logs, error strings).
 *
 * Two complementary detection strategies:
 *  - TEXTUAL rules here match secret material by SHAPE (private-key PEM
 *    blocks, credential URLs, auth-scheme tokens, sk-/AKIA/gh*_ key formats)
 *    regardless of surrounding structure — needed for free text (error
 *    strings, checkpoint worktree snapshots, raw logs).
 *  - `credential_assignment` / `stringified_credential_assignment` below AND
 *    `isSecretKeyName` (reused by `redactDeep`'s structural walker in
 *    redact.ts) match secret material by NAME (`KEY=value`, `key: value`,
 *    `"key": "value"`, and the backslash-escaped `\"key\":\"value\"` forms
 *    where the key mentions key/secret/token/password/credential) — needed
 *    because not every secret value has a recognizable shape (e.g. an opaque
 *    internal token, or a plain-English password).
 *
 * Rules run in a FIXED order (see DEFAULT_REDACTION_RULES): the private-key
 * block rule always runs first because it spans newlines and must not be
 * fragmented by later single-line rules; `credential_url` runs before the
 * assignment rules so a URL's embedded `user:pass@` is never misparsed as a
 * key/value pair; `stringified_credential_assignment` runs before
 * `credential_assignment` because its multi-character `\...\"` delimiters
 * must not be fragmented by the simpler rule; every later rule only sees
 * text the earlier rules left behind, so a value already replaced by an
 * earlier rule's `[REDACTED:...]` token can never be re-matched (or
 * corrupted) by a later one.
 *
 * GUARANTEES of the name-based assignment rules (verifier round-4, the
 * escape/truncation class — each is fixture- or fuzz-pinned):
 *  - JSON-string-GRAMMAR-correct quoted values: the quoted branches are
 *    `"(?:[^"\\]|\\.)*"` (and the single-quote analog), so a backslash
 *    escape is consumed AS PART of the value — `{"password":"\"quoted\""}`
 *    and `{"password":"stap\"le tail"}` redact the WHOLE value to the
 *    nearest UNESCAPED closing quote. The run can never jump past an
 *    unescaped quote, so a match is always bounded by the nearest real
 *    string terminator.
 *  - ESCAPE-RUN delimiters (stringified JSON, escape depth 1–3+): a
 *    sensitive pair whose delimiters are a backslash-run+quote at ANY
 *    uniform run length — `\"password\":\"v\"` (depth 1, run 1),
 *    `\\\"password\\\":\\\"v\\\"` (depth 2, run 3), run 7 at depth 3 —
 *    matches WITHOUT parsing, via a captured backslash-run and
 *    backreferenced closing delimiters. Fuzz-proven for stringification
 *    depth 0–3 over values free of embedded quote/backslash escapes; for
 *    FULL JSON-grammar values at depth ≥ 1 the flat-error sink adds a
 *    parse-based belt (`redactFlattenedJson` in redact.ts — balanced-JSON
 *    locate → parse → structural redact with recursion into stringified
 *    string values → re-stringify → redactText), fallback to plain
 *    `redactText` on any parse failure. That combination (regex here, belt
 *    at the sink) is what the depth-0–3 fuzz pins.
 *  - UNTERMINATED-QUOTE fallback: after a SENSITIVE key + separator, a
 *    value that OPENS with a quote (or escape-run+quote) but never closes —
 *    provider truncation, or any upstream byte-bound cutting mid-string —
 *    redacts to END-OF-STRING (a trailing lone backslash from a cut escape
 *    is consumed too). Sensitive-key-gated, so benign prose without a
 *    sensitive `key: "` prefix is never swallowed.
 *  - REDACT-BEFORE-TRUNCATE (enforced at the call sites, documented here as
 *    part of the contract): every site that bounds/slices provider-derived
 *    text into a detail/preview redacts FIRST, so a slice may cut a
 *    `[REDACTED:...]` marker but can never un-terminate a quote before
 *    redaction has seen the full text. Capture-time byte caps that cannot
 *    be reordered (streaming stderr head/tail buffers) are covered by the
 *    unterminated-quote fallback at snapshot-redaction time instead.
 *
 * CONVERGENCE (round-4 rule): the pattern layer is CONVERGED as of this
 * round; further text-path findings are documented-accepted residuals unless
 * a WHOLE shaped-or-keyed synthetic secret leaks through a DURABLE sink.
 *
 * HONESTY — scope limit (do not claim otherwise): pattern redaction catches
 * secrets by SHAPE or by KEY NAME only. A shapeless secret in free prose —
 * no `KEY=value`/`key: value` form and no recognizable token shape — is OUT
 * OF SCOPE for this library by design and passes through unredacted. For
 * structured data use `redactDeep` (key-name aware on object properties);
 * for project-specific token formats register §17.1 project patterns.
 *
 * ACCEPTED residuals (verifier-reviewed, kept BY DESIGN — do not "fix"):
 *  - unquoted comma-tail: `API_KEY=head,tail` redacts `head` only. The
 *    UNQUOTED value branch must terminate on `,` (JSON/object-literal
 *    adjacency would otherwise be swallowed), and the tail is shapeless
 *    prose — out of pattern scope per the paragraph above.
 *  - digit-glued key prefix: `1API_KEY=v` never matches. Env names cannot
 *    start with a digit, and the `\b(?![0-9])` guard is exactly what keeps
 *    hex strings/ids (`...29a1token=...`-shaped runs) from producing false
 *    positives. The guard stays.
 *  - deeper-escape tail at the PURE-REGEX layer: an escape-run value whose
 *    content embeds a DEEPER-escaped quote (`\"password\":\"hun\\\"ter\"`)
 *    terminates the regex match at the first same-run delimiter, so a tail
 *    FRAGMENT (never the whole secret) can survive redactText alone. The
 *    flat-error sink's parse-based belt (`redactFlattenedJson`) covers the
 *    full JSON grammar there; other textual sinks accept the fragment
 *    residual under the convergence rule.
 */

export interface RedactionRule {
  readonly id: string;
  readonly description: string;
  readonly apply: (text: string) => string;
}

/**
 * Key-NAME shapes treated as secret-bearing (case-insensitive substring
 * match against a property/identifier name). Deliberately does NOT include
 * a bare "auth" or bare "key" alternative — those produce false positives
 * ("author", "authentic", "primaryKey", "sortKey"); the auth-header case is
 * covered separately by the shape-based `auth_header` rule below.
 *
 * This alternation is ALSO embedded structurally into `ASSIGNMENT_RE` and
 * `STRINGIFIED_ASSIGNMENT_RE` below (via `.source`), so the assignment
 * rules and `redactDeep`'s key test can never drift apart.
 */
export const SECRET_KEY_NAME_RE =
  /(?:api[_-]?key|access[_-]?key|private[_-]?key|secret(?:[_-]?key)?|client[_-]?secret|token|password|passwd|credential)/i;

export function isSecretKeyName(name: string): boolean {
  return SECRET_KEY_NAME_RE.test(name);
}

const REDACTED = (label: string): string => `[REDACTED:${label}]`;

// ---------------------------------------------------------------------------
// 1. Private key PEM blocks — MUST run first (spans newlines).
// ---------------------------------------------------------------------------
const PRIVATE_KEY_BLOCK_RE =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

// ---------------------------------------------------------------------------
// 2. Credential URLs — scheme://user:pass@host
// ---------------------------------------------------------------------------
const CREDENTIAL_URL_RE = /(\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/g;

// ---------------------------------------------------------------------------
// 3. Escape-run assignment — a sensitive pair INSIDE stringified JSON,
//    delimited by backslash-run+quote at any uniform run length (depth 1 →
//    `\"`, depth 2 → `\\\"`, depth 3 → run 7). The captured run (group 1)
//    is backreferenced for every later delimiter, so only a consistently
//    escaped pair matches — a misaligned start self-rejects on the closing
//    backreference. Runs BEFORE `credential_assignment` so its multi-char
//    delimiters are never fragmented by the simpler rule. Value branches:
//      - `\1"…\1"` — quoted at the SAME escape depth, consumed to the first
//        same-run delimiter (greedy with a `(?!\1")` guard);
//      - `[^\s"'\\,{}\[\]]+` — unquoted JSON scalar (number/bool/null);
//      - `\1"…$` — UNTERMINATED (truncation): opens but never closes at
//        this depth → redact to end-of-string.
//    Empty values (quoted or unterminated) carry no secret material and are
//    preserved verbatim, mirroring the plain rule. Idempotent: the redacted
//    forms re-match and map to themselves (or no longer match at all).
// ---------------------------------------------------------------------------
const STRINGIFIED_ASSIGNMENT_RE = new RegExp(
  String.raw`(\\+)"((?![0-9])[A-Za-z0-9_]*(?:${SECRET_KEY_NAME_RE.source})[A-Za-z0-9_]*)\1"(\s*[:=]\s*)` +
    String.raw`(?:\1"((?:(?!\1")[\s\S])*)\1"|([^\s"'\\,{}\[\]]+)|\1"((?:(?!\1")[\s\S])*)$)`,
  'gi',
);

// ---------------------------------------------------------------------------
// 4. Name-based assignment — `KEY=value`, `key: value`, `"key": "value"`
//    where the key mentions a secret-shaped word (§17.1 "env assignments").
//    The sensitive-key alternation (`SECRET_KEY_NAME_RE`) is part of the
//    REGEX ITSELF, so ONLY sensitive-key assignments ever match: a
//    non-sensitive `word:`/`word=` pair is never consumed at all, so it can
//    never swallow (and thereby SHIELD from redaction) a following
//    `API_KEY=...` as its "value". (The previous broad `key SEP value` match
//    with a replacer-side key check had exactly that bypass: because the
//    value class admits `=`, `note: DB_PASSWORD=hunter2` matched as
//    key=`note` value=`DB_PASSWORD=hunter2` and passed through untouched —
//    and `describeRawError`'s `${kind}: ${message}` composition put such a
//    non-sensitive prefix in front of EVERY provider message.)
//    Non-secret assignments (PORT=3000, "role":"admin") still pass through
//    byte-for-byte unchanged — they simply never match.
//    The VALUE side is an alternation of five branches:
//      - `"(?:[^"\\]|\\.)*"` / `'(?:[^'\\]|\\.)*'` — QUOTED values,
//        JSON-string-GRAMMAR correct: a backslash escape (`\"`, `\\`, …) is
//        consumed as part of the value, and the match closes at the nearest
//        UNESCAPED matching quote. (The previous `[^"]*` branches stopped
//        at the nearest quote CHARACTER, so `{"password":"\"whole\""}`
//        leaked the whole secret and `"stap\"le tail"` leaked its tail —
//        verifier-demonstrated round-4 bypasses, now fixture-pinned as
//        whole-value redactions.) Internal whitespace/commas/braces are
//        secret material, not terminators; the run can never jump past an
//        unescaped quote.
//      - `[^\s"',{}]+` — the UNQUOTED branch, byte-for-byte the verified
//        round-2 class: DELIBERATELY admits `=` (base64 padding,
//        `k=v`-shaped opaque tokens) and terminates on
//        whitespace/quote/comma/brace.
//      - `"(?:[^"\\]|\\.)*\\?$` / `'…$` — UNTERMINATED-QUOTE fallback
//        (truncation class): the value OPENS with a quote but no unescaped
//        closing quote ever arrives (provider truncation, upstream
//        byte-bounds) → consume to END-OF-STRING, including a trailing
//        lone backslash from a cut escape. Sensitive-key-gated by
//        construction, so benign prose is never swallowed.
//    Quote handling (documented choice): the replacer PRESERVES the
//    surrounding quotes and redacts only the inner value —
//    `password:"[REDACTED:credential]"` — so JSON/object-literal framing
//    survives; the unterminated branches preserve the OPENING quote only
//    (honest: there was no closing quote). An EMPTY quoted value (`""`/`''`
//    or a bare opening quote at end-of-string) carries no secret material
//    and is preserved verbatim, mirroring `redactDeep`'s empty-string rule.
//    Idempotent: `"[REDACTED:credential]"` re-matches the quoted branch and
//    maps to itself; the unterminated redacted form re-matches the
//    unterminated branch and maps to itself.
//    For the ACCEPTED residuals of this rule (unquoted comma-tail,
//    digit-glued key prefix) see the file header.
// ---------------------------------------------------------------------------
const ASSIGNMENT_RE = new RegExp(
  String.raw`\b(?![0-9])([A-Za-z0-9_]*(?:${SECRET_KEY_NAME_RE.source})[A-Za-z0-9_]*)(["']?\s*[:=]\s*)` +
    String.raw`(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"',{}]+)|"((?:[^"\\]|\\.)*\\?)$|'((?:[^'\\]|\\.)*\\?)$)`,
  'gi',
);

// ---------------------------------------------------------------------------
// 5. Auth-scheme tokens — `Bearer|Basic|Token|Digest <value>`, with or
//    without a preceding "Authorization:" label (§17.1 "auth headers").
// ---------------------------------------------------------------------------
const AUTH_SCHEME_TOKEN_RE = /\b(Bearer|Basic|Token|Digest)\s+([A-Za-z0-9\-._~+/]{8,}=*)/g;

// ---------------------------------------------------------------------------
// 6. Standalone `sk-`/`sk_` API keys (Anthropic/OpenAI/Stripe-secret style).
// ---------------------------------------------------------------------------
const SK_API_KEY_RE = /\bsk[-_][A-Za-z0-9_-]{10,}/g;

// ---------------------------------------------------------------------------
// 7. AWS Access Key IDs.
// ---------------------------------------------------------------------------
const AWS_AKIA_RE = /\bAKIA[0-9A-Z]{16}\b/g;

// ---------------------------------------------------------------------------
// 8. GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_...).
// ---------------------------------------------------------------------------
const GITHUB_TOKEN_RE = /\bgh[oprsu]_[A-Za-z0-9]{20,}\b/g;

export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  {
    id: 'private_key_block',
    description: 'PEM-style private key block (-----BEGIN/END ... PRIVATE KEY-----).',
    apply: (text) => text.replace(PRIVATE_KEY_BLOCK_RE, REDACTED('private_key_block')),
  },
  {
    id: 'credential_url',
    description: 'URL with embedded user:pass credentials.',
    apply: (text) =>
      text.replace(CREDENTIAL_URL_RE, (_match, scheme: string) => `${scheme}${REDACTED('credential_url')}@`),
  },
  {
    id: 'stringified_credential_assignment',
    description:
      'Backslash-escaped `\\"key\\": \\"value\\"` pair inside stringified JSON, any uniform escape run.',
    apply: (text) =>
      // Every match is a sensitive-key pair BY CONSTRUCTION (the
      // SECRET_KEY_NAME_RE alternation is embedded in the regex), so the
      // replacer redacts every NON-EMPTY value unconditionally, exactly as
      // `credential_assignment` below does. Empty quoted/unterminated
      // values carry no secret material and are preserved verbatim.
      text.replace(
        STRINGIFIED_ASSIGNMENT_RE,
        (
          match,
          run: string,
          key: string,
          sep: string,
          quoted: string | undefined,
          unquoted: string | undefined,
          unterminated: string | undefined,
        ) => {
          const delim = `${run}"`;
          if (quoted !== undefined) {
            return quoted.length === 0
              ? match
              : `${delim}${key}${delim}${sep}${delim}${REDACTED('credential')}${delim}`;
          }
          if (unquoted !== undefined) {
            return `${delim}${key}${delim}${sep}${REDACTED('credential')}`;
          }
          if (unterminated !== undefined && unterminated.length > 0) {
            return `${delim}${key}${delim}${sep}${delim}${REDACTED('credential')}`;
          }
          return match;
        },
      ),
  },
  {
    id: 'credential_assignment',
    description: 'Name-based key=value / "key": "value" assignment for secret-shaped key names.',
    apply: (text) =>
      // Every match is a sensitive-key assignment BY CONSTRUCTION (the
      // SECRET_KEY_NAME_RE alternation is embedded in ASSIGNMENT_RE), so the
      // replacer redacts every NON-EMPTY value unconditionally — a
      // value-content check here would re-introduce consumption-shielding
      // if the regex and replacer ever drifted. The single exception is an
      // EMPTY quoted value ("" / '' / a bare opening quote at end-of-string):
      // there is no secret material inside it (the consumed span is exactly
      // `key`, `sep`, and the quote(s)), so it is preserved verbatim rather
      // than fabricating a credential.
      text.replace(
        ASSIGNMENT_RE,
        (
          match,
          key: string,
          sep: string,
          dquoted: string | undefined,
          squoted: string | undefined,
          unquoted: string | undefined,
          dopen: string | undefined,
          sopen: string | undefined,
        ) => {
          if (dquoted !== undefined) {
            return dquoted.length === 0 ? match : `${key}${sep}"${REDACTED('credential')}"`;
          }
          if (squoted !== undefined) {
            return squoted.length === 0 ? match : `${key}${sep}'${REDACTED('credential')}'`;
          }
          if (unquoted !== undefined) {
            return `${key}${sep}${REDACTED('credential')}`;
          }
          if (dopen !== undefined) {
            return dopen.length === 0 ? match : `${key}${sep}"${REDACTED('credential')}`;
          }
          if (sopen !== undefined) {
            return sopen.length === 0 ? match : `${key}${sep}'${REDACTED('credential')}`;
          }
          return match;
        },
      ),
  },
  {
    id: 'auth_header',
    description: 'Bearer/Basic/Token/Digest auth-scheme token value.',
    apply: (text) =>
      text.replace(AUTH_SCHEME_TOKEN_RE, (_match, scheme: string) => `${scheme} ${REDACTED('auth_header')}`),
  },
  {
    id: 'api_key',
    description: 'sk-/sk_ prefixed API key (Anthropic/OpenAI/Stripe-style).',
    apply: (text) => text.replace(SK_API_KEY_RE, REDACTED('api_key')),
  },
  {
    id: 'aws_access_key',
    description: 'AWS Access Key ID (AKIA...).',
    apply: (text) => text.replace(AWS_AKIA_RE, REDACTED('aws_access_key')),
  },
  {
    id: 'github_token',
    description: "GitHub personal/app/OAuth token (gh[oprsu]_...).",
    apply: (text) => text.replace(GITHUB_TOKEN_RE, REDACTED('api_key')),
  },
];
