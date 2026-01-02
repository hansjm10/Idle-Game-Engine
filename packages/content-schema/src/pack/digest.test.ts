import { describe, expect, it } from 'vitest';

import { computePackDigest } from './digest.js';
import type { ParsedContentPack } from './schema.js';

const createBaseMetadata = (): ParsedContentPack['metadata'] =>
  ({
    id: 'pack-a',
    title: { default: 'Pack A', variants: {} },
    version: '1.0.0',
    engine: '^1.0.0',
    authors: [],
    defaultLocale: 'en',
    supportedLocales: ['en'],
    tags: [],
    links: [],
  }) as unknown as ParsedContentPack['metadata'];

const createParsedPack = (
  overrides: Partial<ParsedContentPack> = {},
): ParsedContentPack =>
  ({
    metadata: createBaseMetadata(),
    resources: [],
    generators: [],
    upgrades: [],
    metrics: [],
    achievements: [],
    automations: [],
    transforms: [],
    prestigeLayers: [],
    runtimeEvents: [],
    ...overrides,
  }) as ParsedContentPack;

describe('computePackDigest', () => {
  it('produces stable digests for equivalent packs regardless of key order', () => {
    const titleA = { default: 'Pack A', variants: {} };
    const titleB = { variants: {}, default: 'Pack A' };

    const metadataA = {
      ...createBaseMetadata(),
      title: titleA,
    } as unknown as ParsedContentPack['metadata'];

    const metadataB = {
      version: '1.0.0',
      engine: '^1.0.0',
      title: titleB,
      supportedLocales: ['en'],
      defaultLocale: 'en',
      id: 'pack-a',
      tags: [],
      authors: [],
      links: [],
    } as unknown as ParsedContentPack['metadata'];

    const digestA = computePackDigest(createParsedPack({ metadata: metadataA }));
    const digestB = computePackDigest(createParsedPack({ metadata: metadataB }));

    expect(digestB).toStrictEqual(digestA);
  });

  it('changes digest when content differs', () => {
    const baseDigest = computePackDigest(createParsedPack());
    const changedDigest = computePackDigest(
      createParsedPack({
        metadata: {
          ...createBaseMetadata(),
          id: 'pack-b',
        } as ParsedContentPack['metadata'],
      }),
    );

    expect(changedDigest.hash).not.toBe(baseDigest.hash);
  });

  it('ignores unsupported values in objects and arrays', () => {
    const metadataWithNoise = {
      ...createBaseMetadata(),
      summary: undefined,
      extraFunction: (() => 'ignored') as unknown as string,
      extraSymbol: Symbol('ignored') as unknown as string,
    } as unknown as ParsedContentPack['metadata'];

    const noisyResources = [
      undefined,
      (() => null) as unknown as ParsedContentPack['resources'][number],
      Symbol('skip') as unknown as ParsedContentPack['resources'][number],
      null as unknown as ParsedContentPack['resources'][number],
    ] as unknown as ParsedContentPack['resources'];

    const cleanResources = [
      null,
      null,
      null,
      null,
    ] as unknown as ParsedContentPack['resources'];

    const digestWithNoise = computePackDigest(
      createParsedPack({ metadata: metadataWithNoise, resources: noisyResources }),
    );
    const digestClean = computePackDigest(
      createParsedPack({ metadata: createBaseMetadata(), resources: cleanResources }),
    );

    expect(digestWithNoise).toStrictEqual(digestClean);
  });
});
