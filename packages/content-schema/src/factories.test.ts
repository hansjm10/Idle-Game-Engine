import { describe, expect, it } from 'vitest';

import {
  createResource,
  createGenerator,
  createUpgrade,
  createMetric,
  createAchievement,
  createAutomation,
  createTransform,
  createPrestigeLayer,
  createGuildPerk,
  type ResourceInput,
  type GeneratorInput,
  type UpgradeInput,
  type MetricInput,
  type AchievementInput,
  type AutomationInput,
  type TransformInput,
  type PrestigeLayerInput,
  type GuildPerkInput,
} from './factories.js';

describe('createResource', () => {
  it('creates a normalized resource from plain input', () => {
    const input: ResourceInput = {
      id: 'test.energy',
      name: { default: 'Energy' },
      category: 'currency',
      tier: 1,
    };

    const result = createResource(input);

    expect(result.id).toBe('test.energy');
    expect(result.name.default).toBe('Energy');
    expect(result.category).toBe('currency');
    expect(result.tier).toBe(1);
    // Verify defaults are applied
    expect(result.startAmount).toBe(0);
    expect(result.visible).toBe(true);
    expect(result.unlocked).toBe(false);
    expect(result.tags).toEqual([]);
  });

  it('accepts string id without type assertions', () => {
    // This test verifies the ergonomic benefit - plain strings work
    const result = createResource({
      id: 'my-pack.gold',
      name: { default: 'Gold' },
      category: 'currency',
      tier: 1,
    });

    expect(result.id).toBe('my-pack.gold');
  });
});

describe('createGenerator', () => {
  it('creates a normalized generator from plain input', () => {
    const input: GeneratorInput = {
      id: 'test.solar-panel',
      name: { default: 'Solar Panel' },
      produces: [{ resourceId: 'test.energy', rate: { kind: 'constant', value: 1 } }],
      purchase: {
        currencyId: 'test.gold',
        baseCost: 10,
        costCurve: { kind: 'constant', value: 1 },
      },
      baseUnlock: { kind: 'always' },
    };

    const result = createGenerator(input);

    expect(result.id).toBe('test.solar-panel');
    expect(result.name.default).toBe('Solar Panel');
    expect(result.produces).toHaveLength(1);
    expect(result.produces[0].resourceId).toBe('test.energy');
    // Verify defaults
    expect(result.consumes).toEqual([]);
    expect(result.tags).toEqual([]);
  });
});

describe('createUpgrade', () => {
  it('creates a normalized upgrade from plain input', () => {
    const input: UpgradeInput = {
      id: 'test.efficiency',
      name: { default: 'Efficiency' },
      category: 'generator',
      targets: [{ kind: 'generator', id: 'test.solar-panel' }],
      cost: {
        currencyId: 'test.gold',
        baseCost: 100,
        costCurve: { kind: 'constant', value: 1 },
      },
      effects: [
        {
          kind: 'modifyGeneratorRate',
          generatorId: 'test.solar-panel',
          operation: 'multiply',
          value: { kind: 'constant', value: 1.5 },
        },
      ],
    };

    const result = createUpgrade(input);

    expect(result.id).toBe('test.efficiency');
    expect(result.name.default).toBe('Efficiency');
    expect(result.effects).toHaveLength(1);
  });
});

describe('createMetric', () => {
  it('creates a normalized metric from plain input', () => {
    const input: MetricInput = {
      id: 'test.total-energy',
      name: { default: 'Total Energy' },
      kind: 'counter',
      unit: 'energy',
      source: { kind: 'runtime' },
    };

    const result = createMetric(input);

    expect(result.id).toBe('test.total-energy');
    expect(result.name.default).toBe('Total Energy');
    expect(result.kind).toBe('counter');
  });
});

describe('createAchievement', () => {
  it('creates a normalized achievement from plain input', () => {
    const input: AchievementInput = {
      id: 'test.first-energy',
      name: { default: 'First Spark' },
      description: { default: 'Generate your first energy' },
      tier: 'bronze',
      category: 'progression',
      track: {
        kind: 'resource',
        resourceId: 'test.energy',
        comparator: 'gte',
        threshold: { kind: 'constant', value: 1 },
      },
    };

    const result = createAchievement(input);

    expect(result.id).toBe('test.first-energy');
    expect(result.name.default).toBe('First Spark');
    expect(result.tier).toBe('bronze');
  });
});

describe('createAutomation', () => {
  it('creates a normalized automation from plain input', () => {
    const input: AutomationInput = {
      id: 'test.auto-buy',
      name: { default: 'Auto Buy' },
      description: { default: 'Automatically purchases generators' },
      targetType: 'generator',
      targetId: 'test.solar-panel',
      trigger: {
        kind: 'resourceThreshold',
        resourceId: 'test.gold',
        threshold: { kind: 'constant', value: 100 },
      },
      unlockCondition: { kind: 'always' },
    };

    const result = createAutomation(input);

    expect(result.id).toBe('test.auto-buy');
    expect(result.name.default).toBe('Auto Buy');
    expect(result.targetType).toBe('generator');
  });
});

describe('createTransform', () => {
  it('creates a normalized transform from plain input', () => {
    const input: TransformInput = {
      id: 'test.convert',
      name: { default: 'Convert' },
      description: { default: 'Convert energy to gold' },
      mode: 'instant',
      trigger: { kind: 'manual' },
      inputs: [{ resourceId: 'test.energy', amount: { kind: 'constant', value: 10 } }],
      outputs: [{ resourceId: 'test.gold', amount: { kind: 'constant', value: 1 } }],
    };

    const result = createTransform(input);

    expect(result.id).toBe('test.convert');
    expect(result.name.default).toBe('Convert');
    expect(result.inputs).toHaveLength(1);
    expect(result.outputs).toHaveLength(1);
  });
});

describe('createPrestigeLayer', () => {
  it('creates a normalized prestige layer from plain input', () => {
    const input: PrestigeLayerInput = {
      id: 'test.rebirth',
      name: { default: 'Rebirth' },
      summary: { default: 'Reset for prestige points' },
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'test.energy',
        comparator: 'gte',
        amount: { kind: 'constant', value: 1000 },
      },
      reward: {
        resourceId: 'test.prestige-points',
        baseReward: { kind: 'constant', value: 1 },
      },
      resetTargets: ['test.energy', 'test.gold'],
    };

    const result = createPrestigeLayer(input);

    expect(result.id).toBe('test.rebirth');
    expect(result.name.default).toBe('Rebirth');
    expect(result.resetTargets).toContain('test.energy');
  });
});

describe('createGuildPerk', () => {
  it('creates a normalized guild perk from plain input', () => {
    const input: GuildPerkInput = {
      id: 'test.guild-bonus',
      name: { default: 'Guild Bonus' },
      description: { default: 'Increases production for all guild members' },
      category: 'buff',
      maxRank: 10,
      effects: [
        {
          kind: 'modifyResourceRate',
          resourceId: 'test.energy',
          operation: 'multiply',
          value: { kind: 'constant', value: 1.1 },
        },
      ],
      cost: {
        kind: 'currency',
        resourceId: 'test.guild-points',
        amount: { kind: 'constant', value: 100 },
      },
    };

    const result = createGuildPerk(input);

    expect(result.id).toBe('test.guild-bonus');
    expect(result.name.default).toBe('Guild Bonus');
    expect(result.maxRank).toBe(10);
  });
});
