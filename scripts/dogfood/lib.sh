#!/usr/bin/env bash
#
# Shared resolution + digest + containment helpers for the dogfood scripts.
#
# WHY THIS FILE EXISTS: the battery only means something if it checks the SAME
# things the slice scripts will actually execute. When `start-slice.sh` resolved
# its own role defaults and `preflight.sh` hard-coded a different set, an
# `IMPLEMENTOR=opencode:…` run dispatched an adapter the battery had declared
# "unused and not checked". Resolution happens here, once, so the scripts cannot
# disagree about what "current" means.
#
# Sourced by: preflight.sh · start-slice.sh · run-slice.sh. Never executed
# directly. (The gate-only helpers — effective/persisted config identity and the
# attempt claim — live on the `gate-enforcement` branch with the gate itself.)
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
const entries = [];   // { rel, kind } — kind 'd' for directory, 'f' for file
let refusal = null;
const describe = (st) =>
  st.isSymbolicLink() ? 'symlink'
  : st.isBlockDevice() ? 'block device'
  : st.isCharacterDevice() ? 'character device'
  : st.isFIFO() ? 'fifo'
  : st.isSocket() ? 'socket'
  : 'unknown entry type';

// The ROOT itself must be a real directory. Walking straight into it would follow
// a symlinked `dist` and bind neither the link nor its target.
let rootStat;
try { rootStat = fs.lstatSync(root); }
catch (e) { process.stdout.write(`!cannot lstat dist/: ${e.message}`); process.exit(1); }
if (!rootStat.isDirectory()) {
  process.stdout.write(`!dist/ is a ${describe(rootStat)} — it must be a real directory for its bytes to be bound`);
  process.exit(1);
}

(function walk(dir) {
  if (refusal !== null) return;
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { refusal = `cannot read ${dir}: ${e.message}`; return; }
  for (const name of names) {
    if (refusal !== null) return;
    const p = path.join(dir, name);
    let st;
    try { st = fs.lstatSync(p); } catch (e) { refusal = `cannot lstat ${path.relative(root, p)}: ${e.message}`; return; }
    if (st.isDirectory()) {
      // Directories are hashed too, so an added or removed EMPTY directory still
      // moves the digest.
      entries.push({ rel: path.relative(root, p), kind: 'd' });
      walk(p);
    } else if (st.isFile()) {
      entries.push({ rel: path.relative(root, p), kind: 'f' });
    } else {
      refusal = `dist/${path.relative(root, p)} is a ${describe(st)} — a build never produces one, and its bytes cannot be bound`;
    }
  }
})(root);
if (refusal !== null) { process.stdout.write(`!${refusal}`); process.exit(1); }
if (entries.length === 0) { process.stdout.write('!dist/ is missing or empty — nothing to bind'); process.exit(1); }
entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
const h = crypto.createHash('sha256');
for (const e of entries) {
  h.update(e.kind);
  h.update(e.rel);
  h.update('\0');
  if (e.kind === 'f') h.update(crypto.createHash('sha256').update(fs.readFileSync(path.join(root, e.rel))).digest());
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
// String concatenation, NOT path.join: join() normalises `..` away lexically, so
// a relative `link/../../store` would collapse before any symlink is followed —
// the same bug this walker exists to avoid. Every component, including those
// from cwd, goes through the resolution loop below.
const abs = path.isAbsolute(input) ? input : process.cwd() + path.sep + input;
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

