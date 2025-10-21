import { z } from 'zod';

import { conditionSchema } from '../base/conditions.js';
import { contentIdSchema } from '../base/ids.js';
import { localizedTextSchema } from '../base/localization.js';
import { numericFormulaSchema } from '../base/formulas.js';
import {
  finiteNumberSchema,
  nonNegativeNumberSchema,
  positiveIntSchema,
} from '../base/numbers.js';
import { upgradeEffectSchema } from './upgrades.js';

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

type ContentId = z.infer<typeof contentIdSchema>;

const productionEntrySchema = z
  .object({
    resourceId: contentIdSchema,
    rate: numericFormulaSchema,
  })
  .strict();

const consumptionEntrySchema = z
  .object({
    resourceId: contentIdSchema,
    rate: numericFormulaSchema,
  })
  .strict();

const ensureUniqueResourceHandles = (
  entries: readonly { resourceId: ContentId }[],
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
) => {
  const seen = new Map<string, number>();
  entries.forEach((entry, index) => {
    const existing = seen.get(entry.resourceId);
    if (existing !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...path, index, 'resourceId'],
        message: `Duplicate resource reference "${entry.resourceId}" also declared at index ${existing}.`,
      });
      return;
    }
    seen.set(entry.resourceId, index);
  });
};

const normalizeTags = (tags: readonly string[]): readonly string[] =>
  Object.freeze(
    [...new Set(tags)].sort((left, right) => left.localeCompare(right)),
  );

type PurchaseDefinition = {
  readonly currencyId: ContentId;
  readonly baseCost: number;
  readonly costCurve: z.infer<typeof numericFormulaSchema>;
  readonly maxBulk?: number;
};

type PurchaseInput = {
  readonly currencyId: z.input<typeof contentIdSchema>;
  readonly baseCost: z.input<typeof nonNegativeNumberSchema>;
  readonly costCurve: z.input<typeof numericFormulaSchema>;
  readonly maxBulk?: z.input<typeof positiveIntSchema>;
};

type GeneratorDefinitionInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly icon?: string;
  readonly tags?: readonly string[];
  readonly produces: readonly z.input<typeof productionEntrySchema>[];
  readonly consumes?: readonly z.input<typeof consumptionEntrySchema>[];
  readonly purchase: PurchaseInput;
  readonly maxLevel?: z.input<typeof positiveIntSchema>;
  readonly order?: z.input<typeof finiteNumberSchema>;
  readonly baseUnlock: z.input<typeof conditionSchema>;
  readonly visibilityCondition?: z.input<typeof conditionSchema>;
  readonly automation?: { readonly automationId: z.input<typeof contentIdSchema> };
  readonly effects?: readonly z.input<typeof upgradeEffectSchema>[];
};

type GeneratorDefinition = {
  readonly id: ContentId;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly icon?: string;
  readonly tags: readonly string[];
  readonly produces: readonly z.infer<typeof productionEntrySchema>[];
  readonly consumes: readonly z.infer<typeof consumptionEntrySchema>[];
  readonly purchase: PurchaseDefinition;
  readonly maxLevel?: number;
  readonly order?: number;
  readonly baseUnlock: z.infer<typeof conditionSchema>;
  readonly visibilityCondition?: z.infer<typeof conditionSchema>;
  readonly automation?: { readonly automationId: ContentId };
  readonly effects: readonly z.infer<typeof upgradeEffectSchema>[];
};

const purchaseSchema: z.ZodType<PurchaseDefinition, z.ZodTypeDef, PurchaseInput> = z
  .object({
    currencyId: contentIdSchema,
    baseCost: nonNegativeNumberSchema,
    costCurve: numericFormulaSchema,
    maxBulk: positiveIntSchema.optional(),
  })
  .strict();

const compareOrderable = (left: GeneratorDefinition, right: GeneratorDefinition) => {
  const leftOrder =
    left.order === undefined ? Number.POSITIVE_INFINITY : left.order;
  const rightOrder =
    right.order === undefined ? Number.POSITIVE_INFINITY : right.order;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
};

export const generatorDefinitionSchema: z.ZodType<
  GeneratorDefinition,
  z.ZodTypeDef,
  GeneratorDefinitionInput
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
    produces: z.array(productionEntrySchema).min(1, {
      message: 'Generators must produce at least one resource.',
    }),
    consumes: z.array(consumptionEntrySchema).default([]),
    purchase: purchaseSchema,
    maxLevel: positiveIntSchema.optional(),
    order: finiteNumberSchema.optional(),
    baseUnlock: conditionSchema,
    visibilityCondition: conditionSchema.optional(),
    automation: z
      .object({
        automationId: contentIdSchema,
      })
      .strict()
      .optional(),
    effects: z.array(upgradeEffectSchema).default([]),
  })
  .strict()
  .superRefine((generator, ctx) => {
    ensureUniqueResourceHandles(generator.produces, ctx, ['produces']);
    ensureUniqueResourceHandles(generator.consumes, ctx, ['consumes']);
    const { maxLevel, purchase } = generator;
    if (purchase.maxBulk !== undefined && maxLevel !== undefined) {
      if (purchase.maxBulk > maxLevel) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['purchase', 'maxBulk'],
          message: 'Bulk purchase limit cannot exceed generator max level.',
        });
      }
    }
  })
  .transform((generator) => ({
    ...generator,
    tags: normalizeTags(generator.tags),
    consumes: Object.freeze([...generator.consumes]),
    produces: Object.freeze([...generator.produces]),
    effects: Object.freeze([...generator.effects]),
  }));

export const generatorCollectionSchema = z
  .array(generatorDefinitionSchema)
  .superRefine((generators, ctx) => {
    const seen = new Map<string, number>();
    generators.forEach((generator, index) => {
      const existingIndex = seen.get(generator.id);
      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate generator id "${generator.id}" also defined at index ${existingIndex}.`,
        });
      } else {
        seen.set(generator.id, index);
      }
    });
  })
  .transform((generators) =>
    Object.freeze(
      [...generators].sort((left, right) => compareOrderable(left, right)),
    ),
  );

export type Generator = z.infer<typeof generatorDefinitionSchema>;
