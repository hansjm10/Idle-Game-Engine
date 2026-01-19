import type { AssetId } from '@idle-engine/renderer-contract';

export interface WebGpuAtlasImageInput {
  readonly assetId: AssetId;
  readonly width: number;
  readonly height: number;
}

export interface WebGpuAtlasLayoutEntry {
  readonly assetId: AssetId;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WebGpuAtlasLayout {
  readonly schemaVersion: 1;
  readonly atlasWidthPx: number;
  readonly atlasHeightPx: number;
  readonly paddingPx: number;
  readonly entries: readonly WebGpuAtlasLayoutEntry[];
}

export interface WebGpuAtlasPackingOptions {
  /**
   * Maximum atlas dimension in pixels (width and height).
   */
  readonly maxSizePx?: number;
  /**
   * Gap between sprites packed into the atlas (both axes).
   */
  readonly paddingPx?: number;
  /**
   * When enabled, atlas dimensions are rounded up to powers of two.
   */
  readonly powerOfTwo?: boolean;
}

export interface WebGpuAtlasPackingResult {
  readonly atlasWidthPx: number;
  readonly atlasHeightPx: number;
  readonly paddingPx: number;
  readonly entries: readonly WebGpuAtlasLayoutEntry[];
}

const DEFAULT_MAX_SIZE_PX = 2048;
const DEFAULT_PADDING_PX = 2;

function compareAssetId(a: AssetId, b: AssetId): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function nextPowerOfTwo(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 1;
  }

  let result = 1;
  while (result < value) {
    result *= 2;
  }
  return result;
}

function packShelf(
  images: readonly WebGpuAtlasImageInput[],
  atlasWidthPx: number,
  paddingPx: number,
): {
  readonly packedHeightPx: number;
  readonly entries: readonly WebGpuAtlasLayoutEntry[];
} {
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;

  const entries: WebGpuAtlasLayoutEntry[] = [];

  for (const image of images) {
    if (image.width <= 0 || image.height <= 0) {
      throw new Error(`Atlas image ${image.assetId} has invalid size ${image.width}x${image.height}.`);
    }

    if (image.width > atlasWidthPx) {
      throw new Error(
        `Atlas image ${image.assetId} width (${image.width}) exceeds atlas width (${atlasWidthPx}).`,
      );
    }

    if (cursorX > 0 && cursorX + image.width > atlasWidthPx) {
      cursorX = 0;
      cursorY += rowHeight + paddingPx;
      rowHeight = 0;
    }

    entries.push({
      assetId: image.assetId,
      x: cursorX,
      y: cursorY,
      width: image.width,
      height: image.height,
    });

    cursorX += image.width + paddingPx;
    rowHeight = Math.max(rowHeight, image.height);
  }

  const packedHeightPx = cursorY + rowHeight;
  return { packedHeightPx, entries };
}

export function packAtlas(
  inputImages: readonly WebGpuAtlasImageInput[],
  options: WebGpuAtlasPackingOptions = {},
): WebGpuAtlasPackingResult {
  const maxSizePx = options.maxSizePx ?? DEFAULT_MAX_SIZE_PX;
  const paddingPx = options.paddingPx ?? DEFAULT_PADDING_PX;
  const powerOfTwo = options.powerOfTwo ?? true;

  if (!Number.isFinite(maxSizePx) || maxSizePx <= 0) {
    throw new Error(`Invalid atlas maxSizePx: ${maxSizePx}`);
  }

  const images = [...inputImages].sort((a, b) => compareAssetId(a.assetId, b.assetId));

  for (let i = 1; i < images.length; i += 1) {
    const previous = images[i - 1];
    const current = images[i];
    if (previous && current && previous.assetId === current.assetId) {
      throw new Error(`Atlas input contains duplicate AssetId: ${current.assetId}`);
    }
  }

  let maxImageWidth = 1;
  for (const image of images) {
    maxImageWidth = Math.max(maxImageWidth, image.width);
  }

  let atlasWidthPx = powerOfTwo ? nextPowerOfTwo(maxImageWidth) : maxImageWidth;
  if (atlasWidthPx > maxSizePx) {
    throw new Error(
      `Atlas requires width ${atlasWidthPx} but maxSizePx is ${maxSizePx}.`,
    );
  }

  while (true) {
    const { packedHeightPx, entries } = packShelf(images, atlasWidthPx, paddingPx);
    const atlasHeightCandidate = powerOfTwo ? nextPowerOfTwo(packedHeightPx) : packedHeightPx;

    if (atlasHeightCandidate <= maxSizePx) {
      return {
        atlasWidthPx,
        atlasHeightPx: atlasHeightCandidate,
        paddingPx,
        entries,
      };
    }

    if (powerOfTwo) {
      atlasWidthPx *= 2;
    } else {
      atlasWidthPx = Math.min(maxSizePx, atlasWidthPx * 2);
    }

    if (atlasWidthPx > maxSizePx) {
      throw new Error(
        `Atlas packing exceeded maxSizePx ${maxSizePx} (height needed ${atlasHeightCandidate}).`,
      );
    }
  }
}

export function createAtlasLayout(result: WebGpuAtlasPackingResult): WebGpuAtlasLayout {
  return {
    schemaVersion: 1,
    atlasWidthPx: result.atlasWidthPx,
    atlasHeightPx: result.atlasHeightPx,
    paddingPx: result.paddingPx,
    entries: result.entries,
  };
}

export const __test__ = {
  compareAssetId,
  nextPowerOfTwo,
  packShelf,
};
