/**
 * P4b-1 ALERTS (§5cc) — the durable `alert.raised` folded into its triggering
 * transition's #atomicEngineWrite, and best-effort/at-least-once delivery
 * DERIVED from the log.
 *
 * These tests FAIL without the P4b-1 wiring:
 *  - the notify effects at transitions.ts (paused_limit / interrupted /
 *    breaker_open) previously produced `notify.requested` with NO `alert.raised`
 *    and were never delivered — the live silent-drop gap;
 *  - the same-transaction property (no cause → no alert, no alert → no cause) is
 *    proven by crash-injecting the `alert.raised` append and observing the WHOLE
 *    pause transaction roll back;
 *  - delivery + at-least-once-across-restart + dedup-by-(alertId,sink) + §17.1
 *    redaction of `detail`.
 *
 * Real code paths only (`runCoordination` → `pauseForLimit` / `#interruptOnChildDeath`);
 * synthetic secrets/pids only; no real spawns.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { specVersionId, specHash as toSpecHash, type RunId } from '../domain/ids.js';
import type { DomainEvent, EventOfType } from '../domain/events.js';
import { deriveAlertRaisedEvents } from '../domain/alerts.js';
import { redactText } from '../redaction/index.js';
import {
  AdapterError,
  InProcessFakeAdapter,
  limitOnTurnN,
  type ConfigOptionDescriptor,
  type InProcessTurnScript,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../adapters/index.js';
import { DeterministicIdFactory, RandomIdFactory } from '../lib/id-factory.js';
import type { DriverKind } from '../persistence/index.js';
import {
  availableDriverKinds,
  openTestDatabase,
  type TestDatabaseHandle,
} from '../persistence/test-support.js';
import { parseEngineConfig } from '../config/loader.js';
import { OrchestrationService, type RoleAdapterFactory, type AlertOptions } from './service.js';
import type { RoleRunner } from './role-runner.js';
import type { Harness, RoleModelSpec } from './model-resolution.js';
import type { RoleName } from '../domain/state.js';

// ---------------------------------------------------------------------------
// Harness plumbing
// ---------------------------------------------------------------------------
const CLAUDE_LOW: RoleModelSpec = { harness: 'claude', model: 'opus', effort: 'low' };
const SPEC = toSpecHash('spec_alerts');
const DRIVER_KINDS = await availableDriverKinds();

function configOptions(harness: Harness): ConfigOptionDescriptor[] {
  if (harness === 'claude') {
    return [
      { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
      { id: 'thinking', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
    ];
  }
  return [
    { id: 'model', kind: 'model', values: ['gpt-5.6-terra', 'gpt-5.6-sol'], current: 'gpt-5.6-sol' },
    { id: 'model_reasoning_effort', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
  ];
}

interface FactoryOpts {
  readonly turns?: readonly InProcessTurnScript[];
  readonly onSetConfigOption?: (input: SetConfigOptionInput) => SetConfigOptionResult;
}

function makeFactory(opts: FactoryOpts = {}): RoleAdapterFactory {
  return {
    create(options) {
      const adapter = new InProcessFakeAdapter({
        harnessId: options.resolved.harness,
        capabilities: { configOptions: configOptions(options.resolved.harness) },
        turns: opts.turns ?? [{}],
        ...(opts.onSetConfigOption !== undefined ? { onSetConfigOption: opts.onSetConfigOption } : {}),
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

async function setup(opts?: {
  readonly factory?: FactoryOpts;
  readonly config?: Record<string, unknown>;
  readonly alerts?: AlertOptions;
  readonly clock?: ManualClock;
  readonly driver?: DriverKind;
}): Promise<{ service: OrchestrationService; db: TestDatabaseHandle['db'] }> {
  handle = await openTestDatabase({
    kind: opts?.driver ?? 'better-sqlite3',
    file: false,
    ...(opts?.clock !== undefined ? { clock: opts.clock } : {}),
  });
  const db = handle.db;
  const parsed = opts?.config !== undefined ? parseEngineConfig(opts.config) : undefined;
  if (parsed !== undefined && !parsed.ok) throw new Error(`bad test config: ${JSON.stringify(parsed.error)}`);
  const service = new OrchestrationService({
    db,
    ids: new DeterministicIdFactory(),
    adapterFactory: makeFactory(opts?.factory ?? {}),
    ...(parsed?.ok === true ? { config: parsed.value } : {}),
    ...(opts?.alerts !== undefined ? { alerts: opts.alerts } : {}),
  });
  return { service, db };
}

function roleRunnerOnce(role: RoleName): RoleRunner {
  return {
    role,
    run: async (session) => {
      await session.prompt({ prompt: 'go' });
      return {};
    },
  };
}

function eventTypes(db: TestDatabaseHandle['db'], runId: RunId): string[] {
  return db.events.listByRun(runId).map((e) => e.type);
}

function raisedAlerts(db: TestDatabaseHandle['db'], runId: RunId): EventOfType<'alert.raised'>[] {
  return db.events
    .listByRun(runId)
    .filter((e): e is EventOfType<'alert.raised'> => e.type === 'alert.raised');
}

/** Inject a "process death" into the write path: the batch carrying `type` throws. */
function crashOnAppendOf(db: TestDatabaseHandle['db'], type: string): { restore: () => void } {
  const events = db.events as { appendBatch: typeof db.events.appendBatch };
  const original = db.events.appendBatch.bind(db.events);
  events.appendBatch = (drafts: readonly DomainEvent[]) => {
    if (drafts.some((d) => d.type === type)) {
      throw new Error(`injected crash: process died appending ${type}`);
    }
    return original(drafts);
  };
  return { restore: () => void (events.appendBatch = original) };
}

function approvedImplementing(service: OrchestrationService): RunId {
  const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
  service.advanceWorkflowPhase(runId, 'created', 'specifying');
  service.advanceWorkflowPhase(runId, 'specifying', 'awaiting_approval');
  expect(
    service.approve(runId, { specVersionId: specVersionId('sv_alerts'), specHash: SPEC }).status,
  ).toBe('applied');
  service.advanceWorkflowPhase(runId, 'approved', 'implementing');
  return runId;
}

// ===========================================================================
// (1) alert.raised folded into the SAME transaction as its trigger
// ===========================================================================
describe('P4b-1: alert.raised rides its triggering transition atomically', () => {
  it('a LIMIT pause (T4) emits alert.raised{limit_paused} in the SAME atomic append as the trigger + checkpoint', async () => {
    const { service, db } = await setup({ factory: { turns: limitOnTurnN(1) } });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    await service.runCoordination(runId, roleRunnerOnce('coordinator')).catch(() => undefined);
    expect(service.status(runId).suspension).toBe('paused_limit');

    const alerts = raisedAlerts(db, runId);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.payload.kind).toBe('limit_paused');
    expect(alerts[0]!.payload.topic).toBe('paused_limit');
    expect(alerts[0]!.payload.role).toBe('coordinator');

    // Same transaction ⇒ same idempotency-key lineage AND contiguous sequences
    // with the trigger + notify + checkpoint (one appendBatch, one txn).
    const all = db.events.listByRun(runId);
    const trigger = all.find((e) => e.type === 'limit.classified.prompt_turn')!;
    const alertSeq = Number(alerts[0]!.sequence);
    const triggerSeq = Number(trigger.sequence);
    expect(alertSeq).toBeGreaterThan(triggerSeq);
    expect(alerts[0]!.payload.alertId).toContain(String(trigger.idempotencyKey));
  });

  it('a CRASH (T13) emits alert.raised{crash}; a BREAKER-OPEN (T14) emits alert.raised{breaker_open}', async () => {
    // windowMax 3 → the 4th crash within the window opens the breaker (T14).
    const crashOnPin: FactoryOpts['onSetConfigOption'] = () => {
      throw new AdapterError('unexpected_eof', 'injected: child died during pin');
    };
    const { service, db } = await setup({
      factory: { onSetConfigOption: crashOnPin },
      config: { restarts: { windowMax: 3 } },
    });
    const runId = approvedImplementing(service);

    const outcomes: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      await service.runCoordination(runId, roleRunnerOnce('coordinator')).catch(() => undefined);
      const suspension = service.status(runId).suspension;
      outcomes.push(suspension);
      if (suspension === 'interrupted') service.resume(runId);
    }
    expect(outcomes.slice(0, 3)).toEqual(['interrupted', 'interrupted', 'interrupted']);
    expect(service.status(runId).suspension).toBe('breaker_open');

    const kinds = raisedAlerts(db, runId).map((a) => a.payload.kind);
    // Three crash interrupts (T13) each raised a `crash` alert; the exhausting
    // 4th raised a `breaker_open` alert (T14) — riding restart.exhausted.
    expect(kinds.filter((k) => k === 'crash')).toHaveLength(3);
    expect(kinds.filter((k) => k === 'breaker_open')).toHaveLength(1);

    // breaker_open alert rode restart.exhausted, NOT another T13.
    expect(eventTypes(db, runId)).toContain('restart.exhausted');
    const breakerAlert = raisedAlerts(db, runId).find((a) => a.payload.kind === 'breaker_open')!;
    expect(breakerAlert.payload.topic).toBe('breaker_open');
  });

  it('NO cause → NO alert / NO alert → NO cause: crash-injecting the alert.raised append rolls the WHOLE pause transaction back', async () => {
    const { service, db } = await setup({ factory: { turns: limitOnTurnN(1) } });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });

    const crash = crashOnAppendOf(db, 'alert.raised');
    const error: unknown = await service
      .runCoordination(runId, roleRunnerOnce('coordinator'))
      .then(() => undefined)
      .catch((e: unknown) => e);
    crash.restore();
    expect(String(error)).toContain('injected crash');

    // The alert could not be written → its cause (the T4 trigger, the incident,
    // the checkpoint) did not commit either: one transaction, all-or-nothing.
    const types = eventTypes(db, runId);
    expect(types).not.toContain('alert.raised');
    expect(types).not.toContain('limit.classified.prompt_turn');
    expect(types).not.toContain('limit.incident.recorded');
    expect(service.status(runId).suspension).not.toBe('paused_limit');
  });
});

// ===========================================================================
// (2) delivery: best-effort, at-least-once, dedup by (alertId, sink)
// ===========================================================================
describe('P4b-1: delivery derived from the log (at-least-once, dedup)', () => {
  it('un-acked alerts are delivered to stderr + status_json and marked delivered', async () => {
    const stderr: string[] = [];
    const { service, db } = await setup({
      factory: { turns: limitOnTurnN(1) },
      alerts: { stderrWrite: (line) => stderr.push(line) },
    });
    const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await service.runCoordination(runId, roleRunnerOnce('coordinator')).catch(() => undefined);

    // Raised but NOT yet delivered.
    expect(stderr).toHaveLength(0);
    expect(service.alertStatus(runId)[0]!.delivered).toBe(false);

    const { delivered } = service.deliverPendingAlerts(runId);
    expect(delivered.map((d) => d.sink).sort()).toEqual(['status_json', 'stderr']);
    expect(stderr).toHaveLength(1);
    expect(stderr[0]!).toContain('[alert:limit_paused]');

    const status = service.alertStatus(runId);
    expect(status).toHaveLength(1);
    expect(status[0]!.delivered).toBe(true);
    expect([...status[0]!.sinks].sort()).toEqual(['status_json', 'stderr']);
    expect(eventTypes(db, runId).filter((t) => t === 'alert.delivered')).toHaveLength(2);
  });

  it('a simulated restart re-delivers an un-acked alert EXACTLY once more (dedup by alertId/sink)', async () => {
    // Process A raises the alert but crashes BEFORE delivering it.
    const { service: serviceA, db } = await setup({
      factory: { turns: limitOnTurnN(1) },
      alerts: { stderrWrite: () => expect.fail('process A must not deliver') },
    });
    const { runId } = serviceA.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
    await serviceA.runCoordination(runId, roleRunnerOnce('coordinator')).catch(() => undefined);
    expect(db.events.listByRun(runId).some((e) => e.type === 'alert.raised')).toBe(true);
    expect(db.events.listByRun(runId).some((e) => e.type === 'alert.delivered')).toBe(false);

    // Process B (restart, fresh service + RandomIdFactory over the SAME store)
    // re-derives the un-acked alert and delivers it — exactly once.
    const stderrB: string[] = [];
    const serviceB = new OrchestrationService({
      db,
      ids: new RandomIdFactory(),
      adapterFactory: makeFactory(),
      alerts: { stderrWrite: (line) => stderrB.push(line) },
    });
    serviceB.deliverPendingAlerts(runId);
    expect(stderrB).toHaveLength(1);

    // A second pass (or another restart) delivers nothing more.
    serviceB.deliverPendingAlerts(runId);
    expect(stderrB).toHaveLength(1);
    expect(eventTypes(db, runId).filter((t) => t === 'alert.delivered')).toHaveLength(2); // stderr + status_json, once
  });
});

// ===========================================================================
// (3) redaction of detail (§17.1)
// ===========================================================================
describe('P4b-1: alert detail is redacted (§17.1)', () => {
  it('deriveAlertRaisedEvents redacts a secret in the detail before storing', () => {
    const trigger: DomainEvent = {
      type: 'child.exited.unexpectedly',
      runId: 'run_x' as RunId,
      sequence: -1 as never,
      idempotencyKey: 'idem-x' as never,
      occurredAt: '2026-07-20T00:00:00.000Z' as never,
      payload: {},
    } as unknown as DomainEvent;
    const emitted: DomainEvent[] = [
      {
        type: 'notify.requested',
        runId: 'run_x' as RunId,
        sequence: -1 as never,
        idempotencyKey: 'idem-x#0' as never,
        occurredAt: '2026-07-20T00:00:00.000Z' as never,
        payload: { topic: 'interrupted', message: 'crashed' },
      } as unknown as DomainEvent,
    ];
    const out = deriveAlertRaisedEvents({
      trigger,
      emitted,
      context: { role: 'implementor', detail: 'boom token=sk-ant-ABCDEFGHIJ0123456789 tail' },
      redact: redactText,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.payload.detail).toContain('[REDACTED');
    expect(out[0]!.payload.detail).not.toContain('ABCDEFGHIJ0123456789');
  });

  it('a real crash whose error message carries a secret stores a redacted alert detail', async () => {
    const secret = 'sk-ant-SECRETKEY0123456789';
    const crashWithSecret: FactoryOpts['onSetConfigOption'] = () => {
      throw new AdapterError('unexpected_eof', `child died: leaked ${secret} here`);
    };
    const { service, db } = await setup({ factory: { onSetConfigOption: crashWithSecret } });
    const runId = approvedImplementing(service);
    await service.runCoordination(runId, roleRunnerOnce('coordinator')).catch(() => undefined);
    expect(service.status(runId).suspension).toBe('interrupted');

    const alert = raisedAlerts(db, runId)[0]!;
    expect(alert.payload.kind).toBe('crash');
    expect(alert.payload.detail).toContain('[REDACTED');
    expect(alert.payload.detail).not.toContain('SECRETKEY0123456789');
  });
});

// ===========================================================================
// (4) both sqlite drivers
// ===========================================================================
describe('P4b-1: both sqlite drivers raise + deliver alerts', () => {
  for (const driver of DRIVER_KINDS) {
    it(`${driver}: a limit pause raises + delivers a limit_paused alert`, async () => {
      const stderr: string[] = [];
      const { service, db } = await setup({
        driver,
        factory: { turns: limitOnTurnN(1) },
        alerts: { stderrWrite: (line) => stderr.push(line) },
      });
      const { runId } = service.createRun({ goal: 'g', workspacePath: '/ws', coordinator: CLAUDE_LOW });
      await service.runCoordination(runId, roleRunnerOnce('coordinator')).catch(() => undefined);
      expect(raisedAlerts(db, runId)).toHaveLength(1);
      service.deliverPendingAlerts(runId);
      expect(stderr).toHaveLength(1);
      expect(service.alertStatus(runId)[0]!.delivered).toBe(true);
    });
  }
});
