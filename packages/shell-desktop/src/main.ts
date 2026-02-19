import { app, BrowserWindow, ipcMain, Menu } from 'electron';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createControlCommands } from '@idle-engine/controls';
import {
  CommandPriority,
  RUNTIME_COMMAND_TYPES,
  type Command,
  type InputEvent,
  type InputEventCommandPayload,
  type RuntimeCommand,
} from '@idle-engine/core';
import { IPC_CHANNELS, type IpcInvokeMap, type ShellControlEvent, type ShellInputEventEnvelope, type ShellSimStatusPayload } from './ipc.js';
import { monotonicNowMs } from './monotonic-time.js';
import type { MenuItemConstructorOptions } from 'electron';
import type { ControlScheme } from '@idle-engine/controls';
import type { AssetMcpController } from './mcp/asset-tools.js';
import type { InputMcpController } from './mcp/input-tools.js';
import type { ShellDesktopMcpServer } from './mcp/mcp-server.js';
import type { SimMcpController, SimMcpStatus } from './mcp/sim-tools.js';
import type { WindowMcpController } from './mcp/window-tools.js';
import type { SimWorkerInboundMessage, SimWorkerOutboundMessage } from './sim/worker-protocol.js';

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';

const enableUnsafeWebGpu = isDev || process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU === '1';
if (enableUnsafeWebGpu) {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
}

const enableMcpServer = process.env.IDLE_ENGINE_ENABLE_MCP_SERVER === '1'
  || process.argv.includes('--enable-mcp-server');

const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const rendererHtmlPath = fileURLToPath(new URL('./renderer/index.html', import.meta.url));
const repoRootPath = fileURLToPath(new URL('../../../', import.meta.url));
const defaultCompiledAssetsRootPath = path.resolve(
  repoRootPath,
  'packages/content-sample/content/compiled',
);
const configuredCompiledAssetsRootPath = process.env.IDLE_ENGINE_COMPILED_ASSETS_ROOT;
const compiledAssetsRootPath = configuredCompiledAssetsRootPath
  ? path.resolve(configuredCompiledAssetsRootPath)
  : defaultCompiledAssetsRootPath;

const assetMcpController: AssetMcpController = {
  compiledAssetsRootPath,
};

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
  const controlValue = (value as { value?: unknown }).value;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (typeof intent !== 'string' || intent.trim().length === 0) {
    return false;
  }
  // If value is present, it must be finite
  if (controlValue !== undefined) {
    if (typeof controlValue !== 'number' || !Number.isFinite(controlValue)) {
      return false;
    }
  }
  if (metadata !== undefined) {
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      return false;
    }
  }
  return phase === 'start' || phase === 'repeat' || phase === 'end';
}

/**
 * Validates if a value is a valid InputEventModifiers object.
 */
function isValidInputEventModifiers(value: unknown): value is { alt: boolean; ctrl: boolean; meta: boolean; shift: boolean } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.alt === 'boolean' &&
    typeof obj.ctrl === 'boolean' &&
    typeof obj.meta === 'boolean' &&
    typeof obj.shift === 'boolean'
  );
}

/**
 * Validates if a value is a valid PointerInputEvent.
 *
 * In addition to basic shape validation, this function enforces:
 * - phase must match intent: mouse-down→start, mouse-move→repeat, mouse-up→end
 * - button must be an integer in range -1..32
 * - buttons must be an integer in range 0..0xFFFF
 */
function isValidPointerInputEvent(value: unknown): value is InputEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind !== 'pointer') {
    return false;
  }
  const validIntents = ['mouse-down', 'mouse-up', 'mouse-move'];
  if (!validIntents.includes(obj.intent as string)) {
    return false;
  }
  const validPhases = ['start', 'repeat', 'end'];
  if (!validPhases.includes(obj.phase as string)) {
    return false;
  }
  // Validate phase matches intent per design: mouse-down→start, mouse-move→repeat, mouse-up→end
  const intentPhaseMap: Record<string, string> = {
    'mouse-down': 'start',
    'mouse-move': 'repeat',
    'mouse-up': 'end',
  };
  if (intentPhaseMap[obj.intent as string] !== obj.phase) {
    return false;
  }
  if (typeof obj.x !== 'number' || !Number.isFinite(obj.x)) {
    return false;
  }
  if (typeof obj.y !== 'number' || !Number.isFinite(obj.y)) {
    return false;
  }
  // button must be an integer in range -1..32
  if (typeof obj.button !== 'number' || !Number.isInteger(obj.button) || obj.button < -1 || obj.button > 32) {
    return false;
  }
  // buttons must be an integer in range 0..0xFFFF
  if (typeof obj.buttons !== 'number' || !Number.isInteger(obj.buttons) || obj.buttons < 0 || obj.buttons > 0xFFFF) {
    return false;
  }
  const validPointerTypes = ['mouse', 'pen', 'touch'];
  if (!validPointerTypes.includes(obj.pointerType as string)) {
    return false;
  }
  return isValidInputEventModifiers(obj.modifiers);
}

/**
 * Validates if a value is a valid WheelInputEvent.
 */
function isValidWheelInputEvent(value: unknown): value is InputEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  if (obj.kind !== 'wheel') {
    return false;
  }
  if (obj.intent !== 'mouse-wheel') {
    return false;
  }
  if (obj.phase !== 'repeat') {
    return false;
  }
  if (typeof obj.x !== 'number' || !Number.isFinite(obj.x)) {
    return false;
  }
  if (typeof obj.y !== 'number' || !Number.isFinite(obj.y)) {
    return false;
  }
  if (typeof obj.deltaX !== 'number' || !Number.isFinite(obj.deltaX)) {
    return false;
  }
  if (typeof obj.deltaY !== 'number' || !Number.isFinite(obj.deltaY)) {
    return false;
  }
  if (typeof obj.deltaZ !== 'number' || !Number.isFinite(obj.deltaZ)) {
    return false;
  }
  const validDeltaModes = [0, 1, 2];
  if (!validDeltaModes.includes(obj.deltaMode as number)) {
    return false;
  }
  return isValidInputEventModifiers(obj.modifiers);
}

/**
 * Validates if a value is a valid InputEvent (pointer or wheel).
 */
function isValidInputEvent(value: unknown): value is InputEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'pointer') {
    return isValidPointerInputEvent(value);
  }
  if (kind === 'wheel') {
    return isValidWheelInputEvent(value);
  }
  return false;
}

/**
 * Validates if a value is a valid ShellInputEventEnvelope.
 *
 * The schemaVersion must be exactly 1; unknown versions are dropped
 * at the IPC boundary (not enqueued).
 */
function isValidShellInputEventEnvelope(value: unknown): value is ShellInputEventEnvelope {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const obj = value as Record<string, unknown>;
  // Only schemaVersion 1 is supported; unknown versions are dropped
  if (obj.schemaVersion !== 1) {
    return false;
  }
  return isValidInputEvent(obj.event);
}

type SimWorkerController = Readonly<{
  sendControlEvent: (event: ShellControlEvent) => void;
  sendInputEvent: (envelope: ShellInputEventEnvelope) => void;
  enqueueCommands: (commands: readonly Command[]) => void;
  pause: () => void;
  resume: () => void;
  step: (steps: number) => Promise<SimMcpStatus>;
  getStatus: () => SimMcpStatus;
  dispose: () => void;
}>;

const buildStoppedSimStatus = (): SimMcpStatus => ({ state: 'stopped', stepSizeMs: 16, nextStep: 0 });

let mainWindow: BrowserWindow | undefined;
let simWorkerController: SimWorkerController | undefined;
let mcpServer: ShellDesktopMcpServer | undefined;

function createSimWorkerController(mainWindow: BrowserWindow): SimWorkerController {
  const worker = new Worker(new URL('./sim-worker.js', import.meta.url));

  let isDisposing = false;
  let hasFailed = false;
  let isReady = false;
  let isPaused = false;

  type ShellSimFailureStatusPayload = Extract<ShellSimStatusPayload, { kind: 'stopped' | 'crashed' }>;
  let lastFailure: ShellSimFailureStatusPayload | undefined;

  let stepSizeMs = 16;
  let nextStep = 0;
  const maxStepsPerFrame = 50;
  type StepCompletionWaiter = Readonly<{
    targetStep: number;
    resolve: (status: SimMcpStatus) => void;
    reject: (error: Error) => void;
  }>;
  let stepCompletionWaiters: StepCompletionWaiter[] = [];

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

  const buildStatusSnapshot = (): SimMcpStatus => {
    if (lastFailure) {
      return {
        state: lastFailure.kind,
        reason: lastFailure.reason,
        exitCode: lastFailure.exitCode,
        stepSizeMs,
        nextStep,
      };
    }

    if (isDisposing) {
      return { state: 'stopped', stepSizeMs, nextStep };
    }

    if (!isReady) {
      return { state: 'starting', stepSizeMs, nextStep };
    }

    return { state: isPaused ? 'paused' : 'running', stepSizeMs, nextStep };
  };

  const rejectPendingStepCompletions = (error: Error): void => {
    if (stepCompletionWaiters.length === 0) {
      return;
    }

    const pending = stepCompletionWaiters;
    stepCompletionWaiters = [];
    for (const waiter of pending) {
      waiter.reject(error);
    }
  };

  const resolvePendingStepCompletions = (): void => {
    if (stepCompletionWaiters.length === 0) {
      return;
    }

    const statusSnapshot = buildStatusSnapshot();
    const pending = stepCompletionWaiters;
    stepCompletionWaiters = [];

    for (const waiter of pending) {
      if (nextStep >= waiter.targetStep) {
        waiter.resolve(statusSnapshot);
      } else {
        stepCompletionWaiters.push(waiter);
      }
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
    lastFailure = status;
    stopTickLoop();
    rejectPendingStepCompletions(new Error(`Sim ${status.kind}: ${status.reason}`));

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
    if (tickTimer || hasFailed || isDisposing || isPaused || !isReady) {
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

  // Emit sim-status 'starting' when the worker controller is created
  sendSimStatus({ kind: 'starting' });

  worker.on('message', (message: SimWorkerOutboundMessage) => {
    // Ignore worker messages after disposal or failure to avoid stale frames/status after restart
    if (isDisposing || hasFailed) {
      return;
    }

    if (message.kind === 'ready') {
      stepSizeMs = message.stepSizeMs;
      nextStep = message.nextStep;
      isReady = true;
      resolvePendingStepCompletions();
      // Emit sim-status 'running' when the worker is ready
      sendSimStatus({ kind: 'running' });
      startTickLoop();
      return;
    }

    if (message.kind === 'frame') {
      nextStep = message.nextStep;
      resolvePendingStepCompletions();
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
    // Drop control events until worker is ready (design workflow rule)
    if (!isReady) {
      return;
    }

    const context = {
      step: nextStep,
      timestamp: nextStep * stepSizeMs,
      priority: CommandPriority.PLAYER,
    };

    let commands: readonly RuntimeCommand[];
    try {
      commands = createControlCommands(DEMO_CONTROL_SCHEME, event, context);
    } catch (error: unknown) {
      // Treat control-event mapping exceptions as fatal bridge failures per issue #850 design doc.
      // Transition to sim-status crashed, stop the tick loop, and terminate the worker.
      const reason = error instanceof Error ? error.message : String(error);
      handleWorkerFailure({ kind: 'crashed', reason }, error);
      return;
    }

    if (commands.length > 0) {
      safePostMessage({ kind: 'enqueueCommands', commands });
    }
    // Note: passthrough SHELL_CONTROL_EVENT is no longer emitted from renderer inputs.
    // Legacy passthrough behavior is removed per issue #850.
  };

  /**
   * Enqueues an INPUT_EVENT command for a validated input event envelope.
   *
   * The command uses:
   * - type: RUNTIME_COMMAND_TYPES.INPUT_EVENT
   * - priority: CommandPriority.PLAYER
   * - step: current nextStep snapshot
   * - timestamp: step * stepSizeMs
   * - payload: { schemaVersion: 1, event: <validated event> }
   * - requestId: omitted
   */
  const sendInputEvent = (envelope: ShellInputEventEnvelope): void => {
    // Drop input events until worker is ready (design workflow rule)
    if (!isReady) {
      return;
    }

    const inputEventCommand: Command<InputEventCommandPayload> = {
      type: RUNTIME_COMMAND_TYPES.INPUT_EVENT,
      payload: {
        schemaVersion: envelope.schemaVersion,
        event: envelope.event,
      },
      priority: CommandPriority.PLAYER,
      timestamp: nextStep * stepSizeMs,
      step: nextStep,
    };

    safePostMessage({ kind: 'enqueueCommands', commands: [inputEventCommand] });
  };

  const enqueueCommands = (commands: readonly Command[]): void => {
    safePostMessage({ kind: 'enqueueCommands', commands });
  };

  const pause = (): void => {
    if (hasFailed || isDisposing) {
      return;
    }

    isPaused = true;
    stopTickLoop();
  };

  const resume = (): void => {
    if (hasFailed || isDisposing) {
      return;
    }

    isPaused = false;
    startTickLoop();
  };

  const step = async (steps: number): Promise<SimMcpStatus> => {
    if (!Number.isFinite(steps) || Math.floor(steps) !== steps || steps < 1) {
      throw new TypeError('Invalid sim step count: expected integer >= 1');
    }

    if (hasFailed || isDisposing) {
      throw new Error('Simulation is not running.');
    }

    if (!isReady) {
      throw new Error('Sim is not ready to step yet.');
    }

    isPaused = true;
    stopTickLoop();

    const targetStep = (stepCompletionWaiters.at(-1)?.targetStep ?? nextStep) + steps;
    const completionPromise = new Promise<SimMcpStatus>((resolve, reject) => {
      stepCompletionWaiters.push({ targetStep, resolve, reject });
    });

    let remainingSteps = steps;
    while (remainingSteps > 0 && !hasFailed && !isDisposing) {
      const batchStepCount = Math.min(remainingSteps, maxStepsPerFrame);
      safePostMessage({ kind: 'tick', deltaMs: batchStepCount * stepSizeMs });
      remainingSteps -= batchStepCount;
    }

    resolvePendingStepCompletions();
    return completionPromise;
  };

  const getStatus = (): SimMcpStatus => {
    return buildStatusSnapshot();
  };

  const dispose = (): void => {
    isDisposing = true;
    isPaused = true;
    stopTickLoop();
    rejectPendingStepCompletions(new Error('Simulation stopped before step completed.'));
    void worker.terminate().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
  };

  return { sendControlEvent, sendInputEvent, enqueueCommands, pause, resume, step, getStatus, dispose };
}

const simMcpController: SimMcpController = {
  getStatus: () => simWorkerController?.getStatus() ?? buildStoppedSimStatus(),
  start: () => {
    if (simWorkerController) {
      const currentStatus = simWorkerController.getStatus();
      if (
        currentStatus.state !== 'stopped' &&
        currentStatus.state !== 'crashed'
      ) {
        return currentStatus;
      }

      simWorkerController.dispose();
      simWorkerController = undefined;
    }

    if (!mainWindow) {
      throw new Error('Main window is not ready; cannot start simulation.');
    }

    simWorkerController = createSimWorkerController(mainWindow);
    return simWorkerController.getStatus();
  },
  stop: () => {
    const current = simWorkerController?.getStatus();
    simWorkerController?.dispose();
    simWorkerController = undefined;
    return current ? { ...current, state: 'stopped' } : buildStoppedSimStatus();
  },
  pause: () => {
    if (!simWorkerController) {
      throw new Error('Simulation is not running.');
    }

    simWorkerController.pause();
    return simWorkerController.getStatus();
  },
  resume: () => {
    if (!simWorkerController) {
      throw new Error('Simulation is not running.');
    }

    simWorkerController.resume();
    return simWorkerController.getStatus();
  },
  step: async (steps) => {
    const controller = simWorkerController;
    if (!controller) {
      throw new Error('Simulation is not running.');
    }

    return controller.step(steps);
  },
  enqueue: (commands) => {
    if (!simWorkerController) {
      throw new Error('Simulation is not running.');
    }

    simWorkerController.enqueueCommands(commands);
    return { enqueued: commands.length };
  },
};

const getMainWindowOrThrow = (): BrowserWindow => {
  if (!mainWindow) {
    throw new Error('Main window is not ready.');
  }

  return mainWindow;
};

const windowMcpController: WindowMcpController = {
  getInfo: () => {
    const window = getMainWindowOrThrow();
    const devToolsOpen = window.webContents.isDevToolsOpened?.() ?? false;
    return {
      bounds: window.getBounds(),
      url: window.webContents.getURL(),
      devToolsOpen,
    };
  },
  resize: (width, height) => {
    const window = getMainWindowOrThrow();
    window.setSize(width, height);
    const devToolsOpen = window.webContents.isDevToolsOpened?.() ?? false;
    return {
      bounds: window.getBounds(),
      url: window.webContents.getURL(),
      devToolsOpen,
    };
  },
  setDevTools: (action) => {
    const window = getMainWindowOrThrow();

    if (action === 'open') {
      window.webContents.openDevTools({ mode: 'detach' });
    } else if (action === 'close') {
      window.webContents.closeDevTools();
    } else {
      const isOpen = window.webContents.isDevToolsOpened?.() ?? false;
      if (isOpen) {
        window.webContents.closeDevTools();
      } else {
        window.webContents.openDevTools({ mode: 'detach' });
      }
    }

    return { devToolsOpen: window.webContents.isDevToolsOpened?.() ?? false };
  },
  captureScreenshotPng: async () => {
    const window = getMainWindowOrThrow();
    const image = await window.webContents.capturePage();
    return image.toPNG();
  },
};

const inputMcpController: InputMcpController = {
  sendControlEvent: (event) => {
    if (!simWorkerController) {
      throw new Error('Simulation is not running.');
    }

    simWorkerController.sendControlEvent(event);
  },
};

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
      const relativePath = path.relative(compiledAssetsRootPath, assetPath);
      if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        throw new TypeError('Invalid asset url: path must be inside compiled assets.');
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

  ipcMain.on(IPC_CHANNELS.inputEvent, (_event, envelope: unknown) => {
    // Invalid envelopes are dropped (no enqueueCommands)
    if (!isValidShellInputEventEnvelope(envelope)) {
      return;
    }
    // When sim is not running (stopped/crashed/disposing), input events are ignored
    // This is handled by safePostMessage inside sendInputEvent, which checks hasFailed/isDisposing
    simWorkerController?.sendInputEvent(envelope);
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
    if (enableMcpServer) {
      const { maybeStartShellDesktopMcpServer } = await import('./mcp/mcp-server.js');
      mcpServer = await maybeStartShellDesktopMcpServer({
        sim: simMcpController,
        window: windowMcpController,
        input: inputMcpController,
        asset: assetMcpController,
      });
    }
    mainWindow = await createMainWindow();
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
  mainWindow = undefined;
  if (process.platform !== 'darwin') {
    mcpServer?.close().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
    mcpServer = undefined;
    app.quit();
  }
});

app.on('before-quit', () => {
  mcpServer?.close().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error(error);
  });
  mcpServer = undefined;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow()
      .then((createdWindow) => {
        mainWindow = createdWindow;
        simWorkerController = createSimWorkerController(createdWindow);
      })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error(error);
      });
  }
});
