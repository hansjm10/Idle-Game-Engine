import type { NormalizedContentPack } from '@idle-engine/content-schema';

import type { EngineConfigOverrides } from './config.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from './command.js';
import type {
  PurchaseGeneratorPayload,
  PurchaseUpgradePayload,
  RunTransformPayload,
  ToggleAutomationPayload,
} from './command.js';
import type { CommandResult } from './command-dispatcher.js';
import type { RuntimeDiagnosticsTimelineOptions } from './diagnostics/runtime-diagnostics-controller.js';
import type { EventHandler, EventSubscriptionOptions } from './events/event-bus.js';
import type { RuntimeEventType } from './events/runtime-event.js';
import type { GameStateSaveFormat } from './game-state-save.js';
import { createGameRuntime } from './internals.browser.js';
import type { GameRuntimeWiring } from './internals.browser.js';
import type { ProgressionAuthoritativeState, ProgressionSnapshot } from './progression.js';
import { buildProgressionSnapshot } from './progression.js';

export type GameSnapshot = ProgressionSnapshot;

export type SerializedGameState = GameStateSaveFormat;

export type Unsubscribe = () => void;

export type CreateGameOptions = Readonly<{
  readonly config?: EngineConfigOverrides;
  readonly stepSizeMs?: number;
  readonly maxStepsPerFrame?: number;
  readonly initialStep?: number;
  readonly initialProgressionState?: ProgressionAuthoritativeState;

  readonly systems?: Readonly<{
    readonly production?: boolean;
    readonly automation?: boolean;
    readonly transforms?: boolean;
    readonly entities?: boolean;
  }>;

  readonly diagnostics?: Readonly<{
    readonly enabled?: boolean;
    readonly timeline?: RuntimeDiagnosticsTimelineOptions | false;
  }>;

  readonly eventBus?: Readonly<{
    readonly capacity?: number;
  }>;

  readonly scheduler?: Readonly<{
    readonly intervalMs?: number; // default: stepSizeMs
  }>;
}>;

export interface Game {
  start(): void;
  stop(): void;
  tick(deltaMs: number): void;

  getSnapshot(): GameSnapshot;

  serialize(): SerializedGameState;
  hydrate(save: SerializedGameState): void;

  purchaseGenerator(generatorId: string, count: number): CommandResult;
  purchaseUpgrade(upgradeId: string): CommandResult;
  toggleAutomation(automationId: string, enabled: boolean): CommandResult;
  startTransform(transformId: string): CommandResult;

  on<TType extends RuntimeEventType>(
    eventType: TType,
    handler: EventHandler<TType>,
    options?: EventSubscriptionOptions,
  ): Unsubscribe;

  readonly internals: GameRuntimeWiring;
}

function toPositiveIntOrFallback(
  value: number,
  fallback: number,
): number {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.floor(value)) : fallback;
}

function toValidIntervalMs(
  intervalMs: unknown,
  fallback: number,
): number {
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return fallback;
  }
  return intervalMs;
}

export function createGame(
  content: NormalizedContentPack,
  options?: CreateGameOptions,
): Game {
  const config =
    options?.eventBus?.capacity === undefined
      ? options?.config
      : ({
          ...options?.config,
          limits: {
            ...options?.config?.limits,
            eventBusDefaultChannelCapacity: options.eventBus.capacity,
          },
        } satisfies EngineConfigOverrides);

  const wiring = createGameRuntime({
    content,
    ...(config ? { config } : {}),
    ...(options?.stepSizeMs === undefined ? {} : { stepSizeMs: options.stepSizeMs }),
    ...(options?.maxStepsPerFrame === undefined
      ? {}
      : { maxStepsPerFrame: options.maxStepsPerFrame }),
    ...(options?.initialStep === undefined ? {} : { initialStep: options.initialStep }),
    ...(options?.initialProgressionState === undefined
      ? {}
      : { initialProgressionState: options.initialProgressionState }),
    enableProduction: options?.systems?.production,
    enableAutomation: options?.systems?.automation,
    enableTransforms: options?.systems?.transforms,
    enableEntities: options?.systems?.entities,
  });

  const { runtime } = wiring;

  const diagnostics = options?.diagnostics;
  if (diagnostics) {
    const timeline = diagnostics.timeline;
    if (diagnostics.enabled === false || timeline === false) {
      runtime.enableDiagnostics(false);
    } else if (diagnostics.enabled === true || timeline !== undefined) {
      runtime.enableDiagnostics(timeline);
    }
  }

  let intervalHandle: ReturnType<typeof setInterval> | null = null;

  const stop = (): void => {
    if (intervalHandle === null) {
      return;
    }
    clearInterval(intervalHandle);
    intervalHandle = null;
  };

  const tick = (deltaMs: number): void => {
    runtime.tick(deltaMs);
  };

  const start = (): void => {
    if (intervalHandle !== null) {
      return;
    }

    const defaultIntervalMs = runtime.getStepSizeMs();
    const intervalMs = toValidIntervalMs(
      options?.scheduler?.intervalMs,
      defaultIntervalMs,
    );

    intervalHandle = setInterval(() => {
      tick(intervalMs);
    }, intervalMs);
  };

  const enqueuePlayerCommand = <TPayload extends object>(
    type: string,
    payload: TPayload,
  ): CommandResult => {
    const step = runtime.getNextExecutableStep();
    const timestamp = runtime.getCurrentStep() * runtime.getStepSizeMs();

    const accepted = wiring.commandQueue.enqueue({
      type,
      payload,
      priority: CommandPriority.PLAYER,
      timestamp,
      step,
    });

    if (!accepted) {
      return {
        success: false,
        error: {
          code: 'COMMAND_REJECTED',
          message: 'Command was rejected by the queue.',
          details: { type, step, timestamp },
        },
      };
    }

    return { success: true };
  };

  const hydrate = (save: GameStateSaveFormat): void => {
    stop();

    const targetStep = save.runtime.step;
    const currentStep = runtime.getCurrentStep();
    if (targetStep < currentStep) {
      throw new Error(
        `Cannot hydrate a save from step ${targetStep} into a runtime currently at step ${currentStep}. Create a new game instance instead.`,
      );
    }

    if (targetStep > currentStep) {
      runtime.fastForward((targetStep - currentStep) * runtime.getStepSizeMs());
    }

    wiring.hydrate(save, { currentStep: targetStep });
  };

  const game: Game = {
    start,
    stop,
    tick,
    getSnapshot: () =>
      buildProgressionSnapshot(
        runtime.getCurrentStep(),
        Date.now(),
        wiring.coordinator.state,
      ),
    serialize: () => wiring.serialize(),
    hydrate,
    purchaseGenerator: (generatorId, count) =>
      enqueuePlayerCommand<PurchaseGeneratorPayload>(
        RUNTIME_COMMAND_TYPES.PURCHASE_GENERATOR,
        {
          generatorId,
          count: toPositiveIntOrFallback(count, 1),
        },
      ),
    purchaseUpgrade: (upgradeId) =>
      enqueuePlayerCommand<PurchaseUpgradePayload>(
        RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
        { upgradeId },
      ),
    toggleAutomation: (automationId, enabled) =>
      enqueuePlayerCommand<ToggleAutomationPayload>(
        RUNTIME_COMMAND_TYPES.TOGGLE_AUTOMATION,
        { automationId, enabled },
      ),
    startTransform: (transformId) =>
      enqueuePlayerCommand<RunTransformPayload>(
        RUNTIME_COMMAND_TYPES.RUN_TRANSFORM,
        { transformId },
      ),
    on: (eventType, handler, subscriptionOptions) => {
      const subscription = runtime.getEventBus().on(eventType, handler, subscriptionOptions);
      return () => subscription.unsubscribe();
    },
    internals: wiring,
  };

  return Object.freeze(game);
}

