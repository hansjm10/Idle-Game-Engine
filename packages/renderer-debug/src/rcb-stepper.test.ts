import { describe, expect, it } from 'vitest';

import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

import { createRenderCommandBufferStepper } from './rcb-stepper.js';

function createRcb(step: number): RenderCommandBuffer {
  return {
    frame: {
      schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
      step,
      simTimeMs: step * 16,
      contentHash: 'content',
    },
    scene: {
      camera: { x: 0, y: 0, zoom: 1 },
    },
    passes: [{ id: 'ui' }],
    draws: [],
  };
}

describe('createRenderCommandBufferStepper', () => {
  it('returns an empty stepper for no frames', () => {
    const stepper = createRenderCommandBufferStepper([]);
    expect(stepper.size).toBe(0);
    expect(stepper.index).toBe(-1);
    expect(stepper.current).toBeUndefined();
    expect(stepper.next()).toBeUndefined();
    expect(stepper.prev()).toBeUndefined();
  });

  it('clamps seek/next/prev within bounds', () => {
    const a = createRcb(1);
    const b = createRcb(2);
    const stepper = createRenderCommandBufferStepper([a, b]);

    expect(stepper.size).toBe(2);
    expect(stepper.index).toBe(0);
    expect(stepper.current).toBe(a);

    expect(stepper.prev()).toBe(a);
    expect(stepper.index).toBe(0);

    expect(stepper.next()).toBe(b);
    expect(stepper.index).toBe(1);

    expect(stepper.next()).toBe(b);
    expect(stepper.index).toBe(1);

    expect(stepper.seek(999)).toBe(b);
    expect(stepper.index).toBe(1);

    expect(stepper.seek(-5)).toBe(a);
    expect(stepper.index).toBe(0);
  });
});
