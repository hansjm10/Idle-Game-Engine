# Shell Desktop MCP Tool Workflows

## Tool Catalog

- `mcp__idle-engine-shell-desktop__health`: backend/gateway availability signal.
- `mcp__idle-engine-shell-desktop__sim_status`: current sim lifecycle and step metadata.
- `mcp__idle-engine-shell-desktop__sim_start`: start tick loop.
- `mcp__idle-engine-shell-desktop__sim_pause`: pause tick loop.
- `mcp__idle-engine-shell-desktop__sim_resume`: resume paused loop.
- `mcp__idle-engine-shell-desktop__sim_step`: advance by N steps while paused.
- `mcp__idle-engine-shell-desktop__sim_stop`: stop and dispose worker.
- `mcp__idle-engine-shell-desktop__sim_enqueue`: enqueue runtime commands deterministically.
- `mcp__idle-engine-shell-desktop__window_info`: read bounds/url/devtools state.
- `mcp__idle-engine-shell-desktop__window_resize`: set window width/height.
- `mcp__idle-engine-shell-desktop__window_devtools`: open/close/toggle devtools.
- `mcp__idle-engine-shell-desktop__window_screenshot`: capture bounded PNG bytes.
- `mcp__idle-engine-shell-desktop__input_controlEvent`: inject control event into shell control scheme.
- `mcp__idle-engine-shell-desktop__asset_list`: list compiled assets under root.
- `mcp__idle-engine-shell-desktop__asset_read`: read asset file content.

## Standard Sequences

### 1) Deterministic Regression Snapshot

1. `health`
2. `sim_status`
3. `sim_start` (if not running)
4. `sim_pause`
5. `sim_step` with `steps: 120`
6. `window_resize` (e.g. `1280x720`)
7. `window_screenshot`
8. `sim_status`

### 2) Runtime Debug Triage

1. `health`
2. `window_info`
3. `window_devtools` with `action: "open"`
4. `sim_status`
5. If running: `sim_pause` then `sim_step` with `steps: 1`
6. `window_screenshot`

### 3) Content Inspection + Exercise

1. `asset_list` with path + bounded `maxEntries`
2. `asset_read` with discovered file path + bounded `maxBytes`
3. `sim_enqueue` with targeted runtime command(s)
4. `sim_step` (paused flow) or `sim_resume` (live flow)
5. `sim_status`

## Parameter Notes

- `sim_step.steps`: omit for default single-step; set integer for deterministic batches.
- `window_devtools.action`: use `open`, `close`, or `toggle`.
- `window_resize`: always pass both `width` and `height` integers.
- `input_controlEvent`: always pass `intent` and `phase`; add `value`/`metadata` only if needed.
- `asset_list.path`: relative path from compiled assets root.
- `asset_read.maxBytes`: cap reads to avoid oversized payloads.

## Startup Commands (Repo)

- Direct headless shell with MCP:
  - `pnpm shell:desktop:headless`
- Gateway + backend split:
  - `pnpm shell:desktop:mcp:gateway`
  - `pnpm shell:desktop:headless:gateway-backend`
- Smoke test:
  - `pnpm shell:desktop:mcp:smoke`

## Failure Handling

- If `health` reports backend down in gateway mode, start backend and retry.
- If screenshot is blank or stale, capture `sim_status`, then pause/step and recapture.
- If an asset path fails, re-list parent directory and select an existing path.
