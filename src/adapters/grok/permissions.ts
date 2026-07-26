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
import { permissiveImplementorPosture } from '../../lib/permanent-deny.js';
import { writeBoundary, type WriteBoundary } from '../../worktree/write-scope.js';
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
  /**
   * The EXECUTION root: where the session runs and what the read-only shell
   * classifier judges absolute path arguments against. Reads legitimately span
   * the whole tree even when writes do not.
   */
  readonly cwd: string;
  /**
   * B4 — the implementor's WRITE boundary, separate from `cwd` because
   * narrowing READS to a scope would deny the agent the exploration its own
   * prompt tells it to do, while leaving WRITES at `cwd` is exactly the
   * whole-root permission shared-tree parallelism cannot have.
   *
   * Optional, and the omission is safe in one direction only: this function
   * falls back to the single root `cwd`, which is byte-for-byte the pre-B4
   * `workspaceWriteRoot: cwd` binding. Supplying a boundary can only NARROW.
   * The invariant this module exists to protect — every Grok session that can
   * approve anything has a VALIDATED write boundary, never a raw string — holds
   * either way, because the fallback goes through `writeBoundary()` too.
   */
  readonly writeBoundary?: WriteBoundary;
  /** Exact verification commands to allowlist as `Execute` titles. */
  readonly allowedShellCommands?: readonly string[];
}

/**
 * Build the Grok mediation config. THE ONLY producer of `VetoedMediation`.
 *
 * The veto is attached last and unconditionally, so no branch below can return a
 * config without it. When the caller supplied no mediation at all we still
 * produce one rather than returning `undefined`, so there is no "no config, no
 * veto" path either.
 *
 * §2.4: this is also the ONE place that turns the permissive implementor default
 * on. The posture rides in the same shaped policy as the read-only classifier
 * and the write boundary, so a Grok implementor either gets all three or gets
 * none — there is no partially-configured session. Every other role, and every
 * caller-supplied interactive config, keeps today's deny-by-default.
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
            // F14: the classifier is BOUND to the assignment worktree here —
            // the same root the structured-write rule uses on the next line,
            // and the same absolute path the implementor prompt confines the
            // agent to. Before this binding it judged absolute paths with no
            // root at all and therefore refused every one of them, including
            // the worktree the prompt had just named; the agent's first
            // exploration command was denied and the turn ended before any work
            // was committed. `isGrokReadOnlyShellPermissionTitle` requires the
            // root parameter, so this closure is the only way to satisfy
            // `allowReadOnlyOperation`'s single-argument shape — a future call
            // site cannot re-acquire the old behaviour by simply passing the
            // function reference.
            allowReadOnlyOperation: (operation: string): boolean =>
              isGrokReadOnlyShellPermissionTitle(operation, input.cwd),
            // B4: the WRITE rule is bound to the assignment's scope, which may
            // be narrower than `cwd`. The read-only classifier above stays on
            // `cwd` deliberately — an implementor must be able to READ the tree
            // it is changing a corner of.
            workspaceWriteBoundary:
              input.writeBoundary ?? writeBoundary({ mode: 'worktree', executionRoot: input.cwd }),
            // §2.4: the permissive default, bound to the SAME execution root the
            // read-only classifier judges absolute path arguments against. This
            // is the only production site that turns it on, and it is the site
            // whose denials were measured: `run_c4648778` lost four consecutive
            // implementor turns to `git tag -l`, `2>&1` and `git ls-tree`, each
            // separately patched into the read-only classifier afterwards.
            //
            // The posture is bound to `cwd`, not to `writeBoundary`, for the
            // same reason the read-only classifier is: the §2.4 containment rule
            // asks "is this outside the agent's worktree", which is a READ
            // boundary question. Narrowing WRITES stays the write boundary's
            // job, and the workspace-write rule above still adjudicates every
            // structured write against it.
            implementorPosture: permissiveImplementorPosture(input.cwd),
          },
        }
      : base;
  // UNCONDITIONAL — outside every branch above. Every role, every mode.
  return { ...shaped, verifyOperationPayload: grokShellPayloadMatchesTitle };
}
