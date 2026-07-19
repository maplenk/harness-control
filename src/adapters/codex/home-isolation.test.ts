/**
 * Codex spawn-time CODEX_HOME isolation — unit tests (PLAN §17.1, live-gate
 * H-1). Everything runs against FIXTURE homes under mkdtemp — the
 * developer's real `~/.codex` is never touched (options.realCodexHome is
 * always injected here).
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_AUTH_JSON_BASENAME,
  CODEX_HOME_ENV_VAR,
  CODEX_SAFE_APPROVALS_REVIEWER,
  checkCodexHostApprovalsConfig,
  codexSandboxModeForRole,
  parseApprovalsReviewerValues,
  prepareCodexHomeIsolation,
  renderOrchestratorCodexConfigToml,
} from './home-isolation.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Fixture "real" provider home + a tempRoot for isolated homes. */
function fixture(options: { authJson?: string | false } = {}): {
  readonly realCodexHome: string;
  readonly tempRoot: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'codex-home-isolation-test-'));
  roots.push(root);
  const realCodexHome = path.join(root, 'dot-codex');
  mkdirSync(realCodexHome, { recursive: true });
  if (options.authJson !== false) {
    writeFileSync(
      path.join(realCodexHome, CODEX_AUTH_JSON_BASENAME),
      options.authJson ?? '{"fixture":"auth-material-bytes"}',
      { mode: 0o600 },
    );
  }
  const tempRoot = path.join(root, 'isolated');
  mkdirSync(tempRoot, { recursive: true });
  return { realCodexHome, tempRoot };
}

const modeBits = (p: string): number => statSync(p).mode & 0o777;

describe('codexSandboxModeForRole — per-role baseline mirrors the P-1 mode pins', () => {
  it('coordinator/verifier/undefined → read-only; implementor → workspace-write; never full access', () => {
    expect(codexSandboxModeForRole('coordinator')).toBe('read-only');
    expect(codexSandboxModeForRole('verifier')).toBe('read-only');
    expect(codexSandboxModeForRole(undefined)).toBe('read-only');
    expect(codexSandboxModeForRole('implementor')).toBe('workspace-write');
  });
});

describe('renderOrchestratorCodexConfigToml — minimal, client-routing, self-parsing', () => {
  it('emits ONLY approvals_reviewer=user + the sandbox baseline (no auto-approver re-enable)', () => {
    const toml = renderOrchestratorCodexConfigToml('read-only');
    expect(toml).toContain('approvals_reviewer = "user"');
    expect(toml).toContain('sandbox_mode = "read-only"');
    // No ACTIVE assignment re-enables an internal reviewer or a notify hook
    // (comments may NAME the dangerous values while explaining the guard).
    expect(toml).not.toMatch(/^\s*approvals_reviewer\s*=\s*"(?:auto_review|guardian_subagent)"/m);
    expect(toml).not.toMatch(/^\s*notify\s*=/m);
    // Our own parser must read back the safe value ONLY (writer/checker agree).
    expect(parseApprovalsReviewerValues(toml)).toEqual([CODEX_SAFE_APPROVALS_REVIEWER]);
  });
});

describe('prepareCodexHomeIsolation (H-1: isolated CODEX_HOME carrying auth material only)', () => {
  it('creates a 0700 per-run home with the orchestrator config (0600) and CODEX_HOME env', () => {
    const { realCodexHome, tempRoot } = fixture();
    const prepared = prepareCodexHomeIsolation({ realCodexHome, tempRoot, role: 'verifier' });
    expect(prepared.dir.startsWith(tempRoot + path.sep)).toBe(true);
    expect(modeBits(prepared.dir)).toBe(0o700);
    expect(prepared.env).toEqual({ [CODEX_HOME_ENV_VAR]: prepared.dir });
    expect(prepared.sandboxMode).toBe('read-only');
    expect(modeBits(prepared.configPath)).toBe(0o600);
    const toml = readFileSync(prepared.configPath, 'utf8');
    expect(parseApprovalsReviewerValues(toml)).toEqual(['user']);
    expect(toml).toContain('sandbox_mode = "read-only"');
    prepared.dispose();
  });

  it('byte-copies auth.json in with 0600 and leaves the real home untouched', () => {
    const { realCodexHome, tempRoot } = fixture({ authJson: '{"fixture":"chatgpt-tokens"}' });
    const realAuthPath = path.join(realCodexHome, CODEX_AUTH_JSON_BASENAME);
    const before = readFileSync(realAuthPath, 'utf8');
    const prepared = prepareCodexHomeIsolation({ realCodexHome, tempRoot, role: 'implementor' });
    expect(prepared.authMaterial).toBe('auth_json');
    expect(prepared.sandboxMode).toBe('workspace-write');
    const isolatedAuthPath = path.join(prepared.dir, CODEX_AUTH_JSON_BASENAME);
    expect(readFileSync(isolatedAuthPath, 'utf8')).toBe(before); // byte-identical COPY
    expect(modeBits(isolatedAuthPath)).toBe(0o600);
    // COPY-IN semantics: mutating the isolated copy (a core token refresh)
    // must never reach the real file.
    writeFileSync(isolatedAuthPath, '{"fixture":"refreshed-in-isolation"}');
    expect(readFileSync(realAuthPath, 'utf8')).toBe(before);
    prepared.dispose();
  });

  it('missing real auth.json → authMaterial none, isolation still complete', () => {
    const { realCodexHome, tempRoot } = fixture({ authJson: false });
    const prepared = prepareCodexHomeIsolation({ realCodexHome, tempRoot });
    expect(prepared.authMaterial).toBe('none');
    expect(existsSync(path.join(prepared.dir, CODEX_AUTH_JSON_BASENAME))).toBe(false);
    expect(existsSync(prepared.configPath)).toBe(true);
    prepared.dispose();
  });

  it('dispose removes the whole home (incl. copied auth material) and is idempotent', () => {
    const { realCodexHome, tempRoot } = fixture();
    const prepared = prepareCodexHomeIsolation({ realCodexHome, tempRoot });
    expect(existsSync(prepared.dir)).toBe(true);
    prepared.dispose();
    expect(existsSync(prepared.dir)).toBe(false);
    prepared.dispose(); // idempotent
    expect(existsSync(prepared.dir)).toBe(false);
  });

  it('two runs get DISTINCT isolated homes (per-run, never shared)', () => {
    const { realCodexHome, tempRoot } = fixture();
    const first = prepareCodexHomeIsolation({ realCodexHome, tempRoot });
    const second = prepareCodexHomeIsolation({ realCodexHome, tempRoot });
    expect(first.dir).not.toBe(second.dir);
    first.dispose();
    second.dispose();
  });
});

describe('parseApprovalsReviewerValues — the doctor-side read-only parser', () => {
  it('extracts quoted assignments, tolerating whitespace and trailing comments', () => {
    expect(
      parseApprovalsReviewerValues(
        ['# header', 'model = "gpt-5.6-sol"', '  approvals_reviewer = "auto_review"  # danger', ''].join(
          '\n',
        ),
      ),
    ).toEqual(['auto_review']);
  });

  it('finds profile-scoped assignments too (over-warning is the safe direction)', () => {
    expect(
      parseApprovalsReviewerValues(
        ['approvals_reviewer = "user"', '[profiles.risky]', 'approvals_reviewer = "guardian_subagent"'].join(
          '\n',
        ),
      ),
    ).toEqual(['user', 'guardian_subagent']);
  });

  it('returns empty when the key never appears (core default user applies)', () => {
    expect(parseApprovalsReviewerValues('model = "x"\n')).toEqual([]);
    expect(parseApprovalsReviewerValues('# approvals_reviewer = "auto_review" (commented out)')).toEqual(
      [],
    );
  });
});

describe('checkCodexHostApprovalsConfig (doctor H-1 flag; read-only, never mutates)', () => {
  it('absent config.toml → safe (core documented default user)', () => {
    const { realCodexHome } = fixture({ authJson: false });
    const check = checkCodexHostApprovalsConfig(realCodexHome);
    expect(check.exists).toBe(false);
    expect(check.safe).toBe(true);
    expect(check.issues).toEqual([]);
  });

  it('approvals_reviewer = "user" → safe', () => {
    const { realCodexHome } = fixture({ authJson: false });
    writeFileSync(path.join(realCodexHome, 'config.toml'), 'approvals_reviewer = "user"\n');
    const check = checkCodexHostApprovalsConfig(realCodexHome);
    expect(check).toMatchObject({ exists: true, approvalsReviewers: ['user'], safe: true, issues: [] });
  });

  it('the live H-1 posture (auto_review) is FLAGGED with an explanatory issue — file untouched', () => {
    const { realCodexHome } = fixture({ authJson: false });
    const configPath = path.join(realCodexHome, 'config.toml');
    const content = '# host config\napprovals_reviewer = "auto_review"\nnotify = ["helper"]\n';
    writeFileSync(configPath, content);
    const check = checkCodexHostApprovalsConfig(realCodexHome);
    expect(check.safe).toBe(false);
    expect(check.approvalsReviewers).toEqual(['auto_review']);
    expect(check.issues.join(' ')).toContain('auto_review');
    expect(check.issues.join(' ')).toContain('H-1');
    // READ-ONLY guarantee: byte-identical after the check.
    expect(readFileSync(configPath, 'utf8')).toBe(content);
  });

  it('the legacy guardian_subagent alias is flagged identically', () => {
    const { realCodexHome } = fixture({ authJson: false });
    writeFileSync(path.join(realCodexHome, 'config.toml'), 'approvals_reviewer = "guardian_subagent"\n');
    expect(checkCodexHostApprovalsConfig(realCodexHome).safe).toBe(false);
  });
});
