import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CommandPriority, CommandQueue } from '@idle-engine/core';
import {
  initializeRuntimeWorker,
  type RuntimeWorkerHarness,
} from './runtime.worker';
import {
  CommandSource,
  WORKER_MESSAGE_SCHEMA_VERSION,
  type RuntimeWorkerError,
} from './modules/runtime-worker-protocol.js';

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
    vi.spyOn(console, 'warn').mockImplementation(() => {});
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

    const readyEnvelope = context.postMessage.mock.calls[0]?.[0] as {
      type?: string;
      schemaVersion?: number;
    } | null;

    expect(readyEnvelope).toMatchObject({
      type: 'READY',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    expect(scheduledTick).not.toBeNull();
    // First command should be stamped for step 0.
    context.dispatch({
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      requestId: 'test-0',
      command: {
        type: 'TEST',
        payload: { iteration: 0 },
        issuedAt: 1,
      },
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const firstQueued = enqueueSpy.mock.calls[0]![0]!;
    expect(firstQueued.priority).toBe(CommandPriority.PLAYER);
    expect(firstQueued.step).toBe(0);

    // Advance the runtime by one fixed step through the worker tick loop.
    advanceTime(110);
    runTick();

    const stateEnvelope = context.postMessage.mock.calls.find(
      ([payload]) =>
        (payload as { type?: string } | undefined)?.type === 'STATE_UPDATE',
    )?.[0] as {
      type: string;
      schemaVersion: number;
      state: { currentStep: number };
    } | null;

    expect(stateEnvelope).not.toBeNull();
    expect(stateEnvelope).toMatchObject({
      type: 'STATE_UPDATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      state: expect.objectContaining({
        currentStep: 1,
        events: expect.any(Array),
        backPressure: expect.any(Object),
      }),
    });

    // Subsequent commands are stamped with the next executable step (1).
    advanceTime(1);
    context.dispatch({
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      requestId: 'test-1',
      command: {
        type: 'TEST',
        payload: { iteration: 1 },
        issuedAt: 2,
      },
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(2);
    const secondQueued = enqueueSpy.mock.calls[1]![0] as {
      priority: CommandPriority;
      step: number;
    };
    expect(secondQueued.step).toBe(1);

    // Ensure worker cleanup requests clear the interval.
    context.dispatch({
      type: 'TERMINATE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });
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
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      requestId: 'stall-0',
      command: { type: 'A', payload: {}, issuedAt: 1 },
    });
    harness.handleMessage({
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      requestId: 'stall-1',
      command: { type: 'B', payload: {}, issuedAt: 2 },
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
    context.dispatch({
      type: 'DIAGNOSTICS_SUBSCRIBE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });
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

  it('emits structured errors when command payloads are invalid', () => {
    const scheduleTick = (callback: () => void) => {
      scheduledTick = callback;
      return () => {
        if (scheduledTick === callback) {
          scheduledTick = null;
        }
      };
    };

    const enqueueSpy = vi.spyOn(CommandQueue.prototype, 'enqueue');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    harness = initializeRuntimeWorker({
      context: context as unknown as DedicatedWorkerGlobalScope,
      now: () => currentTime,
      scheduleTick,
    });

    context.postMessage.mockClear();

    harness.handleMessage({
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      requestId: 'invalid-0',
      command: { type: '', payload: {}, issuedAt: 1 },
    });

    expect(enqueueSpy).not.toHaveBeenCalled();

    const errorEnvelope = context.postMessage.mock.calls.find(
      ([payload]) => (payload as { type?: string } | undefined)?.type === 'ERROR',
    )?.[0] as RuntimeWorkerError | undefined;

    expect(errorEnvelope).toBeDefined();
    expect(errorEnvelope).toMatchObject({
      type: 'ERROR',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      error: expect.objectContaining({
        code: 'INVALID_COMMAND_PAYLOAD',
        requestId: 'invalid-0',
      }),
    });
  });

  it('drops stale commands and reports replay errors', () => {
    const scheduleTick = (callback: () => void) => {
      scheduledTick = callback;
      return () => {
        if (scheduledTick === callback) {
          scheduledTick = null;
        }
      };
    };

    const enqueueSpy = vi.spyOn(CommandQueue.prototype, 'enqueue');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    harness = initializeRuntimeWorker({
      context: context as unknown as DedicatedWorkerGlobalScope,
      now: () => currentTime,
      scheduleTick,
    });

    context.postMessage.mockClear();

    harness.handleMessage({
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      requestId: 'stale-0',
      command: { type: 'PING', payload: {}, issuedAt: 10 },
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    context.postMessage.mockClear();

    harness.handleMessage({
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      source: CommandSource.PLAYER,
      requestId: 'stale-1',
      command: { type: 'PING', payload: {}, issuedAt: 5 },
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);

    const errorEnvelope = context.postMessage.mock.calls.find(
      ([payload]) => (payload as { type?: string } | undefined)?.type === 'ERROR',
    )?.[0] as RuntimeWorkerError | undefined;

    expect(errorEnvelope).toBeDefined();
    expect(errorEnvelope).toMatchObject({
      type: 'ERROR',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      error: expect.objectContaining({
        code: 'STALE_COMMAND',
        requestId: 'stale-1',
      }),
    });
  });

  it('rejects mismatched schema versions', () => {
    const scheduleTick = (callback: () => void) => {
      scheduledTick = callback;
      return () => {
        if (scheduledTick === callback) {
          scheduledTick = null;
        }
      };
    };

    const enqueueSpy = vi.spyOn(CommandQueue.prototype, 'enqueue');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    harness = initializeRuntimeWorker({
      context: context as unknown as DedicatedWorkerGlobalScope,
      now: () => currentTime,
      scheduleTick,
    });

    context.postMessage.mockClear();

    harness.handleMessage({
      type: 'COMMAND',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION + 1,
      source: CommandSource.PLAYER,
      requestId: 'schema-0',
      command: { type: 'PING', payload: {}, issuedAt: 1 },
    });

    expect(enqueueSpy).not.toHaveBeenCalled();

    const errorEnvelope = context.postMessage.mock.calls.find(
      ([payload]) => (payload as { type?: string } | undefined)?.type === 'ERROR',
    )?.[0] as RuntimeWorkerError | undefined;

    expect(errorEnvelope).toBeDefined();
    expect(errorEnvelope).toMatchObject({
      type: 'ERROR',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      error: expect.objectContaining({
        code: 'SCHEMA_VERSION_MISMATCH',
        requestId: 'schema-0',
      }),
    });
  });
});
