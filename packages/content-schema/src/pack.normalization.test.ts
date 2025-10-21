import { describe, expect, it } from 'vitest';

import { createContentPackValidator } from './index.js';

const createNormalizationFixture = () => ({
  metadata: {
    id: 'sample-pack',
    title: {
      default: 'Sample Pack',
      variants: {
        'fr-FR': 'Pack Exemple',
      },
    },
    summary: {
      default: 'A short summary',
      variants: {
        'fr-FR': 'Un bref résumé',
      },
    },
    version: '1.0.0',
    engine: '^1.0.0',
    defaultLocale: 'en-US',
    supportedLocales: ['en-US', 'fr-FR'],
    authors: ['Example Author'],
  },
  resources: [
    {
      id: 'resource:beta',
      name: { default: 'Beta Resource', variants: {} },
      category: 'primary' as const,
      tier: 1,
      order: 2,
    },
    {
      id: 'resource:alpha',
      name: {
        default: 'Alpha Resource',
        variants: {
          'fr-FR': 'Ressource Alpha',
        },
      },
      category: 'primary' as const,
      tier: 1,
      order: 1,
    },
  ],
  generators: [
    {
      id: 'generator:alpha',
      name: {
        default: 'Alpha Generator',
        variants: {
          'fr-FR': 'Générateur Alpha',
        },
      },
      produces: [
        {
          resourceId: 'resource:alpha',
          rate: { kind: 'constant', value: 1 },
        },
      ],
      consumes: [],
      purchase: {
        currencyId: 'resource:alpha',
        baseCost: 1,
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
  guildPerks: [],
  runtimeEvents: [],
});

describe('normalizeContentPack', () => {
  it('produces deterministic ordering, lookups, and locale mirroring', () => {
    const validator = createContentPackValidator();
    const input = createNormalizationFixture();

    const { pack: normalized, warnings } = validator.parse(input);

    expect(normalized.resources.map((resource) => resource.id)).toEqual([
      'resource:alpha',
      'resource:beta',
    ]);

    const alphaResource = normalized.lookup.resources.get('resource:alpha');
    expect(alphaResource).toBe(normalized.resources[0]);

    const betaResource = normalized.lookup.resources.get('resource:beta');
    expect(betaResource?.name.variants['en-US']).toBe('Beta Resource');

    expect(
      normalized.serializedLookup.resourceById['resource:alpha'],
    ).toBe(alphaResource);

    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'localization.missingVariant',
          path: ['resources', 1, 'name'],
        }),
      ]),
    );
  });

  it('emits stable digests across repeated runs', () => {
    const validator = createContentPackValidator();
    const base = createNormalizationFixture();

    const first = validator.parse(base).pack.digest.hash;
    const secondInput = JSON.parse(JSON.stringify(base));
    const second = validator.parse(secondInput).pack.digest.hash;

    expect(second).toBe(first);
  });
});
