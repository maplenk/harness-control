# Harness Orchestration MVP — Architecture Plan

Status: **Draft for review**  
Date: 2026-07-18  
Implementation status: paused after dependency/bootstrap setup; no orchestration source has been implemented.

## 1. Decision requested

Approve or revise these four decisions before implementation resumes:

1. Build a headless Node.js/TypeScript orchestration core and CLI before any Electron UI.
2. Use current, maintained ACP adapters for Codex and Claude in the MVP.
3. Require explicit human approval of an immutable specification before implementation.
4. Stop at a verified, merge-ready commit; do not modify or merge into the user's primary checkout automatically.

Recommended answer: approve all four. They produce the smallest useful vertical slice without weakening session integrity, permissions, verification, or memory provenance.

## 2. Problem statement

Coding-agent harnesses such as Codex, Claude Code, OpenCode, Pi, and Grok own an agent loop: model calls, tool execution, permissions, context management, and native session history. They expose different control surfaces and do not share a portable session format.

The product must coordinate those harnesses without pretending they are interchangeable. It must:

- turn a user goal into an approved, testable specification;
- run implementation in an isolated Git worktree;
- independently verify every acceptance criterion;
- preserve run, session, model, memory, and evidence lineage;
- support changing a model or harness at safe checkpoints;
- recover honestly after crashes and cancellation;
- keep the human in control of specifications, permissions, and integration.

## 3. Research conclusions

### 3.1 Protocol boundaries

| Concept | Responsibility | Use in this product |
|---|---|---|
| Harness | Agent loop, tools, permissions, native history, model configuration | Executed backend |
| Model | Inference configuration within a harness | Resolved per session segment and turn |
| ACP | Client-to-agent session lifecycle, prompts, events, permissions, cancellation | Primary orchestration control plane |
| MCP | Agent-to-tool/context servers | Optional tools available inside a harness |
| Direct RPC/JSONL | Harness-specific control protocol | Later fallback when maintained ACP is unavailable |
| Shell/headless mode | One-shot process execution | Diagnostics only; not represented as resumable |

ACP and MCP are complementary, not alternatives. ACP controls an agent. MCP gives an agent tools and context.

### 3.2 Harness integration matrix

| Harness | Current control surface | MVP decision |
|---|---|---|
| Codex | Official `@agentclientprotocol/codex-acp`; native `codex app-server`; `codex exec --json` | Use exact-pinned official ACP adapter |
| Claude Code | Official `@agentclientprotocol/claude-agent-acp`; native headless/Agent SDK | Use exact-pinned official ACP adapter |
| OpenCode | Native `opencode acp` | Add after the core ACP contract is proven |
| Pi | Native `pi --mode rpc`; community ACP bridges | Add native RPC adapter after MVP |
| Grok Build | Installed local CLI supports sessions and streaming JSON; provenance is not established as an official xAI harness | Explicit opt-in native adapter after MVP; never auto-execute |
| Auggie | ACP-capable local harness used by Intent | Later provider profile |

Exact MVP runtime dependencies:

- `@agentclientprotocol/sdk@1.2.1`
- `@agentclientprotocol/claude-agent-acp@0.59.0`
- `@agentclientprotocol/codex-acp@1.1.4`
- Node.js `>=22.14.0`

Runtime adapters must execute the installed, lockfile-pinned package binaries. They must never use an unpinned `npx -y <package>` fallback.

### 3.3 Intent-derived workflow

The local Augment specialists establish three useful roles:

- Coordinator: spec-first planning, explicit approval, delegation, and acceptance-criteria ownership.
- Implementor: narrow assigned scope, worktree changes, tests, and evidence.
- Verifier: read-only, criterion-by-criterion evidence, no partial approval.

The product will adopt those invariants, not Intent-specific UI, APIs, proposal cards, or unsafe permission defaults. Role prompts guide agents; the host state machine remains the scheduler and security boundary.

## 4. MVP scope

### 4.1 Included

- Headless TypeScript core and CLI.
- Coordinator, Implementor, and Verifier profiles.
- Official Claude ACP and Codex ACP provider profiles.
- Capability-negotiated generic ACP subprocess transport.
- Immutable specification versions and explicit approval.
- One active implementor in one isolated Git worktree.
- Independent verification and a bounded remediation loop.
- SQLite event/state store and content-addressed artifacts.
- Structured, provenance-bearing memory.
- Same-harness model switching when confirmed by ACP.
- Successor-session handoff for unsupported or cross-harness changes.
- Restart/resume, cancellation, process cleanup, permissions, and redaction.
- Deterministic offline tests plus optional authenticated live smoke tests.

### 4.2 Deferred

- Electron or web UI.
- Parallel task waves.
- Pi, OpenCode, Grok, and Auggie execution adapters.
- Automatic merge into the primary checkout.
- Remote workers.
- Vector embeddings or a vector database.
- Deployment, messaging, or external side effects.

Deferred adapters remain architectural requirements: the adapter SPI and persistence model must not assume ACP-only operation.

## 5. System architecture

```text
CLI / future UI
      |
      v
Application service
  - workflow state machine
  - policy/approval engine
  - model-switch coordinator
  - recovery supervisor
      |
      +-----------------------+
      |                       |
      v                       v
Harness adapter SPI       Git worktree manager
      |
      +-- Generic ACP stdio transport
      |     +-- Claude ACP profile
      |     +-- Codex ACP profile
      |
      +-- Future native RPC adapters
      |
      v
SQLite repositories + artifact store
  - event log
  - workflow projections
  - session lineage
  - structured memory
  - evidence and checkpoints
```

The CLI is a client of the application service. No workflow transition may exist only in CLI code; a future UI must reuse the same state machine.

## 6. Domain model

### 6.1 Canonical entities

| Entity | Purpose |
|---|---|
| `Run` | User goal and top-level workflow state |
| `SpecVersion` | Immutable structured specification and content hash |
| `Assignment` | Role, approved spec version, base commit, worktree, and policy |
| `SessionSegment` | One harness-native session with resolved harness/model configuration |
| `Turn` | One request/response boundary within a segment |
| `Event` | Append-only normalized audit record |
| `Artifact` | Content-addressed spec, checkpoint, diff, test output, or evidence |
| `MemoryEntry` | Typed constraint, decision, fact, risk, or evidence reference |
| `Verification` | Criterion-by-criterion verdict against an exact spec and commit |
| `MergeReadiness` | Proof that one verified commit is eligible for manual integration |

IDs for runs, segments, ACP sessions, provider-native sessions, turns, and OS processes are distinct fields.

### 6.2 Run state machine

```text
created
  -> specifying
  -> awaiting_approval
  -> approved
  -> implementing
  -> verifying
       -> needs_remediation -> implementing
       -> merge_ready

Any non-terminal state may become:
  -> cancelling -> cancelled
  -> interrupted
  -> failed
```

Rules:

- Approval binds the exact `SpecVersion` hash.
- A successor spec supersedes the prior version and makes its open assignments stale.
- Verification binds the approved spec hash, base commit, and implementation commit.
- `merge_ready` requires evidence for every criterion.
- Remediation is bounded by configuration; exhaustion ends in `failed`, never false completion.

## 7. Specification contract

The Coordinator must return a structured specification containing:

- goal;
- assumptions and unresolved questions;
- constraints and permissions;
- non-goals;
- ordered tasks and dependencies;
- acceptance criteria with stable IDs;
- verification commands and expected evidence;
- rollback or recovery notes;
- proposed implementor and verifier harness/model profiles.

Coordinator output is untrusted input. The host validates its schema, rejects ambiguous or untestable criteria, stores it as an immutable artifact, and waits for human approval.

Imported human-authored specifications are supported, but they do not remove the Coordinator role from the workflow.

## 8. Role contracts

### 8.1 Coordinator

- Read-only workspace access.
- Creates or revises specifications.
- May inspect evidence and request remediation.
- Cannot approve its own specification.
- Cannot dispatch processes, alter workflow state directly, or write product files.

### 8.2 Implementor

- Workspace-write access only inside its assigned worktree.
- Receives one approved spec version and bounded task scope.
- Must execute declared verification commands.
- Returns changed files, diff, tests, exit statuses, risks, and commit SHA.
- Cannot change acceptance criteria or mark the run complete.

### 8.3 Verifier

- Read-only access to the exact implementation commit.
- Maps every acceptance-criterion ID to direct evidence.
- Must report `passed`, `failed`, or `unproven` per criterion.
- Any `failed` or `unproven` criterion prevents completion.
- Cannot edit files or repair the implementation.

These policies are enforced by the host and adapter configuration, not only by prompts.

## 9. Harness adapter SPI

Each adapter must implement:

```text
probe()
initialize()
createSession()
loadSession()
prompt()
cancelTurn()
listConfigOptions()
setConfigOption()
resolvePermission()
close()
```

Each operation returns explicit capabilities and normalized results. Unsupported capabilities return a typed error; they never silently degrade.

Required capability record:

- protocol and version;
- executable/package version;
- authentication readiness;
- create/load/fork/cancel support;
- advertised model, mode, and reasoning options;
- permission-request support;
- MCP configuration support;
- checkpoint/export support;
- observed session identity.

## 10. ACP transport

### 10.1 Lifecycle

1. Resolve the exact local package binary.
2. Spawn one subprocess in its own process group where supported.
3. Treat stdout exclusively as ACP NDJSON; retain bounded redacted stderr diagnostics.
4. Initialize and negotiate protocol/capabilities.
5. Create or load a session and confirm its returned identity.
6. Process prompts and normalized updates.
7. Cancel gracefully, then escalate termination if required.
8. Close streams and reap the entire process group.

### 10.2 Resource limits

Initial defaults, configurable per provider:

- handshake timeout: 15 seconds;
- turn timeout: 30 minutes;
- maximum protocol line: 1 MiB;
- bounded decoded-event queue: 1,000 events;
- retained stderr: 64 KiB with head/tail preservation;
- cancellation grace period: 3 seconds;
- termination grace period: 2 seconds.

Malformed JSON, oversized lines, protocol mismatches, unexpected EOF, and queue overflow produce explicit terminal events and cleanup.

### 10.3 Permission mediation

- Interactive runs present ACP permission choices to the user.
- Noninteractive runs deny requests unless an assignment policy explicitly allows the exact operation.
- Unknown operations default to deny.
- Coordinator and Verifier write requests are always denied.
- No provider receives a global bypass-permissions configuration.

## 11. Session and model semantics

### 11.1 Resume

Persist separately:

- orchestration segment ID;
- ACP session ID;
- provider-native session ID if exposed;
- process-generation ID;
- last completed turn and event sequence.

Resume in place only when the adapter advertises session loading and confirms the same session identity. Otherwise create a successor segment from a checkpoint.

### 11.2 Model switching

Switches occur only between completed turns.

For an in-session ACP switch:

1. Discover session configuration options.
2. Select an advertised option whose category is `model` or `model_config`.
3. Validate the requested value against allowed values.
4. Persist `model.switch.requested`.
5. Call `session/set_config_option`.
6. Confirm the returned effective option value.
7. Persist `model.switch.confirmed`; on rejection or ambiguity, persist `model.switch.failed`.

The implementation must not assume an option ID named `model`, and must not use the obsolete `session/set_model` method as the current protocol.

If unsupported, rejected, timed out, or cross-harness:

1. build a provenance-linked checkpoint;
2. close the predecessor segment;
3. create a successor segment with the target harness/model;
4. inject only the approved spec, selected memory, checkpoint, and evidence references;
5. record that native continuity was not preserved.

Example target flow:

```text
Codex / gpt-5.6-terra drafts specification v1
  -> user pauses at approval boundary
  -> switch coordinator to gpt-5.6-sol
  -> confirmed same-session change OR checkpoint-linked successor
  -> sol reviews and proposes specification v2
```

## 12. Persistence and crash recovery

Use `node:sqlite` behind repository interfaces so the driver can be replaced.

Database requirements:

- WAL mode;
- foreign keys enabled;
- busy timeout;
- schema migration table;
- restrictive file permissions where supported;
- one logical writer;
- transactions around event append and state projection;
- monotonic sequence per run;
- unique idempotency key for provider notifications and transitions.

Large payloads are redacted, hashed, and written to a content-addressed artifact directory. SQLite retains metadata plus bounded head/tail previews.

On restart:

- never trust a stored PID alone;
- mark abandoned `running` work as `interrupted`;
- replay idempotent events to rebuild projections;
- inspect worktree and artifact state;
- resume a confirmed provider session or create a checkpoint-linked successor.

## 13. Memory design

Memory has four layers:

1. Event log: authoritative audit history.
2. Artifacts: immutable specs, diffs, tests, checkpoints, and evidence.
3. Working context: approved spec, active constraints, decisions, failures, and open risks.
4. Durable typed memory: selected facts and lessons with provenance.

Every `MemoryEntry` contains:

- type: `constraint`, `decision`, `fact`, `risk`, or `evidence`;
- scope: run, project, role, or session lineage;
- source event/artifact;
- trust level;
- creation and optional expiry time;
- content hash;
- redacted content.

Selection is deterministic:

1. reject expired or out-of-scope entries;
2. preserve approved constraints and criteria;
3. rank trusted decisions, current failures, then evidence;
4. break ties by stable timestamp and ID;
5. stop at a configured character/token budget.

No raw transcript becomes semantic memory automatically. No vector store is required for the MVP.

A handoff checkpoint must preserve verbatim:

- approved spec hash and acceptance criteria;
- constraints and permission policy;
- confirmed decisions;
- unresolved risks;
- failing tests;
- artifact/evidence references;
- predecessor harness, model, session, and final turn.

## 14. Git worktree and merge-readiness rules

For each implementation assignment:

1. require a Git repository and resolve an immutable base SHA;
2. create a dedicated branch and worktree outside the primary checkout;
3. acquire a single-writer lease;
4. run the Implementor only inside that worktree;
5. record diff, tests, and resulting commit;
6. mount or inspect that exact commit read-only for the Verifier;
7. create `MergeReadiness` only for the verified commit.

Readiness fails if:

- any criterion is failed or unproven;
- the approved spec hash changed;
- the implementation commit differs from the verified commit;
- the destination checkout is dirty;
- the base branch drifted;
- conflicts are detected;
- required tests were not run or failed.

The MVP reports the exact manual integration command or patch but does not execute it.

## 15. Security and privacy

- Child processes receive a minimal environment allowlist.
- Credentials are inherited only when explicitly required by the selected provider.
- Redaction occurs before database writes, artifact writes, logging, checkpointing, memory extraction, and error reporting.
- Redaction covers authorization headers, common API-key formats, private keys, credential URLs, sensitive environment assignments, and configured project-specific patterns.
- Raw provider payloads are stored only after redaction and size bounding.
- Database and artifact paths never include prompts or secrets.
- Optional local Grok discovery reports path/version only; execution requires explicit configuration and consent.

## 16. CLI contract

```text
harness doctor [--json]
harness start --workspace PATH --goal TEXT --coordinator codex|claude [--model ID]
harness approve RUN_ID --spec-version ID
harness run RUN_ID --implementor PROFILE --verifier PROFILE
harness resume RUN_ID
harness status RUN_ID [--json]
harness switch-model RUN_ID --role ROLE --model ID [--harness ID]
harness cancel RUN_ID
```

Behavior:

- `doctor` checks Node/SQLite, lockfile adapter binaries, versions, ACP handshake, authentication readiness, Git, and optional discovered harnesses without executing untrusted binaries.
- `start` invokes the Coordinator and stops at `awaiting_approval`.
- `approve` binds an immutable spec version.
- `run` executes implementation and verification synchronously for the MVP.
- `resume` performs crash/session recovery.
- `switch-model` switches only at a safe boundary; otherwise it rejects the request.
- `cancel` is idempotent and persists one terminal result.

All commands support stable JSON output for future UI integration.

## 17. Testing and completion evidence

No live provider is required for deterministic CI. Faithful fake ACP subprocesses, fake clocks/IDs, and temporary Git repositories cover protocol and workflow behavior.

### 17.1 Required automated tests

1. ACP fragmented NDJSON.
2. Malformed and oversized protocol lines.
3. Stderr noise does not corrupt stdout.
4. Handshake timeout and protocol-version mismatch.
5. Bounded event queue/backpressure.
6. Permission request defaults to deny.
7. Cancellation during startup, permission wait, streaming, and tool execution.
8. Process-group cleanup without orphaned children.
9. Duplicate provider notification remains one logical event.
10. Restart after event append but before projection update recovers consistently.
11. Spec supersession makes existing assignment stale.
12. Missing verifier evidence prevents `merge_ready`.
13. Confirmed same-session model change.
14. Unsupported and cross-harness change creates a linked successor.
15. Redaction prevents fixture secrets in DB, logs, artifacts, checkpoints, and memory.
16. Memory selection preserves criteria, constraints, decisions, failures, and evidence.
17. Worktree isolation leaves the primary checkout unchanged.
18. Merge readiness rejects dirty destination, base drift, conflict, wrong commit, or failed criteria.
19. Full offline flow: goal -> spec -> approval -> worktree implementation -> verification -> merge-ready.

### 17.2 Live smoke tests

Run only with explicit user approval and existing authentication:

- initialize official Claude ACP and Codex ACP;
- create a read-only session in a temporary repository;
- prompt for a deterministic inspection-only response;
- confirm session identity, normalized events, cancellation, and cleanup;
- exercise a model-option query without forcing a paid or unsupported switch.

Live smoke failures are reported separately from deterministic correctness.

### 17.3 Definition of done

The MVP is complete only when:

- build, typecheck, and all offline tests pass;
- `doctor` accurately reports both configured official adapters;
- the CLI completes the offline vertical slice;
- at least one explicitly approved live adapter smoke test passes, or authentication is documented as the sole external blocker;
- all three role profiles and architecture/research documentation exist;
- an independent review finds no unresolved high-severity correctness or security issue;
- every change is consolidated in the main workspace and left unstaged for user review.

## 18. Implementation sequence

### Phase 1 — Contracts and persistence

- Domain types, event vocabulary, state machine, repository interfaces.
- SQLite migrations, artifact store, redaction, deterministic IDs/clocks.
- Coordinator, Implementor, and Verifier profiles.
- Unit tests for transitions, idempotency, memory, and recovery.

Exit gate: state and security invariants pass without any real harness.

### Phase 2 — Harness transport

- Adapter SPI.
- Supervised ACP subprocess transport.
- Claude and Codex package profiles.
- Fake ACP conformance suite.
- `doctor`, capability records, permissions, cancellation.

Exit gate: all protocol failure modes terminate cleanly without leaks.

### Phase 3 — Useful vertical slice

- Coordinator spec generation and approval.
- Git worktree assignment.
- Implementor evidence collection.
- Independent verifier and bounded remediation.
- Merge-readiness report.

Exit gate: full deterministic end-to-end fixture leaves the primary checkout unchanged.

### Phase 4 — Session, memory, and model changes

- Confirmed session loading.
- Same-session model configuration.
- Checkpoint-linked successor sessions.
- Structured memory selection and handoff.
- Restart/resume.

Exit gate: terra-to-sol-style escalation preserves lineage without fabricated continuity.

### Phase 5 — Verification and handoff

- Build/typecheck/test.
- Optional approved live smoke.
- Independent code and architecture reviews.
- Fix high-severity findings.
- Final evidence matrix and file/line references.
- Consolidate all changes in the main workspace, unstaged.

## 19. Review checklist

Please mark each item approved or add a correction:

- [ ] CLI-first core; Electron deferred.
- [ ] Official Claude ACP and Codex ACP are the only executable MVP providers.
- [ ] Coordinator-generated specification requires human approval.
- [ ] One implementor worktree and independent read-only verifier.
- [ ] Bounded remediation loop.
- [ ] Model changes only between turns; successor handoff when continuity is unavailable.
- [ ] SQLite event store plus structured provenance-bearing memory.
- [ ] Default-deny permission mediation and redaction-before-persistence.
- [ ] Verified merge readiness only; no automatic merge.
- [ ] Pi/OpenCode/Grok/Auggie adapters deferred but preserved in the SPI.

## 20. Primary references

- [Agent Client Protocol repository](https://github.com/agentclientprotocol/agent-client-protocol)
- [ACP TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [Claude Agent ACP package](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)
- [Codex ACP package](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)
- [Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [MCP architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture)
- [OpenCode ACP documentation](https://opencode.ai/docs/acp/)
- [Pi coding-agent repository](https://github.com/badlogic/pi-mono)
- [Augment Intent overview](https://www.augmentcode.com/blog/intent-a-workspace-for-agent-orchestration)
- Local Coordinator basis: `/Users/tagtaste/.augment/specialists/spec-writer.md`
- Local Implementor basis: `/Users/tagtaste/.augment/specialists/implementor.md`
- Local Verifier basis: `/Users/tagtaste/.augment/specialists/verifier.md`

