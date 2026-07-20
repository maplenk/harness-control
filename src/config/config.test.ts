import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import { DEFAULT_BOUNDS, DEFAULT_PROBE_LADDER_MINUTES } from '../domain/state.js';
import { RSS_GRACEFUL_STOP_DEADLINE_MS } from '../domain/transitions.js';
import { isErr, isOk, unwrap } from '../lib/result.js';
import {
  loadEngineConfigFromFile,
  parseEngineConfig,
  toEngineBounds,
  type ConfigIssue,
} from './loader.js';
import {
  BYTES_PER_GB,
  DEFAULT_ENGINE_CONFIG,
  DEFAULT_FAILOVER_POLICY,
  FAILOVER_POLICIES,
  RESTART_WINDOW_OFF,
} from './schema.js';

function issuePaths(issues: readonly ConfigIssue[]): string[] {
  return issues.map((i) => i.path);
}

describe('engineConfigSchema defaults (PLAN §12.1, §13, §14, §17.2)', () => {
  it('matches every normative default called out in the plan', () => {
    expect(DEFAULT_ENGINE_CONFIG).toEqual({
      memory: {
        budgetMb: 1024,
        softThresholdRatio: 0.75,
        hardCeilingRatio: 1.5,
        gracefulStopDeadlineMs: RSS_GRACEFUL_STOP_DEADLINE_MS,
      },
      restarts: {
        windowMax: 5,
        windowMinutes: 10,
        lifetimeCap: 10,
        unsafeDev: false,
        autoRespawn: 'bounded',
      },
      maxLiveChildren: 3,
      failoverPolicy: 'wait',
      // P4b wave 2: empty ladder by default (NO implicit target); per-incident
      // failover walk bounded at 2.
      failoverLadder: [],
      maxFailoversPerIncident: 2,
      // W2-4 (Rev 2 correction): the cap is PER INCIDENT (`maxProbesPerIncident`,
      // permanent exhaustion) — the Wave-1 sliding-window fields
      // (`maxProbesPerWindow`/`windowHours`) are gone, deliberately.
      limitProbe: {
        ladderMinutes: [...DEFAULT_PROBE_LADDER_MINUTES],
        maxProbesPerIncident: 6,
      },
      quotas: {
        perRunBytes: 2 * BYTES_PER_GB,
        globalBytes: 20 * BYTES_PER_GB,
      },
      remediation: { maxRounds: 3 },
      checkpoint: { cadenceTurns: 3 },
      budget: { conservativeReservationUsd: 0.5 },
      // W3-1: the verification runner's per-run env additions default EMPTY —
      // the minimal allowlist is the whole default surface.
      verification: { envAllowlist: [] },
    });
  });

  it('stays in sync with the transition engine defaults (single source of truth)', () => {
    expect(DEFAULT_ENGINE_CONFIG.restarts.windowMax).toBe(DEFAULT_BOUNDS.restartWindowMax);
    expect(DEFAULT_ENGINE_CONFIG.restarts.lifetimeCap).toBe(DEFAULT_BOUNDS.lifetimeRestartMax);
    expect(DEFAULT_ENGINE_CONFIG.limitProbe.maxProbesPerIncident).toBe(DEFAULT_BOUNDS.probeMax);
    expect(DEFAULT_ENGINE_CONFIG.remediation.maxRounds).toBe(DEFAULT_BOUNDS.remediationMax);
  });

  it('freezes the parsed config deeply (readonly at runtime, not just in types)', () => {
    expect(() => {
      // @ts-expect-error -- intentionally violating readonly to assert runtime enforcement
      DEFAULT_ENGINE_CONFIG.maxLiveChildren = 99;
    }).toThrow();
    expect(() => {
      // @ts-expect-error -- intentionally violating readonly to assert runtime enforcement
      DEFAULT_ENGINE_CONFIG.memory.budgetMb = 1;
    }).toThrow();
    expect(() => {
      // @ts-expect-error -- intentionally violating readonly to assert runtime enforcement
      DEFAULT_ENGINE_CONFIG.limitProbe.ladderMinutes.push(999);
    }).toThrow();
  });

  it('deep-freezes results from parseEngineConfig too, including partially-overridden nested objects', () => {
    const config = unwrap(parseEngineConfig({ memory: { budgetMb: 2048 } }));
    expect(() => {
      // @ts-expect-error -- intentionally violating readonly to assert runtime enforcement
      config.memory.budgetMb = 1;
    }).toThrow();
    expect(() => {
      // @ts-expect-error -- intentionally violating readonly to assert runtime enforcement
      config.restarts.lifetimeCap = 1; // untouched, defaulted sub-object
    }).toThrow();
  });

  it('exposes exactly the four failover policies, defaulting to wait', () => {
    expect(FAILOVER_POLICIES).toEqual(['wait', 'switch_model', 'switch_harness', 'ask']);
    expect(DEFAULT_FAILOVER_POLICY).toBe('wait');
  });
});

describe('parseEngineConfig (deep partial overrides + validation)', () => {
  it('accepts {} and returns the full defaults', () => {
    const result = parseEngineConfig({});
    expect(isOk(result)).toBe(true);
    expect(unwrap(result)).toEqual(DEFAULT_ENGINE_CONFIG);
  });

  it('defaults every field omitted from the input, including nested-partial objects', () => {
    const result = parseEngineConfig({ memory: { budgetMb: 2048 }, maxLiveChildren: 5 });
    const config = unwrap(result);
    expect(config.memory.budgetMb).toBe(2048);
    expect(config.memory.softThresholdRatio).toBe(0.75); // untouched sibling field still defaults
    expect(config.maxLiveChildren).toBe(5);
    expect(config.restarts).toEqual(DEFAULT_ENGINE_CONFIG.restarts); // untouched section still defaults
  });

  it('rejects a negative memory budget', () => {
    const result = parseEngineConfig({ memory: { budgetMb: -1 } });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(issuePaths(result.error)).toContain('memory.budgetMb');
  });

  it('rejects hardCeilingRatio at or below softThresholdRatio', () => {
    const result = parseEngineConfig({ memory: { softThresholdRatio: 0.9, hardCeilingRatio: 0.5 } });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(issuePaths(result.error)).toContain('memory.hardCeilingRatio');
  });

  it('rejects a restart window value outside {3,5,8,off}', () => {
    const result = parseEngineConfig({ restarts: { windowMax: 4 } });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(issuePaths(result.error)).toContain('restarts.windowMax');
  });

  it("rejects windowMax: 'off' without unsafeDev", () => {
    const result = parseEngineConfig({ restarts: { windowMax: RESTART_WINDOW_OFF } });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(issuePaths(result.error)).toContain('restarts.windowMax');
      expect(result.error[0]?.message).toMatch(/unsafeDev/);
    }
  });

  it("accepts windowMax: 'off' when unsafeDev is true, and still requires a positive lifetimeCap", () => {
    const result = parseEngineConfig({ restarts: { windowMax: RESTART_WINDOW_OFF, unsafeDev: true } });
    expect(isOk(result)).toBe(true);
    const config = unwrap(result);
    expect(config.restarts.windowMax).toBe('off');
    expect(config.restarts.lifetimeCap).toBe(10); // non-disableable default, unaffected by unsafeDev
  });

  it('rejects a non-ascending probe ladder', () => {
    const result = parseEngineConfig({ limitProbe: { ladderMinutes: [60, 30] } });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(issuePaths(result.error)).toContain('limitProbe.ladderMinutes');
  });

  it('rejects the retired sliding-window probe fields (W2-4: per-incident cap only)', () => {
    // Rev 2 deliberate correction: exhaustion is permanent per incident —
    // there is no probe time window to configure, and the strict schema
    // refuses the old field names loudly instead of silently ignoring them.
    expect(isErr(parseEngineConfig({ limitProbe: { maxProbesPerWindow: 6 } }))).toBe(true);
    expect(isErr(parseEngineConfig({ limitProbe: { windowHours: 24 } }))).toBe(true);
  });

  it('rejects a per-run quota that exceeds the global quota', () => {
    const result = parseEngineConfig({ quotas: { perRunBytes: 30 * BYTES_PER_GB, globalBytes: 20 * BYTES_PER_GB } });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(issuePaths(result.error)).toContain('quotas.perRunBytes');
  });

  it('rejects an unknown failover policy', () => {
    const result = parseEngineConfig({ failoverPolicy: 'auto_pilot' });
    expect(isErr(result)).toBe(true);
  });

  it('P4b wave 2: `wait` (and the default) still parse', () => {
    expect(isOk(parseEngineConfig({ failoverPolicy: 'wait' }))).toBe(true);
    expect(isOk(parseEngineConfig({}))).toBe(true);
  });

  it('P4b wave 2: still refuses `ask` (unimplemented) with a clear P4b message', () => {
    const result = parseEngineConfig({ failoverPolicy: 'ask' });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(issuePaths(result.error)).toContain('failoverPolicy');
      expect(result.error.some((issue) => /P4b/.test(issue.message))).toBe(true);
    }
    // Even paired with a ladder, `ask` is refused — it is unimplemented.
    expect(
      isErr(
        parseEngineConfig({
          failoverPolicy: 'ask',
          failoverLadder: [{ harness: 'codex', model: 'gpt-5.6-terra' }],
        }),
      ),
    ).toBe(true);
  });

  it('P4b wave 2: accepts `switch_model` with a non-empty single-harness ladder', () => {
    const result = parseEngineConfig({
      failoverPolicy: 'switch_model',
      failoverLadder: [
        { harness: 'claude', model: 'opus' },
        { harness: 'claude', model: 'sonnet', effort: 'high' },
      ],
    });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(unwrap(result).failoverLadder).toEqual([
        { harness: 'claude', model: 'opus' },
        { harness: 'claude', model: 'sonnet', effort: 'high' },
      ]);
    }
  });

  it('P4b wave 2: accepts `switch_harness` with a cross-harness ladder', () => {
    const result = parseEngineConfig({
      failoverPolicy: 'switch_harness',
      failoverLadder: [
        { harness: 'claude', model: 'opus' },
        { harness: 'codex', model: 'gpt-5.6-terra', effort: 'high' },
      ],
      maxFailoversPerIncident: 3,
    });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(unwrap(result).maxFailoversPerIncident).toBe(3);
  });

  // §review-7 F4(a): harness/effort in a ladder entry must name a value the
  // RUNTIME can honor (the `HARNESSES` / `REASONING_EFFORTS` vocab reused from
  // model-resolution.ts) — an arbitrary string that would only fail deep in
  // dispatch is now a loud PARSE error.
  it('P4b wave 2 (F4a): REJECTS an unadvertised harness at parse (`claude-code`)', () => {
    const result = parseEngineConfig({
      failoverPolicy: 'switch_harness',
      failoverLadder: [{ harness: 'claude-code', model: 'opus' }],
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(issuePaths(result.error).some((p) => /failoverLadder/.test(p))).toBe(true);
      expect(result.error.some((i) => /harness must be one of/.test(i.message))).toBe(true);
    }
  });

  it('P4b wave 2 (F4a): REJECTS an unadvertised effort at parse (`ultra`)', () => {
    const result = parseEngineConfig({
      failoverPolicy: 'switch_harness',
      failoverLadder: [{ harness: 'codex', model: 'gpt-5.6-terra', effort: 'ultra' }],
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(issuePaths(result.error).some((p) => /failoverLadder/.test(p))).toBe(true);
      expect(result.error.some((i) => /effort must be one of/.test(i.message))).toBe(true);
    }
  });

  it('accepts `xhigh` now that it is in the effort vocabulary', () => {
    const result = parseEngineConfig({
      failoverPolicy: 'switch_harness',
      failoverLadder: [{ harness: 'codex', model: 'gpt-5.6-terra', effort: 'xhigh' }],
    });
    expect(isOk(result)).toBe(true);
  });

  it('P4b wave 2 (F4a): a valid harness+effort entry still parses', () => {
    const result = parseEngineConfig({
      failoverPolicy: 'switch_harness',
      failoverLadder: [{ harness: 'codex', model: 'gpt-5.6-terra', effort: 'high' }],
    });
    expect(isOk(result)).toBe(true);
  });

  it('P4b wave 2 (F4a): accepts an OpenCode dynamic provider/model target', () => {
    const result = parseEngineConfig({
      failoverPolicy: 'switch_harness',
      failoverLadder: [
        { harness: 'codex', model: 'gpt-5.6-terra' },
        { harness: 'opencode', model: 'xai/grok-4.5', effort: 'high' },
      ],
    });
    expect(isOk(result)).toBe(true);
  });

  it('P4b wave 2: REJECTS `switch_model` without a ladder (no implicit target)', () => {
    const result = parseEngineConfig({ failoverPolicy: 'switch_model' });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(issuePaths(result.error)).toContain('failoverPolicy');
      expect(result.error.some((i) => /non-empty failoverLadder/.test(i.message))).toBe(true);
    }
    // An explicitly-empty ladder is refused the same way.
    expect(isErr(parseEngineConfig({ failoverPolicy: 'switch_model', failoverLadder: [] }))).toBe(
      true,
    );
  });

  it('P4b wave 2: REJECTS `switch_harness` without a ladder (no implicit target)', () => {
    const result = parseEngineConfig({ failoverPolicy: 'switch_harness' });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(issuePaths(result.error)).toContain('failoverPolicy');
      expect(result.error.some((i) => /non-empty failoverLadder/.test(i.message))).toBe(true);
    }
  });

  it('P4b wave 2: REJECTS a `switch_model` ladder that changes harness (model-only)', () => {
    const result = parseEngineConfig({
      failoverPolicy: 'switch_model',
      failoverLadder: [
        { harness: 'claude', model: 'opus' },
        { harness: 'codex', model: 'gpt-5.6-terra' },
      ],
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(issuePaths(result.error)).toContain('failoverLadder');
      expect(result.error.some((i) => /same harness/.test(i.message))).toBe(true);
    }
  });

  it('P4b wave 2: validates ladder entries (rejects empty/missing fields and unknown keys)', () => {
    // Missing model.
    expect(
      isErr(parseEngineConfig({ failoverPolicy: 'switch_harness', failoverLadder: [{ harness: 'codex' }] })),
    ).toBe(true);
    // Empty harness string.
    expect(
      isErr(
        parseEngineConfig({
          failoverPolicy: 'switch_harness',
          failoverLadder: [{ harness: '', model: 'opus' }],
        }),
      ),
    ).toBe(true);
    // Unknown key (strict entry schema).
    expect(
      isErr(
        parseEngineConfig({
          failoverPolicy: 'switch_harness',
          failoverLadder: [{ harness: 'codex', model: 'opus', temperature: 0.7 }],
        }),
      ),
    ).toBe(true);
  });

  it('P4b wave 2: rejects a non-positive / non-integer maxFailoversPerIncident', () => {
    expect(isErr(parseEngineConfig({ maxFailoversPerIncident: 0 }))).toBe(true);
    expect(isErr(parseEngineConfig({ maxFailoversPerIncident: -1 }))).toBe(true);
    expect(isErr(parseEngineConfig({ maxFailoversPerIncident: 1.5 }))).toBe(true);
  });

  it('W3-1: accepts explicit, non-credential verification env-allowlist additions', () => {
    const result = parseEngineConfig({ verification: { envAllowlist: ['NVM_DIR', 'JAVA_HOME'] } });
    expect(isOk(result)).toBe(true);
    expect(unwrap(result).verification.envAllowlist).toEqual(['NVM_DIR', 'JAVA_HOME']);
  });

  it('W3-1: rejects credential-shaped verification env-allowlist additions (§17.1: NO credential-shaped vars)', () => {
    // SYNTHETIC names only — the shapes the redaction key-name rule flags.
    for (const name of ['MY_API_KEY', 'NPM_TOKEN', 'DB_PASSWORD', 'CLIENT_SECRET']) {
      const result = parseEngineConfig({ verification: { envAllowlist: [name] } });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(issuePaths(result.error)).toContain('verification.envAllowlist');
        expect(result.error[0]?.message).toMatch(/credential-shaped/);
      }
    }
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    const result = parseEngineConfig({ notARealField: true });
    expect(isErr(result)).toBe(true);
  });

  it('collects multiple issues in one pass rather than failing on the first', () => {
    const result = parseEngineConfig({
      memory: { budgetMb: -1 },
      maxLiveChildren: -3,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(result.error.length).toBeGreaterThanOrEqual(2);
  });
});

describe('toEngineBounds bridge (EngineConfig → EngineBounds, §14)', () => {
  it('maps the default config onto DEFAULT_BOUNDS exactly', () => {
    expect(toEngineBounds(DEFAULT_ENGINE_CONFIG)).toEqual(DEFAULT_BOUNDS);
  });

  it("maps windowMax: 'off' to an unbounded window count while keeping the lifetime cap finite", () => {
    const config = unwrap(
      parseEngineConfig({ restarts: { windowMax: RESTART_WINDOW_OFF, unsafeDev: true, lifetimeCap: 4 } }),
    );
    const bounds = toEngineBounds(config);
    expect(bounds.restartWindowMax).toBe(Number.POSITIVE_INFINITY);
    expect(bounds.lifetimeRestartMax).toBe(4); // non-disableable cap still enforced
  });
});

describe('loadEngineConfigFromFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'harness-config-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('loads and validates a JSON config file', () => {
    const path = join(dir, 'config.json');
    writeFileSync(path, JSON.stringify({ maxLiveChildren: 7 }), 'utf8');
    const result = loadEngineConfigFromFile(path);
    expect(isOk(result)).toBe(true);
    expect(unwrap(result).maxLiveChildren).toBe(7);
  });

  it('reports a missing file as an Err rather than throwing', () => {
    const result = loadEngineConfigFromFile(join(dir, 'does-not-exist.json'));
    expect(isErr(result)).toBe(true);
  });

  it('reports invalid JSON as an Err rather than throwing', () => {
    const path = join(dir, 'broken.json');
    writeFileSync(path, '{ not valid json', 'utf8');
    const result = loadEngineConfigFromFile(path);
    expect(isErr(result)).toBe(true);
  });

  it('reports schema violations from a file the same way as in-memory input', () => {
    const path = join(dir, 'invalid.json');
    writeFileSync(path, JSON.stringify({ maxLiveChildren: -1 }), 'utf8');
    const result = loadEngineConfigFromFile(path);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) expect(issuePaths(result.error)).toContain('maxLiveChildren');
  });
});
