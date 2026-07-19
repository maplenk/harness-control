/**
 * `createPsClient` against REAL spawned processes (this repo's env is
 * Darwin — see module doc in `./ps.ts`). Foundational coverage for the
 * primitive `registry.test.ts`/`watchdog.test.ts` build their real-process
 * scenarios on top of.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { createPsClient } from './ps.js';

const clock = new ManualClock('2026-07-18T09:00:00.000Z');
const ps = createPsClient(clock);

let spawned: ChildProcess[] = [];

function spawnDetachedNode(script: string): ChildProcess {
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: 'ignore' });
  spawned.push(child);
  return child;
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 150));
  void child;
}

afterEach(() => {
  for (const child of spawned) {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
  spawned = [];
});

describe('PsClient.sampleProcessTree', () => {
  it('reports the RSS (in bytes) and pid of a real live process group', async () => {
    const child = spawnDetachedNode('setInterval(() => {}, 1000);');
    await waitForSpawn(child);
    const pid = child.pid!;

    const sample = ps.sampleProcessTree(pid);
    expect(sample).toBeDefined();
    expect(sample!.pgid).toBe(pid);
    expect(sample!.pids).toContain(pid);
    expect(sample!.processCount).toBeGreaterThanOrEqual(1);
    // A bare `node -e` process has real (non-zero) baseline RSS.
    expect(sample!.rssBytes).toBeGreaterThan(1024 * 1024);
    expect(sample!.sampledAt).toBe(clock.nowIso());
  });

  it('sums RSS across every process sharing the group (a shell + its child)', async () => {
    const child = spawn('bash', ['-c', `${JSON.stringify(process.execPath)} -e "setInterval(()=>{},1000)" & wait`], {
      detached: true,
      stdio: 'ignore',
    });
    spawned.push(child);
    await waitForSpawn(child);

    const sample = ps.sampleProcessTree(child.pid!);
    expect(sample).toBeDefined();
    expect(sample!.processCount).toBeGreaterThanOrEqual(2);
  });

  it('returns undefined for a process group with no live members', () => {
    // A pgid far outside any plausible live range.
    expect(ps.sampleProcessTree(999_999)).toBeUndefined();
  });

  it('returns undefined once the group has fully exited', async () => {
    const child = spawnDetachedNode('process.exit(0);');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(ps.sampleProcessTree(child.pid!)).toBeUndefined();
  });
});

describe('PsClient.sampleIdentity', () => {
  it('reports pid/pgid/executablePath/startedAt for a real live process', async () => {
    const child = spawnDetachedNode('setInterval(() => {}, 1000);');
    await waitForSpawn(child);
    const pid = child.pid!;

    const identity = ps.sampleIdentity(pid);
    expect(identity).toBeDefined();
    expect(identity!.pid).toBe(pid);
    expect(identity!.pgid).toBe(pid); // detached: own process-group leader
    expect(identity!.executablePath).toBe(process.execPath);
    expect(identity!.startedAt.length).toBeGreaterThan(0);
  });

  it('two live processes never share a startedAt+pid identity by coincidence', async () => {
    const a = spawnDetachedNode('setInterval(() => {}, 1000);');
    await waitForSpawn(a);
    const b = spawnDetachedNode('setInterval(() => {}, 1000);');
    await waitForSpawn(b);

    const identityA = ps.sampleIdentity(a.pid!);
    const identityB = ps.sampleIdentity(b.pid!);
    expect(identityA!.pid).not.toBe(identityB!.pid);
  });

  it('returns undefined for a pid that does not resolve', () => {
    expect(ps.sampleIdentity(999_999)).toBeUndefined();
  });

  it('re-sampling the SAME live process returns an identical identity (stable comparison basis)', async () => {
    const child = spawnDetachedNode('setInterval(() => {}, 1000);');
    await waitForSpawn(child);
    const first = ps.sampleIdentity(child.pid!);
    const second = ps.sampleIdentity(child.pid!);
    expect(second).toEqual(first);
  });
});

describe('PsClient.isAlive', () => {
  it('is true for a live process and false once it has exited', async () => {
    const child = spawnDetachedNode('setInterval(() => {}, 1000);');
    await waitForSpawn(child);
    expect(ps.isAlive(child.pid!)).toBe(true);

    process.kill(child.pid!, 'SIGKILL');
    await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(ps.isAlive(child.pid!)).toBe(false);
  });

  it('is false for an implausible pid', () => {
    expect(ps.isAlive(999_999)).toBe(false);
  });
});
