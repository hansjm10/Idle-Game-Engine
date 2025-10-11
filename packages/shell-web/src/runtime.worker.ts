/// <reference lib="webworker" />

import {
  CommandPriority,
  CommandQueue,
  CommandDispatcher,
  IdleEngineRuntime,
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

type IncomingMessage = CommandMessage | TerminateMessage;

interface StateUpdateMessage {
  readonly type: 'STATE_UPDATE';
  readonly state: {
    readonly currentStep: number;
  };
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
      const message: StateUpdateMessage = {
        type: 'STATE_UPDATE',
        state: {
          currentStep: after,
        },
      };
      context.postMessage(message);
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
