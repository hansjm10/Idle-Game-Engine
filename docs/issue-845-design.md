---
title: "renderer: improve bitmap font asset pipeline for production use (Issue 845)"
sidebar_position: 99
---

# renderer: improve bitmap font asset pipeline for production use (Issue 845)

## Document Control
- **Title**: Introduce build-time (MSDF) font atlas generation + renderer support for production-quality text
- **Authors**: Ralph (AI agent)
- **Reviewers**: @hansjm10
- **Status**: Draft
- **Last Updated**: 2026-01-25
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/845
- **Execution Mode**: AI-led

## 1. Summary
Standardize a production-ready font pipeline by moving font atlas generation from runtime into a deterministic build step, driven by a content-pack font specification. The build step generates per-font atlas images + glyph metrics (prefer MSDF for crisp scaling), while `@idle-engine/renderer-webgpu` gains MSDF shader support and `@idle-engine/shell-desktop` loads the prebuilt font assets (keeping the current runtime generation as an explicit dev fallback).

## 2. Context & Problem Statement
- **Background**:
  - The renderer contract supports `AssetManifest` entries of kind `font` (`packages/renderer-contract/src/types.ts`), but does not define how fonts are produced or stored.
  - `@idle-engine/renderer-webgpu` renders `text` draws using bitmap fonts supplied by the host via `assets.loadFont(...)` (`packages/renderer-webgpu/src/webgpu-renderer.ts`). A font is currently modeled as an image plus glyph rectangles/metrics (`WebGpuBitmapFont` / `WebGpuBitmapFontGlyph`).
  - Issue 845 references a PR that rasterizes fonts at runtime (using `OffscreenCanvas`) as a quick fix for `shell-desktop`, but this is not an adequate long-term production approach.
- **Problem**:
  - Runtime rasterization increases startup time, adds platform constraints (renderer-process APIs, font availability), and risks non-determinism (OS font differences, hinting/kerning differences, etc.).
  - Plain bitmap atlases do not scale well across UI zoom levels; crisp text typically requires distance-field rendering (SDF/MSDF) or multiple baked sizes.
  - There is no canonical content-pack schema or build artifact format for fonts, so hosts must implement bespoke loaders and ad hoc hashing/manifest wiring.
- **Forces**:
  - Determinism and replay friendliness: text layout and glyph metrics must be stable across machines.
  - Cross-platform build and CI: font generation must be reproducible and not require fragile manual setup.
  - Renderer simplicity: avoid large API churn in `@idle-engine/renderer-contract` and keep `RenderCommandBuffer` unchanged.

## 3. Goals & Non-Goals
- **Goals**:
  1. Define a content-pack font specification that can drive build-time font atlas generation (glyph set, sizing, technique).
  2. Add a build step (invoked via `pnpm generate` / content compilation flow) that emits deterministic font atlas artifacts:
     - atlas image (e.g., PNG),
     - glyph metrics metadata (JSON),
     - stable `contentHash` inputs for `AssetManifest` entries.
  3. Add MSDF text rendering support to `@idle-engine/renderer-webgpu` while preserving existing bitmap font behavior.
  4. Update `@idle-engine/shell-desktop` to load prebuilt font assets and only use runtime generation as a dev/debug fallback.
  5. Add tests and docs so the pipeline is maintainable and hard to misuse.
- **Non-Goals**:
  - Full text shaping/kerning/bi-di layout (the renderer currently iterates code points and lays out sequentially).
  - A complete “all assets” pipeline (sprite sheets, shaders, etc.) beyond what is necessary to support fonts.
  - Runtime remote font downloads or OS font fallback.
  - Shipping a full-featured font editor UI.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**:
  - Renderer maintainers (`packages/renderer-webgpu`, `packages/renderer-contract`)
  - Content pipeline maintainers (`packages/content-schema`, `packages/content-compiler`, `tools/`)
  - Shell maintainers (`packages/shell-desktop`)
  - Content authors (need a simple, predictable way to declare fonts + glyph coverage)
- **Agent Roles**:
  - **Schema Agent**: Add/validate the font asset schema for content packs.
  - **Font Pipeline Agent**: Implement build-time font atlas generation and artifact emission.
  - **Renderer Agent**: Implement MSDF shader path in `@idle-engine/renderer-webgpu`.
  - **Shell Agent**: Load font artifacts and wire `assets.loadFont(...)` + `AssetManifest` plumbing.
  - **Docs/Test Agent**: Update docs and add regression tests.
- **Affected Packages/Services**:
  - `packages/content-schema` (new schema for font specs; validation)
  - `packages/content-compiler` (invoke font pipeline + emit artifacts)
  - `packages/renderer-webgpu` (MSDF shader support; font technique support)
  - `packages/shell-desktop` (asset loader + runtime fallback behavior)
  - `tools/` (new font compiler wrapper or embedded generator tooling)
- **Compatibility Considerations**:
  - Keep renderer contract stable: no changes to `RenderCommandBuffer` are required.
  - `WebGpuBitmapFont` changes (if any) must be additive (e.g., optional `technique`), so existing hosts remain compatible.
  - Packs without font declarations must continue to compile and run unchanged.

## 5. Current State
- Renderer contract types:
  - `AssetManifest` supports `AssetKind = 'image' | 'font' | 'spriteSheet' | 'shader'` (`packages/renderer-contract/src/types.ts`).
- WebGPU renderer text pipeline:
  - Hosts supply fonts through `WebGpuRendererAssets.loadFont(...)` as `{ image, baseFontSizePx, lineHeightPx, glyphs, fallbackCodePoint? }`.
  - The renderer packs the font image into the global atlas, then computes per-glyph UVs by combining the packed atlas rect with glyph sub-rects (`buildBitmapFontRuntimeGlyph(...)` in `packages/renderer-webgpu/src/webgpu-renderer.ts`).
  - `text` draws render as instanced quads using the same pipeline as sprites (`#handleTextDraw(...)` calls `appendBitmapTextInstances(...)`).
  - There is no MSDF/SDF shader path; text is effectively “alpha bitmap tinted by draw color”.
- Content pipeline:
  - `packages/content-schema` pack schema is strict and does not define fonts/assets today (`packages/content-schema/src/pack/schema.ts`).
  - `docs/content-compiler-design.md` explicitly scoped asset bundling/binary assets out of the initial compiler milestone.

## 6. Proposed Solution
### 6.1 Architecture Overview
- **Narrative**:
  1. Content packs declare fonts (source TTF/OTF, glyph ranges, base size, technique).
  2. A build-time tool generates deterministic font artifacts per declared font:
     - MSDF atlas image + glyph metrics JSON (preferred), or
     - classic bitmap alpha atlas image + glyph metrics JSON (fallback option).
  3. The build step also produces a stable `AssetManifest` fragment (or a pack-local assets manifest) that includes `font` entries with `contentHash` derived from artifact content (e.g., SHA-256 of bytes).
  4. Hosts (starting with `shell-desktop`) load the assets manifest and implement `assets.loadFont(...)` by reading the generated font metadata + decoding the atlas image.
  5. `@idle-engine/renderer-webgpu` renders bitmap fonts as today, and renders MSDF fonts via a dedicated MSDF text pipeline/shader.
- **Diagram**: TBD

### 6.2 Detailed Design
- **Runtime Changes**
  - Extend the in-memory font model returned by `assets.loadFont(...)` to support MSDF metadata in an additive way. Proposed shape:
    - `technique?: 'bitmap' | 'msdf'` (default: `'bitmap'`)
    - `msdf?: { pxRange: number }` (required when `technique === 'msdf'`)
  - Add a new MSDF render pipeline in `packages/renderer-webgpu/src/webgpu-renderer.ts`:
    - A WGSL fragment shader that samples the atlas (RGB MSDF), computes signed distance via `median(r, g, b)`, and derives alpha using `fwidth`-based smoothing.
    - Batching rule: MSDF text draws must not be batched with sprite/image draws unless the pipeline/shader is the same. Introduce a separate batch kind (e.g., `msdfText`) or flush on technique boundaries.
  - Keep the existing bitmap path unchanged for hosts that supply bitmap atlases.
- **Data & Schemas**
  - Add a font declaration schema for content packs. Minimal proposed authoring schema (exact location TBD):
    ```json
    {
      "fonts": [
        {
          "id": "game.ui-font",
          "source": "fonts/inter.ttf",
          "baseSizePx": 32,
          "lineHeightPx": 40,
          "codePointRanges": [[32, 126], [8192, 8303]],
          "technique": "msdf",
          "fallbackCodePoint": 65533
        }
      ]
    }
    ```
    Notes:
    - `id` becomes the renderer `AssetId` for `AssetManifest` (`kind: 'font'`).
    - `codePointRanges` must be normalized and validated (ascending, non-overlapping, within Unicode range).
    - `lineHeightPx` can be explicit or derived by the generator (TBD; see Open Questions).
  - Define a compiled font artifact format that is easy for hosts to load. Proposed:
    - `*.font.json` containing:
      - `baseFontSizePx`, `lineHeightPx`, `glyphs[]`, `fallbackCodePoint?`
      - `technique` + technique-specific fields (e.g., `msdf.pxRange`)
      - `imageFile` (relative path) or a convention-based filename.
    - `*.png` (or `.webp`) atlas image emitted by the generator.
- **APIs & Contracts**
  - Keep `@idle-engine/renderer-contract` unchanged.
  - Update `@idle-engine/renderer-webgpu` public types (`WebGpuBitmapFont`) additively if MSDF metadata is carried there.
  - Document the “bitmap font artifact” contract clearly (JSON schema + examples).
- **Tooling & Automation**
  - Implement a new build step invoked from the content pipeline:
    - Option A (preferred): integrate into `packages/content-compiler` as an additional artifact stage (“assets”) alongside JSON/module emission.
    - Option B: introduce a dedicated CLI under `tools/` (e.g., `tools/font-atlas-cli`) that `content-compiler` invokes.
  - Use a dedicated MSDF generator (candidates: `msdfgen`, `msdf-atlas-gen`) pinned to a known version and configured to avoid non-deterministic outputs (TBD).
  - Emit stable hashes for `AssetManifest` entries by hashing artifact bytes (image + metadata).

### 6.3 Operational Considerations
- **Deployment**:
  - CI must run the font generation step as part of `pnpm generate` (or equivalent) so generated artifacts are always present for packaging.
  - Decide whether generated font artifacts are committed (like other compiled content outputs) or generated in CI only (TBD; align with existing “generated artifacts checked in” pattern).
- **Telemetry & Observability**:
  - Log structured build-step events only (no noisy console output in tests); runtime telemetry is out of scope.
- **Security & Compliance**:
  - Treat font compilation as local file IO only; do not fetch remote assets during build.
  - Ensure the tool does not execute arbitrary paths from untrusted packs when run in CI (validate `source` paths resolve within the pack root).

## 7. Work Breakdown & Delivery Plan
### 7.1 Issue Map

| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| `spike(fonts): research MSDF tooling` | Evaluate `msdfgen` vs `msdf-atlas-gen` (quality, determinism, packaging) | Font Pipeline Agent | None | Recommendation + pinned tool/version + example output checked |
| `feat(content-schema): add font asset spec` | Add schema + validation for font declarations in content packs | Schema Agent | Tooling decision | Packs validate; docs updated; tests added |
| `feat(content-compiler): generate font atlas artifacts` | Implement build-time generation + deterministic artifacts (image + JSON) | Font Pipeline Agent | Schema | `pnpm generate` emits artifacts; deterministic in `--check` mode |
| `feat(renderer-webgpu): MSDF text shader` | Add MSDF pipeline and technique-based dispatch for text draws | Renderer Agent | Tooling decision | MSDF text renders; bitmap fonts unchanged; tests pass |
| `feat(shell-desktop): load prebuilt font assets` | Implement font asset loader and wire `assets.loadFont(...)` | Shell Agent | Compiler artifacts | Shell loads font assets; runtime generation is fallback only |
| `docs: document font pipeline + authoring` | Document schema, artifact format, and usage guidance | Docs/Test Agent | Schema + tooling | Docs added; example pack updated (optional) |
| `chore: deprecate runtime font generation` | Mark runtime font generation as deprecated (dev fallback) | Shell Agent | Shell loading | Deprecated path gated + documented |

### 7.2 Milestones
- **Phase 1**: Tooling decision + content schema for font declarations.
- **Phase 2**: Build-time atlas generation + emitted artifacts + manifest hashing.
- **Phase 3**: Renderer MSDF pipeline + shell asset loading + docs.

### 7.3 Coordination Notes
- **Hand-off Package**:
  - Issue 845 body (requirements and target files).
  - Renderer font contracts: `packages/renderer-contract/src/types.ts`, `packages/renderer-webgpu/src/webgpu-renderer.ts`
  - Content pack schema entrypoint: `packages/content-schema/src/pack/schema.ts`
  - Content compiler scope constraints: `docs/content-compiler-design.md` (revisit non-goals for assets)
- **Communication Cadence**: Single reviewer checkpoint at the end of each phase; keep Issue 845 updated with decision notes.

## 8. Agent Guidance & Guardrails
- **Context Packets**:
  - Read Issue 845 and `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md` for determinism constraints.
  - Inspect `packages/renderer-webgpu/src/webgpu-renderer.ts` text batching (`#handleTextDraw`, `appendBitmapTextInstances`).
  - Inspect `packages/content-schema/src/pack/schema.ts` to understand current strict pack schema.
- **Prompting & Constraints**:
  - Prefer additive API changes; keep `RenderCommandBuffer` stable.
  - Keep outputs deterministic: stable glyph ordering, stable atlas packing, stable JSON serialization.
  - Do not edit checked-in `dist/**` by hand.
- **Safety Rails**:
  - Validate that font `source` paths resolve inside the pack directory.
  - Impose sane caps (max glyph count, atlas size) and fail with actionable errors.
  - Avoid shipping OS-font dependent runtime paths as the default.
- **Validation Hooks**:
  - `pnpm test --filter @idle-engine/renderer-webgpu`
  - `pnpm test --filter @idle-engine/content-schema`
  - `pnpm test --filter @idle-engine/content-compiler`
  - `pnpm lint`
  - `pnpm generate --check` (once the font step is wired into the generate pipeline)

## 9. Alternatives Considered
1. **Keep runtime font atlas generation (OffscreenCanvas)**:
   - Pros: no build tooling; quick iteration.
   - Cons: startup cost, platform dependence, weaker determinism; rejected for production.
2. **Use DOM/CSS text rendering**:
   - Rejected: undermines determinism and replay goals; mismatched across environments (see Issue 778).
3. **Prebaked bitmap atlases only (no MSDF)**:
   - Viable fallback, but scaling quality is poor; could be Phase 1 while MSDF lands.
4. **Single-channel SDF instead of MSDF**:
   - Lower memory and simpler shader, but worse corner fidelity; keep as an option if MSDF tooling proves brittle.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Content schema tests: validate font declarations (range normalization, duplicate IDs, invalid paths).
  - Content compiler tests: ensure generated artifacts are deterministic (byte-identical) under `--check` and stable ordering rules.
  - Renderer tests: add WebGPU-stub tests that:
    - validate MSDF technique selects the MSDF pipeline,
    - validate bitmap fonts remain on the existing sprite pipeline,
    - validate technique metadata validation (e.g., missing `msdf.pxRange`).
- **Performance**:
  - Measure build-time font generation cost on CI and keep a baseline (TBD thresholds).
  - Ensure runtime startup is improved vs runtime generation by removing font rasterization work.
- **Tooling / A11y**:
  - Manual smoke test in `shell-desktop`: render sample UI text at multiple `fontSizePx` values and validate crispness and stability under zoom.

## 11. Risks & Mitigations
1. **MSDF tooling availability and cross-platform support**:
   - Mitigation: pin versions; prefer distributable binaries or WASM; add CI checks that fail with actionable install instructions.
2. **Non-deterministic atlas output across OS/architectures**:
   - Mitigation: lock tool version and flags; ensure glyph ordering is explicit; consider generating artifacts only in CI and committing results (TBD).
3. **Renderer complexity / batching regressions**:
   - Mitigation: keep bitmap path unchanged; isolate MSDF pipeline; add regression tests around batching boundaries.
4. **Atlas size explosion for large code point ranges**:
   - Mitigation: enforce caps; encourage authoring narrow ranges; support multi-page output as follow-up if needed.

## 12. Rollout Plan
- **Milestones**:
  1. Land schema + tooling decision (no runtime changes yet).
  2. Land build-time font generation + artifact format + manifest hashing.
  3. Land renderer MSDF shader support.
  4. Land shell-desktop asset loading and deprecate runtime generation by default.
- **Migration Strategy**:
  - Existing hosts that provide bitmap fonts remain supported.
  - Packs can adopt the new `fonts` spec incrementally; missing fonts should produce clear errors when text draws reference absent `fontAssetId`s.
- **Communication**:
  - Update Issue 845 with the chosen generator tool/version and an example artifact output snapshot.

## 13. Open Questions
1. Where should font declarations live: extend `pack.json` (new `fonts` field) vs a dedicated `assets.json` file within each pack?
2. Which generator tool is preferred (`msdfgen`, `msdf-atlas-gen`, or another), and how do we package it for CI + contributors?
3. Should `lineHeightPx` be authored, derived from font metrics, or both (authored override)?
4. Do we need per-font MSDF parameters beyond `pxRange` (e.g., edge threshold), and if so how are they surfaced to the shader deterministically?
5. Should the build step emit an `AssetManifest` for all assets or a “fonts-only” manifest initially?
6. Are generated font artifacts committed to the repo (like other compiler outputs) or generated in CI/packaging only?

## 14. Follow-Up Work
- Extend the asset pipeline beyond fonts (images/sprite sheets/shaders) once the basic “assets manifest + hashing” approach is proven.
- Add advanced text features (kerning/shaping, fallback fonts) if required by localization goals.
- Add a replay/inspection harness that can validate text rendering determinism using packed fonts and known RCB fixtures.

## 15. References
- Issue 845: https://github.com/hansjm10/Idle-Game-Engine/issues/845
- Renderer contract asset kinds: `packages/renderer-contract/src/types.ts`
- WebGPU renderer font + text handling: `packages/renderer-webgpu/src/webgpu-renderer.ts`
- Determinism constraints (text + assets): `docs/desktop-shell-webgpu-renderer-replay-design-issue-778.md`
- Content pack schema entrypoint: `packages/content-schema/src/pack/schema.ts`
- Content compiler design scope: `docs/content-compiler-design.md`

## Appendix A — Glossary
- **Atlas**: A single packed texture containing multiple images (and font atlas images) used for batching and fewer texture binds.
- **Bitmap font**: A font rendered to pixels ahead of time; scaling up typically blurs or pixelates.
- **SDF/MSDF**: Signed Distance Field / Multi-channel Signed Distance Field. Encodes distance to glyph edges so text can scale crisply in a shader.
- **`pxRange`**: The pixel distance range encoded into an SDF/MSDF atlas; required to convert sampled values into coverage.

## Appendix B — Change Log
| Date       | Author | Change Summary |
|------------|--------|----------------|
| 2026-01-25 | Ralph (AI agent) | Initial draft for Issue 845 |
