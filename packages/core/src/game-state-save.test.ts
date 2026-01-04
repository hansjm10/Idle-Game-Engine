import { beforeEach, describe, expect, it } from 'vitest';

import type {
  AutomationDefinition,
  NumericFormula,
  TransformDefinition,
} from '@idle-engine/content-schema';

import { CommandPriority } from './command.js';
import { createAutomationSystem } from './automation-system.js';
import { createResourceStateAdapter } from './automation-resource-state-adapter.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
} from './content-test-helpers.js';
import {
  decodeGameStateSave,
  encodeGameStateSave,
  hydrateGameStateSaveFormat,
  loadGameStateSaveFormat,
  serializeGameStateSaveFormat,
  type SchemaMigration,
} from './game-state-save.js';
import { IdleEngineRuntime } from './index.js';
import { createProductionSystem } from './production-system.js';
import { createProgressionCoordinator } from './progression-coordinator.js';
import { PRDRegistry, getCurrentRNGSeed, resetRNG, setRNGSeed } from './rng.js';
import { createTransformSystem } from './transform-system.js';

const STEP_SIZE_MS = 100;

const literal = (value: number): NumericFormula => ({
  kind: 'constant',
  value,
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
        { resourceId: 'resource.gold' as any, amount: { kind: 'constant', value: 10 } },
      ],
      outputs: [
        { resourceId: 'resource.gems' as any, amount: { kind: 'constant', value: 1 } },
      ],
      cooldown: { kind: 'constant', value: 500 },
      trigger: { kind: 'manual' },
      tags: [],
    },
  ];
}

function createHarness(initialStep = 0) {
  const content = createTestContent();
  const coordinator = createProgressionCoordinator({
    content,
    stepDurationMs: STEP_SIZE_MS,
  });
  coordinator.updateForStep(initialStep);

  const runtime = new IdleEngineRuntime({
    stepSizeMs: STEP_SIZE_MS,
    initialStep,
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

  runtime.addSystem(productionSystem);

  const commandQueue = runtime.getCommandQueue();
  const resourceStateAdapter = createResourceStateAdapter(coordinator.resourceState);

  const automations = createTestAutomations();
  const automationSystem = createAutomationSystem({
    automations,
    stepDurationMs: STEP_SIZE_MS,
    commandQueue,
    resourceState: resourceStateAdapter,
    conditionContext: coordinator.getConditionContext(),
  });

  const transforms = createTestTransforms();
  const transformSystem = createTransformSystem({
    transforms,
    stepDurationMs: STEP_SIZE_MS,
    resourceState: resourceStateAdapter,
    conditionContext: coordinator.getConditionContext(),
  });

  return {
    runtime,
    coordinator,
    productionSystem,
    automationSystem,
    transformSystem,
    commandQueue,
  };
}

function createSerializedSave(savedAt = 0) {
  const harness = createHarness(0);
  return serializeGameStateSaveFormat({
    runtimeStep: 0,
    savedAt,
    coordinator: harness.coordinator,
    productionSystem: harness.productionSystem,
    automationState: harness.automationSystem.getState(),
    transformState: harness.transformSystem.getState(),
    commandQueue: harness.commandQueue,
  });
}

function advanceSteps(
  runtime: IdleEngineRuntime,
  coordinator: ReturnType<typeof createProgressionCoordinator>,
  steps: number,
) {
  for (let i = 0; i < steps; i += 1) {
    const before = runtime.getCurrentStep();
    runtime.tick(STEP_SIZE_MS);
    const after = runtime.getCurrentStep();
    if (after !== before) {
      coordinator.updateForStep(after);
    }
  }
}

beforeEach(() => {
  resetRNG();
});

describe('game-state-save', () => {
  it('roundtrips a complete save format', () => {
    const harness = createHarness(0);
    setRNGSeed(123_456);

    harness.coordinator.incrementGeneratorOwned('generator.mine', 1);
    advanceSteps(harness.runtime, harness.coordinator, 2);
    harness.coordinator.setGeneratorEnabled('generator.mine', false);
    harness.coordinator.setUpgradePurchases('upgrade.double-mine', 1);

    const runtimeStep = harness.runtime.getCurrentStep();

    harness.automationSystem.restoreState(
      [
        {
          id: 'auto:collector',
          enabled: false,
          lastFiredStep: runtimeStep - 1,
          cooldownExpiresStep: runtimeStep + 3,
          unlocked: true,
          lastThresholdSatisfied: false,
        },
      ],
      { savedWorkerStep: runtimeStep, currentStep: runtimeStep },
    );

    harness.transformSystem.restoreState(
      [
        {
          id: 'transform:convert',
          unlocked: true,
          cooldownExpiresStep: runtimeStep + 5,
        },
      ],
      { savedWorkerStep: runtimeStep, currentStep: runtimeStep },
    );

    harness.commandQueue.enqueue({
      type: 'test:noop',
      payload: { message: 'hello' },
      priority: CommandPriority.PLAYER,
      timestamp: 1000,
      step: harness.runtime.getNextExecutableStep(),
    });

    harness.commandQueue.enqueue({
      type: 'test:noop2',
      payload: [1, 2, 3],
      priority: CommandPriority.AUTOMATION,
      timestamp: 1001,
      step: harness.runtime.getNextExecutableStep(),
    });

    const savedAt = 42;
    const save = serializeGameStateSaveFormat({
      runtimeStep,
      savedAt,
      coordinator: harness.coordinator,
      productionSystem: harness.productionSystem,
      automationState: harness.automationSystem.getState(),
      transformState: harness.transformSystem.getState(),
      commandQueue: harness.commandQueue,
    });

    const restored = createHarness(save.runtime.step);
    setRNGSeed(999);
    expect(getCurrentRNGSeed()).toBe(999);

    hydrateGameStateSaveFormat({
      save,
      coordinator: restored.coordinator,
      productionSystem: restored.productionSystem,
      automationSystem: restored.automationSystem,
      transformSystem: restored.transformSystem,
      commandQueue: restored.commandQueue,
    });

    expect(getCurrentRNGSeed()).toBe(save.runtime.rngSeed);

    const roundTripped = serializeGameStateSaveFormat({
      runtimeStep: restored.runtime.getCurrentStep(),
      savedAt,
      coordinator: restored.coordinator,
      productionSystem: restored.productionSystem,
      automationState: restored.automationSystem.getState(),
      transformState: restored.transformSystem.getState(),
      commandQueue: restored.commandQueue,
    });

    expect(roundTripped).toEqual(save);
  });

  it('roundtrips PRD registry state when provided', () => {
    const harness = createHarness(0);
    const prdRegistry = new PRDRegistry();
    setRNGSeed(1);

    const prd = prdRegistry.getOrCreate('mission.alpha', 0);
    prd.roll();
    prd.roll();

    const save = serializeGameStateSaveFormat({
      runtimeStep: harness.runtime.getCurrentStep(),
      savedAt: 123,
      coordinator: harness.coordinator,
      prdRegistry,
      commandQueue: harness.commandQueue,
    });

    const restored = createHarness(save.runtime.step);
    const restoredRegistry = new PRDRegistry();

    hydrateGameStateSaveFormat({
      save,
      coordinator: restored.coordinator,
      commandQueue: restored.commandQueue,
      prdRegistry: restoredRegistry,
    });

    expect(save.prd).toBeDefined();
    expect(restoredRegistry.captureState()).toEqual(save.prd);
  });

  it('loads legacy v0 saves via migration', () => {
    const harness = createHarness(0);
    setRNGSeed(123);

    const runtimeStep = harness.runtime.getCurrentStep();
    harness.automationSystem.restoreState(
      [
        {
          id: 'auto:collector',
          enabled: true,
          lastFiredStep: runtimeStep,
          cooldownExpiresStep: runtimeStep,
          unlocked: true,
          lastThresholdSatisfied: true,
        },
      ],
      { savedWorkerStep: runtimeStep, currentStep: runtimeStep },
    );

    const save = serializeGameStateSaveFormat({
      runtimeStep,
      savedAt: 1,
      coordinator: harness.coordinator,
      productionSystem: harness.productionSystem,
      automationState: harness.automationSystem.getState(),
      commandQueue: harness.commandQueue,
    });

    const legacy = {
      savedAt: save.savedAt,
      resources: {
        ...save.resources,
        automationState: save.automation,
      },
      progression: save.progression,
      transforms: save.transforms,
      commandQueue: save.commandQueue,
      runtime: save.runtime,
    };

    const migrated = loadGameStateSaveFormat(legacy);
    expect(migrated).toEqual(save);
  });

  it('supports optional gzip compression', async () => {
    const resourceCount = 5000;
    const ids = Array.from({ length: resourceCount }, (_, index) => `resource.${index}`);
    const amounts = Array.from({ length: resourceCount }, () => 0);
    const capacities = Array.from({ length: resourceCount }, () => null);
    const flags = Array.from({ length: resourceCount }, () => 0);

    const save = {
      version: 1,
      savedAt: 0,
      resources: { ids, amounts, capacities, flags },
      progression: {
        schemaVersion: 2,
        step: 0,
        resources: { ids, amounts, capacities, flags },
        generators: [],
        upgrades: [],
        achievements: [],
      },
      automation: [],
      transforms: [],
      entities: { entities: [], instances: [], entityInstances: [] },
      commandQueue: { schemaVersion: 1, entries: [] },
      runtime: { step: 0, rngSeed: 1 },
    } as const;

    const uncompressed = await encodeGameStateSave(save, {
      compression: 'none',
    });
    const compressed = await encodeGameStateSave(save, {
      compression: 'gzip',
    });

    expect(compressed.length).toBeLessThan(uncompressed.length);

    const decoded = await decodeGameStateSave(compressed);
    expect(decoded.runtime.step).toBe(0);
    expect(decoded.resources.ids.length).toBe(resourceCount);
  });

  it('rejects unsupported compression headers when decoding', async () => {
    const payload = new TextEncoder().encode(JSON.stringify({}));
    const encoded = new Uint8Array(payload.length + 1);
    encoded[0] = 9;
    encoded.set(payload, 1);

    await expect(decodeGameStateSave(encoded)).rejects.toThrow(
      /Unsupported save compression header/,
    );
  });

  it('rejects saves with invalid timestamps', () => {
    const save = createSerializedSave(5);

    expect(() => loadGameStateSaveFormat({ ...save, savedAt: -1 })).toThrow(
      'Save data has an invalid savedAt timestamp.',
    );
  });

  it('requires core save fields when loading', () => {
    const save = createSerializedSave(5);
    const { resources: _resources, ...missingResources } = save as any;
    const { progression: _progression, ...missingProgression } = save as any;
    const { commandQueue: _commandQueue, ...missingCommandQueue } = save as any;

    expect(() => loadGameStateSaveFormat(missingResources)).toThrow(
      'Save data is missing resources.',
    );
    expect(() => loadGameStateSaveFormat(missingProgression)).toThrow(
      'Save data is missing progression state.',
    );
    expect(() => loadGameStateSaveFormat(missingCommandQueue)).toThrow(
      'Save data is missing command queue state.',
    );
  });

  it('rejects saves without a detectable version', () => {
    expect(() => loadGameStateSaveFormat({})).toThrow(
      'Unable to determine game state save version.',
    );
  });

  it('rejects saves without a migration path', () => {
    const save = createSerializedSave(0);
    const unsupported = { ...save, version: 2 };

    expect(() =>
      loadGameStateSaveFormat(unsupported, {
        migrations: [],
      }),
    ).toThrow(/No migration path/);
  });

  it('rejects migrations that do not update the save version', () => {
    const save = createSerializedSave(0);
    const migrations: SchemaMigration[] = [
      {
        fromVersion: 1,
        toVersion: 2,
        migrate: (value) => value,
      },
    ];

    expect(() =>
      loadGameStateSaveFormat(save, {
        targetVersion: 2,
        migrations,
      }),
    ).toThrow(/did not set the expected version/);
  });

  it('rejects empty or non-Uint8Array save payloads', async () => {
    await expect(decodeGameStateSave(new Uint8Array())).rejects.toThrow(
      'Encoded save must be a non-empty Uint8Array.',
    );

    await expect(
      decodeGameStateSave('invalid' as unknown as Uint8Array),
    ).rejects.toThrow('Encoded save must be a non-empty Uint8Array.');
  });

  it('skips rng seed application when disabled', () => {
    setRNGSeed(4242);
    const save = createSerializedSave(0);

    setRNGSeed(777);
    const coordinator = createProgressionCoordinator({
      content: createTestContent(),
      stepDurationMs: STEP_SIZE_MS,
    });

    hydrateGameStateSaveFormat({
      save,
      coordinator,
      applyRngSeed: false,
    });

    expect(getCurrentRNGSeed()).toBe(777);
  });
});
