#!/usr/bin/env bash
set -euo pipefail

DISPLAY_ID="${IDLE_ENGINE_XPRA_DISPLAY:-:121}"
XPRA_SOCKET_DIR="${IDLE_ENGINE_XPRA_SOCKET_DIR:-$HOME/.xpra}"

if ! command -v xpra >/dev/null 2>&1; then
  echo "xpra is required but was not found in PATH." >&2
  exit 1
fi

xpra stop "$DISPLAY_ID" --socket-dir="$XPRA_SOCKET_DIR" || true
