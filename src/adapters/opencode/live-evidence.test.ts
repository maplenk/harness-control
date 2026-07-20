import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EXPECTED_OPENCODE_VERSION } from './command.js';

interface OpenCodeIsolationEvidence {
  readonly schemaVersion?: unknown;
  readonly harness?: unknown;
  readonly adapterVersion?: unknown;
  readonly childArgs?: unknown;
  readonly isolation?: {
    readonly pure?: unknown;
    readonly isolatedHome?: unknown;
    readonly hostileHostConfigLoaded?: unknown;
    readonly hostileProjectConfigLoaded?: unknown;
    readonly hostileMcpStarted?: unknown;
  };
  readonly permissionMediation?: {
    readonly denied?: unknown;
    readonly bashBypassFileCreated?: unknown;
  };
  readonly modelIdentityFile?: unknown;
}

const evidencePath = fileURLToPath(
  new URL('../../../docs/reviews/evidence/opencode-isolation-live.json', import.meta.url),
);

function readEvidence(): OpenCodeIsolationEvidence {
  return JSON.parse(readFileSync(evidencePath, 'utf8')) as OpenCodeIsolationEvidence;
}

describe('OpenCode live-isolation evidence gate', () => {
  it('requires refreshed real-provider proof for the exact pinned adapter version', () => {
    const proof = readEvidence();
    expect(
      proof.adapterVersion,
      'OpenCode version drift requires a fresh real-provider isolation probe: run `npm run smoke:opencode:isolation:record` only after the new binary passes the hostile-config test',
    ).toBe(EXPECTED_OPENCODE_VERSION);
    expect(proof).toMatchObject({
      schemaVersion: 2,
      harness: 'opencode',
      childArgs: ['acp', '--pure'],
      isolation: {
        pure: true,
        isolatedHome: true,
        hostileHostConfigLoaded: false,
        hostileProjectConfigLoaded: false,
        hostileMcpStarted: false,
      },
      permissionMediation: {
        bashBypassFileCreated: false,
      },
    });
    expect(Array.isArray(proof.permissionMediation?.denied)).toBe(true);
    expect((proof.permissionMediation?.denied as readonly unknown[]).length).toBeGreaterThan(0);
    expect(proof.modelIdentityFile).toContain('harness=opencode');
  });
});
