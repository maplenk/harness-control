/**
 * Factory composition conformance (PLAN §5, §9, §10, §17.1): profile ×
 * generic ACP transport. Offline: command resolution reads the repo's own
 * pinned node_modules; the only process ever spawned is the FAKE ACP child
 * (via the documented `spawnOverride` seam) — real adapters are never
 * spawned outside the P2 live gate. Codex H-1 home isolation always runs
 * against FIXTURE homes here (never the developer's real `~/.codex`):
 * either `codexHome` points at a fixture, or `mode:'inherit_host'` disables
 * isolation for tests where it is irrelevant.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import {
  CLAUDE_HARNESS_ID,
  CLAUDE_PACKAGE_NAME,
  CLAUDE_SESSION_MODE_POLICY,
  EXPECTED_CLAUDE_ADAPTER_VERSION,
} from './claude/index.js';
import {
  CODEX_AUTH_JSON_BASENAME,
  CODEX_HARNESS_ID,
  CODEX_HOME_ENV_VAR,
  CODEX_SESSION_MODE_POLICY,
  EXPECTED_CODEX_ADAPTER_VERSION,
} from './codex/index.js';
import {
  EXPECTED_OPENCODE_VERSION,
  OPENCODE_AUTH_JSON_RELATIVE_PATH,
  OPENCODE_HARNESS_ID,
  OPENCODE_PERMISSION_ENV_VAR,
  OPENCODE_SESSION_MODE_POLICY,
  openCodePermissionPolicyForRole,
  openCodeAuthJsonPath,
} from './opencode/index.js';
import { fakeAcpChildPath, writeScenarioFile, type FakeAcpScenario } from './fake/index.js';
import type { SessionUpdate } from './spi.js';
import {
  createClaudeAcpAdapter,
  createCodexAcpAdapter,
  createOpenCodeAcpAdapter,
  providerStaticOverrides,
} from './factory.js';

const GENEROUS_MS = 20_000;
const CLOCK = new ManualClock('2026-07-18T12:00:00.000Z');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Isolation disabled — for tests where the codex home is irrelevant (no
 * fixture I/O, and the developer's real ~/.codex is never consulted). */
const NO_ISOLATION = { mode: 'inherit_host' } as const;
const NO_OPENCODE_ISOLATION = { mode: 'inherit_host' } as const;

/** Fixture "real" codex home + tempRoot (H-1 tests never touch ~/.codex). */
function fixtureCodexHome(options: { authJson?: boolean } = {}): {
  readonly realCodexHome: string;
  readonly tempRoot: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-codex-home-'));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const realCodexHome = path.join(root, 'dot-codex');
  mkdirSync(realCodexHome, { recursive: true });
  if (options.authJson !== false) {
    writeFileSync(path.join(realCodexHome, CODEX_AUTH_JSON_BASENAME), '{"fixture":"chatgpt-login"}', {
      mode: 0o600,
    });
  }
  const tempRoot = path.join(root, 'isolated');
  mkdirSync(tempRoot, { recursive: true });
  return { realCodexHome, tempRoot };
}

function fixtureOpenCodeHome(options: { authJson?: boolean } = {}): {
  readonly realHome: string;
  readonly tempRoot: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-opencode-home-'));
  cleanups.push(async () => rm(root, { recursive: true, force: true }));
  const realHome = path.join(root, 'real-home');
  mkdirSync(realHome, { recursive: true });
  if (options.authJson !== false) {
    const authPath = openCodeAuthJsonPath(realHome);
    mkdirSync(path.dirname(authPath), { recursive: true });
    writeFileSync(authPath, 'opaque-opencode-auth-fixture', { mode: 0o600 });
  }
  const tempRoot = path.join(root, 'isolated');
  mkdirSync(tempRoot, { recursive: true });
  return { realHome, tempRoot };
}

const claudeLimitEnvelope = {
  code: -32603,
  message: 'rate limited',
  data: { errorKind: 'rate_limit' },
};
const codexLimitEnvelope = {
  code: -32603,
  message: 'usage limit',
  data: { codexErrorInfo: 'usageLimitExceeded' },
};

describe('provider adapter factory — command resolution + version pin (§3, §13, §17.1)', () => {
  it('claude: resolves the lockfile-pinned binary, asserts the pin, spawns via process.execPath', () => {
    const { adapter, resolved, spawn } = createClaudeAcpAdapter({ clock: CLOCK, processEnv: {} });
    expect(adapter.harnessId).toBe(CLAUDE_HARNESS_ID);
    expect(resolved.packageName).toBe(CLAUDE_PACKAGE_NAME);
    expect(resolved.version).toBe(EXPECTED_CLAUDE_ADAPTER_VERSION);
    expect(spawn.command).toBe(process.execPath);
    expect(spawn.args).toEqual([resolved.binPath]);
  });

  it('codex: resolves the lockfile-pinned binary and asserts the pin', () => {
    const { adapter, resolved } = createCodexAcpAdapter({
      clock: CLOCK,
      processEnv: {},
      codexHome: NO_ISOLATION,
    });
    expect(adapter.harnessId).toBe(CODEX_HARNESS_ID);
    expect(resolved.version).toBe(EXPECTED_CODEX_ADAPTER_VERSION);
  });

  it('opencode: resolves the lockfile-pinned native binary + acp subcommand', () => {
    const { adapter, resolved, spawn } = createOpenCodeAcpAdapter({
      clock: CLOCK,
      processEnv: {},
      openCodeHome: NO_OPENCODE_ISOLATION,
    });
    expect(adapter.harnessId).toBe(OPENCODE_HARNESS_ID);
    expect(resolved.version).toBe(EXPECTED_OPENCODE_VERSION);
    expect(spawn.command).toBe(resolved.binPath);
    expect(spawn.args).toEqual(['acp', '--pure']);
  });
});

describe('provider adapter factory — §17.1 credential forwarding + H-1 isolation env', () => {
  it("forwards ONLY the provider's own key vars, only when present; caller env wins", () => {
    const processEnv = {
      ANTHROPIC_API_KEY: 'sk-ant-test',
      OPENAI_API_KEY: 'sk-oai-test',
      CODEX_API_KEY: 'ck-test',
      UNRELATED_SECRET: 'nope',
    };
    const claude = createClaudeAcpAdapter({ clock: CLOCK, processEnv });
    expect(claude.spawn.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-test' });

    const codex = createCodexAcpAdapter({ clock: CLOCK, processEnv, codexHome: NO_ISOLATION });
    expect(codex.spawn.env).toEqual({ CODEX_API_KEY: 'ck-test', OPENAI_API_KEY: 'sk-oai-test' });

    const overridden = createClaudeAcpAdapter({
      clock: CLOCK,
      processEnv,
      env: { ANTHROPIC_API_KEY: 'caller-wins' },
    });
    expect(overridden.spawn.env).toEqual({ ANTHROPIC_API_KEY: 'caller-wins' });

    const empty = createClaudeAcpAdapter({ clock: CLOCK, processEnv: {} });
    expect(empty.spawn.env).toBeUndefined();

    const opencode = createOpenCodeAcpAdapter({
      clock: CLOCK,
      openCodeHome: NO_OPENCODE_ISOLATION,
      processEnv: {
        HOME: '/fixture/home-without-opencode-auth',
        OPENROUTER_API_KEY: 'sk-or-test',
        UNRELATED_SECRET: 'nope',
      },
    });
    // OpenCode owns provider auth dynamically through its auth store. No
    // provider-specific key is guessed or forwarded implicitly.
    expect(opencode.spawn.env).toBeUndefined();

    const explicitOpenCodeEnv = createOpenCodeAcpAdapter({
      clock: CLOCK,
      processEnv: {},
      openCodeHome: NO_OPENCODE_ISOLATION,
      env: { CUSTOM_PROVIDER_TOKEN: 'caller-opt-in' },
    });
    expect(explicitOpenCodeEnv.spawn.env).toEqual({
      CUSTOM_PROVIDER_TOKEN: 'caller-opt-in',
    });
  });

  it('opencode legacy inherit seam detects its auth store without opening it', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'factory-opencode-home-'));
    cleanups.push(async () => rm(home, { recursive: true, force: true }));
    const authPath = openCodeAuthJsonPath(home);
    mkdirSync(path.dirname(authPath), { recursive: true });
    writeFileSync(authPath, 'opaque-credential-fixture');

    const created = createOpenCodeAcpAdapter({
      clock: CLOCK,
      processEnv: { HOME: home },
      openCodeHome: NO_OPENCODE_ISOLATION,
    });

    expect(created.staticCapabilities.auth).toBe('detected_but_unvalidated');
    expect(created.spawn.env).toBeUndefined();
  });

  it('opencode default H-1 isolation copies auth only and pins ACP-routing policy', async () => {
    const { realHome, tempRoot } = fixtureOpenCodeHome();
    const created = createOpenCodeAcpAdapter({
      clock: CLOCK,
      processEnv: { HOME: realHome, OPENROUTER_API_KEY: 'must-not-cross' },
      permissions: { mode: 'headless', role: 'implementor' },
      openCodeHome: { realHome, tempRoot },
    });
    cleanups.push(async () => created.adapter.close());

    expect(created.spawn.args).toEqual(['acp', '--pure']);
    expect(created.openCodeHome?.authMaterial).toBe('auth_json');
    expect(created.staticCapabilities.auth).toBe('detected_but_unvalidated');
    expect(created.spawn.env?.['HOME']).toBe(created.openCodeHome?.dir);
    expect(created.spawn.env?.['XDG_CONFIG_HOME']).toBe(
      path.join(created.openCodeHome!.dir, '.config'),
    );
    expect(created.spawn.env?.['OPENCODE_DISABLE_PROJECT_CONFIG']).toBe('true');
    expect(JSON.parse(created.spawn.env?.[OPENCODE_PERMISSION_ENV_VAR] ?? '{}')).toEqual(
      openCodePermissionPolicyForRole('implementor'),
    );
    expect(created.spawn.env?.['OPENROUTER_API_KEY']).toBeUndefined();
    expect(readFileSync(created.openCodeHome!.authPath, 'utf8')).toBe(
      'opaque-opencode-auth-fixture',
    );
    expect(created.openCodeHome!.authPath).toBe(
      path.join(created.openCodeHome!.dir, OPENCODE_AUTH_JSON_RELATIVE_PATH),
    );

    const isolatedDir = created.openCodeHome!.dir;
    await created.adapter.close();
    expect(existsSync(isolatedDir)).toBe(false);
  });

  it('opencode isolation env cannot be replaced by caller or spawnOverride env', () => {
    const { realHome, tempRoot } = fixtureOpenCodeHome({ authJson: false });
    expect(() =>
      createOpenCodeAcpAdapter({
        clock: CLOCK,
        processEnv: { HOME: realHome },
        openCodeHome: { realHome, tempRoot },
        env: { HOME: '/hostile/caller-home' },
      }),
    ).toThrow(/owned by opencode spawn isolation/);
    expect(() =>
      createOpenCodeAcpAdapter({
        clock: CLOCK,
        processEnv: { HOME: realHome },
        openCodeHome: { realHome, tempRoot },
        spawnOverride: {
          command: process.execPath,
          args: [fakeAcpChildPath(), '/fixture/scenario.json'],
          env: { OPENCODE_PERMISSION: '{"*":"allow"}' },
        },
      }),
    ).toThrow(/owned by opencode spawn isolation/);
  });

  it('codex default (H-1): isolated CODEX_HOME injected — orchestrator config + copied auth, key vars still forwarded', () => {
    const { realCodexHome, tempRoot } = fixtureCodexHome();
    const created = createCodexAcpAdapter({
      clock: CLOCK,
      processEnv: { OPENAI_API_KEY: 'sk-oai-test' },
      permissions: { mode: 'headless', role: 'verifier' },
      codexHome: { realCodexHome, tempRoot },
    });
    cleanups.push(async () => created.codexHome?.dispose());

    // Env: credentials forwarded AND the isolation lever injected.
    expect(created.spawn.env?.['OPENAI_API_KEY']).toBe('sk-oai-test');
    const isolatedHome = created.spawn.env?.[CODEX_HOME_ENV_VAR];
    expect(isolatedHome).toBe(created.codexHome?.dir);
    expect(isolatedHome?.startsWith(tempRoot + path.sep)).toBe(true);

    // The isolated home: 0700 dir, orchestrator config routing approvals to
    // the CLIENT, per-role sandbox baseline, auth.json byte-copied at 0600.
    expect(statSync(created.codexHome!.dir).mode & 0o777).toBe(0o700);
    const toml = readFileSync(created.codexHome!.configPath, 'utf8');
    expect(toml).toContain('approvals_reviewer = "user"');
    expect(toml).toContain('sandbox_mode = "read-only"'); // verifier baseline
    const isolatedAuth = path.join(created.codexHome!.dir, CODEX_AUTH_JSON_BASENAME);
    expect(readFileSync(isolatedAuth, 'utf8')).toBe('{"fixture":"chatgpt-login"}');
    expect(statSync(isolatedAuth).mode & 0o777).toBe(0o600);
    expect(created.codexHome?.authMaterial).toBe('auth_json');

    // H-2: carried auth material is detected_but_unvalidated — NOT supported.
    expect(created.staticCapabilities.auth).toBe('detected_but_unvalidated');
  });

  it('codex isolation CODEX_HOME cannot be replaced by caller or spawnOverride env', () => {
    const { realCodexHome, tempRoot } = fixtureCodexHome();
    expect(() =>
      createCodexAcpAdapter({
        clock: CLOCK,
        processEnv: {},
        codexHome: { realCodexHome, tempRoot },
        env: { [CODEX_HOME_ENV_VAR]: '/caller/pinned/home' },
      }),
    ).toThrow(/owned by codex spawn isolation/);
    expect(() =>
      createCodexAcpAdapter({
        clock: CLOCK,
        processEnv: {},
        codexHome: { realCodexHome, tempRoot },
        spawnOverride: {
          command: process.execPath,
          args: [fakeAcpChildPath(), '/fixture/scenario.json'],
          env: { [CODEX_HOME_ENV_VAR]: '/override/pinned/home' },
        },
      }),
    ).toThrow(/owned by codex spawn isolation/);
  });
});

describe('provider adapter factory — §9 capability layering (static vs wire)', () => {
  it('overrides carry ONLY the documented provider-static fields', () => {
    const { overrides, staticCapabilities } = createClaudeAcpAdapter({
      clock: CLOCK,
      processEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    });
    expect(Object.keys(overrides).sort()).toEqual(
      [
        'auth',
        'conflictingBuiltinTools',
        'executable',
        'modelMechanism',
        'retryAfterTier',
        'sessionIdentity',
        'usageAccounting',
        'usageLimitReporting',
      ].sort(),
    );
    // Wire-observed fields are deliberately NOT overridden:
    expect(overrides).not.toHaveProperty('sessionOps');
    expect(overrides).not.toHaveProperty('protocol');
    expect(overrides).not.toHaveProperty('configOptions');
    expect(overrides).not.toHaveProperty('permissionRequests');
    expect(overrides).not.toHaveProperty('mcpConfig');
    // H-2: a present env key is MATERIAL, never validation → unvalidated.
    expect(overrides.auth).toBe('detected_but_unvalidated');
    expect(staticCapabilities.auth).toBe('detected_but_unvalidated');
  });

  it('claude/codex static knowledge diverges exactly as source-verified (§13 tiers, §8 denylist)', () => {
    const claude = createClaudeAcpAdapter({ clock: CLOCK, processEnv: {} });
    const codex = createCodexAcpAdapter({ clock: CLOCK, processEnv: {}, codexHome: NO_ISOLATION });
    expect(claude.overrides.usageLimitReporting).toBe('structured');
    expect(codex.overrides.usageLimitReporting).toBe('structured');
    expect(claude.overrides.retryAfterTier).toBe('honored');
    expect(codex.overrides.retryAfterTier).toBe('forecast_fallback');
    expect(claude.overrides.conflictingBuiltinTools).toEqual(['Task']);
    expect(codex.overrides.conflictingBuiltinTools).toEqual([]);
    expect(claude.overrides.auth).toBe('unknown'); // empty env: honest unknown
  });

  it('providerStaticOverrides pins resolvedPath to the actually-spawned path', () => {
    const { staticCapabilities } = createClaudeAcpAdapter({ clock: CLOCK, processEnv: {} });
    const picked = providerStaticOverrides(staticCapabilities, '/actually/spawned.js');
    expect(picked.executable?.resolvedPath).toBe('/actually/spawned.js');
    expect(picked.executable?.version).toBe(EXPECTED_CLAUDE_ADAPTER_VERSION);
  });
});

describe('provider adapter factory — §13 classifier wiring on the SPI surface', () => {
  it("claude adapter classifies Claude's errorKind convention, not Codex's", () => {
    const { adapter } = createClaudeAcpAdapter({ clock: CLOCK, processEnv: {} });
    expect(adapter.classifyError(claudeLimitEnvelope)).toMatchObject({
      kind: 'usage_limit',
      source: 'structured',
      detectionTier: 'structured',
      provider: CLAUDE_HARNESS_ID,
    });
    // The OTHER provider's discriminator is NOT a positive match here.
    expect(adapter.classifyError(codexLimitEnvelope).kind).toBe('unknown_provider_error');
    // Agent-message text is NEVER classified (§9/§13).
    expect(adapter.classifyError('I hit a rate limit (429), resumesAt tomorrow').kind).toBe(
      'unknown_provider_error',
    );
  });

  it("codex adapter classifies Codex's codexErrorInfo convention, not Claude's", () => {
    const { adapter } = createCodexAcpAdapter({ clock: CLOCK, processEnv: {}, codexHome: NO_ISOLATION });
    expect(adapter.classifyError(codexLimitEnvelope)).toMatchObject({
      kind: 'usage_limit',
      source: 'structured',
      detectionTier: 'structured',
      provider: CODEX_HARNESS_ID,
    });
    expect(adapter.classifyError(claudeLimitEnvelope).kind).toBe('unknown_provider_error');
  });
});

describe('provider adapter factory — composed initialize() over the fake wire (spawnOverride seam)', () => {
  it(
    'wire-probed fields stay authoritative while provider-static fields survive the merge',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'factory-fake-wire-'));
      const scenarioPath = await writeScenarioFile({}, dir);
      const { adapter, resolved } = createClaudeAcpAdapter({
        clock: CLOCK,
        processEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' },
        spawnOverride: { command: process.execPath, args: [fakeAcpChildPath(), scenarioPath] },
      });
      cleanups.push(async () => {
        await adapter.close();
        await rm(dir, { recursive: true, force: true });
      });

      const record = await adapter.initialize();
      // WIRE authoritative: the fake advertises loadSession only — the
      // claude profile's static resume:true must NOT leak over the probe.
      expect(record.sessionOps.load).toBe(true);
      expect(record.sessionOps.resume).toBe(false);
      expect(record.sessionOps.fork).toBe(false);
      // PROVIDER-STATIC survive: identity, tiers, denylist, auth, mechanism.
      expect(record.executable.packageName).toBe(CLAUDE_PACKAGE_NAME);
      expect(record.executable.version).toBe(EXPECTED_CLAUDE_ADAPTER_VERSION);
      expect(record.usageLimitReporting).toBe('structured');
      expect(record.retryAfterTier).toBe('honored');
      expect(record.usageAccounting).toBe('per_turn');
      expect(record.conflictingBuiltinTools).toEqual(['Task']);
      expect(record.auth).toBe('detected_but_unvalidated'); // H-2: key presence ≠ validation
      expect(record.modelMechanism).toBe('session_set_config_option');
      // §10.1 nonce echo observed on the real wire.
      expect(adapter.probedCapabilities?.spawnIdEchoed).toBe(true);
      // The spawned (override) path is what executable.resolvedPath reports.
      expect(record.executable.resolvedPath).toBe(fakeAcpChildPath());
      expect(record.executable.resolvedPath).not.toBe(resolved.binPath);
    },
    GENEROUS_MS,
  );
});

describe('provider adapter factory — P-1 session-mode pinning wired from the profile policies', () => {
  it('the normative per-role policies are exactly as the live gate directs', () => {
    // claude: session/set_mode 'default' — NEVER 'auto' — for every role.
    for (const role of ['coordinator', 'implementor', 'verifier'] as const) {
      expect(CLAUDE_SESSION_MODE_POLICY.byRole[role]).toEqual({
        mechanism: 'session_set_mode',
        value: 'default',
      });
    }
    expect(CLAUDE_SESSION_MODE_POLICY.defaultPin?.value).toBe('default');
    // codex: read-only for coordinator/verifier; workspace-write ('agent',
    // never 'agent-full-access') ONLY for the implementor.
    expect(CODEX_SESSION_MODE_POLICY.byRole.coordinator?.value).toBe('read-only');
    expect(CODEX_SESSION_MODE_POLICY.byRole.verifier?.value).toBe('read-only');
    expect(CODEX_SESSION_MODE_POLICY.byRole.implementor).toEqual({
      mechanism: 'session_set_config_option',
      optionId: 'mode',
      value: 'agent',
    });
    expect(CODEX_SESSION_MODE_POLICY.defaultPin?.value).toBe('read-only');
    // OpenCode: plan for read-only roles; build only in the implementor worktree.
    expect(OPENCODE_SESSION_MODE_POLICY.byRole.coordinator?.value).toBe('plan');
    expect(OPENCODE_SESSION_MODE_POLICY.byRole.verifier?.value).toBe('plan');
    expect(OPENCODE_SESSION_MODE_POLICY.byRole.implementor?.value).toBe('build');
    expect(OPENCODE_SESSION_MODE_POLICY.defaultPin?.value).toBe('plan');
  });

  it(
    'claude factory adapter pins mode default at createSession (session/set_mode) for the configured role',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'factory-mode-claude-'));
      const scenarioPath = await writeScenarioFile({}, dir);
      const { adapter } = createClaudeAcpAdapter({
        clock: CLOCK,
        processEnv: {},
        permissions: { mode: 'headless', role: 'implementor' },
        spawnOverride: { command: process.execPath, args: [fakeAcpChildPath(), scenarioPath] },
      });
      cleanups.push(async () => {
        await adapter.close();
        await rm(dir, { recursive: true, force: true });
      });
      await adapter.initialize();
      await adapter.createSession({ cwd: tmpdir() });
      expect(adapter.modePins).toEqual([
        expect.objectContaining({
          role: 'implementor',
          mechanism: 'session_set_mode',
          value: 'default',
        }),
      ]);
    },
    GENEROUS_MS,
  );

  it(
    'codex factory adapter pins read-only for the verifier via set_config_option, echo-confirmed',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'factory-mode-codex-'));
      const scenarioPath = await writeScenarioFile({}, dir);
      const { adapter } = createCodexAcpAdapter({
        clock: CLOCK,
        processEnv: {},
        permissions: { mode: 'headless', role: 'verifier' },
        codexHome: NO_ISOLATION,
        spawnOverride: { command: process.execPath, args: [fakeAcpChildPath(), scenarioPath] },
      });
      cleanups.push(async () => {
        await adapter.close();
        await rm(dir, { recursive: true, force: true });
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      expect(adapter.modePins).toEqual([
        expect.objectContaining({
          role: 'verifier',
          mechanism: 'session_set_config_option',
          optionId: 'mode',
          value: 'read-only',
          echoed: true,
        }),
      ]);
      const mode = (await adapter.listConfigOptions(session.acpSessionId)).find(
        (option) => option.id === 'mode',
      );
      expect(mode?.current).toBe('read-only');
    },
    GENEROUS_MS,
  );
});

// ---------------------------------------------------------------------------
// P2 live-gate regression H-1/H-2 (docs/reviews/p2-live-gate.md, Run 2):
// spawn-time CODEX_HOME isolation must defeat an inherited auto-approver,
// and must CARRY the auth material the core needs.
// ---------------------------------------------------------------------------
describe('P2 live-gate regression H-1 — isolated CODEX_HOME defeats an inherited auto-approver', () => {
  /** The live H-1 scenario: hostile host-global approvals_reviewer + a core
   * that requires auth material in whatever home it resolves. */
  const HOSTILE_HOST_SCENARIO: FakeAcpScenario = {
    codexHost: { inheritedApprovalsReviewer: 'auto_review', requireAuthJson: true },
    turns: [
      { escalation: { toolTitle: 'Write /Users/host/p2-gate-deny-probe-codex.txt' } },
    ],
  };

  async function scenarioOnDisk(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'factory-h1-'));
    cleanups.push(async () => rm(dir, { recursive: true, force: true }));
    return writeScenarioFile(HOSTILE_HOST_SCENARIO, dir);
  }

  it(
    'WITHOUT isolation (inherit_host): the fake reproduces the live bypass — auto-approved write, zero permission requests',
    async () => {
      const scenarioPath = await scenarioOnDisk();
      const { adapter } = createCodexAcpAdapter({
        clock: CLOCK,
        processEnv: {},
        permissions: { mode: 'headless', role: 'verifier' },
        codexHome: { mode: 'inherit_host' }, // the pre-H-1 spawn contract
        spawnOverride: { command: process.execPath, args: [fakeAcpChildPath(), scenarioPath] },
      });
      cleanups.push(async () => adapter.close());
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });

      const updates: SessionUpdate[] = [];
      const result = await adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'write outside the sandbox',
        onUpdate: (update) => updates.push(update),
      });

      // The write went through with the ACP client NEVER consulted — exactly
      // the live step-4 failure (Guardian Review + write-through under a
      // read-only pin).
      expect(result.stopReason).toBe('end_turn');
      const texts = updates.flatMap((u) => (u.kind === 'agent_message_chunk' ? [u.text] : []));
      expect(texts).toContain('WROTE');
      expect(updates.some((u) => u.kind === 'permission_request')).toBe(false);
      expect(
        updates.some((u) => u.kind === 'tool_call' && u.title === 'Guardian Review'),
      ).toBe(true);
      expect(adapter.permissionDecisions).toEqual([]);
      // The read-only pin WAS applied and echoed — the bypass rode around it.
      expect(adapter.modePins[0]).toMatchObject({ value: 'read-only', echoed: true });
    },
    GENEROUS_MS,
  );

  it(
    'WITH isolation (default): the orchestrator config WINS — same hostile host, write DENIED via the client channel; auth carried; home disposed on close',
    async () => {
      const scenarioPath = await scenarioOnDisk();
      const { realCodexHome, tempRoot } = fixtureCodexHome(); // auth.json present
      const created = createCodexAcpAdapter({
        clock: CLOCK,
        processEnv: {},
        permissions: { mode: 'headless', role: 'verifier' },
        codexHome: { realCodexHome, tempRoot }, // mode defaults to 'isolated'
        spawnOverride: { command: process.execPath, args: [fakeAcpChildPath(), scenarioPath] },
      });
      const { adapter } = created;
      cleanups.push(async () => adapter.close());
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });

      const updates: SessionUpdate[] = [];
      const result = await adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'write outside the sandbox',
        onUpdate: (update) => updates.push(update),
      });

      // The isolated home replaced the hostile host config: the escalation
      // routed to the CLIENT, §10.2's verifier write-veto denied it, no
      // write happened. (requireAuthJson also proves the isolated home
      // CARRIED auth.json — a bare-config isolation would have 401'd here.)
      expect(result.stopReason).toBe('end_turn');
      const texts = updates.flatMap((u) => (u.kind === 'agent_message_chunk' ? [u.text] : []));
      expect(texts).toContain('DENIED');
      expect(texts).not.toContain('WROTE');
      expect(updates.some((u) => u.kind === 'permission_request')).toBe(true);
      expect(updates.some((u) => u.kind === 'tool_call' && u.title === 'Guardian Review')).toBe(false);
      expect(adapter.permissionDecisions).toEqual([
        expect.objectContaining({ action: 'deny', reason: 'denied_role_write' }),
      ]);
      expect(adapter.modePins[0]).toMatchObject({ value: 'read-only', echoed: true });

      // H-2: the successful (non-cancelled) turn recorded validated evidence.
      expect(adapter.authEvidence.validatedTurnAt).toBeDefined();

      // Disposal is wired to close(): the copied auth material is removed.
      const isolatedDir = created.codexHome!.dir;
      expect(existsSync(path.join(isolatedDir, CODEX_AUTH_JSON_BASENAME))).toBe(true);
      await adapter.close();
      expect(existsSync(isolatedDir)).toBe(false);
    },
    GENEROUS_MS,
  );

  it(
    'H-2 negative control: isolation WITHOUT auth material → the turn fails auth (-32000), recorded as auth-failure evidence',
    async () => {
      const scenarioPath = await scenarioOnDisk();
      const { realCodexHome, tempRoot } = fixtureCodexHome({ authJson: false });
      const created = createCodexAcpAdapter({
        clock: CLOCK,
        processEnv: { OPENAI_API_KEY: 'sk-proj-invalid' },
        permissions: { mode: 'headless', role: 'verifier' },
        codexHome: { realCodexHome, tempRoot },
        spawnOverride: { command: process.execPath, args: [fakeAcpChildPath(), scenarioPath] },
      });
      const { adapter } = created;
      cleanups.push(async () => adapter.close());
      expect(created.codexHome?.authMaterial).toBe('none');
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });

      await expect(
        adapter.prompt({ sessionId: session.acpSessionId, prompt: 'any turn' }),
      ).rejects.toMatchObject({ kind: 'provider_error' });

      // The codex classifier calls the envelope `auth`; the adapter recorded
      // it — so a present-but-dead key reads detected_but_unsupported, never
      // supported (the exact live H-2 falsification, offline).
      expect(adapter.authEvidence.authFailureAt).toBeDefined();
      expect(adapter.authEvidence.validatedTurnAt).toBeUndefined();
    },
    GENEROUS_MS,
  );
});
