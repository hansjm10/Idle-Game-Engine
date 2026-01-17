import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';

export interface RenderCommandBufferStepper {
  readonly size: number;
  readonly index: number;
  readonly current: RenderCommandBuffer | undefined;
  seek(index: number): RenderCommandBuffer | undefined;
  next(): RenderCommandBuffer | undefined;
  prev(): RenderCommandBuffer | undefined;
}

export function createRenderCommandBufferStepper(
  frames: readonly RenderCommandBuffer[],
): RenderCommandBufferStepper {
  let index = frames.length > 0 ? 0 : -1;

  function current(): RenderCommandBuffer | undefined {
    if (index < 0) {
      return undefined;
    }
    return frames[index];
  }

  function seek(nextIndex: number): RenderCommandBuffer | undefined {
    if (frames.length === 0) {
      index = -1;
      return undefined;
    }

    if (nextIndex < 0) {
      index = 0;
      return frames[index];
    }

    if (nextIndex >= frames.length) {
      index = frames.length - 1;
      return frames[index];
    }

    index = nextIndex;
    return frames[index];
  }

  return {
    get size() {
      return frames.length;
    },
    get index() {
      return index;
    },
    get current() {
      return current();
    },
    seek,
    next() {
      return seek(index + 1);
    },
    prev() {
      return seek(index - 1);
    },
  };
}
