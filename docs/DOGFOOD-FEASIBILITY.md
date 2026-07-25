# Dogfood Feasibility — DP over the slice ladder

*Owner: Claude (orchestrator lead). Written 2026-07-25 from live probes against the current tree; landed at the slice-1a LAND gate. Companions: `docs/EXECUTION-PLAN.md` (the recurrence + schedule), `docs/UI-IMPLEMENTATION-PLAN.md` §6A (the slice ladder), the F8–F11 engine-fix specs.*

**Value function:** all slices merged via legitimate `merge_ready`, zero hand-built UI.
**State:** (engine capabilities E, merged slices S, primary manifest M). Each slice is a transition with preconditions and a failure distribution.
**Verdicts:** WORKS · WORKS-WITH-CONSTRAINTS · AT-RISK · FAILS-TODAY.

Every cell below is resolved — the open probes (better-sqlite3 under `--ignore-scripts`, vite build without lifecycle scripts, verifier network/timeout/confinement, the B0 layout question) all reported, and their answers are folded into the laws and the table. §5 records what each one returned.

---

## 1. Global transition laws (apply to every slice)

**L1 — Manifest freeze inside runs.** UI slices must NEVER touch `package.json` / `package-lock.json` (PATHS excludes them). Dependency additions are human-landed, codex-reviewed, clean-tree **engine-track** commits landed BEFORE the slice (the §6A "bootstrap precondition" pattern), so worktrees always hit the APFS-clone path. **CONFIRMED by probe:** the `npm ci --ignore-scripts` fallback yields a **BROKEN toolchain** on the current manifest — better-sqlite3@12.11.1 installs its bindings via a lifecycle script, so a script-less install leaves no `.node`: persistence suite 58/122 red, all 10 files failing, while typecheck stayed deceptively green. → **F9 filed** (`docs/engine-fix-f9-provisioning-spec.md`): remove/gate the fallback and fail closed with an operator-actionable message. L1 is therefore upgrading from convention to engine-enforced.

**L2 — Acceptance-criteria shapes allowlist.** Permitted: `tsc`; scoped `vitest`; compound shell lines (`a && b`, `grep …; echo`). **CONFIRMED:** the runner is `defaultVerificationRunner` (`implementor.ts:242`), spawning `shell:true` via `/bin/sh -c`; a nonzero exit is a captured outcome, never a throw; **10-minute per-command timeout (exit 124), 16 MB output cap, W3-1 env allowlist (no wholesale env inherit), W4-7 process-group reap** — backgrounded descendants die with the group, so a daemon started inside a command does not survive the command. Daemon-shaped ACs must therefore be in-process vitest servers on ephemeral loopback ports. **BANNED:** playwright / puppeteer / cypress (browser downloads + install scripts), anything needing network at verify time, anything needing lifecycle scripts, any single command over 10 minutes.

**L3 — F8 + F9 land before slice 2a** (crash-redo cost + the first dep-add era). F9 additionally closes the **false clone** (matching fingerprints + a stale primary tree → exit 127 straight through the GOOD lane; `isPrimaryCloneable` never checks contents, `provision.ts:932`) and the **sticky broken tree** (the install-lane marker short-circuits every later round, `provision.ts:531`).

**L4 — Repo freeze during runs.** No commits and no tracked-file edits between `start` and the run's terminal state; all landings happen at LAND gates only. Includes the suite-hygiene items (the root `vitest.config.ts` exclude, removing stale `.claude/worktrees` checkouts) and the `harness.db` backup before the first post-migration run. `.claude/` writes are safe — it is already gitignored — so scratchpad-and-`.claude`-only during runs.

**L5 — UI state-vocabulary amendment before slices 4 / 6a.** `resource_exhausted` (suspension), `provisioning_failed` and `no_deliverable` appear zero times in `UI-DESIGN-BRIEF.md` / `UI-IMPLEMENTATION-PLAN.md`, and the engine defines six `SUSPENSION_KINDS` (`state.ts:39`). A UI built from those docs renders an RSS-killed run blank. Landed as **Revision 12** of the UI plan; slices 4 and 6a must carry the full vocabulary (plus `paused_user` modeling) into their specs.

**L6 — Root-manifest-only layout law** (until F7 §5 workspace support ever lands). No `"workspaces"` key **ever** — it is a terminal `provisioning_failed` at `provision.ts:240`, and it is the *natural* move for an agent, so every UI slice spec must explicitly ban it. No nested `web/package.json` — provisioning is blind to it (exit 127 at nested depth). `web/` is a source directory; all deps live in the root manifest.

**L7 — Dep-landing ritual** (the L1 companion). Merge the dep commit → `npm install` in the primary → `npm run build` → suite → THEN the next `start`. Never leave uncommitted manifest edits in the primary: they flip every concurrent run onto the (broken) install lane, and post-F9 onto loud refusals. F9 turns ritual violations from silent false-negatives into cause-named refusals.

**L8 — Config placement + collection floor.** The Vite config lives at `web/vite.config.ts` **only**. A root `vite.config.ts` with `root:'web'` reroutes **Vitest's** root, and `npm test` then runs 1 file out of 104 with **exit 0** — empirically proven false-green. The root gets a `vitest.config.ts` solely for the `**/.claude/**` exclude (suite hygiene; agent worktrees mirror `src/` and doubled the reported suite to 3398 = 2×1699). Standing guard in every web-touching slice and at every LAND gate: **`vitest list --filesOnly` must collect ≥ 103 files.**

**L9 — No `listen()` in acceptance criteria.** **PROBED:** the codex read-only Seatbelt **denies** loopback bind (`LISTEN_FAIL EPERM`, live probe 2026-07-25). The verifier re-runs the commands itself and its evidence alone gates — the host self-check is side-effect-only, with zero readers of `verificationPassed` — so a socket-binding test can never pass codex verification. Law: `src/serve/` is designed **handler-first** — HTTP tested via inject-style dispatch (no bind), WS via `noServer:true` + `handleUpgrade` with in-process fake sockets. The few irreducible real-socket proofs (slice 3's live cursor-resume across a socket kill) run under a **claude-pinned verifier for that slice only** — claude runs exactly the declared command strings, unsandboxed, still cross-vendor against the grok implementor — or as a human LAND-gate check. Corollaries when sockets do run: bind AND dial the literal `127.0.0.1` (never `localhost`: there is no `NODE_OPTIONS` in the env allowlist to fix Node's IPv6-first resolution), always port 0. All declared commands must be POSIX-sh clean — the host runs `/bin/sh -c` while the verifier runs bash, and bashisms diverge. Verifier turn budget is **30 minutes total** (transport cap), not 10 minutes per command.

**L10 — Criteria must be code-fixable and evidence-rigorous.** A remediation round with no new commit is `no_deliverable`, and the run **dies early** (`deliverable.ts:30` — the run-1 killer). Never write environmental or procedural criteria ("re-run X", "provide evidence"). Coordinator rigor belongs in `expectedEvidence` (concreteness-gated); `verificationCommands` are validated as non-empty strings only. Corollaries: `.gitignore` must **pre-cover** every tool artifact (`test-results/`, `playwright-report/`, `*.log`) — post-verification dirt is an agent-actionable blocker that burns a round; and nothing may edit tracked files in the PRIMARY while a run is live (the W3-1 drift guard poisons the round).

**L11 — Preflight battery before EVERY run, and it must drill the ENGINE.** Born from the two 2026-07-25 misses (the grok permission trap and F10), both invisible to a green suite. A scripted, sub-minute, zero-spend dry-run that exercises the engine's REAL paths against the CURRENT tooling before any coordinator dollar. Shipped as **`scripts/dogfood/preflight.sh`** and **enforced**: `start-slice.sh` and `run-slice.sh` both call `require-preflight.sh`, which refuses unless the most recent record has `verdict:"pass"` at the current HEAD, on the current toolchain, less than 30 minutes old.

Two design rules, both learned the hard way in review:

1. **A simulation of what the engine is believed to do can pass while the engine fails.** The first version of this battery hand-rolled a `git add` that mimicked the staging helper — and it passed, on a machine where the engine's own helper throws. Section (d) therefore imports the **real** `addAllExceptNodeModules` out of `dist/` and runs it; the hand-rolled version survives only as a labelled, non-gating canary that explains *why* a real-helper failure happened.
2. **Check the right facts, but bind the right things.** A record that binds HEAD and the toolchain still authorises a run whose *executable* tree changed, because `dist/` is gitignored and mutable — the same stale-dist class that started this whole project. The record therefore also binds a **sha256 digest over the whole `dist/` tree** (paths + contents), the **resolved role triple**, the **effective config**, and the **canonical store + log paths**; the gate recomputes all of them and refuses on any mismatch, and refuses records that are merely *incomplete* (a missing field must never read as agreement). Role and config resolution lives in exactly one place — `scripts/dogfood/lib.sh`, sourced by all four scripts — because the gate and the spend path cannot be allowed to disagree about what "current" means.
3. **Bind what will execute, not what the environment currently says.** Three corollaries the reviews forced out: (a) the digest must account for **every** directory entry — silently skipping symlinks let a symlinked `dist/cli` survive a rebuild and change targets without moving the digest, so anything that is not a regular file or directory is now refused by name; (b) path containment must resolve **component by component**, because `path.resolve()` collapses `..` lexically before symlinks are followed and `link/../x` can land inside the repo while classifying as outside it; (c) at `run` the CLI **ignores `$CONFIG`** and loads the config persisted at `start`, so the gate binds the run's persisted `run_config` projection rather than the ambient env — otherwise a run created with engine defaults could be blessed by a preflight that used the dogfood config. Containment itself is re-checked by the gate and by both slice scripts, not just by the battery, since a valid record can outlive the environment that produced it.

Sections: **(a)** toolchain provenance — git/node/npm recorded as a JSON line in `$HARNESS_HOME/logs/preflight.jsonl`, drift vs `preflight-baseline.json` warns (the run fingerprint's `platformKey` covers node only, and F10 was a **git**-version interaction it cannot see); **(b)** runtime toolchain proof — better-sqlite3 opened *and queried*, `tsc`/`vitest` executed, because a populated `.bin` proves nothing (F9/P1); **(c)** `npm run build` + `doctor --json` with the pinned dogfood config, evaluated **per dispatched role** (claude/grok/codex fail the battery; unused adapters are printed but never gate — a blanket accept of `overall:"warn"` would swallow a broken grok); **(d)** the **gating** engine staging drill described above, against an ignored+present `node_modules` fixture; **(e)** the L8 discovery floor — `vitest list --filesOnly` is a root-reroute canary, not a real collection, and the floor may only be raised above the committed `floorMin`, never lowered; **(f)** clean tree (the F5 base-pin precondition) plus the dist digest, run last so it also re-proves the battery itself left no dirt. The store and log dir must resolve **outside** the repo or the battery refuses at startup, and the record write is re-checked afterwards — a provenance file that lands inside the tree is dirt that fails the *next* run. A record that cannot be written is escalated, never merely noted in memory: the gate reads the file, so a failed append tries a fail-record and then invalidates the log rather than leaving an older PASS as the last word. Because even that is defeatable by an immutable log dir, every attempt also writes a **claim** (`$HARNESS_HOME/.preflight-claim.json`) in a different failure domain, carrying the attempt id the record must match — a stale PASS is then *orphaned* by the next preflight even when the log cannot be touched, and the gate refuses if it cannot write its own attempt marker. Residual, stated rather than hidden: making **both** locations immutable still defeats it, which is deliberate operator action rather than plausible accident.

**Not yet shipped:** the permission-policy lint (enumerate the implementor's plausible first tool calls against the current grok allowlist and fail on any denial-shaped mismatch). It needs the classifier exposed to a script, so **preflight does not cover the F11 class today** — F11 removes the specific trap it was born from, but the next denial-shaped mismatch would still be discovered by a paying run. Tracked, not blocking.

---

## 2. Pinned web dep list

Land via the L7 ritual before B0. Exact versions, probe-verified compatible.

- **dependencies:** react 19.0.8, react-dom 19.0.8
- **devDependencies:** @types/react 19.2.17, @types/react-dom 19.2.3, **vite 7.3.6** (*not* 8 — vitest 3.2.4's vite-node caps at ^7), @vitejs/plugin-react 5.2.0, happy-dom 20.11.1, @testing-library/react 16.3.2, @testing-library/dom 10.4.1
- **2a era:** `ws` (pure JS)

No `.gitignore` changes needed for the build output (`dist/` already matches `web/dist` at depth); `test-results/` and `playwright-report/` are pre-covered per L10. A new `web/tsconfig.json` (jsx `react-jsx`, moduleResolution `bundler`) is required; the root tsconfig `include` (`src/**`) is unaffected.

---

## 3. Optimal schedule

1. **Slice 1a runs.** Meanwhile executor agents BUILD the F8–F11 branches (worktree-isolated, no main commits during the run; codex diff-gates ready).
2. **1a LAND gate window:** merge 1a → merge F8 → merge F9 (+ F10, F11) → suite-hygiene fix (root `vitest.config.ts` exclude + remove the stale `.claude` worktree) → land the plan/feasibility/spec docs → dep-land commit (the §2 pinned list) → `npm install` in the primary → rebuild `dist` → suite green (~103 files / 1699 tests) → back up `harness.db` (1b-prep).
3. **1b** (operations repo — no new deps) → **B0** (first visible UI, layout (i)) → **2a → 2b → 2c → 3 → 4 …** per the ladder.

---

## 4. Per-slice table

| Slice | Verdict | Preconditions beyond deps | Predicted failure modes (evidence) | Spec mitigations |
|---|---|---|---|---|
| 1a executor | WORKS (high confidence; shape proven by `ef952b1` pre-F7) | — | grok mis-edits the 111 KB `commands.ts`; spec sprawl | tight PATHS; ACs = CLI parity + envelope purity |
| 1b operations repo | WORKS-WITH-CONSTRAINTS | 1a | migration ledger has no rollback; projection-cursor NULL landmine (`projection-repository.ts:75`); idempotency-key design | spec must mandate cursor-threading + `UNIQUE(actor, idempotencyKey)`; LAND: back up `~/.harness/harness.db` |
| 2a lease + endpoint + forwarding | WORKS-WITH-CONSTRAINTS | 1b, F8 landed, `ws` pre-landed per L1 | first HTTP surface; **the verifier cannot bind a socket (L9, probed)**; security-gate AC breadth | in-process dispatch only — no `listen()` in any AC; lease CAS race tests per §3.8 |
| 2b enumeration + snapshots + WS | WORKS-WITH-CONSTRAINTS | 2a | sentinel scopes leak into `/runs` (5 confirmed live); WAL readonly `-shm` quirk; reads-that-write blacklist | spec lists the sentinel filter + exclusive cursor translation + `asOfSequence`/`fleetRevision`; WS via `noServer:true` + `handleUpgrade` |
| 2c attention + permissions + `/meta` | WORKS | 2b | permission-fencing complexity (`session.ts` pending-map lifecycle) | fence-tuple ACs per §3A.3 |
| B0 fixture shell | WORKS — layout (i) root-manifest **CONFIRMED** (vite build 266 ms + happy-dom component test PASS under `--ignore-scripts`; esbuild/rollup binaries ship as optionalDependency FILES) | F9 landed + dep-land ritual done | trap: a root `vite.config.ts` with `root:'web'` reroutes VITEST → 1/104 files, exit 0 (false-green); unpinned deps → ERESOLVE | vite config at `web/vite.config.ts` ONLY; AC guard "`vitest list` collects ≥ 103 files"; ACs = typecheck + `tsc -p web/tsconfig` + vite build + vitest incl. happy-dom component tests |
| 3 proof slice (UI ↔ serve) | AT-RISK (composite) | 2b, B0 | "live cursor-resume across a socket kill" as a deterministic test; two-surface integration sprawl | split the ACs: server-side kill/replay test + client store test; keep the browser out; the irreducible real-socket proof runs under an L9 claude-pinned verifier or as a human LAND-gate check |
| 4 Phase B shell + read screens | WORKS-WITH-CONSTRAINTS | 3, L5 amendment | 6-state connection machine under jsdom; scope explosion (5 screens) | consider a 4a/4b split if the AC count exceeds the verifier contract |
| 5 B2 write actions | WORKS | 4 | approve-hash CONFLICT paths; two-durable-commands handoff | executor-level tests exist as the pattern |
| 6a failure screens | WORKS-WITH-CONSTRAINTS | 4, L5 | five suspension compositions; the "reset time unavailable" literal | fixture-driven jsdom; engine state fixtures from real event logs |
| 6b management screens | WORKS-WITH-CONSTRAINTS | 4 | config three-tier writes; closed HARNESSES allowlist validation | reuse the model-resolution vocabulary in the ACs |
| 7 inspection tabs | WORKS-WITH-CONSTRAINTS | 4 | artifact per-run listing UNDERCOUNTS via raw SQL (PK = hash; use `gc.ts:58 collectReferencedArtifactHashes`); diff endpoint read-only proof | spec cites the correct enumeration path |
| 8a PTY broker | WORKS-WITH-CONSTRAINTS (upgraded) | node-pty **1.1.0** pinned (bundles `prebuilds/darwin-arm64` — `require()` PASSES under `--ignore-scripts`, empirically); `@xterm/*` pure JS | prebuild presence is platform-specific — an AC must assert the `.node` loads | dep-land ritual; AC: `node -e "require('node-pty')"` + in-process PTY session tests |
| 8b takeover + tmux | WORKS-WITH-CONSTRAINTS | 8a | §14 identity reuse | — |
| 9a/9b Electron + packaging | AT-RISK (was FAILS) | electron 43.2.0 has NO postinstall but lazily downloads ~100 MB at first `require()` — network + nondeterminism at verify time | first-require fetch during verification; better-sqlite3 ABI rebuild for Electron needs scripts | pre-seed the electron binary in the PRIMARY (the APFS clone carries `node_modules/electron/`) or set `ELECTRON_OVERRIDE_DIST_PATH`; ACs = main-process logic unit tests only; packaging/signing/ABI-rebuild are human LAND-gate steps |

---

## 5. Predictions and resolved probes

**Will work** (under L1–L11): 1a → 2c, B0, 3 → 7.

**Will fail without intervention:** any workspaces layout (`provision.ts:240` refusal, blast radius = every later run); dep-adds inside runs (the install fallback produces a broken toolchain — F9); playwright / electron / node-pty ACs written naively; crash-resume until F8 lands; any harness commit at all until F10 lands; `npm test` counts until the suite-hygiene fix; UI truthfulness on RSS-killed states until the L5 amendment.

**Probes that were open in the draft and are now closed:**

| Question | Answer | Consequence |
|---|---|---|
| better-sqlite3 under `npm ci --ignore-scripts` | **Broken** — no `.node`, 58/122 persistence tests red, typecheck still green | F9 (kill the install lane; runtime smoke before the marker) |
| vite build without lifecycle scripts | **Works** — 266 ms; esbuild/rollup binaries ship as optionalDependency FILES | B0 upgraded to WORKS |
| verifier network / timeout / confinement | 10 min per command, 16 MB cap, env allowlist, process-group reap; **loopback bind DENIED** (`LISTEN_FAIL EPERM`) | L2 + L9 |
| B0 layout | root-manifest layout (i) confirmed; a root `vite.config.ts` with `root:'web'` is a false-green trap | L6 + L8 |
| node-pty under `--ignore-scripts` | `require()` **passes** at 1.1.0 (bundled darwin-arm64 prebuild) | 8a upgraded from AT-RISK |

---

## 6. Slice-spec inputs (carry these into the coordinator goal)

**Slice 1b — operations repo.** The **projection-cursor landmine**: `ProjectionRepository.save()` called without `eventCursor` NULLs the watermark, and a later `recover()` then double-folds (`projection-repository.ts:75`). Any new write path must thread the cursor. Spec must also mandate `UNIQUE(actor, idempotencyKey)`. LAND-gate precondition: back up `~/.harness/harness.db` (first post-migration run).

**Slice 2b — enumeration + snapshots.**

- **Filter the five sentinel scopes** — confirmed live in `runs`: `run__run_ownership`, `run__process_registry`, `run__spawn_reservations`, `run__desired_model`, `run__failover_incident`. They must never appear in `/runs`.
- `openDatabase({ readonly: true })` exists (`database.ts:41`), but the WAL + `-shm` recreate caveat applies (a readonly connection transiently fails right after another process's last connection cleans up the sidecars).
- **Reads-that-write blacklist** — none of these may be called from a reader process: `projections.recover()`, `telemetry.aggregateWindow` (deletes folded rows), the `artifacts.write()` dedup path, `DurableRunOwnershipStore.acquire`, `service.deliverAlerts`.
- **Safe status surface:** `service.status()` + the getters + `events.listByRun(runId, { fromSequence })`.

**Slice 7 — inspection tabs.** Artifact per-run listing **undercounts** via raw SQL because the primary key is the content hash; use `gc.ts:58 collectReferencedArtifactHashes` as the enumeration path.
