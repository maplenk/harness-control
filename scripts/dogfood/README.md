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
# 1. START — coordinator drafts the spec, stops at the approval gate.
scripts/dogfood/slice-1a.sh                 # Run 1a (§3A.1); or:
SECTION="§3A.2" SLICE="…" PATHS="…" scripts/dogfood/start-slice.sh

# 2. MONITOR — live event log + status (there is no `serve` daemon yet; reads
#    the SQLite store directly). Run in a second shell.
scripts/dogfood/monitor.sh                  # newest run; --once for a snapshot

# 3. APPROVE + RUN — bind the EXACT hash, drive implement → verify → merge_ready.
scripts/dogfood/run-slice.sh RUN_ID SPEC_VERSION SPEC_HASH
```

## Memory / engine config

`start-slice.sh` forwards `--config` (default `scripts/dogfood/dogfood.config.json`,
which pins the **implementor RSS budget to 2048 MB** via the F4 per-role override).
`--config` at `start` is persisted into the run, so the `run` stage inherits it.
Override with `CONFIG=/path/to.json scripts/dogfood/slice-1a.sh`, or `CONFIG=` for
engine defaults. The config path + sha256 are recorded in the run manifest.

If the implementor still trips the RSS ceiling, the safe recovery is an **audited
raise + resume** (the run stays `resource_exhausted`, spawns no verifier, until it
succeeds): `node dist/cli/index.js set-budget RUN_ID --role implementor --memory-budget-mb <MB> --resume`.

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
