#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

if [[ -f "$PID_FILE" ]]; then
  existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "${existing_pid:-}" ]] && is_running "$existing_pid"; then
    echo "[shell-desktop] MCP gateway daemon already running (pid=$existing_pid, endpoint=http://127.0.0.1:${MCP_PORT}/mcp/sse)"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"

cd "$ROOT_DIR"
echo "[shell-desktop] Building shell-desktop gateway artifacts..." >>"$LOG_FILE"
pnpm --filter @idle-engine/shell-desktop run build >>"$LOG_FILE" 2>&1

if ! command -v setsid >/dev/null 2>&1; then
  echo "[shell-desktop] setsid is required but was not found in PATH." >&2
  exit 1
fi

rm -f "$PID_FILE"
setsid -f bash -c "echo \$\$ > '$PID_FILE'; exec node '$ROOT_DIR/packages/shell-desktop/dist/mcp/mcp-gateway-cli.js' >>'$LOG_FILE' 2>&1" || {
  echo "[shell-desktop] Failed to daemonize MCP gateway process." >&2
  exit 1
}

for _ in $(seq 1 120); do
  if [[ ! -f "$PID_FILE" ]]; then
    sleep 0.25
    continue
  fi

  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -z "${pid:-}" ]]; then
    sleep 0.25
    continue
  fi

  if ! is_running "$pid"; then
    echo "[shell-desktop] MCP gateway daemon failed to start. Recent logs:" >&2
    tail -n 80 "$LOG_FILE" >&2 || true
    exit 1
  fi

  if curl -f -sS --max-time 1 -o /dev/null "http://127.0.0.1:${MCP_PORT}/healthz"; then
    echo "[shell-desktop] MCP gateway daemon started (pid=$pid, endpoint=http://127.0.0.1:${MCP_PORT}/mcp/sse)"
    exit 0
  fi

  sleep 0.25
done

echo "[shell-desktop] MCP gateway daemon did not become reachable in time. Recent logs:" >&2
tail -n 80 "$LOG_FILE" >&2 || true
exit 1
