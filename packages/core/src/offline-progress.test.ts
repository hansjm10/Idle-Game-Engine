import { describe, expect, it, vi } from 'vitest';

import type { NumericFormula } from '@idle-engine/content-schema';

import { IdleEngineRuntime } from './index.js';
import { createProductionSystem } from './production-system.js';
import type { SerializedProductionAccumulators } from './production-system.js';
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

function registerProgressionCoordinatorSystem(
  runtime: IdleEngineRuntime,
  coordinator: ReturnType<typeof createProgressionCoordinator>,
) {
  runtime.addSystem({
    id: 'progression-coordinator',
    tick: ({ step }) => {
      coordinator.updateForStep(step + 1);
    },
  });
}

function setupConstantRateHarness(
  harness: ReturnType<typeof createHarness>,
): void {
  harness.coordinator.incrementGeneratorOwned('generator.mine', 1);
  harness.coordinator.setUpgradePurchases('upgrade.double-mine', 1);
  harness.coordinator.updateForStep(harness.runtime.getCurrentStep());
}

function normalizeAccumulators(
  state: SerializedProductionAccumulators,
): SerializedProductionAccumulators {
  const epsilon = 1e-9;
  const round = (value: number): number =>
    Math.round(value / epsilon) * epsilon;
  const accumulators: Record<string, number> = {};
  for (const [key, value] of Object.entries(state.accumulators)) {
    const normalized = round(value);
    if (Math.abs(normalized) < epsilon) {
      continue;
    }
    accumulators[key] = normalized;
  }
  return { accumulators };
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

  it('batches ticks when the runtime advances the coordinator', () => {
    const baseline = createHarness(0);
    registerProgressionCoordinatorSystem(baseline.runtime, baseline.coordinator);
    baseline.coordinator.incrementGeneratorOwned('generator.mine', 1);
    baseline.coordinator.setUpgradePurchases('upgrade.double-mine', 1);
    baseline.coordinator.updateForStep(baseline.runtime.getCurrentStep());

    baseline.runtime.tick(STEP_SIZE_MS);
    baseline.runtime.tick(STEP_SIZE_MS);
    baseline.runtime.tick(STEP_SIZE_MS);

    const saved = serializeProgressionCoordinatorState(
      baseline.coordinator,
      baseline.productionSystem,
    );

    const offlineElapsedMs = STEP_SIZE_MS * 200 + 34;
    const fullSteps = Math.floor(offlineElapsedMs / STEP_SIZE_MS);

    const stepByStep = createHarness(saved.step);
    registerProgressionCoordinatorSystem(stepByStep.runtime, stepByStep.coordinator);
    hydrateProgressionCoordinatorState(
      saved,
      stepByStep.coordinator,
      stepByStep.productionSystem,
    );
    stepByStep.coordinator.updateForStep(stepByStep.runtime.getCurrentStep());

    for (let step = 0; step < fullSteps; step += 1) {
      stepByStep.runtime.tick(STEP_SIZE_MS);
    }
    stepByStep.runtime.tick(offlineElapsedMs - fullSteps * STEP_SIZE_MS);

    const batched = createHarness(saved.step);
    registerProgressionCoordinatorSystem(batched.runtime, batched.coordinator);
    hydrateProgressionCoordinatorState(
      saved,
      batched.coordinator,
      batched.productionSystem,
    );

    const tickSpy = vi.spyOn(batched.runtime, 'tick');

    applyOfflineProgress({
      elapsedMs: offlineElapsedMs,
      coordinator: batched.coordinator,
      runtime: batched.runtime,
    });

    expect(batched.runtime.getCurrentStep()).toBe(stepByStep.runtime.getCurrentStep());
    expect(batched.coordinator.resourceState.exportForSave()).toEqual(
      stepByStep.coordinator.resourceState.exportForSave(),
    );
    expect(batched.productionSystem.exportAccumulators()).toEqual(
      stepByStep.productionSystem.exportAccumulators(),
    );
    expect(tickSpy.mock.calls.length).toBeLessThan(fullSteps);
  });

  it('applies constant-rate fast path when preconditions are met', () => {
    const offlineElapsedMs = STEP_SIZE_MS * 15;
    const netRates = { 'resource.gold': 8 };

    const expected = createHarness(0);
    setupConstantRateHarness(expected);
    applyOfflineProgress({
      elapsedMs: offlineElapsedMs,
      coordinator: expected.coordinator,
      runtime: expected.runtime,
    });

    const fastPath = createHarness(0);
    setupConstantRateHarness(fastPath);
    const tickSpy = vi.spyOn(fastPath.runtime, 'tick');

    applyOfflineProgress({
      elapsedMs: offlineElapsedMs,
      coordinator: fastPath.coordinator,
      runtime: fastPath.runtime,
      fastPath: {
        mode: 'constant-rates',
        resourceNetRates: netRates,
        preconditions: {
          constantRates: true,
          noUnlocks: true,
          noAchievements: true,
          noAutomation: true,
          modeledResourceBounds: true,
        },
      },
    });

    expect(tickSpy).not.toHaveBeenCalled();
    expect(fastPath.runtime.getCurrentStep()).toBe(expected.runtime.getCurrentStep());
    expect(fastPath.coordinator.resourceState.exportForSave()).toEqual(
      expected.coordinator.resourceState.exportForSave(),
    );
    expect(
      normalizeAccumulators(fastPath.productionSystem.exportAccumulators()),
    ).toEqual(
      normalizeAccumulators(expected.productionSystem.exportAccumulators()),
    );
  });

  it('keeps production accumulators in sync when fast path uses production system', () => {
    const offlineElapsedMs = STEP_SIZE_MS * 14;
    const netRates = { 'resource.gold': 8 };

    const expected = createHarness(0);
    setupConstantRateHarness(expected);
    applyOfflineProgress({
      elapsedMs: offlineElapsedMs,
      coordinator: expected.coordinator,
      runtime: expected.runtime,
    });

    const fastPath = createHarness(0);
    setupConstantRateHarness(fastPath);
    const tickSpy = vi.spyOn(fastPath.runtime, 'tick');

    applyOfflineProgress({
      elapsedMs: offlineElapsedMs,
      coordinator: fastPath.coordinator,
      productionSystem: fastPath.productionSystem,
      runtime: fastPath.runtime,
      fastPath: {
        mode: 'constant-rates',
        resourceNetRates: netRates,
        preconditions: {
          constantRates: true,
          noUnlocks: true,
          noAchievements: true,
          noAutomation: true,
          modeledResourceBounds: true,
        },
      },
    });

    expect(tickSpy).not.toHaveBeenCalled();
    expect(fastPath.runtime.getCurrentStep()).toBe(expected.runtime.getCurrentStep());
    expect(fastPath.coordinator.resourceState.exportForSave()).toEqual(
      expected.coordinator.resourceState.exportForSave(),
    );
    expect(
      normalizeAccumulators(fastPath.productionSystem.exportAccumulators()),
    ).toEqual(
      normalizeAccumulators(expected.productionSystem.exportAccumulators()),
    );
  });

  it('falls back to tick path when fast path preconditions are not satisfied', () => {
    const offlineElapsedMs = STEP_SIZE_MS * 15;
    const netRates = { 'resource.gold': 8 };

    const expected = createHarness(0);
    setupConstantRateHarness(expected);
    applyOfflineProgress({
      elapsedMs: offlineElapsedMs,
      coordinator: expected.coordinator,
      runtime: expected.runtime,
    });

    const fallback = createHarness(0);
    setupConstantRateHarness(fallback);
    const tickSpy = vi.spyOn(fallback.runtime, 'tick');

    applyOfflineProgress({
      elapsedMs: offlineElapsedMs,
      coordinator: fallback.coordinator,
      runtime: fallback.runtime,
      fastPath: {
        mode: 'constant-rates',
        resourceNetRates: netRates,
        preconditions: {
          constantRates: true,
          noUnlocks: true,
          noAchievements: true,
          noAutomation: false,
          modeledResourceBounds: true,
        },
      },
    });

    expect(tickSpy).toHaveBeenCalled();
    expect(fallback.runtime.getCurrentStep()).toBe(expected.runtime.getCurrentStep());
    expect(fallback.coordinator.resourceState.exportForSave()).toEqual(
      expected.coordinator.resourceState.exportForSave(),
    );
    expect(
      normalizeAccumulators(fallback.productionSystem.exportAccumulators()),
    ).toEqual(
      normalizeAccumulators(expected.productionSystem.exportAccumulators()),
    );
  });

  it('throws when fast path is invalid and onInvalid is error', () => {
    const offlineElapsedMs = STEP_SIZE_MS * 5;
    const harness = createHarness(0);
    setupConstantRateHarness(harness);

    expect(() =>
      applyOfflineProgress({
        elapsedMs: offlineElapsedMs,
        coordinator: harness.coordinator,
        runtime: harness.runtime,
        fastPath: {
          mode: 'constant-rates',
          resourceNetRates: { 'resource.gold': 8 },
          preconditions: {
            constantRates: true,
            noUnlocks: true,
            noAchievements: true,
            noAutomation: false,
            modeledResourceBounds: true,
          },
          onInvalid: 'error',
        },
      }),
    ).toThrowError('Offline progress fast path preconditions are not satisfied.');
  });
});
