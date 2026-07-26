/**
 * CLI-only seam tests (§3A.1 bullet 5): `--test-approve` is structurally
 * impossible over origin:'http'.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isErr, isOk } from '../../lib/result.js';
import { runId, specVersionId } from '../../domain/ids.js';
import { DeterministicIdFactory } from '../../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../../persistence/test-support.js';
import { OrchestrationService, type RoleAdapterFactory } from '../index.js';
import {
  cliApplicationPort,
  routeCliCommand,
} from '../../cli/commands.js';
import {
  grantCliOnlySeam,
  type CliCommandContext,
  type CliInvocationOptions,
  type CliOnlySeam,
} from './cli-seam.js';
import { executeApplicationCommand } from './executor.js';
import type { CommandContext } from './types.js';

/** A cli-origin context is assignable to grantCliOnlySeam's first parameter. */
export const CLI_CONTEXT_ACCEPTED: (CommandContext & {
  origin: 'cli';
}) extends Parameters<typeof grantCliOnlySeam>[0]
  ? true
  : false = true;

/** An http-origin context is NOT assignable to grantCliOnlySeam's first parameter. */
export const HTTP_CONTEXT_REJECTED: (CommandContext & {
  origin: 'http';
}) extends Parameters<typeof grantCliOnlySeam>[0]
  ? true
  : false = false;

/**
 * A plain structural object is NOT a CliOnlySeam — only grantCliOnlySeam mints
 * the opaque brand. If CliOnlySeam were a public interface, this flips to true.
 */
export const PLAIN_SEAM_OBJECT_REJECTED: {
  origin: 'cli';
  options: CliInvocationOptions;
} extends CliOnlySeam
  ? true
  : false = false;

const CLI_CTX: CliCommandContext = {
  actor: 'cli:test',
  origin: 'cli',
  idempotencyKey: 'idem_test' as CommandContext['idempotencyKey'],
};

const NO_SPAWN_FACTORY: RoleAdapterFactory = {
  create() {
    throw new Error('cli-seam tests must not spawn adapters');
  },
};

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
  vi.restoreAllMocks();
});

describe('grantCliOnlySeam (§3A.1 --test-approve isolation)', () => {
  it('type witnesses: cli accepted, http rejected at the type level', () => {
    expect(CLI_CONTEXT_ACCEPTED).toBe(true);
    expect(HTTP_CONTEXT_REJECTED).toBe(false);
    expect(PLAIN_SEAM_OBJECT_REJECTED).toBe(false);
  });

  it('grants the seam for a genuine origin:cli context', () => {
    const result = grantCliOnlySeam(CLI_CTX, { json: false, testApprove: true });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) {
      expect(result.value.origin).toBe('cli');
      expect(result.value.options).toEqual({ json: false, testApprove: true });
    }
  });

  it('refuses a forged/cast origin:http context at runtime', () => {
    const forged = { ...CLI_CTX, origin: 'http' } as unknown as CliCommandContext;
    const result = grantCliOnlySeam(forged, { json: false, testApprove: true });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error.code).toBe('cli_only_capability');
      expect(result.error.details).toMatchObject({ origin: 'http' });
    }
  });

  it('routeCliCommand strips testApprove off the ApplicationCommand approve intent', () => {
    const routing = routeCliCommand(
      {
        kind: 'approve',
        json: true,
        runId: runId('run_1'),
        specVersionId: specVersionId('spec_1'),
        testApprove: true,
      },
      {},
      {},
    );
    expect(routing.route).toBe('application');
    if (routing.route !== 'application') return;
    expect(routing.command.kind).toBe('approve');
    expect('testApprove' in routing.command).toBe(false);
    expect(routing.options.testApprove).toBe(true);
    // Seam travels outside the command and outside the context keys.
    expect(Object.keys(routing.context).sort()).toEqual(
      ['actor', 'idempotencyKey', 'origin'].sort(),
    );
    expect(Object.keys(routing.command).sort()).toEqual(
      ['kind', 'runId', 'specVersionId'].sort(),
    );
  });

  it('cliApplicationPort rejects HTTP envelope with forged testApprove seam; never calls service.approve', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const service = new OrchestrationService({
      db: handle.db,
      ids: new DeterministicIdFactory(),
      adapterFactory: NO_SPAWN_FACTORY,
    });
    const approveSpy = vi.spyOn(service, 'approve');

    // Forged seam bag carrying testApprove — not minted by grantCliOnlySeam.
    const forgedSeam = {
      origin: 'cli',
      options: { json: true, testApprove: true },
    } as unknown as CliOnlySeam;

    const port = cliApplicationPort({
      service,
      db: handle.db,
      env: { HARNESS_TEST_MODE: '1' },
      deps: {},
      seam: forgedSeam,
    });

    const result = await executeApplicationCommand(port, {
      command: {
        kind: 'approve',
        runId: runId('run_1'),
        specVersionId: specVersionId('spec_1'),
      },
      context: {
        actor: 'http:attacker',
        origin: 'http',
        idempotencyKey: 'idem_http_forged' as CommandContext['idempotencyKey'],
      },
    });

    expect(result.status).toBe('rejected');
    if (result.status === 'rejected') {
      expect(result.error.code).toBe('cli_only_capability');
      expect(result.error.details).toMatchObject({ origin: 'http' });
    }
    expect(approveSpy).not.toHaveBeenCalled();
  });
});
