/// <reference lib="webworker" />

import {
  CommandPriority,
  CommandQueue,
  CommandDispatcher,
  IdleEngineRuntime,
  type DiagnosticTimelineResult,
  type EventBus,
} from '@idle-engine/core';

export type {
  RuntimeEventSnapshot,
  RuntimeStatePayload,
} from './modules/runtime-worker-protocol.js';

import {
  WORKER_MESSAGE_SCHEMA_VERSION,
  CommandSource,
  type RuntimeWorkerInboundMessage,
  type RuntimeWorkerCommand,
  type RuntimeWorkerDiagnosticsUpdate,
  type RuntimeWorkerStateUpdate,
  type RuntimeWorkerReady,
  type RuntimeWorkerErrorDetails,
  type RuntimeWorkerError,
  type RuntimeStatePayload,
  type RuntimeEventSnapshot,
} from './modules/runtime-worker-protocol.js';

const RAF_INTERVAL_MS = 16;

export interface RuntimeWorkerOptions {
  readonly context?: DedicatedWorkerGlobalScope;
  readonly now?: () => number;
  readonly scheduleTick?: (callback: () => void) => () => void;
  readonly handshakeId?: string;
}

export interface RuntimeWorkerHarness {
  readonly runtime: IdleEngineRuntime;
  readonly handleMessage: (message: unknown) => void;
  readonly tick: () => void;
  readonly dispose: () => void;
}

export function initializeRuntimeWorker(
  options: RuntimeWorkerOptions = {},
): RuntimeWorkerHarness {
  const context =
    options.context ?? (self as DedicatedWorkerGlobalScope);
  const now = options.now ?? (() => performance.now());
  const scheduleTick =
    options.scheduleTick ??
    ((callback: () => void) => {
      const id = setInterval(callback, RAF_INTERVAL_MS);
      return () => clearInterval(id);
    });

  const commandQueue = new CommandQueue();
  const commandDispatcher = new CommandDispatcher();
  const runtime = new IdleEngineRuntime({
    commandQueue,
    commandDispatcher,
  });

  let diagnosticsEnabled = false;
  let diagnosticsHead: number | undefined;
  let diagnosticsConfiguration:
    | DiagnosticTimelineResult['configuration']
    | undefined;

  const postDiagnosticsUpdate = (result: DiagnosticTimelineResult) => {
    diagnosticsHead = result.head;
    diagnosticsConfiguration = result.configuration;

    const message: RuntimeWorkerDiagnosticsUpdate = {
      type: 'DIAGNOSTICS_UPDATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      diagnostics: result,
    };
    context.postMessage(message);
  };

  const emitDiagnosticsDelta = (force = false) => {
    if (!diagnosticsEnabled) {
      return;
    }

    const result = runtime.readDiagnosticsDelta(diagnosticsHead);
    const hasUpdates =
      force ||
      result.entries.length > 0 ||
      result.dropped > 0 ||
      diagnosticsConfiguration !== result.configuration;

    if (!hasUpdates) {
      return;
    }

    postDiagnosticsUpdate(result);
  };

  const monotonicClock = createMonotonicClock(now);

  let lastTimestamp = now();
  const tick = () => {
    const current = now();
    const delta = current - lastTimestamp;
    lastTimestamp = current;

    const before = runtime.getCurrentStep();
    runtime.tick(delta);
    const after = runtime.getCurrentStep();

    if (after > before) {
      const eventBus = runtime.getEventBus();
      const events = collectOutboundEvents(eventBus);
      const backPressure = eventBus.getBackPressureSnapshot();

      const message: RuntimeWorkerStateUpdate = {
        type: 'STATE_UPDATE',
        schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
        state: {
          currentStep: after,
          events,
          backPressure,
        },
      };
      context.postMessage(message);
      emitDiagnosticsDelta();
    }
  };

  let stopTick: () => void = () => {};

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null;

  let lastAcceptedCommandIssuedAt = Number.NEGATIVE_INFINITY;

  const postError = (details: RuntimeWorkerErrorDetails) => {
    console.warn('[runtime.worker] %s', details.message, {
      code: details.code,
      requestId: details.requestId,
      details: details.details,
    });
    const envelope: RuntimeWorkerError = {
      type: 'ERROR',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      error: details,
    };
    context.postMessage(envelope);
  };

  const isValidCommandSource = (value: unknown): value is CommandSource =>
    value === CommandSource.PLAYER ||
    value === CommandSource.AUTOMATION ||
    value === CommandSource.SYSTEM;

  const handleCommandMessage = (
    raw: Record<string, unknown>,
    requestId?: string,
  ) => {
    const source = raw.source;
    if (!isValidCommandSource(source)) {
      postError({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command source must be a known string identifier',
        requestId,
        details: { source },
      });
      return;
    }

    if (!('command' in raw) || !isRecord(raw.command)) {
      postError({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command envelope is missing the command payload',
        requestId,
        details: { command: raw.command },
      });
      return;
    }

    const command = raw.command as Record<string, unknown>;
    const type = command.type;
    if (typeof type !== 'string' || type.trim().length === 0) {
      postError({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command type must be a non-empty string',
        requestId,
        details: { type },
      });
      return;
    }

    if (!Object.prototype.hasOwnProperty.call(command, 'payload')) {
      postError({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command payload is required',
        requestId,
        details: { hasPayload: false },
      });
      return;
    }

    const issuedAt = command.issuedAt;
    if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) {
      postError({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command issuedAt must be a finite number',
        requestId,
        details: { issuedAt },
      });
      return;
    }

    if (issuedAt < lastAcceptedCommandIssuedAt) {
      console.warn('[runtime.worker] Dropping stale command', {
        type,
        issuedAt,
        lastAcceptedCommandIssuedAt,
        requestId,
      });
      postError({
        code: 'STALE_COMMAND',
        message: 'Command issuedAt is not monotonic',
        requestId,
        details: {
          issuedAt,
          lastAcceptedCommandIssuedAt,
        },
      });
      return;
    }

    lastAcceptedCommandIssuedAt = issuedAt;

    const commandMessage = raw as RuntimeWorkerCommand<unknown>;
    commandQueue.enqueue({
      type,
      payload: commandMessage.command.payload,
      priority: CommandPriority.PLAYER,
      timestamp: monotonicClock.now(),
      step: runtime.getNextExecutableStep(),
    });
  };

  const handleMessage = (message: unknown) => {
    if (!isRecord(message)) {
      return;
    }

    const type = message.type;
    const schemaVersion = message.schemaVersion;
    const requestId =
      typeof message.requestId === 'string' ? message.requestId : undefined;

    if (schemaVersion !== WORKER_MESSAGE_SCHEMA_VERSION) {
      postError({
        code: 'SCHEMA_VERSION_MISMATCH',
        message: 'Unsupported worker message schema version',
        requestId,
        details: {
          expected: WORKER_MESSAGE_SCHEMA_VERSION,
          received: schemaVersion,
          type,
        },
      });
      return;
    }

    if (type === 'COMMAND') {
      handleCommandMessage(message, requestId);
      return;
    }

    if (type === 'DIAGNOSTICS_SUBSCRIBE') {
      diagnosticsEnabled = true;
      diagnosticsHead = undefined;
      diagnosticsConfiguration = undefined;
      runtime.enableDiagnostics();
      emitDiagnosticsDelta(true);
      return;
    }

    if (type === 'TERMINATE') {
      stopTick();
      context.removeEventListener('message', messageListener);
      context.close();
      return;
    }

    postError({
      code: 'UNSUPPORTED_MESSAGE',
      message: 'Unsupported worker message type received',
      requestId,
      details: { type },
    });
  };

  const messageListener = (
    event: MessageEvent<RuntimeWorkerInboundMessage | unknown>,
  ) => {
    handleMessage(event.data);
  };

  context.addEventListener('message', messageListener);

  const readyMessage: RuntimeWorkerReady = {
    type: 'READY',
    schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    handshakeId: options.handshakeId,
  };
  context.postMessage(readyMessage);

  stopTick = scheduleTick(tick);

  const dispose = () => {
    stopTick();
    context.removeEventListener('message', messageListener);
  };

  return {
    runtime,
    handleMessage,
    tick,
    dispose,
  };
}

function createMonotonicClock(now: () => number) {
  let last = 0;
  return {
    now(): number {
      const raw = now();
      if (raw <= last) {
        last += 0.0001;
        return last;
      }
      last = raw;
      return raw;
    },
  };
}

if (!import.meta.vitest) {
  initializeRuntimeWorker();
}

function collectOutboundEvents(bus: EventBus): RuntimeEventSnapshot[] {
  const manifest = bus.getManifest();
  const events: RuntimeEventSnapshot[] = [];

  for (let channelIndex = 0; channelIndex < manifest.entries.length; channelIndex += 1) {
    const buffer = bus.getOutboundBuffer(channelIndex);
    for (let bufferIndex = 0; bufferIndex < buffer.length; bufferIndex += 1) {
      const record = buffer.at(bufferIndex);
      events.push({
        channel: channelIndex,
        type: record.type,
        tick: record.tick,
        issuedAt: record.issuedAt,
        dispatchOrder: record.dispatchOrder,
        payload: record.payload,
      });
    }
  }

  events.sort((left, right) => {
    if (left.tick !== right.tick) {
      return left.tick - right.tick;
    }
    return left.dispatchOrder - right.dispatchOrder;
  });

  return events;
}
