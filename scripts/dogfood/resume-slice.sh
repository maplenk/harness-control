#!/usr/bin/env bash
#
# Dogfood RESUME / RECHECK / BUDGET-RAISE — the gated way to re-enter a live run.
#
# WHY THIS EXISTS: `resume`, `recheck` and `set-budget --resume` all SPEND (they
# drive provider turns) and all MUTATE a run, exactly like `run` does. Before
# this script they were documented as raw `node dist/cli/index.js …` one-liners,
# so the most common recovery paths — the ones an operator reaches for when a run
# is already in trouble — bypassed the L11 gate entirely: no freshness, no dist
# digest, no claim, no containment. Every CLI call that drives a run goes through
# require-preflight first.
#
# Usage:
#   scripts/dogfood/resume-slice.sh RUN_ID                     resume (waits)
#   scripts/dogfood/resume-slice.sh RUN_ID recheck             §16 re-check
#   scripts/dogfood/resume-slice.sh RUN_ID budget ROLE MB      audited RSS raise
#                                                              then resume
# Exit: the CLI exit code (0 terminal · 3 limit pause · 4 integration_blocked).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
. "$ROOT/scripts/dogfood/lib.sh"

: "${HARNESS_HOME:=$HOME/.harness}"; export HARNESS_HOME
LOGDIR="${DOGFOOD_LOG_DIR:-$HARNESS_HOME/logs}"; mkdir -p "$LOGDIR"
CLI=(node "$ROOT/dist/cli/index.js")

RUN_ID="${1:?usage: resume-slice.sh RUN_ID [recheck | budget ROLE MB]}"
ACTION="${2:-resume}"

CONTAINMENT="$(dogfood_require_containment "$ROOT" "$HARNESS_HOME" "$LOGDIR")" || { echo "!! ${CONTAINMENT#!}" >&2; exit 1; }
bash "$ROOT/scripts/dogfood/require-preflight.sh" "$RUN_ID" || exit 1

STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$LOGDIR/resume-$STAMP-$ACTION.log"

case "$ACTION" in
  resume)
    echo "── RESUME $RUN_ID (waits in-process on a limit pause) ──"
    set +e
    "${CLI[@]}" resume "$RUN_ID" --wait --json 2>&1 | tee "$LOG"
    RC="${PIPESTATUS[0]}"
    set -e ;;
  recheck)
    echo "── RECHECK $RUN_ID (§16 integration re-check; no provider turn) ──"
    set +e
    "${CLI[@]}" recheck "$RUN_ID" --json 2>&1 | tee "$LOG"
    RC="${PIPESTATUS[0]}"
    set -e ;;
  budget)
    ROLE="${3:?usage: resume-slice.sh RUN_ID budget ROLE MB}"
    MB="${4:?usage: resume-slice.sh RUN_ID budget ROLE MB}"
    echo "── SET-BUDGET $RUN_ID --role $ROLE --memory-budget-mb $MB --resume ──"
    echo "   (F3: the ONE sanctioned exception to config immutability; audited, never silent)"
    set +e
    "${CLI[@]}" set-budget "$RUN_ID" --role "$ROLE" --memory-budget-mb "$MB" --resume --json 2>&1 | tee "$LOG"
    RC="${PIPESTATUS[0]}"
    set -e ;;
  *)
    echo "!! unknown action '$ACTION' (expected: resume | recheck | budget ROLE MB)" >&2
    exit 2 ;;
esac

echo
echo "── exit $RC   (log: $LOG) ──"
exit "$RC"
