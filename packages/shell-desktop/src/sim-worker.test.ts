import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import type { SimWorkerInboundMessage, SimWorkerOutboundMessage } from './sim/worker-protocol.js';

type MessageHandler = ((message: unknown) => void) | undefined;

describe('shell-desktop sim worker', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('throws when started without parentPort', async () => {
    vi.doMock('node:worker_threads', () => ({ parentPort: null }));
    vi.doMock('./sim/sim-runtime.js', () => ({
      createSimRuntime: vi.fn(),
      loadSerializedSimRuntimeState: vi.fn(),
    }));

    await expect(import('./sim-worker.js')).rejects.toThrow(/requires parentPort/);
  }, 10_000);

  it('emits ready after init', async () => {
    const createSimRuntime = vi.fn(() => ({
      tick: vi.fn(),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 25),
      getNextStep: vi.fn(() => 7),
      getOfflineCatchupStatus: vi.fn(() => ({ busy: false, pendingSteps: 0 })),
      getCapabilities: vi.fn(() => ({
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: true,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
      })),
    }));

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'init', stepSizeMs: 25, maxStepsPerFrame: 99 });

    expect(createSimRuntime).toHaveBeenCalledWith({ stepSizeMs: 25, maxStepsPerFrame: 99 });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'ready',
      stepSizeMs: 25,
      nextStep: 7,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: true,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
      },
      offlineCatchup: { busy: false, pendingSteps: 0 },
    });
  });

  it('handles serialize and hydrate requests without crashing the worker', async () => {
    const hydratedFrame = {
      frame: {
        schemaVersion: 1,
        step: 12,
        simTimeMs: 240,
        contentHash: 'content:dev',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [],
      draws: [],
    };
    const runtime = {
      tick: vi.fn(),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 20),
      getNextStep: vi.fn(() => 5),
      getCapabilities: vi.fn(() => ({
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: true,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
      })),
      serialize: vi.fn(() => ({
        schemaVersion: 1,
        nextStep: 5,
        gameState: {
          runtime: { step: 5 },
          commandQueue: {
            schemaVersion: 1,
            entries: [],
          },
        },
        accumulatorBacklogMs: 0,
      })),
    };
    const restoredRuntime = {
      tick: vi.fn(),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 20),
      getNextStep: vi.fn(() => 12),
      getOfflineCatchupStatus: vi.fn(() => ({ busy: true, pendingSteps: 3 })),
      getCapabilities: vi.fn(() => ({
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: true,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
      })),
      serialize: vi.fn(),
      renderCurrentFrame: vi.fn(() => hydratedFrame),
    };
    const createSimRuntime = vi
      .fn()
      .mockReturnValueOnce(runtime)
      .mockReturnValueOnce(restoredRuntime);
    const loadSerializedSimRuntimeState = vi.fn((value: unknown) => value);

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({
      createSimRuntime,
      loadSerializedSimRuntimeState,
    }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'init', stepSizeMs: 20, maxStepsPerFrame: 30 });
    parentPort.postMessage.mockClear();

    messageHandler?.({ kind: 'serialize', requestId: 'serialize-1' });

    expect(runtime.serialize).toHaveBeenCalledTimes(1);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'serialized',
      requestId: 'serialize-1',
      state: {
        schemaVersion: 1,
        nextStep: 5,
        gameState: {
          runtime: { step: 5 },
          commandQueue: {
            schemaVersion: 1,
            entries: [],
          },
        },
        accumulatorBacklogMs: 0,
      },
    });

    parentPort.postMessage.mockClear();

    const savedState = {
      schemaVersion: 1,
      nextStep: 12,
      gameState: {
        runtime: { step: 12 },
        commandQueue: {
          schemaVersion: 1,
          entries: [
            {
              type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
              priority: 1,
              timestamp: 240,
              step: 12,
              payload: { resourceId: 'sample-pack.energy', amount: 2 },
            },
          ],
        },
      },
      accumulatorBacklogMs: 7,
    };
    messageHandler?.({ kind: 'hydrate', requestId: 'hydrate-1', state: savedState });

    expect(loadSerializedSimRuntimeState).toHaveBeenCalledWith(savedState);
    expect(createSimRuntime).toHaveBeenLastCalledWith({
      stepSizeMs: 20,
      maxStepsPerFrame: 30,
      initialSerializedState: savedState,
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'hydrated',
      requestId: 'hydrate-1',
      nextStep: 12,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: true,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
      },
      frame: hydratedFrame,
      offlineCatchup: { busy: true, pendingSteps: 3 },
    });
  });

  it('emits protocol errors for blank serialize and hydrate request ids', async () => {
    const runtime = {
      tick: vi.fn(),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 20),
      getNextStep: vi.fn(() => 5),
      getCapabilities: vi.fn(() => ({
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: true,
      })),
      serialize: vi.fn(() => ({ schemaVersion: 1, nextStep: 5, demoState: {} })),
    };
    const createSimRuntime = vi.fn(() => runtime);
    const loadSerializedSimRuntimeState = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({
      createSimRuntime,
      loadSerializedSimRuntimeState,
    }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'init', stepSizeMs: 20, maxStepsPerFrame: 30 });
    parentPort.postMessage.mockClear();

    messageHandler?.({ kind: 'serialize', requestId: '   ' });
    messageHandler?.({ kind: 'hydrate', requestId: '', state: {} });

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'error',
      error: 'protocol:serialize invalid requestId',
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'error',
      error: 'protocol:hydrate invalid requestId',
    });
    expect(loadSerializedSimRuntimeState).not.toHaveBeenCalled();
  });

  it('emits requestError when serialization is unsupported or throws', async () => {
    const runtime: {
      tick: ReturnType<typeof vi.fn>;
      enqueueCommands: ReturnType<typeof vi.fn>;
      getStepSizeMs: ReturnType<typeof vi.fn>;
      getNextStep: ReturnType<typeof vi.fn>;
      getCapabilities: ReturnType<typeof vi.fn>;
      serialize?: ReturnType<typeof vi.fn>;
    } = {
      tick: vi.fn(),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 20),
      getNextStep: vi.fn(() => 5),
      getCapabilities: vi.fn(() => ({
        canSerialize: false,
        canHydrate: true,
        supportsOfflineCatchup: true,
      })),
    };
    const createSimRuntime = vi.fn(() => runtime);
    const loadSerializedSimRuntimeState = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({
      createSimRuntime,
      loadSerializedSimRuntimeState,
    }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'init', stepSizeMs: 20, maxStepsPerFrame: 30 });
    parentPort.postMessage.mockClear();

    messageHandler?.({ kind: 'serialize', requestId: 'serialize-unsupported' });

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'requestError',
      requestId: 'serialize-unsupported',
      error: 'Simulation runtime does not support serialization.',
    });

    parentPort.postMessage.mockClear();
    runtime.serialize = vi.fn(() => {
      throw new Error('serialize failed');
    });

    messageHandler?.({ kind: 'serialize', requestId: 'serialize-throws' });

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'requestError',
      requestId: 'serialize-throws',
      error: 'serialize failed',
    });
  });

  it('emits requestError when hydration is unsupported or the save payload is invalid', async () => {
    const runtime = {
      tick: vi.fn(),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 20),
      getNextStep: vi.fn(() => 5),
      getCapabilities: vi
        .fn()
        .mockReturnValueOnce({
          canSerialize: false,
          canHydrate: true,
          supportsOfflineCatchup: true,
        })
        .mockReturnValueOnce({
          canSerialize: false,
          canHydrate: false,
          supportsOfflineCatchup: true,
        })
        .mockReturnValue({
          canSerialize: false,
          canHydrate: true,
          supportsOfflineCatchup: true,
        }),
    };
    const createSimRuntime = vi.fn(() => runtime);
    const loadSerializedSimRuntimeState = vi.fn(() => {
      throw new TypeError('invalid save');
    });

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({
      createSimRuntime,
      loadSerializedSimRuntimeState,
    }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'init', stepSizeMs: 20, maxStepsPerFrame: 30 });
    parentPort.postMessage.mockClear();

    messageHandler?.({ kind: 'hydrate', requestId: 'hydrate-unsupported', state: {} });

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'requestError',
      requestId: 'hydrate-unsupported',
      error: 'Simulation runtime does not support hydration.',
    });

    parentPort.postMessage.mockClear();

    messageHandler?.({ kind: 'hydrate', requestId: 'hydrate-invalid', state: {} });

    expect(loadSerializedSimRuntimeState).toHaveBeenCalledWith({});
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'requestError',
      requestId: 'hydrate-invalid',
      error: 'invalid save',
    });
  });

  it('emits error with protocol:init and stepSizeMs when stepSizeMs is missing', async () => {
    const createSimRuntime = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'init', maxStepsPerFrame: 10 } as unknown as SimWorkerInboundMessage);

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error' }),
    );
    const errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    const errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('stepSizeMs');
    expect(parentPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  it('emits error with protocol:init and maxStepsPerFrame when maxStepsPerFrame is missing', async () => {
    const createSimRuntime = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'init', stepSizeMs: 16 } as unknown as SimWorkerInboundMessage);

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error' }),
    );
    const errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    const errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('maxStepsPerFrame');
    expect(parentPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  it('emits error with protocol:init for non-finite stepSizeMs values (NaN, Infinity)', async () => {
    const createSimRuntime = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    // Test NaN
    messageHandler?.({ kind: 'init', stepSizeMs: Number.NaN, maxStepsPerFrame: 10 } as SimWorkerInboundMessage);

    let errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    let errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('stepSizeMs');

    parentPort.postMessage.mockClear();

    // Test Infinity
    messageHandler?.({ kind: 'init', stepSizeMs: Number.POSITIVE_INFINITY, maxStepsPerFrame: 10 } as SimWorkerInboundMessage);

    errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('stepSizeMs');

    expect(parentPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  it('emits error with protocol:init for non-finite maxStepsPerFrame values (NaN, Infinity)', async () => {
    const createSimRuntime = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    // Test NaN
    messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: Number.NaN } as SimWorkerInboundMessage);

    let errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    let errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('maxStepsPerFrame');

    parentPort.postMessage.mockClear();

    // Test Infinity
    messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: Number.POSITIVE_INFINITY } as SimWorkerInboundMessage);

    errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('maxStepsPerFrame');

    expect(parentPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  it('emits error with protocol:init for negative or zero stepSizeMs values', async () => {
    const createSimRuntime = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    // Test zero
    messageHandler?.({ kind: 'init', stepSizeMs: 0, maxStepsPerFrame: 10 } as SimWorkerInboundMessage);

    let errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    let errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('stepSizeMs');

    parentPort.postMessage.mockClear();

    // Test negative
    messageHandler?.({ kind: 'init', stepSizeMs: -16, maxStepsPerFrame: 10 } as SimWorkerInboundMessage);

    errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('stepSizeMs');

    expect(parentPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  it('emits error with protocol:init for stepSizeMs values between 0 and 1 (e.g., 0.5)', async () => {
    const createSimRuntime = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    // Test 0.5 (between 0 and 1)
    messageHandler?.({ kind: 'init', stepSizeMs: 0.5, maxStepsPerFrame: 10 } as SimWorkerInboundMessage);

    const errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    const errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('stepSizeMs');

    expect(parentPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  it('emits error with protocol:init for maxStepsPerFrame values between 0 and 1 (e.g., 0.5)', async () => {
    const createSimRuntime = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    // Test 0.5 (between 0 and 1)
    messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 0.5 } as SimWorkerInboundMessage);

    const errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    const errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('maxStepsPerFrame');

    expect(parentPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  it('emits error with protocol:init for negative or zero maxStepsPerFrame values', async () => {
    const createSimRuntime = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    // Test zero
    messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 0 } as SimWorkerInboundMessage);

    let errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    let errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('maxStepsPerFrame');

    parentPort.postMessage.mockClear();

    // Test negative
    messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: -5 } as SimWorkerInboundMessage);

    errorCall = parentPort.postMessage.mock.calls.find(
      (call) => (call[0] as SimWorkerOutboundMessage).kind === 'error',
    );
    expect(errorCall).toBeDefined();
    errorMessage = (errorCall?.[0] as { error?: string })?.error ?? '';
    expect(errorMessage).toContain('protocol:init');
    expect(errorMessage).toContain('maxStepsPerFrame');

    expect(parentPort.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'ready' }));
  });

  it('still produces frame output after invalid init and recovers with subsequent valid init', async () => {
    const runtime = {
      tick: vi.fn().mockReturnValueOnce({ frames: [{ id: 'frame-1' }], nextStep: 1 }),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 16),
      getNextStep: vi.fn(() => 0),
    };
    const createSimRuntime = vi.fn(() => runtime);

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    // Send an invalid init (missing stepSizeMs)
    messageHandler?.({ kind: 'init', maxStepsPerFrame: 10 } as unknown as SimWorkerInboundMessage);

    // Expect error for invalid init
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'error' }),
    );
    expect(parentPort.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ready' }),
    );

    parentPort.postMessage.mockClear();

    // Send a tick - should still produce frame using default runtime
    messageHandler?.({ kind: 'tick', deltaMs: 16 });

    // The tick should produce a frame (using ensureRuntime with defaults)
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'frame' }),
    );

    parentPort.postMessage.mockClear();

    // Now send a valid init - should emit ready and proceed normally
    messageHandler?.({ kind: 'init', stepSizeMs: 25, maxStepsPerFrame: 5 });

    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ready' }),
    );
  });

  it('ignores invalid messages', async () => {
    const createSimRuntime = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    messageHandler?.(null);
    messageHandler?.([]);
    messageHandler?.('nope');
    messageHandler?.({ kind: 'unknown' });
    messageHandler?.({ kind: 'tick', deltaMs: Number.NaN });

    expect(createSimRuntime).not.toHaveBeenCalled();
    expect(parentPort.postMessage).not.toHaveBeenCalled();
  });

  it('ticks and emits coalesced frames', async () => {
    const runtime = {
      tick: vi
        .fn()
        .mockReturnValueOnce({ frames: [{ id: 'frame-a' }], nextStep: 3 })
        .mockReturnValueOnce({ frames: [{ id: 'frame-b1' }, { id: 'frame-b2' }], nextStep: 4 }),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 16),
      getNextStep: vi.fn(() => 0),
    };
    const createSimRuntime = vi.fn(() => runtime);

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'tick', deltaMs: 5 });
    messageHandler?.({ kind: 'tick', deltaMs: 6 });

    expect(createSimRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.tick).toHaveBeenCalledWith(5);
    expect(runtime.tick).toHaveBeenCalledWith(6);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'frame',
      frame: { id: 'frame-a' },
      droppedFrames: 0,
      nextStep: 3,
    });
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'frame',
      frame: { id: 'frame-b2' },
      droppedFrames: 1,
      nextStep: 4,
    });
  });

  it('emits a frame message without a frame when the sim produces none', async () => {
    const runtime = {
      tick: vi.fn().mockReturnValueOnce({ frames: [], nextStep: 3 }),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 16),
      getNextStep: vi.fn(() => 0),
    };
    const createSimRuntime = vi.fn(() => runtime);

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'tick', deltaMs: 5 });

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'frame',
      droppedFrames: 0,
      nextStep: 3,
    });
  });

  it('drains offline catch-up without posting a live tick delta', async () => {
    const runtime = {
      tick: vi.fn(),
      drainOfflineCatchup: vi.fn().mockReturnValueOnce({
        frames: [],
        droppedFrames: 0,
        nextStep: 7,
        runtimeBacklog: { totalMs: 5, hostFrameMs: 0, creditedMs: 5 },
        offlineCatchup: { busy: false, pendingSteps: 0 },
      }),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 16),
      getNextStep: vi.fn(() => 0),
    };
    const createSimRuntime = vi.fn(() => runtime);

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'drainOfflineCatchup' });

    expect(runtime.tick).not.toHaveBeenCalled();
    expect(runtime.drainOfflineCatchup).toHaveBeenCalledTimes(1);
    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'frame',
      droppedFrames: 0,
      nextStep: 7,
      runtimeBacklog: { totalMs: 5, hostFrameMs: 0, creditedMs: 5 },
      offlineCatchup: { busy: false, pendingSteps: 0 },
    });
  });

  it('enqueues commands', async () => {
    const runtime = {
      tick: vi.fn(),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(),
      getNextStep: vi.fn(),
    };
    const createSimRuntime = vi.fn(() => runtime);

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    const commands = [{ type: 'test-command' }] as const;
    messageHandler?.({ kind: 'enqueueCommands', commands });

    expect(createSimRuntime).toHaveBeenCalledTimes(1);
    expect(runtime.enqueueCommands).toHaveBeenCalledWith(commands);
  });

  it('closes when asked to shutdown', async () => {
    const createSimRuntime = vi.fn();

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'shutdown' });

    expect(parentPort.close).toHaveBeenCalledTimes(1);
  });

  it('emits worker errors when handlers throw', async () => {
    const createSimRuntime = vi.fn(() => ({
      tick: vi
        .fn()
        .mockImplementationOnce(() => {
          throw new Error('boom');
        })
        .mockImplementationOnce(() => {
          throw 'kaboom';
        }),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(),
      getNextStep: vi.fn(),
    }));

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    messageHandler?.({ kind: 'tick', deltaMs: 1 });
    messageHandler?.({ kind: 'tick', deltaMs: 2 });

    expect(parentPort.postMessage).toHaveBeenCalledWith({ kind: 'error', error: 'boom' });
    expect(parentPort.postMessage).toHaveBeenCalledWith({ kind: 'error', error: 'kaboom' });
  });

  it('emits error when INPUT_EVENT with schemaVersion !== 1 is processed during tick', async () => {
    // Create a mock runtime that throws when tick is called after enqueuing
    // an INPUT_EVENT with invalid schemaVersion
    let enqueuedCommands: unknown[] = [];
    const runtime = {
      tick: vi.fn(() => {
        // Check if we have an enqueued INPUT_EVENT with schemaVersion !== 1
        // This simulates the behavior of the real runtime throwing on schemaVersion mismatch
        for (const cmd of enqueuedCommands) {
          const command = cmd as { type?: string; payload?: { schemaVersion?: number } };
          if (
            command.type === 'INPUT_EVENT' &&
            command.payload?.schemaVersion !== 1
          ) {
            throw new Error(
              `Unsupported InputEventCommandPayload schemaVersion: ${command.payload?.schemaVersion}`,
            );
          }
        }
        return { frames: [{ id: 'frame' }], nextStep: 1 };
      }),
      enqueueCommands: vi.fn((commands: unknown[]) => {
        enqueuedCommands = [...enqueuedCommands, ...commands];
      }),
      getStepSizeMs: vi.fn(() => 16),
      getNextStep: vi.fn(() => 0),
    };
    const createSimRuntime = vi.fn(() => runtime);

    let messageHandler: MessageHandler;
    const parentPort = {
      on: vi.fn((_event: string, handler: (message: unknown) => void) => {
        messageHandler = handler;
      }),
      postMessage: vi.fn(),
      close: vi.fn(),
    };

    vi.doMock('node:worker_threads', () => ({ parentPort }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime }));

    await import('./sim-worker.js');

    // Initialize the worker
    messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 10 });
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'ready' }),
    );
    parentPort.postMessage.mockClear();

    // Enqueue an INPUT_EVENT command with schemaVersion: 2 (invalid)
    messageHandler?.({
      kind: 'enqueueCommands',
      commands: [
        {
          type: 'INPUT_EVENT',
          priority: 1, // CommandPriority.PLAYER
          step: 0,
          timestamp: 0,
          payload: {
            schemaVersion: 2, // Invalid - should cause a throw
            event: {
              kind: 'pointer',
              intent: 'mouse-down',
              phase: 'start',
              x: 20,
              y: 20,
              button: 0,
              buttons: 1,
            },
          },
        },
      ],
    });

    // Tick to process the command - this should trigger the throw in the INPUT_EVENT handler
    messageHandler?.({ kind: 'tick', deltaMs: 16 });

    // The worker should emit an error with the schemaVersion mismatch message
    expect(parentPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'error',
        error: expect.stringContaining('schemaVersion'),
      }),
    );
  });
});
