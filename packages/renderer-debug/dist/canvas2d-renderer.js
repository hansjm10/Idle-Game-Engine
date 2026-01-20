import { rgbaToCssColor } from './color.js';
import { validateRenderCommandBuffer } from './rcb-validation.js';
let tintScratch;
function pickFiniteNumber(record, keys) {
    for (const key of keys) {
        const value = record[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
    }
    return undefined;
}
function getCanvasImageSourceSize(source) {
    const record = source;
    const width = pickFiniteNumber(record, ['width', 'naturalWidth', 'videoWidth', 'codedWidth']) ??
        0;
    const height = pickFiniteNumber(record, ['height', 'naturalHeight', 'videoHeight', 'codedHeight']) ??
        0;
    const widthInt = Math.floor(width);
    const heightInt = Math.floor(height);
    if (widthInt <= 0 || heightInt <= 0) {
        return undefined;
    }
    return { width: widthInt, height: heightInt };
}
function getTintScratch(width, height) {
    if (width <= 0 || height <= 0) {
        return undefined;
    }
    if (!tintScratch) {
        if (typeof OffscreenCanvas !== 'undefined') {
            const canvas = new OffscreenCanvas(width, height);
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                return undefined;
            }
            tintScratch = { canvas, ctx };
        }
        else {
            const canvas = globalThis.document?.createElement('canvas');
            if (!canvas) {
                return undefined;
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                return undefined;
            }
            tintScratch = { canvas, ctx };
        }
    }
    if (!tintScratch) {
        return undefined;
    }
    const scratch = tintScratch;
    if (scratch.canvas.width !== width) {
        scratch.canvas.width = width;
    }
    if (scratch.canvas.height !== height) {
        scratch.canvas.height = height;
    }
    return scratch;
}
function drawRect(ctx, draw, pixelRatio) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgbaToCssColor(draw.colorRgba);
    ctx.fillRect(draw.x * pixelRatio, draw.y * pixelRatio, draw.width * pixelRatio, draw.height * pixelRatio);
}
function drawText(ctx, draw, pixelRatio, assets) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = rgbaToCssColor(draw.colorRgba);
    const fontFamily = draw.fontAssetId && assets?.resolveFontFamily
        ? assets.resolveFontFamily(draw.fontAssetId)
        : undefined;
    ctx.font = `${draw.fontSizePx * pixelRatio}px ${fontFamily ?? 'sans-serif'}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(draw.text, draw.x * pixelRatio, draw.y * pixelRatio);
}
function drawMissingAssetPlaceholder(ctx, draw, pixelRatio) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(255, 0, 255, 0.75)';
    ctx.fillRect(draw.x * pixelRatio, draw.y * pixelRatio, draw.width * pixelRatio, draw.height * pixelRatio);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.lineWidth = 1;
    ctx.strokeRect(draw.x * pixelRatio, draw.y * pixelRatio, draw.width * pixelRatio, draw.height * pixelRatio);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
    ctx.font = `${12 * pixelRatio}px sans-serif`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText(`missing: ${draw.assetId}`, draw.x * pixelRatio + 2 * pixelRatio, draw.y * pixelRatio + 2 * pixelRatio);
}
function drawImage(ctx, draw, pixelRatio, assets) {
    const image = assets?.resolveImage ? assets.resolveImage(draw.assetId) : undefined;
    if (!image) {
        drawMissingAssetPlaceholder(ctx, draw, pixelRatio);
        return;
    }
    const width = draw.width * pixelRatio;
    const height = draw.height * pixelRatio;
    if (width <= 0 || height <= 0) {
        return;
    }
    const tintRgba = draw.tintRgba;
    const tint = tintRgba === undefined ? undefined : tintRgba >>> 0;
    const tintRed = tint === undefined ? 0xff : (tint >>> 24) & 0xff;
    const tintGreen = tint === undefined ? 0xff : (tint >>> 16) & 0xff;
    const tintBlue = tint === undefined ? 0xff : (tint >>> 8) & 0xff;
    const tintAlphaByte = tint === undefined ? 0xff : tint & 0xff;
    if (tintAlphaByte === 0) {
        return;
    }
    const alpha = tintAlphaByte / 255;
    const isWhiteTint = tintRed === 0xff && tintGreen === 0xff && tintBlue === 0xff;
    if (isWhiteTint) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(image, draw.x * pixelRatio, draw.y * pixelRatio, width, height);
        ctx.globalAlpha = 1;
        return;
    }
    const sourceSize = getCanvasImageSourceSize(image);
    const scratch = getTintScratch(sourceSize?.width ?? Math.max(1, Math.round(width)), sourceSize?.height ?? Math.max(1, Math.round(height)));
    if (!scratch) {
        ctx.globalAlpha = alpha;
        ctx.drawImage(image, draw.x * pixelRatio, draw.y * pixelRatio, width, height);
        ctx.globalAlpha = 1;
        return;
    }
    const { canvas: scratchCanvas, ctx: scratchCtx } = scratch;
    scratchCtx.globalCompositeOperation = 'source-over';
    scratchCtx.globalAlpha = 1;
    scratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
    scratchCtx.drawImage(image, 0, 0, scratchCanvas.width, scratchCanvas.height);
    scratchCtx.globalCompositeOperation = 'multiply';
    scratchCtx.globalAlpha = 1;
    scratchCtx.fillStyle = `rgb(${tintRed}, ${tintGreen}, ${tintBlue})`;
    scratchCtx.fillRect(0, 0, scratchCanvas.width, scratchCanvas.height);
    scratchCtx.globalCompositeOperation = 'destination-in';
    scratchCtx.globalAlpha = alpha;
    scratchCtx.drawImage(image, 0, 0, scratchCanvas.width, scratchCanvas.height);
    scratchCtx.globalCompositeOperation = 'source-over';
    scratchCtx.globalAlpha = 1;
    ctx.globalAlpha = 1;
    ctx.drawImage(scratchCanvas, draw.x * pixelRatio, draw.y * pixelRatio, width, height);
    ctx.globalAlpha = 1;
}
export function renderRenderCommandBufferToCanvas2d(ctx, rcb, options = {}) {
    if (options.validate !== false) {
        const validation = validateRenderCommandBuffer(rcb);
        if (!validation.ok) {
            throw new Error(`Invalid RenderCommandBuffer: ${validation.errors.join('; ')}`);
        }
    }
    const pixelRatio = options.pixelRatio ?? 1;
    const assets = options.assets;
    let scissorDepth = 0;
    for (const draw of rcb.draws) {
        switch (draw.kind) {
            case 'clear': {
                ctx.globalAlpha = 1;
                ctx.fillStyle = rgbaToCssColor(draw.colorRgba);
                ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
                break;
            }
            case 'rect':
                drawRect(ctx, draw, pixelRatio);
                break;
            case 'image':
                drawImage(ctx, draw, pixelRatio, assets);
                break;
            case 'text':
                drawText(ctx, draw, pixelRatio, assets);
                break;
            case 'scissorPush': {
                ctx.save();
                ctx.beginPath();
                ctx.rect(draw.x * pixelRatio, draw.y * pixelRatio, draw.width * pixelRatio, draw.height * pixelRatio);
                ctx.clip();
                scissorDepth += 1;
                break;
            }
            case 'scissorPop': {
                if (scissorDepth > 0) {
                    ctx.restore();
                    scissorDepth -= 1;
                }
                break;
            }
            default: {
                const exhaustiveCheck = draw;
                throw new Error(`Unsupported draw kind: ${String(exhaustiveCheck)}`);
            }
        }
    }
    while (scissorDepth > 0) {
        ctx.restore();
        scissorDepth -= 1;
    }
}
//# sourceMappingURL=canvas2d-renderer.js.map