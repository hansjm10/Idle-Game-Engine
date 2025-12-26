import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import { contentPackSchema, createContentPackValidator } from './index.js';

const createMinimalPack = () => ({
  metadata: {
    id: 'sample-pack',
    title: { default: 'Sample Pack' },
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US'],
  },
  resources: [
    {
      id: 'resource:energy',
      name: { default: 'Energy' },
      category: 'primary' as const,
      tier: 1,
    },
  ],
  generators: [
    {
      id: 'generator:reactor',
      name: { default: 'Reactor' },
      produces: [
        { resourceId: 'resource:energy', rate: { kind: 'constant', value: 1 } },
      ],
      consumes: [],
      purchase: {
        currencyId: 'resource:energy',
        costMultiplier: 1,
        costCurve: { kind: 'constant', value: 1 },
      },
      baseUnlock: { kind: 'always' },
    },
  ],
  upgrades: [],
  metrics: [],
  achievements: [],
  automations: [],
  transforms: [],
  prestigeLayers: [],
  runtimeEvents: [],
});

describe('content pack validator', () => {
  it('parses a minimal pack and produces normalized lookup maps', () => {
    const pack = createMinimalPack();
    const schemaResult = contentPackSchema.parse(pack);
    expect(schemaResult.resources).toHaveLength(1);

    const { pack: normalized, warnings } = createContentPackValidator().parse(pack);
    expect(warnings).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalized.lookup.resources.get('resource:energy' as any)).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(normalized.lookup.generators.get('generator:reactor' as any)).toBeDefined();
    expect(normalized.digest.hash).toMatch(/^fnv1a-[0-9a-f]{8}$/);
  });

  it('rejects cross-module reference to an unknown resource', () => {
    const invalidPack = createMinimalPack();
    invalidPack.generators[0].produces[0].resourceId = 'resource:missing';
    const validator = createContentPackValidator();
    expect(() => validator.parse(invalidPack)).toThrow(ZodError);
  });

  it('rejects multi-cost generator purchases that reference unknown resources', () => {
    const invalidPack = createMinimalPack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (invalidPack.generators[0] as any).purchase = {
      costs: [
        {
          resourceId: 'resource:energy',
          costMultiplier: 1,
          costCurve: { kind: 'constant', value: 1 },
        },
        {
          resourceId: 'resource:missing',
          costMultiplier: 1,
          costCurve: { kind: 'constant', value: 1 },
        },
      ],
    };
    const validator = createContentPackValidator();
    expect(() => validator.parse(invalidPack)).toThrow(ZodError);
  });

  it('rejects multi-cost upgrade purchases that reference unknown resources', () => {
    const invalidPack = createMinimalPack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (invalidPack.upgrades as any) = [
      {
        id: 'upgrade:test',
        name: { default: 'Test Upgrade' },
        category: 'global' as const,
        targets: [{ kind: 'global' }],
        cost: {
          costs: [
            {
              resourceId: 'resource:energy',
              costMultiplier: 1,
              costCurve: { kind: 'constant', value: 1 },
            },
            {
              resourceId: 'resource:missing',
              costMultiplier: 1,
              costCurve: { kind: 'constant', value: 1 },
            },
          ],
        },
        effects: [
          {
            kind: 'modifyResourceRate',
            resourceId: 'resource:energy',
            operation: 'add',
            value: { kind: 'constant', value: 1 },
          },
        ],
      },
    ];

    const validator = createContentPackValidator();
    expect(() => validator.parse(invalidPack)).toThrow(ZodError);
  });

  it('rejects modifyGeneratorConsumption effects that reference unknown resources', () => {
    const invalidPack = createMinimalPack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (invalidPack.upgrades as any) = [
      {
        id: 'upgrade:invalid-consumption',
        name: { default: 'Invalid Consumption' },
        category: 'generator' as const,
        targets: [{ kind: 'generator', id: 'generator:reactor' }],
        cost: {
          currencyId: 'resource:energy',
          costMultiplier: 1,
          costCurve: { kind: 'constant', value: 1 },
        },
        effects: [
          {
            kind: 'modifyGeneratorConsumption',
            generatorId: 'generator:reactor',
            resourceId: 'resource:missing',
            operation: 'multiply',
            value: { kind: 'constant', value: 0.5 },
          },
        ],
      },
    ];

    const validator = createContentPackValidator();
    expect(() => validator.parse(invalidPack)).toThrow(ZodError);
  });

  it('rejects resource unlock conditions that reference unknown entities', () => {
    const invalidPack = createMinimalPack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (invalidPack.resources[0] as any).unlockCondition = {
      kind: 'generatorLevel',
      generatorId: 'generator:missing',
      comparator: 'gte',
      level: { kind: 'constant', value: 1 },
    };

    const validator = createContentPackValidator();
    expect(() => validator.parse(invalidPack)).toThrow(ZodError);
  });

  it('rejects resource prestige blocks that reference unknown prestige layers', () => {
    const invalidPack = createMinimalPack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (invalidPack.resources[0] as any).prestige = { layerId: 'prestige:missing' };

    const validator = createContentPackValidator();
    expect(() => validator.parse(invalidPack)).toThrow(ZodError);
  });

  it('collects warnings for missing optional dependencies when active pack ids are supplied', () => {
    const packWithOptionalDependency = createMinimalPack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (packWithOptionalDependency.metadata as any).dependencies = {
      optional: [{ packId: 'friends-pack' }],
    };
    const validator = createContentPackValidator({
      activePackIds: ['core-pack'],
    });
    const result = validator.safeParse(packWithOptionalDependency);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.warnings).toHaveLength(1);
      expect(result.data.warnings[0]?.code).toBe('dependencies.optionalMissing');
    }
  });

  it('enforces feature gates when runtime version predates automations', () => {
    const packWithAutomation = createMinimalPack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (packWithAutomation.automations as any) = [
      {
        id: 'automation:auto-reactor',
        name: { default: 'Auto Reactor' },
        description: { default: 'Automatically runs the reactor' },
        targetType: 'generator' as const,
        targetId: 'generator:reactor',
        trigger: {
          kind: 'interval' as const,
          interval: { kind: 'constant', value: 1 },
        },
        unlockCondition: { kind: 'always' },
      },
    ];
    const validator = createContentPackValidator({ runtimeVersion: '0.1.0' });
    expect(() => validator.parse(packWithAutomation)).toThrow(ZodError);
  });

  it('does not enforce allowlists for unspecified categories', () => {
    const packWithScriptMetric = createMinimalPack();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (packWithScriptMetric.metrics as any) = [
      {
        id: 'metric:scripted',
        name: { default: 'Scripted Metric', variants: {} },
        kind: 'counter',
        source: { kind: 'script', scriptId: 'script:custom' },
      },
    ];

    const validator = createContentPackValidator({
      allowlists: {
        flags: { required: ['flag:ok'] },
      },
    });

    expect(() => validator.parse(packWithScriptMetric)).not.toThrow();
  });
});
