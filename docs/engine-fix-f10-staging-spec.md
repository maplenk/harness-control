# Engine Fix — Prove the Index Instead of Naming an Ignored Pathspec (F10) — v1

**Status:** spec v1 — fix shape empirically validated (§4 scenario matrix); implementation on the engine track with F8/F9/F11, codex diff-review before land
**Severity:** BLOCKER — on git 2.55.0 **every** harness commit path dies. The implementor's post-turn commit and the §16.3 WIP reconciliation commit both call the same helper, and both throw before committing. A run cannot produce a deliverable at all.
**Surfaced by:** the 2026-07-25 preflight design work, on the machine that runs the dogfood. Not a hypothetical: `git --version` here is **2.55.0**, and the drill fails on it today.
**Root cause:** a *defensive* pathspec became the failure. `:(exclude)node_modules` names an **ignored** path, and modern git refuses commands that explicitly name ignored paths.
**Fix shape:** stop naming the path. Stage plainly, then **prove the index** — post-check the staged paths and unstage any `node_modules` entry, fail-closed if any survive.

---

## 1. Problem

F7 introduced `addAllExceptNodeModules` (`git.ts:221-223`) so a provisioned, git-ignored `node_modules` could never enter a harness commit even if the target repo's ignore rule went missing:

```
git add -A -- . ':(exclude)node_modules'
```

On **git 2.55.0**, in the exact shape F7 provisioning creates — an **ignored AND present** `node_modules` — that command exits **1**:

```
The following paths are ignored by one of your .gitignore files:
node_modules
hint: Use -f if you really want to add them.
hint: Disable this message with "git config set advice.addIgnoredFile false"
```

An `:(exclude)` pathspec counts as *explicitly naming* the path for the ignored-path advice check, so git errors out. `runGit` surfaces a nonzero exit as a throw, and **both** callers die:

| Caller | Site | Consequence |
|---|---|---|
| Implementor post-turn commit | `implementor.ts:973-974` | the round's work is never committed → no implementation commit → `no_deliverable` |
| §16.3 WIP reconciliation commit | `validate.ts:173-174` | taint recovery cannot preserve partial work → resume path breaks |

The cruel detail (§4 r1): git **stages the non-excluded paths and then exits nonzero**. The work lands in the index and the engine throws anyway — so the failure looks like a harness crash rather than a staging refusal.

**Why the green suite did not catch it.** Both halves of the production shape exist in tests, in different files, never together:

- `implementor.test.ts` drives the staging helper against a **real** temp git repo (`makeTempGitRepo`, `src/worktree/test-support.ts`) — but the only `.gitignore` it ever writes is `*.log` (`:836`). Its `node_modules` fixtures are therefore **not ignored**, and with no ignore rule the old pathspec exits 0 (§4 r3).
- `provision.test.ts` writes the real `node_modules/` ignore rule (`:105`, `:444`, `:789`, `:894`, `:994`) — but never exercises the staging helper.

So the tests were not fake-git-blind; they were **fixture-shape-blind**. The regression test must assemble the whole production shape in one place: real git + a **committed `node_modules/` ignore rule** + a **present** `node_modules` + the actual staging call. Any regression test that keeps the two halves apart re-opens this exact hole.

---

## 2. Contract

### 2.1 Stage plainly

`addAllExceptNodeModules` stops naming `node_modules`. Staging is plain `git add -A -- .`, which is ignore-aware on its own: an ignored `node_modules` is simply not staged (§4 r1), and full `-A` semantics (adds, modifications, deletions) are preserved for everything else.

### 2.2 Prove the index (the post-check)

After staging, read the staged paths and match each against:

```
(^|/)node_modules(/|$)
```

This is the load-bearing change in coverage: the old pathspec was **root-anchored** and silently missed a nested `web/node_modules` (§4 r3) — the very layout the UI slices introduce. The regex catches `node_modules` at any depth.

Read the paths with `git diff --cached --name-only -z` and split on NUL. Newline-splitting is not acceptable: `core.quotepath` and unusual filenames would corrupt the comparison, and a corrupted comparison here means a silent miss.

### 2.3 Targeted reset, then fail closed

For each distinct offending `node_modules` root, run `git reset --quiet -- <root>`. That removes the index entry **without touching the working tree** — the provisioned toolchain stays on disk and remains usable by verification (§4 r2, r3). Resetting a pathspec that matches nothing is a no-op that exits 0 (§4 r5), so the post-check is safe to run unconditionally.

Then **re-read the index**. If any path still matches the regex, **fail closed**: do not commit, raise a distinct, operator-actionable error. A provisioned tree entering a harness commit is the outcome F7 exists to prevent; if we cannot prove it did not happen, we do not commit.

The reset must never be a bare `git reset` — that would unstage the implementor's real work.

### 2.4 Gated on active provisioning (unchanged)

The post-check runs only where the exclusion ran: while provisioning is **active**. Under `worktree.provision='none'` the operator owns `node_modules`, plain `addAll` keeps full semantics, and legitimately-tracked `node_modules` changes must still commit (§4 r4 shows what an ungated post-check would silently drop). This preserves the F7 round-2 #3 decision exactly.

### 2.5 Unchanged

`unstageNodeModules` (`git.ts:235-237`) keeps its round-4 #3 role — the pre-staged-by-someone-else case — and is now the same primitive the post-check uses. Provisioning's independent fail-closed refusal of an unignored/tracked `node_modules` is untouched; this fix is complementary to it, not a replacement.

---

## 3. Acceptance criteria (machine-checkable)

- **AC-1 the live shape commits** — real git repo, committed `node_modules/` ignore rule, present `node_modules`, dirty tracked + new untracked files → the implementor commit succeeds, exit 0, and the commit contains the work and **no** `node_modules` path.
- **AC-2 the WIP path too** — the same shape through the §16.3 WIP reconciliation commit (`validate.ts:173-174`) succeeds.
- **AC-3 unignored node_modules is caught** — no ignore rule, `node_modules` present → plain add stages it, the post-check unstages it, the commit contains none of it, and the files remain on disk.
- **AC-4 nested trees are caught** — `web/node_modules` present with no ignore rule → post-check unstages it (the old root-anchored pathspec did not), `web/app.ts` still commits.
- **AC-5 fail-closed** — with the targeted reset stubbed to a no-op, a staged `node_modules` entry survives the post-check → the flow **refuses to commit** and raises the distinct error. It never commits "best effort".
- **AC-6 provision='none' preserved** — tracked `node_modules`, modified, provisioning inactive → the change commits normally (the post-check does not run).
- **AC-7 NUL parsing** — a staged path containing a space/quote-triggering character is parsed correctly (no false positive, no false negative).
- **AC-8 regression discipline** — AC-1 demonstrably FAILS on pre-F10 code with the git 2.55 error. Run it against the parent commit first, and assert on the exit path rather than the message text.

---

## 4. Empirical scenario matrix (git 2.55.0, re-run 2026-07-25)

Scratch repos, real git, no engine code involved. `OLD` = `git add -A -- . ':(exclude)node_modules'`; `NEW` = plain `git add -A -- .` plus the post-check.

| # | Scenario | OLD behavior | NEW behavior |
|---|---|---|---|
| **r1** | ignored + **present** `node_modules`, dirty tracked file (**the live shape**) | **rc=1**, "The following paths are ignored…" — *and it had already staged `tracked.txt`* | rc=0, staged `[tracked.txt]` |
| **r2** | **unignored** `node_modules` present (the case the exclusion existed for) | n/a | rc=0, staged `[node_modules/left-pad/index.js, tracked.txt]` → post-check reset → `[tracked.txt]`, file still on disk |
| **r3** | nested `web/node_modules`, no ignore rule | rc=0 but staged `[web/app.ts, web/node_modules/pkg/i.js]` — **root-anchored pathspec missed it** | post-check hits `web/node_modules`, targeted reset → `[web/app.ts]` |
| **r4** | **tracked** `node_modules`, modified (`provision='none'`) | n/a | plain add stages `[node_modules/pkg/i.js, tracked.txt]`; an **ungated** post-check would drop the legitimate change → §2.4 gate is required |
| **r5** | reset with a pathspec matching nothing | n/a | rc=0 no-op, staging untouched — the post-check is safe to run unconditionally |

`scripts/dogfood/preflight.sh` section (b) carries r1 forward as a **permanent canary**: it drills the git *behavior* rather than the repo's helper, so it keeps catching version regressions after the helper is rewritten again. It also prints the OLD form's exit code as living documentation of this fix.

---

## 5. Codex diff-review focus

1. **Symmetry.** Both call sites (`implementor.ts:973-974`, `validate.ts:173-174`) must go through the SAME primitive — a second implementation is a second place to regress.
2. **Fail-closed reachability.** Is there any path where the post-check's refusal is swallowed and the commit proceeds?
3. **`-z` parsing.** Empty-index case, single-entry case, trailing-NUL handling.
4. **Interaction with F7's round-4 #3 pre-staged case** — the pre-commit `unstageNodeModules` and the post-check must not fight or double-report.
5. **Message redaction** on the new fail-closed error (paths only, no env).
