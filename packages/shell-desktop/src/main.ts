import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { promises as fsPromises } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
import { writeSave, cleanupStaleTempFiles } from './save-storage.js';
import { decodeGameStateSave } from './runtime-harness.js';
import type { GameStateSaveFormat } from './runtime-harness.js';
import type { MenuItemConstructorOptions } from 'electron';
import type { ControlScheme } from '@idle-engine/controls';
import type { SimWorkerCapabilities, SimWorkerInboundMessage, SimWorkerOutboundMessage } from './sim/worker-protocol.js';

const isDev = !app.isPackaged || process.env.NODE_ENV === 'development';

const REQUEST_TIMEOUT_MS = 10_000;
const WORKER_READY_TIMEOUT_MS = 10_000;

const enableUnsafeWebGpu = isDev || process.env.IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU === '1';
if (enableUnsafeWebGpu) {
  app.commandLine.appendSwitch('enable-unsafe-webgpu');
}

const preloadPath = fileURLToPath(new URL('./preload.cjs', import.meta.url));
const rendererHtmlPath = fileURLToPath(new URL('./renderer/index.html', import.meta.url));
const repoRootPath = fileURLToPath(new URL('../../../', import.meta.url));
const compiledAssetsRootPath = path.resolve(
  repoRootPath,
  'packages/content-sample/content/compiled',
);

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
  triggerSave: () => void;
  triggerLoad: () => void;
  triggerOfflineCatchup: () => void;
  getCapabilities: () => SimWorkerCapabilities;
  dispose: () => void;
}>;

let simWorkerController: SimWorkerController | undefined;

// Mutable dev menu item config objects. `installAppMenu()` inserts them into the
// menu template; later code mutates `.enabled` to reflect capability & lock state.
const devMenuSaveItem: MenuItemConstructorOptions = {
  label: 'Save',
  accelerator: 'CmdOrCtrl+S',
  enabled: false,
  click: () => { simWorkerController?.triggerSave(); },
};

const devMenuLoadItem: MenuItemConstructorOptions = {
  label: 'Load',
  accelerator: 'CmdOrCtrl+O',
  enabled: false,
  click: () => { simWorkerController?.triggerLoad(); },
};

const devMenuOfflineCatchupItem: MenuItemConstructorOptions = {
  label: 'Offline Catch-Up',
  accelerator: 'CmdOrCtrl+Shift+O',
  enabled: false,
  click: () => { simWorkerController?.triggerOfflineCatchup(); },
};

function refreshDevMenuState(caps: SimWorkerCapabilities, ready: boolean, locked: boolean): void {
  devMenuSaveItem.enabled = ready && caps.canSerialize && !locked;
  devMenuLoadItem.enabled = ready && caps.canSerialize && !locked;
  devMenuOfflineCatchupItem.enabled = ready && caps.canOfflineCatchup && !locked;
}

function createSimWorkerController(mainWindow: BrowserWindow): SimWorkerController {
  const worker = new Worker(new URL('./sim-worker.js', import.meta.url));

  let isDisposing = false;
  let hasFailed = false;
  let isReady = false;

  type ShellSimFailureStatusPayload = Extract<ShellSimStatusPayload, { kind: 'stopped' | 'crashed' }>;

  let stepSizeMs = 16;
  let nextStep = 0;
  const maxStepsPerFrame = 50;

  const tickIntervalMs = 16;
  const MAX_TICK_DELTA_MS = 250;
  let lastTickMs = 0;
  let tickTimer: NodeJS.Timeout | undefined;

  // Capability cache: default disabled until ready
  let capabilities: SimWorkerCapabilities = { canSerialize: false, canOfflineCatchup: false };

  // Worker-ready startup timeout: cleared when valid ready payload is processed
  let readyTimeoutTimer: NodeJS.Timeout | undefined;

  // Operation lock: only one save/load/catchup operation at a time
  let operationLocked = false;
  let activeSerializeRequestId: string | undefined;
  let activeHydrateRequestId: string | undefined;
  let operationTimeoutTimer: NodeJS.Timeout | undefined;

  const clearOperationState = (): void => {
    operationLocked = false;
    activeSerializeRequestId = undefined;
    activeHydrateRequestId = undefined;
    if (operationTimeoutTimer) {
      clearTimeout(operationTimeoutTimer);
      operationTimeoutTimer = undefined;
    }
    refreshDevMenuState(capabilities, isReady && !hasFailed && !isDisposing, false);
  };

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
    if (readyTimeoutTimer) {
      clearTimeout(readyTimeoutTimer);
      readyTimeoutTimer = undefined;
    }
    stopTickLoop();
    clearOperationState();
    refreshDevMenuState(capabilities, false, false);

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

  /**
   * Normalizes a ready message, handling protocol v2, explicit v1, and legacy formats.
   * Returns a result with `ok: true` and normalized fields on success,
   * or `ok: false` with a deterministic failure `reason` on validation failure.
   */
  const normalizeReady = (message: Record<string, unknown>): {
    ok: true;
    stepSizeMs: number;
    nextStep: number;
    capabilities: SimWorkerCapabilities;
  } | {
    ok: false;
    reason: string;
  } => {
    // Validate required fields
    if (typeof message.stepSizeMs !== 'number' || !Number.isFinite(message.stepSizeMs) || message.stepSizeMs < 1) {
      return { ok: false, reason: 'Invalid ready payload: missing or invalid stepSizeMs.' };
    }
    if (typeof message.nextStep !== 'number' || !Number.isFinite(message.nextStep)) {
      return { ok: false, reason: 'Invalid ready payload: missing or invalid nextStep.' };
    }

    const pv = message.protocolVersion;
    const caps = message.capabilities;

    // Legacy fallback: both protocolVersion and capabilities are missing
    if (pv === undefined && caps === undefined) {
      return {
        ok: true,
        stepSizeMs: message.stepSizeMs,
        nextStep: message.nextStep,
        capabilities: { canSerialize: false, canOfflineCatchup: false },
      };
    }

    // Explicit protocol v1: protocolVersion is 1, normalize to disabled capabilities
    if (pv === 1) {
      return {
        ok: true,
        stepSizeMs: message.stepSizeMs,
        nextStep: message.nextStep,
        capabilities: { canSerialize: false, canOfflineCatchup: false },
      };
    }

    // Protocol v2: protocolVersion must be 2 with valid capabilities
    if (pv === 2) {
      if (
        typeof caps === 'object' && caps !== null && !Array.isArray(caps) &&
        typeof (caps as Record<string, unknown>).canSerialize === 'boolean' &&
        typeof (caps as Record<string, unknown>).canOfflineCatchup === 'boolean'
      ) {
        return {
          ok: true,
          stepSizeMs: message.stepSizeMs,
          nextStep: message.nextStep,
          capabilities: {
            canSerialize: (caps as { canSerialize: boolean }).canSerialize,
            canOfflineCatchup: (caps as { canOfflineCatchup: boolean }).canOfflineCatchup,
          },
        };
      }
      // protocolVersion 2 but invalid capabilities
      return { ok: false, reason: 'Invalid ready.capabilities: expected { canSerialize: boolean; canOfflineCatchup: boolean } for protocolVersion 2.' };
    }

    // Any other protocolVersion value is unsupported
    return { ok: false, reason: `Invalid ready.protocolVersion: expected 1 or 2, received ${String(pv)}.` };
  };

  safePostMessage({ kind: 'init', stepSizeMs, maxStepsPerFrame });

  // Start worker-ready timeout immediately after init
  readyTimeoutTimer = setTimeout(() => {
    if (!isReady && !hasFailed && !isDisposing) {
      handleWorkerFailure(
        { kind: 'crashed', reason: 'Worker ready timeout: no valid ready message received.' },
        undefined,
      );
    }
  }, WORKER_READY_TIMEOUT_MS);
  readyTimeoutTimer.unref?.();

  // Emit sim-status 'starting' when the worker controller is created
  sendSimStatus({ kind: 'starting' });

  worker.on('message', (message: SimWorkerOutboundMessage) => {
    // Ignore worker messages after disposal or failure to avoid stale frames/status after restart
    if (isDisposing || hasFailed) {
      return;
    }

    if (message.kind === 'ready') {
      const normalized = normalizeReady(message as unknown as Record<string, unknown>);
      if (!normalized.ok) {
        handleWorkerFailure(
          { kind: 'crashed', reason: normalized.reason },
          message,
        );
        return;
      }

      // Clear ready timeout — valid ready payload arrived in time
      if (readyTimeoutTimer) {
        clearTimeout(readyTimeoutTimer);
        readyTimeoutTimer = undefined;
      }

      stepSizeMs = normalized.stepSizeMs;
      nextStep = normalized.nextStep;
      capabilities = normalized.capabilities;
      isReady = true;
      // Emit sim-status 'running' when the worker is ready
      sendSimStatus({ kind: 'running' });
      refreshDevMenuState(capabilities, true, operationLocked);
      startTickLoop();
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

    if (message.kind === 'saveData') {
      // Request correlation: only consume matching requestId
      if (!activeSerializeRequestId || message.requestId !== activeSerializeRequestId) {
        // Unmatched/duplicate/late response — ignore
        // eslint-disable-next-line no-console
        console.warn(`[shell-desktop] Ignoring unmatched saveData response: ${message.requestId}`);
        return;
      }

      // Consume requestId immediately to reject duplicates, but keep
      // operationLocked true through the entire disk-write phase so a
      // second save cannot overlap and potentially overwrite newer data.
      const savedRequestId = activeSerializeRequestId;
      activeSerializeRequestId = undefined;
      if (operationTimeoutTimer) {
        clearTimeout(operationTimeoutTimer);
        operationTimeoutTimer = undefined;
      }

      if (!message.ok) {
        // Serialize failed — unlock immediately (no disk write pending)
        clearOperationState();
        // eslint-disable-next-line no-console
        console.error(`[shell-desktop] Save failed: ${message.error.message}`);
        return;
      }

      // Persist save data via atomic storage; unlock only after write settles
      void writeSave(message.data).then(() => {
        // eslint-disable-next-line no-console
        console.log(`[shell-desktop] Save complete (requestId: ${savedRequestId}).`);
      }).catch((writeError: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[shell-desktop] Save write failed:', writeError);
      }).finally(() => {
        clearOperationState();
      });
      return;
    }

    if (message.kind === 'hydrateResult') {
      // Request correlation: only consume matching requestId
      if (!activeHydrateRequestId || message.requestId !== activeHydrateRequestId) {
        // Unmatched/duplicate/late response — ignore
        // eslint-disable-next-line no-console
        console.warn(`[shell-desktop] Ignoring unmatched hydrateResult response: ${message.requestId}`);
        return;
      }

      clearOperationState();

      if (!message.ok) {
        // eslint-disable-next-line no-console
        console.error(`[shell-desktop] Load hydrate failed: ${message.error.message}`);
        return;
      }

      nextStep = message.nextStep;
      // eslint-disable-next-line no-console
      console.log(`[shell-desktop] Load complete (nextStep: ${message.nextStep}).`);
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

  const triggerSave = (): void => {
    if (!isReady || hasFailed || isDisposing || operationLocked || !capabilities.canSerialize) {
      return;
    }

    operationLocked = true;
    const requestId = randomUUID().replace(/-/g, '').slice(0, 32);
    activeSerializeRequestId = requestId;
    refreshDevMenuState(capabilities, true, true);

    // Start timeout timer
    operationTimeoutTimer = setTimeout(() => {
      if (activeSerializeRequestId === requestId) {
        // eslint-disable-next-line no-console
        console.error(`[shell-desktop] Save request timed out waiting for requestId ${requestId}.`);
        clearOperationState();
      }
    }, REQUEST_TIMEOUT_MS);
    operationTimeoutTimer.unref?.();

    safePostMessage({ kind: 'serialize', requestId });
  };

  const triggerLoad = (): void => {
    if (!isReady || hasFailed || isDisposing || operationLocked || !capabilities.canSerialize) {
      return;
    }

    operationLocked = true;
    refreshDevMenuState(capabilities, true, true);

    void (async () => {
      try {
        // Open file picker for user to select a save file
        const result = await dialog.showOpenDialog(mainWindow, {
          title: 'Load Save File',
          filters: [{ name: 'Save Files', extensions: ['bin'] }, { name: 'All Files', extensions: ['*'] }],
          properties: ['openFile'],
        });

        if (result.canceled || result.filePaths.length === 0) {
          // User cancelled the picker — return to idle without error
          clearOperationState();
          return;
        }

        const selectedPath = result.filePaths[0]!;
        const buffer = await fsPromises.readFile(selectedPath);
        const saveBytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);

        if (saveBytes.byteLength === 0) {
          // eslint-disable-next-line no-console
          console.error('[shell-desktop] Load failed: selected file is empty.');
          clearOperationState();
          return;
        }

        // Decode and validate save data using core binary codec
        let validSave: GameStateSaveFormat;
        try {
          validSave = await decodeGameStateSave(saveBytes);
        } catch (decodeError: unknown) {
          // eslint-disable-next-line no-console
          console.error('[shell-desktop] Load failed: save data decode/validation failed.', decodeError);
          clearOperationState();
          return;
        }

        // Send hydrate request to worker
        const requestId = randomUUID().replace(/-/g, '').slice(0, 32);
        activeHydrateRequestId = requestId;

        // Start timeout timer
        operationTimeoutTimer = setTimeout(() => {
          if (activeHydrateRequestId === requestId) {
            // eslint-disable-next-line no-console
            console.error(`[shell-desktop] Hydrate request timed out waiting for requestId ${requestId}.`);
            clearOperationState();
          }
        }, REQUEST_TIMEOUT_MS);
        operationTimeoutTimer.unref?.();

        safePostMessage({ kind: 'hydrate', requestId, save: validSave });
      } catch (loadError: unknown) {
        // eslint-disable-next-line no-console
        console.error('[shell-desktop] Load failed:', loadError);
        clearOperationState();
      }
    })();
  };

  const triggerOfflineCatchup = (): void => {
    if (!isReady || hasFailed || isDisposing || operationLocked || !capabilities.canOfflineCatchup) {
      return;
    }

    // Build a default OFFLINE_CATCHUP command with 1 hour elapsed and empty resourceDeltas
    const elapsedMs = 3_600_000; // 1 hour
    const resourceDeltas: Record<string, number> = {};

    const command: Command = {
      type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
      priority: CommandPriority.SYSTEM,
      step: nextStep,
      timestamp: nextStep * stepSizeMs,
      payload: {
        elapsedMs,
        resourceDeltas,
      },
    };

    try {
      safePostMessage({ kind: 'enqueueCommands', commands: [command] });
      // eslint-disable-next-line no-console
      console.log('[shell-desktop] Offline catch-up queued.');
    } catch (dispatchError: unknown) {
      // eslint-disable-next-line no-console
      console.error('[shell-desktop] Offline catch-up dispatch failed:', dispatchError);
    }
  };

  const getCapabilities = (): SimWorkerCapabilities => capabilities;

  const dispose = (): void => {
    isDisposing = true;
    if (readyTimeoutTimer) {
      clearTimeout(readyTimeoutTimer);
      readyTimeoutTimer = undefined;
    }
    stopTickLoop();
    clearOperationState();
    refreshDevMenuState(capabilities, false, false);
    void worker.terminate().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
  };

  return { sendControlEvent, sendInputEvent, triggerSave, triggerLoad, triggerOfflineCatchup, getCapabilities, dispose };
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
    {
      label: 'Dev',
      submenu: [
        devMenuSaveItem,
        devMenuLoadItem,
        { type: 'separator' },
        devMenuOfflineCatchupItem,
      ],
    },
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
    // Best-effort cleanup of stale temp save files from interrupted writes.
    // Must run before save/load operations become available (i.e. before worker init).
    try {
      await cleanupStaleTempFiles();
    } catch (cleanupError: unknown) {
      // eslint-disable-next-line no-console
      console.error('[shell-desktop] Stale temp cleanup failed (non-fatal):', cleanupError);
    }

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
