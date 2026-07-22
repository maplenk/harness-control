# F7 implementation notes — codex diff-review round (commit a43eeaf → this branch)

Branch: `worktree-agent-ad6b0180db834588b`. Spec: `docs/engine-fix-worktree-deps-spec.md` (v3).
Review being addressed: `docs/engine-fix-worktree-deps-review-codex-diff.md` (8 blockers + 1 high + 1 medium).

Overriding property: **fail-closed** — a provisioning failure must NEVER reach the verifier or green a run.

## Status of each finding

- **B1 (blocker) — DONE.** No-deps shortcut ran before the definitive checks; and `git add -A` could stage a provisioned tree.
  - Definitive tracked/ignored/symlink preflight now runs BEFORE the no-deps trivial return: `src/worktree/provision.ts` `assertNodeModulesSafe()` (called ~`provisionWorktreeDeps` before the `!declaresDeps` return).
  - The implementor commit now excludes node_modules: `src/worktree/git.ts` `addAllExceptNodeModules()` (`git add -A -- . :(exclude)node_modules`), used at `src/app/flows/implementor.ts` (was `addAll`, ~line 947).
  - Tests: provision.test.ts "F7 B1/B8 …" (symlink/tracked no-deps), vertical-slice.test.ts F7 loop test asserts no `node_modules` in HEAD.
- **B2 (blocker) — DONE.** Accepted a populated-but-broken tree without `.bin/`.
  - `hasBinDir()` required in: clone-eligibility (`buildStagedTree`), the short-circuit, and before writing the marker (`provisionWorktreeDeps`). `src/worktree/provision.ts`.
  - Tests: provision.test.ts "F7 B2 …" (marker-but-no-.bin rebuilds; primary-no-.bin installs).
- **B3 (blocker) — DONE.** Git/manifest errors were classified as safe absence.
  - `src/worktree/git.ts`: `readFileAtHead` distinguishes genuine absence (`/does not exist in|exists on disk, but not in/`) from error → throws; `isPathTracked` throws on exit≠0/1.
  - `src/worktree/provision.ts`: `parsePackageJson` throws provisioning_failed on malformed JSON; `collectManifests` wrapped so any read/parse error → fail closed.
  - Tests: provision.test.ts "F7 B3 …" (injected git error, ignore error, malformed JSON).
- **B4 (blocker) — DONE.** Crash recovery deleted the only rollback copy.
  - `src/worktree/provision.ts` `gcAbandonedStages(stageRoot, slug, worktreePath, warn)`: when worktree node_modules is MISSING and a stage holds `old-*`, RESTORE it before deleting. `gcProvisionStages` gained a `worktreePath` param; `provisionWorktreeDeps` passes it; `removeWorktree` passes `undefined`.
  - Tests: provision.test.ts "F7 B4 …" (crash after move-aside + failing rebuild → old tree restored).
- **B5 (blocker) — DONE.** Fingerprint didn't bind all workspace manifests (`**`).
  - `src/worktree/provision.ts` `assertSupportedWorkspacePatterns()` / `isSupportedWorkspacePattern()`: any pattern with `**`/partial-segment glob/`?[]{}` → fail closed (deferred full glob support). Called in `collectManifests`.
  - Tests: provision.test.ts "F7 B5 …" (`packages/**` → provisioning_failed).
- **B6 (blocker) — DONE.** Symlink scan silently skipped traversal errors.
  - `src/worktree/provision.ts` `scanSymlinkContainment`: readdir/readlink errors THROW provisioning_failed (never mark a tree we couldn't fully scan).
  - Tests: provision.test.ts scan unit test asserts a missing tree root → provisioning_failed.
- **H7 (high) — DONE.** Normal npm workspace links flagged as escaping.
  - `scanSymlinkContainment` now takes `{stageTreeRoot, eventualTreeRoot, containmentRoot}` and resolves each link from its EVENTUAL `<worktree>/node_modules` location, bounding to the WORKTREE (so `node_modules/pkg -> ../packages/pkg` passes; absolute/worktree-escaping fail). `src/worktree/provision.ts`.
  - Tests: provision.test.ts scan unit test (workspace-relative link passes).
- **B8 (blocker) — DONE.** Tracked symlink node_modules was unlinked before the tracked check.
  - Now NEVER unlink: `assertNodeModulesSafe` fails closed on a symlink node_modules before any mutation (subsumes the old unlink path). `src/worktree/provision.ts`.
  - Tests: provision.test.ts "FAILS CLOSED on a symlinked node_modules WITHOUT mutating it".
- **M9 (medium) — DONE.** Provisioning failures mis-surfaced + stale reporting.
  - `src/app/flows/deliverable.ts`: `adjudicateImplementorDeliverable` returns `completed` when `result.provisioningFailed` is set (never masks as no_deliverable → NoDeliverableError).
  - `src/app/flows/orchestrate.ts`: both fail-closed breaks now resolve the actual committed HEAD and record `{round, implementationCommit}` into `provisioningFailure`. `ProvisioningFailure` gained `round?`/`implementationCommit?` (`src/app/flows/implementor.ts`). CLI surfaces them (`src/cli/commands.ts`).
  - Tests: implementor.test.ts M9 unit test; vertical-slice.test.ts asserts round=1 + implementationCommit set.

## Files touched this round
- src/worktree/git.ts (B1 addAllExceptNodeModules; B3 readFileAtHead/isPathTracked strictness)
- src/worktree/provision.ts (B1/B2/B3/B4/B5/B6/H7/B8)
- src/app/flows/deliverable.ts (M9a)
- src/app/flows/orchestrate.ts (M9b)
- src/app/flows/implementor.ts (B1 use addAllExceptNodeModules; M9 ProvisioningFailure fields)
- src/cli/commands.ts (M9 surfacing)
- Tests: src/worktree/provision.test.ts, src/app/flows/implementor.test.ts, src/app/flows/vertical-slice.test.ts

## Verification
- `npm run typecheck` and `npm test` must be green. (See final report for verbatim counts.)

---

# Round 2 — codex diff-review round 2 (`docs/engine-fix-worktree-deps-review-codex-diff2.md`, commit 6e33827)

Scope (decided by orchestrator): fix the dogfood-relevant correctness bugs + make npm-workspace
repos FAIL CLOSED; DEFER real workspace support. Overriding property unchanged: **fail-closed**.

## Status of each fix
- **#1 (blocker) — DONE.** The no-dependency trivial-success path left any existing `node_modules`
  in place, so a stale toolchain (`.bin/tsc`) could reach self-check/verifier. `provision.ts`
  `provisionWorktreeDeps` (no-deps branch, ~line 470): if a `node_modules` exists it is removed
  TRANSACTIONALLY — renamed OUT of the worktree into a same-filesystem stage (atomic; the worktree
  has no `node_modules` the instant the rename returns, so a crash mid-delete can never leave a
  partial tree), then the moved-aside copy is freed best-effort. If the atomic move cannot be done →
  FAIL CLOSED. A no-deps repo ends with no `node_modules`.
  - Tests: provision.test.ts "F7 round-2 #1 …" (pre-existing tree removed; clean no-op otherwise).
- **#4 (blocker) — DONE.** `gcAbandonedStages` swallowed a failed `old-*` restore and fell through to
  the deletion sweep, destroying the only backup. `provision.ts` `gcAbandonedStages` (~line 738): a
  restore-rename failure now THROWS `provisioning_failed` BEFORE the deletion sweep, preserving the
  `old-*` backup so it stays recoverable on a later call. (Only reachable on the provisioning
  preflight — `removeWorktree` calls with `worktreePath=undefined`, skipping the restore block.)
  - Tests: provision.test.ts "F7 round-2 #4 …" (read-only stage → restore EACCES → backup preserved
    + provisioning fails). Skipped when running as root (permission bypass).
- **#6 (high) — DONE.** A provisioning failure was persisted as a bare `completed`, so a resume could
  SKIP the implementor and verify a round that required `NoDeliverableError`. `deliverable.ts`
  `adjudicateImplementorDeliverable` (~line 16): the `provisioningFailed → completed` override is
  REMOVED. Adjudication is now on the DELIVERABLE alone — an abnormal/no-commit round stays
  `no_deliverable` (so `runRole` persists that durable stage and resume RE-DRIVES the implementor,
  verifier NOT bypassed); a good committed deliverable stays `completed` and the loop still HALTS on
  the returned `result.provisioningFailed` with the terminal `provisioning_failed` outcome.
  - Tests: implementor.test.ts "F7 round-2 #6 …" (no_deliverable for abnormal/no-commit +
    provisioningFailed; completed for good-commit + provisioningFailed). Resume re-drive of a
    `no_deliverable` round is proven by vertical-slice.test.ts "restart/resume does NOT bypass the
    gate … re-drives the IMPLEMENTOR".
- **#8 (high) — DONE.** `readFileAtHead` recognized genuine absence via an English `git show` stderr
  regex (locale-dependent). `git.ts` `readFileAtHead` (~line 346): existence is now STRUCTURAL and
  locale-independent — `git ls-tree HEAD -- <relpath>` exits 0 for any readable HEAD and prints a
  line iff the path is tracked, so EMPTY stdout is genuine absence (decided on exit code + emptiness,
  no message parsing). A nonzero `ls-tree` exit (broken object store / unreadable HEAD / spawn
  failure) THROWS (fail closed). The old `GIT_SHOW_GENUINELY_ABSENT_RE` regex is removed.
  - Tests: provision.test.ts "F7 round-2 #8 …" (genuine absence → undefined incl. under a non-English
    LC_ALL; unresolvable HEAD → throws).
- **#5 WORKSPACES → FAIL CLOSED (blocker; subsumes #2/#7/workspace-#3) — DONE.** Any root
  `package.json` with a `workspaces` KEY now FAILS CLOSED. `provision.ts` `assertNoWorkspaces` (called
  in `collectManifests`): presence of the key alone is decisive — array (literal / `*` / `**` /
  `./packages/*` / partial-segment globs), `{ packages: [] }` object form, empty array, and
  non-array/malformed values all fail closed; the value is never trusted or normalized. The
  workspace-SUPPORT machinery (`workspacePatterns`, `assertSupportedWorkspacePatterns`,
  `isSupportedWorkspacePattern`, `dirMatchesPattern`, `expandDiskPattern`, `ManifestSource.workspaceDirs`,
  and the now-unused `ProvisionGit.listTrackedFilesAtHead` + `git.listTrackedFilesAtHead`) is REMOVED —
  no contradictory "support" code remains. Workspace support is NOT implemented; it is refused.
  - Tests: provision.test.ts "any `workspaces` declaration … FAILS CLOSED" (7 syntax cases).
- **#3 (cheap) exclusion under provision='none' — DONE.** `addAllExceptNodeModules` unconditionally
  excluded `node_modules`, silently dropping legitimate tracked node_modules changes under
  `worktree.provision='none'`. The exclusion now applies ONLY while provisioning is ACTIVE
  (strategy != 'none'). `git.ts` keeps both `addAll` and `addAllExceptNodeModules`; `implementor.ts`
  `ImplementorFlow` gained a `provisionActive` option (default true) and branches the commit staging;
  `manager.ts` exposes `get provisionStrategy`; the loop driver (`orchestrate.ts`) and `runImplementor`
  pass `provisionActive: worktrees.provisionStrategy !== 'none'`.
  - Tests: implementor.test.ts "F7 round-2 #3 …" (tracked node_modules committed under 'none';
    excluded from HEAD when active).

## Files touched (round 2)
- src/worktree/git.ts (#8 readFileAtHead structural/locale-independent; removed GIT_SHOW_GENUINELY_ABSENT_RE + dead listTrackedFilesAtHead)
- src/worktree/provision.ts (#1 no-deps stale removal; #4 restore-failure preserves backup; #5 assertNoWorkspaces + removed workspace machinery + listTrackedFilesAtHead from ProvisionGit)
- src/worktree/manager.ts (#5 removed REAL_PROVISION_GIT.listTrackedFilesAtHead; #3 provisionStrategy getter)
- src/app/flows/deliverable.ts (#6 removed the provisioningFailed→completed override)
- src/app/flows/implementor.ts (#3 provisionActive option + commit branch + runImplementor wiring)
- src/app/flows/orchestrate.ts (#3 pass provisionActive)
- Tests: src/worktree/provision.test.ts, src/app/flows/implementor.test.ts

## Newly-deferred (round 2) — intentional MVP deferrals, to add to spec §5
- **Real npm-workspace provisioning (#2/#7).** We FAIL CLOSED on any `workspaces` declaration instead
  of installing/cloning workspace-local `packages/<pkg>/node_modules` trees (unhoisted / version-
  conflicting deps). A workspace repo can never false-green; it is refused until real support lands.
- **Nested `packages/*/node_modules` provisioning (#3, review's nested-generated concern).** Only the
  ROOT `node_modules` is provisioned/excluded. Distinguishing implementor-generated nested
  `node_modules` from legitimate tracked nested paths is deferred (moot while workspaces fail closed).
- **Realpath filesystem symlink-chain containment (#5, review's H7-lexical concern).** The symlink
  containment scan stays LEXICAL (path-arithmetic on the eventual in-worktree location); it is NOT
  switched to `realpath` chain resolution. This repo has no tracked in-tree symlinks, so a link
  chained through a tracked symlink to outside is not a live dogfood risk. Deferred.

NOTE (doc location): `docs/engine-fix-worktree-deps-spec.md` lives only in the PRIMARY checkout
(untracked, not in this worktree); per the "do not touch the primary checkout" constraint the §5
additions above were NOT written into that file here — they are recorded in this in-worktree note and
in the final report for the orchestrator to port into the primary spec.

---

# Round 3 — codex diff-review round 3 (`docs/engine-fix-worktree-deps-review-codex-diff3.md`, commit 5994b49)

Round-2 fixes CONFIRMED good by the review. Round 3 = deeper FAILURE/EDGE-path robustness. Six fixes
applied; #4 (npm env / committed-`.npmrc` isolation) DEFERRED to spec §5.8. Overriding property
unchanged: **fail-closed** — a provisioning failure NEVER reaches the verifier, greens a run, or
corrupts the branch/backup.

## Status of each fix
- **#1 (blocker) — DONE.** A completed-round resume could WIP-commit `node_modules`/dirt into HEAD. The
  matching implementor commit is persisted `completed` despite provisioning failure
  (`deliverable.ts`), so resume re-enters at VERIFICATION (`orchestrate.ts` `resolveResumeEntry`), but
  adoption ran `validate()` whose dirty-tree recovery did an UNRESTRICTED `git add -A`
  (`validate.ts`). Two-part fix:
  - (a) `validate()`'s WIP/dirty-recovery staging now EXCLUDES `node_modules` whenever provisioning is
    active — `ValidateWorktreeInput.excludeNodeModulesFromWip` threaded into `commitWip`
    (`src/worktree/validate.ts`), set by the manager to `provisionStrategy !== 'none'`
    (`src/worktree/manager.ts` `validate()`). Same exclusion the implementor commit uses.
  - (b) a COMPLETED implementor round resume no longer runs `validate()` — `adoptWorktree`
    (`src/app/flows/orchestrate.ts`) RESETS the worktree to the EXACT persisted host-verified
    implementation commit via `discardToCommit` (like the verifier branch), discarding post-commit
    dirt, NEVER WIP-committing it. The commit is persisted on completion
    (`recordImplementationCommit` → `WorktreeFactsState.lastImplementationCommit`,
    `src/app/projections.ts`). An INTERRUPTED implementor round still takes the `validate()` path.
  - M9 routing INTACT: an abnormal/no-commit round stays `no_deliverable` → resume re-drives the
    implementor (`resolveResumeEntry` → `first: 'implement'` → `validate()` path, not the reset).
  - Tests: vertical-slice.test.ts "#1 — a completed round that failed provisioning RESUMES by resetting
    to the persisted commit"; provision.test.ts "F7 round-3 #1 (fix a) … WIP commit EXCLUDES
    node_modules"; the abnormal-resume re-drive is re-confirmed by the existing F2 "restart/resume does
    NOT bypass the gate" test.
- **#2 (blocker) — DONE.** A swap whose move-in AND rollback BOTH fail left the sole `old-*` backup in
  the stage, then the unconditional `finally` deleted it. `swapIntoPlace` now leaves the backup on an
  unconfirmed rollback and surfaces the move-in failure; the `finally` PRESERVES a stage that still
  holds an `old-*` (`stageHoldsBackup`) — a later crash-recovery preflight restores it. A swap failure
  is surfaced as `provisioning_failed`. `src/worktree/provision.ts`.
  - Tests: provision.test.ts "F7 round-3 #2 … swapIntoPlace leaves the sole `old-*` backup on a double
    fault" + "stageHoldsBackup: … unreadable → true (fail safe)".
- **#3 (blocker) — DONE.** `lstatSafe` suppressed EVERY error → an `EIO`/`EACCES` became "absent" →
  a stale `.bin` could survive the safety preflight / no-deps removal. Now ONLY `ENOENT`/`ENOTDIR` is
  absence; any other error THROWS `provisioning_failed`. The non-authoritative PRIMARY clone-source
  call is wrapped (`isPrimaryCloneable`) so a clone-source hiccup still falls back to install, never a
  hard halt. `src/worktree/provision.ts`.
  - Tests: provision.test.ts "F7 round-3 #3 … lstatSafe: ENOENT/ENOTDIR → undefined; any other error
    (EACCES) → provisioning_failed".
- **#5 (high) — DONE.** Two bugs. (a) When the worktree tree was missing, a failure to READ a matching
  stage during the crash-recovery scan was silently skipped and the later sweep could delete it — an
  unreadable stage now FAILS CLOSED (preserved). (b) Prefix matching meant GC for `asg-x` also matched
  `asg-x-y-*`. Stages now live in an EXACT per-assignment NAMESPACE dir `<.provision>/<slug>/<stage>`
  (`gcAbandonedStages` enumerates exactly that dir — no prefix filter). `src/worktree/provision.ts`
  (+ `manager.ts` comment).
  - Tests: provision.test.ts "F7 round-3 #5 … UNREADABLE stage … PRESERVED and fails closed" + "GC for
    one assignment never touches a prefix-related assignment (asg-x vs asg-x-y)". The four existing
    crash-stage tests were updated to the subdir layout.
- **#6 (high) — DONE.** `runImplementor` let `options.provisionActive=false` override an ACTIVE manager
  while still installing the manager's default provisioning callback → the commit staged node_modules
  via `addAll`. It now DERIVES `provisionActive` from the manager strategy and REJECTS a contradicting
  override (fail closed, before the worktree is created). `src/app/flows/implementor.ts`.
  - Tests: implementor.test.ts "runImplementor — F7 round-3 #6 rejects an inconsistent provisionActive
    override" (reject on active+false; accept the matching `'none'`+false).
- **#7 (medium) — DONE.** `toProvisioningFailure` stored the raw error detail the CLI prints; the
  implementor-boundary path already redacts. It now applies the same `redactText`.
  `src/app/flows/orchestrate.ts`.
  - Tests: vertical-slice.test.ts "F7 round-3 #7 — toProvisioningFailure redacts the surfaced detail"
    (a secret-shaped detail is scrubbed); the #1 resume test exercises the verifier-boundary path
    end-to-end.

## #4 (blocker in the review) — DEFERRED to spec §5.8 (NOT implemented this round)
Per the orchestrator's scope, the npm-environment / committed-`.npmrc` isolation hardening (a hostile
`.npmrc` redirecting npm cache/log writes into the primary checkout, or expanding ambient tokens into
registry auth; `npm ci` receiving the full `{...process.env}`) is DEFERRED to spec §5.8 as
malicious-implementor hardening. The dogfood uses the CLONE path (fingerprint matches the primary),
not `npm ci`, and the implementor is FS-sandboxed/cooperative in the MVP threat model. NO npm
env/cache/userconfig isolation was implemented. To land later: minimal env, isolated
HOME/userconfig/cache for the install lane, and reject/override path-escaping npm settings.

## Files touched (round 3)
- src/worktree/validate.ts (#1a excludeNodeModulesFromWip → commitWip)
- src/worktree/manager.ts (#1a validate() passes provisionStrategy!=='none'; #5 comment)
- src/app/projections.ts (#1b WorktreeFactsState.lastImplementationCommit)
- src/app/flows/orchestrate.ts (#1b recordImplementationCommit + adoptWorktree completed-implementor
  reset; #7 toProvisioningFailure redactText + export)
- src/app/flows/implementor.ts (#6 reject inconsistent provisionActive override)
- src/worktree/provision.ts (#2 swapIntoPlace/stageHoldsBackup; #3 lstatSafe strict + isPrimaryCloneable;
  #5 per-assignment namespace + unreadable-stage fail-closed; exported swapIntoPlace/stageHoldsBackup/
  lstatSafe for tests)
- Tests: src/worktree/provision.test.ts, src/app/flows/implementor.test.ts,
  src/app/flows/vertical-slice.test.ts

## Verification (round 3)
- `npm run typecheck` → exit 0.
- `npm test` → 103 files, 1689 tests, all passing.

---

# Round 4 — codex diff-review round 4 (commit 79ae2ee)

Round-3 CONFIRMED converging; round 4 = 4 NARROW refinements of the round-3 fixes (1 blocker
+ 2 high + 1 medium). Overriding property unchanged: **fail-closed** — never verify/reset to a
WRONG commit, never lose the sole backup, never commit a provisioned tree.

## Status of each fix
- **#1 (blocker) — DONE.** `lastImplementationCommit` was not round-scoped → a multi-round crash
  could reset/verify the WRONG commit (round 1 records c1; round 2 durably completes at c2 but
  crashes BEFORE recording it → resume finds a SET-but-stale c1, the narrow-window fallback does not
  trigger, adoption hard-resets to c1 and discards c2). FIX: the persisted commit is now
  ROUND-SCOPED — `WorktreeFactsState.lastImplementationCommit = { round, commit }`
  (`src/app/projections.ts`); `recordImplementationCommit(round, commit)` and `adoptWorktree` use it
  ONLY when `persisted.round === resume.round.round`, else fall back to the current worktree HEAD
  (exactly the resuming round's durable commit) (`src/app/flows/orchestrate.ts`).
  - Test: vertical-slice.test.ts "#1 (round-4) — a persisted implementation commit from a DIFFERENT
    round is NOT used on resume" (poison a mismatched round → resume uses current HEAD, never the
    stale commit).
- **#2 (high) — DONE.** `diskSource` (primary-manifest reads) treated EVERY FS error as absence → a
  transiently-unreadable PRESENT primary `.npmrc`/lockfile could falsely match the worktree's absent
  entry → cloning an unproven tree. FIX: return `undefined` ONLY for genuine `ENOENT`; any other error
  throws so `buildStagedTree`'s catch falls back to install (`src/worktree/provision.ts`). Same class
  as round-3 #3 but on the primary-manifest path.
  - Test: provision.test.ts "F7 round-4 #2 … an UNREADABLE (present) primary .npmrc → clone NOT
    attempted, install selected".
- **#3 (high) — DONE.** `git add -A -- . :(exclude)node_modules` prevents ADDING node_modules but does
  NOT unstage an entry already in the index (a verification command / interrupted implementor that ran
  `git add node_modules`). FIX: new `git.unstageNodeModules` (`git reset -- node_modules`, no-op when
  nothing staged, working tree untouched) is called — while provisioning is active — BEFORE both the
  implementor commit (`src/app/flows/implementor.ts`) and the §16.3 WIP commit (`src/worktree/validate.ts`).
  - Tests: provision.test.ts "F7 round-4 #3 … validate() WIP commit UNSTAGES a pre-staged node_modules";
    implementor.test.ts "F7 round-4 #3 a pre-staged node_modules is unstaged before the commit" (the
    fake stages via `git add -A` mid-turn).
- **#4 (medium) — DONE.** A failure to enumerate the assignment namespace ROOT dir was swallowed as
  "no namespace" — if node_modules is missing and the namespace may hold the sole `old-*` backup,
  provisioning continued instead of failing closed. FIX: only genuine `ENOENT` means "no namespace";
  any other read error on the provisioning preflight (`worktreePath` defined) preserves + throws
  `provisioning_failed` (the removeWorktree cleanup path, `worktreePath` undefined, stays best-effort)
  (`src/worktree/provision.ts`). Same class as round-3 #5 child-stage fix, for the namespace root.
  - Test: provision.test.ts "F7 round-4 #4 … a non-ENOENT enumeration error on the assignment namespace
    dir → provisioning_failed (preserved)".
- **Production-path swap test (codex flag) — DONE.** Round-3 #2 tested `swapIntoPlace`/`stageHoldsBackup`
  in isolation but not the PRODUCTION catch/finally in `provisionWorktreeDeps`. Added a test-only `rename`
  seam to `ProvisionParams` (production leaves it undefined) and a test that drives the double fault
  THROUGH `provisionWorktreeDeps`.
  - Test: provision.test.ts "F7 round-4 #2 (production path) — provisionWorktreeDeps preserves the
    backup on a swap double fault".

## Files touched (round 4)
- src/app/projections.ts (#1 round-scoped lastImplementationCommit shape)
- src/app/flows/orchestrate.ts (#1 recordImplementationCommit(round,commit) + adoptWorktree round guard)
- src/worktree/provision.ts (#2 diskSource ENOENT-only; #4 namespace-root enum fail-closed; ProvisionParams.rename seam)
- src/worktree/git.ts (#3 unstageNodeModules)
- src/app/flows/implementor.ts (#3 unstage before the implementor commit)
- src/worktree/validate.ts (#3 unstage before the WIP commit)
- Tests: src/worktree/provision.test.ts, src/app/flows/implementor.test.ts, src/app/flows/vertical-slice.test.ts

## Verification (round 4)
- `npm run typecheck` → exit 0.
- `npm test` → 103 files, 1695 tests, all passing.

---

# Round 5 — codex diff-review round 5 (commit 14b7d1b)

All 4 round-4 fixes CONFIRMED correct; codex found NO other non-deferred blocker/high. ONE finding
left — the SAME-process twin of the round-4 blocker. Overriding property unchanged: **fail-closed** —
never verify/provision a wrong/contaminated commit.

## Status of the fix
- **HIGH — same-process verifier failover/auto-respawn could verify the WRONG worktree state — DONE.**
  Round-4 made CROSS-process adoption discard to the persisted implementation commit (`adoptWorktree`,
  correct), but the SAME-process forced-verifier re-entry (a `switch_model` limit failover or a bounded
  auto-respawn whose durable redrive re-enters at verification) merely restored the SHA variable — it
  never reset the worktree. So a verifier attempt that moved HEAD or dirtied files then limited/crashed
  left the same-process successor provisioning the moved HEAD while verification bound the OLD commit
  (contaminated / wrong state; the §16 readiness probe is too late). FIX: the forced-verifier branch
  (`src/app/flows/orchestrate.ts`) now `discardToCommit(boundCommit)` — reset + `git clean -fd` + assert
  HEAD is EXACTLY the bound commit and clean — BEFORE provisioning/dispatch, the SAME guarantee
  cross-process adoption gives. Idempotent for the cross-process path (adoptWorktree already discarded);
  a missing binding throws `LoopCompositionError` (fail closed).
  - Tests: failover.test.ts "round-5 — a verifier LIMIT whose attempt-1 moved HEAD + dirtied files
    re-enters at the BOUND commit" and the bounded-auto-respawn (CRASH) twin — attempt 1 commits a bogus
    HEAD + tracked dirt (`beforeTurn` hook), attempt 2 must start at EXACTLY the bound implementation
    commit with the dirt gone → merge_ready. Both run on both sqlite drivers (4 tests). VERIFIED they
    FAIL with the discard disabled (worktree HEAD = the moved/contaminated commit ≠ bound commit).

## Files touched (round 5)
- src/app/flows/orchestrate.ts (forced-verifier branch discardToCommit + missing-binding guard)
- src/app/failover.test.ts (AdapterScript.beforeTurn contamination hook + 2 tests × 2 drivers)

## Verification (round 5)
- `npm run typecheck` → exit 0.
- `npm test` → 103 files, 1699 tests, all passing.
