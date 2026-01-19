const DEFAULT_MAX_SIZE_PX = 2048;
const DEFAULT_PADDING_PX = 2;
function getPackingConfig(options) {
    const maxSizePx = options.maxSizePx ?? DEFAULT_MAX_SIZE_PX;
    const paddingPx = options.paddingPx ?? DEFAULT_PADDING_PX;
    const powerOfTwo = options.powerOfTwo ?? true;
    if (!Number.isFinite(maxSizePx) || maxSizePx <= 0) {
        throw new Error(`Invalid atlas maxSizePx: ${maxSizePx}`);
    }
    if (!Number.isFinite(paddingPx) || paddingPx < 0) {
        throw new Error(`Invalid atlas paddingPx: ${paddingPx}`);
    }
    return { maxSizePx, paddingPx, powerOfTwo };
}
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
function assertNoDuplicateAssetIds(images) {
    for (let index = 1; index < images.length; index += 1) {
        if (images[index - 1].assetId === images[index].assetId) {
            throw new Error(`Atlas input contains duplicate AssetId: ${images[index].assetId}`);
        }
    }
}
function getMaxImageWidth(images) {
    let maxImageWidth = 1;
    for (const image of images) {
        maxImageWidth = Math.max(maxImageWidth, image.width);
    }
    return maxImageWidth;
}
function getNextAtlasWidth(options) {
    const nextWidth = options.currentAtlasWidthPx * 2;
    if (options.powerOfTwo) {
        return nextWidth;
    }
    return Math.min(options.maxSizePx, nextWidth);
}
function packWithGrowingWidth(options) {
    let atlasWidthPx = options.initialAtlasWidthPx;
    while (true) {
        const { packedHeightPx, entries } = packShelf(options.images, atlasWidthPx, options.paddingPx);
        const atlasHeightCandidate = options.powerOfTwo ? nextPowerOfTwo(packedHeightPx) : packedHeightPx;
        if (atlasHeightCandidate <= options.maxSizePx) {
            return {
                atlasWidthPx,
                atlasHeightPx: atlasHeightCandidate,
                paddingPx: options.paddingPx,
                entries,
            };
        }
        const nextAtlasWidthPx = getNextAtlasWidth({
            currentAtlasWidthPx: atlasWidthPx,
            maxSizePx: options.maxSizePx,
            powerOfTwo: options.powerOfTwo,
        });
        if (nextAtlasWidthPx <= atlasWidthPx || nextAtlasWidthPx > options.maxSizePx) {
            throw new Error(`Atlas packing exceeded maxSizePx ${options.maxSizePx} (height needed ${atlasHeightCandidate}).`);
        }
        atlasWidthPx = nextAtlasWidthPx;
    }
}
export function packAtlas(inputImages, options = {}) {
    const { maxSizePx, paddingPx, powerOfTwo } = getPackingConfig(options);
    const images = [...inputImages].sort((a, b) => compareAssetId(a.assetId, b.assetId));
    assertNoDuplicateAssetIds(images);
    const maxImageWidth = getMaxImageWidth(images);
    const initialAtlasWidthPx = powerOfTwo ? nextPowerOfTwo(maxImageWidth) : maxImageWidth;
    if (initialAtlasWidthPx > maxSizePx) {
        throw new Error(`Atlas requires width ${initialAtlasWidthPx} but maxSizePx is ${maxSizePx}.`);
    }
    return packWithGrowingWidth({
        images,
        initialAtlasWidthPx,
        maxSizePx,
        paddingPx,
        powerOfTwo,
    });
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