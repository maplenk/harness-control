#!/usr/bin/env bash
#
# Dogfood UNATTENDED slice (B2) — start → implement → verify → merge-readiness
# with NO human approval step.
#
# This is `start-slice.sh` + `run-slice.sh` composed under an engine config
# pinned to `approval:'auto'`. It approves nothing itself. The ENGINE signs the
# drafted spec hash inside the same transaction that persists the draft, and
# this script only proceeds once it has read that back out of the engine.
#
# Usage:
#   SECTION="§3A.1" SLICE="…" PATHS="…" scripts/dogfood/auto-slice.sh
#
# Parameters (env-overridable; SECTION/SLICE/PATHS pass through to start-slice.sh):
#   CONFIG       engine config file. DEFAULT: scripts/dogfood/dogfood.auto.config.json
#   IMPLEMENTOR  default grok:grok-build:high        (xAI/Grok Build)
#   VERIFIER     default codex:gpt-5.6-sol:xhigh     (OpenAI/Codex, read-only)
#   DRY_RUN=1    print the goal that would be sent and stop (start-slice.sh)
#
# ── WHAT AUTONOMY COSTS YOU, stated once, here ──────────────────────────────
# Under `approval:'human'` a person reads the drafted spec before any money is
# spent. Under `auto` nobody does, and TWO filters are all that stand between a
# coordinator's plan and real work:
#
#   1. `verification.allowedCommands` in CONFIG — the EXACT command strings a
#      criterion may cite. The coordinator picks WHICH of them proves a
#      criterion; it cannot invent `true` or `npm test || true`. This list is
#      the last human eye on what "proof" means for this run, so treat editing
#      it as the approval you are no longer giving. Matching is EXACT: a slice
#      whose criteria need an absence check (`test -z "$(grep -REl … || true)"`)
#      must have that exact string added to CONFIG *before* `start`.
#   2. The §7 testability gate, a lexical filter on the evidence prose. It is
#      deliberately weak and is not the guard — see (1).
#
# Known residual (report, not a promise): the allowlist pins the command TEXT,
# while F15's `expectedExitCode` is chosen by the COORDINATOR. A criterion may
# therefore cite an allowed command and declare that a NON-ZERO exit proves it —
# e.g. `{ "command": "npx vitest run", "expectedExitCode": 1 }` is a criterion
# satisfied by the suite FAILING. Read the drafted criteria in the run log
# before the merge gate; the merge gate is still human.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
cd "$ROOT"

: "${HARNESS_HOME:=$HOME/.harness}"; export HARNESS_HOME
LOGDIR="${DOGFOOD_LOG_DIR:-$HARNESS_HOME/logs}"; mkdir -p "$LOGDIR"

CONFIG="${CONFIG:-$ROOT/scripts/dogfood/dogfood.auto.config.json}"
[ -f "$CONFIG" ] || { echo "!! CONFIG is not a readable file: $CONFIG" >&2; exit 2; }

STAMP="$(date +%Y%m%d-%H%M%S)"
MANIFEST="$LOGDIR/auto-slice-$STAMP.manifest.json"

echo "── dogfood UNATTENDED slice ───────────────────────────────────"
echo " config   : $CONFIG"
echo " manifest : $MANIFEST"
echo " NOTE: no human approval step. The engine signs the drafted spec."
echo "───────────────────────────────────────────────────────────────"
echo

# STAGE 1 — coordinator drafts; the engine signs (or does not).
CONFIG="$CONFIG" MANIFEST_OUT="$MANIFEST" "$HERE/start-slice.sh"

if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "── DRY_RUN=1 — nothing spawned, nothing to run ──"
  exit 0
fi

# STAGE 2 — proceed ONLY on what the ENGINE reported. `autoApproved` is derived
# in start-slice.sh from the engine's own `start --json` (`approval.mode ==
# 'auto'` AND `phase == 'approved'`), never from the config we passed: a config
# file is an intention, and only the run's pinned mode is authority.
read -r AUTO_OK RUN_ID SPEC_VERSION SPEC_HASH PHASE <<EOF
$(node -e 'const m=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
  process.stdout.write([m.autoApproved?"yes":"no", m.runId??"-", m.specVersionId??"-", m.specHash??"-", m.phase??"?"].join(" ")+"\n");' "$MANIFEST")
EOF

if [ "$AUTO_OK" != "yes" ]; then
  echo
  echo "!! run $RUN_ID did NOT auto-approve — it is at phase '$PHASE'." >&2
  echo "   This script does not approve anything. Either the config was not" >&2
  echo "   pinned to approval='auto' at start, or the engine refused to sign." >&2
  echo "   Check:  node dist/cli/index.js status $RUN_ID --json | grep -i approv" >&2
  echo "   To finish this run WITH a human signature:" >&2
  echo "     scripts/dogfood/run-slice.sh $RUN_ID $SPEC_VERSION $SPEC_HASH" >&2
  exit 2
fi

echo
echo "── engine-signed: run $RUN_ID at '$PHASE' — driving implement → verify ──"
echo

# STAGE 3 — run-slice.sh re-reads the run's state and skips the approve step on
# its own (it is the one place that decides), so this stays a plain hand-off.
exec "$HERE/run-slice.sh" "$RUN_ID" "$SPEC_VERSION" "$SPEC_HASH"
