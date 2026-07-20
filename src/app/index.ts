/**
 * Application service engine (PLAN §5, §6, §20 P3) — the orchestration core.
 * Ownership: src/app/**.
 *
 * - `service.ts`: `OrchestrationService` — run lifecycle, the single
 *   authoritative `ingest` transition path, workflow dispatch advances, the
 *   role-flow seam driver, CLI command wrappers, status.
 * - `role-runner.ts`: the `RoleRunner`/`RoleSession` seam the three flows
 *   (coordinator/implementor/verifier) implement next phase, plus the
 *   `PermissionMediation` config.
 * - `model-resolution.ts`: `{harness, model, effort}` → §11.2 config-option
 *   pins (Claude reasoning/thinking; Codex model slug + model_reasoning_effort).
 * - `cost.ts`: §17.2 honest per-role/per-phase token+cost accounting.
 * - `projections.ts`: EngineState reducer + UI vocabulary projection.
 * - `process-registry-store.ts`: W2-6 durable §14 identity store (SQLite
 *   projection layer) backing the supervisor's startup orphan reaping.
 */
export * from './service.js';
export * from './alerts.js';
export * from './role-runner.js';
export * from './planning-chat.js';
export * from './model-resolution.js';
export * from './cost.js';
export * from './projections.js';
export * from './process-registry-store.js';
export * from './desired-model-store.js';
