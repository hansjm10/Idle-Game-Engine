import { describe, expect, it } from 'vitest';

import { generatorDefinitionSchema, generatorCollectionSchema } from '../generators.js';

describe('generatorDefinitionSchema', () => {
  const baseGenerator = {
    id: 'reactor',
    name: { default: 'Reactor', variants: {} },
    produces: [{ resourceId: 'energy', rate: { kind: 'constant', value: 1 } }],
    consumes: [],
    purchase: {
      currencyId: 'energy',
      costMultiplier: 10,
      costCurve: { kind: 'constant', value: 1 },
    },
    baseUnlock: { kind: 'always' },
  } as const;

  it('normalizes tags and effects', () => {
    const definition = generatorDefinitionSchema.parse({
      ...baseGenerator,
      tags: ['Production', 'production'],
      effects: [
        {
          kind: 'modifyResourceRate',
          resourceId: 'energy',
          operation: 'add',
          value: { kind: 'constant', value: 2 },
        },
      ],
    });

    expect(definition.tags).toEqual(['production']);
    expect(definition.effects).toHaveLength(1);
  });

  it('defaults initialLevel to 0', () => {
    const definition = generatorDefinitionSchema.parse(baseGenerator);

    expect(definition.initialLevel).toBe(0);
  });

  it('rejects invalid initialLevel values', () => {
    expect(() =>
      generatorDefinitionSchema.parse({
        ...baseGenerator,
        initialLevel: -1,
      }),
    ).toThrowError(/greater than or equal to 0/i);

    expect(() =>
      generatorDefinitionSchema.parse({
        ...baseGenerator,
        initialLevel: 1.5,
      }),
    ).toThrowError(/integer/i);
  });

  it('rejects initialLevel above maxLevel', () => {
    expect(() =>
      generatorDefinitionSchema.parse({
        ...baseGenerator,
        maxLevel: 2,
        initialLevel: 3,
      }),
    ).toThrowError(/initial level cannot exceed generator max level/i);
  });

  it('rejects duplicate resource references in production', () => {
    expect(() =>
      generatorDefinitionSchema.parse({
        ...baseGenerator,
        produces: [
          { resourceId: 'energy', rate: { kind: 'constant', value: 1 } },
          { resourceId: 'energy', rate: { kind: 'constant', value: 2 } },
        ],
      }),
    ).toThrowError(/duplicate resource reference/i);
  });

  it('rejects bulk limits that exceed the generator max level', () => {
    expect(() =>
      generatorDefinitionSchema.parse({
        ...baseGenerator,
        maxLevel: 10,
        purchase: {
          ...baseGenerator.purchase,
          maxBulk: 20,
        },
      }),
    ).toThrowError(/bulk purchase limit/i);
  });

  it('accepts multi-resource generator costs', () => {
    const definition = generatorDefinitionSchema.parse({
      ...baseGenerator,
      purchase: {
        costs: [
          {
            resourceId: 'crystal',
            costMultiplier: 5,
            costCurve: { kind: 'constant', value: 1 },
          },
          {
            resourceId: 'energy',
            costMultiplier: 10,
            costCurve: { kind: 'constant', value: 1 },
          },
        ],
      },
    });

    expect('costs' in definition.purchase).toBe(true);
    if ('costs' in definition.purchase) {
      expect(definition.purchase.costs.map((cost) => cost.resourceId)).toEqual([
        'crystal',
        'energy',
      ]);
    }
  });

  it('rejects duplicate multi-resource generator costs', () => {
    expect(() =>
      generatorDefinitionSchema.parse({
        ...baseGenerator,
        purchase: {
          costs: [
            {
              resourceId: 'energy',
              costMultiplier: 5,
              costCurve: { kind: 'constant', value: 1 },
            },
            {
              resourceId: 'energy',
              costMultiplier: 10,
              costCurve: { kind: 'constant', value: 1 },
            },
          ],
        },
      }),
    ).toThrowError(/duplicate cost resource/i);
  });
});

describe('generatorCollectionSchema', () => {
  it('rejects duplicate generator ids', () => {
    expect(() =>
      generatorCollectionSchema.parse([
        {
          id: 'reactor',
          name: { default: 'Reactor', variants: {} },
          produces: [{ resourceId: 'energy', rate: { kind: 'constant', value: 1 } }],
          consumes: [],
          purchase: {
            currencyId: 'energy',
            costMultiplier: 10,
            costCurve: { kind: 'constant', value: 1 },
          },
          baseUnlock: { kind: 'always' },
        },
        {
          id: 'reactor',
          name: { default: 'Duplicate', variants: {} },
          produces: [{ resourceId: 'energy', rate: { kind: 'constant', value: 1 } }],
          consumes: [],
          purchase: {
            currencyId: 'energy',
            costMultiplier: 5,
            costCurve: { kind: 'constant', value: 1 },
          },
          baseUnlock: { kind: 'always' },
        },
      ]),
    ).toThrowError(/duplicate generator id/i);
  });
});
