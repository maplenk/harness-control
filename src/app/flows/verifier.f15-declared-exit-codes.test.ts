/**
 * F15 — a criterion may declare the exit code that proves it.
 *
 * The finding this closes (`docs/specs/f15-declared-exit-codes-spec.md` §1): a
 * criterion was provable only if every declared command exited `0`, and `grep`
 * exits `1` when it finds nothing. "Finds nothing" is the pass condition of
 * every absence/scope/isolation criterion, so the engine could not prove the
 * criteria the harness most exists to enforce. A real slice satisfied all
 * thirteen of its criteria and was rejected.
 *
 * Every test in the first four blocks FAILS on the parent commit — see the
 * recorded proofs in the F15 report.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import {
  buildVerifierPrompt,
  executeEvidenceReceipts,
  hostReceiptProofIssue,
  VerifierRunner,
  verificationCommandArgv,
  type EvidenceRecorder,
} from './verifier.js';
import { buildImplementorPrompt, type VerificationCommandOutcome } from './implementor.js';
import { canonicalizeSpec, validateCoordinatorSpec } from './coordinator.js';
import {
  describeVerificationCommand,
  normalizeVerificationCommand,
  reservedExitCodeReason,
  verificationCommandExpectedExitCode,
  verificationCommandText,
  verificationCommandTexts,
  HOST_TERMINATION_EXIT_CODE,
  UNREADABLE_EXPECTED_EXIT_CODE,
  type VerificationCommand,
} from '../../domain/verification-command.js';
import type { AcceptanceCriterion, EvidenceReceipt } from '../../domain/entities.js';
import { artifactHash, criterionId, gitSha, runId, specHash } from '../../domain/ids.js';
import { isoTimestamp } from '../../lib/clock.js';
import type { RoleSession } from '../role-runner.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const RUN = runId('run_f15');
const SPEC = specHash('spec_f15');
const COMMIT = gitSha('c'.repeat(40));
const CWD = '/worktree/f15';

function crit(id: string, commands: readonly VerificationCommand[]): AcceptanceCriterion {
  return {
    id: criterionId(id),
    description: `Criterion ${id}`,
    verificationCommands: commands,
    expectedEvidence: 'no matching lines',
  };
}

/**
 * A host receipt for one declared command. `launchFailed` is spread from
 * `overrides` so a test can OMIT it entirely and model a receipt written before
 * F15 existed — which is what every receipt already in the store looks like.
 */
function receipt(
  declared: VerificationCommand,
  overrides: Partial<EvidenceReceipt> & { readonly criterion?: string } = {},
): EvidenceReceipt {
  const { criterion = 'AC-1', ...rest } = overrides;
  return {
    receiptId: 'receipt_1',
    receiptRef: artifactHash('receipt_ref_1'),
    runId: RUN,
    criterionId: criterionId(criterion),
    specHash: SPEC,
    implementationCommit: COMMIT,
    argv: verificationCommandArgv(verificationCommandText(declared)),
    cwd: CWD,
    exitCode: 0,
    launchFailed: false,
    startedAt: isoTimestamp('2026-07-26T00:00:00.000Z'),
    endedAt: isoTimestamp('2026-07-26T00:00:01.000Z'),
    stdoutRef: artifactHash('stdout_1'),
    stderrRef: artifactHash('stderr_1'),
    outputDigest: 'digest_1',
    toolchain: {
      node: 'v22.0.0',
      platform: 'darwin',
      arch: 'arm64',
      provisioningMarker: 'clone:fingerprint',
    },
    ...rest,
  };
}

/** A receipt as the store holds it from before F15: NO `launchFailed` key. */
function legacyReceipt(
  declared: VerificationCommand,
  overrides: Partial<EvidenceReceipt> = {},
): EvidenceReceipt {
  const full = receipt(declared, overrides);
  const { launchFailed: _dropped, ...withoutLaunchState } = full;
  // Round-tripped through JSON the way the store does, so this is genuinely the
  // persisted shape rather than a TypeScript-only omission.
  return JSON.parse(JSON.stringify(withoutLaunchState)) as EvidenceReceipt;
}

function fakeEvidence(): EvidenceRecorder {
  let n = 0;
  return {
    record: async (): Promise<ReturnType<typeof artifactHash>> => {
      n += 1;
      return artifactHash(`ev_${n}`);
    },
  };
}

/** Minimal session: the verifier flow only needs `runId` + one prompt turn. */
function sessionReporting(
  rows: ReadonlyArray<{ id: string; verdict: string; evidence?: string }>,
): RoleSession {
  return {
    runId: RUN,
    prompt: async (input: {
      readonly onUpdate?: (update: { kind: string; text: string }) => void;
    }) => {
      input.onUpdate?.({
        kind: 'agent_message_chunk',
        text: JSON.stringify({ criteria: rows }),
      });
      return { kind: 'completed', stopReason: 'end_turn', origin: 'fresh' };
    },
  } as unknown as RoleSession;
}

async function verdictFor(
  criterion: AcceptanceCriterion,
  hostReceipts: readonly EvidenceReceipt[],
): Promise<{ readonly verdict: string; readonly note: string }> {
  const runner = new VerifierRunner({
    criteria: [criterion],
    runId: RUN,
    specHash: SPEC,
    implementationCommit: COMMIT,
    cwd: CWD,
    evidence: fakeEvidence(),
    hostReceipts,
    hostVerificationPassed: true,
  });
  const gathering = await runner.run(
    sessionReporting([
      { id: String(criterion.id), verdict: 'passed', evidence: 'I ran it and observed the pass.' },
    ]),
  );
  const result = gathering.criteria[0]!;
  return { verdict: result.verdict, note: result.note ?? '' };
}

// ===========================================================================
// 1. The gate decision itself (pure)
// ===========================================================================
describe('F15 — hostReceiptProofIssue: the declared code is what proves the command', () => {
  it('a criterion declaring exit 1 is PROVEN by a receipt that exited 1 (absence is provable)', () => {
    const declared = { command: 'grep -rn "dist/cli" web/', expectedExitCode: 1 };
    expect(hostReceiptProofIssue(receipt(declared, { exitCode: 1 }), declared)).toBeUndefined();
  });

  it('a declared code is an EQUALITY check, not a floor: exit 0 does not prove a declared 1', () => {
    const declared = { command: 'grep -rn "dist/cli" web/', expectedExitCode: 1 };
    const issue = hostReceiptProofIssue(receipt(declared, { exitCode: 0 }), declared);
    expect(issue).toMatch(/exited 0, not the declared 1/);
  });

  it('a bare string still means exit 0 — the pre-F15 contract, unchanged in both directions', () => {
    expect(hostReceiptProofIssue(receipt('npm test', { exitCode: 0 }), 'npm test')).toBeUndefined();
    expect(hostReceiptProofIssue(receipt('npm test', { exitCode: 1 }), 'npm test')).toMatch(
      /exited 1, not the declared 0/,
    );
  });

  it('a FAILED LAUNCH is refused even when the spec declared 127, with its own message', () => {
    const declared = { command: 'nosuchbinary', expectedExitCode: 127 };
    const issue = hostReceiptProofIssue(
      receipt(declared, { exitCode: 127, launchFailed: true }),
      declared,
    );
    expect(issue).toMatch(/never LAUNCHED/);
    expect(issue).toMatch(/regardless of the declared expected exit code/);
    // NOT the exit-mismatch message — the exit codes DO match here.
    expect(issue).not.toMatch(/not the declared/);
  });

  it('exit 127 from a command that DID launch proves a criterion declaring 127', () => {
    // `/bin/sh -c 'nosuchcmd'` really does exit 127 with the shell running fine;
    // that is an observation, unlike a spawn that never happened.
    const declared = { command: 'sh -c "nosuchcmd"', expectedExitCode: 127 };
    expect(
      hostReceiptProofIssue(receipt(declared, { exitCode: 127, launchFailed: false }), declared),
    ).toBeUndefined();
  });

  it('the host termination code 124 can never be declared — nor can it prove anything', () => {
    const declared = { command: 'sleep 600', expectedExitCode: HOST_TERMINATION_EXIT_CODE };
    expect(hostReceiptProofIssue(receipt(declared, { exitCode: 124 }), declared)).toMatch(
      /can never prove it/,
    );
    // And the OBSERVATION side: a timeout never proves a 0-declared criterion
    // either, and says why rather than reporting a bare mismatch.
    expect(hostReceiptProofIssue(receipt('npm test', { exitCode: 124 }), 'npm test')).toMatch(
      /timeout\/output-cap termination code/,
    );
  });

  it('an unreadable declared code fails closed instead of defaulting to 0', () => {
    const corrupt = { command: 'grep -rn x .' } as unknown as VerificationCommand;
    expect(verificationCommandExpectedExitCode(corrupt)).toBe(UNREADABLE_EXPECTED_EXIT_CODE);
    expect(hostReceiptProofIssue(receipt(corrupt, { exitCode: 0 }), corrupt)).toMatch(
      /not a readable integer/,
    );
  });
});

// ===========================================================================
// 2. Persisted receipts predate `launchFailed` (house rule 9)
// ===========================================================================
describe('F15 — a receipt written before launch state existed is UNKNOWN, never false', () => {
  it('does not crash, and still proves a 0-declared criterion (exactly what pre-F15 accepted)', () => {
    const legacy = legacyReceipt('npm test', { exitCode: 0 });
    expect('launchFailed' in legacy).toBe(false);
    expect(hostReceiptProofIssue(legacy, 'npm test')).toBeUndefined();
  });

  it('does NOT prove a non-zero-declared criterion — 1 could have been a failed launch', () => {
    const declared = { command: 'grep -rn "dist/cli" web/', expectedExitCode: 1 };
    const legacy = legacyReceipt(declared, { exitCode: 1 });
    const issue = hostReceiptProofIssue(legacy, declared);
    expect(issue).toMatch(/predates launch-state recording/);
    expect(issue).not.toMatch(/not the declared/);
  });

  it('still refuses a 0-declared criterion whose receipt exited non-zero', () => {
    expect(hostReceiptProofIssue(legacyReceipt('npm test', { exitCode: 1 }), 'npm test')).toMatch(
      /exited 1, not the declared 0/,
    );
  });
});

// ===========================================================================
// 3. The gate FIRES inside the flow (house rule 5)
// ===========================================================================
describe('F15 — VerifierRunner applies the declared code to the real verdict', () => {
  it('a matching receipt lets a declaring criterion PASS (the rejected-slice shape)', async () => {
    const c = crit('AC-1', [{ command: 'grep -rn "dist/cli" web/', expectedExitCode: 1 }]);
    const { verdict } = await verdictFor(c, [
      receipt(c.verificationCommands[0]!, { exitCode: 1 }),
    ]);
    expect(verdict).toBe('passed');
  });

  it('a zero-exit receipt leaves a 1-declaring criterion UNPROVEN even when the model says passed', async () => {
    const c = crit('AC-1', [{ command: 'grep -rn "dist/cli" web/', expectedExitCode: 1 }]);
    const { verdict, note } = await verdictFor(c, [
      receipt(c.verificationCommands[0]!, { exitCode: 0 }),
    ]);
    expect(verdict).toBe('unproven');
    expect(note).toMatch(/exited 0, not the declared 1/);
  });

  it('a failed launch blocks a 127-declaring criterion with the launch-failure note', async () => {
    const c = crit('AC-1', [{ command: 'nosuchbinary', expectedExitCode: 127 }]);
    const { verdict, note } = await verdictFor(c, [
      receipt(c.verificationCommands[0]!, { exitCode: 127, launchFailed: true }),
    ]);
    expect(verdict).toBe('unproven');
    expect(note).toMatch(/never LAUNCHED/);
  });

  it('a pre-F15 receipt blocks a declaring criterion but still clears a plain one', async () => {
    const declaring = crit('AC-1', [{ command: 'grep -rn x .', expectedExitCode: 1 }]);
    const blocked = await verdictFor(declaring, [
      legacyReceipt(declaring.verificationCommands[0]!, { exitCode: 1 }),
    ]);
    expect(blocked.verdict).toBe('unproven');
    expect(blocked.note).toMatch(/predates launch-state recording/);

    const plain = crit('AC-1', ['npm test']);
    const cleared = await verdictFor(plain, [
      legacyReceipt(plain.verificationCommands[0]!, { exitCode: 0 }),
    ]);
    expect(cleared.verdict).toBe('passed');
  });

  it('the shell allowlist carries the command TEXT, never the declaration object', () => {
    const runner = new VerifierRunner({
      criteria: [
        crit('AC-1', [{ command: 'grep -rn x .', expectedExitCode: 1 }, 'npm test']),
        crit('AC-2', [{ command: 'grep -rn x .', expectedExitCode: 2 }]),
      ],
      runId: RUN,
      specHash: SPEC,
      implementationCommit: COMMIT,
      cwd: CWD,
      evidence: fakeEvidence(),
      hostReceipts: [],
      hostVerificationPassed: true,
    });
    expect(runner.allowedShellCommands).toEqual(['grep -rn x .', 'npm test']);
  });
});

// ===========================================================================
// 4. The receipt records launch state (§3.2)
// ===========================================================================
describe('F15 — executeEvidenceReceipts records launch state on every receipt', () => {
  const deps = {
    runId: RUN,
    binding: { specHash: SPEC, implementationCommit: COMMIT },
    cwd: CWD,
    evidence: fakeEvidence(),
    provisioningMarker: 'clone:fingerprint',
    ids: { nextId: (prefix: string) => `${prefix}_1` } as never,
    clock: { nowIso: () => isoTimestamp('2026-07-26T00:00:00.000Z') } as never,
  };

  it('carries the runner outcome through, and runs the DECLARED command text', async () => {
    const seen: string[] = [];
    const receipts = await executeEvidenceReceipts({
      ...deps,
      criteria: [crit('AC-1', [{ command: 'grep -rn x .', expectedExitCode: 1 }])],
      runner: async (command: string): Promise<VerificationCommandOutcome> => {
        seen.push(command);
        return { exitCode: 1, stdout: '', stderr: '', launchFailed: false };
      },
    });
    expect(seen).toEqual(['grep -rn x .']);
    expect(receipts[0]!.argv).toEqual(verificationCommandArgv('grep -rn x .'));
    expect(receipts[0]!.exitCode).toBe(1);
    expect(receipts[0]!.launchFailed).toBe(false);
  });

  it('records launchFailed=true when the runner itself throws', async () => {
    const receipts = await executeEvidenceReceipts({
      ...deps,
      criteria: [crit('AC-1', ['npm test'])],
      runner: async (): Promise<VerificationCommandOutcome> => {
        throw new Error('no shell');
      },
    });
    expect(receipts[0]!.exitCode).toBe(127);
    expect(receipts[0]!.launchFailed).toBe(true);
  });

  it('binds launch state into the receipt BODY, so it is covered by the CAS ref', async () => {
    const bodies: string[] = [];
    const receipts = await executeEvidenceReceipts({
      ...deps,
      evidence: {
        record: async (input: { content: string }) => {
          bodies.push(input.content);
          return artifactHash(`ev_${bodies.length}`);
        },
      },
      criteria: [crit('AC-1', ['npm test'])],
      runner: async (): Promise<VerificationCommandOutcome> => ({
        exitCode: 0,
        stdout: '',
        stderr: '',
        launchFailed: false,
      }),
    });
    // stdout, stderr, then the receipt body — the third recorded artifact.
    const body = JSON.parse(bodies[2]!) as Record<string, unknown>;
    expect(body['launchFailed']).toBe(false);
    expect(receipts[0]!.receiptRef).toBeDefined();
  });
});

// ===========================================================================
// 5. Hash stability — approval must survive this change byte-for-byte
// ===========================================================================
/**
 * Computed on the PARENT commit (4e307f3) before any F15 edit, with:
 *   npx tsx -e "…canonicalizeSpec(validateCoordinatorSpec(FIXTURE).value)…"
 * If either literal moves, every persisted human approval whose spec declares no
 * exit codes has silently been invalidated.
 */
const PRE_F15_CANONICAL_SHA256 =
  'd7a6a8931df0a472d2d66de1da1eb8807b0a8d24e41dd4dfe946cc6b065ad2f4';
const PRE_F15_CANONICAL_BYTES = 1086;

const ALL_STRING_SPEC = {
  goal: 'F15 hash-stability fixture: an all-string criterion set',
  assumptions: ['the fixture is frozen'],
  openQuestions: [],
  constraints: ['no network'],
  permissions: ['read the repo'],
  nonGoals: ['rewriting history'],
  tasks: [
    { id: 'T1', description: 'implement the thing', dependsOn: [] },
    { id: 'T2', description: 'prove the thing', dependsOn: ['T1'] },
  ],
  acceptanceCriteria: [
    {
      id: 'AC-1',
      description: 'the suite passes',
      verificationCommands: ['npm test'],
      expectedEvidence: 'exit code 0',
    },
    {
      id: 'AC-2',
      description: 'no engine import leaks into web/',
      verificationCommands: ['grep -rn "dist/cli" web/', 'npx tsc --noEmit'],
      expectedEvidence: 'no matching lines in stdout',
    },
  ],
  rollback: 'git revert the commit',
  proposedImplementorProfile: 'implementor',
  proposedVerifierProfile: 'verifier',
} as const;

function canonicalize(raw: unknown): string {
  const validated = validateCoordinatorSpec(raw);
  if (!validated.ok) throw new Error(`fixture rejected: ${JSON.stringify(validated.error)}`);
  return canonicalizeSpec(validated.value);
}

function sha256(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

describe('F15 — SpecVersion.contentHash is unchanged for a spec that declares nothing', () => {
  it('an all-string criterion set hashes to the pinned PRE-CHANGE digest', () => {
    const canonical = canonicalize(ALL_STRING_SPEC);
    expect(Buffer.from(canonical, 'utf8').byteLength).toBe(PRE_F15_CANONICAL_BYTES);
    expect(sha256(canonical)).toBe(PRE_F15_CANONICAL_SHA256);
  });

  it('an explicit `expectedExitCode: 0` normalizes to the bare string and hashes identically', () => {
    const withZeroObjects = {
      ...ALL_STRING_SPEC,
      acceptanceCriteria: ALL_STRING_SPEC.acceptanceCriteria.map((c) => ({
        ...c,
        verificationCommands: c.verificationCommands.map((command) => ({
          command,
          expectedExitCode: 0,
        })),
      })),
    };
    expect(sha256(canonicalize(withZeroObjects))).toBe(PRE_F15_CANONICAL_SHA256);
  });

  it('a NON-zero declaration DOES change the hash — it is part of what a human approved', () => {
    const declaring = {
      ...ALL_STRING_SPEC,
      acceptanceCriteria: ALL_STRING_SPEC.acceptanceCriteria.map((c, i) =>
        i === 1
          ? {
              ...c,
              verificationCommands: [
                { command: 'grep -rn "dist/cli" web/', expectedExitCode: 1 },
                'npx tsc --noEmit',
              ],
            }
          : c,
      ),
    };
    expect(sha256(canonicalize(declaring))).not.toBe(PRE_F15_CANONICAL_SHA256);
  });

  it('canonicalizeSpec normalizes even a hand-assembled document that bypassed the schema', () => {
    const validated = validateCoordinatorSpec(ALL_STRING_SPEC);
    if (!validated.ok) throw new Error('fixture rejected');
    const handAssembled = {
      ...validated.value,
      acceptanceCriteria: validated.value.acceptanceCriteria.map((c) => ({
        ...c,
        verificationCommands: c.verificationCommands.map((command) => ({
          command: verificationCommandText(command),
          expectedExitCode: 0,
        })),
      })),
    };
    expect(sha256(canonicalizeSpec(handAssembled))).toBe(PRE_F15_CANONICAL_SHA256);
  });
});

// ===========================================================================
// 6. The §7 schema admits the declaration and refuses what cannot prove
// ===========================================================================
describe('F15 — the coordinator spec schema (§7)', () => {
  function withCommands(commands: readonly unknown[]): unknown {
    return {
      ...ALL_STRING_SPEC,
      acceptanceCriteria: [
        { ...ALL_STRING_SPEC.acceptanceCriteria[0], verificationCommands: commands },
      ],
    };
  }

  it('accepts the object form and keeps a non-zero declaration', () => {
    const result = validateCoordinatorSpec(
      withCommands([{ command: 'grep -rn x .', expectedExitCode: 1 }]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.acceptanceCriteria[0]!.verificationCommands[0]).toEqual({
      command: 'grep -rn x .',
      expectedExitCode: 1,
    });
  });

  it('rejects the host-reserved 124 at spec time, where the coordinator can still fix it', () => {
    const result = validateCoordinatorSpec(
      withCommands([{ command: 'sleep 600', expectedExitCode: 124 }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.map((i) => i.message).join('\n')).toMatch(/can never prove a criterion/);
  });

  it('rejects a non-integer, out-of-range, or unknown-key declaration', () => {
    for (const bad of [
      { command: 'x', expectedExitCode: 1.5 },
      { command: 'x', expectedExitCode: -1 },
      { command: 'x', expectedExitCode: 256 },
      { command: 'x', expectedExitCode: 1, extra: true },
      { command: '', expectedExitCode: 1 },
    ]) {
      expect(validateCoordinatorSpec(withCommands([bad])).ok).toBe(false);
    }
  });
});

// ===========================================================================
// 7. Both role prompts state the rule (§3.3)
// ===========================================================================
describe('F15 — the prompts teach the declaration, not just the notes', () => {
  it('the verifier prompt renders the expectation and states the equality rule', () => {
    const c = crit('AC-1', [{ command: 'grep -rn x .', expectedExitCode: 1 }, 'npm test']);
    const prompt = buildVerifierPrompt({
      criteria: [c],
      implementationCommit: COMMIT,
      hostReceipts: [receipt(c.verificationCommands[0]!, { exitCode: 1 })],
    });
    expect(prompt).toContain('grep -rn x . (expects exit 1)');
    expect(prompt).toContain('npm test');
    expect(prompt).toMatch(/exitCode EQUALS the exit code the criterion\s+declares/);
    expect(prompt).toContain('launchFailed=false');
  });

  it('the verifier prompt shows an unknown launch state as unknown, not false', () => {
    const prompt = buildVerifierPrompt({
      criteria: [crit('AC-1', ['npm test'])],
      implementationCommit: COMMIT,
      hostReceipts: [legacyReceipt('npm test')],
    });
    expect(prompt).toContain('launchFailed=unknown');
  });

  it('the implementor prompt shows the expectation in both criterion and command blocks', () => {
    const prompt = buildImplementorPrompt(
      {
        goal: 'g',
        specHash: SPEC,
        specDocument: '{}',
        criteria: [crit('AC-1', [{ command: 'grep -rn x .', expectedExitCode: 1 }])],
        taskScope: 's',
      },
      CWD,
    );
    expect(prompt.match(/grep -rn x \. \(expects exit 1\)/g)?.length).toBe(2);
  });

  it('the coordinator emission contract teaches the object form and the absence rule', async () => {
    const contract = readFileSync(
      path.join(SRC_ROOT, 'app', 'flows', 'coordinator.ts'),
      'utf8',
    );
    expect(contract).toContain('"expectedExitCode": 1');
    expect(contract).toMatch(/exit 1 when they find nothing/);
  });
});

// ===========================================================================
// 8. Chokepoint inventory (house rule 1)
// ===========================================================================
const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function productionSources(): readonly string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        files.push(full);
      }
    }
  };
  walk(SRC_ROOT);
  return files.sort();
}

/**
 * Line span of a top-level `export function <name>(…) { … }`, closing on the
 * first column-0 `}`. Deliberately simple: it only has to bound one known
 * function in one known file, and it fails LOUDLY (returns `undefined`, so the
 * caller stops exempting anything) if that function is renamed or nested.
 */
function topLevelFunctionRange(
  text: string,
  name: string,
): { readonly start: number; readonly end: number } | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`export function ${name}(`));
  if (start < 0) return undefined;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i] === '}') return { start: start + 1, end: i + 1 };
  }
  return undefined;
}

/** A source line that is not a comment or a doc line. */
function codeLines(text: string): readonly { readonly line: number; readonly code: string }[] {
  return text
    .split('\n')
    .map((raw, i) => ({ line: i + 1, code: raw.trim() }))
    .filter(({ code }) => !code.startsWith('*') && !code.startsWith('//') && !code.startsWith('/*'));
}

describe('F15 — every reader of a declared command crosses the normalizing chokepoint', () => {
  /**
   * House rule 1: a fix that is a check at a call site is not a fix if a future
   * contributor must REMEMBER to add it. The union type already stops a new
   * reader that needs a `string` from compiling — but `.join()` and template
   * interpolation compile fine and would silently emit `[object Object]` as a
   * shell command. So the readers are ENUMERATED: adding one fails this test
   * until it is classified here.
   */
  const APPROVED_READERS: ReadonlyMap<string, readonly string[]> = new Map([
    [
      'app/flows/verifier.ts',
      [
        'for (const declared of criterion.verificationCommands) {', // execute → verificationCommandText
        'if (c.verificationCommands.length > 0) {', // length only
        '`     verification commands: ${c.verificationCommands', // → describeVerificationCommand
        'config.criteria.flatMap((criterion) => criterion.verificationCommands),', // → verificationCommandTexts
        'if (criterion.verificationCommands.length === 0) return undefined;', // length only
        'for (const declared of criterion.verificationCommands) {', // gate → text + expected code
        'if (c.verificationCommands.length === 0) return true;', // length only
      ],
    ],
    [
      'app/flows/implementor.ts',
      [
        'readonly verificationCommands?: readonly VerificationCommand[];', // declaration
        'if (context.verificationCommands !== undefined) return context.verificationCommands;', // typed pass-through
        'for (const declared of criterion.verificationCommands) {', // → text + expected code
        'c.verificationCommands.length > 0', // length only
        '? c.verificationCommands.map(describeVerificationCommand).join(\' && \')', // → describe
      ],
    ],
    [
      'app/flows/coordinator.ts',
      [
        'verificationCommands: z', // the §7 schema (normalizes on parse)
        'verificationCommands: normalizeVerificationCommands(c.verificationCommands),', // canonical bytes
        'verificationCommands: normalizeVerificationCommands(c.verificationCommands),', // persisted entity
      ],
    ],
    [
      'cli/commands.ts',
      ['verificationCommands: normalizeVerificationCommands(c.verificationCommands),'],
    ],
    ['domain/entities.ts', ['readonly verificationCommands: readonly VerificationCommand[];']],
  ]);

  it('the production reader set is exactly the classified one', () => {
    const found = new Map<string, string[]>();
    for (const file of productionSources()) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      if (rel === 'domain/verification-command.ts') continue; // the chokepoint itself
      for (const { code } of codeLines(readFileSync(file, 'utf8'))) {
        if (!/\bverificationCommands\b/.test(code)) continue;
        // The coordinator's emission contract is a prompt string, not a reader.
        if (code.includes('"acceptanceCriteria"')) continue;
        const bucket = found.get(rel) ?? [];
        bucket.push(code);
        found.set(rel, bucket);
      }
    }
    expect([...found.keys()].sort()).toEqual([...APPROVED_READERS.keys()].sort());
    for (const [rel, lines] of found) {
      expect(lines, `unclassified verificationCommands reader in ${rel}`).toEqual(
        APPROVED_READERS.get(rel),
      );
    }
  });

  it('exactly ONE production site constructs an evidence receipt body', () => {
    const sites: string[] = [];
    for (const file of productionSources()) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      for (const { code } of codeLines(readFileSync(file, 'utf8'))) {
        if (/^receiptId:/.test(code)) sites.push(rel);
      }
    }
    // If this grows, the new site must use `HostEvidenceReceiptBody` so that
    // omitting `launchFailed` is a compile error rather than a silent unknown.
    expect(sites).toEqual(['app/flows/verifier.ts']);
  });

  it('no production site compares a receipt exit code outside the gate function', () => {
    // Scoped to RECEIPT exit codes on purpose: the codebase compares plenty of
    // process exit codes (git probes, child processes, the CLI's own status),
    // and none of those are host attestations. A receipt-shaped name is the
    // thing that must never be judged outside the gate.
    const RECEIPT_EXIT_COMPARISON = /[Rr]eceipt\w*\.exitCode\s*[!=]==/;
    const offenders: string[] = [];
    for (const file of productionSources()) {
      const rel = path.relative(SRC_ROOT, file).split(path.sep).join('/');
      const text = readFileSync(file, 'utf8');
      const gate = topLevelFunctionRange(text, 'hostReceiptProofIssue');
      for (const { code, line } of codeLines(text)) {
        if (!RECEIPT_EXIT_COMPARISON.test(code)) continue;
        if (gate !== undefined && line >= gate.start && line <= gate.end) continue;
        offenders.push(`${rel}:${line}`);
      }
    }
    // `hostReceiptProofIssue` is the only place an exit code may be JUDGED, and
    // it cannot be called without the declaration that says which code proves
    // it. A comparison anywhere else is the pre-F15 bug growing back.
    expect(offenders).toEqual([]);
  });
});

// ===========================================================================
// 9. The accessors themselves
// ===========================================================================
describe('F15 — verification-command accessors', () => {
  it('read both arms without the caller destructuring the union', () => {
    expect(verificationCommandText('npm test')).toBe('npm test');
    expect(verificationCommandExpectedExitCode('npm test')).toBe(0);
    expect(verificationCommandText({ command: 'grep x .', expectedExitCode: 1 })).toBe('grep x .');
    expect(verificationCommandExpectedExitCode({ command: 'grep x .', expectedExitCode: 1 })).toBe(
      1,
    );
  });

  it('normalize collapses an expected-0 object and preserves everything else', () => {
    expect(normalizeVerificationCommand({ command: 'npm test', expectedExitCode: 0 })).toBe(
      'npm test',
    );
    expect(normalizeVerificationCommand({ command: 'grep x .', expectedExitCode: 1 })).toEqual({
      command: 'grep x .',
      expectedExitCode: 1,
    });
    expect(normalizeVerificationCommand('npm test')).toBe('npm test');
  });

  it('describe annotates only a non-default expectation', () => {
    expect(describeVerificationCommand('npm test')).toBe('npm test');
    expect(describeVerificationCommand({ command: 'npm test', expectedExitCode: 0 })).toBe(
      'npm test',
    );
    expect(describeVerificationCommand({ command: 'grep x .', expectedExitCode: 1 })).toBe(
      'grep x . (expects exit 1)',
    );
  });

  it('the permission allowlist dedupes by TEXT across differing expectations', () => {
    expect(
      verificationCommandTexts([
        'grep x .',
        { command: 'grep x .', expectedExitCode: 1 },
        { command: 'grep x .', expectedExitCode: 2 },
        'npm test',
      ]),
    ).toEqual(['grep x .', 'npm test']);
  });

  it('reservedExitCodeReason names every code that can never prove a criterion', () => {
    expect(reservedExitCodeReason(0)).toBeUndefined();
    expect(reservedExitCodeReason(1)).toBeUndefined();
    expect(reservedExitCodeReason(127)).toBeUndefined();
    expect(reservedExitCodeReason(HOST_TERMINATION_EXIT_CODE)).toMatch(/reserved by the host/);
    expect(reservedExitCodeReason(UNREADABLE_EXPECTED_EXIT_CODE)).toMatch(/not a readable integer/);
    expect(reservedExitCodeReason(256)).toMatch(/0\.\.255/);
    expect(reservedExitCodeReason(1.5)).toMatch(/0\.\.255/);
  });
});
