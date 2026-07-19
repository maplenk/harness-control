/**
 * Codex ACP adapter profile bundle (PLAN §3, §5, §9): the pieces a generic
 * ACP transport composes for the Codex harness — command resolution,
 * CapabilityRecord population, and classifyError (PLAN §5's architecture
 * diagram: "generic ACP stdio transport ├─ ... └─ Codex ACP profile"). This
 * module builds ONLY these pieces; it never spawns a process itself and is
 * NOT a `HarnessAdapter` implementation (that's the generic transport's
 * job, built elsewhere — PLAN §10).
 */
import type { Clock } from '../../lib/clock.js';
import type { CapabilityRecord, ErrorClassification } from '../spi.js';
import {
  CODEX_HARNESS_ID,
  buildCodexCapabilityRecord,
  type CodexCapabilityInput,
} from './capabilities.js';
import { classifyCodexError } from './classify.js';
import {
  CODEX_BIN_NAME,
  CODEX_PACKAGE_NAME,
  EXPECTED_CODEX_ADAPTER_VERSION,
  resolveCodexCommand,
  type ResolveCommandOptions,
  type ResolvedAdapterCommand,
} from './command.js';

export interface CodexAcpProfile {
  readonly harnessId: string;
  readonly packageName: string;
  readonly binName: string;
  readonly expectedAdapterVersion: string;
  readonly resolveCommand: (options?: ResolveCommandOptions) => ResolvedAdapterCommand;
  readonly buildCapabilityRecord: (input: CodexCapabilityInput) => CapabilityRecord;
  readonly classifyError: (raw: unknown, clock: Clock) => ErrorClassification;
}

/** The bundled Codex ACP profile — the surface a generic ACP transport
 * (built elsewhere, PLAN §10) composes against for the Codex harness. */
export const codexAcpProfile: CodexAcpProfile = {
  harnessId: CODEX_HARNESS_ID,
  packageName: CODEX_PACKAGE_NAME,
  binName: CODEX_BIN_NAME,
  expectedAdapterVersion: EXPECTED_CODEX_ADAPTER_VERSION,
  resolveCommand: resolveCodexCommand,
  buildCapabilityRecord: buildCodexCapabilityRecord,
  classifyError: classifyCodexError,
};
