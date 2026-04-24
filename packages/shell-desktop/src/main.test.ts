import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CommandPriority, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import type { createControlCommands as CreateControlCommandsFn } from '@idle-engine/controls';
import { IPC_CHANNELS, SHELL_CONTROL_EVENT_COMMAND_TYPE } from './ipc.js';
import type { DiagnosticsMcpController } from './mcp/diagnostics-tools.js';
import type { InputMcpController } from './mcp/input-tools.js';
import type { ShellDesktopMcpServer } from './mcp/mcp-server.js';
import { SIM_MCP_MAX_STEP_COUNT, type SimMcpController } from './mcp/sim-tools.js';

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

type MenuEntry = {
  label?: string;
  submenu?: MenuEntry[];
  enabled?: boolean;
  click?: () => unknown;
  role?: string;
  type?: string;
};

function getLatestMenuTemplate(): MenuEntry[] {
  const latestMenuCall = Menu.setApplicationMenu.mock.calls.at(-1);
  if (!latestMenuCall) {
    throw new Error('Expected application menu to be installed');
  }

  return latestMenuCall[0] as MenuEntry[];
}

function getMenuEntry(path: readonly string[]): MenuEntry {
  let currentEntries = getLatestMenuTemplate();
  let currentEntry: MenuEntry | undefined;

  for (const label of path) {
    currentEntry = currentEntries.find((entry) => entry.label === label);
    if (!currentEntry) {
      throw new Error(`Menu entry not found: ${path.join(' > ')}`);
    }
    currentEntries = currentEntry.submenu ?? [];
  }

  return currentEntry!;
}

function getRegisteredMcpControllers(): {
  sim: SimMcpController;
  input: InputMcpController;
} {
  const registrationCalls = maybeStartShellDesktopMcpServer.mock.calls as unknown as Array<
    [{
      sim?: SimMcpController;
      input?: InputMcpController;
    }?]
  >;
  const registration = registrationCalls[0]?.[0] as
    | {
        sim?: SimMcpController;
        input?: InputMcpController;
      }
    | undefined;

  if (!registration?.sim || !registration.input) {
    throw new Error('Expected MCP controllers to be registered');
  }

  return {
    sim: registration.sim,
    input: registration.input,
  };
}

const app = {
  isPackaged: false,
  name: 'idle-engine',
  commandLine: { appendSwitch: vi.fn() },
  getPath: vi.fn(() => path.join('C:', 'mock-user-data')),
  getVersion: vi.fn(() => '0.1.0'),
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
  static constructorOptions: unknown[] = [];
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

  constructor(options: unknown) {
    BrowserWindow.constructorOptions.push(options);
    BrowserWindow.windows.push(this);
  }
}

vi.mock('electron', () => ({
  app,
  BrowserWindow,
  ipcMain,
  Menu,
}));

const fsPromises: {
  readFile: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  unlink: ReturnType<typeof vi.fn>;
} = {
  readFile: vi.fn(async () => Buffer.from([1, 2, 3])),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  rename: vi.fn(async () => undefined),
  unlink: vi.fn(async () => undefined),
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

const maybeStartShellDesktopMcpServer = vi.fn(async () => undefined as ShellDesktopMcpServer | undefined);

vi.mock('./mcp/mcp-server.js', () => ({
  maybeStartShellDesktopMcpServer,
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
  const originalEnableMcpServer = process.env.IDLE_ENGINE_ENABLE_MCP_SERVER;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    app.isPackaged = false;
    BrowserWindow.windows = [];
    BrowserWindow.constructorOptions = [];
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

    if (originalEnableMcpServer === undefined) {
      delete process.env.IDLE_ENGINE_ENABLE_MCP_SERVER;
    } else {
      process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = originalEnableMcpServer;
    }

    app.getPath.mockReturnValue(path.join('C:', 'mock-user-data'));
    app.getVersion.mockReturnValue('0.1.0');
    fsPromises.readFile.mockImplementation(async () => Buffer.from([1, 2, 3]));
    fsPromises.mkdir.mockImplementation(async () => undefined);
    fsPromises.writeFile.mockImplementation(async () => undefined);
    fsPromises.rename.mockImplementation(async () => undefined);
    fsPromises.unlink.mockImplementation(async () => undefined);
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

    if (originalEnableMcpServer === undefined) {
      delete process.env.IDLE_ENGINE_ENABLE_MCP_SERVER;
    } else {
      process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = originalEnableMcpServer;
    }
  });

  it('registers the ping IPC handler and enables WebGPU switch', async () => {
    await import('./main.js');
    await flushMicrotasks();

    expect(app.commandLine.appendSwitch).toHaveBeenCalledWith('enable-unsafe-webgpu');
    expect(maybeStartShellDesktopMcpServer).not.toHaveBeenCalled();

    const handlerCall = ipcMain.handle.mock.calls.find((call) => call[0] === IPC_CHANNELS.ping);
    expect(handlerCall).toBeDefined();

    const handler = handlerCall?.[1] as undefined | ((event: unknown, request: unknown) => Promise<unknown>);
    expect(handler).toBeTypeOf('function');

    await expect(handler?.({}, { message: 'hello' })).resolves.toEqual({ message: 'hello' });
    await expect(handler?.({}, { message: 123 })).rejects.toThrow(TypeError);
    await expect(handler?.({}, null)).rejects.toThrow(TypeError);
    await expect(handler?.({}, [])).rejects.toThrow(TypeError);
  }, 15000);

  it('uses a sandboxed CommonJS preload tuple', async () => {
    await import('./main.js');
    await flushMicrotasks();

    const options = BrowserWindow.constructorOptions[0] as
      | { webPreferences?: { sandbox?: boolean; preload?: string } }
      | undefined;

    expect(options?.webPreferences?.sandbox).toBe(true);
    expect(path.basename(options?.webPreferences?.preload ?? '')).toBe('preload.cjs');
  });

  it('starts the MCP server when enabled', async () => {
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';

    await import('./main.js');
    await flushMicrotasks();

    expect(maybeStartShellDesktopMcpServer).toHaveBeenCalledTimes(1);
  });

  it('logs and swallows MCP close failures during window-all-closed shutdown', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
      enumerable: true,
      writable: false,
    });
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';
    const close = vi.fn(async () => {
      throw new Error('mcp close failed');
    });
    maybeStartShellDesktopMcpServer.mockResolvedValueOnce({
      url: new URL('http://127.0.0.1:8570/mcp'),
      close,
    } satisfies ShellDesktopMcpServer);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await import('./main.js');
      await flushMicrotasks();

      const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
      const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
      windowAllClosedHandler?.();
      await flushMicrotasks();

      expect(close).toHaveBeenCalledTimes(1);
      expect(app.quit).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ message: 'mcp close failed' }));
    } finally {
      consoleError.mockRestore();
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        enumerable: true,
        writable: false,
      });
    }
  });

  it('closes MCP server during before-quit and logs close failures', async () => {
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';
    const close = vi.fn(async () => {
      throw new Error('before-quit close failed');
    });
    maybeStartShellDesktopMcpServer.mockResolvedValueOnce({
      url: new URL('http://127.0.0.1:8570/mcp'),
      close,
    } satisfies ShellDesktopMcpServer);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const beforeQuitCall = app.on.mock.calls.find((call) => call[0] === 'before-quit');
    const beforeQuitHandler = beforeQuitCall?.[1] as undefined | (() => void);
    beforeQuitHandler?.();
    await flushMicrotasks();

    expect(close).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(expect.objectContaining({ message: 'before-quit close failed' }));

    consoleError.mockRestore();
  });

  it('captures renderer diagnostics and structured renderer logs for MCP tools', async () => {
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';

    await import('./main.js');
    await flushMicrotasks();

    const maybeStartCalls = maybeStartShellDesktopMcpServer.mock.calls as unknown as Array<[
      { diagnostics?: DiagnosticsMcpController }?,
    ]>;
    const diagnostics = maybeStartCalls[0]?.[0]?.diagnostics;
    if (!diagnostics) {
      throw new Error('Expected MCP diagnostics controller to be registered');
    }

    const diagnosticsHandlerCall = ipcMain.on.mock.calls.find(
      (call) => call[0] === IPC_CHANNELS.rendererDiagnostics,
    );
    const diagnosticsHandler = diagnosticsHandlerCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);
    expect(diagnosticsHandler).toBeTypeOf('function');

    const logHandlerCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.rendererLog);
    const logHandler = logHandlerCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);
    expect(logHandler).toBeTypeOf('function');

    diagnosticsHandler?.({}, null);
    logHandler?.({}, null);

    diagnosticsHandler?.({}, {
      outputText: 'IPC ok\nSim running\nWebGPU ok.',
      rendererState: 'running',
      webgpu: { status: 'ok' },
    });
    logHandler?.({}, {
      severity: 'warn',
      subsystem: 'webgpu',
      message: 'WebGPU device lost',
      metadata: { reason: 'test-loss' },
    });

    expect(diagnostics.getRendererStatus()).toEqual(expect.objectContaining({
      outputText: 'IPC ok\nSim running\nWebGPU ok.',
      rendererState: 'running',
    }));
    expect(diagnostics.getWebGpuHealth()).toEqual(expect.objectContaining({ status: 'ok' }));
    expect(diagnostics.getLogs()).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: 'renderer',
        subsystem: 'webgpu',
        severity: 'warn',
        message: 'WebGPU device lost',
      }),
    ]));

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('steps simulation in bounded batches and returns status after worker progress', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';

    await import('./main.js');
    await flushMicrotasks();

    const maybeStartCalls = maybeStartShellDesktopMcpServer.mock.calls as unknown as Array<[{ sim?: SimMcpController }?]>;
    const sim = maybeStartCalls[0]?.[0]?.sim;
    if (!sim) {
      throw new Error('Expected MCP sim controller to be registered');
    }

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();

    worker?.postMessage.mockClear();

    const stepPromise = sim.step(120);

    const tickCalls = worker?.postMessage.mock.calls
      .map((call) => call[0] as { kind?: string; deltaMs?: number })
      .filter((message) => message.kind === 'tick');

    expect(tickCalls?.map((message) => message.deltaMs)).toEqual([800, 800, 320]);

    let stepSettled = false;
    void stepPromise.then(() => {
      stepSettled = true;
    });
    await flushMicrotasks();
    expect(stepSettled).toBe(false);

    worker?.emitMessage({ kind: 'frame', droppedFrames: 0, nextStep: 50 });
    await flushMicrotasks();
    expect(stepSettled).toBe(false);

    worker?.emitMessage({ kind: 'frame', droppedFrames: 0, nextStep: 100 });
    await flushMicrotasks();
    expect(stepSettled).toBe(false);

    worker?.emitMessage({ kind: 'frame', droppedFrames: 0, nextStep: 120 });

    await expect(stepPromise).resolves.toEqual({
      state: 'paused',
      stepSizeMs: 16,
      nextStep: 120,
    });

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('rejects an in-flight sim.step before load hydration can be overtaken by a stale frame', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16, 32]);
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';

    await import('./main.js');
    await flushMicrotasks();

    const { sim } = getRegisteredMcpControllers();
    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: true,
        saveFileStem: 'content-dev',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks();

    const stepPromise = sim.step(1);

    fsPromises.readFile.mockImplementationOnce(
      async () =>
        JSON.stringify({
          schemaVersion: 1,
          metadata: {
            savedAt: '2026-03-12T21:00:00.000Z',
            appVersion: '0.1.0',
            runtime: {
              saveFileStem: 'content-dev',
              saveSchemaVersion: 1,
              contentHash: 'content:dev',
              contentVersion: 'dev',
            },
          },
          state: {
            schemaVersion: 1,
            nextStep: 9,
            demoState: {
              tickCount: 9,
              resourceCount: 5,
              lastCollectedStep: 8,
            },
            accumulatorBacklogMs: 0,
            pendingCommands: {
              schemaVersion: 1,
              entries: [],
            },
          },
        }) as unknown as Buffer,
    );

    getMenuEntry(['Simulation', 'Load']).click?.();
    await flushMicrotasks(20);

    const hydrateCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCall).toBeDefined();

    worker?.emitMessage({ kind: 'frame', droppedFrames: 0, nextStep: 1 });
    await expect(stepPromise).rejects.toThrow('Simulation step was interrupted by state load.');

    worker?.emitMessage({
      kind: 'hydrated',
      requestId: (hydrateCall?.[0] as { requestId?: string }).requestId ?? '',
      nextStep: 9,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: true,
        saveFileStem: 'content-dev',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks(20);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('rejects sim.step values above the MCP step bound', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';

    await import('./main.js');
    await flushMicrotasks();

    const maybeStartCalls = maybeStartShellDesktopMcpServer.mock.calls as unknown as Array<[{ sim?: SimMcpController }?]>;
    const sim = maybeStartCalls[0]?.[0]?.sim;
    if (!sim) {
      throw new Error('Expected MCP sim controller to be registered');
    }

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();
    worker?.postMessage.mockClear();

    await expect(sim.step(SIM_MCP_MAX_STEP_COUNT + 1)).rejects.toThrow(
      `Invalid sim step count: expected integer in [1, ${SIM_MCP_MAX_STEP_COUNT}]`,
    );

    const tickCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'tick',
    ) ?? [];
    expect(tickCalls).toHaveLength(0);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
  });

  it('rejects sim.enqueue when the worker has crashed', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const maybeStartCalls = maybeStartShellDesktopMcpServer.mock.calls as unknown as Array<[{ sim?: SimMcpController }?]>;
    const sim = maybeStartCalls[0]?.[0]?.sim;
    if (!sim) {
      throw new Error('Expected MCP sim controller to be registered');
    }

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();
    worker?.emitExit(1);
    await flushMicrotasks();

    expect(sim.getStatus().state).toBe('crashed');

    worker?.postMessage.mockClear();
    expect(() => sim.enqueue([
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        payload: { resourceId: 'sample-pack.energy', amount: 1 },
        priority: CommandPriority.PLAYER,
        step: 0,
        timestamp: 0,
      },
    ])).toThrow('Simulation is crashed; cannot enqueue commands.');

    const enqueueCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    ) ?? [];
    expect(enqueueCalls).toHaveLength(0);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();

    consoleError.mockRestore();
  });

  it('recreates the sim worker when sim.start is called after a crash', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await import('./main.js');
    await flushMicrotasks();

    const maybeStartCalls = maybeStartShellDesktopMcpServer.mock.calls as unknown as Array<[{ sim?: SimMcpController }?]>;
    const sim = maybeStartCalls[0]?.[0]?.sim;
    if (!sim) {
      throw new Error('Expected MCP sim controller to be registered');
    }

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({ kind: 'ready', stepSizeMs: 16, nextStep: 0 });
    await flushMicrotasks();
    worker?.emitExit(1);
    await flushMicrotasks();

    expect(sim.getStatus().state).toBe('crashed');

    const restartedStatus = sim.start();
    expect(restartedStatus.state).toBe('starting');
    expect(Worker.instances).toHaveLength(2);
    expect(sim.getStatus().state).toBe('starting');

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();

    consoleError.mockRestore();
  });

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

  it('enables simulation tooling menu items when the worker reports support', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: true,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks();

    expect(getMenuEntry(['Simulation', 'Save']).enabled).toBe(true);
    expect(getMenuEntry(['Simulation', 'Load']).enabled).toBe(true);
    expect(getMenuEntry(['Simulation', 'Offline Catch-up: 5 Minutes']).enabled).toBe(true);
    expect(getMenuEntry(['Simulation', 'Offline Catch-up: 1 Hour']).enabled).toBe(true);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();
  });

  it('disables simulation tooling menu items after the last darwin window closes', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
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

      const worker = Worker.instances[0];
      expect(worker).toBeDefined();

      worker?.emitMessage({
        kind: 'ready',
        stepSizeMs: 16,
        nextStep: 0,
        capabilities: {
          canSerialize: true,
          canHydrate: true,
          supportsOfflineCatchup: true,
          saveFileStem: 'sample-pack',
          saveSchemaVersion: 1,
          contentHash: 'content:dev',
          contentVersion: 'dev',
        },
      });
      await flushMicrotasks();

      expect(getMenuEntry(['Simulation', 'Save']).enabled).toBe(true);
      expect(getMenuEntry(['Simulation', 'Load']).enabled).toBe(true);

      const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
      const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
      windowAllClosedHandler?.();
      await flushMicrotasks();

      expect(getMenuEntry(['Simulation', 'Save']).enabled).toBe(false);
      expect(getMenuEntry(['Simulation', 'Load']).enabled).toBe(false);
      expect(getMenuEntry(['Simulation', 'Offline Catch-up: 5 Minutes']).enabled).toBe(false);
      expect(app.quit).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', {
        value: originalPlatform,
        configurable: true,
        enumerable: true,
        writable: false,
      });
    }
  });

  it('enables save and load independently based on reported capabilities', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 0,
      capabilities: {
        canSerialize: true,
        canHydrate: false,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
      },
    });
    await flushMicrotasks();

    expect(getMenuEntry(['Simulation', 'Save']).enabled).toBe(true);
    expect(getMenuEntry(['Simulation', 'Load']).enabled).toBe(false);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();
  });

  it('freezes IPC and MCP command ingress while save is in flight', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';

    await import('./main.js');
    await flushMicrotasks();

    const { input, sim } = getRegisteredMcpControllers();
    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 4,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: true,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks();

    const controlEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.controlEvent);
    const controlEventHandler = controlEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);
    const inputEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.inputEvent);
    const inputEventHandler = inputEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);
    expect(controlEventHandler).toBeTypeOf('function');
    expect(inputEventHandler).toBeTypeOf('function');

    worker?.postMessage.mockClear();
    getMenuEntry(['Simulation', 'Save']).click?.();
    await flushMicrotasks();

    const serializeCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'serialize',
    );
    expect(serializeCall).toBeDefined();

    controlEventHandler?.({}, { intent: 'collect', phase: 'start' });
    inputEventHandler?.({}, {
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
    });

    expect(() => input.sendControlEvent({ intent: 'collect', phase: 'start' }))
      .toThrow('Simulation save/load is in progress.');

    const status = sim.getStatus();
    expect(() => sim.enqueue([
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        payload: { resourceId: 'demo', amount: 1 },
        priority: CommandPriority.PLAYER,
        step: status.nextStep,
        timestamp: status.nextStep * status.stepSizeMs,
      },
    ])).toThrow('Simulation save/load is in progress.');

    await expect(sim.step(1)).rejects.toThrow('Simulation save/load is in progress.');
    expect(() => sim.pause()).toThrow('Simulation save/load is in progress.');

    const enqueueCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    );
    expect(enqueueCalls).toHaveLength(0);

    worker?.emitMessage({
      kind: 'serialized',
      requestId: (serializeCall?.[0] as { requestId: string }).requestId,
      state: {
        schemaVersion: 1,
        nextStep: 4,
        demoState: {
          tickCount: 4,
          resourceCount: 2,
          lastCollectedStep: 3,
        },
      },
    });
    await flushMicrotasks(20);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();
  });

  it('publishes a hydrated frame immediately when load completes while paused', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';
    const savedEnvelope = {
      schemaVersion: 1,
      metadata: {
        savedAt: '2026-03-12T21:00:00.000Z',
        appVersion: '0.1.0',
        runtime: {
          saveFileStem: 'sample-pack',
          saveSchemaVersion: 1,
          contentHash: 'content:dev',
          contentVersion: 'dev',
        },
      },
      state: {
        schemaVersion: 1,
        nextStep: 9,
        demoState: {
          tickCount: 9,
          resourceCount: 5,
          lastCollectedStep: 8,
        },
      },
    };
    const hydratedFrame = {
      frame: {
        schemaVersion: 1,
        step: 9,
        simTimeMs: 144,
        contentHash: 'content:dev',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [],
      draws: [],
    };
    fsPromises.readFile.mockImplementationOnce(
      async () => JSON.stringify(savedEnvelope) as unknown as Buffer,
    );

    await import('./main.js');
    await flushMicrotasks();

    const { sim } = getRegisteredMcpControllers();
    const mainWindow = BrowserWindow.windows[0];
    const worker = Worker.instances[0];
    expect(mainWindow).toBeDefined();
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 2,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks();

    sim.pause();
    worker?.postMessage.mockClear();
    mainWindow?.webContents.send.mockClear();

    getMenuEntry(['Simulation', 'Load']).click?.();
    await flushMicrotasks();

    const hydrateCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCall).toBeDefined();

    worker?.emitMessage({
      kind: 'hydrated',
      requestId: (hydrateCall?.[0] as { requestId: string }).requestId,
      nextStep: 9,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
      frame: hydratedFrame,
    });
    await flushMicrotasks(20);

    expect(mainWindow?.webContents.send).toHaveBeenCalledWith(
      IPC_CHANNELS.frame,
      hydratedFrame,
    );

    await vi.advanceTimersByTimeAsync(64);
    const tickCalls = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'tick',
    );
    expect(tickCalls).toHaveLength(0);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();
  });

  it('rejects pending sim.step waiters when load completes and retargets later steps', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';
    const savedEnvelope = {
      schemaVersion: 1,
      metadata: {
        savedAt: '2026-03-12T21:00:00.000Z',
        appVersion: '0.1.0',
        runtime: {
          saveFileStem: 'sample-pack',
          saveSchemaVersion: 1,
          contentHash: 'content:dev',
          contentVersion: 'dev',
        },
      },
      state: {
        schemaVersion: 1,
        nextStep: 9,
        demoState: {
          tickCount: 9,
          resourceCount: 5,
          lastCollectedStep: 8,
        },
      },
    };
    fsPromises.readFile.mockImplementationOnce(
      async () => JSON.stringify(savedEnvelope) as unknown as Buffer,
    );

    await import('./main.js');
    await flushMicrotasks();

    const { sim } = getRegisteredMcpControllers();
    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 2,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks();

    worker?.postMessage.mockClear();

    const interruptedStepPromise = sim.step(3);

    let interruptedStepSettled = false;
    void interruptedStepPromise.then(() => {
      interruptedStepSettled = true;
    }, () => {
      interruptedStepSettled = true;
    });
    await flushMicrotasks();
    expect(interruptedStepSettled).toBe(false);

    getMenuEntry(['Simulation', 'Load']).click?.();
    await flushMicrotasks();

    const hydrateCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCall).toBeDefined();

    worker?.emitMessage({
      kind: 'hydrated',
      requestId: (hydrateCall?.[0] as { requestId: string }).requestId,
      nextStep: 9,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });

    await expect(interruptedStepPromise).rejects.toThrow('Simulation step was interrupted by state load.');

    worker?.postMessage.mockClear();

    const resumedStepPromise = sim.step(2);
    let resumedStepSettled = false;
    void resumedStepPromise.then(() => {
      resumedStepSettled = true;
    }, () => {
      resumedStepSettled = true;
    });
    await flushMicrotasks();
    expect(resumedStepSettled).toBe(false);

    worker?.emitMessage({ kind: 'frame', droppedFrames: 0, nextStep: 10 });
    await flushMicrotasks();
    expect(resumedStepSettled).toBe(false);

    worker?.emitMessage({ kind: 'frame', droppedFrames: 0, nextStep: 11 });
    await expect(resumedStepPromise).resolves.toEqual({
      state: 'paused',
      stepSizeMs: 16,
      nextStep: 11,
    });

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();
  });

  it('rejects pending sim.step waiters before load reads the save file', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';
    const savedEnvelope = {
      schemaVersion: 1,
      metadata: {
        savedAt: '2026-03-12T21:00:00.000Z',
        appVersion: '0.1.0',
        runtime: {
          saveFileStem: 'sample-pack',
          saveSchemaVersion: 1,
          contentHash: 'content:dev',
          contentVersion: 'dev',
        },
      },
      state: {
        schemaVersion: 1,
        nextStep: 9,
        demoState: {
          tickCount: 9,
          resourceCount: 5,
          lastCollectedStep: 8,
        },
      },
    };

    let resolveReadFile: ((value: Buffer) => void) | undefined;
    fsPromises.readFile.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveReadFile = (value) => resolve(value);
      }),
    );

    await import('./main.js');
    await flushMicrotasks();

    const { sim } = getRegisteredMcpControllers();
    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 2,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks();

    worker?.postMessage.mockClear();

    const interruptedStepResult = sim.step(3).then(
      (status) => ({ status }),
      (error: unknown) => ({ error }),
    );
    await flushMicrotasks();

    getMenuEntry(['Simulation', 'Load']).click?.();
    await flushMicrotasks();

    const hydrateCallsBeforeReadCompletes = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCallsBeforeReadCompletes).toHaveLength(0);

    worker?.emitMessage({ kind: 'frame', droppedFrames: 0, nextStep: 5 });

    await expect(interruptedStepResult).resolves.toEqual({
      error: expect.objectContaining({
        message: 'Simulation step was interrupted by state load.',
      }),
    });

    resolveReadFile?.(Buffer.from(JSON.stringify(savedEnvelope)));
    await flushMicrotasks();

    const hydrateCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCall).toBeDefined();

    worker?.emitMessage({
      kind: 'hydrated',
      requestId: (hydrateCall?.[0] as { requestId: string }).requestId,
      nextStep: 9,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks(20);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();
  });

  it('writes saves atomically after requesting worker serialization', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 4,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 3,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks();

    getMenuEntry(['Simulation', 'Save']).click?.();
    await flushMicrotasks();

    const serializeCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'serialize',
    );
    expect(serializeCall).toBeDefined();

    const requestId = (serializeCall?.[0] as { requestId: string }).requestId;
    worker?.emitMessage({
      kind: 'serialized',
      requestId,
      state: {
        schemaVersion: 1,
        nextStep: 4,
        demoState: {
          tickCount: 12,
          resourceCount: 7,
          lastCollectedStep: 3,
        },
      },
    });
    await flushMicrotasks(20);

    expect(fsPromises.mkdir).toHaveBeenCalledWith(path.join('C:', 'mock-user-data'), { recursive: true });
    expect(fsPromises.writeFile).toHaveBeenCalledTimes(1);
    expect(fsPromises.rename).toHaveBeenCalledTimes(1);

    const [tempPath, rawSave, encoding] =
      fsPromises.writeFile.mock.calls[0] as unknown as [string, string, string];
    expect(tempPath).toMatch(/sample-pack\.save\.json\.\d+\.\d+\.tmp$/);
    expect(encoding).toBe('utf8');

    const savedEnvelope = JSON.parse(rawSave);
    expect(savedEnvelope).toMatchObject({
      schemaVersion: 1,
      metadata: {
        appVersion: '0.1.0',
        runtime: {
          saveFileStem: 'sample-pack',
          saveSchemaVersion: 3,
          contentHash: 'content:dev',
          contentVersion: 'dev',
        },
      },
      state: {
        schemaVersion: 1,
        nextStep: 4,
        demoState: {
          tickCount: 12,
          resourceCount: 7,
          lastCollectedStep: 3,
        },
      },
    });

    expect(fsPromises.rename).toHaveBeenCalledWith(
      tempPath,
      path.join('C:', 'mock-user-data', 'sample-pack.save.json'),
    );

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();
  });

  it('loads a saved envelope and hydrates the worker state', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);
    const savedEnvelope = {
      schemaVersion: 1,
      metadata: {
        savedAt: '2026-03-12T21:00:00.000Z',
        appVersion: '0.1.0',
        runtime: {
          saveFileStem: 'sample-pack',
          saveSchemaVersion: 1,
          contentHash: 'content:dev',
          contentVersion: 'dev',
        },
      },
      state: {
        schemaVersion: 1,
        nextStep: 9,
        demoState: {
          tickCount: 9,
          resourceCount: 5,
          lastCollectedStep: 8,
        },
      },
    };
    fsPromises.readFile.mockImplementationOnce(
      async () => JSON.stringify(savedEnvelope) as unknown as Buffer,
    );

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 2,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks();

    getMenuEntry(['Simulation', 'Load']).click?.();
    await flushMicrotasks();

    expect(fsPromises.readFile).toHaveBeenCalledWith(
      path.join('C:', 'mock-user-data', 'sample-pack.save.json'),
      'utf8',
    );

    const hydrateCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCall).toBeDefined();
    expect(hydrateCall?.[0]).toMatchObject({
      kind: 'hydrate',
      state: savedEnvelope.state,
    });

    const requestId = (hydrateCall?.[0] as { requestId: string }).requestId;
    worker?.emitMessage({
      kind: 'hydrated',
      requestId,
      nextStep: 9,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks(20);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();
  });

  it('freezes command ingress before load reads the save file', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);
    process.env.IDLE_ENGINE_ENABLE_MCP_SERVER = '1';

    const savedEnvelope = {
      schemaVersion: 1,
      metadata: {
        savedAt: '2026-03-12T21:00:00.000Z',
        appVersion: '0.1.0',
        runtime: {
          saveFileStem: 'sample-pack',
          saveSchemaVersion: 1,
          contentHash: 'content:dev',
          contentVersion: 'dev',
        },
      },
      state: {
        schemaVersion: 1,
        nextStep: 9,
        demoState: {
          tickCount: 9,
          resourceCount: 5,
          lastCollectedStep: 8,
        },
      },
    };

    let resolveReadFile: ((value: Buffer) => void) | undefined;
    fsPromises.readFile.mockImplementationOnce(
      () => new Promise((resolve) => {
        resolveReadFile = (value) => resolve(value);
      }),
    );

    await import('./main.js');
    await flushMicrotasks();

    const { sim, input } = getRegisteredMcpControllers();
    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 2,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks();

    const controlEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.controlEvent);
    const controlEventHandler = controlEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);
    const inputEventCall = ipcMain.on.mock.calls.find((call) => call[0] === IPC_CHANNELS.inputEvent);
    const inputEventHandler = inputEventCall?.[1] as undefined | ((event: unknown, payload: unknown) => void);
    expect(controlEventHandler).toBeTypeOf('function');
    expect(inputEventHandler).toBeTypeOf('function');

    worker?.postMessage.mockClear();

    getMenuEntry(['Simulation', 'Load']).click?.();
    await flushMicrotasks();

    expect(fsPromises.readFile).toHaveBeenCalledWith(
      path.join('C:', 'mock-user-data', 'sample-pack.save.json'),
      'utf8',
    );

    const hydrateCallsBeforeReadCompletes = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCallsBeforeReadCompletes).toHaveLength(0);

    expect(() => input.sendControlEvent({ intent: 'collect', phase: 'start' }))
      .toThrow('Simulation save/load is in progress.');

    const status = sim.getStatus();
    expect(() => sim.enqueue([
      {
        type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
        payload: { resourceId: 'demo', amount: 1 },
        priority: CommandPriority.PLAYER,
        step: status.nextStep,
        timestamp: status.nextStep * status.stepSizeMs,
      },
    ])).toThrow('Simulation save/load is in progress.');

    controlEventHandler?.({}, { intent: 'collect', phase: 'start' });
    inputEventHandler?.({}, {
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
    });

    const enqueueCallsWhileReadPending = worker?.postMessage.mock.calls.filter(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    );
    expect(enqueueCallsWhileReadPending).toHaveLength(0);

    resolveReadFile?.(Buffer.from(JSON.stringify(savedEnvelope)));
    await flushMicrotasks();

    const hydrateCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
    );
    expect(hydrateCall).toBeDefined();

    worker?.emitMessage({
      kind: 'hydrated',
      requestId: (hydrateCall?.[0] as { requestId: string }).requestId,
      nextStep: 9,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks(20);

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();
  });

  it('sanitizes save paths and cleans up temp files when atomic save writes fail', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fsPromises.rename.mockImplementationOnce(async () => {
      throw new Error('rename failed');
    });

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 4,
      capabilities: {
        canSerialize: true,
        canHydrate: false,
        supportsOfflineCatchup: false,
        saveFileStem: '  sample pack !!!  ',
      },
    });
    await flushMicrotasks();

    getMenuEntry(['Simulation', 'Save']).click?.();
    await flushMicrotasks();

    const serializeCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'serialize',
    );
    expect(serializeCall).toBeDefined();

    const requestId = (serializeCall?.[0] as { requestId: string }).requestId;
    worker?.emitMessage({
      kind: 'serialized',
      requestId,
      state: {
        schemaVersion: 1,
        nextStep: 4,
        demoState: {
          tickCount: 12,
          resourceCount: 7,
          lastCollectedStep: 3,
        },
      },
    });
    await flushMicrotasks(20);

    const [tempPath, rawSave] =
      fsPromises.writeFile.mock.calls[0] as unknown as [string, string];
    expect(tempPath).toMatch(/sample-pack\.save\.json\.\d+\.\d+\.tmp$/);
    expect(fsPromises.rename).toHaveBeenCalledWith(
      tempPath,
      path.join('C:', 'mock-user-data', 'sample-pack.save.json'),
    );
    expect(fsPromises.unlink).toHaveBeenCalledWith(tempPath);

    const savedEnvelope = JSON.parse(rawSave);
    expect(savedEnvelope.metadata.runtime).toEqual({
      saveFileStem: 'sample-pack',
      saveSchemaVersion: 1,
    });

    const errorCall = consoleError.mock.calls.at(-1);
    const errorValue = errorCall?.[1];
    const errorMessage = errorValue instanceof Error ? errorValue.message : String(errorValue);
    expect(errorCall?.[0]).toContain('[shell-desktop] Save state failed');
    expect(errorMessage).toContain('rename failed');

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();

    consoleError.mockRestore();
  });

  it('rejects invalid and incompatible save envelopes before hydrating', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence(Array.from({ length: 32 }, (_value, index) => index * 16));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const baseEnvelope = {
      schemaVersion: 1,
      metadata: {
        savedAt: '2026-03-12T21:00:00.000Z',
        appVersion: '0.1.0',
        runtime: {
          saveFileStem: 'sample-pack',
          saveSchemaVersion: 1,
          contentHash: 'content:dev',
          contentVersion: 'dev',
        },
      },
      state: {
        schemaVersion: 1,
        nextStep: 9,
        demoState: {
          tickCount: 9,
          resourceCount: 5,
          lastCollectedStep: 8,
        },
      },
    };

    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 16,
      nextStep: 2,
      capabilities: {
        canSerialize: true,
        canHydrate: true,
        supportsOfflineCatchup: false,
        saveFileStem: 'sample-pack',
        saveSchemaVersion: 1,
        contentHash: 'content:dev',
        contentVersion: 'dev',
      },
    });
    await flushMicrotasks();

    const cases = [
      {
        description: 'shell schema mismatch',
        raw: JSON.stringify({ ...baseEnvelope, schemaVersion: 2 }),
        error: 'Unsupported shell save schema version',
      },
      {
        description: 'blank savedAt',
        raw: JSON.stringify({
          ...baseEnvelope,
          metadata: { ...baseEnvelope.metadata, savedAt: '' },
        }),
        error: 'metadata.savedAt',
      },
      {
        description: 'missing runtime metadata',
        raw: JSON.stringify({
          ...baseEnvelope,
          metadata: { ...baseEnvelope.metadata, runtime: null },
        }),
        error: 'metadata.runtime object',
      },
      {
        description: 'blank save file stem',
        raw: JSON.stringify({
          ...baseEnvelope,
          metadata: {
            ...baseEnvelope.metadata,
            runtime: { ...baseEnvelope.metadata.runtime, saveFileStem: '' },
          },
        }),
        error: 'saveFileStem',
      },
      {
        description: 'invalid save schema version',
        raw: JSON.stringify({
          ...baseEnvelope,
          metadata: {
            ...baseEnvelope.metadata,
            runtime: { ...baseEnvelope.metadata.runtime, saveSchemaVersion: 0 },
          },
        }),
        error: 'saveSchemaVersion',
      },
      {
        description: 'invalid content hash type',
        raw: JSON.stringify({
          ...baseEnvelope,
          metadata: {
            ...baseEnvelope.metadata,
            runtime: { ...baseEnvelope.metadata.runtime, contentHash: 42 },
          },
        }),
        error: 'contentHash',
      },
      {
        description: 'invalid content version type',
        raw: JSON.stringify({
          ...baseEnvelope,
          metadata: {
            ...baseEnvelope.metadata,
            runtime: { ...baseEnvelope.metadata.runtime, contentVersion: 42 },
          },
        }),
        error: 'contentVersion',
      },
      {
        description: 'missing state payload',
        raw: JSON.stringify({
          schemaVersion: 1,
          metadata: baseEnvelope.metadata,
        }),
        error: 'persisted state payload',
      },
      {
        description: 'identity mismatch',
        raw: JSON.stringify({
          ...baseEnvelope,
          metadata: {
            ...baseEnvelope.metadata,
            runtime: { ...baseEnvelope.metadata.runtime, saveFileStem: 'other-pack' },
          },
        }),
        error: 'Save identity mismatch',
      },
      {
        description: 'runtime schema mismatch',
        raw: JSON.stringify({
          ...baseEnvelope,
          metadata: {
            ...baseEnvelope.metadata,
            runtime: { ...baseEnvelope.metadata.runtime, saveSchemaVersion: 2 },
          },
        }),
        error: 'Save schema mismatch',
      },
      {
        description: 'content hash mismatch',
        raw: JSON.stringify({
          ...baseEnvelope,
          metadata: {
            ...baseEnvelope.metadata,
            runtime: { ...baseEnvelope.metadata.runtime, contentHash: 'content:other' },
          },
        }),
        error: 'Save content hash mismatch',
      },
    ];

    for (const testCase of cases) {
      fsPromises.readFile.mockImplementationOnce(
        async () => testCase.raw as unknown as Buffer,
      );
      worker?.postMessage.mockClear();
      consoleError.mockClear();

      getMenuEntry(['Simulation', 'Load']).click?.();
      await flushMicrotasks(20);

      const hydrateCalls = worker?.postMessage.mock.calls.filter(
        (call) => (call[0] as { kind?: string } | undefined)?.kind === 'hydrate',
      ) ?? [];
      expect(hydrateCalls, testCase.description).toHaveLength(0);

      const errorCall = consoleError.mock.calls.at(-1);
      const errorValue = errorCall?.[1];
      const errorMessage = errorValue instanceof Error ? errorValue.message : String(errorValue);
      expect(errorCall?.[0], testCase.description).toContain('[shell-desktop] Load state failed');
      expect(errorMessage, testCase.description).toContain(testCase.error);
    }

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();

    consoleError.mockRestore();
  });

  it('enqueues offline catch-up without resourceDeltas when supported', async () => {
    vi.useFakeTimers();
    setMonotonicNowSequence([0, 16]);
    await import('./main.js');
    await flushMicrotasks();

    const worker = Worker.instances[0];
    expect(worker).toBeDefined();

    worker?.emitMessage({
      kind: 'ready',
      stepSizeMs: 20,
      nextStep: 7,
      capabilities: {
        canSerialize: false,
        canHydrate: false,
        supportsOfflineCatchup: true,
      },
    });
    await flushMicrotasks();

    getMenuEntry(['Simulation', 'Offline Catch-up: 5 Minutes']).click?.();
    await flushMicrotasks();

    const enqueueCall = worker?.postMessage.mock.calls.find(
      (call) => (call[0] as { kind?: string } | undefined)?.kind === 'enqueueCommands',
    );
    expect(enqueueCall).toBeDefined();

    const command = ((enqueueCall?.[0] as { commands?: Array<Record<string, unknown>> }).commands ?? [])[0];
    expect(command).toMatchObject({
      type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
      priority: CommandPriority.SYSTEM,
      step: 7,
      timestamp: 140,
      payload: {
        elapsedMs: 5 * 60 * 1000,
      },
    });
    expect(command?.payload).not.toHaveProperty('resourceDeltas');

    const windowAllClosedCall = app.on.mock.calls.find((call) => call[0] === 'window-all-closed');
    const windowAllClosedHandler = windowAllClosedCall?.[1] as undefined | (() => void);
    windowAllClosedHandler?.();
    await flushMicrotasks();
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
});
