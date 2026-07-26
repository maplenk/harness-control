#!/usr/bin/env bash
#
# Dogfood MERGE GATE (§6A "mandatory serial merge/rebuild gate").
#
# Between every dogfood run the plan requires, in order:
#   1. the HUMAN merges the verified commit (never automatic);
#   2. the full suite + typecheck pass on the MERGED tree;
#   3. `npm run build` regenerates dist/cli/index.js, so the NEXT run executes
#      the new harness binary rather than a stale one;
#   4. the working tree is clean;
#   5. the next run's manifest records the new base SHA.
#
# Skipping any step is how a later slice silently branches from an unmerged
# tree or runs an old binary, so this script performs them as one transaction:
# the merge is staged with --no-commit, every check runs against the merged
# working tree, and the merge is COMMITTED only if all of them pass. A failure
# leaves `main` exactly as it was.
#
# Usage:
#   scripts/dogfood/merge-gate.sh RUN_ID            # review only; merges nothing
#   CONFIRM=1 scripts/dogfood/merge-gate.sh RUN_ID  # perform the gate
#
# Env:
#   CONFIRM=1        actually merge (default: dry review, exit 0)
#   SUITE_FLOOR=N    minimum test FILES vitest must discover (default 103)
#   ALLOW_UNPROVEN=1 permit a merge_ready record whose verdict is not `passed`
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
: "${HARNESS_HOME:=$HOME/.harness}"; export HARNESS_HOME
: "${SUITE_FLOOR:=103}"
CLI=(node "$ROOT/dist/cli/index.js")

RUN_ID="${1:?usage: merge-gate.sh RUN_ID}"
LOGDIR="${DOGFOOD_LOG_DIR:-$HARNESS_HOME/logs}"; mkdir -p "$LOGDIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
GATELOG="$LOGDIR/merge-gate-$STAMP.log"

die() { echo "✗ $*" >&2; exit 1; }
step() { echo; echo "── $* ──"; }

# ---------------------------------------------------------------------------
# 0. Preconditions on the PRIMARY checkout, before anything is touched.
# ---------------------------------------------------------------------------
step "0. preconditions"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "not on main (on '$BRANCH') — the gate merges into main only"
[ -z "$(git status --porcelain)" ] || die "working tree is dirty; commit or stash first"
BASE_BEFORE="$(git rev-parse HEAD)"
echo "  main @ $BASE_BEFORE (clean)"

# ---------------------------------------------------------------------------
# 1. The run must actually be merge_ready, and its verdict must be `passed`.
#    A merge_ready phase is necessary, not sufficient: the engine emits a
#    readiness RECORD, and `ready:false` with blockers is not a pass.
#
#    FIELD NAMES ARE LOAD-BEARING HERE. They come from `mergeReadinessView`
#    (src/cli/commands.ts:1384) and are `ready` / `verifiedCommit` / `blockers`
#    / `specApprovedBy`. An earlier draft of this script guessed `verdict` and
#    `implementationCommit`; both are absent, so it would have refused a
#    genuinely ready run — a false refusal at the worst possible moment. If the
#    view changes, this parser must change with it, which is why the read below
#    fails LOUDLY on an unrecognised shape instead of defaulting.
# ---------------------------------------------------------------------------
step "1. run state"
STATUS_JSON="$LOGDIR/merge-gate-$STAMP-status.json"
"${CLI[@]}" status "$RUN_ID" --json >"$STATUS_JSON" 2>/dev/null \
  || die "cannot read status for $RUN_ID (is dist built?)"

# The readiness record does NOT come from `status`. `mergeReadinessView` is
# emitted only by `run` and `recheck` (commands.ts:1258/:1567); `status --json`
# has no `mergeReadiness` key at all. An earlier draft of this gate read it from
# `status` and therefore refused a genuinely `merge_ready` run as "ready=absent"
# — the same false-refusal failure as the earlier `verdict` guess, one layer up:
# right field names, wrong source.
#
# The durable record is the `verification.completed.passed` event payload, which
# is what the engine actually committed. Read it from a COPY of the store: a
# read-only sqlite3 connection fails outright between runs (WAL, no `-shm`), and
# a run-scoped CLI call would append `alert.delivered` to the run being gated.
SNAP="$(mktemp -d "${TMPDIR:-/tmp}/merge-gate-snap-XXXXXX")"
cp "$HARNESS_HOME/harness.db" "$SNAP/h.db"
for side in "-wal" "-shm"; do
  [ -f "$HARNESS_HOME/harness.db$side" ] && cp "$HARNESS_HOME/harness.db$side" "$SNAP/h.db$side"
done
READINESS_JSON="$LOGDIR/merge-gate-$STAMP-readiness.json"
sqlite3 -noheader "$SNAP/h.db" \
  "SELECT payload_json FROM events WHERE run_id='$RUN_ID' AND type='verification.completed.passed' ORDER BY sequence DESC LIMIT 1;" \
  >"$READINESS_JSON" 2>/dev/null || true
rm -rf "$SNAP"

# `read` returns non-zero at EOF, which `set -e` would treat as fatal, so the
# node side emits a trailing newline AND the read is guarded. Without both, the
# gate exits 1 here with no message.
read -r PHASE READY SIGNER COMMIT < <(node - "$STATUS_JSON" "$READINESS_JSON" <<'NODE'
const fs = require('fs');
const b = (o => o.json ?? o)(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')));
const raw = fs.readFileSync(process.argv[3], 'utf8').trim();
let mr;
if (raw !== '') {
  try { mr = JSON.parse(raw).mergeReadiness; } catch { mr = 'UNREADABLE'; }
}
// Distinguish "no readiness record yet" from "a record whose shape I cannot
// read" — the first is an ordinary not-ready state, the second is a bug in
// this parser and must never be reported as a verdict.
const ready = mr === undefined ? 'absent'
  : mr === 'UNREADABLE' || typeof mr !== 'object' ? 'UNPARSEABLE'
  : mr.ready === true ? 'true'
  : mr.ready === false ? 'false'
  : 'UNPARSEABLE';
const commit = (typeof mr === 'object' && mr !== null ? mr.verifiedCommit : undefined) ?? '-';
// The signer is on `status` itself, and is the authority here.
console.log([b.phase ?? '?', ready, b.specApprovedBy ?? '-', commit || '-'].join(' '));
NODE
) || true
[ -n "${PHASE:-}" ] || die "could not parse run status from $STATUS_JSON"
echo "  phase=$PHASE  ready=$READY  specApprovedBy=$SIGNER  verifiedCommit=$COMMIT"
[ "$READY" != "UNPARSEABLE" ] \
  || die "the readiness record has a shape this gate cannot read — mergeReadinessView changed.
     Fix the parser in this script rather than overriding; a gate that guesses is worse than none."
[ "$PHASE" = "merge_ready" ] || die "phase is '$PHASE', not merge_ready — nothing to gate"
if [ "$READY" != "true" ] && [ "${ALLOW_UNPROVEN:-0}" != "1" ]; then
  die "the readiness record says ready=$READY. Blockers are listed in $STATUS_JSON.
     Set ALLOW_UNPROVEN=1 only with a written reason."
fi
# B2: say who approved the INTENT. Not a blocker — an auto-approved run can be
# perfectly merge-ready — but the human merging must not have to dig for it.
case "$SIGNER" in
  auto)    echo "  ! spec approval was AUTO — the ENGINE approved this spec; NO human reviewed the";
           echo "    INTENT. Review WHAT was built, not only that it verified.";;
  unknown) echo "  ! spec approval is UNKNOWN — the event log cannot substantiate who approved this.";
           echo "    That is worse news than 'the engine did'. Read the run's approval events before merging.";;
esac

# ---------------------------------------------------------------------------
# 2. Locate the verified commit. The engine names assignment branches
#    harness/assignment/asg_<runid>; trust the branch only if it CONTAINS the
#    commit the readiness record names.
# ---------------------------------------------------------------------------
step "2. verified commit"
ASG_BRANCH="$(git for-each-ref --format='%(refname:short)' 'refs/heads/harness/assignment/*' \
  | grep -F "${RUN_ID#run_}" | head -1 || true)"
[ -n "$ASG_BRANCH" ] || die "no assignment branch found for $RUN_ID"
BRANCH_TIP="$(git rev-parse "$ASG_BRANCH")"
echo "  branch $ASG_BRANCH @ $BRANCH_TIP"
if [ "$COMMIT" != "-" ] && [ -n "$COMMIT" ]; then
  git merge-base --is-ancestor "$COMMIT" "$BRANCH_TIP" \
    || die "the verified commit $COMMIT is NOT an ancestor of $ASG_BRANCH — refusing"
  [ "$COMMIT" = "$BRANCH_TIP" ] \
    || echo "  ! branch tip is AHEAD of the verified commit; merging the VERIFIED one"
  MERGE_REF="$COMMIT"
else
  echo "  ! readiness record names no commit; merging the branch tip"
  MERGE_REF="$BRANCH_TIP"
fi

step "3. what would land"
git diff --stat "$BASE_BEFORE...$MERGE_REF" | tail -30
CHANGED="$(git diff --name-only "$BASE_BEFORE...$MERGE_REF" | wc -l | tr -d ' ')"
echo "  $CHANGED file(s)"

if [ "${CONFIRM:-0}" != "1" ]; then
  echo
  echo "── review only (CONFIRM is not 1) — nothing merged ──"
  echo "   full diff : git diff $BASE_BEFORE...$MERGE_REF"
  echo "   to gate   : CONFIRM=1 scripts/dogfood/merge-gate.sh $RUN_ID"
  exit 0
fi

# ---------------------------------------------------------------------------
# 4. Stage the merge WITHOUT committing, so every check below runs against the
#    merged tree and a failure can be undone with `git merge --abort`.
# ---------------------------------------------------------------------------
step "4. staging the merge (--no-commit)"
if ! git merge --no-ff --no-commit "$MERGE_REF" >>"$GATELOG" 2>&1; then
  git merge --abort 2>/dev/null || true
  die "merge conflicted — main untouched. See $GATELOG"
fi
echo "  merged into the working tree, not yet committed"

abort_gate() {
  echo
  echo "── ROLLING BACK ──"
  git merge --abort 2>/dev/null || git reset --hard "$BASE_BEFORE"
  git status --porcelain | head
  die "$1"
}

# ---------------------------------------------------------------------------
# 5. Gate steps 2–4: typecheck, discovery floor, full suite, build, clean tree.
#    The discovery floor is the guard under the vitest `.claude` exclude — a
#    config change that reroutes collection still exits 0, so a bare green bar
#    does not prove the suite ran.
# ---------------------------------------------------------------------------
step "5a. typecheck"
npm run typecheck >>"$GATELOG" 2>&1 || abort_gate "typecheck FAILED on the merged tree — see $GATELOG"
echo "  0 errors"

step "5b. suite discovery floor (>= $SUITE_FLOOR files)"
FILES="$(npx vitest list --filesOnly 2>/dev/null | grep -c . || echo 0)"
echo "  discovered $FILES test file(s)"
[ "$FILES" -ge "$SUITE_FLOOR" ] \
  || abort_gate "discovery collapsed to $FILES files (floor $SUITE_FLOOR) — a config change rerouted collection"

step "5c. full suite"
SUITELOG="$LOGDIR/merge-gate-$STAMP-suite.log"
if npx vitest run >"$SUITELOG" 2>&1; then
  grep -E "^ *Test Files|^ *Tests " "$SUITELOG" | sed 's/^/  /'
else
  grep -E "^ *Test Files|^ *Tests |FAIL " "$SUITELOG" | head -30 | sed 's/^/  /'
  abort_gate "suite FAILED on the merged tree — see $SUITELOG"
fi

step "5d. build"
npm run build >>"$GATELOG" 2>&1 || abort_gate "build FAILED on the merged tree — see $GATELOG"
echo "  dist/cli/index.js regenerated — the next run executes THIS binary"

# ---------------------------------------------------------------------------
# 6. All checks passed against the merged tree. Commit the merge.
# ---------------------------------------------------------------------------
step "6. committing the merge"
git commit --no-edit >>"$GATELOG" 2>&1 || abort_gate "merge commit failed — see $GATELOG"
BASE_AFTER="$(git rev-parse HEAD)"
echo "  main @ $BASE_AFTER"

step "7. clean tree"
# dist/ is gitignored, so a rebuild must not dirty the tree. If it does, dist is
# tracked somewhere it should not be — that is a real finding, not a nuisance.
if [ -n "$(git status --porcelain)" ]; then
  git status --porcelain | head | sed 's/^/  /'
  die "tree is dirty AFTER the merge commit — resolve before the next run (merge is committed at $BASE_AFTER)"
fi
echo "  clean"

# ---------------------------------------------------------------------------
# 8. Record the new base SHA for the next run's manifest.
# ---------------------------------------------------------------------------
MANIFEST="$LOGDIR/merge-gate-$STAMP.manifest.json"
node - "$MANIFEST" "$RUN_ID" "$BASE_BEFORE" "$BASE_AFTER" "$MERGE_REF" "$ASG_BRANCH" "$READY" "$SIGNER" "$FILES" <<'NODE'
const fs = require('fs');
const [out, runId, baseBefore, baseAfter, verified, branch, ready, signer, files] = process.argv.slice(2);
fs.writeFileSync(out, JSON.stringify({
  gate: 'dogfood-merge-gate', runId,
  readinessReady: ready === 'true',
  // Recorded, not just displayed: months from now the question "did a human
  // review the intent of this commit?" is answerable only from here.
  specApprovedBy: signer,
  baseShaBefore: baseBefore, baseShaAfter: baseAfter,
  verifiedCommit: verified, assignmentBranch: branch,
  testFilesDiscovered: Number(files),
}, null, 2));
NODE

echo
echo "✔ MERGE GATE PASSED"
echo "  base SHA for the next run : $BASE_AFTER"
echo "  manifest                  : $MANIFEST"
echo "  gate log                  : $GATELOG"
echo
echo "next — push, then start the next slice with PLAN_SHA=$BASE_AFTER"
