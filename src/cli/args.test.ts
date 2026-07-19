/**
 * Full CLI arg surface (PLAN §18) — every command's parsed shape plus the
 * usage-error and help edges. Pure; no engine. (The `doctor`/help legacy shapes
 * are additionally pinned in `doctor.test.ts`.)
 */
import { describe, expect, it } from 'vitest';
import { parseCliArgs } from './args.js';

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

  it('rejects an unknown role or an undeterminable harness', () => {
    expect(parseCliArgs(['switch-model', 'run_1', '--role', 'boss', '--model', 'codex:x'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['switch-model', 'run_1', '--role', 'implementor', '--model', 'opus'])).toMatchObject({ kind: 'usage_error' });
    expect(parseCliArgs(['switch-model', 'run_1', '--role', 'implementor'])).toMatchObject({ kind: 'usage_error' });
  });
});

describe('parseCliArgs — general', () => {
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
