import { describe, expect, it } from 'vitest';

import type { ExpressionNode } from './formulas.js';
import { numericFormulaSchema } from './formulas.js';

const createDeepUnaryExpression = (depth: number): ExpressionNode => {
  let node: ExpressionNode = { kind: 'literal', value: 1 };
  for (let index = 0; index < depth; index += 1) {
    node = {
      kind: 'unary',
      op: 'sqrt',
      operand: node,
    };
  }
  return node;
};

describe('numericFormulaSchema', () => {
  it('accepts constant formulas with finite values', () => {
    const result = numericFormulaSchema.parse({
      kind: 'constant',
      value: 42,
    });
    expect(result).toEqual({
      kind: 'constant',
      value: 42,
    });
  });

  it('validates piecewise segments with strict ordering and catch-all', () => {
    const piecewise = {
      kind: 'piecewise' as const,
      pieces: [
        {
          untilLevel: 5,
          formula: { kind: 'linear', base: 1, slope: 2 },
        },
        {
          untilLevel: 10,
          formula: { kind: 'constant', value: 20 },
        },
        {
          formula: { kind: 'constant', value: 100 },
        },
      ],
    };

    expect(numericFormulaSchema.parse(piecewise)).toEqual(piecewise);
  });

  it('rejects piecewise formulas without a final catch-all segment', () => {
    const result = numericFormulaSchema.safeParse({
      kind: 'piecewise',
      pieces: [
        {
          untilLevel: 5,
          formula: { kind: 'constant', value: 1 },
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: 'Piecewise formulas must terminate with a catch-all segment.',
        }),
      ]),
    );
  });

  it('rejects piecewise formulas with non-increasing untilLevel values', () => {
    const result = numericFormulaSchema.safeParse({
      kind: 'piecewise',
      pieces: [
        {
          untilLevel: 10,
          formula: { kind: 'constant', value: 1 },
        },
        {
          untilLevel: 8,
          formula: { kind: 'constant', value: 2 },
        },
        {
          formula: { kind: 'constant', value: 3 },
        },
      ],
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message:
            'Piecewise segments must declare strictly increasing untilLevel values.',
        }),
      ]),
    );
  });

  it('rejects binary expressions that use disallowed operators', () => {
    const result = numericFormulaSchema.safeParse({
      kind: 'expression',
      expression: {
        kind: 'binary',
        op: 'mod',
        left: { kind: 'literal', value: 4 },
        right: { kind: 'literal', value: 2 },
      },
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('Invalid enum value'),
        }),
      ]),
    );
  });

  it('guards against excessively deep expression trees', () => {
    const expression = createDeepUnaryExpression(20);
    const result = numericFormulaSchema.safeParse({
      kind: 'expression',
      expression,
    });

    expect(result.success).toBe(false);
    expect(result.success ? [] : result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining('Expression depth exceeds'),
        }),
      ]),
    );
  });
});
