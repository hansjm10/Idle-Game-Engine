import { describe, expect, it } from 'vitest';

import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
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

function createSampleRcb(): RenderCommandBuffer {
  return {
    frame: {
      schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
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
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
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

  it('flags schemaVersion mismatches', () => {
    const rcb = {
      frame: {
        schemaVersion: 1,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
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

  it('flags non-string draw kinds', () => {
    const rcb = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
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

  it('flags duplicate pass ids', () => {
    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
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

  it('applies nested scissor clipping with pixelRatio scaling', () => {
    const { ctx, calls } = createFakeContext();

    const rcb: RenderCommandBuffer = {
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step: 1,
        simTimeMs: 16,
        contentHash: 'content',
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
});
