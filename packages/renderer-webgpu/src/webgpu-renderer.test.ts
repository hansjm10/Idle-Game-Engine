import { describe, expect, it } from 'vitest';
import { __test__ } from './webgpu-renderer.js';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

describe('renderer-webgpu', () => {
  it('converts RGBA ints to GPUColor', () => {
    expect(__test__.colorRgbaToGpuColor(0xff_00_00_ff)).toEqual({
      r: 1,
      g: 0,
      b: 0,
      a: 1,
    });

    expect(__test__.colorRgbaToGpuColor(0x00_80_ff_40)).toEqual({
      r: 0,
      g: 128 / 255,
      b: 1,
      a: 64 / 255,
    });
  });

  it('derives a sane canvas pixel size', () => {
    const canvas = {
      clientWidth: 0,
      clientHeight: 10,
    } as HTMLCanvasElement;

    expect(__test__.getCanvasPixelSize(canvas, 2)).toEqual({ width: 1, height: 20 });
  });

  it('defaults to opaque black when RCB has no clear draw', () => {
    const rcb = {
      frame: {
        schemaVersion: 1,
        step: 0,
        simTimeMs: 0,
        contentHash: 'content:dev',
      },
      passes: [{ id: 'world' }],
      draws: [],
    } satisfies RenderCommandBuffer;

    expect(__test__.selectClearColor(rcb)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it('prefers the clear draw matching the first pass', () => {
    const rcb = {
      frame: {
        schemaVersion: 1,
        step: 0,
        simTimeMs: 0,
        contentHash: 'content:dev',
      },
      passes: [{ id: 'ui' }, { id: 'world' }],
      draws: [
        {
          kind: 'clear',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0xff_00_00_ff,
        },
        {
          kind: 'clear',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0x00_ff_00_ff,
        },
      ],
    } satisfies RenderCommandBuffer;

    expect(__test__.selectClearColor(rcb)).toEqual({ r: 0, g: 1, b: 0, a: 1 });
  });
});
