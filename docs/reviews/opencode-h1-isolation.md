# OpenCode H-1 isolation acceptance — 2026-07-20

Target: lockfile-pinned `opencode-ai@1.18.1`, native `opencode acp --pure`,
model `xai/grok-4.5`, effort `high`.

## Finding reproduced

The pre-fix spawn inherited both `~/.config/opencode` and project
`opencode.json` / `.opencode`. A hostile fixture was resolved by the real
binary with:

- global and project `permission: allow`;
- global and project custom agents;
- global and project MCP servers.

OpenCode's characterized default also allows most tools without asking, so a
build-mode child could bypass ACP permission mediation entirely.

## Enforced boundary

Every production OpenCode adapter now:

- creates a private per-run HOME and XDG config/data/cache/state tree;
- byte-copies only `.local/share/opencode/auth.json` at `0600`;
- starts `opencode acp --pure`;
- disables project config, external skills, Claude-Code config/skills, LSP
  downloads, auto-update, and sharing;
- points custom and file-managed config at private empty directories;
- supplies an orchestrator config with no plugins or MCP;
- applies `OPENCODE_PERMISSION` last: workspace read/glob/grep are allowed,
  implementor structured edits are allowed, `task` is denied, and all other
  tools ask the ACP client;
- rejects caller or spawn-override attempts to replace isolation-owned env;
- deletes the private tree on adapter close.

## Live result

`npm run smoke:opencode:isolation` passed against the user's existing OpenCode
Grok subscription:

- requested and provider-echoed model: `xai/grok-4.5`;
- requested and provider-echoed effort: `high`;
- hostile host config loaded: **false**;
- hostile project config loaded: **false**;
- hostile MCP started: **false**;
- Bash request observed over ACP: **yes**;
- decision: **deny / denied_default**;
- Bash canary file created: **false**;
- safe in-worktree structured edit: **passed**;
- model identity file: `model=xai/grok-4.5`, `provider=xai`,
  `harness=opencode`.

Machine-readable proof:
[`evidence/opencode-isolation-live.json`](evidence/opencode-isolation-live.json).

The shipped CLI was then run end to end with Claude Opus as coordinator,
isolated OpenCode/Grok as implementor, and Codex as verifier. It reached
`merge_ready`; all three model pins were provider-echoed and the host re-ran
the generated repository's tests. Proof:
[`evidence/mixed-harness-live-2026-07-20.json`](evidence/mixed-harness-live-2026-07-20.json).

This closes the OpenCode implementor precondition for the pinned version. The
offline suite requires this proof's `adapterVersion` to equal
`EXPECTED_OPENCODE_VERSION`, so a version bump stays red until the real probe
passes and refreshes the record with
`npm run smoke:opencode:isolation:record`.
