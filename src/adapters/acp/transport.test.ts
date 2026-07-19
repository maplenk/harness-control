/**
 * Generic ACP stdio transport conformance — PLAN §19 tests 1–5 against the
 * child-process fake (`fake-acp-child.mjs`), driven through the real
 * `AcpStdioAdapter` → `AcpStdioTransport` stack.
 *
 * Integration-style: real child processes, real timers, generous bounds.
 * The normative §10.2 numbers are asserted on `ACP_TRANSPORT_LIMITS`; tests
 * that must OBSERVE a bound in reasonable time shrink it via the options
 * while the default stays normative.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  fakeAcpChildPath,
  writeScenarioFile,
  type FakeAcpScenario,
} from '../fake/index.js';
import { isAdapterError, type AdapterError, type AdapterErrorKind } from '../spi.js';
import type { SessionUpdate } from '../spi.js';
import { ACP_TRANSPORT_LIMITS, type AcpTransportLimits } from './transport.js';
import { AcpStdioAdapter, type AcpAdapterOptions } from './session.js';

const GENEROUS_MS = 20_000;
const SPAWN_NONCE = 'spawn-test-nonce-1';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function makeAdapter(
  scenario: FakeAcpScenario,
  options: {
    limits?: Partial<AcpTransportLimits>;
    permissions?: AcpAdapterOptions['permissions'];
  } = {},
): Promise<AcpStdioAdapter> {
  const dir = await mkdtemp(path.join(tmpdir(), 'acp-transport-test-'));
  const scenarioPath = await writeScenarioFile(scenario, dir);
  const adapter = new AcpStdioAdapter({
    harnessId: 'fake-acp-child',
    spawn: { command: process.execPath, args: [fakeAcpChildPath(), scenarioPath] },
    spawnId: SPAWN_NONCE,
    ...(options.limits !== undefined ? { limits: options.limits } : {}),
    ...(options.permissions !== undefined ? { permissions: options.permissions } : {}),
  });
  cleanups.push(async () => {
    await adapter.close();
    await rm(dir, { recursive: true, force: true });
  });
  return adapter;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitUntil(
  check: () => boolean,
  label: string,
  timeoutMs = 8000,
  intervalMs = 25,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function expectAdapterErrorKind(
  promise: Promise<unknown>,
  kind: AdapterErrorKind,
): Promise<AdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(isAdapterError(error), `expected AdapterError, got ${String(error)}`).toBe(true);
    const adapterError = error as AdapterError;
    expect(adapterError.kind).toBe(kind);
    return adapterError;
  }
  throw new Error(`Expected AdapterError kind '${kind}', but the promise resolved`);
}

function messageTexts(updates: readonly SessionUpdate[]): string[] {
  return updates.flatMap((update) =>
    update.kind === 'agent_message_chunk' ? [update.text] : [],
  );
}

describe('ACP transport limits (PLAN §10.2 — normative numbers)', () => {
  it('defaults are exactly the normative values', () => {
    expect(ACP_TRANSPORT_LIMITS.handshakeTimeoutMs).toBe(15_000);
    expect(ACP_TRANSPORT_LIMITS.turnTimeoutMs).toBe(30 * 60 * 1000);
    expect(ACP_TRANSPORT_LIMITS.maxLineBytes).toBe(1024 * 1024);
    expect(ACP_TRANSPORT_LIMITS.queueCapacity).toBe(1000);
    expect(ACP_TRANSPORT_LIMITS.stderrHeadBytes).toBe(64 * 1024);
    expect(ACP_TRANSPORT_LIMITS.stderrTailBytes).toBe(64 * 1024);
    expect(ACP_TRANSPORT_LIMITS.cancelGraceMs).toBe(3000);
    expect(ACP_TRANSPORT_LIMITS.terminateGraceMs).toBe(2000);
  });
});

describe('PLAN §19 test 1 — fragmented NDJSON', () => {
  it(
    'reassembles frames split across arbitrary chunk boundaries (handshake AND turn)',
    async () => {
      const adapter = await makeAdapter({
        fragmentation: { chunkBytes: 5, interChunkDelayMs: 0 },
        turns: [
          {
            updates: [{ text: 'hello ' }, { text: 'fragmented ' }, { text: 'world' }],
            response: { stopReason: 'end_turn' },
          },
        ],
      });
      const record = await adapter.initialize();
      expect(record.protocol).toEqual({ name: 'acp', version: '1' });
      // §10.1 identity nonce echoed through the fragmented handshake.
      expect(adapter.probedCapabilities?.spawnIdEchoed).toBe(true);

      const session = await adapter.createSession({ cwd: tmpdir() });
      expect(String(session.acpSessionId)).toBe('sess_fake_000001');

      const updates: SessionUpdate[] = [];
      const result = await adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'go',
        onUpdate: (update) => updates.push(update),
      });
      expect(result.stopReason).toBe('end_turn');
      expect(messageTexts(updates)).toEqual(['hello ', 'fragmented ', 'world']);
    },
    GENEROUS_MS,
  );
});

describe('PLAN §19 test 2 — malformed and oversized lines', () => {
  it(
    'malformed JSON on stdout is a terminal event: prompt rejects, group reaped, fatal sticks',
    async () => {
      const adapter = await makeAdapter({
        turns: [{ updates: [{ text: 'pre' }], malformedLines: ['{this is not json'] }],
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });

      await expectAdapterErrorKind(
        adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' }),
        'malformed_frame',
      );
      // Terminal event + cleanup (§10.2): the child is reaped.
      await waitUntil(() => adapter.exitInfo !== undefined, 'child reaped after malformed frame');
      // The fatal error resurfaces on any further use — never undefined behavior.
      await expectAdapterErrorKind(
        adapter.prompt({ sessionId: session.acpSessionId, prompt: 'again' }),
        'malformed_frame',
      );
    },
    GENEROUS_MS,
  );

  it(
    'a >1MiB protocol line is a terminal event (oversized_frame) even though it is valid JSON',
    async () => {
      const adapter = await makeAdapter({
        turns: [{ oversizedLineBytes: 1024 * 1024 }],
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      await expectAdapterErrorKind(
        adapter.prompt({ sessionId: session.acpSessionId, prompt: 'go' }),
        'oversized_frame',
      );
      await waitUntil(() => adapter.exitInfo !== undefined, 'child reaped after oversized frame');
    },
    GENEROUS_MS,
  );
});

describe('PLAN §19 test 3 — stderr noise isolation', () => {
  it(
    'stderr noise never contaminates the protocol; retention is bounded head/tail and redacted',
    async () => {
      const noisyLines = Array.from({ length: 40 }, (_, i) => `noise line ${i} ${'x'.repeat(180)}`);
      const adapter = await makeAdapter(
        {
          stderr: {
            onStart: [
              'first boot noise',
              'Authorization: Bearer supersecrettokenvalue1234',
              ...noisyLines,
              'last boot noise',
            ],
            perTurn: ['turn noise'],
          },
          turns: [{ updates: [{ text: 'clean' }], response: { stopReason: 'end_turn' } }],
        },
        { limits: { stderrHeadBytes: 2048, stderrTailBytes: 2048 } },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const updates: SessionUpdate[] = [];
      const result = await adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'go',
        onUpdate: (update) => updates.push(update),
      });

      // The protocol conversation was untouched by ~8KB of stderr noise.
      expect(result.stopReason).toBe('end_turn');
      expect(messageTexts(updates)).toEqual(['clean']);
      expect(updates.every((update) => update.kind !== 'unknown')).toBe(true);

      await waitUntil(() => {
        const snapshot = adapter.stderrSnapshot();
        return snapshot !== undefined && snapshot.tail.includes('turn noise');
      }, 'stderr captured');

      const snapshot = adapter.stderrSnapshot()!;
      // Head keeps the beginning, tail the end, and the middle was dropped.
      expect(snapshot.head).toContain('first boot noise');
      expect(snapshot.tail).toContain('turn noise');
      expect(snapshot.truncated).toBe(true);
      expect(snapshot.totalBytes).toBeGreaterThan(2048 + 2048);
      // §17.1: redacted before exposure.
      expect(snapshot.head).not.toContain('supersecrettokenvalue1234');
      expect(snapshot.head).toContain('[REDACTED:auth_header]');
    },
    GENEROUS_MS,
  );
});

describe('PLAN §19 test 4 — handshake timeout + protocol version mismatch', () => {
  it(
    'a stalled handshake trips the (shrunk) handshake bound and reaps the child',
    async () => {
      const adapter = await makeAdapter(
        { handshake: { behavior: 'stall' } },
        { limits: { handshakeTimeoutMs: 400 } },
      );
      await expectAdapterErrorKind(adapter.initialize(), 'handshake_timeout');
      await waitUntil(() => adapter.exitInfo !== undefined, 'child reaped after handshake timeout');
    },
    GENEROUS_MS,
  );

  it(
    'a protocol version mismatch at initialize is terminal and reaps the child',
    async () => {
      const adapter = await makeAdapter({ handshake: { protocolVersion: 99 } });
      await expectAdapterErrorKind(adapter.initialize(), 'protocol_version_mismatch');
      await waitUntil(() => adapter.exitInfo !== undefined, 'child reaped after version mismatch');
    },
    GENEROUS_MS,
  );

  it(
    'a child that exits instead of answering the handshake surfaces unexpected_eof',
    async () => {
      const adapter = await makeAdapter({ handshake: { behavior: 'exit', exitCode: 7 } });
      await expectAdapterErrorKind(adapter.initialize(), 'unexpected_eof');
      expect(adapter.exitInfo?.code).toBe(7);
    },
    GENEROUS_MS,
  );
});

describe('PLAN §19 test 5 — bounded decoded-event queue / backpressure', () => {
  it(
    'an update flood past the (shrunk) queue bound is a terminal event + cleanup',
    async () => {
      const adapter = await makeAdapter(
        {
          turns: [
            {
              updates: Array.from({ length: 400 }, (_, i) => ({ text: `u${i}` })),
              // ONE stdout write for the whole 400-line burst: the client
              // decodes it within a single data event, so with capacity 40
              // the enqueue loop overflows synchronously — the producer
              // outruns the consumer DETERMINISTICALLY (a per-line trickle
              // is load-dependent: a starved child under a busy host lets
              // the drain keep up and the flood never overflows).
              updatesCoalesced: true,
              response: { stopReason: 'end_turn' },
            },
          ],
        },
        // Queue bound shrunk to keep the test fast; drain throttled so the
        // producer genuinely outruns the consumer. Default bound (1000) is
        // asserted normative above.
        { limits: { queueCapacity: 40, dispatchBatchSize: 5 } },
      );
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      await expectAdapterErrorKind(
        adapter.prompt({ sessionId: session.acpSessionId, prompt: 'flood' }),
        'queue_overflow',
      );
      await waitUntil(() => adapter.exitInfo !== undefined, 'child reaped after queue overflow');
    },
    GENEROUS_MS,
  );

  it(
    'bursts below the bound are absorbed: every update delivered, in order, then the result',
    async () => {
      const count = 300;
      const adapter = await makeAdapter({
        turns: [
          {
            updates: Array.from({ length: count }, (_, i) => ({ text: `u${i}` })),
            response: { stopReason: 'end_turn' },
          },
        ],
      });
      await adapter.initialize();
      const session = await adapter.createSession({ cwd: tmpdir() });
      const updates: SessionUpdate[] = [];
      const result = await adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'burst',
        onUpdate: (update) => updates.push(update),
      });
      expect(result.stopReason).toBe('end_turn');
      expect(messageTexts(updates)).toEqual(
        Array.from({ length: count }, (_, i) => `u${i}`),
      );
    },
    GENEROUS_MS,
  );
});
