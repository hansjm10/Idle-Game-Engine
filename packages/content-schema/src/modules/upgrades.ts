import { z } from 'zod';

import { conditionSchema, type Condition } from '../base/conditions.js';
import { contentIdSchema, flagIdSchema } from '../base/ids.js';
import { localizedTextSchema } from '../base/localization.js';
import { numericFormulaSchema } from '../base/formulas.js';
import { finiteNumberSchema, nonNegativeNumberSchema, positiveIntSchema } from '../base/numbers.js';

type ContentId = z.infer<typeof contentIdSchema>;
type ContentIdInput = z.input<typeof contentIdSchema>;
type NumericFormula = z.infer<typeof numericFormulaSchema>;
type NumericFormulaInput = z.input<typeof numericFormulaSchema>;
type FlagId = z.infer<typeof flagIdSchema>;
type FlagIdInput = z.input<typeof flagIdSchema>;
type ConditionInput = z.input<typeof conditionSchema>;

const tagSchema = z
  .string()
  .trim()
  .min(1, { message: 'Tags must contain at least one character.' })
  .max(24, { message: 'Tags must contain at most 24 characters.' })
  .regex(/^[a-z0-9][a-z0-9/_:-]*$/i, {
    message:
      'Tags must start with an alphanumeric character and may include "-", "_", ":", or "/" thereafter.',
  })
  .transform((value) => value.toLowerCase());

const adjustmentOperationSchema = z.enum(['add', 'multiply', 'set'] as const);

type AdjustmentOperation = z.infer<typeof adjustmentOperationSchema>;

const upgradeTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('resource'),
      id: contentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('generator'),
      id: contentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('automation'),
      id: contentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('prestigeLayer'),
      id: contentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('guildPerk'),
      id: contentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('global'),
    })
    .strict(),
]);

const costSchema = z
  .object({
    currencyId: contentIdSchema,
    baseCost: nonNegativeNumberSchema,
    costCurve: numericFormulaSchema,
    maxBulk: positiveIntSchema.optional(),
  })
  .strict();

type UpgradeEffect =
  | {
      readonly kind: 'modifyResourceRate';
      readonly resourceId: ContentId;
      readonly operation: AdjustmentOperation;
      readonly value: NumericFormula;
    }
  | {
      readonly kind: 'modifyGeneratorRate';
      readonly generatorId: ContentId;
      readonly operation: AdjustmentOperation;
      readonly value: NumericFormula;
    }
  | {
      readonly kind: 'modifyGeneratorCost';
      readonly generatorId: ContentId;
      readonly operation: AdjustmentOperation;
      readonly value: NumericFormula;
    }
  | {
      readonly kind: 'grantAutomation';
      readonly automationId: ContentId;
    }
  | {
      readonly kind: 'grantFlag';
      readonly flagId: FlagId;
      readonly value: boolean;
    }
  | {
      readonly kind: 'unlockResource';
      readonly resourceId: ContentId;
    }
  | {
      readonly kind: 'unlockGenerator';
      readonly generatorId: ContentId;
    }
  | {
      readonly kind: 'alterDirtyTolerance';
      readonly resourceId: ContentId;
      readonly operation: AdjustmentOperation;
      readonly value: NumericFormula;
    }
  | {
      readonly kind: 'emitEvent';
      readonly eventId: ContentId;
    };

type UpgradeEffectInput =
  | {
      readonly kind: 'modifyResourceRate';
      readonly resourceId: ContentIdInput;
      readonly operation: AdjustmentOperation;
      readonly value: NumericFormulaInput;
    }
  | {
      readonly kind: 'modifyGeneratorRate';
      readonly generatorId: ContentIdInput;
      readonly operation: AdjustmentOperation;
      readonly value: NumericFormulaInput;
    }
  | {
      readonly kind: 'modifyGeneratorCost';
      readonly generatorId: ContentIdInput;
      readonly operation: AdjustmentOperation;
      readonly value: NumericFormulaInput;
    }
  | {
      readonly kind: 'grantAutomation';
      readonly automationId: ContentIdInput;
    }
  | {
      readonly kind: 'grantFlag';
      readonly flagId: FlagIdInput;
      readonly value?: boolean;
    }
  | {
      readonly kind: 'unlockResource';
      readonly resourceId: ContentIdInput;
    }
  | {
      readonly kind: 'unlockGenerator';
      readonly generatorId: ContentIdInput;
    }
  | {
      readonly kind: 'alterDirtyTolerance';
      readonly resourceId: ContentIdInput;
      readonly operation: AdjustmentOperation;
      readonly value: NumericFormulaInput;
    }
  | {
      readonly kind: 'emitEvent';
      readonly eventId: ContentIdInput;
    };

const effectSchema: z.ZodType<UpgradeEffect, z.ZodTypeDef, UpgradeEffectInput> = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('modifyResourceRate'),
      resourceId: contentIdSchema,
      operation: adjustmentOperationSchema,
      value: numericFormulaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('modifyGeneratorRate'),
      generatorId: contentIdSchema,
      operation: adjustmentOperationSchema,
      value: numericFormulaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('modifyGeneratorCost'),
      generatorId: contentIdSchema,
      operation: adjustmentOperationSchema,
      value: numericFormulaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('grantAutomation'),
      automationId: contentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('grantFlag'),
      flagId: flagIdSchema,
      value: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      kind: z.literal('unlockResource'),
      resourceId: contentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unlockGenerator'),
      generatorId: contentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('alterDirtyTolerance'),
      resourceId: contentIdSchema,
      operation: adjustmentOperationSchema,
      value: numericFormulaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('emitEvent'),
      eventId: contentIdSchema,
    })
    .strict(),
]);

const prerequisiteEntrySchema: z.ZodType<
  Condition,
  z.ZodTypeDef,
  ConditionInput | ContentIdInput
> = z
  .union([conditionSchema, contentIdSchema])
  .transform((entry) => {
    if (typeof entry === 'string') {
      const prerequisite: Condition = {
        kind: 'upgradeOwned',
        upgradeId: entry,
        requiredPurchases: 1,
      };
      return prerequisite;
    }
    return entry;
  });

const normalizeTags = (tags: readonly string[]): readonly string[] =>
  Object.freeze(
    [...new Set(tags)].sort((left, right) => left.localeCompare(right)),
  );

const ensureUniqueTargets = (
  targets: readonly z.infer<typeof upgradeTargetSchema>[],
  ctx: z.RefinementCtx,
) => {
  const seen = new Map<string, number>();
  targets.forEach((target, index) => {
    const id = target.kind === 'global' ? 'global' : `${target.kind}:${target.id}`;
    const existing = seen.get(id);
    if (existing !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets', index],
        message: `Duplicate upgrade target "${id}" also declared at index ${existing}.`,
      });
      return;
    }
    seen.set(id, index);
  });
};

type RepeatableUpgrade = {
  readonly maxPurchases?: number;
  readonly costCurve?: z.infer<typeof numericFormulaSchema>;
  readonly effectCurve?: z.infer<typeof numericFormulaSchema>;
};

type UpgradeDefinitionInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly icon?: string;
  readonly tags?: readonly string[];
  readonly category: 'global' | 'resource' | 'generator' | 'automation' | 'prestige' | 'guild';
  readonly targets: readonly z.input<typeof upgradeTargetSchema>[];
  readonly cost: z.input<typeof costSchema>;
  readonly repeatable?: {
    readonly maxPurchases?: z.input<typeof positiveIntSchema>;
    readonly costCurve?: z.input<typeof numericFormulaSchema>;
    readonly effectCurve?: z.input<typeof numericFormulaSchema>;
  };
  readonly prerequisites?: readonly z.input<typeof prerequisiteEntrySchema>[];
  readonly order?: z.input<typeof finiteNumberSchema>;
  readonly effects: readonly UpgradeEffectInput[];
  readonly unlockCondition?: z.input<typeof conditionSchema>;
  readonly visibilityCondition?: z.input<typeof conditionSchema>;
};

type UpgradeDefinition = {
  readonly id: ContentId;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly icon?: string;
  readonly tags: readonly string[];
  readonly category: 'global' | 'resource' | 'generator' | 'automation' | 'prestige' | 'guild';
  readonly targets: readonly z.infer<typeof upgradeTargetSchema>[];
  readonly cost: z.infer<typeof costSchema>;
  readonly repeatable?: RepeatableUpgrade;
  readonly prerequisites: readonly Condition[];
  readonly order?: number;
  readonly effects: readonly UpgradeEffect[];
  readonly unlockCondition?: z.infer<typeof conditionSchema>;
  readonly visibilityCondition?: z.infer<typeof conditionSchema>;
};

const compareOrderable = (left: UpgradeDefinition, right: UpgradeDefinition) => {
  const leftOrder =
    left.order === undefined ? Number.POSITIVE_INFINITY : left.order;
  const rightOrder =
    right.order === undefined ? Number.POSITIVE_INFINITY : right.order;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
};

export const upgradeDefinitionSchema: z.ZodType<
  UpgradeDefinition,
  z.ZodTypeDef,
  UpgradeDefinitionInput
> = z
  .object({
    id: contentIdSchema,
    name: localizedTextSchema,
    icon: z
      .string()
      .trim()
      .min(1, { message: 'Icon paths must contain at least one character.' })
      .max(128, { message: 'Icon paths must contain at most 128 characters.' })
      .optional(),
    tags: z.array(tagSchema).default([]),
    category: z.enum(['global', 'resource', 'generator', 'automation', 'prestige', 'guild'] as const),
    targets: z.array(upgradeTargetSchema).min(1, {
      message: 'Upgrades must target at least one entity.',
    }),
    cost: costSchema,
    repeatable: z
      .object({
        maxPurchases: positiveIntSchema.optional(),
        costCurve: numericFormulaSchema.optional(),
        effectCurve: numericFormulaSchema.optional(),
      })
      .strict()
      .optional(),
    prerequisites: z.array(prerequisiteEntrySchema).default([]),
    order: finiteNumberSchema.optional(),
    effects: z.array(effectSchema).min(1, {
      message: 'Upgrades must declare at least one effect.',
    }),
    unlockCondition: conditionSchema.optional(),
    visibilityCondition: conditionSchema.optional(),
  })
  .strict()
  .superRefine((upgrade, ctx) => {
    ensureUniqueTargets(upgrade.targets, ctx);
    if (upgrade.repeatable) {
      const { repeatable } = upgrade;
      if (
        repeatable.maxPurchases === undefined &&
        repeatable.costCurve === undefined &&
        repeatable.effectCurve === undefined
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repeatable'],
          message: 'Repeatable upgrades must declare at least one progression parameter.',
        });
      }
    }
    const seenEffectKinds = new Map<string, number>();
    upgrade.effects.forEach((effect, index) => {
      const key =
        effect.kind === 'grantFlag'
          ? `grantFlag:${effect.flagId}`
          : effect.kind === 'grantAutomation'
          ? `grantAutomation:${effect.automationId}`
          : effect.kind === 'emitEvent'
          ? `emitEvent:${effect.eventId}`
          : undefined;
      if (key) {
        const existing = seenEffectKinds.get(key);
        if (existing !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['effects', index],
            message: `Duplicate effect "${key}" also declared at index ${existing}.`,
          });
        } else {
          seenEffectKinds.set(key, index);
        }
      }
    });
  })
  .transform((upgrade) => ({
    ...upgrade,
    tags: normalizeTags(upgrade.tags),
    targets: Object.freeze([...upgrade.targets]),
    effects: Object.freeze([...upgrade.effects]),
    prerequisites: Object.freeze([...upgrade.prerequisites]),
  }));

export const upgradeCollectionSchema = z
  .array(upgradeDefinitionSchema)
  .superRefine((upgrades, ctx) => {
    const seen = new Map<string, number>();
    upgrades.forEach((upgrade, index) => {
      const existingIndex = seen.get(upgrade.id);
      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate upgrade id "${upgrade.id}" also defined at index ${existingIndex}.`,
        });
      } else {
        seen.set(upgrade.id, index);
      }
    });
  })
  .transform((upgrades) =>
    Object.freeze(
      [...upgrades].sort((left, right) => compareOrderable(left, right)),
    ),
  );

export type Upgrade = z.infer<typeof upgradeDefinitionSchema>;
export const upgradeEffectSchema = effectSchema;
