import {
  BINARY_OPERATORS,
  CALL_FUNCTION_NAMES,
  UNARY_OPERATORS,
  type ExpressionNode,
  type NumericFormula,
} from './formulas.js';

type ReferenceNode = Extract<ExpressionNode, { kind: 'ref' }>;
type ReferenceTarget = ReferenceNode['target'];
type VariableReferenceTarget = Extract<ReferenceTarget, { type: 'variable' }>;
type EntityReferenceTarget = Exclude<ReferenceTarget, VariableReferenceTarget>;

type VariableName = VariableReferenceTarget['name'];
type EntityType = EntityReferenceTarget['type'];

type EntityValueLookup =
  | ReadonlyMap<string, number>
  | Readonly<Record<string, number>>
  | ((id: string) => number | undefined);

export interface FormulaEvaluationEntities {
  readonly resource?: EntityValueLookup;
  readonly generator?: EntityValueLookup;
  readonly upgrade?: EntityValueLookup;
  readonly automation?: EntityValueLookup;
  readonly prestigeLayer?: EntityValueLookup;
}

export interface FormulaEvaluationContext {
  readonly variables?: Partial<Record<VariableName, number>>;
  readonly entities?: Partial<Record<EntityType, EntityValueLookup>>;
  readonly getReferenceValue?: (target: ReferenceTarget) => number | undefined;
}

export const evaluateNumericFormula = (
  formula: NumericFormula,
  context: FormulaEvaluationContext = {},
): number => {
  switch (formula.kind) {
    case 'constant':
      return formula.value;
    case 'linear': {
      const level = resolveReferenceValue({ type: 'variable', name: 'level' }, context);
      return formula.base + formula.slope * level;
    }
    case 'exponential': {
      const level = resolveReferenceValue({ type: 'variable', name: 'level' }, context);
      const offset = formula.offset ?? 0;
      return formula.base * Math.pow(formula.growth, level) + offset;
    }
    case 'polynomial': {
      const level = resolveReferenceValue({ type: 'variable', name: 'level' }, context);
      return formula.coefficients.reduce((total, coefficient, index) => {
        return total + coefficient * Math.pow(level, index);
      }, 0);
    }
    case 'piecewise': {
      const level = resolveReferenceValue({ type: 'variable', name: 'level' }, context);
      const segment = selectPiecewiseSegment(formula.pieces, level);
      return evaluateNumericFormula(segment.formula, context);
    }
    case 'expression':
      return evaluateExpressionNode(formula.expression, context);
    default:
      return exhaustive(formula);
  }
};

export const evaluateExpressionNode = (
  node: ExpressionNode,
  context: FormulaEvaluationContext = {},
): number => {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'ref':
      return resolveReferenceValue(node.target, context);
    case 'binary':
      return evaluateBinary(node.op, node.left, node.right, context);
    case 'unary':
      return evaluateUnary(node.op, node.operand, context);
    case 'call':
      return evaluateCall(node.name, node.args, context);
    default:
      return exhaustive(node);
  }
};

const evaluateBinary = (
  op: (typeof BINARY_OPERATORS)[number],
  left: ExpressionNode,
  right: ExpressionNode,
  context: FormulaEvaluationContext,
): number => {
  const leftValue = evaluateExpressionNode(left, context);
  const rightValue = evaluateExpressionNode(right, context);
  switch (op) {
    case 'add':
      return leftValue + rightValue;
    case 'sub':
      return leftValue - rightValue;
    case 'mul':
      return leftValue * rightValue;
    case 'div':
      return leftValue / rightValue;
    case 'pow':
      return Math.pow(leftValue, rightValue);
    case 'min':
      return Math.min(leftValue, rightValue);
    case 'max':
      return Math.max(leftValue, rightValue);
    default:
      return exhaustive(op);
  }
};

const evaluateUnary = (
  op: (typeof UNARY_OPERATORS)[number],
  operand: ExpressionNode,
  context: FormulaEvaluationContext,
): number => {
  const value = evaluateExpressionNode(operand, context);
  switch (op) {
    case 'abs':
      return Math.abs(value);
    case 'ceil':
      return Math.ceil(value);
    case 'floor':
      return Math.floor(value);
    case 'round':
      return Math.round(value);
    case 'sqrt':
      return Math.sqrt(value);
    case 'log10':
      return Math.log10(value);
    case 'ln':
      return Math.log(value);
    default:
      return exhaustive(op);
  }
};

const evaluateCall = (
  name: (typeof CALL_FUNCTION_NAMES)[number],
  args: ExpressionNode[],
  context: FormulaEvaluationContext,
): number => {
  switch (name) {
    case 'clamp': {
      const [value, minValue, maxValue] = evaluateArguments(args, 3, context);
      const lower = Math.min(minValue, maxValue);
      const upper = Math.max(minValue, maxValue);
      return Math.min(Math.max(value, lower), upper);
    }
    case 'lerp': {
      const [start, end, t] = evaluateArguments(args, 3, context);
      return start + (end - start) * t;
    }
    case 'min3': {
      const [a, b, c] = evaluateArguments(args, 3, context);
      return Math.min(a, b, c);
    }
    case 'max3': {
      const [a, b, c] = evaluateArguments(args, 3, context);
      return Math.max(a, b, c);
    }
    case 'pow10': {
      const [exponent] = evaluateArguments(args, 1, context);
      return Math.pow(10, exponent);
    }
    case 'root': {
      const [value, degree] = evaluateArguments(args, 2, context);
      return Math.pow(value, 1 / degree);
    }
    default:
      return exhaustive(name);
  }
};

const evaluateArguments = (
  args: ExpressionNode[],
  expectedLength: number,
  context: FormulaEvaluationContext,
): number[] => {
  if (args.length !== expectedLength) {
    throw new Error(
      `Function expects ${expectedLength} arguments, received ${args.length}.`,
    );
  }
  return args.map((arg) => evaluateExpressionNode(arg, context));
};

const selectPiecewiseSegment = (
  pieces: Extract<NumericFormula, { kind: 'piecewise' }>['pieces'],
  level: number,
) => {
  for (const piece of pieces) {
    if (piece.untilLevel === undefined) {
      return piece;
    }
    if (level < piece.untilLevel) {
      return piece;
    }
  }
  return pieces[pieces.length - 1]!;
};

const resolveReferenceValue = (
  target: ReferenceTarget,
  context: FormulaEvaluationContext,
): number => {
  const fromResolver = context.getReferenceValue?.(target);
  if (fromResolver !== undefined) {
    return fromResolver;
  }

  if (target.type === 'variable') {
    return resolveVariableValue(target, context);
  }

  return resolveEntityValue(target, context);
};

const resolveVariableValue = (
  target: VariableReferenceTarget,
  context: FormulaEvaluationContext,
): number => {
  const value = context.variables?.[target.name];
  if (value === undefined) {
    throw new Error(
      `Missing variable "${target.name}" in formula evaluation context.`,
    );
  }
  return value;
};

const resolveEntityValue = (
  target: EntityReferenceTarget,
  context: FormulaEvaluationContext,
): number => {
  const lookup = context.entities?.[target.type];
  if (!lookup) {
    throw new Error(
      `Missing entity lookup for type "${target.type}" while resolving "${target.id}".`,
    );
  }

  const value = getEntityValue(lookup, target.id);
  if (value === undefined) {
    throw new Error(
      `Missing entity value for type "${target.type}" with id "${target.id}".`,
    );
  }
  return value;
};

const getEntityValue = (
  lookup: EntityValueLookup,
  id: string,
): number | undefined => {
  if (typeof lookup === 'function') {
    return lookup(id);
  }
  if (lookup instanceof Map) {
    return lookup.get(id);
  }
  if (isRecordLookup(lookup)) {
    if (Object.prototype.hasOwnProperty.call(lookup, id)) {
      return lookup[id];
    }
    return undefined;
  }
  return undefined;
};

const isRecordLookup = (
  value: unknown,
): value is Readonly<Record<string, number>> =>
  typeof value === 'object' && value !== null && !(value instanceof Map);

const exhaustive = (value: never): never => {
  throw new Error(`Unhandled value: ${String(value)}`);
};
