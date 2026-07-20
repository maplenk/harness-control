import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  detectOpenCodeAuthMaterial,
  openCodeAuthJsonPath,
} from './auth.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('OpenCode auth-store discovery', () => {
  it('checks only the standard path and never needs credential contents', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'opencode-auth-'));
    tempDirs.push(home);
    const authPath = openCodeAuthJsonPath(home);

    expect(authPath).toBe(
      path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    );
    expect(detectOpenCodeAuthMaterial(home)).toBe(false);

    mkdirSync(path.dirname(authPath), { recursive: true });
    writeFileSync(authPath, 'not-json-and-never-read');
    expect(detectOpenCodeAuthMaterial(home)).toBe(true);
  });
});
