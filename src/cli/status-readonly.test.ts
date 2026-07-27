import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_ENGINE_CONFIG } from '../config/loader.js';
import { OrchestrationService } from '../app/service.js';
import { createRunFixture } from '../app/test-support.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { executeCommand } from './commands.js';

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

describe('status observation boundary', () => {
  it('does not invoke alert delivery or append an event', async () => {
    handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
    const service = new OrchestrationService({
      db: handle.db,
      config: DEFAULT_ENGINE_CONFIG,
    });
    const { runId } = createRunFixture(service, {
      goal: 'Observe without writing',
      workspacePath: '/tmp/status-readonly-fixture',
      coordinator: { harness: 'codex', model: 'gpt-5.6-sol' },
    });
    const delivery = vi.spyOn(service, 'deliverPendingAlerts');
    const before = handle.db.events.countByRun(runId);

    const output = await executeCommand(
      service,
      handle.db,
      { kind: 'status', json: true, runId },
      {},
    );

    expect(output.exitCode).toBe(0);
    expect(delivery).not.toHaveBeenCalled();
    expect(handle.db.events.countByRun(runId)).toBe(before);
  });
});
