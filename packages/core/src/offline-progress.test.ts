import { describe, expect, it, vi } from 'vitest';

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
  resolveMaxTicksPerCall,
  resolveOfflineProgressTotals,
} from './offline-progress-limits.js';
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

  it('reports progress and respects maxTicksPerCall limits', () => {
    const harness = createHarness(0);
    const progressSpy = vi.fn();

    const result = applyOfflineProgress({
      elapsedMs: STEP_SIZE_MS * 5,
      coordinator: harness.coordinator,
      runtime: harness.runtime,
      limits: { maxTicksPerCall: 2 },
      onProgress: progressSpy,
    });

    expect(progressSpy).toHaveBeenCalledTimes(2);
    const lastProgress = progressSpy.mock.calls[
      progressSpy.mock.calls.length - 1
    ]?.[0];
    expect(lastProgress).toEqual({
      processedMs: STEP_SIZE_MS * 2,
      totalMs: STEP_SIZE_MS * 5,
      processedSteps: 2,
      totalSteps: 5,
      remainingMs: STEP_SIZE_MS * 3,
      remainingSteps: 3,
    });
    expect(result).toMatchObject({
      processedSteps: 2,
      totalSteps: 5,
      remainingSteps: 3,
      completed: false,
    });
  });

  it('reports progress for remainder elapsed time', () => {
    const harness = createHarness(0);
    const progressSpy = vi.fn();
    const elapsedMs = STEP_SIZE_MS * 2 + 50;

    const result = applyOfflineProgress({
      elapsedMs,
      coordinator: harness.coordinator,
      runtime: harness.runtime,
      onProgress: progressSpy,
    });

    expect(progressSpy).toHaveBeenCalledTimes(3);
    const lastProgress =
      progressSpy.mock.calls[progressSpy.mock.calls.length - 1]?.[0];
    expect(lastProgress).toEqual({
      processedMs: elapsedMs,
      totalMs: elapsedMs,
      processedSteps: 2,
      totalSteps: 2,
      remainingMs: 0,
      remainingSteps: 0,
    });
    expect(result).toMatchObject({
      processedMs: elapsedMs,
      totalMs: elapsedMs,
      processedSteps: 2,
      totalSteps: 2,
      remainingMs: 0,
      remainingSteps: 0,
      completed: true,
    });
  });

  it('caps elapsedMs while preserving remainder below the step cap', () => {
    const harness = createHarness(0);

    const result = applyOfflineProgress({
      elapsedMs: STEP_SIZE_MS * 3 + 50,
      coordinator: harness.coordinator,
      runtime: harness.runtime,
      limits: { maxElapsedMs: STEP_SIZE_MS * 2 + 50 },
    });

    expect(result).toMatchObject({
      totalSteps: 2,
      totalMs: STEP_SIZE_MS * 2 + 50,
      processedSteps: 2,
      processedMs: STEP_SIZE_MS * 2 + 50,
      remainingMs: 0,
      completed: true,
    });
    expect(harness.runtime.getCurrentStep()).toBe(2);
  });

  it('caps steps and drops remainder beyond the step cap', () => {
    const harness = createHarness(0);

    const result = applyOfflineProgress({
      elapsedMs: STEP_SIZE_MS * 3 + 50,
      coordinator: harness.coordinator,
      runtime: harness.runtime,
      limits: { maxSteps: 1 },
    });

    expect(result).toMatchObject({
      totalSteps: 1,
      totalMs: STEP_SIZE_MS,
      processedSteps: 1,
      processedMs: STEP_SIZE_MS,
      remainingMs: 0,
      completed: true,
    });
    expect(harness.runtime.getCurrentStep()).toBe(1);
  });

  it('applies maxElapsedMs before maxSteps and drops remainder when maxSteps truncates', () => {
    const harness = createHarness(0);
    const elapsedMs = STEP_SIZE_MS * 6 + 50;

    const result = applyOfflineProgress({
      elapsedMs,
      coordinator: harness.coordinator,
      runtime: harness.runtime,
      limits: {
        maxElapsedMs: STEP_SIZE_MS * 3 + 50,
        maxSteps: 2,
      },
    });

    expect(result).toMatchObject({
      totalSteps: 2,
      totalMs: STEP_SIZE_MS * 2,
      processedSteps: 2,
      processedMs: STEP_SIZE_MS * 2,
      remainingMs: 0,
      completed: true,
    });
    expect(harness.runtime.getCurrentStep()).toBe(2);
  });

  it('ignores invalid maxElapsedMs values when resolving totals', () => {
    const elapsedMs = STEP_SIZE_MS * 5 + 50;
    const baseline = resolveOfflineProgressTotals(elapsedMs, STEP_SIZE_MS);
    const invalidValues = [
      -1,
      -100,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const value of invalidValues) {
      const limits = { maxElapsedMs: value };
      const totals = resolveOfflineProgressTotals(
        elapsedMs,
        STEP_SIZE_MS,
        limits,
      );

      expect(totals).toEqual(baseline);
      if (Number.isNaN(value)) {
        expect(Number.isNaN(limits.maxElapsedMs)).toBe(true);
      } else {
        expect(limits.maxElapsedMs).toBe(value);
      }
    }
  });

  it('ignores invalid maxSteps values when resolving totals', () => {
    const elapsedMs = STEP_SIZE_MS * 5 + 50;
    const baseline = resolveOfflineProgressTotals(elapsedMs, STEP_SIZE_MS);
    const invalidValues = [
      -1,
      -100,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const value of invalidValues) {
      const limits = { maxSteps: value };
      const totals = resolveOfflineProgressTotals(
        elapsedMs,
        STEP_SIZE_MS,
        limits,
      );

      expect(totals).toEqual(baseline);
      if (Number.isNaN(value)) {
        expect(Number.isNaN(limits.maxSteps)).toBe(true);
      } else {
        expect(limits.maxSteps).toBe(value);
      }
    }
  });

  it('ignores invalid maxTicksPerCall values when resolving max ticks', () => {
    const invalidValues = [
      -1,
      -100,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ];

    for (const value of invalidValues) {
      const limits = { maxTicksPerCall: value };
      expect(resolveMaxTicksPerCall(limits)).toBeUndefined();
      if (Number.isNaN(value)) {
        expect(Number.isNaN(limits.maxTicksPerCall)).toBe(true);
      } else {
        expect(limits.maxTicksPerCall).toBe(value);
      }
    }
  });

  it('matches uninterrupted outcomes when chunked across calls', () => {
    const baseline = createHarness(0);
    baseline.coordinator.incrementGeneratorOwned('generator.mine', 1);
    baseline.coordinator.setUpgradePurchases('upgrade.double-mine', 1);
    baseline.coordinator.updateForStep(baseline.runtime.getCurrentStep());

    applyFrameDeltas(baseline.runtime, baseline.coordinator, [
      STEP_SIZE_MS,
      STEP_SIZE_MS,
      STEP_SIZE_MS,
    ]);

    const saved = serializeProgressionCoordinatorState(
      baseline.coordinator,
      baseline.productionSystem,
    );

    const offlineElapsedMs = STEP_SIZE_MS * 45 + 34;

    const uninterrupted = createHarness(saved.step);
    hydrateProgressionCoordinatorState(
      saved,
      uninterrupted.coordinator,
      uninterrupted.productionSystem,
    );

    applyOfflineProgress({
      elapsedMs: offlineElapsedMs,
      coordinator: uninterrupted.coordinator,
      runtime: uninterrupted.runtime,
    });

    const chunked = createHarness(saved.step);
    hydrateProgressionCoordinatorState(
      saved,
      chunked.coordinator,
      chunked.productionSystem,
    );

    let remainingMs = offlineElapsedMs;
    let result = applyOfflineProgress({
      elapsedMs: remainingMs,
      coordinator: chunked.coordinator,
      runtime: chunked.runtime,
      limits: { maxTicksPerCall: 7 },
    });
    remainingMs = result.remainingMs;

    let guard = 0;
    while (!result.completed && guard < 20) {
      result = applyOfflineProgress({
        elapsedMs: remainingMs,
        coordinator: chunked.coordinator,
        runtime: chunked.runtime,
        limits: { maxTicksPerCall: 7 },
      });
      remainingMs = result.remainingMs;
      guard += 1;
    }

    expect(result.completed).toBe(true);
    expect(chunked.runtime.getCurrentStep()).toBe(
      uninterrupted.runtime.getCurrentStep(),
    );
    expect(chunked.coordinator.resourceState.exportForSave()).toEqual(
      uninterrupted.coordinator.resourceState.exportForSave(),
    );
    expect(chunked.productionSystem.exportAccumulators()).toEqual(
      uninterrupted.productionSystem.exportAccumulators(),
    );
  });
});
