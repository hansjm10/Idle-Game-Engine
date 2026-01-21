---
title: "renderer-webgpu: Reduce Per-Frame Allocations in Quad/Text Batching (Issue 809)"
sidebar_position: 99
---

# renderer-webgpu: Reduce Per-Frame Allocations in Quad/Text Batching (Issue 809)

## Document Control
- **Title**: Reduce per-frame allocations in WebGPU quad/text batching
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-21
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/809
- **Execution Mode**: AI-led

## 1. Summary
The WebGPU renderer currently accumulates quad instance data in a `number[]` and allocates a new `Float32Array` on every batch flush, while text rendering pushes per-glyph instance data into the same hot array path. At higher draw/text volumes this produces avoidable GC pressure and frame-time spikes. This design replaces the hot-path `number[]` with a reusable, growable `Float32Array` instance builder (cursor-based writer) that is reused across flushes and frames, and updates the upload path to write only the used byte range without allocating new buffers in steady state.

## 2. Context & Problem Statement
- **Background**: `@idle-engine/renderer-webgpu` renders `rect`, `image`, and `text` draws as instanced quads (`INSTANCE_STRIDE_BYTES = 48`, i.e. 12 floats per instance) using a single GPU instance buffer updated via `device.queue.writeBuffer(...)`. Draws are sorted by pass and `sortKey` (`orderDrawsByPassAndSortKey`) and then streamed through a quad batching loop that flushes when the pipeline kind changes (rect vs image), the pass changes (world vs ui), or scissor state changes.
- **Problem**: The quad batching loop builds up `WebGpuQuadRenderState.batchInstances: number[]` and, on each flush, converts it into `new Float32Array(state.batchInstances)` before uploading. Additionally, `#resetQuadBatch` discards the existing array by assigning a new `[]`. For text draws, `appendBitmapTextInstances(...)` pushes 12 numbers per glyph into the same array. These repeated allocations and high-frequency `push(...)` calls can create significant GC pressure and degrade performance.
- **Forces**:
  - Preserve the renderer contract: `RenderCommandBuffer` inputs and rendering outputs must remain behaviorally identical.
  - Keep batching semantics correct across pipeline/pass/scissor boundaries.
  - Ensure the solution works in both browser WebGPU and the test harness (stub WebGPU environment used by `webgpu-renderer.test.ts`).

## 3. Goals & Non-Goals
- **Goals**:
  - Eliminate per-flush allocations in steady state (after buffers grow to the required capacity).
  - Avoid `number[]` usage on the hot path for quad and text instance accumulation.
  - Maintain the existing instance layout (pos/size, uv rect, color = 12 floats) and draw call behavior.
  - Add a unit test or micro-benchmark that asserts buffer reuse behavior across multiple renders/flushes.
- **Non-Goals**:
  - Redesigning draw ordering/grouping (`orderDrawsByPassAndSortKey`) or changing batching boundaries.
  - Implementing advanced text shaping/kerning or changing bitmap font layout rules.
  - Eliminating all allocations in `render(...)` (e.g., `#writeGlobals` currently allocates small temporary typed arrays); these may be follow-up optimizations.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Renderer maintainers (`packages/renderer-webgpu`).
  - Desktop shell maintainers relying on stable frame-time (`packages/shell-desktop`), indirectly.
- **Agent Roles**:
  - **Docs Agent**: Maintain this design doc and track open questions.
  - **Renderer Implementation Agent**: Implement typed buffer builder + refactor quad/text batching to use it.
  - **Test/Perf Agent**: Update/add tests (and optional micro-benchmark) to prove reuse and prevent regressions.
- **Affected Packages/Services**:
  - `packages/renderer-webgpu/src/webgpu-renderer.ts` (batching + upload path)
  - `packages/renderer-webgpu/src/webgpu-renderer.test.ts` (tests for buffer uploads and reuse)
  - (Optional) a new helper module under `packages/renderer-webgpu/src/` (typed buffer builder)
- **Compatibility Considerations**:
  - No changes to `@idle-engine/renderer-contract` or `RenderCommandBuffer` formats.
  - The GPU-side instance vertex layout must remain unchanged (attribute order and stride).

## 5. Current State
`WebGpuRendererImpl` builds and flushes per-batch instance data as follows:
- The render loop streams ordered draws through `#renderQuadDrawEntry(...)`, which calls:
  - `#handleRectDraw(...)` / `#handleImageDraw(...)`: pushes 12 values per draw into `state.batchInstances` and increments `state.batchInstanceCount`.
  - `#handleTextDraw(...)`: calls `appendBitmapTextInstances({ batchInstances: state.batchInstances, ... })`, which pushes 12 values per rendered glyph and returns the number of appended glyph instances.
- Flushing (`#flushQuadBatch(...)`) converts the JS array to a typed array (`new Float32Array(state.batchInstances)`), grows the GPU instance buffer if needed, and uploads the data using `device.queue.writeBuffer(...)`.
- Resetting a batch (`#resetQuadBatch(...)`) discards the prior `batchInstances` array by assigning `state.batchInstances = []`, ensuring a new array allocation per flush/batch boundary.

The test suite (`packages/renderer-webgpu/src/webgpu-renderer.test.ts`) currently treats instance uploads as an `ArrayBuffer` payload passed to `queue.writeBuffer(...)`, and validates instance content by constructing `new Float32Array(data)`.

## 6. Proposed Solution

### 6.1 Architecture Overview
- Replace the hot `number[]` accumulation with a reusable typed instance builder:
  - A growable `Float32Array` buffer and a write cursor (float offset).
  - A `reset()` method to set the cursor back to 0 without allocating.
  - A `reserve(requiredFloats)` / `ensureCapacity(requiredFloats)` method to grow geometrically when needed.
- Keep the current batching boundaries (kind/pass/scissor) but change writes from `push(...)` to direct indexed writes into the typed buffer.
- Upload only the used portion of the builder’s underlying `ArrayBuffer` by using the `dataOffset`/`size` parameters of `queue.writeBuffer(...)` (or equivalent `ArrayBufferView` upload), avoiding `slice(...)` allocations.

**Diagram (conceptual)**:
`ordered draws` → `batch boundary checks` → `typed instance writer (cursor)` → `flush` → `queue.writeBuffer(instanceBuffer, ..., size = usedBytes)` → `reset cursor`

### 6.2 Detailed Design
- **Runtime Changes**:
  - Introduce a `Float32ArrayBuilder` (name TBD) with:
    - `buffer: Float32Array`
    - `lengthFloats: number` (cursor)
    - `reset(): void`
    - `ensureCapacity(requiredFloats: number): void` (doubling strategy; copies existing contents on growth)
  - Update `WebGpuQuadRenderState` to store the builder (or store it on the renderer instance and reference it from render state) instead of `batchInstances: number[]`.
  - Update `#handleRectDraw`, `#handleImageDraw`, and `appendBitmapTextInstances` to write directly into the typed buffer:
    - Write 12 floats per instance in the existing order: `[x, y, w, h, u0, v0, u1, v1, r, g, b, a]`.
    - Increment `batchInstanceCount` as today, or derive it from `lengthFloats / 12` (choose one and add invariants to keep them consistent).
  - Update `#flushQuadBatch` to:
    - Compute `usedBytes = lengthFloats * 4`.
    - Call `#ensureInstanceBuffer(usedBytes)`.
    - Upload without allocating:
      - Preferred: `queue.writeBuffer(instanceBuffer, 0, builder.buffer.buffer, 0, usedBytes)` (exact signature TBD per environment/types).
      - Alternative: `queue.writeBuffer(instanceBuffer, 0, builder.buffer, 0, usedBytes)` (upload view directly).
    - Reset the builder cursor and batch metadata.
- **Data & Schemas**: N/A.
- **APIs & Contracts**:
  - No external API changes.
  - If tests need visibility into reuse behavior, expose minimal internals via `webgpu-renderer.ts` `__test__` exports (e.g., a helper to access the instance builder identity) without making it part of the public renderer interface.
- **Tooling & Automation**:
  - Update `webgpu-renderer.test.ts` expectations to accept the new `writeBuffer` call shape (likely including `dataOffset`/`size`, and/or a `Float32Array` payload).
  - Add a unit test that renders twice and asserts the instance upload source buffer is reused once capacity is sufficient.

### 6.3 Operational Considerations
- **Deployment**: No special rollout mechanics; change is internal to the renderer package.
- **Telemetry & Observability**: N/A in-code. For manual verification, use browser devtools allocation profiling or Node `--trace-gc` during a high-volume render loop to confirm reduced GC churn.
- **Security & Compliance**: No new data handling; no user input surfaces added.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(renderer-webgpu): add reusable Float32Array builder` | Implement growable typed buffer + cursor utility | Renderer Implementation Agent | None | Builder supports reset + growth; no per-reset allocation |
| `refactor(renderer-webgpu): use typed builder for quad/text batching` | Replace `number[]` writes and `new Float32Array(...)` conversion with builder writes + upload by size | Renderer Implementation Agent | Builder utility | Rendering output matches existing tests; steady-state flushes allocate 0 new arrays |
| `test(renderer-webgpu): assert instance upload buffer reuse` | Update/add Vitest case to prove buffer identity reuse across renders/flushes | Test/Perf Agent | Refactor | Test fails if per-flush typed buffers are reallocated |
| `bench(renderer-webgpu): optional micro-benchmark for flush loop` | Small benchmark harness (Vitest or script) to quantify allocations/time | Test/Perf Agent | Refactor | Demonstrates reduced allocations in steady state (TBD metrics) |

### 7.2 Milestones
- **Phase 1**: Land builder + refactor + unit test proving reuse.
- **Phase 2**: Optional follow-ups to reduce other per-frame allocations (e.g., globals scratch buffers) if profiling shows remaining hotspots.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - `packages/renderer-webgpu/src/webgpu-renderer.ts`
  - `packages/renderer-webgpu/src/webgpu-renderer.test.ts`
  - (Optional) `packages/renderer-webgpu/src/<typed-builder>.ts`
  - This design doc: `docs/issue-809-design.md`
- **Communication Cadence**: One reviewer pass after Phase 1; Phase 2 only if profiling data supports it.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Issue 809: https://github.com/hansjm10/Idle-Game-Engine/issues/809
  - Renderer implementation: `packages/renderer-webgpu/src/webgpu-renderer.ts`
  - Existing tests: `packages/renderer-webgpu/src/webgpu-renderer.test.ts`
  - Instance layout constants: `INSTANCE_STRIDE_BYTES`, shader `VertexInput` in `webgpu-renderer.ts`
- **Prompting & Constraints**:
  - Do not edit checked-in generated outputs under `packages/renderer-webgpu/dist/**` by hand.
  - Preserve type-only imports/exports (`import type` / `export type`) if adding new modules.
  - Keep `INSTANCE_STRIDE_BYTES` and attribute ordering unchanged unless the shader + pipeline are updated in lockstep (out of scope).
- **Safety Rails**:
  - Always upload exactly `instanceCount * INSTANCE_STRIDE_BYTES` bytes (no stale trailing data).
  - Reset cursor and batch metadata on every flush and on early-out cases (empty batch, zero scissor rect).
  - Ensure growth logic is bounded and does not thrash (geometric growth; avoid per-instance reallocations).
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/renderer-webgpu`
  - `pnpm lint --filter @idle-engine/renderer-webgpu`

## 9. Alternatives Considered
- **Reuse `number[]` instead of reallocating**: Avoids `state.batchInstances = []`, but still requires allocating a typed array (or copying) to upload to the GPU each flush.
- **Precompute and allocate per frame**: Build a single typed array for all instances in the frame. This complicates scissor boundaries and mixed rect/image/text batching, and may require extra passes over text to count glyphs.
- **Pool per-flush typed arrays**: Reduces GC of buffers but still allocates frequently and increases complexity (pool sizing, lifetime, fragmentation).
- **Mapped GPU buffers**: Using mapped-at-creation buffers or persistent mapping is not broadly viable and complicates WebGPU usage patterns; also likely increases complexity beyond this issue’s scope.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Update `webgpu-renderer.test.ts` to validate instance uploads when `writeBuffer` uses `dataOffset`/`size` and/or a typed view payload.
  - Add a new test that:
    - renders a scene that triggers at least one flush and grows the instance builder to a non-trivial size,
    - renders the same scene again,
    - asserts the instance upload source buffer identity is reused (same `ArrayBuffer` or same builder object) and the `size` argument matches the expected used bytes.
- **Performance**:
  - Optional micro-benchmark that runs a tight loop with many flushes and asserts stable buffer identity; record timing locally (no console output in CI beyond Vitest’s reporter).
- **Tooling / A11y**: N/A.

## 11. Risks & Mitigations
- **Risk**: Upload path writes the full underlying buffer instead of the used range, causing stale data to be rendered.  
  **Mitigation**: Always pass `size = instanceCount * INSTANCE_STRIDE_BYTES` (or `lengthFloats * 4`) to `writeBuffer`.
- **Risk**: Cursor/instanceCount drift leads to incorrect `drawIndexed` instance counts.  
  **Mitigation**: Derive one from the other (single source of truth), and add assertions in tests (e.g., `lengthFloats === instanceCount * 12`).
- **Risk**: Tests become brittle due to different `writeBuffer` argument types (`ArrayBuffer` vs `ArrayBufferView`).  
  **Mitigation**: Update tests to validate content by constructing a `Float32Array` view over the provided data with offsets/sizes instead of assuming `data.byteLength` equals the used bytes.

## 12. Rollout Plan
- **Milestones**:
  - Merge Phase 1 changes with passing tests.
  - If desired, follow up with Phase 2 allocation reductions based on profiling.
- **Migration Strategy**: None.
- **Communication**: Note in the PR description that per-flush allocations were removed and include the new reuse test as evidence.

## 13. Open Questions
- Should Issue 809 also cover the small per-frame allocations in `#writeGlobals(...)` (currently allocates a `Float32Array` twice per render), or keep that as follow-up work?
- What is the preferred test assertion shape for “no per-flush allocation” in this repo: buffer identity reuse, `writeBuffer` argument inspection, or a dedicated benchmark harness?
- Should the typed builder live inside `webgpu-renderer.ts` (minimal surface area) or as a separate module under `packages/renderer-webgpu/src/` for reuse/testing?
- Do we want to reserve capacity up-front based on draw counts (and `text.length` as an upper bound) to reduce growth checks in the tight loop?

## 14. Follow-Up Work
- Replace other small per-frame temporary typed arrays (`#writeGlobals`) with reusable scratch buffers if profiling shows they are meaningful.
- Consider reusing other transient arrays in render state (`scissorStack`) if scissor-heavy UIs become a hotspot.

## 15. References
- Issue 809: https://github.com/hansjm10/Idle-Game-Engine/issues/809
- Quad/text batching + flush allocation: `packages/renderer-webgpu/src/webgpu-renderer.ts`
- Instance upload tests: `packages/renderer-webgpu/src/webgpu-renderer.test.ts`
- Renderer package overview: `packages/renderer-webgpu/README.md`

## Appendix A — Glossary
- **Batch flush**: The point where accumulated instances are uploaded to the GPU and drawn (triggered by kind/pass/scissor boundaries).
- **Instance buffer**: The GPU vertex buffer containing per-quad instance attributes (12 floats per instance).
- **Steady state**: After the typed builder has grown to accommodate typical peak instance counts, subsequent frames should not allocate new buffers.
- **Typed buffer builder**: A growable typed array plus cursor used as a reusable write target for instance data.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-21 | Codex (AI) | Initial draft for Issue 809 |

