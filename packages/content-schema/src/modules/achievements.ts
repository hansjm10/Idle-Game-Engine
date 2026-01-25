import { z } from 'zod';

import { conditionSchema } from '../base/conditions.js';
import { contentIdSchema, flagIdSchema, scriptIdSchema } from '../base/ids.js';
import {
  localizedSummarySchema,
  localizedTextSchema,
} from '../base/localization.js';
import { numericFormulaSchema, type NumericFormula } from '../base/formulas.js';
import { finiteNumberSchema, positiveIntSchema } from '../base/numbers.js';

type AchievementCategory =
  | 'progression'
  | 'prestige'
  | 'automation'
  | 'collection';

type AchievementTier = 'bronze' | 'silver' | 'gold' | 'platinum';

type ProgressMode = 'oneShot' | 'incremental' | 'repeatable';

const ICON_MAX_LENGTH = 128;
const TAG_MAX_LENGTH = 24;
const ONE_FORMULA: NumericFormula = Object.freeze({
  kind: 'constant',
  value: 1,
} as const);

const tagSchema = z
  .string()
  .trim()
  .min(1, { message: 'Tags must contain at least one character.' })
  .max(TAG_MAX_LENGTH, {
    message: `Tags must contain at most ${TAG_MAX_LENGTH} characters.`,
  })
  .regex(/^[a-z0-9][a-z0-9/_:-]*$/i, {
    message:
      'Tags must start with an alphanumeric character and may include "-", "_", ":", or "/" thereafter.',
  })
  .transform((value) => value.toLowerCase());

const comparatorSchema = z
  .enum(['gte', 'gt', 'lte', 'lt'] as const)
  .default('gte');

const trackSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('resource'),
      resourceId: contentIdSchema,
      threshold: numericFormulaSchema,
      comparator: comparatorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('generator-level'),
      generatorId: contentIdSchema,
      level: numericFormulaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('generator-count'),
      threshold: numericFormulaSchema,
      comparator: comparatorSchema,
      generatorIds: z.array(contentIdSchema).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('upgrade-owned'),
      upgradeId: contentIdSchema,
      purchases: numericFormulaSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('flag'),
      flagId: flagIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('script'),
      scriptId: scriptIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('custom-metric'),
      metricId: contentIdSchema,
      threshold: numericFormulaSchema,
    })
    .strict(),
]);

type AchievementTrack = z.infer<typeof trackSchema>;

const repeatableProgressSchema = z
  .object({
    resetWindow: numericFormulaSchema,
    maxRepeats: positiveIntSchema.optional(),
    rewardScaling: numericFormulaSchema.default(ONE_FORMULA),
  })
  .strict();

type RepeatableProgress = z.infer<typeof repeatableProgressSchema>;

const progressSchema = z
  .object({
    target: numericFormulaSchema.optional(),
    mode: z.enum(['oneShot', 'incremental', 'repeatable'] as const).default('oneShot'),
    repeatable: repeatableProgressSchema.optional(),
  })
  .strict()
  .default({ mode: 'oneShot' });

type AchievementProgress = z.infer<typeof progressSchema>;

const achievementRewardSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('grantResource'),
      resourceId: contentIdSchema,
      amount: numericFormulaSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('grantUpgrade'),
      upgradeId: contentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('emitEvent'),
      eventId: contentIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('unlockAutomation'),
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
]);

type AchievementReward = z.infer<typeof achievementRewardSchema>;

type AchievementDefinitionInput = {
  readonly id: z.input<typeof contentIdSchema>;
  readonly name: z.input<typeof localizedTextSchema>;
  readonly description: z.input<typeof localizedSummarySchema>;
  readonly category: AchievementCategory;
  readonly tier: AchievementTier;
  readonly icon?: string;
  readonly tags?: readonly z.input<typeof tagSchema>[];
  readonly track: z.input<typeof trackSchema>;
  readonly progress?: z.input<typeof progressSchema>;
  readonly reward?: z.input<typeof achievementRewardSchema>;
  readonly unlockCondition?: z.input<typeof conditionSchema>;
  readonly visibilityCondition?: z.input<typeof conditionSchema>;
  readonly onUnlockEvents?: readonly z.input<typeof contentIdSchema>[];
  readonly displayOrder?: z.input<typeof finiteNumberSchema>;
};

type ContentId = z.infer<typeof contentIdSchema>;

type AchievementDefinitionModel = {
  readonly id: ContentId;
  readonly name: z.infer<typeof localizedTextSchema>;
  readonly description: z.infer<typeof localizedSummarySchema>;
  readonly category: AchievementCategory;
  readonly tier: AchievementTier;
  readonly icon?: string;
  readonly tags: readonly string[];
  readonly track: AchievementTrack;
  readonly progress: {
    readonly target: NumericFormula;
    readonly mode: ProgressMode;
    readonly repeatable?: RepeatableProgress;
  };
  readonly reward?: AchievementReward;
  readonly unlockCondition?: z.infer<typeof conditionSchema>;
  readonly visibilityCondition?: z.infer<typeof conditionSchema>;
  readonly onUnlockEvents: readonly ContentId[];
  readonly displayOrder?: number;
};

const normalizeTags = (tags: readonly string[]): readonly string[] =>
  Object.freeze(
    [...new Set(tags)].sort((left, right) => left.localeCompare(right)),
  );

const normalizeUnlockEvents = (
  events: readonly ContentId[],
): readonly ContentId[] =>
  Object.freeze(
    [...new Set(events)].sort((left, right) => left.localeCompare(right)),
  );

const compareOrderable = (
  left: AchievementDefinitionModel,
  right: AchievementDefinitionModel,
) => {
  const leftOrder =
    left.displayOrder === undefined
      ? Number.POSITIVE_INFINITY
      : left.displayOrder;
  const rightOrder =
    right.displayOrder === undefined
      ? Number.POSITIVE_INFINITY
      : right.displayOrder;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.id.localeCompare(right.id);
};

const resolveProgressTarget = ({
  progress,
  track,
}: {
  readonly progress: AchievementProgress;
  readonly track: AchievementTrack;
}): NumericFormula => {
  if (progress.target) {
    return progress.target;
  }

  switch (track.kind) {
    case 'resource':
      return track.threshold;
    case 'generator-level':
      return track.level;
    case 'generator-count':
      return track.threshold;
    case 'upgrade-owned':
      return track.purchases ?? ONE_FORMULA;
    case 'custom-metric':
      return track.threshold;
    case 'flag':
    case 'script':
      return ONE_FORMULA;
    default:
      return ONE_FORMULA;
  }
};

const ensureRepeatableConsistency = (
  progress: AchievementProgress,
  ctx: z.RefinementCtx,
) => {
  if (progress.mode === 'repeatable') {
    if (!progress.repeatable) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['progress', 'repeatable'],
        message:
          'Repeatable achievements must define repeatable progress configuration.',
      });
      return;
    }
  } else if (progress.repeatable) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['progress', 'repeatable'],
      message:
        'Repeatable configuration is only valid when progress mode is "repeatable".',
    });
  }
};

const ensurePositiveTarget = (
  target: NumericFormula,
  ctx: z.RefinementCtx,
) => {
  if (target.kind !== 'constant') {
    return;
  }

  if (target.value <= 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['progress', 'target'],
      message: 'Achievement progress targets must be greater than 0.',
    });
  }
};

export const achievementDefinitionSchema: z.ZodType<
  AchievementDefinitionModel,
  z.ZodTypeDef,
  AchievementDefinitionInput
> = z
  .object({
    id: contentIdSchema,
    name: localizedTextSchema,
    description: localizedSummarySchema,
    category: z.enum(
      ['progression', 'prestige', 'automation', 'collection'] as const,
    ),
    tier: z.enum(['bronze', 'silver', 'gold', 'platinum'] as const),
    icon: z
      .string()
      .trim()
      .min(1, { message: 'Icon paths must contain at least one character.' })
      .max(ICON_MAX_LENGTH, {
        message: `Icon paths must contain at most ${ICON_MAX_LENGTH} characters.`,
      })
      .optional(),
    tags: z.array(tagSchema).default([]),
    track: trackSchema,
    progress: progressSchema,
    reward: achievementRewardSchema.optional(),
    unlockCondition: conditionSchema.optional(),
    visibilityCondition: conditionSchema.optional(),
    onUnlockEvents: z.array(contentIdSchema).default([]),
    displayOrder: finiteNumberSchema.optional(),
  })
  .strict()
  .superRefine((achievement, ctx) => {
    ensureRepeatableConsistency(achievement.progress, ctx);
    const target = resolveProgressTarget({
      progress: achievement.progress,
      track: achievement.track,
    });
    ensurePositiveTarget(target, ctx);
  })
  .transform((achievement) => {
    const target = resolveProgressTarget({
      progress: achievement.progress,
      track: achievement.track,
    });

    let repeatable: RepeatableProgress | undefined;
    if (achievement.progress.mode === 'repeatable') {
      const repeatableInput = achievement.progress.repeatable!;
      repeatable = {
        ...repeatableInput,
        rewardScaling: repeatableInput.rewardScaling ?? ONE_FORMULA,
      };
    }

    return {
      ...achievement,
      tags: normalizeTags(achievement.tags),
      progress: {
        target,
        mode: achievement.progress.mode,
        repeatable,
      },
      onUnlockEvents: normalizeUnlockEvents(achievement.onUnlockEvents),
    };
  });

export const achievementCollectionSchema = z
  .array(achievementDefinitionSchema)
  .superRefine((achievements, ctx) => {
    const seen = new Map<string, number>();
    achievements.forEach((achievement, index) => {
      const existingIndex = seen.get(achievement.id);
      if (existingIndex !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'id'],
          message: `Duplicate achievement id "${achievement.id}" also defined at index ${existingIndex}.`,
        });
        return;
      }
      seen.set(achievement.id, index);
    });
  })
  .transform((achievements) =>
    Object.freeze(
      [...achievements].sort((left, right) => compareOrderable(left, right)),
    ),
  );

export type AchievementDefinition = z.infer<typeof achievementDefinitionSchema>;
