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
      baseCost: 10,
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
            baseCost: 10,
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
            baseCost: 5,
            costCurve: { kind: 'constant', value: 1 },
          },
          baseUnlock: { kind: 'always' },
        },
      ]),
    ).toThrowError(/duplicate generator id/i);
  });
});
