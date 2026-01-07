import { afterEach, describe, expect, it, vi } from 'vitest';

import { evaluateUpgradeEffects } from './upgrade-effects.js';
import type {
  UpgradeEffectEvaluatorContext,
  UpgradeEffectSource,
} from './upgrade-effects.js';
import type { FormulaEvaluationContext } from '@idle-engine/content-schema';

// Helper to create constant formula in the format expected by evaluateNumericFormula
const constantFormula = (value: number) => ({ kind: 'constant' as const, value });

describe('upgrade-effects', () => {
  const createMockContext = (
    overrides?: Partial<UpgradeEffectEvaluatorContext>,
  ): UpgradeEffectEvaluatorContext => ({
    step: 1,
    createFormulaEvaluationContext: (level: number): FormulaEvaluationContext => ({
      variables: { level },
    }),
    getBaseCapacity: () => 100,
    getBaseDirtyTolerance: () => 0.1,
    onError: vi.fn(),
    ...overrides,
  });

  const createUpgradeSource = (
    effects: any[],
    purchases: number = 1,
    repeatableConfig?: { effectCurve?: any },
  ): UpgradeEffectSource =>
    ({
      definition: {
        id: 'test-upgrade',
        displayName: 'Test Upgrade',
        effects,
        repeatable: repeatableConfig,
        costs: [],
      } as any,
      purchases,
    }) as UpgradeEffectSource;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('evaluateUpgradeEffects', () => {
    it('returns empty maps when no upgrades provided', () => {
      const context = createMockContext();
      const result = evaluateUpgradeEffects([], context);

      expect(result.resourceRateMultipliers.size).toBe(0);
      expect(result.generatorCostMultipliers.size).toBe(0);
      expect(result.resourceCapacityOverrides.size).toBe(0);
      expect(result.unlockedResources.size).toBe(0);
      expect(result.unlockedGenerators.size).toBe(0);
      expect(result.grantedAutomations.size).toBe(0);
      expect(result.grantedFlags.size).toBe(0);
    });

    it('skips upgrades with zero purchase count', () => {
      const context = createMockContext();
      const upgrades = [
        createUpgradeSource([{ kind: 'unlockResource', resourceId: 'gold' }], 0),
      ];

      const result = evaluateUpgradeEffects(upgrades, context);

      expect(result.unlockedResources.size).toBe(0);
    });

    it('skips upgrades with negative purchase count', () => {
      const context = createMockContext();
      const upgrades = [
        createUpgradeSource(
          [{ kind: 'unlockResource', resourceId: 'gold' }],
          -1,
        ),
      ];

      const result = evaluateUpgradeEffects(upgrades, context);

      expect(result.unlockedResources.size).toBe(0);
    });

    describe('unlockResource effect', () => {
      it('adds resource to unlockedResources set', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([{ kind: 'unlockResource', resourceId: 'gold' }]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.unlockedResources.has('gold')).toBe(true);
      });

      it('handles multiple unlock effects', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            { kind: 'unlockResource', resourceId: 'gold' },
            { kind: 'unlockResource', resourceId: 'silver' },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.unlockedResources.has('gold')).toBe(true);
        expect(result.unlockedResources.has('silver')).toBe(true);
      });
    });

    describe('unlockGenerator effect', () => {
      it('adds generator to unlockedGenerators set', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            { kind: 'unlockGenerator', generatorId: 'miner' },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.unlockedGenerators.has('miner')).toBe(true);
      });
    });

    describe('grantAutomation effect', () => {
      it('adds automation to grantedAutomations set', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            { kind: 'grantAutomation', automationId: 'auto-buy' },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.grantedAutomations.has('auto-buy')).toBe(true);
      });
    });

    describe('grantFlag effect', () => {
      it('adds flag to grantedFlags map with specified value', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            { kind: 'grantFlag', flagId: 'has-prestige', value: true },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.grantedFlags.get('has-prestige')).toBe(true);
      });

      it('can grant flag with false value', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            { kind: 'grantFlag', flagId: 'disabled-feature', value: false },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.grantedFlags.get('disabled-feature')).toBe(false);
      });
    });

    describe('modifyGeneratorRate effect', () => {
      it('applies multiply operation to generator rate', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyGeneratorRate',
              generatorId: 'miner',
              operation: 'multiply',
              value: constantFormula(2),
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        // Base is 1, multiply by 2 = 2
        expect(result.generatorRateMultipliers.get('miner')).toBe(2);
      });

      it('stacks multiply operations', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyGeneratorRate',
              generatorId: 'miner',
              operation: 'multiply',
              value: constantFormula(2),
            },
          ]),
          createUpgradeSource([
            {
              kind: 'modifyGeneratorRate',
              generatorId: 'miner',
              operation: 'multiply',
              value: constantFormula(3),
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        // Base 1 * 2 * 3 = 6
        expect(result.generatorRateMultipliers.get('miner')).toBe(6);
      });
    });

    describe('modifyGeneratorCost effect', () => {
      it('applies multiply operation to generator cost', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyGeneratorCost',
              generatorId: 'miner',
              operation: 'multiply',
              value: constantFormula(0.5), // 50% cost reduction
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        // Base is 1, multiply by 0.5 = 0.5
        expect(result.generatorCostMultipliers.get('miner')).toBeCloseTo(0.5);
      });
    });

    describe('modifyResourceRate effect', () => {
      it('applies add operation to resource rate', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyResourceRate',
              resourceId: 'gold',
              operation: 'add',
              value: constantFormula(5),
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        // Base is 1, add 5 = 6
        expect(result.resourceRateMultipliers.get('gold')).toBe(6);
      });

      it('applies set operation to resource rate', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyResourceRate',
              resourceId: 'gold',
              operation: 'set',
              value: constantFormula(10),
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.resourceRateMultipliers.get('gold')).toBe(10);
      });
    });

    describe('modifyResourceCapacity effect', () => {
      it('applies multiply operation to capacity', () => {
        const context = createMockContext({
          getBaseCapacity: () => 100,
        });
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyResourceCapacity',
              resourceId: 'gold',
              operation: 'multiply',
              value: constantFormula(2),
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.resourceCapacityOverrides.get('gold')).toBe(200);
      });

      it('handles Infinity capacity with add/multiply', () => {
        const context = createMockContext({
          getBaseCapacity: () => Infinity,
        });
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyResourceCapacity',
              resourceId: 'gold',
              operation: 'multiply',
              value: constantFormula(2),
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.resourceCapacityOverrides.get('gold')).toBe(Infinity);
      });

      it('set operation overrides Infinity', () => {
        const context = createMockContext({
          getBaseCapacity: () => Infinity,
        });
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyResourceCapacity',
              resourceId: 'gold',
              operation: 'set',
              value: constantFormula(500),
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.resourceCapacityOverrides.get('gold')).toBe(500);
      });

      it('reports error for negative capacity multiplier', () => {
        const onError = vi.fn();
        const context = createMockContext({
          getBaseCapacity: () => 100,
          onError,
        });
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyResourceCapacity',
              resourceId: 'gold',
              operation: 'multiply',
              value: constantFormula(-1),
            },
          ]),
        ];

        evaluateUpgradeEffects(upgrades, context);

        expect(onError).toHaveBeenCalled();
        expect(onError.mock.calls[0][0].message).toContain(
          'negative multiplier',
        );
      });
    });

    describe('modifyGeneratorConsumption effect', () => {
      it('applies modifier to generator consumption', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyGeneratorConsumption',
              generatorId: 'factory',
              operation: 'multiply',
              value: constantFormula(0.8),
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(
          result.generatorConsumptionMultipliers.get('factory'),
        ).toBeCloseTo(0.8);
      });

      it('applies modifier to specific resource consumption', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'modifyGeneratorConsumption',
              generatorId: 'factory',
              resourceId: 'fuel',
              operation: 'multiply',
              value: constantFormula(0.5),
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        const generatorMap =
          result.generatorResourceConsumptionMultipliers.get('factory');
        expect(generatorMap?.get('fuel')).toBeCloseTo(0.5);
      });
    });

    describe('alterDirtyTolerance effect', () => {
      it('applies modifier to dirty tolerance', () => {
        const context = createMockContext({
          getBaseDirtyTolerance: () => 0.1,
        });
        const upgrades = [
          createUpgradeSource([
            {
              kind: 'alterDirtyTolerance',
              resourceId: 'gold',
              operation: 'set',
              value: constantFormula(0.5),
            },
          ]),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        expect(result.dirtyToleranceOverrides.get('gold')).toBeCloseTo(0.5);
      });
    });

    describe('repeatable upgrades', () => {
      it('applies effects multiple times for repeatable upgrades', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource(
            [
              {
                kind: 'modifyGeneratorRate',
                generatorId: 'miner',
                operation: 'multiply',
                value: constantFormula(1.1), // 10% boost per level
              },
            ],
            3, // Purchased 3 times
            { effectCurve: undefined }, // Repeatable without curve
          ),
        ];

        const result = evaluateUpgradeEffects(upgrades, context);

        // Applied 3 times: 1 * 1.1 * 1.1 * 1.1 = 1.331
        expect(result.generatorRateMultipliers.get('miner')).toBeCloseTo(1.331);
      });
    });

    describe('error handling', () => {
      it('handles unknown effect kind gracefully', () => {
        const context = createMockContext();
        const upgrades = [
          createUpgradeSource([
            { kind: 'unknownEffectKind' as any, someData: 'test' },
          ]),
        ];

        // Should not throw
        expect(() => evaluateUpgradeEffects(upgrades, context)).not.toThrow();
      });

      it('returns frozen result object', () => {
        const context = createMockContext();
        const result = evaluateUpgradeEffects([], context);

        expect(Object.isFrozen(result)).toBe(true);
      });
    });
  });
});
