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

const DIRTY_TOLERANCE_MIN = 1e-9;
const DIRTY_TOLERANCE_MAX = 5e-1;

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

type ResourceCategory = 'primary' | 'prestige' | 'automation' | 'currency' | 'misc';

type ResourceDefinitionInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly category: ResourceCategory;
  readonly tier: z.input<typeof positiveIntSchema>;
  readonly icon?: string;
  readonly startAmount?: z.input<typeof nonNegativeNumberSchema>;
  readonly capacity?: number | null;
  readonly visible?: boolean;
  readonly unlocked?: boolean;
  readonly dirtyTolerance?: number;
  readonly order?: z.input<typeof finiteNumberSchema>;
  readonly unlockCondition?: z.input<typeof conditionSchema>;
  readonly visibilityCondition?: z.input<typeof conditionSchema>;
  readonly prestige?: {
    readonly layerId: z.input<typeof contentIdSchema>;
    readonly resetRetention?: z.input<typeof numericFormulaSchema>;
  };
  readonly tags?: readonly string[];
};

type ResourceId = z.infer<typeof contentIdSchema>;

type ResourceDefinition = {
  readonly id: ResourceId;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly category: ResourceCategory;
  readonly tier: number;
  readonly icon?: string;
  readonly startAmount: number;
  readonly capacity: number | null;
  readonly visible: boolean;
  readonly unlocked: boolean;
  readonly dirtyTolerance?: number;
  readonly order?: number;
  readonly unlockCondition?: z.infer<typeof conditionSchema>;
  readonly visibilityCondition?: z.infer<typeof conditionSchema>;
  readonly prestige?: {
    readonly layerId: ResourceId;
    readonly resetRetention?: z.infer<typeof numericFormulaSchema>;
  };
  readonly tags: readonly string[];
};

const normalizeTags = (tags: readonly string[]): readonly string[] =>
  Object.freeze(
    [...new Set(tags)].sort((left, right) => left.localeCompare(right)),
  );

const compareOrderable = (left: ResourceDefinition, right: ResourceDefinition) => {
  const leftOrder =
    left.order === undefined ? Number.POSITIVE_INFINITY : left.order;
  const rightOrder =
    right.order === undefined ? Number.POSITIVE_INFINITY : right.order;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
};

export const resourceDefinitionSchema: z.ZodType<
  ResourceDefinition,
  z.ZodTypeDef,
  ResourceDefinitionInput
> = z
  .object({
    id: contentIdSchema,
    name: localizedTextSchema,
    category: z.enum(['primary', 'prestige', 'automation', 'currency', 'misc'] as const),
    tier: positiveIntSchema,
    icon: z
      .string()
      .trim()
      .min(1, { message: 'Icon paths must contain at least one character.' })
      .max(128, { message: 'Icon paths must contain at most 128 characters.' })
      .optional(),
    startAmount: nonNegativeNumberSchema.default(0),
    capacity: z
      .union([
        finiteNumberSchema.refine((value) => value >= 0, {
          message: 'Capacity must be greater than or equal to 0.',
        }),
        z.literal(null),
      ])
      .default(null),
    visible: z.boolean().default(true),
    unlocked: z.boolean().default(false),
    dirtyTolerance: finiteNumberSchema
      .refine((value) => value >= DIRTY_TOLERANCE_MIN, {
        message: `Dirty tolerance must be at least ${DIRTY_TOLERANCE_MIN}.`,
      })
      .refine((value) => value <= DIRTY_TOLERANCE_MAX, {
        message: `Dirty tolerance must be at most ${DIRTY_TOLERANCE_MAX}.`,
      })
      .optional(),
    order: finiteNumberSchema.optional(),
    unlockCondition: conditionSchema.optional(),
    visibilityCondition: conditionSchema.optional(),
    prestige: z
      .object({
        layerId: contentIdSchema,
        resetRetention: numericFormulaSchema.optional(),
      })
      .strict()
      .optional(),
    tags: z.array(tagSchema).default([]),
  })
  .strict()
  .superRefine((resource, ctx) => {
    if (resource.capacity !== null && resource.capacity < resource.startAmount) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['capacity'],
        message: 'Initial resource amount cannot exceed capacity.',
      });
    }
  })
  .transform((resource) => ({
    ...resource,
    tags: normalizeTags(resource.tags),
  }));

export const resourceCollectionSchema = z
  .array(resourceDefinitionSchema)
  .superRefine((resources, ctx) => {
    const seen = new Map<string, number>();
    resources.forEach((resource, index) => {
      const existingIndex = seen.get(resource.id);
      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate resource id "${resource.id}" also defined at index ${existingIndex}.`,
        });
      } else {
        seen.set(resource.id, index);
      }
    });
  })
  .transform((resources) =>
    Object.freeze(
      [...resources].sort((left, right) => compareOrderable(left, right)),
    ),
  );

export type Resource = z.infer<typeof resourceDefinitionSchema>;
