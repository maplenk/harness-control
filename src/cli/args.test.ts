/**
 * Full CLI arg surface (PLAN §18) — every command's parsed shape plus the
 * usage-error and help edges. Pure; no engine. (The `doctor`/help legacy shapes
 * are additionally pinned in `doctor.test.ts`.)
 */
import { describe, expect, it } from 'vitest';
import { CLI_USAGE, parseCliArgs } from './args.js';

describe('parseCliArgs — start', () => {
  it('parses the coordinator profile + flags onto a RoleModelSpec', () => {
    expect(
      parseCliArgs(['start', '--workspace', '/ws', '--goal', 'Add a flag', '--coordinator', 'claude', '--model', 'opus', '--effort', 'low']),
    ).toEqual({
      kind: 'start',
      json: false,
      workspace: '/ws',
      goal: 'Add a flag',
      coordinator: { harness: 'claude', model: 'opus', effort: 'low' },
    });
  });

  it('accepts --json and a packed coordinator token', () => {
    expect(parseCliArgs(['start', '--json', '--workspace', '/ws', '--goal', 'g', '--coordinator', 'codex:gpt-5.6-terra'])).toMatchObject({
      kind: 'start',
      json: true,
      coordinator: { harness: 'codex', model: 'gpt-5.6-terra' },
    });
  });

  it('accepts a packed Grok Build coordinator token', () => {
    expect(
      parseCliArgs([
        'start',
        '--workspace',
        '/ws',
        '--goal',
        'g',
        '--coordinator',
        'grok:grok-build:high',
      ]),
    ).toMatchObject({
      kind: 'start',
      coordinator: { harness: 'grok', model: 'grok-build', effort: 'high' },
    });
  });

  it('enables opt-in Agent Room planning chat', () => {
    expect(
      parseCliArgs([
        'start',
        '--workspace',
        '/ws',
        '--goal',
        'g',
        '--coordinator',
        'claude:opus',
        '--enable-chat',
      ]),
    ).toMatchObject({
      kind: 'start',
      enableChat: true,
    });
  });

  it('is a usage error when required flags are missing or the profile is bad', () => {
    expect(parseCliArgs(['start', '--workspace', '/ws', '--coordinator', 'claude', '--model', 'opus'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['start', '--workspace', '/ws', '--goal', 'g', '--coordinator', 'bogus'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['start', '--goal', 'g', '--coordinator', 'claude', '--model', 'opus'])).toMatchObject({ kind: 'usage_error' });
  });
});

describe('parseCliArgs — spec revise / approve / run', () => {
  it('parses `spec revise RUN_ID --feedback`', () => {
    expect(parseCliArgs(['spec', 'revise', 'run_1', '--feedback', 'tighten criteria'])).toEqual({
      kind: 'spec_revise',
      json: false,
      runId: 'run_1',
      feedback: 'tighten criteria',
    });
  });

  it('rejects a missing/unknown spec subcommand and a missing --feedback', () => {
    expect(parseCliArgs(['spec'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['spec', 'delete', 'run_1'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['spec', 'revise', 'run_1'])).toMatchObject({ kind: 'usage_error' });
  });

  it('parses `approve RUN_ID --spec-version` with optional --spec-hash and --test-approve', () => {
    expect(parseCliArgs(['approve', 'run_1', '--spec-version', 'spec_1'])).toEqual({
      kind: 'approve',
      json: false,
      runId: 'run_1',
      specVersionId: 'spec_1',
      testApprove: false,
    });
    expect(parseCliArgs(['approve', 'run_1', '--spec-version', 'spec_1', '--spec-hash', 'h1', '--test-approve'])).toEqual({
      kind: 'approve',
      json: false,
      runId: 'run_1',
      specVersionId: 'spec_1',
      specHash: 'h1',
      testApprove: true,
    });
  });

  it('requires --spec-version on approve', () => {
    expect(parseCliArgs(['approve', 'run_1'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['approve'])).toMatchObject({ kind: 'usage_error' });
  });

  it('parses `run RUN_ID` with optional implementor/verifier profiles', () => {
    expect(parseCliArgs(['run', 'run_1'])).toEqual({ kind: 'run', json: false, runId: 'run_1' });
    expect(parseCliArgs(['run', 'run_1', '--implementor', 'codex:gpt-5.6-terra', '--verifier', 'claude:opus'])).toEqual({
      kind: 'run',
      json: false,
      runId: 'run_1',
      implementor: { harness: 'codex', model: 'gpt-5.6-terra' },
      verifier: { harness: 'claude', model: 'opus' },
    });
  });

  // B3 — `--in-place`: the ONLY route to the non-default execution mode.
  it('parses `run --in-place`, and its ABSENCE is not `false` but nothing at all', () => {
    // The status quo, byte-for-byte: no flag, no field. An `inPlace: false` here
    // would be a new key on every existing parse result.
    expect(parseCliArgs(['run', 'run_1'])).toEqual({ kind: 'run', json: false, runId: 'run_1' });
    expect(parseCliArgs(['run', 'run_1', '--in-place'])).toEqual({
      kind: 'run',
      json: false,
      runId: 'run_1',
      inPlace: true,
    });
    // Composes with everything else `run` accepts, in any position.
    expect(
      parseCliArgs(['run', 'run_1', '--in-place', '--json', '--no-wait', '--implementor', 'claude:opus']),
    ).toEqual({
      kind: 'run',
      json: true,
      runId: 'run_1',
      implementor: { harness: 'claude', model: 'opus' },
      inPlace: true,
      noWait: true,
    });
  });

  it('refuses `--in-place` a VALUE, and refuses it on commands that do not have it', () => {
    // A boolean that took a value would let `--in-place=worktree` read as opting
    // OUT while switching the mode ON.
    expect(parseCliArgs(['run', 'run_1', '--in-place=true'])).toEqual({
      kind: 'usage_error',
      message: '--in-place takes no value',
    });
    // The mode is chosen when the loop is driven. Accepting it on `resume` or
    // `status` would suggest it could be changed after the workspace exists.
    expect(parseCliArgs(['resume', 'run_1', '--in-place'])).toMatchObject({
      kind: 'usage_error',
      message: 'unknown option: --in-place',
    });
    expect(parseCliArgs(['status', 'run_1', '--in-place'])).toMatchObject({
      kind: 'usage_error',
      message: 'unknown option: --in-place',
    });
    expect(parseCliArgs(['start', '--in-place'])).toMatchObject({
      kind: 'usage_error',
      message: 'unknown option: --in-place',
    });
  });

  it('parses Grok Build implementor and verifier profiles', () => {
    expect(
      parseCliArgs([
        'run',
        'run_1',
        '--implementor',
        'grok:grok-build:high',
        '--verifier',
        'grok:grok-build:low',
      ]),
    ).toMatchObject({
      kind: 'run',
      implementor: { harness: 'grok', model: 'grok-build', effort: 'high' },
      verifier: { harness: 'grok', model: 'grok-build', effort: 'low' },
    });
  });
});

describe('parseCliArgs — simple RUN_ID commands', () => {
  it('parses status/resume/pause/cancel/recheck', () => {
    expect(parseCliArgs(['status', 'run_1'])).toEqual({ kind: 'status', json: false, runId: 'run_1' });
    expect(parseCliArgs(['status', 'run_1', '--json'])).toEqual({ kind: 'status', json: true, runId: 'run_1' });
    expect(parseCliArgs(['resume', 'run_1'])).toEqual({ kind: 'resume', json: false, runId: 'run_1' });
    expect(parseCliArgs(['pause', 'run_1'])).toEqual({ kind: 'pause', json: false, runId: 'run_1' });
    expect(parseCliArgs(['cancel', 'run_1'])).toEqual({ kind: 'cancel', json: false, runId: 'run_1' });
    // W2-2: §16 readiness re-probe for an integration_blocked run.
    expect(parseCliArgs(['recheck', 'run_1'])).toEqual({ kind: 'recheck', json: false, runId: 'run_1' });
    expect(parseCliArgs(['recheck', 'run_1', '--json'])).toEqual({ kind: 'recheck', json: true, runId: 'run_1' });
    expect(parseCliArgs(['recheck'])).toMatchObject({ kind: 'usage_error' });
  });

  it('requires exactly one RUN_ID', () => {
    expect(parseCliArgs(['status'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['status', 'run_1', 'run_2'])).toMatchObject({ kind: 'usage_error' });
  });

  it('parses `breaker reset RUN_ID`', () => {
    expect(parseCliArgs(['breaker', 'reset', 'run_1'])).toEqual({ kind: 'breaker_reset', json: false, runId: 'run_1' });
    expect(parseCliArgs(['breaker'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['breaker', 'open', 'run_1'])).toMatchObject({ kind: 'usage_error' });
  });
});

describe('parseCliArgs — switch-model', () => {
  it('parses `--role --model --harness` onto a target RoleModelSpec', () => {
    expect(parseCliArgs(['switch-model', 'run_1', '--role', 'implementor', '--model', 'gpt-5.6-terra', '--harness', 'codex'])).toEqual({
      kind: 'switch_model',
      json: false,
      runId: 'run_1',
      role: 'implementor',
      target: { harness: 'codex', model: 'gpt-5.6-terra' },
    });
  });

  it('accepts a harness:model --model without --harness', () => {
    expect(parseCliArgs(['switch-model', 'run_1', '--role', 'coordinator', '--model', 'claude:opus', '--effort', 'high'])).toMatchObject({
      kind: 'switch_model',
      role: 'coordinator',
      target: { harness: 'claude', model: 'opus', effort: 'high' },
    });
  });

  it('accepts a Grok Build switch target', () => {
    expect(
      parseCliArgs([
        'switch-model',
        'run_1',
        '--role',
        'implementor',
        '--model',
        'grok:grok-build',
        '--effort',
        'high',
      ]),
    ).toMatchObject({
      kind: 'switch_model',
      target: { harness: 'grok', model: 'grok-build', effort: 'high' },
    });
  });

  it('rejects an unknown role or an undeterminable harness', () => {
    expect(parseCliArgs(['switch-model', 'run_1', '--role', 'boss', '--model', 'codex:x'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['switch-model', 'run_1', '--role', 'implementor', '--model', 'opus'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['switch-model', 'run_1', '--role', 'implementor'])).toMatchObject({ kind: 'usage_error' });
  });
});

describe('parseCliArgs — set-budget (F3 audited memory override)', () => {
  it('parses --role + --memory-budget-mb (+ optional --resume)', () => {
    expect(
      parseCliArgs(['set-budget', 'run_1', '--role', 'implementor', '--memory-budget-mb', '2048']),
    ).toEqual({ kind: 'set_budget', json: false, runId: 'run_1', role: 'implementor', budgetMb: 2048 });
    expect(
      parseCliArgs(['set-budget', 'run_1', '--role', 'verifier', '--memory-budget-mb', '4096', '--resume']),
    ).toMatchObject({ kind: 'set_budget', role: 'verifier', budgetMb: 4096, resume: true });
  });

  it('rejects an unknown role, a missing/non-positive/non-integer budget', () => {
    expect(parseCliArgs(['set-budget', 'run_1', '--role', 'boss', '--memory-budget-mb', '2048'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['set-budget', 'run_1', '--role', 'implementor'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['set-budget', 'run_1', '--role', 'implementor', '--memory-budget-mb', '0'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['set-budget', 'run_1', '--role', 'implementor', '--memory-budget-mb', '1.5'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['set-budget', 'run_1', '--role', 'implementor', '--memory-budget-mb', 'lots'])).toMatchObject({ kind: 'usage_error' });
  });
});

describe('parseCliArgs — general', () => {
  it('documents the first-party Grok Build packed profile form', () => {
    expect(CLI_USAGE).toContain('--implementor grok:grok-build:high');
  });

  it('treats --help anywhere as help and unknown commands/options as usage errors', () => {
    expect(parseCliArgs(['status', 'run_1', '--help'])).toEqual({ kind: 'help' });
    expect(parseCliArgs(['frobnicate'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['status', 'run_1', '--wat'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['start', '--goal'])).toMatchObject({ kind: 'usage_error' });
  });

  it('supports --flag=value form', () => {
    expect(parseCliArgs(['spec', 'revise', 'run_1', '--feedback=be terse'])).toMatchObject({
      kind: 'spec_revise',
      feedback: 'be terse',
    });
  });

  it('rejects --config on run-scoped commands with a says-why error (W1-F5: config binds at start)', () => {
    for (const argv of [
      ['status', 'run_1', '--config', 'x.json'],
      ['run', 'run_1', '--config', 'x.json'],
      ['approve', 'run_1', '--spec-version', 'spec_1', '--config', 'x.json'],
      ['spec', 'revise', 'run_1', '--feedback', 'f', '--config', 'x.json'],
      ['resume', 'run_1', '--config=x.json'],
      ['switch-model', 'run_1', '--role', 'implementor', '--model', 'm', '--config', 'x.json'],
      ['breaker', 'reset', 'run_1', '--config', 'x.json'],
    ]) {
      const parsed = parseCliArgs(argv);
      expect(parsed).toMatchObject({ kind: 'usage_error' });
      expect((parsed as { message: string }).message).toContain('config binds at start');
    }
  });
});
