import type { EventPublisher } from './events/event-bus.js';
import type { Command } from './command.js';
import type { CommandPriority } from './command.js';
import { authorizeCommand } from './command-authorization.js';
import { telemetry } from './telemetry.js';

export interface CommandError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface CommandResultSuccess {
  readonly success: true;
}

export interface CommandResultFailure {
  readonly success: false;
  readonly error: CommandError;
}

export type CommandResult = CommandResultSuccess | CommandResultFailure;

export interface CommandFailure {
  readonly requestId?: string;
  readonly type: string;
  readonly priority: CommandPriority;
  readonly timestamp: number;
  readonly step: number;
  readonly error: CommandError;
}

export type CommandExecutionOutcome =
  | Readonly<{
      readonly success: true;
      readonly requestId?: string;
      readonly serverStep: number;
    }>
  | Readonly<{
      readonly success: false;
      readonly requestId?: string;
      readonly serverStep: number;
      readonly error: CommandError;
    }>;

export interface ExecutionContext {
  readonly step: number;
  readonly timestamp: number;
  readonly priority: CommandPriority;
  readonly events: EventPublisher;
}

export type CommandHandlerResult =
  | void
  | CommandResult
  | Promise<void | CommandResult>;

export type CommandHandler<TPayload = unknown> = (
  payload: TPayload,
  context: ExecutionContext,
) => CommandHandlerResult;

export class CommandDispatcher {
  private readonly handlers = new Map<string, CommandHandler>();
  private eventPublisher: EventPublisher = DEFAULT_EVENT_PUBLISHER;

  register<TPayload>(type: string, handler: CommandHandler<TPayload>): void {
    this.handlers.set(type, handler as CommandHandler);
  }

  setEventPublisher(publisher: EventPublisher): void {
    this.eventPublisher = publisher;
  }

  getHandler(type: string): CommandHandler | undefined {
    return this.handlers.get(type);
  }

  forEachHandler(
    callback: (type: string, handler: CommandHandler) => void,
  ): void {
    for (const [type, handler] of this.handlers.entries()) {
      callback(type, handler);
    }
  }

  execute(command: Command): void {
    void this.executeWithResult(command);
  }

  executeWithResult(command: Command): CommandResult | Promise<CommandResult> {
    const handler = this.handlers.get(command.type);
    if (!handler) {
      telemetry.recordError('UnknownCommandType', { type: command.type });
      return createCommandFailure('UNKNOWN_COMMAND_TYPE', 'Unknown command type.', {
        type: command.type,
      });
    }

    if (!authorizeCommand(command, { phase: 'live', reason: 'dispatcher' })) {
      return createCommandFailure(
        'COMMAND_UNAUTHORIZED',
        'Command priority is not authorized for this command.',
        {
          type: command.type,
          priority: command.priority,
        },
      );
    }

    const context: ExecutionContext = {
      step: command.step,
      timestamp: command.timestamp,
      priority: command.priority,
      events: this.eventPublisher,
    };

    try {
      const result = handler(command.payload, context);
      if (isPromiseLike(result)) {
        return Promise.resolve(result).then(
          (resolved) => {
            if (isCommandResult(resolved)) {
              return normalizeCommandResult(resolved);
            }

            return COMMAND_SUCCESS_RESULT;
          },
          (error) => {
            telemetry.recordError('CommandExecutionFailed', {
              type: command.type,
              error: error instanceof Error ? error.message : String(error),
            });

            return createCommandFailure(
              'COMMAND_EXECUTION_FAILED',
              'Command execution failed.',
              {
                type: command.type,
                error: error instanceof Error ? error.message : String(error),
              },
            );
          },
        );
      }

      if (isCommandResult(result)) {
        return normalizeCommandResult(result);
      }

      return COMMAND_SUCCESS_RESULT;
    } catch (error) {
      telemetry.recordError('CommandExecutionFailed', {
        type: command.type,
        error: error instanceof Error ? error.message : String(error),
      });

      return createCommandFailure(
        'COMMAND_EXECUTION_FAILED',
        'Command execution failed.',
        {
          type: command.type,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === 'function'
  );
}

function isCommandResult(value: unknown): value is CommandResult {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  if (!('success' in value)) {
    return false;
  }

  return typeof (value as { success?: unknown }).success === 'boolean';
}

function normalizeCommandResult(value: CommandResult): CommandResult {
  if (value.success) {
    return COMMAND_SUCCESS_RESULT;
  }

  const error = value.error;
  if (
    typeof error?.code !== 'string' ||
    error.code.trim().length === 0 ||
    typeof error.message !== 'string'
  ) {
    return createCommandFailure(
      'COMMAND_RESULT_INVALID',
      'Command handler returned an invalid failure result.',
    );
  }

  return value;
}

function createCommandFailure(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): CommandResultFailure {
  if (details) {
    return {
      success: false,
      error: {
        code,
        message,
        details,
      },
    };
  }

  return {
    success: false,
    error: {
      code,
      message,
    },
  };
}

const DEFAULT_EVENT_PUBLISHER: EventPublisher = {
  publish() {
    throw new Error('Event publisher has not been configured on this CommandDispatcher instance.');
  },
};

const COMMAND_SUCCESS_RESULT: CommandResultSuccess = { success: true };
