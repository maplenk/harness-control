/**
 * `doctor` (PLAN §18) — offline-deterministic conformance. Auth checks run
 * against an injected fake HOME + env (never the developer's real
 * credentials); the handshake section spawns only the FAKE ACP child through
 * the real transport (integration-style, generous bounds); adapter
 * resolution reads this repo's own lockfile-pinned node_modules.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import {
  EXPECTED_CLAUDE_ADAPTER_VERSION,
} from '../adapters/claude/index.js';
import { EXPECTED_CODEX_ADAPTER_VERSION } from '../adapters/codex/index.js';
import { BYTES_PER_GB } from '../config/schema.js';
import { runDoctor, renderDoctorText } from './doctor.js';
import { CLI_USAGE, parseCliArgs } from './index.js';

const GENEROUS_MS = 30_000;
const CLOCK = new ManualClock('2026-07-18T12:00:00.000Z');

const tempDirs: string[] = [];
async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('doctor — full report (fake handshake, real pinned resolution, temp sqlite)', () => {
  it(
    'reports every §18 section and warns (not fails) when no auth evidence exists',
    async () => {
      const home = await makeTempDir('doctor-home-empty-');
      const report = await runDoctor({ env: {}, homeDir: home, clock: CLOCK });

      expect(report.generatedAt).toBe(CLOCK.nowIso());

      // Adapters: resolved from THIS repo's lockfile-pinned node_modules.
      expect(report.adapters.map((a) => a.harnessId)).toEqual(['claude', 'codex']);
      for (const adapter of report.adapters) {
        expect(adapter.resolved).toBe(true);
        expect(adapter.versionPinned).toBe(true);
        expect(adapter.binPath).toContain('node_modules');
        expect(adapter.provenance).toContain('never npx -y');
      }
      expect(report.adapters[0]?.installedVersion).toBe(EXPECTED_CLAUDE_ADAPTER_VERSION);
      expect(report.adapters[1]?.installedVersion).toBe(EXPECTED_CODEX_ADAPTER_VERSION);
      expect(report.adapters[1]?.provenance).toContain('optionalDependencies');

      // Auth: empty env + empty home → honest unknown for both providers.
      expect(report.auth.map((a) => [a.provider, a.readiness])).toEqual([
        ['claude', 'unknown'],
        ['codex', 'unknown'],
      ]);

      // Host config (H-1): no ~/.codex/config.toml → safe (core default user).
      expect(report.hostConfig.codex).toMatchObject({ exists: false, safe: true, issues: [] });
      expect(report.hostConfig.codex.configPath).toBe(path.join(home, '.codex', 'config.toml'));

      // Fake-adapter handshake through the real transport stack.
      expect(report.acpHandshake.target).toBe('fake');
      expect(report.acpHandshake.ok).toBe(true);
      expect(report.acpHandshake.spawnIdEchoed).toBe(true);
      expect(report.acpHandshake.protocolVersion).toBe('1');
      expect(report.acpHandshake.note).toContain('live compatibility gate');

      // Git + sqlite + quotas.
      expect(report.git.available).toBe(true);
      expect(report.git.version).toContain('git version');
      expect(report.sqlite.ok).toBe(true);
      expect(report.sqlite.driver).toBe('better-sqlite3');
      expect(report.sqlite.pragmas?.journalMode.toLowerCase()).toBe('wal');
      expect(report.sqlite.pragmas?.foreignKeys).toBe(true);
      expect(report.sqlite.pragmas?.busyTimeoutMs).toBeGreaterThan(0);
      expect(typeof report.sqlite.nodeSqliteAvailable).toBe('boolean');
      expect(report.quotas).toMatchObject({
        source: 'defaults',
        perRunBytes: 2 * BYTES_PER_GB,
        globalBytes: 20 * BYTES_PER_GB,
        issues: [],
      });

      // No structural failure + no positive auth evidence → warn, with note.
      expect(report.overall).toBe('warn');
      expect(report.notes.join(' ')).toContain('no provider has positive');

      // JSON-stable (§18: stable --json everywhere).
      expect(() => JSON.stringify(report)).not.toThrow();
      const text = renderDoctorText(report);
      expect(text).toContain('overall: WARN');
      expect(text).toContain('claude');
      expect(text).toContain('codex');
    },
    GENEROUS_MS,
  );

  it(
    'auth evidence-honest mapping (H-2): presence — env key OR on-disk material — is never supported',
    async () => {
      const home = await makeTempDir('doctor-home-creds-');
      await mkdir(path.join(home, '.claude'), { recursive: true });
      await writeFile(path.join(home, '.claude', '.credentials.json'), '{}', 'utf8');
      await mkdir(path.join(home, '.codex'), { recursive: true });
      await writeFile(path.join(home, '.codex', 'auth.json'), '{}', 'utf8');

      // Disk artifacts only: claude OAuth state stays detected_but_unsupported
      // (ToS-barred path); codex auth.json is the REAL (ChatGPT subscription)
      // path — material present but unvalidated until a turn succeeds.
      const detected = await runDoctor({ env: {}, homeDir: home, clock: CLOCK });
      expect(detected.auth.map((a) => a.readiness)).toEqual([
        'detected_but_unsupported',
        'detected_but_unvalidated',
      ]);
      expect(detected.auth[0]?.evidence.join(' ')).toContain('.credentials.json');
      expect(detected.auth[1]?.evidence.join(' ')).toContain('auth.json');
      expect(detected.overall).toBe('warn');

      // Env keys are MATERIAL, not validation (the live gate proved a
      // present OPENAI_API_KEY 401-invalid): detected_but_unvalidated, and
      // overall stays warn — never ok from presence alone.
      const withKeys = await runDoctor({
        env: { ANTHROPIC_API_KEY: 'sk-ant-x', OPENAI_API_KEY: 'sk-oai-x' },
        homeDir: home,
        clock: CLOCK,
      });
      expect(withKeys.auth.map((a) => a.readiness)).toEqual([
        'detected_but_unvalidated',
        'detected_but_unvalidated',
      ]);
      expect(withKeys.overall).toBe('warn');
      expect(withKeys.notes.join(' ')).toContain('VALIDATED');
    },
    GENEROUS_MS,
  );

  it(
    'host-config safety (H-1): approvals_reviewer=auto_review in ~/.codex/config.toml is FLAGGED read-only',
    async () => {
      const home = await makeTempDir('doctor-home-hostcfg-');
      await mkdir(path.join(home, '.codex'), { recursive: true });
      const configPath = path.join(home, '.codex', 'config.toml');
      const content = 'approvals_reviewer = "auto_review"\n';
      await writeFile(configPath, content, 'utf8');

      const report = await runDoctor({ env: {}, homeDir: home, clock: CLOCK });
      expect(report.hostConfig.codex).toMatchObject({
        exists: true,
        approvalsReviewers: ['auto_review'],
        safe: false,
      });
      expect(report.hostConfig.codex.issues.join(' ')).toContain('auto_review');
      expect(report.overall).toBe('warn'); // flagged, never fail (isolation mitigates), never mutated
      expect(report.notes.join(' ')).toContain('host codex config flagged (H-1)');
      const { readFile } = await import('node:fs/promises');
      expect(await readFile(configPath, 'utf8')).toBe(content); // READ-ONLY

      const text = renderDoctorText(report);
      expect(text).toContain('host config');
      expect(text).toContain('WARN');

      // Safe value → no flag.
      await writeFile(configPath, 'approvals_reviewer = "user"\n', 'utf8');
      const safeReport = await runDoctor({ env: {}, homeDir: home, clock: CLOCK });
      expect(safeReport.hostConfig.codex).toMatchObject({ safe: true, approvalsReviewers: ['user'] });
      expect(safeReport.notes.join(' ')).not.toContain('host codex config flagged');
    },
    GENEROUS_MS,
  );

  it(
    'quota section honors --config FILE; invalid config → overall fail with all issues listed',
    async () => {
      const dir = await makeTempDir('doctor-config-');
      const good = path.join(dir, 'good.json');
      await writeFile(
        good,
        JSON.stringify({ quotas: { perRunBytes: 1024, globalBytes: 4096 } }),
        'utf8',
      );
      const withFile = await runDoctor({ env: {}, homeDir: dir, clock: CLOCK, configPath: good });
      expect(withFile.quotas).toMatchObject({
        source: 'file',
        configPath: good,
        perRunBytes: 1024,
        globalBytes: 4096,
      });

      const bad = path.join(dir, 'bad.json');
      await writeFile(bad, JSON.stringify({ quotas: { perRunBytes: -1 } }), 'utf8');
      const failed = await runDoctor({ env: {}, homeDir: dir, clock: CLOCK, configPath: bad });
      expect(failed.quotas.issues.length).toBeGreaterThan(0);
      expect(failed.overall).toBe('fail');
      expect(failed.notes.join(' ')).toContain('engine config invalid');
    },
    GENEROUS_MS,
  );
});

describe('cli arg parsing (hand-rolled, §18)', () => {
  it('parses doctor with --json and --config in both forms', () => {
    expect(parseCliArgs(['doctor'])).toEqual({ kind: 'doctor', json: false });
    expect(parseCliArgs(['doctor', '--json'])).toEqual({ kind: 'doctor', json: true });
    expect(parseCliArgs(['doctor', '--json', '--config', 'x.json'])).toEqual({
      kind: 'doctor',
      json: true,
      configPath: 'x.json',
    });
    expect(parseCliArgs(['doctor', '--config=y.json'])).toEqual({
      kind: 'doctor',
      json: false,
      configPath: 'y.json',
    });
  });

  it('help, unknown commands, and malformed options are usage-safe', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['doctor', '--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['frobnicate'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['doctor', '--config'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['doctor', '--wat'])).toMatchObject({ kind: 'usage_error' });
    expect(CLI_USAGE).toContain('doctor');
  });
});
