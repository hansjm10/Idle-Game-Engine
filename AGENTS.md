# Repository Guidelines

Use this file as the compact entry point for agent work. Keep detailed guidance
in repository docs, package READMEs, and validation scripts.

## Source Of Truth

- Start with [docs/agent-map.md](docs/agent-map.md), the canonical
  task-to-context router for agent work.
- Use [docs/role-index.md](docs/role-index.md) for contributor role entry
  points and package READMEs for package-local invariants.
- Use [docs/contributor-handbook.md](docs/contributor-handbook.md) for local
  workflow, Lefthook behavior, coding style, and PR expectations.
- Use [docs/testing-guidelines.md](docs/testing-guidelines.md) for Vitest
  layout, deterministic test rules, and output constraints.
- Use [docs/agent-first-workflow-design.md](docs/agent-first-workflow-design.md)
  as the source initiative for agent workflow infrastructure changes.

## Task Routing

| Task type | Read first | Keep changes centered in |
| --- | --- | --- |
| Runtime simulation, commands, events, persistence, telemetry | `docs/agent-map.md` Runtime | `packages/core/` |
| Content DSL, compiler, sample packs, validation CLI | `docs/agent-map.md` Content Pipeline | `packages/content-*`, `tools/content-*`, `docs/examples/` |
| Renderer contracts, WebGPU, debug renderers, controls | `docs/agent-map.md` Renderer | `packages/renderer-*`, `packages/controls/`, shell renderer files |
| Electron shell, MCP, screenshots, diagnostics | `docs/agent-map.md` Shell MCP | `packages/shell-desktop/`, shell MCP scripts |
| Markdown docs, Docusaurus navigation, design docs, READMEs | `docs/agent-map.md` Docs | `docs/`, `packages/docs/`, `AGENTS.md` |
| Workspace scripts, CI, lint presets, hooks, hygiene | `docs/agent-map.md` Tooling and CI | `tools/scripts/`, `.github/`, config packages, root config |
| Benchmarks, performance pages, generated reports, releases | `docs/agent-map.md` relevant task family | Source files plus generated outputs required by that workflow |

## Validation Commands

- Install dependencies with `pnpm install` on Node >=20.10 and pnpm >=8.
- Prefer focused validation from `docs/agent-map.md` while iterating.
- Use `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:ci`, and
  `pnpm docs:build` when the changed surface calls for broader checks.
- Use `pnpm fast:check` for the repository fast path; scope behavior is
  documented in the contributor handbook.
- Lefthook runs pre-commit checks through `pnpm prepare`. Automated commits
  should allow several minutes for hooks instead of treating them as hung.

## Generated Artifacts

- Do not hand-edit generated outputs such as checked-in `dist/` files,
  generated manifests, or report pages.
- Regenerate artifacts with the owning command from `docs/agent-map.md` or the
  relevant package README, then commit source and generated output together when
  the workflow requires it.
- Do not run `pnpm coverage:md` as routine verification for unrelated work.
  Prefer the manual Coverage Report workflow when `docs/coverage/index.md` must
  be refreshed, and commit that tracked file only from a generated refresh.
- Keep Vitest and content-tool output machine-readable. The
  `vitest-llm-reporter` final JSON line must remain intact, with no extra
  console noise around it.

## Safety Rails

- Keep diffs aligned with the issue scope and the task family in
  `docs/agent-map.md`; do not expand `AGENTS.md` into a long-form manual.
- Preserve deterministic runtime behavior and pure simulation logic.
- Use `import type { ... }` and `export type { ... }` for type-only symbols.
- Prefer existing workspace patterns and package-local helpers before adding new
  abstractions.
- Leave unrelated user or local changes untouched, including local agent
  scratch files and editor swap files.
- Ask for clarification when docs disagree, task scope crosses public API
  boundaries, or validation would require broad generated-artifact updates.
