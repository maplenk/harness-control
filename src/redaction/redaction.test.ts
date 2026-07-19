import { describe, expect, it } from 'vitest';
import { REDACTION_FIXTURES } from './fixtures.js';
import { isSecretKeyName } from './patterns.js';
import {
  DEFAULT_REDACTION_CONFIG,
  redactDeep,
  redactError,
  redactFlattenedJson,
  redactText,
  type RedactionConfig,
} from './redact.js';

describe('redactText fixture corpus (PLAN §19 test 15)', () => {
  for (const fixture of REDACTION_FIXTURES) {
    it(`${fixture.id}: ${fixture.description}`, () => {
      const output = redactText(fixture.input);
      for (const secret of fixture.secrets) {
        expect(output).not.toContain(secret);
      }
      if (fixture.secrets.length > 0) {
        expect(output).toContain('[REDACTED:');
      }
      for (const kept of fixture.preserve ?? []) {
        expect(output).toContain(kept);
      }
    });
  }

  it('is idempotent: redacting already-redacted text is a no-op', () => {
    for (const fixture of REDACTION_FIXTURES) {
      const once = redactText(fixture.input);
      const twice = redactText(once);
      expect(twice).toBe(once);
    }
  });

  it('is pure and deterministic across repeated calls', () => {
    const fixture = REDACTION_FIXTURES[0]!;
    expect(redactText(fixture.input)).toBe(redactText(fixture.input));
  });
});

describe('credential_assignment — quoted values (round-3 gap)', () => {
  it('redacts the exact demonstrated fuzzing probe byte-exactly, quotes preserved', () => {
    expect(redactText('{"password":"correct horse battery staple"}')).toBe('{"password":"[REDACTED:credential]"}');
  });

  it('redacts the single-quoted variant byte-exactly', () => {
    expect(redactText("{'password':'correct horse battery staple'}")).toBe("{'password':'[REDACTED:credential]'}");
  });

  it('preserves EMPTY quoted values verbatim — no fabricated credential (mirrors redactDeep)', () => {
    const input = 'password="" SESSION_TOKEN=\'\'';
    expect(redactText(input)).toBe(input);
  });

  it('an empty quoted value never shields a following sensitive assignment', () => {
    expect(redactText('password="" API_KEY=leak-me-not')).toBe('password="" API_KEY=[REDACTED:credential]');
  });

  it('escaped-quote JSON is FULLY covered on BOTH paths: redactDeep structurally AND redactText grammar-correctly (round-4)', () => {
    // Structurally, the key name alone replaces the WHOLE value; textually,
    // the grammar-correct quoted branch now consumes the escaped quote as
    // part of the value (fixture `quoted-value-escaped-quote-whole-secret`).
    const out = redactDeep({ password: 'stap"le tail' });
    expect(out.password).toBe('[REDACTED:credential]');
    expect(JSON.stringify(out)).not.toContain('le tail');
    expect(redactText('{"password":"stap\\"le tail"}')).toBe('{"password":"[REDACTED:credential]"}');
  });
});

// ---------------------------------------------------------------------------
// Round 4 — the escape/truncation class (L1 nested-JSON literal escapes,
// L2 unterminated/truncated quote, L3 leading-escaped-quote). All secret
// material is SYNTHETIC.
// ---------------------------------------------------------------------------

describe('round-4 escape/truncation class — byte-exact demonstrated leaks', () => {
  it('L1: a sensitive pair inside a stringified-JSON string value is redacted byte-exactly, escape framing preserved', () => {
    expect(redactText('request body was {"metadata":"{\\"password\\":\\"hunter two\\"}"}')).toBe(
      'request body was {"metadata":"{\\"password\\":\\"[REDACTED:credential]\\"}"}',
    );
  });

  it('L2: an unterminated quoted value after a sensitive key redacts to end-of-string, byte-exactly', () => {
    expect(redactText('{"password":"correct horse battery sta')).toBe('{"password":"[REDACTED:credential]');
  });

  it('L2 single-quote analog', () => {
    expect(redactText("{'password':'correct horse battery sta")).toBe("{'password':'[REDACTED:credential]");
  });

  it('L3: a leading-escaped-quote value is a WHOLE-secret redaction, byte-exactly', () => {
    expect(redactText('{"password":"\\"correct horse\\""}')).toBe('{"password":"[REDACTED:credential]"}');
  });

  it('escape depth 2 and 3: the captured backslash-run generalizes (runs 3 and 7), byte-exactly', () => {
    const depth2 = JSON.stringify({ outer: JSON.stringify({ inner: JSON.stringify({ api_key: 'deep two secret' }) }) });
    const depth2Redacted = JSON.stringify({
      outer: JSON.stringify({ inner: JSON.stringify({ api_key: '[REDACTED:credential]' }) }),
    });
    expect(redactText(depth2)).toBe(depth2Redacted);

    const depth3 = JSON.stringify({
      a: JSON.stringify({ b: JSON.stringify({ c: JSON.stringify({ password: 'deep three secret' }) }) }),
    });
    const depth3Redacted = JSON.stringify({
      a: JSON.stringify({ b: JSON.stringify({ c: JSON.stringify({ password: '[REDACTED:credential]' }) }) }),
    });
    expect(redactText(depth3)).toBe(depth3Redacted);
  });

  it('escaped unterminated value (truncation inside stringified JSON) redacts to end-of-string', () => {
    expect(redactText('{"metadata":"{\\"password\\":\\"hunter t')).toBe(
      '{"metadata":"{\\"password\\":\\"[REDACTED:credential]',
    );
  });

  it('the unterminated fallback is sensitive-key-gated: benign prose with a lone quote is untouched', () => {
    const prose = 'the deploy note said "rollback later and the log ended there';
    expect(redactText(prose)).toBe(prose);
  });

  it('round-4 outputs are idempotent under redactText', () => {
    for (const input of [
      'request body was {"metadata":"{\\"password\\":\\"hunter two\\"}"}',
      '{"password":"correct horse battery sta',
      '{"password":"\\"correct horse\\""}',
      '{"metadata":"{\\"password\\":\\"hunter t',
    ]) {
      const once = redactText(input);
      expect(redactText(once)).toBe(once);
    }
  });
});

// Deterministic PRNG (mulberry32) so the fuzz is reproducible.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SENSITIVE_KEYS = [
  'password',
  'api_key',
  'ACCESS_TOKEN',
  'client_secret',
  'SESSION_TOKEN',
  'passwd',
  'credential',
  'private_key',
] as const;

const WRAPPER_KEYS = ['metadata', 'blob', 'payload', 'wrapped'] as const;

function pick<T>(rand: () => number, items: readonly T[]): T {
  return items[Math.floor(rand() * items.length)]!;
}

function randomValue(rand: () => number, charset: readonly string[], core: string): string {
  const chunk = (): string =>
    Array.from({ length: 3 + Math.floor(rand() * 6) }, () => pick(rand, charset)).join('');
  return `${chunk()} ${core} ${chunk()}`;
}

/** Build `depth` levels of stringification around a sensitive pair; returns
 * the FLAT text a provider error would carry. Depth 0 is plain JSON. */
function flattenedProbe(rand: () => number, depth: number, value: string): string {
  const key = pick(rand, SENSITIVE_KEYS);
  let obj: Record<string, unknown> = { [key]: value, note: 'benign note' };
  for (let level = 0; level < depth; level += 1) {
    obj = { [pick(rand, WRAPPER_KEYS)]: JSON.stringify(obj) };
  }
  return `provider rejected: ${JSON.stringify(obj)} (status 400)`;
}

describe('round-4 fuzz — stringification depth 0-3 (deterministic, synthetic secrets)', () => {
  const SIMPLE_CHARSET = [...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-.!@#,é密'] as const;
  const NASTY_CHARSET = [...SIMPLE_CHARSET, '"', "'", '\\', '\n', '{', '}', ':', '[', ']'] as const;

  it('regex layer (redactText): simple values, depth 0-3 — the escaping-invariant core never survives', () => {
    const rand = mulberry32(0x40a2b1c3);
    for (let i = 0; i < 200; i += 1) {
      const depth = i % 4;
      const core = `zqcore${i}x${'k'.repeat(8)}`;
      const flat = flattenedProbe(rand, depth, randomValue(rand, SIMPLE_CHARSET, core));
      const out = redactText(flat);
      expect(out, `depth ${depth} case ${i}: ${flat}`).not.toContain(core);
      expect(out).toContain('benign note'); // sibling keys survive — no over-redaction
      expect(redactText(out)).toBe(out); // idempotent
    }
  });

  it('flat-error belt (redactFlattenedJson): FULL JSON-grammar values (quotes/backslashes/newlines), depth 0-3', () => {
    const rand = mulberry32(0x5eed);
    for (let i = 0; i < 200; i += 1) {
      const depth = i % 4;
      const core = `zqbelt${i}x${'m'.repeat(8)}`;
      const flat = flattenedProbe(rand, depth, randomValue(rand, NASTY_CHARSET, core));
      const out = redactFlattenedJson(flat);
      expect(out, `depth ${depth} case ${i}: ${flat}`).not.toContain(core);
      expect(out).toContain('benign note');
      expect(redactText(out)).toBe(out); // belt output is stable under redactText
    }
  });
});

describe('round-4 — redactFlattenedJson (the describeRawError belt)', () => {
  it('redacts the L1 probe byte-exactly via the structural walk (parse → key-name redact → re-stringify)', () => {
    expect(redactFlattenedJson('request body was {"metadata":"{\\"password\\":\\"hunter two\\"}"}')).toBe(
      'request body was {"metadata":"{\\"password\\":\\"[REDACTED:credential]\\"}"}',
    );
  });

  it('falls back gracefully on truncated (unparseable) JSON — the pattern layer still redacts', () => {
    expect(redactFlattenedJson('{"password":"correct horse battery sta')).toBe(
      '{"password":"[REDACTED:credential]',
    );
  });

  it('is never weaker than redactText on plain non-JSON text', () => {
    for (const fixture of REDACTION_FIXTURES) {
      const out = redactFlattenedJson(fixture.input);
      for (const secret of fixture.secrets) {
        expect(out, fixture.id).not.toContain(secret);
      }
    }
  });

  it('leaves non-secret JSON semantically intact (values preserved through parse/re-stringify)', () => {
    const out = redactFlattenedJson('probe saw {"role":"admin user","count":3}');
    expect(out).toContain('"role":"admin user"');
    expect(out).toContain('"count":3'); // non-string primitives survive
    expect(out).toContain('probe saw ');
  });

  it('oversized inputs take the plain redactText fallback and still redact', () => {
    const big = `${'x'.repeat(70 * 1024)} API_KEY=sup3r-s3cret-value`;
    const out = redactFlattenedJson(big);
    expect(out).not.toContain('sup3r-s3cret-value');
    expect(out).toContain('[REDACTED:credential]');
  });
});

describe('round-4 — truncation order regression (slices mid-quote and mid-escape)', () => {
  /** Every 4-char window of `secretSpan` must be absent from `out`. */
  function expectNoWindow(out: string, secretSpan: string, context: string): void {
    for (let w = 0; w + 4 <= secretSpan.length; w += 1) {
      expect(out, context).not.toContain(secretSpan.slice(w, w + 4));
    }
  }

  const CASES: ReadonlyArray<{ readonly id: string; readonly text: string; readonly secretSpan: string }> = [
    {
      id: 'plain quoted JSON',
      text: '{"password":"correct horse battery staple"}',
      secretSpan: 'correct horse battery staple',
    },
    {
      id: 'escaped depth-1 JSON',
      text: 'request body was {"metadata":"{\\"password\\":\\"hunter two secret\\"}"}',
      secretSpan: 'hunter two secret',
    },
    {
      id: 'escaped quote inside the value (mid-escape cuts)',
      text: '{"password":"stap\\"le tail here"}',
      secretSpan: 'stap\\"le tail here',
    },
    {
      id: 'unquoted env assignment',
      text: 'API_KEY=8f14e45fceea167a5a36dedd4bea2543',
      secretSpan: '8f14e45fceea167a5a36dedd4bea2543',
    },
  ];

  it('redact-BEFORE-truncate (the enforced site order): no slice of the redacted text leaks any fragment', () => {
    for (const { id, text, secretSpan } of CASES) {
      const redacted = redactText(text);
      for (let cut = 0; cut <= redacted.length; cut += 1) {
        expectNoWindow(redacted.slice(0, cut), secretSpan, `${id} @redacted-cut ${cut}`);
      }
    }
  });

  it('defense in depth for capture-time byte caps: redaction AFTER a cut (any position, incl. mid-escape/mid-quote) still leaks no fragment', () => {
    for (const { id, text, secretSpan } of CASES) {
      for (let cut = 0; cut <= text.length; cut += 1) {
        const out = redactText(text.slice(0, cut));
        expectNoWindow(out, secretSpan, `${id} @raw-cut ${cut}`);
      }
    }
  });

  it('the flat-error belt holds under the same raw cuts (parse failure → fallback still redacts)', () => {
    for (const { id, text, secretSpan } of CASES) {
      for (let cut = 0; cut <= text.length; cut += 1) {
        const out = redactFlattenedJson(text.slice(0, cut));
        expectNoWindow(out, secretSpan, `${id} @belt-cut ${cut}`);
      }
    }
  });
});

describe('isSecretKeyName', () => {
  it('matches common secret-shaped identifiers', () => {
    for (const name of [
      'API_KEY',
      'apiKey',
      'aws_secret_access_key',
      'STRIPE_SECRET_KEY',
      'password',
      'DB_PASSWORD',
      'access_token',
      'client_secret',
      'private_key',
    ]) {
      expect(isSecretKeyName(name)).toBe(true);
    }
  });

  it('does not flag plausible false positives', () => {
    for (const name of ['author', 'authentic', 'sortKey', 'primaryKey', 'PORT', 'NODE_ENV', 'username', 'role']) {
      expect(isSecretKeyName(name)).toBe(false);
    }
  });
});

describe('redactDeep — structural sink coverage (DB rows, checkpoint content)', () => {
  it('redacts by KEY NAME even when the value has no recognizable secret shape', () => {
    const row = { id: 42, username: 'alice', password: 'hunter2', role: 'admin' };
    const output = redactDeep(row);
    expect(output.password).toBe('[REDACTED:credential]');
    expect(output.username).toBe('alice');
    expect(output.role).toBe('admin');
    expect(output.id).toBe(42);
  });

  it('recurses through nested objects and arrays (DB row / checkpoint content shape)', () => {
    const checkpointLikeContent = {
      specHash: 'abc123',
      constraints: ['never touch prod'],
      confirmedDecisions: ['use bearer sk-ant-api03-1234567890ABCDEFGHIJ for the smoke test'],
      unresolvedRisks: ['leaked AWS key AKIAIOSFODNN7EXAMPLE in an old commit'],
      worktree: {
        headSha: 'deadbeef',
        statusPorcelain: ' M src/index.ts',
        secretsFound: { DB_PASSWORD: 'CorrectHorseBatteryStaple9!' },
      },
      permissionPolicy: { mode: 'headless', allowlist: ['git status'] },
    };
    const output = redactDeep(checkpointLikeContent);
    expect(JSON.stringify(output)).not.toContain('sk-ant-api03-1234567890ABCDEFGHIJ');
    expect(JSON.stringify(output)).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(output.worktree.secretsFound.DB_PASSWORD).toBe('[REDACTED:credential]');
    // non-secret structure is preserved verbatim
    expect(output.specHash).toBe('abc123');
    expect(output.worktree.headSha).toBe('deadbeef');
    expect(output.permissionPolicy).toEqual({ mode: 'headless', allowlist: ['git status'] });
    expect(output.constraints).toEqual(['never touch prod']);
  });

  it('leaves non-string primitives untouched (numbers, booleans, null, Date)', () => {
    const when = new Date('2026-07-18T00:00:00.000Z');
    const value = { count: 3, active: true, missing: null, when };
    const output = redactDeep(value);
    expect(output.count).toBe(3);
    expect(output.active).toBe(true);
    expect(output.missing).toBeNull();
    expect(output.when).toBe(when);
  });

  it('does not mutate the input', () => {
    const row = { password: 'hunter2' };
    const before = JSON.stringify(row);
    redactDeep(row);
    expect(JSON.stringify(row)).toBe(before);
  });
});

describe('redactError — error-string sink coverage', () => {
  it('redacts secrets embedded in an Error message', () => {
    const error = new Error('request to https://api.example.com failed: Authorization: Bearer sk-ant-api03-zzzzzzzzzzzzzzzzzzzz rejected');
    const output = redactError(error);
    expect(output).not.toContain('sk-ant-api03-zzzzzzzzzzzzzzzzzzzz');
    expect(output.startsWith('Error: ')).toBe(true);
  });

  it('preserves a custom error name', () => {
    class HarnessError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'HarnessError';
      }
    }
    const output = redactError(new HarnessError('AKIAIOSFODNN7EXAMPLE leaked'));
    expect(output.startsWith('HarnessError: ')).toBe(true);
    expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('handles non-Error thrown values (string and object)', () => {
    expect(redactError('DB_PASSWORD=hunter2plus')).not.toContain('hunter2plus');
    const obj = redactError({ password: 'hunter2', code: 'EAUTH' });
    expect(obj).not.toContain('hunter2');
    expect(obj).toContain('EAUTH');
  });
});

describe('configurable project patterns (§17.1)', () => {
  const PROJECT_TOKEN = 'PROJ-SECRET-778812';
  const text = `internal ticket token ${PROJECT_TOKEN} must never leave the build`;

  it('does not redact an unregistered project-specific format under the default config', () => {
    expect(redactText(text)).toContain(PROJECT_TOKEN);
  });

  it('redacts once a project pattern is registered, without disturbing surrounding text', () => {
    const config: RedactionConfig = {
      ...DEFAULT_REDACTION_CONFIG,
      projectPatterns: [{ id: 'proj_ticket_token', regex: /PROJ-SECRET-\d+/ }],
    };
    const output = redactText(text, config);
    expect(output).not.toContain(PROJECT_TOKEN);
    expect(output).toContain('[REDACTED:proj_ticket_token]');
    expect(output).toContain('internal ticket token');
    expect(output).toContain('must never leave the build');
  });

  it('normalizes a non-global custom regex so every occurrence is redacted, not just the first', () => {
    const config: RedactionConfig = {
      ...DEFAULT_REDACTION_CONFIG,
      projectPatterns: [{ id: 'repeat', regex: /XSECRETX/ }], // intentionally no 'g' flag
    };
    const output = redactText('XSECRETX and again XSECRETX', config);
    expect(output).toBe('[REDACTED:repeat] and again [REDACTED:repeat]');
  });

  it('still applies built-in rules alongside project patterns', () => {
    const config: RedactionConfig = {
      ...DEFAULT_REDACTION_CONFIG,
      projectPatterns: [{ id: 'proj_ticket_token', regex: /PROJ-SECRET-\d+/g }],
    };
    const output = redactText(`API_KEY=sk-abcdefghijklmnop and ${PROJECT_TOKEN}`, config);
    expect(output).not.toContain('sk-abcdefghijklmnop');
    expect(output).not.toContain(PROJECT_TOKEN);
  });
});
