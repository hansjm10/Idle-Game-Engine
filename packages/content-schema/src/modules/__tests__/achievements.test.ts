import { describe, expect, it } from 'vitest';

import {
  achievementCollectionSchema,
  achievementDefinitionSchema,
} from '../achievements.js';

describe('achievementDefinitionSchema', () => {
  const baseAchievement = {
    id: 'first-prestige',
    name: { default: 'First Prestige', variants: {} },
    description: { default: 'Prestige once.', variants: {} },
    category: 'prestige',
    tier: 'bronze',
    track: {
      kind: 'resource',
      resourceId: 'prestige-points',
      threshold: { kind: 'constant', value: 10 },
    },
  } as const;

  it('derives progress target from the primary track when omitted', () => {
    const definition = achievementDefinitionSchema.parse({
      ...baseAchievement,
    });

    expect(definition.progress.target).toEqual({
      kind: 'constant',
      value: 10,
    });
  });

  it('derives progress target from generator-count threshold when omitted', () => {
    const definition = achievementDefinitionSchema.parse({
      ...baseAchievement,
      id: 'generator-count',
      track: {
        kind: 'generator-count',
        threshold: { kind: 'constant', value: 5 },
      },
    });

    expect(definition.progress.target).toEqual({
      kind: 'constant',
      value: 5,
    });
    expect(definition.track).toEqual(
      expect.objectContaining({
        kind: 'generator-count',
        comparator: 'gte',
      }),
    );
  });

  it('requires repeatable configuration when progress mode is repeatable', () => {
    expect(() =>
      achievementDefinitionSchema.parse({
        ...baseAchievement,
        progress: { mode: 'repeatable' },
      }),
    ).toThrowError(/repeatable achievements must define/i);
  });

  it('rejects repeatable configuration when the mode is not repeatable', () => {
    expect(() =>
      achievementDefinitionSchema.parse({
        ...baseAchievement,
        progress: {
          mode: 'oneShot',
          repeatable: {
            resetWindow: { kind: 'constant', value: 1 },
          },
        },
      }),
    ).toThrowError(/repeatable configuration is only valid/i);
  });

  it('defaults boolean tracks to a unit progress target', () => {
    const definition = achievementDefinitionSchema.parse({
      ...baseAchievement,
      id: 'story-complete',
      category: 'progression',
      track: { kind: 'flag', flagId: 'story-complete' },
    });

    expect(definition.progress.target).toEqual({
      kind: 'constant',
      value: 1,
    });
  });

  it('defaults grant flag rewards to true', () => {
    const definition = achievementDefinitionSchema.parse({
      ...baseAchievement,
      reward: {
        kind: 'grantFlag',
        flagId: 'unlocked-mode',
      },
    });

    expect(definition.reward).toEqual({
      kind: 'grantFlag',
      flagId: 'unlocked-mode',
      value: true,
    });
  });
});

describe('achievementCollectionSchema', () => {
  it('rejects duplicate achievement ids', () => {
    expect(() =>
      achievementCollectionSchema.parse([
        {
          id: 'first-prestige',
          name: { default: 'First Prestige', variants: {} },
          description: { default: 'Prestige once.', variants: {} },
          category: 'prestige',
          tier: 'bronze',
          track: {
            kind: 'resource',
            resourceId: 'prestige-points',
            threshold: { kind: 'constant', value: 10 },
          },
        },
        {
          id: 'first-prestige',
          name: { default: 'Another', variants: {} },
          description: { default: 'Duplicate', variants: {} },
          category: 'prestige',
          tier: 'silver',
          track: {
            kind: 'resource',
            resourceId: 'prestige-points',
            threshold: { kind: 'constant', value: 20 },
          },
        },
      ]),
    ).toThrowError(/duplicate achievement id/i);
  });
});
