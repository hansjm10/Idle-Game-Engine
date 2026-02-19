# Shell Demo Gap Audit Evidence

This folder stores run artifacts for the shell-desktop WebGPU gap audit.

## Protocol

1. Start shell backend for MCP gateway mode:
   - `pnpm shell:desktop:headless:gateway-backend`
2. Verify MCP connectivity:
   - `pnpm shell:desktop:mcp:smoke`
3. For each scenario step:
   - apply scenario action (`sim.*`, `window.*`, `input.*`, or `sim.enqueue`)
   - capture screenshot via MCP `window.screenshot`
   - save under `docs/evidence/shell-demo-gap-audit/screens/`
   - review the image before moving to next step
   - append findings to `docs/issue-shell-demo-gap-audit-template.md`

## Screenshot Naming

Use `NNN-phase-scenario-variant.png`.

Examples:
- `010-baseline-startup-1280x720.png`
- `040-input-pointer-collect-hitbox.png`
- `070-recovery-resume-post-pause.png`

## Required Evidence Fields Per Step

- `step_id`: stable identifier like `S03`.
- `actions`: commands/actions executed.
- `screenshot`: relative PNG path.
- `expected`: expected observable behavior.
- `actual`: actual observed behavior.
- `severity`: `low`, `medium`, or `high`.
- `subsystem`: `renderer-webgpu`, `shell-desktop`, `core/runtime`, or `mcp/tooling`.

## Scenario Matrix

- `S01` Startup and idle render stability.
- `S02` Window resize extremes.
- `S03` Keyboard and pointer input parity.
- `S04` Pause, resume, and fixed-step stepping.
- `S05` Burst enqueue and draw-density stress profiles.
- `S06` Asset browsing and read bounds.
- `S07` Recovery behavior after stop/start lifecycle.
- `S08` Extended run drift spot-check.

## Latest Run Summary (2026-02-19)

- Command: `pnpm shell:desktop:gap-audit`
- Report: `docs/evidence/shell-demo-gap-audit/screens/capture-report.json`
- Screenshot count: `8`
- Visual result: all screenshots showed persistent black frame with WebGPU device-loss overlay (`writeBuffer` bytes-too-large error).
