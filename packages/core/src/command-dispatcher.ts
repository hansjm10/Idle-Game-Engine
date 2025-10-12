import type { Command } from './command.js';
import type { CommandPriority } from './command.js';
import { authorizeCommand } from './command-authorization.js';
import { telemetry } from './telemetry.js';

export interface ExecutionContext {
  readonly step: number;
  readonly timestamp: number;
  readonly priority: CommandPriority;
}

export type CommandHandler<TPayload = unknown> = (
  payload: TPayload,
  context: ExecutionContext,
) => void | Promise<void>;

export class CommandDispatcher {
  private readonly handlers = new Map<string, CommandHandler>();

  register<TPayload>(type: string, handler: CommandHandler<TPayload>): void {
    this.handlers.set(type, handler as CommandHandler);
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
    const handler = this.handlers.get(command.type);
    if (!handler) {
      telemetry.recordError('UnknownCommandType', { type: command.type });
      return;
    }

    if (!authorizeCommand(command, { phase: 'live', reason: 'dispatcher' })) {
      return;
    }

    const context: ExecutionContext = {
      step: command.step,
      timestamp: command.timestamp,
      priority: command.priority,
    };

    try {
      const result = handler(command.payload, context);
      if (isPromiseLike(result)) {
        result.catch((error) => {
          telemetry.recordError('CommandExecutionFailed', {
            type: command.type,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      }
    } catch (error) {
      telemetry.recordError('CommandExecutionFailed', {
        type: command.type,
        error: error instanceof Error ? error.message : String(error),
      });
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
