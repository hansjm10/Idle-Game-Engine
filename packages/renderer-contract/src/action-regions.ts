import type { RenderActionRegion } from './types.js';

export type ActionRegionHitTestOptions = Readonly<{
  readonly includeDisabled?: boolean;
}>;

export function isPointInActionRegion(
  region: RenderActionRegion,
  x: number,
  y: number,
): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }

  return (
    x >= region.x &&
    x < region.x + region.width &&
    y >= region.y &&
    y < region.y + region.height
  );
}

export function hitTestActionRegions(
  regions: readonly RenderActionRegion[],
  x: number,
  y: number,
  options: ActionRegionHitTestOptions = {},
): RenderActionRegion | undefined {
  for (let index = regions.length - 1; index >= 0; index -= 1) {
    const region = regions[index];
    if (!isPointInActionRegion(region, x, y)) {
      continue;
    }
    if (!region.enabled && options.includeDisabled !== true) {
      return undefined;
    }
    return region;
  }

  return undefined;
}
