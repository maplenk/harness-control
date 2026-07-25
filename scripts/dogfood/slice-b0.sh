#!/usr/bin/env bash
#
# Run B0 — a fixture-backed React shell under `web/` (§6A run B0).
#
# HISTORY, because this is a re-drive and the first attempt matters:
# `run_60ccbfda` (2026-07-25) took this exact slice all the way to `verifying`
# with a real implementor commit — 17 files, 824 lines, scope respected — and
# its verifier recorded `failedCriteria: []` with five `unproven`. Independently
# re-measured afterwards: ALL THIRTEEN criteria were in fact satisfied (16/16
# web tests passing, the four absence checks holding, `vite build web` building
# in 284 ms). Two defects made a correct slice unprovable:
#
#   * the engine could not prove ABSENCE — every declared command had to exit 0,
#     and `grep` exits 1 when it finds nothing (→ F15);
#   * the spec declared `npx vite build --root web`, which Vite 7 rejects, and
#     commands are frozen under the approved hash so nothing could repair it
#     (→ laws L12/L13, and F16 to catch it mechanically).
#
# The previous implementor output is preserved at tag
# `dogfood/b0-first-implementor-commit` — compare against it rather than
# assuming this run must start from nothing.
#
# PRECONDITIONS (check, do not assume):
#   1. F15 is merged and `npm run build` has been re-run, or the absence
#      criteria will come back `unproven` again for the same structural reason.
#   2. The tree is clean and the suite is green.
#   3. `approval` is NOT set to `auto`. Until F16 exists, a human reading the
#      drafted commands is the ONLY thing standing between an unexecutable
#      command and another wasted slice.
#
# This is the START stage only: the coordinator drafts and stops at the
# approval gate. READ THE DRAFTED COMMANDS before approving — every one of
# them, against the versions actually installed. Then run-slice.sh.
#
# `DRY_RUN=1 scripts/dogfood/slice-b0.sh` prints the goal and spawns nothing.
set -euo pipefail

export SECTION="§6A run B0"
export SLICE="a fixture-backed React shell under web/ — NO daemon, NO serve, NO network: render the fleet rail and one run overview from STATIC FIXTURE DATA only. Deps are already installed at the repo root (react 19.0.8, react-dom, vite 7.3.6, @vitejs/plugin-react, happy-dom, @testing-library/react) — you must NOT modify package.json or package-lock.json. The Vite config MUST live at web/vite.config.ts and MUST NOT set a root or a test key, because either would reroute the ROOT vitest collection (a config change that collapses collection still exits 0, so that failure is silent). Colocated *.test.tsx files must select their own DOM environment with a per-file pragma rather than changing any shared config"
export PATHS="a new web/ directory (web/index.html, web/tsconfig.json, web/vite.config.ts, and web/src/** including *.test.tsx colocated tests) — and NOTHING outside web/. Do not touch package.json, package-lock.json, vitest.config.ts, src/**, docs/**, or scripts/**"
export COORDINATOR="${COORDINATOR:-claude:opus:xhigh}"

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start-slice.sh"
