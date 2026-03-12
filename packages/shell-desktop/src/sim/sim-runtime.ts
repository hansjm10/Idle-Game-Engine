import {
  IdleEngineRuntime,
  RUNTIME_COMMAND_TYPES,
  type Command,
  type InputEventCommandPayload,
  type RuntimeCommandPayloads,
} from '@idle-engine/core';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import { SHELL_CONTROL_EVENT_COMMAND_TYPE, type ShellControlEvent } from '../ipc.js';
import {
  DEFAULT_SIM_RUNTIME_CAPABILITIES,
  type SimRuntimeCapabilities,
} from './worker-protocol.js';
import type { AssetId, RenderCommandBuffer } from '@idle-engine/renderer-contract';

export const SIM_RUNTIME_SAVE_SCHEMA_VERSION = 1;

type DemoState = {
  tickCount: number;
  resourceCount: number;
  lastCollectedStep: number | null;
};

export type SerializedSimRuntimeState = Readonly<{
  schemaVersion: typeof SIM_RUNTIME_SAVE_SCHEMA_VERSION;
  nextStep: number;
  demoState: DemoState;
}>;

export type SimRuntimeOptions = Readonly<{
  stepSizeMs?: number;
  maxStepsPerFrame?: number;
  initialStep?: number;
  initialState?: Partial<DemoState>;
}>;

export type SimTickResult = Readonly<{
  frames: readonly RenderCommandBuffer[];
  nextStep: number;
}>;

export type SimRuntime = Readonly<{
  tick: (deltaMs: number) => SimTickResult;
  enqueueCommands: (commands: readonly Command[]) => void;
  getStepSizeMs: () => number;
  getNextStep: () => number;
  hasCommandHandler: (type: string) => boolean;
  serialize?: () => SerializedSimRuntimeState;
  getCapabilities?: () => SimRuntimeCapabilities;
}>;

type CollectResourcePayload =
  RuntimeCommandPayloads[typeof RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE];
type OfflineCatchupPayload =
  RuntimeCommandPayloads[typeof RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP];

type ShellControlEventCommandPayload = Readonly<{
  event: ShellControlEvent;
}>;

/**
 * Demo UI hit-test region (matches buildFrame panel rect).
 */
const DEMO_UI_PANEL = {
  x: 16,
  y: 16,
  width: 320,
  height: 72,
} as const;

const SAMPLE_FONT_ASSET_ID = 'sample-pack.ui-font' as AssetId;
const SIM_RUNTIME_CONTENT_HASH = 'content:dev';
const SIM_RUNTIME_CONTENT_VERSION = 'dev';
const SIM_RUNTIME_SAVE_FILE_STEM = 'content-dev';

const clampByte = (value: number): number => Math.min(255, Math.max(0, Math.floor(value)));

const rgba = (red: number, green: number, blue: number, alpha = 255): number =>
  (((clampByte(red) << 24) | (clampByte(green) << 16) | (clampByte(blue) << 8) | clampByte(alpha)) >>>
    0);

const normalizeCommand = (
  candidate: unknown,
  options: { readonly nextStep: number; readonly stepSizeMs: number },
): Command | null => {
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return null;
  }

  const command = candidate as Partial<Command>;
  if (typeof command.type !== 'string' || command.type.trim().length === 0) {
    return null;
  }
  if (typeof command.priority !== 'number' || !Number.isFinite(command.priority)) {
    return null;
  }
  if (typeof command.step !== 'number' || !Number.isFinite(command.step)) {
    return null;
  }
  if (typeof command.timestamp !== 'number' || !Number.isFinite(command.timestamp)) {
    return null;
  }

  const normalizedStep = Math.max(options.nextStep, Math.floor(command.step));
  const normalizedTimestamp =
    normalizedStep === Math.floor(command.step)
      ? command.timestamp
      : normalizedStep * options.stepSizeMs;

  return {
    type: command.type,
    priority: command.priority,
    payload: (command as { payload?: unknown }).payload,
    timestamp: normalizedTimestamp,
    step: normalizedStep,
    requestId: command.requestId,
  };
};

function normalizeDemoState(initialState?: Partial<DemoState>): DemoState {
  const tickCount = initialState?.tickCount;
  const resourceCount = initialState?.resourceCount;
  const lastCollectedStep = initialState?.lastCollectedStep;

  return {
    tickCount:
      typeof tickCount === 'number' && Number.isFinite(tickCount) && tickCount >= 0
        ? Math.floor(tickCount)
        : 0,
    resourceCount:
      typeof resourceCount === 'number' && Number.isFinite(resourceCount) && resourceCount >= 0
        ? resourceCount
        : 0,
    lastCollectedStep:
      typeof lastCollectedStep === 'number' && Number.isFinite(lastCollectedStep)
        ? Math.floor(lastCollectedStep)
        : null,
  };
}

function parseSerializedDemoState(value: unknown): DemoState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid sim runtime save: expected demoState object.');
  }

  const record = value as Record<string, unknown>;
  const tickCount = record['tickCount'];
  if (typeof tickCount !== 'number' || !Number.isFinite(tickCount) || tickCount < 0) {
    throw new TypeError('Invalid sim runtime save: expected demoState.tickCount non-negative number.');
  }

  const resourceCount = record['resourceCount'];
  if (typeof resourceCount !== 'number' || !Number.isFinite(resourceCount) || resourceCount < 0) {
    throw new TypeError(
      'Invalid sim runtime save: expected demoState.resourceCount non-negative number.',
    );
  }

  const lastCollectedStep = record['lastCollectedStep'];
  if (
    lastCollectedStep !== null &&
    (typeof lastCollectedStep !== 'number' || !Number.isFinite(lastCollectedStep) || lastCollectedStep < 0)
  ) {
    throw new TypeError(
      'Invalid sim runtime save: expected demoState.lastCollectedStep non-negative number or null.',
    );
  }

  return {
    tickCount: Math.floor(tickCount),
    resourceCount,
    lastCollectedStep: lastCollectedStep === null ? null : Math.floor(lastCollectedStep),
  };
}

function sumFiniteObjectValues(value: unknown): number {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 0;
  }

  return Object.values(value).reduce((total, entry) => {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) {
      return total;
    }

    return total + entry;
  }, 0);
}

function resolveOfflineCatchupStepCount(
  payload: OfflineCatchupPayload,
  stepSizeMs: number,
): number {
  if (stepSizeMs <= 0) {
    return 0;
  }

  let elapsedMs = payload.elapsedMs;
  if (typeof payload.maxElapsedMs === 'number' && Number.isFinite(payload.maxElapsedMs) && payload.maxElapsedMs >= 0) {
    elapsedMs = Math.min(elapsedMs, payload.maxElapsedMs);
  }

  let totalSteps = Math.max(0, Math.floor(elapsedMs / stepSizeMs));
  if (typeof payload.maxSteps === 'number' && Number.isFinite(payload.maxSteps) && payload.maxSteps >= 0) {
    totalSteps = Math.min(totalSteps, Math.floor(payload.maxSteps));
  }

  return totalSteps;
}

export function loadSerializedSimRuntimeState(value: unknown): SerializedSimRuntimeState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Invalid sim runtime save: expected an object.');
  }

  const record = value as Record<string, unknown>;
  if (record['schemaVersion'] !== SIM_RUNTIME_SAVE_SCHEMA_VERSION) {
    throw new TypeError(`Invalid sim runtime save schema version: ${record['schemaVersion']}`);
  }

  const nextStep = record['nextStep'];
  if (typeof nextStep !== 'number' || !Number.isFinite(nextStep) || nextStep < 0) {
    throw new TypeError('Invalid sim runtime save: expected { nextStep: non-negative number }.');
  }

  const demoState = parseSerializedDemoState(record['demoState']);

  return {
    schemaVersion: SIM_RUNTIME_SAVE_SCHEMA_VERSION,
    nextStep: Math.floor(nextStep),
    demoState,
  };
}

export function createSimRuntime(options: SimRuntimeOptions = {}): SimRuntime {
  const state = normalizeDemoState(options.initialState);

  const runtime = new IdleEngineRuntime({
    stepSizeMs: options.stepSizeMs,
    maxStepsPerFrame: options.maxStepsPerFrame,
    ...(options.initialStep === undefined ? {} : { initialStep: options.initialStep }),
  });

  const frameQueue: RenderCommandBuffer[] = [];

  const buildFrame = (step: number): RenderCommandBuffer => {
    const stepSizeMs = runtime.getStepSizeMs();
    const simTimeMs = step * stepSizeMs;
    const wave = state.tickCount % 120;
    const clearColor = rgba(0x18, 0x2a + wave, 0x44, 0xff);

    const panelX = 16;
    const panelY = 16;
    const panelWidth = 320;
    const panelHeight = 72;

    const meterX = panelX + 16;
    const meterY = panelY + 40;
    const meterWidth = panelWidth - 32;
    const meterHeight = 16;

    const clampedUnits = Math.max(0, Math.min(20, Math.floor(state.resourceCount)));
    const fillWidth = Math.floor((meterWidth * clampedUnits) / 20);

    return {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step,
        simTimeMs,
        contentHash: 'content:dev',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'world' }, { id: 'ui' }],
      draws: [
        {
          kind: 'clear',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: clearColor,
        },
        {
          kind: 'rect',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          x: panelX,
          y: panelY,
          width: panelWidth,
          height: panelHeight,
          colorRgba: 0x00_00_00_b3,
        },
        {
          kind: 'rect',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
          x: meterX,
          y: meterY,
          width: meterWidth,
          height: meterHeight,
          colorRgba: 0x18_2a_44_ff,
        },
        {
          kind: 'rect',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
          x: meterX,
          y: meterY,
          width: fillWidth,
          height: meterHeight,
          colorRgba: state.lastCollectedStep === step ? 0x8a_2a_4f_ff : 0x2a_4f_8a_ff,
        },
        {
          kind: 'text',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 3 },
          x: panelX + 16,
          y: panelY + 16,
          text: `Resources: ${state.resourceCount}`,
          colorRgba: 0xff_ff_ff_ff,
          fontAssetId: SAMPLE_FONT_ASSET_ID,
          fontSizePx: 18,
        },
      ],
    };
  };

  const dispatcher = runtime.getCommandDispatcher();
  dispatcher.register(RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE, (payload: CollectResourcePayload, context) => {
    if (payload.resourceId !== 'demo') {
      return;
    }
    state.resourceCount += payload.amount;
    state.lastCollectedStep = context.step;
  });

  dispatcher.register(SHELL_CONTROL_EVENT_COMMAND_TYPE, (_payload: ShellControlEventCommandPayload) => undefined);

  dispatcher.register(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP, (payload: OfflineCatchupPayload, context) => {
    if (typeof payload?.elapsedMs !== 'number' || !Number.isFinite(payload.elapsedMs) || payload.elapsedMs <= 0) {
      return;
    }

    const offlineSteps = resolveOfflineCatchupStepCount(payload, runtime.getStepSizeMs());
    const resourceDelta = offlineSteps + sumFiniteObjectValues(payload.resourceDeltas);

    state.tickCount += offlineSteps;
    state.resourceCount += resourceDelta;
    state.lastCollectedStep = context.step;
  });

  dispatcher.register(RUNTIME_COMMAND_TYPES.INPUT_EVENT, (payload: InputEventCommandPayload, context) => {
    // Fail-fast on unknown schema version (sim worker crashes)
    if (payload.schemaVersion !== 1) {
      throw new Error(`Unsupported InputEventCommandPayload schemaVersion: ${payload.schemaVersion}`);
    }

    const { event } = payload;

    // Only handle pointer mouse-down events for demo UI hit-testing
    if (event.kind !== 'pointer' || event.intent !== 'mouse-down') {
      return;
    }

    // Hit-test against the demo UI panel
    const { x, y } = event;
    const inBounds =
      x >= DEMO_UI_PANEL.x &&
      x < DEMO_UI_PANEL.x + DEMO_UI_PANEL.width &&
      y >= DEMO_UI_PANEL.y &&
      y < DEMO_UI_PANEL.y + DEMO_UI_PANEL.height;

    if (!inBounds) {
      return;
    }

    // In-bounds click: trigger the same effect as COLLECT_RESOURCE
    state.resourceCount += 1;
    state.lastCollectedStep = context.step;
  });

  const hasCommandHandler = (type: string): boolean => dispatcher.getHandler(type) !== undefined;
  const getCapabilities = (): SimRuntimeCapabilities => ({
    ...DEFAULT_SIM_RUNTIME_CAPABILITIES,
    canSerialize: true,
    canHydrate: true,
    supportsOfflineCatchup: hasCommandHandler(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP),
    saveFileStem: SIM_RUNTIME_SAVE_FILE_STEM,
    saveSchemaVersion: SIM_RUNTIME_SAVE_SCHEMA_VERSION,
    contentHash: SIM_RUNTIME_CONTENT_HASH,
    contentVersion: SIM_RUNTIME_CONTENT_VERSION,
  });
  const serialize = (): SerializedSimRuntimeState => ({
    schemaVersion: SIM_RUNTIME_SAVE_SCHEMA_VERSION,
    nextStep: runtime.getNextExecutableStep(),
    demoState: {
      tickCount: state.tickCount,
      resourceCount: state.resourceCount,
      lastCollectedStep: state.lastCollectedStep,
    },
  });

  runtime.addSystem({
    id: 'demo-state',
    tick: () => {
      state.tickCount += 1;
    },
  });

  runtime.addSystem({
    id: 'frame-producer',
    tick: (context) => {
      frameQueue.push(buildFrame(context.step));
    },
  });

  const tick = (deltaMs: number): SimTickResult => {
    frameQueue.length = 0;
    runtime.tick(deltaMs);

    // Check for fatal command execution failures and rethrow them.
    // This ensures schemaVersion mismatches in INPUT_EVENT handlers crash the worker.
    const failures = runtime.drainCommandFailures();
    for (const failure of failures) {
      if (
        failure.error.code === 'COMMAND_EXECUTION_FAILED' &&
        failure.type === RUNTIME_COMMAND_TYPES.INPUT_EVENT
      ) {
        const originalError =
          (failure.error.details as { error?: string } | undefined)?.error ??
          failure.error.message;
        throw new Error(originalError);
      }
    }

    return {
      frames: Array.from(frameQueue),
      nextStep: runtime.getNextExecutableStep(),
    };
  };

  const enqueueCommands = (commands: readonly Command[]): void => {
    const nextStep = runtime.getNextExecutableStep();
    const stepSizeMs = runtime.getStepSizeMs();
    const queue = runtime.getCommandQueue();

    for (const command of commands) {
      const normalized = normalizeCommand(command, { nextStep, stepSizeMs });
      if (!normalized) {
        continue;
      }
      queue.enqueue(normalized);
    }
  };

  return {
    tick,
    enqueueCommands,
    getStepSizeMs: () => runtime.getStepSizeMs(),
    getNextStep: () => runtime.getNextExecutableStep(),
    hasCommandHandler,
    serialize,
    getCapabilities,
  };
}
