/**
 * Public surface of the harness-orchestration P1 core (PLAN.md §20 P1:
 * contracts & persistence). One entry point for everything the P2+ layers
 * (application service, adapters, CLI — PLAN §5) consume:
 *
 * - lib:         injected clock/id providers, Result, branding, bounded queue
 * - domain:      ids, entities, event vocabulary, state axes, §6.3 transition table
 * - redaction:   redaction before every sink (§17.1)
 * - artifacts:   content-addressed store + reference-aware GC (§12.1, §12.2)
 * - checkpoint:  mechanical checkpoint contract (§12.2)
 * - memory:      provenance memory + deterministic context selection (§15)
 * - persistence: SQLite drivers, repositories, §6.3 one-transaction write path (§12.1)
 * - config:      engine config schema/loader + role-profile parsing (§8, §18, D3)
 *
 * Test scaffolding (src/persistence/test-support.ts, src/memory/test-support.ts)
 * is deliberately NOT re-exported: it is not part of the public surface.
 * Every shared type has exactly ONE declaration (in src/domain or src/lib),
 * so these star re-exports cannot become ambiguous; `DEFAULT_ENGINE_CONFIG`
 * appears via both config/schema.js and config/loader.js but is the same
 * declaration re-exported, which is legal and unambiguous.
 */

// Shared primitives (deterministic infrastructure; PLAN §19 "fake clocks/IDs")
export * from './lib/brand.js';
export * from './lib/clock.js';
export * from './lib/id-factory.js';
export * from './lib/result.js';
export * from './lib/bounded-queue.js';

// Domain contracts (§6)
export * from './domain/ids.js';
export * from './domain/entities.js';
export * from './domain/events.js';
export * from './domain/state.js';
export * from './domain/transitions.js';

// Redaction before every sink (§17.1)
export * from './redaction/index.js';

// Content-addressed artifact store + GC (§12.1, §12.2)
export * from './artifacts/index.js';

// Mechanical checkpoints (§12.2)
export * from './checkpoint/index.js';

// Memory + context economics (§15)
export * from './memory/scope.js';
export * from './memory/store.js';
export * from './memory/selector.js';

// Persistence (§12.1): drivers, migrations, repositories, write path
export * from './persistence/index.js';

// Engine config + role profiles (§8, §18, D3)
export * from './config/schema.js';
export * from './config/loader.js';
export * from './config/frontmatter.js';
export * from './config/profile.js';

// ---------------------------------------------------------------------------
// P2 packages (PLAN §20 P2: transport & supervision), wired as NAMESPACE
// exports — unlike the P1 modules above, these packages declare overlapping
// member names both across themselves and with the P1 core (e.g. the
// claude/codex profiles' mirrored `checkVersionPin`, the SPI's
// `AuthReadiness` vocabulary), so star re-exports would silently drop the
// ambiguous names (ESM semantics). Namespaces keep every name reachable
// from the single entry point with zero ambiguity; deep imports
// (`./adapters/spi.js`, `./supervisor/watchdog.js`, …) remain first-class.
// ---------------------------------------------------------------------------

// Harness adapter SPI + fakes + generic ACP transport + provider profiles (§9, §10)
export * as adapters from './adapters/index.js';

// Process supervision: identity registry, watchdog, breaker, heartbeat (§14)
export * as supervisor from './supervisor/index.js';

// Git worktrees: manager, mutex, validation, paths (§16)
export * as worktree from './worktree/index.js';

// CLI surface (§18): doctor report collection (the bin entry is src/cli/index.ts)
export * as cli from './cli/doctor.js';
