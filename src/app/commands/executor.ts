/**
 * Shared, origin-neutral command executor (plan §3A.1).
 *
 * Validates the envelope (command + context), then dispatches through an
 * injected `ApplicationCommandPort`. No `NodeJS.ProcessEnv`, no exit codes.
 */
import { redactText } from '../../redaction/index.js';
import {
  APPLICATION_COMMAND_KINDS,
  COMMAND_ORIGINS,
  type ApplicationCommand,
  type ApplicationCommandKind,
  type ApplicationResult,
  type CommandContext,
  type CommandOrigin,
} from './types.js';

/** Port the CLI (and later HTTP) implement to drive domain handlers. */
export interface ApplicationCommandPort {
  execute(command: ApplicationCommand, context: CommandContext): Promise<ApplicationResult>;
}

/** Command + context envelope submitted to the shared executor. */
export interface ApplicationCommandEnvelope {
  readonly command: ApplicationCommand;
  readonly context: CommandContext;
}

/**
 * Validate the envelope, then dispatch to the port. Thrown errors become a
 * typed `{ status: 'failed', code: 'unhandled_error' }` result.
 */
export async function executeApplicationCommand(
  port: ApplicationCommandPort,
  envelope: ApplicationCommandEnvelope,
): Promise<ApplicationResult> {
  const contextError = validateContext(envelope.context);
  if (contextError !== undefined) {
    const kind =
      envelope.command !== null &&
      typeof envelope.command === 'object' &&
      'kind' in envelope.command &&
      typeof (envelope.command as { kind: unknown }).kind === 'string'
        ? String((envelope.command as { kind: string }).kind)
        : 'unknown';
    return {
      status: 'invalid',
      command: kind,
      error: {
        code: 'invalid_context',
        message: contextError,
        details: {},
      },
    };
  }

  const commandError = validateCommand(envelope.command);
  if (commandError !== undefined) {
    const kind =
      envelope.command !== null &&
      typeof envelope.command === 'object' &&
      'kind' in envelope.command &&
      typeof (envelope.command as { kind: unknown }).kind === 'string'
        ? String((envelope.command as { kind: string }).kind)
        : 'unknown';
    return {
      status: 'invalid',
      command: kind,
      error: {
        code: 'invalid_command',
        message: commandError,
        details: {},
      },
    };
  }

  try {
    return await port.execute(envelope.command, envelope.context);
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error));
    return {
      status: 'failed',
      command: envelope.command.kind,
      error: {
        code: 'unhandled_error',
        message,
        details: {},
      },
    };
  }
}

function validateContext(context: CommandContext): string | undefined {
  if (context === null || typeof context !== 'object') {
    return 'command context is required';
  }
  if (!(COMMAND_ORIGINS as readonly string[]).includes(context.origin as CommandOrigin)) {
    return `origin must be one of ${COMMAND_ORIGINS.join(', ')}`;
  }
  if (typeof context.actor !== 'string' || context.actor.trim() === '') {
    return 'actor must be a non-empty string';
  }
  if (typeof context.idempotencyKey !== 'string' || context.idempotencyKey.trim() === '') {
    return 'idempotencyKey must be a non-empty string';
  }
  return undefined;
}

function validateCommand(command: ApplicationCommand): string | undefined {
  if (command === null || typeof command !== 'object') {
    return 'command is required';
  }
  const kind = (command as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || !(APPLICATION_COMMAND_KINDS as readonly string[]).includes(kind)) {
    return `command.kind must be one of ${APPLICATION_COMMAND_KINDS.join(', ')}`;
  }

  switch (kind as ApplicationCommandKind) {
    case 'start': {
      const start = command as Extract<ApplicationCommand, { kind: 'start' }>;
      if (typeof start.workspace !== 'string' || start.workspace.trim() === '') {
        return 'start.workspace must be a non-empty string';
      }
      if (typeof start.goal !== 'string' || start.goal.trim() === '') {
        return 'start.goal must be a non-empty string';
      }
      if (
        start.coordinator === null ||
        typeof start.coordinator !== 'object' ||
        typeof start.coordinator.harness !== 'string' ||
        start.coordinator.harness.trim() === '' ||
        typeof start.coordinator.model !== 'string' ||
        start.coordinator.model.trim() === ''
      ) {
        return 'start.coordinator must include non-empty harness and model';
      }
      return undefined;
    }
    case 'reviseSpec': {
      const revise = command as Extract<ApplicationCommand, { kind: 'reviseSpec' }>;
      if (!nonEmpty(revise.runId)) return 'reviseSpec.runId is required';
      if (typeof revise.feedback !== 'string' || revise.feedback.trim() === '') {
        return 'reviseSpec.feedback must be a non-empty string';
      }
      return undefined;
    }
    case 'approve': {
      const approve = command as Extract<ApplicationCommand, { kind: 'approve' }>;
      if (!nonEmpty(approve.runId)) return 'approve.runId is required';
      if (!nonEmpty(approve.specVersionId)) return 'approve.specVersionId is required';
      return undefined;
    }
    case 'run':
    case 'recheck':
    case 'resume':
    case 'pause':
    case 'cancel':
    case 'breakerReset': {
      const scoped = command as { runId?: unknown };
      if (!nonEmpty(scoped.runId)) return `${kind}.runId is required`;
      return undefined;
    }
    case 'switchModel': {
      const switchModel = command as Extract<ApplicationCommand, { kind: 'switchModel' }>;
      if (!nonEmpty(switchModel.runId)) return 'switchModel.runId is required';
      if (typeof switchModel.role !== 'string' || switchModel.role.trim() === '') {
        return 'switchModel.role is required';
      }
      if (
        switchModel.target === null ||
        typeof switchModel.target !== 'object' ||
        typeof switchModel.target.harness !== 'string' ||
        switchModel.target.harness.trim() === '' ||
        typeof switchModel.target.model !== 'string' ||
        switchModel.target.model.trim() === ''
      ) {
        return 'switchModel.target must include non-empty harness and model';
      }
      return undefined;
    }
    case 'respondToPermission': {
      const respond = command as Extract<ApplicationCommand, { kind: 'respondToPermission' }>;
      if (!nonEmpty(respond.runId)) return 'respondToPermission.runId is required';
      if (!nonEmpty(respond.processGenerationId)) {
        return 'respondToPermission.processGenerationId is required';
      }
      if (!nonEmpty(respond.acpSessionId)) return 'respondToPermission.acpSessionId is required';
      if (typeof respond.requestId !== 'string' || respond.requestId.trim() === '') {
        return 'respondToPermission.requestId is required';
      }
      if (typeof respond.optionId !== 'string' || respond.optionId.trim() === '') {
        return 'respondToPermission.optionId is required';
      }
      if (respond.decision !== 'allow' && respond.decision !== 'deny') {
        return 'respondToPermission.decision must be allow or deny';
      }
      return undefined;
    }
    default: {
      const _exhaustive: never = kind as never;
      return `unsupported command kind: ${String(_exhaustive)}`;
    }
  }
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '';
}
