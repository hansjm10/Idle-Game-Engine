import type {
  NormalizedContentPack,
  NormalizedAutomation,
  NormalizedAchievement,
  NormalizedGenerator,
  NormalizedEntity,
  NormalizedPrestigeLayer,
  NormalizedResource,
  NormalizedTransform,
  NormalizedUpgrade,
  NumericFormula,
} from '@idle-engine/content-schema';

type LocalizedNameShape = NormalizedResource['name'];
type ResourceOverrides = Record<string, unknown> & {
  readonly name?: string | NormalizedResource['name'];
};
type GeneratorOverrides = Record<string, unknown> & {
  readonly name?: string | NormalizedGenerator['name'];
};
type EntityOverrides = Record<string, unknown> & {
  readonly name?: string | NormalizedEntity['name'];
  readonly description?: string | NormalizedEntity['description'];
  readonly stats?: NormalizedEntity['stats'];
};
type UpgradeOverrides = Record<string, unknown> & {
  readonly name?: string | NormalizedUpgrade['name'];
};
type AchievementOverrides = Record<string, unknown> & {
  readonly name?: string | NormalizedAchievement['name'];
  readonly description?: string | NormalizedAchievement['description'];
};
type PrestigeLayerOverrides = Record<string, unknown> & {
  readonly name?: string | NormalizedPrestigeLayer['name'];
  readonly summary?: string | NormalizedPrestigeLayer['summary'];
};

function ensureLocalizedName<T extends LocalizedNameShape>(
  value: string | T | undefined,
  fallback: string,
): T {
  if (typeof value === 'string') {
    return {
      default: value,
      variants: {},
    } as T;
  }
  if (value) {
    return value;
  }
  return {
    default: fallback,
    variants: {},
  } as T;
}
/**
 * Common numeric formula for test cases representing a constant value of 1
 */
export const literalOne: NumericFormula = { kind: 'constant', value: 1 };

/**
 * Creates base metadata for test content packs
 */
export function createTestMetadata(overrides?: Partial<NormalizedContentPack['metadata']>): NormalizedContentPack['metadata'] {
  return {
    id: 'pack.test',
    title: 'Test Pack',
    version: '1.0.0',
    engine: '>=0.0.0',
    authors: [],
    defaultLocale: 'en-US' as const,
    supportedLocales: ['en-US'] as const,
    tags: [],
    links: [],
    ...overrides,
  } as NormalizedContentPack['metadata'];
}

/**
 * Creates a test digest for content packs
 */
export function createTestDigest(overrides?: Partial<NormalizedContentPack['digest']>) {
  return {
    version: 'test',
    hash: 'test-hash',
    ...overrides,
  };
}

/**
 * Creates a complete NormalizedContentPack from individual components
 */
export function createContentPack(config: {
  resources?: NormalizedResource[];
  entities?: NormalizedEntity[];
  automations?: NormalizedAutomation[];
  achievements?: NormalizedAchievement[];
  transforms?: NormalizedTransform[];
  generators?: NormalizedGenerator[];
  upgrades?: NormalizedUpgrade[];
  prestigeLayers?: NormalizedPrestigeLayer[];
  metadata?: Record<string, unknown>;
  digest?: Record<string, unknown>;
}): NormalizedContentPack {
  const {
    resources = [],
    entities = [],
    automations = [],
    achievements = [],
    transforms = [],
    generators = [],
    upgrades = [],
    prestigeLayers = [],
    metadata = {},
    digest = {},
  } = config;

  // Build lookup maps
  const resourcesMap = new Map(resources.map((r) => [r.id, r]));
  const entitiesMap = new Map(entities.map((entity) => [entity.id, entity]));
  const automationsMap = new Map(automations.map((a) => [a.id, a]));
  const achievementsMap = new Map(achievements.map((a) => [a.id, a]));
  const transformsMap = new Map(transforms.map((t) => [t.id, t]));
  const generatorsMap = new Map(generators.map((g) => [g.id, g]));
  const upgradesMap = new Map(upgrades.map((u) => [u.id, u]));
  const prestigeLayersMap = new Map(prestigeLayers.map((p) => [p.id, p]));

  // Build serialized lookup objects
  const resourceById = Object.fromEntries(resources.map((r) => [r.id, r]));
  const entityById = Object.fromEntries(entities.map((entity) => [entity.id, entity]));
  const automationById = Object.fromEntries(automations.map((a) => [a.id, a]));
  const achievementById = Object.fromEntries(achievements.map((a) => [a.id, a]));
  const transformById = Object.fromEntries(transforms.map((t) => [t.id, t]));
  const generatorById = Object.fromEntries(generators.map((g) => [g.id, g]));
  const upgradeById = Object.fromEntries(upgrades.map((u) => [u.id, u]));
  const prestigeLayerById = Object.fromEntries(prestigeLayers.map((p) => [p.id, p]));

  return {
    metadata: createTestMetadata(
      metadata as Partial<NormalizedContentPack['metadata']>,
    ),
    resources,
    entities,
    generators,
    upgrades,
    metrics: [],
    achievements,
    automations,
    transforms,
    prestigeLayers,
    runtimeEvents: [],
    lookup: {
      resources: resourcesMap,
      entities: entitiesMap,
      generators: generatorsMap,
      upgrades: upgradesMap,
      metrics: new Map(),
      achievements: achievementsMap,
      automations: automationsMap,
      transforms: transformsMap,
      prestigeLayers: prestigeLayersMap,
      runtimeEvents: new Map(),
    },
    serializedLookup: {
      resourceById,
      entityById,
      generatorById,
      upgradeById,
      metricById: {},
      achievementById,
      automationById,
      transformById,
      prestigeLayerById,
      runtimeEventById: {},
    },
    digest: createTestDigest(
      digest as Partial<NormalizedContentPack['digest']>,
    ),
  } as unknown as NormalizedContentPack;
}

/**
 * Creates a basic resource definition for testing
 */
export function createResourceDefinition(
  id: string,
  overrides?: ResourceOverrides,
): NormalizedResource {
  const defaultName = id.split('.').pop() || id;
  const rawName = overrides?.name as
    | string
    | NormalizedResource['name']
    | undefined;
  const normalizedName = ensureLocalizedName<NormalizedResource['name']>(
    rawName,
    defaultName,
  );

  return {
    id,
    category: 'currency' as const,
    tier: 1,
    startAmount: 0,
    capacity: null,
    visible: true,
    unlocked: true,
    tags: [],
    ...overrides,
    name: normalizedName,
  } as unknown as NormalizedResource;
}

/**
 * Creates a basic generator definition for testing
 */
export function createGeneratorDefinition(
  id: string,
  overrides?: GeneratorOverrides,
): NormalizedGenerator {
  const defaultName = id.split('.').pop() || id;
  const rawName = overrides?.name as
    | string
    | NormalizedGenerator['name']
    | undefined;
  const normalizedName = ensureLocalizedName<NormalizedGenerator['name']>(
    rawName,
    defaultName,
  );

  return {
    id,
    category: 'production' as const,
    tags: [],
    purchase: {
      currencyId: 'resource.energy',
      costMultiplier: 10,
      costCurve: literalOne,
    },
    produces: [],
    consumes: [],
    baseUnlock: { kind: 'always' },
    initialLevel: 0,
    order: 1,
    effects: [],
    ...overrides,
    name: normalizedName,
  } as unknown as NormalizedGenerator;
}

/**
 * Creates a basic entity definition for testing
 */
export function createEntityDefinition(
  id: string,
  overrides?: EntityOverrides,
): NormalizedEntity {
  const defaultName = id.split('.').pop() || id;
  const rawName = overrides?.name as
    | string
    | NormalizedEntity['name']
    | undefined;
  const normalizedName = ensureLocalizedName<NormalizedEntity['name']>(
    rawName,
    defaultName,
  );
  const rawDescription = overrides?.description as
    | string
    | NormalizedEntity['description']
    | undefined;
  const normalizedDescription = ensureLocalizedName<NormalizedEntity['description']>(
    rawDescription,
    defaultName,
  );
  const stats =
    overrides?.stats ??
    ([
      {
        id: `${id}.stat`,
        name: normalizedName,
        baseValue: literalOne,
      },
    ] as unknown as NormalizedEntity['stats']);

  return {
    id,
    name: normalizedName,
    description: normalizedDescription,
    stats,
    startCount: 0,
    trackInstances: false,
    unlocked: false,
    visible: true,
    tags: [],
    ...overrides,
  } as unknown as NormalizedEntity;
}

/**
 * Creates a basic upgrade definition for testing
 */
export function createUpgradeDefinition(
  id: string,
  overrides?: UpgradeOverrides,
): NormalizedUpgrade {
  const defaultName = id.split('.').pop() || id;
  const rawName = overrides?.name as
    | string
    | NormalizedUpgrade['name']
    | undefined;
  const normalizedName = ensureLocalizedName<NormalizedUpgrade['name']>(
    rawName,
    defaultName,
  );

  return {
    id,
    category: 'global' as const,
    tags: [],
    targets: [{ kind: 'global' }],
    cost: {
      currencyId: 'resource.energy',
      costMultiplier: 100,
      costCurve: literalOne,
    },
    repeatable: undefined,
    prerequisites: [],
    effects: [],
    ...overrides,
    name: normalizedName,
  } as unknown as NormalizedUpgrade;
}

/**
 * Creates a basic achievement definition for testing
 */
export function createAchievementDefinition(
  id: string,
  overrides?: AchievementOverrides,
): NormalizedAchievement {
  const defaultName = id.split('.').pop() || id;
  const rawName = overrides?.name as
    | string
    | NormalizedAchievement['name']
    | undefined;
  const normalizedName = ensureLocalizedName<NormalizedAchievement['name']>(
    rawName,
    defaultName,
  );
  const rawDescription = overrides?.description as
    | string
    | NormalizedAchievement['description']
    | undefined;
  const normalizedDescription =
    ensureLocalizedName<NormalizedAchievement['description']>(
      rawDescription,
      '',
    );

  return {
    id,
    name: normalizedName,
    description: normalizedDescription,
    category: 'progression' as const,
    tier: 'bronze' as const,
    tags: [],
    track: {
      kind: 'resource' as const,
      resourceId: 'resource.energy',
      threshold: literalOne,
      comparator: 'gte' as const,
    },
    progress: {
      mode: 'oneShot' as const,
      target: literalOne,
    },
    onUnlockEvents: [],
    ...overrides,
  } as unknown as NormalizedAchievement;
}

/**
 * Creates a basic prestige layer definition for testing
 */
export function createPrestigeLayerDefinition(
  id: string,
  overrides?: PrestigeLayerOverrides,
): NormalizedPrestigeLayer {
  const defaultName = id.split('.').pop() || id;
  const rawName = overrides?.name as
    | string
    | NormalizedPrestigeLayer['name']
    | undefined;
  const normalizedName = ensureLocalizedName<NormalizedPrestigeLayer['name']>(
    rawName,
    defaultName,
  );
  const rawSummary = overrides?.summary as
    | string
    | NormalizedPrestigeLayer['summary']
    | undefined;
  const normalizedSummary = ensureLocalizedName<NormalizedPrestigeLayer['summary']>(
    rawSummary,
    '',
  );

  return {
    id,
    name: normalizedName,
    summary: normalizedSummary,
    resetTargets: ['resource.energy'],
    unlockCondition: { kind: 'always' },
    reward: {
      resourceId: 'resource.prestige',
      baseReward: literalOne,
    },
    retention: [],
    ...overrides,
  } as unknown as NormalizedPrestigeLayer;
}
