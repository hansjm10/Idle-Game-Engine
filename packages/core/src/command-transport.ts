import type { CommandPriority } from './command.js';
import type { JsonValue } from './command-queue.js';

export const DEFAULT_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
export const DEFAULT_PENDING_COMMAND_TIMEOUT_MS = 30 * 1000;

export type SerializedCommand = Readonly<{
  readonly type: string;
  readonly priority: CommandPriority;
  readonly timestamp: number;
  readonly step: number;
  readonly payload: JsonValue;
  readonly requestId?: string;
}>;

export type CommandResponseError = Readonly<{
  readonly code: string;
  readonly message: string;
  readonly details?: JsonValue;
}>;

export interface CommandEnvelope {
  readonly requestId: string;
  readonly clientId: string;
  readonly command: SerializedCommand;
  readonly sentAt: number;
}

export interface CommandResponse {
  readonly requestId: string;
  readonly status: 'accepted' | 'rejected' | 'duplicate';
  /** Server step when the command was enqueued (acknowledgment step). */
  readonly serverStep: number;
  readonly error?: CommandResponseError;
}
