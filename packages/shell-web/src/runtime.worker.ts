/// <reference lib="webworker" />

import {
  CommandPriority,
  CommandQueue,
  CommandDispatcher,
  IdleEngineRuntime,
  type BackPressureSnapshot,
  type DiagnosticTimelineResult,
  type EventBus,
  type OfflineCatchUpResult,
} from '@idle-engine/core';

interface CommandMessage {
  readonly type: 'COMMAND';
  readonly command: {
    readonly type: string;
    readonly payload: unknown;
  };
}

interface TerminateMessage {
  readonly type: 'TERMINATE';
}

interface DiagnosticsSubscribeMessage {
  readonly type: 'DIAGNOSTICS_SUBSCRIBE';
}

interface VisibilityChangeMessage {
  readonly type: 'VISIBILITY_CHANGE';
  readonly visible: boolean;
}

interface OfflineCatchUpMessage {
  readonly type: 'OFFLINE_CATCH_UP';
  readonly elapsedMs: number;
}

type IncomingMessage =
  | CommandMessage
  | TerminateMessage
  | DiagnosticsSubscribeMessage
  | VisibilityChangeMessage
  | OfflineCatchUpMessage;

interface StateUpdateMessage {
  readonly type: 'STATE_UPDATE';
  readonly state: RuntimeStatePayload;
}

interface DiagnosticsUpdateMessage {
  readonly type: 'DIAGNOSTICS_UPDATE';
  readonly diagnostics: DiagnosticTimelineResult;
}

interface OfflineCatchUpResultPayload extends OfflineCatchUpResult {
  readonly remainingMs: number;
}

interface OfflineCatchUpResultMessage {
  readonly type: 'OFFLINE_CATCH_UP_RESULT';
  readonly result: OfflineCatchUpResultPayload;
}

const RAF_INTERVAL_MS = 16;

export interface RuntimeWorkerOptions {
  readonly context?: DedicatedWorkerGlobalScope;
  readonly now?: () => number;
  readonly scheduleTick?: (callback: () => void) => () => void;
}

export interface RuntimeWorkerHarness {
  readonly runtime: IdleEngineRuntime;
  readonly handleMessage: (message: IncomingMessage) => void;
  readonly setVisibility: (visible: boolean) => void;
  readonly requestOfflineCatchUp: (elapsedMs: number) => OfflineCatchUpResult;
  readonly tick: () => void;
  readonly dispose: () => void;
}

export interface RuntimeEventSnapshot {
  readonly channel: number;
  readonly type: string;
  readonly tick: number;
  readonly issuedAt: number;
  readonly dispatchOrder: number;
  readonly payload: unknown;
}

export interface RuntimeStatePayload {
  readonly currentStep: number;
  readonly events: readonly RuntimeEventSnapshot[];
  readonly backPressure: BackPressureSnapshot;
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

    const message: DiagnosticsUpdateMessage = {
      type: 'DIAGNOSTICS_UPDATE',
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

  const emitStateSnapshot = () => {
    const eventBus = runtime.getEventBus();
    const events = collectOutboundEvents(eventBus);
    const backPressure = eventBus.getBackPressureSnapshot();

    const message: StateUpdateMessage = {
      type: 'STATE_UPDATE',
      state: {
        currentStep: runtime.getCurrentStep(),
        events,
        backPressure,
      },
    };
    context.postMessage(message);
  };

  let lastTimestamp = now();

  const runOfflineCatchUpInternal = (
    elapsedMs: number,
    emitOutputs: boolean,
  ): OfflineCatchUpResult => {
    const normalizedElapsed = Math.max(0, elapsedMs ?? 0);
    const result = runtime.runOfflineCatchUp(normalizedElapsed);
    if (emitOutputs && result.executedSteps > 0) {
      emitStateSnapshot();
      emitDiagnosticsDelta(true);
    }
    return result;
  };

  const performOfflineCatchUp = (elapsedMs: number): OfflineCatchUpResult => {
    const result = runOfflineCatchUpInternal(elapsedMs, true);
    const currentTime = now();
    const remainingMs = Math.max(0, result.requestedMs - result.simulatedMs);
    const baselineTimestamp = currentTime - remainingMs;
    lastTimestamp = Number.isFinite(baselineTimestamp)
      ? baselineTimestamp
      : currentTime;
    const message: OfflineCatchUpResultMessage = {
      type: 'OFFLINE_CATCH_UP_RESULT',
      result: {
        ...result,
        remainingMs,
      },
    };
    context.postMessage(message);
    return result;
  };

  const setVisibility = (visible: boolean) => {
    runtime.setBackgroundThrottled(!visible);
  };

  const monotonicClock = createMonotonicClock(now);

  const tick = () => {
    const current = now();
    const delta = current - lastTimestamp;
    lastTimestamp = current;

    const before = runtime.getCurrentStep();
    runtime.tick(delta);
    const after = runtime.getCurrentStep();

    if (after > before) {
      emitStateSnapshot();
      emitDiagnosticsDelta();
    }
  };

  let stopTick: () => void = () => {};

  const handleMessage = (message: IncomingMessage) => {
    if (!message) {
      return;
    }

    if (message.type === 'COMMAND') {
      commandQueue.enqueue({
        ...message.command,
        priority: CommandPriority.PLAYER,
        timestamp: monotonicClock.now(),
        step: runtime.getNextExecutableStep(),
      });
      return;
    }

    if (message.type === 'DIAGNOSTICS_SUBSCRIBE') {
      diagnosticsEnabled = true;
      diagnosticsHead = undefined;
      diagnosticsConfiguration = undefined;
      runtime.enableDiagnostics();
      emitDiagnosticsDelta(true);
      return;
    }

    if (message.type === 'VISIBILITY_CHANGE') {
      setVisibility(message.visible);
      return;
    }

    if (message.type === 'OFFLINE_CATCH_UP') {
      performOfflineCatchUp(message.elapsedMs);
      return;
    }

    if (message.type === 'TERMINATE') {
      stopTick();
      context.removeEventListener('message', messageListener);
      context.close();
    }
  };

  const messageListener = (event: MessageEvent<IncomingMessage>) => {
    handleMessage(event.data);
  };

  context.addEventListener('message', messageListener);
  stopTick = scheduleTick(tick);

  const dispose = () => {
    stopTick();
    context.removeEventListener('message', messageListener);
  };

  return {
    runtime,
    handleMessage,
    setVisibility,
    requestOfflineCatchUp: performOfflineCatchUp,
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
