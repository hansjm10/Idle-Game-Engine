import { z } from 'zod';

import { conditionSchema } from '../base/conditions.js';
import { contentIdSchema } from '../base/ids.js';
import { localizedSummarySchema, localizedTextSchema } from '../base/localization.js';
import { numericFormulaSchema } from '../base/formulas.js';
import {
  finiteNumberSchema,
  integerSchema,
  positiveIntSchema,
} from '../base/numbers.js';

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

const nonNegativeIntSchema = integerSchema.refine((value) => value >= 0, {
  message: 'Value must be greater than or equal to 0.',
});

type ContentId = z.infer<typeof contentIdSchema>;
type NumericFormula = z.infer<typeof numericFormulaSchema>;

type EntityStatInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly baseValue: z.input<typeof numericFormulaSchema>;
  readonly minValue?: z.input<typeof numericFormulaSchema>;
  readonly maxValue?: z.input<typeof numericFormulaSchema>;
};

type EntityStat = {
  readonly id: ContentId;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly baseValue: NumericFormula;
  readonly minValue?: NumericFormula;
  readonly maxValue?: NumericFormula;
};

const entityStatSchema: z.ZodType<EntityStat, z.ZodTypeDef, EntityStatInput> = z
  .object({
    id: contentIdSchema,
    name: localizedTextSchema,
    baseValue: numericFormulaSchema,
    minValue: numericFormulaSchema.optional(),
    maxValue: numericFormulaSchema.optional(),
  })
  .strict();

const entityProgressionSchema = z
  .object({
    experienceResource: contentIdSchema.optional(),
    levelFormula: numericFormulaSchema,
    maxLevel: positiveIntSchema.optional(),
    statGrowth: z.record(contentIdSchema, numericFormulaSchema).default({}),
  })
  .strict()
  .transform((progression) => ({
    ...progression,
    statGrowth: Object.freeze({ ...progression.statGrowth }),
  }));

type EntityProgressionInput = z.input<typeof entityProgressionSchema>;
type EntityProgression = z.infer<typeof entityProgressionSchema>;

type EntityDefinitionInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly description: z.input<typeof localizedSummarySchema>;
  readonly stats: readonly EntityStatInput[];
  readonly maxCount?: z.input<typeof numericFormulaSchema>;
  readonly startCount?: z.input<typeof nonNegativeIntSchema>;
  readonly trackInstances?: boolean;
  readonly progression?: EntityProgressionInput;
  readonly unlockCondition?: z.input<typeof conditionSchema>;
  readonly visibilityCondition?: z.input<typeof conditionSchema>;
  readonly unlocked?: boolean;
  readonly visible?: boolean;
  readonly tags?: readonly string[];
  readonly order?: z.input<typeof finiteNumberSchema>;
};

type EntityDefinitionShape = {
  readonly id: ContentId;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly description: z.infer<typeof localizedSummarySchema>;
  readonly stats: readonly EntityStat[];
  readonly maxCount?: NumericFormula;
  readonly startCount: number;
  readonly trackInstances: boolean;
  readonly progression?: EntityProgression;
  readonly unlockCondition?: z.infer<typeof conditionSchema>;
  readonly visibilityCondition?: z.infer<typeof conditionSchema>;
  readonly unlocked: boolean;
  readonly visible: boolean;
  readonly tags: readonly string[];
  readonly order?: number;
};

const normalizeTags = (tags: readonly string[]): readonly string[] =>
  Object.freeze(
    [...new Set(tags)].sort((left, right) => left.localeCompare(right)),
  );

const compareOrderable = (
  left: EntityDefinitionShape,
  right: EntityDefinitionShape,
) => {
  const leftOrder =
    left.order === undefined ? Number.POSITIVE_INFINITY : left.order;
  const rightOrder =
    right.order === undefined ? Number.POSITIVE_INFINITY : right.order;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
};

export const entityDefinitionSchema: z.ZodType<
  EntityDefinitionShape,
  z.ZodTypeDef,
  EntityDefinitionInput
> = z
  .object({
    id: contentIdSchema,
    name: localizedTextSchema,
    description: localizedSummarySchema,
    stats: z.array(entityStatSchema).min(1, {
      message: 'Entities must declare at least one stat.',
    }),
    maxCount: numericFormulaSchema.optional(),
    startCount: nonNegativeIntSchema.default(0),
    trackInstances: z.boolean().default(false),
    progression: entityProgressionSchema.optional(),
    unlockCondition: conditionSchema.optional(),
    visibilityCondition: conditionSchema.optional(),
    unlocked: z.boolean().default(false),
    visible: z.boolean().default(true),
    tags: z.array(tagSchema).default([]),
    order: finiteNumberSchema.optional(),
  })
  .strict()
  .superRefine((entity, ctx) => {
    const seenStats = new Map<string, number>();
    entity.stats.forEach((stat, index) => {
      const existingIndex = seenStats.get(stat.id);
      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['stats', index, 'id'],
          message: `Duplicate stat id "${stat.id}" also declared at index ${existingIndex}.`,
        });
        return;
      }
      seenStats.set(stat.id, index);
    });

    if (entity.progression) {
      const statIds = new Set(entity.stats.map((stat) => stat.id));
      Object.keys(entity.progression.statGrowth).forEach((statId) => {
        if (!statIds.has(statId as ContentId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['progression', 'statGrowth', statId],
            message: `Stat growth references unknown stat "${statId}".`,
          });
        }
      });
    }
  })
  .transform((entity) => ({
    ...entity,
    tags: normalizeTags(entity.tags),
    stats: Object.freeze([...entity.stats]),
    progression: entity.progression
      ? {
          ...entity.progression,
          statGrowth: Object.freeze({ ...entity.progression.statGrowth }),
        }
      : entity.progression,
  }));

export const entityCollectionSchema = z
  .array(entityDefinitionSchema)
  .superRefine((entities, ctx) => {
    const seen = new Map<string, number>();
    entities.forEach((entity, index) => {
      const existingIndex = seen.get(entity.id);
      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate entity id "${entity.id}" also defined at index ${existingIndex}.`,
        });
      } else {
        seen.set(entity.id, index);
      }
    });
  })
  .transform((entities) =>
    Object.freeze(
      [...entities].sort((left, right) => compareOrderable(left, right)),
    ),
  );

export type EntityDefinition = z.infer<typeof entityDefinitionSchema>;
