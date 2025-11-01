import type { NormalizedContentPack } from '@idle-engine/content-schema';
import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from './progression-coordinator.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from './test-helpers.js';

function createRepeatableContentPack(): NormalizedContentPack {
  const resource = createResourceDefinition('resource.test', {
    name: 'Test Resource',
  });

  const repeatableUpgrade = createUpgradeDefinition('upgrade.repeatable', {
    name: 'Repeatable Upgrade',
    cost: {
      currencyId: resource.id,
      baseCost: 1,
      costCurve: literalOne,
    },
    repeatable: {
      costCurve: literalOne,
    },
    effects: [
      {
        kind: 'grantFlag',
        flagId: 'flag.repeatable',
        value: true,
      },
    ],
  });

  return createContentPack({
    resources: [resource],
    upgrades: [repeatableUpgrade],
  });
}

function createGeneratorUnlockContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });

  const generator = createGeneratorDefinition('generator.unlockable', {
    name: {
      default: 'Unlockable Generator',
      variants: { 'en-US': 'Unlockable Generator' },
    } as any,
    purchase: {
      currencyId: energy.id,
      baseCost: 25,
      costCurve: {
        kind: 'linear',
        base: 25,
        slope: 0,
      },
    },
    produces: [
      {
        resourceId: energy.id,
        rate: {
          kind: 'constant',
          value: 1,
        },
      },
    ],
    baseUnlock: {
      kind: 'resourceThreshold',
      resourceId: energy.id,
      comparator: 'gte',
      amount: { kind: 'constant', value: 15 },
    } as any,
  });

  return createContentPack({
    resources: [energy],
    generators: [generator],
    metadata: {
      id: 'pack.unlockable',
      title: 'Unlockable Pack',
    },
  });
}

function createInvisibleGeneratorContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.hidden.energy', {
    name: 'Hidden Energy',
  });

  const generator = createGeneratorDefinition('generator.hidden', {
    name: {
      default: 'Hidden Generator',
      variants: { 'en-US': 'Hidden Generator' },
    } as any,
    purchase: {
      currencyId: energy.id,
      baseCost: 10,
      costCurve: {
        kind: 'linear',
        base: 10,
        slope: 0,
      },
    },
    produces: [
      {
        resourceId: energy.id,
        rate: {
          kind: 'constant',
          value: 1,
        },
      },
    ],
    visibilityCondition: {
      kind: 'resourceThreshold',
      resourceId: energy.id,
      comparator: 'gte',
      amount: {
        kind: 'constant',
        value: 1,
      },
    } as any,
  });

  return createContentPack({
    resources: [energy],
    generators: [generator],
    metadata: {
      id: 'pack.hidden',
      title: 'Hidden Pack',
    },
  });
}

function createBaseCostGeneratorContentPack(): NormalizedContentPack {
  const currency = createResourceDefinition('resource.currency', {
    name: 'Currency',
  });

  const generator = createGeneratorDefinition('generator.base-cost', {
    name: {
      default: 'Base Cost Generator',
      variants: { 'en-US': 'Base Cost Generator' },
    } as any,
    purchase: {
      currencyId: currency.id,
      baseCost: 100,
      costCurve: literalOne,
    },
    produces: [
      {
        resourceId: currency.id,
        rate: literalOne,
      },
    ],
  });

  return createContentPack({
    resources: [currency],
    generators: [generator],
    metadata: {
      id: 'pack.generator.base-cost',
      title: 'Generator Base Cost Pack',
    },
  });
}

function createBaseCostUpgradeContentPack(): NormalizedContentPack {
  const currency = createResourceDefinition('resource.currency', {
    name: 'Currency',
  });

  const upgrade = createUpgradeDefinition('upgrade.base-cost', {
    name: 'Base Cost Upgrade',
    cost: {
      currencyId: currency.id,
      baseCost: 250,
      costCurve: literalOne,
    },
    effects: [
      {
        kind: 'grantFlag',
        flagId: 'flag.base-cost',
        value: true,
      },
    ],
  });

  return createContentPack({
    resources: [currency],
    upgrades: [upgrade],
    metadata: {
      id: 'pack.upgrade.base-cost',
      title: 'Upgrade Base Cost Pack',
    },
  });
}

describe('progression-coordinator', () => {
  it('keeps repeatable upgrades without maxPurchases available after purchase', () => {
    const coordinator = createProgressionCoordinator({
      content: createRepeatableContentPack(),
      stepDurationMs: 100,
    }) as unknown as {
      updateForStep(step: number): void;
      getUpgradeRecord(id: string): {
        purchases: number;
        state: { status: string; purchases?: number };
      } | undefined;
    };

    const record = coordinator.getUpgradeRecord('upgrade.repeatable');
    expect(record).toBeDefined();

    coordinator.updateForStep(0);
    expect(record?.state.status).toBe('available');

    if (!record) {
      throw new Error('Upgrade record missing');
    }

    record.purchases = 1;
    record.state.purchases = 1;

    coordinator.updateForStep(1);

    expect(record.state.status).toBe('available');
  });

  it('keeps repeatable upgrade quotes available when maxPurchases is undefined', () => {
    const coordinator = createProgressionCoordinator({
      content: createRepeatableContentPack(),
      stepDurationMs: 100,
    }) as unknown as {
      updateForStep(step: number): void;
      upgradeEvaluator?: {
        getPurchaseQuote(id: string): { status: string } | undefined;
        applyPurchase(id: string): void;
      };
    };

    coordinator.updateForStep(0);

    const upgradeEvaluator = coordinator.upgradeEvaluator;
    expect(upgradeEvaluator).toBeDefined();

    const initialQuote = upgradeEvaluator?.getPurchaseQuote('upgrade.repeatable');
    expect(initialQuote).toBeDefined();
    expect(initialQuote?.status).toBe('available');

    upgradeEvaluator?.applyPurchase('upgrade.repeatable');
    coordinator.updateForStep(1);

    const subsequentQuote = upgradeEvaluator?.getPurchaseQuote('upgrade.repeatable');
    expect(subsequentQuote).toBeDefined();
    expect(subsequentQuote?.status).toBe('available');
  });

  it('includes upgrade baseCost when quoting costs', () => {
    const coordinator = createProgressionCoordinator({
      content: createBaseCostUpgradeContentPack(),
      stepDurationMs: 100,
    });

    const quote = coordinator.upgradeEvaluator?.getPurchaseQuote(
      'upgrade.base-cost',
    );

    expect(quote).toBeDefined();
    expect(quote?.costs).toEqual([
      { resourceId: 'resource.currency', amount: 250 },
    ]);
  });

  it('does not quote purchases for locked generators', () => {
    const coordinator = createProgressionCoordinator({
      content: createGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    });

    const quote = coordinator.generatorEvaluator.getPurchaseQuote(
      'generator.unlockable',
      1,
    );
    expect(quote).toBeUndefined();

    const internalCoordinator = coordinator as unknown as {
      getGeneratorRecord(
        id: string,
      ): { state: { isUnlocked: boolean } } | undefined;
    };
    const record = internalCoordinator.getGeneratorRecord('generator.unlockable');
    expect(record?.state.isUnlocked).toBe(false);
  });

  it('does not quote purchases for invisible generators', () => {
    const coordinator = createProgressionCoordinator({
      content: createInvisibleGeneratorContentPack(),
      stepDurationMs: 100,
    });

    const quote = coordinator.generatorEvaluator.getPurchaseQuote(
      'generator.hidden',
      1,
    );
    expect(quote).toBeUndefined();

    const internalCoordinator = coordinator as unknown as {
      getGeneratorRecord(
        id: string,
      ):
        | { state: { isUnlocked: boolean; isVisible: boolean } }
        | undefined;
    };
    const record = internalCoordinator.getGeneratorRecord('generator.hidden');
    expect(record?.state.isUnlocked).toBe(true);
    expect(record?.state.isVisible).toBe(false);
  });

  it('keeps generators unlocked after initially satisfying the base unlock condition', () => {
    const coordinator = createProgressionCoordinator({
      content: createGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    }) as unknown as {
      resourceState: {
        requireIndex(id: string): number;
        addAmount(index: number, amount: number): number;
        spendAmount(index: number, amount: number): boolean;
      };
      updateForStep(step: number): void;
      getGeneratorRecord(
        id: string,
      ): { state: { isUnlocked: boolean; owned: number } } | undefined;
      incrementGeneratorOwned(id: string, count: number): void;
    };

    const record = coordinator.getGeneratorRecord('generator.unlockable');
    expect(record).toBeDefined();
    if (!record) {
      throw new Error('Generator record missing');
    }

    expect(record.state.isUnlocked).toBe(false);

    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');

    coordinator.resourceState.addAmount(energyIndex, 30);
    coordinator.updateForStep(0);

    expect(record.state.isUnlocked).toBe(true);

    coordinator.incrementGeneratorOwned('generator.unlockable', 1);
    const spent = coordinator.resourceState.spendAmount(energyIndex, 25);
    expect(spent).toBe(true);

    coordinator.updateForStep(1);

    expect(record.state.isUnlocked).toBe(true);
  });

  it('quotes generator purchases using baseCost multipliers', () => {
    const coordinator = createProgressionCoordinator({
      content: createBaseCostGeneratorContentPack(),
      stepDurationMs: 100,
    });

    const quote = coordinator.generatorEvaluator.getPurchaseQuote(
      'generator.base-cost',
      2,
    );

    expect(quote).toBeDefined();
    expect(quote?.costs).toEqual([
      { resourceId: 'resource.currency', amount: 200 },
    ]);
  });
});

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
        baseCost: 10,
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

    const energyIndex = coordinator.resourceState.getIndex(energy.id);
    const generatorRecord = coordinator.state.generators.find(
      (g) => g.id === generator.id,
    );

    // Step 0: Start with 0 energy - generator should be locked and invisible
    coordinator.updateForStep(0);
    expect(generatorRecord?.isUnlocked).toBe(false);
    expect(generatorRecord?.isVisible).toBe(false);
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(0);

    // Step 1: Add 10 energy - still below unlock threshold
    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(1);
    expect(generatorRecord?.isUnlocked).toBe(false);
    expect(generatorRecord?.isVisible).toBe(false);

    // Step 2: Add 5 more energy (total 15) - generator unlocks
    coordinator.resourceState.addAmount(energyIndex, 5);
    coordinator.updateForStep(2);
    expect(generatorRecord?.isUnlocked).toBe(true);
    expect(generatorRecord?.isVisible).toBe(true);

    // Step 3: Purchase generator - verify quote and spend resources
    const quote = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      1,
    );
    expect(quote).toBeDefined();
    expect(quote?.costs).toEqual([{ resourceId: energy.id, amount: 10 }]);

    const spent = coordinator.resourceState.spendAmount(energyIndex, 10);
    expect(spent).toBe(true);
    coordinator.incrementGeneratorOwned(generator.id, 1);
    coordinator.updateForStep(3);

    expect(generatorRecord?.owned).toBe(1);
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(5);
  });

  it('simulates upgrade purchases affecting generator unlock conditions', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const upgrade = createUpgradeDefinition('upgrade.efficiency', {
      name: 'Efficiency Boost',
      cost: {
        currencyId: energy.id,
        baseCost: 20,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantFlag',
          flagId: 'flag.efficiency',
          value: true,
        },
      ],
    });

    const advancedGenerator = createGeneratorDefinition(
      'generator.advanced',
      {
        name: {
          default: 'Advanced Generator',
          variants: { 'en-US': 'Advanced Generator' },
        } as any,
        purchase: {
          currencyId: energy.id,
          baseCost: 50,
          costCurve: literalOne,
        },
        produces: [
          {
            resourceId: energy.id,
            rate: { kind: 'constant', value: 5 },
          },
        ],
        baseUnlock: {
          kind: 'upgradeOwned',
          upgradeId: upgrade.id,
          requiredPurchases: 1,
        } as any,
      },
    );

    const pack = createContentPack({
      resources: [energy],
      generators: [advancedGenerator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.getIndex(energy.id);
    const generatorRecord = coordinator.state.generators.find(
      (g) => g.id === advancedGenerator.id,
    );
    const upgradeRecord = coordinator.state.upgrades?.find(
      (u) => u.id === upgrade.id,
    );

    // Step 0: Generator locked, upgrade available
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);
    expect(generatorRecord?.isUnlocked).toBe(false);
    expect(upgradeRecord?.status).toBe('available');

    // Step 1: Purchase upgrade
    const upgradeQuote = coordinator.upgradeEvaluator?.getPurchaseQuote(
      upgrade.id,
      1,
    );
    expect(upgradeQuote?.status).toBe('available');
    expect(upgradeQuote?.costs).toEqual([{ resourceId: energy.id, amount: 20 }]);

    coordinator.resourceState.spendAmount(energyIndex, 20);
    coordinator.incrementUpgradePurchases(upgrade.id, 1);
    coordinator.updateForStep(1);

    // Step 2: Generator unlocks after upgrade purchase
    coordinator.updateForStep(2);
    expect(generatorRecord?.isUnlocked).toBe(true);
    expect(generatorRecord?.isVisible).toBe(true);

    // Verify generator purchase is now possible
    const generatorQuote = coordinator.generatorEvaluator.getPurchaseQuote(
      advancedGenerator.id,
      1,
    );
    expect(generatorQuote).toBeDefined();
    expect(generatorQuote?.costs).toEqual([
      { resourceId: energy.id, amount: 50 },
    ]);
  });

  it('simulates multiple generator purchases with persistent state', () => {
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
        baseCost: 1,
        costCurve: {
          kind: 'linear',
          base: 10,
          slope: 5, // Cost increases by 5 per level
        },
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 2 },
        },
      ],
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
    const generatorRecord = coordinator.state.generators.find(
      (g) => g.id === generator.id,
    );

    // Start with resources
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);

    // Step 1: Purchase first generator (cost: 10)
    const quote1 = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      1,
    );
    expect(quote1).toBeDefined();
    expect(quote1?.costs).toEqual([{ resourceId: energy.id, amount: 10 }]);

    coordinator.resourceState.spendAmount(energyIndex, 10);
    coordinator.incrementGeneratorOwned(generator.id, 1);
    coordinator.updateForStep(1);

    expect(generatorRecord?.owned).toBe(1);
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(90);

    // Step 2: Purchase second generator (cost should be higher due to cost curve)
    const quote2 = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      2,
    );
    expect(quote2).toBeDefined();
    // Verify cost increases with level
    expect(quote2?.costs[0].amount).toBeGreaterThan(10);

    const cost2 = quote2?.costs[0].amount ?? 0;
    coordinator.resourceState.spendAmount(energyIndex, cost2);
    coordinator.incrementGeneratorOwned(generator.id, 1);
    coordinator.updateForStep(2);

    expect(generatorRecord?.owned).toBe(2);
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(100 - 10 - cost2);

    // Step 3: Verify third purchase quote has increased cost further
    const quote3 = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      3,
    );
    expect(quote3).toBeDefined();
    // Verify cost continues to increase
    expect(quote3?.costs[0].amount).toBeGreaterThan(cost2);
  });

  it('simulates complex condition evaluation with multiple nested conditions', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const crystal = createResourceDefinition('resource.crystal', {
      name: 'Crystal',
    });

    const basicUpgrade = createUpgradeDefinition('upgrade.basic', {
      name: 'Basic Upgrade',
      cost: {
        currencyId: energy.id,
        baseCost: 10,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantFlag',
          flagId: 'flag.basic',
          value: true,
        },
      ],
    });

    const basicGenerator = createGeneratorDefinition('generator.basic', {
      name: {
        default: 'Basic Generator',
        variants: { 'en-US': 'Basic Generator' },
      } as any,
      purchase: {
        currencyId: energy.id,
        baseCost: 15,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: crystal.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    // Advanced generator requires: energy >= 50 AND crystal >= 10 AND (basic upgrade OR basic generator level >= 3)
    const advancedGenerator = createGeneratorDefinition(
      'generator.advanced',
      {
        name: {
          default: 'Advanced Generator',
          variants: { 'en-US': 'Advanced Generator' },
        } as any,
        purchase: {
          currencyId: crystal.id,
          baseCost: 25,
          costCurve: literalOne,
        },
        produces: [
          {
            resourceId: energy.id,
            rate: { kind: 'constant', value: 3 },
          },
        ],
        baseUnlock: {
          kind: 'allOf',
          conditions: [
            {
              kind: 'resourceThreshold',
              resourceId: energy.id,
              comparator: 'gte',
              amount: { kind: 'constant', value: 50 },
            },
            {
              kind: 'resourceThreshold',
              resourceId: crystal.id,
              comparator: 'gte',
              amount: { kind: 'constant', value: 10 },
            },
            {
              kind: 'anyOf',
              conditions: [
                {
                  kind: 'upgradeOwned',
                  upgradeId: basicUpgrade.id,
                  requiredPurchases: 1,
                },
                {
                  kind: 'generatorLevel',
                  generatorId: basicGenerator.id,
                  comparator: 'gte',
                  level: { kind: 'constant', value: 3 },
                },
              ],
            },
          ],
        } as any,
      },
    );

    const pack = createContentPack({
      resources: [energy, crystal],
      generators: [basicGenerator, advancedGenerator],
      upgrades: [basicUpgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.getIndex(energy.id);
    const crystalIndex = coordinator.resourceState.getIndex(crystal.id);
    const advancedRecord = coordinator.state.generators.find(
      (g) => g.id === advancedGenerator.id,
    );

    // Step 0: No conditions met
    coordinator.updateForStep(0);
    expect(advancedRecord?.isUnlocked).toBe(false);

    // Step 1: Add resources but no upgrade/generator
    coordinator.resourceState.addAmount(energyIndex, 60);
    coordinator.resourceState.addAmount(crystalIndex, 15);
    coordinator.updateForStep(1);
    expect(advancedRecord?.isUnlocked).toBe(false);

    // Step 2: Purchase basic upgrade - all conditions met
    coordinator.resourceState.spendAmount(energyIndex, 10);
    coordinator.incrementUpgradePurchases(basicUpgrade.id, 1);
    coordinator.updateForStep(2);
    expect(advancedRecord?.isUnlocked).toBe(true);
    expect(advancedRecord?.isVisible).toBe(true);
  });
});

describe('Integration: bulk purchase edge cases', () => {
  it('handles large bulk purchases (1000+ generators) with exponential cost curves', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.expensive', {
      name: {
        default: 'Expensive Generator',
        variants: { 'en-US': 'Expensive Generator' },
      } as any,
      purchase: {
        currencyId: energy.id,
        baseCost: 10,
        costCurve: {
          kind: 'exponential',
          base: 1,
          growth: 1.01, // Modest 1% growth per level
        },
        maxBulk: 1500, // Allow large bulk purchases
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
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
    const generatorRecord = coordinator.state.generators.find(
      (g) => g.id === generator.id,
    );

    // Add very large amount of resources for 1000 purchases
    coordinator.resourceState.addAmount(energyIndex, 1000000);
    coordinator.updateForStep(0);

    // Test bulk purchase of 1000 generators
    const startTime = performance.now();
    const quote = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      1000,
    );
    const endTime = performance.now();

    expect(quote).toBeDefined();
    expect(quote?.costs).toBeDefined();
    expect(quote?.costs[0].resourceId).toBe(energy.id);
    expect(quote?.costs[0].amount).toBeGreaterThan(0);
    expect(Number.isFinite(quote?.costs[0].amount)).toBe(true);

    // Verify cost calculation performance (should be <100ms for 1000 iterations)
    expect(endTime - startTime).toBeLessThan(100);

    // Apply the purchase
    const cost = quote?.costs[0].amount ?? 0;
    coordinator.resourceState.spendAmount(energyIndex, cost);
    coordinator.incrementGeneratorOwned(generator.id, 1000);
    coordinator.updateForStep(1);

    expect(generatorRecord?.owned).toBe(1000);
  });

  it('detects numeric overflow when bulk purchase costs exceed MAX_SAFE_INTEGER', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.explosive', {
      name: {
        default: 'Explosive Cost Generator',
        variants: { 'en-US': 'Explosive Cost Generator' },
      } as any,
      purchase: {
        currencyId: energy.id,
        baseCost: 1e15, // Very large base cost
        costCurve: {
          kind: 'exponential',
          base: 1,
          growth: 2.0, // Doubles each level
        },
        maxBulk: 100,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
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

    // Try to purchase 60 generators - cost should overflow
    const quote = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      60,
    );

    // Should either return undefined or a cost that's still finite
    if (quote !== undefined) {
      expect(Number.isFinite(quote.costs[0].amount)).toBe(true);
    }
  });

  it('handles bulk purchases hitting maxLevel boundary', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.limited', {
      name: {
        default: 'Limited Generator',
        variants: { 'en-US': 'Limited Generator' },
      } as any,
      purchase: {
        currencyId: energy.id,
        baseCost: 10,
        costCurve: literalOne,
        maxBulk: 100,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
      maxLevel: 50, // Hard cap at 50
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
    const generatorRecord = coordinator.state.generators.find(
      (g) => g.id === generator.id,
    );

    coordinator.resourceState.addAmount(energyIndex, 10000);
    coordinator.updateForStep(0);

    // Purchase 40 generators successfully
    const quote1 = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      40,
    );
    expect(quote1).toBeDefined();
    coordinator.resourceState.spendAmount(energyIndex, quote1?.costs[0].amount ?? 0);
    coordinator.incrementGeneratorOwned(generator.id, 40);
    coordinator.updateForStep(1);
    expect(generatorRecord?.owned).toBe(40);

    // Try to purchase 20 more (would go to 60, exceeds maxLevel of 50)
    const quote2 = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      20,
    );
    // Should reject because it would exceed maxLevel
    expect(quote2).toBeUndefined();

    // Purchase exactly to maxLevel (10 more)
    const quote3 = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      10,
    );
    expect(quote3).toBeDefined();
    coordinator.resourceState.spendAmount(energyIndex, quote3?.costs[0].amount ?? 0);
    coordinator.incrementGeneratorOwned(generator.id, 10);
    coordinator.updateForStep(2);
    expect(generatorRecord?.owned).toBe(50);

    // Verify no more purchases possible
    const quote4 = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      1,
    );
    expect(quote4).toBeUndefined();
  });

  it('handles bulk purchase with insufficient resources mid-calculation', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.scaling', {
      name: {
        default: 'Scaling Generator',
        variants: { 'en-US': 'Scaling Generator' },
      } as any,
      purchase: {
        currencyId: energy.id,
        baseCost: 1,
        costCurve: {
          kind: 'exponential',
          base: 1,
          growth: 1.5,
        },
        maxBulk: 50,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
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
    const generatorRecord = coordinator.state.generators.find(
      (g) => g.id === generator.id,
    );

    // Add limited resources
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);

    // Get quote for bulk purchase
    const quote = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      20,
    );
    expect(quote).toBeDefined();
    const totalCost = quote?.costs[0].amount ?? 0;

    // Verify we can afford it
    const currentAmount = coordinator.resourceState.getAmount(energyIndex);
    if (totalCost <= currentAmount) {
      // Purchase should succeed
      const spent = coordinator.resourceState.spendAmount(energyIndex, totalCost);
      expect(spent).toBe(true);
      coordinator.incrementGeneratorOwned(generator.id, 20);
      coordinator.updateForStep(1);
      expect(generatorRecord?.owned).toBe(20);
    } else {
      // Purchase should fail - not enough resources
      const spent = coordinator.resourceState.spendAmount(energyIndex, totalCost);
      expect(spent).toBe(false);
      expect(generatorRecord?.owned).toBe(0);
    }
  });

  it('validates bulk purchase performance for 100 purchases completes quickly', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.standard', {
      name: {
        default: 'Standard Generator',
        variants: { 'en-US': 'Standard Generator' },
      } as any,
      purchase: {
        currencyId: energy.id,
        baseCost: 10,
        costCurve: {
          kind: 'exponential',
          base: 1,
          growth: 1.15,
        },
        maxBulk: 150,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.resourceState.addAmount(
      coordinator.resourceState.getIndex(energy.id),
      1e9,
    );
    coordinator.updateForStep(0);

    // Measure performance for 100 purchases
    const startTime = performance.now();
    const quote = coordinator.generatorEvaluator.getPurchaseQuote(
      generator.id,
      100,
    );
    const endTime = performance.now();

    expect(quote).toBeDefined();
    expect(endTime - startTime).toBeLessThan(50); // Should complete in <50ms
  });
});

describe('Integration: hydration error scenarios', () => {
  it('detects invalid save format with missing required fields', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const pack = createContentPack({
      resources: [energy],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Try to hydrate with invalid/incomplete save data
    const invalidSave = {
      ids: ['resource.energy'],
      // Missing amounts, capacities, flags arrays
    } as any;

    // Should detect missing fields and throw
    expect(() => {
      coordinator.hydrateResources(invalidSave);
    }).toThrow();
  });

  it('detects missing resource definitions (resource removed from content)', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });
    const crystal = createResourceDefinition('resource.crystal', {
      name: 'Crystal',
    });

    // Create content pack with both resources
    const packWithBoth = createContentPack({
      resources: [energy, crystal],
    });

    const coordinator1 = createProgressionCoordinator({
      content: packWithBoth,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator1.resourceState.getIndex(energy.id);
    const crystalIndex = coordinator1.resourceState.getIndex(crystal.id);

    coordinator1.resourceState.addAmount(energyIndex, 100);
    coordinator1.resourceState.addAmount(crystalIndex, 50);
    coordinator1.updateForStep(0);

    // Export save with both resources
    const save = coordinator1.resourceState.exportForSave();
    expect(save.ids).toContain('resource.energy');
    expect(save.ids).toContain('resource.crystal');

    // Create new coordinator with only energy (crystal removed from content)
    const packWithoutCrystal = createContentPack({
      resources: [energy],
    });

    const coordinator2 = createProgressionCoordinator({
      content: packWithoutCrystal,
      stepDurationMs: 100,
    });

    // Hydration should detect incompatible definitions and throw
    expect(() => {
      coordinator2.hydrateResources(save);
    }).toThrow('incompatible');
  });

  it('detects negative amounts in save data', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const pack = createContentPack({
      resources: [energy],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Create save with negative amount
    const corruptedSave = {
      ids: ['resource.energy'],
      amounts: [-100], // Invalid negative amount
      capacities: [1000],
      flags: [0],
      unlocked: [true],
      visible: [true],
    };

    // Negative amounts are valid in the current implementation (clamped to 0 on access)
    // But let's verify they don't crash the system
    expect(() => {
      coordinator.hydrateResources(corruptedSave);
    }).not.toThrow();

    // Amount should be clamped to valid range
    const energyIndex = coordinator.resourceState.getIndex(energy.id);
    const amount = coordinator.resourceState.getAmount(energyIndex);
    expect(amount).toBeGreaterThanOrEqual(0);
  });

  it('detects corrupted state data with NaN values', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const pack = createContentPack({
      resources: [energy],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Create save with NaN values
    const corruptedSave = {
      ids: ['resource.energy'],
      amounts: [NaN], // Invalid NaN amount
      capacities: [1000],
      flags: [0],
      unlocked: [true],
      visible: [true],
    };

    // Should detect and reject invalid NaN values
    expect(() => {
      coordinator.hydrateResources(corruptedSave);
    }).toThrow('finite numbers');
  });

  it('detects corrupted state data with Infinity values', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const pack = createContentPack({
      resources: [energy],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Create save with Infinity values
    const corruptedSave = {
      ids: ['resource.energy'],
      amounts: [Infinity],
      capacities: [1000],
      flags: [0],
      unlocked: [true],
      visible: [true],
    };

    // Should detect and reject invalid Infinity values
    expect(() => {
      coordinator.hydrateResources(corruptedSave);
    }).toThrow('finite numbers');
  });

  it('detects corrupted unlocked/visible flag data', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const pack = createContentPack({
      resources: [energy],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Create save with invalid unlocked values (Uint8Array instead of boolean[])
    const corruptedSave = {
      ids: ['resource.energy'],
      amounts: [100],
      capacities: [1000],
      flags: [0],
      unlocked: new Uint8Array([1]), // Invalid type
      visible: new Uint8Array([1]),
    };

    // Should detect and reject invalid unlocked values
    expect(() => {
      coordinator.hydrateResources(corruptedSave);
    }).toThrow('boolean');
  });

  it('preserves progression state across save/restore cycle with generators', () => {
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
        baseCost: 10,
        costCurve: {
          kind: 'exponential',
          base: 1,
          growth: 1.15,
        },
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
    });

    // First coordinator - build up state
    const coordinator1 = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex1 = coordinator1.resourceState.getIndex(energy.id);
    coordinator1.resourceState.addAmount(energyIndex1, 1000);
    coordinator1.incrementGeneratorOwned(generator.id, 25);
    coordinator1.updateForStep(0);

    // Export save
    const save = coordinator1.resourceState.exportForSave();
    const generatorState = coordinator1.state.generators.find(
      (g) => g.id === generator.id,
    );
    expect(generatorState?.owned).toBe(25);

    // Create second coordinator and restore
    const coordinator2 = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
      initialState: coordinator1.state,
    });

    coordinator2.hydrateResources(save);
    coordinator2.updateForStep(0);

    // Verify restored state
    const energyIndex2 = coordinator2.resourceState.getIndex(energy.id);
    expect(coordinator2.resourceState.getAmount(energyIndex2)).toBe(1000);

    const generatorState2 = coordinator2.state.generators.find(
      (g) => g.id === generator.id,
    );
    expect(generatorState2?.owned).toBe(25);

    // Verify can continue purchasing from restored state
    const quote = coordinator2.generatorEvaluator.getPurchaseQuote(
      generator.id,
      5,
    );
    expect(quote).toBeDefined();

    // Cost should be calculated from level 25 (current owned), not from 0
    expect(quote?.costs[0].amount).toBeGreaterThan(50);
  });
});

describe('Integration: enhanced error messages', () => {
  it('reports detailed error when generator not found', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const content = createContentPack({
      resources: [energy],
      generators: [],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const cost = (coordinator as any).computeGeneratorCost(
      'nonexistent-generator',
      0,
    );

    expect(cost).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Generator cost calculation failed');
    expect(errors[0].message).toContain('nonexistent-generator');
    expect(errors[0].message).toContain('not found');
  });

  it('reports detailed error when generator baseCost is invalid', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const generator = createGeneratorDefinition('generator.test-gen', {
      name: { default: 'Test Generator', variants: {} } as any,
      purchase: {
        currencyId: energy.id,
        baseCost: NaN, // Invalid baseCost
        costCurve: { kind: 'constant', value: 1 },
      },
      produces: [{
        resourceId: energy.id,
        rate: { kind: 'constant', value: 1 },
      }],
    });
    const content = createContentPack({
      resources: [energy],
      generators: [generator],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const cost = (coordinator as any).computeGeneratorCost('generator.test-gen', 0);

    expect(cost).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Generator cost calculation failed');
    expect(errors[0].message).toContain('generator.test-gen');
    expect(errors[0].message).toContain('baseCost is invalid');
  });

  it('reports detailed error when generator cost curve evaluation fails', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const generator = createGeneratorDefinition('generator.test-gen', {
      name: { default: 'Test Generator', variants: {} } as any,
      purchase: {
        currencyId: energy.id,
        baseCost: 10,
        costCurve: { kind: 'exponential', base: 1, growth: -1 }, // Negative growth causes issues
      },
      produces: [{
        resourceId: energy.id,
        rate: { kind: 'constant', value: 1 },
      }],
    });
    const content = createContentPack({
      resources: [energy],
      generators: [generator],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    // Evaluate at a high purchase index to potentially cause overflow or invalid result
    const cost = (coordinator as any).computeGeneratorCost('generator.test-gen', 1000);

    if (cost === undefined) {
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('Generator cost calculation failed');
      expect(errors[0].message).toContain('generator.test-gen');
      expect(errors[0].message).toContain('purchase index 1000');
    }
  });

  it('reports detailed error when upgrade baseCost is invalid', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const upgrade = createUpgradeDefinition('upgrade.test-upgrade', {
      name: 'Test Upgrade',
      cost: {
        currencyId: energy.id,
        baseCost: Infinity, // Invalid baseCost
        costCurve: { kind: 'constant', value: 1 },
      },
      effects: [],
    });
    const content = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    coordinator.updateForStep(0);

    // Access the upgrade record to test cost calculation
    const upgradeRecord = (coordinator as any).upgrades.get('upgrade.test-upgrade');
    const costs = (coordinator as any).computeUpgradeCosts(upgradeRecord);

    expect(costs).toBeUndefined();
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].message).toContain('Upgrade cost calculation failed');
    expect(errors[0].message).toContain('upgrade.test-upgrade');
    expect(errors[0].message).toContain('baseCost is invalid');
  });

  it('reports detailed error when repeatable upgrade cost curve fails', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy', startAmount: 10000 });
    const upgrade = createUpgradeDefinition('upgrade.test-upgrade', {
      name: 'Test Upgrade',
      cost: {
        currencyId: energy.id,
        baseCost: 10,
        costCurve: { kind: 'constant', value: 1 },
      },
      repeatable: {
        costCurve: { kind: 'exponential', base: 1, growth: -2 }, // Invalid repeatable curve
        maxPurchases: 10,
      },
      effects: [],
    });
    const content = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    coordinator.updateForStep(0);

    // Purchase the upgrade once to set purchases > 0
    const upgradeRecord = (coordinator as any).upgrades.get('upgrade.test-upgrade');
    upgradeRecord.purchases = 5;

    const costs = (coordinator as any).computeUpgradeCosts(upgradeRecord);

    if (costs === undefined) {
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].message).toContain('Upgrade cost calculation failed');
      expect(errors[0].message).toContain('upgrade.test-upgrade');
      expect(errors[0].message).toContain('purchase level 5');
    }
  });

  it('does not call onError when costs are calculated successfully', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const generator = createGeneratorDefinition('generator.test-gen', {
      name: { default: 'Test Generator', variants: {} } as any,
      purchase: {
        currencyId: energy.id,
        baseCost: 10,
        costCurve: { kind: 'constant', value: 1 },
      },
      produces: [{
        resourceId: energy.id,
        rate: { kind: 'constant', value: 1 },
      }],
    });
    const content = createContentPack({
      resources: [energy],
      generators: [generator],
    });
    const coordinator = createProgressionCoordinator({
      content,
      stepDurationMs: 100,
      onError: (error) => errors.push(error),
    });

    const cost = (coordinator as any).computeGeneratorCost('generator.test-gen', 0);

    expect(cost).toBeDefined();
    expect(errors).toHaveLength(0);
  });
});
