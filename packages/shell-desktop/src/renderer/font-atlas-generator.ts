import type { WebGpuBitmapFont, WebGpuBitmapFontGlyph } from '@idle-engine/renderer-webgpu';

export interface FontAtlasConfig {
  fontFamily: string;
  baseFontSizePx: number;
  codePointRanges: ReadonlyArray<readonly [number, number]>;
  padding?: number;
}

interface GlyphMeasurement {
  codePoint: number;
  char: string;
  width: number;
  height: number;
  xAdvance: number;
  ascent: number;
  descent: number;
}

function measureGlyphs(
  ctx: OffscreenCanvasRenderingContext2D,
  config: FontAtlasConfig,
): GlyphMeasurement[] {
  const measurements: GlyphMeasurement[] = [];
  const fontSizePx = config.baseFontSizePx;

  ctx.font = `${fontSizePx}px ${config.fontFamily}`;
  ctx.textBaseline = 'alphabetic';

  for (const [start, end] of config.codePointRanges) {
    for (let codePoint = start; codePoint <= end; codePoint++) {
      const char = String.fromCodePoint(codePoint);
      const metrics = ctx.measureText(char);

      const width = Math.ceil(
        metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight,
      );
      const ascent = Math.ceil(metrics.actualBoundingBoxAscent);
      const descent = Math.ceil(metrics.actualBoundingBoxDescent);
      const height = ascent + descent;
      const xAdvance = Math.ceil(metrics.width);

      measurements.push({
        codePoint,
        char,
        width: Math.max(1, width),
        height: Math.max(1, height),
        xAdvance,
        ascent,
        descent,
      });
    }
  }

  return measurements;
}

interface PackedGlyph {
  measurement: GlyphMeasurement;
  x: number;
  y: number;
}

function packGlyphs(
  measurements: GlyphMeasurement[],
  padding: number,
): { packedGlyphs: PackedGlyph[]; atlasWidth: number; atlasHeight: number } {
  const sorted = measurements
    .slice()
    .sort((a, b) => b.height - a.height || b.width - a.width);

  let atlasWidth = 256;
  let atlasHeight = 256;
  const maxAtlasSize = 4096;

  while (atlasWidth <= maxAtlasSize && atlasHeight <= maxAtlasSize) {
    const packedGlyphs: PackedGlyph[] = [];
    let cursorX = padding;
    let cursorY = padding;
    let rowHeight = 0;
    let success = true;

    for (const measurement of sorted) {
      const glyphWidth = measurement.width + padding;
      const glyphHeight = measurement.height + padding;

      if (cursorX + glyphWidth > atlasWidth) {
        cursorX = padding;
        cursorY += rowHeight;
        rowHeight = 0;
      }

      if (cursorY + glyphHeight > atlasHeight) {
        success = false;
        break;
      }

      packedGlyphs.push({
        measurement,
        x: cursorX,
        y: cursorY,
      });

      cursorX += glyphWidth;
      rowHeight = Math.max(rowHeight, glyphHeight);
    }

    if (success) {
      return { packedGlyphs, atlasWidth, atlasHeight };
    }

    if (atlasWidth <= atlasHeight) {
      atlasWidth *= 2;
    } else {
      atlasHeight *= 2;
    }
  }

  throw new Error(
    `Font atlas exceeds maximum size (${maxAtlasSize}x${maxAtlasSize})`,
  );
}

function renderGlyphsToCanvas(
  ctx: OffscreenCanvasRenderingContext2D,
  packedGlyphs: PackedGlyph[],
  config: FontAtlasConfig,
): void {
  const fontSizePx = config.baseFontSizePx;

  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.font = `${fontSizePx}px ${config.fontFamily}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = 'white';

  for (const { measurement, x, y } of packedGlyphs) {
    const drawX = x;
    const drawY = y + measurement.ascent;
    ctx.fillText(measurement.char, drawX, drawY);
  }
}

function buildBitmapFontGlyphs(
  packedGlyphs: PackedGlyph[],
): WebGpuBitmapFontGlyph[] {
  return packedGlyphs.map(({ measurement, x, y }) => ({
    codePoint: measurement.codePoint,
    x,
    y,
    width: measurement.width,
    height: measurement.height,
    xOffsetPx: 0,
    yOffsetPx: 0,
    xAdvancePx: measurement.xAdvance,
  }));
}

export function generateBitmapFont(config: FontAtlasConfig): WebGpuBitmapFont {
  const padding = config.padding ?? 2;

  const measureCanvas = new OffscreenCanvas(1, 1);
  const measureCtx = measureCanvas.getContext('2d');
  if (!measureCtx) {
    throw new Error('Failed to create 2D context for glyph measurement');
  }

  const measurements = measureGlyphs(measureCtx, config);
  const { packedGlyphs, atlasWidth, atlasHeight } = packGlyphs(
    measurements,
    padding,
  );

  const atlasCanvas = new OffscreenCanvas(atlasWidth, atlasHeight);
  const atlasCtx = atlasCanvas.getContext('2d');
  if (!atlasCtx) {
    throw new Error('Failed to create 2D context for atlas rendering');
  }

  renderGlyphsToCanvas(atlasCtx, packedGlyphs, config);

  const glyphs = buildBitmapFontGlyphs(packedGlyphs);
  const lineHeightPx = Math.ceil(config.baseFontSizePx * 1.2);

  return {
    image: atlasCanvas,
    baseFontSizePx: config.baseFontSizePx,
    lineHeightPx,
    glyphs,
    fallbackCodePoint: 0x3f, // '?'
  };
}

export const DEFAULT_FONT_ATLAS_CONFIG: FontAtlasConfig = {
  fontFamily: 'monospace',
  baseFontSizePx: 16,
  codePointRanges: [[32, 126]], // ASCII printable characters
  padding: 2,
};
