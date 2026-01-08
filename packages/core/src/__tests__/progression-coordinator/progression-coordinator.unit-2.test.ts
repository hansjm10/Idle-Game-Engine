import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../index.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../../content-test-helpers.js';
import {
  createCostMultiplierGeneratorContentPack,
  createGeneratorUnlockContentPack,
  createResourceConditionContentPack,
} from './progression-coordinator.test-helpers.js';

describe('progression-coordinator', () => {
  it('evaluates unlock and visibility conditions for resources', () => {
    const coordinator = createProgressionCoordinator({
      content: createResourceConditionContentPack(),
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(
      'resource.conditional.energy',
    );
    const gemsIndex = coordinator.resourceState.requireIndex(
      'resource.conditional.gems',
    );

    expect(coordinator.resourceState.isUnlocked(gemsIndex)).toBe(false);
    expect(coordinator.resourceState.isVisible(gemsIndex)).toBe(false);

    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(0);

    expect(coordinator.resourceState.isUnlocked(gemsIndex)).toBe(true);
    expect(coordinator.resourceState.isVisible(gemsIndex)).toBe(false);

    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(1);

    expect(coordinator.resourceState.isUnlocked(gemsIndex)).toBe(true);
    expect(coordinator.resourceState.isVisible(gemsIndex)).toBe(true);

    const spent = coordinator.resourceState.spendAmount(energyIndex, 20);
    expect(spent).toBe(true);

    coordinator.updateForStep(2);

    expect(coordinator.resourceState.isUnlocked(gemsIndex)).toBe(true);
    expect(coordinator.resourceState.isVisible(gemsIndex)).toBe(true);
  });

  it('defaults resource visibility to unlock when visibilityCondition is omitted', () => {
    const currency = createResourceDefinition('resource.currency', {
      name: 'Currency',
      unlocked: false,
      visible: false,
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource.currency',
        comparator: 'gte',
        amount: { kind: 'constant', value: 1 },
      } as any,
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [currency],
      }),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const index = coordinator.resourceState.getIndex(currency.id);
    if (index === undefined) {
      throw new Error('Resource index missing');
    }
    expect(coordinator.resourceState.isUnlocked(index)).toBe(false);
    expect(coordinator.resourceState.isVisible(index)).toBe(false);

    coordinator.resourceState.addAmount(index, 1);
    coordinator.updateForStep(1);

    expect(coordinator.resourceState.isUnlocked(index)).toBe(true);
    expect(coordinator.resourceState.isVisible(index)).toBe(true);
  });

  it('defaults generator visibility to unlock when visibilityCondition is omitted', () => {
    const coordinator = createProgressionCoordinator({
      content: createGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const generator = coordinator.state.generators?.find(
      (entry) => entry.id === 'generator.unlockable',
    );
    expect(generator).toBeDefined();
    expect(generator?.isUnlocked).toBe(false);
    expect(generator?.isVisible).toBe(false);

    const energyIndex = coordinator.resourceState.getIndex('resource.energy');
    if (energyIndex === undefined) {
      throw new Error('Resource index missing');
    }
    coordinator.resourceState.addAmount(energyIndex, 15);

    coordinator.updateForStep(1);

    const updatedGenerator = coordinator.state.generators?.find(
      (entry) => entry.id === 'generator.unlockable',
    );
    expect(updatedGenerator).toBeDefined();
    expect(updatedGenerator?.isUnlocked).toBe(true);
    expect(updatedGenerator?.isVisible).toBe(true);
  });

  it('keeps generators unlocked after initially satisfying the base unlock condition', () => {
    const coordinator = createProgressionCoordinator({
      content: createGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.getIndex('resource.energy');
    if (energyIndex === undefined) {
      throw new Error('Resource index missing');
    }

    coordinator.resourceState.addAmount(energyIndex, 15);
    coordinator.updateForStep(0);

    const generator = coordinator.state.generators?.find(
      (entry) => entry.id === 'generator.unlockable',
    );
    expect(generator?.isUnlocked).toBe(true);

    coordinator.resourceState.spendAmount(energyIndex, 15);
    coordinator.updateForStep(1);

    const updatedGenerator = coordinator.state.generators?.find(
      (entry) => entry.id === 'generator.unlockable',
    );
    expect(updatedGenerator?.isUnlocked).toBe(true);
  });

  it('seeds generators with initialLevel on fresh state without reapplying on save', () => {
    const currency = createResourceDefinition('resource.currency', {
      name: 'Currency',
    });

    const generator = createGeneratorDefinition('generator.seeded', {
      name: 'Seeded Generator',
      initialLevel: 3,
      purchase: {
        currencyId: currency.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [currency],
        generators: [generator],
      }),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const seededGenerator = coordinator.state.generators?.find(
      (entry) => entry.id === generator.id,
    );
    expect(seededGenerator?.owned).toBe(3);
    expect(seededGenerator?.isUnlocked).toBe(true);

    const savedState = coordinator.state;
    const restored = createProgressionCoordinator({
      content: createContentPack({
        resources: [currency],
        generators: [generator],
      }),
      stepDurationMs: 100,
      initialState: savedState,
    });

    restored.updateForStep(1);

    const restoredGenerator = restored.state.generators?.find(
      (entry) => entry.id === generator.id,
    );
    expect(restoredGenerator?.owned).toBe(3);
  });

  it('quotes generator purchases using costMultiplier multipliers', () => {
    const coordinator = createProgressionCoordinator({
      content: createCostMultiplierGeneratorContentPack(),
      stepDurationMs: 100,
    });

    const quote = coordinator.generatorEvaluator.getPurchaseQuote(
      'generator.base-cost',
      1,
    );
    expect(quote).toBeDefined();
    expect(quote?.costs).toEqual([{ resourceId: 'resource.currency', amount: 100 }]);
  });

  it('defaults upgrade visibility to unlock when visibilityCondition is omitted', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const upgrade = createUpgradeDefinition('upgrade.energy-gate', {
      name: 'Energy Gate',
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: energy.id,
        comparator: 'gte',
        amount: { kind: 'constant', value: 5 },
      } as any,
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [energy],
        upgrades: [upgrade],
        metadata: {
          id: 'pack.upgrades.default-visibility',
          title: 'Default Upgrade Visibility Pack',
        },
      }),
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const upgradeRecord = coordinator.state.upgrades?.find(
      (record) => record.id === upgrade.id,
    );

    coordinator.updateForStep(0);

    expect(upgradeRecord?.status).toBe('locked');
    expect(upgradeRecord?.isVisible).toBe(false);

    coordinator.resourceState.addAmount(energyIndex, 5);
    coordinator.updateForStep(1);
    expect(upgradeRecord?.status).toBe('available');
    expect(upgradeRecord?.isVisible).toBe(true);

    coordinator.resourceState.spendAmount(energyIndex, 5);
    coordinator.updateForStep(2);
    expect(upgradeRecord?.status).toBe('locked');
    expect(upgradeRecord?.isVisible).toBe(false);
  });
});
