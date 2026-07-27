import { afterEach, describe, expect, it } from 'vitest';
import {
  SEQUENCE_UNASSIGNED,
  idempotencyKey,
  type RunId,
} from '../domain/ids.js';
import type { ApplicationCommand, ApplicationResult } from '../app/commands/index.js';
import { DEFAULT_ENGINE_CONFIG } from '../config/loader.js';
import { OrchestrationService } from '../app/service.js';
import { createRunFixture } from '../app/test-support.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { startHarnessServer, type HarnessServer } from './server.js';

let handle: TestDatabaseHandle | undefined;
let server: HarnessServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

async function rig(
  execute?: NonNullable<Parameters<typeof startHarnessServer>[0]['execute']>,
): Promise<{ readonly runId: RunId; readonly base: string }> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const service = new OrchestrationService({
    db: handle.db,
    config: DEFAULT_ENGINE_CONFIG,
  });
  const created = createRunFixture(service, {
    goal: 'Ship the operator UI',
    workspacePath: '/tmp/harness-control-fixture',
    coordinator: { harness: 'codex', model: 'gpt-5.6-sol' },
  });
  server = await startHarnessServer({
    db: handle.db,
    token: 'test-token',
    csrfToken: 'test-csrf',
    ...(execute !== undefined ? { execute } : {}),
  });
  return { runId: created.runId, base: server.origin };
}

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: 'Bearer test-token', ...extra };
}

describe('Harness Control server', () => {
  it('guards the API and exposes only real run snapshots', async () => {
    const { runId, base } = await rig();
    const unauthenticated = await fetch(`${base}/api/runs`);
    expect(unauthenticated.status).toBe(401);

    const fleet = await fetch(`${base}/api/runs`, { headers: auth() });
    expect(fleet.status).toBe(200);
    const body = (await fleet.json()) as {
      runs: readonly { runId: string; goal: string; asOfSequence: number }[];
    };
    expect(body.runs).toEqual([
      expect.objectContaining({
        runId: String(runId),
        goal: 'Ship the operator UI',
        asOfSequence: 0,
      }),
    ]);
  });

  it('keeps snapshot reads side-effect-free and converts exclusive event cursors', async () => {
    const { runId, base } = await rig();
    const db = handle!.db;
    for (const [index, message] of ['first', 'second'].entries()) {
      db.events.append({
        type: 'notify.requested',
        runId,
        sequence: SEQUENCE_UNASSIGNED,
        idempotencyKey: idempotencyKey(`notice-${index}`),
        occurredAt: db.clock.nowIso(),
        payload: { topic: 'run_failed', message },
      });
    }
    const before = db.events.countByRun(runId);
    const snapshot = await fetch(`${base}/api/runs/${encodeURIComponent(String(runId))}`, {
      headers: auth(),
    });
    expect(snapshot.status).toBe(200);
    expect(db.events.countByRun(runId)).toBe(before);

    const replay = await fetch(
      `${base}/api/runs/${encodeURIComponent(String(runId))}/events?after=1`,
      { headers: auth() },
    );
    const body = (await replay.json()) as {
      nextCursor: number;
      events: readonly { sequence: number; payload: { message: string } }[];
    };
    expect(body.events).toEqual([
      expect.objectContaining({ sequence: 2, payload: expect.objectContaining({ message: 'second' }) }),
    ]);
    expect(body.nextCursor).toBe(2);
  });

  it('requires same-origin CSRF proof before invoking a write command', async () => {
    let invoked = 0;
    const accepted: ApplicationResult = {
      status: 'accepted',
      command: 'cancel',
      payload: { data: { outcome: 'cancelled' }, summary: 'cancelled' },
    };
    const { runId, base } = await rig(async () => {
      invoked += 1;
      return accepted;
    });
    const endpoint = `${base}/api/runs/${encodeURIComponent(String(runId))}/cancel`;
    const refused = await fetch(endpoint, {
      method: 'POST',
      headers: auth({ 'Content-Type': 'application/json' }),
      body: '{}',
    });
    expect(refused.status).toBe(403);
    expect(invoked).toBe(0);

    const allowed = await fetch(endpoint, {
      method: 'POST',
      headers: auth({
        'Content-Type': 'application/json',
        Origin: base,
        'X-Harness-CSRF': 'test-csrf',
        'Idempotency-Key': 'cancel-once',
      }),
      body: '{}',
    });
    expect(allowed.status).toBe(200);
    expect(invoked).toBe(1);
  });

  it('carries New Run role and isolation defaults into the shared start command', async () => {
    let observed: ApplicationCommand | undefined;
    const accepted: ApplicationResult = {
      status: 'accepted',
      command: 'start',
      payload: { data: { runId: 'run_created' }, summary: 'started' },
    };
    const { base } = await rig(async (command) => {
      observed = command;
      return accepted;
    });
    const response = await fetch(`${base}/api/runs`, {
      method: 'POST',
      headers: auth({
        'Content-Type': 'application/json',
        Origin: base,
        'X-Harness-CSRF': 'test-csrf',
      }),
      body: JSON.stringify({
        goal: 'Ship the selected defaults',
        repositories: [{ id: 'api', path: '/tmp/api' }],
        coordinator: { harness: 'claude', model: 'opus', effort: 'high' },
        implementor: { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
        verifier: { harness: 'claude', model: 'sonnet', effort: 'medium' },
        executionMode: 'in_place',
      }),
    });

    expect(response.status).toBe(200);
    expect(observed).toEqual({
      kind: 'start',
      workspace: '/tmp/api',
      goal: 'Ship the selected defaults',
      coordinator: { harness: 'claude', model: 'opus', effort: 'high' },
      implementor: { harness: 'codex', model: 'gpt-5.6-sol', effort: 'high' },
      verifier: { harness: 'claude', model: 'sonnet', effort: 'medium' },
      executionMode: 'in_place',
    });
  });
});
