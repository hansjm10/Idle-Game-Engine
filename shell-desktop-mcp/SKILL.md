---
name: shell-desktop-mcp
description: Operate the Idle Engine Electron shell through the shell-desktop MCP server, including simulation lifecycle control, deterministic stepping, window diagnostics/screenshots, shell control events, and compiled asset inspection. Use when tasks mention shell-desktop MCP, Electron shell automation, `mcp__idle-engine-shell-desktop__*` tools, headless xpra runs, runtime debugging, or regression capture from the desktop shell.
---

# Shell Desktop MCP

## Overview

Drive the Electron shell via MCP tools with deterministic, testable workflows.
Prefer short preflight checks, explicit state transitions, and reproducible evidence capture.

## Workflow

1. Confirm backend availability before any action.
2. Capture baseline shell/sim state.
3. Run the requested simulation, window, input, or asset operations.
4. Re-check state and summarize deltas.
5. If needed, capture screenshot/report artifacts for issue follow-up.

## Preflight

Run this sequence first:

1. Call `mcp__idle-engine-shell-desktop__health`.
2. If health is not OK, start shell-desktop via repo scripts:
   - `pnpm shell:desktop:headless` for direct local MCP on `8570`.
   - `pnpm shell:desktop:mcp:gateway` plus `pnpm shell:desktop:headless:gateway-backend` for always-on gateway mode.
3. Call `mcp__idle-engine-shell-desktop__sim_status`.
4. Call `mcp__idle-engine-shell-desktop__window_info`.

If startup is required, use `docs/shell-desktop-mcp.md` for port/env details.

## Operation Patterns

### Simulation Control

- Use `mcp__idle-engine-shell-desktop__sim_start`, `mcp__idle-engine-shell-desktop__sim_pause`, `mcp__idle-engine-shell-desktop__sim_resume`, `mcp__idle-engine-shell-desktop__sim_stop` for lifecycle transitions.
- Use `mcp__idle-engine-shell-desktop__sim_step` only after pause when deterministic frame advancement is required.
- Use `mcp__idle-engine-shell-desktop__sim_enqueue` to inject runtime commands in deterministic order.
- Capture `mcp__idle-engine-shell-desktop__sim_status` before and after each lifecycle mutation.

### Window Diagnostics

- Use `mcp__idle-engine-shell-desktop__window_info` to read bounds/url/devtools state.
- Use `mcp__idle-engine-shell-desktop__window_resize` before screenshot collection.
- Use `mcp__idle-engine-shell-desktop__window_devtools` for renderer debugging.
- Use `mcp__idle-engine-shell-desktop__window_screenshot` to capture bounded PNG evidence.

### Input Injection

- Use `mcp__idle-engine-shell-desktop__input_controlEvent` for shell control intents.
- Prefer explicit `intent`, `phase`, and optional `value`/`metadata` over opaque payloads.
- After input injection, step or resume sim and capture resulting status or screenshot.

### Asset Inspection

- Use `mcp__idle-engine-shell-desktop__asset_list` to enumerate assets first.
- Use `mcp__idle-engine-shell-desktop__asset_read` only on discovered paths.
- Respect bounded reads via `maxBytes` and keep analysis focused on targeted files.

## Determinism and Evidence

- For reproducible debugging, run: pause -> step N -> screenshot -> status.
- Include the exact step count and window size in findings.
- Keep one operation batch per objective (regression, debugging, content inspection) to avoid mixed signals.

## References

- Tool call examples and sequencing: `references/tool-workflows.md`
- MCP server setup/runbook: `docs/shell-desktop-mcp.md`
