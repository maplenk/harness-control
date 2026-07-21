import { describe, expect, it } from 'vitest';
import {
  STOP_INTENT_CAUSES,
  stopIntentConfirmation,
  type StopIntentCause,
} from './state.js';

type Confirmation = ReturnType<typeof stopIntentConfirmation>;

/**
 * `Record<StopIntentCause, ...>` is intentional compile-time exhaustiveness:
 * widening the public cause union fails typecheck until confirmation semantics
 * and this contract table are both updated.
 */
const EXPECTED_CONFIRMATION: Record<StopIntentCause, Confirmation> = {
  limit_pause: 'confirm_only',
  unknown_error_pause: 'confirm_only',
  user_pause: 'pause_user',
  resource_exhaustion: 'resource_exhaustion',
};

describe('StopIntentCause exhaustiveness', () => {
  it('assigns confirmation behavior to every serialized cause', () => {
    expect(STOP_INTENT_CAUSES).toEqual(Object.keys(EXPECTED_CONFIRMATION));
    for (const cause of STOP_INTENT_CAUSES) {
      expect(stopIntentConfirmation(cause)).toBe(EXPECTED_CONFIRMATION[cause]);
    }
  });
});
