import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';

import {
  createDeterministicFormulaEvaluationContext,
  createFormulaArbitrary,
  createFormulaEvaluationContextArbitrary,
  DEFAULT_FORMULA_PROPERTY_SEED,
  evaluateNumericFormula,
  type FormulaEvaluationContext,
  type FormulaEntityReferenceType,
} from './formulas.arbitraries.js';
import { numericFormulaSchema, type ExpressionNode } from './formulas.js';

const propertyConfig = (offset: number): fc.Parameters<unknown> => ({
  numRuns: 200,
  seed: DEFAULT_FORMULA_PROPERTY_SEED + offset,
});

const withLevel = (base: FormulaEvaluationContext, level: number): FormulaEvaluationContext => ({
  ...base,
  level,
});

const collectRootDegrees = (node: ExpressionNode): number[] => {
  const pending: ExpressionNode[] = [node];
  const degrees: number[] = [];

  while (pending.length > 0) {
    const current = pending.pop()!;
    switch (current.kind) {
      case 'binary':
        pending.push(current.left, current.right);
        break;
      case 'unary':
        pending.push(current.operand);
        break;
      case 'call': {
        if (current.name === 'root') {
          const degreeArg = current.args[1];
          if (degreeArg?.kind === 'literal') {
            degrees.push(degreeArg.value);
          }
        }
        pending.push(...current.args);
        break;
      }
      default:
        break;
    }
  }

  return degrees;
};

const containsRootCall = (node: ExpressionNode): boolean =>
  collectRootDegrees(node).length > 0;

const collectEntityReferenceTypes = (
  node: ExpressionNode,
): FormulaEntityReferenceType[] => {
  const pending: ExpressionNode[] = [node];
  const types: FormulaEntityReferenceType[] = [];

  while (pending.length > 0) {
    const current = pending.pop()!;
    switch (current.kind) {
      case 'binary':
        pending.push(current.left, current.right);
        break;
      case 'unary':
        pending.push(current.operand);
        break;
      case 'call':
        pending.push(...current.args);
        break;
      case 'ref':
        if (current.target.type !== 'variable') {
          types.push(current.target.type);
        }
        break;
      default:
        break;
    }
  }

  return types;
};

const computeExpressionDepth = (node: ExpressionNode): number => {
  switch (node.kind) {
    case 'literal':
    case 'ref':
      return 1;
    case 'unary':
      return 1 + computeExpressionDepth(node.operand);
    case 'binary':
      return (
        1 +
        Math.max(
          computeExpressionDepth(node.left),
          computeExpressionDepth(node.right),
        )
      );
    case 'call':
      return (
        1 +
        node.args.reduce<number>(
          (deepest, arg) => Math.max(deepest, computeExpressionDepth(arg)),
          0,
        )
      );
    default:
      return 1;
  }
};

describe('createFormulaArbitrary', () => {
  it('produces schemas that parse and evaluate to finite non-negative numbers', () => {
    const formulaArb = createFormulaArbitrary();
    const contextArb = createFormulaEvaluationContextArbitrary();
    fc.assert(
      fc.property(formulaArb, contextArb, (formula, context) => {
        const parseResult = numericFormulaSchema.safeParse(formula);
        expect(parseResult.success).toBe(true);

        const value = evaluateNumericFormula(formula, context);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }),
      propertyConfig(0),
    );
  });

  it('generates constant formulas whose evaluation matches their value', () => {
    const formulaArb = createFormulaArbitrary({ kinds: ['constant'] });
    const contextArb = createFormulaEvaluationContextArbitrary();
    fc.assert(
      fc.property(formulaArb, contextArb, (formula, context) => {
        expect(formula.kind).toBe('constant');
        if (formula.kind !== 'constant') {
          return;
        }
        const value = evaluateNumericFormula(formula, context);
        expect(value).toBe(formula.value);
        expect(value).toBeGreaterThanOrEqual(0);
      }),
      propertyConfig(1),
    );
  });

  it('generates linear formulas that grow monotonically with level', () => {
    const formulaArb = createFormulaArbitrary({ kinds: ['linear'] });
    fc.assert(
      fc.property(
        formulaArb,
        fc.double({ min: 0, max: 250, noNaN: true }),
        fc.double({ min: 0, max: 250, noNaN: true }),
        (formula, levelA, levelB) => {
          const lower = Math.min(levelA, levelB);
          const upper = Math.max(levelA, levelB);

          const baseContext = createDeterministicFormulaEvaluationContext();
          const lowContext = withLevel(baseContext, lower);
          const highContext = withLevel(baseContext, upper);

          const lowValue = evaluateNumericFormula(formula, lowContext);
          const highValue = evaluateNumericFormula(formula, highContext);

          expect(lowValue).toBeGreaterThanOrEqual(0);
          expect(highValue).toBeGreaterThanOrEqual(lowValue);
          expect(Number.isFinite(highValue)).toBe(true);
        },
      ),
      propertyConfig(2),
    );
  });

  it('generates exponential formulas that remain finite and non-decreasing', () => {
    const formulaArb = createFormulaArbitrary({ kinds: ['exponential'] });
    fc.assert(
      fc.property(
        formulaArb,
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (formula, levelA, levelB) => {
          const lower = Math.min(levelA, levelB);
          const upper = Math.max(levelA, levelB);
          const baseContext = createDeterministicFormulaEvaluationContext();

          const lowValue = evaluateNumericFormula(formula, withLevel(baseContext, lower));
          const highValue = evaluateNumericFormula(formula, withLevel(baseContext, upper));

          expect(Number.isFinite(lowValue)).toBe(true);
          expect(Number.isFinite(highValue)).toBe(true);
          expect(highValue).toBeGreaterThanOrEqual(lowValue);
        },
      ),
      propertyConfig(3),
    );
  });

  it('generates polynomial formulas with non-negative outputs for non-negative levels', () => {
    const formulaArb = createFormulaArbitrary({ kinds: ['polynomial'] });
    fc.assert(
      fc.property(
        formulaArb,
        fc.double({ min: 0, max: 25, noNaN: true }),
        (formula, sampleLevel) => {
          const context = withLevel(createDeterministicFormulaEvaluationContext(), sampleLevel);
          const value = evaluateNumericFormula(formula, context);
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        },
      ),
      propertyConfig(4),
    );
  });

  it('generates piecewise formulas with ordered segments and catch-all clause', () => {
    const formulaArb = createFormulaArbitrary({
      kinds: ['piecewise', 'constant', 'linear'],
    }).filter((formula) => formula.kind === 'piecewise');

    fc.assert(
      fc.property(formulaArb, (formula) => {
        expect(formula.pieces.length).toBeGreaterThan(0);

        const lastPiece = formula.pieces[formula.pieces.length - 1]!;
        expect(lastPiece.untilLevel).toBeUndefined();

        for (let index = 0; index < formula.pieces.length - 1; index += 1) {
          const current = formula.pieces[index]!;
          const next = formula.pieces[index + 1]!;
          expect(current.untilLevel).toBeDefined();
          expect(current.untilLevel).toBeLessThan(next.untilLevel ?? Infinity);
        }

        const baseContext = createDeterministicFormulaEvaluationContext();
        const penultimate = formula.pieces.length > 1
          ? formula.pieces[formula.pieces.length - 2]
          : undefined;
        const penultimateLevel =
          penultimate && penultimate.untilLevel !== undefined
            ? penultimate.untilLevel
            : baseContext.level;

        const sampleLevels = [
          0,
          ...formula.pieces
            .slice(0, -1)
            .map((piece) => Math.max(0, (piece.untilLevel ?? 0) - 0.5)),
          penultimateLevel + 5,
        ];

        sampleLevels.forEach((sampleLevel) => {
          const context = withLevel(baseContext, sampleLevel);
          const value = evaluateNumericFormula(formula, context);
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        });
      }),
      propertyConfig(5),
    );
  });

  it('supports piecewise-only kind selection', () => {
    const formulaArb = createFormulaArbitrary({ kinds: ['piecewise'] });

    fc.assert(
      fc.property(formulaArb, (formula) => {
        expect(formula.kind).toBe('piecewise');
        if (formula.kind !== 'piecewise') {
          return;
        }

        expect(formula.pieces.length).toBeGreaterThan(0);
        const lastPiece = formula.pieces[formula.pieces.length - 1]!;
        expect(lastPiece.untilLevel).toBeUndefined();

        const baseContext = createDeterministicFormulaEvaluationContext();
        const sampleLevels = [0, baseContext.level, baseContext.level + 10];
        sampleLevels.forEach((level) => {
          const context = withLevel(baseContext, level);
          const value = evaluateNumericFormula(formula, context);
          expect(Number.isFinite(value)).toBe(true);
          expect(value).toBeGreaterThanOrEqual(0);
        });
      }),
      { ...propertyConfig(6), numRuns: 120 },
    );
  });

  it('generates expression formulas that evaluate to finite non-negative results', () => {
    const formulaArb = createFormulaArbitrary({ kinds: ['expression'] });
    const contextArb = createFormulaEvaluationContextArbitrary();
    fc.assert(
      fc.property(formulaArb, contextArb, (formula, context) => {
        const value = evaluateNumericFormula(formula, context);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }),
      propertyConfig(7),
    );
  });

  it('keeps expression depth within caller limits when adding non-negative guards', () => {
    const depthCaps = [1, 2, 3, 4] as const;
    depthCaps.forEach((maxExpressionDepth, index) => {
      const formulaArb = createFormulaArbitrary({
        kinds: ['expression'],
        maxExpressionDepth,
      });
      fc.assert(
        fc.property(formulaArb, (formula) => {
          expect(formula.kind).toBe('expression');
          if (formula.kind !== 'expression') {
            return;
          }

          const expression = formula.expression;
          const depth = computeExpressionDepth(expression);
          const isGuarded =
            expression.kind === 'binary' &&
            expression.op === 'max' &&
            expression.left.kind === 'literal' &&
            expression.left.value === 0;

          expect(depth).toBeLessThanOrEqual(maxExpressionDepth);

          if (maxExpressionDepth < 2) {
            expect(isGuarded).toBe(false);
            return;
          }

          if (!isGuarded) {
            return;
          }

          const guardDepth = computeExpressionDepth(expression.right);
          expect(depth).toBe(guardDepth + 1);
          expect(guardDepth).toBeLessThanOrEqual(maxExpressionDepth - 1);
        }),
        propertyConfig(11 + index),
      );
    });
  });

  it('respects fractional minimums for root degrees', () => {
    const rootRange = { min: 2.7, max: 5 };
    const minExpectedDegree = Math.max(1, Math.ceil(rootRange.min));
    const maxExpectedDegree = Math.max(
      minExpectedDegree,
      Math.max(1, Math.floor(rootRange.max)),
    );

    const expressionWithRootArb = createFormulaArbitrary({
      kinds: ['expression'],
      rootDegreeRange: rootRange,
      maxExpressionDepth: 3,
    }).filter(
      (formula) =>
        formula.kind === 'expression' && containsRootCall(formula.expression),
    );

    fc.assert(
      fc.property(expressionWithRootArb, (formula) => {
        expect(formula.kind).toBe('expression');
        if (formula.kind !== 'expression') {
          return;
        }

        const degrees = collectRootDegrees(formula.expression);
        expect(degrees.length).toBeGreaterThan(0);
        degrees.forEach((degree) => {
          expect(degree).toBeGreaterThanOrEqual(minExpectedDegree);
          expect(degree).toBeLessThanOrEqual(maxExpectedDegree);
        });
      }),
      propertyConfig(8),
    );
  });

  it('omits entity references for empty reference pools', () => {
    const emptyResourcePool = { resource: [] as const };
    const formulaArb = createFormulaArbitrary({
      kinds: ['expression'],
      referencePools: emptyResourcePool,
    }).filter((formula) => formula.kind === 'expression');
    const contextArb = createFormulaEvaluationContextArbitrary(emptyResourcePool);

    fc.assert(
      fc.property(formulaArb, contextArb, (formula, context) => {
        expect(formula.kind).toBe('expression');
        if (formula.kind !== 'expression') {
          return;
        }

        const entityTypes = collectEntityReferenceTypes(formula.expression);
        expect(entityTypes).not.toContain('resource');
        expect(Object.keys(context.resources)).toHaveLength(0);

        const value = evaluateNumericFormula(formula, context);
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThanOrEqual(0);
      }),
      propertyConfig(9),
    );
  });

  it('limits piecewise thresholds to available integer levels', () => {
    const piecewiseRange = { min: 0, max: 1.5 };

    const piecewiseOnlyArb = createFormulaArbitrary({
      kinds: ['piecewise'],
      piecewiseLevelRange: piecewiseRange,
      maxPiecewiseSegments: 4,
    });

    fc.assert(
      fc.property(piecewiseOnlyArb, (formula) => {
        expect(formula.kind).toBe('piecewise');
        if (formula.kind !== 'piecewise') {
          return;
        }

        const levelMin = Math.ceil(piecewiseRange.min);
        const levelMax = Math.floor(piecewiseRange.max);
        const availableLevels = Math.max(0, levelMax - levelMin + 1);

        expect(formula.pieces.length - 1).toBeLessThanOrEqual(availableLevels);
        formula.pieces.slice(0, -1).forEach((piece) => {
          expect(piece.untilLevel).toBeDefined();
          expect(piece.untilLevel).toBeGreaterThanOrEqual(levelMin);
          expect(piece.untilLevel).toBeLessThanOrEqual(levelMax);
        });
      }),
      { ...propertyConfig(10), numRuns: 80 },
    );
  });

  it('never generates piecewise thresholds above the floored maximum level', () => {
    const piecewiseRange = { min: 0, max: 1.5 };
    const piecewiseOnlyArb = createFormulaArbitrary({
      kinds: ['piecewise'],
      piecewiseLevelRange: piecewiseRange,
      maxPiecewiseSegments: 4,
    });

    const samples = fc.sample(piecewiseOnlyArb, { seed: 1337, numRuns: 400 });
    const levelMin = Math.ceil(piecewiseRange.min);
    const levelMax = Math.floor(piecewiseRange.max);

    samples.forEach((formula) => {
      expect(formula.kind).toBe('piecewise');
      if (formula.kind !== 'piecewise') {
        return;
      }

      const thresholds = formula.pieces.slice(0, -1).map((piece) => piece.untilLevel);
      thresholds.forEach((untilLevel) => {
        expect(untilLevel).toBeDefined();
        if (untilLevel === undefined) {
          return;
        }

        expect(untilLevel).toBeGreaterThanOrEqual(levelMin);
        expect(untilLevel).toBeLessThanOrEqual(levelMax);
      });
    });
  });
});
