import { RENDERER_CONTRACT_SCHEMA_VERSION } from '@idle-engine/renderer-contract';
import type { AssetId, AssetManifest } from '@idle-engine/renderer-contract';

export const SHELL_DEFAULT_FONT_ID = 'font:default' as AssetId;

export const SHELL_ASSET_MANIFEST: AssetManifest = {
  schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
  assets: [
    {
      id: SHELL_DEFAULT_FONT_ID,
      kind: 'font',
      contentHash: 'shell:runtime-generated',
    },
  ],
};
