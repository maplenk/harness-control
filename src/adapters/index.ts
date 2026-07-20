/**
 * Adapter layer (PLAN §9, §10): the transport-agnostic harness adapter SPI,
 * the scriptable fakes used by the conformance suite, the generic ACP stdio
 * transport + session adapter, the per-provider ACP profiles, and the
 * factory that composes profile × transport into a ready adapter.
 *
 * `claude`/`codex`/`opencode` are NAMESPACE re-exports on purpose: the profile
 * packages intentionally mirror each other's module layout and therefore
 * declare same-named members (`checkVersionPin`, `ResolvedAdapterCommand`,
 * `ResolveCommandOptions`, `VersionPinCheck`, `EnvelopeRecord`) — star
 * re-exporting both would make those names silently ambiguous (ESM drops
 * ambiguous star exports rather than erroring). Deep imports
 * (`./claude/index.js`, `./codex/index.js`, `./opencode/index.js`) remain
 * first-class.
 */
export * from './spi.js';
export * from './fake/index.js';
export * from './acp/index.js';
export * from './factory.js';
export { createClaudeProviderAdapter } from './claude/provider.js';
export * as claude from './claude/index.js';
export * as codex from './codex/index.js';
export * as opencode from './opencode/index.js';
