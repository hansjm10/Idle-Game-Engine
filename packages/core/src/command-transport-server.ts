import type { Command } from './command.js';
import { CommandPriority } from './command.js';
import type { CommandExecutionOutcome, CommandError } from './command-dispatcher.js';
import type { CommandQueue, JsonValue } from './command-queue.js';
import {
  DEFAULT_IDEMPOTENCY_TTL_MS,
  type CommandEnvelope,
  type CommandResponse,
  type CommandResponseError,
  type SerializedCommand,
} from './command-transport.js';
import type { IdempotencyRegistry } from './idempotency-registry.js';
import { InMemoryIdempotencyRegistry } from './idempotency-registry.js';

const DEFAULT_MAX_IDENTIFIER_LENGTH = 128;

export interface CommandTransportServerOptions {
  readonly commandQueue: CommandQueue;
  readonly registry?: IdempotencyRegistry;
  readonly idempotencyTtlMs?: number;
  readonly getNextExecutableStep?: () => number;
  readonly drainCommandOutcomes?: () => CommandExecutionOutcome[];
  readonly now?: () => number;
  readonly maxIdentifierLength?: number;
}

export interface CommandTransportServer {
  handleEnvelope(envelope: CommandEnvelope): CommandResponse;
  drainOutcomeResponses(now?: number): CommandResponse[];
  purgeExpired(now?: number): void;
}

interface PendingKeyEntry {
  readonly key: string;
  readonly expiresAt: number;
}

interface ValidationResult<T> {
  readonly ok: true;
  readonly value: T;
}

interface ValidationFailure {
  readonly ok: false;
  readonly error: CommandResponseError;
}

type ValidationOutcome<T> = ValidationResult<T> | ValidationFailure;

export function createCommandTransportServer(
  options: CommandTransportServerOptions,
): CommandTransportServer {
  const registry = options.registry ?? new InMemoryIdempotencyRegistry();
  const idempotencyTtlMs = normalizeTtl(options.idempotencyTtlMs);
  const maxIdentifierLength = normalizeMaxIdentifierLength(
    options.maxIdentifierLength,
  );
  const now = options.now ?? Date.now;
  const pendingKeys = new Map<string, PendingKeyEntry>();

  const purgeExpired = (atTime: number): void => {
    registry.purgeExpired(atTime);
    for (const [requestId, entry] of pendingKeys.entries()) {
      if (entry.expiresAt <= atTime) {
        pendingKeys.delete(requestId);
      }
    }
  };

  const handleEnvelope = (envelope: CommandEnvelope): CommandResponse => {
    const atTime = now();
    purgeExpired(atTime);

    const responseRequestId =
      typeof envelope?.requestId === 'string' ? envelope.requestId : '';

    const requestIdResult = normalizeIdentifier(
      envelope?.requestId,
      maxIdentifierLength,
    );
    if (!requestIdResult.ok) {
      return createRejectedResponse(
        responseRequestId,
        resolveServerStep(undefined, options.getNextExecutableStep),
        requestIdResult.error,
      );
    }

    const clientIdResult = normalizeIdentifier(
      envelope?.clientId,
      maxIdentifierLength,
    );
    if (!clientIdResult.ok) {
      return createRejectedResponse(
        requestIdResult.value,
        resolveServerStep(undefined, options.getNextExecutableStep),
        clientIdResult.error,
      );
    }

    const key = `${clientIdResult.value}:${requestIdResult.value}`;
    const cached = registry.get(key);
    if (cached) {
      return toDuplicateResponse(cached);
    }

    const pending = pendingKeys.get(requestIdResult.value);
    if (pending && pending.key !== key) {
      const error = createResponseError(
        'REQUEST_ID_IN_USE',
        'Envelope requestId is already in use by another client.',
      );
      const response = createRejectedResponse(
        requestIdResult.value,
        resolveServerStep(undefined, options.getNextExecutableStep),
        error,
      );
      registry.record(
        key,
        response,
        atTime + idempotencyTtlMs,
      );
      return response;
    }

    if (!Number.isFinite(envelope?.sentAt)) {
      const error = createResponseError(
        'INVALID_SENT_AT',
        'Envelope sentAt must be a finite number.',
      );
      return recordRejectedResponse(
        registry,
        pendingKeys,
        key,
        requestIdResult.value,
        resolveServerStep(undefined, options.getNextExecutableStep),
        error,
        atTime,
        idempotencyTtlMs,
      );
    }

    const normalizedCommand = normalizeSerializedCommand(
      envelope?.command,
      requestIdResult.value,
      maxIdentifierLength,
    );
    if (!normalizedCommand.ok) {
      return recordRejectedResponse(
        registry,
        pendingKeys,
        key,
        requestIdResult.value,
        resolveServerStep(undefined, options.getNextExecutableStep),
        normalizedCommand.error,
        atTime,
        idempotencyTtlMs,
      );
    }

    const commandRequestId = normalizedCommand.value.requestId;
    if (
      commandRequestId !== undefined &&
      commandRequestId !== requestIdResult.value
    ) {
      const error = createResponseError(
        'REQUEST_ID_MISMATCH',
        'Command requestId does not match envelope requestId.',
        {
          commandRequestId,
          envelopeRequestId: requestIdResult.value,
        },
      );
      return recordRejectedResponse(
        registry,
        pendingKeys,
        key,
        requestIdResult.value,
        resolveServerStep(undefined, options.getNextExecutableStep),
        error,
        atTime,
        idempotencyTtlMs,
      );
    }

    const serverStep = resolveServerStep(
      normalizedCommand.value.step,
      options.getNextExecutableStep,
    );

    const command: Command = {
      type: normalizedCommand.value.type,
      priority: normalizedCommand.value.priority,
      timestamp: normalizedCommand.value.timestamp,
      step: serverStep,
      payload: normalizedCommand.value.payload,
      requestId: requestIdResult.value,
    };

    options.commandQueue.enqueue(command);

    const response = createAcceptedResponse(
      requestIdResult.value,
      serverStep,
    );

    registry.record(
      key,
      response,
      atTime + idempotencyTtlMs,
    );
    pendingKeys.set(requestIdResult.value, {
      key,
      expiresAt: atTime + idempotencyTtlMs,
    });

    return response;
  };

  const drainOutcomeResponses = (atTime = now()): CommandResponse[] => {
    purgeExpired(atTime);

    const outcomes = options.drainCommandOutcomes?.() ?? [];
    if (outcomes.length === 0) {
      return [];
    }

    const responses: CommandResponse[] = [];
    for (const outcome of outcomes) {
      const requestId = outcome.requestId;
      if (!requestId) {
        continue;
      }

      const pending = pendingKeys.get(requestId);
      if (!pending) {
        continue;
      }

      const response = outcome.success
        ? createAcceptedResponse(requestId, outcome.serverStep)
        : createRejectedResponse(
            requestId,
            outcome.serverStep,
            toResponseError(outcome.error),
          );

      registry.record(
        pending.key,
        response,
        atTime + idempotencyTtlMs,
      );
      pendingKeys.delete(requestId);
      responses.push(response);
    }

    return responses;
  };

  return {
    handleEnvelope,
    drainOutcomeResponses,
    purgeExpired: (atTime = now()) => {
      purgeExpired(atTime);
    },
  };
}

function normalizeTtl(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_IDEMPOTENCY_TTL_MS;
  }
  return Math.floor(value);
}

function normalizeMaxIdentifierLength(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_IDENTIFIER_LENGTH;
  }
  return Math.floor(value);
}

function normalizeIdentifier(
  value: unknown,
  maxLength: number,
): ValidationOutcome<string> {
  if (typeof value !== 'string') {
    return {
      ok: false,
      error: createResponseError(
        'INVALID_IDENTIFIER',
        'Identifier must be a string.',
      ),
    };
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return {
      ok: false,
      error: createResponseError(
        'INVALID_IDENTIFIER',
        'Identifier must be a non-empty string.',
      ),
    };
  }

  if (trimmed.length > maxLength) {
    return {
      ok: false,
      error: createResponseError(
        'IDENTIFIER_TOO_LONG',
        'Identifier exceeds the maximum length.',
        {
          maxLength,
          length: trimmed.length,
        },
      ),
    };
  }

  if (trimmed !== value) {
    return {
      ok: false,
      error: createResponseError(
        'INVALID_IDENTIFIER_FORMAT',
        'Identifier must not include leading or trailing whitespace.',
      ),
    };
  }

  return { ok: true, value };
}

function normalizeSerializedCommand(
  value: unknown,
  requestId: string,
  maxIdentifierLength: number,
): ValidationOutcome<SerializedCommand> {
  if (!value || typeof value !== 'object') {
    return {
      ok: false,
      error: createResponseError(
        'INVALID_COMMAND',
        'Command payload must be an object.',
      ),
    };
  }

  const record = value as Record<string, unknown>;

  const type = record.type;
  if (typeof type !== 'string' || type.trim().length === 0) {
    return {
      ok: false,
      error: createResponseError(
        'INVALID_COMMAND_TYPE',
        'Command type must be a non-empty string.',
      ),
    };
  }

  const priority = record.priority;
  if (!isValidCommandPriority(priority)) {
    const priorityDetail =
      typeof priority === 'number' && Number.isFinite(priority)
        ? priority
        : String(priority);
    return {
      ok: false,
      error: createResponseError(
        'INVALID_COMMAND_PRIORITY',
        'Command priority is invalid.',
        { priority: priorityDetail },
      ),
    };
  }

  const timestamp = record.timestamp;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return {
      ok: false,
      error: createResponseError(
        'INVALID_COMMAND_TIMESTAMP',
        'Command timestamp must be a finite number.',
      ),
    };
  }

  const step = record.step;
  if (
    typeof step !== 'number' ||
    !Number.isFinite(step) ||
    !Number.isInteger(step) ||
    step < 0
  ) {
    return {
      ok: false,
      error: createResponseError(
        'INVALID_COMMAND_STEP',
        'Command step must be a non-negative integer.',
      ),
    };
  }

  let payload: JsonValue;
  try {
    payload = cloneJsonValue(record.payload);
  } catch (error) {
    return {
      ok: false,
      error: createResponseError(
        'INVALID_COMMAND_PAYLOAD',
        error instanceof Error
          ? error.message
          : 'Command payload must be JSON-compatible.',
      ),
    };
  }

  const commandRequestId = record.requestId;
  if (commandRequestId !== undefined) {
    const normalized = normalizeIdentifier(
      commandRequestId,
      maxIdentifierLength,
    );
    if (!normalized.ok) {
      return {
        ok: false,
        error: createResponseError(
          'INVALID_COMMAND_REQUEST_ID',
          'Command requestId is invalid.',
        ),
      };
    }
  }

  return {
    ok: true,
    value: {
      type,
      priority: priority as CommandPriority,
      timestamp,
      step,
      payload,
      requestId: commandRequestId === undefined
        ? requestId
        : (commandRequestId as string),
    },
  };
}

function isValidCommandPriority(value: unknown): value is CommandPriority {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Object.values(CommandPriority).includes(value as CommandPriority)
  );
}

function resolveServerStep(
  fallbackStep: number | undefined,
  getNextExecutableStep?: () => number,
): number {
  if (getNextExecutableStep) {
    const step = getNextExecutableStep();
    if (
      typeof step === 'number' &&
      Number.isFinite(step) &&
      Number.isInteger(step) &&
      step >= 0
    ) {
      return step;
    }
  }

  if (
    typeof fallbackStep === 'number' &&
    Number.isFinite(fallbackStep) &&
    Number.isInteger(fallbackStep) &&
    fallbackStep >= 0
  ) {
    return fallbackStep;
  }

  return 0;
}

function createAcceptedResponse(
  requestId: string,
  serverStep: number,
): CommandResponse {
  return {
    requestId,
    status: 'accepted',
    serverStep,
  };
}

function createRejectedResponse(
  requestId: string,
  serverStep: number,
  error: CommandResponseError,
): CommandResponse {
  return {
    requestId,
    status: 'rejected',
    serverStep,
    error,
  };
}

function recordRejectedResponse(
  registry: IdempotencyRegistry,
  pendingKeys: Map<string, PendingKeyEntry>,
  key: string,
  requestId: string,
  serverStep: number,
  error: CommandResponseError,
  atTime: number,
  ttlMs: number,
): CommandResponse {
  const response = createRejectedResponse(requestId, serverStep, error);
  registry.record(key, response, atTime + ttlMs);
  pendingKeys.set(requestId, {
    key,
    expiresAt: atTime + ttlMs,
  });
  return response;
}

function toDuplicateResponse(cached: CommandResponse): CommandResponse {
  return {
    requestId: cached.requestId,
    status: 'duplicate',
    serverStep: cached.serverStep,
    ...(cached.error ? { error: cached.error } : {}),
  };
}

function createResponseError(
  code: string,
  message: string,
  details?: JsonValue,
): CommandResponseError {
  return {
    code,
    message,
    ...(details ? { details } : {}),
  };
}

function toResponseError(error: CommandError): CommandResponseError {
  let details: JsonValue | undefined;
  if (error.details !== undefined) {
    try {
      details = cloneJsonValue(error.details);
    } catch {
      details = undefined;
    }
  }
  return createResponseError(
    error.code,
    error.message,
    details,
  );
}

function cloneJsonValue(value: unknown): JsonValue {
  const seen = new WeakSet<object>();
  return cloneJsonValueInner(value, seen);
}

function cloneJsonValueInner(
  value: unknown,
  seen: WeakSet<object>,
): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error('Command payload contains non-finite number');
      }
      return value;
    case 'object':
      break;
    default:
      throw new Error(
        `Command payload contains unsupported JSON type: ${typeof value}`,
      );
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      throw new Error('Command payload contains a circular reference');
    }
    seen.add(value);
    const cloned = value.map((entry) => cloneJsonValueInner(entry, seen));
    seen.delete(value);
    return cloned;
  }

  if (seen.has(value as object)) {
    throw new Error('Command payload contains a circular reference');
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error('Command payload must be a plain JSON object');
  }

  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error('Command payload contains symbol keys');
  }

  seen.add(value as object);
  const record = value as Record<string, unknown>;
  const result: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (entry === undefined) {
      throw new Error('Command payload contains undefined value');
    }
    result[key] = cloneJsonValueInner(entry, seen);
  }
  seen.delete(value as object);
  return result;
}
