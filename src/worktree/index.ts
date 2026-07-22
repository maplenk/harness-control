/**
 * Public surface of the git worktree manager package (PLAN.md §16).
 * Ownership: src/worktree/**.
 *
 * `./test-support.ts` is deliberately NOT re-exported here (mirrors
 * `src/persistence/test-support.ts` / `src/memory/test-support.ts`'s
 * convention) — it is real, exported, importable-by-path scaffolding
 * (including the `assertPrimaryCheckoutUntouched` helper PLAN §19 test 17
 * will use in P3), just not part of this package's public API surface.
 */
export * from './errors.js';
export * from './advisory-lease.js';
export * from './git.js';
export * from './mutex.js';
export * from './paths.js';
export * from './provision.js';
export * from './validate.js';
export * from './manager.js';
