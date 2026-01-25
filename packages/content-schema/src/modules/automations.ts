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

/**
 * Target type for automation commands.
 *
 * - `generator`: Toggle a generator's enabled state. Uses `targetId` and optionally
 *   `targetEnabled` (default true). Generates a `TOGGLE_GENERATOR` command.
 *
 * - `upgrade`: Purchase an upgrade. Uses `targetId`. Generates a `PURCHASE_UPGRADE` command.
 *
 * - `purchaseGenerator`: Buy generator levels. Uses `targetId` and optionally
 *   `targetCount` (default 1). Generates a `PURCHASE_GENERATOR` command.
 *
 * - `collectResource`: Add resources directly. Uses `targetId` and optionally
 *   `targetAmount` (default 1). Generates a `COLLECT_RESOURCE` command.
 *
 * - `system`: Trigger system commands. Uses `systemTargetId` (not `targetId`).
 *   Valid system targets: `system:prestige`, `system:save`, `system:reset`.
 */
type AutomationTargetType =
  | 'generator'
  | 'upgrade'
  | 'purchaseGenerator'
  | 'collectResource'
  | 'system';

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

const cooldownSchema: z.ZodType<
  NumericFormula,
  z.ZodTypeDef,
  z.input<typeof finiteNumberSchema> | z.input<typeof numericFormulaSchema>
> = z
  .union([finiteNumberSchema, numericFormulaSchema])
  .transform((value) =>
    typeof value === 'number' ? { kind: 'constant', value } : value,
  );

type AutomationTriggerInput = z.input<typeof triggerSchema>;

type AutomationDefinitionInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly description: z.input<typeof localizedTextSchema>;
  readonly targetType: AutomationTargetType;
  readonly targetId?: z.input<typeof contentIdSchema>;
  readonly systemTargetId?: z.input<typeof systemAutomationTargetIdSchema>;
  readonly targetEnabled?: boolean;
  readonly targetCount?: z.input<typeof numericFormulaSchema>;
  readonly targetAmount?: z.input<typeof numericFormulaSchema>;
  readonly trigger: AutomationTriggerInput;
  readonly cooldown?: z.input<typeof cooldownSchema>;
  readonly resourceCost?: z.input<typeof resourceCostSchema>;
  readonly unlockCondition: z.input<typeof conditionSchema>;
  readonly visibilityCondition?: z.input<typeof conditionSchema>;
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
  readonly targetEnabled?: boolean;
  readonly targetCount?: NumericFormula;
  readonly targetAmount?: NumericFormula;
  readonly trigger: AutomationTrigger;
  readonly cooldown?: NumericFormula;
  readonly resourceCost?: z.infer<typeof resourceCostSchema>;
  readonly unlockCondition: z.infer<typeof conditionSchema>;
  readonly visibilityCondition?: z.infer<typeof conditionSchema>;
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
    targetType: z
      .enum(
        ['generator', 'upgrade', 'purchaseGenerator', 'collectResource', 'system'] as const,
      )
      .describe(
        'Target type: generator (toggle), upgrade (purchase), purchaseGenerator (buy levels), collectResource (add resources), system (system commands)',
      ),
    targetId: contentIdSchema.optional(),
    systemTargetId: systemAutomationTargetIdSchema.optional(),
    targetEnabled: z.boolean().optional(),
    targetCount: numericFormulaSchema.optional(),
    targetAmount: numericFormulaSchema.optional(),
    trigger: triggerSchema,
    cooldown: cooldownSchema.optional(),
    resourceCost: resourceCostSchema.optional(),
    unlockCondition: conditionSchema,
    visibilityCondition: conditionSchema.optional(),
    enabledByDefault: z.boolean().default(false),
    order: finiteNumberSchema.optional(),
    scriptId: scriptIdSchema.optional(),
  })
  .strict()
  .superRefine((automation, ctx) => {
    if (automation.targetType === 'system') {
      validateSystemAutomationTarget(automation, ctx);
      return;
    }

    validateNonSystemAutomationTarget(automation, ctx);
  });

function addAutomationIssue(
  ctx: z.RefinementCtx,
  path: readonly (string | number)[],
  message: string,
): void {
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: [...path],
    message,
  });
}

function validateSystemAutomationTarget(
  automation: AutomationDefinitionModel,
  ctx: z.RefinementCtx,
): void {
  if (!automation.systemTargetId) {
    addAutomationIssue(ctx, ['systemTargetId'], 'System automations must declare a systemTargetId.');
  }
  if (automation.targetId !== undefined) {
    addAutomationIssue(ctx, ['targetId'], 'System automations must not declare a targetId.');
  }
  if (automation.targetEnabled !== undefined) {
    addAutomationIssue(ctx, ['targetEnabled'], 'System automations must not declare targetEnabled.');
  }
  if (automation.targetCount !== undefined) {
    addAutomationIssue(ctx, ['targetCount'], 'System automations must not declare targetCount.');
  }
  if (automation.targetAmount !== undefined) {
    addAutomationIssue(ctx, ['targetAmount'], 'System automations must not declare targetAmount.');
  }
}

function validateNonSystemAutomationTarget(
  automation: AutomationDefinitionModel,
  ctx: z.RefinementCtx,
): void {
  if (!automation.targetId) {
    addAutomationIssue(
      ctx,
      ['targetId'],
      `Automations targeting "${automation.targetType}" must provide a targetId.`,
    );
  }

  if (automation.systemTargetId !== undefined) {
    addAutomationIssue(ctx, ['systemTargetId'], 'Only system automations may declare a systemTargetId.');
  }

  if (automation.targetType !== 'generator' && automation.targetEnabled !== undefined) {
    addAutomationIssue(ctx, ['targetEnabled'], 'Only generator automations may declare targetEnabled.');
  }

  if (
    automation.targetType !== 'purchaseGenerator' &&
    automation.targetCount !== undefined
  ) {
    addAutomationIssue(ctx, ['targetCount'], 'Only purchaseGenerator automations may declare targetCount.');
  }

  if (automation.targetType !== 'collectResource' && automation.targetAmount !== undefined) {
    addAutomationIssue(ctx, ['targetAmount'], 'Only collectResource automations may declare targetAmount.');
  }
}

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
