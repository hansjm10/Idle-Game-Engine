import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import type { createControlCommands as CreateControlCommandsFn } from '@idle-engine/controls';
import { IPC_CHANNELS, SHELL_CONTROL_EVENT_COMMAND_TYPE } from './ipc.js';

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

const fsPromises = {
  readFile: vi.fn(async () => Buffer.from([1, 2, 3])),
};

vi.mock('node:fs', () => ({
  promises: fsPromises,
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

const writeSaveMock = vi.fn(async () => undefined);
const readSaveMock = vi.fn(async (): Promise<Uint8Array | undefined> => undefined);
const cleanupStaleTempFilesMock = vi.fn(async () => undefined);

vi.mock('./save-storage.js', () => ({
  writeSave: writeSaveMock,
  readSave: readSaveMock,
  cleanupStaleTempFiles: cleanupStaleTempFilesMock,
}));

const loadGameStateSaveFormatMock = vi.fn((data: unknown) => data);

vi.mock('./runtime-harness.js', () => ({
  loadGameStateSaveFormat: loadGameStateSaveFormatMock,
}));

let uuidCounter = 0;

vi.mock('node:crypto', () => ({
  randomUUID: () => {
    uuidCounter += 1;
    return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, '0')}`;
  },
}));

// Use a lazy reference to the real createControlCommands so it can be mocked per-test
let realCreateControlCommands: typeof CreateControlCommandsFn;

const createControlCommandsMock = vi.fn((...args: Parameters<typeof CreateControlCommandsFn>) => {
  return realCreateControlCommands(...args);
});

vi.mock('@idle-engine/controls', async (importOriginal) => {
  const actual = await importOriginal() as { createControlCommands: typeof CreateControlCommandsFn };
  realCreateControlCommands = actual.createControlCommands;
  return {
    ...actual,
    createControlCommands: createControlCommandsMock,
  };
});

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
    monotonicNowSequence = [];

    uuidCounter = 0;

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
    await expect(handler?.({}, null)).rejects.toThrow(TypeError);
    await expect(handler?.({}, [])).rejects.toThrow(TypeError);
  }, 15000);

  it('restricts readAsset to compiled assets', async () => {
    await import('./main.js');
    await flushMicrotasks();

    const handlerCall = ipcMain.handle.mock.calls.find(
      (call) => call[0] === IPC_CHANNELS.readAsset,
    );
    expect(handlerCall).toBeDefined();

    const handler = handlerCall?.[1] as undefined | ((event: unknown, request: unknown) => Promise<unknown>);
    expect(handler).toBeTypeOf('function');

    const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const compiledRoot = path.join(repoRoot, 'packages/content-sample/content/compiled');
    const allowedPath = path.join(
      compiledRoot,
      '@idle-engine/sample-pack.assets/renderer-assets.manifest.json',
    );
    const allowedUrl = pathToFileURL(allowedPath).toString();

    const disallowedPath = path.join(repoRoot, 'packages/shell-desktop/src/main.ts');
    const disallowedUrl = pathToFileURL(disallowedPath).toString();

    await expect(handler?.({}, { url: disallowedUrl })).rejects.toThrow(TypeError);

    const result = await handler?.({}, { url: allowedUrl });
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(fsPromises.readFile).toHaveBeenCalledWith(allowedPath);
  });

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

    // Test: frame message with frame present forwards to IPC
    const frameB = { frame: { step: 1, simTimeMs: 16 } };
    worker?.emitMessage({ kind: 'frame', frame: frameB, droppedFrames: 0, nextStep: 2 });
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(IPC_CHANNELS.frame, frameB);

    // Test: frame message without frame does not send IPC
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

    // Clear calls from controller creation (starting status)
    mainWindow?.webContents.send.mockClear();

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();

    worker?.emitExit(0);

    // During disposal, worker exit should not trigger stopped/crashed status
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.objectContaining({ kind: 'stopped' }),
    );
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.objectContaining({ kind: 'crashed' }),
    );
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
    // Invalid: value is present but not finite (NaN)
    controlEventHandler?.({}, { intent: 'collect', phase: 'start', value: NaN });
    // Invalid: value is present but not finite (Infinity)
    controlEventHandler?.({}, { intent: 'collect', phase: 'start', value: Infinity });
    // Invalid: value is present but not finite (-Infinity)
    controlEventHandler?.({}, { intent: 'collect', phase: 'start', value: -Infinity });
    // Invalid: value is present but not a number
    controlEventHandler?.({}, { intent: 'collect', phase: 'start', value: 'not-a-number' });
    expect(worker?.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueueCommands' }));

    controlEventHandler?.({}, { intent: 'collect', phase: 'end' });
    expect(worker?.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueueCommands' }));

    // Valid: ShellControlEvent with a valid finite value is still processed
    controlEventHandler?.({}, { intent: 'collect', phase: 'start', value: 42.5 });
    expect(worker?.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'enqueueCommands' }));

    // Reset for next tests
    worker?.postMessage.mockClear();

    // Note: passthrough SHELL_CONTROL_EVENT is no longer emitted from renderer inputs (issue #850)
    const passthroughEvent = {
      intent: 'mouse-move',
      phase: 'repeat',
      metadata: { x: 12, y: 34, passthrough: true },
    };
    const enqueueCallsBeforePassthrough = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;
    controlEventHandler?.({}, passthroughEvent);
    // Passthrough events that don't match bindings no longer enqueue SHELL_CONTROL_EVENT
    const enqueueCallsAfterPassthrough = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;
    expect(enqueueCallsAfterPassthrough).toBe(enqueueCallsBeforePassthrough);
    // Verify no SHELL_CONTROL_EVENT was enqueued
    expect(worker?.postMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'enqueueCommands',
        commands: expect.arrayContaining([
          expect.objectContaining({
            type: SHELL_CONTROL_EVENT_COMMAND_TYPE,
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

  it('drops invalid input event payloads without enqueuing commands', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });

    const inputEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.inputEvent);
    expect(inputEventCall).toBeDefined();
    const inputEventHandler = inputEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    const enqueueCallsBefore = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;

    // Invalid: null
    inputEventHandler?.({}, null);
    // Invalid: array
    inputEventHandler?.({}, []);
    // Invalid: missing schemaVersion
    inputEventHandler?.({}, { event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: wrong schemaVersion (2 instead of 1)
    inputEventHandler?.({}, { schemaVersion: 2, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: missing event
    inputEventHandler?.({}, { schemaVersion: 1 });
    // Invalid: event is null
    inputEventHandler?.({}, { schemaVersion: 1, event: null });
    // Invalid: event has unknown kind
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'unknown', intent: 'test', phase: 'start' } });
    // Invalid: pointer event with invalid intent
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'invalid', phase: 'start', x: 0, y: 0, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with non-finite x
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: NaN, y: 0, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with non-finite y
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: Infinity, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with invalid pointerType
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 0, buttons: 1, pointerType: 'stylus', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with invalid phase
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'invalid', x: 0, y: 0, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with missing modifiers
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 0, buttons: 1, pointerType: 'mouse' } });
    // Invalid: pointer event with incomplete modifiers
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false } } });
    // Invalid: wheel event with non-finite deltaX
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'wheel', intent: 'mouse-wheel', phase: 'repeat', x: 0, y: 0, deltaX: NaN, deltaY: 0, deltaZ: 0, deltaMode: 0, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: wheel event with invalid deltaMode
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'wheel', intent: 'mouse-wheel', phase: 'repeat', x: 0, y: 0, deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 3, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: wheel event with wrong intent
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'wheel', intent: 'mouse-down', phase: 'repeat', x: 0, y: 0, deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 0, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: wheel event with wrong phase
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'wheel', intent: 'mouse-wheel', phase: 'start', x: 0, y: 0, deltaX: 0, deltaY: 0, deltaZ: 0, deltaMode: 0, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with phase not matching intent (mouse-down with repeat instead of start)
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'repeat', x: 0, y: 0, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with phase not matching intent (mouse-move with start instead of repeat)
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-move', phase: 'start', x: 0, y: 0, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with phase not matching intent (mouse-up with repeat instead of end)
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-up', phase: 'repeat', x: 0, y: 0, button: 0, buttons: 0, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with non-integer button (float)
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 0.5, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with button outside range (< -1)
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: -2, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with button outside range (> 32)
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 33, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with non-integer buttons (float)
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 0, buttons: 1.5, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with buttons outside range (< 0)
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 0, buttons: -1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });
    // Invalid: pointer event with buttons outside range (> 0xFFFF)
    inputEventHandler?.({}, { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 0, buttons: 0x10000, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } });

    const enqueueCallsAfter = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;

    // No commands should have been enqueued
    expect(enqueueCallsAfter).toBe(enqueueCallsBefore);

    // Cleanup: close windows to dispose worker and stop tick loop
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('enqueues INPUT_EVENT commands for valid pointer events', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 5 });

    const inputEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.inputEvent);
    expect(inputEventCall).toBeDefined();
    const inputEventHandler = inputEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    const validPointerDown = {
      schemaVersion: 1,
      event: {
        kind: 'pointer',
        intent: 'mouse-down',
        phase: 'start',
        x: 100,
        y: 200,
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      },
    };

    inputEventHandler?.({}, validPointerDown);

    expect(worker?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'enqueueCommands',
        commands: [
          expect.objectContaining({
            type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
            payload: {
              schemaVersion: 1,
              event: validPointerDown.event,
            },
            priority: 1, // CommandPriority.PLAYER
            step: 5,
            timestamp: 80, // 5 * 16
          }),
        ],
      }),
    );

    // Verify requestId is NOT included (should be omitted)
    const lastEnqueueCall = worker?.postMessage.mock.calls
      .filter((call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands')
      .pop();
    const inputEventCommand = (lastEnqueueCall?.[0] as { commands?: Array<{ requestId?: unknown }> })?.commands?.[0];
    expect(inputEventCommand).not.toHaveProperty('requestId');

    // Cleanup: close windows to dispose worker and stop tick loop
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('enqueues INPUT_EVENT commands for valid wheel events', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 20, nextStep: 3 });

    const inputEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.inputEvent);
    expect(inputEventCall).toBeDefined();
    const inputEventHandler = inputEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    const validWheelEvent = {
      schemaVersion: 1,
      event: {
        kind: 'wheel',
        intent: 'mouse-wheel',
        phase: 'repeat',
        x: 50,
        y: 75,
        deltaX: 0,
        deltaY: -100,
        deltaZ: 0,
        deltaMode: 0,
        modifiers: { alt: true, ctrl: false, meta: false, shift: false },
      },
    };

    inputEventHandler?.({}, validWheelEvent);

    expect(worker?.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'enqueueCommands',
        commands: [
          expect.objectContaining({
            type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
            payload: {
              schemaVersion: 1,
              event: validWheelEvent.event,
            },
            priority: 1, // CommandPriority.PLAYER
            step: 3,
            timestamp: 60, // 3 * 20
          }),
        ],
      }),
    );

    // Cleanup: close windows to dispose worker and stop tick loop
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('ignores input events when sim is stopped or crashed', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });

    const inputEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.inputEvent);
    expect(inputEventCall).toBeDefined();
    const inputEventHandler = inputEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    const validPointerDown = {
      schemaVersion: 1,
      event: {
        kind: 'pointer',
        intent: 'mouse-down',
        phase: 'start',
        x: 10,
        y: 20,
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      },
    };

    // Input events work before crash
    const enqueueCallsBefore = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;

    inputEventHandler?.({}, validPointerDown);

    const enqueueCallsAfterFirst = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;
    expect(enqueueCallsAfterFirst).toBe(enqueueCallsBefore + 1);

    // Simulate worker crash
    worker?.emitExit(1);
    await flushMicrotasks();

    // Input events should be ignored after crash (no more enqueueCommands)
    inputEventHandler?.({}, validPointerDown);

    const enqueueCallsAfterCrash = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;
    expect(enqueueCallsAfterCrash).toBe(enqueueCallsAfterFirst);

    consoleError.mockRestore();
  });

  it('ignores input events when sim is disposing', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });

    const inputEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.inputEvent);
    expect(inputEventCall).toBeDefined();
    const inputEventHandler = inputEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    const validPointerDown = {
      schemaVersion: 1,
      event: {
        kind: 'pointer',
        intent: 'mouse-down',
        phase: 'start',
        x: 10,
        y: 20,
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      },
    };

    // Input events work before dispose
    const enqueueCallsBefore = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;

    inputEventHandler?.({}, validPointerDown);

    const enqueueCallsAfterFirst = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;
    expect(enqueueCallsAfterFirst).toBe(enqueueCallsBefore + 1);

    // Trigger dispose by closing windows
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();

    // Input events should be ignored after dispose (no more enqueueCommands)
    inputEventHandler?.({}, validPointerDown);

    const enqueueCallsAfterDispose = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;
    expect(enqueueCallsAfterDispose).toBe(enqueueCallsAfterFirst);
  });

  it('does not enqueue SHELL_CONTROL_EVENT from input events', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });

    const inputEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.inputEvent);
    expect(inputEventCall).toBeDefined();
    const inputEventHandler = inputEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    // Send several valid input events
    const events = [
      { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-down', phase: 'start', x: 0, y: 0, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } },
      { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-move', phase: 'repeat', x: 10, y: 20, button: 0, buttons: 1, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } },
      { schemaVersion: 1, event: { kind: 'pointer', intent: 'mouse-up', phase: 'end', x: 10, y: 20, button: 0, buttons: 0, pointerType: 'mouse', modifiers: { alt: false, ctrl: false, meta: false, shift: false } } },
      { schemaVersion: 1, event: { kind: 'wheel', intent: 'mouse-wheel', phase: 'repeat', x: 50, y: 50, deltaX: 0, deltaY: -10, deltaZ: 0, deltaMode: 0, modifiers: { alt: false, ctrl: false, meta: false, shift: false } } },
    ];

    for (const event of events) {
      inputEventHandler?.({}, event);
    }

    // Verify no SHELL_CONTROL_EVENT commands were enqueued (acceptance criterion #4)
    const allEnqueueCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ) ?? [];

    for (const call of allEnqueueCalls) {
      const commands = (call[0] as { commands?: Array<{ type?: string }> }).commands ?? [];
      for (const command of commands) {
        expect(command.type).not.toBe(SHELL_CONTROL_EVENT_COMMAND_TYPE);
      }
    }

    // Verify all commands are INPUT_EVENT
    const inputEventCount = allEnqueueCalls.reduce((count, call) => {
      const commands = (call[0] as { commands?: Array<{ type?: string }> }).commands ?? [];
      return count + commands.filter((cmd) => cmd.type === RUNTIME_COMMAND_TYPES.INPUT_EVENT).length;
    }, 0);
    expect(inputEventCount).toBe(events.length);

    // Cleanup: close windows to dispose worker and stop tick loop
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
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

  it('does not enable WebGPU switch in packaged mode without an explicit override', async () => {
    app.isPackaged = true;
    process.env.NODE_ENV = 'production';
    delete process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU;

    await import('./main.js');
    await flushMicrotasks();

    expect(app.commandLine.appendSwitch).not.toHaveBeenCalled();
  });

  it('drops input events received before worker ready handshake', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    const inputEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.inputEvent);
    expect(inputEventCall).toBeDefined();
    const inputEventHandler = inputEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    const validPointerDown = {
      schemaVersion: 1,
      event: {
        kind: 'pointer',
        intent: 'mouse-down',
        phase: 'start',
        x: 10,
        y: 20,
        button: 0,
        buttons: 1,
        pointerType: 'mouse',
        modifiers: { alt: false, ctrl: false, meta: false, shift: false },
      },
    };

    // Send input event BEFORE ready - should be dropped
    const enqueueCallsBeforeReady = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;

    inputEventHandler?.({}, validPointerDown);

    const enqueueCallsAfterPreReadyInput = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;

    // Should NOT have enqueued (dropped because not ready)
    expect(enqueueCallsAfterPreReadyInput).toBe(enqueueCallsBeforeReady);

    // Now emit ready
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Send input event AFTER ready - should be accepted
    inputEventHandler?.({}, validPointerDown);

    const enqueueCallsAfterPostReadyInput = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;

    // Should have enqueued (accepted because ready)
    expect(enqueueCallsAfterPostReadyInput).toBe(enqueueCallsAfterPreReadyInput + 1);

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('drops control events received before worker ready handshake', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    const controlEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.controlEvent);
    expect(controlEventCall).toBeDefined();
    const controlEventHandler = controlEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    const validControlEvent = { intent: 'collect', phase: 'start' };

    // Send control event BEFORE ready - should be dropped
    const enqueueCallsBeforeReady = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;

    controlEventHandler?.({}, validControlEvent);

    const enqueueCallsAfterPreReadyControl = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;

    // Should NOT have enqueued (dropped because not ready)
    expect(enqueueCallsAfterPreReadyControl).toBe(enqueueCallsBeforeReady);

    // Now emit ready
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Send control event AFTER ready - should be accepted
    controlEventHandler?.({}, validControlEvent);

    const enqueueCallsAfterPostReadyControl = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ).length ?? 0;

    // Should have enqueued (accepted because ready)
    expect(enqueueCallsAfterPostReadyControl).toBe(enqueueCallsAfterPreReadyControl + 1);

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('sends sim-status starting when sim worker controller is created', async () => {
    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    // Verify sim-status 'starting' was sent when the controller was created
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      { kind: 'starting' },
    );

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('sends sim-status running when worker emits ready', async () => {
    setMonotonicNowSequence([0]);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    // Clear previous calls to isolate the ready message test
    mainWindow?.webContents.send.mockClear();

    // Emit ready from worker
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Verify sim-status 'running' was sent
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      { kind: 'running' },
    );

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('sends sim-status starting when worker controller is recreated on reload', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    // Clear calls after initial creation
    mainWindow?.webContents.send.mockClear();

    // Trigger recreation by simulating a page reload (did-finish-load)
    const didFinishLoadCall = mainWindow?.webContents.on.mock.calls.find((call) => call[0] === 'did-finish-load');
    expect(didFinishLoadCall).toBeDefined();
    const didFinishLoadHandler = didFinishLoadCall?.[1] as undefined | (() => void);
    didFinishLoadHandler?.();
    await flushMicrotasks();

    // Verify sim-status 'starting' was sent when the new controller was created
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      { kind: 'starting' },
    );

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();

    consoleError.mockRestore();
  });

  it('sends sim-status transitions in order: starting, running', async () => {
    setMonotonicNowSequence([0]);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    // Collect all sim-status calls
    const simStatusCalls = mainWindow?.webContents.send.mock.calls
      .filter((call) => call[0] === IPC_CHANNELS.simStatus)
      .map((call) => call[1] as { kind: string });

    // Should have 'starting' from creation
    expect(simStatusCalls).toContainEqual({ kind: 'starting' });

    // Emit ready from worker
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Collect all sim-status calls again
    const allSimStatusCalls = mainWindow?.webContents.send.mock.calls
      .filter((call) => call[0] === IPC_CHANNELS.simStatus)
      .map((call) => call[1] as { kind: string });

    // Should have both 'starting' and 'running' in order
    expect(allSimStatusCalls).toEqual([
      { kind: 'starting' },
      { kind: 'running' },
    ]);

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('treats createControlCommands exceptions as fatal and emits sim-status crashed', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    // Emit ready so control events are accepted
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Clear previous calls to isolate the test
    mainWindow?.webContents.send.mockClear();
    worker?.postMessage.mockClear();

    // Mock createControlCommands to throw an error
    createControlCommandsMock.mockImplementationOnce(() => {
      throw new Error('control-event mapping failed');
    });

    const controlEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.controlEvent);
    expect(controlEventCall).toBeDefined();
    const controlEventHandler = controlEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    // Send a valid control event that will trigger the exception
    controlEventHandler?.({}, { intent: 'collect', phase: 'start' });
    await flushMicrotasks();

    // Verify sim-status 'crashed' was sent
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.objectContaining({ kind: 'crashed', reason: 'control-event mapping failed' }),
    );

    // Verify no commands were enqueued after the exception
    const enqueueCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    );
    expect(enqueueCalls).toHaveLength(0);

    // Verify ticking is stopped by advancing time and checking no tick messages
    await vi.advanceTimersByTimeAsync(64);
    const tickCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'tick',
    );
    expect(tickCalls).toHaveLength(0);

    // Verify subsequent control events are also dropped (sim is in failed state)
    createControlCommandsMock.mockReturnValueOnce([]);
    controlEventHandler?.({}, { intent: 'collect', phase: 'start' });
    await flushMicrotasks();

    const enqueueCallsAfter = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    );
    expect(enqueueCallsAfter).toHaveLength(0);

    consoleError.mockRestore();
  });

  it('treats createControlCommands non-Error exceptions as fatal with stringified reason', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    // Emit ready so control events are accepted
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Clear previous calls to isolate the test
    mainWindow?.webContents.send.mockClear();

    // Mock createControlCommands to throw a non-Error value
    createControlCommandsMock.mockImplementationOnce(() => {
      throw 'string error from createControlCommands';
    });

    const controlEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.controlEvent);
    expect(controlEventCall).toBeDefined();
    const controlEventHandler = controlEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);

    // Send a valid control event that will trigger the exception
    controlEventHandler?.({}, { intent: 'collect', phase: 'start' });
    await flushMicrotasks();

    // Verify sim-status 'crashed' was sent with stringified reason
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.objectContaining({ kind: 'crashed', reason: 'string error from createControlCommands' }),
    );

    consoleError.mockRestore();
  });

  it('ignores worker frame messages after controller disposal', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    // Emit ready so the worker is running
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Clear calls to isolate the test
    mainWindow?.webContents.send.mockClear();

    // Trigger disposal by closing windows
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();

    // Now emit a stale frame message from the worker after disposal
    const staleFrame = { frame: { step: 99, simTimeMs: 1000 } };
    worker?.emitMessage({ kind: 'frame', frame: staleFrame, droppedFrames: 0, nextStep: 100 });
    await flushMicrotasks();

    // Verify no frame IPC was sent (stale message should be ignored)
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.frame,
      expect.anything(),
    );

    // Verify no sim-status IPC was sent either
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.anything(),
    );
  });

  it('ignores worker ready messages after controller disposal', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    // Clear calls after initial 'starting' status
    mainWindow?.webContents.send.mockClear();

    // Trigger disposal by closing windows (before ready)
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();

    // Now emit a stale ready message from the worker after disposal
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Verify no 'running' sim-status was sent (stale message should be ignored)
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      { kind: 'running' },
    );

    // Verify no tick messages were sent (tick loop should not have started)
    await vi.advanceTimersByTimeAsync(64);
    const tickCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'tick',
    );
    expect(tickCalls).toHaveLength(0);
  });

  it('ignores worker frame messages after crash', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16, 32]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    // Emit ready so the worker is running
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Trigger a crash
    worker?.emitExit(1);
    await flushMicrotasks();

    // Clear calls to isolate the test
    mainWindow?.webContents.send.mockClear();

    // Now emit a stale frame message from the worker after crash
    const staleFrame = { frame: { step: 99, simTimeMs: 1000 } };
    worker?.emitMessage({ kind: 'frame', frame: staleFrame, droppedFrames: 0, nextStep: 100 });
    await flushMicrotasks();

    // Verify no frame IPC was sent (stale message should be ignored)
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.frame,
      expect.anything(),
    );

    // Verify no sim-status IPC was sent either
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.anything(),
    );

    consoleError.mockRestore();
  });

  it('ignores worker ready messages after crash', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    // Emit ready so the worker is running
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Trigger a crash
    worker?.emitExit(1);
    await flushMicrotasks();

    // Clear calls to isolate the test (crash already sent 'crashed' status)
    mainWindow?.webContents.send.mockClear();

    // Now emit a stale ready message from the worker after crash
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Verify no 'running' sim-status was sent (stale message should be ignored)
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      { kind: 'running' },
    );

    // Record tick calls count after crash but before stale ready
    const tickCallsBeforeStaleReady = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'tick',
    ).length ?? 0;

    // Verify tick loop was not restarted by the stale ready message
    await vi.advanceTimersByTimeAsync(64);
    const tickCallsAfterStaleReady = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'tick',
    ).length ?? 0;

    // The tick loop was already stopped by the crash, and the stale ready should not restart it
    // No new tick calls should have been made
    expect(tickCallsAfterStaleReady).toBe(tickCallsBeforeStaleReady);

    consoleError.mockRestore();
  });

  // ─────────────────────────────────────────────────────────────────────────
  // T5 — Dev menu, save/load/offline flows, protocol normalization
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Helper: finds the Dev submenu from the template passed to Menu.buildFromTemplate.
   */
  function findDevSubmenu(): Array<{ label?: string; accelerator?: string; enabled?: boolean; click?: () => void; type?: string }> {
    const templateCall = Menu.buildFromTemplate.mock.calls[0];
    expect(templateCall).toBeDefined();
    const template = templateCall?.[0] as Array<{ label?: string; submenu?: unknown[] }>;
    const devEntry = template.find((item) => item.label === 'Dev');
    expect(devEntry).toBeDefined();
    return devEntry?.submenu as Array<{ label?: string; accelerator?: string; enabled?: boolean; click?: () => void; type?: string }>;
  }

  it('installs a Dev menu with Save, Load, and Offline Catch-Up actions', async () => {
    await import('./main.js');
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    const loadItem = devSubmenu.find((item) => item.label === 'Load');
    const catchupItem = devSubmenu.find((item) => item.label === 'Offline Catch-Up');

    expect(saveItem).toBeDefined();
    expect(saveItem?.accelerator).toBe('CmdOrCtrl+S');
    expect(saveItem?.enabled).toBe(false);

    expect(loadItem).toBeDefined();
    expect(loadItem?.accelerator).toBe('CmdOrCtrl+O');
    expect(loadItem?.enabled).toBe(false);

    expect(catchupItem).toBeDefined();
    expect(catchupItem?.accelerator).toBe('CmdOrCtrl+Shift+O');
    expect(catchupItem?.enabled).toBe(false);

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('enables Dev menu actions when v2 ready with capabilities is received', async () => {
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    const loadItem = devSubmenu.find((item) => item.label === 'Load');
    const catchupItem = devSubmenu.find((item) => item.label === 'Offline Catch-Up');

    // Before ready: all disabled
    expect(saveItem?.enabled).toBe(false);
    expect(loadItem?.enabled).toBe(false);
    expect(catchupItem?.enabled).toBe(false);

    // Emit v2 ready with full capabilities
    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: true },
    });
    await flushMicrotasks();

    // After v2 ready: Save/Load and Offline Catch-Up enabled
    expect(saveItem?.enabled).toBe(true);
    expect(loadItem?.enabled).toBe(true);
    expect(catchupItem?.enabled).toBe(true);

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('normalizes legacy ready payloads to protocol v1 with disabled capabilities', async () => {
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    // Emit legacy ready (no protocolVersion, no capabilities)
    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    // Should transition to running (legacy is valid)
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      { kind: 'running' },
    );

    // Dev menu items should remain disabled (legacy = no capabilities)
    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    const loadItem = devSubmenu.find((item) => item.label === 'Load');
    const catchupItem = devSubmenu.find((item) => item.label === 'Offline Catch-Up');

    expect(saveItem?.enabled).toBe(false);
    expect(loadItem?.enabled).toBe(false);
    expect(catchupItem?.enabled).toBe(false);

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('enables only canSerialize actions when canOfflineCatchup is false', async () => {
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    const loadItem = devSubmenu.find((item) => item.label === 'Load');
    const catchupItem = devSubmenu.find((item) => item.label === 'Offline Catch-Up');

    expect(saveItem?.enabled).toBe(true);
    expect(loadItem?.enabled).toBe(true);
    expect(catchupItem?.enabled).toBe(false);

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('rejects malformed ready payload (unsupported protocolVersion) as worker failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    mainWindow?.webContents.send.mockClear();

    // Emit ready with unsupported protocolVersion (3)
    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 3,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: true },
    } as unknown);
    await flushMicrotasks();

    // Should transition to crashed (not running)
    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.objectContaining({ kind: 'crashed' }),
    );
    expect(mainWindow?.webContents.send).not.toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      { kind: 'running' },
    );

    consoleError.mockRestore();
  });

  it('rejects ready with protocolVersion 2 but missing capabilities as worker failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    mainWindow?.webContents.send.mockClear();

    // Emit v2 ready with no capabilities
    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
    } as unknown);
    await flushMicrotasks();

    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.simStatus,
      expect.objectContaining({ kind: 'crashed' }),
    );

    consoleError.mockRestore();
  });

  it('save flow: sends serialize, consumes matching saveData, writes via atomic storage', async () => {
    setMonotonicNowSequence([0]);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    // Emit v2 ready with serialize capability
    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    expect(saveItem?.enabled).toBe(true);

    // Trigger save via click handler
    saveItem?.click?.();
    await flushMicrotasks();

    // Verify serialize message was sent to worker
    const serializeCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'serialize',
    );
    expect(serializeCall).toBeDefined();
    const sentRequestId = (serializeCall?.[0] as { requestId?: string })?.requestId;
    expect(sentRequestId).toBeDefined();
    expect(typeof sentRequestId).toBe('string');

    // Save item should be disabled during operation
    expect(saveItem?.enabled).toBe(false);

    // Worker responds with saveData matching the requestId
    const saveBytes = new Uint8Array([1, 2, 3, 4]);
    worker?.emitMessage({
      kind: 'saveData',
      requestId: sentRequestId!,
      ok: true,
      data: saveBytes,
    });
    await flushMicrotasks();

    // Verify writeSave was called with the data
    expect(writeSaveMock).toHaveBeenCalledWith(saveBytes);

    // Save item should be re-enabled after operation completes
    expect(saveItem?.enabled).toBe(true);

    consoleLog.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('save flow: handles saveData error response without worker-failed transition', async () => {
    setMonotonicNowSequence([0]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    expect(mainWindow).toBeDefined();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    saveItem?.click?.();
    await flushMicrotasks();

    const serializeCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'serialize',
    );
    const sentRequestId = (serializeCall?.[0] as { requestId?: string })?.requestId;

    // Worker responds with error
    worker?.emitMessage({
      kind: 'saveData',
      requestId: sentRequestId!,
      ok: false,
      error: { code: 'SERIALIZE_FAILED', message: 'Serialization failed.', retriable: true },
    });
    await flushMicrotasks();

    // writeSave should NOT have been called
    expect(writeSaveMock).not.toHaveBeenCalled();

    // Worker should NOT be in failed state (no crashed status beyond starting/running)
    const crashedCalls = mainWindow?.webContents.send.mock.calls.filter(
      (call) => call[0] === IPC_CHANNELS.simStatus && (call[1] as { kind?: string })?.kind === 'crashed',
    );
    expect(crashedCalls).toHaveLength(0);

    // Save item should be re-enabled (recoverable)
    expect(saveItem?.enabled).toBe(true);

    consoleError.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('save flow: times out when no matching saveData arrives', async () => {
    vi.useFakeTimers();
    // Provide enough monotonicNowMs values for tick loop calls during the 11s advance
    const tickValues = Array.from({ length: 800 }, (_, i) => i * 16);
    setMonotonicNowSequence(tickValues);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    saveItem?.click?.();
    await flushMicrotasks();

    expect(saveItem?.enabled).toBe(false);

    // Advance past timeout (10s)
    await vi.advanceTimersByTimeAsync(11_000);
    await flushMicrotasks();

    // Save item should be re-enabled after timeout
    expect(saveItem?.enabled).toBe(true);

    // Verify timeout was logged
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('timed out'),
    );

    consoleError.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('ignores unmatched saveData responses without corrupting state', async () => {
    setMonotonicNowSequence([0]);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');

    // Trigger save
    saveItem?.click?.();
    await flushMicrotasks();

    const serializeCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'serialize',
    );
    const sentRequestId = (serializeCall?.[0] as { requestId?: string })?.requestId;

    // Send unmatched saveData response (wrong requestId)
    worker?.emitMessage({
      kind: 'saveData',
      requestId: 'wrong-request-id',
      ok: true,
      data: new Uint8Array([1, 2, 3]),
    });
    await flushMicrotasks();

    // Should be ignored — writeSave not called, operation still locked
    expect(writeSaveMock).not.toHaveBeenCalled();
    expect(saveItem?.enabled).toBe(false);

    // Warn should have been logged for unmatched response
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring unmatched saveData'),
    );

    // Now send the matching response
    worker?.emitMessage({
      kind: 'saveData',
      requestId: sentRequestId!,
      ok: true,
      data: new Uint8Array([4, 5, 6]),
    });
    await flushMicrotasks();

    expect(writeSaveMock).toHaveBeenCalled();
    expect(saveItem?.enabled).toBe(true);

    consoleWarn.mockRestore();
    consoleLog.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('ignores duplicate saveData responses after the first match', async () => {
    setMonotonicNowSequence([0]);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    saveItem?.click?.();
    await flushMicrotasks();

    const serializeCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'serialize',
    );
    const sentRequestId = (serializeCall?.[0] as { requestId?: string })?.requestId;

    // First matching response — consumed
    worker?.emitMessage({
      kind: 'saveData',
      requestId: sentRequestId!,
      ok: true,
      data: new Uint8Array([1]),
    });
    await flushMicrotasks();

    expect(writeSaveMock).toHaveBeenCalledTimes(1);

    // Duplicate response — ignored
    worker?.emitMessage({
      kind: 'saveData',
      requestId: sentRequestId!,
      ok: true,
      data: new Uint8Array([2]),
    });
    await flushMicrotasks();

    // writeSave still only called once
    expect(writeSaveMock).toHaveBeenCalledTimes(1);

    consoleWarn.mockRestore();
    consoleLog.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('load flow: reads save, decodes, validates, sends hydrate, consumes matching hydrateResult', async () => {
    setMonotonicNowSequence([0]);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const saveFormat = {
      version: 1,
      savedAt: 1000,
      resources: {},
      progression: {},
      commandQueue: {},
    };
    const saveBytes = new TextEncoder().encode(JSON.stringify(saveFormat));
    readSaveMock.mockResolvedValueOnce(saveBytes);
    loadGameStateSaveFormatMock.mockReturnValueOnce(saveFormat);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const loadItem = devSubmenu.find((item) => item.label === 'Load');
    expect(loadItem?.enabled).toBe(true);

    // Trigger load
    loadItem?.click?.();
    await flushMicrotasks();

    // readSave should have been called
    expect(readSaveMock).toHaveBeenCalled();
    expect(loadGameStateSaveFormatMock).toHaveBeenCalledWith(saveFormat);

    // Verify hydrate message was sent to worker
    const hydrateCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCall).toBeDefined();
    const hydrateMsg = hydrateCall?.[0] as { requestId?: string; save?: unknown };
    expect(hydrateMsg.requestId).toBeDefined();
    expect(hydrateMsg.save).toEqual(saveFormat);

    // Worker responds with success
    worker?.emitMessage({
      kind: 'hydrateResult',
      requestId: hydrateMsg.requestId!,
      ok: true,
      nextStep: 100,
    });
    await flushMicrotasks();

    // Load item should be re-enabled
    expect(loadItem?.enabled).toBe(true);

    consoleLog.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('load flow: handles hydrateResult error without worker-failed transition', async () => {
    setMonotonicNowSequence([0]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const saveFormat = { version: 1, savedAt: 1000, resources: {}, progression: {}, commandQueue: {} };
    const saveBytes = new TextEncoder().encode(JSON.stringify(saveFormat));
    readSaveMock.mockResolvedValueOnce(saveBytes);
    loadGameStateSaveFormatMock.mockReturnValueOnce(saveFormat);

    await import('./main.js');
    await flushMicrotasks();

    const mainWindow = BrowserWindow.windows[0];
    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const loadItem = devSubmenu.find((item) => item.label === 'Load');
    loadItem?.click?.();
    await flushMicrotasks();

    const hydrateCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    const hydrateMsg = hydrateCall?.[0] as { requestId?: string };

    // Worker responds with error
    worker?.emitMessage({
      kind: 'hydrateResult',
      requestId: hydrateMsg.requestId!,
      ok: false,
      error: { code: 'HYDRATE_FAILED', message: 'Hydration failed.', retriable: true },
    });
    await flushMicrotasks();

    // Not a worker failure — no crashed status
    const crashedCalls = mainWindow?.webContents.send.mock.calls.filter(
      (call) => call[0] === IPC_CHANNELS.simStatus && (call[1] as { kind?: string })?.kind === 'crashed',
    );
    expect(crashedCalls).toHaveLength(0);

    // Load should be re-enabled (recoverable)
    expect(loadItem?.enabled).toBe(true);

    consoleError.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('ignores unmatched hydrateResult responses without corrupting state', async () => {
    setMonotonicNowSequence([0]);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const saveFormat = { version: 1, savedAt: 1000, resources: {}, progression: {}, commandQueue: {} };
    const saveBytes = new TextEncoder().encode(JSON.stringify(saveFormat));
    readSaveMock.mockResolvedValueOnce(saveBytes);
    loadGameStateSaveFormatMock.mockReturnValueOnce(saveFormat);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const loadItem = devSubmenu.find((item) => item.label === 'Load');
    loadItem?.click?.();
    await flushMicrotasks();

    const hydrateCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    const hydrateMsg = hydrateCall?.[0] as { requestId?: string };

    // Send unmatched hydrateResult
    worker?.emitMessage({
      kind: 'hydrateResult',
      requestId: 'wrong-id',
      ok: true,
      nextStep: 999,
    });
    await flushMicrotasks();

    // Operation still locked (unmatched was ignored)
    expect(loadItem?.enabled).toBe(false);
    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('Ignoring unmatched hydrateResult'),
    );

    // Now send matching response
    worker?.emitMessage({
      kind: 'hydrateResult',
      requestId: hydrateMsg.requestId!,
      ok: true,
      nextStep: 50,
    });
    await flushMicrotasks();

    expect(loadItem?.enabled).toBe(true);

    consoleWarn.mockRestore();
    consoleLog.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('offline catch-up dispatch enqueues OFFLINE_CATCHUP with default resourceDeltas', async () => {
    setMonotonicNowSequence([0]);
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 5,
      capabilities: { canSerialize: false, canOfflineCatchup: true },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const catchupItem = devSubmenu.find((item) => item.label === 'Offline Catch-Up');
    expect(catchupItem?.enabled).toBe(true);

    // Save/Load should be disabled (canSerialize = false)
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    expect(saveItem?.enabled).toBe(false);

    // Trigger offline catch-up
    catchupItem?.click?.();
    await flushMicrotasks();

    // Verify enqueueCommands with OFFLINE_CATCHUP command
    const enqueueCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    );

    const catchupEnqueue = enqueueCalls?.find((call) => {
      const msg = call[0] as { commands?: Array<{ type?: string }> };
      return msg.commands?.some((cmd) => cmd.type === RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP);
    });
    expect(catchupEnqueue).toBeDefined();

    const catchupCmd = (catchupEnqueue?.[0] as { commands: Array<{ type: string; payload: unknown; priority: number }> }).commands.find(
      (cmd) => cmd.type === RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
    );
    expect(catchupCmd).toBeDefined();
    expect(catchupCmd?.priority).toBe(0); // CommandPriority.SYSTEM
    expect((catchupCmd?.payload as { resourceDeltas?: unknown })?.resourceDeltas).toEqual({});
    expect(typeof (catchupCmd?.payload as { elapsedMs?: unknown })?.elapsedMs).toBe('number');
    expect((catchupCmd?.payload as { elapsedMs?: number })?.elapsedMs).toBeGreaterThan(0);

    consoleLog.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('disables dev menu actions after worker failure', async () => {
    setMonotonicNowSequence([0]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    // Emit v2 ready with capabilities
    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: true },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    const loadItem = devSubmenu.find((item) => item.label === 'Load');
    const catchupItem = devSubmenu.find((item) => item.label === 'Offline Catch-Up');

    // All enabled before failure
    expect(saveItem?.enabled).toBe(true);
    expect(loadItem?.enabled).toBe(true);
    expect(catchupItem?.enabled).toBe(true);

    // Worker crashes
    worker?.emitExit(1);
    await flushMicrotasks();

    // All disabled after failure
    expect(saveItem?.enabled).toBe(false);
    expect(loadItem?.enabled).toBe(false);
    expect(catchupItem?.enabled).toBe(false);

    consoleError.mockRestore();
  });

  it('load flow: handles no save file gracefully', async () => {
    setMonotonicNowSequence([0]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // readSave returns undefined (no file)
    readSaveMock.mockResolvedValueOnce(undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const loadItem = devSubmenu.find((item) => item.label === 'Load');
    loadItem?.click?.();
    await flushMicrotasks();

    // No hydrate message should be sent (no file)
    const hydrateCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCalls).toHaveLength(0);

    // Load should be re-enabled
    expect(loadItem?.enabled).toBe(true);

    consoleError.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('load flow: handles decode failure gracefully without sending hydrate', async () => {
    setMonotonicNowSequence([0]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // readSave returns invalid bytes (not valid JSON)
    readSaveMock.mockResolvedValueOnce(new Uint8Array([0xFF, 0xFE]));

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const loadItem = devSubmenu.find((item) => item.label === 'Load');
    loadItem?.click?.();
    await flushMicrotasks();

    // No hydrate message should be sent (decode failed)
    const hydrateCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCalls).toHaveLength(0);

    expect(loadItem?.enabled).toBe(true);

    consoleError.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('late saveData after operation cleared via timeout is ignored', async () => {
    vi.useFakeTimers();
    // Provide enough monotonicNowMs values for tick loop calls during the 11s advance
    const tickValues = Array.from({ length: 800 }, (_, i) => i * 16);
    setMonotonicNowSequence(tickValues);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      protocolVersion: 2,
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: { canSerialize: true, canOfflineCatchup: false },
    });
    await flushMicrotasks();

    const devSubmenu = findDevSubmenu();
    const saveItem = devSubmenu.find((item) => item.label === 'Save');
    saveItem?.click?.();
    await flushMicrotasks();

    const serializeCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'serialize',
    );
    const sentRequestId = (serializeCall?.[0] as { requestId?: string })?.requestId;

    // Advance past timeout
    await vi.advanceTimersByTimeAsync(11_000);
    await flushMicrotasks();

    // Now send late saveData
    worker?.emitMessage({
      kind: 'saveData',
      requestId: sentRequestId!,
      ok: true,
      data: new Uint8Array([1]),
    });
    await flushMicrotasks();

    // writeSave should NOT have been called (late response)
    expect(writeSaveMock).not.toHaveBeenCalled();

    consoleError.mockRestore();
    consoleWarn.mockRestore();

    // Cleanup
    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  describe('startup stale temp cleanup', () => {
    it('invokes cleanupStaleTempFiles before save/load operations can run', async () => {
      // Track that cleanup is called before the worker is created (which enables save/load).
      // At cleanup invocation time no worker instances should exist yet.
      let workerCountAtCleanup = -1;
      cleanupStaleTempFilesMock.mockImplementation(async () => {
        workerCountAtCleanup = Worker.instances.length;
      });

      setMonotonicNowSequence([0]);
      await import('./main.js');
      await flushMicrotasks();

      expect(cleanupStaleTempFilesMock).toHaveBeenCalledTimes(1);

      // At cleanup time, no workers should have been created yet
      expect(workerCountAtCleanup).toBe(0);

      // After startup completes, a worker should exist (save/load operations are now possible)
      expect(Worker.instances).toHaveLength(1);

      // Cleanup
      const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
      const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
      windowAllClosedHandler?.();
    });

    it('handles cleanup failure as best-effort without crashing startup', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      const cleanupError = new Error('permission denied');
      cleanupStaleTempFilesMock.mockRejectedValueOnce(cleanupError);

      setMonotonicNowSequence([0]);
      await import('./main.js');
      await flushMicrotasks();

      // Startup should complete despite cleanup failure
      expect(Worker.instances).toHaveLength(1);
      expect(Worker.instances[0]?.postMessage).toHaveBeenCalled();

      // Error should have been logged
      expect(consoleError).toHaveBeenCalledWith(
        '[shell-desktop] Stale temp cleanup failed (non-fatal):',
        cleanupError,
      );

      consoleError.mockRestore();

      // Cleanup
      const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
      const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
      windowAllClosedHandler?.();
    });
  });
});
