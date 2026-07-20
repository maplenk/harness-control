/**
 * OpenCode credential-store discovery.
 *
 * `opencode auth login` writes provider credentials to the user's OpenCode
 * data directory. The factory presence-checks this source path, then the H-1
 * isolation layer byte-copies it into a fresh per-run XDG data home. Contents
 * are never parsed, logged, or written back to the real store.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export const OPENCODE_AUTH_JSON_RELATIVE_PATH = path.join(
  '.local',
  'share',
  'opencode',
  'auth.json',
);

/** Default OpenCode credential path for a specific HOME. */
export function openCodeAuthJsonPath(homeDir: string = homedir()): string {
  return path.join(homeDir, OPENCODE_AUTH_JSON_RELATIVE_PATH);
}

/** Read-only source presence check; credential contents are never parsed. */
export function detectOpenCodeAuthMaterial(homeDir: string = homedir()): boolean {
  return existsSync(openCodeAuthJsonPath(homeDir));
}
