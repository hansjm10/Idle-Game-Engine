import { z } from 'zod';

import { contentIdSchema, flagIdSchema, scriptIdSchema } from './ids.js';
import { numericFormulaSchema } from './formulas.js';
import type { NumericFormula } from './formulas.js';
import { positiveIntSchema } from './numbers.js';

const MAX_CONDITION_DEPTH = 16;
const MAX_CONDITION_NODE_COUNT = 256;

const COMPARATORS = ['gte', 'gt', 'lte', 'lt'] as const;

const comparatorSchema = z.enum(COMPARATORS);

type ContentId = z.infer<typeof contentIdSchema>;
type FlagId = z.infer<typeof flagIdSchema>;
type ScriptId = z.infer<typeof scriptIdSchema>;
type PositiveInt = z.infer<typeof positiveIntSchema>;
type ConditionComparatorValue = z.infer<typeof comparatorSchema>;

type ContentIdInput = z.input<typeof contentIdSchema>;
type FlagIdInput = z.input<typeof flagIdSchema>;
type ScriptIdInput = z.input<typeof scriptIdSchema>;
type NumericFormulaInput = z.input<typeof numericFormulaSchema>;
type PositiveIntInput = z.input<typeof positiveIntSchema>;

type ConditionNode =
  | { kind: 'always' }
  | { kind: 'never' }
  | {
      kind: 'resourceThreshold';
      resourceId: ContentId;
      comparator: ConditionComparatorValue;
      amount: NumericFormula;
    }
  | {
      kind: 'generatorLevel';
      generatorId: ContentId;
      comparator: ConditionComparatorValue;
      level: NumericFormula;
    }
  | {
      kind: 'upgradeOwned';
      upgradeId: ContentId;
      requiredPurchases: PositiveInt;
    }
  | {
      kind: 'prestigeUnlocked';
      prestigeLayerId: ContentId;
    }
  | {
      kind: 'flag';
      flagId: FlagId;
    }
  | {
      kind: 'script';
      scriptId: ScriptId;
    }
  | {
      kind: 'allOf';
      conditions: ConditionNode[];
    }
  | {
      kind: 'anyOf';
      conditions: ConditionNode[];
    }
  | {
      kind: 'not';
      condition: ConditionNode;
    };

type ConditionNodeInput =
  | { kind: 'always' }
  | { kind: 'never' }
  | {
      kind: 'resourceThreshold';
      resourceId: ContentIdInput;
      comparator: ConditionComparatorValue;
      amount: NumericFormulaInput;
    }
  | {
      kind: 'generatorLevel';
      generatorId: ContentIdInput;
      comparator: ConditionComparatorValue;
      level: NumericFormulaInput;
    }
  | {
      kind: 'upgradeOwned';
      upgradeId: ContentIdInput;
      requiredPurchases?: PositiveIntInput;
    }
  | {
      kind: 'prestigeUnlocked';
      prestigeLayerId: ContentIdInput;
    }
  | {
      kind: 'flag';
      flagId: FlagIdInput;
    }
  | {
      kind: 'script';
      scriptId: ScriptIdInput;
    }
  | {
      kind: 'allOf';
      conditions: ConditionNodeInput[];
    }
  | {
      kind: 'anyOf';
      conditions: ConditionNodeInput[];
    }
  | {
      kind: 'not';
      condition: ConditionNodeInput;
    };

const createConditionSchema = (
  self: z.ZodType<ConditionNode, z.ZodTypeDef, ConditionNodeInput>,
) =>
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
        conditions: z.array(self).min(1, {
          message: 'allOf conditions must include at least one nested condition.',
        }),
      })
      .strict(),
    z
      .object({
        kind: z.literal('anyOf'),
        conditions: z.array(self).min(1, {
          message: 'anyOf conditions must include at least one nested condition.',
        }),
      })
      .strict(),
    z
      .object({
        kind: z.literal('not'),
        condition: self,
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

export const conditionSchema: z.ZodType<
  ConditionNode,
  z.ZodTypeDef,
  ConditionNodeInput
> = z
  .lazy(() => createConditionSchema(conditionSchema))
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
