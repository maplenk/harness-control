#!/usr/bin/env bash
#
# Shared resolution + digest + containment helpers for the dogfood scripts.
#
# WHY THIS FILE EXISTS: the preflight battery and the enforcement gate only mean
# something if they bind the SAME things the spend paths will actually execute.
# When `start-slice.sh` resolved its own role defaults and `preflight.sh`
# hard-coded a different set, an `IMPLEMENTOR=opencode:…` run dispatched an
# adapter the battery had declared "unused and not gating". Every fact the record
# binds is resolved here, once, and sourced by all four scripts, so the gate and
# the run can no longer disagree about what "current" means.
#
# Sourced by: preflight.sh · require-preflight.sh · start-slice.sh · run-slice.sh
# Never executed directly.
#
# Helpers that can fail print a message starting with "!" on stdout and exit 1,
# so callers can surface the reason instead of guessing from an empty string.

# ── Role profiles ────────────────────────────────────────────────────────────
# The packed `harness:model:effort` tokens the slice scripts dispatch. These
# defaults are the single source of truth; the slice scripts must not restate
# them. Env overrides are honoured, and the gate binds whatever was resolved.
dogfood_resolve_roles() {
  COORDINATOR="${COORDINATOR:-claude:opus:xhigh}"
  IMPLEMENTOR="${IMPLEMENTOR:-grok:grok-build:high}"
  VERIFIER="${VERIFIER:-codex:gpt-5.6-sol:xhigh}"
}

# The harness id of a packed role token (`claude:opus:xhigh` → `claude`).
dogfood_harness_of() { printf '%s' "${1%%:*}"; }

# ── Engine config ────────────────────────────────────────────────────────────
# `${CONFIG-default}` (not `:-`) is deliberate and load-bearing: CONFIG unset
# means "use the committed dogfood config", CONFIG="" means "engine defaults".
# $1 = repo root.
dogfood_resolve_config() {
  CONFIG="${CONFIG-$1/scripts/dogfood/dogfood.config.json}"
}

# The sha256 of the config FILE — display only. Identity comparisons use the
# EFFECTIVE config below, because that is what the engine actually runs on.
dogfood_config_sha() {
  if [ -z "${1:-}" ]; then printf 'engine-defaults'
  elif [ -f "$1" ]; then shasum -a 256 "$1" 2>/dev/null | awk '{print $1}'
  else printf 'MISSING'
  fi
}

# sha256 over the canonical form of the EFFECTIVE EngineConfig a fresh `start`
# would pin for this env — i.e. the parsed config file, or DEFAULT_ENGINE_CONFIG
# when CONFIG="". Comparing raw file bytes is not enough: the CLI persists the
# PARSED config at `start` and ignores $CONFIG afterwards, so file-sha equality
# says nothing about what an existing run executes on (see
# dogfood_run_config_sha). $1 = repo root, $2 = resolved config path (may be "").
dogfood_effective_config_sha() {
  node - "$1" "${2:-}" <<'NODE'
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const [root, configPath] = process.argv.slice(2);
const canonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
};
(async () => {
  const loader = await import(pathToFileURL(path.join(root, 'dist/config/loader.js')).href);
  let cfg;
  if (configPath === '') {
    cfg = loader.DEFAULT_ENGINE_CONFIG;
  } else {
    const r = loader.loadEngineConfigFromFile(configPath);
    if (r.ok !== true) { process.stdout.write(`!the engine config is invalid: ${configPath}`); process.exit(1); }
    cfg = r.value;
  }
  process.stdout.write(require('node:crypto').createHash('sha256').update(canonical(cfg)).digest('hex'));
})().catch((e) => { process.stdout.write(`!cannot compute the effective config: ${(e && e.message) || e}`); process.exit(1); });
NODE
}

# sha256 over the canonical form of the config a run ACTUALLY executes on: the
# `run_config` projection persisted at `start`. Read-only, direct SQL — never
# `openDatabase`, which runs migrations (a write) on open. $1 = root, $2 = store
# home, $3 = run id.
dogfood_run_config_sha() {
  node - "$1" "$2" "$3" <<'NODE'
const path = require('node:path');
const [root, home, runId] = process.argv.slice(2);
const canonical = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
};
let Database;
try { Database = require(path.join(root, 'node_modules/better-sqlite3')); }
catch (e) { process.stdout.write(`!cannot load better-sqlite3: ${e.message}`); process.exit(1); }
let db;
try { db = new Database(path.join(home, 'harness.db'), { readonly: true, fileMustExist: true }); }
catch (e) { process.stdout.write(`!cannot open the run store read-only: ${e.message}`); process.exit(1); }
try {
  const row = db.prepare(
    "SELECT state_json FROM run_projections WHERE run_id = ? AND projection_name = 'run_config'",
  ).get(runId);
  if (row === undefined) { process.stdout.write(`!run ${runId} has no persisted engine config`); process.exit(1); }
  process.stdout.write(
    require('node:crypto').createHash('sha256').update(canonical(JSON.parse(row.state_json))).digest('hex'),
  );
} catch (e) { process.stdout.write(`!cannot read the persisted run config: ${e.message}`); process.exit(1); }
finally { try { db.close(); } catch { /* ignore */ } }
NODE
}

# ── dist digest ──────────────────────────────────────────────────────────────
# sha256 over the whole built tree — every relative path AND every file's
# content, in sorted order. HEAD does not cover this: dist/ is gitignored and
# mutable, so a record that binds only the commit authorises whatever bytes
# happen to be in dist/ when the slice script finally runs. That is the same
# stale-dist class that opened this project.
#
# The walk uses lstat and REFUSES anything that is not a regular file or a
# directory. Skipping such entries was a hole: `isDirectory()`/`isFile()` are
# both false for a symlink, `npm run build` does not clean dist/, so a
# pre-existing symlinked `dist/cli` survived the build — Node followed it at
# require time while the digest omitted the link AND its target, leaving the
# digest identical when the target changed. A tsc build never emits a symlink,
# socket, fifo or device, so refusing is both simpler and correct: an entry we
# cannot account for makes the digest a lie.
# $1 = repo root.
dogfood_dist_digest() {
  node - "$1/dist" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.argv[2];
const files = [];
let refusal = null;
const describe = (st) =>
  st.isSymbolicLink() ? 'symlink'
  : st.isBlockDevice() ? 'block device'
  : st.isCharacterDevice() ? 'character device'
  : st.isFIFO() ? 'fifo'
  : st.isSocket() ? 'socket'
  : 'unknown entry type';
(function walk(dir) {
  if (refusal !== null) return;
  let entries;
  try { entries = fs.readdirSync(dir); } catch (e) { refusal = `cannot read ${dir}: ${e.message}`; return; }
  for (const name of entries) {
    if (refusal !== null) return;
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch (e) { refusal = `cannot lstat ${path.relative(root, p)}: ${e.message}`; return; }
    if (st.isDirectory()) walk(p);
    else if (st.isFile()) files.push(p);
    else refusal = `dist/${path.relative(root, p)} is a ${describe(st)} — a build never produces one, and its bytes cannot be bound`;
  }
})(root);
if (refusal !== null) { process.stdout.write(`!${refusal}`); process.exit(1); }
if (files.length === 0) { process.stdout.write('!dist/ is missing or empty — nothing to bind'); process.exit(1); }
files.sort();
const h = crypto.createHash('sha256');
for (const f of files) {
  h.update(path.relative(root, f));
  h.update('\0');
  h.update(crypto.createHash('sha256').update(fs.readFileSync(f)).digest());
  h.update('\0');
}
process.stdout.write(h.digest('hex'));
NODE
}

# ── Path canonicalisation + containment ──────────────────────────────────────
# Canonicalise a path by walking it COMPONENT BY COMPONENT, resolving symlinks
# as it goes. `path.resolve()` cannot be used first: it collapses `..`
# lexically, so `link/../x` normalises to `x` before the link is followed, and a
# path that lands inside the repo can be classified as outside it. Non-existent
# trailing components are appended literally (the dir may not be created yet).
# $1 = path. Prints the canonical absolute path.
dogfood_canonical_path() {
  node - "$1" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const input = process.argv[2];
const abs = path.isAbsolute(input) ? input : path.join(process.cwd(), input);
let cur = path.parse(abs).root;
for (const part of abs.split(path.sep)) {
  if (part === '' || part === '.') continue;
  if (part === '..') {
    try { cur = fs.realpathSync(cur); } catch { /* keep what we have */ }
    cur = path.dirname(cur);
    continue;
  }
  const next = path.join(cur, part);
  let st;
  try { st = fs.lstatSync(next); } catch { cur = next; continue; }
  if (st.isSymbolicLink()) {
    let target;
    try { target = fs.readlinkSync(next); } catch { cur = next; continue; }
    const joined = path.isAbsolute(target) ? target : path.join(cur, target);
    try { cur = fs.realpathSync(joined); } catch { cur = path.normalize(joined); }
  } else {
    cur = next;
  }
}
process.stdout.write(cur);
NODE
}

# Exit 0 if $1 resolves INSIDE $2, using the component-wise canonicaliser above.
dogfood_path_inside() {
  local candidate root rel
  candidate="$(dogfood_canonical_path "$1")"
  root="$(dogfood_canonical_path "$2")"
  [ -n "$candidate" ] && [ -n "$root" ] || return 0   # cannot prove outside → treat as inside (fail closed)
  case "$candidate" in
    "$root") return 0 ;;
    "$root"/*) return 0 ;;
    *) return 1 ;;
  esac
}

# The containment refusal, shared by the battery, the gate AND both spend paths.
# The store and log dir must live outside the repo: the CLI writes harness.db and
# artifacts into the store, and preflight appends its provenance record to the
# log dir. Either landing inside the repo dirties the tree, which fails the NEXT
# run's clean-tree check — and pointing one at an ignored directory would hide it
# from `git status` entirely. Checking this only in preflight was not enough: a
# valid record stored in an external log dir could be reused while HARNESS_HOME
# was repointed into the repo. $1 = repo root, $2 = store home, $3 = log dir.
# Prints a reason and returns 1 on refusal.
dogfood_require_containment() {
  if dogfood_path_inside "$2" "$1"; then
    printf '!HARNESS_HOME resolves inside the repo (%s) — refusing: run artifacts would dirty the tree' "$2"
    return 1
  fi
  if dogfood_path_inside "$3" "$1"; then
    printf '!the log dir resolves inside the repo (%s) — refusing: the provenance record would dirty the tree' "$3"
    return 1
  fi
  return 0
}

# ── Attempt claim ────────────────────────────────────────────────────────────
# A durable marker OUTSIDE the log dir, written by preflight and required by the
# gate. It exists because the provenance log alone is fail-open at its last rung:
# if the record file AND its directory are both unwritable, a failing preflight
# cannot overwrite or delete the stale PASS, and the gate would authorise a run
# the battery had just rejected. The claim is written FIRST, from a different
# location, and carries the attempt's identity; a stale record's attemptId then
# no longer matches the current claim, so the gate refuses.
#
# RESIDUAL, stated honestly: this REDUCES the surface, it does not eliminate it.
# If BOTH the claim path and the log dir are unwritable, preflight fails loudly
# but the stale pair survives and would still authorise. Defeating it requires
# deliberately making two separate locations immutable, which is operator action,
# not plausible accident. That is the documented floor.
dogfood_claim_path()    { printf '%s/.preflight-claim.json' "$1"; }   # $1 = store home
dogfood_attempts_path() { printf '%s/.preflight-claim.attempts' "$1"; }
