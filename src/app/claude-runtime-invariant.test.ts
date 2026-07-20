import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CLAUDE_RUNTIME_AUTH_POLICY,
  claudeProviderRolePolicy,
} from '../adapters/claude/provider.js';

describe('Claude production runtime invariant', () => {
  it('keeps every role on the installed subscription provider', () => {
    expect(CLAUDE_RUNTIME_AUTH_POLICY).toBe('installed_subscription_provider_only');
    expect(claudeProviderRolePolicy('coordinator').permissionMode).toBe('dontAsk');
    expect(claudeProviderRolePolicy('implementor').permissionMode).toBe('acceptEdits');
    expect(claudeProviderRolePolicy('verifier').permissionMode).toBe('dontAsk');
  });

  it('forbids the legacy API-key ACP factory from production service wiring', async () => {
    const serviceSource = await readFile(
      fileURLToPath(new URL('./service.ts', import.meta.url)),
      'utf8',
    );
    expect(serviceSource).toContain("if (options.resolved.harness === 'claude')");
    expect(serviceSource).toContain('createClaudeProviderAdapter({');
    expect(serviceSource).not.toContain('createClaudeAcpAdapter');
  });
});
