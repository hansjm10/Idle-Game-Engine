/**
 * Comprehensive integration fixtures for testing content pack validation,
 * normalization, and error handling across all scenarios outlined in
 * docs/content-dsl-schema-design.md §6.
 */

const baseTitle = {
  default: 'Test Pack',
  variants: {},
} as const;

/**
 * SUCCESS CASE: Valid pack with comprehensive module coverage
 */
export const validComprehensivePackFixture = {
  metadata: {
    id: 'comprehensive-test',
    title: {
      default: 'Comprehensive Test Pack',
      variants: {
        'fr-FR': 'Pack de Test Complet',
        'es-ES': 'Paquete de Prueba Integral',
      },
    },
    summary: {
      default: 'A complete pack covering all modules',
      variants: {
        'fr-FR': 'Un pack complet couvrant tous les modules',
      },
    },
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US', 'fr-FR', 'es-ES'],
    authors: ['Test Author', 'Another Author'],
    tags: ['test', 'comprehensive'],
    dependencies: {
      requires: [{ packId: '@idle-engine/core', version: '^1.0.0' }],
      optional: [{ packId: 'optional-pack', version: '^1.0.0' }],
    },
  },
  resources: [
    {
      id: 'energy',
      name: {
        default: 'Energy',
        variants: {
          'fr-FR': 'Énergie',
          'es-ES': 'Energía',
        },
      },
      category: 'primary' as const,
      tier: 1,
      startAmount: 10,
      capacity: 1000,
      visible: true,
      unlocked: true,
      order: 1,
    },
    {
      id: 'crystals',
      name: {
        default: 'Crystals',
        variants: {
          'fr-FR': 'Cristaux',
          'es-ES': 'Cristales',
        },
      },
      category: 'prestige' as const,
      tier: 2,
      unlockCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'energy',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 100 },
      },
      order: 2,
    },
  ],
  entities: [
    {
      id: 'scout',
      name: {
        default: 'Scout',
        variants: {},
      },
      description: {
        default: 'Fast reconnaissance unit',
        variants: {},
      },
      stats: [
        {
          id: 'speed',
          name: { default: 'Speed', variants: {} },
          baseValue: { kind: 'constant', value: 10 },
        },
        {
          id: 'perception',
          name: { default: 'Perception', variants: {} },
          baseValue: { kind: 'constant', value: 8 },
        },
      ],
      maxCount: { kind: 'constant', value: 10 },
      startCount: 1,
      trackInstances: false,
      progression: {
        experienceResource: 'energy',
        levelFormula: { kind: 'linear', base: 100, slope: 25 },
        maxLevel: 50,
        statGrowth: {
          speed: { kind: 'constant', value: 1 },
          perception: { kind: 'constant', value: 0.5 },
        },
      },
      unlockCondition: {
        kind: 'resourceThreshold',
        resourceId: 'energy',
        comparator: 'gte',
        amount: { kind: 'constant', value: 100 },
      },
      tags: ['recon'],
    },
  ],
  generators: [
    {
      id: 'solar-panel',
      name: {
        default: 'Solar Panel',
        variants: {
          'fr-FR': 'Panneau Solaire',
        },
      },
      produces: [
        {
          resourceId: 'energy',
          rate: {
            kind: 'linear' as const,
            base: 1,
            slope: 0.5,
          },
        },
      ],
      consumes: [],
      purchase: {
        currencyId: 'energy',
        costMultiplier: 10,
        costCurve: {
          kind: 'exponential' as const,
          base: 10,
          growth: 1.15,
          offset: 0,
        },
      },
      baseUnlock: { kind: 'always' as const },
      order: 1,
    },
  ],
  upgrades: [
    {
      id: 'efficiency-boost',
      name: {
        default: 'Efficiency Boost',
        variants: {
          'fr-FR': 'Amélioration d\'Efficacité',
        },
      },
      category: 'global' as const,
      targets: [{ kind: 'global' as const }],
      cost: {
        currencyId: 'energy',
        costMultiplier: 50,
        costCurve: { kind: 'constant', value: 50 },
      },
      effects: [
        {
          kind: 'modifyGeneratorRate' as const,
          generatorId: 'solar-panel',
          operation: 'multiply' as const,
          value: { kind: 'constant', value: 1.5 },
        },
      ],
      unlockCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'energy',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 50 },
      },
    },
  ],
  metrics: [
    {
      id: 'total-energy-produced',
      name: {
        default: 'Total Energy Produced',
        variants: {
          'fr-FR': 'Énergie Totale Produite',
        },
      },
      description: {
        default: 'Cumulative energy produced across all time',
        variants: {},
      },
      kind: 'counter' as const,
      unit: 'units',
      source: { kind: 'runtime' as const },
    },
  ],
  achievements: [
    {
      id: 'first-energy',
      name: {
        default: 'First Energy',
        variants: {
          'fr-FR': 'Première Énergie',
        },
      },
      description: {
        default: 'Produce your first unit of energy',
        variants: {
          'fr-FR': 'Produisez votre première unité d\'énergie',
        },
      },
      category: 'progression' as const,
      tier: 'bronze' as const,
      track: {
        kind: 'resource' as const,
        resourceId: 'energy',
        threshold: { kind: 'constant', value: 1 },
        comparator: 'gte' as const,
      },
      progress: {
        mode: 'oneShot' as const,
      },
    },
  ],
  automations: [],
  transforms: [],
  prestigeLayers: [],
  runtimeEvents: [],
};

/**
 * MISSING REFERENCES: Generator produces non-existent resource
 */
export const missingResourceReferenceFixture = {
  metadata: {
    id: 'missing-ref-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [
    {
      id: 'broken-generator',
      name: baseTitle,
      produces: [
        {
          resourceId: 'non-existent-resource',
          rate: { kind: 'constant', value: 1 },
        },
      ],
      consumes: [],
      purchase: {
        currencyId: 'energy',
        costMultiplier: 10,
        costCurve: { kind: 'constant', value: 10 },
      },
      baseUnlock: { kind: 'always' as const },
    },
  ],
  upgrades: [],
};

/**
 * CYCLIC UNLOCK CONDITIONS: Resource A unlocks Resource B which unlocks Resource A
 */
export const cyclicUnlockConditionsFixture = {
  metadata: {
    id: 'cyclic-unlock-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-a',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
      unlockCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'resource-b',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 10 },
      },
    },
    {
      id: 'resource-b',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
      unlockCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'resource-a',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 10 },
      },
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * CYCLIC UNLOCK CONDITIONS - CROSS-ENTITY-TYPE
 * Resource unlocks via generator threshold, generator unlocks via resource threshold
 */
export const cyclicUnlockCrossEntityFixture = {
  metadata: {
    id: 'cyclic-unlock-cross-entity',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
      unlockCondition: {
        kind: 'generatorLevel' as const,
        generatorId: 'solar-panel',
        comparator: 'gte' as const,
        level: { kind: 'constant', value: 1 },
      },
    },
  ],
  generators: [
    {
      id: 'solar-panel',
      name: baseTitle,
      produces: [
        {
          resourceId: 'energy',
          rate: { kind: 'constant', value: 1 },
        },
      ],
      purchase: {
        currencyId: 'energy',
        costMultiplier: 10,
        costCurve: {
          kind: 'exponential' as const,
          base: 10,
          growth: 1.15,
          offset: 0,
        },
      },
      baseUnlock: {
        kind: 'resourceThreshold' as const,
        resourceId: 'energy',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 50 },
      },
    },
  ],
  upgrades: [],
};

/**
 * SELF-THRESHOLD UNLOCK CONDITIONS: Resource unlocks itself after first production.
 * This should not be treated as an unlock dependency cycle.
 */
export const selfThresholdUnlockConditionsFixture = {
  metadata: {
    id: 'self-threshold-unlock-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'hidden-ore',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
      visible: false,
      unlocked: false,
      unlockCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'hidden-ore',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 1 },
      },
      visibilityCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'hidden-ore',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 1 },
      },
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * ANYOF UNLOCK CONDITIONS: Alternative branch should not register dependency edges.
 */
export const anyOfUnlockBreaksCycleFixture = {
  metadata: {
    id: 'anyof-unlock-breaks-cycle-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-a',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
      unlockCondition: {
        kind: 'anyOf' as const,
        conditions: [
          { kind: 'flag' as const, flagId: 'debug' },
          {
            kind: 'resourceThreshold' as const,
            resourceId: 'resource-b',
            comparator: 'gte' as const,
            amount: { kind: 'constant', value: 1 },
          },
        ],
      },
    },
    {
      id: 'resource-b',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
      unlockCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'resource-a',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 1 },
      },
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * LOCALIZATION GAPS: Missing translations for declared supported locales
 */
export const localizationGapsFixture = {
  metadata: {
    id: 'localization-gap-pack',
    title: {
      default: 'Localization Test',
      variants: {
        'fr-FR': 'Test de Localisation',
        // Missing 'es-ES' variant
      },
    },
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US', 'fr-FR', 'es-ES'], // Claims to support es-ES
  },
  resources: [
    {
      id: 'energy',
      name: {
        default: 'Energy',
        variants: {
          'fr-FR': 'Énergie',
          // Missing 'es-ES' variant
        },
      },
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'crystals',
      name: {
        default: 'Crystals',
        variants: {
          // Missing both 'fr-FR' and 'es-ES' variants
        },
      },
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * DEPENDENCY LOOPS: Pack declares dependency cycle
 */
export const dependencyLoopFixture = {
  metadata: {
    id: 'pack-a',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
    dependencies: {
      requires: [
        { packId: 'pack-b', version: '^1.0.0' },
      ],
    },
  },
  resources: [],
  generators: [],
  upgrades: [],
};

// Companion pack for dependency loop testing
export const dependencyLoopFixturePackB = {
  metadata: {
    id: 'pack-b',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
    dependencies: {
      requires: [
        { packId: 'pack-a', version: '^1.0.0' },
      ],
    },
  },
  resources: [],
  generators: [],
  upgrades: [],
};

/**
 * SELF-REFERENCING DEPENDENCY: Pack depends on itself
 */
export const selfReferencingDependencyFixture = {
  metadata: {
    id: 'self-ref-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
    dependencies: {
      requires: [
        { packId: 'self-ref-pack', version: '^1.0.0' },
      ],
    },
  },
  resources: [],
  generators: [],
  upgrades: [],
};

/**
 * INVALID RUNTIME EVENT CONTRIBUTIONS: Missing schema path, duplicate IDs
 */
export const invalidRuntimeEventContributionsFixture = {
  metadata: {
    id: 'invalid-events-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [],
  generators: [],
  upgrades: [],
  runtimeEvents: [
    {
      namespace: 'test',
      name: 'custom-event',
      version: 1,
      payload: {
        kind: 'zod' as const,
        schemaPath: '../../../outside-pack/malicious.ts', // Invalid: parent directory escape
      },
    },
    {
      namespace: 'test',
      name: 'duplicate-event',
      version: 1,
      payload: {
        kind: 'zod' as const,
        schemaPath: './schemas/event-a.ts',
      },
    },
    {
      namespace: 'test',
      name: 'duplicate-event', // Duplicate name in same namespace
      version: 2,
      payload: {
        kind: 'zod' as const,
        schemaPath: './schemas/event-b.ts',
      },
    },
  ],
};

/**
 * INVALID FORMULA REFERENCES: Formula references non-existent entities
 */
export const invalidFormulaReferencesFixture = {
  metadata: {
    id: 'invalid-formula-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [
    {
      id: 'generator',
      name: baseTitle,
      produces: [
        {
          resourceId: 'energy',
          rate: {
            kind: 'expression' as const,
            expression: {
              kind: 'ref' as const,
              target: {
                type: 'resource' as const,
                id: 'non-existent-resource', // Invalid reference
              },
            },
          },
        },
      ],
      consumes: [],
      purchase: {
        currencyId: 'energy',
        costMultiplier: 10,
        costCurve: { kind: 'constant', value: 10 },
      },
      baseUnlock: { kind: 'always' as const },
    },
  ],
  upgrades: [],
};

/**
 * INVALID ENTITY FORMULA REFERENCES: Entity formulas reference unknown resources
 */
export const invalidEntityFormulaReferencesFixture = {
  metadata: {
    id: 'invalid-entity-formula',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  entities: [
    {
      id: 'scout',
      name: baseTitle,
      description: baseTitle,
      stats: [
        {
          id: 'speed',
          name: baseTitle,
          baseValue: {
            kind: 'expression' as const,
            expression: {
              kind: 'ref' as const,
              target: {
                type: 'resource' as const,
                id: 'missing-formula-resource',
              },
            },
          },
        },
      ],
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * INVALID ENTITY REFERENCES: Entity progression references unknown resource
 */
export const invalidEntityExperienceFixture = {
  metadata: {
    id: 'invalid-entity-experience',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  entities: [
    {
      id: 'scout',
      name: baseTitle,
      description: baseTitle,
      stats: [
        {
          id: 'speed',
          name: baseTitle,
          baseValue: { kind: 'constant', value: 1 },
        },
      ],
      progression: {
        experienceResource: 'missing-resource',
        levelFormula: { kind: 'constant', value: 10 },
      },
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * FEATURE GATE VIOLATIONS: Pack uses modules not supported by target runtime
 */
export const featureGateViolationFixture = {
  metadata: {
    id: 'feature-gate-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^0.1.0', // Targets old runtime
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  automations: [
    // Automations require >=0.2.0 per FEATURE_GATES
    {
      id: 'auto-generate',
      name: baseTitle,
      description: baseTitle,
      targetType: 'system' as const,
      systemTargetId: 'offline-catchup',
      trigger: {
        kind: 'interval' as const,
        interval: { kind: 'constant', value: 1000 },
      },
      unlockCondition: { kind: 'always' as const },
    },
  ],
  transforms: [],
  prestigeLayers: [],
};

/**
 * DUPLICATE IDS: Multiple resources with same ID
 */
export const duplicateResourceIdsFixture = {
  metadata: {
    id: 'duplicate-ids-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'energy', // Duplicate ID
      name: { default: 'Energy 2', variants: {} },
      category: 'primary' as const,
      tier: 2,
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * MISSING METRIC REFERENCE: Achievement tracks non-existent custom metric
 */
export const missingMetricReferenceFixture = {
  metadata: {
    id: 'missing-metric-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [],
  generators: [],
  upgrades: [],
  metrics: [
    {
      id: 'clicks',
      name: baseTitle,
      kind: 'counter' as const,
      source: { kind: 'runtime' as const },
    },
  ],
  achievements: [
    {
      id: 'clicker',
      name: baseTitle,
      description: baseTitle,
      category: 'progression' as const,
      tier: 'bronze' as const,
      track: {
        kind: 'custom-metric' as const,
        metricId: 'non-existent-metric', // Invalid metric reference
        threshold: { kind: 'constant', value: 100 },
      },
      progress: {
        mode: 'oneShot' as const,
      },
    },
  ],
};

/**
 * INVALID ALLOWLIST REFERENCES: Condition references flag/script not in allowlist
 */
export const invalidAllowlistReferenceFixture = {
  metadata: {
    id: 'invalid-allowlist-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'energy',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
      unlockCondition: {
        kind: 'flag' as const,
        flagId: 'undefined-flag', // Not in allowlist
      },
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * RUNTIME EVENT CATALOG COLLISION: Pack event collides with core event
 */
export const runtimeEventCollisionFixture = {
  metadata: {
    id: 'event-collision-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [],
  generators: [],
  upgrades: [],
  runtimeEvents: [
    {
      namespace: 'idle-engine-core',
      name: 'resource-updated', // Collides with core event
      version: 1,
      payload: {
        kind: 'zod' as const,
        schemaPath: './schemas/resource-updated.ts',
      },
    },
  ],
};

/**
 * CYCLIC TRANSFORM CHAINS - DIRECT: Transform A → Transform B → Transform A
 * Transform A consumes X, produces Y
 * Transform B consumes Y, produces X
 */
export const cyclicTransformDirectFixture = {
  metadata: {
    id: 'cyclic-transform-direct',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 120 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 110 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * DIRECT TRANSFORM CHAIN - NET LOSS: Transform A → Transform B → Transform A
 * Transform A consumes X, produces Y
 * Transform B consumes Y, produces X
 */
export const netLossTransformCycleFixture = {
  metadata: {
    id: 'net-loss-transform-cycle',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 80 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 90 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * DIRECT TRANSFORM CHAIN - NEUTRAL: Transform A → Transform B → Transform A
 * Overall cycle ratio = 1.0 (exactly neutral, should be allowed)
 * Transform A: 100 X → 100 Y (ratio 1.0)
 * Transform B: 100 Y → 100 X (ratio 1.0)
 */
export const neutralTransformCycleFixture = {
  metadata: {
    id: 'neutral-transform-cycle',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * INDIRECT TRANSFORM CHAIN - NET LOSS: Transform A → Transform B → Transform C → Transform A
 * Overall cycle ratio = 0.9 * 0.9 * 0.9 = 0.729 (net loss, should be allowed)
 * Transform A: 100 X → 90 Y (ratio 0.9)
 * Transform B: 100 Y → 90 Z (ratio 0.9)
 * Transform C: 100 Z → 90 X (ratio 0.9)
 */
export const netLossIndirectTransformCycleFixture = {
  metadata: {
    id: 'net-loss-indirect-transform-cycle',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-z',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 90 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 90 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-c',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 90 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * NON-SIMPLE TRANSFORM IN CYCLE: Transform with multiple inputs in a cycle
 * Should be rejected because cycle profitability cannot be evaluated
 */
export const nonSimpleTransformCycleFixture = {
  metadata: {
    id: 'non-simple-transform-cycle',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-catalyst',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100 },
        },
        {
          resourceId: 'resource-catalyst',
          amount: { kind: 'constant', value: 10 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 80 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 90 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * EPSILON BOUNDARY TEST - BELOW THRESHOLD: Cycle ratio just below PROFIT_EPSILON (1e-8).
 * Ratio = 1.000000001 (1e-9 above 1.0) which is below the 1e-8 threshold.
 * Should be ALLOWED.
 */
export const epsilonBelowThresholdCycleFixture = {
  metadata: {
    id: 'epsilon-below-threshold-cycle',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          // Using large numbers to achieve precise ratio
          amount: { kind: 'constant', value: 1000000000 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          // Ratio = 1.000000001 (1e-9 above 1.0)
          amount: { kind: 'constant', value: 1000000001 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 1000000000 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          // Ratio = 1.0
          amount: { kind: 'constant', value: 1000000000 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * EPSILON BOUNDARY TEST - ABOVE THRESHOLD: Cycle ratio just above PROFIT_EPSILON (1e-8).
 * Ratio = 1.00000002 (2e-8 above 1.0) which is above the 1e-8 threshold.
 * Should be REJECTED.
 */
export const epsilonAboveThresholdCycleFixture = {
  metadata: {
    id: 'epsilon-above-threshold-cycle',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100000000 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          // Ratio = 1.00000002 (2e-8 above 1.0)
          amount: { kind: 'constant', value: 100000002 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100000000 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          // Ratio = 1.0
          amount: { kind: 'constant', value: 100000000 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * NON-CONSTANT FORMULA IN CYCLE: Transform with linear formula in a cycle.
 * Should be rejected because cycle profitability cannot be evaluated for non-constant formulas.
 */
export const nonConstantFormulaCycleFixture = {
  metadata: {
    id: 'non-constant-formula-cycle',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          // Linear formula instead of constant - profitability cannot be evaluated
          amount: { kind: 'linear', base: 80, slope: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 90 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * CYCLIC TRANSFORM CHAINS - INDIRECT: Transform A → Transform B → Transform C → Transform A
 * Transform A consumes X, produces Y
 * Transform B consumes Y, produces Z
 * Transform C consumes Z, produces X
 */
export const cyclicTransformIndirectFixture = {
  metadata: {
    id: 'cyclic-transform-indirect',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-z',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 110 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 110 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-c',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 110 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * CYCLIC TRANSFORM CHAINS - MULTI-RESOURCE
 * Transform A consumes X + Y, produces Z
 * Transform B consumes Z, produces X
 * Transform C consumes Z, produces Y
 */
export const cyclicTransformMultiResourceFixture = {
  metadata: {
    id: 'cyclic-transform-multi',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-z',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 1 },
        },
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-c',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * NON-CYCLIC TRANSFORM CHAIN - LINEAR: Transform A → Transform B → Transform C
 * Transform A consumes X, produces Y
 * Transform B consumes Y, produces Z
 * Transform C consumes Z, produces W
 * This is a valid non-cyclic chain.
 */
export const linearTransformChainFixture = {
  metadata: {
    id: 'linear-transform-chain',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-z',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-w',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-c',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-w',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * NON-CYCLIC TRANSFORM CHAIN - CONVERGENT TREE
 * Transform A consumes X, produces Z
 * Transform B consumes Y, produces Z
 * Transform C consumes Z, produces W
 * Multiple streams converge but never loop back.
 */
export const convergentTransformTreeFixture = {
  metadata: {
    id: 'convergent-transform-tree',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-z',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-w',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-c',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-z',
          amount: { kind: 'constant', value: 2 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-w',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * NON-CYCLIC TRANSFORM CHAIN - RESOURCE SINK
 * Transforms consume resources but don't regenerate them.
 * This creates a one-way flow with no cycles.
 */
export const resourceSinkTransformFixture = {
  metadata: {
    id: 'resource-sink-transform',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'mana',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'essence',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'boost-item',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'craft-boost',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'mana',
          amount: { kind: 'constant', value: 100 },
        },
        {
          resourceId: 'essence',
          amount: { kind: 'constant', value: 10 },
        },
      ],
      outputs: [
        {
          resourceId: 'boost-item',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * EDGE CASE - SELF-REFERENCING TRANSFORM
 * Transform A consumes X and produces X
 * This creates a self-loop.
 */
export const selfReferencingTransformFixture = {
  metadata: {
    id: 'self-referencing-transform',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 1 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 0.8 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * ZERO-AMOUNT TRANSFORM IN CYCLE: Transform with zero input amount.
 * Should be treated as non-simple (profitability cannot be evaluated) and rejected if in a cycle.
 */
export const zeroAmountTransformCycleFixture = {
  metadata: {
    id: 'zero-amount-transform-cycle',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    {
      id: 'transform-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          // Zero amount - should be treated as non-simple
          amount: { kind: 'constant', value: 0 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 80 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 90 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * DISJOINT CYCLES: Two independent cycles in the same pack.
 * One net-positive (X<->Y) and one net-loss (A<->B).
 * Should be rejected because of the net-positive cycle.
 */
export const disjointCyclesFixture = {
  metadata: {
    id: 'disjoint-cycles',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-a',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-b',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    // Net-positive cycle: X <-> Y (ratio = 1.2 * 1.1 = 1.32)
    {
      id: 'transform-x-to-y',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 120 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-y-to-x',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 110 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    // Net-loss cycle: A <-> B (ratio = 0.8 * 0.9 = 0.72)
    {
      id: 'transform-a-to-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-a',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-b',
          amount: { kind: 'constant', value: 80 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b-to-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-b',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-a',
          amount: { kind: 'constant', value: 90 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * DISJOINT CYCLES - ALL NET LOSS: Two independent net-loss cycles.
 * Both should be allowed since neither is net-positive.
 */
export const disjointNetLossCyclesFixture = {
  metadata: {
    id: 'disjoint-net-loss-cycles',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource-x',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-y',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-a',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
    {
      id: 'resource-b',
      name: baseTitle,
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [],
  upgrades: [],
  transforms: [
    // Net-loss cycle 1: X <-> Y (ratio = 0.8 * 0.9 = 0.72)
    {
      id: 'transform-x-to-y',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 80 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-y-to-x',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-y',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-x',
          amount: { kind: 'constant', value: 90 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    // Net-loss cycle 2: A <-> B (ratio = 0.7 * 0.85 = 0.595)
    {
      id: 'transform-a-to-b',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-a',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-b',
          amount: { kind: 'constant', value: 70 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
    {
      id: 'transform-b-to-a',
      name: baseTitle,
      description: baseTitle,
      inputs: [
        {
          resourceId: 'resource-b',
          amount: { kind: 'constant', value: 100 },
        },
      ],
      outputs: [
        {
          resourceId: 'resource-a',
          amount: { kind: 'constant', value: 85 },
        },
      ],
      trigger: { kind: 'manual' as const },
      mode: 'instant' as const,
    },
  ],
};

/**
 * PRESTIGE LAYER: Pack with prestige layer but missing the required prestige count resource.
 * Should fail validation with a clear error message.
 */
export const missingPrestigeCountResourceFixture = {
  metadata: {
    id: 'prestige-test-pack',
    title: baseTitle,
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'prestige-test-pack.energy',
      name: { default: 'Energy', variants: {} },
      category: 'primary' as const,
      tier: 1,
      startAmount: 100,
    },
    {
      id: 'prestige-test-pack.prestige-points',
      name: { default: 'Prestige Points', variants: {} },
      category: 'prestige' as const,
      tier: 2,
    },
    // Note: Missing 'prestige-test-pack.ascension-prestige-count' resource
  ],
  generators: [],
  upgrades: [],
  prestigeLayers: [
    {
      id: 'prestige-test-pack.ascension',
      name: { default: 'Ascension', variants: {} },
      summary: { default: 'Reset for prestige points.', variants: {} },
      resetTargets: ['prestige-test-pack.energy'],
      unlockCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'prestige-test-pack.energy',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 100 },
      },
      reward: {
        resourceId: 'prestige-test-pack.prestige-points',
        baseReward: { kind: 'constant', value: 1 },
      },
    },
  ],
};
