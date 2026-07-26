/**
 * Layer-boundary invariants for src/app/commands/: non-test modules must not
 * import src/cli/** or the src/app barrel (cycle risk once re-exported).
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = dirname(fileURLToPath(import.meta.url));

const REQUIRED_FILES = [
  'types.ts',
  'cli-seam.ts',
  'executor.ts',
  'index.ts',
  'types.test.ts',
  'executor.test.ts',
  'cli-seam.test.ts',
  'cli-adapter.test.ts',
  'module-boundaries.test.ts',
] as const;

/** Import specifier capture: from '...', from "...", import('...'). */
const IMPORT_SPEC =
  /(?:from\s+|import\s*\(\s*)['"]([^'"]+)['"]/g;

describe('src/app/commands module boundaries', () => {
  it('ships the expected production and test modules', async () => {
    const entries = await readdir(DIR);
    for (const name of REQUIRED_FILES) {
      expect(entries, `missing ${name}`).toContain(name);
    }
  });

  it('keeps non-test modules free of cli/ and app-barrel imports', async () => {
    const entries = await readdir(DIR);
    const nonTest = entries.filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    const offenders: string[] = [];

    for (const name of nonTest) {
      const source = await readFile(join(DIR, name), 'utf8');
      for (const match of source.matchAll(IMPORT_SPEC)) {
        const spec = match[1] ?? '';
        if (spec.includes('cli/') || spec === '../index.js') {
          offenders.push(`${name}: ${spec}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });
});
