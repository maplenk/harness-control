#!/usr/bin/env bash
#
# SELFTEST for the L11 preflight battery and its enforcement gate.
#
# WHY THIS IS CHECKED IN: the gate is the thing standing between a stale/forged
# record and real spending. Its guarantees were previously demonstrated in an
# agent session and reported as prose — unauditable and unrepeatable. A gate whose
# own guarantees cannot be re-run is not a gate. Everything below runs from a
# clean checkout, builds its own fixtures in a scratch dir OUTSIDE the repo,
# asserts BOTH the exit code and the specific refusal text, and cleans up.
#
# Usage:  npm run test:preflight
#     or  bash scripts/dogfood/preflight-selftest.sh
#     env: KEEP=1   leave the scratch store behind for inspection
#
# Requires: a built dist/ (run `npm run build` first — the gate binds its digest).
# Costs nothing: no provider calls, no network, no writes inside the repo, and it
# never touches the real $HARNESS_HOME.
#
# Exit: 0 = every case behaved as specified · 1 = at least one case did not.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
[ -n "${ROOT:-}" ] && cd "$ROOT" || { echo "!! cannot resolve repo root" >&2; exit 1; }
. "$ROOT/scripts/dogfood/lib.sh" || { echo "!! cannot source lib.sh" >&2; exit 1; }

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/harness-selftest-XXXXXX")" || exit 1
STORE="$SCRATCH/store"; LOGS="$STORE/logs"
cleanup() { [ "${KEEP:-0}" = "1" ] && { echo "kept: $SCRATCH"; return; }; chmod -R u+w "$SCRATCH" 2>/dev/null; rm -rf "$SCRATCH"; }
trap cleanup EXIT

PASSED=0; FAILED=0
GATE="$ROOT/scripts/dogfood/require-preflight.sh"
ATT=11111111-1111-1111-1111-111111111111

# ── fixture ──────────────────────────────────────────────────────────────────
# Builds a VALID record + claim pair, then applies `key=value` overrides.
# Special keys: __age=<min> __drop=<csv> __raw=<text> __empty=1 claim.<field>=<v>
HEAD_SHA="$(git rev-parse HEAD)"
GIT_V="$(git --version | awk '{print $3}')"
NODE_V="$(node --version)"; NPM_V="$(npm --version)"
dogfood_resolve_roles; dogfood_resolve_config "$ROOT"
CFG="$(dogfood_effective_config_sha "$ROOT" "${CONFIG:-}")"
DIST="$(dogfood_dist_digest "$ROOT")"
case "${DIST:-}" in ''|'!'*) echo "!! cannot digest dist/ — run \`npm run build\` first (${DIST#!})" >&2; exit 1 ;; esac

fixture() {
  rm -rf "$STORE"; mkdir -p "$LOGS"
  local home_c log_c
  home_c="$(dogfood_canonical_path "$STORE")"; log_c="$(dogfood_canonical_path "$LOGS")"
  node - "$LOGS/preflight.jsonl" "$STORE/.preflight-claim.json" "$HEAD_SHA" "$GIT_V" "$NODE_V" "$NPM_V" \
       "$COORDINATOR" "$IMPLEMENTOR" "$VERIFIER" "$CFG" "$DIST" "$home_c" "$log_c" "$ATT" "$@" <<'NODE'
const fs = require('node:fs');
const [rec, claim, head, git, node, npm, co, im, ve, cfg, dist, home, log, att, ...ov] = process.argv.slice(2);
const now = (m) => new Date(Date.now() - (m || 0) * 60000).toISOString().replace(/\.\d{3}Z$/, 'Z');
const r = { at: now(0), attemptId: att, verdict: 'pass', git, node, npm, head, branch: 't',
  distDigest: dist, coordinator: co, implementor: im, verifier: ve, configSha: cfg,
  harnessHome: home, logDir: log, doctor: 'ok', skipBuild: false,
  collectedTestFiles: 103, floor: 103, elapsedS: 2, warnings: 0, failures: 0 };
const c = { attemptId: att, at: now(0), verdict: 'pass', head, distDigest: dist };
let drop = [], raw = null, empty = false;
for (const o of ov) {
  const i = o.indexOf('='); const k = o.slice(0, i); const v = o.slice(i + 1);
  if (k === '__age') r.at = now(Number(v));
  else if (k === '__drop') drop = v.split(',');
  else if (k === '__raw') raw = v;
  else if (k === '__empty') empty = true;
  else if (k.startsWith('claim.')) c[k.slice(6)] = v;
  else if (k === 'skipBuild') r[k] = v === 'true';
  else r[k] = v;
}
for (const k of drop) delete r[k];
fs.writeFileSync(claim, JSON.stringify(c) + '\n');
if (empty) fs.writeFileSync(rec, '');
else fs.writeFileSync(rec, (raw !== null ? raw : JSON.stringify(r)) + '\n');
NODE
}

# ── assertions ───────────────────────────────────────────────────────────────
# expect <label> <expected-exit> <expected-substring-or-EMPTY> -- <command...>
expect() {
  local label="$1" want_rc="$2" want_txt="$3"; shift 4
  local out rc
  out="$("$@" 2>&1)"; rc=$?
  local ok=1
  [ "$rc" = "$want_rc" ] || ok=0
  if [ -n "$want_txt" ] && ! printf '%s' "$out" | grep -qF -- "$want_txt"; then ok=0; fi
  if [ "$ok" = 1 ]; then
    PASSED=$((PASSED + 1)); printf '  ok   %s\n' "$label"
  else
    FAILED=$((FAILED + 1))
    printf '  FAIL %s\n' "$label"
    printf '       expected exit %s%s\n' "$want_rc" "${want_txt:+ containing: \"$want_txt\"}"
    printf '       got      exit %s: %s\n' "$rc" "$(printf '%s' "$out" | head -2 | tr '\n' ' ' | cut -c1-160)"
  fi
}
gate() { HARNESS_HOME="$STORE" bash "$GATE" "$@"; }

echo "── preflight/gate selftest ────────────────────────────────────────────"
echo " repo    : $ROOT"
echo " scratch : $SCRATCH   (never the real \$HARNESS_HOME)"
echo " dist    : ${DIST:0:16}…"
echo "───────────────────────────────────────────────────────────────────────"

echo
echo "A. accepts a valid record, refuses stale/foreign ones"
fixture                                   ; expect "valid record + matching claim" 0 "preflight gate: passing record" -- gate
fixture __age=45                          ; expect "45 minutes old"                1 "minutes old (max 30)" -- gate
fixture head=deadbeefdeadbeefdeadbeefdead ; expect "different HEAD"                 1 "but the tree is now at" -- gate
fixture git=2.49.0                        ; expect "git changed underneath"         1 "git changed since the preflight" -- gate
fixture verdict=diagnostic skipBuild=true ; expect "diagnostic (SKIP_BUILD)"        1 "DIAGNOSTIC run" -- gate
fixture verdict=fail                      ; expect "failing record"                 1 'verdict is "fail"' -- gate
fixture __raw='not json'                  ; expect "corrupt record"                 1 "not valid JSON" -- gate
fixture __empty=1                         ; expect "empty log"                      1 "record is empty" -- gate
fixture; rm -f "$LOGS/preflight.jsonl"    ; expect "no log at all"                  1 "no preflight record at" -- gate

echo
echo "B. an incomplete record must never read as agreement"
for k in git node npm distDigest implementor configSha attemptId harnessHome logDir; do
  fixture "__drop=$k"; expect "missing $k" 1 "incomplete — missing/invalid: $k" -- gate
done
fixture __drop=git,node,npm ; expect "missing all three versions" 1 "missing/invalid: git, node, npm" -- gate

echo
echo "C. binds the EXECUTABLE tree, the roles and the config"
fixture distDigest=0000000000000000         ; expect "recorded digest != current dist" 1 "dist/ CHANGED since the preflight" -- gate
fixture implementor=opencode:grok-code:high ; expect "record gated another implementor" 1 "implementor role differs" -- gate
fixture configSha=deadbeef                  ; expect "different engine config"         1 "engine config differs" -- gate
fixture
expect "caller overrides IMPLEMENTOR after pf" 1 "implementor role differs" -- \
  env IMPLEMENTOR=opencode:grok-code:high HARNESS_HOME="$STORE" bash "$GATE"

echo
echo "D. the attempt claim orphans a record the log could not replace"
fixture claim.attemptId=22222222-2222-2222-2222-222222222222 claim.verdict=fail
expect "later attempt FAILED, record kept"  1 "record is ORPHANED" -- gate
fixture claim.attemptId=22222222-2222-2222-2222-222222222222
expect "later attempt passed, record stale" 1 "record is ORPHANED" -- gate
fixture claim.verdict=running               ; expect "attempt still running"     1 'attempt recorded verdict "running"' -- gate
fixture; rm -f "$STORE/.preflight-claim.json" ; expect "claim missing entirely"  1 "no attempt claim at" -- gate
fixture; printf 'nope\n' > "$STORE/.preflight-claim.json" ; expect "claim corrupt" 1 "attempt claim is unreadable" -- gate
fixture claim.head=abc                      ; expect "claim/record disagree on HEAD" 1 "disagree about HEAD/dist" -- gate
fixture; chmod 555 "$STORE"
expect "gate cannot write its attempt marker" 1 "cannot write the gate attempt marker" -- gate
chmod 755 "$STORE"

echo
echo "E. store/log identity and containment"
fixture harnessHome=/somewhere/else     ; expect "record bound another store"   1 "store moved since the preflight" -- gate
fixture logDir=/somewhere/else/logs     ; expect "record bound another log dir" 1 "log dir moved since the preflight" -- gate
fixture
expect "HARNESS_HOME repointed into repo" 1 "resolves inside the repo" -- \
  env HARNESS_HOME="$ROOT/.selftest-store" DOGFOOD_LOG_DIR="$LOGS" bash "$GATE"

echo
echo "F. ordering: the LAST record is the current truth"
fixture
node -e 'const fs=require("node:fs");const f=process.argv[1];const l=JSON.parse(fs.readFileSync(f,"utf8").trim());
l.verdict="fail";l.failures=1;fs.appendFileSync(f,JSON.stringify(l)+"\n");' "$LOGS/preflight.jsonl"
expect "pass THEN fail" 1 'verdict is "fail"' -- gate

echo
echo "G. lib primitives (the holes the digest and containment used to have)"
mkdir -p "$SCRATCH/dtest/dist/sub" "$SCRATCH/ta" "$SCRATCH/tb"
printf 'A\n' > "$SCRATCH/ta/f.js"; printf 'B\n' > "$SCRATCH/tb/f.js"
printf 'x\n' > "$SCRATCH/dtest/dist/sub/a.js"
D1="$(dogfood_dist_digest "$SCRATCH/dtest")"
mkdir -p "$SCRATCH/dtest/dist/empty-dir"
D2="$(dogfood_dist_digest "$SCRATCH/dtest")"
if [ "$D1" != "$D2" ]; then PASSED=$((PASSED+1)); echo "  ok   an added EMPTY directory moves the digest"
else FAILED=$((FAILED+1)); echo "  FAIL an added empty directory did not move the digest"; fi
rmdir "$SCRATCH/dtest/dist/empty-dir"
ln -sfn "$SCRATCH/ta" "$SCRATCH/dtest/dist/linked"
OUT="$(dogfood_dist_digest "$SCRATCH/dtest")"
case "$OUT" in
  '!'*symlink*) PASSED=$((PASSED+1)); echo "  ok   a symlinked entry inside dist is refused" ;;
  *) FAILED=$((FAILED+1)); echo "  FAIL symlinked entry not refused: ${OUT:0:60}" ;;
esac
rm -f "$SCRATCH/dtest/dist/linked"
mv "$SCRATCH/dtest/dist" "$SCRATCH/dtest/dist-real"; ln -sfn "$SCRATCH/dtest/dist-real" "$SCRATCH/dtest/dist"
OUT="$(dogfood_dist_digest "$SCRATCH/dtest")"
case "$OUT" in
  '!'*symlink*) PASSED=$((PASSED+1)); echo "  ok   a symlinked dist ROOT is refused" ;;
  *) FAILED=$((FAILED+1)); echo "  FAIL symlinked dist root not refused: ${OUT:0:60}" ;;
esac
rm -f "$SCRATCH/dtest/dist"

ln -sfn "$ROOT/scripts" "$SCRATCH/link-to-repo"
if dogfood_path_inside "$SCRATCH/link-to-repo/../docs" "$ROOT"; then
  PASSED=$((PASSED+1)); echo "  ok   absolute symlink/.. that lands in the repo is INSIDE"
else FAILED=$((FAILED+1)); echo "  FAIL absolute symlink/.. classified outside the repo"; fi
if ( cd "$SCRATCH" && dogfood_path_inside "link-to-repo/../docs" "$ROOT" ); then
  PASSED=$((PASSED+1)); echo "  ok   RELATIVE symlink/.. that lands in the repo is INSIDE"
else FAILED=$((FAILED+1)); echo "  FAIL relative symlink/.. classified outside the repo"; fi
rm -f "$SCRATCH/link-to-repo"

echo
echo "H. preflight never exits leaving an older PASS authoritative"
# Seed a store whose last record+claim would authorise a run, then abort a fresh
# preflight before it can finish, and require the gate to stop authorising.
fixture
expect "seeded pair authorises (precondition)" 0 "passing record" -- gate
HARNESS_HOME="$STORE" DOGFOOD_LOG_DIR="$LOGS" TMPDIR=/nonexistent-selftest-dir \
  bash "$ROOT/scripts/dogfood/preflight.sh" >/dev/null 2>&1
expect "aborted preflight orphans the pair" 1 "" -- gate
CLAIM_VERDICT="$(node -e 'try{process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).verdict))}catch{process.stdout.write("<unreadable>")}' "$STORE/.preflight-claim.json")"
if [ "$CLAIM_VERDICT" != "pass" ]; then
  PASSED=$((PASSED+1)); echo "  ok   claim left as \"$CLAIM_VERDICT\" (not pass) after the abort"
else FAILED=$((FAILED+1)); echo "  FAIL claim still reads \"pass\" after an aborted preflight"; fi

echo
echo "───────────────────────────────────────────────────────────────────────"
echo " passed: $PASSED   failed: $FAILED"
if [ "$FAILED" -gt 0 ]; then echo "── SELFTEST FAILED ──"; exit 1; fi
echo "── SELFTEST PASSED ──"
exit 0
