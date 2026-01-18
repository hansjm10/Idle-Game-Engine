import { describe, expect, it } from 'vitest';

import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

import {
  createRenderCommandBufferStepper,
  rgbaToCssColor,
  renderRenderCommandBufferToCanvas2d,
  validateRenderCommandBuffer,
} from './index.js';

describe('renderer-debug public API', () => {
  it('exports the expected surface area', () => {
    expect(typeof renderRenderCommandBufferToCanvas2d).toBe('function');
    expect(typeof validateRenderCommandBuffer).toBe('function');
    expect(typeof createRenderCommandBufferStepper).toBe('function');
    expect(typeof rgbaToCssColor).toBe('function');
  });
});

describe('rgbaToCssColor', () => {
  it('formats alpha without trailing zeros', () => {
    expect(rgbaToCssColor(0x00_00_00_ff)).toBe('rgba(0, 0, 0, 1)');
    expect(rgbaToCssColor(0x00_00_00_00)).toBe('rgba(0, 0, 0, 0)');
    expect(rgbaToCssColor(0x00_00_00_33)).toBe('rgba(0, 0, 0, 0.2)');
  });
});

describe('createRenderCommandBufferStepper', () => {
  it('handles empty frame lists', () => {
    const stepper = createRenderCommandBufferStepper([]);

    expect(stepper.size).toBe(0);
    expect(stepper.index).toBe(-1);
    expect(stepper.current).toBeUndefined();
    expect(stepper.seek(0)).toBeUndefined();
    expect(stepper.next()).toBeUndefined();
    expect(stepper.prev()).toBeUndefined();
  });

  it('clamps seeks to valid indices', () => {
    const makeFrame = (step: number): RenderCommandBuffer => ({
      frame: {
        schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
        step,
        simTimeMs: 0,
        contentHash: 'content',
      },
      passes: [],
      draws: [],
    });

    const first = makeFrame(1);
    const second = makeFrame(2);

    const stepper = createRenderCommandBufferStepper([first, second]);

    expect(stepper.size).toBe(2);
    expect(stepper.index).toBe(0);
    expect(stepper.current).toBe(first);

    expect(stepper.seek(10)).toBe(second);
    expect(stepper.index).toBe(1);

    expect(stepper.seek(-1)).toBe(first);
    expect(stepper.index).toBe(0);

    expect(stepper.next()).toBe(second);
    expect(stepper.next()).toBe(second);
    expect(stepper.prev()).toBe(first);
    expect(stepper.prev()).toBe(first);
  });
});

