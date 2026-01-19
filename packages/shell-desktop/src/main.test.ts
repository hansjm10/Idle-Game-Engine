import { describe, expect, it, vi } from 'vitest';

import { IPC_CHANNELS } from './ipc.js';

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

describe('shell-desktop main process entrypoint', () => {
  it('registers the ping IPC handler and enables WebGPU switch', async () => {
    await import('./main.js');
    await Promise.resolve();

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-unsafe-webgpu');

    const handlerCall = ipcMain.handle.mock.calls.find((call) => call[0] === IPC_CHANNELS.ping);
    expect(handlerCall).toBeDefined();

    const handler = handlerCall?.[1] as undefined | ((event: unknown, request: unknown) => Promise<unknown>);
    expect(handler).toBeTypeOf('function');

    await expect(handler?.({}, { message: 'hello' })).resolves.toEqual({ message: 'hello' });
    await expect(handler?.({}, { message: 123 })).rejects.toThrow(TypeError);
  });
});

