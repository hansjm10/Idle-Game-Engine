import { z } from 'zod';

import { conditionSchema } from '../base/conditions.js';
import { contentIdSchema } from '../base/ids.js';
import { localizedTextSchema } from '../base/localization.js';
import { numericFormulaSchema } from '../base/formulas.js';
import { finiteNumberSchema } from '../base/numbers.js';

const ICON_MAX_LENGTH = 128;

const retentionEntrySchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('resource'),
      resourceId: contentIdSchema,
      amount: numericFormulaSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('upgrade'),
      upgradeId: contentIdSchema,
    })
    .strict(),
]);

const rewardSchema = z
  .object({
    resourceId: contentIdSchema,
    baseReward: numericFormulaSchema,
    multiplierCurve: numericFormulaSchema.optional(),
  })
  .strict();

type PrestigeLayerInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly icon?: string;
  readonly summary: z.input<typeof localizedTextSchema>;
  readonly resetTargets: readonly z.input<typeof contentIdSchema>[];
  readonly unlockCondition: z.input<typeof conditionSchema>;
  readonly reward: z.input<typeof rewardSchema>;
  readonly retention?: readonly z.input<typeof retentionEntrySchema>[];
  readonly automation?: { readonly automationId: z.input<typeof contentIdSchema> };
  readonly order?: z.input<typeof finiteNumberSchema>;
};

type PrestigeLayerModel = {
  readonly id: string;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly icon?: string;
  readonly summary: z.infer<typeof localizedTextSchema>;
  readonly resetTargets: readonly string[];
  readonly unlockCondition: z.infer<typeof conditionSchema>;
  readonly reward: z.infer<typeof rewardSchema>;
  readonly retention: readonly z.infer<typeof retentionEntrySchema>[];
  readonly automation?: { readonly automationId: string };
  readonly order?: number;
};

const normalizeResetTargets = (
  targets: readonly string[],
): readonly string[] =>
  Object.freeze(
    [...new Set(targets)].sort((left, right) => left.localeCompare(right)),
  );

export const prestigeLayerSchema: z.ZodType<
  PrestigeLayerModel,
  z.ZodTypeDef,
  PrestigeLayerInput
> = z
  .object({
    id: contentIdSchema,
    name: localizedTextSchema,
    icon: z
      .string()
      .trim()
      .min(1, { message: 'Icon paths must contain at least one character.' })
      .max(ICON_MAX_LENGTH, {
        message: `Icon paths must contain at most ${ICON_MAX_LENGTH} characters.`,
      })
      .optional(),
    summary: localizedTextSchema,
    resetTargets: z.array(contentIdSchema).min(1, {
      message: 'Prestige layers must reset at least one resource.',
    }),
    unlockCondition: conditionSchema,
    reward: rewardSchema,
    retention: z.array(retentionEntrySchema).default([]),
    automation: z
      .object({
        automationId: contentIdSchema,
      })
      .strict()
      .optional(),
    order: finiteNumberSchema.optional(),
  })
  .strict()
  .transform((layer) => ({
    ...layer,
    resetTargets: normalizeResetTargets(layer.resetTargets),
    retention: Object.freeze([...layer.retention]),
  }));

export const prestigeCollectionSchema = z
  .array(prestigeLayerSchema)
  .superRefine((layers, ctx) => {
    const seen = new Map<string, number>();
    layers.forEach((layer, index) => {
      const existingIndex = seen.get(layer.id);
      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate prestige layer id "${layer.id}" also defined at index ${existingIndex}.`,
        });
        return;
      }
      seen.set(layer.id, index);
    });
  })
  .transform((layers) =>
    Object.freeze(
      [...layers].sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );

export type PrestigeLayerDefinition = z.infer<typeof prestigeLayerSchema>;
