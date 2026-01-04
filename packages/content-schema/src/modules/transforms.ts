import { z } from 'zod';

import { conditionSchema, type Condition } from '../base/conditions.js';
import { contentIdSchema } from '../base/ids.js';
import {
  localizedSummarySchema,
  localizedTextSchema,
} from '../base/localization.js';
import { numericFormulaSchema } from '../base/formulas.js';
import {
  finiteNumberSchema,
  percentSchema,
  positiveIntSchema,
} from '../base/numbers.js';

const tagSchema: z.ZodString = z
  .string()
  .trim()
  .min(1, { message: 'Tags must contain at least one character.' })
  .max(24, { message: 'Tags must contain at most 24 characters.' })
  .regex(/^[a-z0-9][a-z0-9/_:-]*$/i, {
    message:
      'Tags must start with an alphanumeric character and may include "-", "_", ":", or "/" thereafter.',
  });

type ContentId = z.infer<typeof contentIdSchema>;

const endpointSchema = z
  .object({
    resourceId: contentIdSchema,
    amount: numericFormulaSchema,
  })
  .strict();

const cooldownSchema: z.ZodType<
  z.infer<typeof numericFormulaSchema>,
  z.ZodTypeDef,
  z.input<typeof finiteNumberSchema> | z.input<typeof numericFormulaSchema>
> = z
  .union([finiteNumberSchema, numericFormulaSchema])
  .transform((value) =>
    typeof value === 'number' ? { kind: 'constant', value } : value,
  );

const missionEntityRequirementSchema = z
  .object({
    entityId: contentIdSchema,
    count: numericFormulaSchema,
    minStats: z.record(contentIdSchema, numericFormulaSchema).optional(),
    preferHighStats: z.array(contentIdSchema).optional(),
    returnOnComplete: z.boolean().default(true),
  })
  .strict();

const missionSuccessRateModifierSchema = z
  .object({
    stat: contentIdSchema,
    weight: numericFormulaSchema,
    entityScope: z.enum(['average', 'sum', 'min', 'max'] as const).default('average'),
  })
  .strict();

const missionSuccessRateSchema = z
  .object({
    baseRate: numericFormulaSchema,
    statModifiers: z.array(missionSuccessRateModifierSchema).optional(),
    usePRD: z.boolean().default(false),
  })
  .strict()
  .superRefine((successRate, ctx) => {
    if (successRate.baseRate.kind !== 'constant') {
      return;
    }
    const result = percentSchema.safeParse(successRate.baseRate.value);
    if (result.success) {
      return;
    }
    const issue = result.error.issues[0];
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['baseRate'],
      message: issue?.message ?? 'Value must be between 0 and 1 inclusive.',
    });
  });

const missionOutcomeSchema = z
  .object({
    outputs: z.array(endpointSchema),
    entityExperience: numericFormulaSchema.optional(),
    entityDamage: numericFormulaSchema.optional(),
    message: localizedTextSchema.optional(),
  })
  .strict();

const missionOutcomesSchema = z
  .object({
    success: missionOutcomeSchema,
    failure: missionOutcomeSchema.optional(),
    critical: missionOutcomeSchema
      .extend({
        chance: numericFormulaSchema,
      })
      .optional(),
  })
  .strict();

type MissionFields = {
  readonly entityRequirements: z.infer<typeof missionEntityRequirementSchema>[];
  readonly successRate?: z.infer<typeof missionSuccessRateSchema>;
  readonly outcomes: z.infer<typeof missionOutcomesSchema>;
};

type MissionFieldsInput = {
  readonly entityRequirements: z.input<typeof missionEntityRequirementSchema>[];
  readonly successRate?: z.input<typeof missionSuccessRateSchema>;
  readonly outcomes: z.input<typeof missionOutcomesSchema>;
};

type TransformSafetyInput = {
  readonly maxRunsPerTick?: z.input<typeof positiveIntSchema>;
  readonly maxOutstandingBatches?: z.input<typeof positiveIntSchema>;
};

type TransformSafety = {
  readonly maxRunsPerTick?: number;
  readonly maxOutstandingBatches?: number;
};

type TransformTriggerInput =
  | { readonly kind: 'manual' }
  | { readonly kind: 'automation'; readonly automationId: z.input<typeof contentIdSchema> }
  | { readonly kind: 'condition'; readonly condition: z.input<typeof conditionSchema> }
  | { readonly kind: 'event'; readonly eventId: z.input<typeof contentIdSchema> };

type TransformTrigger =
  | { readonly kind: 'manual' }
  | { readonly kind: 'automation'; readonly automationId: ContentId }
  | { readonly kind: 'condition'; readonly condition: Condition }
  | { readonly kind: 'event'; readonly eventId: ContentId };

type TransformDefinitionInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly description: z.input<typeof localizedSummarySchema>;
  readonly mode: 'instant' | 'continuous' | 'batch' | 'mission';
  readonly inputs: readonly z.input<typeof endpointSchema>[];
  readonly outputs: readonly z.input<typeof endpointSchema>[];
  readonly duration?: z.input<typeof numericFormulaSchema>;
  readonly cooldown?: z.input<typeof cooldownSchema>;
  readonly trigger: TransformTriggerInput;
  readonly unlockCondition?: z.input<typeof conditionSchema>;
  readonly visibilityCondition?: z.input<typeof conditionSchema>;
  readonly automation?: { readonly automationId: z.input<typeof contentIdSchema> };
  readonly tags?: readonly z.input<typeof tagSchema>[];
  readonly safety?: TransformSafetyInput;
  readonly order?: z.input<typeof finiteNumberSchema>;
} & Partial<MissionFieldsInput>;

type TransformDefinitionModel = {
  readonly id: ContentId;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly description: z.infer<typeof localizedSummarySchema>;
  readonly mode: 'instant' | 'continuous' | 'batch' | 'mission';
  readonly inputs: readonly z.infer<typeof endpointSchema>[];
  readonly outputs: readonly z.infer<typeof endpointSchema>[];
  readonly duration?: z.infer<typeof numericFormulaSchema>;
  readonly cooldown?: z.infer<typeof numericFormulaSchema>;
  readonly trigger: TransformTrigger;
  readonly unlockCondition?: z.infer<typeof conditionSchema>;
  readonly visibilityCondition?: z.infer<typeof conditionSchema>;
  readonly automation?: { readonly automationId: ContentId };
  readonly tags: readonly string[];
  readonly safety?: TransformSafety;
  readonly order?: number;
} & Partial<MissionFields>;

const normalizeTags = (tags: readonly string[]): readonly string[] =>
  Object.freeze(
    [...new Set(tags.map((value) => value.toLowerCase()))].sort((left, right) =>
      left.localeCompare(right),
    ),
  );

export const transformDefinitionSchema: z.ZodType<
  TransformDefinitionModel,
  z.ZodTypeDef,
  TransformDefinitionInput
> = z
  .object({
    id: contentIdSchema,
    name: localizedTextSchema,
    description: localizedSummarySchema,
    mode: z.enum(['instant', 'continuous', 'batch', 'mission'] as const),
    inputs: z.array(endpointSchema).min(1, {
      message: 'Transforms must consume at least one resource.',
    }),
    outputs: z.array(endpointSchema),
    duration: numericFormulaSchema.optional(),
    cooldown: cooldownSchema.optional(),
    entityRequirements: z.array(missionEntityRequirementSchema).optional(),
    successRate: missionSuccessRateSchema.optional(),
    outcomes: missionOutcomesSchema.optional(),
    trigger: z.union([
      z
        .object({
          kind: z.literal('manual'),
        })
        .strict(),
      z
        .object({
          kind: z.literal('automation'),
          automationId: contentIdSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('condition'),
          condition: conditionSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal('event'),
          eventId: contentIdSchema,
        })
        .strict(),
    ]),
    unlockCondition: conditionSchema.optional(),
    visibilityCondition: conditionSchema.optional(),
    automation: z
      .object({
        automationId: contentIdSchema,
      })
      .strict()
      .optional(),
    tags: z.array(tagSchema).default([]),
    safety: z
      .object({
        maxRunsPerTick: positiveIntSchema.optional(),
        maxOutstandingBatches: positiveIntSchema.optional(),
      })
      .strict()
      .optional(),
    order: finiteNumberSchema.optional(),
  })
  .strict()
  .superRefine((transform, ctx) => {
    if (transform.mode !== 'mission' && transform.outputs.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['outputs'],
        message: 'Transforms must produce at least one resource.',
      });
    }

    if (transform.mode === 'batch' && transform.duration === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['duration'],
        message: 'Batch transforms must declare a duration.',
      });
    }

    if (transform.mode === 'mission') {
      if (transform.duration === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['duration'],
          message: 'Mission transforms must declare a duration.',
        });
      }

      if (!transform.entityRequirements || transform.entityRequirements.length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entityRequirements'],
          message: 'Mission transforms must declare entity requirements.',
        });
      }

      if (!transform.outcomes) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['outcomes'],
          message: 'Mission transforms must declare outcomes.',
        });
      }
    }

    if (transform.trigger.kind === 'automation') {
      if (!transform.automation) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['automation'],
          message:
            'Automation-triggered transforms must declare a matching automation reference.',
        });
        return;
      }

      if (transform.automation.automationId !== transform.trigger.automationId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['automation', 'automationId'],
          message: 'Automation id must match the trigger automation id.',
        });
      }
    }
  })
  .transform((transform) => ({
    ...transform,
    tags: normalizeTags(transform.tags),
    inputs: Object.freeze([...transform.inputs]),
    outputs: Object.freeze([...transform.outputs]),
  }));

export const transformCollectionSchema = z
  .array(transformDefinitionSchema)
  .superRefine((transforms, ctx) => {
    const seen = new Map<string, number>();
    transforms.forEach((transform, index) => {
      const existingIndex = seen.get(transform.id);
      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate transform id "${transform.id}" also defined at index ${existingIndex}.`,
        });
        return;
      }
      seen.set(transform.id, index);
    });
  })
  .transform((transforms) =>
    Object.freeze(
      [...transforms].sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );

export type TransformDefinition = z.infer<typeof transformDefinitionSchema>;
