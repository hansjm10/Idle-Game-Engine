# `@idle-engine/shell-desktop`

Electron desktop shell scaffold for hosting the Idle Engine simulation + renderer integration.

## Usage

```bash
pnpm --filter @idle-engine/shell-desktop run build
pnpm --filter @idle-engine/shell-desktop run start
```

## Notes
- The renderer process runs with `contextIsolation: true` and `nodeIntegration: false`; the preload exposes a minimal, typed API on `window.idleEngine`.
- The build copies renderer static assets from `src/renderer` into `dist/renderer` via `tools/scripts/copy-renderer-assets.mjs`.
- On Linux in headless/CI environments you may need an X/Wayland display (e.g. `xvfb-run`) to launch the window.
