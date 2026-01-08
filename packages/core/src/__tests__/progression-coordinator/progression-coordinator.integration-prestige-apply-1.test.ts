import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../index.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createPrestigeLayerDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../../content-test-helpers.js';

describe('Integration: prestige system applyPrestige', () => {
  it('retention formulas see pre-reset resource values', () => {
    // This test verifies the fix for the retention formula timing bug.
    // Retention formulas like "energy * 0.1" should see the PRE-reset value of energy,
    // not the post-reset value (which would be startAmount, typically 0).

    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0, // Will be reset to this value
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    // Retention formula: energy * 0.1 (retain 10% of energy)
    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      unlockCondition: {
        kind: 'always',
      },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: {
          kind: 'constant',
          value: 1,
        },
      },
      resetTargets: [energy.id],
      retention: [
        {
          kind: 'resource',
          resourceId: energy.id,
          amount: {
            kind: 'expression',
            expression: {
              kind: 'binary',
              op: 'mul',
              left: {
                kind: 'ref',
                target: { type: 'resource', id: energy.id },
              },
              right: { kind: 'literal', value: 0.1 },
            },
          },
        },
      ],
    });

    const content = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    });

    // Set energy to 100 before prestige
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 100);

    coordinator.updateForStep(0);

    // Prestige layer should be unlocked
    expect(coordinator.prestigeEvaluator?.getPrestigeQuote(prestigeLayer.id)?.status).toBe(
      'available',
    );

    // Apply prestige
    coordinator.prestigeEvaluator?.applyPrestige(prestigeLayer.id, 'token-1');

    // Energy should be reset to 0, then retention should add back 10 (10% of 100)
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(10);
  });

  it('resets generators and upgrades when configured, respecting retention', () => {
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

    const generator = createGeneratorDefinition('generator.test', {
      name: 'Test Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const upgrade = createUpgradeDefinition('upgrade.test', {
      name: 'Test Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [],
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: { kind: 'constant', value: 1 },
      },
      resetTargets: [energy.id],
      resetGenerators: [generator.id],
      resetUpgrades: [upgrade.id],
      retention: [
        {
          kind: 'generator',
          generatorId: generator.id,
        },
        {
          kind: 'upgrade',
          upgradeId: upgrade.id,
        },
      ],
    });

    const content = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      generators: [generator],
      upgrades: [upgrade],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    }) as any;

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 100);

    // Purchase generator and upgrade
    coordinator.incrementGeneratorOwned(generator.id, 5);
    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(0);

    expect(coordinator.getGeneratorRecord(generator.id)?.state.owned).toBe(5);
    expect(coordinator.getUpgradeRecord(upgrade.id)?.purchases).toBe(1);

    // Apply prestige - generator and upgrade should be retained
    coordinator.prestigeEvaluator.applyPrestige(prestigeLayer.id, 'token-2');

    expect(coordinator.getGeneratorRecord(generator.id)?.state.owned).toBe(5);
    expect(coordinator.getUpgradeRecord(upgrade.id)?.purchases).toBe(1);
  });

  it('re-seeds reset generators with initialLevel after prestige', () => {
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

    const seededGenerator = createGeneratorDefinition('generator.seeded', {
      name: 'Seeded Generator',
      initialLevel: 2,
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: { kind: 'constant', value: 1 },
      },
      resetTargets: [energy.id],
      resetGenerators: [seededGenerator.id],
    });

    const content = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      generators: [seededGenerator],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    }) as any;

    coordinator.updateForStep(0);
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 100);

    coordinator.incrementGeneratorOwned(seededGenerator.id, 5);
    coordinator.updateForStep(1);

    expect(coordinator.getGeneratorRecord(seededGenerator.id)?.state.owned).toBe(7);

    coordinator.prestigeEvaluator.applyPrestige(prestigeLayer.id, 'token-3');

    expect(coordinator.getGeneratorRecord(seededGenerator.id)?.state.owned).toBe(2);
  });

  it('keeps reset generators at default initialLevel locked until base unlock is met', () => {
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

    const gatedGenerator = createGeneratorDefinition('generator.gated', {
      name: 'Gated Generator',
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

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: { kind: 'constant', value: 1 },
      },
      resetTargets: [energy.id],
      resetGenerators: [gatedGenerator.id],
    });

    const content = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      generators: [gatedGenerator],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    }) as any;

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);

    coordinator.prestigeEvaluator.applyPrestige(prestigeLayer.id, 'token-4');

    // After prestige, energy is reset to 0, so generator should be locked
    const record = coordinator.getGeneratorRecord(gatedGenerator.id);
    expect(record?.state.isUnlocked).toBe(false);
    expect(record?.state.owned).toBe(0);
  });

  it('keeps seeded generators unlocked after prestige even if base unlock is unmet', () => {
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

    const seededGenerator = createGeneratorDefinition('generator.seeded', {
      name: 'Seeded Generator',
      initialLevel: 2,
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

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: { kind: 'constant', value: 1 },
      },
      resetTargets: [energy.id],
      resetGenerators: [seededGenerator.id],
    });

    const content = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      generators: [seededGenerator],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
    }) as any;

    coordinator.updateForStep(0);
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);

    coordinator.prestigeEvaluator?.applyPrestige(prestigeLayer.id, 'token-seeded');

    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(0);

    const resetRecord = coordinator.getGeneratorRecord(seededGenerator.id);
    expect(resetRecord?.state.owned).toBe(2);
    expect(resetRecord?.state.isUnlocked).toBe(true);
  });
});

