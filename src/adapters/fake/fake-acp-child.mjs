#!/usr/bin/env node
/**
 * fake-acp-child.mjs — scriptable child-process fake ACP agent.
 *
 * A real child process speaking newline-delimited JSON-RPC 2.0 over stdio,
 * scripted per test via ONE JSON file: `node fake-acp-child.mjs <scenario.json>`
 * (no argument → all defaults → a cooperative agent). It is the substrate for
 * PLAN §19 tests 1–8/21; the typed scenario schema lives in `./scenario.ts`
 * (`FakeAcpScenario`) and `./child.ts` provides a spawn helper.
 *
 * Scriptable behaviors (scenario key → effect):
 *  - `fragmentation.chunkBytes`   fragment EVERY stdout NDJSON line across
 *                                 chunk boundaries (test 1).
 *  - `turns[n].malformedLines`    inject non-JSON lines verbatim (test 2).
 *  - `turns[n].oversizedLineBytes`emit one valid-JSON line padded past N
 *                                 bytes, e.g. >1MiB (test 2).
 *  - `stderr.onStart/perTurn`     write stderr noise; stdout stays pure ACP
 *                                 (test 3).
 *  - `handshake.behavior`         'stall' never answers initialize (test 4);
 *                                 'exit' dies instead; `protocolVersion`
 *                                 advertises a mismatching version (test 4).
 *  - `turns[n].lateUpdates`       deliver session/update AFTER the prompt
 *                                 response — late updates, issue #864.
 *  - `turns[n].permission`        emit `session/request_permission` and wait
 *                                 for the client's response (tests 6, 7).
 *  - `turns[n].error`             respond with a JSON-RPC error envelope,
 *                                 e.g. -32603 + data.errorKind='rate_limit'
 *                                 (tests 8, 21; PLAN §13).
 *  - `cancel.behavior`            'acknowledge' | 'delay' | 'ignore' the
 *                                 `session/cancel` notification (test 7).
 *  - `turns[n].exit`              exit abruptly mid-turn (test 8/crash paths).
 *  - `codexHost` + `turns[n].escalation`
 *                                 H-1 substrate: inheritable-but-overridden
 *                                 approvals reviewer — env CODEX_HOME's
 *                                 config.toml wins over the scenario's
 *                                 inherited host value; internal reviewer
 *                                 auto-approves an out-of-sandbox write
 *                                 ("Guardian Review", zero permission
 *                                 requests), client routing round-trips
 *                                 session/request_permission. Plus
 *                                 `requireAuthJson`: isolated homes must
 *                                 CARRY auth.json or turns fail -32000.
 *  - `handshake.authMethods` / `authenticate`
 *                                 H-2 substrate: advertised auth methods +
 *                                 scriptable `authenticate` (accepts `{}` by
 *                                 default — acceptance ≠ validity).
 *
 * Protocol surface (ACP-shaped, REAL wire fidelity per the P2 live gate,
 * docs/reviews/p2-live-gate.md — the offline truth-pin for TX-1..TX-3b/P-1..P-3):
 *   client→agent requests: `initialize`, `session/new`, `session/load`,
 *   `session/prompt`, `session/set_config_option`, `session/set_mode`;
 *   notification: `session/cancel`.
 *   agent→client: responses, `session/update` notifications,
 *   `session/request_permission` requests (ids ≥ 9001).
 *   The initialize result carries `_meta.spawnId` echoing the
 *   HARNESS_SPAWN_ID env nonce (PLAN §10.1 identity checks).
 *
 * REAL-shape enforcement (mirrors both pinned adapters):
 *  - `session/new`/`session/load` REQUIRE `mcpServers` (and `cwd`); cwd-only
 *    params are rejected with the zod-formatted `-32602` recorded live
 *    (TX-1): `data:{_errors:[], mcpServers:{_errors:[…]}}`.
 *  - session/new + session/load results carry REAL-shaped `configOptions`
 *    (`{id,name,category,type,currentValue,options:[{value,…}]}`, TX-2) and a
 *    `modes` SessionModeState whose default `currentModeId` is the DANGEROUS
 *    live default `'auto'` (P-1) — pinning must be exercised explicitly.
 *  - `session/set_config_option` REQUIRES `configId` (an `optionId` frame is
 *    `-32602`-rejected exactly like live, TX-3); unknown ids/values get the
 *    data-less handler `-32602`; the response echoes the full refreshed
 *    `configOptions` (TX-3b) and a `config_option_update` session update
 *    precedes it (claude-verified).
 *  - `session/set_mode` validates `modeId` against `availableModes`, updates
 *    the mode state, and emits `current_mode_update` (P-1/P-3).
 *  - every prompt turn attaches REAL-shaped `usage` to the response and emits
 *    a `usage_update` session update before it (P-3/§17.2); scriptable off
 *    via `turn.usage:false` / `turn.usageUpdate:false`.
 *
 * Determinism notes: single session id (scenario.session.sessionId, default
 * 'sess_fake_000001'); turn N uses scenario.turns[N], overflowing to
 * scenario.defaultTurn, then to a built-in benign turn ("ok", end_turn).
 * All stdout writes are serialized through one queue so scripted ordering
 * (updates → response → late updates) survives fragmentation delays.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------
let scenario = {};
const scenarioPath = process.argv[2];
if (scenarioPath) {
  try {
    scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  } catch (error) {
    process.stderr.write(`fake-acp-child: cannot read scenario ${scenarioPath}: ${String(error)}\n`);
    process.exit(2);
  }
} else if (process.env.FAKE_ACP_SCENARIO) {
  try {
    scenario = JSON.parse(process.env.FAKE_ACP_SCENARIO);
  } catch (error) {
    process.stderr.write(`fake-acp-child: cannot parse FAKE_ACP_SCENARIO: ${String(error)}\n`);
    process.exit(2);
  }
}

const handshake = scenario.handshake ?? {};
const fragmentation = scenario.fragmentation ?? {};
const stderrScript = scenario.stderr ?? {};
const cancelScript = scenario.cancel ?? {};
const loadScript = scenario.load ?? {};
const authenticateScript = scenario.authenticate ?? {};
const codexHost = scenario.codexHost ?? {};
const sessionId = scenario.session?.sessionId ?? 'sess_fake_000001';
const turns = Array.isArray(scenario.turns) ? scenario.turns : [];
const builtinDefaultTurn = { updates: [{ text: 'ok' }], response: { stopReason: 'end_turn' } };

// ---------------------------------------------------------------------------
// H-1 substrate: approvals-reviewer resolution mirroring the real codex core
// (docs/reviews/p2-live-gate.md H-1; see scenario.ts `FakeCodexHostScript`).
// env CODEX_HOME set → $CODEX_HOME/config.toml's approvals_reviewer wins
// (missing file/key → the core's documented default 'user'); env unset → the
// scenario's inherited host value (models user-global ~/.codex/config.toml).
// ---------------------------------------------------------------------------
function resolveEffectiveApprovalsReviewer() {
  const codexHome = process.env.CODEX_HOME;
  if (typeof codexHome === 'string' && codexHome.length > 0) {
    try {
      const toml = readFileSync(join(codexHome, 'config.toml'), 'utf8');
      for (const line of toml.split(/\r?\n/)) {
        const match = /^\s*approvals_reviewer\s*=\s*"([^"]*)"\s*(?:#.*)?$/.exec(line);
        if (match) return match[1];
      }
    } catch {
      /* isolated home without a config file */
    }
    return 'user'; // core documented default once the host config is replaced
  }
  return codexHost.inheritedApprovalsReviewer ?? 'user';
}
const effectiveApprovalsReviewer = resolveEffectiveApprovalsReviewer();

/** H-2 substrate: with CODEX_HOME set, auth material must have been CARRIED
 * into the isolated home ($CODEX_HOME/auth.json), else turns fail with the
 * -32000 auth envelope (the live probe's provider-401 class). */
function authMaterialMissing() {
  if (codexHost.requireAuthJson !== true) return false;
  const codexHome = process.env.CODEX_HOME;
  if (typeof codexHome !== 'string' || codexHome.length === 0) return false; // inherited host login present
  return !existsSync(join(codexHome, 'auth.json'));
}

// ---------------------------------------------------------------------------
// REAL-shaped per-session state (TX-2/P-1 fidelity; see module header)
// ---------------------------------------------------------------------------
const DEFAULT_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'fake-small',
    options: [
      { value: 'fake-small', name: 'Fake Small' },
      { value: 'fake-large', name: 'Fake Large' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    // The DANGEROUS live default posture (claude 'auto') — P-1 pinning must
    // be exercised explicitly against this fake.
    currentValue: 'auto',
    options: [
      { value: 'auto', name: 'Auto' },
      { value: 'default', name: 'Default' },
      { value: 'plan', name: 'Plan' },
      { value: 'read-only', name: 'Read-only' },
      { value: 'agent', name: 'Agent' },
      { value: 'agent-full-access', name: 'Agent (full access)' },
    ],
  },
];

const DEFAULT_MODES = {
  currentModeId: 'auto',
  availableModes: [
    { id: 'auto', name: 'Auto' },
    { id: 'default', name: 'Default' },
    { id: 'plan', name: 'Plan' },
    { id: 'read-only', name: 'Read-only' },
    { id: 'agent', name: 'Agent' },
    { id: 'agent-full-access', name: 'Agent (full access)' },
  ],
};

// Mutable copies: set_config_option/set_mode update them and echo the state.
const sessionConfigOptions = structuredClone(scenario.session?.configOptions ?? DEFAULT_CONFIG_OPTIONS);
const sessionModes = structuredClone(scenario.session?.modes ?? DEFAULT_MODES);

/** REAL-shaped per-turn usage defaults (values as recorded in the gate). */
const DEFAULT_TURN_USAGE = { totalTokens: 24, inputTokens: 2, outputTokens: 22 };
const DEFAULT_USAGE_UPDATE = { used: 1200, size: 200000 };

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Zod-formatted `-32602` exactly as both pinned adapters emit it for missing
 * required params (gate appendix): `{"code":-32602,"message":"Invalid
 * params","data":{"_errors":[],"<field>":{"_errors":[…]}}}`.
 */
function invalidParamsError(missingFields) {
  const data = { _errors: [] };
  for (const field of missingFields) data[field] = { _errors: ['Required'] };
  return { code: -32602, message: 'Invalid params', data };
}

/** Handler-level, data-less `-32602` (codex `RequestError.invalidParams()`). */
const DATALESS_INVALID_PARAMS = { code: -32602, message: 'Invalid params' };

function flattenSelectValues(options) {
  const values = [];
  for (const entry of options ?? []) {
    if (entry && typeof entry.value === 'string') values.push(entry.value);
    else if (entry && Array.isArray(entry.options)) {
      for (const grouped of entry.options) {
        if (grouped && typeof grouped.value === 'string') values.push(grouped.value);
      }
    }
  }
  return values;
}

// ---------------------------------------------------------------------------
// Serialized stdout writer (fragmentation-aware)
// ---------------------------------------------------------------------------
let writeChain = Promise.resolve();

function writeStdout(data) {
  return new Promise((resolve) => process.stdout.write(data, () => resolve()));
}

/** Queue one full line (fragmented into chunks when scripted). */
function enqueueLine(text) {
  writeChain = writeChain.then(async () => {
    const line = `${text}\n`;
    const chunkBytes = fragmentation.chunkBytes ?? 0;
    if (chunkBytes > 0) {
      const interChunkDelayMs = fragmentation.interChunkDelayMs ?? 2;
      const buf = Buffer.from(line, 'utf8');
      for (let offset = 0; offset < buf.length; offset += chunkBytes) {
        await writeStdout(buf.subarray(offset, offset + chunkBytes));
        if (offset + chunkBytes < buf.length) await delay(interChunkDelayMs);
      }
    } else {
      await writeStdout(line);
    }
  });
  return writeChain;
}

const send = (message) => enqueueLine(JSON.stringify(message));
const sendRawLine = (text) => enqueueLine(text);

async function flushAndExit(code) {
  try {
    await writeChain;
  } finally {
    process.exit(code);
  }
}

// ---------------------------------------------------------------------------
// Update shaping (FakeUpdateScript sugar → ACP session/update)
// ---------------------------------------------------------------------------
function toUpdateObject(updateScript) {
  if (updateScript && typeof updateScript === 'object') {
    if ('raw' in updateScript) return updateScript.raw;
    if ('thought' in updateScript) {
      return {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: String(updateScript.thought) },
      };
    }
    if ('text' in updateScript) {
      return {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: String(updateScript.text) },
      };
    }
  }
  return { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } };
}

function sendSessionUpdate(updateScript) {
  return send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: { sessionId, update: toUpdateObject(updateScript) },
  });
}

/**
 * `turn.updatesCoalesced`: serialize ALL update lines into ONE stdout write.
 * The whole burst lands in one (or very few) pipe chunk(s), so the client
 * decodes it within a single data event — a deterministic producer-outruns-
 * consumer burst for the queue-overflow bound (test 5), immune to host load.
 * Bypasses the per-line fragmentation writer on purpose (see scenario.ts).
 */
function sendCoalescedUpdates(updateScripts) {
  const burst = updateScripts
    .map((updateScript) =>
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: { sessionId, update: toUpdateObject(updateScript) },
      }),
    )
    .map((line) => `${line}\n`)
    .join('');
  writeChain = writeChain.then(() => writeStdout(burst));
  return writeChain;
}

function oversizedLine(minBytes) {
  const skeleton = {
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } },
    },
  };
  const baseLength = JSON.stringify(skeleton).length;
  const padding = 'x'.repeat(Math.max(1, minBytes - baseLength + 1));
  skeleton.params.update.content.text = padding;
  return JSON.stringify(skeleton);
}

// ---------------------------------------------------------------------------
// Permission plumbing (agent→client requests awaiting responses)
// ---------------------------------------------------------------------------
let nextOutgoingId = 9001;
const pendingOutgoing = new Map(); // id → resolve(responseMessage)

function requestPermission(permissionScript) {
  const id = nextOutgoingId;
  nextOutgoingId += 1;
  const options = permissionScript.options ?? [
    { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'reject_once', name: 'Reject once', kind: 'reject_once' },
  ];
  const responsePromise = new Promise((resolve) => pendingOutgoing.set(id, resolve));
  void send({
    jsonrpc: '2.0',
    id,
    method: 'session/request_permission',
    params: {
      sessionId,
      toolCall: { title: permissionScript.toolTitle ?? 'write file' },
      options,
    },
  });
  return responsePromise;
}

// ---------------------------------------------------------------------------
// Prompt turns
// ---------------------------------------------------------------------------
let promptCount = 0;
/** @type {{ id: unknown, settled: boolean } | null} */
let inFlightPrompt = null;

function settlePrompt(turnState, body) {
  if (turnState.settled) return;
  turnState.settled = true;
  let finalBody = body;
  // REAL fidelity: every settled PromptResponse (incl. cancelled — codex-
  // verified) carries per-turn usage unless scripted off (`turn.usage:false`).
  if (body.result && typeof body.result.stopReason === 'string' && turnState.usage) {
    finalBody = { ...body, result: { ...body.result, usage: turnState.usage } };
  }
  void send({ jsonrpc: '2.0', id: turnState.id, ...finalBody });
}

async function runPromptTurn(id, turn) {
  const turnState = {
    id,
    settled: false,
    usage: turn.usage === false ? undefined : { ...DEFAULT_TURN_USAGE, ...(turn.usage ?? {}) },
  };
  inFlightPrompt = turnState;

  for (const line of stderrScript.perTurn ?? []) {
    process.stderr.write(`${line}\n`);
  }

  // H-2 substrate: an isolated CODEX_HOME that failed to carry auth material
  // fails the turn with the -32000 auth envelope (live probe: provider 401,
  // key already masked here exactly as redaction rendered it).
  if (authMaterialMissing()) {
    settlePrompt(turnState, {
      error: {
        code: -32000,
        message: 'Authentication required: Incorrect API key provided: sk-proj-****',
        data: { message: 'Incorrect API key provided: sk-proj-****' },
      },
    });
    return;
  }

  const updates = turn.updates ?? [];
  if (turn.updatesCoalesced === true && updates.length > 0) {
    await sendCoalescedUpdates(updates);
  } else {
    for (let i = 0; i < updates.length; i += 1) {
      if (turnState.settled) return;
      await sendSessionUpdate(updates[i]);
      if (turn.exit?.when === 'mid_updates' && i === 0) {
        await flushAndExit(turn.exit.code ?? 1);
      }
      if ((turn.updateDelayMs ?? 0) > 0) await delay(turn.updateDelayMs);
    }
  }
  if (turn.exit?.when === 'mid_updates' && updates.length === 0) {
    await flushAndExit(turn.exit.code ?? 1);
  }

  for (const line of turn.malformedLines ?? []) {
    await sendRawLine(line);
  }
  if (typeof turn.oversizedLineBytes === 'number' && turn.oversizedLineBytes > 0) {
    await sendRawLine(oversizedLine(turn.oversizedLineBytes));
  }

  // H-1 substrate: an out-of-sandbox write attempt, routed per the effective
  // approvals reviewer (see resolveEffectiveApprovalsReviewer). Mirrors the
  // live wire: internal reviewer → "Guardian Review" tool-call + silent
  // write-through; client routing → a real session/request_permission
  // round-trip that gates the write.
  if (turn.escalation) {
    const toolTitle = turn.escalation.toolTitle ?? 'Write /outside/workspace/escalation.txt';
    if (
      effectiveApprovalsReviewer === 'auto_review' ||
      effectiveApprovalsReviewer === 'guardian_subagent'
    ) {
      await send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'guardian_review_1',
            title: 'Guardian Review',
            status: 'completed',
          },
        },
      });
      await send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId,
          update: {
            sessionUpdate: 'tool_call',
            toolCallId: 'escalated_write_1',
            title: toolTitle,
            status: 'completed',
          },
        },
      });
      await sendSessionUpdate({ text: 'WROTE' }); // zero permission requests — the H-1 bypass
    } else {
      const response = await requestPermission({ toolTitle });
      if (turnState.settled) return;
      const outcome = response?.result?.outcome;
      if (outcome?.outcome === 'cancelled') {
        settlePrompt(turnState, { result: { stopReason: 'cancelled' } });
        return;
      }
      if (
        outcome?.outcome === 'selected' &&
        typeof outcome.optionId === 'string' &&
        outcome.optionId.startsWith('allow')
      ) {
        await send({
          jsonrpc: '2.0',
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'tool_call',
              toolCallId: 'escalated_write_1',
              title: toolTitle,
              status: 'completed',
            },
          },
        });
        await sendSessionUpdate({ text: 'WROTE' });
      } else {
        await sendSessionUpdate({ text: 'DENIED' }); // write blocked by the client
      }
    }
  }

  if (turn.permission) {
    const response = await requestPermission(turn.permission);
    if (turnState.settled) return;
    const outcome = response?.result?.outcome;
    if (outcome?.outcome === 'cancelled') {
      settlePrompt(turnState, { result: { stopReason: 'cancelled' } });
      return;
    }
  }

  if ((turn.delayBeforeResponseMs ?? 0) > 0) {
    await delay(turn.delayBeforeResponseMs);
    if (turnState.settled) return;
  }

  if (turn.exit?.when === 'before_response') {
    await flushAndExit(turn.exit.code ?? 1);
  }

  // REAL fidelity (P-3/§17.2): a `usage_update` session update precedes the
  // successful response on every live turn. Scriptable off/overridden.
  if (!turn.error && turn.usageUpdate !== false && !turnState.settled) {
    await send({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: {
          sessionUpdate: 'usage_update',
          ...DEFAULT_USAGE_UPDATE,
          ...(turn.usageUpdate ?? {}),
        },
      },
    });
  }

  if (turn.error) {
    settlePrompt(turnState, {
      error: {
        code: turn.error.code ?? -32603,
        message: turn.error.message ?? 'scripted error',
        ...(turn.error.data !== undefined ? { data: turn.error.data } : {}),
      },
    });
  } else {
    settlePrompt(turnState, {
      result: { stopReason: turn.response?.stopReason ?? 'end_turn' },
    });
  }

  const lateUpdates = turn.lateUpdates ?? [];
  if (lateUpdates.length > 0) {
    await delay(turn.lateUpdateDelayMs ?? 10);
    for (const updateScript of lateUpdates) {
      await sendSessionUpdate(updateScript);
    }
  }

  if (turn.exit?.when === 'after_response') {
    await flushAndExit(turn.exit.code ?? 1);
  }
}

function handleCancelNotification() {
  const behavior = cancelScript.behavior ?? 'acknowledge';
  if (behavior === 'ignore') return;
  const delayMs = cancelScript.delayMs ?? (behavior === 'delay' ? 1000 : 0);
  const target = inFlightPrompt;
  void (async () => {
    if (delayMs > 0) await delay(delayMs);
    if (target && !target.settled) {
      settlePrompt(target, { result: { stopReason: 'cancelled' } });
    }
  })();
}

// ---------------------------------------------------------------------------
// Request handlers
// ---------------------------------------------------------------------------
async function handleInitialize(message) {
  const behavior = handshake.behavior ?? 'ok';
  if (behavior === 'stall') return; // never respond; the client's 15s bound must fire
  if (behavior === 'exit') {
    await flushAndExit(handshake.exitCode ?? 1);
    return;
  }
  if ((handshake.delayMs ?? 0) > 0) await delay(handshake.delayMs);
  void send({
    jsonrpc: '2.0',
    id: message.id,
    result: {
      protocolVersion: handshake.protocolVersion ?? message.params?.protocolVersion ?? 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {},
        // P-2 substrate: real adapters advertise sessionCapabilities entries
        // as EMPTY OBJECTS `{}`; scriptable so probes can be exercised.
        ...(handshake.sessionCapabilities !== undefined
          ? { sessionCapabilities: handshake.sessionCapabilities }
          : {}),
      },
      agentInfo: { name: handshake.agentInfoName ?? 'fake-acp-child', version: '0.0.0' },
      // H-2: REAL-shaped advertised auth methods (codex-acp live:
      // [{id:'api-key',…},{id:'chat-gpt',…}]); default [] as before.
      authMethods: (handshake.authMethods ?? []).map((method) => ({
        id: method.id,
        name: method.name ?? method.id,
        description: null,
      })),
      _meta: {
        ...(handshake.meta ?? {}),
        spawnId: process.env.HARNESS_SPAWN_ID ?? null,
      },
    },
  });
  for (const notification of handshake.notifications ?? []) {
    void send({
      jsonrpc: '2.0',
      method: notification.method,
      ...(notification.params !== undefined ? { params: notification.params } : {}),
    });
  }
}

/** TX-1: `session/new` requires `cwd` AND `mcpServers` — like both adapters. */
function handleSessionNew(message) {
  const params = message.params ?? {};
  const missing = [];
  if (typeof params.cwd !== 'string') missing.push('cwd');
  if (!Array.isArray(params.mcpServers)) missing.push('mcpServers');
  if (missing.length > 0) {
    void send({ jsonrpc: '2.0', id: message.id, error: invalidParamsError(missing) });
    return;
  }
  void send({
    jsonrpc: '2.0',
    id: message.id,
    result: { sessionId, modes: sessionModes, configOptions: sessionConfigOptions },
  });
}

async function handleSessionLoad(message) {
  // TX-1: `session/load` requires `mcpServers` (and cwd/sessionId) too.
  const params = message.params ?? {};
  const missing = [];
  if (!Array.isArray(params.mcpServers)) missing.push('mcpServers');
  if (typeof params.cwd !== 'string') missing.push('cwd');
  if (typeof params.sessionId !== 'string') missing.push('sessionId');
  if (missing.length > 0) {
    void send({ jsonrpc: '2.0', id: message.id, error: invalidParamsError(missing) });
    return;
  }
  for (const updateScript of loadScript.replayUpdates ?? []) {
    await sendSessionUpdate(updateScript);
  }
  if (loadScript.error) {
    void send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: loadScript.error.code ?? -32603,
        message: loadScript.error.message ?? 'scripted load error',
        ...(loadScript.error.data !== undefined ? { data: loadScript.error.data } : {}),
      },
    });
    return;
  }
  // REAL LoadSessionResponse: modes + configOptions (no sessionId echo).
  void send({
    jsonrpc: '2.0',
    id: message.id,
    result: { modes: sessionModes, configOptions: sessionConfigOptions },
  });
}

/** TX-3/TX-3b: requires `configId` (never `optionId`); validates the value;
 * echoes the full refreshed configOptions, preceded by a
 * `config_option_update` session update (claude-verified). */
function handleSetConfigOption(message) {
  const params = message.params ?? {};
  const missing = [];
  if (typeof params.sessionId !== 'string') missing.push('sessionId');
  if (typeof params.configId !== 'string') missing.push('configId');
  if (params.value === undefined) missing.push('value');
  if (missing.length > 0) {
    void send({ jsonrpc: '2.0', id: message.id, error: invalidParamsError(missing) });
    return;
  }
  const option = sessionConfigOptions.find((entry) => entry.id === params.configId);
  if (option === undefined) {
    void send({ jsonrpc: '2.0', id: message.id, error: DATALESS_INVALID_PARAMS });
    return;
  }
  // W2-7: scripted PROVIDER-level failure (e.g. a usage-limit envelope during
  // the initial_config_pin window). Frame validation above stays REAL — only
  // a frame-valid request reaches the scripted outcome.
  const scriptedError = scenario.setConfigOption?.error;
  if (scriptedError !== undefined) {
    void send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: scriptedError.code ?? -32603,
        message: scriptedError.message ?? 'scripted error',
        ...(scriptedError.data !== undefined ? { data: scriptedError.data } : {}),
      },
    });
    return;
  }
  if (option.type === 'boolean') {
    if (typeof params.value !== 'boolean') {
      void send({ jsonrpc: '2.0', id: message.id, error: DATALESS_INVALID_PARAMS });
      return;
    }
    option.currentValue = params.value;
  } else {
    const values = flattenSelectValues(option.options);
    if (!values.includes(params.value)) {
      // Handler-level value rejection is data-less live (codex-verified).
      void send({ jsonrpc: '2.0', id: message.id, error: DATALESS_INVALID_PARAMS });
      return;
    }
    option.currentValue = params.value;
  }
  void send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'config_option_update', configOptions: sessionConfigOptions },
    },
  });
  void send({ jsonrpc: '2.0', id: message.id, result: { configOptions: sessionConfigOptions } });
}

/** H-2: `authenticate {methodId}` — accepts with the empty `{}` result
 * (mirroring live: acceptance is instant and proves NOTHING about credential
 * validity), or answers the scripted error. */
function handleAuthenticate(message) {
  const params = message.params ?? {};
  if (typeof params.methodId !== 'string') {
    void send({ jsonrpc: '2.0', id: message.id, error: invalidParamsError(['methodId']) });
    return;
  }
  if (authenticateScript.error) {
    void send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: authenticateScript.error.code ?? -32602,
        message: authenticateScript.error.message ?? 'scripted authenticate error',
        ...(authenticateScript.error.data !== undefined ? { data: authenticateScript.error.data } : {}),
      },
    });
    return;
  }
  void send({ jsonrpc: '2.0', id: message.id, result: {} });
}

/** P-1: `session/set_mode` validates against availableModes, updates the mode
 * state, emits `current_mode_update`, and responds with the empty result. */
function handleSetMode(message) {
  const params = message.params ?? {};
  const missing = [];
  if (typeof params.sessionId !== 'string') missing.push('sessionId');
  if (typeof params.modeId !== 'string') missing.push('modeId');
  if (missing.length > 0) {
    void send({ jsonrpc: '2.0', id: message.id, error: invalidParamsError(missing) });
    return;
  }
  if (!sessionModes.availableModes.some((mode) => mode.id === params.modeId)) {
    void send({ jsonrpc: '2.0', id: message.id, error: DATALESS_INVALID_PARAMS });
    return;
  }
  sessionModes.currentModeId = params.modeId;
  void send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: { sessionUpdate: 'current_mode_update', currentModeId: params.modeId },
    },
  });
  void send({ jsonrpc: '2.0', id: message.id, result: {} });
}

function handleMessage(message) {
  if (message === null || typeof message !== 'object') return;

  // Response to one of OUR requests (permission resolution).
  if (message.method === undefined && message.id !== undefined) {
    const resolve = pendingOutgoing.get(message.id);
    if (resolve) {
      pendingOutgoing.delete(message.id);
      resolve(message);
    }
    return;
  }

  switch (message.method) {
    case 'initialize':
      void handleInitialize(message);
      return;
    case 'authenticate':
      handleAuthenticate(message);
      return;
    case 'session/new':
      handleSessionNew(message);
      return;
    case 'session/load':
      void handleSessionLoad(message);
      return;
    case 'session/set_config_option':
      handleSetConfigOption(message);
      return;
    case 'session/set_mode':
      handleSetMode(message);
      return;
    case 'session/prompt': {
      const turn = turns[promptCount] ?? scenario.defaultTurn ?? builtinDefaultTurn;
      promptCount += 1;
      void runPromptTurn(message.id, turn);
      return;
    }
    case 'session/cancel':
      handleCancelNotification();
      return;
    default:
      if (message.id !== undefined) {
        void send({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: `Method not found: ${String(message.method)}` },
        });
      }
  }
}

// ---------------------------------------------------------------------------
// Boot + stdin NDJSON reader
// ---------------------------------------------------------------------------
for (const line of stderrScript.onStart ?? []) {
  process.stderr.write(`${line}\n`);
}

let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  for (;;) {
    const newlineIndex = stdinBuffer.indexOf('\n');
    if (newlineIndex === -1) break;
    const line = stdinBuffer.slice(0, newlineIndex);
    stdinBuffer = stdinBuffer.slice(newlineIndex + 1);
    if (line.trim() === '') continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stderr.write('fake-acp-child: ignoring unparseable stdin line\n');
      continue;
    }
    handleMessage(message);
  }
});
process.stdin.on('end', () => {
  void flushAndExit(0);
});
