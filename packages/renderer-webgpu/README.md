# `@idle-engine/renderer-webgpu`

WebGPU renderer backend for the Idle Engine renderer contract, including deterministic sprite atlasing + instanced quad batching.

## API

- `createWebGpuRenderer(canvas, options?)` → `Promise<WebGpuRenderer>`
- `WebGpuRenderer.resize(options?)` updates the canvas pixel size and reconfigures the context.
- `WebGpuRenderer.loadAssets(manifest, assets, options?)` builds a deterministic texture atlas (including bitmap fonts) and exposes `atlasLayoutHash`.
- `WebGpuRenderer.render(rcb)` clears and renders `rect` + `image` + `text` draws (instanced quads), with optional `scissorPush`/`scissorPop` clipping.
- `WebGpuRenderer.dispose()` stops future `render/resize` calls from doing GPU work.

## Text rendering

`text` draws are rendered using bitmap fonts supplied via `assets.loadFont(...)`. Layout is deterministic (no OS font fallback, no kerning/shaping).

## Options

- `requiredFeatures`: validated against `adapter.features`; missing features throw `WebGpuNotSupportedError`.
- `preferredFormats`: when provided, the first entry is used. The implementation does not probe format support or fall back to later entries.
- `worldFixedPointScale`: scale factor for world-pass draw coordinates (defaults to `WORLD_FIXED_POINT_SCALE`). Set to `1` if you are supplying world coordinates as unscaled floats.
- `onDeviceLost`: invoked when `device.lost` resolves; after loss, the renderer no-ops `render/resize`.

## Environment

- Requires a runtime with WebGPU enabled.
- In Electron, WebGPU bring-up may require `enable-unsafe-webgpu` (see `@idle-engine/shell-desktop`).

## Example

```ts
import { createWebGpuRenderer } from '@idle-engine/renderer-webgpu';
import { RENDERER_CONTRACT_SCHEMA_VERSION, WORLD_FIXED_POINT_SCALE } from '@idle-engine/renderer-contract';
import type { AssetId, AssetManifest, RenderCommandBuffer } from '@idle-engine/renderer-contract';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
if (!canvas) throw new Error('Missing canvas');

const renderer = await createWebGpuRenderer(canvas, {
  onDeviceLost: (error) => {
    console.error('Device lost', error.reason);
  },
});

const demoAssetId = 'sprite:demo' as AssetId;
const manifest: AssetManifest = {
  schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION,
  assets: [{ id: demoAssetId, kind: 'image', contentHash: 'demo' }],
};

await renderer.loadAssets(manifest, {
  async loadImage(assetId) {
    if (assetId !== demoAssetId) {
      throw new Error(`Unknown assetId: ${assetId}`);
    }

    const image = new Image();
    image.src = '/sprites/demo.png';
    await image.decode();
    return image;
  },
});

const rcb: RenderCommandBuffer = {
  frame: { schemaVersion: RENDERER_CONTRACT_SCHEMA_VERSION, step: 0, simTimeMs: 0, contentHash: 'content:dev' },
  passes: [{ id: 'world' }],
  draws: [
    {
      kind: 'clear',
      passId: 'world',
      sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
      colorRgba: 0x18_2a_44_ff,
    },
    {
      kind: 'image',
      passId: 'world',
      sortKey: { sortKeyHi: 0, sortKeyLo: 1 },
      assetId: demoAssetId,
      x: 20 * WORLD_FIXED_POINT_SCALE,
      y: 20 * WORLD_FIXED_POINT_SCALE,
      width: 64 * WORLD_FIXED_POINT_SCALE,
      height: 64 * WORLD_FIXED_POINT_SCALE,
    },
  ],
};

renderer.render(rcb);
```
