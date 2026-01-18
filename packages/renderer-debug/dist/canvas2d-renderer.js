import { rgbaToCssColor } from './color.js';
import { validateRenderCommandBuffer } from './rcb-validation.js';
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
    // tintRgba is treated as opacity only (alpha byte); RGB is ignored.
    const alpha = draw.tintRgba !== undefined ? ((draw.tintRgba >>> 0) & 0xff) / 255 : 1;
    ctx.globalAlpha = alpha;
    ctx.drawImage(image, draw.x * pixelRatio, draw.y * pixelRatio, draw.width * pixelRatio, draw.height * pixelRatio);
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
            default: {
                const exhaustiveCheck = draw;
                throw new Error(`Unsupported draw kind: ${String(exhaustiveCheck)}`);
            }
        }
    }
}
//# sourceMappingURL=canvas2d-renderer.js.map