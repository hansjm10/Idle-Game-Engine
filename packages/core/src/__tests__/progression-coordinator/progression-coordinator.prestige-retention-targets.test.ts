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

describe('Prestige retention targets', () => {
  it('computes retained generators in prestige quote preview', () => {
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

    const retainedGenerator = createGeneratorDefinition('generator.retained', {
      name: 'Retained Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
      produces: [{ resourceId: energy.id, rate: literalOne }],
    });

    const resetGenerator = createGeneratorDefinition('generator.reset', {
      name: 'Reset Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
      produces: [{ resourceId: energy.id, rate: literalOne }],
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      resetGenerators: ['generator.retained', 'generator.reset'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
      },
      retention: [
        {
          kind: 'generator',
          generatorId: 'generator.retained',
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      generators: [retainedGenerator, resetGenerator],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Setup: purchase both generators
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);

    coordinator.generatorEvaluator.applyPurchase(retainedGenerator.id, 5);
    coordinator.generatorEvaluator.applyPurchase(resetGenerator.id, 3);
    coordinator.updateForStep(1);

    // Verify both generators are purchased
    expect(coordinator.state.generators?.[0]?.owned).toBe(5);
    expect(coordinator.state.generators?.[1]?.owned).toBe(3);

    // Get prestige quote and verify retained targets includes the generator
    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote?.retainedTargets).toContain('generator.retained');
    expect(quote?.retainedTargets).not.toContain('generator.reset');

    // Apply prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');

    // Retained generator should still have its level
    expect(coordinator.state.generators?.[0]?.owned).toBe(5);
    // Reset generator should be reset
    expect(coordinator.state.generators?.[1]?.owned).toBe(0);
  });

  it('applies prestige reward multiplier curve when defined', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 1000,
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
        baseReward: { kind: 'constant', value: 10 },
        multiplierCurve: { kind: 'constant', value: 2 }, // 2x multiplier
      },
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    // Get prestige quote and verify reward amount includes multiplier
    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    // Base reward 10 * multiplier 2 = 20
    expect(quote?.reward.amount).toBe(20);
  });

  it('computes retained upgrades in prestige quote preview', () => {
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

    const retainedUpgrade = createUpgradeDefinition('upgrade.retained', {
      name: 'Retained Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
    });

    const resetUpgrade = createUpgradeDefinition('upgrade.reset', {
      name: 'Reset Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      resetUpgrades: ['upgrade.retained', 'upgrade.reset'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
      },
      retention: [
        {
          kind: 'upgrade',
          upgradeId: 'upgrade.retained',
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      upgrades: [retainedUpgrade, resetUpgrade],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Setup: purchase both upgrades
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);

    coordinator.upgradeEvaluator!.applyPurchase(retainedUpgrade.id);
    coordinator.upgradeEvaluator!.applyPurchase(resetUpgrade.id);
    coordinator.updateForStep(1);

    // Verify both upgrades are purchased
    expect(
      coordinator.getConditionContext().getUpgradePurchases(retainedUpgrade.id),
    ).toBe(1);
    expect(
      coordinator.getConditionContext().getUpgradePurchases(resetUpgrade.id),
    ).toBe(1);

    // Get prestige quote and verify retained targets includes the upgrade
    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote?.retainedTargets).toContain('upgrade.retained');
    expect(quote?.retainedTargets).not.toContain('upgrade.reset');

    // Apply prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');

    // Retained upgrade should still be purchased
    expect(
      coordinator.getConditionContext().getUpgradePurchases(retainedUpgrade.id),
    ).toBe(1);
    // Reset upgrade should be reset
    expect(
      coordinator.getConditionContext().getUpgradePurchases(resetUpgrade.id),
    ).toBe(0);
  });
});
