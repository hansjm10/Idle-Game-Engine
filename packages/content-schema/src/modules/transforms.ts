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

const missionStageIdSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]*$/, {
    message: 'Stage ids must start with a letter and contain only lowercase letters, numbers, or underscores.',
  });

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

type MissionDecisionOptionModifiersModel = {
  readonly successRateBonus?: z.infer<typeof numericFormulaSchema>;
  readonly durationMultiplier?: z.infer<typeof numericFormulaSchema>;
  readonly outputMultiplier?: z.infer<typeof numericFormulaSchema>;
};

type MissionDecisionOptionModel = {
  readonly id: z.infer<typeof missionStageIdSchema>;
  readonly label: z.infer<typeof localizedTextSchema>;
  readonly description?: z.infer<typeof localizedSummarySchema>;
  readonly condition?: z.infer<typeof conditionSchema>;
  readonly nextStage: z.infer<typeof missionStageIdSchema> | null;
  readonly modifiers?: MissionDecisionOptionModifiersModel;
};

type MissionDecisionOptionInput = {
  readonly id: z.input<typeof missionStageIdSchema>;
  readonly label: z.input<typeof localizedTextSchema>;
  readonly description?: z.input<typeof localizedSummarySchema>;
  readonly condition?: z.input<typeof conditionSchema>;
  readonly nextStage: z.input<typeof missionStageIdSchema> | null;
  readonly modifiers?: {
    readonly successRateBonus?: z.input<typeof numericFormulaSchema>;
    readonly durationMultiplier?: z.input<typeof numericFormulaSchema>;
    readonly outputMultiplier?: z.input<typeof numericFormulaSchema>;
  };
};

const missionDecisionOptionSchema: z.ZodType<
  MissionDecisionOptionModel,
  z.ZodTypeDef,
  MissionDecisionOptionInput
> = z
  .object({
    id: missionStageIdSchema,
    label: localizedTextSchema,
    description: localizedSummarySchema.optional(),
    condition: conditionSchema.optional(),
    nextStage: missionStageIdSchema.nullable(),
    modifiers: z
      .object({
        successRateBonus: numericFormulaSchema.optional(),
        durationMultiplier: numericFormulaSchema.optional(),
        outputMultiplier: numericFormulaSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

type MissionDecisionModel = {
  readonly prompt: z.infer<typeof localizedTextSchema>;
  readonly timeout?: z.infer<typeof numericFormulaSchema>;
  readonly defaultOption: z.infer<typeof missionStageIdSchema>;
  readonly options: MissionDecisionOptionModel[];
};

type MissionDecisionInput = {
  readonly prompt: z.input<typeof localizedTextSchema>;
  readonly timeout?: z.input<typeof numericFormulaSchema>;
  readonly defaultOption: z.input<typeof missionStageIdSchema>;
  readonly options: MissionDecisionOptionInput[];
};

const missionDecisionSchema: z.ZodType<
  MissionDecisionModel,
  z.ZodTypeDef,
  MissionDecisionInput
> = z
  .object({
    prompt: localizedTextSchema,
    timeout: numericFormulaSchema.optional(),
    defaultOption: missionStageIdSchema,
    options: z.array(missionDecisionOptionSchema).min(2).max(4),
  })
  .strict()
  .superRefine((decision, ctx) => {
    const ids = new Map<string, number>();
    decision.options.forEach((option, index) => {
      const existing = ids.get(option.id);
      if (existing !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['options', index, 'id'],
          message: `Duplicate decision option id "${option.id}" also defined at index ${existing}.`,
        });
        return;
      }
      ids.set(option.id, index);
    });

    if (!ids.has(decision.defaultOption)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['defaultOption'],
        message: `Decision defaultOption "${decision.defaultOption}" must reference an option id defined in options.`,
      });
    }
  });

const missionCheckpointSchema = z
  .object({
    outputs: z.array(endpointSchema),
    entityExperience: numericFormulaSchema.optional(),
    message: localizedTextSchema.optional(),
  })
  .strict();

const missionStageOutcomeOverridesSchema = z
  .object({
    success: missionOutcomeSchema.optional(),
    failure: missionOutcomeSchema.optional(),
  })
  .strict();

type MissionStageModel = {
  readonly id: string;
  readonly name?: z.infer<typeof localizedTextSchema>;
  readonly duration: z.infer<typeof numericFormulaSchema>;
  readonly checkpoint?: z.infer<typeof missionCheckpointSchema>;
  readonly decision?: z.infer<typeof missionDecisionSchema>;
  readonly stageSuccessRate?: z.infer<typeof numericFormulaSchema>;
  readonly stageOutcomes?: z.infer<typeof missionStageOutcomeOverridesSchema>;
  readonly nextStage?: string | null;
};

type MissionStageInput = {
  readonly id: z.input<typeof missionStageIdSchema>;
  readonly name?: z.input<typeof localizedTextSchema>;
  readonly duration: z.input<typeof numericFormulaSchema>;
  readonly checkpoint?: z.input<typeof missionCheckpointSchema>;
  readonly decision?: z.input<typeof missionDecisionSchema>;
  readonly stageSuccessRate?: z.input<typeof numericFormulaSchema>;
  readonly stageOutcomes?: z.input<typeof missionStageOutcomeOverridesSchema>;
  readonly nextStage?: z.input<typeof missionStageIdSchema> | null;
};

const missionStageSchema: z.ZodType<MissionStageModel, z.ZodTypeDef, MissionStageInput> = z
  .object({
    id: missionStageIdSchema,
    name: localizedTextSchema.optional(),
    duration: numericFormulaSchema,
    checkpoint: missionCheckpointSchema.optional(),
    decision: missionDecisionSchema.optional(),
    stageSuccessRate: numericFormulaSchema.optional(),
    stageOutcomes: missionStageOutcomeOverridesSchema.optional(),
    nextStage: missionStageIdSchema.nullable().optional(),
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
  readonly stages?: readonly z.infer<typeof missionStageSchema>[];
  readonly initialStage?: z.infer<typeof missionStageIdSchema>;
};

type MissionFieldsInput = {
  readonly entityRequirements: z.input<typeof missionEntityRequirementSchema>[];
  readonly successRate?: z.input<typeof missionSuccessRateSchema>;
  readonly outcomes: z.input<typeof missionOutcomesSchema>;
  readonly stages?: readonly z.input<typeof missionStageSchema>[];
  readonly initialStage?: z.input<typeof missionStageIdSchema>;
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

const reportTransformIssue = (
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void => {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [...path],
    message,
  });
};

const validateNonMissionOutputs = (
  transform: TransformDefinitionModel,
  ctx: z.RefinementCtx,
): void => {
  if (transform.mode !== 'mission' && transform.outputs.length === 0) {
    reportTransformIssue(
      ctx,
      ['outputs'],
      'Transforms must produce at least one resource.',
    );
  }
};

const validateBatchTransform = (
  transform: TransformDefinitionModel,
  ctx: z.RefinementCtx,
): void => {
  if (transform.mode === 'batch' && transform.duration === undefined) {
    reportTransformIssue(
      ctx,
      ['duration'],
      'Batch transforms must declare a duration.',
    );
  }
};

const validateMissionTransform = (
  transform: TransformDefinitionModel,
  ctx: z.RefinementCtx,
): void => {
  const hasStages = transform.stages !== undefined && transform.stages.length > 0;

  if (!hasStages && transform.duration === undefined) {
    reportTransformIssue(
      ctx,
      ['duration'],
      'Mission transforms must declare a duration.',
    );
  }

  if (!transform.entityRequirements || transform.entityRequirements.length === 0) {
    reportTransformIssue(
      ctx,
      ['entityRequirements'],
      'Mission transforms must declare entity requirements.',
    );
  }

  if (!transform.outcomes) {
    reportTransformIssue(
      ctx,
      ['outcomes'],
      'Mission transforms must declare outcomes.',
    );
  }

  if (!hasStages) {
    return;
  }

  const stages = transform.stages ?? [];
  const stageIndexById = new Map<string, number>();
  stages.forEach((stage, index) => {
    const existing = stageIndexById.get(stage.id);
    if (existing !== undefined) {
      reportTransformIssue(
        ctx,
        ['stages', index, 'id'],
        `Duplicate stage id "${stage.id}" also defined at index ${existing}.`,
      );
      return;
    }
    stageIndexById.set(stage.id, index);
  });

  const initialStage = transform.initialStage ?? stages[0]?.id;
  if (initialStage && !stageIndexById.has(initialStage)) {
    reportTransformIssue(
      ctx,
      ['initialStage'],
      `Initial stage "${initialStage}" must reference a valid stage id.`,
    );
  }

  const stageById = new Map<string, (typeof stages)[number]>();
  stages.forEach((stage) => {
    stageById.set(stage.id, stage);
  });

  stages.forEach((stage, stageIndex) => {
    if (stage.decision) {
      stage.decision.options.forEach((option, optionIndex) => {
        const next = option.nextStage;
        if (next !== null && !stageIndexById.has(next)) {
          reportTransformIssue(
            ctx,
            ['stages', stageIndex, 'decision', 'options', optionIndex, 'nextStage'],
            `Decision option nextStage "${next}" must reference a valid stage id or null.`,
          );
        }
      });
      return;
    }

    const next = stage.nextStage;
    if (next !== undefined && next !== null && !stageIndexById.has(next)) {
      reportTransformIssue(
        ctx,
        ['stages', stageIndex, 'nextStage'],
        `Stage nextStage "${next}" must reference a valid stage id or null.`,
      );
    }
  });

  const getOutgoingStageIds = (stageId: string): readonly string[] => {
    const stage = stageById.get(stageId);
    if (!stage) {
      return [];
    }

    if (stage.decision) {
      const nextStages = stage.decision.options
        .map((option) => option.nextStage)
        .filter((nextStage): nextStage is string => nextStage !== null);
      return Object.freeze([...new Set(nextStages)]);
    }

    const nextStage = stage.nextStage;
    return nextStage ? Object.freeze([nextStage]) : [];
  };

  const canTerminateFrom = (stageId: string, seen: Set<string>): boolean => {
    if (seen.has(stageId)) {
      return false;
    }
    seen.add(stageId);

    const stage = stageById.get(stageId);
    if (!stage) {
      return false;
    }

    if (stage.decision) {
      if (stage.decision.options.some((option) => option.nextStage === null)) {
        return true;
      }
    } else if (stage.nextStage === undefined || stage.nextStage === null) {
      return true;
    }

    return getOutgoingStageIds(stageId).some((next) =>
      canTerminateFrom(next, new Set(seen)),
    );
  };

  const rootStage = initialStage ?? stages[0]?.id;
  if (rootStage) {
    const visitState = new Map<string, 'visiting' | 'visited'>();
    const detectCycle = (stageId: string): boolean => {
      const state = visitState.get(stageId);
      if (state === 'visiting') {
        return true;
      }
      if (state === 'visited') {
        return false;
      }

      visitState.set(stageId, 'visiting');
      for (const next of getOutgoingStageIds(stageId)) {
        if (detectCycle(next)) {
          return true;
        }
      }
      visitState.set(stageId, 'visited');
      return false;
    };

    if (detectCycle(rootStage)) {
      reportTransformIssue(
        ctx,
        ['stages'],
        'Multi-stage missions may not contain circular stage references.',
      );
    } else if (!canTerminateFrom(rootStage, new Set())) {
      reportTransformIssue(
        ctx,
        ['stages'],
        'Multi-stage missions must include at least one path that terminates (nextStage: null).',
      );
    }
  }
};

const validateAutomationTrigger = (
  transform: TransformDefinitionModel,
  triggerAutomationId: ContentId,
  ctx: z.RefinementCtx,
): void => {
  if (!transform.automation) {
    reportTransformIssue(
      ctx,
      ['automation'],
      'Automation-triggered transforms must declare a matching automation reference.',
    );
    return;
  }

  if (transform.automation.automationId !== triggerAutomationId) {
    reportTransformIssue(
      ctx,
      ['automation', 'automationId'],
      'Automation id must match the trigger automation id.',
    );
  }
};

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
    stages: z.array(missionStageSchema).min(1).optional(),
    initialStage: missionStageIdSchema.optional(),
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
    validateNonMissionOutputs(transform, ctx);
    validateBatchTransform(transform, ctx);
    if (transform.mode === 'mission') {
      validateMissionTransform(transform, ctx);
    }

    if (transform.trigger.kind === 'automation') {
      validateAutomationTrigger(transform, transform.trigger.automationId, ctx);
    }
  })
  .transform((transform) => ({
    ...transform,
    tags: normalizeTags(transform.tags),
    inputs: Object.freeze([...transform.inputs]),
    outputs: Object.freeze([...transform.outputs]),
    ...(transform.stages
      ? {
          stages: Object.freeze([...transform.stages]),
          initialStage: transform.initialStage ?? transform.stages[0]?.id,
        }
      : {}),
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
