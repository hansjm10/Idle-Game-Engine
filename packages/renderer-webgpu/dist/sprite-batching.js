function compareNumbers(a, b) {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}
function compareSortKey(a, b) {
    const hi = compareNumbers(a.sortKeyHi, b.sortKeyHi);
    if (hi !== 0) {
        return hi;
    }
    return compareNumbers(a.sortKeyLo, b.sortKeyLo);
}
export function orderDrawsByPassAndSortKey(rcb) {
    const passIndexById = new Map();
    for (let index = 0; index < rcb.passes.length; index += 1) {
        const pass = rcb.passes[index];
        if (pass && !passIndexById.has(pass.id)) {
            passIndexById.set(pass.id, index);
        }
    }
    const ordered = [];
    for (let index = 0; index < rcb.draws.length; index += 1) {
        const draw = rcb.draws[index];
        if (draw.kind === 'clear') {
            continue;
        }
        ordered.push({
            draw,
            originalIndex: index,
            passId: draw.passId,
            passIndex: passIndexById.get(draw.passId) ?? Number.MAX_SAFE_INTEGER,
            sortKey: draw.sortKey,
        });
    }
    ordered.sort((a, b) => {
        const pass = compareNumbers(a.passIndex, b.passIndex);
        if (pass !== 0) {
            return pass;
        }
        const sortKey = compareSortKey(a.sortKey, b.sortKey);
        if (sortKey !== 0) {
            return sortKey;
        }
        return compareNumbers(a.originalIndex, b.originalIndex);
    });
    return ordered;
}
const FLOATS_PER_SPRITE_INSTANCE = 12;
export function buildSpriteInstances(options) {
    const imageDraws = [];
    for (const entry of options.orderedDraws) {
        if (entry.draw.kind === 'image') {
            imageDraws.push({ passId: entry.passId, draw: entry.draw });
        }
    }
    const instances = new Float32Array(imageDraws.length * FLOATS_PER_SPRITE_INSTANCE);
    const groups = [];
    let writeOffset = 0;
    let currentGroupPass;
    let currentGroupFirstInstance = 0;
    function pushGroup(endInstance) {
        if (currentGroupPass === undefined) {
            return;
        }
        const instanceCount = endInstance - currentGroupFirstInstance;
        if (instanceCount <= 0) {
            return;
        }
        groups.push({
            passId: currentGroupPass,
            firstInstance: currentGroupFirstInstance,
            instanceCount,
        });
    }
    for (let index = 0; index < imageDraws.length; index += 1) {
        const imageDraw = imageDraws[index];
        if (!imageDraw) {
            continue;
        }
        if (currentGroupPass === undefined) {
            currentGroupPass = imageDraw.passId;
            currentGroupFirstInstance = index;
        }
        else if (currentGroupPass !== imageDraw.passId) {
            pushGroup(index);
            currentGroupPass = imageDraw.passId;
            currentGroupFirstInstance = index;
        }
        const uv = options.uvByAssetId.get(imageDraw.draw.assetId);
        if (!uv) {
            throw new Error(`Atlas missing UVs for AssetId: ${imageDraw.draw.assetId}`);
        }
        const tintRgba = imageDraw.draw.tintRgba;
        const tint = tintRgba === undefined ? undefined : tintRgba >>> 0;
        const tintRed = tint === undefined ? 1 : ((tint >>> 24) & 0xff) / 255;
        const tintGreen = tint === undefined ? 1 : ((tint >>> 16) & 0xff) / 255;
        const tintBlue = tint === undefined ? 1 : ((tint >>> 8) & 0xff) / 255;
        const tintAlpha = tint === undefined ? 1 : (tint & 0xff) / 255;
        instances[writeOffset++] = imageDraw.draw.x;
        instances[writeOffset++] = imageDraw.draw.y;
        instances[writeOffset++] = imageDraw.draw.width;
        instances[writeOffset++] = imageDraw.draw.height;
        instances[writeOffset++] = uv.u0;
        instances[writeOffset++] = uv.v0;
        instances[writeOffset++] = uv.u1;
        instances[writeOffset++] = uv.v1;
        instances[writeOffset++] = tintRed;
        instances[writeOffset++] = tintGreen;
        instances[writeOffset++] = tintBlue;
        instances[writeOffset++] = tintAlpha;
    }
    pushGroup(imageDraws.length);
    return {
        instances,
        groups,
        instanceCount: imageDraws.length,
    };
}
export const __test__ = {
    compareSortKey,
    FLOATS_PER_SPRITE_INSTANCE,
};
//# sourceMappingURL=sprite-batching.js.map