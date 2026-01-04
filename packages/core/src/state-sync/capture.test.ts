import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AutomationDefinition,
  NumericFormula,
  TransformDefinition,
} from '@idle-engine/content-schema';

import { createAutomationSystem, serializeAutomationState } from '../automation-system.js';
import { createResourceStateAdapter } from '../automation-resource-state-adapter.js';
import { CommandPriority, RUNTIME_COMMAND_TYPES } from '../command.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
} from '../content-test-helpers.js';
import { captureGameStateSnapshot, IdleEngineRuntime } from '../index.js';
import { createProductionSystem } from '../production-system.js';
import { createProgressionCoordinator } from '../progression-coordinator.js';
import { serializeProgressionCoordinatorState } from '../progression-coordinator-save.js';
import { resetRNG, setRNGSeed } from '../rng.js';
import { createTransformSystem, serializeTransformState } from '../transform-system.js';
import type { EntitySystemState } from '../entity-system.js';

const STEP_SIZE_MS = 100;
const INITIAL_STEP = 12;
const FIXED_NOW = 1_700_000_000;
const OVERRIDE_NOW = 1_700_000_123;

const literal = (value: number): NumericFormula => ({
  kind: 'constant',
  value,
});

const createEmptyEntityState = (): EntitySystemState => ({
  entities: new Map(),
  instances: new Map(),
  entityInstances: new Map(),
});

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

describe('captureGameStateSnapshot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetRNG();
  });

  it('captures all state components into a unified snapshot with capturedAt override', () => {
    vi.spyOn(Date, 'now').mockReturnValue(FIXED_NOW);
    setRNGSeed(4242);

    const content = createTestContent();
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: STEP_SIZE_MS,
    });
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

    const automationState = automationSystem.getState();
    const transformState = transformSystem.getState();

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
      capturedAt: OVERRIDE_NOW,
      getAutomationState: () => automationState,
      getTransformState: () => transformState,
      getEntityState: createEmptyEntityState,
      commandQueue,
      productionSystem,
    });

    const expectedResources = coordinator.resourceState.exportForSave();
    const expectedProgression = serializeProgressionCoordinatorState(
      coordinator,
      productionSystem,
    );
    const expectedAutomation = serializeAutomationState(automationState);
    const expectedTransforms = serializeTransformState(transformState);
    const expectedEntities = { entities: [], instances: [], entityInstances: [] };
    const expectedCommandQueue = commandQueue.exportForSave();

    expect(snapshot).toEqual({
      version: 1,
      capturedAt: OVERRIDE_NOW,
      runtime: {
        step: INITIAL_STEP,
        stepSizeMs: STEP_SIZE_MS,
        rngSeed: 4242,
        rngState: 4242,
      },
      resources: expectedResources,
      progression: expectedProgression,
      automation: expectedAutomation,
      transforms: expectedTransforms,
      entities: expectedEntities,
      commandQueue: expectedCommandQueue,
    });

    expect(expectedAutomation.length).toBeGreaterThan(0);
    expect(expectedTransforms.length).toBeGreaterThan(0);
    expect(snapshot.resources.automationState).toBeUndefined();
    expect(snapshot.resources.transformState).toBeUndefined();
  });
});
