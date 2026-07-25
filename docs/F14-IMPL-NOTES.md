# F14 — the read-only shell classifier refused every absolute path, including the agent's own worktree

Parent: `a77f3da` ("F8-F11: resumable rounds, proven provisioning, git-2.55 staging, grok permission veto").

## 1. The defect

`hasEscapingPathArgument` (`src/adapters/grok/command.ts`) decided whether a shell
argument could name something outside the agent's worktree. One of its clauses was
`arg.startsWith('/')` — **every** absolute path escapes.

It does not. `buildImplementorPrompt` hands the agent its worktree BY ABSOLUTE PATH:

```
- You may create, modify, or delete files ONLY inside your assigned worktree: <abs>. Never write outside it.
```

So the engine names a path and then denies every command that uses it. A denied
permission ends the turn *before* the work is committed, so the round adjudicates
`no_deliverable` and the run dies. Four dogfood runs were lost this way.

### Reproduction (measured on the parent, against the classifier)

Live evidence, run_60ccbfda — grok's FIRST exploration command, denied:

```
ls -la <worktree> && ls -la web 2>/dev/null; head -n 5 docs/…; git rev-parse HEAD; git status --porcelain | head -20
```

Every token is individually safe. Only the absolute `<worktree>` made it a denial.
On the parent:

| command | parent verdict |
| --- | --- |
| `ls -la <worktree>` (the worktree ITSELF) | denied |
| `ls -la <worktree>/web` (its own subdir) | denied |
| `head -n 5 <worktree>/package.json` | denied |
| `ls -la /etc` | denied (correct) |
| `ls -la .`, `ls -la web` | allowed (correct) |

The worktree path in production is `<repo>.worktrees/assignment-asg_<runid>` —
verified on disk for run_60ccbfda, alongside two sibling assignment worktrees.

## 2. The fix

**An absolute argument is admissible if and only if it RESOLVES inside the agent's
worktree root.** Everything else is refused exactly as before.

| file | what changed |
| --- | --- |
| `src/lib/path-containment.ts` (new) | `isPathInside` (:61), `nearestExistingAncestor` (:75), `resolvesInsideRoot` (:99) — the containment computation, extracted so there is ONE copy. |
| `src/adapters/grok/command.ts:313` | `hasEscapingPathArgument(argv, worktreeRoot)` — `startsWith('/')` replaced by `worktreeRoot === undefined || !resolvesInsideRoot(worktreeRoot, arg)`. |
| `src/adapters/grok/command.ts:357` | `isSafeReadOnlyArgv(argv, worktreeRoot)` threads it. |
| `src/adapters/grok/command.ts:409` | `isGrokReadOnlyShellPermissionTitle(operation, worktreeRoot)` — second parameter REQUIRED (`string \| undefined`). |
| `src/adapters/grok/permissions.ts:86` | `allowReadOnlyOperation` is now a closure binding `input.cwd` — the assignment worktree, the same root `workspaceWriteRoot` uses. |
| `src/adapters/acp/session.ts:223-233` | `isWorkspaceWriteOperation` now calls the shared `resolvesInsideRoot`; its private `isPathInside`/`nearestExistingAncestor` are deleted. Behaviour identical except §4. |
| `src/app/flows/implementor.ts:858` | one prompt line preferring relative paths for shell inspection. |

### Why the root is trustworthy at that call site

`buildGrokMediation({ cwd })` ← `createGrokBuildAcpAdapter` (`src/adapters/factory.ts:560,583`)
← `RoleAdapterFactory.create({ cwd })` (`src/app/service.ts:769`)
← `OrchestrationService.runRole(runId, runner, spec, cwd)` (`src/app/service.ts:2771`)
← `deps.service.runRole(…, handle.worktreePath, …)` (`src/app/flows/implementor.ts:1324`).

`handle.worktreePath` = `worktreePathFor(baseDir, assignmentId)` = `path.join(path.resolve(repoRoot) + '.worktrees', 'assignment-<slug>')`
(`src/worktree/paths.ts:35-69`) — absolute, `..`-free, and the SAME string the prompt
confines the agent to. It is also already trusted as `workspaceWriteRoot`, so this
change adds no new trust to an existing input.

Note: the task brief said `isGrokReadOnlyShellPermissionTitle(title, cwd)` "already
receives a cwd argument". It did not — on the parent it took one parameter and the
policy stored the bare function reference. Threading it is part of this fix.

### Why the parameter is REQUIRED rather than optional

`HeadlessPermissionPolicy.allowReadOnlyOperation` is `(operation: string) => boolean`.
A two-parameter function is not assignable to it, so the closure in
`buildGrokMediation` is the ONLY way to satisfy the type — a future call site cannot
silently re-acquire the broken behaviour by passing the function reference. Passing
`undefined` is legal and means "this caller has no root": no absolute path is
admissible, i.e. exactly today's behaviour, stated rather than assumed.

## 3. Containment is computed, never pattern-matched

`resolvesInsideRoot(root, candidate)`:

1. both sides must be ABSOLUTE (a relative path would silently be resolved against
   `process.cwd()`);
2. neither may contain a `..` segment (see §4);
3. `realpathSync(root)`, then `realpathSync(nearestExistingAncestor(candidate))`;
4. `path.relative` containment between those two realpaths;
5. any throw, or no existing ancestor → `false`.

`path.relative`, not a string prefix: worktrees are siblings under
`<repo>.worktrees/`, so `…/assignment-asg_run_a` is a string prefix of
`…/assignment-asg_run_a-2`. Pinned in both `path-containment.test.ts` and
`command.test.ts`.

## 4. A finding on the way: `realpathSync` is not `realpath(3)`

Node's `fs.realpathSync` begins with `path.resolve(p)` — it collapses `..`
**lexically**, then walks components resolving symlinks. Measured (node 24, darwin),
with `escape` a symlink to a directory outside the root:

```
realpathSync(`${root}/escape`)    -> <outside>   (correct)
realpathSync(`${root}/escape/..`) -> <root>      (WRONG — the kernel says <outside>/..)
```

So the tool used to defeat lexical collapse performs one itself once a `..` appears.
Consequence on the PARENT: `isWorkspaceWriteOperation` **admitted**
`Write \`<root>/escape/../pwned.txt\`` — a structured write that lands in the
worktree's parent directory. Verified by running the parent's logic verbatim
(`nearestExistingAncestor` → `<root>/escape/..`, `realpathSync` → `<root>`,
`isPathInside` → `true`) and again by disabling only the new guard and watching
`src/adapters/acp/session.test.ts` fail (`expected true to be false`).

`resolvesInsideRoot` therefore REFUSES a `..` segment instead of resolving one.
Resolving it correctly means reimplementing `realpath(3)` component by component;
declining to answer is the honest alternative and `..` appears in no path anyone
needs. The Grok classifier keeps its own lexical `..` rejections on top (now applied
to absolute paths too, which the blanket `/` rejection used to hide).

## 5. Fails-on-parent proof

Tests were written first and run against the untouched parent source (vitest
transpiles without typechecking, so the extra argument is simply ignored at runtime
and the tests fail for the RIGHT reason — a denial, not a compile error):

```
$ npx vitest run src/adapters/grok/command.test.ts src/adapters/grok/permissions.test.ts
 Test Files  2 failed (2)
      Tests  12 failed | 135 passed (147)

FAIL … F14 … > classifies grok's EXACT denied command from run_60ccbfda as read-only
        AssertionError: expected false to be true
FAIL … F14 … > ADMITS the worktree root itself
FAIL … F14 … > ADMITS the worktree root with a trailing slash
FAIL … F14 … > ADMITS a subdirectory of the worktree
FAIL … F14 … > ADMITS a file inside the worktree
FAIL … F14 … > ADMITS a SINGLE-QUOTED absolute path inside the worktree
FAIL … F14 … > ADMITS several absolute paths inside the worktree
FAIL … F14 … > ADMITS a deep path inside the worktree
FAIL … F14 … > ADMITS a not-yet-existing file whose nearest EXISTING ancestor is inside
FAIL … F14 … > ADMITS a git read scoped to an absolute path inside
FAIL … F14 … > the symlink escape is one `path.resolve` — and `realpathSync` — would have called contained
FAIL … permissions … > binds the assignment worktree root into the read-only shell classifier

$ npx vitest run src/app/flows/implementor.test.ts
      Tests  1 failed | 40 passed (41)
FAIL … > implements in an isolated worktree … (relativePathLine: expected undefined to be defined)
```

Every REFUSE-direction case already passed on the parent (it refused everything) —
that is the point of pinning them: they prove the fix did not trade one direction
for the other. The §4 finding fails on the parent too (proof above).

## 6. The case table actually pinned

### ADMITTED (absolute, inside the worktree)

| case | where |
| --- | --- |
| run_60ccbfda's exact denied command | `command.test.ts` |
| the worktree root itself / with a trailing slash | `command.test.ts`, `path-containment.test.ts` |
| a subdirectory, a deep subdirectory, a file | both |
| a SINGLE-QUOTED absolute path inside | `command.test.ts` |
| several absolute inside-paths in one command | `command.test.ts` |
| a not-yet-existing file whose nearest existing ancestor is inside | both |
| `git log --oneline -5 <root>/docs` | `command.test.ts` |
| a symlink inside the worktree pointing to another place inside it | `path-containment.test.ts` |
| relative paths (`.`, `web`, `docs/x.md`) — unchanged | `command.test.ts` |
| **production wiring**: `decidePermission` → `allowlisted_read_only_operation` for `ls -la <cwd> && ls -la web 2>/dev/null` through `buildGrokMediation` | `permissions.test.ts` |

### REFUSED

| case | where |
| --- | --- |
| `/etc`, `/etc/passwd`, `'/etc/passwd'` (quoted), `/tmp` | `command.test.ts` |
| the PARENT of the worktree | `command.test.ts`, `path-containment.test.ts` |
| a SHARED-PREFIX sibling worktree (`<root>-2/secret.txt`) | both |
| a symlink inside the worktree pointing OUT, **no `..` anywhere** | both |
| the escaping symlink itself | both |
| `<root>/escape/../secret.txt` — the shape `path.resolve` AND `realpathSync` call contained | `command.test.ts`, `path-containment.test.ts` |
| `/../` inside an otherwise contained absolute path | `command.test.ts` |
| a trailing `/..` on an absolute path | `command.test.ts` |
| an absolute path that does not exist at all | `command.test.ts` |
| ONE outside argument among admissible ones | `command.test.ts` |
| `--file=<root>/pat.txt` — `=/` stays refused even pointing INSIDE | `command.test.ts` |
| `..`, `../outside.txt`, `web/../../etc/passwd`, `~/.ssh/id_ed25519` | `command.test.ts` |
| absolute paths with no root / `''` / a relative root / a nonexistent root (relative inspection still works) | `command.test.ts`, `path-containment.test.ts` |
| a `..` in the ROOT | `path-containment.test.ts` |
| a NUL-bearing path | `path-containment.test.ts` |
| non-widening sweep with a root supplied: `rm -rf`, `>` write redirection, `mkdir -p`, `npm run typecheck`, `--output=`, `rg --pre`, `$( … )`, `curl` | `command.test.ts` |
| **production wiring**: `/etc`, the worktree's parent, `<cwd>/../secret` → `denied_default` | `permissions.test.ts` |
| `Write \`<root>/escape/../pwned.txt\`` (§4, newly closed) | `session.test.ts` |
| every pre-existing rejection (quoting, redirection, backtick, payload, git-flag suites) — all 22 call sites now pass `undefined` explicitly and return the same verdicts | `command.test.ts` |

## 7. Green bar

| | parent | with fix |
| --- | --- | --- |
| `npm run typecheck` | exit 0 | exit 0 |
| `npx vitest run` | 106 files / 1945 passed | **107 files / 1987 passed**, 0 failed |
| `npx vitest list --filesOnly` | 106 | 107 (floor is 103) |

42 new tests. Each commit in the map is independently green — verified by extracting
it with `git archive` (read-only) and running typecheck + the suite there:
`794b6c5` 107 files / 1952 passed, `efd0a9c` 107 / 1987, `ee9d133` 107 / 1987,
`4281200` (docs only) 107 / 1987. All typecheck exit 0.

A green suite is not the gate — codex adversarial review is.

## 8. What I could NOT verify, and known residuals

- **No live grok run.** The fix is proven at the classifier and at the
  mediation-construction boundary, not end-to-end against a real grok binary. The
  next dogfood run is the real test.
- **`dist/` is gitignored and was not rebuilt here.** `npm run build` before the next
  dogfood run, or the run executes the old classifier.
- **The `docs/…` component of run_60ccbfda's command was truncated** in the report I
  was given; I reconstructed it as `docs/HANDOFF-dogfood-F7.md`. Immaterial to the
  verdict: it is a relative path, admissible before and after.
- **TOCTOU.** Containment is evaluated when the permission is decided; a symlink
  swapped between decision and execution is not covered by this layer. Grok's
  `--sandbox strict` process boundary is the independent second gate. Unchanged by
  this work — `isWorkspaceWriteOperation` has always had the same property.
- **The classifier is no longer pure.** It now stats the filesystem for absolute
  arguments. `decidePermission` already treats a throw as a denial, and
  `resolvesInsideRoot` catches internally; the cost is a few `stat`s per request.
- **A third `isPathInside` lives in `src/worktree/paths.ts`** (pure, lexical, no I/O,
  used to guard worktree PLACEMENT). Deliberately not consolidated: different
  semantics, different question, no filesystem access by design.
- **Case-insensitive filesystems.** `path.relative` is case-sensitive, so a
  case-variant spelling of the root is refused. Fail-closed direction.
- **Relative paths are still not containment-checked** (unchanged by instruction).
  The lexical `..` rejections — `..`, `../`, `/../`, and now a trailing `/..` — are
  what stands between a relative argument and a symlink traversal. Adding the
  trailing-`/..` clause is the one place I tightened relative handling; it is
  strictly additive and can be reverted in one line if a reviewer disagrees.
