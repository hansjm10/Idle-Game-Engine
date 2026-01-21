---
title: "renderer-webgpu: Destroy GPU resources on dispose (Issue 811)"
sidebar_position: 99
---

# renderer-webgpu: Destroy GPU resources on dispose (Issue 811)

## Document Control
- **Title**: Destroy owned WebGPU textures/buffers on renderer dispose
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-21
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/811
- **Execution Mode**: AI-led

## 1. Summary
`@idle-engine/renderer-webgpu` allocates GPU resources (sprite atlas texture and multiple GPU buffers) but does not currently destroy them. `dispose()` only flips a flag, and the atlas texture created in `loadAssets()` is not retained anywhere, making it impossible to free later. This design introduces explicit ownership tracking for GPU textures/buffers and adds deterministic cleanup: destroy owned resources in `dispose()`, destroy the previous atlas when replacing it in `loadAssets()`, and destroy the old instance buffer when the renderer grows it.

## 2. Context & Problem Statement
- **Background**: `packages/renderer-webgpu/src/webgpu-renderer.ts` implements `WebGpuRenderer` by creating a sprite pipeline (sampler, bind groups, vertex/index buffers, uniform buffer) and building an atlas texture during `loadAssets(...)`. Rendering uploads per-frame instance data into a GPU instance buffer via `device.queue.writeBuffer(...)`.
- **Problem**:
  - The atlas texture is created and uploaded in `#createAtlasTextureAndUpload(...)` and is used to create a bind group, but the texture reference itself is not stored, so it cannot be destroyed later.
  - `#ensureInstanceBuffer(...)` may allocate a new `GPUBuffer` when required capacity increases, but does not destroy the prior buffer when replacing it.
  - `dispose()` currently only sets `#disposed = true` and does not call `.destroy()` on any textures/buffers.
- **Forces**:
  - Some hosts may call `loadAssets()` multiple times (content reload, recovery/recreate loops); leaks can accumulate GPU memory and cause instability on some drivers.
  - Cleanup must be deterministic and not depend on GC timing; `.destroy()` should be invoked on resources the renderer owns.
  - The external renderer contract should not change; this should be a safe, internal behavior fix.

## 3. Goals & Non-Goals
- **Goals**:
  - Ensure `dispose()` destroys owned `GPUTexture`/`GPUBuffer` resources and is safe to call multiple times.
  - Ensure repeated `loadAssets()` calls do not leak atlas textures (destroy the previous atlas before/when replacing it).
  - Ensure instance buffer growth (`#ensureInstanceBuffer`) does not leak prior buffers.
  - Add/update unit tests to assert `.destroy()` is invoked on stubbed textures/buffers where applicable.
  - Avoid behavioral changes in rendered output and public APIs (except stronger cleanup semantics).
- **Non-Goals**:
  - Adding new public APIs such as `unloadAssets()` (could be follow-up work).
  - Attempting to “destroy everything” (e.g., pipelines/bind groups/samplers), since WebGPU does not expose explicit destruction for all object types.
  - Implementing GPU memory telemetry or driver-specific leak detection beyond unit tests.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Renderer maintainers (`packages/renderer-webgpu`).
  - Host applications embedding WebGPU (`packages/shell-desktop`, future web shells) that may reload assets or recreate renderers.
- **Agent Roles**:
  - **Docs Agent**: Maintain this design doc and track open questions.
  - **Renderer Implementation Agent**: Implement resource ownership tracking and cleanup logic.
  - **Test Agent**: Extend the WebGPU stub harness and add regression tests for `.destroy()` calls.
- **Affected Packages/Services**:
  - `packages/renderer-webgpu/src/webgpu-renderer.ts` (resource creation, replacement, disposal)
  - `packages/renderer-webgpu/src/webgpu-renderer.test.ts` (stub WebGPU environment + new tests)
  - (Optional) `packages/renderer-webgpu/README.md` (document stronger dispose semantics)
- **Compatibility Considerations**:
  - No changes to `WebGpuRenderer` interface shape are required; only stronger guarantees for `dispose()` and repeated `loadAssets()`.
  - Ensure cleanup does not affect rendering correctness when the renderer is still in use (e.g., do not destroy the currently-bound atlas until the replacement is fully set).

## 5. Current State
Today, `WebGpuRendererImpl` owns several long-lived resources but does not treat them as owned for cleanup:
- Pipeline setup (`#ensureSpritePipeline`) allocates:
  - `#spriteUniformBuffer`, `#spriteVertexBuffer`, `#spriteIndexBuffer`, `#spriteSampler`, and bind groups.
- Instance uploads allocate/grow an instance buffer in `#ensureInstanceBuffer(requiredBytes)`.
  - When capacity is insufficient, a new `GPUBuffer` is created and assigned to `#spriteInstanceBuffer`, overwriting the prior reference without destroying it.
- Atlas loading (`loadAssets`) creates an atlas texture and writes image data into it:
  - `const atlasTexture = this.#createAtlasTextureAndUpload(...)`
  - `this.#spriteTextureBindGroup = this.#createSpriteAtlasBindGroup(atlasTexture)`
  - The `atlasTexture` is not retained on the class after `loadAssets` returns.
- Disposal:
  - `dispose(): void { this.#disposed = true; }`
  - No `.destroy()` calls are issued for textures/buffers.

The existing test harness stubs WebGPU objects but does not currently model `.destroy()` calls, so resource cleanup is untested.

## 6. Proposed Solution

### 6.1 Architecture Overview
Introduce a simple “owned resources” model inside `WebGpuRendererImpl`:
- Any `GPUTexture`/`GPUBuffer` created by this renderer instance is considered owned.
- Owned resources are:
  - stored on the renderer instance so they can be explicitly destroyed later, and
  - destroyed in two scenarios:
    1. **On replace** (e.g., atlas texture and resizable instance buffer), and
    2. **On dispose** (final cleanup).

This keeps cleanup local and explicit without adding a general-purpose resource manager.

### 6.2 Detailed Design
- **Runtime Changes**:
  - Track the atlas texture:
    - Add a private field (name TBD): `#atlasTexture: GPUTexture | undefined`.
    - In `loadAssets(...)`, before replacing the atlas:
      - destroy any previous `#atlasTexture` (best-effort) and clear it.
      - create the new atlas, assign `#atlasTexture = atlasTexture`, then rebuild `#spriteTextureBindGroup`.
  - Fix instance buffer growth:
    - In `#ensureInstanceBuffer(requiredBytes)`, when reallocating:
      - hold `const prior = this.#spriteInstanceBuffer`, create the new buffer, then call `prior?.destroy()` after the new assignment is complete.
    - Keep `#spriteInstanceBufferSize` in sync with the active buffer.
  - Destroy owned buffers/textures on dispose:
    - Update `dispose()` to:
      - be idempotent (if already disposed, return),
      - call `.destroy()` on:
        - `#atlasTexture`
        - `#spriteUniformBuffer`
        - `#spriteVertexBuffer`
        - `#spriteIndexBuffer`
        - `#spriteInstanceBuffer`
      - clear references (`undefined`) so subsequent code paths cannot accidentally use destroyed resources.
    - Continue to set `#disposed = true` so `render/resize` stay no-op and so device-lost handling remains suppressed after dispose.
  - Defensive error handling:
    - Prefer best-effort cleanup that does not throw from `dispose()` (wrap per-resource `.destroy()` in `try/catch` if needed to keep shutdown paths safe in both real WebGPU and test stubs).

- **Data & Schemas**: N/A.

- **APIs & Contracts**:
  - No changes to `WebGpuRenderer` or renderer-contract types are required.
  - Optional documentation update: clarify in `packages/renderer-webgpu/README.md` that `dispose()` destroys owned textures/buffers (not only “stops future GPU work”).

- **Tooling & Automation**:
  - Extend the WebGPU stub environment in `webgpu-renderer.test.ts` so:
    - `device.createBuffer()` returns objects that include a `destroy` spy, and
    - `device.createTexture()` returns objects that include a `destroy` spy.
  - Add tests that:
    - create a renderer, run `loadAssets(...)`, call `dispose()`, and assert the atlas texture and buffers’ `destroy` spies were called once.
    - call `loadAssets(...)` twice and assert the first atlas texture `destroy()` is called when replaced.
    - trigger instance buffer growth across renders (or by rendering enough instances) and assert the prior instance buffer `destroy()` is called on resize.

### 6.3 Operational Considerations
- **Deployment**: Internal behavior change; no migration. Improvement is realized when hosts call `dispose()` (e.g., on teardown or renderer replacement).
- **Telemetry & Observability**: N/A. Avoid adding logging in hot paths or shutdown paths.
- **Security & Compliance**: N/A (no new data surfaces).

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `bug(renderer-webgpu): track and destroy atlas texture` | Store atlas `GPUTexture` and destroy prior atlas on replacement | Renderer Implementation Agent | None | Calling `loadAssets()` multiple times does not leak atlas textures; tests assert `.destroy()` calls |
| `bug(renderer-webgpu): destroy buffers on dispose` | Destroy owned buffers (`uniform`, `vertex`, `index`, `instance`) in `dispose()` | Renderer Implementation Agent | None | `dispose()` calls `.destroy()` once per owned buffer and is idempotent |
| `bug(renderer-webgpu): destroy resized instance buffer` | Destroy prior `#spriteInstanceBuffer` when growing it | Renderer Implementation Agent | Buffer tracking | Instance buffer growth does not leak old buffers; tests assert `.destroy()` calls |
| `test(renderer-webgpu): assert destroy calls via stubs` | Extend stubs and add regression tests for disposal/replacement | Test Agent | Implementation | `pnpm test --filter @idle-engine/renderer-webgpu` passes; new tests fail on regressions |

### 7.2 Milestones
- **Phase 1**: Implement atlas texture tracking + dispose buffer/texture destruction, update stubs, add unit coverage.
- **Phase 2**: Verify replacement paths (second `loadAssets`, instance buffer growth) and add targeted regression tests.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Issue 811: https://github.com/hansjm10/Idle-Game-Engine/issues/811
  - Primary file: `packages/renderer-webgpu/src/webgpu-renderer.ts`
  - Test harness: `packages/renderer-webgpu/src/webgpu-renderer.test.ts`
- **Communication Cadence**: One reviewer pass once unit tests cover the new cleanup behavior.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Issue 811 and the two code references in the issue body.
  - WebGPU resource creation sites in `webgpu-renderer.ts` (`createTexture`, `createBuffer`, `#ensureInstanceBuffer`, `dispose`).
  - Stub WebGPU environment in `webgpu-renderer.test.ts` (used to validate `.destroy()` calls).
- **Prompting & Constraints**:
  - Do not edit generated `packages/renderer-webgpu/dist/**` by hand.
  - Keep behavior deterministic and avoid console output in tests (Vitest LLM reporter expects clean output).
- **Safety Rails**:
  - Only destroy resources created/owned by the renderer instance.
  - Do not attempt to destroy `context.getCurrentTexture()` or any external image sources.
  - Ensure `dispose()` remains safe to call during teardown even if `device.lost` has resolved.
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/renderer-webgpu`
  - `pnpm lint --filter @idle-engine/renderer-webgpu` (or workspace `pnpm lint` if needed)

## 9. Alternatives Considered
1. **Do nothing / rely on GC**: Rejected; GPU resources can outlive JS references, and relying on GC timing risks long-lived GPU memory growth.
2. **Create a new renderer instance instead of reloading assets**: Not always viable for hosts; still requires explicit cleanup of the prior instance to avoid leaking buffers/textures.
3. **Central “resource manager” registry**: Overkill for the current surface area; explicit fields and targeted cleanup are simpler and easier to reason about.
4. **FinalizationRegistry-based cleanup**: Rejected; non-deterministic and unreliable for ensuring timely GPU resource reclamation.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Extend `packages/renderer-webgpu/src/webgpu-renderer.test.ts` stubs so `GPUBuffer`/`GPUTexture` expose `.destroy()` spies.
  - Add tests for:
    - `.dispose()` destroys the atlas texture and buffers.
    - Repeated `loadAssets()` destroys the previous atlas texture.
    - Instance buffer growth destroys the previous instance buffer.
- **Performance**: N/A (behavioral fix). Optional manual validation in a real WebGPU host: repeatedly call `loadAssets()` and monitor GPU memory/driver stability.
- **Tooling / A11y**: N/A.

## 11. Risks & Mitigations
- **Destroying resources still in use by the GPU**:
  - Mitigation: only destroy on `dispose()` or when atomically swapping to a replacement atlas/buffer. WebGPU destruction is designed to be safe as long as the application does not continue using the destroyed resource.
- **Double-destroy / idempotency bugs**:
  - Mitigation: clear references after destruction and guard `dispose()` to run once.
- **Device lost behavior differences across implementations**:
  - Mitigation: keep cleanup best-effort and non-throwing; maintain existing `#lost` gating for render/resize.
- **Test harness drift from real WebGPU**:
  - Mitigation: only stub `.destroy()` for textures/buffers; avoid inventing behavior for pipeline/bind group objects.

## 12. Rollout Plan
- **Milestones**: Land as a patch-level bug fix within `@idle-engine/renderer-webgpu`.
- **Migration Strategy**: None. Hosts should already call `dispose()` on teardown; this change makes it effective for GPU memory.
- **Communication**: Note in release notes (or issue comment) that `dispose()` now actively destroys GPU textures/buffers and that repeated `loadAssets()` no longer leaks atlas textures.

## 13. Open Questions
1. Should `loadAssets()` destroy the previous atlas texture *before* or *after* creating the replacement (trade-off: minimal peak memory vs. avoiding a transient “no atlas” state if creation fails)?
2. Should `dispose()` attempt to destroy resources even if the device has already been lost, or should it short-circuit when `#lost` is true?
3. Do we want to document a stronger lifecycle recommendation for hosts (e.g., always call `dispose()` before abandoning a renderer instance)?

## 14. Follow-Up Work
- Consider adding a public `unloadAssets()` method to free the atlas without disposing the entire renderer (if host workflows need it).
- Consider tracking/destroying additional WebGPU resource types if added later (e.g., `GPUQuerySet`), using the same owned-resource approach.

## 15. References
- Issue 811: https://github.com/hansjm10/Idle-Game-Engine/issues/811
- Renderer implementation: `packages/renderer-webgpu/src/webgpu-renderer.ts`
- Renderer tests/stubs: `packages/renderer-webgpu/src/webgpu-renderer.test.ts`
- Renderer package docs: `packages/renderer-webgpu/README.md`

## Appendix A — Glossary
- **WebGPU**: Modern GPU API for the web; exposes devices, queues, buffers, textures, and pipelines.
- **GPUTexture**: WebGPU resource representing an image/texture allocation; supports `.destroy()`.
- **GPUBuffer**: WebGPU resource representing a linear memory allocation; supports `.destroy()`.
- **Atlas**: A packed texture containing multiple sprites/fonts for efficient batching.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-21 | Codex (AI) | Initial draft |

