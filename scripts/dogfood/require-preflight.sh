#!/usr/bin/env bash
#
# PREFLIGHT ENFORCEMENT GATE (execution-plan law L11).
#
# `start-slice.sh` and `run-slice.sh` call this first. A preflight that nobody is
# required to run is a preflight nobody runs — and a preflight that ran an hour
# ago, against a different HEAD, a different built tree, or a different set of
# harnesses, is worse than none, because it reads as assurance.
#
# The record must be PASSING, COMPLETE, CURRENT and FRESH:
#
#   verdict  == "pass"        — "diagnostic" (SKIP_BUILD: dist not rebuilt) and
#                               "fail" are both rejected
#   every bound field present — a record missing git/node/npm/digest/roles is
#                               incomplete evidence, not permissive evidence
#   head     == current HEAD  — same source tree
#   distDigest == current     — same EXECUTABLE tree. HEAD does not cover this:
#                               dist/ is gitignored and mutable, so patching it
#                               after a passing preflight leaves every other
#                               field matching while the slice runs other bytes
#   git/node/npm == current   — the toolchain has not moved underneath it
#   roles + configSha        — the battery gated doctor on the harnesses THIS
#                               invocation will dispatch; if the caller's
#                               COORDINATOR/IMPLEMENTOR/VERIFIER/CONFIG differ
#                               from the ones preflight bound, it proved nothing
#                               about this run
#   age      <  30 minutes    — hardcoded, deliberately not env-overridable
#
# It reads the LAST record in the log, not the last PASSING one: if a failing
# preflight ran after a passing one, the failure is the current truth.
#
# Usage:  bash scripts/dogfood/require-preflight.sh
# Exit:   0 = cleared to start · 1 = refused (reason printed)
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
[ -n "${ROOT:-}" ] && cd "$ROOT" || { echo "!! cannot resolve/enter repo root" >&2; exit 1; }
. "$ROOT/scripts/dogfood/lib.sh" || { echo "!! cannot source scripts/dogfood/lib.sh" >&2; exit 1; }

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
{ [ -n "$GIT_V" ] && [ -n "$NODE_V" ] && [ -n "$NPM_V" ]; } || refuse "cannot read the current git/node/npm versions"

# Re-resolve, with the SAME logic preflight used, what this invocation would run.
dogfood_resolve_roles
dogfood_resolve_config "$ROOT"
CONFIG_SHA="$(dogfood_config_sha "${CONFIG:-}")"
DIST_DIGEST="$(dogfood_dist_digest "$ROOT")"
[ -n "$DIST_DIGEST" ] || refuse "dist/ is missing or empty — nothing to run (build, then preflight)"

REASON="$(node - "$RECORD" "$HEAD_SHA" "$GIT_V" "$NODE_V" "$NPM_V" "$MAX_AGE_MIN" \
  "$DIST_DIGEST" "$COORDINATOR" "$IMPLEMENTOR" "$VERIFIER" "$CONFIG_SHA" <<'NODE'
const fs = require('node:fs');
const [record, head, git, node, npm, maxAgeMin, distDigest, coordinator, implementor, verifier, configSha] =
  process.argv.slice(2);

let lines;
try {
  lines = fs.readFileSync(record, 'utf8').split('\n').filter((l) => l.trim().length > 0);
} catch (e) { process.stdout.write(`cannot read the record: ${e.message}`); process.exit(0); }
if (lines.length === 0) { process.stdout.write('the preflight record is empty'); process.exit(0); }

let r;
try { r = JSON.parse(lines[lines.length - 1]); }
catch (e) { process.stdout.write(`the most recent record is not valid JSON: ${e.message}`); process.exit(0); }
if (r === null || typeof r !== 'object' || Array.isArray(r)) {
  process.stdout.write('the most recent record is not a JSON object'); process.exit(0);
}

// FAIL CLOSED ON INCOMPLETE RECORDS. Comparing a field only "if it is defined"
// means a record that OMITS the field passes the comparison — so an old-format
// or hand-edited record could authorise a run precisely because it says less.
// Every bound field must be present and non-empty.
const REQUIRED = ['at', 'verdict', 'git', 'node', 'npm', 'head',
  'distDigest', 'coordinator', 'implementor', 'verifier', 'configSha'];
const missing = REQUIRED.filter((k) => typeof r[k] !== 'string' || r[k].length === 0);
if (missing.length > 0) {
  process.stdout.write(`the record is incomplete — missing/invalid: ${missing.join(', ')} (regenerate it; the format changed)`);
  process.exit(0);
}
if (typeof r.skipBuild !== 'boolean') {
  process.stdout.write('the record is incomplete — missing/invalid: skipBuild');
  process.exit(0);
}

if (r.verdict !== 'pass') {
  process.stdout.write(
    r.verdict === 'diagnostic'
      ? 'the most recent preflight was a DIAGNOSTIC run (SKIP_BUILD=1 — dist was not rebuilt, so the staging drill proved a stale binary)'
      : `the most recent preflight verdict is "${r.verdict}" (${r.failures ?? '?'} failures)`,
  );
  process.exit(0);
}
if (r.skipBuild === true) { process.stdout.write('the most recent preflight skipped the build'); process.exit(0); }
if (r.head !== head) {
  process.stdout.write(`the preflight ran against HEAD ${String(r.head).slice(0, 12)} but the tree is now at ${head.slice(0, 12)}`);
  process.exit(0);
}
if (r.distDigest !== distDigest) {
  process.stdout.write(
    `dist/ CHANGED since the preflight (recorded ${String(r.distDigest).slice(0, 12)}…, now ${distDigest.slice(0, 12)}…) — ` +
    'the staging drill proved a build that is no longer on disk',
  );
  process.exit(0);
}
for (const [name, seen, was] of [['git', git, r.git], ['node', node, r.node], ['npm', npm, r.npm]]) {
  if (was !== seen) { process.stdout.write(`${name} changed since the preflight (${was} → ${seen})`); process.exit(0); }
}
for (const [name, seen, was] of [
  ['coordinator', coordinator, r.coordinator],
  ['implementor', implementor, r.implementor],
  ['verifier', verifier, r.verifier],
]) {
  if (was !== seen) {
    process.stdout.write(`the ${name} role differs from the one preflight gated (${was} → ${seen}) — doctor never checked that harness`);
    process.exit(0);
  }
}
if (r.configSha !== configSha) {
  process.stdout.write(`the engine config differs from the one preflight used (${String(r.configSha).slice(0, 12)}… → ${configSha.slice(0, 12)}…)`);
  process.exit(0);
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
    echo "✔ preflight gate: passing record ${AGE}m old at ${HEAD_SHA:0:12}, dist ${DIST_DIGEST:0:12}… (${FILES} test files discovered)"
    exit 0 ;;
  *)
    refuse "${REASON:-unknown reason}" ;;
esac
