import type { RenderCommandBuffer, ViewModel } from './types.js';
export declare const WORLD_FIXED_POINT_SCALE: 256;
export type CompileViewModelToRenderCommandBufferOptions = Readonly<{
    worldFixedPointScale?: number;
}>;
declare function quantizeToInt(value: number, scale: number, label: string): number;
declare function encodeSignedInt32ToSortableUint32(value: number, label: string): number;
export declare function compileViewModelToRenderCommandBuffer(viewModel: ViewModel, options?: CompileViewModelToRenderCommandBufferOptions): RenderCommandBuffer;
export declare const __test__: {
    quantizeToInt: typeof quantizeToInt;
    encodeSignedInt32ToSortableUint32: typeof encodeSignedInt32ToSortableUint32;
};
export {};
//# sourceMappingURL=render-compiler.d.ts.map