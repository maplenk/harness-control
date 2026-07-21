import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  XAI_API_KEY_ENV_VAR,
  detectGrokAuthMaterial,
  grokAuthJsonPath,
} from './auth.js';

const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'grok-auth-test-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Grok auth material discovery', () => {
  it('detects SuperGrok auth.json without reading its contents', () => {
    const home = root();
    const authPath = grokAuthJsonPath(home);
    mkdirSync(path.dirname(authPath), { recursive: true });
    writeFileSync(authPath, 'not-json-and-never-parsed');
    expect(detectGrokAuthMaterial(home, {})).toBe(true);
  });

  it('detects a non-empty XAI_API_KEY and ignores empty values', () => {
    const home = root();
    expect(detectGrokAuthMaterial(home, { [XAI_API_KEY_ENV_VAR]: 'xai-test' })).toBe(true);
    expect(detectGrokAuthMaterial(home, { [XAI_API_KEY_ENV_VAR]: '' })).toBe(false);
  });

  it('does not accept a symlink as browser-login auth material', () => {
    const home = root();
    const target = path.join(home, 'target');
    writeFileSync(target, 'secret');
    const authPath = grokAuthJsonPath(home);
    mkdirSync(path.dirname(authPath), { recursive: true });
    symlinkSync(target, authPath);
    expect(detectGrokAuthMaterial(home, {})).toBe(false);
  });
});
