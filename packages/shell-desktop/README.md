# `@idle-engine/shell-desktop`

Electron desktop shell scaffold for hosting the Idle Engine simulation + renderer integration.

## Usage

```bash
pnpm --filter @idle-engine/shell-desktop run build
pnpm --filter @idle-engine/shell-desktop run start
```

## WebGPU

- Development runs enable Electron’s WebGPU bring-up switch automatically (see `enable-unsafe-webgpu` in `src/main.ts`).
- Packaged runs require an explicit override: set `IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU=1` before launching.
- The current renderer entrypoint presents a stable clear color and prints status lines (IPC + WebGPU) to the on-screen overlay.

## Notes
- The renderer process runs with `contextIsolation: true` and `nodeIntegration: false`; the preload exposes a minimal, typed API on `window.idleEngine`.
- The build bundles `src/renderer/index.ts` into `dist/renderer/index.js` (so the renderer does not rely on `../../../*/dist/*` imports) and copies static assets via `tools/scripts/copy-renderer-assets.mjs`.
- On Linux in headless/CI environments you may need an X/Wayland display (e.g. `xvfb-run`) to launch the window.
