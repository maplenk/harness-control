#!/usr/bin/env bash
#
# Dogfood MONITOR — tail a run's event log (the coordinator/implementor/verifier
# activity) plus its current phase/suspension/vitals. There is no `serve` daemon
# yet (Phase A), so this reads the durable SQLite store directly — read-only.
#
# Usage:
#   scripts/dogfood/monitor.sh [RUN_ID]           # live loop (Ctrl-C to stop)
#   scripts/dogfood/monitor.sh [RUN_ID] --once    # one-shot snapshot, then exit
#
# With no RUN_ID, the newest run in the store is used.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
: "${HARNESS_HOME:=$HOME/.harness}"; export HARNESS_HOME
DB="$HARNESS_HOME/harness.db"
CLI=(node "$ROOT/dist/cli/index.js")

RUN_ID=""; ONCE=0
for a in "$@"; do
  case "$a" in
    --once) ONCE=1 ;;
    *) RUN_ID="$a" ;;
  esac
done

[ -f "$DB" ] || { echo "no run store yet at $DB (start a slice first)"; exit 1; }
if [ -z "$RUN_ID" ]; then
  RUN_ID="$(sqlite3 "$DB" "SELECT run_id FROM runs ORDER BY first_seen_at DESC LIMIT 1;")"
fi
[ -n "$RUN_ID" ] || { echo "no runs in store"; exit 1; }

q_events() { # $1 = after-sequence
  sqlite3 -noheader -separator ' │ ' "$DB" \
    "SELECT printf('%4d', sequence), substr(occurred_at,12,8), printf('%-26s', type),
            replace(substr(payload_json,1,140),char(10),' ')
     FROM events WHERE run_id='$RUN_ID' AND sequence>$1 ORDER BY sequence;"
}
q_max() { sqlite3 -noheader "$DB" "SELECT COALESCE(MAX(sequence),0) FROM events WHERE run_id='$RUN_ID';"; }
show_status() {
  echo "── status $RUN_ID ──"
  "${CLI[@]}" status "$RUN_ID" --json 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);const b=o.json??o;
        console.log("  phase="+b.phase+"  suspension="+(b.suspension??"none")+"  op="+(b.operation??"idle")+"  ui="+(b.uiState??"?"));
        if(b.vitals)console.log("  vitals: "+JSON.stringify(b.vitals));
        if(b.cost)console.log("  cost: "+JSON.stringify(b.cost));
        if(b.limit)console.log("  limit: "+JSON.stringify(b.limit));
      }catch(e){console.log("  (status parse: "+e.message+")")}})' || echo "  (status unavailable)"
}

echo "monitoring run $RUN_ID   store=$HARNESS_HOME"
echo "seq │ time     │ type                       │ payload"
last=0
q_events "$last"; last="$(q_max)"
show_status

if [ "$ONCE" -eq 1 ]; then exit 0; fi

trap 'echo; echo "stopped monitoring $RUN_ID"; exit 0' INT
while true; do
  sleep 2
  rows="$(q_events "$last")"
  if [ -n "$rows" ]; then
    echo "$rows"
    last="$(q_max)"
    # reprint a compact status line whenever new events land
    "${CLI[@]}" status "$RUN_ID" --json 2>/dev/null \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const b=(JSON.parse(s).json)??JSON.parse(s);
          process.stdout.write("      → phase="+b.phase+" suspension="+(b.suspension??"none")+" op="+(b.operation??"idle")+"\n")}catch(e){}})' || true
  fi
done
