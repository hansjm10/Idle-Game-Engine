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
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
} from '../content-test-helpers.js';
import {
  captureGameStateSnapshot,
  CommandQueue,
  createResourceState,
  IdleEngineRuntime,
  restoreFromSnapshot,
  restorePartial,
} from '../index.js';
import { createProductionSystem } from '../production-system.js';
import { createProgressionCoordinator } from '../progression-coordinator.js';
import { hydrateProgressionCoordinatorState } from '../progression-coordinator-save.js';
import { getCurrentRNGSeed, resetRNG, setRNGSeed } from '../rng.js';
import type { ResourceDefinition } from '../resource-state.js';
import { createTransformSystem } from '../transform-system.js';
import type { GameStateSnapshot } from './types.js';

const STEP_SIZE_MS = 100;
const INITIAL_STEP = 12;
const CAPTURE_TIME = 1_700_000_123;

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
          baseCost: 10,
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
          baseCost: 100,
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
      commandQueue,
      productionSystem,
    });

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
      commandQueue: restored.commandQueue,
      productionSystem: restoredProductionSystem,
    });

    expect(roundTrip).toEqual(snapshot);
    expect(getCurrentRNGSeed()).toBe(snapshot.runtime.rngSeed);
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
});
