/**
 * In-process fake adapter tests: proves the scriptable SPI fake honors the
 * §9 contract precisely enough to be the conformance substrate — capability
 * gating (typed, never silent), streaming order, permission flow (T20),
 * cancellation, late updates (#864), resume variants (§11.1), and the
 * reference error classifier (§13; test-21 substrate: envelopes only, agent
 * text never classifies).
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../lib/clock.js';
import { acpSessionId, nativeSessionId } from '../../domain/ids.js';
import {
  AdapterError,
  UnsupportedCapabilityError,
  isAdapterError,
  providerEnvelopeOf,
  type SessionUpdate,
} from '../spi.js';
import {
  authRequiredErrorEnvelope,
  codexUsageLimitErrorEnvelope,
  http429RetryAfterShape,
  rateLimitErrorEnvelope,
} from './scenario.js';
import {
  InProcessFakeAdapter,
  defaultCapabilityRecord,
  limitOnTurnN,
  probeScriptAuthFailure,
  probeScriptStillLimitedThenOk,
  referenceClassifyError,
  type InProcessFakeOptions,
} from './in-process.js';

const AT = '2026-07-18T00:00:00.000Z';

function makeAdapter(options: InProcessFakeOptions = {}): InProcessFakeAdapter {
  return new InProcessFakeAdapter({ clock: new ManualClock(AT), ...options });
}

async function makeSession(options: InProcessFakeOptions = {}) {
  const adapter = makeAdapter(options);
  await adapter.initialize();
  const handle = await adapter.createSession({ cwd: '/tmp/w' });
  return { adapter, handle };
}

async function kindOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isAdapterError(error) ? error.kind : `not-adapter-error:${String(error)}`;
  }
}

describe('lifecycle and capability gating', () => {
  it('session ops before initialize() throw typed invalid_state', async () => {
    const adapter = makeAdapter();
    expect(await kindOf(adapter.createSession({ cwd: '/x' }))).toBe('invalid_state');
    expect(await kindOf(adapter.prompt({ sessionId: acpSessionId('nope'), prompt: 'hi' }))).toBe(
      'invalid_state',
    );
  });

  it('probe works pre-initialize and merges scripted overrides', async () => {
    const adapter = makeAdapter({ probe: { auth: 'detected_but_unsupported', issues: ['no key'] } });
    const probe = await adapter.probe();
    expect(probe.available).toBe(true);
    expect(probe.auth).toBe('detected_but_unsupported');
    expect(probe.issues).toEqual(['no key']);
  });

  it('initialize returns defaults merged with capability overrides', async () => {
    const adapter = makeAdapter({ capabilities: { usageLimitReporting: 'none', auth: 'supported' } });
    const record = await adapter.initialize();
    expect(record.usageLimitReporting).toBe('none');
    expect(record.auth).toBe('supported');
    expect(record.probedAt).toBe(AT);
    expect(record).toEqual(adapter.capabilities);
    expect(record.modelMechanism).toBe(
      defaultCapabilityRecord('fake-acp', new ManualClock(AT)).modelMechanism,
    );
  });

  it('loadSession with load capability off throws UnsupportedCapabilityError — never silent', async () => {
    const adapter = makeAdapter({
      capabilities: { sessionOps: { create: true, load: false, resume: false, fork: false, cancel: true } },
    });
    await adapter.initialize();
    let thrown: unknown;
    try {
      await adapter.loadSession({ acpSessionId: acpSessionId('s'), cwd: '/x' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedCapabilityError);
    expect((thrown as UnsupportedCapabilityError).capability).toBe('loadSession');
  });

  it('close() is idempotent, rejects in-flight turns, and blocks further ops', async () => {
    const { adapter, handle } = await makeSession({ turns: [{ ignoreCancel: true, permission: {} }] });
    // Attach the rejection observer BEFORE close so the rejection is handled.
    const pendingKind = kindOf(adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'x' }));
    await adapter.close();
    await adapter.close();
    expect(await pendingKind).toBe('unexpected_eof');
    expect(await kindOf(adapter.createSession({ cwd: '/x' }))).toBe('invalid_state');
  });
});

describe('sessions', () => {
  it('createSession mints distinct branded ids incl. native identity', async () => {
    const { adapter, handle } = await makeSession();
    expect(String(handle.acpSessionId)).toBe('fake_acp_sess_000001');
    expect(String(handle.nativeSessionId)).toBe('fake_native_sess_000001');
    const second = await adapter.createSession({ cwd: '/tmp/w' });
    expect(String(second.acpSessionId)).toBe('fake_acp_sess_000002');
  });

  it('loadSession finds created and registered sessions; unknown → session_not_found', async () => {
    const { adapter, handle } = await makeSession();
    const reloaded = await adapter.loadSession({ acpSessionId: handle.acpSessionId, cwd: '/x' });
    expect(reloaded).toEqual(handle);
    adapter.registerLoadableSession('persisted_sess', 'persisted_native');
    const persisted = await adapter.loadSession({ acpSessionId: acpSessionId('persisted_sess'), cwd: '/x' });
    expect(String(persisted.nativeSessionId)).toBe('persisted_native');
    expect(await kindOf(adapter.loadSession({ acpSessionId: acpSessionId('ghost'), cwd: '/x' }))).toBe(
      'session_not_found',
    );
  });

  it('scripted loadError models advertised-but-failed load', async () => {
    const { adapter, handle } = await makeSession({ loadError: 'unexpected_eof' });
    expect(await kindOf(adapter.loadSession({ acpSessionId: handle.acpSessionId, cwd: '/x' }))).toBe(
      'unexpected_eof',
    );
  });
});

describe('resumeSession (§9, §11.1)', () => {
  it("default: native resume with confirmed identity, per the task's exact shape", async () => {
    const { adapter, handle } = await makeSession();
    const result = await adapter.resumeSession?.({ acpSessionId: handle.acpSessionId, cwd: '/x' });
    expect(result).toBeDefined();
    expect(result?.resumed).toBe('native');
    expect(result?.identityConfirmed).toBe(true);
    expect(result?.session).toEqual(handle);
  });

  it("scripted 'replayed' with unconfirmed identity forces the successor path decision", async () => {
    const { adapter, handle } = await makeSession({
      resume: { behavior: 'replayed', identityConfirmed: false },
    });
    const result = await adapter.resumeSession?.({ acpSessionId: handle.acpSessionId, cwd: '/x' });
    expect(result?.resumed).toBe('replayed');
    expect(result?.identityConfirmed).toBe(false);
  });

  it('advertised-but-failed resume throws the scripted typed error', async () => {
    const { adapter, handle } = await makeSession({
      resume: { behavior: 'fail', errorKind: 'unexpected_eof' },
    });
    expect(adapter.capabilities?.sessionOps.resume).toBe(true); // still advertised
    expect(
      await kindOf(adapter.resumeSession!({ acpSessionId: handle.acpSessionId, cwd: '/x' })),
    ).toBe('unexpected_eof');
  });

  it('identity mismatch against expectedNativeSessionId → session_identity_mismatch', async () => {
    const { adapter, handle } = await makeSession();
    expect(
      await kindOf(
        adapter.resumeSession!({
          acpSessionId: handle.acpSessionId,
          cwd: '/x',
          expectedNativeSessionId: nativeSessionId('some_other_native'),
        }),
      ),
    ).toBe('session_identity_mismatch');
  });

  it("'omit' removes the optional member; capability=true + method throws typed when gated off", async () => {
    const omitted = makeAdapter({ resume: 'omit' });
    expect(omitted.resumeSession).toBeUndefined();

    // Method present but record says unsupported → typed error, never silent.
    const { adapter, handle } = await makeSession({
      capabilities: { sessionOps: { create: true, load: true, resume: false, fork: false, cancel: true } },
    });
    let thrown: unknown;
    try {
      await adapter.resumeSession!({ acpSessionId: handle.acpSessionId, cwd: '/x' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnsupportedCapabilityError);
  });

  it('forkSession is omitted by default (MVP: probed only) and scriptable on', async () => {
    expect(makeAdapter().forkSession).toBeUndefined();
    const { adapter, handle } = await makeSession({
      fork: 'supported',
      capabilities: { sessionOps: { create: true, load: true, resume: true, fork: true, cancel: true } },
    });
    const fork = await adapter.forkSession!({ acpSessionId: handle.acpSessionId, cwd: '/x' });
    expect(String(fork.acpSessionId)).not.toBe(String(handle.acpSessionId));
  });
});

describe('prompt streaming', () => {
  it('emits scripted updates in order, then resolves with stop reason + usage', async () => {
    const updates: SessionUpdate[] = [
      { kind: 'agent_thought_chunk', text: 'thinking' },
      { kind: 'agent_message_chunk', text: 'hello ' },
      { kind: 'agent_message_chunk', text: 'world' },
      { kind: 'tool_call', toolCallId: 'tc_1', title: 'read file', status: 'completed' },
    ];
    const { adapter, handle } = await makeSession({
      turns: [
        {
          updates,
          result: {
            stopReason: 'end_turn',
            usage: { inputTokens: 10, outputTokens: 5, source: 'adapter' },
          },
        },
      ],
    });
    const seen: SessionUpdate[] = [];
    const result = await adapter.prompt({
      sessionId: handle.acpSessionId,
      prompt: 'hi',
      onUpdate: (u) => seen.push(u),
    });
    expect(seen).toEqual(updates);
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage?.source).toBe('adapter');
  });

  it('unscripted turns default to a benign end_turn', async () => {
    const { adapter, handle } = await makeSession();
    const result = await adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'hi' });
    expect(result).toEqual({ stopReason: 'end_turn' });
  });

  it('at most one in-flight prompt per session (§6.2)', async () => {
    const { adapter, handle } = await makeSession({ turns: [{ permission: {} }] });
    const first = adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'a' });
    expect(await kindOf(adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'b' }))).toBe(
      'invalid_state',
    );
    await adapter.cancelTurn({ sessionId: handle.acpSessionId });
    await expect(first).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('late updates arrive AFTER the prompt promise settles, attributed to the closed turn (#864)', async () => {
    const { adapter, handle } = await makeSession({
      turns: [
        {
          updates: [{ kind: 'agent_message_chunk', text: 'during' }],
          result: { stopReason: 'end_turn' },
          lateUpdates: [{ kind: 'agent_message_chunk', text: 'late' }],
        },
      ],
    });
    const order: string[] = [];
    const result = await adapter.prompt({
      sessionId: handle.acpSessionId,
      prompt: 'hi',
      onUpdate: (u) => order.push(u.kind === 'agent_message_chunk' ? u.text : u.kind),
    });
    order.push(`settled:${result.stopReason}`);
    expect(order).toEqual(['during', 'settled:end_turn']); // late one not yet delivered
    for (let i = 0; i < 12 && order.length < 3; i += 1) await Promise.resolve(); // drain microtasks
    expect(order).toEqual(['during', 'settled:end_turn', 'late']);
  });

  it('scripted error envelope rejects provider_error carrying the envelope verbatim', async () => {
    const envelope = rateLimitErrorEnvelope({ retryAfterSeconds: 1200 });
    const { adapter, handle } = await makeSession({ turns: [{ errorEnvelope: envelope }] });
    let thrown: unknown;
    try {
      await adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'hi' });
    } catch (error) {
      thrown = error;
    }
    expect(isAdapterError(thrown) && thrown.kind === 'provider_error').toBe(true);
    expect(providerEnvelopeOf(thrown)).toBe(envelope);
    // ...and a fresh prompt is allowed afterwards (turn is over).
    await expect(adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'again' })).resolves.toEqual({
      stopReason: 'end_turn',
    });
  });
});

describe('permission flow (T20)', () => {
  it('surfaces permission_request, then resolvePermission(selected) completes the turn', async () => {
    const { adapter, handle } = await makeSession({
      turns: [
        {
          permission: { requestId: 'perm_scripted', description: 'Write to src/app.ts' },
          result: { stopReason: 'end_turn' },
        },
      ],
    });
    const seen: SessionUpdate[] = [];
    const pending = adapter.prompt({
      sessionId: handle.acpSessionId,
      prompt: 'edit',
      onUpdate: (u) => seen.push(u),
    });
    const first = seen[0];
    expect(first?.kind).toBe('permission_request');
    if (first?.kind !== 'permission_request') throw new Error('unreachable');
    expect(first.request.requestId).toBe('perm_scripted');
    expect(first.request.sessionId).toBe(handle.acpSessionId);
    expect(first.request.options.length).toBeGreaterThan(0);

    await adapter.resolvePermission({
      sessionId: handle.acpSessionId,
      requestId: 'perm_scripted',
      outcome: { kind: 'selected', optionId: 'allow_once' },
    });
    await expect(pending).resolves.toEqual({ stopReason: 'end_turn' });
  });

  it('cancelled outcome resolves the turn with stopReason cancelled', async () => {
    const { adapter, handle } = await makeSession({
      turns: [{ permission: { requestId: 'p1' }, result: { stopReason: 'end_turn' } }],
    });
    const pending = adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'edit' });
    await adapter.resolvePermission({
      sessionId: handle.acpSessionId,
      requestId: 'p1',
      outcome: { kind: 'cancelled' },
    });
    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' });
  });

  it('resolving an unknown requestId is typed invalid_state', async () => {
    const { adapter, handle } = await makeSession({ turns: [{ permission: { requestId: 'p1' } }] });
    void adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'edit' });
    expect(
      await kindOf(
        adapter.resolvePermission({
          sessionId: handle.acpSessionId,
          requestId: 'wrong',
          outcome: { kind: 'selected', optionId: 'allow_once' },
        }),
      ),
    ).toBe('invalid_state');
  });
});

describe('cancellation', () => {
  it('cancelTurn settles the in-flight prompt with cancelled; idle cancel is an idempotent no-op', async () => {
    const { adapter, handle } = await makeSession({ turns: [{ permission: {} }] });
    await adapter.cancelTurn({ sessionId: handle.acpSessionId }); // idle: no-op
    const pending = adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'x' });
    await adapter.cancelTurn({ sessionId: handle.acpSessionId });
    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' });
    expect(adapter.cancelRequestCount).toBe(2);
  });

  it('ignoreCancel swallows the request; forceCompleteTurn finishes it', async () => {
    const { adapter, handle } = await makeSession({ turns: [{ ignoreCancel: true, permission: {} }] });
    let settled = false;
    const pending = adapter
      .prompt({ sessionId: handle.acpSessionId, prompt: 'x' })
      .finally(() => (settled = true));
    await adapter.cancelTurn({ sessionId: handle.acpSessionId });
    await Promise.resolve();
    expect(settled).toBe(false); // the cancel was ignored — still pending
    adapter.forceCompleteTurn(handle.acpSessionId, { stopReason: 'cancelled' });
    await expect(pending).resolves.toEqual({ stopReason: 'cancelled' });
  });
});

describe('config options (§11.2)', () => {
  it('listConfigOptions reflects the record; setConfigOption echoes the effective value', async () => {
    const { adapter, handle } = await makeSession();
    const before = await adapter.listConfigOptions(handle.acpSessionId);
    expect(before.find((o) => o.id === 'model')?.current).toBe('fake-small');
    const result = await adapter.setConfigOption({
      sessionId: handle.acpSessionId,
      optionId: 'model',
      value: 'fake-large',
    });
    expect(result).toEqual({ effectiveValue: 'fake-large', echoed: true });
    const after = await adapter.listConfigOptions(handle.acpSessionId);
    expect(after.find((o) => o.id === 'model')?.current).toBe('fake-large');
  });

  it('unknown option id and out-of-set value are typed invalid_argument', async () => {
    const { adapter, handle } = await makeSession();
    expect(
      await kindOf(
        adapter.setConfigOption({ sessionId: handle.acpSessionId, optionId: 'nope', value: 'x' }),
      ),
    ).toBe('invalid_argument');
    expect(
      await kindOf(
        adapter.setConfigOption({ sessionId: handle.acpSessionId, optionId: 'model', value: 'gpt-9' }),
      ),
    ).toBe('invalid_argument');
  });

  it('scripted onSetConfigOption can model a switch that never echoes (§11.2 timeout path)', async () => {
    const { adapter, handle } = await makeSession({
      onSetConfigOption: (input) => ({ effectiveValue: input.value, echoed: false }),
    });
    const result = await adapter.setConfigOption({
      sessionId: handle.acpSessionId,
      optionId: 'model',
      value: 'fake-large',
    });
    expect(result.echoed).toBe(false);
  });
});

describe('classifyError (§13; envelopes ONLY — test-21 substrate)', () => {
  const clock = new ManualClock(AT);

  it('-32603 + data.errorKind=rate_limit → usage_limit/structured/high with ETA from retryAfterSeconds', () => {
    const c = referenceClassifyError(rateLimitErrorEnvelope({ retryAfterSeconds: 1200 }), clock);
    expect(c.kind).toBe('usage_limit');
    expect(c.source).toBe('structured');
    expect(c.confidence).toBe('high');
    expect(c.detectionTier).toBe('structured');
    expect(c.resumesAt).toBe('2026-07-18T00:20:00.000Z');
  });

  it('nested {error:{...}} JSON-RPC envelopes classify identically', () => {
    const c = referenceClassifyError({ error: rateLimitErrorEnvelope({ resumesAt: AT }) }, clock);
    expect(c.kind).toBe('usage_limit');
    expect(c.resumesAt).toBe(AT);
  });

  it('HTTP 429 + Retry-After → usage_limit at the http_429 tier', () => {
    const c = referenceClassifyError({ status: 429, headers: { 'retry-after': '600' } }, clock);
    expect(c.kind).toBe('usage_limit');
    expect(c.detectionTier).toBe('http_429');
    expect(c.resumesAt).toBe('2026-07-18T00:10:00.000Z');
  });

  it('auth envelopes (401/403/errorKind auth) → auth', () => {
    expect(referenceClassifyError({ status: 401 }, clock).kind).toBe('auth');
    expect(referenceClassifyError({ code: -32000, data: { errorKind: 'auth' } }, clock).kind).toBe('auth');
  });

  it('typed AdapterErrors → crash/protocol; provider_error recurses on its envelope', () => {
    expect(referenceClassifyError(new AdapterError('unexpected_eof', 'died'), clock).kind).toBe('crash');
    expect(referenceClassifyError(new AdapterError('oversized_frame', 'big'), clock).kind).toBe('protocol');
    const wrapped = new AdapterError('provider_error', 'x', {
      envelope: rateLimitErrorEnvelope({}),
    });
    expect(referenceClassifyError(wrapped, clock).kind).toBe('usage_limit');
  });

  it('agent-message TEXT never classifies as a limit — fail-safe unknown_provider_error', () => {
    const chatty = 'I hit my rate limit, please retry after 5pm — resumesAt 2026-07-18T17:00:00Z';
    const c = referenceClassifyError(chatty, clock);
    expect(c.kind).toBe('unknown_provider_error');
    expect(c.confidence).toBe('low');
    expect(c.resumesAt).toBeUndefined();
    expect(referenceClassifyError(undefined, clock).kind).toBe('unknown_provider_error');
    expect(referenceClassifyError({ code: -32099, message: 'opaque' }, clock).kind).toBe(
      'unknown_provider_error',
    );
  });

  it('the adapter method applies overrides first, then the reference classifier', async () => {
    const { adapter } = await makeSession({
      classifyOverride: (raw) =>
        raw === 'special'
          ? { kind: 'auth', source: 'structured', confidence: 'high' }
          : undefined,
    });
    expect(adapter.classifyError('special').kind).toBe('auth');
    expect(adapter.classifyError(rateLimitErrorEnvelope({})).kind).toBe('usage_limit');
  });
});

describe('call log', () => {
  it('records the operation sequence for conformance assertions', async () => {
    const { adapter, handle } = await makeSession();
    await adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'x' });
    await adapter.cancelTurn({ sessionId: handle.acpSessionId });
    expect(adapter.log.map((entry) => entry.op)).toEqual([
      'initialize',
      'createSession',
      'prompt',
      'cancelTurn',
    ]);
  });
});

// ---------------------------------------------------------------------------
// W2-7 scenario extensions (fake-adapter deliverables — pinned here)
// ---------------------------------------------------------------------------
describe('W2-7: the reference classifier recognizes BOTH pinned real-adapter conventions', () => {
  const clock = new ManualClock(AT);

  it('the codex structured shape (-32603 + codexErrorInfo=usageLimitExceeded) → usage_limit with an honestly ABSENT ETA', () => {
    const c = referenceClassifyError(codexUsageLimitErrorEnvelope(), clock);
    expect(c.kind).toBe('usage_limit');
    expect(c.source).toBe('structured');
    expect(c.detectionTier).toBe('structured');
    expect('resumesAt' in c).toBe(false); // no reset field crosses ACP (#227)
    // Nested {error:{...}} wrapping classifies identically.
    expect(referenceClassifyError({ error: codexUsageLimitErrorEnvelope() }, clock).kind).toBe('usage_limit');
  });

  it('a DIFFERENT codexErrorInfo value stays fail-safe unknown (never a limit)', () => {
    const c = referenceClassifyError(
      { code: -32603, message: 'x', data: { codexErrorInfo: 'unauthorized' } },
      clock,
    );
    expect(c.kind).toBe('unknown_provider_error');
  });

  it('the shared -32000 authRequired factory shape → auth (both adapters use the same SDK factory)', () => {
    expect(referenceClassifyError(authRequiredErrorEnvelope(), clock).kind).toBe('auth');
  });

  it('the http429RetryAfterShape helper classifies at the http_429 tier with the computed ETA', () => {
    const c = referenceClassifyError(http429RetryAfterShape(600), clock);
    expect(c.kind).toBe('usage_limit');
    expect(c.detectionTier).toBe('http_429');
    expect(c.resumesAt).toBe('2026-07-18T00:10:00.000Z');
  });

  it('agent-message TEXT of either convention still never classifies (type-based guard, not content)', () => {
    expect(referenceClassifyError(JSON.stringify(codexUsageLimitErrorEnvelope()), clock).kind).toBe(
      'unknown_provider_error',
    );
    expect(referenceClassifyError(JSON.stringify(rateLimitErrorEnvelope()), clock).kind).toBe(
      'unknown_provider_error',
    );
  });
});

describe('W2-7: dieMidTurn — child death mid-turn at the SPI surface', () => {
  it('streams the scripted updates, then rejects with the transport-shaped unexpected_eof (classified crash)', async () => {
    const { adapter, handle } = await makeSession({
      turns: [
        {
          updates: [{ kind: 'agent_message_chunk', text: 'partial work' }],
          dieMidTurn: true,
          // Deliberately scripted alongside a result: death wins — the turn
          // never settles normally.
          result: { stopReason: 'end_turn' },
        },
        {},
      ],
    });
    const seen: SessionUpdate[] = [];
    const error: unknown = await adapter
      .prompt({ sessionId: handle.acpSessionId, prompt: 'x', onUpdate: (u) => seen.push(u) })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(seen).toEqual([{ kind: 'agent_message_chunk', text: 'partial work' }]);
    expect(isAdapterError(error) && error.kind === 'unexpected_eof').toBe(true);
    expect(adapter.classifyError(error).kind).toBe('crash');
    // The session is usable again (a fresh generation would re-prompt).
    await expect(adapter.prompt({ sessionId: handle.acpSessionId, prompt: 'y' })).resolves.toEqual({
      stopReason: 'end_turn',
    });
  });
});

describe('W2-7: declarative turn-script builders', () => {
  it('limitOnTurnN(3) = two benign turns then the envelope; n<1 throws', async () => {
    const turns = limitOnTurnN(3, codexUsageLimitErrorEnvelope());
    expect(turns).toHaveLength(3);
    expect(turns[0]).toEqual({});
    expect(turns[1]).toEqual({});
    expect(turns[2]!.errorEnvelope).toEqual(codexUsageLimitErrorEnvelope());
    expect(() => limitOnTurnN(0)).toThrow(/positive integer/);

    // Behavioral: turns 1..N-1 complete, turn N rejects provider_error
    // carrying the envelope.
    const { adapter, handle } = await makeSession({ turns: limitOnTurnN(2) });
    await expect(adapter.prompt({ sessionId: handle.acpSessionId, prompt: '1' })).resolves.toEqual({
      stopReason: 'end_turn',
    });
    const error: unknown = await adapter
      .prompt({ sessionId: handle.acpSessionId, prompt: '2' })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(isAdapterError(error) && error.kind === 'provider_error').toBe(true);
    expect(providerEnvelopeOf(error)).toEqual(rateLimitErrorEnvelope());
  });

  it('probeScriptStillLimitedThenOk(k): k limit turns then a healthy one; probeScriptAuthFailure: one -32000 turn', () => {
    const script = probeScriptStillLimitedThenOk(2);
    expect(script).toHaveLength(3);
    expect(script[0]!.errorEnvelope).toEqual(rateLimitErrorEnvelope());
    expect(script[1]!.errorEnvelope).toEqual(rateLimitErrorEnvelope());
    expect(script[2]).toEqual({});
    const auth = probeScriptAuthFailure();
    expect(auth).toHaveLength(1);
    expect(auth[0]!.errorEnvelope).toEqual(authRequiredErrorEnvelope());
  });
});
