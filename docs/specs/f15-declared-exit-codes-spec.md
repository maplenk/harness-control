# F15 — a criterion may declare what exit code proves it

**Status:** drafted 2026-07-26, from a live finding in dogfood run `run_60ccbfda`.
**Severity:** blocks the dogfood ladder. Five criteria went `unproven` on a slice
whose code was, on the evidence, correct.

---

## 1. The finding

Run `run_60ccbfda` (B0, fixture-backed React shell) reached `verifying` with a
real implementor commit (`8141a82`, 17 files, 824 lines, scope respected). The
verifier — codex, independently, with host receipts — recorded:

```
failedCriteria:   []
unprovenCriteria: [AC-8, AC-9, AC-10, AC-11, AC-13]
```

`failedCriteria` is **empty**. Nothing was found wrong with the code. Four of the
five criteria could not be *proven*, and the verifier's own narrative evidence
says it independently confirmed them:

| AC | Verifier's recorded evidence |
| --- | --- |
| AC-9 | "Host receipt … exited 1 with empty output. I independently ran the same grep and observed no matches, then inspected every import under `web/`: none imports the engine tree or `dist/cli`." |
| AC-10 | "My independent git diff listed only `web/…` files. The non-web count printed 0, and the frozen-path diff was empty." |
| AC-11 | "web/vite.config.ts exists; the root/test-key grep returned no lines with exit 1 … Inspection shows only a plugins key." |

Those read as passes. They were recorded `unproven`.

## 2. Root cause

`src/app/flows/verifier.ts:876` (`#hostReceiptIssue`), the F13 host-attestation
gate:

```ts
if (current.receipt.exitCode !== 0) {
  return `Host receipt ${current.receipt.receiptId} exited ${current.receipt.exitCode}; ` +
         'execution did not prove the criterion, so it is unproven.';
}
```

A criterion is provable only if **every** declared command exits `0`.

`grep` exits `1` when it finds nothing. "Finds nothing" is the pass condition for
AC-8 (no network surface), AC-9 (no engine imports), AC-11 (no `root`/`test` key
in the Vite config), and AC-10's `grep -cv '^web/'` (prints `0`, exits `1`).

So the engine **cannot prove absence** — and absence is the shape of every scope,
isolation, and containment criterion. The criteria the harness most exists to
enforce are exactly the ones it cannot certify. This is the engine's
characteristic bug (house rule 2) in its false-refusal polarity: a command that
exited non-zero *was observed*; treating that as "I could not determine the
criterion" discards a real observation.

AC-13 is a **different** finding and is NOT in F15's scope: its command
`npx vite build --root web` is simply wrong for Vite 7 (`CACError: Unknown
option '--root'`; the CLI takes a positional root). That is a coordinator
spec-authoring defect, addressed by the operating law in §6, not by code.

## 3. What to build

### 3.1 A criterion may declare the exit code that proves it

`AcceptanceCriterion.verificationCommands` is `readonly string[]`
(`src/domain/entities.ts:74`). Widen the element to a union:

```ts
export type VerificationCommand =
  | string
  | { readonly command: string; readonly expectedExitCode: number };
```

A bare string means `expectedExitCode: 0` — **today's behaviour, unchanged**.

The gate compares `receipt.exitCode` against the declared code instead of `0`.

**Hashing.** `SpecVersion.contentHash` binds approval. A spec that declares no
exit codes MUST hash exactly as it does today, or every persisted approval breaks.
Normalize to the string form whenever the expected code is `0` — do not emit an
object with a `0` in it. Add a test that an all-string criterion set hashes
identically before and after this change (compute the hash on `main`, pin it).

### 3.2 Close the launch-failure hole this opens

`EvidenceReceipt` (`src/domain/entities.ts:264`) records `exitCode` but **not**
`launchFailed`. The runner sets `{ exitCode: 127, launchFailed: true }` for a
command that never started (`verifier.ts:174`, `implementor.ts:344`) and
`{ exitCode: 124, launchFailed: false }` for a timeout (`implementor.ts:359`).
The receipt flattens all of that to a number.

Today that is harmless, because any non-zero refuses. **F15 makes it dangerous**:
a criterion declaring `expectedExitCode: 127` would accept a command that never
ran, and one declaring `124` would accept a timeout as proof.

So:

- Add `launchFailed: boolean` to `EvidenceReceipt` and populate it from the
  outcome. It is part of the immutable receipt body, so it is bound into the CAS
  artifact like every other field.
- The gate refuses a receipt with `launchFailed === true` **regardless of the
  declared expected code**, with its own distinct message. A command that did not
  execute proves nothing; that is not a policy choice the spec may override.
- Consider the same for the timeout exit (`124`). Decide explicitly and say why
  in your report — do not leave it implicit.

**Persisted receipts predate this field** (house rule 9). Receipts already in the
store have no `launchFailed`. Validate and migrate at the read boundary: absent
means "recorded before the field existed", which is legitimately *unknown*, not
`false`. An unknown launch state may not prove a criterion whose declared code is
non-zero; it may continue to prove one whose declared code is `0`, because that
is exactly what the pre-F15 gate already accepted. Never crash on an old shape,
and never fabricate a modern attestation from a record that predates it.

### 3.3 The coordinator must be able to emit the new shape

Wherever the coordinator is told the criterion JSON schema
(`src/app/flows/verifier.ts:556` carries a sibling contract string; find the
coordinator's), teach it the object form and when to use it. State the rule in
the prompt, not only in the notes.

## 4. Explicitly out of scope

- Do **not** relax the gate into "the verifier may judge a non-zero exit on the
  evidence." That reopens precisely the hole F13 closed — model prose standing in
  for execution. The host receipt stays authoritative; F15 only lets the spec
  declare, in advance and under the approved hash, what the host must observe.
- Do not add shell inversion helpers (`! grep …`). See §6.

## 5. Definition of done

- `npm run typecheck` → 0 errors.
- `npm test` → full suite. Baseline on the branch point is **2063 passing**;
  report exact counts and investigate any move you did not intend.
- Tests that FAIL on the parent commit, for each of:
  - a criterion declaring `expectedExitCode: 1` with a matching receipt → `passed`;
  - the same criterion with a receipt that exited `0` → `unproven` (a declared
    code is an equality check, not a floor);
  - a receipt with `launchFailed: true` and a declared code of `127` → `unproven`,
    with the launch-failure message, not the exit-mismatch one;
  - a persisted receipt with no `launchFailed` field → does not crash; proves a
    `0`-declared criterion; does not prove a non-zero-declared one;
  - an all-string criterion set hashes identically to the pinned pre-change hash.
- Record the exact command and output for each parent failure.

## 6. The operating law this run also produced (not code — land it in the laws doc)

**L11 — a verification command's success exit must be declared, and inversion is
not a substitute.** The coordinator must either write commands that exit `0` on
success, or declare `expectedExitCode`. It must NOT wrap a check in `!` to force
a zero exit: `! grep -R pattern path` exits `0` both when the pattern is absent
*and* when grep failed with exit `2` (unreadable path, bad regex). That converts
"I could not determine X" into "X is false" — the same bug in the opposite
polarity. Where a distinction is needed, declare the code.

**L12 — a verification command must be executable as written, against the
versions actually installed.** AC-13 declared `npx vite build --root web`; the
installed Vite 7.3.6 takes a positional root and errors on `--root`. A criterion
whose command cannot run is unfixable by the implementor, because the command
lives in the frozen, hash-bound spec — so the run burns remediation rounds it
cannot possibly clear.
