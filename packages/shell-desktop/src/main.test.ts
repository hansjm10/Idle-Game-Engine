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

  static getAllWindows(): BrowserWindow[] {
    return BrowserWindow.windows;
  }

  public webContents = {
    openDevTools: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    getURL: vi.fn(() => 'app://idle-engine'),
  };

  public on = vi.fn();

  public show = vi.fn();

  public loadFile = vi.fn(async () => undefined);

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

  public on = vi.fn((_event: string, _handler: (...args: unknown[]) => void) => this);

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

  it('does not enable WebGPU switch in packaged mode without an explicit override', async () => {
    app.isPackaged = true;
    process.env.NODE_ENV = 'production';
    delete process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU;

    await import('./main.js');
    await flushMicrotasks();

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });
});
