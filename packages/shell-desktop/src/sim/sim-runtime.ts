import {
  IdleEngineRuntime,
  RUNTIME_COMMAND_TYPES,
  type Command,
  type InputEventCommandPayload,
  type RuntimeCommandPayloads,
} from '@idle-engine/core';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import { SHELL_CONTROL_EVENT_COMMAND_TYPE, type ShellControlEvent } from '../ipc.js';
import type { AssetId, RenderCommandBuffer } from '@idle-engine/renderer-contract';

export type SimRuntimeOptions = Readonly<{
  stepSizeMs?: number;
  maxStepsPerFrame?: number;
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
}>;

export const DEMO_SET_STRESS_PROFILE_COMMAND_TYPE = 'DEMO_SET_STRESS_PROFILE' as const;

export const DEMO_STRESS_PROFILES = [
  'baseline',
  'draw-burst',
  'clip-stack',
  'text-wall',
  'mixed',
] as const;

export type DemoStressProfile = (typeof DEMO_STRESS_PROFILES)[number];

type CollectResourcePayload =
  RuntimeCommandPayloads[typeof RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE];

type ShellControlEventCommandPayload = Readonly<{
  event: ShellControlEvent;
}>;

type DemoSetStressProfilePayload = Readonly<{
  profile: DemoStressProfile;
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

type DemoState = {
  tickCount: number;
  resourceCount: number;
  lastCollectedStep: number | null;
  stressProfile: DemoStressProfile;
};

const SAMPLE_FONT_ASSET_ID = 'sample-pack.ui-font' as AssetId;
const EXTENDED_GLYPH_SAMPLE = 'Glyph probe: AA11 ?? ++ -- <> {} //';
const FALLBACK_GLYPH_SAMPLE = 'Fallback probe: ??? ???';
const CLIP_LABEL = 'Clip stack demo';
const DRAW_BURST_MAX_CELLS = 160;
const TEXT_WALL_ROWS = 18;
const TEXT_WALL_COLUMNS = 4;

type RenderDraw = RenderCommandBuffer['draws'][number];

const clampByte = (value: number): number => Math.min(255, Math.max(0, Math.floor(value)));

const rgba = (red: number, green: number, blue: number, alpha = 255): number =>
  (((clampByte(red) << 24) | (clampByte(green) << 16) | (clampByte(blue) << 8) | clampByte(alpha)) >>>
    0);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isDemoStressProfile = (value: unknown): value is DemoStressProfile =>
  typeof value === 'string' && (DEMO_STRESS_PROFILES as readonly string[]).includes(value);

const isDemoSetStressProfilePayload = (value: unknown): value is DemoSetStressProfilePayload => {
  if (!isRecord(value)) {
    return false;
  }

  return isDemoStressProfile(value['profile']);
};

const appendDrawBurst = (
  draws: RenderDraw[],
  sortKeyStart: number,
  tickCount: number,
  intensity: number,
): number => {
  const rows = 8;
  const columns = 20;
  const visibleCells = Math.max(20, Math.min(DRAW_BURST_MAX_CELLS, Math.floor(intensity)));
  let sortKey = sortKeyStart;

  for (let index = 0; index < visibleCells; index += 1) {
    const row = Math.floor(index / columns) % rows;
    const column = index % columns;
    const x = 20 + column * 34;
    const y = 120 + row * 20;
    const pulse = (tickCount + index) % 30;
    const pulseUnit = pulse / 29;

    draws.push({
      kind: 'rect',
      passId: 'world',
      sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
      x,
      y,
      width: 28 + (pulse % 3),
      height: 14,
      colorRgba: rgba(
        0x1a + Math.floor(60 * pulseUnit),
        0x36 + Math.floor(80 * (1 - pulseUnit)),
        0x5c + (column % 4) * 18,
      ),
    });
    sortKey += 1;
  }

  draws.push({
    kind: 'text',
    passId: 'ui',
    sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
    x: 20,
    y: 290,
    text: `Draw burst cells=${visibleCells}`,
    colorRgba: 0xff_ff_ff_ff,
    fontAssetId: SAMPLE_FONT_ASSET_ID,
    fontSizePx: 14,
  });

  return sortKey + 1;
};

const appendClipStress = (
  draws: RenderDraw[],
  sortKeyStart: number,
  tickCount: number,
): number => {
  let sortKey = sortKeyStart;
  const clipX = 420;
  const clipY = 30;
  const clipWidth = 280;
  const clipHeight = 180;

  draws.push({
    kind: 'rect',
    passId: 'ui',
    sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
    x: clipX - 2,
    y: clipY - 2,
    width: clipWidth + 4,
    height: clipHeight + 4,
    colorRgba: 0xff_ff_ff_26,
  });
  sortKey += 1;

  draws.push({
    kind: 'scissorPush',
    passId: 'ui',
    sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
    x: clipX,
    y: clipY,
    width: clipWidth,
    height: clipHeight,
  });
  sortKey += 1;

  for (let index = 0; index < 28; index += 1) {
    const wave = (tickCount + index * 2) % 50;
    draws.push({
      kind: 'rect',
      passId: 'ui',
      sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
      x: clipX - 80 + index * 15,
      y: clipY + 16 + ((index % 5) * 26 + wave) % 120,
      width: 96,
      height: 18,
      colorRgba: rgba(0x4a, 0x30 + (index % 6) * 18, 0x92, 0xd0),
    });
    sortKey += 1;
  }

  draws.push({
    kind: 'scissorPush',
    passId: 'ui',
    sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
    x: clipX + 42,
    y: clipY + 34,
    width: clipWidth - 84,
    height: clipHeight - 68,
  });
  sortKey += 1;

  draws.push({
    kind: 'rect',
    passId: 'ui',
    sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
    x: clipX + 24,
    y: clipY + 20 + (tickCount % 42),
    width: clipWidth - 16,
    height: 42,
    colorRgba: 0x2a_90_b4_cc,
  });
  sortKey += 1;

  draws.push({
    kind: 'text',
    passId: 'ui',
    sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
    x: clipX + 54,
    y: clipY + 52,
    text: CLIP_LABEL,
    colorRgba: 0xff_ff_ff_ff,
    fontAssetId: SAMPLE_FONT_ASSET_ID,
    fontSizePx: 14,
  });
  sortKey += 1;

  draws.push({
    kind: 'scissorPop',
    passId: 'ui',
    sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
  });
  sortKey += 1;

  draws.push({
    kind: 'scissorPop',
    passId: 'ui',
    sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
  });

  return sortKey + 1;
};

const appendTextWall = (
  draws: RenderDraw[],
  sortKeyStart: number,
  tickCount: number,
): number => {
  let sortKey = sortKeyStart;
  const wallOriginX = 20;
  const wallOriginY = 330;

  draws.push({
    kind: 'text',
    passId: 'ui',
    sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
    x: wallOriginX,
    y: wallOriginY,
    text: EXTENDED_GLYPH_SAMPLE,
    colorRgba: 0xff_ff_ff_ff,
    fontAssetId: SAMPLE_FONT_ASSET_ID,
    fontSizePx: 13,
  });
  sortKey += 1;

  draws.push({
    kind: 'text',
    passId: 'ui',
    sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
    x: wallOriginX,
    y: wallOriginY + 16,
    text: FALLBACK_GLYPH_SAMPLE,
    colorRgba: 0xdc_dc_dc_ff,
    fontAssetId: SAMPLE_FONT_ASSET_ID,
    fontSizePx: 13,
  });
  sortKey += 1;

  for (let row = 0; row < TEXT_WALL_ROWS; row += 1) {
    const rowShift = (tickCount + row) % 9;
    for (let column = 0; column < TEXT_WALL_COLUMNS; column += 1) {
      draws.push({
        kind: 'text',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: sortKey },
        x: wallOriginX + column * 180,
        y: wallOriginY + 38 + row * 14,
        text: `S${row.toString().padStart(2, '0')}-${column} :: ${'='.repeat(rowShift + column + 1)}`,
        colorRgba: rgba(0xd4 - row * 4, 0xee - column * 16, 0xff - rowShift * 6),
        fontAssetId: SAMPLE_FONT_ASSET_ID,
        fontSizePx: 12,
      });
      sortKey += 1;
    }
  }

  return sortKey;
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

export function createSimRuntime(options: SimRuntimeOptions = {}): SimRuntime {
  const state: DemoState = {
    tickCount: 0,
    resourceCount: 0,
    lastCollectedStep: null,
    stressProfile: 'baseline',
  };

  const runtime = new IdleEngineRuntime({
    stepSizeMs: options.stepSizeMs,
    maxStepsPerFrame: options.maxStepsPerFrame,
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

    const draws: RenderDraw[] = [
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
      {
        kind: 'text',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 4 },
        x: panelX + 16,
        y: panelY + 58,
        text: `Profile: ${state.stressProfile}`,
        colorRgba: 0xd0_d8_e2_ff,
        fontAssetId: SAMPLE_FONT_ASSET_ID,
        fontSizePx: 12,
      },
    ];

    let nextSortKey = 10;
    const profile = state.stressProfile;

    if (profile === 'draw-burst') {
      const pulse = 40 + (state.tickCount % 90);
      nextSortKey = appendDrawBurst(draws, nextSortKey, state.tickCount, pulse);
    } else if (profile === 'clip-stack') {
      nextSortKey = appendClipStress(draws, nextSortKey, state.tickCount);
    } else if (profile === 'text-wall') {
      nextSortKey = appendTextWall(draws, nextSortKey, state.tickCount);
    } else if (profile === 'mixed') {
      const pulse = 32 + (state.tickCount % 72);
      nextSortKey = appendDrawBurst(draws, nextSortKey, state.tickCount, pulse);
      nextSortKey = appendClipStress(draws, nextSortKey, state.tickCount);
      nextSortKey = appendTextWall(draws, nextSortKey, state.tickCount);
    }

    draws.push({
      kind: 'text',
      passId: 'ui',
      sortKey: { sortKeyHi: 0, sortKeyLo: nextSortKey },
      x: 20,
      y: 620,
      text: `tick=${state.tickCount} step=${step}`,
      colorRgba: 0xaa_ba_cc_ff,
      fontAssetId: SAMPLE_FONT_ASSET_ID,
      fontSizePx: 12,
    });

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
      draws,
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

  dispatcher.register(DEMO_SET_STRESS_PROFILE_COMMAND_TYPE, (payload: unknown) => {
    if (!isDemoSetStressProfilePayload(payload)) {
      return;
    }

    state.stressProfile = payload.profile;
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
  };
}
