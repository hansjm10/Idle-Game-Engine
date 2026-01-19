import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createControlCommands } from '@idle-engine/controls';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { IPC_CHANNELS } from './ipc.js';
import type { IpcInvokeMap } from './ipc.js';
import type { ShellControlEvent } from './ipc.js';
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

function isShellControlEvent(value: unknown): value is ShellControlEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const intent = (value as { intent?: unknown }).intent;
  const phase = (value as { phase?: unknown }).phase;
  if (typeof intent !== 'string' || intent.trim().length === 0) {
    return false;
  }
  return phase === 'start' || phase === 'repeat' || phase === 'end';
}

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

type SimWorkerErrorMessage = Readonly<{
  kind: 'error';
  error: string;
}>;

type SimWorkerOutboundMessage =
  | SimWorkerReadyMessage
  | SimWorkerFramesMessage
  | SimWorkerErrorMessage;

type SimWorkerController = Readonly<{
  sendControlEvent: (event: ShellControlEvent) => void;
  dispose: () => void;
}>;

let simWorkerController: SimWorkerController | undefined;

function createSimWorkerController(mainWindow: BrowserWindow): SimWorkerController {
  const worker = new Worker(new URL('./sim-worker.js', import.meta.url));

  let stepSizeMs = 16;
  let nextStep = 0;
  const maxStepsPerFrame = 50;

  const postMessage = (message: SimWorkerInboundMessage): void => {
    worker.postMessage(message);
  };

  const tickIntervalMs = 16;
  let lastTickMs = Date.now();
  let tickTimer: NodeJS.Timeout | undefined;

  const startTickLoop = (): void => {
    if (tickTimer) {
      return;
    }

    lastTickMs = Date.now();
    tickTimer = setInterval(() => {
      const nowMs = Date.now();
      const deltaMs = Math.max(0, nowMs - lastTickMs);
      lastTickMs = nowMs;
      postMessage({ kind: 'tick', deltaMs });
    }, tickIntervalMs);

    tickTimer.unref?.();
  };

  postMessage({ kind: 'init', stepSizeMs, maxStepsPerFrame });

  worker.on('message', (message: SimWorkerOutboundMessage) => {
    if (message.kind === 'ready') {
      stepSizeMs = message.stepSizeMs;
      nextStep = message.nextStep;
      startTickLoop();
      return;
    }

    if (message.kind === 'frames') {
      nextStep = message.nextStep;
      for (const frame of message.frames) {
        mainWindow.webContents.send(IPC_CHANNELS.frame, frame);
      }
      return;
    }

    if (message.kind === 'error') {
      // eslint-disable-next-line no-console
      console.error(message.error);
    }
  });

  worker.on('error', (error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
  });

  const sendControlEvent = (event: ShellControlEvent): void => {
    const context = {
      step: nextStep,
      timestamp: nextStep * stepSizeMs,
      priority: CommandPriority.PLAYER,
    };

    const commands = createControlCommands(DEMO_CONTROL_SCHEME, event, context);
    if (commands.length === 0) {
      return;
    }
    postMessage({ kind: 'enqueueCommands', commands });
  };

  const dispose = (): void => {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
    void worker.terminate();
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
