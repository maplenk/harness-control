/** Grok Build ACP profile bundle composed by the shared provider factory. */
import type { Clock } from '../../lib/clock.js';
import type { CapabilityRecord, ErrorClassification } from '../spi.js';
import {
  GROK_HARNESS_ID,
  buildGrokCapabilityRecord,
  type GrokCapabilityInput,
} from './capabilities.js';
import { classifyGrokError } from './classify.js';
import {
  GROK_BIN_NAME,
  GROK_PACKAGE_NAME,
  MINIMUM_GROK_VERSION,
  assertGrokMinimumVersion,
  type ResolveGrokCommandOptions,
  type ResolvedGrokCommand,
} from './command.js';

export interface GrokAcpProfile {
  readonly harnessId: typeof GROK_HARNESS_ID;
  readonly packageName: typeof GROK_PACKAGE_NAME;
  readonly binName: typeof GROK_BIN_NAME;
  readonly minimumVersion: typeof MINIMUM_GROK_VERSION;
  readonly resolveCommand: (options?: ResolveGrokCommandOptions) => ResolvedGrokCommand;
  readonly buildCapabilityRecord: (input: GrokCapabilityInput) => CapabilityRecord;
  readonly classifyError: (raw: unknown, clock: Clock) => ErrorClassification;
}

export const grokAcpProfile: GrokAcpProfile = {
  harnessId: GROK_HARNESS_ID,
  packageName: GROK_PACKAGE_NAME,
  binName: GROK_BIN_NAME,
  minimumVersion: MINIMUM_GROK_VERSION,
  resolveCommand: assertGrokMinimumVersion,
  buildCapabilityRecord: buildGrokCapabilityRecord,
  classifyError: classifyGrokError,
};
