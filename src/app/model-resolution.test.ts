/**
 * §11.2 / §3 model + effort resolution — pure mapping AND its application
 * against a live session via `setConfigOption` (asserted against the
 * in-process fake). Covers the two live-test targets explicitly:
 * coordinator = claude/opus/low, implementor = codex/gpt-5.6-terra.
 */
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../lib/clock.js';
import { InProcessFakeAdapter, type ConfigOptionDescriptor } from '../adapters/index.js';
import {
  applyRoleModel,
  resolveOptionId,
  resolveRoleModel,
  roleModelSpec,
  asHarness,
  CLAUDE_REASONING_OPTION_ID,
  CODEX_REASONING_OPTION_ID,
  OPENCODE_REASONING_OPTION_ID,
  UnadvertisedModelTargetError,
} from './model-resolution.js';

function setCalls(adapter: InProcessFakeAdapter): unknown[] {
  return adapter.log.filter((entry) => entry.op === 'setConfigOption').map((entry) => entry.detail);
}

async function fakeWith(harnessId: string, configOptions: readonly ConfigOptionDescriptor[]) {
  const adapter = new InProcessFakeAdapter({
    harnessId,
    clock: new ManualClock('2026-07-18T00:00:00.000Z'),
    capabilities: { configOptions },
  });
  await adapter.initialize();
  const session = await adapter.createSession({ cwd: '/workspace' });
  const advertised = await adapter.listConfigOptions(session.acpSessionId);
  return { adapter, sessionId: session.acpSessionId, advertised };
}

const CLAUDE_OPTIONS: readonly ConfigOptionDescriptor[] = [
  { id: 'model', kind: 'model', values: ['opus', 'sonnet', 'haiku'], current: 'sonnet' },
  // Deliberately NOT the preferred id 'thinking' — exercises kind-matching.
  { id: 'reasoning_effort', kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
];

const CODEX_OPTIONS: readonly ConfigOptionDescriptor[] = [
  { id: 'model', kind: 'model', values: ['gpt-5.6-terra', 'gpt-5.6-sol'], current: 'gpt-5.6-sol' },
  { id: CODEX_REASONING_OPTION_ID, kind: 'reasoning', values: ['minimal', 'low', 'medium', 'high'], current: 'medium' },
];

const OPENCODE_OPTIONS: readonly ConfigOptionDescriptor[] = [
  {
    id: 'model',
    kind: 'model',
    values: ['xai/grok-4.5'],
    current: 'xai/grok-4.5',
  },
  {
    id: OPENCODE_REASONING_OPTION_ID,
    kind: 'reasoning',
    values: ['low', 'medium', 'high'],
    current: 'low',
  },
  { id: 'mode', kind: 'mode', values: ['build', 'plan'], current: 'plan' },
];

describe('resolveRoleModel (pure §11.2 mapping)', () => {
  it('maps claude/opus/low → model option + reasoning/thinking option', () => {
    const resolved = resolveRoleModel({ harness: 'claude', model: 'opus', effort: 'low' });
    expect(resolved.harness).toBe('claude');
    expect(resolved.model).toBe('opus');
    expect(resolved.effort).toBe('low');
    expect(resolved.configOptions).toEqual([
      { purpose: 'model', optionId: 'model', value: 'opus', kind: 'model' },
      { purpose: 'reasoning', optionId: CLAUDE_REASONING_OPTION_ID, value: 'low', kind: 'reasoning' },
    ]);
    // Claude has no `-c` core overrides.
    expect(resolved.codexConfigOverrides).toBeUndefined();
  });

  it('maps codex/gpt-5.6-terra → model slug + model_reasoning_effort (+ `-c` overrides)', () => {
    const resolved = resolveRoleModel({ harness: 'codex', model: 'gpt-5.6-terra', effort: 'medium' });
    expect(resolved.configOptions).toEqual([
      { purpose: 'model', optionId: 'model', value: 'gpt-5.6-terra', kind: 'model' },
      { purpose: 'reasoning', optionId: CODEX_REASONING_OPTION_ID, value: 'medium', kind: 'reasoning' },
    ]);
    expect(resolved.codexConfigOverrides).toEqual({
      model: 'gpt-5.6-terra',
      model_reasoning_effort: 'medium',
    });
  });

  it('omits the reasoning intent when no effort is set (implementor codex/gpt-5.6-terra)', () => {
    const resolved = resolveRoleModel({ harness: 'codex', model: 'gpt-5.6-terra' });
    expect(resolved.configOptions).toEqual([
      { purpose: 'model', optionId: 'model', value: 'gpt-5.6-terra', kind: 'model' },
    ]);
    expect(resolved.codexConfigOverrides).toEqual({ model: 'gpt-5.6-terra' });
    expect(resolved.effort).toBeUndefined();
  });

  it('maps opencode/xai/grok-4.5/high → dynamic model id + effort option', () => {
    const resolved = resolveRoleModel({
      harness: 'opencode',
      model: 'xai/grok-4.5',
      effort: 'high',
    });
    expect(resolved.configOptions).toEqual([
      { purpose: 'model', optionId: 'model', value: 'xai/grok-4.5', kind: 'model' },
      {
        purpose: 'reasoning',
        optionId: OPENCODE_REASONING_OPTION_ID,
        value: 'high',
        kind: 'reasoning',
      },
    ]);
    expect(resolved.codexConfigOverrides).toBeUndefined();
  });
});

describe('resolveOptionId', () => {
  it('prefers an exact id match, else falls back to the matching kind', () => {
    const intent = { purpose: 'reasoning', optionId: 'thinking', value: 'low', kind: 'reasoning' } as const;
    expect(resolveOptionId(intent, CLAUDE_OPTIONS)).toBe('reasoning_effort'); // by kind
    expect(
      resolveOptionId(intent, [{ id: 'thinking', kind: 'reasoning', values: ['low'] }]),
    ).toBe('thinking'); // exact id
    // Neither present → the preferred id verbatim (attempted, fails loudly at adapter).
    expect(resolveOptionId(intent, [{ id: 'model', kind: 'model', values: [] }])).toBe('thinking');
  });
});

describe('resolveOptionId — reject an explicit unadvertised MODEL target (§5t (5))', () => {
  const modelIntent = (value: string) =>
    ({ purpose: 'model', optionId: 'model', value, kind: 'model' }) as const;

  it('accepts an advertised model slug', () => {
    expect(resolveOptionId(modelIntent('gpt-5.6-terra'), CODEX_OPTIONS)).toBe('model');
  });

  it('THROWS UnadvertisedModelTargetError for a model slug not among the advertised values (no silent set)', () => {
    expect(() => resolveOptionId(modelIntent('gpt-9-ghost'), CODEX_OPTIONS)).toThrow(
      UnadvertisedModelTargetError,
    );
  });

  it('does NOT silently fall back to the first advertised model option when the slug is unadvertised', () => {
    // Exact id 'model' absent → old code swapped to the first model-kind option
    // ('llm') and set the wrong slug. Now it rejects the unadvertised target.
    expect(() =>
      resolveOptionId(modelIntent('ghost'), [{ id: 'llm', kind: 'model', values: ['a', 'b'] }]),
    ).toThrow(/not advertised/);
  });

  it('keeps the no-explicit-target default behavior when the option enumerates no values', () => {
    // values: [] → cannot validate → attempted (fails loudly at the adapter), not rejected.
    expect(resolveOptionId(modelIntent('anything'), [{ id: 'model', kind: 'model', values: [] }])).toBe(
      'model',
    );
  });
});

describe('applyRoleModel (against the in-process fake)', () => {
  it('coordinator=claude/opus/low → setConfigOption(model=opus) then reasoning(low)', async () => {
    const { adapter, sessionId, advertised } = await fakeWith('claude', CLAUDE_OPTIONS);
    const resolved = resolveRoleModel(roleModelSpec(asHarness('claude'), 'opus', 'low'));

    const applied = await applyRoleModel(adapter, sessionId, resolved, advertised);

    expect(setCalls(adapter)).toEqual([
      { optionId: 'model', value: 'opus' },
      { optionId: 'reasoning_effort', value: 'low' }, // resolved by kind
    ]);
    expect(applied.map((a) => ({ id: a.resolvedOptionId, ok: a.ok, echoed: a.echoed, value: a.effectiveValue }))).toEqual([
      { id: 'model', ok: true, echoed: true, value: 'opus' },
      { id: 'reasoning_effort', ok: true, echoed: true, value: 'low' },
    ]);
  });

  it('implementor=codex/gpt-5.6-terra → setConfigOption(model=gpt-5.6-terra) via model_reasoning_effort key', async () => {
    const { adapter, sessionId, advertised } = await fakeWith('codex', CODEX_OPTIONS);
    const resolved = resolveRoleModel({ harness: 'codex', model: 'gpt-5.6-terra', effort: 'low' });

    await applyRoleModel(adapter, sessionId, resolved, advertised);

    expect(setCalls(adapter)).toEqual([
      { optionId: 'model', value: 'gpt-5.6-terra' },
      { optionId: 'model_reasoning_effort', value: 'low' },
    ]);
  });

  it('opencode/xai/grok-4.5/high pins the exact advertised model and effort', async () => {
    const { adapter, sessionId, advertised } = await fakeWith('opencode', OPENCODE_OPTIONS);
    const resolved = resolveRoleModel({
      harness: 'opencode',
      model: 'xai/grok-4.5',
      effort: 'high',
    });

    await applyRoleModel(adapter, sessionId, resolved, advertised);

    expect(setCalls(adapter)).toEqual([
      { optionId: 'model', value: 'xai/grok-4.5' },
      { optionId: 'effort', value: 'high' },
    ]);
  });

  it('captures a per-intent failure (value outside advertised set) without throwing', async () => {
    const narrowed: readonly ConfigOptionDescriptor[] = [
      { id: 'model', kind: 'model', values: ['opus'], current: 'opus' },
      { id: 'thinking', kind: 'reasoning', values: ['medium', 'high'], current: 'medium' }, // no 'low'
    ];
    const { adapter, sessionId, advertised } = await fakeWith('claude', narrowed);
    const resolved = resolveRoleModel({ harness: 'claude', model: 'opus', effort: 'low' });

    const applied = await applyRoleModel(adapter, sessionId, resolved, advertised);

    expect(applied[0]?.ok).toBe(true);
    expect(applied[1]?.ok).toBe(false);
    expect(applied[1]?.error).toContain('invalid_argument');
    // The call was still attempted (logged) even though the value was rejected.
    expect(setCalls(adapter)).toContainEqual({ optionId: 'thinking', value: 'low' });
  });

  it('captures an unadvertised MODEL target as ok:false WITHOUT attempting a set (typed rejection, no silent swap)', async () => {
    const { adapter, sessionId, advertised } = await fakeWith('codex', CODEX_OPTIONS);
    const resolved = resolveRoleModel({ harness: 'codex', model: 'gpt-9-ghost' });

    const applied = await applyRoleModel(adapter, sessionId, resolved, advertised);

    expect(applied[0]?.ok).toBe(false);
    expect(applied[0]?.error).toContain('not advertised');
    // The wrong model was NEVER set on the session — no silent swap/attempt.
    expect(setCalls(adapter)).toEqual([]);
  });
});

describe('asHarness / roleModelSpec validation', () => {
  it('accepts OpenCode as a live harness', () => {
    expect(asHarness('opencode')).toBe('opencode');
  });

  it('rejects unknown harness and effort', () => {
    expect(() => asHarness('gemini')).toThrow(/Unknown harness/);
    expect(() => roleModelSpec('claude', 'opus', 'turbo')).toThrow(/Unknown reasoning effort/);
  });
});
