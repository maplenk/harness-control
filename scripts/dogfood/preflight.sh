#!/usr/bin/env bash
#
# Dogfood PREFLIGHT (execution-plan law L11) — the <1-minute, zero-spend battery
# that runs before EVERY dogfood `start`. `run-slice.sh` should refuse without a
# fresh pass.
#
# Why it exists: both 2026-07-25 misses were invisible to a green suite. F10 (the
# staging helper dying on git 2.55's exclude-pathspec) lived because the flow
# tests fake git; the grok permission trap lived because policy is only exercised
# by a live turn. A green suite proves the CODE against ITSELF; this battery
# proves the code against the CURRENT MACHINE — real git, the real native
# bindings, the real built CLI, the real collection count.
#
# Usage:  bash scripts/dogfood/preflight.sh
#   env:  FLOOR=<n>       suite collection floor          (default 103)
#         SKIP_BUILD=1    skip the rebuild in section (d) (doctor still runs)
#         HARNESS_HOME    run store                       (default ~/.harness)
#
# Exit:  0 = every section passed (warnings print but are never fatal)
#        1 = at least one section FAILED — do NOT start a run
#
# Costs nothing: no provider calls, no network, no installs. Writes exactly two
# places — one JSON line appended to $HARNESS_HOME/logs/preflight.jsonl (the
# provenance record; platformKey covers node only, and F10 was a GIT-version
# interaction the fingerprint cannot see) and a mktemp scratch repo removed on exit.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT" || { echo "!! cannot cd to repo root"; exit 1; }

: "${HARNESS_HOME:=$HOME/.harness}"
LOGDIR="${DOGFOOD_LOG_DIR:-$HARNESS_HOME/logs}"; mkdir -p "$LOGDIR"
RECORD="$LOGDIR/preflight.jsonl"
FLOOR="${FLOOR:-103}"
BASELINE="$ROOT/scripts/dogfood/preflight-baseline.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
T0=$(date +%s)

WORK="$(mktemp -d "${TMPDIR:-/tmp}/harness-preflight-XXXXXX")" || exit 1
trap 'rm -rf "$WORK"' EXIT

FAILURES=()
WARNINGS=()
hdr()  { printf '\n── %s\n' "$*"; }
pass() { printf '   ✔ %s\n' "$*"; }
warn() { WARNINGS+=("$*"); printf '   ! %s\n' "$*"; }
fail() { FAILURES+=("$*"); printf '   ✖ %s\n' "$*"; }
info() { printf '     %s\n' "$*"; }

echo "── dogfood PREFLIGHT (L11) ────────────────────────────────────"
echo " repo   : $ROOT"
echo " store  : $HARNESS_HOME"
echo " record : $RECORD"
echo "───────────────────────────────────────────────────────────────"

# ─────────────────────────────────────────────────────────────────────────────
# (a) Toolchain provenance — record the versions the run will actually execute
#     against. Drift WARNS (a new git/node is not automatically wrong); the point
#     is that the version lands in the per-run record, so the next F10-class
#     surprise is one `git log`-of-the-jsonl away from being explained.
# ─────────────────────────────────────────────────────────────────────────────
hdr "a. toolchain provenance"
for BIN in git node npm; do
  command -v "$BIN" >/dev/null 2>&1 || fail "$BIN is not on PATH"
done
GIT_V="$(git --version 2>/dev/null | awk '{print $3}')"
NODE_V="$(node --version 2>/dev/null)"
NPM_V="$(npm --version 2>/dev/null)"
HEAD_SHA="$(git rev-parse HEAD 2>/dev/null)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null)"
info "git ${GIT_V:-?} · node ${NODE_V:-?} · npm ${NPM_V:-?}"
info "HEAD ${HEAD_SHA:-?} (${BRANCH:-?})"

if [ -f "$BASELINE" ]; then
  DRIFT="$(node - "$BASELINE" "$GIT_V" "$NODE_V" "$NPM_V" <<'NODE'
const fs = require('node:fs');
const [file, git, node, npm] = process.argv.slice(2);
let base;
try { base = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { process.stdout.write('UNREADABLE'); process.exit(0); }
const seen = { git, node, npm };
const drift = Object.keys(seen)
  .filter((k) => base[k] !== undefined && base[k] !== seen[k])
  .map((k) => `${k} ${base[k]} → ${seen[k]}`);
process.stdout.write(drift.join('; '));
NODE
)"
  if [ "$DRIFT" = "UNREADABLE" ]; then
    warn "baseline file is not valid JSON: $BASELINE"
  elif [ -n "$DRIFT" ]; then
    warn "toolchain drift vs baseline — $DRIFT  (update $BASELINE once the drill below still passes)"
  else
    pass "toolchain matches $(basename "$BASELINE")"
  fi
else
  warn "no baseline at $BASELINE — drift cannot be detected"
fi

# ─────────────────────────────────────────────────────────────────────────────
# (b) Engine git-path drill — the F10 CLASS canary, on REAL git.
#     Shape: an ignored-and-present node_modules (exactly what F7 provisions into
#     a worktree) plus dirty tracked + untracked files, then the staging call the
#     engine makes before every commit. It must exit 0 and stage nothing under
#     node_modules. This deliberately drills the git BEHAVIOUR rather than the
#     repo's helper function, so it keeps catching git-version regressions after
#     the helper is rewritten (F10 rewrote it once already).
# ─────────────────────────────────────────────────────────────────────────────
hdr "b. engine git-path drill (ignored+present node_modules → plain \`git add -A -- .\`)"
DRILL="$WORK/drill"
mkdir -p "$DRILL"
git -C "$DRILL" init -q -b main >/dev/null 2>&1
printf 'node_modules/\n' > "$DRILL/.gitignore"
printf 'x\n' > "$DRILL/tracked.txt"
git -C "$DRILL" add -A >/dev/null 2>&1
git -C "$DRILL" -c user.email=preflight@harness -c user.name=preflight commit -q -m init >/dev/null 2>&1
mkdir -p "$DRILL/node_modules/left-pad"
printf 'module.exports = 1;\n' > "$DRILL/node_modules/left-pad/index.js"
printf 'y\n'   > "$DRILL/tracked.txt"     # dirty tracked file
printf 'new\n' > "$DRILL/added.txt"       # new untracked file

ADD_OUT="$(git -C "$DRILL" add -A -- . 2>&1)"; ADD_RC=$?
STAGED="$(git -C "$DRILL" diff --cached --name-only 2>/dev/null)"
if [ "$ADD_RC" -ne 0 ]; then
  fail "\`git add -A -- .\` exited $ADD_RC on git ${GIT_V:-?} — the engine's staging path is BROKEN on this machine"
  info "${ADD_OUT}"
else
  pass "\`git add -A -- .\` exited 0"
fi
if printf '%s\n' "$STAGED" | grep -Eq '(^|/)node_modules(/|$)'; then
  fail "staged paths include node_modules — a provisioned toolchain would enter a harness commit"
  printf '%s\n' "$STAGED" | grep -E '(^|/)node_modules(/|$)' | sed 's/^/       /'
else
  pass "no node_modules path staged"
fi
# Guard against a vacuous pass: the drill is only meaningful if -A semantics held.
if printf '%s\n' "$STAGED" | grep -q '^tracked.txt$' && printf '%s\n' "$STAGED" | grep -q '^added.txt$'; then
  pass "full \`-A\` semantics intact (modified + added both staged)"
else
  fail "expected tracked.txt AND added.txt staged; got: $(printf '%s' "$STAGED" | tr '\n' ' ')"
fi
# Informational: the pre-F10 helper shape, kept as living documentation of the
# regression. Never fails the battery — the engine no longer uses it.
git -C "$DRILL" reset -q >/dev/null 2>&1
LEGACY_OUT="$(git -C "$DRILL" add -A -- . ':(exclude)node_modules' 2>&1)"; LEGACY_RC=$?
if [ "$LEGACY_RC" -ne 0 ]; then
  info "(F10 confirmed on this git: the pre-F10 \`:(exclude)node_modules\` pathspec exits $LEGACY_RC — \"${LEGACY_OUT%%$'\n'*}\")"
else
  info "(pre-F10 \`:(exclude)node_modules\` pathspec still exits 0 on this git — F10 was version-specific)"
fi
git -C "$DRILL" reset -q >/dev/null 2>&1

# ─────────────────────────────────────────────────────────────────────────────
# (c) Primary toolchain — the F9/L1 lesson: a populated node_modules/.bin proves
#     NOTHING (it is filled at unpack time, independent of lifecycle scripts).
#     Prove the native binding by OPENING a database, and prove the binaries by
#     EXECUTING them.
# ─────────────────────────────────────────────────────────────────────────────
hdr "c. primary toolchain (runtime proof, not presence)"
SQLITE_OUT="$(node -e "const D=require('better-sqlite3');const db=new D(':memory:');const r=db.prepare('select 1 as x').get();db.close();process.stdout.write(String(r.x));" 2>&1)"; SQLITE_RC=$?
if [ "$SQLITE_RC" -eq 0 ] && [ "$SQLITE_OUT" = "1" ]; then
  pass "better-sqlite3 native binding loads and queries"
else
  fail "better-sqlite3 runtime smoke failed (rc=$SQLITE_RC): ${SQLITE_OUT}"
fi
for BIN in tsc vitest; do
  if [ -x "$ROOT/node_modules/.bin/$BIN" ]; then
    BIN_V="$("$ROOT/node_modules/.bin/$BIN" --version 2>&1 | head -1)"; BIN_RC=$?
    if [ "$BIN_RC" -eq 0 ]; then pass "node_modules/.bin/$BIN executes — ${BIN_V}"
    else fail "node_modules/.bin/$BIN exists but \`--version\` exited $BIN_RC: ${BIN_V}"; fi
  else
    fail "node_modules/.bin/$BIN missing or not executable — run \`npm install\` in the primary"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# (d) Build + doctor — the next run executes dist/, not src/. Rebuild it from the
#     current HEAD, then ask the engine's own readiness check. `warn` is
#     acceptable (unvalidated auth is normal before a turn); `fail` is not.
# ─────────────────────────────────────────────────────────────────────────────
hdr "d. build + doctor"
if [ "${SKIP_BUILD:-}" = "1" ]; then
  warn "SKIP_BUILD=1 — dist/ NOT rebuilt; the run may execute a stale engine"
else
  if npm run build >"$WORK/build.log" 2>&1; then
    pass "npm run build (dist rebuilt from ${HEAD_SHA:0:12})"
  else
    fail "npm run build failed — tail:"
    tail -n 15 "$WORK/build.log" | sed 's/^/       /'
  fi
fi
if [ -f "$ROOT/dist/cli/index.js" ]; then
  node "$ROOT/dist/cli/index.js" doctor --json >"$WORK/doctor.json" 2>"$WORK/doctor.err"
  DOCTOR_SUMMARY="$(node - "$WORK/doctor.json" <<'NODE'
const fs = require('node:fs');
try {
  const r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  process.stdout.write([r.overall ?? 'unparsed', ...(r.notes ?? [])].join('\n'));
} catch (e) {
  process.stdout.write('unparsed\n' + String(e.message));
}
NODE
)"
  DOCTOR_OVERALL="$(printf '%s' "$DOCTOR_SUMMARY" | head -1)"
  case "$DOCTOR_OVERALL" in
    ok)   pass "doctor overall: ok" ;;
    warn) pass "doctor overall: warn (accepted — notes below)"
          printf '%s\n' "$DOCTOR_SUMMARY" | tail -n +2 | sed 's/^/       ! /' ;;
    *)    fail "doctor overall: ${DOCTOR_OVERALL:-<no output>}"
          printf '%s\n' "$DOCTOR_SUMMARY" | tail -n +2 | sed 's/^/       /'
          [ -s "$WORK/doctor.err" ] && tail -n 5 "$WORK/doctor.err" | sed 's/^/       /' ;;
  esac
else
  fail "dist/cli/index.js missing — cannot run doctor"
  DOCTOR_OVERALL="unbuilt"
fi

# ─────────────────────────────────────────────────────────────────────────────
# (e) Suite collection floor — the counterpart to the root vitest.config.ts
#     `**/.claude/**` exclude. An exclude can only ever REMOVE files, and a
#     rerouted root (trap: a root vite/vitest config with `root: 'web'`) collapses
#     collection to ~1 file while still exiting 0. The floor is what makes a
#     false-green loud. `vitest list --filesOnly` is collection-only: no test
#     bodies run, no network, ~1s.
# ─────────────────────────────────────────────────────────────────────────────
hdr "e. suite collection floor (>= $FLOOR test files)"
if [ -x "$ROOT/node_modules/.bin/vitest" ]; then
  "$ROOT/node_modules/.bin/vitest" list --filesOnly >"$WORK/list.txt" 2>"$WORK/list.err"; LIST_RC=$?
  COLLECTED="$(grep -c . "$WORK/list.txt" 2>/dev/null || echo 0)"
  if [ "$LIST_RC" -ne 0 ]; then
    fail "\`vitest list --filesOnly\` exited $LIST_RC"
    tail -n 8 "$WORK/list.err" | sed 's/^/       /'
  elif [ "$COLLECTED" -lt "$FLOOR" ]; then
    fail "collected $COLLECTED test files, floor is $FLOOR — discovery is broken (config reroute? bad exclude?)"
  else
    pass "collected $COLLECTED test files (floor $FLOOR)"
    if grep -q '\.claude/' "$WORK/list.txt"; then
      fail "collection includes .claude/ paths — the root vitest.config.ts exclude is not in effect"
    fi
  fi
else
  fail "node_modules/.bin/vitest missing — cannot check the collection floor"
  COLLECTED=0
fi

# ─────────────────────────────────────────────────────────────────────────────
# (f) Clean tree — F5 + the repo-freeze law: `start` pins the base sha, and any
#     tracked-file edit during a live run poisons the round (W3-1 drift guard).
#     A dirty tree here means the freeze is already violated before the run began.
# ─────────────────────────────────────────────────────────────────────────────
hdr "f. clean tree (F5 base pin + repo-freeze precondition)"
DIRT="$(git status --porcelain 2>/dev/null)"
if [ -z "$DIRT" ]; then
  pass "working tree clean at ${HEAD_SHA:0:12}"
else
  fail "working tree is dirty — commit, stash, or move edits to the scratchpad before \`start\`"
  printf '%s\n' "$DIRT" | sed 's/^/       /'
fi

# ─────────────────────────────────────────────────────────────────────────────
# Verdict + provenance record
# ─────────────────────────────────────────────────────────────────────────────
T1=$(date +%s); ELAPSED=$((T1 - T0))
VERDICT="pass"; [ "${#FAILURES[@]}" -gt 0 ] && VERDICT="fail"

node - "$RECORD" "$STARTED_AT" "$VERDICT" "$GIT_V" "$NODE_V" "$NPM_V" "$HEAD_SHA" "$BRANCH" \
  "${DOCTOR_OVERALL:-}" "${COLLECTED:-0}" "$FLOOR" "$ELAPSED" "${#WARNINGS[@]}" "${#FAILURES[@]}" <<'NODE'
const fs = require('node:fs');
const [record, at, verdict, git, node, npm, head, branch, doctor, collected, floor, elapsedS, warns, fails] =
  process.argv.slice(2);
const line = JSON.stringify({
  at, verdict, git, node, npm, head, branch,
  doctor: doctor || null,
  collectedTestFiles: Number(collected), floor: Number(floor),
  elapsedS: Number(elapsedS), warnings: Number(warns), failures: Number(fails),
});
fs.appendFileSync(record, line + '\n');
process.stdout.write(line + '\n');
NODE

echo
echo "───────────────────────────────────────────────────────────────"
if [ "${#WARNINGS[@]}" -gt 0 ]; then
  echo " warnings (${#WARNINGS[@]}):"
  printf '   ! %s\n' "${WARNINGS[@]+"${WARNINGS[@]}"}"
fi
if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo " FAILURES (${#FAILURES[@]}):"
  printf '   ✖ %s\n' "${FAILURES[@]+"${FAILURES[@]}"}"
  echo "── PREFLIGHT FAILED in ${ELAPSED}s — do NOT start a run ────────"
  exit 1
fi
echo "── PREFLIGHT PASSED in ${ELAPSED}s — cleared to start ──────────"
exit 0
