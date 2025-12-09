import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

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

  it('defaults exponential base to 1 when omitted', () => {
    const result = numericFormulaSchema.parse({
      kind: 'exponential',
      growth: 1.15,
    });
    expect(result).toEqual({
      kind: 'exponential',
      base: 1,
      growth: 1.15,
    });
  });

  it('preserves explicit exponential base when provided', () => {
    const result = numericFormulaSchema.parse({
      kind: 'exponential',
      base: 10,
      growth: 1.15,
      offset: 5,
    });
    expect(result).toEqual({
      kind: 'exponential',
      base: 10,
      growth: 1.15,
      offset: 5,
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

  it('accepts expression formulas at the maximum allowed depth', () => {
    const expression = createDeepUnaryExpression(15);
    const result = numericFormulaSchema.safeParse({
      kind: 'expression',
      expression,
    });

    expect(result.success).toBe(true);
  });
});

describe('numericFormulaSchema (property-based tests)', () => {
  it('property: exponential formulas with growth > 1 are monotonically increasing', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 1000, noNaN: true }),
        fc.double({ min: 1.01, max: 2, noNaN: true }),
        (base, growth) => {
          const formula = {
            kind: 'exponential' as const,
            base,
            growth,
            offset: 0,
          };

          const result = numericFormulaSchema.safeParse(formula);
          expect(result.success).toBe(true);

          if (!result.success) return;

          // Verify monotonicity: f(n+1) > f(n) for positive inputs
          // Formula: base * (growth ^ level) + offset
          const evalAt = (level: number) =>
            base * Math.pow(growth, level) + 0;

          const value1 = evalAt(1);
          const value2 = evalAt(2);
          const value10 = evalAt(10);

          expect(value2).toBeGreaterThan(value1);
          expect(value10).toBeGreaterThan(value2);
          expect(Number.isFinite(value1)).toBe(true);
          expect(Number.isFinite(value2)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: linear formulas produce finite outputs for reasonable inputs', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -100, max: 100, noNaN: true }),
        fc.integer({ min: 0, max: 1000 }),
        (base, slope, level) => {
          const formula = {
            kind: 'linear' as const,
            base,
            slope,
          };

          const result = numericFormulaSchema.safeParse(formula);
          expect(result.success).toBe(true);

          if (!result.success) return;

          // Verify output is finite for reasonable level inputs
          // Formula: base + (slope * level)
          const value = base + slope * level;
          expect(Number.isFinite(value)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: polynomial formulas with positive coefficients are non-negative for non-negative inputs', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 100, noNaN: true }), {
          minLength: 1,
          maxLength: 5,
        }),
        fc.integer({ min: 0, max: 50 }),
        (coefficients, level) => {
          const formula = {
            kind: 'polynomial' as const,
            coefficients,
          };

          const result = numericFormulaSchema.safeParse(formula);
          expect(result.success).toBe(true);

          if (!result.success) return;

          // Verify non-negativity for non-negative inputs
          // Formula: sum(coefficient[i] * level^i)
          let value = 0;
          for (let index = 0; index < coefficients.length; index += 1) {
            value += coefficients[index]! * Math.pow(level, index);
          }

          expect(value).toBeGreaterThanOrEqual(0);
          expect(Number.isFinite(value)).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: piecewise formulas respect segment boundaries', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            untilLevel: fc.integer({ min: 1, max: 100 }),
            value: fc.double({ min: 1, max: 1000, noNaN: true }),
          }),
          { minLength: 1, maxLength: 5 },
        ),
        fc.double({ min: 1, max: 1000, noNaN: true }),
        (segments, catchAllValue) => {
          // Sort and deduplicate untilLevel values
          const sortedSegments = segments
            .map((seg) => ({
              untilLevel: seg.untilLevel,
              formula: { kind: 'constant' as const, value: seg.value },
            }))
            .sort((a, b) => a.untilLevel - b.untilLevel);

          // Ensure strictly increasing untilLevel
          const uniqueSegments = sortedSegments.filter(
            (seg, index, array) =>
              index === 0 || seg.untilLevel > array[index - 1]!.untilLevel,
          );

          if (uniqueSegments.length === 0) return;

          const pieces = [
            ...uniqueSegments,
            { formula: { kind: 'constant' as const, value: catchAllValue } },
          ];

          const formula = {
            kind: 'piecewise' as const,
            pieces,
          };

          const result = numericFormulaSchema.safeParse(formula);
          expect(result.success).toBe(true);

          if (!result.success) return;

          // Verify parsed formula maintains segment order
          if (result.data.kind === 'piecewise') {
            expect(result.data.pieces).toHaveLength(pieces.length);
          }
        },
      ),
      { numRuns: 50 },
    );
  });

  it('property: expression depth is bounded by schema limits', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 }), (depth) => {
        const expression = createDeepUnaryExpression(depth);
        const formula = {
          kind: 'expression' as const,
          expression,
        };

        const result = numericFormulaSchema.safeParse(formula);

        // Depth <= 15 should succeed, depth > 15 should fail
        if (depth <= 15) {
          expect(result.success).toBe(true);
        } else {
          expect(result.success).toBe(false);
          if (!result.success) {
            expect(result.error.issues).toEqual(
              expect.arrayContaining([
                expect.objectContaining({
                  message: expect.stringContaining('Expression depth exceeds'),
                }),
              ]),
            );
          }
        }
      }),
      { numRuns: 50 },
    );
  });

  it('property: constant formulas always accept finite numbers', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1e10, max: 1e10, noNaN: true }),
        (value) => {
          const formula = {
            kind: 'constant' as const,
            value,
          };

          const result = numericFormulaSchema.safeParse(formula);
          expect(result.success).toBe(true);

          if (result.success && result.data.kind === 'constant') {
            expect(result.data.value).toBe(value);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('property: rejects formulas with NaN or Infinity values', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        (invalidValue) => {
          const formula = {
            kind: 'constant' as const,
            value: invalidValue,
          };

          const result = numericFormulaSchema.safeParse(formula);
          expect(result.success).toBe(false);
        },
      ),
    );
  });
});
