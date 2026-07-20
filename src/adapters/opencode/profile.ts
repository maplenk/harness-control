/** OpenCode ACP profile bundle composed by the generic provider factory. */
import type { Clock } from '../../lib/clock.js';
import type { CapabilityRecord, ErrorClassification } from '../spi.js';
import {
  OPENCODE_HARNESS_ID,
  buildOpenCodeCapabilityRecord,
  type OpenCodeCapabilityInput,
} from './capabilities.js';
import { classifyOpenCodeError } from './classify.js';
import {
  EXPECTED_OPENCODE_VERSION,
  OPENCODE_BIN_NAME,
  OPENCODE_PACKAGE_NAME,
  resolveOpenCodeCommand,
  type ResolveCommandOptions,
  type ResolvedAdapterCommand,
} from './command.js';

export interface OpenCodeAcpProfile {
  readonly harnessId: string;
  readonly packageName: string;
  readonly binName: string;
  readonly expectedAdapterVersion: string;
  readonly resolveCommand: (options?: ResolveCommandOptions) => ResolvedAdapterCommand;
  readonly buildCapabilityRecord: (input: OpenCodeCapabilityInput) => CapabilityRecord;
  readonly classifyError: (raw: unknown, clock: Clock) => ErrorClassification;
}

export const openCodeAcpProfile: OpenCodeAcpProfile = {
  harnessId: OPENCODE_HARNESS_ID,
  packageName: OPENCODE_PACKAGE_NAME,
  binName: OPENCODE_BIN_NAME,
  expectedAdapterVersion: EXPECTED_OPENCODE_VERSION,
  resolveCommand: resolveOpenCodeCommand,
  buildCapabilityRecord: buildOpenCodeCapabilityRecord,
  classifyError: classifyOpenCodeError,
};
