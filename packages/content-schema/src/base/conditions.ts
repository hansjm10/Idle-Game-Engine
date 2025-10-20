import { z } from 'zod';

import { contentIdSchema, flagIdSchema, scriptIdSchema } from './ids.js';
import { numericFormulaSchema } from './formulas.js';
import { positiveIntSchema } from './numbers.js';

const MAX_CONDITION_DEPTH = 16;
const MAX_CONDITION_NODE_COUNT = 256;

const COMPARATORS = ['gte', 'gt', 'lte', 'lt'] as const;

const comparatorSchema = z.enum(COMPARATORS);

const createConditionSchema = (): z.ZodTypeAny =>
  z.discriminatedUnion('kind', [
    z
      .object({ kind: z.literal('always') })
      .strict(),
    z
      .object({ kind: z.literal('never') })
      .strict(),
    z
      .object({
        kind: z.literal('resourceThreshold'),
        resourceId: contentIdSchema,
        comparator: comparatorSchema,
        amount: numericFormulaSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('generatorLevel'),
        generatorId: contentIdSchema,
        comparator: comparatorSchema,
        level: numericFormulaSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('upgradeOwned'),
        upgradeId: contentIdSchema,
        requiredPurchases: positiveIntSchema.default(1),
      })
      .strict(),
    z
      .object({
        kind: z.literal('prestigeUnlocked'),
        prestigeLayerId: contentIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('flag'),
        flagId: flagIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('script'),
        scriptId: scriptIdSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal('allOf'),
        conditions: z.array(conditionSchema).min(1, {
          message: 'allOf conditions must include at least one nested condition.',
        }),
      })
      .strict(),
    z
      .object({
        kind: z.literal('anyOf'),
        conditions: z.array(conditionSchema).min(1, {
          message: 'anyOf conditions must include at least one nested condition.',
        }),
      })
      .strict(),
    z
      .object({
        kind: z.literal('not'),
        condition: conditionSchema,
      })
      .strict(),
  ]);

const countConditionNodes = (condition: unknown): number => {
  const typed = condition as { kind: string; [key: string]: unknown };
  switch (typed.kind) {
    case 'allOf':
    case 'anyOf':
      return (
        1 +
        (Array.isArray(typed.conditions)
          ? typed.conditions.reduce(
              (total, child) => total + countConditionNodes(child),
              0,
            )
          : 0)
      );
    case 'not':
      return 1 + countConditionNodes(typed.condition);
    default:
      return 1;
  }
};

const maxConditionDepth = (condition: unknown): number => {
  const typed = condition as { kind: string; [key: string]: unknown };
  switch (typed.kind) {
    case 'allOf':
    case 'anyOf':
      return (
        1 +
        (Array.isArray(typed.conditions)
          ? typed.conditions.reduce(
              (deepest, child) =>
                Math.max(deepest, maxConditionDepth(child)),
              0,
            )
          : 0)
      );
    case 'not':
      return 1 + maxConditionDepth(typed.condition);
    default:
      return 1;
  }
};

export const conditionSchema: z.ZodTypeAny = z
  .lazy(createConditionSchema)
  .superRefine((condition, ctx) => {
    const depth = maxConditionDepth(condition);
    if (depth > MAX_CONDITION_DEPTH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Condition depth ${depth} exceeds the maximum of ${MAX_CONDITION_DEPTH}.`,
      });
    }

    const nodeCount = countConditionNodes(condition);
    if (nodeCount > MAX_CONDITION_NODE_COUNT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Condition node count ${nodeCount} exceeds the maximum of ${MAX_CONDITION_NODE_COUNT}.`,
      });
    }
  });

export type ConditionComparator = z.infer<typeof comparatorSchema>;
export type Condition = z.infer<typeof conditionSchema>;
