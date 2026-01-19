import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';
export type RenderCommandBufferValidationResult = {
    readonly ok: true;
} | {
    readonly ok: false;
    readonly errors: readonly string[];
};
export declare function validateRenderCommandBuffer(rcb: RenderCommandBuffer): RenderCommandBufferValidationResult;
//# sourceMappingURL=rcb-validation.d.ts.map