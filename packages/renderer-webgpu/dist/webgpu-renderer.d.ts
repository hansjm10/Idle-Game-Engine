import type { RenderCommandBuffer } from '@idle-engine/renderer-contract';
export declare class WebGpuNotSupportedError extends Error {
    name: string;
}
export declare class WebGpuDeviceLostError extends Error {
    name: string;
    readonly reason: GPUDeviceLostReason | undefined;
    constructor(message: string, reason?: GPUDeviceLostReason);
}
export interface WebGpuRendererResizeOptions {
    readonly devicePixelRatio?: number;
}
export interface WebGpuRendererCreateOptions {
    readonly powerPreference?: GPUPowerPreference;
    readonly alphaMode?: GPUCanvasAlphaMode;
    readonly deviceDescriptor?: GPUDeviceDescriptor;
    readonly requiredFeatures?: readonly GPUFeatureName[];
    readonly preferredFormats?: readonly GPUTextureFormat[];
    readonly onDeviceLost?: (error: WebGpuDeviceLostError) => void;
}
export interface WebGpuRenderer {
    readonly canvas: HTMLCanvasElement;
    readonly context: GPUCanvasContext;
    readonly device: GPUDevice;
    readonly adapter: GPUAdapter;
    readonly format: GPUTextureFormat;
    resize(options?: WebGpuRendererResizeOptions): void;
    render(rcb: RenderCommandBuffer): void;
    dispose(): void;
}
declare function colorRgbaToGpuColor(colorRgba: number): GPUColor;
declare function selectClearColor(rcb: RenderCommandBuffer): GPUColor;
declare function getCanvasPixelSize(canvas: HTMLCanvasElement, devicePixelRatio: number): {
    width: number;
    height: number;
};
export declare function createWebGpuRenderer(canvas: HTMLCanvasElement, options?: WebGpuRendererCreateOptions): Promise<WebGpuRenderer>;
export declare const __test__: {
    colorRgbaToGpuColor: typeof colorRgbaToGpuColor;
    getCanvasPixelSize: typeof getCanvasPixelSize;
    selectClearColor: typeof selectClearColor;
};
export {};
//# sourceMappingURL=webgpu-renderer.d.ts.map