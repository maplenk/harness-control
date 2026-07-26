# Dogfood — build the Harness Control UI by running the harness on its own plan

Per `docs/UI-IMPLEMENTATION-PLAN.md` §6A: each **bounded implementation slice**
is one `harness` run — the coordinator drafts a testable spec from a pinned plan
section, the human approves the exact spec hash, one implementor works in an
isolated worktree, an independent verifier gathers evidence, and `merge_ready`
hands off to the human to merge. Runs are **serial** with a **merge/rebuild
gate** between them.

Three-vendor role split (fixed): coordinator **claude:opus:xhigh** (Anthropic),
implementor **grok:grok-build:high** (xAI/Grok Build), verifier
**codex:gpt-5.6-sol:xhigh** (OpenAI, read-only).

## Run order (§6A)

`Bootstrap → A0 (1a→1b) → Phase A (2a→2b→2c) → proof slice → B → B2 → C/C2 → D → E → F`

## Per slice

```sh
# 0. PREFLIGHT — by hand, every time. There is no script for this on this branch
#    (one exists on `gate-enforcement`, advisory and deliberately unmerged), so
#    it is operator discipline:
npm run build                               # dist must be the merged HEAD
npm test                                    # 103 files / 1699 tests, NOT doubled
node dist/cli/index.js doctor --json        # claude/grok/codex resolved + authed
git status --porcelain                      # must be empty before `start`

# 1. START — coordinator drafts the spec, stops at the approval gate.
scripts/dogfood/slice-1a.sh                 # Run 1a (§3A.1); or:
SECTION="§3A.2" SLICE="…" PATHS="…" scripts/dogfood/start-slice.sh

# 2. MONITOR — live event log + status. Run in a second shell.
scripts/dogfood/monitor.sh                  # newest run; --once for a snapshot
scripts/dogfood/watch.sh RUN_ID             # the only side-effect-FREE option

# 3. APPROVE + RUN — bind the EXACT hash, drive implement → verify → merge_ready.
scripts/dogfood/run-slice.sh RUN_ID SPEC_VERSION SPEC_HASH
```

## Unattended: no human approval step (B2 `approval: 'auto'`)

Steps 1 and 3 collapse into one command when the run is created under a config
pinned to `approval: 'auto'`:

```sh
SECTION="§3A.1" SLICE="…" PATHS="…" scripts/dogfood/auto-slice.sh
```

`auto-slice.sh` = `start-slice.sh` (with `CONFIG=scripts/dogfood/dogfood.auto.config.json`)
→ `run-slice.sh`, and **nothing in the chain approves anything**. Under
`approval:'auto'` the ENGINE binds the drafted spec hash inside the same
transaction that persists the draft (`completeCoordinationRound`), so `start`
returns with the run already at `approved`; the scripts only read that back and
proceed. Everything after approval — implement → verify → bounded remediation →
merge-readiness — is unchanged, because nothing after T1 ever involved a human.

The mode is pinned into the run's config at `createRun` and is **immutable for
that run's life**: a later process holding the opposite config can neither grant
nor revoke it. The scripts therefore branch on the run's own reported state, not
on which config file was passed. `run-slice.sh` skips `approve` only when
`status --json` reports the run `approved` **and** bound to the exact hash it was
handed; it refuses on a different hash, on a signer the event log cannot
substantiate, and on any other phase.

**Preconditions and price of `auto`:**

- `verification.allowedCommands` must be **non-empty** — the engine refuses
  `approval:'auto'` without it at config parse. With no human reading the spec,
  the coordinator must not also choose what counts as proof.
- Matching is **exact string equality against the command text**. Every command
  any criterion may cite has to be in the config **before** `start`, including
  slice-specific absence checks (`test -z "$(grep -REl "PATTERN" PATH || true)"`).
  Editing that list *is* the approval you are no longer giving — and it is the
  only remaining human eye on whether a declared command is executable as
  written (L13/F16 is not built).
- `dogfood.auto.config.json` ships a baseline of whole-repo commands
  (`npm run typecheck`, `npm run build`, `npx vitest run`). Extend it per slice;
  do not widen it to make a run pass.
- **Residual, not fixed:** the allowlist pins the command TEXT, while F15's
  `expectedExitCode` is chosen by the coordinator. A criterion may cite an
  allowed command and declare a NON-ZERO exit as its proof — e.g.
  `{"command":"npx vitest run","expectedExitCode":1}` is a criterion satisfied by
  the suite failing. Read the drafted criteria before the merge gate.
- The **merge gate stays human**. `auto` removes the approval step, not the merge.

## ⚠ `status` is NOT read-only — monitoring mutates the run

Counterintuitive and worth knowing before you "just check on it": **every CLI
invocation carrying a run id delivers pending alerts and appends `alert.delivered`
events to the durable log** (`src/cli/commands.ts:201` → `service.ts:1658`). That
includes plain `status`, and therefore `monitor.sh`, which polls `status --json`.
Consequences:

- Monitoring a run **writes to the event log** and advances its sequence numbers.
- It takes the SQLite write lock, so it can contend with the run itself.
- `watch.sh` is the **only** truly read-only path: it queries the store with
  `sqlite3 -readonly` and never goes through the CLI. Prefer it for idle watching,
  especially during long turns.

This is engine behaviour, not a scripting choice — "best-effort at-least-once
alert delivery on every invocation" is deliberate (P4b-1). Just do not mistake
observation for a passive act.

## Memory / engine config

`start-slice.sh` forwards `--config` (default `scripts/dogfood/dogfood.config.json`,
which pins the **implementor RSS budget to 2048 MB** via the F4 per-role override).
`--config` at `start` is persisted into the run, so the `run` stage inherits it.
Override with `CONFIG=/path/to.json scripts/dogfood/slice-1a.sh`, or `CONFIG=` for
engine defaults. The config path + sha256 are recorded in the run manifest.

If the implementor still trips the RSS ceiling, the safe recovery is an **audited
raise + resume** (the run stays `resource_exhausted`, spawns no verifier, until it
succeeds). Re-run the step-0 checks first — `resume` spends and mutates exactly
like `run` does — then:

```sh
node dist/cli/index.js set-budget RUN_ID --role implementor --memory-budget-mb <MB> --resume
```

`RUN_ID` and `--role` are both required (`args.ts:61`). The same rule applies to
`resume` and `recheck`: they drive provider turns and mutate the run, and they
are what you reach for when a run is *already* in trouble — the worst moment to
be running an unverified binary.

## Merge/rebuild gate (between every run — why runs are serial)

1. human **merges** the verified commit (never automatic);
2. `npm test` **+** `npm run typecheck` pass on the merged tree;
3. `npm run build` regenerates `dist/cli/index.js` — the next run executes the
   **new** binary (A0 refactors the very command layer the harness runs on);
4. working tree clean;
5. record the new base SHA + plan SHA in the next run's manifest.

## Where things land

- Run store + event log: `${HARNESS_HOME:-~/.harness}/harness.db`
- Per-run logs + manifests: `${HARNESS_HOME:-~/.harness}/logs/slice-<ts>-*`
- Coordinator writes no files; the implementor's worktree is isolated; the
  verifier is read-only on the implementor's exact commit.

Dogfooding **complements** the deterministic suite (`npm test`) — it does not
replace it.
