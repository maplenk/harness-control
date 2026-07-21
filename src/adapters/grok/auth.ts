/** Grok Build authentication-material discovery. */
import { existsSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export const XAI_API_KEY_ENV_VAR = 'XAI_API_KEY';
export const GROK_AUTH_JSON_RELATIVE_PATH = path.join('.grok', 'auth.json');

/** Default SuperGrok/browser-login credential path for a specific HOME. */
export function grokAuthJsonPath(homeDir: string = homedir()): string {
  return path.join(homeDir, GROK_AUTH_JSON_RELATIVE_PATH);
}

/**
 * Presence-only probe. Credential contents are never parsed or logged, and
 * presence is not treated as proof that a provider turn will authenticate.
 */
export function detectGrokAuthMaterial(
  homeDir: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const apiKey = env[XAI_API_KEY_ENV_VAR];
  if (typeof apiKey === 'string' && apiKey.length > 0) return true;
  const authPath = grokAuthJsonPath(homeDir);
  if (!existsSync(authPath)) return false;
  const source = lstatSync(authPath);
  return source.isFile() && !source.isSymbolicLink();
}
