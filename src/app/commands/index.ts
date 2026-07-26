/**
 * Application-neutral command surface (plan §3A.1 / Phase A0).
 *
 * Types, the CLI-only seam, and the shared executor. The CLI adapter in
 * `src/cli/commands.ts` translates RunCommand ↔ ApplicationCommand and
 * renders ApplicationResult → {json, text, exitCode}.
 */
export * from './types.js';
export * from './cli-seam.js';
export * from './executor.js';
export * from './operation-recovery.js';
