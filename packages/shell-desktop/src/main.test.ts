import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from './ipc.js';

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

  public on = vi.fn((event: string, handler: (...args: unknown[]) => void) => {
    if (event === 'message') {
      this.messageHandler = handler as (message: unknown) => void;
    }
    if (event === 'error') {
      this.errorHandler = handler as (error: unknown) => void;
    }
    return this;
  });

  emitMessage(message: unknown): void {
    this.messageHandler?.(message);
  }

  emitError(error: unknown): void {
    this.errorHandler?.(error);
  }

  constructor(_script: unknown) {
    Worker.instances.push(this);
  }
}

vi.mock('node:worker_threads', () => ({
  Worker,
}));

describe('shell-desktop main process entrypoint', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalEnableUnsafeWebGpu = process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    app.isPackaged = false;
    BrowserWindow.windows = [];
    BrowserWindow.shouldRejectLoadFile = false;
    Worker.instances = [];

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

  it('starts the sim tick loop and forwards frames to the renderer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

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

    const frameA = { frame: { step: 0, simTimeMs: 0 } };
    const frameB = { frame: { step: 1, simTimeMs: 16 } };
    worker?.emitMessage({ kind: 'frames', frames: [frameA, frameB], nextStep: 2 });

    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.frame, frameA);
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.frame, frameB);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('handles control events and worker errors', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });

    const controlEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.controlEvent);
    expect(controlEventCall).toBeDefined();
    const controlEventHandler = controlEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    controlEventHandler?.({}, { intent: 'collect', phase: 'end' });
    expect(worker?.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueueCommands' }));

    controlEventHandler?.({}, { intent: 'collect', phase: 'start' });
    expect(worker?.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueueCommands' }));

    worker?.emitMessage({ kind: 'error', error: 'sim-worker error' });
    worker?.emitError(new Error('worker crashed'));
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
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

  it('does not enable WebGPU switch in packaged mode without an explicit override', async () => {
    app.isPackaged = true;
    process.env.NODE_ENV = 'production';
    delete process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU;

    await import('./main.js');
    await flushMicrotasks();

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});
