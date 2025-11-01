/**
 * Test utilities for runtime worker tests
 *
 * Provides reusable test harness components for testing worker message handlers,
 * time-based simulations, and tick scheduling.
 */

import { vi } from 'vitest';

/**
 * Message handler type for worker event listeners
 */
type MessageHandler = (event: MessageEvent<unknown>) => void;

/**
 * Stub implementation of DedicatedWorkerGlobalScope for testing.
 *
 * Provides mocks for `postMessage`, `close`, and event listener management.
 * Use the `dispatch` method to simulate incoming messages from the main thread.
 *
 * @example
 * ```typescript
 * const context = new StubWorkerContext();
 * initializeRuntimeWorker({ context: context as unknown as DedicatedWorkerGlobalScope });
 * context.dispatch({ type: 'COMMAND', ... });
 * expect(context.postMessage).toHaveBeenCalledWith(...);
 * ```
 */
export class StubWorkerContext {
  public readonly postMessage = vi.fn<(data: unknown) => void>();
  public readonly close = vi.fn();

  private readonly listeners = new Set<MessageHandler>();

  addEventListener(
    type: string,
    handler: EventListenerOrEventListenerObject,
  ): void {
    if (type !== 'message') return;
    this.listeners.add(handler as MessageHandler);
  }

  removeEventListener(
    type: string,
    handler: EventListenerOrEventListenerObject,
  ): void {
    if (type !== 'message') return;
    this.listeners.delete(handler as MessageHandler);
  }

  /**
   * Dispatch a message to all registered listeners.
   * Simulates receiving a message from the main thread.
   */
  dispatch(data: unknown): void {
    for (const listener of this.listeners) {
      listener({ data } as MessageEvent<unknown>);
    }
  }

  /**
   * Get the number of listeners for a given event type.
   */
  listenerCount(type: string): number {
    if (type !== 'message') {
      return 0;
    }
    return this.listeners.size;
  }
}

/**
 * Flush the microtask queue.
 *
 * Useful for waiting for async operations to complete in tests.
 *
 * @example
 * ```typescript
 * context.dispatch(message);
 * await flushAsync();
 * expect(context.postMessage).toHaveBeenCalled();
 * ```
 */
export const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Time controller for deterministic tick-based tests.
 */
export interface TestTimeController {
  /** Current time in milliseconds */
  currentTime: number;
  /** Scheduled tick callback (null if no tick scheduled) */
  scheduledTick: (() => void) | null;
  /** Advance time by delta milliseconds */
  advanceTime: (delta: number) => void;
  /** Execute the scheduled tick (throws if no tick scheduled) */
  runTick: () => void;
  /** Factory for scheduleTick option (compatible with RuntimeWorkerOptions) */
  scheduleTick: (callback: () => void) => () => void;
  /** Get current time (compatible with RuntimeWorkerOptions.now) */
  now: () => number;
}

/**
 * Create a test time controller for deterministic tick simulation.
 *
 * Returns an object with time management utilities and factories compatible
 * with RuntimeWorkerOptions.
 *
 * @example
 * ```typescript
 * const timeController = createTestTimeController();
 * const harness = initializeRuntimeWorker({
 *   context: context as unknown as DedicatedWorkerGlobalScope,
 *   now: timeController.now,
 *   scheduleTick: timeController.scheduleTick,
 * });
 *
 * timeController.advanceTime(110);
 * timeController.runTick();
 * ```
 */
export function createTestTimeController(): TestTimeController {
  let currentTime = 0;
  let scheduledTick: (() => void) | null = null;

  return {
    get currentTime() {
      return currentTime;
    },
    set currentTime(value: number) {
      currentTime = value;
    },
    get scheduledTick() {
      return scheduledTick;
    },
    set scheduledTick(value: (() => void) | null) {
      scheduledTick = value;
    },
    advanceTime(delta: number) {
      currentTime += delta;
    },
    runTick() {
      if (!scheduledTick) {
        throw new Error('Tick loop is not scheduled');
      }
      scheduledTick();
    },
    scheduleTick(callback: () => void) {
      scheduledTick = callback;
      return () => {
        if (scheduledTick === callback) {
          scheduledTick = null;
        }
      };
    },
    now() {
      return currentTime;
    },
  };
}
