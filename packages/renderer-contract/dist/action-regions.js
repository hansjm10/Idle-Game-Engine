export function isPointInActionRegion(region, x, y) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return false;
    }
    return (x >= region.x &&
        x < region.x + region.width &&
        y >= region.y &&
        y < region.y + region.height);
}
export function hitTestActionRegions(regions, x, y, options = {}) {
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
//# sourceMappingURL=action-regions.js.map