#!/usr/bin/env bash
#
# Dogfood APPROVE + RUN stage (§6A) — bind the EXACT drafted spec hash (T1),
# then drive implement → verify → (bounded remediation) → merge-readiness. The
# implementor works in an isolated worktree; the verifier is read-only on the
# implementor's exact commit. Ends at `merge_ready` (hand off to the human to
# merge) or a suspension/blocked state.
#
# WHO SIGNS is decided by the run, not by this script (B2). The approval mode is
# pinned into the run's config at `start` and is immutable for the run's life,
# so this reads the ENGINE's state and acts on it:
#
#   awaiting_approval               → run `harness approve` (the human gate).
#   approved, already bound to THIS
#     spec hash                     → SKIP approve; report who signed it.
#   approved, bound to a DIFFERENT
#     hash                          → REFUSE. Something is not the run we think.
#   anything else                   → REFUSE.
#
# Why a branch and not an unconditional `approve`: T1 is illegal from
# `approved`, so on an `approval:'auto'` run the old unconditional call exited
# non-zero and `set -euo pipefail` aborted the whole stage before `run` — the
# unattended path could not get past its own approve step. The branch is on the
# run's OWN phase + bound hash, never on "which config file did we pass",
# because the config a later process happens to hold has no authority over a
# mode that was pinned at createRun.
#
# This script NEVER manufactures an approval: it only forwards the hash the
# caller was given, and refuses when the engine's bound hash disagrees.
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

RUN_ID="${1:?usage: run-slice.sh RUN_ID SPEC_VERSION SPEC_HASH}"
SPEC_VERSION="${2:?spec version id required}"
SPEC_HASH="${3:?spec hash required (binds the exact drafted spec)}"
IMPLEMENTOR="${IMPLEMENTOR:-grok:grok-build:high}"
VERIFIER="${VERIFIER:-codex:gpt-5.6-sol:xhigh}"

STAMP="$(date +%Y%m%d-%H%M%S)"
APPROVE_JSON="$LOGDIR/slice-$STAMP-approve.json"
RUN_LOG="$LOGDIR/slice-$STAMP-run.log"
STATUS_JSON="$LOGDIR/slice-$STAMP-status.json"
PRE_JSON="$LOGDIR/slice-$STAMP-prestatus.json"

# ---- APPROVAL GATE: read the run's OWN state, then act on it ----------------
# `status --json` is not free (it delivers pending alerts and appends
# `alert.delivered`) — that cost is accepted here because the decision must come
# from the engine, and a wrong decision costs a whole slice.
"${CLI[@]}" status "$RUN_ID" --json >"$PRE_JSON"
# One line, three space-separated fields. Every field has an explicit sentinel
# for "the engine did not report this", so a missing key can never be read as a
# value: an absent phase is '?', an absent bound hash is '-', and an absent
# signer is 'unknown' — which this script REFUSES on rather than assuming.
PRE_FIELDS="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=(JSON.parse(s).json)??JSON.parse(s);
  process.stdout.write([b.phase??"?", b.approvedSpecHash??"-", b.specApprovedBy??"unknown"].join(" ")+"\n");})' <"$PRE_JSON")"
PHASE="${PRE_FIELDS%% *}"
PRE_REST="${PRE_FIELDS#* }"
BOUND_HASH="${PRE_REST%% *}"
SIGNER="${PRE_REST##* }"

case "$PHASE" in
  awaiting_approval)
    echo "── APPROVE $RUN_ID @ $SPEC_HASH  (human gate: approval='human') ──"
    "${CLI[@]}" approve "$RUN_ID" --spec-version "$SPEC_VERSION" --spec-hash "$SPEC_HASH" --json \
      | tee "$APPROVE_JSON"
    ;;
  approved)
    if [ "$BOUND_HASH" != "$SPEC_HASH" ]; then
      echo "!! refusing: run $RUN_ID is already approved, but bound to spec hash" >&2
      echo "     $BOUND_HASH" >&2
      echo "   while this invocation names" >&2
      echo "     $SPEC_HASH" >&2
      echo "   The engine implements the hash it BOUND. Re-read the start manifest," >&2
      echo "   or cancel and re-start; never run a spec you did not intend." >&2
      exit 2
    fi
    echo "── APPROVE skipped — run $RUN_ID is ALREADY approved and bound to this exact spec ──"
    echo "   signer: $SIGNER"
    if [ "$SIGNER" = "auto" ]; then
      echo "   ⚠ AUTO-APPROVED: the ENGINE signed this spec (approval='auto', pinned at start)."
      echo "     NO human reviewed the intent. The merge-readiness report repeats this."
    elif [ "$SIGNER" = "unknown" ]; then
      # Absence is not 'human' — the engine refuses to run such a spec, and so
      # does this script rather than presenting an unattributable approval.
      echo "!! refusing: run $RUN_ID records NO approval signer the event log can" >&2
      echo "   substantiate. Do NOT assume a human approved it (the engine refuses" >&2
      echo "   this state too). Investigate the run's spec.approved events." >&2
      exit 2
    fi
    ;;
  *)
    echo "!! refusing: run $RUN_ID is at phase '$PHASE' — approve/run is legal only from" >&2
    echo "   'awaiting_approval' (human gate) or 'approved' (already signed)." >&2
    exit 2
    ;;
esac

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
