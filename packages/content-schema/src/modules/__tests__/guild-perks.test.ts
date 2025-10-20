import { describe, expect, it } from 'vitest';

import {
  guildPerkCollectionSchema,
  guildPerkDefinitionSchema,
} from '../guild-perks.js';

describe('guildPerkDefinitionSchema', () => {
  const basePerk = {
    id: 'guild-buffer',
    name: { default: 'Guild Buffer', variants: {} },
    description: { default: 'Improves guild storage.', variants: {} },
    category: 'buff',
    maxRank: 5,
    effects: [
      {
        kind: 'modifyGuildStorage',
        storageId: 'guild-storage',
        operation: 'add',
        value: { kind: 'constant', value: 10 },
      },
    ],
    cost: {
      kind: 'currency',
      resourceId: 'guild-coin',
      amount: { kind: 'constant', value: 100 },
    },
  } as const;

  it('accepts guild-specific effects', () => {
    const perk = guildPerkDefinitionSchema.parse({
      ...basePerk,
    });

    expect(perk.effects).toHaveLength(1);
  });

  it('rejects empty effect lists', () => {
    expect(() =>
      guildPerkDefinitionSchema.parse({
        ...basePerk,
        effects: [],
      }),
    ).toThrowError(/at least one effect/i);
  });
});

describe('guildPerkCollectionSchema', () => {
  it('rejects duplicate guild perk ids', () => {
    expect(() =>
      guildPerkCollectionSchema.parse([
        {
          id: 'guild-buffer',
          name: { default: 'Guild Buffer', variants: {} },
          description: { default: 'Improves storage.', variants: {} },
          category: 'buff',
          maxRank: 5,
          effects: [
            {
              kind: 'modifyGuildStorage',
              storageId: 'guild-storage',
              operation: 'add',
              value: { kind: 'constant', value: 5 },
            },
          ],
          cost: {
            kind: 'currency',
            resourceId: 'guild-coin',
            amount: { kind: 'constant', value: 100 },
          },
        },
        {
          id: 'guild-buffer',
          name: { default: 'Duplicate', variants: {} },
          description: { default: 'Duplicate perk.', variants: {} },
          category: 'buff',
          maxRank: 5,
          effects: [
            {
              kind: 'modifyGuildStorage',
              storageId: 'guild-storage',
              operation: 'add',
              value: { kind: 'constant', value: 5 },
            },
          ],
          cost: {
            kind: 'currency',
            resourceId: 'guild-coin',
            amount: { kind: 'constant', value: 100 },
          },
        },
      ]),
    ).toThrowError(/duplicate guild perk id/i);
  });
});
