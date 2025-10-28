import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as core from '@idle-engine/core';
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
    core.clearGameState();
    harness?.dispose();
    harness = null;
  });

  it('stamps player commands with the runtime step and emits state updates', async () => {
    const enqueueSpy = vi.spyOn(core.CommandQueue.prototype, 'enqueue');
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
    expect(firstQueued.priority).toBe(core.CommandPriority.PLAYER);
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
      priority: core.CommandPriority;
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

  it('disables diagnostics when unsubscribe message is received', () => {
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

    const enableSpy = vi.spyOn(harness.runtime, 'enableDiagnostics');

    context.dispatch({
      type: 'DIAGNOSTICS_SUBSCRIBE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });
    expect(enableSpy).toHaveBeenCalledTimes(1);
    expect(enableSpy.mock.calls.at(-1)).toEqual([]);

    context.dispatch({
      type: 'DIAGNOSTICS_UNSUBSCRIBE',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    expect(enableSpy).toHaveBeenCalledTimes(2);
    expect(enableSpy.mock.calls.at(-1)).toEqual([false]);
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

    const enqueueSpy = vi.spyOn(core.CommandQueue.prototype, 'enqueue');
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

  it('acknowledges session restore requests and validates payloads', () => {
    const scheduleTick = (callback: () => void) => {
      scheduledTick = callback;
      return () => {
        if (scheduledTick === callback) {
          scheduledTick = null;
        }
      };
    };

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const enqueueSpy = vi.spyOn(core.CommandQueue.prototype, 'enqueue');
    const setGameStateSpy = vi.spyOn(core, 'setGameState');
    const serializedState: core.SerializedResourceState = {
      ids: ['energy'],
      amounts: [5],
      capacities: [10],
      flags: [0],
    };

    harness = initializeRuntimeWorker({
      context: context as unknown as DedicatedWorkerGlobalScope,
      now: () => currentTime,
      scheduleTick,
    });

    context.postMessage.mockClear();

    context.dispatch({
      type: 'RESTORE_SESSION',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      elapsedMs: 1200,
      state: serializedState,
      resourceDeltas: { energy: 10 },
    });

    expect(setGameStateSpy).toHaveBeenCalledWith(serializedState);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    const offlineCommand = enqueueSpy.mock.calls[0]![0] as {
      type: string;
      payload: { elapsedMs: number; resourceDeltas: Record<string, number> };
      priority: core.CommandPriority;
    };
    expect(offlineCommand.type).toBe(
      core.RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
    );
    expect(offlineCommand.payload).toMatchObject({
      elapsedMs: 1200,
      resourceDeltas: { energy: 10 },
    });
    expect(offlineCommand.priority).toBe(core.CommandPriority.SYSTEM);

    const restoredEnvelope = context.postMessage.mock.calls.find(
      ([payload]) =>
        (payload as { type?: string } | undefined)?.type ===
        'SESSION_RESTORED',
    )?.[0];
    expect(restoredEnvelope).toMatchObject({
      type: 'SESSION_RESTORED',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
    });

    context.postMessage.mockClear();

    context.dispatch({
      type: 'RESTORE_SESSION',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      elapsedMs: -10,
    });

    const restoreError = context.postMessage.mock.calls.find(
      ([payload]) =>
        (payload as { type?: string } | undefined)?.type === 'ERROR',
    )?.[0] as RuntimeWorkerError | undefined;

    expect(restoreError).toBeDefined();
    expect(restoreError!.error).toMatchObject({
      code: 'RESTORE_FAILED',
    });
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(setGameStateSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects restore payloads with non-finite resource delta values', () => {
    const scheduleTick = (callback: () => void) => {
      scheduledTick = callback;
      return () => {
        if (scheduledTick === callback) {
          scheduledTick = null;
        }
      };
    };

    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const enqueueSpy = vi.spyOn(core.CommandQueue.prototype, 'enqueue');
    const setGameStateSpy = vi.spyOn(core, 'setGameState');

    harness = initializeRuntimeWorker({
      context: context as unknown as DedicatedWorkerGlobalScope,
      now: () => currentTime,
      scheduleTick,
    });

    context.postMessage.mockClear();

    context.dispatch({
      type: 'RESTORE_SESSION',
      schemaVersion: WORKER_MESSAGE_SCHEMA_VERSION,
      elapsedMs: 100,
      resourceDeltas: { energy: Number.POSITIVE_INFINITY },
    });

    const restoreError = context.postMessage.mock.calls.find(
      ([payload]) =>
        (payload as { type?: string } | undefined)?.type === 'ERROR',
    )?.[0] as RuntimeWorkerError | undefined;

    expect(restoreError).toBeDefined();
    expect(restoreError!.error).toMatchObject({
      code: 'RESTORE_FAILED',
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
    expect(setGameStateSpy).not.toHaveBeenCalled();
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

    const enqueueSpy = vi.spyOn(core.CommandQueue.prototype, 'enqueue');
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

    const enqueueSpy = vi.spyOn(core.CommandQueue.prototype, 'enqueue');
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
