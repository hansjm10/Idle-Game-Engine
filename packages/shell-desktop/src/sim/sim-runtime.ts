import {
  CommandPriority,
  IdleEngineRuntime,
  RUNTIME_COMMAND_TYPES,
} from '@idle-engine/core';
// eslint-disable-next-line no-restricted-imports -- shell-desktop drives an engine-level test harness that needs access to coordinator + save helpers.
import {
  buildProgressionSnapshot,
  createProgressionCoordinator,
  loadGameStateSaveFormat,
  wireGameRuntime,
  type GameStateSaveFormat,
  type ProgressionSnapshot,
} from '@idle-engine/core/internals';
import {
  compileViewModelToRenderCommandBuffer,
  RENDERER_CONTRACT_SCHEMA_VERSION,
  type UiNode,
  type ViewModel,
} from '@idle-engine/renderer-contract';
import { testGameContent, testGameContentArtifactHash } from '@idle-engine/content-test-game';
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
  serialize?: () => GameStateSaveFormat;
  hydrate?: (save: unknown) => void;
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
  const mode = (process.env.IDLE_ENGINE_GAME ?? 'demo').trim().toLowerCase();
  if (mode === 'test-game') {
    return createTestGameSimRuntime(options);
  }
  return createDemoSimRuntime(options);
}

function createDemoSimRuntime(options: SimRuntimeOptions = {}): SimRuntime {
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

type UiButton = Readonly<{
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  onClick: () => void;
}>;

type UiInputState = {
  hoveredId: string | null;
  pressedId: string | null;
};

function createTestGameSimRuntime(options: SimRuntimeOptions = {}): SimRuntime {
  const runtime = new IdleEngineRuntime({
    stepSizeMs: options.stepSizeMs ?? 16,
    maxStepsPerFrame: options.maxStepsPerFrame ?? 50,
  });

  const metricContext: {
    resourceState?: ReturnType<typeof createProgressionCoordinator>['resourceState'];
  } = {};

  const resolveResourceAmount = (resourceId: string): number => {
    const resourceState = metricContext.resourceState;
    if (!resourceState) {
      return 0;
    }
    const index = resourceState.getIndex(resourceId);
    if (index === undefined) {
      return 0;
    }
    return resourceState.getAmount(index);
  };

  const coordinator = createProgressionCoordinator({
    content: testGameContent,
    stepDurationMs: runtime.getStepSizeMs(),
    getCustomMetricValue: (metricId) => {
      if (metricId === 'test-game.metric.gold-gauge') {
        return resolveResourceAmount('test-game.gold');
      }
      if (metricId === 'test-game.metric.step-counter') {
        return runtime.getCurrentStep();
      }
      return 0;
    },
  });

  metricContext.resourceState = coordinator.resourceState;

  const wiring = wireGameRuntime({
    content: testGameContent,
    runtime,
    coordinator,
    enableProduction: true,
    enableAutomation: true,
    enableTransforms: true,
    enableEntities: true,
    registerOfflineCatchup: true,
  });

  // Reserve the command type so passthrough events don't show up as unknown commands.
  wiring.commandDispatcher.register(SHELL_CONTROL_EVENT_COMMAND_TYPE, () => undefined);

  const uiState: UiInputState = {
    hoveredId: null,
    pressedId: null,
  };

  let buttons: readonly UiButton[] = [];

  const frameQueue: RenderCommandBuffer[] = [];

  const formatNumber = (value: number): string => {
    if (!Number.isFinite(value)) {
      return '0';
    }
    const abs = Math.abs(value);
    if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}b`;
    if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}m`;
    if (abs >= 1e3) return `${(value / 1e3).toFixed(2)}k`;
    if (abs >= 100) return value.toFixed(0);
    if (abs >= 10) return value.toFixed(1);
    return value.toFixed(2);
  };

  const uiColorForButton = (id: string): number => {
    if (uiState.pressedId === id) {
      return 0x8a_2a_4f_ff;
    }
    if (uiState.hoveredId === id) {
      return 0x2a_4f_8a_ff;
    }
    return 0x18_2a_44_ff;
  };

  const findButtonAt = (x: number, y: number): UiButton | undefined => {
    for (const button of buttons) {
      if (x < button.x || y < button.y) {
        continue;
      }
      if (x > button.x + button.width || y > button.y + button.height) {
        continue;
      }
      return button;
    }
    return undefined;
  };

  const handleShellControlEvent = (event: ShellControlEvent): void => {
    const metadata = event.metadata;
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return;
    }

    const x = (metadata as { x?: unknown }).x;
    const y = (metadata as { y?: unknown }).y;
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) {
      return;
    }

    const hit = findButtonAt(x, y);
    const hitId = hit?.id ?? null;

    if (event.intent === 'mouse-move') {
      uiState.hoveredId = hitId;
      return;
    }

    if (event.intent === 'mouse-down') {
      uiState.hoveredId = hitId;
      uiState.pressedId = hitId;
      return;
    }

    if (event.intent === 'mouse-up') {
      uiState.hoveredId = hitId;
      const pressedId = uiState.pressedId;
      uiState.pressedId = null;
      if (pressedId && pressedId === hitId) {
        hit?.onClick();
      }
    }
  };

  const enqueuePlayerCommand = <TPayload extends object>(type: string, payload: TPayload): void => {
    const stepSizeMs = runtime.getStepSizeMs();
    const step = runtime.getNextExecutableStep();
    const timestamp = runtime.getCurrentStep() * stepSizeMs;

    wiring.commandQueue.enqueue({
      type,
      payload,
      priority: CommandPriority.PLAYER,
      timestamp,
      step,
    });
  };

  const buildUiButtonsAndNodes = (snapshot: ProgressionSnapshot): { nodes: UiNode[]; buttons: UiButton[] } => {
    const nodes: UiNode[] = [];
    const nextButtons: UiButton[] = [];

    const baseX = 560;
    let cursorY = 16;
    const rowHeight = 22;
    const headerHeight = 26;
    const panelWidth = 600;

    const addText = (id: string, x: number, y: number, text: string, fontSizePx: number, colorRgba: number): void => {
      nodes.push({
        kind: 'text',
        id,
        x,
        y,
        width: panelWidth - (x - baseX),
        height: rowHeight,
        text,
        colorRgba,
        fontSizePx,
      });
    };

    const addRect = (id: string, x: number, y: number, width: number, height: number, colorRgba: number): void => {
      nodes.push({
        kind: 'rect',
        id,
        x,
        y,
        width,
        height,
        colorRgba,
        radiusPx: 6,
      });
    };

    const addButton = (id: string, label: string, x: number, y: number, width: number, height: number, onClick: () => void): void => {
      addRect(`btn:${id}:bg`, x, y, width, height, uiColorForButton(id));
      addText(`btn:${id}:label`, x + 8, y + 4, label, 12, 0xff_ff_ff_ff);
      nextButtons.push({ id, x, y, width, height, onClick });
    };

    addRect('panel:bg', baseX - 12, cursorY - 8, panelWidth + 24, 760, 0x00_00_00_80);

    addText('title', baseX, cursorY, 'Test Game — Click to play', 16, 0xff_ff_ff_ff);
    cursorY += headerHeight;

    addText('resources:title', baseX, cursorY, 'Resources', 14, 0xff_ff_ff_ff);
    cursorY += headerHeight;

    const resources = snapshot.resources.filter((resource) => resource.visible).slice(0, 10);
    for (const resource of resources) {
      const cap = resource.capacity === undefined ? '' : ` / ${formatNumber(resource.capacity)}`;
      addText(
        `resource:${resource.id}`,
        baseX,
        cursorY,
        `${resource.displayName}: ${formatNumber(resource.amount)}${cap}  (${formatNumber(resource.perSecond)}/s)`,
        12,
        resource.unlocked ? 0xff_ff_ff_ff : 0xaa_aa_aa_ff,
      );
      cursorY += rowHeight;
    }

    cursorY += 8;

    addButton(
      'action:collect-gold',
      'Collect +1 Gold',
      baseX,
      cursorY,
      180,
      20,
      () => enqueuePlayerCommand(RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE, { resourceId: 'test-game.gold', amount: 1 }),
    );

    cursorY += headerHeight;

    addText('generators:title', baseX, cursorY, 'Generators', 14, 0xff_ff_ff_ff);
    cursorY += headerHeight;

    const generators = snapshot.generators.filter((generator) => generator.visible).slice(0, 8);
    for (const generator of generators) {
      const status = generator.unlocked ? '' : ' (locked)';
      addText(
        `gen:${generator.id}`,
        baseX,
        cursorY,
        `${generator.displayName}  x${generator.owned}${status}`,
        12,
        generator.unlocked ? 0xff_ff_ff_ff : 0xaa_aa_aa_ff,
      );

      const buyId = `action:buy-gen:${generator.id}`;
      const toggleId = `action:toggle-gen:${generator.id}`;

      addButton(
        buyId,
        generator.canAfford ? 'Buy' : 'Buy',
        baseX + 340,
        cursorY,
        60,
        20,
        () => enqueuePlayerCommand(RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR, { generatorId: generator.id, count: 1 }),
      );

      addButton(
        toggleId,
        generator.enabled ? 'On' : 'Off',
        baseX + 410,
        cursorY,
        48,
        20,
        () => enqueuePlayerCommand(RUNTIME_COMMAND_TYPES.TOGGLE_GENERATOR, { generatorId: generator.id, enabled: !generator.enabled }),
      );

      cursorY += rowHeight;
    }

    cursorY += 8;

    addText('upgrades:title', baseX, cursorY, 'Upgrades', 14, 0xff_ff_ff_ff);
    cursorY += headerHeight;

    const upgrades = snapshot.upgrades.filter((upgrade) => upgrade.visible).slice(0, 8);
    for (const upgrade of upgrades) {
      addText(
        `upg:${upgrade.id}`,
        baseX,
        cursorY,
        `${upgrade.displayName}  [${upgrade.status}]`,
        12,
        upgrade.status === 'available' ? 0xff_ff_ff_ff : 0xaa_aa_aa_ff,
      );

      if (upgrade.status === 'available') {
        const buyId = `action:buy-upg:${upgrade.id}`;
        addButton(
          buyId,
          'Buy',
          baseX + 340,
          cursorY,
          60,
          20,
          () => enqueuePlayerCommand(RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE, { upgradeId: upgrade.id }),
        );
      }

      cursorY += rowHeight;
    }

    cursorY += 8;

    addText('automations:title', baseX, cursorY, 'Automations', 14, 0xff_ff_ff_ff);
    cursorY += headerHeight;

    const automations = snapshot.automations.filter((automation) => automation.visible).slice(0, 6);
    for (const automation of automations) {
      addText(
        `auto:${automation.id}`,
        baseX,
        cursorY,
        `${automation.displayName}  ${automation.isEnabled ? '[enabled]' : '[disabled]'}`,
        12,
        automation.unlocked ? 0xff_ff_ff_ff : 0xaa_aa_aa_ff,
      );

      const toggleId = `action:toggle-auto:${automation.id}`;
      addButton(
        toggleId,
        automation.isEnabled ? 'On' : 'Off',
        baseX + 340,
        cursorY,
        60,
        20,
        () => enqueuePlayerCommand(RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION, { automationId: automation.id, enabled: !automation.isEnabled }),
      );

      cursorY += rowHeight;
    }

    cursorY += 8;

    addText('prestige:title', baseX, cursorY, 'Prestige', 14, 0xff_ff_ff_ff);
    cursorY += headerHeight;

    const prestigeLayers = snapshot.prestigeLayers.filter((layer) => layer.visible).slice(0, 4);
    for (const layer of prestigeLayers) {
      addText(
        `prestige:${layer.id}`,
        baseX,
        cursorY,
        `${layer.displayName}  [${layer.status}]`,
        12,
        layer.status === 'locked' ? 0xaa_aa_aa_ff : 0xff_ff_ff_ff,
      );

      if (layer.status !== 'locked') {
        const prestigeId = `action:prestige:${layer.id}`;
        addButton(
          prestigeId,
          'Prestige',
          baseX + 340,
          cursorY,
          80,
          20,
          () => enqueuePlayerCommand(RUNTIME_COMMAND_TYPES.PRESTIGE_RESET, { layerId: layer.id }),
        );
      }

      cursorY += rowHeight;
    }

    cursorY += 8;

    if (snapshot.transforms.length > 0) {
      addText('transforms:title', baseX, cursorY, 'Transforms', 14, 0xff_ff_ff_ff);
      cursorY += headerHeight;

      const transforms = snapshot.transforms.filter((transform) => transform.visible).slice(0, 4);
      for (const transform of transforms) {
        addText(
          `transform:${transform.id}`,
          baseX,
          cursorY,
          `${transform.displayName}`,
          12,
          transform.unlocked ? 0xff_ff_ff_ff : 0xaa_aa_aa_ff,
        );

        if (transform.unlocked) {
          const runId = `action:run-transform:${transform.id}`;
          addButton(
            runId,
            'Run',
            baseX + 340,
            cursorY,
            60,
            20,
            () => enqueuePlayerCommand(RUNTIME_COMMAND_TYPES.RUN_TRANSFORM, { transformId: transform.id, runs: 1 }),
          );
        }

        cursorY += rowHeight;
      }
    }

    cursorY += 8;

    if (snapshot.achievements && snapshot.achievements.length > 0) {
      addText('achievements:title', baseX, cursorY, 'Achievements', 14, 0xff_ff_ff_ff);
      cursorY += headerHeight;

      const achievements = snapshot.achievements.filter((achievement) => achievement.visible).slice(0, 6);
      for (const achievement of achievements) {
        const suffix = achievement.unlocked ? ' (done)' : ` ${formatNumber(achievement.progress)} / ${formatNumber(achievement.target)}`;
        addText(
          `ach:${achievement.id}`,
          baseX,
          cursorY,
          `${achievement.displayName}${suffix}`,
          12,
          achievement.unlocked ? 0xaa_ff_aa_ff : 0xff_ff_ff_ff,
        );
        cursorY += rowHeight;
      }
    }

    return { nodes, buttons: nextButtons };
  };

  runtime.addSystem({
    id: 'test-game-ui',
    tick: ({ step }) => {
      const stepSizeMs = runtime.getStepSizeMs();
      const frameStep = step + 1;
      const simTimeMs = frameStep * stepSizeMs;
      const snapshot = buildProgressionSnapshot(frameStep, simTimeMs, coordinator.state);
      const ui = buildUiButtonsAndNodes(snapshot);
      buttons = ui.buttons;

      const viewModel: ViewModel = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: frameStep,
          simTimeMs,
          contentHash: testGameContentArtifactHash,
        },
        scene: {
          camera: { x: 0, y: 0, zoom: 1 },
          sprites: [],
        },
        ui: {
          nodes: ui.nodes,
        },
      };

      frameQueue.push(compileViewModelToRenderCommandBuffer(viewModel));
    },
  });

  const hasCommandHandler = (type: string): boolean => {
    if (type === SHELL_CONTROL_EVENT_COMMAND_TYPE) {
      return true;
    }
    return wiring.commandDispatcher.getHandler(type) !== undefined;
  };

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

      if (normalized.type === SHELL_CONTROL_EVENT_COMMAND_TYPE) {
        const payload = normalized.payload as { event?: unknown };
        const event = payload.event;
        if (event && typeof event === 'object' && !Array.isArray(event)) {
          handleShellControlEvent(event as ShellControlEvent);
        }
        continue;
      }

      queue.enqueue(normalized);
    }
  };

  const serialize = (): GameStateSaveFormat => wiring.serialize();

  const hydrate = (save: unknown): void => {
    const loaded = loadGameStateSaveFormat(save);

    const targetStep = loaded.runtime.step;
    const currentStep = runtime.getCurrentStep();
    if (targetStep < currentStep) {
      throw new Error(
        `Cannot hydrate a save from step ${targetStep} into a runtime currently at step ${currentStep}. Create a new game instance instead.`,
      );
    }

    if (targetStep > currentStep) {
      runtime.fastForward((targetStep - currentStep) * runtime.getStepSizeMs());
    }

    wiring.hydrate(loaded, { currentStep: targetStep });
    uiState.hoveredId = null;
    uiState.pressedId = null;
  };

  return {
    tick,
    enqueueCommands,
    serialize,
    hydrate,
    getStepSizeMs: () => runtime.getStepSizeMs(),
    getNextStep: () => runtime.getNextExecutableStep(),
    hasCommandHandler,
  };
}
