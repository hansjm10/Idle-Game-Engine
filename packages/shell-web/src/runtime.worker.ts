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

const workerContext = self as DedicatedWorkerGlobalScope;

const commandQueue = new CommandQueue();
const commandDispatcher = new CommandDispatcher();
const runtime = new IdleEngineRuntime({
  commandQueue,
  commandDispatcher,
});

const monotonicClock = createMonotonicClock();

workerContext.addEventListener('message', (event: MessageEvent<IncomingMessage>) => {
  const { data } = event;
  if (!data) {
    return;
  }

  if (data.type === 'COMMAND') {
    commandQueue.enqueue({
      ...data.command,
      priority: CommandPriority.PLAYER,
      timestamp: monotonicClock.now(),
      step: runtime.getNextExecutableStep(),
    });
    return;
  }

  if (data.type === 'TERMINATE') {
    clearInterval(interval);
    workerContext.close();
  }
});

let lastTimestamp = performance.now();
const RAF_INTERVAL_MS = 16;

const tickLoop = () => {
  const now = performance.now();
  const delta = now - lastTimestamp;
  lastTimestamp = now;

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
    workerContext.postMessage(message);
  }
};

const interval = setInterval(tickLoop, RAF_INTERVAL_MS);

function createMonotonicClock() {
  let last = 0;
  return {
    now(): number {
      const raw = performance.now();
      if (raw <= last) {
        last += 0.0001;
        return last;
      }
      last = raw;
      return raw;
    },
  };
}

export {};
