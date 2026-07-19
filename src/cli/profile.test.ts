/**
 * Role-profile parsing (§7, §8, §18) — the two accepted forms plus the
 * conflict/validation edges. Pure; no engine.
 */
import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '../lib/result.js';
import { parseRoleProfile, parseSwitchTarget } from './profile.js';

describe('parseRoleProfile', () => {
  it('maps bare harness + --model/--effort onto a RoleModelSpec (§18 coordinator form)', () => {
    const result = parseRoleProfile({ profile: 'claude', model: 'opus', effort: 'low' });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual({ harness: 'claude', model: 'opus', effort: 'low' });
  });

  it('maps a packed harness:model token (§18 implementor form)', () => {
    const result = parseRoleProfile({ profile: 'codex:gpt-5.6-terra' });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual({ harness: 'codex', model: 'gpt-5.6-terra' });
  });

  it('maps a packed harness:model:effort token', () => {
    const result = parseRoleProfile({ profile: 'codex:gpt-5.6-terra:high' });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual({ harness: 'codex', model: 'gpt-5.6-terra', effort: 'high' });
  });

  it('errors when no model can be resolved', () => {
    expect(isErr(parseRoleProfile({ profile: 'claude' }))).toBe(true);
  });

  it('errors on an unknown harness', () => {
    expect(isErr(parseRoleProfile({ profile: 'bogus', model: 'x' }))).toBe(true);
  });

  it('errors on an unknown effort', () => {
    expect(isErr(parseRoleProfile({ profile: 'claude', model: 'opus', effort: 'ludicrous' }))).toBe(true);
  });

  it('rejects specifying the model twice (profile + --model)', () => {
    expect(isErr(parseRoleProfile({ profile: 'claude:opus', model: 'sonnet' }))).toBe(true);
  });

  it('rejects specifying the effort twice (profile + --effort)', () => {
    expect(isErr(parseRoleProfile({ profile: 'claude:opus:low', effort: 'high' }))).toBe(true);
  });

  it('rejects an empty or over-segmented profile', () => {
    expect(isErr(parseRoleProfile({ profile: '' }))).toBe(true);
    expect(isErr(parseRoleProfile({ profile: 'claude:opus:low:extra' }))).toBe(true);
  });
});

describe('parseSwitchTarget', () => {
  it('resolves harness from --harness', () => {
    const result = parseSwitchTarget({ model: 'gpt-5.6-sol', harness: 'codex' });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual({ harness: 'codex', model: 'gpt-5.6-sol' });
  });

  it('resolves harness from a harness:model --model token', () => {
    const result = parseSwitchTarget({ model: 'codex:gpt-5.6-sol' });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual({ harness: 'codex', model: 'gpt-5.6-sol' });
  });

  it('carries --effort through', () => {
    const result = parseSwitchTarget({ model: 'opus', harness: 'claude', effort: 'medium' });
    expect(isOk(result)).toBe(true);
    if (isOk(result)) expect(result.value).toEqual({ harness: 'claude', model: 'opus', effort: 'medium' });
  });

  it('errors when the harness cannot be determined', () => {
    expect(isErr(parseSwitchTarget({ model: 'opus' }))).toBe(true);
  });
});
