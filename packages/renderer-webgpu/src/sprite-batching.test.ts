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

  it('sorts by sortKeyHi before sortKeyLo', () => {
    const rcb = {
      frame: { schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION, step: 0, simTimeMs: 0, contentHash: 'content:dev' },
      passes: [{ id: 'world' }],
      draws: [
        {
          kind: 'image',
          passId: 'world',
          sortKey: { sortKeyHi: 1, sortKeyLo: 0 },
          assetId: 'b' as AssetId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
        {
          kind: 'image',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 999 },
          assetId: 'a' as AssetId,
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
      'b',
    ]);
  });

  it('skips clear draws and sorts unknown passes after known ones', () => {
    const rcb = {
      frame: { schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION, step: 0, simTimeMs: 0, contentHash: 'content:dev' },
      passes: [{ id: 'world' }],
      draws: [
        {
          kind: 'clear',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0x00_00_00_ff,
        },
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
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          assetId: 'a' as AssetId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
      ],
    } as unknown as RenderCommandBuffer;

    const ordered = orderDrawsByPassAndSortKey(rcb);
    expect(ordered.map((entry) => entry.draw.kind)).toEqual(['image', 'image']);
    expect(ordered.map((entry) => (entry.draw.kind === 'image' ? entry.draw.assetId : ''))).toEqual([
      'a',
      'b',
    ]);
  });

  it('builds empty instance buffers when there are no image draws', () => {
    const result = buildSpriteInstances({
      orderedDraws: [],
      uvByAssetId: new Map(),
    });

    expect(result.instanceCount).toBe(0);
    expect(result.instances).toEqual(new Float32Array([]));
    expect(result.groups).toEqual([]);
  });

  it('throws when atlas UVs are missing for an image draw', () => {
    const rcb = {
      frame: { schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION, step: 0, simTimeMs: 0, contentHash: 'content:dev' },
      passes: [{ id: 'world' }],
      draws: [
        {
          kind: 'image',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          assetId: 'sprite:missing' as AssetId,
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
      ],
    } as unknown as RenderCommandBuffer;

    const ordered = orderDrawsByPassAndSortKey(rcb);

    expect(() =>
      buildSpriteInstances({
        orderedDraws: ordered,
        uvByAssetId: new Map(),
      }),
    ).toThrow('Atlas missing UVs for AssetId');
  });

  it('builds per-pass instance groups and respects tintRgba (0xRRGGBBAA)', () => {
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
    const spriteAColorOffset = instanceStride - 4;
    expect(result.instances.slice(spriteAColorOffset, spriteAColorOffset + 4)).toEqual(
      new Float32Array([0x12 / 255, 0x34 / 255, 0x56 / 255, 0x80 / 255]),
    );

    const spriteBColorOffset = instanceStride + (instanceStride - 4);
    expect(result.instances.slice(spriteBColorOffset, spriteBColorOffset + 4)).toEqual(
      new Float32Array([1, 1, 1, 1]),
    );
  });
});
