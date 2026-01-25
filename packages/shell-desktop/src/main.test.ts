import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { IPC_CHANNELS, SHELL_CONTROL_EVENT_COMMAND_TYPE } from './ipc.js';

const readFile = vi.fn();
const writeFile = vi.fn();

vi.mock('node:fs/promises', () => ({
  readFile,
  writeFile,
}));

let monotonicNowSequence: number[] = [];

const monotonicNowMs = vi.fn(() => {
  const nextValue = monotonicNowSequence.shift();
  if (nextValue === undefined) {
    throw new Error('monotonicNowMs sequence exhausted');
  }
  return nextValue;
});

const setMonotonicNowSequence = (values: readonly number[]): void => {
  monotonicNowSequence = [...values];
};

async function flushMicrotasks(maxTurns = 10): Promise<void> {
  for (let i = 0; i < maxTurns; i += 1) {
    await Promise.resolve();
  }
}

const app = {
  isPackaged: false,
  name: 'idle-engine',
  commandLine: { appendSwitch: vi.fn() },
  whenReady: vi.fn(() => Promise.resolve()),
  on: vi.fn(),
  getPath: vi.fn(() => '/userData'),
  quit: vi.fn(),
  exit: vi.fn(),
};

const ipcMain = {
  handle: vi.fn(),
  on: vi.fn(),
};

const Menu = {
  buildFromTemplate: vi.fn((template) => template),
  setApplicationMenu: vi.fn(),
};

class BrowserWindow {
  static windows: BrowserWindow[] = [];
  static shouldRejectLoadFile = false;

  static getAllWindows(): BrowserWindow[] {
    return BrowserWindow.windows;
  }

  public webContents = {
    openDevTools: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    getURL: vi.fn(() => 'app://idle-engine'),
    send: vi.fn(),
  };

  public on = vi.fn();

  public show = vi.fn();

  public loadFile = vi.fn(async () => {
    if (BrowserWindow.shouldRejectLoadFile) {
      throw new Error('load failed');
    }
  });

  constructor(_options: unknown) {
    BrowserWindow.windows.push(this);
  }
}

vi.mock('electron', () => ({
  app,
  BrowserWindow,
  ipcMain,
  Menu,
}));

class Worker {
  static instances: Worker[] = [];

  public postMessage = vi.fn();

  public terminate = vi.fn(async () => 0);

  public messageHandler: ((message: unknown) => void) | undefined;
  public errorHandler: ((error: unknown) => void) | undefined;
  public exitHandler: ((exitCode: number) => void) | undefined;
  public messageErrorHandler: ((error: unknown) => void) | undefined;

  public on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'message') {
      this.messageHandler = handler as (message: unknown) => void;
    }
    if (event === 'error') {
      this.errorHandler = handler as (error: unknown) => void;
    }
    if (event === 'exit') {
      this.exitHandler = handler as (exitCode: number) => void;
    }
    if (event === 'messageerror') {
      this.messageErrorHandler = handler as (error: unknown) => void;
    }
    return this;
  });

  emitMessage(message: unknown): void {
    this.messageHandler?.(message);
  }

  emitError(error: unknown): void {
    this.errorHandler?.(error);
  }

  emitExit(exitCode: number): void {
    this.exitHandler?.(exitCode);
  }

  emitMessageError(error: unknown): void {
    this.messageErrorHandler?.(error);
  }

  constructor(_script: unknown) {
    Worker.instances.push(this);
  }
}

vi.mock('node:worker_threads', () => ({
  Worker,
}));

vi.mock('./monotonic-time.js', () => ({
  monotonicNowMs,
}));

describe('shell-desktop main process entrypoint', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnableUnsafeWebGpu = process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU;
  const originalGameMode = process.env.IDLE_ENGINE_GAME;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    app.isPackaged = false;
    BrowserWindow.windows = [];
    BrowserWindow.shouldRejectLoadFile = false;
    Worker.instances = [];
    monotonicNowSequence = [];

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalEnableUnsafeWebGpu === undefined) {
      delete process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU;
    } else {
      process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU = originalEnableUnsafeWebGpu;
    }

    if (originalGameMode === undefined) {
      delete process.env.IDLE_ENGINE_GAME;
    } else {
      process.env.IDLE_ENGINE_GAME = originalGameMode;
    }
  });

  afterEach(() => {
    vi.useRealTimers();

    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }

    if (originalEnableUnsafeWebGpu === undefined) {
      delete process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU;
    } else {
      process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU = originalEnableUnsafeWebGpu;
    }

    if (originalGameMode === undefined) {
      delete process.env.IDLE_ENGINE_GAME;
    } else {
      process.env.IDLE_ENGINE_GAME = originalGameMode;
    }
  });

  it('registers the ping IPC handler and enables WebGPU switch', async () => {
    await import('./main.js');
    await flushMicrotasks();

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-unsafe-webgpu');

    const handlerCall = ipcMain.handle.mock.calls.find((call) => call[0] === IPC_CHANNELS.ping);
    expect(handlerCall).toBeDefined();

    const handler = handlerCall?.[1] as undefined | ((event: unknown, request: unknown) => Promise<unknown>);
    expect(handler).toBeTypeOf('function');

    await expect(handler?.({}, { message: 'hello' })).resolves.toEqual({ message: 'hello' });
    await expect(handler?.({}, { message: 123 })).rejects.toThrow(TypeError);
    await expect(handler?.({}, null)).rejects.toThrow(TypeError);
    await expect(handler?.({}, [])).rejects.toThrow(TypeError);
  }, 15000);

  it('recreates the sim worker when activated with no open windows', async () => {
    await import('./main.js');
    await flushMicrotasks();

    expect(Worker.instances).toHaveLength(1);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    expect(windowAllClosedCall).toBeDefined();

    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    expect(windowAllClosedHandler).toBeTypeOf('function');

    BrowserWindow.windows = [];
    windowAllClosedHandler?.();
    expect(Worker.instances[0]?.terminate).toHaveBeenCalledTimes(1);

    const activateCall = app.on.mock.calls.find((call) => call[0] === 'activate');
    expect(activateCall).toBeDefined();

    const activateHandler = activateCall?.[1] as undefined | (() => void);
    expect(activateHandler).toBeTypeOf('function');

    activateHandler?.();
    await flushMicrotasks();

    expect(Worker.instances).toHaveLength(2);
  });

  it('recreates the sim worker when the renderer reloads', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    expect(Worker.instances).toHaveLength(1);

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const didFinishLoadCall = mainWindow?.webContents.on.mock.calls.find((call) => call[0] === 'did-finish-load');
    expect(didFinishLoadCall).toBeDefined();

    const didFinishLoadHandler = didFinishLoadCall?.[1] as undefined | (() => void);
    expect(didFinishLoadHandler).toBeTypeOf('function');

    Worker.instances[0]?.terminate.mockRejectedValueOnce(new Error('terminate failed'));
    didFinishLoadHandler?.();
    await flushMicrotasks();

    expect(Worker.instances[0]?.terminate).toHaveBeenCalledTimes(1);
    expect(Worker.instances).toHaveLength(2);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();

    didFinishLoadHandler?.();
    await flushMicrotasks();

    expect(Worker.instances).toHaveLength(2);

    consoleError.mockRestore();
  });

  it('starts the sim tick loop and forwards frames to the renderer', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16, 32]);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const readyToShowCall = mainWindow?.on.mock.calls.find((call) => call[0] === 'ready-to-show');
    expect(readyToShowCall).toBeDefined();
    const readyToShowHandler = readyToShowCall?.[1] as undefined | (() => void);
    readyToShowHandler?.();
    expect(mainWindow?.show).toHaveBeenCalledTimes(1);
    expect(mainWindow?.webContents.openDevTools).toHaveBeenCalledTimes(1);

    const willNavigateCall = mainWindow?.webContents.on.mock.calls.find((call) => call[0] === 'will-navigate');
    expect(willNavigateCall).toBeDefined();
    const willNavigateHandler = willNavigateCall?.[1] as undefined | ((event: { preventDefault: () => void }, url: string) => void);
    const navigationEvent = { preventDefault: vi.fn() };
    willNavigateHandler?.(navigationEvent, 'https://example.com');
    expect(navigationEvent.preventDefault).toHaveBeenCalledTimes(1);

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(32);
    expect(worker?.postMessage).toHaveBeenCalledWith({ kind: 'tick', deltaMs: 16 });

    let frameSends = 0;
    mainWindow?.webContents.send.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.frame) {
        frameSends += 1;
        if (frameSends === 1) {
          throw new Error('frame send failed');
        }
      }
      return undefined;
    });

    const frameA = { frame: { step: 0, simTimeMs: 0 } };
    const frameB = { frame: { step: 1, simTimeMs: 16 } };
    worker?.emitMessage({ kind: 'frames', frames: [frameA, frameB], nextStep: 2 });

    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.frame, frameB);
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(IPC_CHANNELS.frame, frameA);

    mainWindow?.webContents.send.mockClear();
    worker?.emitMessage({ kind: 'frames', frames: [], nextStep: 2 });
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(IPC_CHANNELS.frame, expect.anything());

    worker?.emitMessage({ kind: 'frame', frame: frameB, droppedFrames: 0, nextStep: 2 });
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.frame, frameB);

    mainWindow?.webContents.send.mockClear();
    worker?.emitMessage({ kind: 'frame', droppedFrames: 0, nextStep: 2 });
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(IPC_CHANNELS.frame, expect.anything());

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();

    consoleError.mockRestore();
  });

  it('logs an error when forwarding a coalesced frame fails', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    mainWindow?.webContents.send.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.frame) {
        throw new Error('frame send failed');
      }
      return undefined;
    });

    const frame = { frame: { step: 0, simTimeMs: 0 } };
    worker?.emitMessage({ kind: 'frame', frame, droppedFrames: 0, nextStep: 1 });

    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ message: 'frame send failed' }));
    consoleError.mockRestore();
  });

  it('clamps tick deltaMs when the monotonic clock jumps', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([1000, 900, 2000, 2016]);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(48);

    const tickCalls = worker?.postMessage.mock.calls
      .map((call) => call[0] as { kind?: string; deltaMs?: number })
      .filter((message) => message.kind === 'tick');

    expect(tickCalls).toHaveLength(3);
    expect(tickCalls?.map((message) => message.deltaMs)).toEqual([0, 250, 16]);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('treats non-finite tick deltas as zero', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, Number.NaN]);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(16);

    const tickCalls = worker?.postMessage.mock.calls
      .map((call) => call[0] as { kind?: string; deltaMs?: number })
      .filter((message) => message.kind === 'tick');

    expect(tickCalls).toHaveLength(1);
    expect(tickCalls?.[0]?.deltaMs).toBe(0);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('stops the tick loop and notifies the renderer when the sim worker exits', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16, 32]);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(32);
    expect(worker?.postMessage).toHaveBeenCalledWith({ kind: 'tick', deltaMs: 16 });

    const tickCallsBeforeExit = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'tick',
    );
    expect(tickCallsBeforeExit).toHaveLength(2);

    mainWindow?.webContents.send.mockImplementation((channel: string) => {
      if (channel === IPC_CHANNELS.simStatus) {
        throw new Error('send failed');
      }
      return undefined;
    });
    worker?.terminate.mockRejectedValueOnce(new Error('terminate failed'));

    worker?.emitExit(1);
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.objectContaining({ kind: 'crashed', exitCode: 1 }),
    );
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(64);
    const tickCallsAfterExit = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'tick',
    );
    expect(tickCallsAfterExit).toHaveLength(2);

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('notifies the renderer when the sim worker exits cleanly', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitExit(0);

    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.objectContaining({ kind: 'stopped', exitCode: 0 }),
    );
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Sim stopped'), expect.anything());

    consoleError.mockRestore();
  });

  it('treats postMessage exceptions as sim-worker fatal and clears the tick loop', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.postMessage.mockImplementation((message: unknown) => {
      if (typeof message === 'object' && message !== null && (message as { kind?: unknown }).kind === 'tick') {
        throw new Error('postMessage failed');
      }
    });

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(16);
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.objectContaining({ kind: 'crashed' }),
    );

    const tickCallsAfterFailure = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'tick',
    );
    expect(tickCallsAfterFailure).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(64);
    const tickCallsAfterAdvance = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'tick',
    );
    expect(tickCallsAfterAdvance).toHaveLength(1);

    const didFinishLoadCall = mainWindow?.webContents.on.mock.calls.find((call) => call[0] === 'did-finish-load');
    const didFinishLoadHandler = didFinishLoadCall?.[1] as undefined | (() => void);
    didFinishLoadHandler?.();
    await flushMicrotasks();

    const nextWorker = Worker.instances[1];
    expect(nextWorker).toBeDefined();

    nextWorker?.postMessage.mockImplementation((message: unknown) => {
      if (typeof message === 'object' && message !== null && (message as { kind?: unknown }).kind === 'tick') {
        throw 'tick exploded';
      }
    });

    setMonotonicNowSequence([100, 116]);
    nextWorker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(16);
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.objectContaining({ kind: 'crashed', reason: 'tick exploded' }),
    );

    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not treat worker exit during disposal as a crash', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();

    worker?.emitExit(0);

    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(IPC_CHANNELS.simStatus, expect.anything());
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('handles control events and worker errors', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });

    const controlEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.controlEvent);
    expect(controlEventCall).toBeDefined();
    const controlEventHandler = controlEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    controlEventHandler?.({}, null);
    controlEventHandler?.({}, []);
    controlEventHandler?.({}, { intent: 'collect', phase: 'start', metadata: [] });
    controlEventHandler?.({}, { intent: '', phase: 'start' });
    controlEventHandler?.({}, { intent: 'collect', phase: 'nope' });
    expect(worker?.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueueCommands' }));

    controlEventHandler?.({}, { intent: 'collect', phase: 'end' });
    expect(worker?.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueueCommands' }));

    const passthroughEvent = {
      intent: 'mouse-move',
      phase: 'repeat',
      metadata: { x: 12, y: 34, passthrough: true },
    };
    controlEventHandler?.({}, passthroughEvent);
    expect(worker?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'enqueueCommands',
        commands: expect.arrayContaining([
          expect.objectContaining({
            type: SHELL_CONTROL_EVENT_COMMAND_TYPE,
            payload: { event: passthroughEvent },
          }),
        ]),
      }),
    );

    const collectPassthroughEvent = {
      intent: 'collect',
      phase: 'start',
      metadata: { passthrough: true },
    };
    const enqueueMessagesBeforeCollectPassthrough =
      worker?.postMessage.mock.calls
        .map((call) => call[0] as { kind?: string; commands?: Array<{ type?: string }> })
        .filter((message) => message.kind === 'enqueueCommands')
        .length ?? 0;
    controlEventHandler?.({}, collectPassthroughEvent);
    const enqueueMessagesAfterCollectPassthrough =
      worker?.postMessage.mock.calls
        .map((call) => call[0] as { kind?: string; commands?: Array<{ type?: string }> })
        .filter((message) => message.kind === 'enqueueCommands') ?? [];
    expect(enqueueMessagesAfterCollectPassthrough).toHaveLength(enqueueMessagesBeforeCollectPassthrough + 1);
    const collectPassthroughMessage =
      enqueueMessagesAfterCollectPassthrough[enqueueMessagesAfterCollectPassthrough.length - 1];
    expect(collectPassthroughMessage?.commands).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE })]),
    );
    expect(collectPassthroughMessage?.commands).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: SHELL_CONTROL_EVENT_COMMAND_TYPE })]),
    );

    controlEventHandler?.({}, { intent: 'collect', phase: 'start' });
    expect(worker?.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueueCommands' }));

    const enqueueCallsBeforeFailure = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length;

    worker?.emitMessageError(new Error('message payload failed'));
    worker?.emitMessageError('message payload failed');
    await flushMicrotasks();

    controlEventHandler?.({}, { intent: 'collect', phase: 'start' });
    const enqueueCallsAfterFailure = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length;
    expect(enqueueCallsAfterFailure).toBe(enqueueCallsBeforeFailure);

    worker?.emitMessage({ kind: 'error', error: 'sim-worker error' });
    worker?.emitError(new Error('worker crashed'));
    worker?.emitError('worker crashed');
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('installs the application menu with macOS roles on darwin', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
      enumerable: true,
      writable: false,
    });

    try {
      await import('./main.js');
      await flushMicrotasks();

      expect(Menu.buildFromTemplate).toHaveBeenCalledTimes(1);
      const template = Menu.buildFromTemplate.mock.calls[0]?.[0] as unknown as Array<{ label?: string; submenu?: unknown }>;
      expect(template[0]).toMatchObject({ label: app.name });
      expect(template[0]?.submenu).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: 'about' }), expect.objectContaining({ role: 'quit' })]),
      );
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        enumerable: true,
        writable: false,
      });
    }
  });

  it('logs startup failures without crashing the process', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    app.whenReady.mockRejectedValueOnce(new Error('startup failed'));

    await import('./main.js');
    await flushMicrotasks();

    expect(app.exit).toHaveBeenCalledWith(1);
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('logs activate failures when the main window cannot be created', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    BrowserWindow.shouldRejectLoadFile = true;
    BrowserWindow.windows = [];

    const activateCall = app.on.mock.calls.find((call) => call[0] === 'activate');
    const activateHandler = activateCall?.[1] as undefined | (() => void);
    activateHandler?.();
    await flushMicrotasks();

    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('saves and loads test game state via menu actions in test-game mode', async () => {
    process.env.IDLE_ENGINE_GAME = 'test-game';

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleInfo = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    writeFile.mockResolvedValueOnce(undefined);
    readFile.mockResolvedValueOnce(JSON.stringify({ saveVersion: 1 }));

    try {
      await import('./main.js');
      await flushMicrotasks();

      const template = Menu.buildFromTemplate.mock.calls[0]?.[0] as unknown as Array<{ label?: string; submenu?: unknown }>;
      const gameMenu = template.find((entry) => entry.label === 'Game') as undefined | { submenu?: unknown };
      const gameSubmenu = gameMenu?.submenu as undefined | Array<{ label?: string; click?: () => void }>;
      expect(gameSubmenu).toBeDefined();

      const worker = Worker.instances[0];
      expect(worker).toBeDefined();

      const offlineCatchupOneHour = gameSubmenu?.find((entry) => entry.label === 'Offline catch-up (1h)');
      expect(offlineCatchupOneHour?.click).toBeTypeOf('function');
      worker?.postMessage.mockClear();
      offlineCatchupOneHour?.click?.();
      expect(worker?.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'enqueueCommands',
          commands: expect.arrayContaining([expect.objectContaining({ type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP })]),
        }),
      );

      const saveEntry = gameSubmenu?.find((entry) => entry.label === 'Save');
      expect(saveEntry?.click).toBeTypeOf('function');

      worker?.postMessage.mockClear();
      saveEntry?.click?.();

      const serializeCall = worker?.postMessage.mock.calls.find(
        (call) => (call[0] as { kind?: string } | undefined)?.kind === 'serialize',
      );
      expect(serializeCall).toBeDefined();
      const requestId = (serializeCall?.[0] as { requestId?: string }).requestId;
      expect(requestId).toBeTypeOf('string');

      worker?.emitMessage({ kind: 'serialized', requestId, save: { saved: true } });
      await flushMicrotasks();

      expect(writeFile).toHaveBeenCalledWith(
        '/userData/test-game-save.json',
        expect.stringContaining('"saved": true'),
        'utf8',
      );

      const loadEntry = gameSubmenu?.find((entry) => entry.label === 'Load');
      expect(loadEntry?.click).toBeTypeOf('function');

      worker?.postMessage.mockClear();
      loadEntry?.click?.();
      await flushMicrotasks();

      expect(readFile).toHaveBeenCalledWith('/userData/test-game-save.json', 'utf8');

      const hydrateCall = worker?.postMessage.mock.calls.find(
        (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
      );
      expect(hydrateCall).toBeDefined();
      const hydrateRequestId = (hydrateCall?.[0] as { requestId?: string }).requestId;
      expect(hydrateRequestId).toBeTypeOf('string');

      worker?.emitMessage({ kind: 'hydrated', requestId: hydrateRequestId, success: true, stepSizeMs: 8, nextStep: 42 });
      await flushMicrotasks();

      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining('Saved test game state'));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining('Loaded test game state'));
    } finally {
      consoleError.mockRestore();
      consoleInfo.mockRestore();
    }
  });

  it('logs an error when the sim worker returns a serialized response without a payload', async () => {
    process.env.IDLE_ENGINE_GAME = 'test-game';

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await import('./main.js');
      await flushMicrotasks();

      const template = Menu.buildFromTemplate.mock.calls[0]?.[0] as unknown as Array<{ label?: string; submenu?: unknown }>;
      const gameMenu = template.find((entry) => entry.label === 'Game') as undefined | { submenu?: unknown };
      const gameSubmenu = gameMenu?.submenu as undefined | Array<{ label?: string; click?: () => void }>;
      expect(gameSubmenu).toBeDefined();

      const worker = Worker.instances[0];
      expect(worker).toBeDefined();

      const saveEntry = gameSubmenu?.find((entry) => entry.label === 'Save');
      expect(saveEntry?.click).toBeTypeOf('function');

      worker?.postMessage.mockClear();
      saveEntry?.click?.();

      const serializeCall = worker?.postMessage.mock.calls.find(
        (call) => (call[0] as { kind?: string } | undefined)?.kind === 'serialize',
      );
      expect(serializeCall).toBeDefined();
      const requestId = (serializeCall?.[0] as { requestId?: string }).requestId;
      expect(requestId).toBeTypeOf('string');

      worker?.emitMessage({ kind: 'serialized', requestId });
      await flushMicrotasks();

      expect(writeFile).not.toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save test game state'),
        expect.objectContaining({ message: expect.stringContaining('did not return a save payload') }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('treats save/load requests after sim worker failure as errors', async () => {
    process.env.IDLE_ENGINE_GAME = 'test-game';

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    readFile.mockResolvedValueOnce(JSON.stringify({ version: 1 }));

    try {
      await import('./main.js');
      await flushMicrotasks();

      const template = Menu.buildFromTemplate.mock.calls[0]?.[0] as unknown as Array<{ label?: string; submenu?: unknown }>;
      const gameMenu = template.find((entry) => entry.label === 'Game') as undefined | { submenu?: unknown };
      const gameSubmenu = gameMenu?.submenu as undefined | Array<{ label?: string; click?: () => void }>;
      expect(gameSubmenu).toBeDefined();

      const saveEntry = gameSubmenu?.find((entry) => entry.label === 'Save');
      const loadEntry = gameSubmenu?.find((entry) => entry.label === 'Load');
      expect(saveEntry?.click).toBeTypeOf('function');
      expect(loadEntry?.click).toBeTypeOf('function');

      const worker = Worker.instances[0];
      expect(worker).toBeDefined();
      worker?.emitExit(1);
      consoleError.mockClear();

      saveEntry?.click?.();
      await flushMicrotasks();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save test game state'),
        expect.objectContaining({ message: 'Sim worker is not available.' }),
      );

      loadEntry?.click?.();
      await flushMicrotasks();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load test game state'),
        expect.objectContaining({ message: 'Sim worker is not available.' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logs hydrate failures reported by the sim worker', async () => {
    process.env.IDLE_ENGINE_GAME = 'test-game';

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    readFile.mockResolvedValueOnce(JSON.stringify({ version: 1 }));

    try {
      await import('./main.js');
      await flushMicrotasks();

      const template = Menu.buildFromTemplate.mock.calls[0]?.[0] as unknown as Array<{ label?: string; submenu?: unknown }>;
      const gameMenu = template.find((entry) => entry.label === 'Game') as undefined | { submenu?: unknown };
      const gameSubmenu = gameMenu?.submenu as undefined | Array<{ label?: string; click?: () => void }>;
      expect(gameSubmenu).toBeDefined();

      const loadEntry = gameSubmenu?.find((entry) => entry.label === 'Load');
      expect(loadEntry?.click).toBeTypeOf('function');

      const worker = Worker.instances[0];
      expect(worker).toBeDefined();

      worker?.postMessage.mockClear();
      loadEntry?.click?.();
      await flushMicrotasks();

      const hydrateCall = worker?.postMessage.mock.calls.find(
        (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
      );
      expect(hydrateCall).toBeDefined();
      const requestId = (hydrateCall?.[0] as { requestId?: string }).requestId;
      expect(requestId).toBeTypeOf('string');

      worker?.emitMessage({ kind: 'hydrated', requestId: 'unknown', success: false, error: 'ignored' });
      worker?.emitMessage({ kind: 'hydrated', requestId, success: false });
      await flushMicrotasks();

      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load test game state'),
        expect.objectContaining({ message: 'Sim worker failed to hydrate save.' }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not enable WebGPU switch in packaged mode without an explicit override', async () => {
    app.isPackaged = true;
    process.env.NODE_ENV = 'production';
    delete process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU;

    await import('./main.js');
    await flushMicrotasks();

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});
