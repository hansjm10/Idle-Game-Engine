import { describe, expect, it } from 'vitest';

import { hashRenderCommandBuffer, hashViewModel } from './hashing.js';
import type {
  RenderCommandBuffer,
  ViewModel,
} from './types.js';

describe('hashing', () => {
  it('hashes ViewModel deterministically (independent of object key insertion order)', async () => {
    const a: ViewModel = {
      frame: {
        schemaVersion: 1,
        step: 2,
        simTimeMs: 32,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: 1, y: 2, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    const b: ViewModel = {
      ui: {
        nodes: [],
      },
      scene: {
        sprites: [],
        camera: { zoom: 1, y: 2, x: 1 },
      },
      frame: {
        contentHash: 'content:abc',
        simTimeMs: 32,
        step: 2,
        schemaVersion: 1,
      },
    };

    await expect(hashViewModel(a)).resolves.toEqual(await hashViewModel(b));
  });

  it('normalizes -0 to 0 before hashing', async () => {
    const a: ViewModel = {
      frame: {
        schemaVersion: 1,
        step: 2,
        simTimeMs: 32,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: -0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    const b: ViewModel = {
      frame: {
        schemaVersion: 1,
        step: 2,
        simTimeMs: 32,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    await expect(hashViewModel(a)).resolves.toEqual(await hashViewModel(b));
  });

  it('rejects NaN and Infinity for hashing', async () => {
    const nan: ViewModel = {
      frame: {
        schemaVersion: 1,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: Number.NaN, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    const infinity: ViewModel = {
      frame: {
        schemaVersion: 1,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content:abc',
      },
      scene: {
        camera: { x: Number.POSITIVE_INFINITY, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    await expect(hashViewModel(nan)).rejects.toThrow(/NaN/);
    await expect(hashViewModel(infinity)).rejects.toThrow(/Infinity/);
  });

  it('hashes RenderCommandBuffer deterministically', async () => {
    const a: RenderCommandBuffer = {
      frame: {
        schemaVersion: 1,
        step: 2,
        simTimeMs: 32,
        contentHash: 'content:abc',
      },
      passes: [
        { id: 'world' },
        { id: 'ui' },
      ],
      draws: [
        {
          kind: 'clear',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0xff_00_00_ff,
        },
      ],
    };

    const b: RenderCommandBuffer = {
      draws: [
        {
          colorRgba: 0xff_00_00_ff,
          sortKey: { sortKeyLo: 0, sortKeyHi: 0 },
          passId: 'world',
          kind: 'clear',
        },
      ],
      passes: [
        { id: 'world' },
        { id: 'ui' },
      ],
      frame: {
        contentHash: 'content:abc',
        simTimeMs: 32,
        step: 2,
        schemaVersion: 1,
      },
    };

    await expect(hashRenderCommandBuffer(a)).resolves.toEqual(
      await hashRenderCommandBuffer(b),
    );
  });
});
