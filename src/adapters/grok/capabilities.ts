/** Source/live-characterized Grok Build 0.2.106 ACP capabilities. */
import type { RoleName } from '../../domain/state.js';
import type { Clock } from '../../lib/clock.js';
import {
  deriveAuthReadiness,
  type AuthReadiness,
  type AuthValidationEvidence,
  type CapabilityRecord,
  type ExecutableInfo,
} from '../spi.js';
import { XAI_API_KEY_ENV_VAR } from './auth.js';

export const GROK_HARNESS_ID = 'grok';
export const GROK_ACP_PROTOCOL_VERSION = 1;
export const GROK_ACP_AUTH_METHOD = 'grok.com';

/** Native delegation controls are disabled at spawn and reported as conflicts. */
export const GROK_CONFLICTING_BUILTIN_TOOLS = [
  'task',
  'kill_task',
  'get_task_output',
] as const;

export type GrokSandboxProfile = 'read-only' | 'strict';
export type GrokPermissionMode = 'acceptEdits' | 'dontAsk' | 'auto';

/** Undefined/unknown roles fail closed to the read-only process sandbox. */
export function grokSandboxProfileForRole(role: RoleName | undefined): GrokSandboxProfile {
  return role === 'implementor' ? 'strict' : 'read-only';
}

/**
 * Implementor runs in `auto` (grok auto-approves its own tool calls, contained
 * by the `strict` FS sandbox); every other role fails closed to `dontAsk`.
 * NOTE (macOS): `--sandbox strict` does NOT block child-process network on
 * macOS (Seatbelt no-op — Linux-only via seccomp), so under `auto` the
 * implementor's shell network egress is NOT sandbox-restricted here; grok's
 * native network (web/telemetry/sharing) stays disabled by home-isolation.
 */
export function grokPermissionModeForRole(role: RoleName | undefined): GrokPermissionMode {
  return role === 'implementor' ? 'auto' : 'dontAsk';
}

export interface GrokAuthProbeContext {
  readonly authMaterialDetected?: boolean;
  readonly evidence?: AuthValidationEvidence;
}

export function probeGrokAuthReadiness(
  env: NodeJS.ProcessEnv = process.env,
  context: GrokAuthProbeContext = {},
): AuthReadiness {
  const apiKey = env[XAI_API_KEY_ENV_VAR];
  const materialDetected =
    (typeof apiKey === 'string' && apiKey.length > 0) || context.authMaterialDetected === true;
  return deriveAuthReadiness(materialDetected, context.evidence ?? {});
}

export interface GrokCapabilityInput {
  readonly executable: ExecutableInfo;
  readonly clock: Clock;
  readonly auth?: AuthReadiness;
}

/**
 * Static baseline. Grok 0.2.106 initialize advertises loadSession and the
 * permission core, but no standard resume/fork/config-option capability.
 * Live ACP observations remain authoritative in the shared adapter.
 */
export function buildGrokCapabilityRecord(input: GrokCapabilityInput): CapabilityRecord {
  return {
    harnessId: GROK_HARNESS_ID,
    protocol: { name: 'acp', version: String(GROK_ACP_PROTOCOL_VERSION) },
    executable: input.executable,
    auth: input.auth ?? probeGrokAuthReadiness(),
    sessionOps: { create: true, load: true, resume: false, fork: false, cancel: true },
    configOptions: [],
    modelMechanism: 'cli_flag',
    permissionRequests: true,
    mcpConfig: { supported: false, reportOnly: true },
    checkpointExport: false,
    usageLimitReporting: 'parseable',
    retryAfterTier: 'forecast_only',
    usageAccounting: 'none',
    conflictingBuiltinTools: GROK_CONFLICTING_BUILTIN_TOOLS,
    sessionIdentity: { exposesNativeSessionId: false, confirmsIdentityOnResume: true },
    probedAt: input.clock.nowIso(),
  };
}
