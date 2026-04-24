import {
  createGame,
  RUNTIME_COMMAND_TYPES,
  type Command,
  type Game,
  type GameSnapshot,
  type InputEventCommandPayload,
  type RuntimeCommandPayloads,
  type SerializedGameState,
} from '@idle-engine/core';
import {
  sampleContent,
  sampleContentArtifactHash,
  sampleContentSummary,
} from '@idle-engine/content-sample';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import { SHELL_CONTROL_EVENT_COMMAND_TYPE, type ShellControlEvent } from '../ipc.js';
import {
  DEFAULT_SIM_RUNTIME_CAPABILITIES,
  type SimRuntimeCapabilities,
} from './worker-protocol.js';
import type {
  AssetId,
  RenderCommandBuffer,
  RenderDraw,
  RenderPassId,
  SortKey,
} from '@idle-engine/renderer-contract';

export const SIM_RUNTIME_SAVE_SCHEMA_VERSION = 1;

export type SerializedSimRuntimeState = Readonly<{
  schemaVersion: typeof SIM_RUNTIME_SAVE_SCHEMA_VERSION;
  nextStep: number;
  gameState: SerializedGameState;
  accumulatorBacklogMs: number;
}>;

export type SimRuntimeOptions = Readonly<{
  stepSizeMs?: number;
  maxStepsPerFrame?: number;
  initialStep?: number;
  initialSerializedState?: SerializedSimRuntimeState;
  initialAccumulatorBacklogMs?: number;
}>;

export type SimTickResult = Readonly<{
  frames: readonly RenderCommandBuffer[];
  frame?: RenderCommandBuffer;
  droppedFrames: number;
  nextStep: number;
}>;

export type SimRuntime = Readonly<{
  tick: (deltaMs: number) => SimTickResult;
  enqueueCommands: (commands: readonly Command[]) => void;
  renderCurrentFrame?: () => RenderCommandBuffer | undefined;
  getStepSizeMs: () => number;
  getNextStep: () => number;
  hasCommandHandler: (type: string) => boolean;
  serialize?: () => SerializedSimRuntimeState;
  getCapabilities?: () => SimRuntimeCapabilities;
}>;

type OfflineCatchupPayload =
  RuntimeCommandPayloads[typeof RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP];

type ShellControlEventCommandPayload = Readonly<{
  event: ShellControlEvent;
}>;

const SAMPLE_ENERGY_RESOURCE_ID = 'sample-pack.energy';
const SAMPLE_COLLECT_AMOUNT = 1;
const SAMPLE_FONT_ASSET_ID = 'sample-pack.ui-font' as AssetId;
const SIM_RUNTIME_SAVE_FILE_STEM = 'sample-pack';
const MAX_RETAINED_TICK_FRAMES = 128;
// Some packaged runtime builds ignore zero-delta ticks before checking credited backlog.
const CREDITED_BACKLOG_DRAIN_DELTA_MS = Number.MIN_VALUE;

const SAMPLE_UI_PANEL = {
  x: 16,
  y: 16,
  width: 440,
  height: 236,
} as const;

const clampByte = (value: number): number => Math.min(255, Math.max(0, Math.floor(value)));

const rgba = (red: number, green: number, blue: number, alpha = 255): number =>
  (((clampByte(red) << 24) | (clampByte(green) << 16) | (clampByte(blue) << 8) | clampByte(alpha)) >>>
    0);

const formatNumber = (value: number): string => {
  if (!Number.isFinite(value)) {
    return '0';
  }

  if (Math.abs(value) >= 1000 || Number.isInteger(value)) {
    return String(Math.round(value));
  }

  const fixed = value.toFixed(2);
  if (fixed.endsWith('.00')) {
    return fixed.slice(0, -3);
  }
  if (fixed.endsWith('0')) {
    return fixed.slice(0, -1);
  }
  return fixed;
};

const formatSignedRate = (value: number): string => {
  if (value === 0) {
    return '+0/s';
  }
  return `${value > 0 ? '+' : ''}${formatNumber(value)}/s`;
};

const createSortKey = (sortKeyLo: number): SortKey => ({
  sortKeyHi: 0,
  sortKeyLo,
});

const pushRect = (
  draws: RenderDraw[],
  options: {
    readonly passId?: RenderPassId;
    readonly sortKeyLo: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly colorRgba: number;
  },
): void => {
  draws.push({
    kind: 'rect',
    passId: options.passId ?? 'ui',
    sortKey: createSortKey(options.sortKeyLo),
    x: options.x,
    y: options.y,
    width: options.width,
    height: options.height,
    colorRgba: options.colorRgba,
  });
};

const pushText = (
  draws: RenderDraw[],
  options: {
    readonly sortKeyLo: number;
    readonly x: number;
    readonly y: number;
    readonly text: string;
    readonly fontSizePx?: number;
    readonly colorRgba?: number;
  },
): void => {
  draws.push({
    kind: 'text',
    passId: 'ui',
    sortKey: createSortKey(options.sortKeyLo),
    x: options.x,
    y: options.y,
    text: options.text,
    colorRgba: options.colorRgba ?? 0xff_ff_ff_ff,
    fontAssetId: SAMPLE_FONT_ASSET_ID,
    fontSizePx: options.fontSizePx ?? 15,
  });
};

const buildResourceLabel = (
  resource: GameSnapshot['resources'][number],
): string => {
  const capacity =
    resource.capacity === undefined ? '' : ` / ${formatNumber(resource.capacity)}`;
  return `${resource.displayName}: ${formatNumber(resource.amount)}${capacity} ${formatSignedRate(resource.perSecond)}`;
};

const buildGeneratorLabel = (
  generator: GameSnapshot['generators'][number],
  resourceNames: ReadonlyMap<string, string>,
): string => {
  const firstCost = generator.costs[0];
  const cost =
    firstCost === undefined
      ? 'no cost'
      : `${formatNumber(firstCost.amount)} ${resourceNames.get(firstCost.resourceId) ?? firstCost.resourceId}`;
  const readiness = generator.canAfford ? 'ready' : 'needs';
  const enabled = generator.enabled ? 'on' : 'off';
  return `${generator.displayName}: owned ${generator.owned} (${enabled}) | ${readiness} ${cost}`;
};

const buildSamplePackFrame = (
  game: Game,
  step: number,
  snapshot: GameSnapshot,
): RenderCommandBuffer => {
  const stepSizeMs = game.internals.runtime.getStepSizeMs();
  const simTimeMs = step * stepSizeMs;
  const wave = step % 120;
  const clearColor = rgba(0x16, 0x24 + Math.floor(wave / 4), 0x31, 0xff);
  const draws: RenderDraw[] = [
    {
      kind: 'clear',
      passId: 'world',
      sortKey: createSortKey(0),
      colorRgba: clearColor,
    },
  ];

  let sortKeyLo = 1;
  pushRect(draws, {
    sortKeyLo: sortKeyLo++,
    ...SAMPLE_UI_PANEL,
    colorRgba: 0x09_12_18_dd,
  });

  pushText(draws, {
    sortKeyLo: sortKeyLo++,
    x: SAMPLE_UI_PANEL.x + 16,
    y: SAMPLE_UI_PANEL.y + 14,
    text: 'Sample Content Pack',
    fontSizePx: 18,
  });

  pushText(draws, {
    sortKeyLo: sortKeyLo++,
    x: SAMPLE_UI_PANEL.x + 16,
    y: SAMPLE_UI_PANEL.y + 42,
    text: `Step ${step} | ${formatNumber(simTimeMs)} ms`,
    fontSizePx: 13,
    colorRgba: 0xb8_c7_d4_ff,
  });

  const visibleResources = snapshot.resources
    .filter((resource) => resource.visible)
    .slice(0, 4);
  const resourceNames = new Map(
    snapshot.resources.map((resource) => [resource.id, resource.displayName]),
  );
  const meterX = SAMPLE_UI_PANEL.x + 16;
  const meterWidth = SAMPLE_UI_PANEL.width - 32;
  let rowY = SAMPLE_UI_PANEL.y + 72;

  for (const resource of visibleResources) {
    const meterScale = resource.capacity ?? Math.max(100, Math.ceil(resource.amount));
    const fillRatio =
      meterScale <= 0
        ? 0
        : Math.max(0, Math.min(1, resource.amount / meterScale));
    const fillWidth = Math.floor(meterWidth * fillRatio);

    pushText(draws, {
      sortKeyLo: sortKeyLo++,
      x: meterX,
      y: rowY,
      text: buildResourceLabel(resource),
      fontSizePx: 14,
      colorRgba: resource.unlocked ? 0xff_ff_ff_ff : 0x91_a0_ab_ff,
    });
    pushRect(draws, {
      sortKeyLo: sortKeyLo++,
      x: meterX,
      y: rowY + 22,
      width: meterWidth,
      height: 10,
      colorRgba: 0x1e_2b_34_ff,
    });
    pushRect(draws, {
      sortKeyLo: sortKeyLo++,
      x: meterX,
      y: rowY + 22,
      width: fillWidth,
      height: 10,
      colorRgba: resource.unlocked ? 0x2f_8f_83_ff : 0x4d_58_63_ff,
    });
    rowY += 42;
  }

  const firstGenerator = snapshot.generators.find((generator) => generator.visible);
  if (firstGenerator) {
    pushText(draws, {
      sortKeyLo: sortKeyLo++,
      x: meterX,
      y: SAMPLE_UI_PANEL.y + SAMPLE_UI_PANEL.height - 56,
      text: buildGeneratorLabel(firstGenerator, resourceNames),
      fontSizePx: 13,
      colorRgba: firstGenerator.canAfford ? 0x93_e6_ab_ff : 0xd3_d9_de_ff,
    });
  }

  pushText(draws, {
    sortKeyLo: sortKeyLo++,
    x: meterX,
    y: SAMPLE_UI_PANEL.y + SAMPLE_UI_PANEL.height - 28,
    text: 'Click panel or press Space: +1 Energy',
    fontSizePx: 13,
    colorRgba: 0xb8_c7_d4_ff,
  });

  return {
    frame: {
      schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
      step,
      simTimeMs,
      contentHash: sampleContentArtifactHash,
    },
    scene: {
      camera: { x: 0, y: 0, zoom: 1 },
    },
    passes: [{ id: 'world' }, { id: 'ui' }],
    draws,
  };
};

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

function normalizeAccumulatorBacklogMs(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseSerializedAccumulatorBacklogMs(value: unknown): number {
  if (value === undefined) {
    return 0;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(
      'Invalid sim runtime save: expected accumulatorBacklogMs non-negative number.',
    );
  }

  return value;
}

function assertRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(message);
  }

  return value as Record<string, unknown>;
}

function readSavedGameRuntimeStep(gameState: SerializedGameState): number {
  const runtime = assertRecord(
    (gameState as Record<string, unknown>)['runtime'],
    'Invalid sim runtime save: expected gameState.runtime object.',
  );
  const step = runtime['step'];
  if (typeof step !== 'number' || !Number.isFinite(step) || step < 0) {
    throw new TypeError('Invalid sim runtime save: expected gameState.runtime.step non-negative number.');
  }

  return Math.floor(step);
}

function resolveOfflineCatchupStepCount(
  payload: OfflineCatchupPayload,
  stepSizeMs: number,
): number {
  if (stepSizeMs <= 0) {
    return 0;
  }

  let elapsedMs = payload.elapsedMs;
  if (
    typeof payload.maxElapsedMs === 'number' &&
    Number.isFinite(payload.maxElapsedMs) &&
    payload.maxElapsedMs >= 0
  ) {
    elapsedMs = Math.min(elapsedMs, payload.maxElapsedMs);
  }

  let totalSteps = Math.max(0, Math.floor(elapsedMs / stepSizeMs));
  if (
    typeof payload.maxSteps === 'number' &&
    Number.isFinite(payload.maxSteps) &&
    payload.maxSteps >= 0
  ) {
    totalSteps = Math.min(totalSteps, Math.floor(payload.maxSteps));
  }

  return totalSteps;
}

function resolveOfflineCatchupTotalMs(
  payload: OfflineCatchupPayload,
  stepSizeMs: number,
): number {
  if (stepSizeMs <= 0) {
    return 0;
  }

  const totalSteps = resolveOfflineCatchupStepCount(payload, stepSizeMs);
  if (totalSteps <= 0) {
    return 0;
  }

  let elapsedMs = payload.elapsedMs;
  if (
    typeof payload.maxElapsedMs === 'number' &&
    Number.isFinite(payload.maxElapsedMs) &&
    payload.maxElapsedMs >= 0
  ) {
    elapsedMs = Math.min(elapsedMs, payload.maxElapsedMs);
  }

  const fullSteps = Math.max(0, Math.floor(elapsedMs / stepSizeMs));
  const remainderMs =
    totalSteps === fullSteps ? elapsedMs - fullSteps * stepSizeMs : 0;

  return totalSteps * stepSizeMs + remainderMs;
}

function isBudgetableOfflineCatchupPayload(payload: unknown): payload is OfflineCatchupPayload {
  if (typeof payload !== 'object' || payload === null) {
    return false;
  }

  const resourceDeltas = (payload as { readonly resourceDeltas?: unknown }).resourceDeltas;
  if (
    resourceDeltas !== undefined &&
    (typeof resourceDeltas !== 'object' ||
      resourceDeltas === null ||
      Array.isArray(resourceDeltas))
  ) {
    return false;
  }

  const elapsedMs = (payload as { readonly elapsedMs?: unknown }).elapsedMs;
  return typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs > 0;
}

export function loadSerializedSimRuntimeState(value: unknown): SerializedSimRuntimeState {
  const record = assertRecord(value, 'Invalid sim runtime save: expected an object.');
  if (record['schemaVersion'] !== SIM_RUNTIME_SAVE_SCHEMA_VERSION) {
    throw new TypeError(`Invalid sim runtime save schema version: ${record['schemaVersion']}`);
  }

  const nextStep = record['nextStep'];
  if (typeof nextStep !== 'number' || !Number.isFinite(nextStep) || nextStep < 0) {
    throw new TypeError('Invalid sim runtime save: expected { nextStep: non-negative number }.');
  }

  const gameState = assertRecord(
    record['gameState'],
    'Invalid sim runtime save: expected gameState object.',
  ) as SerializedGameState;
  readSavedGameRuntimeStep(gameState);

  return {
    schemaVersion: SIM_RUNTIME_SAVE_SCHEMA_VERSION,
    nextStep: Math.floor(nextStep),
    gameState,
    accumulatorBacklogMs: parseSerializedAccumulatorBacklogMs(record['accumulatorBacklogMs']),
  };
}

export function createSimRuntime(options: SimRuntimeOptions = {}): SimRuntime {
  const initialSerializedState = options.initialSerializedState;
  const initialGameStep =
    initialSerializedState === undefined
      ? options.initialStep
      : readSavedGameRuntimeStep(initialSerializedState.gameState);
  const game = createGame(sampleContent, {
    stepSizeMs: options.stepSizeMs,
    maxStepsPerFrame: options.maxStepsPerFrame,
    ...(initialGameStep === undefined ? {} : { initialStep: initialGameStep }),
  });
  const { runtime, commandDispatcher: dispatcher } = game.internals;
  const frameQueue: RenderCommandBuffer[] = [];
  const initialAccumulatorBacklogMs =
    initialSerializedState?.accumulatorBacklogMs ?? options.initialAccumulatorBacklogMs;
  let accumulatorBacklogMs = normalizeAccumulatorBacklogMs(initialAccumulatorBacklogMs);
  let droppedFrames = 0;
  let lastFrame: RenderCommandBuffer | undefined;
  let offlineCatchupDrainBudgetMs = 0;

  const captureFrame = (frame: RenderCommandBuffer): void => {
    lastFrame = frame;
    if (frameQueue.length < MAX_RETAINED_TICK_FRAMES) {
      frameQueue.push(frame);
      return;
    }

    droppedFrames += 1;
  };

  dispatcher.register(
    SHELL_CONTROL_EVENT_COMMAND_TYPE,
    (_payload: ShellControlEventCommandPayload) => undefined,
  );

  const offlineCatchupHandler = dispatcher.getHandler(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP);
  if (offlineCatchupHandler) {
    dispatcher.register(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP, (payload: OfflineCatchupPayload, context) => {
      let totalOfflineMs = 0;
      const stepSizeMs = isBudgetableOfflineCatchupPayload(payload)
        ? runtime.getStepSizeMs()
        : 0;
      if (Number.isFinite(stepSizeMs) && stepSizeMs > 0) {
        totalOfflineMs = resolveOfflineCatchupTotalMs(payload, stepSizeMs);
      }

      const result = offlineCatchupHandler(payload, context);
      if (totalOfflineMs > 0) {
        offlineCatchupDrainBudgetMs += totalOfflineMs;
        accumulatorBacklogMs += Math.max(0, totalOfflineMs - stepSizeMs);
      }
      return result;
    });
  }

  dispatcher.register(RUNTIME_COMMAND_TYPES.INPUT_EVENT, (payload: InputEventCommandPayload) => {
    if (payload.schemaVersion !== 1) {
      throw new Error(`Unsupported InputEventCommandPayload schemaVersion: ${payload.schemaVersion}`);
    }

    const { event } = payload;

    if (event.kind !== 'pointer' || event.intent !== 'mouse-down') {
      return;
    }

    const { x, y } = event;
    const inBounds =
      x >= SAMPLE_UI_PANEL.x &&
      x < SAMPLE_UI_PANEL.x + SAMPLE_UI_PANEL.width &&
      y >= SAMPLE_UI_PANEL.y &&
      y < SAMPLE_UI_PANEL.y + SAMPLE_UI_PANEL.height;

    if (!inBounds) {
      return;
    }

    game.collectResource(SAMPLE_ENERGY_RESOURCE_ID, SAMPLE_COLLECT_AMOUNT);
  });

  const hasCommandHandler = (type: string): boolean => dispatcher.getHandler(type) !== undefined;

  if (initialSerializedState) {
    game.hydrate(initialSerializedState.gameState);
  }

  if (accumulatorBacklogMs > 0) {
    runtime.creditTime(accumulatorBacklogMs);
  }

  const getCapabilities = (): SimRuntimeCapabilities => ({
    ...DEFAULT_SIM_RUNTIME_CAPABILITIES,
    canSerialize: true,
    canHydrate: true,
    supportsOfflineCatchup: hasCommandHandler(RUNTIME_COMMAND_TYPES.OFFLINE_CATCHUP),
    saveFileStem: SIM_RUNTIME_SAVE_FILE_STEM,
    saveSchemaVersion: SIM_RUNTIME_SAVE_SCHEMA_VERSION,
    contentHash: sampleContentArtifactHash,
    contentVersion: sampleContentSummary.version,
  });
  const serialize = (): SerializedSimRuntimeState => ({
    schemaVersion: SIM_RUNTIME_SAVE_SCHEMA_VERSION,
    nextStep: runtime.getNextExecutableStep(),
    gameState: game.serialize(),
    accumulatorBacklogMs,
  });

  runtime.addSystem({
    id: 'sample-pack-frame-producer',
    tick: (context) => {
      captureFrame(buildSamplePackFrame(game, context.step, game.getSnapshot()));
    },
  });

  const rethrowFatalCommandFailures = (): void => {
    const failures = runtime.drainCommandFailures();
    runtime.drainCommandOutcomes();
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
  };

  const processTickBudget = (
    deltaMs: number,
    options: { readonly drainCreditedBacklog?: boolean } = {},
  ): number => {
    const nextStepBeforeTick = runtime.getNextExecutableStep();
    game.tick(
      options.drainCreditedBacklog && deltaMs === 0
        ? CREDITED_BACKLOG_DRAIN_DELTA_MS
        : deltaMs,
    );
    rethrowFatalCommandFailures();

    const processedSteps = Math.max(0, runtime.getNextExecutableStep() - nextStepBeforeTick);
    if (processedSteps > 0) {
      const processedMs = processedSteps * runtime.getStepSizeMs();
      accumulatorBacklogMs = Math.max(0, accumulatorBacklogMs - processedMs);
      offlineCatchupDrainBudgetMs = Math.max(0, offlineCatchupDrainBudgetMs - processedMs);
    }

    return processedSteps;
  };

  const tick = (deltaMs: number): SimTickResult => {
    frameQueue.length = 0;
    droppedFrames = 0;
    lastFrame = undefined;
    accumulatorBacklogMs += deltaMs > 0 ? deltaMs : 0;

    processTickBudget(deltaMs);

    while (offlineCatchupDrainBudgetMs >= runtime.getStepSizeMs()) {
      const processedSteps = processTickBudget(0, { drainCreditedBacklog: true });
      if (processedSteps <= 0) {
        break;
      }
    }

    return {
      frames: Array.from(frameQueue),
      frame: lastFrame,
      droppedFrames: droppedFrames + Math.max(0, frameQueue.length - 1),
      nextStep: runtime.getNextExecutableStep(),
    };
  };

  const enqueueCommands = (commands: readonly Command[]): void => {
    const nextStep = runtime.getNextExecutableStep();
    const stepSizeMs = runtime.getStepSizeMs();
    const queue = game.internals.commandQueue;

    for (const command of commands) {
      const normalized = normalizeCommand(command, { nextStep, stepSizeMs });
      if (!normalized) {
        continue;
      }
      queue.enqueue(normalized);
    }
  };

  const renderCurrentFrame = (): RenderCommandBuffer | undefined => {
    const nextStep = runtime.getNextExecutableStep();
    return buildSamplePackFrame(game, Math.max(0, nextStep - 1), game.getSnapshot());
  };

  return {
    tick,
    enqueueCommands,
    renderCurrentFrame,
    getStepSizeMs: () => runtime.getStepSizeMs(),
    getNextStep: () => runtime.getNextExecutableStep(),
    hasCommandHandler,
    serialize,
    getCapabilities,
  };
}
