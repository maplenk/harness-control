/**
 * Claude ACP adapter profile bundle (PLAN §3, §5, §9): the pieces a generic
 * ACP transport composes for the Claude harness — command resolution,
 * CapabilityRecord population, and classifyError (PLAN §5's architecture
 * diagram: "generic ACP stdio transport ├─ Claude ACP profile"). This
 * module builds ONLY these pieces; it never spawns a process itself and is
 * NOT a `HarnessAdapter` implementation (that's the generic transport's
 * job, built elsewhere — PLAN §10).
 */
import type { Clock } from '../../lib/clock.js';
import type { CapabilityRecord, ErrorClassification } from '../spi.js';
import {
  CLAUDE_HARNESS_ID,
  buildClaudeCapabilityRecord,
  type ClaudeCapabilityInput,
} from './capabilities.js';
import { classifyClaudeError } from './classify.js';
import {
  CLAUDE_BIN_NAME,
  CLAUDE_PACKAGE_NAME,
  EXPECTED_CLAUDE_ADAPTER_VERSION,
  resolveClaudeCommand,
  type ResolveCommandOptions,
  type ResolvedAdapterCommand,
} from './command.js';

export interface ClaudeAcpProfile {
  readonly harnessId: string;
  readonly packageName: string;
  readonly binName: string;
  readonly expectedAdapterVersion: string;
  readonly resolveCommand: (options?: ResolveCommandOptions) => ResolvedAdapterCommand;
  readonly buildCapabilityRecord: (input: ClaudeCapabilityInput) => CapabilityRecord;
  readonly classifyError: (raw: unknown, clock: Clock) => ErrorClassification;
}

/** The bundled Claude ACP profile — the surface a generic ACP transport
 * (built elsewhere, PLAN §10) composes against for the Claude harness. */
export const claudeAcpProfile: ClaudeAcpProfile = {
  harnessId: CLAUDE_HARNESS_ID,
  packageName: CLAUDE_PACKAGE_NAME,
  binName: CLAUDE_BIN_NAME,
  expectedAdapterVersion: EXPECTED_CLAUDE_ADAPTER_VERSION,
  resolveCommand: resolveClaudeCommand,
  buildCapabilityRecord: buildClaudeCapabilityRecord,
  classifyError: classifyClaudeError,
};
