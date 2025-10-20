import { describe, expect, it } from 'vitest';

import {
  prestigeCollectionSchema,
  prestigeLayerSchema,
} from '../prestige.js';

describe('prestigeLayerSchema', () => {
  const baseLayer = {
    id: 'ascension',
    name: { default: 'Ascension', variants: {} },
    summary: { default: 'Reset for Ascension Shards.', variants: {} },
    resetTargets: ['energy'],
    unlockCondition: { kind: 'always' },
    reward: {
      resourceId: 'ascension-shard',
      baseReward: { kind: 'constant', value: 1 },
    },
  } as const;

  it('normalizes reset targets', () => {
    const layer = prestigeLayerSchema.parse({
      ...baseLayer,
      resetTargets: ['Energy', 'energy'],
    });

    expect(layer.resetTargets).toEqual(['energy']);
  });

  it('requires at least one reset target', () => {
    expect(() =>
      prestigeLayerSchema.parse({
        ...baseLayer,
        resetTargets: [],
      }),
    ).toThrowError(/must reset at least one resource/i);
  });
});

describe('prestigeCollectionSchema', () => {
  it('rejects duplicate prestige ids', () => {
    expect(() =>
      prestigeCollectionSchema.parse([
        {
          id: 'ascension',
          name: { default: 'Ascension', variants: {} },
          summary: { default: 'Reset for shards.', variants: {} },
          resetTargets: ['energy'],
          unlockCondition: { kind: 'always' },
          reward: {
            resourceId: 'ascension-shard',
            baseReward: { kind: 'constant', value: 1 },
          },
        },
        {
          id: 'ascension',
          name: { default: 'Duplicate', variants: {} },
          summary: { default: 'Duplicate.', variants: {} },
          resetTargets: ['energy'],
          unlockCondition: { kind: 'always' },
          reward: {
            resourceId: 'ascension-shard',
            baseReward: { kind: 'constant', value: 2 },
          },
        },
      ]),
    ).toThrowError(/duplicate prestige layer id/i);
  });
});
