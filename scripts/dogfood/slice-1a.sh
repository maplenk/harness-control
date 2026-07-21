#!/usr/bin/env bash
#
# Run 1a — Phase A0: application-neutral command executor + CLI parity (§3A.1).
# The FIRST dogfood slice of the Harness Control UI build (§6A run order:
# Bootstrap → A0 → Phase A → proof slice → …). This is a backend seam, not a
# visible screen — everything the UI binds to depends on it, so it goes first.
#
# Just the START stage: the coordinator drafts a testable spec from §3A.1 and
# stops at the human-approval gate. Review the spec, then run-slice.sh.
set -euo pipefail

export SECTION="§3A.1"
export SLICE="the application-neutral command executor — ApplicationCommand (domain intents, no json/text/exitCode/testApprove/noWait fields), CommandContext{actor,origin,idempotencyKey}, typed ApplicationResult/ApplicationError — and making the CLI a thin adapter over it (parse argv → ApplicationCommand + CommandContext{origin:'cli'}, render result → text+exitCode), with --test-approve structurally impossible over the http origin"
export PATHS="a new src/app/commands/ directory, src/cli/commands.ts, src/cli/index.ts, src/app/index.ts, and their *.test.ts files"
export COORDINATOR="${COORDINATOR:-claude:opus:xhigh}"

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/start-slice.sh"
