import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSafeGrokProjectConfig, findUnsafeGrokProjectSources } from './project-safety.js';

const roots: string[] = [];
function repo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'grok-project-safety-'));
  roots.push(root);
  mkdirSync(path.join(root, '.git'));
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Grok hostile project-config guard', () => {
  it('finds executable and permission sources from cwd through the git root', () => {
    const root = repo();
    const nested = path.join(root, 'packages', 'app');
    mkdirSync(path.join(nested, '.grok', 'plugins'), { recursive: true });
    mkdirSync(path.join(root, '.claude'), { recursive: true });
    writeFileSync(path.join(root, '.claude', 'settings.local.json'), '{}');
    const found = findUnsafeGrokProjectSources(nested);
    expect(found).toEqual([
      path.join(root, '.claude', 'settings.local.json'),
      path.join(nested, '.grok', 'plugins'),
    ].sort());
    expect(() => assertSafeGrokProjectConfig(nested)).toThrow(/Refusing Grok Build spawn/);
  });

  it('does not reject project instructions or skills', () => {
    const root = repo();
    mkdirSync(path.join(root, '.grok', 'skills', 'safe'), { recursive: true });
    writeFileSync(path.join(root, 'AGENTS.md'), '# rules');
    writeFileSync(path.join(root, '.grok', 'skills', 'safe', 'SKILL.md'), '# safe');
    expect(findUnsafeGrokProjectSources(root)).toEqual([]);
    expect(() => assertSafeGrokProjectConfig(root)).not.toThrow();
  });
});
