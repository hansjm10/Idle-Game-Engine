import { z } from 'zod';

import { contentIdSchema } from './ids.js';
import { finiteNumberSchema } from './numbers.js';

type ContentId = z.infer<typeof contentIdSchema>;

export type VariableReferenceTarget = {
  type: 'variable';
  name: 'level' | 'time' | 'deltaTime';
};

export type EntityReferenceTarget = {
  type: 'resource' | 'generator' | 'upgrade' | 'automation' | 'prestigeLayer';
  id: ContentId;
};

export type ExpressionNodeModel =
  | { kind: 'literal'; value: number }
  | { kind: 'ref'; target: VariableReferenceTarget | EntityReferenceTarget }
  | {
      kind: 'binary';
      op: (typeof BINARY_OPERATORS)[number];
      left: ExpressionNodeModel;
      right: ExpressionNodeModel;
    }
  | {
      kind: 'unary';
      op: (typeof UNARY_OPERATORS)[number];
      operand: ExpressionNodeModel;
    }
  | {
      kind: 'call';
      name: (typeof CALL_FUNCTION_NAMES)[number];
      args: ExpressionNodeModel[];
    };

export type NumericFormulaModel =
  | { kind: 'constant'; value: number }
  | { kind: 'linear'; base: number; slope: number }
  | {
      kind: 'exponential';
      base: number;
      growth: number;
      offset?: number;
    }
  | { kind: 'polynomial'; coefficients: number[] }
  | { kind: 'piecewise'; pieces: PiecewiseSegmentModel[] }
  | { kind: 'expression'; expression: ExpressionNodeModel };

type PiecewiseSegmentModel = {
  untilLevel?: number;
  formula: NumericFormulaModel;
};

type ContentIdInput = z.input<typeof contentIdSchema>;

type EntityReferenceTargetInput = {
  type: 'resource' | 'generator' | 'upgrade' | 'automation' | 'prestigeLayer';
  id: ContentIdInput;
};

type ExpressionNodeInput =
  | { kind: 'literal'; value: number }
  | {
      kind: 'ref';
      target: VariableReferenceTarget | EntityReferenceTargetInput;
    }
  | {
      kind: 'binary';
      op: (typeof BINARY_OPERATORS)[number];
      left: ExpressionNodeInput;
      right: ExpressionNodeInput;
    }
  | {
      kind: 'unary';
      op: (typeof UNARY_OPERATORS)[number];
      operand: ExpressionNodeInput;
    }
  | {
      kind: 'call';
      name: (typeof CALL_FUNCTION_NAMES)[number];
      args: ExpressionNodeInput[];
    };

type PiecewiseSegmentInput = {
  untilLevel?: number;
  formula: NumericFormulaInput;
};

type NumericFormulaInput =
  | { kind: 'constant'; value: number }
  | { kind: 'linear'; base: number; slope: number }
  | {
      kind: 'exponential';
      base?: number;
      growth: number;
      offset?: number;
    }
  | { kind: 'polynomial'; coefficients: number[] }
  | { kind: 'piecewise'; pieces: PiecewiseSegmentInput[] }
  | { kind: 'expression'; expression: ExpressionNodeInput };

export const BINARY_OPERATORS = [
  'add',
  'sub',
  'mul',
  'div',
  'pow',
  'min',
  'max',
] as const;

export const UNARY_OPERATORS = [
  'abs',
  'ceil',
  'floor',
  'round',
  'sqrt',
  'log10',
  'ln',
] as const;

export const CALL_FUNCTION_NAMES = [
  'clamp',
  'lerp',
  'min3',
  'max3',
  'pow10',
  'root',
] as const;

export const CALL_FUNCTION_ARITY = {
  clamp: 3,
  lerp: 3,
  min3: 3,
  max3: 3,
  pow10: 1,
  root: 2,
} as const satisfies Record<(typeof CALL_FUNCTION_NAMES)[number], number>;

export const MAX_EXPRESSION_DEPTH = 16;
export const MAX_EXPRESSION_NODE_COUNT = 256;
export const MAX_FORMULA_DEPTH = 16;
export const MAX_FORMULA_NODE_COUNT = 256;

const variableReferenceTargetSchema = z
  .object({
    type: z.literal('variable'),
    name: z.enum(['level', 'time', 'deltaTime'] as const),
  })
  .strict();

const entityReferenceTargetSchema = z
  .object({
    type: z.enum(
      ['resource', 'generator', 'upgrade', 'automation', 'prestigeLayer'] as const,
    ),
    id: contentIdSchema,
  })
  .strict();

const expressionReferenceTargetSchema = z.discriminatedUnion('type', [
  variableReferenceTargetSchema,
  entityReferenceTargetSchema,
]);

const literalExpressionSchema = z
  .object({
    kind: z.literal('literal'),
    value: finiteNumberSchema,
  })
  .strict();

const createExpressionNodeSchema = (
  self: z.ZodType<ExpressionNodeModel, z.ZodTypeDef, ExpressionNodeInput>,
) =>
  z
    .discriminatedUnion('kind', [
      literalExpressionSchema,
      z
        .object({
          kind: z.literal('ref'),
          target: expressionReferenceTargetSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('binary'),
          op: z.enum(BINARY_OPERATORS),
          left: self,
          right: self,
        })
        .strict(),
      z
        .object({
          kind: z.literal('unary'),
          op: z.enum(UNARY_OPERATORS),
          operand: self,
        })
        .strict(),
      z
        .object({
          kind: z.literal('call'),
          name: z.enum(CALL_FUNCTION_NAMES),
          args: z.array(self),
        })
        .strict(),
    ])
    .superRefine((node, ctx) => {
      if (node.kind !== 'call') {
        return;
      }
      const expectedArity = CALL_FUNCTION_ARITY[node.name];
      if (node.args.length !== expectedArity) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Function ${node.name} expects ${expectedArity} arguments, received ${node.args.length}.`,
          path: ['args'],
        });
      }
    });

export const expressionNodeSchema: z.ZodType<
  ExpressionNodeModel,
  z.ZodTypeDef,
  ExpressionNodeInput
> = z
  .lazy(() => createExpressionNodeSchema(expressionNodeSchema))
  .superRefine((node, ctx) => {
    const depth = getExpressionDepth(node);
    if (depth > MAX_EXPRESSION_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expression depth exceeds maximum allowed depth (${MAX_EXPRESSION_DEPTH}).`,
      });
    }

    const nodeCount = countExpressionNodes(node);
    if (nodeCount > MAX_EXPRESSION_NODE_COUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Expression node count ${nodeCount} exceeds the maximum of ${MAX_EXPRESSION_NODE_COUNT}.`,
      });
    }
  });

const createPieceSchema = (
  self: z.ZodType<NumericFormulaModel, z.ZodTypeDef, NumericFormulaInput>,
) =>
  z
    .object({
      untilLevel: finiteNumberSchema.optional(),
      formula: self,
    })
    .strict();

const createNumericFormulaSchema = (
  self: z.ZodType<NumericFormulaModel, z.ZodTypeDef, NumericFormulaInput>,
) =>
  z.discriminatedUnion('kind', [
    z
      .object({
        kind: z.literal('constant'),
        value: finiteNumberSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('linear'),
        base: finiteNumberSchema,
        slope: finiteNumberSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('exponential'),
        base: finiteNumberSchema.default(1),
        growth: finiteNumberSchema,
        offset: finiteNumberSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('polynomial'),
        coefficients: z
          .array(finiteNumberSchema, {
            invalid_type_error: 'Polynomial coefficients must be numeric.',
          })
          .min(1, {
            message: 'Polynomial formulas require at least one coefficient.',
          }),
      })
      .strict(),
    z
      .object({
        kind: z.literal('piecewise'),
        pieces: z
          .array(createPieceSchema(self))
          .min(1, { message: 'Piecewise formulas require at least one piece.' }),
      })
      .strict(),
    z
      .object({
        kind: z.literal('expression'),
        expression: expressionNodeSchema,
      })
      .strict(),
  ]);

export const numericFormulaSchema: z.ZodType<
  NumericFormulaModel,
  z.ZodTypeDef,
  NumericFormulaInput
> = z
  .lazy(() => createNumericFormulaSchema(numericFormulaSchema))
  .superRefine((formula, ctx) => {
    if (formula.kind === 'piecewise') {
      validatePiecewise(formula.pieces, ctx);
    }

    const depth = getFormulaDepth(formula);
    if (depth > MAX_FORMULA_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Formula depth ${depth} exceeds the maximum of ${MAX_FORMULA_DEPTH}.`,
      });
    }

    const nodeCount = countFormulaNodes(formula);
    if (nodeCount > MAX_FORMULA_NODE_COUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Formula node count ${nodeCount} exceeds the maximum of ${MAX_FORMULA_NODE_COUNT}.`,
      });
    }
  });

export const formulaNodeSchema = expressionNodeSchema;

export type ExpressionNode = ExpressionNodeModel; // NOSONAR - public API alias for schema consumers
export type NumericFormula = NumericFormulaModel; // NOSONAR - public API alias for schema consumers

function countExpressionNodes(node: ExpressionNodeModel): number {
  switch (node.kind) {
    case 'literal':
    case 'ref':
      return 1;
    case 'unary':
      return 1 + countExpressionNodes(node.operand);
    case 'binary':
      return 1 + countExpressionNodes(node.left) + countExpressionNodes(node.right);
    case 'call':
      return (
        1 +
        node.args.reduce<number>(
          (total, arg) => total + countExpressionNodes(arg),
          0,
        )
      );
    default:
      return 1;
  }
}

function getExpressionDepth(node: ExpressionNodeModel): number {
  switch (node.kind) {
    case 'literal':
    case 'ref':
      return 1;
    case 'unary':
      return 1 + getExpressionDepth(node.operand);
    case 'binary':
      return 1 + Math.max(getExpressionDepth(node.left), getExpressionDepth(node.right));
    case 'call':
      return (
        1 +
        node.args.reduce<number>(
          (deepest, arg) => Math.max(deepest, getExpressionDepth(arg)),
          0,
        )
      );
    default:
      return 1;
  }
}

function getFormulaDepth(formula: NumericFormulaModel): number {
  if (formula.kind === 'piecewise') {
    return (
      1 +
      formula.pieces.reduce<number>(
        (deepest, piece) => Math.max(deepest, getFormulaDepth(piece.formula)),
        0,
      )
    );
  }

  if (formula.kind === 'expression') {
    return getExpressionDepth(formula.expression);
  }

  return 1;
}

function countFormulaNodes(formula: NumericFormulaModel): number {
  if (formula.kind === 'piecewise') {
    return (
      1 +
      formula.pieces.reduce<number>(
        (total, piece) => total + countFormulaNodes(piece.formula),
        0,
      )
    );
  }

  if (formula.kind === 'expression') {
    return 1 + countExpressionNodes(formula.expression);
  }

  return 1;
}

function validatePiecewise(
  pieces: readonly PiecewiseSegmentModel[],
  ctx: z.RefinementCtx,
): void {
  let sawCatchAll = false;
  let previousLevel = Number.NEGATIVE_INFINITY;

  pieces.forEach((piece, index) => {
    const isLast = index === pieces.length - 1;

    if (isLast) {
      sawCatchAll = piece.untilLevel === undefined;
      if (!sawCatchAll) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['pieces', index, 'untilLevel'],
          message: 'Final piecewise segment must omit untilLevel to act as a catch-all.',
        });
      }
      return;
    }

    if (piece.untilLevel === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pieces', index, 'untilLevel'],
        message: 'Non-terminal piecewise segments must specify untilLevel.',
      });
      return;
    }

    if (piece.untilLevel <= previousLevel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['pieces', index, 'untilLevel'],
        message: 'Piecewise segments must declare strictly increasing untilLevel values.',
      });
    }

    previousLevel = piece.untilLevel;
  });

  if (!sawCatchAll) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['pieces'],
      message: 'Piecewise formulas must terminate with a catch-all segment.',
    });
  }
}
