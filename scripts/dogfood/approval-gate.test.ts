/**
 * The dogfood runner's APPROVAL GATE, executed.
 *
 * `scripts/dogfood/run-slice.sh` decides whether to issue `harness approve`
 * from the RUN's own state (`status --json`: phase + bound spec hash + signer),
 * because B2's `approval:'auto'` makes the human gate conditional. Before that
 * branch existed the script approved unconditionally — which is illegal from
 * `approved` (T1's precondition), so under `set -euo pipefail` the unattended
 * path aborted at its own approve step and never reached `run`.
 *
 * A branch that decides whether a human signature is required needs a test that
 * proves it FIRES, in both directions, and a shell script gets no help from the
 * type checker. So this drives the REAL script with a STUB `dist/cli/index.js`
 * that records every subcommand it was handed:
 *
 *  - "approve was skipped" is proven by its ABSENCE from the trace, not by an
 *    exit code that could be 0 for any number of reasons;
 *  - "the run never started" is proven by `run` being ABSENT from the trace of
 *    every refusal — a refusal that still spawns an implementor is not one.
 *
 * The stub is a stand-in for the CLI, not for the script under test: the script
 * itself is copied byte-for-byte from the repo and executed (L11 — a battery
 * that simulates the thing it is checking proves nothing about the thing).
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const RUN_SLICE = fileURLToPath(new URL('./run-slice.sh', import.meta.url));

const HASH_BOUND = 'sha256:1111111111111111111111111111111111111111111111111111111111111111';
const HASH_OTHER = 'sha256:2222222222222222222222222222222222222222222222222222222222222222';

/**
 * A stub `harness` CLI: it answers `status --json` with the scripted body and
 * appends every invocation's subcommand to a trace file. `approve` and `run`
 * succeed, so a refusal in the trace can only have come from the SCRIPT.
 */
const STUB_CLI = `const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.TRACE, args[0] + '\\n');
if (args[0] === 'status') { process.stdout.write(process.env.STUB_STATUS + '\\n'); process.exit(0); }
process.stdout.write('{"outcome":"applied"}\\n');
process.exit(0);
`;

interface DrillResult {
  readonly exitCode: number;
  /** Subcommands the script invoked, in order. */
  readonly trace: readonly string[];
  readonly output: string;
}

let sandbox: string | undefined;

afterEach(() => {
  if (sandbox !== undefined) fs.rmSync(sandbox, { recursive: true, force: true });
  sandbox = undefined;
});

/** Run the REAL run-slice.sh against a stub CLI answering with `status`. */
function drill(status: Record<string, unknown>, requestedHash = HASH_BOUND): DrillResult {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-gate-drill-'));
  sandbox = root;
  fs.mkdirSync(path.join(root, 'scripts', 'dogfood'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'cli'), { recursive: true });
  // The script under test, verbatim from the repo.
  fs.copyFileSync(RUN_SLICE, path.join(root, 'scripts', 'dogfood', 'run-slice.sh'));
  fs.writeFileSync(path.join(root, 'dist', 'cli', 'index.js'), STUB_CLI, 'utf8');
  const trace = path.join(root, 'trace.txt');
  fs.writeFileSync(trace, '', 'utf8');

  let exitCode = 0;
  let output = '';
  try {
    output = execFileSync(
      '/bin/bash',
      [path.join(root, 'scripts', 'dogfood', 'run-slice.sh'), 'run_drill', 'spec_drill', requestedHash],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          TRACE: trace,
          STUB_STATUS: JSON.stringify(status),
          HARNESS_HOME: path.join(root, 'home'),
        },
      },
    );
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    exitCode = e.status ?? 1;
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const lines = fs.readFileSync(trace, 'utf8').split('\n').filter(Boolean);
  return { exitCode, trace: lines, output };
}

describe('run-slice.sh approval gate', () => {
  it('awaiting_approval — issues the human approval, then runs', () => {
    const r = drill({ phase: 'awaiting_approval' });
    expect(r.exitCode).toBe(0);
    expect(r.trace).toEqual(['status', 'approve', 'run', 'status']);
  });

  it("approved by 'auto' on the SAME hash — SKIPS approve and still runs", () => {
    const r = drill({ phase: 'approved', approvedSpecHash: HASH_BOUND, specApprovedBy: 'auto' });
    expect(r.exitCode).toBe(0);
    // The whole point: no approve, and the run still happened.
    expect(r.trace).not.toContain('approve');
    expect(r.trace).toEqual(['status', 'run', 'status']);
    // The operator is TOLD nobody reviewed the intent.
    expect(r.output).toContain('AUTO-APPROVED');
    expect(r.output).toContain('NO human reviewed the intent');
  });

  it("approved by 'human' on the SAME hash — SKIPS approve and still runs (idempotent re-entry)", () => {
    const r = drill({ phase: 'approved', approvedSpecHash: HASH_BOUND, specApprovedBy: 'human' });
    expect(r.exitCode).toBe(0);
    expect(r.trace).toEqual(['status', 'run', 'status']);
    expect(r.output).not.toContain('AUTO-APPROVED');
  });

  it('approved to a DIFFERENT hash — REFUSES, and nothing runs', () => {
    const r = drill({ phase: 'approved', approvedSpecHash: HASH_OTHER, specApprovedBy: 'auto' });
    expect(r.exitCode).toBe(2);
    // The refusal fired in time: no approve, and above all no `run`.
    expect(r.trace).toEqual(['status']);
    expect(r.output).toContain('already approved, but bound to spec hash');
  });

  it('approved with NO substantiated signer — REFUSES rather than assuming a human', () => {
    // `specApprovedBy` absent is B2's UNKNOWN: the log cannot attribute the
    // signature. "I could not determine who signed" is not "a human signed".
    const r = drill({ phase: 'approved', approvedSpecHash: HASH_BOUND });
    expect(r.exitCode).toBe(2);
    expect(r.trace).toEqual(['status']);
    expect(r.output).toContain('NO approval signer');
  });

  it('any other phase — REFUSES, and nothing runs', () => {
    const r = drill({ phase: 'implementing' });
    expect(r.exitCode).toBe(2);
    expect(r.trace).toEqual(['status']);
    expect(r.output).toContain("is at phase 'implementing'");
  });

  it('the drill is not vacuous — the stub CLI is really reached', () => {
    // A sandbox misconfiguration that made the script exit before invoking
    // anything would satisfy every "not to contain" assertion above.
    const r = drill({ phase: 'awaiting_approval' });
    expect(r.trace.length).toBeGreaterThan(0);
    expect(r.trace[0]).toBe('status');
  });
});
