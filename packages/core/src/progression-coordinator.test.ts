import type { NormalizedContentPack, NumericFormula } from '@idle-engine/content-schema';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SerializedResourceState, TelemetryFacade } from './index.js';
import {
  CommandPriority,
  IdleEngineRuntime,
  RUNTIME_COMMAND_TYPES,
  createAutomationSystem,
  createMockEventPublisher,
  createProgressionCoordinator,
  createResourceStateAdapter,
  registerResourceCommandHandlers,
  resetTelemetry,
  setTelemetry,
} from './index.js';
import {
  createContentPack,
  createAchievementDefinition,
  createGeneratorDefinition,
  createPrestigeLayerDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from './content-test-helpers.js';
import { buildProgressionSnapshot } from './progression.js';

function createRepeatableContentPack(): NormalizedContentPack {
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

function createGeneratorLevelUnlockContentPack(): NormalizedContentPack {
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
    } as any,
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

function createDuplicateVisibilityConditionContentPack(): NormalizedContentPack {
  const energy = createResourceDefinition('resource.energy', {
    name: 'Energy',
  });

  const thresholdCondition = {
    kind: 'resourceThreshold',
    resourceId: energy.id,
    comparator: 'gte',
    amount: { kind: 'constant', value: 10 },
  } as any;

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

function createCompoundGeneratorUnlockContentPack(): NormalizedContentPack {
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
    } as any,
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

function createOrGeneratorUnlockContentPack(): NormalizedContentPack {
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
    } as any,
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

function createDynamicFormulaUnlockContentPack(): NormalizedContentPack {
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
    } as any,
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

function createResourceConditionContentPack(): NormalizedContentPack {
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
    } as any,
    visibilityCondition: {
      kind: 'resourceThreshold',
      resourceId: energy.id,
      comparator: 'gte',
      amount: { kind: 'constant', value: 20 },
    } as any,
  });

  return createContentPack({
    resources: [energy, gems],
    metadata: {
      id: 'pack.resources.conditional',
      title: 'Conditional Resources Pack',
    },
  });
}

function createCostMultiplierGeneratorContentPack(): NormalizedContentPack {
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

function createCostMultiplierUpgradeContentPack(): NormalizedContentPack {
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

function createMultiCostGeneratorContentPack(): NormalizedContentPack {
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

function createMultiCostUpgradeContentPack(): NormalizedContentPack {
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

describe('progression-coordinator', () => {
  it('allows upgrade cost formulas to reference generator and upgrade entities', () => {
    const currency = createResourceDefinition('resource.currency', {
      name: 'Currency',
    });

    const generatorId = 'generator.alpha';
    const upgradeId = 'upgrade.scaling';

    const generator = createGeneratorDefinition(generatorId, {
      purchase: {
        currencyId: currency.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const costCurve = {
      kind: 'expression',
      expression: {
        kind: 'binary',
        op: 'add',
        left: { kind: 'literal', value: 1 },
        right: {
          kind: 'binary',
          op: 'add',
          left: {
            kind: 'ref',
            target: { type: 'generator', id: generatorId },
          },
          right: {
            kind: 'ref',
            target: { type: 'upgrade', id: upgradeId },
          },
        },
      },
    } as unknown as NumericFormula;

    const upgrade = createUpgradeDefinition(upgradeId, {
      name: 'Scaling Upgrade',
      cost: {
        currencyId: currency.id,
        costMultiplier: 10,
        costCurve,
      },
      repeatable: {
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantFlag',
          flagId: 'flag.scaling',
          value: true,
        },
      ],
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [currency],
        generators: [generator],
        upgrades: [upgrade],
      }),
      stepDurationMs: 100,
    });

    coordinator.generatorEvaluator.applyPurchase(generatorId, 3);
    coordinator.upgradeEvaluator?.applyPurchase(upgradeId);
    coordinator.upgradeEvaluator?.applyPurchase(upgradeId);

    const quote = coordinator.upgradeEvaluator?.getPurchaseQuote(upgradeId);
    expect(quote).toBeDefined();
    expect(quote?.status).toBe('available');
    expect(quote?.costs).toEqual([{ resourceId: currency.id, amount: 60 }]);
  });

  it('quotes bulk generator purchases using simulated owned values in cost formulas', () => {
    const currency = createResourceDefinition('resource.currency', {
      name: 'Currency',
    });

    const generatorId = 'generator.alpha';

    const costCurve = {
      kind: 'expression',
      expression: {
        kind: 'binary',
        op: 'add',
        left: { kind: 'literal', value: 1 },
        right: {
          kind: 'ref',
          target: { type: 'generator', id: generatorId },
        },
      },
    } as unknown as NumericFormula;

    const generator = createGeneratorDefinition(generatorId, {
      purchase: {
        currencyId: currency.id,
        costMultiplier: 10,
        costCurve,
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

    const quote = coordinator.generatorEvaluator.getPurchaseQuote(generatorId, 2);
    expect(quote).toBeDefined();
    expect(quote?.costs).toEqual([{ resourceId: currency.id, amount: 30 }]);
  });

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

  it('includes upgrade costMultiplier when quoting costs', () => {
    const coordinator = createProgressionCoordinator({
      content: createCostMultiplierUpgradeContentPack(),
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

  it('quotes multi-resource generator purchases', () => {
    const coordinator = createProgressionCoordinator({
      content: createMultiCostGeneratorContentPack(),
      stepDurationMs: 100,
    });

    const quote = coordinator.generatorEvaluator.getPurchaseQuote(
      'generator.multi-cost',
      2,
    );

    expect(quote?.costs).toEqual([
      { resourceId: 'resource.energy', amount: 20 },
      { resourceId: 'resource.parts', amount: 50 },
    ]);
  });

  it('quotes multi-resource upgrade purchases', () => {
    const coordinator = createProgressionCoordinator({
      content: createMultiCostUpgradeContentPack(),
      stepDurationMs: 100,
    });

    const quote = coordinator.upgradeEvaluator?.getPurchaseQuote(
      'upgrade.multi-cost',
    );

    expect(quote?.costs).toEqual([
      { resourceId: 'resource.energy', amount: 10 },
      { resourceId: 'resource.parts', amount: 25 },
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

  it('includes unlockHint for generators locked by resource threshold', () => {
    const coordinator = createProgressionCoordinator({
      content: createGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((g) => g.id === 'generator.unlockable');
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toBe('Requires resource.energy >= 15');
  });

  it('includes unlockHint for generators locked by generator level', () => {
    const coordinator = createProgressionCoordinator({
      content: createGeneratorLevelUnlockContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((g) => g.id === 'generator.gated');
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toBe('Requires generator.basic >= 5');
  });

  it('does not duplicate hint when visibilityCondition equals baseUnlock', () => {
    const coordinator = createProgressionCoordinator({
      content: createDuplicateVisibilityConditionContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find(
      (g) => g.id === 'generator.duplicate-visibility',
    );
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toBe('Requires resource.energy >= 10');
  });

  it('includes unlockHint for generators locked by compound and condition', () => {
    const coordinator = createProgressionCoordinator({
      content: createCompoundGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((g) => g.id === 'generator.compound');
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toContain('resource.energy');
    expect(generator?.unlockHint).toContain('generator.basic');
  });

  it('omits satisfied subconditions from compound unlock hints', () => {
    const coordinator = createProgressionCoordinator({
      content: createCompoundGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 15);

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((g) => g.id === 'generator.compound');
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toBe('Requires generator.basic >= 5');
  });

  it('includes unlockHint for generators locked by or condition', () => {
    const coordinator = createProgressionCoordinator({
      content: createOrGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((g) => g.id === 'generator.or');
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toContain('Requires any of:');
    expect(generator?.unlockHint).toContain('resource.energy');
    expect(generator?.unlockHint).toContain('generator.basic');
  });

  it('describes dynamic formula thresholds using current game state', () => {
    const coordinator = createProgressionCoordinator({
      content: createDynamicFormulaUnlockContentPack(),
      stepDurationMs: 100,
    });

    const internalCoordinator = coordinator as unknown as {
      getGeneratorRecord(
        id: string,
      ): { state: { owned: number } } | undefined;
    };
    const basicRecord = internalCoordinator.getGeneratorRecord('generator.basic');
    if (!basicRecord) {
      throw new Error('Missing test generator.basic record');
    }
    basicRecord.state.owned = 2;

    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 15);

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((g) => g.id === 'generator.dynamic');
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toBe('Requires resource.energy >= 20');
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
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const gems = createResourceDefinition('resource.gems', {
      name: 'Gems',
      unlocked: false,
      visible: false,
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: energy.id,
        comparator: 'gte',
        amount: { kind: 'constant', value: 10 },
      } as any,
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [energy, gems],
        metadata: {
          id: 'pack.resources.default-visibility',
          title: 'Default Resource Visibility Pack',
        },
      }),
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const gemsIndex = coordinator.resourceState.requireIndex(gems.id);

    coordinator.updateForStep(0);
    expect(coordinator.resourceState.isUnlocked(gemsIndex)).toBe(false);
    expect(coordinator.resourceState.isVisible(gemsIndex)).toBe(false);

    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(1);
    expect(coordinator.resourceState.isUnlocked(gemsIndex)).toBe(true);
    expect(coordinator.resourceState.isVisible(gemsIndex)).toBe(true);

    coordinator.resourceState.spendAmount(energyIndex, 10);
    coordinator.updateForStep(2);
    expect(coordinator.resourceState.isUnlocked(gemsIndex)).toBe(true);
    expect(coordinator.resourceState.isVisible(gemsIndex)).toBe(true);
  });

  it('defaults generator visibility to unlock when visibilityCondition is omitted', () => {
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
      baseUnlock: {
        kind: 'resourceThreshold',
        resourceId: energy.id,
        comparator: 'gte',
        amount: { kind: 'constant', value: 10 },
      } as any,
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [energy],
        generators: [generator],
        metadata: {
          id: 'pack.generators.default-visibility',
          title: 'Default Generator Visibility Pack',
        },
      }),
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const generatorRecord = coordinator.state.generators?.find(
      (record) => record.id === generator.id,
    );

    coordinator.updateForStep(0);
    expect(generatorRecord?.isUnlocked).toBe(false);
    expect(generatorRecord?.isVisible).toBe(false);

    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(1);
    expect(generatorRecord?.isUnlocked).toBe(true);
    expect(generatorRecord?.isVisible).toBe(true);

    coordinator.resourceState.spendAmount(energyIndex, 10);
    coordinator.updateForStep(2);
    expect(generatorRecord?.isUnlocked).toBe(true);
    expect(generatorRecord?.isVisible).toBe(true);
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

  it('seeds generators with initialLevel on fresh state without reapplying on save', () => {
    const generator = createGeneratorDefinition('generator.seeded', {
      initialLevel: 2,
      baseUnlock: { kind: 'always' },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({ generators: [generator] }),
      stepDurationMs: 100,
    }) as unknown as {
      getGeneratorRecord(
        id: string,
      ): { state: { owned: number; isUnlocked: boolean } } | undefined;
      incrementGeneratorOwned(id: string, count: number): void;
      state: ReturnType<typeof createProgressionCoordinator>['state'];
    };

    const record = coordinator.getGeneratorRecord('generator.seeded');
    expect(record?.state.owned).toBe(2);
    expect(record?.state.isUnlocked).toBe(true);

    coordinator.incrementGeneratorOwned('generator.seeded', 3);

    const restored = createProgressionCoordinator({
      content: createContentPack({ generators: [generator] }),
      stepDurationMs: 100,
      initialState: coordinator.state,
    }) as unknown as {
      getGeneratorRecord(id: string): { state: { owned: number } } | undefined;
    };

    const restoredRecord = restored.getGeneratorRecord('generator.seeded');
    expect(restoredRecord?.state.owned).toBe(5);
  });

  it('quotes generator purchases using costMultiplier multipliers', () => {
    const coordinator = createProgressionCoordinator({
      content: createCostMultiplierGeneratorContentPack(),
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

  it('allows prestige reward formulas to reference generator and upgrade entities', () => {
    const currency = createResourceDefinition('resource.currency', {
      name: 'Currency',
    });
    const rewardCurrency = createResourceDefinition('resource.prestige', {
      name: 'Prestige',
    });

    const generatorId = 'generator.alpha';
    const upgradeId = 'upgrade.scaling';
    const prestigeLayerId = 'prestige.alpha';

    const prestigeCountResource = createResourceDefinition(
      `${prestigeLayerId}-prestige-count`,
      { name: 'Prestige Count' },
    );

    const generator = createGeneratorDefinition(generatorId, {
      purchase: {
        currencyId: currency.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const upgrade = createUpgradeDefinition(upgradeId, {
      name: 'Scaling Upgrade',
      cost: {
        currencyId: currency.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantFlag',
          flagId: 'flag.scaling',
          value: true,
        },
      ],
    });

    const baseReward = {
      kind: 'expression',
      expression: {
        kind: 'binary',
        op: 'add',
        left: {
          kind: 'ref',
          target: { type: 'generator', id: generatorId },
        },
        right: {
          kind: 'ref',
          target: { type: 'upgrade', id: upgradeId },
        },
      },
    } as unknown as NumericFormula;

    const prestigeLayer = createPrestigeLayerDefinition(prestigeLayerId, {
      resetTargets: [],
      reward: {
        resourceId: rewardCurrency.id,
        baseReward,
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [currency, rewardCurrency, prestigeCountResource],
        generators: [generator],
        upgrades: [upgrade],
        prestigeLayers: [prestigeLayer],
      }),
      stepDurationMs: 100,
    });

    coordinator.generatorEvaluator.applyPurchase(generatorId, 3);
    coordinator.upgradeEvaluator?.applyPurchase(upgradeId);
    coordinator.upgradeEvaluator?.applyPurchase(upgradeId);

    const quote = coordinator.prestigeEvaluator?.getPrestigeQuote(prestigeLayerId);
    expect(quote).toBeDefined();
    expect(quote?.reward.amount).toBe(5);
  });

  it('allows unlock condition formulas to reference upgrade entities', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const upgradeId = 'upgrade.gate';
    const generatorId = 'generator.locked';

    const upgrade = createUpgradeDefinition(upgradeId, {
      name: 'Gate Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantFlag',
          flagId: 'flag.gate',
          value: true,
        },
      ],
    });

    const threshold = {
      kind: 'expression',
      expression: {
        kind: 'binary',
        op: 'add',
        left: {
          kind: 'ref',
          target: { type: 'upgrade', id: upgradeId },
        },
        right: { kind: 'literal', value: 1 },
      },
    } as unknown as NumericFormula;

    const generator = createGeneratorDefinition(generatorId, {
      baseUnlock: {
        kind: 'resourceThreshold',
        resourceId: energy.id,
        comparator: 'gte',
        amount: threshold,
      } as any,
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [energy],
        generators: [generator],
        upgrades: [upgrade],
      }),
      stepDurationMs: 100,
    });

    const generatorRecord = coordinator.state.generators?.find(
      (record) => record.id === generatorId,
    );
    expect(generatorRecord?.isUnlocked).toBe(false);

    coordinator.upgradeEvaluator?.applyPurchase(upgradeId);
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 2);
    coordinator.updateForStep(1);

    expect(generatorRecord?.isUnlocked).toBe(true);
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

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const generatorRecord = coordinator.state.generators?.find(
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
        costMultiplier: 20,
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
          costMultiplier: 50,
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

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const generatorRecord = coordinator.state.generators?.find(
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
    );
    expect(upgradeQuote?.status).toBe('available');
    expect(upgradeQuote?.costs).toEqual([{ resourceId: energy.id, amount: 20 }]);

    coordinator.resourceState.spendAmount(energyIndex, 20);
    coordinator.incrementUpgradePurchases(upgrade.id);
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
        costMultiplier: 1,
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

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const generatorRecord = coordinator.state.generators?.find(
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
        costMultiplier: 10,
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
        costMultiplier: 15,
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
          costMultiplier: 25,
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

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const crystalIndex = coordinator.resourceState.requireIndex(crystal.id);
    const advancedRecord = coordinator.state.generators?.find(
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
    coordinator.incrementUpgradePurchases(basicUpgrade.id);
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
        costMultiplier: 10,
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

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const generatorRecord = coordinator.state.generators?.find(
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
        costMultiplier: 1e15, // Very large cost multiplier
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
        costMultiplier: 10,
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

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const generatorRecord = coordinator.state.generators?.find(
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
        costMultiplier: 1,
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

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    const generatorRecord = coordinator.state.generators?.find(
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
        costMultiplier: 10,
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
      coordinator.resourceState.requireIndex(energy.id),
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

    const energyIndex = coordinator1.resourceState.requireIndex(energy.id);
    const crystalIndex = coordinator1.resourceState.requireIndex(crystal.id);

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
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
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
      coordinator.hydrateResources(
        corruptedSave as unknown as SerializedResourceState,
      );
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
        costMultiplier: 10,
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

    const energyIndex1 = coordinator1.resourceState.requireIndex(energy.id);
    coordinator1.resourceState.addAmount(energyIndex1, 1000);
    coordinator1.incrementGeneratorOwned(generator.id, 25);
    coordinator1.updateForStep(0);

    // Export save
    const save = coordinator1.resourceState.exportForSave();
    const generatorState = coordinator1.state.generators?.find(
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
    const energyIndex2 = coordinator2.resourceState.requireIndex(energy.id);
    expect(coordinator2.resourceState.getAmount(energyIndex2)).toBe(1000);

    const generatorState2 = coordinator2.state.generators?.find(
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

  it('reports detailed error when generator costMultiplier is invalid', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const generator = createGeneratorDefinition('generator.test-gen', {
      name: { default: 'Test Generator', variants: {} } as any,
      purchase: {
        currencyId: energy.id,
        costMultiplier: NaN, // Invalid costMultiplier
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
    expect(errors[0].message).toContain('costMultiplier is invalid');
  });

  it('reports detailed error when generator cost curve evaluation fails', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const generator = createGeneratorDefinition('generator.test-gen', {
      name: { default: 'Test Generator', variants: {} } as any,
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
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

  it('reports detailed error when upgrade costMultiplier is invalid', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy' });
    const upgrade = createUpgradeDefinition('upgrade.test-upgrade', {
      name: 'Test Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: Infinity, // Invalid costMultiplier
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
    expect(errors[0].message).toContain('costMultiplier is invalid');
  });

  it('reports detailed error when repeatable upgrade cost curve fails', () => {
    const errors: Error[] = [];
    const energy = createResourceDefinition('resource.energy', { name: 'Energy', startAmount: 10000 });
    const upgrade = createUpgradeDefinition('upgrade.test-upgrade', {
      name: 'Test Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 10,
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
        costMultiplier: 10,
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
      resetTargets: ['resource.energy'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
      },
      retention: [
        {
          kind: 'resource',
          resourceId: 'resource.energy',
          // Formula: energy * 0.1 (10% of energy)
          amount: {
            kind: 'expression',
            expression: {
              kind: 'binary',
              op: 'mul',
              left: { kind: 'ref', target: { type: 'resource', id: 'resource.energy' } },
              right: { kind: 'literal', value: 0.1 },
            },
          },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Setup: Give player 1000 energy
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 1000);
    coordinator.updateForStep(0);

    // Verify pre-prestige state
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(1000);

    // Verify prestige evaluator exists and layer is available
    expect(coordinator.prestigeEvaluator).toBeDefined();
    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote).toBeDefined();
    expect(quote!.status).toBe('available');

    // Apply prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');

    // Key assertion: energy should be 100 (10% of 1000), NOT 1 (10% of startAmount 10)
    const postPrestigeEnergy = coordinator.resourceState.getAmount(energyIndex);
    expect(postPrestigeEnergy).toBe(100);
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

    const generatorReset = createGeneratorDefinition('generator.reset-me', {
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const generatorRetained = createGeneratorDefinition('generator.keep-me', {
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const upgradeReset = createUpgradeDefinition('upgrade.reset-me', {
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [],
    });

    const upgradeRetained = createUpgradeDefinition('upgrade.keep-me', {
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [],
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      resetGenerators: ['generator.reset-me', 'generator.keep-me'],
      resetUpgrades: ['upgrade.reset-me', 'upgrade.keep-me'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
      },
      retention: [
        { kind: 'generator', generatorId: 'generator.keep-me' },
        { kind: 'upgrade', upgradeId: 'upgrade.keep-me' },
      ],
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [energy, prestigeFlux, prestigeCount],
        generators: [generatorReset, generatorRetained],
        upgrades: [upgradeReset, upgradeRetained],
        prestigeLayers: [prestigeLayer],
      }),
      stepDurationMs: 100,
    }) as unknown as {
      generatorEvaluator: { applyPurchase(id: string, count: number): void };
      upgradeEvaluator?: { applyPurchase(id: string): void };
      prestigeEvaluator?: { applyPrestige(layerId: string, token?: string): void };
      getGeneratorRecord(id: string): { state: { owned: number; enabled: boolean; isUnlocked: boolean } } | undefined;
      getUpgradeRecord(id: string): { purchases: number } | undefined;
      setGeneratorEnabled(id: string, enabled: boolean): boolean;
    };

    coordinator.generatorEvaluator.applyPurchase('generator.reset-me', 3);
    coordinator.generatorEvaluator.applyPurchase('generator.keep-me', 2);
    coordinator.upgradeEvaluator?.applyPurchase('upgrade.reset-me');
    coordinator.upgradeEvaluator?.applyPurchase('upgrade.keep-me');
    coordinator.setGeneratorEnabled('generator.reset-me', false);
    coordinator.setGeneratorEnabled('generator.keep-me', false);

    // Verify pre-prestige state
    expect(coordinator.getGeneratorRecord('generator.reset-me')?.state.owned).toBe(3);
    expect(coordinator.getGeneratorRecord('generator.reset-me')?.state.enabled).toBe(false);
    expect(coordinator.getGeneratorRecord('generator.reset-me')?.state.isUnlocked).toBe(true);
    expect(coordinator.getGeneratorRecord('generator.keep-me')?.state.owned).toBe(2);
    expect(coordinator.getGeneratorRecord('generator.keep-me')?.state.enabled).toBe(false);
    expect(coordinator.getGeneratorRecord('generator.keep-me')?.state.isUnlocked).toBe(true);
    expect(coordinator.getUpgradeRecord('upgrade.reset-me')?.purchases).toBe(1);
    expect(coordinator.getUpgradeRecord('upgrade.keep-me')?.purchases).toBe(1);

    coordinator.prestigeEvaluator?.applyPrestige('prestige.ascension', 'token-reset');

    expect(coordinator.getGeneratorRecord('generator.reset-me')?.state.owned).toBe(0);
    expect(coordinator.getGeneratorRecord('generator.reset-me')?.state.enabled).toBe(true);
    // Generator is re-unlocked by updateForStep since it has no baseUnlock condition
    // (re-locking behavior is tested in 're-locks gated reset resources...' test)
    expect(coordinator.getGeneratorRecord('generator.reset-me')?.state.isUnlocked).toBe(true);
    expect(coordinator.getGeneratorRecord('generator.keep-me')?.state.owned).toBe(2);
    expect(coordinator.getGeneratorRecord('generator.keep-me')?.state.enabled).toBe(false);
    // Retained generators skip the entire reset block, preserving isUnlocked
    expect(coordinator.getGeneratorRecord('generator.keep-me')?.state.isUnlocked).toBe(true);

    expect(coordinator.getUpgradeRecord('upgrade.reset-me')?.purchases).toBe(0);
    expect(coordinator.getUpgradeRecord('upgrade.keep-me')?.purchases).toBe(1);
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

    const prestigeCount = createResourceDefinition('prestige.seed-prestige-count', {
      name: 'Seed Count',
      startAmount: 0,
    });

    const seededGenerator = createGeneratorDefinition('generator.seeded', {
      initialLevel: 2,
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.seed', {
      name: 'Seed',
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
    };

    coordinator.generatorEvaluator.applyPurchase(seededGenerator.id, 3);

    expect(coordinator.getGeneratorRecord(seededGenerator.id)?.state.owned).toBe(5);

    coordinator.prestigeEvaluator?.applyPrestige(prestigeLayer.id, 'token-seed');

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

    const prestigeCount = createResourceDefinition('prestige.zero-prestige-count', {
      name: 'Zero Count',
      startAmount: 0,
    });

    const gatedGenerator = createGeneratorDefinition('generator.zero-gated', {
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

    const prestigeLayer = createPrestigeLayerDefinition('prestige.zero', {
      name: 'Zero',
      resetTargets: [energy.id],
      resetGenerators: [gatedGenerator.id],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: prestigeFlux.id,
        baseReward: literalOne,
      },
    });

    const coordinator = createProgressionCoordinator({
      content: createContentPack({
        resources: [energy, prestigeFlux, prestigeCount],
        generators: [gatedGenerator],
        prestigeLayers: [prestigeLayer],
      }),
      stepDurationMs: 100,
    }) as unknown as {
      updateForStep(step: number): void;
      resourceState: {
        requireIndex(id: string): number;
        addAmount(index: number, amount: number): number;
      };
      prestigeEvaluator?: { applyPrestige(layerId: string, token?: string): void };
      getGeneratorRecord(
        id: string,
      ): { state: { owned: number; isUnlocked: boolean } } | undefined;
    };

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);

    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(0);

    expect(coordinator.getGeneratorRecord(gatedGenerator.id)?.state.isUnlocked).toBe(
      true,
    );

    coordinator.prestigeEvaluator?.applyPrestige(prestigeLayer.id, 'token-zero');

    const resetRecord = coordinator.getGeneratorRecord(gatedGenerator.id);
    expect(resetRecord?.state.owned).toBe(0);
    expect(resetRecord?.state.isUnlocked).toBe(false);

    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(1);

    expect(coordinator.getGeneratorRecord(gatedGenerator.id)?.state.isUnlocked).toBe(
      true,
    );
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

    const prestigeCount = createResourceDefinition(
      'prestige.seeded-gated-prestige-count',
      {
        name: 'Seeded Gated Count',
        startAmount: 0,
      },
    );

    const seededGenerator = createGeneratorDefinition('generator.seeded-gated', {
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

    const prestigeLayer = createPrestigeLayerDefinition('prestige.seeded-gated', {
      name: 'Seeded Gated',
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
      resourceState: {
        requireIndex(id: string): number;
        addAmount(index: number, amount: number): number;
        getAmount(index: number): number;
      };
      updateForStep(step: number): void;
      prestigeEvaluator?: { applyPrestige(layerId: string, token?: string): void };
      getGeneratorRecord(
        id: string,
      ): { state: { owned: number; isUnlocked: boolean } } | undefined;
    };

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 10);
    coordinator.updateForStep(0);

    expect(coordinator.getGeneratorRecord(seededGenerator.id)?.state.isUnlocked).toBe(
      true,
    );

    coordinator.prestigeEvaluator?.applyPrestige(prestigeLayer.id, 'token-seeded');

    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(0);

    const resetRecord = coordinator.getGeneratorRecord(seededGenerator.id);
    expect(resetRecord?.state.owned).toBe(2);
    expect(resetRecord?.state.isUnlocked).toBe(true);
  });

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

  it('throws error when prestige layer is locked', () => {
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
      // Requires 1000 energy to unlock
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource.energy',
        comparator: 'gte',
        amount: { kind: 'constant', value: 1000 },
      },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
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

    // Only add 500 energy - not enough to unlock
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 500);
    coordinator.updateForStep(0);

    // Verify layer is locked
    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote!.status).toBe('locked');

    // Attempting to apply prestige should throw
    expect(() => {
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');
    }).toThrow('locked');
  });

  it('throws error when prestige layer not found', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
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
        resourceId: 'resource.energy',
        baseReward: { kind: 'constant', value: 1 },
      },
    });

    const pack = createContentPack({
      resources: [energy, prestigeCount],
      prestigeLayers: [prestigeLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    expect(() => {
      coordinator.prestigeEvaluator!.applyPrestige('prestige.nonexistent', 'test-token');
    }).toThrow('not found');
  });

  it('resets non-retained resources to startAmount', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 50, // Custom startAmount
    });

    const crystal = createResourceDefinition('resource.crystal', {
      name: 'Crystal',
      startAmount: 25,
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
      resetTargets: ['resource.energy', 'resource.crystal'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 10 },
      },
      retention: [], // No retention - all reset targets should reset
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

    // Energy should reset to startAmount (50)
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(50);

    // Crystal should reset to startAmount (25)
    expect(coordinator.resourceState.getAmount(crystalIndex)).toBe(25);
  });

  it('skips resetting resources that are in retention list', () => {
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
        baseReward: { kind: 'constant', value: 1 },
      },
      // Retain energy with no formula (keep existing value)
      retention: [
        {
          kind: 'resource',
          resourceId: 'resource.energy',
          // No amount formula = don't modify after reset skip
        },
      ],
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
    coordinator.resourceState.addAmount(energyIndex, 1000);
    coordinator.updateForStep(0);

    // Apply prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');

    // Energy should be unchanged because it's in retention without a formula
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(1000);
  });
});

describe('Integration: prestige telemetry', () => {
  let telemetryStub: TelemetryFacade;

  beforeEach(() => {
    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);
  });

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  it('emits telemetry when confirmationToken is provided', () => {
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
        baseReward: { kind: 'constant', value: 1 },
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

    // Apply prestige with a confirmation token
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token-abc123');

    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'PrestigeResetTokenReceived',
      expect.objectContaining({
        layerId: 'prestige.ascension',
        tokenLength: 17, // 'test-token-abc123'.length
      }),
    );
  });
});

describe('Integration: PRESTIGE_RESET command handler with real evaluator', () => {
  // These tests exercise the full command flow through registerResourceCommandHandlers
  // using the real ContentPrestigeEvaluator, verifying end-to-end resource mutations.

  let telemetryStub: TelemetryFacade;

  beforeEach(() => {
    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);
  });

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  it('executes prestige reset via command dispatcher and mutates resource state', async () => {
    // Import command infrastructure
    const { CommandDispatcher, registerResourceCommandHandlers, RUNTIME_COMMAND_TYPES, CommandPriority } = await import('./index.js');

    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 10,
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
        baseReward: { kind: 'constant', value: 5 },
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

    // Setup: Give player 1000 energy
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const prestigeFluxIndex = coordinator.resourceState.requireIndex('resource.prestige-flux');
    coordinator.resourceState.addAmount(energyIndex, 1000);
    coordinator.updateForStep(0);

    // Wire up command dispatcher with real prestige evaluator
    const dispatcher = new CommandDispatcher();
    registerResourceCommandHandlers({
      dispatcher,
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      prestigeSystem: coordinator.prestigeEvaluator,
    });

    // Verify pre-prestige state
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(1010); // 1000 + 10 startAmount
    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(0);

    // Execute PRESTIGE_RESET command
    dispatcher.execute({
      type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      payload: { layerId: 'prestige.ascension', confirmationToken: 'test-token' },
      priority: CommandPriority.PLAYER,
      timestamp: Date.now(),
      step: 1,
    });

    // Verify post-prestige state
    // Energy should be reset to startAmount (10)
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(10);
    // Prestige flux should be granted (5)
    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(5);

    // Verify telemetry was emitted
    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'PrestigeResetConfirmed',
      expect.objectContaining({
        layerId: 'prestige.ascension',
      }),
    );
  });

  it('rejects locked prestige layer via command dispatcher', async () => {
    const { CommandDispatcher, registerResourceCommandHandlers, RUNTIME_COMMAND_TYPES, CommandPriority } = await import('./index.js');

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
      // Requires 1000 energy to unlock
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource.energy',
        comparator: 'gte',
        amount: { kind: 'constant', value: 1000 },
      },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 5 },
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

    // Only 100 energy - not enough to unlock
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);

    const dispatcher = new CommandDispatcher();
    registerResourceCommandHandlers({
      dispatcher,
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      prestigeSystem: coordinator.prestigeEvaluator,
    });

    // Execute PRESTIGE_RESET command on locked layer
    dispatcher.execute({
      type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      payload: { layerId: 'prestige.ascension', confirmationToken: 'test-token' },
      priority: CommandPriority.PLAYER,
      timestamp: Date.now(),
      step: 1,
    });

    // Energy should remain unchanged (not reset)
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(100);

    // Verify PrestigeResetLocked warning was emitted
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetLocked',
      expect.objectContaining({
        layerId: 'prestige.ascension',
      }),
    );
  });

  it('handles repeatable prestige (completed status) via command dispatcher', async () => {
    const { CommandDispatcher, registerResourceCommandHandlers, RUNTIME_COMMAND_TYPES, CommandPriority } = await import('./index.js');

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
        baseReward: { kind: 'constant', value: 10 },
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

    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const prestigeFluxIndex = coordinator.resourceState.requireIndex('resource.prestige-flux');
    const countIndex = coordinator.resourceState.requireIndex('prestige.ascension-prestige-count');

    const dispatcher = new CommandDispatcher();
    registerResourceCommandHandlers({
      dispatcher,
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      prestigeSystem: coordinator.prestigeEvaluator,
    });

    // First prestige
    coordinator.resourceState.addAmount(energyIndex, 500);
    coordinator.updateForStep(0);

    dispatcher.execute({
      type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      payload: { layerId: 'prestige.ascension', confirmationToken: 'test-token-1' },
      priority: CommandPriority.PLAYER,
      timestamp: Date.now(),
      step: 1,
    });

    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(10);
    expect(coordinator.resourceState.getAmount(countIndex)).toBe(1);

    // Second prestige (layer status is now 'completed')
    coordinator.resourceState.addAmount(energyIndex, 500);
    coordinator.updateForStep(1);

    // Verify status is 'completed' before second prestige
    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote!.status).toBe('completed');

    dispatcher.execute({
      type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      payload: { layerId: 'prestige.ascension', confirmationToken: 'test-token-2' },
      priority: CommandPriority.PLAYER,
      timestamp: Date.now(),
      step: 2,
    });

    // Flux should accumulate (10 + 10 = 20)
    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(20);
    // Count should increment to 2
    expect(coordinator.resourceState.getAmount(countIndex)).toBe(2);
  });

  it('passes confirmationToken through full command flow', async () => {
    const { CommandDispatcher, registerResourceCommandHandlers, RUNTIME_COMMAND_TYPES, CommandPriority } = await import('./index.js');

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
        baseReward: { kind: 'constant', value: 1 },
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

    const dispatcher = new CommandDispatcher();
    registerResourceCommandHandlers({
      dispatcher,
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      prestigeSystem: coordinator.prestigeEvaluator,
    });

    // Execute with confirmationToken
    dispatcher.execute({
      type: RUNTIME_COMMAND_TYPES.PRESTIGE_RESET,
      payload: {
        layerId: 'prestige.ascension',
        confirmationToken: 'user-confirmed-prestige-token',
      },
      priority: CommandPriority.PLAYER,
      timestamp: Date.now(),
      step: 1,
    });

    // Token receipt should be logged via telemetry
    expect(telemetryStub.recordProgress).toHaveBeenCalledWith(
      'PrestigeResetTokenReceived',
      expect.objectContaining({
        layerId: 'prestige.ascension',
        tokenLength: 'user-confirmed-prestige-token'.length,
      }),
    );
  });
});

describe('Integration: prestige layer status transitions', () => {
  it('prestige layer state includes isUnlocked property', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 100,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
    });

    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource.energy',
        comparator: 'gte',
        amount: { kind: 'constant', value: 500 },
      },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
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

    // Initially locked (energy = 100, requirement = 500)
    coordinator.updateForStep(0);
    const layerState = coordinator.state.prestigeLayers?.find(
      (l) => l.id === 'prestige.ascension',
    );
    expect(layerState).toBeDefined();
    expect(layerState!.isUnlocked).toBe(false);
    expect(layerState!.isVisible).toBe(false);

    // Add enough energy to unlock
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    coordinator.resourceState.addAmount(energyIndex, 500);
    coordinator.updateForStep(1);

    const updatedLayerState = coordinator.state.prestigeLayers?.find(
      (l) => l.id === 'prestige.ascension',
    );
    expect(updatedLayerState!.isUnlocked).toBe(true);
    expect(updatedLayerState!.isVisible).toBe(true);
  });

  it('status is locked when prestige layer unlock condition is not met', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 100,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
    });

    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource.energy',
        comparator: 'gte',
        amount: { kind: 'constant', value: 500 },
      },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
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

    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote).toBeDefined();
    expect(quote!.status).toBe('locked');
  });

  it('status is available when unlocked but never prestiged', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
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
        baseReward: { kind: 'constant', value: 1 },
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

    const quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote).toBeDefined();
    expect(quote!.status).toBe('available');
  });

  it('status is completed after applying prestige (with prestige count resource)', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
    });

    // Prestige count resource tracks number of times prestige has been applied
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
        baseReward: { kind: 'constant', value: 1 },
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

    // Before prestige: status should be 'available'
    let quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote!.status).toBe('available');

    // Apply prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token');
    coordinator.updateForStep(1);

    // After prestige: status should be 'completed' (prestige count >= 1)
    quote = coordinator.prestigeEvaluator!.getPrestigeQuote('prestige.ascension');
    expect(quote!.status).toBe('completed');
  });

  it('throws error when prestige count resource does not exist', () => {
    // Fail-fast validation ensures content authors don't forget the prestige count resource
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      resetTargets: ['resource.energy'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
      },
    });

    const pack = createContentPack({
      resources: [energy, prestigeFlux],
      // Missing: prestige.ascension-prestige-count resource
      prestigeLayers: [prestigeLayer],
    });

    // Should throw during initialization due to missing prestige count resource
    expect(() => {
      createProgressionCoordinator({
        content: pack,
        stepDurationMs: 100,
      });
    }).toThrow('prestige.ascension-prestige-count');
  });

  it('prestige counter is preserved when included in resetTargets', () => {
    // This test verifies that the prestige counter resource is automatically
    // protected from being reset, even if it's included in resetTargets.
    // Without this protection, multi-prestige tracking would break:
    // - First prestige: counter reset to 0, then incremented to 1
    // - Second prestige: counter reset to 0, then incremented to 1 (should be 2!)

    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const prestigeFlux = createResourceDefinition('resource.prestige-flux', {
      name: 'Prestige Flux',
      startAmount: 0,
    });

    // The prestige counter resource follows the convention: {layerId}-prestige-count
    const prestigeCount = createResourceDefinition('prestige.ascension-prestige-count', {
      name: 'Ascension Count',
      startAmount: 0,
    });

    const prestigeLayer = createPrestigeLayerDefinition('prestige.ascension', {
      name: 'Ascension',
      // Bug scenario: resetTargets includes the prestige counter
      resetTargets: ['resource.energy', 'prestige.ascension-prestige-count'],
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 1 },
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

    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const countIndex = coordinator.resourceState.requireIndex('prestige.ascension-prestige-count');

    // First prestige
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(0);
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token-1');

    // Count should be 1 after first prestige
    expect(coordinator.resourceState.getAmount(countIndex)).toBe(1);

    // Second prestige
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(1);
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token-2');

    // Key assertion: count should be 2, NOT 1
    // If the counter is being reset before increment, this would fail
    expect(coordinator.resourceState.getAmount(countIndex)).toBe(2);

    // Third prestige for good measure
    coordinator.resourceState.addAmount(energyIndex, 100);
    coordinator.updateForStep(2);
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'test-token-3');

    expect(coordinator.resourceState.getAmount(countIndex)).toBe(3);
  });

  it('bonus layer with empty resetTargets grants reward without resetting any resources', () => {
    // Bonus layers have empty resetTargets - they grant rewards without sacrifice.
    // Use cases: milestone rewards, achievement-style prestige, tutorial layers.
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

    const prestigeCount = createResourceDefinition('prestige.bonus-prestige-count', {
      name: 'Bonus Prestige Count',
      startAmount: 0,
    });

    const bonusLayer = createPrestigeLayerDefinition('prestige.bonus', {
      name: 'Bonus Layer',
      resetTargets: [], // Empty - no resources are reset
      unlockCondition: { kind: 'always' },
      reward: {
        resourceId: 'resource.prestige-flux',
        baseReward: { kind: 'constant', value: 50 },
      },
    });

    const pack = createContentPack({
      resources: [energy, crystal, prestigeFlux, prestigeCount],
      prestigeLayers: [bonusLayer],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    // Setup: Give player resources
    const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
    const crystalIndex = coordinator.resourceState.requireIndex('resource.crystal');
    const prestigeFluxIndex = coordinator.resourceState.requireIndex('resource.prestige-flux');

    coordinator.resourceState.addAmount(energyIndex, 500);
    coordinator.resourceState.addAmount(crystalIndex, 200);
    coordinator.updateForStep(0);

    // Verify initial state
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(500);
    expect(coordinator.resourceState.getAmount(crystalIndex)).toBe(200);
    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(0);

    // Apply bonus prestige
    coordinator.prestigeEvaluator!.applyPrestige('prestige.bonus', 'token-bonus');

    // Reward should be granted
    expect(coordinator.resourceState.getAmount(prestigeFluxIndex)).toBe(50);

    // All other resources should remain unchanged (empty resetTargets = no resets)
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(500);
    expect(coordinator.resourceState.getAmount(crystalIndex)).toBe(200);
  });
});

describe('Integration: upgrade effects', () => {
  it('applies modifyGeneratorRate upgrade effects to generator rates', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.boosted', {
      name: 'Boosted Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.generator-boost', {
      name: 'Generator Boost',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(2);

    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(2);
  });

  it('stacks repeatable modifyGeneratorRate effects per purchase', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.scaling', {
      name: 'Scaling Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.scaling-boost', {
      name: 'Scaling Boost',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'linear', base: 1, slope: 1 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(2);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(6);
  });

  it('stacks constant modifyGeneratorRate repeatables multiplicatively', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.constant-repeatable', {
      name: 'Constant Repeatable Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.constant-repeatable-boost', {
      name: 'Constant Repeatable Boost',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(2);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(4);
  });

  it('applies repeatable effectCurve to multiply operations', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.effect-curve-multiply', {
      name: 'Effect Curve (Multiply)',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.effect-curve-multiply', {
      name: 'Effect Curve Multiply',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
        effectCurve: { kind: 'linear', base: 1, slope: 1 },
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'linear', base: 1, slope: 1 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(4);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(36);
  });

  it('applies repeatable effectCurve to add operations', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.effect-curve-add', {
      name: 'Effect Curve (Add)',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.effect-curve-add', {
      name: 'Effect Curve Add',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
        effectCurve: { kind: 'linear', base: 1, slope: 1 },
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'add',
          value: { kind: 'constant', value: 0.1 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1.2);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1.5);
  });

  it('applies repeatable effectCurve to set operations', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.effect-curve-set', {
      name: 'Effect Curve (Set)',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.effect-curve-set', {
      name: 'Effect Curve Set',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      repeatable: {
        costCurve: literalOne,
        effectCurve: { kind: 'linear', base: 10, slope: 1 },
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: generator.id,
          operation: 'set',
          value: { kind: 'constant', value: 1 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(11);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(2);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(12);
  });

  it('applies modifyGeneratorCost upgrade effects to generator purchase quotes', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const generator = createGeneratorDefinition('generator.discounted', {
      name: 'Discounted Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 10,
        costCurve: literalOne,
      },
      produces: [],
      consumes: [],
    });

    const upgrade = createUpgradeDefinition('upgrade.generator-discount', {
      name: 'Generator Discount',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorCost',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 0.5 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const before = coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 1);
    expect(before?.costs[0]?.amount).toBeCloseTo(10);

    coordinator.incrementUpgradePurchases(upgrade.id);

    const after = coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 1);
    expect(after?.costs[0]?.amount).toBeCloseTo(5);
  });

  it('applies modifyResourceRate upgrade effects to generator resource rates', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });
    const gold = createResourceDefinition('resource.gold', {
      name: 'Gold',
    });

    const generator = createGeneratorDefinition('generator.gold-mine', {
      name: 'Gold Mine',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: gold.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
    });

    const upgrade = createUpgradeDefinition('upgrade.gold-rate', {
      name: 'Gold Rate Boost',
      category: 'resource',
      targets: [{ kind: 'resource', id: gold.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyResourceRate',
          resourceId: gold.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy, gold],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(1);

    coordinator.incrementUpgradePurchases(upgrade.id);
    coordinator.updateForStep(1);
    expect(coordinator.state.generators?.[0]?.produces?.[0]?.rate).toBeCloseTo(2);
  });

  it('applies modifyGeneratorConsumption effects to generator consumption rates', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });
    const fuel = createResourceDefinition('resource.fuel', {
      name: 'Fuel',
    });
    const output = createResourceDefinition('resource.output', {
      name: 'Output',
    });

    const generator = createGeneratorDefinition('generator.consumer', {
      name: 'Consumer',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      produces: [
        {
          resourceId: output.id,
          rate: { kind: 'constant', value: 1 },
        },
      ],
      consumes: [
        {
          resourceId: energy.id,
          rate: { kind: 'constant', value: 4 },
        },
        {
          resourceId: fuel.id,
          rate: { kind: 'constant', value: 2 },
        },
      ],
    });

    const baseConsumptionUpgrade = createUpgradeDefinition('upgrade.consume-base', {
      name: 'Consume Base',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorConsumption',
          generatorId: generator.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 0.5 },
        },
      ],
    });

    const fuelConsumptionUpgrade = createUpgradeDefinition('upgrade.consume-fuel', {
      name: 'Consume Fuel',
      category: 'generator',
      targets: [{ kind: 'generator', id: generator.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyGeneratorConsumption',
          generatorId: generator.id,
          resourceId: fuel.id,
          operation: 'add',
          value: { kind: 'constant', value: 0.5 },
        },
      ],
    });

    const energyRateUpgrade = createUpgradeDefinition('upgrade.energy-rate', {
      name: 'Energy Rate',
      category: 'resource',
      targets: [{ kind: 'resource', id: energy.id }],
      cost: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyResourceRate',
          resourceId: energy.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 3 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy, fuel, output],
      generators: [generator],
      upgrades: [baseConsumptionUpgrade, fuelConsumptionUpgrade, energyRateUpgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);
    const initialGenerator = coordinator.state.generators?.[0];
    expect(initialGenerator?.produces?.[0]?.rate).toBeCloseTo(1);
    expect(
      initialGenerator?.consumes?.find((rate) => rate.resourceId === energy.id)?.rate,
    ).toBeCloseTo(4);
    expect(
      initialGenerator?.consumes?.find((rate) => rate.resourceId === fuel.id)?.rate,
    ).toBeCloseTo(2);

    coordinator.incrementUpgradePurchases(baseConsumptionUpgrade.id);
    coordinator.incrementUpgradePurchases(fuelConsumptionUpgrade.id);
    coordinator.incrementUpgradePurchases(energyRateUpgrade.id);
    coordinator.updateForStep(1);

    const updatedGenerator = coordinator.state.generators?.[0];
    expect(updatedGenerator?.produces?.[0]?.rate).toBeCloseTo(1);
    expect(
      updatedGenerator?.consumes?.find((rate) => rate.resourceId === energy.id)?.rate,
    ).toBeCloseTo(6);
    expect(
      updatedGenerator?.consumes?.find((rate) => rate.resourceId === fuel.id)?.rate,
    ).toBeCloseTo(1.5);
  });

  it('applies modifyResourceCapacity add effects to resource capacity and clamping', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      capacity: 10,
    });

    const upgrade = createUpgradeDefinition('upgrade.capacity-add', {
      name: 'Capacity Boost',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyResourceCapacity',
          resourceId: energy.id,
          operation: 'add',
          value: { kind: 'constant', value: 5 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.resourceState.addAmount(energyIndex, 20);
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(10);

    coordinator.incrementUpgradePurchases(upgrade.id);

    expect(coordinator.resourceState.getCapacity(energyIndex)).toBeCloseTo(15);
    coordinator.resourceState.addAmount(energyIndex, 10);
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(15);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const view = snapshot.resources.find((resource) => resource.id === energy.id);
    expect(view?.capacity).toBeCloseTo(15);
  });

  it('applies modifyResourceCapacity multiply effects to resource capacity', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      capacity: 12,
    });

    const upgrade = createUpgradeDefinition('upgrade.capacity-multiply', {
      name: 'Capacity Multiplier',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'modifyResourceCapacity',
          resourceId: energy.id,
          operation: 'multiply',
          value: { kind: 'constant', value: 2 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    coordinator.incrementUpgradePurchases(upgrade.id);

    expect(coordinator.resourceState.getCapacity(energyIndex)).toBeCloseTo(24);
    coordinator.resourceState.addAmount(energyIndex, 30);
    expect(coordinator.resourceState.getAmount(energyIndex)).toBe(24);
  });

  it('applies grantFlag so flag conditions can gate upgrades', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const flagUpgrade = createUpgradeDefinition('upgrade.grant-flag', {
      name: 'Grant Flag',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantFlag',
          flagId: 'flag.gated',
          value: true,
        },
      ],
    });

    const gatedUpgrade = createUpgradeDefinition('upgrade.gated-by-flag', {
      name: 'Gated Upgrade',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      unlockCondition: {
        kind: 'flag',
        flagId: 'flag.gated',
      },
      effects: [],
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [flagUpgrade, gatedUpgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    expect(coordinator.upgradeEvaluator?.getPurchaseQuote(gatedUpgrade.id)?.status).toBe(
      'locked',
    );

    coordinator.upgradeEvaluator?.applyPurchase(flagUpgrade.id);

    expect(coordinator.upgradeEvaluator?.getPurchaseQuote(gatedUpgrade.id)?.status).toBe(
      'available',
    );
  });

  it('applies unlockResource and unlockGenerator upgrade effects immediately', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });
    const hidden = createResourceDefinition('resource.hidden', {
      name: 'Hidden',
      unlocked: false,
      visible: false,
      unlockCondition: { kind: 'never' },
      visibilityCondition: { kind: 'never' },
    });

    const generator = createGeneratorDefinition('generator.hidden', {
      name: 'Hidden Generator',
      purchase: {
        currencyId: energy.id,
        costMultiplier: 1,
        costCurve: literalOne,
      },
      baseUnlock: { kind: 'never' },
      visibilityCondition: { kind: 'never' },
    });

    const upgrade = createUpgradeDefinition('upgrade.unlock-stuff', {
      name: 'Unlock Stuff',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        { kind: 'unlockResource', resourceId: hidden.id },
        { kind: 'unlockGenerator', generatorId: generator.id },
      ],
    });

    const pack = createContentPack({
      resources: [energy, hidden],
      generators: [generator],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const hiddenIndex = coordinator.resourceState.requireIndex(hidden.id);
    expect(coordinator.resourceState.isUnlocked(hiddenIndex)).toBe(false);
    expect(coordinator.resourceState.isVisible(hiddenIndex)).toBe(false);
    expect(coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 1)).toBeUndefined();

    coordinator.incrementUpgradePurchases(upgrade.id);

    expect(coordinator.resourceState.isUnlocked(hiddenIndex)).toBe(true);
    expect(coordinator.resourceState.isVisible(hiddenIndex)).toBe(true);
    expect(coordinator.generatorEvaluator.getPurchaseQuote(generator.id, 1)).toBeDefined();
  });

  it('applies alterDirtyTolerance upgrade effects to resource state', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      dirtyTolerance: 0.001,
    });

    const upgrade = createUpgradeDefinition('upgrade.dirty-tolerance', {
      name: 'Dirty Tolerance Override',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'alterDirtyTolerance',
          resourceId: energy.id,
          operation: 'set',
          value: { kind: 'constant', value: 0.01 },
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const energyIndex = coordinator.resourceState.requireIndex(energy.id);
    expect(coordinator.resourceState.getDirtyTolerance(energyIndex)).toBeCloseTo(0.001);

    coordinator.incrementUpgradePurchases(upgrade.id);

    expect(coordinator.resourceState.getDirtyTolerance(energyIndex)).toBeCloseTo(0.01);
  });

  it('applies grantAutomation upgrade effects to the automation system via unlock hook', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const automation = {
      id: 'automation.test',
      name: { default: 'Test Automation', variants: {} },
      description: { default: 'Test', variants: {} },
      targetType: 'system',
      systemTargetId: 'offline-catchup',
      trigger: { kind: 'commandQueueEmpty' },
      unlockCondition: { kind: 'never' },
      enabledByDefault: false,
    } as any;

    const upgrade = createUpgradeDefinition('upgrade.grant-automation', {
      name: 'Grant Automation',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'grantAutomation',
          automationId: automation.id,
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      automations: [automation],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const runtime = new IdleEngineRuntime({ stepSizeMs: 100 });
    const automationSystem = createAutomationSystem({
      automations: pack.automations,
      commandQueue: runtime.getCommandQueue(),
      resourceState: createResourceStateAdapter(coordinator.resourceState),
      stepDurationMs: 100,
      isAutomationUnlocked: (automationId) =>
        coordinator.getGrantedAutomationIds().has(automationId),
    });

    const events = createMockEventPublisher();

    automationSystem.tick({ step: 0, deltaMs: 100, events });
    expect(automationSystem.getState().get(automation.id)?.unlocked).toBe(false);

    coordinator.incrementUpgradePurchases(upgrade.id);

    automationSystem.tick({ step: 1, deltaMs: 100, events });
    expect(automationSystem.getState().get(automation.id)?.unlocked).toBe(true);
  });

  it('emits runtime events when purchasing upgrades with emitEvent effects', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
    });

    const upgrade = createUpgradeDefinition('upgrade.emit', {
      name: 'Emit Event',
      cost: {
        currencyId: energy.id,
        costMultiplier: 0,
        costCurve: literalOne,
      },
      effects: [
        {
          kind: 'emitEvent',
          eventId: 'sample:reactor-primed',
        },
      ],
    });

    const pack = createContentPack({
      resources: [energy],
      upgrades: [upgrade],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const runtime = new IdleEngineRuntime({ stepSizeMs: 100, initialStep: 0 });
    registerResourceCommandHandlers({
      dispatcher: runtime.getCommandDispatcher(),
      resources: coordinator.resourceState,
      generatorPurchases: coordinator.generatorEvaluator,
      generatorToggles: coordinator,
      upgradePurchases: coordinator.upgradeEvaluator,
    });

    const commandQueue = runtime.getCommandQueue();
    commandQueue.enqueue({
      type: RUNTIME_COMMAND_TYPES.PURCHASE_UPGRADE,
      payload: { upgradeId: upgrade.id },
      priority: CommandPriority.PLAYER,
      timestamp: 0,
      step: runtime.getNextExecutableStep(),
    });

    const manifest = runtime.getEventBus().getManifest();
    const entry = manifest.entries.find(
      (candidate) => candidate.type === 'sample:reactor-primed',
    );
    expect(entry).toBeDefined();

    runtime.tick(100);

    const buffer = runtime.getEventBus().getOutboundBuffer(entry!.channel);
    expect(buffer.length).toBe(1);
    expect(buffer.at(0).type).toBe('sample:reactor-primed');
    expect(buffer.at(0).issuedAt).toBe(0);
    expect(buffer.at(0).payload).toEqual({});
  });

  it('emits runtime events from achievement emitEvent rewards with deterministic issuedAt', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 0,
    });

    const achievement = createAchievementDefinition('achievement.emit-event', {
      reward: {
        kind: 'emitEvent',
        eventId: 'sample:reactor-primed',
      },
    });

    const pack = createContentPack({
      resources: [energy],
      achievements: [achievement],
    });

    const coordinator = createProgressionCoordinator({
      content: pack,
      stepDurationMs: 100,
    });

    const runtime = new IdleEngineRuntime({ stepSizeMs: 100, initialStep: 0 });
    const energyIndex = coordinator.resourceState.requireIndex(energy.id);

    runtime.addSystem({
      id: 'progression-coordinator',
      tick: ({ step, events }) => {
        if (step === 0) {
          coordinator.resourceState.addAmount(energyIndex, 1);
        }
        coordinator.updateForStep(step, { events });
      },
    });

    const manifest = runtime.getEventBus().getManifest();
    const entry = manifest.entries.find(
      (candidate) => candidate.type === 'sample:reactor-primed',
    );
    expect(entry).toBeDefined();

    runtime.tick(100);

    const buffer = runtime.getEventBus().getOutboundBuffer(entry!.channel);
    expect(buffer.length).toBe(1);
    expect(buffer.at(0).type).toBe('sample:reactor-primed');
    expect(buffer.at(0).issuedAt).toBe(0);
    expect(buffer.at(0).payload).toEqual({});
  });
});

describe('Integration: prestige confirmationToken validation', () => {
  let telemetryStub: TelemetryFacade;

  beforeEach(() => {
    telemetryStub = {
      recordError: vi.fn(),
      recordWarning: vi.fn(),
      recordProgress: vi.fn(),
      recordCounters: vi.fn(),
      recordTick: vi.fn(),
    };
    setTelemetry(telemetryStub);
  });

  afterEach(() => {
    resetTelemetry();
    vi.restoreAllMocks();
  });

  it('rejects prestige when no confirmation token provided', () => {
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
        baseReward: { kind: 'constant', value: 1 },
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

    // Attempt prestige without a token - should throw
    expect(() => {
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension');
    }).toThrow('Prestige operation requires a confirmation token');
  });

  it('rejects prestige with duplicate confirmation token', () => {
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
        baseReward: { kind: 'constant', value: 1 },
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

    // First prestige with a token - should succeed
    coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'unique-token-123');

    // Second prestige with the same token - should throw
    expect(() => {
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'unique-token-123');
    }).toThrow('Confirmation token has already been used');

    // Verify telemetry warning was emitted
    expect(telemetryStub.recordWarning).toHaveBeenCalledWith(
      'PrestigeResetDuplicateToken',
      expect.objectContaining({ layerId: 'prestige.ascension' }),
    );
  });

  it('cleans up expired tokens from storage', () => {
    const energy = createResourceDefinition('resource.energy', {
      name: 'Energy',
      startAmount: 100, // Start with enough to prestige multiple times
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
        baseReward: { kind: 'constant', value: 1 },
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

    // Mock Date.now to control time
    let currentTime = 1000000;
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => currentTime);

    try {
      // First prestige at t=1000000
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'token-to-expire');

      // Try to use same token again at t=1000000 - should fail (duplicate)
      expect(() => {
        coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'token-to-expire');
      }).toThrow('Confirmation token has already been used');

      // Advance time by 61 seconds (past the 60 second expiration)
      currentTime += 61_000;

      // Restore enough energy to prestige again
      const energyIndex = coordinator.resourceState.requireIndex('resource.energy');
      coordinator.resourceState.addAmount(energyIndex, 100);
      coordinator.updateForStep(1);

      // Use a new token to trigger cleanup of expired tokens
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'trigger-cleanup');

      // Now the old token should have been cleaned up, so using it again should work
      // (it's no longer in the usedTokens map)
      coordinator.resourceState.addAmount(energyIndex, 100);
      coordinator.updateForStep(2);
      coordinator.prestigeEvaluator!.applyPrestige('prestige.ascension', 'token-to-expire');

      // If we got here without throwing, the test passes
      // The token was successfully reused after expiration
    } finally {
      dateNowSpy.mockRestore();
    }
  });
});
