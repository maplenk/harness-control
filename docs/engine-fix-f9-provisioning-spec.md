# Engine Fix — Provisioning Must Prove the Tree It Provides (F9) — v2

**Status:** spec v2 (supersedes the v1 draft after the provisioning code audit) — codex spec-review with F8, then implementation → codex diff-review → land
**Severity:** HIGH — F9 is the other half of F7. F7 made provisioning *happen*; F9 makes it *honest*. Every problem below produces a **silent false-negative run**: the verifier gets a broken toolchain, all criteria go `unproven`, remediation burns rounds on unactionable findings, run dies at `no_deliverable`.
**Surfaced by:** the L1 manifest-freeze probe, 2026-07-25 (P1 empirically proven), plus a full audit of `src/worktree/provision.ts` (P2–P5, code-verified).
**Scope:** close the lanes that stamp an unproven tree as proven, and make accepted config **act or be refused**. No masking anywhere.
**Interlocking operational law:** L1/L7 in `docs/EXECUTION-PLAN.md` — dependency changes land via engine-track commits, and the merge is IMMEDIATELY followed by `npm install` + `npm run build` + suite in the primary, BEFORE any `start`. F9 turns ritual violations from silent false-negatives into loud, cause-named refusals.

---

## 1. Problems (all code-verified 2026-07-25; P1 also empirically proven)

**P1 — The install lane produces unproven toolchains.** `npm ci --ignore-scripts` (`provision.ts:175-184`) cannot build script-installed native deps. On the current manifest, better-sqlite3@12.11.1 installs its binding via a lifecycle script, so a script-less install lands the package with **no `.node`**. Probe result: persistence suite **58/122 red, all 10 files failing** — while `typecheck` stayed deceptively green. `hasBinDir` (`provision.ts:921-923`) then passes on a merely-*existing* `.bin` directory, so the broken tree is stamped "proven".

**P2 — Broken trees are STICKY.** The marker written after an install-lane build matches the new fingerprint, so every later round in the run short-circuits (`provision.ts:531`) straight onto the broken tree. Remediation cannot self-heal; the run burns to terminal.

**P3 — The false clone.** Clone eligibility compares the primary's **on-disk** manifests to the worktree's **HEAD** manifests (`provision.ts:646-647`), but `isPrimaryCloneable` (`provision.ts:932`) never validates the primary *tree contents* against those manifests. Merge a dep-adding commit, start the next run before `npm install` runs in the primary → fingerprints match → a stale tree missing the new deps is cloned, the marker is written, and the verify command exits **127**. That is the exact failure class F7 exists to kill, arriving through the clone lane instead.

**P4 — Config semantics lie (W4-1).** `provision:'clone'` does not force clone: on ineligibility it silently falls through to install (`provision.ts:636` + `:669`). Post-F9, `'install'` would be accepted-but-inert. Accepted config must act or be refused.

**P5 — Unbounded external commands.** `runtime.install` and provisioning-path `runGit` have no timeout; a stalled `npm ci` holds the git mutex + advisory lease forever.

---

## 2. Contract

### 2.1 Remove the mismatch→install fallback

On primary/worktree fingerprint mismatch, provisioning **fails closed** as `provisioning_failed` with a **cause-coded, diff-naming** operator message (both `ManifestSet`s are in hand at `provision.ts:647`): which file diverged (`package.json` / `package-lock.json` / `.npmrc` / `platformKey`), the inferred cause, and the remedy.

| Cause | Meaning | Remedy in the message |
|---|---|---|
| `deps_changed_in_worktree` | the implementor's commit changed manifests | "dependency changes are landed via the engine track, not inside runs" |
| `primary_manifests_diverged` | primary checkout has uncommitted/unsynced manifest edits | "commit/sync and `npm install`, then re-run" |

The CLI `next:` hint (`commands.ts:1148`) becomes cause-specific; the current text sends dep-addition cases in circles.

### 2.2 Close the false clone — prove the primary tree BEFORE cloning

Minimum bar: every root-level `dependencies` + `devDependencies` name in the fingerprinted manifests resolves to a directory under the primary's `node_modules`. On failure → `provisioning_failed`, cause `primary_tree_stale` ("run `npm install` in the primary").

*(Alternative accepted if codex prefers: an install-time fingerprint marker written into the PRIMARY tree by the operator flow, compared byte-wise.)*

### 2.3 Replace the toolchain proof with a runtime smoke — `.bin/` checks CANNOT work

`node_modules/.bin/` is populated from package `bin` fields at **unpack** time, independent of lifecycle scripts. A script-less install therefore yields a fully-populated `.bin` and zero built `.node` artifacts — which is precisely how P1 slipped past `hasBinDir`.

New proof, executed in the **STAGED** tree **before the marker write at `provision.ts:589`** (so an unproven tree can never become sticky): derive from the fingerprinted manifests the list of installed packages declaring `install`/`postinstall` scripts (at minimum better-sqlite3 today) and `node -e "require(...)"` each from the staged tree root, with a bounded timeout and an allowlisted env. Any load failure → `provisioning_failed`, cause `native_toolchain_unproven`, **naming the package**.

The same smoke runs on the **CLONE** lane's staged tree. That closes P3's residue: a primary broken by a past script-less install would otherwise propagate through clone silently. The clone lane is **cheap, not safe** — its correctness is inherited from the last real `npm install` in the primary, and inheritance is not proof.

### 2.4 Honest config vocabulary

| Value | Post-F9 meaning |
|---|---|
| `'auto'` | clone-or-fail-closed (no install lane) |
| `'clone'` | clone-or-fail-closed, with **no** retry-as-install on unsafe symlinks — the second `buildViaInstall` caller (`provision.ts:564`) becomes fail-closed under both strategies, refusing with cause `unsafe_clone_symlinks` instead of silently switching lanes |
| `'install'` | **refused at config parse** with a migration message: "install provisioning was removed: script-less installs cannot prove native toolchains; land deps in the primary and use clone" |
| `'none'` | unchanged (the operator owns `node_modules`) |

### 2.5 Bound external commands

`runtime.install` (while it survives the transition) and provisioning-path `runGit` get a timeout — default 10 min, matching the verification runner — failing closed on expiry with the mutex and advisory lease released.

### 2.6 No masking anywhere

No driver soft-skips, no verifier accommodation for missing bindings. A tree that cannot be proven is `provisioning_failed`, full stop.

### 2.7 Unchanged

Transactional staging/swap; the out-of-worktree stage namespace and its three fail-closed GC paths (`provision.ts:797,821,840` — orthogonal, verified); marker semantics for *proven* trees; `recheck` (does not provision); the `'none'` strategy; the workspaces refusal (`provision.ts:240`); nested-manifest blindness (documented limitation — the L6 layout law keeps manifests root-only; F7 §5 deferral for real workspace support stands).

---

## 3. Acceptance criteria (machine-checkable)

- **AC-1 mismatch fails closed** — worktree adds a dep → `provisioning_failed`, **no npm invocation occurs** (spy/refute in the unit test), message names the diverged file and cause `deps_changed_in_worktree`.
- **AC-2 stale primary caught** — matching fingerprints + primary missing one manifest-declared package dir → `provisioning_failed` cause `primary_tree_stale`, **no clone performed**, remedy text present.
- **AC-3 healthy path unchanged** — healthy primary + matching fingerprints → clone lane unchanged (existing F7 suite green); marker short-circuit still honored for proven trees.
- **AC-4 config acts or refuses** — `'install'` refused at parse with the migration message; `'clone'` + unsafe-symlink clone result → `provisioning_failed` cause `unsafe_clone_symlinks` (no lane switch); `'auto'` behaves as clone-or-fail.
- **AC-5 the smoke, both lanes, before the marker** — staged tree with a script-bearing package present-but-unbuilt (the better-sqlite3 shape: package dir + populated `.bin`, no `.node`) → smoke fails BEFORE the marker write → `provisioning_failed` cause `native_toolchain_unproven` naming the package, and **no marker exists afterward** (no stickiness). Same test on the clone lane with a deliberately-broken primary tree.
- **AC-6 timeouts release locks** — stalled installer/git (sleeping fake runtime) → timeout → fail-closed, mutex + advisory lease released (a subsequent acquire succeeds immediately).
- **AC-7 regression discipline** — AC-1 / AC-2 / AC-5 scenarios on pre-F9 code demonstrably reach the broken state (install-lane tree stamped proven / stale clone stamped proven). Run the tests against the parent commit first.

---

## 4. Codex spec-review focus

1. **Call-site enumeration.** Provisioning has two consumers — `implementor.ts:1003` and `orchestrate.ts:766` (+ `:742` discard-then-provision). Confirm no other consumer regresses.
2. **Env asymmetry.** While `runtime.install` survives for the transition/tests, pin its env to an allowlist like the verification runner: today it inherits the FULL orchestrator env including credentials (`provision.ts:181` vs `implementor.ts:158`).
3. **Message redaction** (F7 round-3 #7) applied to the new cause-coded messages.
4. **`clone_source_fingerprint_mismatch` warn-field misnaming** — `worktreePath` carries the primary root (`provision.ts:652`). Fix in passing.
5. **Scope discipline on AC-5's declared-binaries check** — keep it to a leading-token match against `.bin` entries; parsing commands is scope creep.
