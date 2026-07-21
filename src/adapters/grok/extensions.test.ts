import { describe, expect, it } from 'vitest';
import {
  assertSafeGrokInitializeExtensions,
  assertSafeGrokMcpServersUpdated,
} from './extensions.js';

describe('Grok MCP extension guards', () => {
  it('accepts absent and empty initialize MCP server sets', () => {
    expect(() => assertSafeGrokInitializeExtensions({})).not.toThrow();
    expect(() =>
      assertSafeGrokInitializeExtensions({ _meta: { mcpServers: [] } }),
    ).not.toThrow();
  });

  it('rejects non-empty initialize MCP servers without leaking the payload', () => {
    const secret = 'DO-NOT-LEAK';
    let thrown: unknown;
    try {
      assertSafeGrokInitializeExtensions({
        _meta: { mcpServers: [{ command: 'server', env: { SECRET: secret } }] },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ kind: 'protocol_version_mismatch' });
    expect((thrown as Error).message).not.toContain(secret);
  });

  it('accepts empty updates and rejects non-empty servers_updated payloads', () => {
    expect(() => assertSafeGrokMcpServersUpdated({ servers: [] })).not.toThrow();
    expect(() => assertSafeGrokMcpServersUpdated({ mcpServers: {} })).not.toThrow();
    expect(() =>
      assertSafeGrokMcpServersUpdated({ servers: [{ name: 'host-tool' }] }),
    ).toThrow(/MCP passthrough is disabled/);
  });
});
