---
title: "renderer-webgpu: validate schema versions and cap untrusted inputs (Issue 813)"
sidebar_position: 99
---

# renderer-webgpu: validate schema versions and cap untrusted inputs (Issue 813)

## Document Control
- **Title**: Validate renderer contract schema versions and cap untrusted inputs in `@idle-engine/renderer-webgpu`
- **Authors**: Codex (AI)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-24
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/813
- **Execution Mode**: AI-led

## 1. Summary
`@idle-engine/renderer-webgpu` currently accepts untrusted `AssetManifest` and `RenderCommandBuffer` inputs without validating `schemaVersion` or enforcing basic resource limits (asset count, draws per frame, text length). This creates avoidable failure modes: silent schema mismatches can produce undefined behavior, and oversized inputs can trigger excessive allocations or per-frame work that freezes/crashes the browser (DoS). This design adds fail-fast schema version checks at `loadAssets()` and `render()`, introduces configurable input limits with safe defaults, and adds unit tests + documentation for the default caps.

## 2. Context & Problem Statement
- **Background**:
  - The renderer contract lives in `@idle-engine/renderer-contract` and defines `AssetManifest`, `RenderCommandBuffer`, and `RENDERER_CONTRACT_SCHEMA_VERSION`.
  - The WebGPU backend (`packages/renderer-webgpu/src/webgpu-renderer.ts`) has two public entry points for untrusted payloads:
    - `WebGpuRenderer.loadAssets(manifest, assets, ...)` (manifest-driven atlas construction)
    - `WebGpuRenderer.render(rcb)` (per-frame draw processing and GPU submission)
  - These payloads can originate from content packs, mods, or replay files, and should be treated as untrusted by default.
- **Problem**:
  - **Schema version mismatch**: `loadAssets()` does not validate `manifest.schemaVersion`, and `render()` does not validate `rcb.frame.schemaVersion`, despite the contract having an explicit version constant.
  - **Denial of Service**: there are no caps on input sizes. Notably:
    - Huge `manifest.assets` forces large sorts and many async `loadImage/loadFont` calls.
    - Huge `rcb.draws` forces sorting/processing and multiple `Array.prototype.some(...)` scans.
    - Huge `TextDraw.text` can trigger large instance reservations (`reserveInstances(text.length)`) and significant per-frame CPU/memory pressure.
- **Forces**:
  - Keep the renderer deterministic (especially for atlas layout/hashing).
  - Keep the public API small and backward-compatible for valid inputs.
  - Fail fast with clear, actionable error messages (no silent corruption).
  - Avoid adding heavy runtime dependencies (e.g., schema validators) unless necessary.

## 3. Goals & Non-Goals
- **Goals**:
  - Reject incompatible schema versions at the earliest entry points:
    - `manifest.schemaVersion === RENDERER_CONTRACT_SCHEMA_VERSION`
    - `rcb.frame.schemaVersion === RENDERER_CONTRACT_SCHEMA_VERSION`
  - Add configurable limits (with defaults) to cap:
    - maximum assets per manifest
    - maximum draws per frame
    - maximum text length per `TextDraw`
  - Ensure limit violations fail fast before expensive work (sorting, allocations, GPU submission).
  - Add deterministic unit tests covering schema mismatch and limit enforcement.
  - Document default limits in package docs (README and/or exported JSDoc).
- **Non-Goals**:
  - Full structural validation of the entire renderer contract payload (beyond the minimal checks described here).
  - Introducing per-field numeric validation everywhere (e.g., checking all coordinates are finite) as part of Issue 813.
  - Adding new renderer-contract schema versions or migration tooling.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Renderer maintainers (`packages/renderer-webgpu`)
  - Host applications that run untrusted content/replays (`packages/shell-desktop`, future web shells)
  - Content pack authors (indirectly; they see clearer errors on mismatch)
- **Agent Roles**:
  - **Docs Agent**: Maintain this design doc and capture decisions/open questions.
  - **Renderer Implementation Agent**: Implement schema checks + caps in `webgpu-renderer.ts`.
  - **Test Agent**: Add unit tests to `packages/renderer-webgpu/src/webgpu-renderer.test.ts`.
  - **Docs/Release Agent**: Update `packages/renderer-webgpu/README.md` to document limits and configuration.
- **Affected Packages/Services**:
  - `packages/renderer-webgpu/src/webgpu-renderer.ts` (validation and limits)
  - `packages/renderer-webgpu/src/webgpu-renderer.test.ts` (new unit tests)
  - `packages/renderer-webgpu/README.md` (document defaults)
  - `packages/renderer-contract/src/types.ts` (reference for schema constant; no changes expected)
- **Compatibility Considerations**:
  - This change is intentionally stricter: callers passing mismatched schema versions or oversized inputs will now receive immediate errors.
  - Limits must be configurable so trusted/controlled environments can raise caps when necessary.

## 5. Current State
- Contract schema versioning exists:
  - `packages/renderer-contract/src/types.ts` exports `RENDERER_CONTRACT_SCHEMA_VERSION` and uses it in `AssetManifest.schemaVersion` and `FrameHeader.schemaVersion`.
- `WebGpuRenderer.loadAssets(...)` behavior:
  - Builds deterministic atlas layout by filtering/sorting `manifest.assets` (`getSortedRenderableAtlasEntries(...)`) and packing sources.
  - Does not validate `manifest.schemaVersion` and does not cap `manifest.assets.length`.
  - Performs some validation (e.g., rejects duplicate `AssetId` among renderable atlas entries), but only after iterating/sorting.
- `WebGpuRenderer.render(...)` behavior:
  - Immediately sorts/rewrites draw order via `orderDrawsByPassAndSortKey(rcb)` and then iterates draws to emit instance data + submit GPU work.
  - Does not validate `rcb.frame.schemaVersion` and does not cap `rcb.draws.length`.
  - Text draws can allocate proportional to `draw.text.length` via `appendBitmapTextInstances(...)`.
- Related prior work:
  - `packages/renderer-debug/src/rcb-validation.ts` includes a `validateRenderCommandBuffer(...)` helper that checks `frame.schemaVersion` and many structural/numeric constraints, but `renderer-webgpu` does not use it today.

## 6. Proposed Solution
### 6.1 Architecture Overview
- Add a small input validation layer at the entry points of `@idle-engine/renderer-webgpu`:
  - **Schema version checks** in `loadAssets()` and `render()`.
  - **Limit checks** in `loadAssets()` and `render()` using renderer-owned caps.
- Expose caps via `WebGpuRendererCreateOptions` so hosts can tune limits based on their trust model and performance envelope.
- Keep checks lightweight, synchronous, and fail-fast:
  - Reject oversized `manifest.assets` before sorting/loading.
  - Reject oversized `rcb.draws` before ordering/sorting.
  - Reject oversized `TextDraw.text` before instance reservations.

### 6.2 Detailed Design
- **Runtime Changes**:
  1. Import the schema version constant in `packages/renderer-webgpu/src/webgpu-renderer.ts`:
     - Add `RENDERER_CONTRACT_SCHEMA_VERSION` to the value imports from `@idle-engine/renderer-contract`.
  2. Add a public limits shape and defaults:
     - `export interface WebGpuRendererLimits { maxAssets?: number; maxDrawsPerFrame?: number; maxTextLength?: number }`
     - Defaults (initial proposal, aligned with Issue 813): `maxAssets = 10_000`, `maxDrawsPerFrame = 100_000`, `maxTextLength = 10_000`.
     - Defaults should be applied once during `createWebGpuRenderer(...)` / `WebGpuRendererImpl` construction to avoid per-call recomputation.
  3. Extend `WebGpuRendererCreateOptions` with an optional `limits` field:
     - `readonly limits?: WebGpuRendererLimits;`
  4. Enforce schema + caps:
     - In `loadAssets(manifest, ...)`:
       - Throw if `manifest.schemaVersion !== RENDERER_CONTRACT_SCHEMA_VERSION`.
       - Throw if `manifest.assets.length > limits.maxAssets`.
       - Perform these checks before `getSortedRenderableAtlasEntries(manifest)`.
     - In `render(rcb)`:
       - Throw if `rcb.frame.schemaVersion !== RENDERER_CONTRACT_SCHEMA_VERSION`.
       - Throw if `rcb.draws.length > limits.maxDrawsPerFrame`.
       - Scan draws (only if within draw-count limit) and throw if any `TextDraw.text.length > limits.maxTextLength`.
       - Perform these checks before `orderDrawsByPassAndSortKey(rcb)` to avoid `O(n log n)` work on rejected inputs.
  5. Error messages:
     - Prefer stable, descriptive messages that include the actual and expected values, e.g.:
       - `AssetManifest schemaVersion X is not supported (expected Y).`
       - `RenderCommandBuffer frame.schemaVersion X is not supported (expected Y).`
       - `Draw count exceeds limit: N > maxDrawsPerFrame`
       - `Text length exceeds limit: N > maxTextLength`
     - (Open question) whether to introduce dedicated error classes for hosts to catch/recover without string matching.
- **Data & Schemas**:
  - No renderer-contract schema changes. This work enforces the existing `RENDERER_CONTRACT_SCHEMA_VERSION`.
- **APIs & Contracts**:
  - Adds optional `limits` to `WebGpuRendererCreateOptions` only; no required call-site changes for valid inputs.
  - No changes to `@idle-engine/renderer-contract` public types required.
- **Tooling & Automation**:
  - Add unit tests under `packages/renderer-webgpu/src/webgpu-renderer.test.ts`.
  - Update `packages/renderer-webgpu/README.md` to document default limits and configuration.

### 6.3 Operational Considerations
- **Deployment**: Standard package release for `@idle-engine/renderer-webgpu`.
- **Telemetry & Observability**: No new logging in core library paths; hosts can catch and instrument errors as needed.
- **Security & Compliance**:
  - Reduces availability risk from untrusted content/replays by bounding resource usage at the API boundary.
  - Converts silent schema mismatch into explicit rejection, improving safety and debuggability.

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `bug(renderer-webgpu): validate schema versions at entry points` | Import `RENDERER_CONTRACT_SCHEMA_VERSION` and enforce `manifest.schemaVersion` and `rcb.frame.schemaVersion` checks | Renderer Implementation Agent | Design approval | Clear thrown errors for mismatches; unit tests cover both cases |
| `feat(renderer-webgpu): add and enforce WebGpuRendererLimits` | Add `limits` to create options, defaults, and enforce `maxAssets/maxDrawsPerFrame/maxTextLength` | Renderer Implementation Agent | Schema checks | Oversized inputs rejected before sorting/allocation; tests cover each limit |
| `test(renderer-webgpu): add DoS hardening regression tests` | Add unit tests for mismatch + limit violations and ensure errors are descriptive | Test Agent | Implementation | Vitest suite covers schema mismatch and caps; tests deterministic |
| `docs(renderer-webgpu): document default limits` | Document defaults and how to override in `packages/renderer-webgpu/README.md` (or exported JSDoc) | Docs/Release Agent | Implementation | README includes defaults and `limits` example; no console noise in tests |

### 7.2 Milestones
- **Phase 1**: Implement schema version validation + unit tests.
- **Phase 2**: Implement caps + unit tests + README/JSDoc documentation.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Issue 813: https://github.com/hansjm10/Idle-Game-Engine/issues/813
  - Entry points: `packages/renderer-webgpu/src/webgpu-renderer.ts` (`loadAssets`, `render`, `createWebGpuRenderer`)
  - Contract schema: `packages/renderer-contract/src/types.ts`
  - Existing validation patterns: `packages/renderer-debug/src/rcb-validation.ts`
  - Test harness: `packages/renderer-webgpu/src/webgpu-renderer.test.ts`
- **Communication Cadence**: Single reviewer pass once tests + docs are updated.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Read Issue 813 body and review current `loadAssets` and `render` implementations to identify where expensive work begins.
  - Confirm how `appendBitmapTextInstances` allocates/reserves instances so `maxTextLength` blocks worst-case allocations.
- **Prompting & Constraints**:
  - Do not edit checked-in `dist/` outputs.
  - Preserve ES module imports and type-only import/export rules (`import type { ... }`).
  - Keep validation logic small and deterministic; avoid console output that could corrupt `vitest-llm-reporter`.
- **Safety Rails**:
  - Validation must occur before sorting/packing/allocations whenever possible.
  - Prefer throwing errors (fail-fast) over truncation/clamping for contract violations.
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/renderer-webgpu`
  - `pnpm lint --filter @idle-engine/renderer-webgpu` (or `pnpm lint`)

## 9. Alternatives Considered
1. **Do nothing / rely on TypeScript types**: Rejected; does not protect runtime from untrusted JSON/replay inputs.
2. **Full schema validation (e.g., AJV/Zod) for manifests + RCB**: More complete but adds runtime overhead and dependencies; can be a follow-up if needed.
3. **Reuse `@idle-engine/renderer-debug` validation directly**: Would add an undesirable dependency edge for a production renderer and still doesn’t address asset manifest caps.
4. **Truncate oversized inputs instead of throwing**: Avoids hard failures but risks silent corruption and non-obvious rendering differences; not aligned with schema versioning.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Add tests that assert:
    - `loadAssets()` throws when `manifest.schemaVersion !== RENDERER_CONTRACT_SCHEMA_VERSION`.
    - `render()` throws when `rcb.frame.schemaVersion !== RENDERER_CONTRACT_SCHEMA_VERSION`.
    - `loadAssets()` throws when `manifest.assets.length > maxAssets` (and does so before invoking `assets.loadImage/loadFont`).
    - `render()` throws when `rcb.draws.length > maxDrawsPerFrame` (and does so before GPU submission).
    - `render()` throws when any `TextDraw.text.length > maxTextLength` (and does so before instance buffer reservations).
- **Performance**:
  - Validation adds small `O(n)` scanning for text lengths (bounded by `maxDrawsPerFrame`), while preventing `O(n log n)` sorting and large allocations on rejected inputs.
- **Tooling / A11y**:
  - Manual validation in a WebGPU host (Electron shell) by feeding intentionally malformed replays/packs and confirming error surfacing and no tab freeze.

## 11. Risks & Mitigations
- **Breaking existing consumers with old schema versions**:
  - Mitigation: clear error message pointing at expected schema version; ensure contract version bumps are coordinated.
- **Default caps too low for legitimate content**:
  - Mitigation: expose `limits` in `WebGpuRendererCreateOptions`; document how to raise limits for trusted environments.
- **Validation overhead on hot render loop**:
  - Mitigation: keep checks minimal; only scan for text length after draw-count is within bounds.

## 12. Rollout Plan
- **Milestones**: Ship as a patch/minor update to `@idle-engine/renderer-webgpu` (depending on semver interpretation of “throws on invalid input”).
- **Migration Strategy**: None for compliant callers; update any replays/content packs that carry stale schema versions.
- **Communication**: Note in release notes and issue comment that the renderer now enforces schema versions and default input caps.

## 13. Open Questions
1. Should limits be configured only at renderer creation (`createWebGpuRenderer(..., { limits })`), or should `loadAssets`/`render` also accept per-call overrides?
2. Should the library introduce dedicated error classes (e.g., `WebGpuRendererSchemaMismatchError`, `WebGpuRendererLimitExceededError`) to allow safe host-side recovery without string matching?
3. Should `maxTextLength` be defined in terms of JavaScript UTF-16 code units (`text.length`) or Unicode code points (iteration count of `for (const ch of text)`)?
4. Should we also cap `passes.length` and/or scissor stack depth to avoid other unbounded structures (follow-up or included in this issue)?
5. Are the proposed defaults (`10k` assets, `100k` draws, `10k` chars) appropriate for the intended content scale, or should they be tuned based on empirical packs?

## 14. Follow-Up Work
- Consider promoting a shared, dependency-light validation helper into `@idle-engine/renderer-contract` (so multiple renderers/hosts can reuse it).
- Add optional stricter validation modes for hosts running fully untrusted content:
  - finite number validation for coordinates/dimensions
  - string non-emptiness checks for IDs
  - per-kind draw validation (similar to `renderer-debug`’s `validateRenderCommandBuffer`)
- Add fuzz/property-based tests that generate random manifests/RCBs within caps to ensure renderer robustness.

## 15. References
- Issue 813: https://github.com/hansjm10/Idle-Game-Engine/issues/813
- Contract schema version + types: `packages/renderer-contract/src/types.ts`
- WebGPU entry points: `packages/renderer-webgpu/src/webgpu-renderer.ts`
- Existing RCB validation helper (debug tooling): `packages/renderer-debug/src/rcb-validation.ts`
- WebGPU renderer README example (mentions schema version constant): `packages/renderer-webgpu/README.md`

## Appendix A — Glossary
- **AssetManifest**: Renderer input that lists asset IDs, kinds, and content hashes to build a sprite atlas.
- **RenderCommandBuffer (RCB)**: Per-frame renderer input containing passes and ordered draws.
- **Schema version**: Integer constant (`RENDERER_CONTRACT_SCHEMA_VERSION`) indicating the expected field layout for contract payloads.
- **DoS (Denial of Service)**: Attacks/inputs that exhaust CPU/memory or otherwise freeze/crash the host.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-24 | Codex (AI) | Initial draft |
