import { describe, expect, it } from 'vitest';

import type { AssetId, RenderCommandBuffer } from '@idle-engine/renderer-contract';

import type { Canvas2dContextLike } from './canvas2d-renderer.js';
import {
  renderRenderCommandBufferToCanvas2d,
} from './canvas2d-renderer.js';
import { validateRenderCommandBuffer } from './rcb-validation.js';

function createFakeContext(): {
  ctx: Canvas2dContextLike;
  calls: ReadonlyArray<{ name: string; args: readonly unknown[] }>;
} {
  const calls: Array<{ name: string; args: readonly unknown[] }> = [];

  const ctx: Canvas2dContextLike = {
    canvas: { width: 100, height: 50 },
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    font: '10px sans-serif',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    clearRect: (...args) => calls.push({ name: 'clearRect', args }),
    fillRect: (...args) => calls.push({ name: 'fillRect', args }),
    strokeRect: (...args) => calls.push({ name: 'strokeRect', args }),
    fillText: (...args) => calls.push({ name: 'fillText', args }),
    drawImage: (...args) => calls.push({ name: 'drawImage', args }),
  };

  return { ctx, calls };
}

function createSampleRcb(): RenderCommandBuffer {
  return {
    frame: {
      schemaVersion: 1,
      step: 1,
      simTimeMs: 16,
      contentHash: 'content',
    },
    passes: [{ id: 'ui' }],
    draws: [
      {
        kind: 'clear',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
        colorRgba: 0x00_00_00_ff,
      },
      {
        kind: 'rect',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
        x: 1,
        y: 2,
        width: 3,
        height: 4,
        colorRgba: 0xff_00_00_ff,
      },
      {
        kind: 'text',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
        x: 5,
        y: 6,
        text: 'hello',
        colorRgba: 0xff_ff_ff_ff,
        fontSizePx: 10,
      },
      {
        kind: 'image',
        passId: 'ui',
        sortKey: { sortKeyHi: 0, sortKeyLo: 3 },
        assetId: 'image:missing' as AssetId,
        x: 7,
        y: 8,
        width: 9,
        height: 10,
      },
    ],
  };
}

describe('validateRenderCommandBuffer', () => {
  it('flags out-of-order sort keys', () => {
    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: 1,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'rect',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          colorRgba: 0xff_00_00_ff,
        },
        {
          kind: 'rect',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          colorRgba: 0xff_00_00_ff,
        },
      ],
    };

    const result = validateRenderCommandBuffer(rcb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('sortKey out of order');
    }
  });
});

describe('renderRenderCommandBufferToCanvas2d', () => {
  it('renders draws in order with pixelRatio scaling', () => {
    const { ctx, calls } = createFakeContext();
    const rcb = createSampleRcb();

    renderRenderCommandBufferToCanvas2d(ctx, rcb, { pixelRatio: 2 });

    expect(calls.map((c) => c.name)).toEqual([
      'fillRect',
      'fillRect',
      'fillText',
      'fillRect',
      'strokeRect',
      'fillText',
    ]);

    expect(calls[1].args).toEqual([2, 4, 6, 8]);
    expect(calls[2].args).toEqual(['hello', 10, 12]);
    expect(calls[3].args).toEqual([14, 16, 18, 20]);
  });
});
