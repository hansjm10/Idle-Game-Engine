# Automated Accessibility Smoke Tests

Issue: #5 &mdash; Tooling & QA Workstream

## 1. Problem Statement
- The web shell (`@idle-engine/shell-web`) currently has no automated accessibility coverage.
- Manual audits are easy to defer and become stale as UI surfaces evolve.
- Without early a11y feedback, regressions can ship unnoticed and cause downstream rework.

## 2. Goals
- Provide a repeatable smoke test that blocks obvious WCAG 2.1 A/AA violations on the primary shell experience.
- Keep feedback loops under one minute so the test can run locally and in continuous integration.
- Produce machine-readable reports so failures are actionable (selectors, rule IDs, details).
- Establish a structure that scales to additional UI surfaces (future pages, modals, overlays).

## 3. Non-Goals
- Performing exhaustive accessibility audits or visual regression testing.
- Covering service backends or non-web clients.
- Enforcing design token-level contrast compliance (handled separately by design system).
- Replacing component-level unit tests run under Vitest.

## 4. Current State
- The React/Vite shell renders a single landing view (`packages/shell-web/src/modules/App.tsx`) without automated browser tests.
- The monorepo relies on `pnpm`, with `lefthook` wired to run `pnpm lint` and `pnpm test:ci`, but no package defines an integration or end-to-end test script yet.
- A GitHub Actions CI workflow (`.github/workflows/ci.yml`) already enforces lint, test, and build gates; this effort should extend that pipeline's `pnpm test:ci` phase with accessibility coverage.

## 5. Proposed Solution

### 5.1 Tooling Selection
- Use **Playwright** for browser automation: lightweight, headless by default, first-class TypeScript support, and built-in server lifecycle helpers.
- Use **@axe-core/playwright** for WCAG rules. Axe provides rich metadata for violations and integrates cleanly with Playwright's `Page` API.
- Store Playwright code in TypeScript to keep parity with the rest of the repo and enable IDE assistance.

### 5.2 Workspace & Layout
- Add a new workspace package `tools/a11y-smoke-tests` (referenced by `pnpm-workspace.yaml`):
  - `package.json` scripts:
    - `build` (noop placeholder for consistency).
    - `test` → `playwright test`.
    - `test:ci` → `cross-env CI=1 playwright test --reporter=line`.
    - `postinstall` → `node ./scripts/install-playwright.cjs`, which skips work when cached browsers already exist and otherwise invokes `pnpm exec playwright install`, adding `--with-deps` only when running on Linux CI so cross-platform local installs stay compatible. The script should detect `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` (or similar) and short-circuit cleanly so offline or air-gapped environments do not fail installs.
  - Dependencies: `@playwright/test`, `@axe-core/playwright`, `cross-env`, `typescript`, `ts-node` (for config), and shared ESLint config if linting is enabled later.
  - `playwright.config.ts` with:
    - `webServer` invoking `pnpm --filter @idle-engine/core run build && pnpm --filter @idle-engine/shell-web run build && pnpm --filter @idle-engine/shell-web run preview -- --host 127.0.0.1 --port 4173 --strictPort` so dependent packages emit their bundles before the preview server starts, avoiding missing-module failures on fresh clones, and the preview fails fast if the port is occupied.
    - `port: 4173` (or `url: 'http://127.0.0.1:4173'`) so Playwright waits for the preview server to become ready instead of racing Vite boot times.
    - `timeout` tuned for CI (suggest 60s per test) and `reuseExistingServer` when not in CI for faster local runs.
    - `use` block setting `baseURL: 'http://127.0.0.1:4173'` so the smoke test can navigate with relative paths like `/`.
    - Single browser project (`chromium`) for now to keep runtime small; other browsers can be added later.
  - `tests/landing-page.a11y.spec.ts` as the initial suite.
  - Update the repo `.gitignore` to exclude Playwright output directories (`playwright-report/`, `test-results/`, `blob-report/`) and the optional Axe artifact path (`artifacts/accessibility/`) so local runs do not introduce noisy untracked files.

### 5.3 Test Flow
1. Let Playwright's `webServer` command build `@idle-engine/core` and then the shell (`pnpm --filter @idle-engine/core run build && pnpm --filter @idle-engine/shell-web run build`) before launching `vite preview`, ensuring the test always exercises the production bundle and that workspace dependencies ship compiled artifacts.
2. Launch the preview server via the same `webServer` configuration.
3. Navigate to `/` and wait for the `<main>` landmark.
4. Execute Axe analysis with tags `wcag2a` and `wcag2aa`.
5. Assert the violation list is empty; on failure, emit the violation summaries to stdout for quick triage.
6. (Future) Expand coverage to UI overlays once they exist (resource panels, upgrade modals, social components) by adding selectors and navigation steps.

### 5.4 CI & Local Workflow Integration
- Update root scripts:
  - Add `"test:a11y": "pnpm --filter ./tools/a11y-smoke-tests run test"` (or use the package name once defined).
  - Ensure `"test:ci"` runs unit suites and the smoke test without double-invoking Playwright (e.g., leave the root script as `pnpm -r run test:ci` so each workspace contributes once, or orchestrate the phases via a small Node helper script if sequential execution is preferred).
  - Document the expected runtime impact before enabling the pre-commit hook so contributors understand how to temporarily opt out (`LEFTHOOK=0`) if the smoke suite blocks urgent commits; adjust the plan after collecting timing data from the first implementation pass.
- Document a local shortcut: `pnpm test:a11y --ui` (Playwright UI) for debugging.
- In the existing GitHub Actions pipeline (`.github/workflows/ci.yml`), keep the current `pnpm test:ci` step so unit tests and the smoke suite run together (the new workspace's `test:ci` script will execute automatically). If additional visibility is desired, add a follow-up step that invokes `pnpm test:a11y` explicitly.
  1. `pnpm install --frozen-lockfile` (already present in the workflow).
  2. `pnpm test:ci` (the recursive run covers unit tests and the accessibility suite once the new package lands).
  3. *(Optional)* `pnpm test:a11y` for a dedicated accessibility report; Playwright's `webServer` configuration handles building `@idle-engine/core` and `@idle-engine/shell-web` before launching the preview server, avoiding redundant work.
  - Cache Playwright browsers between runs (`~/.cache/ms-playwright`) to reduce install time.
- Evaluate `lefthook.yml` after implementation:
  - Option A (default): keep `pnpm test:ci` hook; the a11y test should complete in ~20–30s after initial browser download.
  - Option B: introduce a lighter `test:fast` hook for commits if the team finds the smoke test too heavy; CI will still run `test:ci`.

### 5.5 Reporting & Observability
- Configure Playwright reporter to emit concise violation summaries.
- Store raw Axe JSON under `artifacts/accessibility/` when `CI=1` (optional follow-up) so PRs can surface diffs.
- Consider future integration with GitHub PR annotations via Playwright's GitHub reporter if violations occur.

## 6. Rollout Steps
1. Scaffold `tools/a11y-smoke-tests` workspace with dependencies and config.
2. Update `pnpm-workspace.yaml` and root scripts (`package.json`, `lefthook.yml` if required).
3. Implement the landing-page smoke test and ensure it passes locally.
4. Document usage in `packages/shell-web/README.md` (or repo root README) for developers.
5. Wire into the future CI workflow; verify headless run on Linux.

## 7. Risks & Mitigations
- **Initial browser download increases install time**: Cache the Playwright directory so subsequent installs short-circuit through the `install-playwright.cjs` guard.
- **Flaky server start-up**: Use Playwright's `webServer` retry/backoff and increase `timeout` to absorb slower cold builds.
- **False positives from Axe on dynamic content**: Wait for UI stabilization (loading indicators) before analysis; selectively exclude animations if needed.
- **Pre-commit friction**: Monitor hook duration; if average exceeds acceptable limits, fall back to running the smoke test in CI only.

## 8. Open Questions
- Should future social-service UI routes receive separate smoke tests with authenticated flows?
- Do we want to publish Axe violation artifacts as CI attachments from day one, or defer to a later tooling story?
- Will additional shells (native/Tauri) need analogous tests, and if so should they share the same Playwright workspace?

## 9. Acceptance Criteria
- Repeatable `pnpm test:a11y` command that fails on Axe violations.
- Smoke test executes in <1 minute locally after browsers are installed.
- Documentation updated so contributors know how to run and debug the suite.
- Root `pnpm test:ci` exercises the smoke test, enabling easy CI adoption once the pipeline is live.
