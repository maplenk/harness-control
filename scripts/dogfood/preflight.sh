#!/usr/bin/env bash
#
# Dogfood PREFLIGHT (execution-plan law L11) — the <1-minute, zero-spend battery
# that runs before EVERY dogfood `start`. `start-slice.sh` and `run-slice.sh`
# refuse to run without a fresh PASSING record from this script
# (`scripts/dogfood/require-preflight.sh` is the gate).
#
# Why it exists: both 2026-07-25 misses were invisible to a green suite. F10 (the
# staging helper dying on git 2.55) lived because no test ever built the
# ignored-and-present `node_modules` shape that provisioning creates in
# production; the grok permission trap lived because policy is only exercised by
# a live turn. A green suite proves the CODE against ITSELF; this battery proves
# the BUILT ENGINE against the CURRENT MACHINE.
#
# The gating check is section (d): it imports the **real** `addAllExceptNodeModules`
# from `dist/` and runs it against a real fixture. A simulation of what the engine
# is believed to do can pass while the engine itself fails — so the simulation is
# kept only as a labelled, non-gating canary that explains a real-helper failure.
#
# Usage:  bash scripts/dogfood/preflight.sh
#   env:  FLOOR=<n>       discovery floor; may only be RAISED above the committed
#                         baseline `floorMin` — a lower override is rejected
#         SKIP_BUILD=1    skip the rebuild; forces verdict "diagnostic", which the
#                         enforcement gate REJECTS (a stale dist proves nothing)
#         HARNESS_HOME    run store (default ~/.harness)
#
# Exit:  0 = all sections passed (verdict "pass", or "diagnostic" under SKIP_BUILD)
#        1 = at least one section FAILED — do NOT start a run
#
# Writes exactly two places, both OUTSIDE the repo: one JSON line appended to
# $HARNESS_HOME/logs/preflight.jsonl, and a mktemp scratch dir removed on exit.
# The only repo-local write is `dist/` (gitignored, and section (f) re-proves the
# tree is clean afterwards) — nothing this script does can dirty the next run's
# clean-tree check.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." 2>/dev/null && pwd)"
[ -n "${ROOT:-}" ] && cd "$ROOT" || { echo "!! cannot resolve/enter repo root" >&2; exit 1; }

# Role/config/digest/containment helpers, shared with the gate and the slice
# scripts so the facts this record binds are the facts the run will execute.
. "$ROOT/scripts/dogfood/lib.sh" || { echo "!! cannot source scripts/dogfood/lib.sh" >&2; exit 1; }

: "${HARNESS_HOME:=$HOME/.harness}"
LOGDIR="${DOGFOOD_LOG_DIR:-$HARNESS_HOME/logs}"
# The store and the log dir must live OUTSIDE the repo. If they resolve inside
# it, this battery's own provenance write becomes repo dirt — and since the
# append happens after the clean-tree check, a PASS could leave behind exactly
# the dirt that fails the NEXT run's clean-tree check.
if dogfood_path_inside "$HARNESS_HOME" "$ROOT"; then
  echo "!! HARNESS_HOME resolves inside the repo ($HARNESS_HOME) — refusing: run artifacts would dirty the tree" >&2; exit 1
fi
if dogfood_path_inside "$LOGDIR" "$ROOT"; then
  echo "!! the log dir resolves inside the repo ($LOGDIR) — refusing: the provenance record would dirty the tree" >&2; exit 1
fi
mkdir -p "$LOGDIR" || { echo "!! cannot create log dir $LOGDIR" >&2; exit 1; }
RECORD="$LOGDIR/preflight.jsonl"
BASELINE="$ROOT/scripts/dogfood/preflight-baseline.json"
HELPER_JS="$ROOT/dist/worktree/git.js"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
T0=$(date +%s)

# Resolve exactly what the slice scripts will dispatch, using their own logic.
dogfood_resolve_roles
dogfood_resolve_config "$ROOT"
CONFIG_SHA="$(dogfood_config_sha "${CONFIG:-}")"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/harness-preflight-XXXXXX")" || { echo "!! mktemp failed" >&2; exit 1; }
trap 'rm -rf "$WORK"' EXIT

FAILURES=()
WARNINGS=()
hdr()  { printf '\n── %s\n' "$*"; }
pass() { printf '   ✔ %s\n' "$*"; }
warn() { WARNINGS+=("$*"); printf '   ! %s\n' "$*"; }
fail() { FAILURES+=("$*"); printf '   ✖ %s\n' "$*"; }
info() { printf '     %s\n' "$*"; }
# A bare integer, or nothing. Every count in this script goes through it, so a
# tool that prints "0\n0", an empty string, or a diagnostic can never reach `-lt`.
as_int() { case "${1:-}" in ''|*[!0-9]*) printf '' ;; *) printf '%s' "$1" ;; esac; }

echo "── dogfood PREFLIGHT (L11) ────────────────────────────────────"
echo " repo   : $ROOT"
echo " store  : $HARNESS_HOME"
echo " record : $RECORD"
echo " roles  : $COORDINATOR / $IMPLEMENTOR / $VERIFIER"
echo " config : ${CONFIG:-<engine defaults>} (${CONFIG_SHA:0:12})"
echo "───────────────────────────────────────────────────────────────"

# ─────────────────────────────────────────────────────────────────────────────
# (a) Toolchain provenance — record the versions the run will actually execute
#     against. Drift WARNS (a new git/node is not automatically wrong); the point
#     is that the version reaches the record, so the next F10-class surprise is
#     one `grep` of the jsonl away from being explained.
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
[ -n "$GIT_V" ]    || fail "could not read git version"
[ -n "$NODE_V" ]   || fail "could not read node version"
[ -n "$NPM_V" ]    || fail "could not read npm version"
[ -n "$HEAD_SHA" ] || fail "could not resolve HEAD — is this a git repo?"
info "git ${GIT_V:-?} · node ${NODE_V:-?} · npm ${NPM_V:-?}"
info "HEAD ${HEAD_SHA:-?} (${BRANCH:-?})"

FLOOR_MIN=""
if [ -f "$BASELINE" ]; then
  BASE_OUT="$(node - "$BASELINE" "$GIT_V" "$NODE_V" "$NPM_V" <<'NODE'
const fs = require('node:fs');
const [file, git, node, npm] = process.argv.slice(2);
let base;
try { base = JSON.parse(fs.readFileSync(file, 'utf8')); }
catch { process.stdout.write('UNREADABLE\n'); process.exit(0); }
const seen = { git, node, npm };
const drift = Object.keys(seen)
  .filter((k) => base[k] !== undefined && base[k] !== seen[k])
  .map((k) => `${k} ${base[k]} → ${seen[k]}`);
process.stdout.write(`FLOORMIN\t${Number.isInteger(base.floorMin) && base.floorMin > 0 ? base.floorMin : ''}\n`);
process.stdout.write(`DRIFT\t${drift.join('; ')}\n`);
NODE
)"
  if [ -z "$BASE_OUT" ] || [ "${BASE_OUT%%$'\n'*}" = "UNREADABLE" ]; then
    fail "baseline file unreadable or not valid JSON: $BASELINE"
  else
    FLOOR_MIN="$(as_int "$(printf '%s\n' "$BASE_OUT" | awk -F'\t' '$1=="FLOORMIN"{print $2}')")"
    DRIFT="$(printf '%s\n' "$BASE_OUT" | awk -F'\t' '$1=="DRIFT"{print $2}')"
    if [ -n "$DRIFT" ]; then
      warn "toolchain drift vs baseline — $DRIFT  (update $BASELINE once section (d) still passes)"
    else
      pass "toolchain matches $(basename "$BASELINE")"
    fi
  fi
else
  fail "no baseline at $BASELINE — drift cannot be detected and the floor has no anchor"
fi
if [ -z "$FLOOR_MIN" ]; then
  fail "baseline is missing a positive integer \"floorMin\" — the discovery floor has no committed anchor"
  FLOOR_MIN=0
fi
# The floor may be RAISED (the suite grows) but never LOWERED: a lower override is
# exactly how a broken-discovery run would be made to "pass".
FLOOR_RAW="${FLOOR:-$FLOOR_MIN}"
FLOOR="$(as_int "$FLOOR_RAW")"
if [ -z "$FLOOR" ] || [ "$FLOOR" -le 0 ]; then
  fail "FLOOR override must be a positive integer (got '$FLOOR_RAW')"
  FLOOR="$FLOOR_MIN"
elif [ "$FLOOR" -lt "$FLOOR_MIN" ]; then
  fail "FLOOR=$FLOOR is below the committed baseline floorMin=$FLOOR_MIN — refusing to lower the floor"
  FLOOR="$FLOOR_MIN"
fi

# ─────────────────────────────────────────────────────────────────────────────
# (b) Primary toolchain — the F9/P1 lesson: a populated `node_modules/.bin` proves
#     NOTHING (it is filled at unpack time, independent of lifecycle scripts).
#     Prove the native binding by OPENING a database and running a query; prove
#     the binaries by EXECUTING them.
# ─────────────────────────────────────────────────────────────────────────────
hdr "b. primary toolchain (runtime proof, not presence)"
SQLITE_OUT="$(node -e "const D=require('better-sqlite3');const db=new D(':memory:');const r=db.prepare('select 1 as x').get();db.close();process.stdout.write(String(r.x));" 2>&1)"; SQLITE_RC=$?
if [ "$SQLITE_RC" -eq 0 ] && [ "$SQLITE_OUT" = "1" ]; then
  pass "better-sqlite3 native binding loads and queries"
else
  fail "better-sqlite3 runtime smoke failed (rc=$SQLITE_RC): ${SQLITE_OUT}"
fi
for BIN in tsc vitest; do
  if [ -x "$ROOT/node_modules/.bin/$BIN" ]; then
    BIN_V="$("$ROOT/node_modules/.bin/$BIN" --version 2>&1 | head -1)"; BIN_RC=$?
    if [ "$BIN_RC" -eq 0 ] && [ -n "$BIN_V" ]; then pass "node_modules/.bin/$BIN executes — ${BIN_V}"
    else fail "node_modules/.bin/$BIN exists but \`--version\` exited $BIN_RC: ${BIN_V:-<no output>}"; fi
  else
    fail "node_modules/.bin/$BIN missing or not executable — run \`npm install\` in the primary"
  fi
done

# ─────────────────────────────────────────────────────────────────────────────
# (c) Build + doctor. The next run executes `dist/`, not `src/` — and section (d)
#     drills the helper out of that same `dist/`, so the build also establishes
#     dist freshness. Doctor is evaluated PER ROLE: only the three harnesses we
#     actually dispatch may fail the battery; unused adapters are printed, not
#     enforced. A blanket accept of overall:"warn" would swallow a broken grok.
# ─────────────────────────────────────────────────────────────────────────────
hdr "c. build + doctor"
if [ "${SKIP_BUILD:-}" = "1" ]; then
  warn "SKIP_BUILD=1 — dist/ NOT rebuilt; verdict forced to \"diagnostic\" and the enforcement gate will reject this record"
else
  if npm run build >"$WORK/build.log" 2>&1; then
    pass "npm run build (dist rebuilt from ${HEAD_SHA:0:12})"
  else
    fail "npm run build failed — tail:"
    tail -n 15 "$WORK/build.log" | sed 's/^/       /'
  fi
fi

DOCTOR_OVERALL="unrun"
if [ ! -f "$ROOT/dist/cli/index.js" ]; then
  fail "dist/cli/index.js missing — cannot run doctor"
else
  DOCTOR_ARGS=(doctor --json)
  if [ -z "${CONFIG:-}" ]; then
    info "config: <engine defaults> (CONFIG is set but empty — the same resolution the slice scripts use)"
  elif [ -f "$CONFIG" ]; then
    DOCTOR_ARGS+=(--config "$CONFIG")
    info "config: $(basename "$CONFIG") sha256=${CONFIG_SHA:0:12}"
  else
    fail "the resolved engine config does not exist: $CONFIG"
  fi
  node "$ROOT/dist/cli/index.js" "${DOCTOR_ARGS[@]}" >"$WORK/doctor.json" 2>"$WORK/doctor.err"
  if [ ! -s "$WORK/doctor.json" ]; then
    fail "doctor produced no JSON"
    [ -s "$WORK/doctor.err" ] && tail -n 5 "$WORK/doctor.err" | sed 's/^/       /'
  else
    DOCTOR_EVAL="$(node - "$WORK/doctor.json" \
      "$(dogfood_harness_of "$COORDINATOR")" "$(dogfood_harness_of "$IMPLEMENTOR")" "$(dogfood_harness_of "$VERIFIER")" <<'NODE'
const fs = require('node:fs');
// The harnesses THIS INVOCATION will dispatch, resolved by lib.sh from exactly
// the env the slice scripts read — never a hard-coded triple. With
// IMPLEMENTOR=opencode:… the opencode adapter gates and grok becomes the
// unused one. Anything not dispatched is reported but never gates, and
// `overall` is not trusted as a gate because it folds all adapters together.
const [coordinator, implementor, verifier] = process.argv.slice(3);
const ROLES = {};
ROLES[coordinator] = 'coordinator';
ROLES[implementor] = ROLES[implementor] ? `${ROLES[implementor]}+implementor` : 'implementor';
ROLES[verifier] = ROLES[verifier] ? `${ROLES[verifier]}+verifier` : 'verifier';
const out = [];
let r;
try { r = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')); }
catch (e) { process.stdout.write(`STATUS\tfail\nFAIL\tdoctor JSON unparseable: ${e.message}\n`); process.exit(0); }

const fails = [];
const warns = [];
const notes = [];
notes.push(`overall=${r.overall ?? '?'} (context only — this battery gates per role)`);

for (const [id, role] of Object.entries(ROLES)) {
  const a = (r.adapters ?? []).find((x) => x.harnessId === id);
  if (!a) { fails.push(`${role} harness '${id}': no adapter report`); continue; }
  if (a.resolved !== true) fails.push(`${role} harness '${id}': not resolved`);
  else if (a.versionPinned === false) fails.push(`${role} harness '${id}': version drift (expected ${a.expectedVersion}, installed ${a.installedVersion})`);
  if (Array.isArray(a.issues) && a.issues.length > 0) fails.push(`${role} harness '${id}': ${a.issues.join('; ')}`);
  if (a.resolved === true && a.installedVersion && a.expectedVersion && String(a.installedVersion).indexOf(String(a.expectedVersion)) !== 0) {
    notes.push(`${role} '${id}': installed ${a.installedVersion} vs documented baseline ${a.expectedVersion}`);
  }
  const auth = (r.auth ?? []).find((x) => x.provider === id);
  if (!auth) fails.push(`${role} harness '${id}': no auth report`);
  else if (auth.readiness === 'supported') notes.push(`${role} '${id}': auth validated`);
  else if (auth.readiness === 'detected_but_unvalidated') warns.push(`${role} '${id}': auth detected_but_unvalidated (normal until a provider turn is recorded — H-2)`);
  else fails.push(`${role} harness '${id}': auth readiness '${auth.readiness}'`);
}

for (const a of r.adapters ?? []) {
  if (ROLES[a.harnessId]) continue;
  if (a.resolved !== true || (Array.isArray(a.issues) && a.issues.length > 0)) {
    warns.push(`unused adapter '${a.harnessId}': ${a.resolved !== true ? 'not resolved' : a.issues.join('; ')} (not dispatched — accepted)`);
  }
}

if (r.git?.available !== true) fails.push('git unavailable per doctor');
if (r.sqlite?.ok !== true) fails.push(`sqlite check failed${r.sqlite?.error ? `: ${r.sqlite.error}` : ''}`);
if (r.acpHandshake?.ok !== true) fails.push('ACP handshake (fake) failed');
if ((r.quotas?.issues ?? []).length > 0) fails.push(`engine config invalid: ${r.quotas.issues.map((i) => i.message ?? JSON.stringify(i)).join('; ')}`);
if (r.hostConfig?.codex?.safe === false) warns.push('host codex config flagged (H-1) — read-only check, orchestrator spawns are isolated');

out.push(`STATUS\t${fails.length > 0 ? 'fail' : 'ok'}`);
for (const f of fails) out.push(`FAIL\t${f}`);
for (const w of warns) out.push(`WARN\t${w}`);
for (const n of notes) out.push(`NOTE\t${n}`);
process.stdout.write(out.join('\n') + '\n');
NODE
)"
    DOCTOR_STATUS="$(printf '%s\n' "$DOCTOR_EVAL" | awk -F'\t' '$1=="STATUS"{print $2; exit}')"
    DOCTOR_OVERALL="${DOCTOR_STATUS:-unparsed}"
    if [ "$DOCTOR_STATUS" = "ok" ]; then
      pass "doctor: every dispatched role healthy ($(dogfood_harness_of "$COORDINATOR")/$(dogfood_harness_of "$IMPLEMENTOR")/$(dogfood_harness_of "$VERIFIER"))"
    else
      fail "doctor: one or more dispatched roles unhealthy"
    fi
    printf '%s\n' "$DOCTOR_EVAL" | awk -F'\t' '$1=="FAIL"{print "       ✖ " $2}'
    printf '%s\n' "$DOCTOR_EVAL" | awk -F'\t' '$1=="WARN"{print "       ! " $2}'
    printf '%s\n' "$DOCTOR_EVAL" | awk -F'\t' '$1=="NOTE"{print "       · " $2}'
    # Fold doctor's warns into the battery's warning count so the provenance
    # record cannot claim `warnings:0` while warn lines are on screen.
    while IFS= read -r DW; do
      [ -n "$DW" ] && WARNINGS+=("doctor: $DW")
    done < <(printf '%s\n' "$DOCTOR_EVAL" | awk -F'\t' '$1=="WARN"{print $2}')
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# (d) Engine staging drill — the GATING check, run against the REAL built helper.
#     Fixture = exactly what F7 provisioning creates: an ignored AND present
#     `node_modules`, plus a dirty tracked file and a new untracked file. We
#     import `addAllExceptNodeModules` out of `dist/worktree/git.js` and run it,
#     because a hand-rolled `git add` simulation can pass while the engine's own
#     helper throws (F10 is exactly that failure). Both harness commit paths —
#     the implementor post-turn commit and the §16.3 WIP commit — go through it.
# ─────────────────────────────────────────────────────────────────────────────
hdr "d. engine staging drill — REAL helper from dist/ (gating)"
DRILL="$WORK/drill"
DRILL_READY=1
mkdir -p "$DRILL" || DRILL_READY=0
git -C "$DRILL" init -q -b main >/dev/null 2>&1 || DRILL_READY=0
printf 'node_modules/\n' > "$DRILL/.gitignore" || DRILL_READY=0
printf 'x\n' > "$DRILL/tracked.txt" || DRILL_READY=0
git -C "$DRILL" add -A >/dev/null 2>&1 || DRILL_READY=0
git -C "$DRILL" -c user.email=preflight@harness -c user.name=preflight commit -q -m init >/dev/null 2>&1 || DRILL_READY=0
mkdir -p "$DRILL/node_modules/left-pad" || DRILL_READY=0
printf 'module.exports = 1;\n' > "$DRILL/node_modules/left-pad/index.js" || DRILL_READY=0
printf 'y\n'   > "$DRILL/tracked.txt" || DRILL_READY=0   # dirty tracked file
printf 'new\n' > "$DRILL/added.txt"   || DRILL_READY=0   # new untracked file
[ -n "$(git -C "$DRILL" rev-parse --verify HEAD 2>/dev/null)" ] || DRILL_READY=0
[ -f "$DRILL/node_modules/left-pad/index.js" ] || DRILL_READY=0

if [ "$DRILL_READY" -ne 1 ]; then
  fail "could not build the drill fixture (scratch repo setup failed) — the GATING check did not run"
elif [ ! -f "$HELPER_JS" ]; then
  fail "dist/worktree/git.js missing — cannot drill the real staging helper (build failed or dist is stale)"
else
  HELPER_OUT="$(node - "$HELPER_JS" "$DRILL" <<'NODE'
const { pathToFileURL } = require('node:url');
const [helperPath, dir] = process.argv.slice(2);
(async () => {
  const mod = await import(pathToFileURL(helperPath).href);
  const fn = mod.addAllExceptNodeModules;
  if (typeof fn !== 'function') { process.stdout.write('MISSING_EXPORT\n'); return; }
  try { await fn(dir); process.stdout.write('OK\n'); }
  catch (e) {
    const detail = (e && (e.detail || e.message)) || String(e);
    process.stdout.write('THREW ' + String(detail).split('\n')[0] + '\n');
  }
})().catch((e) => { process.stdout.write('IMPORT_ERROR ' + String((e && e.message) || e) + '\n'); process.exitCode = 1; });
NODE
)"
  HELPER_RC=$?
  HELPER_OUT="$(printf '%s\n' "$HELPER_OUT" | head -1)"
  # The printed verdict is not the whole story: a probe that prints OK, stages
  # correctly and then exits nonzero (unhandled rejection, late throw, OOM) has
  # not demonstrated a healthy helper. Both must agree.
  if [ "$HELPER_RC" -ne 0 ] && [ "$HELPER_OUT" = "OK" ]; then
    fail "the real-helper probe reported OK but its process exited $HELPER_RC — treating as a failure"
    HELPER_OUT="EXIT_MISMATCH"
  fi
  case "$HELPER_OUT" in
    OK)
      pass "addAllExceptNodeModules() from dist/ ran without throwing (probe exit 0)" ;;
    EXIT_MISMATCH)
      : ;;
    THREW*)
      fail "the ENGINE'S OWN staging helper FAILS on this machine — ${HELPER_OUT#THREW }"
      info "F10 class: every harness commit path (implementor post-turn commit AND the §16.3 WIP commit) calls this helper. Do NOT start a run." ;;
    MISSING_EXPORT)
      fail "dist/worktree/git.js does not export addAllExceptNodeModules — dist is stale or the helper was renamed (update this drill)" ;;
    *)
      fail "could not invoke the real helper: ${HELPER_OUT:-<no output>}" ;;
  esac

  STAGED="$(git -C "$DRILL" diff --cached --name-only 2>/dev/null)"
  if printf '%s\n' "$STAGED" | grep -Eq '(^|/)node_modules(/|$)'; then
    fail "the real helper staged node_modules — a provisioned toolchain would enter a harness commit"
    printf '%s\n' "$STAGED" | grep -E '(^|/)node_modules(/|$)' | sed 's/^/       /'
  else
    pass "no node_modules path staged by the real helper"
  fi
  # Vacuous-pass guard: "nothing staged" also satisfies "no node_modules staged".
  if printf '%s\n' "$STAGED" | grep -q '^tracked.txt$' && printf '%s\n' "$STAGED" | grep -q '^added.txt$'; then
    pass "full \`-A\` semantics intact (modified + added both staged)"
  else
    fail "expected tracked.txt AND added.txt staged by the real helper; got: [$(printf '%s' "$STAGED" | tr '\n' ' ')]"
  fi
fi

# Supplemental, NON-GATING git-behaviour canaries. They do not prove the engine —
# section (d) above does that — but when the real helper fails, these lines say
# whether git itself changed or only the engine's call shape is wrong.
if [ "$DRILL_READY" -eq 1 ]; then
  git -C "$DRILL" reset -q >/dev/null 2>&1
  CANARY_OUT="$(git -C "$DRILL" add -A -- . 2>&1)"; CANARY_RC=$?
  CANARY_STAGED="$(git -C "$DRILL" diff --cached --name-only 2>/dev/null)"
  if [ "$CANARY_RC" -eq 0 ] && ! printf '%s\n' "$CANARY_STAGED" | grep -Eq '(^|/)node_modules(/|$)'; then
    info "(canary, non-gating: plain \`git add -A -- .\` exits 0 and stages no node_modules on git ${GIT_V:-?})"
  else
    warn "canary (non-gating): plain \`git add -A -- .\` exited $CANARY_RC / staged [$(printf '%s' "$CANARY_STAGED" | tr '\n' ' ')] — git itself behaves unexpectedly here"
    info "${CANARY_OUT}"
  fi
  git -C "$DRILL" reset -q >/dev/null 2>&1
  LEGACY_OUT="$(git -C "$DRILL" add -A -- . ':(exclude)node_modules' 2>&1)"; LEGACY_RC=$?
  if [ "$LEGACY_RC" -ne 0 ]; then
    info "(canary, non-gating: the pre-F10 \`:(exclude)node_modules\` pathspec exits $LEGACY_RC here — \"${LEGACY_OUT%%$'\n'*}\")"
  else
    info "(canary, non-gating: the pre-F10 \`:(exclude)node_modules\` pathspec still exits 0 — F10 was version-specific)"
  fi
  git -C "$DRILL" reset -q >/dev/null 2>&1
fi

# ─────────────────────────────────────────────────────────────────────────────
# (e) Discovery floor / root-reroute canary. NOT a real collection: `vitest list`
#     only globs and loads config, it never runs a test body. What it catches is
#     discovery being silently rerouted or narrowed — a root vite/vitest config
#     with `root: 'web'` collapses discovery to ~1 file and still exits 0, and an
#     over-broad exclude quietly deletes coverage. Green tests are the suite's
#     job; this is the floor underneath them.
# ─────────────────────────────────────────────────────────────────────────────
hdr "e. discovery floor / root-reroute canary (>= $FLOOR test files)"
COLLECTED=0
if [ ! -x "$ROOT/node_modules/.bin/vitest" ]; then
  fail "node_modules/.bin/vitest missing — cannot check the discovery floor"
else
  "$ROOT/node_modules/.bin/vitest" list --filesOnly >"$WORK/list.txt" 2>"$WORK/list.err"; LIST_RC=$?
  DISCOVERED="$(as_int "$(grep -c . "$WORK/list.txt" 2>/dev/null | head -1 | tr -d ' ')")"
  if [ "$LIST_RC" -ne 0 ]; then
    fail "\`vitest list --filesOnly\` exited $LIST_RC"
    tail -n 8 "$WORK/list.err" | sed 's/^/       /'
  elif [ -z "$DISCOVERED" ]; then
    fail "could not count discovered test files"
  else
    COLLECTED="$DISCOVERED"
    if [ "$COLLECTED" -lt "$FLOOR" ]; then
      fail "discovery found $COLLECTED test files, floor is $FLOOR — discovery is broken (config reroute? over-broad exclude?)"
    else
      pass "discovery found $COLLECTED test files (floor $FLOOR)"
    fi
    if grep -q '\.claude/' "$WORK/list.txt"; then
      fail "discovery includes .claude/ paths — the root vitest.config.ts exclude is not in effect"
    fi
  fi
fi

# ─────────────────────────────────────────────────────────────────────────────
# (f) Clean tree — F5 + the repo-freeze law: `start` pins the base sha, and any
#     tracked-file edit during a live run poisons the round (W3-1 drift guard).
#     Running this LAST also re-proves that nothing above dirtied the repo.
# ─────────────────────────────────────────────────────────────────────────────
hdr "f. clean tree + executable identity"
DIRT="$(git status --porcelain 2>/dev/null)"; DIRT_RC=$?
if [ "$DIRT_RC" -ne 0 ]; then
  fail "\`git status --porcelain\` exited $DIRT_RC"
elif [ -z "$DIRT" ]; then
  pass "working tree clean at ${HEAD_SHA:0:12}"
else
  fail "working tree is dirty — commit, stash, or move edits to the scratchpad before \`start\`"
  printf '%s\n' "$DIRT" | sed 's/^/       /'
fi

# The commit sha does NOT identify what the run will execute: dist/ is gitignored
# and mutable, so a record binding only HEAD authorises whatever bytes are in
# dist/ when the slice script finally runs. Bind the built tree itself.
DIST_DIGEST="$(dogfood_dist_digest "$ROOT")"
if [ -z "$DIST_DIGEST" ]; then
  fail "could not digest dist/ — the executable tree cannot be bound to this record"
else
  pass "dist digest ${DIST_DIGEST:0:16}… (390-odd files, content+paths)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Verdict + provenance record. Only "pass" is accepted by the enforcement gate.
# ─────────────────────────────────────────────────────────────────────────────
T1=$(date +%s); ELAPSED=$((T1 - T0))
if [ "${#FAILURES[@]}" -gt 0 ]; then
  VERDICT="fail"
elif [ "${SKIP_BUILD:-}" = "1" ]; then
  VERDICT="diagnostic"
else
  VERDICT="pass"
fi

append_record() { # $1 = verdict to record
  node - "$RECORD" "$STARTED_AT" "$1" "$GIT_V" "$NODE_V" "$NPM_V" "$HEAD_SHA" "$BRANCH" \
    "$DOCTOR_OVERALL" "$COLLECTED" "$FLOOR" "$ELAPSED" "${#WARNINGS[@]}" "${#FAILURES[@]}" "${SKIP_BUILD:-0}" \
    "$DIST_DIGEST" "$COORDINATOR" "$IMPLEMENTOR" "$VERIFIER" "$CONFIG_SHA" <<'NODE'
const fs = require('node:fs');
const [record, at, verdict, git, node, npm, head, branch, doctor, collected, floor, elapsedS,
  warns, fails, skipBuild, distDigest, coordinator, implementor, verifier, configSha] = process.argv.slice(2);
const line = JSON.stringify({
  at, verdict, git, node, npm, head, branch,
  distDigest, coordinator, implementor, verifier, configSha,
  doctor: doctor || null,
  skipBuild: skipBuild === '1',
  collectedTestFiles: Number(collected) || 0, floor: Number(floor) || 0,
  elapsedS: Number(elapsedS) || 0, warnings: Number(warns) || 0, failures: Number(fails) || 0,
});
fs.appendFileSync(record, line + '\n');
process.stdout.write(line + '\n');
NODE
}
# Node's stack trace is noise here; the escalation below is the operator message.
append_record_quiet() { append_record "$1" 2>>"$WORK/record.err"; }

# A failed append is NOT a cosmetic problem. The gate reads the FILE, not this
# process's memory, so flipping VERDICT here would leave the previous PASS as the
# last record — and it would authorise the very run this battery just rejected.
# Escalate: write a fail record; failing that, destroy the log. The gate refuses
# on missing/empty/unreadable, which is the safe landing state.
if ! append_record_quiet "$VERDICT"; then
  echo
  echo "!! could not append the provenance record to $RECORD"
  [ -s "$WORK/record.err" ] && grep -m1 -E 'Error|EACCES|EPERM|ENOENT|ENOSPC|EROFS' "$WORK/record.err" | sed 's/^/     /'
  if append_record_quiet "fail"; then
    echo "!! wrote a FAIL record instead — the gate will refuse"
  elif { : 2>/dev/null > "$RECORD"; }; then
    echo "!! truncated $RECORD — no stale pass remains"
  elif rm -f "$RECORD" 2>/dev/null; then
    echo "!! removed $RECORD — no stale pass remains"
  else
    echo "!! COULD NOT INVALIDATE $RECORD — a stale PASS may still authorise a run. Delete it by hand NOW."
  fi
  echo "── PREFLIGHT FAILED (record not written) — do NOT start a run ──"
  exit 1
fi

# Belt to the containment refusal's suspenders: the append happens after the
# clean-tree check, so re-prove the tree did not change underneath it. Compare
# against the section-(f) snapshot, not against "clean" — an already-dirty tree
# has already failed (f), and what matters here is dirt this write INTRODUCED,
# which would make the record we just wrote false.
POST_DIRT="$(git status --porcelain 2>/dev/null)"
if [ "$POST_DIRT" != "$DIRT" ]; then
  echo
  echo "!! the provenance write dirtied the repo — invalidating the record just written"
  printf '%s\n' "$POST_DIRT" | sed 's/^/     /'
  append_record_quiet "fail" >/dev/null 2>&1 || { : 2>/dev/null > "$RECORD"; } || rm -f "$RECORD" 2>/dev/null
  echo "── PREFLIGHT FAILED (post-write dirt) — do NOT start a run ──"
  exit 1
fi

echo
echo "───────────────────────────────────────────────────────────────"
if [ "${#WARNINGS[@]}" -gt 0 ]; then
  echo " warnings (${#WARNINGS[@]}):"
  printf '   ! %s\n' "${WARNINGS[@]+"${WARNINGS[@]}"}"
fi
if [ "${#FAILURES[@]}" -gt 0 ]; then
  echo " FAILURES (${#FAILURES[@]}):"
  printf '   ✖ %s\n' "${FAILURES[@]+"${FAILURES[@]}"}"
  echo "── PREFLIGHT FAILED in ${ELAPSED}s (verdict=fail) — do NOT start a run ──"
  exit 1
fi
if [ "$VERDICT" = "diagnostic" ]; then
  echo "── PREFLIGHT DIAGNOSTIC in ${ELAPSED}s — checks passed but dist was NOT rebuilt."
  echo "   The enforcement gate REJECTS this record. Re-run without SKIP_BUILD before starting."
  exit 0
fi
echo "── PREFLIGHT PASSED in ${ELAPSED}s — cleared to start ──────────"
exit 0
