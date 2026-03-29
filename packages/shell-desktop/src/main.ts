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
  type RuntimeCommandPayloads,
} from '@idle-engine/core';
import {
  IPC_CHANNELS,
  type IpcInvokeMap,
  type ShellControlEvent,
  type ShellInputEventEnvelope,
  type ShellRendererDiagnosticsPayload,
  type ShellRendererLogPayload,
  type ShellSimStatusPayload,
} from './ipc.js';
import { monotonicNowMs } from './monotonic-time.js';
import type { MenuItemConstructorOptions } from 'electron';
import type { ControlScheme } from '@idle-engine/controls';
import type { AssetMcpController } from './mcp/asset-tools.js';
import type {
  DiagnosticsLogEntry,
  DiagnosticsLogSeverity,
  DiagnosticsMcpController,
  DiagnosticsWebGpuHealthStatus,
  RendererDiagnosticsStatus,
  WebGpuHealthProbe,
} from './mcp/diagnostics-tools.js';
import type { InputMcpController } from './mcp/input-tools.js';
import type { ShellDesktopMcpServer } from './mcp/mcp-server.js';
import { SIM_MCP_MAX_STEP_COUNT, type SimMcpController, type SimMcpStatus } from './mcp/sim-tools.js';
import type { WindowMcpController } from './mcp/window-tools.js';
import {
  DEFAULT_SIM_RUNTIME_CAPABILITIES,
  type SimRuntimeCapabilities,
  type SimWorkerInboundMessage,
  type SimWorkerOutboundMessage,
} from './sim/worker-protocol.js';

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
const MAX_DIAGNOSTICS_LOG_ENTRIES = 2_000;
const SHELL_DESKTOP_SAVE_SCHEMA_VERSION = 1;
const OFFLINE_CATCHUP_PRESETS = [
  { label: 'Offline Catch-up: 5 Minutes', elapsedMs: 5 * 60 * 1000 },
  { label: 'Offline Catch-up: 1 Hour', elapsedMs: 60 * 60 * 1000 },
] as const;

const assetMcpController: AssetMcpController = {
  compiledAssetsRootPath,
};

let rendererDiagnosticsStatus: RendererDiagnosticsStatus | undefined;
let webGpuHealthProbe: WebGpuHealthProbe = {
  status: 'lost',
  lastLossReason: 'WebGPU status pending.',
};
let diagnosticsLogId = 0;
const diagnosticsLogs: DiagnosticsLogEntry[] = [];

function pushDiagnosticsLog(
  entry: Readonly<{
    source: DiagnosticsLogEntry['source'];
    subsystem: string;
    severity: DiagnosticsLogSeverity;
    message: string;
    metadata?: Readonly<Record<string, unknown>>;
  }>,
): void {
  const nowMs = Date.now();
  diagnosticsLogId += 1;
  diagnosticsLogs.push({
    id: diagnosticsLogId,
    timestampMs: nowMs,
    source: entry.source,
    subsystem: entry.subsystem,
    severity: entry.severity,
    message: entry.message,
    ...(entry.metadata === undefined ? {} : { metadata: entry.metadata }),
  });

  const overflow = diagnosticsLogs.length - MAX_DIAGNOSTICS_LOG_ENTRIES;
  if (overflow > 0) {
    diagnosticsLogs.splice(0, overflow);
  }
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`;
  }

  if (typeof value === 'object' && value !== null) {
    try {
      const jsonValue = JSON.stringify(value);
      if (jsonValue !== undefined) {
        return jsonValue;
      }
    } catch {
      return '[Unserializable object]';
    }
    return Object.prototype.toString.call(value);
  }

  return String(value);
}

type ShellDesktopSaveEnvelope = Readonly<{
  schemaVersion: typeof SHELL_DESKTOP_SAVE_SCHEMA_VERSION;
  metadata: Readonly<{
    savedAt: string;
    appVersion: string;
    runtime: Readonly<{
      saveFileStem: string;
      saveSchemaVersion: number;
      contentHash?: string;
      contentVersion?: string;
    }>;
  }>;
  state: unknown;
}>;

type OfflineCatchupPayload =
  RuntimeCommandPayloads[typeof RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP];

function asRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(message);
  }

  return value as Record<string, unknown>;
}

function trimHyphenEdges(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value.codePointAt(start) === 45) {
    start += 1;
  }

  while (end > start && value.codePointAt(end - 1) === 45) {
    end -= 1;
  }

  return value.slice(start, end);
}

function isAllowedSaveFileStemCharacter(codePoint: number): boolean {
  return (
    (codePoint >= 48 && codePoint <= 57) ||
    (codePoint >= 65 && codePoint <= 90) ||
    (codePoint >= 97 && codePoint <= 122) ||
    codePoint === 45 ||
    codePoint === 46 ||
    codePoint === 95
  );
}

function collapseUnsafeSaveFileStemCharacters(value: string): string {
  let sanitized = '';
  let previousWasReplacement = false;

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && isAllowedSaveFileStemCharacter(codePoint)) {
      sanitized += character;
      previousWasReplacement = false;
      continue;
    }

    if (!previousWasReplacement) {
      sanitized += '-';
      previousWasReplacement = true;
    }
  }

  return sanitized;
}

function sanitizeSaveFileStem(value: string | undefined): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return 'sim-state';
  }

  const sanitized = trimHyphenEdges(
    collapseUnsafeSaveFileStemCharacters(value.trim()),
  );

  return sanitized.length > 0 ? sanitized : 'sim-state';
}

function getSaveFileStem(capabilities: SimRuntimeCapabilities): string {
  return sanitizeSaveFileStem(capabilities.saveFileStem);
}

function buildShellSavePath(capabilities: SimRuntimeCapabilities): string {
  return path.join(app.getPath('userData'), `${getSaveFileStem(capabilities)}.save.json`);
}

function buildShellSaveEnvelope(
  capabilities: SimRuntimeCapabilities,
  state: unknown,
): ShellDesktopSaveEnvelope {
  return {
    schemaVersion: SHELL_DESKTOP_SAVE_SCHEMA_VERSION,
    metadata: {
      savedAt: new Date().toISOString(),
      appVersion: app.getVersion(),
      runtime: {
        saveFileStem: getSaveFileStem(capabilities),
        saveSchemaVersion: capabilities.saveSchemaVersion ?? 1,
        ...(capabilities.contentHash === undefined ? {} : { contentHash: capabilities.contentHash }),
        ...(capabilities.contentVersion === undefined ? {} : { contentVersion: capabilities.contentVersion }),
      },
    },
    state,
  };
}

function parseShellSaveRuntimeMetadata(
  value: unknown,
  capabilities: SimRuntimeCapabilities,
): ShellDesktopSaveEnvelope['metadata']['runtime'] {
  const runtimeMetadata = asRecord(
    value,
    'Invalid save file: expected metadata.runtime object.',
  );
  const saveFileStem = runtimeMetadata['saveFileStem'];
  const saveSchemaVersion = runtimeMetadata['saveSchemaVersion'];
  const contentHash = runtimeMetadata['contentHash'];
  const contentVersion = runtimeMetadata['contentVersion'];

  if (typeof saveFileStem !== 'string' || saveFileStem.trim().length === 0) {
    throw new TypeError('Invalid save file: expected metadata.runtime.saveFileStem string.');
  }
  if (typeof saveSchemaVersion !== 'number' || !Number.isInteger(saveSchemaVersion) || saveSchemaVersion < 1) {
    throw new TypeError('Invalid save file: expected metadata.runtime.saveSchemaVersion integer.');
  }
  if (contentHash !== undefined && typeof contentHash !== 'string') {
    throw new TypeError('Invalid save file: expected metadata.runtime.contentHash string.');
  }
  if (contentVersion !== undefined && typeof contentVersion !== 'string') {
    throw new TypeError('Invalid save file: expected metadata.runtime.contentVersion string.');
  }

  const expectedSaveFileStem = getSaveFileStem(capabilities);
  if (saveFileStem !== expectedSaveFileStem) {
    throw new Error(
      `Save identity mismatch: expected ${expectedSaveFileStem} but found ${saveFileStem}.`,
    );
  }

  if (
    capabilities.saveSchemaVersion !== undefined &&
    saveSchemaVersion !== capabilities.saveSchemaVersion
  ) {
    throw new Error(
      `Save schema mismatch: expected ${capabilities.saveSchemaVersion} but found ${saveSchemaVersion}.`,
    );
  }

  if (
    capabilities.contentHash !== undefined &&
    typeof contentHash === 'string' &&
    contentHash !== capabilities.contentHash
  ) {
    throw new Error(
      `Save content hash mismatch: expected ${capabilities.contentHash} but found ${contentHash}.`,
    );
  }

  return {
    saveFileStem,
    saveSchemaVersion,
    ...(contentHash === undefined ? {} : { contentHash }),
    ...(contentVersion === undefined ? {} : { contentVersion }),
  };
}

function parseShellSaveEnvelope(
  raw: string,
  capabilities: SimRuntimeCapabilities,
): ShellDesktopSaveEnvelope {
  const parsed = JSON.parse(raw) as unknown;
  const record = asRecord(parsed, 'Invalid save file: expected a top-level object.');
  if (record['schemaVersion'] !== SHELL_DESKTOP_SAVE_SCHEMA_VERSION) {
    throw new TypeError(`Unsupported shell save schema version: ${record['schemaVersion']}`);
  }

  const metadata = asRecord(record['metadata'], 'Invalid save file: expected metadata object.');
  const savedAt = metadata['savedAt'];
  const appVersion = metadata['appVersion'];
  if (typeof savedAt !== 'string' || savedAt.trim().length === 0) {
    throw new TypeError('Invalid save file: expected metadata.savedAt string.');
  }
  if (typeof appVersion !== 'string' || appVersion.trim().length === 0) {
    throw new TypeError('Invalid save file: expected metadata.appVersion string.');
  }

  const runtime = parseShellSaveRuntimeMetadata(metadata['runtime'], capabilities);
  if (!Reflect.has(record, 'state')) {
    throw new TypeError('Invalid save file: expected persisted state payload.');
  }

  return {
    schemaVersion: SHELL_DESKTOP_SAVE_SCHEMA_VERSION,
    metadata: {
      savedAt,
      appVersion,
      runtime,
    },
    state: record['state'],
  };
}

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await fsPromises.writeFile(tempPath, contents, 'utf8');
    await fsPromises.rename(tempPath, filePath);
  } catch (error: unknown) {
    await fsPromises.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDiagnosticsLogSeverity(value: unknown): value is DiagnosticsLogSeverity {
  return value === 'debug' || value === 'info' || value === 'warn' || value === 'error';
}

function isDiagnosticsWebGpuHealthStatus(value: unknown): value is DiagnosticsWebGpuHealthStatus {
  return value === 'ok' || value === 'lost' || value === 'recovered';
}

function isRendererLogPayload(value: unknown): value is ShellRendererLogPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const severity = (value as { severity?: unknown }).severity;
  const subsystem = (value as { subsystem?: unknown }).subsystem;
  const message = (value as { message?: unknown }).message;
  const metadata = (value as { metadata?: unknown }).metadata;

  if (!isDiagnosticsLogSeverity(severity) || !isNonEmptyString(subsystem) || !isNonEmptyString(message)) {
    return false;
  }

  if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
    return false;
  }

  return true;
}

function isRendererDiagnosticsPayload(value: unknown): value is ShellRendererDiagnosticsPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const outputText = (value as { outputText?: unknown }).outputText;
  if (typeof outputText !== 'string') {
    return false;
  }

  const errorBannerText = (value as { errorBannerText?: unknown }).errorBannerText;
  if (errorBannerText !== undefined && typeof errorBannerText !== 'string') {
    return false;
  }

  const rendererState = (value as { rendererState?: unknown }).rendererState;
  if (rendererState !== undefined && typeof rendererState !== 'string') {
    return false;
  }

  const webgpu = (value as { webgpu?: unknown }).webgpu;
  if (webgpu !== undefined) {
    if (typeof webgpu !== 'object' || webgpu === null || Array.isArray(webgpu)) {
      return false;
    }

    const status = (webgpu as { status?: unknown }).status;
    const lastLossReason = (webgpu as { lastLossReason?: unknown }).lastLossReason;
    if (!isDiagnosticsWebGpuHealthStatus(status)) {
      return false;
    }
    if (lastLossReason !== undefined && typeof lastLossReason !== 'string') {
      return false;
    }
  }

  return true;
}

type SimWorkerController = Readonly<{
  sendControlEvent: (event: ShellControlEvent) => void;
  sendInputEvent: (envelope: ShellInputEventEnvelope) => void;
  enqueueCommands: (commands: readonly Command[]) => void;
  serializeState: () => Promise<unknown>;
  hydrateState: (state: unknown) => Promise<void>;
  runWhileCommandIngressFrozen: <T>(operation: () => Promise<T> | T) => Promise<T>;
  isCommandIngressFrozen: () => boolean;
  pause: () => void;
  resume: () => void;
  step: (steps: number) => Promise<SimMcpStatus>;
  getStatus: () => SimMcpStatus;
  getCapabilities: () => SimRuntimeCapabilities;
  dispose: () => void;
}>;

type SimWorkerControllerOptions = Readonly<{
  onCapabilitiesChanged?: (capabilities: SimRuntimeCapabilities) => void;
}>;

const buildStoppedSimStatus = (): SimMcpStatus => ({ state: 'stopped', stepSizeMs: 16, nextStep: 0 });

let mainWindow: BrowserWindow | undefined;
let simWorkerController: SimWorkerController | undefined;
let mcpServer: ShellDesktopMcpServer | undefined;
let simRuntimeCapabilities: SimRuntimeCapabilities = DEFAULT_SIM_RUNTIME_CAPABILITIES;
let simToolingBusy = false;
const SIM_TOOLING_BUSY_ERROR = 'Simulation save/load is in progress.';
const SIM_STEP_INVALIDATED_BY_LOAD_ERROR = 'Simulation step was interrupted by state load.';

function createSimWorkerController(
  mainWindow: BrowserWindow,
  options: SimWorkerControllerOptions = {},
): SimWorkerController {
  const worker = new Worker(new URL('./sim-worker.js', import.meta.url));

  let isDisposing = false;
  let hasFailed = false;
  let isReady = false;
  let isPaused = false;
  let runtimeCapabilities: SimRuntimeCapabilities = DEFAULT_SIM_RUNTIME_CAPABILITIES;

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
  const pendingRequests = new Map<
    string,
    Readonly<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }>
  >();
  let requestSequence = 0;
  let commandIngressFreezeDepth = 0;

  const tickIntervalMs = 16;
  const MAX_TICK_DELTA_MS = 250;
  let lastTickMs = 0;
  let tickTimer: NodeJS.Timeout | undefined;
  const notifyCapabilitiesChanged = (): void => {
    options.onCapabilitiesChanged?.(runtimeCapabilities);
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

  const isCommandIngressFrozen = (): boolean => commandIngressFreezeDepth > 0;

  const publishFrame = (frame: Extract<SimWorkerOutboundMessage, { kind: 'frame' }>['frame']): void => {
    if (!frame) {
      return;
    }

    try {
      mainWindow.webContents.send(IPC_CHANNELS.frame, frame);
    } catch (error: unknown) {
      // eslint-disable-next-line no-console
      console.error(error);
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

  const rejectPendingRequests = (error: Error): void => {
    if (pendingRequests.size === 0) {
      return;
    }

    for (const pendingRequest of pendingRequests.values()) {
      pendingRequest.reject(error);
    }
    pendingRequests.clear();
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
    rejectPendingRequests(new Error(`Sim ${status.kind}: ${status.reason}`));
    runtimeCapabilities = DEFAULT_SIM_RUNTIME_CAPABILITIES;
    notifyCapabilitiesChanged();

    pushDiagnosticsLog({
      source: 'main',
      subsystem: 'sim',
      severity: status.kind === 'stopped' ? 'warn' : 'error',
      message: `Sim ${status.kind}: ${status.reason}`,
      metadata: details === undefined
        ? undefined
        : {
            details: stringifyUnknown(details),
            ...(status.exitCode === undefined ? {} : { exitCode: status.exitCode }),
          },
    });

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
      const reason = error instanceof Error ? error.message : stringifyUnknown(error);
      handleWorkerFailure({ kind: 'crashed', reason }, error);
    }
  };

  const takePendingRequest = (
    requestId: string,
  ): Readonly<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }> | undefined => {
    const pendingRequest = pendingRequests.get(requestId);
    if (!pendingRequest) {
      return undefined;
    }

    pendingRequests.delete(requestId);
    return pendingRequest;
  };

  const requestWorker = <TResponse>(message: SimWorkerInboundMessage & Readonly<{ requestId: string }>): Promise<TResponse> => {
    if (hasFailed || isDisposing) {
      throw new Error('Simulation is not running.');
    }

    if (!isReady) {
      throw new Error('Sim is not ready yet.');
    }

    return new Promise<TResponse>((resolve, reject) => {
      pendingRequests.set(message.requestId, {
        resolve: (value: unknown) => {
          resolve(value as TResponse);
        },
        reject,
      });
      safePostMessage(message);
    });
  };

  const runWhileCommandIngressFrozen = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    if (hasFailed || isDisposing) {
      throw new Error('Simulation is not running.');
    }

    if (!isReady) {
      throw new Error('Sim is not ready yet.');
    }

    const wasPaused = isPaused;
    isPaused = true;
    commandIngressFreezeDepth += 1;
    stopTickLoop();

    try {
      return await operation();
    } finally {
      commandIngressFreezeDepth = Math.max(0, commandIngressFreezeDepth - 1);
      isPaused = wasPaused;
      if (!wasPaused && !isCommandIngressFrozen()) {
        startTickLoop();
      }
    }
  };

  notifyCapabilitiesChanged();

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
  pushDiagnosticsLog({
    source: 'main',
    subsystem: 'sim',
    severity: 'info',
    message: 'Sim worker init requested.',
    metadata: { stepSizeMs, maxStepsPerFrame },
  });

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
      runtimeCapabilities = message.capabilities ?? DEFAULT_SIM_RUNTIME_CAPABILITIES;
      notifyCapabilitiesChanged();
      pushDiagnosticsLog({
        source: 'main',
        subsystem: 'sim',
        severity: 'info',
        message: 'Sim worker is ready.',
        metadata: { stepSizeMs, nextStep, capabilities: runtimeCapabilities },
      });
      resolvePendingStepCompletions();
      // Emit sim-status 'running' when the worker is ready
      sendSimStatus({ kind: 'running' });
      startTickLoop();
      return;
    }

    if (message.kind === 'frame') {
      nextStep = message.nextStep;
      resolvePendingStepCompletions();
      publishFrame(message.frame);
      return;
    }

    if (message.kind === 'serialized') {
      takePendingRequest(message.requestId)?.resolve(message.state);
      return;
    }

    if (message.kind === 'hydrated') {
      rejectPendingStepCompletions(new Error(SIM_STEP_INVALIDATED_BY_LOAD_ERROR));
      nextStep = message.nextStep;
      runtimeCapabilities = message.capabilities ?? runtimeCapabilities;
      notifyCapabilitiesChanged();
      publishFrame(message.frame);
      takePendingRequest(message.requestId)?.resolve(undefined);
      return;
    }

    if (message.kind === 'requestError') {
      takePendingRequest(message.requestId)?.reject(new Error(message.error));
      return;
    }

    if (message.kind === 'error') {
      handleWorkerFailure({ kind: 'crashed', reason: message.error }, message.error);
    }
  });

  worker.on('error', (error: unknown) => {
    handleWorkerFailure(
      { kind: 'crashed', reason: error instanceof Error ? error.message : stringifyUnknown(error) },
      error,
    );
  });

  worker.on('messageerror', (error: unknown) => {
    handleWorkerFailure(
      { kind: 'crashed', reason: error instanceof Error ? error.message : stringifyUnknown(error) },
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
    if (!isReady || isCommandIngressFrozen()) {
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
      const reason = error instanceof Error ? error.message : stringifyUnknown(error);
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
    if (!isReady || isCommandIngressFrozen()) {
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
    if (isCommandIngressFrozen()) {
      return;
    }

    safePostMessage({ kind: 'enqueueCommands', commands });
  };

  const serializeState = async (): Promise<unknown> => {
    return runWhileCommandIngressFrozen(async () => {
      const requestId = `serialize-${++requestSequence}`;
      return requestWorker<unknown>({ kind: 'serialize', requestId });
    });
  };

  const hydrateState = async (state: unknown): Promise<void> => {
    await runWhileCommandIngressFrozen(async () => {
      const requestId = `hydrate-${++requestSequence}`;
      await requestWorker<void>({ kind: 'hydrate', requestId, state });
    });
  };

  const pause = (): void => {
    if (hasFailed || isDisposing) {
      return;
    }

    if (isCommandIngressFrozen()) {
      throw new Error(SIM_TOOLING_BUSY_ERROR);
    }

    isPaused = true;
    stopTickLoop();
  };

  const resume = (): void => {
    if (hasFailed || isDisposing) {
      return;
    }

    if (isCommandIngressFrozen()) {
      throw new Error(SIM_TOOLING_BUSY_ERROR);
    }

    isPaused = false;
    startTickLoop();
  };

  const step = async (steps: number): Promise<SimMcpStatus> => {
    if (!Number.isFinite(steps) || Math.floor(steps) !== steps || steps < 1 || steps > SIM_MCP_MAX_STEP_COUNT) {
      throw new TypeError(`Invalid sim step count: expected integer in [1, ${SIM_MCP_MAX_STEP_COUNT}]`);
    }

    if (hasFailed || isDisposing) {
      throw new Error('Simulation is not running.');
    }

    if (!isReady) {
      throw new Error('Sim is not ready to step yet.');
    }

    if (isCommandIngressFrozen()) {
      throw new Error(SIM_TOOLING_BUSY_ERROR);
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

  const getCapabilities = (): SimRuntimeCapabilities => runtimeCapabilities;

  const dispose = (): void => {
    isDisposing = true;
    isPaused = true;
    stopTickLoop();
    rejectPendingStepCompletions(new Error('Simulation stopped before step completed.'));
    rejectPendingRequests(new Error('Simulation stopped before worker request completed.'));
    runtimeCapabilities = DEFAULT_SIM_RUNTIME_CAPABILITIES;
    notifyCapabilitiesChanged();
    void worker.terminate().catch((error: unknown) => {
      // eslint-disable-next-line no-console
      console.error(error);
    });
  };

  return {
    sendControlEvent,
    sendInputEvent,
    enqueueCommands,
    serializeState,
    hydrateState,
    runWhileCommandIngressFrozen,
    isCommandIngressFrozen,
    pause,
    resume,
    step,
    getStatus,
    getCapabilities,
    dispose,
  };
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

    simWorkerController = createSimWorkerController(mainWindow, {
      onCapabilitiesChanged: updateSimRuntimeCapabilities,
    });
    pushDiagnosticsLog({
      source: 'main',
      subsystem: 'sim',
      severity: 'info',
      message: 'Simulation started via MCP.',
    });
    return simWorkerController.getStatus();
  },
  stop: () => {
    const current = simWorkerController?.getStatus();
    simWorkerController?.dispose();
    simWorkerController = undefined;
    pushDiagnosticsLog({
      source: 'main',
      subsystem: 'sim',
      severity: 'info',
      message: 'Simulation stopped via MCP.',
    });
    return current ? { ...current, state: 'stopped' } : buildStoppedSimStatus();
  },
  pause: () => {
    if (!simWorkerController) {
      throw new Error('Simulation is not running.');
    }

    simWorkerController.pause();
    pushDiagnosticsLog({
      source: 'main',
      subsystem: 'sim',
      severity: 'info',
      message: 'Simulation paused via MCP.',
    });
    return simWorkerController.getStatus();
  },
  resume: () => {
    if (!simWorkerController) {
      throw new Error('Simulation is not running.');
    }

    if (simWorkerController.isCommandIngressFrozen()) {
      throw new Error(SIM_TOOLING_BUSY_ERROR);
    }

    simWorkerController.resume();
    pushDiagnosticsLog({
      source: 'main',
      subsystem: 'sim',
      severity: 'info',
      message: 'Simulation resumed via MCP.',
    });
    return simWorkerController.getStatus();
  },
  step: async (steps) => {
    const controller = simWorkerController;
    if (!controller) {
      throw new Error('Simulation is not running.');
    }

    if (controller.isCommandIngressFrozen()) {
      throw new Error(SIM_TOOLING_BUSY_ERROR);
    }

    return controller.step(steps);
  },
  enqueue: (commands) => {
    const controller = simWorkerController;
    if (!controller) {
      throw new Error('Simulation is not running.');
    }

    const status = controller.getStatus();
    if (status.state === 'crashed' || status.state === 'stopped') {
      throw new Error(`Simulation is ${status.state}; cannot enqueue commands.`);
    }

    if (controller.isCommandIngressFrozen()) {
      throw new Error(SIM_TOOLING_BUSY_ERROR);
    }

    controller.enqueueCommands(commands);
    return { enqueued: commands.length };
  },
};

function updateSimRuntimeCapabilities(capabilities: SimRuntimeCapabilities): void {
  if (simRuntimeCapabilities === capabilities) {
    return;
  }

  simRuntimeCapabilities = capabilities;
  installAppMenu();
}

function setSimToolingBusy(isBusy: boolean): void {
  if (simToolingBusy === isBusy) {
    return;
  }

  simToolingBusy = isBusy;
  installAppMenu();
}

async function saveSimulationState(): Promise<void> {
  const controller = simWorkerController;
  const capabilities = controller?.getCapabilities() ?? DEFAULT_SIM_RUNTIME_CAPABILITIES;
  if (!controller || !capabilities.canSerialize) {
    throw new Error('Simulation runtime does not support save.');
  }

  const serializedState = await controller.serializeState();
  const savePath = buildShellSavePath(capabilities);
  const envelope = buildShellSaveEnvelope(capabilities, serializedState);
  await writeFileAtomic(savePath, `${JSON.stringify(envelope, null, 2)}\n`);

  pushDiagnosticsLog({
    source: 'main',
    subsystem: 'sim-tooling',
    severity: 'info',
    message: 'Simulation save written.',
    metadata: {
      savePath,
      saveFileStem: getSaveFileStem(capabilities),
    },
  });
}

async function loadSimulationState(): Promise<void> {
  const controller = simWorkerController;
  const capabilities = controller?.getCapabilities() ?? DEFAULT_SIM_RUNTIME_CAPABILITIES;
  if (!controller || !capabilities.canHydrate) {
    throw new Error('Simulation runtime does not support load.');
  }

  const savePath = buildShellSavePath(capabilities);
  const envelope = await controller.runWhileCommandIngressFrozen(async () => {
    const rawSave = await fsPromises.readFile(savePath, 'utf8');
    const parsedEnvelope = parseShellSaveEnvelope(rawSave, capabilities);
    await controller.hydrateState(parsedEnvelope.state);
    return parsedEnvelope;
  });

  pushDiagnosticsLog({
    source: 'main',
    subsystem: 'sim-tooling',
    severity: 'info',
    message: 'Simulation save loaded.',
    metadata: {
      savePath,
      savedAt: envelope.metadata.savedAt,
      saveFileStem: envelope.metadata.runtime.saveFileStem,
    },
  });
}

function enqueueOfflineCatchup(elapsedMs: number): void {
  const controller = simWorkerController;
  const capabilities = controller?.getCapabilities() ?? DEFAULT_SIM_RUNTIME_CAPABILITIES;
  if (!controller || !capabilities.supportsOfflineCatchup) {
    throw new Error('Simulation runtime does not support offline catch-up.');
  }

  const status = controller.getStatus();
  const payload: OfflineCatchupPayload = { elapsedMs };
  controller.enqueueCommands([
    {
      type: RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP,
      priority: CommandPriority.SYSTEM,
      payload,
      step: status.nextStep,
      timestamp: status.nextStep * status.stepSizeMs,
    },
  ]);

  pushDiagnosticsLog({
    source: 'main',
    subsystem: 'sim-tooling',
    severity: 'info',
    message: 'Offline catch-up enqueued.',
    metadata: {
      elapsedMs,
      step: status.nextStep,
    },
  });
}

function runSimToolingAction(label: string, action: () => Promise<void> | void): void {
  if (simToolingBusy) {
    return;
  }

  setSimToolingBusy(true);
  void Promise.resolve()
    .then(action)
    .catch((error: unknown) => {
      pushDiagnosticsLog({
        source: 'main',
        subsystem: 'sim-tooling',
        severity: 'error',
        message: `${label} failed.`,
        metadata: { error: stringifyUnknown(error) },
      });
      // eslint-disable-next-line no-console
      console.error(`[shell-desktop] ${label} failed`, error);
    })
    .finally(() => {
      setSimToolingBusy(false);
    });
}

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

    if (simWorkerController.isCommandIngressFrozen()) {
      throw new Error(SIM_TOOLING_BUSY_ERROR);
    }

    simWorkerController.sendControlEvent(event);
  },
};

const diagnosticsMcpController: DiagnosticsMcpController = {
  getRendererStatus: () => rendererDiagnosticsStatus,
  getLogs: () => diagnosticsLogs,
  getWebGpuHealth: () => webGpuHealthProbe,
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

  ipcMain.on(IPC_CHANNELS.rendererDiagnostics, (_event, payload: unknown) => {
    if (!isRendererDiagnosticsPayload(payload)) {
      return;
    }

    const nowMs = Date.now();
    rendererDiagnosticsStatus = {
      outputText: payload.outputText,
      ...(payload.errorBannerText === undefined ? {} : { errorBannerText: payload.errorBannerText }),
      ...(payload.rendererState === undefined ? {} : { rendererState: payload.rendererState }),
      updatedAtMs: nowMs,
    };

    if (payload.webgpu !== undefined) {
      const previous = webGpuHealthProbe;
      webGpuHealthProbe = {
        status: payload.webgpu.status,
        ...(payload.webgpu.lastLossReason === undefined ? {} : { lastLossReason: payload.webgpu.lastLossReason }),
        lastEventTimestampMs: nowMs,
      };

      if (
        previous.status !== webGpuHealthProbe.status
        || previous.lastLossReason !== webGpuHealthProbe.lastLossReason
      ) {
        const severity: DiagnosticsLogSeverity = webGpuHealthProbe.status === 'lost' ? 'warn' : 'info';
        pushDiagnosticsLog({
          source: 'renderer',
          subsystem: 'webgpu',
          severity,
          message: `WebGPU status: ${webGpuHealthProbe.status}`,
          metadata: {
            ...(webGpuHealthProbe.lastLossReason === undefined
              ? {}
              : { lastLossReason: webGpuHealthProbe.lastLossReason }),
          },
        });
      }
    }
  });

  ipcMain.on(IPC_CHANNELS.rendererLog, (_event, payload: unknown) => {
    if (!isRendererLogPayload(payload)) {
      return;
    }

    pushDiagnosticsLog({
      source: 'renderer',
      subsystem: payload.subsystem.trim(),
      severity: payload.severity,
      message: payload.message,
      ...(payload.metadata === undefined ? {} : { metadata: payload.metadata }),
    });
  });
}

function installAppMenu(): void {
  const hasSaveSupport =
    simWorkerController !== undefined &&
    !simToolingBusy &&
    simRuntimeCapabilities.canSerialize;
  const hasLoadSupport =
    simWorkerController !== undefined &&
    !simToolingBusy &&
    simRuntimeCapabilities.canHydrate;
  const hasOfflineCatchupSupport =
    simWorkerController !== undefined &&
    !simToolingBusy &&
    simRuntimeCapabilities.supportsOfflineCatchup;

  const simulationSubmenu: MenuItemConstructorOptions[] = [
    {
      label: 'Save',
      enabled: hasSaveSupport,
      click: () => {
        runSimToolingAction('Save state', saveSimulationState);
      },
    },
    {
      label: 'Load',
      enabled: hasLoadSupport,
      click: () => {
        runSimToolingAction('Load state', loadSimulationState);
      },
    },
    { type: 'separator' },
    ...OFFLINE_CATCHUP_PRESETS.map<MenuItemConstructorOptions>((preset) => ({
      label: preset.label,
      enabled: hasOfflineCatchupSupport,
      click: () => {
        runSimToolingAction(preset.label, () => {
          enqueueOfflineCatchup(preset.elapsedMs);
        });
      },
    })),
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
    { label: 'Simulation', submenu: simulationSubmenu },
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
    simWorkerController = createSimWorkerController(mainWindow, {
      onCapabilitiesChanged: updateSimRuntimeCapabilities,
    });
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
        diagnostics: diagnosticsMcpController,
      });
      if (mcpServer) {
        pushDiagnosticsLog({
          source: 'main',
          subsystem: 'mcp',
          severity: 'info',
          message: 'Embedded MCP server started.',
          metadata: { url: mcpServer.url.toString() },
        });
      }
    }
    mainWindow = await createMainWindow();
    simWorkerController = createSimWorkerController(mainWindow, {
      onCapabilitiesChanged: updateSimRuntimeCapabilities,
    });
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
  simRuntimeCapabilities = DEFAULT_SIM_RUNTIME_CAPABILITIES;
  simToolingBusy = false;
  mainWindow = undefined;
  installAppMenu();
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
        simWorkerController = createSimWorkerController(createdWindow, {
          onCapabilitiesChanged: updateSimRuntimeCapabilities,
        });
      })
      .catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error(error);
      });
  }
});
