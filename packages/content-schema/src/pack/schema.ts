import { z } from 'zod';

import type {
  AchievementDefinition,
} from '../modules/achievements.js';
import type {
  AutomationDefinition,
} from '../modules/automations.js';
import type { Generator } from '../modules/generators.js';
import type { Metadata } from '../modules/metadata.js';
import type { MetricDefinition } from '../modules/metrics.js';
import type {
  PrestigeLayerDefinition,
} from '../modules/prestige.js';
import type { Resource } from '../modules/resources.js';
import type {
  RuntimeEventContribution,
} from '../modules/runtime-events.js';
import type {
  TransformDefinition,
} from '../modules/transforms.js';
import type { Upgrade } from '../modules/upgrades.js';
import {
  achievementCollectionSchema,
} from '../modules/achievements.js';
import {
  automationCollectionSchema,
} from '../modules/automations.js';
import { generatorCollectionSchema } from '../modules/generators.js';
import { metadataSchema } from '../modules/metadata.js';
import { metricCollectionSchema } from '../modules/metrics.js';
import {
  prestigeCollectionSchema,
} from '../modules/prestige.js';
import { resourceCollectionSchema } from '../modules/resources.js';
import {
  runtimeEventContributionCollectionSchema,
} from '../modules/runtime-events.js';
import {
  transformCollectionSchema,
} from '../modules/transforms.js';
import { upgradeCollectionSchema } from '../modules/upgrades.js';

export interface ParsedContentPack {
  readonly metadata: Metadata;
  readonly resources: readonly Resource[];
  readonly generators: readonly Generator[];
  readonly upgrades: readonly Upgrade[];
  readonly metrics: readonly MetricDefinition[];
  readonly achievements: readonly AchievementDefinition[];
  readonly automations: readonly AutomationDefinition[];
  readonly transforms: readonly TransformDefinition[];
  readonly prestigeLayers: readonly PrestigeLayerDefinition[];
  readonly runtimeEvents: readonly RuntimeEventContribution[];
}

const baseContentPackSchema: z.ZodType<ParsedContentPack, z.ZodTypeDef, unknown> = z
  .object({
    metadata: metadataSchema,
    resources: resourceCollectionSchema.default([]),
    generators: generatorCollectionSchema.default([]),
    upgrades: upgradeCollectionSchema.default([]),
    metrics: metricCollectionSchema.default([]),
    achievements: achievementCollectionSchema.default([]),
    automations: automationCollectionSchema.default([]),
    transforms: transformCollectionSchema.default([]),
    prestigeLayers: prestigeCollectionSchema.default([]),
    runtimeEvents: runtimeEventContributionCollectionSchema.default([]),
  })
  .strict();

export const contentPackSchema = baseContentPackSchema;
