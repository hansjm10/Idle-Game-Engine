import { beforeEach, describe, expect, it, vi } from 'vitest';

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
