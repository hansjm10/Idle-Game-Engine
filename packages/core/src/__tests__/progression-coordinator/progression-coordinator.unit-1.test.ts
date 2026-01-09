import type { NumericFormula } from '@idle-engine/content-schema';
import { describe, expect, it } from 'vitest';

import { createProgressionCoordinator } from '../../internals.js';
import {
  createContentPack,
  createGeneratorDefinition,
  createResourceDefinition,
  createUpgradeDefinition,
  literalOne,
} from '../../content-test-helpers.js';
import { buildProgressionSnapshot } from '../../progression.js';
import {
  createCompoundGeneratorUnlockContentPack,
  createCostMultiplierUpgradeContentPack,
  createDuplicateVisibilityConditionContentPack,
  createDynamicFormulaUnlockContentPack,
  createGeneratorLevelUnlockContentPack,
  createGeneratorUnlockContentPack,
  createInvisibleGeneratorContentPack,
  createMultiCostGeneratorContentPack,
  createMultiCostUpgradeContentPack,
  createOrGeneratorUnlockContentPack,
  createPrestigeUnlockHintContentPack,
  createRepeatableContentPack,
  createUnlockHintFallbackContentPack,
  createUpgradeUnlockHintContentPack,
} from './progression-coordinator.test-helpers.js';

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

    const quote = coordinator.upgradeEvaluator?.getPurchaseQuote('upgrade.base-cost');
    expect(quote).toBeDefined();
    expect(quote?.costs).toEqual([{ resourceId: 'resource.currency', amount: 250 }]);
  });

  it('quotes multi-resource generator purchases', () => {
    const coordinator = createProgressionCoordinator({
      content: createMultiCostGeneratorContentPack(),
      stepDurationMs: 100,
    });

    const quote = coordinator.generatorEvaluator.getPurchaseQuote('generator.multi-cost', 1);
    expect(quote).toBeDefined();
    expect(quote?.costs).toEqual([
      { resourceId: 'resource.energy', amount: 10 },
      { resourceId: 'resource.parts', amount: 25 },
    ]);
  });

  it('quotes multi-resource upgrade purchases', () => {
    const coordinator = createProgressionCoordinator({
      content: createMultiCostUpgradeContentPack(),
      stepDurationMs: 100,
    });

    const quote = coordinator.upgradeEvaluator?.getPurchaseQuote('upgrade.multi-cost');
    expect(quote).toBeDefined();
    expect(quote?.costs).toEqual([
      { resourceId: 'resource.energy', amount: 10 },
      { resourceId: 'resource.parts', amount: 25 },
    ]);
  });

  it('does not quote purchases for locked generators', () => {
    const coordinator = createProgressionCoordinator({
      content: createGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    }) as unknown as {
      generatorEvaluator: {
        getPurchaseQuote(id: string, count: number): unknown;
      };
      getGeneratorRecord(id: string): { state: { isUnlocked: boolean } } | undefined;
    };

    const generator = coordinator.getGeneratorRecord('generator.unlockable');
    expect(generator).toBeDefined();
    expect(generator?.state.isUnlocked).toBe(false);

    const quote = coordinator.generatorEvaluator.getPurchaseQuote('generator.unlockable', 1);
    expect(quote).toBeUndefined();
  });

  it('includes unlockHint for generators locked by resource threshold', () => {
    const coordinator = createProgressionCoordinator({
      content: createGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((entry) => entry.id === 'generator.unlockable');
    expect(generator).toBeDefined();
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toBe('Requires Energy >= 15');
  });

  it('includes unlockHint for generators locked by generator level', () => {
    const coordinator = createProgressionCoordinator({
      content: createGeneratorLevelUnlockContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((entry) => entry.id === 'generator.gated');
    expect(generator).toBeDefined();
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toBe('Requires Basic Generator >= 5');
  });

  it('does not duplicate hint when visibilityCondition equals baseUnlock', () => {
    const coordinator = createProgressionCoordinator({
      content: createDuplicateVisibilityConditionContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find(
      (entry) => entry.id === 'generator.duplicate-visibility',
    );
    expect(generator).toBeDefined();
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toBe('Requires Energy >= 10');
  });

  it('includes unlockHint for generators locked by compound and condition', () => {
    const coordinator = createProgressionCoordinator({
      content: createCompoundGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((entry) => entry.id === 'generator.compound');
    expect(generator).toBeDefined();
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toContain('Energy');
    expect(generator?.unlockHint).toContain('Basic Generator');
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
    const generator = snapshot.generators.find((entry) => entry.id === 'generator.compound');
    expect(generator).toBeDefined();
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toBe('Requires Basic Generator >= 5');
  });

  it('includes unlockHint for generators locked by or condition', () => {
    const coordinator = createProgressionCoordinator({
      content: createOrGeneratorUnlockContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((entry) => entry.id === 'generator.or');
    expect(generator).toBeDefined();
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toContain('Requires any of:');
    expect(generator?.unlockHint).toContain('Energy');
    expect(generator?.unlockHint).toContain('Basic Generator');
  });

  it('describes dynamic formula thresholds using current game state', () => {
    const coordinator = createProgressionCoordinator({
      content: createDynamicFormulaUnlockContentPack(),
      stepDurationMs: 100,
    });

    const internalCoordinator = coordinator as unknown as {
      getGeneratorRecord(id: string): { state: { owned: number } } | undefined;
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
    const generator = snapshot.generators.find((entry) => entry.id === 'generator.dynamic');
    expect(generator).toBeDefined();
    expect(generator?.unlocked).toBe(false);
    expect(generator?.unlockHint).toBe('Requires Energy >= 20');
  });

  it('includes unlockHint for upgrades locked by upgrade ownership', () => {
    const coordinator = createProgressionCoordinator({
      content: createUpgradeUnlockHintContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const upgrade = snapshot.upgrades.find((entry) => entry.id === 'upgrade.gated');
    expect(upgrade).toBeDefined();
    expect(upgrade?.status).toBe('locked');
    expect(upgrade?.unlockHint).toBe('Requires owning 1× Starter Upgrade');
  });

  it('includes unlockHint for prestige layers locked by prestige count threshold', () => {
    const coordinator = createProgressionCoordinator({
      content: createPrestigeUnlockHintContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const layer = snapshot.prestigeLayers.find((entry) => entry.id === 'prestige.ascension');
    expect(layer).toBeDefined();
    expect(layer?.status).toBe('locked');
    expect(layer?.unlockHint).toBe('Requires prestige count for Ascension >= 1');
  });

  it('falls back to ids in unlockHint when display names are blank', () => {
    const coordinator = createProgressionCoordinator({
      content: createUnlockHintFallbackContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const snapshot = buildProgressionSnapshot(0, 0, coordinator.state);
    const generator = snapshot.generators.find((entry) => entry.id === 'generator.unlockable');
    expect(generator?.unlockHint).toBe('Requires resource.energy >= 15');

    const upgrade = snapshot.upgrades.find((entry) => entry.id === 'upgrade.gated');
    expect(upgrade?.unlockHint).toBe('Requires owning 1× upgrade.starter');

    const prestigeLayer = snapshot.prestigeLayers.find((entry) => entry.id === 'prestige.ascension');
    expect(prestigeLayer?.unlockHint).toBe(
      'Requires prestige count for prestige.ascension >= 1',
    );
  });

  it('does not quote purchases for invisible generators', () => {
    const coordinator = createProgressionCoordinator({
      content: createInvisibleGeneratorContentPack(),
      stepDurationMs: 100,
    });

    coordinator.updateForStep(0);

    const quote = coordinator.generatorEvaluator.getPurchaseQuote('generator.hidden', 1);
    expect(quote).toBeUndefined();
  });
});
