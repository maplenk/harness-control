#!/usr/bin/env bash
#
# SELFTEST for the preflight battery and the lib primitives it depends on.
#
# SCOPE: exactly what ships on this branch. It does NOT synthesize provenance
# records and assert on them — the automated enforcement gate those fixtures
# existed for is deferred to the `gate-enforcement` branch, and a suite that
# mostly exercises its own fixtures is theatre. What is left is small and honest:
# the digest and containment primitives, the wrappers' refusal ordering, and ONE
# real end-to-end `preflight.sh` run proving its staging drill actually fires.
#
# Usage:  npm run test:preflight
#     or  bash scripts/dogfood/preflight-selftest.sh
#     env: KEEP=1   leave the scratch dir behind for inspection
#
# Requires a built dist/ (`npm run build`) — section D runs the real battery,
# whose staging drill loads the built helper out of dist/.
#
# Costs nothing: no provider calls, no network. Everything lands in a mktemp
# scratch dir OUTSIDE the repo, and the real $HARNESS_HOME is never touched —
# section D points HARNESS_HOME and DOGFOOD_LOG_DIR at the scratch, and every
# case sets both, so a custom log env in the caller cannot false-fail this.
#
# Exit: 0 = every case behaved as specified · 1 = at least one did not.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
[ -n "${ROOT:-}" ] && cd "$ROOT" || { echo "!! cannot resolve repo root" >&2; exit 1; }
. "$ROOT/scripts/dogfood/lib.sh" || { echo "!! cannot source lib.sh" >&2; exit 1; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/harness-selftest-XXXXXX")" || exit 1
cleanup() {
  if [ "${KEEP:-0}" = "1" ]; then echo "kept: $SCRATCH"; return; fi
  chmod -R u+w "$SCRATCH" 2>/dev/null
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

PASSED=0; FAILED=0
ok()  { PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAILED=$((FAILED + 1)); printf '  FAIL %s\n' "$1"; [ -n "${2:-}" ] && printf '       %s\n' "$2"; return 0; }
check() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3" "expected [$2], got [$1]"; fi; }

echo "── preflight selftest ─────────────────────────────────────────────────"
echo " repo    : $ROOT"
echo " scratch : $SCRATCH   (the real \$HARNESS_HOME is never touched)"
echo "───────────────────────────────────────────────────────────────────────"

# ── A. dist digest: every entry must be accounted for ────────────────────────
echo
echo "A. the dist digest binds what will actually execute"
DT="$SCRATCH/dtest"
mkdir -p "$DT/dist/sub" "$SCRATCH/target-a"
printf 'x\n' > "$DT/dist/sub/a.js"
printf 'A\n' > "$SCRATCH/target-a/f.js"

D1="$(dogfood_dist_digest "$DT")"
case "$D1" in
  ''|'!'*) bad "digests a plain tree" "$D1" ;;
  *)       ok  "digests a plain tree" ;;
esac

printf 'y\n' > "$DT/dist/sub/a.js"
D2="$(dogfood_dist_digest "$DT")"
if [ "$D1" != "$D2" ]; then ok "changed file content moves the digest"
else bad "changed file content moves the digest" "both were ${D1:0:16}"; fi
printf 'x\n' > "$DT/dist/sub/a.js"

mkdir -p "$DT/dist/empty-dir"
D3="$(dogfood_dist_digest "$DT")"
if [ "$D1" != "$D3" ]; then ok "an added EMPTY directory moves the digest"
else bad "an added EMPTY directory moves the digest" "an empty dir was invisible"; fi
rmdir "$DT/dist/empty-dir"

# A symlinked CHILD: node follows it at require time, so a digest that skipped it
# would stay identical while the executed bytes changed underneath.
ln -sfn "$SCRATCH/target-a" "$DT/dist/linked"
OUT="$(dogfood_dist_digest "$DT")"
case "$OUT" in
  '!'*symlink*) ok "a symlinked entry inside dist is refused" ;;
  *)            bad "a symlinked entry inside dist is refused" "got: ${OUT:0:70}" ;;
esac
rm -f "$DT/dist/linked"

# A symlinked ROOT: the same hole, one level up.
mv "$DT/dist" "$DT/dist-real"
ln -sfn "$DT/dist-real" "$DT/dist"
OUT="$(dogfood_dist_digest "$DT")"
case "$OUT" in
  '!'*symlink*) ok "a symlinked dist ROOT is refused" ;;
  *)            bad "a symlinked dist ROOT is refused" "got: ${OUT:0:70}" ;;
esac
rm -f "$DT/dist"; mv "$DT/dist-real" "$DT/dist"

rm -rf "$DT/dist"; mkdir -p "$DT/dist"
OUT="$(dogfood_dist_digest "$DT")"
case "$OUT" in
  '!'*) ok "an empty dist is refused, not silently digested" ;;
  *)    bad "an empty dist is refused" "got: ${OUT:0:70}" ;;
esac

# ── B. containment: `..` must resolve THROUGH symlinks, not around them ──────
echo
echo "B. containment resolves symlinks before .."
ln -sfn "$ROOT/scripts" "$SCRATCH/link-to-repo"
if dogfood_path_inside "$SCRATCH/link-to-repo/../docs" "$ROOT"; then
  ok "absolute symlink/.. landing in the repo is INSIDE"
else bad "absolute symlink/.. landing in the repo is INSIDE" "classified outside"; fi

if ( cd "$SCRATCH" && dogfood_path_inside "link-to-repo/../docs" "$ROOT" ); then
  ok "RELATIVE symlink/.. landing in the repo is INSIDE"
else bad "RELATIVE symlink/.. landing in the repo is INSIDE" "classified outside"; fi

if dogfood_path_inside "$SCRATCH/target-a" "$ROOT"; then
  bad "a genuinely external path is OUTSIDE" "classified inside"
else ok "a genuinely external path is OUTSIDE"; fi

if dogfood_path_inside "$ROOT/docs" "$ROOT"; then ok "a plain in-repo path is INSIDE"
else bad "a plain in-repo path is INSIDE" "classified outside"; fi

MSG="$(dogfood_require_containment "$ROOT" "$ROOT/.store" "$SCRATCH/logs")"; RC=$?
check "$RC" "1" "containment refuses a store inside the repo"
case "$MSG" in
  '!HARNESS_HOME resolves inside the repo'*) ok "…naming HARNESS_HOME as the offender" ;;
  *) bad "…naming HARNESS_HOME as the offender" "got: ${MSG:0:70}" ;;
esac
MSG="$(dogfood_require_containment "$ROOT" "$SCRATCH" "$ROOT/logs")"
case "$MSG" in
  '!the log dir resolves inside the repo'*) ok "…naming the log dir when that is the offender" ;;
  *) bad "…naming the log dir when that is the offender" "got: ${MSG:0:70}" ;;
esac
dogfood_require_containment "$ROOT" "$SCRATCH" "$SCRATCH/logs" >/dev/null; RC=$?
check "$RC" "0" "containment accepts an external store + log"

# ── C. the wrappers refuse BEFORE creating anything inside the repo ──────────
echo
echo "C. wrappers check containment before creating directories"
rm -rf "$ROOT/.selftest-store"
HARNESS_HOME="$ROOT/.selftest-store" DOGFOOD_LOG_DIR="$ROOT/.selftest-store/logs" \
  SECTION="§x" SLICE="x" PATHS="x" bash "$ROOT/scripts/dogfood/start-slice.sh" >/dev/null 2>&1
check "$?" "1" "start-slice refuses an in-repo store"
if [ -e "$ROOT/.selftest-store" ]; then
  bad "start-slice created nothing in the repo" "it created .selftest-store first"
  rm -rf "$ROOT/.selftest-store"
else ok "start-slice created nothing in the repo"; fi

HARNESS_HOME="$ROOT/.selftest-store" DOGFOOD_LOG_DIR="$ROOT/.selftest-store/logs" \
  bash "$ROOT/scripts/dogfood/run-slice.sh" run spec hash >/dev/null 2>&1
check "$?" "1" "run-slice refuses an in-repo store"
if [ -e "$ROOT/.selftest-store" ]; then
  bad "run-slice created nothing in the repo" "it created .selftest-store first"
  rm -rf "$ROOT/.selftest-store"
else ok "run-slice created nothing in the repo"; fi

# ── D. the real battery, end to end ─────────────────────────────────────────
# The point: preflight.sh actually runs, and section (d) executes the REAL
# addAllExceptNodeModules out of dist/ and reaches a verdict. WHICH verdict is
# machine-dependent — it fails while F10 is unlanded — so we assert the drill
# fired and reported one, never which one.
echo
echo "D. a real preflight run exercises the staging drill"
PF_LOG="$SCRATCH/preflight.out"
HARNESS_HOME="$SCRATCH/store" DOGFOOD_LOG_DIR="$SCRATCH/store/logs" \
  bash "$ROOT/scripts/dogfood/preflight.sh" >"$PF_LOG" 2>&1
PF_RC=$?

if grep -q 'engine staging drill — REAL helper from dist/' "$PF_LOG"; then ok "section (d) ran"
else bad "section (d) ran" "header missing from the output"; fi

if grep -q 'ran without throwing' "$PF_LOG" || grep -q "staging helper FAILS on this machine" "$PF_LOG"; then
  ok "the real helper was invoked and reported a verdict"
else bad "the real helper was invoked and reported a verdict" "neither outcome line present"; fi

if grep -q 'semantics intact' "$PF_LOG"; then
  ok "the vacuous-pass guard ran (staging asserted, not just absence)"
else bad "the vacuous-pass guard ran" "guard line missing"; fi

if grep -q 'discovery found [0-9]* test files' "$PF_LOG"; then ok "the discovery floor ran"
else bad "the discovery floor ran" "floor line missing"; fi

REC="$SCRATCH/store/logs/preflight.jsonl"
if [ -f "$REC" ]; then
  ok "a provenance line landed in the SCRATCH log dir"
  FIELDS="$(node -e '
const fs = require("node:fs");
const last = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").pop();
const r = JSON.parse(last);
const need = ["at","verdict","git","node","npm","head","distDigest","harnessHome","logDir"];
process.stdout.write(need.filter((k) => typeof r[k] !== "string" || !r[k]).join(",") || "complete");
' "$REC" 2>&1)"
  check "$FIELDS" "complete" "the provenance line carries every expected field"
else
  bad "a provenance line landed in the SCRATCH log dir" "no $REC"
fi

case "$PF_RC" in
  0|1) ok "preflight exited with a definite verdict (rc=$PF_RC)" ;;
  *)   bad "preflight exited with a definite verdict" "rc=$PF_RC" ;;
esac

echo
echo "───────────────────────────────────────────────────────────────────────"
echo " passed: $PASSED   failed: $FAILED"
if [ "$FAILED" -gt 0 ]; then echo "── SELFTEST FAILED ──"; exit 1; fi
echo "── SELFTEST PASSED ──"
exit 0
