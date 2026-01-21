import { describe, expect, it } from 'vitest';

import { hashRenderCommandBuffer } from './hashing.js';
import { compileViewModelToRenderCommandBuffer } from './render-compiler.js';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from './types.js';
import type { ViewModel } from './types.js';

import { renderCompilerFixtureViewModel } from './__fixtures__/render-compiler.js';

describe('render compiler', () => {
  it('quantizes world-space sprite coordinates to fixed-point integers', () => {
    const viewModel: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content:test',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
        sprites: [
          {
            id: 'sprite',
            assetId: 'asset:sprite',
            x: 1.1,
            y: -2.03,
            z: 0.125,
            width: 3.333,
            height: 4.666,
          },
        ],
      },
      ui: {
        nodes: [],
      },
    };

    const rcb = compileViewModelToRenderCommandBuffer(viewModel);
    const draw = rcb.draws.find(
      (entry) => entry.kind === 'image' && entry.passId === 'world',
    );

    expect(draw).toMatchObject({
      kind: 'image',
      passId: 'world',
      x: 282,
      y: -520,
      width: 853,
      height: 1194,
    });
    expect(draw && Number.isInteger(draw.x)).toBe(true);
    expect(draw && Number.isInteger(draw.y)).toBe(true);
    expect(draw && Number.isInteger(draw.width)).toBe(true);
    expect(draw && Number.isInteger(draw.height)).toBe(true);
  });

  it('orders sprite draws deterministically (independent of input array order)', async () => {
    const spriteA = {
      id: 'sprite-a',
      assetId: 'asset:sprite-a',
      x: 0,
      y: 0,
      z: 0,
      width: 1,
      height: 1,
    } as const;

    const spriteB = {
      id: 'sprite-b',
      assetId: 'asset:sprite-b',
      x: 0,
      y: 0,
      z: 0,
      width: 1,
      height: 1,
    } as const;

    const base: Omit<ViewModel, 'scene'> & Pick<ViewModel, 'scene'> = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 2,
        simTimeMs: 32,
        contentHash: 'content:test',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    const a = compileViewModelToRenderCommandBuffer({
      ...base,
      scene: { ...base.scene, sprites: [spriteA, spriteB] },
    });
    const b = compileViewModelToRenderCommandBuffer({
      ...base,
      scene: { ...base.scene, sprites: [spriteB, spriteA] },
    });

    await expect(hashRenderCommandBuffer(a)).resolves.toEqual(
      await hashRenderCommandBuffer(b),
    );
  });

  it('orders UI draws deterministically (ties broken by stable draw ids)', async () => {
    const base: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 3,
        simTimeMs: 48,
        contentHash: 'content:test',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    const nodeA = {
      kind: 'rect',
      id: 'a',
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      colorRgba: 0x11_11_11_ff,
    } as const;

    const nodeB = {
      kind: 'rect',
      id: 'b',
      x: 10,
      y: 10,
      width: 20,
      height: 20,
      colorRgba: 0x22_22_22_ff,
    } as const;

    const a = compileViewModelToRenderCommandBuffer({
      ...base,
      ui: { nodes: [nodeA, nodeB] },
    });
    const b = compileViewModelToRenderCommandBuffer({
      ...base,
      ui: { nodes: [nodeB, nodeA] },
    });

    await expect(hashRenderCommandBuffer(a)).resolves.toEqual(
      await hashRenderCommandBuffer(b),
    );
  });

  it('keeps meter background draw before fill draw', () => {
    const viewModel: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 4,
        simTimeMs: 64,
        contentHash: 'content:test',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [
          {
            kind: 'meter',
            id: 'meter',
            x: 10,
            y: 10,
            width: 100,
            height: 10,
            value: 1,
            max: 2,
            fillColorRgba: 0x2a_4f_8a_ff,
            backgroundColorRgba: 0x18_2a_44_ff,
          },
        ],
      },
    };

    const rcb = compileViewModelToRenderCommandBuffer(viewModel);
    const draws = rcb.draws.filter((draw) => draw.kind === 'rect' && draw.passId === 'ui');

    expect(draws).toHaveLength(2);
    expect(draws[0]).toMatchObject({ colorRgba: 0x18_2a_44_ff });
    expect(draws[1]).toMatchObject({ colorRgba: 0x2a_4f_8a_ff });
  });

  it('produces stable hashes for golden fixtures', async () => {
    const rcb = compileViewModelToRenderCommandBuffer(renderCompilerFixtureViewModel);
    await expect(hashRenderCommandBuffer(rcb)).resolves.toEqual(
      'dac6cf9d5a6300421744b298afc5d0dd652762d75a46c8b5724c69dcc518d27e',
    );
  });
});
