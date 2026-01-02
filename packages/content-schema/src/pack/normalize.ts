import {
  normalizeLocalizedText,
  type LocalizedSummary,
  type LocalizedText,
} from '../base/localization.js';
import {
  createContentPackDigest,
  freezeArray,
  freezeMap,
  freezeObject,
  freezeRecord,
} from '../runtime-helpers.js';
import type { ParsedContentPack } from './schema.js';
import type {
  NormalizationContext,
  NormalizedAchievement,
  NormalizedAutomation,
  NormalizedContentPack,
  NormalizedContentPackModules,
  NormalizedGenerator,
  NormalizedMetadata,
  NormalizedMetric,
  NormalizedPrestigeLayer,
  NormalizedResource,
  NormalizedRuntimeEventContribution,
  NormalizedTransform,
  NormalizedUpgrade,
} from './types.js';

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

export const normalizeContentPack = (
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
    pack.upgrades.map((upgrade, index) => {
      const normalizedDescription = normalizeOptional(
        upgrade.description,
        ['upgrades', index, 'description'],
      );
      return freezeObject({
        ...upgrade,
        name: normalize(upgrade.name, ['upgrades', index, 'name']),
        ...(normalizedDescription === undefined
          ? {}
          : { description: normalizedDescription }),
      }) as NormalizedUpgrade;
    }),
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
          summary: normalize(layer.summary, ['prestigeLayers', index, 'summary']),
        }) as NormalizedPrestigeLayer,
    ),
  );

  const normalizedRuntimeEvents = freezeArray(
    pack.runtimeEvents.map(
      (event) => freezeObject({ ...event }) as NormalizedRuntimeEventContribution,
    ),
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
