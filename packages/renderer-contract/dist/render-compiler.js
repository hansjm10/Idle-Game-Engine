export const WORLD_FIXED_POINT_SCALE = 256;
function compareNumbers(a, b) {
    if (a < b) {
        return -1;
    }
    if (a > b) {
        return 1;
    }
    return 0;
}
function compareStrings(a, b) {
    if (a === b) {
        return 0;
    }
    return a < b ? -1 : 1;
}
function compareSortKey(a, b) {
    const hi = compareNumbers(a.sortKeyHi, b.sortKeyHi);
    if (hi !== 0) {
        return hi;
    }
    return compareNumbers(a.sortKeyLo, b.sortKeyLo);
}
function requireFiniteNumber(value, label) {
    if (!Number.isFinite(value)) {
        throw new TypeError(`Render compiler expected ${label} to be a finite number.`);
    }
    return value;
}
function roundAwayFromZero(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    if (value < 0) {
        return Math.ceil(value - 0.5);
    }
    return Math.floor(value + 0.5);
}
function quantizeToInt(value, scale, label) {
    const finite = requireFiniteNumber(value, label);
    const scaled = finite * scale;
    if (!Number.isFinite(scaled)) {
        throw new TypeError(`Render compiler expected ${label} to be within quantizable range.`);
    }
    const quantized = roundAwayFromZero(scaled);
    return quantized === 0 ? 0 : quantized;
}
function requireInt32(value, label) {
    if (!Number.isInteger(value)) {
        throw new TypeError(`Render compiler expected ${label} to be an integer.`);
    }
    if (value < -2147483648 || value > 2147483647) {
        throw new TypeError(`Render compiler expected ${label} to fit in int32.`);
    }
    return value;
}
function encodeSignedInt32ToSortableUint32(value, label) {
    const int32 = requireInt32(value, label);
    return (int32 ^ 0x80000000) >>> 0;
}
function requireNonEmptyString(value, label) {
    if (value.trim().length === 0) {
        throw new Error(`Render compiler expected ${label} to be a non-empty string.`);
    }
    return value;
}
function createPasses() {
    return [{ id: 'world' }, { id: 'ui' }];
}
function getPassIndex(passId) {
    return passId === 'world' ? 0 : 1;
}
function sortDrawEntries(entries) {
    const seenKeys = new Set();
    for (const entry of entries) {
        if (seenKeys.has(entry.drawKey)) {
            throw new Error(`Render compiler produced duplicate drawKey: ${entry.drawKey}`);
        }
        seenKeys.add(entry.drawKey);
    }
    entries.sort((a, b) => {
        const pass = compareNumbers(getPassIndex(a.passId), getPassIndex(b.passId));
        if (pass !== 0) {
            return pass;
        }
        const sortKey = compareSortKey(a.sortKey, b.sortKey);
        if (sortKey !== 0) {
            return sortKey;
        }
        return compareStrings(a.drawKey, b.drawKey);
    });
}
function compileSpriteInstance(sprite, options) {
    const id = requireNonEmptyString(sprite.id, 'SpriteInstance.id');
    const assetId = requireNonEmptyString(sprite.assetId, 'SpriteInstance.assetId');
    const x = quantizeToInt(sprite.x, options.worldFixedPointScale, `SpriteInstance(${id}).x`);
    const y = quantizeToInt(sprite.y, options.worldFixedPointScale, `SpriteInstance(${id}).y`);
    const width = quantizeToInt(sprite.width, options.worldFixedPointScale, `SpriteInstance(${id}).width`);
    const height = quantizeToInt(sprite.height, options.worldFixedPointScale, `SpriteInstance(${id}).height`);
    const z = quantizeToInt(sprite.z, options.worldFixedPointScale, `SpriteInstance(${id}).z`);
    const sortKey = {
        sortKeyHi: encodeSignedInt32ToSortableUint32(z, `SpriteInstance(${id}).sortKeyHi`),
        sortKeyLo: encodeSignedInt32ToSortableUint32(y, `SpriteInstance(${id}).sortKeyLo`),
    };
    const draw = {
        kind: 'image',
        passId: 'world',
        sortKey,
        assetId,
        x,
        y,
        width,
        height,
        tintRgba: sprite.tintRgba,
    };
    return {
        passId: 'world',
        sortKey,
        drawKey: `world:sprite:${id}`,
        draw,
    };
}
function compileUiNode(node) {
    const id = requireNonEmptyString(node.id, 'UiNode.id');
    const x = quantizeToInt(node.x, 1, `UiNode(${id}).x`);
    const y = quantizeToInt(node.y, 1, `UiNode(${id}).y`);
    const width = quantizeToInt(node.width, 1, `UiNode(${id}).width`);
    const height = quantizeToInt(node.height, 1, `UiNode(${id}).height`);
    const sortKey = {
        sortKeyHi: encodeSignedInt32ToSortableUint32(y, `UiNode(${id}).sortKeyHi`),
        sortKeyLo: encodeSignedInt32ToSortableUint32(x, `UiNode(${id}).sortKeyLo`),
    };
    switch (node.kind) {
        case 'rect': {
            const draw = {
                kind: 'rect',
                passId: 'ui',
                sortKey,
                x,
                y,
                width,
                height,
                colorRgba: node.colorRgba,
            };
            return [
                {
                    passId: 'ui',
                    sortKey,
                    drawKey: `ui:rect:${id}`,
                    draw,
                },
            ];
        }
        case 'image': {
            const assetId = requireNonEmptyString(node.assetId, `UiImageNode(${id}).assetId`);
            const draw = {
                kind: 'image',
                passId: 'ui',
                sortKey,
                assetId,
                x,
                y,
                width,
                height,
                tintRgba: node.tintRgba,
            };
            return [
                {
                    passId: 'ui',
                    sortKey,
                    drawKey: `ui:image:${id}`,
                    draw,
                },
            ];
        }
        case 'text': {
            const fontSizePx = quantizeToInt(node.fontSizePx, 1, `UiTextNode(${id}).fontSizePx`);
            const draw = {
                kind: 'text',
                passId: 'ui',
                sortKey,
                x,
                y,
                text: node.text,
                colorRgba: node.colorRgba,
                fontAssetId: node.fontAssetId,
                fontSizePx,
            };
            return [
                {
                    passId: 'ui',
                    sortKey,
                    drawKey: `ui:text:${id}`,
                    draw,
                },
            ];
        }
        case 'meter':
            return compileUiMeterNode(node, { id, x, y, width, height, sortKey });
    }
}
function compileUiMeterNode(node, options) {
    const value = requireFiniteNumber(node.value, `UiMeterNode(${options.id}).value`);
    const max = requireFiniteNumber(node.max, `UiMeterNode(${options.id}).max`);
    const clampedMax = Math.max(0, max);
    const clampedValue = clampedMax > 0 ? Math.max(0, Math.min(value, clampedMax)) : 0;
    const fillWidth = clampedMax === 0 ? 0 : Math.max(0, Math.min(options.width, Math.floor((options.width * clampedValue) / clampedMax)));
    const backgroundDraw = {
        kind: 'rect',
        passId: 'ui',
        sortKey: options.sortKey,
        x: options.x,
        y: options.y,
        width: options.width,
        height: options.height,
        colorRgba: node.backgroundColorRgba,
    };
    const fillDraw = {
        kind: 'rect',
        passId: 'ui',
        sortKey: options.sortKey,
        x: options.x,
        y: options.y,
        width: fillWidth,
        height: options.height,
        colorRgba: node.fillColorRgba,
    };
    return [
        {
            passId: 'ui',
            sortKey: options.sortKey,
            drawKey: `ui:meter:${options.id}:background`,
            draw: backgroundDraw,
        },
        {
            passId: 'ui',
            sortKey: options.sortKey,
            drawKey: `ui:meter:${options.id}:fill`,
            draw: fillDraw,
        },
    ];
}
export function compileViewModelToRenderCommandBuffer(viewModel, options = {}) {
    const worldFixedPointScale = options.worldFixedPointScale ?? WORLD_FIXED_POINT_SCALE;
    if (!Number.isFinite(worldFixedPointScale) || worldFixedPointScale <= 0) {
        throw new Error('Render compiler expected worldFixedPointScale to be a positive number.');
    }
    const passes = createPasses();
    const entries = [];
    for (const sprite of viewModel.scene.sprites) {
        entries.push(compileSpriteInstance(sprite, { worldFixedPointScale }));
    }
    for (const node of viewModel.ui.nodes) {
        entries.push(...compileUiNode(node));
    }
    sortDrawEntries(entries);
    const draws = [];
    for (const entry of entries) {
        draws.push(entry.draw);
    }
    return {
        frame: {
            schemaVersion: viewModel.frame.schemaVersion,
            step: viewModel.frame.step,
            simTimeMs: viewModel.frame.simTimeMs,
            contentHash: viewModel.frame.contentHash,
            renderFrame: viewModel.frame.renderFrame,
        },
        passes,
        draws,
    };
}
export const __test__ = {
    quantizeToInt,
    encodeSignedInt32ToSortableUint32,
};
//# sourceMappingURL=render-compiler.js.map