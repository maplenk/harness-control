#!/usr/bin/env bash
# Live-monitor a harness run's event log; print decision events, stop at a terminal.
#
# Usage:  bash scripts/dogfood/watch.sh [run_id]
#   default run_id = the re-verify run (run_8aa51aea).
# Ctrl-C to stop early. Heartbeats + turn.started are filtered out.
set -uo pipefail

RUN="${1:-run_8aa51aea-2bf0-4906-afba-7f0bdc8ba7e3}"
DB="${HARNESS_HOME:-$HOME/.harness}/harness.db"
[ -f "$DB" ] || { echo "no harness.db at $DB"; exit 1; }

last=$(sqlite3 -noheader "$DB" "SELECT COALESCE(MAX(sequence),0) FROM events WHERE run_id='$RUN';" 2>/dev/null || echo 0)
echo "watching $RUN from seq $last  (Ctrl-C to stop)"
echo "seq | type                       | payload"

# Terminal markers: success, fail-closed, exhaustion, integration block, run end.
TERM_RE="merge_ready|provisioning_failed|no_deliverable|resource_exhaust|paused_limit|breaker_open|integration_blocked|run\.(failed|completed|settled)"

while true; do
  rows=$(sqlite3 -readonly -noheader -separator ' | ' "$DB" \
    "SELECT printf('%3d',sequence), printf('%-26s',type), substr(replace(replace(payload_json,char(10),' '),char(9),' '),1,120) \
     FROM events WHERE run_id='$RUN' AND sequence>$last \
       AND type NOT LIKE '%heartbeat%' AND type NOT LIKE '%sample%' AND type NOT IN ('turn.started') \
     ORDER BY sequence;" 2>/dev/null || true)
  mx=$(sqlite3 -readonly -noheader "$DB" "SELECT COALESCE(MAX(sequence),0) FROM events WHERE run_id='$RUN';" 2>/dev/null || echo "$last")
  [ -n "$mx" ] && [ "$mx" -gt "$last" ] 2>/dev/null && last=$mx
  [ -n "$rows" ] && echo "$rows"
  if [ -n "$rows" ] && echo "$rows" | grep -Eiq "$TERM_RE"; then
    echo "----------------------------------------------------------------------"
    echo ">>> TERMINAL/DECISION reached (see above). merge_ready = F7 works + ef952b1 verified."
    break
  fi
  sleep 5
done
