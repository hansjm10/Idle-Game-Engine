import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  BalanceValidationError,
  createContentPackValidator,
  type BalanceValidationOptions,
} from '../index.js';

type TestPack = {
  readonly metadata: Record<string, unknown>;
  readonly resources: Record<string, unknown>[];
  readonly generators: Record<string, unknown>[];
  readonly upgrades: Record<string, unknown>[];
  readonly metrics: Record<string, unknown>[];
  readonly achievements: Record<string, unknown>[];
  readonly automations: Record<string, unknown>[];
  readonly transforms: Record<string, unknown>[];
  readonly prestigeLayers: Record<string, unknown>[];
  readonly guildPerks: Record<string, unknown>[];
  readonly runtimeEvents: Record<string, unknown>[];
};

const propertyConfig: fc.Parameters<unknown> = { seed: 422000, numRuns: 48 };

const createBasePack = (): TestPack => ({
  metadata: {
    id: 'balance-pack',
    title: { default: 'Balance Pack' },
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource:primary',
      name: { default: 'Primary' },
      category: 'primary' as const,
      tier: 1,
      unlocked: true,
    },
    {
      id: 'resource:currency',
      name: { default: 'Currency' },
      category: 'primary' as const,
      tier: 1,
      unlocked: true,
    },
  ],
  generators: [],
  upgrades: [],
  metrics: [],
  achievements: [],
  automations: [],
  transforms: [],
  prestigeLayers: [],
  guildPerks: [],
  runtimeEvents: [],
});

const createValidator = (balance?: BalanceValidationOptions) =>
  createContentPackValidator({
    balance,
  });

describe('balance validation', () => {
  it('throws BalanceValidationError when generator rates go negative', () => {
    const pack = createBasePack();
    pack.generators.push({
      id: 'generator:unstable',
      name: { default: 'Unstable Generator' },
      produces: [
        {
          resourceId: 'resource:primary',
          rate: { kind: 'constant', value: -1 },
        },
      ],
      consumes: [],
      purchase: {
        currencyId: 'resource:currency',
        costMultiplier: 1,
        costCurve: { kind: 'constant', value: 1 },
      },
      baseUnlock: { kind: 'always' as const },
    });

    const validator = createValidator();
    expect(() => validator.parse(pack)).toThrow(BalanceValidationError);
  });

  it('surfaces balanceErrors without throwing when warnOnly is enabled', () => {
    const pack = createBasePack();
    pack.generators.push({
      id: 'generator:warn',
      name: { default: 'Warn Generator' },
      produces: [
        { resourceId: 'resource:primary', rate: { kind: 'constant', value: -2 } },
      ],
      consumes: [],
      purchase: {
        currencyId: 'resource:currency',
        costMultiplier: 1,
        costCurve: { kind: 'constant', value: 1 },
      },
      baseUnlock: { kind: 'always' as const },
    });

    const validator = createValidator({ warnOnly: true });
    const result = validator.parse(pack);
    expect(result.balanceErrors.length).toBeGreaterThan(0);
  });

  it('accepts monotone, non-negative cost curves across sampled purchases', async () => {
    await fc.assert(
      fc.property(
        fc.double({ min: 1, max: 25, noNaN: true }),
        fc.double({ min: 0, max: 2, noNaN: true }),
        (costMultiplier, slope) => {
          const pack = createBasePack();
          pack.generators.push({
            id: 'generator:monotone',
            name: { default: 'Monotone Generator' },
            produces: [
              { resourceId: 'resource:primary', rate: { kind: 'constant', value: 1 } },
            ],
            consumes: [],
            purchase: {
              currencyId: 'resource:currency',
              costMultiplier,
              costCurve: { kind: 'linear', base: 1, slope },
            },
            baseUnlock: { kind: 'always' as const },
          });

          const validator = createValidator({ sampleSize: 8, maxGrowth: 20 });
          const result = validator.parse(pack);
          expect(result.balanceErrors).toHaveLength(0);
        },
      ),
      propertyConfig,
    );
  });

  it('accepts monotone, non-negative multi-cost curves across sampled purchases', () => {
    const pack = createBasePack();
    pack.resources.push({
      id: 'resource:crystal',
      name: { default: 'Crystal' },
      category: 'primary' as const,
      tier: 1,
      unlocked: true,
    });

    pack.generators.push({
      id: 'generator:multi-cost',
      name: { default: 'Multi Cost Generator' },
      produces: [
        { resourceId: 'resource:primary', rate: { kind: 'constant', value: 1 } },
      ],
      consumes: [],
      purchase: {
        costs: [
          {
            resourceId: 'resource:currency',
            costMultiplier: 1,
            costCurve: { kind: 'constant', value: 1 },
          },
          {
            resourceId: 'resource:crystal',
            costMultiplier: 2,
            costCurve: { kind: 'constant', value: 1 },
          },
        ],
      },
      baseUnlock: { kind: 'always' as const },
    });

    const validator = createValidator({ sampleSize: 8, maxGrowth: 20 });
    const result = validator.parse(pack);
    expect(result.balanceErrors).toHaveLength(0);
  });

  it('flags decreasing costs as balance errors', async () => {
    await fc.assert(
      fc.property(
        fc.double({ min: 1, max: 10, noNaN: true }),
        fc.double({ min: 0.1, max: 3, noNaN: true }),
        (costMultiplier, slopeMagnitude) => {
        const pack = createBasePack();
        pack.generators.push({
          id: 'generator:decreasing-cost',
          name: { default: 'Decreasing Cost' },
          produces: [
            { resourceId: 'resource:primary', rate: { kind: 'constant', value: 1 } },
          ],
          consumes: [],
          purchase: {
            currencyId: 'resource:currency',
            costMultiplier,
            costCurve: { kind: 'linear', base: 1, slope: -slopeMagnitude },
          },
          baseUnlock: { kind: 'always' as const },
        });

        const validator = createValidator({ warnOnly: true, sampleSize: 5 });
        const result = validator.parse(pack);
        expect(result.balanceErrors.length).toBeGreaterThan(0);
      }),
      { ...propertyConfig, seed: 422001 },
    );
  });

  it('treats generatorLevel gating on a producer as satisfying unlock ordering', () => {
    const pack = createBasePack();
    pack.resources.push({
      id: 'resource:fuel',
      name: { default: 'Fuel' },
      category: 'primary' as const,
      tier: 1,
      unlocked: false,
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource:primary',
        comparator: 'gte',
        amount: { kind: 'constant', value: 1 },
      },
    });

    pack.generators.push({
      id: 'generator:fuel-pump',
      name: { default: 'Fuel Pump' },
      produces: [
        { resourceId: 'resource:fuel', rate: { kind: 'constant', value: 1 } },
      ],
      consumes: [],
      purchase: {
        currencyId: 'resource:currency',
        costMultiplier: 1,
        costCurve: { kind: 'constant', value: 1 },
      },
      baseUnlock: { kind: 'always' as const },
    });

    pack.generators.push({
      id: 'generator:burner',
      name: { default: 'Burner' },
      produces: [
        { resourceId: 'resource:primary', rate: { kind: 'constant', value: 1 } },
      ],
      consumes: [],
      purchase: {
        currencyId: 'resource:fuel',
        costMultiplier: 1,
        costCurve: { kind: 'constant', value: 1 },
      },
      baseUnlock: {
        kind: 'generatorLevel',
        generatorId: 'generator:fuel-pump',
        comparator: 'gte',
        level: { kind: 'constant', value: 1 },
      },
    });

    const validator = createValidator();
    const result = validator.parse(pack);
    expect(
      result.balanceWarnings.some((warning) => warning.code === 'balance.unlock.ordering'),
    ).toBe(false);
  });

  it('treats flag gating from upgrade-granted flags as satisfying unlock ordering', () => {
    const pack = createBasePack();
    pack.resources.push({
      id: 'resource:fuel',
      name: { default: 'Fuel' },
      category: 'primary' as const,
      tier: 1,
      unlocked: false,
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource:primary',
        comparator: 'gte',
        amount: { kind: 'constant', value: 1 },
      },
    });

    pack.upgrades.push({
      id: 'upgrade:fuel-milestone',
      name: { default: 'Fuel Milestone' },
      category: 'global' as const,
      targets: [{ kind: 'global' as const }],
      cost: {
        currencyId: 'resource:fuel',
        costMultiplier: 1,
        costCurve: { kind: 'constant', value: 1 },
      },
      effects: [{ kind: 'grantFlag', flagId: 'fuel-milestone', value: true }],
      unlockCondition: { kind: 'always' as const },
    });

    pack.generators.push({
      id: 'generator:fuel-consumer',
      name: { default: 'Fuel Consumer' },
      produces: [
        { resourceId: 'resource:primary', rate: { kind: 'constant', value: 1 } },
      ],
      consumes: [{ resourceId: 'resource:fuel', rate: { kind: 'constant', value: 1 } }],
      purchase: {
        currencyId: 'resource:currency',
        costMultiplier: 1,
        costCurve: { kind: 'constant', value: 1 },
      },
      baseUnlock: { kind: 'flag', flagId: 'fuel-milestone' },
    });

    const validator = createValidator();
    const result = validator.parse(pack);
    const orderingWarnings = result.balanceWarnings.filter(
      (warning) => warning.code === 'balance.unlock.ordering',
    );

    expect(
      orderingWarnings.some(
        (warning) => warning.path?.join('.') === 'generators.0.consumes.0.resourceId',
      ),
    ).toBe(false);
  });

  it('treats achievement-granted flags as satisfying unlock ordering', () => {
    const pack = createBasePack();
    pack.resources.push({
      id: 'resource:fuel',
      name: { default: 'Fuel' },
      category: 'primary' as const,
      tier: 1,
      unlocked: false,
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'resource:primary',
        comparator: 'gte',
        amount: { kind: 'constant', value: 1 },
      },
    });

    pack.achievements.push({
      id: 'achievement:fuel-milestone',
      name: { default: 'Fuel Milestone' },
      description: { default: 'Unlock fuel' },
      category: 'progression' as const,
      tier: 'bronze' as const,
      track: {
        kind: 'resource',
        resourceId: 'resource:fuel',
        threshold: { kind: 'constant', value: 1 },
        comparator: 'gte',
      },
      reward: { kind: 'grantFlag', flagId: 'fuel-milestone', value: true },
    });

    pack.generators.push({
      id: 'generator:fuel-consumer',
      name: { default: 'Fuel Consumer' },
      produces: [
        { resourceId: 'resource:primary', rate: { kind: 'constant', value: 1 } },
      ],
      consumes: [{ resourceId: 'resource:fuel', rate: { kind: 'constant', value: 1 } }],
      purchase: {
        currencyId: 'resource:currency',
        costMultiplier: 1,
        costCurve: { kind: 'constant', value: 1 },
      },
      baseUnlock: { kind: 'flag', flagId: 'fuel-milestone' },
    });

    const validator = createValidator();
    const result = validator.parse(pack);
    expect(
      result.balanceWarnings.some((warning) => warning.code === 'balance.unlock.ordering'),
    ).toBe(false);
  });
});
