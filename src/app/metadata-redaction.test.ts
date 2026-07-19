/**
 * W3-3 metadata-sink redaction — the service-readback half (§17.1).
 *
 * The persistence boundary itself is pinned in
 * src/persistence/metadata-redaction.test.ts; THIS suite proves the review's
 * probe end-to-end through the service: a SYNTHETIC `API_KEY=...` planted in
 * `start --goal` and `spec revise --feedback` is redacted in the raw DB rows
 * AND on every readback surface (`status`, `getSpecDraft`, `getRoleRound`,
 * `getImplementVerifyLoopState`, `listByRun`), while hashes/ids stay
 * byte-identical and §12.3 replay/recover reproduces the live state. Also
 * pins the registry↔projection-name linkage the persistence layer cannot
 * import (its map holds literal strings; the constants live here in app).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { assignmentId, specHash, specVersionId } from '../domain/ids.js';
import { InProcessFakeAdapter, type ConfigOptionDescriptor } from '../adapters/index.js';
import { DeterministicIdFactory } from '../lib/id-factory.js';
import { openTestDatabase, type TestDatabaseHandle } from '../persistence/test-support.js';
import { PROJECTION_FREE_TEXT_FIELDS } from '../persistence/index.js';
import { OrchestrationService, type RoleAdapterFactory } from './service.js';
import {
  ENGINE_STATE_PROJECTION,
  IMPLEMENT_VERIFY_LOOP_PROJECTION,
  ROLE_ROUND_PROJECTION,
  RUN_META_PROJECTION,
  SPEC_DRAFT_PROJECTION,
} from './projections.js';
import type { RoleRunner } from './role-runner.js';

/** SYNTHETIC planted secret (the review's probe shape). Never a real credential. */
const SECRET_VALUE = 'w33-svc-synthetic-secret-0002';
const PLANTED = `API_KEY=${SECRET_VALUE}`;

const CLAUDE_LOW = { harness: 'claude', model: 'opus', effort: 'low' } as const;

function fakeConfigOptions(): ConfigOptionDescriptor[] {
  return [
    { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
    { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

function makeFakeFactory(): RoleAdapterFactory {
  return {
    create() {
      const adapter = new InProcessFakeAdapter({
        harnessId: 'claude',
        capabilities: { configOptions: fakeConfigOptions() },
      });
      return { adapter, dispose: (): Promise<void> => adapter.close() };
    },
  };
}

let handle: TestDatabaseHandle | undefined;

afterEach(() => {
  handle?.close();
  handle?.cleanup();
  handle = undefined;
});

async function setup(): Promise<{ service: OrchestrationService; db: TestDatabaseHandle['db'] }> {
  handle = await openTestDatabase({ kind: 'better-sqlite3', file: false });
  const service = new OrchestrationService({
    db: handle.db,
    ids: new DeterministicIdFactory(),
    adapterFactory: makeFakeFactory(),
  });
  return { service, db: handle.db };
}

function rawProjectionState(db: TestDatabaseHandle['db'], run: string, name: string): string {
  const row = db.driver
    .prepare('SELECT state_json FROM run_projections WHERE run_id = ? AND projection_name = ?')
    .get<{ state_json: string }>([run, name]);
  expect(row).toBeDefined();
  return row!.state_json;
}

describe('W3-3 metadata-sink redaction — service readbacks', () => {
  it('the registered projection names are exactly the app-owned constants (literal-string linkage)', () => {
    expect(Object.keys(PROJECTION_FREE_TEXT_FIELDS).sort()).toEqual(
      [
        IMPLEMENT_VERIFY_LOOP_PROJECTION,
        ROLE_ROUND_PROJECTION,
        RUN_META_PROJECTION,
        SPEC_DRAFT_PROJECTION,
      ].sort(),
    );
    // The engine projection is deliberately NOT registered (no user free text).
    expect(PROJECTION_FREE_TEXT_FIELDS[ENGINE_STATE_PROJECTION]).toBeUndefined();
  });

  it('start --goal with a planted secret: raw run_meta row + status() readback are redacted (the review probe)', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({
      goal: `Ship the toggle before Friday. ${PLANTED}`,
      workspacePath: '/ws/repo',
      coordinator: CLAUDE_LOW,
    });

    const raw = rawProjectionState(db, String(runId), RUN_META_PROJECTION);
    expect(raw).not.toContain(SECRET_VALUE);
    expect(raw).toContain('[REDACTED:');

    const status = service.status(runId);
    expect(status.goal).toBeDefined();
    expect(status.goal).not.toContain(SECRET_VALUE);
    expect(status.goal).toContain('Ship the toggle before Friday.'); // prose survives
    expect(status.workspacePath).toBe('/ws/repo'); // unregistered field byte-identical
  });

  it('the coordinator round inputs carry the REDACTED goal: getRoleRound + raw role_round row', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({
      goal: `Ship it. ${PLANTED}`,
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    const runner: RoleRunner = {
      role: 'coordinator',
      run: async (session) => {
        await session.prompt({ prompt: 'Draft the spec.' });
        return {};
      },
    };
    await service.runCoordination(runId, runner);

    const raw = rawProjectionState(db, String(runId), ROLE_ROUND_PROJECTION);
    expect(raw).not.toContain(SECRET_VALUE);

    const round = service.getRoleRound(runId);
    expect(round).toBeDefined();
    expect(round!.stage).toBe('completed');
    expect(round!.inputs).toBeDefined();
    // The serialized inputs stay parseable (resume re-entry parses them) and
    // the goal inside is the redacted one.
    const inputs = JSON.parse(round!.inputs!) as { goal?: string };
    expect(inputs.goal).toBeDefined();
    expect(inputs.goal).not.toContain(SECRET_VALUE);
    expect(inputs.goal).toContain('[REDACTED:');
  });

  it('spec revise --feedback with a planted secret: raw event row + listByRun redacted; recover replays the live state', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    service.advanceWorkflowPhase(runId, 'created', 'specifying');
    service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');

    const result = service.reviseSpec(runId, `Scope this down. ${PLANTED}`);
    expect(result.status).toBe('applied');

    // Raw DB row: no secret survives.
    const row = db.driver
      .prepare('SELECT payload_json FROM events WHERE run_id = ? AND type = ?')
      .get<{ payload_json: string }>([String(runId), 'spec.revise.requested']);
    expect(row).toBeDefined();
    expect(row!.payload_json).not.toContain(SECRET_VALUE);
    expect(row!.payload_json).toContain('[REDACTED:');

    // Readback surface: the replayable log carries the redacted feedback.
    const revise = db.events.listByRun(runId).find((e) => e.type === 'spec.revise.requested');
    expect(revise).toBeDefined();
    const feedback = (revise!.payload as { feedback: string }).feedback;
    expect(feedback).not.toContain(SECRET_VALUE);
    expect(feedback).toContain('Scope this down.');

    // §12.3 replay parity: wipe the engine projection and recover — the
    // redacted log rebuilds the exact live state (T2 folded to specifying).
    const before = service.status(runId);
    expect(before.phase).toBe('specifying');
    db.driver
      .prepare('DELETE FROM run_projections WHERE run_id = ? AND projection_name = ?')
      .run([String(runId), ENGINE_STATE_PROJECTION]);
    const recovered = service.recover(runId);
    expect(recovered.phase).toBe('specifying');
    expect(recovered.suspension.kind).toBe(before.suspension);
    expect(service.status(runId).phase).toBe(before.phase);
  });

  it('getSpecDraft: canonicalSpec + goal redacted; specHash/specVersionId/criteria byte-identical', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const hash = specHash('0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0');
    const versionId = specVersionId('spec_w33_1');
    service.saveSpecDraft(runId, {
      specVersionId: versionId,
      specHash: hash,
      canonicalSpec: `{\n  "goal": "Ship it. ${PLANTED}",\n  "criteria": []\n}`,
      goal: `Ship it. ${PLANTED}`,
      criteria: [],
      proposedImplementorProfile: 'codex:gpt-5.6-terra',
      proposedVerifierProfile: 'claude:opus',
      revision: 1,
    });

    const raw = rawProjectionState(db, String(runId), SPEC_DRAFT_PROJECTION);
    expect(raw).not.toContain(SECRET_VALUE);

    const draft = service.getSpecDraft(runId);
    expect(draft).toBeDefined();
    expect(draft!.goal).not.toContain(SECRET_VALUE);
    expect(draft!.canonicalSpec).not.toContain(SECRET_VALUE);
    expect(draft!.canonicalSpec).toContain('[REDACTED:');
    // Hash/id bindings byte-identical (approval still binds THIS hash).
    expect(String(draft!.specHash)).toBe(String(hash));
    expect(String(draft!.specVersionId)).toBe(String(versionId));
    expect(draft!.revision).toBe(1);
    expect(draft!.proposedImplementorProfile).toBe('codex:gpt-5.6-terra');
  });

  it('implement→verify loop taskScope redacted; assignment/spec bindings byte-identical', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    service.saveImplementVerifyLoopState(runId, {
      assignmentId: assignmentId('asg_w33_1'),
      implementor: { harness: 'codex', model: 'gpt-5.6-terra' },
      verifier: CLAUDE_LOW,
      specHash: specHash('hash_loop_w33'),
      taskScope: `Implement the toggle. Do not log ${PLANTED}.`,
      destinationLabel: 'main',
      destinationRef: 'refs/heads/main',
    });

    const raw = rawProjectionState(db, String(runId), IMPLEMENT_VERIFY_LOOP_PROJECTION);
    expect(raw).not.toContain(SECRET_VALUE);

    const loop = service.getImplementVerifyLoopState(runId);
    expect(loop).toBeDefined();
    expect(loop!.taskScope).not.toContain(SECRET_VALUE);
    expect(loop!.taskScope).toContain('Implement the toggle.');
    expect(String(loop!.assignmentId)).toBe('asg_w33_1');
    expect(String(loop!.specHash)).toBe('hash_loop_w33');
  });

  it('approval hash binding is untouched by redaction: approvedSpecHash byte-identical end to end', async () => {
    const { service, db } = await setup();
    const { runId } = service.createRun({
      goal: `g ${PLANTED}`,
      workspacePath: '/ws',
      coordinator: CLAUDE_LOW,
    });
    service.advanceWorkflowPhase(runId, 'created', 'specifying');
    service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');

    const hash = specHash('c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00');
    const approved = service.approve(runId, { specVersionId: specVersionId('spec_1'), specHash: hash });
    expect(approved.status).toBe('applied');
    expect(String(service.status(runId).approvedSpecHash)).toBe(String(hash));

    // The raw spec.approved row is EXACTLY the stringified payload.
    const row = db.driver
      .prepare('SELECT payload_json FROM events WHERE run_id = ? AND type = ?')
      .get<{ payload_json: string }>([String(runId), 'spec.approved']);
    expect(row!.payload_json).toBe(
      JSON.stringify({ specVersionId: 'spec_1', specHash: String(hash), approvedBy: 'human' }),
    );
  });
});
