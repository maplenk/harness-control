/**
 * Type-level and runtime witnesses for the §3A.1 application-neutral command
 * vocabulary. Absence claims are proven positively (exit 0 on success).
 */
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_COMMAND_KINDS,
  APPLICATION_STATUSES,
  COMMAND_ORIGINS,
  type ApplicationCommand,
  type ApplicationCommandKind,
  type ApplicationError,
  type ApplicationResult,
} from './types.js';

/** Distributive key extraction — `keyof (A|B)` alone is the intersection. */
type ForbiddenKeys<T, K extends string> = T extends unknown ? Extract<keyof T, K> : never;
type HasNoKeys<T, K extends string> = [ForbiddenKeys<T, K>] extends [never] ? true : false;

/** No presentation/test/wait-policy fields on any ApplicationCommand member. */
export const NO_PRESENTATION_FIELDS: HasNoKeys<
  ApplicationCommand,
  'json' | 'text' | 'exitCode' | 'testApprove' | 'noWait' | 'wait'
> = true;

/** Context fields travel alongside the command, never inside it. */
export const NO_CONTEXT_FIELDS_IN_COMMAND: HasNoKeys<
  ApplicationCommand,
  'actor' | 'origin' | 'idempotencyKey' | 'context'
> = true;

/** ApplicationResult is not a process exit envelope. */
export const NO_PRESENTATION_IN_RESULT: HasNoKeys<ApplicationResult, 'json' | 'text' | 'exitCode'> =
  true;

/** ApplicationError is not a process exit envelope. */
export const NO_PRESENTATION_IN_ERROR: HasNoKeys<ApplicationError, 'json' | 'text' | 'exitCode'> =
  true;

/** Kind tuple and union are exactly the same set (both directions). */
export const KINDS_EXHAUSTIVE: [ApplicationCommand['kind']] extends [ApplicationCommandKind]
  ? [ApplicationCommandKind] extends [ApplicationCommand['kind']]
    ? true
    : false
  : false = true;

describe('ApplicationCommand vocabulary (§3A.1)', () => {
  it('enumerates exactly the 11 domain intents in plan order', () => {
    expect([...APPLICATION_COMMAND_KINDS]).toEqual([
      'start',
      'reviseSpec',
      'approve',
      'run',
      'recheck',
      'resume',
      'pause',
      'cancel',
      'breakerReset',
      'switchModel',
      'respondToPermission',
    ]);
  });

  it('enumerates the three command origins', () => {
    expect([...COMMAND_ORIGINS]).toEqual(['cli', 'http', 'system']);
  });

  it('enumerates the typed application statuses', () => {
    expect([...APPLICATION_STATUSES]).toEqual(
      expect.arrayContaining([
        'accepted',
        'rejected',
        'invalid',
        'conflict',
        'not_found',
        'failed',
        'blocked',
        'limit_paused',
      ]),
    );
    expect(APPLICATION_STATUSES).toHaveLength(8);
  });

  it('type witnesses prove no presentation fields on the neutral surface', () => {
    expect(NO_PRESENTATION_FIELDS).toBe(true);
    expect(NO_CONTEXT_FIELDS_IN_COMMAND).toBe(true);
    expect(NO_PRESENTATION_IN_RESULT).toBe(true);
    expect(NO_PRESENTATION_IN_ERROR).toBe(true);
    expect(KINDS_EXHAUSTIVE).toBe(true);
  });
});
