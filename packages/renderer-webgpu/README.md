# `@idle-engine/renderer-webgpu`

Minimal WebGPU renderer backend (device init + clear pass) for the Idle Engine renderer contract.

## API

- `createWebGpuRenderer(canvas, options?)` → `Promise<WebGpuRenderer>`
- `WebGpuRenderer.resize(options?)` updates the canvas pixel size and reconfigures the context.
- `WebGpuRenderer.render(rcb)` submits a render pass that clears to the selected color from the `RenderCommandBuffer`.
- `WebGpuRenderer.dispose()` stops future `render/resize` calls from doing GPU work.

## Options

- `requiredFeatures`: validated against `adapter.features`; missing features throw `WebGpuNotSupportedError`.
- `preferredFormats`: when provided, the first entry is used. The implementation does not probe format support or fall back to later entries.
- `onDeviceLost`: invoked when `device.lost` resolves; after loss, the renderer no-ops `render/resize`.

## Environment

- Requires a runtime with WebGPU enabled.
- In Electron, WebGPU bring-up may require `enable-unsafe-webgpu` (see `@idle-engine/shell-desktop`).

## Example

```ts
import { createWebGpuRenderer } from '@idle-engine/renderer-webgpu';

const canvas = document.querySelector<HTMLCanvasElement>('#canvas');
if (!canvas) throw new Error('Missing canvas');

const renderer = await createWebGpuRenderer(canvas, {
  onDeviceLost: (error) => {
    console.error('Device lost', error.reason);
  },
});

renderer.render({
  frame: { schemaVersion: 1, step: 0, simTimeMs: 0, contentHash: 'content:dev' },
  passes: [{ id: 'world' }],
  draws: [
    {
      kind: 'clear',
      passId: 'world',
      sortKey: { sortKeyHi: 0, sortKeyLo: 0 },
      colorRgba: 0x18_2a_44_ff,
    },
  ],
});
```
