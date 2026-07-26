#!/usr/bin/env bash
#
# Dogfood START stage (§6A) — the coordinator drafts a testable spec from a
# PINNED plan section, then STOPS at the approval gate. This spawns the real
# coordinator adapter (a blocking turn) and exits; it never approves or
# implements anything ITSELF.
#
# Where it stops depends on the run's PINNED approval mode (B2), which comes
# from the config passed to `start` and is immutable for the run's life:
#   approval:'human' (the default, scripts/dogfood/dogfood.config.json)
#       → the run parks at `awaiting_approval`; a person runs `harness approve`.
#   approval:'auto'  (scripts/dogfood/dogfood.auto.config.json)
#       → the ENGINE signs the drafted hash inside the same transaction that
#         persists the draft, and this exits with the run already at `approved`.
# This script does not choose; it REPORTS what the engine did, read back from
# the engine's own `start --json` output.
#
# Parameters (env-overridable):
#   SECTION      required  plan section to spec, e.g. "§3A.1"
#   SLICE        required  one-line scope the coordinator must honour
#   PATHS        required  comma-list of files the implementor may touch
#   PLAN_SHA     optional  plan commit to pin (default: current HEAD)
#   COORDINATOR  optional  packed harness:model:effort (default claude:opus:xhigh)
#   CONFIG       optional  engine config file (default dogfood.config.json; "" = engine defaults)
#   MANIFEST_OUT optional  ALSO write the manifest here (for scripted chaining)
#   HARNESS_HOME optional  run store (default ~/.harness)
#
# Output: prints the run id, spec version, spec hash + the exact next command,
# and writes a per-run manifest under $HARNESS_HOME/logs.
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
# Per-run engine config (F4 per-role memory budget, etc.). Default: the committed
# dogfood config (implementor RSS budget pinned to 2048 MB). Set CONFIG="" to run
# on engine defaults. --config at `start` pins it into the run's persisted config,
# so the `run` stage inherits it (no need to pass it to run-slice.sh).
CONFIG="${CONFIG-$ROOT/scripts/dogfood/dogfood.config.json}"

[ -f "$ROOT/dist/cli/index.js" ] || { echo "!! dist not built — run: npm run build" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
JSON="$LOGDIR/slice-$STAMP-start.json"
ERRLOG="$LOGDIR/slice-$STAMP-start.err.log"
MANIFEST="${MANIFEST_OUT:-$LOGDIR/slice-$STAMP.manifest.json}"

# --config forwarding: forward the config file if set + present; record its hash.
CONFIG_ARGS=()
CONFIG_SHA=""
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
  CONFIG_ARGS=(--config "$CONFIG")
  CONFIG_SHA="$(shasum -a 256 "$CONFIG" | awk '{print $1}')"
elif [ -n "$CONFIG" ]; then
  echo "!! CONFIG is set but not a readable file: $CONFIG" >&2; exit 1
fi

# Standing criterion-authoring rules, appended to EVERY slice goal.
#
# These are not style advice — each one killed a paying run. They live here
# rather than in the per-slice SLICE text because relying on the operator to
# retype them is exactly the omission that costs a run: run_60ccbfda drafted
# five criteria that no implementor could ever satisfy, and was cancelled.
#
# L12: the host gate proves a criterion only when every declared command exits
#      the code the criterion expects (0 unless declared otherwise). `grep`
#      exits 1 when it finds NOTHING — which is the pass condition for every
#      absence check — so an undeclared absence criterion is unprovable.
# L13: the coordinator never executes what it drafts, and the implementor
#      cannot repair it, because commands are frozen under the approved hash.
#      A command that cannot run burns every remediation round.
CRITERION_LAWS="CRITERION-AUTHORING RULES (each of these killed a previous run; violating one wastes the whole slice): \
(1) Every verification command must EXIT 0 when the criterion is satisfied. A criterion that asserts something is ABSENT \
must not rely on a bare \`grep\` — grep exits 1 when it finds nothing, and a non-zero exit does not prove the criterion. \
Write the check so success is exit 0, e.g. \`test -z \"\$(grep -REl PATTERN PATH || true)\"\`. \
(2) NEVER write \`! grep ...\` to force a zero exit: that also exits 0 when grep FAILS with exit 2 (unreadable path, bad \
regex), turning 'I could not determine this' into 'this is false'. \
(3) Every command must be executable AS WRITTEN against the versions actually installed in this repo. Check flags against \
the installed major version before you declare a command — e.g. Vite 7 takes a POSITIONAL root (\`vite build web\`) and \
ERRORS on \`--root\`. Prefer commands you can reason about exactly; when unsure of a flag, use a simpler form. \
(4) Every criterion must be satisfiable by EDITING FILES. Never write a criterion that asks anyone to re-run something, \
provide evidence, or change the environment — the implementor can only edit code, and the commands themselves are frozen \
under the approved spec hash."

GOAL="Read docs/UI-IMPLEMENTATION-PLAN.md ${SECTION} at plan SHA ${PLAN_SHA}. \
Produce a testable spec whose acceptance criteria are exactly that section's \
acceptance bullets. Scope: only ${SLICE}; touch no files outside ${PATHS}. \
${CRITERION_LAWS}"

echo "── dogfood START ──────────────────────────────────────────────"
echo " section     : ${SECTION} @ ${PLAN_SHA}"
echo " coordinator : ${COORDINATOR}"
echo " config      : ${CONFIG:-<engine defaults>}${CONFIG_SHA:+  (sha256 ${CONFIG_SHA:0:12}…)}"
echo " scope       : ${SLICE}"
echo " paths       : ${PATHS}"
echo " store       : ${HARNESS_HOME}"
echo " json/err    : ${JSON}  |  ${ERRLOG}"
echo " (spawns the real coordinator; blocks until awaiting_approval)"
echo "───────────────────────────────────────────────────────────────"
echo
echo "GOAL (verbatim, exactly what the coordinator is told):"
printf '%s\n' "$GOAL" | fold -s -w 100 | sed 's/^/  | /'
echo

# A coordinator turn is a real spend. DRY_RUN=1 prints the goal and stops, so
# the operator can read what will be asked before paying for it.
if [ "${DRY_RUN:-0}" = "1" ]; then
  echo "── DRY_RUN=1 — nothing spawned, no run created ──"
  exit 0
fi

set +e
"${CLI[@]}" start --workspace . --coordinator "$COORDINATOR" \
  ${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"} --goal "$GOAL" --json \
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
node - "$JSON" "$MANIFEST" "$SECTION" "$PLAN_SHA" "$COORDINATOR" "$GOAL" "$CONFIG" "$CONFIG_SHA" <<'NODE'
const fs = require('fs');
const [json, manifestPath, section, planSha, coordinator, goal, config, configSha] = process.argv.slice(2);
const o = JSON.parse(fs.readFileSync(json, 'utf8'));
const b = o.json ?? o;                    // --json prints the command body
const spec = b.spec ?? {};
// B2: WHO signed, read back from the ENGINE's own output — never inferred from
// "we passed the auto config, so it must be auto". `start --json` emits an
// `approval` object only when the engine actually bound the drafted hash
// itself; its absence means the run is still at the human gate.
const approval = b.approval;
const manifest = {
  section, planSha, coordinator, goal,
  ...(config ? { config, configSha } : {}),
  baseSha: require('child_process').execSync('git rev-parse HEAD').toString().trim(),
  runId: b.runId, phase: b.phase,
  approvalMode: approval ? approval.mode : 'human',
  autoApproved: Boolean(approval && approval.mode === 'auto' && b.phase === 'approved'),
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
line('  base sha: ' + manifest.baseSha + '   (F5: must equal current HEAD)');
line('  config: ' + (config || '(engine defaults)') + (configSha ? '  sha256=' + configSha.slice(0, 12) + '…' : ''));
line('  criteria: ' + (manifest.criteria.map((c) => c.id).join(', ') || '(none parsed)'));
line('  proposed implementor: ' + (manifest.proposedImplementor ?? '—'));
line('  proposed verifier   : ' + (manifest.proposedVerifier ?? '—'));
line('  manifest: ' + manifestPath);
line('  approval: ' + manifest.approvalMode + (manifest.autoApproved ? ' — ENGINE-SIGNED, no human reviewed this spec' : ''));
line('');
// The `next` line follows the ENGINE's state. An auto-approved run has already
// passed T1; still telling the operator to "approve the EXACT hash" would send
// them into a command T1's own precondition rejects.
if (manifest.autoApproved) {
  line('next — the spec is ALREADY approved (approvedBy:auto). Read the criteria above, then:');
  line('  scripts/dogfood/run-slice.sh ' + manifest.runId + ' ' + manifest.specVersionId + ' ' + manifest.specHash);
  line('  (run-slice.sh skips `approve` on its own — it reads the run\'s phase + bound hash.)');
} else {
  line('next — review the spec, then approve the EXACT hash and run:');
  line('  scripts/dogfood/run-slice.sh ' + manifest.runId + ' ' + manifest.specVersionId + ' ' + manifest.specHash);
}
NODE

PHASE_OUT="$(node -e 'const o=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
  process.stdout.write(String((o.json??o).phase??"?"));' "$JSON")"
echo "── coordinator done; run is ${PHASE_OUT} ──"
