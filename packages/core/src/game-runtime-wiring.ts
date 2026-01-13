import type { NormalizedContentPack } from '@idle-engine/content-schema';

import type { EngineConfigOverrides } from './config.js';
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
  readonly config?: EngineConfigOverrides;
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
  assertValidCoordinatorStepDuration(runtimeStepSizeMs, coordinator.state.stepDurationMs);

  coordinator.updateForStep(runtime.getCurrentStep());

  const applyViaFinalizeTick = options.production?.applyViaFinalizeTick ?? false;
  const enablement = resolveWiringEnablement(options, content);

  const systems: System[] = [];

  const resourceStateAdapter = createResourceStateAdapter(
    coordinator.resourceState,
  );

  const prdRegistry = new PRDRegistry(seededRandom);

  const automationSystem = createAutomationSystemIfEnabled({
    enabled: enablement.enableAutomation,
    automations: content.automations,
    commandQueue: runtime.getCommandQueue(),
    resourceState: resourceStateAdapter,
    stepDurationMs: runtimeStepSizeMs,
    conditionContext: coordinator.getConditionContext(),
    isAutomationUnlocked: (automationId) =>
      coordinator.getGrantedAutomationIds().has(automationId),
  });

  const entitySystem = createEntitySystemIfEnabled({
    enabled: enablement.enableEntities,
    entities: content.entities,
    stepDurationMs: runtimeStepSizeMs,
    conditionContext: coordinator.getConditionContext(),
  });

  const transformSystem = createTransformSystemIfEnabled({
    enabled: enablement.enableTransforms,
    transforms: content.transforms,
    stepDurationMs: runtimeStepSizeMs,
    resourceState: resourceStateAdapter,
    conditionContext: coordinator.getConditionContext(),
    entitySystem,
    prdRegistry,
    config: options.config,
  });

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

  registerOfflineCatchupHandlerIfEnabled({
    enabled: enablement.registerOfflineCatchup,
    dispatcher: runtime.getCommandDispatcher(),
    coordinator,
    runtime,
  });

  const productionSystem = registerProductionSystemIfEnabled({
    enabled: enablement.enableProduction,
    hasGenerators: content.generators.length > 0,
    applyViaFinalizeTick,
    runtime,
    coordinator,
    systems,
  });

  registerSystemIfDefined(runtime, systems, automationSystem);
  registerSystemIfDefined(runtime, systems, transformSystem);
  registerSystemIfDefined(runtime, systems, entitySystem);
  syncCoordinatorEntityStateIfEnabled(coordinator, entitySystem, content.entities);

  const coordinatorUpdateSystem: System = {
    id: 'progression-coordinator',
    tick: ({ step, events }) => {
      coordinator.updateForStep(step + 1, { events });
    },
  };

  runtime.addSystem(coordinatorUpdateSystem);
  systems.push(coordinatorUpdateSystem);

  registerAutomationHandlersIfEnabled(runtime.getCommandDispatcher(), automationSystem);
  registerTransformHandlersIfEnabled(runtime.getCommandDispatcher(), transformSystem);
  registerEntityHandlersIfEnabled(runtime.getCommandDispatcher(), entitySystem);

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

function assertValidCoordinatorStepDuration(
  runtimeStepSizeMs: number,
  coordinatorStepDurationMs: unknown,
): void {
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
}

function resolveWiringEnablement(
  options: WireGameRuntimeOptions<RuntimeWiringRuntime>,
  content: NormalizedContentPack,
): Readonly<{
  enableProduction: boolean;
  enableAutomation: boolean;
  enableTransforms: boolean;
  enableEntities: boolean;
  registerOfflineCatchup: boolean;
}> {
  return {
    enableProduction: options.enableProduction ?? content.generators.length > 0,
    enableAutomation: options.enableAutomation ?? content.automations.length > 0,
    enableTransforms: options.enableTransforms ?? content.transforms.length > 0,
    enableEntities: options.enableEntities ?? content.entities.length > 0,
    registerOfflineCatchup: options.registerOfflineCatchup ?? true,
  };
}

function createAutomationSystemIfEnabled(
  options: Readonly<{
    enabled: boolean;
    automations: NormalizedContentPack['automations'];
    commandQueue: CommandQueue;
    resourceState: ReturnType<typeof createResourceStateAdapter>;
    stepDurationMs: number;
    conditionContext: ReturnType<ProgressionCoordinator['getConditionContext']>;
    isAutomationUnlocked: (automationId: string) => boolean;
  }>,
): ReturnType<typeof createAutomationSystem> | undefined {
  if (!options.enabled || options.automations.length === 0) {
    return undefined;
  }

  return createAutomationSystem({
    automations: options.automations,
    commandQueue: options.commandQueue,
    resourceState: options.resourceState,
    stepDurationMs: options.stepDurationMs,
    conditionContext: options.conditionContext,
    isAutomationUnlocked: options.isAutomationUnlocked,
  });
}

function createEntitySystemIfEnabled(
  options: Readonly<{
    enabled: boolean;
    entities: NormalizedContentPack['entities'];
    stepDurationMs: number;
    conditionContext: ReturnType<ProgressionCoordinator['getConditionContext']>;
  }>,
): EntitySystem | undefined {
  if (!options.enabled || options.entities.length === 0) {
    return undefined;
  }

  return new EntitySystem(options.entities, createSeededRng(), {
    stepDurationMs: options.stepDurationMs,
    conditionContext: options.conditionContext,
  });
}

function createTransformSystemIfEnabled(
  options: Readonly<{
    enabled: boolean;
    transforms: NormalizedContentPack['transforms'];
    stepDurationMs: number;
    resourceState: ReturnType<typeof createResourceStateAdapter>;
    conditionContext: ReturnType<ProgressionCoordinator['getConditionContext']>;
    entitySystem: EntitySystem | undefined;
    prdRegistry: PRDRegistry;
    config?: EngineConfigOverrides;
  }>,
): ReturnType<typeof createTransformSystem> | undefined {
  if (!options.enabled || options.transforms.length === 0) {
    return undefined;
  }

  return createTransformSystem({
    transforms: options.transforms,
    stepDurationMs: options.stepDurationMs,
    resourceState: options.resourceState,
    conditionContext: options.conditionContext,
    entitySystem: options.entitySystem,
    prdRegistry: options.prdRegistry,
    config: options.config,
  });
}

function registerOfflineCatchupHandlerIfEnabled(
  options: Readonly<{
    enabled: boolean;
    dispatcher: CommandDispatcher;
    coordinator: ProgressionCoordinator;
    runtime: RuntimeWiringRuntime;
  }>,
): void {
  if (!options.enabled) {
    return;
  }
  registerOfflineCatchupCommandHandler({
    dispatcher: options.dispatcher,
    coordinator: options.coordinator,
    runtime: options.runtime,
  });
}

function registerProductionSystemIfEnabled(
  options: Readonly<{
    enabled: boolean;
    hasGenerators: boolean;
    applyViaFinalizeTick: boolean;
    runtime: RuntimeWiringRuntime;
    coordinator: ProgressionCoordinator;
    systems: System[];
  }>,
): ProductionSystem | undefined {
  if (!options.enabled || !options.hasGenerators) {
    return undefined;
  }

  const productionSystem = createProductionSystem({
    applyViaFinalizeTick: options.applyViaFinalizeTick,
    generators: () =>
      (options.coordinator.state.generators ?? []).map((generator) => ({
        id: generator.id,
        owned: generator.owned,
        enabled: generator.enabled,
        produces: generator.produces ?? [],
        consumes: generator.consumes ?? [],
      })),
    resourceState: options.coordinator.resourceState,
  });

  options.runtime.addSystem(productionSystem);
  options.systems.push(productionSystem);

  if (options.applyViaFinalizeTick) {
    const resourceFinalizeSystem: System = {
      id: 'resource-finalize',
      tick: ({ deltaMs }) => options.coordinator.resourceState.finalizeTick(deltaMs),
    };
    options.runtime.addSystem(resourceFinalizeSystem);
    options.systems.push(resourceFinalizeSystem);
  }

  return productionSystem;
}

function registerSystemIfDefined(
  runtime: RuntimeWiringRuntime,
  systems: System[],
  system: System | undefined,
): void {
  if (!system) {
    return;
  }
  runtime.addSystem(system);
  systems.push(system);
}

function syncCoordinatorEntityStateIfEnabled(
  coordinator: ProgressionCoordinator,
  entitySystem: EntitySystem | undefined,
  entityDefinitions: NormalizedContentPack['entities'],
): void {
  if (!entitySystem) {
    return;
  }

  const coordinatorState = coordinator.state as ProgressionAuthoritativeState & {
    entities?: ProgressionEntityState;
  };
  coordinatorState.entities = {
    definitions: entityDefinitions,
    state: entitySystem.getState().entities,
    instances: entitySystem.getState().instances,
    entityInstances: entitySystem.getState().entityInstances,
  };
}

function registerAutomationHandlersIfEnabled(
  dispatcher: CommandDispatcher,
  automationSystem: ReturnType<typeof createAutomationSystem> | undefined,
): void {
  if (!automationSystem) {
    return;
  }
  registerAutomationCommandHandlers({
    dispatcher,
    automationSystem,
  });
}

function registerTransformHandlersIfEnabled(
  dispatcher: CommandDispatcher,
  transformSystem: ReturnType<typeof createTransformSystem> | undefined,
): void {
  if (!transformSystem) {
    return;
  }
  registerTransformCommandHandlers({
    dispatcher,
    transformSystem,
  });
}

function registerEntityHandlersIfEnabled(
  dispatcher: CommandDispatcher,
  entitySystem: EntitySystem | undefined,
): void {
  if (!entitySystem) {
    return;
  }
  registerEntityCommandHandlers({
    dispatcher,
    entitySystem,
  });
}
