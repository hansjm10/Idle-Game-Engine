import './process-shim.js';
import type { RuntimeWorkerHarness } from '../runtime.worker.js';
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

export class InlineRuntimeWorker implements WorkerBridgeWorker {
  private readonly bridgeListeners = new Set<MessageListener>();
  private readonly workerListeners = new Set<MessageListener>();
  private readonly pendingMessages: unknown[] = [];
  private harness: RuntimeWorkerHarness | null = null;
  private disposed = false;

  constructor() {
    const context: InlineWorkerContext = {
      addEventListener: (type, listener) => {
        if (type !== 'message') {
          return;
        }
        this.workerListeners.add(listener);
        if (this.pendingMessages.length > 0) {
          const buffered = this.pendingMessages.splice(0, this.pendingMessages.length);
          for (const message of buffered) {
            this.postToWorkerListeners(message);
          }
        }
      },
      removeEventListener: (type, listener) => {
        if (type !== 'message') {
          return;
        }
        this.workerListeners.delete(listener);
      },
      postMessage: (message) => {
        if (this.disposed) {
          return;
        }
        this.postToBridgeListeners(message);
      },
      close: () => {
        this.disposeInternal();
      },
      fetch:
        typeof fetch === 'function'
          ? fetch.bind(globalThis)
          : undefined,
    };

    void import('../runtime.worker.js')
      .then(({ initializeRuntimeWorker }) => {
        if (this.disposed) {
          return;
        }
        this.harness = initializeRuntimeWorker({
          context: context as unknown as DedicatedWorkerGlobalScope,
          fetch: context.fetch,
        });
        if (this.pendingMessages.length > 0) {
          const buffered = this.pendingMessages.splice(0, this.pendingMessages.length);
          for (const message of buffered) {
            this.postToWorkerListeners(message);
          }
        }
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error('[InlineRuntimeWorker] Failed to initialize runtime worker', error);
      });
  }

  addEventListener(
    type: string,
    listener: MessageListener,
  ): void {
    if (type !== 'message') {
      return;
    }
    this.bridgeListeners.add(listener);
  }

  removeEventListener(
    type: string,
    listener: MessageListener,
  ): void {
    if (type !== 'message') {
      return;
    }
    this.bridgeListeners.delete(listener);
  }

  postMessage(message: unknown): void {
    if (this.disposed) {
      return;
    }
    if (this.workerListeners.size === 0 || this.harness === null) {
      this.pendingMessages.push(message);
      return;
    }
    this.postToWorkerListeners(message);
  }

  terminate(): void {
    this.disposeInternal();
  }

  private disposeInternal(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.bridgeListeners.clear();
    this.workerListeners.clear();
    this.pendingMessages.length = 0;
    this.harness?.dispose();
    this.harness = null;
  }

  private postToBridgeListeners(message: unknown): void {
    queueMicrotask(() => {
      for (const listener of this.bridgeListeners) {
        listener({ data: message } as MessageEvent<unknown>);
      }
    });
  }

  private postToWorkerListeners(message: unknown): void {
    queueMicrotask(() => {
      for (const listener of this.workerListeners) {
        listener({ data: message } as MessageEvent<unknown>);
      }
    });
  }
}

export function createInlineRuntimeWorker(): WorkerBridgeWorker {
  return new InlineRuntimeWorker();
}
