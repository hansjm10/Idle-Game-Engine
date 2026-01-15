/**
 * Comprehensive integration fixtures for testing content pack validation,
 * normalization, and error handling across all scenarios outlined in
 * docs/content-dsl-schema-design.md §6.
 */

const baseTitle = {
  default: 'Test Pack',
  variants: {},
} as const;

type TransformAmount =
  | { kind: 'constant'; value: number }
  | { kind: 'linear'; base: number; slope: number };

type TransformIO = {
  resourceId: string;
  amount: TransformAmount;
};

const createMetadata = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  title: baseTitle,
  version: '1.0.0',
  engine: '^1.0.0',
  defaultLocale: 'en-US',
  supportedLocales: ['en-US'],
  ...overrides,
});

const createResource = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: baseTitle,
  category: 'primary' as const,
  tier: 1,
  ...overrides,
});

const createManualTransform = (
  id: string,
  inputs: TransformIO[],
  outputs: TransformIO[],
  overrides: Record<string, unknown> = {},
) => ({
  id,
  name: baseTitle,
  description: baseTitle,
  inputs,
  outputs,
  trigger: { kind: 'manual' as const },
  mode: 'instant' as const,
  ...overrides,
});

const createResources = (...ids: string[]) => ids.map((id) => createResource(id));

const constantAmount = (value: number): TransformAmount => ({
  kind: 'constant',
  value,
});

const linearAmount = (base: number, slope: number): TransformAmount => ({
  kind: 'linear',
  base,
  slope,
});

const constantIO = (resourceId: string, value: number): TransformIO => ({
  resourceId,
  amount: constantAmount(value),
});

const linearIO = (resourceId: string, base: number, slope: number): TransformIO => ({
  resourceId,
  amount: linearAmount(base, slope),
});

const createConstantTransform = (
  id: string,
  inputResourceId: string,
  inputValue: number,
  outputResourceId: string,
  outputValue: number,
  overrides: Record<string, unknown> = {},
) =>
  createManualTransform(
    id,
    [constantIO(inputResourceId, inputValue)],
    [constantIO(outputResourceId, outputValue)],
    overrides,
  );

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
  metadata: createMetadata('missing-ref-pack'),
  resources: [
    createResource('energy'),
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
  metadata: createMetadata('cyclic-unlock-pack'),
  resources: [
    createResource('resource-a', {
      unlockCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'resource-b',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 10 },
      },
    }),
    createResource('resource-b', {
      unlockCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'resource-a',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 10 },
      },
    }),
  ],
  generators: [],
  upgrades: [],
};

/**
 * CYCLIC UNLOCK CONDITIONS - CROSS-ENTITY-TYPE
 * Resource unlocks via generator threshold, generator unlocks via resource threshold
 */
export const cyclicUnlockCrossEntityFixture = {
  metadata: createMetadata('cyclic-unlock-cross-entity'),
  resources: [
    createResource('energy', {
      unlockCondition: {
        kind: 'generatorLevel' as const,
        generatorId: 'solar-panel',
        comparator: 'gte' as const,
        level: { kind: 'constant', value: 1 },
      },
    }),
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
  metadata: createMetadata('self-threshold-unlock-pack'),
  resources: [
    createResource('hidden-ore', {
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
    }),
  ],
  generators: [],
  upgrades: [],
};

/**
 * ANYOF UNLOCK CONDITIONS: Alternative branch should not register dependency edges.
 */
export const anyOfUnlockBreaksCycleFixture = {
  metadata: createMetadata('anyof-unlock-breaks-cycle-pack'),
  resources: [
    createResource('resource-a', {
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
    }),
    createResource('resource-b', {
      unlockCondition: {
        kind: 'resourceThreshold' as const,
        resourceId: 'resource-a',
        comparator: 'gte' as const,
        amount: { kind: 'constant', value: 1 },
      },
    }),
  ],
  generators: [],
  upgrades: [],
};

/**
 * LOCALIZATION GAPS: Missing translations for declared supported locales
 */
export const localizationGapsFixture = {
  metadata: createMetadata('localization-gap-pack', {
    title: {
      default: 'Localization Test',
      variants: {
        'fr-FR': 'Test de Localisation',
        // Missing 'es-ES' variant
      },
    },
    supportedLocales: ['en-US', 'fr-FR', 'es-ES'], // Claims to support es-ES
  }),
  resources: [
    createResource('energy', {
      name: {
        default: 'Energy',
        variants: {
          'fr-FR': 'Énergie',
          // Missing 'es-ES' variant
        },
      },
    }),
    createResource('crystals', {
      name: {
        default: 'Crystals',
        variants: {
          // Missing both 'fr-FR' and 'es-ES' variants
        },
      },
    }),
  ],
  generators: [],
  upgrades: [],
};

/**
 * DEPENDENCY LOOPS: Pack declares dependency cycle
 */
export const dependencyLoopFixture = {
  metadata: createMetadata('pack-a', {
    dependencies: {
      requires: [{ packId: 'pack-b', version: '^1.0.0' }],
    },
  }),
  resources: [],
  generators: [],
  upgrades: [],
};

// Companion pack for dependency loop testing
export const dependencyLoopFixturePackB = {
  metadata: createMetadata('pack-b', {
    dependencies: {
      requires: [{ packId: 'pack-a', version: '^1.0.0' }],
    },
  }),
  resources: [],
  generators: [],
  upgrades: [],
};

/**
 * SELF-REFERENCING DEPENDENCY: Pack depends on itself
 */
export const selfReferencingDependencyFixture = {
  metadata: createMetadata('self-ref-pack', {
    dependencies: {
      requires: [{ packId: 'self-ref-pack', version: '^1.0.0' }],
    },
  }),
  resources: [],
  generators: [],
  upgrades: [],
};

/**
 * INVALID RUNTIME EVENT CONTRIBUTIONS: Missing schema path, duplicate IDs
 */
export const invalidRuntimeEventContributionsFixture = {
  metadata: createMetadata('invalid-events-pack'),
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
  metadata: createMetadata('invalid-formula-pack'),
  resources: [
    createResource('energy'),
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
  metadata: createMetadata('invalid-entity-formula'),
  resources: [
    createResource('energy'),
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
 * INVALID ENTITY MAX COUNT REFERENCES: Entity maxCount formula references unknown resource
 */
export const invalidEntityMaxCountFormulaReferencesFixture = {
  metadata: createMetadata('invalid-entity-maxcount'),
  resources: [
    createResource('energy'),
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
      maxCount: {
        kind: 'expression' as const,
        expression: {
          kind: 'ref' as const,
          target: {
            type: 'resource' as const,
            id: 'missing-maxcount-resource',
          },
        },
      },
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * INVALID ENTITY STAT GROWTH REFERENCES: Entity statGrowth formula references unknown resource
 */
export const invalidEntityStatGrowthFormulaReferencesFixture = {
  metadata: createMetadata('invalid-entity-statgrowth'),
  resources: [
    createResource('energy'),
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
        levelFormula: { kind: 'constant', value: 10 },
        statGrowth: {
          speed: {
            kind: 'expression' as const,
            expression: {
              kind: 'ref' as const,
              target: {
                type: 'resource' as const,
                id: 'missing-statgrowth-resource',
              },
            },
          },
        },
      },
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * INVALID ENTITY REFERENCES: Entity progression references unknown resource
 */
export const invalidEntityExperienceFixture = {
  metadata: createMetadata('invalid-entity-experience'),
  resources: [
    createResource('energy'),
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
  metadata: createMetadata('feature-gate-pack', { engine: '^0.1.0' }), // Targets old runtime
  resources: [
    createResource('energy'),
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
 * FEATURE GATE VIOLATIONS: Pack uses entities not supported by target runtime
 */
export const entityFeatureGateViolationFixture = {
  metadata: createMetadata('entity-feature-gate-pack', { engine: '^0.4.0' }), // Targets old runtime
  resources: [],
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
    },
  ],
  generators: [],
  upgrades: [],
};

/**
 * DUPLICATE IDS: Multiple resources with same ID
 */
export const duplicateResourceIdsFixture = {
  metadata: createMetadata('duplicate-ids-pack'),
  resources: [
    createResource('energy'),
    // Duplicate ID
    createResource('energy', {
      name: { default: 'Energy 2', variants: {} },
      tier: 2,
    }),
  ],
  generators: [],
  upgrades: [],
};

/**
 * MISSING METRIC REFERENCE: Achievement tracks non-existent custom metric
 */
export const missingMetricReferenceFixture = {
  metadata: createMetadata('missing-metric-pack'),
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
  metadata: createMetadata('invalid-allowlist-pack'),
  resources: [
    createResource('energy', {
      unlockCondition: {
        kind: 'flag' as const,
        flagId: 'undefined-flag', // Not in allowlist
      },
    }),
  ],
  generators: [],
  upgrades: [],
};

/**
 * RUNTIME EVENT CATALOG COLLISION: Pack event collides with core event
 */
export const runtimeEventCollisionFixture = {
  metadata: createMetadata('event-collision-pack'),
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
  metadata: createMetadata('cyclic-transform-direct'),
  resources: createResources('resource-x', 'resource-y'),
  generators: [],
  upgrades: [],
  transforms: [
    createConstantTransform('transform-a', 'resource-x', 100, 'resource-y', 120),
    createConstantTransform('transform-b', 'resource-y', 100, 'resource-x', 110),
  ],
};

/**
 * DIRECT TRANSFORM CHAIN - NET LOSS: Transform A → Transform B → Transform A
 * Transform A consumes X, produces Y
 * Transform B consumes Y, produces X
 */
export const netLossTransformCycleFixture = {
  metadata: createMetadata('net-loss-transform-cycle'),
  resources: createResources('resource-x', 'resource-y'),
  generators: [],
  upgrades: [],
  transforms: [
    createConstantTransform('transform-a', 'resource-x', 100, 'resource-y', 80),
    createConstantTransform('transform-b', 'resource-y', 100, 'resource-x', 90),
  ],
};

/**
 * DIRECT TRANSFORM CHAIN - NEUTRAL: Transform A → Transform B → Transform A
 * Overall cycle ratio = 1.0 (exactly neutral, should be allowed)
 * Transform A: 100 X → 100 Y (ratio 1.0)
 * Transform B: 100 Y → 100 X (ratio 1.0)
 */
export const neutralTransformCycleFixture = {
  metadata: createMetadata('neutral-transform-cycle'),
  resources: createResources('resource-x', 'resource-y'),
  generators: [],
  upgrades: [],
  transforms: [
    createConstantTransform('transform-a', 'resource-x', 100, 'resource-y', 100),
    createConstantTransform('transform-b', 'resource-y', 100, 'resource-x', 100),
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
  metadata: createMetadata('net-loss-indirect-transform-cycle'),
  resources: createResources('resource-x', 'resource-y', 'resource-z'),
  generators: [],
  upgrades: [],
  transforms: [
    createConstantTransform('transform-a', 'resource-x', 100, 'resource-y', 90),
    createConstantTransform('transform-b', 'resource-y', 100, 'resource-z', 90),
    createConstantTransform('transform-c', 'resource-z', 100, 'resource-x', 90),
  ],
};

/**
 * NON-SIMPLE TRANSFORM IN CYCLE: Transform with multiple inputs in a cycle
 * Should be rejected because cycle profitability cannot be evaluated
 */
export const nonSimpleTransformCycleFixture = {
  metadata: createMetadata('non-simple-transform-cycle'),
  resources: createResources('resource-x', 'resource-y', 'resource-catalyst'),
  generators: [],
  upgrades: [],
  transforms: [
    createManualTransform(
      'transform-a',
      [
        constantIO('resource-x', 100),
        constantIO('resource-catalyst', 10),
      ],
      [constantIO('resource-y', 80)],
    ),
    createConstantTransform('transform-b', 'resource-y', 100, 'resource-x', 90),
  ],
};

/**
 * EPSILON BOUNDARY TEST - BELOW THRESHOLD: Cycle ratio just below PROFIT_EPSILON (1e-8).
 * Ratio = 1.000000001 (1e-9 above 1.0) which is below the 1e-8 threshold.
 * Should be ALLOWED.
 */
export const epsilonBelowThresholdCycleFixture = {
  metadata: createMetadata('epsilon-below-threshold-cycle'),
  resources: createResources('resource-x', 'resource-y'),
  generators: [],
  upgrades: [],
  transforms: [
    createManualTransform(
      'transform-a',
      [
        // Using large numbers to achieve precise ratio
        constantIO('resource-x', 1000000000),
      ],
      [
        // Ratio = 1.000000001 (1e-9 above 1.0)
        constantIO('resource-y', 1000000001),
      ],
    ),
    createManualTransform(
      'transform-b',
      [constantIO('resource-y', 1000000000)],
      [
        // Ratio = 1.0
        constantIO('resource-x', 1000000000),
      ],
    ),
  ],
};

/**
 * EPSILON BOUNDARY TEST - ABOVE THRESHOLD: Cycle ratio just above PROFIT_EPSILON (1e-8).
 * Ratio = 1.00000002 (2e-8 above 1.0) which is above the 1e-8 threshold.
 * Should be REJECTED.
 */
export const epsilonAboveThresholdCycleFixture = {
  metadata: createMetadata('epsilon-above-threshold-cycle'),
  resources: createResources('resource-x', 'resource-y'),
  generators: [],
  upgrades: [],
  transforms: [
    createManualTransform(
      'transform-a',
      [constantIO('resource-x', 100000000)],
      [
        // Ratio = 1.00000002 (2e-8 above 1.0)
        constantIO('resource-y', 100000002),
      ],
    ),
    createManualTransform(
      'transform-b',
      [constantIO('resource-y', 100000000)],
      [
        // Ratio = 1.0
        constantIO('resource-x', 100000000),
      ],
    ),
  ],
};

/**
 * NON-CONSTANT FORMULA IN CYCLE: Transform with linear formula in a cycle.
 * Should be rejected because cycle profitability cannot be evaluated for non-constant formulas.
 */
export const nonConstantFormulaCycleFixture = {
  metadata: createMetadata('non-constant-formula-cycle'),
  resources: createResources('resource-x', 'resource-y'),
  generators: [],
  upgrades: [],
  transforms: [
    createManualTransform(
      'transform-a',
      [constantIO('resource-x', 100)],
      [
        // Linear formula instead of constant - profitability cannot be evaluated
        linearIO('resource-y', 80, 1),
      ],
    ),
    createConstantTransform('transform-b', 'resource-y', 100, 'resource-x', 90),
  ],
};

/**
 * CYCLIC TRANSFORM CHAINS - INDIRECT: Transform A → Transform B → Transform C → Transform A
 * Transform A consumes X, produces Y
 * Transform B consumes Y, produces Z
 * Transform C consumes Z, produces X
 */
export const cyclicTransformIndirectFixture = {
  metadata: createMetadata('cyclic-transform-indirect'),
  resources: createResources('resource-x', 'resource-y', 'resource-z'),
  generators: [],
  upgrades: [],
  transforms: [
    createConstantTransform('transform-a', 'resource-x', 100, 'resource-y', 110),
    createConstantTransform('transform-b', 'resource-y', 100, 'resource-z', 110),
    createConstantTransform('transform-c', 'resource-z', 100, 'resource-x', 110),
  ],
};

/**
 * CYCLIC TRANSFORM CHAINS - MULTI-RESOURCE
 * Transform A consumes X + Y, produces Z
 * Transform B consumes Z, produces X
 * Transform C consumes Z, produces Y
 */
export const cyclicTransformMultiResourceFixture = {
  metadata: createMetadata('cyclic-transform-multi'),
  resources: createResources('resource-x', 'resource-y', 'resource-z'),
  generators: [],
  upgrades: [],
  transforms: [
    createManualTransform(
      'transform-a',
      [
        constantIO('resource-x', 1),
        constantIO('resource-y', 1),
      ],
      [constantIO('resource-z', 1)],
    ),
    createConstantTransform('transform-b', 'resource-z', 1, 'resource-x', 1),
    createConstantTransform('transform-c', 'resource-z', 1, 'resource-y', 1),
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
  metadata: createMetadata('linear-transform-chain'),
  resources: createResources('resource-x', 'resource-y', 'resource-z', 'resource-w'),
  generators: [],
  upgrades: [],
  transforms: [
    createConstantTransform('transform-a', 'resource-x', 1, 'resource-y', 1),
    createConstantTransform('transform-b', 'resource-y', 1, 'resource-z', 1),
    createConstantTransform('transform-c', 'resource-z', 1, 'resource-w', 1),
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
  metadata: createMetadata('convergent-transform-tree'),
  resources: createResources('resource-x', 'resource-y', 'resource-z', 'resource-w'),
  generators: [],
  upgrades: [],
  transforms: [
    createConstantTransform('transform-a', 'resource-x', 1, 'resource-z', 1),
    createConstantTransform('transform-b', 'resource-y', 1, 'resource-z', 1),
    createConstantTransform('transform-c', 'resource-z', 2, 'resource-w', 1),
  ],
};

/**
 * NON-CYCLIC TRANSFORM CHAIN - RESOURCE SINK
 * Transforms consume resources but don't regenerate them.
 * This creates a one-way flow with no cycles.
 */
export const resourceSinkTransformFixture = {
  metadata: createMetadata('resource-sink-transform'),
  resources: createResources('mana', 'essence', 'boost-item'),
  generators: [],
  upgrades: [],
  transforms: [
    createManualTransform(
      'craft-boost',
      [
        constantIO('mana', 100),
        constantIO('essence', 10),
      ],
      [constantIO('boost-item', 1)],
    ),
  ],
};

/**
 * EDGE CASE - SELF-REFERENCING TRANSFORM
 * Transform A consumes X and produces X
 * This creates a self-loop.
 */
export const selfReferencingTransformFixture = {
  metadata: createMetadata('self-referencing-transform'),
  resources: createResources('resource-x'),
  generators: [],
  upgrades: [],
  transforms: [
    createConstantTransform('transform-a', 'resource-x', 1, 'resource-x', 0.8),
  ],
};

/**
 * ZERO-AMOUNT TRANSFORM IN CYCLE: Transform with zero input amount.
 * Should be treated as non-simple (profitability cannot be evaluated) and rejected if in a cycle.
 */
export const zeroAmountTransformCycleFixture = {
  metadata: createMetadata('zero-amount-transform-cycle'),
  resources: createResources('resource-x', 'resource-y'),
  generators: [],
  upgrades: [],
  transforms: [
    createManualTransform(
      'transform-a',
      [
        // Zero amount - should be treated as non-simple
        constantIO('resource-x', 0),
      ],
      [constantIO('resource-y', 80)],
    ),
    createConstantTransform('transform-b', 'resource-y', 100, 'resource-x', 90),
  ],
};

/**
 * DISJOINT CYCLES: Two independent cycles in the same pack.
 * One net-positive (X<->Y) and one net-loss (A<->B).
 * Should be rejected because of the net-positive cycle.
 */
export const disjointCyclesFixture = {
  metadata: createMetadata('disjoint-cycles'),
  resources: createResources('resource-x', 'resource-y', 'resource-a', 'resource-b'),
  generators: [],
  upgrades: [],
  transforms: [
    // Net-positive cycle: X <-> Y (ratio = 1.2 * 1.1 = 1.32)
    createConstantTransform('transform-x-to-y', 'resource-x', 100, 'resource-y', 120),
    createConstantTransform('transform-y-to-x', 'resource-y', 100, 'resource-x', 110),
    // Net-loss cycle: A <-> B (ratio = 0.8 * 0.9 = 0.72)
    createConstantTransform('transform-a-to-b', 'resource-a', 100, 'resource-b', 80),
    createConstantTransform('transform-b-to-a', 'resource-b', 100, 'resource-a', 90),
  ],
};

/**
 * DISJOINT CYCLES - ALL NET LOSS: Two independent net-loss cycles.
 * Both should be allowed since neither is net-positive.
 */
export const disjointNetLossCyclesFixture = {
  metadata: createMetadata('disjoint-net-loss-cycles'),
  resources: createResources('resource-x', 'resource-y', 'resource-a', 'resource-b'),
  generators: [],
  upgrades: [],
  transforms: [
    // Net-loss cycle 1: X <-> Y (ratio = 0.8 * 0.9 = 0.72)
    createConstantTransform('transform-x-to-y', 'resource-x', 100, 'resource-y', 80),
    createConstantTransform('transform-y-to-x', 'resource-y', 100, 'resource-x', 90),
    // Net-loss cycle 2: A <-> B (ratio = 0.7 * 0.85 = 0.595)
    createConstantTransform('transform-a-to-b', 'resource-a', 100, 'resource-b', 70),
    createConstantTransform('transform-b-to-a', 'resource-b', 100, 'resource-a', 85),
  ],
};

/**
 * PRESTIGE LAYER: Pack with prestige layer but missing the required prestige count resource.
 * Should fail validation with a clear error message.
 */
export const missingPrestigeCountResourceFixture = {
  metadata: createMetadata('prestige-test-pack'),
  resources: [
    createResource('prestige-test-pack.energy', {
      name: { default: 'Energy', variants: {} },
      startAmount: 100,
    }),
    createResource('prestige-test-pack.prestige-points', {
      name: { default: 'Prestige Points', variants: {} },
      category: 'prestige' as const,
      tier: 2,
    }),
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
