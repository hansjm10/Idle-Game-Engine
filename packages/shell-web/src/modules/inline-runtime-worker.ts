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
  private readonly pendingBridgeMessages: unknown[] = [];
  private harness: RuntimeWorkerHarness | null = null;
  private harnessInitialization: Promise<void> | null = null;
  private disposed = false;

  constructor() {
  }

  private postToBridgeListeners(message: unknown): void {
    if (this.bridgeListeners.size === 0) {
      this.pendingBridgeMessages.push(message);
      return;
    }

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

  private ensureHarness(): void {
    if (this.harness || this.harnessInitialization || this.disposed) {
      return;
    }

    const context: InlineWorkerContext = {
      addEventListener: (type, listener) => {
        if (type !== 'message') {
          return;
        }
        this.workerListeners.add(listener);
        if (this.pendingMessages.length > 0) {
          const buffered = this.pendingMessages.splice(
            0,
            this.pendingMessages.length,
          );
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

    this.harnessInitialization = import('../runtime.worker.js')
      .then(({ initializeRuntimeWorker }) => {
        if (this.disposed) {
          return;
        }

        try {
          this.harness = initializeRuntimeWorker({
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
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error(
          '[InlineRuntimeWorker] Failed to dynamically import runtime worker',
          error,
        );
      })
      .finally(() => {
        this.harnessInitialization = null;
      });
  }

  private disposeInternal(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.bridgeListeners.clear();
    this.workerListeners.clear();
    this.pendingMessages.length = 0;
    this.pendingBridgeMessages.length = 0;
    if (this.harness) {
      try {
        this.harness.dispose();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(
          '[InlineRuntimeWorker] Failed to dispose runtime harness',
          error,
        );
      } finally {
        this.harness = null;
      }
    }
  }

  addEventListener(
    type: string,
    listener: MessageListener,
  ): void {
    if (type !== 'message') {
      return;
    }
    this.bridgeListeners.add(listener);
    if (this.pendingBridgeMessages.length > 0) {
      const buffered = this.pendingBridgeMessages.splice(
        0,
        this.pendingBridgeMessages.length,
      );
      for (const message of buffered) {
        this.postToBridgeListeners(message);
      }
    }
    this.ensureHarness();
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
    this.ensureHarness();
    if (!this.harness || this.workerListeners.size === 0) {
      this.pendingMessages.push(message);
      return;
    }
    this.postToWorkerListeners(message);
  }

  terminate(): void {
    this.disposeInternal();
  }
}

export function createInlineRuntimeWorker(): WorkerBridgeWorker {
  return new InlineRuntimeWorker();
}
