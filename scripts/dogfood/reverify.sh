#!/usr/bin/env bash
# Re-verify grok's committed work (ef952b1) through the F7-fixed engine.
#
# The original run_8aa51aea false-negatived ONLY because worktrees had no
# node_modules (verify commands exited 127). F7 (landed on main as 5669d22) now
# provisions a real node_modules at the verify boundary, so a resume should let
# the verifier actually run the commands and reach merge_ready.
#
# Usage:  bash scripts/dogfood/reverify.sh
# Watch:  bash scripts/dogfood/watch.sh         (in another terminal)
set -uo pipefail

REPO="/Users/tagtaste/Documents/QBApps/harness-orchestration"
RUN="run_8aa51aea-2bf0-4906-afba-7f0bdc8ba7e3"
WT="$REPO.worktrees/assignment-asg_run_8aa51aea-2bf0-4906-afba-7f0bdc8ba7e3"
LOGDIR="${HARNESS_HOME:-$HOME/.harness}/logs"; mkdir -p "$LOGDIR"
LOG="$LOGDIR/reverify.log"
cd "$REPO" || { echo "repo not found"; exit 1; }

echo "== 1/4  ensure dist is the F7-fixed build =="
# REMINDER (advisory, not enforced): this script RESUMES a run — it spends and it
# mutates, exactly like `run`. Run `bash scripts/dogfood/preflight.sh` first; its
# section (d) is the check that the engine can commit at all on this machine.
npm run build >/dev/null 2>&1 && echo "   dist rebuilt (F7 present)" || { echo "   BUILD FAILED"; exit 1; }

echo "== 2/4  drop the manual salvage-proof node_modules symlink =="
# F7 fails closed on a symlinked node_modules; remove it so F7's OWN provisioning runs.
if [ -L "$WT/node_modules" ]; then
  rm -v "$WT/node_modules"
elif [ -e "$WT/node_modules" ]; then
  echo "   node_modules is a real dir (leaving it; F7 short-circuits on a valid tree)"
else
  echo "   no node_modules present (F7 will provision it)"
fi

echo "== 3/4  current run state =="
node ./dist/cli/index.js status "$RUN" --json 2>/dev/null | head -30 \
  || echo "   (status unavailable — resume will report the durable state)"

echo "== 4/4  resume through the F7-fixed engine (gated above) =="
echo "   (F7 provisions node_modules at the verify boundary; watch for merge_ready)"
node ./dist/cli/index.js resume "$RUN" --json 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
echo
echo "RESUME_RC=$rc   (log: $LOG)"
echo "If it reports the run is terminal / remediation-exhausted, the fix is proven but the"
echo "OLD run can't advance — start a FRESH slice instead (scripts/dogfood/start-slice.sh)."
exit "$rc"
