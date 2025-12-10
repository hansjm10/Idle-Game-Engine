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

  it('throws when start amount exceeds capacity', () => {
    expect(() =>
      createResource({
        id: 'test.energy',
        name: { default: 'Energy' },
        category: 'currency',
        tier: 1,
        startAmount: 100,
        capacity: 50,
      }),
    ).toThrowError(/cannot exceed capacity/i);
  });

  it('throws when required fields are missing', () => {
    expect(() =>
      createResource({
        id: 'test.energy',
        name: { default: 'Energy' },
        // missing category and tier
      } as ResourceInput),
    ).toThrow();
  });

  it('throws for invalid category', () => {
    expect(() =>
      createResource({
        id: 'test.energy',
        name: { default: 'Energy' },
        category: 'invalid-category' as ResourceInput['category'],
        tier: 1,
      }),
    ).toThrow();
  });
});

describe('createGenerator', () => {
  const baseGenerator: GeneratorInput = {
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

  it('creates a normalized generator from plain input', () => {
    const result = createGenerator(baseGenerator);

    expect(result.id).toBe('test.solar-panel');
    expect(result.name.default).toBe('Solar Panel');
    expect(result.produces).toHaveLength(1);
    expect(result.produces[0].resourceId).toBe('test.energy');
    // Verify defaults
    expect(result.consumes).toEqual([]);
    expect(result.tags).toEqual([]);
  });

  it('throws for duplicate resource references in production', () => {
    expect(() =>
      createGenerator({
        ...baseGenerator,
        produces: [
          { resourceId: 'test.energy', rate: { kind: 'constant', value: 1 } },
          { resourceId: 'test.energy', rate: { kind: 'constant', value: 2 } },
        ],
      }),
    ).toThrowError(/duplicate resource reference/i);
  });

  it('throws when bulk limit exceeds max level', () => {
    expect(() =>
      createGenerator({
        ...baseGenerator,
        maxLevel: 10,
        purchase: {
          ...baseGenerator.purchase,
          maxBulk: 20,
        },
      }),
    ).toThrowError(/bulk purchase limit/i);
  });

  it('throws when required fields are missing', () => {
    expect(() =>
      createGenerator({
        id: 'test.generator',
        name: { default: 'Generator' },
        // missing produces, purchase, baseUnlock
      } as GeneratorInput),
    ).toThrow();
  });
});

describe('createUpgrade', () => {
  const baseUpgrade: UpgradeInput = {
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

  it('creates a normalized upgrade from plain input', () => {
    const result = createUpgrade(baseUpgrade);

    expect(result.id).toBe('test.efficiency');
    expect(result.name.default).toBe('Efficiency');
    expect(result.effects).toHaveLength(1);
  });

  it('throws for duplicate targets', () => {
    expect(() =>
      createUpgrade({
        ...baseUpgrade,
        targets: [{ kind: 'global' }, { kind: 'global' }],
      }),
    ).toThrowError(/duplicate upgrade target/i);
  });

  it('throws when repeatable upgrades lack progression parameters', () => {
    expect(() =>
      createUpgrade({
        ...baseUpgrade,
        repeatable: {},
      }),
    ).toThrowError(/repeatable upgrades must declare at least one progression parameter/i);
  });

  it('throws when required fields are missing', () => {
    expect(() =>
      createUpgrade({
        id: 'test.upgrade',
        name: { default: 'Upgrade' },
        // missing category, targets, cost, effects
      } as UpgradeInput),
    ).toThrow();
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

  it('throws when required fields are missing', () => {
    expect(() =>
      createMetric({
        id: 'test.metric',
        name: { default: 'Metric' },
        // missing kind, unit, source
      } as MetricInput),
    ).toThrow();
  });

  it('throws for invalid metric kind', () => {
    expect(() =>
      createMetric({
        id: 'test.metric',
        name: { default: 'Metric' },
        kind: 'invalid' as MetricInput['kind'],
        unit: 'energy',
        source: { kind: 'runtime' },
      }),
    ).toThrow();
  });
});

describe('createAchievement', () => {
  const baseAchievement: AchievementInput = {
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

  it('creates a normalized achievement from plain input', () => {
    const result = createAchievement(baseAchievement);

    expect(result.id).toBe('test.first-energy');
    expect(result.name.default).toBe('First Spark');
    expect(result.tier).toBe('bronze');
  });

  it('throws when repeatable configuration conflicts with progress mode', () => {
    expect(() =>
      createAchievement({
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

  it('throws when repeatable mode lacks required configuration', () => {
    expect(() =>
      createAchievement({
        ...baseAchievement,
        progress: { mode: 'repeatable' },
      }),
    ).toThrowError(/repeatable achievements must define/i);
  });

  it('throws when required fields are missing', () => {
    expect(() =>
      createAchievement({
        id: 'test.achievement',
        name: { default: 'Achievement' },
        // missing description, tier, category, track
      } as AchievementInput),
    ).toThrow();
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

  it('throws when required fields are missing', () => {
    expect(() =>
      createAutomation({
        id: 'test.automation',
        name: { default: 'Automation' },
        // missing description, targetType, targetId, trigger, unlockCondition
      } as AutomationInput),
    ).toThrow();
  });

  it('throws for invalid target type', () => {
    expect(() =>
      createAutomation({
        id: 'test.automation',
        name: { default: 'Automation' },
        description: { default: 'Description' },
        targetType: 'invalid' as AutomationInput['targetType'],
        targetId: 'test.target',
        trigger: {
          kind: 'resourceThreshold',
          resourceId: 'test.gold',
          threshold: { kind: 'constant', value: 100 },
        },
        unlockCondition: { kind: 'always' },
      }),
    ).toThrow();
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

  it('throws when required fields are missing', () => {
    expect(() =>
      createTransform({
        id: 'test.transform',
        name: { default: 'Transform' },
        // missing description, mode, trigger, inputs, outputs
      } as TransformInput),
    ).toThrow();
  });

  it('throws for invalid mode', () => {
    expect(() =>
      createTransform({
        id: 'test.transform',
        name: { default: 'Transform' },
        description: { default: 'Description' },
        mode: 'invalid' as TransformInput['mode'],
        trigger: { kind: 'manual' },
        inputs: [{ resourceId: 'test.energy', amount: { kind: 'constant', value: 10 } }],
        outputs: [{ resourceId: 'test.gold', amount: { kind: 'constant', value: 1 } }],
      }),
    ).toThrow();
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

  it('throws when required fields are missing', () => {
    expect(() =>
      createPrestigeLayer({
        id: 'test.prestige',
        name: { default: 'Prestige' },
        // missing summary, unlockCondition, reward, resetTargets
      } as PrestigeLayerInput),
    ).toThrow();
  });

  it('throws for empty resetTargets array', () => {
    expect(() =>
      createPrestigeLayer({
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
        resetTargets: [],
      }),
    ).toThrow();
  });
});

describe('createGuildPerk', () => {
  const baseGuildPerk: GuildPerkInput = {
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

  it('creates a normalized guild perk from plain input', () => {
    const result = createGuildPerk(baseGuildPerk);

    expect(result.id).toBe('test.guild-bonus');
    expect(result.name.default).toBe('Guild Bonus');
    expect(result.maxRank).toBe(10);
  });

  it('throws when required fields are missing', () => {
    expect(() =>
      createGuildPerk({
        id: 'test.perk',
        name: { default: 'Perk' },
        // missing description, category, maxRank, effects, cost
      } as GuildPerkInput),
    ).toThrow();
  });

  it('throws for invalid maxRank', () => {
    expect(() =>
      createGuildPerk({
        ...baseGuildPerk,
        maxRank: 0,
      }),
    ).toThrow();
  });

  it('throws for invalid category', () => {
    expect(() =>
      createGuildPerk({
        ...baseGuildPerk,
        category: 'invalid' as GuildPerkInput['category'],
      }),
    ).toThrow();
  });
});
