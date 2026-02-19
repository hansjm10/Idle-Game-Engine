#!/usr/bin/env bash
set -euo pipefail

PID_FILE="${IDLE_ENGINE_MCP_GATEWAY_PID_FILE:-/tmp/idle-engine-shell-desktop-mcp-gateway.pid}"

is_running() {
  local pid="$1"
  kill -0 "$pid" >/dev/null 2>&1
}

if [[ ! -f "$PID_FILE" ]]; then
  echo "[shell-desktop] MCP gateway daemon is not running (pid file missing)."
  exit 0
fi

pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "${pid:-}" ]]; then
  rm -f "$PID_FILE"
  echo "[shell-desktop] MCP gateway daemon is not running (empty pid file)."
  exit 0
fi

if ! is_running "$pid"; then
  rm -f "$PID_FILE"
  echo "[shell-desktop] MCP gateway daemon is not running (stale pid file removed)."
  exit 0
fi

kill "$pid" >/dev/null 2>&1 || true
for _ in $(seq 1 80); do
  if ! is_running "$pid"; then
    rm -f "$PID_FILE"
    echo "[shell-desktop] MCP gateway daemon stopped."
    exit 0
  fi
  sleep 0.25
done

kill -9 "$pid" >/dev/null 2>&1 || true
rm -f "$PID_FILE"
echo "[shell-desktop] MCP gateway daemon force-stopped."
