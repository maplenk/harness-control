/**
 * ACP adapter variant for providers whose model/reasoning selection is fixed
 * in the spawned process argv rather than through session/set_config_option.
 *
 * The orchestration service deliberately has one pin-enforcement path: after
 * session/new it lists the effective options, asks the adapter to set each
 * requested value, and records the echoed result before declaring the child
 * active. A CLI-flag provider cannot mutate those values after spawn, but it
 * can still participate honestly in that contract: advertise only the exact
 * values present in argv and reject every different value.
 */
import type { AcpSessionId } from '../../domain/ids.js';
import {
  AdapterError,
  type ConfigOptionDescriptor,
  type SetConfigOptionInput,
  type SetConfigOptionResult,
} from '../spi.js';
import { AcpStdioAdapter, type AcpAdapterOptions } from './session.js';

export interface SpawnPinnedAcpAdapterOptions extends AcpAdapterOptions {
  readonly model: string;
  readonly reasoning?: {
    readonly optionId: string;
    readonly value: string;
  };
}

/**
 * Keeps all ACP wire behavior in AcpStdioAdapter while virtualizing only the
 * immutable spawn-time model/reasoning options.
 */
export class SpawnPinnedAcpAdapter extends AcpStdioAdapter {
  readonly #pins: readonly ConfigOptionDescriptor[];

  constructor(options: SpawnPinnedAcpAdapterOptions) {
    super(options);
    this.#pins = Object.freeze([
      Object.freeze({
        id: 'model',
        kind: 'model' as const,
        values: Object.freeze([options.model]),
        current: options.model,
      }),
      ...(options.reasoning !== undefined
        ? [
            Object.freeze({
              id: options.reasoning.optionId,
              kind: 'reasoning' as const,
              values: Object.freeze([options.reasoning.value]),
              current: options.reasoning.value,
            }),
          ]
        : []),
    ]);
  }

  override async listConfigOptions(
    sessionId: AcpSessionId,
  ): Promise<readonly ConfigOptionDescriptor[]> {
    // Calling through first preserves the parent's initialized/session-state
    // validation and any non-pin wire options (for example provider modes).
    const wire = await super.listConfigOptions(sessionId);
    const pinnedIds = new Set(this.#pins.map((pin) => pin.id));
    return Object.freeze([
      ...wire.filter((option) => !pinnedIds.has(option.id)),
      ...this.#pins,
    ]);
  }

  override async setConfigOption(
    input: SetConfigOptionInput,
  ): Promise<SetConfigOptionResult> {
    const pin = this.#pins.find((candidate) => candidate.id === input.optionId);
    if (pin === undefined) return super.setConfigOption(input);

    // Validate the session through the parent without issuing a wire mutation.
    await super.listConfigOptions(input.sessionId);
    const effectiveValue = pin.current!;
    if (input.value !== effectiveValue) {
      throw new AdapterError(
        'invalid_argument',
        `${this.harnessId} was spawned with ${input.optionId} '${effectiveValue}', not '${input.value}'`,
        { harnessId: this.harnessId },
      );
    }
    return { effectiveValue, echoed: true };
  }
}
