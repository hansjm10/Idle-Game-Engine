import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createControlCommands } from '@idle-engine/controls';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { IPC_CHANNELS, SHELL_CONTROL_EVENT_COMMAND_TYPE, type IpcInvokeMap, type ShellControlEvent, type ShellSimStatusPayload } from './ipc.js';
import { monotonicNowMs } from './monotonic-time.js';
import type { Command } from '@idle-engine/core';
import type { MenuItemConstructorOptions } from 'electron';
import type { ControlScheme } from '@idle-engine/controls';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';

const enableUnsafeWebGpu = isDev || process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU === '1';
if (enableUnsafeWebGpu) {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
}

const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const rendererHtmlPath = fileURLToPath(new URL('./renderer/index.html', import.meta.url));
const repoRootPath = fileURLToPath(new URL('../../../', import.meta.url));

const DEMO_CONTROL_SCHEME: ControlScheme = {
  id: 'shell-desktop-demo',
  version: '1',
  actions: [
    {
      id: 'collect-demo',
      commandType: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      payload: { resourceId: 'demo', amount: 1 },
    },
  ],
  bindings: [
    {
      id: 'collect-space',
      intent: 'collect',
      actionId: 'collect-demo',
      phases: ['start'],
    },
  ],
};

function assertPingRequest(
  request: unknown,
): asserts request is IpcInvokeMap[typeof IPC_CHANNELS.ping]['request'] {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new TypeError('Invalid ping request: expected an object');
  }

  const message = (request as { message?: unknown }).message;
  if (typeof message !== 'string') {
    throw new TypeError('Invalid ping request: expected { message: string }');
  }
}

function assertReadAssetRequest(
  request: unknown,
): asserts request is IpcInvokeMap[typeof IPC_CHANNELS.readAsset]['request'] {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    throw new TypeError('Invalid read asset request: expected an object');
  }

  const url = (request as { url?: unknown }).url;
  if (typeof url !== 'string' || url.trim().length === 0) {
    throw new TypeError('Invalid read asset request: expected { url: string }');
  }
}

function isShellControlEvent(value: unknown): value is ShellControlEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const intent = (value as { intent?: unknown }).intent;
  const phase = (value as { phase?: unknown }).phase;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (typeof intent !== 'string' || intent.trim().length === 0) {
    return false;
  }
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return false;
    }
  }
  return phase === 'start' || phase === 'repeat' || phase === 'end';
}

const shouldPassthroughControlEvent = (event: ShellControlEvent): boolean =>
  event.metadata?.['passthrough'] === true;

type SimWorkerInitMessage = Readonly<{
  kind: 'init';
  stepSizeMs: number;
  maxStepsPerFrame: number;
}>;

type SimWorkerTickMessage = Readonly<{
  kind: 'tick';
  deltaMs: number;
}>;

type SimWorkerEnqueueCommandsMessage = Readonly<{
  kind: 'enqueueCommands';
  commands: readonly Command[];
}>;

type SimWorkerInboundMessage =
  | SimWorkerInitMessage
  | SimWorkerTickMessage
  | SimWorkerEnqueueCommandsMessage;

type SimWorkerReadyMessage = Readonly<{
  kind: 'ready';
  stepSizeMs: number;
  nextStep: number;
}>;

type SimWorkerFramesMessage = Readonly<{
  kind: 'frames';
  frames: readonly RenderCommandBuffer[];
  nextStep: number;
}>;

type SimWorkerFrameMessage = Readonly<{
  kind: 'frame';
  frame?: RenderCommandBuffer;
  droppedFrames: number;
  nextStep: number;
}>;

type SimWorkerErrorMessage = Readonly<{
  kind: 'error';
  error: string;
}>;

type SimWorkerOutboundMessage =
  | SimWorkerReadyMessage
  | SimWorkerFramesMessage
  | SimWorkerFrameMessage
  | SimWorkerErrorMessage;

type SimWorkerController = Readonly<{
  sendControlEvent: (event: ShellControlEvent) => void;
  dispose: () => void;
}>;

let simWorkerController: SimWorkerController | undefined;

function createSimWorkerController(mainWindow: BrowserWindow): SimWorkerController {
  const worker = new Worker(new URL('./sim-worker.js', import.meta.url));

  let isDisposing = false;
  let hasFailed = false;

  type ShellSimFailureStatusPayload = Extract<ShellSimStatusPayload, { kind: 'stopped' | 'crashed' }>;

  let stepSizeMs = 16;
  let nextStep = 0;
  const maxStepsPerFrame = 50;

  const tickIntervalMs = 16;
  const MAX_TICK_DELTA_MS = 250;
  let lastTickMs = 0;
  let tickTimer: NodeJS.Timeout | undefined;

  const clampTickDeltaMs = (rawDeltaMs: number): number => {
    if (!Number.isFinite(rawDeltaMs)) {
      return 0;
    }
    const deltaMs = Math.trunc(rawDeltaMs);
    if (deltaMs <= 0) {
      return 0;
    }
    return Math.min(deltaMs, MAX_TICK_DELTA_MS);
  };

  const stopTickLoop = (): void => {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };

  const sendSimStatus = (status: ShellSimStatusPayload): void => {
    try {
      mainWindow.webContents.send(IPC_CHANNELS.simStatus, status);
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.error(error);
    }
  };

  const handleWorkerFailure = (status: ShellSimFailureStatusPayload, details?: unknown): void => {
    if (hasFailed || isDisposing) {
      return;
    }

    hasFailed = true;
    stopTickLoop();

    // eslint-disable-next-line no-console
    console.error(status.kind === 'stopped' ? `[shell-desktop] Sim stopped: ${status.reason}` : `[shell-desktop] Sim crashed: ${status.reason}`, details);

    sendSimStatus(status);

    void worker.terminate().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
  };

  const safePostMessage = (message: SimWorkerInboundMessage): void => {
    if (hasFailed || isDisposing) {
      return;
    }

    try {
      worker.postMessage(message);
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      handleWorkerFailure({ kind: 'crashed', reason }, error);
    }
  };

  const startTickLoop = (): void => {
    if (tickTimer || hasFailed || isDisposing) {
      return;
    }

    lastTickMs = monotonicNowMs();
    tickTimer = setInterval(() => {
      const nowMs = monotonicNowMs();
      const rawDeltaMs = nowMs - lastTickMs;
      lastTickMs = nowMs;
      const deltaMs = clampTickDeltaMs(rawDeltaMs);
      safePostMessage({ kind: 'tick', deltaMs });
    }, tickIntervalMs);

    tickTimer.unref?.();
  };

  safePostMessage({ kind: 'init', stepSizeMs, maxStepsPerFrame });

  worker.on('message', (message: SimWorkerOutboundMessage) => {
    if (message.kind === 'ready') {
      stepSizeMs = message.stepSizeMs;
      nextStep = message.nextStep;
      startTickLoop();
      return;
    }

    if (message.kind === 'frames') {
      nextStep = message.nextStep;
      const frame = message.frames.at(-1);
      if (!frame) {
        return;
      }
      try {
        mainWindow.webContents.send(IPC_CHANNELS.frame, frame);
      } catch (error: unknown) {
        // eslint-disable-next-line no-console
        console.error(error);
      }
      return;
    }

    if (message.kind === 'frame') {
      nextStep = message.nextStep;
      if (!message.frame) {
        return;
      }
      try {
        mainWindow.webContents.send(IPC_CHANNELS.frame, message.frame);
      } catch (error: unknown) {
        // eslint-disable-next-line no-console
        console.error(error);
      }
      return;
    }

    if (message.kind === 'error') {
      handleWorkerFailure({ kind: 'crashed', reason: message.error }, message.error);
    }
  });

  worker.on('error', (error: unknown) => {
    handleWorkerFailure(
      { kind: 'crashed', reason: error instanceof Error ? error.message : String(error) },
      error,
    );
  });

  worker.on('messageerror', (error: unknown) => {
    handleWorkerFailure(
      { kind: 'crashed', reason: error instanceof Error ? error.message : String(error) },
      error,
    );
  });

  worker.on('exit', (exitCode: number) => {
    if (isDisposing) {
      return;
    }

    handleWorkerFailure(
      {
        kind: exitCode === 0 ? 'stopped' : 'crashed',
        reason: `Sim worker exited with code ${exitCode}.`,
        exitCode,
      },
      { exitCode },
    );
  });

  const sendControlEvent = (event: ShellControlEvent): void => {
    const context = {
      step: nextStep,
      timestamp: nextStep * stepSizeMs,
      priority: CommandPriority.PLAYER,
    };

    const commands = createControlCommands(DEMO_CONTROL_SCHEME, event, context);
    if (commands.length > 0) {
      safePostMessage({ kind: 'enqueueCommands', commands });
      return;
    }

    if (!shouldPassthroughControlEvent(event)) {
      return;
    }

    const passthroughCommand: Command<{ event: ShellControlEvent }> = {
      type: SHELL_CONTROL_EVENT_COMMAND_TYPE,
      payload: { event },
      priority: context.priority,
      timestamp: context.timestamp,
      step: context.step,
    };

    safePostMessage({ kind: 'enqueueCommands', commands: [passthroughCommand] });
  };

  const dispose = (): void => {
    isDisposing = true;
    stopTickLoop();
    void worker.terminate().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
  };

  return { sendControlEvent, dispose };
}

function registerIpcHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.ping,
    async (_event, request: unknown) => {
      assertPingRequest(request);
      return { message: request.message } satisfies IpcInvokeMap[typeof IPC_CHANNELS.ping]['response'];
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.readAsset,
    async (_event, request: unknown) => {
      assertReadAssetRequest(request);

      const assetUrl = new URL(request.url);
      if (assetUrl.protocol !== 'file:') {
        throw new TypeError('Invalid asset url: expected a file:// URL.');
      }

      const assetPath = path.resolve(fileURLToPath(assetUrl));
      const relativePath = path.relative(repoRootPath, assetPath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new TypeError('Invalid asset url: path must be inside the repository.');
      }

      const buffer = await fsPromises.readFile(assetPath);
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      );
    },
  );

  ipcMain.on(IPC_CHANNELS.controlEvent, (_event, event: unknown) => {
    if (!isShellControlEvent(event)) {
      return;
    }
    simWorkerController?.sendControlEvent(event);
  });
}

function installAppMenu(): void {
  const viewSubmenu: MenuItemConstructorOptions[] = [
    { role: 'reload' },
    { role: 'forceReload' },
    { role: 'toggleDevTools' },
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ];

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'quit' },
            ] satisfies MenuItemConstructorOptions[],
          },
        ]
      : []),
    { label: 'View', submenu: viewSubmenu },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createMainWindow(): Promise<BrowserWindow> {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: preloadPath,
    },
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow.show();
    if (isDev) {
      mainWindow.webContents.openDevTools({ mode: 'detach' });
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
    }
  });

  mainWindow.webContents.on('did-finish-load', () => {
    if (!simWorkerController) {
      return;
    }

    simWorkerController.dispose();
    simWorkerController = createSimWorkerController(mainWindow);
  });

  await mainWindow.loadFile(rendererHtmlPath);

  return mainWindow;
}

app
  .whenReady()
  .then(async () => {
    installAppMenu();
    registerIpcHandlers();
    const mainWindow = await createMainWindow();
    simWorkerController = createSimWorkerController(mainWindow);
  })
  .catch((error: unknown) => {
    // Avoid unhandled promise rejection noise; Electron will exit if startup fails.
    // eslint-disable-next-line no-console
    console.error(error);
    app.exit(1);
  });

app.on('window-all-closed', () => {
  simWorkerController?.dispose();
  simWorkerController = undefined;
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow()
      .then((mainWindow) => {
        simWorkerController = createSimWorkerController(mainWindow);
      })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error(error);
      });
  }
});
