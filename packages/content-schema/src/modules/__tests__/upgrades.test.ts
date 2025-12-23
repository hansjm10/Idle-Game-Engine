import { describe, expect, it } from 'vitest';

import { upgradeCollectionSchema, upgradeDefinitionSchema } from '../upgrades.js';

describe('upgradeDefinitionSchema', () => {
  const baseUpgrade = {
    id: 'boost',
    name: { default: 'Boost', variants: {} },
    category: 'global' as const,
    targets: [{ kind: 'global' }],
    cost: {
      currencyId: 'energy',
      costMultiplier: 100,
      costCurve: { kind: 'constant', value: 1 },
    },
    effects: [
      {
        kind: 'modifyResourceRate',
        resourceId: 'energy',
        operation: 'add',
        value: { kind: 'constant', value: 5 },
      },
    ],
  };

  it('coerces string prerequisites to upgrade-owned conditions', () => {
    const result = upgradeDefinitionSchema.parse({
      ...baseUpgrade,
      prerequisites: ['core-upgrade'],
    });

    expect(result.prerequisites).toEqual([
      {
        kind: 'upgradeOwned',
        upgradeId: 'core-upgrade',
        requiredPurchases: 1,
      },
    ]);
  });

  it('rejects duplicate targets', () => {
    expect(() =>
      upgradeDefinitionSchema.parse({
        ...baseUpgrade,
        targets: [{ kind: 'global' }, { kind: 'global' }],
      }),
    ).toThrowError(/duplicate upgrade target/i);
  });

  it('requires repeatable upgrades to declare at least one progression parameter', () => {
    expect(() =>
      upgradeDefinitionSchema.parse({
        ...baseUpgrade,
        repeatable: {},
      }),
    ).toThrowError(/repeatable upgrades must declare at least one progression parameter/i);
  });

  it('accepts multi-resource upgrade costs', () => {
    const result = upgradeDefinitionSchema.parse({
      ...baseUpgrade,
      cost: {
        costs: [
          {
            resourceId: 'crystal',
            costMultiplier: 25,
            costCurve: { kind: 'constant', value: 1 },
          },
          {
            resourceId: 'energy',
            costMultiplier: 100,
            costCurve: { kind: 'constant', value: 1 },
          },
        ],
      },
    });

    expect('costs' in result.cost).toBe(true);
    if ('costs' in result.cost) {
      expect(result.cost.costs.map((cost) => cost.resourceId)).toEqual([
        'crystal',
        'energy',
      ]);
    }
  });

  it('rejects duplicate multi-resource upgrade costs', () => {
    expect(() =>
      upgradeDefinitionSchema.parse({
        ...baseUpgrade,
        cost: {
          costs: [
            {
              resourceId: 'energy',
              costMultiplier: 25,
              costCurve: { kind: 'constant', value: 1 },
            },
            {
              resourceId: 'energy',
              costMultiplier: 50,
              costCurve: { kind: 'constant', value: 1 },
            },
          ],
        },
      }),
    ).toThrowError(/duplicate cost resource/i);
  });
});

describe('upgradeCollectionSchema', () => {
  it('rejects duplicate ids', () => {
    expect(() =>
      upgradeCollectionSchema.parse([
        {
          id: 'boost',
          name: { default: 'Boost', variants: {} },
          category: 'global',
          targets: [{ kind: 'global' }],
          cost: {
            currencyId: 'energy',
            costMultiplier: 100,
            costCurve: { kind: 'constant', value: 1 },
          },
          effects: [
            {
              kind: 'modifyResourceRate',
              resourceId: 'energy',
              operation: 'add',
              value: { kind: 'constant', value: 2 },
            },
          ],
        },
        {
          id: 'boost',
          name: { default: 'Duplicate', variants: {} },
          category: 'global',
          targets: [{ kind: 'global' }],
          cost: {
            currencyId: 'energy',
            costMultiplier: 50,
            costCurve: { kind: 'constant', value: 1 },
          },
          effects: [
            {
              kind: 'modifyResourceRate',
              resourceId: 'energy',
              operation: 'add',
              value: { kind: 'constant', value: 1 },
            },
          ],
        },
      ]),
    ).toThrowError(/duplicate upgrade id/i);
  });
});
