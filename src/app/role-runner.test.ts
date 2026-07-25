import { describe, expect, it } from 'vitest';
import type { PromptResult } from '../adapters/spi.js';
import type { AcpStopReason } from '../domain/entities.js';
import type { RoleName } from '../domain/state.js';
import {
  adjudicateRoleTurn,
  type AbortedTurnDisposition,
  type RoleTurnOrigin,
} from './role-runner.js';

const STOP_REASONS: readonly AcpStopReason[] = [
  'end_turn',
  'cancelled',
  'refusal',
  'max_tokens',
  'max_turn_requests',
];
const ROLES: readonly RoleName[] = [
  'coordinator',
  'implementor',
  'verifier',
];
const ORIGINS: readonly RoleTurnOrigin[] = ['fresh', 'resumed'];

const CASES = STOP_REASONS.flatMap((stopReason) =>
  ROLES.flatMap((role) =>
    ORIGINS.map((origin) => ({ stopReason, role, origin })),
  ),
);

function expectedDisposition(role: RoleName): AbortedTurnDisposition {
  if (role === 'coordinator') return 'retry';
  if (role === 'implementor') return 'no_deliverable';
  return 'void_verification';
}

describe('F13 AC-5 — stop reason × role × fresh/resumed matrix', () => {
  it.each(CASES)(
    '$stopReason × $role × $origin',
    ({ stopReason, role, origin }) => {
      const prompt: PromptResult = { stopReason };
      const turn = adjudicateRoleTurn(role, origin, prompt);

      expect(turn.origin).toBe(origin);
      expect(turn.stopReason).toBe(stopReason);
      if (stopReason === 'end_turn') {
        expect(turn).toMatchObject({
          kind: 'completed',
          stopReason: 'end_turn',
        });
      } else {
        expect(turn).toMatchObject({
          kind: 'aborted',
          stopReason,
          disposition: expectedDisposition(role),
        });
      }
    },
  );
});
