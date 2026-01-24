import { IdleEngineRuntime, RUNTIME_COMMAND_TYPES } from '@idle-engine/core';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import { SHELL_CONTROL_EVENT_COMMAND_TYPE, type ShellControlEvent } from '../ipc.js';
import type { Command, RuntimeCommandPayloads } from '@idle-engine/core';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

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

type CollectResourcePayload =
  RuntimeCommandPayloads[typeof RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE];

type ShellControlEventCommandPayload = Readonly<{
  event: ShellControlEvent;
}>;

type DemoState = {
  tickCount: number;
  resourceCount: number;
  lastCollectedStep: number | null;
};

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

export function createSimRuntime(options: SimRuntimeOptions = {}): SimRuntime {
  const state: DemoState = {
    tickCount: 0,
    resourceCount: 0,
    lastCollectedStep: null,
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
