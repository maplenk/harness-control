# Codex diff-review ROUND 2 of F7 (commit 6e33827) — 2026-07-22

Verdict: NEEDS-FIX (5 blockers + 3 high). Scope decision: fix dogfood-relevant + workspaces-fail-closed; DEFER workspace support / realpath containment.

## 1. Prioritized findings

1. **Blocker — B1 remains: stale provisioned dependencies survive the no-deps shortcut.** `6e33827:src/worktree/provision.ts:467`, `:483`, `:557`. A real, ignored, untracked `node_modules` passes safety; when remediation removes dependency fields but retains `.gitignore`, provisioning returns trivial success without removing or validating the old tree. Self-check and verifier can execute stale `.bin` tools and reach `merge_ready`.

2. **Blocker — workspace-local dependency trees are discarded.** `6e33827:src/worktree/provision.ts:647`, `:678`, `:693`, `:708`, `:629`. Clone/install preserves only root `node_modules`; npm workspace dependencies physically installed under `packages/a/node_modules`—for example conflicting versions that cannot be hoisted—remain in the stage/primary workspace and are discarded/not cloned. Verification can resolve a wrong hoisted/global version or fail despite “successful” provisioning.

3. **Blocker — nested `node_modules` can still enter HEAD.** `6e33827:src/worktree/git.ts:221`, `:222`; `6e33827:src/worktree/provision.ts:475`. The exclusion and preflight cover only root `node_modules`. With `.gitignore` containing `/node_modules/`, an implementor-side npm operation can create unignored `packages/a/node_modules`; `git add` stages it, and workspace verification can use the committed toolchain. Conversely, the unconditional exclusion silently prevents legitimate tracked root `node_modules` changes even under `worktree.provision='none'` (`provision.ts:516`).

4. **Blocker — B4 recovery can still delete the sole backup.** `6e33827:src/worktree/provision.ts:788`, `:792`, `:800`, `:802`. If restoring `old-*` fails, the error is swallowed and GC immediately deletes that stage. A transient rename failure therefore destroys the only rollback copy. Restoration failure must preserve the stage and fail provisioning.

5. **Blocker — H7 containment is lexical, not filesystem containment.** `6e33827:src/worktree/provision.ts:435`, `:438`, `:439`. `node_modules/pkg -> ../packages/pkg` passes even when `packages/pkg` is itself a tracked symlink to the primary or outside the worktree. Commands following the chain can write outside the worktree. Resolve existing targets/ancestors through `realpath`, failing closed on resolution errors.

6. **High — M9 creates an unsafe durable resume state.** `6e33827:src/app/flows/deliverable.ts:16`; `6e33827:src/app/projections.ts:224`; `6e33827:src/app/flows/orchestrate.ts:253`. Provisioning failure overrides abnormal/no-commit adjudication and is persisted merely as `completed`; `provisioning_failed` and the underlying deliverability result are not projected. After the environment is fixed, resume skips the implementor and verifies a round that normally required `NoDeliverableError`. Persist a distinct failure state or enough adjudication data to re-drive the implementor when appropriate.

7. **High — B5 does not fail closed on all valid npm workspace syntax.** `6e33827:src/worktree/provision.ts:275`, `:286`, `:289`, `:330`. Patterns such as `./packages/*` are accepted but never match tracked `packages/a/package.json`; npm normalizes the leading `./`. With no root dependencies, this reaches trivial success while missing workspace dependencies. Invalid non-array workspace declarations are also silently treated as empty.

8. **High — B3 absence detection depends on English Git diagnostics.** `6e33827:src/worktree/git.ts:298`, `:301`, `:346`, `:359`. Git runs without `LC_ALL=C`, while absence is recognized through an English stderr regex. A localized genuine absence—commonly a missing `.npmrc`—becomes `git_command_failed`, breaking provisioning. Force stable diagnostics or determine existence structurally.

## 2. Verdict

**NEEDS-FIX.**

Required: eliminate stale trees on no-deps success; provision workspace-local trees; distinguish generated nested dependencies from legitimate tracked paths; preserve backups on failed recovery; use real filesystem containment; persist M9’s failure/deliverability state safely; normalize or reject all npm workspace syntax; and make Git absence detection locale-independent.

B8’s never-unlink policy is sound. Requiring `.bin/` without a named binary matches the MVP contract; full binary provenance is the explicitly deferred §5 work.

## 3. Must-add tests

- Round 2 removes dependencies but retains the ignore rule; assert stale `node_modules` cannot reach self-check/verifier.
- Real npm workspace with an unhoisted/conflicting dependency; assert workspace-local dependencies survive clone/install.
- Root-only ignore plus generated `packages/a/node_modules`; assert it never enters HEAD, while legitimate tracked nested paths retain normal commit semantics.
- Inject restore-rename failure; assert `old-*` remains recoverable and provisioning fails.
- Workspace link chained through an in-worktree symlink to outside; assert rejection.
- Round-2 no-commit/abnormal provisioning failure followed by resume after recovery; assert the implementor is re-driven and verifier is not bypassed.
- `./packages/*`, negated patterns, and malformed workspace declarations.
- Localized genuine-absence diagnostics versus a real `git show` failure.
