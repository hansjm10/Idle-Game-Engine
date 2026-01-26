---
title: "renderer-webgpu: improve texture usage flags (Issue 846)"
sidebar_position: 99
---

# renderer-webgpu: improve texture usage flags (Issue 846)

## Document Control
- **Title**: Ensure WebGPU texture usage flags are cross-backend compatible for `copyExternalImageToTexture`
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-26
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/846 (triggered by runtime bitmap font generation in #841)
- **Execution Mode**: AI-led

## 1. Summary
`@idle-engine/renderer-webgpu` uploads packed atlas images via `GPUQueue.copyExternalImageToTexture(...)`. Chrome’s WebGPU implementation (Dawn) may internally execute this copy via a render pass, which requires the destination texture to include `RENDER_ATTACHMENT` usage in addition to `COPY_DST`. Today the atlas texture is created with `TEXTURE_BINDING | COPY_DST`, which can trigger repeated runtime errors and prevent asset loading. This design centralizes texture-usage requirements behind a small helper, documents cross-backend differences, and adds regression tests to keep atlas texture usage compatible across WebGPU backends.

## 2. Context & Problem Statement
- **Background**:
  - `packages/renderer-webgpu/src/webgpu-renderer.ts` packs images/fonts into a single atlas (`packAtlas(...)`) and uploads each packed entry using `device.queue.copyExternalImageToTexture(...)` in `#createAtlasTextureAndUpload(...)`.
  - The atlas texture is sampled in the sprite/text pipelines, so it also needs `TEXTURE_BINDING`.
  - The renderer’s unit tests run in Node without WebGPU globals, so `webgpu-renderer.ts` maintains small numeric fallbacks for usage enums (`GPU_TEXTURE_USAGE`, `GPU_BUFFER_USAGE`, etc.).
- **Problem**:
  - On Chrome/Dawn, `copyExternalImageToTexture` may throw unless the destination texture has both `COPY_DST` and `RENDER_ATTACHMENT` usage:
    - `Destination texture needs to have CopyDst and RenderAttachment usage.`
  - The current atlas texture descriptor uses `TEXTURE_BINDING | COPY_DST` only, so the renderer can fail to load assets on Chromium-based hosts.
- **Forces**:
  - Keep the renderer contract stable (no schema changes).
  - Keep behavior deterministic and testable in a WebGPU-less environment.
  - Prefer a robust, centralized policy over scattering backend-specific workarounds.
  - Avoid premature runtime backend detection unless it materially reduces risk/cost.

## 3. Goals & Non-Goals
- **Goals**:
  - Ensure textures used as the destination for `copyExternalImageToTexture` are created with the required usage flags across backends (at minimum `COPY_DST | RENDER_ATTACHMENT`).
  - Centralize the policy so future external-copy destinations don’t regress or copy/paste a partial usage mask.
  - Add deterministic unit tests that assert atlas texture usage includes required flags.
  - Document the known backend variance so future contributors understand why the flag set is a superset.
- **Non-Goals**:
  - Perfectly minimizing texture usage flags per backend/driver.
  - Adding runtime backend detection unless needed for correctness.
  - Introducing new atlas formats, render-target textures, or a broad WebGPU abstraction layer.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Renderer maintainers (`packages/renderer-webgpu`)
  - Host apps embedding WebGPU (`packages/shell-desktop`, future web shells)
- **Agent Roles**:
  - **Docs Agent**: Maintain this design doc, ensure references are current.
  - **Renderer Implementation Agent**: Implement centralized texture usage helpers and migrate call sites.
  - **Test Agent**: Extend the existing WebGPU stubs and add regression tests for usage flags.
- **Affected Packages/Services**:
  - `packages/renderer-webgpu/src/webgpu-renderer.ts` (atlas texture creation)
  - `packages/renderer-webgpu/src/webgpu-renderer.test.ts` (WebGPU stub + new tests)
  - `packages/renderer-webgpu/README.md` (documentation note; optional)
- **Compatibility Considerations**:
  - No renderer-contract changes.
  - Texture usage becomes a conservative superset for atlas uploads; this should be accepted by all conforming implementations.

## 5. Current State
- Atlas upload is implemented in `WebGpuRenderer.#createAtlasTextureAndUpload(...)`:
  - Creates a single atlas texture with `usage: TEXTURE_BINDING | COPY_DST`.
  - Calls `device.queue.copyExternalImageToTexture(...)` for each atlas entry.
- `webgpu-renderer.ts` defines a minimal `GPU_TEXTURE_USAGE` fallback for non-WebGPU runtimes, but it currently does not include `RENDER_ATTACHMENT`, making it easy for the renderer and tests to drift from real WebGPU requirements.

## 6. Proposed Solution
### 6.1 Architecture Overview
- Introduce a small “usage policy” helper for textures used as destinations of `copyExternalImageToTexture`.
- Update atlas texture creation to use the helper and always include `RENDER_ATTACHMENT` in addition to existing needs (`TEXTURE_BINDING | COPY_DST`).
- Extend `GPU_TEXTURE_USAGE` fallback constants to include `RENDER_ATTACHMENT` so Node-based unit tests can validate the bitmask deterministically.
- Document the rationale (Chrome/Dawn behavior, links to spec discussions) near the helper and/or in package docs.

### 6.2 Detailed Design
- **Runtime Changes**:
  - Add a helper in `packages/renderer-webgpu/src/` (new module or colocated near atlas upload) with a narrow, explicit intent, for example:
    - `getCopyExternalImageToTextureDestinationUsage(baseUsage: number): number`
    - or `createCopyExternalImageDestinationTexture(device, descriptor): GPUTexture`
  - Update `#createAtlasTextureAndUpload(...)` to use the helper so the atlas texture is always compatible with `copyExternalImageToTexture`.
  - Extend `GPU_TEXTURE_USAGE` to include `RENDER_ATTACHMENT` (from `globalThis.GPUTextureUsage` when available, otherwise a numeric fallback).
- **Data & Schemas**: No changes.
- **APIs & Contracts**: No public API changes; helper is internal to `@idle-engine/renderer-webgpu`.
- **Tooling & Automation**:
  - Add or extend unit tests that assert `device.createTexture(...)` receives a descriptor with `COPY_DST | RENDER_ATTACHMENT` when the texture is used as an external-copy destination.
  - (Optional) Add a short note to `packages/renderer-webgpu/README.md` under **Environment** or a new **Implementation Notes** section explaining the flag choice.

### 6.3 Operational Considerations
- **Deployment**: Ships as a patch-level renderer fix; no migration required.
- **Telemetry & Observability**: N/A (the error is thrown by the WebGPU implementation; fixing it removes console/device errors during `loadAssets()`).
- **Security & Compliance**: No new security surface; no new data handling.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `feat(renderer-webgpu): centralize texture usage for external copies` | Add a helper that applies required usage flags for `copyExternalImageToTexture` destinations; update atlas texture creation and usage enum fallbacks accordingly. | Renderer Implementation Agent | Doc approval | Atlas texture is created with `COPY_DST | RENDER_ATTACHMENT | TEXTURE_BINDING`; no scattered one-off bitmask tweaks; Node fallback constants include `RENDER_ATTACHMENT`. |
| `test(renderer-webgpu): assert atlas texture usage flags` | Add regression tests verifying `createTexture` is called with the expected usage mask when `loadAssets()` uploads an atlas via `copyExternalImageToTexture`. | Test Agent | Implementation | New tests fail if `RENDER_ATTACHMENT` is omitted; tests run deterministically in Node with the existing WebGPU stubs. |
| `docs(renderer-webgpu): document copyExternalImageToTexture backend variance` | Add a short rationale and reference links (GPUWeb issue, MDN/spec notes) explaining why `RENDER_ATTACHMENT` is included for external-copy destination textures. | Docs Agent | Implementation | Documentation exists either as code comments near the helper or as a package doc entry; references are linked. |

### 7.2 Milestones
- **Phase 1**: Helper + atlas usage update + tests + documentation note (single PR).
- **Phase 2** (optional): Extend the helper/policy if new texture upload paths are added (e.g., `copyBufferToTexture`, `writeTexture`, render targets) so each operation has an explicit, documented usage requirement.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Issue context + backend discussion links are in Issue 846.
  - Atlas upload path: `packages/renderer-webgpu/src/webgpu-renderer.ts` (`#createAtlasTextureAndUpload`).
  - Test harness: `packages/renderer-webgpu/src/webgpu-renderer.test.ts`.
- **Communication Cadence**: One reviewer pass after tests and docs land; follow-up comment on Issue 846 with the shipped policy.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Read Issue 846 and inspect `#createAtlasTextureAndUpload(...)` call sites of `copyExternalImageToTexture`.
  - Validate how usage constants are defined for Node-based tests (fallback enum values).
- **Prompting & Constraints**:
  - Do not edit checked-in `dist/**` outputs by hand.
  - Avoid console output in tests (Vitest LLM reporter expects clean output).
  - Prefer a small helper with a narrow name/contract over a generic “kitchen sink” WebGPU wrapper.
- **Safety Rails**:
  - Limit `RENDER_ATTACHMENT` usage widening to textures that are actually used as external-copy destinations (atlas today).
  - Keep tests resilient by asserting only what is required for correctness.
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/renderer-webgpu`
  - `pnpm lint --filter @idle-engine/renderer-webgpu` (or `pnpm lint`)

## 9. Alternatives Considered
1. **Inline fix at atlas creation** (`usage |= RENDER_ATTACHMENT`): Works, but encourages repeating backend knowledge at call sites and makes future regressions more likely.
2. **Runtime backend detection** (only add the flag on Dawn): Avoids superset usage, but adds complexity and likely requires non-portable adapter/UA checks.
3. **Staging upload path** (copy via buffer instead of external image copy): Adds overhead and complexity; does not address the core “usage requirements vary” problem.
4. **Wait for implementation changes**: Not acceptable; the renderer must be robust across the hosts we support today.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Extend `packages/renderer-webgpu/src/webgpu-renderer.test.ts` so a `loadAssets()` call asserts the atlas texture was created with `COPY_DST | RENDER_ATTACHMENT` (and still includes `TEXTURE_BINDING` for sampling).
  - (Optional) Add a focused unit test for the helper itself if extracted into its own module.
- **Performance**: N/A (one-time texture creation flags).
- **Tooling / A11y**: Manual validation in Chromium-based hosts (Electron shell): load assets that trigger runtime bitmap font generation and confirm no Dawn validation errors occur.

## 11. Risks & Mitigations
- **Superset usage flags change allocation/perf characteristics**:
  - Mitigation: apply the superset only where needed (external-copy destinations), and keep the policy centralized for future tuning.
- **Backend variance expands (additional required flags)**:
  - Mitigation: document the rationale and keep the helper as the single place to encode requirements.
- **Tests become brittle due to numeric flag values**:
  - Mitigation: assert bit inclusion (mask contains required bits) rather than full equality where appropriate, and keep fallback constants aligned with spec values.

## 12. Rollout Plan
- **Milestones**: Land as a patch-level fix to `@idle-engine/renderer-webgpu`.
- **Migration Strategy**: None.
- **Communication**: Comment on Issue 846 noting that atlas textures created for `copyExternalImageToTexture` now include `RENDER_ATTACHMENT` for cross-backend compatibility.

## 13. Open Questions
1. Should the helper live in a dedicated `webgpu-texture-*.ts` module, or remain in `webgpu-renderer.ts` until more call sites exist?
2. Do we want to assert “bit inclusion” or “exact mask equality” in tests (to allow future additions without churn)?
3. Should we document this as code comments only, or also add a short “backend variance” note in `packages/renderer-webgpu/README.md`?
4. Is there a preferred manual repro path (Electron shell flow) to validate before/after on Chromium/Dawn?

## 14. Follow-Up Work
- Extend the usage helper/policy as additional texture operations are introduced (render targets, depth textures, buffer-to-texture uploads).
- Track Firefox WebGPU behavior when it becomes available and update docs/tests if requirements differ.

## 15. References
- Issue 846: https://github.com/hansjm10/Idle-Game-Engine/issues/846
- GPUWeb discussion: https://github.com/gpuweb/gpuweb/issues/3357
- MDN: https://developer.mozilla.org/en-US/docs/Web/API/GPUQueue/copyExternalImageToTexture
- Atlas upload path: `packages/renderer-webgpu/src/webgpu-renderer.ts`
- Renderer unit tests: `packages/renderer-webgpu/src/webgpu-renderer.test.ts`

## Appendix A — Glossary
- **Usage flags**: Bitmask on `GPUTextureDescriptor.usage` describing how a texture will be used (copy, sampling, render attachment, etc.).
- **Dawn**: Chromium’s WebGPU implementation layer (used by Chrome/Electron).
- **`copyExternalImageToTexture`**: WebGPU API for copying from an external image source (e.g., `ImageBitmap`, `HTMLImageElement`) into a GPU texture.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-26 | Codex (AI) | Initial draft |

