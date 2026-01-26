import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { NormalizedFontAsset } from '@idle-engine/content-schema';

function createFont(overrides: Partial<NormalizedFontAsset> = {}): NormalizedFontAsset {
  return {
    id: 'test-font' as NormalizedFontAsset['id'],
    source: 'fonts/test.ttf',
    baseSizePx: 16,
    codePointRanges: [[65, 66]],
    technique: 'msdf',
    msdf: { pxRange: 3 },
    ...overrides,
  };
}

describe('content-compiler font artifacts', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('generates metadata, hashes output, and caches the msdf generator', async () => {
    const atlasBytes = Buffer.from([11, 22, 33, 44]);
    const bmfontJson = JSON.stringify({
      common: { lineHeight: 18.7 },
      chars: [
        {
          id: 66.9,
          x: 10.2,
          y: 20.8,
          width: 5.9,
          height: 6.1,
          xoffset: 0.5,
          yoffset: -1.5,
          xadvance: 7.25,
        },
        {
          id: 65,
          x: 0,
          y: 0,
          width: 4,
          height: 5,
          xoffset: 0,
          yoffset: 0,
          xadvance: 6,
        },
      ],
    });

    const generateBmfont = vi.fn(
      (
        _fontPathOrBuffer: string | Buffer,
        _options: unknown,
        callback: (error: Error | null, textures: unknown, font: unknown) => void,
      ) => {
        callback(
          null,
          [{ filename: 'atlas.png', texture: atlasBytes }],
          { filename: 'font.json', data: bmfontJson },
        );
      },
    );

    const requireFn = vi.fn((id: string) => {
      if (id === 'msdf-bmfont-xml') {
        return generateBmfont;
      }
      throw new Error(`Unexpected require(${id}).`);
    });

    vi.doMock('node:module', () => ({
      createRequire: vi.fn(() => requireFn),
    }));

    const { generateMsdfFontAssetFiles } = await import('./fonts.js');

    const font = createFont({
      id: 'ui-font' as NormalizedFontAsset['id'],
      baseSizePx: 42,
      codePointRanges: [[65, 66]],
      msdf: { pxRange: 7 },
    });

    const first = await generateMsdfFontAssetFiles({
      font,
      sourcePath: '/tmp/ui-font.ttf',
    });

    const second = await generateMsdfFontAssetFiles({
      font,
      sourcePath: '/tmp/ui-font.ttf',
    });

    expect(requireFn).toHaveBeenCalledTimes(1);
    expect(generateBmfont).toHaveBeenCalledTimes(2);

    const [fontPath, options] = generateBmfont.mock.calls[0] ?? [];
    expect(fontPath).toBe('/tmp/ui-font.ttf');
    expect(options).toMatchObject({
      outputType: 'json',
      charset: 'AB?',
      fontSize: 42,
      textureSize: [512, 512],
      texturePadding: 2,
      fieldType: 'msdf',
      distanceRange: 7,
      roundDecimal: 0,
    });

    expect(second.atlasPng).toEqual(first.atlasPng);
    expect(second.metadataJson).toBe(first.metadataJson);
    expect(second.contentHash).toBe(first.contentHash);

    const parsedMetadata = JSON.parse(first.metadataJson) as Record<string, unknown>;
    expect(parsedMetadata).toMatchObject({
      schemaVersion: 1,
      id: 'ui-font',
      technique: 'msdf',
      baseFontSizePx: 42,
      lineHeightPx: 18.7,
      fallbackCodePoint: 63,
      msdf: { pxRange: 7 },
    });

    const glyphs = parsedMetadata['glyphs'] as Array<Record<string, unknown>>;
    expect(glyphs.map((glyph) => glyph['codePoint'])).toEqual([65, 66]);
    expect(glyphs[1]).toMatchObject({
      codePoint: 66,
      x: 10,
      y: 20,
      width: 5,
      height: 6,
      xOffsetPx: 0.5,
      yOffsetPx: -1.5,
      xAdvancePx: 7.25,
    });

    const expectedHash = createHash('sha256')
      .update(first.atlasPng)
      .update(Buffer.from(first.metadataJson, 'utf8'))
      .digest('hex');
    expect(first.contentHash).toBe(expectedHash);
  });

  it('does not append the fallback when it is already covered by codePointRanges', async () => {
    const generateBmfont = vi.fn(
      (
        _fontPathOrBuffer: string | Buffer,
        options: { charset: string },
        callback: (error: Error | null, textures: unknown, font: unknown) => void,
      ) => {
        callback(null, [{ filename: 'atlas.png', texture: Buffer.from([1]) }], {
          filename: 'font.json',
          data: JSON.stringify({ common: { lineHeight: 1 }, chars: [] }),
        });
        expect(options.charset).toBe('?');
      },
    );

    vi.doMock('node:module', () => ({
      createRequire: vi.fn(() => (id: string) => {
        if (id === 'msdf-bmfont-xml') {
          return generateBmfont;
        }
        throw new Error(`Unexpected require(${id}).`);
      }),
    }));

    const { generateMsdfFontAssetFiles } = await import('./fonts.js');
    await generateMsdfFontAssetFiles({
      font: createFont({
        codePointRanges: [[63, 63]],
      }),
      sourcePath: '/tmp/ui-font.ttf',
    });
  });

  it('throws when codePointRanges produce too many glyphs', async () => {
    vi.doMock('node:module', () => ({
      createRequire: vi.fn(() => vi.fn()),
    }));

    const { generateMsdfFontAssetFiles } = await import('./fonts.js');

    await expect(
      generateMsdfFontAssetFiles({
        font: createFont({
          codePointRanges: [[0, 4096]],
        }),
        sourcePath: '/tmp/too-many.ttf',
      }),
    ).rejects.toThrow(/exceeds max glyph count/);
  });

  it('throws when msdf-bmfont-xml emits multiple atlas pages', async () => {
    const generateBmfont = vi.fn(
      (
        _fontPathOrBuffer: string | Buffer,
        _options: unknown,
        callback: (error: Error | null, textures: unknown, font: unknown) => void,
      ) => {
        callback(null, [
          { filename: 'atlas-1.png', texture: Buffer.from([1]) },
          { filename: 'atlas-2.png', texture: Buffer.from([2]) },
        ], { filename: 'font.json', data: JSON.stringify({ common: { lineHeight: 1 }, chars: [] }) });
      },
    );

    vi.doMock('node:module', () => ({
      createRequire: vi.fn(() => (id: string) => {
        if (id === 'msdf-bmfont-xml') {
          return generateBmfont;
        }
        throw new Error(`Unexpected require(${id}).`);
      }),
    }));

    const { generateMsdfFontAssetFiles } = await import('./fonts.js');

    await expect(
      generateMsdfFontAssetFiles({
        font: createFont(),
        sourcePath: '/tmp/ui-font.ttf',
      }),
    ).rejects.toThrow(/produced 2 atlas pages/);
  });

  it('throws when the bmfont json is missing expected blocks', async () => {
    const generateBmfont = vi.fn(
      (
        _fontPathOrBuffer: string | Buffer,
        _options: unknown,
        callback: (error: Error | null, textures: unknown, font: unknown) => void,
      ) => {
        callback(null, [{ filename: 'atlas.png', texture: Buffer.from([1]) }], {
          filename: 'font.json',
          data: JSON.stringify({ chars: [] }),
        });
      },
    );

    vi.doMock('node:module', () => ({
      createRequire: vi.fn(() => (id: string) => {
        if (id === 'msdf-bmfont-xml') {
          return generateBmfont;
        }
        throw new Error(`Unexpected require(${id}).`);
      }),
    }));

    const { generateMsdfFontAssetFiles } = await import('./fonts.js');

    await expect(
      generateMsdfFontAssetFiles({
        font: createFont(),
        sourcePath: '/tmp/ui-font.ttf',
      }),
    ).rejects.toThrow(/missing common block/);
  });

  it('throws when canonicalizing metadata fails', async () => {
    const generateBmfont = vi.fn(
      (
        _fontPathOrBuffer: string | Buffer,
        _options: unknown,
        callback: (error: Error | null, textures: unknown, font: unknown) => void,
      ) => {
        callback(null, [{ filename: 'atlas.png', texture: Buffer.from([1]) }], {
          filename: 'font.json',
          data: JSON.stringify({ common: { lineHeight: 1 }, chars: [] }),
        });
      },
    );

    vi.doMock('node:module', () => ({
      createRequire: vi.fn(() => (id: string) => {
        if (id === 'msdf-bmfont-xml') {
          return generateBmfont;
        }
        throw new Error(`Unexpected require(${id}).`);
      }),
    }));

    vi.doMock('canonicalize', () => ({
      default: vi.fn(() => null),
    }));

    const { generateMsdfFontAssetFiles } = await import('./fonts.js');

    await expect(
      generateMsdfFontAssetFiles({
        font: createFont(),
        sourcePath: '/tmp/ui-font.ttf',
      }),
    ).rejects.toThrow(/Failed to canonicalize font metadata/);
  });
});
