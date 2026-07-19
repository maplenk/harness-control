/**
 * Role-profile parsing (PLAN §7, §8, §18) — the CLI's mapping from the
 * operator-facing `--coordinator`/`--implementor`/`--verifier` surface onto a
 * `RoleModelSpec`, which the engine then feeds to `resolveRoleModel` (§11.2).
 *
 * Two accepted forms (both normative in §18's examples):
 *  - a bare harness plus separate flags: `--coordinator claude --model opus
 *    --effort low`;
 *  - a colon-packed profile token: `--implementor 'codex:gpt-5.6-terra'`
 *    (optionally `harness:model:effort`).
 *
 * Everything here is PURE and total (Result-based, never throws) so the whole
 * arg surface is unit-testable with no engine, DB, or process spawn. The
 * harness/effort vocabularies are validated by the engine's own
 * `asHarness`/`roleModelSpec` builders (single source of truth), so the CLI
 * never re-declares the allowed values.
 */
import { asHarness, roleModelSpec, type RoleModelSpec } from '../app/index.js';
import { err, ok, type Result } from '../lib/result.js';

export interface RoleProfileInput {
  /** PROFILE token: `harness`, `harness:model`, or `harness:model:effort`. */
  readonly profile: string;
  /** `--model` override; used only when the profile omits a model segment. */
  readonly model?: string;
  /** `--effort` override; used only when the profile omits an effort segment. */
  readonly effort?: string;
}

/**
 * Parse a role profile into a `RoleModelSpec`. The colon segments win over the
 * `--model`/`--effort` flags, and supplying a value in BOTH places is a hard
 * error (an ambiguous request should never be silently resolved one way).
 */
export function parseRoleProfile(input: RoleProfileInput): Result<RoleModelSpec, string> {
  const trimmed = input.profile.trim();
  if (trimmed === '') {
    return err('empty profile (expected `harness`, `harness:model`, or `harness:model:effort`)');
  }
  const parts = trimmed.split(':').map((part) => part.trim());
  if (parts.length > 3) {
    return err(`too many ':' segments in profile '${input.profile}' (expected harness[:model[:effort]])`);
  }
  const harnessToken = parts[0];
  if (harnessToken === undefined || harnessToken === '') {
    return err(`missing harness in profile '${input.profile}'`);
  }
  const profileModel = emptyToUndefined(parts[1]);
  const profileEffort = emptyToUndefined(parts[2]);

  if (profileModel !== undefined && input.model !== undefined) {
    return err(`model given twice: in profile '${input.profile}' and via --model '${input.model}'`);
  }
  if (profileEffort !== undefined && input.effort !== undefined) {
    return err(`effort given twice: in profile '${input.profile}' and via --effort '${input.effort}'`);
  }
  const model = profileModel ?? input.model;
  const effort = profileEffort ?? input.effort;
  if (model === undefined) {
    return err(
      `no model for harness '${harnessToken}': put it in the profile ('${harnessToken}:MODEL') or pass --model`,
    );
  }
  return buildSpec(harnessToken, model, effort);
}

export interface SwitchTargetInput {
  /** `--model`; may itself be a `harness:model` token when `--harness` is absent. */
  readonly model: string;
  readonly harness?: string;
  readonly effort?: string;
}

/**
 * Resolve `switch-model`'s target (§11.2, §18: `--role ROLE --model ID
 * [--harness ID]`). The harness comes from `--harness`, or from a
 * `harness:model` prefix on `--model`; it is never guessed. A same-harness
 * switch therefore still names its harness explicitly — the CLI holds no
 * per-role harness state to infer it from (that lives in a live session, §11.1).
 */
export function parseSwitchTarget(input: SwitchTargetInput): Result<RoleModelSpec, string> {
  const rawModel = input.model.trim();
  if (rawModel === '') return err('--model is required for switch-model');
  let harnessToken = emptyToUndefined(input.harness?.trim());
  let model = rawModel;
  if (harnessToken === undefined) {
    const colon = rawModel.indexOf(':');
    if (colon > 0) {
      harnessToken = rawModel.slice(0, colon).trim();
      model = rawModel.slice(colon + 1).trim();
    }
  }
  if (harnessToken === undefined) {
    return err("switch-model needs a target harness: pass --harness, or use --model 'harness:model'");
  }
  if (model === '') return err('--model has no model after the harness prefix');
  return buildSpec(harnessToken, model, input.effort);
}

function buildSpec(harnessToken: string, model: string, effort: string | undefined): Result<RoleModelSpec, string> {
  try {
    const harness = asHarness(harnessToken);
    return ok(roleModelSpec(harness, model, effort));
  } catch (error) {
    return err(error instanceof Error ? error.message : String(error));
  }
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}
