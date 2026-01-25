import type { AssetId, Sha256Hex } from '@idle-engine/renderer-contract';
import type {
  WebGpuBitmapFont,
  WebGpuRendererAssets,
} from '@idle-engine/renderer-webgpu';

import {
  generateBitmapFont,
  DEFAULT_FONT_ATLAS_CONFIG,
} from './font-atlas-generator.js';
import type { FontAtlasConfig } from './font-atlas-generator.js';
import { SHELL_DEFAULT_FONT_ID } from './shell-manifest.js';

export interface ShellAssetLoaderOptions {
  fontFamily?: string;
  baseFontSizePx?: number;
}

export function createShellAssetLoader(
  options?: ShellAssetLoaderOptions,
): WebGpuRendererAssets {
  const fontConfig: FontAtlasConfig = {
    ...DEFAULT_FONT_ATLAS_CONFIG,
    fontFamily: options?.fontFamily ?? DEFAULT_FONT_ATLAS_CONFIG.fontFamily,
    baseFontSizePx:
      options?.baseFontSizePx ?? DEFAULT_FONT_ATLAS_CONFIG.baseFontSizePx,
  };

  let cachedFont: WebGpuBitmapFont | undefined;

  return {
    loadImage(
      assetId: AssetId,
      _contentHash: Sha256Hex,
    ): Promise<GPUImageCopyExternalImageSource> {
      throw new Error(
        `Shell desktop does not support image assets: ${assetId}`,
      );
    },

    loadFont(
      assetId: AssetId,
      _contentHash: Sha256Hex,
    ): Promise<WebGpuBitmapFont> {
      if (assetId !== SHELL_DEFAULT_FONT_ID) {
        throw new Error(`Unknown font asset: ${assetId}`);
      }

      if (!cachedFont) {
        cachedFont = generateBitmapFont(fontConfig);
      }

      return Promise.resolve(cachedFont);
    },
  };
}
