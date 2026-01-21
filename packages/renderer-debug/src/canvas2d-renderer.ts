import { WORLD_FIXED_POINT_SCALE } from '@idle-engine/renderer-contract';
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

  save(): void;
  restore(): void;
  beginPath(): void;
  rect(x: number, y: number, width: number, height: number): void;
  clip(): void;

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
  /**
   * World-pass draw coordinates are expected to be fixed-point integers emitted by the render
   * compiler (`value * worldFixedPointScale`).
   *
   * Set to `1` if you are supplying world coordinates as unscaled floats.
   */
  readonly worldFixedPointScale?: number;
  readonly assets?: RendererDebugAssets;
  readonly validate?: boolean;
}

interface CanvasImageSourceSize {
  readonly width: number;
  readonly height: number;
}

type TintScratchCanvas = OffscreenCanvas | HTMLCanvasElement;
type TintScratchContext = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
type TintScratch = { canvas: TintScratchCanvas; ctx: TintScratchContext };

let tintScratch: TintScratch | undefined;

function pickFiniteNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

function getCanvasImageSourceSize(source: CanvasImageSource): CanvasImageSourceSize | undefined {
  const record = source as unknown as Record<string, unknown>;
  const width =
    pickFiniteNumber(record, ['width', 'naturalWidth', 'videoWidth', 'codedWidth']) ??
    0;
  const height =
    pickFiniteNumber(record, ['height', 'naturalHeight', 'videoHeight', 'codedHeight']) ??
    0;

  const widthInt = Math.floor(width);
  const heightInt = Math.floor(height);
  if (widthInt <= 0 || heightInt <= 0) {
    return undefined;
  }

  return { width: widthInt, height: heightInt };
}

function createTintScratch(width: number, height: number): TintScratch | undefined {
  const offscreenCanvasCtor = (
    globalThis as unknown as { OffscreenCanvas?: typeof OffscreenCanvas }
  ).OffscreenCanvas;

  if (offscreenCanvasCtor) {
    const canvas = new offscreenCanvasCtor(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return undefined;
    }
    return { canvas, ctx };
  }

  const canvas = (
    globalThis as unknown as {
      document?: { createElement(tagName: string): HTMLCanvasElement };
    }
  ).document?.createElement('canvas');
  if (!canvas) {
    return undefined;
  }

  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return undefined;
  }

  return { canvas, ctx };
}

function resizeTintScratch(scratch: TintScratch, width: number, height: number): void {
  if (scratch.canvas.width !== width) {
    scratch.canvas.width = width;
  }
  if (scratch.canvas.height !== height) {
    scratch.canvas.height = height;
  }
}

function getTintScratch(width: number, height: number): TintScratch | undefined {
  if (width <= 0 || height <= 0) {
    return undefined;
  }

  tintScratch ??= createTintScratch(width, height);
  if (!tintScratch) {
    return undefined;
  }

  resizeTintScratch(tintScratch, width, height);
  return tintScratch;
}

function drawRect(
  ctx: Canvas2dContextLike,
  draw: RectDraw,
  pixelRatio: number,
  coordScale: number,
): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = rgbaToCssColor(draw.colorRgba);
  ctx.fillRect(
    draw.x * coordScale * pixelRatio,
    draw.y * coordScale * pixelRatio,
    draw.width * coordScale * pixelRatio,
    draw.height * coordScale * pixelRatio,
  );
}

function drawText(
  ctx: Canvas2dContextLike,
  draw: TextDraw,
  pixelRatio: number,
  assets: RendererDebugAssets | undefined,
  coordScale: number,
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

  ctx.fillText(draw.text, draw.x * coordScale * pixelRatio, draw.y * coordScale * pixelRatio);
}

function drawMissingAssetPlaceholder(
  ctx: Canvas2dContextLike,
  draw: ImageDraw,
  pixelRatio: number,
  coordScale: number,
): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255, 0, 255, 0.75)';
  ctx.fillRect(
    draw.x * coordScale * pixelRatio,
    draw.y * coordScale * pixelRatio,
    draw.width * coordScale * pixelRatio,
    draw.height * coordScale * pixelRatio,
  );

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.lineWidth = 1;
  ctx.strokeRect(
    draw.x * coordScale * pixelRatio,
    draw.y * coordScale * pixelRatio,
    draw.width * coordScale * pixelRatio,
    draw.height * coordScale * pixelRatio,
  );

  ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.font = `${12 * pixelRatio}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(
    `missing: ${draw.assetId}`,
    draw.x * coordScale * pixelRatio + 2 * pixelRatio,
    draw.y * coordScale * pixelRatio + 2 * pixelRatio,
  );
}

function drawImage(
  ctx: Canvas2dContextLike,
  draw: ImageDraw,
  pixelRatio: number,
  assets: RendererDebugAssets | undefined,
  coordScale: number,
): void {
  const image = assets?.resolveImage ? assets.resolveImage(draw.assetId) : undefined;
  if (!image) {
    drawMissingAssetPlaceholder(ctx, draw, pixelRatio, coordScale);
    return;
  }

  const width = draw.width * coordScale * pixelRatio;
  const height = draw.height * coordScale * pixelRatio;
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
    ctx.drawImage(
      image,
      draw.x * coordScale * pixelRatio,
      draw.y * coordScale * pixelRatio,
      width,
      height,
    );
    ctx.globalAlpha = 1;
    return;
  }

  const sourceSize = getCanvasImageSourceSize(image);
  const scratch = getTintScratch(
    sourceSize?.width ?? Math.max(1, Math.round(width)),
    sourceSize?.height ?? Math.max(1, Math.round(height)),
  );
  if (!scratch) {
    ctx.globalAlpha = alpha;
    ctx.drawImage(
      image,
      draw.x * coordScale * pixelRatio,
      draw.y * coordScale * pixelRatio,
      width,
      height,
    );
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

  ctx.drawImage(
    scratchCanvas,
    draw.x * coordScale * pixelRatio,
    draw.y * coordScale * pixelRatio,
    width,
    height,
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

  const worldFixedPointScale = options.worldFixedPointScale ?? WORLD_FIXED_POINT_SCALE;
  if (!Number.isFinite(worldFixedPointScale) || worldFixedPointScale <= 0) {
    throw new Error('Canvas2D renderer expected worldFixedPointScale to be a positive number.');
  }
  const worldFixedPointInvScale = 1 / worldFixedPointScale;

  let scissorDepth = 0;

  for (const draw of rcb.draws) {
    const coordScale = draw.passId === 'world' ? worldFixedPointInvScale : 1;
    switch (draw.kind) {
      case 'clear': {
        ctx.globalAlpha = 1;
        ctx.fillStyle = rgbaToCssColor(draw.colorRgba);
        ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        break;
      }
      case 'rect':
        drawRect(ctx, draw, pixelRatio, coordScale);
        break;
      case 'image':
        drawImage(ctx, draw, pixelRatio, assets, coordScale);
        break;
      case 'text':
        drawText(ctx, draw, pixelRatio, assets, coordScale);
        break;
      case 'scissorPush': {
        ctx.save();
        ctx.beginPath();
        ctx.rect(
          draw.x * coordScale * pixelRatio,
          draw.y * coordScale * pixelRatio,
          draw.width * coordScale * pixelRatio,
          draw.height * coordScale * pixelRatio,
        );
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
        const exhaustiveCheck: never = draw;
        throw new Error(`Unsupported draw kind: ${String(exhaustiveCheck)}`);
      }
    }
  }

  while (scissorDepth > 0) {
    ctx.restore();
    scissorDepth -= 1;
  }
}
