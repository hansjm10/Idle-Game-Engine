import type {
  Condition,
  LocalizedText,
  NormalizedContentPack,
  NumericFormula,
} from '@idle-engine/content-schema';

import {
  createContentPack,
  createGeneratorDefinition,
  createPrestigeLayerDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from './content-test-helpers.js';

export function createRepeatableContentPack(): NormalizedContentPack {
  const resource = createResourceDefinition('resource.test', {
    name: 'Test Resource',
  });

  const repeatableUpgrade = createUpgradeDefinition('upgrade.repeatable', {
    name: 'Repeatable Upgrade',
    cost: {
      currencyId: resource.id,
      costMultiplier: 1,
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

export function createGeneratorUnlockContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });

  const generator = createGeneratorDefinition('generator.unlockable', {
    name: {
      default: 'Unlockable Generator',
      variants: { 'en-US': 'Unlockable Generator' },
    } as LocalizedText,
    purchase: {
      currencyId: energy.id,
      costMultiplier: 25,
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
    } as Condition,
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

export function createUnlockHintFallbackContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: ' ',
  });
  const prestige = createResourceDefinition('resource.prestige', {
    name: ' ',
  });
  const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
    name: ' ',
  });

  const generator = createGeneratorDefinition('generator.unlockable', {
    name: ' ',
    purchase: {
      currencyId: energy.id,
      costMultiplier: 25,
      costCurve: literalOne,
    },
    baseUnlock: {
      kind: 'resourceThreshold',
      resourceId: energy.id,
      comparator: 'gte',
      amount: { kind: 'constant', value: 15 },
    } as Condition,
  });

  const starterUpgrade = createUpgradeDefinition('upgrade.starter', {
    name: ' ',
    cost: {
      currencyId: energy.id,
      costMultiplier: 1,
      costCurve: literalOne,
    },
  });
  const gatedUpgrade = createUpgradeDefinition('upgrade.gated', {
    name: ' ',
    cost: {
      currencyId: energy.id,
      costMultiplier: 2,
      costCurve: literalOne,
    },
    unlockCondition: {
      kind: 'upgradeOwned',
      upgradeId: starterUpgrade.id,
      requiredPurchases: 1,
    } as Condition,
  });

  const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
    name: ' ',
    unlockCondition: {
      kind: 'prestigeCountThreshold',
      prestigeLayerId: 'prestige.ascension',
      comparator: 'gte',
      count: 1,
    } as Condition,
  });

  return createContentPack({
    resources: [energy, prestige, prestigeCount],
    generators: [generator],
    upgrades: [starterUpgrade, gatedUpgrade],
    prestigeLayers: [prestigeLayer],
    metadata: {
      id: 'pack.unlock-hint-fallback',
      title: 'Unlock Hint Fallback Pack',
    },
  });
}

export function createGeneratorLevelUnlockContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });

  const basicGenerator = createGeneratorDefinition('generator.basic', {
    name: 'Basic Generator',
    purchase: {
      currencyId: energy.id,
      costMultiplier: 10,
      costCurve: literalOne,
    },
  });

  const gatedGenerator = createGeneratorDefinition('generator.gated', {
    name: 'Gated Generator',
    purchase: {
      currencyId: energy.id,
      costMultiplier: 25,
      costCurve: literalOne,
    },
    baseUnlock: {
      kind: 'generatorLevel',
      generatorId: basicGenerator.id,
      comparator: 'gte',
      level: { kind: 'constant', value: 5 },
    } as Condition,
  });

  return createContentPack({
    resources: [energy],
    generators: [basicGenerator, gatedGenerator],
    metadata: {
      id: 'pack.gated-generators',
      title: 'Gated Generators Pack',
    },
  });
}

export function createDuplicateVisibilityConditionContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });

  const thresholdCondition: Condition = {
    kind: 'resourceThreshold',
    resourceId: energy.id,
    comparator: 'gte',
    amount: { kind: 'constant', value: 10 },
  };

  const generator = createGeneratorDefinition('generator.duplicate-visibility', {
    name: 'Duplicate Visibility Generator',
    purchase: {
      currencyId: energy.id,
      costMultiplier: 25,
      costCurve: literalOne,
    },
    baseUnlock: thresholdCondition,
    visibilityCondition: thresholdCondition,
  });

  return createContentPack({
    resources: [energy],
    generators: [generator],
    metadata: {
      id: 'pack.duplicate-visibility',
      title: 'Duplicate Visibility Pack',
    },
  });
}

export function createCompoundGeneratorUnlockContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });

  const basicGenerator = createGeneratorDefinition('generator.basic', {
    name: 'Basic Generator',
    purchase: {
      currencyId: energy.id,
      costMultiplier: 10,
      costCurve: literalOne,
    },
  });

  const compoundGenerator = createGeneratorDefinition('generator.compound', {
    name: 'Compound Generator',
    purchase: {
      currencyId: energy.id,
      costMultiplier: 25,
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
          kind: 'generatorLevel',
          generatorId: basicGenerator.id,
          comparator: 'gte',
          level: { kind: 'constant', value: 5 },
        },
      ],
    } as Condition,
  });

  return createContentPack({
    resources: [energy],
    generators: [basicGenerator, compoundGenerator],
    metadata: {
      id: 'pack.compound-generator-unlock',
      title: 'Compound Generator Unlock Pack',
    },
  });
}

export function createUpgradeUnlockHintContentPack(): NormalizedContentPack {
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
  });

  const gatedUpgrade = createUpgradeDefinition('upgrade.gated', {
    name: 'Gated Upgrade',
    cost: {
      currencyId: energy.id,
      costMultiplier: 2,
      costCurve: literalOne,
    },
    unlockCondition: {
      kind: 'upgradeOwned',
      upgradeId: starterUpgrade.id,
      requiredPurchases: 1,
    } as Condition,
  });

  return createContentPack({
    resources: [energy],
    upgrades: [starterUpgrade, gatedUpgrade],
    metadata: {
      id: 'pack.upgrade-unlock-hints',
      title: 'Upgrade Unlock Hint Pack',
    },
  });
}

export function createPrestigeUnlockHintContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });
  const prestige = createResourceDefinition('resource.prestige', {
    name: 'Prestige',
  });
  const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
    name: 'Prestige Count',
  });

  const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
    name: 'Ascension',
    unlockCondition: {
      kind: 'prestigeCountThreshold',
      prestigeLayerId: 'prestige.ascension',
      comparator: 'gte',
      count: 1,
    } as Condition,
  });

  return createContentPack({
    resources: [energy, prestige, prestigeCount],
    prestigeLayers: [prestigeLayer],
    metadata: {
      id: 'pack.prestige-unlock-hints',
      title: 'Prestige Unlock Hint Pack',
    },
  });
}

export function createOrGeneratorUnlockContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });

  const basicGenerator = createGeneratorDefinition('generator.basic', {
    name: 'Basic Generator',
    purchase: {
      currencyId: energy.id,
      costMultiplier: 10,
      costCurve: literalOne,
    },
  });

  const orGenerator = createGeneratorDefinition('generator.or', {
    name: 'Or Generator',
    purchase: {
      currencyId: energy.id,
      costMultiplier: 25,
      costCurve: literalOne,
    },
    baseUnlock: {
      kind: 'anyOf',
      conditions: [
        {
          kind: 'resourceThreshold',
          resourceId: energy.id,
          comparator: 'gte',
          amount: { kind: 'constant', value: 10 },
        },
        {
          kind: 'generatorLevel',
          generatorId: basicGenerator.id,
          comparator: 'gte',
          level: { kind: 'constant', value: 5 },
        },
      ],
    } as Condition,
  });

  return createContentPack({
    resources: [energy],
    generators: [basicGenerator, orGenerator],
    metadata: {
      id: 'pack.or-generator-unlock',
      title: 'Or Generator Unlock Pack',
    },
  });
}

export function createDynamicFormulaUnlockContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });

  const basicGenerator = createGeneratorDefinition('generator.basic', {
    name: 'Basic Generator',
    purchase: {
      currencyId: energy.id,
      costMultiplier: 10,
      costCurve: literalOne,
    },
  });

  const dynamicThreshold: NumericFormula = {
    kind: 'expression',
    expression: {
      kind: 'binary',
      op: 'mul',
      left: {
        kind: 'binary',
        op: 'max',
        left: {
          kind: 'ref',
          target: { type: 'generator', id: basicGenerator.id },
        },
        right: { kind: 'literal', value: 1 },
      },
      right: { kind: 'literal', value: 10 },
    },
  };

  const dynamicGenerator = createGeneratorDefinition('generator.dynamic', {
    name: 'Dynamic Generator',
    purchase: {
      currencyId: energy.id,
      costMultiplier: 25,
      costCurve: literalOne,
    },
    baseUnlock: {
      kind: 'resourceThreshold',
      resourceId: energy.id,
      comparator: 'gte',
      amount: dynamicThreshold,
    } as Condition,
  });

  return createContentPack({
    resources: [energy],
    generators: [basicGenerator, dynamicGenerator],
    metadata: {
      id: 'pack.dynamic-formula-unlock',
      title: 'Dynamic Formula Unlock Pack',
    },
  });
}

export function createInvisibleGeneratorContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.hidden.energy', {
    name: 'Hidden Energy',
  });

  const generator = createGeneratorDefinition('generator.hidden', {
    name: {
      default: 'Hidden Generator',
      variants: { 'en-US': 'Hidden Generator' },
    } as LocalizedText,
    purchase: {
      currencyId: energy.id,
      costMultiplier: 10,
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
    } as Condition,
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

export function createResourceConditionContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.conditional.energy', {
    name: 'Energy',
  });

  const gems = createResourceDefinition('resource.conditional.gems', {
    name: 'Gems',
    unlocked: false,
    visible: false,
    unlockCondition: {
      kind: 'resourceThreshold',
      resourceId: energy.id,
      comparator: 'gte',
      amount: { kind: 'constant', value: 10 },
    } as Condition,
    visibilityCondition: {
      kind: 'resourceThreshold',
      resourceId: energy.id,
      comparator: 'gte',
      amount: { kind: 'constant', value: 20 },
    } as Condition,
  });

  return createContentPack({
    resources: [energy, gems],
    metadata: {
      id: 'pack.resources.conditional',
      title: 'Conditional Resources Pack',
    },
  });
}

export function createCostMultiplierGeneratorContentPack(): NormalizedContentPack {
  const currency = createResourceDefinition('resource.currency', {
    name: 'Currency',
  });

  const generator = createGeneratorDefinition('generator.base-cost', {
    name: {
      default: 'Base Cost Generator',
      variants: { 'en-US': 'Base Cost Generator' },
    } as LocalizedText,
    purchase: {
      currencyId: currency.id,
      costMultiplier: 100,
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

export function createCostMultiplierUpgradeContentPack(): NormalizedContentPack {
  const currency = createResourceDefinition('resource.currency', {
    name: 'Currency',
  });

  const upgrade = createUpgradeDefinition('upgrade.base-cost', {
    name: 'Base Cost Upgrade',
    cost: {
      currencyId: currency.id,
      costMultiplier: 250,
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

export function createMultiCostGeneratorContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });
  const parts = createResourceDefinition('resource.parts', {
    name: 'Parts',
  });

  const generator = createGeneratorDefinition('generator.multi-cost', {
    name: 'Multi Cost Generator',
    purchase: {
      costs: [
        { resourceId: energy.id, costMultiplier: 10, costCurve: literalOne },
        { resourceId: parts.id, costMultiplier: 25, costCurve: literalOne },
      ],
    },
    produces: [{ resourceId: energy.id, rate: literalOne }],
  });

  return createContentPack({
    resources: [energy, parts],
    generators: [generator],
    metadata: {
      id: 'pack.generator.multi-cost',
      title: 'Generator Multi Cost Pack',
    },
  });
}

export function createMultiCostUpgradeContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });
  const parts = createResourceDefinition('resource.parts', {
    name: 'Parts',
  });

  const upgrade = createUpgradeDefinition('upgrade.multi-cost', {
    name: 'Multi Cost Upgrade',
    cost: {
      costs: [
        { resourceId: energy.id, costMultiplier: 10, costCurve: literalOne },
        { resourceId: parts.id, costMultiplier: 25, costCurve: literalOne },
      ],
    },
    effects: [
      {
        kind: 'grantFlag',
        flagId: 'flag.multi-cost',
        value: true,
      },
    ],
  });

  return createContentPack({
    resources: [energy, parts],
    upgrades: [upgrade],
    metadata: {
      id: 'pack.upgrade.multi-cost',
      title: 'Upgrade Multi Cost Pack',
    },
  });
}
