/**
 * PLAN.md §19 test 28: "identity-verified reaping — a recorded pgid now
 * owned by a different process is NEVER killed (simulate by recording fake
 * identity for a live unrelated process you spawned)."
 *
 * Identity/reaping scenarios below use real spawned processes and the real
 * `ps` client except for the focused leader-gone/live-descendant regression,
 * whose scripted process-tree sample makes that narrow crash window exact.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { processGenerationId } from '../domain/ids.js';
import { createEnvNonceVerifier, createPsClient, type EnvNonceVerifier, type PsClient } from './ps.js';
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
  selfPid?: number,
): ProcessRegistry {
  return new ProcessRegistry({
    clock,
    ps: createPsClient(clock),
    ...(onAlert ? { onAlert } : {}),
    ...(envNonce ? { envNonce } : {}),
    ...(selfPid !== undefined ? { selfPid } : {}),
  });
}

/**
 * W4-0 (§14:139): startup reaping runs in a NEW orchestrator process — the
 * records it finds were written by the PRIOR, now-crashed orchestrator, whose
 * pid is DEAD. `register()` stamps THIS (live) process as owner, so a record
 * fed to `reapOrphans` in the same test must be re-stamped with a dead owner
 * to model the real orphan scenario; a self-owned LIVE record is deliberately
 * never reaped (that is the peer-kill safety gate — covered by its own test).
 */
const CRASHED_OWNER_PID = 999_999; // never alive at reap time
function asOrphanOfCrashedOwner(registry: ProcessRegistry, record: ProcessIdentityRecord): void {
  registry.store.put({ ...record, ownerPid: CRASHED_OWNER_PID });
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

  it('runs the pre-signal persistence hook after identity match and withholds the signal when it throws', async () => {
    const registry = makeRegistry();
    const child = spawnDetachedNode();
    await settle();
    const record = registry.register({
      generationId: processGenerationId('gen_persist_before_kill'),
      pid: child.pid!,
      pgid: child.pid!,
      spawnNonce: 'nonce-persist',
    });
    let hookCalls = 0;
    expect(() =>
      registry.signalVerified(record.generationId, 'SIGKILL', {
        beforeSignal: () => {
          hookCalls += 1;
          throw new Error('persistence failed');
        },
      }),
    ).toThrow('persistence failed');
    expect(hookCalls).toBe(1);
    await settle(100);
    expect(isAliveReal(child.pid!)).toBe(true);
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
    asOrphanOfCrashedOwner(registry, orphanRecord); // owner (prior orchestrator) is dead

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

    expect(summary.signalSentCount).toBe(1);
    expect(summary.confirmedGoneCount).toBe(0);
    expect(summary.skippedCount).toBe(1);
    const signaledEntry = summary.entries.find((e) => e.generationId === orphanRecord.generationId);
    const skippedEntry = summary.entries.find((e) => e.generationId === staleRecord.generationId);
    expect(signaledEntry?.action).toBe('signal_sent');
    expect(skippedEntry?.action).toBe('skipped');
    expect(skippedEntry?.verification.verdict).toBe('mismatch');

    // Signal acceptance retains ownership. Only a later whole-tree absence
    // confirms exit; service-level durable acknowledgement removes the record.
    expect(registry.store.get(orphanRecord.generationId)).toBeDefined();
    await waitExit(orphan);
    expect(isAliveReal(orphan.pid!)).toBe(false);
    const confirmed = registry.reapOrphans('SIGKILL');
    expect(confirmed.confirmedGoneCount).toBe(1);
    expect(confirmed.entries[0]?.action).toBe('confirmed_gone');
    // R1: confirmed absence is only a report. The durable owner survives until
    // the service commits its recovery outcome and explicitly acknowledges it.
    expect(registry.store.get(orphanRecord.generationId)).toBeDefined();
    registry.store.remove(orphanRecord.generationId);
    expect(registry.store.get(orphanRecord.generationId)).toBeUndefined();

    // The live unrelated process was NEVER killed, and its (now-proven-stale)
    // record is left in place rather than silently dropped.
    await settle(200);
    expect(isAliveReal(unrelated.pid!)).toBe(true);
    expect(registry.store.get(staleRecord.generationId)).toBeDefined();

    // The stale record is re-checked on both passes and alerts both times;
    // the confirmed-gone record never alerts.
    expect(alerts).toHaveLength(2);
    for (const alert of alerts) {
      expect(alert.attemptedAction).toBe('reap');
      expect(alert.record.generationId).toBe(staleRecord.generationId);
    }
  });

  it('does not confirm exit when the leader is gone but descendants remain in the recorded process group', () => {
    const pgid = 41_700;
    const descendantPid = 41_701;
    let treeAlive = true;
    const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    const ps: PsClient = {
      // The registered group leader is already gone.
      sampleIdentity: () => undefined,
      // A descendant remains in the original group until the test removes it.
      sampleProcessTree: (sampledPgid) =>
        treeAlive
          ? {
              pgid: sampledPgid,
              rssBytes: 64_000,
              processCount: 1,
              pids: [descendantPid],
              sampledAt: clock.nowIso(),
            }
          : undefined,
      isAlive: () => false,
    };
    const registry = new ProcessRegistry({
      clock,
      ps,
      selfPid: 41_799,
      sendSignal: (signaledPgid, signal) => signals.push({ pgid: signaledPgid, signal }),
    });
    const record: ProcessIdentityRecord = {
      generationId: processGenerationId('gen_leader_gone_descendant_live'),
      pid: pgid,
      pgid,
      startedAt: 'leader-start',
      executablePath: '/fake/leader',
      spawnNonce: 'leader-nonce',
      recordedAt: clock.nowIso(),
      ownerPid: CRASHED_OWNER_PID,
    };
    registry.store.put(record);

    const pending = registry.reapOrphans('SIGKILL');

    expect(pending.signalSentCount).toBe(0);
    expect(pending.exitPendingCount).toBe(1);
    expect(pending.confirmedGoneCount).toBe(0);
    expect(pending.entries[0]).toMatchObject({
      generationId: record.generationId,
      action: 'exit_pending',
      verification: { verdict: 'gone' },
    });
    expect(signals).toEqual([]);
    expect(registry.store.get(record.generationId)).toBeDefined();

    treeAlive = false;
    const absent = registry.reapOrphans('SIGKILL');
    expect(absent.signalSentCount).toBe(0);
    expect(absent.confirmedGoneCount).toBe(1);
    expect(absent.entries[0]?.action).toBe('confirmed_gone');
    // R1: even confirmed absence remains retryable until the durable outcome
    // has committed and the service explicitly removes this owner record.
    expect(registry.store.get(record.generationId)).toBeDefined();
    expect(registry.reapOrphans('SIGKILL').confirmedGoneCount).toBe(1);
  });

  it('reconciles a startup identity mismatch when the recorded PGID is independently absent', () => {
    const pgid = 41_800;
    const alerts: IdentityAlert[] = [];
    const signals: Array<{ pgid: number; signal: NodeJS.Signals }> = [];
    const ps: PsClient = {
      // The pid was recycled: identity verification must still forbid a
      // signal, but the old recorded process group no longer has any member.
      sampleIdentity: (pid) => ({
        pid,
        ppid: 1,
        pgid: pid,
        startedAt: 'recycled-start',
        executablePath: '/unrelated/process',
      }),
      sampleProcessTree: () => undefined,
      isAlive: () => false,
    };
    const registry = new ProcessRegistry({
      clock,
      ps,
      selfPid: 41_899,
      sendSignal: (signaledPgid, signal) => signals.push({ pgid: signaledPgid, signal }),
      onAlert: (alert) => alerts.push(alert),
    });
    const record: ProcessIdentityRecord = {
      generationId: processGenerationId('gen_mismatch_tree_absent'),
      pid: pgid,
      pgid,
      startedAt: 'original-start',
      executablePath: '/original/process',
      spawnNonce: 'original-nonce',
      recordedAt: clock.nowIso(),
      ownerPid: CRASHED_OWNER_PID,
    };
    registry.store.put(record);

    const summary = registry.reapOrphans('SIGKILL');

    expect(summary.signalSentCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
    expect(summary.confirmedGoneCount).toBe(1);
    expect(summary.entries[0]).toMatchObject({
      generationId: record.generationId,
      action: 'confirmed_gone',
      verification: { verdict: 'mismatch' },
    });
    expect(signals).toEqual([]);
    expect(alerts).toHaveLength(1);
    // Durable ownership is still retained until the service commits and
    // explicitly acknowledges the recovered terminal outcome.
    expect(registry.store.get(record.generationId)).toBeDefined();
  });

  it('a fully-gone record is confirmed without signaling and retained until durable acknowledgement', async () => {
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
    asOrphanOfCrashedOwner(registry, record); // owner (prior orchestrator) is dead
    await waitExit(child);
    await settle();

    const summary = registry.reapOrphans('SIGKILL');
    expect(summary.signalSentCount).toBe(0);
    expect(summary.confirmedGoneCount).toBe(1);
    expect(summary.skippedCount).toBe(0);
    expect(summary.entries[0]!.action).toBe('confirmed_gone');
    expect(summary.entries[0]!.verification.verdict).toBe('gone');
    expect(alerts).toHaveLength(0);
    expect(registry.store.get(record.generationId)).toBeDefined();
    registry.store.remove(record.generationId);
    expect(registry.store.get(record.generationId)).toBeUndefined();
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
      asOrphanOfCrashedOwner(registry, record); // owner (prior orchestrator) is dead

      const summary = registry.reapOrphans('SIGKILL');
      expect(summary.signalSentCount).toBe(1);
      expect(summary.confirmedGoneCount).toBe(0);
      expect(summary.entries[0]!.action).toBe('signal_sent');
      expect(summary.entries[0]!.verification.verdict).toBe('match');
      expect(registry.store.get(record.generationId)).toBeDefined();
      await waitExit(child);
      expect(isAliveReal(child.pid!)).toBe(false);
      expect(registry.reapOrphans('SIGKILL').confirmedGoneCount).toBe(1);
      expect(registry.store.get(record.generationId)).toBeDefined();
      registry.store.remove(record.generationId);
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
      asOrphanOfCrashedOwner(registry, record); // owner (prior orchestrator) is dead

      const summary = registry.reapOrphans('SIGKILL');
      expect(summary.signalSentCount).toBe(0);
      expect(summary.confirmedGoneCount).toBe(0);
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
    asOrphanOfCrashedOwner(registry, record); // owner (prior orchestrator) is dead

    const summary = registry.reapOrphans('SIGKILL');
    expect(summary.signalSentCount).toBe(0);
    expect(summary.confirmedGoneCount).toBe(0);
    expect(summary.entries[0]!.verification.verdict).toBe('nonce_mismatch');
    await settle(150);
    expect(isAliveReal(child.pid!)).toBe(true);
    expect(registry.store.get(record.generationId)).toBeDefined();
    expect(alerts).toHaveLength(1);
  });
});

describe('ProcessRegistry.reapOrphans — W4-0 owner-liveness gate (§14:139)', () => {
  it('NEVER reaps a record owned by a still-alive PEER orchestrator — the child is left running and NOT in the summary', async () => {
    // Two logical orchestrators over ONE shared store. Process A (selfPid = a
    // real, LIVE pid) owns a real live child; process B does the reaping.
    const store = new InMemoryProcessRegistryStore();
    const peer = spawnDetachedNode(); // stands in for the LIVE peer orchestrator
    await settle();
    const child = spawnDetachedNode(); // A's live child
    await settle();

    const orchestratorA = new ProcessRegistry({ clock, ps: createPsClient(clock), store, selfPid: peer.pid! });
    const registered = orchestratorA.register({
      generationId: processGenerationId('gen_peer_child'),
      pid: child.pid!,
      pgid: child.pid!,
      spawnNonce: 'peer-nonce',
    });
    expect(registered.ownerPid).toBe(peer.pid); // stamped with A's pid

    const alerts: IdentityAlert[] = [];
    const orchestratorB = new ProcessRegistry({
      clock,
      ps: createPsClient(clock),
      store,
      onAlert: (a) => alerts.push(a),
      selfPid: process.pid, // B (the reaper) is a DIFFERENT live process
    });

    const summary = orchestratorB.reapOrphans('SIGKILL');

    // The live peer's child was untouched: not killed, not signaled, not
    // removed, not even identity-verified (no entry, no alert).
    expect(summary.signalSentCount).toBe(0);
    expect(summary.confirmedGoneCount).toBe(0);
    expect(summary.skippedCount).toBe(0);
    expect(summary.ownerLiveSkippedCount).toBe(1);
    expect(summary.entries).toEqual([]);
    expect(alerts).toEqual([]);
    await settle(150);
    expect(isAliveReal(child.pid!)).toBe(true);
    expect(store.get(registered.generationId)).toBeDefined();
  });

  it('DOES reap a dead-owner orphan even though the child itself is still alive (the crashed orchestrator can no longer manage it)', async () => {
    const store = new InMemoryProcessRegistryStore();
    const child = spawnDetachedNode();
    await settle();
    // The owning orchestrator already crashed: register through a registry
    // whose selfPid is a dead pid, so the record carries a dead owner.
    const prior = new ProcessRegistry({ clock, ps: createPsClient(clock), store, selfPid: CRASHED_OWNER_PID });
    const record = prior.register({
      generationId: processGenerationId('gen_deadowner_child'),
      pid: child.pid!,
      pgid: child.pid!,
      spawnNonce: 'deadowner-nonce',
    });
    expect(record.ownerPid).toBe(CRASHED_OWNER_PID);

    const reaper = new ProcessRegistry({ clock, ps: createPsClient(clock), store, selfPid: process.pid });
    const summary = reaper.reapOrphans('SIGKILL');

    expect(summary.ownerLiveSkippedCount).toBe(0);
    expect(summary.signalSentCount).toBe(1);
    expect(summary.confirmedGoneCount).toBe(0);
    expect(summary.entries[0]!.action).toBe('signal_sent');
    expect(store.get(record.generationId)).toBeDefined();
    await waitExit(child);
    expect(isAliveReal(child.pid!)).toBe(false);
    expect(reaper.reapOrphans('SIGKILL').confirmedGoneCount).toBe(1);
    expect(store.get(record.generationId)).toBeDefined();
    store.remove(record.generationId);
    expect(store.get(record.generationId)).toBeUndefined();
  });

  it('treats a RECYCLED owner pid (alive pid, different start-time) as a dead owner and reaps the orphan', async () => {
    const store = new InMemoryProcessRegistryStore();
    // The "owner" pid is a real, LIVE process — but the recorded owner
    // start-time does not match it (the original owner exited and its pid was
    // recycled by this unrelated process). Owner is therefore provably dead.
    const recycled = spawnDetachedNode();
    await settle();
    const child = spawnDetachedNode();
    await settle();

    const childIdentity = new ProcessRegistry({ clock, ps: createPsClient(clock), store }).register({
      generationId: processGenerationId('gen_recycled_owner'),
      pid: child.pid!,
      pgid: child.pid!,
      spawnNonce: 'recycled-nonce',
    });
    // Overwrite the owner with the recycled pid + a start-time that will NOT
    // match the live process now wearing it.
    store.put({ ...childIdentity, ownerPid: recycled.pid!, ownerStartedAt: 'Mon Jan  1 00:00:00 2020' });

    const reaper = new ProcessRegistry({ clock, ps: createPsClient(clock), store, selfPid: process.pid });
    const summary = reaper.reapOrphans('SIGKILL');

    expect(summary.ownerLiveSkippedCount).toBe(0);
    expect(summary.signalSentCount).toBe(1);
    expect(summary.confirmedGoneCount).toBe(0);
    expect(store.get(childIdentity.generationId)).toBeDefined();
    await waitExit(child);
    expect(isAliveReal(child.pid!)).toBe(false);
    expect(reaper.reapOrphans('SIGKILL').confirmedGoneCount).toBe(1);
    // The recycled owner process itself was never touched.
    expect(isAliveReal(recycled.pid!)).toBe(true);
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
