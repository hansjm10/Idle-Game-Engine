import type { Command } from './command.js';
import type { CommandPriority } from './command.js';
import { telemetry } from './telemetry.js';

export interface ExecutionContext {
  readonly step: number;
  readonly timestamp: number;
  readonly priority: CommandPriority;
}

export type CommandHandler<TPayload = unknown> = (
  payload: TPayload,
  context: ExecutionContext,
) => void;

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

    const context: ExecutionContext = {
      step: command.step,
      timestamp: command.timestamp,
      priority: command.priority,
    };

    try {
      handler(command.payload, context);
    } catch (error) {
      telemetry.recordError('CommandExecutionFailed', {
        type: command.type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
