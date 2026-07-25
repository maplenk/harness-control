/**
 * F15 — a criterion may declare the exit code that PROVES it.
 *
 * ## Why this module exists
 *
 * Before F15 a criterion was provable only if every declared command exited
 * `0`. `grep` exits `1` when it finds nothing, and "finds nothing" is the pass
 * condition of every scope, isolation and containment criterion — so the engine
 * could not prove ABSENCE, which is the shape of the criteria the harness most
 * exists to enforce. A real slice satisfied all thirteen of its criteria and was
 * rejected (`docs/specs/f15-declared-exit-codes-spec.md` §1).
 *
 * A criterion may now declare the exit code its command must produce. A BARE
 * STRING still means `expectedExitCode: 0` — today's behaviour, unchanged.
 *
 * ## Why the accessors live here and not at the call sites
 *
 * House rule 1: guard the state, not the routes. `verificationCommands` is read
 * in five modules — the runner, the argv builder, the permission allowlists, two
 * prompts, and the host-receipt gate. If each one destructured the union itself,
 * one forgotten site would silently read `[object Object]` as a shell command or
 * compare an exit code against `0`.
 *
 * So the union is deliberately NOT string-compatible: every existing site that
 * needed a `string` stopped compiling when `AcceptanceCriterion` widened, and the
 * ONLY way to get one back is `verificationCommandText`. The expectation has the
 * same treatment: `verificationCommandExpectedExitCode` is the only way to learn
 * what a receipt must show. `verification-command.chokepoints.test.ts` enumerates
 * every reader in `src/` and fails when a new one appears un-normalized.
 */

/** A command whose PROVING exit code is not `0` (e.g. `grep` finding nothing). */
export interface DeclaredVerificationCommand {
  readonly command: string;
  /**
   * The exit code that proves the criterion. `0` is never stored in this form —
   * `normalizeVerificationCommand` collapses it to the bare string so a spec
   * that declares nothing hashes byte-identically to a pre-F15 spec.
   */
  readonly expectedExitCode: number;
}

/**
 * One declared verification command. A bare `string` is the pre-F15 shape and
 * means "must exit 0"; persisted specs written before F15 contain only these,
 * which is why the string arm is kept rather than migrated away (house rule 9 —
 * an old record must stay readable without a rewrite).
 */
export type VerificationCommand = string | DeclaredVerificationCommand;

/**
 * The host's timeout / output-cap termination code. `defaultVerificationRunner`
 * reports `124` both when it kills a command at the deadline and when it kills
 * one for exceeding the output cap — and a command is also free to `exit 124` on
 * its own. Those are indistinguishable in the receipt, so `124` can never be
 * evidence of anything: see `reservedExitCodeReason`.
 */
export const HOST_TERMINATION_EXIT_CODE = 124;

/**
 * Sentinel for a declaration whose `expectedExitCode` is not a usable integer —
 * only reachable from a corrupt/hand-edited persisted record, since the §7 zod
 * schema rejects it at the write boundary. No process exit code is negative, so
 * it can never match a receipt: the criterion fails closed instead of silently
 * defaulting to `0` (house rule 2 — "I could not read the declaration" is not
 * "the declaration said 0").
 */
export const UNREADABLE_EXPECTED_EXIT_CODE = -1;

/** The shell command text — the ONLY supported way to get a `string` back. */
export function verificationCommandText(declared: VerificationCommand): string {
  return typeof declared === 'string' ? declared : declared.command;
}

/**
 * The exit code that proves this command. `0` for the bare-string form (the
 * pre-F15 contract), the declared code otherwise, and
 * `UNREADABLE_EXPECTED_EXIT_CODE` for a declaration that carries no usable
 * integer — never `0`, which would turn an unreadable record into a pass.
 */
export function verificationCommandExpectedExitCode(declared: VerificationCommand): number {
  if (typeof declared === 'string') return 0;
  const code: unknown = declared.expectedExitCode;
  return typeof code === 'number' && Number.isInteger(code)
    ? code
    : UNREADABLE_EXPECTED_EXIT_CODE;
}

/**
 * Why an expected exit code can never be proven, or `undefined` when it can.
 *
 * Reserving `124` refuses strictly LESS than the pre-F15 engine, which accepted
 * only `0` — so house rule 3 ("never refuse what the status quo accepts") is not
 * in tension: no spec that works today stops working. What it prevents is the
 * new false-acceptance F15 would otherwise open, where a criterion declaring
 * `124` accepts the harness giving up on a command as proof that the command
 * passed.
 */
export function reservedExitCodeReason(expectedExitCode: number): string | undefined {
  if (expectedExitCode === UNREADABLE_EXPECTED_EXIT_CODE) {
    return 'its declared expected exit code is not a readable integer';
  }
  if (expectedExitCode === HOST_TERMINATION_EXIT_CODE) {
    return (
      `exit ${HOST_TERMINATION_EXIT_CODE} is reserved by the host for timeout and ` +
      'output-cap terminations, which are indistinguishable from a command that ' +
      'chose to exit with it'
    );
  }
  if (!Number.isInteger(expectedExitCode) || expectedExitCode < 0 || expectedExitCode > 255) {
    return 'a process exit code must be an integer in 0..255';
  }
  return undefined;
}

/**
 * THE HASH CHOKEPOINT. `SpecVersion.contentHash` binds human approval, so a
 * criterion set that declares no exit codes must serialize byte-identically to
 * how it serialized before F15. Collapsing the `expectedExitCode: 0` object back
 * to a bare string is what guarantees that: the object form only ever reaches
 * the canonical bytes when it carries information the string form cannot.
 */
export function normalizeVerificationCommand(declared: VerificationCommand): VerificationCommand {
  if (typeof declared === 'string') return declared;
  return declared.expectedExitCode === 0 ? declared.command : declared;
}

export function normalizeVerificationCommands(
  declared: readonly VerificationCommand[],
): readonly VerificationCommand[] {
  return declared.map(normalizeVerificationCommand);
}

/**
 * How a declared command is shown to a model (both role prompts). The
 * expectation is stated whenever it is not the default, so the agent's own
 * judgment lines up with what the host gate will enforce rather than assuming
 * a non-zero exit means failure.
 */
export function describeVerificationCommand(declared: VerificationCommand): string {
  const expected = verificationCommandExpectedExitCode(declared);
  const text = verificationCommandText(declared);
  return expected === 0 ? text : `${text} (expects exit ${expected})`;
}

/**
 * The distinct shell command texts a role is permitted to run, in first-seen
 * order. Two declarations of the same command with different expected codes are
 * ONE permission — the allowlist governs execution, not proof.
 */
export function verificationCommandTexts(
  declared: readonly VerificationCommand[],
): readonly string[] {
  return [...new Set(declared.map(verificationCommandText))];
}
