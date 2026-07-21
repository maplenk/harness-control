/** Read-only hostile project-configuration guard for Grok Build spawns. */
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { AdapterError } from '../spi.js';
import { GROK_HARNESS_ID } from './capabilities.js';

/** Sources that can add executable integrations or widen tool permissions. */
export const GROK_UNSAFE_PROJECT_SOURCES: readonly string[] = [
  path.join('.grok', 'config.toml'),
  path.join('.grok', 'hooks'),
  path.join('.grok', 'plugins'),
  path.join('.grok', 'sandbox.toml'),
  path.join('.claude', 'settings.json'),
  path.join('.claude', 'settings.local.json'),
  '.mcp.json',
  path.join('.cursor', 'mcp.json'),
] as const;

function directoriesToGitRoot(cwd: string): readonly string[] {
  const directories: string[] = [];
  let current = path.resolve(cwd);
  for (;;) {
    directories.push(current);
    if (existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return directories;
}

/**
 * Returns every executable/permission-bearing source Grok would discover
 * between cwd and the git root. Instruction and skill files are deliberately
 * not rejected: they cannot bypass the OS sandbox or ACP permission channel.
 */
export function findUnsafeGrokProjectSources(cwd: string): readonly string[] {
  const found = new Set<string>();
  for (const directory of directoriesToGitRoot(cwd)) {
    for (const relative of GROK_UNSAFE_PROJECT_SOURCES) {
      const candidate = path.join(directory, relative);
      if (existsSync(candidate)) found.add(candidate);
    }
  }
  return [...found].sort();
}

/** Fails closed before spawn when project config could widen policy. */
export function assertSafeGrokProjectConfig(cwd: string): void {
  const unsafe = findUnsafeGrokProjectSources(cwd);
  if (unsafe.length === 0) return;
  throw new AdapterError(
    'invalid_argument',
    `Refusing Grok Build spawn: project executable/permission configuration is present: ${unsafe.join(', ')}`,
    { harnessId: GROK_HARNESS_ID },
  );
}
