import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SimWorkerInboundMessage, SimWorkerOutboundMessage } from './sim/worker-protocol.js';

type MessageHandler = ((message: unknown) => void) | undefined;

const flushMicrotasks = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('shell-desktop sim worker', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('throws when started without parentPort', async () => {
    vi.doMock('node:worker_threads', () => ({ parentPort: null }));
    vi.doMock('./sim/sim-runtime.js', () => ({ createSimRuntime: vi.fn() }));

    await expect(import('./sim-worker.js')).rejects.toThrow(/requires parentPort/);
  });

  it('emits protocol v2 ready after init with capabilities derived from runtime', async () => {
    const createSimRuntime = vi.fn(() => ({
      tick: vi.fn(),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 25),
      getNextStep: vi.fn(() => 7),
      hasCommandHandler: vi.fn(() => false),
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
      protocolVersion: 2,
      stepSizeMs: 25,
      nextStep: 7,
      capabilities: {
        canSerialize: false,
        canOfflineCatchup: false,
      },
    });
  });

  it('emits ready with canSerialize true when runtime has serialize and hydrate', async () => {
    const createSimRuntime = vi.fn(() => ({
      tick: vi.fn(),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 16),
      getNextStep: vi.fn(() => 0),
      hasCommandHandler: vi.fn((type: string) => type === 'OFFLINE_CATCHUP'),
      serialize: vi.fn(),
      hydrate: vi.fn(),
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

    messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 10 });

    expect(parentPort.postMessage).toHaveBeenCalledWith({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: {
        canSerialize: true,
        canOfflineCatchup: true,
      },
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
      hasCommandHandler: vi.fn(() => false),
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
      hasCommandHandler: vi.fn(() => false),
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

  describe('serialize handler', () => {
    it('returns saveData success with non-empty bytes when runtime supports serialize', async () => {
      const mockSaveFormat = {
        version: 1,
        savedAt: 1000,
        resources: {},
        progression: {},
        commandQueue: {},
      };
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
        serialize: vi.fn(() => mockSaveFormat),
        hydrate: vi.fn(),
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

      messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 10 });
      parentPort.postMessage.mockClear();

      messageHandler?.({ kind: 'serialize', requestId: 'req-1' });
      await flushMicrotasks();

      const saveCall = parentPort.postMessage.mock.calls.find(
        (call) => (call[0] as SimWorkerOutboundMessage).kind === 'saveData',
      );
      expect(saveCall).toBeDefined();
      const saveMsg = saveCall?.[0] as {
        kind: string;
        requestId: string;
        ok: boolean;
        data?: Uint8Array;
      };
      expect(saveMsg.ok).toBe(true);
      expect(saveMsg.requestId).toBe('req-1');
      expect(saveMsg.data).toBeInstanceOf(Uint8Array);
      expect(saveMsg.data!.byteLength).toBeGreaterThan(0);
    });

    it('returns CAPABILITY_UNAVAILABLE when runtime does not support serialize', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 10 });
      parentPort.postMessage.mockClear();

      messageHandler?.({ kind: 'serialize', requestId: 'req-2' });

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        kind: 'saveData',
        requestId: 'req-2',
        ok: false,
        error: {
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'Runtime does not support serialize.',
          retriable: false,
        },
      });
    });

    it('returns PROTOCOL_VALIDATION_FAILED for missing requestId', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      messageHandler?.({ kind: 'serialize' });

      const saveCall = parentPort.postMessage.mock.calls.find(
        (call) => (call[0] as SimWorkerOutboundMessage).kind === 'saveData',
      );
      expect(saveCall).toBeDefined();
      const saveMsg = saveCall?.[0] as {
        kind: string;
        requestId: string;
        ok: boolean;
        error?: { code: string; message: string };
      };
      expect(saveMsg.ok).toBe(false);
      expect(saveMsg.error?.code).toBe('PROTOCOL_VALIDATION_FAILED');
      expect(saveMsg.error?.message).toContain('serialize.requestId');
    });

    it('returns PROTOCOL_VALIDATION_FAILED for invalid requestId (empty string)', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      messageHandler?.({ kind: 'serialize', requestId: '' });

      const saveCall = parentPort.postMessage.mock.calls.find(
        (call) => (call[0] as SimWorkerOutboundMessage).kind === 'saveData',
      );
      expect(saveCall).toBeDefined();
      const saveMsg = saveCall?.[0] as {
        kind: string;
        ok: boolean;
        error?: { code: string };
      };
      expect(saveMsg.ok).toBe(false);
      expect(saveMsg.error?.code).toBe('PROTOCOL_VALIDATION_FAILED');
    });

    it('returns PROTOCOL_VALIDATION_FAILED for requestId with special characters', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      messageHandler?.({ kind: 'serialize', requestId: 'req with spaces!' });

      const saveCall = parentPort.postMessage.mock.calls.find(
        (call) => (call[0] as SimWorkerOutboundMessage).kind === 'saveData',
      );
      expect(saveCall).toBeDefined();
      const saveMsg = saveCall?.[0] as {
        kind: string;
        ok: boolean;
        error?: { code: string };
      };
      expect(saveMsg.ok).toBe(false);
      expect(saveMsg.error?.code).toBe('PROTOCOL_VALIDATION_FAILED');
    });

    it('returns SERIALIZE_FAILED when runtime.serialize throws', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
        serialize: vi.fn(() => {
          throw new Error('serialization error');
        }),
        hydrate: vi.fn(),
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

      messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 10 });
      parentPort.postMessage.mockClear();

      messageHandler?.({ kind: 'serialize', requestId: 'req-fail' });
      await flushMicrotasks();

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        kind: 'saveData',
        requestId: 'req-fail',
        ok: false,
        error: {
          code: 'SERIALIZE_FAILED',
          message: 'serialization error',
          retriable: true,
        },
      });
    });

    it('produces bytes decodable by core decodeGameStateSave (binary roundtrip)', async () => {
      const { decodeGameStateSave } = await import('./runtime-harness.js');
      const mockSaveFormat = {
        version: 1,
        savedAt: 2000,
        resources: { wood: 50 },
        progression: { level: 2 },
        automation: [],
        transforms: [],
        entities: { entities: [], instances: [], entityInstances: [] },
        commandQueue: { commands: [] },
        runtime: { step: 10 },
      };
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
        serialize: vi.fn(() => mockSaveFormat),
        hydrate: vi.fn(),
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

      messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 10 });
      parentPort.postMessage.mockClear();

      messageHandler?.({ kind: 'serialize', requestId: 'roundtrip-1' });
      await flushMicrotasks();

      const saveCall = parentPort.postMessage.mock.calls.find(
        (call) => (call[0] as SimWorkerOutboundMessage).kind === 'saveData',
      );
      expect(saveCall).toBeDefined();
      const saveMsg = saveCall?.[0] as {
        kind: string;
        ok: boolean;
        data?: Uint8Array;
      };
      expect(saveMsg.ok).toBe(true);
      expect(saveMsg.data).toBeInstanceOf(Uint8Array);

      // Decode the produced bytes with the core codec
      const decoded = await decodeGameStateSave(saveMsg.data!);
      expect(decoded.version).toBe(1);
      expect(decoded.savedAt).toBe(2000);
      expect(decoded.resources).toEqual({ wood: 50 });
      expect(decoded.progression).toEqual({ level: 2 });
      expect(decoded.commandQueue).toEqual({ commands: [] });
      expect(decoded.runtime.step).toBe(10);
    });
  });

  describe('hydrate handler', () => {
    const validSave = {
      version: 1,
      savedAt: 1000,
      resources: { gold: 100 },
      progression: { phase: 'early' },
      automation: [],
      transforms: [],
      entities: { entities: [], instances: [], entityInstances: [] },
      commandQueue: { commands: [] },
      runtime: { step: 5, stepSizeMs: 16 },
    };

    it('returns hydrateResult success when runtime supports hydrate', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 42),
        hasCommandHandler: vi.fn(() => false),
        serialize: vi.fn(),
        hydrate: vi.fn(),
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

      messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 10 });
      parentPort.postMessage.mockClear();

      messageHandler?.({ kind: 'hydrate', requestId: 'hyd-1', save: validSave });

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        kind: 'hydrateResult',
        requestId: 'hyd-1',
        ok: true,
        nextStep: 42,
      });
    });

    it('returns CAPABILITY_UNAVAILABLE when runtime does not support hydrate', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 10 });
      parentPort.postMessage.mockClear();

      messageHandler?.({ kind: 'hydrate', requestId: 'hyd-2', save: validSave });

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        kind: 'hydrateResult',
        requestId: 'hyd-2',
        ok: false,
        error: {
          code: 'CAPABILITY_UNAVAILABLE',
          message: 'Runtime does not support hydrate.',
          retriable: false,
        },
      });
    });

    it('returns PROTOCOL_VALIDATION_FAILED for missing requestId', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      messageHandler?.({ kind: 'hydrate', save: validSave });

      const hydrateCall = parentPort.postMessage.mock.calls.find(
        (call) => (call[0] as SimWorkerOutboundMessage).kind === 'hydrateResult',
      );
      expect(hydrateCall).toBeDefined();
      const hydrateMsg = hydrateCall?.[0] as {
        kind: string;
        ok: boolean;
        error?: { code: string; message: string };
      };
      expect(hydrateMsg.ok).toBe(false);
      expect(hydrateMsg.error?.code).toBe('PROTOCOL_VALIDATION_FAILED');
      expect(hydrateMsg.error?.message).toContain('hydrate.requestId');
    });

    it('returns INVALID_SAVE_DATA when save is not an object', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      messageHandler?.({ kind: 'hydrate', requestId: 'hyd-3', save: 'not-an-object' });

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        kind: 'hydrateResult',
        requestId: 'hyd-3',
        ok: false,
        error: {
          code: 'INVALID_SAVE_DATA',
          message: 'Invalid hydrate.save: expected GameStateSaveFormat that resolves to version 1.',
          retriable: false,
        },
      });
    });

    it('returns INVALID_SAVE_DATA when save.savedAt is invalid', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      messageHandler?.({
        kind: 'hydrate',
        requestId: 'hyd-4',
        save: { ...validSave, savedAt: -1 },
      });

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        kind: 'hydrateResult',
        requestId: 'hyd-4',
        ok: false,
        error: {
          code: 'INVALID_SAVE_DATA',
          message: 'Invalid hydrate.save.savedAt: expected finite number >= 0.',
          retriable: false,
        },
      });
    });

    it('returns INVALID_SAVE_DATA when save.resources is missing', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      const { resources: _resources, ...saveWithoutResources } = validSave;
      messageHandler?.({
        kind: 'hydrate',
        requestId: 'hyd-5',
        save: saveWithoutResources,
      });

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        kind: 'hydrateResult',
        requestId: 'hyd-5',
        ok: false,
        error: {
          code: 'INVALID_SAVE_DATA',
          message: 'Invalid hydrate.save.resources: expected object.',
          retriable: false,
        },
      });
    });

    it('returns INVALID_SAVE_DATA when save.progression is missing', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      const { progression: _progression, ...saveWithoutProgression } = validSave;
      messageHandler?.({
        kind: 'hydrate',
        requestId: 'hyd-6',
        save: saveWithoutProgression,
      });

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        kind: 'hydrateResult',
        requestId: 'hyd-6',
        ok: false,
        error: {
          code: 'INVALID_SAVE_DATA',
          message: 'Invalid hydrate.save.progression: expected object.',
          retriable: false,
        },
      });
    });

    it('returns INVALID_SAVE_DATA when save.commandQueue is missing', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
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

      const { commandQueue: _commandQueue, ...saveWithoutCommandQueue } = validSave;
      messageHandler?.({
        kind: 'hydrate',
        requestId: 'hyd-7',
        save: saveWithoutCommandQueue,
      });

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        kind: 'hydrateResult',
        requestId: 'hyd-7',
        ok: false,
        error: {
          code: 'INVALID_SAVE_DATA',
          message: 'Invalid hydrate.save.commandQueue: expected object.',
          retriable: false,
        },
      });
    });

    it('returns HYDRATE_FAILED when runtime.hydrate throws', async () => {
      const createSimRuntime = vi.fn(() => ({
        tick: vi.fn(),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 0),
        hasCommandHandler: vi.fn(() => false),
        serialize: vi.fn(),
        hydrate: vi.fn(() => {
          throw new Error('hydration failed');
        }),
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

      messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 10 });
      parentPort.postMessage.mockClear();

      messageHandler?.({ kind: 'hydrate', requestId: 'hyd-8', save: validSave });

      expect(parentPort.postMessage).toHaveBeenCalledWith({
        kind: 'hydrateResult',
        requestId: 'hyd-8',
        ok: false,
        error: {
          code: 'HYDRATE_FAILED',
          message: 'hydration failed',
          retriable: true,
        },
      });
    });

    it('does not regress tick/enqueue/shutdown after hydrate', async () => {
      const runtime = {
        tick: vi.fn().mockReturnValue({ frames: [{ id: 'frame-after-hydrate' }], nextStep: 50 }),
        enqueueCommands: vi.fn(),
        getStepSizeMs: vi.fn(() => 16),
        getNextStep: vi.fn(() => 42),
        hasCommandHandler: vi.fn(() => false),
        serialize: vi.fn(),
        hydrate: vi.fn(),
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

      messageHandler?.({ kind: 'init', stepSizeMs: 16, maxStepsPerFrame: 10 });
      parentPort.postMessage.mockClear();

      // Hydrate
      messageHandler?.({ kind: 'hydrate', requestId: 'hyd-reg', save: validSave });
      expect(parentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'hydrateResult', ok: true }),
      );
      parentPort.postMessage.mockClear();

      // Tick still works
      messageHandler?.({ kind: 'tick', deltaMs: 16 });
      expect(parentPort.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'frame' }),
      );
      parentPort.postMessage.mockClear();

      // Enqueue still works
      const commands = [{ type: 'test-command' }] as const;
      messageHandler?.({ kind: 'enqueueCommands', commands });
      expect(runtime.enqueueCommands).toHaveBeenCalledWith(commands);

      // Shutdown still works
      messageHandler?.({ kind: 'shutdown' });
      expect(parentPort.close).toHaveBeenCalledTimes(1);
    });
  });
});
