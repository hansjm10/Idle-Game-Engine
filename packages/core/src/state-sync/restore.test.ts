import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AutomationDefinition,
  NumericFormula,
  TransformDefinition,
} from '@idle-engine/content-schema';

import { createAutomationSystem } from '../automation-system.js';
import { createResourceStateAdapter } from '../automation-resource-state-adapter.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from '../command.js';
import type { SerializedCommandQueueV1 } from '../command-queue.js';
import {
  createContentPack,
  createEntityDefinition,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
} from '../content-test-helpers.js';
import {
  captureGameStateSnapshot,
  CommandQueue,
  createGameRuntime,
  createResourceState,
  IdleEngineRuntime,
  restoreGameRuntimeFromSnapshot,
  restoreFromSnapshot,
  restorePartial,
} from '../index.js';
import { createProductionSystem } from '../production-system.js';
import { createProgressionCoordinator } from '../progression-coordinator.js';
import { hydrateProgressionCoordinatorState } from '../progression-coordinator-save.js';
import {
  getCurrentRNGSeed,
  getRNGState,
  resetRNG,
  seededRandom,
  setRNGSeed,
} from '../rng.js';
import type { ResourceDefinition } from '../resource-state.js';
import { createTransformSystem } from '../transform-system.js';
import type { GameStateSnapshot } from './types.js';
import type { EntitySystemState } from '../entity-system.js';

const STEP_SIZE_MS = 100;
const INITIAL_STEP = 12;
const CAPTURE_TIME = 1_700_000_123;

const createEmptyEntityState = (): EntitySystemState => ({
  entities: new Map(),
  instances: new Map(),
  entityInstances: new Map(),
});

const literal = (value: number): NumericFormula => ({
  kind: 'constant',
  value,
});

const createResourceDefinitions = (
  resources: readonly {
    readonly id: string;
    readonly startAmount?: number;
    readonly capacity?: number | null;
    readonly unlocked?: boolean;
    readonly visible?: boolean;
    readonly dirtyTolerance?: number;
  }[],
): ResourceDefinition[] =>
  resources.map((resource) => ({
    id: resource.id,
    startAmount: resource.startAmount ?? 0,
    capacity:
      resource.capacity === null || resource.capacity === undefined
        ? undefined
        : resource.capacity,
    unlocked: resource.unlocked ?? false,
    visible: resource.visible ?? true,
    dirtyTolerance: resource.dirtyTolerance ?? undefined,
  }));

function createTestContent() {
  return createContentPack({
    resources: [
      createResourceDefinition('resource.energy', {
        startAmount: 1000,
        capacity: null,
        unlocked: true,
        visible: true,
      }),
      createResourceDefinition('resource.gold', {
        startAmount: 0,
        capacity: null,
        unlocked: true,
        visible: true,
      }),
      createResourceDefinition('resource.gems', {
        startAmount: 0,
        capacity: null,
        unlocked: true,
        visible: true,
      }),
    ],
    generators: [
      createGeneratorDefinition('generator.mine', {
        purchase: {
          currencyId: 'resource.energy',
          costMultiplier: 10,
          costCurve: literal(1),
        },
        produces: [{ resourceId: 'resource.gold', rate: literal(4) }],
        consumes: [],
        baseUnlock: { kind: 'always' },
      }),
    ],
    upgrades: [
      createUpgradeDefinition('upgrade.double-mine', {
        cost: {
          currencyId: 'resource.energy',
          costMultiplier: 100,
          costCurve: literal(1),
        },
        effects: [
          {
            kind: 'modifyGeneratorRate',
            generatorId: 'generator.mine',
            operation: 'multiply',
            value: literal(2),
          },
        ],
      }),
    ],
  });
}

function createTestAutomations(): AutomationDefinition[] {
  return [
    {
      id: 'auto:collector' as any,
      name: { default: 'Auto Collector', variants: {} },
      description: { default: 'Collects automatically', variants: {} },
      targetType: 'generator',
      targetId: 'gen:clicks' as any,
      trigger: { kind: 'interval', interval: { kind: 'constant', value: 100 } },
      unlockCondition: { kind: 'always' },
      enabledByDefault: true,
      order: 0,
    },
  ];
}

function createTestTransforms(): TransformDefinition[] {
  return [
    {
      id: 'transform:convert' as any,
      name: { default: 'Convert', variants: {} },
      description: { default: 'Convert gold to gems', variants: {} },
      mode: 'instant',
      inputs: [
        { resourceId: 'resource.gold' as any, amount: literal(10) },
      ],
      outputs: [
        { resourceId: 'resource.gems' as any, amount: literal(1) },
      ],
      cooldown: literal(500),
      trigger: { kind: 'manual' },
      tags: [],
    },
  ];
}

describe('restoreFromSnapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetRNG();
  });

  it('restores a snapshot so capture round-trips with matching data', () => {
    setRNGSeed(4242);
    seededRandom();
    seededRandom();
    const expectedRngState = getRNGState();

    const content = createTestContent();
    const resourceDefinitions = createResourceDefinitions(content.resources);

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: STEP_SIZE_MS,
    });
    coordinator.incrementGeneratorOwned('generator.mine', 2);
    coordinator.incrementUpgradePurchases('upgrade.double-mine');
    coordinator.updateForStep(INITIAL_STEP);

    const runtime = new IdleEngineRuntime({
      stepSizeMs: STEP_SIZE_MS,
      initialStep: INITIAL_STEP,
    });

    const productionSystem = createProductionSystem({
      systemId: 'test-production',
      generators: () =>
        (coordinator.state.generators ?? []).map((generator) => ({
          id: generator.id,
          owned: generator.owned,
          enabled: generator.enabled,
          produces: generator.produces ?? [],
          consumes: generator.consumes ?? [],
        })),
      resourceState: coordinator.resourceState,
      applyThreshold: 1,
    });

    const commandQueue = runtime.getCommandQueue();
    const resourceStateAdapter = createResourceStateAdapter(
      coordinator.resourceState,
    );

    const automationSystem = createAutomationSystem({
      automations: createTestAutomations(),
      stepDurationMs: STEP_SIZE_MS,
      commandQueue,
      resourceState: resourceStateAdapter,
      conditionContext: coordinator.getConditionContext(),
    });

    const transformSystem = createTransformSystem({
      transforms: createTestTransforms(),
      stepDurationMs: STEP_SIZE_MS,
      resourceState: resourceStateAdapter,
      conditionContext: coordinator.getConditionContext(),
    });

    commandQueue.enqueue({
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.energy', amount: 5 },
      timestamp: 12345,
      step: INITIAL_STEP,
    });

    const snapshot = captureGameStateSnapshot({
      runtime,
      progressionCoordinator: coordinator,
      capturedAt: CAPTURE_TIME,
      getAutomationState: () => automationSystem.getState(),
      getTransformState: () => transformSystem.getState(),
      getEntityState: createEmptyEntityState,
      commandQueue,
      productionSystem,
    });

    expect(snapshot.runtime.rngState).toBe(expectedRngState);

    setRNGSeed(7);

    const restored = restoreFromSnapshot({
      snapshot,
      resourceDefinitions,
    });

    const restoredCoordinator = createProgressionCoordinator({
      content,
      stepDurationMs: STEP_SIZE_MS,
      initialState: {
        stepDurationMs: STEP_SIZE_MS,
        resources: {
          state: restored.resources,
        },
      },
    });

    const restoredProductionSystem = createProductionSystem({
      systemId: 'test-production',
      generators: () =>
        (restoredCoordinator.state.generators ?? []).map((generator) => ({
          id: generator.id,
          owned: generator.owned,
          enabled: generator.enabled,
          produces: generator.produces ?? [],
          consumes: generator.consumes ?? [],
        })),
      resourceState: restoredCoordinator.resourceState,
      applyThreshold: 1,
    });

    hydrateProgressionCoordinatorState(
      snapshot.progression,
      restoredCoordinator,
      restoredProductionSystem,
      { skipResources: true },
    );

    const restoredResourceAdapter = createResourceStateAdapter(
      restoredCoordinator.resourceState,
    );

    const restoredAutomationSystem = createAutomationSystem({
      automations: createTestAutomations(),
      stepDurationMs: STEP_SIZE_MS,
      commandQueue: restored.commandQueue,
      resourceState: restoredResourceAdapter,
      conditionContext: restoredCoordinator.getConditionContext(),
    });

    const restoredTransformSystem = createTransformSystem({
      transforms: createTestTransforms(),
      stepDurationMs: STEP_SIZE_MS,
      resourceState: restoredResourceAdapter,
      conditionContext: restoredCoordinator.getConditionContext(),
    });

    restoredAutomationSystem.restoreState(snapshot.automation, {
      savedWorkerStep: snapshot.runtime.step,
      currentStep: restored.runtime.getCurrentStep(),
    });

    restoredTransformSystem.restoreState(snapshot.transforms, {
      savedWorkerStep: snapshot.runtime.step,
      currentStep: restored.runtime.getCurrentStep(),
    });

    const roundTrip = captureGameStateSnapshot({
      runtime: restored.runtime,
      progressionCoordinator: restoredCoordinator,
      capturedAt: CAPTURE_TIME,
      getAutomationState: () => restoredAutomationSystem.getState(),
      getTransformState: () => restoredTransformSystem.getState(),
      getEntityState: createEmptyEntityState,
      commandQueue: restored.commandQueue,
      productionSystem: restoredProductionSystem,
    });

    expect(roundTrip).toEqual(snapshot);
    expect(getCurrentRNGSeed()).toBe(snapshot.runtime.rngSeed);
    expect(getRNGState()).toBe(snapshot.runtime.rngState);
  });

  it('skips RNG restoration when applyRngSeed is false', () => {
    const resources = {
      ids: ['resource.energy'],
      amounts: [10],
      capacities: [null],
      unlocked: [true],
      visible: [true],
      flags: [0],
    };

    const snapshot: GameStateSnapshot = {
      version: 1,
      capturedAt: 0,
      runtime: {
        step: 0,
        stepSizeMs: STEP_SIZE_MS,
        rngSeed: 1337,
        rngState: 42,
      },
      resources,
      progression: {
        schemaVersion: 2,
        step: 0,
        resources,
        generators: [],
        upgrades: [],
        achievements: [],
      },
      automation: [],
      transforms: [],
      entities: { entities: [], instances: [], entityInstances: [] },
      prd: {},
      commandQueue: {
        schemaVersion: 1,
        entries: [],
      },
    };

    const resourceDefinitions: ResourceDefinition[] = [
      {
        id: 'resource.energy',
        startAmount: 0,
        capacity: null,
        unlocked: true,
        visible: true,
      },
    ];

    setRNGSeed(9001);

    restoreFromSnapshot({
      snapshot,
      resourceDefinitions,
      applyRngSeed: false,
    });

    expect(getCurrentRNGSeed()).toBe(9001);
    expect(getRNGState()).toBe(9001);
  });

  it('reports added resource ids during reconciliation', () => {
    const resources = {
      ids: ['resource.energy'],
      amounts: [10],
      capacities: [null],
      flags: [0],
    };

    const snapshot: GameStateSnapshot = {
      version: 1,
      capturedAt: 0,
      runtime: {
        step: 0,
        stepSizeMs: STEP_SIZE_MS,
        rngSeed: undefined,
      },
      resources,
      progression: {
        schemaVersion: 2,
        step: 0,
        resources,
        generators: [],
        upgrades: [],
        achievements: [],
      },
      automation: [],
      transforms: [],
      entities: { entities: [], instances: [], entityInstances: [] },
      commandQueue: {
        schemaVersion: 1,
        entries: [],
      },
    };

    const resourceDefinitions: ResourceDefinition[] = [
      {
        id: 'resource.energy',
        startAmount: 0,
        capacity: null,
        unlocked: true,
        visible: true,
      },
      {
        id: 'resource.gold',
        startAmount: 0,
        capacity: null,
        unlocked: true,
        visible: true,
      },
    ];

    const restored = restoreFromSnapshot({
      snapshot,
      resourceDefinitions,
      applyRngSeed: false,
    });

    expect(restored.reconciliation.addedIds).toEqual(['resource.gold']);
    expect(restored.reconciliation.removedIds).toEqual([]);
  });

  it('rebases command steps when runtime step differs', () => {
    const resources = {
      ids: ['resource.energy'],
      amounts: [10],
      capacities: [null],
      unlocked: [true],
      visible: [true],
      flags: [0],
    };

    const commandQueue: SerializedCommandQueueV1 = {
      schemaVersion: 1,
      entries: [
        {
          type: 'command.test',
          priority: CommandPriority.PLAYER,
          timestamp: 55,
          step: 10,
          payload: { amount: 2 },
        },
      ],
    };

    const snapshot: GameStateSnapshot = {
      version: 1,
      capturedAt: 0,
      runtime: {
        step: 10,
        stepSizeMs: STEP_SIZE_MS,
        rngSeed: undefined,
      },
      resources,
      progression: {
        schemaVersion: 2,
        step: 10,
        resources,
        generators: [],
        upgrades: [],
        achievements: [],
      },
      automation: [],
      transforms: [],
      entities: { entities: [], instances: [], entityInstances: [] },
      commandQueue,
    };

    const resourceDefinitions: ResourceDefinition[] = [
      {
        id: 'resource.energy',
        startAmount: 0,
        capacity: null,
        unlocked: false,
        visible: false,
      },
    ];

    const restored = restoreFromSnapshot({
      snapshot,
      resourceDefinitions,
      runtimeOptions: { initialStep: 4 },
    });

    const restoredQueue = restored.commandQueue.exportForSave();
    expect(restoredQueue.entries[0]?.step).toBe(4);
    expect(restored.runtime.getCurrentStep()).toBe(4);
  });
});

describe('restoreGameRuntimeFromSnapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetRNG();
  });

  it('restores wiring so snapshots round-trip', () => {
    setRNGSeed(4242);
    seededRandom();
    seededRandom();
    const expectedRngState = getRNGState();

    const baseContent = createTestContent();
    const content = createContentPack({
      resources: [...baseContent.resources],
      generators: [...baseContent.generators],
      upgrades: [...baseContent.upgrades],
      automations: createTestAutomations(),
      transforms: createTestTransforms(),
    });

    const wiring = createGameRuntime({
      content,
      stepSizeMs: STEP_SIZE_MS,
      initialStep: INITIAL_STEP,
    });

    wiring.coordinator.incrementGeneratorOwned('generator.mine', 2);
    wiring.coordinator.incrementUpgradePurchases('upgrade.double-mine');
    wiring.coordinator.updateForStep(INITIAL_STEP);

    wiring.commandQueue.enqueue({
      type: RUNTIME_COMMAND_TYPES.COLLECT_RESOURCE,
      priority: CommandPriority.PLAYER,
      payload: { resourceId: 'resource.energy', amount: 5 },
      timestamp: 12345,
      step: INITIAL_STEP,
    });

    const snapshot = captureGameStateSnapshot({
      runtime: wiring.runtime,
      progressionCoordinator: wiring.coordinator,
      capturedAt: CAPTURE_TIME,
      getAutomationState: () => wiring.automationSystem?.getState() ?? new Map(),
      getTransformState: () => wiring.transformSystem?.getState() ?? new Map(),
      getEntityState: createEmptyEntityState,
      commandQueue: wiring.commandQueue,
      productionSystem: wiring.productionSystem,
    });

    expect(snapshot.runtime.rngState).toBe(expectedRngState);

    setRNGSeed(7);

    const restored = restoreGameRuntimeFromSnapshot({
      content,
      snapshot,
    });

    const roundTrip = captureGameStateSnapshot({
      runtime: restored.runtime,
      progressionCoordinator: restored.coordinator,
      capturedAt: CAPTURE_TIME,
      getAutomationState: () => restored.automationSystem?.getState() ?? new Map(),
      getTransformState: () => restored.transformSystem?.getState() ?? new Map(),
      getEntityState: createEmptyEntityState,
      commandQueue: restored.commandQueue,
      productionSystem: restored.productionSystem,
    });

    expect(roundTrip).toEqual(snapshot);
    expect(getCurrentRNGSeed()).toBe(snapshot.runtime.rngSeed);
    expect(getRNGState()).toBe(snapshot.runtime.rngState);
  });

  it('defaults applyViaFinalizeTick to true when generators are present', () => {
    const content = createTestContent();

    const wiring = createGameRuntime({
      content,
      stepSizeMs: STEP_SIZE_MS,
      initialStep: INITIAL_STEP,
    });

    const snapshot = captureGameStateSnapshot({
      runtime: wiring.runtime,
      progressionCoordinator: wiring.coordinator,
      capturedAt: CAPTURE_TIME,
      getAutomationState: () => wiring.automationSystem?.getState() ?? new Map(),
      getTransformState: () => wiring.transformSystem?.getState() ?? new Map(),
      getEntityState: createEmptyEntityState,
      commandQueue: wiring.commandQueue,
      productionSystem: wiring.productionSystem,
    });

    const restored = restoreGameRuntimeFromSnapshot({
      content,
      snapshot,
    });

    expect(restored.runtime.getMaxStepsPerFrame()).toBe(1);
    expect(restored.systems.map((system) => system.id)).toEqual([
      'production',
      'resource-finalize',
      'progression-coordinator',
    ]);
  });

  it('respects applyViaFinalizeTick override when restoring', () => {
    const content = createTestContent();

    const wiring = createGameRuntime({
      content,
      stepSizeMs: STEP_SIZE_MS,
      production: { applyViaFinalizeTick: false },
    });

    const snapshot = captureGameStateSnapshot({
      runtime: wiring.runtime,
      progressionCoordinator: wiring.coordinator,
      capturedAt: CAPTURE_TIME,
      getAutomationState: () => wiring.automationSystem?.getState() ?? new Map(),
      getTransformState: () => wiring.transformSystem?.getState() ?? new Map(),
      getEntityState: createEmptyEntityState,
      commandQueue: wiring.commandQueue,
      productionSystem: wiring.productionSystem,
    });

    const restored = restoreGameRuntimeFromSnapshot({
      content,
      snapshot,
      production: { applyViaFinalizeTick: false },
    });

    expect(restored.runtime.getMaxStepsPerFrame()).toBeGreaterThan(1);
    expect(restored.systems.map((system) => system.id)).toEqual([
      'production',
      'progression-coordinator',
    ]);
  });

  it('rebases automation and transform steps when restoring into a later step', () => {
    const baseContent = createTestContent();
    const content = createContentPack({
      resources: [...baseContent.resources],
      generators: [...baseContent.generators],
      upgrades: [...baseContent.upgrades],
      automations: createTestAutomations(),
      transforms: createTestTransforms(),
    });

    const wiring = createGameRuntime({
      content,
      stepSizeMs: STEP_SIZE_MS,
      initialStep: INITIAL_STEP,
    });

    const automationSystem = wiring.automationSystem;
    const transformSystem = wiring.transformSystem;
    if (!automationSystem || !transformSystem) {
      throw new Error('Expected automation and transform systems to be wired.');
    }

    const savedStep = wiring.runtime.getCurrentStep();
    const rebaseDelta = 5;
    const targetStep = savedStep + rebaseDelta;

    const lastFiredStep = savedStep - 2;
    const automationCooldown = savedStep + 4;
    const transformCooldown = savedStep + 6;

    automationSystem.restoreState(
      [
        {
          id: 'auto:collector',
          enabled: true,
          lastFiredStep,
          cooldownExpiresStep: automationCooldown,
          unlocked: true,
          lastThresholdSatisfied: false,
        },
      ],
      { savedWorkerStep: savedStep, currentStep: savedStep },
    );

    transformSystem.restoreState(
      [
        {
          id: 'transform:convert',
          unlocked: true,
          cooldownExpiresStep: transformCooldown,
        },
      ],
      { savedWorkerStep: savedStep, currentStep: savedStep },
    );

    const snapshot = captureGameStateSnapshot({
      runtime: wiring.runtime,
      progressionCoordinator: wiring.coordinator,
      capturedAt: CAPTURE_TIME,
      getAutomationState: () => wiring.automationSystem?.getState() ?? new Map(),
      getTransformState: () => wiring.transformSystem?.getState() ?? new Map(),
      getEntityState: createEmptyEntityState,
      commandQueue: wiring.commandQueue,
      productionSystem: wiring.productionSystem,
    });

    const restored = restoreGameRuntimeFromSnapshot({
      content,
      snapshot,
      runtimeOptions: { initialStep: targetStep },
    });

    const restoredAutomation = restored.automationSystem
      ?.getState()
      .get('auto:collector');
    const restoredTransform = restored.transformSystem
      ?.getState()
      .get('transform:convert');

    if (!restoredAutomation || !restoredTransform) {
      throw new Error('Expected automation and transform systems to be wired.');
    }

    expect(restored.runtime.getCurrentStep()).toBe(targetStep);
    expect(restoredAutomation.lastFiredStep).toBe(lastFiredStep + rebaseDelta);
    expect(restoredAutomation.cooldownExpiresStep).toBe(
      automationCooldown + rebaseDelta,
    );
    expect(restoredTransform.cooldownExpiresStep).toBe(
      transformCooldown + rebaseDelta,
    );
  });

  it('rebases entity assignment steps when restoring into a later step', () => {
    const content = createContentPack({
      resources: [
        createResourceDefinition('resource.energy', {
          startAmount: 0,
          capacity: null,
          unlocked: true,
          visible: true,
        }),
      ],
      entities: [
        createEntityDefinition('entity.scout', {
          trackInstances: true,
          startCount: 1,
          unlocked: true,
          visible: true,
        }),
      ],
    });

    const savedStep = 10;
    const rebaseDelta = 4;
    const wiring = createGameRuntime({
      content,
      stepSizeMs: STEP_SIZE_MS,
      initialStep: savedStep,
    });

    const entitySystem = wiring.entitySystem;
    if (!entitySystem) {
      throw new Error('Expected entity system to be wired.');
    }

    const [instance] = entitySystem.getInstancesForEntity('entity.scout');
    if (!instance) {
      throw new Error('Expected entity instance to be created.');
    }

    const assignment = {
      missionId: 'mission.alpha',
      batchId: 'batch-1',
      deployedAtStep: savedStep - 1,
      returnStep: savedStep + 3,
    };

    entitySystem.assignToMission(instance.instanceId, assignment);

    const snapshot = captureGameStateSnapshot({
      runtime: wiring.runtime,
      progressionCoordinator: wiring.coordinator,
      capturedAt: CAPTURE_TIME,
      getAutomationState: () => wiring.automationSystem?.getState() ?? new Map(),
      getTransformState: () => wiring.transformSystem?.getState() ?? new Map(),
      getEntityState: () => entitySystem.getState(),
      commandQueue: wiring.commandQueue,
      productionSystem: wiring.productionSystem,
    });

    const targetStep = savedStep + rebaseDelta;
    const restored = restoreGameRuntimeFromSnapshot({
      content,
      snapshot,
      runtimeOptions: { initialStep: targetStep },
    });

    const restoredEntitySystem = restored.entitySystem;
    if (!restoredEntitySystem) {
      throw new Error('Expected entity system to be wired.');
    }

    const [restoredInstance] =
      restoredEntitySystem.getInstancesForEntity('entity.scout');
    if (!restoredInstance?.assignment) {
      throw new Error('Expected entity assignment to be restored.');
    }

    expect(restored.runtime.getCurrentStep()).toBe(targetStep);
    expect(restoredInstance.assignment).toEqual({
      missionId: assignment.missionId,
      batchId: assignment.batchId,
      deployedAtStep: assignment.deployedAtStep + rebaseDelta,
      returnStep: assignment.returnStep + rebaseDelta,
    });
    expect(
      restoredEntitySystem.getEntityState('entity.scout')?.availableCount,
    ).toBe(0);
  });
});

describe('restorePartial', () => {
  it('applies resource and command queue updates for full restores', () => {
    const resources = {
      ids: ['resource.energy'],
      amounts: [15],
      capacities: [null],
      unlocked: [true],
      visible: [true],
      flags: [0],
    };

    const commandQueue: SerializedCommandQueueV1 = {
      schemaVersion: 1,
      entries: [
        {
          type: 'command.test',
          priority: CommandPriority.PLAYER,
          timestamp: 55,
          step: 5,
          payload: { amount: 2 },
        },
      ],
    };

    const snapshot: GameStateSnapshot = {
      version: 1,
      capturedAt: 0,
      runtime: {
        step: 5,
        stepSizeMs: STEP_SIZE_MS,
        rngSeed: undefined,
      },
      resources,
      progression: {
        schemaVersion: 2,
        step: 5,
        resources,
        generators: [],
        upgrades: [],
        achievements: [],
      },
      automation: [],
      transforms: [],
      entities: { entities: [], instances: [], entityInstances: [] },
      commandQueue,
    };

    const resourceDefinitions: ResourceDefinition[] = [
      {
        id: 'resource.energy',
        startAmount: 0,
        capacity: null,
        unlocked: false,
        visible: false,
      },
    ];

    const resourceState = createResourceState(resourceDefinitions);
    const commandQueueInstance = new CommandQueue();

    restorePartial(snapshot, 'full', {
      resources: resourceState,
      commandQueue: commandQueueInstance,
    });

    const index = resourceState.requireIndex('resource.energy');
    expect(resourceState.getAmount(index)).toBe(15);
    expect(resourceState.isUnlocked(index)).toBe(true);
    expect(resourceState.isVisible(index)).toBe(true);
    expect(commandQueueInstance.exportForSave()).toEqual(commandQueue);
  });

  it('rebases command steps when configured', () => {
    const resources = {
      ids: ['resource.energy'],
      amounts: [0],
      capacities: [null],
      flags: [0],
    };

    const commandQueue: SerializedCommandQueueV1 = {
      schemaVersion: 1,
      entries: [
        {
          type: 'command.test',
          priority: CommandPriority.PLAYER,
          timestamp: 55,
          step: 10,
          payload: { amount: 2 },
        },
      ],
    };

    const snapshot: GameStateSnapshot = {
      version: 1,
      capturedAt: 0,
      runtime: {
        step: 10,
        stepSizeMs: STEP_SIZE_MS,
        rngSeed: undefined,
      },
      resources,
      progression: {
        schemaVersion: 2,
        step: 10,
        resources,
        generators: [],
        upgrades: [],
        achievements: [],
      },
      automation: [],
      transforms: [],
      entities: { entities: [], instances: [], entityInstances: [] },
      commandQueue,
    };

    const commandQueueInstance = new CommandQueue();

    restorePartial(
      snapshot,
      'commands',
      { commandQueue: commandQueueInstance },
      { rebaseCommands: { savedStep: 10, currentStep: 4 } },
    );

    const restored = commandQueueInstance.exportForSave();
    expect(restored.entries).toHaveLength(1);
    expect(restored.entries[0]?.step).toBe(4);
  });

  it('throws when resource arrays are malformed', () => {
    const resources = {
      ids: ['resource.energy'],
      amounts: [],
      capacities: [null],
      unlocked: [true],
      visible: [true],
      flags: [0],
    };

    const snapshot: GameStateSnapshot = {
      version: 1,
      capturedAt: 0,
      runtime: {
        step: 0,
        stepSizeMs: STEP_SIZE_MS,
        rngSeed: undefined,
      },
      resources,
      progression: {
        schemaVersion: 2,
        step: 0,
        resources,
        generators: [],
        upgrades: [],
        achievements: [],
      },
      automation: [],
      transforms: [],
      entities: { entities: [], instances: [], entityInstances: [] },
      commandQueue: {
        schemaVersion: 1,
        entries: [],
      },
    };

    const resourceDefinitions: ResourceDefinition[] = [
      {
        id: 'resource.energy',
        startAmount: 0,
        capacity: null,
        unlocked: false,
        visible: false,
      },
    ];

    const resourceState = createResourceState(resourceDefinitions);

    expect(() =>
      restorePartial(snapshot, 'resources', { resources: resourceState }),
    ).toThrow('amounts');
  });
});
