/**
 * Application-neutral command vocabulary (§3A.1 / Phase A0).
 *
 * Domain intents + envelope context + typed outcomes. Presentation and test
 * fields (`json` / `text` / `exitCode` / `testApprove` / `noWait` / `wait`) are
 * deliberately absent: the CLI and HTTP adapters own those, not this surface.
 */
import type {
  AcpSessionId,
  IdempotencyKey,
  ProcessGenerationId,
  RunId,
  SpecHash,
  SpecVersionId,
} from '../../domain/ids.js';
import type { RoleName } from '../../domain/state.js';
import type { ExecutionMode } from '../../domain/execution-mode.js';
import type { RoleModelSpec } from '../model-resolution.js';

// ---------------------------------------------------------------------------
// ApplicationCommand — domain intents only (plan §3A.1 bullet 1)
// ---------------------------------------------------------------------------

/** The closed set of domain command kinds the shared executor accepts. */
export const APPLICATION_COMMAND_KINDS = [
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
] as const;

export type ApplicationCommandKind = (typeof APPLICATION_COMMAND_KINDS)[number];

/**
 * Domain intents for the shared executor. No presentation (`json`/`text`/
 * `exitCode`), test (`testApprove`), or wait-policy (`noWait`/`wait`) fields —
 * those stay on the CLI options bag / HTTP adapter.
 */
export type ApplicationCommand =
  | {
      readonly kind: 'start';
      readonly workspace: string;
      readonly goal: string;
      readonly coordinator: RoleModelSpec;
      /** Operator-selected defaults persisted with the run and offered back at implementation time. */
      readonly implementor?: RoleModelSpec;
      readonly verifier?: RoleModelSpec;
      readonly executionMode?: ExecutionMode;
      readonly configPath?: string;
      /** Opt-in Agent Room discussion before final spec synthesis (domain intent, not presentation). */
      readonly enableChat?: boolean;
    }
  | {
      readonly kind: 'reviseSpec';
      readonly runId: RunId;
      readonly feedback: string;
    }
  | {
      readonly kind: 'approve';
      readonly runId: RunId;
      readonly specVersionId: SpecVersionId;
      readonly specHash?: SpecHash;
    }
  | {
      readonly kind: 'run';
      readonly runId: RunId;
      readonly implementor?: RoleModelSpec;
      readonly verifier?: RoleModelSpec;
      readonly inPlace?: boolean;
    }
  | { readonly kind: 'recheck'; readonly runId: RunId }
  | { readonly kind: 'resume'; readonly runId: RunId }
  | { readonly kind: 'pause'; readonly runId: RunId }
  | { readonly kind: 'cancel'; readonly runId: RunId }
  | { readonly kind: 'breakerReset'; readonly runId: RunId }
  | {
      readonly kind: 'switchModel';
      readonly runId: RunId;
      readonly role: RoleName;
      readonly target: RoleModelSpec;
    }
  | {
      readonly kind: 'respondToPermission';
      readonly runId: RunId;
      readonly processGenerationId: ProcessGenerationId;
      readonly acpSessionId: AcpSessionId;
      readonly requestId: string;
      readonly optionId: string;
      readonly decision: 'allow' | 'deny';
    };

// ---------------------------------------------------------------------------
// CommandContext — carried ALONGSIDE the command (plan §3A.1 bullet 2)
// ---------------------------------------------------------------------------

export const COMMAND_ORIGINS = ['cli', 'http', 'system'] as const;
export type CommandOrigin = (typeof COMMAND_ORIGINS)[number];

/**
 * Who submitted the command, from where, under which idempotency key.
 * Lives next to the command in the envelope — never inside ApplicationCommand.
 */
export interface CommandContext {
  readonly actor: string;
  readonly origin: CommandOrigin;
  readonly idempotencyKey: IdempotencyKey;
}

// ---------------------------------------------------------------------------
// ApplicationResult / ApplicationError — typed outcomes (plan §3A.1 bullet 3)
// ---------------------------------------------------------------------------

/**
 * Discriminated outcome statuses. The CLI maps these to exit codes; HTTP will
 * map them to status codes. Never a process exit code on this surface.
 */
export const APPLICATION_STATUSES = [
  'accepted',
  'rejected',
  'invalid',
  'conflict',
  'not_found',
  'failed',
  'blocked',
  'limit_paused',
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/** Domain payload carried by an accepted result (HTTP body shape). */
export interface CommandPayload {
  readonly data: Readonly<Record<string, unknown>>;
  readonly summary: string;
}

/** Typed error carried by a non-accepted result. */
export interface ApplicationError {
  readonly code: string;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

/**
 * Discriminated result: either accepted with a payload, or a non-accepted
 * status with a structured error. No `json` / `text` / `exitCode` keys.
 */
export type ApplicationResult<T = CommandPayload> =
  | { readonly status: 'accepted'; readonly command: string; readonly payload: T }
  | {
      readonly status: Exclude<ApplicationStatus, 'accepted'>;
      readonly command: string;
      readonly error: ApplicationError;
    };
