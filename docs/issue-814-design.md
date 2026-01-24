---
title: "renderer-contract/webgpu: include camera state in RCB for replay correctness (Issue 814)"
sidebar_position: 99
---

# renderer-contract/webgpu: include camera state in RCB for replay correctness (Issue 814)

## Document Control
- **Title**: Include world camera state in `RenderCommandBuffer` to make RCB-only visual replay correct and self-contained
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-24
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/814
- **Execution Mode**: AI-led

## 1. Summary
`RenderCommandBuffer` (RCB) is intended to be a self-contained, replayable “how to draw this frame” payload. Today, camera state is held as external renderer instance state (`WebGpuRenderer.setWorldCamera(...)`) and is not included in the RCB, which makes RCB-only visual replays non-deterministic/incorrect whenever the camera changes. This design adds camera state to the renderer contract under `rcb.scene.camera`, updates the ViewModel→RCB compiler to copy camera state, updates `@idle-engine/renderer-webgpu` to render using the camera included in the RCB (including world-pass scissor calculations), and bumps the renderer contract schema version to reflect the breaking contract change.

## 2. Context & Problem Statement
- **Background**:
  - `@idle-engine/renderer-contract` defines `ViewModel` (includes `scene.camera`) and `RenderCommandBuffer` (currently: `frame`, `passes`, `draws`). See `packages/renderer-contract/src/types.ts`.
  - `@idle-engine/renderer-webgpu` uses camera state to transform world coordinates for world-pass draws and to compute scissor rectangles. Today that camera lives on the renderer instance (`#worldCamera`) and is mutated via `setWorldCamera(...)`. See `packages/renderer-webgpu/src/webgpu-renderer.ts`.
  - The engine’s replay design (Issue 778) relies on hashing ViewModels/RCBs to validate deterministic replay streams and enable “visual replay” without rerunning sim. See `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md`.
- **Problem**:
  - RCB-only playback has no authoritative record of the camera transform that was used when the frame was rendered.
  - As a result, world-pass geometry and scissor/clipping are interpreted using whatever camera state happens to be present (often the default `{ x: 0, y: 0, zoom: 1 }`), producing incorrect visuals during replay (wrong positions, zoom, and clip regions).
  - Because `hashRenderCommandBuffer(rcb)` only hashes the RCB payload, camera changes are currently invisible to hash comparisons, weakening determinism auditing for visual replays.
- **Forces**:
  - Keep the renderer contract “data-only”, serializable, and hashable (no implicit external state required to interpret the payload).
  - Preserve deterministic hashing requirements (reject NaN/Infinity, stable canonicalization).
  - Treat this as a contract-breaking change and make schema evolution explicit.

## 3. Goals & Non-Goals
- **Goals**:
  - Make RCB-only replay correct with respect to camera (world transforms and world scissor).
  - Ensure camera state is included in the hashed RCB payload so replay validation catches camera mismatches.
  - Keep the contract shape aligned with `ViewModel` where possible (use `scene.camera`).
  - Provide clear migration notes and a schema version bump to prevent silent mismatches.
- **Non-Goals**:
  - Redesign the render pass system (e.g., per-pass transform graphs) beyond what is required to carry a single world camera.
  - Solve pixel-identical rendering across different GPU/driver stacks (goal is deterministic inputs + correct camera interpretation).
  - Add interpolation/tweening semantics to the contract (if needed, they should be recorded explicitly or derived deterministically).

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Renderer contract maintainers (`packages/renderer-contract`)
  - WebGPU renderer maintainers (`packages/renderer-webgpu`)
  - Replay/diagnostics maintainers (`packages/core/src/replay/*`)
  - Host applications consuming RCB streams (e.g., `packages/shell-desktop`, tooling, inspectors)
- **Agent Roles**:
  - **Contract Agent**: Update `RenderCommandBuffer` types/schema version and publish migration notes.
  - **Compiler Agent**: Update `compileViewModelToRenderCommandBuffer(...)` to include camera state.
  - **Renderer Agent**: Update `WebGpuRenderer.render(rcb)` (and related helpers) to consume `rcb.scene.camera`.
  - **Debug/Validation Agent**: Update `@idle-engine/renderer-debug` validation and Canvas2D backend to respect `rcb.scene.camera` (optional but recommended for consistent replay tooling).
  - **Docs Agent**: Update READMEs and replay docs/examples to include the new required field.
- **Affected Packages/Services**:
  - `packages/renderer-contract/src/types.ts` (contract change + schema bump)
  - `packages/renderer-contract/src/render-compiler.ts` (copy camera into RCB)
  - `packages/renderer-webgpu/src/webgpu-renderer.ts` (consume camera from RCB; scissor math + globals)
  - `packages/renderer-debug/src/rcb-validation.ts` and `packages/renderer-debug/src/canvas2d-renderer.ts` (optional updates)
  - `packages/core/src/replay/*` (record/replay fixtures and any hard-coded RCBs)
  - Package docs/examples (e.g., `packages/renderer-webgpu/README.md`)
- **Compatibility Considerations**:
  - This is a breaking renderer-contract change: it requires bumping `RENDERER_CONTRACT_SCHEMA_VERSION` and updating all RCB producers/consumers in-tree.
  - Previously recorded RCB streams (e.g., replay files) will require migration or must be treated as incompatible and rejected by schema version checks.

## 5. Current State
- `ViewModel` includes `scene.camera`, but `compileViewModelToRenderCommandBuffer(...)` discards it and only emits `frame/passes/draws`. See `packages/renderer-contract/src/render-compiler.ts`.
- `@idle-engine/renderer-webgpu` stores camera on the renderer instance (`#worldCamera`) and uses it for:
  - world pass scissor conversion (`#toDeviceScissorRect(...)`), and
  - writing world globals uniform (`#writeGlobals(WORLD_GLOBALS_OFFSET, this.#worldCamera)`).
  See `packages/renderer-webgpu/src/webgpu-renderer.ts`.
- RCB hashing is used for replay validation (`hashRenderCommandBuffer(rcb)`), but since camera is not inside RCB, camera-dependent visual differences are not reflected in the RCB hash. See `packages/renderer-contract/src/hashing.ts` and `packages/core/src/replay/sim-replay.ts`.

## 6. Proposed Solution
### 6.1 Architecture Overview
- Treat camera state as per-frame render input, not renderer instance state.
- Embed world camera state in the RCB so any consumer (WebGPU renderer, debug renderers, tooling) can render the frame correctly without additional ambient state.

### 6.2 Detailed Design
- **Runtime Changes**:
  - Update RCB generation (`compileViewModelToRenderCommandBuffer`) to include `scene.camera` from the input `ViewModel`.
  - Update renderers to read camera from the RCB during `render(rcb)`:
    - World scissor conversion uses `rcb.scene.camera`.
    - World globals uniform uses `rcb.scene.camera`.
    - UI continues to use identity camera `{ x: 0, y: 0, zoom: 1 }`.
- **Data & Schemas**:
  - Update the renderer contract:
    - Add `scene: { camera: Camera2D }` to `RenderCommandBuffer`.
    - Bump `RENDERER_CONTRACT_SCHEMA_VERSION` (currently `3`) to the next version (expected: `4`).
  - Camera numeric constraints:
    - `camera.x`, `camera.y`, `camera.zoom` must be finite numbers (`hashing.normalizeNumbersForHash` already rejects NaN/Infinity).
    - `camera.zoom` should be positive (`> 0`) for meaningful transforms; enforce in compiler and/or renderers (exact enforcement location is an implementation detail; see Open Questions).
- **APIs & Contracts**:
  - Keep `WebGpuRenderer.setWorldCamera(camera)` for now, but mark it as deprecated in documentation/JSDoc.
    - New invariant: `render(rcb)` uses `rcb.scene.camera` and does not require `setWorldCamera(...)` for correctness.
    - Optional transitional behavior (if desired): `render(rcb)` may fall back to the instance camera when `rcb.scene` is missing, but only if we choose to support older schema versions in the renderer. Default expectation is strict schema matching.
- **Tooling & Automation**:
  - Update in-tree fixtures and docs that construct RCB objects manually to include `scene.camera`.
  - Update replay tooling/docs so recorded RCB frames are self-contained and RCB hashes reflect camera state.

### 6.3 Operational Considerations
- **Deployment**:
  - Land contract change + schema bump first, then update all dependents in-tree in the same PR to keep the workspace compiling.
  - Explicitly reject mismatched schema versions at entry points (already present in WebGPU renderer; extend as needed elsewhere).
- **Telemetry & Observability**:
  - No new telemetry required; schema mismatch errors should be descriptive so hosts can instrument them.
- **Security & Compliance**:
  - Improves replay safety by removing reliance on ambient renderer state for interpreting untrusted RCB streams.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(renderer-contract): add camera to RenderCommandBuffer` | Extend RCB type with `scene.camera` and bump `RENDERER_CONTRACT_SCHEMA_VERSION` | Contract Agent | Design approval | Types updated; schema version bumped; migration notes captured in doc/PR |
| `feat(renderer-contract): compile camera into RCB` | Update `compileViewModelToRenderCommandBuffer` to copy camera from ViewModel into RCB | Compiler Agent | Contract change | Unit tests updated/added to assert camera is present and stable for hashing |
| `refactor(renderer-webgpu): render using rcb.scene.camera` | Replace instance-state camera usage in world scissor and globals with `rcb.scene.camera` | Renderer Agent | Contract change | Existing scissor/camera tests updated; RCB-only render path correct without calling `setWorldCamera` |
| `chore(renderer-debug): respect RCB camera` | Update `renderRenderCommandBufferToCanvas2d` and validation to apply world camera for parity with WebGPU | Debug/Validation Agent | Contract change | Canvas2D output matches WebGPU camera interpretation for the same RCB; tests updated |
| `docs(renderer-webgpu/replay): update examples + migration notes` | Update README examples and replay docs to include `scene.camera` | Docs Agent | Contract + implementation | Examples compile; docs explain schema bump and required field |

### 7.2 Milestones
- **Phase 1**: Contract change + schema bump + compiler update (workspace compiles).
- **Phase 2**: WebGPU renderer update + tests (RCB-only replay correctness).
- **Phase 3**: Debug tooling parity + docs/migration updates.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Contract types: `packages/renderer-contract/src/types.ts`
  - Compiler: `packages/renderer-contract/src/render-compiler.ts`
  - WebGPU renderer: `packages/renderer-webgpu/src/webgpu-renderer.ts`
  - Existing scissor/camera tests: `packages/renderer-webgpu/src/webgpu-renderer.test.ts`
  - Replay hashing: `packages/renderer-contract/src/hashing.ts`, `packages/core/src/replay/sim-replay.ts`
  - Prior replay design: `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md`
- **Communication Cadence**: Single reviewer pass after implementation + tests, with a follow-up doc pass for migration notes if schema bump impacts existing replay artifacts.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Load Issue 814 body for acceptance criteria and file references.
  - Review how camera is used today in WebGPU scissor/global uniforms.
  - Identify any in-tree RCB fixtures/examples that will break when `scene.camera` becomes required.
- **Prompting & Constraints**:
  - Do not edit checked-in `dist/` outputs by hand.
  - Use type-only imports/exports (`import type { ... }`) per workspace lint rules.
  - Keep renderer-contract changes minimal and data-only; avoid adding runtime dependencies for validation.
- **Safety Rails**:
  - Prefer fail-fast behavior on schema mismatch; do not silently assume default camera during replay.
  - Ensure hashing behavior remains deterministic (no NaN/Infinity; stable key ordering).
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/renderer-contract`
  - `pnpm test --filter @idle-engine/renderer-webgpu`
  - `pnpm test --filter @idle-engine/renderer-debug`
  - `pnpm test --filter @idle-engine/core` (visual replay tests)

## 9. Alternatives Considered
1. **Keep camera external (require `setWorldCamera` during replay)**: Rejected; violates the “RCB is self-contained” goal and makes RCB-only replay correctness dependent on caller behavior.
2. **Store camera in `FrameHeader`**: Simpler shape but semantically mixes “frame identity” and “render state”; also less aligned with `ViewModel.scene`.
3. **Attach camera per pass (`RenderPass` carries transform)**: More extensible (multiple cameras/passes), but heavier change than needed for Issue 814 and requires larger refactors across compilers/renderers.
4. **Record camera as a draw command (e.g., `kind: 'setCamera'`)**: Keeps `RenderCommandBuffer` flat but complicates ordering rules and makes camera an implicit state machine again; rejected in favor of explicit `scene` metadata.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Update renderer-contract compiler tests to assert `compileViewModelToRenderCommandBuffer(viewModel).scene.camera` equals the input camera.
  - Add/adjust hashing tests to confirm that RCB hashes differ when camera differs (even if draws are identical).
  - Update WebGPU renderer tests to remove reliance on `renderer.setWorldCamera(...)` and instead supply camera via the RCB; ensure scissor conversion matches expected device pixels.
  - Update any replay fixtures/tests that construct RCBs (in `packages/core/src/replay/*.test.ts`) to include `scene.camera`.
- **Performance**:
  - Camera adds a tiny constant payload per frame (3 numbers); no measurable perf impact expected.
- **Tooling / A11y**:
  - Manual sanity check in a host (Electron/web) by capturing an RCB stream with camera movement and replaying it without any external camera calls.

## 11. Risks & Mitigations
- **Breaking change ripple**: Many fixtures/examples create RCB objects manually and will fail to compile until updated.
  - *Mitigation*: Land schema bump + in-tree updates in one PR; include a checklist of touched packages.
- **Camera float nondeterminism**: If camera is computed using non-deterministic timing (vsync interpolation), hashes may differ between runs.
  - *Mitigation*: Define where camera comes from for “deterministic replay” mode (derive from sim time or record camera explicitly and treat it as non-authoritative).
- **Partial adoption**: Some renderers/tooling might ignore camera and remain incorrect.
  - *Mitigation*: Update `@idle-engine/renderer-debug` as part of the rollout or explicitly document its limitations.

## 12. Rollout Plan
- **Milestones**:
  1. Bump schema version and update contract/compiler (RCB includes camera).
  2. Update WebGPU renderer to consume camera from RCB and update tests.
  3. Update docs/examples and (optionally) debug tooling parity.
- **Migration Strategy**:
  - Treat pre-bump RCB streams as incompatible and reject them via schema checks.
  - If legacy replay support is required, add an explicit migration step that injects a default camera or reconstructs camera from recorded host input (out of scope for this issue; see Open Questions).
- **Communication**:
  - Include migration notes in PR description:
    - `RenderCommandBuffer` now requires `scene.camera`.
    - `RENDERER_CONTRACT_SCHEMA_VERSION` bumped; old replays must be regenerated or migrated.

## 13. Open Questions
1. Should `camera.zoom` be validated as `> 0` at the contract boundary (compiler/renderer), or left to downstream renderers to interpret?
2. Should `WebGpuRenderer.setWorldCamera(...)` be removed (breaking API), formally deprecated, or retained as an override for ad-hoc/manual rendering?
3. Do we want per-pass camera transforms soon (making `RenderPass` carry a transform), or is a single `rcb.scene.camera` sufficient for the foreseeable roadmap?
4. Do replay file formats need an explicit “RCB schema version” field separate from `FrameHeader.schemaVersion`, or is the existing schema version sufficient?

## 14. Follow-Up Work
- Expand “RCB is self-contained” to other renderer state currently implicit (e.g., viewport assumptions, devicePixelRatio semantics), if replay correctness requires it.
- Consider a small migration utility for replay files when contract schema versions change.
- Consider adding optional quantization rules for camera (fixed-point) if camera hashing proves too sensitive for deterministic validation workflows.

## 15. References
- Issue 814: https://github.com/hansjm10/Idle-Game-Engine/issues/814
- Renderer contract types: `packages/renderer-contract/src/types.ts`
- ViewModel→RCB compiler: `packages/renderer-contract/src/render-compiler.ts`
- WebGPU renderer implementation: `packages/renderer-webgpu/src/webgpu-renderer.ts`
- WebGPU renderer tests (camera/scissor): `packages/renderer-webgpu/src/webgpu-renderer.test.ts`
- Replay hashing: `packages/renderer-contract/src/hashing.ts`
- Replay validation logic: `packages/core/src/replay/sim-replay.ts`
- Prior replay design doc (Issue 778): `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md`

## Appendix A — Glossary
- **RCB (RenderCommandBuffer)**: A per-frame, data-only rendering payload describing passes and ordered draws for a renderer backend.
- **ViewModel**: A higher-level per-frame description (scene + UI) that is compiled into an RCB.
- **Camera2D**: The world camera transform `{ x, y, zoom }` used to map world coordinates into device/pixel space.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-24 | Codex (AI) | Initial draft for Issue 814 |

