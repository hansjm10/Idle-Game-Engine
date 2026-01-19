import type { AssetId } from '@idle-engine/renderer-contract';
export interface WebGpuAtlasImageInput {
    readonly assetId: AssetId;
    readonly width: number;
    readonly height: number;
}
export interface WebGpuAtlasLayoutEntry {
    readonly assetId: AssetId;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}
export interface WebGpuAtlasLayout {
    readonly schemaVersion: 1;
    readonly atlasWidthPx: number;
    readonly atlasHeightPx: number;
    readonly paddingPx: number;
    readonly entries: readonly WebGpuAtlasLayoutEntry[];
}
export interface WebGpuAtlasPackingOptions {
    /**
     * Maximum atlas dimension in pixels (width and height).
     */
    readonly maxSizePx?: number;
    /**
     * Gap between sprites packed into the atlas (both axes).
     */
    readonly paddingPx?: number;
    /**
     * When enabled, atlas dimensions are rounded up to powers of two.
     */
    readonly powerOfTwo?: boolean;
}
export interface WebGpuAtlasPackingResult {
    readonly atlasWidthPx: number;
    readonly atlasHeightPx: number;
    readonly paddingPx: number;
    readonly entries: readonly WebGpuAtlasLayoutEntry[];
}
declare function compareAssetId(a: AssetId, b: AssetId): number;
declare function nextPowerOfTwo(value: number): number;
declare function packShelf(images: readonly WebGpuAtlasImageInput[], atlasWidthPx: number, paddingPx: number): {
    readonly packedHeightPx: number;
    readonly entries: readonly WebGpuAtlasLayoutEntry[];
};
export declare function packAtlas(inputImages: readonly WebGpuAtlasImageInput[], options?: WebGpuAtlasPackingOptions): WebGpuAtlasPackingResult;
export declare function createAtlasLayout(result: WebGpuAtlasPackingResult): WebGpuAtlasLayout;
export declare const __test__: {
    compareAssetId: typeof compareAssetId;
    nextPowerOfTwo: typeof nextPowerOfTwo;
    packShelf: typeof packShelf;
};
export {};
//# sourceMappingURL=atlas-packer.d.ts.map