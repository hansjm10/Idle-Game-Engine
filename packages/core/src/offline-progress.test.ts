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
import { applyOfflineProgress } from './offline-progress.js';
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

function applyFrameDeltas(
  runtime: IdleEngineRuntime,
  coordinator: ReturnType<typeof createProgressionCoordinator>,
  deltas: readonly number[],
) {
  for (const deltaMs of deltas) {
    const before = runtime.getCurrentStep();
    runtime.tick(deltaMs);
    const after = runtime.getCurrentStep();
    if (after !== before) {
      coordinator.updateForStep(after);
    }
  }
}

describe('applyOfflineProgress', () => {
  it('matches online fixed-step outcomes after save/load', () => {
    const harness = createHarness(0);
    harness.coordinator.incrementGeneratorOwned('generator.mine', 1);
    harness.coordinator.setUpgradePurchases('upgrade.double-mine', 1);
    harness.coordinator.updateForStep(harness.runtime.getCurrentStep());

    // Run 3 steps online to ensure production accumulators + resources are non-trivial.
    applyFrameDeltas(harness.runtime, harness.coordinator, [
      STEP_SIZE_MS,
      STEP_SIZE_MS,
      STEP_SIZE_MS,
    ]);

    const saved = serializeProgressionCoordinatorState(
      harness.coordinator,
      harness.productionSystem,
    );

    const offlineElapsedMs = 1234;

    // Baseline: simulate online frame cadence.
    const frameDeltas = [
      ...Array.from({ length: 77 }, () => 16),
      2,
    ];
    applyFrameDeltas(
      harness.runtime,
      harness.coordinator,
      frameDeltas,
    );

    const restored = createHarness(saved.step);
    hydrateProgressionCoordinatorState(
      saved,
      restored.coordinator,
      restored.productionSystem,
    );

    applyOfflineProgress({
      elapsedMs: offlineElapsedMs,
      coordinator: restored.coordinator,
      runtime: restored.runtime,
    });

    expect(restored.runtime.getCurrentStep()).toBe(
      harness.runtime.getCurrentStep(),
    );
    expect(restored.coordinator.resourceState.exportForSave()).toEqual(
      harness.coordinator.resourceState.exportForSave(),
    );
    expect(restored.productionSystem.exportAccumulators()).toEqual(
      harness.productionSystem.exportAccumulators(),
    );
  });

  it('applies resource deltas before ticking and clamps negative deltas to available amounts', () => {
    const harness = createHarness(0);
    const state = harness.coordinator.resourceState;
    const energyIndex = state.requireIndex('resource.energy');
    const goldIndex = state.requireIndex('resource.gold');

    applyOfflineProgress({
      elapsedMs: 0,
      coordinator: harness.coordinator,
      runtime: harness.runtime,
      resourceDeltas: {
        'resource.gold': 5,
        'resource.energy': -2000,
        'resource.unknown': 10,
      },
    });

    expect(state.getAmount(goldIndex)).toBe(5);
    expect(state.getAmount(energyIndex)).toBe(0);
  });
});
