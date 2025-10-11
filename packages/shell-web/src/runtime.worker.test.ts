import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandPriority, CommandQueue } from '@idle-engine/core';
import {
  initializeRuntimeWorker,
  type RuntimeWorkerHarness,
} from './runtime.worker';

type MessageHandler = (event: MessageEvent<unknown>) => void;

class StubWorkerContext {
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

  dispatch(data: unknown): void {
    for (const listener of this.listeners) {
      listener({ data } as MessageEvent<unknown>);
    }
  }
}

describe('runtime.worker integration', () => {
  let currentTime = 0;
  let scheduledTick: (() => void) | null = null;
  let context: StubWorkerContext;
  let harness: RuntimeWorkerHarness | null = null;

  const advanceTime = (delta: number) => {
    currentTime += delta;
  };

  const runTick = () => {
    if (!scheduledTick) {
      throw new Error('Tick loop is not scheduled');
    }
    scheduledTick();
  };

  beforeEach(() => {
    currentTime = 0;
    scheduledTick = null;
    context = new StubWorkerContext();

    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    harness?.dispose();
    harness = null;
  });

  it('stamps player commands with the runtime step and emits state updates', async () => {
    const enqueueSpy = vi.spyOn(CommandQueue.prototype, 'enqueue');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'debug').mockImplementation(() => {});

    const scheduleTick = (callback: () => void) => {
      scheduledTick = callback;
      return () => {
        if (scheduledTick === callback) {
          scheduledTick = null;
        }
      };
    };

    harness = initializeRuntimeWorker({
      context: context as unknown as DedicatedWorkerGlobalScope,
      now: () => currentTime,
      scheduleTick,
    });

    expect(scheduledTick).not.toBeNull();
    // First command should be stamped for step 0.
    context.dispatch({
      type: 'COMMAND',
      command: { type: 'TEST', payload: { iteration: 0 } },
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const firstQueued = enqueueSpy.mock.calls[0]![0] as {
      priority: CommandPriority;
      step: number;
      payload: unknown;
    };
    expect(firstQueued.priority).toBe(CommandPriority.PLAYER);
    expect(firstQueued.step).toBe(0);

    // Advance the runtime by one fixed step through the worker tick loop.
    advanceTime(110);
    runTick();

    expect(context.postMessage).toHaveBeenCalledWith({
      type: 'STATE_UPDATE',
      state: { currentStep: 1 },
    });

    // Subsequent commands are stamped with the next executable step (1).
    advanceTime(1);
    context.dispatch({
      type: 'COMMAND',
      command: { type: 'TEST', payload: { iteration: 1 } },
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    const secondQueued = enqueueSpy.mock.calls[1]![0] as {
      priority: CommandPriority;
      step: number;
    };
    expect(secondQueued.step).toBe(1);

    // Ensure worker cleanup requests clear the interval.
    context.dispatch({ type: 'TERMINATE' });
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(scheduledTick).toBeNull();
  });
});
