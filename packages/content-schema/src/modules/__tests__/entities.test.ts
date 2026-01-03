import { describe, expect, it } from 'vitest';

import { entityCollectionSchema, entityDefinitionSchema } from '../entities.js';

describe('entityDefinitionSchema', () => {
  it('normalizes tags and defaults while enforcing invariants', () => {
    const definition = entityDefinitionSchema.parse({
      id: 'Scout',
      name: { default: 'Scout', variants: {} },
      description: { default: 'Fast reconnaissance unit', variants: {} },
      stats: [
        {
          id: 'Speed',
          name: { default: 'Speed', variants: {} },
          baseValue: { kind: 'constant', value: 10 },
        },
      ],
      tags: ['Recon', 'recon'],
    });

    expect(definition.id).toBe('scout');
    expect(definition.stats[0]?.id).toBe('speed');
    expect(definition.tags).toEqual(['recon']);
    expect(definition.startCount).toBe(0);
    expect(definition.trackInstances).toBe(false);
    expect(definition.visible).toBe(true);
    expect(definition.unlocked).toBe(false);
  });

  it('rejects duplicate stat ids', () => {
    expect(() =>
      entityDefinitionSchema.parse({
        id: 'scout',
        name: { default: 'Scout', variants: {} },
        description: { default: 'Duplicate stats', variants: {} },
        stats: [
          {
            id: 'speed',
            name: { default: 'Speed', variants: {} },
            baseValue: { kind: 'constant', value: 10 },
          },
          {
            id: 'speed',
            name: { default: 'Speed', variants: {} },
            baseValue: { kind: 'constant', value: 12 },
          },
        ],
      }),
    ).toThrowError(/duplicate stat id/i);
  });

  it('rejects stat growth entries that are not declared stats', () => {
    expect(() =>
      entityDefinitionSchema.parse({
        id: 'scout',
        name: { default: 'Scout', variants: {} },
        description: { default: 'Unknown stat growth', variants: {} },
        stats: [
          {
            id: 'speed',
            name: { default: 'Speed', variants: {} },
            baseValue: { kind: 'constant', value: 10 },
          },
        ],
        progression: {
          levelFormula: { kind: 'constant', value: 10 },
          statGrowth: {
            power: { kind: 'constant', value: 1 },
          },
        },
      }),
    ).toThrowError(/unknown stat/i);
  });
});

describe('entityCollectionSchema', () => {
  it('rejects duplicate ids', () => {
    expect(() =>
      entityCollectionSchema.parse([
        {
          id: 'scout',
          name: { default: 'Scout', variants: {} },
          description: { default: 'First', variants: {} },
          stats: [
            {
              id: 'speed',
              name: { default: 'Speed', variants: {} },
              baseValue: { kind: 'constant', value: 10 },
            },
          ],
        },
        {
          id: 'scout',
          name: { default: 'Scout Duplicate', variants: {} },
          description: { default: 'Second', variants: {} },
          stats: [
            {
              id: 'speed',
              name: { default: 'Speed', variants: {} },
              baseValue: { kind: 'constant', value: 10 },
            },
          ],
        },
      ]),
    ).toThrowError(/duplicate entity id/i);
  });

  it('sorts by explicit order before id', () => {
    const collection = entityCollectionSchema.parse([
      {
        id: 'beta',
        name: { default: 'Beta', variants: {} },
        description: { default: 'Beta entity', variants: {} },
        stats: [
          {
            id: 'speed',
            name: { default: 'Speed', variants: {} },
            baseValue: { kind: 'constant', value: 10 },
          },
        ],
      },
      {
        id: 'alpha',
        name: { default: 'Alpha', variants: {} },
        description: { default: 'Alpha entity', variants: {} },
        stats: [
          {
            id: 'speed',
            name: { default: 'Speed', variants: {} },
            baseValue: { kind: 'constant', value: 10 },
          },
        ],
        order: 0,
      },
    ]);

    expect(collection[0].id).toBe('alpha');
    expect(collection[1].id).toBe('beta');
  });
});
