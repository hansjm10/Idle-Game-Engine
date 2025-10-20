import { describe, expect, it } from 'vitest';

import type { Condition } from './conditions.js';
import { conditionSchema } from './conditions.js';

const createDeepNotCondition = (depth: number): Condition => {
  let condition: Condition = { kind: 'always' };
  for (let index = 0; index < depth; index += 1) {
    condition = {
      kind: 'not',
      condition,
    };
  }
  return condition;
};

describe('conditionSchema', () => {
  it('parses nested aggregations with numeric formulas', () => {
    const condition = conditionSchema.parse({
      kind: 'allOf',
      conditions: [
        {
          kind: 'resourceThreshold',
          resourceId: 'gold',
          comparator: 'gte',
          amount: { kind: 'constant', value: 10 },
        },
        {
          kind: 'anyOf',
          conditions: [
            {
              kind: 'generatorLevel',
              generatorId: 'foundry',
              comparator: 'gt',
              level: { kind: 'linear', base: 1, slope: 1 },
            },
            {
              kind: 'upgradeOwned',
              upgradeId: 'double-yield',
            },
          ],
        },
      ],
    });

    expect(condition).toMatchObject({
      kind: 'allOf',
      conditions: expect.any(Array),
    });
  });

  it('defaults upgradeOwned requiredPurchases to 1', () => {
    const condition = conditionSchema.parse({
      kind: 'upgradeOwned',
      upgradeId: 'double-yield',
    });

    expect(condition).toEqual({
      kind: 'upgradeOwned',
      upgradeId: 'double-yield',
      requiredPurchases: 1,
    });
  });

  it('requires aggregations to contain at least one condition', () => {
    const result = conditionSchema.safeParse({
      kind: 'allOf',
      conditions: [],
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'allOf conditions must include at least one nested condition.',
        }),
      ]),
    );
  });

  it('enforces positive required purchase counts', () => {
    const result = conditionSchema.safeParse({
      kind: 'upgradeOwned',
      upgradeId: 'double-yield',
      requiredPurchases: 0,
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Value must be a positive integer greater than 0.',
        }),
      ]),
    );
  });

  it('guards against excessively deep condition trees', () => {
    const condition = createDeepNotCondition(20);
    const result = conditionSchema.safeParse(condition);

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('Condition depth'),
        }),
      ]),
    );
  });
});
