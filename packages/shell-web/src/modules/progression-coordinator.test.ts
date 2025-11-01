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
