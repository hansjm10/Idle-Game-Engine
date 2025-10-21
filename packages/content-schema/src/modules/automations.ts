import { z } from 'zod';

import { conditionSchema } from '../base/conditions.js';
import {
  contentIdSchema,
  scriptIdSchema,
  systemAutomationTargetIdSchema,
} from '../base/ids.js';
import { localizedTextSchema } from '../base/localization.js';
import { numericFormulaSchema, type NumericFormula } from '../base/formulas.js';
import { finiteNumberSchema } from '../base/numbers.js';

type ContentId = z.infer<typeof contentIdSchema>;
type ScriptId = z.infer<typeof scriptIdSchema>;
type SystemAutomationTargetId = z.infer<typeof systemAutomationTargetIdSchema>;

type AutomationTargetType = 'generator' | 'upgrade' | 'system';

type AutomationTrigger =
  | {
      readonly kind: 'interval';
      readonly interval: NumericFormula;
    }
  | {
      readonly kind: 'resourceThreshold';
      readonly resourceId: ContentId;
      readonly comparator: 'gte' | 'gt' | 'lte' | 'lt';
      readonly threshold: NumericFormula;
    }
  | { readonly kind: 'commandQueueEmpty' }
  | { readonly kind: 'event'; readonly eventId: ContentId };

const comparatorSchema = z.enum(['gte', 'gt', 'lte', 'lt'] as const);

const resourceCostSchema = z
  .object({
    resourceId: contentIdSchema,
    rate: numericFormulaSchema,
  })
  .strict();

const triggerSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('interval'),
      interval: numericFormulaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('resourceThreshold'),
      resourceId: contentIdSchema,
      comparator: comparatorSchema.default('gte'),
      threshold: numericFormulaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('commandQueueEmpty'),
    })
    .strict(),
  z
    .object({
      kind: z.literal('event'),
      eventId: contentIdSchema,
    })
    .strict(),
]);

type AutomationTriggerInput = z.input<typeof triggerSchema>;

type AutomationDefinitionInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly description: z.input<typeof localizedTextSchema>;
  readonly targetType: AutomationTargetType;
  readonly targetId?: z.input<typeof contentIdSchema>;
  readonly systemTargetId?: z.input<typeof systemAutomationTargetIdSchema>;
  readonly trigger: AutomationTriggerInput;
  readonly cooldown?: z.input<typeof finiteNumberSchema>;
  readonly resourceCost?: z.input<typeof resourceCostSchema>;
  readonly unlockCondition: z.input<typeof conditionSchema>;
  readonly enabledByDefault?: boolean;
  readonly order?: z.input<typeof finiteNumberSchema>;
  readonly scriptId?: z.input<typeof scriptIdSchema>;
};

type AutomationDefinitionModel = {
  readonly id: ContentId;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly description: z.infer<typeof localizedTextSchema>;
  readonly targetType: AutomationTargetType;
  readonly targetId?: ContentId;
  readonly systemTargetId?: SystemAutomationTargetId;
  readonly trigger: AutomationTrigger;
  readonly cooldown?: number;
  readonly resourceCost?: z.infer<typeof resourceCostSchema>;
  readonly unlockCondition: z.infer<typeof conditionSchema>;
  readonly enabledByDefault: boolean;
  readonly order?: number;
  readonly scriptId?: ScriptId;
};

export const automationDefinitionSchema: z.ZodType<
  AutomationDefinitionModel,
  z.ZodTypeDef,
  AutomationDefinitionInput
> = z
  .object({
    id: contentIdSchema,
    name: localizedTextSchema,
    description: localizedTextSchema,
    targetType: z.enum(['generator', 'upgrade', 'system'] as const),
    targetId: contentIdSchema.optional(),
    systemTargetId: systemAutomationTargetIdSchema.optional(),
    trigger: triggerSchema,
    cooldown: finiteNumberSchema.optional(),
    resourceCost: resourceCostSchema.optional(),
    unlockCondition: conditionSchema,
    enabledByDefault: z.boolean().default(false),
    order: finiteNumberSchema.optional(),
    scriptId: scriptIdSchema.optional(),
  })
  .strict()
  .superRefine((automation, ctx) => {
    if (automation.targetType === 'system') {
      if (!automation.systemTargetId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['systemTargetId'],
          message: 'System automations must declare a systemTargetId.',
        });
      }
      if (automation.targetId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targetId'],
          message: 'System automations must not declare a targetId.',
        });
      }
    } else {
      if (!automation.targetId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['targetId'],
          message: `Automations targeting ${automation.targetType}s must provide a targetId.`,
        });
      }

      if (automation.systemTargetId !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['systemTargetId'],
          message: 'Only system automations may declare a systemTargetId.',
        });
      }
    }
  });

export const automationCollectionSchema = z
  .array(automationDefinitionSchema)
  .superRefine((automations, ctx) => {
    const seen = new Map<string, number>();
    automations.forEach((automation, index) => {
      const existing = seen.get(automation.id);
      if (existing !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate automation id "${automation.id}" also defined at index ${existing}.`,
        });
        return;
      }
      seen.set(automation.id, index);
    });
  })
  .transform((automations) =>
    Object.freeze(
      [...automations].sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );

export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
