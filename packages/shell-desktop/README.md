# `@idle-engine/shell-desktop`

Electron desktop shell scaffold for hosting the Idle Engine simulation + renderer integration.

## Usage

```bash
pnpm --filter @idle-engine/shell-desktop run build
pnpm --filter @idle-engine/shell-desktop run start
```

## Headless Remote Usage (xpra)

For remote/headless Linux hosts, use the workspace helper that starts (or reuses) an xpra display and launches Electron with `--no-sandbox`:

```bash
pnpm shell:desktop:headless
```

Defaults:
- xpra display: `:121`
- xpra backend: `xorg` (hardware GL path via `tools/scripts/xpra-xorg-wrapper.sh`)
- MCP enabled: `1`
- MCP port: `8570`
- Vulkan feature flag: enabled (`--enable-features=Vulkan`)

Useful overrides:

```bash
IDLE_ENGINE_XPRA_DISPLAY=:122 IDLE_ENGINE_MCP_PORT=8571 pnpm shell:desktop:headless
IDLE_ENGINE_XPRA_BACKEND=xvfb IDLE_ENGINE_REQUIRE_HW_GL=0 pnpm shell:desktop:headless
pnpm shell:desktop:mcp:smoke
pnpm shell:desktop:headless:stop
```

Set `IDLE_ENGINE_COMPILED_ASSETS_ROOT=/abs/path/to/content/compiled` to reuse the MCP asset tools with a non-sample game content pack.

Always-on MCP gateway (for Codex/Cursor startup before shell launch):

```bash
pnpm shell:desktop:mcp:gateway
pnpm shell:desktop:headless:gateway-backend
```

Daemonized always-on mode (from repo root):

```bash
pnpm shell:desktop:mcp:gateway:daemon:start
pnpm shell:desktop:mcp:gateway:daemon:status
pnpm shell:desktop:mcp:gateway:daemon:stop
```

Quick GPU verification:

```bash
vulkaninfo --summary
```

Electron DevTools:

```js
navigator.gpu
const a = await navigator.gpu.requestAdapter(); a?.name
```

## WebGPU

- Development runs enable Electron’s WebGPU bring-up switch automatically (see `enable-unsafe-webgpu` in `src/main.ts`).
- Packaged runs require an explicit override: set `IDLE_ENGINE_ENABLE_UNSAFE_WEBGPU=1` before launching.
- The current renderer entrypoint presents a stable clear color and prints status lines (IPC + WebGPU) to the on-screen overlay.

## Notes
- The renderer process runs with `contextIsolation: true` and `nodeIntegration: false`; the preload exposes a minimal, typed API on `window.idleEngine`.
- The build bundles `src/renderer/index.ts` into `dist/renderer/index.js` (so the renderer does not rely on `../../../*/dist/*` imports) and copies static assets via `tools/scripts/copy-renderer-assets.mjs`.
- On Linux in headless/CI environments you may need an X/Wayland display (e.g. `xvfb-run`) to launch the window.
