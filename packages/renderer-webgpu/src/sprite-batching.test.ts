import { describe, expect, it } from 'vitest';
import { buildSpriteInstances, orderDrawsByPassAndSortKey } from './sprite-batching.js';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import type {
  AssetId,
  RenderCommandBuffer,
} from '@idle-engine/renderer-contract';

describe('sprite-batching', () => {
  it('sorts draws by pass order and sortKey stably', () => {
    const rcb = {
      frame: { schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION, step: 0, simTimeMs: 0, contentHash: 'content:dev' },
      passes: [{ id: 'world' }, { id: 'ui' }],
      draws: [
        {
          kind: 'image',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          assetId: 'b' as AssetId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
        {
          kind: 'image',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
          assetId: 'a' as AssetId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
        {
          kind: 'image',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
          assetId: 'c' as AssetId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
      ],
    } as unknown as RenderCommandBuffer;

    const ordered = orderDrawsByPassAndSortKey(rcb);
    expect(ordered.map((entry) => (entry.draw.kind === 'image' ? entry.draw.assetId : ''))).toEqual([
      'a',
      'c',
      'b',
    ]);
  });

  it('builds per-pass instance groups and respects alpha-only tinting', () => {
    const rcb = {
      frame: { schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION, step: 0, simTimeMs: 0, contentHash: 'content:dev' },
      passes: [{ id: 'world' }, { id: 'ui' }],
      draws: [
        {
          kind: 'image',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          assetId: 'sprite:a' as AssetId,
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          tintRgba: 0x12_34_56_80,
        },
        {
          kind: 'image',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          assetId: 'sprite:b' as AssetId,
          x: 5,
          y: 6,
          width: 7,
          height: 8,
        },
      ],
    } as unknown as RenderCommandBuffer;

    const ordered = orderDrawsByPassAndSortKey(rcb);

    const result = buildSpriteInstances({
      orderedDraws: ordered,
      uvByAssetId: new Map([
        ['sprite:a' as AssetId, { u0: 0, v0: 0, u1: 0.5, v1: 0.5 }],
        ['sprite:b' as AssetId, { u0: 0.5, v0: 0.5, u1: 1, v1: 1 }],
      ]),
    });

    expect(result.groups).toEqual([
      { passId: 'world', firstInstance: 0, instanceCount: 1 },
      { passId: 'ui', firstInstance: 1, instanceCount: 1 },
    ]);

    const instanceStride = 12;
    const spriteAAlpha = result.instances[instanceStride - 1];
    expect(spriteAAlpha).toBeCloseTo(0x80 / 255);
  });
});
