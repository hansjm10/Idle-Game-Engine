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
        baseCost: 10,
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
        baseCost: 50,
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
  guildPerks: [],
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
        baseCost: 10,
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
        baseCost: 10,
        costCurve: { kind: 'constant', value: 10 },
      },
      baseUnlock: { kind: 'always' as const },
    },
  ],
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
