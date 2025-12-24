# Repository Guidelines

## Project Structure & Module Organization
Modules are declared in `pnpm-workspace.yaml`: `packages/core` contains the deterministic runtime with colocated `*.test.ts`, `packages/shell-web` delivers the Vite-powered web shell, `packages/content-sample` ships reference data packs, and `packages/config-*` publish shared lint/test presets. Backend experiments sit in `services/social`, and command-line tooling in `tools/`. Generated `dist/` outputs are checked in for inspectors but should not be edited by hand.

## Build, Test, and Development Commands
Use `pnpm install` with Node ≥20.10 and pnpm ≥8 to sync dependencies. `pnpm lint` runs eslint across the workspace, and `pnpm test` executes all Vitest suites in parallel; `pnpm test:ci` runs workspace `test:ci` scripts in parallel (tune with `TEST_CI_WORKSPACE_CONCURRENCY`), while `pnpm test:ci:serial` keeps the serialized order for debugging. `pnpm dev` (aliased to `pnpm --filter shell-web run dev`) starts the web shell at `localhost:5173`. Accessibility smoke checks run with `pnpm test:a11y`; on fresh Linux hosts run `pnpm exec playwright install-deps` once to satisfy Playwright.

## Coding Style & Naming Conventions
TypeScript is the standard language, using ES modules, two-space indentation, and camelCase for symbols with PascalCase for classes. Shared linting rules are defined in `eslint.config.mjs` and the `packages/config-eslint` preset; prefer lint fixes over manual restyling. Keep constants SCREAMING_SNAKE_CASE, favour pure functions for simulation logic, and co-locate command payload types with their handlers in `packages/core`.

- Use `import type { ... }` and `export type { ... }` for type-only symbols. The workspace enforces `@typescript-eslint/consistent-type-imports` and `@typescript-eslint/consistent-type-exports` at error level.

## Testing Guidelines
Vitest drives unit tests with shared config in `@idle-engine/config-vitest`; add new cases in `*.test.ts` files next to the implementation. Scope runs with `pnpm test --filter <package>` when iterating locally, and keep simulations deterministic so the `vitest-llm-reporter` summary remains stable. The reporter prints a final JSON object (one line, no trailing text) that downstream agents parse—for example:

```json
{"event":"run_end","summary":{"passed":12,"failed":0,"durationMs":523}}
```

Always leave the JSON intact and avoid console noise that could corrupt the payload. Run `pnpm test:a11y` after modifying shell UI flows or ARIA attributes, and note any remaining coverage gaps in the PR description.

### Coverage report page (docs)
- After changing tests or code that affects coverage, run `pnpm coverage:md` from the repository root to regenerate `docs/coverage/index.md`.
- Commit the updated `docs/coverage/index.md` file. The folder `docs/coverage/` is ignored by default, but `index.md` is allow‑listed in `.gitignore` and must be tracked so the Docusaurus build succeeds.
- Do not edit `docs/coverage/index.md` manually—always regenerate via the command above.

## Commit & Pull Request Guidelines
History favours Conventional Commits such as `chore: add vitest llm reporter` and `feat: define runtime command payloads`, occasionally supplemented by merge commits like `Integrate runtime command queue... (#52)`. Aim for `type(scope?): concise summary`, link issues or PR numbers in parentheses, and keep imperative voice. PRs should outline the problem, the solution, and test commands executed; include screenshots or recordings for `shell-web` changes and note any follow-up work. Ensure Lefthook is installed (`pnpm prepare`) so pre-commit lint, test, and build checks run before pushing.

Pre-commit hooks can take several minutes (generate/build/lint/test-content). When running commits via automation, use extended timeouts (>=10 minutes) and allow long-running output without treating it as a hang.
