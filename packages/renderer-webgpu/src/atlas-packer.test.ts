import { describe, expect, it } from 'vitest';
import { createAtlasLayout, packAtlas } from './atlas-packer.js';
import { canonicalEncodeForHash, sha256Hex } from '@idle-engine/renderer-contract';
import type { AssetId } from '@idle-engine/renderer-contract';

describe('atlas-packer', () => {
  it('packs deterministically by AssetId regardless of input order', () => {
    const images = [
      { assetId: 'b' as AssetId, width: 8, height: 8 },
      { assetId: 'a' as AssetId, width: 8, height: 16 },
      { assetId: 'c' as AssetId, width: 4, height: 4 },
    ];

    const first = packAtlas(images, { maxSizePx: 64, paddingPx: 2, powerOfTwo: true });
    const second = packAtlas([...images].reverse(), { maxSizePx: 64, paddingPx: 2, powerOfTwo: true });

    expect(first).toEqual(second);
    expect(first.entries.map((entry) => entry.assetId)).toEqual(['a', 'b', 'c']);
  });

  it('produces a stable layout hash for the same pack result', async () => {
    const images = [
      { assetId: 'a' as AssetId, width: 8, height: 8 },
      { assetId: 'b' as AssetId, width: 8, height: 8 },
    ];

    const result = packAtlas(images, { maxSizePx: 64, paddingPx: 0, powerOfTwo: true });
    const layout = createAtlasLayout(result);
    const firstHash = await sha256Hex(canonicalEncodeForHash(layout));
    const secondHash = await sha256Hex(canonicalEncodeForHash(layout));

    expect(firstHash).toBe(secondHash);
  });

  it('grows atlas width when needed to respect maxSizePx', () => {
    const images = [
      { assetId: 'a' as AssetId, width: 32, height: 32 },
      { assetId: 'b' as AssetId, width: 32, height: 32 },
      { assetId: 'c' as AssetId, width: 32, height: 32 },
      { assetId: 'd' as AssetId, width: 32, height: 32 },
    ];

    const packed = packAtlas(images, { maxSizePx: 64, paddingPx: 0, powerOfTwo: true });

    expect(packed.atlasWidthPx).toBe(64);
    expect(packed.atlasHeightPx).toBe(64);
  });

  it('throws when powerOfTwo is disabled and packing cannot fit within maxSizePx', () => {
    const images = [
      { assetId: 'a' as AssetId, width: 32, height: 32 },
      { assetId: 'b' as AssetId, width: 32, height: 32 },
    ];

    expect(() => packAtlas(images, { maxSizePx: 32, paddingPx: 0, powerOfTwo: false })).toThrow(
      'exceeded maxSizePx',
    );
  });

  it('throws on duplicate AssetIds', () => {
    const images = [
      { assetId: 'a' as AssetId, width: 8, height: 8 },
      { assetId: 'a' as AssetId, width: 8, height: 8 },
    ];

    expect(() => packAtlas(images, { maxSizePx: 64 })).toThrow('duplicate AssetId');
  });
});
