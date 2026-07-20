import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SystemClock } from '../../lib/clock.js';
import {
  CLAUDE_PROVIDER_SCOPE_PROMPT,
  CLAUDE_RUNTIME_AUTH_POLICY,
  ClaudeProviderAdapter,
  buildClaudeProviderArgs,
  checkClaudeProviderVersion,
  claudeProviderRolePolicy,
  classifyClaudeProviderError,
  type ResolvedClaudeProviderCommand,
} from './provider.js';

const fixture = fileURLToPath(new URL('./provider.test-child.mjs', import.meta.url));
const resolved: ResolvedClaudeProviderCommand = {
  command: process.execPath,
  args: [fixture],
  packageName: 'claude-provider-test',
  version: '0.0.0-test',
  binPath: fixture,
  packageDir: fileURLToPath(new URL('.', import.meta.url)),
};

describe('ClaudeProviderAdapter — first-party persistent stream-json path', () => {
  it('pins the complete coordinator spawn argv, including every safety flag', () => {
    expect(
      buildClaudeProviderArgs({
        resolvedArgs: ['provider-shim'],
        role: 'coordinator',
        model: 'opus',
        effort: 'low',
        sessionId: 'session-coordinator',
      }),
    ).toEqual([
      'provider-shim',
      '-p',
      '--model',
      'opus',
      '--effort',
      'low',
      '--permission-mode',
      'dontAsk',
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      'Read,Glob,Grep',
      '--disallowedTools',
      'Task,NotebookEdit,EnterWorktree,ExitWorktree,Write,Edit',
      '--append-system-prompt',
      CLAUDE_PROVIDER_SCOPE_PROMPT,
      '--no-session-persistence',
      '--session-id',
      'session-coordinator',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
    ]);
  });

  it('pins the complete implementor spawn argv with edits allowed and Bash denied', () => {
    expect(
      buildClaudeProviderArgs({
        role: 'implementor',
        model: 'sonnet',
        sessionId: 'session-implementor',
      }),
    ).toEqual([
      '-p',
      '--model',
      'sonnet',
      '--permission-mode',
      'acceptEdits',
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      'Read,Glob,Grep,Edit,Write',
      '--disallowedTools',
      'Task,NotebookEdit,EnterWorktree,ExitWorktree,Bash',
      '--append-system-prompt',
      CLAUDE_PROVIDER_SCOPE_PROMPT,
      '--no-session-persistence',
      '--session-id',
      'session-implementor',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
    ]);
  });

  it('pins exact verifier Bash grants without granting blanket shell access', () => {
    const args = buildClaudeProviderArgs({
      role: 'verifier',
      model: 'sonnet',
      effort: 'high',
      sessionId: 'session-verifier',
      allowedShellCommands: ['npm test', 'git diff --stat'],
    });
    expect(args).toEqual([
      '-p',
      '--model',
      'sonnet',
      '--effort',
      'high',
      '--permission-mode',
      'dontAsk',
      '--safe-mode',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
      '--tools',
      'Read,Glob,Grep,Bash',
      '--allowedTools',
      'Bash(npm test)',
      'Bash(git diff --stat)',
      '--settings',
      '{"permissions":{"allow":["Bash(npm test)","Bash(git diff --stat)"]}}',
      '--disallowedTools',
      'Task,NotebookEdit,EnterWorktree,ExitWorktree,Write,Edit',
      '--append-system-prompt',
      CLAUDE_PROVIDER_SCOPE_PROMPT,
      '--no-session-persistence',
      '--session-id',
      'session-verifier',
      '--output-format',
      'stream-json',
      '--input-format',
      'stream-json',
      '--include-partial-messages',
      '--verbose',
    ]);
    expect(args).not.toContain('Bash');
  });

  it('enforces subscription-provider-only routing and role-specific tool policy', () => {
    expect(CLAUDE_RUNTIME_AUTH_POLICY).toBe('installed_subscription_provider_only');
    expect(claudeProviderRolePolicy('coordinator')).toEqual({
      permissionMode: 'dontAsk',
      tools: ['Read', 'Glob', 'Grep'],
      deniedTools: ['Task', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'Write', 'Edit'],
      allowedTools: [],
    });
    expect(claudeProviderRolePolicy('verifier')).toEqual(
      claudeProviderRolePolicy('coordinator'),
    );
    expect(claudeProviderRolePolicy('implementor')).toEqual({
      permissionMode: 'acceptEdits',
      tools: ['Read', 'Glob', 'Grep', 'Edit', 'Write'],
      deniedTools: ['Task', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'Bash'],
      allowedTools: [],
    });
    expect(claudeProviderRolePolicy('verifier', ['npm test', 'git diff --stat'])).toEqual({
      permissionMode: 'dontAsk',
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      deniedTools: ['Task', 'NotebookEdit', 'EnterWorktree', 'ExitWorktree', 'Write', 'Edit'],
      allowedTools: ['Bash(npm test)', 'Bash(git diff --stat)'],
    });
    expect(checkClaudeProviderVersion('2.1.215 (Claude Code)').pinned).toBe(true);
    expect(checkClaudeProviderVersion('2.2.0 (Claude Code)').pinned).toBe(true);
    expect(checkClaudeProviderVersion('2.1.214 (Claude Code)').pinned).toBe(false);
    expect(checkClaudeProviderVersion('not-semver').pinned).toBe(false);
  });

  it('supports the implementor through the same native provider adapter', async () => {
    const adapter = new ClaudeProviderAdapter({
      role: 'implementor',
      cwd: tmpdir(),
      model: 'sonnet',
      effort: 'low',
      clock: new SystemClock(),
      resolved,
    });
    try {
      const capabilities = await adapter.initialize();
      expect(capabilities).toMatchObject({
        harnessId: 'claude',
        protocol: { name: 'headless_json', version: 'stream-json-v1' },
        permissionRequests: false,
      });
      await expect(adapter.createSession({ cwd: tmpdir() })).resolves.toMatchObject({
        nativeSessionId: expect.any(String),
      });
    } finally {
      await adapter.close();
    }
  });

  it('keeps one native session across turns and exposes provider-echoed model/usage', async () => {
    const adapter = new ClaudeProviderAdapter({
      role: 'coordinator',
      cwd: tmpdir(),
      model: 'opus',
      effort: 'low',
      clock: new SystemClock(),
      resolved,
    });
    try {
      const capabilities = await adapter.initialize();
      expect(capabilities).toMatchObject({
        harnessId: 'claude',
        protocol: { name: 'headless_json', version: 'stream-json-v1' },
        modelMechanism: 'cli_flag',
        permissionRequests: false,
      });
      const session = await adapter.createSession({ cwd: tmpdir() });
      await expect(
        adapter.setConfigOption({
          sessionId: session.acpSessionId,
          optionId: 'model',
          value: 'opus',
        }),
      ).resolves.toEqual({ effectiveValue: 'opus', echoed: true });
      await expect(
        adapter.setConfigOption({
          sessionId: session.acpSessionId,
          optionId: 'thinking',
          value: 'low',
        }),
      ).resolves.toEqual({ effectiveValue: 'low', echoed: true });

      const first: string[] = [];
      const firstResult = await adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'one',
        onUpdate: (update) => {
          if (update.kind === 'agent_message_chunk') first.push(update.text);
        },
      });
      const second: string[] = [];
      const secondResult = await adapter.prompt({
        sessionId: session.acpSessionId,
        prompt: 'two',
        onUpdate: (update) => {
          if (update.kind === 'agent_message_chunk') second.push(update.text);
        },
      });

      expect(first.join('')).toBe('TURN_1');
      expect(second.join('')).toBe('TURN_2');
      expect(firstResult).toMatchObject({
        stopReason: 'end_turn',
        usage: { inputTokens: 6, outputTokens: 4, costUsd: 0.01, source: 'adapter' },
      });
      expect(secondResult).toMatchObject({
        stopReason: 'end_turn',
        usage: { inputTokens: 7, outputTokens: 4, costUsd: 0.02, source: 'adapter' },
      });
      expect(adapter.observedModel).toBe('resolved/opus');
      expect(adapter.rateLimitObservations).toEqual([
        {
          infoKey: 'rate_limit_info',
          fields: ['rateLimitType', 'resetsAt', 'status', 'utilization'],
          status: 'allowed_warning',
          resetsAt: 1_784_934_000,
          rateLimitType: 'seven_day',
          classification: {
            kind: 'unknown_provider_error',
            source: 'parsed',
            confidence: 'low',
            detectionTier: 'unknown',
            provider: 'claude',
          },
        },
        {
          infoKey: 'rate_limit_info',
          fields: ['rateLimitType', 'resetsAt', 'status', 'utilization'],
          status: 'allowed_warning',
          resetsAt: 1_784_934_000,
          rateLimitType: 'seven_day',
          classification: {
            kind: 'unknown_provider_error',
            source: 'parsed',
            confidence: 'low',
            detectionTier: 'unknown',
            provider: 'claude',
          },
        },
      ]);
      expect(adapter.toolInvocationObservations).toEqual([
        {
          name: 'Bash',
          inputKeys: ['command'],
          command: 'fixture-command-1',
        },
        {
          name: 'Bash',
          inputKeys: ['command'],
          command: 'fixture-command-2',
        },
      ]);
      expect(session.nativeSessionId).toBeDefined();
      expect(adapter.transportPid).toBeTypeOf('number');
    } finally {
      await adapter.close();
    }
  });

  it('classifies only structured native provider limit/auth envelopes', () => {
    // Exact allowed-warning shape observed from real Claude Code 2.1.215.
    expect(
      classifyClaudeProviderError({
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          resetsAt: 1_784_934_000,
          rateLimitType: 'seven_day',
          utilization: 0.83,
          isUsingOverage: false,
          surpassedThreshold: 0.75,
        },
      }),
    ).toMatchObject({
      kind: 'unknown_provider_error',
      detectionTier: 'unknown',
    });
    expect(
      classifyClaudeProviderError({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000 },
      }),
    ).toMatchObject({
      kind: 'usage_limit',
      detectionTier: 'structured',
      provider: 'claude',
    });
    expect(
      classifyClaudeProviderError({
        type: 'rate_limit_event',
        rateLimitInfo: { status: 'REJECTED', resets_at: 1_800_000_000 },
      }),
    ).toMatchObject({
      kind: 'usage_limit',
      detectionTier: 'structured',
      provider: 'claude',
      resumesAt: '2027-01-15T08:00:00.000Z',
    });
    expect(
      classifyClaudeProviderError({
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        api_error_status: 429,
      }),
    ).toMatchObject({
      kind: 'usage_limit',
      detectionTier: 'http_429',
      provider: 'claude',
    });
    expect(classifyClaudeProviderError({ error: { statusCode: '429' } })).toMatchObject({
      kind: 'usage_limit',
      detectionTier: 'http_429',
      provider: 'claude',
    });
    expect(classifyClaudeProviderError({ api_error_status: 401 })).toMatchObject({
      kind: 'auth',
      provider: 'claude',
    });
    expect(classifyClaudeProviderError({ response: { status: '403' } })).toMatchObject({
      kind: 'auth',
      provider: 'claude',
    });
    expect(classifyClaudeProviderError('rate limit 429')).toMatchObject({
      kind: 'unknown_provider_error',
      detectionTier: 'unknown',
    });
  });
});
