/**
 * Shared executor envelope validation and port delegation (§3A.1 bullets 2–3).
 */
import { describe, expect, it } from 'vitest';
import { idempotencyKey, runId } from '../../domain/ids.js';
import {
  executeApplicationCommand,
  type ApplicationCommandPort,
} from './executor.js';
import type { ApplicationCommand, ApplicationResult, CommandContext } from './types.js';

const VALID_CONTEXT: CommandContext = {
  actor: 'cli:tester',
  origin: 'cli',
  idempotencyKey: idempotencyKey('idem_000001'),
};

const PAUSE_COMMAND: ApplicationCommand = {
  kind: 'pause',
  runId: runId('run_000001'),
};

function keysOf(value: unknown): string[] {
  return value !== null && typeof value === 'object' ? Object.keys(value) : [];
}

describe('executeApplicationCommand', () => {
  it('refuses an empty actor with invalid_context', async () => {
    const port: ApplicationCommandPort = {
      execute: async () => {
        throw new Error('port must not be called');
      },
    };
    const result = await executeApplicationCommand(port, {
      command: PAUSE_COMMAND,
      context: { ...VALID_CONTEXT, actor: '' },
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.error.code).toBe('invalid_context');
    expect(keysOf(result)).not.toContain('exitCode');
    expect(keysOf(result)).not.toContain('text');
  });

  it('refuses an empty idempotencyKey with invalid_context', async () => {
    const port: ApplicationCommandPort = {
      execute: async () => {
        throw new Error('port must not be called');
      },
    };
    const result = await executeApplicationCommand(port, {
      command: PAUSE_COMMAND,
      context: {
        ...VALID_CONTEXT,
        idempotencyKey: idempotencyKey(''),
      },
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.error.code).toBe('invalid_context');
  });

  it('refuses a bogus kind (cast) with invalid_command', async () => {
    const port: ApplicationCommandPort = {
      execute: async () => {
        throw new Error('port must not be called');
      },
    };
    const result = await executeApplicationCommand(port, {
      command: { kind: 'not_a_real_kind' } as unknown as ApplicationCommand,
      context: VALID_CONTEXT,
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.error.code).toBe('invalid_command');
  });

  it('refuses a missing runId with invalid_command', async () => {
    const port: ApplicationCommandPort = {
      execute: async () => {
        throw new Error('port must not be called');
      },
    };
    const result = await executeApplicationCommand(port, {
      command: { kind: 'pause', runId: runId('') } as ApplicationCommand,
      context: VALID_CONTEXT,
    });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.error.code).toBe('invalid_command');
  });

  it('delegates a valid envelope to the port and returns its result verbatim', async () => {
    const canned: ApplicationResult = {
      status: 'accepted',
      command: 'pause',
      payload: {
        data: { outcome: 'applied' },
        summary: 'paused',
      },
    };
    let sawCommand: ApplicationCommand | undefined;
    let sawContext: CommandContext | undefined;
    const port: ApplicationCommandPort = {
      execute: async (command, context) => {
        sawCommand = command;
        sawContext = context;
        return canned;
      },
    };
    const result = await executeApplicationCommand(port, {
      command: PAUSE_COMMAND,
      context: VALID_CONTEXT,
    });
    expect(result).toBe(canned);
    expect(sawCommand).toEqual(PAUSE_COMMAND);
    expect(sawContext).toBe(VALID_CONTEXT);
    expect(keysOf(result)).not.toContain('exitCode');
    expect(keysOf(result)).not.toContain('text');
  });

  it('maps a throwing port to failed/unhandled_error without presentation keys', async () => {
    const port: ApplicationCommandPort = {
      execute: async () => {
        throw new Error('boom from port');
      },
    };
    const result = await executeApplicationCommand(port, {
      command: PAUSE_COMMAND,
      context: VALID_CONTEXT,
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error.code).toBe('unhandled_error');
    expect(result.error.message).toContain('boom from port');
    expect(keysOf(result)).not.toContain('exitCode');
    expect(keysOf(result)).not.toContain('text');
    expect(keysOf(result.error)).not.toContain('exitCode');
    expect(keysOf(result.error)).not.toContain('text');
  });
});
