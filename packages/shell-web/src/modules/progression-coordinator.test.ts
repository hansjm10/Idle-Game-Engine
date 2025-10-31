import type { NormalizedContentPack, NumericFormula } from '@idle-engine/content-schema';
import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from './progression-coordinator.js';

const literalOne: NumericFormula = { kind: 'constant', value: 1 };

function createRepeatableContentPack(): NormalizedContentPack {
  const resource = {
    id: 'resource.test',
    name: 'Test Resource',
    category: 'currency',
    tier: 1,
    startAmount: 0,
    capacity: null,
    visible: true,
    unlocked: true,
    tags: [],
  };

  const repeatableUpgrade = {
    id: 'upgrade.repeatable',
    name: 'Repeatable Upgrade',
    category: 'global',
    tags: [],
    targets: [{ kind: 'global' }],
    cost: {
      currencyId: resource.id,
      baseCost: 1,
      costCurve: literalOne,
    },
    repeatable: {
      costCurve: literalOne,
    },
    prerequisites: [],
    effects: [
      {
        kind: 'grantFlag',
        flagId: 'flag.repeatable',
        value: true,
      },
    ],
  };

  return {
    metadata: {
      id: 'pack.test',
      title: 'Test Pack',
      version: '1.0.0',
      engine: '>=0.0.0',
      authors: [],
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
      tags: [],
      links: [],
    },
    resources: [resource],
    generators: [],
    upgrades: [repeatableUpgrade],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    guildPerks: [],
    runtimeEvents: [],
    lookup: {
      resources: new Map([[resource.id, resource]]),
      generators: new Map(),
      upgrades: new Map([[repeatableUpgrade.id, repeatableUpgrade]]),
      metrics: new Map(),
      achievements: new Map(),
      automations: new Map(),
      transforms: new Map(),
      prestigeLayers: new Map(),
      guildPerks: new Map(),
      runtimeEvents: new Map(),
    },
    serializedLookup: {
      resourceById: { [resource.id]: resource },
      generatorById: {},
      upgradeById: { [repeatableUpgrade.id]: repeatableUpgrade },
      metricById: {},
      achievementById: {},
      automationById: {},
      transformById: {},
      prestigeLayerById: {},
      guildPerkById: {},
      runtimeEventById: {},
    },
    digest: {
      version: 'test',
      hash: 'test-hash',
    },
  } as unknown as NormalizedContentPack;
}

function createGeneratorUnlockContentPack(): NormalizedContentPack {
  const energy = {
    id: 'resource.energy',
    name: 'Energy',
    category: 'currency',
    tier: 1,
    startAmount: 0,
    capacity: null,
    visible: true,
    unlocked: true,
    tags: [],
  };

  const generator = {
    id: 'generator.unlockable',
    name: {
      default: 'Unlockable Generator',
      variants: { 'en-US': 'Unlockable Generator' },
    },
    baseUnlock: {
      kind: 'resourceThreshold',
      resourceId: energy.id,
      comparator: 'gte',
      amount: { kind: 'constant', value: 15 },
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
    consumes: [],
    purchase: {
      currencyId: energy.id,
      baseCost: 25,
      costCurve: {
        kind: 'linear',
        base: 25,
        slope: 0,
      },
    },
    order: 1,
    effects: [],
    tags: [],
  };

  return {
    metadata: {
      id: 'pack.unlockable',
      title: 'Unlockable Pack',
      version: '1.0.0',
      engine: '>=0.0.0',
      authors: [],
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
      tags: [],
      links: [],
    },
    resources: [energy],
    generators: [generator],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    guildPerks: [],
    runtimeEvents: [],
    lookup: {
      resources: new Map([[energy.id, energy]]),
      generators: new Map([[generator.id, generator]]),
      upgrades: new Map(),
      metrics: new Map(),
      achievements: new Map(),
      automations: new Map(),
      transforms: new Map(),
      prestigeLayers: new Map(),
      guildPerks: new Map(),
      runtimeEvents: new Map(),
    },
    serializedLookup: {
      resourceById: { [energy.id]: energy },
      generatorById: { [generator.id]: generator },
      upgradeById: {},
      metricById: {},
      achievementById: {},
      automationById: {},
      transformById: {},
      prestigeLayerById: {},
      guildPerkById: {},
      runtimeEventById: {},
    },
    digest: {
      version: 'test',
      hash: 'test-hash',
    },
  } as unknown as NormalizedContentPack;
}

function createInvisibleGeneratorContentPack(): NormalizedContentPack {
  const energy = {
    id: 'resource.hidden.energy',
    name: 'Hidden Energy',
    category: 'currency',
    tier: 1,
    startAmount: 0,
    capacity: null,
    visible: true,
    unlocked: true,
    tags: [],
  };

  const generator = {
    id: 'generator.hidden',
    name: {
      default: 'Hidden Generator',
      variants: { 'en-US': 'Hidden Generator' },
    },
    baseUnlock: {
      kind: 'always',
    },
    visibilityCondition: {
      kind: 'resourceThreshold',
      resourceId: energy.id,
      comparator: 'gte',
      amount: {
        kind: 'constant',
        value: 1,
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
    consumes: [],
    purchase: {
      currencyId: energy.id,
      baseCost: 10,
      costCurve: {
        kind: 'linear',
        base: 10,
        slope: 0,
      },
    },
    order: 1,
    effects: [],
    tags: [],
  };

  return {
    metadata: {
      id: 'pack.hidden',
      title: 'Hidden Pack',
      version: '1.0.0',
      engine: '>=0.0.0',
      authors: [],
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
      tags: [],
      links: [],
    },
    resources: [energy],
    generators: [generator],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    guildPerks: [],
    runtimeEvents: [],
    lookup: {
      resources: new Map([[energy.id, energy]]),
      generators: new Map([[generator.id, generator]]),
      upgrades: new Map(),
      metrics: new Map(),
      achievements: new Map(),
      automations: new Map(),
      transforms: new Map(),
      prestigeLayers: new Map(),
      guildPerks: new Map(),
      runtimeEvents: new Map(),
    },
    serializedLookup: {
      resourceById: { [energy.id]: energy },
      generatorById: { [generator.id]: generator },
      upgradeById: {},
      metricById: {},
      achievementById: {},
      automationById: {},
      transformById: {},
      prestigeLayerById: {},
      guildPerkById: {},
      runtimeEventById: {},
    },
    digest: {
      version: 'test',
      hash: 'test-hash',
    },
  } as unknown as NormalizedContentPack;
}

function createBaseCostGeneratorContentPack(): NormalizedContentPack {
  const currency = {
    id: 'resource.currency',
    name: 'Currency',
    category: 'currency',
    tier: 1,
    startAmount: 0,
    capacity: null,
    visible: true,
    unlocked: true,
    tags: [],
  };

  const generator = {
    id: 'generator.base-cost',
    name: {
      default: 'Base Cost Generator',
      variants: { 'en-US': 'Base Cost Generator' },
    },
    baseUnlock: { kind: 'always' },
    produces: [
      {
        resourceId: currency.id,
        rate: literalOne,
      },
    ],
    consumes: [],
    purchase: {
      currencyId: currency.id,
      baseCost: 100,
      costCurve: literalOne,
    },
    order: 1,
    effects: [],
    tags: [],
  };

  return {
    metadata: {
      id: 'pack.generator.base-cost',
      title: 'Generator Base Cost Pack',
      version: '1.0.0',
      engine: '>=0.0.0',
      authors: [],
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
      tags: [],
      links: [],
    },
    resources: [currency],
    generators: [generator],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    guildPerks: [],
    runtimeEvents: [],
    lookup: {
      resources: new Map([[currency.id, currency]]),
      generators: new Map([[generator.id, generator]]),
      upgrades: new Map(),
      metrics: new Map(),
      achievements: new Map(),
      automations: new Map(),
      transforms: new Map(),
      prestigeLayers: new Map(),
      guildPerks: new Map(),
      runtimeEvents: new Map(),
    },
    serializedLookup: {
      resourceById: { [currency.id]: currency },
      generatorById: { [generator.id]: generator },
      upgradeById: {},
      metricById: {},
      achievementById: {},
      automationById: {},
      transformById: {},
      prestigeLayerById: {},
      guildPerkById: {},
      runtimeEventById: {},
    },
    digest: {
      version: 'test',
      hash: 'test-hash',
    },
  } as unknown as NormalizedContentPack;
}

function createBaseCostUpgradeContentPack(): NormalizedContentPack {
  const currency = {
    id: 'resource.currency',
    name: 'Currency',
    category: 'currency',
    tier: 1,
    startAmount: 0,
    capacity: null,
    visible: true,
    unlocked: true,
    tags: [],
  };

  const upgrade = {
    id: 'upgrade.base-cost',
    name: 'Base Cost Upgrade',
    category: 'global',
    tags: [],
    targets: [{ kind: 'global' as const }],
    cost: {
      currencyId: currency.id,
      baseCost: 250,
      costCurve: literalOne,
    },
    prerequisites: [],
    effects: [
      {
        kind: 'grantFlag',
        flagId: 'flag.base-cost',
        value: true,
      },
    ],
  };

  return {
    metadata: {
      id: 'pack.upgrade.base-cost',
      title: 'Upgrade Base Cost Pack',
      version: '1.0.0',
      engine: '>=0.0.0',
      authors: [],
      defaultLocale: 'en-US',
      supportedLocales: ['en-US'],
      tags: [],
      links: [],
    },
    resources: [currency],
    generators: [],
    upgrades: [upgrade],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    guildPerks: [],
    runtimeEvents: [],
    lookup: {
      resources: new Map([[currency.id, currency]]),
      generators: new Map(),
      upgrades: new Map([[upgrade.id, upgrade]]),
      metrics: new Map(),
      achievements: new Map(),
      automations: new Map(),
      transforms: new Map(),
      prestigeLayers: new Map(),
      guildPerks: new Map(),
      runtimeEvents: new Map(),
    },
    serializedLookup: {
      resourceById: { [currency.id]: currency },
      generatorById: {},
      upgradeById: { [upgrade.id]: upgrade },
      metricById: {},
      achievementById: {},
      automationById: {},
      transformById: {},
      prestigeLayerById: {},
      guildPerkById: {},
      runtimeEventById: {},
    },
    digest: {
      version: 'test',
      hash: 'test-hash',
    },
  } as unknown as NormalizedContentPack;
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
