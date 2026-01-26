import type { z } from 'zod';

import type { contentIdSchema, packSlugSchema } from '../base/ids.js';
import type { upgradeEffectSchema, Upgrade } from '../modules/upgrades.js';
import type { BalanceValidationOptions } from '../balance.js';
import type { ValidationCache } from './cache.js';
import type { ContentSchemaWarning } from '../errors.js';
import type { ContentPackDigest } from '../runtime-helpers.js';
import type {
  AchievementDefinition,
} from '../modules/achievements.js';
import type { AutomationDefinition } from '../modules/automations.js';
import type { EntityDefinition } from '../modules/entities.js';
import type { Generator } from '../modules/generators.js';
import type { Metadata } from '../modules/metadata.js';
import type { MetricDefinition } from '../modules/metrics.js';
import type { PrestigeLayerDefinition } from '../modules/prestige.js';
import type { Resource } from '../modules/resources.js';
import type {
  RuntimeEventContribution,
} from '../modules/runtime-events.js';
import type { TransformDefinition } from '../modules/transforms.js';
import type { FontAsset } from '../modules/fonts.js';

type PackId = z.infer<typeof packSlugSchema>;
type ContentId = z.infer<typeof contentIdSchema>;

export type UpgradeEffect = z.infer<typeof upgradeEffectSchema>;

export type NormalizedMetadata = Metadata;
export type NormalizedResource = Resource;
export type NormalizedEntity = EntityDefinition;
export type NormalizedGenerator = Generator;
export type NormalizedUpgrade = Upgrade;
export type NormalizedMetric = MetricDefinition;
export type NormalizedAchievement = AchievementDefinition;
export type NormalizedAutomation = AutomationDefinition;
export type NormalizedTransform = TransformDefinition;
export type NormalizedPrestigeLayer = PrestigeLayerDefinition;
export type NormalizedRuntimeEventContribution = RuntimeEventContribution;
export type NormalizedFontAsset = FontAsset;

export type NormalizedContentPackModules = {
  readonly metadata: NormalizedMetadata;
  readonly fonts: readonly NormalizedFontAsset[];
  readonly resources: readonly NormalizedResource[];
  readonly entities: readonly NormalizedEntity[];
  readonly generators: readonly NormalizedGenerator[];
  readonly upgrades: readonly NormalizedUpgrade[];
  readonly metrics: readonly NormalizedMetric[];
  readonly achievements: readonly NormalizedAchievement[];
  readonly automations: readonly NormalizedAutomation[];
  readonly transforms: readonly NormalizedTransform[];
  readonly prestigeLayers: readonly NormalizedPrestigeLayer[];
  readonly runtimeEvents: readonly NormalizedRuntimeEventContribution[];
};

export interface NormalizedContentPack extends NormalizedContentPackModules {
  readonly lookup: {
    readonly fonts: ReadonlyMap<ContentId, NormalizedFontAsset>;
    readonly resources: ReadonlyMap<ContentId, NormalizedResource>;
    readonly entities: ReadonlyMap<ContentId, NormalizedEntity>;
    readonly generators: ReadonlyMap<ContentId, NormalizedGenerator>;
    readonly upgrades: ReadonlyMap<ContentId, NormalizedUpgrade>;
    readonly metrics: ReadonlyMap<ContentId, NormalizedMetric>;
    readonly achievements: ReadonlyMap<ContentId, NormalizedAchievement>;
    readonly automations: ReadonlyMap<ContentId, NormalizedAutomation>;
    readonly transforms: ReadonlyMap<ContentId, NormalizedTransform>;
    readonly prestigeLayers: ReadonlyMap<ContentId, NormalizedPrestigeLayer>;
    readonly runtimeEvents: ReadonlyMap<ContentId, NormalizedRuntimeEventContribution>;
  };
  readonly serializedLookup: {
    readonly fontById: Readonly<Record<string, NormalizedFontAsset>>;
    readonly resourceById: Readonly<Record<string, NormalizedResource>>;
    readonly entityById: Readonly<Record<string, NormalizedEntity>>;
    readonly generatorById: Readonly<Record<string, NormalizedGenerator>>;
    readonly upgradeById: Readonly<Record<string, NormalizedUpgrade>>;
    readonly metricById: Readonly<Record<string, NormalizedMetric>>;
    readonly achievementById: Readonly<Record<string, NormalizedAchievement>>;
    readonly automationById: Readonly<Record<string, NormalizedAutomation>>;
    readonly transformById: Readonly<Record<string, NormalizedTransform>>;
    readonly prestigeLayerById: Readonly<Record<string, NormalizedPrestigeLayer>>;
    readonly runtimeEventById: Readonly<Record<string, NormalizedRuntimeEventContribution>>;
  };
  readonly digest: ContentPackDigest;
}

export interface NormalizationContext {
  readonly runtimeVersion?: string;
  readonly warningSink?: (warning: ContentSchemaWarning) => void;
}

export type AllowlistEntries = readonly string[] | ReadonlySet<string>;

export interface AllowlistSpecInput {
  readonly required?: AllowlistEntries;
  readonly soft?: AllowlistEntries;
}

export interface NormalizedAllowlistSpec {
  readonly required: ReadonlySet<string>;
  readonly soft: ReadonlySet<string>;
}

export interface ContentSchemaOptions {
  readonly allowlists?: {
    readonly flags?: AllowlistSpecInput;
    readonly scripts?: AllowlistSpecInput;
    readonly systemAutomationTargets?: AllowlistSpecInput;
  };
  readonly runtimeVersion?: string;
  readonly knownPacks?: readonly {
    readonly id: PackId;
    readonly version: string;
    readonly requires?: readonly {
      readonly packId: PackId;
      readonly version?: string;
    }[];
  }[];
  readonly runtimeEventCatalogue?: AllowlistEntries;
  readonly activePackIds?: AllowlistEntries;
  readonly warningSink?: (warning: ContentSchemaWarning) => void;
  readonly balance?: BalanceValidationOptions;
  /**
   * Optional validation cache for memoizing validation results.
   * When provided, validation results are cached by content digest,
   * allowing repeated validations of the same content to return
   * cached results instead of re-running the full validation pipeline.
   *
   * @see createValidationCache
   */
  readonly cache?: ValidationCache;
}

export type KnownPackEntry = NonNullable<ContentSchemaOptions['knownPacks']>[number];

export type KnownPackDependency = {
  readonly packId: PackId;
  readonly version?: string;
};

export interface ContentPackValidationResult {
  readonly pack: NormalizedContentPack;
  readonly warnings: readonly ContentSchemaWarning[];
  readonly balanceWarnings: readonly ContentSchemaWarning[];
  readonly balanceErrors: readonly ContentSchemaWarning[];
}

export interface ContentPackSafeParseSuccess {
  readonly success: true;
  readonly data: ContentPackValidationResult;
}

export interface ContentPackSafeParseFailure {
  readonly success: false;
  readonly error: unknown;
}

export type ContentPackSafeParseResult =
  | ContentPackSafeParseSuccess
  | ContentPackSafeParseFailure;

export interface ContentPackValidator {
  parse(input: unknown): ContentPackValidationResult;
  safeParse(input: unknown): ContentPackSafeParseResult;
}

export interface CrossReferenceContext {
  readonly allowlists: {
    readonly flags?: NormalizedAllowlistSpec;
    readonly scripts?: NormalizedAllowlistSpec;
    readonly systemAutomationTargets?: NormalizedAllowlistSpec;
  };
  readonly warningSink: (warning: ContentSchemaWarning) => void;
  readonly runtimeEventCatalogue: ReadonlySet<string>;
  readonly runtimeVersion?: string;
  readonly activePackIds: ReadonlySet<PackId>;
  readonly knownPacks: ReadonlyMap<PackId, KnownPackEntry>;
}
