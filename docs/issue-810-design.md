---
title: shell-desktop — Bundle renderer deps (issue-810)
sidebar_position: 99
---

# shell-desktop — Bundle renderer deps (issue-810)

## Document Control
- **Title**: Bundle `@idle-engine/shell-desktop` renderer dependencies (avoid `dist/`-relative imports)
- **Authors**: Ralph (AI agent)
- **Reviewers**: Jordan Hans (hansjm10), Desktop Shell Maintainers
- **Status**: Draft
- **Last Updated**: 2026-01-24
- **Related Issues**: https://github.com/hansjm10/Idle-Game-Engine/issues/810
- **Execution Mode**: AI-led

## 1. Summary
The `@idle-engine/shell-desktop` renderer currently imports sibling workspace packages via deep relative paths that point into checked-in `dist/` outputs (for example `../../../renderer-webgpu/dist/index.js`). This works in-repo but is brittle for packaging (it assumes a monorepo directory layout at runtime) and makes it easy to accidentally run against stale builds. This design bundles the renderer entrypoint into a self-contained `dist/renderer/index.js` (plus optional sourcemap), so the desktop renderer no longer relies on `../../../*/dist/*` imports while keeping dev and packaged builds working.

## 2. Context & Problem Statement
### Background
- The Electron main process loads `dist/renderer/index.html`, which in turn loads `dist/renderer/index.js` as an ES module.
- The renderer TS entrypoint is `packages/shell-desktop/src/renderer/index.ts`.
- Today, that entrypoint imports renderer dependencies via deep relative paths into sibling package `dist/` directories:
  - `packages/shell-desktop/src/renderer/index.ts` imports `../../../renderer-contract/dist/index.js` and `../../../renderer-webgpu/dist/index.js`.

### Problem
- **Packaging brittleness**: The runtime file layout for packaged Electron apps typically does not preserve monorepo sibling directories, so `../../../renderer-webgpu/dist/index.js` is likely to break when the app is packaged or moved.
- **Stale dependency risk**: Because imports point directly at checked-in `dist/` outputs, it is easy to run with stale compiled JS when upstream packages change but are not rebuilt.

### Forces
- **CSP**: `index.html` uses `script-src 'self'`; the solution must keep scripts as local files (no remote fetching, no inline script injection).
- **Keep current runtime shape**: `main.ts` expects the renderer files at `dist/renderer/*`.
- **Minimal churn**: Prefer a targeted build pipeline change over a broad refactor of renderer packages.

## 3. Goals & Non-Goals
### Goals
- Remove `../../../*/dist/*` relative imports from the built renderer JS.
- Keep `pnpm --filter @idle-engine/shell-desktop run start` working for local development.
- Ensure packaged builds can load the renderer without depending on a monorepo directory layout.
- Keep the renderer code deterministic and browser-compatible (no Node-only imports in the bundled output).

### Non-Goals
- Introducing a full Electron packaging pipeline (e.g., electron-builder) if it does not already exist.
- Refactoring `@idle-engine/renderer-webgpu` or `@idle-engine/renderer-contract` public APIs.
- Changing renderer feature behavior (input handling, IPC wiring, WebGPU rendering).

## 4. Stakeholders, Agents & Impacted Surfaces
### Primary Stakeholders
- Desktop shell maintainers (Electron app)
- Renderer maintainers (`@idle-engine/renderer-webgpu`, `@idle-engine/renderer-contract`)

### Agent Roles
- **Docs Agent**: Maintain this design doc and follow-up docs if build steps change.
- **Runtime Implementation Agent**: Implement the bundling pipeline and update imports/tests.
- **Validation Agent**: Add/adjust CI checks and tests to prevent regressions.

### Affected Packages/Services
- `packages/shell-desktop` (renderer build and tests)
- `packages/renderer-webgpu` (consumed by bundle)
- `packages/renderer-contract` (consumed by bundle)
- `tools/scripts/*` (optional: new bundling script)

### Compatibility Considerations
- The renderer output must remain compatible with Electron’s renderer runtime (Chromium) and the existing CSP.
- The Electron main/preload code should not need to change its URL/path assumptions for `dist/renderer`.

## 5. Current State
- Renderer assets are served from `packages/shell-desktop/dist/renderer/`:
  - Static assets are copied by `tools/scripts/copy-renderer-assets.mjs`.
  - TypeScript emits `dist/renderer/index.js` via `tsc -p packages/shell-desktop/tsconfig.json`.
- `packages/shell-desktop/src/renderer/index.ts` imports sibling packages via deep relative paths into their `dist/` folders, and `packages/shell-desktop/src/renderer/index.test.ts` mocks the same deep relative import.

## 6. Proposed Solution

### 6.1 Architecture Overview
Bundle the renderer entrypoint (`packages/shell-desktop/src/renderer/index.ts`) into a self-contained JS artifact located at `packages/shell-desktop/dist/renderer/index.js`. The bundle inlines (or otherwise localizes) dependencies like `@idle-engine/renderer-webgpu` and `@idle-engine/renderer-contract`, removing the need for any runtime imports that traverse outside `dist/renderer/`.

### 6.2 Detailed Design

#### Runtime Changes
- No runtime behavior changes are intended; the renderer continues to:
  - Use `window.idleEngine` (from preload) for IPC.
  - Render via `createWebGpuRenderer`.
  - Consume `RenderCommandBuffer` frames and display status.

#### Data & Schemas
- No schema changes.

#### APIs & Contracts
- Replace deep relative imports in `packages/shell-desktop/src/renderer/index.ts` with package imports:
  - `@idle-engine/renderer-webgpu`
  - `@idle-engine/renderer-contract`
- The bundler resolves those imports at build time and produces a browser-resolvable output (no bare specifiers in the final `dist/renderer/index.js`).

#### Tooling & Automation
Add a renderer bundling step to `@idle-engine/shell-desktop`’s build:
- **Recommended**: `esbuild` bundle invoked from a small Node script (either in `tools/scripts/` or `packages/shell-desktop/scripts/`).
  - Entry: `packages/shell-desktop/src/renderer/index.ts`
  - Output: `packages/shell-desktop/dist/renderer/index.js`
  - Settings: `platform: 'browser'`, `format: 'esm'`, `bundle: true`, `target: 'es2022'` (or the repo’s standard target)
  - Optional: generate sourcemaps in dev builds only.
- Update `packages/shell-desktop/package.json` build script to run bundling after `tsc`, and keep `copy-renderer-assets.mjs` for `.html`/`.css`.
- Update `packages/shell-desktop/src/renderer/index.test.ts` mocks to match the new import paths (mock `@idle-engine/renderer-webgpu` instead of a deep relative `dist/` import).
- Add a small validation check (test or build-time assertion) that the bundled output does not contain `../../../renderer-*/dist/` paths.

### 6.3 Operational Considerations
#### Deployment
- No runtime deployment changes beyond producing a different `dist/renderer/index.js` artifact.

#### Telemetry & Observability
- No changes. (Optional follow-up: add a renderer “bundle version” string to status output for easier diagnostics.)

#### Security & Compliance
- Ensure bundling does not introduce CSP violations (no inline script, no remote fetches, avoid `eval`-based sourcemaps).
- Keep dependency surface small: bundle only what the renderer needs.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| feat(shell-desktop): bundle renderer deps | Add bundler step producing `dist/renderer/index.js` and remove deep relative imports | Runtime Implementation Agent | Design doc approved | Renderer output has no `../../../*/dist/*` imports; `pnpm --filter @idle-engine/shell-desktop run start` works |
| test(shell-desktop): update renderer mocks | Update `src/renderer/index.test.ts` to mock package imports and add regression check on bundle output | Validation Agent | Bundler in place | Tests pass; bundle output assertion passes |
| chore(shell-desktop): document build steps | Update package README/docs with how to build renderer bundle | Docs Agent | Bundler in place | Docs mention new build artifacts and troubleshooting |

### 7.2 Milestones
- **Phase 1**: Implement bundling + update imports/tests; land build output change.
- **Phase 2**: Add stricter CI guardrails (bundle output validation) and optional sourcemap/minification tweaks.

### 7.3 Coordination Notes
- Hand-off package:
  - `packages/shell-desktop/src/renderer/index.ts`
  - `packages/shell-desktop/src/renderer/index.test.ts`
  - `packages/shell-desktop/package.json`
  - `tools/scripts/copy-renderer-assets.mjs`
- Validation commands (expected):
  - `pnpm --filter @idle-engine/shell-desktop run build`
  - `pnpm --filter @idle-engine/shell-desktop run test`

## 8. Agent Guidance & Guardrails
- Do not edit checked-in `dist/` outputs by hand; change sources and build scripts only.
- Keep renderer output inside `packages/shell-desktop/dist/renderer/` (or subfolders), so packaging can include a single directory.
- Prefer a single-file bundle initially (simpler packaging), unless code-splitting is explicitly required.
- Validation hooks:
  - Ensure `dist/renderer/index.js` contains no `../../../renderer-*/dist/` strings after build.
  - Ensure the renderer still loads under the existing CSP (no runtime errors on page load).

## 9. Alternatives Considered
- **Vendor/copy dependencies into `dist/renderer/`**: Copy `packages/renderer-*/dist/*` into `dist/renderer/vendor/` and rewrite imports. This avoids bundler tooling but still duplicates compiled code and requires manual dependency graph maintenance.
- **Import maps**: Add an import map to `index.html` to map `@idle-engine/*` to relative file URLs. This keeps modules separate but complicates packaging (must ship and maintain the mapped paths) and still risks stale `dist/` usage.
- **Enable Node-style resolution in renderer**: Not recommended; increases security risk and diverges from browser module semantics.

## 10. Testing & Validation Plan
- **Unit / Integration**:
  - Update existing renderer unit tests (`packages/shell-desktop/src/renderer/index.test.ts`) to mock package imports.
  - Add a regression test or build check that the bundled `dist/renderer/index.js` has no `dist/`-relative imports outside `dist/renderer`.
- **Manual QA**:
  - Run `pnpm --filter @idle-engine/shell-desktop run start` and verify:
    - The window loads without module resolution errors.
    - IPC ping succeeds.
    - WebGPU renderer initializes and frames render or fallback path is stable.
- **Packaging smoke** (if packaging workflow exists): verify the renderer loads from the packaged app without accessing sibling packages.

## 11. Risks & Mitigations
- **Bundler introduces new build dependency**: Mitigate by keeping the bundler script small and isolated to `packages/shell-desktop`.
- **CSP / sourcemap issues**: Use external sourcemaps (or disable in production) and avoid eval-based dev tooling.
- **Output drift vs. `tsc` emit**: Make the bundling step authoritative for `dist/renderer/index.js` and add a guard to prevent regressions.

## 12. Rollout Plan
- Land bundling as part of `@idle-engine/shell-desktop` build.
- Update tests and add bundle output guardrails in the same PR.
- (Optional) Add a follow-up to validate packaged mode once a packaging workflow is defined.

## 13. Open Questions
- Should the renderer bundle be single-file only, or is code-splitting acceptable for this project’s packaging goals?
- Should the bundler resolve workspace dependencies from source (`src/`) or from package exports (`dist/`), and should `shell-desktop`’s build depend on building renderer packages first?
- Do we want production minification and/or sourcemaps, and what is the policy for shipping `.map` files?
- Is there an intended Electron packaging tool/workflow to validate “packaged mode” in CI?

## 14. Follow-Up Work
- Add a documented “packaged build” workflow once the project selects an Electron packaging solution.
- Consider consolidating renderer build tooling across future shells (desktop/web) if more bundling needs emerge.

## 15. References
- Issue: https://github.com/hansjm10/Idle-Game-Engine/issues/810
- `packages/shell-desktop/src/renderer/index.ts`
- `packages/shell-desktop/src/renderer/index.test.ts`
- `packages/shell-desktop/src/renderer/index.html`
- `packages/shell-desktop/package.json`
- `tools/scripts/copy-renderer-assets.mjs`
- `packages/renderer-webgpu/package.json`
- `packages/renderer-contract/package.json`

## Appendix A — Glossary
- **Renderer (Electron)**: The Chromium-based process that runs `index.html` and Web APIs like WebGPU.
- **Bundle**: A build artifact where multiple modules are combined into a single (or a few) JS files for simpler loading.
- **CSP**: Content Security Policy; rules restricting which scripts/styles may load and execute.

## Appendix B — Change Log
| Date       | Author          | Change Summary |
|------------|-----------------|----------------|
| 2026-01-24 | Ralph (AI agent) | Initial draft for issue-810 |

