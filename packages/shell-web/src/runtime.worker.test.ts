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

    expect(context.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'STATE_UPDATE',
        state: expect.objectContaining({
          currentStep: 1,
          events: expect.any(Array),
          backPressure: expect.objectContaining({
            tick: expect.any(Number),
            counters: expect.objectContaining({
              published: expect.any(Number),
              softLimited: expect.any(Number),
              overflowed: expect.any(Number),
              subscribers: expect.any(Number),
            }),
            channels: expect.any(Array),
          }),
        }),
      }),
    );

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

  it('creates monotonic timestamps when the clock stalls', () => {
    const scheduleTick = (callback: () => void) => {
      scheduledTick = callback;
      return () => {
        if (scheduledTick === callback) {
          scheduledTick = null;
        }
      };
    };

    const fixedTime = 100;

    harness = initializeRuntimeWorker({
      context: context as unknown as DedicatedWorkerGlobalScope,
      now: () => fixedTime,
      scheduleTick,
    });

    harness.handleMessage({
      type: 'COMMAND',
      command: { type: 'A', payload: {} },
    });
    harness.handleMessage({
      type: 'COMMAND',
      command: { type: 'B', payload: {} },
    });

    const queue = harness.runtime.getCommandQueue();
    const commands = queue.dequeueAll();

    expect(commands).toHaveLength(2);
    expect(commands[0]!.timestamp).toBe(100);
    expect(commands[1]!.timestamp).toBeCloseTo(100.0001, 6);
  });

  it('gates diagnostics updates behind a subscription handshake', () => {
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

    // Advance once to generate a state update before diagnostics are enabled.
    advanceTime(110);
    runTick();
    const hasPreHandshakeDiagnostics = context.postMessage.mock.calls.some(
      ([payload]) => (payload as { type?: string } | undefined)?.type === 'DIAGNOSTICS_UPDATE',
    );
    expect(hasPreHandshakeDiagnostics).toBe(false);

    context.postMessage.mockClear();

    const enableSpy = vi.spyOn(harness.runtime, 'enableDiagnostics');
    context.dispatch({ type: 'DIAGNOSTICS_SUBSCRIBE' });
    expect(enableSpy).toHaveBeenCalledTimes(1);

    const baselineCall = context.postMessage.mock.calls.find(
      ([payload]) => (payload as { type?: string } | undefined)?.type === 'DIAGNOSTICS_UPDATE',
    );
    expect(baselineCall).toBeDefined();

    const baselineDiagnostics = (baselineCall![0] as {
      diagnostics: { head: number };
    }).diagnostics;

    context.postMessage.mockClear();

    advanceTime(120);
    runTick();

    const diagnosticsCall = context.postMessage.mock.calls.find(
      ([payload]) => (payload as { type?: string } | undefined)?.type === 'DIAGNOSTICS_UPDATE',
    );
    expect(diagnosticsCall).toBeDefined();
    const diagnosticsAfterTick = (diagnosticsCall![0] as {
      diagnostics: { head: number; entries: unknown[] };
    }).diagnostics;
    expect(diagnosticsAfterTick.head).toBeGreaterThanOrEqual(baselineDiagnostics.head);
    expect(Array.isArray(diagnosticsAfterTick.entries)).toBe(true);

    const stateUpdateCall = context.postMessage.mock.calls.find(
      ([payload]) => (payload as { type?: string } | undefined)?.type === 'STATE_UPDATE',
    );
    expect(stateUpdateCall).toBeDefined();
  });

  it('throttles ticks when visibility changes to hidden', () => {
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
    harness.setVisibility(false);

    advanceTime(500);
    const beforeBackground = harness.runtime.getCurrentStep();
    harness.tick();
    const afterBackground = harness.runtime.getCurrentStep();
    expect(afterBackground - beforeBackground).toBe(1);

    harness.setVisibility(true);
    advanceTime(500);
    const beforeForeground = harness.runtime.getCurrentStep();
    harness.tick();
    const afterForeground = harness.runtime.getCurrentStep();
    expect(afterForeground - beforeForeground).toBeGreaterThan(1);
  });

  it('runs offline catch-up and emits result summaries', () => {
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

    context.postMessage.mockClear();

    const elapsedMs = 450;
    context.dispatch({ type: 'OFFLINE_CATCH_UP', elapsedMs });

    const messages = context.postMessage.mock.calls.map((call) => call[0]);
    const stateUpdate = messages.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'STATE_UPDATE',
    ) as { state: { currentStep: number } } | undefined;
    const resultMessage = messages.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'OFFLINE_CATCH_UP_RESULT',
    ) as {
      result: { remainingMs: number; simulatedMs: number };
    } | undefined;

    expect(stateUpdate?.state.currentStep).toBeGreaterThan(0);
    expect(resultMessage).toBeDefined();
    expect(resultMessage?.result.remainingMs).toBe(50);
    expect(resultMessage?.result.simulatedMs).toBe(400);
    expect(harness.runtime.getCurrentStep()).toBe(4);
  });

  it('resets tick baseline after offline catch-up completes', () => {
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

    const runtimeTickSpy = vi.spyOn(harness.runtime, 'tick');
    context.postMessage.mockClear();

    const elapsedMs = 450;
    advanceTime(elapsedMs);
    context.dispatch({ type: 'OFFLINE_CATCH_UP', elapsedMs });

    const resultMessage = context.postMessage.mock.calls
      .map(([payload]) => payload)
      .find(
        (payload) =>
          typeof payload === 'object' &&
          payload !== null &&
          (payload as { type?: unknown }).type === 'OFFLINE_CATCH_UP_RESULT',
      ) as { result: { remainingMs: number } } | undefined;

    const remainingMs = resultMessage?.result.remainingMs ?? 0;

    runtimeTickSpy.mockClear();

    harness.tick();

    expect(runtimeTickSpy).toHaveBeenCalledTimes(1);
    expect(runtimeTickSpy.mock.calls[0]![0]).toBeCloseTo(remainingMs, 6);
  });
});
