import { describe, expect, it } from 'vitest';

import { dependencyCycleFixture } from '../../__fixtures__/invalid-content.js';
import { dependencyCollectionSchema } from '../dependencies.js';
import { metadataSchema } from '../metadata.js';

describe('metadataSchema', () => {
  it('normalizes authors, locales, links, and tags', () => {
    const result = metadataSchema.parse({
      id: 'Sample-Pack',
      title: {
        default: 'Idle Pack',
        variants: {},
      },
      version: '1.0.0',
      engine: '^1.0.0',
      authors: [' Alice ', 'alice', 'Bob'],
      defaultLocale: 'en-us',
      supportedLocales: ['fr-fr', 'en-US'],
      tags: ['Gameplay', 'ui', 'ui'],
      links: [
        {
          kind: 'Docs',
          label: ' Guide ',
          href: 'https://example.com/guide',
        },
        {
          kind: 'docs',
          label: 'Guide',
          href: 'https://example.com/guide',
        },
      ],
    });

    expect(result.id).toBe('sample-pack');
    expect(result.authors).toEqual(['Alice', 'Bob']);
    expect(result.supportedLocales).toEqual(['en-US', 'fr-FR']);
    expect(result.tags).toEqual(['gameplay', 'ui']);
    expect(result.links).toEqual([
      {
        kind: 'docs',
        label: 'Guide',
        href: 'https://example.com/guide',
      },
    ]);
    expect((result.title.variants as Record<string, string>)['en-US']).toBe(
      'Idle Pack',
    );
  });

  it('rejects metadata when supported locales omit the default locale', () => {
    expect(() =>
      metadataSchema.parse({
        id: 'sample-pack',
        title: { default: 'Idle Pack', variants: {} },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['fr-FR'],
      }),
    ).toThrowError(/supported locales/i);
  });

  it('rejects self-referential dependencies', () => {
    expect(() =>
      metadataSchema.parse({
        id: 'self-pack',
        title: { default: 'Idle Pack', variants: {} },
        version: '1.0.0',
        engine: '^1.0.0',
        defaultLocale: 'en-US',
        supportedLocales: ['en-US'],
        dependencies: dependencyCollectionSchema.parse({
          requires: [{ packId: 'self-pack', version: '^1.0.0' }],
        }),
      }),
    ).toThrowError(/cannot declare a requires dependency on itself/i);
  });

  it('identifies dependency issues in the cycle fixture', () => {
    expect(() => metadataSchema.parse(dependencyCycleFixture.metadata)).toThrow();
  });
});
