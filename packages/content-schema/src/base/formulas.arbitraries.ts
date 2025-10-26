import * as fc from 'fast-check';

import { contentIdSchema } from './ids.js';
import {
  CALL_FUNCTION_NAMES,
  MAX_EXPRESSION_DEPTH,
  MAX_FORMULA_DEPTH,
  NumericFormula,
  ExpressionNode,
  numericFormulaSchema,
  EntityReferenceTarget,
  VariableReferenceTarget,
} from './formulas.js';

type EntityReferenceType = EntityReferenceTarget['type'];
type ContentIdValue = ReturnType<typeof contentIdSchema.parse>;

export type FormulaReferencePools = Record<
  EntityReferenceType,
  readonly ContentIdValue[]
>;

const ALL_FORMULA_KINDS: readonly NumericFormula['kind'][] = [
  'constant',
  'linear',
  'exponential',
  'polynomial',
  'piecewise',
  'expression',
] as const;

const ENTITY_REFERENCE_TYPES: readonly EntityReferenceType[] = [
  'resource',
  'generator',
  'upgrade',
  'automation',
  'prestigeLayer',
] as const;

const VARIABLE_NAMES: readonly VariableReferenceTarget['name'][] = [
  'level',
  'time',
  'deltaTime',
] as const;

const mapContentIds = (values: readonly string[]): readonly ContentIdValue[] =>
  values.map((value) => contentIdSchema.parse(value));

const DEFAULT_REFERENCE_POOL: FormulaReferencePools = {
  resource: mapContentIds(['resource/ore-vein', 'resource/copper', 'resource/energy-core']),
  generator: mapContentIds(['generator/ore-drill', 'generator/smelter']),
  upgrade: mapContentIds(['upgrade/miner-capacity', 'upgrade/smelter-efficiency']),
  automation: mapContentIds(['automation/logistics-bot', 'automation/smelter-daemon']),
  prestigeLayer: mapContentIds(['prestige/main-loop', 'prestige/endgame']),
};

const sanitizeReferencePool = (
  pool: Partial<Record<EntityReferenceType, readonly string[]>> | undefined,
): FormulaReferencePools => {
  const resolved: FormulaReferencePools = { ...DEFAULT_REFERENCE_POOL };
  if (!pool) {
    return resolved;
  }

  ENTITY_REFERENCE_TYPES.forEach((type) => {
    if (!Object.prototype.hasOwnProperty.call(pool, type)) {
      return;
    }
    const entries = pool[type];
    if (!entries || entries.length === 0) {
      resolved[type] = [];
      return;
    }
    resolved[type] = entries.map((entry) => contentIdSchema.parse(entry));
  });

  return resolved;
};

const toLiteral = (value: number): ExpressionNode => ({
  kind: 'literal',
  value,
});

const createVariableRef = (name: VariableReferenceTarget['name']): ExpressionNode => ({
  kind: 'ref',
  target: {
    type: 'variable',
    name,
  },
});

const createEntityRef = (
  type: EntityReferenceType,
  id: ContentIdValue,
): ExpressionNode => ({
  kind: 'ref',
  target: {
    type,
    id,
  },
});

type Range = {
  readonly min: number;
  readonly max: number;
};

const DEFAULT_NUMERIC_RANGE: Range = { min: 0, max: 1_000 };
const DEFAULT_STRICTLY_POSITIVE_RANGE: Range = { min: 0.1, max: 1_000 };
const DEFAULT_EXPONENTIAL_GROWTH_RANGE: Range = { min: 1.01, max: 2 };
const DEFAULT_EXPONENT_RANGE: Range = { min: 1, max: 5 };
const DEFAULT_ROOT_DEGREE_RANGE: Range = { min: 1, max: 6 };
const DEFAULT_PIECEWISE_LEVEL_RANGE: Range = { min: 1, max: 100 };

const isFiniteNumber = (value: number): value is number => Number.isFinite(value);

type RangeSanitizationOptions = {
  readonly requireStrictlyPositiveMin?: boolean;
};

const sanitizeRange = (
  candidate: Range | undefined,
  fallback: Range,
  { requireStrictlyPositiveMin = false }: RangeSanitizationOptions = {},
): Range => {
  if (!candidate) {
    return fallback;
  }

  const { min: rawMin, max: rawMax } = candidate;

  if (!isFiniteNumber(rawMin) || !isFiniteNumber(rawMax)) {
    return fallback;
  }

  const lower = Math.min(rawMin, rawMax);
  const upper = Math.max(rawMin, rawMax);

  if (requireStrictlyPositiveMin) {
    if (lower <= 0 || upper <= 0) {
      return fallback;
    }
  }

  return { min: lower, max: upper };
};

const createNumberArb = ({ min, max }: Range): fc.Arbitrary<number> =>
  fc.double({
    min,
    max,
    noDefaultInfinity: true,
    noNaN: true,
  });

const clampDepth = (depth: number, maximum: number): number =>
  Math.max(0, Math.min(depth, maximum));

const wrapWithNonNegativeGuard = (expression: ExpressionNode): ExpressionNode => ({
  kind: 'binary',
  op: 'max',
  left: toLiteral(0),
  right: expression,
});

type ResolvedArbitraryOptions = {
  readonly maxFormulaDepth: number;
  readonly maxExpressionDepth: number;
  readonly maxPiecewiseSegments: number;
  readonly maxPolynomialCoefficients: number;
  readonly numericRange: Range;
  readonly strictlyPositiveRange: Range;
  readonly exponentialGrowthRange: Range;
  readonly exponentRange: Range;
  readonly rootDegreeRange: { readonly min: number; readonly max: number };
  readonly piecewiseLevelRange: { readonly min: number; readonly max: number };
};

export type FormulaArbitraryOptions = {
  readonly maxFormulaDepth?: number;
  readonly maxExpressionDepth?: number;
  readonly maxPiecewiseSegments?: number;
  readonly maxPolynomialCoefficients?: number;
  readonly numericRange?: Range;
  readonly strictlyPositiveRange?: Range;
  readonly exponentialGrowthRange?: Range;
  readonly exponentRange?: Range;
  readonly rootDegreeRange?: { readonly min: number; readonly max: number };
  readonly piecewiseLevelRange?: { readonly min: number; readonly max: number };
  readonly referencePools?: Partial<Record<EntityReferenceType, readonly string[]>>;
  readonly kinds?: readonly NumericFormula['kind'][];
};

const resolveOptions = (options?: FormulaArbitraryOptions): ResolvedArbitraryOptions => {
  const maxFormulaDepth = clampDepth(options?.maxFormulaDepth ?? 5, MAX_FORMULA_DEPTH - 1);
  const maxExpressionDepth = clampDepth(
    options?.maxExpressionDepth ?? 5,
    MAX_EXPRESSION_DEPTH - 1,
  );
  const numericRange = sanitizeRange(options?.numericRange, DEFAULT_NUMERIC_RANGE);
  const strictlyPositiveRange = sanitizeRange(
    options?.strictlyPositiveRange,
    DEFAULT_STRICTLY_POSITIVE_RANGE,
    { requireStrictlyPositiveMin: true },
  );
  const exponentialGrowthRange = sanitizeRange(
    options?.exponentialGrowthRange,
    DEFAULT_EXPONENTIAL_GROWTH_RANGE,
    { requireStrictlyPositiveMin: true },
  );
  const exponentRange = sanitizeRange(options?.exponentRange, DEFAULT_EXPONENT_RANGE);
  const rootDegreeRange = sanitizeRange(
    options?.rootDegreeRange,
    DEFAULT_ROOT_DEGREE_RANGE,
    { requireStrictlyPositiveMin: true },
  );
  const piecewiseLevelRange = sanitizeRange(
    options?.piecewiseLevelRange,
    DEFAULT_PIECEWISE_LEVEL_RANGE,
  );

  return {
    maxFormulaDepth,
    maxExpressionDepth,
    maxPiecewiseSegments: Math.max(1, Math.min(options?.maxPiecewiseSegments ?? 4, 6)),
    maxPolynomialCoefficients: Math.max(
      1,
      Math.min(options?.maxPolynomialCoefficients ?? 5, 8),
    ),
    numericRange,
    strictlyPositiveRange,
    exponentialGrowthRange,
    exponentRange,
    rootDegreeRange,
    piecewiseLevelRange,
  };
};

const createExpressionArbitraryInternal = (
  resolved: ResolvedArbitraryOptions,
  pools: Record<EntityReferenceType, readonly ContentIdValue[]>,
): fc.Arbitrary<ExpressionNode> => {
  const nonNegativeNumber = createNumberArb(resolved.numericRange);
  const strictlyPositiveNumber = createNumberArb(resolved.strictlyPositiveRange);

  const literalNode = nonNegativeNumber.map((value) => toLiteral(value));
  const positiveLiteralNode = strictlyPositiveNumber.map((value) => toLiteral(value));

  const variableRefNode = fc
    .constantFrom(...VARIABLE_NAMES)
    .map((name) => createVariableRef(name));

  const referencePairs = ENTITY_REFERENCE_TYPES.flatMap((type) =>
    pools[type].map((id) => [type, id] as const),
  );

  const leafCandidates: fc.Arbitrary<ExpressionNode>[] = [literalNode, variableRefNode];

  if (referencePairs.length > 0) {
    const entityRefNode = fc
      .constantFrom(...referencePairs)
      .map(([type, id]) => createEntityRef(type, id));
    leafCandidates.push(entityRefNode);
  }

  const leafNode = fc.oneof(...leafCandidates);

  const expressionCache = new Map<number, fc.Arbitrary<ExpressionNode>>();
  const positiveCache = new Map<number, fc.Arbitrary<ExpressionNode>>();
  const strictlyPositiveCache = new Map<number, fc.Arbitrary<ExpressionNode>>();

  const getExpression = (depth: number): fc.Arbitrary<ExpressionNode> => {
    const normalized = clampDepth(depth, resolved.maxExpressionDepth);
    if (!expressionCache.has(normalized)) {
      expressionCache.set(normalized, buildExpression(normalized));
    }
    return expressionCache.get(normalized)!;
  };

  const getPositiveExpression = (depth: number): fc.Arbitrary<ExpressionNode> => {
    const normalized = clampDepth(depth, resolved.maxExpressionDepth);
    if (!positiveCache.has(normalized)) {
      positiveCache.set(normalized, buildPositiveExpression(normalized));
    }
    return positiveCache.get(normalized)!;
  };

  const getStrictlyPositiveExpression = (
    depth: number,
  ): fc.Arbitrary<ExpressionNode> => {
    const normalized = clampDepth(depth, resolved.maxExpressionDepth);
    if (!strictlyPositiveCache.has(normalized)) {
      strictlyPositiveCache.set(normalized, buildStrictlyPositiveExpression(normalized));
    }
    return strictlyPositiveCache.get(normalized)!;
  };

  const buildPositiveExpression = (depth: number): fc.Arbitrary<ExpressionNode> => {
    if (depth <= 0) {
      return fc.oneof(literalNode, fc.constant(toLiteral(0)));
    }

    const smaller = getExpression(depth - 1);

    return fc.oneof(
      literalNode,
      fc.constant(toLiteral(0)),
      fc.record({
        kind: fc.constant('unary'),
        op: fc.constant('abs'),
        operand: smaller,
      }),
      fc.record({
        kind: fc.constant('binary'),
        op: fc.constant('max'),
        left: literalNode,
        right: smaller,
      }),
    );
  };

  const buildStrictlyPositiveExpression = (
    depth: number,
  ): fc.Arbitrary<ExpressionNode> => {
    if (depth <= 0) {
      return positiveLiteralNode;
    }

    const positive = getPositiveExpression(depth - 1);

    return fc.oneof(
      positiveLiteralNode,
      fc.record({
        kind: fc.constant('binary'),
        op: fc.constant('max'),
        left: positiveLiteralNode,
        right: positive,
      }),
    );
  };

  const buildExpression = (depth: number): fc.Arbitrary<ExpressionNode> => {
    if (depth <= 0) {
      return leafNode;
    }

    const smaller = getExpression(depth - 1);
    const positive = getPositiveExpression(depth - 1);
    const strictlyPositive = getStrictlyPositiveExpression(depth - 1);

    const unaryNodes: fc.Arbitrary<ExpressionNode>[] = [
      fc.record({
        kind: fc.constant('unary'),
        op: fc.constant('abs'),
        operand: smaller,
      }),
      fc.record({
        kind: fc.constant('unary'),
        op: fc.constant('ceil'),
        operand: smaller,
      }),
      fc.record({
        kind: fc.constant('unary'),
        op: fc.constant('floor'),
        operand: smaller,
      }),
      fc.record({
        kind: fc.constant('unary'),
        op: fc.constant('round'),
        operand: smaller,
      }),
      fc.record({
        kind: fc.constant('unary'),
        op: fc.constant('sqrt'),
        operand: positive,
      }),
      fc.record({
        kind: fc.constant('unary'),
        op: fc.constant('log10'),
        operand: strictlyPositive,
      }),
      fc.record({
        kind: fc.constant('unary'),
        op: fc.constant('ln'),
        operand: strictlyPositive,
      }),
    ];

    const exponentLiteral = fc
      .integer({
        min: Math.ceil(resolved.exponentRange.min),
        max: Math.floor(resolved.exponentRange.max),
      })
      .map((value) => toLiteral(value));

    const minRootDegree = Math.max(1, Math.ceil(resolved.rootDegreeRange.min));
    const maxRootDegree = Math.max(
      minRootDegree,
      Math.max(1, Math.floor(resolved.rootDegreeRange.max)),
    );

    const binaryNodes: fc.Arbitrary<ExpressionNode>[] = [
      fc.tuple(smaller, smaller).map(([left, right]) => ({
        kind: 'binary' as const,
        op: 'add' as const,
        left,
        right,
      })),
      fc.tuple(smaller, smaller).map(([left, right]) => ({
        kind: 'binary' as const,
        op: 'sub' as const,
        left,
        right,
      })),
      fc.tuple(smaller, smaller).map(([left, right]) => ({
        kind: 'binary' as const,
        op: 'mul' as const,
        left,
        right,
      })),
      fc.tuple(smaller, strictlyPositive).map(([left, right]) => ({
        kind: 'binary' as const,
        op: 'div' as const,
        left,
        right,
      })),
      fc.tuple(positive, exponentLiteral).map(([left, right]) => ({
        kind: 'binary' as const,
        op: 'pow' as const,
        left,
        right,
      })),
      fc.tuple(smaller, smaller).map(([left, right]) => ({
        kind: 'binary' as const,
        op: 'min' as const,
        left,
        right,
      })),
      fc.tuple(smaller, smaller).map(([left, right]) => ({
        kind: 'binary' as const,
        op: 'max' as const,
        left,
        right,
      })),
    ];

    const callNodes: fc.Arbitrary<ExpressionNode>[] = [
      fc.tuple(smaller, positive, positive).map(([value, minValue, maxValue]) => ({
        kind: 'call' as const,
        name: 'clamp' satisfies (typeof CALL_FUNCTION_NAMES)[number],
        args: [value, minValue, maxValue],
      })),
      fc.tuple(smaller, smaller, fc.double({ min: 0, max: 1, noNaN: true })).map(
        ([start, end, t]) => ({
          kind: 'call' as const,
          name: 'lerp' satisfies (typeof CALL_FUNCTION_NAMES)[number],
          args: [start, end, toLiteral(t)],
        }),
      ),
      fc.tuple(smaller, smaller, smaller).map((args) => ({
        kind: 'call' as const,
        name: 'min3' satisfies (typeof CALL_FUNCTION_NAMES)[number],
        args,
      })),
      fc.tuple(smaller, smaller, smaller).map((args) => ({
        kind: 'call' as const,
        name: 'max3' satisfies (typeof CALL_FUNCTION_NAMES)[number],
        args,
      })),
      fc.double({ min: -3, max: 3, noNaN: true }).map((exponent) => ({
        kind: 'call' as const,
        name: 'pow10' satisfies (typeof CALL_FUNCTION_NAMES)[number],
        args: [toLiteral(exponent)],
      })),
      fc.tuple(
        strictlyPositive,
        fc
          .integer({
            min: minRootDegree,
            max: maxRootDegree,
          })
          .map((value) => toLiteral(value)),
      ).map(([value, degree]) => ({
        kind: 'call' as const,
        name: 'root' satisfies (typeof CALL_FUNCTION_NAMES)[number],
        args: [value, degree],
      })),
    ];

    return fc.oneof(leafNode, ...unaryNodes, ...binaryNodes, ...callNodes);
  };

  return getExpression(resolved.maxExpressionDepth);
};

const createPiecewiseArbitrary = (
  resolved: ResolvedArbitraryOptions,
  subFormula: fc.Arbitrary<NumericFormula>,
): fc.Arbitrary<NumericFormula> => {
  const levelMin = Math.ceil(resolved.piecewiseLevelRange.min);
  const levelMax = Math.floor(resolved.piecewiseLevelRange.max);
  const availableLevels = Math.max(0, levelMax - levelMin + 1);
  const maxNonTerminalCount = Math.min(
    resolved.maxPiecewiseSegments - 1,
    availableLevels,
  );

  return fc
    .integer({ min: 0, max: maxNonTerminalCount })
    .chain((nonTerminalCount) => {
      const thresholdsArb =
        nonTerminalCount === 0
          ? fc.constant<number[]>([])
          : fc
              .uniqueArray(
                fc.integer({
                  min: levelMin,
                  max: levelMax,
                }),
                {
                  minLength: nonTerminalCount,
                  maxLength: nonTerminalCount,
                },
              )
              .map((levels) => levels.slice().sort((a, b) => a - b));

      const formulasArb = fc.array(subFormula, {
        minLength: nonTerminalCount + 1,
        maxLength: nonTerminalCount + 1,
      });

      return fc.tuple(thresholdsArb, formulasArb).map(([thresholds, formulas]) => {
        type PiecewiseSegment = { readonly untilLevel?: number; readonly formula: NumericFormula };
        const pieces: PiecewiseSegment[] = thresholds.map((untilLevel, index) => ({
          untilLevel,
          formula: formulas[index]!,
        }));
        pieces.push({
          formula: formulas[formulas.length - 1]!,
        });
        return {
          kind: 'piecewise' as const,
          pieces,
        } satisfies NumericFormula;
      });
    });
};

export interface FormulaEvaluationContext {
  readonly level: number;
  readonly time: number;
  readonly deltaTime: number;
  readonly resources: Readonly<Record<string, number>>;
  readonly generators: Readonly<Record<string, number>>;
  readonly upgrades: Readonly<Record<string, number>>;
  readonly automations: Readonly<Record<string, number>>;
  readonly prestigeLayers: Readonly<Record<string, number>>;
}

const createEntityValueLookup = (
  pools: Record<EntityReferenceType, readonly string[]>,
  value: number,
): {
  readonly resources: Record<string, number>;
  readonly generators: Record<string, number>;
  readonly upgrades: Record<string, number>;
  readonly automations: Record<string, number>;
  readonly prestigeLayers: Record<string, number>;
} => ({
  resources: Object.fromEntries(pools.resource.map((id) => [id, value] as const)),
  generators: Object.fromEntries(pools.generator.map((id) => [id, value] as const)),
  upgrades: Object.fromEntries(pools.upgrade.map((id) => [id, value] as const)),
  automations: Object.fromEntries(pools.automation.map((id) => [id, value] as const)),
  prestigeLayers: Object.fromEntries(pools.prestigeLayer.map((id) => [id, value] as const)),
});

const getEntityValue = (
  context: FormulaEvaluationContext,
  type: EntityReferenceType,
  id: string,
): number => {
  switch (type) {
    case 'resource':
      return context.resources[id] ?? 0;
    case 'generator':
      return context.generators[id] ?? 0;
    case 'upgrade':
      return context.upgrades[id] ?? 0;
    case 'automation':
      return context.automations[id] ?? 0;
    case 'prestigeLayer':
      return context.prestigeLayers[id] ?? 0;
    default:
      return 0;
  }
};

const evaluateExpression = (
  expression: ExpressionNode,
  context: FormulaEvaluationContext,
): number => {
  switch (expression.kind) {
    case 'literal':
      return expression.value;
    case 'ref': {
      if (expression.target.type === 'variable') {
        const variable = expression.target.name;
        switch (variable) {
          case 'level':
            return context.level;
          case 'time':
            return context.time;
          case 'deltaTime':
            return context.deltaTime;
          default:
            return 0;
        }
      }
      return getEntityValue(context, expression.target.type, expression.target.id);
    }
    case 'binary': {
      const left = evaluateExpression(expression.left, context);
      const right = evaluateExpression(expression.right, context);
      switch (expression.op) {
        case 'add':
          return left + right;
        case 'sub':
          return left - right;
        case 'mul':
          return left * right;
        case 'div':
          return right === 0 ? Number.POSITIVE_INFINITY : left / right;
        case 'pow':
          return Math.pow(left, right);
        case 'min':
          return Math.min(left, right);
        case 'max':
          return Math.max(left, right);
        default:
          return Number.NaN;
      }
    }
    case 'unary': {
      const operand = evaluateExpression(expression.operand, context);
      switch (expression.op) {
        case 'abs':
          return Math.abs(operand);
        case 'ceil':
          return Math.ceil(operand);
        case 'floor':
          return Math.floor(operand);
        case 'round':
          return Math.round(operand);
        case 'sqrt':
          return operand < 0 ? Number.NaN : Math.sqrt(operand);
        case 'log10':
          return operand <= 0 ? Number.NaN : Math.log10(operand);
        case 'ln':
          return operand <= 0 ? Number.NaN : Math.log(operand);
        default:
          return Number.NaN;
      }
    }
    case 'call': {
      const args = expression.args.map((arg) => evaluateExpression(arg, context));
      switch (expression.name) {
        case 'clamp': {
          const [value, minValue, maxValue] = args;
          if (args.length < 3) {
            return Number.NaN;
          }
          const lower = Math.min(minValue, maxValue);
          const upper = Math.max(minValue, maxValue);
          return Math.min(Math.max(value, lower), upper);
        }
        case 'lerp': {
          const [start, end, tValue = 0] = args;
          const clampedT = Math.min(Math.max(tValue, 0), 1);
          return start + (end - start) * clampedT;
        }
        case 'min3':
          return Math.min(...args);
        case 'max3':
          return Math.max(...args);
        case 'pow10': {
          const [exponent = 0] = args;
          return Math.pow(10, exponent);
        }
        case 'root': {
          const [value, degree = 1] = args;
          if (degree === 0) {
            return Number.NaN;
          }
          return value < 0 && degree % 2 === 0
            ? Number.NaN
            : Math.pow(value, 1 / degree);
        }
        default:
          return Number.NaN;
      }
    }
    default:
      return Number.NaN;
  }
};

export const evaluateNumericFormula = (
  formula: NumericFormula,
  context: FormulaEvaluationContext,
): number => {
  switch (formula.kind) {
    case 'constant':
      return formula.value;
    case 'linear':
      return formula.base + formula.slope * context.level;
    case 'exponential': {
      const offset = formula.offset ?? 0;
      return formula.base * Math.pow(formula.growth, context.level) + offset;
    }
    case 'polynomial': {
      return formula.coefficients.reduce((total, coefficient, index) => {
        return total + coefficient * Math.pow(context.level, index);
      }, 0);
    }
    case 'piecewise': {
      if (formula.pieces.length === 0) {
        return Number.NaN;
      }
      const { level } = context;
      const [lastPiece] = formula.pieces.slice(-1);
      for (const piece of formula.pieces.slice(0, -1)) {
        if (piece.untilLevel === undefined || level < piece.untilLevel) {
          return evaluateNumericFormula(piece.formula, context);
        }
      }
      if (!lastPiece) {
        return Number.NaN;
      }
      return evaluateNumericFormula(lastPiece.formula, context);
    }
    case 'expression':
      return evaluateExpression(formula.expression, context);
    default:
      return Number.NaN;
  }
};

export const DEFAULT_FORMULA_PROPERTY_SEED = 177013;

export const createFormulaArbitrary = (
  options?: FormulaArbitraryOptions,
): fc.Arbitrary<NumericFormula> => {
  const resolved = resolveOptions(options);
  const pools = sanitizeReferencePool(options?.referencePools);
  const guardableExpressionDepth = resolved.maxExpressionDepth >= 2;
  const expressionDepthBudget = guardableExpressionDepth
    ? Math.max(0, resolved.maxExpressionDepth - 2)
    : Math.max(0, resolved.maxExpressionDepth - 1);
  const expressionOptions =
    expressionDepthBudget === resolved.maxExpressionDepth
      ? resolved
      : { ...resolved, maxExpressionDepth: expressionDepthBudget };
  const expressionArbitrary = createExpressionArbitraryInternal(expressionOptions, pools);
  const allowedKinds = new Set<NumericFormula['kind']>(
    (options?.kinds?.length ? options.kinds : ALL_FORMULA_KINDS) as readonly NumericFormula['kind'][],
  );

  const formulaCache = new Map<number, fc.Arbitrary<NumericFormula>>();

  const nonNegativeNumber = createNumberArb(resolved.numericRange);
  const exponentialGrowth = createNumberArb(resolved.exponentialGrowthRange);

  const getFormula = (depth: number): fc.Arbitrary<NumericFormula> => {
    const normalized = clampDepth(depth, resolved.maxFormulaDepth);
    if (!formulaCache.has(normalized)) {
      formulaCache.set(normalized, buildFormula(normalized));
    }
    return formulaCache.get(normalized)!;
  };

  const buildFormula = (depth: number): fc.Arbitrary<NumericFormula> => {
    const baseFormulas: fc.Arbitrary<NumericFormula>[] = [];

    if (allowedKinds.has('constant')) {
      baseFormulas.push(
        nonNegativeNumber.map(
          (value) =>
            ({
              kind: 'constant',
              value,
            }) satisfies NumericFormula,
        ),
      );
    }

    if (allowedKinds.has('linear')) {
      baseFormulas.push(
        fc.tuple(nonNegativeNumber, nonNegativeNumber).map(([base, slope]) => ({
          kind: 'linear' as const,
          base,
          slope,
        })),
      );
    }

    if (allowedKinds.has('exponential')) {
      baseFormulas.push(
        fc
          .tuple(nonNegativeNumber, exponentialGrowth, fc.option(nonNegativeNumber))
          .map(([base, growth, offset]) => ({
            kind: 'exponential' as const,
            base,
            growth,
            offset: offset ?? 0,
          })),
      );
    }

    if (allowedKinds.has('polynomial')) {
      baseFormulas.push(
        fc
          .array(nonNegativeNumber, {
            minLength: 1,
            maxLength: resolved.maxPolynomialCoefficients,
          })
          .map((coefficients) => ({
            kind: 'polynomial' as const,
            coefficients,
          })),
      );
    }

    const nestedFormulas: fc.Arbitrary<NumericFormula>[] = [];

    if (allowedKinds.has('expression')) {
      nestedFormulas.push(
        expressionArbitrary.map((expression) => ({
          kind: 'expression' as const,
          expression: guardableExpressionDepth
            ? wrapWithNonNegativeGuard(expression)
            : expression,
        })),
      );
    }

    if (allowedKinds.has('piecewise')) {
      // Ensure piecewise segments remain constructible even when no other kinds are allowed.
      const terminalFormula =
        baseFormulas.length > 0
          ? fc.oneof(...baseFormulas)
          : nonNegativeNumber.map(
              (value) =>
                ({
                  kind: 'constant' as const,
                  value,
                }) satisfies NumericFormula,
            );
      const segmentFormula = depth > 0 ? getFormula(depth - 1) : terminalFormula;
      nestedFormulas.push(createPiecewiseArbitrary(resolved, segmentFormula));
    }

    if (depth <= 0) {
      const baseCandidates = [...baseFormulas, ...nestedFormulas];
      if (baseCandidates.length === 0) {
        throw new Error(
          'createFormulaArbitrary requires at least one allowed formula kind to be specified.',
        );
      }
      return fc.oneof(...baseCandidates);
    }

    const candidates = [...baseFormulas, ...nestedFormulas];
    if (candidates.length === 0) {
      throw new Error(
        'createFormulaArbitrary requires at least one allowed formula kind to be specified.',
      );
    }

    return fc.oneof(...candidates);
  };

  return getFormula(resolved.maxFormulaDepth).filter((formula) => {
    const parseResult = numericFormulaSchema.safeParse(formula);
    return parseResult.success;
  });
};

export interface FormulaEvaluationContextArbitraryOptions {
  readonly levelRange?: Range;
  readonly timeRange?: Range;
  readonly deltaTimeRange?: Range;
  readonly entityValueRange?: Range;
}

const DEFAULT_CONTEXT_LEVEL_RANGE: Range = { min: 0, max: 200 };
const DEFAULT_CONTEXT_TIME_RANGE: Range = { min: 0, max: 10_000 };
const DEFAULT_CONTEXT_DELTA_TIME_RANGE: Range = { min: 0.016, max: 60 };
const DEFAULT_CONTEXT_ENTITY_VALUE_RANGE: Range = { min: 0, max: 10_000 };

export const createFormulaEvaluationContextArbitrary = (
  pools?: Partial<Record<EntityReferenceType, readonly string[]>>,
  options?: FormulaEvaluationContextArbitraryOptions,
): fc.Arbitrary<FormulaEvaluationContext> => {
  const resolvedPools = sanitizeReferencePool(pools);
  const levelRange = sanitizeRange(options?.levelRange, DEFAULT_CONTEXT_LEVEL_RANGE);
  const timeRange = sanitizeRange(options?.timeRange, DEFAULT_CONTEXT_TIME_RANGE);
  const deltaTimeRange = sanitizeRange(
    options?.deltaTimeRange,
    DEFAULT_CONTEXT_DELTA_TIME_RANGE,
  );
  const entityValueRange = sanitizeRange(
    options?.entityValueRange,
    DEFAULT_CONTEXT_ENTITY_VALUE_RANGE,
  );

  const entityValueArb = createNumberArb(entityValueRange);

  const createEntityRecord = (type: EntityReferenceType) => {
    const entries = Object.fromEntries(
      resolvedPools[type].map((id) => [id, entityValueArb] as const),
    ) as Record<string, fc.Arbitrary<number>>;
    return fc.record(entries);
  };

  return fc.record({
    level: createNumberArb(levelRange),
    time: createNumberArb(timeRange),
    deltaTime: createNumberArb(deltaTimeRange),
    resources: createEntityRecord('resource'),
    generators: createEntityRecord('generator'),
    upgrades: createEntityRecord('upgrade'),
    automations: createEntityRecord('automation'),
    prestigeLayers: createEntityRecord('prestigeLayer'),
  });
};

export const createDeterministicFormulaEvaluationContext = (
  pools?: Partial<Record<EntityReferenceType, readonly string[]>>,
): FormulaEvaluationContext => {
  const resolvedPools = sanitizeReferencePool(pools);
  const lookup = createEntityValueLookup(resolvedPools, 100);
  return {
    level: 10,
    time: 1_000,
    deltaTime: 1,
    resources: lookup.resources,
    generators: lookup.generators,
    upgrades: lookup.upgrades,
    automations: lookup.automations,
    prestigeLayers: lookup.prestigeLayers,
  };
};

export type {
  EntityReferenceType as FormulaEntityReferenceType,
  ResolvedArbitraryOptions as ResolvedFormulaArbitraryOptions,
};
