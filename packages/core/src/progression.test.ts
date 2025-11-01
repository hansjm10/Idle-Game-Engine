import { describe, expect, it } from 'vitest';

import {
  buildProgressionSnapshot,
  type ProgressionAuthoritativeState,
  type ProgressionGeneratorState,
  type ProgressionUpgradeState,
} from './progression.js';
import {
  createResourceState,
} from './resource-state.js';
import type {
  GeneratorPurchaseEvaluator,
  GeneratorPurchaseQuote,
  UpgradePurchaseEvaluator,
  UpgradePurchaseQuote,
} from './resource-command-handlers.js';

class StubGeneratorEvaluator implements GeneratorPurchaseEvaluator {
  public readonly quotes = new Map<string, GeneratorPurchaseQuote>();

  getPurchaseQuote(
    generatorId: string,
    count: number,
  ): GeneratorPurchaseQuote | undefined {
    if (count !== 1) {
      return undefined;
    }
    return this.quotes.get(generatorId);
  }

  applyPurchase(): void {
    // noop for snapshot tests
  }
}

class StubUpgradeEvaluator implements UpgradePurchaseEvaluator {
  public readonly quotes = new Map<string, UpgradePurchaseQuote>();

  getPurchaseQuote(upgradeId: string): UpgradePurchaseQuote | undefined {
    return this.quotes.get(upgradeId);
  }

  applyPurchase(): void {
    // noop for snapshot tests
  }
}

describe('buildProgressionSnapshot', () => {
  it('derives resource and generator views from authoritative state', () => {
    const stepDurationMs = 100;
    const resourceState = createResourceState([
      {
        id: 'energy',
        startAmount: 120,
        capacity: 200,
        unlocked: true,
        visible: true,
      },
      {
        id: 'crystal',
        startAmount: 10,
        unlocked: true,
        visible: true,
      },
    ]);

    const energyIndex = resourceState.requireIndex('energy');
    const crystalIndex = resourceState.requireIndex('crystal');
    resourceState.applyIncome(energyIndex, 5);
    resourceState.applyExpense(crystalIndex, 1);
    resourceState.finalizeTick(0);

    const generators: ProgressionGeneratorState[] = [
      {
        id: 'sample.reactor',
        displayName: 'Reactor',
        owned: 2,
        isUnlocked: true,
        isVisible: true,
        produces: [{ resourceId: 'energy', rate: 1 }],
        consumes: [{ resourceId: 'crystal', rate: 0.5 }],
        nextPurchaseReadyAtStep: 6,
      },
    ];

    const upgrades: ProgressionUpgradeState[] = [
      {
        id: 'sample.reactor-insulation',
        displayName: 'Reactor Insulation',
        status: 'available',
        isVisible: true,
        unlockHint: 'Collect more energy',
      },
    ];

    const generatorEvaluator = new StubGeneratorEvaluator();
    generatorEvaluator.quotes.set('sample.reactor', {
      generatorId: 'sample.reactor',
      costs: [{ resourceId: 'energy', amount: 42 }],
    });

    const upgradeEvaluator = new StubUpgradeEvaluator();
    upgradeEvaluator.quotes.set('sample.reactor-insulation', {
      upgradeId: 'sample.reactor-insulation',
      status: 'available',
      costs: [{ resourceId: 'energy', amount: 75 }],
    });

    const state: ProgressionAuthoritativeState = {
      stepDurationMs,
      resources: {
        state: resourceState,
        metadata: new Map([
          ['energy', { displayName: 'Energy' }],
          ['crystal', { displayName: 'Crystal' }],
        ]),
      },
      generators,
      generatorPurchases: generatorEvaluator,
      upgrades,
      upgradePurchases: upgradeEvaluator,
    };

    const snapshot = buildProgressionSnapshot(5, 1234, state);

    expect(snapshot.step).toBe(5);
    expect(snapshot.publishedAt).toBe(1234);

    expect(snapshot.resources).toEqual([
      {
        id: 'energy',
        displayName: 'Energy',
        amount: 120,
        isUnlocked: true,
        isVisible: true,
        capacity: 200,
        perTick: 0.5,
      },
      {
        id: 'crystal',
        displayName: 'Crystal',
        amount: 10,
        isUnlocked: true,
        isVisible: true,
        perTick: -0.1,
      },
    ]);

    expect(snapshot.generators).toEqual([
      {
        id: 'sample.reactor',
        displayName: 'Reactor',
        owned: 2,
        isUnlocked: true,
        isVisible: true,
        costs: [{ resourceId: 'energy', amount: 42 }],
        produces: [{ resourceId: 'energy', rate: 1 }],
        consumes: [{ resourceId: 'crystal', rate: 0.5 }],
        nextPurchaseReadyAtStep: 6,
      },
    ]);

    expect(snapshot.upgrades).toEqual([
      {
        id: 'sample.reactor-insulation',
        displayName: 'Reactor Insulation',
        status: 'available',
        costs: [{ resourceId: 'energy', amount: 75 }],
        unlockHint: 'Collect more energy',
        isVisible: true,
      },
    ]);
  });

  it('falls back to serialized resource state when live buffers are unavailable', () => {
    const serialized = {
      ids: ['energy'],
      amounts: [50],
      capacities: [null],
      unlocked: [false],
      visible: [true],
      flags: [0],
    };

    const state: ProgressionAuthoritativeState = {
      stepDurationMs: 100,
      resources: {
        serialized,
      },
    };

    const snapshot = buildProgressionSnapshot(2, 999, state);
    expect(snapshot.resources).toEqual([
      {
        id: 'energy',
        displayName: 'energy',
        amount: 50,
        isUnlocked: false,
        isVisible: true,
        perTick: 0,
      },
    ]);
    expect(snapshot.generators).toHaveLength(0);
    expect(snapshot.upgrades).toHaveLength(0);
  });

  it('defaults nextPurchaseReadyAtStep to current step plus one when omitted', () => {
    const generatorEvaluator = new StubGeneratorEvaluator();
    generatorEvaluator.quotes.set('sample.generator', {
      generatorId: 'sample.generator',
      costs: [{ resourceId: 'energy', amount: 12 }],
    });

    const state: ProgressionAuthoritativeState = {
      stepDurationMs: 50,
      generators: [
        {
          id: 'sample.generator',
          displayName: 'Generator',
          owned: 1,
          isUnlocked: true,
          isVisible: true,
          produces: [],
          consumes: [],
        },
      ],
      generatorPurchases: generatorEvaluator,
    };

    const snapshot = buildProgressionSnapshot(7, 321, state);
    expect(snapshot.generators).toEqual([
      expect.objectContaining({
        id: 'sample.generator',
        nextPurchaseReadyAtStep: 8,
      }),
    ]);
  });

  it('preserves explicit nextPurchaseReadyAtStep when set to current step', () => {
    const generatorEvaluator = new StubGeneratorEvaluator();
    generatorEvaluator.quotes.set('sample.generator', {
      generatorId: 'sample.generator',
      costs: [{ resourceId: 'energy', amount: 12 }],
    });

    const state: ProgressionAuthoritativeState = {
      stepDurationMs: 50,
      generators: [
        {
          id: 'sample.generator',
          displayName: 'Generator',
          owned: 1,
          isUnlocked: true,
          isVisible: true,
          produces: [],
          consumes: [],
          nextPurchaseReadyAtStep: 7,
        },
      ],
      generatorPurchases: generatorEvaluator,
    };

    const snapshot = buildProgressionSnapshot(7, 321, state);
    expect(snapshot.generators).toEqual([
      expect.objectContaining({
        id: 'sample.generator',
        nextPurchaseReadyAtStep: 7,
      }),
    ]);
  });

  it('propagates upgrade state costs when no evaluator is available', () => {
    const state: ProgressionAuthoritativeState = {
      stepDurationMs: 100,
      upgrades: [
        {
          id: 'sample-upgrade',
          displayName: 'Upgrade',
          status: 'locked',
          isVisible: false,
          costs: [{ resourceId: 'energy', amount: 42 }],
        },
      ],
    };

    const snapshot = buildProgressionSnapshot(3, 900, state);
    expect(snapshot.upgrades).toEqual([
      expect.objectContaining({
        id: 'sample-upgrade',
        costs: [{ resourceId: 'energy', amount: 42 }],
      }),
    ]);
  });

  it('uses upgrade evaluator costs when available', () => {
    const upgradeEvaluator = new StubUpgradeEvaluator();
    upgradeEvaluator.quotes.set('sample-upgrade', {
      upgradeId: 'sample-upgrade',
      status: 'available',
      costs: [{ resourceId: 'crystal', amount: 100 }],
    });

    const state: ProgressionAuthoritativeState = {
      stepDurationMs: 100,
      upgrades: [
        {
          id: 'sample-upgrade',
          displayName: 'Upgrade',
          status: 'available',
          isVisible: true,
          costs: [{ resourceId: 'energy', amount: 42 }],
        },
      ],
      upgradePurchases: upgradeEvaluator,
    };

    const snapshot = buildProgressionSnapshot(3, 900, state);
    expect(snapshot.upgrades).toEqual([
      expect.objectContaining({
        id: 'sample-upgrade',
        costs: [{ resourceId: 'crystal', amount: 100 }],
      }),
    ]);
  });
});
