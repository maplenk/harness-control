/**
 * OpenCode ACP profile — source-characterized static capabilities for the
 * lockfile-pinned OpenCode CLI. Wire-observed capabilities/config options
 * remain authoritative in the generic ACP adapter.
 */
import type { Clock } from '../../lib/clock.js';
import type { SessionModePolicy } from '../acp/session.js';
import {
  deriveAuthReadiness,
  type AuthReadiness,
  type AuthValidationEvidence,
  type CapabilityRecord,
  type ExecutableInfo,
} from '../spi.js';

export const OPENCODE_HARNESS_ID = 'opencode';
export const OPENCODE_ACP_PROTOCOL_VERSION = 1;

/**
 * OpenCode exposes its built-in `plan` and `build` agents as the ACP `mode`
 * config option. Keep read-only roles on `plan`; only the isolated worktree
 * implementor receives `build`.
 */
export const OPENCODE_SESSION_MODE_POLICY: SessionModePolicy = {
  byRole: {
    coordinator: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'plan' },
    implementor: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'build' },
    verifier: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'plan' },
  },
  defaultPin: { mechanism: 'session_set_config_option', optionId: 'mode', value: 'plan' },
};

/**
 * OpenCode includes a general subagent exposed through its task tool. The
 * orchestrator owns delegation, so the profile advertises it as conflicting.
 */
export const OPENCODE_CONFLICTING_BUILTIN_TOOLS: readonly string[] = ['task'];

export interface OpenCodeAuthProbeContext {
  /** `opencode auth login` store was detected (presence only). */
  readonly authMaterialDetected?: boolean;
  readonly evidence?: AuthValidationEvidence;
}

export function probeOpenCodeAuthReadiness(
  context: OpenCodeAuthProbeContext = {},
): AuthReadiness {
  return deriveAuthReadiness(
    context.authMaterialDetected === true,
    context.evidence ?? {},
  );
}

export interface OpenCodeCapabilityInput {
  readonly executable: ExecutableInfo;
  readonly clock: Clock;
  readonly auth?: AuthReadiness;
}

/**
 * Verified against OpenCode 1.18.1:
 * - native `opencode acp`, protocol v1;
 * - load/resume/fork/cancel;
 * - model/effort/mode via `session/set_config_option`;
 * - ACP permission requests;
 * - per-turn usage plus cumulative cost updates.
 */
export function buildOpenCodeCapabilityRecord(
  input: OpenCodeCapabilityInput,
): CapabilityRecord {
  return {
    harnessId: OPENCODE_HARNESS_ID,
    protocol: { name: 'acp', version: String(OPENCODE_ACP_PROTOCOL_VERSION) },
    executable: input.executable,
    auth: input.auth ?? probeOpenCodeAuthReadiness(),
    sessionOps: {
      create: true,
      load: true,
      resume: true,
      fork: true,
      cancel: true,
    },
    // Dynamic provider/model/effort/mode values arrive on session/new/load.
    configOptions: [],
    modelMechanism: 'session_set_config_option',
    permissionRequests: true,
    mcpConfig: { supported: true, reportOnly: true },
    checkpointExport: false,
    // Provider errors cross a structured ACP envelope, but usage-limit
    // discrimination is provider-dependent (HTTP status/errorName).
    usageLimitReporting: 'parseable',
    retryAfterTier: 'forecast_only',
    usageAccounting: 'per_turn',
    conflictingBuiltinTools: OPENCODE_CONFLICTING_BUILTIN_TOOLS,
    sessionIdentity: {
      exposesNativeSessionId: false,
      confirmsIdentityOnResume: true,
    },
    probedAt: input.clock.nowIso(),
  };
}
