#!/usr/bin/env bash
#
# PREFLIGHT ENFORCEMENT GATE (execution-plan law L11).
#
# `start-slice.sh` and `run-slice.sh` call this first. A preflight that nobody is
# required to run is a preflight nobody runs — and worse, a preflight that ran
# an hour ago against a different HEAD is a false assurance. This gate demands a
# record that is PASSING, CURRENT, and FRESH:
#
#   verdict  == "pass"        — "diagnostic" (SKIP_BUILD: dist not rebuilt) and
#                               "fail" are both rejected
#   head     == current HEAD  — the battery drilled the binary built from THIS tree
#   git/node/npm == current   — the toolchain has not changed underneath it
#   age      <  30 minutes    — recent enough that the machine is still the machine
#
# It reads the LAST record in the log, not the last PASSING one: if a failing
# preflight ran after a passing one, the failure is the current truth.
#
# Usage:  bash scripts/dogfood/require-preflight.sh
# Exit:   0 = cleared to start · 1 = refused (reason printed)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
[ -n "${ROOT:-}" ] && cd "$ROOT" || { echo "!! cannot resolve/enter repo root" >&2; exit 1; }

: "${HARNESS_HOME:=$HOME/.harness}"
LOGDIR="${DOGFOOD_LOG_DIR:-$HARNESS_HOME/logs}"
RECORD="$LOGDIR/preflight.jsonl"
MAX_AGE_MIN=30

refuse() {
  echo "!! PREFLIGHT GATE: $1" >&2
  echo "!! run: bash scripts/dogfood/preflight.sh" >&2
  exit 1
}

[ -f "$RECORD" ] || refuse "no preflight record at $RECORD"

HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"
[ -n "$HEAD_SHA" ] || refuse "cannot resolve HEAD"
GIT_V="$(git --version 2>/dev/null | awk '{print $3}')"
NODE_V="$(node --version 2>/dev/null)"
NPM_V="$(npm --version 2>/dev/null)"

REASON="$(node - "$RECORD" "$HEAD_SHA" "$GIT_V" "$NODE_V" "$NPM_V" "$MAX_AGE_MIN" <<'NODE'
const fs = require('node:fs');
const [record, head, git, node, npm, maxAgeMin] = process.argv.slice(2);
let lines;
try {
  lines = fs.readFileSync(record, 'utf8').split('\n').filter((l) => l.trim().length > 0);
} catch (e) { process.stdout.write(`cannot read the record: ${e.message}`); process.exit(0); }
if (lines.length === 0) { process.stdout.write('the preflight record is empty'); process.exit(0); }

let r;
try { r = JSON.parse(lines[lines.length - 1]); }
catch (e) { process.stdout.write(`the most recent record is not valid JSON: ${e.message}`); process.exit(0); }

if (r.verdict !== 'pass') {
  process.stdout.write(
    r.verdict === 'diagnostic'
      ? 'the most recent preflight was a DIAGNOSTIC run (SKIP_BUILD=1 — dist was not rebuilt, so the staging drill proved a stale binary)'
      : `the most recent preflight verdict is "${r.verdict ?? 'unknown'}" (${r.failures ?? '?'} failures)`,
  );
  process.exit(0);
}
if (r.skipBuild === true) { process.stdout.write('the most recent preflight skipped the build'); process.exit(0); }
if (r.head !== head) {
  process.stdout.write(`the preflight ran against HEAD ${String(r.head).slice(0, 12)} but the tree is now at ${head.slice(0, 12)}`);
  process.exit(0);
}
for (const [name, seen, was] of [['git', git, r.git], ['node', node, r.node], ['npm', npm, r.npm]]) {
  if (was !== undefined && was !== seen) {
    process.stdout.write(`${name} changed since the preflight (${was} → ${seen})`);
    process.exit(0);
  }
}
const at = Date.parse(r.at);
if (Number.isNaN(at)) { process.stdout.write(`the record has an unparseable timestamp "${r.at}"`); process.exit(0); }
const ageMin = (Date.now() - at) / 60000;
if (ageMin > Number(maxAgeMin)) {
  process.stdout.write(`the preflight is ${Math.round(ageMin)} minutes old (max ${maxAgeMin})`);
  process.exit(0);
}
if (ageMin < -5) { process.stdout.write(`the record is timestamped ${Math.round(-ageMin)} minutes in the future — clock skew`); process.exit(0); }
process.stdout.write(`OK\t${Math.round(ageMin)}\t${r.collectedTestFiles ?? '?'}`);
NODE
)"
NODE_RC=$?
[ "$NODE_RC" -eq 0 ] || refuse "could not evaluate the preflight record (node exited $NODE_RC)"

case "$REASON" in
  OK*)
    AGE="$(printf '%s' "$REASON" | awk -F'\t' '{print $2}')"
    FILES="$(printf '%s' "$REASON" | awk -F'\t' '{print $3}')"
    echo "✔ preflight gate: passing record ${AGE}m old at ${HEAD_SHA:0:12} (${FILES} test files discovered)"
    exit 0 ;;
  *)
    refuse "${REASON:-unknown reason}" ;;
esac
