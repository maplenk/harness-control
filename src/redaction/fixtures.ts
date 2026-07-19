/**
 * Redaction fixture corpus (PLAN.md §19 test 15: "redaction across sinks —
 * DB rows, artifact files, checkpoint content, error strings"). Each fixture
 * pairs a realistic secret-bearing string with the exact secret substrings
 * that must NOT survive redaction and, where useful, the non-secret context
 * that MUST survive (proof the redactor doesn't over-redact). Consumed by
 * `redaction.test.ts`; exported so other sinks' tests (artifacts,
 * checkpoint) can reuse the same corpus instead of inventing ad hoc secrets.
 */

export interface RedactionFixture {
  readonly id: string;
  readonly description: string;
  readonly input: string;
  /** Secret substrings that must be ABSENT from the redacted output. */
  readonly secrets: readonly string[];
  /** Non-secret substrings that must be PRESENT (untouched) in the output. */
  readonly preserve?: readonly string[];
}

export const REDACTION_FIXTURES: readonly RedactionFixture[] = [
  {
    id: 'auth-header-bearer',
    description: 'HTTP Authorization header with a Bearer token',
    input:
      'GET /v1/messages HTTP/1.1\nAuthorization: Bearer sk-ant-api03-AbCdEf1234567890ZzYyXxWw\nHost: api.anthropic.com',
    secrets: ['sk-ant-api03-AbCdEf1234567890ZzYyXxWw'],
    preserve: ['GET /v1/messages HTTP/1.1', 'Host: api.anthropic.com', 'Authorization: Bearer'],
  },
  {
    id: 'auth-header-basic',
    description: 'HTTP Authorization header with a Basic token',
    input: 'Authorization: Basic dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk',
    secrets: ['dXNlcjpzdXBlcnNlY3JldHBhc3N3b3Jk'],
    preserve: ['Authorization: Basic'],
  },
  {
    id: 'anthropic-api-key-prose',
    description: 'Anthropic-style sk-ant- API key embedded in prose (no assignment operator)',
    input: 'set ANTHROPIC_API_KEY to sk-ant-api03-9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c and restart',
    secrets: ['sk-ant-api03-9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c'],
    preserve: ['set ANTHROPIC_API_KEY to', 'and restart'],
  },
  {
    id: 'openai-api-key-curl',
    description: 'OpenAI-style sk- API key inside a curl command',
    input: 'curl -H "Authorization: Bearer sk-proj-abcdefghijklmnopqrstuvwx" https://api.openai.com/v1/chat/completions',
    secrets: ['sk-proj-abcdefghijklmnopqrstuvwx'],
    preserve: ['https://api.openai.com/v1/chat/completions'],
  },
  {
    id: 'api-key-opaque-assignment',
    description: 'API_KEY env assignment with an opaque (non-prefixed) secret value',
    input: 'API_KEY=8f14e45fceea167a5a36dedd4bea2543',
    secrets: ['8f14e45fceea167a5a36dedd4bea2543'],
  },
  {
    id: 'aws-access-key-id',
    description: 'AWS Access Key ID (AKIA prefix) in a CLI invocation',
    input: 'aws configure set aws_access_key_id AKIAIOSFODNN7EXAMPLE',
    secrets: ['AKIAIOSFODNN7EXAMPLE'],
    preserve: ['aws configure set aws_access_key_id'],
  },
  {
    id: 'aws-secret-access-key-env',
    description: 'AWS secret access key as an env assignment',
    input: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    secrets: ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  },
  {
    id: 'private-key-block-rsa',
    description: 'RSA private key PEM block',
    input:
      '-----BEGIN RSA PRIVATE KEY-----\n' +
      'MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumL7m2ea5nJXOEwXtc4kLj8Pf\n' +
      'kOX3wIDAQABAoIBAQC7VJTUt9Us8cKj\n' +
      '-----END RSA PRIVATE KEY-----',
    secrets: ['MIIEpAIBAAKCAQEA1c7+9z5Pad7OejecsQ0bu3aumL7m2ea5nJXOEwXtc4kLj8Pf'],
  },
  {
    id: 'private-key-block-openssh',
    description: 'OpenSSH private key block',
    input:
      '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
      'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQAAACD\n' +
      '-----END OPENSSH PRIVATE KEY-----',
    secrets: ['b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZWQyNTUxOQAAACD'],
  },
  {
    id: 'credential-url-postgres',
    description: 'Database URL with embedded username/password',
    input: 'DATABASE_URL=postgres://dbuser:h4x0r_p4ss@db.internal.example.com:5432/prod',
    secrets: ['dbuser:h4x0r_p4ss'],
    preserve: ['db.internal.example.com:5432/prod'],
  },
  {
    id: 'credential-url-in-error-text',
    description: 'Generic scheme URL with credentials surfaced inside error text',
    input: 'failed to connect to redis://default:sup3rSecr3t@cache.example.com:6379/0: ECONNREFUSED',
    secrets: ['default:sup3rSecr3t'],
    preserve: ['ECONNREFUSED', 'cache.example.com:6379/0'],
  },
  {
    id: 'env-assignment-stripe-secret',
    description: 'Stripe-style secret key via env assignment',
    input: 'export STRIPE_SECRET_KEY=sk_live_51H8xyzABCDEFGHIJKLMNOPQ',
    secrets: ['sk_live_51H8xyzABCDEFGHIJKLMNOPQ'],
  },
  {
    id: 'env-assignment-password-plain-english',
    description: 'Password env assignment with an opaque (non-magic-prefix) value',
    input: 'DB_PASSWORD=CorrectHorseBatteryStaple9!',
    secrets: ['CorrectHorseBatteryStaple9!'],
  },
  {
    id: 'json-field-password',
    description: 'JSON object field carrying a password value (DB row / API payload shape)',
    input: '{"username":"alice","password":"tr0ub4dor&3","role":"admin"}',
    secrets: ['tr0ub4dor&3'],
    preserve: ['"username":"alice"', '"role":"admin"'],
  },
  {
    id: 'github-personal-access-token',
    description: 'GitHub personal access token surfaced in a git remote error',
    input: 'remote: Invalid credentials for token ghp_16C7e42F292c6912E7710c838347Ae178B4a',
    secrets: ['ghp_16C7e42F292c6912E7710c838347Ae178B4a'],
    preserve: ['remote: Invalid credentials for token'],
  },
  {
    id: 'non-secret-passthrough',
    description: 'Ordinary text and benign env assignments must survive completely untouched',
    input: 'PORT=3000\nNODE_ENV=production\nThe deploy finished in 42s.',
    secrets: [],
    preserve: ['PORT=3000', 'NODE_ENV=production', 'The deploy finished in 42s.'],
  },
  // -------------------------------------------------------------------------
  // Assignment-shielding regressions (verifier-demonstrated bypasses): a
  // NON-sensitive `word:`/`word=` pair must never CONSUME a following
  // sensitive assignment as its "value" and thereby shield it from
  // redaction. All secret material is SYNTHETIC.
  // -------------------------------------------------------------------------
  {
    id: 'assignment-shielded-by-kind-prefix',
    description:
      "Demonstrated leak: describeRawError's `${kind}: ${message}` composition — the `invalid_argument:` prefix must not shield the trailing assignment",
    input: 'invalid_argument: setConfigOption failed: API_KEY=sup3r-s3cret-token-value',
    secrets: ['sup3r-s3cret-token-value'],
    preserve: ['invalid_argument: setConfigOption failed:', 'API_KEY='],
  },
  {
    id: 'assignment-shielded-by-word-prefix',
    description: 'Demonstrated leak: a benign `note:` label must not shield the following assignment',
    input: 'note: DB_PASSWORD=hunter2',
    secrets: ['hunter2'],
    preserve: ['note:', 'DB_PASSWORD='],
  },
  {
    id: 'assignment-kind-prefix-direct',
    description:
      'The `${kind}: ` prefix DIRECTLY adjacent to the assignment (no intermediate words) must not shield it either',
    input: 'invalid_argument: API_KEY=c0nf1g-rejected-echo',
    secrets: ['c0nf1g-rejected-echo'],
    preserve: ['invalid_argument:', 'API_KEY='],
  },
  {
    id: 'assignment-value-with-equals-padding',
    description:
      'A sensitive value containing `=` (base64-ish padding / k=v-shaped opaque token) is consumed WHOLE — no tail fragment survives',
    input: 'SESSION_TOKEN=leaky-part-one=leaky-part-two==',
    secrets: ['leaky-part-one', 'leaky-part-two'],
    preserve: ['SESSION_TOKEN='],
  },
  {
    id: 'assignment-back-to-back',
    description:
      'Back-to-back assignments: the sensitive one is redacted while its non-sensitive neighbors survive byte-for-byte',
    input: 'A=1 API_KEY=x B=2',
    secrets: ['API_KEY=x'],
    preserve: ['A=1', 'B=2', 'API_KEY='],
  },
  // -------------------------------------------------------------------------
  // Quoted-value assignments (round-3 verifier bypass): a QUOTED value with
  // internal whitespace/commas/braces escaped the old `(["']?)value\3`
  // backreference form entirely (the closing-quote backreference sat AFTER a
  // value class that terminated on whitespace) — the exact JSON probe below
  // reached a durable `limit.probe.inconclusive.detail` row VERBATIM. The
  // quoted branches now consume to the MATCHING closing quote. All secret
  // material is SYNTHETIC.
  // -------------------------------------------------------------------------
  {
    id: 'quoted-json-password-with-spaces',
    description:
      'Demonstrated leak (the exact fuzzing probe): a JSON password value with internal spaces is redacted whole, quotes preserved',
    input: '{"password":"correct horse battery staple"}',
    secrets: ['correct horse battery staple', 'correct horse', 'staple'],
    preserve: ['{"password":"', '"}'],
  },
  {
    id: 'quoted-single-json-password-with-spaces',
    description: 'Single-quoted variant of the probe: consumed to the matching single quote',
    input: "{'password':'correct horse battery staple'}",
    secrets: ['correct horse battery staple'],
    preserve: ["{'password':'", "'}"],
  },
  {
    id: 'quoted-value-with-commas-and-braces',
    description: 'Commas and braces INSIDE a quoted value are secret material, not terminators',
    input: 'API_TOKEN="fake-head,fake-mid{fake-inner}fake-tail end"',
    secrets: ['fake-head', 'fake-mid', 'fake-inner', 'fake-tail'],
    preserve: ['API_TOKEN="'],
  },
  {
    id: 'quoted-value-empty',
    description:
      'Empty quoted values carry no secret material and are preserved verbatim (mirrors redactDeep’s empty-string rule and the previous no-match behavior)',
    input: 'password="" SESSION_TOKEN=\'\'',
    secrets: [],
    preserve: ['password=""', "SESSION_TOKEN=''"],
  },
  {
    id: 'quoted-value-escaped-quote-whole-secret',
    description:
      'Round-4 fix of a previously UNDERSTATED case: the quoted branches are JSON-string-grammar correct, so a backslash-escaped quote is consumed as part of the value and the WHOLE value — head, escaped quote, and tail — is redacted to the nearest UNESCAPED closing quote. (The prior fixture pinned this as a head-only redaction with a surviving `le tail` fragment; that understated the leak class.)',
    input: '{"password":"stap\\"le tail"}',
    secrets: ['stap\\', 'stap', 'le tail'],
    preserve: ['{"password":"', '"}'],
  },
  {
    id: 'quoted-value-mixed-quotes',
    description: 'A quote of the OTHER kind inside a quoted value is ordinary secret material',
    input: 'SECRET_TOKEN="val\'ue with space" ACCESS_TOKEN=\'he said "hi" pass\'',
    secrets: ["val'ue with space", "val'ue", 'he said "hi" pass', '"hi" pass'],
    preserve: ['SECRET_TOKEN="', "ACCESS_TOKEN='"],
  },
  {
    id: 'quoted-value-unicode',
    description: 'Unicode (accents, CJK, emoji) inside a quoted value is consumed and redacted whole',
    input: 'DB_PASSWORD="pässwörd 密码 \u{1F511} staple"',
    secrets: ['pässwörd 密码 \u{1F511} staple', 'pässwörd', '密码', '\u{1F511}'],
    preserve: ['DB_PASSWORD="'],
  },
  {
    id: 'quoted-non-secret-passthrough',
    description:
      'Quoted values under NON-sensitive keys are untouched — the quoted branches broadened WHAT a value is, never WHICH keys match',
    input: '{"role":"admin user","note":"a, b {c} d"}',
    secrets: [],
    preserve: ['{"role":"admin user"', '"note":"a, b {c} d"}'],
  },
  // -------------------------------------------------------------------------
  // Round-4 escape/truncation class (verifier-demonstrated whole-secret
  // leaks L1–L3, all previously reaching the durable
  // `limit.probe.inconclusive` row / status --json / CLI text via
  // describeRawError). All secret material is SYNTHETIC. L3 lives above as
  // `quoted-value-leading-escaped-quote` + the fixed
  // `quoted-value-escaped-quote-whole-secret`.
  // -------------------------------------------------------------------------
  {
    id: 'escaped-nested-json-password',
    description:
      'L1 demonstrated leak: a sensitive pair hidden INSIDE a stringified-JSON string value (backslash-escaped quotes, non-sensitive outer key) is matched by the escape-run rule without parsing',
    input: 'request body was {"metadata":"{\\"password\\":\\"hunter two\\"}"}',
    secrets: ['hunter two'],
    preserve: ['request body was', '"metadata"', '\\"password\\"'],
  },
  {
    id: 'escaped-nested-json-depth-two',
    description:
      'Escape depth 2 (double-stringified): the captured backslash-run generalizes — run 3 delimiters match the same way run 1 does',
    input: `provider rejected ${JSON.stringify({ outer: JSON.stringify({ inner: JSON.stringify({ api_key: 'deep two secret' }) }) })}`,
    secrets: ['deep two secret'],
    preserve: ['provider rejected', '"outer"', 'inner'],
  },
  {
    id: 'quoted-value-leading-escaped-quote',
    description:
      'L3 demonstrated leak, pinned as WHOLE-secret (not tail-only): a value that OPENS with an escaped quote is consumed to the real closing quote — grammar-correct, nothing survives',
    input: '{"password":"\\"correct horse\\""}',
    secrets: ['correct horse', '\\"correct horse\\"'],
    preserve: ['{"password":"', '"}'],
  },
  {
    id: 'unterminated-quote-truncated-value',
    description:
      'L2 demonstrated leak: provider truncation (or an upstream byte-bound) cut the closing quote — the sensitive-key-gated unterminated-quote fallback redacts to end-of-string instead of matching no branch',
    input: '{"password":"correct horse battery sta',
    secrets: ['correct horse battery sta', 'correct horse'],
    preserve: ['{"password":"'],
  },
  {
    id: 'unterminated-quote-benign-prose-not-swallowed',
    description:
      'The unterminated-quote fallback is sensitive-key-GATED: an unclosed quote in benign prose (no sensitive key ahead of it) swallows nothing',
    input: 'the deploy note said "rollback later and the log ended there',
    secrets: [],
    preserve: ['the deploy note said "rollback later and the log ended there'],
  },
];
