# Adversarial review brief — for Codex gpt-5.6-sol (xhigh / High reasoning)

You are reviewing an architecture plan for a cross-harness agent-orchestration MVP. You (gpt-5.6) authored Rev 1 of this plan; a different orchestrator model produced Rev 2 after three research passes and user scope decisions. This is an adversarial peer review, not a rubber stamp. Read-only: do not modify any files except writing your review output (see Output).

## Read first (in this order)
1. `PLAN.md` — Rev 2, the plan under review.
2. `docs/ORCHESTRATOR-NOTES.md` — the orchestrator's full reasoning trail: evidence log with confidence tiers, per-decision reasoning with rejected alternatives, self-identified weak points, standing uncertainties. Attack this reasoning as well as the plan.
3. `docs/archive/PLAN-v1-codex.md` — your Rev 1 baseline, for diffing intent.

Context you may not have: user-locked scope decisions are in PLAN.md §1 (usage-limit pause/resume IS in MVP; "memory optimisation" = BOTH process supervision and context/token economics; the "Intent Next" design package is visual direction only; WebSockets only at the observation boundary).

## Task 1 — Defend Rev 1 / attack Rev 2
Diff Rev 2 against your Rev 1 intent. Which amendments are improvements, which introduce risks or contradictions you would push back on? Defend Rev 1 choices where Rev 2 weakened them.

## Task 2 — Rule on the open debate items (with reasons)
(a) Claude transport: ACP-uniform MVP vs Claude-SDK adapter now (native SDK is stronger for Claude; Codex's native SDK is weaker than its ACP adapter — spawn-per-turn, no permission callback).
(b) The strategic ACP bet vs the market's PTY/headless reality (note: Intent by Augment's local teardown proves Intent drives all its harnesses via ACP — see notes §1).
(c) WebSockets only at the observation/UI boundary (event-bus subscriber, replay-by-sequence), stdio for agent control.
(d) Capability-probing `session/fork`/`session/resume` vs checkpoint-successor-only.
(e) MCP passthrough to sessions: best-effort in MVP (probe + warn; claude-agent-acp issue #883) vs deferred entirely.
(f) D7 `--quick` fast path (threshold-gated auto-approval of micro-specs): does it break the spec-approval invariants?
(g) Memory design: ADD-only entries + bi-temporal invalidation + summarizing compactor — sound or overbuilt for MVP?

## Task 3 — Hunt for flaws in Rev 2
Internal contradictions; unbounded resource risks; missing states/transitions in §6.1 (limit-pause during `awaiting_approval`? breaker during `verifying`? watchdog kill during a git operation? limit during model-switch confirm? limit during checkpoint creation itself?); the forecast engine's failure modes (§13); anything in §13/§14 that cannot actually be tested deterministically as §19 claims. Also audit the reasoning notes: is anything single-source being treated as settled? Were rejected alternatives (notes §2) dismissed too fast — especially best-surface-per-harness transport and headless-JSON-everywhere?

## Task 4 — Scope check
Is P1–P5 realistically ordered? Is the MVP too fat (flagship + supervision + context economics)? Name what you would CUT first if forced, and the one thing under-invested in.

## Output (required)
Write your complete review to `docs/reviews/codex-sol-review.md` (create the directory) with:
1. Verdict per debate item (a)–(g) and D1–D7 where you have a view.
2. Ranked flaw list: severity (high/med/low), section reference, concrete failure scenario, suggested fix.
3. Rev 1 defenses: where Rev 2 should revert or amend.
4. Final go/no-go with explicit conditions.
Dense plain prose. No praise padding.
