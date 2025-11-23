import { describe, it, expect } from 'vitest';

import { evaluateNumericFormula } from '@idle-engine/content-schema';

import { sampleContent } from '.';

const ASCENSION_ALPHA_ID = 'sample-pack.ascension-alpha';
const PRESTIGE_RESOURCE_ID = 'sample-pack.prestige-flux';

const toPrestigeLayer = () => {
  const prestigeLayers = sampleContent.modules.prestigeLayers ?? [];
  const layer = prestigeLayers.find((entry) => entry.id === ASCENSION_ALPHA_ID);
  expect(layer).toBeDefined();
  return layer!;
};

const evaluatePrestigeReward = (resources: Record<string, number>) => {
  const layer = toPrestigeLayer();
  return evaluateNumericFormula(layer.reward.baseReward as any, {
    variables: { level: 0, time: 0, deltaTime: 1 },
    entities: {
      resource: (id: string) => resources[id] ?? 0,
    },
  });
};

describe('sample content prestige', () => {
  it('defines ascension-alpha with prestige currency retention and reset coverage', () => {
    const layer = toPrestigeLayer();
    const resetTargets = new Set(layer.resetTargets);
    expect(resetTargets.has('sample-pack.energy')).toBe(true);
    expect(resetTargets.has('sample-pack.crystal')).toBe(true);
    expect(resetTargets.has('sample-pack.alloy')).toBe(true);
    expect(resetTargets.has('sample-pack.data-core')).toBe(true);
    expect(resetTargets.has(PRESTIGE_RESOURCE_ID)).toBe(false);

    const prestigeResource = sampleContent.modules.resources.find(
      (resource) => resource.id === PRESTIGE_RESOURCE_ID,
    );
    expect(prestigeResource?.prestige?.layerId).toBe(ASCENSION_ALPHA_ID);
  });

  it('clamps prestige rewards to the design formula and cap', () => {
    const minReward = evaluatePrestigeReward({
      'sample-pack.energy': 0,
      'sample-pack.crystal': 0,
      'sample-pack.data-core': 0,
    });
    expect(minReward).toBe(1);

    const midReward = evaluatePrestigeReward({
      'sample-pack.energy': 1_500,
      'sample-pack.crystal': 900,
      'sample-pack.data-core': 600,
    });
    expect(midReward).toBe(4);

    const cappedReward = evaluatePrestigeReward({
      'sample-pack.energy': 10_000_000,
      'sample-pack.crystal': 10_000_000,
      'sample-pack.data-core': 10_000_000,
    });
    expect(cappedReward).toBe(5_000);
  });
});
