import { describe, expect, it } from 'vitest';

import type { NumericFormula } from '@idle-engine/content-schema';

import { IdleEngineRuntime } from './index.js';
import { createProductionSystem } from './production-system.js';
import { createProgressionCoordinator } from './progression-coordinator.js';
import {
  createContentPack,
  createAchievementDefinition,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
} from './content-test-helpers.js';
import {
  hydrateProgressionCoordinatorState,
  serializeProgressionCoordinatorState,
} from './progression-coordinator-save.js';
import type { SerializedProgressionCoordinatorStateV1 } from './progression-coordinator-save.js';

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
    achievements: [
      createAchievementDefinition('achievement.energy-1'),
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
  it('does nothing when hydrate is called with undefined', () => {
    const { coordinator, productionSystem } = createHarness(0);
    coordinator.incrementGeneratorOwned('generator.mine', 1);

    const before = serializeProgressionCoordinatorState(coordinator, productionSystem);

    hydrateProgressionCoordinatorState(undefined, coordinator, productionSystem);

    expect(
      serializeProgressionCoordinatorState(coordinator, productionSystem),
    ).toEqual(before);
  });

  it('throws when hydrating an unsupported schema version', () => {
    const { coordinator } = createHarness(0);

    expect(() =>
      hydrateProgressionCoordinatorState(
        { schemaVersion: 999 } as unknown as SerializedProgressionCoordinatorStateV1,
        coordinator,
      ),
    ).toThrow('Unsupported progression coordinator save schema version: 999');
  });

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
    coordinator.setGeneratorEnabled('generator.mine', false);

    const saved = serializeProgressionCoordinatorState(coordinator, productionSystem);

    const corrupted = {
      ...saved,
      generators: [
        ...saved.generators,
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

    expect(
      serializeProgressionCoordinatorState(
        restored.coordinator,
        restored.productionSystem,
      ),
    ).toEqual(saved);
  });

  it('ignores serialized upgrade entries with blank ids', () => {
    const { coordinator, productionSystem } = createHarness(0);
    coordinator.setUpgradePurchases('upgrade.double-mine', 1);

    const saved = serializeProgressionCoordinatorState(coordinator, productionSystem);
    const corrupted = {
      ...saved,
      upgrades: [
        ...saved.upgrades,
        {
          id: ' ',
          purchases: 123,
        },
      ],
    };

    const restored = createHarness(corrupted.step);
    hydrateProgressionCoordinatorState(
      corrupted,
      restored.coordinator,
      restored.productionSystem,
    );

    expect(
      serializeProgressionCoordinatorState(
        restored.coordinator,
        restored.productionSystem,
      ),
    ).toEqual(saved);
  });

  it('ignores serialized achievement entries with blank ids', () => {
    const { coordinator, productionSystem } = createHarness(0);

    const saved = serializeProgressionCoordinatorState(coordinator, productionSystem);
    const corrupted = {
      ...saved,
      achievements: [
        ...saved.achievements,
        {
          id: ' ',
          completions: 99,
          progress: 123,
          nextRepeatableAtStep: 50,
          lastCompletedStep: 10,
        },
      ],
    };

    const restored = createHarness(corrupted.step);
    hydrateProgressionCoordinatorState(
      corrupted,
      restored.coordinator,
      restored.productionSystem,
    );

    expect(
      serializeProgressionCoordinatorState(
        restored.coordinator,
        restored.productionSystem,
      ),
    ).toEqual(saved);
  });

  it('hydrates legacy v1 saves by resetting achievements', () => {
    const source = createHarness(0);
    source.coordinator.incrementGeneratorOwned('generator.mine', 1);

    const savedV2 = serializeProgressionCoordinatorState(
      source.coordinator,
      source.productionSystem,
    );
    const savedV1: SerializedProgressionCoordinatorStateV1 = {
      schemaVersion: 1,
      step: savedV2.step,
      resources: savedV2.resources,
      generators: savedV2.generators,
      upgrades: savedV2.upgrades,
      productionAccumulators: savedV2.productionAccumulators,
    };

    const baseline = createHarness(savedV1.step);
    hydrateProgressionCoordinatorState(
      savedV1,
      baseline.coordinator,
      baseline.productionSystem,
    );
    const baselineAchievements = serializeProgressionCoordinatorState(
      baseline.coordinator,
      baseline.productionSystem,
    ).achievements;

    const restored = createHarness(savedV1.step);
    const achievement = restored.coordinator.state.achievements?.find(
      (entry) => entry.id === 'achievement.energy-1',
    );
    expect(achievement).toBeDefined();

    const mutableAchievement = achievement as unknown as {
      isVisible: boolean;
      completions: number;
      progress: number;
      target: number;
      nextRepeatableAtStep?: number;
      lastCompletedStep?: number;
    };
    mutableAchievement.isVisible = true;
    mutableAchievement.completions = 2;
    mutableAchievement.progress = 5;
    mutableAchievement.target = 10;
    mutableAchievement.nextRepeatableAtStep = 20;
    mutableAchievement.lastCompletedStep = 30;

    hydrateProgressionCoordinatorState(
      savedV1,
      restored.coordinator,
      restored.productionSystem,
    );

    expect(
      serializeProgressionCoordinatorState(
        restored.coordinator,
        restored.productionSystem,
      ).achievements,
    ).toEqual(baselineAchievements);
  });

  it('skips resource hydration when requested', () => {
    const source = createHarness(0);
    source.coordinator.incrementGeneratorOwned('generator.mine', 2);
    source.coordinator.setUpgradePurchases('upgrade.double-mine', 1);

    const goldIndexSource = source.coordinator.resourceState.requireIndex(
      'resource.gold',
    );
    source.coordinator.resourceState.addAmount(goldIndexSource, 100);

    const saved = serializeProgressionCoordinatorState(
      source.coordinator,
      source.productionSystem,
    );

    const restored = createHarness(0);
    const goldIndexRestored = restored.coordinator.resourceState.requireIndex(
      'resource.gold',
    );
    restored.coordinator.resourceState.addAmount(goldIndexRestored, 5);
    const goldBefore = restored.coordinator.resourceState.getAmount(goldIndexRestored);

    hydrateProgressionCoordinatorState(
      saved,
      restored.coordinator,
      undefined,
      { skipResources: true },
    );

    expect(restored.coordinator.resourceState.getAmount(goldIndexRestored)).toBe(
      goldBefore,
    );

    const generator = restored.coordinator.state.generators?.find(
      (entry) => entry.id === 'generator.mine',
    );
    expect(generator?.owned).toBe(2);
    expect(
      restored.coordinator.getConditionContext().getUpgradePurchases(
        'upgrade.double-mine',
      ),
    ).toBe(1);
  });

  it('normalizes malformed generator, upgrade, and achievement fields when hydrating', () => {
    const source = createHarness(0);
    const saved = serializeProgressionCoordinatorState(
      source.coordinator,
      source.productionSystem,
    );

    const corrupted = {
      ...saved,
      generators: [
        {
          id: 'generator.mine',
          owned: Number.NaN,
          enabled: false,
          isUnlocked: true,
        },
        {
          id: 'generator.mine',
          owned: 2.9,
          enabled: 'nope',
          isUnlocked: null,
          nextPurchaseReadyAtStep: Number.NaN,
        },
        { id: 123, owned: 1, enabled: true, isUnlocked: true },
        { id: 'generator.unknown', owned: 5, enabled: true, isUnlocked: true },
        null,
      ],
      upgrades: [
        { id: 'upgrade.double-mine', purchases: Number.NaN },
        { id: 'upgrade.double-mine', purchases: 2.9 },
        { id: 123, purchases: 1 },
        { id: 'upgrade.unknown', purchases: 5 },
        null,
      ],
      achievements: [
        {
          id: 'achievement.energy-1',
          completions: Number.NaN,
          progress: Number.NaN,
          nextRepeatableAtStep: Number.NaN,
          lastCompletedStep: Number.NaN,
        },
        {
          id: 'achievement.energy-1',
          completions: 2.9,
          progress: -1,
          nextRepeatableAtStep: -1,
          lastCompletedStep: Number.POSITIVE_INFINITY,
        },
        { id: 123, completions: 1, progress: 1 },
        { id: 'achievement.unknown', completions: 5, progress: 10 },
        null,
      ],
    } as unknown as typeof saved;

    const restored = createHarness(0);
    hydrateProgressionCoordinatorState(
      corrupted,
      restored.coordinator,
      restored.productionSystem,
    );

    const generator = restored.coordinator.state.generators?.find(
      (entry) => entry.id === 'generator.mine',
    );
    expect(generator?.owned).toBe(2);
    expect(generator?.enabled).toBe(true);
    expect(generator?.nextPurchaseReadyAtStep).toBe(1);

    expect(
      restored.coordinator.getConditionContext().getUpgradePurchases(
        'upgrade.double-mine',
      ),
    ).toBe(1);

    const achievement = restored.coordinator.state.achievements?.find(
      (entry) => entry.id === 'achievement.energy-1',
    );
    expect(achievement?.completions).toBe(2);
    expect(achievement?.progress).toBe(1);
    expect(achievement?.nextRepeatableAtStep).toBeUndefined();
    expect(achievement?.lastCompletedStep).toBeUndefined();
  });

  it('ignores production accumulators when no production system is provided', () => {
    const source = createHarness(0);
    source.coordinator.incrementGeneratorOwned('generator.mine', 1);

    const saved = serializeProgressionCoordinatorState(
      source.coordinator,
      source.productionSystem,
    );
    expect(saved.productionAccumulators).toBeDefined();

    const restored = createHarness(0);
    hydrateProgressionCoordinatorState(saved, restored.coordinator);

    const generator = restored.coordinator.state.generators?.find(
      (entry) => entry.id === 'generator.mine',
    );
    expect(generator?.owned).toBe(1);
  });
});
