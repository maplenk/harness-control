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

# Optional: the run this gate is guarding. Given one, the config identity is
# taken from the run's PERSISTED config rather than the ambient env — see below.
RUN_ID="${1:-}"

: "${HARNESS_HOME:=$HOME/.harness}"
LOGDIR="${DOGFOOD_LOG_DIR:-$HARNESS_HOME/logs}"
RECORD="$LOGDIR/preflight.jsonl"
CLAIM="$(dogfood_claim_path "$HARNESS_HOME")"
ATTEMPTS="$(dogfood_attempts_path "$HARNESS_HOME")"
MAX_AGE_MIN=30

refuse() {
  echo "!! PREFLIGHT GATE: $1" >&2
  echo "!! run: bash scripts/dogfood/preflight.sh" >&2
  exit 1
}

# Containment is re-checked HERE, not just in preflight: a perfectly valid record
# written with an external log dir could otherwise be reused while HARNESS_HOME
# is repointed into the repo, and the CLI would then write harness.db and
# artifacts inside the repository.
CONTAINMENT="$(dogfood_require_containment "$ROOT" "$HARNESS_HOME" "$LOGDIR")" || refuse "${CONTAINMENT#!}"

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
DIST_DIGEST="$(dogfood_dist_digest "$ROOT")"
case "${DIST_DIGEST:-}" in
  '')   refuse "cannot digest dist/ — nothing to run (build, then preflight)" ;;
  '!'*) refuse "dist/ cannot be bound: ${DIST_DIGEST#!}" ;;
esac

# CONFIG IDENTITY. At `start` the ambient $CONFIG is what gets pinned, so the
# effective config is the right comparison. At `run` the CLI IGNORES $CONFIG and
# loads the config persisted at `start` — so hashing the caller's env there would
# authorise a run whose actual config differs (a run created with CONFIG="" being
# blessed by a preflight that used the dogfood config). With a RUN_ID we
# therefore bind the run's persisted config instead.
if [ -n "$RUN_ID" ]; then
  CONFIG_IDENTITY="$(dogfood_run_config_sha "$ROOT" "$HARNESS_HOME" "$RUN_ID")"
  CONFIG_SOURCE="run $RUN_ID (persisted at start)"
else
  CONFIG_IDENTITY="$(dogfood_effective_config_sha "$ROOT" "${CONFIG:-}")"
  CONFIG_SOURCE="the resolved CONFIG for a fresh start"
fi
case "${CONFIG_IDENTITY:-}" in
  ''|'!'*) refuse "cannot determine the engine config for ${CONFIG_SOURCE}: ${CONFIG_IDENTITY#!}" ;;
esac

# The attempt claim: a durable marker in a DIFFERENT failure domain from the log.
# Reading it closes the fail-open tail where an immutable log dir let a stale PASS
# outlive the failing preflight that should have replaced it. Writing to it is
# mandatory too — a gate that cannot record its own attempt cannot claim the
# store is in a state it understands.
[ -f "$CLAIM" ] || refuse "no attempt claim at $CLAIM — the preflight that wrote this record predates the claim, or could not write it"
if ! printf '%s\tgate\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$HEAD_SHA" "${RUN_ID:-<start>}" >> "$ATTEMPTS" 2>/dev/null; then
  refuse "cannot write the gate attempt marker at $ATTEMPTS — refusing rather than proceeding on a store I cannot write"
fi

HARNESS_HOME_CANON="$(dogfood_canonical_path "$HARNESS_HOME")"
LOGDIR_CANON="$(dogfood_canonical_path "$LOGDIR")"

# EDITING THE HEREDOC BELOW: keep single quotes BALANCED on every line — no
# apostrophes in prose ("the record" not "the record's"). macOS ships bash
# 3.2.57, whose parser mis-scans a heredoc nested inside $( ) when the body has
# an odd number of single quotes, and fails with "unexpected EOF while looking
# for matching" pointing at a line far below the real cause.

REASON="$(node - "$RECORD" "$HEAD_SHA" "$GIT_V" "$NODE_V" "$NPM_V" "$MAX_AGE_MIN" \
  "$DIST_DIGEST" "$COORDINATOR" "$IMPLEMENTOR" "$VERIFIER" "$CONFIG_IDENTITY" \
  "$CLAIM" "$HARNESS_HOME_CANON" "$LOGDIR_CANON" "$CONFIG_SOURCE" <<'NODE'
const fs = require('node:fs');
const [record, head, git, node, npm, maxAgeMin, distDigest, coordinator, implementor, verifier, configSha,
  claimPath, harnessHome, logDir, configSource] = process.argv.slice(2);

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
const REQUIRED = ['at', 'attemptId', 'verdict', 'git', 'node', 'npm', 'head',
  'distDigest', 'coordinator', 'implementor', 'verifier', 'configSha', 'harnessHome', 'logDir'];
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
  process.stdout.write(
    `the engine config differs from the one preflight gated: recorded ${String(r.configSha).slice(0, 12)}…, ` +
    `but ${configSource} is ${configSha.slice(0, 12)}…`,
  );
  process.exit(0);
}
if (r.harnessHome !== harnessHome) {
  process.stdout.write(`the store moved since the preflight (${r.harnessHome} → ${harnessHome})`);
  process.exit(0);
}
if (r.logDir !== logDir) {
  process.stdout.write(`the log dir moved since the preflight (${r.logDir} → ${logDir})`);
  process.exit(0);
}

// The claim must name the attempt THIS record came from. That is what survives
// an immutable log: a failing preflight rewrites the claim even when it cannot
// touch the record, so a stale PASS is left orphaned rather than authoritative.
// (Apostrophes are banned in this heredoc — see the note above the block.)
let claim;
try { claim = JSON.parse(fs.readFileSync(claimPath, 'utf8')); }
catch (e) { process.stdout.write(`the attempt claim is unreadable (${e.message})`); process.exit(0); }
if (claim === null || typeof claim !== 'object' || Array.isArray(claim)) {
  process.stdout.write('the attempt claim is not a JSON object'); process.exit(0);
}
for (const k of ['attemptId', 'verdict', 'head', 'distDigest']) {
  if (typeof claim[k] !== 'string' || claim[k].length === 0) {
    process.stdout.write(`the attempt claim is incomplete — missing/invalid: ${k}`); process.exit(0);
  }
}
if (claim.attemptId !== r.attemptId) {
  process.stdout.write(
    `the record is ORPHANED: the latest preflight attempt is ${claim.attemptId.slice(0, 8)} ` +
    `(verdict "${claim.verdict}") but this record is from attempt ${String(r.attemptId).slice(0, 8)} — ` +
    'a later preflight ran and could not replace the record',
  );
  process.exit(0);
}
if (claim.verdict !== 'pass') {
  process.stdout.write(`the latest preflight attempt recorded verdict "${claim.verdict}" in its claim`);
  process.exit(0);
}
if (claim.head !== r.head || claim.distDigest !== r.distDigest) {
  process.stdout.write('the attempt claim and the record disagree about HEAD/dist — the pair cannot be trusted');
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
