import type { AssetId, RenderCommandBuffer, RenderDraw, RenderPassId, SortKey } from '@idle-engine/renderer-contract';
export interface OrderedDraw {
    readonly draw: RenderDraw;
    readonly originalIndex: number;
    readonly passId: RenderPassId;
    readonly passIndex: number;
    readonly sortKey: SortKey;
}
export interface SpriteUvRect {
    readonly u0: number;
    readonly v0: number;
    readonly u1: number;
    readonly v1: number;
}
export interface SpriteInstanceGroup {
    readonly passId: RenderPassId;
    readonly firstInstance: number;
    readonly instanceCount: number;
}
export interface SpriteInstanceBuildResult {
    readonly instances: Float32Array;
    readonly groups: readonly SpriteInstanceGroup[];
    readonly instanceCount: number;
}
declare function compareSortKey(a: SortKey, b: SortKey): number;
export declare function orderDrawsByPassAndSortKey(rcb: RenderCommandBuffer): readonly OrderedDraw[];
export declare function buildSpriteInstances(options: {
    readonly orderedDraws: readonly OrderedDraw[];
    readonly uvByAssetId: ReadonlyMap<AssetId, SpriteUvRect>;
}): SpriteInstanceBuildResult;
export declare const __test__: {
    compareSortKey: typeof compareSortKey;
    FLOATS_PER_SPRITE_INSTANCE: number;
};
export {};
//# sourceMappingURL=sprite-batching.d.ts.map