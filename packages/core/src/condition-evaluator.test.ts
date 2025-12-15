import type { Condition } from '@idle-engine/content-schema';
import { describe, expect, it } from 'vitest';

import {
  combineConditions,
  compareWithComparator,
  type ConditionContext,
  describeCondition,
  evaluateCondition,
  formatComparator,
  formatNumber,
} from './index.js';

type ConditionContentId =
  & Extract<Condition, { resourceId: unknown }>['resourceId']
  & Extract<Condition, { generatorId: unknown }>['generatorId']
  & Extract<Condition, { upgradeId: unknown }>['upgradeId']
  & Extract<Condition, { prestigeLayerId: unknown }>['prestigeLayerId'];

type ConditionFlagId = Extract<Condition, { flagId: unknown }>['flagId'];
type ConditionScriptId = Extract<Condition, { scriptId: unknown }>['scriptId'];

const cid = (value: string) => value as ConditionContentId;
const flag = (value: string) => value as ConditionFlagId;
const script = (value: string) => value as ConditionScriptId;

describe('evaluateCondition', () => {
  const createContext = (overrides?: Partial<ConditionContext>): ConditionContext => ({
    getResourceAmount: () => 0,
    getGeneratorLevel: () => 0,
    getUpgradePurchases: () => 0,
    ...overrides,
  });

  it('returns true for undefined condition', () => {
    const context = createContext();
    expect(evaluateCondition(undefined, context)).toBe(true);
  });

  it('evaluates "always" condition as true', () => {
    const context = createContext();
    const condition: Condition = { kind: 'always' };
    expect(evaluateCondition(condition, context)).toBe(true);
  });

  it('evaluates "never" condition as false', () => {
    const context = createContext();
    const condition: Condition = { kind: 'never' };
    expect(evaluateCondition(condition, context)).toBe(false);
  });

  it('evaluates resourceThreshold with gte comparator', () => {
    const context = createContext({
      getResourceAmount: (id) => (id === 'energy' ? 100 : 0),
    });

    const conditionMet: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'gte',
      amount: { kind: 'constant', value: 50 },
    };
    expect(evaluateCondition(conditionMet, context)).toBe(true);

    const conditionNotMet: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'gte',
      amount: { kind: 'constant', value: 150 },
    };
    expect(evaluateCondition(conditionNotMet, context)).toBe(false);
  });

  it('evaluates resourceThreshold with gt comparator', () => {
    const context = createContext({
      getResourceAmount: (id) => (id === 'energy' ? 100 : 0),
    });

    const conditionMet: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'gt',
      amount: { kind: 'constant', value: 99 },
    };
    expect(evaluateCondition(conditionMet, context)).toBe(true);

    const conditionEqual: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'gt',
      amount: { kind: 'constant', value: 100 },
    };
    expect(evaluateCondition(conditionEqual, context)).toBe(false);
  });

  it('evaluates resourceThreshold with lte comparator', () => {
    const context = createContext({
      getResourceAmount: (id) => (id === 'energy' ? 100 : 0),
    });

    const conditionMet: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'lte',
      amount: { kind: 'constant', value: 150 },
    };
    expect(evaluateCondition(conditionMet, context)).toBe(true);

    const conditionNotMet: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'lte',
      amount: { kind: 'constant', value: 50 },
    };
    expect(evaluateCondition(conditionNotMet, context)).toBe(false);
  });

  it('evaluates resourceThreshold with lt comparator', () => {
    const context = createContext({
      getResourceAmount: (id) => (id === 'energy' ? 100 : 0),
    });

    const conditionMet: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'lt',
      amount: { kind: 'constant', value: 101 },
    };
    expect(evaluateCondition(conditionMet, context)).toBe(true);

    const conditionEqual: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'lt',
      amount: { kind: 'constant', value: 100 },
    };
    expect(evaluateCondition(conditionEqual, context)).toBe(false);
  });

  it('evaluates generatorLevel condition', () => {
    const context = createContext({
      getGeneratorLevel: (id) => (id === 'generator.test' ? 5 : 0),
    });

    const conditionMet: Condition = {
      kind: 'generatorLevel',
      generatorId: cid('generator.test'),
      comparator: 'gte',
      level: { kind: 'constant', value: 3 },
    };
    expect(evaluateCondition(conditionMet, context)).toBe(true);

    const conditionNotMet: Condition = {
      kind: 'generatorLevel',
      generatorId: cid('generator.test'),
      comparator: 'gte',
      level: { kind: 'constant', value: 10 },
    };
    expect(evaluateCondition(conditionNotMet, context)).toBe(false);
  });

	  it('evaluates upgradeOwned condition', () => {
	    const context = createContext({
	      getUpgradePurchases: (id) => (id === 'upgrade.test' ? 3 : 0),
	    });

    const conditionMet: Condition = {
      kind: 'upgradeOwned',
      upgradeId: cid('upgrade.test'),
      requiredPurchases: 2,
    };
    expect(evaluateCondition(conditionMet, context)).toBe(true);

    const conditionNotMet: Condition = {
      kind: 'upgradeOwned',
      upgradeId: cid('upgrade.test'),
      requiredPurchases: 5,
    };
	    expect(evaluateCondition(conditionNotMet, context)).toBe(false);
	  });

	  it('evaluates prestigeCountThreshold condition via {layerId}-prestige-count resource', () => {
	    const context = createContext({
	      getResourceAmount: (id) => (id === 'prestige.alpha-prestige-count' ? 1 : 0),
	    });

	    expect(
	      evaluateCondition(
	        {
	          kind: 'prestigeCountThreshold',
	          prestigeLayerId: cid('prestige.alpha'),
	          comparator: 'gte',
	          count: 1,
	        },
	        context,
	      ),
	    ).toBe(true);

	    expect(
	      evaluateCondition(
	        {
	          kind: 'prestigeCountThreshold',
	          prestigeLayerId: cid('prestige.alpha'),
	          comparator: 'gte',
	          count: 2,
	        },
	        context,
	      ),
	    ).toBe(false);
	  });

	  it('evaluates prestigeCompleted condition via {layerId}-prestige-count resource', () => {
	    const context = createContext({
	      getResourceAmount: (id) => (id === 'prestige.alpha-prestige-count' ? 1 : 0),
	    });

	    expect(
	      evaluateCondition(
	        {
	          kind: 'prestigeCompleted',
	          prestigeLayerId: cid('prestige.alpha'),
	        },
	        context,
	      ),
	    ).toBe(true);

	    expect(
	      evaluateCondition(
	        {
	          kind: 'prestigeCompleted',
	          prestigeLayerId: cid('prestige.beta'),
	        },
	        context,
	      ),
	    ).toBe(false);
	  });

	  it('evaluates prestigeUnlocked condition via context hook', () => {
	    const context = createContext({
	      hasPrestigeLayerUnlocked: (id) => id === 'prestige.alpha',
	    });

    expect(
      evaluateCondition(
        {
          kind: 'prestigeUnlocked',
          prestigeLayerId: cid('prestige.alpha'),
        },
        context,
      ),
    ).toBe(true);

    expect(
      evaluateCondition(
        {
          kind: 'prestigeUnlocked',
          prestigeLayerId: cid('prestige.beta'),
        },
        context,
      ),
    ).toBe(false);
  });

  it('evaluates flag condition via context hook', () => {
    const context = createContext({
      isFlagSet: (id) => id === 'flag.completed',
    });

    expect(
      evaluateCondition(
        {
          kind: 'flag',
          flagId: flag('flag.completed'),
        },
        context,
      ),
    ).toBe(true);

    expect(
      evaluateCondition(
        {
          kind: 'flag',
          flagId: flag('flag.missing'),
        },
        context,
      ),
    ).toBe(false);
  });

  it('evaluates script condition via context hook and reports missing hook', () => {
    const errors: Error[] = [];
    const context = createContext({
      evaluateScriptCondition: (id) => id === 'script.success',
      onError: (error) => errors.push(error),
    });

    expect(
      evaluateCondition(
        {
          kind: 'script',
          scriptId: script('script.success'),
        },
        context,
      ),
    ).toBe(true);
    expect(errors).toHaveLength(0);

    expect(
      evaluateCondition(
        {
          kind: 'script',
          scriptId: script('script.failure'),
        },
        createContext({
          onError: (error) => errors.push(error),
        }),
      ),
    ).toBe(false);
    expect(errors[0]?.message).toContain(
      'Condition "script" targeting "script.failure" requires',
    );
  });

  it('evaluates allOf condition requiring all nested conditions', () => {
    const context = createContext({
      getResourceAmount: (id) => (id === 'energy' ? 100 : 0),
      getGeneratorLevel: (id) => (id === 'generator.test' ? 5 : 0),
    });

    const conditionAllMet: Condition = {
      kind: 'allOf',
      conditions: [
        {
          kind: 'resourceThreshold',
          resourceId: cid('energy'),
          comparator: 'gte',
          amount: { kind: 'constant', value: 50 },
        },
        {
          kind: 'generatorLevel',
          generatorId: cid('generator.test'),
          comparator: 'gte',
          level: { kind: 'constant', value: 3 },
        },
      ],
    };
    expect(evaluateCondition(conditionAllMet, context)).toBe(true);

    const conditionOneFails: Condition = {
      kind: 'allOf',
      conditions: [
        {
          kind: 'resourceThreshold',
          resourceId: cid('energy'),
          comparator: 'gte',
          amount: { kind: 'constant', value: 50 },
        },
        {
          kind: 'generatorLevel',
          generatorId: cid('generator.test'),
          comparator: 'gte',
          level: { kind: 'constant', value: 10 },
        },
      ],
    };
    expect(evaluateCondition(conditionOneFails, context)).toBe(false);
  });

  it('evaluates anyOf condition requiring at least one nested condition', () => {
    const context = createContext({
      getResourceAmount: (id) => (id === 'energy' ? 100 : 0),
      getGeneratorLevel: (id) => (id === 'generator.test' ? 2 : 0),
    });

    const conditionOneMet: Condition = {
      kind: 'anyOf',
      conditions: [
        {
          kind: 'resourceThreshold',
          resourceId: cid('energy'),
          comparator: 'gte',
          amount: { kind: 'constant', value: 50 },
        },
        {
          kind: 'generatorLevel',
          generatorId: cid('generator.test'),
          comparator: 'gte',
          level: { kind: 'constant', value: 10 },
        },
      ],
    };
    expect(evaluateCondition(conditionOneMet, context)).toBe(true);

    const conditionNoneMet: Condition = {
      kind: 'anyOf',
      conditions: [
        {
          kind: 'resourceThreshold',
          resourceId: cid('energy'),
          comparator: 'gte',
          amount: { kind: 'constant', value: 200 },
        },
        {
          kind: 'generatorLevel',
          generatorId: cid('generator.test'),
          comparator: 'gte',
          level: { kind: 'constant', value: 10 },
        },
      ],
    };
    expect(evaluateCondition(conditionNoneMet, context)).toBe(false);
  });

  it('evaluates not condition inverting nested condition', () => {
    const context = createContext({
      getResourceAmount: (id) => (id === 'energy' ? 100 : 0),
    });

    const conditionMet: Condition = {
      kind: 'not',
      condition: {
        kind: 'resourceThreshold',
        resourceId: cid('energy'),
        comparator: 'gte',
        amount: { kind: 'constant', value: 200 },
      },
    };
    expect(evaluateCondition(conditionMet, context)).toBe(true);

    const conditionNotMet: Condition = {
      kind: 'not',
      condition: {
        kind: 'resourceThreshold',
        resourceId: cid('energy'),
        comparator: 'gte',
        amount: { kind: 'constant', value: 50 },
      },
    };
    expect(evaluateCondition(conditionNotMet, context)).toBe(false);
  });

  it('returns false for unknown condition kind', () => {
    const context = createContext();
    const condition = { kind: 'unknown' } as unknown as Condition;
    expect(evaluateCondition(condition, context)).toBe(false);
  });

  it('calls error callback for unknown condition kind in production', () => {
    const errors: Error[] = [];
    const context = createContext({
      onError: (error) => errors.push(error),
    });
    const condition = { kind: 'unknown' } as unknown as Condition;

    const result = evaluateCondition(condition, context);

    expect(result).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Unknown condition kind: unknown');
  });

  it('detects excessive recursion depth with deeply nested allOf conditions', () => {
    const errors: Error[] = [];
    const context = createContext({
      onError: (error) => errors.push(error),
    });

    // Create a condition nested 101 levels deep (exceeds MAX_CONDITION_DEPTH of 100)
    let condition: Condition = { kind: 'always' };
    for (let i = 0; i < 101; i++) {
      condition = { kind: 'allOf', conditions: [condition] };
    }

    const result = evaluateCondition(condition, context);

    expect(result).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('exceeded maximum depth');
    expect(errors[0].message).toContain('circular dependency');
  });

  it('detects excessive recursion depth with deeply nested anyOf conditions', () => {
    const errors: Error[] = [];
    const context = createContext({
      onError: (error) => errors.push(error),
    });

    // Create a condition nested 101 levels deep (exceeds MAX_CONDITION_DEPTH of 100)
    let condition: Condition = { kind: 'never' };
    for (let i = 0; i < 101; i++) {
      condition = { kind: 'anyOf', conditions: [condition] };
    }

    const result = evaluateCondition(condition, context);

    expect(result).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('exceeded maximum depth');
  });

  it('detects excessive recursion depth with deeply nested not conditions', () => {
    const errors: Error[] = [];
    const context = createContext({
      onError: (error) => errors.push(error),
    });

    // Create a condition nested 101 levels deep (exceeds MAX_CONDITION_DEPTH of 100)
    let condition: Condition = { kind: 'always' };
    for (let i = 0; i < 101; i++) {
      condition = { kind: 'not', condition };
    }

    evaluateCondition(condition, context);

    // The exact result depends on the parity of negations after depth check,
    // but we care that an error was reported
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('exceeded maximum depth');
    expect(errors[0].message).toContain('circular dependency');
  });

  it('handles moderately nested conditions within depth limit', () => {
    const errors: Error[] = [];
    const context = createContext({
      getResourceAmount: () => 100,
      onError: (error) => errors.push(error),
    });

    // Create a condition nested 50 levels deep (within MAX_CONDITION_DEPTH of 100)
    let condition: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'gte',
      amount: { kind: 'constant', value: 50 },
    };
    for (let i = 0; i < 50; i++) {
      condition = { kind: 'allOf', conditions: [condition] };
    }

    const result = evaluateCondition(condition, context);

    expect(result).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it('handles mixed recursive conditions approaching depth limit', () => {
    const errors: Error[] = [];
    const context = createContext({
      getResourceAmount: () => 100,
      onError: (error) => errors.push(error),
    });

    // Create a condition with mixed nesting (allOf, anyOf, not) at 99 depth
    let condition: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'gte',
      amount: { kind: 'constant', value: 50 },
    };
    for (let i = 0; i < 33; i++) {
      condition = { kind: 'allOf', conditions: [condition] };
    }
    for (let i = 0; i < 33; i++) {
      condition = { kind: 'anyOf', conditions: [condition] };
    }
    for (let i = 0; i < 33; i++) {
      condition = { kind: 'not', condition };
    }

    const result = evaluateCondition(condition, context);

    // Should succeed (depth = 99, limit = 100)
    expect(result).toBe(false); // false because of odd number of 'not' wrappers
    expect(errors).toHaveLength(0);
  });
});

describe('compareWithComparator', () => {
  it('compares with gt comparator', () => {
    expect(compareWithComparator(10, 5, 'gt')).toBe(true);
    expect(compareWithComparator(5, 5, 'gt')).toBe(false);
    expect(compareWithComparator(3, 5, 'gt')).toBe(false);
  });

  it('compares with gte comparator', () => {
    expect(compareWithComparator(10, 5, 'gte')).toBe(true);
    expect(compareWithComparator(5, 5, 'gte')).toBe(true);
    expect(compareWithComparator(3, 5, 'gte')).toBe(false);
  });

  it('compares with lt comparator', () => {
    expect(compareWithComparator(3, 5, 'lt')).toBe(true);
    expect(compareWithComparator(5, 5, 'lt')).toBe(false);
    expect(compareWithComparator(10, 5, 'lt')).toBe(false);
  });

  it('compares with lte comparator', () => {
    expect(compareWithComparator(3, 5, 'lte')).toBe(true);
    expect(compareWithComparator(5, 5, 'lte')).toBe(true);
    expect(compareWithComparator(10, 5, 'lte')).toBe(false);
  });

  it('returns false for unknown comparator', () => {
    expect(compareWithComparator(10, 5, 'unknown' as any)).toBe(false);
  });

  it('calls error callback for unknown comparator in production', () => {
    const errors: Error[] = [];
    const context = { onError: (error: Error) => errors.push(error) };

    const result = compareWithComparator(10, 5, 'unknown' as any, context);

    expect(result).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('Unknown comparator: unknown');
  });
});

describe('combineConditions', () => {
  it('returns undefined for empty array', () => {
    expect(combineConditions([])).toBeUndefined();
  });

  it('returns single condition as-is', () => {
    const condition: Condition = { kind: 'always' };
    expect(combineConditions([condition])).toBe(condition);
  });

  it('combines multiple conditions into allOf', () => {
    const condition1: Condition = { kind: 'always' };
    const condition2: Condition = { kind: 'never' };
    const result = combineConditions([condition1, condition2]);

    expect(result).toEqual({
      kind: 'allOf',
      conditions: [condition1, condition2],
    });
  });
});

describe('describeCondition', () => {
  it('returns undefined for undefined condition', () => {
    expect(describeCondition(undefined)).toBeUndefined();
  });

  it('returns undefined for always condition', () => {
    expect(describeCondition({ kind: 'always' })).toBeUndefined();
  });

  it('describes never condition', () => {
    expect(describeCondition({ kind: 'never' })).toBe(
      'Unavailable in this build',
    );
  });

  it('describes resourceThreshold condition', () => {
    const condition: Condition = {
      kind: 'resourceThreshold',
      resourceId: cid('energy'),
      comparator: 'gte',
      amount: { kind: 'constant', value: 100 },
    };
    expect(describeCondition(condition)).toBe('Requires energy >= 100');
  });

  it('describes generatorLevel condition', () => {
    const condition: Condition = {
      kind: 'generatorLevel',
      generatorId: cid('generator.test'),
      comparator: 'gt',
      level: { kind: 'constant', value: 5 },
    };
    expect(describeCondition(condition)).toBe('Requires generator.test > 5');
  });

	  it('describes upgradeOwned condition', () => {
	    const condition: Condition = {
	      kind: 'upgradeOwned',
	      upgradeId: cid('upgrade.test'),
	      requiredPurchases: 3,
	    };
	    expect(describeCondition(condition)).toBe(
	      'Requires owning 3× upgrade.test',
	    );
	  });

	  it('describes prestigeCountThreshold condition', () => {
	    const condition: Condition = {
	      kind: 'prestigeCountThreshold',
	      prestigeLayerId: cid('prestige.alpha'),
	      comparator: 'gte',
	      count: 1,
	    };
	    expect(describeCondition(condition)).toBe(
	      'Requires prestige count for prestige.alpha >= 1',
	    );
	  });

	  it('describes prestigeCompleted condition', () => {
	    const condition: Condition = {
	      kind: 'prestigeCompleted',
	      prestigeLayerId: cid('prestige.alpha'),
	    };
	    expect(describeCondition(condition)).toBe(
	      'Requires prestiged at least once in prestige.alpha',
	    );
	  });

	  it('describes prestigeUnlocked condition', () => {
	    const condition: Condition = {
	      kind: 'prestigeUnlocked',
	      prestigeLayerId: cid('prestige.alpha'),
	    };
	    expect(describeCondition(condition)).toBe(
	      'Requires prestige layer prestige.alpha available',
	    );
	  });

	  it('describes allOf condition with multiple parts', () => {
	    const condition: Condition = {
	      kind: 'allOf',
	      conditions: [
        {
          kind: 'resourceThreshold',
          resourceId: cid('energy'),
          comparator: 'gte',
          amount: { kind: 'constant', value: 100 },
        },
        {
          kind: 'generatorLevel',
          generatorId: cid('generator.test'),
          comparator: 'gte',
          level: { kind: 'constant', value: 5 },
        },
      ],
    };
    expect(describeCondition(condition)).toBe(
      'Requires energy >= 100, Requires generator.test >= 5',
    );
  });

  it('describes allOf condition filtering out always conditions', () => {
    const condition: Condition = {
      kind: 'allOf',
      conditions: [
        { kind: 'always' },
        {
          kind: 'resourceThreshold',
          resourceId: cid('energy'),
          comparator: 'gte',
          amount: { kind: 'constant', value: 100 },
        },
      ],
    };
    expect(describeCondition(condition)).toBe('Requires energy >= 100');
  });

  it('describes anyOf condition with multiple parts', () => {
    const condition: Condition = {
      kind: 'anyOf',
      conditions: [
        {
          kind: 'resourceThreshold',
          resourceId: cid('energy'),
          comparator: 'gte',
          amount: { kind: 'constant', value: 100 },
        },
        {
          kind: 'generatorLevel',
          generatorId: cid('generator.test'),
          comparator: 'gte',
          level: { kind: 'constant', value: 5 },
        },
      ],
    };
    expect(describeCondition(condition)).toBe(
      'Requires any of: Requires energy >= 100 or Requires generator.test >= 5',
    );
  });

  it('describes not condition', () => {
    const condition: Condition = {
      kind: 'not',
      condition: {
        kind: 'resourceThreshold',
        resourceId: cid('energy'),
        comparator: 'gte',
        amount: { kind: 'constant', value: 100 },
      },
    };
    expect(describeCondition(condition)).toBe('Not (Requires energy >= 100)');
  });

  it('returns undefined for not condition with always nested', () => {
    const condition: Condition = {
      kind: 'not',
      condition: { kind: 'always' },
    };
    expect(describeCondition(condition)).toBeUndefined();
  });

  it('returns undefined for unknown condition kind', () => {
    const condition = { kind: 'unknown' } as unknown as Condition;
    expect(describeCondition(condition)).toBeUndefined();
  });
});

describe('formatComparator', () => {
  it('formats gt comparator', () => {
    expect(formatComparator('gt')).toBe('>');
  });

  it('formats gte comparator', () => {
    expect(formatComparator('gte')).toBe('>=');
  });

  it('formats lt comparator', () => {
    expect(formatComparator('lt')).toBe('<');
  });

  it('formats lte comparator', () => {
    expect(formatComparator('lte')).toBe('<=');
  });

  it('returns input for unknown comparator', () => {
    expect(formatComparator('unknown' as any)).toBe('unknown');
  });
});

describe('formatNumber', () => {
  it('formats integers without decimals', () => {
    expect(formatNumber(100)).toBe('100');
    expect(formatNumber(0)).toBe('0');
  });

  it('removes trailing .00 from decimals', () => {
    expect(formatNumber(100.0)).toBe('100');
  });

  it('formats decimals with significant precision', () => {
    expect(formatNumber(100.5)).toBe('100.50');
  });

  it('formats small numbers with toPrecision', () => {
    expect(formatNumber(0.01)).toBe('0.010');
    expect(formatNumber(0.001)).toBe('0.0010');
  });

  it('formats infinity', () => {
    expect(formatNumber(Infinity)).toBe('Infinity');
    expect(formatNumber(-Infinity)).toBe('Infinity');
  });

  it('formats negative numbers', () => {
    expect(formatNumber(-100)).toBe('-100');
    expect(formatNumber(-0.01)).toBe('-0.010');
  });
});
