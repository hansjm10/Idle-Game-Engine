import type {
  NormalizedContentPack,
  NormalizedGenerator,
  NormalizedResource,
  NormalizedUpgrade,
  NumericFormula,
} from '@idle-engine/content-schema';

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
  metadata?: Partial<NormalizedContentPack['metadata']>;
  digest?: Partial<NormalizedContentPack['digest']>;
}): NormalizedContentPack {
  const {
    resources = [],
    generators = [],
    upgrades = [],
    metadata = {},
    digest = {},
  } = config;

  // Build lookup maps
  const resourcesMap = new Map(resources.map((r) => [r.id, r]));
  const generatorsMap = new Map(generators.map((g) => [g.id, g]));
  const upgradesMap = new Map(upgrades.map((u) => [u.id, u]));

  // Build serialized lookup objects
  const resourceById = Object.fromEntries(resources.map((r) => [r.id, r]));
  const generatorById = Object.fromEntries(generators.map((g) => [g.id, g]));
  const upgradeById = Object.fromEntries(upgrades.map((u) => [u.id, u]));

  return {
    metadata: createTestMetadata(metadata),
    resources,
    generators,
    upgrades,
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    guildPerks: [],
    runtimeEvents: [],
    lookup: {
      resources: resourcesMap,
      generators: generatorsMap,
      upgrades: upgradesMap,
      metrics: new Map(),
      achievements: new Map(),
      automations: new Map(),
      transforms: new Map(),
      prestigeLayers: new Map(),
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
      transformById: {},
      prestigeLayerById: {},
      guildPerkById: {},
      runtimeEventById: {},
    },
    digest: createTestDigest(digest),
  } as unknown as NormalizedContentPack;
}

/**
 * Creates a basic resource definition for testing
 */
export function createResourceDefinition(
  id: string,
  overrides?: Partial<NormalizedResource>,
): NormalizedResource {
  return {
    id,
    name: id.split('.').pop() || id,
    category: 'currency' as const,
    tier: 1,
    startAmount: 0,
    capacity: null,
    visible: true,
    unlocked: true,
    tags: [],
    ...overrides,
  } as unknown as NormalizedResource;
}

/**
 * Creates a basic generator definition for testing
 */
export function createGeneratorDefinition(
  id: string,
  overrides?: Partial<NormalizedGenerator>,
): NormalizedGenerator {
  return {
    id,
    name: id.split('.').pop() || id,
    category: 'production' as const,
    tags: [],
    purchase: {
      currencyId: 'resource.energy',
      baseCost: 10,
      costCurve: literalOne,
    },
    produces: [],
    consumes: [],
    baseUnlock: { kind: 'always' },
    order: 1,
    effects: [],
    ...overrides,
  } as unknown as NormalizedGenerator;
}

/**
 * Creates a basic upgrade definition for testing
 */
export function createUpgradeDefinition(
  id: string,
  overrides?: Partial<NormalizedUpgrade>,
): NormalizedUpgrade {
  return {
    id,
    name: id.split('.').pop() || id,
    category: 'global' as const,
    tags: [],
    targets: [{ kind: 'global' }],
    cost: {
      currencyId: 'resource.energy',
      baseCost: 100,
      costCurve: literalOne,
    },
    repeatable: undefined,
    prerequisites: [],
    effects: [],
    ...overrides,
  } as unknown as NormalizedUpgrade;
}
