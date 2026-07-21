import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../lib/clock.js';
import { SpawnPinnedAcpAdapter } from './spawn-pinned.js';

const FAKE_CHILD = fileURLToPath(
  new URL('../fake/fake-acp-child.mjs', import.meta.url),
);
const AT = '2026-07-21T00:00:00.000Z';

function adapter(): SpawnPinnedAcpAdapter {
  return new SpawnPinnedAcpAdapter({
    harnessId: 'grok',
    spawn: {
      command: process.execPath,
      args: [FAKE_CHILD],
      env: {
        FAKE_ACP_SCENARIO: JSON.stringify({
          initialize: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            agentInfo: { name: 'grok', version: '0.2.106' },
          },
          sessionNew: { sessionId: 'grok-session', configOptions: [] },
        }),
      },
    },
    clock: new ManualClock(AT),
    capabilityOverrides: { modelMechanism: 'cli_flag' },
    model: 'grok-build',
    reasoning: { optionId: 'reasoning_effort', value: 'high' },
  });
}

function guardedAdapter(handshake: Record<string, unknown>): SpawnPinnedAcpAdapter {
  return new SpawnPinnedAcpAdapter({
    harnessId: 'grok',
    spawn: {
      command: process.execPath,
      args: [FAKE_CHILD],
      env: { FAKE_ACP_SCENARIO: JSON.stringify({ handshake }) },
    },
    clock: new ManualClock(AT),
    capabilityOverrides: { modelMechanism: 'cli_flag' },
    model: 'grok-build',
    initializeGuard: (result) => {
      const meta = (result as { _meta?: { mcpServers?: unknown[] } })._meta;
      if ((meta?.mcpServers?.length ?? 0) > 0) throw new Error('external MCP rejected');
    },
    notificationGuard: (method, params) => {
      const servers = (params as { mcpServers?: unknown[] } | undefined)?.mcpServers;
      if (method === '_x.ai/mcp/servers_updated' && (servers?.length ?? 0) > 0) {
        throw new Error('external MCP rejected');
      }
    },
  });
}

describe('SpawnPinnedAcpAdapter', () => {
  it('advertises and echo-confirms only the model/effort fixed in argv', async () => {
    const subject = adapter();
    try {
      const capabilities = await subject.initialize();
      expect(capabilities.modelMechanism).toBe('cli_flag');
      const session = await subject.createSession({ cwd: process.cwd() });
      expect(await subject.listConfigOptions(session.acpSessionId)).toEqual([
        {
          id: 'mode',
          kind: 'mode',
          values: ['auto', 'default', 'plan', 'read-only', 'agent', 'agent-full-access'],
          current: 'auto',
        },
        { id: 'model', kind: 'model', values: ['grok-build'], current: 'grok-build' },
        {
          id: 'reasoning_effort',
          kind: 'reasoning',
          values: ['high'],
          current: 'high',
        },
      ]);
      await expect(
        subject.setConfigOption({
          sessionId: session.acpSessionId,
          optionId: 'model',
          value: 'grok-build',
        }),
      ).resolves.toEqual({ effectiveValue: 'grok-build', echoed: true });
      await expect(
        subject.setConfigOption({
          sessionId: session.acpSessionId,
          optionId: 'reasoning_effort',
          value: 'high',
        }),
      ).resolves.toEqual({ effectiveValue: 'high', echoed: true });
    } finally {
      await subject.close();
    }
  });

  it('rejects a value that differs from the immutable spawn pin', async () => {
    const subject = adapter();
    try {
      await subject.initialize();
      const session = await subject.createSession({ cwd: process.cwd() });
      await expect(
        subject.setConfigOption({
          sessionId: session.acpSessionId,
          optionId: 'model',
          value: 'grok-elsewhere',
        }),
      ).rejects.toMatchObject({ kind: 'invalid_argument', harnessId: 'grok' });
    } finally {
      await subject.close();
    }
  });

  it('fails initialize closed when provider extension metadata violates policy', async () => {
    const subject = guardedAdapter({ meta: { mcpServers: [{ name: 'hostile' }] } });
    try {
      await expect(subject.initialize()).rejects.toMatchObject({
        kind: 'invalid_argument',
        harnessId: 'grok',
      });
    } finally {
      await subject.close();
    }
  });

  it('terminates after a provider extension notification violates policy', async () => {
    const subject = guardedAdapter({
      notifications: [
        {
          method: '_x.ai/mcp/servers_updated',
          params: { mcpServers: [{ name: 'hostile' }] },
        },
      ],
    });
    try {
      await subject.initialize();
      await new Promise<void>((resolve) => setImmediate(resolve));
      await expect(subject.createSession({ cwd: process.cwd() })).rejects.toMatchObject({
        kind: 'invalid_argument',
        harnessId: 'grok',
      });
    } finally {
      await subject.close();
    }
  });
});
