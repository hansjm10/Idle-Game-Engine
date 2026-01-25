import { describe, expect, it } from 'vitest';

import { hashRenderCommandBuffer } from './hashing.js';
import { __test__, compileViewModelToRenderCommandBuffer } from './render-compiler.js';
import { RENDERER_CONTRACT_SCHEMA_VERSION } from './types.js';
import type { ViewModel } from './types.js';

import { renderCompilerFixtureViewModel } from './__fixtures__/render-compiler.js';

describe('render compiler', () => {
  it('copies camera into the RenderCommandBuffer scene', () => {
    const viewModel: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 0,
        simTimeMs: 0,
        contentHash: 'content:test',
      },
      scene: {
        camera: { x: 1.25, y: -2.5, zoom: 3 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    const rcb = compileViewModelToRenderCommandBuffer(viewModel);

    expect(rcb.scene.camera).toEqual(viewModel.scene.camera);
  });

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

  it('rejects camera zoom values that are not positive', () => {
    const viewModel: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content:test',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 0 },
        sprites: [],
      },
      ui: {
        nodes: [],
      },
    };

    expect(() => compileViewModelToRenderCommandBuffer(viewModel)).toThrow(/camera\.zoom/i);
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

  it('compiles UI image nodes into ui image draws', () => {
    const viewModel: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 5,
        simTimeMs: 80,
        contentHash: 'content:test',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
        sprites: [],
      },
      ui: {
        nodes: [
          {
            kind: 'image',
            id: 'ui-image',
            assetId: 'asset:ui-image',
            x: 12.6,
            y: 8.4,
            width: 100,
            height: 50,
            tintRgba: 0x11_22_33_44,
          },
        ],
      },
    };

    const rcb = compileViewModelToRenderCommandBuffer(viewModel);
    const draw = rcb.draws.find((entry) => entry.kind === 'image' && entry.passId === 'ui');

    expect(draw).toMatchObject({
      kind: 'image',
      passId: 'ui',
      assetId: 'asset:ui-image',
      x: 13,
      y: 8,
      width: 100,
      height: 50,
      tintRgba: 0x11_22_33_44,
    });
  });

  it('clamps meter fill widths (non-positive max and out-of-range values)', () => {
    const base: Omit<ViewModel, 'ui'> & Pick<ViewModel, 'ui'> = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 6,
        simTimeMs: 96,
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

    const maxZero = compileViewModelToRenderCommandBuffer({
      ...base,
      ui: {
        nodes: [
          {
            kind: 'meter',
            id: 'meter-zero',
            x: 0,
            y: 0,
            width: 10,
            height: 2,
            value: 5,
            max: 0,
            fillColorRgba: 0xff_00_00_ff,
            backgroundColorRgba: 0x00_00_00_ff,
          },
        ],
      },
    });
    const maxZeroFill = maxZero.draws.find(
      (draw) => draw.kind === 'rect' && draw.passId === 'ui' && draw.colorRgba === 0xff_00_00_ff,
    );
    expect(maxZeroFill).toMatchObject({ width: 0 });

    const valueOverMax = compileViewModelToRenderCommandBuffer({
      ...base,
      ui: {
        nodes: [
          {
            kind: 'meter',
            id: 'meter-over',
            x: 0,
            y: 0,
            width: 10,
            height: 2,
            value: 999,
            max: 4,
            fillColorRgba: 0xff_00_00_ff,
            backgroundColorRgba: 0x00_00_00_ff,
          },
        ],
      },
    });
    const valueOverMaxFill = valueOverMax.draws.find(
      (draw) => draw.kind === 'rect' && draw.passId === 'ui' && draw.colorRgba === 0xff_00_00_ff,
    );
    expect(valueOverMaxFill).toMatchObject({ width: 10 });

    const valueUnderZero = compileViewModelToRenderCommandBuffer({
      ...base,
      ui: {
        nodes: [
          {
            kind: 'meter',
            id: 'meter-under',
            x: 0,
            y: 0,
            width: 10,
            height: 2,
            value: -1,
            max: 4,
            fillColorRgba: 0xff_00_00_ff,
            backgroundColorRgba: 0x00_00_00_ff,
          },
        ],
      },
    });
    const valueUnderZeroFill = valueUnderZero.draws.find(
      (draw) => draw.kind === 'rect' && draw.passId === 'ui' && draw.colorRgba === 0xff_00_00_ff,
    );
    expect(valueUnderZeroFill).toMatchObject({ width: 0 });
  });

  it('throws on invalid inputs (worldFixedPointScale, empty ids, duplicates)', () => {
    const base: ViewModel = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 7,
        simTimeMs: 112,
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

    expect(() =>
      compileViewModelToRenderCommandBuffer(base, { worldFixedPointScale: 0 }),
    ).toThrow(/worldFixedPointScale/);

    expect(() =>
      compileViewModelToRenderCommandBuffer({
        ...base,
        scene: {
          ...base.scene,
          sprites: [
            {
              id: 'sprite',
              assetId: 'asset:sprite',
              x: 0,
              y: 0,
              z: 0,
              width: 1,
              height: 1,
            },
            {
              id: 'sprite',
              assetId: 'asset:sprite',
              x: 0,
              y: 0,
              z: 0,
              width: 1,
              height: 1,
            },
          ],
        },
      }),
    ).toThrow(/duplicate drawKey/);

    expect(() =>
      compileViewModelToRenderCommandBuffer({
        ...base,
        scene: {
          ...base.scene,
          sprites: [
            {
              id: '   ',
              assetId: 'asset:sprite',
              x: 0,
              y: 0,
              z: 0,
              width: 1,
              height: 1,
            },
          ],
        },
      }),
    ).toThrow(/non-empty string/);
  });

  it('validates quantization and int32 encoding helpers', () => {
    expect(() => __test__.quantizeToInt(Number.NaN, 1, 'value')).toThrow(/finite number/);
    expect(() => __test__.quantizeToInt(Number.MAX_VALUE, 256, 'value')).toThrow(
      /quantizable range/,
    );

    expect(() => __test__.encodeSignedInt32ToSortableUint32(1.5, 'value')).toThrow(/integer/);
    expect(() =>
      __test__.encodeSignedInt32ToSortableUint32(2147483648, 'value'),
    ).toThrow(/int32/);
  });

  it('produces stable hashes for golden fixtures', async () => {
    const rcb = compileViewModelToRenderCommandBuffer(renderCompilerFixtureViewModel);
    await expect(hashRenderCommandBuffer(rcb)).resolves.toEqual(
      'f53fcdc13a10171a33aed7414eabb42f0e793414229e5d0b1e826bad66e818c2',
    );
  });
});
