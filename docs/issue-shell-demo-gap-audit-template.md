# Shell Demo Gap Audit Findings

Use this template to convert audit findings into GitHub issues.

## Run Metadata

- Date: 2026-02-19
- Commit: `d72362b8`
- Runner: Codex MCP audit script (`pnpm shell:desktop:gap-audit`)
- Environment: headless shell-desktop via gateway endpoint `http://127.0.0.1:8570/mcp/sse`
- Notes: screenshots were generated from a forced sim reset and manually reviewed with `view_image`.

## Findings

| id | title | subsystem | severity | reproduction_steps | expected | actual | evidence_screenshot | candidate_issue_title |
|---|---|---|---|---|---|---|---|---|
| G01 | Baseline frame immediately triggers WebGPU device-loss on writeBuffer | renderer-webgpu | high | 1. Start shell backend with `pnpm shell:desktop:headless:gateway-backend` 2. Run `pnpm shell:desktop:gap-audit` 3. Inspect step `S01` screenshot | baseline world + UI panel should render with active profile text | screen is fully black and overlay shows `WebGPU lost ... Number of bytes to write is too large` | `docs/evidence/shell-demo-gap-audit/screens/010-baseline-startup-1280x720.png` | `fix(renderer-webgpu): prevent writeBuffer overflow causing immediate device loss in shell-desktop` |
| G02 | Recovery path never restores rendering after initial WebGPU loss | shell-desktop, renderer-webgpu | high | 1. Reproduce G01 2. Continue audit through steps `S04`..`S08` 3. Compare screenshots across profile changes and lifecycle restart | device-loss recovery should reinitialize renderer and resume frame output | every screenshot remains black with persistent `Attempting recovery...`; no visible scene returns after pause/step, profile changes, or stop/start | `docs/evidence/shell-demo-gap-audit/screens/040-pause-step-clip-stack.png` | `fix(shell-desktop): make WebGPU recovery converge after device-loss instead of permanent black frame` |
| G03 | Renderer failure lacks actionable diagnostics for triage | shell-desktop | medium | 1. Reproduce G01 2. Review overlay text and MCP status report (`capture-report.json`) | failure diagnostics should include profile, draw/glyph counts, and attempted buffer sizes for issue triage | only generic exception text is surfaced; MCP report confirms sim progress but does not expose renderer metrics/root-cause context | `docs/evidence/shell-demo-gap-audit/screens/080-long-run-drift-spot-check.png` | `feat(shell-desktop): emit structured renderer failure diagnostics (profile/draw-count/buffer-bytes)` |

## Issue Draft Block

Copy this block per finding.

### Summary


### Reproduction

1. 
2. 
3. 

### Expected


### Actual


### Evidence

- Screenshot: 
- Step id: 
- Commands used: 

### Scope

- Impacted component:
- Potential owner:

### Acceptance Criteria

- [ ]
- [ ]
