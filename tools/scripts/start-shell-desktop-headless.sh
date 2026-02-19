#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DISPLAY_ID="${IDLE_ENGINE_XPRA_DISPLAY:-:121}"
XPRA_SOCKET_DIR="${IDLE_ENGINE_XPRA_SOCKET_DIR:-$HOME/.xpra}"
XPRA_BACKEND="${IDLE_ENGINE_XPRA_BACKEND:-xorg}"
MCP_ENABLED="${IDLE_ENGINE_ENABLE_MCP_SERVER:-1}"
MCP_GATEWAY_MODE="${IDLE_ENGINE_MCP_GATEWAY_MODE:-0}"
if [[ -n "${IDLE_ENGINE_MCP_PORT:-}" ]]; then
  MCP_PORT="${IDLE_ENGINE_MCP_PORT}"
elif [[ "$MCP_GATEWAY_MODE" == "1" ]]; then
  MCP_PORT="8571"
else
  MCP_PORT="8570"
fi
BUILD_BEFORE_START="${IDLE_ENGINE_BUILD_BEFORE_START:-1}"
NO_SANDBOX="${IDLE_ENGINE_NO_SANDBOX:-1}"
ENABLE_VULKAN_FEATURE="${IDLE_ENGINE_ENABLE_VULKAN_FEATURE:-1}"
REQUIRE_HW_GL="${IDLE_ENGINE_REQUIRE_HW_GL:-1}"
XORG_WRAPPER="$ROOT_DIR/tools/scripts/xpra-xorg-wrapper.sh"

if ! command -v xpra >/dev/null 2>&1; then
  echo "xpra is required but was not found in PATH." >&2
  exit 1
fi

if ! command -v xset >/dev/null 2>&1; then
  echo "xset is required but was not found in PATH." >&2
  exit 1
fi

if [[ -z "${XDG_RUNTIME_DIR:-}" || ! -d "${XDG_RUNTIME_DIR:-}" || ! -w "${XDG_RUNTIME_DIR:-}" ]]; then
  export XDG_RUNTIME_DIR="/tmp/xdg-runtime-$(id -u)"
  mkdir -p "$XDG_RUNTIME_DIR"
  chmod 700 "$XDG_RUNTIME_DIR" || true
fi

mkdir -p /tmp/.X11-unix
chmod 1777 /tmp/.X11-unix || true
mkdir -p "$XPRA_SOCKET_DIR"

XPRA_LIST_OUTPUT="$(xpra list --socket-dir="$XPRA_SOCKET_DIR" 2>/dev/null || true)"
if ! printf '%s\n' "$XPRA_LIST_OUTPUT" | grep -q "LIVE session at ${DISPLAY_ID}$"; then
  XPRA_START_ARGS=(
    "--daemon=yes"
    "--socket-dir=$XPRA_SOCKET_DIR"
    "--notifications=no"
    "--pulseaudio=no"
    "--mdns=no"
    "--exit-with-children=no"
    "--speaker=off"
    "--microphone=off"
    "--start=/bin/true"
  )

  if [[ "$XPRA_BACKEND" == "xorg" ]] && command -v Xorg >/dev/null 2>&1 && [[ -x "$XORG_WRAPPER" ]]; then
    XPRA_START_ARGS+=("--xvfb=$XORG_WRAPPER")
    echo "[shell-desktop] Starting xpra display $DISPLAY_ID with Xorg backend."
  else
    echo "[shell-desktop] Starting xpra display $DISPLAY_ID with Xvfb backend."
  fi

  xpra start "$DISPLAY_ID" \
    "${XPRA_START_ARGS[@]}"
fi

ready=0
for _ in $(seq 1 60); do
  if DISPLAY="$DISPLAY_ID" xset q >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done

if [[ "$ready" != "1" ]]; then
  echo "xpra display $DISPLAY_ID did not become ready." >&2
  exit 1
fi

if command -v glxinfo >/dev/null 2>&1; then
  GL_RENDERER_LINE="$(DISPLAY="$DISPLAY_ID" glxinfo -B 2>/dev/null | grep -m1 'OpenGL renderer string:' || true)"
  if [[ -n "$GL_RENDERER_LINE" ]]; then
    echo "[shell-desktop] ${GL_RENDERER_LINE}"
  fi

  if [[ "$REQUIRE_HW_GL" == "1" ]] && [[ "${GL_RENDERER_LINE,,}" == *"llvmpipe"* ]]; then
    echo "Detected software renderer (llvmpipe) on $DISPLAY_ID; refusing to launch Electron." >&2
    echo "Stop the display and restart with Xorg backend:" >&2
    echo "  pnpm shell:desktop:headless:stop" >&2
    echo "  IDLE_ENGINE_XPRA_BACKEND=xorg pnpm shell:desktop:headless" >&2
    exit 1
  fi
fi

if [[ "$BUILD_BEFORE_START" == "1" ]]; then
  (cd "$ROOT_DIR" && pnpm --filter @idle-engine/shell-desktop run build)
fi

APP_ARGS=("./dist/main.js")
if [[ "$MCP_ENABLED" == "1" ]]; then
  APP_ARGS+=("--enable-mcp-server" "--mcp-port=$MCP_PORT")
fi

ELECTRON_ARGS=()
if [[ "$NO_SANDBOX" == "1" ]]; then
  ELECTRON_ARGS+=("--no-sandbox")
fi
if [[ "$ENABLE_VULKAN_FEATURE" == "1" ]]; then
  ELECTRON_ARGS+=("--enable-features=Vulkan")
fi

if [[ "$MCP_ENABLED" == "1" ]]; then
  echo "[shell-desktop] MCP endpoint: http://127.0.0.1:$MCP_PORT/mcp/sse"
  if [[ "$MCP_GATEWAY_MODE" == "1" ]]; then
    echo "[shell-desktop] Gateway mode enabled (expected gateway endpoint: http://127.0.0.1:8570/mcp/sse)"
  fi
fi

echo "[shell-desktop] Launching on DISPLAY=$DISPLAY_ID (xpra socket dir: $XPRA_SOCKET_DIR)"

cd "$ROOT_DIR/packages/shell-desktop"
DISPLAY="$DISPLAY_ID" IDLE_ENGINE_ENABLE_MCP_SERVER="$MCP_ENABLED" IDLE_ENGINE_MCP_PORT="$MCP_PORT" pnpm exec electron "${ELECTRON_ARGS[@]}" "${APP_ARGS[@]}" "$@"
