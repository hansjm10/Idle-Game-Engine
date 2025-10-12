import type { Command, RuntimeCommandType } from './command.js';
import { COMMAND_AUTHORIZATIONS } from './command.js';
import { telemetry } from './telemetry.js';

const DEFAULT_UNAUTHORIZED_EVENT = 'CommandPriorityViolation';

export interface AuthorizationOptions {
  readonly phase?: 'live' | 'replay';
  readonly reason?: string;
}

function getAuthorizationPolicy(type: string) {
  return COMMAND_AUTHORIZATIONS[type as RuntimeCommandType];
}

export function authorizeCommand(
  command: Command,
  options: AuthorizationOptions = {},
): boolean {
  const policy = getAuthorizationPolicy(command.type);

  if (!policy) {
    return true;
  }

  if (policy.allowedPriorities.includes(command.priority)) {
    return true;
  }

  const event = policy.unauthorizedEvent ?? DEFAULT_UNAUTHORIZED_EVENT;

  const data: Record<string, unknown> = {
    type: command.type,
    attemptedPriority: command.priority,
    allowedPriorities: policy.allowedPriorities,
    phase: options.phase ?? 'live',
  };

  if (options.reason) {
    data.reason = options.reason;
  }

  telemetry.recordWarning(event, data);

  return false;
}

export { DEFAULT_UNAUTHORIZED_EVENT };
