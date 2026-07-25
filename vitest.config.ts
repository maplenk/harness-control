// Root Vitest config.
//
// Its SOLE purpose is the `**/.claude/**` exclude. It deliberately configures
// nothing else — no `root`, no `include`, no pool/environment changes — so
// `npm test` keeps behaving exactly as it did on bare defaults.
// (Line comments, not a block comment: the glob patterns below contain `*/`.)
//
// WHY THE EXCLUDE EXISTS
// We use Claude agent worktrees routinely, and they live at
// `.claude/worktrees/agent-*` — each one a full checkout of THIS repo, mirroring
// `src/` (its own `*.test.ts` files, its own `node_modules`). Vitest's default
// excludes cover `node_modules`, `dist`, `cypress` and `.{idea,git,cache,output,temp}`
// — but NOT `.claude`. So a bare `npm test` at the repo root discovers the whole
// suite once per leftover worktree, on top of the real one.
//
// That is not theory: the historically reported suite size of 206 files / 3398
// tests was exactly 2x the real 103 files / 1699 tests, because the stale F7 agent
// worktree `.claude/worktrees/agent-ad6b0180db834588b` was still on disk (verified
// 2026-07-25 with `npx vitest run --exclude '**/.claude/**'`). The failure mode is
// nasty in both directions: a STALE copy passes self-consistently and silently
// inflates counts and wall-clock, while a DIVERGED copy can fail a tree that is
// actually green. Assignment worktrees are engine-created from the committed tree
// and live outside the repo, so the verifier was never affected — this is a
// primary-checkout hygiene problem only.
//
// GUARD CONVENTION (do not delete this exclude without replacing the guard)
// An exclude removes files from discovery, so it needs a floor underneath it:
//
//     npx vitest list --filesOnly | wc -l     # must be >= 103
//
// `scripts/dogfood/preflight.sh` enforces that floor before every dogfood run, and
// suite-touching slices carry it as an acceptance criterion. The floor is what
// catches the OTHER direction of this bug class — a config change that silently
// reroutes discovery (e.g. a root Vite/Vitest config setting `root: 'web'`, which
// collapses collection to a single file and still exits 0). Raise the floor when
// the real suite grows; never lower it to make a run pass.
//
// `configDefaults.exclude` is spread in explicitly rather than replaced, so the
// built-in ignores survive this file — and survive Vitest upgrades that add more.
// Current defaults, for readers: `**/node_modules/**`, `**/dist/**`,
// `**/cypress/**`, `**/.{idea,git,cache,output,temp}/**`, and
// `**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*`.
import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '**/.claude/**'],
  },
});
