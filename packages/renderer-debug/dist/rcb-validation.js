import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}
function isFiniteInt(value) {
    return isFiniteNumber(value) && Number.isInteger(value);
}
function validateFiniteCoordinate(errors, path, field, value, requiresUiPixels) {
    const fieldPath = `${path}.${field}`;
    if (requiresUiPixels) {
        if (!isFiniteInt(value)) {
            errors.push(`${fieldPath} must be a finite integer number`);
        }
        return;
    }
    if (!isFiniteNumber(value)) {
        errors.push(`${fieldPath} must be a finite number`);
    }
}
function validateFiniteNonNegativeDimension(errors, path, field, value, requiresUiPixels) {
    const fieldPath = `${path}.${field}`;
    if (requiresUiPixels) {
        if (!isFiniteInt(value)) {
            errors.push(`${fieldPath} must be a finite integer number`);
            return;
        }
    }
    else if (!isFiniteNumber(value)) {
        errors.push(`${fieldPath} must be a finite number`);
        return;
    }
    if (value < 0) {
        errors.push(`${fieldPath} must be non-negative`);
    }
}
function validateFinitePositiveDimension(errors, path, field, value, requiresUiPixels) {
    const fieldPath = `${path}.${field}`;
    if (requiresUiPixels) {
        if (!isFiniteInt(value)) {
            errors.push(`${fieldPath} must be a finite integer number`);
            return;
        }
    }
    else if (!isFiniteNumber(value)) {
        errors.push(`${fieldPath} must be a finite number`);
        return;
    }
    if (value <= 0) {
        errors.push(`${fieldPath} must be positive`);
    }
}
function isUint32(value) {
    return (typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 4294967295);
}
function isRecord(value) {
    return typeof value === 'object' && value !== null;
}
function isRenderPassId(value) {
    return value === 'world' || value === 'ui';
}
function sortKeyToString(sortKey) {
    return `${sortKey.sortKeyHi}:${sortKey.sortKeyLo}`;
}
function compareSortKey(a, b) {
    if (a.sortKeyHi !== b.sortKeyHi) {
        return a.sortKeyHi - b.sortKeyHi;
    }
    return a.sortKeyLo - b.sortKeyLo;
}
function parseSortKey(errors, path, sortKey) {
    if (!isRecord(sortKey)) {
        errors.push(`${path}.sortKey must be an object`);
        return undefined;
    }
    const sortKeyHi = sortKey['sortKeyHi'];
    const sortKeyLo = sortKey['sortKeyLo'];
    if (!isUint32(sortKeyHi)) {
        errors.push(`${path}.sortKey.sortKeyHi must be uint32`);
    }
    if (!isUint32(sortKeyLo)) {
        errors.push(`${path}.sortKey.sortKeyLo must be uint32`);
    }
    if (!isUint32(sortKeyHi) || !isUint32(sortKeyLo)) {
        return undefined;
    }
    return { sortKeyHi, sortKeyLo };
}
function parseDrawCommon(errors, path, draw, passIndexById) {
    const passIdValue = draw['passId'];
    let passId;
    let passIndex;
    if (!isRenderPassId(passIdValue)) {
        errors.push(`${path}.passId must be 'world' or 'ui'`);
    }
    else {
        passId = passIdValue;
        passIndex = passIndexById.get(passIdValue);
        if (passIndex === undefined) {
            errors.push(`${path}.passId references unknown passId: ${passIdValue}`);
        }
    }
    const sortKey = parseSortKey(errors, path, draw['sortKey']);
    return { passId, passIndex, sortKey };
}
function validateClearDraw(errors, path, draw) {
    if (!isUint32(draw['colorRgba'])) {
        errors.push(`${path}.colorRgba must be uint32 RGBA`);
    }
}
function validateRectGeometry(errors, path, draw, passId) {
    const requiresUiPixels = passId === 'ui';
    validateFiniteCoordinate(errors, path, 'x', draw['x'], requiresUiPixels);
    validateFiniteCoordinate(errors, path, 'y', draw['y'], requiresUiPixels);
    validateFiniteNonNegativeDimension(errors, path, 'width', draw['width'], requiresUiPixels);
    validateFiniteNonNegativeDimension(errors, path, 'height', draw['height'], requiresUiPixels);
}
function validateRectDraw(errors, path, draw, passId) {
    validateRectGeometry(errors, path, draw, passId);
    if (!isUint32(draw['colorRgba'])) {
        errors.push(`${path}.colorRgba must be uint32 RGBA`);
    }
}
function validateImageDraw(errors, path, draw, passId) {
    const assetId = draw['assetId'];
    if (typeof assetId !== 'string' || assetId.length === 0) {
        errors.push(`${path}.assetId must be non-empty`);
    }
    validateRectGeometry(errors, path, draw, passId);
    const tintRgba = draw['tintRgba'];
    if (tintRgba !== undefined && !isUint32(tintRgba)) {
        errors.push(`${path}.tintRgba must be uint32 RGBA when provided`);
    }
}
function validateTextDraw(errors, path, draw, passId) {
    const requiresUiPixels = passId === 'ui';
    validateFiniteCoordinate(errors, path, 'x', draw['x'], requiresUiPixels);
    validateFiniteCoordinate(errors, path, 'y', draw['y'], requiresUiPixels);
    if (typeof draw['text'] !== 'string') {
        errors.push(`${path}.text must be a string`);
    }
    if (!isUint32(draw['colorRgba'])) {
        errors.push(`${path}.colorRgba must be uint32 RGBA`);
    }
    const fontAssetId = draw['fontAssetId'];
    if (fontAssetId !== undefined &&
        (typeof fontAssetId !== 'string' || fontAssetId.length === 0)) {
        errors.push(`${path}.fontAssetId must be non-empty when provided`);
    }
    validateFinitePositiveDimension(errors, path, 'fontSizePx', draw['fontSizePx'], requiresUiPixels);
}
function validateScissorPushDraw(errors, path, draw, passId) {
    validateRectGeometry(errors, path, draw, passId);
}
export function validateRenderCommandBuffer(rcb) {
    const errors = [];
    const rcbValue = rcb;
    if (!isRecord(rcbValue)) {
        return { ok: false, errors: ['rcb must be an object'] };
    }
    const frameValue = rcbValue['frame'];
    if (!isRecord(frameValue)) {
        errors.push('frame must be an object');
    }
    else {
        const schemaVersion = frameValue['schemaVersion'];
        if (!isUint32(schemaVersion)) {
            errors.push('frame.schemaVersion must be uint32');
        }
        else if (schemaVersion !== RENDERER_CONTRACT_SCHEMA_VERSION) {
            errors.push(`frame.schemaVersion must equal ${RENDERER_CONTRACT_SCHEMA_VERSION}`);
        }
    }
    const sceneValue = rcbValue['scene'];
    if (isRecord(sceneValue)) {
        const cameraValue = sceneValue['camera'];
        if (isRecord(cameraValue)) {
            const cameraX = cameraValue['x'];
            const cameraY = cameraValue['y'];
            const cameraZoom = cameraValue['zoom'];
            if (!isFiniteNumber(cameraX)) {
                errors.push('scene.camera.x must be a finite number');
            }
            if (!isFiniteNumber(cameraY)) {
                errors.push('scene.camera.y must be a finite number');
            }
            if (!isFiniteNumber(cameraZoom) || cameraZoom <= 0) {
                errors.push('scene.camera.zoom must be a positive number');
            }
        }
        else {
            errors.push('scene.camera must be an object');
        }
    }
    else {
        errors.push('scene must be an object');
    }
    const passesValue = rcbValue['passes'];
    const drawsValue = rcbValue['draws'];
    if (!Array.isArray(passesValue)) {
        errors.push('passes must be an array');
    }
    if (!Array.isArray(drawsValue)) {
        errors.push('draws must be an array');
    }
    const passes = Array.isArray(passesValue) ? passesValue : [];
    const draws = Array.isArray(drawsValue) ? drawsValue : [];
    const passIndexById = new Map();
    for (let index = 0; index < passes.length; index++) {
        const path = `passes[${index}]`;
        const pass = passes[index];
        if (!isRecord(pass)) {
            errors.push(`${path} must be an object`);
            continue;
        }
        const id = pass['id'];
        if (!isRenderPassId(id)) {
            errors.push(`${path}.id must be 'world' or 'ui'`);
            continue;
        }
        if (passIndexById.has(id)) {
            errors.push(`passes contains duplicate id: ${id}`);
            continue;
        }
        passIndexById.set(id, index);
    }
    const drawOrderInfo = [];
    const drawKinds = [];
    for (let index = 0; index < draws.length; index++) {
        const path = `draws[${index}]`;
        const draw = draws[index];
        if (!isRecord(draw)) {
            errors.push(`${path} must be an object`);
            drawOrderInfo.push({
                passId: undefined,
                passIndex: undefined,
                sortKey: undefined,
            });
            drawKinds.push(undefined);
            continue;
        }
        const kind = draw['kind'];
        if (typeof kind === 'string') {
            drawKinds.push(kind);
        }
        else {
            errors.push(`${path}.kind must be a string`);
            drawKinds.push(undefined);
        }
        const common = parseDrawCommon(errors, path, draw, passIndexById);
        drawOrderInfo.push(common);
        switch (kind) {
            case 'clear':
                validateClearDraw(errors, path, draw);
                break;
            case 'rect':
                validateRectDraw(errors, path, draw, common.passId);
                break;
            case 'image':
                validateImageDraw(errors, path, draw, common.passId);
                break;
            case 'text':
                validateTextDraw(errors, path, draw, common.passId);
                break;
            case 'scissorPush':
                validateScissorPushDraw(errors, path, draw, common.passId);
                break;
            case 'scissorPop':
                break;
            default:
                if (typeof kind === 'string') {
                    errors.push(`${path}.kind must be one of: clear, rect, image, text, scissorPush, scissorPop`);
                }
        }
    }
    let previousPassIndex = -1;
    let previousSortKey;
    for (let index = 0; index < drawOrderInfo.length; index++) {
        const { passId, passIndex, sortKey } = drawOrderInfo[index];
        if (passIndex === undefined) {
            previousPassIndex = -1;
            previousSortKey = undefined;
            continue;
        }
        if (passIndex < previousPassIndex) {
            errors.push(`draws[${index}] passId ${passId} out of order (pass index ${passIndex} < ${previousPassIndex})`);
            previousPassIndex = passIndex;
            previousSortKey = sortKey;
            continue;
        }
        if (passIndex === previousPassIndex &&
            previousSortKey !== undefined &&
            sortKey !== undefined) {
            if (compareSortKey(sortKey, previousSortKey) < 0) {
                errors.push(`draws[${index}] sortKey out of order (${sortKeyToString(sortKey)} < ${sortKeyToString(previousSortKey)})`);
            }
        }
        previousPassIndex = passIndex;
        previousSortKey = sortKey;
    }
    let currentPassId;
    let scissorDepth = 0;
    for (let index = 0; index < drawOrderInfo.length; index++) {
        const { passId, passIndex } = drawOrderInfo[index];
        if (passIndex === undefined || passId === undefined) {
            currentPassId = undefined;
            scissorDepth = 0;
            continue;
        }
        if (currentPassId !== passId) {
            if (currentPassId !== undefined && scissorDepth !== 0) {
                errors.push(`draws[${index}] scissor stack not empty when switching passId (depth ${scissorDepth})`);
            }
            currentPassId = passId;
            scissorDepth = 0;
        }
        const kind = drawKinds[index];
        if (kind === 'scissorPush') {
            scissorDepth += 1;
        }
        else if (kind === 'scissorPop') {
            if (scissorDepth === 0) {
                errors.push(`draws[${index}] scissorPop without matching scissorPush`);
            }
            else {
                scissorDepth -= 1;
            }
        }
    }
    if (currentPassId !== undefined && scissorDepth !== 0) {
        errors.push(`scissor stack not empty at end of draw list (depth ${scissorDepth})`);
    }
    if (errors.length > 0) {
        return { ok: false, errors };
    }
    return { ok: true };
}
//# sourceMappingURL=rcb-validation.js.map