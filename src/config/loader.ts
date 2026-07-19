/**
 * Config loader (PLAN.md §12.1, §13, §14, §17.2) + the bridge from
 * `EngineConfig` (operator-facing, validated) to `EngineBounds` (the
 * transition engine's internal bound set, `src/domain/state.ts`).
 *
 * Parsing is total and Result-based (`src/lib/result.ts`): malformed input
 * never throws, it produces a list of `ConfigIssue` with a dot-path and
 * message per zod issue, so a CLI (`doctor`, `start`) can print all problems
 * at once instead of failing on the first one.
 */
import { readFileSync } from 'node:fs';
import type { z } from 'zod';
import type { EngineBounds } from '../domain/state.js';
import { err, ok, type Result } from '../lib/result.js';
import {
  DEFAULT_ENGINE_CONFIG,
  RESTART_WINDOW_OFF,
  deepFreeze,
  engineConfigSchema,
  type EngineConfig,
} from './schema.js';

export interface ConfigIssue {
  /** Dot-path into the config object, e.g. "memory.hardCeilingRatio"; '' = whole document. */
  readonly path: string;
  readonly message: string;
}

function toConfigIssues(error: z.ZodError): readonly ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Validate a (possibly deeply partial) plain object against the engine
 * config schema, filling in every default. Never throws.
 */
export function parseEngineConfig(input: unknown = {}): Result<EngineConfig, readonly ConfigIssue[]> {
  const result = engineConfigSchema.safeParse(input);
  if (result.success) return ok(deepFreeze(result.data));
  return err(toConfigIssues(result.error));
}

/**
 * Read + JSON-parse + validate a config file. Missing file, invalid JSON, and
 * schema violations are all reported as `ConfigIssue`s rather than thrown.
 */
export function loadEngineConfigFromFile(filePath: string): Result<EngineConfig, readonly ConfigIssue[]> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (error) {
    return err([{ path: '', message: `Cannot read config file '${filePath}': ${errorMessage(error)}` }]);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return err([{ path: '', message: `Invalid JSON in config file '${filePath}': ${errorMessage(error)}` }]);
  }

  return parseEngineConfig(parsedJson);
}

/**
 * Bridge `EngineConfig` → `EngineBounds` for `initialEngineState` /
 * `applyTransition` (§14: `windowMax: 'off'` — reachable only behind
 * `unsafeDev` — maps to an unbounded window count while the non-disableable
 * `lifetimeCap` is threaded through unchanged, so the breaker can still open
 * on the lifetime cap alone).
 */
export function toEngineBounds(config: EngineConfig): EngineBounds {
  return {
    restartWindowMax:
      config.restarts.windowMax === RESTART_WINDOW_OFF
        ? Number.POSITIVE_INFINITY
        : config.restarts.windowMax,
    lifetimeRestartMax: config.restarts.lifetimeCap,
    probeMax: config.limitProbe.maxProbesPerIncident,
    remediationMax: config.remediation.maxRounds,
  };
}

export { DEFAULT_ENGINE_CONFIG };
