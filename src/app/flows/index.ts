/**
 * Role FLOWS (PLAN §8, §20 P3) — the strategies that plug into the role-flow
 * seam (`../role-runner.ts`). Each implements `RoleRunner` and supplies the
 * turn logic + role-specific pre/post work; the engine (`../service.ts`) owns
 * the surrounding provider lifecycle.
 *
 *  - `implementor.ts`: worktree-confined implementation + verification-command
 *    self-check + work commit (§8 Implementor, §16).
 *  - `verifier.ts`: independent verification + remediation + merge-readiness.
 *  - `orchestrate.ts`: the surrounding P3 orchestrator that composes the
 *    implement → verify → remediation loop into `merge_ready` (§20 P3).
 *
 * (The coordinator flow is importable directly from `./coordinator.js`; its
 * barrel export is left to that file's owner to avoid a concurrent-edit clash.)
 */
export * from './implementor.js';
export * from './verifier.js';
export * from './orchestrate.js';
