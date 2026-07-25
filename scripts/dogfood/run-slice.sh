#!/usr/bin/env bash
#
# Dogfood APPROVE + RUN stage (§6A) — bind the EXACT drafted spec hash (T1
# human approval), then drive implement → verify → (bounded remediation) →
# merge-readiness. The implementor works in an isolated worktree; the verifier
# is read-only on the implementor's exact commit. Ends at `merge_ready` (hand
# off to the human to merge) or a suspension/blocked state.
#
# Usage:
#   scripts/dogfood/run-slice.sh RUN_ID SPEC_VERSION SPEC_HASH
#
# Parameters (env-overridable):
#   IMPLEMENTOR  default grok:grok-build:high          (xAI/Grok Build)
#   VERIFIER     default codex:gpt-5.6-sol:xhigh       (OpenAI/Codex, read-only)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
: "${HARNESS_HOME:=$HOME/.harness}"; export HARNESS_HOME
LOGDIR="${DOGFOOD_LOG_DIR:-$HARNESS_HOME/logs}"; mkdir -p "$LOGDIR"
CLI=(node "$ROOT/dist/cli/index.js")

# L11 ENFORCEMENT: approve+run is where the real money and the real worktree
# commits happen — refuse without a fresh PASSING preflight (verdict=pass, same
# HEAD, same toolchain, <30 min old). "diagnostic" records (SKIP_BUILD=1) are
# rejected too: the staging drill must have run against the CURRENT dist.
bash "$ROOT/scripts/dogfood/require-preflight.sh" || exit 1

RUN_ID="${1:?usage: run-slice.sh RUN_ID SPEC_VERSION SPEC_HASH}"
SPEC_VERSION="${2:?spec version id required}"
SPEC_HASH="${3:?spec hash required (binds the exact drafted spec)}"
IMPLEMENTOR="${IMPLEMENTOR:-grok:grok-build:high}"
VERIFIER="${VERIFIER:-codex:gpt-5.6-sol:xhigh}"

STAMP="$(date +%Y%m%d-%H%M%S)"
APPROVE_JSON="$LOGDIR/slice-$STAMP-approve.json"
RUN_LOG="$LOGDIR/slice-$STAMP-run.log"
STATUS_JSON="$LOGDIR/slice-$STAMP-status.json"

echo "── APPROVE $RUN_ID @ $SPEC_HASH ──"
"${CLI[@]}" approve "$RUN_ID" --spec-version "$SPEC_VERSION" --spec-hash "$SPEC_HASH" --json \
  | tee "$APPROVE_JSON"

echo
echo "── RUN (implement → verify → merge-readiness) ──"
echo " implementor : $IMPLEMENTOR"
echo " verifier    : $VERIFIER"
echo " run log     : $RUN_LOG"
echo "  (default limit-pause policy WAITS in-process; monitor in a second shell:"
echo "   scripts/dogfood/monitor.sh $RUN_ID )"
set +e
"${CLI[@]}" run "$RUN_ID" --implementor "$IMPLEMENTOR" --verifier "$VERIFIER" --json \
  2>&1 | tee "$RUN_LOG"
RC="${PIPESTATUS[0]}"
set -e

echo
echo "── final status (exit $RC) ──"
"${CLI[@]}" status "$RUN_ID" --json | tee "$STATUS_JSON" >/dev/null
node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=(JSON.parse(s).json)??JSON.parse(s);
  console.log("  phase="+b.phase+"  suspension="+(b.suspension??"none")+"  ui="+(b.uiState??"?"));
  })' < "$STATUS_JSON" || cat "$STATUS_JSON"

echo
case "$RC" in
  0) echo "✔ reached a terminal/hand-off state — if merge_ready, MERGE GATE next:";
     echo "   1) human merges the verified commit  2) npm test && npm run typecheck  3) npm run build  4) clean tree  5) record new base SHA";;
  3) echo "‖ paused on a provider usage limit (--no-wait semantics). Resume with:";
     echo "   node dist/cli/index.js resume $RUN_ID --wait";;
  4) echo "▲ integration_blocked — resolve §16 blockers then: node dist/cli/index.js recheck $RUN_ID";;
  *) echo "✗ run exited $RC — inspect $RUN_LOG and status above.";;
esac
exit "$RC"
