import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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

const resolveGameMode = (): string =>
  (process.env.IDLE_ENGINE_GAME ?? 'demo').trim().toLowerCase();

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

const TEST_GAME_CONTROL_SCHEME: ControlScheme = {
  id: 'shell-desktop-test-game',
  version: '1',
  actions: [
    {
      id: 'collect-gold',
      commandType: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      payload: { resourceId: 'test-game.gold', amount: 1 },
    },
  ],
  bindings: [
    {
      id: 'collect-space',
      intent: 'collect',
      actionId: 'collect-gold',
      phases: ['start'],
    },
  ],
};

const resolveControlScheme = (): ControlScheme =>
  resolveGameMode() === 'test-game' ? TEST_GAME_CONTROL_SCHEME : DEMO_CONTROL_SCHEME;

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

type SimWorkerSerializeMessage = Readonly<{
  kind: 'serialize';
  requestId: string;
}>;

type SimWorkerHydrateMessage = Readonly<{
  kind: 'hydrate';
  requestId: string;
  save: unknown;
}>;

type SimWorkerInboundMessage =
  | SimWorkerInitMessage
  | SimWorkerTickMessage
  | SimWorkerEnqueueCommandsMessage
  | SimWorkerSerializeMessage
  | SimWorkerHydrateMessage;

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

type SimWorkerSerializedMessage = Readonly<{
  kind: 'serialized';
  requestId: string;
  save?: unknown;
  error?: string;
}>;

type SimWorkerHydratedMessage = Readonly<{
  kind: 'hydrated';
  requestId: string;
  success: boolean;
  nextStep?: number;
  stepSizeMs?: number;
  error?: string;
}>;

type SimWorkerOutboundMessage =
  | SimWorkerReadyMessage
  | SimWorkerFramesMessage
  | SimWorkerFrameMessage
  | SimWorkerSerializedMessage
  | SimWorkerHydratedMessage
  | SimWorkerErrorMessage;

type SimWorkerController = Readonly<{
  sendControlEvent: (event: ShellControlEvent) => void;
  enqueueCommand: <TPayload extends object>(
    type: string,
    payload: TPayload,
    priority: CommandPriority,
  ) => void;
  requestSerialize: () => Promise<unknown>;
  requestHydrate: (save: unknown) => Promise<void>;
  dispose: () => void;
}>;

let simWorkerController: SimWorkerController | undefined;

const getTestGameSavePath = (): string =>
  join(app.getPath('userData'), 'test-game-save.json');

const saveTestGameState = async (): Promise<void> => {
  if (resolveGameMode() !== 'test-game') {
    return;
  }

  const controller = simWorkerController;
  if (!controller) {
    // eslint-disable-next-line no-console
    console.error('[shell-desktop] Cannot save: sim worker is not running.');
    return;
  }

  try {
    const save = await controller.requestSerialize();
    const savePath = getTestGameSavePath();
    await writeFile(savePath, JSON.stringify(save, null, 2), 'utf8');
    // eslint-disable-next-line no-console
    console.info(`[shell-desktop] Saved test game state to ${savePath}`);
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.error('[shell-desktop] Failed to save test game state.', error);
  }
};

const loadTestGameState = async (): Promise<void> => {
  if (resolveGameMode() !== 'test-game') {
    return;
  }

  const controller = simWorkerController;
  if (!controller) {
    // eslint-disable-next-line no-console
    console.error('[shell-desktop] Cannot load: sim worker is not running.');
    return;
  }

  const savePath = getTestGameSavePath();
  try {
    const raw = await readFile(savePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    await controller.requestHydrate(parsed);
    // eslint-disable-next-line no-console
    console.info(`[shell-desktop] Loaded test game state from ${savePath}`);
  } catch (error: unknown) {
    // eslint-disable-next-line no-console
    console.error(`[shell-desktop] Failed to load test game state from ${savePath}.`, error);
  }
};

const enqueueOfflineCatchup = (elapsedMs: number): void => {
  if (resolveGameMode() !== 'test-game') {
    return;
  }

  const controller = simWorkerController;
  if (!controller) {
    // eslint-disable-next-line no-console
    console.error('[shell-desktop] Cannot apply offline catch-up: sim worker is not running.');
    return;
  }

  controller.enqueueCommand(
    RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
    { elapsedMs, resourceDeltas: {} },
    CommandPriority.SYSTEM,
  );
};

function createSimWorkerController(mainWindow: BrowserWindow): SimWorkerController {
  const worker = new Worker(new URL('./sim-worker.js', import.meta.url));

  let isDisposing = false;
  let hasFailed = false;

  type ShellSimFailureStatusPayload = Extract<ShellSimStatusPayload, { kind: 'stopped' | 'crashed' }>;

  let stepSizeMs = 16;
  let nextStep = 0;
  const maxStepsPerFrame = resolveGameMode() === 'test-game' ? 5000 : 50;

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

  type PendingRequest<TValue> = Readonly<{
    resolve: (value: TValue) => void;
    reject: (error: Error) => void;
  }>;

  const pendingSerializeRequests = new Map<string, PendingRequest<unknown>>();
  const pendingHydrateRequests = new Map<string, PendingRequest<void>>();

  const rejectPendingRequests = (reason: string): void => {
    const error = new Error(reason);

    for (const request of pendingSerializeRequests.values()) {
      request.reject(error);
    }
    pendingSerializeRequests.clear();

    for (const request of pendingHydrateRequests.values()) {
      request.reject(error);
    }
    pendingHydrateRequests.clear();
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
    rejectPendingRequests(status.reason);

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

    if (message.kind === 'serialized') {
      const request = pendingSerializeRequests.get(message.requestId);
      if (!request) {
        return;
      }
      pendingSerializeRequests.delete(message.requestId);

      if (message.error) {
        request.reject(new Error(message.error));
        return;
      }
      if (message.save === undefined) {
        request.reject(new Error('Sim worker did not return a save payload.'));
        return;
      }

      request.resolve(message.save);
      return;
    }

    if (message.kind === 'hydrated') {
      const request = pendingHydrateRequests.get(message.requestId);
      if (!request) {
        return;
      }
      pendingHydrateRequests.delete(message.requestId);

      if (!message.success) {
        request.reject(new Error(message.error ?? 'Sim worker failed to hydrate save.'));
        return;
      }

      if (typeof message.stepSizeMs === 'number' && Number.isFinite(message.stepSizeMs) && message.stepSizeMs > 0) {
        stepSizeMs = message.stepSizeMs;
      }
      if (typeof message.nextStep === 'number' && Number.isFinite(message.nextStep) && message.nextStep >= 0) {
        nextStep = message.nextStep;
      }

      request.resolve(undefined);
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

    const commands = createControlCommands(resolveControlScheme(), event, context);
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

  const enqueueCommand = <TPayload extends object>(
    type: string,
    payload: TPayload,
    priority: CommandPriority,
  ): void => {
    safePostMessage({
      kind: 'enqueueCommands',
      commands: [
        {
          type,
          payload,
          priority,
          timestamp: nextStep * stepSizeMs,
          step: nextStep,
        },
      ],
    });
  };

  const requestSerialize = async (): Promise<unknown> => {
    if (hasFailed || isDisposing) {
      throw new Error('Sim worker is not available.');
    }

    const requestId = randomUUID();
    return await new Promise((resolve, reject) => {
      pendingSerializeRequests.set(requestId, { resolve, reject });
      safePostMessage({ kind: 'serialize', requestId });
    });
  };

  const requestHydrate = async (save: unknown): Promise<void> => {
    if (hasFailed || isDisposing) {
      throw new Error('Sim worker is not available.');
    }

    const requestId = randomUUID();
    return await new Promise((resolve, reject) => {
      pendingHydrateRequests.set(requestId, { resolve, reject });
      safePostMessage({ kind: 'hydrate', requestId, save });
    });
  };

  const dispose = (): void => {
    isDisposing = true;
    stopTickLoop();
    rejectPendingRequests('Sim worker disposed.');
    void worker.terminate().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
  };

  return { sendControlEvent, enqueueCommand, requestSerialize, requestHydrate, dispose };
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
  const isTestGame = resolveGameMode() === 'test-game';

  const gameSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Save',
      accelerator: 'CmdOrCtrl+S',
      enabled: isTestGame,
      click: () => {
        void saveTestGameState();
      },
    },
    {
      label: 'Load',
      accelerator: 'CmdOrCtrl+O',
      enabled: isTestGame,
      click: () => {
        void loadTestGameState();
      },
    },
    { type: 'separator' },
    {
      label: 'Offline catch-up (1h)',
      enabled: isTestGame,
      click: () => enqueueOfflineCatchup(60 * 60 * 1000),
    },
    {
      label: 'Offline catch-up (6h)',
      enabled: isTestGame,
      click: () => enqueueOfflineCatchup(6 * 60 * 60 * 1000),
    },
    {
      label: 'Offline catch-up (12h)',
      enabled: isTestGame,
      click: () => enqueueOfflineCatchup(12 * 60 * 60 * 1000),
    },
  ];

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
    { label: 'Game', submenu: gameSubmenu },
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
