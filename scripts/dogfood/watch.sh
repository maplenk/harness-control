#!/usr/bin/env bash
# Live-monitor a harness run's event log; print decision events, stop at a terminal.
#
# Usage:  bash scripts/dogfood/watch.sh [run_id]
#   default run_id = the re-verify run (run_8aa51aea).
# Ctrl-C to stop early. Heartbeats + turn.started are filtered out.
#
# This is the ONLY side-effect-free way to watch a run: it opens the SQLite file
# read-only and appends nothing. Going through the CLI does not have that
# property — every run-scoped invocation, INCLUDING plain `status`, delivers
# pending alerts and appends `alert.delivered` to the durable log
# (`src/cli/commands.ts:201` → `service.ts:1658`), so `monitor.sh` mutates the run
# it is watching. Prefer this script for idle watching.
#
# EVERY sqlite3 invocation below passes -readonly. That is load-bearing, not
# stylistic: the run id is interpolated into SQL, so a read-write connection
# would let a crafted argument execute write statements. The id is also shape-
# validated before it reaches SQL.
set -uo pipefail

RUN="${1:-run_8aa51aea-2bf0-4906-afba-7f0bdc8ba7e3}"
if ! [[ "$RUN" =~ ^run_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
  echo "refusing '$RUN': expected a run id of the form run_<uuid>" >&2
  exit 2
fi
DB="${HARNESS_HOME:-$HOME/.harness}/harness.db"
[ -f "$DB" ] || { echo "no harness.db at $DB"; exit 1; }

last=$(sqlite3 -readonly -noheader "$DB" "SELECT COALESCE(MAX(sequence),0) FROM events WHERE run_id='$RUN';" 2>/dev/null || echo 0)
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
