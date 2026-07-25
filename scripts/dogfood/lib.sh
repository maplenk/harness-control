#!/usr/bin/env bash
#
# Shared resolution + digest helpers for the dogfood scripts.
#
# WHY THIS FILE EXISTS: the preflight battery and the enforcement gate only mean
# something if they bind the SAME things the spend paths will actually execute.
# When `start-slice.sh` resolved its own role defaults and `preflight.sh`
# hard-coded a different set, an `IMPLEMENTOR=opencode:…` run dispatched an
# adapter the battery had declared "unused and not gating". Every fact that the
# record binds is resolved here, once, and sourced by all four scripts, so the
# gate and the run can no longer disagree about what "current" means.
#
# Sourced by: preflight.sh · require-preflight.sh · start-slice.sh · run-slice.sh
# Never executed directly.

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

# A stable identity for the resolved config: its sha256, or a sentinel.
# $1 = resolved config path (may be empty).
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
# stale-dist class that opened this project. ~390 files / 3.6 MB, well under a
# second. Prints the hex digest, or nothing if dist is missing/empty.
# $1 = repo root.
dogfood_dist_digest() {
  node - "$1/dist" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = process.argv[2];
const files = [];
(function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.isFile()) files.push(p);
  }
})(root);
if (files.length === 0) { process.stdout.write(''); process.exit(0); }
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

# ── Path containment ─────────────────────────────────────────────────────────
# Exit 0 if $1 resolves INSIDE $2. Canonicalises both (realpath of the longest
# existing prefix), so symlinked or not-yet-created log dirs cannot smuggle
# writes into the repo and dirty the next run's clean-tree check.
dogfood_path_inside() {
  node - "$1" "$2" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const real = (p) => {
  let cur = path.resolve(p);
  const parts = [];
  for (;;) {
    try {
      const r = fs.realpathSync(cur);
      return parts.length > 0 ? path.join(r, ...parts.slice().reverse()) : r;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      parts.push(path.basename(cur));
      cur = parent;
    }
  }
};
const candidate = real(process.argv[2]);
const root = real(process.argv[3]);
const rel = path.relative(root, candidate);
const inside = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
process.exit(inside ? 0 : 1);
NODE
}
