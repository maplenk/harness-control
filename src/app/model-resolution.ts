/**
 * MODEL / EFFORT resolution (PLAN §3, §11.2) — the piece the live acceptance
 * smoke (§20 P3) turns on: given a role's `{harness, model, effort}`, produce
 * the exact `session/set_config_option` calls that pin the model slug and
 * reasoning effort on a live session, then apply them through the §11.2
 * confirm-by-echo flow.
 *
 * Provider mechanisms (source-verified in the adapter profiles):
 *  - **Claude** (`claude-agent-acp@0.59.0`, `modelMechanism =
 *    session_set_config_option`): effort maps onto the `thought_level`/
 *    reasoning config option (SPI kind `'reasoning'`); the model slug onto the
 *    `model` config option. Example live target: `opus` at effort `low`.
 *  - **Codex** (`codex-acp@1.1.4`, `modelMechanism =
 *    session_set_config_option`): the model slug (e.g. `gpt-5.6-terra`) onto
 *    the `model` config option and effort onto `model_reasoning_effort`. The
 *    underlying `codex` core ALSO accepts these as `-c key=value` spawn
 *    overrides (`-c model=…`, `-c model_reasoning_effort=…`) — carried here as
 *    `codexConfigOverrides`, the documented fallback (codex/capabilities.ts)
 *    if `session/set_config_option` ever regresses.
 *  - **OpenCode** (`opencode-ai@1.18.1`, native `opencode acp`): a fully
 *    qualified provider/model id (for example `openai/gpt-4.1`) maps to
 *    `model`; its model-dependent reasoning variant maps
 *    to the `effort` config option.
 *  - **Grok Build** (`grok agent stdio`): model and reasoning effort are
 *    process-spawn pins exposed to the orchestration layer as virtual ACP
 *    config options (`model` and `reasoning_effort`). This preserves the same
 *    confirm-by-echo contract as session-mutable providers without silently
 *    pretending the underlying process can switch either value in place.
 *
 * `resolveRoleModel` is PURE (no I/O, no adapter): it yields config-option
 * INTENTS keyed by purpose. `applyRoleModel` is the one function that touches
 * an adapter — it resolves each intent's wire option id against the session's
 * advertised options (exact id, else first option of the matching SPI kind)
 * and drives `setConfigOption`, recording the §11.2 effective-value echo. A
 * per-intent adapter failure is captured (`ok:false`), never thrown HERE —
 * enforcement is the caller's job: `OrchestrationService.runRole` retries a
 * failed pin once and then fails the spawn with a typed `ModelPinError`
 * (W1-F8), so a role never silently runs on the provider default.
 */
import type { AcpSessionId } from '../domain/ids.js';
import {
  isAdapterError,
  type ConfigOptionDescriptor,
  type HarnessAdapter,
} from '../adapters/spi.js';
import { redactText } from '../redaction/index.js';

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------
/** Live ACP harnesses supported by the runtime. */
export const HARNESSES = ['claude', 'codex', 'opencode', 'grok'] as const;
export type Harness = (typeof HARNESSES)[number];

/**
 * Reasoning effort vocabulary. Codex's `model_reasoning_effort` accepts
 * `minimal|low|medium|high` (OpenAI reasoning-effort levels); Claude's
 * reasoning/thought_level option is reconciled against its own advertised
 * values in `applyRoleModel`, so the same discrete ladder is used as the
 * canonical request and mapped by `resolveOptionId`.
 */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

/** A role's resolved harness/model/effort triple (the input to §11.2 pinning). */
export interface RoleModelSpec {
  readonly harness: Harness;
  /** Provider model slug/id, e.g. `opus` or `openai/gpt-4.1`. */
  readonly model: string;
  readonly effort?: ReasoningEffort;
}

/** Narrow an arbitrary harness string (e.g. from a profile/CLI) to `Harness`. */
export function asHarness(value: string): Harness {
  if ((HARNESSES as readonly string[]).includes(value)) return value as Harness;
  throw new Error(`Unknown harness '${value}' (expected one of ${HARNESSES.join(', ')})`);
}

/** Ergonomic builder that validates the effort against the known ladder. */
export function roleModelSpec(harness: Harness, model: string, effort?: string): RoleModelSpec {
  if (effort !== undefined && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new Error(`Unknown reasoning effort '${effort}' (expected one of ${REASONING_EFFORTS.join(', ')})`);
  }
  return { harness, model, ...(effort !== undefined ? { effort: effort as ReasoningEffort } : {}) };
}

// ---------------------------------------------------------------------------
// Well-known config option ids (preferred; matched by kind as a fallback)
// ---------------------------------------------------------------------------
export const MODEL_OPTION_ID = 'model';
/** Preferred Claude reasoning option id; matched by SPI kind `'reasoning'`. */
export const CLAUDE_REASONING_OPTION_ID = 'thinking';
/** Codex's config key for reasoning effort (also a `-c` override key). */
export const CODEX_REASONING_OPTION_ID = 'model_reasoning_effort';
/** OpenCode's provider/model-specific reasoning variant option. */
export const OPENCODE_REASONING_OPTION_ID = 'effort';
/** Grok Build's spawn-time reasoning-effort virtual config option. */
export const GROK_REASONING_OPTION_ID = 'reasoning_effort';

// ---------------------------------------------------------------------------
// Resolved intents
// ---------------------------------------------------------------------------
export type ConfigOptionPurpose = 'model' | 'reasoning';

export interface ConfigOptionIntent {
  readonly purpose: ConfigOptionPurpose;
  /** Preferred wire option id (used verbatim if the session advertises it). */
  readonly optionId: string;
  readonly value: string;
  /** SPI kind used to resolve the option id when the preferred id is absent. */
  readonly kind: ConfigOptionDescriptor['kind'];
}

export interface ResolvedRoleModel {
  readonly harness: Harness;
  readonly model: string;
  readonly effort?: ReasoningEffort;
  /** Ordered `setConfigOption` intents (model first, then reasoning). */
  readonly configOptions: readonly ConfigOptionIntent[];
  /**
   * Codex-only `-c key=value` core overrides (model slug + reasoning effort) —
   * the documented spawn-time fallback; the MVP applies model/effort via
   * `session/set_config_option` instead (codex-acp's advertised mechanism).
   */
  readonly codexConfigOverrides?: Readonly<Record<string, string>>;
}

/** Sink-safe profile identity used by F13's cross-vendor audit and rejection. */
export interface ResolvedRoleProfile {
  readonly harness: Harness;
  readonly model: string;
  readonly effort?: ReasoningEffort;
}

export interface VerificationRoleResolution {
  readonly implementor: ResolvedRoleProfile;
  readonly verifier: ResolvedRoleProfile;
  readonly resolvedHarnesses: {
    readonly implementor: Harness;
    readonly verifier: Harness;
  };
  readonly warnings: readonly string[];
}

export class IndependenceViolationError extends Error {
  override readonly name: string = 'IndependenceViolationError';
  readonly code = 'independence_violation' as const;
  readonly implementor: ResolvedRoleProfile;
  readonly verifier: ResolvedRoleProfile;

  constructor(
    implementor: ResolvedRoleProfile,
    verifier: ResolvedRoleProfile,
  ) {
    super(
      'independence_violation: verifier harness equals implementor harness ' +
        `(${describeResolvedProfile(implementor)}; ${describeResolvedProfile(verifier)}). ` +
        'Set verification.allowSameHarness=true only for a knowing single-vendor run.',
    );
    this.implementor = implementor;
    this.verifier = verifier;
  }
}

function resolvedProfile(spec: RoleModelSpec): ResolvedRoleProfile {
  const resolved = resolveRoleModel(spec);
  return {
    harness: resolved.harness,
    model: resolved.model,
    ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
  };
}

function describeResolvedProfile(profile: ResolvedRoleProfile): string {
  return (
    `${profile.harness}/${profile.model}` +
    (profile.effort !== undefined ? `@${profile.effort}` : '')
  );
}

/**
 * Resolve both verification roles together and enforce harness independence.
 * Model sameness is reported, not rejected; harness sameness requires the
 * explicit run-config opt-out.
 */
export function resolveVerificationRoles(
  implementorSpec: RoleModelSpec,
  verifierSpec: RoleModelSpec,
  allowSameHarness: boolean,
): VerificationRoleResolution {
  const implementor = resolvedProfile(implementorSpec);
  const verifier = resolvedProfile(verifierSpec);
  if (
    implementor.harness === verifier.harness &&
    !allowSameHarness
  ) {
    throw new IndependenceViolationError(implementor, verifier);
  }

  const warnings: string[] = [];
  if (implementor.harness === verifier.harness) {
    warnings.push(
      'verification.allowSameHarness=true: implementor and verifier use the ' +
        `same harness (${implementor.harness}); cross-vendor independence is disabled.`,
    );
    if (implementor.model === verifier.model) {
      warnings.push(
        `implementor and verifier also resolve to the same model ` +
          `(${implementor.harness}/${implementor.model}); allowed with warning.`,
      );
    }
  }
  return {
    implementor,
    verifier,
    resolvedHarnesses: {
      implementor: implementor.harness,
      verifier: verifier.harness,
    },
    warnings,
  };
}

/**
 * Pure mapping of `{harness, model, effort}` → config-option intents (§11.2).
 * Model slug always pins the `model` option; effort (when present) pins the
 * provider's reasoning option.
 */
export function resolveRoleModel(spec: RoleModelSpec): ResolvedRoleModel {
  const intents: ConfigOptionIntent[] = [
    { purpose: 'model', optionId: MODEL_OPTION_ID, value: spec.model, kind: 'model' },
  ];

  if (spec.harness === 'claude') {
    if (spec.effort !== undefined) {
      intents.push({
        purpose: 'reasoning',
        optionId: CLAUDE_REASONING_OPTION_ID,
        value: spec.effort,
        kind: 'reasoning',
      });
    }
    return {
      harness: 'claude',
      model: spec.model,
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      configOptions: intents,
    };
  }

  if (spec.harness === 'codex') {
    const overrides: Record<string, string> = { model: spec.model };
    if (spec.effort !== undefined) {
      intents.push({
        purpose: 'reasoning',
        optionId: CODEX_REASONING_OPTION_ID,
        value: spec.effort,
        kind: 'reasoning',
      });
      overrides[CODEX_REASONING_OPTION_ID] = spec.effort;
    }
    return {
      harness: 'codex',
      model: spec.model,
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      configOptions: intents,
      codexConfigOverrides: overrides,
    };
  }

  if (spec.harness === 'grok') {
    if (spec.effort !== undefined) {
      intents.push({
        purpose: 'reasoning',
        optionId: GROK_REASONING_OPTION_ID,
        value: spec.effort,
        kind: 'reasoning',
      });
    }
    return {
      harness: 'grok',
      model: spec.model,
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
      configOptions: intents,
    };
  }

  if (spec.effort !== undefined) {
    intents.push({
      purpose: 'reasoning',
      optionId: OPENCODE_REASONING_OPTION_ID,
      value: spec.effort,
      kind: 'reasoning',
    });
  }
  return {
    harness: 'opencode',
    model: spec.model,
    ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    configOptions: intents,
  };
}

// ---------------------------------------------------------------------------
// Application against a live session (§11.2 confirm-by-echo)
// ---------------------------------------------------------------------------
/**
 * A typed rejection: the caller asked for a MODEL slug that the live session
 * does NOT advertise (§5t (5)). BEFORE this guard `resolveOptionId` silently
 * fell back to the first advertised option of the `model` kind, so an
 * unadvertised target could be "set" against the wrong/default option and then
 * "confirmed" by the echo — a wrong model presented as applied. An explicit
 * unadvertised model target is now a loud, typed error (thrown at resolution,
 * before any adapter call), never a silent swap. Affects `initial_config_pin` /
 * F8 pinning TODAY, not just switch-model.
 */
export class UnadvertisedModelTargetError extends Error {
  override readonly name: string = 'UnadvertisedModelTargetError';
  readonly requestedModel: string;
  readonly advertisedModels: readonly string[];

  constructor(requestedModel: string, advertisedModels: readonly string[]) {
    super(
      `model '${requestedModel}' is not advertised by the live session ` +
        `(advertised: ${advertisedModels.join(', ')}) — refusing to silently substitute a different model`,
    );
    this.requestedModel = requestedModel;
    this.advertisedModels = [...advertisedModels];
  }
}

/**
 * Resolve an intent's wire option id against a session's advertised options:
 * an exact id match wins; otherwise the first advertised option of the
 * intent's SPI kind; otherwise the preferred id verbatim (so a still-unlisted
 * option is at least attempted and fails loudly at the adapter).
 *
 * For a MODEL intent whose EXPLICIT target slug is not among the resolved
 * option's advertised `values`, this THROWS `UnadvertisedModelTargetError`
 * rather than silently swapping to a different/default model (§5t (5)). The
 * no-explicit-target default behavior is preserved: an option that advertises
 * NO enumerated values (`values: []`) cannot be validated, so the request is
 * still attempted and fails loudly at the adapter if wrong.
 */
export function resolveOptionId(
  intent: ConfigOptionIntent,
  advertised: readonly ConfigOptionDescriptor[],
): string {
  const exact = advertised.find((option) => option.id === intent.optionId);
  if (exact !== undefined) {
    assertAdvertisedModelTarget(intent, exact);
    return intent.optionId;
  }
  const byKind = advertised.find((option) => option.kind === intent.kind);
  if (byKind === undefined) return intent.optionId;
  assertAdvertisedModelTarget(intent, byKind);
  return byKind.id;
}

/**
 * Reject an EXPLICIT unadvertised MODEL target. Only the `model` kind is guarded
 * (a wrong model silently "confirmed" is the §5t (5) bug); reasoning-value
 * mismatches stay captured as `ok:false` per-intent adapter failures (W1-F8).
 * An option that enumerates NO values cannot be validated → not rejected.
 */
function assertAdvertisedModelTarget(
  intent: ConfigOptionIntent,
  option: ConfigOptionDescriptor,
): void {
  if (intent.kind !== 'model') return;
  if (option.values.length === 0) return;
  if (option.values.includes(intent.value)) return;
  throw new UnadvertisedModelTargetError(intent.value, option.values);
}

/** One applied model/effort pin (the §11.2 echo outcome for one intent). */
export interface AppliedConfigOption {
  readonly intent: ConfigOptionIntent;
  readonly resolvedOptionId: string;
  readonly ok: boolean;
  /** Effective value the adapter reported (§11.2), when the set succeeded. */
  readonly effectiveValue?: string;
  /** true only when the adapter OBSERVED an effective-value echo (§11.2). */
  readonly echoed?: boolean;
  readonly error?: string;
  /** The RAW thrown error for `ok:false` (W2-3: classification precedes any
   * retry — the enforcement path feeds this to the profile `classifyError`,
   * which needs the typed error/envelope, not the flattened string). */
  readonly rawError?: unknown;
}

/**
 * Apply a resolved model/effort to a live session via `setConfigOption`,
 * recording each §11.2 effective-value echo. Per-intent adapter failures are
 * captured (`ok:false, error`), never thrown — enforcement (one retry, then
 * a typed `ModelPinError` failing the spawn) lives in
 * `OrchestrationService.runRole` (W1-F8). An `ok:true` without an echo is an
 * unconfirmed pin (`echoed:false`), accepted — some adapters do not echo.
 *
 * A resolution-time rejection (§5t (5): an explicit unadvertised MODEL target,
 * `UnadvertisedModelTargetError`) is likewise CAPTURED as `ok:false` before any
 * adapter call — never a silent swap to a different model — so enforcement fails
 * the spawn loudly instead of pinning the wrong model and "confirming" it.
 */
export async function applyRoleModel(
  adapter: HarnessAdapter,
  sessionId: AcpSessionId,
  resolved: ResolvedRoleModel,
  advertised: readonly ConfigOptionDescriptor[],
): Promise<readonly AppliedConfigOption[]> {
  const applied: AppliedConfigOption[] = [];
  for (const intent of resolved.configOptions) {
    let resolvedOptionId: string;
    try {
      resolvedOptionId = resolveOptionId(intent, advertised);
    } catch (error) {
      // §5t (5): an explicit unadvertised model target is a typed rejection,
      // not a silent fallback. Record it as a failed pin so W1-F8 enforcement
      // fails the spawn rather than silently running a substituted model.
      applied.push({
        intent,
        resolvedOptionId: intent.optionId,
        ok: false,
        error: redactText(isAdapterError(error) ? `${error.kind}: ${error.message}` : String(error)),
        rawError: error,
      });
      continue;
    }
    try {
      const result = await adapter.setConfigOption({
        sessionId,
        optionId: resolvedOptionId,
        value: intent.value,
      });
      applied.push({
        intent,
        resolvedOptionId,
        ok: true,
        effectiveValue: result.effectiveValue,
        echoed: result.echoed,
      });
    } catch (error) {
      applied.push({
        intent,
        resolvedOptionId,
        ok: false,
        // The flattened string is SINK-bound (ModelPinError text → CLI/log
        // output); the provider message can echo secrets, so redact here
        // (§17.1). `rawError` stays raw on purpose — the classifier needs
        // the typed error/envelope, and it never reaches a sink itself.
        error: redactText(isAdapterError(error) ? `${error.kind}: ${error.message}` : String(error)),
        rawError: error,
      });
    }
  }
  return applied;
}
