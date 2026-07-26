/**
 * CLI adapter tests (§3A.1 bullet 4): routing, lossless round-trip, status
 * mapping, delegation through deps.applicationPort, and live-engine parity.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { DeterministicIdFactory } from '../../lib/id-factory.js';
import {
  acpSessionId,
  processGenerationId,
  runId as toRunId,
  specHash,
  specVersionId,
} from '../../domain/ids.js';
import { openTestDatabase, type TestDatabaseHandle } from '../../persistence/test-support.js';
import { OrchestrationService, type RoleAdapterFactory } from '../index.js';
import { createRunFixture } from '../test-support.js';
import {
  applicationResultFromCommandOutput,
  cliApplicationPort,
  executeCommand,
  renderApplicationResult,
  routeCliCommand,
  toRunCommand,
  type CommandOutput,
} from '../../cli/commands.js';
import type { RunCommand } from '../../cli/args.js';
import type { ApplicationCommand, ApplicationResult, CommandContext } from './types.js';
import type { ApplicationCommandPort } from './executor.js';

const NO_SPAWN_FACTORY: RoleAdapterFactory = {
  create() {
    throw new Error('cli-adapter tests must not spawn adapters');
  },
};

const CLAUDE_LOW = { harness: 'claude' as const, model: 'opus', effort: 'low' as const };

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

async function setup(): Promise<{
  service: OrchestrationService;
  db: TestDatabaseHandle['db'];
}> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: NO_SPAWN_FACTORY,
  });
  return { service, db: handle.db };
}

// ---------------------------------------------------------------------------
// Routing table
// ---------------------------------------------------------------------------
describe('routeCliCommand', () => {
  it('routes status and set_budget as cli_local', () => {
    const status = routeCliCommand(
      { kind: 'status', json: true, runId: toRunId('r1') },
      {},
      {},
    );
    expect(status.route).toBe('cli_local');
    if (status.route === 'cli_local') expect(status.command.kind).toBe('status');

    const budget = routeCliCommand(
      {
        kind: 'set_budget',
        json: false,
        runId: toRunId('r1'),
        role: 'implementor',
        budgetMb: 512,
      },
      {},
      {},
    );
    expect(budget.route).toBe('cli_local');
    if (budget.route === 'cli_local') expect(budget.command.kind).toBe('set_budget');
  });

  it('routes the other 10 RunCommand kinds to application intents', () => {
    const cases: Array<{ cmd: RunCommand; appKind: ApplicationCommand['kind'] }> = [
      {
        cmd: {
          kind: 'start',
          json: false,
          workspace: '/ws',
          goal: 'g',
          coordinator: CLAUDE_LOW,
        },
        appKind: 'start',
      },
      {
        cmd: {
          kind: 'spec_revise',
          json: false,
          runId: toRunId('r1'),
          feedback: 'f',
        },
        appKind: 'reviseSpec',
      },
      {
        cmd: {
          kind: 'approve',
          json: true,
          runId: toRunId('r1'),
          specVersionId: specVersionId('s1'),
          testApprove: false,
        },
        appKind: 'approve',
      },
      { cmd: { kind: 'run', json: true, runId: toRunId('r1') }, appKind: 'run' },
      { cmd: { kind: 'recheck', json: true, runId: toRunId('r1') }, appKind: 'recheck' },
      { cmd: { kind: 'resume', json: true, runId: toRunId('r1') }, appKind: 'resume' },
      { cmd: { kind: 'pause', json: true, runId: toRunId('r1') }, appKind: 'pause' },
      { cmd: { kind: 'cancel', json: true, runId: toRunId('r1') }, appKind: 'cancel' },
      {
        cmd: { kind: 'breaker_reset', json: true, runId: toRunId('r1') },
        appKind: 'breakerReset',
      },
      {
        cmd: {
          kind: 'switch_model',
          json: true,
          runId: toRunId('r1'),
          role: 'implementor',
          target: CLAUDE_LOW,
        },
        appKind: 'switchModel',
      },
    ];
    for (const { cmd, appKind } of cases) {
      const routing = routeCliCommand(cmd, {}, {});
      expect(routing.route, cmd.kind).toBe('application');
      if (routing.route !== 'application') continue;
      expect(routing.command.kind, cmd.kind).toBe(appKind);
      expect(routing.context.origin).toBe('cli');
      expect(routing.context.actor.length).toBeGreaterThan(0);
      expect(String(routing.context.idempotencyKey).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Lossless RunCommand ↔ ApplicationCommand round-trip
// ---------------------------------------------------------------------------
describe('toRunCommand / routeCliCommand round-trip', () => {
  const table: RunCommand[] = [
    // start — optionals absent
    {
      kind: 'start',
      json: false,
      workspace: '/ws',
      goal: 'g',
      coordinator: CLAUDE_LOW,
    },
    // start — optionals present
    {
      kind: 'start',
      json: true,
      workspace: '/ws',
      goal: 'g',
      coordinator: CLAUDE_LOW,
      configPath: '/cfg.json',
      enableChat: true,
      noWait: true,
    },
    // spec_revise absent / present noWait
    { kind: 'spec_revise', json: false, runId: toRunId('r1'), feedback: 'please revise' },
    {
      kind: 'spec_revise',
      json: true,
      runId: toRunId('r1'),
      feedback: 'please revise',
      noWait: true,
    },
    // approve without / with testApprove + specHash
    {
      kind: 'approve',
      json: false,
      runId: toRunId('r1'),
      specVersionId: specVersionId('s1'),
      testApprove: false,
    },
    {
      kind: 'approve',
      json: true,
      runId: toRunId('r1'),
      specVersionId: specVersionId('s1'),
      specHash: specHash('a'.repeat(64)),
      testApprove: true,
    },
    // run variants
    { kind: 'run', json: false, runId: toRunId('r1') },
    {
      kind: 'run',
      json: true,
      runId: toRunId('r1'),
      implementor: CLAUDE_LOW,
      verifier: { harness: 'codex', model: 'gpt', effort: 'medium' },
      inPlace: true,
      noWait: true,
    },
    { kind: 'recheck', json: true, runId: toRunId('r1') },
    { kind: 'resume', json: false, runId: toRunId('r1') },
    { kind: 'resume', json: true, runId: toRunId('r1'), wait: true },
    { kind: 'pause', json: true, runId: toRunId('r1') },
    { kind: 'cancel', json: false, runId: toRunId('r1') },
    { kind: 'breaker_reset', json: true, runId: toRunId('r1') },
    {
      kind: 'switch_model',
      json: true,
      runId: toRunId('r1'),
      role: 'verifier',
      target: CLAUDE_LOW,
    },
  ];

  it('round-trips every routed kind with optionals present and absent', () => {
    for (const cmd of table) {
      const routing = routeCliCommand(cmd, { USER: 'u' }, { ids: new DeterministicIdFactory() });
      expect(routing.route, cmd.kind).toBe('application');
      if (routing.route !== 'application') continue;
      const back = toRunCommand(routing.command, routing.options);
      expect(back, `round-trip ${cmd.kind}`).toStrictEqual(cmd);
    }
  });
});

// ---------------------------------------------------------------------------
// Status mapping + exit-code round-trip
// ---------------------------------------------------------------------------
describe('applicationResultFromCommandOutput / renderApplicationResult', () => {
  const cases: Array<{ label: string; output: CommandOutput; status: ApplicationResult['status'] }> =
    [
      {
        label: 'ok-0',
        output: {
          json: { command: 'cancel', ok: true, outcome: 'applied', phase: 'cancelled' },
          text: 'cancelled',
          exitCode: 0,
        },
        status: 'accepted',
      },
      {
        label: 'rejected-1',
        output: {
          json: {
            command: 'pause',
            ok: false,
            outcome: 'rejected',
            reason: 'no_active_child',
            detail: 'x',
          },
          text: 'rejected',
          exitCode: 1,
        },
        status: 'rejected',
      },
      {
        label: 'not-found-1',
        output: {
          json: {
            command: 'status',
            ok: false,
            error: { name: 'RunNotFoundError', message: 'missing' },
          },
          text: 'error: missing',
          exitCode: 1,
        },
        status: 'not_found',
      },
      {
        label: 'failed-1',
        output: {
          json: {
            command: 'resume',
            ok: false,
            error: { name: 'WorkflowAdvanceError', message: 'bad' },
          },
          text: 'error: bad',
          exitCode: 1,
        },
        status: 'failed',
      },
      {
        label: 'invalid-2',
        output: {
          json: { command: 'approve', ok: false, refused: 'test_approve_guard' },
          text: 'refused',
          exitCode: 2,
        },
        status: 'invalid',
      },
      {
        label: 'conflict-2',
        output: {
          json: { command: 'approve', ok: false, refused: 'approved_hash_mismatch' },
          text: 'hash mismatch',
          exitCode: 2,
        },
        status: 'conflict',
      },
      {
        label: 'limit-3',
        output: {
          json: { command: 'run', ok: false, limit: true },
          text: 'paused_limit',
          exitCode: 3,
        },
        status: 'limit_paused',
      },
      {
        label: 'blocked-4',
        output: {
          json: { command: 'recheck', ok: false, integration_blocked: true },
          text: 'blocked',
          exitCode: 4,
        },
        status: 'blocked',
      },
    ];

  it('maps exit codes to ApplicationResult statuses', () => {
    for (const { label, output, status } of cases) {
      const result = applicationResultFromCommandOutput(label, output);
      expect(result.status, label).toBe(status);
      expect(result.command, label).toBe(String(output.json['command']));
    }
  });

  it('round-trips CommandOutput through result mapping and render', () => {
    for (const { label, output } of cases) {
      const round = renderApplicationResult(
        applicationResultFromCommandOutput(label, output),
      );
      expect(round, label).toStrictEqual(output);
    }
  });

  it('answers respondToPermission with unsupported_command via the CLI port', async () => {
    const { service, db } = await setup();
    const port = cliApplicationPort({
      service,
      db,
      env: {},
      deps: {},
      seam: { origin: 'cli', options: { json: true } },
    });
    const result = await port.execute(
      {
        kind: 'respondToPermission',
        runId: toRunId('r1'),
        processGenerationId: processGenerationId('pgen_1'),
        acpSessionId: acpSessionId('acp_1'),
        requestId: 'req',
        optionId: 'opt',
        decision: 'deny',
      },
      {
        actor: 'cli:t',
        origin: 'cli',
        idempotencyKey: 'idem_1' as CommandContext['idempotencyKey'],
      },
    );
    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected') return;
    expect(result.error.code).toBe('unsupported_command');
  });
});

// ---------------------------------------------------------------------------
// Delegation proof via deps.applicationPort
// ---------------------------------------------------------------------------
describe('executeCommand delegates to the shared executor', () => {
  it('injects ApplicationCommand + CommandContext{origin:cli} into applicationPort', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, {
      goal: 'g',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });

    let sawCommand: ApplicationCommand | undefined;
    let sawContext: CommandContext | undefined;
    const canned: ApplicationResult = {
      status: 'accepted',
      command: 'pause',
      payload: {
        data: { runId, outcome: 'applied', phase: 'implementing' },
        summary: 'canned pause applied',
      },
    };
    const spy: ApplicationCommandPort = {
      async execute(command, context) {
        sawCommand = command;
        sawContext = context;
        return canned;
      },
    };

    const out = await executeCommand(
      service,
      db,
      { kind: 'pause', json: true, runId },
      { USER: 'tester' },
      { applicationPort: spy },
    );

    expect(sawCommand).toEqual({ kind: 'pause', runId });
    expect(sawContext?.origin).toBe('cli');
    expect(sawContext?.actor.length).toBeGreaterThan(0);
    expect(String(sawContext?.idempotencyKey ?? '').length).toBeGreaterThan(0);
    expect(out).toStrictEqual(renderApplicationResult(canned));
    expect(out.exitCode).toBe(0);
    expect(out.text).toBe('canned pause applied');
  });
});

// ---------------------------------------------------------------------------
// Live-engine parity through the real port
// ---------------------------------------------------------------------------
describe('live-engine parity through the real CLI port', () => {
  it('cancel → exit 0 applied/cancelled', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, {
      goal: 'g',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const out = await executeCommand(
      service,
      db,
      { kind: 'cancel', json: true, runId },
      {},
      {},
    );
    expect(out.exitCode).toBe(0);
    expect(out.json).toMatchObject({
      command: 'cancel',
      ok: true,
      outcome: 'applied',
      phase: 'cancelled',
    });
  });

  it('pause → exit 1 rejected (no active child)', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, {
      goal: 'g',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const out = await executeCommand(
      service,
      db,
      { kind: 'pause', json: true, runId },
      {},
      {},
    );
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({
      command: 'pause',
      ok: false,
      outcome: 'rejected',
    });
  });

  it('breaker_reset → exit 1 rejected (breaker not open)', async () => {
    const { service, db } = await setup();
    const { runId } = createRunFixture(service, {
      goal: 'g',
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const out = await executeCommand(
      service,
      db,
      { kind: 'breaker_reset', json: true, runId },
      {},
      {},
    );
    expect(out.exitCode).toBe(1);
    expect(out.json).toMatchObject({
      command: 'breaker_reset',
      ok: false,
      outcome: 'rejected',
    });
  });
});

