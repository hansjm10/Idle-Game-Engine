---
title: Desktop Shell + WebGPU Renderer + Replay (Issue 778)
sidebar_position: 6
---

# Desktop Shell (Electron) + WebGPU Renderer (GPU UI) + Deterministic Replay (Issue 778)

## Document Control
- **Title**: Introduce a first-party Electron desktop shell, WebGPU renderer, and deterministic visual replay
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10 (Runtime Core), TODO (Rendering), TODO (Tools/Release)
- **Status**: Draft
- **Last Updated**: 2026-01-16
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/778
- **Execution Mode**: AI-led

## 1. Summary
This proposal adds a first-party desktop host (“shell”) and a first-party 2D renderer to the Idle Engine monorepo while preserving the existing deterministic, platform-agnostic simulation core (`packages/core`). The shell is Electron-based and is responsible for time, input, persistence, and asset IO. Rendering is performed via a custom WebGPU backend (plus an optional debug backend) that consumes data-only frame descriptions. A deterministic record/replay system ties everything together by enabling authoritative sim replays (commands + initial state + RNG) and optional “visual replays” (ViewModel and/or RenderCommandBuffer per frame) to support debugging, regression testing, and inspection tooling.

## 2. Context & Problem Statement
- **Background**:
  - The repository currently prioritizes a deterministic, headless runtime (`packages/core`) that can be hosted by downstream applications; there is no first-party GPU presentation layer (`docs/idle-engine-design.md`).
  - The core already includes deterministic primitives relevant to replay and host integration:
    - Fixed-step runtime loop (`packages/core/src/internals.browser.ts`).
    - Deterministic command queue semantics (`docs/runtime-command-queue-design.md`).
    - A command recorder/replayer utility (`packages/core/src/command-recorder.ts`).
    - Efficient publish transports for typed-array state export (`packages/core/src/resource-publish-transport.ts`).
    - A controls contract intended for shell integrations (`packages/controls/src/index.ts`).
- **Problem**:
  - There is no canonical desktop host that demonstrates end-to-end “engine + shell + renderer” integration, so each downstream app must rebuild time scheduling, persistence, input mapping, and debugging tools independently.
  - There is no renderer contract or renderer implementation that can support sprite-heavy 2D scenes and GPU-rendered UI/HUD without DOM/CSS.
  - Visual debugging is currently limited: while the sim is deterministic and replayable, there is no standardized mechanism to record the derived presentation layer (ViewModel / draw list) and replay it for diagnosing visual regressions.
- **Forces**:
  - Desktop target (Windows/macOS/Linux) with stable GPU behavior and predictable packaging.
  - Maintain determinism: authoritative sim output must be reproducible; visual layers must be deterministically derived from sim state (or fully captured).
  - Correctness/control/maintainability over rapid shipping: prefer explicit contracts, stable types, and testable pure transforms.
  - Avoid DOM/CSS dependency for UI; all in-game UI/HUD is GPU-rendered.

## 3. Goals & Non-Goals
- **Goals**:
  1. Add a first-party desktop shell package that can load a content pack, run the sim deterministically, and present a GPU-rendered game + HUD.
  2. Define a stable “core ↔ shell ↔ renderer” contract based on data-only frame descriptions (ViewModel and/or RenderCommandBuffer).
  3. Implement a WebGPU 2D renderer capable of:
     - sprite rendering (batched quads + atlases),
     - basic 2D scene features (camera, layers, culling),
     - GPU UI primitives (rects, images, clipping),
     - text rendering (bitmap or MSDF pipeline).
  4. Add deterministic record/replay that can reproduce:
     - authoritative sim evolution (initial state + command stream + RNG),
     - optional per-frame ViewModel and/or RenderCommandBuffer (for visual debugging).
  5. Provide a debug renderer option (Canvas2D or minimal WebGPU) to validate contracts and diagnostics early.
- **Non-Goals** (initially):
  - 3D rendering.
  - DOM/CSS-based UI.
  - Multiplayer/network synchronization (the design should not block it; it is not delivered here).
  - Pixel-perfect identical output across different GPUs/driver stacks (goal is deterministic *inputs and command buffers*, not necessarily identical rasterization).
- **Acceptance Criteria (initial implementation phase)**:
  - Desktop shell runs the sim with fixed-step updates and renders frames via a renderer interface.
  - Renderer draws sprites + a minimal GPU UI (text + panels) without DOM/CSS.
  - Replay reproduces sim state and produces identical RenderCommandBuffer hashes for a given replay on the same build/content.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Runtime Core maintainers (determinism, contracts, replay invariants).
  - Shell/UX maintainers (desktop app behavior, input, persistence).
  - Rendering maintainers (WebGPU backend, debug backend, performance).
  - Tooling maintainers (replay files, inspectors, CI harnesses).
- **Agent Roles**:

| Agent | Responsibilities |
|-------|------------------|
| Desktop Shell Agent | Electron scaffolding, app lifecycle, persistence, content + asset IO, wiring sim ↔ renderer. |
| Renderer Contract Agent | Define ViewModel / RenderCommandBuffer types and deterministic compilation rules. |
| WebGPU Renderer Agent | WebGPU device setup, pipelines, batching, atlases, text, perf instrumentation. |
| Debug Renderer Agent | Canvas2D/minimal backend for early contract validation and test harnesses. |
| Replay & Tooling Agent | Replay container format, record/replay runner, hashing/diffing, UI/CLI hooks. |
| CI/Build Agent | Workspace wiring, packaging scripts, platform CI notes, lint/test configuration. |
| Docs Agent | Keep this doc and follow-up subsystem docs aligned with implementation. |

- **Affected Packages/Services**:
  - Existing: `packages/core`, `packages/controls`, `packages/content-schema`, `packages/docs`, `docs/`, `tools/runtime-sim`.
  - New (proposed): `packages/shell-desktop`, `packages/renderer-webgpu`, `packages/renderer-debug`, plus a small “boundary” module for shared rendering types (see §6.2).
- **Compatibility Considerations**:
  - Keep `packages/core` deterministic and platform-agnostic; avoid coupling core to Electron/WebGPU runtime specifics.
  - Version all replay formats; fail fast on mismatched engine version, content hash, or asset manifest hash.
  - Ensure the renderer contract supports evolution (schema versioning, optional fields) without breaking existing replay files.

## 5. Current State
- **Headless runtime exists**: `IdleEngineRuntime` implements a deterministic fixed-step loop with an accumulator (`packages/core/src/internals.browser.ts`) and deterministic command step stamping (`docs/runtime-command-queue-design.md`).
- **Replay primitives exist**: `CommandRecorder` can record commands + start state + runtime event frames and replay them (`packages/core/src/command-recorder.ts`), but there is no standardized file/container format and no visual replay.
- **Shell integration examples exist (non-graphical)**:
  - `packages/fantasy-guild-tui` demonstrates a Node-based host that loads content, runs `createGame`, and polls snapshots to render a terminal UI.
  - `tools/runtime-sim` provides headless simulation/benchmark tooling.
- **Rendering contract does not exist**: there is no ViewModel / RenderCommandBuffer schema, no renderer implementation, and no asset pipeline for 2D scenes/UI in this repo.

## 6. Proposed Solution

### 6.1 Architecture Overview
- **Narrative**:
  - The deterministic sim stays in `packages/core` and produces authoritative state.
  - A shell hosts the sim, collects input, loads content packs, performs IO, and derives presentation data.
  - A renderer consumes a data-only frame description and performs GPU rendering (no sim access, no IO).
  - Replay is treated as a first-class workflow: record authoritative inputs and deterministic derived outputs, then replay them for debugging.
- **Diagram** (desktop, recommended “isolated sim” default):

```text
Electron Main Process
  - app lifecycle
  - filesystem IO (saves, content packs)
  - native dialogs, window mgmt
        |
        | IPC (typed messages; no arbitrary eval)
        v
Electron Renderer Process (Chromium)
  - input capture
  - renderer-webgpu (GPU)
  - HUD/UI system (GPU-rendered)
  - replay UI (dev mode)
        |
        | postMessage (structured clone / typed arrays)
        v
Sim Worker (Web Worker or WorkerThread)
  - @idle-engine/core deterministic runtime
  - command queue + systems
  - (pure) selectViewModel(...)
  - emits frames + events
```

### 6.2 Detailed Design

#### 6.2.1 Package Layout
Proposed packages (additive to the workspace):
- `packages/shell-desktop` (`@idle-engine/shell-desktop`): Electron desktop shell.
- `packages/renderer-webgpu` (`@idle-engine/renderer-webgpu`): WebGPU backend implementation.
- `packages/renderer-debug` (`@idle-engine/renderer-debug`, optional): Canvas2D/minimal backend.
- `packages/renderer-contract` (`@idle-engine/renderer-contract`): shared, runtime-agnostic types for ViewModel and RenderCommandBuffer.
  - Rationale: keep the renderer contract stable and avoid depending on either `@idle-engine/core` or WebGPU at runtime.
  - This package should be types-first and pure-data only (no IO, no DOM, no WebGPU).

#### 6.2.2 Core ↔ Shell ↔ Renderer Boundaries
**Core responsibilities (unchanged constraints)**:
- Deterministic state transitions: `state' = reduce(state, step, commands)`.
- Deterministic time: simulation time derived from `(step * stepSizeMs)`, not wall clock.
- Emit runtime events as data (`EventBus`) for side effects, diagnostics, and tooling.
- Provide stable, pure selectors for “presentation derivation” *when feasible*.
  - For engine-generic HUD (resources, generators, upgrades), selectors can live in core.
  - For game-specific scene composition, selectors can live in a game module within the shell until content schemas mature.

**Shell responsibilities**:
- Time source and fixed-step scheduling (`IdleEngineRuntime.tick(deltaMs)`), including background throttling behavior and max-step budgets.
- Input capture → `@idle-engine/controls` mapping → runtime commands (player priority).
- Persistence (settings/saves), filesystem IO, content pack discovery/loading, and dev-mode hot reload.
- Asset management: load/validate assets and provide stable asset IDs + hashes to the renderer.
- Record/replay orchestration:
  - record: capture authoritative sim inputs + optional derived outputs,
  - replay: drive sim and/or renderer from recorded streams.

**Renderer responsibilities**:
- Consume ViewModel or RenderCommandBuffer and render it.
- Own GPU resources (textures, atlases, pipelines, buffers, glyph caches).
- Provide debug overlays (bounds, overdraw, missing assets) without altering sim state.
- Avoid IO and avoid any direct access to sim state (only data-only frame inputs).

#### 6.2.3 Frame Description: Two-Layer Model
Adopt a two-layer approach, matching Issue 778:
1. **ViewModel**: semantic “what should be shown” (UI widgets, sprites, meters, labels).
2. **RenderCommandBuffer (RCB)**: explicit “how to draw” (pass, pipeline/material, quads, scissor, text runs).

Key requirements:
- The compilation step `ViewModel → RenderCommandBuffer` is deterministic:
  - stable ordering rules,
  - explicit sort keys,
  - no iteration-order hazards (avoid `Map`/object key dependence unless explicitly canonicalized).
- Both ViewModel and RCB are versioned for evolution and replay compatibility.

#### 6.2.4 Coordinate Systems & Timing
Define explicit coordinate spaces up front to prevent later churn:
- **Simulation time**: `simTimeMs = step * stepSizeMs` (authoritative).
- **World space**: float world units (camera-controlled). Prefer stable rounding rules at the compile boundary (e.g., quantize to 1/256th units) if cross-platform drift becomes an issue.
- **UI space**: logical pixels with integer coordinates; apply devicePixelRatio scaling at renderer boundary.
- **Render frame cadence**:
  - Sim runs at fixed step (e.g., 60 Hz or 10 Hz depending on game).
  - Renderer renders at vsync; optionally interpolates between steps for smoother camera motion, but interpolation inputs must derive from deterministic sim time (or be recorded).

#### 6.2.5 Renderer Contract (High-Level Shape)
The contract package defines (at minimum):
- `AssetId` and `AssetManifest` (fonts, images, sprite sheets, shaders) with content hashes.
- `ViewModel`:
  - `frame`: `{ tick, simTimeMs, contentHash, schemaVersion }`
  - `scene`: camera + sprite instances + optional tilemap/particle descriptors
  - `ui`: a small set of GPU-friendly primitives (rect, image, text, meter/progress bar), plus layout metadata
- `RenderCommandBuffer`:
  - `passes[]`: e.g., `world`, `ui`
  - `draws[]` (or pass-scoped draws): each draw has a stable `sortKey` and references materials/geometry
  - optional `debug` channels (bounds, missing assets, perf markers)

Design guardrail: the renderer contract must remain “data only”, serializable, and amenable to hashing/diffing for replay validation.

#### 6.2.6 WebGPU Renderer (Capabilities Roadmap)
The WebGPU backend is split into milestones (initially minimal, growing over time):
1. **Scaffold**: device init + swapchain + clear screen; integrate with shell window resize.
2. **Sprites**: texture loading, atlas, instanced quad batching, camera transforms, alpha blending.
3. **GPU UI primitives**: rects, images, 9-slice (optional), scissor/clipping, transforms.
4. **Text**: bitmap or MSDF glyph atlas + deterministic layout strategy (see Open Questions).
5. **Scene features**: tilemaps, particles, animation tracks, culling.
6. **Tooling**: perf HUD, frame capture, replay stepping UI, debug overlays.

#### 6.2.7 Deterministic Record/Replay (Sim + Visual)
Provide two complementary replay products:

**A) Sim Replay (authoritative)**
- Purpose: reproduce state evolution for debugging/verification; foundation for offline tooling.
- Inputs: content identity + initial state snapshot + command stream + RNG seed/state.
- Recommended baseline implementation: build on `CommandRecorder` (`packages/core/src/command-recorder.ts`) and state snapshot tooling (`docs/state-synchronization-protocol-design.md`).

**B) Visual Replay (debugging)**
- Purpose: reproduce and inspect visuals without rerunning sim; validate ViewModel/RCB determinism.
- Recorded data (configurable):
  - per-step ViewModel (post-tick),
  - and/or per-render-frame RenderCommandBuffer (post-compile).
- Validation: during a “combined replay”, run sim replay and compare computed ViewModel/RCB hashes against recorded frames. Mismatches fail fast and include a diffable summary.

**Replay container format (high-level)**
- Use a versioned container with explicit headers, designed for large frame streams:
  - `header`: engine version, platform, schema versions, stepSizeMs, capture metadata.
  - `content`: content pack ID/version + content hash; fail on mismatch.
  - `assets`: asset manifest hash + per-asset digests; fail on mismatch unless explicitly allowed.
  - `sim`: command log (and optionally runtime event frames).
  - `frames`: chunked ViewModel/RCB frames; include per-frame hashes for quick validation.

#### 6.2.8 Asset Determinism & Atlas Packing
To keep visual replays stable:
- Asset IDs are stable and come from manifests (not file paths).
- Atlas packing must be deterministic:
  - stable input ordering (sort by asset ID),
  - deterministic packing algorithm and tie-breaking,
  - record the atlas layout hash in replay headers and optionally record the layout itself.
- Fail-fast behavior:
  - mismatched content hash → abort replay (authoritative sim mismatch),
  - mismatched asset manifest hash → abort visual replay (render mapping mismatch), unless replay is “logic-only”.

### 6.3 Operational Considerations
- **Deployment**:
  - The desktop shell ships as a separate package/app; CI should build artifacts per platform.
  - Prefer a reproducible build pipeline; avoid “download at runtime” for critical assets (fonts/sprite sheets).
- **Telemetry & Observability**:
  - Leverage existing runtime diagnostics timeline (`packages/core/src/diagnostics/*`) and expose a dev overlay in the shell.
  - Add renderer metrics: frame time, GPU submission time, batch counts, atlas pressure, glyph cache churn.
  - Ensure replay validation errors provide structured JSON summaries suitable for CI parsing (mirroring existing deterministic test/reporting practices).
- **Security & Compliance** (Electron):
  - Follow Electron security guidance (context isolation, disable Node integration in renderer, narrow preload API surface).
  - Treat replay and content pack files as untrusted input: validate schema versions, lengths, and hashes before ingestion.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `docs: desktop shell + WebGPU renderer + replay (Issue 778)` | This document + follow-up links | Docs Agent | None | Doc merged and referenced from Issue 778 |
| `chore(shell-desktop): Electron scaffolding` | Main/preload/renderer scaffolding, window lifecycle | Desktop Shell Agent | Doc approved | App opens window, clean shutdown, basic IPC wiring |
| `feat(renderer-contract): define ViewModel + RCB types` | Add data-only contract package with versioning | Renderer Contract Agent | Doc approved | Types published in workspace; basic validation + hashing helpers |
| `feat(renderer-debug): minimal backend` | Canvas2D/minimal WebGPU backend consuming RCB | Debug Renderer Agent | render-contract | Can render a handful of primitives; supports replay stepping |
| `feat(renderer-webgpu): device init + clear` | WebGPU init + resize + present loop | WebGPU Renderer Agent | render-contract | Renders stable clear color; handles device loss gracefully |
| `feat(renderer-webgpu): sprites + batching` | Quad batching + texture/atlas loader | WebGPU Renderer Agent | device init | Draw N sprites deterministically with stable sort |
| `feat(renderer-webgpu): GPU UI primitives` | Rect/image primitives + clipping | WebGPU Renderer Agent | sprites | HUD panels render without DOM |
| `feat(renderer-webgpu): text pipeline` | Bitmap/MSDF text rendering + deterministic layout | WebGPU Renderer Agent | UI primitives | Text renders deterministically for packaged fonts |
| `feat(shell-desktop): sim worker + frame pump` | Run core in Worker, emit ViewModel/RCB to renderer | Desktop Shell Agent | Electron scaffolding + contract | Sim ticks deterministically; renderer receives frames |
| `feat(replay): sim replay container + runner` | Write/read sim replay files; CLI or in-app UI | Replay & Tooling Agent | render-contract + shell | Record & replay sim commands; validate final state |
| `feat(replay): visual replay (ViewModel/RCB)` | Record per-frame ViewModel/RCB; hash validation | Replay & Tooling Agent | replay container + renderer | Replay reproduces identical frame hashes on same build/content |
| `test(render-compiler): deterministic RCB generation` | Golden tests for compilation determinism | Renderer Contract Agent | contract | `pnpm test` passes; deterministic ordering validated |

### 7.2 Milestones
- **Phase 1 — Foundations**:
  - Electron shell scaffolding + renderer contract + minimal debug renderer + WebGPU “clear screen”.
  - Establish replay container header conventions and basic sim recording integration.
- **Phase 2 — 2D Rendering + GPU UI**:
  - Sprites, atlases, UI primitives, and an initial text strategy.
  - Deterministic compile rules + golden tests for RCB generation.
- **Phase 3 — Replay Tooling**:
  - Combined replay runner (sim + visual) with hash validation and step-through UI.
  - Perf HUD and capture/export workflows for debugging.

### 7.3 Coordination Notes
- **Hand-off Package** (minimum context for implementation agents):
  - `docs/runtime-command-queue-design.md` (step stamping + determinism contract)
  - `packages/core/src/internals.browser.ts` (tick loop and step lifecycle)
  - `packages/core/src/command-recorder.ts` (existing command replay utility)
  - `packages/core/src/resource-publish-transport.ts` (typed-array transport patterns)
  - `packages/controls/src/index.ts` (input → command mapping contract)
- **Communication Cadence**:
  - Phase boundary reviews (contract + scaffolding, then rendering primitives, then replay tooling).
  - Keep follow-up issues small and sliceable (one contract change per PR where possible).

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Always load: `docs/design-document-template.md`, `docs/idle-engine-design.md`, Issue 778.
  - For determinism: `docs/runtime-command-queue-design.md`, `docs/runtime-step-lifecycle.md`, `docs/state-synchronization-protocol-design.md`.
  - For replay: `packages/core/src/command-recorder.ts`.
- **Prompting & Constraints**:
  - Keep the sim deterministic: no wall-clock time or unseeded randomness in selectors/compilers.
  - Keep renderer contract data-only and versioned; avoid leaking core internals into renderer.
  - Prefer pure functions for compilation and hashing so tests can run in Node without GPU.
- **Safety Rails**:
  - Do not edit checked-in `dist/` outputs by hand.
  - Do not introduce console noise that could corrupt JSON-based test reporters.
  - Treat replay/content/asset files as untrusted input: validate before use.
- **Validation Hooks**:
  - `pnpm lint`
  - `pnpm test` (and package-filtered tests during iteration)
  - If tests affect coverage, regenerate via `pnpm coverage:md` (do not edit `docs/coverage/index.md` manually).

## 9. Alternatives Considered
- **Use DOM/CSS for UI**: rejected due to explicit constraint; also undermines deterministic UI/layout when relying on browser font metrics and CSS.
- **Use an off-the-shelf renderer (PixiJS/WebGL/Unity/Godot)**: rejected for long-horizon control, determinism, and deep integration needs (replay + debug overlays + contract stability).
- **Tauri instead of Electron**: viable long-term, but Electron is chosen initially for ecosystem maturity and faster iteration on WebGPU/WebView behavior; revisit once contracts stabilize.
- **Run sim in Electron main process**: viable, but sim-in-worker (renderer process) aligns with existing browser-safe runtime entrypoints and keeps a strict UI/IO boundary; evaluate per performance/profiling.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Contract-level tests: canonicalization, hashing, deterministic ordering of ViewModel/RCB structures.
  - Replay tests: sim replay produces identical end-state checksums; combined replay validates ViewModel/RCB frame hashes.
  - Shell tests (where feasible): IPC message validation, file format validation.
- **Performance**:
  - Add micro-benchmarks for compile step (ViewModel → RCB) and sprite batching.
  - Track renderer frame time budgets and regression thresholds (CI-reported, not necessarily gating initially).
- **Tooling / A11y**:
  - GPU UI must include focus navigation and readable text scaling strategies (tracked as a follow-up workstream if not immediately delivered).

## 11. Risks & Mitigations
| Risk | Impact | Mitigation |
|------|--------|------------|
| WebGPU platform/driver variance | Rendering differences or device loss | Implement robust device-loss handling; keep debug renderer; gate advanced features behind capability checks |
| Text determinism (fonts/layout) | Replay mismatches across machines | Use packaged fonts + deterministic metrics; start with bitmap/MSDF and constrain shaping; record layout decisions in replay if needed |
| Renderer contract churn | Downstream work blocked by breaking changes | Version contracts; keep changes additive; add “contract conformance” tests and replay golden sets |
| Large replay files | Slow IO, poor UX | Chunk frames; optional recording modes; compression as follow-up |
| Asset pipeline complexity | Non-determinism, long iteration times | Stable asset manifests + hashes; deterministic atlas packing; start simple and iterate |
| Electron security pitfalls | RCE risk | Follow security checklist; minimal preload API; no remote content by default |

## 12. Rollout Plan
- **Milestones**:
  - Introduce packages behind dev-only entrypoints first.
  - Promote to “first-party shell” once replay + renderer contract are stable and smoke-tested on all three OSes.
- **Migration Strategy**:
  - Additive: no required changes for existing core consumers.
  - Replay formats are versioned; older replays remain loadable via adapters or explicit “unsupported version” errors.
- **Communication**:
  - Track progress in Issue 778 with links to the issue map entries and the latest replay/renderer contract versions.

## 13. Open Questions
1. **Text strategy**: bitmap fonts vs MSDF; shaping scope (ASCII only vs full shaping via HarfBuzz/WASM).
2. **UI layout engine**: custom layout vs flexbox-like solver (Yoga) vs immediate-mode UI.
3. **Coordinate and unit conventions**: world-units vs pixel-units; camera scaling rules; integer quantization boundaries.
4. **Where ViewModel is authored**: in `packages/core` selectors vs a game module in the shell vs content-driven scene graph.
5. **Renderer fallback policy**: is a WebGL fallback required, or is debug renderer sufficient?
6. **Replay container format details**: JSON vs binary, compression, streaming, stable hashing algorithm choice.

## 14. Follow-Up Work
- Add a dedicated “Shell & Rendering” documentation section (including how downstream apps can reuse the renderer contract without Electron).
- Extend content schemas to optionally declare asset manifests and scene composition metadata (if/when game requirements demand it).
- Add a “replay inspector” tool (CLI + in-app) with diff views, frame scrubber, and export-to-bug-report workflow.

## 15. References
- https://github.com/hansjm10/Idle-Game-Engine/issues/778
- `docs/design-document-template.md`
- `docs/idle-engine-design.md`
- `docs/runtime-command-queue-design.md`
- `docs/runtime-step-lifecycle.md`
- `docs/state-synchronization-protocol-design.md`
- `packages/core/src/internals.browser.ts`
- `packages/core/src/command-recorder.ts`
- `packages/core/src/resource-publish-transport.ts`
- `packages/controls/src/index.ts`
- WebGPU spec: https://www.w3.org/TR/webgpu/
- WGSL spec: https://www.w3.org/TR/WGSL/
- Electron security guide: https://www.electronjs.org/docs/latest/tutorial/security

## Appendix A — Glossary
- **Shell**: The host application that owns IO, input, scheduling, and integrates sim + renderer.
- **ViewModel**: Semantic, renderer-agnostic data describing what should appear in the scene/UI.
- **RenderCommandBuffer (RCB)**: Renderer-ready draw list and associated metadata with deterministic ordering.
- **Sim Replay**: Authoritative replay based on initial state + command stream + RNG.
- **Visual Replay**: Replay of ViewModel and/or RCB frames for visual debugging without rerunning sim.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-16 | Codex (AI) | Initial draft for Issue 778 |
