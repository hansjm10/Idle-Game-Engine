import type {
  NormalizedContentPack,
  NormalizedGenerator,
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
type UpgradeOverrides = Record<string, unknown> & {
  readonly name?: string | NormalizedUpgrade['name'];
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
export function createTestMetadata(overrides?: Partial<NormalizedContentPack['metadata']>) {
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
  };
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
  generators?: NormalizedGenerator[];
  upgrades?: NormalizedUpgrade[];
  transforms?: NormalizedTransform[];
  prestigeLayers?: NormalizedPrestigeLayer[];
  metadata?: Record<string, unknown>;
  digest?: Record<string, unknown>;
}): NormalizedContentPack {
  const {
    resources = [],
    generators = [],
    upgrades = [],
    transforms = [],
    prestigeLayers = [],
    metadata = {},
    digest = {},
  } = config;

  // Build lookup maps
  const resourcesMap = new Map(resources.map((r) => [r.id, r]));
  const generatorsMap = new Map(generators.map((g) => [g.id, g]));
  const upgradesMap = new Map(upgrades.map((u) => [u.id, u]));
  const transformsMap = new Map(transforms.map((t) => [t.id, t]));
  const prestigeLayersMap = new Map(prestigeLayers.map((p) => [p.id, p]));

  // Build serialized lookup objects
  const resourceById = Object.fromEntries(resources.map((r) => [r.id, r]));
  const generatorById = Object.fromEntries(generators.map((g) => [g.id, g]));
  const upgradeById = Object.fromEntries(upgrades.map((u) => [u.id, u]));
  const transformById = Object.fromEntries(transforms.map((t) => [t.id, t]));
  const prestigeLayerById = Object.fromEntries(prestigeLayers.map((p) => [p.id, p]));

  return {
    metadata: createTestMetadata(
      metadata as Partial<NormalizedContentPack['metadata']>,
    ),
    resources,
    generators,
    upgrades,
    metrics: [],
    achievements: [],
    automations: [],
    transforms,
    prestigeLayers,
    guildPerks: [],
    runtimeEvents: [],
    lookup: {
      resources: resourcesMap,
      generators: generatorsMap,
      upgrades: upgradesMap,
      metrics: new Map(),
      achievements: new Map(),
      automations: new Map(),
      transforms: transformsMap,
      prestigeLayers: prestigeLayersMap,
      guildPerks: new Map(),
      runtimeEvents: new Map(),
    },
    serializedLookup: {
      resourceById,
      generatorById,
      upgradeById,
      metricById: {},
      achievementById: {},
      automationById: {},
      transformById,
      prestigeLayerById,
      guildPerkById: {},
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
