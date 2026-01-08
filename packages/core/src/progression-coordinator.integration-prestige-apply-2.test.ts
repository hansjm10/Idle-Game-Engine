import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from './index.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createPrestigeLayerDefinition,
  createResourceDefinition,
  literalOne,
} from './content-test-helpers.js';

describe('Integration: prestige system applyPrestige', () => {
  it('resets seeded generators to initialLevel once per prestige layer', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFluxA = createResourceDefinition('resource.prestige-a', {
      name: 'Prestige A',
      startAmount: 0,
    });

    const prestigeFluxB = createResourceDefinition('resource.prestige-b', {
      name: 'Prestige B',
      startAmount: 0,
    });

    const prestigeCountA = createResourceDefinition('prestige.layer-a-prestige-count', {
      name: 'Layer A Count',
      startAmount: 0,
    });

    const prestigeCountB = createResourceDefinition('prestige.layer-b-prestige-count', {
      name: 'Layer B Count',
      startAmount: 0,
    });

    const seededGenerator = createGeneratorDefinition('generator.seeded-multi', {
      initialLevel: 2,
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const layerA = createPrestigeLayerDefinition('prestige.layer-a', {
      name: 'Layer A',
      resetTargets: [energy.id],
      resetGenerators: [seededGenerator.id],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFluxA.id,
        baseReward: literalOne,
      },
    });

    const layerB = createPrestigeLayerDefinition('prestige.layer-b', {
      name: 'Layer B',
      resetTargets: [energy.id],
      resetGenerators: [seededGenerator.id],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFluxB.id,
        baseReward: literalOne,
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [energy, prestigeFluxA, prestigeFluxB, prestigeCountA, prestigeCountB],
        generators: [seededGenerator],
        prestigeLayers: [layerA, layerB],
      }),
      stepDurationMs: 100,
    }) as unknown as {
      generatorEvaluator: { applyPurchase(id: string, count: number): void };
      prestigeEvaluator?: { applyPrestige(layerId: string, token?: string): void };
      getGeneratorRecord(id: string): { state: { owned: number } } | undefined;
    };

    coordinator.generatorEvaluator.applyPurchase(seededGenerator.id, 3);

    coordinator.prestigeEvaluator?.applyPrestige(layerA.id, 'token-layer-a');

    expect(coordinator.getGeneratorRecord(seededGenerator.id)?.state.owned).toBe(2);

    coordinator.generatorEvaluator.applyPurchase(seededGenerator.id, 1);

    coordinator.prestigeEvaluator?.applyPrestige(layerB.id, 'token-layer-b');

    expect(coordinator.getGeneratorRecord(seededGenerator.id)?.state.owned).toBe(2);
  });

  it('does not re-apply initialLevel after prestige when restoring from save', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.save-prestige-count', {
      name: 'Save Count',
      startAmount: 0,
    });

    const seededGenerator = createGeneratorDefinition('generator.seeded-save', {
      initialLevel: 2,
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.save', {
      name: 'Save',
      resetTargets: [energy.id],
      resetGenerators: [seededGenerator.id],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: literalOne,
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [energy, prestigeFlux, prestigeCount],
        generators: [seededGenerator],
        prestigeLayers: [prestigeLayer],
      }),
      stepDurationMs: 100,
    }) as unknown as {
      generatorEvaluator: { applyPurchase(id: string, count: number): void };
      prestigeEvaluator?: { applyPrestige(layerId: string, token?: string): void };
      getGeneratorRecord(id: string): { state: { owned: number } } | undefined;
      state: ReturnType<typeof createProgressionCoordinator>['state'];
    };

    coordinator.generatorEvaluator.applyPurchase(seededGenerator.id, 3);
    coordinator.prestigeEvaluator?.applyPrestige(prestigeLayer.id, 'token-save');

    expect(coordinator.getGeneratorRecord(seededGenerator.id)?.state.owned).toBe(2);

    const restored = createProgressionCoordinator({
      content: createContentPack({
        resources: [energy, prestigeFlux, prestigeCount],
        generators: [seededGenerator],
        prestigeLayers: [prestigeLayer],
      }),
      stepDurationMs: 100,
      initialState: coordinator.state,
    }) as unknown as {
      getGeneratorRecord(id: string): { state: { owned: number } } | undefined;
    };

    expect(restored.getGeneratorRecord(seededGenerator.id)?.state.owned).toBe(2);
  });

  it('re-locks gated reset resources and preserves default-unlocked resources after prestige', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const gated = createResourceDefinition('resource.gated', {
      name: 'Gated',
      startAmount: 0,
      unlocked: false,
      visible: false,
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: energy.id,
        comparator: 'gte',
        amount: { kind: 'constant', value: 10 },
      } as any,
      visibilityCondition: {
        kind: 'resourceThreshold',
        resourceId: energy.id,
        comparator: 'gte',
        amount: { kind: 'constant', value: 10 },
      } as any,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.test-prestige-count', {
      name: 'Prestige Count',
      startAmount: 0,
    });

    const gatedGenerator = createGeneratorDefinition('generator.gated', {
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      baseUnlock: {
        kind: 'resourceThreshold',
        resourceId: energy.id,
        comparator: 'gte',
        amount: { kind: 'constant', value: 10 },
      } as any,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.test', {
      resetTargets: [energy.id, gated.id],
      resetGenerators: [gatedGenerator.id],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: { kind: 'constant', value: 1 },
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [energy, gated, prestigeFlux, prestigeCount],
        generators: [gatedGenerator],
        prestigeLayers: [prestigeLayer],
      }),
      stepDurationMs: 100,
    }) as unknown as {
      updateForStep(step: number): void;
      resourceState: {
        requireIndex(id: string): number;
        addAmount(index: number, amount: number): number;
        isUnlocked(index: number): boolean;
        isVisible(index: number): boolean;
      };
      prestigeEvaluator?: { applyPrestige(layerId: string, token?: string): void };
      getGeneratorRecord(id: string): { state: { isUnlocked: boolean } } | undefined;
    };

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const gatedIndex = coordinator.resourceState.requireIndex(gated.id);

    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(0);

    expect(coordinator.resourceState.isUnlocked(energyIndex)).toBe(true);
    expect(coordinator.resourceState.isVisible(energyIndex)).toBe(true);
    expect(coordinator.resourceState.isUnlocked(gatedIndex)).toBe(true);
    expect(coordinator.resourceState.isVisible(gatedIndex)).toBe(true);
    expect(coordinator.getGeneratorRecord(gatedGenerator.id)?.state.isUnlocked).toBe(
      true,
    );

    coordinator.prestigeEvaluator?.applyPrestige('prestige.test', 'token-relock');

    expect(coordinator.resourceState.isUnlocked(energyIndex)).toBe(true);
    expect(coordinator.resourceState.isVisible(energyIndex)).toBe(true);
    expect(coordinator.resourceState.isUnlocked(gatedIndex)).toBe(false);
    expect(coordinator.resourceState.isVisible(gatedIndex)).toBe(false);
    expect(coordinator.getGeneratorRecord(gatedGenerator.id)?.state.isUnlocked).toBe(
      false,
    );
  });

  it('retention formulas can reference multiple resources', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const crystal = createResourceDefinition('resource.crystal', {
      name: 'Crystal',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    // Retention formula: (energy + crystal) * 0.05 (5% of combined resources)
    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy', 'resource.crystal'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
      },
      retention: [
        {
          kind: 'resource',
          resourceId: 'resource.energy',
          // Formula: (energy + crystal) * 0.05
          amount: {
            kind: 'expression',
            expression: {
              kind: 'binary',
              op: 'mul',
              left: {
                kind: 'binary',
                op: 'add',
                left: { kind: 'ref', target: { type: 'resource', id: 'resource.energy' } },
                right: { kind: 'ref', target: { type: 'resource', id: 'resource.crystal' } },
              },
              right: { kind: 'literal', value: 0.05 },
            },
          },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy, crystal, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Setup: energy = 1000, crystal = 500
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const crystalIndex = coordinator.resourceState.requireIndex('resource.crystal');
    coordinator.resourceState.addAmount(energyIndex, 1000);
    coordinator.resourceState.addAmount(crystalIndex, 500);
    coordinator.updateForStep(0);

    // Apply prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');

    // Energy should be (1000 + 500) * 0.05 = 75
    const postPrestigeEnergy = coordinator.resourceState.getAmount(energyIndex);
    expect(postPrestigeEnergy).toBe(75);

    // Crystal should be reset to startAmount (0) since it's not in retention
    const postPrestigeCrystal = coordinator.resourceState.getAmount(crystalIndex);
    expect(postPrestigeCrystal).toBe(0);
  });

  it('grants prestige reward before evaluating retention formulas', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        // Reward: energy * 0.01 (1% of energy as prestige flux)
        baseReward: {
          kind: 'expression',
          expression: {
            kind: 'binary',
            op: 'mul',
            left: { kind: 'ref', target: { type: 'resource', id: 'resource.energy' } },
            right: { kind: 'literal', value: 0.01 },
          },
        },
      },
      retention: [],
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Setup: energy = 1000
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const prestigeFluxIndex = coordinator.resourceState.requireIndex('resource.prestige-flux');
    coordinator.resourceState.addAmount(energyIndex, 1000);
    coordinator.updateForStep(0);

    // Apply prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');

    // Prestige flux should be 1000 * 0.01 = 10
    const postPrestigeFlux = coordinator.resourceState.getAmount(prestigeFluxIndex);
    expect(postPrestigeFlux).toBe(10);

    // Energy should be reset to startAmount (0)
    const postPrestigeEnergy = coordinator.resourceState.getAmount(energyIndex);
    expect(postPrestigeEnergy).toBe(0);
  });
});

