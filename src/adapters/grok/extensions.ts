/** Fail-closed guards for Grok-specific MCP extension surfaces. */
import { AdapterError } from '../spi.js';
import { GROK_HARNESS_ID } from './capabilities.js';

type EnvelopeRecord = Record<string, unknown>;

function asRecord(value: unknown): EnvelopeRecord | undefined {
  return value !== null && typeof value === 'object' ? (value as EnvelopeRecord) : undefined;
}

function hasServers(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  const record = asRecord(value);
  return record !== undefined && Object.keys(record).length > 0;
}

function rejectMcp(source: 'initialize' | 'servers_updated'): never {
  // Never interpolate the raw payload: MCP definitions commonly contain
  // executable args, headers and environment-held credentials.
  throw new AdapterError(
    'protocol_version_mismatch',
    `Grok Build ${source} advertised non-empty MCP servers; MCP passthrough is disabled by orchestrator policy`,
    { harnessId: GROK_HARNESS_ID },
  );
}

/** Accepts a full initialize result and rejects non-empty `_meta.mcpServers`. */
export function assertSafeGrokInitializeExtensions(initializeResult: unknown): void {
  const result = asRecord(initializeResult);
  const meta = asRecord(result?.['_meta']);
  if (hasServers(meta?.['mcpServers'])) rejectMcp('initialize');
}

/**
 * Guards params for `_x.ai/mcp/servers_updated`. Empty/omitted server sets
 * are harmless; any non-empty array/map is a protocol policy violation.
 */
export function assertSafeGrokMcpServersUpdated(params: unknown): void {
  const record = asRecord(params);
  const servers = record?.['mcpServers'] ?? record?.['servers'];
  if (hasServers(servers)) rejectMcp('servers_updated');
}
