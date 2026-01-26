import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import canonicalize from 'canonicalize';
import type { NormalizedFontAsset } from '@idle-engine/content-schema';

export interface GeneratedFontAssetFiles {
  readonly atlasPng: Uint8Array;
  readonly metadataJson: string;
  readonly contentHash: string;
}

export interface GeneratedFontMetadata {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly technique: 'msdf';
  readonly baseFontSizePx: number;
  readonly lineHeightPx: number;
  readonly glyphs: readonly GeneratedFontGlyph[];
  readonly fallbackCodePoint?: number;
  readonly msdf: {
    readonly pxRange: number;
  };
}

export interface GeneratedFontGlyph {
  readonly codePoint: number;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly xOffsetPx: number;
  readonly yOffsetPx: number;
  readonly xAdvancePx: number;
}

type MsdfBmfontTexture = Readonly<{
  filename: string;
  texture: Buffer;
}>;

type MsdfBmfontFontFile = Readonly<{
  filename: string;
  data: string;
}>;

type MsdfBmfontCallback = (
  error: Error | null,
  textures: readonly MsdfBmfontTexture[],
  font: MsdfBmfontFontFile,
) => void;

type MsdfBmfontOptions = Readonly<{
  outputType: 'json';
  charset: string;
  fontSize: number;
  textureSize: readonly [number, number];
  texturePadding: number;
  fieldType: 'msdf';
  distanceRange: number;
  roundDecimal: number;
}>;

type GenerateBmfontFn = (
  fontPathOrBuffer: string | Buffer,
  options: MsdfBmfontOptions,
  callback: MsdfBmfontCallback,
) => void;

const require = createRequire(import.meta.url);

let cachedGenerateBmfont: GenerateBmfontFn | undefined;

function getGenerateBmfont(): GenerateBmfontFn {
  if (!cachedGenerateBmfont) {
    cachedGenerateBmfont = require('msdf-bmfont-xml') as GenerateBmfontFn;
  }
  return cachedGenerateBmfont;
}

const DEFAULT_TEXTURE_SIZE: readonly [number, number] = [512, 512];
const DEFAULT_TEXTURE_PADDING = 2;
const DEFAULT_ROUND_DECIMAL = 0;
const DEFAULT_FALLBACK_CODE_POINT = 0x3f; // '?'
const MAX_GLYPHS_PER_FONT = 4096;

function stableJson(value: unknown): string {
  const result = canonicalize(value);
  if (typeof result !== 'string') {
    throw new Error('Failed to canonicalize font metadata.');
  }
  return result;
}

function buildCharset(font: NormalizedFontAsset): { charset: string; glyphCount: number } {
  const fallback = font.fallbackCodePoint ?? DEFAULT_FALLBACK_CODE_POINT;

  let glyphCount = 0;
  for (const [start, end] of font.codePointRanges) {
    glyphCount += end - start + 1;
    if (glyphCount > MAX_GLYPHS_PER_FONT) {
      throw new Error(
        `Font ${font.id} exceeds max glyph count (${glyphCount} > ${MAX_GLYPHS_PER_FONT}). Narrow codePointRanges.`,
      );
    }
  }

  const includesFallback = font.codePointRanges.some(([start, end]) => fallback >= start && fallback <= end);
  if (!includesFallback) {
    glyphCount += 1;
  }
  if (glyphCount > MAX_GLYPHS_PER_FONT) {
    throw new Error(
      `Font ${font.id} exceeds max glyph count (${glyphCount} > ${MAX_GLYPHS_PER_FONT}). Narrow codePointRanges.`,
    );
  }

  const chars: string[] = [];
  for (const [start, end] of font.codePointRanges) {
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      chars.push(String.fromCodePoint(codePoint));
    }
  }
  if (!includesFallback) {
    chars.push(String.fromCodePoint(fallback));
  }

  return { charset: chars.join(''), glyphCount };
}

function extractFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Invalid ${label}: expected a finite number.`);
  }
  return value;
}

function parseBmfontJson(fontId: string, rawJson: string): GeneratedFontMetadata {
  const parsed = JSON.parse(rawJson) as unknown;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Invalid BMFont JSON for ${fontId}: expected an object.`);
  }

  const common = (parsed as { common?: unknown }).common;
  if (typeof common !== 'object' || common === null || Array.isArray(common)) {
    throw new Error(`Invalid BMFont JSON for ${fontId}: missing common block.`);
  }

  const chars = (parsed as { chars?: unknown }).chars;
  if (!Array.isArray(chars)) {
    throw new Error(`Invalid BMFont JSON for ${fontId}: missing chars list.`);
  }

  const lineHeightPx = extractFiniteNumber(common as Record<string, unknown>, 'lineHeight', `${fontId}.common.lineHeight`);

  const glyphs: GeneratedFontGlyph[] = [];
  for (const entry of chars) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const codePoint = extractFiniteNumber(record, 'id', `${fontId}.chars[].id`);
    const x = extractFiniteNumber(record, 'x', `${fontId}.chars[].x`);
    const y = extractFiniteNumber(record, 'y', `${fontId}.chars[].y`);
    const width = extractFiniteNumber(record, 'width', `${fontId}.chars[].width`);
    const height = extractFiniteNumber(record, 'height', `${fontId}.chars[].height`);
    const xOffsetPx = extractFiniteNumber(record, 'xoffset', `${fontId}.chars[].xoffset`);
    const yOffsetPx = extractFiniteNumber(record, 'yoffset', `${fontId}.chars[].yoffset`);
    const xAdvancePx = extractFiniteNumber(record, 'xadvance', `${fontId}.chars[].xadvance`);

    glyphs.push({
      codePoint: Math.trunc(codePoint),
      x: Math.trunc(x),
      y: Math.trunc(y),
      width: Math.trunc(width),
      height: Math.trunc(height),
      xOffsetPx,
      yOffsetPx,
      xAdvancePx,
    });
  }

  glyphs.sort((left, right) => left.codePoint - right.codePoint);

  return {
    schemaVersion: 1,
    id: fontId,
    technique: 'msdf',
    baseFontSizePx: 0,
    lineHeightPx,
    glyphs: Object.freeze(glyphs),
    msdf: { pxRange: 0 },
  };
}

export async function generateMsdfFontAssetFiles(options: Readonly<{
  font: NormalizedFontAsset;
  sourcePath: string;
}>): Promise<GeneratedFontAssetFiles> {
  const { charset } = buildCharset(options.font);

  const generateBmfont = getGenerateBmfont();
  const bmfont = await new Promise<{
    textures: readonly MsdfBmfontTexture[];
    font: MsdfBmfontFontFile;
  }>((resolve, reject) => {
    generateBmfont(
      options.sourcePath,
      {
        outputType: 'json',
        charset,
        fontSize: options.font.baseSizePx,
        textureSize: DEFAULT_TEXTURE_SIZE,
        texturePadding: DEFAULT_TEXTURE_PADDING,
        fieldType: 'msdf',
        distanceRange: options.font.msdf.pxRange,
        roundDecimal: DEFAULT_ROUND_DECIMAL,
      },
      (error, textures, font) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ textures, font });
      },
    );
  });

  if (bmfont.textures.length !== 1) {
    throw new Error(
      `Font ${options.font.id} generation produced ${bmfont.textures.length} atlas pages. Increase atlas size or narrow the charset.`,
    );
  }

  const atlasPng = new Uint8Array(bmfont.textures[0].texture);
  const parsedMetadata = parseBmfontJson(options.font.id, bmfont.font.data);
  const fallbackCodePoint = options.font.fallbackCodePoint ?? DEFAULT_FALLBACK_CODE_POINT;

  const metadata: GeneratedFontMetadata = {
    ...parsedMetadata,
    baseFontSizePx: options.font.baseSizePx,
    msdf: { pxRange: options.font.msdf.pxRange },
    ...(fallbackCodePoint !== undefined ? { fallbackCodePoint } : {}),
  };

  const metadataJson = stableJson(metadata);
  const metadataBytes = Buffer.from(metadataJson, 'utf8');

  const contentHash = createHash('sha256')
    .update(atlasPng)
    .update(metadataBytes)
    .digest('hex');

  return {
    atlasPng,
    metadataJson,
    contentHash,
  };
}
