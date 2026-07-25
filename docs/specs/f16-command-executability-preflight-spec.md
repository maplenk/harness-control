# F16 — prove a declared command can RUN before anyone commits to it

**Status:** drafted 2026-07-26 from dogfood run `run_60ccbfda`. Not started.
**Blocks:** enabling `approval: 'auto'`. Does NOT block the next human-approved run.

---

## 1. The finding

`run_60ccbfda` declared, as acceptance criterion AC-13:

```
npx vite build --root web
```

The installed Vite 7.3.6 takes a **positional** root and errors:
`CACError: Unknown option '--root'`. The correct form is `npx vite build web`,
which builds in 284 ms.

The coordinator drafts commands and **never executes one**. The implementor
cannot repair them, because `verificationCommands` are frozen under the approved
spec hash. So the run burned a remediation round it could never clear, and no
engine fix rescues it — the run was cancelled and re-specced.

Nothing in the engine catches this class. The only thing standing between a
broken command and a wasted slice today is a human reading the drafted spec.
**Auto-approval removes exactly that reader**, which is why this blocks it.

## 2. The design trap — read before proposing a gate

The obvious design is "refuse to approve a spec whose commands cannot run."
The obvious *implementation* of that is "refuse on exit 127 / launch failure",
because those are the only unambiguous non-execution signals.

**That would not have caught this defect.** `vite build --root web` exits `1`
with a usage error on stderr, not `127`. A gate narrow enough to be safe under
house rule 3 ("never refuse what the status quo accepts") is too narrow to be
useful; a gate wide enough to catch usage errors is a stderr heuristic that will
eventually refuse a legitimate command.

So do not build one gate. Build two things with different standards of proof.

## 3. What to build

### 3.1 Executability evidence at the approval gate (for humans)

Before a run can be approved, execute every declared verification command **once**
and record the outcome as evidence the operator sees at the gate: the criterion
id, the command, the exit code, and the first lines of stderr.

Nothing is refused on this basis. The operator reads
`AC-13: npx vite build --root web → exit 1 · CACError: Unknown option '--root'`
and declines to approve. That is decision support, and it is exactly what was
missing.

**Expect most commands to FAIL here, and say so in the output.** They run against
the base commit, where the feature does not exist yet. A criterion that *passes*
at base is itself worth flagging — it proves nothing about the work.

### 3.2 A conservative automatic refusal (for `approval: 'auto'`)

When the run is pinned `auto` there is no reader, so the engine must decide.
Refuse the approval when a declared command is **positively identified** as
non-executing:

- the launch failed (see F15, which adds `launchFailed` to the receipt), or
- exit `127`, or
- the shell reported `command not found`, or
- stderr matches a **high-confidence** usage-error signature for the tool that
  ran — and this list must be explicit, narrow, and justified in code, not a
  general "looks like usage" regex.

Everything else warns loudly and proceeds (house rule 3). A false refusal under
`auto` is cheap and recoverable — the coordinator re-drafts. A false *acceptance*
costs a whole slice, which is what happened.

### 3.3 Where it runs — this is the safety-critical decision

**Not in the operator's primary checkout.** Verification commands are arbitrary
shell; running them in the live working tree would violate L4 (repo freeze during
runs) and could destroy uncommitted work.

Run them in a provisioned worktree at the base commit, through the **same**
machinery the verification boundary already uses (`executeEvidenceReceipts`, the
W3-1 env allowlist, the 10-minute timeout, the 16 MB cap, the W4-7 process-group
reap). Do not write a second runner: a preflight that executes commands under
weaker confinement than verification is a new hole, not a guard.

Cost note: this provisions a worktree earlier than today. Measure it and say what
it costs. If provisioning at approval time is too expensive, the acceptable
fallback is to run the preflight at the **start of the implement phase**, before
the implementor is dispatched — which still converts "burn every remediation
round" into "fail immediately, naming the exact bad command", for near-zero extra
cost. State which you built and why.

## 4. Explicitly out of scope

- Do not try to validate flags statically against installed tool versions. There
  is no reliable source for that, and a wrong static rule refuses valid commands.
- Do not let the preflight's outcome substitute for verification. It proves a
  command *runs*, never that a criterion *holds*.

## 5. Definition of done

- Preflight evidence is visible at the approval gate for every declared command.
- Under `approval: 'auto'`, a `127` / launch-failure / `command not found`
  command refuses the approval, with the criterion id and command in the message.
- A command that merely FAILS at base (the normal case) does not refuse, under
  either mode. There is a test proving this — it is the false-refusal direction
  and it is the one that will bite.
- The preflight executes through the existing verification runner, with the same
  confinement. A test proves the env allowlist and timeout apply.
- `npm run typecheck` 0; full suite green with exact counts against a recorded
  baseline; `npm run build` clean.

## 6. Relationship to F15

Independent, but they touch the same structures. F15 widens
`verificationCommands` to carry a declared expected exit code and adds
`launchFailed` to `EvidenceReceipt`. F16 consumes `launchFailed` in §3.2. **Land
F15 first**, then build F16 on the merged shape.
