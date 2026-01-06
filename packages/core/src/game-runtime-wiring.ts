import type { NormalizedContentPack } from '@idle-engine/content-schema';

import type { CommandDispatcher } from './command-dispatcher.js';
import type { CommandQueue } from './command-queue.js';
import type { GameStateSaveFormat } from './game-state-save.js';
import type { ProgressionCoordinator } from './progression-coordinator.js';
import type { ProductionSystem } from './production-system.js';
import type { System } from './index.js';
import { createAutomationSystem } from './automation-system.js';
import { registerAutomationCommandHandlers } from './automation-command-handlers.js';
import { createResourceStateAdapter } from './automation-resource-state-adapter.js';
import { hydrateGameStateSaveFormat, serializeGameStateSaveFormat } from './game-state-save.js';
import { registerOfflineCatchupCommandHandler } from './offline-catchup-command-handlers.js';
import { createProductionSystem } from './production-system.js';
import { createTransformSystem } from './transform-system.js';
import { registerTransformCommandHandlers } from './transform-command-handlers.js';
import { registerResourceCommandHandlers } from './resource-command-handlers.js';
import { EntitySystem, createSeededRng } from './entity-system.js';
import { registerEntityCommandHandlers } from './entity-command-handlers.js';
import { PRDRegistry, seededRandom } from './rng.js';
import type { ProgressionAuthoritativeState, ProgressionEntityState } from './progression.js';

export interface RuntimeWiringRuntime {
  getStepSizeMs(): number;
  creditTime(deltaMs: number): void;
  getCurrentStep(): number;
  getCommandQueue(): CommandQueue;
  getCommandDispatcher(): CommandDispatcher;
  addSystem(system: System): void;
}

export type GameRuntimeSerializeOptions = Readonly<{
  readonly savedAt?: number;
  readonly rngSeed?: number;
  readonly runtimeStep?: number;
}>;

export type GameRuntimeHydrateOptions = Readonly<{
  readonly currentStep?: number;
  readonly applyRngSeed?: boolean;
}>;

export type GameRuntimeWiring<
  TRuntime extends RuntimeWiringRuntime = RuntimeWiringRuntime,
> = Readonly<{
  readonly runtime: TRuntime;
  readonly coordinator: ProgressionCoordinator;
  readonly commandQueue: CommandQueue;
  readonly commandDispatcher: CommandDispatcher;
  readonly prdRegistry: PRDRegistry;
  readonly productionSystem?: ProductionSystem;
  readonly automationSystem?: ReturnType<typeof createAutomationSystem>;
  readonly transformSystem?: ReturnType<typeof createTransformSystem>;
  readonly entitySystem?: EntitySystem;
  readonly systems: readonly System[];
  readonly serialize: (options?: GameRuntimeSerializeOptions) => GameStateSaveFormat;
  readonly hydrate: (
    save: GameStateSaveFormat,
    options?: GameRuntimeHydrateOptions,
  ) => void;
}>;

export type WireGameRuntimeOptions<
  TRuntime extends RuntimeWiringRuntime = RuntimeWiringRuntime,
> = Readonly<{
  readonly content: NormalizedContentPack;
  readonly runtime: TRuntime;
  readonly coordinator: ProgressionCoordinator;
  readonly enableProduction?: boolean;
  readonly enableAutomation?: boolean;
  readonly enableTransforms?: boolean;
  readonly enableEntities?: boolean;
  readonly production?: {
    readonly applyViaFinalizeTick?: boolean;
  };
  readonly registerOfflineCatchup?: boolean;
}>;

export function wireGameRuntime<
  TRuntime extends RuntimeWiringRuntime,
>(options: WireGameRuntimeOptions<TRuntime>): GameRuntimeWiring<TRuntime> {
  const { content, runtime, coordinator } = options;
  const runtimeStepSizeMs = runtime.getStepSizeMs();
  const coordinatorStepDurationMs = coordinator.state.stepDurationMs;

  if (
    typeof coordinatorStepDurationMs !== 'number' ||
    !Number.isFinite(coordinatorStepDurationMs) ||
    coordinatorStepDurationMs <= 0
  ) {
    throw new Error(
      'Progression coordinator step duration must be a positive, finite number.',
    );
  }

  if (coordinatorStepDurationMs !== runtimeStepSizeMs) {
    throw new Error(
      `Runtime stepSizeMs (${runtimeStepSizeMs}) must match coordinator stepDurationMs (${coordinatorStepDurationMs}).`,
    );
  }

  coordinator.updateForStep(runtime.getCurrentStep());

  const applyViaFinalizeTick = options.production?.applyViaFinalizeTick ?? false;
  const enableProduction =
    options.enableProduction ?? content.generators.length > 0;
  const enableAutomation =
    options.enableAutomation ?? content.automations.length > 0;
  const enableTransforms =
    options.enableTransforms ?? content.transforms.length > 0;
  const enableEntities =
    options.enableEntities ?? content.entities.length > 0;
  const registerOfflineCatchup = options.registerOfflineCatchup ?? true;

  const systems: System[] = [];

  const resourceStateAdapter = createResourceStateAdapter(
    coordinator.resourceState,
  );

  const automationSystem =
    enableAutomation && content.automations.length > 0
      ? createAutomationSystem({
          automations: content.automations,
          commandQueue: runtime.getCommandQueue(),
          resourceState: resourceStateAdapter,
          stepDurationMs: runtimeStepSizeMs,
          conditionContext: coordinator.getConditionContext(),
          isAutomationUnlocked: (automationId) =>
            coordinator.getGrantedAutomationIds().has(automationId),
        })
      : undefined;

  const prdRegistry = new PRDRegistry(seededRandom);

  const entitySystem =
    enableEntities && content.entities.length > 0
      ? new EntitySystem(content.entities, createSeededRng(), {
          stepDurationMs: runtimeStepSizeMs,
          conditionContext: coordinator.getConditionContext(),
        })
      : undefined;

  const transformSystem =
    enableTransforms && content.transforms.length > 0
      ? createTransformSystem({
          transforms: content.transforms,
          stepDurationMs: runtimeStepSizeMs,
          resourceState: resourceStateAdapter,
          conditionContext: coordinator.getConditionContext(),
          entitySystem,
          prdRegistry,
        })
      : undefined;

  registerResourceCommandHandlers({
    dispatcher: runtime.getCommandDispatcher(),
    resources: coordinator.resourceState,
    generatorPurchases: coordinator.generatorEvaluator,
    generatorToggles: coordinator,
    automationSystemId: automationSystem?.id ?? 'automation-system',
    ...(coordinator.upgradeEvaluator
      ? { upgradePurchases: coordinator.upgradeEvaluator }
      : {}),
    ...(coordinator.prestigeEvaluator
      ? { prestigeSystem: coordinator.prestigeEvaluator }
      : {}),
  });

  if (registerOfflineCatchup) {
    registerOfflineCatchupCommandHandler({
      dispatcher: runtime.getCommandDispatcher(),
      coordinator,
      runtime,
    });
  }

  let productionSystem: ProductionSystem | undefined;
  if (enableProduction && content.generators.length > 0) {
    productionSystem = createProductionSystem({
      applyViaFinalizeTick,
      generators: () =>
        (coordinator.state.generators ?? []).map((generator) => ({
          id: generator.id,
          owned: generator.owned,
          enabled: generator.enabled,
          produces: generator.produces ?? [],
          consumes: generator.consumes ?? [],
        })),
      resourceState: coordinator.resourceState,
    });

    runtime.addSystem(productionSystem);
    systems.push(productionSystem);

    if (applyViaFinalizeTick) {
      const resourceFinalizeSystem: System = {
        id: 'resource-finalize',
        tick: ({ deltaMs }) => coordinator.resourceState.finalizeTick(deltaMs),
      };
      runtime.addSystem(resourceFinalizeSystem);
      systems.push(resourceFinalizeSystem);
    }
  }

  if (automationSystem) {
    runtime.addSystem(automationSystem);
    systems.push(automationSystem);
  }

  if (transformSystem) {
    runtime.addSystem(transformSystem);
    systems.push(transformSystem);
  }

  if (entitySystem) {
    runtime.addSystem(entitySystem);
    systems.push(entitySystem);

    const coordinatorState = coordinator.state as ProgressionAuthoritativeState & {
      entities?: ProgressionEntityState;
    };
    coordinatorState.entities = {
      definitions: content.entities,
      state: entitySystem.getState().entities,
      instances: entitySystem.getState().instances,
      entityInstances: entitySystem.getState().entityInstances,
    };
  }

  const coordinatorUpdateSystem: System = {
    id: 'progression-coordinator',
    tick: ({ step, events }) => {
      coordinator.updateForStep(step + 1, { events });
    },
  };

  runtime.addSystem(coordinatorUpdateSystem);
  systems.push(coordinatorUpdateSystem);

  if (automationSystem) {
    registerAutomationCommandHandlers({
      dispatcher: runtime.getCommandDispatcher(),
      automationSystem,
    });
  }

  if (transformSystem) {
    registerTransformCommandHandlers({
      dispatcher: runtime.getCommandDispatcher(),
      transformSystem,
    });
  }

  if (entitySystem) {
    registerEntityCommandHandlers({
      dispatcher: runtime.getCommandDispatcher(),
      entitySystem,
    });
  }

  const serialize = (
    serializeOptions?: GameRuntimeSerializeOptions,
  ): GameStateSaveFormat =>
    serializeGameStateSaveFormat({
      runtimeStep: serializeOptions?.runtimeStep ?? runtime.getCurrentStep(),
      savedAt: serializeOptions?.savedAt,
      rngSeed: serializeOptions?.rngSeed,
      coordinator,
      prdRegistry,
      productionSystem,
      automationState: automationSystem?.getState(),
      transformState: transformSystem?.getState(),
      entitySystem,
      commandQueue: runtime.getCommandQueue(),
    });

  const hydrate = (
    save: GameStateSaveFormat,
    hydrateOptions?: GameRuntimeHydrateOptions,
  ): void => {
    hydrateGameStateSaveFormat({
      save,
      coordinator,
      productionSystem,
      automationSystem,
      transformSystem,
      entitySystem,
      prdRegistry,
      commandQueue: runtime.getCommandQueue(),
      currentStep: hydrateOptions?.currentStep,
      applyRngSeed: hydrateOptions?.applyRngSeed,
    });
  };

  return {
    runtime,
    coordinator,
    commandQueue: runtime.getCommandQueue(),
    commandDispatcher: runtime.getCommandDispatcher(),
    prdRegistry,
    productionSystem,
    automationSystem,
    transformSystem,
    entitySystem,
    systems,
    serialize,
    hydrate,
  };
}
