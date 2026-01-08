import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../index.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../../content-test-helpers.js';

describe('Integration: coordinator + condition evaluation game loop', () => {
  it('simulates resource accumulation unlocking generators over multiple steps', () => {
    // Create a game with energy resource and generator that unlocks at 15 energy
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.reactor', {
      name: {
        default: 'Reactor',
        variants: { 'en-US': 'Reactor' },
      } as any,
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 2 },
        },
      ],
      baseUnlock: {
        kind: 'resourceThreshold',
        resourceId: energy.id,
        comparator: 'gte',
        amount: { kind: 'constant', value: 15 },
      } as any,
      visibilityCondition: {
        kind: 'resourceThreshold',
        resourceId: energy.id,
        comparator: 'gte',
        amount: { kind: 'constant', value: 15 },
      } as any,
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Start with no energy
    coordinator.updateForStep(0);
    const generatorState = coordinator.state.generators?.find(
      (g) => g.id === generator.id,
    );
    expect(generatorState?.isUnlocked).toBe(false);
    expect(generatorState?.isVisible).toBe(false);

    // Simulate accumulating energy over steps
    const energyIndex = coordinator.resourceState.getIndex(energy.id);
    if (energyIndex === undefined) {
      throw new Error('Energy index missing');
    }

    // Add 10 energy (still locked)
    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(1);
    const stillLocked = coordinator.state.generators?.find((g) => g.id === generator.id);
    expect(stillLocked?.isUnlocked).toBe(false);

    // Add 5 more energy (reaches unlock threshold)
    coordinator.resourceState.addAmount(energyIndex, 5);
    coordinator.updateForStep(2);
    const unlocked = coordinator.state.generators?.find((g) => g.id === generator.id);
    expect(unlocked?.isUnlocked).toBe(true);
    expect(unlocked?.isVisible).toBe(true);
  });

  it('simulates upgrade purchases affecting generator unlock conditions', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const starterUpgrade = createUpgradeDefinition('upgrade.starter', {
      name: 'Starter Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantFlag',
          flagId: 'flag.starter',
          value: true,
        },
      ],
    });

    const gatedGenerator = createGeneratorDefinition('generator.gated', {
      name: 'Gated Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
      baseUnlock: {
        kind: 'flag',
        flagId: 'flag.starter',
        value: true,
      } as any,
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [gatedGenerator],
      upgrades: [starterUpgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    const generatorState = coordinator.state.generators?.find(
      (g) => g.id === gatedGenerator.id,
    );
    expect(generatorState?.isUnlocked).toBe(false);

    // Purchase upgrade to unlock generator
    coordinator.upgradeEvaluator?.applyPurchase(starterUpgrade.id);
    coordinator.updateForStep(1);

    const unlockedGenerator = coordinator.state.generators?.find(
      (g) => g.id === gatedGenerator.id,
    );
    expect(unlockedGenerator?.isUnlocked).toBe(true);
  });

  it('simulates multiple generator purchases with persistent state', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.basic', {
      name: 'Basic Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    coordinator.generatorEvaluator.applyPurchase(generator.id, 3);

    const generatorState = coordinator.state.generators?.find((g) => g.id === generator.id);
    expect(generatorState?.owned).toBe(3);

    coordinator.updateForStep(1);
    const updatedGeneratorState = coordinator.state.generators?.find((g) => g.id === generator.id);
    expect(updatedGeneratorState?.owned).toBe(3);
  });

  it('simulates complex condition evaluation with multiple nested conditions', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.complex', {
      name: 'Complex Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
      baseUnlock: {
        kind: 'allOf',
        conditions: [
          {
            kind: 'resourceThreshold',
            resourceId: energy.id,
            comparator: 'gte',
            amount: { kind: 'constant', value: 10 },
          },
          {
            kind: 'anyOf',
            conditions: [
              {
                kind: 'resourceThreshold',
                resourceId: energy.id,
                comparator: 'gte',
                amount: { kind: 'constant', value: 20 },
              },
              {
                kind: 'resourceThreshold',
                resourceId: energy.id,
                comparator: 'gte',
                amount: { kind: 'constant', value: 30 },
              },
            ],
          },
        ],
      } as any,
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.getIndex(energy.id);
    if (energyIndex === undefined) {
      throw new Error('Energy index missing');
    }

    // Add 15 energy (meets first condition but not nested anyOf)
    coordinator.resourceState.addAmount(energyIndex, 15);
    coordinator.updateForStep(0);
    let generatorState = coordinator.state.generators?.find((g) => g.id === generator.id);
    expect(generatorState?.isUnlocked).toBe(false);

    // Add 5 more energy (meets nested anyOf via 20 threshold)
    coordinator.resourceState.addAmount(energyIndex, 5);
    coordinator.updateForStep(1);
    generatorState = coordinator.state.generators?.find((g) => g.id === generator.id);
    expect(generatorState?.isUnlocked).toBe(true);
  });
});

