#!/usr/bin/env bash
set -euo pipefail

PID_FILE="${IDLE_ENGINE_MCP_GATEWAY_PID_FILE:-/tmp/idle-engine-shell-desktop-mcp-gateway.pid}"
LOG_FILE="${IDLE_ENGINE_MCP_GATEWAY_LOG_FILE:-/tmp/idle-engine-shell-desktop-mcp-gateway.log}"
MCP_PORT="${IDLE_ENGINE_MCP_PORT:-8570}"

is_running() {
  local pid="$1"
  if kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

if [[ ! -f "$PID_FILE" ]]; then
  echo "[shell-desktop] MCP gateway daemon status: stopped (no pid file)."
  exit 1
fi

pid="$(cat "$PID_FILE" 2>/dev/null || true)"
if [[ -z "${pid:-}" ]]; then
  echo "[shell-desktop] MCP gateway daemon status: stopped (empty pid file)."
  exit 1
fi

if ! is_running "$pid"; then
  echo "[shell-desktop] MCP gateway daemon status: stopped (stale pid=$pid)."
  exit 1
fi

if curl -f -sS --max-time 1 -o /dev/null "http://127.0.0.1:${MCP_PORT}/healthz"; then
  echo "[shell-desktop] MCP gateway daemon status: running (pid=$pid, endpoint=http://127.0.0.1:${MCP_PORT}/mcp/sse, log=$LOG_FILE)."
  exit 0
fi

echo "[shell-desktop] MCP gateway daemon status: running (pid=$pid) but endpoint is not reachable yet."
exit 1
