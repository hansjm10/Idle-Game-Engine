import { WORLD_FIXED_POINT_SCALE } from '@idle-engine/renderer-contract';
import type {
  AssetId,
  Camera2D,
  ClearDraw,
  ImageDraw,
  RectDraw,
  RenderCommandBuffer,
  RenderDraw,
  ScissorPushDraw,
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

interface CameraTransform {
  readonly zoom: number;
  readonly x: number;
  readonly y: number;
}

interface DrawBounds {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface TintRgbaComponents {
  readonly alpha: number;
  readonly isWhite: boolean;
  readonly red: number;
  readonly green: number;
  readonly blue: number;
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

function getCameraTransform(camera: Camera2D, isWorld: boolean): CameraTransform {
  if (!isWorld) {
    return { zoom: 1, x: 0, y: 0 };
  }

  const zoom = Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1;
  const x = Number.isFinite(camera.x) ? camera.x : 0;
  const y = Number.isFinite(camera.y) ? camera.y : 0;
  return { zoom, x, y };
}

function getDrawBounds(
  draw: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  coordScale: number,
  pixelRatio: number,
  cameraTransform: CameraTransform,
): DrawBounds | undefined {
  const x = (draw.x * coordScale - cameraTransform.x) * cameraTransform.zoom * pixelRatio;
  const y = (draw.y * coordScale - cameraTransform.y) * cameraTransform.zoom * pixelRatio;
  const width = draw.width * coordScale * cameraTransform.zoom * pixelRatio;
  const height = draw.height * coordScale * cameraTransform.zoom * pixelRatio;
  if (width <= 0 || height <= 0) {
    return undefined;
  }

  return { x, y, width, height };
}

function parseTintRgba(tintRgba: number | undefined): TintRgbaComponents | undefined {
  const tint = tintRgba === undefined ? undefined : tintRgba >>> 0;
  const red = tint === undefined ? 0xff : (tint >>> 24) & 0xff;
  const green = tint === undefined ? 0xff : (tint >>> 16) & 0xff;
  const blue = tint === undefined ? 0xff : (tint >>> 8) & 0xff;
  const alphaByte = tint === undefined ? 0xff : tint & 0xff;
  if (alphaByte === 0) {
    return undefined;
  }

  const alpha = alphaByte / 255;
  const isWhite = red === 0xff && green === 0xff && blue === 0xff;
  return { alpha, isWhite, red, green, blue };
}

function drawCanvasImageWithAlpha(
  ctx: Canvas2dContextLike,
  image: CanvasImageSource,
  bounds: DrawBounds,
  alpha: number,
): void {
  ctx.globalAlpha = alpha;
  ctx.drawImage(image, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.globalAlpha = 1;
}

function drawTintedCanvasImage(
  ctx: Canvas2dContextLike,
  image: CanvasImageSource,
  bounds: DrawBounds,
  tint: TintRgbaComponents,
): void {
  const sourceSize = getCanvasImageSourceSize(image);
  const scratch = getTintScratch(
    sourceSize?.width ?? Math.max(1, Math.round(bounds.width)),
    sourceSize?.height ?? Math.max(1, Math.round(bounds.height)),
  );
  if (!scratch) {
    drawCanvasImageWithAlpha(ctx, image, bounds, tint.alpha);
    return;
  }

  const { canvas: scratchCanvas, ctx: scratchCtx } = scratch;
  scratchCtx.globalCompositeOperation = 'source-over';
  scratchCtx.globalAlpha = 1;
  scratchCtx.clearRect(0, 0, scratchCanvas.width, scratchCanvas.height);
  scratchCtx.drawImage(image, 0, 0, scratchCanvas.width, scratchCanvas.height);

  scratchCtx.globalCompositeOperation = 'multiply';
  scratchCtx.globalAlpha = 1;
  scratchCtx.fillStyle = `rgb(${tint.red}, ${tint.green}, ${tint.blue})`;
  scratchCtx.fillRect(0, 0, scratchCanvas.width, scratchCanvas.height);

  scratchCtx.globalCompositeOperation = 'destination-in';
  scratchCtx.globalAlpha = tint.alpha;
  scratchCtx.drawImage(image, 0, 0, scratchCanvas.width, scratchCanvas.height);

  scratchCtx.globalCompositeOperation = 'source-over';
  scratchCtx.globalAlpha = 1;

  ctx.globalAlpha = 1;
  ctx.drawImage(scratchCanvas, bounds.x, bounds.y, bounds.width, bounds.height);
  ctx.globalAlpha = 1;
}

function drawRect(
  ctx: Canvas2dContextLike,
  draw: RectDraw,
  pixelRatio: number,
  coordScale: number,
  camera: Camera2D,
): void {
  const cameraTransform = getCameraTransform(camera, draw.passId === 'world');

  ctx.globalAlpha = 1;
  ctx.fillStyle = rgbaToCssColor(draw.colorRgba);
  ctx.fillRect(
    (draw.x * coordScale - cameraTransform.x) * cameraTransform.zoom * pixelRatio,
    (draw.y * coordScale - cameraTransform.y) * cameraTransform.zoom * pixelRatio,
    draw.width * coordScale * cameraTransform.zoom * pixelRatio,
    draw.height * coordScale * cameraTransform.zoom * pixelRatio,
  );
}

function drawText(
  ctx: Canvas2dContextLike,
  draw: TextDraw,
  pixelRatio: number,
  assets: RendererDebugAssets | undefined,
  coordScale: number,
  camera: Camera2D,
): void {
  const cameraTransform = getCameraTransform(camera, draw.passId === 'world');

  ctx.globalAlpha = 1;
  ctx.fillStyle = rgbaToCssColor(draw.colorRgba);

  const fontFamily =
    draw.fontAssetId && assets?.resolveFontFamily
      ? assets.resolveFontFamily(draw.fontAssetId)
      : undefined;

  ctx.font = `${draw.fontSizePx * cameraTransform.zoom * pixelRatio}px ${fontFamily ?? 'sans-serif'}`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  ctx.fillText(
    draw.text,
    (draw.x * coordScale - cameraTransform.x) * cameraTransform.zoom * pixelRatio,
    (draw.y * coordScale - cameraTransform.y) * cameraTransform.zoom * pixelRatio,
  );
}

function drawMissingAssetPlaceholder(
  ctx: Canvas2dContextLike,
  draw: ImageDraw,
  pixelRatio: number,
  coordScale: number,
  camera: Camera2D,
): void {
  const cameraTransform = getCameraTransform(camera, draw.passId === 'world');

  const bounds = getDrawBounds(draw, coordScale, pixelRatio, cameraTransform);
  if (!bounds) {
    return;
  }
  const inset = 2 * cameraTransform.zoom * pixelRatio;

  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(255, 0, 255, 0.75)';
  ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.9)';
  ctx.font = `${12 * cameraTransform.zoom * pixelRatio}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(
    `missing: ${draw.assetId}`,
    bounds.x + inset,
    bounds.y + inset,
  );
}

function drawImage(
  ctx: Canvas2dContextLike,
  draw: ImageDraw,
  pixelRatio: number,
  assets: RendererDebugAssets | undefined,
  coordScale: number,
  camera: Camera2D,
): void {
  const image = assets?.resolveImage ? assets.resolveImage(draw.assetId) : undefined;
  if (!image) {
    drawMissingAssetPlaceholder(ctx, draw, pixelRatio, coordScale, camera);
    return;
  }

  const cameraTransform = getCameraTransform(camera, draw.passId === 'world');
  const bounds = getDrawBounds(draw, coordScale, pixelRatio, cameraTransform);
  if (!bounds) {
    return;
  }

  const tint = parseTintRgba(draw.tintRgba);
  if (!tint) {
    return;
  }

  if (tint.isWhite) {
    drawCanvasImageWithAlpha(ctx, image, bounds, tint.alpha);
    return;
  }

  drawTintedCanvasImage(ctx, image, bounds, tint);
}

function drawClear(ctx: Canvas2dContextLike, draw: ClearDraw): void {
  ctx.globalAlpha = 1;
  ctx.fillStyle = rgbaToCssColor(draw.colorRgba);
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
}

function pushScissor(
  ctx: Canvas2dContextLike,
  draw: ScissorPushDraw,
  pixelRatio: number,
  coordScale: number,
  camera: Camera2D,
): void {
  const cameraTransform = getCameraTransform(camera, draw.passId === 'world');

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    (draw.x * coordScale - cameraTransform.x) * cameraTransform.zoom * pixelRatio,
    (draw.y * coordScale - cameraTransform.y) * cameraTransform.zoom * pixelRatio,
    draw.width * coordScale * cameraTransform.zoom * pixelRatio,
    draw.height * coordScale * cameraTransform.zoom * pixelRatio,
  );
  ctx.clip();
}

function popScissor(ctx: Canvas2dContextLike, scissorDepth: number): number {
  if (scissorDepth <= 0) {
    return 0;
  }

  ctx.restore();
  return scissorDepth - 1;
}

function restoreScissorDepth(ctx: Canvas2dContextLike, scissorDepth: number): void {
  let depth = scissorDepth;
  while (depth > 0) {
    ctx.restore();
    depth -= 1;
  }
}

interface Canvas2dRenderContext {
  readonly ctx: Canvas2dContextLike;
  readonly pixelRatio: number;
  readonly assets: RendererDebugAssets | undefined;
  readonly worldFixedPointInvScale: number;
  readonly worldCamera: Camera2D;
}

function renderDrawToCanvas2d(
  renderCtx: Canvas2dRenderContext,
  draw: RenderDraw,
  scissorDepth: number,
): number {
  const coordScale = draw.passId === 'world' ? renderCtx.worldFixedPointInvScale : 1;

  switch (draw.kind) {
    case 'clear':
      drawClear(renderCtx.ctx, draw);
      return scissorDepth;
    case 'rect':
      drawRect(renderCtx.ctx, draw, renderCtx.pixelRatio, coordScale, renderCtx.worldCamera);
      return scissorDepth;
    case 'image':
      drawImage(
        renderCtx.ctx,
        draw,
        renderCtx.pixelRatio,
        renderCtx.assets,
        coordScale,
        renderCtx.worldCamera,
      );
      return scissorDepth;
    case 'text':
      drawText(
        renderCtx.ctx,
        draw,
        renderCtx.pixelRatio,
        renderCtx.assets,
        coordScale,
        renderCtx.worldCamera,
      );
      return scissorDepth;
    case 'scissorPush':
      pushScissor(
        renderCtx.ctx,
        draw,
        renderCtx.pixelRatio,
        coordScale,
        renderCtx.worldCamera,
      );
      return scissorDepth + 1;
    case 'scissorPop':
      return popScissor(renderCtx.ctx, scissorDepth);
    default: {
      const exhaustiveCheck: never = draw;
      throw new Error(`Unsupported draw kind: ${String(exhaustiveCheck)}`);
    }
  }
}

function renderDrawsToCanvas2d(
  renderCtx: Canvas2dRenderContext,
  draws: readonly RenderDraw[],
): void {
  let scissorDepth = 0;

  for (const draw of draws) {
    scissorDepth = renderDrawToCanvas2d(renderCtx, draw, scissorDepth);
  }

  restoreScissorDepth(renderCtx.ctx, scissorDepth);
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

  const worldCamera = rcb.scene.camera;

  renderDrawsToCanvas2d(
    {
      ctx,
      pixelRatio,
      assets,
      worldFixedPointInvScale,
      worldCamera,
    },
    rcb.draws,
  );
}
