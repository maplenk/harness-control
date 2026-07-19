/**
 * PLAN.md §19 test 28: "identity-verified reaping — a recorded pgid now
 * owned by a different process is NEVER killed (simulate by recording fake
 * identity for a live unrelated process you spawned)."
 *
 * All scenarios below use REAL spawned processes and the REAL `ps`-backed
 * client (`./ps.ts`) — no fakes stand in for the OS.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { processGenerationId } from '../domain/ids.js';
import { createEnvNonceVerifier, createPsClient, type EnvNonceVerifier } from './ps.js';
import {
  InMemoryProcessRegistryStore,
  ProcessRegistry,
  type IdentityAlert,
  type ProcessIdentityRecord,
} from './registry.js';

const clock = new ManualClock('2026-07-18T09:00:00.000Z');

let spawned: ChildProcess[] = [];

function spawnDetachedNode(
  script = 'setInterval(() => {}, 1000);',
  env?: Readonly<Record<string, string>>,
): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], {
    detached: true,
    stdio: 'ignore',
    ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
  });
  spawned.push(child);
  return child;
}

async function settle(ms = 150): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once('exit', () => resolve()));
}

function isAliveReal(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  for (const child of spawned) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try {
          process.kill(child.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
  }
  spawned = [];
  await settle(30);
});

function makeRegistry(
  onAlert?: (alert: IdentityAlert) => void,
  envNonce?: EnvNonceVerifier,
): ProcessRegistry {
  return new ProcessRegistry({
    clock,
    ps: createPsClient(clock),
    ...(onAlert ? { onAlert } : {}),
    ...(envNonce ? { envNonce } : {}),
  });
}

describe('ProcessRegistry.register + verify (baseline identity capture)', () => {
  it('captures a real process identity and verify() reports a match while it stays alive', async () => {
    const registry = makeRegistry();
    const child = spawnDetachedNode();
    await settle();

    const record = registry.register({
      generationId: processGenerationId('gen_match_1'),
      pid: child.pid!,
      pgid: child.pid!,
      spawnNonce: 'nonce-1',
    });
    expect(record.pid).toBe(child.pid);
    expect(record.executablePath).toBe(process.execPath);

    const verification = registry.verify(record.generationId);
    expect(verification.verdict).toBe('match');
  });

  it('verify() reports "gone" once the process has exited, and no store mutation happens on its own', async () => {
    const registry = makeRegistry();
    const child = spawnDetachedNode('setTimeout(() => process.exit(0), 400);');
    await settle();
    const record = registry.register({
      generationId: processGenerationId('gen_gone_1'),
      pid: child.pid!,
      pgid: child.pid!,
      spawnNonce: 'nonce-2',
    });
    await waitExit(child);
    await settle();

    const verification = registry.verify(record.generationId);
    expect(verification.verdict).toBe('gone');
    // verify() never mutates the store — the record is still there for the caller to decide what to do with.
    expect(registry.store.get(record.generationId)).toBeDefined();
  });
});

describe('ProcessRegistry.signalVerified — every signal is identity-gated', () => {
  it('sends the signal and kills a genuinely matching live process', async () => {
    const registry = makeRegistry();
    const child = spawnDetachedNode();
    await settle();
    const record = registry.register({
      generationId: processGenerationId('gen_kill_1'),
      pid: child.pid!,
      pgid: child.pid!,
      spawnNonce: 'nonce-3',
    });

    const verification = registry.signalVerified(record.generationId, 'SIGKILL');
    expect(verification.verdict).toBe('match');
    await waitExit(child);
    expect(isAliveReal(child.pid!)).toBe(false);
  });

  it('withholds the signal and raises an alert when the pid now identifies a DIFFERENT process (mismatch)', async () => {
    const alerts: IdentityAlert[] = [];
    const registry = makeRegistry((alert) => alerts.push(alert));

    // A real, live, UNRELATED process — standing in for "the original
    // process this record named has exited and its pid/pgid were recycled."
    const unrelated = spawnDetachedNode();
    await settle();

    const staleRecord: ProcessIdentityRecord = {
      generationId: processGenerationId('gen_mismatch_1'),
      pid: unrelated.pid!,
      pgid: unrelated.pid!,
      // Deliberately WRONG start-time/executable — this is what a genuinely
      // stale record (from a process that has since exited and whose pid
      // got reused) would look like against the live unrelated process.
      startedAt: 'Mon Jan  1 00:00:00 2020',
      executablePath: '/definitely/not/the/real/executable',
      spawnNonce: 'stale-nonce',
      recordedAt: clock.nowIso(),
    };
    registry.store.put(staleRecord);

    const verification = registry.signalVerified(staleRecord.generationId, 'SIGKILL');
    expect(verification.verdict).toBe('mismatch');
    if (verification.verdict === 'mismatch') {
      expect(verification.reason).toMatch(/start-time|executable/);
    }

    // The critical assertion: the live unrelated process was NEVER touched.
    await settle(200);
    expect(isAliveReal(unrelated.pid!)).toBe(true);

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.attemptedAction).toBe('signal');
    expect(alerts[0]!.verification.verdict).toBe('mismatch');
  });

  it('withholds the signal (no-op, no throw) when the pid no longer resolves at all', () => {
    const alerts: IdentityAlert[] = [];
    const registry = makeRegistry((alert) => alerts.push(alert));
    const staleRecord: ProcessIdentityRecord = {
      generationId: processGenerationId('gen_gone_2'),
      pid: 999_999,
      pgid: 999_999,
      startedAt: 'Mon Jan  1 00:00:00 2020',
      executablePath: '/nope',
      spawnNonce: 'nonce-4',
      recordedAt: clock.nowIso(),
    };
    registry.store.put(staleRecord);

    const verification = registry.signalVerified(staleRecord.generationId, 'SIGKILL');
    expect(verification.verdict).toBe('gone');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.attemptedAction).toBe('signal');
  });
});

describe('ProcessRegistry.reapOrphans — PLAN §19 test 28', () => {
  it('kills only the identity-verified match; a stale record pointing at a live unrelated process is left running and reported skipped', async () => {
    const alerts: IdentityAlert[] = [];
    const registry = makeRegistry((alert) => alerts.push(alert));

    // A genuine orphan this registry actually spawned/registered.
    const orphan = spawnDetachedNode();
    await settle();
    const orphanRecord = registry.register({
      generationId: processGenerationId('gen_orphan_real'),
      pid: orphan.pid!,
      pgid: orphan.pid!,
      spawnNonce: 'real-nonce',
    });

    // A live, unrelated process a STALE record happens to point at (§14's
    // exact ambiguity scenario: a recorded pgid now owned by someone else).
    const unrelated = spawnDetachedNode();
    await settle();
    const staleRecord: ProcessIdentityRecord = {
      generationId: processGenerationId('gen_orphan_stale'),
      pid: unrelated.pid!,
      pgid: unrelated.pid!,
      startedAt: 'Mon Jan  1 00:00:00 2020',
      executablePath: '/definitely/not/the/real/executable',
      spawnNonce: 'stale-nonce',
      recordedAt: clock.nowIso(),
    };
    registry.store.put(staleRecord);

    const summary = registry.reapOrphans('SIGKILL');

    expect(summary.killedCount).toBe(1);
    expect(summary.skippedCount).toBe(1);
    const killedEntry = summary.entries.find((e) => e.generationId === orphanRecord.generationId);
    const skippedEntry = summary.entries.find((e) => e.generationId === staleRecord.generationId);
    expect(killedEntry?.action).toBe('killed');
    expect(skippedEntry?.action).toBe('skipped');
    expect(skippedEntry?.verification.verdict).toBe('mismatch');

    // The genuine orphan is dead; the record is gone from the store.
    await waitExit(orphan);
    expect(isAliveReal(orphan.pid!)).toBe(false);
    expect(registry.store.get(orphanRecord.generationId)).toBeUndefined();

    // The live unrelated process was NEVER killed, and its (now-proven-stale)
    // record is left in place rather than silently dropped.
    await settle(200);
    expect(isAliveReal(unrelated.pid!)).toBe(true);
    expect(registry.store.get(staleRecord.generationId)).toBeDefined();

    // Exactly one alert, for the mismatch only.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.attemptedAction).toBe('reap');
    expect(alerts[0]!.record.generationId).toBe(staleRecord.generationId);
  });

  it('a fully-gone record (process already exited) is skipped, never signaled, and left for the caller to interpret', async () => {
    const alerts: IdentityAlert[] = [];
    const registry = makeRegistry((alert) => alerts.push(alert));
    const child = spawnDetachedNode('setTimeout(() => process.exit(0), 400);');
    await settle();
    const record = registry.register({
      generationId: processGenerationId('gen_already_gone'),
      pid: child.pid!,
      pgid: child.pid!,
      spawnNonce: 'nonce-5',
    });
    await waitExit(child);
    await settle();

    const summary = registry.reapOrphans('SIGKILL');
    expect(summary.killedCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    expect(summary.entries[0]!.verification.verdict).toBe('gone');
    expect(alerts).toHaveLength(1);
    expect(registry.store.get(record.generationId)).toBeDefined();
  });
});

describe('ProcessRegistry.reapOrphans — W2-6 env-nonce re-verification (§14)', () => {
  const NONCE_READABLE = process.platform === 'darwin' || process.platform === 'linux';

  it.runIf(NONCE_READABLE)(
    'kills a verified orphan whose env carries the recorded HARNESS_SPAWN_ID (real reader)',
    async () => {
      const alerts: IdentityAlert[] = [];
      const registry = makeRegistry((alert) => alerts.push(alert), createEnvNonceVerifier());
      const child = spawnDetachedNode(undefined, { HARNESS_SPAWN_ID: 'real-env-nonce-1' });
      await settle();
      const record = registry.register({
        generationId: processGenerationId('gen_nonce_ok'),
        pid: child.pid!,
        pgid: child.pid!,
        spawnNonce: 'real-env-nonce-1',
      });

      const summary = registry.reapOrphans('SIGKILL');
      expect(summary.killedCount).toBe(1);
      expect(summary.entries[0]!.verification.verdict).toBe('match');
      await waitExit(child);
      expect(isAliveReal(child.pid!)).toBe(false);
      expect(registry.store.get(record.generationId)).toBeUndefined();
      expect(alerts).toHaveLength(0);
    },
  );

  it.runIf(NONCE_READABLE)(
    'withholds when the live process carries NO readable nonce (unverifiable = ambiguity, never kill)',
    async () => {
      const alerts: IdentityAlert[] = [];
      const registry = makeRegistry((alert) => alerts.push(alert), createEnvNonceVerifier());
      // A real process WITHOUT HARNESS_SPAWN_ID in its env — ps identity
      // matches (we registered it live), but the nonce cannot be confirmed.
      const child = spawnDetachedNode();
      await settle();
      const record = registry.register({
        generationId: processGenerationId('gen_nonce_missing'),
        pid: child.pid!,
        pgid: child.pid!,
        spawnNonce: 'claimed-but-unconfirmable',
      });

      const summary = registry.reapOrphans('SIGKILL');
      expect(summary.killedCount).toBe(0);
      expect(summary.entries[0]!.action).toBe('skipped');
      expect(summary.entries[0]!.verification.verdict).toBe('nonce_unverifiable');

      // The process was NEVER signaled; the record is retained; one alert raised.
      await settle(150);
      expect(isAliveReal(child.pid!)).toBe(true);
      expect(registry.store.get(record.generationId)).toBeDefined();
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.attemptedAction).toBe('reap');
    },
  );

  it('withholds on a contradicting nonce even when the ps identity fully matches (fake verifier, platform-independent)', async () => {
    const alerts: IdentityAlert[] = [];
    const registry = makeRegistry((alert) => alerts.push(alert), {
      verifyNonce: () => 'mismatch',
    });
    const child = spawnDetachedNode();
    await settle();
    const record = registry.register({
      generationId: processGenerationId('gen_nonce_contradicts'),
      pid: child.pid!,
      pgid: child.pid!,
      spawnNonce: 'recorded-nonce',
    });

    const summary = registry.reapOrphans('SIGKILL');
    expect(summary.killedCount).toBe(0);
    expect(summary.entries[0]!.verification.verdict).toBe('nonce_mismatch');
    await settle(150);
    expect(isAliveReal(child.pid!)).toBe(true);
    expect(registry.store.get(record.generationId)).toBeDefined();
    expect(alerts).toHaveLength(1);
  });
});

describe('InMemoryProcessRegistryStore', () => {
  it('put/get/remove/list round-trip', () => {
    const store = new InMemoryProcessRegistryStore();
    const record: ProcessIdentityRecord = {
      generationId: processGenerationId('gen_store_1'),
      pid: 1,
      pgid: 1,
      startedAt: 's',
      executablePath: '/bin/true',
      spawnNonce: 'n',
      recordedAt: clock.nowIso(),
    };
    expect(store.list()).toEqual([]);
    store.put(record);
    expect(store.get(record.generationId)).toEqual(record);
    expect(store.list()).toEqual([record]);
    store.remove(record.generationId);
    expect(store.get(record.generationId)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});
