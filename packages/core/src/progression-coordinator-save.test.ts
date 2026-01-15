import { describe, expect, it } from 'vitest';

import type { NumericFormula } from '@idle-engine/content-schema';

import { IdleEngineRuntime } from './index.js';
import { createProductionSystem } from './production-system.js';
import { createProgressionCoordinator } from './progression-coordinator.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
} from './content-test-helpers.js';
import {
  hydrateProgressionCoordinatorState,
  serializeProgressionCoordinatorState,
} from './progression-coordinator-save.js';

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

  return { coordinator, runtime, productionSystem };
}

function tick(runtime: IdleEngineRuntime, stepMs: number) {
  runtime.tick(stepMs);
}

function advanceSteps(
  runtime: IdleEngineRuntime,
  coordinator: ReturnType<typeof createProgressionCoordinator>,
  steps: number,
) {
  for (let i = 0; i < steps; i += 1) {
    const before = runtime.getCurrentStep();
    tick(runtime, STEP_SIZE_MS);
    const after = runtime.getCurrentStep();
    if (after !== before) {
      coordinator.updateForStep(after);
    }
  }
}

describe('progression-coordinator-save', () => {
  it('roundtrips resources, generators, upgrades, step, and production accumulators', () => {
    const { coordinator, runtime, productionSystem } = createHarness(0);

    coordinator.incrementGeneratorOwned('generator.mine', 1);
    advanceSteps(runtime, coordinator, 2);

    coordinator.setGeneratorEnabled('generator.mine', false);
    coordinator.setUpgradePurchases('upgrade.double-mine', 1);

    const saved = serializeProgressionCoordinatorState(
      coordinator,
      productionSystem,
    );

    const restored = createHarness(saved.step);
    hydrateProgressionCoordinatorState(
      saved,
      restored.coordinator,
      restored.productionSystem,
    );

    expect(
      serializeProgressionCoordinatorState(
        restored.coordinator,
        restored.productionSystem,
      ),
    ).toEqual(saved);
    expect(restored.runtime.getCurrentStep()).toBe(saved.step);
  });

  it('ignores serialized generator entries with blank ids', () => {
    const { coordinator, productionSystem } = createHarness(0);
    coordinator.incrementGeneratorOwned('generator.mine', 3);

    const saved = serializeProgressionCoordinatorState(
      coordinator,
      productionSystem,
    );

    const corrupted = {
      ...saved,
      generators: [
        {
          id: ' ',
          owned: 99,
          enabled: false,
          isUnlocked: true,
          nextPurchaseReadyAtStep: 10,
        },
      ],
    };

    const restored = createHarness(corrupted.step);
    hydrateProgressionCoordinatorState(
      corrupted,
      restored.coordinator,
      restored.productionSystem,
    );

    const owned = restored.coordinator.state.generators?.find(
      (generator) => generator.id === 'generator.mine',
    )?.owned;
    expect(owned).toBe(0);
  });
});
