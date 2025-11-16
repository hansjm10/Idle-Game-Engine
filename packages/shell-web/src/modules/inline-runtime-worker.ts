import './process-shim.js';
import {
  initializeRuntimeWorker,
  type RuntimeWorkerHarness,
} from '../runtime.worker.js';
import type { WorkerBridgeWorker } from './worker-bridge-worker.js';

type MessageListener = (event: MessageEvent<unknown>) => void;

interface InlineWorkerContext {
  addEventListener: (
    type: string,
    listener: MessageListener,
  ) => void;
  removeEventListener: (
    type: string,
    listener: MessageListener,
  ) => void;
  postMessage: (message: unknown) => void;
  close: () => void;
  fetch?: typeof fetch;
}

const bridgeListeners = new Set<MessageListener>();
const workerListeners = new Set<MessageListener>();
const pendingMessages: unknown[] = [];
let sharedHarness: RuntimeWorkerHarness | null = null;

function disposeInlineRuntimeHarness(): void {
  if (sharedHarness) {
    try {
      sharedHarness.dispose();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(
        '[InlineRuntimeWorker] Failed to dispose runtime harness',
        error,
      );
    } finally {
      sharedHarness = null;
    }
  }

  bridgeListeners.clear();
  workerListeners.clear();
  pendingMessages.length = 0;
}

function postToBridgeListeners(message: unknown): void {
  queueMicrotask(() => {
    for (const listener of bridgeListeners) {
      listener({ data: message } as MessageEvent<unknown>);
    }
  });
}

function postToWorkerListeners(message: unknown): void {
  queueMicrotask(() => {
    for (const listener of workerListeners) {
      listener({ data: message } as MessageEvent<unknown>);
    }
  });
}

function ensureHarness(): void {
  if (sharedHarness) {
    return;
  }

  const context: InlineWorkerContext = {
    addEventListener: (type, listener) => {
      if (type !== 'message') {
        return;
      }
      workerListeners.add(listener);
      if (pendingMessages.length > 0) {
        const buffered = pendingMessages.splice(
          0,
          pendingMessages.length,
        );
        for (const message of buffered) {
          postToWorkerListeners(message);
        }
      }
    },
    removeEventListener: (type, listener) => {
      if (type !== 'message') {
        return;
      }
      workerListeners.delete(listener);
    },
    postMessage: (message) => {
      postToBridgeListeners(message);
    },
    close: () => {
      // Inline harness stays alive for the lifetime of the page; no-op.
    },
    fetch:
      typeof fetch === 'function'
        ? fetch.bind(globalThis)
        : undefined,
  };

  try {
    sharedHarness = initializeRuntimeWorker({
      context: context as unknown as DedicatedWorkerGlobalScope,
      fetch: context.fetch,
      scheduleTick: (callback) => {
        // Ensure at least one tick runs immediately in inline mode so the
        // shell receives an initial progression snapshot even if timers are
        // throttled in dev tools or test environments.
        callback();
        const id = setInterval(callback, 16);
        return () => clearInterval(id);
      },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      '[InlineRuntimeWorker] Failed to initialize runtime worker',
      error,
    );
  }
}

export class InlineRuntimeWorker implements WorkerBridgeWorker {
  constructor() {
  }

  addEventListener(
    type: string,
    listener: MessageListener,
  ): void {
    if (type !== 'message') {
      return;
    }
    ensureHarness();
    bridgeListeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: MessageListener,
  ): void {
    if (type !== 'message') {
      return;
    }
    bridgeListeners.delete(listener);
  }

  postMessage(message: unknown): void {
    ensureHarness();
    if (!sharedHarness || workerListeners.size === 0) {
      pendingMessages.push(message);
      return;
    }
    postToWorkerListeners(message);
  }

  terminate(): void {
    disposeInlineRuntimeHarness();
  }
}

export function createInlineRuntimeWorker(): WorkerBridgeWorker {
  return new InlineRuntimeWorker();
}
