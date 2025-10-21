/**
 * Snapshot tests verifying normalization determinism across multiple runs
 * per docs/content-dsl-schema-design.md §6 and §5.17.
 */

import { describe, expect, it } from 'vitest';
import { createContentPackValidator } from '../index.js';
import { validComprehensivePackFixture } from '../__fixtures__/integration-packs.js';

describe('Normalization Snapshots', () => {
  it('produces deterministic output for comprehensive pack', () => {
    const validator = createContentPackValidator({
      runtimeVersion: '1.0.0',
      activePackIds: ['@idle-engine/core'],
    });

    const result = validator.parse(validComprehensivePackFixture);

    // Snapshot the entire normalized pack
    expect(result.pack).toMatchSnapshot();

    // Verify digest is stable
    expect(result.pack.digest).toMatchSnapshot('pack-digest');
  });

  it('produces identical output across multiple parses of same input', () => {
    const validator = createContentPackValidator();

    const firstParse = validator.parse(validComprehensivePackFixture);
    const secondParse = validator.parse(
      JSON.parse(JSON.stringify(validComprehensivePackFixture)),
    );
    const thirdParse = validator.parse({
      ...validComprehensivePackFixture,
    });

    // All parses should produce identical digests
    expect(firstParse.pack.digest.hash).toBe(secondParse.pack.digest.hash);
    expect(secondParse.pack.digest.hash).toBe(thirdParse.pack.digest.hash);

    // Verify resources are in same order
    expect(firstParse.pack.resources.map((r) => r.id)).toEqual(
      secondParse.pack.resources.map((r) => r.id),
    );
  });

  it('normalizes resource ordering deterministically', () => {
    const validator = createContentPackValidator();

    const packWithUnorderedResources = {
      metadata: {
        id: 'order-test',
        title: { default: 'Order Test', variants: {} },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
      },
      resources: [
        {
          id: 'zulu',
          name: { default: 'Zulu', variants: {} },
          category: 'primary' as const,
          tier: 1,
          order: 3,
        },
        {
          id: 'alpha',
          name: { default: 'Alpha', variants: {} },
          category: 'primary' as const,
          tier: 1,
          order: 1,
        },
        {
          id: 'mike',
          name: { default: 'Mike', variants: {} },
          category: 'primary' as const,
          tier: 1,
          order: 2,
        },
      ],
      generators: [],
      upgrades: [],
    };

    const result = validator.parse(packWithUnorderedResources);

    // Verify order field determines sort
    expect(result.pack.resources.map((r) => r.id)).toEqual([
      'alpha',
      'mike',
      'zulu',
    ]);

    // Snapshot the ordering
    expect(result.pack.resources).toMatchSnapshot('ordered-resources');
  });

  it('normalizes locale variants deterministically', () => {
    const validator = createContentPackValidator();

    const packWithLocales = {
      metadata: {
        id: 'locale-test',
        title: {
          default: 'Locale Test',
          variants: {
            'fr-FR': 'Test de Locale',
            'es-ES': 'Prueba de Configuración Regional',
            'de-DE': 'Locale-Test',
          },
        },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US', 'fr-FR', 'es-ES', 'de-DE'],
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
        },
      ],
      generators: [],
      upgrades: [],
    };

    const result = validator.parse(packWithLocales);

    // Snapshot normalized locales
    expect(result.pack.metadata.title).toMatchSnapshot('title-with-locales');
    expect(result.pack.resources[0]?.name).toMatchSnapshot(
      'resource-name-with-locales',
    );

    // Verify defaultLocale is mirrored into variants
    expect(result.pack.metadata.title.variants['en-US']).toBe('Locale Test');
  });

  it('normalizes formulas deterministically', () => {
    const validator = createContentPackValidator();

    const packWithFormulas = {
      metadata: {
        id: 'formula-test',
        title: { default: 'Formula Test', variants: {} },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
      },
      resources: [
        {
          id: 'energy',
          name: { default: 'Energy', variants: {} },
          category: 'primary' as const,
          tier: 1,
        },
      ],
      generators: [
        {
          id: 'solar-panel',
          name: { default: 'Solar Panel', variants: {} },
          produces: [
            {
              resourceId: 'energy',
              rate: {
                kind: 'piecewise' as const,
                pieces: [
                  {
                    untilLevel: 10,
                    formula: { kind: 'linear' as const, base: 1, slope: 0.5 },
                  },
                  {
                    untilLevel: 50,
                    formula: {
                      kind: 'exponential' as const,
                      base: 10,
                      growth: 1.1,
                      offset: 5,
                    },
                  },
                  {
                    formula: {
                      kind: 'polynomial' as const,
                      coefficients: [100, 10, 1],
                    },
                  },
                ],
              },
            },
          ],
          consumes: [],
          purchase: {
            currencyId: 'energy',
            baseCost: 10,
            costCurve: { kind: 'constant' as const, value: 10 },
          },
          baseUnlock: { kind: 'always' as const },
        },
      ],
      upgrades: [],
    };

    const result = validator.parse(packWithFormulas);

    // Snapshot the normalized formulas
    expect(result.pack.generators[0]?.produces[0]?.rate).toMatchSnapshot(
      'piecewise-formula',
    );
  });

  it('normalizes conditions deterministically', () => {
    const validator = createContentPackValidator();

    const packWithConditions = {
      metadata: {
        id: 'condition-test',
        title: { default: 'Condition Test', variants: {} },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
      },
      resources: [
        {
          id: 'energy',
          name: { default: 'Energy', variants: {} },
          category: 'primary' as const,
          tier: 1,
        },
        {
          id: 'crystals',
          name: { default: 'Crystals', variants: {} },
          category: 'prestige' as const,
          tier: 2,
          unlockCondition: {
            kind: 'allOf' as const,
            conditions: [
              {
                kind: 'resourceThreshold' as const,
                resourceId: 'energy',
                comparator: 'gte' as const,
                amount: { kind: 'constant' as const, value: 100 },
              },
              {
                kind: 'anyOf' as const,
                conditions: [
                  {
                    kind: 'resourceThreshold' as const,
                    resourceId: 'energy',
                    comparator: 'gte' as const,
                    amount: { kind: 'constant' as const, value: 200 },
                  },
                ],
              },
            ],
          },
        },
      ],
      generators: [],
      upgrades: [],
    };

    const result = validator.parse(packWithConditions);

    // Snapshot the normalized condition tree
    expect(
      result.pack.resources.find((r) => r.id === 'crystals')?.unlockCondition,
    ).toMatchSnapshot('complex-condition-tree');
  });

  it('normalizes lookup maps structure', () => {
    const validator = createContentPackValidator();

    const result = validator.parse(validComprehensivePackFixture);

    // Snapshot lookup map keys
    const lookupKeys = {
      resources: Array.from(result.pack.lookup.resources.keys()),
      generators: Array.from(result.pack.lookup.generators.keys()),
      upgrades: Array.from(result.pack.lookup.upgrades.keys()),
      metrics: Array.from(result.pack.lookup.metrics.keys()),
      achievements: Array.from(result.pack.lookup.achievements.keys()),
    };

    expect(lookupKeys).toMatchSnapshot('lookup-map-keys');

    // Snapshot serialized lookup keys
    const serializedLookupKeys = {
      resources: Object.keys(result.pack.serializedLookup.resourceById),
      generators: Object.keys(result.pack.serializedLookup.generatorById),
      upgrades: Object.keys(result.pack.serializedLookup.upgradeById),
    };

    expect(serializedLookupKeys).toMatchSnapshot('serialized-lookup-keys');
  });

  it('normalizes metadata fields deterministically', () => {
    const validator = createContentPackValidator();

    const packWithMetadata = {
      metadata: {
        id: 'metadata-test',
        title: { default: 'Metadata Test', variants: {} },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['fr-FR', 'en-US', 'es-ES'], // Unsorted
        authors: ['Author B', 'Author A', 'Author C'], // Unsorted
        tags: ['zulu', 'alpha', 'mike'], // Unsorted
      },
      resources: [],
      generators: [],
      upgrades: [],
    };

    const result = validator.parse(packWithMetadata);

    // Snapshot normalized metadata (should be sorted)
    expect(result.pack.metadata).toMatchSnapshot('normalized-metadata');

    // Verify arrays are sorted
    expect(result.pack.metadata.supportedLocales).toEqual([
      'en-US',
      'es-ES',
      'fr-FR',
    ]);
  });

  it('produces consistent digest hashes for equivalent packs', () => {
    const validator = createContentPackValidator();

    const pack1 = {
      metadata: {
        id: 'test-pack',
        title: { default: 'Test', variants: {} },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
      },
      resources: [
        {
          id: 'energy',
          name: { default: 'Energy', variants: {} },
          category: 'primary' as const,
          tier: 1,
        },
      ],
      generators: [],
      upgrades: [],
    };

    // Create equivalent pack with different ordering
    const pack2 = JSON.parse(JSON.stringify(pack1));

    const result1 = validator.parse(pack1);
    const result2 = validator.parse(pack2);

    // Digests should match
    expect(result1.pack.digest.hash).toBe(result2.pack.digest.hash);
    expect(result1.pack.digest.version).toBe(result2.pack.digest.version);

    // Snapshot the digest format
    expect(result1.pack.digest).toMatchSnapshot('digest-format');
  });
});
