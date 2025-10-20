import { z } from 'zod';

import { conditionSchema } from '../base/conditions.js';
import { contentIdSchema } from '../base/ids.js';
import { localizedTextSchema } from '../base/localization.js';
import { numericFormulaSchema } from '../base/formulas.js';
import { finiteNumberSchema, positiveIntSchema } from '../base/numbers.js';
import { upgradeEffectSchema } from './upgrades.js';

const guildSpecificEffectSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('modifyGuildStorage'),
      storageId: contentIdSchema,
      operation: z.enum(['add', 'multiply', 'set'] as const),
      value: numericFormulaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unlockGuildAutomation'),
      automationId: contentIdSchema,
    })
    .strict(),
]);

const guildEffectSchema = z.union([upgradeEffectSchema, guildSpecificEffectSchema]);

const guildCostSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('currency'),
      resourceId: contentIdSchema,
      amount: numericFormulaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('metric'),
      metricId: contentIdSchema,
      amount: numericFormulaSchema,
    })
    .strict(),
]);

type GuildPerkDefinitionInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly description: z.input<typeof localizedTextSchema>;
  readonly category: 'buff' | 'utility' | 'cosmetic';
  readonly maxRank: z.input<typeof positiveIntSchema>;
  readonly effects: readonly z.input<typeof guildEffectSchema>[];
  readonly cost: z.input<typeof guildCostSchema>;
  readonly unlockCondition?: z.input<typeof conditionSchema>;
  readonly order?: z.input<typeof finiteNumberSchema>;
  readonly visibilityCondition?: z.input<typeof conditionSchema>;
};

type GuildPerkDefinitionModel = {
  readonly id: string;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly description: z.infer<typeof localizedTextSchema>;
  readonly category: 'buff' | 'utility' | 'cosmetic';
  readonly maxRank: number;
  readonly effects: readonly z.infer<typeof guildEffectSchema>[];
  readonly cost: z.infer<typeof guildCostSchema>;
  readonly unlockCondition?: z.infer<typeof conditionSchema>;
  readonly order?: number;
  readonly visibilityCondition?: z.infer<typeof conditionSchema>;
};

export const guildPerkDefinitionSchema: z.ZodType<
  GuildPerkDefinitionModel,
  z.ZodTypeDef,
  GuildPerkDefinitionInput
> = z
  .object({
    id: contentIdSchema,
    name: localizedTextSchema,
    description: localizedTextSchema,
    category: z.enum(['buff', 'utility', 'cosmetic'] as const),
    maxRank: positiveIntSchema,
    effects: z.array(guildEffectSchema).min(1, {
      message: 'Guild perks must define at least one effect.',
    }),
    cost: guildCostSchema,
    unlockCondition: conditionSchema.optional(),
    order: finiteNumberSchema.optional(),
    visibilityCondition: conditionSchema.optional(),
  })
  .strict()
  .transform((perk) => ({
    ...perk,
    effects: Object.freeze([...perk.effects]),
  }));

export const guildPerkCollectionSchema = z
  .array(guildPerkDefinitionSchema)
  .superRefine((perks, ctx) => {
    const seen = new Map<string, number>();
    perks.forEach((perk, index) => {
      const existing = seen.get(perk.id);
      if (existing !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate guild perk id "${perk.id}" also defined at index ${existing}.`,
        });
        return;
      }
      seen.set(perk.id, index);
    });
  })
  .transform((perks) =>
    Object.freeze(
      [...perks].sort((left, right) => left.id.localeCompare(right.id)),
    ),
  );

export type GuildPerkDefinition = z.infer<typeof guildPerkDefinitionSchema>;
