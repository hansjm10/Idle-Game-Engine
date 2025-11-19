import { describe, expect, it } from 'vitest';

import { duplicateResourceIdsFixture } from '../../__fixtures__/invalid-content.js';
import { resourceCollectionSchema, resourceDefinitionSchema } from '../resources.js';

describe('resourceDefinitionSchema', () => {
  it('normalizes tags and order while enforcing invariants', () => {
    const definition = resourceDefinitionSchema.parse({
      id: 'Energy',
      name: { default: 'Energy', variants: {} },
      category: 'primary',
      tier: 1,
      startAmount: 10,
      capacity: 100,
      tags: ['Economy', 'economy', 'Production'],
      order: 5,
    });

    expect(definition.id).toBe('energy');
    expect(definition.tags).toEqual(['economy', 'production']);
    expect(definition.startAmount).toBe(10);
    expect(definition.capacity).toBe(100);
  });

  it('defaults economyClassification to soft', () => {
    const definition = resourceDefinitionSchema.parse({
      id: 'energy',
      name: { default: 'Energy', variants: {} },
      category: 'primary',
      tier: 1,
    });

    expect(definition.economyClassification).toBe('soft');
  });

  it('accepts explicit hard economyClassification', () => {
    const definition = resourceDefinitionSchema.parse({
      id: 'crystal',
      name: { default: 'Crystal', variants: {} },
      category: 'currency',
      tier: 1,
      economyClassification: 'hard',
    });

    expect(definition.economyClassification).toBe('hard');
  });

  it('rejects start amounts that exceed capacity', () => {
    expect(() =>
      resourceDefinitionSchema.parse({
        id: 'energy',
        name: { default: 'Energy', variants: {} },
        category: 'primary',
        tier: 1,
        startAmount: 50,
        capacity: 10,
      }),
    ).toThrowError(/cannot exceed capacity/i);
  });
});

describe('resourceCollectionSchema', () => {
  it('rejects duplicate ids', () => {
    expect(() =>
      resourceCollectionSchema.parse([
        {
          id: 'energy',
          name: { default: 'Energy', variants: {} },
          category: 'primary',
          tier: 1,
        },
        {
          id: 'energy',
          name: { default: 'Energy Copy', variants: {} },
          category: 'primary',
          tier: 1,
        },
      ]),
    ).toThrowError(/duplicate resource id/i);
  });

  it('rejects the duplicate ids fixture', () => {
    expect(() =>
      resourceCollectionSchema.parse(duplicateResourceIdsFixture.resources),
    ).toThrowError(/duplicate resource id/i);
  });

  it('sorts by explicit order before id', () => {
    const collection = resourceCollectionSchema.parse([
      {
        id: 'beta',
        name: { default: 'Beta', variants: {} },
        category: 'primary',
        tier: 1,
      },
      {
        id: 'alpha',
        name: { default: 'Alpha', variants: {} },
        category: 'primary',
        tier: 1,
        order: 0,
      },
    ]);

    expect(collection[0].id).toBe('alpha');
    expect(collection[1].id).toBe('beta');
  });
});
