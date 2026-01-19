import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';
export interface RenderCommandBufferStepper {
    readonly size: number;
    readonly index: number;
    readonly current: RenderCommandBuffer | undefined;
    seek(index: number): RenderCommandBuffer | undefined;
    next(): RenderCommandBuffer | undefined;
    prev(): RenderCommandBuffer | undefined;
}
export declare function createRenderCommandBufferStepper(frames: readonly RenderCommandBuffer[]): RenderCommandBufferStepper;
//# sourceMappingURL=rcb-stepper.d.ts.map