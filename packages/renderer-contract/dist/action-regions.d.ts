import type { RenderActionRegion } from './types.js';
export type ActionRegionHitTestOptions = Readonly<{
    readonly includeDisabled?: boolean;
}>;
export declare function isPointInActionRegion(region: RenderActionRegion, x: number, y: number): boolean;
export declare function hitTestActionRegions(regions: readonly RenderActionRegion[], x: number, y: number, options?: ActionRegionHitTestOptions): RenderActionRegion | undefined;
//# sourceMappingURL=action-regions.d.ts.map