import { z } from 'zod';

import type { Condition } from './base/conditions.js';
import {
  contentIdSchema,
  flagIdSchema,
  packSlugSchema,
  scriptIdSchema,
  systemAutomationTargetIdSchema,
} from './base/ids.js';
import type { ExpressionNode, NumericFormula } from './base/formulas.js';
import {
  normalizeLocalizedText,
  type LocalizedSummary,
  type LocalizedText,
} from './base/localization.js';
import {
  achievementCollectionSchema,
  type AchievementDefinition,
} from './modules/achievements.js';
import {
  automationCollectionSchema,
  type AutomationDefinition,
} from './modules/automations.js';
import {
  generatorCollectionSchema,
  type Generator,
} from './modules/generators.js';
import {
  guildPerkCollectionSchema,
  type GuildPerkDefinition,
} from './modules/guild-perks.js';
import {
  metadataSchema,
  type Metadata,
} from './modules/metadata.js';
import {
  metricCollectionSchema,
  type MetricDefinition,
} from './modules/metrics.js';
import {
  prestigeCollectionSchema,
  type PrestigeLayerDefinition,
} from './modules/prestige.js';
import { resourceCollectionSchema, type Resource } from './modules/resources.js';
import {
  runtimeEventContributionCollectionSchema,
  type RuntimeEventContribution,
} from './modules/runtime-events.js';
import {
  transformCollectionSchema,
  type TransformDefinition,
} from './modules/transforms.js';
import {
  upgradeCollectionSchema,
  upgradeEffectSchema,
  type Upgrade,
} from './modules/upgrades.js';
import { validateContentPackBalance, type BalanceValidationOptions } from './balance.js';
import { BalanceValidationError } from './errors.js';
import type { ContentSchemaWarning } from './errors.js';
import { resolveFeatureViolations, type FeatureGateMap } from './runtime-compat.js';
import {
  createContentPackDigest,
  freezeArray,
  freezeMap,
  freezeObject,
  freezeRecord,
  type ContentPackDigest,
} from './runtime-helpers.js';

type PackId = z.infer<typeof packSlugSchema>;
type ContentId = z.infer<typeof contentIdSchema>;
type UpgradeDefinition = Upgrade;
type UpgradeEffect = z.infer<typeof upgradeEffectSchema>;

export type NormalizedMetadata = Metadata;
export type NormalizedResource = Resource;
export type NormalizedGenerator = Generator;
export type NormalizedUpgrade = UpgradeDefinition;
export type NormalizedMetric = MetricDefinition;
export type NormalizedAchievement = AchievementDefinition;
export type NormalizedAutomation = AutomationDefinition;
export type NormalizedTransform = TransformDefinition;
export type NormalizedPrestigeLayer = PrestigeLayerDefinition;
export type NormalizedGuildPerk = GuildPerkDefinition;
export type NormalizedRuntimeEventContribution = RuntimeEventContribution;

type AllowlistEntries = readonly string[] | ReadonlySet<string>;

interface AllowlistSpecInput {
  readonly required?: AllowlistEntries;
  readonly soft?: AllowlistEntries;
}

interface NormalizedAllowlistSpec {
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
}

type KnownPackEntry = NonNullable<ContentSchemaOptions['knownPacks']>[number];
type KnownPackDependency = {
  readonly packId: PackId;
  readonly version?: string;
};

export interface ContentPackValidationResult {
  readonly pack: NormalizedContentPack;
  readonly warnings: readonly ContentSchemaWarning[];
  readonly balanceWarnings: readonly ContentSchemaWarning[];
  readonly balanceErrors: readonly ContentSchemaWarning[];
}

interface ParsedContentPack {
  readonly metadata: Metadata;
  readonly resources: readonly Resource[];
  readonly generators: readonly Generator[];
  readonly upgrades: readonly UpgradeDefinition[];
  readonly metrics: readonly MetricDefinition[];
  readonly achievements: readonly AchievementDefinition[];
  readonly automations: readonly AutomationDefinition[];
  readonly transforms: readonly TransformDefinition[];
  readonly prestigeLayers: readonly PrestigeLayerDefinition[];
  readonly guildPerks: readonly GuildPerkDefinition[];
  readonly runtimeEvents: readonly RuntimeEventContribution[];
}

type NormalizedContentPackModules = {
  readonly metadata: NormalizedMetadata;
  readonly resources: readonly NormalizedResource[];
  readonly generators: readonly NormalizedGenerator[];
  readonly upgrades: readonly NormalizedUpgrade[];
  readonly metrics: readonly NormalizedMetric[];
  readonly achievements: readonly NormalizedAchievement[];
  readonly automations: readonly NormalizedAutomation[];
  readonly transforms: readonly NormalizedTransform[];
  readonly prestigeLayers: readonly NormalizedPrestigeLayer[];
  readonly guildPerks: readonly NormalizedGuildPerk[];
  readonly runtimeEvents: readonly NormalizedRuntimeEventContribution[];
};

export interface NormalizedContentPack extends NormalizedContentPackModules {
  readonly lookup: {
    readonly resources: ReadonlyMap<ContentId, NormalizedResource>;
    readonly generators: ReadonlyMap<ContentId, NormalizedGenerator>;
    readonly upgrades: ReadonlyMap<ContentId, NormalizedUpgrade>;
    readonly metrics: ReadonlyMap<ContentId, NormalizedMetric>;
    readonly achievements: ReadonlyMap<ContentId, NormalizedAchievement>;
    readonly automations: ReadonlyMap<ContentId, NormalizedAutomation>;
    readonly transforms: ReadonlyMap<ContentId, NormalizedTransform>;
    readonly prestigeLayers: ReadonlyMap<ContentId, NormalizedPrestigeLayer>;
    readonly guildPerks: ReadonlyMap<ContentId, NormalizedGuildPerk>;
    readonly runtimeEvents: ReadonlyMap<ContentId, NormalizedRuntimeEventContribution>;
  };
  readonly serializedLookup: {
    readonly resourceById: Readonly<Record<string, NormalizedResource>>;
    readonly generatorById: Readonly<Record<string, NormalizedGenerator>>;
    readonly upgradeById: Readonly<Record<string, NormalizedUpgrade>>;
    readonly metricById: Readonly<Record<string, NormalizedMetric>>;
    readonly achievementById: Readonly<Record<string, NormalizedAchievement>>;
    readonly automationById: Readonly<Record<string, NormalizedAutomation>>;
    readonly transformById: Readonly<Record<string, NormalizedTransform>>;
    readonly prestigeLayerById: Readonly<Record<string, NormalizedPrestigeLayer>>;
    readonly guildPerkById: Readonly<Record<string, NormalizedGuildPerk>>;
    readonly runtimeEventById: Readonly<Record<string, NormalizedRuntimeEventContribution>>;
  };
  readonly digest: ContentPackDigest;
}

export interface NormalizationContext {
  readonly runtimeVersion?: string;
  readonly warningSink?: (warning: ContentSchemaWarning) => void;
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
    guildPerks: guildPerkCollectionSchema.default([]),
    runtimeEvents: runtimeEventContributionCollectionSchema.default([]),
  })
  .strict();

export const contentPackSchema = baseContentPackSchema;

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

const toArray = (entries: AllowlistEntries | undefined): readonly string[] =>
  entries ? Array.from(entries) : [];

const runtimeEventIdSchema = contentIdSchema;

const toMutablePath = (
  path: readonly (string | number)[],
): (string | number)[] => [...path];

const normalizeAllowlistEntries = (
  entries: AllowlistEntries | undefined,
  severity: 'error' | 'warning',
  schema: z.ZodType<string>,
  warningSink: (warning: ContentSchemaWarning) => void,
  pathPrefix: readonly (string | number)[],
): ReadonlySet<string> => {
  const normalized = new Set<string>();
  const issues: z.ZodIssue[] = [];
  toArray(entries).forEach((value, index) => {
    const result = schema.safeParse(value);
    if (!result.success) {
      const entryPath = [...pathPrefix, index] as const;
      if (severity === 'error') {
        result.error.issues.forEach((issue) => {
          issues.push({
            ...issue,
            path: toMutablePath([...entryPath, ...issue.path] as const),
          });
        });
        return;
      }
      warningSink({
        code:
          severity === 'warning'
            ? 'allowlist.invalidSoftEntry'
            : 'allowlist.invalidEntry',
        message: `Allowlist entry "${value}" failed validation.`,
        path: toMutablePath(entryPath),
        severity,
        issues: result.error.issues,
      });
      return;
    }
    normalized.add(result.data);
  });

  if (severity === 'error' && issues.length > 0) {
    throw new z.ZodError(issues);
  }

  return normalized;
};

const normalizeAllowlistSpec = (
  spec: AllowlistSpecInput | undefined,
  schema: z.ZodType<string>,
  warningSink: (warning: ContentSchemaWarning) => void,
  pathPrefix: readonly (string | number)[],
): NormalizedAllowlistSpec => ({
  required: normalizeAllowlistEntries(
    spec?.required,
    'error',
    schema,
    warningSink,
    [...pathPrefix, 'required'],
  ),
  soft: normalizeAllowlistEntries(
    spec?.soft,
    'warning',
    schema,
    warningSink,
    [...pathPrefix, 'soft'],
  ),
});

const normalizeRuntimeEventCatalogue = (
  entries: AllowlistEntries | undefined,
): ReadonlySet<string> =>
  new Set(
    toArray(entries).map((eventType) => runtimeEventIdSchema.parse(eventType)),
  );

const normalizeActivePackIds = (
  entries: AllowlistEntries | undefined,
): ReadonlySet<PackId> =>
  new Set(toArray(entries).map((packId) => packSlugSchema.parse(packId)));

type LocalizedValue = LocalizedText | LocalizedSummary;

const createLocalizedValueNormalizer = (
  metadata: NormalizedMetadata,
  warningSink: NormalizationContext['warningSink'],
) => {
  const baseOptions = {
    defaultLocale: metadata.defaultLocale,
    supportedLocales: metadata.supportedLocales,
    warningSink,
  };

  const normalize = <Localized extends LocalizedValue>(
    localized: Localized,
    path: readonly (string | number)[],
  ): Localized =>
    normalizeLocalizedText(localized, {
      ...baseOptions,
      path,
    });

  const normalizeOptional = <Localized extends LocalizedValue>(
    localized: Localized | undefined,
    path: readonly (string | number)[],
  ): Localized | undefined =>
    localized
      ? normalizeLocalizedText(localized, {
          ...baseOptions,
          path,
        })
      : undefined;

  return { normalize, normalizeOptional };
};

const normalizeContentPack = (
  pack: ParsedContentPack,
  context: NormalizationContext = {},
): NormalizedContentPack => {
  const metadataBaseOptions = {
    defaultLocale: pack.metadata.defaultLocale,
    supportedLocales: pack.metadata.supportedLocales,
    warningSink: context.warningSink,
  };

  const normalizedMetadata = freezeObject({
    ...pack.metadata,
    title: normalizeLocalizedText(pack.metadata.title, {
      ...metadataBaseOptions,
      path: ['metadata', 'title'],
    }),
    summary: pack.metadata.summary
      ? normalizeLocalizedText(pack.metadata.summary, {
          ...metadataBaseOptions,
          path: ['metadata', 'summary'],
        })
      : pack.metadata.summary,
  } as NormalizedMetadata);

  const { normalize, normalizeOptional } = createLocalizedValueNormalizer(
    normalizedMetadata,
    context.warningSink,
  );

  const normalizedResources = freezeArray(
    pack.resources.map(
      (resource, index) =>
        freezeObject({
          ...resource,
          name: normalize(resource.name, ['resources', index, 'name']),
        }) as NormalizedResource,
    ),
  );

  const normalizedGenerators = freezeArray(
    pack.generators.map(
      (generator, index) =>
        freezeObject({
          ...generator,
          name: normalize(generator.name, ['generators', index, 'name']),
        }) as NormalizedGenerator,
    ),
  );

  const normalizedUpgrades = freezeArray(
    pack.upgrades.map(
      (upgrade, index) =>
        freezeObject({
          ...upgrade,
          name: normalize(upgrade.name, ['upgrades', index, 'name']),
        }) as NormalizedUpgrade,
    ),
  );

  const normalizedMetrics = freezeArray(
    pack.metrics.map(
      (metric, index) =>
        freezeObject({
          ...metric,
          name: normalize(metric.name, ['metrics', index, 'name']),
          description: normalizeOptional(
            metric.description,
            ['metrics', index, 'description'],
          ),
        }) as NormalizedMetric,
    ),
  );

  const normalizedAchievements = freezeArray(
    pack.achievements.map(
      (achievement, index) =>
        freezeObject({
          ...achievement,
          name: normalize(achievement.name, ['achievements', index, 'name']),
          description: normalize(
            achievement.description,
            ['achievements', index, 'description'],
          ),
        }) as NormalizedAchievement,
    ),
  );

  const normalizedAutomations = freezeArray(
    pack.automations.map(
      (automation, index) =>
        freezeObject({
          ...automation,
          name: normalize(automation.name, ['automations', index, 'name']),
          description: normalize(
            automation.description,
            ['automations', index, 'description'],
          ),
        }) as NormalizedAutomation,
    ),
  );

  const normalizedTransforms = freezeArray(
    pack.transforms.map(
      (transform, index) =>
        freezeObject({
          ...transform,
          name: normalize(transform.name, ['transforms', index, 'name']),
          description: normalize(
            transform.description,
            ['transforms', index, 'description'],
          ),
        }) as NormalizedTransform,
    ),
  );

  const normalizedPrestigeLayers = freezeArray(
    pack.prestigeLayers.map(
      (layer, index) =>
        freezeObject({
          ...layer,
          name: normalize(layer.name, ['prestigeLayers', index, 'name']),
          summary: normalize(
            layer.summary,
            ['prestigeLayers', index, 'summary'],
          ),
        }) as NormalizedPrestigeLayer,
    ),
  );

  const normalizedGuildPerks = freezeArray(
    pack.guildPerks.map(
      (perk, index) =>
        freezeObject({
          ...perk,
          name: normalize(perk.name, ['guildPerks', index, 'name']),
          description: normalize(
            perk.description,
            ['guildPerks', index, 'description'],
          ),
        }) as NormalizedGuildPerk,
    ),
  );

  const normalizedRuntimeEvents = freezeArray(
    pack.runtimeEvents.map((event) => freezeObject({ ...event }) as NormalizedRuntimeEventContribution),
  );

  const normalizedModules: NormalizedContentPackModules = {
    metadata: normalizedMetadata,
    resources: normalizedResources,
    generators: normalizedGenerators,
    upgrades: normalizedUpgrades,
    metrics: normalizedMetrics,
    achievements: normalizedAchievements,
    automations: normalizedAutomations,
    transforms: normalizedTransforms,
    prestigeLayers: normalizedPrestigeLayers,
    guildPerks: normalizedGuildPerks,
    runtimeEvents: normalizedRuntimeEvents,
  };

  const lookup = freezeObject({
    resources: freezeMap(normalizedModules.resources),
    generators: freezeMap(normalizedModules.generators),
    upgrades: freezeMap(normalizedModules.upgrades),
    metrics: freezeMap(normalizedModules.metrics),
    achievements: freezeMap(normalizedModules.achievements),
    automations: freezeMap(normalizedModules.automations),
    transforms: freezeMap(normalizedModules.transforms),
    prestigeLayers: freezeMap(normalizedModules.prestigeLayers),
    guildPerks: freezeMap(normalizedModules.guildPerks),
    runtimeEvents: freezeMap(normalizedModules.runtimeEvents),
  });

  const serializedLookup = freezeObject({
    resourceById: freezeRecord(normalizedModules.resources),
    generatorById: freezeRecord(normalizedModules.generators),
    upgradeById: freezeRecord(normalizedModules.upgrades),
    metricById: freezeRecord(normalizedModules.metrics),
    achievementById: freezeRecord(normalizedModules.achievements),
    automationById: freezeRecord(normalizedModules.automations),
    transformById: freezeRecord(normalizedModules.transforms),
    prestigeLayerById: freezeRecord(normalizedModules.prestigeLayers),
    guildPerkById: freezeRecord(normalizedModules.guildPerks),
    runtimeEventById: freezeRecord(normalizedModules.runtimeEvents),
  });

  const digest = createContentPackDigest(normalizedModules);

  return freezeObject({
    ...normalizedModules,
    lookup,
    serializedLookup,
    digest,
  });
};

const buildFeatureGateMap = (pack: ParsedContentPack): FeatureGateMap => ({
  automations: pack.automations.length > 0,
  transforms: pack.transforms.length > 0,
  runtimeEvents: pack.runtimeEvents.length > 0,
  prestigeLayers: pack.prestigeLayers.length > 0,
  guildPerks: pack.guildPerks.length > 0,
});

const assertAllowlisted = (
  spec: NormalizedAllowlistSpec | undefined,
  id: string,
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
  warningSink: (warning: ContentSchemaWarning) => void,
  warningCode: string,
  message: string,
) => {
  if (!spec) {
    return;
  }

  if (spec.required.has(id) || spec.soft.has(id)) {
    return;
  }

  if (spec.soft.size > 0 && !spec.required.size) {
    warningSink({
      code: warningCode,
      message,
      path: toMutablePath(path),
      severity: 'warning',
    });
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: toMutablePath(path),
    message,
  });
};

const collectFormulaEntityReferences = (
  formula: NumericFormula,
  collector: (reference: { type: string; id: string }) => void,
) => {
  const visitFormula = (node: NumericFormula) => {
    switch (node.kind) {
      case 'constant':
      case 'linear':
      case 'exponential':
      case 'polynomial':
        return;
      case 'piecewise':
        node.pieces.forEach((piece) => visitFormula(piece.formula));
        return;
      case 'expression':
        visitExpression(node.expression);
        return;
      default:
        return;
    }
  };

  const visitExpression = (expression: unknown): void => {
    if (!expression || typeof expression !== 'object') {
      return;
    }
    const expr = expression as ExpressionNode;
    switch (expr.kind) {
      case 'literal':
        return;
      case 'ref':
        if (expr.target?.type && expr.target.type !== 'variable') {
          collector({
            type: expr.target.type,
            id: expr.target.id,
          });
        }
        return;
      case 'binary':
        visitExpression(expr.left);
        visitExpression(expr.right);
        return;
      case 'unary':
        visitExpression(expr.operand);
        return;
      case 'call':
        expr.args?.forEach((arg) => visitExpression(arg));
        return;
      default:
        return;
    }
  };

  visitFormula(formula);
};

const getIndexMap = <Value extends { readonly id: string }>(
  values: readonly Value[],
): Map<string, { readonly index: number; readonly value: Value }> => {
  const indexMap = new Map<string, { readonly index: number; readonly value: Value }>();
  values.forEach((value, index) => {
    indexMap.set(value.id, { index, value });
  });
  return indexMap;
};

interface CrossReferenceContext {
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

const validateCrossReferences = (
  pack: ParsedContentPack,
  ctx: z.RefinementCtx,
  context: CrossReferenceContext,
) => {
  const resourceIndex = getIndexMap(pack.resources);
  const generatorIndex = getIndexMap(pack.generators);
  const upgradeIndex = getIndexMap(pack.upgrades);
  const metricIndex = getIndexMap(pack.metrics);
  const achievementIndex = getIndexMap(pack.achievements);
  const automationIndex = getIndexMap(pack.automations);
  const transformIndex = getIndexMap(pack.transforms);
  const prestigeIndex = getIndexMap(pack.prestigeLayers);
  const guildPerkIndex = getIndexMap(pack.guildPerks);
  const knownRuntimeEvents = new Set<string>(context.runtimeEventCatalogue);
  pack.runtimeEvents.forEach((event) => {
    knownRuntimeEvents.add(event.id);
  });

  const warn = context.warningSink;

  const ensureRuntimeEventKnown = (
    id: string,
    path: readonly (string | number)[],
    severity: 'error' | 'warning',
  ) => {
    if (knownRuntimeEvents.has(id)) {
      return;
    }
    if (severity === 'warning') {
      warn({
        code: 'runtimeEvent.unknown',
        message: `Runtime event "${id}" is not present in the known catalogue.`,
        path: toMutablePath(path),
        severity,
      });
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: toMutablePath(path),
      message: `Runtime event "${id}" must exist in the known event catalogue.`,
    });
  };

  const ensureContentReference = (
    map: Map<string, { index: number }>,
    id: string,
    path: readonly (string | number)[],
    message: string,
  ) => {
    if (map.has(id)) {
      return;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: toMutablePath(path),
      message,
    });
  };

  pack.resources.forEach((resource, index) => {
    if (resource.unlockCondition) {
      validateConditionNode(
        resource.unlockCondition,
        ['resources', index, 'unlockCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }

    if (resource.visibilityCondition) {
      validateConditionNode(
        resource.visibilityCondition,
        ['resources', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }

    if (resource.prestige) {
      ensureContentReference(
        prestigeIndex,
        resource.prestige.layerId,
        ['resources', index, 'prestige', 'layerId'],
        `Resource "${resource.id}" references unknown prestige layer "${resource.prestige.layerId}".`,
      );

      if (resource.prestige.resetRetention) {
        collectFormulaEntityReferences(resource.prestige.resetRetention, (reference) => {
          ensureFormulaReference(reference, ['resources', index, 'prestige', 'resetRetention'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
        });
      }
    }
  });

  pack.runtimeEvents.forEach((event, index) => {
    if (context.runtimeEventCatalogue.has(event.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(['runtimeEvents', index, 'id'] as const),
        message: `Runtime event "${event.id}" collides with an existing catalogue entry.`,
      });
    }

    event.emits.forEach((emitter, emitterIndex) => {
      switch (emitter.source) {
        case 'achievement':
          ensureContentReference(
            achievementIndex,
            emitter.id,
            toMutablePath(['runtimeEvents', index, 'emits', emitterIndex, 'id'] as const),
            `Runtime event emitter references unknown achievement "${emitter.id}".`,
          );
          break;
        case 'upgrade':
          ensureContentReference(
            upgradeIndex,
            emitter.id,
            toMutablePath(['runtimeEvents', index, 'emits', emitterIndex, 'id'] as const),
            `Runtime event emitter references unknown upgrade "${emitter.id}".`,
          );
          break;
        case 'transform':
          ensureContentReference(
            transformIndex,
            emitter.id,
            toMutablePath(['runtimeEvents', index, 'emits', emitterIndex, 'id'] as const),
            `Runtime event emitter references unknown transform "${emitter.id}".`,
          );
          break;
        case 'script':
          assertAllowlisted(
            context.allowlists.scripts,
            emitter.id,
            toMutablePath(['runtimeEvents', index, 'emits', emitterIndex, 'id'] as const),
            ctx,
            warn,
            'allowlist.script.missing',
            `Script "${emitter.id}" is not declared in the scripts allowlist.`,
          );
          break;
        default:
          break;
      }
    });
  });

  pack.generators.forEach((generator, index) => {
    generator.produces.forEach((entry, produceIndex) => {
      ensureContentReference(
        resourceIndex,
        entry.resourceId,
        ['generators', index, 'produces', produceIndex, 'resourceId'],
        `Generator "${generator.id}" produces unknown resource "${entry.resourceId}".`,
      );
      collectFormulaEntityReferences(entry.rate, (reference) => {
        ensureFormulaReference(reference, ['generators', index, 'produces', produceIndex, 'rate'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
      });
    });
    generator.consumes.forEach((entry, consumeIndex) => {
      ensureContentReference(
        resourceIndex,
        entry.resourceId,
        ['generators', index, 'consumes', consumeIndex, 'resourceId'],
        `Generator "${generator.id}" consumes unknown resource "${entry.resourceId}".`,
      );
      collectFormulaEntityReferences(entry.rate, (reference) => {
        ensureFormulaReference(reference, ['generators', index, 'consumes', consumeIndex, 'rate'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
      });
    });
    ensureContentReference(
      resourceIndex,
      generator.purchase.currencyId,
      ['generators', index, 'purchase', 'currencyId'],
      `Generator "${generator.id}" references unknown currency "${generator.purchase.currencyId}".`,
    );
    collectFormulaEntityReferences(generator.purchase.costCurve, (reference) => {
      ensureFormulaReference(reference, ['generators', index, 'purchase', 'costCurve'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
    });
    if (generator.automation) {
      ensureContentReference(
        automationIndex,
        generator.automation.automationId,
        ['generators', index, 'automation', 'automationId'],
        `Generator "${generator.id}" references unknown automation "${generator.automation.automationId}".`,
      );
    }
    if (generator.baseUnlock) {
      validateConditionNode(
        generator.baseUnlock,
        ['generators', index, 'baseUnlock'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    if (generator.visibilityCondition) {
      validateConditionNode(
        generator.visibilityCondition,
        ['generators', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    generator.effects.forEach((effect, effectIndex) => {
      validateUpgradeEffect(
        effect,
        ['generators', index, 'effects', effectIndex],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        automationIndex,
        prestigeIndex,
        knownRuntimeEvents,
      );
    });
  });

  pack.upgrades.forEach((upgrade, index) => {
    upgrade.targets.forEach((target, targetIndex) => {
      switch (target.kind) {
        case 'resource':
          ensureContentReference(
            resourceIndex,
            target.id,
            ['upgrades', index, 'targets', targetIndex, 'id'],
            `Upgrade "${upgrade.id}" targets unknown resource "${target.id}".`,
          );
          break;
        case 'generator':
          ensureContentReference(
            generatorIndex,
            target.id,
            ['upgrades', index, 'targets', targetIndex, 'id'],
            `Upgrade "${upgrade.id}" targets unknown generator "${target.id}".`,
          );
          break;
        case 'automation':
          ensureContentReference(
            automationIndex,
            target.id,
            ['upgrades', index, 'targets', targetIndex, 'id'],
            `Upgrade "${upgrade.id}" targets unknown automation "${target.id}".`,
          );
          break;
        case 'prestigeLayer':
          ensureContentReference(
            prestigeIndex,
            target.id,
            ['upgrades', index, 'targets', targetIndex, 'id'],
            `Upgrade "${upgrade.id}" targets unknown prestige layer "${target.id}".`,
          );
          break;
        case 'guildPerk':
          ensureContentReference(
            guildPerkIndex,
            target.id,
            ['upgrades', index, 'targets', targetIndex, 'id'],
            `Upgrade "${upgrade.id}" targets unknown guild perk "${target.id}".`,
          );
          break;
        default:
          break;
      }
    });
    ensureContentReference(
      resourceIndex,
      upgrade.cost.currencyId,
      ['upgrades', index, 'cost', 'currencyId'],
      `Upgrade "${upgrade.id}" references unknown currency "${upgrade.cost.currencyId}".`,
    );
    collectFormulaEntityReferences(upgrade.cost.costCurve, (reference) => {
      ensureFormulaReference(reference, ['upgrades', index, 'cost', 'costCurve'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
    });
    upgrade.effects.forEach((effect, effectIndex) => {
      validateUpgradeEffect(
        effect,
        ['upgrades', index, 'effects', effectIndex],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        automationIndex,
        prestigeIndex,
        knownRuntimeEvents,
      );
    });
    upgrade.prerequisites.forEach((prerequisite, prerequisiteIndex) => {
      validateConditionNode(
        prerequisite,
        ['upgrades', index, 'prerequisites', prerequisiteIndex],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    });
    if (upgrade.unlockCondition) {
      validateConditionNode(
        upgrade.unlockCondition,
        ['upgrades', index, 'unlockCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    if (upgrade.visibilityCondition) {
      validateConditionNode(
        upgrade.visibilityCondition,
        ['upgrades', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
  });

  pack.metrics.forEach((metric, index) => {
    if (metric.source.kind === 'script') {
      assertAllowlisted(
        context.allowlists.scripts,
        metric.source.scriptId,
        ['metrics', index, 'source', 'scriptId'],
        ctx,
        warn,
        'allowlist.script.missing',
        `Metric "${metric.id}" references script "${metric.source.scriptId}" that is not in the scripts allowlist.`,
      );
    }
  });

  pack.achievements.forEach((achievement, index) => {
    switch (achievement.track.kind) {
      case 'resource':
        ensureContentReference(
          resourceIndex,
          achievement.track.resourceId,
          ['achievements', index, 'track', 'resourceId'],
          `Achievement "${achievement.id}" references unknown resource "${achievement.track.resourceId}".`,
        );
        collectFormulaEntityReferences(achievement.track.threshold, (reference) => {
          ensureFormulaReference(reference, ['achievements', index, 'track', 'threshold'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
        });
        break;
      case 'generator-level':
        ensureContentReference(
          generatorIndex,
          achievement.track.generatorId,
          ['achievements', index, 'track', 'generatorId'],
          `Achievement "${achievement.id}" references unknown generator "${achievement.track.generatorId}".`,
        );
        collectFormulaEntityReferences(achievement.track.level, (reference) => {
          ensureFormulaReference(reference, ['achievements', index, 'track', 'level'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
        });
        break;
      case 'upgrade-owned':
        ensureContentReference(
          upgradeIndex,
          achievement.track.upgradeId,
          ['achievements', index, 'track', 'upgradeId'],
          `Achievement "${achievement.id}" references unknown upgrade "${achievement.track.upgradeId}".`,
        );
        if (achievement.track.purchases) {
          collectFormulaEntityReferences(achievement.track.purchases, (reference) => {
            ensureFormulaReference(reference, ['achievements', index, 'track', 'purchases'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
          });
        }
        break;
      case 'flag':
        assertAllowlisted(
          context.allowlists.flags,
          achievement.track.flagId,
          ['achievements', index, 'track', 'flagId'],
          ctx,
          warn,
          'allowlist.flag.missing',
          `Achievement "${achievement.id}" references flag "${achievement.track.flagId}" that is not in the flags allowlist.`,
        );
        break;
      case 'script':
        assertAllowlisted(
          context.allowlists.scripts,
          achievement.track.scriptId,
          ['achievements', index, 'track', 'scriptId'],
          ctx,
          warn,
          'allowlist.script.missing',
          `Achievement "${achievement.id}" references script "${achievement.track.scriptId}" that is not in the scripts allowlist.`,
        );
        break;
      case 'custom-metric':
        ensureContentReference(
          metricIndex,
          achievement.track.metricId,
          ['achievements', index, 'track', 'metricId'],
          `Achievement "${achievement.id}" references unknown metric "${achievement.track.metricId}".`,
        );
        collectFormulaEntityReferences(achievement.track.threshold, (reference) => {
          ensureFormulaReference(reference, ['achievements', index, 'track', 'threshold'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
        });
        break;
      default:
        break;
    }
    if (achievement.reward) {
      switch (achievement.reward.kind) {
        case 'grantResource':
          ensureContentReference(
            resourceIndex,
            achievement.reward.resourceId,
            ['achievements', index, 'reward', 'resourceId'],
            `Achievement "${achievement.id}" grants unknown resource "${achievement.reward.resourceId}".`,
          );
          collectFormulaEntityReferences(achievement.reward.amount, (reference) => {
            ensureFormulaReference(reference, ['achievements', index, 'reward', 'amount'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
          });
          break;
        case 'grantUpgrade':
          ensureContentReference(
            upgradeIndex,
            achievement.reward.upgradeId,
            ['achievements', index, 'reward', 'upgradeId'],
            `Achievement "${achievement.id}" grants unknown upgrade "${achievement.reward.upgradeId}".`,
          );
          break;
        case 'grantGuildPerk':
          ensureContentReference(
            guildPerkIndex,
            achievement.reward.perkId,
            ['achievements', index, 'reward', 'perkId'],
            `Achievement "${achievement.id}" grants unknown guild perk "${achievement.reward.perkId}".`,
          );
          break;
        case 'emitEvent':
          ensureRuntimeEventKnown(
            achievement.reward.eventId,
            ['achievements', index, 'reward', 'eventId'],
            context.runtimeEventCatalogue.size > 0 ? 'error' : 'warning',
          );
          break;
        case 'unlockAutomation':
          ensureContentReference(
            automationIndex,
            achievement.reward.automationId,
            ['achievements', index, 'reward', 'automationId'],
            `Achievement "${achievement.id}" unlocks unknown automation "${achievement.reward.automationId}".`,
          );
          break;
        case 'grantFlag':
          assertAllowlisted(
            context.allowlists.flags,
            achievement.reward.flagId,
            ['achievements', index, 'reward', 'flagId'],
            ctx,
            warn,
            'allowlist.flag.missing',
            `Achievement "${achievement.id}" grants flag "${achievement.reward.flagId}" that is not in the flags allowlist.`,
          );
          break;
        default:
          break;
      }
    }
    if (achievement.unlockCondition) {
      validateConditionNode(
        achievement.unlockCondition,
        ['achievements', index, 'unlockCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    if (achievement.visibilityCondition) {
      validateConditionNode(
        achievement.visibilityCondition,
        ['achievements', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    achievement.onUnlockEvents.forEach((eventId, eventIndex) => {
      ensureRuntimeEventKnown(
        eventId,
        ['achievements', index, 'onUnlockEvents', eventIndex],
        context.runtimeEventCatalogue.size > 0 ? 'error' : 'warning',
      );
    });
  });

  pack.automations.forEach((automation, index) => {
    if (
      automation.targetType === 'generator' ||
      automation.targetType === 'purchaseGenerator'
    ) {
      if (automation.targetId) {
        ensureContentReference(
          generatorIndex,
          automation.targetId,
          ['automations', index, 'targetId'],
          `Automation "${automation.id}" references unknown generator "${automation.targetId}".`,
        );
      }
      if (automation.targetType === 'purchaseGenerator' && automation.targetCount) {
        collectFormulaEntityReferences(automation.targetCount, (reference) => {
          ensureFormulaReference(
            reference,
            ['automations', index, 'targetCount'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
      }
    } else if (automation.targetType === 'upgrade') {
      if (automation.targetId) {
        ensureContentReference(
          upgradeIndex,
          automation.targetId,
          ['automations', index, 'targetId'],
          `Automation "${automation.id}" references unknown upgrade "${automation.targetId}".`,
        );
      }
    } else if (automation.targetType === 'collectResource') {
      if (automation.targetId) {
        ensureContentReference(
          resourceIndex,
          automation.targetId,
          ['automations', index, 'targetId'],
          `Automation "${automation.id}" references unknown resource "${automation.targetId}".`,
        );
      }
      if (automation.targetAmount) {
        collectFormulaEntityReferences(automation.targetAmount, (reference) => {
          ensureFormulaReference(
            reference,
            ['automations', index, 'targetAmount'],
            ctx,
            resourceIndex,
            generatorIndex,
            upgradeIndex,
            automationIndex,
            prestigeIndex,
          );
        });
      }
    } else if (automation.targetType === 'system') {
      if (automation.systemTargetId) {
        assertAllowlisted(
          context.allowlists.systemAutomationTargets,
          automation.systemTargetId,
          ['automations', index, 'systemTargetId'],
          ctx,
          warn,
          'allowlist.systemAutomationTarget.missing',
          `Automation "${automation.id}" references system target "${automation.systemTargetId}" not present in the allowlist.`,
        );
      }
    }
    if (automation.resourceCost) {
      ensureContentReference(
        resourceIndex,
        automation.resourceCost.resourceId,
        ['automations', index, 'resourceCost', 'resourceId'],
        `Automation "${automation.id}" references unknown resource "${automation.resourceCost.resourceId}".`,
      );
      collectFormulaEntityReferences(automation.resourceCost.rate, (reference) => {
        ensureFormulaReference(reference, ['automations', index, 'resourceCost', 'rate'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
      });
    }
    switch (automation.trigger.kind) {
      case 'resourceThreshold':
        ensureContentReference(
          resourceIndex,
          automation.trigger.resourceId,
          ['automations', index, 'trigger', 'resourceId'],
          `Automation "${automation.id}" trigger references unknown resource "${automation.trigger.resourceId}".`,
        );
        collectFormulaEntityReferences(automation.trigger.threshold, (reference) => {
          ensureFormulaReference(reference, ['automations', index, 'trigger', 'threshold'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
        });
        break;
      case 'event':
        ensureRuntimeEventKnown(
          automation.trigger.eventId,
          ['automations', index, 'trigger', 'eventId'],
          context.runtimeEventCatalogue.size > 0 ? 'error' : 'warning',
        );
        break;
      default:
        break;
    }
    if (automation.scriptId) {
      assertAllowlisted(
        context.allowlists.scripts,
        automation.scriptId,
        ['automations', index, 'scriptId'],
        ctx,
        warn,
        'allowlist.script.missing',
        `Automation "${automation.id}" references script "${automation.scriptId}" that is not in the scripts allowlist.`,
      );
    }
    validateConditionNode(
      automation.unlockCondition,
      ['automations', index, 'unlockCondition'],
      ctx,
      context,
      resourceIndex,
      generatorIndex,
      upgradeIndex,
      prestigeIndex,
    );
  });

  pack.transforms.forEach((transform, index) => {
    transform.inputs.forEach((input, inputIndex) => {
      ensureContentReference(
        resourceIndex,
        input.resourceId,
        ['transforms', index, 'inputs', inputIndex, 'resourceId'],
        `Transform "${transform.id}" consumes unknown resource "${input.resourceId}".`,
      );
      collectFormulaEntityReferences(input.amount, (reference) => {
        ensureFormulaReference(reference, ['transforms', index, 'inputs', inputIndex, 'amount'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
      });
    });
    transform.outputs.forEach((output, outputIndex) => {
      ensureContentReference(
        resourceIndex,
        output.resourceId,
        ['transforms', index, 'outputs', outputIndex, 'resourceId'],
        `Transform "${transform.id}" produces unknown resource "${output.resourceId}".`,
      );
      collectFormulaEntityReferences(output.amount, (reference) => {
        ensureFormulaReference(reference, ['transforms', index, 'outputs', outputIndex, 'amount'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
      });
    });
    if (transform.duration) {
      collectFormulaEntityReferences(transform.duration, (reference) => {
        ensureFormulaReference(reference, ['transforms', index, 'duration'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
      });
    }
    if (transform.cooldown) {
      collectFormulaEntityReferences(transform.cooldown, (reference) => {
        ensureFormulaReference(reference, ['transforms', index, 'cooldown'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
      });
    }
    switch (transform.trigger.kind) {
      case 'automation':
        ensureContentReference(
          automationIndex,
          transform.trigger.automationId,
          ['transforms', index, 'trigger', 'automationId'],
          `Transform "${transform.id}" references unknown automation "${transform.trigger.automationId}".`,
        );
        break;
      case 'condition':
        validateConditionNode(
          transform.trigger.condition,
          ['transforms', index, 'trigger', 'condition'],
          ctx,
          context,
          resourceIndex,
          generatorIndex,
          upgradeIndex,
          prestigeIndex,
        );
        break;
      case 'event':
        ensureRuntimeEventKnown(
          transform.trigger.eventId,
          ['transforms', index, 'trigger', 'eventId'],
          context.runtimeEventCatalogue.size > 0 ? 'error' : 'warning',
        );
        break;
      default:
        break;
    }
    if (transform.automation) {
      ensureContentReference(
        automationIndex,
        transform.automation.automationId,
        ['transforms', index, 'automation', 'automationId'],
        `Transform "${transform.id}" references unknown automation "${transform.automation.automationId}".`,
      );
    }
    if (transform.unlockCondition) {
      validateConditionNode(
        transform.unlockCondition,
        ['transforms', index, 'unlockCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    if (transform.visibilityCondition) {
      validateConditionNode(
        transform.visibilityCondition,
        ['transforms', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
  });

  pack.prestigeLayers.forEach((layer, index) => {
    layer.resetTargets.forEach((target, targetIndex) => {
      ensureContentReference(
        resourceIndex,
        target,
        ['prestigeLayers', index, 'resetTargets', targetIndex],
        `Prestige layer "${layer.id}" resets unknown resource "${target}".`,
      );
    });
    layer.resetGenerators?.forEach((target, targetIndex) => {
      ensureContentReference(
        generatorIndex,
        target,
        ['prestigeLayers', index, 'resetGenerators', targetIndex],
        `Prestige layer "${layer.id}" resets unknown generator "${target}".`,
      );
    });
    layer.resetUpgrades?.forEach((target, targetIndex) => {
      ensureContentReference(
        upgradeIndex,
        target,
        ['prestigeLayers', index, 'resetUpgrades', targetIndex],
        `Prestige layer "${layer.id}" resets unknown upgrade "${target}".`,
      );
    });
    ensureContentReference(
      resourceIndex,
      layer.reward.resourceId,
      ['prestigeLayers', index, 'reward', 'resourceId'],
      `Prestige layer "${layer.id}" rewards unknown resource "${layer.reward.resourceId}".`,
    );
    collectFormulaEntityReferences(layer.reward.baseReward, (reference) => {
      ensureFormulaReference(reference, ['prestigeLayers', index, 'reward', 'baseReward'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
    });
    if (layer.reward.multiplierCurve) {
      collectFormulaEntityReferences(layer.reward.multiplierCurve, (reference) => {
        ensureFormulaReference(reference, ['prestigeLayers', index, 'reward', 'multiplierCurve'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
      });
    }
    layer.retention.forEach((entry, retentionIndex) => {
      if (entry.kind === 'resource') {
        ensureContentReference(
          resourceIndex,
          entry.resourceId,
          ['prestigeLayers', index, 'retention', retentionIndex, 'resourceId'],
          `Prestige layer "${layer.id}" retains unknown resource "${entry.resourceId}".`,
        );
      } else if (entry.kind === 'generator') {
        ensureContentReference(
          generatorIndex,
          entry.generatorId,
          ['prestigeLayers', index, 'retention', retentionIndex, 'generatorId'],
          `Prestige layer "${layer.id}" retains unknown generator "${entry.generatorId}".`,
        );
      } else if (entry.kind === 'upgrade') {
        ensureContentReference(
          upgradeIndex,
          entry.upgradeId,
          ['prestigeLayers', index, 'retention', retentionIndex, 'upgradeId'],
          `Prestige layer "${layer.id}" retains unknown upgrade "${entry.upgradeId}".`,
        );
      }
    });
    if (layer.automation) {
      ensureContentReference(
        automationIndex,
        layer.automation.automationId,
        ['prestigeLayers', index, 'automation', 'automationId'],
        `Prestige layer "${layer.id}" references unknown automation "${layer.automation.automationId}".`,
      );
    }
    validateConditionNode(
      layer.unlockCondition,
      ['prestigeLayers', index, 'unlockCondition'],
      ctx,
      context,
      resourceIndex,
      generatorIndex,
      upgradeIndex,
      prestigeIndex,
    );
    // Validate that the required prestige count resource exists
    const prestigeCountId = `${layer.id}-prestige-count`;
    ensureContentReference(
      resourceIndex,
      prestigeCountId,
      ['prestigeLayers', index, 'id'],
      `Prestige layer "${layer.id}" requires a resource named "${prestigeCountId}" to track prestige count. ` +
        `Add this resource to your content pack's resources array.`,
    );
  });

  pack.guildPerks.forEach((perk, index) => {
    perk.effects.forEach((effect, effectIndex) => {
      validateUpgradeEffect(
        effect,
        ['guildPerks', index, 'effects', effectIndex],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        automationIndex,
        prestigeIndex,
        knownRuntimeEvents,
      );
    });
    switch (perk.cost.kind) {
      case 'currency':
        ensureContentReference(
          resourceIndex,
          perk.cost.resourceId,
          ['guildPerks', index, 'cost', 'resourceId'],
          `Guild perk "${perk.id}" references unknown resource "${perk.cost.resourceId}".`,
        );
        collectFormulaEntityReferences(perk.cost.amount, (reference) => {
          ensureFormulaReference(reference, ['guildPerks', index, 'cost', 'amount'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
        });
        break;
      case 'metric':
        ensureContentReference(
          metricIndex,
          perk.cost.metricId,
          ['guildPerks', index, 'cost', 'metricId'],
          `Guild perk "${perk.id}" references unknown metric "${perk.cost.metricId}".`,
        );
        collectFormulaEntityReferences(perk.cost.amount, (reference) => {
          ensureFormulaReference(reference, ['guildPerks', index, 'cost', 'amount'], ctx, resourceIndex, generatorIndex, upgradeIndex, automationIndex, prestigeIndex);
        });
        break;
      default:
        break;
    }
    if (perk.unlockCondition) {
      validateConditionNode(
        perk.unlockCondition,
        ['guildPerks', index, 'unlockCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
    if (perk.visibilityCondition) {
      validateConditionNode(
        perk.visibilityCondition,
        ['guildPerks', index, 'visibilityCondition'],
        ctx,
        context,
        resourceIndex,
        generatorIndex,
        upgradeIndex,
        prestigeIndex,
      );
    }
  });

  validateDependencies(pack, ctx, context);

  const featureGateViolations = resolveFeatureViolations(
    context.runtimeVersion,
    buildFeatureGateMap(pack),
  );
  featureGateViolations.forEach((violation) => {
    if (violation.severity === 'error') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(['metadata', 'version'] as const),
        message: violation.message,
      });
    } else {
      warn({
        code: 'runtime.featureGate',
        message: violation.message,
        path: toMutablePath(['metadata', 'version'] as const),
        severity: 'warning',
      });
    }
  });

  // Validate transform chains for cycles
  validateTransformCycles(pack, ctx);

  // Validate unlock conditions for cycles
  validateUnlockConditionCycles(pack, ctx);
};

const ensureFormulaReference = (
  reference: { readonly type: string; readonly id: string },
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
  resources: Map<string, { index: number }>,
  generators: Map<string, { index: number }>,
  upgrades: Map<string, { index: number }>,
  automations: Map<string, { index: number }>,
  prestigeLayers: Map<string, { index: number }>,
) => {
  switch (reference.type) {
    case 'resource':
      if (!resources.has(reference.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Formula references unknown resource "${reference.id}".`,
        });
      }
      break;
    case 'generator':
      if (!generators.has(reference.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Formula references unknown generator "${reference.id}".`,
        });
      }
      break;
    case 'upgrade':
      if (!upgrades.has(reference.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Formula references unknown upgrade "${reference.id}".`,
        });
      }
      break;
    case 'automation':
      if (!automations.has(reference.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Formula references unknown automation "${reference.id}".`,
        });
      }
      break;
    case 'prestigeLayer':
      if (!prestigeLayers.has(reference.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Formula references unknown prestige layer "${reference.id}".`,
        });
      }
      break;
    default:
      break;
  }
};

const validateUpgradeEffect = (
  effect: UpgradeEffect | GuildPerkDefinition['effects'][number],
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
  context: CrossReferenceContext,
  resources: Map<string, { index: number }>,
  generators: Map<string, { index: number }>,
  upgrades: Map<string, { index: number }>,
  automations: Map<string, { index: number }>,
  prestigeLayers: Map<string, { index: number }>,
  runtimeEvents: ReadonlySet<string>,
) => {
  const ensureReference = (
    map: Map<string, { index: number }>,
    id: string,
    message: string,
  ) => {
    if (!map.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(path),
        message,
      });
    }
  };

  switch (effect.kind) {
    case 'modifyResourceRate':
    case 'unlockResource':
    case 'alterDirtyTolerance':
      ensureReference(
        resources,
        effect.resourceId,
        `Effect references unknown resource "${effect.resourceId}".`,
      );
      if ('value' in effect) {
        collectFormulaEntityReferences(effect.value, (reference) => {
          ensureFormulaReference(reference, path, ctx, resources, generators, upgrades, automations, prestigeLayers);
        });
      }
      break;
    case 'modifyGeneratorRate':
    case 'modifyGeneratorCost':
    case 'unlockGenerator':
      ensureReference(
        generators,
        effect.generatorId,
        `Effect references unknown generator "${effect.generatorId}".`,
      );
      if ('value' in effect) {
        collectFormulaEntityReferences(effect.value, (reference) => {
          ensureFormulaReference(reference, path, ctx, resources, generators, upgrades, automations, prestigeLayers);
        });
      }
      break;
    case 'grantAutomation':
      ensureReference(
        automations,
        effect.automationId,
        `Effect references unknown automation "${effect.automationId}".`,
      );
      break;
    case 'grantFlag':
      assertAllowlisted(
        context.allowlists.flags,
        effect.flagId,
        [...path, 'flagId'] as const,
        ctx,
        context.warningSink,
        'allowlist.flag.missing',
        `Effect references flag "${effect.flagId}" that is not in the flags allowlist.`,
      );
      break;
    case 'emitEvent':
      if (!runtimeEvents.has(effect.eventId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: toMutablePath(path),
          message: `Effect references unknown runtime event "${effect.eventId}".`,
        });
      }
      break;
    case 'unlockGuildAutomation':
      ensureReference(
        automations,
        effect.automationId,
        `Effect references unknown automation "${effect.automationId}".`,
      );
      break;
    case 'modifyGuildStorage':
      ensureReference(
        resources,
        effect.storageId,
        `Effect references unknown resource "${effect.storageId}".`,
      );
      collectFormulaEntityReferences(effect.value, (reference) => {
        ensureFormulaReference(reference, path, ctx, resources, generators, upgrades, automations, prestigeLayers);
      });
      break;
    default:
      break;
  }
};

const validateConditionNode = (
  condition: Condition | undefined,
  path: readonly (string | number)[],
  ctx: z.RefinementCtx,
  context: CrossReferenceContext,
  resources: Map<string, { index: number }>,
  generators: Map<string, { index: number }>,
  upgrades: Map<string, { index: number }>,
  prestigeLayers: Map<string, { index: number }>,
) => {
  if (!condition) {
    return;
  }

  const visit = (node: Condition, currentPath: readonly (string | number)[]) => {
    switch (node.kind) {
      case 'resourceThreshold':
        if (!resources.has(node.resourceId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'resourceId'] as const),
            message: `Condition references unknown resource "${node.resourceId}".`,
          });
        }
        collectFormulaEntityReferences(node.amount, (reference) => {
          ensureFormulaReference(reference, currentPath, ctx, resources, generators, upgrades, new Map(), prestigeLayers);
        });
        break;
      case 'generatorLevel':
        if (!generators.has(node.generatorId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'generatorId'] as const),
            message: `Condition references unknown generator "${node.generatorId}".`,
          });
        }
        collectFormulaEntityReferences(node.level, (reference) => {
          ensureFormulaReference(reference, currentPath, ctx, resources, generators, upgrades, new Map(), prestigeLayers);
        });
        break;
      case 'upgradeOwned':
        if (!upgrades.has(node.upgradeId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'upgradeId'] as const),
            message: `Condition references unknown upgrade "${node.upgradeId}".`,
          });
        }
        break;
      case 'prestigeCountThreshold':
        if (!prestigeLayers.has(node.prestigeLayerId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'prestigeLayerId'] as const),
            message: `Condition references unknown prestige layer "${node.prestigeLayerId}".`,
          });
        }
        break;
      case 'prestigeCompleted':
        if (!prestigeLayers.has(node.prestigeLayerId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'prestigeLayerId'] as const),
            message: `Condition references unknown prestige layer "${node.prestigeLayerId}".`,
          });
        }
        break;
      case 'prestigeUnlocked':
        if (!prestigeLayers.has(node.prestigeLayerId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: toMutablePath([...currentPath, 'prestigeLayerId'] as const),
            message: `Condition references unknown prestige layer "${node.prestigeLayerId}".`,
          });
        }
        break;
      case 'flag':
        assertAllowlisted(
          context.allowlists.flags,
          node.flagId,
          [...currentPath, 'flagId'],
          ctx,
          context.warningSink,
          'allowlist.flag.missing',
          `Condition references flag "${node.flagId}" that is not in the flags allowlist.`,
        );
        break;
      case 'script':
        assertAllowlisted(
          context.allowlists.scripts,
          node.scriptId,
          [...currentPath, 'scriptId'],
          ctx,
          context.warningSink,
          'allowlist.script.missing',
          `Condition references script "${node.scriptId}" that is not in the scripts allowlist.`,
        );
        break;
      case 'allOf':
      case 'anyOf':
        node.conditions.forEach((child, childIndex) =>
          visit(child, [...currentPath, 'conditions', childIndex]),
        );
        break;
      case 'not':
        visit(node.condition, [...currentPath, 'condition']);
        break;
      default:
        break;
    }
  };

  visit(condition, path);
};

const validateDependencies = (
  pack: ParsedContentPack,
  ctx: z.RefinementCtx,
  context: CrossReferenceContext,
) => {
  const dependencies = pack.metadata.dependencies;
  if (!dependencies) {
    return;
  }

  const packId = pack.metadata.id;

  dependencies.optional.forEach((dependency, index) => {
    if (context.activePackIds.size === 0) {
      return;
    }
    if (!context.activePackIds.has(dependency.packId)) {
      context.warningSink({
        code: 'dependencies.optionalMissing',
        message: `Optional dependency "${dependency.packId}" is not present in active pack set.`,
        path: toMutablePath(['metadata', 'dependencies', 'optional', index] as const),
        severity: 'warning',
      });
    }
  });

  const adjacency = new Map<string, Set<string>>();

  const addEdge = (from: string, to: string) => {
    if (!adjacency.has(from)) {
      adjacency.set(from, new Set());
    }
    adjacency.get(from)?.add(to);
  };

  dependencies.requires.forEach((dependency, index) => {
    if (dependency.packId === packId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(['metadata', 'dependencies', 'requires', index, 'packId'] as const),
        message: 'Pack cannot depend on itself.',
      });
      return;
    }
    addEdge(packId, dependency.packId);
    if (!context.knownPacks.has(dependency.packId)) {
      context.warningSink({
        code: 'dependencies.unknownPack',
        message: `Dependency "${dependency.packId}" is not present in known pack graph.`,
        path: toMutablePath(['metadata', 'dependencies', 'requires', index, 'packId'] as const),
        severity: 'warning',
      });
    }
  });

  context.knownPacks.forEach((knownPack) => {
    knownPack.requires?.forEach((dependency: KnownPackDependency) => {
      addEdge(knownPack.id, dependency.packId);
    });
  });

  const stack = new Set<string>();
  const visited = new Set<string>();

  const visit = (node: string): boolean => {
    if (stack.has(node)) {
      return true;
    }
    if (visited.has(node)) {
      return false;
    }
    visited.add(node);
    stack.add(node);
    const edges = adjacency.get(node);
    if (edges) {
      for (const target of edges) {
        if (visit(target)) {
          return true;
        }
      }
    }
    stack.delete(node);
    return false;
  };

  if (visit(packId)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: toMutablePath(['metadata', 'dependencies', 'requires'] as const),
      message: 'Dependency graph contains a cycle involving this pack.',
    });
  }
};

/**
 * Type definitions for cycle detection
 */
type AdjacencyGraph = Map<string, Set<string>>;
type CyclePath = string[];

/**
 * Normalizes a cycle path to its canonical form for deduplication.
 * The canonical form starts with the lexicographically smallest element.
 * For example: [B, C, A, B] becomes [A, B, C, A]
 */
const normalizeCyclePath = (cyclePath: CyclePath): string => {
  if (cyclePath.length <= 1) {
    return cyclePath.join('→');
  }

  // Remove the duplicate last element for rotation
  const cycle = cyclePath.slice(0, -1);

  // Find the index of the lexicographically smallest element
  let minIndex = 0;
  for (let i = 1; i < cycle.length; i++) {
    if (cycle[i] < cycle[minIndex]) {
      minIndex = i;
    }
  }

  // Rotate the cycle to start with the smallest element
  const normalized = [...cycle.slice(minIndex), ...cycle.slice(0, minIndex)];
  // Add the first element again to close the cycle
  normalized.push(normalized[0]);

  return normalized.join('→');
};

/**
 * Generic cycle detection using DFS with path tracking.
 * Returns detected cycles (deduplicated and optionally stopping at first cycle).
 *
 * @param adjacency - The graph represented as an adjacency list
 * @param nodes - The nodes to check for cycles
 * @param stopAtFirst - If true, stops after finding the first cycle (default: true for performance)
 * @returns Array of cycle paths
 */
const detectCycles = (
  adjacency: AdjacencyGraph,
  nodes: Iterable<string>,
  stopAtFirst = true,
): CyclePath[] => {
  const visited = new Set<string>();
  const stack = new Set<string>();
  const path: CyclePath = [];
  const cycles: CyclePath[] = [];
  const seenCycles = new Set<string>();

  const visit = (node: string): boolean => {
    if (stack.has(node)) {
      // Cycle detected! Build the cycle path
      const cycleStartIndex = path.indexOf(node);
      const cyclePath: CyclePath = [...path.slice(cycleStartIndex), node];

      // Normalize and deduplicate
      const normalizedCycle = normalizeCyclePath(cyclePath);
      if (!seenCycles.has(normalizedCycle)) {
        seenCycles.add(normalizedCycle);
        cycles.push(cyclePath);

        // Early termination if requested
        if (stopAtFirst) {
          return true; // Signal to stop
        }
      }
      return false;
    }

    if (visited.has(node)) {
      return false;
    }

    visited.add(node);
    stack.add(node);
    path.push(node);

    const edges = adjacency.get(node);
    if (edges) {
      for (const target of edges) {
        if (visit(target)) {
          return true; // Propagate early termination
        }
      }
    }

    stack.delete(node);
    path.pop();
    return false;
  };

  // Check all nodes for cycles
  for (const nodeId of nodes) {
    if (!visited.has(nodeId)) {
      if (visit(nodeId)) {
        break; // Early termination
      }
    }
  }

  return cycles;
};

const validateTransformCycles = (
  pack: ParsedContentPack,
  ctx: z.RefinementCtx,
) => {
  // Build a graph where nodes are transforms and edges are resource dependencies
  // Edge from transform A to transform B exists when:
  // A produces a resource that B consumes as input
  const adjacency = new Map<string, Set<string>>();
  const transformIndex = new Map<string, number>();

  // Index all transforms by their output resources
  const resourceProducers = new Map<string, Set<string>>();

  pack.transforms.forEach((transform, index) => {
    transformIndex.set(transform.id, index);

    transform.outputs.forEach((output) => {
      if (!resourceProducers.has(output.resourceId)) {
        resourceProducers.set(output.resourceId, new Set());
      }
      resourceProducers.get(output.resourceId)?.add(transform.id);
    });
  });

  // Build the adjacency graph based on resource dependencies
  pack.transforms.forEach((transform) => {
    transform.inputs.forEach((input) => {
      const producers = resourceProducers.get(input.resourceId);
      if (producers) {
        producers.forEach((producerId) => {
          // Add edge from producer to consumer
          if (!adjacency.has(producerId)) {
            adjacency.set(producerId, new Set());
          }
          adjacency.get(producerId)?.add(transform.id);
        });
      }
    });
  });

  // Detect cycles using the generic helper
  // Uses early termination (stopAtFirst=true by default) for performance
  const cycles = detectCycles(
    adjacency,
    pack.transforms.map((t) => t.id),
  );

  // Report detected cycle (at most one due to early termination)
  for (const cyclePath of cycles) {
    const cycleDescription = cyclePath.join(' → ');
    const firstNodeInCycle = cyclePath[0];
    const index = transformIndex.get(firstNodeInCycle);

    // Collect resources involved in the cycle
    const involvedResources = new Set<string>();
    for (let i = 0; i < cyclePath.length - 1; i++) {
      const currentTransformId = cyclePath[i];
      const nextTransformId = cyclePath[i + 1];

      // Find the transform objects
      const currentTransform = pack.transforms.find((t) => t.id === currentTransformId);
      const nextTransform = pack.transforms.find((t) => t.id === nextTransformId);

      if (currentTransform && nextTransform) {
        // Find resources produced by current that are consumed by next
        currentTransform.outputs.forEach((output) => {
          if (nextTransform.inputs.some((input) => input.resourceId === output.resourceId)) {
            involvedResources.add(output.resourceId);
          }
        });
      }
    }

    const resourceList = Array.from(involvedResources).sort().join(', ');
    const resourceContext = involvedResources.size > 0
      ? ` (involves resources: ${resourceList})`
      : '';

    if (index !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(['transforms', index] as const),
        message: `Transform cycle detected: ${cycleDescription}${resourceContext}. Consider breaking the cycle by: (1) introducing external resource sources via generators or initial grants, (2) converting to a linear transformation chain, or (3) adding intermediate resources to create a clear flow direction.`,
      });
    }
  }
};

const validateUnlockConditionCycles = (
  pack: ParsedContentPack,
  ctx: z.RefinementCtx,
) => {
  // Build a graph where nodes are entities (resources, generators, upgrades, etc.)
  // and edges represent unlock dependencies
  const adjacency = new Map<string, Set<string>>();

  // Track entity types and indices for error reporting
  type EntityInfo = {
    type: 'resource' | 'generator' | 'upgrade' | 'achievement' | 'transform' | 'prestige';
    index: number;
  };
  const entityMap = new Map<string, EntityInfo>();

  // Helper to extract entity references from conditions
  const extractConditionReferences = (condition: Condition | undefined): Set<string> => {
    const refs = new Set<string>();

    if (!condition) {
      return refs;
    }

	    const visit = (node: Condition) => {
	      switch (node.kind) {
	        case 'resourceThreshold':
	          refs.add(node.resourceId);
	          break;
	        case 'generatorLevel':
	          refs.add(node.generatorId);
	          break;
	        case 'upgradeOwned':
	          refs.add(node.upgradeId);
	          break;
	        case 'prestigeCountThreshold':
	          refs.add(`${node.prestigeLayerId}-prestige-count`);
	          break;
	        case 'prestigeCompleted':
	          refs.add(`${node.prestigeLayerId}-prestige-count`);
	          break;
	        case 'prestigeUnlocked':
	          refs.add(node.prestigeLayerId);
	          break;
	        case 'allOf':
	        case 'anyOf':
	          node.conditions.forEach(visit);
          break;
        case 'not':
          visit(node.condition);
          break;
        case 'always':
        case 'never':
        case 'flag':
        case 'script':
          // These conditions don't reference game entities, so no unlock dependencies
          break;
        default: {
          // Exhaustive check - TypeScript will error if new kinds are added
          const _exhaustive: never = node;
          return _exhaustive;
        }
      }
    };

    visit(condition);
    return refs;
  };

  // Index all entities
  pack.resources.forEach((resource, index) => {
    entityMap.set(resource.id, { type: 'resource', index });
  });
  pack.generators.forEach((generator, index) => {
    entityMap.set(generator.id, { type: 'generator', index });
  });
  pack.upgrades.forEach((upgrade, index) => {
    entityMap.set(upgrade.id, { type: 'upgrade', index });
  });
  pack.achievements.forEach((achievement, index) => {
    entityMap.set(achievement.id, { type: 'achievement', index });
  });
  pack.transforms.forEach((transform, index) => {
    entityMap.set(transform.id, { type: 'transform', index });
  });
  pack.prestigeLayers.forEach((layer, index) => {
    entityMap.set(layer.id, { type: 'prestige', index });
  });

  // Build adjacency graph for resources
  pack.resources.forEach((resource) => {
    if (resource.unlockCondition) {
      const refs = extractConditionReferences(resource.unlockCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(resource.id);
      });
    }
  });

  // Build adjacency graph for generators
  pack.generators.forEach((generator) => {
    if (generator.baseUnlock) {
      const refs = extractConditionReferences(generator.baseUnlock);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(generator.id);
      });
    }
  });

  // Build adjacency graph for upgrades
  pack.upgrades.forEach((upgrade) => {
    if (upgrade.unlockCondition) {
      const refs = extractConditionReferences(upgrade.unlockCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(upgrade.id);
      });
    }
    // Also check prerequisites (which are Condition objects)
    upgrade.prerequisites.forEach((prereqCondition) => {
      const refs = extractConditionReferences(prereqCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(upgrade.id);
      });
    });
  });

  // Build adjacency graph for achievements
  pack.achievements.forEach((achievement) => {
    if (achievement.unlockCondition) {
      const refs = extractConditionReferences(achievement.unlockCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(achievement.id);
      });
    }
  });

  // Build adjacency graph for transforms
  pack.transforms.forEach((transform) => {
    if (transform.unlockCondition) {
      const refs = extractConditionReferences(transform.unlockCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(transform.id);
      });
    }
  });

  // Build adjacency graph for prestige layers
  pack.prestigeLayers.forEach((layer) => {
    if (layer.unlockCondition) {
      const refs = extractConditionReferences(layer.unlockCondition);
      refs.forEach((ref) => {
        if (!adjacency.has(ref)) {
          adjacency.set(ref, new Set());
        }
        adjacency.get(ref)?.add(layer.id);
      });
    }
  });

  // Mapping from entity type to pack array property name
  const entityTypePaths: Record<EntityInfo['type'], string> = {
    resource: 'resources',
    generator: 'generators',
    upgrade: 'upgrades',
    achievement: 'achievements',
    transform: 'transforms',
    prestige: 'prestigeLayers',
  };

  // Detect cycles using the generic helper
  // Uses early termination (stopAtFirst=true by default) for performance
  const cycles = detectCycles(adjacency, entityMap.keys());

  // Report detected cycle (at most one due to early termination)
  for (const cyclePath of cycles) {
    const cycleDescription = cyclePath.join(' → ');
    const firstNodeInCycle = cyclePath[0];
    const entityInfo = entityMap.get(firstNodeInCycle);

    // Collect entity types involved in the cycle
    const involvedTypes = new Set<string>();
    cyclePath.forEach((entityId) => {
      const info = entityMap.get(entityId);
      if (info) {
        involvedTypes.add(info.type);
      }
    });

    const typeList = Array.from(involvedTypes).sort().join(', ');
    const typeContext = involvedTypes.size > 0
      ? ` (involves ${involvedTypes.size === 1 ? typeList : `entity types: ${typeList}`})`
      : '';

    if (entityInfo) {
      const pathPrefix = [entityTypePaths[entityInfo.type], entityInfo.index] as const;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: toMutablePath(pathPrefix),
        message: `Unlock condition cycle detected: ${cycleDescription}${typeContext}. Consider fixing by: (1) introducing a base entity that both depend on, (2) removing one unlock condition to create a hierarchical progression, or (3) using a flag or other non-entity condition to break the cycle.`,
      });
    }
  }
};

const buildContentPackEffectsSchema = (
  options: ContentSchemaOptions,
  warningSink: (warning: ContentSchemaWarning) => void,
) => {
  const allowlists: CrossReferenceContext['allowlists'] =
    options.allowlists === undefined
      ? {}
      : {
          ...(options.allowlists.flags
            ? {
                flags: normalizeAllowlistSpec(
                  options.allowlists.flags,
                  flagIdSchema,
                  warningSink,
                  ['options', 'allowlists', 'flags'],
                ),
              }
            : {}),
          ...(options.allowlists.scripts
            ? {
                scripts: normalizeAllowlistSpec(
                  options.allowlists.scripts,
                  scriptIdSchema,
                  warningSink,
                  ['options', 'allowlists', 'scripts'],
                ),
              }
            : {}),
          ...(options.allowlists.systemAutomationTargets
            ? {
                systemAutomationTargets: normalizeAllowlistSpec(
                  options.allowlists.systemAutomationTargets,
                  systemAutomationTargetIdSchema,
                  warningSink,
                  ['options', 'allowlists', 'systemAutomationTargets'],
                ),
              }
            : {}),
        };

  const runtimeEventCatalogue = normalizeRuntimeEventCatalogue(
    options.runtimeEventCatalogue,
  );
  const activePackIds = normalizeActivePackIds(options.activePackIds);
  const knownPacks = new Map<PackId, KnownPackEntry>();
  options.knownPacks?.forEach((packEntry) => {
    knownPacks.set(packEntry.id, packEntry);
  });

  return baseContentPackSchema
    .superRefine((pack, ctx) =>
      validateCrossReferences(pack, ctx, {
        allowlists,
        warningSink,
        runtimeEventCatalogue,
        runtimeVersion: options.runtimeVersion,
        activePackIds,
        knownPacks,
      }),
    )
    .transform((pack) =>
      normalizeContentPack(pack, {
        runtimeVersion: options.runtimeVersion,
        warningSink,
      }),
    );
};

export const createContentPackValidator = (
  options: ContentSchemaOptions = {},
): ContentPackValidator => ({
  parse(input: unknown): ContentPackValidationResult {
    const warnings: ContentSchemaWarning[] = [];
    const sink = (warning: ContentSchemaWarning) => {
      warnings.push(warning);
      options.warningSink?.(warning);
    };

    const schema = buildContentPackEffectsSchema(options, sink);
    const pack = schema.parse(input);

    const balanceOptions = options.balance ?? {};
    const balanceResult =
      balanceOptions.enabled === false
        ? { warnings: Object.freeze([] as ContentSchemaWarning[]), errors: Object.freeze([] as ContentSchemaWarning[]) }
        : validateContentPackBalance(pack, balanceOptions, options.warningSink);

    if (balanceResult.errors.length > 0 && balanceOptions.warnOnly !== true) {
      throw new BalanceValidationError('Balance validation failed.', balanceResult.errors);
    }

    return {
      pack,
      warnings,
      balanceWarnings: balanceResult.warnings,
      balanceErrors: balanceResult.errors,
    };
  },
  safeParse(input: unknown): ContentPackSafeParseResult {
    const warnings: ContentSchemaWarning[] = [];
    const sink = (warning: ContentSchemaWarning) => {
      warnings.push(warning);
      options.warningSink?.(warning);
    };
    const schema = buildContentPackEffectsSchema(options, sink);
    const result = schema.safeParse(input);
    if (result.success) {
      try {
        const balanceOptions = options.balance ?? {};
        const balanceResult =
          balanceOptions.enabled === false
            ? { warnings: Object.freeze([] as ContentSchemaWarning[]), errors: Object.freeze([] as ContentSchemaWarning[]) }
            : validateContentPackBalance(result.data, balanceOptions, options.warningSink);

        if (balanceResult.errors.length > 0 && balanceOptions.warnOnly !== true) {
          throw new BalanceValidationError('Balance validation failed.', balanceResult.errors);
        }

        return {
          success: true,
          data: {
            pack: result.data,
            warnings,
            balanceWarnings: balanceResult.warnings,
            balanceErrors: balanceResult.errors,
          },
        };
      } catch (error) {
        return { success: false, error };
      }
    }
    return { success: false, error: result.error };
  },
});

export const parseContentPack = (
  input: unknown,
  options?: ContentSchemaOptions,
): ContentPackValidationResult => createContentPackValidator(options).parse(input);
