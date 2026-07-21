#!/usr/bin/env bash
#
# Dogfood START stage (§6A) — the coordinator drafts a testable spec from a
# PINNED plan section, then STOPS at the human-approval gate. This spawns the
# real coordinator adapter (a blocking turn) and exits at `awaiting_approval`;
# it never approves or implements anything.
#
# Parameters (env-overridable):
#   SECTION      required  plan section to spec, e.g. "§3A.1"
#   SLICE        required  one-line scope the coordinator must honour
#   PATHS        required  comma-list of files the implementor may touch
#   PLAN_SHA     optional  plan commit to pin (default: current HEAD)
#   COORDINATOR  optional  packed harness:model:effort (default claude:opus:xhigh)
#   HARNESS_HOME optional  run store (default ~/.harness)
#
# Output: prints the run id, spec version, spec hash + the exact approve/run
# commands, and writes a per-run manifest under $HARNESS_HOME/logs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

: "${HARNESS_HOME:=$HOME/.harness}"; export HARNESS_HOME
LOGDIR="${DOGFOOD_LOG_DIR:-$HARNESS_HOME/logs}"; mkdir -p "$LOGDIR"
CLI=(node "$ROOT/dist/cli/index.js")

SECTION="${SECTION:?set SECTION (e.g. §3A.1)}"
SLICE="${SLICE:?set SLICE (one-line scope)}"
PATHS="${PATHS:?set PATHS (files the implementor may touch)}"
PLAN_SHA="${PLAN_SHA:-$(git rev-parse HEAD)}"
COORDINATOR="${COORDINATOR:-claude:opus:xhigh}"

[ -f "$ROOT/dist/cli/index.js" ] || { echo "!! dist not built — run: npm run build" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
JSON="$LOGDIR/slice-$STAMP-start.json"
ERRLOG="$LOGDIR/slice-$STAMP-start.err.log"
MANIFEST="$LOGDIR/slice-$STAMP.manifest.json"

GOAL="Read docs/UI-IMPLEMENTATION-PLAN.md ${SECTION} at plan SHA ${PLAN_SHA}. \
Produce a testable spec whose acceptance criteria are exactly that section's \
acceptance bullets. Scope: only ${SLICE}; touch no files outside ${PATHS}."

echo "── dogfood START ──────────────────────────────────────────────"
echo " section     : ${SECTION} @ ${PLAN_SHA}"
echo " coordinator : ${COORDINATOR}"
echo " scope       : ${SLICE}"
echo " paths       : ${PATHS}"
echo " store       : ${HARNESS_HOME}"
echo " json/err    : ${JSON}  |  ${ERRLOG}"
echo " (spawns the real coordinator; blocks until awaiting_approval)"
echo "───────────────────────────────────────────────────────────────"

set +e
"${CLI[@]}" start --workspace . --coordinator "$COORDINATOR" --goal "$GOAL" --json \
  >"$JSON" 2>"$ERRLOG"
RC=$?
set -e

if [ "$RC" -ne 0 ]; then
  echo "!! start exited $RC — stderr tail:" >&2
  tail -n 20 "$ERRLOG" >&2
  echo "!! stdout (if any):" >&2
  cat "$JSON" >&2 || true
  exit "$RC"
fi

# Extract the fields the approve/run stage needs and record the manifest.
node - "$JSON" "$MANIFEST" "$SECTION" "$PLAN_SHA" "$COORDINATOR" "$GOAL" <<'NODE'
const fs = require('fs');
const [json, manifestPath, section, planSha, coordinator, goal] = process.argv.slice(2);
const o = JSON.parse(fs.readFileSync(json, 'utf8'));
const b = o.json ?? o;                    // --json prints the command body
const spec = b.spec ?? {};
const manifest = {
  section, planSha, coordinator, goal,
  baseSha: require('child_process').execSync('git rev-parse HEAD').toString().trim(),
  runId: b.runId, phase: b.phase,
  specVersionId: spec.specVersionId, specHash: spec.specHash, revision: spec.revision,
  proposedImplementor: spec.proposedImplementor, proposedVerifier: spec.proposedVerifier,
  criteria: spec.criteria ?? [],
};
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
const line = (s) => process.stdout.write(s + '\n');
line('');
line('✔ run ' + manifest.runId + ' → phase ' + manifest.phase);
line('  spec ' + manifest.specVersionId + ' (rev ' + manifest.revision + ')');
line('  hash ' + manifest.specHash);
line('  criteria: ' + (manifest.criteria.map((c) => c.id).join(', ') || '(none parsed)'));
line('  proposed implementor: ' + (manifest.proposedImplementor ?? '—'));
line('  proposed verifier   : ' + (manifest.proposedVerifier ?? '—'));
line('  manifest: ' + manifestPath);
line('');
line('next — review the spec, then approve the EXACT hash and run:');
line('  scripts/dogfood/run-slice.sh ' + manifest.runId + ' ' + manifest.specVersionId + ' ' + manifest.specHash);
NODE

echo "── coordinator done; run is awaiting_approval ──"
