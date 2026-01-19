const DEFAULT_MAX_SIZE_PX = 2048;
const DEFAULT_PADDING_PX = 2;
function compareAssetId(a, b) {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}
function nextPowerOfTwo(value) {
    if (!Number.isFinite(value) || value <= 0) {
        return 1;
    }
    let result = 1;
    while (result < value) {
        result *= 2;
    }
    return result;
}
function packShelf(images, atlasWidthPx, paddingPx) {
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    const entries = [];
    for (const image of images) {
        if (image.width <= 0 || image.height <= 0) {
            throw new Error(`Atlas image ${image.assetId} has invalid size ${image.width}x${image.height}.`);
        }
        if (image.width > atlasWidthPx) {
            throw new Error(`Atlas image ${image.assetId} width (${image.width}) exceeds atlas width (${atlasWidthPx}).`);
        }
        if (cursorX > 0 && cursorX + image.width > atlasWidthPx) {
            cursorX = 0;
            cursorY += rowHeight + paddingPx;
            rowHeight = 0;
        }
        entries.push({
            assetId: image.assetId,
            x: cursorX,
            y: cursorY,
            width: image.width,
            height: image.height,
        });
        cursorX += image.width + paddingPx;
        rowHeight = Math.max(rowHeight, image.height);
    }
    const packedHeightPx = cursorY + rowHeight;
    return { packedHeightPx, entries };
}
export function packAtlas(inputImages, options = {}) {
    const maxSizePx = options.maxSizePx ?? DEFAULT_MAX_SIZE_PX;
    const paddingPx = options.paddingPx ?? DEFAULT_PADDING_PX;
    const powerOfTwo = options.powerOfTwo ?? true;
    if (!Number.isFinite(maxSizePx) || maxSizePx <= 0) {
        throw new Error(`Invalid atlas maxSizePx: ${maxSizePx}`);
    }
    if (!Number.isFinite(paddingPx) || paddingPx < 0) {
        throw new Error(`Invalid atlas paddingPx: ${paddingPx}`);
    }
    const images = [...inputImages].sort((a, b) => compareAssetId(a.assetId, b.assetId));
    for (let i = 1; i < images.length; i += 1) {
        const previous = images[i - 1];
        const current = images[i];
        if (previous && current && previous.assetId === current.assetId) {
            throw new Error(`Atlas input contains duplicate AssetId: ${current.assetId}`);
        }
    }
    let maxImageWidth = 1;
    for (const image of images) {
        maxImageWidth = Math.max(maxImageWidth, image.width);
    }
    let atlasWidthPx = powerOfTwo ? nextPowerOfTwo(maxImageWidth) : maxImageWidth;
    if (atlasWidthPx > maxSizePx) {
        throw new Error(`Atlas requires width ${atlasWidthPx} but maxSizePx is ${maxSizePx}.`);
    }
    while (true) {
        const { packedHeightPx, entries } = packShelf(images, atlasWidthPx, paddingPx);
        const atlasHeightCandidate = powerOfTwo ? nextPowerOfTwo(packedHeightPx) : packedHeightPx;
        if (atlasHeightCandidate <= maxSizePx) {
            return {
                atlasWidthPx,
                atlasHeightPx: atlasHeightCandidate,
                paddingPx,
                entries,
            };
        }
        const nextAtlasWidthPx = powerOfTwo ? atlasWidthPx * 2 : Math.min(maxSizePx, atlasWidthPx * 2);
        if (nextAtlasWidthPx === atlasWidthPx) {
            throw new Error(`Atlas packing exceeded maxSizePx ${maxSizePx} (height needed ${atlasHeightCandidate}).`);
        }
        atlasWidthPx = nextAtlasWidthPx;
        if (atlasWidthPx > maxSizePx) {
            throw new Error(`Atlas packing exceeded maxSizePx ${maxSizePx} (height needed ${atlasHeightCandidate}).`);
        }
    }
}
export function createAtlasLayout(result) {
    return {
        schemaVersion: 1,
        atlasWidthPx: result.atlasWidthPx,
        atlasHeightPx: result.atlasHeightPx,
        paddingPx: result.paddingPx,
        entries: result.entries,
    };
}
export const __test__ = {
    compareAssetId,
    nextPowerOfTwo,
    packShelf,
};
//# sourceMappingURL=atlas-packer.js.map