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
import type { ContentSchemaWarning } from './errors.js';
import { resolveFeatureViolations, type FeatureGateMap } from './runtime-compat.js';

type PackId = z.infer<typeof packSlugSchema>;
type UpgradeDefinition = Upgrade;
type UpgradeEffect = z.infer<typeof upgradeEffectSchema>;

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
}

type KnownPackEntry = NonNullable<ContentSchemaOptions['knownPacks']>[number];
type KnownPackDependency = {
  readonly packId: PackId;
  readonly version?: string;
};

export interface ContentPackValidationResult {
  readonly pack: NormalizedContentPack;
  readonly warnings: readonly ContentSchemaWarning[];
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

export interface NormalizedContentPack extends ParsedContentPack {
  readonly lookup: {
    readonly resources: ReadonlyMap<string, Resource>;
    readonly generators: ReadonlyMap<string, Generator>;
    readonly upgrades: ReadonlyMap<string, UpgradeDefinition>;
    readonly metrics: ReadonlyMap<string, MetricDefinition>;
    readonly achievements: ReadonlyMap<string, AchievementDefinition>;
    readonly automations: ReadonlyMap<string, AutomationDefinition>;
    readonly transforms: ReadonlyMap<string, TransformDefinition>;
    readonly prestigeLayers: ReadonlyMap<string, PrestigeLayerDefinition>;
    readonly guildPerks: ReadonlyMap<string, GuildPerkDefinition>;
    readonly runtimeEvents: ReadonlyMap<string, RuntimeEventContribution>;
  };
  readonly serializedLookup: {
    readonly resourceById: Readonly<Record<string, Resource>>;
    readonly generatorById: Readonly<Record<string, Generator>>;
    readonly upgradeById: Readonly<Record<string, UpgradeDefinition>>;
    readonly metricById: Readonly<Record<string, MetricDefinition>>;
    readonly achievementById: Readonly<Record<string, AchievementDefinition>>;
    readonly automationById: Readonly<Record<string, AutomationDefinition>>;
    readonly transformById: Readonly<Record<string, TransformDefinition>>;
    readonly prestigeLayerById: Readonly<Record<string, PrestigeLayerDefinition>>;
    readonly guildPerkById: Readonly<Record<string, GuildPerkDefinition>>;
    readonly runtimeEventById: Readonly<Record<string, RuntimeEventContribution>>;
  };
  readonly digest: {
    readonly version: number;
    readonly hash: string;
  };
}

const CONTENT_PACK_DIGEST_VERSION = 1;

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

type ContentPackInput = z.input<typeof baseContentPackSchema>;

export interface ContentPackSafeParseSuccess {
  readonly success: true;
  readonly data: ContentPackValidationResult;
}

export interface ContentPackSafeParseFailure {
  readonly success: false;
  readonly error: z.ZodError<ContentPackInput>;
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

const freezeMap = <Value extends { readonly id: string }>(
  values: readonly Value[],
): ReadonlyMap<string, Value> =>
  Object.freeze(
    new Map(values.map((value) => [value.id, value] as const)),
  );

const freezeRecord = <Value extends { readonly id: string }>(
  values: readonly Value[],
): Readonly<Record<string, Value>> =>
  Object.freeze(
    Object.fromEntries(values.map((value) => [value.id, value] as const)),
  );

const fnv1a = (input: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
    hash >>>= 0;
  }
  return hash >>> 0;
};

const computeDigest = (pack: ParsedContentPack) => {
  const digestPayload = {
    id: pack.metadata.id,
    version: pack.metadata.version,
    modules: {
      resources: pack.resources.map((resource) => resource.id),
      generators: pack.generators.map((generator) => generator.id),
      upgrades: pack.upgrades.map((upgrade) => upgrade.id),
      metrics: pack.metrics.map((metric) => metric.id),
      achievements: pack.achievements.map((achievement) => achievement.id),
      automations: pack.automations.map((automation) => automation.id),
      transforms: pack.transforms.map((transform) => transform.id),
      prestigeLayers: pack.prestigeLayers.map((layer) => layer.id),
      guildPerks: pack.guildPerks.map((perk) => perk.id),
      runtimeEvents: pack.runtimeEvents.map((event) => event.id),
    },
  };
  const serialized = JSON.stringify(digestPayload);
  const hash = fnv1a(serialized);
  return {
    version: CONTENT_PACK_DIGEST_VERSION,
    hash: `fnv1a-${hash.toString(16).padStart(8, '0')}`,
  };
};

const normalizeContentPack = (
  pack: ParsedContentPack,
): NormalizedContentPack => {
  const lookup = {
    resources: freezeMap(pack.resources),
    generators: freezeMap(pack.generators),
    upgrades: freezeMap(pack.upgrades),
    metrics: freezeMap(pack.metrics),
    achievements: freezeMap(pack.achievements),
    automations: freezeMap(pack.automations),
    transforms: freezeMap(pack.transforms),
    prestigeLayers: freezeMap(pack.prestigeLayers),
    guildPerks: freezeMap(pack.guildPerks),
    runtimeEvents: freezeMap(pack.runtimeEvents),
  } as const;

  const serializedLookup = {
    resourceById: freezeRecord(pack.resources),
    generatorById: freezeRecord(pack.generators),
    upgradeById: freezeRecord(pack.upgrades),
    metricById: freezeRecord(pack.metrics),
    achievementById: freezeRecord(pack.achievements),
    automationById: freezeRecord(pack.automations),
    transformById: freezeRecord(pack.transforms),
    prestigeLayerById: freezeRecord(pack.prestigeLayers),
    guildPerkById: freezeRecord(pack.guildPerks),
    runtimeEventById: freezeRecord(pack.runtimeEvents),
  } as const;

  return Object.freeze({
    ...pack,
    lookup,
    serializedLookup,
    digest: computeDigest(pack),
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
    if (automation.targetType === 'generator') {
      if (automation.targetId) {
        ensureContentReference(
          generatorIndex,
          automation.targetId,
          ['automations', index, 'targetId'],
          `Automation "${automation.id}" references unknown generator "${automation.targetId}".`,
        );
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

const buildContentPackEffectsSchema = (
  options: ContentSchemaOptions,
  warningSink: (warning: ContentSchemaWarning) => void,
) => {
  const allowlists = options.allowlists
    ? {
        flags: normalizeAllowlistSpec(
          options.allowlists.flags,
          flagIdSchema,
          warningSink,
          ['options', 'allowlists', 'flags'],
        ),
        scripts: normalizeAllowlistSpec(
          options.allowlists.scripts,
          scriptIdSchema,
          warningSink,
          ['options', 'allowlists', 'scripts'],
        ),
        systemAutomationTargets: normalizeAllowlistSpec(
          options.allowlists.systemAutomationTargets,
          systemAutomationTargetIdSchema,
          warningSink,
          ['options', 'allowlists', 'systemAutomationTargets'],
        ),
      }
    : {};

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
    .transform((pack) => normalizeContentPack(pack));
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

    return { pack, warnings };
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
      return {
        success: true,
        data: {
          pack: result.data,
          warnings,
        },
      };
    }
    return { success: false, error: result.error };
  },
});

export const parseContentPack = (
  input: unknown,
  options?: ContentSchemaOptions,
): ContentPackValidationResult => createContentPackValidator(options).parse(input);
