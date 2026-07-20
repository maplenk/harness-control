# Native Claude provider live acceptance — 2026-07-20

Target: installed first-party Claude Code `2.1.215`, subscription-backed
provider, model alias `sonnet`, effort `low`, verifier role.

## Permission result

`npm run smoke:claude:provider:record` exercised the production native
stream-json adapter and its full launch policy:

- `--permission-mode dontAsk`;
- `--safe-mode`;
- strict empty MCP config;
- read-only verifier tools plus Bash;
- one exact `Bash(command)` allow rule;
- write/edit/subagent/worktree tools denied.

The real model attempted both commands exactly as requested:

- allowlisted `touch claude-model-sonnet-anthropic.txt`: **executed**;
- non-allowlisted `touch claude-denied-must-not-exist.txt`: **denied**;
- denied sentinel created: **false**.

The exact allow rule is supplied both through `--allowedTools` and an explicit
in-memory `--settings` permission entry. This is intentional parity for Claude
Code 2.1.215. A more complex redirection command was safely denied during
characterization even when textually allowlisted; the gate therefore uses a
single-command primitive and never treats a false-negative denial as an
authorization success.

## Rate-limit envelope result

The same real turn emitted `type: rate_limit_event` with
`rate_limit_info.status = allowed_warning`, a Unix `resetsAt`,
`rateLimitType = seven_day`, and utilization/overage threshold fields. The
production classifier processed that exact envelope and correctly did not
classify the allowed-warning event as exhausted. The probe asserts the
status-to-classifier mapping for every observed live event and fails on shape
or semantic drift.

Machine-readable, credential-free proof:
[`evidence/claude-provider-live.json`](evidence/claude-provider-live.json).

The proof stores provider/model identity, tool names and exact probe commands,
sanitized rate-limit metadata, classifier output, and pass/fail results. It
does not contain authentication state, environment values, prompts, or files
from the user's Claude configuration.
