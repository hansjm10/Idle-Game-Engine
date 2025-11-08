# Automated Accessibility Smoke Tests

## Document Control
- **Title**: Automated Accessibility Smoke Tests
- **Authors**: Jordan Hans
- **Reviewers**: TODO – Assign accessibility QA reviewer
- **Status**: In Review
- **Last Updated**: 2025-10-23
- **Related Issues**: [#191](https://github.com/hansjm10/Idle-Game-Engine/issues/191), [#5](https://github.com/hansjm10/Idle-Game-Engine/issues/5)
- **Execution Mode**: AI-led

## 1. Summary
The Idle Engine web shell currently ships without automated accessibility coverage, creating a risk that regressions slip past manual testing. This design introduces a Playwright- and Axe-powered smoke test that exercises the production build of `@idle-engine/shell-web`, emits actionable violation data, and fits inside existing `pnpm test:ci` pipelines. The plan scopes the technical approach, agent workflows, and follow-up work so autonomous contributors can deliver and maintain the suite with minimal friction.

## 2. Context & Problem Statement
- **Background**: The repository relies on `pnpm`, Lefthook, and GitHub Actions to enforce lint, unit tests, and build steps. No integration or browser-based tests run today, and developers manually inspect the shell UI for WCAG coverage.
- **Problem**: Accessibility smoke checks are easy to defer, go stale as UI surfaces change, and lack machine-readable failure data. Without automation, accessibility regressions may ship unnoticed and force rework.
- **Forces**: (1) Feedback must complete in under one minute to remain viable locally and in CI. (2) Reports need machine-readable selectors and WCAG rule IDs so agents can auto-triage failures. (3) The solution must scale to future UI surfaces without rewriting tooling.

## 3. Goals & Non-Goals
- **Goals**:
  - Deliver a deterministic accessibility smoke test that blocks WCAG 2.1 A/AA failures on the primary shell experience.
  - Keep the workflow compatible with `pnpm test:a11y` locally and `pnpm test:ci` in CI, with sub-minute runtime after browsers are cached.
  - Produce violation summaries that downstream agents can parse and act on without manual context.
  - Set up reusable scaffolding so additional shell routes or overlays can be covered incrementally.
- **Non-Goals**:
  - Comprehensive accessibility audits or visual regression coverage.
  - Backend or non-web client accessibility testing.
  - Enforcing design token contrast rules (handled by the design system).
  - Replacing Vitest unit suites or component-level tests.

## 4. Stakeholders, Agents & Impacted Surfaces
- **Primary Stakeholders**: Shell Web squad, QA & Accessibility maintainers, Docs & Tooling working group.
- **Agent Roles**:
  - *Docs Agent*: Maintains this design, context packets, and changelog.
  - *A11y Automation Agent*: Implements and updates Playwright/Axe suites.
  - *CI Integration Agent*: Keeps `pnpm test:ci` and GitHub Actions wiring aligned with the smoke tests.
- **Affected Packages/Services**: `packages/shell-web`, `packages/core`, `tools/a11y-smoke-tests`, `.github/workflows/ci.yml`, `lefthook.yml`.
- **Compatibility Considerations**: Avoid breaking existing build/test contracts, respect workspace boundaries, and ensure Playwright installs do not impact environments with `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`.

## 5. Current State
`@idle-engine/shell-web` renders a landing page without automated browser coverage. Lefthook runs `pnpm lint`, `pnpm test:ci`, and `pnpm build`, but no package exports an accessibility test target. GitHub Actions executes the same commands, leaving accessibility gaps unaddressed. Contributors must rely on ad-hoc manual audits that drift quickly as UI evolves.

## 6. Proposed Solution

### 6.1 Architecture Overview
Adopt a dedicated workspace under `tools/a11y-smoke-tests` that runs Playwright against the production build of the shell. Playwright launches Vite’s preview server after building dependencies, Axe audits the rendered landing page, and violations fail the run with structured output. The suite integrates with existing `pnpm` scripts so CI picks it up automatically.

### 6.2 Detailed Design
- **Runtime Changes**: None. The runtime remains untouched; only build/test orchestration changes.
- **Data & Schemas**: Optional JSON artifacts may be emitted under `artifacts/accessibility/` during CI for future diffing; no schema changes today.
- **APIs & Contracts**:
  - Author `pnpm test:a11y` (workspace root) to invoke the Playwright suite.
  - Ensure `pnpm test:ci` recursively runs the smoke tests without double execution.
  - Guard scripts against unsupported flags (e.g., reject `pnpm test:a11y -- --ui`).
- **Tooling & Automation**:
  - Create `tools/a11y-smoke-tests` with dependencies: `@playwright/test`, `@axe-core/playwright`, `cross-env`, `typescript`, `ts-node`.
  - Provide `playwright.config.ts` that:
    - Builds `@idle-engine/core` and `@idle-engine/shell-web` before starting `pnpm --filter @idle-engine/shell-web run preview -- --host 127.0.0.1 --port 4173 --strictPort`.
    - Sets `use.baseURL` to `http://127.0.0.1:4173`, `timeout` ≈ 60s, and `reuseExistingServer` when `CI` is unset.
    - Limits projects to `chromium` initially.
  - Implement `tests/landing-page.a11y.spec.ts` that waits for the `<main>` landmark, runs Axe with `wcag2a` and `wcag2aa` tags, and asserts zero violations while logging actionable summaries on failure.
  - Write `scripts/install-playwright.cjs` and `scripts/run-playwright.cjs` to manage browser installs and flag validation.
  - Update `.gitignore` to exclude Playwright’s output directories and optional Axe artifacts.

### 6.3 Operational Considerations
- **Deployment**: GitHub Actions already runs `pnpm test:ci`; once the new workspace is in the dependency graph, the a11y suite runs automatically. Consider caching `~/.cache/ms-playwright` for faster reruns.
- **Telemetry & Observability**: Use Playwright reporters for console summaries. Future enhancements may upload Axe JSON artifacts or integrate GitHub annotations.
- **Security & Compliance**: No PII or authenticated flows; ensure preview servers bind to `127.0.0.1` to avoid cross-network exposure. Respect `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` for air-gapped installs.

## 7. Work Breakdown & Delivery Plan

### 7.1 Issue Map
| Issue Title | Scope Summary | Proposed Assignee/Agent | Dependencies | Acceptance Criteria |
|-------------|---------------|-------------------------|--------------|---------------------|
| docs: migrate Accessibility Smoke Tests design to template | Align doc with standard template, add agent guidance and changelog | Docs Agent | Template approved | Document merged; context packets ready for agents |
| feat(tools): scaffold Playwright a11y smoke tests workspace | Create workspace, scripts, initial landing-page spec | A11y Automation Agent | Doc sign-off | `pnpm test:a11y` passes locally; browsers cached; repo scripts updated |
| ci: integrate a11y smoke tests into pipelines | Wire Lefthook and GitHub Actions to run the suite reliably | CI Integration Agent | Workspace scaffold | CI run shows Playwright job passing; flakes under 2% week-over-week |

### 7.2 Milestones
- **Phase 1**: Approve design, scaffold workspace, land initial smoke test (target under one week).
- **Phase 2**: Extend coverage to overlays/modals and publish Axe artifacts in CI (target one week after Phase 1).

### 7.3 Coordination Notes
- **Hand-off Package**: Share this doc, `pnpm-workspace.yaml`, `packages/shell-web/README.md`, and latest CI logs with incoming agents.
- **Communication Cadence**: Async updates on issue #191 thrice weekly; escalate blockers in the Docs & Tooling channel.

## 8. Agent Guidance & Guardrails
- **Context Packets**: `docs/accessibility-smoke-tests-design.md`, `docs/implementation-plan.md`, `pnpm-workspace.yaml`, `.github/workflows/ci.yml`, `packages/shell-web/README.md`.
- **Prompting & Constraints**: Reference this document when implementing scripts; follow Conventional Commits; keep runtime deterministic; avoid introducing unsupported Playwright flags.
- **Safety Rails**: Do not modify `dist/` artifacts directly; avoid `git reset --hard`; respect `LEFTHOOK` hooks unless coordinating overrides; keep server host `127.0.0.1`.
- **Validation Hooks**: Run `pnpm install`, `pnpm test:a11y`, and `pnpm test:ci` before marking work complete; attach violation logs when failures occur.

## 9. Alternatives Considered
- **Cypress + axe-core plugin**: Rejected due to heavier runtime, slower CI cold starts, and limited first-class TypeScript tooling compared to Playwright.
- **Puppeteer with custom Axe integration**: Rejected; would require more glue code, lacks built-in test runner ergonomics, and duplicates functionality Playwright already offers.
- **Storybook-driven accessibility checks**: Deferred; Storybook is not in use for the shell today and would add setup overhead before tests can run.

## 10. Testing & Validation Plan
- **Unit / Integration**: Maintain Playwright specs under `tools/a11y-smoke-tests/tests`. Future unit tests can validate helper utilities (e.g., violation formatters).
- **Performance**: Track total runtime; target ≤ 60s per run after browser cache warm-up. Investigate when durations exceed 90s.
- **Tooling / A11y**: Execute `pnpm test:a11y` locally and in CI. When modifying shell UI, rerun the suite and capture failure artifacts for review.

## 11. Risks & Mitigations
- **Initial browser download slows installs**: Cache Playwright artifacts and short-circuit the installer when `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` is set.
- **Flaky server startup causes false failures**: Use Playwright `webServer` retries, strict ports, and generous timeouts to absorb cold builds.
- **Dynamic content triggers false positives**: Wait for UI stabilization (loading indicators resolved) before running Axe; selectively suppress known-safe animations.
- **Pre-commit friction**: Monitor Lefthook timings; consider a lighter `test:fast` hook if contributors report unacceptable delays.

## 12. Rollout Plan
- **Milestones**: Land workspace scaffolding, integrate with CI, document usage in README, monitor first two weeks of runs.
- **Migration Strategy**: Introduce the new package via standard PR; ensure `pnpm install` succeeds on clean clones; document opt-out instructions (`LEFTHOOK=0`).
- **Communication**: Announce availability in the Shell Web release notes and internal tooling updates; highlight how to rerun the suite locally.

## 13. Open Questions
- Should future social-service UI routes receive dedicated smoke tests with authenticated flows?
- Do we want to publish Axe violation artifacts (JSON) as CI attachments in the first iteration?
- Will additional shells (e.g., native/Tauri) require analogous tests, and should they reuse this workspace?
- Who will serve as the long-term reviewer/approver for accessibility automation changes?

## 14. Follow-Up Work
- Draft issues for expanding coverage to overlays and modals once they ship.
- Evaluate GitHub annotation integration for Axe violations.
- Audit other documentation that references the legacy accessibility plan and update links accordingly.

## 15. References
- `docs/design-document-template.md`
- `pnpm-workspace.yaml`
- `.github/workflows/ci.yml`
- `packages/shell-web/src/modules/App.tsx`
- [Playwright Docs](https://playwright.dev/)
- [Axe Core Accessibility Testing](https://www.deque.com/axe/)

## Appendix A — Glossary
- **Axe**: Deque’s accessibility engine that audits pages for WCAG compliance.
- **Playwright**: Microsoft’s browser automation framework used for end-to-end testing.
- **Smoke Test**: A lightweight test ensuring core functionality works before deeper validation.
- **WCAG**: Web Content Accessibility Guidelines, the standard for accessibility compliance.

## Appendix B — Change Log
| Date       | Author      | Change Summary |
|------------|-------------|----------------|
| 2025-10-23 | Jordan Hans | Migrated document to standard template; added agent guidance and delivery plan |
