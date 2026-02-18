#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DISPLAY_ID="${IDLE_ENGINE_XPRA_DISPLAY:-:121}"
XPRA_SOCKET_DIR="${IDLE_ENGINE_XPRA_SOCKET_DIR:-$HOME/.xpra}"
MCP_ENABLED="${IDLE_ENGINE_ENABLE_MCP_SERVER:-1}"
MCP_PORT="${IDLE_ENGINE_MCP_PORT:-8570}"
BUILD_BEFORE_START="${IDLE_ENGINE_BUILD_BEFORE_START:-1}"
NO_SANDBOX="${IDLE_ENGINE_NO_SANDBOX:-1}"

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
  xpra start "$DISPLAY_ID" \
    --daemon=yes \
    --socket-dir="$XPRA_SOCKET_DIR" \
    --notifications=no \
    --pulseaudio=no \
    --mdns=no \
    --exit-with-children=no \
    --speaker=off \
    --microphone=off \
    --start=/bin/true
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

if [[ "$MCP_ENABLED" == "1" ]]; then
  echo "[shell-desktop] MCP endpoint: http://127.0.0.1:$MCP_PORT/mcp/sse"
fi

echo "[shell-desktop] Launching on DISPLAY=$DISPLAY_ID (xpra socket dir: $XPRA_SOCKET_DIR)"

cd "$ROOT_DIR/packages/shell-desktop"
DISPLAY="$DISPLAY_ID" IDLE_ENGINE_ENABLE_MCP_SERVER="$MCP_ENABLED" IDLE_ENGINE_MCP_PORT="$MCP_PORT" pnpm exec electron "${ELECTRON_ARGS[@]}" "${APP_ARGS[@]}" "$@"
