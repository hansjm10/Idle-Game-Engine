import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SimWorkerInboundMessage, SimWorkerOutboundMessage } from './sim/worker-protocol.js';

type MessageHandler = ((message: unknown) => void) | undefined;

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

  it('emits ready after init', async () => {
    const createSimRuntime = vi.fn(() => ({
      tick: vi.fn(),
      enqueueCommands: vi.fn(),
      getStepSizeMs: vi.fn(() => 25),
      getNextStep: vi.fn(() => 7),
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
    expect(parentPort.postMessage).toHaveBeenCalledWith({ kind: 'ready', stepSizeMs: 25, nextStep: 7 });
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
});
