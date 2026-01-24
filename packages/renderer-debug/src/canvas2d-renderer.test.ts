import { describe, expect, it, vi } from 'vitest';

import { RENDERER_CONTRACT_SCHEMA_VERSION, WORLD_FIXED_POINT_SCALE } from '@idle-engine/renderer-contract';
import type { AssetId, RenderCommandBuffer } from '@idle-engine/renderer-contract';

import type { Canvas2dContextLike } from './canvas2d-renderer.js';
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
    save: () => calls.push({ name: 'save', args: [] }),
    restore: () => calls.push({ name: 'restore', args: [] }),
    beginPath: () => calls.push({ name: 'beginPath', args: [] }),
    rect: (...args) => calls.push({ name: 'rect', args }),
    clip: () => calls.push({ name: 'clip', args: [] }),
    clearRect: (...args) => calls.push({ name: 'clearRect', args }),
    fillRect: (...args) => calls.push({ name: 'fillRect', args }),
    strokeRect: (...args) => calls.push({ name: 'strokeRect', args }),
    fillText: (...args) => calls.push({ name: 'fillText', args }),
    drawImage: (...args) => calls.push({ name: 'drawImage', args }),
  };

  return { ctx, calls };
}

function createFakeContextWithAlphaTracking(): {
  ctx: Canvas2dContextLike;
  calls: ReadonlyArray<{
    name: string;
    args: readonly unknown[];
    globalAlpha: number;
  }>;
} {
  const calls: Array<{
    name: string;
    args: readonly unknown[];
    globalAlpha: number;
  }> = [];

  const ctx: Canvas2dContextLike = {
    canvas: { width: 100, height: 50 },
    fillStyle: '',
    strokeStyle: '',
    globalAlpha: 1,
    lineWidth: 1,
    font: '10px sans-serif',
    textBaseline: 'alphabetic',
    textAlign: 'start',
    save: () => calls.push({ name: 'save', args: [], globalAlpha: ctx.globalAlpha }),
    restore: () =>
      calls.push({ name: 'restore', args: [], globalAlpha: ctx.globalAlpha }),
    beginPath: () =>
      calls.push({ name: 'beginPath', args: [], globalAlpha: ctx.globalAlpha }),
    rect: (...args) => calls.push({ name: 'rect', args, globalAlpha: ctx.globalAlpha }),
    clip: () => calls.push({ name: 'clip', args: [], globalAlpha: ctx.globalAlpha }),
    clearRect: (...args) =>
      calls.push({ name: 'clearRect', args, globalAlpha: ctx.globalAlpha }),
    fillRect: (...args) =>
      calls.push({ name: 'fillRect', args, globalAlpha: ctx.globalAlpha }),
    strokeRect: (...args) =>
      calls.push({ name: 'strokeRect', args, globalAlpha: ctx.globalAlpha }),
    fillText: (...args) =>
      calls.push({ name: 'fillText', args, globalAlpha: ctx.globalAlpha }),
    drawImage: (...args) =>
      calls.push({ name: 'drawImage', args, globalAlpha: ctx.globalAlpha }),
  };

  return { ctx, calls };
}

function createSampleRcb(): RenderCommandBuffer {
  return {
    frame: {
      schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
      step: 1,
      simTimeMs: 16,
      contentHash: 'content',
    },
    scene: {
      camera: { x: 0, y: 0, zoom: 1 },
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
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
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

  it('flags out-of-order sort keys by sortKeyHi', () => {
    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'rect',
          passId: 'ui',
          sortKey: { sortKeyHi: 1, sortKeyLo: 0 },
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          colorRgba: 0xff_00_00_ff,
        },
        {
          kind: 'rect',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
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

  it('flags schemaVersion mismatches', () => {
    const rcb = {
      frame: {
        schemaVersion: 1,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [],
    } as unknown as RenderCommandBuffer;

    const result = validateRenderCommandBuffer(rcb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain(
        `frame.schemaVersion must equal ${RENDERER_CONTRACT_SCHEMA_VERSION}`,
      );
    }
  });

  it('flags non-uint32 schemaVersion and missing arrays', () => {
    const rcb = {
      frame: {
        schemaVersion: '4',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: null,
      draws: null,
    } as unknown as RenderCommandBuffer;

    const result = validateRenderCommandBuffer(rcb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('frame.schemaVersion must be uint32');
      expect(result.errors.join('\n')).toContain('passes must be an array');
      expect(result.errors.join('\n')).toContain('draws must be an array');
    }
  });

  it('flags malformed pass entries', () => {
    const rcb = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [null, { id: 'nope' }],
      draws: [],
    } as unknown as RenderCommandBuffer;

    const result = validateRenderCommandBuffer(rcb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('passes[0] must be an object');
      expect(result.errors.join('\n')).toContain(
        "passes[1].id must be 'world' or 'ui'",
      );
    }
  });

  it('flags non-string draw kinds', () => {
    const rcb = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 123,
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
        },
      ],
    } as unknown as RenderCommandBuffer;

    const result = validateRenderCommandBuffer(rcb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('draws[0].kind must be a string');
    }
  });

  it('validates draw fields across passes and kinds', () => {
    const rcb = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }, { id: 'world' }],
      draws: [
        {
          kind: 'clear',
          passId: 'nope',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0x00_00_00_ff,
        },
        {
          kind: 'clear',
          passId: 'ui',
          sortKey: { sortKeyHi: -1, sortKeyLo: '0' },
          colorRgba: 'bad',
        },
        {
          kind: 'rect',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
          x: 1.5,
          y: 0,
          width: -1,
          height: 1,
          colorRgba: 'bad',
        },
        {
          kind: 'scissorPush',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
          x: 0,
          y: 0,
          width: 1.5,
          height: 1,
        },
        {
          kind: 'image',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 3 },
          assetId: 'asset:test',
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          tintRgba: 'bad',
        },
        {
          kind: 'text',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 4 },
          x: 0,
          y: 0,
          text: 123,
          colorRgba: 'bad',
          fontAssetId: '',
          fontSizePx: 0,
        },
        {
          kind: 'text',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 5 },
          x: 0,
          y: 0,
          text: 'ok',
          colorRgba: 0x00_00_00_ff,
          fontSizePx: 1.5,
        },
        {
          kind: 'triangle',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 6 },
        },
        null,
        {
          kind: 'rect',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          x: Number.NaN,
          y: 0,
          width: Number.NaN,
          height: 1,
          colorRgba: 0x00_00_00_ff,
        },
        {
          kind: 'text',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
          x: 0,
          y: 0,
          text: 'ok',
          colorRgba: 0x00_00_00_ff,
          fontSizePx: Number.NaN,
        },
      ],
    } as unknown as RenderCommandBuffer;

    const result = validateRenderCommandBuffer(rcb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const errors = result.errors.join('\n');
      expect(errors).toContain("draws[0].passId must be 'world' or 'ui'");
      expect(errors).toContain('draws[1].sortKey.sortKeyHi must be uint32');
      expect(errors).toContain('draws[1].sortKey.sortKeyLo must be uint32');
      expect(errors).toContain('draws[1].colorRgba must be uint32 RGBA');
      expect(errors).toContain('draws[2].x must be a finite integer number');
      expect(errors).toContain('draws[2].width must be non-negative');
      expect(errors).toContain('draws[2].colorRgba must be uint32 RGBA');
      expect(errors).toContain('draws[3].width must be a finite integer number');
      expect(errors).toContain('draws[4].tintRgba must be uint32 RGBA when provided');
      expect(errors).toContain('draws[5].text must be a string');
      expect(errors).toContain('draws[5].fontAssetId must be non-empty when provided');
      expect(errors).toContain('draws[5].fontSizePx must be positive');
      expect(errors).toContain('draws[6].fontSizePx must be a finite integer number');
      expect(errors).toContain(
        'draws[7].kind must be one of: clear, rect, image, text, scissorPush, scissorPop',
      );
      expect(errors).toContain('draws[8] must be an object');
      expect(errors).toContain('draws[9].x must be a finite number');
      expect(errors).toContain('draws[9].width must be a finite number');
      expect(errors).toContain('draws[10].fontSizePx must be a finite number');
    }
  });

  it('flags malformed scene.camera values', () => {
    const missingCamera = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: null,
      },
      passes: [],
      draws: [],
    } as unknown as RenderCommandBuffer;

    const missingCameraResult = validateRenderCommandBuffer(missingCamera);
    expect(missingCameraResult.ok).toBe(false);
    if (!missingCameraResult.ok) {
      expect(missingCameraResult.errors.join('\n')).toContain(
        'scene.camera must be an object',
      );
    }

    const invalidCamera = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: Number.NaN, y: Number.POSITIVE_INFINITY, zoom: 0 },
      },
      passes: [],
      draws: [],
    } as unknown as RenderCommandBuffer;

    const invalidCameraResult = validateRenderCommandBuffer(invalidCamera);
    expect(invalidCameraResult.ok).toBe(false);
    if (!invalidCameraResult.ok) {
      expect(invalidCameraResult.errors.join('\n')).toContain(
        'scene.camera.x must be a finite number',
      );
      expect(invalidCameraResult.errors.join('\n')).toContain(
        'scene.camera.y must be a finite number',
      );
      expect(invalidCameraResult.errors.join('\n')).toContain(
        'scene.camera.zoom must be a positive number',
      );
    }
  });

  it('flags scissor stack errors (dangling clips)', () => {
    const unbalancedPassSwitch: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'world' }, { id: 'ui' }],
      draws: [
        {
          kind: 'scissorPush',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
        {
          kind: 'clear',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0x00_00_00_ff,
        },
      ],
    };

    const passSwitchResult = validateRenderCommandBuffer(unbalancedPassSwitch);
    expect(passSwitchResult.ok).toBe(false);
    if (!passSwitchResult.ok) {
      expect(passSwitchResult.errors.join('\n')).toContain(
        'scissor stack not empty when switching passId',
      );
    }

    const unbalancedEnd: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'scissorPush',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          x: 0,
          y: 0,
          width: 10,
          height: 10,
        },
      ],
    };

    const endResult = validateRenderCommandBuffer(unbalancedEnd);
    expect(endResult.ok).toBe(false);
    if (!endResult.ok) {
      expect(endResult.errors.join('\n')).toContain(
        'scissor stack not empty at end of draw list',
      );
    }
  });

  it('flags duplicate pass ids', () => {
    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }, { id: 'ui' }],
      draws: [],
    };

    const result = validateRenderCommandBuffer(rcb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('passes contains duplicate id: ui');
    }
  });

  it('flags draws referencing unknown passId', () => {
    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'clear',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0x00_00_00_ff,
        },
      ],
    };

    const result = validateRenderCommandBuffer(rcb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain(
        'draws[0].passId references unknown passId: world',
      );
    }
  });

  it('flags scissorPop without matching scissorPush', () => {
    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'scissorPop',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
        },
      ],
    };

    const result = validateRenderCommandBuffer(rcb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain(
        'scissorPop without matching scissorPush',
      );
    }
  });

  it('flags draws out of order across passes', () => {
    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'world' }, { id: 'ui' }],
      draws: [
        {
          kind: 'clear',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0x00_00_00_ff,
        },
        {
          kind: 'clear',
          passId: 'world',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          colorRgba: 0x00_00_00_ff,
        },
      ],
    };

    const result = validateRenderCommandBuffer(rcb);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain(
        'draws[1] passId world out of order',
      );
    }
  });

  it('does not throw on malformed runtime shapes', () => {
    const malformed = {
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'rect',
          passId: 'ui',
          sortKey: null,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          colorRgba: 0xff_00_00_ff,
        },
        {
          kind: 'image',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          assetId: null,
          x: 0,
          y: 0,
          width: 1,
          height: 1,
        },
      ],
    } as unknown as RenderCommandBuffer;

    expect(() => validateRenderCommandBuffer(malformed)).not.toThrow();

    const result = validateRenderCommandBuffer(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('draws[0].sortKey must be an object');
      expect(result.errors.join('\n')).toContain('draws[1].assetId must be non-empty');
    }
  });

  it('does not throw when rcb is not an object', () => {
    const malformed = null as unknown as RenderCommandBuffer;

    expect(() => validateRenderCommandBuffer(malformed)).not.toThrow();

    const result = validateRenderCommandBuffer(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join('\n')).toContain('rcb must be an object');
    }
  });
});

	describe('renderRenderCommandBufferToCanvas2d', () => {
	  it('renders draws in order with pixelRatio scaling', async () => {
    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

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

	  it('dequantizes world-pass fixed-point coordinates', async () => {
	    vi.resetModules();
	    const { renderRenderCommandBufferToCanvas2d } = await import(
	      './canvas2d-renderer.js'
	    );

	    const { ctx, calls } = createFakeContext();

	    const rcb: RenderCommandBuffer = {
	      frame: {
	        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
	        step: 1,
	        simTimeMs: 16,
	        contentHash: 'content',
	      },
	      scene: {
	        camera: { x: 0, y: 0, zoom: 1 },
	      },
	      passes: [{ id: 'world' }],
	      draws: [
	        {
	          kind: 'image',
	          passId: 'world',
	          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
	          assetId: 'image:missing' as AssetId,
	          x: 10 * WORLD_FIXED_POINT_SCALE,
	          y: 20 * WORLD_FIXED_POINT_SCALE,
	          width: 30 * WORLD_FIXED_POINT_SCALE,
	          height: 40 * WORLD_FIXED_POINT_SCALE,
	        },
	      ],
	    };

	    renderRenderCommandBufferToCanvas2d(ctx, rcb, { pixelRatio: 2 });

	    expect(calls.map((c) => c.name)).toEqual(['fillRect', 'strokeRect', 'fillText']);
	    expect(calls[0].args).toEqual([20, 40, 60, 80]);
	  });

    it('throws when worldFixedPointScale is not positive', async () => {
      vi.resetModules();
      const { renderRenderCommandBufferToCanvas2d } = await import(
        './canvas2d-renderer.js'
      );

      const { ctx } = createFakeContext();
      const rcb = createSampleRcb();

      expect(() =>
        renderRenderCommandBufferToCanvas2d(ctx, rcb, { worldFixedPointScale: 0 })
      ).toThrow(/worldFixedPointScale/i);
    });

    it('applies camera transforms to world scissor rectangles', async () => {
      vi.resetModules();
      const { renderRenderCommandBufferToCanvas2d } = await import(
        './canvas2d-renderer.js'
      );

      const { ctx, calls } = createFakeContext();

      const rcb: RenderCommandBuffer = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 1,
          simTimeMs: 16,
          contentHash: 'content',
        },
        scene: {
          camera: { x: 2, y: 1, zoom: 3 },
        },
        passes: [{ id: 'world' }],
        draws: [
          {
            kind: 'scissorPush',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            x: 10 * WORLD_FIXED_POINT_SCALE,
            y: 5 * WORLD_FIXED_POINT_SCALE,
            width: 4 * WORLD_FIXED_POINT_SCALE,
            height: 2 * WORLD_FIXED_POINT_SCALE,
          },
          {
            kind: 'scissorPop',
            passId: 'world',
            sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
          },
        ],
      };

      renderRenderCommandBufferToCanvas2d(ctx, rcb, { pixelRatio: 2 });

      expect(calls.map((c) => c.name)).toEqual([
        'save',
        'beginPath',
        'rect',
        'clip',
        'restore',
      ]);
      expect(calls[2]?.args).toEqual([48, 24, 24, 12]);
    });

  it('applies nested scissor clipping with pixelRatio scaling', async () => {
    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    const { ctx, calls } = createFakeContext();

    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'scissorPush',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          x: 1,
          y: 2,
          width: 3,
          height: 4,
        },
        {
          kind: 'scissorPush',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
          x: 5,
          y: 6,
          width: 7,
          height: 8,
        },
        {
          kind: 'scissorPop',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 2 },
        },
        {
          kind: 'scissorPop',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 3 },
        },
      ],
    };

    renderRenderCommandBufferToCanvas2d(ctx, rcb, { pixelRatio: 2 });

    expect(calls.map((c) => c.name)).toEqual([
      'save',
      'beginPath',
      'rect',
      'clip',
      'save',
      'beginPath',
      'rect',
      'clip',
      'restore',
      'restore',
    ]);

    expect(calls[2]?.args).toEqual([2, 4, 6, 8]);
    expect(calls[6]?.args).toEqual([10, 12, 14, 16]);
  });

  it('uses assets.resolveFontFamily for text draws', async () => {
    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    const { ctx } = createFakeContext();

    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'text',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          x: 1,
          y: 2,
          text: 'hello',
          colorRgba: 0xff_ff_ff_ff,
          fontSizePx: 10,
          fontAssetId: 'font:test' as AssetId,
        },
      ],
    };

    renderRenderCommandBufferToCanvas2d(ctx, rcb, {
      pixelRatio: 2,
      assets: { resolveFontFamily: () => 'TestFont' },
    });

    expect(ctx.font).toBe('20px TestFont');
  });

  it('throws when validation fails (validate=true)', async () => {
    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    const { ctx } = createFakeContext();
    const malformed = null as unknown as RenderCommandBuffer;
    expect(() => renderRenderCommandBufferToCanvas2d(ctx, malformed)).toThrow(
      'Invalid RenderCommandBuffer:',
    );
  });

  it('throws on unsupported draw kind (validate=false)', async () => {
    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    const { ctx } = createFakeContext();

    const rcb = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'bogus',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
        },
      ],
    } as unknown as RenderCommandBuffer;

    expect(() =>
      renderRenderCommandBufferToCanvas2d(ctx, rcb, { validate: false }),
    ).toThrow('Unsupported draw kind');
  });

  it('restores dangling scissorPush at end (validate=false)', async () => {
    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    const { ctx, calls } = createFakeContext();

    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'scissorPush',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          x: 1,
          y: 2,
          width: 3,
          height: 4,
        },
      ],
    };

    renderRenderCommandBufferToCanvas2d(ctx, rcb, { pixelRatio: 2, validate: false });

    expect(calls.map((c) => c.name)).toEqual([
      'save',
      'beginPath',
      'rect',
      'clip',
      'restore',
    ]);
  });

  it('skips image draws with non-positive size', async () => {
    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    const { ctx, calls } = createFakeContext();
    const image = { width: 2, height: 3 } as unknown as CanvasImageSource;

    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'image',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          assetId: 'image:test' as AssetId,
          x: 1,
          y: 2,
          width: 0,
          height: 3,
        },
      ],
    };

    renderRenderCommandBufferToCanvas2d(ctx, rcb, {
      assets: { resolveImage: () => image },
    });

    expect(calls).toEqual([]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('skips image draws with tintRgba alpha=0', async () => {
    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    const { ctx, calls } = createFakeContext();
    const image = { width: 2, height: 3 } as unknown as CanvasImageSource;

    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'image',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          assetId: 'image:test' as AssetId,
          x: 1,
          y: 2,
          width: 2,
          height: 3,
          tintRgba: 0x12_34_56_00,
        },
      ],
    };

    renderRenderCommandBufferToCanvas2d(ctx, rcb, {
      assets: { resolveImage: () => image },
    });

    expect(calls).toEqual([]);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('applies alpha-only tint when tintRgba is white (0xFFFFFFAA)', async () => {
    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    const { ctx, calls } = createFakeContextWithAlphaTracking();
    const image = { width: 2, height: 3 } as unknown as CanvasImageSource;

    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
      },
      scene: {
        camera: { x: 0, y: 0, zoom: 1 },
      },
      passes: [{ id: 'ui' }],
      draws: [
        {
          kind: 'image',
          passId: 'ui',
          sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
          assetId: 'image:test' as AssetId,
          x: 1,
          y: 2,
          width: 2,
          height: 3,
          tintRgba: 0xff_ff_ff_80,
        },
      ],
    };

    renderRenderCommandBufferToCanvas2d(ctx, rcb, {
      assets: { resolveImage: () => image },
    });

    expect(calls.map((c) => c.name)).toEqual(['drawImage']);
    expect(calls[0]?.args[0]).toBe(image);
    expect(calls[0]?.globalAlpha).toBeCloseTo(0x80 / 0xff);
    expect(ctx.globalAlpha).toBe(1);
  });

  it('falls back to alpha-only when scratch canvas is unavailable', async () => {
    const globalRecord = globalThis as unknown as Record<string, unknown>;
    const originalOffscreenCanvas = globalRecord.OffscreenCanvas;
    const originalDocument = globalRecord.document;

    globalRecord.OffscreenCanvas = undefined;
    delete globalRecord.document;

    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    try {
      const { ctx, calls } = createFakeContextWithAlphaTracking();
      const image = {} as unknown as CanvasImageSource;

      const rcb: RenderCommandBuffer = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 1,
          simTimeMs: 16,
          contentHash: 'content',
        },
        scene: {
          camera: { x: 0, y: 0, zoom: 1 },
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'image',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            assetId: 'image:test' as AssetId,
            x: 1,
            y: 2,
            width: 2,
            height: 3,
            tintRgba: 0x12_34_56_80,
          },
        ],
      };

      renderRenderCommandBufferToCanvas2d(ctx, rcb, {
        assets: { resolveImage: () => image },
      });

      expect(calls.map((c) => c.name)).toEqual(['drawImage']);
      expect(calls[0]?.args[0]).toBe(image);
      expect(calls[0]?.globalAlpha).toBeCloseTo(0x80 / 0xff);
      expect(ctx.globalAlpha).toBe(1);
    } finally {
      globalRecord.OffscreenCanvas = originalOffscreenCanvas;
      globalRecord.document = originalDocument;
    }
  });

  it('applies tintRgba as RGBA tint using a document-backed scratch canvas', async () => {
    const globalRecord = globalThis as unknown as Record<string, unknown>;
    const originalOffscreenCanvas = globalRecord.OffscreenCanvas;
    const originalDocument = globalRecord.document;
    const scratchCalls: Array<{
      name: string;
      args: readonly unknown[];
      state: {
        globalCompositeOperation: string;
        globalAlpha: number;
        fillStyle: unknown;
      };
    }> = [];

    class FakeScratchContext {
      globalCompositeOperation = 'source-over';
      globalAlpha = 1;
      fillStyle: unknown = '';

      clearRect(...args: readonly unknown[]): void {
        scratchCalls.push({ name: 'clearRect', args, state: this.#state() });
      }

      fillRect(...args: readonly unknown[]): void {
        scratchCalls.push({ name: 'fillRect', args, state: this.#state() });
      }

      drawImage(...args: readonly unknown[]): void {
        scratchCalls.push({ name: 'drawImage', args, state: this.#state() });
      }

      #state(): {
        globalCompositeOperation: string;
        globalAlpha: number;
        fillStyle: unknown;
      } {
        return {
          globalCompositeOperation: this.globalCompositeOperation,
          globalAlpha: this.globalAlpha,
          fillStyle: this.fillStyle,
        };
      }
    }

    class FakeCanvas {
      width = 0;
      height = 0;
      #ctx = new FakeScratchContext();

      getContext(type: string): FakeScratchContext | null {
        if (type !== '2d') {
          return null;
        }
        return this.#ctx;
      }
    }

    globalRecord.OffscreenCanvas = undefined;
    globalRecord.document = {
      createElement: () => new FakeCanvas() as unknown as HTMLCanvasElement,
    };

    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    try {
      const { ctx, calls } = createFakeContext();
      const image = { width: 2, height: 3 } as unknown as CanvasImageSource;

      const rcb: RenderCommandBuffer = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 1,
          simTimeMs: 16,
          contentHash: 'content',
        },
        scene: {
          camera: { x: 0, y: 0, zoom: 1 },
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'image',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            assetId: 'image:test' as AssetId,
            x: 1,
            y: 2,
            width: 2,
            height: 3,
            tintRgba: 0x12_34_56_80,
          },
        ],
      };

      renderRenderCommandBufferToCanvas2d(ctx, rcb, {
        assets: { resolveImage: () => image },
      });

      expect(calls.map((c) => c.name)).toEqual(['drawImage']);
      expect(calls[0]?.args[0]).toBeInstanceOf(FakeCanvas);

      const multiplyFill = scratchCalls.find((call) => call.name === 'fillRect');
      expect(multiplyFill?.state.globalCompositeOperation).toBe('multiply');
      expect(multiplyFill?.state.fillStyle).toBe('rgb(18, 52, 86)');

      let maskDraw: (typeof scratchCalls)[number] | undefined;
      for (let index = scratchCalls.length - 1; index >= 0; index -= 1) {
        const call = scratchCalls[index];
        if (call?.name === 'drawImage') {
          maskDraw = call;
          break;
        }
      }
      expect(maskDraw?.state.globalCompositeOperation).toBe('destination-in');
      expect(maskDraw?.state.globalAlpha).toBeCloseTo(0x80 / 0xff);
    } finally {
      globalRecord.OffscreenCanvas = originalOffscreenCanvas;
      globalRecord.document = originalDocument;
    }
  });

  it('falls back when a document scratch canvas cannot create a 2d context', async () => {
    const globalRecord = globalThis as unknown as Record<string, unknown>;
    const originalOffscreenCanvas = globalRecord.OffscreenCanvas;
    const originalDocument = globalRecord.document;

    class FakeCanvas {
      width = 0;
      height = 0;

      getContext(): null {
        return null;
      }
    }

    globalRecord.OffscreenCanvas = undefined;
    globalRecord.document = {
      createElement: () => new FakeCanvas() as unknown as HTMLCanvasElement,
    };

    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    try {
      const { ctx, calls } = createFakeContextWithAlphaTracking();
      const image = { width: 2, height: 3 } as unknown as CanvasImageSource;

      const rcb: RenderCommandBuffer = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 1,
          simTimeMs: 16,
          contentHash: 'content',
        },
        scene: {
          camera: { x: 0, y: 0, zoom: 1 },
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'image',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            assetId: 'image:test' as AssetId,
            x: 1,
            y: 2,
            width: 2,
            height: 3,
            tintRgba: 0x12_34_56_80,
          },
        ],
      };

      renderRenderCommandBufferToCanvas2d(ctx, rcb, {
        assets: { resolveImage: () => image },
      });

      expect(calls.map((c) => c.name)).toEqual(['drawImage']);
      expect(calls[0]?.args[0]).toBe(image);
      expect(calls[0]?.globalAlpha).toBeCloseTo(0x80 / 0xff);
      expect(ctx.globalAlpha).toBe(1);
    } finally {
      globalRecord.OffscreenCanvas = originalOffscreenCanvas;
      globalRecord.document = originalDocument;
    }
  });

  it('applies tintRgba as RGBA tint using OffscreenCanvas scratch', async () => {
    const globalRecord = globalThis as unknown as Record<string, unknown>;
    const originalOffscreenCanvas = globalRecord.OffscreenCanvas;
    const originalDocument = globalRecord.document;
    const scratchCalls: Array<{
      name: string;
      args: readonly unknown[];
      state: {
        globalCompositeOperation: string;
        globalAlpha: number;
        fillStyle: unknown;
      };
    }> = [];

    class FakeOffscreenContext {
      globalCompositeOperation = 'source-over';
      globalAlpha = 1;
      fillStyle: unknown = '';

      clearRect(...args: readonly unknown[]): void {
        scratchCalls.push({ name: 'clearRect', args, state: this.#state() });
      }

      fillRect(...args: readonly unknown[]): void {
        scratchCalls.push({ name: 'fillRect', args, state: this.#state() });
      }

      drawImage(...args: readonly unknown[]): void {
        scratchCalls.push({ name: 'drawImage', args, state: this.#state() });
      }

      #state(): {
        globalCompositeOperation: string;
        globalAlpha: number;
        fillStyle: unknown;
      } {
        return {
          globalCompositeOperation: this.globalCompositeOperation,
          globalAlpha: this.globalAlpha,
          fillStyle: this.fillStyle,
        };
      }
    }

    class FakeOffscreenCanvas {
      width: number;
      height: number;
      #ctx: FakeOffscreenContext;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
        this.#ctx = new FakeOffscreenContext();
      }

      getContext(type: string): FakeOffscreenContext | null {
        if (type !== '2d') {
          return null;
        }
        return this.#ctx;
      }
    }

    globalRecord.OffscreenCanvas = FakeOffscreenCanvas as unknown as typeof OffscreenCanvas;
    delete globalRecord.document;

    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    try {
      const { ctx, calls } = createFakeContext();
      const imageA = { width: 2, height: 3 } as unknown as CanvasImageSource;
      const imageB = { width: 4, height: 5 } as unknown as CanvasImageSource;

      const rcb: RenderCommandBuffer = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 1,
          simTimeMs: 16,
          contentHash: 'content',
        },
        scene: {
          camera: { x: 0, y: 0, zoom: 1 },
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'image',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            assetId: 'image:a' as AssetId,
            x: 1,
            y: 2,
            width: 2,
            height: 3,
            tintRgba: 0x12_34_56_80,
          },
          {
            kind: 'image',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
            assetId: 'image:b' as AssetId,
            x: 4,
            y: 5,
            width: 4,
            height: 5,
            tintRgba: 0x12_34_56_80,
          },
        ],
      };

      renderRenderCommandBufferToCanvas2d(ctx, rcb, {
        assets: {
          resolveImage: (assetId) => (assetId === ('image:a' as AssetId) ? imageA : imageB),
        },
      });

      expect(calls.map((c) => c.name)).toEqual(['drawImage', 'drawImage']);
      expect(calls[0]?.args[0]).toBeInstanceOf(FakeOffscreenCanvas);
      expect(calls[1]?.args[0]).toBeInstanceOf(FakeOffscreenCanvas);

      const firstScratchCanvas = calls[0]?.args[0] as unknown as FakeOffscreenCanvas;
      const secondScratchCanvas = calls[1]?.args[0] as unknown as FakeOffscreenCanvas;
      expect(secondScratchCanvas).toBe(firstScratchCanvas);
      expect(secondScratchCanvas.width).toBe(4);
      expect(secondScratchCanvas.height).toBe(5);

      const multiplyFill = scratchCalls.find((call) => call.name === 'fillRect');
      expect(multiplyFill?.state.globalCompositeOperation).toBe('multiply');
      expect(multiplyFill?.state.fillStyle).toBe('rgb(18, 52, 86)');
    } finally {
      globalRecord.OffscreenCanvas = originalOffscreenCanvas;
      globalRecord.document = originalDocument;
    }
  });

  it('falls back when OffscreenCanvas cannot provide a 2d context', async () => {
    const globalRecord = globalThis as unknown as Record<string, unknown>;
    const originalOffscreenCanvas = globalRecord.OffscreenCanvas;
    const originalDocument = globalRecord.document;

    class FakeOffscreenCanvas {
      width: number;
      height: number;

      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }

      getContext(): null {
        return null;
      }
    }

    globalRecord.OffscreenCanvas = FakeOffscreenCanvas as unknown as typeof OffscreenCanvas;
    delete globalRecord.document;

    vi.resetModules();
    const { renderRenderCommandBufferToCanvas2d } = await import(
      './canvas2d-renderer.js'
    );

    try {
      const { ctx, calls } = createFakeContextWithAlphaTracking();
      const image = { width: 2, height: 3 } as unknown as CanvasImageSource;

      const rcb: RenderCommandBuffer = {
        frame: {
          schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
          step: 1,
          simTimeMs: 16,
          contentHash: 'content',
        },
        scene: {
          camera: { x: 0, y: 0, zoom: 1 },
        },
        passes: [{ id: 'ui' }],
        draws: [
          {
            kind: 'image',
            passId: 'ui',
            sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
            assetId: 'image:test' as AssetId,
            x: 1,
            y: 2,
            width: 2,
            height: 3,
            tintRgba: 0x12_34_56_80,
          },
        ],
      };

      renderRenderCommandBufferToCanvas2d(ctx, rcb, {
        assets: { resolveImage: () => image },
      });

      expect(calls.map((c) => c.name)).toEqual(['drawImage']);
      expect(calls[0]?.args[0]).toBe(image);
      expect(calls[0]?.globalAlpha).toBeCloseTo(0x80 / 0xff);
      expect(ctx.globalAlpha).toBe(1);
    } finally {
      globalRecord.OffscreenCanvas = originalOffscreenCanvas;
      globalRecord.document = originalDocument;
    }
  });
});
