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

. "$ROOT/scripts/dogfood/lib.sh"

: "${HARNESS_HOME:=$HOME/.harness}"; export HARNESS_HOME
LOGDIR="${DOGFOOD_LOG_DIR:-$HARNESS_HOME/logs}"; mkdir -p "$LOGDIR"
CLI=(node "$ROOT/dist/cli/index.js")

# Independent containment refusal (also enforced by preflight and the gate): the
# CLI is about to create the run store, which must not be inside the repo.
CONTAINMENT="$(dogfood_require_containment "$ROOT" "$HARNESS_HOME" "$LOGDIR")" || { echo "!! ${CONTAINMENT#!}" >&2; exit 1; }

# L11 ENFORCEMENT: never spend a coordinator dollar without a fresh PASSING
# preflight — same HEAD, same dist digest, same toolchain, same resolved roles,
# same effective config, same store/log, valid attempt claim, <30 min old. The
# gate rejects "diagnostic" records, so SKIP_BUILD=1 cannot slip past it. It runs
# BEFORE the role resolution below deliberately: the gate re-resolves the same
# values itself from the same env, via the same lib.sh helpers. No RUN_ID here —
# `start` is what PINS the config, so the ambient CONFIG is the right binding.
bash "$ROOT/scripts/dogfood/require-preflight.sh" || exit 1

SECTION="${SECTION:?set SECTION (e.g. §3A.1)}"
SLICE="${SLICE:?set SLICE (one-line scope)}"
PATHS="${PATHS:?set PATHS (files the implementor may touch)}"
PLAN_SHA="${PLAN_SHA:-$(git rev-parse HEAD)}"
# Roles and per-run engine config come from lib.sh — the SAME resolution the
# preflight battery gated doctor on and the gate re-checked. Restating the
# defaults here is what let an overridden role dispatch an unchecked adapter.
# (COORDINATOR default claude:opus:xhigh; CONFIG defaults to the committed
# dogfood config with the implementor RSS budget pinned to 2048 MB — set
# CONFIG="" for engine defaults. --config at `start` pins it into the run's
# persisted config, so the `run` stage inherits it.)
dogfood_resolve_roles
dogfood_resolve_config "$ROOT"

[ -f "$ROOT/dist/cli/index.js" ] || { echo "!! dist not built — run: npm run build" >&2; exit 1; }

STAMP="$(date +%Y%m%d-%H%M%S)"
JSON="$LOGDIR/slice-$STAMP-start.json"
ERRLOG="$LOGDIR/slice-$STAMP-start.err.log"
MANIFEST="$LOGDIR/slice-$STAMP.manifest.json"

# --config forwarding: forward the config file if set + present; record its hash.
CONFIG_ARGS=()
CONFIG_SHA=""
if [ -n "$CONFIG" ] && [ -f "$CONFIG" ]; then
  CONFIG_ARGS=(--config "$CONFIG")
  CONFIG_SHA="$(shasum -a 256 "$CONFIG" | awk '{print $1}')"
elif [ -n "$CONFIG" ]; then
  echo "!! CONFIG is set but not a readable file: $CONFIG" >&2; exit 1
fi

GOAL="Read docs/UI-IMPLEMENTATION-PLAN.md ${SECTION} at plan SHA ${PLAN_SHA}. \
Produce a testable spec whose acceptance criteria are exactly that section's \
acceptance bullets. Scope: only ${SLICE}; touch no files outside ${PATHS}."

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
const manifest = {
  section, planSha, coordinator, goal,
  ...(config ? { config, configSha } : {}),
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
line('  base sha: ' + manifest.baseSha + '   (F5: must equal current HEAD)');
line('  config: ' + (config || '(engine defaults)') + (configSha ? '  sha256=' + configSha.slice(0, 12) + '…' : ''));
line('  criteria: ' + (manifest.criteria.map((c) => c.id).join(', ') || '(none parsed)'));
line('  proposed implementor: ' + (manifest.proposedImplementor ?? '—'));
line('  proposed verifier   : ' + (manifest.proposedVerifier ?? '—'));
line('  manifest: ' + manifestPath);
line('');
line('next — review the spec, then approve the EXACT hash and run:');
line('  scripts/dogfood/run-slice.sh ' + manifest.runId + ' ' + manifest.specVersionId + ' ' + manifest.specHash);
NODE

echo "── coordinator done; run is awaiting_approval ──"
