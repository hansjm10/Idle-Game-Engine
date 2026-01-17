import type {
  AssetId,
  ImageDraw,
  RectDraw,
  RenderCommandBuffer,
  TextDraw,
} from '@idle-engine/renderer-contract';

import { rgbaToCssColor } from './color.js';
import { validateRenderCommandBuffer } from './rcb-validation.js';

export type CanvasFillStyle = string | CanvasGradient | CanvasPattern;

export interface Canvas2dContextLike {
  readonly canvas: { readonly width: number; readonly height: number };

  fillStyle: CanvasFillStyle;
  strokeStyle: CanvasFillStyle;
  globalAlpha: number;
  lineWidth: number;

  font: string;
  textBaseline: CanvasTextBaseline;
  textAlign: CanvasTextAlign;

  clearRect(x: number, y: number, width: number, height: number): void;
  fillRect(x: number, y: number, width: number, height: number): void;
  strokeRect(x: number, y: number, width: number, height: number): void;
  fillText(text: string, x: number, y: number): void;
  drawImage(
    image: CanvasImageSource,
    dx: number,
    dy: number,
    dWidth: number,
    dHeight: number,
  ): void;
}

export interface RendererDebugAssets {
  resolveImage?(assetId: AssetId): CanvasImageSource | undefined;
  resolveFontFamily?(assetId: AssetId): string | undefined;
}

export interface RenderCommandBufferToCanvas2dOptions {
  /**
   * Scales draw coordinates and font size.
   *
   * The canvas is expected to already be sized in device pixels
   * (`ctx.canvas.width/height`). `clear` fills the raw canvas dimensions,
   * while other draws multiply coordinates by `pixelRatio`.
   */
  readonly pixelRatio?: number;
  readonly assets?: RendererDebugAssets;
  readonly validate?: boolean;
}

function drawRect(
  ctx: Canvas2dContextLike,
  draw: RectDraw,
  pixelRatio: number,
): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = rgbaToCssColor(draw.colorRgba);
  ctx.fillRect(
    draw.x * pixelRatio,
    draw.y * pixelRatio,
    draw.width * pixelRatio,
    draw.height * pixelRatio,
  );
}

function drawText(
  ctx: Canvas2dContextLike,
  draw: TextDraw,
  pixelRatio: number,
  assets: RendererDebugAssets | undefined,
): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = rgbaToCssColor(draw.colorRgba);

  const fontFamily =
    draw.fontAssetId && assets?.resolveFontFamily
      ? assets.resolveFontFamily(draw.fontAssetId)
      : undefined;

  ctx.font = `${draw.fontSizePx * pixelRatio}px ${fontFamily ?? 'sans-serif'}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  ctx.fillText(draw.text, draw.x * pixelRatio, draw.y * pixelRatio);
}

function drawMissingAssetPlaceholder(
  ctx: Canvas2dContextLike,
  draw: ImageDraw,
  pixelRatio: number,
): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255, 0, 255, 0.75)';
  ctx.fillRect(
    draw.x * pixelRatio,
    draw.y * pixelRatio,
    draw.width * pixelRatio,
    draw.height * pixelRatio,
  );

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    draw.x * pixelRatio,
    draw.y * pixelRatio,
    draw.width * pixelRatio,
    draw.height * pixelRatio,
  );

  ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.font = `${12 * pixelRatio}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(
    `missing: ${draw.assetId}`,
    draw.x * pixelRatio + 2 * pixelRatio,
    draw.y * pixelRatio + 2 * pixelRatio,
  );
}

function drawImage(
  ctx: Canvas2dContextLike,
  draw: ImageDraw,
  pixelRatio: number,
  assets: RendererDebugAssets | undefined,
): void {
  const image = assets?.resolveImage ? assets.resolveImage(draw.assetId) : undefined;
  if (!image) {
    drawMissingAssetPlaceholder(ctx, draw, pixelRatio);
    return;
  }

  // tintRgba is treated as opacity only (alpha byte); RGB is ignored.
  const alpha =
    draw.tintRgba !== undefined ? ((draw.tintRgba >>> 0) & 0xff) / 255 : 1;
  ctx.globalAlpha = alpha;

  ctx.drawImage(
    image,
    draw.x * pixelRatio,
    draw.y * pixelRatio,
    draw.width * pixelRatio,
    draw.height * pixelRatio,
  );

  ctx.globalAlpha = 1;
}

export function renderRenderCommandBufferToCanvas2d(
  ctx: Canvas2dContextLike,
  rcb: RenderCommandBuffer,
  options: RenderCommandBufferToCanvas2dOptions = {},
): void {
  if (options.validate !== false) {
    const validation = validateRenderCommandBuffer(rcb);
    if (!validation.ok) {
      throw new Error(
        `Invalid RenderCommandBuffer: ${validation.errors.join('; ')}`,
      );
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
        const exhaustiveCheck: never = draw;
        throw new Error(`Unsupported draw kind: ${String(exhaustiveCheck)}`);
      }
    }
  }
}
