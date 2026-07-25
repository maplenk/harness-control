/**
 * Grok permission mediation — assembled in ONE place so the payload veto cannot
 * be omitted.
 *
 * ROUND 6 (the third finding on the same property). The veto had been fixed
 * twice at whatever layer the previous review named, and a different layer
 * remained each time: first it lived on a policy type the interactive config
 * variant does not have, then — once moved to the config root — the FACTORY
 * installed it only for `implementor` + `headless`, so a production interactive
 * Grok session never received it at all and an interactive decider could approve
 * a divergent or absent payload.
 *
 * The property being protected is: **every Grok session that can approve
 * anything carries the payload veto — every role, every mediation mode.** Point
 * fixes kept restating it; this module makes it structural.
 *
 * How the enforcement works:
 *  - `VetoedMediation` requires `verifyOperationPayload` (NOT optional), so a
 *    plain `PermissionMediationConfig` does not satisfy the type. Assigning one
 *    where a `VetoedMediation` is expected is a COMPILE ERROR, which is what
 *    makes "a future path added without a veto" impossible rather than merely
 *    discouraged.
 *  - `buildGrokMediation` is the only producer, and it stamps the veto
 *    UNCONDITIONALLY — outside every role/mode branch. The role- and
 *    mode-specific shaping (allowlist, read-only classifier, workspace-write
 *    root) happens on the way in and cannot skip it.
 */
import type { RoleName } from '../../domain/state.js';
import { noPayloadToVerify, type PermissionMediationConfig, type VerifyOperationPayload } from '../acp/session.js';
import { grokShellPayloadMatchesTitle, grokShellPermissionTitle, isGrokReadOnlyShellPermissionTitle } from './command.js';

/**
 * A mediation config that PROVABLY carries the payload veto. The required
 * property is the enforcement: nothing without a veto is assignable to it.
 */
export type VetoedMediation = PermissionMediationConfig & {
  readonly verifyOperationPayload: VerifyOperationPayload;
};

export interface GrokMediationInput {
  /** The caller's requested mediation, if any. */
  readonly permissions?: PermissionMediationConfig;
  readonly role?: RoleName;
  /** Worktree root for the implementor's structured-write rule. */
  readonly cwd: string;
  /** Exact verification commands to allowlist as `Execute` titles. */
  readonly allowedShellCommands?: readonly string[];
}

/**
 * Build the Grok mediation config. THE ONLY producer of `VetoedMediation`.
 *
 * The veto is attached last and unconditionally, so no branch below can return a
 * config without it. When the caller supplied no mediation at all we still
 * produce one (`headless`, empty policy = default-deny) rather than returning
 * `undefined`, so there is no "no config, no veto" path either.
 */
export function buildGrokMediation(input: GrokMediationInput): VetoedMediation {
  // The placeholder veto here is REPLACED unconditionally by the real one on
  // the final return; it exists only so the intermediate value typechecks.
  const base: PermissionMediationConfig =
    input.permissions ?? { mode: 'headless', verifyOperationPayload: noPayloadToVerify };
  const shaped: PermissionMediationConfig =
    input.role === 'implementor' && base.mode === 'headless'
      ? {
          ...base,
          policy: {
            allow: [
              ...new Set([
                ...(base.policy?.allow ?? []),
                ...(input.allowedShellCommands ?? []).map(grokShellPermissionTitle),
              ]),
            ],
            allowReadOnlyOperation: isGrokReadOnlyShellPermissionTitle,
            workspaceWriteRoot: input.cwd,
          },
        }
      : base;
  // UNCONDITIONAL — outside every branch above. Every role, every mode.
  return { ...shaped, verifyOperationPayload: grokShellPayloadMatchesTitle };
}
