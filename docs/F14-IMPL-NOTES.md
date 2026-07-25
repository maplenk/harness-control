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
| `src/lib/path-containment.ts` (new) | `isPathInside` (:66), `withoutTrailingSlashes` (:129), `nearestExistingAncestor` (:154), `hasParentSegment` (:183), `resolvesInsideRoot` (:196) — the containment computation, extracted so there is ONE copy. |
| `src/adapters/grok/command.ts:313` | `hasEscapingPathArgument(argv, worktreeRoot)` — `startsWith('/')` replaced by `worktreeRoot === undefined || !resolvesInsideRoot(worktreeRoot, arg)`. |
| `src/adapters/grok/command.ts:357` | `isSafeReadOnlyArgv(argv, worktreeRoot)` threads it. |
| `src/adapters/grok/command.ts:409` | `isGrokReadOnlyShellPermissionTitle(operation, worktreeRoot)` — second parameter REQUIRED (`string \| undefined`). |
| `src/adapters/grok/permissions.ts:86` | `allowReadOnlyOperation` is now a closure binding `input.cwd` — the assignment worktree, the same root `workspaceWriteRoot` uses. |
| `src/adapters/acp/session.ts:223-233` | `isWorkspaceWriteOperation` now calls the shared `resolvesInsideRoot`; its private `isPathInside`/`nearestExistingAncestor` are deleted. Behaviour identical except §4. |
| `src/app/flows/implementor.ts:858` | one prompt line preferring relative paths for shell inspection. |

### Why the root is trustworthy at that call site

`buildGrokMediation({ cwd })` ← `createGrokBuildAcpAdapter` (`src/adapters/factory.ts:561,613`)
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
3. trailing SLASHES are stripped from the root here and from the candidate on EVERY
   step of the walk (§4c, §4d) — only `/`, never `\`, which is a filename byte on
   this platform; then `realpathSync(root)`, then the `lstat`-probed nearest existing
   ancestor of `candidate` (§4b blocker 1), then `realpathSync` of THAT;
4. `path.relative` containment between those two realpaths;
5. any throw, an undecidable ancestor walk, or no existing ancestor → `false`.

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

## 4b. Codex round 1 — two blockers, one rule

Both findings were the same rule: **inability to determine containment is not
evidence of containment.** Both were mine, both were real, both are fixed
regression-first.

### Blocker 1 — `existsSync` conflates "absent" with "unresolvable"

`nearestExistingAncestor` probed with `existsSync`, which FOLLOWS symlinks (a
dangling link reports `false`) and swallows every error code (ELOOP, EACCES,
ENAMETOOLONG report `false` too). The walk therefore stepped OVER an undecidable
component and answered about a shallower path that really is inside the root.

The sharpest form needs no race: `Write <root>/dangling` where `dangling` is a
symlink to a not-yet-existing path outside. `existsSync` says the link is not
there, the walk selects `<root>`, containment says yes — and the write follows the
link and CREATES the file outside the worktree.

Fixed at `src/lib/path-containment.ts:88-118`: probe with `lstat` (a symlink is an
ENTRY whether or not its target exists) and act on the error CODE —
`ENOENT`/`ENOTDIR` are the only definitive absences, per the F9 `lstatSafe`
contract in `worktree/provision.ts:2450`. Everything else ends the walk as
`undecidable`, which refuses. Stopping AT a dangling link hands `realpathSync` the
job of resolving it, and its ENOENT/ELOOP throw is caught as a refusal.
`nearestExistingAncestor` now returns `{kind:'found',path} | {kind:'undecidable'}`
— an absent tail component is still skipped, which is what keeps the
not-yet-created target answerable.

### Blocker 2 — an implementor adapter could default its containment root

`CreateProviderAdapterOptions.cwd` is optional and `createGrokBuildAcpAdapter`
substituted `process.cwd()` before `buildGrokMediation` bound it as BOTH
`workspaceWriteRoot` and the classifier's containment root. Main declined every
absolute path, so a defaulted root is a genuine widening, not a preserved status
quo. Production always supplies a real worktree (`RoleAdapterOptions.cwd` is
required), but nothing made that a rule.

The role is a RUNTIME value (`options.role ?? options.permissions?.role`), so the
type system cannot demand the pairing. `src/adapters/factory.ts:588-603` therefore
REFUSES to construct an implementor adapter without an explicit `cwd`, and refuses
a relative one — before `assertSafeGrokProjectConfig`, before the isolated home,
before any resource exists to leak. A relative cwd is refused rather than accepted
because `resolvesInsideRoot` declines a relative root, so accepting one would
silently reinstate "no absolute path is ever admissible" — F14 again, quietly.
`process.cwd()` remains the default for the version probe and the project-config
scan, which are not containment decisions.

### Not blocking, restored

`command.test.ts` — the F11-era pin proving a single-quoted NUL is still rejected
had been deleted. Cause: my own scripted rewrite of the 22 call sites had a branch
that advanced its output cursor without copying the text it skipped, silently
dropping ~28 lines. The behaviour was never broken, but deleting a guard's proof is
how the guard later dies quietly. Restored, plus a second assertion that it stays
refused WITH a root in hand (F14 widened which absolute PATHS are admissible,
nothing about which BYTES are). I then diffed every touched file against `a77f3da`
for parent lines with no counterpart in HEAD: the only remaining absences are the
intended edits (import rewrites, the moved containment helpers, the rewritten
predicate). Nothing else was lost.

## 4c. Codex round 2 — a trailing separator routed around the walk

Round 2 confirmed the round-1 blocker fixes (including that the error-code switch
admits ENOENT/ENOTDIR as absence and declines ELOOP, ENAMETOOLONG, EACCES/EPERM,
EIO, EMFILE/ENFILE, NUL's `ERR_INVALID_ARG_VALUE` and every unknown) and found one
more bypass — of the switch itself, before it could ever see the real component:

```
lstat('link/')        -> ENOTDIR / ENOENT      classified ABSENT
path.dirname('link/') -> the GRANDparent       the link is never probed
```

One byte turns "this component resolves outside the root" into "not here, ask its
parent" — and the parent is inside. Demonstrated against this repo's own
`node_modules/.bin`, measured again here on the parent implementation:

```
lstat('.bin/tsx')  -> present     resolvesInsideRoot(.bin, .bin/tsx)  -> false  (correct)
lstat('.bin/tsx/') -> ENOTDIR     resolvesInsideRoot(.bin, .bin/tsx/) -> TRUE   (bypass)
   … the same symlink, resolving to node_modules/tsx/dist/cli.mjs, outside .bin
```

**Fix** (`src/lib/path-containment.ts:104-147`, `:182`): strip trailing separators
from the candidate INSIDE `nearestExistingAncestor`, before the first probe — not
at a call site, so no caller can reach the probe un-normalised — and from the root
in `resolvesInsideRoot`. Every later step of the walk comes from `path.dirname`,
which never emits a trailing separator, so one normalisation at entry covers the
whole walk.

Stripping preserves MEANING rather than deleting bytes: `link/` denotes the
directory `link` points at, and probing `link` resolves exactly that target — an
escaping link still declines, an inside one still admits. `path.normalize` is not
usable (it keeps one trailing separator, and it collapses `..` lexically, which is
what §4 exists to refuse). The `> 1` floor keeps `/` intact.

Re-run of codex's exact demonstration against the fixed helper:

```
.bin/tsx  .bin/tsx/  .bin/tsx//  .bin/tsx/.  .bin/tsx/./   -> all false
root supplied as `.bin/` with candidate `.bin/tsx/`        -> false
root `.bin` with candidate `.bin/`                         -> true
```

`link/.` was already correct — `path.dirname('link/.')` is `link`, so the component
was still probed — and is now pinned, because the difference between `link/` and
`link/.` is exactly the thing that is easy to get wrong again.

## 4d. Codex round 3 — normalise what the ALGORITHM can produce

Round 3 confirmed the corrected ENOTDIR invariant and every terminal-separator
shape, and found two more — both instances of one error, which is worth naming
because it was its third appearance on this branch: **I normalised the shape I had
seen rather than the shape the algorithm can produce.**

### Blocker 1 — `path.dirname` DOES emit a trailing separator

§4c claimed "every later step comes from `path.dirname`, which never produces a
trailing separator, so one normalisation at entry covers the whole walk". False:

```
path.dirname('link//missing')     === 'link/'
path.dirname('/a/link//missing')  === '/a/link/'
```

Any interior doubled separator makes the walk's OWN STEP produce exactly the shape
entry-normalisation existed to remove, so the next probe is un-normalised and skips
the component again — the §4c bypass, reintroduced by the fix's own loop. Measured
on `117569b` against this repo's `.bin`:

```
resolvesInsideRoot(.bin, .bin/tsx//missing) = true   | classifier admits = true
resolvesInsideRoot(.bin, .bin/tsx//.)       = true   | classifier admits = true
resolvesInsideRoot(.bin, .bin/tsx//./)      = true   | classifier admits = true
resolvesInsideRoot(.bin, .bin/tsx/)         = false  (the shape §4c had seen)
```

**Fix** (`src/lib/path-containment.ts:160-171`, the walk body): normalise on EVERY iteration —
`current := withoutTrailingSlashes(dirname(current))`. The property is now
structural rather than argued: no step's OUTPUT can be un-normalised, whatever its
input was, so there is no reachability argument left to get wrong. Termination is
documented rather than assumed: both functions are non-lengthening, so `current`
strictly shrinks until it stops changing at the filesystem root.

### Blocker 2 — `\` is a filename byte, not a separator

The helper stripped trailing `\` as well as `/`. This package declares
`"os": ["darwin"]`, and POSIX has exactly one separator — so `<root>\` names a real
SIBLING entry of the root, and stripping rewrote it into `<root>` itself. The
helper answered about a directory the caller never named. Both consumers were
reachable, verified on `117569b` with a real file created at `<root>\`:

```
resolvesInsideRoot(root, `${root}\`)                    -> true
shell classifier, cat '<root>\'  (single-quoted, so the byte survives F11) -> true
isWorkspaceWriteOperation(Write `<root>\`, root)        -> true   (allowlisted_workspace_write)
```

**Fix**: `withoutTrailingSlashes` (renamed from `…Separators`) strips **only `/`**
(`:129`), and `hasParentSegment` splits on **only `/`** (`:183`) — so `a\..\b` is
one legitimate filename component, not a traversal. Reading it as three would
refuse a real in-worktree file, and a false denial ends an agent's turn before its
work is committed, which is the failure this whole item exists to fix. The only
remaining `path.sep` in the module is inside `isPathInside`, comparing against what
`path.relative` itself produced.

Post-fix, every shape above returns `false`, and the both-directions pins are new
tests: `<root>\`, `<root>\\`, `<root>\dir` and a backslash-bearing ROOT all decline,
while `<root>/we\ird.txt` and `<root>/odd\..\name.txt` — real files whose NAMES
contain backslashes — are admitted.

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

### Round 2 (codex blockers), same discipline

```
$ npx vitest run src/lib/path-containment.test.ts src/adapters/grok/command.test.ts src/adapters/factory.test.ts
      Tests  6 failed | 136 passed (142)

FAIL … factory … > grok: REFUSES to construct an implementor adapter without an explicit worktree cwd
FAIL … resolvesInsideRoot > DECLINES a dangling symlink component instead of treating it as absent
FAIL … resolvesInsideRoot > DECLINES when a component cannot be stat-ed at all (errors are not absence)
FAIL … nearestExistingAncestor > walks up to the first path that exists, and reports what it could not decide
FAIL … F14 … > REFUSES a DANGLING symlink inside the worktree (an entry that exists and resolves nowhere)
FAIL … F14 … > REFUSES a path THROUGH a dangling symlink
```

Written against the round-1 implementation, i.e. they fail on `5733c7f` — the commit
codex reviewed — for the reasons codex named, not for a compile error.

### Round 3 (the trailing separator), same discipline

```
$ npx vitest run src/lib/path-containment.test.ts src/adapters/grok/command.test.ts
      Tests  5 failed | 117 passed (122)

FAIL … resolvesInsideRoot > DECLINES a component named with a TRAILING SEPARATOR instead of skipping it
FAIL … resolvesInsideRoot > a trailing separator changes no verdict for paths that really are inside
FAIL … F14 … > REFUSES an escaping symlink named with a TRAILING SEPARATOR
FAIL … F14 … > REFUSES ...with a doubled separator
FAIL … F14 … > REFUSES a DANGLING symlink with a trailing separator
```

Written against `dcc9219`, the commit codex reviewed in round 2. The second failure
is worth reading: it is the PRESERVATION test, and it failed only on its escape
assertion (`resolvesInsideRoot('<root>/', '<root>/file-link/')`) — every
"still admits what it should" assertion above it already passed. The tightening had
nothing to preserve that it was breaking.

### Round 4 (the walk's own step, and the backslash), same discipline

```
$ npx vitest run src/lib/path-containment.test.ts src/adapters/grok/command.test.ts src/adapters/acp/session.test.ts
      Tests  7 failed | 171 passed (178)

FAIL … resolvesInsideRoot > DECLINES when the walk itself would regenerate a trailing separator
FAIL … resolvesInsideRoot > treats a backslash as a FILENAME byte, never as a separator
FAIL … session > allows only path-qualified structured writes inside an implementor worktree
FAIL … F14 … > REFUSES an escaping symlink reached through an INTERIOR doubled separator
FAIL … F14 … > REFUSES ...the same with a trailing dot
FAIL … F14 … > REFUSES ...and with a trailing dot-slash
FAIL … F14 … > REFUSES a SIBLING file whose name ends in a backslash (a filename byte on darwin, not a separator)
```

Written against `117569b`. Both blockers are pinned at the CONTAINMENT level and at
each CONSUMER — the shell classifier and the structured-write rule — because both
consumers were independently reachable.

## 6. The case table actually pinned

### ADMITTED (absolute, inside the worktree)

| case | where |
| --- | --- |
| run_60ccbfda's exact denied command | `command.test.ts` |
| the worktree root itself / with a trailing slash | `command.test.ts`, `path-containment.test.ts` |
| a subdirectory, a deep subdirectory, a file | both |
| a SINGLE-QUOTED absolute path inside | `command.test.ts` |
| several absolute inside-paths in one command | `command.test.ts` |
| a not-yet-existing file whose nearest existing ancestor is inside — the case the `lstat` tightening had to preserve, re-asserted after it | both |
| a not-yet-existing file under a not-yet-existing directory | `path-containment.test.ts` |
| a non-implementor Grok adapter constructed without `cwd` (negative control: the refusal is scoped to the role that consumes the root) | `factory.test.ts` |
| `git log --oneline -5 <root>/docs` | `command.test.ts` |
| a symlink inside the worktree pointing to another place inside it | `path-containment.test.ts` |
| **a real inside path named with a TRAILING SEPARATOR** — `<root>/web/`, `<root>/web//`, `<root>/web/.`, `<root>/`, `<root>//`, an inside-pointing `link/`, and a not-yet-created `never-existed/` | `command.test.ts`, `path-containment.test.ts` |
| **a ROOT supplied with a trailing separator** (`<root>/`, `<root>//`) — identical verdicts in both directions | `path-containment.test.ts` |
| **an inside path reached through an INTERIOR doubled separator** — `<root>/web//missing`, `<root>//web//missing`, `<root>/web//`, `<root>/src//adapters` | `command.test.ts`, `path-containment.test.ts` |
| **files whose NAMES contain backslashes** — `<root>/we\ird.txt`, and `<root>/odd\..\name.txt` which must NOT be read as a traversal | `path-containment.test.ts`, `session.test.ts` |
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
| **a DANGLING symlink inside the worktree** — the entry exists, `existsSync` calls it absent, following it would create/read outside | `command.test.ts`, `path-containment.test.ts` |
| **a path THROUGH a dangling symlink** | `command.test.ts`, `path-containment.test.ts` |
| **a symlink LOOP** (ELOOP — an error that is not absence) | `path-containment.test.ts` |
| **an escaping symlink named with a TRAILING SEPARATOR** — codex's exact `node_modules/.bin/tsx/` shape, a link to a FILE outside | `command.test.ts`, `path-containment.test.ts` |
| **the same with a doubled separator** (`link//`), **with `/.`**, and **with `/./`** | `path-containment.test.ts` |
| **a DANGLING link with a trailing separator** (`dangling/`, `dangling//`, `dangling/.`) — the ENOENT route to the same skip | `command.test.ts`, `path-containment.test.ts` |
| **a directory-target escaping symlink with a trailing separator** (`escape/`, `escape//`) — normalising must not flip this to an admit | `command.test.ts`, `path-containment.test.ts` |
| the filesystem root `/` as the candidate | `path-containment.test.ts` |
| **an escaping symlink reached through an INTERIOR doubled separator** — `link//missing`, `link//.`, `link//./`, `link//missing//deeper`, `link///missing`, plus the dangling and directory-target variants | `command.test.ts`, `path-containment.test.ts` |
| **a real SIBLING file named `<root>\`** — at the containment level, through the shell classifier as `cat '<root>\'` (single-quoted, so the byte survives F11's tokeniser), and through the structured-write rule as ``Write `<root>\` `` | `path-containment.test.ts`, `command.test.ts`, `session.test.ts` |
| `<root>\\`, `<root>\dir`, and a backslash-bearing ROOT | `path-containment.test.ts` |
| **a component longer than `NAME_MAX`** (ENAMETOOLONG — the other suppressed-error shape) | `path-containment.test.ts` |
| a NUL-bearing single-quoted argument, with AND without a root (restored F11 pin) | `command.test.ts` |
| **constructing a Grok implementor adapter with no `cwd`** (role stated, and role inferred from the mediation config) → `invalid_argument`, before any resource is built | `factory.test.ts` |
| **constructing one with a RELATIVE `cwd`** → `invalid_argument` | `factory.test.ts` |
| non-widening sweep with a root supplied: `rm -rf`, `>` write redirection, `mkdir -p`, `npm run typecheck`, `--output=`, `rg --pre`, `$( … )`, `curl` | `command.test.ts` |
| **production wiring**: `/etc`, the worktree's parent, `<cwd>/../secret` → `denied_default` | `permissions.test.ts` |
| `Write \`<root>/escape/../pwned.txt\`` (§4, newly closed) | `session.test.ts` |
| every pre-existing rejection (quoting, redirection, backtick, payload, git-flag suites) — all 22 call sites now pass `undefined` explicitly and return the same verdicts | `command.test.ts` |

## 7. Green bar

| | parent | round 1 | round 2 | round 3 | round 4 (now) |
| --- | --- | --- | --- | --- | --- |
| `npm run typecheck` | exit 0 | exit 0 | exit 0 | exit 0 | exit 0 |
| `npx vitest run` | 106 files / 1945 | 107 / 1987 | 107 / 1993 | 107 / 2000 | **107 files / 2007 passed**, 0 failed |
| `npx vitest list --filesOnly` | 106 | 107 | 107 | 107 | 107 (floor is 103) |

62 new tests. Each round-1 commit was verified independently green by extracting it
with `git archive` (read-only) and running typecheck + the suite there: `794b6c5`
107 files / 1952 passed, `efd0a9c` 107 / 1987, `ee9d133` 107 / 1987, `4281200`
(docs) 107 / 1987 — all typecheck exit 0.

A green suite is not the gate — codex adversarial review is. Round 1 was green and
still had two blockers in it; round 2 was green, had passed a blocker review, and
still had a one-byte bypass in it; round 3 was green, had passed two reviews, and
its own fix could regenerate the condition it removed.

## 8. What I could NOT verify, and known residuals

- **LANDING STEP — `dist/` must be rebuilt.** `dist/` is gitignored and is not built
  in this worktree, and the dogfood run executes the BUILT classifier. Without
  `npm run build` at merge, the next run executes the old one and F14 reproduces
  exactly as before. (Coordinator is handling this at merge.)
- **No live grok run.** The fix is proven at the classifier, at the
  mediation-construction boundary, and at the adapter-construction boundary — not
  end-to-end against a real grok binary. The next dogfood run is the real test.
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
- **Separator semantics are POSIX, deliberately.** Only `/` separates; `\` is a
  filename byte (`package.json` declares `"os": ["darwin"]`). On Windows this module
  would be wrong in the widening direction — `a\..\b` really is a traversal there —
  so a port must revisit `withoutTrailingSlashes` and `hasParentSegment` together,
  not one of them.
- **Relative paths are still not containment-checked** (unchanged by instruction).
  The lexical `..` rejections — `..`, `../`, `/../`, and now a trailing `/..` — are
  what stands between a relative argument and a symlink traversal. Adding the
  trailing-`/..` clause is the one place I tightened relative handling; it is
  strictly additive and can be reverted in one line if a reviewer disagrees.
- **The dangling-symlink tightening costs denials in one plausible case.** A broken
  entry inside a provisioned `node_modules` (e.g. a `.bin` link whose target was not
  installed) makes an ABSOLUTE path naming it undecidable, so it is denied. The
  relative form is unaffected, and the prompt steers toward relative. Provisioning
  itself refuses escaping symlinks at clone time (`clone_symlinks_unsafe`), so the
  common case is a real directory.
- **Only the Grok implementor construction path is guarded.** Claude/Codex/OpenCode
  adapters still default `cwd` to `process.cwd()`; none of them binds a containment
  root today, so the guard would be decoration rather than enforcement. If any of
  them gains one, it needs the same refusal — the check is role-scoped precisely so
  that omission is visible rather than inherited.
- **`ENOTDIR` is treated as absence** (the F9 `lstatSafe` contract), and that is safe
  ONLY because the walk then probes the component itself. The invariant is not
  "ENOTDIR means absent"; it is **ENOTDIR may be skipped only when the skipped step
  moves exactly one component, so the real component is still probed next**. §4c is
  what that invariant looked like when it did not hold: a trailing separator made
  `path.dirname` skip TWO levels, the component was never probed, and an ENOTDIR
  that was fine everywhere else became a bypass. Any future change to the walk's
  step function has to re-establish this, not just the error-code switch.
