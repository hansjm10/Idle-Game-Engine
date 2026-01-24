import type { AssetId, AssetManifest, Camera2D, RenderCommandBuffer, Sha256Hex } from '@idle-engine/renderer-contract';
import type { WebGpuAtlasLayout } from './atlas-packer.js';
export declare class WebGpuNotSupportedError extends Error {
    name: string;
}
export declare class WebGpuDeviceLostError extends Error {
    name: string;
    readonly reason: GPUDeviceLostReason | undefined;
    constructor(message: string, reason?: GPUDeviceLostReason);
}
export interface WebGpuRendererLimits {
    /**
     * Maximum number of entries allowed in `AssetManifest.assets`.
     *
     * Default: 10_000
     */
    readonly maxAssets?: number;
    /**
     * Maximum number of draws allowed in a single `RenderCommandBuffer`.
     *
     * Default: 100_000
     */
    readonly maxDrawsPerFrame?: number;
    /**
     * Maximum text length (measured in JavaScript UTF-16 code units, i.e. `text.length`)
     * allowed per `TextDraw`.
     *
     * Default: 10_000
     */
    readonly maxTextLength?: number;
}
export interface WebGpuRendererResizeOptions {
    readonly devicePixelRatio?: number;
}
export interface WebGpuBitmapFontGlyph {
    readonly codePoint: number;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly xOffsetPx: number;
    readonly yOffsetPx: number;
    readonly xAdvancePx: number;
}
export interface WebGpuBitmapFont {
    readonly image: GPUImageCopyExternalImageSource;
    readonly baseFontSizePx: number;
    readonly lineHeightPx: number;
    readonly glyphs: readonly WebGpuBitmapFontGlyph[];
    readonly fallbackCodePoint?: number;
}
export interface WebGpuRendererAssets {
    loadImage(assetId: AssetId, contentHash: Sha256Hex): Promise<GPUImageCopyExternalImageSource>;
    loadFont?(assetId: AssetId, contentHash: Sha256Hex): Promise<WebGpuBitmapFont>;
}
export interface WebGpuRendererLoadAssetsOptions {
    readonly maxAtlasSizePx?: number;
    readonly paddingPx?: number;
    readonly powerOfTwo?: boolean;
}
export interface WebGpuRendererAtlasState {
    readonly layout: WebGpuAtlasLayout;
    readonly layoutHash: Sha256Hex;
}
export interface WebGpuRendererCreateOptions {
    readonly powerPreference?: GPUPowerPreference;
    readonly alphaMode?: GPUCanvasAlphaMode;
    readonly deviceDescriptor?: GPUDeviceDescriptor;
    readonly requiredFeatures?: readonly GPUFeatureName[];
    readonly preferredFormats?: readonly GPUTextureFormat[];
    /**
     * Caps applied to untrusted inputs passed to `loadAssets(...)` and `render(...)`.
     *
     * Defaults are documented in `WebGpuRendererLimits`.
     */
    readonly limits?: WebGpuRendererLimits;
    /**
     * World-pass draw coordinates in `RenderCommandBuffer` are expected to be fixed-point integers
     * produced by `compileViewModelToRenderCommandBuffer` (`value * worldFixedPointScale`).
     *
     * Set to `1` if you are supplying world coordinates as unscaled floats.
     */
    readonly worldFixedPointScale?: number;
    readonly onDeviceLost?: (error: WebGpuDeviceLostError) => void;
}
export interface WebGpuRenderer {
    readonly canvas: HTMLCanvasElement;
    readonly context: GPUCanvasContext;
    readonly device: GPUDevice;
    readonly adapter: GPUAdapter;
    readonly format: GPUTextureFormat;
    readonly atlasLayout: WebGpuAtlasLayout | undefined;
    readonly atlasLayoutHash: Sha256Hex | undefined;
    resize(options?: WebGpuRendererResizeOptions): void;
    loadAssets(manifest: AssetManifest, assets: WebGpuRendererAssets, options?: WebGpuRendererLoadAssetsOptions): Promise<WebGpuRendererAtlasState>;
    setWorldCamera(camera: Camera2D): void;
    render(rcb: RenderCommandBuffer): void;
    dispose(): void;
}
declare function colorRgbaToGpuColor(colorRgba: number): GPUColor;
declare function selectClearColor(rcb: RenderCommandBuffer): GPUColor;
declare function getCanvasPixelSize(canvas: HTMLCanvasElement, devicePixelRatio: number): {
    width: number;
    height: number;
};
declare function getExternalImageSize(source: GPUImageCopyExternalImageSource): {
    width: number;
    height: number;
};
export declare function createWebGpuRenderer(canvas: HTMLCanvasElement, options?: WebGpuRendererCreateOptions): Promise<WebGpuRenderer>;
export declare const __test__: {
    colorRgbaToGpuColor: typeof colorRgbaToGpuColor;
    getCanvasPixelSize: typeof getCanvasPixelSize;
    selectClearColor: typeof selectClearColor;
    getExternalImageSize: typeof getExternalImageSize;
};
export {};
//# sourceMappingURL=webgpu-renderer.d.ts.map