/**
 * Child-process fake tests (integration-style: real child processes, real
 * timers, generous bounds). Proves every scenario knob the transport
 * conformance suite (PLAN §19 tests 1–8/21) will lean on actually behaves as
 * scripted on the wire: handshake, fragmentation, malformed/oversized lines,
 * stderr isolation, stalls, permission requests, error envelopes, late
 * updates, ignored cancels, and unexpected exits.
 */
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { FakeAcpScenario } from './scenario.js';
import { rateLimitErrorEnvelope } from './scenario.js';
import { spawnFakeAcpChild, type SpawnedFakeAcp } from './child.js';

const GENEROUS_MS = 10_000;

interface JsonRpcMessage {
  readonly jsonrpc?: string;
  readonly id?: number | string;
  readonly method?: string;
  readonly params?: any;
  readonly result?: any;
  readonly error?: { code: number; message: string; data?: unknown };
}

/** Minimal raw NDJSON client — deliberately NOT the product transport. */
class RawClient {
  readonly stdoutChunks: string[] = [];
  readonly lines: string[] = [];
  readonly messages: JsonRpcMessage[] = [];
  readonly unparsedLines: string[] = [];
  stderr = '';
  #buffer = '';
  #nextId = 1;
  readonly #waiters: Array<{
    predicate: (m: JsonRpcMessage) => boolean;
    resolve: (m: JsonRpcMessage) => void;
  }> = [];

  constructor(readonly spawned: SpawnedFakeAcp) {
    const { child } = spawned;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.stdoutChunks.push(chunk);
      this.#buffer += chunk;
      for (;;) {
        const index = this.#buffer.indexOf('\n');
        if (index === -1) break;
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        if (line === '') continue;
        this.lines.push(line);
        try {
          const message = JSON.parse(line) as JsonRpcMessage;
          this.messages.push(message);
          for (let i = this.#waiters.length - 1; i >= 0; i -= 1) {
            const waiter = this.#waiters[i]!;
            if (waiter.predicate(message)) {
              this.#waiters.splice(i, 1);
              waiter.resolve(message);
            }
          }
        } catch {
          this.unparsedLines.push(line);
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });
  }

  send(message: object): void {
    this.spawned.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method: string, params?: object): number {
    const id = this.#nextId;
    this.#nextId += 1;
    this.send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
    return id;
  }

  waitFor(
    predicate: (m: JsonRpcMessage) => boolean,
    timeoutMs = GENEROUS_MS,
    label = 'message',
  ): Promise<JsonRpcMessage> {
    const existing = this.messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.#waiters.push({
        predicate,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  waitForResponse(id: number, timeoutMs = GENEROUS_MS): Promise<JsonRpcMessage> {
    return this.waitFor((m) => m.id === id && m.method === undefined, timeoutMs, `response ${id}`);
  }
}

const clients: RawClient[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.spawned.cleanup()));
});

async function start(
  scenario: FakeAcpScenario,
  env?: Readonly<Record<string, string>>,
): Promise<RawClient> {
  const spawned = await spawnFakeAcpChild(scenario, env !== undefined ? { env } : {});
  const client = new RawClient(spawned);
  clients.push(client);
  return client;
}

/** initialize + session/new; returns the sessionId the child advertises.
 * Sends the wire-REQUIRED `mcpServers: []` (TX-1) — cwd-only is rejected. */
async function handshakeAndSession(client: RawClient): Promise<string> {
  const initId = client.request('initialize', { protocolVersion: 1 });
  await client.waitForResponse(initId);
  const newId = client.request('session/new', { cwd: '/tmp', mcpServers: [] });
  const response = await client.waitForResponse(newId);
  return response.result.sessionId as string;
}

/** agent_message_chunk texts among all observed session/update messages. */
function messageChunkTexts(client: RawClient): string[] {
  return client.messages
    .filter(
      (m) =>
        m.method === 'session/update' &&
        m.params?.update?.sessionUpdate === 'agent_message_chunk',
    )
    .map((m) => m.params.update.content.text as string);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('fake ACP child process', () => {
  it(
    'happy path: handshake echoes the spawn nonce, session/new, prompt streams updates then a result',
    async () => {
      const client = await start(
        {
          turns: [
            {
              updates: [{ text: 'hello ' }, { text: 'world' }],
              response: { stopReason: 'end_turn' },
            },
          ],
        },
        { HARNESS_SPAWN_ID: 'nonce-123' },
      );
      const initId = client.request('initialize', { protocolVersion: 1 });
      const init = await client.waitForResponse(initId);
      expect(init.result.protocolVersion).toBe(1);
      expect(init.result.agentInfo.name).toBe('fake-acp-child');
      expect(init.result._meta.spawnId).toBe('nonce-123'); // §10.1 identity nonce

      const sessionId = await handshakeAndSession(client);
      expect(sessionId).toBe('sess_fake_000001');

      const promptId = client.request('session/prompt', { sessionId, prompt: [] });
      const response = await client.waitForResponse(promptId);
      expect(response.result.stopReason).toBe('end_turn');
      // REAL fidelity: per-turn usage on the settled response (gate-recorded
      // shape) and a usage_update session update before it (P-3/§17.2).
      expect(response.result.usage).toEqual({ totalTokens: 24, inputTokens: 2, outputTokens: 22 });
      const usageUpdates = client.messages.filter(
        (m) => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'usage_update',
      );
      expect(usageUpdates).toHaveLength(1);
      expect(usageUpdates[0]!.params.update).toMatchObject({ used: 1200, size: 200000 });

      const updates = client.messages.filter((m) => m.method === 'session/update');
      expect(messageChunkTexts(client)).toEqual(['hello ', 'world']);
      // Updates (incl. the usage_update) arrived before the response.
      const responseIndex = client.messages.indexOf(response);
      for (const update of updates) expect(client.messages.indexOf(update)).toBeLessThan(responseIndex);
    },
    GENEROUS_MS,
  );

  it(
    'test-1 substrate: fragments NDJSON across chunk boundaries while frames stay parseable',
    async () => {
      const client = await start({
        fragmentation: { chunkBytes: 7, interChunkDelayMs: 2 },
        turns: [{ updates: [{ text: 'fragmented payload' }] }],
      });
      const sessionId = await handshakeAndSession(client);
      const promptId = client.request('session/prompt', { sessionId, prompt: [] });
      await client.waitForResponse(promptId);
      // Frames were split: many raw chunks carry no newline at all.
      expect(client.stdoutChunks.length).toBeGreaterThan(client.lines.length);
      expect(client.stdoutChunks.some((chunk) => !chunk.includes('\n'))).toBe(true);
      expect(client.unparsedLines).toEqual([]); // reassembled lines all parse
      const updates = client.messages.filter((m) => m.method === 'session/update');
      expect(updates[0]?.params.update.content.text).toBe('fragmented payload');
    },
    GENEROUS_MS,
  );

  it(
    'test-2 substrate: emits malformed lines verbatim and an oversized (>1MiB) valid-JSON line',
    async () => {
      const oneMiB = 1024 * 1024;
      const client = await start({
        turns: [
          {
            malformedLines: ['{this is not json', 'plain noise line'],
            oversizedLineBytes: oneMiB,
          },
        ],
      });
      const sessionId = await handshakeAndSession(client);
      const promptId = client.request('session/prompt', { sessionId, prompt: [] });
      await client.waitForResponse(promptId);
      expect(client.unparsedLines).toEqual(['{this is not json', 'plain noise line']);
      const oversized = client.lines.find((line) => Buffer.byteLength(line, 'utf8') > oneMiB);
      expect(oversized).toBeDefined();
      expect(() => JSON.parse(oversized!)).not.toThrow(); // valid JSON, just too big
    },
    GENEROUS_MS,
  );

  it(
    'test-3 substrate: stderr noise stays on stderr; stdout remains pure protocol',
    async () => {
      const client = await start({
        stderr: { onStart: ['boot noise'], perTurn: ['turn noise'] },
        turns: [{ updates: [{ text: 'clean' }] }],
      });
      const sessionId = await handshakeAndSession(client);
      const promptId = client.request('session/prompt', { sessionId, prompt: [] });
      await client.waitForResponse(promptId);
      await sleep(50);
      expect(client.stderr).toContain('boot noise');
      expect(client.stderr).toContain('turn noise');
      expect(client.unparsedLines).toEqual([]);
      expect(client.lines.some((line) => line.includes('noise'))).toBe(false);
    },
    GENEROUS_MS,
  );

  it(
    'test-4 substrate: a stalled handshake never answers; a scripted version mismatch is advertised',
    async () => {
      const stalled = await start({ handshake: { behavior: 'stall' } });
      const initId = stalled.request('initialize', { protocolVersion: 1 });
      await sleep(400);
      expect(stalled.messages.filter((m) => m.id === initId)).toHaveLength(0);
      expect(stalled.spawned.child.exitCode).toBeNull(); // alive, just silent

      const mismatched = await start({ handshake: { protocolVersion: 99 } });
      const mismatchId = mismatched.request('initialize', { protocolVersion: 1 });
      const response = await mismatched.waitForResponse(mismatchId);
      expect(response.result.protocolVersion).toBe(99);
    },
    GENEROUS_MS,
  );

  it(
    'late updates: session/update for the closed turn arrives AFTER the prompt response (#864)',
    async () => {
      const client = await start({
        turns: [
          {
            updates: [{ text: 'on time' }],
            response: { stopReason: 'end_turn' },
            lateUpdates: [{ text: 'late straggler' }],
            lateUpdateDelayMs: 30,
          },
        ],
      });
      const sessionId = await handshakeAndSession(client);
      const promptId = client.request('session/prompt', { sessionId, prompt: [] });
      const response = await client.waitForResponse(promptId);
      const late = await client.waitFor(
        (m) => m.method === 'session/update' && m.params?.update?.content?.text === 'late straggler',
        GENEROUS_MS,
        'late update',
      );
      expect(client.messages.indexOf(late)).toBeGreaterThan(client.messages.indexOf(response));
    },
    GENEROUS_MS,
  );

  it(
    'permission flow: emits session/request_permission, waits, honors selected and cancelled outcomes',
    async () => {
      const client = await start({
        turns: [
          { permission: { toolTitle: 'write file' }, response: { stopReason: 'end_turn' } },
          { permission: {}, response: { stopReason: 'end_turn' } },
        ],
      });
      const sessionId = await handshakeAndSession(client);

      // Turn 1: allow.
      const prompt1 = client.request('session/prompt', { sessionId, prompt: [] });
      const permission1 = await client.waitFor(
        (m) => m.method === 'session/request_permission',
        GENEROUS_MS,
        'permission request',
      );
      expect(permission1.params.toolCall.title).toBe('write file');
      expect(permission1.params.options.length).toBeGreaterThan(0);
      client.send({
        jsonrpc: '2.0',
        id: permission1.id,
        result: { outcome: { outcome: 'selected', optionId: 'allow_once' } },
      });
      const response1 = await client.waitForResponse(prompt1);
      expect(response1.result.stopReason).toBe('end_turn');

      // Turn 2: cancelled outcome → cancelled stop reason.
      const prompt2 = client.request('session/prompt', { sessionId, prompt: [] });
      const permission2 = await client.waitFor(
        (m) => m.method === 'session/request_permission' && m.id !== permission1.id,
        GENEROUS_MS,
        'second permission request',
      );
      client.send({
        jsonrpc: '2.0',
        id: permission2.id,
        result: { outcome: { outcome: 'cancelled' } },
      });
      const response2 = await client.waitForResponse(prompt2);
      expect(response2.result.stopReason).toBe('cancelled');
    },
    GENEROUS_MS,
  );

  it(
    'test-8/21 substrate: prompt answered by a -32603 error envelope with data.errorKind=rate_limit',
    async () => {
      const client = await start({
        turns: [{ error: rateLimitErrorEnvelope({ retryAfterSeconds: 900 }) }],
      });
      const sessionId = await handshakeAndSession(client);
      const promptId = client.request('session/prompt', { sessionId, prompt: [] });
      const response = await client.waitForResponse(promptId);
      expect(response.result).toBeUndefined();
      expect(response.error?.code).toBe(-32603);
      expect((response.error?.data as any).errorKind).toBe('rate_limit');
      expect((response.error?.data as any).retryAfterSeconds).toBe(900);
    },
    GENEROUS_MS,
  );

  it(
    'cancellation: acknowledge settles with cancelled; ignore leaves the prompt unanswered',
    async () => {
      // Acknowledge: a slow turn is preempted by the cancel.
      const acking = await start({
        cancel: { behavior: 'acknowledge' },
        turns: [{ delayBeforeResponseMs: 5000 }],
      });
      const session1 = await handshakeAndSession(acking);
      const prompt1 = acking.request('session/prompt', { sessionId: session1, prompt: [] });
      await sleep(50);
      acking.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session1 } });
      const response1 = await acking.waitForResponse(prompt1);
      expect(response1.result.stopReason).toBe('cancelled');

      // Ignore: no response within a generous observation window.
      const ignoring = await start({
        cancel: { behavior: 'ignore' },
        turns: [{ delayBeforeResponseMs: 60_000 }],
      });
      const session2 = await handshakeAndSession(ignoring);
      const prompt2 = ignoring.request('session/prompt', { sessionId: session2, prompt: [] });
      await sleep(50);
      ignoring.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: session2 } });
      await sleep(300);
      expect(ignoring.messages.filter((m) => m.id === prompt2)).toHaveLength(0);
      expect(ignoring.spawned.child.exitCode).toBeNull(); // alive and stubbornly silent
    },
    GENEROUS_MS,
  );

  it(
    'unexpected exit: the child dies mid-turn with the scripted code and no response',
    async () => {
      const client = await start({
        turns: [{ updates: [{ text: 'about to die' }], exit: { when: 'before_response', code: 3 } }],
      });
      const sessionId = await handshakeAndSession(client);
      const promptId = client.request('session/prompt', { sessionId, prompt: [] });
      const [code] = (await once(client.spawned.child, 'exit')) as [number | null];
      expect(code).toBe(3);
      expect(client.messages.filter((m) => m.id === promptId)).toHaveLength(0);
      // The pre-death update still made it out (flushed before exit).
      expect(
        client.messages.some(
          (m) => m.method === 'session/update' && m.params?.update?.content?.text === 'about to die',
        ),
      ).toBe(true);
    },
    GENEROUS_MS,
  );

  it(
    'session/load replays scripted updates before responding with the REAL result shape',
    async () => {
      const client = await start({
        load: { replayUpdates: [{ text: 'replayed 1' }, { text: 'replayed 2' }] },
      });
      const initId = client.request('initialize', { protocolVersion: 1 });
      await client.waitForResponse(initId);
      const loadId = client.request('session/load', {
        sessionId: 'sess_fake_000001',
        cwd: '/tmp',
        mcpServers: [], // TX-1: wire-required on session/load too
      });
      const response = await client.waitForResponse(loadId);
      // REAL LoadSessionResponse: configOptions + modes, NO sessionId echo.
      expect(response.result.sessionId).toBeUndefined();
      expect(Array.isArray(response.result.configOptions)).toBe(true);
      expect(response.result.modes.currentModeId).toBe('auto');
      const texts = client.messages
        .filter((m) => m.method === 'session/update')
        .map((m) => m.params.update.content.text);
      expect(texts).toEqual(['replayed 1', 'replayed 2']);
      const responseIndex = client.messages.indexOf(response);
      const lastReplay = client.messages.filter((m) => m.method === 'session/update').at(-1)!;
      expect(client.messages.indexOf(lastReplay)).toBeLessThan(responseIndex);
    },
    GENEROUS_MS,
  );

  it(
    'defaults: no scenario turns → benign built-in turn; unknown methods → -32601',
    async () => {
      const client = await start({});
      const sessionId = await handshakeAndSession(client);
      const promptId = client.request('session/prompt', { sessionId, prompt: [] });
      const response = await client.waitForResponse(promptId);
      expect(response.result.stopReason).toBe('end_turn');
      const unknownId = client.request('session/does_not_exist', {});
      const error = await client.waitForResponse(unknownId);
      expect(error.error?.code).toBe(-32601);
    },
    GENEROUS_MS,
  );
});

describe('fake ACP child — REAL wire-shape enforcement (P2 live-gate fidelity)', () => {
  it(
    'TX-1: cwd-only session/new AND session/load are rejected with the recorded zod-shaped -32602',
    async () => {
      const client = await start({});
      const initId = client.request('initialize', { protocolVersion: 1 });
      await client.waitForResponse(initId);

      // The exact Run-A failure: {cwd} only, no mcpServers.
      const newId = client.request('session/new', { cwd: '/tmp' });
      const newError = await client.waitForResponse(newId);
      expect(newError.result).toBeUndefined();
      expect(newError.error?.code).toBe(-32602);
      expect(newError.error?.message).toBe('Invalid params');
      expect((newError.error?.data as any)._errors).toEqual([]);
      expect((newError.error?.data as any).mcpServers._errors.length).toBeGreaterThan(0);

      const loadId = client.request('session/load', { sessionId: 'sess_fake_000001', cwd: '/tmp' });
      const loadError = await client.waitForResponse(loadId);
      expect(loadError.error?.code).toBe(-32602);
      expect((loadError.error?.data as any).mcpServers).toBeDefined();

      // With mcpServers the same frames pass, and the result carries the
      // REAL-shaped configOptions (TX-2 substrate) + modes (P-1 substrate).
      const okId = client.request('session/new', { cwd: '/tmp', mcpServers: [] });
      const ok = await client.waitForResponse(okId);
      expect(ok.result.sessionId).toBe('sess_fake_000001');
      const model = ok.result.configOptions.find((o: any) => o.id === 'model');
      expect(model).toMatchObject({
        category: 'model',
        type: 'select',
        currentValue: 'fake-small',
      });
      expect(model.options.map((o: any) => o.value)).toEqual(['fake-small', 'fake-large']);
      expect(ok.result.modes.currentModeId).toBe('auto'); // dangerous live default
    },
    GENEROUS_MS,
  );

  it(
    'TX-3/TX-3b: set_config_option requires configId, rejects unknown values data-less, echoes configOptions and a config_option_update',
    async () => {
      const client = await start({});
      const sessionId = await handshakeAndSession(client);

      // Our old frame shape (optionId) — the exact live 7b failure.
      const wrongId = client.request('session/set_config_option', {
        sessionId,
        optionId: 'model',
        value: 'fake-large',
      });
      const wrong = await client.waitForResponse(wrongId);
      expect(wrong.error?.code).toBe(-32602);
      expect((wrong.error?.data as any).configId._errors.length).toBeGreaterThan(0);

      // Guessed value outside the advertised set — data-less handler -32602
      // (the exact live codex 7c failure).
      const guessId = client.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: 'gpt-9-guessed',
      });
      const guess = await client.waitForResponse(guessId);
      expect(guess.error).toEqual({ code: -32602, message: 'Invalid params' });

      // Correct frame: effective-value echo via configOptions[].currentValue
      // (NOT a result.value field), preceded by config_option_update.
      const okId = client.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: 'fake-large',
      });
      const ok = await client.waitForResponse(okId);
      expect(ok.result.value).toBeUndefined();
      const echoed = ok.result.configOptions.find((o: any) => o.id === 'model');
      expect(echoed.currentValue).toBe('fake-large');
      const optionUpdate = await client.waitFor(
        (m) =>
          m.method === 'session/update' &&
          m.params?.update?.sessionUpdate === 'config_option_update',
        GENEROUS_MS,
        'config_option_update',
      );
      expect(
        optionUpdate.params.update.configOptions.find((o: any) => o.id === 'model').currentValue,
      ).toBe('fake-large');
      expect(client.messages.indexOf(optionUpdate)).toBeLessThan(client.messages.indexOf(ok));
    },
    GENEROUS_MS,
  );

  it(
    'P-1 substrate: session/set_mode validates modeId, updates mode state, and emits current_mode_update',
    async () => {
      const client = await start({});
      const sessionId = await handshakeAndSession(client);

      const missingId = client.request('session/set_mode', { sessionId });
      const missing = await client.waitForResponse(missingId);
      expect(missing.error?.code).toBe(-32602);
      expect((missing.error?.data as any).modeId).toBeDefined();

      const unknownId = client.request('session/set_mode', { sessionId, modeId: 'yolo' });
      const unknown = await client.waitForResponse(unknownId);
      expect(unknown.error).toEqual({ code: -32602, message: 'Invalid params' });

      const okId = client.request('session/set_mode', { sessionId, modeId: 'default' });
      const ok = await client.waitForResponse(okId);
      expect(ok.error).toBeUndefined();
      const modeUpdate = await client.waitFor(
        (m) =>
          m.method === 'session/update' &&
          m.params?.update?.sessionUpdate === 'current_mode_update',
        GENEROUS_MS,
        'current_mode_update',
      );
      expect(modeUpdate.params.update.currentModeId).toBe('default');
    },
    GENEROUS_MS,
  );

  it(
    'scriptable fidelity knobs: usage/usageUpdate overrides and suppression; scripted session config options',
    async () => {
      const client = await start({
        session: {
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: 'm1',
              options: [{ value: 'm1', name: 'M1' }],
            },
          ],
        },
        turns: [
          { usage: { inputTokens: 7349, outputTokens: 5, totalTokens: 7354 }, usageUpdate: { used: 7349, size: 400000 } },
          { usage: false, usageUpdate: false },
        ],
      });
      const sessionId = await handshakeAndSession(client);
      const prompt1 = client.request('session/prompt', { sessionId, prompt: [] });
      const response1 = await client.waitForResponse(prompt1);
      expect(response1.result.usage).toEqual({ inputTokens: 7349, outputTokens: 5, totalTokens: 7354 });

      const prompt2 = client.request('session/prompt', { sessionId, prompt: [] });
      const response2 = await client.waitForResponse(prompt2);
      expect(response2.result.usage).toBeUndefined();
      const usageUpdates = client.messages.filter(
        (m) => m.method === 'session/update' && m.params?.update?.sessionUpdate === 'usage_update',
      );
      expect(usageUpdates).toHaveLength(1); // turn 2 suppressed its usage_update
      expect(usageUpdates[0]!.params.update.used).toBe(7349);
    },
    GENEROUS_MS,
  );

  it(
    'W2-7: scripted set_config_option provider error — frame contract stays REAL, only the outcome is scripted',
    async () => {
      const client = await start({
        setConfigOption: { error: rateLimitErrorEnvelope() },
      });
      const sessionId = await handshakeAndSession(client);

      // Frame validation is UNCHANGED: a frame-invalid request still gets the
      // zod-shaped -32602, never the scripted envelope (the fake enforces
      // real wire shapes even while scripting a provider failure).
      const wrongId = client.request('session/set_config_option', {
        sessionId,
        optionId: 'model',
        value: 'fake-large',
      });
      const wrong = await client.waitForResponse(wrongId);
      expect(wrong.error?.code).toBe(-32602);

      // A frame-VALID request gets the scripted provider envelope verbatim —
      // the wire shape of a usage limit during the initial_config_pin window.
      const okId = client.request('session/set_config_option', {
        sessionId,
        configId: 'model',
        value: 'fake-large',
      });
      const response = await client.waitForResponse(okId);
      expect(response.result).toBeUndefined();
      expect(response.error).toEqual({
        code: -32603,
        message: 'Provider rate limit reached',
        data: { errorKind: 'rate_limit' },
      });
      // The option was NOT applied and no config_option_update was emitted.
      expect(
        client.messages.some(
          (m) =>
            m.method === 'session/update' &&
            m.params?.update?.sessionUpdate === 'config_option_update',
        ),
      ).toBe(false);
    },
    GENEROUS_MS,
  );
});
