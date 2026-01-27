---
title: Shell Desktop MCP Guide
description: Enable and use the embedded MCP server shipped with @idle-engine/shell-desktop
sidebar_position: 25
---

# Shell Desktop MCP Guide

The Electron desktop shell (`@idle-engine/shell-desktop`) ships an embedded [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for local, developer-only automation.

- Disabled by default.
- Binds to `127.0.0.1` only.
- Uses SSE (Server-Sent Events) over HTTP.

## Quickstart

Start the desktop shell with MCP enabled:

```bash
IDLE_ENGINE_ENABLE_MCP_SERVER=1 pnpm --filter @idle-engine/shell-desktop run start
```

By default the server listens on port `8570` and prints a line like:

```text
[shell-desktop] MCP server listening at http://127.0.0.1:8570/mcp/sse
```

### Configuration

- Enablement:
  - Env var: `IDLE_ENGINE_ENABLE_MCP_SERVER=1`
  - Arg: `--enable-mcp-server`
- Port override:
  - Env var: `IDLE_ENGINE_MCP_PORT=8571`
  - Arg: `--mcp-port=8571`

The SSE endpoint is always `/mcp/sse`.

## Tool surface (MVP)

- `health`: basic health/capabilities snapshot.
- `sim/*`: `sim/status`, `sim/start`, `sim/stop`, `sim/pause`, `sim/resume`, `sim/step`, `sim/enqueue`.
- `window/*`: `window/info`, `window/resize`, `window/devtools`, `window/screenshot` (bounded, returns base64 PNG).
- `input/*`: `input/controlEvent` (reuses `ShellControlEvent` semantics).
- `asset/*`: `asset/list`, `asset/read` (scoped to compiled assets root with traversal protection).

## Client setup

### Cursor

Create `.cursor/mcp.json` (repo-local) and point it at the SSE URL:

```json
{
  "mcpServers": {
    "idle-engine-shell-desktop": {
      "url": "http://127.0.0.1:8570/mcp/sse"
    }
  }
}
```

Restart Cursor (or reload MCP servers) after editing the file.

### Claude Desktop

Claude Desktop configures remote MCP servers via its UI (Settings → Connectors). Add a custom MCP server that points at:

```text
http://127.0.0.1:8570/mcp/sse
```

If your Claude Desktop build does not support remote MCP servers (or refuses `http://localhost` URLs), use Cursor or an SSE→stdio bridge tool and then configure the bridge as a local stdio MCP server in Claude Desktop.

## Example workflows

### Regression testing

Prompt template:

> Start the sim, pause it, step 120 frames, take a screenshot, and report `sim/status` plus the screenshot bytes count.

### Debugging

Prompt template:

> Call `window/info`, open devtools via `window/devtools`, then `sim/status`. If the sim is running, pause it and step 1 frame. Summarize what changed.

### Content iteration

Prompt template:

> List assets under the compiled assets root (limit to the top 25 entries). If you find any JSON content, read one file (max 50KB) and summarize what knobs it exposes. Then enqueue a command that would exercise the change, and step 10 frames.
