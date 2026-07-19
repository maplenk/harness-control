/**
 * Engine configuration schema (PLAN.md §12.1, §13, §14, §17.2).
 *
 * A single typed, validated, fully-defaulted `EngineConfig` covers every
 * numeric/behavioral knob the plan calls out as configurable:
 *  - §14 process supervision: memory watchdog budget/thresholds, bounded
 *    restarts/breaker (window + non-disableable lifetime cap + `--unsafe-dev`),
 *    max-live-children concurrency guard.
 *  - §13 usage-limit pause/resume: per-assignment default failover policy,
 *    unknown-ETA probe ladder + bound.
 *  - §12.1 persistence: per-run/global artifact quotas.
 *  - §6.3 T23: remediation round bound.
 *  - §12.2: checkpoint cadence (every N completed turns).
 *  - §17.2: honest cost accounting / soft budget.
 *
 * Numeric defaults that already exist as normative constants elsewhere in the
 * domain layer (`DEFAULT_BOUNDS`, `DEFAULT_PROBE_LADDER_MINUTES`,
 * `RSS_GRACEFUL_STOP_DEADLINE_MS`) are reused here rather than re-declared, so
 * there is exactly one source of truth. (W2-1: the probe ladder moved from
 * transitions.ts to state.ts — the T10 reducer only folds probe counts; the
 * pure scheduler computes deadlines from THIS pinned per-run config.) See
 * `toEngineBounds` in `./loader.ts` for the reverse direction (config →
 * `EngineBounds` for the transition engine).
 */
import { z } from 'zod';
import type { FailoverPolicy } from '../domain/entities.js';
import { DEFAULT_BOUNDS, DEFAULT_PROBE_LADDER_MINUTES } from '../domain/state.js';
import { RSS_GRACEFUL_STOP_DEADLINE_MS } from '../domain/transitions.js';
import { isSecretKeyName } from '../redaction/patterns.js';

// ---------------------------------------------------------------------------
// Shared unit constants (binary, matching the existing "1024MB" convention
// already normative for the RSS budget default — §14).
// ---------------------------------------------------------------------------
export const BYTES_PER_MB = 1024 * 1024;
export const BYTES_PER_GB = 1024 * BYTES_PER_MB;

/**
 * Recursively `Object.freeze`s an object graph of plain objects/arrays.
 *
 * zod's `.readonly()` freezes a value it PARSES directly, but when a nested
 * schema's key is omitted from the input and zod substitutes a precomputed
 * `.default(...)` value, it clones that default rather than passing the
 * (already-frozen) reference through — so the clone comes back unfrozen even
 * though the schema chain includes `.readonly()` (verified empirically,
 * zod 4.4.3). This closes that gap so "every EngineConfig is readonly at
 * runtime" is actually true regardless of which fields were defaulted vs
 * explicitly supplied — see `config.test.ts`.
 */
export function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (!Object.isFrozen(value)) Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== null && typeof child === 'object' && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// §13 failover policy vocabulary — mirrors domain/entities.ts FailoverPolicy.
// `satisfies` makes it a compile error for the two to drift apart silently.
// ---------------------------------------------------------------------------
export const FAILOVER_POLICIES = [
  'wait',
  'switch_model',
  'switch_harness',
  'ask',
] as const satisfies readonly FailoverPolicy[];

export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = 'wait';

// ---------------------------------------------------------------------------
// §14: window-bound restart count is configurable among exactly 3|5|8, or
// disabled ('off') — and 'off' is only reachable behind `unsafeDev` (the
// non-disableable lifetime cap still applies even then).
// ---------------------------------------------------------------------------
export const RESTART_WINDOW_OFF = 'off' as const;
export const RESTART_WINDOW_CHOICES = [3, 5, 8, RESTART_WINDOW_OFF] as const;
export type RestartWindowMax = (typeof RESTART_WINDOW_CHOICES)[number];

// Single source of truth for the two "5"s (this schema's literal default and
// DEFAULT_BOUNDS.restartWindowMax) is DEFAULT_BOUNDS; the literal-union type
// here is strictly narrower than EngineBounds.restartWindowMax's `number`, so
// the value can't just be threaded through `.default(DEFAULT_BOUNDS...)` —
// this check fails loudly at module load instead of drifting silently.
const DEFAULT_RESTART_WINDOW_MAX = 5;
if ((DEFAULT_BOUNDS.restartWindowMax as number) !== DEFAULT_RESTART_WINDOW_MAX) {
  throw new Error(
    `src/config/schema.ts: restarts.windowMax default (${DEFAULT_RESTART_WINDOW_MAX}) drifted ` +
      `from DEFAULT_BOUNDS.restartWindowMax (${DEFAULT_BOUNDS.restartWindowMax})`,
  );
}

// ---------------------------------------------------------------------------
// §14 memory watchdog: budget default 1024MB; soft 75% → warn; hard emergency
// ceiling 150% of budget → SIGKILL; graceful path deadline reuses the
// transition engine's own constant.
// ---------------------------------------------------------------------------
const memorySchema = z
  .object({
    /** RSS budget in MB for the full process tree of a segment. */
    budgetMb: z.number().int().positive().default(1024),
    /** Fraction of budget that triggers `warn.rss_soft` + notify (T21). */
    softThresholdRatio: z.number().positive().max(1).default(0.75),
    /** Fraction of budget that triggers the emergency SIGKILL path (T22). */
    hardCeilingRatio: z.number().positive().default(1.5),
    /** Deadline for the graceful checkpoint+stop path before escalating. */
    gracefulStopDeadlineMs: z.number().int().positive().default(RSS_GRACEFUL_STOP_DEADLINE_MS),
  })
  .strict()
  .refine((v) => v.hardCeilingRatio > v.softThresholdRatio, {
    message: 'hardCeilingRatio must exceed softThresholdRatio',
    path: ['hardCeilingRatio'],
  })
  .readonly();
const MEMORY_DEFAULT = memorySchema.parse({});

// ---------------------------------------------------------------------------
// §14 restarts/breaker: window bound (default 5/10min, configurable 3|5|8, or
// 'off' — only behind --unsafe-dev) AND non-disableable per-assignment
// lifetime cap (default 10).
// ---------------------------------------------------------------------------
const restartsSchema = z
  .object({
    windowMax: z.literal(RESTART_WINDOW_CHOICES).default(DEFAULT_RESTART_WINDOW_MAX),
    windowMinutes: z.number().int().positive().default(10),
    /** Non-disableable (§14) — no 'off' variant exists for this field, ever. */
    lifetimeCap: z.number().int().positive().default(DEFAULT_BOUNDS.lifetimeRestartMax),
    /** Gate for `windowMax: 'off'`; retains the lifetime cap regardless. */
    unsafeDev: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.windowMax === RESTART_WINDOW_OFF && !v.unsafeDev) {
      ctx.addIssue({
        code: 'custom',
        message: "restarts.windowMax 'off' requires restarts.unsafeDev=true (§14: --unsafe-dev)",
        path: ['windowMax'],
      });
    }
  })
  .readonly();
const RESTARTS_DEFAULT = restartsSchema.parse({});

// ---------------------------------------------------------------------------
// §13 unknown-ETA probe ladder: 30m → 1h → 2h → 4h, bounded PER INCIDENT.
// W2-4 (P4a): the cap is `maxProbesPerIncident` (default 6) and exhaustion
// is PERMANENT for that incident — no sliding time window exists (a 24h
// window was deliberately rejected complexity); manual `resume` always
// remains available. The pure scheduler (src/scheduler/limit-schedule.ts)
// computes every deadline from THIS pinned per-run config.
// ---------------------------------------------------------------------------
const limitProbeSchema = z
  .object({
    /** Backoff delays in minutes; must be non-decreasing. */
    ladderMinutes: z
      .array(z.number().int().positive())
      .min(1)
      .refine((arr) => arr.every((v, i) => i === 0 || v >= (arr[i - 1] ?? 0)), {
        message: 'ladderMinutes must be non-decreasing',
      })
      .readonly()
      .default([...DEFAULT_PROBE_LADDER_MINUTES]),
    /** Per-incident probe cap; exhaustion is permanent for the incident. */
    maxProbesPerIncident: z.number().int().positive().default(DEFAULT_BOUNDS.probeMax),
  })
  .strict()
  .readonly();
const LIMIT_PROBE_DEFAULT = limitProbeSchema.parse({});

// ---------------------------------------------------------------------------
// §12.1 quotas: per-run artifact quota 2GB, global 20GB.
// ---------------------------------------------------------------------------
const quotasSchema = z
  .object({
    perRunBytes: z.number().int().positive().default(2 * BYTES_PER_GB),
    globalBytes: z.number().int().positive().default(20 * BYTES_PER_GB),
  })
  .strict()
  .refine((v) => v.perRunBytes <= v.globalBytes, {
    message: 'quotas.perRunBytes must not exceed quotas.globalBytes',
    path: ['perRunBytes'],
  })
  .readonly();
const QUOTAS_DEFAULT = quotasSchema.parse({});

// ---------------------------------------------------------------------------
// §6.3 T23: remediation bound (default 3) — exhaustion → failed.
// ---------------------------------------------------------------------------
const remediationSchema = z
  .object({
    maxRounds: z.number().int().positive().default(DEFAULT_BOUNDS.remediationMax),
  })
  .strict()
  .readonly();
const REMEDIATION_DEFAULT = remediationSchema.parse({});

// ---------------------------------------------------------------------------
// §12.2: checkpoint cadence — every N completed turns (default 3).
// ---------------------------------------------------------------------------
const checkpointSchema = z
  .object({
    cadenceTurns: z.number().int().positive().default(3),
  })
  .strict()
  .readonly();
const CHECKPOINT_DEFAULT = checkpointSchema.parse({});

// ---------------------------------------------------------------------------
// §17.1/W3-1 verification-runner confinement: per-run EXPLICIT env-allowlist
// additions for the host-run spec verification commands (implementor
// self-check). The runner's default is the minimal VERIFICATION_ENV_ALLOWLIST
// (PATH + toolchain basics); there is deliberately NO "inherit everything"
// knob, and credential-shaped names are rejected at parse time (the runner
// refuses them again at construction — belt and braces).
// ---------------------------------------------------------------------------
const verificationSchema = z
  .object({
    /** Extra env KEYS the verification runner inherits from the orchestrator
     * environment, beyond the built-in minimal allowlist. Explicit only. */
    envAllowlist: z
      .array(z.string().min(1))
      .readonly()
      .default([])
      .refine((keys) => !keys.some((key) => isSecretKeyName(key)), {
        message:
          'verification.envAllowlist must not contain credential-shaped names ' +
          '(§17.1/W3-1: verification commands never see credentials in the MVP)',
      }),
  })
  .strict()
  .readonly();
const VERIFICATION_DEFAULT = verificationSchema.parse({});

// ---------------------------------------------------------------------------
// §17.2 honest cost accounting: `--max-budget` is an estimated soft budget
// (undefined = none set; new turns are never refused on cost grounds until an
// operator opts in). `conservativeReservationUsd` is the per-turn reservation
// used only when the adapter's `usageAccounting` is unavailable — an
// explicit, overridable placeholder pending real pricing-table calibration.
// ---------------------------------------------------------------------------
const budgetSchema = z
  .object({
    maxBudgetUsd: z.number().positive().optional(),
    conservativeReservationUsd: z.number().positive().default(0.5),
  })
  .strict()
  .readonly();
const BUDGET_DEFAULT = budgetSchema.parse({});

// ---------------------------------------------------------------------------
// Top-level EngineConfig
// ---------------------------------------------------------------------------
export const engineConfigSchema = z
  .object({
    memory: memorySchema.default(MEMORY_DEFAULT),
    restarts: restartsSchema.default(RESTARTS_DEFAULT),
    /** §14 concurrency: simple max-live-children guard (default 3). */
    maxLiveChildren: z.number().int().positive().default(3),
    /** §13: per-assignment default; `wait|switch_model|switch_harness|ask`. */
    failoverPolicy: z.literal(FAILOVER_POLICIES).default(DEFAULT_FAILOVER_POLICY),
    limitProbe: limitProbeSchema.default(LIMIT_PROBE_DEFAULT),
    quotas: quotasSchema.default(QUOTAS_DEFAULT),
    remediation: remediationSchema.default(REMEDIATION_DEFAULT),
    checkpoint: checkpointSchema.default(CHECKPOINT_DEFAULT),
    budget: budgetSchema.default(BUDGET_DEFAULT),
    /** §17.1/W3-1: verification-runner confinement knobs. */
    verification: verificationSchema.default(VERIFICATION_DEFAULT),
  })
  .strict()
  .readonly();

export type EngineConfig = z.infer<typeof engineConfigSchema>;
export type MemoryConfig = EngineConfig['memory'];
export type RestartsConfig = EngineConfig['restarts'];
export type LimitProbeConfig = EngineConfig['limitProbe'];
export type QuotasConfig = EngineConfig['quotas'];
export type RemediationConfig = EngineConfig['remediation'];
export type CheckpointConfig = EngineConfig['checkpoint'];
export type BudgetConfig = EngineConfig['budget'];
export type VerificationConfig = EngineConfig['verification'];

/** Fully-resolved defaults — safe to import directly with no I/O or overrides. */
export const DEFAULT_ENGINE_CONFIG: EngineConfig = deepFreeze(engineConfigSchema.parse({}));
